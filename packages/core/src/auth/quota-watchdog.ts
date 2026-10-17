/**
 * BI-02.2 · Coding Plan 额度监测与余额预警看门狗。
 *
 * - pollOnce()：GET 配额端点（baseUrl+path 注入），响应 shape 可配 mapper——
 *   归一化快照语义 { used, total, resetAt?, rpmRemaining?, tpmRemaining?, rateLimited }；
 *   缺省 mapper 接受 canonical 形状（camelCase/snake_case 双兼容），畸形响应抛
 *   结构化 protocol 错误，绝不炸轮询循环。
 * - start()/stop()：间隔轮询（IntervalTimerPort 注入，测试用手动 fire 实现）；
 *   start 立即执行首轮，随后按 intervalMs 周期轮询；轮询进行中跳过重叠 tick；
 *   单次轮询失败只记脱敏日志，循环继续。
 * - 触发条件（两级告警）：余量比 < thresholds.ratio（缺省 0.1）→ warn（low_ratio）；
 *   余量归零 → critical（exhausted）；响应标记 rate_limited（且 thresholds.rateLimited
 *   启用）→ critical（rate_limited），双条件同中时 rate_limited 优先只发一条。
 * - 预警去抖：同 level 冷却期内（cooldownMs，按注入时钟计）不重复 onAlert；
 *   跨 level（warn→critical）不受冷却拦截。
 * - latest()：最近一次成功轮询的快照缓存。
 *
 * 零数据外泄红线：fetch 经 requestJson（../auth/http）全量注入，本模块自身永不触网；
 * 日志只含 method/脱敏 URL/状态码/note，响应原文与凭据绝不落日志。
 * 零外部依赖：node:timers + 注入 fetch。
 */
import { HttpRequestError, redactUrl, requestJson, type FetchLike } from "./http";

/** 缺省配额端点基址（与既有 Coding Plan 端点同域；可注入覆盖）。 */
export const DEFAULT_QUOTA_BASE_URL = "https://open.bigmodel.cn";
/** 缺省配额查询路径（语义注入；测试一律注入 stub 路径，不触网）。 */
export const DEFAULT_QUOTA_PATH = "/api/coding-plan/quota";

/**
 * 间隔轮询 timer 端口（通用；本包 quota-watchdog 与 off-peak-service 共用形态）。
 * start 注册周期回调并返回句柄，stop 按句柄撤销；测试注入手动 fire 的内存实现。
 */
export interface IntervalTimerPort {
  start(fn: () => void, intervalMs: number): unknown;
  stop(handle: unknown): void;
}

