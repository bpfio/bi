import { describe, expect, test } from "bun:test";

import type { IntervalTimerPort } from "./quota-watchdog";
import {
  DEFAULT_QUOTA_BASE_URL,
  DEFAULT_QUOTA_PATH,
  QuotaWatchdog,
  QuotaWatchdogError,
  type QuotaAlert,
  type QuotaMapper,
} from "./quota-watchdog";
import type { FetchLike } from "./http";

const OK_BODY = { used: 100, total: 1000, reset_at: 1_900_000_000_000 };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function captureFetch(respond: (req: CapturedRequest, call: number) => Response): {
  fetch: FetchLike;
  requests: CapturedRequest[];
  count: () => number;
} {
  const requests: CapturedRequest[] = [];
  const doFetch = ((url: string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const request: CapturedRequest = { url, method: init?.method ?? "GET", headers };
    requests.push(request);
    return Promise.resolve(respond(request, requests.length));
  }) as FetchLike;
  return { fetch: doFetch, requests, count: () => requests.length };
}

/** 宏任务冲刷：等待全部已排队的微任务（立即 resolve 的 fetch stub）完成。 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** 手动 timer：start 只注册不启动，fire 由测试驱动（确定性，无真实时钟）。 */
function manualTimer(): IntervalTimerPort & { fire(): void; isActive(): boolean; startedCount(): number } {
  let fn: (() => void) | undefined;
  let started = 0;
  return {
    start(f: () => void) {
      fn = f;
      started++;
      return "handle";
    },
    stop() {
      fn = undefined;
    },
    fire() {
      fn?.();
    },
    isActive() {
      return fn !== undefined;
    },
    startedCount() {
      return started;
    },
  };
}

type WatchdogOptions = ConstructorParameters<typeof QuotaWatchdog>[0];

function makeWatchdog(overrides: Partial<WatchdogOptions>): QuotaWatchdog {
  const { fetchImpl, ...rest } = overrides;
  return new QuotaWatchdog({
    fetchImpl: fetchImpl ?? captureFetch(() => jsonResponse(OK_BODY)).fetch,
    onAlert: () => {},
    ...rest,
  });
}

describe("QuotaWatchdog · 构造校验", () => {
  test("baseUrl 非法 URL → config 错误（不触网）", () => {
    expect(() => makeWatchdog({ baseUrl: "not-a-url" })).toThrowError(QuotaWatchdogError);
  });

  test("thresholds.ratio 越界 / intervalMs 非正 → config 错误", () => {
    expect(() => makeWatchdog({ thresholds: { ratio: 1.5 } })).toThrowError(QuotaWatchdogError);
    expect(() => makeWatchdog({ intervalMs: 0 })).toThrowError(QuotaWatchdogError);
    expect(() => makeWatchdog({ cooldownMs: -1 })).toThrowError(QuotaWatchdogError);
  });
});

