/**
 * BI-02.4 · 赠送 Token 申领（Benefit Claim）。
 *
 * - previewGrants()：GET `{baseUrl}{previewPath}`（billing/preview 语义，path 注入）
 *   → [{ grantId, units, expiresAt }]；畸形响应抛结构化 BenefitClaimError。
 * - claim(grantId)：POST `{baseUrl}{claimPath}`（billing/claim 原子语义，body={grantId}），
 *   响应 { claimed, grantUnits }；重复 claim → 结构化 already_claimed（响应 claimed:false
 *   或 HTTP 409 均归一为该 kind，不抛异常）；grant 不存在（404）→ not_found。
 * - balance()：复用第二卡 BalanceMonitor（import，不修改；余额查询语义同源）。
 *
 * 零数据外泄红线：fetch 经 requestJson（./http）注入，本模块自身永不触网；
 * 日志只含脱敏行，grant 载荷与响应原文绝不落日志/错误消息。
 * 零外部依赖：仅注入 fetch。
 */
import { BalanceMonitor, type BalanceSnapshot } from "../gateway/balance-monitor";
import {
  HttpRequestError,
  requestJson,
  type FetchLike,
  type HttpJsonResult,
} from "./http";

/** 缺省基址（与既有 Coding Plan 端点同域；可注入覆盖）。 */
export const DEFAULT_BENEFIT_BASE_URL = "https://open.bigmodel.cn";
/** 缺省赠送额度预览路径（GET billing/preview 语义）。 */
export const DEFAULT_BENEFIT_PREVIEW_PATH = "/api/billing/preview";
/** 缺省赠送额度申领路径（POST billing/claim 原子语义）。 */
export const DEFAULT_BENEFIT_CLAIM_PATH = "/api/billing/claim";

/** 单笔可申领赠送额度预览。 */
export interface GrantPreview {
  readonly grantId: string;
  readonly units: number;
  /** 过期时间（epoch 毫秒）；缺省表示长期有效。 */
  readonly expiresAt?: number;
}

/** claim 失败/业务未成交分类（稳定字面量，供上层自愈分支）。 */
export type ClaimFailureKind =
  | "network"
  | "unauthorized"
  | "already_claimed"
  | "not_found"
  | "protocol";

export interface ClaimFailure {
  readonly kind: ClaimFailureKind;
  /** 脱敏 message，不含响应原文与凭据。 */
  readonly message: string;
  readonly status?: number;
}

export type ClaimOutcome =
  | {
      readonly ok: true;
      readonly claimed: true;
      /** 本次实际入账额度单位数。 */
      readonly grantUnits: number;
      readonly claimedAt: number;
    }
  | { readonly ok: false; readonly failure: ClaimFailure };

/** 赠送额度结构化错误：code 稳定可编程判断，message 不含响应原文。 */
export class BenefitClaimError extends Error {
  readonly code: "config" | "network" | "http" | "protocol";
  readonly status?: number;

  constructor(
    code: BenefitClaimError["code"],
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BenefitClaimError";
    this.code = code;
    this.status = options?.status;
  }
}

