/**
 * BI-14.1 · Taint 污点分析编译器测试。
 *
 * 覆盖矩阵：单/多跳传播、污染步集合、source→sink 路径枚举、sanitize 中断路径、
 * 双路径一消毒一未消毒、无关步与不可达汇、多 source 多 sink 矩阵、非法输入
 * （未知 source/sink、环）、独立 unsanitizedFlows 口径一致、零 source 零噪音。
 */
import { describe, expect, test } from "bun:test";
import { taintAnalysis, unsanitizedFlows } from "./taint";
import { CausalityError } from "./causality-graph";
import type { TaintStep } from "./taint";

/** 断言同步调用抛出指定 code 的 CausalityError。 */
function expectTaintCode(fn: () => unknown, code: CausalityError["code"]): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(CausalityError);
  expect((caught as CausalityError).code).toBe(code);
}

describe("BI-14.1 · taintAnalysis（污染传播与路径审计）", () => {
  test("单 source 单 sink 直连：污染步集合与未消毒路径", () => {
    const steps: TaintStep[] = [
      { id: "src", depends_on: [] },
      { id: "sink", depends_on: ["src"] },
    ];
    const result = taintAnalysis(steps, ["src"], ["sink"]);
    expect(result.taintedSteps).toEqual(["src", "sink"]);
    expect(result.taintedPaths).toEqual([
      { source: "src", sink: "sink", path: ["src", "sink"], sanitized: false },
    ]);
    expect(result.unsanitizedFlows).toHaveLength(1);
  });

  test("多跳传播：中间步被污染，路径完整", () => {
    const steps: TaintStep[] = [
      { id: "src", depends_on: [] },
      { id: "mid", depends_on: ["src"] },
      { id: "sink", depends_on: ["mid"] },
      { id: "clean", depends_on: [] },
    ];
    const result = taintAnalysis(steps, ["src"], ["sink"]);
    expect(result.taintedSteps).toEqual(["src", "mid", "sink"]); // clean 不受污染
    expect(result.taintedPaths).toEqual([
      { source: "src", sink: "sink", path: ["src", "mid", "sink"], sanitized: false },
    ]);
  });

  test("sanitize 中断路径：中间消毒步 → sanitized=true，移出 unsanitizedFlows", () => {
    const steps: TaintStep[] = [
      { id: "src", depends_on: [] },
      { id: "wash", depends_on: ["src"], metadata: { sanitize: true } },
      { id: "sink", depends_on: ["wash"] },
    ];
    const result = taintAnalysis(steps, ["src"], ["sink"]);
    expect(result.taintedSteps).toEqual(["src", "wash", "sink"]); // 传播不中断，审计区分
    expect(result.taintedPaths[0]!.sanitized).toBe(true);
    expect(result.unsanitizedFlows).toEqual([]);
  });

  test("双路径一消毒一未消毒：unsanitizedFlows 只收未消毒支", () => {
    const steps: TaintStep[] = [
      { id: "src", depends_on: [] },
      { id: "wash", depends_on: ["src"], metadata: { sanitize: true } },
      { id: "raw", depends_on: ["src"] },
      { id: "sinkA", depends_on: ["wash"] },
      { id: "sinkB", depends_on: ["raw"] },
    ];
    const result = taintAnalysis(steps, ["src"], ["sinkA", "sinkB"]);
    expect(result.taintedPaths).toHaveLength(2);
    expect(result.unsanitizedFlows).toEqual([
      { source: "src", sink: "sinkB", path: ["src", "raw", "sinkB"], sanitized: false },
    ]);
  });

  test("多 source 多 sink 矩阵：路径按 source × 可达枚举", () => {
    const steps: TaintStep[] = [
      { id: "s1", depends_on: [] },
      { id: "s2", depends_on: [] },
      { id: "hub", depends_on: ["s1", "s2"] },
      { id: "k1", depends_on: ["hub"] },
      { id: "k2", depends_on: ["hub"] },
    ];
    const result = taintAnalysis(steps, ["s1", "s2"], ["k1", "k2"]);
    expect(result.taintedSteps).toEqual(["s1", "s2", "hub", "k1", "k2"]);
    expect(result.taintedPaths.map((p) => [p.source, p.sink, p.path])).toEqual([
      ["s1", "k1", ["s1", "hub", "k1"]],
      ["s1", "k2", ["s1", "hub", "k2"]],
      ["s2", "k1", ["s2", "hub", "k1"]],
      ["s2", "k2", ["s2", "hub", "k2"]],
    ]);
  });

  test("sink 可作中转：路径在 sink 处记录并继续延伸", () => {
    const steps: TaintStep[] = [
      { id: "src", depends_on: [] },
      { id: "k1", depends_on: ["src"] },
      { id: "k2", depends_on: ["k1"] },
    ];
    const result = taintAnalysis(steps, ["src"], ["k1", "k2"]);
    expect(result.taintedPaths.map((p) => p.path)).toEqual([
      ["src", "k1"],
      ["src", "k1", "k2"],
    ]);
  });

  test("sink 不可达 source：无路径（可达性而非全集笛卡尔）", () => {
    const steps: TaintStep[] = [
      { id: "src", depends_on: [] },
      { id: "isolated", depends_on: [] },
    ];
    const result = taintAnalysis(steps, ["src"], ["isolated"]);
    expect(result.taintedSteps).toEqual(["src"]);
    expect(result.taintedPaths).toEqual([]);
    expect(result.unsanitizedFlows).toEqual([]);
  });

  test("环图 → cycle-detected（路径枚举前置拒绝）", () => {
    const steps: TaintStep[] = [
      { id: "a", depends_on: ["b"] },
      { id: "b", depends_on: ["a"] },
    ];
    expectTaintCode(() => taintAnalysis(steps, ["a"], ["b"]), "cycle-detected");
  });

  test("未知 source / sink → unknown-node", () => {
    const steps: TaintStep[] = [{ id: "s", depends_on: [] }];
    expectTaintCode(() => taintAnalysis(steps, ["ghost"], []), "unknown-node");
    expectTaintCode(() => taintAnalysis(steps, [], ["ghost"]), "unknown-node");
  });

  test("独立 unsanitizedFlows 口径与 result.unsanitizedFlows 一致；零 source 零噪音", () => {
    const steps: TaintStep[] = [
      { id: "src", depends_on: [] },
      { id: "sink", depends_on: ["src"] },
    ];
    expect(unsanitizedFlows(steps, ["src"], ["sink"])).toEqual(
      taintAnalysis(steps, ["src"], ["sink"]).unsanitizedFlows,
    );
    const empty = taintAnalysis(steps, [], ["sink"]);
    expect(empty.taintedSteps).toEqual([]);
    expect(empty.taintedPaths).toEqual([]);
    expect(empty.unsanitizedFlows).toEqual([]);
  });
});
