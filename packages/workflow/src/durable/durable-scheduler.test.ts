/**
 * BI-14.5 · 崩溃自愈持久化调度器测试（全 tmp，时钟/睡眠注入可加速）。
 *
 * 覆盖工单钉死的测试矩阵：
 * 1. submit 落 pending（checkpoint=payload、attempts=0、handler-missing fail-fast）；
 * 2. run 主循环：完成留痕（返回值即 checkpoint）、挂起续跑（checkpoint 演进）、
 *    退避重试（sleep 序列 10→20 指数退避）、终态 failed（attempts 耗尽）、重入拒绝；
 * 3. 崩溃模拟：实例 A running 中弃 → 实例 B recover() 重放续跑至 completed；
 *    fail 策略标终态；attempts 耗尽不重放（防崩溃死循环）；分页 recover；
 * 4. 长定时器分片：3×MAX_TIMER_DELAY 恰 3 片睡眠到点转 running 至完成；
 *    run() 不抢 deferred 任务；
 * 5. awaitSettled 多 waiter 终态汇聚（resolve / 全拒绝 / 已终态立即返回）；
 * 6. 两 store 等价性（同场景脚本最终快照一致）与 600 任务分页全量拉齐。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDurableStore, SqliteDurableStore } from "./storage";
import type { DurableStore } from "./storage";
import {
  DurableScheduler,
  DurableSchedulerError,
  MAX_TIMER_DELAY,
  deferredCheckpoint,
} from "./durable-scheduler";
import type { JsonValue, TaskRecord } from "./task-state";
import type { SuspendSignal } from "./durable-scheduler";

/** 虚拟时钟：睡眠即拨钟（退避/分片零等待，sleep 序列可断言）。 */
function virtualTime(start = 1_700_000_000_000) {
  let now = start;
  const sleeps: number[] = [];
  return {
    clock: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
    now: () => now,
  };
}

/** tmp 文件 SQLite 库（端到端走真实文件 + WAL），随 cleanup 删除。 */
function tmpSqlite(): { store: SqliteDurableStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "bi-durable-sched-"));
  const store = new SqliteDurableStore(join(dir, "tasks.db"));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 按 id 升序拍全库快照（等价性比对用）。 */
function snapshot(store: DurableStore): Array<TaskRecord | null> {
  return ["s-boom", "s-comp", "s-orphan", "s-susp"]
    .map((id) => store.get(id));
}

