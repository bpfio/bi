/**
 * BI-23.1 —— 无头走骨架：把 117 卡器官缝成一条可运行的端到端链路。
 *
 * 装配序遵循 RULE-BI-07 定版的 kimi 装配参考（devlog #150）：
 * main 分发 → 会话/配置 → agent 循环 → 工具/权限/钩子。本模块是"缺的那根线"：
 * 模型对话驱动器（问模型 → 收流事件 → 拼工具调用 → 回填结果 → 直到最终文本），
 * 上承 adapters 的 StreamEvent/AgentMessage 线合约（BI-23.3 换真实 SSE 驱动零返工），
 * 下接 BI-07 AgentLoop 工具流水线、BI-06.5 权限门、BI-06.4 钩子、BI-03 JSONL 会话。
 *
 * 骨架期显式降级（不伪造能力）：
 * - 权限 ask 决策：无头无 TTY 无审批 UI → 结构化拒绝回喂模型（BI-23.2 提供 ask 回路）；
 * - 信任门：缺省恒 'trusted'（骨架策略；真实信任门接线归后续装配卡）；
 * - 子命令生态：main 分发只挂真实无头路径，其余子命令结构化"未接线"（不假冒）。
 *
 * 输出形态（BI-30.3 真消费，options.outputFormat）：
 * - stream-json（缺省，契约不变）：逐行透传 StreamEvent（BI-04.2 七类事件原样
 *   JSON），末行追加会话级 { type:"session_done", ... } 汇总；
 * - text：输出面收敛为最终 finalText 一段（事件内部流转照旧，仅不落 out；
 *   session_done 等 meta 不落 out；错误/诊断仍由装配方经 err 报出）。
 * - json（F-ST-02）：全程不落事件流，结束时 stdout 只落一个 JSON 对象
 *   （sessionId/title/rounds/usage/reply/exit，字段对齐 session_done 汇总）；
 *   失败路径不落任何 stdout 内容（绝不输出残缺 JSON），诊断仍由装配方经 err 报出；
 *   唯一例外：rounds-exceeded（回合打尽）落一个完整对象（exit="rounds-exceeded"，
 *   reply 空串），供自动化消费者拿到已探索状态。
 */
import {
	AgentLoop,
	type ToolCall,
	type ToolExecutor,
	type ToolResult,
} from "../agent";
import {
	type AgentMessage,
	type ContentBlock,
	type StopReason,
	type StreamEvent,
	type ToolDefinition,
	type ToolResultBlock,
	type TextBlock,
	type ToolUseBlock,
} from "../adapters/deepseek-adapter";
import { PermissionGate } from "../guard/permission-gate";
import type { PermissionRequest } from "../guard/types";
import type { WorkspaceTrustState } from "../guard/workspace-trust";
import { ToolTimeoutPolicy } from "../guard/timeout-policy";
import { systemClock, type Clock } from "../guard/deadline";
import { boundToolText } from "../context/bounded-tool-text";
import { buildTimeContext, DEFAULT_TIMEZONE } from "../context/time-context";
import { DateChangeSensor } from "../context/date-change-sensor";
import { pruneToolResult } from "../context/tool-result-pruner";
import { WindowManager } from "../context/window-manager";
import { offloadOldestImages } from "../context/image-offload";
import {
	AutoCompactor,
	CompactionCircuitOpenError,
	type Summarizer,
} from "../context/compactor";
import type { Msg } from "../context/tool-pairing";
import { sanitizeErrorPayload } from "../observability/endpoint-sanitizer";
import { join, resolve } from "node:path";
import * as nodeFs from "node:fs";
import {
	consolidate,
	DREAM_FILE_FILENAME,
	DEFAULT_DREAM_IDLE_MS,
} from "../memory/dream";
import type { FsLike } from "../rules";
import {
	DEFAULT_SHELL_RUNNER,
	TargetVerifier,
	type CommandRunner,
	type TargetContract,
	type VerificationResult,
} from "../verifier/target-verifier";
import type { VerifySection } from "../config/schema";
import type { IdentitySection } from "../config/schema";
import { HookRunner, type HookSpawnImpl } from "../hooks/hook-runner";
import type { HookRunRecord } from "../hooks/types";
import { loadHooksConfig } from "../config/hooks-adapter";
import type { HooksSection } from "../config/schema";
import { scanShell } from "../sandbox/shell-scan";
import { type SubagentRunner } from "../subagent/runner";
import { spawnSubagentBinding } from "./subagent-adapter";
import { SessionManager } from "../session/manager";
import type { AppendEntryInput, JsonValue, SessionEntry } from "../session/types";
import type { OutputFormat } from "./commands/args";

/** 模型端口：与 adapters 线合约对齐的最小驱动面（真实 SSE 驱动 BI-23.3 接入）。 */
export interface ModelPort {
	stream(input: {
		messages: readonly AgentMessage[];
		tools: readonly ToolDefinition[];
		signal?: AbortSignal;
	}): AsyncIterable<StreamEvent>;
}

/** 工具绑定：定义（喂模型）+ 执行体（真实器官）+ 权限面（argSummary）。 */
export interface ToolBinding {
	readonly definition: ToolDefinition;
	/** 只读工具（RWLock 读锁语义 + 只读排重资格）。 */
	readonly readOnly: boolean;
	/** 权限门 argSummary（缺省取 JSON 序列化截断）。 */
	readonly argSummary?: (args: unknown) => string;
	execute(args: unknown, signal: AbortSignal): Promise<unknown> | unknown;
}

