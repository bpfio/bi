/**
 * BI-07.15 —— DeepSeek 搜索 Provider（ProviderPort 实现）。
 *
 * 合约要点：
 * - Bun.fetch POST /chat/completions 语义，端点可配（任意 OpenAI 兼容
 *   chat/completions 端点均可挂载）。
 * - 响应 choices[0].message.content 解析为 SearchResult[]：支持裸 JSON 数组 /
 *   { results: [...] } / markdown 代码围栏包裹三种形态；非法条目（无有效
 *   http(s) URL）跳过，永不因单条脏数据炸掉整批。
 * - fetch 可注入（fetchImpl），测试离屏。
 * - 密钥经参数注入（apiKey），仅进请求头，绝不写入日志/错误消息/结果。
 * - 失败路径只抛结构化 SearchError（provider="deepseek"），绝不抛裸异常。
 */

import type { FetchExecutor } from "../web-fetch";
import {
	SearchError,
	DEFAULT_SEARCH_TIMEOUT_MS,
	type ProviderPort,
	type ProviderSearchOptions,
	type SearchResult,
} from "../web-search";

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

/** DeepSeek provider 配置。 */
export interface DeepSeekSearchConfig {
	/** API 密钥（参数注入，不落盘、不进日志）。 */
	apiKey: string;
	/** chat/completions 端点；缺省 https://api.deepseek.com/chat/completions */
	endpoint?: string;
	/** 模型名；缺省 deepseek-chat。 */
	model?: string;
	/** 系统提示词（约束输出 JSON 结果数组）；可配端点语义时可覆写。 */
	systemPrompt?: string;
	/** 采样温度；缺省 0.2。 */
	temperature?: number;
	/** 注入 fetch 执行器；缺省全局 fetch。 */
	fetchImpl?: FetchExecutor;
	/** 缺省超时（毫秒），可被每次 search 的 opts.timeoutMs 覆盖；缺省 15000。 */
	timeoutMs?: number;
}

export const DEFAULT_DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";

/** 约束模型只输出 JSON 结果数组的系统提示词。 */
export const DEFAULT_SEARCH_SYSTEM_PROMPT =
	"你是网页搜索结果格式化器。只输出一个 JSON 数组，不要输出任何其他文字。" +
	"数组每项形如 {\"title\": \"网页标题\", \"url\": \"http(s) 完整链接\", \"snippet\": \"一两句摘要\"}。" +
	"仅收录真实存在的 http/https 链接，按相关性从高到低排序。";

// ---------------------------------------------------------------------------
// 响应解析
// ---------------------------------------------------------------------------

interface RawHit {
	title?: unknown;
	url?: unknown;
	link?: unknown;
	snippet?: unknown;
	description?: unknown;
	content?: unknown;
	summary?: unknown;
}

/** 剥 markdown 代码围栏，截取首个 JSON 主体。 */
function extractJsonBody(text: string): string {
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	let body = fence ? fence[1]! : text;
	const firstArr = body.indexOf("[");
	const firstObj = body.indexOf("{");
	const start =
		firstArr >= 0 && (firstObj < 0 || firstArr < firstObj) ? firstArr : firstObj;
	if (start < 0) return body;
	const lastArr = body.lastIndexOf("]");
	const lastObj = body.lastIndexOf("}");
	const end = Math.max(lastArr, lastObj);
	if (end < start) return body;
	return body.slice(start, end + 1);
}

function asTrimmedString(v: unknown): string {
	return typeof v === "string" ? v.trim() : "";
}

function isValidHttpUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return u.protocol === "https:" || u.protocol === "http:";
	} catch {
		return false;
	}
}

/**
 * 将模型返回的 content 文本解析为 SearchResult[]。
 * 支持数组、{results: [...]}、围栏包裹；无效条目跳过；解析失败抛 provider-error。
 */
