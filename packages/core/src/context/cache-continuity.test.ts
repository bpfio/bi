/**
 * BI-10.3 · cache-continuity 测试。
 *
 * 覆盖：reserve 折减矩阵（大/小 maxTokens、显式封顶）、与 window-manager
 * 协作无公式漂移、compactRequest 的 tools 恒等断言（JSON.stringify 全等）
 * 与原消息零改写、handleOverflowError 的 400/413/500 分类。
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_COMPACT_INSTRUCTION,
  compactRequest,
  effectiveWindow,
  handleOverflowError,
} from "./cache-continuity";
import { DEFAULT_OUTPUT_RESERVE_CAP, defaultOutputReserve, WindowManager } from "./window-manager";
import type { Msg } from "./tool-pairing";

describe("BI-10.3 · effectiveWindow reserve 折减矩阵", () => {
  test("小 maxTokens：quarter 规则 floor(maxTokens/4)", () => {
    expect(effectiveWindow(1_000)).toBe(1_000 - 250);
    expect(effectiveWindow(8_000)).toBe(8_000 - 2_000);
    expect(effectiveWindow(100)).toBe(75);
  });

  test("大 maxTokens：reserve 封顶 64_000", () => {
    expect(effectiveWindow(400_000)).toBe(400_000 - DEFAULT_OUTPUT_RESERVE_CAP);
    expect(effectiveWindow(1_000_000)).toBe(1_000_000 - 64_000);
  });

  test("maxTokens=0：有效视窗 0", () => {
    expect(effectiveWindow(0)).toBe(0);
  });

  test("显式 maxOutputTokens：min(maxOutputTokens, 64_000) 封顶", () => {
    expect(effectiveWindow(100_000, { maxOutputTokens: 64_000 })).toBe(36_000);
    expect(effectiveWindow(100_000, { maxOutputTokens: 100_000 })).toBe(36_000); // 封顶 64_000
    expect(effectiveWindow(100_000, { maxOutputTokens: 32_000 })).toBe(68_000);
    expect(effectiveWindow(100_000, { maxOutputTokens: 0 })).toBe(100_000);
  });

  test("reserve 超过 maxTokens：钳到 0（不出现负视窗）", () => {
    expect(effectiveWindow(10_000, { maxOutputTokens: 64_000 })).toBe(0);
  });

  test("非法输入：负数/非有限 maxTokens 与 maxOutputTokens 抛 RangeError", () => {
    expect(() => effectiveWindow(-1)).toThrow(RangeError);
    expect(() => effectiveWindow(Number.NaN)).toThrow(RangeError);
    expect(() => effectiveWindow(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => effectiveWindow(1_000, { maxOutputTokens: -5 })).toThrow(RangeError);
    expect(() => effectiveWindow(1_000, { maxOutputTokens: Number.NaN })).toThrow(RangeError);
  });
});

describe("BI-10.3 · 与 window-manager 协作无公式漂移", () => {
  test("缺省路径与 WindowManager 缺省 effectiveWindow 全等（矩阵）", () => {
    for (const mt of [0, 1, 1_000, 8_000, 64_000, 128_000, 200_000, 256_000, 400_000, 1_000_000]) {
      const wm = new WindowManager();
      wm.updateUsage(0, mt);
      expect(effectiveWindow(mt)).toBe(wm.effectiveWindow());
      expect(effectiveWindow(mt)).toBe(Math.max(0, mt - defaultOutputReserve(mt)));
    }
  });

  test("显式路径与 WindowManager outputReserve 覆盖语义等价", () => {
    for (const [mt, reserve] of [
      [100_000, 64_000],
      [100_000, 32_000],
      [50_000, 0],
      [8_000, 64_000],
    ] as const) {
      const wm = new WindowManager({ outputReserve: reserve });
      wm.updateUsage(0, mt);
      expect(effectiveWindow(mt, { maxOutputTokens: reserve })).toBe(wm.effectiveWindow());
    }
  });

  test("封顶常量复用 window-manager 的 DEFAULT_OUTPUT_RESERVE_CAP（单一来源）", () => {
    expect(DEFAULT_OUTPUT_RESERVE_CAP).toBe(64_000);
    expect(effectiveWindow(200_000, { maxOutputTokens: 128_000 })).toBe(200_000 - 64_000);
  });
});

describe("BI-10.3 · compactRequest 缓存连续性", () => {
  const msgs: Msg[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "hello" },
    { role: "assistant", toolCallId: "t1", toolName: "Bash", content: "" },
    { role: "tool", toolCallId: "t1", content: "out" },
  ];

  test("尾部追加指令 user 消息，前缀逐元素恒等", () => {
    const r = compactRequest(msgs);
    expect(r.preservedToolDefs).toBe(true);
    expect(r.messages.length).toBe(msgs.length + 1);
    expect(r.messages.slice(0, msgs.length)).toEqual(msgs);
    const last = r.messages[r.messages.length - 1] as Msg;
    expect(last.role).toBe("user");
  });

  test("缺省指令含钉死语义「不要调用工具，仅输出摘要」", () => {
    const r = compactRequest<Msg>([]);
    const last = r.messages[0] as Msg;
    expect(last.content).toBe(DEFAULT_COMPACT_INSTRUCTION);
    expect(DEFAULT_COMPACT_INSTRUCTION).toContain("不要调用工具，仅输出摘要");
  });

  test("自定义 instruction 覆盖缺省", () => {
    const r = compactRequest(msgs, { instruction: "custom-constraint" });
    const last = r.messages[r.messages.length - 1] as Msg;
    expect(last.content).toBe("custom-constraint");
  });

  test("不改写入参数组（新数组）", () => {
    const snapshot = [...msgs];
    compactRequest(msgs);
    expect(msgs).toEqual(snapshot);
    expect(msgs.length).toBe(4);
  });

  test("tools 恒等断言：同引用回传且 JSON.stringify 全等", () => {
    const tools = [
      { name: "Bash", input_schema: { type: "object", properties: { command: { type: "string" } } } },
      { name: "Read", input_schema: { type: "object" } },
    ];
    const r = compactRequest(msgs, { tools });
    expect(r.preservedToolDefs).toBe(true);
    expect(r.tools).toBe(tools); // 同引用：零改写
    expect(JSON.stringify(r.tools)).toBe(JSON.stringify(tools)); // 全等
  });

  test("未注入 tools：结果不含 tools 字段", () => {
    const r = compactRequest(msgs);
    expect("tools" in r).toBe(false);
  });

  test("泛型保型：Msg[] 入 → Msg[] 出（元素类型不丢）", () => {
    const r = compactRequest(msgs);
    const first = r.messages[0];
    const role: string = (first as Msg).role; // 若类型丢失此处编译错
    expect(role).toBe("system");
  });

  test("空 messages：仅含一条指令消息", () => {
    const r = compactRequest<Msg>([]);
    expect(r.messages.length).toBe(1);
    expect((r.messages[0] as Msg).role).toBe("user");
  });
});

describe("BI-10.3 · handleOverflowError 判级", () => {
  const compactVerdict = { willRetry: true, action: "compact" as const };

  test("status=400/413：compact 重试", () => {
    expect(handleOverflowError({ status: 400 })).toEqual(compactVerdict);
    expect(handleOverflowError({ status: 413 })).toEqual(compactVerdict);
  });

  test("statusCode 注入形态：400/413 识别", () => {
    expect(handleOverflowError({ statusCode: 413 })).toEqual(compactVerdict);
    expect(handleOverflowError({ statusCode: 400 })).toEqual(compactVerdict);
  });

  test("code 注入形态：数字与数字串均识别", () => {
    expect(handleOverflowError({ code: 413 })).toEqual(compactVerdict);
    expect(handleOverflowError({ code: "413" })).toEqual(compactVerdict);
    expect(handleOverflowError({ code: "400" })).toEqual(compactVerdict);
  });

  test("Error 对象携带 status：识别", () => {
    const err = Object.assign(new Error("prompt too long"), { status: 413 });
    expect(handleOverflowError(err)).toEqual(compactVerdict);
  });

  test("5xx/429：escalate 不重试", () => {
    expect(handleOverflowError({ status: 500 })).toEqual({ willRetry: false, action: "escalate" });
    expect(handleOverflowError({ status: 503 })).toEqual({ willRetry: false, action: "escalate" });
    expect(handleOverflowError({ status: 429 })).toEqual({ willRetry: false, action: "escalate" });
  });

  test("无状态/非对象/空值：escalate", () => {
    expect(handleOverflowError(new Error("plain"))).toEqual({ willRetry: false, action: "escalate" });
    expect(handleOverflowError(undefined)).toEqual({ willRetry: false, action: "escalate" });
    expect(handleOverflowError(null)).toEqual({ willRetry: false, action: "escalate" });
    expect(handleOverflowError("413")).toEqual({ willRetry: false, action: "escalate" });
    expect(handleOverflowError({ status: "too-long" })).toEqual({ willRetry: false, action: "escalate" });
  });

  test("verdict 形状恒定：恰两字段", () => {
    expect(Object.keys(handleOverflowError({ status: 413 })).sort()).toEqual(["action", "willRetry"]);
  });
});
