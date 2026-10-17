/**
 * BI-21.1 · target-verifier 测试（全 tmp workspace，不触真实仓库）。
 *
 * 覆盖（对齐卡面测试清单）：
 * - deliverables 三态：存在 / 缺失 / 内容缺失；mustContain 多条逐条核验；
 *   mustExist:false 容忍语义；嵌套相对路径；目录非文件；防作弊真实读盘
 *   （同实例两次 verify 之间删文件立即失败）。
 * - command：通过 / 非零退出 / 超时 / runner 抛错（注入 runner，strict 与
 *   best-effort 双态）；超时与退出码独立断言（exit 0 + timedOut 仍判失败）。
 * - predicate 直调：同步/异步/抛错/ctx 可用性。
 * - command 白名单：白名单外拒绝且不触达 runner；isCommandAllowed 谓词；
 *   runner 仅收到契约声明命令；运行期夹带命令被入口快照拒绝。
 * - gateOrThrow 双态；formatGaps 渲染（压平换行、截断、passed 文案）。
 * - 缺省 child_process runner 真实执行：printf 通过 / exit 3 / 超时预算。
 * - 汇总语义：任一 gap → passed:false；空契约放行；result 结构字段。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CommandCheckError,
  CommandNotAllowedError,
  DEFAULT_COMMAND_TIMEOUT_MS,
  TargetIncompleteError,
  TargetVerifier,
  type Check,
  type CommandRunOutcome,
  type CommandRunner,
  type TargetContract,
  type VerificationResult,
} from "./target-verifier";

// ---------- 测试基建：tmp workspace 与脚本化 runner ----------

const workspaces: string[] = [];

async function makeWorkspace(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bi-verifier-"));
  workspaces.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return dir;
}

afterEach(async () => {
  const dirs = workspaces.splice(0);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

interface RunnerCall {
  command: string;
  opts: { timeoutMs: number; cwd: string };
}

const PASS: CommandRunOutcome = { exitCode: 0, stdout: "ok", stderr: "", timedOut: false };

/** 脚本化假 runner：按命令串回放 outcome（Error 则拒绝），并记录全部调用。 */
function scriptedRunner(script: Record<string, CommandRunOutcome | Error>): {
  runner: CommandRunner;
  calls: RunnerCall[];
} {
  const calls: RunnerCall[] = [];
  return {
    calls,
    runner: {
      async run(command, opts) {
        calls.push({ command, opts });
        const outcome = script[command];
        if (outcome instanceof Error) throw outcome;
        if (!outcome) throw new Error(`unexpected command: ${command}`);
        return outcome;
      },
    },
  };
}

function contract(overrides: Partial<TargetContract>): TargetContract {
  return { objective: "demo objective", deliverables: [], checks: [], ...overrides };
}

// ---------- deliverables：真实读盘 ----------

