/**
 * BI-06.9 · 进程资源开销采样器测试。
 *
 * 全部 /proc 读取走 fixture 字符串注入 + 虚拟时钟/定时器，零真实 IO、
 * 零真实等待。覆盖：/proc 字段解析（comm 含空格括号）、cpuPct 公式、
 * 非 Linux unavailable 结构态不炸、proc-unreadable 结构态、滑动窗口淘汰、
 * overThreshold 各 breached 分支与 cpu 优先级、采样循环启停幂等。
 */
import { describe, expect, test } from "bun:test";
import {
  PROC_STATM_PATH,
  PROC_STAT_PATH,
  ResourceSampler,
  parseProcStat,
  parseProcStatm,
} from "./resource-sampler";
import type { SamplerTimer } from "./resource-sampler";
import type { Clock } from "./deadline";

/** 构造 /proc/self/stat fixture：comm 含空格与括号；utime/stime 落 token[11]/[12]。 */
const procStatFixture = (utime: number, stime: number): string =>
  `12345 (node server) R 1 1 1 1 1 1 1 1 1 1 ${utime} ${stime} 0 0 0 0 0 0 0 0 0 1000 100 100`;

/** 构造 /proc/self/statm fixture：resident 为 token[1]（页数）。 */
const procStatmFixture = (residentPages: number): string =>
  `1000 ${residentPages} 150 10 0 40 0`;

/** 可手动拨动的虚拟时钟。 */
class ManualClock implements Clock {
  #now = 0;
  now(): number {
    return this.#now;
  }
  advance(ms: number): void {
    this.#now += ms;
  }
  // 采样器自身不经 Clock 调度（周期循环走注入 SamplerTimer），此处仅为接口兼容 no-op。
  setTimeout(_handler: () => void, _ms: number): unknown {
    return undefined;
  }
  clearTimeout(_handle: unknown): void {
    return undefined;
  }
}

/** 可手动驱动的注入定时器：tick 先推时钟再触发回调（模拟周期采样）。 */
class ManualTimer implements SamplerTimer {
  readonly #callbacks = new Map<number, () => void>();
  #seq = 0;
  lastIntervalMs: number | undefined;

  constructor(private readonly clock: ManualClock) {}

  setInterval(handler: () => void, ms: number): unknown {
    const id = ++this.#seq;
    this.lastIntervalMs = ms;
    this.#callbacks.set(id, handler);
    return id;
  }

  clearInterval(handle: unknown): void {
    this.#callbacks.delete(handle as number);
  }

  get activeCount(): number {
    return this.#callbacks.size;
  }

