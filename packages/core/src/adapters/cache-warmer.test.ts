/**
 * BI-04.3 — cache-warmer 测试。
 *
 * 覆盖：TTL 消逝状态机（skip-fresh / skip-economics / pulse / pulse-failed）、
 * 经济学闸门（expectedSavings = tokens × 单价 × 0.8，低于 $0.05 不唤醒）、
 * 注入式 fetch / 时钟、1-token 脉冲请求形状、失败不抛出只记账。
 * 全部纯内存 fixture（fetch 为内存 spy），零网络。
 */

import { describe, expect, test } from 'bun:test';

import {
  CacheWarmer,
  DEFAULT_THRESHOLD_RATIO,
  DEFAULT_TTL_MS,
  KEEPALIVE_RECOVERY_RATIO,
  MIN_SAVINGS_USD,
  type FetchLike,
} from './cache-warmer';

const TTL = 300_000;

/** 内存 fetch spy：记录调用，按脚本返回。 */
function spyFetch(responses: Array<{ status: number } | Error>): { impl: FetchLike; calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  let i = 0;
  const impl: FetchLike = async (url, init) => {
    const script = responses[Math.min(i, responses.length - 1)];
    i += 1;
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
    if (script instanceof Error) throw script;
    return new Response('{"ok":true}', { status: script.status });
  };
  return { impl, calls };
}

function warmerAt(nowMs: number): {
  warmer: CacheWarmer;
  calls: Array<{ url: string; body: string }>;
} {
  const { impl, calls } = spyFetch([{ status: 200 }]);
  const warmer = new CacheWarmer({ fetchImpl: impl, clock: () => nowMs });
  return { warmer, calls };
}

// ---------------------------------------------------------------------------
// TTL 消逝状态机
// ---------------------------------------------------------------------------

describe('BI-04.3 · CacheWarmer TTL 消逝', () => {
  test('缓存还热（消逝比例 < 阈值）→ skip-fresh，不发请求', async () => {
    const { warmer, calls } = warmerAt(TTL * 0.5);
    const r = await warmer.tick(0, 500_000);
    expect(r.decision).toBe('skip-fresh');
    expect(r.elapsedRatio).toBe(0.5);
    expect(calls.length).toBe(0);
  });

  test('缺省 TTL=300_000ms、阈值=0.9（常量口径锁定）', () => {
    expect(DEFAULT_TTL_MS).toBe(300_000);
    expect(DEFAULT_THRESHOLD_RATIO).toBe(0.9);
    expect(MIN_SAVINGS_USD).toBe(0.05);
    expect(KEEPALIVE_RECOVERY_RATIO).toBe(0.8);
  });

  test('阈值边界：消逝比例恰好 = 0.9 → 进入经济学闸门（不 skip-fresh）', async () => {
    const { impl } = spyFetch([{ status: 200 }]);
    const warmer = new CacheWarmer({ fetchImpl: impl, clock: () => 270_000 });
    const r = await warmer.tick(0, 1_000_000);
    expect(r.decision).not.toBe('skip-fresh');
    expect(r.elapsedRatio).toBe(0.9);
  });

  test('注入时钟决定 elapsedMs / elapsedRatio（确定性时间）', async () => {
    const { impl } = spyFetch([{ status: 200 }]);
    const warmer = new CacheWarmer({ fetchImpl: impl, clock: () => 1234, ttlMs: 1000, thresholdRatio: 0.5 });
    const r = await warmer.tick(0, 1_000_000);
    expect(r.elapsedMs).toBe(1234);
    expect(r.elapsedRatio).toBe(1.234);
    expect(r.decision).toBe('pulse');
  });

  test('自定义 thresholdRatio：0.5 阈值下消逝 0.6 即触发', async () => {
    const { impl } = spyFetch([{ status: 200 }]);
    const warmer = new CacheWarmer({ fetchImpl: impl, clock: () => 600, ttlMs: 1000, thresholdRatio: 0.5 });
    const r = await warmer.tick(0, 1_000_000);
    expect(r.decision).toBe('pulse');
  });
});

