/**
 * BI-23.3 —— 真实模型端口装配配件：BI-04.2 双模态适配器 → BI-23.1 ModelPort。
 *
 * 职责边界（装配层只选择与映射，器官不改动）：
 * - `createAdapterModelPort`：直连形态（baseUrl/apiKey/model 直传），e2e 与注入用；
 * - `resolveModelPort`：BiConfig 选择逻辑（providers/models/thinking 三段）+ 凭据门
 *   （BI-02：`api_key_env` 间接引用，key 只经环境变量解析，永不落盘、永不入日志）；
 * - kind → WireMode：openai → 'openai'，anthropic → 'messages'，google 无已装配
 *   驱动 → 结构化报错（BI-23.3 交付面 = openai/anthropic 两协议）；
 * - thinking.effort（minimal/low/medium/high）→ 适配器档位（off/low/high/max）：
 *   minimal→off、low→low、medium→high、high→max；`thinking.enabled=false` 强制 off。
 *
 * 失败面全部结构化（`ModelPortConfigError`），由 main 分发映射退出码 3
 * （凭据未配置 / 配置缺失 / 无驱动协议），不静默降级、不伪造端口。
 */
import {
	buildRequest,
	DeepSeekAdapter,
	type FetchLike,
	type StreamEvent,
	type ThinkingEffort,
	type WireMode,
} from "../adapters/deepseek-adapter";
import { randomUUID } from "node:crypto";
import type { BiConfig } from "../config/schema";
import type { ModelPort } from "./headless";

/** 模型装配失败（配置缺失 / 凭据未设置 / 无驱动协议）的结构化信号。 */
export class ModelPortConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelPortConfigError";
	}
}

/** kind → WireMode；未知协议结构化报错（不猜测、不降级）。 */
function wireModeFromKind(kind: string): WireMode {
	if (kind === "openai") return "openai";
	if (kind === "anthropic") return "messages";
	throw new ModelPortConfigError(
		`provider kind "${kind}" 暂无已装配驱动（BI-23.3 交付 openai/anthropic 两协议）`,
	);
}

/** bi 思考档位 → 适配器四档；enabled=false 强制 off。 */
export function effortToAdapter(enabled: boolean, effort: string): ThinkingEffort {
	if (!enabled) return "off";
	switch (effort) {
		case "minimal":
			return "off";
		case "low":
			return "low";
		case "medium":
			return "high";
		case "high":
			return "max";
		default:
			return "off";
	}
}

/** 缺省凭据门：api_key_env → 环境变量；未声明 = 无静态 Key（OAuth/本地端点）。 */
function resolveApiKeyFromEnv(
	providerName: string,
	envName: string,
	env: Record<string, string | undefined>,
): string {
	if (envName === "") return "";
	const key = env[envName];
	if (key === undefined || key === "") {
		throw new ModelPortConfigError(
			`环境变量 ${envName} 未设置：provider "${providerName}" 通过 api_key_env 间接引用 API 密钥。` +
				`请导出 ${envName} 后重试；配置文件中永不落明文密钥。` +
				`\n运行 bi doctor 可体检定位配置问题`,
		);
	}
	return key;
}

/** 直连适配器端口构造参数。 */
export interface AdapterModelPortOptions {
	baseUrl: string;
	apiKey: string;
	/** 供应商侧模型名。 */
	model: string;
	/** Wire 形态；缺省 'messages'（Anthropic 规范子集）。 */
	mode?: WireMode;
	thinking?: ThinkingEffort;
	maxTokens?: number;
	temperature?: number;
	/** 注入 fetch（离线测试用）；缺省 globalThis.fetch。 */
	fetchImpl?: FetchLike;
	anthropicVersion?: string;
	/** provider.extra_headers 透传（auto 会话头已在本模块解析为具体值）。 */
	extraHeaders?: Record<string, string>;
}

/**
 * 解析 provider.extra_headers → 请求头实值。
 * 特例：`x-opencode-session = "auto"` → 每次装配生成一个随机 UUID——
 * 装配实例 = 一个会话（REPL/ACP 进程内 memo 化，headless 一次性），
 * 满足 opencode Go 网关"会话内稳定、跨会话不同"的路由要求。
 */
export function resolveExtraHeaders(raw: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		out[key] =
			key === "x-opencode-session" && value === "auto" ? randomUUID() : value;
	}
	return out;
}

