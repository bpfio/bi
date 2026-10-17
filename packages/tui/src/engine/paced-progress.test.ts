import { describe, expect, test } from "bun:test";
import { DEFAULT_RENDER_INTERVAL_MS, PacedProgress } from "./paced-progress";

describe("PacedProgress —— 构造", () => {
  test("默认间隔 50ms，可配置覆盖；非法间隔抛 RangeError", () => {
    expect(DEFAULT_RENDER_INTERVAL_MS).toBe(50);
    expect(new PacedProgress().intervalMs).toBe(50);
    expect(new PacedProgress({ intervalMs: 100 }).intervalMs).toBe(100);
    expect(() => new PacedProgress({ intervalMs: 0 })).toThrow(RangeError);
    expect(() => new PacedProgress({ intervalMs: -1 })).toThrow(RangeError);
    expect(() => new PacedProgress({ intervalMs: 2.5 })).toThrow(RangeError);
  });

  test("初始态：未渲染未 tick，nextDue 立即到期", () => {
    const p = new PacedProgress();
    expect(p.renders).toBe(0);
    expect(p.lastTickAt).toBeUndefined();
    expect(p.lastRenderedAt).toBeUndefined();
    expect(p.nextDue()).toBe(0);
  });
});

describe("PacedProgress —— 节流窗口矩阵（注入时钟）", () => {
  test("首帧直通：t=0 渲染", () => {
    const p = new PacedProgress();
    expect(p.tick(0)).toBe(true);
    expect(p.renders).toBe(1);
  });

  test("窗口矩阵：5ms / 49ms 不渲染，50ms 渲染，51ms 不渲染", () => {
    const p = new PacedProgress();
    expect(p.tick(0)).toBe(true); // 渲染基线
    expect(p.tick(5)).toBe(false); // 5 < 50
    expect(p.tick(49)).toBe(false); // 49 < 50
    expect(p.tick(50)).toBe(true); // 50 >= 50（含边界）
    expect(p.tick(51)).toBe(false); // 51-50 = 1 < 50
    expect(p.renders).toBe(2);
  });

  test("边界含等号：上次渲染后第 50ms 恰好到期", () => {
    const p = new PacedProgress();
    p.tick(100);
    expect(p.tick(149)).toBe(false);
    expect(p.tick(150)).toBe(true);
    expect(p.nextDue()).toBe(200);
  });

  test("上游慢 → 直通：间隔远超 50ms 的事件逐次渲染", () => {
    const p = new PacedProgress();
    expect(p.tick(0)).toBe(true);
    expect(p.tick(200)).toBe(true);
    expect(p.tick(500)).toBe(true);
    expect(p.renders).toBe(3);
  });

  test("上游快 → 保持 50ms 基准：1ms 步进高频 push 渲染次数上限", () => {
    const p = new PacedProgress();
    let rendered = 0;
    for (let t = 0; t <= 1000; t += 1) {
      if (p.tick(t)) rendered += 1;
    }
    // 1000ms / 50ms = 20 窗口 + 首帧 = 21 次；事件循环保护上界成立
    expect(rendered).toBe(p.renders);
    expect(p.renders).toBeLessThanOrEqual(21);
    expect(p.renders).toBe(21);
  });

  test("不规则高频：突发 3ms 间隔只渲染窗口首帧", () => {
    const p = new PacedProgress();
    expect(p.tick(0)).toBe(true);
    expect(p.tick(3)).toBe(false);
    expect(p.tick(6)).toBe(false);
    expect(p.tick(9)).toBe(false);
    expect(p.tick(52)).toBe(true);
    expect(p.tick(55)).toBe(false);
    expect(p.renders).toBe(2);
  });
});

describe("PacedProgress —— 查询与记录分离", () => {
  test("shouldRender 纯查询：不改状态、不推进渲染计数", () => {
    const p = new PacedProgress();
    expect(p.shouldRender(0)).toBe(true); // 首帧
    expect(p.shouldRender(1000)).toBe(true); // 仍未渲染：持续直通
    expect(p.renders).toBe(0);
    expect(p.lastTickAt).toBeUndefined();
    expect(p.tick(10)).toBe(true); // 首帧真实发生
    expect(p.tick(20)).toBe(false);
    expect(p.renders).toBe(1);
  });

  test("markRendered 外部记录：shouldRender + markRendered 组合等价 tick", () => {
    const p = new PacedProgress();
    expect(p.shouldRender(0)).toBe(true);
    p.markRendered(0);
    expect(p.shouldRender(30)).toBe(false);
    expect(p.shouldRender(50)).toBe(true);
    p.markRendered(50);
    expect(p.nextDue()).toBe(100);
    expect(p.renders).toBe(2);
  });

  test("nextDue 随渲染推进：未渲染=立即到期，渲染后=lastRender+interval", () => {
    const p = new PacedProgress();
    p.tick(70); // 首帧直通
    expect(p.nextDue()).toBe(120);
    p.tick(90); // 未到期
    expect(p.nextDue()).toBe(120);
    p.tick(120); // 到期
    expect(p.nextDue()).toBe(170);
  });

  test("lastTickAt 记录最近一次上游推进（无论是否渲染）", () => {
    const p = new PacedProgress();
    p.tick(5);
    expect(p.lastTickAt).toBe(5);
    p.tick(7);
    expect(p.lastTickAt).toBe(7);
    expect(p.lastRenderedAt).toBe(5);
  });
});
