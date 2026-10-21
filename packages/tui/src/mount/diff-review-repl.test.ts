/**
 * FIX-B F5 —— /diff 审查门真交互验收（REPL 主回路层）。
 *
 * 全离线：diff 文本经 readDiff 替身注入（不跑真 git）；按键经 KeyStream 注入
 * （不触 stdin/raw mode）。
 *
 * 覆盖：
 * 1. /diff 提交 → 会话进入 awaiting-confirm（确认浮层在栈顶）→ 浮层行集含真实
 *    diff 内容（用户看到的是真实差异）；
 * 2. y = 批准 → 门禁通过（转录含「审查门: 通过」）；
 * 3. n = 拒绝 → 门禁拒绝（转录含「审查门: 拒绝」）；
 * 4. Esc = 拒绝（fail-closed）；
 * 5. 裁决后会话态复原 idle（浮层撤场，不残留模态）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentTuiSession } from "./agent-tui";
import { KeyStream, runRepl } from "./repl";
import { runDiffGate } from "./diff-gate";
import { DEFAULT_KEYBINDINGS } from "./keybindings";
import type { ModelPort } from "../../../core/src/cli/headless";
import type { StreamEvent } from "../../../core/src/adapters/deepseek-adapter";
import type { ParsedKey } from "../engine/diff-renderer";

/** 样例 unified diff（一个文件、一增一删）。 */
const SAMPLE_DIFF = [
	"diff --git a/packages/tui/src/hud.ts b/packages/tui/src/hud.ts",
	"index 1111111..2222222 100644",
	"--- a/packages/tui/src/hud.ts",
	"+++ b/packages/tui/src/hud.ts",
	"@@ -1,3 +1,3 @@",
	" 上下文行",
	"-旧行",
	"+新行",
].join("\n");

/** 键流小工具：可见文本 → char 键序列。 */
function text(value: string): ParsedKey[] {
	return [...value].map((ch): ParsedKey => ({ kind: "char", char: ch }));
}
const enter: ParsedKey = { kind: "enter" };
const ctrlD: ParsedKey = { kind: "ctrl", char: "d" };

/** 轮询等待（超时即败）。 */
async function until(cond: () => boolean): Promise<void> {
	for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
	expect(cond()).toBe(true);
}

/** 静默模型（/diff 走本地回执，不进模型回合——本测试里模型不应被调用）。 */
function unusedModel(): ModelPort {
	return {
		async *stream(): AsyncGenerator<StreamEvent> {
			yield { type: "content_delta", delta: "不应到达" };
			yield { type: "done", stopReason: "stop" };
		},
	};
}

interface Harness {
	session: AgentTuiSession;
	stream: KeyStream;
	done: Promise<{ submittedLines: number }>;
	frames: Array<{ lines: readonly string[]; state: string }>;
	cleanup: () => Promise<void>;
}

/** 装配 REPL（会话 slashCommand = 真 diff 审查门，confirm 端口接会话确认浮层）。 */
async function harness(): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), "bi-diff-review-"));
	const frames: Array<{ lines: readonly string[]; state: string }> = [];
	const session = new AgentTuiSession({
		model: unusedModel(),
		tools: [],
		cwd: root,
		sessionsRoot: join(root, "sessions"),
		rows: 12,
		cols: 72,
		keybindings: DEFAULT_KEYBINDINGS,
		hooks: {
			onFrame: (lines, info) => frames.push({ lines, state: info.state }),
		},
		slashCommand: async (): Promise<string> => {
			const result = await runDiffGate({
				cwd: root,
				ports: {
					readDiff: async () => SAMPLE_DIFF,
					confirm: (view, summary) => session.confirmReview(view, summary),
				},
			});
			return result.text;
		},
	});
	const stream = new KeyStream();
	const done = runRepl({ session, keys: stream });
	return {
		session,
		stream,
		done,
		frames,
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}

