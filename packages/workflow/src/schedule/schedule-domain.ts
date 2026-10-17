/**
 * BI-07.14 跨时区全周期任务调度引擎 —— 调度域原语层 (schedule-domain)
 *
 * 六大调度原语（Temporal 规范语义，联合判别 kind）:
 *   after  — 相对延时 { delayMs }
 *   at     — 本地化墙钟一次性时点 { isoLocal, tz? }
 *   every  — 固定间隔 { intervalMs }（下限 60s，Unix 纪元对齐）
 *   cron   — 5 字段表达式 { expr, tz? }（分 时 日 月 周；支持 `*` / 步进 / 列表 / 区间）
 *   daily  — 每日墙钟 { hh, mm, tz? }
 *   weekly — 每周墙钟 { weekday 0-6(0=周日), hh, mm, tz? }
 *
 * 400 年硬边界（卡面明文要求）: 格里高利历以 400 年 = 146097 天为精确周期
 * （97 个闰日 / 400 年，且 146097 % 7 === 0 故星期对齐同周期复现）。任何
 * "可命中"的 cron 表达式自 afterMs 起 400 年窗口内必有命中；扫描越界仍未
 * 命中（如 `0 0 30 2 *` 的 2 月 30 日类非法日历组合）返回 null，防死循环。
 * 月日越界由日历扫描自然跳过：扫描器只生成合法公历日（civilFromDays），
 * 2 月 30 日永远不作为候选日出现，扫描自然滚到下一合法日。
 *
 * DST 语义（v1 备案偏差）: localWallToUtc 取墙钟直算（Intl formatToParts
 * 反算 + 单次偏移复核），DST 跳变日存在偏差；消费方对"墙钟直算可能回拨"
 * 一律以 utc > afterMs 守卫兜底，测试以无 DST 时区为主（Asia/Shanghai、
 * UTC、Asia/Kathmandu 等）。
 */

// ---------- 常量 ----------
/** every 原语间隔下限（卡面: minInterval 下限 60s）。 */
export const EVERY_MIN_INTERVAL_MS = 60_000;
/** 400 年硬边界天数（格里高利精确周期，卡面明文要求）。 */
export const CRON_HORIZON_DAYS = 146_097;

// ---------- 六原语类型 ----------
export interface AfterSchedule {
  readonly kind: 'after';
  readonly delayMs: number;
}

export interface AtSchedule {
  readonly kind: 'at';
  /** 本地化墙钟点，格式 YYYY-MM-DDTHH:mm[:ss]（亦可空格分隔），不带时区偏移。 */
  readonly isoLocal: string;
  /** IANA 时区；缺省回落到 nextFire 的 tz 参数（再缺省 UTC）。 */
  readonly tz?: string;
}

export interface EverySchedule {
  readonly kind: 'every';
  /** 间隔毫秒，整数且 ≥ EVERY_MIN_INTERVAL_MS(60s)；命中点按 Unix 纪元对齐。 */
  readonly intervalMs: number;
}

export interface CronSchedule {
  readonly kind: 'cron';
  /** 5 字段表达式: 分 时 日 月 周。 */
  readonly expr: string;
  /** IANA 时区；缺省回落到 nextFire 的 tz 参数（再缺省 UTC）。 */
  readonly tz?: string;
}

export interface DailySchedule {
  readonly kind: 'daily';
  readonly hh: number;
  readonly mm: number;
  readonly tz?: string;
}

export interface WeeklySchedule {
  readonly kind: 'weekly';
  /** 0-6，0=周日。 */
  readonly weekday: number;
  readonly hh: number;
  readonly mm: number;
  readonly tz?: string;
}

export type ScheduleSpec =
  | AfterSchedule
  | AtSchedule
  | EverySchedule
  | CronSchedule
  | DailySchedule
  | WeeklySchedule;

