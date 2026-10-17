import { describe, expect, test } from "bun:test";
import { WorkerPool } from "./worker-pool";

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("WorkerPool · 基本语义", () => {
  test("run 返回任务值（同步与异步 fn 均支持）", async () => {
    const pool = new WorkerPool(2);
    expect(await pool.run(() => 1 + 1)).toBe(2);
    expect(await pool.run(async () => "async-ok")).toBe("async-ok");
    await pool.idle();
    expect(pool.activeCount).toBe(0);
    expect(pool.pendingCount).toBe(0);
  });

  test("非法 size：RangeError", () => {
    expect(() => new WorkerPool(0)).toThrow(RangeError);
    expect(() => new WorkerPool(-1)).toThrow(RangeError);
    expect(() => new WorkerPool(1.5)).toThrow(RangeError);
  });
});

describe("WorkerPool · 并发上限与排队", () => {
  test("并发上限：6 任务 size=2，同时在飞数不超 2", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const pool = new WorkerPool(2);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        pool.run(async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await sleep(20);
          inFlight--;
          return i;
        }),
      ),
    );
    expect(results).toEqual([0, 1, 2, 3, 4, 5]);
    expect(maxInFlight).toBe(2);
    await pool.idle();
  });

  test("size=1 严格串行化：任务体无重叠", async () => {
    let running = false;
    let overlap = false;
    const pool = new WorkerPool(1);
    await Promise.all(
      Array.from({ length: 5 }, () =>
        pool.run(async () => {
          if (running) overlap = true;
          running = true;
          await sleep(5);
          running = false;
        }),
      ),
    );
    expect(overlap).toBe(false);
  });

  test("FIFO 排队顺序：按提交顺序启动", async () => {
    const startOrder: number[] = [];
    const pool = new WorkerPool(1);
    await Promise.all(
      [3, 1, 4, 1, 5].map((ms, i) =>
        pool.run(async () => {
          startOrder.push(i);
          await sleep(ms);
        }),
      ),
    );
    expect(startOrder).toEqual([0, 1, 2, 3, 4]);
  });

  test("pendingCount / activeCount 反映中态", async () => {
    const gate = deferred<void>();
    const pool = new WorkerPool(1);
    const p1 = pool.run(() => gate.promise);
    const p2 = pool.run(() => "b");
    const p3 = pool.run(() => "c");
    expect(pool.activeCount).toBe(1);
    expect(pool.pendingCount).toBe(2);
    gate.resolve();
    expect(await p1).toBeUndefined();
    expect(await p2).toBe("b");
    expect(await p3).toBe("c");
    await pool.idle();
    expect(pool.activeCount).toBe(0);
    expect(pool.pendingCount).toBe(0);
  });
});

describe("WorkerPool · 错误隔离", () => {
  test("单任务 reject 只影响自身，其余任务照常完成", async () => {
    const pool = new WorkerPool(2);
    const settled = await Promise.allSettled([
      pool.run(async () => {
        throw new Error("task-a-fail");
      }),
      pool.run(async () => "task-b-ok"),
      pool.run(() => 42),
    ]);
    expect(settled[0]?.status).toBe("rejected");
    expect((settled[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect((settled[0] as PromiseRejectedResult).reason.message).toBe("task-a-fail");
    expect(settled[1]).toEqual({ status: "fulfilled", value: "task-b-ok" });
    expect(settled[2]).toEqual({ status: "fulfilled", value: 42 });
  });

  test("出错后池仍可用，队列不卡死", async () => {
    const pool = new WorkerPool(1);
    const first = await pool.run(() => {
      throw new Error("boom-1");
    }).then(
      () => "unreachable",
      (e: unknown) => (e as Error).message,
    );
    expect(first).toBe("boom-1");
    expect(await pool.run(() => "after-error")).toBe("after-error");
    await pool.idle();
    expect(pool.activeCount).toBe(0);
    expect(pool.pendingCount).toBe(0);
  });

  test("idle() 在含失败任务的批次后收敛", async () => {
    const pool = new WorkerPool(2);
    const results = await Promise.allSettled([
      pool.run(() => {
        throw new Error("x");
      }),
      pool.run(() => sleep(10).then(() => "slow-ok")),
      pool.run(() => "fast-ok"),
    ]);
    expect(results.some((r) => r.status === "rejected")).toBe(true);
    await pool.idle();
    expect(pool.activeCount).toBe(0);
    expect(pool.pendingCount).toBe(0);
  });
});
