/**
 * BI-06.3 · 工具调用协作式超时看门狗测试（注入虚拟时钟，零真实等待）。
 *
 * 覆盖：限时表默认/按键覆盖/未知工具缺省；到点 abort → 结构化
 * ToolTimeoutError 形状；fn 响应 signal 提前干净退出仍得同错误；外部信号
 * 预中止与运行中中止；进度转发；父 Deadline 预算合并。
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_UNKNOWN_TOOL_TIMEOUT_MS,
  DEFAULT_TOOL_TIMEOUTS,
  ToolTimeoutError,
  ToolTimeoutPolicy,
} from "./timeout-policy";
import { deadlineFrom } from "./deadline";
import type { Clock } from "./deadline";
import type { ToolProgressEvent } from "./timeout-policy";

/** 可手动拨动的虚拟时钟：定时器全部走注入，advance 按到期顺序触发。 */
class ManualClock implements Clock {
  #now = 0;
  #seq = 0;
  readonly #timers = new Map<number, { at: number; handler: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(handler: () => void, ms: number): unknown {
    const id = ++this.#seq;
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), handler });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  /** 推进虚拟时间：按到期顺序触发全部到期定时器（含回调中新注册的）。 */
  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      let bestId: number | undefined;
      let bestAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.#timers) {
        if (timer.at <= target && timer.at < bestAt) {
          bestId = id;
          bestAt = timer.at;
        }
      }
      const due = bestId === undefined ? undefined : this.#timers.get(bestId);
      if (bestId === undefined || due === undefined) break;
      this.#timers.delete(bestId);
      this.#now = Math.max(this.#now, due.at);
      due.handler();
    }
    this.#now = target;
  }

  /** 当前未触发定时器数（泄漏检测）。 */
  get pendingCount(): number {
    return this.#timers.size;
  }
}

/** 捕获 promise 的拒绝原因（不吞正常值）。 */
async function errOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return err;
  }
}

describe("BI-06.3 限时注册表", () => {
  test("默认表：web_search=30s、mcp=60s、python=120s、bash=120s", () => {
    const policy = new ToolTimeoutPolicy();
    expect(policy.timeoutFor("web_search")).toBe(30_000);
    expect(policy.timeoutFor("mcp")).toBe(60_000);
    expect(policy.timeoutFor("python")).toBe(120_000);
    expect(policy.timeoutFor("bash")).toBe(120_000);
    expect(DEFAULT_TOOL_TIMEOUTS["mcp"]).toBe(60_000);
  });

  test("未知工具 → defaultTimeoutMs 缺省 60s", () => {
    const policy = new ToolTimeoutPolicy();
    expect(policy.timeoutFor("no_such_tool")).toBe(DEFAULT_UNKNOWN_TOOL_TIMEOUT_MS);
    expect(policy.timeoutFor("no_such_tool")).toBe(60_000);
  });

  test("构造注入 timeouts 按键覆盖：覆盖项生效，其余键保留默认", () => {
    const policy = new ToolTimeoutPolicy({ timeouts: { web_search: 5_000 } });
    expect(policy.timeoutFor("web_search")).toBe(5_000);
    expect(policy.timeoutFor("mcp")).toBe(60_000);
    expect(policy.timeoutFor("python")).toBe(120_000);
  });

  test("覆盖也可作用于未知工具名（新增限时项）", () => {
    const policy = new ToolTimeoutPolicy({ timeouts: { sql_query: 10_000 } });
    expect(policy.timeoutFor("sql_query")).toBe(10_000);
  });

  test("defaultTimeoutMs 覆盖未知工具缺省", () => {
    const policy = new ToolTimeoutPolicy({ defaultTimeoutMs: 45_000 });
    expect(policy.timeoutFor("obscure_tool")).toBe(45_000);
    expect(policy.timeoutFor("web_search")).toBe(30_000);
  });
});