// ---------- cron 解析结构 ----------
export interface ParsedCron {
  readonly expr: string;
  /** 0-59 */
  readonly minutes: ReadonlySet<number>;
  /** 0-23 */
  readonly hours: ReadonlySet<number>;
  /** 1-31（月日越界由日历扫描自然跳过） */
  readonly doms: ReadonlySet<number>;
  /** 1-12 */
  readonly months: ReadonlySet<number>;
  /** 0-6，0=周日 */
  readonly dows: ReadonlySet<number>;
  readonly domStar: boolean;
  readonly dowStar: boolean;
}

// ---------- 本地墙钟结构 ----------
export interface LocalWall {
  y: number;
  /** 1-12 */
  mo: number;
  /** 1-31 */
  d: number;
  /** 0-23 */
  h: number;
  mi: number;
  s: number;
  /** 0-6，0=周日 */
  weekday: number;
}

// ============================================================
// 格里高利日历核心（Hinnant civil 算法；零依赖；400 年周期精确；
// 导出供测试互证）
// ============================================================

/** 格里高利闰年规则（含世纪年：能被 400 整除才算闰）。 */
export function isGregorianLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** 指定年月的天数（mo 1-12，非法月抛错）。 */
export function daysInMonth(y: number, mo: number): number {
  if (!Number.isInteger(mo) || mo < 1 || mo > 12) {
    throw new Error(`[schedule] 月份越界: ${mo}（合法 1-12）`);
  }
  if (mo === 2) return isGregorianLeap(y) ? 29 : 28;
  return MONTH_DAYS[mo - 1] as number;
}

/** 公历 (y,mo,d) → 自 1970-01-01 起的天数（Hinnant days_from_civil）。 */
export function daysFromCivil(y: number, mo: number, d: number): number {
  const yy = mo <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400; // [0, 399]
  const mp = mo <= 2 ? mo + 9 : mo - 3; // 三月起算的月序 [0, 11]
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1; // [0, 365]
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** 自 1970-01-01 起的天数 → 公历 (y,mo,d)（Hinnant civil_from_days）。 */
export function civilFromDays(z: number): { y: number; mo: number; d: number } {
  const shifted = z + 719468;
  const era = Math.floor(shifted / 146097);
  const doe = shifted - era * 146097; // [0, 146096]
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  ); // [0, 399]
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)); // [0, 365]
  const mp = Math.floor((5 * doy + 2) / 153); // [0, 11]
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1; // [1, 31]
  const mo = mp < 10 ? mp + 3 : mp - 9; // [1, 12]
  return { y: mo <= 2 ? y + 1 : y, mo, d };
}

/** 天序 → 星期（0=周日；1970-01-01 为周四(4)）。 */
export function weekdayFromDays(z: number): number {
  return (((z + 4) % 7) + 7) % 7;
}

// ============================================================
// 时区墙钟（Intl formatToParts 反算法；DST 偏差备案见文件头）
// ============================================================

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Intl.DateTimeFormat 按 tz 缓存（构造即校验 tz：非法 IANA 名在此抛 RangeError）。 */
const wallFormatCache = new Map<string, Intl.DateTimeFormat>();

function wallFormat(tz: string): Intl.DateTimeFormat {
  const cached = wallFormatCache.get(tz);
  if (cached !== undefined) return cached;
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  wallFormatCache.set(tz, dtf);
  return dtf;
}

/** UTC ms → IANA 时区本地墙钟。 */
export function utcToLocalWall(tz: string, ms: number): LocalWall {
  const parts = wallFormat(tz).formatToParts(new Date(ms));
  const num = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (part === undefined) {
      throw new Error(`[schedule] Intl formatToParts 缺少 ${type} 段（tz=${tz}）`);
    }
    return Number(part.value);
  };
  const wd = parts.find((p) => p.type === 'weekday');
  const weekday = wd === undefined ? undefined : WEEKDAY_INDEX[wd.value];
  if (weekday === undefined) {
    throw new Error(`[schedule] Intl weekday 段无法解析（tz=${tz}）`);
  }
  return {
    y: num('year'),
    mo: num('month'),
    d: num('day'),
    h: num('hour'),
    mi: num('minute'),
    s: num('second'),
    weekday,
  };
}

