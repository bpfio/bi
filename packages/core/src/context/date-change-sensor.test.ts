/**
 * BI-10.5 · date-change-sensor 测试。
 *
 * 覆盖：午夜边界矩阵（23:59:59→00:00:01 触发 / 同日内不触发 / 跨多日单
 * 触发 / 时区参数化）、首次登记建立基线不触发、注入时钟（纯 nowMs 计算）、
 * 外部态双模式、时钟回拨披露、非法输入。
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_DATE_TIMEZONE, DateChangeSensor } from "./date-change-sensor";

/** Asia/Shanghai 恒为 UTC+8：epoch = UTC 时刻 − 8h。 */
const SH = (y: number, mo: number, d: number, h: number, mi: number, s: number): number =>
  Date.UTC(y, mo - 1, d, h, mi, s) - 8 * 3_600_000;

describe("BI-10.5 · 首次登记与同日不触发", () => {
  test("首次 check 建立基线不触发（裁定：无前值无可披露）", () => {
    const s = new DateChangeSensor();
    const r = s.check(SH(2026, 10, 15, 12, 0, 0));
    expect(r.marker).toBeNull();
    expect(r.state).toEqual({ lastDate: "2026-10-15" });
  });

  test("同日内多次 check 不触发", () => {
    const s = new DateChangeSensor();
    s.check(SH(2026, 10, 15, 0, 0, 1));
    expect(s.check(SH(2026, 10, 15, 9, 30, 0)).marker).toBeNull();
    expect(s.check(SH(2026, 10, 15, 23, 59, 59)).marker).toBeNull();
  });
});

describe("BI-10.5 · 午夜边界矩阵", () => {
  test("23:59:59 → 00:00:01 触发，previousDate/currentDate 精确", () => {
    const s = new DateChangeSensor();
    s.check(SH(2026, 10, 15, 23, 59, 59)); // 2026-10-15 23:59:59 CST
    const r = s.check(SH(2026, 10, 16, 0, 0, 1)); // 2026-10-16 00:00:01 CST
    expect(r.marker).not.toBeNull();
    expect(r.marker?.kind).toBe("date_change");
    expect(r.marker?.previousDate).toBe("2026-10-15");
    expect(r.marker?.currentDate).toBe("2026-10-16");
    expect(r.state).toEqual({ lastDate: "2026-10-16" });
  });

  test("跨午夜后同日再查不触发（每自然日至多一次）", () => {
    const s = new DateChangeSensor();
    s.check(SH(2026, 10, 15, 23, 59, 59));
    s.check(SH(2026, 10, 16, 0, 0, 1)); // 触发
    expect(s.check(SH(2026, 10, 16, 12, 0, 0)).marker).toBeNull();
    expect(s.check(SH(2026, 10, 16, 23, 59, 59)).marker).toBeNull();
  });

  test("跨多日间隔单触发：10-15 基线 → 10-17 首查即一条 15→17 标记", () => {
    const s = new DateChangeSensor();
    s.check(SH(2026, 10, 15, 10, 0, 0));
    const r = s.check(SH(2026, 10, 17, 0, 0, 1));
    expect(r.marker).toEqual({
      kind: "date_change",
      previousDate: "2026-10-15",
      currentDate: "2026-10-17",
      note: expect.stringContaining("2026-10-17"),
    });
    expect(r.marker?.note).toContain("2026-10-15");
    expect(s.check(SH(2026, 10, 17, 8, 0, 0)).marker).toBeNull(); // 不逐日补发
  });

  test("时区参数化：同一 epoch，Shanghai 已跨午夜而 UTC 未跨", () => {
    const t = Date.UTC(2026, 9, 15, 16, 0, 1); // Shanghai 10-16 00:00:01 / UTC 10-15 16:00:01
    const sh = new DateChangeSensor({ timezone: "Asia/Shanghai" });
    sh.check(Date.UTC(2026, 9, 15, 15, 59, 59) - 8 * 3_600_000); // Shanghai 10-15 23:59:59
    const shR = sh.check(t);
    expect(shR.marker?.currentDate).toBe("2026-10-16");

    const utc = new DateChangeSensor({ timezone: "UTC" });
    utc.check(Date.UTC(2026, 9, 15, 15, 59, 59)); // UTC 10-15 23:59:59
    const utcR = utc.check(t);
    expect(utcR.marker).toBeNull(); // UTC 仍是 10-15
  });

  test("缺省时区 = Asia/Shanghai（与 time-context 对齐）", () => {
    expect(DEFAULT_DATE_TIMEZONE).toBe("Asia/Shanghai");
    const s = new DateChangeSensor();
    s.check(SH(2026, 10, 15, 23, 59, 59));
    expect(s.check(SH(2026, 10, 16, 0, 0, 1)).marker?.currentDate).toBe("2026-10-16");
  });

  test("时钟回拨（日期倒退）同样披露（裁定：日期假设失效即披露）", () => {
    const s = new DateChangeSensor();
    s.check(SH(2026, 10, 16, 12, 0, 0));
    const r = s.check(SH(2026, 10, 15, 12, 0, 0)); // 回到前一天
    expect(r.marker?.previousDate).toBe("2026-10-16");
    expect(r.marker?.currentDate).toBe("2026-10-15");
  });
});

describe("BI-10.5 · 外部态双模式与非法输入", () => {
  test("外部态模式：纯函数式求值，实例内部态不被污染", () => {
    const s = new DateChangeSensor();
    s.check(SH(2026, 10, 15, 12, 0, 0)); // 内部基线 = 10-15
    // 外部态给出 10-01：以外部态求值并触发，但内部基线保持 10-15。
    const r = s.check(SH(2026, 10, 16, 0, 0, 1), { lastDate: "2026-10-01" });
    expect(r.marker?.previousDate).toBe("2026-10-01");
    expect(r.state).toEqual({ lastDate: "2026-10-16" });
    // 内部模式继续：以 10-15 → 10-16 触发（内部未被外部态污染）。
    const inner = s.check(SH(2026, 10, 16, 0, 0, 2));
    expect(inner.marker?.previousDate).toBe("2026-10-15");
  });

  test("外部态 lastDate=null：视同首次登记，只建基线不触发", () => {
    const s = new DateChangeSensor();
    const r = s.check(SH(2026, 10, 15, 12, 0, 0), { lastDate: null });
    expect(r.marker).toBeNull();
    expect(r.state).toEqual({ lastDate: "2026-10-15" });
  });

  test("reset 后重新登记基线（不触发）", () => {
    const s = new DateChangeSensor();
    s.check(SH(2026, 10, 15, 12, 0, 0));
    s.reset();
    expect(s.check(SH(2026, 10, 16, 0, 0, 1)).marker).toBeNull();
  });

  test("非法 nowMs（NaN/Infinity）→ RangeError", () => {
    const s = new DateChangeSensor();
    expect(() => s.check(Number.NaN)).toThrow(RangeError);
    expect(() => s.check(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  test("非法时区：构造期即抛 RangeError", () => {
    expect(() => new DateChangeSensor({ timezone: "Mars/Olympus" })).toThrow(RangeError);
  });

  test("note 披露说明含时区与两侧日期", () => {
    const s = new DateChangeSensor({ timezone: "Asia/Shanghai" });
    s.check(SH(2026, 10, 15, 23, 59, 59));
    const note = s.check(SH(2026, 10, 16, 0, 0, 1)).marker?.note ?? "";
    expect(note).toContain("Asia/Shanghai");
    expect(note).toContain("2026-10-15");
    expect(note).toContain("2026-10-16");
  });
});
