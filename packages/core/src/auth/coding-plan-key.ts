/**
 * BI-02 · 通道二 —— Coding Plan API Key 二阶段换票器。
 *
 * 输入 API Key，调用换票端点换取 `token_use: "project_access"` 的短期 PAT。
 * 失败按四类结构化返回供上层自愈（对齐 failure-classifier 语义）：
 * - network      网络/超时/中止（fetch 抛错）
 * - unauthorized 401（凭据无效）
 * - rate_limited 429（附 Retry-After 换算的 retryAfterMs）
 * - protocol     其余 HTTP 状态码、非法 JSON、响应形状/token_use 不符
 *
 * 零数据外泄：fetch 依赖注入；API Key 与 PAT 只在 Authorization 头与
 * 返回值中出现，日志经 http 层脱敏。
 */
import {
  HttpRequestError,
  redactUrl,
  requestJson,
  type FetchLike,
  type HttpJsonResult,
} from "./http";
import { role, type Secret } from "./types";

/** 默认换票端点（可注入覆盖；测试一律注入 stub，不触网）。 */
export const DEFAULT_CODING_PLAN_EXCHANGE_ENDPOINT =
  "https://open.bigmodel.cn/api/coding-plan/exchange";

/** 失败四分类（稳定字面量，供上层自愈分支）。 */
export type ExchangeFailureKind =
  | "network"
  | "unauthorized"
  | "rate_limited"
  | "protocol";

export interface ExchangeFailure {
  readonly kind: ExchangeFailureKind;
  /** 脱敏 message，不含响应原文与凭据。 */
  readonly message: string;
  readonly status?: number;
  /** 仅 rate_limited：由 Retry-After 换算的建议等待毫秒。 */
  readonly retryAfterMs?: number;
}

export type ExchangeOutcome =
  | {
      readonly ok: true;
      /** 短期 Project Access Token（role("secret") 标记）。 */
      readonly pat: Secret;
      /** 过期时间（epoch 毫秒），由 expires_in 推算。 */
      readonly expiresAt?: number;
      readonly obtainedAt: number;
    }
  | { readonly ok: false; readonly failure: ExchangeFailure };

export interface CodingPlanKeyExchangerConfig {
  readonly endpoint?: string;
  /** fetch 注入（测试注入内存 stub，严禁真实调用）。 */
  readonly fetch?: FetchLike;
  /** 单次请求超时（毫秒），默认 10_000。 */
  readonly timeoutMs?: number;
  readonly now?: () => number;
  /** 脱敏日志宿。 */
  readonly log?: (line: string) => void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRetryAfterMs(
  headerValue: string | null | undefined,
  now: number,
): number | undefined {
  if (headerValue === null || headerValue === undefined || headerValue.trim() === "") {
    return undefined;
  }
  const seconds = Number(headerValue.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const dateMs = Date.parse(headerValue);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - now);
  }
  return undefined;
}

/** API Key 二阶段换票器。 */
export class CodingPlanKeyExchanger {
  readonly #endpoint: string;
  readonly #fetch: FetchLike | undefined;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #log: ((line: string) => void) | undefined;

  constructor(config: CodingPlanKeyExchangerConfig = {}) {
    this.#endpoint = config.endpoint ?? DEFAULT_CODING_PLAN_EXCHANGE_ENDPOINT;
    this.#fetch = config.fetch;
    this.#timeoutMs = config.timeoutMs ?? 10_000;
    this.#now = config.now ?? Date.now;
    this.#log = config.log;
  }

  /**
   * 阶段一：API Key 作为持有者凭据请求换票端点；
   * 阶段二：校验响应为 token_use=project_access 的短期 PAT。
   * 成功返回 ok=true + PAT；失败返回 ok=false + 四类结构化错误（不抛异常）。
   */
  async exchange(apiKey: Secret, signal?: AbortSignal): Promise<ExchangeOutcome> {
    const obtainedAt = this.#now();
    let result: HttpJsonResult;
    try {
      result = await requestJson({
        method: "POST",
        url: this.#endpoint,
        headers: { authorization: `Bearer ${apiKey}` },
        body: {},
        fetch: this.#fetch,
        timeoutMs: this.#timeoutMs,
        signal,
        log: this.#log,
      });
    } catch (error) {
      return { ok: false, failure: this.#classify(error) };
    }

    if (!isObject(result.json)) {
      return {
        ok: false,
        failure: { kind: "protocol", message: "换票响应 JSON 不是对象", status: result.status },
      };
    }
    const accessToken = result.json.access_token;
    if (typeof accessToken !== "string" || accessToken === "") {
      return {
        ok: false,
        failure: { kind: "protocol", message: "换票响应缺少 access_token", status: result.status },
      };
    }
    if (result.json.token_use !== "project_access") {
      return {
        ok: false,
        failure: {
          kind: "protocol",
          message: "token_use 非法：期望 project_access",
          status: result.status,
        },
      };
    }
    const expiresIn = result.json.expires_in;
    const expiresAt =
      typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
        ? obtainedAt + expiresIn * 1000
        : undefined;
    return {
      ok: true,
      pat: role("secret", accessToken),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      obtainedAt,
    };
  }

  #classify(error: unknown): ExchangeFailure {
    if (error instanceof HttpRequestError) {
      if (error.kind === "http" && error.status === 401) {
        return { kind: "unauthorized", message: `凭据被拒绝: ${error.message}`, status: 401 };
      }
      if (error.kind === "http" && error.status === 429) {
        const retryAfterMs = parseRetryAfterMs(
          error.headers?.get("retry-after"),
          this.#now(),
        );
        return {
          kind: "rate_limited",
          message: `触发频控: ${error.message}`,
          status: 429,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        };
      }
      if (error.kind === "protocol") {
        return { kind: "protocol", message: error.message };
      }
      if (error.kind === "http") {
        return {
          kind: "protocol",
          message: `非预期状态码: ${error.message}`,
          ...(error.status === undefined ? {} : { status: error.status }),
        };
      }
      return { kind: "network", message: `网络失败: ${error.message}` };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "network", message: `网络失败: ${message}` };
  }
}

/** 导出给测试与上层：脱敏 URL 工具复用入口。 */
export { redactUrl };
