/**
 * BI-14 · 声明式 DAG 工作流调度引擎测试。
 *
 * 覆盖工单钉死的测试矩阵：
 * 1. DSL 解析矩阵：单步/依赖链/内联与块列表 depends_on/params 标量宽表/
 *    引号转义/注释剔除，及 missing-steps/empty-steps/bad-step/unknown-field/
 *    duplicate-step/unknown-dep/bad-indent 结构化错误；
 * 2. 环检测：二步环、自依赖 → cycle-detected；
 * 3. 并行层调度：跨层串行（执行序断言）、同层并发（栅栏互等，串行实现必死锁）、
 *    上游 results 透传、params 透传；
 * 4. checkpoint 往返：store 内 kind='wf-step'、completed、结果信封可取回；
 * 5. 重启续跑模拟：实例 A running 孤儿弃置 → 实例 B recover() 重放续跑
 *    （首层不重跑、中断步重跑、剩余层完成）；deferred 断点解包续跑；
 *    文件 SQLite 新连接新实例（完成步不重跑）；
 * 6. 失败步传播：上游失败 → 下游 skipped，无关支路照常；幂等重跑；
 *    并发 run 拒绝；手工坏 spec 结构化抛出。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDurableStore, SqliteDurableStore } from "./durable/storage";
import { DurableScheduler } from "./durable/durable-scheduler";
import type { DurableStore } from "./durable/storage";
import {
  DagEngine,
  STEP_MAX_ATTEMPTS,
  WF_STEP_KIND,
  WorkflowParseError,
  asOutcome,
  makeWfStepHandler,
  parseWorkflow,
  stepTaskId,
} from "./engine";
import type { StepHandler, WorkflowSpec } from "./engine";

/** 虚拟时钟（与 scheduler 同源注入；引擎无退避路径，恒定时刻即可）。 */
function virtualTime(start = 1_700_000_000_000) {
  let now = start;
  return { clock: () => now, now: () => now };
}

/** 装配一台引擎（Memory 底座 + wf-step 适配器注册 + 同源虚拟时钟）。 */
function rig(handlers: Record<string, StepHandler>, store: DurableStore = new MemoryDurableStore()) {
  const vt = virtualTime();
  const scheduler = new DurableScheduler({
    store,
    handlers: { [WF_STEP_KIND]: makeWfStepHandler(handlers) },
    clock: vt.clock,
    sleep: async () => {},
  });
  const engine = new DagEngine({ scheduler, handlers, clock: vt.clock });
  return { engine, scheduler, store };
}

/** 互等栅栏：n 个 waiter 全到齐才放行（串行执行会永久挂起 → 测试超时即失败）。 */
function latch(n: number) {
  let remaining = n;
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return {
    wait: async () => {
      remaining--;
      if (remaining === 0) release();
      await promise;
    },
  };
}

/** 轮询等待条件成立（真实时钟小睡；上限 1s 防挂死）。 */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) {
    await new Promise((r) => setTimeout(r, 2));
  }
  if (!cond()) throw new Error(`等待超时：${what}`);
}

/** 断言同步调用抛出指定 code 的 WorkflowParseError（bun toThrow 不认谓词函数）。 */
function expectParseCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(WorkflowParseError);
  expect((caught as WorkflowParseError).code).toBe(code);
}

/** 断言 Promise 拒绝且错误带指定 code 字段（结构化错误判别）。 */
async function expectRejectCode(p: Promise<unknown>, code: string): Promise<unknown> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as { code?: string }).code).toBe(code);
  return caught;
}

// ---------------------------------------------------------------------------
// parseWorkflow
// ---------------------------------------------------------------------------

