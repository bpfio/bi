/**
 * BI-02.2 · 轻量余额查询（GET billing/balance 语义）+ 即将过期额度优先选择函数。
 *
 * - BalanceMonitor.query()：GET `{baseUrl}{path}`（path 注入），响应 canonical 形状
 *   `{ balance, grants?: [{ units, expires_at? }] }` → `{ balance, grants: [{ units, expiresAt? }] }`；
 *   畸形响应抛结构化 BalanceMonitorError（协议/网络/HTTP 分类），响应原文不进错误。
 * - pickGrant(grants, now)：优先抵扣即将过期额度——expiresAt 最近优先；无过期时间
 *   （长期额度）排最后；已过期（expiresAt <= now）跳过；同 expiresAt 保持输入顺序（稳定）。
 *
 * 零数据外泄红线：fetch 经 requestJson（../auth/http）注入，本模块自身永不触网；
 * 生产缺省才落 globalThis.fetch，测试必须注入内存 stub；日志只含脱敏行。
 * 零外部依赖：仅注入 fetch。
 */
import {
  HttpRequestError,
  requestJson,
  type FetchLike,
  type HttpJsonResult,
} from "../auth/http";

/** 复用既有专线入口常量（与本包 Ultra 端点同域，语义一致不改值）。 */
import { DEFAULT_ULTRA_BASE_URL } from "./ultra-gateway";

/** 缺省余额查询路径（语义注入；测试一律注入 stub 路径，不触网）。 */
export const DEFAULT_BALANCE_PATH = "/api/billing/balance";

/** 单笔余额授予（额度包）。 */
export interface BalanceGrant {
  /** 授予额度单位数。 */
  readonly units: number;
  /** 过期时间（epoch 毫秒）；缺省表示长期有效。 */
  readonly expiresAt?: number;
}

/** 余额快照。 */
export interface BalanceSnapshot {
  /** 当前可用余额（单位数）。 */
  readonly balance: number;
  /** 授予明细（缺省空表）。 */
  readonly grants: BalanceGrant[];
}

/** 余额查询结构化错误：code 稳定可编程判断，message 不含响应原文与凭据。 */
export class BalanceMonitorError extends Error {
  readonly code: "config" | "network" | "http" | "protocol";
  readonly status?: number;

  constructor(
    code: BalanceMonitorError["code"],
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BalanceMonitorError";
    this.code = code;
    this.status = options?.status;
  }
}

