/**
 * BI-03.3 会话状态空间正规化与不变量防竞态矩阵 测试。
 *
 * 覆盖面（工单要求 ≥16 用例）：
 *  - 矩阵穷举采样（合法/非法各半，90 格确定计数）；
 *  - 三条不变量正反例（卡面原句备案项逐一验证）；
 *  - 矩阵完整性（30 态 × 3 动作无 undefined 格）；
 *  - assertTransition 合法/非法目标态。
 */
import { describe, expect, test } from "bun:test";
import {
  ACTIVE_WORKS,
  Invariants,
  MATRIX_ACTIONS,
  QUEUE_AUTHORITIES,
  RUN_PHASES,
  StateMatrix,
  StateMatrixViolationError,
} from "./state-matrix";
import type { MatrixState, RunPhase } from "./state-matrix";

const matrix = new StateMatrix();

const PHASES_FOR_ALLOWED_COUNT: readonly RunPhase[] = ["idle", "verifying"];

/** 全状态空间 5×3×2=30 格的确定性穷举。 */
function allStates(): MatrixState[] {
  const states: MatrixState[] = [];
  for (const phase of RUN_PHASES) {
    for (const activeWork of ACTIVE_WORKS) {
      for (const queueAuthority of QUEUE_AUTHORITIES) {
        states.push({ phase, activeWork, queueAuthority });
      }
    }
  }
  return states;
}

/* --------------------------------- 状态空间与矩阵完整性 --------------------------------- */

describe("状态空间正规化", () => {
  test("笛卡尔积规模：5 相位 × 3 工作负载 × 2 队列权威 = 30 格", () => {
    expect(RUN_PHASES.length).toBe(5);
    expect(ACTIVE_WORKS.length).toBe(3);
    expect(QUEUE_AUTHORITIES.length).toBe(2);
    expect(allStates().length).toBe(30);
  });

  test("矩阵完整性：30 态 × 3 动作全部有确定裁决，无 undefined 格", () => {
    for (const state of allStates()) {
      for (const action of MATRIX_ACTIONS) {
        const verdict = matrix.verdict(state, action);
        expect(verdict).toBeDefined();
        expect(typeof verdict.allowed).toBe("boolean");
        if (!verdict.allowed) {
          expect(verdict.reason).toBeTruthy(); // 拒绝必带可诊断理由
        }
      }
      const allowed = matrix.allowedActions(state);
      expect(allowed.every((a) => MATRIX_ACTIONS.includes(a))).toBe(true);
    }
  });

  test("穷举采样：90 (state, action) 格中允许 50、拒绝 40（合法/非法各半且确定）", () => {
    let allowed = 0;
    let denied = 0;
    for (const state of allStates()) {
      for (const action of MATRIX_ACTIONS) {
        if (matrix.verdict(state, action).allowed) allowed += 1;
        else denied += 1;
      }
    }
    // 基表：idle/verifying 各 3 动作，其余相位各 1（cancel）→ 每权威 25；
    // subagent 否决 compact（idle/verifying 各 1 格 × 2 权威 = 4）→ 50。
    expect(allowed).toBe(50);
    expect(denied).toBe(40);
  });

  test("基础表抽查：idle/verifying 全允许（subagent 除外）；忙碌相位仅 cancel", () => {
    for (const work of ACTIVE_WORKS) {
      for (const authority of QUEUE_AUTHORITIES) {
        // 卡面不变量：activeWork=subagent 时 compact 拒绝 → idle/verifying 只剩 fork/cancel。
        const idleExpected = work === "subagent" ? ["fork", "cancel"] : ["compact", "fork", "cancel"];
        expect(matrix.allowedActions({ phase: "idle", activeWork: work, queueAuthority: authority })).toEqual(idleExpected);
        expect(matrix.allowedActions({ phase: "verifying", activeWork: work, queueAuthority: authority })).toEqual(idleExpected);
        for (const busy of ["thinking", "tool-executing", "compacting"] as const) {
          expect(matrix.allowedActions({ phase: busy, activeWork: work, queueAuthority: authority })).toEqual([
            "cancel",
          ]);
        }
      }
    }
  });
});

/* --------------------------------- 不变量（卡面原句逐条） --------------------------------- */

describe("inv_noCompactDuringSubagent（activeWork=subagent 时 compact 动作拒绝）", () => {
  test("正例：idle/subagent 下 compact 被否决，checkAll 报出不变量 id", () => {
    const state: MatrixState = { phase: "idle", activeWork: "subagent", queueAuthority: "user" };
    expect(Invariants.checkAll(state, "compact")).toContain("inv_noCompactDuringSubagent");
    const verdict = matrix.verdict(state, "compact");
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("inv_noCompactDuringSubagent");
  });

  test("反例：idle/none 下 compact 放行；verifying/subagent 同样被拒", () => {
    const none: MatrixState = { phase: "idle", activeWork: "none", queueAuthority: "agent" };
    expect(Invariants.checkAll(none, "compact")).toEqual([]);
    expect(matrix.verdict(none, "compact").allowed).toBe(true);
    const verifyingSub: MatrixState = {
      phase: "verifying",
      activeWork: "subagent",
      queueAuthority: "user",
    };
    expect(matrix.verdict(verifyingSub, "compact").allowed).toBe(false);
  });
});

