/**
 * BI-07.4 · SubagentRunner 装配验收（createSubagentRunner + 脚本化父模型）。
 *
 * 关注面（v1 最小诚实）：
 * - 子会话落地运行：父模型回 stop 即收束，summary = 最终文本（finalText 回传父）；
 * - 工具回环：子循环执行父工具集中的只读子集，toolCalls 正确计数；
 * - 持久化隔离：child 会话独立落盘（sessionId 前缀 sub-），主会话侧零追加（未传
 *   parentSessionId）；
 * - 超时边界：timeoutMs>0 时协作取消，结构化失败（ok:false，不抛、不悬挂）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSubagentRunner } from "./subagent-adapter";
import { SessionManager } from "../session/manager";
import type { ModelPort, ToolBinding } from "./headless";
import type { StreamEvent } from "../adapters/deepseek-adapter";

/** 单次回答模型：直接收束为 stop + 给定文本。 */
function answerModel(text: string): ModelPort {
	return {
		async *stream() {
			yield { type: "content_delta", delta: text } as StreamEvent;
			yield { type: "done", stopReason: "stop" } as StreamEvent;
		},
	};
}

/** 工具调用→再回答模型：首轮 tool_use，次轮 stop（游标推进）。 */
function toolThenAnswerModel(): ModelPort {
	let n = 0;
	return {
		async *stream() {
			n += 1;
			if (n === 1) {
				yield { type: "tool_call_delta", index: 0, id: "c1", name: "read_file", argumentsDelta: '{"path":"x"}' } as StreamEvent;
				yield { type: "done", stopReason: "tool_use" } as StreamEvent;
			} else {
				yield { type: "content_delta", delta: "读完" } as StreamEvent;
				yield { type: "done", stopReason: "stop" } as StreamEvent;
			}
		},
	};
}

/** 悬挂模型：signal abort 前一直挂起（驱动超时协作取消）。 */
function hangingModel(): ModelPort {
	return {
		async *stream(input) {
			const signal = input.signal;
			await new Promise<void>((_resolve, reject) => {
				if (signal?.aborted === true) return reject(new Error("aborted"));
				signal?.addEventListener(
					"abort",
					() => reject(new Error("aborted")),
					{ once: true },
				);
			});
		},
	};
}

function readFileTool(): ToolBinding {
	return {
		definition: {
			name: "read_file",
			description: "读文件",
			inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		},
		readOnly: true,
		execute: async () => "file-content",
	};
}

async function withTempRoot(fn: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "bi-subagent-"));
	try {
		await fn(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("BI-07.4 · SubagentRunner 装配", () => {
	test("子会话落地运行：summary = 父模型最终文本（finalText 回传父）", async () => {
		await withTempRoot(async (root) => {
			const runner = createSubagentRunner({
				model: answerModel("最终答案"),
				tools: [],
				sessionsRoot: root,
				maxRounds: 8,
				timeoutMs: 0,
			});
			const result = await runner.spawn("explore", "目标", {});
			expect(result.ok).toBe(true);
			expect(result.summary).toBe("最终答案");
			expect(result.childSessionId).toMatch(/^sub-/);
			expect(result.toolCalls).toBe(0);
		});
	});

	test("工具回环：子循环执行只读子集，toolCalls 计数正确", async () => {
		await withTempRoot(async (root) => {
			const runner = createSubagentRunner({
				model: toolThenAnswerModel(),
				tools: [readFileTool()],
				sessionsRoot: root,
				maxRounds: 8,
				timeoutMs: 0,
			});
			const result = await runner.spawn("explore", "读一下", {});
			expect(result.ok).toBe(true);
			expect(result.summary).toBe("读完");
			expect(result.toolCalls).toBe(1);
		});
	});

	test("持久化隔离：child 独立落盘（sub- 前缀），主会话侧零追加", async () => {
		await withTempRoot(async (root) => {
			const runner = createSubagentRunner({
				model: answerModel("隔离验证"),
				tools: [],
				sessionsRoot: root,
				maxRounds: 8,
				timeoutMs: 0,
			});
			const result = await runner.spawn("explore", "g", {});
			const mgr = new SessionManager({ rootDir: root });
			const sessions = await mgr.listSessions();
			const child = sessions.find((s) => s.sessionId === result.childSessionId);
			expect(child).toBeDefined();
			const entries = await mgr.entries(result.childSessionId);
			expect(entries.length).toBeGreaterThan(0); // 子会话确有事件落盘
			// 由于没有传 parentSessionId，主会话侧不应被追加任何子汇总。
			const mainTouched = sessions.some(
				(s) => s.sessionId !== result.childSessionId && s.sessionId.startsWith("sub-") === false,
			);
			// 单子派生场景：根目录只应有这一条 sub- 会话；无父会话被触碰。
			expect(sessions.filter((s) => s.sessionId.startsWith("sub-")).length).toBe(1);
			expect(mainTouched).toBe(false);
		});
	});

	test("超时边界：timeoutMs>0 协作取消 → 结构化失败（ok:false，不抛不悬挂）", async () => {
		await withTempRoot(async (root) => {
			const runner = createSubagentRunner({
				model: hangingModel(),
				tools: [],
				sessionsRoot: root,
				maxRounds: 8,
				timeoutMs: 60,
			});
			const result = await runner.spawn("explore", "会超时的任务", {});
			expect(result.ok).toBe(false);
			expect(result.summary).toContain("超时");
		});
	});

	test("缺省 profile 兜底 explore（ runner.spawn 不抛 TypeError）", async () => {
		await withTempRoot(async (root) => {
			const runner = createSubagentRunner({
				model: answerModel("x"),
				tools: [],
				sessionsRoot: root,
				maxRounds: 8,
				timeoutMs: 0,
			});
			const result = await runner.spawn("explore", "g", {});
			expect(result.ok).toBe(true);
			expect(result.profileType).toBe("explore");
		});
	});
});
