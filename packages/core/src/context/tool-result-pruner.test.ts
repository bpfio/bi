/**
 * BI-08.1 · pruneToolResult 测试。
 *
 * 钉死语义：8192 阈值边界（等于不剪）、头 4096 / 尾 1024 保真、
 * 码点安全（代理对绝不截半）、退化配置守护、RangeError 配置房规。
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_HEAD_KEEP,
  DEFAULT_PRUNE_THRESHOLD,
  DEFAULT_TAIL_KEEP,
  codePointLength,
  pruneToolResult,
  takeCodePoints,
  takeLastCodePoints,
} from "./tool-result-pruner";

describe("BI-08.1 中间修剪 · 阈值边界", () => {
  test("恰好 8192 码点：不剪，原样返回", () => {
    const text = "a".repeat(8192);
    expect(pruneToolResult(text)).toBe(text);
  });

  test("8193 码点：触发修剪，omitted = 3073", () => {
    const text = "a".repeat(8193);
    const out = pruneToolResult(text);
    expect(out).toContain("[... tool result middle pruned: 3073 chars ...]");
  });

  test("标记格式精确：头 + 标记 + 尾直拼（无分隔符）", () => {
    const text = `${"H".repeat(4096)}${"M".repeat(3073)}${"T".repeat(1024)}`;
    const out = pruneToolResult(text);
    expect(out).toBe(`H`.repeat(4096) + "[... tool result middle pruned: 3073 chars ...]" + "T".repeat(1024));
  });

  test("头 4096 逐字保真、尾 1024 逐字保真（ASCII）", () => {
    const text = `${"H".repeat(5000)}${"M".repeat(9000)}${"T".repeat(3000)}`;
    const out = pruneToolResult(text);
    expect(out.startsWith("H".repeat(4096))).toBe(true);
    expect(out.endsWith("T".repeat(1024))).toBe(true);
    expect(out).not.toContain("M");
  });

  test("标记内的 N 随实际 omitted 变化", () => {
    const text = "x".repeat(9000);
    expect(pruneToolResult(text)).toContain("pruned: 3880 chars");
  });

  test("空串与阈值内短文本原样返回", () => {
    expect(pruneToolResult("")).toBe("");
    expect(pruneToolResult("short")).toBe("short");
  });

  test("自定义 opts：threshold/headKeep/tailKeep 全部生效", () => {
    const text = `${"A".repeat(60)}${"B".repeat(50)}${"C".repeat(40)}`;
    const out = pruneToolResult(text, { threshold: 100, headKeep: 30, tailKeep: 20 });
    expect(out.startsWith("A".repeat(30))).toBe(true);
    expect(out.endsWith("C".repeat(20))).toBe(true);
    expect(out).toContain("pruned: 100 chars");
    expect(codePointLength(out)).toBe(30 + 20 + "[... tool result middle pruned: 100 chars ...]".length);
  });
});

describe("BI-08.1 中间修剪 · 码点安全", () => {
  test("头侧边界落在代理对中段：整个代理对一起保留/舍弃，绝不截半", () => {
    // 第 4096 个码点处是 😀 的位置——UTF-16 朴素切片必截半，码点切片必须整对。
    const text = `${"a".repeat(4095)}${"😀".repeat(6000)}${"z".repeat(2000)}`;
    const out = pruneToolResult(text);
    expect(out.startsWith(`a`.repeat(4095) + "😀")).toBe(true);
    expect(out.endsWith("z".repeat(1024))).toBe(true);
    // 无孤立代理项：高代理后必跟低代理，低代理前必有高代理。
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(false);
    expect(out).toContain("pruned: 6975 chars");
  });

  test("尾侧边界同样码点安全", () => {
    const text = `${"y".repeat(7000)}${"😀".repeat(3000)}`;
    const out = pruneToolResult(text);
    expect(out.endsWith("😀")).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  });

  test("码点原语：takeCodePoints / takeLastCodePoints 边界行为", () => {
    const s = "a😀b";
    expect(codePointLength(s)).toBe(3);
    expect(takeCodePoints(s, 2)).toBe("a😀");
    expect(takeLastCodePoints(s, 2)).toBe("😀b");
    expect(takeCodePoints(s, 0)).toBe("");
    expect(takeLastCodePoints(s, 99)).toBe(s);
  });
});

describe("BI-08.1 中间修剪 · 配置守护", () => {
  test("头尾预算覆盖全文（omitted ≤ 0）：放弃修剪原样返回", () => {
    const text = "keep".repeat(5); // 20 码点
    expect(pruneToolResult(text, { threshold: 10, headKeep: 100, tailKeep: 100 })).toBe(text);
  });

  test("非法配置抛 RangeError：threshold 0 / NaN、headKeep 负数", () => {
    expect(() => pruneToolResult("x", { threshold: 0 })).toThrow(RangeError);
    expect(() => pruneToolResult("x", { threshold: Number.NaN })).toThrow(RangeError);
    expect(() => pruneToolResult("x", { headKeep: -1 })).toThrow(RangeError);
    expect(() => pruneToolResult("x", { tailKeep: -5 })).toThrow(RangeError);
  });

  test("默认常量钉死：8192 / 4096 / 1024", () => {
    expect(DEFAULT_PRUNE_THRESHOLD).toBe(8192);
    expect(DEFAULT_HEAD_KEEP).toBe(4096);
    expect(DEFAULT_TAIL_KEEP).toBe(1024);
  });
});