export interface HeadlessOptions {
	readonly prompt: string;
	readonly cwd: string;
	readonly model: ModelPort;
	readonly tools: readonly ToolBinding[];
	/** config.toml [[hooks]] 分区（经 BI-01.1 装载适配器映射到 runner 契约）。 */
	readonly hooks?: HooksSection;
	/** 权限门初始模式（缺省 "auto"：全自动放行 + 审计标记；manual 下 ask 走降级拒绝）。 */
	readonly permissionMode?: "manual" | "auto" | "yolo";
	/**
	 * 注入门禁（BI-28.3 接线）：装配层已按 config [permission] mode/rules 建好
	 * 门禁时注入（与 /permissions 命令面共享实例）；缺省按 permissionMode 自建
	 * （缺省 auto：无头路径 ask 不可达，走结构化降级拒绝）。
	 */
	readonly gate?: PermissionGate;
	/** 会话存储根（缺省 SessionManager 默认根）。 */
	readonly sessionsRoot?: string;
	readonly sessionId?: string;
	/** 信任门（骨架缺省恒 trusted）。 */
	readonly trust?: (root: string) => WorkspaceTrustState;
	/** spawn 替身（钩子测试注入；缺省真实子进程）。 */
	readonly hookSpawn?: HookSpawnImpl;
	/** 输出汇（缺省 process.stdout 逐行；测试注入收集）。 */
	readonly out?: (line: string) => void;
	/**
	 * 输出形态（BI-30.3）：缺省 "stream-json" = 逐行透传 StreamEvent + 末行
	 * session_done（现状行为，契约不变）；"text" = 仅落最终 finalText 一段；
	 * "json"（F-ST-02）= 全程不落事件流，结束时 stdout 只落一个 JSON 对象
	 * （sessionId/title/rounds/usage/reply/exit）。
	 */
	readonly outputFormat?: OutputFormat;
	/**
	 * 模型回合上限（防失控，缺省 16）。装配层优先级：CLI --max-rounds > deps 透传 >
	 * config [session] max_rounds（>0 才生效）> 本缺省 16。
	 */
	readonly maxRounds?: number;
	/**
	 * 单回合工具调用上限（对应 config [loop_control] max_tool_calls_per_turn）。
	 * 超限调用**不执行**，回填结构化拒绝结果（不炸回合）；缺省 / ≤0 = 不限。
	 */
	readonly maxToolCallsPerTurn?: number;
	/**
	 * 工具限时看门狗缺省时限（对应 config [loop_control] step_timeout_ms）。
	 * >0 且未显式提供 timeoutPolicy 时装配缺省 ToolTimeoutPolicy（未知工具的看门狗上限）；
	 * 0 = 关闭看门狗（= 现状不限时）。
	 */
	readonly stepTimeoutMs?: number;
	/**
	 * 工具限时看门狗显式注入面（缺省不提供 = 由 stepTimeoutMs 决定是否自建；
	 * 显式提供时优先，stepTimeoutMs 不再自建）。
	 */
	readonly timeoutPolicy?: ToolTimeoutPolicy;
	/**
	 * 单回合总时限（对应 config [loop_control] turn_timeout_ms；缺省 / ≤0 = 不限）。
	 * 超时 → 在飞工具协作取消 + 结构化失败面（exit="turn-timeout"）+ stderr 提示。
	 */
	readonly turnTimeoutMs?: number;
	/**
	 * 注入时钟（单回合时限计时与看门狗定时器；缺省系统时钟）。
	 */
	readonly clock?: Clock;
	/**
	 * [identity] 分区（config identity.*）：system_prompt_path / extra_instructions 消费面。
	 * 缺省不提供 = 不消费 identity 的系统指令面（现状逐字节等价）。
	 */
	readonly identity?: IdentitySection;
	/**
	 * 诊断输出汇（缺省 process.stderr；测试注入收集）。承载 [identity]
	 * system_prompt_path 读取失败的结构化 warn 与 [loop_control] turn_timeout_ms
	 * 超时的结构化提示。
	 */
	readonly err?: (line: string) => void;
	/**
	 * 系统指令注入面（BI-20.2b：--agent-file 内容作为系统指令前置）。
	 * 若存在，渲染为消息序首条 { role:"system" }；缺省不注入。绝不假冒——
	 * 只有 CLI 真实读到文件才传此值。
	 */
	readonly systemInstruction?: string;
	/**
	 * 附加可访问目录（BI-20.2b：--add-dir 聚合透传）。toolset 暂仅单根，本面
	 * 只做"存在性校验（缺失由 CLI 判 exit 2）+ 透传进会话上下文"，不暴露进
	 * 文件工具访问面，边界在最终回复备案；不许静默丢弃。
	 */
	readonly additionalDirs?: readonly string[];
	/**
	 * BI-08.1 有界截断上限（Unicode 码点；对应 config [tools] output_limit_bytes）。
	 * 本面缺省 / ≤0 = 不截断（直连调用方现状路径逐字节等价）；>0 时工具**成功
	 * 输出**超限经 boundToolText 两级预算截断，替换为带结构化标记行的有界文本；
	 * 未超限不截。CLI 装配层经 config 下发缺省 64KiB（F-ST-04），
	 * config 显式 0 = 关闭（装配层不下发，本面即按不截断处理）。
	 */
	readonly outputLimitBytes?: number;
	/**
	 * BI-11.1 脱敏开关（对应 config [telemetry] sanitize_errors）。true = 会话
	 * 错误文本（HeadlessError 抛出口）先经 sanitizeErrorPayload 再抛出；
	 * 缺省 false = 原样（现状）。
	 */
	readonly sanitizeErrors?: boolean;
	/**
	 * BI-21.1 完工自验看门狗（对应 config [verify] on_completion）。提供即在
	 * 会话收尾前跑 TargetVerifier：通过 = 原路输出 + verification 回执；
	 * 不通过 = 结构化差距报告 + HeadlessError("verify-failed")（装配方转非零
	 * 退出码，不假冒成功）。缺省不提供 = 零开销零行为差。
	 */
	readonly verify?: {
		readonly contract: TargetContract;
		/** 命令执行器（缺省 target-verifier 既有 shell spawn 面；测试注入脚本化替身）。 */
		readonly runner?: CommandRunner;
	};
	/**
	 * BI-07.4 子智能体装配（对应 config [subagent] enabled）。提供即把
	 * spawn_subagent 工具追加进本次会话工具数组（与 buildDefaultToolset 的
	 * subagentRunner 选项二选一装配；本面用于 headless 装配点跳过工具集重建、
	 * 保留注入的 options.tools）。缺省 = 不追加（既有工具面零变动）。
	 */
	readonly subagentRunner?: SubagentRunner;
	/**
	 * BI-05.3（W3-D7）上下文引擎装配面（对应 config [context] 挂载式分区）。
	 * 缺省不提供 = 全部开关恒关（现状路径逐字节等价）。每个子开关独立缺省关，
	 * 装配层按 config [context] 显式声明才生效——不静默开启任何行为。
	 */
	readonly context?: HeadlessContextOptions;
	/**
	 * BI-05.1（W4-D9）记忆沉淀装配面（对应 config [memory] 挂载式分区）。
	 * 缺省不提供 = 全部开关恒关（现状路径逐字节等价）。dream = 会话收尾沉淀，
	 * inject = 会话启动注入；每个子开关独立缺省关，装配层按 config [memory]
	 * 显式声明才生效——不静默开启任何行为。
	 */
	readonly memory?: HeadlessMemoryOptions;
}

/** BI-05.1（W4-D9）记忆沉淀装配选项（config [memory] 挂载式分区映射；缺省不提供 = 全关=现状逐字节等价）。 */
export interface HeadlessMemoryOptions {
	/**
	 * 会话收尾沉淀（对应 config [memory] dream_enabled）。仅在 finalText 落定/
	 * 正常退出时触发：经 dream 器官 consolidate 写入 <dir>/BI.dream.md，空闲阈值
	 * 用器官既有常量、锁文件防并发。缺省不提供 = 不沉淀（零开销零行为差）。
	 */
	readonly dream?: HeadlessMemoryDreamOptions;
	/**
	 * 会话启动注入（对应 config [memory] inject_enabled）。启动依次读
	 * <dir>/BI.md（项目记忆，init 脚手架产出）与 <dir>/BI.dream.md（dream 沉淀），
	 * 各自存在且非空才经 systemInstruction 前缀注入（BI.md 段在前；两文件内容
	 * 相同则只注一次）。与 --agent-file 共存时 agent-file 优先，记忆追加其后。
	 * 缺省不提供 = 不注入。
	 */
	readonly inject?: HeadlessMemoryInjectOptions;
}

/** F-ST-05：项目记忆文件名（init 脚手架产出；启动注入时与 BI.dream.md 一并读）。 */
export const PROJECT_MEMORY_FILENAME = "BI.md";

/** BI-05.1 会话收尾沉淀选项（dream 器官消费面；全部可注入以支持确定性测试）。 */
export interface HeadlessMemoryDreamOptions {
	/** 沉淀目标根目录（缺省 options.cwd）。 */
	readonly dir?: string;
	/** 精华提取器（缺省 = 以 finalText 本身为精华串）。 */
	readonly extractor?: (session: string) => string | null | undefined;
	/** 注入文件系统（测试用内存；缺省 node:fs）。 */
	readonly fs?: FsLike;
	/** 注入时钟（毫秒；缺省 Date.now）。 */
	readonly now?: () => number;
	/** 空闲毫秒（缺省 = 器官 DEFAULT_DREAM_IDLE_MS，恰好到达阈值即做梦）。 */
	readonly idleMs?: number;
}

/** BI-05.1 会话启动注入选项（inject 消费面）。 */
export interface HeadlessMemoryInjectOptions {
	/** 注入读取根目录（缺省 options.cwd）。 */
	readonly dir?: string;
	/** 注入文件系统（测试用内存；缺省 node:fs）。 */
	readonly fs?: FsLike;
}

