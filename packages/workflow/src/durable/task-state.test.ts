/**
 * BI-14.5 · Durable 任务状态机测试（纯内存，零 IO）。
 *
 * 覆盖工单钉死的转移表语义：
 * 1. 六条合法边全部放行（pending→running、running→suspended/failed/completed、
 *    suspended→running、failed→pending）；
 * 2. 非法转移矩阵：所有不在表内的 (from, to) 一律结构化报错 invalid-transition；
 * 3. completed 绝对终态无出边、自环拒绝；
 * 4. 25 对组合穷举：合法恰六条，不多不少；
 * 5. 错误对象结构可判别（code / from / to / name）。
 */
import { describe, expect, test } from "bun:test";
import {
  assertTransition,
  InvalidTransitionError,
  TASK_STATES,
  TRANSITIONS,
} from "./task-state";
import type { TaskState } from "./task-state";

/** 合法边全集（与 TRANSITIONS 常量互为镜像，用于穷举交叉验证）。 */
const LEGAL_EDGES: Array<[TaskState, TaskState]> = [
  ["pending", "running"],
  ["running", "suspended"],
  ["running", "failed"],
  ["running", "completed"],
  ["suspended", "running"],
  ["failed", "pending"],
];

describe("BI-14.5 状态机转移表", () => {
  test("六条合法边全部放行", () => {
    for (const [from, to] of LEGAL_EDGES) {
      expect(() => assertTransition(from, to)).not.toThrow();
    }
  });

  test("pending 只准去 running：→suspended / →completed / →failed 拒绝", () => {
    expect(() => assertTransition("pending", "suspended")).toThrow(InvalidTransitionError);
    expect(() => assertTransition("pending", "completed")).toThrow(InvalidTransitionError);
    expect(() => assertTransition("pending", "failed")).toThrow(InvalidTransitionError);
  });

  test("running 不准回退 pending", () => {
    expect(() => assertTransition("running", "pending")).toThrow(InvalidTransitionError);
  });

  test("suspended 只准去 running：→failed / →completed / →pending / →suspended 拒绝", () => {
    expect(() => assertTransition("suspended", "failed")).toThrow(InvalidTransitionError);
    expect(() => assertTransition("suspended", "completed")).toThrow(InvalidTransitionError);
    expect(() => assertTransition("suspended", "pending")).toThrow(InvalidTransitionError);
    expect(() => assertTransition("suspended", "suspended")).toThrow(InvalidTransitionError);
  });

  test("failed 只准重试回 pending：→running / →suspended / →completed / →failed 拒绝", () => {
    expect(() => assertTransition("failed", "running")).toThrow(InvalidTransitionError);
    expect(() => assertTransition("failed", "suspended")).toThrow(InvalidTransitionError);
    expect(() => assertTransition("failed", "completed")).toThrow(InvalidTransitionError);
    expect(() => assertTransition("failed", "failed")).toThrow(InvalidTransitionError);
  });

  test("completed 为绝对终态：全部去向拒绝", () => {
    for (const to of TASK_STATES) {
      expect(() => assertTransition("completed", to)).toThrow(InvalidTransitionError);
    }
  });

  test("自环转移（各态→自身）一律拒绝", () => {
    for (const state of TASK_STATES) {
      expect(() => assertTransition(state, state)).toThrow(InvalidTransitionError);
    }
  });

  test("25 对组合穷举：合法恰六条，与 LEGAL_EDGES 镜像一致", () => {
    const legalKeys = new Set(LEGAL_EDGES.map(([f, t]) => `${f}->${t}`));
    // 转移表常量自身展开也应恰为六条
    const tableKeys = new Set(
      Object.entries(TRANSITIONS).flatMap(([from, tos]) =>
        tos.map((to) => `${from}->${to}`),
      ),
    );
    expect(tableKeys).toEqual(legalKeys);

    let passed = 0;
    for (const from of TASK_STATES) {
      for (const to of TASK_STATES) {
        const key = `${from}->${to}`;
        try {
          assertTransition(from, to);
          passed++;
          expect(legalKeys.has(key)).toBe(true);
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidTransitionError);
          expect(legalKeys.has(key)).toBe(false);
        }
      }
    }
    expect(passed).toBe(6);
  });

  test("错误对象结构：code=invalid-transition，from/to/name 可判别", () => {
    try {
      assertTransition("completed", "pending");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransitionError);
      const err = error as InvalidTransitionError;
      expect(err.code).toBe("invalid-transition");
      expect(err.from).toBe("completed");
      expect(err.to).toBe("pending");
      expect(err.name).toBe("InvalidTransitionError");
      expect(err.message).toContain("completed -> pending");
    }
  });
});
