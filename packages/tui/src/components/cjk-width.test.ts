import { describe, expect, test } from "bun:test";
import { charWidth, textWidth } from "./cjk-width";

describe("cjk-width —— 窄字符（宽度 1）", () => {
  test("ASCII 可打印字符", () => {
    expect(charWidth("a")).toBe(1);
    expect(charWidth("Z")).toBe(1);
    expect(charWidth("0")).toBe(1);
    expect(charWidth("~")).toBe(1);
    expect(charWidth(" ")).toBe(1);
  });

  test("半角片假名与半角符号（FF61..、FFE8..）为 1", () => {
    expect(charWidth("\uFF71")).toBe(1); // ｱ halfwidth katakana
    expect(charWidth("\uFF61")).toBe(1); // ｡ halfwidth ideographic full stop
    expect(charWidth("\uFFE8")).toBe(1); // ￨ halfwidth forms
  });

  test("EAW Neutral 边界：易经卦符与 Hangul 中声填充", () => {
    expect(charWidth("\u4DC0")).toBe(1); // ䷀ Hexagram（EAW=N）
    expect(charWidth("\u1160")).toBe(1); // Hangul Jungseong filler（EAW=N）
    expect(charWidth("\u2FFF")).toBe(1); // CJK 符号区前空档
  });
});

describe("cjk-width —— 宽字符（宽度 2）", () => {
  test("CJK 统一汉字", () => {
    expect(charWidth("中")).toBe(2);
    expect(charWidth("文")).toBe(2);
    expect(charWidth("\u9FFF")).toBe(2);
    expect(charWidth("\u4DBF")).toBe(2); // Ext A 末位
    expect(charWidth("\u3400")).toBe(2); // Ext A 首位
  });

  test("日文假名与 CJK 标点", () => {
    expect(charWidth("あ")).toBe(2);
    expect(charWidth("ア")).toBe(2);
    expect(charWidth("\u3002")).toBe(2); // 。
    expect(charWidth("\u3000")).toBe(2); // 全角空格
  });

  test("谚文（Hangul 音节与 Jamo 初声）", () => {
    expect(charWidth("한")).toBe(2);
    expect(charWidth("\u1100")).toBe(2);
    expect(charWidth("\u115F")).toBe(2);
  });

  test("全角形式区（FF00..FF60、FFE0..FFE6）", () => {
    expect(charWidth("\uFF21")).toBe(2); // Ａ
    expect(charWidth("\uFF0C")).toBe(2); // ，
    expect(charWidth("\uFFE0")).toBe(2); // ￥
    expect(charWidth("\uFFE6")).toBe(2); // ￦
  });

  test("Emoji 主区段（含代理对输入）", () => {
    expect(charWidth("😀")).toBe(2); // U+1F600
    expect(charWidth("🚀")).toBe(2); // U+1F680
    expect(charWidth("👍")).toBe(2); // U+1F44D
    expect(charWidth("\u2705")).toBe(2); // ✅
    expect(charWidth("\u2B50")).toBe(2); // ⭐
    expect(charWidth("\u{1F004}")).toBe(2); // 🀄（码点转义）
  });
});

describe("cjk-width —— 零宽（宽度 0）", () => {
  test("组合附加符号", () => {
    expect(charWidth("\u0301")).toBe(0); // combining acute
    expect(charWidth("\u0338")).toBe(0);
  });

  test("格式零宽：ZWSP / ZWNJ / ZWJ / 变体选择符 / BOM", () => {
    expect(charWidth("\u200B")).toBe(0);
    expect(charWidth("\u200C")).toBe(0);
    expect(charWidth("\u200D")).toBe(0);
    expect(charWidth("\uFE0F")).toBe(0); // VS16
    expect(charWidth("\uFEFF")).toBe(0);
  });

  test("控制字符与空串", () => {
    expect(charWidth("\n")).toBe(0);
    expect(charWidth("\x1b")).toBe(0);
    expect(charWidth("\x7f")).toBe(0);
    expect(charWidth("")).toBe(0);
  });

  test("未配对代理项兜底为 0", () => {
    expect(charWidth("\uD800")).toBe(0);
  });
});

describe("cjk-width —— textWidth 汇总", () => {
  test("中英混排", () => {
    expect(textWidth("a中b")).toBe(4);
    expect(textWidth("中文abc")).toBe(7);
  });

  test("组合字符不占列", () => {
    expect(textWidth("e\u0301")).toBe(1);
  });

  test("emoji 与空串", () => {
    expect(textWidth("😀!")).toBe(3);
    expect(textWidth("")).toBe(0);
  });
});
