/**
 * BI-02.3 · 闲时任务取号客户端（POST /ticket 语义）。
 *
 * - submit(payload)：POST `{baseUrl}{submitPath}`，body=payload，响应取 { ticketId }
 *   （兼容 ticket_id snake_case；缺失 → 结构化 protocol 错误）。
 * - pollStatus(ticketId)：GET `{baseUrl}{statusPath}/{encodeURIComponent(ticketId)}`，
 *   归一化 → { status: 'queued'|'schedulable'|'done'|'expired'|'failed', result?, reason? }。
 * - 3102 超时语义：响应体错误码（顶层 code 或嵌套 error.code）== 3102 → 归一为
 *   'expired'，并触发注入的 reTicket 通知回调（仅通知，不代替上层重新取号——
 *   真正的 re-ticket 回路由上层 OffPeakService 状态机驱动，避免双取号）；
 *   其他错误码 → 'failed'（附脱敏 reason）。
 *
 * 零数据外泄红线：fetch 经 requestJson（../auth/http）注入，本模块自身永不触网；
 * 日志只含脱敏行，payload 与响应原文绝不落日志/错误消息。
 * 零外部依赖：仅注入 fetch。
 */
import {
  HttpRequestError,
  requestJson,
  type FetchLike,
  type HttpJsonResult,
} from "../auth/http";

/** 缺省基址（与既有 Coding Plan 端点同域；可注入覆盖）。 */
export const DEFAULT_OFF_PEAK_BASE_URL = "https://open.bigmodel.cn";
/** 缺省取号路径（POST submit 语义）。 */
export const DEFAULT_OFF_PEAK_SUBMIT_PATH = "/api/off-peak/ticket";
/** 缺省状态查询路径前缀（GET `${statusPath}/${ticketId}` 语义）。 */
export const DEFAULT_OFF_PEAK_STATUS_PATH = "/api/off-peak/ticket";

/** 上游「排队超时」错误码：归一为 expired。 */
export const OFF_PEAK_TIMEOUT_CODE = 3102;

/** 票据状态（归一化后的稳定字面量）。 */
export type OffPeakTicketStatus = "queued" | "schedulable" | "done" | "expired" | "failed";

/** pollStatus 归一化结果。 */
export interface OffPeakStatusResult {
  readonly status: OffPeakTicketStatus;
  /** 仅 done/schedulable：服务端附带的结果载荷（原样透传，本模块不解析）。 */
  readonly result?: unknown;
  /** 仅 failed：脱敏原因（如 `upstream_code:3200`），不含响应原文。 */
  readonly reason?: string;
}

/** 取号客户端结构化错误：code 稳定可编程判断，message 不含响应原文。 */
export class OffPeakClientError extends Error {
  readonly code: "config" | "network" | "http" | "protocol";
  readonly status?: number;

  constructor(
    code: OffPeakClientError["code"],
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OffPeakClientError";
    this.code = code;
    this.status = options?.status;
  }
}

export interface OffPeakClientOptions {
  /** fetch 注入，缺省 globalThis.fetch（生产）；测试必须注入内存 stub。 */
  readonly fetchImpl?: FetchLike;
  /** 端点基址，缺省 DEFAULT_OFF_PEAK_BASE_URL。 */
  readonly baseUrl?: string;
  /** 取号路径（POST submit），缺省 DEFAULT_OFF_PEAK_SUBMIT_PATH。 */
  readonly submitPath?: string;
  /** 状态查询路径前缀（GET `${statusPath}/${ticketId}`），缺省 DEFAULT_OFF_PEAK_STATUS_PATH。 */
  readonly statusPath?: string;
  /**
   * 3102 → expired 时触发的重新取号通知回调（注入；仅通知，不执行取号）。
   * 上层 OffPeakService 依据 expired 状态自行驱动 re-ticket。
   */
  readonly reTicket?: (ticketId: string) => void | Promise<void>;
  /** 附加请求标头（如授权头；调用方注入）。 */
  readonly headers?: Record<string, string>;
  /** 单次请求超时（毫秒），缺省 10_000。 */
  readonly timeoutMs?: number;
  /** 脱敏日志宿。 */
  readonly log?: (line: string) => void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TICKET_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "schedulable",
  "done",
  "expired",
  "failed",
]);

/** 从响应体提取错误码：顶层 code 或嵌套 error.code（数值型）。 */
function extractErrorCode(json: unknown): number | undefined {
  if (!isObject(json)) return undefined;
  if (typeof json.code === "number") return json.code;
  if (isObject(json.error) && typeof json.error.code === "number") {
    return json.error.code;
  }
  return undefined;
}

/** 取号客户端（submit/pollStatus；3102 超时语义）。 */
export class OffPeakClient {
  readonly #fetchImpl: FetchLike | undefined;
  readonly #baseUrl: string;
  readonly #submitPath: string;
  readonly #statusPath: string;
  readonly #reTicket: ((ticketId: string) => void | Promise<void>) | undefined;
  readonly #headers: Record<string, string> | undefined;
  readonly #timeoutMs: number;
  readonly #log: ((line: string) => void) | undefined;

