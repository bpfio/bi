/**
 * BI-02.1 · Ultra VIP 专线路由网关 —— 常规路径重写为专线形态 + 指纹标头注入 + 失败分类。
 *
 * - routeUltra：把常规上游路径（如 `/v1/messages`）重写为专线形态
 *   `<baseUrl>/api/v1/ultra/anthropic/v1/messages`；通用规则=网关挂载 `/api/<版本>`
 *   并在版本段前插入 `/ultra/anthropic`，规则表可经构造注入扩展（注入即全量替换，
 *   可用 DEFAULT_ULTRA_ROUTE_RULES 组合）；未知路径原样返回并附 routed:false
 *   （RoutedUrl 只读标记）；已含 `/ultra/anthropic` 段的路径原样返回且 routed:true（幂等）。
 * - send：fingerprint 标头 + 调用方请求标头（授权标头由调用方传入）合并后，经注入
 *   fetch 发往 routeUltra 结果；2xx 返回 { status, headers(脱敏后), bodyText }；
 *   非 2xx 抛结构化错误 { code:'http', status }（响应正文绝不进错误）；网络错误/中止
 *   → { code:'network'|'timeout' }（外部 AbortSignal 可经 options.signal 注入，
 *   中止统一归 timeout——卡面错误面仅三码）。
 * - classifyFailure：401/403→auth、429→rate_limited、5xx→server、其余→protocol（供上层自愈）。
 *
 * 零数据外泄红线：
 * - fetch 全量注入，本模块自身永不触网；生产缺省才落 globalThis.fetch；
 * - 日志行仅含 method/url/status/脱敏后指纹三标头/note（ze-***last4），绝不包含
 *   凭据原文与响应正文；错误消息只含方法/路径/状态码。
 * 零外部依赖：node:crypto + fetch 注入。
 */
import { randomBytes } from "node:crypto";

import type { Secret } from "../auth/types";
import { buildFingerprintHeaders, redactFingerprint } from "./fingerprint";

/**
 * fetch 依赖注入签名（与 ../auth/http 的 FetchLike 同形。不直接用 typeof fetch：
 * bun-types 的 fetch 带必选 preconnect 属性，测试 stub 无法满足）。
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** 缺省专线入口：与本包既有 Coding Plan 端点同域（open.bigmodel.cn），可注入覆盖。 */
export const DEFAULT_ULTRA_BASE_URL = "https://open.bigmodel.cn";

/** 失败分类（供上层自愈）。 */
export type UltraFailureKind = "auth" | "rate_limited" | "server" | "protocol";

/**
 * 失败状态分类：401/403→'auth'、429→'rate_limited'、5xx→'server'、其余→'protocol'。
 * 卡面为全函数映射；调用方应仅对失败状态（非 2xx）调用。
 */
export function classifyFailure(status: number): UltraFailureKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status >= 500 && status < 600) return "server";
  return "protocol";
}

/** send 失败/构造误用的结构化错误：code 稳定可编程判断，message 不含凭据与响应正文。 */
export class UltraGatewayError extends Error {
  readonly code: "network" | "timeout" | "http" | "config";
  readonly status?: number;

  constructor(
    code: UltraGatewayError["code"],
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "UltraGatewayError";
    this.code = code;
    this.status = options?.status;
  }
}

/** routeUltra 返回形态：URL + routed 只读标记（true=专线形态；false=未知路径原样）。 */
export type RoutedUrl = URL & { readonly routed: boolean };

/** 专线重写规则。 */
export interface UltraRouteRule {
  readonly name: string;
  /** 匹配规范化 pathname（以 / 开头，不含查询串）。禁止 g 标志（exec 有状态）。 */
  readonly pattern: RegExp;
  readonly rewrite: (pathname: string, match: RegExpExecArray) => string;
}

/** 版本段：/v1、/v2/…（段边界用前瞻锚定，避免误吞 /v10abc 之类）。 */
const VERSION_PREFIX_PATTERN = /^\/(v\d+)(?=\/|$)/;

/** 已是专线形态的判定：路径中含 `/ultra/anthropic` 段（幂等短路）。 */
const ULTRA_SEGMENT_PATTERN = /\/ultra\/anthropic(?=\/|$)/;

/**
 * 缺省规则表：常规 `/v1/messages` → `/api/v1/ultra/anthropic/v1/messages`。
 * 通用规则=`/api/<命中版本>` + `/ultra/anthropic`（插在版本段前）+ 原路径。
 * 扩展方式：构造注入 `rules: [...DEFAULT_ULTRA_ROUTE_RULES, myRule]`（全量替换语义）。
 */