  tick(times: number, stepMs = 0): void {
    for (let i = 0; i < times; i += 1) {
      if (stepMs > 0) this.clock.advance(stepMs);
      for (const handler of [...this.#callbacks.values()]) handler();
    }
  }
}

/** 计数式 /proc 读取器：每采样一次 utime+10、rss 页数+1。 */
function makeProcReader() {
  let statCalls = 0;
  return {
    statCalls: () => statCalls,
    read: (path: string): string => {
      if (path === PROC_STAT_PATH) {
        statCalls += 1;
        return procStatFixture(10 * statCalls, 5);
      }
      if (path === PROC_STATM_PATH) {
        return procStatmFixture(200 + statCalls);
      }
      throw new Error(`unexpected path: ${path}`);
    },
  };
}

describe("BI-06.9 /proc 字段解析（fixture 字符串注入）", () => {
  test("parseProcStat：comm 含空格与括号 (node server) → utime/stime 落 token[11]/[12]", () => {
    expect(parseProcStat(procStatFixture(60, 40))).toEqual({ utimeTicks: 60, stimeTicks: 40 });
  });

  test("parseProcStat：畸形输入 → null（无括号 / 字段缺失 / 非数值）", () => {
    expect(parseProcStat("12345 no-comm-here")).toBeNull();
    expect(parseProcStat("1 (x) R 1 1")).toBeNull();
    expect(parseProcStat("1 (x) R 1 1 1 1 1 1 1 1 1 1 a b")).toBeNull();
  });

  test("parseProcStatm：resident = token[1]（页数）", () => {
    expect(parseProcStatm(procStatmFixture(200))).toEqual({ residentPages: 200 });
  });

  test("parseProcStatm：畸形输入 → null（空串 / 单 token / 非数值）", () => {
    expect(parseProcStatm("")).toBeNull();
    expect(parseProcStatm("12")).toBeNull();
    expect(parseProcStatm("12 abc")).toBeNull();
  });
});

describe("BI-06.9 采样与滑动窗口", () => {
  test("首次采样：cpuPct=null（无基线），rssBytes=residentPages×pageSize", () => {
    const clock = new ManualClock();
    const sampler = new ResourceSampler({
      platform: "linux",
      readProc: (path) => (path === PROC_STAT_PATH ? procStatFixture(60, 40) : procStatmFixture(200)),
      clock,
    });
    expect(sampler.sample()).toEqual({
      available: true,
      atMs: 0,
      cpuTicks: 100,
      rssBytes: 819_200,
      cpuPct: null,
    });
  });

  test("二次采样：cpuPct = Δticks/tickHz ÷ Δ秒 ×100（精确值 25%）", () => {
    const clock = new ManualClock();
    const stats = [procStatFixture(60, 40), procStatFixture(80, 45)];
    let sampleIdx = 0;
    const sampler = new ResourceSampler({
      platform: "linux",
      readProc: (path) => {
        if (path === PROC_STAT_PATH) {
          const fixture = stats[sampleIdx] ?? stats[stats.length - 1] ?? "";
          sampleIdx += 1;
          return fixture;
        }
        return procStatmFixture(200);
      },
      clock,
      tickHz: 100,
    });
    const s1 = sampler.sample();
    expect(s1.available && s1.cpuPct).toBe(null);
    clock.advance(1_000);
    const s2 = sampler.sample();
    expect(s2.available && s2.cpuPct).toBe(25);
  });

  test("cpuTicks 回退（容器计量抖动）→ cpuPct 钳制为 0，不为负", () => {
    const clock = new ManualClock();
    const stats = [procStatFixture(80, 40), procStatFixture(30, 15)];
    let sampleIdx = 0;
    const sampler = new ResourceSampler({
      platform: "linux",
      readProc: (path) => {
        if (path === PROC_STAT_PATH) {
          const fixture = stats[sampleIdx] ?? stats[stats.length - 1] ?? "";
          sampleIdx += 1;
          return fixture;
        }
        return procStatmFixture(200);
      },
      clock,
    });
    sampler.sample();
    clock.advance(1_000);
    const s2 = sampler.sample();
    expect(s2.available && s2.cpuPct).toBe(0);
  });

  test("非 Linux 平台 → unsupported-platform 结构态：不炸、不读 /proc、窗口空", () => {
    const clock = new ManualClock();
    const sampler = new ResourceSampler({
      platform: "darwin",
      readProc: () => {
        throw new Error("must not read /proc on non-linux");
      },
      clock,
    });
    const result = sampler.sample();
    expect(result).toEqual({ available: false, reason: "unsupported-platform" });
    expect(sampler.stats()).toEqual({ samples: 0, cpuPct: null, rssBytes: null });
  });

  test("readProc 抛错 → proc-unreadable 结构态不炸", () => {
    const clock = new ManualClock();
    const sampler = new ResourceSampler({
      platform: "linux",
      readProc: () => {
        throw new Error("enoent");
      },
      clock,
    });
    expect(sampler.sample()).toEqual({ available: false, reason: "proc-unreadable" });
    expect(sampler.stats().samples).toBe(0);
  });

  test("/proc 内容畸形 → proc-unreadable 结构态", () => {
    const clock = new ManualClock();
    const sampler = new ResourceSampler({
      platform: "linux",
      readProc: (path) => (path === PROC_STAT_PATH ? "garbage-without-paren" : procStatmFixture(200)),
      clock,
    });
    expect(sampler.sample()).toEqual({ available: false, reason: "proc-unreadable" });
  });

  test("windowSize=3 连推 5 条 → 淘汰最旧，仅留最近 3 条（最新 rss 可观测）", () => {
    const clock = new ManualClock();
    const reader = makeProcReader();
    const sampler = new ResourceSampler({
      platform: "linux",
      readProc: reader.read,
      clock,
      windowSize: 3,
    });
    for (let i = 0; i < 5; i += 1) {
      clock.advance(1_000);
      sampler.sample();
    }
    const stats = sampler.stats();
    expect(stats.samples).toBe(3);
    // 第 5 次采样：rss 页数 = 200 + 5（makeProcReader 计数）。
    expect(stats.rssBytes).toBe(205 * 4096);
    expect(sampler.windowSize).toBe(3);
  });

  test("stats()：窗口整体 cpuPct = 首尾累计 tick 差换算", () => {
    const clock = new ManualClock();
    const reader = makeProcReader();
    const sampler = new ResourceSampler({
      platform: "linux",
      readProc: reader.read,
      clock,
      windowSize: 10,
    });
    sampler.sample(); // t=0：基线（utime=10, stime=5 → 15 ticks）
    clock.advance(1_000);
    sampler.sample(); // 25 ticks → 10%
    clock.advance(1_000);
    sampler.sample(); // 35 ticks → 10%
    const stats = sampler.stats();
    expect(stats.samples).toBe(3);
    // (35-15)/100Hz ÷ 2s ×100 = 10%
    expect(stats.cpuPct).toBe(10);
  });

  test("overThreshold：cpuPct 越界 → breached 'cpu'", () => {
    const clock = new ManualClock();
    const reader = makeProcReader();
    const sampler = new ResourceSampler({ platform: "linux", readProc: reader.read, clock });
    sampler.sample();
    clock.advance(1_000);
    sampler.sample(); // 最新区间 cpuPct = 10%
    expect(sampler.overThreshold({ cpuPct: 5 })).toEqual({ cpuPct: 10, rssBytes: 202 * 4096, breached: "cpu" });
  });

  test("overThreshold：rssBytes 越界 → breached 'rss'", () => {
    const clock = new ManualClock();
    const reader = makeProcReader();
    const sampler = new ResourceSampler({ platform: "linux", readProc: reader.read, clock });
    sampler.sample();
    clock.advance(1_000);
    sampler.sample();
    expect(sampler.overThreshold({ rssBytes: 1_000 }).breached).toBe("rss");
  });

  test("overThreshold：双越界 → 'cpu' 优先报告", () => {
    const clock = new ManualClock();
    const reader = makeProcReader();
    const sampler = new ResourceSampler({ platform: "linux", readProc: reader.read, clock });
    sampler.sample();
    clock.advance(1_000);
    sampler.sample();
    const verdict = sampler.overThreshold({ cpuPct: 5, rssBytes: 1_000 });
    expect(verdict.breached).toBe("cpu");
  });

  test("overThreshold：未越界 / 未设阈值 / 空窗口 → breached null", () => {
    const clock = new ManualClock();
    const reader = makeProcReader();
    const sampler = new ResourceSampler({ platform: "linux", readProc: reader.read, clock });
    // 空窗口：全 null 且未越界。
    expect(sampler.overThreshold({ cpuPct: 1 })).toEqual({ cpuPct: null, rssBytes: null, breached: null });
    sampler.sample();
    clock.advance(1_000);
    sampler.sample();
    expect(sampler.overThreshold({ cpuPct: 99, rssBytes: Number.MAX_SAFE_INTEGER }).breached).toBeNull();
    expect(sampler.overThreshold({}).breached).toBeNull();
  });
});

describe("BI-06.9 采样循环启停（注入 timer）", () => {
  test("start 传 intervalMs；tick 逐拍采样；重复 start 幂等；stop 后不再采样", () => {
    const clock = new ManualClock();
    const timer = new ManualTimer(clock);
    const reader = makeProcReader();
    const sampler = new ResourceSampler({
      platform: "linux",
      readProc: reader.read,
      clock,
      timer,
      windowSize: 10,
    });
    sampler.start(500);
    expect(sampler.running).toBe(true);
    expect(timer.lastIntervalMs).toBe(500);
    timer.tick(3, 1_000);
    expect(sampler.stats().samples).toBe(3);
    sampler.start(500); // 幂等：不叠加定时器
    expect(timer.activeCount).toBe(1);
    sampler.stop();
    expect(sampler.running).toBe(false);
    expect(timer.activeCount).toBe(0);
    timer.tick(2, 1_000); // stop 后回调不触发
    expect(sampler.stats().samples).toBe(3);
    sampler.stop(); // 幂等
    expect(timer.activeCount).toBe(0);
  });

  test("非 Linux 平台循环照常启停，但采样持续返回结构态、窗口保持空", () => {
    const clock = new ManualClock();
    const timer = new ManualTimer(clock);
    const sampler = new ResourceSampler({
      platform: "win32",
      readProc: () => {
        throw new Error("must not read /proc");
      },
      clock,
      timer,
    });
    sampler.start(100);
    timer.tick(2, 10);
    expect(sampler.stats()).toEqual({ samples: 0, cpuPct: null, rssBytes: null });
    sampler.stop();
    expect(timer.activeCount).toBe(0);
  });
});