/** BI-05.3 上下文引擎装配选项（config [context] 子键映射；全部缺省关）。 */
export interface HeadlessContextOptions {
	/** time-context：注入当前时钟上下文到 system 面。缺省 false = off。 */
	readonly timeContext?: boolean;
	/** date-change-sensor：跨日翻转披露（每自然日至多一次）。缺省 false = off。 */
	readonly dateChangeSensor?: boolean;
	/** tool-result-pruner：工具结果二级修剪（紧接 boundToolText）。缺省 false = off。 */
	readonly toolResultPrune?: boolean;
	/** window-manager：历史条目上限裁剪（>0 生效，0 = off）。 */
	readonly maxHistoryEntries?: number;
	/**
	 * BI-08.2：image-offload 渐进图像卸载（对应 config [context] image_offload）。
	 * true = 每回合构造请求消息前对历史跑一次 offloadOldestImages（超限策略以
	 * 器官自带参数为准）；缺省 false = off（零开销零行为差）。
	 */
	readonly imageOffload?: boolean;
	/**
	 * BI-10：AutoCompactor 80% 高水位静默紧缩（对应 config [context] auto_compactor）。
	 * true = 每回合构造请求消息前按水位判定静默紧缩（summarizer 复用当前 model
	 * 端口）；缺省 false = off（现状条目数门禁裁剪路径，完全不进）。
	 */
	readonly autoCompactor?: boolean;
	/**
	 * BI-10 紧缩视窗分母（token 读数；测试确定性注入，仿 now 注入先例）。
	 * 缺省 128_000。仅 autoCompactor 开启时消费。
	 */
	readonly autoCompactorWindowTokens?: number;
	/** 共用 IANA 时区（time_context / date_change_sensor）。缺省 Asia/Shanghai。 */
	readonly timezone?: string;
	/** 注入时钟（测试确定性）。缺省 Date.now。 */
	readonly now?: () => number;
}

export interface HeadlessResult {
	readonly exitCode: number;
	readonly sessionId: string;
	readonly finalText: string;
	readonly rounds: number;
	readonly toolResults: readonly ToolResult[];
	readonly hookRecords: readonly HookRunRecord[];
	/** 权限审计轨迹（工具序）。 */
	readonly permissionDecisions: ReadonlyArray<{ tool: string; decision: string }>;
	/** 附加目录透传面（BI-20.2b；供验收确认未静默丢弃；toolset 单根边界见备案）。 */
	readonly additionalDirs: readonly string[];
	/** 收尾自验回执（仅 [verify] on_completion 开启且实际跑过时存在）。 */
	readonly verification?: VerificationResult;
}

/** 工具调用增量按 index 拼装缓冲（BI-23.2 TUI 挂载复用）。 */
export class ToolCallAssembler {
	#calls = new Map<number, { id?: string; name?: string; args: string }>();

	push(event: Extract<StreamEvent, { type: "tool_call_delta" }>): void {
		const current = this.#calls.get(event.index) ?? { args: "" };
		if (event.id !== undefined) current.id = event.id;
		if (event.name !== undefined) current.name = event.name;
		current.args += event.argumentsDelta;
		this.#calls.set(event.index, current);
	}

	/** 按 index 升序产出拼装完成的调用；清空缓冲。 */
	drain(): ToolCall[] {
		const calls: ToolCall[] = [];
		for (const index of [...this.#calls.keys()].sort((a, b) => a - b)) {
			const partial = this.#calls.get(index)!;
			let parsed: unknown;
			try {
				parsed = JSON.parse(partial.args === "" ? "{}" : partial.args);
			} catch {
				parsed = { __raw: partial.args };
			}
			calls.push({ id: partial.id ?? `call_${index}`, name: partial.name ?? "unknown", args: parsed });
		}
		this.#calls = new Map();
		return calls;
	}
}

/** 会话级装配错误（main 捕获转退出码）。 */
export class HeadlessError extends Error {
	readonly code: "hook-blocked" | "adapter-error" | "rounds-exceeded" | "turn-timeout" | "verify-failed" | "session-not-found";
	/** verify-failed 时的结构化自验结果（含 gaps；其余 code 缺省）。 */
	readonly verification?: VerificationResult;
	constructor(
		code: "hook-blocked" | "adapter-error" | "rounds-exceeded" | "turn-timeout" | "verify-failed" | "session-not-found",
		message: string,
		verification?: VerificationResult,
	) {
		super(message);
		this.name = "HeadlessError";
		this.code = code;
		if (verification !== undefined) this.verification = verification;
	}
}

/**
 * [loop_control] turn_timeout_ms 单回合总时限到点（内部信号）。
 *
 * 与会话级失败码区分：本类只用于打断当前回合（竞速面），对外失败面由
 * failSession("turn-timeout") 抛出（携带脱敏与结构化语义）。
 */
export class TurnTimeoutSignal extends Error {
	readonly code = "turn-timeout" as const;
	constructor(readonly timeoutMs: number) {
		super(`turn exceeded ${timeoutMs}ms`);
		this.name = "TurnTimeoutSignal";
	}
}

/**
 * config [verify] 分区 → TargetContract（装配层转换，纯函数）。
 * 语义钉死：
 * - TOML 只能声明 command 检查（predicate 是代码面，不可配置化）→ kind 恒 "command"；
 * - tolerance 恒 "best-effort"：命令失败降级为 gap 收集**完整**自愈清单，
 *   而非 strict 快失败中断（完工门的产物是差距清单，不是第一个错误）；
 * - path 原样传递：相对路径由 verifier 以会话 cwd 为 workspaceRoot 解析。
 */
export function buildVerifyContract(section: VerifySection): TargetContract {
	return {
		objective: section.objective,
		deliverables: section.deliverables.map((d) => ({
			path: d.path,
			mustExist: d.must_exist,
			mustContain: [...d.must_contain],
		})),
		checks: section.checks.map((c) => ({
			id: c.id,
			kind: "command" as const,
			command: c.command,
			description: c.description,
		})),
		tolerance: "best-effort",
	};
}

/**
 * 无头走骨架主流程：一条带真实工具调用、权限门、钩子触发与 JSONL 落盘的会话。
 */
export async function runHeadless(options: HeadlessOptions): Promise<HeadlessResult> {
	const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
	/** 诊断输出汇（缺省 stderr）：结构化 warn / 提示面（测试注入收集）。 */
	const errOut = options.err ?? ((line: string) => process.stderr.write(`${line}\n`));
	const outputFormat: OutputFormat = options.outputFormat ?? "stream-json";
	// [loop_control] 四键消费面（装配层经 config 下发；缺省/≤0 = 该键不生效）：
	// - max_tool_calls_per_turn：单回合工具调用上限（超限调用不执行，回填结构化拒绝）；
	// - step_timeout_ms：工具限时看门狗缺省时限（>0 且未显式注入 timeoutPolicy 时自建缺省看门狗）；
	// - turn_timeout_ms：单回合总时限（>0 时每回合起时限看门狗）。
	// 注：子代理循环不走本面（自带 max_iterations 语义，见 cli/subagent-adapter.ts）。
	const maxToolCallsPerTurn = options.maxToolCallsPerTurn ?? 0;
	const stepTimeoutMs = options.stepTimeoutMs ?? 0;
	const turnTimeoutMs = options.turnTimeoutMs ?? 0;
	/** 单回合时限计时时钟（可注入；缺省系统时钟）。 */
	const turnClock = options.clock ?? systemClock;
	// text / json 形态：输出面收敛——事件仍内部流转（缓冲/回喂不变），仅不落 out；
	// text 最终只落 finalText 一段，json 最终只落一个 JSON 对象（见下方终局分支）。
	// stream-json 保持逐行透传。
	const emit = (event: unknown): void => {
		if (outputFormat === "stream-json") out(JSON.stringify(event));
	};
	// BI-08.1：输出上限（码点）；本面缺省 / ≤0 = 关闭（直连调用方现状路径逐字节
	// 等价）。CLI 装配层经 config [tools] output_limit_bytes 下发缺省 64KiB
	// （F-ST-04），config 显式 0 = 关闭（装配层不下发 → 此处即关闭）。
	const outputLimitBytes = options.outputLimitBytes ?? 0;
	// BI-05.3（W3-D7）：上下文引擎开关解析（全部缺省关；context 未提供 = 恒关）。
	const ctx = options.context ?? {};
	const ctxTime = ctx.timeContext === true;
	const ctxDate = ctx.dateChangeSensor === true;
	const ctxPrune = ctx.toolResultPrune === true;
	const ctxMaxHist = ctx.maxHistoryEntries ?? 0;
	// 虚账清偿波次 1：BI-08.2 / BI-10 两开关解析（缺省关 = 现状路径逐字节等价）。
	const ctxImageOffload = ctx.imageOffload === true;
	const ctxAutoCompact = ctx.autoCompactor === true;
	const ctxCompactWindowTokens = ctx.autoCompactorWindowTokens ?? 128_000;
	const ctxTz = ctx.timezone ?? DEFAULT_TIMEZONE;
	const ctxNow = ctx.now ?? Date.now;
	// 跨日感知器（内部态持久跨轮；discloseDateChange 每轮调用推进基线）。
	const dateSensor = ctxDate ? new DateChangeSensor({ timezone: ctxTz }) : undefined;
	/** 会话装配错误统一抛出口：sanitizeErrors 开启时消息先过脱敏器（BI-11.1）。 */
	const failSession = (
		code: HeadlessError["code"],
		message: string,
		verification?: VerificationResult,
	): HeadlessError =>
		new HeadlessError(
			code,
			options.sanitizeErrors === true ? sanitizeErrorPayload(message) : message,
			verification,
		);
	const toolResults: ToolResult[] = [];
	const hookRecords: HookRunRecord[] = [];
	const permissionDecisions: Array<{ tool: string; decision: string }> = [];
	/** 收尾自验回执（BI-21.1；仅 verify 开关生效时赋值）。 */
	let verificationResult: VerificationResult | undefined;
	/** 最近一次真实 usage 读数（BI-10 用量优先级：事件读数 > 字符估算）。 */
	let lastUsageInputTokens: number | undefined;
	/**
	 * 会话级用量汇总（json 输出面字段；逐轮取本轮最大值后累加——同轮多次上报
	 * 取最大值，防累计式重复计数；跨轮累加 = 会话总用量）。
	 */
	const usageTotals = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };
	/** json 输出面的用量载荷（成功 / rounds-exceeded 失败两处同形；cached/reasoning 仅 >0 时带出）。 */
	const usagePayload = (): Record<string, number> => ({
		inputTokens: usageTotals.inputTokens,
		outputTokens: usageTotals.outputTokens,
		...(usageTotals.cachedInputTokens > 0 ? { cachedInputTokens: usageTotals.cachedInputTokens } : {}),
		...(usageTotals.reasoningTokens > 0 ? { reasoningTokens: usageTotals.reasoningTokens } : {}),
	});

