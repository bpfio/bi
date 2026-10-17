import { describe, expect, test } from "bun:test";
import {
  Blackboard,
  BlackboardWriteDeniedError,
  type BlackboardEvent,
  type BlackboardFact,
} from "./blackboard";
import type { A2aRole } from "./permissions";

/** 固定时钟（ts 恒定）。 */
const fixedClock = (ts: number) => ({ now: () => ts });

/** 写入被拒时取出稳定拒绝错误（未拒错/拒错类型不符则让用例失败）。 */
function deniedOf(fn: () => void): BlackboardWriteDeniedError {
  try {
    fn();
  } catch (error) {
    if (error instanceof BlackboardWriteDeniedError) return error;
    throw error;
  }
  throw new Error("期望写入被矩阵拒绝，但未抛错");
}

// ---------------------------------------------------------------------------
// 读写与注入时钟
// ---------------------------------------------------------------------------

describe("blackboard: 读写与注入时钟", () => {
  test("write → read 往返：value/source/ts 一致", () => {
    const bb = new Blackboard({ clock: fixedClock(1000) });
    const fact = bb.write("scout/findings", {
      value: { url: "https://example.com", n: 1 },
      source: "coordinator",
    });
    expect(fact).toEqual({ value: { url: "https://example.com", n: 1 }, source: "coordinator", ts: 1000 });
    expect(bb.read("scout/findings")).toEqual(fact);
  });

  test("read 未写键返回 undefined", () => {
    const bb = new Blackboard({ clock: fixedClock(1) });
    expect(bb.read("nope")).toBeUndefined();
  });

  test("write 覆盖语义（latest-wins）：read 为新值且时间线重置为单条", () => {
    const bb = new Blackboard({ clock: fixedClock(1) });
    bb.write("k", { value: "v1", source: "coordinator" });
    bb.write("k", { value: "v2", source: "coordinator" });
    expect(bb.read("k")?.value).toBe("v2");
    expect(bb.snapshot().get("k")).toHaveLength(1);
  });

  test("注入固定时钟：ts 恒为时钟值（不由调用方传入）", () => {
    const bb = new Blackboard({ clock: fixedClock(42) });
    const fact = bb.write("k", { value: true, source: "reporter" });
    expect(fact.ts).toBe(42);
  });

  test("注入递增时钟：ts 随时钟单调", () => {
    let current = 500;
    const bb = new Blackboard({ clock: { now: () => (current += 10) } });
    const f1 = bb.write("a", { value: 1, source: "coordinator" });
    const f2 = bb.write("b", { value: 2, source: "coordinator" });
    const f3 = bb.append("a", { value: 3, source: "coordinator" });
    expect(f1.ts).toBe(510);
    expect(f2.ts).toBe(520);
    expect(f3.ts).toBe(530);
  });

  test("缺省时钟：ts 为当前 epoch 毫秒量级", () => {
    const bb = new Blackboard();
    const fact = bb.write("k", { value: null, source: "coordinator" });
    expect(Number.isFinite(fact.ts)).toBe(true);
    expect(Math.abs(fact.ts - Date.now())).toBeLessThan(1_000);
  });
});

// ---------------------------------------------------------------------------
// 订阅通知与异常隔离
// ---------------------------------------------------------------------------

