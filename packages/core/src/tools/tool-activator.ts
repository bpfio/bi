/**
 * BI-13.1（core 侧薄适配）— `select_tools` 工具处理器
 *
 * 职责：把 mcp 侧 ToolOnDemandRegistry 适配为模型可见的
 * `select_tools({ names })` 工具（输入校验 + select 分发 + 结果序列化 +
 * 压缩统计暴露）。结构类型注入，不 import packages/mcp 的具体类。
 *
 * 度量口径（"初态 System Prompt 工具开销压降 80%+"）：
 * - baselineBytes：假设把目录内所有工具的 name+description+inputSchema(JSON)
 *   全量直出时的 UTF-8 字节数（未做任何按需加载的对照基线）；
 * - initialBytes：初态表面（pinned 全量 Schema + 其余工具紧凑名录）的 UTF-8 字节数；
 * - reductionPercent = (1 - initialBytes / baselineBytes) * 100，目标 ≥ 80%；
 * - currentReductionPercent：以当前表面（含模型已激活工具）同口径计算；
 * - 字节统一按 UTF-8 计（TextEncoder），序列化形态为逐工具紧凑 JSON 对象之和。
 * - compressionStats() 暴露上述统计，供 TUI/日志与 BI-13.3 压缩器消费。
 */

// ---------- registry 最小结构面（与 mcp 侧 ToolOnDemandRegistry duck-type 兼容） ----------

export interface ActivatedToolLike {
	name: string;
	server: string;
	description: string;
	inputSchema: unknown;
}

export interface UnknownToolRefusalLike {
	kind: string;
	name: string;
	message: string;
	suggestions?: readonly string[];
}

export interface SelectResultLike {
	activated: ReadonlyArray<ActivatedToolLike>;
	alreadyActive: readonly string[];
	unknown: ReadonlyArray<UnknownToolRefusalLike>;
}

export interface SurfaceByteStatsLike {
	baselineBytes: number;
	initialBytes: number;
	currentBytes: number;
}

export interface SelectToolsRegistryLike {
	select(names: readonly string[]): Promise<SelectResultLike>;
	surfaceByteStats(): SurfaceByteStatsLike;
}

// ---------- 对外形态 ----------

export interface CompressionStats extends SurfaceByteStatsLike {
	/** 初态压降百分比（相对 baseline），两位小数。 */
	reductionPercent: number;
	/** 当前表面压降百分比（相对 baseline），两位小数。 */
	currentReductionPercent: number;
	/** 目标压降百分比（80）。 */
	targetPercent: number;
	/** 初态压降是否达标（≥80%）。 */
	meetsTarget: boolean;
}

/** 模型可见的工具规格。 */
export interface SelectToolsToolSpec {
	name: "select_tools";
	description: string;
	inputSchema: unknown;
}

/** handler 返回（JSON 可序列化，直接作为工具结果回给模型）。 */
export interface SelectToolsHandlerResult {
	activated: ActivatedToolLike[];
	alreadyActive: string[];
	unknown: Array<{ kind: string; name: string; message: string; suggestions?: string[] }>;
	/** 单行人读摘要。 */
	summary: string;
}

/** 非法输入的结构化拒绝（不走异常控制流）。 */
export interface InvalidInputError {
	kind: "invalid-input";
	message: string;
	issues: string[];
}

export type SelectToolsOutcome =
	| { ok: true; result: SelectToolsHandlerResult }
	| { ok: false; error: InvalidInputError };

export interface ToolActivator {
	tool: SelectToolsToolSpec;
	/** 输入校验 + select 分发 + 结果序列化；registry 内部异常原样上抛。 */
	handle(input: unknown): Promise<SelectToolsOutcome>;
	compressionStats(): CompressionStats;
}

/** 单次 select 允许的最大工具名数量。 */
export const MAX_SELECT_NAMES = 64;

/** 压降目标（百分比）。 */
export const REDUCTION_TARGET_PERCENT = 80;

/**
 * 构造模型可见的 `select_tools` 工具处理器。
 * registry 由调用方注入（结构类型），本模块零外部依赖。
 */
