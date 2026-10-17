/**
 * BI-10 · WindowManager 测试。
 *
 * 覆盖：outputReserve 数学（默认 min(64000, max/4) 与覆盖值）、0.8 水位
 * 电平与一次性上行沿、0.35 回落复位与再武装、3 击熔断、子水位读数清零、
 * 非法输入 RangeError、零视窗退化守护、snapshot 全字段。
 */
import { describe, expect, test } from "bun:test";
import {
  BREAKER_STRIKES,
  COMPACT_WATERMARK,
  DEFAULT_OUTPUT_RESERVE_CAP,
  RESET_WATERMARK,
  WindowManager,
  defaultOutputReserve,
} from "./window-manager";

describe("BI-10 WindowManager · 有效视窗与水位数学", () => {
  test("默认 outputReserve = min(64000, floor(max/4))：200K → 50000/150000", () => {
    expect(defaultOutputReserve(200_000)).toBe(50_000);
    const wm = new WindowManager();
    wm.updateUsage(0, 200_000);
    expect(wm.effectiveWindow()).toBe(150_000);
  });

  test("reserve 封顶 64000：300K → 64000/236000", () => {
    expect(defaultOutputReserve(300_000)).toBe(DEFAULT_OUTPUT_RESERVE_CAP);
    const wm = new WindowManager();
    wm.updateUsage(0, 300_000);
    expect(wm.effectiveWindow()).toBe(236_000);
  });

  test("构造覆盖 outputReserve 生效", () => {
    const wm = new WindowManager({ outputReserve: 10_000 });
    wm.updateUsage(0, 100_000);
    expect(wm.effectiveWindow()).toBe(90_000);
  });

  test("ratio 电平语义：恰好 0.8 应紧缩，0.79 不应", () => {
    const wm = new WindowManager();
    wm.updateUsage(60_000, 100_000); // 60000/75000 = 0.8 整
    expect(wm.ratio()).toBeCloseTo(COMPACT_WATERMARK);
    expect(wm.shouldCompact()).toBe(true);
    wm.updateUsage(59_000, 100_000);
    expect(wm.shouldCompact()).toBe(false);
  });

  test("snapshot 全字段精确", () => {
    const wm = new WindowManager();
    wm.updateUsage(61_000, 100_000);
    const s = wm.snapshot();
    expect(s.promptTokens).toBe(61_000);
    expect(s.maxTokens).toBe(100_000);
    expect(s.outputReserve).toBe(25_000);
    expect(s.effectiveWindow).toBe(75_000);
    expect(s.ratio).toBeCloseTo(61_000 / 75_000);
    expect(s.alertActive).toBe(true);
    expect(s.strikes).toBe(0);
    expect(s.tripped).toBe(false);
  });

  test("零视窗退化：0/0 → ratio 0 无 NaN；有用量无视窗 → Infinity", () => {
    const wm = new WindowManager();
    wm.updateUsage(0, 0);
    expect(wm.ratio()).toBe(0);
    expect(wm.shouldCompact()).toBe(false);
    wm.updateUsage(100, 0);
    expect(wm.ratio()).toBe(Number.POSITIVE_INFINITY);
    expect(wm.shouldCompact()).toBe(true);
  });
});

describe("BI-10 WindowManager · 水位沿与复位", () => {
  test("上行沿一次性触发：同回合第二次消费为 false，持续超水位不重发", () => {
    const wm = new WindowManager();
    wm.updateUsage(61_000, 100_000); // 0.813 上行穿越
    expect(wm.crossedWatermark()).toBe(true);
    expect(wm.crossedWatermark()).toBe(false);
    wm.updateUsage(62_000, 100_000); // 仍超水位：不重发沿
    expect(wm.crossedWatermark()).toBe(false);
  });

  test("0.35 回落复位后重新武装；0.35~0.8 徘徊不复位不发沿（裁定）", () => {
    const wm = new WindowManager();
    wm.updateUsage(61_000, 100_000);
    expect(wm.crossedWatermark()).toBe(true);
    // 回落到 0.5：告警态保持，不发新沿。
    wm.updateUsage(37_500, 100_000);
    expect(wm.crossedWatermark()).toBe(false);
    expect(wm.snapshot().alertActive).toBe(true);
    // 回升 0.81：alert 已激活 → 无新沿（0.35 才复位）。
    wm.updateUsage(61_000, 100_000);
    expect(wm.crossedWatermark()).toBe(false);
    // 跌破 0.35：复位；再穿越 0.8 → 沿重新武装。
    wm.updateUsage(20_000, 100_000);
    expect(wm.snapshot().alertActive).toBe(false);
    wm.updateUsage(61_000, 100_000);
    expect(wm.crossedWatermark()).toBe(true);
  });

  test("常量钉死：0.8 / 0.35 / 64000 / 3 击", () => {
    expect(COMPACT_WATERMARK).toBe(0.8);
    expect(RESET_WATERMARK).toBe(0.35);
    expect(DEFAULT_OUTPUT_RESERVE_CAP).toBe(64_000);
    expect(BREAKER_STRIKES).toBe(3);
  });
});

describe("BI-10 WindowManager · 3 击熔断器", () => {
  test("连续 3 击仍超水位 → 熔断", () => {
    const wm = new WindowManager();
    wm.updateUsage(61_000, 100_000);
    wm.recordCompaction();
    expect(wm.isTripped()).toBe(false);
    wm.updateUsage(61_500, 100_000); // 仍超水位：连击保留
    wm.recordCompaction();
    expect(wm.isTripped()).toBe(false);
    wm.updateUsage(62_000, 100_000);
    expect(wm.strikes()).toBe(2);
    wm.recordCompaction(); // 第 3 击
    expect(wm.isTripped()).toBe(true);
    expect(wm.strikes()).toBe(3);
  });

  test("低于水位的读数证明紧缩有效：清零连击", () => {
    const wm = new WindowManager();
    wm.updateUsage(61_000, 100_000);
    wm.recordCompaction();
    wm.updateUsage(59_000, 100_000); // 0.787 < 0.8 → 连击清零
    expect(wm.strikes()).toBe(0);
    wm.recordCompaction();
    expect(wm.isTripped()).toBe(false);
  });

  test("reset 全量复位（含熔断态）", () => {
    const wm = new WindowManager();
    wm.updateUsage(61_000, 100_000);
    wm.recordCompaction();
    wm.recordCompaction();
    wm.recordCompaction();
    expect(wm.isTripped()).toBe(true);
    wm.reset();
    const s = wm.snapshot();
    expect(s.tripped).toBe(false);
    expect(s.strikes).toBe(0);
    expect(s.alertActive).toBe(false);
    expect(s.promptTokens).toBe(0);
  });
});

describe("BI-10 WindowManager · 配置守护", () => {
  test("非法用量输入抛 RangeError：负数 / NaN", () => {
    const wm = new WindowManager();
    expect(() => wm.updateUsage(-1, 100_000)).toThrow(RangeError);
    expect(() => wm.updateUsage(10, Number.NaN)).toThrow(RangeError);
    expect(() => wm.updateUsage(Number.POSITIVE_INFINITY, 100_000)).toThrow(RangeError);
  });

  test("非法构造 outputReserve 抛 RangeError", () => {
    expect(() => new WindowManager({ outputReserve: -5 })).toThrow(RangeError);
    expect(() => new WindowManager({ outputReserve: Number.NaN })).toThrow(RangeError);
  });
});
