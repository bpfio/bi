/**
 * BI-07.6 · /btw 旁路问答 TUI 两态验收（REPL 挂载面，agent-tui.ts）。
 *
 * 两态语义（诚实边界，绝不假冒回答）：
 * 1. 已注入 BtwService：`/btw <问题>` 走旁路子会话取回答 → 结构化上屏
 *    （屏幕转录，不落主会话 JSONL）；主对话循环零打断、主历史零污染；
 *    finalText = 旁路回答文本；BtwService.ask 被调用（触发私有 runner spawn）。
 * 2. 未装配（btwService 缺省）：`/btw <问题>` 回本地结构化提示，绝不假冒
 *    回答；finalText = ""；BtwService 不存在故 ask 不被调用。
 *
 * 全离线（脚本化模型 + 注入渲染面 + 帧探针），不触碰生产装配（bin/bi.ts）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentTuiSession } from "./agent-tui";
import type { ModelPort, ToolBinding } from "../../../core/src/cli/headless";
import type { AgentMessage, StreamEvent } from "../../../core/src/adapters/deepseek-adapter";
import { BtwService } from "../../../core/src/subagent/btw-service";
import type {
	LoopFactory,
	SubagentEventDraft,
	SubagentSessionWriter,
} from "../../../core/src/subagent/runner";
import type { SessionEntry } from "../../../core/src/session/types";
import { SessionManager } from "../../../core/src/session/manager";

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

/** 脚本化模型：单回合回放（两态测试只验证旁路，不触发主循环）。 */
function quietModel(): { port: ModelPort; calls: { calls: number } } {
	const calls = { calls: 0 };
	const port: ModelPort = {
		async *stream(input) {
			calls.calls += 1;
			void input;
			yield { type: "content_delta", delta: "主循环仍在。" } as StreamEvent;
			yield { type: "done", stopReason: "stop" } as StreamEvent;
		},
	};
	return { port, calls };
}

interface FrameSink {
	frames: Array<{ lines: readonly string[]; approvalVisible: boolean; state: string }>;
	allText(): string;
}

function frameSink(): FrameSink & { hooks: { onFrame: (lines: readonly string[], info: { approvalVisible: boolean; state: string }) => void } } {
	const self: FrameSink = {
		frames: [],
		allText() {
			return this.frames.map((f) => f.lines.join("\n")).join("\n");
		},
	};
	return {
		frames: self.frames,
		allText: self.allText.bind(self),
		hooks: {
			onFrame: (lines, info) => self.frames.push({ lines, approvalVisible: info.approvalVisible, state: info.state }),
		},
	};
}

async function makeRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "bi-tui-btw-"));
	return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/**
 * 构造真实 BtwService（stub 依赖）：loopFactory 记录调用，sessionWriter 不落盘
 * （返回占位 SessionEntry），getContextSlice 返回空上下文。ask 经私有 runner
 * spawn → loopFactory 被触发，回答文本取自 stub outcome.summary。
 */
function fakeBtwService(answer: { ok: boolean; text: string; toolCalls: number }): {
	service: BtwService;
	spawnCalls: { count: number; lastQuestion?: string };
} {
	const spawnCalls = { count: 0, lastQuestion: undefined as string | undefined };
	let seq = 0;
	const sessionWriter: SubagentSessionWriter = {
		async append(sessionId: string, draft: SubagentEventDraft): Promise<SessionEntry> {
			seq += 1;
			return {
				id: `e${seq}`,
				parentId: null,
				type: draft.type,
				payload: draft.payload,
				createdAt: 0,
				seq,
				...(draft.toolCallId !== undefined ? { toolCallId: draft.toolCallId } : {}),
				...(draft.toolName !== undefined ? { toolName: draft.toolName } : {}),
			};
		},
	};
	const loopFactory: LoopFactory = (profile, ctx) => ({
		async run() {
			spawnCalls.count += 1;
			spawnCalls.lastQuestion = ctx.prompt;
			return { ok: answer.ok, summary: answer.text, toolCalls: answer.toolCalls };
		},
	});
	const getContextSlice = () => ({ context: "main" });
	const service = new BtwService({
		loopFactory,
		sessionWriter,
		getContextSlice,
	});
	return { service, spawnCalls };
}

// ---------------------------------------------------------------------------
// 两态验收
// ---------------------------------------------------------------------------

