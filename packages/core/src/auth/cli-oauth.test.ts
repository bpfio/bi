import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  CliOAuthFlow,
  OAuthStateError,
  buildAuthorizeUrl,
  generatePkcePair,
  generatePollToken,
  pkceS256Challenge,
  type CliOAuthConfig,
} from "./cli-oauth";
import { role } from "./types";
import type { FetchLike } from "./http";

const CLIENT_ID = "test-client-id";
const PAT = "pat-test-1234567890";
const AUTH_CODE = "super-secret-auth-code";

/** 按 URL 路由的内存 fetch stub（永不触网）。 */
function stubFetch(
  routes: Record<string, (url: string, init: RequestInit | undefined) => Response | Promise<Response>>,
): FetchLike {
  return (url: string, init?: RequestInit): Promise<Response> => {
    for (const [fragment, handler] of Object.entries(routes)) {
      if (url.includes(fragment)) return Promise.resolve(handler(url, init));
    }
    return Promise.resolve(new Response(JSON.stringify({ error: "no route" }), { status: 404 }));
  };
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** 成功路径的默认配置：pending ×2 → code → 换票 PAT。 */
function successFlow(overrides: Partial<CliOAuthConfig> = {}) {
  let pollCalls = 0;
  const openedUrls: string[] = [];
  const flow = new CliOAuthFlow({
    clientId: CLIENT_ID,
    pollIntervalMs: 5,
    pollTimeoutMs: 2000,
    fetch: stubFetch({
      "/api/oauth/poll": () => {
        pollCalls++;
        if (pollCalls <= 2) return jsonResponse({ status: "pending" });
        return jsonResponse({ status: "success", code: AUTH_CODE });
      },
      "/api/oauth/token": () =>
        jsonResponse({
          access_token: PAT,
          token_use: "project_access",
          expires_in: 3600,
          refresh_token: "rt-1",
        }),
    }),
    openBrowser: (url) => {
      openedUrls.push(url);
    },
    ...overrides,
  });
  return { flow, openedUrls, pollCallCount: () => pollCalls };
}

describe("cli-oauth · PollToken 安全性", () => {
  test("32 字节安全随机（base64url 解码）", () => {
    const token = generatePollToken();
    expect(Buffer.from(token, "base64url").length).toBe(32);
  });

  test("base64url 字符集且无填充", () => {
    const token = generatePollToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain("=");
  });

  test("两次生成不重复（randomness）", () => {
    const seen = new Set(Array.from({ length: 64 }, () => generatePollToken()));
    expect(seen.size).toBe(64);
  });
});

describe("cli-oauth · PKCE S256 规范", () => {
  test("RFC 7636 Appendix B 官方向量", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(pkceS256Challenge(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("challenge 等于 base64url(sha256(verifier)) 且无填充", () => {
    const verifier = generatePkcePair().verifier;
    // 手工 base64→base64url 转换（+/→-_，去填充），交叉验证而非循环引用。
    const manual = createHash("sha256")
      .update(verifier, "ascii")
      .digest("base64")
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    expect(pkceS256Challenge(verifier)).toBe(manual);
    expect(pkceS256Challenge(verifier)).toHaveLength(43);
  });

  test("verifier 为 43 字符 base64url（RFC 7636 43~128 约束），成对生成不重复", () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.challenge).toBe(pkceS256Challenge(a.verifier));
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

describe("cli-oauth · 授权 URL 构造", () => {
  test("含 response_type/client_id/redirect_uri/S256 challenge/state", () => {
    const url = new URL(
      buildAuthorizeUrl({
        authorizeUrl: "https://open.bigmodel.cn/api/oauth/authorize",
        clientId: CLIENT_ID,
        redirectUri: "https://open.bigmodel.cn/api/oauth/cli-callback",
        scopes: ["openid", "profile"],
        challenge: "challenge-xyz",
        state: "poll-token-abc",
      }),
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe("https://open.bigmodel.cn/api/oauth/cli-callback");
    expect(url.searchParams.get("scope")).toBe("openid profile");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-xyz");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("poll-token-abc");
  });
});

describe("cli-oauth · 状态机转移", () => {
  test("成功路径：idle→awaiting_browser→polling→exchange→success，捕获 PAT", async () => {
    const { flow, openedUrls, pollCallCount } = successFlow();
    expect(flow.state).toBe("idle");

    const outcome = await flow.run();

    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    expect(outcome.credential.accessToken).toBe(role("secret", PAT));
    expect(outcome.credential.refreshToken).toBe(role("secret", "rt-1"));
    expect(outcome.credential.obtainedAt).toBeGreaterThan(0);
    expect(outcome.credential.expiresAt).toBeGreaterThan(outcome.credential.obtainedAt);

    expect(flow.state).toBe("success");
    expect(flow.transitions.map((t) => `${t.from}->${t.to}`)).toEqual([
      "idle->awaiting_browser",
      "awaiting_browser->polling",
      "polling->exchange",
      "exchange->success",
    ]);
    expect(flow.transitions.map((t) => t.reason)).toEqual([
      "flow_started",
      "browser_opened",
      "token_payload_received",
      "authorization_code_exchanged",
    ]);
    expect(pollCallCount()).toBeGreaterThanOrEqual(3);

    // 唤起浏览器的 URL 携带 PKCE challenge 与 PollToken state。
    expect(openedUrls.length).toBe(1);
    const url = new URL(openedUrls[0]!);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(Buffer.from(url.searchParams.get("state")!, "base64url").length).toBe(32);
  });

  test("直出模式：轮询直接带回 access_token，无需换票请求", async () => {
    let tokenCalls = 0;
    const { flow } = successFlow({
      fetch: stubFetch({
        "/api/oauth/poll": () =>
          jsonResponse({ status: "success", access_token: PAT, token_use: "project_access" }),
        "/api/oauth/token": () => {
          tokenCalls++;
          return jsonResponse({ access_token: "should-not-be-called" });
        },
      }),
    });
    const outcome = await flow.run();
    expect(outcome.status).toBe("success");
    expect(tokenCalls).toBe(0);
    expect(flow.transitions.at(-1)?.reason).toBe("token_received_directly");
  });

  test("服务端判过期：polling→expired（server_expired）", async () => {
    const { flow } = successFlow({
      fetch: stubFetch({
        "/api/oauth/poll": () => jsonResponse({ status: "expired" }),
      }),
    });
    const outcome = await flow.run();
    expect(outcome).toEqual({ status: "expired", reason: "server_expired" });
    expect(flow.state).toBe("expired");
    expect(flow.transitions.at(-1)).toMatchObject({ from: "polling", to: "expired", reason: "server_expired" });
  });

  test("本地轮询超时：polling→expired（poll_timeout）", async () => {
    const { flow } = successFlow({
      pollIntervalMs: 5,
      pollTimeoutMs: 40,
      fetch: stubFetch({
        "/api/oauth/poll": () => jsonResponse({ status: "pending" }),
      }),
    });
    const outcome = await flow.run();
    expect(outcome).toEqual({ status: "expired", reason: "poll_timeout" });
    expect(flow.state).toBe("expired");
  });

  test("AbortSignal 取消：polling→error（cancelled）", async () => {
    const controller = new AbortController();
    let pollCalls = 0;
    const { flow } = successFlow({
      signal: controller.signal,
      pollIntervalMs: 30,
      fetch: stubFetch({
        "/api/oauth/poll": () => {
          pollCalls++;
          if (pollCalls === 1) controller.abort();
          return jsonResponse({ status: "pending" });
        },
      }),
    });
    const outcome = await flow.run();
    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") return;
    expect(outcome.failure.kind).toBe("cancelled");
    expect(flow.transitions.at(-1)).toMatchObject({ from: "polling", to: "error", reason: "cancelled" });
  });

  test("网络失败：polling→error（network）", async () => {
    const { flow } = successFlow({
      fetch: stubFetch({
        "/api/oauth/poll": () => {
          throw new Error("boom");
        },
      }),
    });
    const outcome = await flow.run();
    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") return;
    expect(outcome.failure.kind).toBe("network");
    expect(flow.transitions.at(-1)).toMatchObject({ from: "polling", to: "error", reason: "network" });
  });

  test("HTTP 500：polling→error（http, status=500）", async () => {
    const { flow } = successFlow({
      fetch: stubFetch({
        "/api/oauth/poll": () => new Response("server exploded", { status: 500 }),
      }),
    });
    const outcome = await flow.run();
    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") return;
    expect(outcome.failure.kind).toBe("http");
    expect(outcome.failure.status).toBe(500);
    expect(outcome.failure.message).not.toContain("server exploded"); // 响应原文不外泄
  });

  test("协议错误：轮询 status 非法 → error（protocol）", async () => {
    const { flow } = successFlow({
      fetch: stubFetch({
        "/api/oauth/poll": () => jsonResponse({ status: "weird" }),
      }),
    });
    const outcome = await flow.run();
    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") return;
    expect(outcome.failure.kind).toBe("protocol");
  });

  test("换票 401：exchange→error（http, status=401）", async () => {
    const { flow } = successFlow({
      fetch: stubFetch({
        "/api/oauth/poll": () => jsonResponse({ status: "success", code: AUTH_CODE }),
        "/api/oauth/token": () => new Response("nope", { status: 401 }),
      }),
    });
    const outcome = await flow.run();
    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") return;
    expect(outcome.failure.kind).toBe("http");
    expect(outcome.failure.status).toBe(401);
    expect(flow.transitions.at(-1)).toMatchObject({ from: "exchange", to: "error" });
  });

  test("令牌响应 token_use 非法：exchange→error（protocol）", async () => {
    const { flow } = successFlow({
      fetch: stubFetch({
        "/api/oauth/poll": () => jsonResponse({ status: "success", code: AUTH_CODE }),
        "/api/oauth/token": () => jsonResponse({ access_token: PAT, token_use: "user" }),
      }),
    });
    const outcome = await flow.run();
    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") return;
    expect(outcome.failure.kind).toBe("protocol");
  });

  test("浏览器唤起失败：awaiting_browser→error（browser），不进入轮询", async () => {
    const { flow } = successFlow({
      openBrowser: () => {
        throw new Error("no display");
      },
    });
    const outcome = await flow.run();
    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") return;
    expect(outcome.failure.kind).toBe("browser");
    expect(flow.transitions).toEqual([
      expect.objectContaining({ from: "idle", to: "awaiting_browser" }),
      expect.objectContaining({ from: "awaiting_browser", to: "error", reason: "browser" }),
    ]);
  });

  test("终态后重跑抛 OAuthStateError（非法转移）", async () => {
    const { flow } = successFlow();
    await flow.run();
    expect(flow.run()).rejects.toBeInstanceOf(OAuthStateError);
  });
});

describe("cli-oauth · 零数据外泄", () => {
  test("日志全程不含 PAT、授权码与轮询 token", async () => {
    const logLines: string[] = [];
    const { flow, openedUrls } = successFlow({ log: (line) => logLines.push(line) });
    await flow.run();

    const all = logLines.join("\n") + "\n" + openedUrls.join("\n");
    expect(logLines.length).toBeGreaterThan(0);
    expect(all).not.toContain(PAT);
    expect(all).not.toContain(AUTH_CODE);
    // 日志中 URL 的敏感 query 值一律遮蔽。
    expect(all).not.toMatch(/poll_token=[A-Za-z0-9_-]{20,}/);
  });
});
