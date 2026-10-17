/**
 * BI-02 · 极薄 fetch 封装 —— 超时、重试（仅幂等轮询）、响应脱敏日志。
 *
 * 零数据外泄红线：
 * - 本模块永不把端点响应原文写入日志，日志只含方法/脱敏 URL/状态码/脱敏标头/脱敏负载；
 * - token、authorization、api-key、poll_token、code、verifier 等敏感字段一律遮蔽。
 * 零外部依赖：仅用全局 fetch 与 node:timers/promises。
 */
import { setTimeout as delay } from "node:timers/promises";

/**
 * fetch 依赖注入签名（结构化最小面，与全局 fetch 兼容；测试注入内存 stub）。
 * 不直接用 typeof fetch：bun-types 的 fetch 带必选 preconnect 属性，stub 无法满足。
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const REDACTED = "[REDACTED]";

/** 敏感标头名集合（小写比较）。 */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-coding-plan-api-key",
]);

/** 敏感字段名匹配（标头之外的 URL query 与 JSON 负载键）。 */
const SENSITIVE_KEY_PATTERN =
  /token|secret|password|passphrase|api[-_]?key|credential|authorization|verifier|(^|[-_.])code([-_.]|$)|(^|[-_.])state([-_.]|$)/i;

/** 深度上限，防环防爆炸。 */
const MAX_REDACT_DEPTH = 8;

function maskIfSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/** 标头脱敏：敏感标头值替换为 [REDACTED]，键名统一小写。 */
export function redactHeaders(
  headers: Record<string, string> | Headers,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = SENSITIVE_HEADERS.has(key.toLowerCase())
        ? REDACTED
        : value;
    });
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    out[lower] = SENSITIVE_HEADERS.has(lower) ? REDACTED : value;
  }
  return out;
}

/** URL 脱敏：敏感 query 参数值遮蔽，其余保留。 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (maskIfSensitiveKey(key)) {
        parsed.searchParams.set(key, REDACTED);
      }
    }
    return parsed.toString();
  } catch {
    return "<unparsable-url>";
  }
}

/** JSON 负载深拷贝脱敏：敏感键下的字符串值替换为 [REDACTED]。 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) return "[depth-limit]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = maskIfSensitiveKey(key) ? REDACTED : redactValue(item, depth + 1);
  }
  return out;
}

/** 单条结构化日志行（已脱敏，可安全落盘）。 */
export interface HttpLogLine {
  readonly method: string;
  readonly url: string;
  readonly attempt: number;
  readonly status?: number;
  readonly requestHeaders?: Record<string, string>;
  readonly requestBody?: unknown;
  readonly note?: string;
}

export function formatLogLine(line: HttpLogLine): string {
  return JSON.stringify({
    ...line,
    url: redactUrl(line.url),
    requestHeaders: line.requestHeaders
      ? redactHeaders(line.requestHeaders)
      : undefined,
    requestBody: line.requestBody === undefined ? undefined : redactValue(line.requestBody),
  });
}

/** 请求级结构化错误：kind 稳定可编程判断，message 不含响应原文。 */
export class HttpRequestError extends Error {
  readonly kind: "network" | "http" | "protocol";
  readonly status?: number;
  /** 非 2xx 时的响应头（供 Retry-After 等元数据读取；不含响应正文）。 */
  readonly headers?: Headers;

