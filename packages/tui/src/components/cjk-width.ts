/**
 * cjk-width —— 东亚宽字符宽度函数（Unicode East Asian Width 简表）。
 *
 * BI-19 合约：表驱动、可测；全角区段宽 2、组合/零宽字符宽 0、其余宽 1。
 * 覆盖常用区段即可：
 * - 零宽：组合附加符号（U+0300..036F）、变体选择符（FE00..FE0F）、组合半符号
 *   （FE20..FE2F）、ZWJ/ZWNJ/ZWSP 等格式零宽字符（200B..200F、2060..2064、FEFF）；
 * - 宽字符（W/F）：Hangul Jamo 初声、CJK 部首/康熙部首/注音/日文假名、CJK 统一
 *   汉字（含 Ext A）、彝文、Hangul 音节、CJK 兼容表意、竖排/兼容形式、全角形式
 *   （FF00..FF60、FFE0..FFE6）、Emoji 主区段（1F300..1F64F、1F680..1F6FF、
 *   1F900..1F9FF）、CJK 扩展 B..F（20000..）；
 * - 控制字符（C0/C1）宽 0（网格写入时由调用方剥离换行，此处兜底）。
 *
 * 未读取 /home/yupeng/references/ 下任何源码；区段表按 Unicode EAW 公开规范重写。
 */

/** [起始码点, 结束码点, 宽度] 半开闭区间表（含两端）。 */
type WidthRange = readonly [start: number, end: number, width: 0 | 1 | 2];

/** 零宽区段：组合符号与格式零宽字符。 */
const ZERO_WIDTH_RANGES: readonly WidthRange[] = [
  [0x0300, 0x036f, 0], // Combining Diacritical Marks
  [0x0483, 0x0489, 0], // Hebrew/Arabic combining
  [0x0591, 0x05bd, 0], // Hebrew combining
  [0x0610, 0x061a, 0], // Arabic combining
  [0x064b, 0x065f, 0], // Arabic diacritics
  [0x0670, 0x0670, 0],
  [0x06d6, 0x06dc, 0], // Arabic combining
  [0x0900, 0x0902, 0], // Devanagari combining
  [0x093a, 0x093a, 0],
  [0x093c, 0x093c, 0],
  [0x0941, 0x0948, 0],
  [0x094d, 0x094d, 0],
  [0x0951, 0x0957, 0],
  [0x0e31, 0x0e31, 0], // Thai combining
  [0x0e34, 0x0e3a, 0],
  [0x0e47, 0x0e4e, 0],
  [0x200b, 0x200f, 0], // ZWSP/ZWNJ/ZWJ/LRM/RLM
  [0x2028, 0x202e, 0], // LS/PS/Bidi 控制与 RLO 等
  [0x2060, 0x2064, 0], // Word Joiner + invisible plus 等
  [0x20d0, 0x20f0, 0], // Combining marks for symbols
  [0xfe00, 0xfe0f, 0], // Variation Selectors
  [0xfe20, 0xfe2f, 0], // Combining Half Marks
  [0xfeff, 0xfeff, 0], // BOM / ZWNBSP
];

