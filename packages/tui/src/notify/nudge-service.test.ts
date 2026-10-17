import { describe, expect, test } from "bun:test";
import {
  DEFAULT_NUDGE_TIMEOUT_MS,
  NudgeService,
  TERMINAL_BELL,
} from "./nudge-service";
import type { NotifyOutcome } from "./desktop-notify";
import type { Scheduler, Timer } from "../engine/paste-burst";
import { MemoryWriter } from "../testing";

/** 记录型手动调度器：记录 delay 并由测试显式触发（全离屏确定性）。 */
class RecordingScheduler implements Scheduler {
  readonly delays: number[] = [];
  private timers: { fn: () => void; canceled: boolean }[] = [];

  schedule(ms: number, fn: () => void): Timer {
    this.delays.push(ms);
    const entry = { fn, canceled: false };
    this.timers.push(entry);
    return {
      cancel: () => {
        entry.canceled = true;
      },
    };
  }

  /** 触发当前所有挂起回调。 */
  runDue(): void {
    const snapshot = [...this.timers];
    this.timers = [];
    for (const t of snapshot) {
      if (!t.canceled) t.fn();
    }
  }

  /** 未取消的挂起计时数。 */
  get size(): number {
    return this.timers.filter((t) => !t.canceled).length;
  }
}

interface Harness {
  svc: NudgeService;
  sched: RecordingScheduler;
  bell: MemoryWriter;
  notifications: { title: string; body: string; outcome: NotifyOutcome[] } & {
    fn: (title: string, body: string) => NotifyOutcome;
  };
}

function makeService(deps: Partial<ConstructorParameters<typeof NudgeService>[0]> = {}): Harness {
  const sched = new RecordingScheduler();
  const bell = new MemoryWriter();
  const notifications: { title: string; body: string; outcome: NotifyOutcome[] } & {
    fn: (title: string, body: string) => NotifyOutcome;
  } = {
    title: "",
    body: "",
    outcome: [],
    fn: (title: string, body: string) => {
      notifications.title = title;
      notifications.body = body;
      const outcome: NotifyOutcome = { status: "dry-run", command: "spy", args: [title, body] };
      notifications.outcome.push(outcome);
      return outcome;
    },
  };
  const svc = new NudgeService({
    bell,
    notifier: notifications.fn,
    scheduler: sched,
    ...deps,
  });
  return { svc, sched, bell, notifications };
}

describe("NudgeService —— 合约常量与超时", () => {
  test("默认超时 10min；自定义超时透传给调度器", () => {
    expect(DEFAULT_NUDGE_TIMEOUT_MS).toBe(10 * 60 * 1000);
    const h = makeService();
    h.svc.beginWait("d1", "删除分支");
    expect(h.sched.delays).toEqual([DEFAULT_NUDGE_TIMEOUT_MS]);
  });

  test("自定义 timeoutMs 生效", () => {
    const h = makeService({ timeoutMs: 1234 });
    h.svc.beginWait("d1");
    expect(h.sched.delays).toEqual([1234]);
  });

  test("非法超时抛 RangeError", () => {
    expect(() => makeService({ timeoutMs: 0 })).toThrow(RangeError);
    expect(() => makeService({ timeoutMs: -5 })).toThrow(RangeError);
    expect(() => makeService({ timeoutMs: 1.5 })).toThrow(RangeError);
  });

  test("蜂鸣字符常量为 BEL (\\a)", () => {
    expect(TERMINAL_BELL).toBe("\x07");
  });
});

describe("NudgeService —— 超时触发 / 取消 / 防重复", () => {
  test("超时触发：蜂鸣 \\a 写注入 writer + 桌面通知一次", () => {
    const h = makeService();
    h.svc.beginWait("d1", "批准 rm -rf build/");
    h.sched.runDue();
    expect(h.bell.output).toBe(TERMINAL_BELL);
    expect(h.notifications.outcome).toHaveLength(1);
    expect(h.notifications.title).toBe("BI 助手");
    expect(h.notifications.body).toContain("批准 rm -rf build/");
    expect(h.notifications.body).toContain("等待审批超时");
    expect(h.svc.statusOf("d1")).toBe("nudged");
    expect(h.svc.hasNudged("d1")).toBe(true);
  });

  test("审批到达取消计时：resolve 后到点不催", () => {
    const h = makeService();
    h.svc.beginWait("d1");
    expect(h.svc.statusOf("d1")).toBe("waiting");
    h.svc.resolve("d1");
    expect(h.svc.statusOf("d1")).toBe("resolved");
    h.sched.runDue();
    expect(h.bell.output).toBe("");
    expect(h.notifications.outcome).toHaveLength(0);
  });

  test("一次性防重复：已催后再 beginWait 同一 id 不再催", () => {
    const h = makeService();
    h.svc.beginWait("d1");
    h.sched.runDue(); // 第一次催
    expect(h.notifications.outcome).toHaveLength(1);
    h.svc.beginWait("d1"); // 同一 pending 决策再挂起
    expect(h.sched.size).toBe(0); // 不重排计时
    h.sched.runDue();
    expect(h.notifications.outcome).toHaveLength(1); // 仍只催过一次
    expect(h.bell.output).toBe(TERMINAL_BELL); // 蜂鸣也只有一次
  });

  test("waiting 中重复 beginWait 重置计时（单计时器）", () => {
    const h = makeService();
    h.svc.beginWait("d1");
    h.svc.beginWait("d1", "新标签");
    expect(h.sched.size).toBe(1); // 旧计时已取消
    h.svc.resolve("d1");
    h.sched.runDue();
    expect(h.notifications.outcome).toHaveLength(0);
  });

  test("resolve 未知 id 为 no-op；催办后 resolve 落定 resolved", () => {
    const h = makeService();
    expect(h.svc.statusOf("ghost")).toBe("unknown");
    h.svc.resolve("ghost"); // 不抛
    h.svc.beginWait("d1");
    h.sched.runDue();
    h.svc.resolve("d1");
    expect(h.svc.statusOf("d1")).toBe("resolved");
    expect(h.svc.hasNudged("d1")).toBe(false); // 落定后不再算 nudged
  });

  test("多决策隔离：各自只催一次，互不影响", () => {
    const h = makeService();
    h.svc.beginWait("d1", "决策一");
    h.svc.beginWait("d2", "决策二");
    expect(h.svc.size).toBe(2);
    h.svc.resolve("d2");
    h.sched.runDue();
    expect(h.notifications.outcome).toHaveLength(1); // d2 已取消
    expect(h.svc.statusOf("d1")).toBe("nudged");
    expect(h.svc.statusOf("d2")).toBe("resolved");
    expect(h.notifications.body).toContain("决策一");
  });

  test("催办后 resolve 再 beginWait：resolve 闭环即新一轮等待，可再次催办", () => {
    const h = makeService();
    h.svc.beginWait("d1");
    h.sched.runDue(); // 第一轮催办
    h.svc.resolve("d1"); // 闭环
    h.svc.beginWait("d1"); // 新一轮等待
    expect(h.svc.statusOf("d1")).toBe("waiting");
    expect(h.sched.size).toBe(1);
    h.sched.runDue();
    expect(h.notifications.outcome).toHaveLength(2); // 新周期独立催办一次
  });
});
