/**
 * BI-06.3 · 截止时间预算（Deadline）测试（注入虚拟时钟，零真实等待）。
 *
 * 覆盖：remainingMs/expired/throwIfExpired 基本语义；子 Deadline 继承
 * 剩余预算与越界钳制（子操作不得超越父截止）；deadlineFrom 边界与
 * systemClock 冒烟。
 */
import { describe, expect, test } from "bun:test";
import { DeadlineExpiredError, deadlineFrom, systemClock } from "./deadline";
import type { Clock } from "./deadline";

/** 可手动拨动的虚拟时钟（零等待测试）。 */
class ManualClock implements Clock {
  #now = 1_700_000_000_000;
  #seq = 0;
  readonly #timers = new Map<number, { at: number; handler: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(handler: () => void, ms: number): unknown {
    const id = ++this.#seq;
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), handler });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  advance(ms: number): void {
    this.#now += ms;
  }
}

describe("BI-06.3 Deadline 基本语义", () => {
  test("deadlineFrom(1000)：剩余 = 1000，未过期", () => {
    const clock = new ManualClock();
    const d = deadlineFrom(1_000, clock);
    expect(d.remainingMs()).toBe(1_000);
    expect(d.expired).toBe(false);
  });

  test("remainingMs 随时钟推进递减，过期后钳制为 0（不为负）", () => {
    const clock = new ManualClock();
    const d = deadlineFrom(1_000, clock);
    clock.advance(400);
    expect(d.remainingMs()).toBe(600);
    clock.advance(2_000);
    expect(d.remainingMs()).toBe(0);
    clock.advance(10_000);
    expect(d.remainingMs()).toBe(0);
  });

  test("expired：推进到点后由 false 变 true", () => {
    const clock = new ManualClock();
    const d = deadlineFrom(1_000, clock);
    clock.advance(999);
    expect(d.expired).toBe(false);
    clock.advance(1);
    expect(d.expired).toBe(true);
  });

  test("throwIfExpired：未过期静默通过；过期抛 DeadlineExpiredError（name/code）", () => {
    const clock = new ManualClock();
    const d = deadlineFrom(100, clock);
    expect(() => d.throwIfExpired()).not.toThrow();
    clock.advance(100);
    try {
      d.throwIfExpired();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DeadlineExpiredError);
      expect((err as DeadlineExpiredError).name).toBe("DeadlineExpiredError");
      expect((err as DeadlineExpiredError).code).toBe("DEADLINE_EXPIRED");
    }
  });

  test("deadlineFrom 负数/0 → 立即过期", () => {
    const clock = new ManualClock();
    expect(deadlineFrom(0, clock).expired).toBe(true);
    expect(deadlineFrom(-5, clock).expired).toBe(true);
    expect(deadlineFrom(-5, clock).remainingMs()).toBe(0);
  });

  test("systemClock 冒烟：真实时钟下 50ms 预算未过期且剩余在 (0,50]", () => {
    const d = deadlineFrom(50);
    expect(d.expired).toBe(false);
    const remaining = d.remainingMs();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(50);
  });

  test("expiresAtMs = clock.now() + 预算（绝对到期线可检视）", () => {
    const clock = new ManualClock();
    const d = deadlineFrom(250, clock);
    expect(d.expiresAtMs).toBe(clock.now() + 250);
  });
});

describe("BI-06.3 子 Deadline 继承与越界拒绝", () => {
  test("child() 缺省继承父剩余预算", () => {
    const clock = new ManualClock();
    const parent = deadlineFrom(1_000, clock);
    clock.advance(200);
    const child = parent.child();
    expect(child.remainingMs()).toBe(800);
    expect(child.expiresAtMs).toBe(parent.expiresAtMs);
  });

  test("child() 与父共享到期线：父过期则子必过期", () => {
    const clock = new ManualClock();
    const parent = deadlineFrom(1_000, clock);
    const child = parent.child();
    clock.advance(1_000);
    expect(parent.expired).toBe(true);
    expect(child.expired).toBe(true);
  });

  test("child(300) 收紧子预算 → 300（短于父剩余）", () => {
    const clock = new ManualClock();
    const parent = deadlineFrom(1_000, clock);
    const child = parent.child(300);
    expect(child.remainingMs()).toBe(300);
    expect(child.expired).toBe(false);
  });

  test("child(5000) 越界请求 → 钳制到父剩余（子不得超越父截止）", () => {
    const clock = new ManualClock();
    const parent = deadlineFrom(1_000, clock);
    clock.advance(200);
    const child = parent.child(5_000);
    expect(child.remainingMs()).toBe(800);
    expect(child.remainingMs()).toBeLessThanOrEqual(parent.remainingMs());
    expect(child.expiresAtMs).toBe(parent.expiresAtMs);
  });

  test("child(0) / child(负数) → 即刻过期的子预算", () => {
    const clock = new ManualClock();
    const parent = deadlineFrom(1_000, clock);
    expect(parent.child(0).expired).toBe(true);
    expect(parent.child(-10).expired).toBe(true);
  });

  test("孙级派生仍不得超越祖父到期线", () => {
    const clock = new ManualClock();
    const grandparent = deadlineFrom(1_000, clock);
    clock.advance(500);
    const parent = grandparent.child();
    const child = parent.child(10_000);
    expect(child.remainingMs()).toBe(500);
    expect(child.expiresAtMs).toBe(grandparent.expiresAtMs);
  });

  test("子预算独立推进：父未过期时收紧的子可先过期", () => {
    const clock = new ManualClock();
    const parent = deadlineFrom(1_000, clock);
    const child = parent.child(300);
    clock.advance(300);
    expect(child.expired).toBe(true);
    expect(parent.expired).toBe(false);
  });
});