describe("deliverables 真实读盘", () => {
  test("产物存在且 mustContain 全命中 → passed true 无 gap", async () => {
    const ws = await makeWorkspace({ "report.md": "alpha beta gamma" });
    const result = await new TargetVerifier().verify(
      contract({
        deliverables: [{ path: "report.md", mustExist: true, mustContain: ["alpha", "gamma"] }],
      }),
      ws,
    );
    expect(result.passed).toBe(true);
    expect(result.gaps).toEqual([]);
  });

  test("产物缺失 → gap 结构化且 passed false", async () => {
    const ws = await makeWorkspace();
    const result = await new TargetVerifier().verify(
      contract({ deliverables: [{ path: "report.md", mustExist: true }] }),
      ws,
    );
    expect(result.passed).toBe(false);
    expect(result.gaps).toHaveLength(1);
    const gap = result.gaps[0]!;
    expect(gap.checkId).toBe("deliverable[0]:report.md");
    expect(gap.expected).toContain("report.md");
    expect(gap.actual).toContain("missing");
    expect(gap.actual).toContain(join(ws, "report.md"));
  });

  test("mustExist:false 且缺失 → 容忍，无 gap", async () => {
    const ws = await makeWorkspace();
    const result = await new TargetVerifier().verify(
      contract({ deliverables: [{ path: "ghost.md", mustExist: false }] }),
      ws,
    );
    expect(result.passed).toBe(true);
    expect(result.gaps).toEqual([]);
  });

  test("mustContain 部分命中 → 逐条核验，缺失子串独立成 gap", async () => {
    const ws = await makeWorkspace({ "a.md": "alpha only" });
    const result = await new TargetVerifier().verify(
      contract({
        deliverables: [{ path: "a.md", mustExist: true, mustContain: ["alpha", "omega"] }],
      }),
      ws,
    );
    expect(result.passed).toBe(false);
    expect(result.gaps).toHaveLength(1);
    const gap = result.gaps[0]!;
    expect(gap.checkId).toBe("deliverable[0]:a.md.mustContain[1]");
    expect(gap.expected).toContain('"omega"');
    expect(gap.actual).toContain("substring not found");
  });

  test("mustExist:false 缺失时跳过 mustContain（语义钉死：不存在即无从核内容）", async () => {
    const ws = await makeWorkspace();
    const result = await new TargetVerifier().verify(
      contract({ deliverables: [{ path: "ghost.md", mustExist: false, mustContain: ["x"] }] }),
      ws,
    );
    expect(result.passed).toBe(true);
    expect(result.gaps).toEqual([]);
  });

  test("防作弊：同实例两次 verify 之间文件被删 → 第二次立即失败（无内存缓存）", async () => {
    const ws = await makeWorkspace({ "live.md": "v1" });
    const c = contract({
      deliverables: [{ path: "live.md", mustExist: true, mustContain: ["v1"] }],
    });
    const verifier = new TargetVerifier();
    expect((await verifier.verify(c, ws)).passed).toBe(true);
    await rm(join(ws, "live.md"));
    const second = await verifier.verify(c, ws);
    expect(second.passed).toBe(false);
    expect(second.gaps[0]!.actual).toContain("missing");
  });

  test("路径是目录 → actual 指明非常规文件", async () => {
    const ws = await makeWorkspace();
    await mkdir(join(ws, "outdir"), { recursive: true });
    const result = await new TargetVerifier().verify(
      contract({ deliverables: [{ path: "outdir", mustExist: true }] }),
      ws,
    );
    expect(result.passed).toBe(false);
    expect(result.gaps[0]!.actual).toContain("not a regular file");
  });

  test("嵌套子目录相对路径按 workspaceRoot 解析", async () => {
    const ws = await makeWorkspace({ "src/deep/notes.md": "deep content" });
    const result = await new TargetVerifier().verify(
      contract({ deliverables: [{ path: "src/deep/notes.md", mustExist: true, mustContain: ["deep"] }] }),
      ws,
    );
    expect(result.passed).toBe(true);
  });
});

// ---------- command checks（注入 runner）----------

