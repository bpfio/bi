/**
 * W3-D7（BI-05.3）· main 分发装配面验收。
 *
 * config [context] → runHeadless 的开关下发经 RunBiOptions.config 注入面做确定性
 * e2e（model 替身 + 已装载配置注入，零磁盘零网络）；并回归"未声明 [context] =
 * 跳过 context 下发 = 现状行为逐字节等价"。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBi } from "./main";
import type { ModelPort, ToolBinding } from "./headless";
import type { AgentMessage, StreamEvent } from "../adapters/deepseek-adapter";
import { createDefaultConfig, type BiConfig } from "../config/schema";

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

function fixedOutputTool(output: unknown): ToolBinding {
	return {
		definition: { name: "emit", description: "输出固定内容", inputSchema: { type: "object", properties: {} } },
		readOnly: true,
		execute: async () => output,
	};
}

function toolThenFinal(): StreamEvent[][] {
	return [
		[
			{ type: "tool_call_delta", index: 0, id: "call_1", name: "emit", argumentsDelta: "{}" },
			{ type: "done", stopReason: "tool_use" },
		],
		[{ type: "content_delta", delta: "完成。" }, { type: "done", stopReason: "stop" }],
	];
}

function configWith(patch: (config: BiConfig) => void): BiConfig {
	const config = createDefaultConfig();
	patch(config);
	return config;
}

async function makeWorkspace(): Promise<{ root: string; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "bi-w3d7-main-"));
	return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function systemTextOf(messages: readonly AgentMessage[]): string {
	const sys = messages.find((m) => m.role === "system");
	return typeof sys?.content === "string" ? sys.content : "";
}

describe("W3-D7 main: [context] time_context → runHeadless", () => {
	test("on：config 声明的 time_context 经主分发生效（模型收到含当前时钟的 system 消息）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port, received } = scriptedModel([[{ type: "content_delta", delta: "hi" }, { type: "done", stopReason: "stop" }]]);
			const code = await runBi(["--prompt", "hi"], {
				model: port,
				out: () => {},
				err: () => {},
				config: configWith((c) => {
					c.context = { time_context: true, date_change_sensor: false, tool_result_prune: false, max_history_entries: 0, timezone: "Asia/Shanghai" };
				}),
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [fixedOutputTool("ok")] },
			});
			expect(code).toBe(0);
			expect(systemTextOf(received[0]!.messages)).toContain("Current time:");
		} finally {
			await cleanup();
		}
	});

	test("缺省（未声明 [context]）：不向模型注入任何时钟 system 消息（现状逐字节等价）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port, received } = scriptedModel([[{ type: "content_delta", delta: "hi" }, { type: "done", stopReason: "stop" }]]);
			const code = await runBi(["--prompt", "hi"], {
				model: port,
				out: () => {},
				err: () => {},
				config: configWith((c) => {
					c.tools.output_limit_bytes = 0;
				}),
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [fixedOutputTool("ok")] },
			});
			expect(code).toBe(0);
			expect(systemTextOf(received[0]!.messages)).toBe("");
		} finally {
			await cleanup();
		}
	});

	test("on：max_history_entries 经主分发生效（历史条目超上限被裁剪）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port, received } = scriptedModel([
				[{ type: "tool_call_delta", index: 0, id: "c0", name: "emit", argumentsDelta: "{}" }, { type: "done", stopReason: "tool_use" }],
				[{ type: "tool_call_delta", index: 0, id: "c1", name: "emit", argumentsDelta: "{}" }, { type: "done", stopReason: "tool_use" }],
				[{ type: "tool_call_delta", index: 0, id: "c2", name: "emit", argumentsDelta: "{}" }, { type: "done", stopReason: "tool_use" }],
				[{ type: "content_delta", delta: "完成" }, { type: "done", stopReason: "stop" }],
			]);
			const code = await runBi(["--prompt", "PROMPT_SENTINEL_main"], {
				model: port,
				out: () => {},
				err: () => {},
				config: configWith((c) => {
					c.context = { time_context: false, date_change_sensor: false, tool_result_prune: false, max_history_entries: 4, timezone: "Asia/Shanghai" };
				}),
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [fixedOutputTool("ok")], maxRounds: 8 },
			});
			expect(code).toBe(0);
			expect(received.at(-1)!.messages.length).toBeLessThanOrEqual(4);
			expect(JSON.stringify(received.at(-1)!.messages)).not.toContain("PROMPT_SENTINEL_main");
		} finally {
			await cleanup();
		}
	});
});
