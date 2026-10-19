import { describe, expect, test } from "bun:test";
import { uuid7, uuid7TimestampMs } from "./uuid7";

/** 单调伪推进容差：批量生成把内部时间戳推到墙钟前的最大毫秒数（见对齐用例注释）。 */
const MONOTONIC_PUSH_SLACK_MS = 10;

describe("uuid7（RFC 9562）", () => {
  test("格式符合 v7 布局：版本位 7、变体位 10b、小写规范格式", () => {
    for (let i = 0; i < 200; i++) {
      const id = uuid7();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  test("唯一性：10000 个 id 无重复", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10000; i++) {
      seen.add(uuid7());
    }
    expect(seen.size).toBe(10000);
  });

  test("时序有序：连续生成的 id 字典序严格递增（字典序=时间序）", () => {
    let prev = uuid7();
    for (let i = 0; i < 2000; i++) {
      const id = uuid7();
      expect(id > prev).toBe(true);
      expect(uuid7TimestampMs(id)).toBeGreaterThanOrEqual(uuid7TimestampMs(prev) as number);
      prev = id;
    }
  });

  test("时间戳提取：内嵌 unix 毫秒与系统时钟对齐", () => {
    const before = Date.now();
    const id = uuid7();
    const after = Date.now();
    const ts = uuid7TimestampMs(id);
    expect(ts).not.toBeNull();
    expect(ts as number).toBeGreaterThanOrEqual(before);
    // 上界留单调推进容差：前序批量用例（如 10000 唯一性）同毫秒超 4096 条时，
    // 实现按 RFC 9562 §6.2 把时间戳伪推进 1ms，内部时钟可短暂领先墙钟。
    expect(ts as number).toBeLessThanOrEqual(after + MONOTONIC_PUSH_SLACK_MS);
  });

  test("时间戳提取：非法输入返回 null", () => {
    expect(uuid7TimestampMs("")).toBeNull();
    expect(uuid7TimestampMs("not-a-uuid")).toBeNull();
    expect(uuid7TimestampMs("00000000-0000-1000-8000-000000000000")).toBeNull(); // 版本位非 7
    expect(uuid7TimestampMs("00000000-0000-7000-c000-000000000000")).toBeNull(); // 变体位非法
    expect(uuid7TimestampMs("00000000-0000-7000-8000-00000000000")).toBeNull(); // 长度不符
  });

  test("边界：时间戳超范围抛 RangeError", () => {
    expect(() => uuid7(-1)).toThrow(RangeError);
    expect(() => uuid7(2 ** 48)).toThrow(RangeError);
    expect(() => uuid7(Number.NaN)).toThrow(RangeError);
  });

  // 注意：注入时间戳会推进模块内单调状态，务必保持本文件最后一个测试，
  // 且其他测试文件不断言默认生成 id 的内嵌时间戳与真实时钟的关系。
  test("注入时间戳（回放/测试场景）：可被精确提取且单调状态不被回退", () => {
    const future = 2 ** 47 - 1; // 48 位上限内
    const id = uuid7(future);
    expect(uuid7TimestampMs(id)).toBe(future);
    // 之后的默认调用仍严格大于注入生成的 id（时间戳沿用内部较大值）。
    expect(uuid7() > id).toBe(true);
  });
});