export function createToolActivator(registry: SelectToolsRegistryLike): ToolActivator {
	const tool: SelectToolsToolSpec = {
		name: "select_tools",
		description:
			"按需激活工具：初态只提供核心工具与紧凑名录（无参数 Schema）；" +
			"调用本工具传入要激活的工具名，换取对应工具的全量输入 Schema（含所属 server 路由）。" +
			"仅传紧凑名录中出现过的名字；重复激活幂等；未知名会返回最近候选建议。",
		inputSchema: {
			type: "object",
			properties: {
				names: {
					type: "array",
					items: { type: "string", minLength: 1 },
					description: `要激活的工具名列表（1~${MAX_SELECT_NAMES} 个）`,
					minItems: 1,
					maxItems: MAX_SELECT_NAMES,
				},
			},
			required: ["names"],
			additionalProperties: false,
		},
	};

	return {
		tool,
		async handle(input: unknown): Promise<SelectToolsOutcome> {
			const issues: string[] = [];
			if (typeof input !== "object" || input === null || Array.isArray(input)) {
				return {
					ok: false,
					error: {
						kind: "invalid-input",
						message: "select_tools 输入必须为对象 { names: string[] }",
						issues: ["输入不是对象"],
					},
				};
			}
			const rawNames = (input as Record<string, unknown>)["names"];
			if (!Array.isArray(rawNames)) {
				issues.push("names 必须为字符串数组");
			} else {
				if (rawNames.length === 0) {
					issues.push("names 不能为空数组");
				}
				if (rawNames.length > MAX_SELECT_NAMES) {
					issues.push(`names 数量超过上限 ${MAX_SELECT_NAMES}（实际 ${rawNames.length}）`);
				}
				for (const name of rawNames) {
					if (typeof name !== "string" || name.trim().length === 0) {
						issues.push("names 含空字符串或非字符串元素");
						break;
					}
				}
			}
			if (issues.length > 0) {
				return {
					ok: false,
					error: {
						kind: "invalid-input",
						message: `select_tools 输入校验失败（${issues.length} 项）`,
						issues,
					},
				};
			}
			const selectResult = await registry.select(rawNames as string[]);
			const result = serializeResult(selectResult);
			return { ok: true, result };
		},
		compressionStats(): CompressionStats {
			return computeCompressionStats(registry.surfaceByteStats());
		},
	};
}

/** 字节统计 → 压缩统计（两位小数舍入）。 */
export function computeCompressionStats(stats: SurfaceByteStatsLike): CompressionStats {
	const ratio = stats.baselineBytes > 0 ? 1 - stats.initialBytes / stats.baselineBytes : 0;
	const currentRatio =
		stats.baselineBytes > 0 ? 1 - stats.currentBytes / stats.baselineBytes : 0;
	const reductionPercent = round2(ratio * 100);
	return {
		...stats,
		reductionPercent,
		currentReductionPercent: round2(currentRatio * 100),
		targetPercent: REDUCTION_TARGET_PERCENT,
		meetsTarget: reductionPercent >= REDUCTION_TARGET_PERCENT,
	};
}

function serializeResult(selectResult: SelectResultLike): SelectToolsHandlerResult {
	const activated = selectResult.activated.map((tool) => ({ ...tool }));
	const unknown = selectResult.unknown.map((refusal) => ({
		kind: refusal.kind,
		name: refusal.name,
		message: refusal.message,
		...(Array.isArray(refusal.suggestions) ? { suggestions: [...refusal.suggestions] } : {}),
	}));
	const parts: string[] = [];
	if (activated.length > 0) {
		parts.push(`已激活 ${activated.length} 个工具（${activated.map((tool) => tool.name).join(", ")}）`);
	}
	if (selectResult.alreadyActive.length > 0) {
		parts.push(`${selectResult.alreadyActive.length} 个本就处于激活态`);
	}
	if (unknown.length > 0) {
		parts.push(`${unknown.length} 个未知名被拒绝`);
	}
	if (parts.length === 0) {
		parts.push("无变更");
	}
	return {
		activated,
		alreadyActive: [...selectResult.alreadyActive],
		unknown,
		summary: parts.join("；"),
	};
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}
