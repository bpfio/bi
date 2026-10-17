/**
 * BI-07.15 —— Web 抓取工具（fetchWebPage）。
 *
 * 合约要点：
 * - Bun.fetch 实现：手动逐跳重定向（计数上限 maxRedirects，缺省 5）。
 * - 总超时预算 timeoutMs（缺省 15s）：跨重定向跳共享同一 deadline。
 * - 响应体按 maxBytes（缺省 1 MiB）流式截断，截断产生 warning，绝不 OOM。
 * - content-type 判定：HTML → 复用 web-extractor.extractReadable（内部走
 *   html-markdown 的 htmlToMarkdown 流式引擎）取主内容 Markdown + title；
 *   纯文本/JSON/XML 等 → text 原样；二进制类型 → 结构化错误。
 * - 4xx/5xx 与一切失败路径只抛结构化 WebFetchError（kind/status/url 可编程
 *   判定），绝不抛裸异常。
 * - fetch 执行器可注入（fetchImpl），测试离屏，零真实网络。
 */

import { htmlToMarkdown } from "./html-markdown";
import { extractReadable, extractTitle } from "./web-extractor";

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

/** 可注入 fetch 执行器：与全局 fetch 签名兼容（global fetch 可直接赋值）。 */
export type FetchExecutor = (input: string, init?: RequestInit) => Promise<Response>;

/** fetchWebPage 选项。 */
export interface FetchWebPageOptions {
	/** 总超时预算（毫秒），跨重定向共享 deadline；缺省 15000。 */
	timeoutMs?: number;
	/** 响应体字节上限，超出截断 + warning；缺省 1 MiB。 */
	maxBytes?: number;
	/** 手动重定向跟随次数上限；缺省 5。 */
	maxRedirects?: number;
	/** 允许的 URL 协议（不含冒号，大小写不敏感）；缺省 ["https", "http"]。 */
	allowedSchemes?: readonly string[];
	/**
	 * 内容抽取模式：
	 * - "readable"（缺省）：web-extractor.extractReadable 剥离镀铬取主内容；
	 * - "full"：htmlToMarkdown 全文档转换（主内容判定失效时的兜底）。
	 */
	content?: "readable" | "full";
	/** 注入 fetch 执行器（测试离屏）；缺省全局 fetch。 */
	fetchImpl?: FetchExecutor;
}

/** fetchWebPage 结果。 */
export interface FetchWebPageResult {
	/** 最终跳转后的 URL。 */
	url: string;
	/** 页面标题（仅 HTML 内容；无 title 或非 HTML 时缺省）。 */
	title?: string;
	/** Markdown 正文（HTML 内容）。 */
	markdown?: string;
	/** 原始文本（text/plain、JSON、XML 等）。 */
	text?: string;
	/** 实际读取的字节数（已按 maxBytes 截断后的量）。 */
	bytes: number;
	/** 是否触发 maxBytes 截断。 */
	truncated: boolean;
	/** 非致命告警（截断、转换容错等）。 */
	warnings: string[];
}

/** WebFetchError 结构化错误种类。 */
export type WebFetchErrorKind =
	| "invalid-url"
	| "scheme-not-allowed"
	| "too-many-redirects"
	| "invalid-redirect"
	| "timeout"
	| "http-error"
	| "unsupported-content-type"
	| "network-error";

/** 结构化抓取错误：一切失败路径唯一出口，绝不抛裸异常。 */
export class WebFetchError extends Error {
	readonly kind: WebFetchErrorKind;
	readonly status?: number;
	readonly url?: string;

	constructor(
		kind: WebFetchErrorKind,
		message: string,
		details: { status?: number; url?: string; cause?: unknown } = {},
	) {
		super(message);
		this.name = "WebFetchError";
		this.kind = kind;
		this.status = details.status;
		this.url = details.url;
		if (details.cause !== undefined) this.cause = details.cause;
	}

	static is(e: unknown): e is WebFetchError {
		return e instanceof WebFetchError;
	}
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
export const DEFAULT_FETCH_MAX_BYTES = 1024 * 1024;
export const DEFAULT_FETCH_MAX_REDIRECTS = 5;
export const DEFAULT_ALLOWED_SCHEMES: readonly string[] = ["https", "http"];

/** 跟随的重定向状态码集合（RFC 7231/7538）。 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const REQUEST_HEADERS: Record<string, string> = {
	"user-agent": "BI-WebFetch/0.1",
	accept: "text/html, text/plain, application/json;q=0.9, */*;q=0.5",
};

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function schemeOf(protocol: string): string {
	return protocol.replace(/:$/, "").toLowerCase();
}

function isRedirectStatus(status: number): boolean {
	return REDIRECT_STATUSES.has(status);
}

/** 是否按纯文本处理（缺 content-type 时按文本兜底）。 */
function isTextualContentType(ct: string): boolean {
	if (ct === "") return true;
	if (ct.startsWith("text/")) return true;
	return (
		ct.includes("json") ||
		ct.includes("xml") ||
		ct.includes("javascript") ||
		ct.includes("yaml") ||
		ct.includes("csv")
	);
}

/** 解析并校验 URL 协议白名单；失败抛结构化错误。 */
function parseAndCheckUrl(raw: string, schemeSet: ReadonlySet<string>): string {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		throw new WebFetchError("invalid-url", `URL 无法解析: ${raw}`, { url: raw });
	}
	const scheme = schemeOf(u.protocol);
	if (!schemeSet.has(scheme)) {
		throw new WebFetchError(
			"scheme-not-allowed",
			`协议不允许: ${u.protocol}（允许: ${[...schemeSet].join(", ")}）`,
			{ url: u.href },
		);
	}
	return u.href;
}