describe("command checks（注入 runner）", () => {
  test("exit 0 → 通过；runner 收到命令串、cwd 与 timeoutMs", async () => {
    const ws = await makeWorkspace();
    const { runner, calls } = scriptedRunner({ "bun test pkg": PASS });
    const result = await new TargetVerifier().verify(
      contract({ checks: [{ id: "t", kind: "command", command: "bun test pkg", description: "tests" }] }),
      ws,
      { runner, commandTimeoutMs: 1234 },
    );
    expect(result.passed).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("bun test pkg");
    expect(calls[0]!.opts.cwd).toBe(ws);
    expect(calls[0]!.opts.timeoutMs).toBe(1234);
  });

  test("非零退出 + strict（缺省）→ 抛 CommandCheckError，含 checkId 与 outcome", async () => {
    const ws = await makeWorkspace();
    const { runner } = scriptedRunner({
      bad: { exitCode: 2, stdout: "", stderr: "boom", timedOut: false },
    });
    let caught: unknown;
    try {
      await new TargetVerifier().verify(
        contract({ checks: [{ id: "t", kind: "command", command: "bad", description: "d" }] }),
        ws,
        { runner },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CommandCheckError);
    expect((caught as CommandCheckError).checkId).toBe("t");
    expect((caught as CommandCheckError).outcome.exitCode).toBe(2);
  });

  test("非零退出 + best-effort → 降级为 gap 而非抛", async () => {
    const ws = await makeWorkspace();
    const { runner } = scriptedRunner({
      bad: { exitCode: 1, stdout: "", stderr: "", timedOut: false },
    });
    const result = await new TargetVerifier().verify(
      contract({
        tolerance: "best-effort",
        checks: [{ id: "t", kind: "command", command: "bad", description: "d" }],
      }),
      ws,
      { runner },
    );
    expect(result.passed).toBe(false);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]!.checkId).toBe("t");
    expect(result.gaps[0]!.actual).toContain("exit 1");
  });

  test("超时独立断言：exit 0 但 timedOut=true → strict 仍判失败", async () => {
    const ws = await makeWorkspace();
    const { runner } = scriptedRunner({
      hang: { exitCode: 0, stdout: "late output", stderr: "", timedOut: true },
    });
    let caught: unknown;
    try {
      await new TargetVerifier().verify(
        contract({ checks: [{ id: "t", kind: "command", command: "hang", description: "d" }] }),
        ws,
        { runner },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CommandCheckError);
    expect((caught as CommandCheckError).outcome.timedOut).toBe(true);
  });

  test("超时 + best-effort → gap expected 含预算、actual 含 timed out", async () => {
    const ws = await makeWorkspace();
    const { runner } = scriptedRunner({
      hang: { exitCode: null, stdout: "", stderr: "", timedOut: true },
    });
    const result = await new TargetVerifier().verify(
      contract({
        tolerance: "best-effort",
        checks: [{ id: "t", kind: "command", command: "hang", description: "d" }],
      }),
      ws,
      { runner, commandTimeoutMs: 150 },
    );
    expect(result.passed).toBe(false);
    expect(result.gaps[0]!.expected).toContain("150ms");
    expect(result.gaps[0]!.actual).toContain("timed out");
  });

  test("runner 抛错 + strict → CommandCheckError（exitCode=null，stderr 记录原因）", async () => {
    const ws = await makeWorkspace();
    const { runner } = scriptedRunner({ "err-cmd": new Error("spawn gone") });
    let caught: unknown;
    try {
      await new TargetVerifier().verify(
        contract({ checks: [{ id: "t", kind: "command", command: "err-cmd", description: "d" }] }),
        ws,
        { runner },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CommandCheckError);
    expect((caught as CommandCheckError).outcome.exitCode).toBeNull();
    expect((caught as CommandCheckError).outcome.stderr).toContain("runner threw: spawn gone");
  });

  test("runner 抛错 + best-effort → 降级为 runner failure gap", async () => {
    const ws = await makeWorkspace();
    const { runner } = scriptedRunner({ "err-cmd": new Error("spawn gone") });
    const result = await new TargetVerifier().verify(
      contract({
        tolerance: "best-effort",
        checks: [{ id: "t", kind: "command", command: "err-cmd", description: "d" }],
      }),
      ws,
      { runner },
    );
    expect(result.passed).toBe(false);
    expect(result.gaps[0]!.actual).toContain("runner failure");
  });

  test("stdout/stderr 捕获：失败 gap 的 actual 携带输出尾部", async () => {
    const ws = await makeWorkspace();
    const { runner } = scriptedRunner({
      noisy: { exitCode: 7, stdout: "partial-stdout-marker", stderr: "partial-stderr-marker", timedOut: false },
    });
    const result = await new TargetVerifier().verify(
      contract({
        tolerance: "best-effort",
        checks: [{ id: "t", kind: "command", command: "noisy", description: "d" }],
      }),
      ws,
      { runner },
    );
    expect(result.gaps[0]!.actual).toContain("partial-stdout-marker");
    expect(result.gaps[0]!.actual).toContain("partial-stderr-marker");
  });
});

// ---------- predicate checks（直调注入函数）----------

describe("predicate checks（直调注入函数）", () => {
  test("同步 predicate 返回 true → 通过", async () => {
    const ws = await makeWorkspace();
    const result = await new TargetVerifier().verify(
      contract({
        checks: [{ id: "p", kind: "predicate", predicate: () => true, description: "always ok" }],
      }),
      ws,
    );
    expect(result.passed).toBe(true);
  });

  test("异步 predicate 返回 false → gap 结构（expected 含 description）", async () => {
    const ws = await makeWorkspace();
    const result = await new TargetVerifier().verify(
      contract({
        checks: [
          { id: "p", kind: "predicate", predicate: async () => false, description: "always says no" },
        ],
      }),
      ws,
    );
    expect(result.passed).toBe(false);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]!.checkId).toBe("p");
    expect(result.gaps[0]!.expected).toContain("always says no");
    expect(result.gaps[0]!.actual).toContain("predicate returned false");
  });

  test("predicate 抛错 → gap actual 记录 predicate threw", async () => {
    const ws = await makeWorkspace();
    const result = await new TargetVerifier().verify(
      contract({
        checks: [
          {
            id: "p",
            kind: "predicate",
            predicate: () => {
              throw new Error("predicate exploded");
            },
            description: "d",
          },
        ],
      }),
      ws,
    );
    expect(result.passed).toBe(false);
    expect(result.gaps[0]!.actual).toContain("predicate threw: predicate exploded");
  });

  test("predicate 收到 ctx.workspaceRoot 且可用其真实读盘；ctx.contract 原样透传", async () => {
    const ws = await makeWorkspace({ "ctx.txt": "hello-ctx" });
    const c = contract({
      checks: [
        {
          id: "p",
          kind: "predicate",
          predicate: async (ctx) => {
            if (ctx.contract !== c) return false;
            const content = await readFile(join(ctx.workspaceRoot, "ctx.txt"), "utf8");
            return content.includes("hello-ctx");
          },
          description: "reads ctx workspace",
        },
      ],
    });
    const result = await new TargetVerifier().verify(c, ws);
    expect(result.passed).toBe(true);
  });
});

