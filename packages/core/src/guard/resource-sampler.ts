/**
 * BI-06.9 — 进程资源开销采样器（ResourceSampler）。
 *
 * Linux 路径（工单钉死）：读取 /proc/self/stat 与 /proc/self/statm。
 * - /proc/self/stat 字段解析（man proc(5)，字段从 1 计数）：
 *   `pid (comm) state ppid ... utime stime ...`。comm 可能含空格与括号
 *   （如 "(node server)"），必须按最后一个 ')' 切分；其后 token[0] 对应
 *   第 3 字段 state，故 utime（第 14 字段）= token[11]、stime（第 15 字段）
 *   = token[12]，单位为 CPU tick，按 USER_HZ 换算秒（缺省 100，可注入）。
 * - /proc/self/statm 字段：`total resident shared text lib data dt`
 *   （单位：内存页）。resident = token[1]，乘以页大小（缺省 4096，可注入）
 *   得 RSS 字节数。
 * - cpuPct = Δ(utime+stime)/tickHz ÷ Δ墙钟秒 × 100（多线程进程可 >100）。
 *
 * 非 Linux 平台：sample() 返回 available:false 的 unavailable 结构态
 * （不抛错、不崩溃、不读 /proc）；/proc 读取失败或内容畸形同理返回
 * proc-unreadable 结构态。
 *
 * 滑动窗口：仅 available 的采样入窗，容量 windowSize 可配（缺省 60），
 * 溢出淘汰最旧。overThreshold 以最近一次采样判定（cpu 优先于 rss）；
 * stats() 提供窗口整体 CPU 百分比（首尾样本累计 tick 差换算）。
 * 采样循环 start/stop 基于注入 timer（缺省系统 setInterval）。
 */
import { readFileSync } from "node:fs";
import { Clock, systemClock } from "./deadline";

/** 单次采样结果：available=false 为结构态（平台不支持 / proc 不可读），不抛错。 */
export type SampleResult =
  | {
      available: true;
      atMs: number;
      /** utime+stime 累计 tick 数。 */
      cpuTicks: number;
      /** 常驻集合字节数（residentPages × pageSize）。 */
      rssBytes: number;
      /** 相对上一次可用采样的 CPU 百分比（首个可用采样为 null；多核可 >100）。 */
      cpuPct: number | null;
    }
  | { available: false; reason: "unsupported-platform" | "proc-unreadable" };

/** 窗口内的可用采样（入窗形态）。 */
export interface WindowEntry {
  readonly atMs: number;
  readonly cpuTicks: number;
  readonly rssBytes: number;
  readonly cpuPct: number | null;
}

export interface ResourceThresholds {
  /** CPU 百分比上限（按最近一个采样区间的 cpuPct 判定）。 */
  readonly cpuPct?: number;
  /** RSS 字节数上限（按最近一次采样判定）。 */
  readonly rssBytes?: number;
}

export interface ThresholdVerdict {
  cpuPct: number | null;
  rssBytes: number | null;
  /** 同时越界时按 'cpu' > 'rss' 优先级报告。 */
  breached: "cpu" | "rss" | null;
}

export interface WindowStats {
  /** 滑动窗口内的可用采样数。 */
  samples: number;
  /** 窗口整体 CPU 百分比（首尾样本累计 tick 差换算；可用样本 <2 为 null）。 */
  cpuPct: number | null;
  /** 最近一次采样的 RSS 字节数（窗口空为 null）。 */
  rssBytes: number | null;
}

/** 可注入周期定时器（采样循环启停）。 */
export interface SamplerTimer {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const systemSamplerTimer: SamplerTimer = {
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface ResourceSamplerOptions {
  /** 目标平台标识（缺省取 process.platform；非 "linux" 即结构态 unavailable）。 */
  readonly platform?: string;
  /** /proc 文件读取器（测试注入 fixture 字符串；缺省 node:fs 同步读）。 */
  readonly readProc?: (path: string) => string;
  /** USER_HZ（缺省 100；容器与主控 tick 率不一致时按实际值注入）。 */
  readonly tickHz?: number;
  /** 内存页大小（缺省 4096）。 */
  readonly pageSize?: number;
  /** 滑动窗口容量（缺省 60，最小 1）。 */
  readonly windowSize?: number;
  /** 时钟（缺省系统时钟）。 */
  readonly clock?: Clock;
  /** 周期定时器（缺省系统定时器）。 */
  readonly timer?: SamplerTimer;
}

/** /proc/self/stat 读取路径。 */
export const PROC_STAT_PATH = "/proc/self/stat";
/** /proc/self/statm 读取路径。 */
export const PROC_STATM_PATH = "/proc/self/statm";

/**
 * 解析 /proc/self/stat 的 utime/stime（tick 数）。
 * comm 含空格/括号时按最后一个 ')' 切分；切分后 token[0]=第 3 字段 state，
 * utime=token[11]、stime=token[12]。畸形输入（无括号/字段缺失/非数值）返回 null。
 */
export function parseProcStat(stat: string): { utimeTicks: number; stimeTicks: number } | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const rest = stat.slice(close + 1).trim().split(/\s+/);
  const utimeRaw = rest[11];
  const stimeRaw = rest[12];
  if (utimeRaw === undefined || stimeRaw === undefined) return null;
  const utime = Number(utimeRaw);
  const stime = Number(stimeRaw);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { utimeTicks: utime, stimeTicks: stime };
}

/** 解析 /proc/self/statm 的 resident 页数（token[1]）；畸形输入返回 null。 */
export function parseProcStatm(statm: string): { residentPages: number } | null {
  const tokens = statm.trim().split(/\s+/);
  const raw = tokens[1];
  if (raw === undefined) return null;
  const resident = Number(raw);
  if (!Number.isFinite(resident) || resident < 0) return null;
  return { residentPages: resident };
}

export class ResourceSampler {
  readonly #platform: string;
  readonly #readProc: (path: string) => string;
  readonly #tickHz: number;
  readonly #pageSize: number;
  readonly #windowSize: number;
  readonly #clock: Clock;
  readonly #timer: SamplerTimer;
  readonly #window: WindowEntry[] = [];
  #timerHandle: unknown;
  #running = false;