describe("QuotaWatchdog · pollOnce 与快照归一", () => {
  test("命中注入 baseUrl+path，canonical 形状归一（snake_case 兼容）", async () => {
    const { fetch, requests } = captureFetch(() =>
      jsonResponse({ used: 100, total: 1000, reset_at: 123, rpm_remaining: 7, rate_limited: false }),
    );
    const wd = makeWatchdog({ fetchImpl: fetch, baseUrl: "https://stub.example", path: "quota/x" });
    const result = await wd.pollOnce();

    expect(requests.length).toBe(1);
    expect(requests[0]!.url).toBe("https://stub.example/quota/x"); // 缺前导 / 自动补齐
    expect(requests[0]!.method).toBe("GET");
    expect(result.snapshot).toEqual({
      used: 100,
      total: 1000,
      resetAt: 123,
      rpmRemaining: 7,
      rateLimited: false,
    });
    expect(result.alert).toBeUndefined();
  });

  test("缺省端点常量布线正确（stub 验证，不触网）", async () => {
    const { fetch, requests } = captureFetch(() => jsonResponse(OK_BODY));
    const wd = makeWatchdog({ fetchImpl: fetch });
    await wd.pollOnce();
    expect(requests[0]!.url).toBe(`${DEFAULT_QUOTA_BASE_URL}${DEFAULT_QUOTA_PATH}`);
  });

  test("自定义 mapper 适配非标 shape", async () => {
    const mapper: QuotaMapper = (raw) => {
      const obj = raw as { data: { usage: number; quota: number } };
      return { used: obj.data.usage, total: obj.data.quota, rateLimited: false };
    };
    const { fetch } = captureFetch(() => jsonResponse({ data: { usage: 990, quota: 1000 } }));
    const alerts: QuotaAlert[] = [];
    const wd = makeWatchdog({ fetchImpl: fetch, mapper, onAlert: (a) => alerts.push(a) });
    const result = await wd.pollOnce();
    expect(result.snapshot.used).toBe(990);
    expect(result.alert?.level).toBe("warn");
    expect(alerts.length).toBe(1);
  });

  test("余量比达标不告警；低于阈值 → warn/low_ratio；归零 → critical/exhausted", async () => {
    // 达标：90% 余量
    const ok = captureFetch(() => jsonResponse({ used: 100, total: 1000 }));
    const okResult = await makeWatchdog({ fetchImpl: ok.fetch }).pollOnce();
    expect(okResult.alert).toBeUndefined();

    // 低于阈值：5% 余量
    const low = captureFetch(() => jsonResponse({ used: 950, total: 1000 }));
    const lowResult = await makeWatchdog({ fetchImpl: low.fetch }).pollOnce();
    expect(lowResult.alert).toEqual({
      level: "warn",
      reason: "low_ratio",
      snapshot: lowResult.snapshot,
    });

    // 归零：0% 余量
    const empty = captureFetch(() => jsonResponse({ used: 1000, total: 1000 }));
    const emptyResult = await makeWatchdog({ fetchImpl: empty.fetch }).pollOnce();
    expect(emptyResult.alert?.level).toBe("critical");
    expect(emptyResult.alert?.reason).toBe("exhausted");
  });

  test("rate_limited 标记 → critical/rate_limited；rateLimited=false 时不触发", async () => {
    const limited = captureFetch(() =>
      jsonResponse({ used: 100, total: 1000, rate_limited: true }),
    );
    const result = await makeWatchdog({ fetchImpl: limited.fetch }).pollOnce();
    expect(result.alert?.level).toBe("critical");
    expect(result.alert?.reason).toBe("rate_limited");

    const disabled = captureFetch(() =>
      jsonResponse({ used: 100, total: 1000, rate_limited: true }),
    );
    const disabledResult = await makeWatchdog({
      fetchImpl: disabled.fetch,
      thresholds: { rateLimited: false },
    }).pollOnce();
    expect(disabledResult.alert).toBeUndefined(); // 余量充足且限流触发关闭
  });

  test("双条件同中（rate_limited + 低余量）→ rate_limited 优先只发一条", async () => {
    const alerts: QuotaAlert[] = [];
    const { fetch } = captureFetch(() =>
      jsonResponse({ used: 990, total: 1000, rate_limited: true }),
    );
    const result = await makeWatchdog({ fetchImpl: fetch, onAlert: (a) => alerts.push(a) }).pollOnce();
    expect(alerts.length).toBe(1);
    expect(result.alert?.reason).toBe("rate_limited");
    expect(result.alert?.level).toBe("critical");
  });
});

describe("QuotaWatchdog · 预警去抖", () => {
  test("同级冷却期内不重复告警；冷却期过后再次触发（注入时钟）", async () => {
    let fakeNow = 1_000;
    const alerts: QuotaAlert[] = [];
    const { fetch } = captureFetch(() => jsonResponse({ used: 950, total: 1000 }));
    const wd = makeWatchdog({
      fetchImpl: fetch,
      onAlert: (a) => alerts.push(a),
      cooldownMs: 1_000,
      now: () => fakeNow,
    });

    await wd.pollOnce(); // t=1000 触发 warn
    expect(alerts.length).toBe(1);

    fakeNow = 1_400;
    await wd.pollOnce(); // 距上次 400 < 1000 → 去抖
    expect(alerts.length).toBe(1);

    fakeNow = 2_100;
    const result = await wd.pollOnce(); // 距上次 1100 >= 1000 → 再次触发
    expect(alerts.length).toBe(2);
    expect(result.alert?.level).toBe("warn");
  });

  test("warn→critical 跨级不受冷却拦截", async () => {
    let fakeNow = 1_000;
    const alerts: QuotaAlert[] = [];
    let body: unknown = { used: 950, total: 1000 };
    const { fetch } = captureFetch(() => jsonResponse(body));
    const wd = makeWatchdog({
      fetchImpl: fetch,
      onAlert: (a) => alerts.push(a),
      cooldownMs: 1_000_000, // 冷却极大，跨级仍须放行
      now: () => fakeNow,
    });

    await wd.pollOnce(); // warn
    expect(alerts.map((a) => a.level)).toEqual(["warn"]);

    fakeNow = 1_100; // 冷却期内
    body = { used: 1000, total: 1000 };
    await wd.pollOnce(); // critical/exhausted 跨级 → 放行
    expect(alerts.map((a) => a.level)).toEqual(["warn", "critical"]);
    expect(alerts[1]!.reason).toBe("exhausted");
  });
});

