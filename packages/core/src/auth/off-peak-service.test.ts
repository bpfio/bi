import { describe, expect, test } from "bun:test";

import type { FetchLike } from "./http";
import type { IntervalTimerPort } from "./quota-watchdog";
import {
  OFF_PEAK_OUTBOX_KEY_PREFIX,
  OFF_PEAK_TASK_KEY_PREFIX,
  OffPeakService,
  type KVStore,
  type OffPeakServiceOptions,
  type OffPeakStatusResult,
  type OffPeakTaskView,
} from "./off-peak-service";

const PAYLOAD = { job: "nightly-report", secret: "PLAINTEXT-do-not-leak" };

/** 内存 KVStore（测试实现；生产绑定 BI-03 SQLite 底座）。 */
function memoryKV(): KVStore & { dump(): Map<string, string> } {
  const map = new Map<string, string>();
  return {
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value);
    },
    delete: async (key) => {
      map.delete(key);
    },
    scan: async (prefix) =>
      [...map.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
    dump: () => map,
  };
}

/** 手动 timer：fire 由测试驱动（注入时钟加速，无真实等待）。 */
function manualTimer(): IntervalTimerPort & { fire(): void; isActive(): boolean; startedCount(): number } {
  let fn: (() => void) | undefined;
  let started = 0;
  return {
    start(f: () => void) {
      fn = f;
      started++;
      return "handle";
    },
    stop() {
      fn = undefined;
    },
    fire() {
      fn?.();
    },
    isActive() {
      return fn !== undefined;
    },
    startedCount() {
      return started;
    },
  };
}

/** 脚本化 fake 取号客户端（零网络）。 */
class FakeClient {
  submitted: unknown[] = [];
  submitError: Error | undefined;
  #script = new Map<string, Array<OffPeakStatusResult | Error>>();

  scriptStatus(ticketId: string, steps: Array<OffPeakStatusResult | Error>): void {
    this.#script.set(ticketId, [...steps]);
  }

  async submit(payload: unknown): Promise<string> {
    if (this.submitError !== undefined) throw this.submitError;
    this.submitted.push(payload);
    return `t-${this.submitted.length}`;
  }

  async pollStatus(ticketId: string): Promise<OffPeakStatusResult> {
    const next = this.#script.get(ticketId)?.shift();
    if (next === undefined) return { status: "queued" };
    if (next instanceof Error) throw next;
    return next;
  }
}

/** settle 端点 stub fetch：按脚本依次返回状态码（缺省 200）。 */
function settleFetch(script: number[] = []): {
  fetch: FetchLike;
  bodies: unknown[];
  count: () => number;
} {
  const bodies: unknown[] = [];
  let calls = 0;
  const fetch = ((_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    calls++;
    const status = script.shift() ?? 200;
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status }));
  }) as FetchLike;
  return { fetch, bodies, count: () => calls };
}

interface ServiceHarness {
  client: FakeClient;
  store: ReturnType<typeof memoryKV>;
  timer: ReturnType<typeof manualTimer>;
  settle: ReturnType<typeof settleFetch>;
  /** settle 状态码脚本（闭包引用同一数组；测试 push 驱动失败/成功）。 */
  settleScript: number[];
  now: { value: number };
  executed: OffPeakTaskView[];
  service: OffPeakService;
}

function makeHarness(overrides: Partial<OffPeakServiceOptions> = {}): ServiceHarness {
  const client = new FakeClient();
  const store = memoryKV();
  const timer = manualTimer();
  const settleScript: number[] = [];
  const settle = settleFetch(settleScript);
  const now = { value: 1_000_000 };
  const executed: OffPeakTaskView[] = [];
  const service = new OffPeakService({
    client,
    store,
    timer,
    execute: (task) => {
      executed.push(task);
      return { done: true };
    },
    fetchImpl: settle.fetch,
    flushBackoffMs: 100,
    maxFlushAttempts: 4,
    now: () => now.value,
    baseUrl: "https://stub.example",
    ...overrides,
  });
  return { client, store, timer, settle, settleScript, now, executed, service };
}

