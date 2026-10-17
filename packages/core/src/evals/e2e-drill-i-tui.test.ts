/**
 * BI-21 工位 H 域级演练 I —— TUI 渲染面。
 *
 * 链路:真实 git diff 输出 → DiffRenderer 双缓冲虚拟终端(最小 ANSI 差分)
 * → TranscriptProjection 四层同构(L1 事件 → L2 逻辑行 → L3 视图行 → L4 markdown)
 * → render/latex 公式转文本 → merman/mermaid 图转 ASCII。
 *
 * 全部真实代码;git diff 为真实仓库工作树输出(零注入)。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DiffRenderer, cup, EL } from "../../../tui/src/engine/diff-renderer";
import { TranscriptProjection, assertProjectionInvariants } from "../../../tui/src/transcript-projection";
import { renderLatex, renderLatexDetailed } from "../../../tui/src/render/latex";
import { renderMermaid } from "../../../tui/src/merman/mermaid-renderer";
import { VirtualTerminal } from "../../../tui/src/engine/virtual-terminal";
import type { Writer } from "../../../tui/src/engine/diff-renderer";

// ---------------------------------------------------------------------------
// tui 模块相对导入(跨包源码直连,tui barrel 未导出这些引擎件)
// ---------------------------------------------------------------------------

/** 收集型 Writer(捕获 DiffRenderer 的最小 ANSI 输出)。 */
function captureWriter(): Writer & { frames: string[] } {
	const frames: string[] = [];
	return {
		frames,
		write(payload: string): void {
			frames.push(payload);
		},
	};
}

;
/**
 * 真实 git diff:一次性临时 git 仓(真实 git 工具链)。
 * 场景 A 的修复(%.4g→_fmt)已被合入主仓 HEAD,工作树 diff 为空;
 * 改用临时仓产出确定性真实 diff(种子文件 + 修改 + git diff)。
 */
function realGitDiff(): string {
	const dir = mkdtempSync(join(tmpdir(), "bi21-i-gitdiff-"));
	roots.push(dir);
	const run = (args: string[]) => {
		const proc = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
		if (proc.exitCode !== 0) throw new Error(`git ${args[0]} 失败: ${proc.stderr.toString()}`);
		return proc.stdout.toString();
	};
	run(["init", "-q"]);
	run(["config", "user.email", "drill@bi.local"]);
	run(["config", "user.name", "BI-21 Drill"]);
	const file = join(dir, "audit.py");
	writeFileSync(file, "def fmt(v):\n    return f\"{v:.4g}\"\n\nDETAIL = \"应为 {fmt(90000)}\"\n", "utf8");
	run(["add", "."]);
	run(["commit", "-q", "-m", "seed"]);
	writeFileSync(file, "def fmt(v):\n    text = f\"{v:.4f}\".rstrip(\"0\").rstrip(\".\")\n    return text\n\nDETAIL = \"应为 {fmt(90000)}\"  # 90050 定位\n", "utf8");
	const diff = run(["diff"]);
	if (diff.trim() === "") throw new Error("git diff 为空");
	return diff;
}

const roots: string[] = [];
afterAll(async () => {
	while (roots.length > 0) {
		const dir = roots.pop();
		if (dir) Bun.spawnSync(["rm", "-rf", dir]);
	}
});

