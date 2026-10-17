/**
 * BI-04.3 — cache-stats 测试。
 *
 * 覆盖：命中/丢失记账口径、expired 浪费成本账单（tokens × 单价）、
 * 命中率（空态 0）、快照不可变、render() 确定性看板（同状态恒同字节、
 * 固定小数位）。全部纯内存，零网络。
 */

import { describe, expect, test } from 'bun:test';

import { CacheStats } from './cache-stats';

describe('BI-04.3 · CacheStats 记账', () => {
  test('空态：全零 + hitRate=0（不出现 NaN）', () => {
    const s = new CacheStats();
    const snap = s.snapshot();
    expect(snap.hits).toBe(0);
    expect(snap.misses).toBe(0);
    expect(snap.hitTokens).toBe(0);
    expect(snap.missedTokens).toBe(0);
    expect(snap.hitRate).toBe(0);
    expect(snap.expiredWastedTokens).toBe(0);
    expect(snap.expiredWastedCostUsd).toBe(0);
  });

  test('recordHit 累计次数与 token', () => {
    const s = new CacheStats();
    s.recordHit(1000);
    s.recordHit(500);
    const snap = s.snapshot();
    expect(snap.hits).toBe(2);
    expect(snap.hitTokens).toBe(1500);
  });

  test('recordMiss 缺省 reason=cold', () => {
    const s = new CacheStats();
    s.recordMiss(300);
    const snap = s.snapshot();
    expect(snap.misses).toBe(1);
    expect(snap.missedTokens).toBe(300);
    expect(snap.expiredWastedTokens).toBe(0);
    expect(snap.expiredWastedCostUsd).toBe(0);
  });

  test('reason=expired 同步累计浪费账单：tokens × 缺省单价', () => {
    const s = new CacheStats();
    s.recordMiss(600, 'expired');
    const snap = s.snapshot();
    expect(snap.expiredWastedTokens).toBe(600);
    expect(snap.expiredWastedCostUsd).toBeCloseTo(600 * 0.00000027, 12);
  });

  test('cold / evicted 丢失不计入浪费账单', () => {
    const s = new CacheStats();
    s.recordMiss(100, 'cold');
    s.recordMiss(200, 'evicted');
    const snap = s.snapshot();
    expect(snap.missedTokens).toBe(300);
    expect(snap.expiredWastedTokens).toBe(0);
    expect(snap.expiredWastedCostUsd).toBe(0);
  });

  test('多次 expired 丢失账单累加', () => {
    const s = new CacheStats();
    s.recordMiss(100, 'expired');
    s.recordMiss(400, 'expired');
    const snap = s.snapshot();
    expect(snap.expiredWastedTokens).toBe(500);
    expect(snap.expiredWastedCostUsd).toBeCloseTo(500 * 0.00000027, 12);
  });

  test('自定义单价注入生效', () => {
    const s = new CacheStats({ pricePerTokenUsd: 0.000001 });
    s.recordMiss(1000, 'expired');
    expect(s.snapshot().expiredWastedCostUsd).toBeCloseTo(0.001, 12);
  });

  test('命中率 = hitTokens / (hitTokens + missedTokens)', () => {
    const s = new CacheStats();
    s.recordHit(4800);
    s.recordMiss(900);
    expect(s.snapshot().hitRate).toBeCloseTo(4800 / 5700, 12);
  });

  test('snapshot 是不可变拷贝：取出后再记账不影响旧快照', () => {
    const s = new CacheStats();
    s.recordHit(100);
    const snap = s.snapshot();
    s.recordHit(50);
    expect(snap.hitTokens).toBe(100);
    expect(s.snapshot().hitTokens).toBe(150);
  });
});

describe('BI-04.3 · CacheStats.render 确定性看板', () => {
  test('同状态恒同字节（两个实例独立记账后渲染逐字节相等）', () => {
    const build = (): string => {
      const s = new CacheStats();
      s.recordHit(4800);
      s.recordHit(300);
      s.recordMiss(200, 'cold');
      s.recordMiss(600, 'expired');
      return s.render();
    };
    expect(build()).toBe(build());
  });

  test('状态变化 → 渲染字节变化（看板非死字符串）', () => {
    const s = new CacheStats();
    const before = s.render();
    s.recordHit(10);
    expect(s.render()).not.toBe(before);
  });

  test('固定小数位：hitRate 百分比两位、成本八位', () => {
    const s = new CacheStats();
    s.recordHit(4800);
    s.recordMiss(900);
    s.recordMiss(600, 'expired');
    const board = s.render();
    expect(board).toContain('hitRate              : 76.19%');
    expect(board).toContain('expiredWastedCostUsd : $0.00016200');
  });

  test('看板字段齐全且无时间戳（确定性口径）', () => {
    const s = new CacheStats();
    s.recordHit(1);
    const board = s.render();
    expect(board.startsWith('CacheStats')).toBe(true);
    for (const field of ['hits', 'misses', 'hitTokens', 'missedTokens', 'hitRate', 'expiredWastedTokens', 'expiredWastedCostUsd']) {
      expect(board.includes(field)).toBe(true);
    }
    expect(board).not.toContain('T=');
    expect(board).not.toContain('Z\n');
  });
});