export const DEFAULT_ULTRA_ROUTE_RULES: readonly UltraRouteRule[] = [
  {
    name: "anthropic-version-mount",
    pattern: VERSION_PREFIX_PATTERN,
    rewrite: (pathname, match) => {
      const version = match[1];
      return version === undefined ? pathname : `/api/${version}/ultra/anthropic${pathname}`;
    },
  },
];

/** send 入参（body 为已序列化文本，网关不做隐式 JSON 化）。 */
export interface UltraRequest {
  readonly method: string;
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

/** send 成功返回：headers 已做指纹脱敏（三标头 ze-***last4），可安全进日志。 */
export interface UltraResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly bodyText: string;
}

export interface UltraSendOptions {
  /** 外部取消/超时信号（AbortSignal 注入）：中止统一按 timeout 归类。 */
  readonly signal?: AbortSignal;
  /** 脱敏日志宿：每行 JSON 仅含 method/url/status/脱敏指纹三标头/note。 */
  readonly log?: (line: string) => void;
}

export interface UltraGatewayOptions {
  /** fetch 注入，缺省 globalThis.fetch（生产）；测试必须注入内存 stub。 */
  readonly fetchImpl?: FetchLike;
  /** 专线入口，缺省 DEFAULT_ULTRA_BASE_URL；末尾多余 "/" 会被剥掉。 */
  readonly baseUrl?: string;
  /** 时钟注入（缺省 Date.now）：参与缺省 traceId 的时间前缀与耗时统计。 */
  readonly now?: () => number;
  /** 规则表注入（全量替换），缺省 DEFAULT_ULTRA_ROUTE_RULES。 */
  readonly rules?: readonly UltraRouteRule[];
  /** 指纹 User-Agent 覆盖，缺省 fingerprint 模块默认值。 */
  readonly userAgent?: string;
  /** traceId 生成器注入（确定性可测），缺省「8B 注入时钟 + 8B 随机」hex。 */
  readonly traceIdGenerator?: () => string;
}

export class UltraGateway {
  readonly #fetchImpl: FetchLike;
  readonly #baseUrl: string;
  readonly #now: () => number;
  readonly #rules: readonly UltraRouteRule[];
  readonly #userAgent: string | undefined;
  readonly #traceIdGenerator: () => string;

