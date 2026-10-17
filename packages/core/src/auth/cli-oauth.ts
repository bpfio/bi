/**
 * BI-02 · 通道一 —— OAuth 2.0 PKCE/Poll 状态机（智谱 BigModel CLI 授权）。
 *
 * 流程：idle → awaiting_browser（生成 32 字节 PollToken + PKCE S256，构造授权 URL
 * 并唤醒浏览器）→ polling（轮询令牌端点，间隔/超时可配，AbortSignal 可取消）
 * → exchange（授权码 + code_verifier 换 PAT）→ success | expired | error。
 *
 * 零数据外泄：fetch 与浏览器唤起全部依赖注入；日志经 http 层脱敏。
 * 零外部依赖：randomBytes/sha256 来自 node:crypto。
 */
import { createHash, randomBytes } from "node:crypto";

import {
  HttpRequestError,
  abortableSleep,
  redactUrl,
  requestJson,
  type FetchLike,
} from "./http";
import { role, type Secret } from "./types";

/** 默认 OAuth 端点（可整体注入覆盖；测试一律注入 stub，不触网）。 */
export const DEFAULT_OAUTH_ENDPOINTS = {
  authorize: "https://open.bigmodel.cn/api/oauth/authorize",
  token: "https://open.bigmodel.cn/api/oauth/token",
  poll: "https://open.bigmodel.cn/api/oauth/poll",
} as const;

/** 默认 CLI 回调页（设备码式授权：浏览器侧确认后 CLI 轮询取票）。 */
export const DEFAULT_REDIRECT_URI = "https://open.bigmodel.cn/api/oauth/cli-callback";

export interface OAuthEndpoints {
  readonly authorize: string;
  readonly token: string;
  readonly poll: string;
}

/** 显式状态机状态。 */
export type OAuthStateName =
  | "idle"
  | "awaiting_browser"
  | "polling"
  | "exchange"
  | "success"
  | "expired"
  | "error";

/** 合法状态转移表（显式建模，转移可测试）。 */
export const OAUTH_STATE_TRANSITIONS: Readonly<
  Record<OAuthStateName, readonly OAuthStateName[]>
> = {
  idle: ["awaiting_browser"],
  awaiting_browser: ["polling", "error"],
  polling: ["exchange", "expired", "error"],
  exchange: ["success", "error"],
  success: [],
  expired: [],
  error: [],
};

/** 一次状态转移记录（含稳定 reason，供断言）。 */
export interface OAuthTransition {
  readonly from: OAuthStateName;
  readonly to: OAuthStateName;
  readonly reason: string;
  readonly at: number;
}

/** 结构化失败（message 脱敏，不含响应原文）。 */
export interface OAuthFailure {
  readonly kind: "network" | "http" | "protocol" | "browser" | "cancelled";
  readonly message: string;
  readonly status?: number;
}

/** 捕获到的 PAT 凭据。 */
export interface OAuthCredential {
  /** Project Access Token（role("secret") 标记）。 */
  readonly accessToken: Secret;
  readonly refreshToken?: Secret;
  /** 过期时间（epoch 毫秒），由 expires_in 推算。 */
  readonly expiresAt?: number;
  readonly obtainedAt: number;
}

export type OAuthOutcome =
  | { readonly status: "success"; readonly credential: OAuthCredential }
  | { readonly status: "expired"; readonly reason: "poll_timeout" | "server_expired" }
  | { readonly status: "error"; readonly failure: OAuthFailure };

export interface CliOAuthConfig {
  /** 客户端 ID（无默认值，必须显式提供）。 */
  readonly clientId: string;
  readonly redirectUri?: string;
  readonly scopes?: readonly string[];
  readonly endpoints?: Partial<OAuthEndpoints>;
  /** fetch 注入（测试注入内存 stub，严禁真实调用）。 */
  readonly fetch?: FetchLike;
  /** 浏览器唤起注入（测试注入 stub；缺省用平台命令 xdg-open/open/start）。 */
  readonly openBrowser?: (url: string) => Promise<void> | void;
  /** 轮询间隔（毫秒），默认 1500。 */
  readonly pollIntervalMs?: number;
  /** 轮询总超时（毫秒），默认 300_000；超时进入 expired。 */
  readonly pollTimeoutMs?: number;
  /** 单次 HTTP 请求超时（毫秒），默认 10_000。 */
  readonly requestTimeoutMs?: number;
  /** 外部取消信号；中止进入 error(cancelled)。 */
  readonly signal?: AbortSignal;
  /** 时钟注入。 */
  readonly now?: () => number;
  /** 脱敏日志宿。 */
  readonly log?: (line: string) => void;
}