export interface BenefitClaimOptions {
  /** fetch 注入，缺省 globalThis.fetch（生产）；测试必须注入内存 stub。 */
  readonly fetchImpl?: FetchLike;
  /** 端点基址，缺省 DEFAULT_BENEFIT_BASE_URL。 */
  readonly baseUrl?: string;
  /** 预览路径（GET），缺省 DEFAULT_BENEFIT_PREVIEW_PATH。 */
  readonly previewPath?: string;
  /** 申领路径（POST），缺省 DEFAULT_BENEFIT_CLAIM_PATH。 */
  readonly claimPath?: string;
  /** 附加请求标头（如授权头；调用方注入）。 */
  readonly headers?: Record<string, string>;
  /** 单次请求超时（毫秒），缺省 10_000。 */
  readonly timeoutMs?: number;
  /** 脱敏日志宿。 */
  readonly log?: (line: string) => void;
  /** BalanceMonitor 注入（缺省按同 baseUrl/headers 构造；复用第二卡，不修改）。 */
  readonly balanceMonitor?: BalanceMonitor;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 解析预览响应：数组（或 { grants: [...] } 包裹）→ GrantPreview[]。 */
function parseGrants(json: unknown): GrantPreview[] {
  let raw: unknown = json;
  if (isObject(json) && "grants" in json) {
    raw = json.grants;
  }
  if (!Array.isArray(raw)) {
    throw new BenefitClaimError("protocol", "赠送额度预览响应不是数组");
  }
  const grants: GrantPreview[] = [];
  for (const item of raw) {
    if (!isObject(item)) {
      throw new BenefitClaimError("protocol", "赠送额度预览元素必须是对象");
    }
    const grantId = item.grantId ?? item.grant_id;
    if (typeof grantId !== "string" || grantId === "") {
      throw new BenefitClaimError("protocol", "赠送额度预览元素缺少 grantId");
    }
    const units = finiteNumber(item.units);
    if (units === undefined) {
      throw new BenefitClaimError("protocol", "赠送额度预览元素缺少数值型 units");
    }
    const expiresAt = finiteNumber(item.expiresAt ?? item.expires_at);
    grants.push(
      expiresAt === undefined
        ? { grantId, units }
        : { grantId, units, expiresAt },
    );
  }
  return grants;
}

/** 赠送 Token 申领服务（preview/claim/balance 三面）。 */
export class BenefitClaimService {
  readonly #fetchImpl: FetchLike | undefined;
  readonly #previewUrl: string;
  readonly #claimUrl: string;
  readonly #headers: Record<string, string> | undefined;
  readonly #timeoutMs: number;
  readonly #log: ((line: string) => void) | undefined;
  readonly #balanceMonitor: BalanceMonitor;