  constructor(options: UltraGatewayOptions = {}) {
    const baseUrl = options.baseUrl ?? DEFAULT_ULTRA_BASE_URL;
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error(`unsupported protocol: ${parsed.protocol}`);
      }
    } catch (error) {
      throw new UltraGatewayError("config", "UltraGateway: baseUrl 须为合法 http(s) 绝对 URL", {
        cause: error,
      });
    }
    this.#baseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#rules = options.rules ?? DEFAULT_ULTRA_ROUTE_RULES;
    this.#userAgent = options.userAgent;
    this.#traceIdGenerator = options.traceIdGenerator ?? (() => this.#defaultTraceId());
  }

  /** 缺省 traceId：8 字节注入时钟（epoch ms，大端，时间可排序）+ 8 字节随机，共 16 字节 hex。 */
  #defaultTraceId(): string {
    const buffer = randomBytes(16);
    const epochMs = BigInt(Math.max(0, Math.floor(this.#now())));
    buffer.writeBigUInt64BE(epochMs, 0);
    return buffer.toString("hex");
  }

  /**
   * 常规路径 → 专线 URL：
   * - 已含 `/ultra/anthropic` 段：原样返回，routed:true（幂等短路）；
   * - 命中规则表：重写为专线形态，routed:true；
   * - 未知路径：原样返回，routed:false（附标记说明，交由上层决策）。
   * 查询串原样保留；缺前导 `/` 自动补齐。
   */
  routeUltra(target: { path: string }): RoutedUrl {
    const raw = target.path;
    if (raw.trim() === "") {
      throw new UltraGatewayError("config", "routeUltra: path 不能为空");
    }
    const queryIndex = raw.indexOf("?");
    const pathPart = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
    const queryPart = queryIndex === -1 ? "" : raw.slice(queryIndex);
    const pathname = pathPart.startsWith("/") ? pathPart : `/${pathPart}`;

    let routedPath: string;
    let routed: boolean;
    if (ULTRA_SEGMENT_PATTERN.test(pathname)) {
      routedPath = pathname;
      routed = true;
    } else {
      const match = this.#firstRuleMatch(pathname);
      if (match === undefined) {
        routedPath = pathname;
        routed = false;
      } else {
        routedPath = match.rewritten;
        routed = true;
      }
    }

    let url: URL;
    try {
      url = new URL(`${this.#baseUrl}${routedPath}${queryPart}`);
    } catch (error) {
      throw new UltraGatewayError("config", "routeUltra: 路径含非法字符，无法拼装 URL", {
        cause: error,
      });
    }
    const routedUrl = url as RoutedUrl;
    Object.defineProperty(routedUrl, "routed", { value: routed, enumerable: false });
    return routedUrl;
  }

  #firstRuleMatch(pathname: string): { rewritten: string } | undefined {
    for (const rule of this.#rules) {
      const match = rule.pattern.exec(pathname);
      if (match !== null) {
        return { rewritten: rule.rewrite(pathname, match) };
      }
    }
    return undefined;
  }

  /**
   * 发送专线请求。指纹标头最后落位（通道身份不可被请求标头覆盖）；
   * 2xx 返回 { status, headers(脱敏后), bodyText }；非 2xx 抛 http 错误（正文不进错误）；
   * 网络错误/中止 → network/timeout 结构化错误。
   */
  async send(
    request: UltraRequest,
    credential: Secret,
    options?: UltraSendOptions,
  ): Promise<UltraResponse> {
    const method = request.method.trim().toUpperCase();
    if (method === "") {
      throw new UltraGatewayError("config", "send: method 不能为空");
    }
    const url = this.routeUltra({ path: request.path });
    const fingerprint = buildFingerprintHeaders({
      apiKey: credential,
      userAgent: this.#userAgent,
      traceId: this.#traceIdGenerator(),
    });
    const headers = mergeHeaders(request.headers, fingerprint);
    const log = options?.log;
    const startedAtMs = this.#now();

    let response: Response;
    try {
      response = await this.#fetchImpl(url.toString(), {
        method,
        headers,
        body: request.body,
        signal: options?.signal,
      });
    } catch (error) {
      const failure = classifyTransportError(error);
      log?.(this.#formatLogLine(method, url, undefined, fingerprint, `failed:${failure.code}`));
      throw failure;
    }

    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch (error) {
      const failure = classifyTransportError(error);
      log?.(
        this.#formatLogLine(
          method,
          url,
          response.status,
          fingerprint,
          `failed:${failure.code}:body-read`,
        ),
      );
      throw failure;
    }

    const status = response.status;
    const durationMs = Math.max(0, this.#now() - startedAtMs);
    if (status < 200 || status >= 300) {
      // HTTP 级失败同样出日志行，note 显式标注 failed:http（响应正文仍绝不进日志/错误）。
      log?.(
        this.#formatLogLine(
          method,
          url,
          status,
          fingerprint,
          `failed:http:durationMs:${durationMs}`,
        ),
      );
      throw new UltraGatewayError(
        "http",
        `Ultra 专线请求失败: HTTP ${status} (${method} ${url.pathname})`,
        { status },
      );
    }
    log?.(this.#formatLogLine(method, url, status, fingerprint, `durationMs:${durationMs}`));
    return { status, headers: redactFingerprint(headersToRecord(response.headers)), bodyText };
  }

  /** 日志行：指纹三标头一律 ze-***last4 遮蔽；绝不包含凭据原文与响应正文。 */
  #formatLogLine(
    method: string,
    url: URL,
    status: number | undefined,
    fingerprint: Record<string, string>,
    note: string,
  ): string {
    return JSON.stringify({
      method,
      url: url.toString(),
      status,
      ...redactFingerprint(fingerprint),
      note,
    });
  }
}

/** 标头合并：键统一小写去重（与 fetch Headers 规范化一致），override（指纹组）最后落位。 */
function mergeHeaders(
  base: Record<string, string> | undefined,
  override: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(base ?? {})) {
    merged[key.toLowerCase()] = value;
  }
  for (const [key, value] of Object.entries(override)) {
    merged[key.toLowerCase()] = value;
  }
  return merged;
}

/** Headers → 小写键 Record（fetch 响应标头本就小写，此处防御性统一）。 */
function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/** 传输层异常归类：Abort/Timeout → timeout，其余 → network。 */
function classifyTransportError(error: unknown): UltraGatewayError {
  if (error instanceof UltraGatewayError) return error;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return new UltraGatewayError("timeout", "Ultra 专线请求超时或被中止", { cause: error });
  }
  const reason = error instanceof Error ? error.message : String(error);
  return new UltraGatewayError("network", `Ultra 专线网络错误: ${reason}`, { cause: error });
}
