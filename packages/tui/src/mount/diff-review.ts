/**
 * FIX-B F5 —— diff 审查门交互确认浮层（/diff 真交互 y/n 裁决）。
 *
 * 器官复用：diff-view.ts 的 renderDiff 视图行（带 ANSI）+ diff-gate.ts 的
 * stripAnsi（上屏转录面为纯文本渲染，裸转义序列会漏字）。
 *
 * 交互合约：
 * - y = 批准（放行本次变更）；n / Esc = 拒绝（fail-closed，与审批浮层同语义）；
 * - 其余按键不消费（模态浮层惯例：等待用户明确裁决，不猜意图）；
 * - 浮层行集 = 汇总头 + diff 视图（去 ANSI）+ 裁决提示行；超屏高时取头部并
 *   显式标注省略行数（完整 diff 在裁决后随命令回执上屏转录，不静默截断）。
 *
 * 键位：复用键位注册表的 approval.allow / approval.deny（默认 y / n），
 * 与权限审批浮层同源——本版本不新增动作名（键位表零变化）。
 */

import type { VirtualTerminal } from "../engine/virtual-terminal";
import type { ParsedKey } from "../engine/diff-renderer";
import type { Component } from "../components/tui-app";
import { actionForKey, type Keybindings } from "./keybindings";
import { stripAnsi } from "./diff-gate";
import type { DiffGateSummary } from "../diff-view";

/** 审查门裁决（approve=放行 / reject=否决）。 */
export type DiffReviewVerdict = "approve" | "reject";

/** 裁决提示行（y/n/Esc 语义与审批浮层一致）。 */
export const DIFF_REVIEW_HINT = "[y] 批准   [n] 拒绝   [Esc] 拒绝";

/**
 * 构造浮层行集（render 与帧探针共用的单一来源）。
 * 总行数钳到 maxRows；裁决提示行恒为末行（超屏高时取 diff 头部 + 省略注记）。
 */
export function buildReviewLines(
	view: readonly string[],
	summary: DiffGateSummary,
	maxRows: number,
): string[] {
	const head = `── diff 审查门：${summary.files} 个文件 · +${summary.additions} -${summary.deletions} ──`;
	const body = view.map((line) => stripAnsi(line));
	// 行预算：头 1 行 + 省略注 1 行 + 提示 1 行 = 3 行固定开销。
	const budget = Math.max(1, maxRows - 3);
	const shown = body.slice(0, budget);
	const omitted = body.length - shown.length;
	const lines: string[] = [head, ...shown];
	if (omitted > 0) lines.push(`… 另有 ${omitted} 行未显示（完整 diff 见裁决后转录）`);
	const room = Math.max(1, maxRows - 1);
	return [...lines.slice(0, room), DIFF_REVIEW_HINT];
}

/**
 * 审查门浮层：渲染 diff 视图 + y/n 提示，裁决经 wait() 返回。
 * 栈顶拦截按键直至裁决（模态语义，与审批浮层同路）。
 */
export class DiffReviewOverlay implements Component {
	#resolve!: (verdict: DiffReviewVerdict) => void;
	readonly #promise: Promise<DiffReviewVerdict>;
	readonly #lines: readonly string[];
	#settled = false;

	constructor(
		view: readonly string[],
		summary: DiffGateSummary,
		private readonly onChange: () => void,
		private readonly bindings: Keybindings,
		maxRows = 20,
	) {
		this.#lines = buildReviewLines(view, summary, maxRows);
		this.#promise = new Promise<DiffReviewVerdict>((resolve) => {
			this.#resolve = resolve;
		});
	}

	/** 等待用户裁决（approve / reject）。 */
	wait(): Promise<DiffReviewVerdict> {
		return this.#promise;
	}

	/** 浮层行集（render 与帧探针共用的单一来源）。 */
	lines(): readonly string[] {
		return this.#lines;
	}

	render(term: VirtualTerminal): void {
		this.#lines.forEach((line, i) => term.write(0, i, line));
	}

	handleKey(key: ParsedKey): void {
		const action = actionForKey(this.bindings, key);
		let verdict: DiffReviewVerdict | undefined;
		if (action === "approval.allow") verdict = "approve";
		else if (action === "approval.deny") verdict = "reject";
		else if (key.kind === "esc") verdict = "reject"; // 结构性取消键，保留硬编码兜底
		if (verdict === undefined || this.#settled) return;
		this.#settled = true;
		this.onChange();
		this.#resolve(verdict);
	}
}