  constructor(
    kind: HttpRequestError["kind"],
    message: string,
    options?: { status?: number; headers?: Headers; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = "HttpRequestError";
    this.kind = kind;
    this.status = options?.status;
    this.headers = options?.headers;
  }
}

export interface HttpJsonOptions {
  /** 请求方法，默认 "GET"。 */
  readonly method?: "GET" | "POST";
  readonly url: string;
  readonly headers?: Record<string, string>;
  /** JSON 负载，POST 时序列化发送。 */
  readonly body?: unknown;
  /** fetch 注入，缺省全局 fetch。 */
  readonly fetch?: FetchLike;
  /** 单次尝试超时（毫秒），默认 10_000。 */
  readonly timeoutMs?: number;
  /**
   * 重试次数，默认 0（不重试）。仅当调用方显式声明操作幂等（即轮询类 GET）
   * 时才允许设为 >0；对 5xx/429/网络错误按指数退避重试。
   */
  readonly retries?: number;
  /** 重试基础退避（毫秒），默认 200，按 2^attempt 指数增长。 */
  readonly backoffMs?: number;
  /** 外部取消信号。 */
  readonly signal?: AbortSignal;
  /** 脱敏日志宿（每行 JSON 已脱敏），缺省不记录。 */
  readonly log?: (line: string) => void;
}

export interface HttpJsonResult {
  readonly status: number;
  readonly json: unknown;
  readonly headers: Headers;
}

interface AttemptResult {
  status: number;
  headers: Headers;
  text: string;
}

function isAbortError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

/** 组合外部信号与单次尝试超时；返回的 cleanup 必须在 finally 中调用。 */
function linkSignals(
  controller: AbortController,
  outer: AbortSignal | undefined,
  timeoutMs: number,
): () => void {
  const timer = setTimeout(() => {
    controller.abort(namedError("timeout", "TimeoutError"));
  }, timeoutMs);
  const onOuterAbort = () => controller.abort(namedError("aborted", "AbortError"));
  if (outer) {
    if (outer.aborted) onOuterAbort();
    else outer.addEventListener("abort", onOuterAbort, { once: true });
  }
  return () => {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  };
}

function namedError(message: string, name: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** 可被 AbortSignal 提前唤醒的 sleep；被中止时静默返回（由调用方复查信号）。 */
export async function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (ms <= 0) return;
  try {
    await delay(ms, undefined, { signal });
  } catch {
    // 被中止：静默返回，调用方在下一轮循环检查 signal.aborted。
  }
}

/**
 * 发起 JSON 请求。2xx 返回解析后的 JSON；非 2xx 抛 HttpRequestError("http")；
 * 网络失败/超时/中止抛 HttpRequestError("network")；2xx 但正文非法 JSON 抛
 * HttpRequestError("protocol")。重试仅在 retries > 0（调用方声明幂等）时启用。
 */
export async function requestJson(
  options: HttpJsonOptions,
): Promise<HttpJsonResult> {
  const method = options.method ?? "GET";
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retries = options.retries ?? 0;
  const backoffMs = options.backoffMs ?? 200;
  const headers: Record<string, string> = {
    accept: "application/json",
    ...options.headers,
  };
  let bodyText: string | undefined;
  if (options.body !== undefined) {
    bodyText = JSON.stringify(options.body);
    headers["content-type"] = headers["content-type"] ?? "application/json";
  }

  for (let attempt = 0; ; attempt++) {
    let attemptResult: AttemptResult;
    try {
      attemptResult = await attemptOnce(doFetch, method, options, headers, bodyText, timeoutMs);
    } catch (error) {
      const classified = classifyAttemptError(error, options.url);
      options.log?.(
        formatLogLine({
          method,
          url: options.url,
          attempt,
          note: `attempt-failed:${classified.kind}:${classified.message}`,
        }),
      );
      if (!isRetryable(classified) || attempt >= retries) {
        throw classified;
      }
      await abortableSleep(backoffMs * 2 ** attempt, options.signal);
      continue;
    }

    options.log?.(
      formatLogLine({
        method,
        url: options.url,
        attempt,
        status: attemptResult.status,
        requestHeaders: headers,
      }),
    );

    if (attemptResult.status < 200 || attemptResult.status >= 300) {
      const error = new HttpRequestError(
        "http",
        `HTTP ${attemptResult.status} from ${redactUrl(options.url)}`,
        { status: attemptResult.status, headers: attemptResult.headers },
      );
      if (
        retries > 0 &&
        attempt < retries &&
        (attemptResult.status === 429 || attemptResult.status >= 500)
      ) {
        await abortableSleep(backoffMs * 2 ** attempt, options.signal);
        continue;
      }
      throw error;
    }

    if (attemptResult.text.trim() === "") {
      throw new HttpRequestError(
        "protocol",
        `空响应体 from ${redactUrl(options.url)}`,
        { status: attemptResult.status },
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(attemptResult.text);
    } catch (error) {
      throw new HttpRequestError(
        "protocol",
        `响应不是合法 JSON from ${redactUrl(options.url)}`,
        { cause: error },
      );
    }
    return { status: attemptResult.status, json, headers: attemptResult.headers };
  }
}

async function attemptOnce(
  doFetch: FetchLike,
  method: "GET" | "POST",
  options: HttpJsonOptions,
  headers: Record<string, string>,
  bodyText: string | undefined,
  timeoutMs: number,
): Promise<AttemptResult> {
  const controller = new AbortController();
  const cleanup = linkSignals(controller, options.signal, timeoutMs);
  try {
    const response = await doFetch(options.url, {
      method,
      headers,
      body: bodyText,
      signal: controller.signal,
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text };
  } finally {
    cleanup();
  }
}

function classifyAttemptError(error: unknown, url: string): HttpRequestError {
  if (error instanceof HttpRequestError) return error;
  if (isAbortError(error)) {
    const label = error.name === "TimeoutError" ? "请求超时" : "请求中止";
    return new HttpRequestError("network", `${label} from ${redactUrl(url)}`, {
      cause: error,
    });
  }
  return new HttpRequestError("network", `网络错误 from ${redactUrl(url)}`, {
    cause: error,
  });
}

function isRetryable(error: HttpRequestError): boolean {
  if (error.kind === "network") return true;
  if (error.kind === "http") {
    return error.status === 429 || (error.status !== undefined && error.status >= 500);
  }
  return false;
}
