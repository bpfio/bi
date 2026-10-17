import { describe, expect, test } from "bun:test";
import { compareRuns, renderMarkdown, renderReport } from "./eval-report";
import { computeTimingStats, computeToolCallFreq } from "./eval-harness";
import type { CaseResult, SuiteReport, ToolCallRecord } from "./eval-harness";

// ---------------------------------------------------------------------------
// 固定时长 fixture（快照对齐：时长全部手工固定，不受墙钟影响）
// ---------------------------------------------------------------------------

function tc(seq: number, turn: number, name: string): ToolCallRecord {
  return { seq, turn, name, args: {}, durationMs: 0 };
}

const case1: CaseResult = {
  caseId: "case-1",
  caseName: "read-and-write",
  passed: true,
  checks: [
    {
      id: "tool-called#0",
      kind: "tool-called",
      pass: true,
      detail: 'tool "read_file" called 2 time(s), expected >=1',
    },
    { id: "output-contains#1", kind: "output-contains", pass: true, detail: 'output contains "done"' },
  ],
  turns: 2,
  durationMs: 4,
  toolCalls: [tc(1, 1, "read_file"), tc(2, 2, "read_file"), tc(3, 2, "write_file")],
  output: "done",
};

const case2: CaseResult = {
  caseId: "case-2",
  caseName: "missing-output",
  passed: false,
  checks: [
    {
      id: "tool-called#0",
      kind: "tool-called",
      pass: true,
      detail: 'tool "read_file" called 1 time(s), expected >=1',
    },
    {
      id: "output-contains#1",
      kind: "output-contains",
      pass: false,
      detail: 'output does not contain "DONE"; actual: "partial"',
    },
  ],
  turns: 4,
  durationMs: 10,
  toolCalls: [tc(1, 1, "read_file")],
  output: "partial",
};

function mkReport(suiteId: string, cases: CaseResult[]): SuiteReport {
  const passed = cases.filter((c) => c.passed).length;
  return {
    suiteId,
    total: cases.length,
    passed,
    failed: cases.length - passed,
    passRate: cases.length === 0 ? 0 : passed / cases.length,
    totalMs: 13,
    cases,
    toolCallFreq: computeToolCallFreq(cases),
    stats: {
      turns: computeTimingStats(cases.map((c) => c.turns)),
      durationMs: computeTimingStats(cases.map((c) => c.durationMs)),
    },
  };
}

const fixtureReport: SuiteReport = mkReport("fixture-suite", [case1, case2]);

// ---------------------------------------------------------------------------
// renderReport（纯文本看板）
// ---------------------------------------------------------------------------

describe("renderReport", () => {
  test("快照：多维看板逐字节对齐", () => {
    expect(renderReport(fixtureReport)).toBe(
      `== Eval Suite: fixture-suite ==
Cases: 2 total | 1 passed | 1 failed | pass rate 50.0%
Wall time: 13ms

Turns     min 2 | median 3 | p95 3.9 | max 4
Duration  min 4ms | median 7ms | p95 9.7ms | max 10ms

Per-case:
  PASS case-1  turns=2  4ms  checks 2/2
  FAIL case-2  turns=4  10ms  checks 1/2

Tool call frequency (top):
  read_file   x3
  write_file  x1

Failures (1):
  [case-2] missing-output - checks 1/2
    - output-contains#1: output does not contain "DONE"; actual: "partial"`,
    );
  });

  test("汇总行：通过率与计数", () => {
    const text = renderReport(fixtureReport);
    expect(text).toContain("Cases: 2 total | 1 passed | 1 failed | pass rate 50.0%");
    expect(text).toContain("Wall time: 13ms");
  });

  test("失败差距明细：案例行 + 逐条失败 check", () => {
    const text = renderReport(fixtureReport);
    expect(text).toContain("[case-2] missing-output - checks 1/2");
    expect(text).toContain('- output-contains#1: output does not contain "DONE"; actual: "partial"');
  });

  test("空套件：n/a 与占位行，不崩溃", () => {
    const text = renderReport(mkReport("empty", []));
    expect(text).toContain("Cases: 0 total | 0 passed | 0 failed | pass rate n/a");
    expect(text).toContain("Turns     n/a");
    expect(text).toContain("Duration  n/a");
    expect(text).toContain("  (no cases)");
    expect(text).toContain("  (none)");
    expect(text).toContain("Failures (0):");
    expect(text).toContain("  none");
  });
});

