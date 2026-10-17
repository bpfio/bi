/**
 * BI-06.9 — 进程资源开销采样器。
 *
 * Linux 路径：读取 /proc/self/stat 与 /proc/self/statm。
 * - /proc/self/stat：`pid (comm) state ppid ... utime stime ...`。
 *   comm 可能含空格与括号，必须按最后一个 ')' 切分；其后 token[0] 对应
 *   第 3 字段 state，故 utime(第14字段)=token[11]、stime(第15字段)=token[12]，
 *   单位为 CPU tick（USER_HZ，缺省按 100 换算）。
 * - /proc/self/statm：`total resident shared text lib data dt`（单位：页），
 *   resident=token[1]，乘以页大小（缺省 4096）得 RSS 字节数。
 * 非 Linux 平台返回 unavailable 结构态（不抛错、不崩溃）。
 */
import { Clock, systemClock } from './deadline';

/** 单次采样结果：available=false 为结构态（平台不支持 / proc 不可读），不抛错。 */
export type SampleResult =
  | {
      available: true;
      atMs: number;
      /** utime+stime 累计 tick 数。 */
      cpuTicks: number;
      /** 常驻集合字节数。 */
      rssBytes: number;
      /** 相对上一次可用采样的 CPU 百分比（首个可用采样为 null；多核可 >100）。 */
      cpuPct: number | null;
    }
  | { available: false; reason: 'unsupported-platform' | 'proc-unreadable' };

export interface ResourceThresholds {
  /** CPU 百分比上限（按最近一个采样区间的 cpuPct 判定）。 */
  cpuPct?: number;
  /** RSS 字节数上限（按最近一次采样判定）。 */
  rssBytes?: number;
}

export interface ThresholdVerdict {
  cpuPct: number | null;
  rssBytes: number | null;
  /** 同时越界时按 'cpu' > 'rss' 优先级报告。 */
  breached: 'cpu' | 'rss' | null;
}

export interface WindowStats {
  /** 滑动窗口内的可用采样数。 */
  samples: number;
  /** 窗口整体 CPU 百分比（首尾样本累计 tick 差换算；样本不足为 null）。 */
  cpuPct: number | null;
  /** 最近一次采样的 RSS 字节数。 */
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
  /** 缺省取 process.platform。 */
  platform?: string;
  /** /proc 文件读取器（测试注入 fixture 字符串）。 */
  readProc?: (path: string) => string;
  /** USER_HZ（缺省 100）。 */
  tickHz?: number;
  /** 内存页大小（缺省 4096）。 */
  pageSize?: number;
  /** 滑动窗口容量（缺省 60）。 */
  windowSize?: number;
  /** 时钟（缺省系统时钟）。 */
  clock?: Clock;
  /** 周期定时器（缺省系统定时器）。 */
  timer?: SamplerTimer;
}

/** 解析 /proc/self/stat 的 utime/stime（tick 数）；comm 含空格时按最后一个 ')' 切分。 */
export function parseProcStat(
  _stat: string,
): { utimeTicks: number; stimeTicks: number } | null {
  throw new Error('BI-06.9 not implemented');
}

/** 解析 /proc/self/statm 的 resident 页数。 */
export function parseProcStatm(_statm: string): { residentPages: number } | null {
  throw new Error('BI-06.9 not implemented');
}

export class ResourceSampler {
  constructor(_options: ResourceSamplerOptions = {}) {}

  /** 滑动窗口容量。 */
  get windowSize(): number {
    throw new Error('BI-06.9 not implemented');
  }

  /** 采样循环是否在运行。 */
  get running(): boolean {
    throw new Error('BI-06.9 not implemented');
  }

  /** 立即采样一次并推入滑动窗口（不可用时返回结构态，不推入窗口）。 */
  sample(): SampleResult {
    throw new Error('BI-06.9 not implemented');
  }

  /** 窗口统计。 */
  stats(): WindowStats {
    throw new Error('BI-06.9 not implemented');
  }

  /** 按最近采样评估阈值越界（cpu 优先于 rss；无可用采样为全 null）。 */
  overThreshold(_thresholds: ResourceThresholds): ThresholdVerdict {
    throw new Error('BI-06.9 not implemented');
  }

  /** 启动采样循环（重复 start 为幂等 no-op）。 */
  start(_intervalMs: number): void {
    throw new Error('BI-06.9 not implemented');
  }

  /** 停止采样循环（未运行时为幂等 no-op）。 */
  stop(): void {
    throw new Error('BI-06.9 not implemented');
  }
}
