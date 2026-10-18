/**
 * BI-23.2 —— TUI 挂载与事件流：把 BI-23.1 的对话驱动器挂上 BI-19/20 渲染器官。
 *
 * 挂载面（kimi 装配序 tui 段；器官全量复用、不改动）：
 * - **双缓冲投影**：TranscriptProjection（BI-19.1 同构 L1→L3）承载会话视图，
 *   TuiApp/DiffRenderer（begin/end 差分帧）负责双缓冲提交；onFrame 钩子回吐
 *   每帧可见行集（注入渲染面断言点）。
 * - **审批 ask 回路**：manual 模式下 PermissionGate 'ask' 决策 → 栈顶审批浮层
 *   （y=允许 / n=拒绝 / Esc=拒绝），回答经 Promise 回喂装配执行体；deny 以
 *   结构化 permission-denied 回喂模型（与无头降级同一回喂语义，不再假冒）。
 * - **Esc 二段取消**：turn 进行中第一段 Esc → AgentLoop.cancelRequest() 等
 *   在飞工具落定转 paused（thinking→paused，BI-07 迁移表），驱动器同步 abort
 *   模型流并优雅收束本回合；cancelWindowMs 窗口内第二段 → exit 终态。paused
 *   会话的下次 submit() 经 resume()（paused→thinking）续转。idle 态 Esc 不消费。
 * - 输入面：本卡以 submit() 挂事件流；行编辑器 REPL 接线（editor 器官挂载）
 *   归后续装配卡。钩子 runner 暂为无头路径专属（挂载卡交付面=投影/审批/取消）。
 */

import {
	AgentLoop,
	type ToolCall,
	type ToolExecutor,
	type ToolResult,
} from "../../../core/src/agent";
import { ToolCallAssembler, type ModelPort, type ToolBinding } from "../../../core/src/cli/headless";
import { PermissionGate } from "../../../core/src/guard/permission-gate";
import type { Clock } from "../../../core/src/guard/deadline";
import type { PermissionRequest } from "../../../core/src/guard/types";
import { SessionManager } from "../../../core/src/session/manager";
import type { AppendEntryInput, JsonValue } from "../../../core/src/session/types";
import {
	type AgentMessage,
	type ContentBlock,
	type StopReason,
	type TextBlock,
	type ToolResultBlock,
	type ToolUseBlock,
} from "../../../core/src/adapters/deepseek-adapter";

import { TuiApp, type Component } from "../components/tui-app";
import type { ParsedKey, Writer } from "../engine/diff-renderer";
import { VirtualTerminal } from "../engine/virtual-terminal";
import { TranscriptProjection, type TranscriptKind } from "../transcript-projection";

/** TUI 会话级错误（结构化面，调用方据此上报）。 */
export class TuiSessionError extends Error {
	readonly code: "adapter-error" | "rounds-exceeded" | "not-started" | "session-exited";
	constructor(code: TuiSessionError["code"], message: string) {
		super(message);
		this.name = "TuiSessionError";
		this.code = code;
	}
}

/** 渲染面探针：每帧提交后回吐（验收断言点）。 */
export interface TuiSessionHooks {
	/** 每次双缓冲帧提交后的可见行集（投影 L3 尾窗 + 状态行）。 */
	readonly onFrame?: (frame: readonly string[], info: FrameInfo) => void;
}

export interface FrameInfo {
	/** 审批浮层是否在栈顶可见。 */
	readonly approvalVisible: boolean;
	/** 驱动器状态。 */
	readonly state: TuiSessionState;
}

export type TuiSessionState = "idle" | "running" | "awaiting-approval" | "exited";

export interface TuiSessionOptions {
	readonly model: ModelPort;
	readonly tools: readonly ToolBinding[];
	readonly cwd: string;
	readonly sessionsRoot?: string;
	/** 权限门初始模式；TUI 挂载的 ask 回路只有 manual 模式可达。 */
	readonly permissionMode?: "manual" | "auto" | "yolo";
	readonly maxRounds?: number;
	/** Esc 二段取消窗口毫秒（透传 BI-07 AgentLoop；缺省 800）。 */
	readonly cancelWindowMs?: number;
	/** 渲染面尺寸（缺省 24x80）。 */
	readonly rows?: number;
	readonly cols?: number;
	readonly clock?: Clock;
	readonly hooks?: TuiSessionHooks;
}

