/**
 * BI-14.4 · ModeMutexCoordinator 测试。
 *
 * 覆盖工单钉死的测试矩阵：
 * 1. 互斥矩阵全对：4 模式 × 4 已激活组合（16 组合表驱动，含幂等重入），
 *    断言强退集合恰为与进入模式互斥的已激活者；
 * 2. forced-exit 事件稽核：exitedBy 字段、exit(reason=forced) 双通道、
 *    强退发射序确定性（canonical 声明序）；
 * 3. goal+swarm 并存特例：双向保留、plan 一进双清；
 * 4. 多 session 同模式共存：互斥是单 session 语义，跨 session 零干扰；
 * 5. 非法 exit：not-active / unknown-mode / bad-session-id 结构化拒绝；
 * 6. EventBus 行为：FIFO 调用序、off 退订、监听器异常隔离、幂等重入零事件。
 */
import { describe, expect, test } from "bun:test";
import {
  ModeMutexCoordinator,
  ModeMutexError,
  WORKFLOW_MODES,
  isExclusive,
} from "./mode-mutex";
import type { ModeEvent, WorkflowMode } from "./mode-mutex";

/** 断言同步调用抛出指定 code 的 ModeMutexError。 */
function expectMutexCode(fn: () => unknown, code: ModeMutexError["code"]): ModeMutexError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ModeMutexError);
  const err = caught as ModeMutexError;
  expect(err.code).toBe(code);
  return err;
}

/** 事件收集器（按序记录全部事件）。 */
function collector(coord: ModeMutexCoordinator): { events: ModeEvent[]; attach: () => void } {
  const events: ModeEvent[] = [];
  for (const type of ["enter", "exit", "forced-exit"] as const) {
    coord.on(type, (event) => events.push(event));
  }
  return { events, attach: () => {} };
}

describe("BI-14.4 · 互斥矩阵（单 session 语义）", () => {
  test("isExclusive 全对：除 swarm×goal 外两两互斥，同模式不互斥", () => {
    for (const a of WORKFLOW_MODES) {
      for (const b of WORKFLOW_MODES) {
        const expected =
          a !== b && !((a === "swarm" && b === "goal") || (a === "goal" && b === "swarm"));
        expect(`${a}×${b}=${isExclusive(a, b)}`).toBe(`${a}×${b}=${expected}`);
      }
    }
  });

  test("4×4 进入组合矩阵全对（16 组合表驱动，含幂等重入）", () => {
    for (const active of WORKFLOW_MODES) {
      for (const entering of WORKFLOW_MODES) {
        const coord = new ModeMutexCoordinator();
        coord.enter(active, "s");
        const result = coord.enter(entering, "s");
        if (active === entering) {
          expect(`${active}→${entering}: no-op`).toBe(`${active}→${entering}: no-op`);
          expect(result.forcedExits).toEqual([]);
          expect(coord.activeModes("s")).toEqual([active]);
          continue;
        }
        const shouldForce = isExclusive(active, entering);
        expect(`${active}→${entering}: forced=${shouldForce}`).toBe(
          `${active}→${entering}: forced=${shouldForce}`,
        );
        if (shouldForce) {
          expect(result.forcedExits).toEqual([
            { mode: active, sessionId: "s", exitedBy: entering },
          ]);
          expect(coord.activeModes("s")).toEqual([entering]);
        } else {
          // goal+swarm 并存特例：保留已激活者，canonical 序
          expect(result.forcedExits).toEqual([]);
          expect(coord.activeModes("s")).toEqual(["swarm", "goal"]);
        }
      }
    }
  });

  test("goal+swarm 并存特例：双向保留；plan 一进双清（稽核双记录）", () => {
    const coord = new ModeMutexCoordinator();
    const r1 = coord.enter("swarm", "s");
    const r2 = coord.enter("goal", "s");
    expect(r1.forcedExits).toEqual([]);
    expect(r2.forcedExits).toEqual([]); // 互不干扰
    expect(coord.activeModes("s")).toEqual(["swarm", "goal"]);

    const r3 = coord.enter("plan", "s");
    expect(r3.forcedExits).toEqual([
      { mode: "swarm", sessionId: "s", exitedBy: "plan" },
      { mode: "goal", sessionId: "s", exitedBy: "plan" },
    ]);
    expect(coord.activeModes("s")).toEqual(["plan"]);

    // 反向：goal 已激活时进 swarm 同样保留 goal
    const coord2 = new ModeMutexCoordinator();
    coord2.enter("goal", "s2");
    expect(coord2.enter("swarm", "s2").forcedExits).toEqual([]);
    expect(coord2.activeModes("s2")).toEqual(["swarm", "goal"]);
  });

  test("forced-exit 事件稽核：exit(reason=forced, exitedBy) + forced-exit 双通道，发射序确定", () => {
    const coord = new ModeMutexCoordinator();
    const { events } = collector(coord);
    coord.enter("swarm", "s");
    coord.enter("goal", "s");
    coord.enter("tower", "s");
    coord.enter("plan", "s");
    const forced = events.filter((e) => e.type === "forced-exit");
    expect(forced).toEqual([
      { type: "forced-exit", mode: "swarm", sessionId: "s", exitedBy: "tower" },
      { type: "forced-exit", mode: "goal", sessionId: "s", exitedBy: "tower" },
      { type: "forced-exit", mode: "tower", sessionId: "s", exitedBy: "plan" },
    ]);
    const exits = events.filter((e) => e.type === "exit");
    expect(exits.every((e) => e.reason === "forced" && e.exitedBy !== undefined)).toBe(true);
    expect(events.filter((e) => e.type === "enter")).toHaveLength(4);
  });

  test("多 session 同模式共存：互斥是单 session 语义，跨 session 零干扰", () => {
    const coord = new ModeMutexCoordinator();
    coord.enter("plan", "s1");
    coord.enter("plan", "s2");
    expect(coord.activeModes("s1")).toEqual(["plan"]);
    expect(coord.activeModes("s2")).toEqual(["plan"]);
    const result = coord.enter("swarm", "s2"); // 只强退 s2 的 plan
    expect(result.forcedExits).toEqual([{ mode: "plan", sessionId: "s2", exitedBy: "swarm" }]);
    expect(coord.activeModes("s1")).toEqual(["plan"]); // s1 不受影响
    expect(coord.activeModes("s2")).toEqual(["swarm"]);
  });

  test("幂等重入：同 session 同模式重复 enter → no-op、零事件、forcedExits 空", () => {
    const coord = new ModeMutexCoordinator();
    const { events } = collector(coord);
    coord.enter("plan", "s");
    const second = coord.enter("plan", "s");
    expect(second.forcedExits).toEqual([]);
    expect(events.filter((e) => e.type === "enter")).toHaveLength(1); // 第二次零事件
    expect(coord.activeModes("s")).toEqual(["plan"]);
  });
});

