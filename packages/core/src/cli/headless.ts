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
 * stream-json 输出合约：逐行透传 StreamEvent（BI-04.2 七类事件原样 JSON），
 * 末行追加会话级 { type:"session_done", ... } 汇总。
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
import { HookRunner, type HookSpawnImpl } from "../hooks/hook-runner";
import type { HookRunRecord } from "../hooks/types";
import { loadHooksConfig } from "../config/hooks-adapter";
import type { HooksSection } from "../config/schema";
import { scanShell } from "../sandbox/shell-scan";
import { SessionManager } from "../session/manager";
import type { AppendEntryInput, JsonValue, SessionEntry } from "../session/types";

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
	/** 会话存储根（缺省 SessionManager 默认根）。 */
	readonly sessionsRoot?: string;
	readonly sessionId?: string;
	/** 信任门（骨架缺省恒 trusted）。 */
	readonly trust?: (root: string) => WorkspaceTrustState;
	/** spawn 替身（钩子测试注入；缺省真实子进程）。 */
	readonly hookSpawn?: HookSpawnImpl;
	/** 输出汇（缺省 process.stdout 逐行；测试注入收集）。 */
	readonly out?: (line: string) => void;
	/** 模型回合上限（防失控，缺省 8）。 */
	readonly maxRounds?: number;
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
}

/** 工具调用增量按 index 拼装缓冲。 */
class ToolCallAssembler {
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
	readonly code: "hook-blocked" | "adapter-error" | "rounds-exceeded";
	constructor(code: "hook-blocked" | "adapter-error" | "rounds-exceeded", message: string) {
		super(message);
		this.name = "HeadlessError";
		this.code = code;
	}
}

/**
 * 无头走骨架主流程：一条带真实工具调用、权限门、钩子触发与 JSONL 落盘的会话。
 */
export async function runHeadless(options: HeadlessOptions): Promise<HeadlessResult> {
	const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
	const emit = (event: unknown): void => out(JSON.stringify(event));
	const toolResults: ToolResult[] = [];
	const hookRecords: HookRunRecord[] = [];
	const permissionDecisions: Array<{ tool: string; decision: string }> = [];

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
		throw new HeadlessError("hook-blocked", `SessionStart 钩子阻断会话: ${startOutcome.reason ?? "no reason"}`);
	}

	// ---- 装配序 ③：权限门（BI-06.5）与工具注册表 ----
	const gate = new PermissionGate({ mode: options.permissionMode ?? "auto" });
	const registry = new Map<string, ToolBinding>();
	for (const binding of options.tools) registry.set(binding.definition.name, binding);
	const readOnlyTools = new Set(options.tools.filter((t) => t.readOnly).map((t) => t.definition.name));

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

		const post = await hookRunner.run("PostToolUse", { ...hookInput("PostToolUse", call.name, call.args), sessionId, cwd: options.cwd });
		hookRecords.push(...post.records); // PostToolUse block 仅记录（执行已完成），不阻断
		return value;
	};

	const agentLoop = new AgentLoop({
		execute: assembledExecutor,
		readOnlyTools,
	});

	// ---- 装配序 ④：模型对话驱动器 ----
	const messages: AgentMessage[] = [{ role: "user", content: options.prompt }];
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
		let text = "";
		const blocks: ContentBlock[] = [];
		const assembler = new ToolCallAssembler();
		let stop: StopReason = null;

		for await (const event of options.model.stream({ messages, tools: options.tools.map((t) => t.definition) })) {
			if (event.type === "content_delta") {
				text += event.delta;
			} else if (event.type === "tool_call_delta") {
				assembler.push(event);
			} else if (event.type === "done") {
				stop = event.stopReason;
			} else if (event.type === "error") {
				throw new HeadlessError("adapter-error", `${event.error.code}: ${event.error.message}`);
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
			emit({ type: "session_done", sessionId, exit: "ok", rounds, finalText });
			return {
				exitCode: 0,
				sessionId,
				finalText,
				rounds,
				toolResults,
				hookRecords,
				permissionDecisions,
			};
		}

		if (stop !== "tool_use") {
			agentLoop.finishTurn();
			throw new HeadlessError("adapter-error", `不可继续的停止原因: ${String(stop)}`);
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

	throw new HeadlessError("rounds-exceeded", `模型回合超过上限 ${maxRounds}`);
}

function safeStringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}