	// ---- 装配序 ①：钩子（config [[hooks]] → BI-01.1 适配器 → BI-06.4 runner）----
	const loadedHooks = loadHooksConfig(options.hooks ?? { enabled: true, entries: [] });
	hookRecords.push(...loadedHooks.dropped.map((drop) => ({
		hookId: `hooks[${drop.index}]`,
		event: "SessionStart" as const,
		command: "",
		status: "bad-output" as const,
		durationMs: 0,
		warning: `hook-load-dropped: ${drop.reason}`,
	})));
	const hookRunner = new HookRunner({
		config: loadedHooks.config,
		trust: options.trust ?? (() => "trusted"),
		scanShell,
		...(options.hookSpawn !== undefined ? { spawnImpl: options.hookSpawn } : {}),
	});
	const hookInput = (event: Parameters<HookRunner["run"]>[0], tool?: string, args?: unknown) => ({
		event,
		...(tool !== undefined ? { tool } : {}),
		...(args !== undefined ? { args } : {}),
		timestamp: new Date().toISOString(),
	});

	// ---- 装配序 ②：会话（BI-03 JSONL）----
	// 0.3.0 测试发现补齐 --resume 语义：sessionId 传入=打开既有会话接续
	// （末条目作追加父节点；不存在=结构化退出），未传入=新建。
	const manager = new SessionManager(options.sessionsRoot !== undefined ? { rootDir: options.sessionsRoot } : {});
	let sessionId: string;
	/** 会话标题（json 输出面字段；新建 = prompt 前 80 字，续会话 = 既有会话标题）。 */
	let sessionTitle = "";
	let resumeTailId: string | null = null;
	/** --resume 时的既有条目（重放进模型上下文；非 resume 恒空）。 */
	let resumeEntries: import("../session/types").SessionEntry[] = [];
	if (options.sessionId !== undefined) {
		const resumeMeta = await manager.getSessionMeta(options.sessionId);
		if (resumeMeta === undefined) {
			emit({ type: "session_done", sessionId: options.sessionId, exit: "session-not-found" });
			throw failSession("session-not-found", `--resume 会话不存在: ${options.sessionId}`);
		}
		sessionId = options.sessionId;
		sessionTitle = resumeMeta.title;
		resumeEntries = await manager.entries(sessionId);
		resumeTailId = resumeEntries.length > 0 ? resumeEntries[resumeEntries.length - 1]!.id : null;
	} else {
		const session = await manager.createSession({
			title: options.prompt.slice(0, 80),
			cwd: options.cwd,
		});
		sessionId = session.sessionId;
		sessionTitle = session.title;
	}

	// SessionStart 钩子：block 即拒开会话（fail-closed，结构化退出）。
	const startOutcome = await hookRunner.run("SessionStart", { ...hookInput("SessionStart"), sessionId, cwd: options.cwd });
	hookRecords.push(...startOutcome.records);
	if (startOutcome.action === "block") {
		emit({ type: "session_done", sessionId, exit: "hook-blocked", reason: startOutcome.reason });
		throw failSession("hook-blocked", `SessionStart 钩子阻断会话: ${startOutcome.reason ?? "no reason"}`);
	}

	// ---- 装配序 ③：权限门（BI-06.5）与工具注册表 ----
	const gate = options.gate ?? new PermissionGate({ mode: options.permissionMode ?? "auto" });
	// BI-07.4：subagentRunner 注入即把 spawn_subagent 追加进本次会话工具数组
	// （跳过工具集重建，保留注入的 options.tools；与 buildDefaultToolset 选项二选一）。
	const tools: ToolBinding[] = [...options.tools];
	if (options.subagentRunner !== undefined) {
		tools.push(spawnSubagentBinding(options.subagentRunner));
	}
	const registry = new Map<string, ToolBinding>();
	for (const binding of tools) registry.set(binding.definition.name, binding);
	const readOnlyTools = new Set(tools.filter((t) => t.readOnly).map((t) => t.definition.name));