describe("BI-14.4 · exit 与非法操作", () => {
  test("显式 exit：reason=explicit、激活集合清空、退出后可干净重进", () => {
    const coord = new ModeMutexCoordinator();
    const { events } = collector(coord);
    coord.enter("plan", "s");
    coord.exit("plan", "s");
    expect(coord.activeModes("s")).toEqual([]);
    expect(events.filter((e) => e.type === "exit")).toEqual([
      { type: "exit", mode: "plan", sessionId: "s", reason: "explicit" },
    ]);
    coord.enter("swarm", "s"); // 干净重入
    expect(coord.activeModes("s")).toEqual(["swarm"]);
  });

  test("非法 exit：未激活模式 → not-active（结构化拒绝，状态不变）", () => {
    const coord = new ModeMutexCoordinator();
    coord.enter("plan", "s");
    expectMutexCode(() => coord.exit("swarm", "s"), "not-active");
    expectMutexCode(() => coord.exit("plan", "ghost"), "not-active");
    expect(coord.activeModes("s")).toEqual(["plan"]);
  });

  test("非法入参：未知模式 → unknown-mode；空 sessionId → bad-session-id", () => {
    const coord = new ModeMutexCoordinator();
    expectMutexCode(
      () => coord.enter("unknown" as WorkflowMode, "s"),
      "unknown-mode",
    );
    expectMutexCode(() => coord.exit("plan", ""), "bad-session-id");
    expectMutexCode(() => coord.enter("plan", ""), "bad-session-id");
    expectMutexCode(
      () => coord.exit("plan" as WorkflowMode, "s"),
      "not-active",
    );
  });
});

describe("BI-14.4 · EventBus 行为", () => {
  test("监听器 FIFO 调用序；off 退订后不再收事件", () => {
    const coord = new ModeMutexCoordinator();
    const order: string[] = [];
    const l1 = (): void => {
      order.push("l1");
    };
    const l2 = (): void => {
      order.push("l2");
    };
    coord.on("enter", l1);
    const unsubscribe = coord.on("enter", l2);
    coord.enter("plan", "s");
    expect(order).toEqual(["l1", "l2"]);
    unsubscribe(); // 退订 l2
    order.length = 0;
    coord.exit("plan", "s");
    coord.enter("tower", "s");
    expect(order).toEqual(["l1"]); // l2 已退订
  });

  test("监听器异常隔离：抛错监听器不阻断协调器与后续监听器", () => {
    const coord = new ModeMutexCoordinator();
    const seen: string[] = [];
    coord.on("enter", () => {
      throw new Error("listener boom");
    });
    coord.on("enter", (e) => seen.push(e.mode));
    const result = coord.enter("plan", "s");
    expect(result.mode).toBe("plan"); // 协调器不受影响
    expect(seen).toEqual(["plan"]); // 后续监听器照常收到
    expect(coord.activeModes("s")).toEqual(["plan"]);
  });

  test("事件负载判别：type 字段可辨 enter / exit / forced-exit", () => {
    const coord = new ModeMutexCoordinator();
    const { events } = collector(coord);
    coord.enter("swarm", "s");
    coord.enter("plan", "s");
    coord.exit("plan", "s");
    expect(events.map((e) => e.type)).toEqual([
      "enter",
      "exit",
      "forced-exit",
      "enter",
      "exit",
    ]);
  });
});