/** 指定时刻 tz 的 UTC 偏移（分钟；东八=+480）。 */
function tzOffsetMinutes(tz: string, ms: number): number {
  const floor = Math.floor(ms / 60_000) * 60_000; // 分钟粒度对齐
  const w = utcToLocalWall(tz, floor);
  const asUtc = new Date(0);
  asUtc.setUTCFullYear(w.y, w.mo - 1, w.d);
  asUtc.setUTCHours(w.h, w.mi, w.s, 0);
  return (asUtc.getTime() - floor) / 60_000;
}

/**
 * 本地墙钟 → UTC ms（Intl formatToParts 反算法 + 单次偏移复核）。
 * 非法日期（2 月 30 日、13 月、25 时等）fail-fast 抛错——cron 日历扫描器
 * 自身保证只生成合法公历日；DST 跳变日墙钟直算，偏差备案（v1 语义）。
 */
export function localWallToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  tz: string,
): number {
  if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d) || !Number.isInteger(h) || !Number.isInteger(mi)) {
    throw new Error(`[schedule] 本地墙钟分量须为整数: y=${y} mo=${mo} d=${d} h=${h} mi=${mi}`);
  }
  if (mo < 1 || mo > 12) throw new Error(`[schedule] 月份越界: ${mo}（合法 1-12）`);
  if (d < 1 || d > daysInMonth(y, mo)) {
    throw new Error(`[schedule] 日期越界: ${y}-${mo}-${d}（该月 ${daysInMonth(y, mo)} 天）`);
  }
  if (h < 0 || h > 23) throw new Error(`[schedule] 小时越界: ${h}（合法 0-23）`);
  if (mi < 0 || mi > 59) throw new Error(`[schedule] 分钟越界: ${mi}（合法 0-59）`);
  const naive = new Date(0);
  naive.setUTCFullYear(y, mo - 1, d);
  naive.setUTCHours(h, mi, 0, 0);
  const base = naive.getTime();
  const off1 = tzOffsetMinutes(tz, base);
  let utc = base - off1 * 60_000;
  const off2 = tzOffsetMinutes(tz, utc);
  if (off2 !== off1) utc = base - off2 * 60_000; // 单次复核收敛（DST 边界）
  return utc;
}

// ============================================================
// cron 解析与推算
// ============================================================

/**
 * 解析单个 cron 字段（支持 `*` / 步进 / 列表 / 区间 / 区间步进；
 * `a/n` 按经典 Vixie 语义 ≡ a-max/n）。非法即抛错。
 */