// ---------------------------------------------------------------------------
// 经济学闸门
// ---------------------------------------------------------------------------

describe('BI-04.3 · CacheWarmer 经济学闸门', () => {
  test('expectedSavingsUsd = tokens × 单价 × 0.8（缺省单价 $0.27/M）', () => {
    const { impl } = spyFetch([{ status: 200 }]);
    const warmer = new CacheWarmer({ fetchImpl: impl });
    expect(warmer.expectedSavingsUsd(1_000_000)).toBeCloseTo(1_000_000 * 0.00000027 * 0.8, 12);
  });

  test('小前缀不值得唤醒：期望节省 < $0.05 → skip-economics，不发请求', async () => {
    // 200_000 × 0.00000027 × 0.8 = $0.0432 < $0.05
    const { warmer, calls } = warmerAt(TTL);
    const r = await warmer.tick(0, 200_000);
    expect(r.decision).toBe('skip-economics');
    expect(r.expectedSavingsUsd).toBeCloseTo(0.0432, 10);
    expect(calls.length).toBe(0);
  });

  test('大前缀值得唤醒：期望节省 ≥ $0.05 → 走到 pulse', async () => {
    // 250_000 × 0.00000027 × 0.8 = $0.054 ≥ $0.05
    const { warmer, calls } = warmerAt(TTL);
    const r = await warmer.tick(0, 250_000);
    expect(r.decision).toBe('pulse');
    expect(calls.length).toBe(1);
  });

  test('skip-fresh 时也回报 expectedSavingsUsd（口径可观测）', async () => {
    const { warmer } = warmerAt(TTL * 0.1);
    const r = await warmer.tick(0, 300_000);
    expect(r.decision).toBe('skip-fresh');
    expect(r.expectedSavingsUsd).toBeCloseTo(300_000 * 0.00000027 * 0.8, 12);
  });
});

// ---------------------------------------------------------------------------
// 1-token 脉冲与失败语义
// ---------------------------------------------------------------------------

describe('BI-04.3 · CacheWarmer 脉冲', () => {
  test('脉冲请求形状：max_tokens=1、缺省 URL/model、content-type JSON', async () => {
    const { impl, calls } = spyFetch([{ status: 200 }]);
    const warmer = new CacheWarmer({ fetchImpl: impl, clock: () => TTL });
    const r = await warmer.tick(0, 1_000_000);
    expect(r.decision).toBe('pulse');
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://api.deepseek.com/chat/completions');
    const body = JSON.parse(calls[0].body) as { model: string; max_tokens: number; messages: Array<{ role: string }> };
    expect(body.max_tokens).toBe(1);
    expect(body.model).toBe('deepseek-chat');
    expect(body.messages.length).toBe(1);
  });

  test('自定义 URL / model 注入生效', async () => {
    const { impl, calls } = spyFetch([{ status: 200 }]);
    const warmer = new CacheWarmer({ fetchImpl: impl, clock: () => TTL, url: 'http://x/y', model: 'm1' });
    await warmer.tick(0, 1_000_000);
    expect(calls[0].url).toBe('http://x/y');
    expect((JSON.parse(calls[0].body) as { model: string }).model).toBe('m1');
  });

  test('非 2xx → pulse-failed（不抛出），error 记 HTTP 状态', async () => {
    const { impl } = spyFetch([{ status: 500 }]);
    const warmer = new CacheWarmer({ fetchImpl: impl, clock: () => TTL });
    const r = await warmer.tick(0, 1_000_000);
    expect(r.decision).toBe('pulse-failed');
    expect(r.error).toBe('HTTP 500');
  });

  test('fetch 抛错 → pulse-failed（不抛出），error 记 message', async () => {
    const { impl } = spyFetch([new Error('boom')]);
    const warmer = new CacheWarmer({ fetchImpl: impl, clock: () => TTL });
    const r = await warmer.tick(0, 1_000_000);
    expect(r.decision).toBe('pulse-failed');
    expect(r.error).toBe('boom');
  });
});