describe("BI-06.3 withDeadline 到点与协作取消", () => {
  test("fn 先于到点完成 → 原值透传，且无残留定时器", async () => {
    const clock = new ManualClock();
    const policy = new ToolTimeoutPolicy({ clock });
    const p = policy.withDeadline("web_search", async () => "ok");
    await expect(p).resolves.toBe("ok");
    expect(clock.pendingCount).toBe(0);
  });

  test("到点且 fn 挂死 → 拒绝 ToolTimeoutError（看门狗兜底）", async () => {
    const clock = new ManualClock();
    const policy = new ToolTimeoutPolicy({ clock });
    const p = policy.withDeadline("mcp", () => new Promise<string>(() => {}));
    clock.advance(60_000);
    const err = await errOf(p);
    expect(err).toBeInstanceOf(ToolTimeoutError);
  });

  test("ToolTimeoutError 结构化形状：name/code/tool/deadlineMs", async () => {
    const clock = new ManualClock();
    const policy = new ToolTimeoutPolicy({ clock });
    const p = policy.withDeadline("python", () => new Promise<string>(() => {}));
    clock.advance(120_000);
    const err = (await errOf(p)) as ToolTimeoutError;
    expect(err instanceof ToolTimeoutError).toBe(true);
    expect(err.name).toBe("ToolTimeoutError");
    expect(err.code).toBe("TOOL_TIMEOUT");
    expect(err.tool).toBe("python");
    expect(err.deadlineMs).toBe(120_000);
    expect(err.message).toContain("python");
  });

  test("到点时内部 signal.aborted === true 且 reason 为同一 ToolTimeoutError", async () => {
    const clock = new ManualClock();
    const policy = new ToolTimeoutPolicy({ clock });
    let captured: AbortSignal | undefined;
    const p = policy.withDeadline("bash", (signal) => {
      captured = signal;
      return new Promise<string>(() => {});
    });
    clock.advance(120_000);
    await errOf(p);
    expect(captured?.aborted).toBe(true);
    expect(captured?.reason).toBeInstanceOf(ToolTimeoutError);
  });

  test("fn 响应 abort 提前干净退出 → 仍拒绝为同一 ToolTimeoutError", async () => {
    const clock = new ManualClock();
    const policy = new ToolTimeoutPolicy({ clock });
    const cleaned: string[] = [];
    const p = policy.withDeadline("mcp", (signal) =>
      new Promise<string>((resolve) => {
        signal.addEventListener("abort", () => {
          cleaned.push("cleanup");
          resolve("clean-exit");
        });
      }),
    );
    clock.advance(60_000);
    const err = await errOf(p);
    expect(err).toBeInstanceOf(ToolTimeoutError);
    expect((err as ToolTimeoutError).code).toBe("TOOL_TIMEOUT");
    expect(cleaned).toEqual(["cleanup"]);
  });

  test("deadlineMs 覆盖注册表限时", async () => {
    const clock = new ManualClock();
    const policy = new ToolTimeoutPolicy({ clock });
    const p = policy.withDeadline("mcp", () => new Promise<string>(() => {}), { deadlineMs: 1_500 });
    clock.advance(1_500);
    const err = (await errOf(p)) as ToolTimeoutError;
    expect(err.deadlineMs).toBe(1_500);
  });

  test("未到点时 fn 不受影响（advance 不够远不触发）", async () => {
    const clock = new ManualClock();
    const policy = new ToolTimeoutPolicy({ clock });
    let settled = false;
    const p = policy.withDeadline("mcp", () => new Promise<string>(() => {}));
    void p.catch(() => {
      settled = true;
    });
    clock.advance(59_999);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(clock.pendingCount).toBe(1);
  });

  test("外部 signal 预先已中止 → 立即拒绝且 fn 不被调用、定时器不泄漏", async () => {
    const clock = new ManualClock();
    const policy = new ToolTimeoutPolicy({ clock });
    const controller = new AbortController();
    controller.abort();
    let invoked = false;
    const p = policy.withDeadline("mcp", () => {
      invoked = true;
      return "should-not-run";
    }, { signal: controller.signal });
    const err = (await errOf(p)) as ToolTimeoutError;
    expect(err).toBeInstanceOf(ToolTimeoutError);
    expect(err.tool).toBe("mcp");
    expect(invoked).toBe(false);
    expect(clock.pendingCount).toBe(0);
  });

  test("外部 signal 运行中 abort → 视同到点，拒绝 ToolTimeoutError", async () => {
    const clock = new ManualClock();
    const policy = new ToolTimeoutPolicy({ clock });
    const controller = new AbortController();
    const p = policy.withDeadline("python", () => new Promise<string>(() => {}), {
      signal: controller.signal,
    });
    controller.abort();
    const err = (await errOf(p)) as ToolTimeoutError;
    expect(err).toBeInstanceOf(ToolTimeoutError);
    expect(err.deadlineMs).toBe(120_000);
    expect(clock.pendingCount).toBe(0);
  });

  test("onProgress 转发：tool/atMs 取注入时钟，note 原样透传", async () => {
    const clock = new ManualClock();
    const policy = new ToolTimeoutPolicy({ clock });
    const events: ToolProgressEvent[] = [];
    const p = policy.withDeadline("python", (_signal, onProgress) => {
      onProgress("half");
      onProgress();
      return "done";
    }, { onProgress: (e) => events.push(e) });
    await expect(p).resolves.toBe("done");
    expect(events.length).toBe(2);
    expect(events[0]?.tool).toBe("python");
    expect(events[0]?.atMs).toBe(0);
    expect(events[0]?.note).toBe("half");
    expect(events[1]?.note).toBeUndefined();
  });

  test("fn 同步抛错（未到点）→ 原错误透传，非 ToolTimeoutError", async () => {
    const clock = new ManualClock();
    const policy = new ToolTimeoutPolicy({ clock });
    const p = policy.withDeadline("mcp", (): string => {
      throw new Error("boom");
    });
    const err = (await errOf(p)) as Error;
    expect(err).not.toBeInstanceOf(ToolTimeoutError);
    expect(err.message).toBe("boom");
    expect(clock.pendingCount).toBe(0);
  });

  test("fn 到点后才 reject → 迟到失败被吞（无 unhandled rejection）", async () => {
    const clock = new ManualClock();
    const policy = new ToolTimeoutPolicy({ clock });
    let rejectLate!: (err: unknown) => void;
    const p = policy.withDeadline("mcp", () =>
      new Promise<string>((_resolve, reject) => {
        rejectLate = reject;
      }),
    );
    clock.advance(60_000);
    const err = (await errOf(p)) as ToolTimeoutError;
    expect(err).toBeInstanceOf(ToolTimeoutError);
    rejectLate(new Error("late failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(err.tool).toBe("mcp");
  });
});

describe("BI-06.3 父 Deadline 预算合并", () => {
  test("父剩余 < 注册表限时 → 生效限时取父剩余", async () => {
    const clock = new ManualClock();
    const policy = new ToolTimeoutPolicy({ clock });
    const parent = deadlineFrom(5_000, clock);
    clock.advance(2_000);
    const p = policy.withDeadline("python", () => new Promise<string>(() => {}), { deadline: parent });
    clock.advance(3_000);
    const err = (await errOf(p)) as ToolTimeoutError;
    expect(err.deadlineMs).toBe(3_000);
  });

  test("注册表限时 < 父剩余 → 用注册表限时", async () => {
    const clock = new ManualClock();
    const policy = new ToolTimeoutPolicy({ clock });
    const parent = deadlineFrom(300_000, clock);
    const p = policy.withDeadline("web_search", () => new Promise<string>(() => {}), { deadline: parent });
    clock.advance(30_000);
    const err = (await errOf(p)) as ToolTimeoutError;
    expect(err.deadlineMs).toBe(30_000);
  });

  test("父 Deadline 已过期 → 按 0ms 处理（0ms 推进即超时）", async () => {
    const clock = new ManualClock();
    const policy = new ToolTimeoutPolicy({ clock });
    const parent = deadlineFrom(1_000, clock);
    clock.advance(1_000);
    const p = policy.withDeadline("mcp", () => new Promise<string>(() => {}), { deadline: parent });
    clock.advance(0);
    const err = (await errOf(p)) as ToolTimeoutError;
    expect(err.deadlineMs).toBe(0);
  });
});
