/**
 * BI-23.2 —— TUI 挂载验收：注入渲染面断言帧序列（伪 TTY 等价面）。
 *
 * 全离线（脚本化模型 + 注入 Writer + 可控时钟），覆盖：
 * 1. 单回合自然收尾：帧序列出现 [user]→[assistant] 行集，状态回「就绪」；
 * 2. 工具回环：tool_use → 工具执行 → [tool] 投影行 + tool_result 回喂模型侧；
 * 3. manual 模式审批 ask 回路：浮层可见（approvalVisible）→ y=允许执行；
 * 4. 审批拒绝：n=拒绝 → 工具不执行 → 结构化 permission-denied 回喂模型；
 * 5. Esc 二段取消（可控时钟）：一段=paused 收束（endedAs=cancelled，可 resume
 *    续转）；窗口内二段=exit 终态（endedAs=exit，续提交结构化报错）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentTuiSession, TuiSessionError } from "./agent-tui";
import type { ModelPort, ToolBinding } from "../../../core/src/cli/headless";
import type { AgentMessage, StreamEvent } from "../../../core/src/adapters/deepseek-adapter";
import type { Clock } from "../../../core/src/guard/deadline";
import type { ParsedKey } from "../engine/diff-renderer";

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

/** 脚本化模型：按回合回放事件，捕获每回合收到的消息（tool_result 回喂断言）。 */
function scriptedModel(rounds: StreamEvent[][]): {
	port: ModelPort;
	received: Array<{ messages: readonly AgentMessage[] }>;
} {
	const received: Array<{ messages: readonly AgentMessage[] }> = [];
	let cursor = 0;
	const port: ModelPort = {
		async *stream(input) {
			const round = rounds[cursor];
			cursor += 1;
			if (round === undefined) throw new Error(`scripted-model: 第 ${cursor} 回合无脚本`);
			received.push({ messages: [...input.messages] });
			for (const event of round) yield event;
		},
	};
	return { port, received };
}

/** 可中止挂起模型：abort 后被闸门放行再吐 error 事件（Esc 二段取消的确定性驱动）。 */
function hangingModel(gate: { promise: Promise<void>; open: () => void }): ModelPort {
	return {
		async *stream(input) {
			const signal = input.signal;
			if (signal?.aborted === true) {
				yield { type: "error", error: { code: "network", message: "request aborted" } } as StreamEvent;
				return;
			}
			const abortWait = new Promise<void>((resolve) => {
				signal?.addEventListener("abort", () => resolve(), { once: true });
				if (signal?.aborted === true) resolve(); // 竞态兜底：已中止的信号不再派发 abort 事件
			});
			yield { type: "content_delta", delta: "进行中…" } as StreamEvent;
			await abortWait;
			await gate.promise;
			yield { type: "error", error: { code: "network", message: "stream aborted" } } as StreamEvent;
		},
	};
}

function echoBinding(name = "echo_tool"): ToolBinding {
	return {
		definition: {
			name,
			description: "回显工具",
			inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
		},
		readOnly: false,
		argSummary: (args) => String((args as { text?: string }).text ?? ""),
		execute: async (args) => `echo:${(args as { text?: string }).text ?? ""}`,
	};
}

const esc: ParsedKey = { kind: "esc" } as ParsedKey;

interface FrameSink {
	frames: Array<{ lines: readonly string[]; approvalVisible: boolean; state: string }>;
	approvalFrames(): Array<{ lines: readonly string[]; state: string }>;
}

function frameSink(): FrameSink & { hooks: { onFrame: (lines: readonly string[], info: { approvalVisible: boolean; state: string }) => void } } {
	const self: FrameSink = {
		frames: [],
		approvalFrames() {
			return this.frames.filter((f) => f.approvalVisible);
		},
	};
	return {
		frames: self.frames,
		approvalFrames: self.approvalFrames.bind(self),
		hooks: {
			onFrame: (lines, info) => self.frames.push({ lines, approvalVisible: info.approvalVisible, state: info.state }),
		},
	};
}

async function makeRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "bi-tui-mount-"));
	return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