	/** 装配执行体：权限门 → PreToolUse 钩子 → 真实工具 → PostToolUse 钩子（AgentLoop 钩子固定序之外的装配层环节）。 */
	const assembledExecutor: ToolExecutor = async (call: ToolCall, signal: AbortSignal): Promise<unknown> => {
		const binding = registry.get(call.name);
		if (binding === undefined) throw new Error(`unknown-tool: ${call.name}`);
		const argSummary = binding.argSummary?.(call.args) ?? String(JSON.stringify(call.args) ?? "undefined").slice(0, 200);

		const decision = gate.check({ tool: call.name, argSummary, mode: gate.mode } satisfies PermissionRequest);
		permissionDecisions.push({ tool: call.name, decision: decision.decision });
		if (decision.decision === "deny") throw new Error(`permission-denied${decision.feedback !== undefined ? `: ${decision.feedback}` : ""}`);
		if (decision.decision === "ask") {
			// 骨架期降级：无头无审批 UI，结构化拒绝回喂模型（BI-23.2 提供 ask 回路）。
			throw new Error("permission-ask-unavailable-in-headless");
		}

		const pre = await hookRunner.run("PreToolUse", { ...hookInput("PreToolUse", call.name, call.args), sessionId, cwd: options.cwd });
		hookRecords.push(...pre.records);
		if (pre.action === "block") throw new Error(`hook-blocked: ${pre.reason ?? "no reason"}`);

		const value = await binding.execute(call.args, signal);
		// BI-08.1：上限 >0 时成功输出有界化（两级预算；未超限 = 原样返回，
		// 只有 bounded 才替换为带结构化标记行的文本）。
		let boundedValue: unknown = value;
		if (outputLimitBytes > 0) {
			const text = typeof value === "string" ? value : safeStringify(value);
			const bounded = boundToolText(text, { maxChars: outputLimitBytes });
			if (bounded.bounded) boundedValue = bounded.text;
		}
		// BI-05.3（W3-D7）：tool-result-pruner 二级修剪（紧接 boundToolText 之后，
		// 纵深防御）。仅当 ctxPrune 开启且当前值为字符串时生效；未超限（≤8192 码点）
		// 原样返回，零变形。缺省 ctxPrune=false = 不修剪（现状逐字节等价）。
		if (ctxPrune === true && typeof boundedValue === "string") {
			boundedValue = pruneToolResult(boundedValue);
		}

		const post = await hookRunner.run("PostToolUse", { ...hookInput("PostToolUse", call.name, call.args), sessionId, cwd: options.cwd });
		hookRecords.push(...post.records); // PostToolUse block 仅记录（执行已完成），不阻断
		return boundedValue;
	};

	const agentLoop = new AgentLoop({
		execute: assembledExecutor,
		readOnlyTools,
		// [loop_control] max_tool_calls_per_turn：单回合工具调用上限（超限调用不执行，
		// 回填结构化拒绝；0 = 不限，缺省不限）。
		...(maxToolCallsPerTurn > 0 ? { maxToolCallsPerTurn } : {}),
		// [loop_control] step_timeout_ms：工具限时看门狗缺省时限。显式注入的 timeoutPolicy
		// 优先；未注入且 step_timeout_ms > 0 时自建缺省看门狗（未知工具按此上限，
		// 内置表键沿用既有限时）。0 = 关闭看门狗（现状不限时）。
		...(options.timeoutPolicy !== undefined
			? { timeoutPolicy: options.timeoutPolicy }
			: stepTimeoutMs > 0
				? { timeoutPolicy: new ToolTimeoutPolicy({ defaultTimeoutMs: stepTimeoutMs }) }
				: {}),
	});

