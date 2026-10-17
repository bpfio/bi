/**
 * BI-10.5 · interruption-recovery 测试。
 *
 * 覆盖：残缺判定矩阵（空串/空白/null/空数组/全空块/混合块/未闭合
 * tool_use）、规范提醒文案逐字断言、一次性消费（offer/take 语义）。
 */
import { describe, expect, test } from "bun:test";
import {
  INTERRUPTION_NOTICE_TEXT,
  InterruptionInjector,
  buildInterruptionNotice,
  type InterruptedTurn,
} from "./interruption-recovery";

const turn = (over: Partial<InterruptedTurn> = {}): InterruptedTurn => ({
  role: "assistant",
  content: "working on it",
  ...over,
});

describe("BI-10.5 · 规范提醒文案", () => {
  test("文案逐字等于工单钉死字符串", () => {
    expect(INTERRUPTION_NOTICE_TEXT).toBe(
      "The previous turn was interrupted by the user before completion. " +
        "Resume the task from the last verified state; do not apologize.",
    );
  });

  test("残缺轮 notice.text 与常量逐字相等（组装方注入源）", () => {
    expect(buildInterruptionNotice(turn({ content: "" })).text).toBe(INTERRUPTION_NOTICE_TEXT);
  });
});

describe("BI-10.5 · 残缺判定矩阵", () => {
  test("空串 content → 残缺", () => {
    expect(buildInterruptionNotice(turn({ content: "" }))).toEqual({
      text: INTERRUPTION_NOTICE_TEXT,
      interrupted: true,
    });
  });

  test("空白串 content → 残缺", () => {
    expect(buildInterruptionNotice(turn({ content: "   \n\t" })).interrupted).toBe(true);
  });

  test("null / undefined content → 残缺", () => {
    expect(buildInterruptionNotice(turn({ content: null })).interrupted).toBe(true);
    expect(buildInterruptionNotice(turn({ content: undefined })).interrupted).toBe(true);
  });

  test("空块数组 content [] → 残缺", () => {
    expect(buildInterruptionNotice(turn({ content: [] })).interrupted).toBe(true);
  });

  test("全空块数组（空串/null/空对象）过滤后无实质块 → 残缺", () => {
    expect(buildInterruptionNotice(turn({ content: ["", null, {}, "  "] })).interrupted).toBe(true);
  });

  test("混合块数组：过滤后仍有实质块 → 完整（工单判定=空内容才残缺）", () => {
    expect(buildInterruptionNotice(turn({ content: ["", "部分输出文本"] })).interrupted).toBe(false);
  });

  test("未闭合 tool_use（toolUseIds 非空）→ 残缺，即使有实质内容", () => {
    expect(buildInterruptionNotice(turn({ toolUseIds: ["t1"] })).interrupted).toBe(true);
  });

  test("空 toolUseIds 数组 + 实质内容 → 完整", () => {
    expect(buildInterruptionNotice(turn({ toolUseIds: [] })).interrupted).toBe(false);
  });

  test("未闭合 tool_use 与空内容并存：单一提醒不叠加", () => {
    const n = buildInterruptionNotice(turn({ content: "", toolUseIds: ["a", "b"] }));
    expect(n.interrupted).toBe(true);
    expect(n.text).toBe(INTERRUPTION_NOTICE_TEXT);
  });

  test("完整轮：text 空串且 interrupted=false（不注入）", () => {
    expect(buildInterruptionNotice(turn())).toEqual({ text: "", interrupted: false });
    expect(buildInterruptionNotice(turn({ content: [{ type: "text", text: "done" }] })).interrupted).toBe(false);
  });
});

describe("BI-10.5 · InterruptionInjector 一次性消费", () => {
  test("offer 残缺轮 → take 取走文本；再次 take → null（消费即清空）", () => {
    const inj = new InterruptionInjector();
    expect(inj.offer(turn({ content: "" }))).toBe(true);
    expect(inj.hasPending).toBe(true);
    expect(inj.take()).toBe(INTERRUPTION_NOTICE_TEXT);
    expect(inj.take()).toBeNull();
    expect(inj.hasPending).toBe(false);
  });

  test("未 offer 直接 take → null", () => {
    expect(new InterruptionInjector().take()).toBeNull();
  });

  test("消费后可重新 offer（新一轮中断再次生效）", () => {
    const inj = new InterruptionInjector();
    inj.offer(turn({ content: "" }));
    inj.take();
    expect(inj.offer(turn({ toolUseIds: ["x"] }))).toBe(true);
    expect(inj.take()).toBe(INTERRUPTION_NOTICE_TEXT);
  });

  test("offer 完整轮：无待发；且覆盖清空旧待发（裁定：新证据取代旧提醒）", () => {
    const inj = new InterruptionInjector();
    inj.offer(turn({ content: "" }));
    expect(inj.offer(turn({ content: "完成了" }))).toBe(false);
    expect(inj.take()).toBeNull();
  });

  test("顺序相反：先完整后残缺 → 待发生效", () => {
    const inj = new InterruptionInjector();
    inj.offer(turn({ content: "ok" }));
    inj.offer(turn({ toolUseIds: ["t"] }));
    expect(inj.take()).toBe(INTERRUPTION_NOTICE_TEXT);
  });
});
