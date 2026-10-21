/**
 * 虚账接线 A —— TUI 侧 [identity] 横幅身份行验收。
 *
 * 覆盖：
 * - config 声明 identity.name → 横幅以 identity.name 替代产品名；
 * - config 声明 identity.tagline → 横幅出副题行；
 * - 未声明（缺省产品名 + 空 tagline）→ 横幅零变化（只落现状单行操作提示）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentTuiSession } from "./agent-tui";
import type { ModelPort } from "../../../core/src/cli/headless";
import type { StreamEvent } from "../../../core/src/adapters/deepseek-adapter";
import { DEFAULT_IDENTITY_NAME } from "../../../core/src/config/schema";

/** 脚本化模型：单回合自然收尾（横幅断言不需要模型行为，仅占位）。 */
function idleModel(): ModelPort {
	return {
		async *stream() {
			yield { type: "content_delta", delta: "你好。" } as StreamEvent;
			yield { type: "done", stopReason: "stop" } as StreamEvent;
		},
	};
}

interface FrameSink {
	frames: Array<{ lines: readonly string[] }>;
	hooks: { onFrame: (lines: readonly string[]) => void };
}

function frameSink(): FrameSink {
	const frames: Array<{ lines: readonly string[] }> = [];
	return { frames, hooks: { onFrame: (lines) => frames.push({ lines: [...lines] }) } };
}

async function makeRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "bi-tui-identity-"));
	return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("TUI · [identity] 横幅身份行", () => {
	test("声明 name / tagline → 横幅出产品名行 + 副题行", async () => {
		const { root, cleanup } = await makeRoot();
		try {
			const sink = frameSink();
			const session = new AgentTuiSession({
				model: idleModel(),
				tools: [],
				cwd: root,
				sessionsRoot: join(root, "sessions"),
				permissionMode: "auto",
				rows: 8,
				cols: 60,
				hooks: sink.hooks,
				identity: {
					name: "稽核员",
					tagline: "勾稽差额归零",
					system_prompt_path: "",
					extra_instructions: "",
				},
			});
			await session.start("横幅");
			session.showBanner();
			const lines = sink.frames.at(-1)!.lines;
			expect(lines.some((l) => l.includes("稽核员"))).toBe(true);
			expect(lines.some((l) => l.includes("勾稽差额归零"))).toBe(true);
			// 现状操作提示行仍在
			expect(lines.some((l) => l.includes("指令与键位"))).toBe(true);
		} finally {
			await cleanup();
		}
	});

	test("未声明（缺省产品名 + 空 tagline）→ 横幅零变化（只落现状单行）", async () => {
		const { root, cleanup } = await makeRoot();
		try {
			const sink = frameSink();
			const session = new AgentTuiSession({
				model: idleModel(),
				tools: [],
				cwd: root,
				sessionsRoot: join(root, "sessions"),
				permissionMode: "auto",
				rows: 8,
				cols: 60,
				hooks: sink.hooks,
				identity: {
					name: DEFAULT_IDENTITY_NAME,
					tagline: "",
					system_prompt_path: "",
					extra_instructions: "",
				},
			});
			await session.start("横幅");
			session.showBanner();
			const lines = sink.frames.at(-1)!.lines;
			expect(lines.some((l) => l.includes("指令与键位"))).toBe(true);
			// 未声明 = 不出身份行（缺省产品名不出现在横幅上）
			expect(lines.some((l) => l.includes(`[system] ${DEFAULT_IDENTITY_NAME}`))).toBe(false);
		} finally {
			await cleanup();
		}
	});

	test("未提供 identity → 横幅零变化（现状单行）", async () => {
		const { root, cleanup } = await makeRoot();
		try {
			const sink = frameSink();
			const session = new AgentTuiSession({
				model: idleModel(),
				tools: [],
				cwd: root,
				sessionsRoot: join(root, "sessions"),
				permissionMode: "auto",
				rows: 8,
				cols: 60,
				hooks: sink.hooks,
			});
			await session.start("横幅");
			session.showBanner();
			const lines = sink.frames.at(-1)!.lines;
			expect(lines.some((l) => l.includes("指令与键位"))).toBe(true);
		} finally {
			await cleanup();
		}
	});
});
