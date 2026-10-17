import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvalHarness, computeTimingStats, computeToolCallFreq, percentile } from "./eval-harness";
import type {
  AgentLoopPort,
  CaseResult,
  EvalCase,
  ToolCallRecord,
  ToolStubMap,
} from "./eval-harness";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

async function injectRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bi-evals-test-"));
  roots.push(dir);
  return dir;
}

/** 参考被测 loop：逐轮拉脚本、执行工具，最后一轮 text 即最终输出。 */
const replayLoop: AgentLoopPort = async (ctx) => {
  let output = "";
  for (;;) {
    const turn = await ctx.nextModelTurn();
    if (turn === null) return output;
    for (const req of turn.toolCalls ?? []) {
      await ctx.executeTool(req.name, req.args);
    }
    if (turn.text !== undefined) output = turn.text;
  }
};

function makeCase(overrides: Partial<EvalCase> & { id: string }): EvalCase {
  return {
    name: overrides.id,
    workspace: { files: [] },
    toolStubs: {},
    modelScript: [],
    expectations: [],
    ...overrides,
  };
}

function mkRec(name: string): ToolCallRecord {
  return { seq: 0, turn: 0, name, args: {}, durationMs: 0 };
}

/** 回放确定性签名：剔除墙钟时长后逐字节可比。 */
function stableSignature(r: CaseResult): string {
  return JSON.stringify({
    turns: r.turns,
    output: r.output,
    tools: r.toolCalls.map((t) => ({ name: t.name, args: t.args, result: t.result, error: t.error })),
    checks: r.checks.map((c) => ({ id: c.id, pass: c.pass, detail: c.detail })),
  });
}

// ---------------------------------------------------------------------------
// 虚拟工作区与沙箱
// ---------------------------------------------------------------------------

