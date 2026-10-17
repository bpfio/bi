/**
 * BI-14.1 · 因果拓扑图编译器测试。
 *
 * 覆盖矩阵：Kahn 层次正确性（线性链/菱形/独立同层）、环检测（二步环/自依赖/
 * 附卡死清单）、非法图（重复 id/未知依赖）、死锁判定（无环/环/悬空依赖/空图）、
 * Mermaid 输出快照（菱形精确串/空图/孤立节点裸声明）。
 */
import { describe, expect, test } from "bun:test";
import { CausalityError, detectDeadlock, toMermaid, topoSort } from "./causality-graph";
import type { GraphStep } from "./causality-graph";

/** 断言同步调用抛出指定 code 的 CausalityError。 */
function expectGraphCode(fn: () => unknown, code: CausalityError["code"]): CausalityError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(CausalityError);
  const err = caught as CausalityError;
  expect(err.code).toBe(code);
  return err;
}

describe("BI-14.1 · topoSort（Kahn）", () => {
  test("线性链 a→b→c：order 层序拼接，layers 逐层单元素", () => {
    const steps: GraphStep[] = [
      { id: "a", depends_on: [] },
      { id: "b", depends_on: ["a"] },
      { id: "c", depends_on: ["b"] },
    ];
    expect(topoSort(steps)).toEqual({
      order: ["a", "b", "c"],
      layers: [["a"], ["b"], ["c"]],
    });
  });

  test("菱形：层次正确，层内保持声明顺序", () => {
    const steps: GraphStep[] = [
      { id: "d", depends_on: ["b", "c"] },
      { id: "b", depends_on: ["a"] },
      { id: "c", depends_on: ["a"] },
      { id: "a", depends_on: [] },
    ];
    const result = topoSort(steps);
    expect(result.layers).toEqual([["a"], ["b", "c"], ["d"]]);
    expect(result.order).toEqual(["a", "b", "c", "d"]);
  });

  test("无依赖步骤同层并列", () => {
    const steps: GraphStep[] = [
      { id: "x", depends_on: [] },
      { id: "y", depends_on: [] },
      { id: "z", depends_on: [] },
    ];
    expect(topoSort(steps).layers).toEqual([["x", "y", "z"]]);
  });

  test("二步环 → cycle-detected（附卡死步骤清单）", () => {
    const err = expectGraphCode(
      () =>
        topoSort([
          { id: "a", depends_on: ["b"] },
          { id: "b", depends_on: ["a"] },
        ]),
      "cycle-detected",
    );
    expect(err.message).toContain("a");
    expect(err.message).toContain("b");
  });

  test("自依赖 → cycle-detected", () => {
    expectGraphCode(() => topoSort([{ id: "a", depends_on: ["a"] }]), "cycle-detected");
  });

  test("重复 id → duplicate-step；未知依赖 → unknown-dep", () => {
    expectGraphCode(
      () =>
        topoSort([
          { id: "s", depends_on: [] },
          { id: "s", depends_on: [] },
        ]),
      "duplicate-step",
    );
    expectGraphCode(() => topoSort([{ id: "s", depends_on: ["ghost"] }]), "unknown-dep");
  });
});

describe("BI-14.1 · detectDeadlock", () => {
  test("无环图 → false；空图 → false", () => {
    expect(detectDeadlock([{ id: "a", depends_on: ["b"] }, { id: "b", depends_on: [] }])).toBe(
      false,
    );
    expect(detectDeadlock([])).toBe(false);
  });

  test("环 → true；依赖悬空（条件永不满足）→ true", () => {
    expect(
      detectDeadlock([
        { id: "a", depends_on: ["b"] },
        { id: "b", depends_on: ["a"] },
      ]),
    ).toBe(true);
    expect(detectDeadlock([{ id: "a", depends_on: ["ghost"] }])).toBe(true);
  });
});

describe("BI-14.1 · toMermaid", () => {
  test("菱形快照：节点裸声明 + 依赖边", () => {
    const steps: GraphStep[] = [
      { id: "a", depends_on: [] },
      { id: "b", depends_on: ["a"] },
      { id: "c", depends_on: ["a"] },
      { id: "d", depends_on: ["b", "c"] },
    ];
    expect(toMermaid(steps)).toBe(
      ["graph TD", "  a", "  b", "  c", "  d", "  a --> b", "  a --> c", "  b --> d", "  c --> d"].join(
        "\n",
      ),
    );
  });

  test("空图仅 graph TD；孤立节点裸声明可见", () => {
    expect(toMermaid([])).toBe("graph TD");
    expect(toMermaid([{ id: "lonely", depends_on: [] }])).toBe(
      ["graph TD", "  lonely"].join("\n"),
    );
  });
});
