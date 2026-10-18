/**
 * BI-25.1 —— 缺省工具注册表面：buildDefaultToolset(cwd) → ToolBinding[]。
 *
 * 职责边界（装配层只包装，器官零改动；ToolBinding 合约见 cli/headless.ts）：
 * - read_file：参考 cli/headless.test.ts readFileSyncBinding 形状（resolve + 逃逸
 *   守卫 + Bun.file 读文本）。守卫边界较参考形状收紧一档：路径段级前缀
 *   （root + sep），兄弟目录同前缀（/w → /w2）不再漏放。
 * - web_fetch：挂 BI-07.15 fetchWebPage（手动重定向/超时预算/字节上限/结构化
 *   WebFetchError 全在器官内）；readOnly:true = 无文件写语义。
 * - web_search：挂 BI-07.15 webSearch + DeepSeekSearchProvider（唯一已装配
 *   ProviderPort）。密钥走 api_key_env 同款间接引用语义：执行时读环境变量
 *   （缺省 DEEPSEEK_API_KEY），未设置 = 结构化报错，绝不假冒结果。
 * - 信号透传：web 两器官自身不带 AbortSignal，绑定层 withSignal 竞出 abort
 *   （中止即 reject，绝不悬挂）；read_file 同步读无需透传。
 *
 * 显式不挂（诚实边界，归后续卡）：
 * - bash / 写类工具：沙箱与权限面（BI-06 器官在，装配策略归后续装配卡）；
 * - list_dir / grep 类：packages/core/src/tools/ 无现成器官，器官在才挂
 *   （BI-25.1 首批注册面 = 下表三件，可增）。
 *
 * 执行测试零外呼：fetch 经 BuildDefaultToolsetOptions.fetchImpl 注入替身。
 */

import { resolve, sep } from "node:path";
import type { ToolBinding } from "./headless";
import { fetchWebPage, type FetchExecutor } from "../tools/web-fetch";
import {
	webSearch,
	TokenBucketRateLimiter,
	TtlResultCache,
	DEFAULT_SEARCH_RPS,
} from "../tools/web-search";
import { DeepSeekSearchProvider } from "../tools/search-providers/deepseek-search";

// ---------------------------------------------------------------------------
// 公共面
// ---------------------------------------------------------------------------

/** web_search 密钥缺省环境变量名（api_key_env 间接引用语义）。 */
export const DEFAULT_SEARCH_API_KEY_ENV = "DEEPSEEK_API_KEY";

/** buildDefaultToolset 选项（全部可选；主控接线只需 buildDefaultToolset(cwd)）。 */
export interface BuildDefaultToolsetOptions {
	/** 注入 fetch 执行器（web 两工具离屏执行测试用）；缺省全局 fetch。 */
	readonly fetchImpl?: FetchExecutor;
	/** web_search 密钥环境变量名；缺省 DEFAULT_SEARCH_API_KEY_ENV。 */
	readonly searchApiKeyEnv?: string;
	/** 环境变量源（密钥解析用）；缺省 process.env。 */
	readonly env?: Record<string, string | undefined>;
}

/**
 * 缺省工具注册表面（BI-25.1）：read_file / web_fetch / web_search 三件，
 * 全部 readOnly（首批面无写语义工具）。每个绑定 = definition（喂模型）+
 * readOnly + argSummary（截断摘要）+ execute（真实器官调用，信号透传）。
 */
export function buildDefaultToolset(cwd: string, options: BuildDefaultToolsetOptions = {}): ToolBinding[] {
	const root = resolve(cwd);
	const fetchImpl: FetchExecutor = options.fetchImpl ?? ((input, init) => fetch(input, init));
	const env = options.env ?? process.env;
	const apiKeyEnv = options.searchApiKeyEnv ?? DEFAULT_SEARCH_API_KEY_ENV;
	// 会话级缓存/限速：随工具集实例隔离（默认全局单例会跨测试与跨会话串味）。
	const searchCache = new TtlResultCache();
	const searchLimiter = new TokenBucketRateLimiter(DEFAULT_SEARCH_RPS);
	return [readFileBinding(root), webFetchBinding(fetchImpl), webSearchBinding({ fetchImpl, env, apiKeyEnv, cache: searchCache, limiter: searchLimiter })];
}

// ---------------------------------------------------------------------------
// read_file —— 工作区文本读取（器官：Bun.file，绑定层守卫）
// ---------------------------------------------------------------------------

