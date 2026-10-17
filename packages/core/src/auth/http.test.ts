import { describe, expect, test } from "bun:test";

import {
  HttpRequestError,
  abortableSleep,
  formatLogLine,
  redactHeaders,
  redactUrl,
  redactValue,
  requestJson,
  type FetchLike,
} from "./http";

const SECRET = "sk-super-secret-value";

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** 统计调用次数的可编程 stub。 */
function sequenceFetch(
  responses: Array<Response | Error>,
): { fetch: FetchLike; calls: () => number } {
  let count = 0;
  const fetch = ((_url: string, _init?: RequestInit) => {
    const item = responses[Math.min(count, responses.length - 1)]!;
    count++;
    if (item instanceof Error) return Promise.reject(item);
    return Promise.resolve(item);
  }) as FetchLike;
  return { fetch, calls: () => count };
}

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

describe("http · 脱敏工具", () => {
  test("redactHeaders 遮蔽敏感标头（对象与 Headers 两种入参）", () => {
    const masked = redactHeaders({
      Authorization: `Bearer ${SECRET}`,
      "X-Api-Key": SECRET,
      "content-type": "application/json",
    });
    expect(masked.authorization).toBe("[REDACTED]");
    expect(masked["x-api-key"]).toBe("[REDACTED]");
    expect(masked["content-type"]).toBe("application/json");

    const headers = new Headers({ "x-coding-plan-api-key": SECRET, accept: "application/json" });
    expect(redactHeaders(headers)["x-coding-plan-api-key"]).toBe("[REDACTED]");
    expect(redactHeaders(headers).accept).toBe("application/json");
  });

  test("redactUrl 遮蔽敏感 query 值，保留键名与非敏感参数", () => {
    const masked = redactUrl(
      "https://example.com/api/poll?poll_token=abc123&code=xyz&client_id=app&keep=1",
    );
    expect(masked).toContain("poll_token=%5BREDACTED%5D");
    expect(masked).toContain("code=%5BREDACTED%5D");
    expect(masked).toContain("client_id=app");
    expect(masked).toContain("keep=1");
    expect(masked).not.toContain("abc123");
  });

  test("redactValue 深层遮蔽敏感键（含数组），非敏感键保留", () => {
    const masked = redactValue({
      access_token: SECRET,
      nested: { refresh_token: SECRET, plain: "ok" },
      list: [{ api_key: SECRET }, "safe"],
      code_verifier: SECRET,
      count: 3,
    });
    const value = masked as Record<string, unknown>;
    expect(value.access_token).toBe("[REDACTED]");
    expect((value.nested as Record<string, unknown>).refresh_token).toBe("[REDACTED]");
    expect((value.nested as Record<string, unknown>).plain).toBe("ok");
    expect((value.list as unknown[])[0]).toEqual({ api_key: "[REDACTED]" });
    expect(value.code_verifier).toBe("[REDACTED]");
    expect(value.count).toBe(3);
  });

  test("formatLogLine 输出单行 JSON 且不含明文", () => {
    const line = formatLogLine({
      method: "POST",
      url: "https://example.com/token?state=secret-state",
      attempt: 0,
      status: 200,
      requestHeaders: { authorization: `Bearer ${SECRET}` },
    });
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain("secret-state");
    expect(JSON.parse(line).status).toBe(200);
  });
});

describe("http · requestJson 基础行为", () => {
  test("GET 2xx 解析 JSON 并回传 status/headers", async () => {
    const { fetch } = sequenceFetch([jsonResponse({ ok: 1 }, 200, { "x-meta": "m" })]);
    const result = await requestJson({ url: "https://example.com/api", fetch });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ ok: 1 });
    expect(result.headers.get("x-meta")).toBe("m");
  });

  test("POST 序列化 JSON 负载并补 content-type", async () => {
    let seenInit: RequestInit | undefined;
    const fetch = ((_url: string, init?: RequestInit) => {
      seenInit = init;
      return Promise.resolve(jsonResponse({ ok: 1 }));
    }) as FetchLike;
    await requestJson({
      method: "POST",
      url: "https://example.com/token",
      body: { grant_type: "authorization_code" },
      fetch,
    });
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.body).toBe(JSON.stringify({ grant_type: "authorization_code" }));
    expect(new Headers(seenInit?.headers).get("content-type")).toBe("application/json");
  });

  test("非 2xx 抛 HttpRequestError(kind=http) 且不回传响应正文", async () => {
    const { fetch } = sequenceFetch([new Response("top-secret-body", { status: 403 })]);
    try {
      await requestJson({ url: "https://example.com/api", fetch });
      throw new Error("should not reach");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpRequestError);
      const e = error as HttpRequestError;
      expect(e.kind).toBe("http");
      expect(e.status).toBe(403);
      expect(e.message).not.toContain("top-secret-body");
    }
  });
});