describe("BI-07.6 · /btw 旁路问答 TUI 两态", () => {
	test("态一：注入 BtwService → 旁路取回答上屏、主会话零污染、ask 被触发", async () => {
		const { root, cleanup } = await makeRoot();
		try {
			const sink = frameSink();
			const { port } = quietModel();
			const { service, spawnCalls } = fakeBtwService({ ok: true, text: "协程是协作式多任务。", toolCalls: 2 });
			const session = new AgentTuiSession({
				model: port,
				tools: [],
				cwd: root,
				sessionsRoot: join(root, "sessions"),
				permissionMode: "auto",
				rows: 8,
				cols: 60,
				hooks: sink.hooks,
				btwService: service,
			});
			const sessionId = await session.start("btw-态一");
			const result = await session.submit("/btw 什么是协程？");

			// 旁路回答作为 finalText 返回（不入主模型回合）。
			expect(result.endedAs).toBe("finish");
			expect(result.finalText).toBe("协程是协作式多任务。");

			// 屏幕上出现结构化 [btw] 回答 + 正文 + 元信息（工具调用次数）。
			const text = sink.allText();
			expect(text).toContain("[btw] 回答");
			expect(text).toContain("协程是协作式多任务。");
			expect(text).toContain("工具调用 2 次");

			// BtwService.ask 被触发（私有 runner 派生子会话 → loopFactory 执行）。
			expect(spawnCalls.count).toBe(1);
			expect(spawnCalls.lastQuestion).toBe("什么是协程？");

			// 主会话历史零污染：/btw 不追加任何 JSONL 条目（仅 start 的 meta）。
			const loaded = await new SessionManager({ rootDir: join(root, "sessions") }).loadSession(sessionId);
			expect(loaded.entries.length).toBe(0);

			// 主对话循环未被打断：随后一次常规 submit 仍能正常收尾。
			const r2 = await session.submit("继续主任务");
			expect(r2.endedAs).toBe("finish");
			expect(r2.finalText).toBe("主循环仍在。");
		} finally {
			await cleanup();
		}
	});

	test("态二：未装配 BtwService → 结构化本地提示、绝不假冒回答、ask 不触发", async () => {
		const { root, cleanup } = await makeRoot();
		try {
			const sink = frameSink();
			const { port, calls } = quietModel();
			// 注意：未传入 btwService（缺省 undefined）。
			const session = new AgentTuiSession({
				model: port,
				tools: [],
				cwd: root,
				sessionsRoot: join(root, "sessions"),
				permissionMode: "auto",
				rows: 8,
				cols: 60,
				hooks: sink.hooks,
				// 无 btwService
			});
			const sessionId = await session.start("btw-态二");
			const result = await session.submit("/btw 这能回答吗？");

			// 诚实边界：返回空 finalText，绝不假冒回答。
			expect(result.endedAs).toBe("finish");
			expect(result.finalText).toBe("");

			// 屏幕上出现装配缺失的结构化提示。
			const text = sink.allText();
			expect(text).toContain("[btw] 旁路问答未装配");
			expect(text).not.toContain("[btw] 回答");

			// 主模型循环根本未被触发（无 BtwService，早返回）。
			expect(calls.calls).toBe(0);

			// 主会话历史零污染。
			const loaded = await new SessionManager({ rootDir: join(root, "sessions") }).loadSession(sessionId);
			expect(loaded.entries.length).toBe(0);

			// 主对话循环未被打断：随后一次常规 submit 仍能正常收尾。
			const r2 = await session.submit("继续主任务");
			expect(r2.endedAs).toBe("finish");
			expect(r2.finalText).toBe("主循环仍在。");
		} finally {
			await cleanup();
		}
	});

	test("态一（失败路径）：旁路 ok:false → 屏幕标记未完成、finalText=失败话术", async () => {
		const { root, cleanup } = await makeRoot();
		try {
			const sink = frameSink();
			const { port } = quietModel();
			const { service } = fakeBtwService({ ok: false, text: "[btw] 上下文取料失败: boom", toolCalls: 0 });
			const session = new AgentTuiSession({
				model: port,
				tools: [],
				cwd: root,
				sessionsRoot: join(root, "sessions"),
				permissionMode: "auto",
				rows: 8,
				cols: 60,
				hooks: sink.hooks,
				btwService: service,
			});
			await session.start("btw-失败");
			const result = await session.submit("/btw 会失败吗？");
			expect(result.finalText).toBe("[btw] 上下文取料失败: boom");
			const text = sink.allText();
			expect(text).toContain("[btw] 未完成");
			expect(text).toContain("[btw] 上下文取料失败: boom");
		} finally {
			await cleanup();
		}
	});
});
