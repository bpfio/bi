import { describe, expect, test } from "bun:test";
import { charWidth, textWidth, segmentGraphemes, layoutPromptLine } from "./cjk-width";

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

describe("cjk-width —— segmentGraphemes 字素切分", () => {
  test("ASCII 逐码元即字素，index 连续", () => {
    const g = segmentGraphemes("abc");
    expect(g.map((x) => x.segment)).toEqual(["a", "b", "c"]);
    expect(g.map((x) => x.index)).toEqual([0, 1, 2]);
  });

  test("emoji 代理对计为单字素（index 跳过代理对）", () => {
    const g = segmentGraphemes("a🎉b");
    expect(g.map((x) => x.segment)).toEqual(["a", "🎉", "b"]);
    // 🎉 占两码元：b 的起始下标为 1 + 2 = 3
    expect(g.map((x) => x.index)).toEqual([0, 1, 3]);
  });

  test("CJK 每字一字素；组合字符（e+◌́）计为单字素", () => {
    expect(segmentGraphemes("你好").map((x) => x.segment)).toEqual(["你", "好"]);
    expect(segmentGraphemes("e\u0301").map((x) => x.segment)).toEqual(["e\u0301"]);
  });
});

describe("cjk-width —— layoutPromptLine 长行横向滚动", () => {
  test("短草稿不滚动：与 v1 渲染一致（含 ⏎ 摊平）", () => {
    expect(layoutPromptLine("abc", 3, 60)).toBe("❯ abc▏");
    expect(layoutPromptLine("ab", 1, 60)).toBe("❯ a▏b");
    expect(layoutPromptLine("你好", 1, 60)).toBe("❯ 你▏好");
    expect(layoutPromptLine("甲\n乙", 3, 60)).toBe("❯ 甲⏎乙▏");
  });

  test("超宽草稿：光标恒在可视窗口内、可见列宽 ≤ 可用列", () => {
    const wide = "0123456789abcdefghij"; // 20 个 ASCII，各宽 1
    const cols = 20; // 提示 2 + 条 1 = 3，可用 17 列
    // 光标在行尾（20）：窗口切片以光标为中心且夹到尾部
    const end = layoutPromptLine(wide, wide.length, cols);
    expect(end.endsWith("▏")).toBe(true);
    expect(textWidth(end.slice(2).replace("▏", ""))).toBeLessThanOrEqual(cols - 3);
    // 光标在中段（10 → 'a'）：条后首字为 'a'
    const mid = layoutPromptLine(wide, 10, cols);
    const bar = mid.indexOf("▏");
    expect(mid.slice(bar + 1, bar + 2)).toBe("a");
    expect(textWidth(mid.slice(2).replace("▏", ""))).toBeLessThanOrEqual(cols - 3);
  });
});