export interface TuiSessionResult {
	readonly sessionId: string;
	readonly finalText: string;
	readonly rounds: number;
	readonly toolResults: readonly ToolResult[];
	readonly permissionDecisions: ReadonlyArray<{ tool: string; decision: string }>;
	/** finish=自然收尾；cancelled=Esc 一段暂停收束；exit=Esc 二段退出。 */
	readonly endedAs: "finish" | "cancelled" | "exit";
}

/** 审批浮层：y=允许 / n=拒绝 / Esc=拒绝；栈顶拦截按键直至回答。 */
class ApprovalOverlay implements Component {
	#resolve: ((answer: "allow" | "deny") => void) | undefined;

	constructor(
		private readonly toolName: string,
		private readonly argSummary: string,
		private readonly onChange: () => void,
	) {}

	get active(): boolean {
		return this.#resolve !== undefined;
	}

	/** 等待用户回答（handleKey 解析后 resolve）。 */
	wait(): Promise<"allow" | "deny"> {
		return new Promise((resolve) => {
			this.#resolve = resolve;
		});
	}

	/** 浮层行集（render 与帧探针共用的单一来源）。 */
	lines(): string[] {
		return [
			"┌─ 权限审批 ─────────────────────────────┐",
			`│ 工具: ${this.toolName} ${this.argSummary}`,
			"│ [y] 允许   [n] 拒绝   [Esc] 拒绝",
			"└────────────────────────────────────────┘",
		];
	}

	render(term: VirtualTerminal): void {
		this.lines().forEach((line, i) => term.write(0, i, line));
	}

	handleKey(key: ParsedKey): void {
		let answer: "allow" | "deny" | undefined;
		if (key.kind === "char" && key.char === "y") answer = "allow";
		else if (key.kind === "char" && key.char === "n") answer = "deny";
		else if (key.kind === "esc") answer = "deny";
		if (answer !== undefined) {
			const resolve = this.#resolve;
			this.#resolve = undefined;
			this.onChange();
			resolve?.(answer);
		}
	}
}

/** 会话视图组件：投影 L3 行集 + 状态行；不消费按键（放行浮层）。 */
class TranscriptView implements Component {
	constructor(
		private readonly session: AgentTuiSession,
		private readonly rows: number,
	) {}

	render(term: VirtualTerminal): void {
		const lines = this.session.projection.render();
		const viewRows = Math.max(1, this.rows - 1);
		const visible = lines.slice(-viewRows);
		for (let i = 0; i < visible.length; i++) term.write(0, i, visible[i]!);
		term.write(0, this.rows - 1, this.session.statusText());
	}

	wantsKey(_key: ParsedKey): boolean {
		return false;
	}
}

/** TUI 挂载会话：submit() 驱动的交互式对话流（投影渲染 + 审批回路 + Esc 二段取消）。 */
export class AgentTuiSession {
	readonly projection: TranscriptProjection;
	readonly app: TuiApp;
	readonly #model: ModelPort;
	readonly #rows: number;
	readonly #cols: number;
	readonly #hooks: TuiSessionHooks;
	readonly #gate: PermissionGate;
	readonly #registry = new Map<string, ToolBinding>();
	readonly #agentLoop: AgentLoop;
	readonly #manager: SessionManager;
	readonly #toolResults: ToolResult[] = [];
	readonly #permissionDecisions: Array<{ tool: string; decision: string }> = [];
	readonly #maxRounds: number;
	#sessionId: string | undefined;
	#messages: AgentMessage[] = [];
	#turnController: AbortController | undefined;
	#turnCancelled = false;
	#exitRequested = false;
	#state: TuiSessionState = "idle";
	#rounds = 0;
	#activeOverlay: ApprovalOverlay | undefined;

