/**
 * W3-D7（BI-05.3）· headless 上下文引擎装配面验收。
 *
 * 每个接入器官 on/off 对照 + 缺省等价回归：
 * - time_context：当前时钟注入 system 面 on/off；
 * - date_change_sensor：跨日翻转披露 on/off（注入时钟跨 00:00）；
 * - tool_result_prune：工具结果二级修剪 on/off（>8192 码点保头尾抹中段）；
 * - max_history_entries：window-manager 历史条目上限裁剪 on/off；
 * - 缺省（context 未提供）：所有行为逐字节等价于现状（既有测试零改动即此回归）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHeadless, type HeadlessOptions, type ModelPort, type ToolBinding } from "./headless";
import type { AgentMessage, StreamEvent } from "../adapters/deepseek-adapter";

/** 脚本化模型端口：按回合回放事件序列，并捕获收到的消息流供接线断言。 */
function scriptedModel(rounds: StreamEvent[][]): {
	port: ModelPort;
	received: Array<{ messages: readonly AgentMessage[]; tools: readonly string[] }>;
} {
	const received: Array<{ messages: readonly AgentMessage[]; tools: readonly string[] }> = [];
	let cursor = 0;
	const port: ModelPort = {
		async *stream(input) {
			const round = rounds[cursor];
			cursor += 1;
			if (round === undefined) throw new Error(`scripted-model: 第 ${cursor} 回合无脚本`);
			received.push({ messages: [...input.messages], tools: input.tools.map((t) => t.name) });
			for (const event of round) yield event;
		},
	};
	return { port, received };
}

/** 固定输出工具绑定（供截断/裁剪断言）。 */
function fixedOutputTool(output: unknown): ToolBinding {
	return {
		definition: { name: "emit", description: "输出固定内容", inputSchema: { type: "object", properties: {} } },
		readOnly: true,
		execute: async () => output,
	};
}

const FINAL_ROUND: StreamEvent[] = [
	{ type: "content_delta", delta: "完成。" },
	{ type: "done", stopReason: "stop" },
];

const TOOL_THEN_FINAL = (output: unknown): StreamEvent[][] => [
	[
		{ type: "tool_call_delta", index: 0, id: "call_1", name: "emit", argumentsDelta: "{}" },
		{ type: "done", stopReason: "tool_use" },
	],
	FINAL_ROUND,
];

/** 多轮 tool_use 序列：前 rounds-1 轮 tool_use，末轮 final。 */
function multiRound(rounds: number): StreamEvent[][] {
	const out: StreamEvent[][] = [];
	for (let i = 0; i < rounds; i++) {
		if (i < rounds - 1) {
			out.push([
				{ type: "tool_call_delta", index: 0, id: `call_${i}`, name: "emit", argumentsDelta: "{}" },
				{ type: "done", stopReason: "tool_use" },
			]);
		} else {
			out.push(FINAL_ROUND);
		}
	}
	return out;
}

async function makeWorkspace(): Promise<{ root: string; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "bi-w3d7-hl-"));
	return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function systemTextOf(messages: readonly AgentMessage[]): string {
	const sys = messages.find((m) => m.role === "system");
	return typeof sys?.content === "string" ? sys.content : "";
}

// ---------------------------------------------------------------------------
// time_context
// ---------------------------------------------------------------------------