describe("BI-14.5 DurableScheduler 提交与主循环", () => {
  test("submit 落 pending：checkpoint=payload、attempts=0、缺省 maxAttempts=3、updatedAt=注入时钟", () => {
    const vt = virtualTime();
    const store = new MemoryDurableStore();
    const sched = new DurableScheduler({
      store,
      clock: vt.clock,
      sleep: vt.sleep,
      handlers: { job: async () => "ok" },
    });
    const record = sched.submit("job", { x: 1 }, { id: "t1" });
    expect(record).toEqual({
      id: "t1",
      kind: "job",
      state: "pending",
      checkpoint: { x: 1 },
      attempts: 0,
      maxAttempts: 3,
      updatedAt: 1_700_000_000_000,
    });
    expect(store.get("t1")).toEqual(record);
  });

  test("submit 未注册 kind → 结构化报错 handler-missing（提交口 fail-fast，不落库）", () => {
    const sched = new DurableScheduler({
      store: new MemoryDurableStore(),
      handlers: { job: async () => "ok" },
    });
    try {
      sched.submit("ghost", null);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DurableSchedulerError);
      expect((error as DurableSchedulerError).code).toBe("handler-missing");
    }
  });

  test("submit 显式 id 与 maxAttempts 生效（缺省 id 生成可用）", () => {
    const sched = new DurableScheduler({
      store: new MemoryDurableStore(),
      handlers: { job: async () => "ok" },
    });
    const explicit = sched.submit("job", null, { id: "fixed", maxAttempts: 7 });
    expect(explicit.maxAttempts).toBe(7);
    const generated = sched.submit("job", null);
    expect(generated.id.length).toBeGreaterThan(0);
    expect(generated.id).not.toBe("fixed");
  });

  test("run 主循环：handler 返回值即 checkpoint 留痕，completed，attempts=1", async () => {
    const vt = virtualTime();
    const store = new MemoryDurableStore();
    const sched = new DurableScheduler({
      store,
      clock: vt.clock,
      sleep: vt.sleep,
      handlers: { job: async (task) => ({ echoed: task.checkpoint, ran: true }) },
    });
    sched.submit("job", { x: 1 }, { id: "run-1" });
    await sched.run();
    const record = store.get("run-1");
    expect(record?.state).toBe("completed");
    expect(record?.attempts).toBe(1);
    expect(record?.checkpoint).toEqual({ echoed: { x: 1 }, ran: true });
  });

  test("handler 挂起两轮续跑：checkpoint 按 {n:0}→{n:1}→{n:2} 演进，终态 completed", async () => {
    const vt = virtualTime();
    const store = new MemoryDurableStore();
    const seen: JsonValue[] = [];
    const sched = new DurableScheduler({
      store,
      clock: vt.clock,
      sleep: vt.sleep,
      handlers: {
        job: async (task): Promise<JsonValue | SuspendSignal> => {
          seen.push(task.checkpoint);
          const n =
            typeof task.checkpoint === "object" &&
            task.checkpoint !== null &&
            "n" in task.checkpoint &&
            typeof task.checkpoint.n === "number"
              ? task.checkpoint.n
              : 0;
          if (n < 2) return { done: false, checkpoint: { n: n + 1 } };
          return { final: n };
        },
      },
    });
    sched.submit("job", { n: 0 }, { id: "susp-1" });
    await sched.run();
    expect(seen).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }]);
    const record = store.get("susp-1");
    expect(record?.state).toBe("completed");
    expect(record?.checkpoint).toEqual({ final: 2 });
    expect(record?.attempts).toBe(3); // 三段执行各计一次
  });

  test("退避重试：两败一成 → sleep 序列 [10,20] 指数退避，completed，attempts=3", async () => {
    const vt = virtualTime();
    const store = new MemoryDurableStore();
    const attemptsSeen: number[] = [];
    const sched = new DurableScheduler({
      store,
      clock: vt.clock,
      sleep: vt.sleep,
      retry: { backoffMs: 10 },
      handlers: {
        job: async (task) => {
          attemptsSeen.push(task.attempts);
          if (task.attempts < 3) throw new Error(`boom #${task.attempts}`);
          return "recovered";
        },
      },
    });
    sched.submit("job", null, { id: "retry-1", maxAttempts: 5 });
    await sched.run();
    expect(vt.sleeps).toEqual([10, 20]); // 2^(attempts-1) 指数退避
    expect(attemptsSeen).toEqual([1, 2, 3]);
    const record = store.get("retry-1");
    expect(record?.state).toBe("completed");
    expect(record?.attempts).toBe(3);
  });

  test("终态 failed：maxAttempts=2 恒败 → failed，attempts=2，handler 恰调 2 次", async () => {
    const vt = virtualTime();
    const store = new MemoryDurableStore();
    let calls = 0;
    const sched = new DurableScheduler({
      store,
      clock: vt.clock,
      sleep: vt.sleep,
      handlers: {
        job: async () => {
          calls++;
          throw new Error("always");
        },
      },
    });
    sched.submit("job", null, { id: "fail-1", maxAttempts: 2 });
    await sched.run();
    expect(calls).toBe(2);
    const record = store.get("fail-1");
    expect(record?.state).toBe("failed");
    expect(record?.attempts).toBe(2);
  });

  test("缺省 backoffMs=0：重试零睡眠（不产生 sleep 调用）", async () => {
    const vt = virtualTime();
    const store = new MemoryDurableStore();
    const sched = new DurableScheduler({
      store,
      clock: vt.clock,
      sleep: vt.sleep,
      handlers: {
        job: async (task) => {
          if (task.attempts < 2) throw new Error("once");
          return "ok";
        },
      },
    });
    sched.submit("job", null, { id: "fast-1", maxAttempts: 3 });
    await sched.run();
    expect(vt.sleeps).toEqual([]);
    expect(store.get("fast-1")?.state).toBe("completed");
  });

  test("run() 重入 → scheduler-busy；首轮收敛后可再次驱动", async () => {
    const vt = virtualTime();
    const store = new MemoryDurableStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sched = new DurableScheduler({
      store,
      clock: vt.clock,
      sleep: vt.sleep,
      handlers: {
        job: async () => {
          await gate;
          return "ok";
        },
      },
    });
    sched.submit("job", null, { id: "busy-1" });
    const first = sched.run();
    await expect(sched.run()).rejects.toMatchObject({ code: "scheduler-busy" });
    release();
    await first;
    sched.submit("job", null, { id: "busy-2" });
    await sched.run();
    expect(store.get("busy-1")?.state).toBe("completed");
    expect(store.get("busy-2")?.state).toBe("completed");
  });
});