export class OAuthStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthStateError";
  }
}

/** 生成 32 字节安全 PollToken（base64url，无填充）。 */
export function generatePollToken(): string {
  return randomBytes(32).toString("base64url");
}

/** RFC 7636 S256：challenge = BASE64URL(SHA256(ASCII(verifier)))，去填充。 */
export function pkceS256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** 生成 PKCE code_verifier（43 字符 base64url，符合 RFC 7636 43~128 约束）与 challenge。 */
export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: pkceS256Challenge(verifier) };
}

/** 构造授权 URL（response_type=code + S256 PKCE + state=PollToken）。 */
export function buildAuthorizeUrl(options: {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  scopes?: readonly string[];
  challenge: string;
  state: string;
}): string {
  const url = new URL(options.authorizeUrl);
  const params = url.searchParams;
  params.set("response_type", "code");
  params.set("client_id", options.clientId);
  params.set("redirect_uri", options.redirectUri);
  if (options.scopes && options.scopes.length > 0) {
    params.set("scope", options.scopes.join(" "));
  }
  params.set("code_challenge", options.challenge);
  params.set("code_challenge_method", "S256");
  params.set("state", options.state);
  return url.toString();
}

/** 轮询端点响应契约（status 驱动状态机）。 */
type PollResponseBody = {
  status?: unknown;
  code?: unknown;
  access_token?: unknown;
  token_use?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
};

/** 令牌端点响应契约。 */
type TokenResponseBody = {
  access_token?: unknown;
  token_use?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
};

/** 缺省浏览器唤起：平台命令（linux xdg-open / darwin open / win32 start）。 */
async function defaultOpenBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * PKCE/Poll 授权流。run() 从 idle 驱动到终态（success/expired/error），
 * 全部转移记录在 transitions 历史；终态后重跑抛 OAuthStateError。
 */
export class CliOAuthFlow {
  readonly #config: CliOAuthConfig;
  readonly #endpoints: OAuthEndpoints;
  #state: OAuthStateName = "idle";
  readonly #history: OAuthTransition[] = [];
  #authorizeUrl: string | undefined;

  constructor(config: CliOAuthConfig) {
    if (config.clientId === "") {
      throw new OAuthStateError("clientId 不能为空");
    }
    this.#config = config;
    this.#endpoints = { ...DEFAULT_OAUTH_ENDPOINTS, ...config.endpoints };
  }

  get state(): OAuthStateName {
    return this.#state;
  }

  get transitions(): readonly OAuthTransition[] {
    return this.#history;
  }

  /** 授权 URL（进入 awaiting_browser 后可用）。 */
  get authorizeUrl(): string | undefined {
    return this.#authorizeUrl;
  }

  #transition(to: OAuthStateName, reason: string): void {
    const allowed = OAUTH_STATE_TRANSITIONS[this.#state];
    if (!allowed.includes(to)) {
      throw new OAuthStateError(
        `非法状态转移: ${this.#state} -> ${to}（reason=${reason}）`,
      );
    }
    this.#history.push({ from: this.#state, to, reason, at: this.#now() });
    this.#state = to;
  }