/** 转录里的 system 条目文本（斜杠命令回执上屏面）。 */
function systemTexts(session: AgentTuiSession): string {
	return session.projection.entries
		.filter((entry) => entry.kind === "system")
		.map((entry) => entry.text)
		.join("\n");
}

/**
 * 提交 "/diff"（真实键序）：候选菜单在 Enter 时先接受补全（草稿 "/diff "），
 * 第二次 Enter 才提交——与真人输入同序（BI-27.4 候选菜单语义）。
 */
function pushDiffCommand(stream: KeyStream): void {
	for (const key of [...text("/diff"), enter, enter]) stream.push(key);
}

describe("FIX-B F5 · /diff 审查门真交互（REPL 主回路）", () => {
	test("y = 批准：门禁通过 + 用户看到真实 diff 内容", async () => {
		const h = await harness();
		try {
			pushDiffCommand(h.stream);
			await until(() => h.session.state === "awaiting-confirm"); // 确认浮层在栈顶
			h.stream.push({ kind: "char", char: "y" });
			await until(() => h.session.state === "idle"); // 裁决后态复原
			h.stream.push(ctrlD);
			const result = await h.done;

			expect(result.submittedLines).toBe(1);
			const said = systemTexts(h.session);
			expect(said).toContain("[diff] 工作区变更：1 个文件，+1 -1");
			expect(said).toContain("[M] packages/tui/src/hud.ts (+1 -1)");
			expect(said).toContain("-旧行");
			expect(said).toContain("+新行");
			expect(said).toContain("审查门: 通过");
			// 浮层在场时屏幕帧含真实 diff 内容（用户裁决前即见差异）
			const overlayFrame = h.frames.find((f) => f.state === "awaiting-confirm");
			expect(overlayFrame).toBeDefined();
			expect(overlayFrame!.lines.join("\n")).toContain("[M] packages/tui/src/hud.ts (+1 -1)");
			expect(overlayFrame!.lines.join("\n")).toContain("+新行");
			expect(overlayFrame!.lines.join("\n")).toContain("[y] 批准");
		} finally {
			await h.cleanup();
		}
	});

	test("n = 拒绝：门禁拒绝（fail-closed）", async () => {
		const h = await harness();
		try {
			pushDiffCommand(h.stream);
			await until(() => h.session.state === "awaiting-confirm");
			h.stream.push({ kind: "char", char: "n" });
			await until(() => h.session.state === "idle");
			h.stream.push(ctrlD);
			await h.done;

			const said = systemTexts(h.session);
			expect(said).toContain("审查门: 拒绝");
			expect(said).not.toContain("审查门: 通过");
		} finally {
			await h.cleanup();
		}
	});

	test("Esc = 拒绝（结构性取消键）", async () => {
		const h = await harness();
		try {
			pushDiffCommand(h.stream);
			await until(() => h.session.state === "awaiting-confirm");
			h.stream.push({ kind: "esc" });
			await until(() => h.session.state === "idle");
			h.stream.push(ctrlD);
			await h.done;

			expect(systemTexts(h.session)).toContain("审查门: 拒绝");
		} finally {
			await h.cleanup();
		}
	});

	test("浮层在栈顶时按键不落编辑器（模态：y 不进草稿）", async () => {
		const h = await harness();
		try {
			pushDiffCommand(h.stream);
			await until(() => h.session.state === "awaiting-confirm");
			h.stream.push({ kind: "char", char: "z" }); // 非裁决键：浮层候裁决
			await new Promise((r) => setTimeout(r, 20));
			expect(h.session.state).toBe("awaiting-confirm");
			h.stream.push({ kind: "char", char: "y" });
			await until(() => h.session.state === "idle");
			h.stream.push(ctrlD);
			await h.done;
			expect(systemTexts(h.session)).toContain("审查门: 通过");
		} finally {
			await h.cleanup();
		}
	});
});