/**
 * 流式读取响应体并按 maxBytes 截断（超出立即停止读流并 cancel）。
 * 空 body（无流）回退 arrayBuffer 一次性读取。
 */
async function readBodyCapped(
	res: Response,
	maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	const reader = res.body?.getReader?.();
	if (!reader) {
		const buf = new Uint8Array(await res.arrayBuffer());
		if (buf.length > maxBytes) return { bytes: buf.slice(0, maxBytes), truncated: true };
		return { bytes: buf, truncated: false };
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.length === 0) continue;
			if (total + value.length > maxBytes) {
				chunks.push(value.slice(0, maxBytes - total));
				total = maxBytes;
				truncated = true;
				void res.body?.cancel().catch(() => {});
				break;
			}
			chunks.push(value);
			total += value.length;
		}
	} finally {
		void reader.releaseLock?.();
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return { bytes: out, truncated };
}

// ---------------------------------------------------------------------------
// 公共入口
// ---------------------------------------------------------------------------

/**
 * 抓取网页并归一化为 Markdown/文本。
 * 失败一律抛结构化 WebFetchError（kind/status/url），绝不抛裸异常。
 */
export async function fetchWebPage(
	rawUrl: string,
	options: FetchWebPageOptions = {},
): Promise<FetchWebPageResult> {
	const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
	const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_FETCH_MAX_BYTES);
	const maxRedirects = Math.max(0, options.maxRedirects ?? DEFAULT_FETCH_MAX_REDIRECTS);
	const allowedSchemes = options.allowedSchemes ?? DEFAULT_ALLOWED_SCHEMES;
	const contentMode = options.content ?? "readable";
	const doFetch: FetchExecutor = options.fetchImpl ?? ((input, init) => fetch(input, init));
	const schemeSet = new Set(allowedSchemes.map((s) => schemeOf(s.trim())));

	let current = parseAndCheckUrl(rawUrl, schemeSet);
	const deadline = Date.now() + timeoutMs;
	let followedRedirects = 0;

	for (;;) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw new WebFetchError("timeout", `抓取超时（预算 ${timeoutMs}ms）: ${current}`, {
				url: current,
			});
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), remaining);
		let res: Response;
		try {
			res = await doFetch(current, {
				redirect: "manual",
				signal: controller.signal,
				headers: REQUEST_HEADERS,
			});
		} catch (e) {
			if (controller.signal.aborted) {
				throw new WebFetchError("timeout", `抓取超时（预算 ${timeoutMs}ms）: ${current}`, {
					url: current,
					cause: e,
				});
			}
			throw new WebFetchError("network-error", `网络错误: ${current}: ${errorMessage(e)}`, {
				url: current,
				cause: e,
			});
		} finally {
			clearTimeout(timer);
		}

		// —— 手动逐跳重定向 ——
		if (isRedirectStatus(res.status)) {
			if (followedRedirects >= maxRedirects) {
				void res.body?.cancel().catch(() => {});
				throw new WebFetchError(
					"too-many-redirects",
					`重定向次数超过上限 ${maxRedirects}: ${current}`,
					{ url: current, status: res.status },
				);
			}
			const location = res.headers.get("location");
			if (!location) {
				void res.body?.cancel().catch(() => {});
				throw new WebFetchError("invalid-redirect", `重定向缺少 Location 头: ${current}`, {
					url: current,
					status: res.status,
				});
			}
			let next: URL;
			try {
				next = new URL(location, current);
			} catch {
				throw new WebFetchError(
					"invalid-redirect",
					`重定向 Location 无法解析: ${location.slice(0, 200)}`,
					{ url: current, status: res.status },
				);
			}
			if (!schemeSet.has(schemeOf(next.protocol))) {
				void res.body?.cancel().catch(() => {});
				throw new WebFetchError(
					"scheme-not-allowed",
					`重定向目标协议不允许: ${next.protocol}`,
					{ url: next.href, status: res.status },
				);
			}
			current = next.href;
			followedRedirects++;
			continue;
		}

		// —— 非 2xx/非重定向 3xx：结构化错误 ——
		if (res.status >= 300) {
			void res.body?.cancel().catch(() => {});
			throw new WebFetchError("http-error", `HTTP ${res.status}: ${current}`, {
				url: current,
				status: res.status,
			});
		}

		// —— content-type 判定（读流前先挡掉二进制）——
		const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
		const isHtml = contentType.includes("html");
		if (!isHtml && !isTextualContentType(contentType)) {
			void res.body?.cancel().catch(() => {});
			throw new WebFetchError(
				"unsupported-content-type",
				`不支持的内容类型: ${contentType || "(缺失)"}: ${current}`,
				{ url: current, status: res.status },
			);
		}

		const { bytes, truncated } = await readBodyCapped(res, maxBytes);
		const warnings: string[] = [];
		if (truncated) warnings.push(`响应体超过 ${maxBytes} 字节上限，已截断。`);
		const decoded = new TextDecoder().decode(bytes);

		if (isHtml) {
			if (contentMode === "full") {
				// 兜底：htmlToMarkdown 全文档转换（title 单独提取）
				const full = htmlToMarkdown(decoded, { maxBytes });
				const title = extractTitle(decoded);
				return {
					url: current,
					title: title === "" ? undefined : title,
					markdown: full.markdown,
					bytes: bytes.length,
					truncated,
					warnings: [...warnings, ...full.warnings],
				};
			}
			const readable = extractReadable(decoded);
			return {
				url: current,
				title: readable.title === "" ? undefined : readable.title,
				markdown: readable.markdown,
				bytes: bytes.length,
				truncated,
				warnings: [...warnings, ...readable.warnings],
			};
		}

		return {
			url: current,
			text: decoded,
			bytes: bytes.length,
			truncated,
			warnings,
		};
	}
}