describe("QuotaWatchdog · mapper 容错与结构化错误（不炸轮询）", () => {
  test("畸形响应（缺 total / 非对象）→ protocol，latest 保留旧值", async () => {
    let body: unknown = { used: 100, total: 1000 };
    const { fetch } = captureFetch(() => jsonResponse(body));
    const wd = makeWatchdog({ fetchImpl: fetch });
    await wd.pollOnce();
    const good = wd.latest();
    expect(good?.total).toBe(1000);

    body = { used: 100 }; // 缺 total
    const failure = await wd.pollOnce().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(QuotaWatchdogError);
    expect((failure as QuotaWatchdogError).code).toBe("protocol");
    expect(wd.latest()).toBe(good); // 失败不覆盖缓存

    body = [1, 2, 3]; // 非对象
    const failure2 = await wd.pollOnce().catch((e: unknown) => e);
    expect((failure2 as QuotaWatchdogError).code).toBe("protocol");
  });

  test("total=0 / rate_limited 非布尔 / mapper 抛错 / mapper 输出非法 → protocol", async () => {
    const zeroTotal = await makeWatchdog({
      fetchImpl: captureFetch(() => jsonResponse({ used: 0, total: 0 })).fetch,
    })
      .pollOnce()
      .catch((e: unknown) => e);
    expect((zeroTotal as QuotaWatchdogError).code).toBe("protocol");

    const badFlag = await makeWatchdog({
      fetchImpl: captureFetch(() => jsonResponse({ used: 0, total: 10, rate_limited: "yes" })).fetch,
    })
      .pollOnce()
      .catch((e: unknown) => e);
    expect((badFlag as QuotaWatchdogError).code).toBe("protocol");

    const throwingMapper: QuotaMapper = () => {
      throw new Error("boom");
    };
    const mapperThrow = await makeWatchdog({
      fetchImpl: captureFetch(() => jsonResponse(OK_BODY)).fetch,
      mapper: throwingMapper,
    })
      .pollOnce()
      .catch((e: unknown) => e);
    expect((mapperThrow as QuotaWatchdogError).code).toBe("protocol");
    expect((mapperThrow as QuotaWatchdogError).message).not.toContain("OK_BODY");

    const badMapperOut: QuotaMapper = () => ({ used: -5, total: 10, rateLimited: false });
    const mapperBad = await makeWatchdog({
      fetchImpl: captureFetch(() => jsonResponse(OK_BODY)).fetch,
      mapper: badMapperOut,
    })
      .pollOnce()
      .catch((e: unknown) => e);
    expect((mapperBad as QuotaWatchdogError).code).toBe("protocol");
  });

  test("HTTP 500 → http 错误带 status（retries=0，恰好一次 fetch）", async () => {
    const { fetch, count } = captureFetch(() => jsonResponse({}, 500));
    const wd = makeWatchdog({ fetchImpl: fetch, retries: 0 });
    const failure = await wd.pollOnce().catch((e: unknown) => e);
    expect((failure as QuotaWatchdogError).code).toBe("http");
    expect((failure as QuotaWatchdogError).status).toBe(500);
    expect(count()).toBe(1);
  });

  test("fetch 拒绝 → network 错误（retries=0）", async () => {
    const doFetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as FetchLike;
    const wd = makeWatchdog({ fetchImpl: doFetch, retries: 0 });
    const failure = await wd.pollOnce().catch((e: unknown) => e);
    expect((failure as QuotaWatchdogError).code).toBe("network");
  });
});

describe("QuotaWatchdog · latest 快照缓存", () => {
  test("未轮询 → undefined；轮询后 → 最新快照", async () => {
    let body: unknown = { used: 100, total: 1000 };
    const { fetch } = captureFetch(() => jsonResponse(body));
    const wd = makeWatchdog({ fetchImpl: fetch });
    expect(wd.latest()).toBeUndefined();

    await wd.pollOnce();
    expect(wd.latest()?.used).toBe(100);

    body = { used: 500, total: 1000 };
    await wd.pollOnce();
    expect(wd.latest()?.used).toBe(500);
  });
});