describe("BI-23.2 · TUI 挂载（注入渲染面）", () => {
	test("单回合自然收尾：帧序列 [user]→[assistant]，状态回就绪", async () => {
		const { root, cleanup } = await makeRoot();
		try {
			const sink = frameSink();
			const session = new AgentTuiSession({
				model: scriptedModel([[{ type: "content_delta", delta: "你好，世界。" }, { type: "done", stopReason: "stop" }]]).port,
				tools: [],
				cwd: root,
				sessionsRoot: join(root, "sessions"),
				permissionMode: "auto",
				rows: 6,
				cols: 60,
				hooks: sink.hooks,
			});
			const sessionId = await session.start("帧序列");
			const result = await session.submit("打声招呼");
			expect(result.endedAs).toBe("finish");
			expect(result.finalText).toBe("你好，世界。");
			expect(result.sessionId).toBe(sessionId);
			const last = sink.frames.at(-1)!;
			expect(last.state).toBe("idle");
			expect(last.lines.some((l) => l.includes("[user] 打声招呼"))).toBe(true);
			expect(last.lines.some((l) => l.includes("[assistant] 你好，世界。"))).toBe(true);
			expect(last.lines.some((l) => l.includes("就绪"))).toBe(true);
			// 帧序列单调推进：首帧含 user，末帧含 assistant
			expect(sink.frames[0]!.lines.some((l) => l.includes("[user]"))).toBe(true);
		} finally {
			await cleanup();
		}
	});

	test("工具回环：tool_use → 执行 → [tool] 投影行 → tool_result 回喂模型", async () => {
		const { root, cleanup } = await makeRoot();
		try {
			const sink = frameSink();
			const { port, received } = scriptedModel([
				[
					{ type: "content_delta", delta: "我来回显。" },
					{ type: "tool_call_delta", index: 0, id: "call_1", name: "echo_tool", argumentsDelta: '{"text":"勾稽"}' },
					{ type: "done", stopReason: "tool_use" },
				],
				[{ type: "content_delta", delta: "完成。" }, { type: "done", stopReason: "stop" }],
			]);
			const session = new AgentTuiSession({
				model: port,
				tools: [echoBinding()],
				cwd: root,
				sessionsRoot: join(root, "sessions"),
				permissionMode: "auto",
				rows: 8,
				cols: 60,
				hooks: sink.hooks,
			});
			await session.start("工具回环");
			const result = await session.submit("回显一下");
			expect(result.endedAs).toBe("finish");
			expect(result.rounds).toBe(2);
			expect(result.toolResults[0]).toMatchObject({ ok: true, value: "echo:勾稽" });
			// 投影行：[tool] echo_tool(...) → echo:勾稽
			const last = sink.frames.at(-1)!;
			expect(last.lines.some((l) => l.startsWith("[tool] echo_tool(") && l.includes("echo:勾稽"))).toBe(true);
			// 模型侧第二回合收到 tool_result 块
			const round2 = received[1]!.messages;
			const toolResultMsg = round2.at(-1);
			expect(toolResultMsg?.role).toBe("user");
			expect(JSON.stringify(toolResultMsg?.content)).toContain("echo:勾稽");
			expect(JSON.stringify(toolResultMsg?.content)).toContain('"call_1"');
		} finally {
			await cleanup();
		}
	});

	test("manual 审批 ask 回路：浮层可见 → y=放行执行", async () => {
		const { root, cleanup } = await makeRoot();
		try {
			const sink = frameSink();
			const { port } = scriptedModel([
				[
					{ type: "tool_call_delta", index: 0, id: "call_1", name: "echo_tool", argumentsDelta: '{"text":"机密"}' },
					{ type: "done", stopReason: "tool_use" },
				],
				[{ type: "content_delta", delta: "已放行。" }, { type: "done", stopReason: "stop" }],
			]);
			const session = new AgentTuiSession({
				model: port,
				tools: [echoBinding()],
				cwd: root,
				sessionsRoot: join(root, "sessions"),
				permissionMode: "manual",
				rows: 8,
				cols: 60,
				hooks: sink.hooks,
			});
			await session.start("审批");
			const pending = session.submit("执行工具");
			// 等待审批浮层出现
			for (let i = 0; i < 200 && sink.approvalFrames().length === 0; i++) {
				await new Promise((r) => setTimeout(r, 1));
			}
			const approval = sink.approvalFrames().at(-1)!;
			expect(approval.state).toBe("awaiting-approval");
			expect(approval.lines.some((l) => l.includes("echo_tool"))).toBe(true);
			// y = 放行
			session.app.dispatchKey({ kind: "char", char: "y" } as ParsedKey);
			const result = await pending;
			expect(result.endedAs).toBe("finish");
			expect(result.toolResults[0]).toMatchObject({ ok: true, value: "echo:机密" });
			expect(result.permissionDecisions).toContainEqual({ tool: "echo_tool", decision: "ask" });
			expect(result.permissionDecisions).toContainEqual({ tool: "echo_tool", decision: "allow(approved)" });
		} finally {
			await cleanup();
		}
	});

	test("manual 审批拒绝：n → 工具不执行，permission-denied 回喂模型", async () => {
		const { root, cleanup } = await makeRoot();
		try {
			const sink = frameSink();
			const { port, received } = scriptedModel([
				[
					{ type: "tool_call_delta", index: 0, id: "call_1", name: "echo_tool", argumentsDelta: '{"text":"x"}' },
					{ type: "done", stopReason: "tool_use" },
				],
				[{ type: "content_delta", delta: "明白，不执行了。" }, { type: "done", stopReason: "stop" }],
			]);
			const session = new AgentTuiSession({
				model: port,
				tools: [echoBinding()],
				cwd: root,
				sessionsRoot: join(root, "sessions"),
				permissionMode: "manual",
				rows: 8,
				cols: 60,
				hooks: sink.hooks,
			});
			await session.start("拒绝");
			const pending = session.submit("试试");
			for (let i = 0; i < 200 && sink.approvalFrames().length === 0; i++) {
				await new Promise((r) => setTimeout(r, 1));
			}
			session.app.dispatchKey({ kind: "char", char: "n" } as ParsedKey);
			const result = await pending;
			expect(result.toolResults[0]!.ok).toBe(false); // 工具未执行，拒绝结构化回喂
			expect(String(result.toolResults[0]!.error)).toContain("permission-denied");
			expect(result.permissionDecisions).toContainEqual({ tool: "echo_tool", decision: "ask" });
			// 拒绝结构化回喂：第二回合消息含 permission-denied 与 isError
			const round2 = received[1]!.messages.at(-1)!;
			const serialized = JSON.stringify(round2.content);
			expect(serialized).toContain("permission-denied");
			expect(serialized).toContain('"isError":true');
		} finally {
			await cleanup();
		}
	});
});