// ---------- command 白名单（防诱导执行任意命令）----------

describe("command 白名单（防诱导执行任意命令）", () => {
  test("白名单外命令经 runCommandCheck → CommandNotAllowedError 且 runner 未被触达", async () => {
    const ws = await makeWorkspace();
    const c = contract({
      checks: [{ id: "legit", kind: "command", command: "echo ok", description: "d" }],
    });
    const { runner, calls } = scriptedRunner({});
    const evil: Check = { id: "evil", kind: "command", command: "rm -rf /", description: "smuggled" };
    await expect(new TargetVerifier().runCommandCheck(c, evil, ws, { runner })).rejects.toBeInstanceOf(
      CommandNotAllowedError,
    );
    expect(calls).toHaveLength(0);
  });

  test("isCommandAllowed：契约声明命令 true，任意串 false；缺省限时 60s", () => {
    const c = contract({
      checks: [{ id: "ok", kind: "command", command: "echo ok", description: "d" }],
    });
    const v = new TargetVerifier();
    expect(v.isCommandAllowed(c, "echo ok")).toBe(true);
    expect(v.isCommandAllowed(c, "rm -rf /")).toBe(false);
    expect(v.isCommandAllowed(c, "echo ok; rm -rf /")).toBe(false);
    expect(DEFAULT_COMMAND_TIMEOUT_MS).toBe(60_000);
  });

  test("runner 仅收到契约 verbatim 声明的命令串", async () => {
    const ws = await makeWorkspace();
    const { runner, calls } = scriptedRunner({ "cmd-a": PASS, "cmd-b": PASS });
    const result = await new TargetVerifier().verify(
      contract({
        checks: [
          { id: "a", kind: "command", command: "cmd-a", description: "d" },
          { id: "b", kind: "command", command: "cmd-b", description: "d" },
        ],
      }),
      ws,
      { runner },
    );
    expect(result.passed).toBe(true);
    expect(calls.map((call) => call.command)).toEqual(["cmd-a", "cmd-b"]);
  });

  test("运行期向 contract.checks 夹带命令 → 入口白名单快照拒绝，命令不触达 runner", async () => {
    const ws = await makeWorkspace();
    const { runner, calls } = scriptedRunner({ "ok-cmd": PASS });
    const c = contract({
      checks: [{ id: "c1", kind: "command", command: "ok-cmd", description: "d" }],
    });
    const poisoned: CommandRunner = {
      async run(command, opts) {
        const outcome = await runner.run(command, opts);
        c.checks.push({ id: "evil", kind: "command", command: "rm -rf /", description: "smuggled" });
        return outcome;
      },
    };
    await expect(
      new TargetVerifier().verify(c, ws, { runner: poisoned }),
    ).rejects.toBeInstanceOf(CommandNotAllowedError);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("ok-cmd");
  });
});

// ---------- gateOrThrow / formatGaps ----------