describe("inv_noForkMidStream（thinking/tool-executing 中 fork 拒绝）", () => {
  test("正例：thinking 与 tool-executing 下 fork 均被否决", () => {
    for (const phase of ["thinking", "tool-executing"] as const) {
      const state: MatrixState = { phase, activeWork: "none", queueAuthority: "user" };
      expect(Invariants.checkAll(state, "fork")).toContain("inv_noForkMidStream");
      expect(matrix.verdict(state, "fork").allowed).toBe(false);
    }
  });

  test("反例：idle 与 verifying 下 fork 放行", () => {
    for (const phase of ["idle", "verifying"] as const) {
      const state: MatrixState = { phase, activeWork: "workflow", queueAuthority: "agent" };
      expect(Invariants.checkAll(state, "fork")).toEqual([]);
      expect(matrix.verdict(state, "fork").allowed).toBe(true);
    }
  });
});

describe("inv_userAuthorityPreempt（queueAuthority=user 时 cancel 恒允许）", () => {
  test("正例：全 30 态中 queueAuthority=user 的 cancel 一律放行（保底型生效）", () => {
    for (const state of allStates()) {
      if (state.queueAuthority !== "user") continue;
      expect(Invariants.forcesAllow(state, "cancel")).toBe(true);
      expect(matrix.verdict(state, "cancel").allowed).toBe(true);
    }
  });

  test("反例：queueAuthority=agent 时不触发保底（cancel 放行来自基础表而非不变量）", () => {
    const state: MatrixState = {
      phase: "tool-executing",
      activeWork: "subagent",
      queueAuthority: "agent",
    };
    expect(Invariants.forcesAllow(state, "cancel")).toBe(false);
    // 放行仍成立，但来源是基础表：cancel 全态放行的设计决策。
    expect(matrix.verdict(state, "cancel").allowed).toBe(true);
  });

  test("checkAll 多重违反不误报：thinking/subagent + compact 只报 compact 不变量", () => {
    const state: MatrixState = { phase: "thinking", activeWork: "subagent", queueAuthority: "user" };
    expect(Invariants.checkAll(state, "compact")).toEqual(["inv_noCompactDuringSubagent"]);
    expect(Invariants.checkAll(state, "fork")).toEqual(["inv_noForkMidStream"]);
    expect(Invariants.checkAll(state, "cancel")).toEqual([]);
  });
});

/* --------------------------------- assertTransition --------------------------------- */

describe("assertTransition", () => {
  test("合法转移：idle/none/user --compact--> compacting/none/user", () => {
    const from: MatrixState = { phase: "idle", activeWork: "none", queueAuthority: "user" };
    expect(() =>
      matrix.assertTransition(from, "compact", {
        phase: "compacting",
        activeWork: "none",
        queueAuthority: "user",
      }),
    ).not.toThrow();
    expect(matrix.transitionTarget(from, "compact")).toEqual({
      phase: "compacting",
      activeWork: "none",
      queueAuthority: "user",
    });
  });

  test("fork 不改本会话状态：规范目标 = 原状态", () => {
    const from: MatrixState = { phase: "verifying", activeWork: "workflow", queueAuthority: "agent" };
    expect(matrix.transitionTarget(from, "fork")).toEqual(from);
    expect(() => matrix.assertTransition(from, "fork", from)).not.toThrow();
  });

  test("cancel 清运行态：phase→idle、activeWork→none，队列权威保留", () => {
    const from: MatrixState = {
      phase: "tool-executing",
      activeWork: "subagent",
      queueAuthority: "user",
    };
    expect(matrix.transitionTarget(from, "cancel")).toEqual({
      phase: "idle",
      activeWork: "none",
      queueAuthority: "user",
    });
  });

  test("非法动作 → StateMatrixViolationError（reason 含不变量 id）", () => {
    const from: MatrixState = { phase: "thinking", activeWork: "none", queueAuthority: "user" };
    let caught: unknown;
    try {
      matrix.assertTransition(from, "fork", from);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StateMatrixViolationError);
    const violation = caught as StateMatrixViolationError;
    expect(violation.reason).toContain("inv_noForkMidStream");
    expect(violation.action).toBe("fork");
  });

  test("非法目标态 → StateMatrixViolationError（compact 落点必须为 compacting）", () => {
    const from: MatrixState = { phase: "idle", activeWork: "none", queueAuthority: "user" };
    expect(() =>
      matrix.assertTransition(from, "compact", {
        phase: "idle",
        activeWork: "none",
        queueAuthority: "user",
      }),
    ).toThrow(StateMatrixViolationError);
  });

  test("allowedActions 与 verdict 全域一致（30 态 × 3 动作交叉验证）", () => {
    for (const state of allStates()) {
      const allowed = new Set(matrix.allowedActions(state));
      for (const action of MATRIX_ACTIONS) {
        expect(allowed.has(action)).toBe(matrix.verdict(state, action).allowed);
      }
    }
  });
});