describe("BI-14.5 崩溃自愈 recover()", () => {
  test("无孤儿 → { scanned:0, replayed:0, failed:0 }", async () => {
    const vt = virtualTime();
    const store = new MemoryDurableStore();
    const sched = new DurableScheduler({
      store,
      clock: vt.clock,
      sleep: vt.sleep,
      handlers: { job: async () => "ok" },
    });
    sched.submit("job", null, { id: "clean-1" });
    expect(await sched.recover()).toEqual({ scanned: 0, replayed: 0, failed: 0 });
    expect(store.get("clean-1")?.state).toBe("pending"); // pending 不受影响
  });

  test("崩溃模拟：实例 A running 中弃 → 实例 B recover 重放续跑至 completed", async () => {
    const vt = virtualTime();
    const store = new MemoryDurableStore();
    // 实例 A：提交后认领（running 落盘即进程死亡断点），弃实例
    const a = new DurableScheduler({
      store,
      clock: vt.clock,
      sleep: vt.sleep,
      handlers: {
        job: async () => {
          throw new Error("实例 A 不应执行到终态");
        },
      },
    });
    a.submit("job", { x: 1 }, { id: "crash-1" });
    store.put({ ...store.get("crash-1")!, state: "running", attempts: 1, updatedAt: vt.now() });
    // 实例 B：同一 store，重放续跑
    const seen: JsonValue[] = [];
    const b = new DurableScheduler({
      store,
      clock: vt.clock,
      sleep: vt.sleep,
      handlers: {
        job: async (task) => {
          seen.push(task.checkpoint);
          return "healed";
        },
      },
    });
    expect(await b.recover()).toEqual({ scanned: 1, replayed: 1, failed: 0 });
    expect(store.get("crash-1")?.state).toBe("pending");
    await b.run();
    const done = store.get("crash-1");
    expect(done?.state).toBe("completed");
    expect(done?.attempts).toBe(2); // 崩溃认领计一次尝试，重放再计一次
    expect(done?.checkpoint).toBe("healed");
    expect(seen).toEqual([{ x: 1 }]); // 续跑载荷 = 原 payload
  });

  test("fail 策略：孤儿一律标 failed 终态，等待中的 waiter 被结构化拒绝", async () => {
    const vt = virtualTime();
    const store = new MemoryDurableStore();
    store.put({
      id: "orphan-1",
      kind: "job",
      state: "running",
      checkpoint: { x: 9 },
      attempts: 2,
      maxAttempts: 3,
      updatedAt: vt.now(),
    });
    const sched = new DurableScheduler({
      store,
      clock: vt.clock,
      sleep: vt.sleep,
      handlers: { job: async () => "unused" },
    });
    const waiter = sched.awaitSettled("orphan-1"); // running 态挂起等待
    expect(await sched.recover("fail")).toEqual({ scanned: 1, replayed: 0, failed: 1 });
    await expect(waiter).rejects.toMatchObject({ code: "task-failed" });
    expect(store.get("orphan-1")?.state).toBe("failed");
  });

  test("replay 但 attempts 已耗尽 → 不重放，留 failed 终态（防崩溃死循环）", async () => {
    const vt = virtualTime();
    const store = new MemoryDurableStore();
    store.put({
      id: "orphan-2",
      kind: "job",
      state: "running",
      checkpoint: null,
      attempts: 3,
      maxAttempts: 3,
      updatedAt: vt.now(),
    });
    let calls = 0;
    const sched = new DurableScheduler({
      store,
      clock: vt.clock,
      sleep: vt.sleep,
      handlers: {
        job: async () => {
          calls++;
          return "never";
        },
      },
    });
    expect(await sched.recover()).toEqual({ scanned: 1, replayed: 0, failed: 1 });
    await sched.run();
    expect(calls).toBe(0);
    expect(store.get("orphan-2")?.state).toBe("failed");
  });

  test("多孤儿分页 recover（pageSize=1 强制分页）：3 个孤儿全部重放回 pending", async () => {
    const vt = virtualTime();
    const store = new MemoryDurableStore();
    for (const id of ["o-a", "o-b", "o-c"]) {
      store.put({
        id,
        kind: "job",
        state: "running",
        checkpoint: null,
        attempts: 1,
        maxAttempts: 3,
        updatedAt: vt.now(),
      });
    }
    const sched = new DurableScheduler({
      store,
      clock: vt.clock,
      sleep: vt.sleep,
      pageSize: 1,
      handlers: { job: async () => "ok" },
    });
    expect(await sched.recover()).toEqual({ scanned: 3, replayed: 3, failed: 0 });
    for (const id of ["o-a", "o-b", "o-c"]) {
      expect(store.get(id)?.state).toBe("pending");
    }
  });
});

