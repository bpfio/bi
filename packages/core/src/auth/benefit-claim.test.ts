import { describe, expect, test } from "bun:test";

import type { FetchLike } from "./http";
import { BalanceMonitor, BalanceMonitorError, DEFAULT_BALANCE_PATH } from "../gateway/balance-monitor";
import {
  BenefitClaimService,
  BenefitClaimError,
  DEFAULT_BENEFIT_BASE_URL,
  DEFAULT_BENEFIT_CLAIM_PATH,
  DEFAULT_BENEFIT_PREVIEW_PATH,
} from "./benefit-claim";

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
  body: string | undefined;
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
    const request: CapturedRequest = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    requests.push(request);
    return Promise.resolve(respond(request));
  }) as FetchLike;
  return { fetch: doFetch, requests, count: () => requests.length };
}

const GRANT_BODY = {
  grants: [
    { grantId: "g-1", units: 500, expires_at: 1_800_000_000_000 },
    { grant_id: "g-2", units: 1200 },
  ],
};

describe("BenefitClaimService · previewGrants", () => {
  test("GET 注入 previewPath（缺省布线正确），snake_case/camelCase 兼容", async () => {
    const { fetch, requests } = captureFetch(() => jsonResponse(GRANT_BODY));
    const svc = new BenefitClaimService({ fetchImpl: fetch, baseUrl: "https://stub.example" });
    const grants = await svc.previewGrants();

    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.url).toBe("https://stub.example/api/billing/preview");
    expect(grants).toEqual([
      { grantId: "g-1", units: 500, expiresAt: 1_800_000_000_000 },
      { grantId: "g-2", units: 1200 },
    ]);

    const { fetch: fetch2, requests: requests2 } = captureFetch(() => jsonResponse(GRANT_BODY));
    await new BenefitClaimService({ fetchImpl: fetch2 }).previewGrants();
    expect(requests2[0]!.url).toBe(`${DEFAULT_BENEFIT_BASE_URL}${DEFAULT_BENEFIT_PREVIEW_PATH}`);
  });

  test("裸数组响应也可解析", async () => {
    const { fetch } = captureFetch(() =>
      jsonResponse([{ grantId: "g-9", units: 10 }]),
    );
    const grants = await new BenefitClaimService({ fetchImpl: fetch }).previewGrants();
    expect(grants).toEqual([{ grantId: "g-9", units: 10 }]);
  });

  test("畸形响应：非数组 / 元素缺 grantId / 缺 units → protocol 错误", async () => {
    const cases: unknown[] = [
      { grants: "nope" },
      { grants: [{ units: 1 }] },
      { grants: [{ grantId: "g" }] },
      "not-array",
    ];
    for (const body of cases) {
      const error = await new BenefitClaimService({
        fetchImpl: captureFetch(() => jsonResponse(body)).fetch,
      })
        .previewGrants()
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BenefitClaimError);
      expect((error as BenefitClaimError).code).toBe("protocol");
    }
  });

  test("网络失败 → network；baseUrl 非法 → config", async () => {
    const doFetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as FetchLike;
    const error = await new BenefitClaimService({ fetchImpl: doFetch })
      .previewGrants()
      .catch((e: unknown) => e);
    expect((error as BenefitClaimError).code).toBe("network");

    expect(() => new BenefitClaimService({ baseUrl: "::bad::" })).toThrowError(BenefitClaimError);
  });
});