/** 读取 Outbox 记录（按键前缀过滤，排除 task 记录）。 */
function outboxEntries(store: ReturnType<typeof memoryKV>): Array<Record<string, unknown>> {
  return [...store.dump().entries()]
    .filter(([key]) => key.startsWith(OFF_PEAK_OUTBOX_KEY_PREFIX))
    .map(([, value]) => JSON.parse(value) as Record<string, unknown>);
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("OffPeakService · 状态机全转移", () => {
  test("全链路：queued → tick(schedulable)→execute→settling → flushOutbox → settled", async () => {
    const h = makeHarness();
    const task = await h.service.submitTask(PAYLOAD);
    expect(task.state).toBe("queued");

    h.client.scriptStatus(task.ticketId, [{ status: "schedulable" }]);
    await h.service.tick();
    expect(h.executed.length).toBe(1);
    expect(h.executed[0]).toEqual({ ticketId: task.ticketId, payload: PAYLOAD });

    const settling = await h.service.getTask(task.ticketId);
    expect(settling?.state).toBe("settling");

    const flushResult = await h.service.flushOutbox();
    expect(flushResult.settled).toBe(1);
    const settled = await h.service.getTask(task.ticketId);
    expect(settled?.state).toBe("settled");
    // settle 端点收到核销载荷（settle 意图 + execute 结果）
    expect(h.settle.bodies[0]).toEqual({
      ticketId: task.ticketId,
      kind: "settle",
      result: { done: true },
    });
    // 核销后 outbox 条目删除
    const outboxKeys = [...h.store.dump().keys()].filter((k) => k.startsWith(OFF_PEAK_OUTBOX_KEY_PREFIX));
    expect(outboxKeys).toEqual([]);
  });

  test("server queued → 本地保持 polling（queued→polling 首转）", async () => {
    const h = makeHarness();
    const task = await h.service.submitTask(PAYLOAD);
    await h.service.tick(); // queued → polling，server 返回 queued
    expect(h.executed.length).toBe(0);
    const after = await h.service.getTask(task.ticketId);
    expect(after?.state).toBe("polling");
  });

  test("server done → 跳过 execute 直达 settling，server result 进核销载荷", async () => {
    const h = makeHarness();
    const task = await h.service.submitTask(PAYLOAD);
    h.client.scriptStatus(task.ticketId, [{ status: "done", result: { serverUnits: 7 } }]);
    await h.service.tick();

    expect(h.executed.length).toBe(0); // 不调用本地 execute
    const after = await h.service.getTask(task.ticketId);
    expect(after?.state).toBe("settling");

    await h.service.flushOutbox();
    expect(h.settle.bodies[0]).toMatchObject({ kind: "settle", result: { serverUnits: 7 } });
  });

  test("server failed → 任务 failed（终态）+ outbox fail 意图", async () => {
    const h = makeHarness();
    const task = await h.service.submitTask(PAYLOAD);
    h.client.scriptStatus(task.ticketId, [{ status: "failed", reason: "upstream_code:3200" }]);
    await h.service.tick();

    const after = await h.service.getTask(task.ticketId);
    expect(after?.state).toBe("failed");
    expect(after?.reason).toBe("upstream_code:3200");
    expect(outboxEntries(h.store)[0]).toMatchObject({
      ticketId: task.ticketId,
      kind: "fail",
      reason: "upstream_code:3200",
    });
  });

  test("execute 抛异常 → failed（execute_failed:<name>）+ outbox fail 记录", async () => {
    const h = makeHarness({
      execute: () => {
        throw new Error("boom-inner");
      },
    });
    const task = await h.service.submitTask(PAYLOAD);
    h.client.scriptStatus(task.ticketId, [{ status: "schedulable" }]);
    await h.service.tick();

    const after = await h.service.getTask(task.ticketId);
    expect(after?.state).toBe("failed");
    expect(after?.reason).toBe("execute_failed:Error");
    expect(after?.reason).not.toContain("boom-inner"); // 错误消息不外泄
    expect(outboxEntries(h.store)[0]).toMatchObject({ kind: "fail", reason: "execute_failed:Error" });
  });

  test("pollStatus 瞬态失败（网络）→ 保持 polling，下一 tick 重试成功", async () => {
    const h = makeHarness();
    const task = await h.service.submitTask(PAYLOAD);
    h.client.scriptStatus(task.ticketId, [
      new Error("ECONNRESET"),
      { status: "schedulable" },
    ]);
    await h.service.tick();
    expect((await h.service.getTask(task.ticketId))?.state).toBe("polling");
    expect(h.executed.length).toBe(0);

    await h.service.tick(); // 下一 tick 重试
    expect(h.executed.length).toBe(1);
    expect((await h.service.getTask(task.ticketId))?.state).toBe("settling");
  });
});

describe("OffPeakService · 3102 → re-ticket 回路", () => {
  test("expired → 同 payload 重新取号：新票 queued、attempts+1、旧票归档 expired", async () => {
    const h = makeHarness();
    const task = await h.service.submitTask(PAYLOAD);
    h.client.scriptStatus(task.ticketId, [{ status: "expired" }]);
    await h.service.tick();

    expect(h.client.submitted.length).toBe(2); // 原始取号 + re-ticket
    expect(h.client.submitted[1]).toEqual(PAYLOAD);

    const oldTask = await h.service.getTask(task.ticketId);
    expect(oldTask?.state).toBe("expired");

    const newTask = await h.service.getTask("t-2");
    expect(newTask).toBeDefined();
    expect(newTask!.state).toBe("queued");
    expect(newTask!.attempts).toBe(1);
    expect(newTask!.payload).toEqual(PAYLOAD);

    // 新票下一 tick 正常推进
    h.client.scriptStatus("t-2", [{ status: "schedulable" }]);
    await h.service.tick();
    expect(h.executed[0]!.ticketId).toBe("t-2");
  });

  test("re-ticket 耗尽（maxRetickets=1）→ failed(re_ticket_exhausted) + outbox fail", async () => {
    const h = makeHarness({ maxRetickets: 1 });
    const task = await h.service.submitTask(PAYLOAD);
    h.client.scriptStatus(task.ticketId, [{ status: "expired" }]);
    await h.service.tick(); // 第 1 次 re-ticket 成功 → t-2 (attempts=1)

    h.client.scriptStatus("t-2", [{ status: "expired" }]);
    await h.service.tick(); // 第 2 次 → 超限 → failed

    const failed = await h.service.getTask("t-2");
    expect(failed?.state).toBe("failed");
    expect(failed?.reason).toBe("re_ticket_exhausted");
    expect(h.client.submitted.length).toBe(2); // 不再取号
    expect(
      outboxEntries(h.store).some((e) => e.kind === "fail" && e.reason === "re_ticket_exhausted"),
    ).toBe(true);
  });

  test("re-ticket 取号瞬态失败 → 旧票保持，下一 tick 重试 re-ticket", async () => {
    const h = makeHarness();
    const task = await h.service.submitTask(PAYLOAD);
    h.client.scriptStatus(task.ticketId, [{ status: "expired" }]);
    h.client.submitError = new Error("ECONNREFUSED");
    await h.service.tick();

    expect(h.client.submitted.length).toBe(1); // re-ticket 失败，未取到新票
    const after = await h.service.getTask(task.ticketId);
    expect(after?.state).toBe("polling"); // 保持可重试

    h.client.submitError = undefined;
    h.client.scriptStatus(task.ticketId, [{ status: "expired" }]); // 重新注入过期脚本
    await h.service.tick(); // 下一 tick：仍 expired → 重试 re-ticket 成功
    expect(h.client.submitted.length).toBe(2);
    expect((await h.service.getTask("t-2"))?.state).toBe("queued");
  });
});

describe("OffPeakService · Outbox 核销：幂等与指数退避（注入时钟）", () => {
  test("幂等：核销成功即删条目，重复 flushOutbox 服务端恰好收到一次 POST", async () => {
    const h = makeHarness();
    const task = await h.service.submitTask(PAYLOAD);
    h.client.scriptStatus(task.ticketId, [{ status: "schedulable" }]);
    await h.service.tick();
    await h.service.flushOutbox();
    expect(h.settle.count()).toBe(1);

    const second = await h.service.flushOutbox();
    expect(second.settled).toBe(0);
    expect(h.settle.count()).toBe(1); // 不重复 settle
  });

  test("失败退避：冷却期内 flush 跳过；指数增长（1x→2x）；推进时钟后重试成功", async () => {
    const h = makeHarness();
    const task = await h.service.submitTask(PAYLOAD);
    h.client.scriptStatus(task.ticketId, [{ status: "schedulable" }]);
    await h.service.tick();
    h.settleScript.push(500, 500); // 前两次核销失败

    // 第 1 次失败：nextAttemptAt = now + 100 (1x)
    let result = await h.service.flushOutbox();
    expect(result).toMatchObject({ settled: 0, retried: 1 });
    expect(h.settle.count()).toBe(1);

    // 冷却期内跳过（POST 计数不变）
    result = await h.service.flushOutbox();
    expect(result.skipped).toBe(1);
    expect(h.settle.count()).toBe(1);

    // 推进 100ms：第 2 次失败，nextAttemptAt = now + 200 (2x 指数)
    h.now.value += 100;
    result = await h.service.flushOutbox();
    expect(result.retried).toBe(1);
    expect(h.settle.count()).toBe(2);

    // 只推进 150ms（<200）→ 仍被跳过
    h.now.value += 150;
    result = await h.service.flushOutbox();
    expect(result.skipped).toBe(1);

    // 推足 200ms：成功 → settled + 条目删除
    h.now.value += 50;
    result = await h.service.flushOutbox();
    expect(result.settled).toBe(1);
    expect((await h.service.getTask(task.ticketId))?.state).toBe("settled");
    expect(h.settle.count()).toBe(3);
  });

  test("重试耗尽（maxFlushAttempts=4）→ 条目标记 dead，不再投递", async () => {
    const h = makeHarness();
    const task = await h.service.submitTask(PAYLOAD);
    h.client.scriptStatus(task.ticketId, [{ status: "schedulable" }]);
    await h.service.tick();
    h.settleScript.push(500, 500, 500, 500, 500);

    // 4 次投递全部失败 → dead
    for (let i = 0; i < 3; i++) {
      await h.service.flushOutbox();
      h.now.value += 10_000;
    }
    const final = await h.service.flushOutbox();
    expect(final.dead).toBe(1);
    expect(h.settle.count()).toBe(4);

    // dead 条目不再投递
    h.now.value += 10_000;
    const after = await h.service.flushOutbox();
    expect(after.settled).toBe(0);
    expect(h.settle.count()).toBe(4);
    const taskAfter = await h.service.getTask(task.ticketId);
    expect(taskAfter?.state).toBe("settling"); // 未晋升，留档排查
  });

  test("并发 flushOutbox：同 ticket in-flight 防重（settle 慢请求期间不重复投递）", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const slowSettle = ((_url: string, init?: RequestInit) => {
      calls++;
      return gate.then(() => new Response("{}", { status: 200 }));
    }) as FetchLike;
    const h = makeHarness({ fetchImpl: slowSettle });
    const task = await h.service.submitTask(PAYLOAD);
    h.client.scriptStatus(task.ticketId, [{ status: "schedulable" }]);
    await h.service.tick();

    const first = h.service.flushOutbox(); // 在途
    await flush();
    const second = await h.service.flushOutbox(); // 并发 → in-flight 跳过
    const secondResult = await second;
    expect(secondResult.skipped).toBe(1);
    expect(calls).toBe(1);

    release();
    const firstResult = await first;
    expect(firstResult.settled).toBe(1);
    expect(calls).toBe(1); // 全程只投递一次
  });
});