describe("EvalHarness.runCase 虚拟工作区", () => {
  test("虚拟工作区文件写入沙箱，被测 loop 可读", async () => {
    const root = await injectRoot();
    const harness = new EvalHarness(async (ctx) => readFile(join(ctx.cwd, "docs/note.md"), "utf8"));
    const result = await harness.runCase(
      makeCase({
        id: "ws-basic",
        workspace: { files: [{ path: "docs/note.md", content: "hello-bi-21" }] },
        expectations: [{ kind: "output-contains", text: "hello-bi-21" }],
      }),
      { sandboxRoot: root },
    );
    expect(result.error).toBeUndefined();
    expect(result.passed).toBe(true);
  });

  test("沙箱用后即焚：sandboxRoot 注入时不残留隔离子目录", async () => {
    const root = await injectRoot();
    const harness = new EvalHarness(replayLoop);
    await harness.runCase(makeCase({ id: "cleanup" }), { sandboxRoot: root });
    expect(await readdir(root)).toHaveLength(0);
  });

  test("keepSandbox 保留沙箱供调试", async () => {
    const root = await injectRoot();
    const harness = new EvalHarness(replayLoop);
    await harness.runCase(
      makeCase({
        id: "keep",
        workspace: { files: [{ path: "a.txt", content: "kept" }] },
      }),
      { sandboxRoot: root, keepSandbox: true },
    );
    const entries = await readdir(root);
    expect(entries).toHaveLength(1);
    const caseDir = join(root, entries[0] as string);
    expect(await readFile(join(caseDir, "a.txt"), "utf8")).toBe("kept");
  });

  test("路径逃逸被拒绝（.. 与绝对路径），且不落盘", async () => {
    const root = await injectRoot();
    const harness = new EvalHarness(replayLoop);
    const dotdot = await harness.runCase(
      makeCase({ id: "escape-1", workspace: { files: [{ path: "../evil.txt", content: "x" }] } }),
      { sandboxRoot: root },
    );
    const absolute = await harness.runCase(
      makeCase({ id: "escape-2", workspace: { files: [{ path: "/etc/evil.txt", content: "x" }] } }),
      { sandboxRoot: root },
    );
    expect(dotdot.error ?? "").toMatch(/escapes sandbox/);
    expect(absolute.error ?? "").toMatch(/escapes sandbox/);
    expect(dotdot.passed).toBe(false);
    expect(await readdir(root)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Check 断言矩阵（五类各正反）
// ---------------------------------------------------------------------------

describe("EvalHarness.runCase Check 断言矩阵", () => {
  test("tool-called 正：默认 minTimes=1", async () => {
    const harness = new EvalHarness(replayLoop);
    const result = await harness.runCase(
      makeCase({
        id: "called-pos",
        toolStubs: { search: () => "hit" },
        modelScript: [{ toolCalls: [{ name: "search", args: { q: "x" } }] }],
        expectations: [{ kind: "tool-called", name: "search" }],
      }),
    );
    expect(result.checks[0]?.pass).toBe(true);
    expect(result.checks[0]?.detail).toContain('called 1 time(s)');
  });

  test("tool-called 负：零调用判负并给出计数", async () => {
    const harness = new EvalHarness(replayLoop);
    const result = await harness.runCase(
      makeCase({
        id: "called-neg",
        expectations: [{ kind: "tool-called", name: "search" }],
      }),
    );
    expect(result.checks[0]?.pass).toBe(false);
    expect(result.checks[0]?.detail).toContain('called 0 time(s)');
  });

  test("tool-called minTimes/maxTimes 边界", async () => {
    const harness = new EvalHarness(replayLoop);
    const script = [
      { toolCalls: [{ name: "t", args: {} }] },
      { toolCalls: [{ name: "t", args: {} }] },
    ];
    const result = await harness.runCase(
      makeCase({
        id: "called-bounds",
        toolStubs: { t: () => null },
        modelScript: script,
        expectations: [
          { kind: "tool-called", name: "t", minTimes: 2, maxTimes: 2 },
          { kind: "tool-called", name: "t", maxTimes: 1 },
          { kind: "tool-called", name: "t", minTimes: 3 },
        ],
      }),
    );
    expect(result.checks[0]?.pass).toBe(true);
    expect(result.checks[1]?.pass).toBe(false);
    expect(result.checks[2]?.pass).toBe(false);
  });

  test("tool-order 正：期望序列按序出现，允许穿插额外调用", async () => {
    const harness = new EvalHarness(replayLoop);
    const result = await harness.runCase(
      makeCase({
        id: "order-pos",
        toolStubs: { a: () => 1, extra: () => 2, b: () => 3 },
        modelScript: [
          { toolCalls: [{ name: "a", args: {} }] },
          { toolCalls: [{ name: "extra", args: {} }] },
          { toolCalls: [{ name: "b", args: {} }] },
        ],
        expectations: [{ kind: "tool-order", expected: ["a", "b"] }],
      }),
    );
    expect(result.checks[0]?.pass).toBe(true);
  });

  test("tool-order 负：乱序判负并列出 recorded 序列", async () => {
    const harness = new EvalHarness(replayLoop);
    const result = await harness.runCase(
      makeCase({
        id: "order-neg",
        toolStubs: { a: () => 1, b: () => 2 },
        modelScript: [
          { toolCalls: [{ name: "b", args: {} }] },
          { toolCalls: [{ name: "a", args: {} }] },
        ],
        expectations: [{ kind: "tool-order", expected: ["a", "b"] }],
      }),
    );
    expect(result.checks[0]?.pass).toBe(false);
    expect(result.checks[0]?.detail).toContain('recorded ["b","a"]');
  });

  test("output-contains 正", async () => {
    const harness = new EvalHarness(replayLoop);
    const result = await harness.runCase(
      makeCase({
        id: "contains-pos",
        modelScript: [{ text: "task done successfully" }],
        expectations: [{ kind: "output-contains", text: "done" }],
      }),
    );
    expect(result.checks[0]?.pass).toBe(true);
  });

  test("output-contains 负：附实际输出节选", async () => {
    const harness = new EvalHarness(replayLoop);
    const result = await harness.runCase(
      makeCase({
        id: "contains-neg",
        modelScript: [{ text: "partial" }],
        expectations: [{ kind: "output-contains", text: "absent-marker" }],
      }),
    );
    expect(result.checks[0]?.pass).toBe(false);
    expect(result.checks[0]?.detail).toContain('does not contain "absent-marker"');
    expect(result.checks[0]?.detail).toContain("partial");
  });

  test("output-contains ignoreCase 生效", async () => {
    const harness = new EvalHarness(replayLoop);
    const result = await harness.runCase(
      makeCase({
        id: "contains-case",
        modelScript: [{ text: "Task DONE" }],
        expectations: [
          { kind: "output-contains", text: "DONE" },
          { kind: "output-contains", text: "done", ignoreCase: true },
        ],
      }),
    );
    expect(result.checks[0]?.pass).toBe(true);
    expect(result.checks[1]?.pass).toBe(true);
  });

  test("output-matches 正：含 flags 多行模式", async () => {
    const harness = new EvalHarness(replayLoop);
    const result = await harness.runCase(
      makeCase({
        id: "matches-pos",
        modelScript: [{ text: "step 1 ok\ndone: 42" }],
        expectations: [
          { kind: "output-matches", pattern: "\\d+" },
          { kind: "output-matches", pattern: "^done: \\d+$", flags: "m" },
        ],
      }),
    );
    expect(result.checks[0]?.pass).toBe(true);
    expect(result.checks[1]?.pass).toBe(true);
  });

  test("output-matches 负", async () => {
    const harness = new EvalHarness(replayLoop);
    const result = await harness.runCase(
      makeCase({
        id: "matches-neg",
        modelScript: [{ text: "no digits here" }],
        expectations: [{ kind: "output-matches", pattern: "^\\d+$" }],
      }),
    );
    expect(result.checks[0]?.pass).toBe(false);
    expect(result.checks[0]?.detail).toContain('does not match /^\\d+$/');
  });

  test("output-matches 非法 pattern 判负而不炸用例", async () => {
    const harness = new EvalHarness(replayLoop);
    const result = await harness.runCase(
      makeCase({
        id: "matches-invalid",
        modelScript: [{ text: "anything" }],
        expectations: [{ kind: "output-matches", pattern: "(" }],
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.checks[0]?.pass).toBe(false);
    expect(result.checks[0]?.detail).toContain("invalid pattern");
  });

  test("max-turns 正反：恰好在限额内通过，超出判负", async () => {
    const harness = new EvalHarness(replayLoop);
    const result = await harness.runCase(
      makeCase({
        id: "turns",
        modelScript: [{ text: "1" }, { text: "2" }, { text: "3" }],
        expectations: [
          { kind: "max-turns", limit: 3 },
          { kind: "max-turns", limit: 2 },
        ],
      }),
    );
    expect(result.turns).toBe(3);
    expect(result.checks[0]?.pass).toBe(true);
    expect(result.checks[1]?.pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 回放确定性与调用记录
// ---------------------------------------------------------------------------

describe("EvalHarness.runCase 回放与记录", () => {
  test("模型脚本回放确定性：两次 run 签名逐字节相同", async () => {
    const stubs: ToolStubMap = {
      add: (args) => (args as { a: number; b: number }).a + (args as { a: number; b: number }).b,
      echo: (args) => args,
    };
    const harness = new EvalHarness(replayLoop);
    const def = makeCase({
      id: "determinism",
      toolStubs: stubs,
      modelScript: [
        { toolCalls: [{ name: "add", args: { a: 1, b: 2 } }] },
        { toolCalls: [{ name: "echo", args: { k: "v" } }], text: "sum computed" },
      ],
      expectations: [
        { kind: "tool-called", name: "add" },
        { kind: "output-contains", text: "sum" },
      ],
    });
    const r1 = await harness.runCase(def);
    const r2 = await harness.runCase(def);
    expect(r1.passed).toBe(true);
    expect(r2.passed).toBe(true);
    expect(stableSignature(r1)).toBe(stableSignature(r2));
    expect(r1.toolCalls[0]?.result).toBe(3);
  });

  test("工具调用 seq/turn 编号：模型首调前 turn=0", async () => {
    const earlyPort: AgentLoopPort = async (ctx) => {
      await ctx.executeTool("early", {});
      const turn = await ctx.nextModelTurn();
      for (const req of turn?.toolCalls ?? []) await ctx.executeTool(req.name, req.args);
      return "ok";
    };
    const harness = new EvalHarness(earlyPort);
    const result = await harness.runCase(
      makeCase({
        id: "seq-turn",
        toolStubs: { early: () => 1, later: () => 2 },
        modelScript: [{ toolCalls: [{ name: "later", args: {} }] }],
      }),
    );
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]?.name).toBe("early");
    expect(result.toolCalls[0]?.seq).toBe(1);
    expect(result.toolCalls[0]?.turn).toBe(0);
    expect(result.toolCalls[1]?.name).toBe("later");
    expect(result.toolCalls[1]?.seq).toBe(2);
    expect(result.toolCalls[1]?.turn).toBe(1);
  });

  test("脚本耗尽后拉取返回 null，turns 只计实际消费", async () => {
    const greedyPort: AgentLoopPort = async (ctx) => {
      let output = "";
      const t1 = await ctx.nextModelTurn();
      if (t1?.text !== undefined) output += t1.text;
      const t2 = await ctx.nextModelTurn();
      const t3 = await ctx.nextModelTurn();
      return `${output}|${t2 === null ? "n1" : "s2"}|${t3 === null ? "n2" : "s3"}`;
    };
    const harness = new EvalHarness(greedyPort);
    const result = await harness.runCase(
      makeCase({ id: "exhausted", modelScript: [{ text: "only" }] }),
    );
    expect(result.turns).toBe(1);
    expect(result.output).toBe("only|n1|n2");
  });

  test("未注册工具：记录错误并抛给被测 loop", async () => {
    const ghostPort: AgentLoopPort = async (ctx) => {
      await ctx.executeTool("ghost", { x: 1 });
      return "unreachable";
    };
    const harness = new EvalHarness(ghostPort);
    const result = await harness.runCase(makeCase({ id: "ghost" }));
    expect(result.error ?? "").toContain('unknown tool "ghost"');
    expect(result.toolCalls[0]?.name).toBe("ghost");
    expect(result.toolCalls[0]?.error ?? "").toContain("no stub registered");
    expect(result.passed).toBe(false);
  });

  test("stub 抛错：error 记录在案，被测 loop 可恢复", async () => {
    const catchPort: AgentLoopPort = async (ctx) => {
      try {
        await ctx.executeTool("fragile", {});
        return "no-throw";
      } catch {
        return "caught";
      }
    };
    const harness = new EvalHarness(catchPort);
    const result = await harness.runCase(
      makeCase({
        id: "stub-throw",
        toolStubs: {
          fragile: () => {
            throw new Error("boom");
          },
        },
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.output).toBe("caught");
    expect(result.toolCalls[0]?.error).toBe("boom");
  });

  test("stub（含异步）返回值被记录", async () => {
    const harness = new EvalHarness(replayLoop);
    const result = await harness.runCase(
      makeCase({
        id: "stub-result",
        toolStubs: {
          slow: async () => ({ ok: 42 }),
        },
        modelScript: [{ toolCalls: [{ name: "slow", args: {} }] }],
      }),
    );
    expect(result.toolCalls[0]?.result).toEqual({ ok: 42 });
    expect(result.toolCalls[0]?.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 超时与异常
// ---------------------------------------------------------------------------

describe("EvalHarness.runCase 超时与异常", () => {
  test("超时判负，abort 信号送达被测 loop", async () => {
    let abortObserved = false;
    const hangingPort: AgentLoopPort = (ctx) =>
      new Promise<string>((resolve) => {
        if (ctx.signal.aborted) {
          abortObserved = true;
          resolve("aborted-before-wait");
          return;
        }
        ctx.signal.addEventListener(
          "abort",
          () => {
            abortObserved = true;
            resolve("aborted");
          },
          { once: true },
        );
      });
    const harness = new EvalHarness(hangingPort);
    const result = await harness.runCase(makeCase({ id: "hang" }), { timeoutMs: 60 });
    expect(result.timedOut).toBe(true);
    expect(result.error ?? "").toContain("timed out");
    expect(result.passed).toBe(false);
    expect(result.output).toBe("");
    expect(abortObserved).toBe(true);
  });

  test("port 抛错：错误透出为装置级 error", async () => {
    const crashPort: AgentLoopPort = async () => {
      throw new Error("loop crashed");
    };
    const harness = new EvalHarness(crashPort);
    const result = await harness.runCase(makeCase({ id: "crash" }));
    expect(result.error).toBe("loop crashed");
    expect(result.passed).toBe(false);
    expect(result.output).toBe("");
  });

  test("装置级错误时 checks 仍产出且 detail 带错误前缀", async () => {
    const crashPort: AgentLoopPort = async () => {
      throw new Error("loop crashed");
    };
    const harness = new EvalHarness(crashPort);
    const result = await harness.runCase(
      makeCase({
        id: "crash-with-check",
        expectations: [{ kind: "output-contains", text: "never" }],
      }),
    );
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.pass).toBe(false);
    expect(result.checks[0]?.detail).toContain("[case error: loop crashed]");
  });
});

// ---------------------------------------------------------------------------
// runSuite：并发池、隔离、汇总
// ---------------------------------------------------------------------------

describe("EvalHarness.runSuite", () => {
  function passCase(id: string): EvalCase {
    return makeCase({
      id,
      modelScript: [{ text: "ok" }],
      expectations: [{ kind: "output-contains", text: "ok" }],
    });
  }

  test("汇总数学与输入序对齐（并发 4 不乱序）", async () => {
    const harness = new EvalHarness(replayLoop);
    const report = await harness.runSuite(
      [passCase("a"), passCase("b"), passCase("c"), passCase("d")],
      { concurrency: 4 },
    );
    expect(report.total).toBe(4);
    expect(report.passed).toBe(4);
    expect(report.failed).toBe(0);
    expect(report.passRate).toBe(1);
    expect(report.cases.map((c) => c.caseId)).toEqual(["a", "b", "c", "d"]);
    expect(report.suiteId).toBe("eval-suite");
    expect(report.totalMs).toBeGreaterThanOrEqual(0);
  });

  test("失败计入 failed 并压低 passRate", async () => {
    const harness = new EvalHarness(replayLoop);
    const failing = makeCase({
      id: "must-fail",
      modelScript: [{ text: "nope" }],
      expectations: [{ kind: "output-contains", text: "wanted" }],
    });
    const report = await harness.runSuite([passCase("a"), failing, passCase("b")]);
    expect(report.total).toBe(3);
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.passRate).toBe(2 / 3);
  });

  test("逐案例隔离目录互不污染", async () => {
    const root = await injectRoot();
    const readLoop: AgentLoopPort = async (ctx) => readFile(join(ctx.cwd, "state.txt"), "utf8");
    const harness = new EvalHarness(readLoop);
    const report = await harness.runSuite(
      [
        makeCase({
          id: "iso-a",
          workspace: { files: [{ path: "state.txt", content: "alpha-content" }] },
          expectations: [{ kind: "output-contains", text: "alpha-content" }],
        }),
        makeCase({
          id: "iso-b",
          workspace: { files: [{ path: "state.txt", content: "beta-content" }] },
          expectations: [{ kind: "output-contains", text: "beta-content" }],
        }),
      ],
      { sandboxRoot: root, concurrency: 2 },
    );
    expect(report.passed).toBe(2);
    expect(report.cases[0]?.output).toBe("alpha-content");
    expect(report.cases[1]?.output).toBe("beta-content");
    expect(await readdir(root)).toHaveLength(0);
  });

  test("stats 与 toolCallFreq 与派生函数对齐", async () => {
    const harness = new EvalHarness(replayLoop);
    const withTools = makeCase({
      id: "freq",
      toolStubs: { read_file: () => 1, write_file: () => 2 },
      modelScript: [
        { toolCalls: [{ name: "read_file", args: {} }, { name: "read_file", args: {} }] },
        { toolCalls: [{ name: "write_file", args: {} }] },
      ],
    });
    const report = await harness.runSuite([passCase("a"), withTools]);
    expect(report.stats.turns).toEqual(computeTimingStats(report.cases.map((c) => c.turns)));
    expect(report.stats.durationMs).toEqual(computeTimingStats(report.cases.map((c) => c.durationMs)));
    expect(report.toolCallFreq).toEqual(computeToolCallFreq(report.cases));
    expect(report.toolCallFreq[0]).toEqual({ name: "read_file", count: 2 });
  });

  test("keepSandbox 套件级保留：suite 目录下每案例各一子目录", async () => {
    const root = await injectRoot();
    const harness = new EvalHarness(replayLoop);
    await harness.runSuite([passCase("s1"), passCase("s2")], {
      sandboxRoot: root,
      keepSandbox: true,
    });
    const suiteEntries = await readdir(root);
    expect(suiteEntries).toHaveLength(1);
    expect(suiteEntries[0] ?? "").toMatch(/^bi-evals-suite-/);
    const caseEntries = await readdir(join(root, suiteEntries[0] as string));
    expect(caseEntries).toHaveLength(2);
    // readdir 顺序不保证，按成员断言。
    expect(caseEntries.some((e) => /^case-s1-/.test(e))).toBe(true);
    expect(caseEntries.some((e) => /^case-s2-/.test(e))).toBe(true);
  });

  test("空套件：零用例不崩，统计为 null", async () => {
    const harness = new EvalHarness(replayLoop);
    const report = await harness.runSuite([]);
    expect(report.total).toBe(0);
    expect(report.passRate).toBe(0);
    expect(report.cases).toHaveLength(0);
    expect(report.stats.turns).toBeNull();
    expect(report.stats.durationMs).toBeNull();
    expect(report.toolCallFreq).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 统计基元：median/p95 手算对齐
// ---------------------------------------------------------------------------

describe("统计基元", () => {
  test("percentile 线性插值手算对齐", () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 0.95)).toBeCloseTo(4.8, 12);
    expect(percentile([10, 20, 30, 40], 0.5)).toBeCloseTo(25, 12);
    expect(percentile([10, 20, 30, 40], 0.95)).toBeCloseTo(38.5, 12);
    expect(percentile([7], 0.5)).toBe(7);
    expect(percentile([7], 0.95)).toBe(7);
  });

  test("computeTimingStats：min/median/p95/max 与空输入 null", () => {
    const stats = computeTimingStats([5, 1, 4, 2, 3]);
    expect(stats?.min).toBe(1);
    expect(stats?.max).toBe(5);
    expect(stats?.median).toBe(3);
    expect(stats?.p95).toBeCloseTo(4.8, 12);
    expect(computeTimingStats([])).toBeNull();
  });

  test("computeToolCallFreq：降序 + 同频字典序", () => {
    const freq = computeToolCallFreq([
      { toolCalls: [mkRec("b"), mkRec("b"), mkRec("a"), mkRec("a")] },
      { toolCalls: [mkRec("c")] },
    ]);
    expect(freq).toEqual([
      { name: "a", count: 2 },
      { name: "b", count: 2 },
      { name: "c", count: 1 },
    ]);
  });
});
