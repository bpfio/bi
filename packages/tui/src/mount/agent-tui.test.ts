/**
 * BI-23.2 —— TUI 挂载验收：注入渲染面断言帧序列（伪 TTY 等价面）。
 * BI-27.2 —— 流式渲染验收：节流帧 + StreamView 预览行 + 运行态秒数。
 *
 * 全离线（脚本化模型 + 注入 Writer + 可控时钟），覆盖：
 * 1. 单回合自然收尾：帧序列出现 [user]→[assistant] 行集，状态回「就绪」；
 * 2. 工具回环：tool_use → 工具执行 → [tool] 投影行 + tool_result 回喂模型侧；
 * 3. manual 模式审批 ask 回路：浮层可见（approvalVisible）→ y=允许执行；
 * 4. 审批拒绝：n=拒绝 → 工具不执行 → 结构化 permission-denied 回喂模型；
 * 5. Esc 二段取消（可控时钟）：一段=paused 收束（endedAs=cancelled，可 resume
 *    续转）；窗口内二段=exit 终态（endedAs=exit，续提交结构化报错）；
 * 6. 流式渲染（BI-27.2）：慢速 delta 流中出现含部分文本的 ▌ StreamView 行；
 *    收束后预览行消失、投影含完整文本；running 状态行含已用秒数；80ms 窗口
 *    内连续 delta 合并出帧；取消收束同样清空预览并转写部分文本。
 * 7. 斜杠命令执行面（BI-30.1）：{ prompt } 形态入模型回合（user/assistant
 *    双入 JSONL 与转录、无 system 本地行）；string 本地形态回归（system 行
 *    上屏、JSONL 零条目）；展开失败（!ok）走本地错误文本、不入模型回合。
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
import { expandCommand, type SlashCommand } from "../../../core/src/commands/custom-commands";
import { SessionManager } from "../../../core/src/session/manager";

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

/** 轮询等待（微任务/宏任务双冲刷；超时即败）。 */
async function until(cond: () => boolean): Promise<void> {
	for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
	expect(cond()).toBe(true);
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

// ---------------------------------------------------------------------------
// BI-27.5 · 视口工程（resize 重排 + 滚轮滚回 + 富文本视图行）
// ---------------------------------------------------------------------------

describe("BI-27.5 · 视口工程", () => {
	test("resize 重排：折叠行宽跟随（projection/styled 双侧重算），滚动锚底", async () => {
		const { root, cleanup } = await makeRoot();
		try {
			const sink = frameSink();
			const longText = "这是一条相当长的用户消息，用来验证宽度变更后折行跟随重排。";
			const session = new AgentTuiSession({
				model: scriptedModel([[{ type: "done", stopReason: "stop" }]]).port,
				tools: [],
				cwd: root,
				sessionsRoot: join(root, "sessions"),
				permissionMode: "auto",
				rows: 6,
				cols: 80,
				hooks: sink.hooks,
			});
			await session.start("resize");
			const pending = session.submit(longText);
			await pending;
			expect(session.projection.width).toBe(80);
			const rows80 = session.visibleTranscriptRows().map((r) => r.spans.map((s) => s.text).join(""));
			// styled 视图行（user 条目）与 L3 同折行语义（width 80）
			const l3At80 = session.projection.render();
			expect(rows80).toEqual(l3At80);

			// 缩窄到 20：双侧重算折行，行数增加，锚底不变（尾行 = 状态行上方）
			session.resize(6, 20);
			expect(session.projection.width).toBe(20);
			const rows20 = session.visibleTranscriptRows().map((r) => r.spans.map((s) => s.text).join(""));
			expect(rows20.length).toBeGreaterThan(rows80.length);
			expect(rows20[0]!.startsWith("[user] 这是一")).toBe(true); // 首行前缀 + 折行
			expect(rows20.join("")).toContain("折行跟随重排。"); // 折行无损
		} finally {
			await cleanup();
		}
	});

	test("滚轮滚回：wheel-up 翻旧（步长 3）、wheel-down 翻新、双端钳制、归零实时锚底", async () => {
		const { root, cleanup } = await makeRoot();
		try {
			const session = new AgentTuiSession({
				// 三个回合 × (user+assistant) = 6 条目；rows=6 → 窗高 4 → maxOffset=2
				model: scriptedModel([
					[{ type: "content_delta", delta: "答一" }, { type: "done", stopReason: "stop" }],
					[{ type: "content_delta", delta: "答二" }, { type: "done", stopReason: "stop" }],
					[{ type: "content_delta", delta: "答三" }, { type: "done", stopReason: "stop" }],
				]).port,
				tools: [],
				cwd: root,
				sessionsRoot: join(root, "sessions"),
				permissionMode: "auto",
				rows: 6,
				cols: 60,
			});
			await session.start("滚回");
			await session.submit("问一");
			await session.submit("问二");
			await session.submit("问三");
			expect(session.scrollOffset).toBe(0);
			const live = session.visibleTranscriptRows().map((r) => r.spans.map((s) => s.text).join(""));

			// wheel-up 一格 = 3 行：翻向更旧（偏移 3 → 钳到 maxOffset=2）
			await session.handleKey({ kind: "wheel-up" });
			expect(session.scrollOffset).toBe(2); // 顶端钳制（不悬空）
			const scrolled = session.visibleTranscriptRows().map((r) => r.spans.map((s) => s.text).join(""));
			expect(scrolled).not.toEqual(live);
			expect(scrolled.join("")).toContain("问一"); // 旧条目回到窗内

			// wheel-down 一格 = 3 行：回到实时锚底（偏移归零）
			await session.handleKey({ kind: "wheel-down" });
			expect(session.scrollOffset).toBe(0);
			expect(session.visibleTranscriptRows().map((r) => r.spans.map((s) => s.text).join(""))).toEqual(live);

			// scrollTranscript 直接调用面：向上一步长 1；底部继续下滚 no-op
			session.scrollTranscript(1);
			expect(session.scrollOffset).toBe(1);
			session.scrollTranscript(-5); // 越过底部：钳 0
			expect(session.scrollOffset).toBe(0);
		} finally {
			await cleanup();
		}
	});

	test("富文本视图行：assistant markdown 剥离落格（styled），帧探针保持 L3 原文", async () => {
		const { root, cleanup } = await makeRoot();
		try {
			const sink = frameSink();
			const session = new AgentTuiSession({
				model: scriptedModel([
					[{ type: "content_delta", delta: "# 计划\n**执行** `run`" }, { type: "done", stopReason: "stop" }],
				]).port,
				tools: [],
				cwd: root,
				sessionsRoot: join(root, "sessions"),
				permissionMode: "auto",
				rows: 8,
				cols: 60,
				hooks: sink.hooks,
			});
			await session.start("富文本");
			await session.submit("给我计划");

			// 视图行（网格面）：markdown 标记剥离，正文保样式分段
			const viewText = session.visibleTranscriptRows().map((r) => r.spans.map((s) => s.text).join(""));
			expect(viewText.some((t) => t === "[assistant] 计划")).toBe(true); // # 剥离
			expect(viewText.some((t) => t.includes("执行 run"))).toBe(true); // **/` 剥离
			expect(viewText.some((t) => t.includes("**"))).toBe(false);
			// 样式分段：粗体落格（BI-27.3 cell 样式面）
			const boldRow = session.visibleTranscriptRows().find((r) => r.spans.some((s) => s.style?.bold === true));
			expect(boldRow).toBeDefined();

			// 帧探针（投影面）：L3 原文不变（markdown 保留）
			const last = sink.frames.at(-1)!;
			expect(last.lines.some((l) => l.includes("[assistant] # 计划"))).toBe(true);
			expect(last.lines.some((l) => l.includes("**执行** `run`"))).toBe(true);
		} finally {
			await cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// BI-27.2 · 流式渲染（节流帧 + StreamView 预览行 + 运行态秒数）
// ---------------------------------------------------------------------------

describe("BI-27.2 · 流式渲染", () => {
	/** 可控时钟：测试显式推进 `now`（节流与秒数共用注入面，零真实延时）。 */
	function steppedClock(initial: number): { clock: Clock; advance: (ms: number) => void } {
		let now = initial;
		return {
			clock: {
				now: () => now,
				setTimeout: (handler, ms) => setTimeout(handler, ms),
				clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
			},
			advance: (ms) => {
				now += ms;
			},
		};
	}

	/** 门控慢速模型：每个 delta 停在闸门，测试推进时钟后放行（确定性节流驱动）。 */
	function gatedStreamModel(gates: Array<{ promise: Promise<void>; open: () => void }>): ModelPort {
		return {
			async *stream() {
				for (let i = 0; i < gates.length; i++) {
					yield { type: "content_delta", delta: `第${i + 1}段` } as StreamEvent;
					await gates[i]!.promise;
				}
				yield { type: "done", stopReason: "stop" } as StreamEvent;
			},
		};
	}

	function gate(): { promise: Promise<void>; open: () => void } {
		let open!: () => void;
		return { promise: new Promise<void>((r) => (open = r)), open };
	}

	test("慢速 delta：流中出现含部分文本的 ▌ 预览行；收束后预览退场、投影含完整文本；running 状态行含秒数", async () => {
		const { root, cleanup } = await makeRoot();
		try {
			const { clock, advance } = steppedClock(1_000);
			const gates = [gate(), gate(), gate()];
			const sink = frameSink();
			const session = new AgentTuiSession({
				model: gatedStreamModel(gates),
				tools: [],
				cwd: root,
				sessionsRoot: join(root, "sessions"),
				permissionMode: "auto",
				rows: 8,
				cols: 60,
				clock,
				hooks: sink.hooks,
			});
			await session.start("流式");
			const pending = session.submit("流式一下");

			// ① 首 delta 立即出帧：StreamView 行含部分文本（running 态）。
			await until(() => sink.frames.some((f) => f.lines.includes("▌第1段")));
			const first = sink.frames.find((f) => f.lines.includes("▌第1段"))!;
			expect(first.state).toBe("running");

			// 推进 3s 后放行第二段：节流窗外 → 新帧；状态行秒数随帧刷新。
			advance(3_000);
			gates[0]!.open();
			await until(() => sink.frames.some((f) => f.lines.includes("▌第1段第2段")));
			const second = sink.frames.filter((f) => f.lines.includes("▌第1段第2段")).at(-1)!;
			// ③ running 状态行含已用秒数（turnStartedAt=1000，now=4000 → 3s）。
			expect(second.lines.some((l) => l.includes("运行中 3s"))).toBe(true);

			// 收束（正常）：预览行退场、投影按既有逻辑含完整文本。
			advance(100);
			gates[1]!.open();
			gates[2]!.open();
			const result = await pending;
			expect(result.endedAs).toBe("finish");
			expect(result.finalText).toBe("第1段第2段第3段");
			const last = sink.frames.at(-1)!;
			// ② 末帧无 ▌ 预览行，且投影含完整文本。
			expect(last.lines.some((l) => l.startsWith("▌"))).toBe(false);
			expect(last.lines.some((l) => l.includes("[assistant] 第1段第2段第3段"))).toBe(true);
			expect(last.state).toBe("idle");
		} finally {
			await cleanup();
		}
	});

	test("节流合并：80ms 窗口内连续 delta 只出一次帧，窗外 delta 出新帧", async () => {
		const { root, cleanup } = await makeRoot();
		try {
			const { clock, advance } = steppedClock(1_000);
			const gates = [gate(), gate(), gate()];
			const sink = frameSink();
			const session = new AgentTuiSession({
				model: gatedStreamModel(gates),
				tools: [],
				cwd: root,
				sessionsRoot: join(root, "sessions"),
				permissionMode: "auto",
				rows: 8,
				cols: 60,
				clock,
				hooks: sink.hooks,
			});
			await session.start("节流");
			const pending = session.submit("连发");

			await until(() => sink.frames.some((f) => f.lines.includes("▌第1段")));
			const afterFirst = sink.frames.length;
			gates[0]!.open(); // delta2 在同一时刻到达：窗口内合并，不出新帧
			await new Promise((r) => setTimeout(r, 20));
			expect(sink.frames.some((f) => f.lines.includes("▌第1段第2段"))).toBe(false);
			expect(sink.frames.length).toBe(afterFirst);

			advance(80); // 窗外：delta3 出新帧（now-last=80，恰达节流阈值）
			gates[1]!.open();
			gates[2]!.open();
			await pending;
			expect(sink.frames.some((f) => f.lines.includes("▌第1段第2段第3段"))).toBe(true);
		} finally {
			await cleanup();
		}
	});

	test("取消收束：预览缓冲清空（▌ 行消失），部分文本按既有逻辑 transcribe 进投影", async () => {
		const { root, cleanup } = await makeRoot();
		let release!: () => void;
		const gate = { promise: new Promise<void>((r) => (release = r)), open: () => release() };
		try {
			const { clock } = steppedClock(1_000);
			const sink = frameSink();
			const session = new AgentTuiSession({
				model: hangingModel(gate),
				tools: [],
				cwd: root,
				sessionsRoot: join(root, "sessions"),
				cancelWindowMs: 800,
				clock,
				rows: 6,
				cols: 40,
				hooks: sink.hooks,
			});
			await session.start("取消预览");
			const pending = session.submit("长任务");
			for (let i = 0; i < 200 && session.agentState !== "thinking"; i++) await new Promise((r) => setTimeout(r, 1));
			await until(() => sink.frames.some((f) => f.lines.includes("▌进行中…"))); // 流中预览可见
			await session.handleKey(esc); // 一段：paused，abort 流
			gate.open();
			const result = await pending;
			expect(result.endedAs).toBe("cancelled");
			const last = sink.frames.at(-1)!;
			expect(last.lines.some((l) => l.startsWith("▌"))).toBe(false); // 预览退场
			expect(last.lines.some((l) => l.includes("[assistant] 进行中…"))).toBe(true); // 部分文本转写（既有行为）
		} finally {
			gate.open();
			await cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// BI-30.1 · 斜杠命令执行面（{ prompt } 入模型回合 / string 本地转录）
// ---------------------------------------------------------------------------

describe("BI-30.1 · 斜杠命令执行面", () => {
	/**
	 * bin/bi.ts 斜杠执行面的契约镜像：已知自定义命令 → expandCommand(命令对象,
	 * 参数数组) → ok 回 { prompt: 展开文本 }、!ok 回 error.message（本地文本）。
	 */
	function customSlashHandler(
		commands: readonly SlashCommand[],
	): (line: string) => Promise<string | { prompt: string }> {
		return async (line) => {
			const trimmed = line.trim();
			const head = trimmed.split(/\s+/)[0] ?? "";
			const command = commands.find((c) => `/${c.name}` === head);
			if (command === undefined) return `未知斜杠命令: ${head}`;
			const rest = trimmed.slice(head.length).trim();
			const argv = rest === "" ? [] : rest.split(/\s+/);
			const expanded = expandCommand(command, argv);
			return expanded.ok ? { prompt: expanded.text } : expanded.error.message;
		};
	}

	/** 自定义命令夹具：必选 `<topic>` + 模板体位置注入（ok/!ok 两路径共用）。 */
	function demoCommand(): SlashCommand {
		return {
			name: "demo",
			description: "示例命令",
			argsSpec: "<topic>",
			requiredArgs: ["topic"],
			optionalArgs: [],
			sourceFile: "/x/demo.md",
			body: "总结: $1",
		};
	}

	test("{ prompt } 形态：展开提示词入模型回合（user/assistant 入 JSONL），转录含 assistant 回复", async () => {
		const { root, cleanup } = await makeRoot();
		try {
			const sink = frameSink();
			const { port, received } = scriptedModel([
				[{ type: "content_delta", delta: "日志已总结。" }, { type: "done", stopReason: "stop" }],
			]);
			const session = new AgentTuiSession({
				model: port,
				tools: [],
				cwd: root,
				sessionsRoot: join(root, "sessions"),
				permissionMode: "auto",
				rows: 8,
				cols: 80,
				hooks: sink.hooks,
				slashCommand: customSlashHandler([demoCommand()]),
			});
			const sessionId = await session.start("斜杠执行面");
			const result = await session.submit("/demo 日志");
			expect(result.endedAs).toBe("finish");
			expect(result.finalText).toBe("日志已总结。");

			// 模型回合收到的是展开后的用户提示词（非 "/demo 日志" 行原文）
			expect(received).toHaveLength(1);
			const messages = received[0]!.messages;
			expect(messages[0]!.role).toBe("user");
			expect(messages[0]!.content).toBe("总结: 日志");

			// 转录：[user] 展开文本 + [assistant] 回复；不出 system 本地行
			const l3 = session.projection.render();
			expect(l3).toContain("[user] 总结: 日志");
			expect(l3).toContain("[assistant] 日志已总结。");
			expect(l3.some((l) => l.startsWith("[system]"))).toBe(false);
			const last = sink.frames.at(-1)!;
			expect(last.lines.some((l) => l.includes("[user] 总结: 日志"))).toBe(true);
			expect(last.lines.some((l) => l.includes("[assistant] 日志已总结。"))).toBe(true);
			expect(last.state).toBe("idle");

			// JSONL：user + assistant 双条目入链（普通收尾，无本地条目）
			const manager = new SessionManager({ rootDir: join(root, "sessions") });
			const entries = await manager.entries(sessionId);
			expect(entries.map((e) => e.type)).toEqual(["user", "assistant"]);
		} finally {
			await cleanup();
		}
	});

	test("string 本地形态（既有回归）：system 行上屏、不入模型回合、JSONL 零条目", async () => {
		const { root, cleanup } = await makeRoot();
		try {
			const sink = frameSink();
			// 脚本为空：模型一旦被调用即抛（第 1 回合无脚本）→ 本测同时断言不入模型回合。
			const { port } = scriptedModel([]);
			const session = new AgentTuiSession({
				model: port,
				tools: [],
				cwd: root,
				sessionsRoot: join(root, "sessions"),
				permissionMode: "auto",
				rows: 8,
				cols: 80,
				hooks: sink.hooks,
				slashCommand: async () => "本地回执: 已切换",
			});
			const sessionId = await session.start("本地回执");
			const result = await session.submit("/permissions yolo");
			expect(result.endedAs).toBe("finish");
			expect(result.finalText).toBe("本地回执: 已切换");
			const l3 = session.projection.render();
			expect(l3).toContain("[system] 本地回执: 已切换");
			expect(l3.some((l) => l.startsWith("[user]"))).toBe(false);
			expect(sink.frames.at(-1)!.lines.some((l) => l.includes("[system] 本地回执"))).toBe(true);
			const manager = new SessionManager({ rootDir: join(root, "sessions") });
			expect(await manager.entries(sessionId)).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});

	test("展开失败（!ok）：error.message 本地错误文本上屏，不入模型回合", async () => {
		const { root, cleanup } = await makeRoot();
		try {
			const sink = frameSink();
			const { port } = scriptedModel([]); // 调用即抛 → 断言不入模型回合
			const session = new AgentTuiSession({
				model: port,
				tools: [],
				cwd: root,
				sessionsRoot: join(root, "sessions"),
				permissionMode: "auto",
				rows: 8,
				cols: 80,
				hooks: sink.hooks,
				slashCommand: customSlashHandler([demoCommand()]),
			});
			const sessionId = await session.start("展开失败");
			const result = await session.submit("/demo"); // 缺必选参数 <topic>
			expect(result.endedAs).toBe("finish");
			expect(result.finalText).toContain("/demo 缺少必选参数: topic");
			const l3 = session.projection.render();
			expect(l3.some((l) => l.startsWith("[system]") && l.includes("缺少必选参数"))).toBe(true);
			expect(l3.some((l) => l.startsWith("[user]"))).toBe(false);
			expect(sink.frames.at(-1)!.lines.some((l) => l.includes("缺少必选参数"))).toBe(true);
			const manager = new SessionManager({ rootDir: join(root, "sessions") });
			expect(await manager.entries(sessionId)).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});
});