	/**
	 * [loop_control] turn_timeout_ms 单回合时限看门狗（缺省不限时 = 不建，空转）。
	 *
	 * 到点语义：abort 本回合的模型流（协作取消信号透传给模型端口）+ abort 在飞工具
	 * 批次（AgentLoop.abortInFlightTools，不改回合状态）→ 以 TurnTimeoutSignal 打断
	 * 本回合；对外失败面（终局输出 + failSession("turn-timeout")）由回合 catch 统一落。
	 */
	const startTurnWatchdog = (): {
		readonly signal: AbortSignal | undefined;
		readonly race: <T>(promise: Promise<T>) => Promise<T>;
		readonly dispose: () => void;
	} => {
		if (turnTimeoutMs <= 0) {
			return {
				signal: undefined,
				race: <T>(promise: Promise<T>): Promise<T> => promise,
				dispose: () => undefined,
			};
		}
		const controller = new AbortController();
		let handle: unknown;
		let disposed = false;
		const timeoutSignal = new TurnTimeoutSignal(turnTimeoutMs);
		const timeoutPromise = new Promise<never>((_resolve, reject) => {
			handle = turnClock.setTimeout(() => {
				if (disposed) return;
				controller.abort(timeoutSignal);
				agentLoop.abortInFlightTools(timeoutSignal);
				reject(timeoutSignal);
			}, turnTimeoutMs);
		});
		// 兜底处理器：竞速之外的拒绝路径也不产生未捕获拒绝。
		timeoutPromise.catch(() => undefined);
		return {
			signal: controller.signal,
			race: <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, timeoutPromise]),
			dispose: () => {
				disposed = true;
				turnClock.clearTimeout(handle);
			},
		};
	};

	// ---- 装配序 ④：模型对话驱动器 ----
	// BI-20.2b：--agent-file 内容作为系统指令前置（系统消息面；无则单条 user）。
	// BI-05.3（W3-D7）：time-context 当前时钟块作为 system 面追加（缺省 ctxTime=false
	// 不追加，逐字节等价）；date-change-sensor 基线在首轮 discloseDateChange 建立。
	const systemParts: string[] = [];
	// [identity] system_prompt_path → 系统指令前缀。CLI --agent-file 优先（CLI 给了
	// 就不读 config 路径——两者不叠加）；config 声明且 CLI 未给时读该文件内容作为
	// 系统指令前缀；文件缺失/不可读 → 结构化 warn（stderr）不炸会话，回退内置（零注入）。
	if (options.systemInstruction !== undefined) {
		systemParts.push(options.systemInstruction);
	} else {
		const promptPath = options.identity?.system_prompt_path?.trim() ?? "";
		if (promptPath !== "") {
			const absPath = resolve(options.cwd, promptPath);
			try {
				const content = nodeFs.readFileSync(absPath, "utf8").trim();
				if (content !== "") systemParts.push(content);
			} catch (cause) {
				errOut(
					`bi: [identity] system_prompt_path 不可读或不存在: ${absPath}（${cause instanceof Error ? cause.message : String(cause)}）——回退内置系统指令`,
				);
			}
		}
	}
	// BI-05.1（W4-D9）：[memory] inject_enabled → 启动读 <cwd>/BI.dream.md，存在则
	// 内容经 system 面前缀注入。与 --agent-file 共存时 agent-file 优先（已先 push），
	// dream 追加其后；文件不存在/空 = 不注入（缺省态，零行为差）。
	//
	// F-ST-05：注入链补 BI.md——init 脚手架产出的项目记忆（BI.md）此前永不被消费。
	// 改为依次读 BI.md（项目记忆）与 BI.dream.md（dream 沉淀）两文件：各自存在且
	// 非空才注入，BI.md 段在前（项目规则先于沉淀记忆）；两文件内容相同时只注一次
	// （去重，防同一段文本重复进 system 面）。
	if (options.memory?.inject !== undefined) {
		const inj = options.memory.inject;
		const injFs = inj.fs ?? nodeFs;
		const injDir = inj.dir ?? options.cwd;
		const injected = new Set<string>();
		for (const fileName of [PROJECT_MEMORY_FILENAME, DREAM_FILE_FILENAME]) {
			try {
				const content = injFs.readFileSync(join(injDir, fileName), "utf8").trim();
				if (content.length === 0) continue;
				if (injected.has(content)) continue; // 两文件内容相同 → 只注一次
				injected.add(content);
				systemParts.push(content);
			} catch {
				// 文件不存在/不可读：视为缺省态，skip（绝不假冒成功）。
			}
		}
	}
	if (ctxTime) {
		systemParts.push(buildTimeContext({ isoNow: new Date(ctxNow()).toISOString(), timezone: ctxTz }));
	}
	// [identity] extra_instructions → 系统面末条（顺序钉死：CLI agent-file（或 config
	// system_prompt_path）→ 内建（项目记忆/时钟块）→ extra_instructions）。
	const extraInstructions = options.identity?.extra_instructions?.trim() ?? "";
	if (extraInstructions !== "") systemParts.push(extraInstructions);
	// --resume 历史重放：user/assistant 的文本轮按序进上下文（assistant 兼容
	// {text} 与 {content:[{type:"text",text}]} 双形态；tool 轮的配对重放归
	// BI-10.2 语法树语义，本面备案不重放——续聊文本场景成立）。
	const resumeHistory: AgentMessage[] = [];
	for (const entry of resumeEntries) {
		if (entry.type !== "user" && entry.type !== "assistant") continue;
		const payload = entry.payload as { text?: unknown; content?: unknown } | null;
		if (payload === null || typeof payload !== "object") continue;
		let text: string | undefined;
		if (typeof payload.text === "string") text = payload.text;
		else if (Array.isArray(payload.content)) {
			text = payload.content
				.filter(
					(block): block is { type: string; text: string } =>
						block !== null && typeof block === "object" &&
						(block as { type?: unknown }).type === "text" &&
						typeof (block as { text?: unknown }).text === "string",
				)
				.map((block) => block.text)
				.join("");
		}
		if (text === undefined || text.length === 0) continue;
		resumeHistory.push({ role: entry.type, content: text });
	}
	const messages: AgentMessage[] = [
		...(systemParts.length > 0 ? [{ role: "system" as const, content: systemParts.join("\n") }] : []),
		...resumeHistory,

		{ role: "user", content: options.prompt },
	];
	/**
	 * BI-05.3 date-change-sensor：每轮开始前检查注入时钟；跨 00:00 翻转时把披露提示
	 * 注入 system 面（每自然日至多一次，内部态天然去重）。缺省 ctxDate=false 时
	 * dateSensor 为 undefined，本函数立即返回（零开销零行为差；现状路径逐字节等价）。
	 */
	const discloseDateChange = (): void => {
		if (dateSensor === undefined) return;
		const { marker } = dateSensor.check(ctxNow());
		if (marker === null) return;
		const existing = messages.find((m) => m.role === "system");
		if (existing !== undefined) {
			const cur = typeof existing.content === "string" ? existing.content : "";
			existing.content = `${cur}\n${marker.note}`;
		} else {
			messages.unshift({ role: "system", content: marker.note });
		}
	};
	/**
	 * BI-05.3 window-manager（重·最小一件）：历史条目上限裁剪。max_history_entries>0
	 * 时每轮保留最近 N 条历史（头部 system 消息恒保留，避免系统指令/时钟块被裁掉）；
	 * 0/缺省 = 不裁（现状逐字节等价）。WindowManager 实例被真实喂入每轮估算 token 数
	 * 作遥测（snapshot 可查），但裁剪动作由条目数门禁驱动——其完整 token 水位紧缩
	 * 由 BI-10 AutoCompactor 承接（见下方 applyAutoCompact 接线）。
	 */
	const windowManager = ctxMaxHist > 0 ? new WindowManager() : undefined;
	/** prompt token 估算（字符/4，与 applyHistoryCap 既有口径一致；BI-10 缺位读数回退共用）。 */
	const estimatePromptTokens = (): number => {
		let estTokens = 0;
		for (const m of messages) {
			const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
			estTokens += Math.ceil(c.length / 4);
		}
		return estTokens;
	};
	const applyHistoryCap = (): void => {
		if (windowManager === undefined) return;
		// 估算 prompt token（字符/4）喂遥测；截断发生时记一击。
		windowManager.updateUsage(estimatePromptTokens(), Math.max(1, ctxMaxHist * 600));
		if (messages.length <= ctxMaxHist) return;
		const head = messages.filter((m) => m.role === "system");
		const tail = messages.slice(-ctxMaxHist);
		if (tail.some((m) => m.role === "system")) {
			messages.length = 0;
			messages.push(...tail);
		} else {
			messages.length = 0;
			messages.push(...head, ...tail);
		}
		windowManager.recordCompaction();
	};
	// ---- BI-08.2：image-offload 渐进卸载接线（每回合发送前跑一次；缺省关 = 零变动）----
	const applyImageOffload = (): void => {
		if (!ctxImageOffload) return;
		// 超限策略以器官自带参数为准（keepRecentN 缺省 0 = 全部可卸载）。器官就地
		// 变换且幂等：卸载槽位替换为文本块（非 image 块），二次调用自动跳过。
		offloadOldestImages(messages);
	};
	// ---- BI-10：AutoCompactor 80% 水位静默紧缩接线（缺省关 = 走既有条目数门禁裁剪）----
	/**
	 * summarizer 端口（BI-10）：用 runHeadless 已装配的 model 端口最小包装——
	 * 截断历史（Msg 视图渲染为文本）→ 单轮总结 prompt → 收集 content_delta 文本
	 * 返回摘要。失败（模型 error 事件 / 空响应 / 流抛错）直接抛出，交器官 catch
	 * （lastFailure 结构化留痕、返回 null、不炸会话、熔断器不计数）。
	 */
	const buildSummarizer = (port: ModelPort): Summarizer => {
		return async (msgs: Msg[]) => {
			const rendered = msgs
				.map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : safeStringify(m.content)}`)
				.join("\n");
			const prompt = [
				"Summarize the following conversation history for context preservation.",
				"Keep key decisions, file paths, open tasks, and unresolved questions. Respond with the summary only.",
				"",
				rendered,
			].join("\n");
			let text = "";
			for await (const event of port.stream({ messages: [{ role: "user", content: prompt }], tools: [] })) {
				if (event.type === "content_delta") text += event.delta;
				else if (event.type === "error") throw new Error(`${event.error.code}: ${event.error.message}`);
			}
			const trimmed = text.trim();
			if (trimmed === "") throw new Error("summarizer: 模型返回空摘要");
			return trimmed;
		};
	};
	/**
	 * AgentMessage[] → 轻量 Msg 视图（AutoCompactor / findSafeCut 消费形态）：
	 * tool_use / tool_result 块逐块拆为带 toolCallId 的 Msg（配对计数正确性），
	 * 其余块映射为同角色 Msg；每个 Msg 经 sourceOf 回指原 AgentMessage，写回时
	 * 原引用保留（会话事件序与 JSONL 落盘形态不被紧缩重排破坏）。
	 */
	const buildMsgView = (
		msgs: readonly AgentMessage[],
	): { view: Msg[]; sourceOf: Map<Msg, AgentMessage> } => {
		const view: Msg[] = [];
		const sourceOf = new Map<Msg, AgentMessage>();
		for (const m of msgs) {
			if (typeof m.content === "string") {
				const v: Msg = { role: m.role, content: m.content };
				view.push(v);
				sourceOf.set(v, m);
				continue;
			}
			let sawBlock = false;
			for (const block of m.content) {
				sawBlock = true;
				const v: Msg =
					block.type === "tool_use"
						? { role: "assistant", toolCallId: block.id, toolName: block.name, content: block }
						: block.type === "tool_result"
							? { role: "tool", toolCallId: block.toolUseId, content: block.content }
							: { role: m.role, content: block };
				view.push(v);
				sourceOf.set(v, m);
			}
			if (!sawBlock) {
				const v: Msg = { role: m.role, content: [] };
				view.push(v);
				sourceOf.set(v, m);
			}
		}
		return { view, sourceOf };
	};
	/**
	 * 紧缩序列写回：来源 Msg 还原为原 AgentMessage 引用（同源多 Msg 连续去重，
	 * 多 tool_use 拆分形态）；唯一非来源 Msg 是 [compacted] 摘要占位（user 形态），
	 * 直接构造。边界语义：安全切点若落在同源 text/tool_use Msg 之间，保留侧还原
	 * 整条原消息（文本块已随 older 段进入摘要，保留侧出现属良性重复，API 序仍合法）。
	 */
	const writeBackCompacted = (compacted: readonly Msg[], sourceOf: Map<Msg, AgentMessage>): AgentMessage[] => {
		const out: AgentMessage[] = [];
		let lastSource: AgentMessage | undefined;
		for (const m of compacted) {
			const src = sourceOf.get(m);
			if (src !== undefined) {
				if (src === lastSource) continue;
				out.push(src);
				lastSource = src;
			} else {
				out.push({ role: "user", content: typeof m.content === "string" ? m.content : safeStringify(m.content) });
				lastSource = undefined;
			}
		}
		return out;
	};
	const compactorWindow = ctxAutoCompact ? new WindowManager() : undefined;
	const autoCompactor = ctxAutoCompact && compactorWindow !== undefined
		? new AutoCompactor({ summarizer: buildSummarizer(options.model), window: compactorWindow })
		: undefined;
	const applyAutoCompact = async (): Promise<void> => {
		if (autoCompactor === undefined || compactorWindow === undefined) return;
		// 用量读数：真实 usage 事件（inputTokens）优先，缺位回退字符/4 估算（与
		// applyHistoryCap 同口径）；视窗分母为装配面注入值（缺省 128_000）。
		compactorWindow.updateUsage(lastUsageInputTokens ?? estimatePromptTokens(), ctxCompactWindowTokens);
		const { view, sourceOf } = buildMsgView(messages);
		let result: Awaited<ReturnType<AutoCompactor["maybeCompact"]>> = null;
		try {
			result = await autoCompactor.maybeCompact(view);
		} catch (err) {
			// 熔断告警（连续 3 击水位仍超）：静默降级为不紧缩——不炸会话，紧缩面
			// 自行停摆，其余管线照常。
			if (err instanceof CompactionCircuitOpenError) return;
			throw err;
		}
		if (result === null) return;
		const next = writeBackCompacted(result.messages, sourceOf);
		messages.length = 0;
		messages.push(...next);
	};
	const maxRounds = options.maxRounds ?? 16;
	let finalText = "";
	let rounds = 0;

	let parentId: string | undefined;
	const rootEntry = await manager.append(sessionId, resumeTailId, { type: "user", payload: { text: options.prompt } as unknown as JsonValue });
	parentId = rootEntry.id;

	const appendChained = async (input: AppendEntryInput): Promise<SessionEntry> => {
		const entry = await manager.append(sessionId, parentId ?? null, input);
		parentId = entry.id;
		return entry;
	};

	// 本回合状态（每回合重置；提为外层变量以便回合体抽成函数供时限竞速消费）。
	let text = "";
	let blocks: ContentBlock[] = [];
	let assembler = new ToolCallAssembler();
	let stop: StopReason = null;
	/** 本轮用量读数（同轮多次上报取最大值，轮末并入会话级汇总）。 */
	let roundUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };

	/**
	 * 本回合主体：模型流 → 工具批 → tool_result 回填。
	 *
	 * 抽成函数是为了让 [loop_control] turn_timeout_ms 的时限看门狗能对**整回合**竞速
	 * （到点 abort 模型流 + abort 在飞工具批次 → 以 TurnTimeoutSignal 打断本回合）。
	 * 返回 "done" = 本回合收束（成功面已落终局输出）；"tools" = 工具回合已回填（继续下一回合）。
	 */
	const runTurnBody = async (
		signal: AbortSignal | undefined,
	): Promise<{ kind: "done" } | { kind: "tools" }> => {
		// 状态机契约：beginTurn 只走 idle→thinking；工具回合落定后已在 thinking，
		// 直接进入下一轮 executeTools（thinking→tool-executing）。
		if (agentLoop.state === "idle") agentLoop.beginTurn();
		// BI-05.3：每轮开始前先跑上下文面各项注入（缺省关 → 零开销零行为差）。
		discloseDateChange(); // 跨日翻转披露
		applyImageOffload(); // BI-08.2 渐进图像卸载（缺省关 = 零变动）
		await applyAutoCompact(); // BI-10 AutoCompactor 水位紧缩（缺省关 = 走既有条目数门禁）
		applyHistoryCap(); // window-manager 历史条目上限裁剪

		for await (const event of options.model.stream({
			messages,
			tools: tools.map((t) => t.definition),
			...(signal !== undefined ? { signal } : {}),
		})) {
			if (event.type === "content_delta") {
				text += event.delta;
			} else if (event.type === "tool_call_delta") {
				assembler.push(event);
			} else if (event.type === "done") {
				stop = event.stopReason;
			} else if (event.type === "error") {
				throw failSession("adapter-error", `${event.error.code}: ${event.error.message}`);
			} else if (event.type === "usage") {
				// BI-10：真实用量读数留痕（紧缩水位判定优先消费，估算仅兜底）。
				if (typeof event.usage.inputTokens === "number") lastUsageInputTokens = event.usage.inputTokens;
				// json 输出面：本轮用量取最大值（同轮多次上报不重复计数）。
				if (typeof event.usage.inputTokens === "number") {
					roundUsage.inputTokens = Math.max(roundUsage.inputTokens, event.usage.inputTokens);
				}
				if (typeof event.usage.outputTokens === "number") {
					roundUsage.outputTokens = Math.max(roundUsage.outputTokens, event.usage.outputTokens);
				}
				if (typeof event.usage.cachedInputTokens === "number") {
					roundUsage.cachedInputTokens = Math.max(roundUsage.cachedInputTokens, event.usage.cachedInputTokens);
				}
				if (typeof event.usage.reasoningTokens === "number") {
					roundUsage.reasoningTokens = Math.max(roundUsage.reasoningTokens, event.usage.reasoningTokens);
				}
			}
			emit(event);
		}

		// 轮末并入会话级用量汇总（json 输出面）。
		usageTotals.inputTokens += roundUsage.inputTokens;
		usageTotals.outputTokens += roundUsage.outputTokens;
		usageTotals.cachedInputTokens += roundUsage.cachedInputTokens;
		usageTotals.reasoningTokens += roundUsage.reasoningTokens;

		if (stop === "stop" || stop === null) {
			if (text !== "") {
				const textBlock: TextBlock = { type: "text", text };
				blocks.push(textBlock);
			}
			finalText = text;
			messages.push({ role: "assistant", content: blocks });
			await appendChained({ type: "assistant", payload: { content: blocks } as unknown as JsonValue });
			agentLoop.finishTurn();

			// ---- 装配序 ⑤·a：会话收尾记忆沉淀（BI-05.1；仅 memory.dream 显式装配时生效）----
			// 空闲阈值判定用器官既有常量 DEFAULT_DREAM_IDLE_MS（缺省恰好到阈值 → 收尾即沉淀）；
			// 锁文件防并发由 consolidate 内部 acquireDreamLock 保证（他人持锁未过期 → 静默跳过）。
			if (options.memory?.dream !== undefined) {
				const dream = options.memory.dream;
				const dreamFs = dream.fs ?? nodeFs;
				const dreamDir = dream.dir ?? options.cwd;
				const dreamNow = dream.now !== undefined ? dream.now() : Date.now();
				const idleMs = dream.idleMs ?? DEFAULT_DREAM_IDLE_MS;
				if (idleMs >= DEFAULT_DREAM_IDLE_MS) {
					const extractor = dream.extractor;
					consolidate([finalText], {
						dir: dreamDir,
						fs: dreamFs,
						now: dreamNow,
						...(extractor !== undefined ? { extractor } : {}),
					});
				}
			}

			// ---- 装配序 ⑤：完工自验（BI-21.1；仅装配层显式提供 verify 时生效）----
			if (options.verify !== undefined) {
				const runner = options.verify.runner ?? DEFAULT_SHELL_RUNNER;
				const verifier = new TargetVerifier();
				const verification = await verifier.verify(options.verify.contract, options.cwd, { runner });
				if (!verification.passed) {
					// 不假冒成功：结构化差距报告（stream-json 上线 + 错误消息携带
					// formatGaps + verification 回执），非零退出码由装配方转换。
					if (outputFormat === "stream-json") {
						// gap 的 actual 可能带命令 stderr（凭据回显）——sanitizeErrors
						// 开启时该输出面同样先过脱敏器（进程内 verification 保持原样）。
						const gaps = options.sanitizeErrors === true
							? verification.gaps.map((g) => ({
									checkId: g.checkId,
									expected: sanitizeErrorPayload(g.expected),
									actual: sanitizeErrorPayload(g.actual),
								}))
							: verification.gaps;
						emit({ type: "session_done", sessionId, exit: "verify-failed", rounds, gaps });
					}
					throw failSession(
						"verify-failed",
						`收尾自验未通过:\n${verifier.formatGaps(verification)}`,
						verification,
					);
				}
				verificationResult = verification;
			}

			if (outputFormat === "text") {
				// text 形态：meta（session_done 等）不落 out，只落最终文本一段。
				out(finalText);
			} else if (outputFormat === "json") {
				// json 形态（F-ST-02）：全程不落事件流，结束时 stdout 只落这一个
				// JSON 对象（字段对齐 session_done 汇总：sessionId/title/rounds/
				// usage/reply=最终 finalText/exit）。失败路径不走到这里——stdout
				// 绝不输出残缺 JSON，诊断由装配方经 err 报出；唯一例外是
				// rounds-exceeded（回合打尽）：该失败面落一个完整对象（exit=
				// "rounds-exceeded"，reply 空串），其余失败仍不落 stdout。
				out(
					JSON.stringify({
						sessionId,
						title: sessionTitle,
						rounds,
						usage: usagePayload(),
						reply: finalText,
						exit: "ok",
					}),
				);
			} else {
				emit({ type: "session_done", sessionId, exit: "ok", rounds, finalText });
			}
			return { kind: "done" };
		}

		if (stop !== "tool_use") {
			agentLoop.finishTurn();
			throw failSession("adapter-error", `不可继续的停止原因: ${String(stop)}`);
		}

		// tool_use 回合：assistant(含 tool_use 块) → 逐调用流水线 → tool_result 回填
		const calls = assembler.drain();
		const useBlocks: ToolUseBlock[] = calls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.args }));
		messages.push({ role: "assistant", content: [...blocks, ...useBlocks] });
		await appendChained({ type: "assistant", payload: { content: [...blocks, ...useBlocks] } as unknown as JsonValue });

		const results = await agentLoop.executeTools(calls);
		toolResults.push(...results);

		const resultBlocks: ToolResultBlock[] = [];
		for (const call of calls) {
			const result = results.find((r) => r.id === call.id);
			const block: ToolResultBlock = {
				type: "tool_result",
				toolUseId: call.id,
				content: result === undefined ? "lost-result" : result.ok ? safeStringify(result.value) : `error: ${result.error ?? "unknown"}`,
				isError: result === undefined || !result.ok,
			};
			resultBlocks.push(block);
			await appendChained(
				{ type: "tool_call", payload: { name: call.name, args: call.args } as unknown as JsonValue, toolCallId: call.id, toolName: call.name },
			);
			await appendChained(
				{
					type: "tool_result",
					payload: (result === undefined ? { ok: false } : { ok: result.ok, ...(result.ok ? { value: result.value } : { error: result.error }) }) as unknown as JsonValue,
					toolCallId: call.id,
					toolName: call.name,
				},
			);
		}
		messages.push({ role: "user", content: resultBlocks });
		return { kind: "tools" };
	};

	/**
	 * [loop_control] turn_timeout_ms 超时的结构化失败面（对齐 F-EV-01 rounds-exceeded 先例）：
	 * - stream-json：落 session_done 帧（exit="turn-timeout"），自动化消费者据此收尾；
	 * - json：落完整 JSON 对象（字段对齐成功形态，reply 空串），stdout 仍是单对象可 parse；
	 * - text：不落 stdout（诊断经 stderr 报出，与既有失败路径同形）。
	 * 终局输出先落，再抛结构化失败（退出码由装配方转非零）。
	 */
	const failTurnTimeout = (): never => {
		if (outputFormat === "stream-json") {
			emit({ type: "session_done", sessionId, exit: "turn-timeout", rounds });
		} else if (outputFormat === "json") {
			out(
				JSON.stringify({
					sessionId,
					title: sessionTitle,
					rounds,
					usage: usagePayload(),
					reply: "",
					exit: "turn-timeout",
				}),
			);
		}
		errOut(
			`bi: [loop_control] turn-timeout: 单回合超过时限 ${turnTimeoutMs}ms（config [loop_control] turn_timeout_ms）`,
		);
		throw failSession(
			"turn-timeout",
			`单回合超过时限 ${turnTimeoutMs}ms（config [loop_control] turn_timeout_ms；可用 [loop_control] turn_timeout_ms 调高）`,
		);
	};

	while (rounds < maxRounds) {
		rounds += 1;
		// 本回合状态重置（每回合独立；与回合体共享同一组外层变量）。
		text = "";
		blocks = [];
		assembler = new ToolCallAssembler();
		stop = null;
		roundUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };
		// [loop_control] turn_timeout_ms：本回合时限看门狗（缺省不限时 = 空转，无定时器）。
		const turnWatch = startTurnWatchdog();
		try {
			const outcome = await turnWatch.race(runTurnBody(turnWatch.signal));
			if (outcome.kind === "done") {
				return {
					exitCode: 0,
					sessionId,
					finalText,
					rounds,
					toolResults,
					hookRecords,
					permissionDecisions,
					additionalDirs: options.additionalDirs ?? [],
					...(verificationResult !== undefined ? { verification: verificationResult } : {}),
				};
			}
		} catch (cause) {
			// 超时 → 结构化失败面（对齐 F-EV-01 rounds-exceeded 先例）；其余错误原样抛。
			if (cause instanceof TurnTimeoutSignal) failTurnTimeout();
			throw cause;
		} finally {
			turnWatch.dispose();
		}
	}

	// F-EV-01：回合打尽 = 结构化失败面——先落终局输出，再照旧抛错（退出码仍非零）。
	// - stream-json：落 session_done 帧（exit="rounds-exceeded"），自动化消费者据此收尾；
	// - json：落完整 JSON 对象（字段对齐成功形态，reply 空串），stdout 仍是单对象可 parse；
	// - text：不落 stdout（诊断经装配方 err 报出，与既有失败路径同形）。
	if (outputFormat === "stream-json") {
		emit({ type: "session_done", sessionId, exit: "rounds-exceeded", rounds });
	} else if (outputFormat === "json") {
		out(
			JSON.stringify({
				sessionId,
				title: sessionTitle,
				rounds,
				usage: usagePayload(),
				reply: "",
				exit: "rounds-exceeded",
			}),
		);
	}
	throw failSession(
		"rounds-exceeded",
		`模型回合超过上限 ${maxRounds}（已用 ${rounds} 回合；可用 --max-rounds 或 config [session] max_rounds 调高）`,
	);
}

function safeStringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}