// ---------------------------------------------------------------------------
// renderMarkdown（同构 markdown 版）
// ---------------------------------------------------------------------------

describe("renderMarkdown", () => {
  test("快照：与文本版同构、逐字节对齐", () => {
    expect(renderMarkdown(fixtureReport)).toBe(
      `# Eval Suite: fixture-suite

- Cases: 2 total, 1 passed, 1 failed (pass rate 50.0%)
- Wall time: 13ms
- Turns: min 2, median 3, p95 3.9, max 4
- Duration: min 4ms, median 7ms, p95 9.7ms, max 10ms

## Per-case

| case | status | turns | duration (ms) | checks |
| --- | --- | --- | --- | --- |
| case-1 | PASS | 2 | 4 | 2/2 |
| case-2 | FAIL | 4 | 10 | 1/2 |

## Tool call frequency (top)

| tool | calls |
| --- | --- |
| read_file | 3 |
| write_file | 1 |

## Failures (1)

### [case-2] missing-output - checks 1/2

- \`output-contains#1\`: output does not contain "DONE"; actual: "partial"
`,
    );
  });

  test("同构字段：统计 bullet、逐案例表行与文本版一致", () => {
    const md = renderMarkdown(fixtureReport);
    expect(md).toContain("# Eval Suite: fixture-suite");
    expect(md).toContain("- Turns: min 2, median 3, p95 3.9, max 4");
    expect(md).toContain("- Duration: min 4ms, median 7ms, p95 9.7ms, max 10ms");
    expect(md).toContain("| case-1 | PASS | 2 | 4 | 2/2 |");
    expect(md).toContain("| case-2 | FAIL | 4 | 10 | 1/2 |");
    expect(md).toContain("| read_file | 3 |");
  });

  test("失败明细以 markdown 列表呈现", () => {
    const md = renderMarkdown(fixtureReport);
    expect(md).toContain("### [case-2] missing-output - checks 1/2");
    expect(md).toContain('- `output-contains#1`: output does not contain "DONE"; actual: "partial"');
  });

  test("空套件：pass rate n/a、空表、Failures (0)", () => {
    const md = renderMarkdown(mkReport("empty", []));
    expect(md).toContain("(pass rate n/a)");
    expect(md).toContain("- Turns: n/a");
    expect(md).toContain("## Failures (0)");
    expect(md).toContain("none");
  });
});

// ---------------------------------------------------------------------------
// compareRuns（基线防回退）
// ---------------------------------------------------------------------------

describe("compareRuns", () => {
  function mkCaseResult(caseId: string, passed: boolean): CaseResult {
    return {
      caseId,
      caseName: caseId,
      passed,
      checks: [],
      turns: 1,
      durationMs: 1,
      toolCalls: [],
      output: "",
    };
  }

  test("回归识别：通过 → 失败", () => {
    const baseline = mkReport("base", [mkCaseResult("a", true), mkCaseResult("b", true)]);
    const current = mkReport("cur", [mkCaseResult("a", false), mkCaseResult("b", true)]);
    const diff = compareRuns(baseline, current);
    expect(diff.regressions).toEqual(['case "a" regressed: passed -> failed']);
    expect(diff.improvements).toEqual([]);
  });

  test("覆盖丢失：基线有、当前缺失记为回退", () => {
    const baseline = mkReport("base", [mkCaseResult("gone", true)]);
    const current = mkReport("cur", []);
    const diff = compareRuns(baseline, current);
    expect(diff.regressions).toEqual(['case "gone" missing in current run (coverage lost)']);
  });

  test("改进与新增覆盖", () => {
    const baseline = mkReport("base", [mkCaseResult("d", false)]);
    const current = mkReport("cur", [mkCaseResult("d", true), mkCaseResult("e", true)]);
    const diff = compareRuns(baseline, current);
    expect(diff.improvements).toEqual([
      'case "d" improved: failed -> passed',
      'case "e" is new coverage (absent in baseline)',
    ]);
    expect(diff.regressions).toEqual([]);
  });

  test("无变化：双列表为空", () => {
    const baseline = mkReport("base", [mkCaseResult("a", true), mkCaseResult("b", false)]);
    const current = mkReport("cur", [mkCaseResult("a", true), mkCaseResult("b", false)]);
    const diff = compareRuns(baseline, current);
    expect(diff.regressions).toEqual([]);
    expect(diff.improvements).toEqual([]);
  });
});