describe("BenefitClaimService · claim 原子申领", () => {
  test("成功：POST claimPath + body={grantId}，返回 { claimed, grantUnits, claimedAt }", async () => {
    const { fetch, requests } = captureFetch(() =>
      jsonResponse({ claimed: true, grantUnits: 500 }),
    );
    const svc = new BenefitClaimService({ fetchImpl: fetch, baseUrl: "https://stub.example" });
    const outcome = await svc.claim("g-1");

    expect(outcome).toMatchObject({ ok: true, claimed: true, grantUnits: 500 });
    if (outcome.ok) expect(outcome.claimedAt).toBeGreaterThan(0);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url).toBe("https://stub.example/api/billing/claim");
    expect(JSON.parse(requests[0]!.body!)).toEqual({ grantId: "g-1" });
  });

  test("重复申领：响应 claimed:false → 结构化 already_claimed（不抛异常）", async () => {
    const { fetch } = captureFetch(() => jsonResponse({ claimed: false }));
    const outcome = await new BenefitClaimService({ fetchImpl: fetch }).claim("g-1");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.kind).toBe("already_claimed");
  });

  test("HTTP 409 → already_claimed；404 → not_found；401 → unauthorized", async () => {
    const conflict = await new BenefitClaimService({
      fetchImpl: captureFetch(() => jsonResponse({}, 409)).fetch,
    })
      .claim("g-1")
      .then((o) => o);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.failure.kind).toBe("already_claimed");

    const notFound = await new BenefitClaimService({
      fetchImpl: captureFetch(() => jsonResponse({}, 404)).fetch,
    })
      .claim("g-x")
      .then((o) => o);
    expect(notFound.ok).toBe(false);
    if (!notFound.ok) expect(notFound.failure.kind).toBe("not_found");

    const unauthorized = await new BenefitClaimService({
      fetchImpl: captureFetch(() => jsonResponse({}, 401)).fetch,
    })
      .claim("g-1")
      .then((o) => o);
    expect(unauthorized.ok).toBe(false);
    if (!unauthorized.ok) expect(unauthorized.failure.kind).toBe("unauthorized");
  });

  test("响应缺 claimed / 缺 grantUnits / 网络失败 → 结构化失败", async () => {
    const missingClaimed = await new BenefitClaimService({
      fetchImpl: captureFetch(() => jsonResponse({ grantUnits: 1 })).fetch,
    })
      .claim("g")
      .then((o) => o);
    expect(missingClaimed.ok).toBe(false);
    if (!missingClaimed.ok) expect(missingClaimed.failure.kind).toBe("protocol");

    const missingUnits = await new BenefitClaimService({
      fetchImpl: captureFetch(() => jsonResponse({ claimed: true })).fetch,
    })
      .claim("g")
      .then((o) => o);
    expect(missingUnits.ok).toBe(false);
    if (!missingUnits.ok) expect(missingUnits.failure.kind).toBe("protocol");

    const doFetch = (() => Promise.reject(new Error("ECONNRESET"))) as FetchLike;
    const network = await new BenefitClaimService({ fetchImpl: doFetch })
      .claim("g")
      .then((o) => o);
    expect(network.ok).toBe(false);
    if (!network.ok) expect(network.failure.kind).toBe("network");
  });
});

describe("BenefitClaimService · balance 复用 BalanceMonitor（import，不修改）", () => {
  test("缺省复用：余额请求打到 billing/balance，返回快照", async () => {
    const { fetch, requests } = captureFetch((req) => {
      if (req.url.endsWith(DEFAULT_BALANCE_PATH)) {
        return jsonResponse({ balance: 1700, grants: [{ units: 500, expires_at: 1 }] });
      }
      return jsonResponse(GRANT_BODY);
    });
    const svc = new BenefitClaimService({ fetchImpl: fetch });
    const snapshot = await svc.balance();

    expect(requests.at(-1)!.url).toBe(`${DEFAULT_BENEFIT_BASE_URL}${DEFAULT_BALANCE_PATH}`);
    expect(snapshot).toEqual({ balance: 1700, grants: [{ units: 500, expiresAt: 1 }] });
  });

  test("注入既有 BalanceMonitor 实例（不改既有产物，仅接线）", async () => {
    const { fetch } = captureFetch(() => jsonResponse({ balance: 42 }));
    const monitor = new BalanceMonitor({ fetchImpl: fetch });
    const svc = new BenefitClaimService({ fetchImpl: fetch, balanceMonitor: monitor });
    const snapshot = await svc.balance();
    expect(snapshot.balance).toBe(42);
  });

  test("余额查询失败按 BalanceMonitorError 分类透传", async () => {
    const doFetch = (() => Promise.reject(new Error("EHOSTUNREACH"))) as FetchLike;
    const svc = new BenefitClaimService({
      fetchImpl: doFetch,
      balanceMonitor: new BalanceMonitor({ fetchImpl: doFetch, retries: 0 }),
    });
    const error = await svc.balance().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BalanceMonitorError);
    expect((error as BalanceMonitorError).code).toBe("network");
  });
});

describe("BenefitClaimService · 零网络与脱敏", () => {
  test("构造不触网；全程 stub 计数精确", async () => {
    const { fetch, count } = captureFetch((req) => {
      if (req.url.endsWith(DEFAULT_BENEFIT_CLAIM_PATH)) {
        return jsonResponse({ claimed: true, grantUnits: 1 });
      }
      if (req.url.endsWith(DEFAULT_BALANCE_PATH)) {
        return jsonResponse({ balance: 1 });
      }
      return jsonResponse(GRANT_BODY);
    });
    const svc = new BenefitClaimService({ fetchImpl: fetch });
    expect(count()).toBe(0);
    await svc.previewGrants();
    await svc.claim("g-1");
    await svc.balance();
    expect(count()).toBe(3);
  });

  test("日志不含授权头明文", async () => {
    const KEY = "sk-PLAINTEXT-benefit-key-777";
    const logs: string[] = [];
    const { fetch } = captureFetch(() => jsonResponse(GRANT_BODY));
    const svc = new BenefitClaimService({
      fetchImpl: fetch,
      headers: { "x-api-key": KEY },
      log: (l) => logs.push(l),
    });
    await svc.previewGrants();
    const all = logs.join("\n");
    expect(logs.length).toBeGreaterThan(0);
    expect(all).not.toContain(KEY);
    expect(all).toContain("[REDACTED]");
  });
});