/** 直连形态：BI-04.2 双模态适配器包装为 ModelPort（每回合按当前消息重建请求）。 */
export function createAdapterModelPort(options: AdapterModelPortOptions): ModelPort {
	const mode: WireMode = options.mode ?? "messages";
	const adapter = DeepSeekAdapter({
		baseUrl: options.baseUrl,
		apiKey: options.apiKey,
		...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
		...(options.anthropicVersion === undefined ? {} : { anthropicVersion: options.anthropicVersion }),
		...(options.extraHeaders === undefined ? {} : { extraHeaders: options.extraHeaders }),
	});
	return {
		stream({ messages, tools, signal }): AsyncIterable<StreamEvent> {
			const request = buildRequest([...messages], {
				mode,
				model: options.model,
				...(options.thinking === undefined ? {} : { thinking: options.thinking }),
				...(options.maxTokens !== undefined && options.maxTokens > 0
					? { maxTokens: options.maxTokens }
					: {}),
				...(options.temperature === undefined ? {} : { temperature: options.temperature }),
				...(tools.length > 0 ? { tools: [...tools] } : {}),
				stream: true,
			});
			return adapter.stream(request, signal);
		},
	};
}

/** 装配结果（诊断用元数据 + 可用端口）。 */
export interface ModelSelection {
	readonly port: ModelPort;
	readonly providerName: string;
	/** models.entries 键（bi 侧模型 ID）。 */
	readonly modelId: string;
	/** 供应商侧模型名。 */
	readonly wireModel: string;
	readonly mode: WireMode;
	readonly baseUrl: string;
	readonly thinking: ThinkingEffort;
}

export interface ResolveModelPortOptions {
	/** 环境变量源（缺省 process.env；api_key_env 解析用）。 */
	env?: Record<string, string | undefined>;
	/** 注入 fetch（离线测试用）。 */
	fetchImpl?: FetchLike;
	/**
	 * 凭据门注入：main 传 `ConfigService.resolveProviderApiKey` 以复用其修复指引
	 * 与 ConfigError 形态；缺省用内置 env 直读（测试注入 env 用）。
	 */
	resolveApiKey?: (providerName: string) => string | undefined;
}

function firstKey(record: Record<string, unknown>): string | undefined {
	for (const key of Object.keys(record)) return key;
	return undefined;
}

/**
 * BiConfig → 真实 ModelPort。选择链：models.default（空 = entries 首个）→
 * 条目引用 provider（空 = providers.default → entries 首个）→ kind 定协议 →
 * 凭据门解析 key → 端口构造。任何一步缺失都结构化报错（含修复指引）。
 */
export function resolveModelPort(
	config: BiConfig,
	options: ResolveModelPortOptions = {},
): ModelSelection {
	const env = options.env ?? process.env;

	const modelId =
		config.models.default !== "" ? config.models.default : firstKey(config.models.entries);
	if (modelId === undefined || modelId === "") {
		throw new ModelPortConfigError(
			"未配置对话模型：请在 ~/.bi/config.toml 设置 [models.default] 并在 [models.entries.<id>] 声明 provider 与 model",
		);
	}
	const modelEntry = config.models.entries[modelId];
	if (modelEntry === undefined) {
		throw new ModelPortConfigError(`模型 "${modelId}"（models.default）不在 models.entries 中`);
	}

	const providerName =
		modelEntry.provider !== ""
			? modelEntry.provider
			: (config.providers.default !== "" ? config.providers.default : firstKey(config.providers.entries));
	if (providerName === undefined || providerName === "") {
		throw new ModelPortConfigError(
			`模型 "${modelId}" 未引用 provider：请补 [models.entries.${modelId}].provider 或 [providers.default]`,
		);
	}
	const providerEntry = config.providers.entries[providerName];
	if (providerEntry === undefined) {
		throw new ModelPortConfigError(
			`provider "${providerName}" 不在 providers.entries 中（模型 "${modelId}" 引用了它）`,
		);
	}

	const mode = wireModeFromKind(providerEntry.kind);
	if (modelEntry.model === "") {
		throw new ModelPortConfigError(`模型 "${modelId}" 缺供应商侧模型名（model 字段为空）`);
	}

	const apiKey =
		options.resolveApiKey !== undefined
			? (options.resolveApiKey(providerName) ?? "")
			: resolveApiKeyFromEnv(providerName, providerEntry.api_key_env, env);

	const thinking = effortToAdapter(config.thinking.enabled, config.thinking.effort);

	return {
		port: createAdapterModelPort({
			baseUrl: providerEntry.base_url,
			apiKey,
			model: modelEntry.model,
			mode,
			thinking,
			...(modelEntry.max_tokens > 0 ? { maxTokens: modelEntry.max_tokens } : {}),
			...(modelEntry.temperature === undefined ? {} : { temperature: modelEntry.temperature }),
			...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
			...(Object.keys(providerEntry.extra_headers).length > 0
				? { extraHeaders: resolveExtraHeaders(providerEntry.extra_headers) }
				: {}),
		}),
		providerName,
		modelId,
		wireModel: modelEntry.model,
		mode,
		baseUrl: providerEntry.base_url,
		thinking,
	};
}