describe("BI-14.5 长定时器分片 scheduleAt", () => {
  test("3 分片定时器：delay=3×MAX_TIMER_DELAY → 恰 3 片睡眠到点执行至 completed", async () => {
    const vt = virtualTime();
    const store = new MemoryDurableStore();
    const seen: JsonValue[] = [];
    const sched = new DurableScheduler({
      store,
      clock: vt.clock,
      sleep: vt.sleep,
      handlers: {
        job: async (task) => {
          seen.push(task.checkpoint);
          return "fired";
        },
      },
    });
    sched.submit("job", { when: "later" }, { id: "timer-1" });
    const at = vt.now() + 3 * MAX_TIMER_DELAY;
    const result = await sched.scheduleAt("timer-1", at);
    expect(result).toBe("fired");
    expect(vt.sleeps).toEqual([MAX_TIMER_DELAY, MAX_TIMER_DELAY, MAX_TIMER_DELAY]);
    const record = store.get("timer-1");
    expect(record?.state).toBe("completed");
    expect(record?.checkpoint).toBe("fired");
    expect(seen).toEqual([{ when: "later" }]); // 到点解包：原 payload 透传 handler
  });

  test("单分片（delay < MAX）：一次睡眠精确到点，不产生多余分片", async () => {
    const vt = virtualTime();
    const store = new MemoryDurableStore();
    const sched = new DurableScheduler({
      store,
      clock: vt.clock,
      sleep: vt.sleep,
      handlers: { job: async () => "on-time" },
    });
    sched.submit("job", null, { id: "timer-2" });
    const result = await sched.scheduleAt("timer-2", vt.now() + 1_500);
    expect(result).toBe("on-time");
    expect(vt.sleeps).toEqual([1_500]);
  });

  test("run() 不抢 deferred 任务：带延期标记的 pending 不被主循环认领", async () => {
    const vt = virtualTime();
    const store = new MemoryDurableStore();
    let calls = 0;
    const sched = new DurableScheduler({
      store,
      clock: vt.clock,
      sleep: vt.sleep,
      handlers: {
        job: async () => {
          calls++;
          return "x";
        },
      },
    });
    store.put({
      id: "defer-1",
      kind: "job",
      state: "pending",
      checkpoint: deferredCheckpoint(vt.now() + 100_000, { v: 1 }),
      attempts: 0,
      maxAttempts: 3,
      updatedAt: vt.now(),
    });
    await sched.run();
    expect(calls).toBe(0);
    expect(store.get("defer-1")?.state).toBe("pending"); // 归 scheduleAt 自驱
  });

  test("scheduleAt 非法目标：未知 id → unknown-task；已完成任务再调度 → not-schedulable", async () => {
    const vt = virtualTime();
    const store = new MemoryDurableStore();
    const sched = new DurableScheduler({
      store,
      clock: vt.clock,
      sleep: vt.sleep,
      handlers: { job: async () => "ok" },
    });
    await expect(sched.scheduleAt("ghost", vt.now() + 1)).rejects.toMatchObject({
      code: "unknown-task",
    });
    sched.submit("job", null, { id: "done-1" });
    store.put({ ...store.get("done-1")!, state: "completed", checkpoint: "x" });
    await expect(sched.scheduleAt("done-1", vt.now() + 1)).rejects.toMatchObject({
      code: "not-schedulable",
    });
  });
});