describe("OffPeakService · 后台轮询（注入 timer 加速）与持久化形态", () => {
  test("start 立即首轮 + fire 驱动周期；stop 后不再轮询；重复 start 幂等", async () => {
    const h = makeHarness({ pollIntervalMs: 30_000 });
    const task = await h.service.submitTask(PAYLOAD);
    h.client.scriptStatus(task.ticketId, [{ status: "queued" }]);

    await h.service.start();
    expect(h.timer.isActive()).toBe(true);
    expect((await h.service.getTask(task.ticketId))?.state).toBe("polling"); // 首轮立即

    await h.service.start();
    await h.service.start();
    expect(h.timer.startedCount()).toBe(1);

    h.timer.fire();
    await flush();
    h.timer.fire();
    await flush();
    // 两次 fire 都不推进状态（server 持续 queued），但轮询在途集合不堆积——用 submit 计数验证轮询仍活着
    h.client.scriptStatus(task.ticketId, [{ status: "schedulable" }]);
    h.timer.fire();
    await flush();
    expect(h.executed.length).toBe(1);
    expect((await h.service.getTask(task.ticketId))?.state).toBe("settling");

    h.service.stop();
    expect(h.timer.isActive()).toBe(false);
  });

  test("KVStore 记录形态：task/outbox 键前缀 + JSON 结构（接缝①断言）", async () => {
    const h = makeHarness();
    const task = await h.service.submitTask(PAYLOAD);
    const rawTask = h.store.dump().get(`${OFF_PEAK_TASK_KEY_PREFIX}${task.ticketId}`);
    expect(rawTask).toBeDefined();
    const parsedTask = JSON.parse(rawTask!) as Record<string, unknown>;
    expect(parsedTask).toMatchObject({
      ticketId: task.ticketId,
      state: "queued",
      attempts: 0,
    });

    h.client.scriptStatus(task.ticketId, [{ status: "schedulable" }]);
    await h.service.tick();
    const rawOutbox = h.store.dump().get(`${OFF_PEAK_OUTBOX_KEY_PREFIX}${task.ticketId}`);
    expect(rawOutbox).toBeDefined();
    const parsedOutbox = JSON.parse(rawOutbox!) as Record<string, unknown>;
    expect(parsedOutbox).toMatchObject({ ticketId: task.ticketId, kind: "settle", status: "pending" });
  });

  test("零网络断言：全程注入 stub，日志不含 payload 明文", async () => {
    const logs: string[] = [];
    const h = makeHarness({
      log: (l) => logs.push(l),
      execute: () => {
        throw new Error("oops");
      },
    });
    const task = await h.service.submitTask(PAYLOAD);
    h.client.scriptStatus(task.ticketId, [{ status: "schedulable" }]);
    await h.service.tick();
    await h.service.flushOutbox();

    const all = logs.join("\n");
    expect(all).not.toContain(PAYLOAD.secret);
    expect(all).not.toContain("nightly-report");
    // settle stub 请求计数即全部出网流量（0 次真实网络由注入保证）
    expect(h.settle.count()).toBe(1); // fail 意图核销
  });
});
