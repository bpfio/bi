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
import { boundToolText } from "../context/bounded-tool-text";
import { buildTimeContext, DEFAULT_TIMEZONE } from "../context/time-context";
import { DateChangeSensor } from "../context/date-change-sensor";
import { pruneToolResult } from "../context/tool-result-pruner";
import { WindowManager } from "../context/window-manager";
import { sanitizeErrorPayload } from "../observability/endpoint-sanitizer";
import {
	DEFAULT_SHELL_RUNNER,
	TargetVerifier,
	type CommandRunner,
	type TargetContract,
	type VerificationResult,
} from "../verifier/target-verifier";
import type { VerifySection } from "../config/schema";
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
	 * session_done（现状行为，契约不变）；"text" = 仅落最终 finalText 一段。
	 */
	readonly outputFormat?: OutputFormat;
	/** 模型回合上限（防失控，缺省 8）。 */
	readonly maxRounds?: number;
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
	 * 缺省 / ≤0 = 不截断（与现状逐字节等价）；>0 时工具**成功输出**超限经
	 * boundToolText 两级预算截断，替换为带结构化标记行的有界文本；未超限不截。
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
	readonly code: "hook-blocked" | "adapter-error" | "rounds-exceeded" | "verify-failed";
	/** verify-failed 时的结构化自验结果（含 gaps；其余 code 缺省）。 */
	readonly verification?: VerificationResult;
	constructor(
		code: "hook-blocked" | "adapter-error" | "rounds-exceeded" | "verify-failed",
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
	const outputFormat: OutputFormat = options.outputFormat ?? "stream-json";
	// text 形态：输出面收敛——事件仍内部流转（缓冲/回喂不变），仅不落 out；
	// 最终只落 finalText 一段（见下方终局分支）。stream-json 保持逐行透传。
	const emit = (event: unknown): void => {
		if (outputFormat === "stream-json") out(JSON.stringify(event));
	};
	// BI-08.1：输出上限（码点）；缺省 / ≤0 = 关闭（现状路径逐字节等价）。
	const outputLimitBytes = options.outputLimitBytes ?? 0;
	// BI-05.3（W3-D7）：上下文引擎开关解析（全部缺省关；context 未提供 = 恒关）。
	const ctx = options.context ?? {};
	const ctxTime = ctx.timeContext === true;
	const ctxDate = ctx.dateChangeSensor === true;
	const ctxPrune = ctx.toolResultPrune === true;
	const ctxMaxHist = ctx.maxHistoryEntries ?? 0;
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
	const manager = new SessionManager(options.sessionsRoot !== undefined ? { rootDir: options.sessionsRoot } : {});
	const session = await manager.createSession({
		...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
		title: options.prompt.slice(0, 80),
		cwd: options.cwd,
	});
	const sessionId = session.sessionId;

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
	});

	// ---- 装配序 ④：模型对话驱动器 ----
	// BI-20.2b：--agent-file 内容作为系统指令前置（系统消息面；无则单条 user）。
	// BI-05.3（W3-D7）：time-context 当前时钟块作为 system 面追加（缺省 ctxTime=false
	// 不追加，逐字节等价）；date-change-sensor 基线在首轮 discloseDateChange 建立。
	const systemParts: string[] = [];
	if (options.systemInstruction !== undefined) systemParts.push(options.systemInstruction);
	if (ctxTime) {
		systemParts.push(buildTimeContext({ isoNow: new Date(ctxNow()).toISOString(), timezone: ctxTz }));
	}
	const messages: AgentMessage[] = [
		...(systemParts.length > 0 ? [{ role: "system" as const, content: systemParts.join("\n") }] : []),
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
	 * 需配合 AutoCompactor（本批归档，不接）。
	 */
	const windowManager = ctxMaxHist > 0 ? new WindowManager() : undefined;
	const applyHistoryCap = (): void => {
		if (windowManager === undefined) return;
		// 估算 prompt token（字符/4）喂遥测；截断发生时记一击。
		let estTokens = 0;
		for (const m of messages) {
			const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
			estTokens += Math.ceil(c.length / 4);
		}
		windowManager.updateUsage(estTokens, Math.max(1, ctxMaxHist * 600));
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
	const maxRounds = options.maxRounds ?? 8;
	let finalText = "";
	let rounds = 0;

	let parentId: string | undefined;
	const rootEntry = await manager.append(sessionId, null, { type: "user", payload: { text: options.prompt } as unknown as JsonValue });
	parentId = rootEntry.id;

	const appendChained = async (input: AppendEntryInput): Promise<SessionEntry> => {
		const entry = await manager.append(sessionId, parentId ?? null, input);
		parentId = entry.id;
		return entry;
	};

	while (rounds < maxRounds) {
		rounds += 1;
		// 状态机契约：beginTurn 只走 idle→thinking；工具回合落定后已在 thinking，
		// 直接进入下一轮 executeTools（thinking→tool-executing）。
		if (agentLoop.state === "idle") agentLoop.beginTurn();
		// BI-05.3：每轮开始前先跑上下文面两项注入（缺省关 → 零开销零行为差）。
		discloseDateChange(); // 跨日翻转披露
		applyHistoryCap(); // window-manager 历史条目上限裁剪
		let text = "";
		const blocks: ContentBlock[] = [];
		const assembler = new ToolCallAssembler();
		let stop: StopReason = null;

		for await (const event of options.model.stream({ messages, tools: tools.map((t) => t.definition) })) {
			if (event.type === "content_delta") {
				text += event.delta;
			} else if (event.type === "tool_call_delta") {
				assembler.push(event);
			} else if (event.type === "done") {
				stop = event.stopReason;
			} else if (event.type === "error") {
				throw failSession("adapter-error", `${event.error.code}: ${event.error.message}`);
			}
			emit(event);
		}

		if (stop === "stop" || stop === null) {
			if (text !== "") {
				const textBlock: TextBlock = { type: "text", text };
				blocks.push(textBlock);
			}
			finalText = text;
			messages.push({ role: "assistant", content: blocks });
			await appendChained({ type: "assistant", payload: { content: blocks } as unknown as JsonValue });
			agentLoop.finishTurn();

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
			} else {
				emit({ type: "session_done", sessionId, exit: "ok", rounds, finalText });
			}
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
	}

	throw failSession("rounds-exceeded", `模型回合超过上限 ${maxRounds}`);
}

function safeStringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}
