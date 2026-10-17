/**
 * BI-21 工位 H —— 终局端到端全流程演练(e2e-drill)。
 *
 * 场景:宏观政策与数据审计。宏观政策公报沿"网页发布 → 双栏版面印刷 → 账表勾稽 →
 * 研报组装 → 视觉核验与交付体检 → worktree 隔离"的真实交付链走全流程。
 *
 * 铁律:
 * - 被测组件全部走真实代码路径;端口注入仅限 I/O 边界
 *   (fetch 执行器 / 视觉判定 judge / doctor 探测端口 / git 与 python 子进程真实落盘)。
 * - 指标误差 0 容忍:web/pdf/xlsx 三链产物与单一数字源(drill-data.ts)逐字比对。
 * - 演练产物只落 worktree(隔离证明),主仓库零污染;不产生任何 git commit。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { fetchWebPage } from "../tools/web-fetch";
import { runDoctor, DOCTOR_CHECK_NAMES } from "../doctor";
import { WorktreeEngine } from "../../../worktree/src/engine";
import { runVisualJudge, type JudgeIssue, type JudgeVerdict } from "../../../../presets/plugins/visualize/visual-judge";

import {
	CANONICAL_LITERALS,
	CORRUPTION,
	GAZETTE_INDICATORS,
	GAZETTE_META,
	LEDGER,
} from "./fixtures/e2e-drill/drill-data";
import {
	buildGazetteLayout,
	expectedReadingOrderLines,
} from "./fixtures/e2e-drill/gazette-layout";

// ---------------------------------------------------------------------------
// 演练环境定位
// ---------------------------------------------------------------------------

const EVAL_DIR = import.meta.dir; // packages/core/src/evals
const REPO_ROOT = resolve(EVAL_DIR, "../../..", "..");
const PDF_EXTRACT = join(REPO_ROOT, "presets/plugins/pdf/scripts/pdf_extract.py");
const XLSX_AUDIT = join(REPO_ROOT, "presets/plugins/spreadsheets/scripts/xlsx_audit.py");
const XLSX_GEN = join(EVAL_DIR, "fixtures/e2e-drill/gen_drill_xlsx.py");
const GAZETTE_HTML = join(EVAL_DIR, "fixtures/e2e-drill/gazette.html");
const WORKTREE_TASK_ID = "bi-drill"; // 分支名 = bi-task-bi-drill(演练分支)
const REPORT_REL_PATH = "docs/DRILL_RESEARCH_REPORT.md";

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** 真实子进程执行(python3 / git),全链演练不允许 mock 被测脚本。 */
async function run(cmd: readonly string[], cwd?: string): Promise<RunResult> {
	const proc = Bun.spawn([...cmd], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	return { code, stdout, stderr };
}

// ---------------------------------------------------------------------------
// 跨环节共享的演练产物(链 2/3/4 → 链 5 组装;全部来自真实代码路径输出)
// ---------------------------------------------------------------------------

const drill = {
	worktreesRoot: "",
	worktreePath: "",
	worktreeBranch: "",
	web: { title: "", markdown: "", url: "", bytes: 0 },
	pdfText: "",
	pdfJsonRaw: "",
	xlsxSheetResults: {} as Record<string, { code: number; errors: number; rows: number }>,
	xlsxCorruption: { code: -1, errors: 0, row: 0, rule: "", detail: "" },
	reportPath: "",
};

const tmpRoots: string[] = [];

afterAll(async () => {
	// 演练收尾:撤销 worktree(隔离沙箱物理清空,主仓库与工作树池零遗留)
	if (drill.worktreesRoot !== "" && drill.worktreeBranch !== "") {
		const engine = new WorktreeEngine({
			reposRoot: REPO_ROOT,
			worktreesRoot: drill.worktreesRoot,
		});
		const removed = await engine.discard(WORKTREE_TASK_ID);
		expect(removed.removed).toBe(true);
		expect(removed.branchDeleted).toBe(true);
		expect(existsSync(drill.worktreePath)).toBe(false);
	}
	while (tmpRoots.length > 0) {
		const dir = tmpRoots.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

describe("BI-21 终局演练:宏观政策与数据审计全流程", () => {
	test("链 1 — Worktree 隔离:bi-drill 演练分支创建与物理隔离", async () => {
		drill.worktreesRoot = await mkdtemp(join(tmpdir(), "bi21-drill-worktrees-"));
		tmpRoots.push(drill.worktreesRoot);
		const engine = new WorktreeEngine({
			reposRoot: REPO_ROOT,
			worktreesRoot: drill.worktreesRoot,
		});

		// 幂等预清(历次残留分支不阻塞本次演练)
		await engine.discard(WORKTREE_TASK_ID).catch(() => {});

		const info = await engine.create(WORKTREE_TASK_ID);
		expect(info.branch).toBe(`bi-task-${WORKTREE_TASK_ID}`);
		expect(info.worktreePath).toBe(join(drill.worktreesRoot, WORKTREE_TASK_ID));
		expect(info.baseCommit).toMatch(/^[0-9a-f]{40}$/);
		expect(typeof info.createdAt).toBe("string");
		drill.worktreePath = info.worktreePath;
		drill.worktreeBranch = info.branch;

		// 引擎台账与 git 物理事实一致
		const listed = await engine.list();
		expect(listed.map((w) => w.taskId)).toContain(WORKTREE_TASK_ID);

		// 隔离证明:演练探针只存在于 worktree,主仓库不可见
		const probe = join(info.worktreePath, "DRILL_PROBE.txt");
		writeFileSync(probe, `BI-21 drill probe @ ${info.baseCommit}\n`);
		expect(existsSync(probe)).toBe(true);
		expect(existsSync(join(REPO_ROOT, "DRILL_PROBE.txt"))).toBe(false);
	}, 60_000);

	test("链 2 — 政策获取:web-fetch 走 htmlToMarkdown 主内容引擎", async () => {
		const html = readFileSync(GAZETTE_HTML, "utf8");
		const calls: string[] = [];

		// 端口注入仅限 I/O 边界:伪 fetch 返回内置 HTML 公报夹具(红头/文号/指标表)
		const result = await fetchWebPage("https://gongbao.example.gov.cn/2026-87.htm", {
			fetchImpl: (input) => {
				calls.push(input);
				return Promise.resolve(
					new Response(html, {
						status: 200,
						headers: { "content-type": "text/html; charset=utf-8" },
					}),
				);
			},
		});

		expect(calls).toEqual(["https://gongbao.example.gov.cn/2026-87.htm"]);
		expect(result.truncated).toBe(false);
		expect(result.bytes).toBe(Buffer.byteLength(html));
		drill.web = {
			title: result.title ?? "",
			markdown: result.markdown ?? "",
			url: result.url,
			bytes: result.bytes,
		};

		// 主内容引擎(extractReadable → htmlToMarkdown)产出:标题/文号/指标逐字保留
		expect(drill.web.title).toBe(`${GAZETTE_META.title}_${GAZETTE_META.agency}公报`);
		for (const literal of CANONICAL_LITERALS) {
			expect(drill.web.markdown).toContain(literal);
		}
		// GFM 指标表保真:表格行逐字
		expect(drill.web.markdown).toContain(
			`| ${GAZETTE_INDICATORS.gdp.label} | ${GAZETTE_INDICATORS.gdp.current} | ${GAZETTE_INDICATORS.gdp.growthPct} |`,
		);
		// 镀铬剥离:nav/footer 整树不可残留主内容
		expect(drill.web.markdown).not.toContain("友情链接");
		expect(drill.web.markdown).not.toContain("网站标识码");
	}, 30_000);

	test("链 3 — 双栏公报抽取:pdf_extract.py 阅读序与指标逐字保真", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bi21-drill-pdf-"));
		tmpRoots.push(dir);
		const layoutPath = join(dir, "gazette-layout.json");
		writeFileSync(layoutPath, JSON.stringify(buildGazetteLayout()));

		const res = await run(
			["python3", PDF_EXTRACT, layoutPath, "--columns", "2", "--format", "json"],
			dir,
		);
		expect(res.stderr).toBe("");
		expect(res.code).toBe(0);
		drill.pdfJsonRaw = res.stdout;

		const parsed = JSON.parse(res.stdout) as {
			columns: number;
			pages: { page: number; text: string }[];
		};
		expect(parsed.columns).toBe(2);
		expect(parsed.pages).toHaveLength(1);

		const lines = parsed.pages[0]!.text.split("\n");
		drill.pdfText = parsed.pages[0]!.text;

		// 阅读序 0 误差:通栏(标题/文号/指标导语)→ 左栏 → 右栏,逐行精确比对
		expect(lines).toEqual(expectedReadingOrderLines());
		// 页眉/页脚/页码噪声剥离
		expect(drill.pdfText).not.toContain("国家统计局公报");
		expect(drill.pdfText).not.toContain("版权所有");
		expect(lines).not.toContain("3");
		// 指标数字逐字保真
		for (const literal of CANONICAL_LITERALS) {
			expect(drill.pdfText).toContain(literal);
		}
	}, 30_000);

	test("链 4 — 财报勾稽:xlsx_audit.py 三表全过 + 注错账 0 容忍定位", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bi21-drill-xlsx-"));
		tmpRoots.push(dir);
		const goodPath = join(dir, "drill-ledger.xlsx");
		const badPath = join(dir, "drill-ledger-bad.xlsx");

		// 夹具生成器与单一数字源逐字同源(夹具自身 0 误差)
		const genSource = readFileSync(XLSX_GEN, "utf8");
		for (const amount of [
			LEDGER.total.subtotal,
			LEDGER.total.rows[0]!.amount,
			LEDGER.total.rows[1]!.amount,
			GAZETTE_INDICATORS.gdp.current,
			GAZETTE_INDICATORS.gdp.prior,
			LEDGER.yoy.rows[1]!.current,
			LEDGER.yoy.rows[1]!.prior,
		]) {
			expect(genSource).toContain(String(amount));
		}

		// 正向:三张表(合计/借贷/同比)逐表审计全部 exit=0
		const gen = await run(["python3", XLSX_GEN, goodPath], dir);
		expect(gen.code).toBe(0);
		for (const sheet of ["合计", "借贷", "同比"]) {
			const res = await run(
				["python3", XLSX_AUDIT, goodPath, "--sheet", sheet, "--json"],
				dir,
			);
			expect(res.code).toBe(0);
			const parsed = JSON.parse(res.stdout) as {
				errors: number;
				rows: number;
				findings: { severity: string }[];
			};
			expect(parsed.errors).toBe(0);
			expect(parsed.findings.every((f) => f.severity !== "error")).toBe(true);
			drill.xlsxSheetResults[sheet] = {
				code: res.code,
				errors: parsed.errors,
				rows: parsed.rows,
			};
		}

		// 反向:注入一处故意错账(合计 90000 → 90050)必须 exit=1 且定位到该行
		const genBad = await run(["python3", XLSX_GEN, badPath, "--corrupt"], dir);
		expect(genBad.code).toBe(0);
		const bad = await run(
			["python3", XLSX_AUDIT, badPath, "--sheet", "合计", "--json"],
			dir,
		);
		expect(bad.code).toBe(1);
		const badParsed = JSON.parse(bad.stdout) as {
			errors: number;
			findings: { rule: string; severity: string; row: number; detail: string }[];
		};
		const errors = badParsed.findings.filter((f) => f.severity === "error");
		expect(badParsed.errors).toBe(errors.length);
		expect(errors.length).toBeGreaterThanOrEqual(1);
		const located = errors.find(
			(f) => f.rule === "total_check" && f.row === CORRUPTION.expectRow,
		);
		expect(located).toBeDefined();
		expect(located!.detail).toContain(
			`第 ${CORRUPTION.expectRow} 行第 ${CORRUPTION.expectColumn} 列合计不符`,
		);
		expect(located!.detail).toContain(String(CORRUPTION.subtotalTampered));
		drill.xlsxCorruption = {
			code: bad.code,
			errors: badParsed.errors,
			row: located!.row,
			rule: located!.rule,
			detail: located!.detail,
		};
	}, 60_000);

	test("链 5 — 研报生成:三链产物组装落盘 worktree,数字逐源 0 误差", () => {
		const { gdp, retail } = GAZETTE_INDICATORS;

		// 三链数字抽取(来自各链真实输出,非常量复读)
		const webGdp = drill.web.markdown.includes(String(gdp.current));
		const webYoy = drill.web.markdown.includes(`${gdp.growthPct}%`);
		const pdfGdp = drill.pdfText.includes(String(gdp.current));
		const pdfYoy = drill.pdfText.includes(`${gdp.growthPct}%`);
		const xlsxGdpRow = drill.xlsxSheetResults["同比"] !== undefined
			&& genContains(gdp.current) && genContains(gdp.prior);
		const totalOk = drill.xlsxSheetResults["合计"]?.errors === 0;
		const debitOk = drill.xlsxSheetResults["借贷"]?.errors === 0;
		const yoyOk = drill.xlsxSheetResults["同比"]?.errors === 0;
		// 三链 GDP/同比同源勾稽:任何一链缺字即 0 误差断言失败
		expect(webGdp && pdfGdp && xlsxGdpRow).toBe(true);
		expect(webYoy && pdfYoy).toBe(true);
		expect(totalOk && debitOk && yoyOk).toBe(true);

		const report = [
			"# 宏观政策与数据审计演练研报(BI-21 工位 H)",
			"",
			`> 数据来源:国家公报网页版(链 2)、双栏印刷版面(链 3)、勾稽账簿(链 4)。`,
			`> 演练分支:${drill.worktreeBranch};本报告落盘于演练 worktree,主仓库零污染。`,
			"",
			"## 一、政策获取(链 2 · web-fetch)",
			"",
			`- 抓取地址:${drill.web.url}`,
			`- 页面标题:${drill.web.title}`,
			`- 文号:${GAZETTE_META.docNumber}(逐字保留)`,
			`- 核心表述:初步核算,前三季度国内生产总值 ${gdp.current} 亿元,同比增长 ${gdp.growthPct}%。`,
			`- 主内容引擎:extractReadable → htmlToMarkdown,镀铬(nav/footer)剥离,${drill.web.bytes} 字节入账。`,
			"",
			"## 二、双栏版面抽取(链 3 · pdf_extract.py)",
			"",
			"阅读序(通栏 → 左栏 → 右栏)逐行比对通过,指标数字逐字保真:",
			"",
			"```text",
			drill.pdfText,
			"```",
			"",
			"## 三、勾稽审计(链 4 · xlsx_audit.py)",
			"",
			`- 合计表:税收 ${LEDGER.total.rows[0]!.amount} + 非税 ${LEDGER.total.rows[1]!.amount} = 合计 ${LEDGER.total.subtotal},审计 exit=0。`,
			`- 借贷表:∑借方 = ∑贷方 = ${LEDGER.total.subtotal},审计 exit=0。`,
			`- 同比表:(${gdp.current} − ${gdp.prior}) ÷ ${gdp.prior} = ${gdp.growthPct}%,与公报增速同源勾稽,审计 exit=0。`,
			`- 注错账反演:合计行篡改 → exit=${drill.xlsxCorruption.code},定位:`,
			`  - 规则:${drill.xlsxCorruption.rule};行号:第 ${drill.xlsxCorruption.row} 行;${drill.xlsxCorruption.detail}`,
			"",
			"## 四、三源 0 误差比对",
			"",
			"| 指标 | 网页公报 | 双栏版面 | 账簿/审计 | 结论 |",
			"| --- | --- | --- | --- | --- |",
			`| GDP 绝对额(${gdp.current} 亿元) | ${webGdp ? "一致" : "缺失"} | ${pdfGdp ? "一致" : "缺失"} | ${xlsxGdpRow ? "一致" : "缺失"} | 通过 |`,
			`| GDP 同比(${gdp.growthPct}%) | ${webYoy ? "一致" : "缺失"} | ${pdfYoy ? "一致" : "缺失"} | ${yoyOk ? "一致" : "缺失"} | 通过 |`,
			`| 社零总额(${retail.current} 亿元 / ${retail.growthPct}%) | ${drill.web.markdown.includes(String(retail.current)) ? "一致" : "缺失"} | ${drill.pdfText.includes(String(retail.current)) ? "一致" : "缺失"} | 不适用 | 通过 |`,
			"",
			"## 五、结论",
			"",
			"政策发布、版面印刷、账表勾稽三链数字完全一致;注错账被精确定位到第",
			`${drill.xlsxCorruption.row} 行,正反两向验证均符合 0 容忍要求。`,
			"",
		].join("\n");

		const docsDir = join(drill.worktreePath, "docs");
		mkdirSync(docsDir, { recursive: true });
		drill.reportPath = join(docsDir, "DRILL_RESEARCH_REPORT.md");
		writeFileSync(drill.reportPath, report);

		// 落盘证据 + 隔离:研报只在 worktree,主仓库 docs/ 不可见
		expect(existsSync(drill.reportPath)).toBe(true);
		expect(existsSync(join(REPO_ROOT, REPORT_REL_PATH))).toBe(false);
		// 研报内容含全部规范字面量与注错定位证据
		for (const literal of CANONICAL_LITERALS) {
			expect(report).toContain(literal);
		}
		expect(report).toContain(`第 ${CORRUPTION.expectRow} 行`);
		expect(report).toContain("exit=1");
	});

	test("链 6 — 核验与体检:visual-judge 纠偏重跑 + runDoctor 注入端口", async () => {
		// —— visual-judge:伪 judge 首轮判 clip → retune 加高 → 二轮通过(一次纠偏重跑) ——
		const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
		const renderHeights: number[] = [];
		let judgedRounds = 0;
		const judge = async (): Promise<JudgeVerdict> => {
			judgedRounds += 1;
			if (judgedRounds === 1) {
				const issue: JudgeIssue = {
					type: "clip",
					detail: "GDP 柱体超出画布底部",
					fixHint: "增大图表高度",
				};
				return { pass: false, issues: [issue] };
			}
			return { pass: true, issues: [] };
		};
		const vj = await runVisualJudge<{ height: number }>({
			params: { height: 400 },
			render: (p) => {
				renderHeights.push(p.height);
			},
			chartRef: "#gdp-quarterly-bar",
			capture: { capture: () => Promise.resolve(PNG) },
			judge: { judge },
			retune: (p, issues) =>
				issues.some((i) => i.type === "clip") ? { height: p.height + 120 } : p,
			maxRounds: 2,
		});
		expect(vj.status).toBe("passed");
		expect(vj.rounds).toBe(2);
		expect(vj.history.map((h) => h.pass)).toEqual([false, true]);
		expect(vj.history[0]!.issues[0]!.type).toBe("clip");
		// VisualJudgeReport.params 合约为 unknown(参数类型运行时擦除),窄化后断言终态纠偏参数
		expect((vj.params as { height: number }).height).toBe(520);
		expect(renderHeights).toEqual([400, 520]);
		expect(vj.issues).toEqual([]);

		// 反向:judge 持续 fail 且超限 → 必须升级 failed(核验门不放过坏图)
		const bad = await runVisualJudge<{ height: number }>({
			params: { height: 400 },
			render: () => {},
			chartRef: "#bad-chart",
			capture: { capture: () => Promise.resolve(PNG) },
			judge: {
				judge: () =>
					Promise.resolve({
						pass: false,
						issues: [{ type: "overlap", detail: "图例遮挡柱体", fixHint: "图例右移" }],
					}),
			},
			maxRounds: 1,
		});
		expect(bad.status).toBe("failed");
		expect(bad.issues).toHaveLength(1);
		expect(bad.issues[0]!.type).toBe("overlap");

		// —— runDoctor(注入端口,零真实 IO):四项全绿为交付前置 ——
		const now = Date.now();
		const healthy = await runDoctor({
			ports: {
				endpointUrl: "https://open.example.com",
				timeoutMs: 200,
				configDir: tmpdir(),
				now: () => now,
				probeNetwork: () =>
					Promise.resolve({ reachable: true, detail: "TCP 443 可达(注入)" }),
				readCredentials: () =>
					Promise.resolve({ provider: "zhipu", expiresAtMs: now + 3_600_000 }),
				exec: (cmd) =>
					Promise.resolve(
						cmd.includes("--version")
							? { code: 0, stdout: "Python 3.14.4", stderr: "" }
							: { code: 0, stdout: "", stderr: "" },
					),
				configDirWritable: () =>
					Promise.resolve({ ok: true, detail: "配置目录可写(注入)" }),
			},
		});
		expect(healthy.allOk).toBe(true);
		expect(healthy.checks).toHaveLength(4);
		expect(healthy.checks.map((c) => c.name)).toEqual([
			DOCTOR_CHECK_NAMES.network,
			DOCTOR_CHECK_NAMES.credentials,
			DOCTOR_CHECK_NAMES.python,
			DOCTOR_CHECK_NAMES.workspace,
		]);

		// 反向:网络探测端口不通 → allOk=false 且带修复建议(体检门拦下带病交付)
		const degraded = await runDoctor({
			ports: {
				endpointUrl: "https://open.example.com",
				timeoutMs: 200,
				configDir: tmpdir(),
				now: () => now,
				probeNetwork: () =>
					Promise.resolve({ reachable: false, detail: "TCP 443 不可达(注入)" }),
				readCredentials: () => Promise.resolve(null),
				exec: () => Promise.resolve({ code: 0, stdout: "Python 3.14.4", stderr: "" }),
				configDirWritable: () => Promise.resolve({ ok: true, detail: "可写(注入)" }),
			},
		});
		expect(degraded.allOk).toBe(false);
		const net = degraded.checks.find((c) => c.name === DOCTOR_CHECK_NAMES.network);
		expect(net?.ok).toBe(false);
		expect(typeof net?.fix).toBe("string");
	}, 30_000);
});

/** 夹具生成器源码是否含指定数字字面量(账簿夹具与单一数字源同源校验)。 */
function genContains(value: number): boolean {
	return readFileSync(XLSX_GEN, "utf8").includes(String(value));
}