  constructor(options: ResourceSamplerOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#readProc = options.readProc ?? ((path: string) => readFileSync(path, "utf8"));
    this.#tickHz = options.tickHz ?? 100;
    this.#pageSize = options.pageSize ?? 4096;
    this.#windowSize = Math.max(1, options.windowSize ?? 60);
    this.#clock = options.clock ?? systemClock;
    this.#timer = options.timer ?? systemSamplerTimer;
  }

  /** 滑动窗口容量。 */
  get windowSize(): number {
    return this.#windowSize;
  }

  /** 采样循环是否在运行。 */
  get running(): boolean {
    return this.#running;
  }

  /** 立即采样一次并推入滑动窗口（不可用时返回结构态，不推入窗口）。 */
  sample(): SampleResult {
    if (this.#platform !== "linux") {
      return { available: false, reason: "unsupported-platform" };
    }
    let stat: string;
    let statm: string;
    try {
      stat = this.#readProc(PROC_STAT_PATH);
      statm = this.#readProc(PROC_STATM_PATH);
    } catch {
      return { available: false, reason: "proc-unreadable" };
    }
    const parsedStat = parseProcStat(stat);
    const parsedStatm = parseProcStatm(statm);
    if (parsedStat === null || parsedStatm === null) {
      return { available: false, reason: "proc-unreadable" };
    }
    const atMs = this.#clock.now();
    const cpuTicks = parsedStat.utimeTicks + parsedStat.stimeTicks;
    const rssBytes = parsedStatm.residentPages * this.#pageSize;
    const prev = this.#window[this.#window.length - 1];
    let cpuPct: number | null = null;
    if (prev !== undefined && atMs > prev.atMs) {
      const deltaTicks = Math.max(0, cpuTicks - prev.cpuTicks);
      cpuPct = Math.max(0, (deltaTicks / this.#tickHz) / ((atMs - prev.atMs) / 1_000) * 100);
    }
    const entry: WindowEntry = { atMs, cpuTicks, rssBytes, cpuPct };
    this.#window.push(entry);
    if (this.#window.length > this.#windowSize) this.#window.shift();
    return { available: true, atMs, cpuTicks, rssBytes, cpuPct };
  }

  /** 窗口统计（仅统计可用采样）。 */
  stats(): WindowStats {
    const first = this.#window[0];
    const latest = this.#window[this.#window.length - 1];
    let cpuPct: number | null = null;
    if (first !== undefined && latest !== undefined && latest.atMs > first.atMs) {
      const deltaTicks = Math.max(0, latest.cpuTicks - first.cpuTicks);
      cpuPct = Math.max(0, (deltaTicks / this.#tickHz) / ((latest.atMs - first.atMs) / 1_000) * 100);
    }
    return {
      samples: this.#window.length,
      cpuPct,
      rssBytes: latest === undefined ? null : latest.rssBytes,
    };
  }

  /** 按最近采样评估阈值越界（cpu 优先于 rss；无可用采样为全 null、未越界）。 */
  overThreshold(thresholds: ResourceThresholds): ThresholdVerdict {
    const latest = this.#window[this.#window.length - 1];
    const cpuPct = latest === undefined ? null : latest.cpuPct;
    const rssBytes = latest === undefined ? null : latest.rssBytes;
    let breached: "cpu" | "rss" | null = null;
    if (thresholds.cpuPct !== undefined && cpuPct !== null && cpuPct > thresholds.cpuPct) {
      breached = "cpu";
    } else if (
      thresholds.rssBytes !== undefined &&
      rssBytes !== null &&
      rssBytes > thresholds.rssBytes
    ) {
      breached = "rss";
    }
    return { cpuPct, rssBytes, breached };
  }

  /** 启动采样循环（重复 start 为幂等 no-op）。 */
  start(intervalMs: number): void {
    if (this.#running) return;
    this.#running = true;
    this.#timerHandle = this.#timer.setInterval(() => {
      this.sample();
    }, Math.max(0, intervalMs));
  }

  /** 停止采样循环（未运行时为幂等 no-op）。 */
  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    this.#timer.clearInterval(this.#timerHandle);
    this.#timerHandle = undefined;
  }
}
