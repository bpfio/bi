/**
 * BI-02.4 · 免费加速抽卡引擎（Highspeed Draw）。
 *
 * - draw()：POST `{baseUrl}{drawPath}`（highspeed/draw 语义，path 注入）
 *   → { hit, token?(Secret 品牌), ttlMs? }；命中即持有（current() 可取），未命中不持牌。
 * - 3402 过期自愈：调用方用所持 token 打上游、经 classifyFailure 类语义观察到
 *   错误码 3402（HIGHSPEED_TOKEN_EXPIRED_CODE）后调用 recover()——重新 draw 一次
 *   并替换所持 token；单飞防抖：并发 recover 合并为一次真实 draw（共享同一 Outcome）；
 *   recover 绕过抽卡冷却（自愈路径不得被冷却卡死），重绘 miss 则清空所持失效 token。
 * - 抽卡冷却：draw() 在冷却期内（cooldownMs，按注入时钟）直接返回 cooldown 结果
 *   （附 retryAfterMs），不触网；recover 成功后同样刷新冷却计时。
 *
 * 零数据外泄红线：fetch 经 requestJson（../auth/http）注入，本模块自身永不触网；
 * token 只经 Secret 品牌值流转与返回，日志只有脱敏行（响应正文与 token 绝不落日志）。
 * 零外部依赖：仅注入 fetch。
 */
import {
  HttpRequestError,
  requestJson,
  type FetchLike,
  type HttpJsonResult,
} from "../auth/http";
import { role, type Secret } from "../auth/types";

/** 缺省基址（与既有 Coding Plan 端点同域；可注入覆盖）。 */
export const DEFAULT_HIGHSPEED_BASE_URL = "https://open.bigmodel.cn";
/** 缺省抽卡路径（POST highspeed/draw 语义）。 */
export const DEFAULT_HIGHSPEED_DRAW_PATH = "/api/highspeed/draw";

/** 上游「免费加速 token 已过期」错误码（对齐 classifyFailure 观察语义）。 */
export const HIGHSPEED_TOKEN_EXPIRED_CODE = 3402;

/** 供调用方判定所持 token 的上游失败码是否为 3402 过期（对齐 classifyFailure 语义）。 */
export function isTokenExpiredCode(code: unknown): boolean {
  return code === HIGHSPEED_TOKEN_EXPIRED_CODE;
}

/** 抽卡失败分类（cooldown 为本地冷却拦截，其余对齐请求错误面）。 */
export type DrawFailureKind = "cooldown" | "network" | "http" | "protocol";

export interface DrawFailure {
  readonly kind: DrawFailureKind;
  /** 脱敏 message，不含响应原文与 token。 */
  readonly message: string;
  readonly status?: number;
  /** 仅 cooldown：距冷却解除的毫秒数（按注入时钟）。 */
  readonly retryAfterMs?: number;
}

export type DrawOutcome =
  | {
      readonly ok: true;
      /** 是否命中（true=发 token；false=未命中）。 */
      readonly hit: boolean;
      /** 命中时的加速 token（role("secret") 标记）。 */
      readonly token?: Secret;
      /** token 有效时长（毫秒，服务端下发）。 */
      readonly ttlMs?: number;
      readonly drawnAt: number;
    }
  | { readonly ok: false; readonly failure: DrawFailure };

/** 抽卡引擎结构化错误（构造校验用；请求失败走 Outcome 不抛异常）。 */
export class HighspeedDrawError extends Error {
  readonly code: "config";

  constructor(code: HighspeedDrawError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HighspeedDrawError";
    this.code = code;
  }
}

/** 所持 token 视图。 */
export interface HeldToken {
  readonly token: Secret;
  /** 过期时间（epoch 毫秒，按 drawnAt + ttlMs 推算；服务端未下发 ttl 则缺省）。 */
  readonly expiresAt?: number;
}

