/**
 * BI-20 接线 —— diff 审查门的 REPL 入口（/diff）。
 *
 * 器官：tui/src/diff-view.ts（parseDiff / renderDiff / presentDiff，零改动复用）。
 * 入口选择：REPL 斜杠命令 `/diff`——对工作区跑 `git diff` → parseDiff 解析 →
 * renderDiff 渲染 → presentDiff 过审查门。与「edit/write 工具执行前 diff 预览」
 * 相比，本入口不侵入工具执行/审批回路（侵入面最小）；后者留备案注释（见文末）。
 *
 * 诚实边界：
 * - 审查确认回调未注册时，presentDiff 按 fail-closed 语义判「拒绝」并给出
 *   理由（本卡如实透出，不冒充已审通过）；宿主（bin/bi.ts REPL 装配面）注入
 *   confirm 端口 → 会话确认浮层真交互 y/n 裁决（FIX-B F5）；
 * - diff 文本取自 `git diff`（未暂存改动）；暂存区用 `--staged`；
 * - 上屏文本去 ANSI（转录面为纯文本渲染，裸转义序列会漏字）。
 */

import {
	parseDiff,
	presentDiff,
	renderDiff,
	type DiffGateDecision,
	type DiffGateSummary,
	type DiffModel,
} from "../diff-view";
import { spawn as nodeSpawn } from "node:child_process";

/** git 执行结果。 */
export interface GitRunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** git 执行面（注入面；测试全离屏注入，不真跑 git）。 */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitRunResult>;

/** 缺省 git 执行面：node:child_process.spawn（管道收 stdout/stderr）。 */
export const defaultGitRunner: GitRunner = (args, cwd) =>
	new Promise<GitRunResult>((resolve) => {
		const child = nodeSpawn("git", [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error: Error) => {
			resolve({ code: 127, stdout, stderr: stderr + error.message });
		});
		child.on("close", (code: number | null) => {
			resolve({ code: code ?? 0, stdout, stderr });
		});
	});

/** 审查门端口（注入面）。 */
export interface DiffGatePorts {
	/** 取 diff 文本（缺省 = 工作区 `git diff`；返回空串视为无改动）。 */
	readonly readDiff?: (cwd: string) => Promise<string>;
	/**
	 * 审查确认回调：拿到渲染行与汇总，返回 true=放行 / false=否决。
	 * 未注册 → presentDiff 按 fail-closed 判拒绝（见文件头诚实边界）。
	 */
	readonly confirm?: (view: readonly string[], summary: DiffGateSummary) => boolean | Promise<boolean>;
}

/** /diff 命令参数解析结果。 */
export type DiffArgsResult =
	| { readonly ok: true; readonly args: readonly string[] }
	| { readonly ok: false; readonly error: string };

/** /diff 参数：空 = 工作区未暂存改动；--staged/--cached = 暂存区。 */
export function parseDiffArgs(rest: string): DiffArgsResult {
	const trimmed = rest.trim();
	if (trimmed === "") return { ok: true, args: ["diff"] };
	if (trimmed === "--staged" || trimmed === "--cached") {
		return { ok: true, args: ["diff", "--staged"] };
	}
	return { ok: false, error: `用法: /diff [--staged]（收到: ${trimmed}）` };
}

/** ANSI 转义序列剥离（上屏转录面为纯文本渲染）。 */
export function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/** /diff 执行结果。 */
export interface DiffCommandResult {
	/** 解析后的 diff 模型。 */
	readonly model: DiffModel;
	/** 渲染行（带 ANSI，终端直出用）。 */
	readonly view: readonly string[];
	/** 汇总（文件数/增删行）。 */
	readonly summary: DiffGateSummary;
	/** 审查门裁决。 */
	readonly decision: DiffGateDecision;
	/** 上屏文本（去 ANSI：汇总 + diff 视图 + 裁决）。 */
	readonly text: string;
}

/** 裁决行（中文标签；理由缺省不列）。 */
function decisionLine(decision: DiffGateDecision): string {
	const label = decision.decision === "approve" ? "通过" : "拒绝";
	return decision.reason !== undefined
		? `审查门: ${label}（${decision.reason}）`
		: `审查门: ${label}`;
}

/**
 * 跑一次 diff 审查门：取 diff 文本 → parseDiff → renderDiff → presentDiff。
 * git 执行面与审查确认均为注入面（测试替身注入，不外呼）。
 */
export async function runDiffGate(options: {
	readonly cwd: string;
	readonly ports?: DiffGatePorts;
	readonly git?: GitRunner;
}): Promise<DiffCommandResult> {
	const ports = options.ports ?? {};
	const readDiff =
		ports.readDiff ??
		(async (cwd: string): Promise<string> => {
			const git = options.git ?? defaultGitRunner;
			const run = await git(["diff"], cwd);
			return run.code === 0 ? run.stdout : "";
		});
	const text = await readDiff(options.cwd);
	const model = parseDiff(text);
	const view = renderDiff(model);
	const decision = await presentDiff(model, {
		...(ports.confirm !== undefined ? { confirm: ports.confirm } : {}),
	});
	const gateSummary: DiffGateSummary = {
		files: model.files.length,
		additions: model.additions,
		deletions: model.deletions,
	};
	const head =
		`[diff] 工作区变更：${gateSummary.files} 个文件，+${gateSummary.additions} -${gateSummary.deletions}`;
	const body = view.map((line) => stripAnsi(line));
	return {
		model,
		view,
		summary: gateSummary,
		decision,
		text: [head, ...body, decisionLine(decision)].join("\n"),
	};
}