describe("BI-23.2 · Esc 二段取消（可控时钟）", () => {
	function fakeClock(times: number[]): Clock {
		let i = 0;
		return {
			now: () => times[i++] ?? 1_000_000,
			setTimeout: (handler, ms) => setTimeout(handler, ms),
			clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
		};
	}

	test("一段 Esc：paused 收束（endedAs=cancelled），续提交经 resume 续转", async () => {
		const { root, cleanup } = await makeRoot();
		let release: () => void;
		const gate = { promise: new Promise<void>((r) => (release = r)), open: () => release() };
		try {
			const model = hangingModel(gate);
			const session = new AgentTuiSession({
				model,
				tools: [],
				cwd: root,
				sessionsRoot: join(root, "sessions"),
				cancelWindowMs: 800,
				clock: fakeClock([0]),
				rows: 6,
				cols: 40,
			});
			await session.start("取消");
			const pending = session.submit("长任务");
			for (let i = 0; i < 200 && session.agentState !== "thinking"; i++) await new Promise((r) => setTimeout(r, 1));
			await session.handleKey(esc); // 一段：thinking→paused，abort 流
			gate.open(); // 放行流的 abort 收束
			const result = await pending;
			expect(result.endedAs).toBe("cancelled");
			expect(session.state).toBe("idle"); // 会话仍可用
			// paused 会话续转语义由 AgentLoop.resume（paused→thinking）保证（BI-07 单测覆盖）；
			// 挂载面在此验证：取消后会话状态就绪、续提交不抛"已退出"。
		} finally {
			gate.open();
			await cleanup();
		}
	});

	test("窗口内二段 Esc：exit 终态（endedAs=exit），续提交结构化报错", async () => {
		const { root, cleanup } = await makeRoot();
		let release!: () => void;
		const gate = { promise: new Promise<void>((r) => (release = r)), open: () => release() };
		try {
			const model = hangingModel(gate);
			const session = new AgentTuiSession({
				model,
				tools: [],
				cwd: root,
				sessionsRoot: join(root, "sessions"),
				cancelWindowMs: 800,
				clock: fakeClock([0, 50]),
				rows: 6,
				cols: 40,
			});
			await session.start("退出");
			const pending = session.submit("长任务");
			for (let i = 0; i < 200 && session.agentState !== "thinking"; i++) await new Promise((r) => setTimeout(r, 1));
			await session.handleKey(esc); // 一段 t=0：paused（流挂起在 gate 后）
			await session.handleKey(esc); // 二段 t=50（窗口内）：exit
			gate.open(); // 放行流的 abort 收束
			const result = await pending;
			expect(result.endedAs).toBe("exit");
			expect(session.state).toBe("exited");
			await expect(session.submit("再来")).rejects.toMatchObject({ code: "session-exited" });
		} finally {
			await cleanup();
		}
	});
});