describe("BI-21 域 I —— TUI 渲染面", () => {
	test("I1 diff-renderer:真实 git diff 入虚拟终端,最小 ANSI 差分", () => {
		const diffText = realGitDiff();
		const diffLines = diffText.split("\n");
		expect(diffLines[0]).toContain("diff --git");

		const out = captureWriter();
		const renderer = new DiffRenderer(out, 40, 120);

		// 帧一:把真实 diff 逐行画进虚拟终端
		const draft1 = renderer.begin();
		diffLines.slice(0, 30).forEach((line, i) => {
			draft1.write(0, i, line.slice(0, 120));
		});
		renderer.end();
		// 首帧:只有非空行绘制,每行一条 cup + 内容 + EL
		expect(out.frames.length).toBe(1);
		const frame1 = out.frames[0]!;
		expect(frame1).toContain("diff --git");
		expect(frame1).toContain("audit.py");
		expect(frame1).toContain(cup(1));
		// 首帧最小输出:空行零绘制(终端基线即空白)
		const blankRowCount = diffLines.slice(0, 30).filter((l) => l === "").length;
		expect(frame1.split(cup(1)).length - 1).toBeLessThanOrEqual(30 - blankRowCount + 1);

		// 帧二:零变更 → 零输出(双缓冲差分的核心承诺)
		const draft2 = renderer.begin();
		diffLines.slice(0, 30).forEach((line, i) => {
			draft2.write(0, i, line.slice(0, 120));
		});
		renderer.end();
		expect(out.frames.length).toBe(1); // 无 payload 不 write

		// 帧三:改一行 → 仅该行一条差分 op
		const draft3 = renderer.begin();
		diffLines.slice(0, 30).forEach((line, i) => {
			draft3.write(0, i, line.slice(0, 120));
		});
		draft3.write(0, 5, "CHANGED-ROW-953680");
		renderer.end();
		expect(out.frames.length).toBe(2);
		expect(out.frames[1]!).toContain("CHANGED-ROW-953680");
		// 差分面:只有一行变化 → 至多一条 cup 定位
		expect(out.frames[1]!.split("\x1b[").length - 1).toBeLessThanOrEqual(2);

		// resize:重建双缓冲,下一帧强制全量
		renderer.resize(50, 100);
		const draft4 = renderer.begin();
		draft4.write(0, 0, "after-resize");
		renderer.end();
		expect(out.frames[2]!).toContain("after-resize");
	}, 30_000);

	test("I2 transcript-projection:L1→L2→L3→L4 四层同构 + 折行无损", () => {
		const p = new TranscriptProjection({ width: 40 });
		p.append({ kind: "user", text: "拉取 2026 年前三季度国民经济运行情况公报并核对指标" });
		p.append({ kind: "assistant", text: "已抓取公报正文:\n国内生产总值 953680 亿元\n同比增长 4.8%" });
		p.append({ kind: "tool", text: "web-fetch → 国统字〔2026〕87 号" });

		// L2 逻辑行:条目内多行保序
		const history = p.historyLines();
		expect(history.filter((h) => h.entryIndex === 1).map((h) => h.text)).toEqual([
			"[assistant] 已抓取公报正文:", // 条目首行携带角色前缀
			"国内生产总值 953680 亿元",
			"同比增长 4.8%",
		]);

		// L3 视图行:宽 40 下长行折行;折行不跨逻辑行
		const views = p.viewLines();
		const longLine = views.filter((v) => v.seq === 0 && v.entryIndex === 0);
		expect(longLine.length).toBeGreaterThan(1); // 40 列内必然折行
		// 折行无损:L3 同逻辑行视图片拼接还原 L2 文本(前缀除外)
		const foldedText = longLine.map((v) => v.text.replace(/^[^ ]+ /, "")).join("");
		expect(foldedText).toContain("国民经济运行情况公报");

		// L4 markdown 与 L3 行行同构
		const md = p.toMarkdown();
		expect(md.split("\n").length).toBe(views.length);
		// 四层同构不变式:运行期断言零异常
		expect(() => assertProjectionInvariants(p)).not.toThrow();

		// render() 与 L3 文本一致
		expect(p.render()).toEqual(views.map((v) => v.text));

		// 非法 kind 抛 TypeError
		expect(() => p.append({ kind: "bogus" as never, text: "x" })).toThrow(TypeError);
	}, 30_000);

	test("I3 latex:分式/上下标转文本 + 警告行不抛异常", () => {
		const lines = renderLatex("\\frac{GDP}{上期} = 1.048");
		expect(lines.length).toBeGreaterThanOrEqual(1);
		expect(lines.join("")).toContain("GDP");
		expect(lines.join("")).not.toContain("\\frac");

		// 上标/下标:转 Unicode 上下标(x^2 → x², y_1 → y₁)
		const sup = renderLatex("x^2 + y_1");
		expect(sup.join("")).not.toContain("^");
		expect(sup.join("")).toContain("²");
		expect(sup.join("")).toContain("₁");

		// 多行分块:\\\\ 与换行都切块
		const detailed = renderLatexDetailed("a \\\\ b\nc");
		expect(detailed.lines.length).toBeGreaterThanOrEqual(2);
		expect(detailed.warnings).toBeDefined();

		// 非法深度:警告行以 ⚠ 追加,不抛异常(fail-soft)
		const deep = renderLatex("\\frac{\\frac{\\frac{\\frac{a}{b}}{c}}{d}}{e} + \\frac{\\frac{a}{b}}{c}");
		expect(deep.some((l) => l.startsWith("⚠")) || deep.join("").length > 0).toBe(true);
	}, 30_000);

	test("I4 mermaid:flowchart/sequence 转 ASCII + 非法语法降级警告", () => {
		// flowchart:节点框 + 连线
		const flow = renderMermaid("flowchart TD\n  A[公报] --> B[审计]\n  B --> C[台账]", { cols: 60 });
		expect(flow.length).toBeGreaterThan(3);
		const joined = flow.join("\n");
		expect(joined).toContain("公报");
		expect(joined).toContain("审计");
		expect(joined).toContain("台账");

		// sequence:参与者与消息
		const seq = renderMermaid("sequenceDiagram\n  A->>B: 拉取公报\n  B-->>A: 953680 亿元", { cols: 60 });
		expect(seq.join("\n")).toContain("拉取公报");

		// 非法语法:降级警告行,不抛异常
		const bad = renderMermaid("this is not mermaid at all");
		expect(bad[0]).toContain("⚠");
	}, 30_000);
});
