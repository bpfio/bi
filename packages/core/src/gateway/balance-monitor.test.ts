import { describe, expect, test } from "bun:test";

import type { FetchLike } from "../auth/http";
import {
  BalanceMonitor,
  BalanceMonitorError,
  DEFAULT_BALANCE_PATH,
  pickGrant,
  type BalanceGrant,
} from "./balance-monitor";

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

function captureFetch(respond: (req: CapturedRequest) => Response): {
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
    return Promise.resolve(respond(request));
  }) as FetchLike;
  return { fetch: doFetch, requests, count: () => requests.length };
}

function makeMonitor(overrides: ConstructorParameters<typeof BalanceMonitor>[0] = {}): BalanceMonitor {
  return new BalanceMonitor({
    fetchImpl: captureFetch(() => jsonResponse({ balance: 0 })).fetch,
    ...overrides,
  });
}

describe("BalanceMonitor · query 归一化", () => {
  test("命中注入 baseUrl+path，expires_at 映射为 expiresAt", async () => {
    const { fetch, requests } = captureFetch(() =>
      jsonResponse({
        balance: 4200,
        grants: [
          { units: 1200, expires_at: 1_800_000_000_000 },
          { units: 3000, expiresAt: 1_900_000_000_000 },
          { units: 100 },
        ],
      }),
    );
    const monitor = makeMonitor({ fetchImpl: fetch, baseUrl: "https://stub.example", path: "billing/balance" });
    const snapshot = await monitor.query();

    expect(requests.length).toBe(1);
    expect(requests[0]!.url).toBe("https://stub.example/billing/balance"); // 缺前导 / 自动补齐
    expect(requests[0]!.method).toBe("GET");
    expect(snapshot).toEqual({
      balance: 4200,
      grants: [
        { units: 1200, expiresAt: 1_800_000_000_000 },
        { units: 3000, expiresAt: 1_900_000_000_000 },
        { units: 100 },
      ],
    });
  });

  test("缺省端点常量布线正确；grants 缺省为空表", async () => {
    const { fetch, requests } = captureFetch(() => jsonResponse({ balance: 7 }));
    const monitor = makeMonitor({ fetchImpl: fetch });
    const snapshot = await monitor.query();
    expect(requests[0]!.url).toBe(`https://open.bigmodel.cn${DEFAULT_BALANCE_PATH}`);
    expect(snapshot).toEqual({ balance: 7, grants: [] });
  });

  test("畸形响应：balance 缺失 / 非对象 → protocol", async () => {
    const missing = await makeMonitor({
      fetchImpl: captureFetch(() => jsonResponse({ grants: [] })).fetch,
    })
      .query()
      .catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(BalanceMonitorError);
    expect((missing as BalanceMonitorError).code).toBe("protocol");

    const notObject = await makeMonitor({
      fetchImpl: captureFetch(() => jsonResponse([1, 2])).fetch,
    })
      .query()
      .catch((e: unknown) => e);
    expect((notObject as BalanceMonitorError).code).toBe("protocol");
  });

  test("畸形响应：grants 非数组 / 元素非对象 / 缺 units → protocol", async () => {
    const cases: unknown[] = [
      { balance: 1, grants: "nope" },
      { balance: 1, grants: [42] },
      { balance: 1, grants: [{ expires_at: 123 }] },
    ];
    for (const body of cases) {
      const error = await makeMonitor({
        fetchImpl: captureFetch(() => jsonResponse(body)).fetch,
      })
        .query()
        .catch((e: unknown) => e);
      expect((error as BalanceMonitorError).code).toBe("protocol");
    }
  });

  test("HTTP 404 → http 错误带 status；fetch 拒绝 → network（retries=0）", async () => {
    const notFound = await makeMonitor({
      fetchImpl: captureFetch(() => jsonResponse({}, 404)).fetch,
      retries: 0,
    })
      .query()
      .catch((e: unknown) => e);
    expect((notFound as BalanceMonitorError).code).toBe("http");
    expect((notFound as BalanceMonitorError).status).toBe(404);

    const doFetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as FetchLike;
    const network = await makeMonitor({ fetchImpl: doFetch, retries: 0 })
      .query()
      .catch((e: unknown) => e);
    expect((network as BalanceMonitorError).code).toBe("network");
  });

  test("baseUrl 非法 → config 错误", () => {
    expect(() => makeMonitor({ baseUrl: "::bad::" })).toThrowError(BalanceMonitorError);
  });
});

describe("pickGrant · 优先抵扣即将过期额度", () => {
  const grants: BalanceGrant[] = [
    { units: 100, expiresAt: 3_000 }, // 远过期
    { units: 200, expiresAt: 2_000 }, // 最近过期 → 优先
    { units: 300 },                   // 长期 → 最后
    { units: 400, expiresAt: 1_000 }, // 已过期 → 跳过
  ];

  test("expiresAt 最近的未过期授予优先", () => {
    expect(pickGrant(grants, 1_500)).toEqual({ units: 200, expiresAt: 2_000 });
  });

  test("无过期时间的长期授予排在所有未过期授予之后", () => {
    const onlyLongTerm: BalanceGrant[] = [{ units: 300 }, { units: 500 }];
    expect(pickGrant(onlyLongTerm, 1_500)).toEqual({ units: 300 }); // 稳定：先出现者优先
  });

  test("已过期（expiresAt <= now）全部跳过 → undefined；空表 → undefined", () => {
    expect(pickGrant(grants, 3_500)).toEqual({ units: 300 }); // 三笔过期，只剩长期
    const allExpired: BalanceGrant[] = [{ units: 1, expiresAt: 900 }];
    expect(pickGrant(allExpired, 900)).toBeUndefined(); // 边界：expiresAt == now 视为过期
    expect(pickGrant([], 1_000)).toBeUndefined();
  });

  test("同 expiresAt 保持输入顺序（稳定选择）", () => {
    const tied: BalanceGrant[] = [
      { units: 11, expiresAt: 2_000 },
      { units: 22, expiresAt: 2_000 },
    ];
    expect(pickGrant(tied, 1_000)).toEqual({ units: 11, expiresAt: 2_000 });
  });
});

describe("BalanceMonitor · 零网络与脱敏", () => {
  test("构造不触网；query 一次恰好一次 stub fetch", async () => {
    const { fetch, count } = captureFetch(() => jsonResponse({ balance: 1 }));
    const monitor = makeMonitor({ fetchImpl: fetch });
    expect(count()).toBe(0);
    await monitor.query();
    await monitor.query();
    expect(count()).toBe(2);
  });

  test("日志不含授权头明文，敏感标头已遮蔽", async () => {
    const KEY = "sk-PLAINTEXT-balance-key-abcdef";
    const logs: string[] = [];
    const { fetch } = captureFetch(() => jsonResponse({ balance: 1 }));
    const monitor = makeMonitor({
      fetchImpl: fetch,
      headers: { authorization: `Bearer ${KEY}` },
      log: (l) => logs.push(l),
    });
    await monitor.query();
    const all = logs.join("\n");
    expect(logs.length).toBeGreaterThan(0);
    expect(all).not.toContain(KEY);
    expect(all).toContain("[REDACTED]");
  });
});
