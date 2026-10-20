/**
 * 工单 H（BI-04 缺件补齐）—— bi 模型插槽路由器（新模块 + 装配）。
 *
 * 职责（钉死，最小可用版）：
 * - `assembleModelRouter`：config.secondary_model 三键（subagent/background/
 *   summarize，条目引用形式 = models.entries 的键）逐个尝试装配；任何一步失败
 *   （模型 ID 不在 entries / 供应商侧模型名为空 / resolvePort 抛出含凭据门失败）
 *   → 该插槽置空并结构化日志（stderr 一行，不阻断）；
 * - `ModelRouter.route(slot)`：slot 有配置且装配成功 → 返回插槽端口；否则回退
 *   主端口（永不因插槽缺失失败，回退是默认语义）；
 * - thinking/extra_headers 等端口参数与主端口装配同构（resolveModelPort 已处理，
 *   route 只做选择）；fast/reasoner/auditor 语义不引入——以 secondary_model
 *   现有三键为准。
 *
 * 消费面备案：subagent 插槽由 main.ts 装配点接线（SubagentRunner 的 model 参数）；
 * background/summarize 消费点随 BI-10 紧缩接线跟进，本模块只交付 route() 面。
 */
import type { BiConfig } from "../config/schema";
import type { ModelPort } from "./headless";

/** 插槽名（与 secondary_model 三键一一对应，不扩面）。 */
export type ModelSlotName = "subagent" | "background" | "summarize";

export const MODEL_SLOT_NAMES: readonly ModelSlotName[] = [
	"subagent",
	"background",
	"summarize",
];

/**
 * 插槽端口解析口（调用方注入，复用 resolveModelPort 的装配逻辑）：
 * 入参为供应商名与供应商侧模型名；装配失败（凭据门/无驱动协议等）以抛错上报，
 * 由本模块捕获折叠为「插槽置空 + 结构化日志」。
 */
export type ResolveSlotPort = (providerName: string, modelName: string) => ModelPort;

export interface ModelRouter {
	/** 主端口（插槽缺失/装配失败时的回退面）。 */
	readonly main: ModelPort;
	/** 插槽路由：有配置且装配成功 → 插槽端口；否则回退主端口（永不失败）。 */
	route(slot: ModelSlotName): ModelPort;
}

export interface AssembleModelRouterOptions {
	/** 主端口（route 回退面，必传）。 */
	main: ModelPort;
	/** 结构化日志汇（缺省 stderr 一行；测试注入收集）。 */
	log?: (line: string) => void;
}

/**
 * 装配模型插槽路由器：secondary_model 三键逐个尝试，失败置空 + 日志（不阻断）；
 * 未配置（键为空串）= 静默缺省（属回退语义，不算失败，不记日志）。
 * 本函数自身绝不抛错——插槽装配的全部失败面都已折叠为置空 + 日志。
 */
export function assembleModelRouter(
	config: BiConfig,
	resolvePort: ResolveSlotPort,
	options: AssembleModelRouterOptions,
): ModelRouter {
	const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	const slots: Partial<Record<ModelSlotName, ModelPort>> = {};
	for (const slot of MODEL_SLOT_NAMES) {
		const modelId = config.secondary_model?.[slot] ?? "";
		if (modelId === "") continue;
		const entry = config.models.entries[modelId];
		if (entry === undefined) {
			log(
				`bi: 模型插槽 ${slot} 装配失败 [slot-model-missing]: 模型 "${modelId}" 不在 models.entries 中，该插槽回退主端口`,
			);
			continue;
		}
		if (entry.model === "") {
			log(
				`bi: 模型插槽 ${slot} 装配失败 [slot-model-empty]: 模型 "${modelId}" 缺供应商侧模型名（model 字段为空），该插槽回退主端口`,
			);
			continue;
		}
		try {
			slots[slot] = resolvePort(entry.provider, entry.model);
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			log(
				`bi: 模型插槽 ${slot} 装配失败 [slot-port]: provider="${entry.provider}" model="${entry.model}"（${message}），该插槽回退主端口`,
			);
		}
	}
	return {
		main: options.main,
		route(slot: ModelSlotName): ModelPort {
			return slots[slot] ?? options.main;
		},
	};
}
