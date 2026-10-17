/**
 * BI-05.4 · time-context 测试。
 *
 * 覆盖：文本块格式、时区偏移（东八/UTC/西半球夏令时）、elapsed 计算
 * （0s/59s/60s 边界、时钟回拨钳 0）、非法输入结构化错误、
 * TimeContextCache 10 分钟刷新窗边界（599999→null / 600000→新块）、
 * 多键独立、reset、注入时钟。
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_REFRESH_INTERVAL_MS,
  DEFAULT_TIMEZONE,
  TimeContextCache,
  TimeContextError,
  buildTimeContext,
} from "./time-context";

// 固定时刻：2026-10-16T04:34:56Z。
const ISO = "2026-10-16T04:34:56Z";

describe("BI-05.4 buildTimeContext · 文本块与时区", () => {
  test("默认时区 Asia/Shanghai（常量钉死），东八区偏移 +08:00", () => {
    expect(DEFAULT_TIMEZONE).toBe("Asia/Shanghai");
    const block = buildTimeContext({ isoNow: ISO });
    expect(block).toBe("Current time: 2026-10-16T12:34:56+08:00 (Asia/Shanghai, UTC+08:00)");
  });

  test("UTC 时区：+00:00，墙钟即 UTC", () => {
    const block = buildTimeContext({ isoNow: ISO, timezone: "UTC" });
    expect(block).toBe("Current time: 2026-10-16T04:34:56+00:00 (UTC, UTC+00:00)");
  });

  test("西半球夏令时：2026-10-16 纽约 EDT = UTC-04:00", () => {
    const block = buildTimeContext({ isoNow: ISO, timezone: "America/New_York" });
    expect(block).toBe("Current time: 2026-10-16T00:34:56-04:00 (America/New_York, UTC-04:00)");
  });

  test("跨日取整：UTC 20:00 → 上海次日 04:00", () => {
    const block = buildTimeContext({ isoNow: "2026-10-16T20:00:00Z", timezone: "Asia/Shanghai" });
    expect(block).toContain("Current time: 2026-10-17T04:00:00+08:00");
  });

  test("无 elapsedSince：不输出 Elapsed 行", () => {
    const block = buildTimeContext({ isoNow: ISO });
    expect(block).not.toContain("Elapsed:");
    expect(block.split("\n").length).toBe(1);
  });

  test("默认缺省 isoNow（墙钟）：能产出包含 Current time 的块", () => {
    const block = buildTimeContext();
    expect(block.startsWith("Current time: ")).toBe(true);
    expect(block).toContain(`(${DEFAULT_TIMEZONE},`);
  });
});

describe("BI-05.4 buildTimeContext · Elapsed 计算", () => {
  const epoch = Date.parse(ISO);

  test("3m 25s", () => {
    const block = buildTimeContext({ isoNow: ISO, elapsedSince: epoch - (3 * 60 + 25) * 1000 });
    expect(block.split("\n")[1]).toBe("Elapsed: 3m 25s since last turn");
  });

  test("边界：0 → 0m 0s；59 → 0m 59s；60 → 1m 0s", () => {
    expect(buildTimeContext({ isoNow: ISO, elapsedSince: epoch }).split("\n")[1]).toBe("Elapsed: 0m 0s since last turn");
    expect(buildTimeContext({ isoNow: ISO, elapsedSince: epoch - 59_000 }).split("\n")[1]).toBe("Elapsed: 0m 59s since last turn");
    expect(buildTimeContext({ isoNow: ISO, elapsedSince: epoch - 60_000 }).split("\n")[1]).toBe("Elapsed: 1m 0s since last turn");
  });

  test("时钟回拨（负 elapsed）钳到 0（裁定）", () => {
    const block = buildTimeContext({ isoNow: ISO, elapsedSince: epoch + 5_000 });
    expect(block.split("\n")[1]).toBe("Elapsed: 0m 0s since last turn");
  });
});

describe("BI-05.4 buildTimeContext · 结构化错误", () => {
  test("非法 isoNow → TimeContextError code=clock", () => {
    let err: unknown;
    try {
      buildTimeContext({ isoNow: "not-a-time" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TimeContextError);
    expect((err as TimeContextError).code).toBe("clock");
  });

  test("非法 timezone → TimeContextError code=config", () => {
    let err: unknown;
    try {
      buildTimeContext({ isoNow: ISO, timezone: "Mars/Olympus_Mons" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TimeContextError);
    expect((err as TimeContextError).code).toBe("config");
  });

  test("非法 elapsedSince（NaN）→ TimeContextError code=clock", () => {
    expect(() => buildTimeContext({ isoNow: ISO, elapsedSince: Number.NaN })).toThrow(TimeContextError);
  });
});

describe("BI-05.4 TimeContextCache · 10 分钟刷新窗", () => {
  test("常量钉死：600_000 ms", () => {
    expect(DEFAULT_REFRESH_INTERVAL_MS).toBe(600_000);
  });

  test("同键窗口内返回 null，跨过刷新窗重建", () => {
    let t = 1_000_000;
    const cache = new TimeContextCache({ now: () => t });
    const first = cache.get("k", { isoNow: ISO });
    expect(first).toContain("Current time: ");
    expect(cache.get("k", { isoNow: ISO })).toBeNull(); // 0ms < 600000
    t += 599_999;
    expect(cache.get("k", { isoNow: ISO })).toBeNull(); // 窗口内
    t += 1; // 累计 600_000：跨过刷新窗
    const fresh = cache.get("k", { isoNow: ISO });
    expect(fresh).not.toBeNull();
    expect(fresh).toContain("Current time: ");
  });

  test("边界精确：599999ms → null；600000ms → 新块（间隔语义 age >= 间隔即重建）", () => {
    let t = 0;
    const cache = new TimeContextCache({ now: () => t });
    cache.get("k", { isoNow: ISO });
    t = 599_999;
    expect(cache.get("k", { isoNow: ISO })).toBeNull();
    t = 600_000;
    expect(cache.get("k", { isoNow: ISO })).not.toBeNull();
  });

  test("多键相互独立：A 重建不影响 B 的窗口", () => {
    let t = 0;
    const cache = new TimeContextCache({ now: () => t });
    expect(cache.get("a", { isoNow: ISO })).not.toBeNull();
    t = 600_000;
    expect(cache.get("b", { isoNow: ISO })).not.toBeNull(); // 首建
    expect(cache.get("a", { isoNow: ISO })).not.toBeNull(); // a 到窗重建
    expect(cache.get("b", { isoNow: ISO })).toBeNull(); // b 仍在窗内
  });

  test("reset：清空刷新记录，下一 get 必重建", () => {
    let t = 0;
    const cache = new TimeContextCache({ now: () => t });
    expect(cache.get("k", { isoNow: ISO })).not.toBeNull();
    expect(cache.get("k", { isoNow: ISO })).toBeNull();
    cache.reset();
    expect(cache.get("k", { isoNow: ISO })).not.toBeNull();
  });

  test("非法 refreshIntervalMs 抛 RangeError；refreshIntervalMs=0 每次 get 都重建", () => {
    expect(() => new TimeContextCache({ refreshIntervalMs: -1 })).toThrow(RangeError);
    const cache = new TimeContextCache({ refreshIntervalMs: 0, now: () => 0 });
    expect(cache.get("k", { isoNow: ISO })).not.toBeNull();
    expect(cache.get("k", { isoNow: ISO })).not.toBeNull();
  });

  test("注入时钟与 opts 透传：重建时块内容跟随最新 opts", () => {
    let t = 0;
    const cache = new TimeContextCache({ now: () => t });
    cache.get("k", { isoNow: ISO });
    t = 600_000;
    const fresh = cache.get("k", { isoNow: ISO, elapsedSince: Date.parse(ISO) - 65_000 });
    expect(fresh?.split("\n")[1]).toBe("Elapsed: 1m 5s since last turn");
  });
});