/** 宽字符区段：East Asian Width W/F 常用覆盖 + Emoji 主区段。 */
const WIDE_RANGES: readonly WidthRange[] = [
  [0x1100, 0x115f, 2], // Hangul Jamo 初声
  [0x231a, 0x231b, 2], // WATCH/HOURGLASS（EAW=W）
  [0x2329, 0x232a, 2], // 〈〉 CJK 括号
  [0x23e9, 0x23ec, 2], // ⏩⏪⏫⏬
  [0x23f0, 0x23f0, 2], // ⏰
  [0x23f3, 0x23f3, 2], // ⏳
  [0x25fd, 0x25fe, 2], // ◽◻
  [0x2614, 0x2615, 2], // ☔☕
  [0x2648, 0x2653, 2], // 十二星座
  [0x267f, 0x267f, 2], // ♿
  [0x2693, 0x2693, 2], // ⚓
  [0x26a1, 0x26a1, 2], // ⚡
  [0x26aa, 0x26ab, 2], // ⚪⚫
  [0x26bd, 0x26be, 2],
  [0x26c4, 0x26c5, 2],
  [0x26ce, 0x26ce, 2],
  [0x26d4, 0x26d4, 2],
  [0x26ea, 0x26ea, 2],
  [0x26f2, 0x26f3, 2],
  [0x26f5, 0x26f5, 2],
  [0x26fa, 0x26fa, 2],
  [0x26fd, 0x26fd, 2],
  [0x2705, 0x2705, 2], // ✅
  [0x270a, 0x270b, 2], // ✊✋
  [0x2728, 0x2728, 2], // ✨
  [0x274c, 0x274c, 2], // ❌
  [0x274e, 0x274e, 2],
  [0x2753, 0x2755, 2], // ❓❔❕
  [0x2757, 0x2757, 2],
  [0x2795, 0x2797, 2], // ➕➖➗
  [0x27b0, 0x27b0, 2],
  [0x27bf, 0x27bf, 2],
  [0x2b1b, 0x2b1c, 2],
  [0x2b50, 0x2b50, 2], // ⭐
  [0x2b55, 0x2b55, 2], // ⭕
  [0x2e80, 0x2e99, 2], // CJK 部首
  [0x2e9b, 0x2ef3, 2],
  [0x2f00, 0x2fd5, 2], // 康熙部首
  [0x2ff0, 0x2ffb, 2], // 表意文字描述符
  [0x3000, 0x303e, 2], // CJK 符号与标点（含全角空格 U+3000）
  [0x3041, 0x3096, 2], // 平假名
  [0x3099, 0x30ff, 2], // 片假名与浊点等
  [0x3105, 0x312f, 2], // 注音符号
  [0x3131, 0x318e, 2], // Hangul 兼容字母
  [0x3190, 0x31e3, 2], // CJK 兼容与注音扩展
  [0x31f0, 0x321e, 2],
  [0x3220, 0x3247, 2],
  [0x3250, 0x4dbf, 2], // 带圈汉字/CJK Ext A
  [0x4e00, 0x9fff, 2], // CJK 统一汉字
  [0xa000, 0xa4c6, 2], // 彝文
  [0xa960, 0xa97c, 2], // Hangul Jamo 扩展 A
  [0xac00, 0xd7a3, 2], // Hangul 音节
  [0xf900, 0xfaff, 2], // CJK 兼容表意
  [0xfe10, 0xfe19, 2], // 竖排形式
  [0xfe30, 0xfe4f, 2], // CJK 兼容形式
  [0xff00, 0xff60, 2], // 全角 ASCII 与半角片假名区
  [0xffe0, 0xffe6, 2], // 全角 ￥￠￡ 等
  [0x16fe0, 0x16fe4, 2], // 川黔滇苗文等
  [0x17000, 0x18aff, 2], // 西夏文
  [0x1b000, 0x1b2fb, 2], // 日文补充假名
  [0x1f004, 0x1f004, 2], // 🀄
  [0x1f0cf, 0x1f0cf, 2], // 🃏
  [0x1f18e, 0x1f18e, 2], // 🆎
  [0x1f191, 0x1f19a, 2], // 🆑🆒🆓🆔🆕🆖🆗🆙🆚
  [0x1f200, 0x1f2ff, 2],
  [0x1f300, 0x1f320, 2], // Misc Symbols & Pictographs 主段
  [0x1f32d, 0x1f335, 2],
  [0x1f337, 0x1f37c, 2],
  [0x1f37e, 0x1f393, 2],
  [0x1f3a0, 0x1f3ca, 2],
  [0x1f3cf, 0x1f3d3, 2],
  [0x1f3e0, 0x1f3f0, 2],
  [0x1f3f4, 0x1f3f4, 2],
  [0x1f3f8, 0x1f43e, 2],
  [0x1f440, 0x1f440, 2], // 👀
  [0x1f442, 0x1f4fc, 2],
  [0x1f4ff, 0x1f53d, 2],
  [0x1f54b, 0x1f54e, 2],
  [0x1f550, 0x1f567, 2],
  [0x1f57a, 0x1f57a, 2],
  [0x1f595, 0x1f596, 2],
  [0x1f5a4, 0x1f5a4, 2],
  [0x1f5fb, 0x1f64f, 2], // 地标到情感符号
  [0x1f680, 0x1f6c5, 2], // Transport & Map
  [0x1f6cc, 0x1f6cc, 2],
  [0x1f6d0, 0x1f6d2, 2],
  [0x1f6eb, 0x1f6ec, 2],
  [0x1f6f4, 0x1f6fc, 2],
  [0x1f7e0, 0x1f7eb, 2], // 🟠🟡🟢🟣🟤🔴🟢…
  [0x1f90c, 0x1f93a, 2], // Supplemental Symbols 主段
  [0x1f93c, 0x1f945, 2],
  [0x1f947, 0x1f9ff, 2],
  [0x1fa70, 0x1faff, 2], // Symbols & Pictographs Extended-A
  [0x20000, 0x2fffd, 2], // CJK Ext B..F 及兼容补充
  [0x30000, 0x3fffd, 2], // CJK Ext G..
];

/** 在升序区间表中二分查找码点宽度；未命中返回 fallback。 */
function lookup(cp: number, ranges: readonly WidthRange[], fallback: number): number {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = ranges[mid] as WidthRange;
    if (cp < range[0]) {
      hi = mid - 1;
    } else if (cp > range[1]) {
      lo = mid + 1;
    } else {
      return range[2];
    }
  }
  return fallback;
}

/**
 * 单个字符（可以是含代理对的完整码点字符串）的终端显示列宽。
 * 字符串为空或仅含未配对代理时返回 0。
 */
export function charWidth(char: string): number {
  if (char.length === 0) return 0;
  const cp = char.codePointAt(0);
  if (cp === undefined) return 0;
  // C0/C1 控制字符与 DEL：不做可见占位。
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp >= 0xd800 && cp <= 0xdfff) return 0; // 未配对代理兜底
  const zero = lookup(cp, ZERO_WIDTH_RANGES, -1);
  if (zero === 0) return 0;
  return lookup(cp, WIDE_RANGES, 1);
}

/** 字符串总显示列宽（按码点累加；控制符贡献 0）。 */
export function textWidth(text: string): number {
  let total = 0;
  for (const ch of text) total += charWidth(ch);
  return total;
}