describe("blackboard: 订阅通知与异常隔离", () => {
  test("write 触发事件：type/key/fact 全匹配", () => {
    const bb = new Blackboard({ clock: fixedClock(7) });
    const events: BlackboardEvent[] = [];
    bb.subscribe("k", (e) => events.push(e));
    const fact = bb.write("k", { value: "v", source: "coordinator" });
    expect(events).toEqual([{ type: "write", key: "k", fact }]);
  });

  test("append 触发事件：type 为 append", () => {
    const bb = new Blackboard({ clock: fixedClock(7) });
    const events: BlackboardEvent[] = [];
    bb.subscribe("k", (e) => events.push(e));
    const fact = bb.append("k", { value: 1, source: "coordinator" });
    expect(events).toEqual([{ type: "append", key: "k", fact }]);
  });

  test("多订阅者均收到同一事件", () => {
    const bb = new Blackboard({ clock: fixedClock(7) });
    const a: unknown[] = [];
    const b: unknown[] = [];
    bb.subscribe("k", (e) => a.push(e.fact.value));
    bb.subscribe("k", (e) => b.push(e.fact.value));
    bb.write("k", { value: "v", source: "coordinator" });
    expect(a).toEqual(["v"]);
    expect(b).toEqual(["v"]);
  });

  test("订阅者异常隔离：抛错订阅者不影响其他订阅者与写入本身", () => {
    const bb = new Blackboard({ clock: fixedClock(7) });
    const seen: unknown[] = [];
    bb.subscribe("k", () => {
      throw new Error("subscriber boom");
    });
    bb.subscribe("k", (e) => seen.push(e.fact.value));
    expect(() => bb.write("k", { value: "ok", source: "coordinator" })).not.toThrow();
    expect(seen).toEqual(["ok"]);
    expect(bb.read("k")?.value).toBe("ok");
  });

  test("退订函数生效：退订后不再收到事件", () => {
    const bb = new Blackboard({ clock: fixedClock(7) });
    const events: unknown[] = [];
    const off = bb.subscribe("k", (e) => events.push(e));
    off();
    bb.write("k", { value: "v", source: "coordinator" });
    expect(events).toHaveLength(0);
  });

  test("跨键不串扰：订阅 a，写 b 不通知", () => {
    const bb = new Blackboard({ clock: fixedClock(7) });
    const events: unknown[] = [];
    bb.subscribe("a", (e) => events.push(e));
    bb.write("b", { value: 1, source: "coordinator" });
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// append 列表型事实追加
// ---------------------------------------------------------------------------

describe("blackboard: append 列表型事实追加", () => {
  test("空键 append：建立单条时间线，read 可读", () => {
    const bb = new Blackboard({ clock: fixedClock(7) });
    const fact = bb.append("log", { value: "first", source: "reporter" });
    expect(fact.ts).toBe(7);
    expect(bb.read("log")).toEqual(fact);
    expect(bb.snapshot().get("log")).toHaveLength(1);
  });

  test("append 累积有序：write + append×2 → 时间线 3 条，read 为最后一条", () => {
    const bb = new Blackboard({ clock: fixedClock(7) });
    bb.write("log", { value: "w1", source: "coordinator" });
    bb.append("log", { value: "a1", source: "reporter" });
    bb.append("log", { value: "a2", source: "reporter" });
    const timeline = bb.snapshot().get("log");
    expect(timeline?.map((f) => f.value)).toEqual(["w1", "a1", "a2"]);
    expect(timeline?.map((f) => f.source)).toEqual(["coordinator", "reporter", "reporter"]);
    expect(bb.read("log")?.value).toBe("a2");
  });

  test("append 同样受矩阵约束：scout append 被拒", () => {
    const bb = new Blackboard({ clock: fixedClock(7) });
    expect(deniedOf(() => bb.append("log", { value: "x", source: "scout" })).reason).toBe(
      "denied-by-matrix",
    );
    expect(bb.read("log")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 写权限与角色矩阵联动（BI-15.3 assertCapability）
// ---------------------------------------------------------------------------

describe("blackboard: 写权限与角色矩阵联动（BI-15.3 assertCapability）", () => {
  test("scout write 被拒：denied-by-matrix（矩阵禁写）", () => {
    const bb = new Blackboard({ clock: fixedClock(7) });
    const error = deniedOf(() => bb.write("k", { value: 1, source: "scout" }));
    expect(error.reason).toBe("denied-by-matrix");
    expect(error.role).toBe("scout");
    expect(error.capability).toBe("write");
  });

  test("auditor write 被拒：denied-by-matrix", () => {
    const bb = new Blackboard({ clock: fixedClock(7) });
    expect(deniedOf(() => bb.write("k", { value: 1, source: "auditor" })).reason).toBe(
      "denied-by-matrix",
    );
  });

  test("coordinator write/append 放行", () => {
    const bb = new Blackboard({ clock: fixedClock(7) });
    expect(bb.write("k", { value: 1, source: "coordinator" }).source).toBe("coordinator");
    expect(bb.append("k", { value: 2, source: "coordinator" }).value).toBe(2);
  });

  test("reporter write/append 放行", () => {
    const bb = new Blackboard({ clock: fixedClock(7) });
    expect(bb.write("k", { value: "draft", source: "reporter" }).value).toBe("draft");
    expect(bb.append("k", { value: "draft2", source: "reporter" }).value).toBe("draft2");
  });

  test("未知角色 write 被拒：unknown-role（deny-by-default）", () => {
    const bb = new Blackboard({ clock: fixedClock(7) });
    const stranger = "root" as string as A2aRole;
    expect(deniedOf(() => bb.write("k", { value: 1, source: stranger })).reason).toBe("unknown-role");
  });

  test("拒绝无副作用：未建键、未通知订阅者", () => {
    const bb = new Blackboard({ clock: fixedClock(7) });
    const events: unknown[] = [];
    bb.subscribe("k", (e) => events.push(e));
    deniedOf(() => bb.write("k", { value: 1, source: "scout" }));
    expect(bb.snapshot().has("k")).toBe(false);
    expect(bb.read("k")).toBeUndefined();
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// snapshot 快照
// ---------------------------------------------------------------------------

describe("blackboard: snapshot 快照", () => {
  test("全量快照：键集合与时间线一致", () => {
    const bb = new Blackboard({ clock: fixedClock(7) });
    bb.write("a/1", { value: 1, source: "coordinator" });
    bb.write("b/1", { value: 2, source: "reporter" });
    const snap = bb.snapshot();
    expect([...snap.keys()].sort()).toEqual(["a/1", "b/1"]);
    expect(snap.get("a/1")?.[0]?.value).toBe(1);
  });

  test("prefix 过滤：仅命中前缀键", () => {
    const bb = new Blackboard({ clock: fixedClock(7) });
    bb.write("scout/findings", { value: 1, source: "coordinator" });
    bb.write("scout/notes", { value: 2, source: "coordinator" });
    bb.write("audit/x", { value: 3, source: "coordinator" });
    const snap = bb.snapshot("scout/");
    expect([...snap.keys()].sort()).toEqual(["scout/findings", "scout/notes"]);
    expect(snap.has("audit/x")).toBe(false);
  });

  test("防御性拷贝：修改快照数组不影响底账", () => {
    const bb = new Blackboard({ clock: fixedClock(7) });
    bb.write("k", { value: "real", source: "coordinator" });
    const snap = bb.snapshot();
    const timeline = snap.get("k") as BlackboardFact[];
    timeline.push({ value: "fake", source: "coordinator", ts: 999 });
    expect(bb.read("k")?.value).toBe("real");
    expect(bb.snapshot().get("k")).toHaveLength(1);
  });

  test("已订阅未写键不出现在快照（无幻影键）", () => {
    const bb = new Blackboard({ clock: fixedClock(7) });
    bb.subscribe("ghost", () => {});
    expect(bb.snapshot().size).toBe(0);
  });
});
