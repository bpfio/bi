/**
 * BI-21.3 — 评测报告看板与基准防回退。
 *
 * - renderReport(report): 多维量化看板（纯文本版）。
 * - renderMarkdown(report): 同构 markdown 版（数据同源、字段同构）。
 *   两者数据源均为 SuiteReport（eval-harness.runSuite 产出；测试可手工构造
 *   固定时长的 fixture 做快照对齐）。渲染一律从 report.cases 现算派生，
 *   report.stats 仅供程序化消费 —— 避免双源分歧。
 * - compareRuns(baseline, current): 基线防回退 —— 识别回退与改进。
 *   判定规则（按 caseId 对齐）：
 *   - regressions: 基线通过 → 当前失败；基线有 → 当前缺失（覆盖丢失）。
 *   - improvements: 基线失败 → 当前通过；仅当前有（新增覆盖）。
 */

import { computeTimingStats, computeToolCallFreq } from "./eval-harness";
import type { CaseResult, SuiteReport, TimingStats } from "./eval-harness";

export interface CompareRunsResult {
  regressions: string[];
  improvements: string[];
}

const TOP_TOOLS_SHOWN = 10;

/** 多维量化看板（纯文本）：通过率、分布（min/median/p95/max）、逐案例、工具频次 top、失败差距明细。 */
export function renderReport(report: SuiteReport): string {
  const cases = report.cases;
  const passed = cases.filter((c) => c.passed).length;
  const failed = cases.length - passed;
  const passRate = cases.length === 0 ? "n/a" : `${((passed / cases.length) * 100).toFixed(1)}%`;
  const turnStats = computeTimingStats(cases.map((c) => c.turns));
  const durStats = computeTimingStats(cases.map((c) => c.durationMs));
  const failures = cases.filter((c) => !c.passed);

  const lines: string[] = [];
  lines.push(`== Eval Suite: ${report.suiteId} ==`);
  lines.push(
    `Cases: ${cases.length} total | ${passed} passed | ${failed} failed | pass rate ${passRate}`,
  );
  lines.push(`Wall time: ${report.totalMs}ms`);
  lines.push("");
  lines.push(`Turns     ${fmtStats(turnStats, "", " | ")}`);
  lines.push(`Duration  ${fmtStats(durStats, "ms", " | ")}`);
  lines.push("");

  lines.push("Per-case:");
  if (cases.length === 0) lines.push("  (no cases)");
  for (const c of cases) {
    const ok = c.checks.filter((k) => k.pass).length;
    lines.push(
      `  ${c.passed ? "PASS" : "FAIL"} ${c.caseId}  turns=${c.turns}  ${c.durationMs}ms  checks ${ok}/${c.checks.length}`,
    );
  }
  lines.push("");

  const freq = computeToolCallFreq(cases).slice(0, TOP_TOOLS_SHOWN);
  lines.push("Tool call frequency (top):");
  if (freq.length === 0) {
    lines.push("  (none)");
  } else {
    const width = Math.max(...freq.map((f) => f.name.length));
    for (const f of freq) lines.push(`  ${f.name.padEnd(width)}  x${f.count}`);
  }
  lines.push("");

  lines.push(`Failures (${failures.length}):`);
  if (failures.length === 0) lines.push("  none");
  for (const c of failures) {
    const ok = c.checks.filter((k) => k.pass).length;
    const err = c.error === undefined ? "" : ` | error: ${c.error}`;
    lines.push(`  [${c.caseId}] ${c.caseName} - checks ${ok}/${c.checks.length}${err}`);
    for (const k of c.checks) {
      if (!k.pass) lines.push(`    - ${k.id}: ${k.detail}`);
    }
  }
  return lines.join("\n");
}

