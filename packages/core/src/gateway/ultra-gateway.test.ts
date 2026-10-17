import { describe, expect, test } from "bun:test";

import { role, type Secret } from "../auth/types";
import {
  buildFingerprintHeaders,
  DEFAULT_USER_AGENT,
  FINGERPRINT_HEADER_PLAN_KEY,
  FINGERPRINT_HEADER_TRACE_ID,
  FINGERPRINT_HEADER_USER_AGENT,
} from "./fingerprint";
import {
  classifyFailure,
  DEFAULT_ULTRA_BASE_URL,
  DEFAULT_ULTRA_ROUTE_RULES,
  UltraGateway,
  UltraGatewayError,
  type FetchLike,
  type UltraRouteRule,
} from "./ultra-gateway";

/** 假 key（仅测试内存值，非真实凭据，命名显式标注 PLAINTEXT 便于断言无泄漏）。 */
const API_KEY = "ultra-test-key-PLAINTEXT-abcd1234";

function credential(): Secret {
  return role("secret", API_KEY);
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** 内存 capture fetch stub：永不触网，记录请求并回放给定响应。 */
function captureFetch(respond: (req: CapturedRequest) => Response): {
  fetch: FetchLike;
  requests: CapturedRequest[];
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
  return { fetch: doFetch, requests };
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

async function catchError(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("期望 Promise 被 reject，但成功返回了");
}

function catchSync(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("期望同步抛错，但正常返回了");
}

const BASIC_REQUEST = {
  method: "POST",
  path: "/v1/messages",
  headers: { authorization: "Bearer test-token", "content-type": "application/json" },
  body: '{"model":"test-model"}',
};

describe("routeUltra · 专线 URL 重写矩阵", () => {
  test("常规 /v1/messages → 缺省 baseUrl 的专线形态，routed:true", () => {
    const gateway = new UltraGateway();
    const url = gateway.routeUltra({ path: "/v1/messages" });
    expect(url.href).toBe(`${DEFAULT_ULTRA_BASE_URL}/api/v1/ultra/anthropic/v1/messages`);
    expect(url.routed).toBe(true);
    expect(url).toBeInstanceOf(URL);
  });

  test("自定义 baseUrl（含路径段、尾斜杠）按 <baseUrl>/… 拼接", () => {
    const gateway = new UltraGateway({ baseUrl: "https://gw.example.com/base/" });
    const url = gateway.routeUltra({ path: "/v1/messages" });
    expect(url.href).toBe("https://gw.example.com/base/api/v1/ultra/anthropic/v1/messages");
  });

  test("版本段泛化：/v2/models → /api/v2/ultra/anthropic/v2/models", () => {
    const gateway = new UltraGateway();
    const url = gateway.routeUltra({ path: "/v2/models" });
    expect(url.href).toBe(`${DEFAULT_ULTRA_BASE_URL}/api/v2/ultra/anthropic/v2/models`);
    expect(url.routed).toBe(true);
  });

  test("幂等：对已重写结果再路由，href 与 routed 均不变", () => {
    const gateway = new UltraGateway();
    const once = gateway.routeUltra({ path: "/v1/messages" });
    const twice = gateway.routeUltra({ path: once.pathname });
    expect(twice.href).toBe(once.href);
    expect(twice.routed).toBe(true);
  });

  test("已含 /ultra/anthropic 段的路径原样返回且 routed:true", () => {
    const gateway = new UltraGateway();
    const full = gateway.routeUltra({ path: "/api/v1/ultra/anthropic/v1/messages" });
    expect(full.href).toBe(`${DEFAULT_ULTRA_BASE_URL}/api/v1/ultra/anthropic/v1/messages`);
    expect(full.routed).toBe(true);
    const partial = gateway.routeUltra({ path: "/v1/ultra/anthropic/x" });
    expect(partial.href).toBe(`${DEFAULT_ULTRA_BASE_URL}/v1/ultra/anthropic/x`);
    expect(partial.routed).toBe(true);
  });

  test("未知路径原样返回并附 routed:false", () => {
    const gateway = new UltraGateway();
    const unknown = gateway.routeUltra({ path: "/foo/bar" });
    expect(unknown.href).toBe(`${DEFAULT_ULTRA_BASE_URL}/foo/bar`);
    expect(unknown.routed).toBe(false);
    const apiPrefixed = gateway.routeUltra({ path: "/api/v1/messages" });
    expect(apiPrefixed.href).toBe(`${DEFAULT_ULTRA_BASE_URL}/api/v1/messages`);
    expect(apiPrefixed.routed).toBe(false);
  });

  test("查询串原样保留在专线路径之后", () => {
    const gateway = new UltraGateway();
    const url = gateway.routeUltra({ path: "/v1/messages?beta=1&x=%20a" });
    expect(url.pathname).toBe("/api/v1/ultra/anthropic/v1/messages");
    expect(url.search).toBe("?beta=1&x=%20a");
  });

  test("缺前导斜杠的路径自动归一化", () => {
    const gateway = new UltraGateway();
    expect(gateway.routeUltra({ path: "v1/messages" }).href).toBe(
      gateway.routeUltra({ path: "/v1/messages" }).href,
    );
  });

  test("规则表可扩展：注入规则与缺省规则组合生效", () => {
    const custom: UltraRouteRule = {
      name: "special-mount",
      pattern: /^\/special\//,
      rewrite: (pathname) => `/api/v1/ultra/anthropic/special-namespace${pathname}`,
    };
    const gateway = new UltraGateway({ rules: [...DEFAULT_ULTRA_ROUTE_RULES, custom] });
    const customRouted = gateway.routeUltra({ path: "/special/x" });
    expect(customRouted.href).toBe(
      `${DEFAULT_ULTRA_BASE_URL}/api/v1/ultra/anthropic/special-namespace/special/x`,
    );
    expect(customRouted.routed).toBe(true);
    expect(gateway.routeUltra({ path: "/v1/messages" }).href).toBe(
      `${DEFAULT_ULTRA_BASE_URL}/api/v1/ultra/anthropic/v1/messages`,
    );
  });

  test("空 path 抛 config 结构化错误", () => {
    const gateway = new UltraGateway();
    const error = catchSync(() => gateway.routeUltra({ path: "   " }));
    expect(error).toBeInstanceOf(UltraGatewayError);
    expect((error as UltraGatewayError).code).toBe("config");
  });

  test("非法 baseUrl 抛 config 结构化错误", () => {
    const bad = catchSync(() => new UltraGateway({ baseUrl: "not-a-url" }));
    expect(bad).toBeInstanceOf(UltraGatewayError);
    expect((bad as UltraGatewayError).code).toBe("config");
    const ftp = catchSync(() => new UltraGateway({ baseUrl: "ftp://open.bigmodel.cn" }));
    expect((ftp as UltraGatewayError).code).toBe("config");
  });
});

describe("send · 成功链路（全 stub，零触网）", () => {
  test("200：专线 URL、指纹三标头、授权标头合并、body 透传、返回脱敏结构", async () => {
    const { fetch, requests } = captureFetch(() => new Response('{"ok":true}', { status: 200 }));
    const gateway = new UltraGateway({ fetchImpl: fetch });
    const result = await gateway.send(BASIC_REQUEST, credential());

    expect(requests.length).toBe(1);
    expect(requests[0]!.url).toBe(`${DEFAULT_ULTRA_BASE_URL}/api/v1/ultra/anthropic/v1/messages`);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.headers["x-coding-plan-api-key"]).toBe(API_KEY);
    expect(requests[0]!.headers[FINGERPRINT_HEADER_USER_AGENT.toLowerCase()]).toBe(
      DEFAULT_USER_AGENT,
    );
    expect(requests[0]!.headers[FINGERPRINT_HEADER_TRACE_ID.toLowerCase()]).toMatch(/^[0-9a-f]{32}$/);
    expect(requests[0]!.headers["authorization"]).toBe("Bearer test-token");
    expect(requests[0]!.body).toBe('{"model":"test-model"}');

    expect(result.status).toBe(200);
    expect(result.bodyText).toBe('{"ok":true}');
    expect(result.headers).toBeInstanceOf(Object);
    expect(result.headers instanceof Headers).toBe(false);
  });

  test("指纹标头不可被请求标头覆盖（含伪造 plan key 与 UA）", async () => {
    const { fetch, requests } = captureFetch(() => new Response("ok", { status: 200 }));
    const gateway = new UltraGateway({ fetchImpl: fetch });
    await gateway.send(
      {
        method: "POST",
        path: "/v1/messages",
        headers: {
          "user-agent": "forged-agent/9.9",
          "X-Coding-Plan-Api-Key": "forged-key",
        },
      },
      credential(),
    );
    expect(requests[0]!.headers["user-agent"]).toBe(DEFAULT_USER_AGENT);
    expect(requests[0]!.headers["x-coding-plan-api-key"]).toBe(API_KEY);
  });

  test("traceIdGenerator 注入确定性：捕获标头等于注入值", async () => {
    const { fetch, requests } = captureFetch(() => new Response("ok", { status: 200 }));
    const gateway = new UltraGateway({ fetchImpl: fetch, traceIdGenerator: () => "trace-fixed-0001" });
    await gateway.send(BASIC_REQUEST, credential());
    expect(requests[0]!.headers["x-zcode-trace-id"]).toBe("trace-fixed-0001");
  });

  test("now 注入参与缺省 traceId：前 16 位 hex 为 epoch ms 大端编码", async () => {
    const NOW_MS = 1_234_567_890_123;
    const { fetch, requests } = captureFetch(() => new Response("ok", { status: 200 }));
    const gateway = new UltraGateway({ fetchImpl: fetch, now: () => NOW_MS });
    await gateway.send(BASIC_REQUEST, credential());
    const traceId = requests[0]!.headers["x-zcode-trace-id"]!;
    expect(traceId).toHaveLength(32);
    expect(traceId.startsWith(NOW_MS.toString(16).padStart(16, "0"))).toBe(true);
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  test("GET 无 body：init.body 为 undefined", async () => {
    const { fetch, requests } = captureFetch(() => new Response("ok", { status: 200 }));
    const gateway = new UltraGateway({ fetchImpl: fetch });
    await gateway.send({ method: "get", path: "/v1/models" }, credential());
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.body).toBeUndefined();
  });

  test("响应标头脱敏：上游回显的 plan key 遮蔽，普通标头原样", async () => {
    const { fetch } = captureFetch(() =>
      new Response("ok", {
        status: 200,
        headers: { "x-coding-plan-api-key": "echo-echo-9999", "content-type": "text/plain" },
      }),
    );
    const gateway = new UltraGateway({ fetchImpl: fetch });
    const result = await gateway.send(BASIC_REQUEST, credential());
    expect(result.headers["x-coding-plan-api-key"]).toBe("ze-***9999");
    expect(result.headers["content-type"]).toBe("text/plain");
  });

  test("userAgent 注入覆盖缺省指纹", async () => {
    const { fetch, requests } = captureFetch(() => new Response("ok", { status: 200 }));
    const gateway = new UltraGateway({ fetchImpl: fetch, userAgent: "zcode-cli/9.9.9" });
    await gateway.send(BASIC_REQUEST, credential());
    expect(requests[0]!.headers["user-agent"]).toBe("zcode-cli/9.9.9");
  });
});

describe("send · 失败分类（供上层自愈）", () => {
  test("401 → http 结构化错误 + auth 分类；响应正文与 key 明文均不进错误消息", async () => {
    const { fetch } = captureFetch(() => new Response(`leak-attempt ${API_KEY}`, { status: 401 }));
    const gateway = new UltraGateway({ fetchImpl: fetch });
    const error = (await catchError(() => gateway.send(BASIC_REQUEST, credential()))) as UltraGatewayError;
    expect(error).toBeInstanceOf(UltraGatewayError);
    expect(error.code).toBe("http");
    expect(error.status).toBe(401);
    expect(classifyFailure(401)).toBe("auth");
    expect(error.message.includes(API_KEY)).toBe(false);
    expect(error.message).toBe("Ultra 专线请求失败: HTTP 401 (POST /api/v1/ultra/anthropic/v1/messages)");
  });

  test("429 → http/429 + rate_limited 分类", async () => {
    const { fetch } = captureFetch(() => new Response("slow down", { status: 429 }));
    const gateway = new UltraGateway({ fetchImpl: fetch });
    const error = (await catchError(() => gateway.send(BASIC_REQUEST, credential()))) as UltraGatewayError;
    expect(error.code).toBe("http");
    expect(error.status).toBe(429);
    expect(classifyFailure(429)).toBe("rate_limited");
    expect(error.message.includes(API_KEY)).toBe(false);
  });

  test("500/503 → server 分类", async () => {
    for (const status of [500, 503]) {
      const { fetch } = captureFetch(() => new Response("boom", { status }));
      const gateway = new UltraGateway({ fetchImpl: fetch });
      const error = (await catchError(() => gateway.send(BASIC_REQUEST, credential()))) as UltraGatewayError;
      expect(error.code).toBe("http");
      expect(error.status).toBe(status);
      expect(classifyFailure(status)).toBe("server");
    }
  });

  test("400/418 → protocol 分类", async () => {
    for (const status of [400, 418]) {
      const { fetch } = captureFetch(() => new Response("bad request", { status }));
      const gateway = new UltraGateway({ fetchImpl: fetch });
      const error = (await catchError(() => gateway.send(BASIC_REQUEST, credential()))) as UltraGatewayError;
      expect(error.status).toBe(status);
      expect(classifyFailure(status)).toBe("protocol");
    }
  });

  test("classifyFailure 边界矩阵：401/403→auth、429→rate_limited、5xx→server、其余→protocol", () => {
    expect(classifyFailure(401)).toBe("auth");
    expect(classifyFailure(403)).toBe("auth");
    expect(classifyFailure(429)).toBe("rate_limited");
    expect(classifyFailure(500)).toBe("server");
    expect(classifyFailure(502)).toBe("server");
    expect(classifyFailure(599)).toBe("server");
    expect(classifyFailure(600)).toBe("protocol");
    expect(classifyFailure(404)).toBe("protocol");
    expect(classifyFailure(302)).toBe("protocol");
  });
});

describe("send · 超时与网络异常（AbortSignal 注入）", () => {
  test("signal 预先中止 → timeout 结构化错误", async () => {
    const gateway = new UltraGateway({ fetchImpl: hangingFetch() });
    const controller = new AbortController();
    controller.abort();
    const error = (await catchError(() =>
      gateway.send(BASIC_REQUEST, credential(), { signal: controller.signal }),
    )) as UltraGatewayError;
    expect(error).toBeInstanceOf(UltraGatewayError);
    expect(error.code).toBe("timeout");
    expect(error.message.includes(API_KEY)).toBe(false);
  });

  test("请求中途 abort → timeout 结构化错误", async () => {
    const gateway = new UltraGateway({ fetchImpl: hangingFetch() });
    const controller = new AbortController();
    const pending = gateway.send(BASIC_REQUEST, credential(), { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 2);
    try {
      const error = (await catchError(() => pending)) as UltraGatewayError;
      expect(error.code).toBe("timeout");
    } finally {
      clearTimeout(timer);
    }
  });

  test("TimeoutError 名称的失败 → timeout 分类", async () => {
    const gateway = new UltraGateway({
      fetchImpl: (() => {
        const timeoutError = new Error("timed out");
        timeoutError.name = "TimeoutError";
        return Promise.reject(timeoutError);
      }) as FetchLike,
    });
    const error = (await catchError(() => gateway.send(BASIC_REQUEST, credential()))) as UltraGatewayError;
    expect(error.code).toBe("timeout");
  });

  test("网络异常 → network 结构化错误，message 不含 key 明文", async () => {
    const gateway = new UltraGateway({
      fetchImpl: (() => Promise.reject(new TypeError("fetch failed"))) as FetchLike,
    });
    const error = (await catchError(() => gateway.send(BASIC_REQUEST, credential()))) as UltraGatewayError;
    expect(error.code).toBe("network");
    expect(error.status).toBeUndefined();
    expect(error.message.includes(API_KEY)).toBe(false);
  });
});

describe("send · 脱敏日志行（零数据外泄断言）", () => {
  test("成功路径：单行 JSON，指纹三标头 ze-***last4，无 key 明文", async () => {
    const { fetch } = captureFetch(() => new Response("ok", { status: 200 }));
    const gateway = new UltraGateway({ fetchImpl: fetch, traceIdGenerator: () => "0123456789abcdef" });
    const lines: string[] = [];
    await gateway.send(BASIC_REQUEST, credential(), { log: (line) => lines.push(line) });

    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed["method"]).toBe("POST");
    expect(parsed["url"]).toBe(`${DEFAULT_ULTRA_BASE_URL}/api/v1/ultra/anthropic/v1/messages`);
    expect(parsed["status"]).toBe(200);
    expect(parsed[FINGERPRINT_HEADER_PLAN_KEY]).toBe("ze-***1234");
    expect(parsed[FINGERPRINT_HEADER_USER_AGENT]).toBe("ze-***.1.8");
    expect(parsed[FINGERPRINT_HEADER_TRACE_ID]).toBe("ze-***cdef");
    expect(lines[0]!.includes(API_KEY)).toBe(false);
    expect(lines[0]!.includes("test-token")).toBe(false);
  });

  test("失败路径（401）：note 标注 failed:http，仍无 key 明文", async () => {
    const { fetch } = captureFetch(() => new Response("unauthorized", { status: 401 }));
    const gateway = new UltraGateway({ fetchImpl: fetch });
    const lines: string[] = [];
    await catchError(() =>
      gateway.send(BASIC_REQUEST, credential(), { log: (line) => lines.push(line) }),
    );

    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(String(parsed["note"])).toMatch(/^failed:http:durationMs:\d+$/);
    expect(parsed["status"]).toBe(401);
    expect(parsed[FINGERPRINT_HEADER_PLAN_KEY]).toBe("ze-***1234");
    expect(lines[0]!.includes(API_KEY)).toBe(false);
  });
});

describe("模块常量与指纹装配一致性", () => {
  test("缺省 baseUrl 与指纹缺省 UA 常量稳定", () => {
    expect(DEFAULT_ULTRA_BASE_URL).toBe("https://open.bigmodel.cn");
    expect(DEFAULT_USER_AGENT).toBe("zcode-cli/0.1.8");
  });

  test("send 与 buildFingerprintHeaders 的标头装配一致（stub 捕获比对）", async () => {
    const { fetch, requests } = captureFetch(() => new Response("ok", { status: 200 }));
    const gateway = new UltraGateway({ fetchImpl: fetch, traceIdGenerator: () => "aaaaaaaaaaaaaaaa" });
    await gateway.send({ method: "POST", path: "/v1/messages" }, credential());
    const expected = buildFingerprintHeaders({ apiKey: credential(), traceId: "aaaaaaaaaaaaaaaa" });
    expect(requests[0]!.headers["x-coding-plan-api-key"]).toBe(expected[FINGERPRINT_HEADER_PLAN_KEY]);
    expect(requests[0]!.headers["user-agent"]).toBe(expected[FINGERPRINT_HEADER_USER_AGENT]);
    expect(requests[0]!.headers["x-zcode-trace-id"]).toBe(expected[FINGERPRINT_HEADER_TRACE_ID]);
  });
});