export function parseDeepSeekResults(content: string, limit: number, provider = "deepseek"): SearchResult[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(extractJsonBody(content));
	} catch (e) {
		throw new SearchError("provider-error", `deepseek 返回内容无法解析为 JSON（长度 ${content.length}）`, {
			provider,
			cause: e,
		});
	}
	let hits: unknown[];
	if (Array.isArray(parsed)) {
		hits = parsed;
	} else if (parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { results?: unknown }).results)) {
		hits = (parsed as { results: unknown[] }).results;
	} else {
		throw new SearchError("provider-error", "deepseek 返回内容既非数组也不含 results 数组", { provider });
	}

	const out: SearchResult[] = [];
	for (const hit of hits) {
		if (hit === null || typeof hit !== "object") continue;
		const h = hit as RawHit;
		const url = asTrimmedString(h.url) || asTrimmedString(h.link);
		if (url === "" || !isValidHttpUrl(url)) continue;
		const snippet = asTrimmedString(h.snippet) || asTrimmedString(h.description) || asTrimmedString(h.summary) || asTrimmedString(h.content);
		const title = asTrimmedString(h.title) || url;
		out.push({ title, url, snippet, provider });
		if (out.length >= limit) break;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Provider 实现
// ---------------------------------------------------------------------------

interface ChatCompletionResponse {
	choices?: Array<{
		message?: { content?: unknown };
	}>;
}

/** DeepSeek ProviderPort 实现（fetch 可注入，密钥参数注入不落盘）。 */
export class DeepSeekSearchProvider implements ProviderPort {
	readonly name = "deepseek";
	private readonly apiKey: string;
	private readonly endpoint: string;
	private readonly model: string;
	private readonly systemPrompt: string;
	private readonly temperature: number;
	private readonly fetchImpl: FetchExecutor;
	private readonly defaultTimeoutMs: number;

	constructor(config: DeepSeekSearchConfig) {
		const key = config.apiKey.trim();
		if (key === "") {
			throw new SearchError("provider-error", "DeepSeekSearchProvider 需要 apiKey（参数注入）", {
				provider: "deepseek",
			});
		}
		this.apiKey = key;
		this.endpoint = config.endpoint ?? DEFAULT_DEEPSEEK_ENDPOINT;
		this.model = config.model ?? DEFAULT_DEEPSEEK_MODEL;
		this.systemPrompt = config.systemPrompt ?? DEFAULT_SEARCH_SYSTEM_PROMPT;
		this.temperature = config.temperature ?? 0.2;
		this.fetchImpl = config.fetchImpl ?? ((input, init) => fetch(input, init));
		this.defaultTimeoutMs = Math.max(1, config.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS);
	}

	async search(query: string, opts: ProviderSearchOptions): Promise<SearchResult[]> {
		const limit = Math.max(1, opts.limit);
		const timeoutMs = Math.max(1, opts.timeoutMs ?? this.defaultTimeoutMs);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		if (opts.signal !== undefined) {
			if (opts.signal.aborted) controller.abort();
			else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
		}

		const payload = {
			model: this.model,
			stream: false,
			temperature: this.temperature,
			messages: [
				{ role: "system", content: this.systemPrompt },
				{ role: "user", content: query },
			],
		};

		let res: Response;
		try {
			res = await this.fetchImpl(this.endpoint, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json",
					// 密钥仅进请求头；不写入任何日志/错误消息
					authorization: `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify(payload),
				signal: controller.signal,
			});
		} catch (e) {
			if (controller.signal.aborted) {
				throw new SearchError("timeout", `deepseek 请求超时（${timeoutMs}ms）`, {
					provider: this.name,
					cause: e,
				});
			}
			throw new SearchError("provider-error", `deepseek 网络错误: ${e instanceof Error ? e.message : String(e)}`, {
				provider: this.name,
				cause: e,
			});
		} finally {
			clearTimeout(timer);
		}

		if (!res.ok) {
			void res.body?.cancel().catch(() => {});
			// 错误消息只带状态码与端点，绝不回显密钥或响应体
			throw new SearchError("provider-error", `deepseek HTTP ${res.status}: ${this.endpoint}`, {
				provider: this.name,
				status: res.status,
			});
		}

		let body: ChatCompletionResponse;
		try {
			body = (await res.json()) as ChatCompletionResponse;
		} catch (e) {
			throw new SearchError("provider-error", "deepseek 响应不是合法 JSON", {
				provider: this.name,
				cause: e,
			});
		}
		const content = body.choices?.[0]?.message?.content;
		const contentText = typeof content === "string" ? content : "";
		return parseDeepSeekResults(contentText, limit, this.name);
	}
}