  constructor(options: OffPeakClientOptions = {}) {
    const baseUrl = options.baseUrl ?? DEFAULT_OFF_PEAK_BASE_URL;
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error(`unsupported protocol: ${parsed.protocol}`);
      }
    } catch (error) {
      throw new OffPeakClientError("config", "OffPeakClient: baseUrl 须为合法 http(s) 绝对 URL", {
        cause: error,
      });
    }
    this.#baseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    const normalize = (p: string) => (p.startsWith("/") ? p : `/${p}`);
    this.#submitPath = normalize(options.submitPath ?? DEFAULT_OFF_PEAK_SUBMIT_PATH);
    this.#statusPath = normalize(options.statusPath ?? DEFAULT_OFF_PEAK_STATUS_PATH);
    this.#reTicket = options.reTicket;
    this.#fetchImpl = options.fetchImpl;
    this.#headers = options.headers;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#log = options.log;
  }

  /**
   * 取号：POST `{baseUrl}{submitPath}`，body=payload；
   * 成功返回 ticketId；非 2xx/网络失败/缺 ticketId → 结构化错误。
   */
  async submit(payload: unknown, signal?: AbortSignal): Promise<string> {
    let result: HttpJsonResult;
    try {
      result = await requestJson({
        method: "POST",
        url: `${this.#baseUrl}${this.#submitPath}`,
        headers: this.#headers,
        body: payload,
        fetch: this.#fetchImpl,
        timeoutMs: this.#timeoutMs,
        signal,
        log: this.#log,
      });
    } catch (error) {
      throw this.#classify(error);
    }
    if (!isObject(result.json)) {
      throw new OffPeakClientError("protocol", "取号响应不是 JSON 对象", { status: result.status });
    }
    const ticketId = result.json.ticketId ?? result.json.ticket_id;
    if (typeof ticketId !== "string" || ticketId === "") {
      throw new OffPeakClientError("protocol", "取号响应缺少 ticketId", { status: result.status });
    }
    return ticketId;
  }

  /**
   * 查询票据状态：GET `{baseUrl}{statusPath}/{ticketId}`。
   * - 3102（体错误码，顶层或嵌套 error.code）→ { status:'expired' } 并触发 reTicket 通知；
   * - 其他体错误码 → { status:'failed', reason:'upstream_code:<n>' }；
   * - 未知 status 字面量 → protocol 错误；非 2xx/网络失败 → 对应结构化错误。
   */
  async pollStatus(ticketId: string, signal?: AbortSignal): Promise<OffPeakStatusResult> {
    if (ticketId.trim() === "") {
      throw new OffPeakClientError("config", "pollStatus: ticketId 不能为空");
    }
    const url = `${this.#baseUrl}${this.#statusPath}/${encodeURIComponent(ticketId)}`;
    let result: HttpJsonResult;
    try {
      result = await requestJson({
        method: "GET",
        url,
        headers: this.#headers,
        fetch: this.#fetchImpl,
        timeoutMs: this.#timeoutMs,
        signal,
        log: this.#log,
      });
    } catch (error) {
      throw this.#classify(error);
    }

    if (!isObject(result.json)) {
      throw new OffPeakClientError("protocol", "票据状态响应不是 JSON 对象", {
        status: result.status,
      });
    }

    const errorCode = extractErrorCode(result.json);
    if (errorCode === OFF_PEAK_TIMEOUT_CODE) {
      // 3102 超时语义：归一 expired + 通知注入回调（回调异常不影响归一结果）。
      try {
        await this.#reTicket?.(ticketId);
      } catch (error) {
        this.#log?.(
          JSON.stringify({
            method: "GET",
            url,
            note: `reTicket-notify-failed:${error instanceof Error ? error.name : "unknown"}`,
          }),
        );
      }
      return { status: "expired" };
    }
    if (errorCode !== undefined) {
      return { status: "failed", reason: `upstream_code:${errorCode}` };
    }

    const status = result.json.status;
    if (typeof status !== "string" || !TICKET_STATUSES.has(status)) {
      throw new OffPeakClientError("protocol", "票据状态响应缺少合法 status 字段", {
        status: result.status,
      });
    }
    const normalized: OffPeakStatusResult = { status: status as OffPeakTicketStatus };
    if (result.json.result !== undefined) {
      return { ...normalized, result: result.json.result };
    }
    return normalized;
  }

  #classify(error: unknown): OffPeakClientError {
    if (error instanceof OffPeakClientError) return error;
    if (error instanceof HttpRequestError) {
      if (error.kind === "http") {
        return new OffPeakClientError("http", `闲时取号请求失败: ${error.message}`, {
          status: error.status,
          cause: error,
        });
      }
      if (error.kind === "protocol") {
        return new OffPeakClientError("protocol", `闲时取号协议错误: ${error.message}`, {
          cause: error,
        });
      }
      return new OffPeakClientError("network", `闲时取号网络失败: ${error.message}`, {
        cause: error,
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    return new OffPeakClientError("network", `闲时取号网络失败: ${message}`, { cause: error });
  }
}
