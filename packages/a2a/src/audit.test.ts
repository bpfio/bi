import { describe, expect, test } from "bun:test";
import {
  PySandboxError,
  type PyRunResult,
  type PySelfHealOutcome,
  runPython,
  selfHealLoop,
  verify,
} from "./audit";

// ---------------------------------------------------------------------------
// 全部用例均为本机 python3 纯标准库计算：零网络、零文件读写、零仓外路径。
// ---------------------------------------------------------------------------

/** 纯计算：100 以内素数之和 = 1060（验证结论唯一事实依据是 stdout）。 */
const PRIMES_CODE = `
total = sum(n for n in range(2, 100) if all(n % d for d in range(2, int(n**0.5) + 1)))
print(f"total={total}")
`;

describe("runPython · 运行即验门（BI-16）", () => {
  test("算术：stdout 即结论", async () => {
    const run = await runPython("print(1 + 2)");
    expect(run.ok).toBe(true);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("3\n");
  });

  test("stdout / stderr 分流", async () => {
    const run = await runPython(`import sys
print("to-stdout")
print("to-stderr", file=sys.stderr)`);
    expect(run.ok).toBe(true);
    expect(run.stdout).toContain("to-stdout");
    expect(run.stdout).not.toContain("to-stderr");
    expect(run.stderr).toContain("to-stderr");
  });

  test("多行纯计算：素数求和，结论只能来自 stdout", async () => {
    const run = await runPython(PRIMES_CODE);
    expect(run.ok).toBe(true);
    expect(run.stdout).toBe("total=1060\n");
    expect(verify(run.stdout, { kind: "number", expected: 1060, pattern: /total=(\d+)/ }).passed).toBe(true);
  });

  test("durationMs / exitCode 结构", async () => {
    const run = await runPython("print(2 ** 10)");
    expect(typeof run.durationMs).toBe("number");
    expect(run.durationMs).toBeGreaterThan(0);
    expect(run.exitCode).toBe(0);
    expect(run.traceback).toBeUndefined();
  });

  test("未捕获异常：traceback 捕获", async () => {
    const run = await runPython(`raise ValueError("boom-xyz-42")`);
    expect(run.ok).toBe(false);
    expect(run.exitCode).toBe(1);
    expect(run.traceback).toBeDefined();
    expect(run.traceback).toContain("Traceback (most recent call last):");
    expect(run.traceback).toContain("ValueError: boom-xyz-42");
    expect(run.stderr).toContain("boom-xyz-42");
  });

  test("语法错误：ok=false 且 traceback 含 SyntaxError", async () => {
    const run = await runPython("def f(:\n    pass");
    expect(run.ok).toBe(false);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("SyntaxError");
    expect(run.traceback).toContain("SyntaxError");
  });

  test("超时：短超时杀掉长 sleep，抛结构化 timeout", async () => {
    const started = Date.now();
    let caught: unknown;
    try {
      await runPython("import time\ntime.sleep(30)\nprint('done')", { timeoutMs: 300 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PySandboxError);
    const e = caught as PySandboxError;
    expect(e.code).toBe("timeout");
    expect(e.partialStdout).toBe("");
    expect(e.partialStderr).toBe("");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("python3 缺失：pythonPath 注入探测 → code=python-missing", async () => {
    let caught: unknown;
    try {
      await runPython("print(1)", { pythonPath: "definitely-not-a-python-xyz" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PySandboxError);
    expect((caught as PySandboxError).code).toBe("python-missing");
    expect((caught as PySandboxError).message).toContain("degrades");
  });

  test("-I 隔离参数生效：sys.flags.isolated=1 / safe_path=True", async () => {
    const run = await runPython("import sys\nprint(sys.flags.isolated, sys.flags.safe_path)");
    expect(run.ok).toBe(true);
    // Python 3.14 实测输出形如 "1 True"
    const [isolated, safePath] = run.stdout.trim().split(/\s+/);
    expect(isolated).toBe("1");
    expect(safePath).toBe("True");
  });

  test("-I 隔离：PYTHON* 环境变量被忽略（PYTHONPATH 不进 sys.path）", async () => {
    const run = await runPython("import sys, json\nprint(json.dumps(sys.path))", {
      env: { PYTHONPATH: "/bogus-pythonpath-xyz-12345" },
    });
    expect(run.ok).toBe(true);
    expect(run.stdout).not.toContain("bogus-pythonpath-xyz-12345");
  });

  test("stdout 大小上限：有界截断且进程自然跑完", async () => {
    const run = await runPython(`print("x" * 200000)`, { maxOutputBytes: 1024 });
    expect(run.ok).toBe(true);
    expect(run.exitCode).toBe(0);
    expect(run.stdout.length).toBeLessThanOrEqual(1024);
    expect(run.stdout.length).toBeGreaterThan(1000);
    expect(run.stdoutTruncated).toBe(true);
  });

  test("stderr 大小上限：有界截断", async () => {
    const run = await runPython(`import sys\nsys.stderr.write("y" * 200000)`, { maxOutputBytes: 512 });
    expect(run.ok).toBe(true);
    expect(run.stderr.length).toBeLessThanOrEqual(512);
    expect(run.stderrTruncated).toBe(true);
  });
});

describe("verify · 三种 matcher（RULE-BI-02 落地门）", () => {
  test("子串 matcher：通过", () => {
    expect(verify("total=1060\n", "total=1060").passed).toBe(true);
    expect(verify("alpha beta gamma", "beta").passed).toBe(true);
  });

  test("子串 matcher：不合 → gap 描述", () => {
    const outcome = verify("total=1060\n", "total=999");
    expect(outcome.passed).toBe(false);
    if (!outcome.passed) expect(outcome.gap).toContain("substring");
  });

  test("正则 matcher：通过（RegExp 字面量）", () => {
    expect(verify("total=1060\n", /^total=\d+\n$/).passed).toBe(true);
    expect(verify("id=42", /id=\d+/).passed).toBe(true);
  });

  test("正则 matcher：不合 → gap 含 pattern", () => {
    const outcome = verify("total=1060\n", /^total=\d{6}$/m);
    expect(outcome.passed).toBe(false);
    if (!outcome.passed) expect(outcome.gap).toContain("regex");
  });

  test("数值精确：stdout 整体可解析", () => {
    expect(verify("42\n", { kind: "number", expected: 42 }).passed).toBe(true);
    expect(verify("42\n", { kind: "number", expected: 43 }).passed).toBe(false);
  });

  test("数值容差：浮点计算绝对容差", () => {
    expect(verify("3.14159", { kind: "number", expected: 3.14159, tolerance: 0.0001 }).passed).toBe(true);
    const outcome = verify("3.14159", { kind: "number", expected: 3.2, tolerance: 0.001 });
    expect(outcome.passed).toBe(false);
    if (!outcome.passed) expect(outcome.gap).toContain("number mismatch");
  });

  test("数值相对容差：tolerance 按 expected 比例", () => {
    // 1005 vs 1000：绝对差 5，相对 1% 容差允许 10 → 过
    expect(verify("1005", { kind: "number", expected: 1000, tolerance: 0.01, relative: true }).passed).toBe(true);
    // 1020 vs 1000：差 20 > 10 → 不过
    expect(verify("1020", { kind: "number", expected: 1000, tolerance: 0.01, relative: true }).passed).toBe(false);
  });

  test("数值提取：pattern 捕获组与首个数字 token 兜底", () => {
    expect(verify("answer: 7.5 units", { kind: "number", expected: 7.5, pattern: /answer:\s*([\d.]+)/ }).passed).toBe(
      true,
    );
    // 无 pattern：取首个数字 token
    expect(verify("rows 12 cols 5", { kind: "number", expected: 12 }).passed).toBe(true);
    // 全无数值
    const outcome = verify("no numbers here", { kind: "number", expected: 1 });
    expect(outcome.passed).toBe(false);
    if (!outcome.passed) expect(outcome.gap).toContain("no numeric value");
  });

  test("数组期望：全部通过才过，取首条失败 gap", () => {
    expect(verify("total=1060\nmode=fast\n", ["total=1060", { kind: "number", expected: 1060, pattern: /total=(\d+)/ }]).passed).toBe(true);
    const outcome = verify("total=1060\n", ["missing-tag", "total=1060"]);
    expect(outcome.passed).toBe(false);
    if (!outcome.passed) expect(outcome.gap).toContain("missing-tag");
  });
});

describe("selfHealLoop · 回注修复环", () => {
  test("首轮即过：healed=true, rounds=1，repair 不被调用", async () => {
    let repairCalls = 0;
    const outcome = await selfHealLoop({
      code: "print(2 + 2)",
      verify: (stdout) => verify(stdout, "4"),
      repair: () => {
        repairCalls++;
        return "print(0)";
      },
    });
    expect(outcome.healed).toBe(true);
    expect(outcome.rounds).toBe(1);
    expect(outcome.lastResult.stdout).toBe("4\n");
    expect(repairCalls).toBe(0);
  });

  test("一轮修复成功：traceback/stdout/gap 回注 repair，第二轮过门", async () => {
    const feedbacks: Array<{ attempt: number; gap: string; traceback?: string; stdout: string }> = [];
    const outcome: PySelfHealOutcome = await selfHealLoop({
      code: 'print("result=" + str(undefined_name))',
      verify: (stdout) => verify(stdout, "result=84"),
      repair: (fb) => {
        feedbacks.push({ attempt: fb.attempt, gap: fb.gap, traceback: fb.run.traceback, stdout: fb.run.stdout });
        return "print('result=' + str(84))";
      },
    });
    expect(outcome.healed).toBe(true);
    expect(outcome.rounds).toBe(2);
    expect(feedbacks.length).toBe(1);
    expect(feedbacks[0]?.attempt).toBe(1);
    expect(feedbacks[0]?.traceback).toContain("NameError");
    expect(feedbacks[0]?.gap).toContain("substring");
    expect(feedbacks[0]?.stdout).toBe("");
    expect(outcome.lastResult.stdout).toBe("result=84\n");
    expect(outcome.history.length).toBe(2);
  });

  test("maxRounds 用尽仍不过：healed=false，结构化收场不抛", async () => {
    let repairCalls = 0;
    const outcome = await selfHealLoop(
      {
        code: "print('still-wrong')",
        verify: (stdout) => verify(stdout, "expected-value"),
        repair: (fb) => {
          repairCalls++;
          return `print('still-wrong-v${fb.attempt}')`;
        },
      },
      3,
    );
    expect(outcome.healed).toBe(false);
    expect(outcome.rounds).toBe(3);
    expect(repairCalls).toBe(2); // 最后一轮不再修复
    expect(outcome.history.length).toBe(3);
    expect(outcome.lastResult.stdout).toContain("still-wrong-v2");
    expect(outcome.lastResult.ok).toBe(true); // 代码本身跑通，只是过不了 verify 门
  });

  test("无 repair 回调：首轮不过即止，rounds=1", async () => {
    const outcome = await selfHealLoop({
      code: "print('no-fix')",
      verify: (stdout) => verify(stdout, "wanted"),
    });
    expect(outcome.healed).toBe(false);
    expect(outcome.rounds).toBe(1);
    expect(outcome.lastResult.stdout).toBe("no-fix\n");
  });

  test("基础设施故障被结构化转换：超时轮回注 repair 后修复成功", async () => {
    const seenErrors: Array<string | undefined> = [];
    const outcome = await selfHealLoop({
      code: "import time\ntime.sleep(30)",
      runOpts: { timeoutMs: 250 },
      verify: (stdout) => verify(stdout, "recovered-after-timeout"),
      repair: (fb) => {
        seenErrors.push(fb.run.error?.code);
        return "print('recovered-after-timeout')";
      },
    });
    expect(seenErrors[0]).toBe("timeout");
    expect(outcome.healed).toBe(true);
    expect(outcome.rounds).toBe(2);
    expect(outcome.lastResult.error).toBeUndefined();
    expect(outcome.lastResult.ok).toBe(true);
  });

  test("repair 回调抛错：记入 note，循环不抛", async () => {
    const outcome = await selfHealLoop({
      code: "print('broken')",
      verify: (stdout) => verify(stdout, "fixed"),
      repair: () => {
        throw new Error("repair-boom-xyz");
      },
    });
    expect(outcome.healed).toBe(false);
    expect(outcome.rounds).toBe(1);
    expect(outcome.note).toContain("repair-boom-xyz");
  });

  test("verify 回调抛错：按失败 gap 处理，不炸循环", async () => {
    const outcome = await selfHealLoop(
      {
        code: "print('ok-ish')",
        verify: () => {
          throw new Error("verifier-bug");
        },
      },
      2,
    );
    expect(outcome.healed).toBe(false);
    const firstEntry = outcome.history[0];
    expect(firstEntry?.verify.passed).toBe(false);
    if (firstEntry && !firstEntry.verify.passed) {
      expect(firstEntry.verify.gap).toContain("verifier-bug");
    }
  });
});

describe("maxRounds 参数与类型面", () => {
  test("maxRounds=1：单轮机会", async () => {
    let repairCalls = 0;
    const outcome = await selfHealLoop(
      {
        code: "print('x')",
        verify: () => ({ passed: false, gap: "never" }),
        repair: () => {
          repairCalls++;
          return "print('y')";
        },
      },
      1,
    );
    expect(outcome.rounds).toBe(1);
    expect(repairCalls).toBe(0);
    expect(outcome.healed).toBe(false);
  });

  test("PyRunResult 可作为值传递（类型冒烟）", () => {
    const sample: PyRunResult = { ok: true, stdout: "", stderr: "", exitCode: 0, durationMs: 1 };
    expect(sample.ok).toBe(true);
  });
});