describe("gateOrThrow 与 formatGaps", () => {
  test("gateOrThrow passed → 原样返回同一 result 引用", async () => {
    const ws = await makeWorkspace();
    const result = await new TargetVerifier().verify(contract({}), ws);
    expect(new TargetVerifier().gateOrThrow(result)).toBe(result);
  });

  test("gateOrThrow failed → TargetIncompleteError，gaps 与 result.gaps 等价", async () => {
    const ws = await makeWorkspace();
    const result = await new TargetVerifier().verify(
      contract({
        checks: [{ id: "p", kind: "predicate", predicate: () => false, description: "d" }],
      }),
      ws,
    );
    let caught: unknown;
    try {
      new TargetVerifier().gateOrThrow(result);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TargetIncompleteError);
    expect((caught as TargetIncompleteError).gaps).toEqual(result.gaps);
    expect((caught as Error).message).toContain("target incomplete");
  });

  test("formatGaps：渲染 gap 数、checkId/expected/actual，多行输出", () => {
    const result: VerificationResult = {
      passed: false,
      ranAt: new Date().toISOString(),
      durationMs: 1,
      gaps: [
        {
          checkId: "deliverable[0]:a.md",
          expected: "file exists: a.md",
          actual: "missing (resolved: /tmp/x/a.md)",
        },
        { checkId: "pred", expected: 'predicate "p" returns true', actual: "predicate returned false" },
      ],
    };
    const text = new TargetVerifier().formatGaps(result);
    expect(text).toContain("target incomplete: 2 gap(s)");
    expect(text).toContain("- [deliverable[0]:a.md] expected: file exists: a.md; actual: missing");
    expect(text).toContain("- [pred] expected: predicate \"p\" returns true; actual: predicate returned false");
    expect(text).toContain("\n");
  });

  test("formatGaps：多行值压平为 \\n 字面量、超长截断", () => {
    const result: VerificationResult = {
      passed: false,
      ranAt: new Date().toISOString(),
      durationMs: 1,
      gaps: [
        { checkId: "c1", expected: "x", actual: "line1\nline2" },
        { checkId: "c2", expected: "y", actual: "a".repeat(400) },
      ],
    };
    const text = new TargetVerifier().formatGaps(result);
    expect(text).toContain("line1\\nline2");
    expect(text).toContain("…(truncated)");
  });

  test("formatGaps：passed → all checks passed 文案", () => {
    const text = new TargetVerifier().formatGaps({
      passed: true,
      gaps: [],
      ranAt: new Date().toISOString(),
      durationMs: 0,
    });
    expect(text).toContain("all checks passed");
  });
});

// ---------- 缺省 child_process runner（真实执行）----------

describe("缺省 child_process runner（真实执行）", () => {
  test("printf 命令 exit 0 → passed true", async () => {
    const ws = await makeWorkspace();
    const result = await new TargetVerifier().verify(
      contract({
        checks: [{ id: "d1", kind: "command", command: "printf verifier-ok", description: "d" }],
      }),
      ws,
    );
    expect(result.passed).toBe(true);
  });

  test("exit 3 → best-effort gap actual 含 exit 3", async () => {
    const ws = await makeWorkspace();
    const result = await new TargetVerifier().verify(
      contract({
        tolerance: "best-effort",
        checks: [{ id: "d2", kind: "command", command: "exit 3", description: "d" }],
      }),
      ws,
    );
    expect(result.passed).toBe(false);
    expect(result.gaps[0]!.actual).toContain("exit 3");
  });

  test("超时预算生效：sleep 2 @200ms → gap actual 含 timed out 且提前杀进程", async () => {
    const ws = await makeWorkspace();
    const result = await new TargetVerifier().verify(
      contract({
        tolerance: "best-effort",
        checks: [{ id: "d3", kind: "command", command: "sleep 2", description: "d" }],
      }),
      ws,
      { commandTimeoutMs: 200 },
    );
    expect(result.passed).toBe(false);
    expect(result.gaps[0]!.actual).toContain("timed out");
    expect(result.durationMs).toBeLessThan(1900);
  });
});

// ---------- 汇总语义 ----------

describe("汇总语义", () => {
  test("任一 gap → passed false：deliverable 缺失与 predicate 失败汇总为 2 gaps（①→② 顺序）", async () => {
    const ws = await makeWorkspace();
    const result = await new TargetVerifier().verify(
      contract({
        deliverables: [{ path: "absent.md", mustExist: true }],
        checks: [{ id: "p", kind: "predicate", predicate: () => false, description: "d" }],
      }),
      ws,
    );
    expect(result.passed).toBe(false);
    expect(result.gaps).toHaveLength(2);
    expect(result.gaps[0]!.checkId).toBe("deliverable[0]:absent.md");
    expect(result.gaps[1]!.checkId).toBe("p");
  });

  test("空契约（无产物无检查）→ passed true 放行", async () => {
    const ws = await makeWorkspace();
    const result = await new TargetVerifier().verify(contract({}), ws);
    expect(result.passed).toBe(true);
    expect(result.gaps).toEqual([]);
  });

  test("result 结构字段：ranAt 为可解析 ISO、durationMs ≥ 0", async () => {
    const ws = await makeWorkspace();
    const result = await new TargetVerifier().verify(contract({}), ws);
    expect(Number.isNaN(Date.parse(result.ranAt))).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