describe("QuotaWatchdog · start/stop 间隔轮询（注入 timer）", () => {
  test("start 立即首轮 + fire 驱动周期；stop 后 fire 不再轮询", async () => {
    const timer = manualTimer();
    const { fetch, count } = captureFetch(() => jsonResponse(OK_BODY));
    const wd = makeWatchdog({ fetchImpl: fetch, timer, intervalMs: 60_000 });

    await wd.start();
    expect(count()).toBe(1); // 首轮立即
    expect(timer.isActive()).toBe(true);

    timer.fire();
    await flush();
    expect(count()).toBe(2);

    timer.fire();
    await flush();
    expect(count()).toBe(3);

    wd.stop();
    expect(timer.isActive()).toBe(false);
    timer.fire();
    await flush();
    expect(count()).toBe(3); // stop 后不再轮询
  });

  test("重复 start 幂等：timer 只注册一次", async () => {
    const timer = manualTimer();
    const { fetch, count } = captureFetch(() => jsonResponse(OK_BODY));
    const wd = makeWatchdog({ fetchImpl: fetch, timer, intervalMs: 60_000 });

    await wd.start();
    await wd.start();
    await wd.start();
    expect(timer.startedCount()).toBe(1);
    expect(count()).toBe(1); // 首轮也只跑一次

    timer.fire();
    await flush();
    expect(count()).toBe(2); // 周期 tick 也只一份
    wd.stop();
  });

  test("轮询在途时跳过重叠 tick（防并发轮询）", async () => {
    const timer = manualTimer();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const slowFetch: FetchLike = () => {
      calls++;
      return gate.then(() => jsonResponse(OK_BODY));
    };
    const wd = makeWatchdog({ fetchImpl: slowFetch, timer, intervalMs: 60_000 });

    const starting = wd.start(); // 首轮在途（挂起）
    await flush();
    timer.fire(); // 上一轮未完成 → 本 tick 跳过
    await flush();
    expect(calls).toBe(1);

    release();
    await starting; // start 在首轮完成后返回
    timer.fire();
    await flush();
    expect(calls).toBe(2);
    wd.stop();
  });

  test("首轮失败不抛错，周期继续（start 正常返回）", async () => {
    const timer = manualTimer();
    const { fetch, count } = captureFetch(() => jsonResponse({ used: 1 }, 500));
    const logs: string[] = [];
    const wd = makeWatchdog({
      fetchImpl: fetch,
      timer,
      intervalMs: 60_000,
      retries: 0,
      log: (l) => logs.push(l),
    });

    await expect(wd.start()).resolves.toBeUndefined(); // 首轮失败被吞
    expect(count()).toBe(1);
    expect(timer.isActive()).toBe(true);

    timer.fire();
    await flush();
    expect(count()).toBe(2); // 循环继续
    expect(logs.join("\n")).toContain("poll-failed:http");
    wd.stop();
  });
});

describe("QuotaWatchdog · 零网络与脱敏", () => {
  test("全程 fetch stub：计数精确，构造本身零请求", async () => {
    const { fetch, requests, count } = captureFetch(() => jsonResponse(OK_BODY));
    const wd = makeWatchdog({ fetchImpl: fetch, baseUrl: "https://stub.example" });
    expect(count()).toBe(0); // 构造不触网
    await wd.pollOnce();
    await wd.pollOnce();
    expect(count()).toBe(2);
    expect(requests.every((r) => r.url.startsWith("https://stub.example"))).toBe(true);
  });

  test("日志不含 key 明文，敏感标头已遮蔽", async () => {
    const KEY = "sk-PLAINTEXT-do-not-leak-123456";
    const logs: string[] = [];
    const { fetch } = captureFetch(() => jsonResponse(OK_BODY));
    const wd = makeWatchdog({
      fetchImpl: fetch,
      headers: { "x-coding-plan-api-key": KEY },
      log: (l) => logs.push(l),
    });
    await wd.pollOnce();
    const all = logs.join("\n");
    expect(logs.length).toBeGreaterThan(0);
    expect(all).not.toContain(KEY);
    expect(all).toContain("[REDACTED]");
  });
});