	constructor(options: TuiSessionOptions) {
		this.#rows = options.rows ?? 24;
		this.#cols = options.cols ?? 80;
		this.#hooks = options.hooks ?? {};
		this.#maxRounds = options.maxRounds ?? 8;
		this.#model = options.model;
		this.projection = new TranscriptProjection({ width: this.#cols });
		const writer: Writer = { write: () => undefined }; // 帧字节面：测试注入 hooks.onFrame 断言行集
		this.app = new TuiApp(writer, this.#rows, this.#cols);
		this.app.push(new TranscriptView(this, this.#rows));
		this.#gate = new PermissionGate({ mode: options.permissionMode ?? "manual" });
		for (const binding of options.tools) this.#registry.set(binding.definition.name, binding);
		const readOnlyTools = new Set(options.tools.filter((t) => t.readOnly).map((t) => t.definition.name));
		this.#manager = new SessionManager(options.sessionsRoot !== undefined ? { rootDir: options.sessionsRoot } : {});
		const executor: ToolExecutor = async (call: ToolCall, signal: AbortSignal): Promise<unknown> =>
			this.#execute(call, signal);
		this.#agentLoop = new AgentLoop({
			execute: executor,
			readOnlyTools,
			...(options.cancelWindowMs !== undefined ? { cancelWindowMs: options.cancelWindowMs } : {}),
			...(options.clock !== undefined ? { clock: options.clock } : {}),
		});
	}

	/** 会话初始化（JSONL 落盘根条目）；submit 前必须调用。 */
	async start(title: string): Promise<string> {
		const session = await this.#manager.createSession({ title: title.slice(0, 80), cwd: "" });
		this.#sessionId = session.sessionId;
		return session.sessionId;
	}

	get sessionId(): string | undefined {
		return this.#sessionId;
	}

	get state(): TuiSessionState {
		return this.#state;
	}

	/** AgentLoop 内态诊断面（thinking/paused/exit/...；测试与状态条用）。 */
	get agentState(): string {
		return this.#agentLoop.state;
	}

	statusText(): string {
		const mode = this.#gate.mode;
		switch (this.#state) {
			case "running":
				return `[${mode}] 运行中 — Esc 取消（双击退出）`;
			case "awaiting-approval":
				return `[${mode}] 等待审批 — y 允许 / n 拒绝`;
			case "exited":
				return "[已退出]";
			default:
				return `[${mode}] 就绪`;
		}
	}

	// ------------------------------------------------------------------
	// 渲染与键位
	// ------------------------------------------------------------------

	#frame(): void {
		this.app.render();
		const lines = this.projection.render();
		const viewRows = Math.max(1, this.#rows - 1);
		const overlay = this.#activeOverlay?.lines() ?? [];
		const frame = [...overlay, ...lines.slice(-(viewRows - overlay.length)), this.statusText()];
		this.#hooks.onFrame?.(frame, { approvalVisible: this.#state === "awaiting-approval", state: this.#state });
	}

	#transcribe(kind: TranscriptKind, text: string): void {
		this.projection.append({ kind, text });
	}

	/**
	 * Esc 键位（宿主键派发调用点）：运行中=二段取消语义；审批浮层/Esc 由浮层
	 * 经 TuiApp.dispatchKey 自行消费；idle 不消费。
	 */
	async handleKey(key: ParsedKey): Promise<void> {
		if (key.kind !== "esc" || this.#state !== "running") return;
		const outcome = await this.#agentLoop.cancelRequest();
		if (outcome.action === "exit") {
			this.#exitRequested = true;
			this.#turnController?.abort();
			this.#state = "exited";
		} else if (outcome.action === "paused") {
			// thinking→paused（BI-07）：abort 模型流，本回合经流 error 分支优雅收束。
			this.#turnCancelled = true;
			this.#turnController?.abort();
		} else if (outcome.action === "noop" && this.#agentLoop.state === "idle") {
			// 回合尚未 beginTurn（submit 仍在会话落盘窗口）：Esc 仍须兑现取消语义。
			this.#turnCancelled = true;
			this.#turnController?.abort();
		}
		this.#frame();
	}

	// ------------------------------------------------------------------
	// 对话驱动（与 headless 同一回合合约，交互面替换输出面）
	// ------------------------------------------------------------------

	/** 提交一条用户输入并跑完对话回合（resolve 于自然收尾/暂停收束；exit 抛错）。 */
	async submit(prompt: string): Promise<TuiSessionResult> {
		if (this.#sessionId === undefined) throw new TuiSessionError("not-started", "会话未初始化：先调用 start()");
		if (this.#state === "exited" || this.#agentLoop.state === "exit") {
			throw new TuiSessionError("session-exited", "会话已退出（Esc 二段），不可继续提交");
		}
		this.#turnCancelled = false;
		this.#exitRequested = false;
		this.#turnController = new AbortController();
		this.#state = "running";

		// 会话持久化：根条目（仅首个 submit 建立）与链式追加。
		if (this.#messages.length === 0) {
			const rootEntry = await this.#manager.append(this.#sessionId, null, {
				type: "user",
				payload: { text: prompt } as unknown as JsonValue,
			});
			this.#parentId = rootEntry.id;
		} else {
			await this.#appendChained({ type: "user", payload: { text: prompt } as unknown as JsonValue });
		}
		this.#messages = [...this.#messages, { role: "user", content: prompt }];
		this.#transcribe("user", prompt);
		this.#frame();

		try {
			while (this.#rounds < this.#maxRounds) {
				this.#rounds += 1;
				// 状态机契约：beginTurn 只走 idle→thinking；paused→thinking 走 resume()。
				if (this.#agentLoop.state === "idle") this.#agentLoop.beginTurn();
				else if (this.#agentLoop.state === "paused") this.#agentLoop.resume();
				let text = "";
				const blocks: ContentBlock[] = [];
				const assembler = new ToolCallAssembler();
				let stop: StopReason = null;
				for await (const event of this.#model.stream({
					messages: this.#messages,
					tools: [...this.#registry.values()].map((t) => t.definition),
					signal: this.#turnController.signal,
				})) {
					if (event.type === "content_delta") text += event.delta;
					else if (event.type === "tool_call_delta") assembler.push(event);
					else if (event.type === "done") stop = event.stopReason;
					else if (event.type === "error") {
						if (this.#turnCancelled || this.#exitRequested) break; // abort 的优雅收束
						throw new TuiSessionError("adapter-error", `${event.error.code}: ${event.error.message}`);
					}
				}
				// Esc 收束：cancelled=一段暂停（保留 paused 态待 resume）；exit=二段终态。
				if (this.#exitRequested || this.#turnCancelled) {
					const endedAs = this.#exitRequested ? "exit" : "cancelled";
					if (text !== "") {
						const partial: ContentBlock[] = [{ type: "text", text }];
						this.#messages.push({ role: "assistant", content: partial });
						this.#transcribe("assistant", text);
						await this.#appendChained({ type: "assistant", payload: { content: partial } as unknown as JsonValue });
					}
					return this.#result(endedAs, text);
				}
				if (stop === "stop" || stop === null) {
					if (text !== "") blocks.push({ type: "text", text } satisfies TextBlock);
					this.#messages.push({ role: "assistant", content: blocks });
					if (text !== "") this.#transcribe("assistant", text);
					await this.#appendChained({ type: "assistant", payload: { content: blocks } as unknown as JsonValue });
					this.#agentLoop.finishTurn();
					this.#state = "idle";
					this.#frame();
					return this.#result("finish", text);
				}
				if (stop !== "tool_use") {
					this.#agentLoop.finishTurn();
					throw new TuiSessionError("adapter-error", `不可继续的停止原因: ${String(stop)}`);
				}

				// tool_use 回合：assistant(含 tool_use 块) → 工具流水线 → tool_result 回填
				const calls = assembler.drain();
				const useBlocks: ToolUseBlock[] = calls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.args }));
				this.#messages.push({ role: "assistant", content: [...blocks, ...useBlocks] });
				await this.#appendChained({ type: "assistant", payload: { content: [...blocks, ...useBlocks] } as unknown as JsonValue });

				const results = await this.#agentLoop.executeTools(calls);
				this.#toolResults.push(...results);

				const resultBlocks: ToolResultBlock[] = [];
				for (const call of calls) {
					const result = results.find((r) => r.id === call.id);
					const summary =
						result === undefined
							? "lost-result"
							: result.ok
								? typeof result.value === "string"
									? result.value
									: JSON.stringify(result.value)
								: `error: ${result.error ?? "unknown"}`;
					resultBlocks.push({
						type: "tool_result",
						toolUseId: call.id,
						content: summary,
						isError: result === undefined || !result.ok,
					});
					this.#transcribe("tool", `${call.name}(${truncate(call.args)} → ${summary === "" ? "空" : truncate(summary)})`);
					await this.#appendChained({ type: "tool_call", payload: { name: call.name, args: call.args } as unknown as JsonValue, toolCallId: call.id, toolName: call.name });
					await this.#appendChained({
						type: "tool_result",
						payload: (result === undefined ? { ok: false } : { ok: result.ok, ...(result.ok ? { value: result.value } : { error: result.error }) }) as unknown as JsonValue,
						toolCallId: call.id,
						toolName: call.name,
					});
				}
				this.#messages.push({ role: "user", content: resultBlocks });
				this.#frame();
			}
			throw new TuiSessionError("rounds-exceeded", `回合超上限 ${this.#maxRounds}`);
		} finally {
			this.#state = String(this.#agentLoop.state) === "exit" ? "exited" : "idle";
			this.#frame();
		}
	}

	#parentId: string | undefined;

	#result(endedAs: TuiSessionResult["endedAs"], finalText: string): TuiSessionResult {
		return {
			sessionId: this.#sessionId!,
			finalText,
			rounds: this.#rounds,
			toolResults: this.#toolResults,
			permissionDecisions: this.#permissionDecisions,
			endedAs,
		};
	}

	async #appendChained(input: AppendEntryInput): Promise<void> {
		const entry = await this.#manager.append(this.#sessionId!, this.#parentId ?? null, input);
		this.#parentId = entry.id;
	}

	/** 装配执行体：权限门（manual ask → 审批浮层回路）→ 真实工具。 */
	async #execute(call: ToolCall, signal: AbortSignal): Promise<unknown> {
		const binding = this.#registry.get(call.name);
		if (binding === undefined) throw new Error(`unknown-tool: ${call.name}`);
		const argSummary = binding.argSummary?.(call.args) ?? String(JSON.stringify(call.args) ?? "undefined").slice(0, 200);
		const request = { tool: call.name, argSummary, mode: this.#gate.mode } satisfies PermissionRequest;
		const decision = this.#gate.check(request);
		this.#permissionDecisions.push({ tool: call.name, decision: decision.decision });
		if (decision.decision === "deny") {
			throw new Error(`permission-denied${decision.feedback !== undefined ? `: ${decision.feedback}` : ""}`);
		}
		if (decision.decision === "ask") {
			const overlay = new ApprovalOverlay(call.name, argSummary, () => this.#frame());
			this.app.push(overlay);
			this.#activeOverlay = overlay;
			this.#state = "awaiting-approval";
			this.#frame();
			const answer = await overlay.wait();
			this.app.pop();
			this.#activeOverlay = undefined;
			this.#state = "running";
			if (answer === "deny") throw new Error("permission-denied: 用户拒绝（TUI 审批回路）");
			this.#permissionDecisions.push({ tool: call.name, decision: "allow(approved)" });
		}
		if (this.#exitRequested) throw new Error("session-exited");
		return await binding.execute(call.args, signal);
	}
}

function truncate(value: unknown, max = 60): string {
	const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "undefined");
	return text.length > max ? `${text.slice(0, max)}…` : text;
}