  constructor(options: BenefitClaimOptions = {}) {
    const baseUrl = options.baseUrl ?? DEFAULT_BENEFIT_BASE_URL;
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error(`unsupported protocol: ${parsed.protocol}`);
      }
    } catch (error) {
      throw new BenefitClaimError("config", "BenefitClaimService: baseUrl 须为合法 http(s) 绝对 URL", {
        cause: error,
      });
    }
    const root = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    const normalize = (p: string) => (p.startsWith("/") ? p : `/${p}`);
    this.#previewUrl = `${root}${normalize(options.previewPath ?? DEFAULT_BENEFIT_PREVIEW_PATH)}`;
    this.#claimUrl = `${root}${normalize(options.claimPath ?? DEFAULT_BENEFIT_CLAIM_PATH)}`;
    this.#fetchImpl = options.fetchImpl;
    this.#headers = options.headers;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#log = options.log;
    // 复用第二卡 BalanceMonitor（import，不修改）：缺省按同 baseUrl/headers 构造。
    this.#balanceMonitor =
      options.balanceMonitor ??
      new BalanceMonitor({
        fetchImpl: options.fetchImpl,
        baseUrl,
        headers: options.headers,
        timeoutMs: options.timeoutMs,
        log: options.log,
      });
  }

  /**
   * 预览可申领赠送额度：GET 预览端点 → [{ grantId, units, expiresAt }]。
   * 网络失败/非 2xx/非法形状 → 抛结构化 BenefitClaimError。
   */
  async previewGrants(signal?: AbortSignal): Promise<GrantPreview[]> {
    let result: HttpJsonResult;
    try {
      result = await requestJson({
        method: "GET",
        url: this.#previewUrl,
        headers: this.#headers,
        fetch: this.#fetchImpl,
        timeoutMs: this.#timeoutMs,
        signal,
        log: this.#log,
      });
    } catch (error) {
      throw this.#classify(error);
    }
    return parseGrants(result.json);
  }

  /**
   * 原子申领：POST 申领端点（body={grantId}）。
   * - 2xx 且 claimed:true → ok:true + grantUnits；
   * - 2xx 且 claimed:false 或 HTTP 409 → ok:false + already_claimed（业务常态，不抛异常）；
   * - HTTP 404 → not_found；网络失败 → network；其余形状/状态 → protocol。
   */
  async claim(grantId: string, signal?: AbortSignal): Promise<ClaimOutcome> {
    if (grantId.trim() === "") {
      throw new BenefitClaimError("config", "claim: grantId 不能为空");
    }
    const claimedAt = Date.now();
    let result: HttpJsonResult;
    try {
      result = await requestJson({
        method: "POST",
        url: this.#claimUrl,
        headers: this.#headers,
        body: { grantId },
        fetch: this.#fetchImpl,
        timeoutMs: this.#timeoutMs,
        signal,
        log: this.#log,
      });
    } catch (error) {
      if (error instanceof HttpRequestError && error.kind === "http") {
        if (error.status === 409) {
          return { ok: false, failure: { kind: "already_claimed", message: "已申领过该赠送额度", status: 409 } };
        }
        if (error.status === 404) {
          return { ok: false, failure: { kind: "not_found", message: "赠送额度不存在", status: 404 } };
        }
      }
      return { ok: false, failure: this.#classifyFailure(error) };
    }

    if (!isObject(result.json)) {
      return {
        ok: false,
        failure: { kind: "protocol", message: "申领响应不是 JSON 对象", status: result.status },
      };
    }
    const claimed = result.json.claimed;
    if (claimed === false) {
      return {
        ok: false,
        failure: { kind: "already_claimed", message: "已申领过该赠送额度", status: result.status },
      };
    }
    if (claimed !== true) {
      return {
        ok: false,
        failure: { kind: "protocol", message: "申领响应缺少 claimed 字段", status: result.status },
      };
    }
    const grantUnits = finiteNumber(result.json.grantUnits ?? result.json.grant_units);
    if (grantUnits === undefined) {
      return {
        ok: false,
        failure: { kind: "protocol", message: "申领响应缺少数值型 grantUnits", status: result.status },
      };
    }
    return { ok: true, claimed: true, grantUnits, claimedAt };
  }

  /**
   * 余额查询：复用第二卡 BalanceMonitor（GET billing/balance 语义）。
   * 错误面与 BalanceMonitorError 一致（network/http/protocol/config）。
   */
  async balance(signal?: AbortSignal): Promise<BalanceSnapshot> {
    return this.#balanceMonitor.query(signal);
  }

  #classify(error: unknown): BenefitClaimError {
    if (error instanceof BenefitClaimError) return error;
    if (error instanceof HttpRequestError) {
      if (error.kind === "http") {
        return new BenefitClaimError("http", `赠送额度请求失败: ${error.message}`, {
          status: error.status,
          cause: error,
        });
      }
      if (error.kind === "protocol") {
        return new BenefitClaimError("protocol", `赠送额度协议错误: ${error.message}`, {
          cause: error,
        });
      }
      return new BenefitClaimError("network", `赠送额度网络失败: ${error.message}`, {
        cause: error,
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    return new BenefitClaimError("network", `赠送额度网络失败: ${message}`, { cause: error });
  }

  #classifyFailure(error: unknown): ClaimFailure {
    if (error instanceof HttpRequestError) {
      if (error.kind === "http" && error.status === 401) {
        return { kind: "unauthorized", message: `凭据被拒绝: ${error.message}`, status: 401 };
      }
      if (error.kind === "http") {
        return {
          kind: "protocol",
          message: `非预期状态码: ${error.message}`,
          ...(error.status === undefined ? {} : { status: error.status }),
        };
      }
      if (error.kind === "protocol") {
        return { kind: "protocol", message: error.message };
      }
      return { kind: "network", message: `网络失败: ${error.message}` };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "network", message: `网络失败: ${message}` };
  }
}
