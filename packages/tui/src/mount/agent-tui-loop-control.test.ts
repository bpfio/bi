/**
 * 虚账接线 A —— TUI 侧 [loop_control] 装配验收。
 *
 * 覆盖：
 * - max_tool_calls_per_turn > 0 → 单回合超限调用不执行，回填结构化拒绝；
 * - 缺省（不提供）→ 全部调用执行（零行为差）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentTuiSession } from "./agent-tui";
import type { ModelPort, ToolBinding } from "../../../core/src/cli/headless";
import type { StreamEvent } from "../../../core/src/adapters/deepseek-adapter";

/** 脚本化模型：首回合两个工具调用，次回合收尾（按回合回放，回合边界清晰）。 */
function twoCallsModel(): ModelPort {
	const rounds: StreamEvent[][] = [
		[
			{ type: "tool_call_delta", index: 0, id: "c1", name: "echo", argumentsDelta: '{"text":"一"}' } as StreamEvent,
			{ type: "tool_call_delta", index: 1, id: "c2", name: "echo", argumentsDelta: '{"text":"二"}' } as StreamEvent,
			{ type: "done", stopReason: "tool_use" } as StreamEvent,
		],
		[
			{ type: "content_delta", delta: "完成。" } as StreamEvent,
			{ type: "done", stopReason: "stop" } as StreamEvent,
		],
	];
	let cursor = 0;
	return {
		async *stream() {
			const round = rounds[cursor];
			cursor += 1;
			if (round === undefined) return;
			for (const event of round) yield event;
		},
	};
}

function echoBinding(executed: string[]): ToolBinding {
	return {
		definition: {
			name: "echo",
			description: "回显",
			inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
		},
		readOnly: true,
		execute: async (args) => {
			const text = String((args as { text?: string }).text ?? "");
			executed.push(text);
			return `echo:${text}`;
		},
	};
}

async function makeRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "bi-tui-loopctl-"));
	return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("TUI · [loop_control] max_tool_calls_per_turn", () => {
	test("生效：超限调用不执行，回填结构化拒绝", async () => {
		const { root, cleanup } = await makeRoot();
		try {
			const executed: string[] = [];
			const session = new AgentTuiSession({
				model: twoCallsModel(),
				tools: [echoBinding(executed)],
				cwd: root,
				sessionsRoot: join(root, "sessions"),
				permissionMode: "auto",
				rows: 8,
				cols: 60,
				maxToolCallsPerTurn: 1,
			});
			await session.start("上限");
			const result = await session.submit("跑两个工具");
			expect(result.endedAs).toBe("finish");
			expect(executed).toEqual(["一"]);
			expect(result.toolResults[0]).toMatchObject({ ok: true });
			expect(result.toolResults[1]).toMatchObject({ ok: false });
			expect(result.toolResults[1]?.error).toContain("loop-control: 单轮工具调用超过上限 1");
		} finally {
			await cleanup();
		}
	});

	test("缺省关：不提供上限 → 全部调用执行", async () => {
		const { root, cleanup } = await makeRoot();
		try {
			const executed: string[] = [];
			const session = new AgentTuiSession({
				model: twoCallsModel(),
				tools: [echoBinding(executed)],
				cwd: root,
				sessionsRoot: join(root, "sessions"),
				permissionMode: "auto",
				rows: 8,
				cols: 60,
			});
			await session.start("无上限");
			const result = await session.submit("跑两个工具");
			expect(result.endedAs).toBe("finish");
			expect(executed).toEqual(["一", "二"]);
			expect(result.toolResults.every((r) => r.ok)).toBe(true);
		} finally {
			await cleanup();
		}
	});
});
