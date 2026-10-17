/**
 * BI-05.4 · 时钟上下文与时区自适应感知器。
 *
 * buildTimeContext：产出可注入的最小文本块——当前 ISO 时间（带时区偏移）
 * + IANA 时区 + UTC 偏移标签；给了 elapsedSince 时追加
 * `Elapsed: Xm Ys since last turn`（负值时钟回拨钳到 0，裁定）。
 * 时区默认 Asia/Shanghai（工单钉死，可配）。
 *
 * TimeContextCache：最小刷新间隔 refreshIntervalMs = 600_000（10 分钟）。
 * 同一缓存键在窗口内返回 null（免重复注入）；跨越刷新窗（age >= 间隔，
 * 边界即重建）才生成新块。时钟注入（now），多键相互独立。
 *
 * 无外部依赖：UTC 偏移由 Intl formatToParts 墙钟反算
 * （wallAsUTC − epochMs），不依赖运行时的 timeZoneName 序列化差异。
 */

export const DEFAULT_TIMEZONE = "Asia/Shanghai";
export const DEFAULT_REFRESH_INTERVAL_MS = 600_000;

export interface TimeContextOpts {
  /** 注入时钟（ISO 8601 字符串）。缺省取墙钟。 */
  isoNow?: string;
  /** IANA 时区。默认 Asia/Shanghai。 */
  timezone?: string;
  /** 上一轮的 epoch 毫秒；给出时追加 Elapsed 行。 */
  elapsedSince?: number;
}

/** 结构化错误：config=时区配置非法；clock=时钟输入不可解析。 */
export class TimeContextError extends Error {
  constructor(
    message: string,
    readonly code: "config" | "clock",
  ) {
    super(message);
    this.name = "TimeContextError";
  }
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 用 Intl 取墙钟各字段（h24 免疫：hourCycle h23）。 */
function wallParts(epochMs: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new TimeContextError(`invalid IANA timezone: ${tz}`, "config");
  }
  const parts = fmt.formatToParts(new Date(epochMs));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const num = (type: string): number => Number.parseInt(get(type), 10);
  return { y: num("year"), mo: num("month"), d: num("day"), h: num("hour"), mi: num("minute"), s: num("second") };
}

/**
 * 构建时间上下文文本块。
 * 行 1：`Current time: <ISO 带偏移> (<IANA 时区>, UTC±HH:MM)`
 * 行 2（仅当给 elapsedSince）：`Elapsed: Xm Ys since last turn`
 *
 * @throws TimeContextError（code="clock"）isoNow 不可解析；
 *   （code="config"）timezone 非法。
 */
export function buildTimeContext(opts: TimeContextOpts = {}): string {
  const isoNow = opts.isoNow ?? new Date().toISOString();
  const epoch = Date.parse(isoNow);
  if (Number.isNaN(epoch)) {
    throw new TimeContextError(`isoNow is not parseable: ${isoNow}`, "clock");
  }
  const tz = opts.timezone ?? DEFAULT_TIMEZONE;
  const w = wallParts(epoch, tz);
  // 墙钟按 UTC 反解与真实 epoch 之差 = 时区偏移（分钟）。
  const wallAsUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  const offsetMin = Math.round((wallAsUtc - epoch) / 60_000);
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const offLabel = `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  const isoWithOffset = `${w.y}-${pad2(w.mo)}-${pad2(w.d)}T${pad2(w.h)}:${pad2(w.mi)}:${pad2(w.s)}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;

  const lines: string[] = [`Current time: ${isoWithOffset} (${tz}, ${offLabel})`];
  if (opts.elapsedSince !== undefined) {
    if (!Number.isFinite(opts.elapsedSince)) {
      throw new TimeContextError(`elapsedSince must be a finite epoch ms, got ${String(opts.elapsedSince)}`, "clock");
    }
    const elapsedMs = Math.max(0, epoch - opts.elapsedSince);
    const totalSec = Math.floor(elapsedMs / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    lines.push(`Elapsed: ${m}m ${s}s since last turn`);
  }
  return lines.join("\n");
}

export interface TimeContextCacheOpts {
  /** 最小刷新间隔（毫秒）。默认 600_000。 */
  refreshIntervalMs?: number;
  /** 注入时钟。默认 `Date.now`。 */
  now?: () => number;
}

export class TimeContextCache {
  readonly refreshIntervalMs: number;
  private readonly now: () => number;
  private readonly lastBuiltAt = new Map<string, number>();

  constructor(opts: TimeContextCacheOpts = {}) {
    const r = opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    if (!Number.isFinite(r) || r < 0) {
      throw new RangeError(`refreshIntervalMs must be a finite number >= 0, got ${String(r)}`);
    }
    this.refreshIntervalMs = r;
    this.now = opts.now ?? Date.now;
  }

  /**
   * 同键在刷新窗内 → null（免重复注入）；age >= refreshIntervalMs →
   * 用 buildTimeContext(opts) 生成新块并记录时刻（边界即重建）。
   */
  get(key: string, opts?: TimeContextOpts): string | null {
    const t = this.now();
    const last = this.lastBuiltAt.get(key);
    if (last !== undefined && t - last < this.refreshIntervalMs) return null;
    const block = buildTimeContext(opts);
    this.lastBuiltAt.set(key, t);
    return block;
  }

  /** 清空全部键的刷新记录（下一 get 必重建）。 */
  reset(): void {
    this.lastBuiltAt.clear();
  }
}