/** 缺省 timer：全局 setInterval/clearInterval（unref，不阻塞进程退出）。 */
export const defaultIntervalTimer: IntervalTimerPort = {
  start(fn, intervalMs) {
    const handle = setInterval(fn, intervalMs);
    handle.unref();
    return handle;
  },
  stop(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/** 归一化额度快照（mapper 输出契约）。 */
export interface QuotaSnapshot {
  /** 已用额度。 */
  readonly used: number;
  /** 额度总量（必须为正数，否则视为协议错误）。 */
  readonly total: number;
  /** 重置时间（epoch 毫秒，可选）。 */
  readonly resetAt?: number;
  /** 每分钟请求数余量（可选）。 */
  readonly rpmRemaining?: number;
  /** 每分钟 token 数余量（可选）。 */
  readonly tpmRemaining?: number;
  /** 响应是否标记限流（缺省 false）。 */
  readonly rateLimited: boolean;
}

/**
 * 响应 shape 适配器：把上游任意形状映射为 QuotaSnapshot。
 * 抛错（或返回非法快照）→ 结构化 protocol 错误，轮询循环不炸。
 */
export type QuotaMapper = (raw: unknown) => QuotaSnapshot;

/** 阈值配置。 */
export interface QuotaThresholds {
  /** 余量比告警阈值，缺省 0.1（<10% 触发）。取值 [0,1]。 */
  readonly ratio?: number;
  /** 是否启用「响应标记 rate_limited → critical」触发，缺省 true。 */
  readonly rateLimited?: boolean;
}

/** 预警级别：warn=余量低于阈值；critical=余量耗尽或被限流。 */
export type QuotaAlertLevel = "warn" | "critical";

/** 告警原因：low_ratio=低于阈值；exhausted=余量归零；rate_limited=被限流。 */
export type QuotaAlertReason = "low_ratio" | "exhausted" | "rate_limited";

/** 预警事件（onAlert 回调载荷；snapshot 为触发时的快照引用）。 */
export interface QuotaAlert {
  readonly level: QuotaAlertLevel;
  readonly reason: QuotaAlertReason;
  readonly snapshot: QuotaSnapshot;
}

/** 单次轮询结果：归一化快照 + 本次触发的告警（未触发缺省）。 */
export interface QuotaPollResult {
  readonly snapshot: QuotaSnapshot;
  readonly alert?: QuotaAlert;
}

/** 看门狗结构化错误：code 稳定可编程判断，message 不含响应原文与凭据。 */
export class QuotaWatchdogError extends Error {
  readonly code: "config" | "network" | "http" | "protocol";
  readonly status?: number;

  constructor(
    code: QuotaWatchdogError["code"],
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "QuotaWatchdogError";
    this.code = code;
    this.status = options?.status;
  }
}

export interface QuotaWatchdogOptions {
  /** fetch 注入（必填；测试注入内存 stub，严禁真实调用）。 */
  readonly fetchImpl: FetchLike;
  /** 预警回调（必填；同级冷却期内不重复触发）。 */
  readonly onAlert: (alert: QuotaAlert) => void;
  /** 配额端点基址，缺省 DEFAULT_QUOTA_BASE_URL。 */
  readonly baseUrl?: string;
  /** 配额端点路径，缺省 DEFAULT_QUOTA_PATH。 */
  readonly path?: string;
  /** 间隔轮询周期（毫秒），缺省 60_000；必须为正数。 */
  readonly intervalMs?: number;
  /** 触发阈值，缺省 { ratio: 0.1, rateLimited: true }。 */
  readonly thresholds?: QuotaThresholds;
  /** 同级告警冷却（毫秒），缺省 300_000；0 表示不去抖。 */
  readonly cooldownMs?: number;
  /** 响应 shape 适配器，缺省 defaultQuotaMapper（canonical 形状）。 */
  readonly mapper?: QuotaMapper;
  /** 间隔轮询 timer 注入，缺省 defaultIntervalTimer。 */
  readonly timer?: IntervalTimerPort;
  /** 时钟注入（去抖计时/日志），缺省 Date.now。 */
  readonly now?: () => number;
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

function optionalField(raw: Record<string, unknown>, camel: string, snake: string): unknown {
  if (camel in raw) return raw[camel];
  if (snake in raw) return raw[snake];
  return undefined;
}

/**
 * 缺省 mapper：canonical 形状
 * `{ used, total, resetAt|reset_at?, rpmRemaining|rpm_remaining?, tpmRemaining|tpm_remaining?, rateLimited|rate_limited? }`。
 * used/total 必填且为有限数、total 必须为正数，否则抛错（由上层归一为 protocol 错误）。
 */
export const defaultQuotaMapper: QuotaMapper = (raw) => {
  if (!isObject(raw)) {
    throw new Error("配额响应不是 JSON 对象");
  }
  const used = finiteNumber(raw.used);
  if (used === undefined) throw new Error("配额响应缺少数值型 used");
  const total = finiteNumber(raw.total);
  if (total === undefined) throw new Error("配额响应缺少数值型 total");
  if (total <= 0) throw new Error("配额响应 total 必须为正数");
  const resetAt = finiteNumber(optionalField(raw, "resetAt", "reset_at"));
  const rpmRemaining = finiteNumber(optionalField(raw, "rpmRemaining", "rpm_remaining"));
  const tpmRemaining = finiteNumber(optionalField(raw, "tpmRemaining", "tpm_remaining"));
  const rateFlag = optionalField(raw, "rateLimited", "rate_limited");
  if (rateFlag !== undefined && typeof rateFlag !== "boolean") {
    throw new Error("配额响应 rate_limited 必须为布尔值");
  }
  return {
    used,
    total,
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(rpmRemaining === undefined ? {} : { rpmRemaining }),
    ...(tpmRemaining === undefined ? {} : { tpmRemaining }),
    rateLimited: rateFlag === true,
  };
};

/** mapper 输出统一校验（含自定义 mapper）：违反快照契约 → protocol 错误。 */
function validateSnapshot(snapshot: QuotaSnapshot): QuotaSnapshot {
  const { used, total } = snapshot;
  if (!Number.isFinite(used) || used < 0) {
    throw new Error("mapper 输出 used 必须为非负有限数");
  }
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error("mapper 输出 total 必须为正有限数");
  }
  for (const [name, value] of [
    ["resetAt", snapshot.resetAt],
    ["rpmRemaining", snapshot.rpmRemaining],
    ["tpmRemaining", snapshot.tpmRemaining],
  ] as const) {
    if (value !== undefined && !Number.isFinite(value)) {
      throw new Error(`mapper 输出 ${name} 必须为有限数`);
    }
  }
  if (typeof snapshot.rateLimited !== "boolean") {
    throw new Error("mapper 输出 rateLimited 必须为布尔值");
  }
  return snapshot;
}

export class QuotaWatchdog {
  readonly #fetchImpl: FetchLike;
  readonly #onAlert: (alert: QuotaAlert) => void;
  readonly #baseUrl: string;
  readonly #path: string;
  readonly #intervalMs: number;
  readonly #thresholds: Required<QuotaThresholds>;
  readonly #cooldownMs: number;
  readonly #mapper: QuotaMapper;
  readonly #timer: IntervalTimerPort;
  readonly #now: () => number;
  readonly #headers: Record<string, string> | undefined;
  readonly #timeoutMs: number;
  readonly #retries: number;
  readonly #log: ((line: string) => void) | undefined;

  #latest: QuotaSnapshot | undefined;
  #lastAlertAt = new Map<QuotaAlertLevel, number>();
  #running = false;
  #handle: unknown;
  #inFlight = false;

  constructor(options: QuotaWatchdogOptions) {
    const baseUrl = options.baseUrl ?? DEFAULT_QUOTA_BASE_URL;
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error(`unsupported protocol: ${parsed.protocol}`);
      }
    } catch (error) {
      throw new QuotaWatchdogError("config", "QuotaWatchdog: baseUrl 须为合法 http(s) 绝对 URL", {
        cause: error,
      });
    }
    this.#baseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    const path = options.path ?? DEFAULT_QUOTA_PATH;
    this.#path = path.startsWith("/") ? path : `/${path}`;
    this.#fetchImpl = options.fetchImpl;
    this.#onAlert = options.onAlert;

    const intervalMs = options.intervalMs ?? 60_000;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new QuotaWatchdogError("config", "QuotaWatchdog: intervalMs 必须为正数");
    }
    this.#intervalMs = intervalMs;

    const ratio = options.thresholds?.ratio ?? 0.1;
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      throw new QuotaWatchdogError("config", "QuotaWatchdog: thresholds.ratio 须在 [0,1] 区间");
    }
    this.#thresholds = { ratio, rateLimited: options.thresholds?.rateLimited ?? true };

    const cooldownMs = options.cooldownMs ?? 300_000;
    if (!Number.isFinite(cooldownMs) || cooldownMs < 0) {
      throw new QuotaWatchdogError("config", "QuotaWatchdog: cooldownMs 不能为负数");
    }
    this.#cooldownMs = cooldownMs;

    const retries = options.retries ?? 1;
    if (!Number.isFinite(retries) || retries < 0) {
      throw new QuotaWatchdogError("config", "QuotaWatchdog: retries 不能为负数");
    }
    this.#retries = retries;

    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new QuotaWatchdogError("config", "QuotaWatchdog: timeoutMs 必须为正数");
    }
    this.#timeoutMs = timeoutMs;

    this.#mapper = options.mapper ?? defaultQuotaMapper;
    this.#timer = options.timer ?? defaultIntervalTimer;
    this.#now = options.now ?? Date.now;
    this.#headers = options.headers;
    this.#log = options.log;
  }

  /** 最近一次成功轮询的快照；从未成功过返回 undefined。 */
  latest(): QuotaSnapshot | undefined {
    return this.#latest;
  }

  /**
   * 单次轮询：GET 配额端点 → mapper 归一化 → 更新 latest 缓存 → 评估告警（含去抖）。
   * 成功返回 { snapshot, alert? }；失败抛结构化 QuotaWatchdogError（不炸轮询循环）。
   */
  async pollOnce(): Promise<QuotaPollResult> {
    const url = `${this.#baseUrl}${this.#path}`;
    let json: unknown;
    try {
      const result = await requestJson({
        method: "GET",
        url,
        headers: this.#headers,
        fetch: this.#fetchImpl,
        timeoutMs: this.#timeoutMs,
        retries: this.#retries,
        log: this.#log,
      });
      json = result.json;
    } catch (error) {
      throw this.#classify(error);
    }

    let snapshot: QuotaSnapshot;
    try {
      snapshot = validateSnapshot(this.#mapper(json));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new QuotaWatchdogError("protocol", `配额响应映射失败: ${reason}`, { cause: error });
    }

    this.#latest = snapshot;
    const alert = this.#evaluate(snapshot);
    if (alert !== undefined) {
      this.#onAlert(alert);
      return { snapshot, alert };
    }
    return { snapshot };
  }

  /**
   * 启动看门狗：立即执行首轮轮询（失败不抛，只记日志），随后按 intervalMs 周期轮询。
   * 重复 start 幂等（已在运行则直接返回）。
   */
  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    await this.#pollSafely();
    if (!this.#running) return; // start/stop 竞态：首轮期间已 stop
    this.#handle = this.#timer.start(() => {
      void this.#pollSafely();
    }, this.#intervalMs);
  }

  /** 停止周期轮询（幂等）；在途轮询让其自然完成。 */
  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    if (this.#handle !== undefined) {
      this.#timer.stop(this.#handle);
      this.#handle = undefined;
    }
  }

  /** 周期 tick：上一轮仍在途时跳过本 tick（防重叠轮询）。 */
  async #pollSafely(): Promise<void> {
    if (this.#inFlight) return;
    this.#inFlight = true;
    try {
      await this.pollOnce();
    } catch (error) {
      const failure =
        error instanceof QuotaWatchdogError
          ? error
          : new QuotaWatchdogError("network", `配额轮询失败: ${String(error)}`);
      this.#log?.(
        JSON.stringify({
          method: "GET",
          url: redactUrl(`${this.#baseUrl}${this.#path}`),
          note: `poll-failed:${failure.code}:${failure.message}`,
        }),
      );
    } finally {
      this.#inFlight = false;
    }
  }

  /**
   * 告警评估（两级 + 同级去抖）：
   * - rate_limited 标记（启用时）→ critical，优先级最高；
   * - 余量比 < ratio → 余量为 0 时 critical(exhausted)，否则 warn(low_ratio)；
   * - 同 level 距上次触发 < cooldownMs（注入时钟）→ 抑制本次；跨 level 不受影响。
   */
  #evaluate(snapshot: QuotaSnapshot): QuotaAlert | undefined {
    const remaining = Math.max(0, snapshot.total - snapshot.used);
    const ratio = remaining / snapshot.total;
    let candidate: QuotaAlert | undefined;
    if (snapshot.rateLimited && this.#thresholds.rateLimited) {
      candidate = { level: "critical", reason: "rate_limited", snapshot };
    } else if (ratio < this.#thresholds.ratio) {
      candidate =
        remaining <= 0
          ? { level: "critical", reason: "exhausted", snapshot }
          : { level: "warn", reason: "low_ratio", snapshot };
    }
    if (candidate === undefined) return undefined;

    const now = this.#now();
    const lastAt = this.#lastAlertAt.get(candidate.level);
    if (lastAt !== undefined && now - lastAt < this.#cooldownMs) {
      return undefined; // 同级冷却期内去抖
    }
    this.#lastAlertAt.set(candidate.level, now);
    return candidate;
  }

  #classify(error: unknown): QuotaWatchdogError {
    if (error instanceof QuotaWatchdogError) return error;
    if (error instanceof HttpRequestError) {
      if (error.kind === "http") {
        return new QuotaWatchdogError("http", `配额查询失败: ${error.message}`, {
          status: error.status,
          cause: error,
        });
      }
      if (error.kind === "protocol") {
        return new QuotaWatchdogError("protocol", `配额查询协议错误: ${error.message}`, {
          cause: error,
        });
      }
      return new QuotaWatchdogError("network", `配额查询网络失败: ${error.message}`, {
        cause: error,
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    return new QuotaWatchdogError("network", `配额查询网络失败: ${message}`, { cause: error });
  }
}