describe("W3-D7 headless: time_context（BI-05.4）", () => {
	test("on：system 面注入当前时钟上下文块（含时区与偏移）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port, received } = scriptedModel([FINAL_ROUND]);
			const now = () => Date.parse("2026-01-15T03:30:00Z");
			await runHeadless({
				prompt: "hi",
				cwd: root,
				model: port,
				tools: [],
				sessionsRoot: join(root, "sessions"),
				context: { timeContext: true, timezone: "Asia/Shanghai", now },
				out: () => {},
			} as HeadlessOptions);
			const sys = systemTextOf(received[0]!.messages);
			expect(sys).toContain("Current time:");
			expect(sys).toContain("Asia/Shanghai");
			expect(sys).toContain("UTC+08:00");
		} finally {
			await cleanup();
		}
	});

	test("off（缺省）：无 system 消息时仍只有 user 消息（现状逐字节等价）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port, received } = scriptedModel([FINAL_ROUND]);
			await runHeadless({
				prompt: "hi",
				cwd: root,
				model: port,
				tools: [],
				sessionsRoot: join(root, "sessions"),
				out: () => {},
			} as HeadlessOptions);
			expect(received[0]!.messages[0]!.role).toBe("user");
			expect(systemTextOf(received[0]!.messages)).toBe("");
		} finally {
			await cleanup();
		}
	});

	test("与 --agent-file 系统指令共存：时间块追加在指令之后，指令原样保留", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port, received } = scriptedModel([FINAL_ROUND]);
			const now = () => Date.parse("2026-01-15T03:30:00Z");
			await runHeadless({
				prompt: "hi",
				cwd: root,
				model: port,
				tools: [],
				sessionsRoot: join(root, "sessions"),
				systemInstruction: "你是助手。",
				context: { timeContext: true, timezone: "Asia/Shanghai", now },
				out: () => {},
			} as HeadlessOptions);
			const sys = systemTextOf(received[0]!.messages);
			expect(sys.startsWith("你是助手。")).toBe(true);
			expect(sys).toContain("Current time:");
		} finally {
			await cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// date_change_sensor
// ---------------------------------------------------------------------------

describe("W3-D7 headless: date_change_sensor（BI-10.5）", () => {
	test("on + 时钟跨 00:00：每自然日至多一次注入跨日披露提示", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			let clock = Date.parse("2026-01-01T12:00:00Z");
			const now = (): number => {
				const v = clock;
				clock += 24 * 3600 * 1000; // 每轮推进一天 → 跨日
				return v;
			};
			const { port, received } = scriptedModel(TOOL_THEN_FINAL("ok"));
			await runHeadless({
				prompt: "hi",
				cwd: root,
				model: port,
				tools: [fixedOutputTool("ok")],
				sessionsRoot: join(root, "sessions"),
				context: { dateChangeSensor: true, timezone: "Asia/Shanghai", now },
				out: () => {},
			} as HeadlessOptions);
			// 末轮（final）消息应含跨日披露 system 提示。
			const last = received.at(-1)!.messages;
			const sys = systemTextOf(last);
			expect(sys).toContain("已跨过 00:00");
		} finally {
			await cleanup();
		}
	});

	test("off（缺省）：即便时钟跨日也不注入任何提示", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			let clock = Date.parse("2026-01-01T12:00:00Z");
			const now = (): number => {
				const v = clock;
				clock += 24 * 3600 * 1000;
				return v;
			};
			const { port, received } = scriptedModel(TOOL_THEN_FINAL("ok"));
			await runHeadless({
				prompt: "hi",
				cwd: root,
				model: port,
				tools: [fixedOutputTool("ok")],
				sessionsRoot: join(root, "sessions"),
				context: { dateChangeSensor: false, timezone: "Asia/Shanghai", now },
				out: () => {},
			} as HeadlessOptions);
			expect(systemTextOf(received.at(-1)!.messages)).toBe("");
		} finally {
			await cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// tool_result_prune
// ---------------------------------------------------------------------------

describe("W3-D7 headless: tool_result_prune（BI-08.1 二级）", () => {
	const BIG = "y".repeat(20_000); // 远超 8192 阈值

	test("on：>8192 码点工具输出保头尾、抹中段（带钉死标记行）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port } = scriptedModel(TOOL_THEN_FINAL(BIG));
			const result = await runHeadless({
				prompt: "输出",
				cwd: root,
				model: port,
				tools: [fixedOutputTool(BIG)],
				sessionsRoot: join(root, "sessions"),
				context: { toolResultPrune: true },
				out: () => {},
			} as HeadlessOptions);
			const value = result.toolResults[0]!.value as string;
			expect(value).toContain("y".repeat(20)); // 头部保留
			expect(value).toContain("y".repeat(20)); // 尾部保留（前后均有）
			expect(value).toMatch(/\[\.\.\. tool result middle pruned: \d+ chars \.\.\.\]/);
		} finally {
			await cleanup();
		}
	});

	test("off（缺省）：超大输出原样穿越（逐字节等价回归）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port } = scriptedModel(TOOL_THEN_FINAL(BIG));
			const result = await runHeadless({
				prompt: "输出",
				cwd: root,
				model: port,
				tools: [fixedOutputTool(BIG)],
				sessionsRoot: join(root, "sessions"),
				out: () => {},
			} as HeadlessOptions);
			expect(result.toolResults[0]!.value).toBe(BIG);
		} finally {
			await cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// max_history_entries（window-manager 裁剪）
// ---------------------------------------------------------------------------

describe("W3-D7 headless: max_history_entries（BI-10 window-manager）", () => {
	test("on：历史条目超上限时每轮仅保留最近 N 条（旧内容被裁掉）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port, received } = scriptedModel(multiRound(4));
			await runHeadless({
				prompt: "PROMPT_SENTINEL_xyz",
				cwd: root,
				model: port,
				tools: [fixedOutputTool("ok")],
				sessionsRoot: join(root, "sessions"),
				maxRounds: 8,
				context: { maxHistoryEntries: 4 },
				out: () => {},
			} as HeadlessOptions);
			const last = received.at(-1)!.messages;
			expect(last.length).toBeLessThanOrEqual(4);
			// 初始 user 提示已在多轮后被裁剪出视窗。
			expect(JSON.stringify(last)).not.toContain("PROMPT_SENTINEL_xyz");
		} finally {
			await cleanup();
		}
	});

	test("off（缺省 / 0）：完整历史保留，初轮 user 提示仍在（现状逐字节等价）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port, received } = scriptedModel(multiRound(4));
			await runHeadless({
				prompt: "PROMPT_SENTINEL_xyz",
				cwd: root,
				model: port,
				tools: [fixedOutputTool("ok")],
				sessionsRoot: join(root, "sessions"),
				maxRounds: 8,
				out: () => {},
			} as HeadlessOptions);
			expect(JSON.stringify(received.at(-1)!.messages)).toContain("PROMPT_SENTINEL_xyz");
		} finally {
			await cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// 缺省等价（context 完全不提供）
// ---------------------------------------------------------------------------

describe("W3-D7 headless: 缺省等价（context 未提供 = 现状逐字节等价）", () => {
	test("无任何 context 选项：time/date/prune/cap 全关，行为与既有路径一致", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const raw = "x".repeat(5_000);
			const { port, received } = scriptedModel(TOOL_THEN_FINAL(raw));
			const result = await runHeadless({
				prompt: "输出",
				cwd: root,
				model: port,
				tools: [fixedOutputTool(raw)],
				sessionsRoot: join(root, "sessions"),
				out: () => {},
			} as HeadlessOptions);
			expect(result.exitCode).toBe(0);
			expect(result.toolResults[0]!.value).toBe(raw); // 未截断未修剪
			expect(systemTextOf(received[0]!.messages)).toBe(""); // 无 system 注入
			expect(JSON.stringify(received.at(-1)!.messages)).toContain("输出"); // user 提示保留
		} finally {
			await cleanup();
		}
	});
});