export interface HighspeedDrawOptions {
  /** fetch 注入，缺省 globalThis.fetch（生产）；测试必须注入内存 stub。 */
  readonly fetchImpl?: FetchLike;
  /** 端点基址，缺省 DEFAULT_HIGHSPEED_BASE_URL。 */
  readonly baseUrl?: string;
  /** 抽卡路径（POST），缺省 DEFAULT_HIGHSPEED_DRAW_PATH。 */
  readonly drawPath?: string;
  /** 抽卡冷却（毫秒），缺省 60_000；0 表示不去抖。 */
  readonly cooldownMs?: number;
  /** 时钟注入（冷却计时/过期推算），缺省 Date.now。 */
  readonly now?: () => number;
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

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export class HighspeedDraw {
  readonly #fetchImpl: FetchLike | undefined;
  readonly #url: string;
  readonly #cooldownMs: number;
  readonly #now: () => number;
  readonly #headers: Record<string, string> | undefined;
  readonly #timeoutMs: number;
  readonly #log: ((line: string) => void) | undefined;

  #held: HeldToken | undefined;
  #lastDrawAt: number | undefined;
  /** 单飞防抖：在途 recover 的共享 Promise（并发 recover 合并为一次真实 draw）。 */
  #recoverPromise: Promise<DrawOutcome> | undefined;

  constructor(options: HighspeedDrawOptions = {}) {
    const baseUrl = options.baseUrl ?? DEFAULT_HIGHSPEED_BASE_URL;
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error(`unsupported protocol: ${parsed.protocol}`);
      }
    } catch (error) {
      throw new HighspeedDrawError("config", "HighspeedDraw: baseUrl 须为合法 http(s) 绝对 URL", {
        cause: error,
      });
    }
    const path = options.drawPath ?? DEFAULT_HIGHSPEED_DRAW_PATH;
    this.#url = `${baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const cooldownMs = options.cooldownMs ?? 60_000;
    if (!Number.isFinite(cooldownMs) || cooldownMs < 0) {
      throw new HighspeedDrawError("config", "HighspeedDraw: cooldownMs 不能为负数");
    }
    this.#cooldownMs = cooldownMs;
    this.#now = options.now ?? Date.now;
    this.#fetchImpl = options.fetchImpl;
    this.#headers = options.headers;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#log = options.log;
  }

  /** 当前所持 token（recover/draw 命中后更新；recover 重绘 miss 后清空）。 */
  current(): HeldToken | undefined {
    return this.#held;
  }

  /** 上次抽卡尝试时间（epoch 毫秒；冷却计时基准）。 */
  lastDrawAt(): number | undefined {
    return this.#lastDrawAt;
  }

  /**
   * 抽卡（受冷却约束）：冷却期内直接返回 cooldown 失败（不触网）；
   * 否则 POST 抽卡端点，命中 → 持有并返回 token，未命中 → ok:true/hit:false。
   */
  async draw(): Promise<DrawOutcome> {
    return this.#drawInternal(false);
  }

  /**
   * 3402 过期自愈：重新 draw 一次并替换所持 token。
   * - 单飞防抖：并发调用共享同一在途 Promise（只发一次请求）；
   * - 绕过抽卡冷却（自愈路径不被冷却卡死）；
   * - 重绘 miss → 清空所持失效 token；重绘失败 → 保持旧 token（由调用方重试）。
   */
  recover(): Promise<DrawOutcome> {
    if (this.#recoverPromise !== undefined) {
      return this.#recoverPromise;
    }
    const promise = this.#drawInternal(true)
      .then((outcome) => {
        // 重绘 miss → 清空所持失效 token（3402 已证明其不可用）。
        if (outcome.ok && !outcome.hit) {
          this.#held = undefined;
        }
        return outcome;
      })
      .finally(() => {
        if (this.#recoverPromise === promise) {
          this.#recoverPromise = undefined;
        }
      });
    this.#recoverPromise = promise;
    return promise;
  }

  async #drawInternal(force: boolean): Promise<DrawOutcome> {
    const now = this.#now();
    if (!force && this.#lastDrawAt !== undefined && now - this.#lastDrawAt < this.#cooldownMs) {
      return {
        ok: false,
        failure: {
          kind: "cooldown",
          message: "抽卡冷却期内",
          retryAfterMs: this.#cooldownMs - (now - this.#lastDrawAt),
        },
      };
    }
    this.#lastDrawAt = now; // 尝试即计时（防对失败端点连打）

    let result: HttpJsonResult;
    try {
      result = await requestJson({
        method: "POST",
        url: this.#url,
        headers: this.#headers,
        body: {},
        fetch: this.#fetchImpl,
        timeoutMs: this.#timeoutMs,
        log: this.#log,
      });
    } catch (error) {
      return { ok: false, failure: this.#classifyFailure(error) };
    }

    if (!isObject(result.json)) {
      return {
        ok: false,
        failure: { kind: "protocol", message: "抽卡响应不是 JSON 对象", status: result.status },
      };
    }
    const hit = result.json.hit;
    if (typeof hit !== "boolean") {
      return {
        ok: false,
        failure: { kind: "protocol", message: "抽卡响应缺少 hit 字段", status: result.status },
      };
    }
    if (!hit) {
      return { ok: true, hit: false, drawnAt: now };
    }
    const rawToken = result.json.token;
    if (typeof rawToken !== "string" || rawToken === "") {
      return {
        ok: false,
        failure: { kind: "protocol", message: "抽卡命中但缺少 token", status: result.status },
      };
    }
    const ttlMs = finiteNumber(result.json.ttlMs ?? result.json.ttl_ms);
    if (ttlMs !== undefined && ttlMs <= 0) {
      return {
        ok: false,
        failure: { kind: "protocol", message: "抽卡响应 ttlMs 必须为正数", status: result.status },
      };
    }
    const token = role("secret", rawToken);
    this.#held = {
      token,
      ...(ttlMs === undefined ? {} : { expiresAt: now + ttlMs }),
    };
    return {
      ok: true,
      hit: true,
      token,
      ...(ttlMs === undefined ? {} : { ttlMs }),
      drawnAt: now,
    };
  }

  #classifyFailure(error: unknown): DrawFailure {
    if (error instanceof HttpRequestError) {
      if (error.kind === "http") {
        return {
          kind: "http",
          message: `抽卡请求失败: ${error.message}`,
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
