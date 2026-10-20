/**
 * 虚账清偿波次 1 · headless 上下文管线接线验收（BI-08.2 image-offload + BI-10 AutoCompactor）。
 *
 * 两器官交付时未接运行时；本文件验收接线面：
 * - image-offload：context.imageOffload=true 时每回合发送前对历史跑一次
 *   offloadOldestImages（结构不变式：消息数/块 entry 数不变）；缺省关 = 零变动。
 * - AutoCompactor：context.autoCompactor=true 时按 80% 水位静默紧缩；summarizer
 *   用注入的 model 端口包装（零真实模型调用，脚本化替身）；缺省关 = 现状条目数
 *   门禁路径，完全不进。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHeadless, type ModelPort, type ToolBinding } from "./headless";
import type { AgentMessage, StreamEvent, TextBlock } from "../adapters/deepseek-adapter";
import { IMAGE_OFFLOAD_PLACEHOLDER } from "../context/image-offload";

/** 脚本化模型端口：按回合回放事件序列，捕获收到的消息流供接线断言。 */
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

/**
 * 带历史注入的脚本化端口：第 injectAt 回合流式开始前把注入器作用到**活**消息
 * 数组上（现管线工具结果恒为字符串、会话为单 user 轮，无天然多模态/多轮入口，
 * 测试经活引用注入后由真实管线消费——image 块模拟多模态历史，user 轮模拟
 * AutoCompactor 器官预期的多轮会话形态）。
 */
function injectingModel(
	rounds: StreamEvent[][],
	injectAt: number,
	inject: (messages: AgentMessage[]) => void,
): {
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
			const live = input.messages as AgentMessage[];
			if (cursor === injectAt) inject(live);
			received.push({ messages: [...live], tools: input.tools.map((t) => t.name) });
			for (const event of round) yield event;
		},
	};
	return { port, received };
}

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

const TOOL_ROUND = (id: string): StreamEvent[] => [
	{ type: "tool_call_delta", index: 0, id, name: "emit", argumentsDelta: "{}" },
	{ type: "done", stopReason: "tool_use" },
];

/** 多轮 tool_use 序列：前 rounds-1 轮 tool_use，末轮 final。 */
function multiRound(rounds: number): StreamEvent[][] {
	const out: StreamEvent[][] = [];
	for (let i = 0; i < rounds; i++) {
		out.push(i < rounds - 1 ? TOOL_ROUND(`call_${i}`) : FINAL_ROUND);
	}
	return out;
}

async function makeWorkspace(): Promise<{ root: string; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "bi-wiring-hl-"));
	return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// BI-08.2 image-offload
// ---------------------------------------------------------------------------

const IMG_DATA = "QUJDREVG"; // base64("ABCDEF")

/** 向活消息数组注入一条含 text + image 块的 assistant 历史（模拟多模态历史）。 */
function injectImageHistory(messages: AgentMessage[]): void {
	messages.push({
		role: "assistant",
		content: [
			{ type: "text", text: "早前看过的图" },
			{ type: "image", source: { type: "base64", data: IMG_DATA } } as unknown as TextBlock,
		],
	});
}

