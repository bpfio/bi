import { describe, expect, test } from "bun:test";

import type { FetchLike } from "../auth/http";
import {
  DEFAULT_OFF_PEAK_BASE_URL,
  DEFAULT_OFF_PEAK_STATUS_PATH,
  DEFAULT_OFF_PEAK_SUBMIT_PATH,
  OFF_PEAK_TIMEOUT_CODE,
  OffPeakClient,
  OffPeakClientError,
  type OffPeakClientOptions,
} from "./off-peak-client";

const PAYLOAD = { job: "nightly-report", rows: 42 };

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

function makeClient(
  fetch: FetchLike,
  overrides: Partial<Omit<OffPeakClientOptions, "fetchImpl">> = {},
): OffPeakClient {
  return new OffPeakClient({ fetchImpl: fetch, ...overrides });
}

describe("OffPeakClient · submit 取号", () => {
  test("POST 注入 submitPath，payload 原样作为 body，返回 ticketId", async () => {
    const { fetch, requests } = captureFetch(() => jsonResponse({ ticketId: "t-100" }));
    const client = makeClient(fetch, { baseUrl: "https://stub.example", submitPath: "off-peak/ticket" });
    const ticketId = await client.submit(PAYLOAD);

    expect(ticketId).toBe("t-100");
    expect(requests.length).toBe(1);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url).toBe("https://stub.example/off-peak/ticket");
    expect(JSON.parse(requests[0]!.body!)).toEqual(PAYLOAD);
  });

  test("缺省端点常量布线正确；响应 ticket_id（snake_case）兼容", async () => {
    const { fetch, requests } = captureFetch(() => jsonResponse({ ticket_id: "t-200" }));
    const client = makeClient(fetch);
    const ticketId = await client.submit(PAYLOAD);
    expect(ticketId).toBe("t-200");
    expect(requests[0]!.url).toBe(`${DEFAULT_OFF_PEAK_BASE_URL}${DEFAULT_OFF_PEAK_SUBMIT_PATH}`);
  });

  test("响应缺 ticketId / 非对象 → protocol 错误", async () => {
    const missing = await makeClient(captureFetch(() => jsonResponse({ ok: true })).fetch)
      .submit(PAYLOAD)
      .catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(OffPeakClientError);
    expect((missing as OffPeakClientError).code).toBe("protocol");

    const notObject = await makeClient(captureFetch(() => jsonResponse([1])).fetch)
      .submit(PAYLOAD)
      .catch((e: unknown) => e);
    expect((notObject as OffPeakClientError).code).toBe("protocol");
  });

  test("HTTP 500 → http 错误；fetch 拒绝 → network 错误", async () => {
    const httpErr = await makeClient(captureFetch(() => jsonResponse({}, 500)).fetch)
      .submit(PAYLOAD)
      .catch((e: unknown) => e);
    expect((httpErr as OffPeakClientError).code).toBe("http");
    expect((httpErr as OffPeakClientError).status).toBe(500);

    const doFetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as FetchLike;
    const networkErr = await makeClient(doFetch)
      .submit(PAYLOAD)
      .catch((e: unknown) => e);
    expect((networkErr as OffPeakClientError).code).toBe("network");
  });
});

describe("OffPeakClient · pollStatus 归一化与 3102 超时语义", () => {
  test("GET statusPath/{ticketId}（URL 编码），状态归一 + result 透传", async () => {
    const { fetch, requests } = captureFetch(() =>
      jsonResponse({ status: "done", result: { units: 100 } }),
    );
    const client = makeClient(fetch, { baseUrl: "https://stub.example", statusPath: "/tickets" });
    const status = await client.pollStatus("t/特殊 字符");

    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.url).toBe(`https://stub.example/tickets/${encodeURIComponent("t/特殊 字符")}`);
    expect(status.status).toBe("done");
    expect(status.result).toEqual({ units: 100 });
  });

  test("缺省 statusPath 布线；queued/schedulable 归一", async () => {
    const queued = captureFetch(() => jsonResponse({ status: "queued" }));
    const s1 = await makeClient(queued.fetch).pollStatus("t1");
    expect(queued.requests[0]!.url).toBe(`${DEFAULT_OFF_PEAK_BASE_URL}${DEFAULT_OFF_PEAK_STATUS_PATH}/t1`);
    expect(s1).toEqual({ status: "queued" });

    const schedulable = captureFetch(() => jsonResponse({ status: "schedulable" }));
    const s2 = await makeClient(schedulable.fetch).pollStatus("t2");
    expect(s2.status).toBe("schedulable");
  });

  test(`体错误码 ${OFF_PEAK_TIMEOUT_CODE}（顶层）→ expired，reTicket 通知回调收到该 ticketId`, async () => {
    const notified: string[] = [];
    const { fetch } = captureFetch(() =>
      jsonResponse({ code: OFF_PEAK_TIMEOUT_CODE, msg: "ticket timeout" }),
    );
    const client = makeClient(fetch, { reTicket: (id) => void notified.push(id) });
    const status = await client.pollStatus("t-3102");

    expect(status).toEqual({ status: "expired" });
    expect(notified).toEqual(["t-3102"]);
  });

  test(`${OFF_PEAK_TIMEOUT_CODE}（嵌套 error.code）→ expired；reTicket 抛错不影响归一`, async () => {
    const { fetch } = captureFetch(() =>
      jsonResponse({ error: { code: OFF_PEAK_TIMEOUT_CODE } }),
    );
    const client = makeClient(fetch, {
      reTicket: () => {
        throw new Error("notify boom");
      },
    });
    const status = await client.pollStatus("t-nest");
    expect(status.status).toBe("expired");
  });

  test("其他体错误码 → failed + 脱敏 reason（不含响应原文）", async () => {
    const { fetch } = captureFetch(() =>
      jsonResponse({ code: 3200, msg: "PLAINTEXT-UPSTREAM-DETAIL" }),
    );
    const status = await makeClient(fetch).pollStatus("t-bad");
    expect(status.status).toBe("failed");
    expect(status.reason).toBe("upstream_code:3200");
    expect(status.reason).not.toContain("PLAINTEXT-UPSTREAM-DETAIL");
  });

  test("未知 status 字面量 → protocol 错误", async () => {
    const err = await makeClient(captureFetch(() => jsonResponse({ status: "wat" })).fetch)
      .pollStatus("t-u")
      .catch((e: unknown) => e);
    expect((err as OffPeakClientError).code).toBe("protocol");
  });
});

describe("OffPeakClient · 零网络与脱敏", () => {
  test("构造不触网；全程 stub 计数精确", async () => {
    const { fetch, count } = captureFetch((req) =>
      req.method === "POST" ? jsonResponse({ ticketId: "t" }) : jsonResponse({ status: "queued" }),
    );
    const client = makeClient(fetch);
    expect(count()).toBe(0);
    await client.submit(PAYLOAD);
    await client.pollStatus("t");
    expect(count()).toBe(2);
  });

  test("日志不含授权头明文", async () => {
    const KEY = "sk-PLAINTEXT-offpeak-key-9999";
    const logs: string[] = [];
    const { fetch } = captureFetch(() => jsonResponse({ ticketId: "t" }));
    const client = makeClient(fetch, {
      headers: { authorization: `Bearer ${KEY}` },
      log: (l) => logs.push(l),
    });
    await client.submit(PAYLOAD);
    const all = logs.join("\n");
    expect(logs.length).toBeGreaterThan(0);
    expect(all).not.toContain(KEY);
    expect(all).toContain("[REDACTED]");
    expect(all).not.toContain("nightly-report"); // payload 不落日志
  });
});