export interface BalanceMonitorOptions {
  /** fetch 注入，缺省 globalThis.fetch（生产）；测试必须注入内存 stub。 */
  readonly fetchImpl?: FetchLike;
  /** 余额端点基址，缺省 DEFAULT_ULTRA_BASE_URL。 */
  readonly baseUrl?: string;
  /** 余额端点路径，缺省 DEFAULT_BALANCE_PATH。 */
  readonly path?: string;
  /** 附加请求标头（如授权头；调用方注入）。 */
  readonly headers?: Record<string, string>;
  /** 单次请求超时（毫秒），缺省 10_000。 */
  readonly timeoutMs?: number;
  /** 幂等 GET 重试次数，缺省 1（429/5xx/网络错误指数退避重试）。 */
  readonly retries?: number;
  /** 脱敏日志宿。 */
  readonly log?: (line: string) => void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 解析余额响应：balance 必填有限数；grants 可选数组，元素 units 必填。 */
function parseBalanceSnapshot(json: unknown): BalanceSnapshot {
  if (!isObject(json)) {
    throw new BalanceMonitorError("protocol", "余额响应不是 JSON 对象");
  }
  const balance = finiteNumber(json.balance);
  if (balance === undefined) {
    throw new BalanceMonitorError("protocol", "余额响应缺少数值型 balance");
  }
  const rawGrants = json.grants ?? [];
  if (!Array.isArray(rawGrants)) {
    throw new BalanceMonitorError("protocol", "余额响应 grants 必须为数组");
  }
  const grants: BalanceGrant[] = [];
  for (const item of rawGrants) {
    if (!isObject(item)) {
      throw new BalanceMonitorError("protocol", "余额响应 grants 元素必须是对象");
    }
    const units = finiteNumber(item.units);
    if (units === undefined) {
      throw new BalanceMonitorError("protocol", "余额响应 grants 元素缺少数值型 units");
    }
    const expiresAt = finiteNumber(item.expiresAt ?? item.expires_at);
    grants.push(
      expiresAt === undefined ? { units } : { units, expiresAt },
    );
  }
  return { balance, grants };
}

/**
 * 优先抵扣即将过期额度的选择函数：
 * - 已过期（expiresAt <= now）的授予跳过（不可用）；
 * - 有过期时间的授予按 expiresAt 升序取最近（即将过期优先）；
 * - 无过期时间（长期）排最后；
 * - 同 expiresAt 保持输入顺序（稳定选择，先出现者优先）；
 * - 空表或全部不可用返回 undefined。
 */
export function pickGrant(
  grants: readonly BalanceGrant[],
  now: number,
): BalanceGrant | undefined {
  let best: BalanceGrant | undefined;
  let bestKey = Number.POSITIVE_INFINITY;
  for (const grant of grants) {
    if (grant.expiresAt !== undefined && grant.expiresAt <= now) continue;
    const key = grant.expiresAt ?? Number.POSITIVE_INFINITY;
    if (best === undefined || key < bestKey) {
      best = grant;
      bestKey = key;
    }
  }
  return best;
}

/** 轻量余额查询器（GET billing/balance 语义；auth 域 BenefitClaim 将复用本类）。 */
export class BalanceMonitor {
  readonly #fetchImpl: FetchLike | undefined;
  readonly #url: string;
  readonly #headers: Record<string, string> | undefined;
  readonly #timeoutMs: number;
  readonly #retries: number;
  readonly #log: ((line: string) => void) | undefined;

  constructor(options: BalanceMonitorOptions = {}) {
    const baseUrl = options.baseUrl ?? DEFAULT_ULTRA_BASE_URL;
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error(`unsupported protocol: ${parsed.protocol}`);
      }
    } catch (error) {
      throw new BalanceMonitorError("config", "BalanceMonitor: baseUrl 须为合法 http(s) 绝对 URL", {
        cause: error,
      });
    }
    const path = options.path ?? DEFAULT_BALANCE_PATH;
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    this.#url = `${baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl}${normalizedPath}`;
    this.#fetchImpl = options.fetchImpl;
    this.#headers = options.headers;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#retries = options.retries ?? 1;
    this.#log = options.log;
  }

  /**
   * 查询余额：GET 余额端点，成功返回归一化快照；
   * 网络失败/超时 → network；非 2xx → http（带 status）；非法形状 → protocol。
   */
  async query(signal?: AbortSignal): Promise<BalanceSnapshot> {
    let result: HttpJsonResult;
    try {
      result = await requestJson({
        method: "GET",
        url: this.#url,
        headers: this.#headers,
        fetch: this.#fetchImpl,
        timeoutMs: this.#timeoutMs,
        retries: this.#retries,
        signal,
        log: this.#log,
      });
    } catch (error) {
      throw this.#classify(error);
    }
    return parseBalanceSnapshot(result.json);
  }

  #classify(error: unknown): BalanceMonitorError {
    if (error instanceof BalanceMonitorError) return error;
    if (error instanceof HttpRequestError) {
      if (error.kind === "http") {
        return new BalanceMonitorError("http", `余额查询失败: ${error.message}`, {
          status: error.status,
          cause: error,
        });
      }
      if (error.kind === "protocol") {
        return new BalanceMonitorError("protocol", `余额查询协议错误: ${error.message}`, {
          cause: error,
        });
      }
      return new BalanceMonitorError("network", `余额查询网络失败: ${error.message}`, {
        cause: error,
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    return new BalanceMonitorError("network", `余额查询网络失败: ${message}`, { cause: error });
  }
}