describe("http · 重试（仅幂等轮询）", () => {
  test("retries>0 时对 5xx 指数退避重试直至成功", async () => {
    const { fetch, calls } = sequenceFetch([
      jsonResponse({}, 500),
      jsonResponse({}, 503),
      jsonResponse({ ok: 1 }),
    ]);
    const result = await requestJson({
      url: "https://example.com/poll",
      fetch,
      retries: 3,
      backoffMs: 1,
    });
    expect(result.status).toBe(200);
    expect(calls()).toBe(3);
  });

  test("重试耗尽后抛最后一次错误", async () => {
    const { fetch, calls } = sequenceFetch([jsonResponse({}, 500), jsonResponse({}, 500)]);
    try {
      await requestJson({ url: "https://example.com/poll", fetch, retries: 1, backoffMs: 1 });
      throw new Error("should not reach");
    } catch (error) {
      expect((error as HttpRequestError).kind).toBe("http");
      expect(calls()).toBe(2);
    }
  });

  test("retries 缺省（非幂等）不重试：POST 500 只调用一次", async () => {
    const { fetch, calls } = sequenceFetch([jsonResponse({}, 500)]);
    try {
      await requestJson({ method: "POST", url: "https://example.com/token", fetch });
      throw new Error("should not reach");
    } catch (error) {
      expect((error as HttpRequestError).status).toBe(500);
      expect(calls()).toBe(1);
    }
  });

  test("4xx 不重试（即使声明幂等）", async () => {
    const { fetch, calls } = sequenceFetch([jsonResponse({}, 404)]);
    try {
      await requestJson({ url: "https://example.com/api", fetch, retries: 3, backoffMs: 1 });
      throw new Error("should not reach");
    } catch (error) {
      expect((error as HttpRequestError).status).toBe(404);
      expect(calls()).toBe(1);
    }
  });

  test("网络错误重试后成功", async () => {
    const { fetch, calls } = sequenceFetch([
      new Error("ECONNRESET"),
      new Error("ECONNRESET"),
      jsonResponse({ ok: 1 }),
    ]);
    const result = await requestJson({ url: "https://example.com/poll", fetch, retries: 2, backoffMs: 1 });
    expect(result.json).toEqual({ ok: 1 });
    expect(calls()).toBe(3);
  });
});

describe("http · 超时与取消", () => {
  test("单次尝试超时抛 network，且消息区分超时", async () => {
    try {
      await requestJson({ url: "https://example.com/slow", fetch: hangingFetch(), timeoutMs: 30 });
      throw new Error("should not reach");
    } catch (error) {
      const e = error as HttpRequestError;
      expect(e.kind).toBe("network");
      expect(e.message).toContain("请求超时");
    }
  });

  test("外部 signal 预先中止 → network", async () => {
    const controller = new AbortController();
    controller.abort();
    try {
      await requestJson({
        url: "https://example.com/api",
        fetch: hangingFetch(),
        signal: controller.signal,
      });
      throw new Error("should not reach");
    } catch (error) {
      expect((error as HttpRequestError).kind).toBe("network");
    }
  });
});

describe("http · 协议错误", () => {
  test("2xx 空响应体 → protocol", async () => {
    const { fetch } = sequenceFetch([new Response("", { status: 200 })]);
    try {
      await requestJson({ url: "https://example.com/api", fetch });
      throw new Error("should not reach");
    } catch (error) {
      expect((error as HttpRequestError).kind).toBe("protocol");
    }
  });

  test("2xx 非法 JSON → protocol，正文不进错误消息", async () => {
    const { fetch } = sequenceFetch([new Response("raw-secret-body", { status: 200 })]);
    try {
      await requestJson({ url: "https://example.com/api", fetch });
      throw new Error("should not reach");
    } catch (error) {
      const e = error as HttpRequestError;
      expect(e.kind).toBe("protocol");
      expect(e.message).not.toContain("raw-secret-body");
    }
  });
});

describe("http · 零数据外泄（日志断言）", () => {
  test("请求日志遮蔽 authorization 与 URL 敏感 query", async () => {
    const logLines: string[] = [];
    const { fetch } = sequenceFetch([jsonResponse({ access_token: "pat-xyz" })]);
    await requestJson({
      url: "https://example.com/poll?poll_token=poll-secret-123",
      headers: { authorization: `Bearer ${SECRET}` },
      fetch,
      log: (line) => logLines.push(line),
    });
    const all = logLines.join("\n");
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain("poll-secret-123");
    expect(all).not.toContain("pat-xyz"); // 响应负载从不入日志
    expect(all).toContain("[REDACTED]");
  });
});

describe("http · abortableSleep", () => {
  test("中止时提前返回，正常时按期返回", async () => {
    const controller = new AbortController();
    const start = Date.now();
    const pending = abortableSleep(200, controller.signal);
    queueMicrotask(() => controller.abort());
    await pending;
    expect(Date.now() - start).toBeLessThan(150);

    const start2 = Date.now();
    await abortableSleep(10);
    expect(Date.now() - start2).toBeGreaterThanOrEqual(5);
  });
});