describe("BI-14 · parseWorkflow（最小 YAML 子集）", () => {
  test("最小单步：depends_on 缺省 []、params 缺省 {}", () => {
    const spec = parseWorkflow("steps:\n  - id: solo\n    run: run.solo\n");
    expect(spec.steps).toEqual([
      { id: "solo", run: "run.solo", depends_on: [], params: {} },
    ]);
  });

  test("依赖链：depends_on 内联 [a, b] 保持书写顺序", () => {
    const spec = parseWorkflow(
      "steps:\n  - id: b\n    run: rb\n    depends_on: [a, c]\n  - id: a\n    run: ra\n  - id: c\n    run: rc\n",
    );
    expect(spec.steps[0]!.depends_on).toEqual(["a", "c"]);
    expect(spec.steps.map((s) => s.id)).toEqual(["b", "a", "c"]);
  });

  test("depends_on 块列表形态（- 项逐行）", () => {
    const spec = parseWorkflow(
      "steps:\n  - id: c\n    run: rc\n    depends_on:\n      - a\n      - b\n  - id: a\n    run: ra\n  - id: b\n    run: rb\n",
    );
    expect(spec.steps[0]!.depends_on).toEqual(["a", "b"]);
  });

  test("params 标量宽表：字符串/整数/浮点/布尔/null", () => {
    const spec = parseWorkflow(
      [
        "steps:",
        "  - id: s",
        "    run: rs",
        "    params:",
        "      name: hello world",
        "      n: 42",
        "      pi: 3.14",
        "      flag: true",
        "      nothing: null",
      ].join("\n"),
    );
    expect(spec.steps[0]!.params).toEqual({
      name: "hello world",
      n: 42,
      pi: 3.14,
      flag: true,
      nothing: null,
    });
  });

  test("引号字符串：单引号 '' 转义、双引号 \\n \\t 转义", () => {
    const spec = parseWorkflow(
      [
        "steps:",
        "  - id: s",
        "    run: rs",
        "    params:",
        "      a: 'it''s ok'",
        '      b: "line\\nbreak\\ttab"',
      ].join("\n"),
    );
    expect(spec.steps[0]!.params).toEqual({ a: "it's ok", b: "line\nbreak\ttab" });
  });

  test("注释与空行剔除：整行 #、行尾 #；引号内 # 不切", () => {
    const spec = parseWorkflow(
      [
        "# 头部注释",
        "steps:  # 行尾注释",
        "  - id: s   # 步骤注释",
        "    run: rs",
        "    params:",
        '      hash: "a # b"',
        "",
        "# 尾部注释",
      ].join("\n"),
    );
    expect(spec.steps).toHaveLength(1);
    expect(spec.steps[0]!.params).toEqual({ hash: "a # b" });
  });

  test("缺顶层 steps → missing-steps", () => {
    expectParseCode(() => parseWorkflow("pipeline:\n  - id: s\n"), "missing-steps");
  });

  test("steps 下零条目 → empty-steps", () => {
    expectParseCode(() => parseWorkflow("steps:\n"), "empty-steps");
  });

  test("步骤缺 run / 缺 id → bad-step", () => {
    expectParseCode(() => parseWorkflow("steps:\n  - id: s\n"), "bad-step");
    expectParseCode(() => parseWorkflow("steps:\n  - run: rs\n"), "bad-step");
  });

  test("未知字段 → unknown-field；重复字段 → duplicate-field", () => {
    expectParseCode(
      () => parseWorkflow("steps:\n  - id: s\n    run: r\n    when: now\n"),
      "unknown-field",
    );
    expectParseCode(
      () => parseWorkflow("steps:\n  - id: s\n    run: r\n    run: r2\n"),
      "duplicate-field",
    );
  });

  test("重复 id → duplicate-step；未知依赖 → unknown-dep", () => {
    expectParseCode(
      () => parseWorkflow("steps:\n  - id: s\n    run: r\n  - id: s\n    run: r2\n"),
      "duplicate-step",
    );
    expectParseCode(
      () => parseWorkflow("steps:\n  - id: s\n    run: r\n    depends_on: [ghost]\n"),
      "unknown-dep",
    );
  });

  test("二步环 → cycle-detected", () => {
    const err = (() => {
      try {
        parseWorkflow(
          "steps:\n  - id: a\n    run: ra\n    depends_on: [b]\n  - id: b\n    run: rb\n    depends_on: [a]\n",
        );
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(WorkflowParseError);
    expect((err as WorkflowParseError).code).toBe("cycle-detected");
  });

  test("自依赖 → cycle-detected", () => {
    expectParseCode(
      () => parseWorkflow("steps:\n  - id: a\n    run: ra\n    depends_on: [a]\n"),
      "cycle-detected",
    );
  });

  test("Tab 缩进 → bad-indent", () => {
    expectParseCode(() => parseWorkflow("steps:\n\t- id: s\n"), "bad-indent");
  });
});

// ---------------------------------------------------------------------------
// DagEngine
// ---------------------------------------------------------------------------

describe("BI-14 · DagEngine", () => {
  test("单步 run：完成、outputs 收集、store 落库断言（kind/state/attempts/checkpoint 信封）", async () => {
    const { engine, store } = rig({ solo: () => 42 });
    const result = await engine.run("w1", parseWorkflow("steps:\n  - id: solo\n    run: solo\n"));
    expect(result.status).toBe("completed");
    expect(result.outputs).toEqual({ solo: 42 });
    expect(result.skipped).toEqual([]);
    const rec = store.get(stepTaskId("w1", "solo"))!;
    expect(rec.kind).toBe(WF_STEP_KIND);
    expect(rec.state).toBe("completed");
    expect(rec.attempts).toBe(1);
    expect(rec.maxAttempts).toBe(STEP_MAX_ATTEMPTS);
    expect(rec.checkpoint).toEqual({ ok: true, value: 42 });
  });

  test("菱形 DAG：跨层串行（执行序 a → [b, c] → d），d 依赖 b、c 的输出", async () => {
    const exec: string[] = [];
    const payloads = new Map<string, unknown>();
    const { engine } = rig({
      ra: (p) => {
        exec.push(p.step.id);
        return "A";
      },
      rb: (p) => {
        exec.push(p.step.id);
        payloads.set(p.step.id, p);
        return "B";
      },
      rc: (p) => {
        exec.push(p.step.id);
        payloads.set(p.step.id, p);
        return "C";
      },
      rd: (p) => {
        exec.push(p.step.id);
        payloads.set(p.step.id, p);
        return `${p.results.b}/${p.results.c}`;
      },
    });
    const spec = parseWorkflow(
      [
        "steps:",
        "  - id: a",
        "    run: ra",
        "  - id: b",
        "    run: rb",
        "    depends_on: [a]",
        "  - id: c",
        "    run: rc",
        "    depends_on: [a]",
        "  - id: d",
        "    run: rd",
        "    depends_on: [b, c]",
      ].join("\n"),
    );
    const result = await engine.run("diamond", spec);
    expect(result.status).toBe("completed");
    expect(result.outputs.d).toBe("B/C");
    // 跨层串行：a 最先，d 最后；b、c 同层（声明序）；d 拿到 b、c 的结果
    expect(exec).toEqual(["a", "b", "c", "d"]);
    const dPayload = payloads.get("d") as { results: Record<string, string> };
    expect(dPayload.results).toEqual({ b: "B", c: "C" });
  });

  test("同层并发：栅栏互等（两个无依赖步同时在场，串行实现必死锁）", async () => {
    const bar = latch(2);
    let maxInside = 0;
    let inside = 0;
    const probe = async (): Promise<string> => {
      inside++;
      maxInside = Math.max(maxInside, inside);
      await bar.wait();
      inside--;
      return "ok";
    };
    const { engine } = rig({ p1: probe, p2: probe });
    const result = await engine.run(
      "parallel",
      parseWorkflow("steps:\n  - id: x\n    run: p1\n  - id: y\n    run: p2\n"),
    );
    expect(result.status).toBe("completed");
    expect(maxInside).toBe(2);
  });

  test("上游 results 透传下游（直接依赖输出按依赖 id 注入）", async () => {
    let seen: unknown = null;
    const { engine } = rig({
      src: () => ({ value: 7, tag: "src" }),
      dst: (p) => {
        seen = p.results;
        return (p.results.src as { value: number }).value;
      },
    });
    const result = await engine.run(
      "pipe",
      parseWorkflow(
        "steps:\n  - id: src\n    run: src\n  - id: dst\n    run: dst\n    depends_on: [src]\n",
      ),
    );
    expect(result.status).toBe("completed");
    expect(seen).toEqual({ src: { value: 7, tag: "src" } });
    expect(result.outputs.dst).toBe(7);
  });

  test("params 透传 handler", async () => {
    let got: unknown = null;
    const { engine } = rig({
      work: (p) => {
        got = p.step.params;
        return null;
      },
    });
    await engine.run(
      "w",
      parseWorkflow(
        "steps:\n  - id: s\n    run: work\n    params:\n      q: dag\n      limit: 5\n",
      ),
    );
    expect(got).toEqual({ q: "dag", limit: 5 });
  });

  test("失败步传播：handler 抛错 → failed / failedStep / error / 下游 skipped", async () => {
    const exec: string[] = [];
    const { engine } = rig({
      ok1: (p) => {
        exec.push(p.step.id);
        return 1;
      },
      boom: (p) => {
        exec.push(p.step.id);
        throw new Error("boom!");
      },
      ok2: (p) => {
        exec.push(p.step.id);
        return 3;
      },
      tail: (p) => {
        exec.push(p.step.id);
        return 4;
      },
    });
    const spec = parseWorkflow(
      [
        "steps:",
        "  - id: a",
        "    run: ok1",
        "  - id: b",
        "    run: boom",
        "    depends_on: [a]",
        "  - id: c",
        "    run: ok2",
        "    depends_on: [a]",
        "  - id: d",
        "    run: tail",
        "    depends_on: [b]",
      ].join("\n"),
    );
    const result = await engine.run("wfail", spec);
    expect(result.status).toBe("failed");
    expect(result.failedStep).toBe("b");
    expect(result.error).toContain("boom!");
    expect(result.skipped).toEqual(["d"]);
    expect(Object.keys(result.outputs).sort()).toEqual(["a", "c"]);
    // 无关支路 c 不受失败影响
    expect(exec).toEqual(["a", "b", "c"]);
  });

  test("失败步的兄弟层与独立支路照常完成；恢复后失败不重跑（信封已落库）", async () => {
    let boomCalls = 0;
    const { engine } = rig({
      bad: () => {
        boomCalls++;
        throw new Error("always");
      },
      good: () => "g",
    });
    const spec = parseWorkflow(
      "steps:\n  - id: bad\n    run: bad\n  - id: good\n    run: good\n",
    );
    const first = await engine.run("wf2", spec);
    expect(first.status).toBe("failed");
    expect(first.failedStep).toBe("bad");
    expect(first.outputs).toEqual({ good: "g" });
    expect(boomCalls).toBe(1);
    const second = await engine.run("wf2", spec);
    expect(second.status).toBe("failed");
    expect(second.outputs).toEqual({ good: "g" });
    expect(boomCalls).toBe(1); // completed 短路：bad 的失败信封直接取回，不重执行
  });

  test("未注册 run handler → 步骤失败信封（不炸引擎）", async () => {
    const { engine } = rig({});
    const result = await engine.run(
      "w",
      parseWorkflow("steps:\n  - id: s\n    run: ghost\n"),
    );
    expect(result.status).toBe("failed");
    expect(result.failedStep).toBe("s");
    expect(result.error).toContain("ghost");
  });

  test("handler 返回 SuspendSignal 形体 → 结构化拒绝（不触发调度器挂起）", async () => {
    const { engine } = rig({
      sneaky: () => ({ done: false, checkpoint: "x" }),
    });
    const result = await engine.run("w", parseWorkflow("steps:\n  - id: s\n    run: sneaky\n"));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("挂起协议冲突");
    const rec = engine.store.get(stepTaskId("w", "s"))!;
    expect(rec.state).toBe("completed"); // 信封落库，任务不悬置
  });

  test("幂等重跑：同 workflowId 二次 run，已完成步不重复执行、outputs 复原", async () => {
    let calls = 0;
    const { engine } = rig({ once: () => {
      calls++;
      return calls;
    } });
    const spec = parseWorkflow("steps:\n  - id: s\n    run: once\n");
    const first = await engine.run("w3", spec);
    const second = await engine.run("w3", spec);
    expect(first.outputs).toEqual({ s: 1 });
    expect(second.outputs).toEqual({ s: 1 });
    expect(calls).toBe(1);
  });

  test("并发 run 拒绝（engine-busy）", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const { engine } = rig({
      slow: async () => {
        await held;
        return "slow";
      },
    });
    const first = engine.run("w4", parseWorkflow("steps:\n  - id: s\n    run: slow\n"));
    await until(() => engine.store.get(stepTaskId("w4", "s"))?.state === "running", "慢步认领");
    await expectRejectCode(
      engine.run("w4b", parseWorkflow("steps:\n  - id: t\n    run: slow\n")),
      "engine-busy",
    );
    release();
    const result = await first;
    expect(result.status).toBe("completed");
  });

  test("重启续跑：实例 A running 孤儿弃置 → 实例 B recover() 重放续跑", async () => {
    const store = new MemoryDurableStore();
    const counts = { a: 0 };
    let bStarted = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => (releaseGate = r));
    const handlers: Record<string, StepHandler> = {
      ha: () => {
        counts.a++;
        return "A";
      },
      hb: async () => {
        bStarted++;
        await gate;
        return "B";
      },
    };
    const vt = virtualTime();
    const mkScheduler = () =>
      new DurableScheduler({
        store,
        handlers: { [WF_STEP_KIND]: makeWfStepHandler(handlers) },
        clock: vt.clock,
        sleep: async () => {},
      });
    const engineA = new DagEngine({ scheduler: mkScheduler(), handlers, clock: vt.clock });
    const engineB = new DagEngine({ scheduler: mkScheduler(), handlers, clock: vt.clock });
    const spec = parseWorkflow(
      "steps:\n  - id: a\n    run: ha\n  - id: b\n    run: hb\n    depends_on: [a]\n",
    );

    const runA = engineA.run("wf5", spec); // 实例 A：驱动到 b 后悬置（模拟进程死亡）
    await until(() => bStarted === 1, "A 驱动到步骤 b");
    expect(store.get(stepTaskId("wf5", "b"))!.state).toBe("running"); // 崩溃孤儿

    const recoverB = engineB.recover("wf5", spec); // 实例 B 接手（A 已弃置）
    await until(() => bStarted === 2, "B 重放中断步 b");
    releaseGate(); // 放行栅栏：B 的 b 重跑完成（A 的旧 handler 返回被状态守卫丢弃）
    const resultB = await recoverB;
    expect(resultB.status).toBe("completed");
    expect(resultB.outputs).toEqual({ a: "A", b: "B" });
    const runAOutcome = await runA; // A 的悬置 run 收敛（b 取回库内权威 checkpoint）
    expect(runAOutcome.status).toBe("completed");
    expect(runAOutcome.outputs).toEqual({ a: "A", b: "B" });

    expect(counts.a).toBe(1); // 首层已完成步不重跑
    expect(bStarted).toBe(2); // 中断步重跑恰一次
    const rec = store.get(stepTaskId("wf5", "b"))!;
    expect(rec.state).toBe("completed");
    expect(rec.attempts).toBe(2); // 1 段崩溃 + 1 段重放
    expect(rec.checkpoint).toEqual({ ok: true, value: "B" });
  });

  test("提交后未认领的 pending 断点 → recover 续跑执行", async () => {
    const { engine, scheduler, store } = rig({ late: () => "L" });
    const spec: WorkflowSpec = parseWorkflow("steps:\n  - id: a\n    run: late\n");
    // 手工制造崩溃窗口：wf-step 任务已落 pending（submit 口），认领前进程死亡
    const payload = {
      workflowId: "wf6",
      stepId: "a",
      run: "late",
      params: {},
      dependsOn: [] as string[],
      results: {} as Record<string, string>,
    };
    const id = stepTaskId("wf6", "a");
    scheduler.submit(WF_STEP_KIND, payload, { id, maxAttempts: STEP_MAX_ATTEMPTS });
    expect(store.get(id)!.state).toBe("pending");

    const result = await engine.recover("wf6", spec);
    expect(result.status).toBe("completed");
    expect(result.outputs).toEqual({ a: "L" });
    const rec = store.get(id)!;
    expect(rec.state).toBe("completed");
    expect(rec.attempts).toBe(1); // 认领即执行段 +1
    expect(rec.checkpoint).toEqual({ ok: true, value: "L" });
  });

  test("文件 SQLite 重启：新连接新实例，完成步不重跑、outputs 复原", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bi-dag-engine-"));
    const path = join(dir, "tasks.db");
    let calls = 0;
    const handlers: Record<string, StepHandler> = {
      w: () => {
        calls++;
        return "done";
      },
    };
    try {
      const storeA = new SqliteDurableStore(path);
      const engineA = rig(handlers, storeA).engine;
      const first = await engineA.run("wf7", parseWorkflow("steps:\n  - id: s\n    run: w\n"));
      expect(first.status).toBe("completed");
      storeA.close();

      const storeB = new SqliteDurableStore(path); // "进程重启"：全新连接
      const engineB = rig(handlers, storeB).engine;
      const second = await engineB.run("wf7", parseWorkflow("steps:\n  - id: s\n    run: w\n"));
      expect(second.outputs).toEqual({ s: "done" });
      expect(calls).toBe(1); // 凭落盘 checkpoint 短路，不重执行
      storeB.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("手工坏 spec 交给 engine.run：环 / 空 / 未知依赖 → 结构化抛出", async () => {
    const { engine } = rig({ x: () => 1 });
    await expectRejectCode(
      engine.run("w", {
        steps: [
          { id: "a", run: "x", depends_on: ["b"] },
          { id: "b", run: "x", depends_on: ["a"] },
        ],
      }),
      "cycle-detected",
    );
    await expectRejectCode(engine.run("w", { steps: [] }), "empty-steps");
    await expectRejectCode(
      engine.run("w", { steps: [{ id: "a", run: "x", depends_on: ["ghost"] }] }),
      "unknown-dep",
    );
  });

  test("asOutcome：非信封 checkpoint 防御性折为失败（手工篡改库内记录）", () => {
    const flipped = asOutcome("plain-string");
    expect(flipped.ok).toBe(false);
    if (flipped.ok) throw new Error("应为失败信封");
    expect(flipped.error).toContain("非步骤结果信封");
  });
});
