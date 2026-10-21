/**
 * FIX-B F5 —— diff 审查门交互确认浮层验收（真交互 y/n 裁决）。
 *
 * 全离线：视图行注入（不跑 git），按键经组件 handleKey 注入（不触 stdin）。
 * 覆盖：
 * 1. 行集构造：汇总头 + diff 视图（去 ANSI）+ 裁决提示行；超屏高显式标注省略；
 * 2. y = 批准；n = 拒绝；Esc = 拒绝（fail-closed）；其余键不消费（浮层候裁决）。
 */
import { describe, expect, test } from "bun:test";

import { DiffReviewOverlay, buildReviewLines, DIFF_REVIEW_HINT } from "./diff-review";
import { DEFAULT_KEYBINDINGS } from "./keybindings";
import { VirtualTerminal } from "../engine/virtual-terminal";
import type { ParsedKey } from "../engine/diff-renderer";
import type { DiffGateSummary } from "../diff-view";

const SUMMARY: DiffGateSummary = { files: 1, additions: 1, deletions: 1 };

/** 带 ANSI 的渲染行（与 renderDiff 产物同形）。 */
const VIEW = [
	"\u001b[36m[M] packages/tui/src/hud.ts (+1 -1)\u001b[0m",
	"\u001b[36m@@ -1,3 +1,3 @@\u001b[0m",
	"\u001b[31m-旧行\u001b[0m",
	"\u001b[32m+新行\u001b[0m",
];

function charKey(ch: string): ParsedKey {
	return { kind: "char", char: ch };
}

describe("FIX-B F5 · 审查门浮层行集", () => {
	test("行集 = 汇总头 + diff 视图（去 ANSI）+ 裁决提示行", () => {
		const lines = buildReviewLines(VIEW, SUMMARY, 20);
		expect(lines[0]).toContain("diff 审查门");
		expect(lines[0]).toContain("1 个文件");
		expect(lines[0]).toContain("+1 -1");
		// diff 真实内容上屏（ANSI 已剥离）
		expect(lines.join("\n")).toContain("[M] packages/tui/src/hud.ts (+1 -1)");
		expect(lines.join("\n")).toContain("-旧行");
		expect(lines.join("\n")).toContain("+新行");
		expect(lines.join("\n")).not.toContain("\u001b[");
		// 末行恒为裁决提示
		expect(lines.at(-1)).toBe(DIFF_REVIEW_HINT);
	});

	test("超屏高：取头部并显式标注省略行数（不静默截断）", () => {
		const many = Array.from({ length: 50 }, (_, i) => `+第${i}行`);
		const lines = buildReviewLines(many, SUMMARY, 10);
		expect(lines.length).toBeLessThanOrEqual(10);
		expect(lines.at(-1)).toBe(DIFF_REVIEW_HINT);
		expect(lines.join("\n")).toContain("行未显示");
		// 省略注记给出真实剩余行数
		const shown = many.filter((line) => lines.includes(line)).length;
		expect(lines.join("\n")).toContain(`另有 ${many.length - shown} 行未显示`);
	});
});

describe("FIX-B F5 · 审查门浮层按键裁决", () => {
	test("y = 批准", async () => {
		const overlay = new DiffReviewOverlay(VIEW, SUMMARY, () => undefined, DEFAULT_KEYBINDINGS, 20);
		overlay.handleKey(charKey("y"));
		expect(await overlay.wait()).toBe("approve");
	});

	test("n = 拒绝", async () => {
		const overlay = new DiffReviewOverlay(VIEW, SUMMARY, () => undefined, DEFAULT_KEYBINDINGS, 20);
		overlay.handleKey(charKey("n"));
		expect(await overlay.wait()).toBe("reject");
	});

	test("Esc = 拒绝（fail-closed：结构性取消键）", async () => {
		const overlay = new DiffReviewOverlay(VIEW, SUMMARY, () => undefined, DEFAULT_KEYBINDINGS, 20);
		overlay.handleKey({ kind: "esc" });
		expect(await overlay.wait()).toBe("reject");
	});

	test("其余键不消费：浮层候裁决（不猜意图）", async () => {
		let settled = false;
		const overlay = new DiffReviewOverlay(
			VIEW,
			SUMMARY,
			() => undefined,
			DEFAULT_KEYBINDINGS,
			20,
		);
		void overlay.wait().then(() => {
			settled = true;
		});
		overlay.handleKey(charKey("x"));
		overlay.handleKey({ kind: "enter" });
		await Promise.resolve();
		expect(settled).toBe(false);
		// 明确裁决后收场
		overlay.handleKey(charKey("y"));
		expect(await overlay.wait()).toBe("approve");
	});

	test("render 把行集落进离屏网格（首行 = 汇总头，末行 = 裁决提示）", () => {
		const term = new VirtualTerminal(10, 60);
		const overlay = new DiffReviewOverlay(VIEW, SUMMARY, () => undefined, DEFAULT_KEYBINDINGS, 20);
		overlay.render(term);
		const text = term.toString();
		expect(text).toContain("diff 审查门");
		expect(text).toContain("-旧行");
		expect(text).toContain(DIFF_REVIEW_HINT);
	});
});