function parseCronField(field: string, min: number, max: number, label: string): Set<number> {
  const out = new Set<number>();
  for (const raw of field.split(',')) {
    if (raw.length === 0) {
      throw new Error(`[schedule] cron ${label} 字段含空列表项: "${field}"`);
    }
    const slash = raw.indexOf('/');
    const base = slash === -1 ? raw : raw.slice(0, slash);
    if (base.length === 0) {
      throw new Error(`[schedule] cron ${label} 字段项缺基数: "${raw}"`);
    }
    const stepStr = slash === -1 ? null : raw.slice(slash + 1);
    let step = 1;
    if (stepStr !== null) {
      step = Number(stepStr);
      if (stepStr.length === 0 || !Number.isInteger(step) || step < 1) {
        throw new Error(`[schedule] cron ${label} 步进非法: "${raw}"`);
      }
    }
    let lo: number;
    let hi: number;
    if (base === '*') {
      lo = min;
      hi = max;
    } else if (base.includes('-')) {
      const seg = base.split('-');
      if (seg.length !== 2 || seg[0] === '' || seg[1] === '') {
        throw new Error(`[schedule] cron ${label} 区间非法: "${raw}"`);
      }
      lo = Number(seg[0] ?? '');
      hi = Number(seg[1] ?? '');
    } else {
      const v = Number(base);
      if (!Number.isInteger(v) || v < min || v > max) {
        throw new Error(`[schedule] cron ${label} 值越界: "${raw}"（合法 ${min}-${max}）`);
      }
      lo = v;
      hi = stepStr === null ? v : max; // Vixie: a/n ≡ a-max/n
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`[schedule] cron ${label} 区间非法: "${raw}"（合法 ${min}-${max}）`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** 解析 5 字段 cron 表达式；非法抛错。 */
export function parseCron(expr: string): ParsedCron {
  const tokens = expr.trim().split(/\s+/);
  if (tokens.length !== 5) {
    throw new Error(`[schedule] cron 表达式须为 5 字段（分 时 日 月 周）: "${expr}"`);
  }
  const fMin = tokens[0] ?? '';
  const fHour = tokens[1] ?? '';
  const fDom = tokens[2] ?? '';
  const fMon = tokens[3] ?? '';
  const fDow = tokens[4] ?? '';
  return {
    expr,
    minutes: parseCronField(fMin, 0, 59, '分'),
    hours: parseCronField(fHour, 0, 23, '时'),
    doms: parseCronField(fDom, 1, 31, '日'),
    months: parseCronField(fMon, 1, 12, '月'),
    dows: parseCronField(fDow, 0, 6, '周'),
    domStar: fDom === '*',
    dowStar: fDow === '*',
  };
}

/**
 * cron 下一次命中（严格晚于 afterMs 的本地分钟粒度）。
 * 逐"日"扫描（ civilFromDays 只生成合法公历日——月日越界自然跳过、闰年
 * 2 月 29 日按规则命中）；命中日内按"分钟序"找首个满足 时×分 的分钟点。
 * dom 与 dow 同时受限时按经典 cron 语义取 OR（仅其一受限则该者决定）。
 * 400 年硬边界：扫描恰 CRON_HORIZON_DAYS(146097) 天，越界未命中返回 null。
 */
export function nextCronFire(expr: string, afterMs: number, tz: string): number | null {
  const c = parseCron(expr);
  const start = utcToLocalWall(tz, afterMs); // 非法 tz 在此抛 RangeError
  const z0 = daysFromCivil(start.y, start.mo, start.d);
  const firstMod = start.h * 60 + start.mi + 1; // 严格晚于 afterMs 的首个本地分钟
  for (let i = 0; i < CRON_HORIZON_DAYS; i++) {
    const z = z0 + i;
    const day = civilFromDays(z);
    if (!c.months.has(day.mo)) continue;
    const domOk = c.doms.has(day.d);
    const dowOk = c.dows.has(weekdayFromDays(z));
    const dayOk =
      c.domStar && c.dowStar ? true : c.domStar ? dowOk : c.dowStar ? domOk : domOk || dowOk;
    if (!dayOk) continue;
    const lower = i === 0 ? firstMod : 0;
    for (let mod = lower; mod <= 1439; mod++) {
      const h = Math.floor(mod / 60);
      const mi = mod % 60;
      if (!c.hours.has(h) || !c.minutes.has(mi)) continue;
      const utc = localWallToUtc(day.y, day.mo, day.d, h, mi, tz);
      if (utc > afterMs) return utc;
      // utc <= afterMs（DST 跳变日墙钟直算回拨）：备案偏差下的保守守卫，继续扫描
    }
  }
  return null; // 400 年硬边界越界（不可命中表达式，防死循环）
}

// ============================================================
// 六原语统一入口
// ============================================================

const ISO_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** 解析 at 原语的本地化墙钟点（不带时区偏移）。 */
function parseIsoLocal(isoLocal: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const m = ISO_LOCAL_RE.exec(isoLocal);
  if (m === null) {
    throw new Error(
      `[schedule] at.isoLocal 非法（须 YYYY-MM-DDTHH:mm[:ss] 本地墙钟，不带时区偏移）: "${isoLocal}"`,
    );
  }
  return {
    y: Number(m[1] ?? ''),
    mo: Number(m[2] ?? ''),
    d: Number(m[3] ?? ''),
    h: Number(m[4] ?? ''),
    mi: Number(m[5] ?? ''),
    s: m[6] === undefined ? 0 : Number(m[6]),
  };
}

function resolveTz(specTz: string | undefined, paramTz: string | undefined): string {
  return specTz ?? paramTz ?? 'UTC';
}

function assertHhMm(hh: number, mm: number, label: string): void {
  if (!Number.isInteger(hh) || hh < 0 || hh > 23) {
    throw new Error(`[schedule] ${label}.hh 须为 0-23 整数: ${hh}`);
  }
  if (!Number.isInteger(mm) || mm < 0 || mm > 59) {
    throw new Error(`[schedule] ${label}.mm 须为 0-59 整数: ${mm}`);
  }
}

/** daily 原语：当日 hh:mm，已过则次日（严格晚于 afterMs）。 */
function nextDailyWall(hh: number, mm: number, tz: string, afterMs: number): number {
  assertHhMm(hh, mm, 'daily');
  const w = utcToLocalWall(tz, afterMs);
  const utc = localWallToUtc(w.y, w.mo, w.d, hh, mm, tz);
  if (utc > afterMs) return utc;
  const nd = civilFromDays(daysFromCivil(w.y, w.mo, w.d) + 1);
  return localWallToUtc(nd.y, nd.mo, nd.d, hh, mm, tz);
}

/** weekly 原语：今日起 7 天内首个匹配 weekday 且严格晚于 afterMs 的 hh:mm。 */
function nextWeeklyWall(
  weekday: number,
  hh: number,
  mm: number,
  tz: string,
  afterMs: number,
): number | null {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new Error(`[schedule] weekly.weekday 须为 0-6（0=周日）: ${weekday}`);
  }
  assertHhMm(hh, mm, 'weekly');
  const w = utcToLocalWall(tz, afterMs);
  const z0 = daysFromCivil(w.y, w.mo, w.d);
  for (let i = 0; i <= 7; i++) {
    const z = z0 + i;
    if (weekdayFromDays(z) !== weekday) continue;
    const day = civilFromDays(z);
    const utc = localWallToUtc(day.y, day.mo, day.d, hh, mm, tz);
    if (utc > afterMs) return utc;
  }
  return null; // 理论不可达（任一 weekday 7 天内必复现）
}

/**
 * 六原语统一入口: 下一次触发时刻（严格晚于 afterMs；at 一次性例外——
 * 过去时刻原样返回，由重放中枢触发后落 completed，迟到补发与崩溃自愈同机制）。
 * 不可命中返回 null（仅 cron 400 年硬边界可达）。
 */
export function nextFire(spec: ScheduleSpec, afterMs: number, tz?: string): number | null {
  if (!Number.isFinite(afterMs)) throw new Error(`[schedule] afterMs 须为有限数: ${afterMs}`);
  switch (spec.kind) {
    case 'after': {
      if (!Number.isFinite(spec.delayMs) || spec.delayMs < 0) {
        throw new Error(`[schedule] after.delayMs 须为非负数: ${spec.delayMs}`);
      }
      return afterMs + spec.delayMs;
    }
    case 'at': {
      const t = parseIsoLocal(spec.isoLocal);
      // 秒级以分钟墙钟换算后追加（DST 偏差备案口径下分钟粒度直算）
      return localWallToUtc(t.y, t.mo, t.d, t.h, t.mi, resolveTz(spec.tz, tz)) + t.s * 1_000;
    }
    case 'every': {
      if (!Number.isInteger(spec.intervalMs) || spec.intervalMs < EVERY_MIN_INTERVAL_MS) {
        throw new Error(
          `[schedule] every.intervalMs 须为整数且 ≥ ${EVERY_MIN_INTERVAL_MS}ms(60s): ${spec.intervalMs}`,
        );
      }
      // Unix 纪元对齐，严格 > afterMs
      return (Math.floor(afterMs / spec.intervalMs) + 1) * spec.intervalMs;
    }
    case 'cron':
      return nextCronFire(spec.expr, afterMs, resolveTz(spec.tz, tz));
    case 'daily':
      return nextDailyWall(spec.hh, spec.mm, resolveTz(spec.tz, tz), afterMs);
    case 'weekly':
      return nextWeeklyWall(spec.weekday, spec.hh, spec.mm, resolveTz(spec.tz, tz), afterMs);
    default: {
      const unknown: never = spec;
      throw new Error(`[schedule] 未知调度原语: ${JSON.stringify(unknown)}`);
    }
  }
}