function readFileBinding(root: string): ToolBinding {
	return {
		definition: {
			name: "read_file",
			description: "读取工作区内文本文件（UTF-8）。超出了工作区根的路径一律拒绝。",
			inputSchema: {
				type: "object",
				properties: { path: { type: "string", description: "相对工作区根的文件路径" } },
				required: ["path"],
			},
		},
		readOnly: true,
		argSummary: (args) => summarizeArg(args, "path"),
		execute: async (args, signal) => {
			const path = takeStringArg(args, "path");
			const abs = resolve(root, path);
			// cwd 逃逸守卫（参考 readFileSyncBinding 形状；边界收紧为路径段级前缀）。
			if (abs !== root && !abs.startsWith(root + sep)) throw new Error("path-escape");
			return await withSignal(signal, () => Bun.file(abs).text());
		},
	};
}

// ---------------------------------------------------------------------------
// web_fetch / web_search —— BI-07.15 web 器官包装（readOnly = 无文件写语义）
// ---------------------------------------------------------------------------

function webFetchBinding(fetchImpl: FetchExecutor): ToolBinding {
	return {
		definition: {
			name: "web_fetch",
			description: "抓取网页并归一化为 Markdown/文本（HTML 取主内容；重定向、超时与字节上限受控）。",
			inputSchema: {
				type: "object",
				properties: { url: { type: "string", description: "http(s) 完整 URL" } },
				required: ["url"],
			},
		},
		readOnly: true,
		argSummary: (args) => summarizeArg(args, "url"),
		execute: (args, signal) => {
			const url = takeStringArg(args, "url");
			return withSignal(signal, () => fetchWebPage(url, { fetchImpl }));
		},
	};
}

interface WebSearchDeps {
	readonly fetchImpl: FetchExecutor;
	readonly env: Record<string, string | undefined>;
	readonly apiKeyEnv: string;
	readonly cache: TtlResultCache;
	readonly limiter: TokenBucketRateLimiter;
}

function webSearchBinding(deps: WebSearchDeps): ToolBinding {
	return {
		definition: {
			name: "web_search",
			description: "Web 搜索（DeepSeek provider）。返回 { title, url, snippet } 结果列表；需经环境变量配置 API 密钥。",
			inputSchema: {
				type: "object",
				properties: { query: { type: "string", description: "搜索词" } },
				required: ["query"],
			},
		},
		readOnly: true,
		argSummary: (args) => summarizeArg(args, "query"),
		execute: async (args, signal) => {
			const query = takeStringArg(args, "query");
			// 密钥门：执行时解析（api_key_env 间接引用语义），未设置结构化报错，不假冒结果。
			const apiKey = (deps.env[deps.apiKeyEnv] ?? "").trim();
			if (apiKey === "") {
				throw new Error(`web_search 未配置：环境变量 ${deps.apiKeyEnv} 未设置（api_key_env 间接引用语义；导出后重试）`);
			}
			const provider = new DeepSeekSearchProvider({ apiKey, fetchImpl: deps.fetchImpl });
			return await withSignal(signal, () =>
				webSearch(query, {
					provider,
					cache: deps.cache,
					limiter: deps.limiter,
				}),
			);
		},
	};
}

// ---------------------------------------------------------------------------
// 绑定层小件：参数取值 / 摘要截断 / 信号竞出
// ---------------------------------------------------------------------------

/** 取字符串参数（缺省/非字符串/空串统一结构化报错）。 */
function takeStringArg(args: unknown, key: string): string {
	const raw = args !== null && typeof args === "object" ? (args as Record<string, unknown>)[key] : undefined;
	if (typeof raw !== "string" || raw.trim() === "") throw new Error(`${key} required`);
	return raw;
}

/** argSummary：目标参数原文（缺省回退整参 JSON），截断到 200 字符（权限门审计面）。 */
function summarizeArg(args: unknown, key: string, max = 200): string {
	const raw = args !== null && typeof args === "object" ? (args as Record<string, unknown>)[key] : undefined;
	let text: string;
	if (typeof raw === "string") {
		text = raw;
	} else {
		try {
			text = JSON.stringify(args) ?? String(args);
		} catch {
			text = String(args);
		}
	}
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 信号透传（器官无 signal 入参时的绑定层补偿）：一旦 abort 立即 reject，
 * 不等器官自身超时。start 工厂惰性求值——已中止的信号不启动器官调用；
 * 竞出后器官侧结果/异常照常落定（已被本层接管，不产生未处理拒绝）。
 */
function withSignal<T>(signal: AbortSignal, start: () => Promise<T>): Promise<T> {
	if (signal.aborted) return Promise.reject(new Error("aborted"));
	let pending: Promise<T>;
	try {
		pending = start();
	} catch (error) {
		return Promise.reject(error);
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new Error("aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		pending.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}