describe("虚账清偿 W1: image-offload（BI-08.2 headless 接线）", () => {
	test("on：发送前对含 image 块历史生效一次（占位符替换、结构不变式保持）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port, received } = injectingModel([TOOL_ROUND("call_1"), FINAL_ROUND], 1, injectImageHistory);
			const result = await runHeadless({
				prompt: "看图",
				cwd: root,
				model: port,
				tools: [fixedOutputTool("ok")],
				sessionsRoot: join(root, "sessions"),
				context: { imageOffload: true },
				out: () => {},
			});
			expect(result.exitCode).toBe(0);
			const last = received.at(-1)!.messages;
			const serialized = JSON.stringify(last);
			// image 负载已卸载，占位符出现且恰一次（重入幂等）。
			expect(serialized).not.toContain(IMG_DATA);
			expect(serialized.split(IMAGE_OFFLOAD_PLACEHOLDER).length - 1).toBe(1);
			// 结构不变式：消息数量不变；被卸载消息的 content entry 数不变。
			expect(last.length).toBe(4);
			const injected = last[1]!;
			expect(Array.isArray(injected.content)).toBe(true);
			const blocks = injected.content as unknown as Array<Record<string, unknown>>;
			expect(blocks.length).toBe(2);
			const slot = blocks[1]!;
			expect(slot["type"]).toBe("text");
			expect(slot["text"]).toBe(IMAGE_OFFLOAD_PLACEHOLDER);
			expect(slot["offloaded"]).toBe(true);
			// 非 image 块原样保留。
			expect(blocks[0]!["text"]).toBe("早前看过的图");
		} finally {
			await cleanup();
		}
	});

	test("off（缺省）：image 块原样穿越，零变动（现状逐字节等价回归）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port, received } = injectingModel([TOOL_ROUND("call_1"), FINAL_ROUND], 1, injectImageHistory);
			const result = await runHeadless({
				prompt: "看图",
				cwd: root,
				model: port,
				tools: [fixedOutputTool("ok")],
				sessionsRoot: join(root, "sessions"),
				out: () => {},
			});
			expect(result.exitCode).toBe(0);
			const serialized = JSON.stringify(received.at(-1)!.messages);
			expect(serialized).toContain(IMG_DATA);
			expect(serialized).not.toContain(IMAGE_OFFLOAD_PLACEHOLDER);
		} finally {
			await cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// BI-10 AutoCompactor
// ---------------------------------------------------------------------------

/** 视窗分母 1000（reserve=floor/4=250，有效窗 750）：4016 字符 prompt 估算 ≥1001 token → 超水位。 */
const OVERWATER_PROMPT = `PROMPT_SENTINEL_${"x".repeat(4000)}`;

/**
 * 向活历史注入两个 user 轮（紧随初轮 prompt）：AutoCompactor 器官要求 ≥2 个
 * user 轮且保留起点 >0 才紧缩（器官裁定），headless 单 user 轮形态下属"轮数
 * 不足 → null"静默；多轮形态用注入模拟。
 */
function injectUserTurns(messages: AgentMessage[]): void {
	messages.splice(1, 0, { role: "user", content: "第二用户轮: 继续" }, { role: "user", content: "第三用户轮: 再继续" });
}

describe("虚账清偿 W1: AutoCompactor（BI-10 headless 接线）", () => {
	test("on + 超水位：经 model 端口总结历史并紧缩（占位符进请求，旧历史出视窗）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			// 回合脚本：tu → tu → 紧缩 summarizer 单轮总结 → final。
			// 第 2 回合注入两个 user 轮 → 第 3 回合起器官 user 轮门禁满足并紧缩。
			const { port, received } = injectingModel(
				[
					TOOL_ROUND("call_1"),
					TOOL_ROUND("call_2"),
					[{ type: "content_delta", delta: "固定摘要文本" }, { type: "done", stopReason: "stop" }],
					FINAL_ROUND,
				],
				2,
				injectUserTurns,
			);
			const result = await runHeadless({
				prompt: OVERWATER_PROMPT,
				cwd: root,
				model: port,
				tools: [fixedOutputTool("ok")],
				sessionsRoot: join(root, "sessions"),
				maxRounds: 8,
				context: { autoCompactor: true, autoCompactorWindowTokens: 1000 },
				out: () => {},
			});
			expect(result.exitCode).toBe(0);
			expect(result.finalText).toBe("完成。");
			// received: r1 请求、r2 请求、summarizer 请求、r3(final) 请求。
			expect(received.length).toBe(4);
			// summarizer 请求 = 单轮 user 总结 prompt，携带被截断的旧历史（零真实模型）。
			const sumReq = received[2]!;
			expect(sumReq.tools).toEqual([]);
			expect(sumReq.messages.length).toBe(1);
			expect(sumReq.messages[0]!.role).toBe("user");
			expect(JSON.stringify(sumReq.messages)).toContain("PROMPT_SENTINEL");
			// 紧缩后请求：[compacted] 占位在前，旧历史（初轮 prompt）已出视窗。
			const last = received.at(-1)!.messages;
			expect(JSON.stringify(last)).toContain("[compacted] 固定摘要文本");
			expect(JSON.stringify(last)).not.toContain("PROMPT_SENTINEL");
			// 紧缩后的 tool 配对仍完整（保留轮次原引用穿越）。
			const lastSerialized = JSON.stringify(last);
			expect(lastSerialized).toContain("call_2");
		} finally {
			await cleanup();
		}
	});

	test("on + summarizer 失败：不炸会话，走器官熔断面（结构化降级继续会话）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port, received } = injectingModel(
				[
					TOOL_ROUND("call_1"),
					TOOL_ROUND("call_2"),
					[{ type: "error", error: { code: "server", message: "总结模型爆炸" } }],
					FINAL_ROUND,
				],
				2,
				injectUserTurns,
			);
			const result = await runHeadless({
				prompt: OVERWATER_PROMPT,
				cwd: root,
				model: port,
				tools: [fixedOutputTool("ok")],
				sessionsRoot: join(root, "sessions"),
				maxRounds: 8,
				context: { autoCompactor: true, autoCompactorWindowTokens: 1000 },
				out: () => {},
			});
			// summarizer 抛错 → 器官 catch（lastFailure）→ 返回 null → 会话照常收尾。
			expect(result.exitCode).toBe(0);
			expect(received.length).toBe(4);
			const last = received.at(-1)!.messages;
			expect(JSON.stringify(last)).not.toContain("[compacted]");
			expect(JSON.stringify(last)).toContain("PROMPT_SENTINEL");
		} finally {
			await cleanup();
		}
	});

	test("on + 水位未超：零开销静默路径（无 summarizer 调用、无紧缩）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port, received } = scriptedModel([TOOL_ROUND("call_1"), FINAL_ROUND]);
			const result = await runHeadless({
				prompt: "PROMPT_SENTINEL_short",
				cwd: root,
				model: port,
				tools: [fixedOutputTool("ok")],
				sessionsRoot: join(root, "sessions"),
				maxRounds: 8,
				context: { autoCompactor: true, autoCompactorWindowTokens: 1000 },
				out: () => {},
			});
			expect(result.exitCode).toBe(0);
			// 仅两回合请求，无 summarizer 插入调用。
			expect(received.length).toBe(2);
			expect(JSON.stringify(received.at(-1)!.messages)).toContain("PROMPT_SENTINEL_short");
			expect(JSON.stringify(received.at(-1)!.messages)).not.toContain("[compacted]");
		} finally {
			await cleanup();
		}
	});

	test("off（缺省）：超水位条件也不紧缩，完整历史保留（现状逐字节等价回归）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port, received } = scriptedModel(multiRound(3));
			const result = await runHeadless({
				prompt: OVERWATER_PROMPT,
				cwd: root,
				model: port,
				tools: [fixedOutputTool("ok")],
				sessionsRoot: join(root, "sessions"),
				maxRounds: 8,
				out: () => {},
			});
			expect(result.exitCode).toBe(0);
			// 三回合请求，无 summarizer 插入调用。
			expect(received.length).toBe(3);
			expect(JSON.stringify(received.at(-1)!.messages)).toContain("PROMPT_SENTINEL");
			expect(JSON.stringify(received.at(-1)!.messages)).not.toContain("[compacted]");
		} finally {
			await cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// 双开关缺省组合回归
// ---------------------------------------------------------------------------

describe("虚账清偿 W1: 双开关缺省（零行为回归）", () => {
	test("image 与紧缩均缺省关：超水位 + image 历史下行为与现状一致", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port, received } = injectingModel([TOOL_ROUND("call_1"), FINAL_ROUND], 1, injectImageHistory);
			const result = await runHeadless({
				prompt: OVERWATER_PROMPT,
				cwd: root,
				model: port,
				tools: [fixedOutputTool("ok")],
				sessionsRoot: join(root, "sessions"),
				maxRounds: 8,
				out: () => {},
			});
			expect(result.exitCode).toBe(0);
			const serialized = JSON.stringify(received.at(-1)!.messages);
			expect(serialized).toContain(IMG_DATA); // image 未卸载
			expect(serialized).toContain("PROMPT_SENTINEL"); // 历史未紧缩
			expect(serialized).not.toContain(IMAGE_OFFLOAD_PLACEHOLDER);
			expect(serialized).not.toContain("[compacted]");
		} finally {
			await cleanup();
		}
	});
});
