/**
 * BI-20 接线 —— diff 审查门入口（/diff）验收。
 *
 * 全离线：diff 文本经 readDiff 替身注入（不跑真 git），审查确认经 confirm
 * 替身注入；断言渲染上屏文本与门禁裁决。
 */
import { describe, expect, test } from "bun:test";

import { parseDiffArgs, runDiffGate, stripAnsi } from "./diff-gate";

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

describe("BI-20 · /diff 参数解析", () => {
	test("空参数 → 工作区未暂存 diff", () => {
		expect(parseDiffArgs("")).toEqual({ ok: true, args: ["diff"] });
		expect(parseDiffArgs("   ")).toEqual({ ok: true, args: ["diff"] });
	});

	test("--staged / --cached → 暂存区 diff", () => {
		expect(parseDiffArgs("--staged")).toEqual({ ok: true, args: ["diff", "--staged"] });
		expect(parseDiffArgs("--cached")).toEqual({ ok: true, args: ["diff", "--staged"] });
	});

	test("非法参数 → 用法回执", () => {
		const result = parseDiffArgs("--wat");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("/diff [--staged]");
	});
});

describe("BI-20 · /diff 渲染入口", () => {
	test("diff 文本 → 解析 + 渲染上屏（去 ANSI 的纯文本）", async () => {
		const result = await runDiffGate({
			cwd: "/tmp",
			ports: {
				readDiff: async () => SAMPLE_DIFF,
				confirm: async () => true,
			},
		});
		expect(result.model.files).toHaveLength(1);
		expect(result.model.additions).toBe(1);
		expect(result.model.deletions).toBe(1);
		// 上屏文本：汇总行 + 文件头 + hunk 头 + 增删行 + 裁决行
		expect(result.text).toContain("[diff] 工作区变更：1 个文件，+1 -1");
		expect(result.text).toContain("[M] packages/tui/src/hud.ts (+1 -1)");
		expect(result.text).toContain("@@ -1,3 +1,3 @@");
		expect(result.text).toContain("-旧行");
		expect(result.text).toContain("+新行");
		expect(result.text).toContain("审查门: 通过");
		// 上屏文本无裸 ANSI 转义序列
		expect(result.text).not.toContain("\u001b[");
	});

	test("渲染行带 ANSI（终端直出用），上屏文本去色后逐行同源", async () => {
		const result = await runDiffGate({
			cwd: "/tmp",
			ports: { readDiff: async () => SAMPLE_DIFF, confirm: async () => true },
		});
		expect(result.view.some((line) => line.includes("\u001b["))).toBe(true);
		expect(result.view.map((line) => stripAnsi(line))).toEqual(
			result.text.split("\n").slice(1, -1),
		);
	});

	test("审查门裁决：确认回调否决 → 拒绝 + 理由", async () => {
		const result = await runDiffGate({
			cwd: "/tmp",
			ports: { readDiff: async () => SAMPLE_DIFF, confirm: async () => false },
		});
		expect(result.decision.decision).toBe("reject");
		expect(result.text).toContain("审查门: 拒绝");
	});

	test("审查门裁决：未注册确认回调 → fail-closed 拒绝（如实回报，不冒充通过）", async () => {
		const result = await runDiffGate({
			cwd: "/tmp",
			ports: { readDiff: async () => SAMPLE_DIFF },
		});
		expect(result.decision.decision).toBe("reject");
		expect(result.text).toContain("审查门: 拒绝");
		expect(result.text).toContain("未注册审查回调");
	});

	test("空 diff：无可审内容 → 门禁放行且视图为空", async () => {
		const result = await runDiffGate({
			cwd: "/tmp",
			ports: { readDiff: async () => "" },
		});
		expect(result.model.files).toHaveLength(0);
		expect(result.decision.decision).toBe("approve");
		expect(result.text).toContain("[diff] 工作区变更：0 个文件，+0 -0");
		expect(result.text).toContain("审查门: 通过");
	});

	test("git 执行面注入：readDiff 缺省时经注入的 git runner 取 diff", async () => {
		const calls: Array<{ args: readonly string[]; cwd: string }> = [];
		const result = await runDiffGate({
			cwd: "/work",
			git: async (args, cwd) => {
				calls.push({ args, cwd });
				return { code: 0, stdout: SAMPLE_DIFF, stderr: "" };
			},
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]!.args).toEqual(["diff"]);
		expect(calls[0]!.cwd).toBe("/work");
		expect(result.model.additions).toBe(1);
	});

	test("git 执行面注入：非零退出码 → 空 diff（不伪造内容）", async () => {
		const result = await runDiffGate({
			cwd: "/work",
			git: async () => ({ code: 129, stdout: "", stderr: "not a git repository" }),
		});
		expect(result.model.files).toHaveLength(0);
		expect(result.text).toContain("[diff] 工作区变更：0 个文件，+0 -0");
	});
});