describe("BI-14.5 awaitSettled 多 waiter 终态汇聚", () => {
  test("3 个 waiter 运行前挂起 → 终态后全部 resolve 同一值", async () => {
    const vt = virtualTime();
    const store = new MemoryDurableStore();
    const sched = new DurableScheduler({
      store,
      clock: vt.clock,
      sleep: vt.sleep,
      handlers: { job: async () => "ok-val" },
    });
    sched.submit("job", null, { id: "wait-1" });
    const w1 = sched.awaitSettled("wait-1");
    const w2 = sched.awaitSettled("wait-1");
    const w3 = sched.awaitSettled("wait-1");
    await sched.run();
    expect(await Promise.all([w1, w2, w3])).toEqual(["ok-val", "ok-val", "ok-val"]);
  });

  test("已 completed 的任务：awaitSettled 立即返回 checkpoint", async () => {
    const vt = virtualTime();
    const store = new MemoryDurableStore();
    const sched = new DurableScheduler({
      store,
      clock: vt.clock,
      sleep: vt.sleep,
      handlers: { job: async () => ({ done: true }) },
    });
    sched.submit("job", null, { id: "wait-2" });
    await sched.run();
    expect(await sched.awaitSettled("wait-2")).toEqual({ done: true });
  });

  test("终态 failed：多 waiter 全部结构化拒绝（task-failed），互不影响", async () => {
    const vt = virtualTime();
    const store = new MemoryDurableStore();
    const sched = new DurableScheduler({
      store,
      clock: vt.clock,
      sleep: vt.sleep,
      handlers: {
        job: async () => {
          throw new Error("no way");
        },
      },
    });
    sched.submit("job", null, { id: "wait-3", maxAttempts: 1 });
    const w1 = sched.awaitSettled("wait-3");
    const w2 = sched.awaitSettled("wait-3");
    await sched.run();
    const settled = await Promise.allSettled([w1, w2]);
    expect(settled).toHaveLength(2);
    for (const outcome of settled) {
      expect(outcome.status).toBe("rejected");
      const reason = (outcome as PromiseRejectedResult).reason as DurableSchedulerError;
      expect(reason.code).toBe("task-failed");
      expect(reason.taskId).toBe("wait-3");
    }
  });

  test("未知 id → unknown-task（不悬挂）", async () => {
    const sched = new DurableScheduler({
      store: new MemoryDurableStore(),
      handlers: { job: async () => "ok" },
    });
    await expect(sched.awaitSettled("ghost")).rejects.toMatchObject({
      code: "unknown-task",
    });
  });
});

describe("BI-14.5 两 store 等价性与 600 任务端到端", () => {
  test("同场景脚本（挂起/退避/终败/孤儿恢复）在 Memory 与 Sqlite 上最终快照一致", async () => {
    const scenario = async (store: DurableStore): Promise<Array<TaskRecord | null>> => {
      const vt = virtualTime();
      const sched = new DurableScheduler({
        store,
        clock: vt.clock,
        sleep: vt.sleep,
        retry: { backoffMs: 5 },
        handlers: {
          comp: async () => ({ finished: "comp" }),
          susp: async (task): Promise<JsonValue | SuspendSignal> => {
            const n =
              typeof task.checkpoint === "object" &&
              task.checkpoint !== null &&
              "n" in task.checkpoint &&
              typeof task.checkpoint.n === "number"
                ? task.checkpoint.n
                : 0;
            if (n < 2) return { done: false, checkpoint: { n: n + 1 } };
            return { finished: "susp" };
          },
          boom: async () => {
            throw new Error("boom");
          },
        },
      });
      sched.submit("comp", { k: "c" }, { id: "s-comp" });
      sched.submit("susp", { n: 0 }, { id: "s-susp" });
      sched.submit("boom", { k: "b" }, { id: "s-boom", maxAttempts: 2 });
      // 孤儿：认领后实例即弃，交给 recover 重放
      store.put({
        id: "s-orphan",
        kind: "comp",
        state: "running",
        checkpoint: { k: "o" },
        attempts: 1,
        maxAttempts: 3,
        updatedAt: vt.now(),
      });
      await sched.recover();
      await sched.run();
      return snapshot(store);
    };
    const { store: sqlite, cleanup } = tmpSqlite();
    try {
      expect(await scenario(new MemoryDurableStore())).toEqual(await scenario(sqlite));
    } finally {
      cleanup();
    }
  });

  test("600 任务端到端：默认 256 分页全量拉齐，全 completed 无重无漏（Memory + Sqlite tmp 文件库）", async () => {
    const { store: sqlite, cleanup } = tmpSqlite();
    try {
      for (const store of [new MemoryDurableStore(), sqlite] as DurableStore[]) {
        const vt = virtualTime();
        let calls = 0;
        const sched = new DurableScheduler({
          store,
          clock: vt.clock,
          sleep: vt.sleep,
          handlers: {
            job: async (task) => {
              calls++;
              return { processed: (task.checkpoint as { n: number }).n };
            },
          },
        });
        for (let i = 0; i < 600; i++) {
          sched.submit("job", { n: i }, { id: `batch-${String(i).padStart(3, "0")}` });
        }
        await sched.run();
        const completed = store.scanStates(["completed"], null, 1_000).items;
        expect(completed).toHaveLength(600);
        expect(new Set(completed.map((r) => r.id)).size).toBe(600);
        const sum = completed.reduce(
          (acc, r) => acc + (r.checkpoint as { processed: number }).processed,
          0,
        );
        expect(sum).toBe((600 * 599) / 2); // 每个 payload 恰执行一次
        expect(calls).toBe(600);
        expect(
          store.scanStates(["pending", "suspended", "running", "failed"]).items,
        ).toEqual([]); // 无残留、无孤儿
      }
    } finally {
      cleanup();
    }
  });
});