/** renderReport 的同构 markdown 版：同一份数据、同一套派生逻辑。 */
export function renderMarkdown(report: SuiteReport): string {
  const cases = report.cases;
  const passed = cases.filter((c) => c.passed).length;
  const failed = cases.length - passed;
  const passRate = cases.length === 0 ? "n/a" : `${((passed / cases.length) * 100).toFixed(1)}%`;
  const turnStats = computeTimingStats(cases.map((c) => c.turns));
  const durStats = computeTimingStats(cases.map((c) => c.durationMs));
  const failures = cases.filter((c) => !c.passed);

  const lines: string[] = [];
  lines.push(`# Eval Suite: ${report.suiteId}`);
  lines.push("");
  lines.push(
    `- Cases: ${cases.length} total, ${passed} passed, ${failed} failed (pass rate ${passRate})`,
  );
  lines.push(`- Wall time: ${report.totalMs}ms`);
  lines.push(`- Turns: ${fmtStats(turnStats, "", ", ")}`);
  lines.push(`- Duration: ${fmtStats(durStats, "ms", ", ")}`);
  lines.push("");

  lines.push("## Per-case");
  lines.push("");
  lines.push("| case | status | turns | duration (ms) | checks |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const c of cases) {
    const ok = c.checks.filter((k) => k.pass).length;
    lines.push(
      `| ${c.caseId} | ${c.passed ? "PASS" : "FAIL"} | ${c.turns} | ${c.durationMs} | ${ok}/${c.checks.length} |`,
    );
  }
  lines.push("");

  const freq = computeToolCallFreq(cases).slice(0, TOP_TOOLS_SHOWN);
  lines.push("## Tool call frequency (top)");
  lines.push("");
  lines.push("| tool | calls |");
  lines.push("| --- | --- |");
  for (const f of freq) lines.push(`| ${f.name} | ${f.count} |`);
  lines.push("");

  lines.push(`## Failures (${failures.length})`);
  lines.push("");
  if (failures.length === 0) lines.push("none");
  for (const c of failures) {
    const ok = c.checks.filter((k) => k.pass).length;
    const err = c.error === undefined ? "" : ` - error: ${c.error}`;
    lines.push(`### [${c.caseId}] ${c.caseName} - checks ${ok}/${c.checks.length}${err}`);
    lines.push("");
    for (const k of c.checks) {
      if (!k.pass) lines.push(`- \`${k.id}\`: ${k.detail}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** 基线防回退：按 caseId 对齐两轮 SuiteReport，识别回退与改进。 */
export function compareRuns(baseline: SuiteReport, current: SuiteReport): CompareRunsResult {
  const regressions: string[] = [];
  const improvements: string[] = [];
  const baseById = new Map<string, CaseResult>();
  for (const c of baseline.cases) baseById.set(c.caseId, c);
  const currById = new Map<string, CaseResult>();
  for (const c of current.cases) currById.set(c.caseId, c);

  for (const [id, base] of baseById) {
    const curr = currById.get(id);
    if (curr === undefined) {
      regressions.push(`case "${id}" missing in current run (coverage lost)`);
      continue;
    }
    if (base.passed && !curr.passed) {
      regressions.push(`case "${id}" regressed: passed -> failed`);
    } else if (!base.passed && curr.passed) {
      improvements.push(`case "${id}" improved: failed -> passed`);
    }
  }
  for (const id of currById.keys()) {
    if (!baseById.has(id)) {
      improvements.push(`case "${id}" is new coverage (absent in baseline)`);
    }
  }
  return { regressions, improvements };
}

// ---------------------------------------------------------------------------
// 内部格式化
// ---------------------------------------------------------------------------

function fmtStats(stats: TimingStats | null, unit: string, sep: string): string {
  if (stats === null) return "n/a";
  return [
    `min ${fmtNum(stats.min)}${unit}`,
    `median ${fmtNum(stats.median)}${unit}`,
    `p95 ${fmtNum(stats.p95)}${unit}`,
    `max ${fmtNum(stats.max)}${unit}`,
  ].join(sep);
}

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