  get #now(): () => number {
    return this.#config.now ?? Date.now;
  }

  async run(): Promise<OAuthOutcome> {
    if (this.#state !== "idle") {
      throw new OAuthStateError(`流程已启动，当前状态: ${this.#state}`);
    }
    const pollToken = generatePollToken();
    const { verifier, challenge } = generatePkcePair();
    const redirectUri = this.#config.redirectUri ?? DEFAULT_REDIRECT_URI;
    const url = buildAuthorizeUrl({
      authorizeUrl: this.#endpoints.authorize,
      clientId: this.#config.clientId,
      redirectUri,
      scopes: this.#config.scopes,
      challenge,
      state: pollToken,
    });
    this.#transition("awaiting_browser", "flow_started");
    this.#authorizeUrl = url;

    if (this.#config.signal?.aborted) {
      return this.#fail("cancelled", "启动前已中止");
    }

    // 唤醒浏览器（注入优先；缺省平台命令）。
    try {
      const open = this.#config.openBrowser ?? defaultOpenBrowser;
      await open(url);
    } catch {
      return this.#fail("browser", `浏览器唤起失败: ${redactUrl(url)}`);
    }
    this.#transition("polling", "browser_opened");

    // 轮询令牌端点：间隔 + 总超时 + 可取消。
    const intervalMs = this.#config.pollIntervalMs ?? 1500;
    const timeoutMs = this.#config.pollTimeoutMs ?? 300_000;
    const deadline = this.#now() + timeoutMs;
    const doFetch = this.#config.fetch;

    for (;;) {
      if (this.#config.signal?.aborted) {
        return this.#fail("cancelled", "轮询期间被中止");
      }
      if (this.#now() >= deadline) {
        this.#transition("expired", "poll_timeout");
        return { status: "expired", reason: "poll_timeout" };
      }

      let body: PollResponseBody;
      try {
        const result = await requestJson({
          method: "GET",
          url: this.#buildPollUrl(pollToken),
          fetch: doFetch,
          timeoutMs: this.#config.requestTimeoutMs ?? 10_000,
          signal: this.#config.signal,
          log: this.#config.log,
        });
        body = asObject(result.json);
      } catch (error) {
        return this.#failFromHttp(error, "轮询失败");
      }

      const status = body.status;
      if (status === "pending") {
        await abortableSleep(intervalMs, this.#config.signal);
        continue;
      }
      if (status === "expired") {
        this.#transition("expired", "server_expired");
        return { status: "expired", reason: "server_expired" };
      }
      if (status !== "success") {
        return this.#fail("protocol", `轮询响应 status 非法: ${String(status)}`);
      }

      this.#transition("exchange", "token_payload_received");
      // 直出模式：轮询直接带回令牌。
      if (typeof body.access_token === "string" && body.access_token !== "") {
        return this.#succeed(body, "token_received_directly");
      }
      // 授权码模式：code + verifier 换票。
      if (typeof body.code === "string" && body.code !== "") {
        let tokenBody: TokenResponseBody;
        try {
          const result = await requestJson({
            method: "POST",
            url: this.#endpoints.token,
            headers: { "content-type": "application/json" },
            body: {
              grant_type: "authorization_code",
              code: body.code,
              code_verifier: verifier,
              client_id: this.#config.clientId,
              redirect_uri: redirectUri,
            },
            fetch: doFetch,
            timeoutMs: this.#config.requestTimeoutMs ?? 10_000,
            signal: this.#config.signal,
            log: this.#config.log,
          });
          tokenBody = asObject(result.json);
        } catch (error) {
          return this.#failFromHttp(error, "授权码换票失败");
        }
        return this.#succeed(tokenBody, "authorization_code_exchanged");
      }
      return this.#fail("protocol", "轮询成功响应缺少 code/access_token");
    }
  }

  #buildPollUrl(pollToken: string): string {
    const url = new URL(this.#endpoints.poll);
    url.searchParams.set("poll_token", pollToken);
    return url.toString();
  }

  #succeed(body: TokenResponseBody, reason: string): OAuthOutcome {
    if (typeof body.access_token !== "string" || body.access_token === "") {
      return this.#fail("protocol", "令牌响应缺少 access_token");
    }
    if (
      body.token_use !== undefined &&
      body.token_use !== "project_access"
    ) {
      return this.#fail("protocol", `token_use 非法: 期望 project_access`);
    }
    const obtainedAt = this.#now();
    const expiresAt =
      typeof body.expires_in === "number" && Number.isFinite(body.expires_in) && body.expires_in > 0
        ? obtainedAt + body.expires_in * 1000
        : undefined;
    const credential: OAuthCredential = {
      accessToken: role("secret", body.access_token),
      ...(typeof body.refresh_token === "string" && body.refresh_token !== ""
        ? { refreshToken: role("secret", body.refresh_token) }
        : {}),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      obtainedAt,
    };
    this.#transition("success", reason);
    return { status: "success", credential };
  }

  #fail(kind: OAuthFailure["kind"], message: string): OAuthOutcome {
    this.#transition("error", kind);
    return { status: "error", failure: { kind, message } };
  }

  #failFromHttp(error: unknown, prefix: string): OAuthOutcome {
    if (error instanceof HttpRequestError) {
      this.#transition("error", error.kind);
      return {
        status: "error",
        failure: {
          kind: error.kind,
          message: `${prefix}: ${error.message}`,
          ...(error.status === undefined ? {} : { status: error.status }),
        },
      };
    }
    this.#transition("error", "network");
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      failure: { kind: "network", message: `${prefix}: ${message}` },
    };
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpRequestError("protocol", "响应 JSON 不是对象");
  }
  return value as Record<string, unknown>;
}
