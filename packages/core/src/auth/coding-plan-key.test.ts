import { describe, expect, test } from "bun:test";

import {
  CodingPlanKeyExchanger,
  DEFAULT_CODING_PLAN_EXCHANGE_ENDPOINT,
} from "./coding-plan-key";
import type { FetchLike } from "./http";
import { role, type Secret } from "./types";

const API_KEY = "api-key-PLAINTEXT-do-not-leak";
const PAT = "pat-PLAINTEXT-do-not-leak";

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** 尊重 AbortSignal 的挂起 fetch stub（超时/取消测试用，永不触网）。 */
function hangingFetch(): FetchLike {
  return ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("AbortError"));
        return;
      }
      signal?.addEventListener(
        "abort",
        () => reject(signal.reason ?? new Error("AbortError")),
        { once: true },
      );
    })) as FetchLike;
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
} {
  const requests: CapturedRequest[] = [];
  const doFetch = ((url: string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const rawHeaders = new Headers(init?.headers);
    rawHeaders.forEach((value, key) => {
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
  return { fetch: doFetch, requests };
}

describe("coding-plan-key · 二阶段换票成功", () => {
  test("API Key 换取 token_use=project_access 的短期 PAT", async () => {
    const { fetch, requests } = captureFetch(() =>
      jsonResponse({
        access_token: PAT,
        token_use: "project_access",
        expires_in: 600,
      }),
    );
    const exchanger = new CodingPlanKeyExchanger({ fetch });
    const outcome = await exchanger.exchange(role("secret", API_KEY));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.pat).toBe(role("secret", PAT));
    expect(outcome.obtainedAt).toBeGreaterThan(0);
    expect(outcome.expiresAt).toBeGreaterThan(outcome.obtainedAt);

    // 阶段一请求携带 Bearer API Key，POST JSON。
    expect(requests.length).toBe(1);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.headers["authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(requests[0]!.body!)).toEqual({});
  });

  test("缺省端点为注入前的官方常量（stub 验证布线，不触网）", async () => {
    const { fetch, requests } = captureFetch(() =>
      jsonResponse({ access_token: PAT, token_use: "project_access" }),
    );
    const exchanger = new CodingPlanKeyExchanger({ fetch });
    await exchanger.exchange(role("secret", API_KEY));
    expect(requests[0]!.url).toBe(DEFAULT_CODING_PLAN_EXCHANGE_ENDPOINT);
    expect(DEFAULT_CODING_PLAN_EXCHANGE_ENDPOINT.startsWith("https://")).toBe(true);
  });

  test("无 expires_in 时 expiresAt 缺省", async () => {
    const { fetch } = captureFetch(() =>
      jsonResponse({ access_token: PAT, token_use: "project_access" }),
    );
    const outcome = await new CodingPlanKeyExchanger({ fetch }).exchange(role("secret", API_KEY));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.expiresAt).toBeUndefined();
  });
});

describe("coding-plan-key · 四类失败结构化返回", () => {
  test("401 → unauthorized", async () => {
    const { fetch } = captureFetch(() => new Response("bad key", { status: 401 }));
    const outcome = await new CodingPlanKeyExchanger({ fetch }).exchange(role("secret", API_KEY));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("unauthorized");
    expect(outcome.failure.status).toBe(401);
  });

  test("429 → rate_limited（Retry-After 秒数换算毫秒）", async () => {
    const { fetch } = captureFetch(() =>
      jsonResponse({ error: "rate" }, 429, { "retry-after": "2" }),
    );
    const outcome = await new CodingPlanKeyExchanger({ fetch }).exchange(role("secret", API_KEY));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("rate_limited");
    expect(outcome.failure.status).toBe(429);
    expect(outcome.failure.retryAfterMs).toBe(2000);
  });

  test("429 无 Retry-After 头 → retryAfterMs 缺省", async () => {
    const { fetch } = captureFetch(() => jsonResponse({}, 429));
    const outcome = await new CodingPlanKeyExchanger({ fetch }).exchange(role("secret", API_KEY));
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.failure.kind).toBe("rate_limited");
    expect(outcome.failure.retryAfterMs).toBeUndefined();
  });

  test("fetch 抛错 → network", async () => {
    const doFetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as FetchLike;
    const outcome = await new CodingPlanKeyExchanger({ fetch: doFetch }).exchange(
      role("secret", API_KEY),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("network");
  });

  test("请求超时 → network", async () => {
    const outcome = await new CodingPlanKeyExchanger({
      fetch: hangingFetch(),
      timeoutMs: 30,
    }).exchange(role("secret", API_KEY));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("network");
    expect(outcome.failure.message).toContain("请求超时");
  });

  test("外部中止 → network（不抛异常）", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await new CodingPlanKeyExchanger({
      fetch: hangingFetch(),
      timeoutMs: 1000,
    }).exchange(role("secret", API_KEY), controller.signal);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("network");
  });

  test("500 → protocol（携带状态码）", async () => {
    const { fetch } = captureFetch(() => jsonResponse({}, 500));
    const outcome = await new CodingPlanKeyExchanger({ fetch }).exchange(role("secret", API_KEY));
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.failure.kind).toBe("protocol");
    expect(outcome.failure.status).toBe(500);
  });

  test("200 但 token_use 非法 → protocol", async () => {
    const { fetch } = captureFetch(() => jsonResponse({ access_token: PAT, token_use: "user" }));
    const outcome = await new CodingPlanKeyExchanger({ fetch }).exchange(role("secret", API_KEY));
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.failure.kind).toBe("protocol");
  });

  test("200 但缺 access_token → protocol", async () => {
    const { fetch } = captureFetch(() => jsonResponse({ token_use: "project_access" }));
    const outcome = await new CodingPlanKeyExchanger({ fetch }).exchange(role("secret", API_KEY));
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.failure.kind).toBe("protocol");
  });

  test("200 但响应非 JSON → protocol", async () => {
    const { fetch } = captureFetch(() => new Response("<html>oops</html>", { status: 200 }));
    const outcome = await new CodingPlanKeyExchanger({ fetch }).exchange(role("secret", API_KEY));
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.failure.kind).toBe("protocol");
    expect(outcome.failure.message).not.toContain("<html>"); // 响应原文不外泄
  });
});

describe("coding-plan-key · 零数据外泄", () => {
  test("日志不含 API Key 与 PAT 明文", async () => {
    const logLines: string[] = [];
    const { fetch } = captureFetch(() =>
      jsonResponse({ access_token: PAT, token_use: "project_access" }),
    );
    const outcome = await new CodingPlanKeyExchanger({
      fetch,
      log: (line) => logLines.push(line),
    }).exchange(role("secret", API_KEY));
    expect(outcome.ok).toBe(true);

    const all = logLines.join("\n");
    expect(logLines.length).toBeGreaterThan(0);
    expect(all).not.toContain(API_KEY);
    expect(all).not.toContain(PAT);
    expect(all).toContain("[REDACTED]"); // authorization 头已遮蔽
  });
});

describe("coding-plan-key · Secret 标记入参约束", () => {
  test("API Key 必须经 role('secret') 标记（类型层面强制，运行时透传）", async () => {
    const { fetch } = captureFetch(() =>
      jsonResponse({ access_token: PAT, token_use: "project_access" }),
    );
    const apiKey: Secret = role("secret", API_KEY);
    const outcome = await new CodingPlanKeyExchanger({ fetch }).exchange(apiKey);
    expect(outcome.ok).toBe(true);
  });
});
