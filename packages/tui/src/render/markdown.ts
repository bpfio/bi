/**
 * render/markdown —— 助手消息 markdown → 带样式视图行（BI-27.3 富文本转录）。
 *
 * 手写解析器，零 npm 依赖。渲染产物为 MarkdownRow（样式分段 spans），全部经
 * VirtualTerminal.write(x, y, text, style) 落格——不产生任何裸转义序列；SGR
 * 发射归 DiffRenderer（按网格单元样式最小差量）。支持最小子集：
 * - ATX 标题 `#{1,6} `：粗体 + 前景色（标记剥离）；
 * - 行内：**粗体** / __粗体__、*斜体* / _斜体_（贴字边界规则）、`行内代码`、
 *   `\` 转义；嵌套（粗体包斜体/代码）有界递归；
 * - 围栏代码块 ``` / ~~~：内容行整体 dim；语言为 latex/tex/math 走 renderLatex
 *   （BI-19.8 现成器官）、mermaid 走 renderMermaid（BI-19.6 现成器官），二者
 *   均为纯 string[] 产物（cell-grid 安全、不抛异常），直接透传落格；
 * - 列表：无序 `-`/`*`/`+` → `•`（缩进保留），有序 `1.` 原样透传；
 * - 折行：按显示列宽贪心（CJK 宽字符计 2 列），样式跨行延续。
 *
 * 诚实边界：
 * - 未识别/畸形 markdown 一律按普通文本行透传，解析全程不抛异常（renderMarkdown
 *   外层另有 try/catch 兜底退化为纯文本行）；
 * - 围栏块内容（含 latex/mermaid 产物）不折行，超宽由网格裁掉（画布即视口）；
 * - 斜体/粗体的「贴字边界」是务实近似（`a_b_c` 不触发斜体），非完整 CommonMark；
 * - styled 折行按码点游走（不做字素簇/emoji 组合序列的整单元换行），含 ZWJ
 *   emoji 的 assistant 文本折行点可能与 L3 unit 折行相差一个码点（仅影响
 *   assistant 富文本行，plain 条目走 transcript-projection.wrapLine 不受影响）。
 */

import type { CellStyle } from "../engine/virtual-terminal";
import { charWidth } from "../components/cjk-width";
import { renderLatex } from "./latex";
import { renderMermaid } from "../merman/mermaid-renderer";

/** 带样式文本分段（style 缺省 = 默认样式）。 */
export interface MarkdownSpan {
  readonly text: string;
  readonly style?: CellStyle;
}

/** 视图行：分段序列（拼接即该行显示文本）。 */
export interface MarkdownRow {
  readonly spans: readonly MarkdownSpan[];
}

/** 渲染选项。 */
export interface MarkdownRenderOptions {
  /**
   * 首行缩进预算（显示列）：正文首行前方已有 `[assistant] ` 前缀占位时，
   * 首逻辑行按 width - indent 预算折行（其余行仍按 width）。
   */
  readonly firstRowIndent?: number;
}

/** 行拼接纯文本（帧探针/测试断言用）。 */
export function rowPlain(row: MarkdownRow): string {
  return row.spans.map((s) => s.text).join("");
}

// ---------------------------------------------------------------------------
// 样式约定（DiffRenderer SGR 发射的色名取值即此表的键）
// ---------------------------------------------------------------------------

const STYLE_HEADING: CellStyle = { bold: true, fg: "cyan" };
const STYLE_CODE_INLINE: CellStyle = { fg: "cyan" };
const STYLE_CODE_BLOCK: CellStyle = { dim: true };

// ---------------------------------------------------------------------------
// 行内解析（有界递归）
// ---------------------------------------------------------------------------

/** 递归深度上限（嵌套粗斜体等；超限按字面透传，防畸形输入深递归）。 */
const MAX_INLINE_DEPTH = 8;

/** 把已解析的子 spans 加上一层样式（叠加而非覆盖，粗体包代码等场景）。 */
function withStyle(spans: MarkdownSpan[], extra: CellStyle): MarkdownSpan[] {
  return spans.map((s) => ({ text: s.text, style: { ...extra, ...(s.style ?? {}) } }));
}

/** 判定行内定界符是否「贴字」：紧邻内侧非空白（星号与下划线定界务实边界规则）。 */
function huggedOpen(text: string, start: number): boolean {
  const ch = text[start];
  return ch !== undefined && !/\s/.test(ch);
}

function huggedClose(text: string, end: number): boolean {
  // end 指向闭定界符下标；其前一字符须非空白
  const ch = text[end - 1];
  return ch !== undefined && !/\s/.test(ch);
}

/** 词字符（下划线 intraword 抑制判定：ASCII 字母/数字/下划线）。 */
function isWordChar(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return false;
  const code = text.charCodeAt(index);
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    code === 0x5f // _
  );
}

/**
 * 行内扫描：转义 / 行内代码 / 粗体 / 斜体。未闭合定界符按字面处理；
 * 深度超限按字面处理。任何位置都不会抛异常。
 */
function parseInline(text: string, depth: number): MarkdownSpan[] {
  if (depth > MAX_INLINE_DEPTH) return [{ text }];
  const spans: MarkdownSpan[] = [];
  let lit = ""; // 字面累积
  const flush = (): void => {
    if (lit !== "") {
      spans.push({ text: lit });
      lit = "";
    }
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    // 转义：下一字符字面
    if (ch === "\\" && i + 1 < text.length) {
      lit += text[i + 1];
      i += 2;
      continue;
    }
    // 行内代码：闭合 ` 前内容原样（不再解析标记）
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        spans.push({ text: text.slice(i + 1, end), style: STYLE_CODE_INLINE });
        i = end + 1;
        continue;
      }
      lit += ch; // 未闭合：字面
      i += 1;
      continue;
    }
    // 粗体 ** / __（__ 另受 intraword 抑制：a__b__c 不触发，同 CommonMark）
    if ((ch === "*" || ch === "_") && text[i + 1] === ch && huggedOpen(text, i + 2)) {
      const marker = ch + ch;
      const end = text.indexOf(marker, i + 2);
      const intrawordOk = ch === "*" || (!isWordChar(text, i - 1) && !isWordChar(text, end + 2));
      if (end > i + 2 && huggedClose(text, end) && intrawordOk) {
        flush();
        const inner = parseInline(text.slice(i + 2, end), depth + 1);
        spans.push(...withStyle(inner, { bold: true }));
        i = end + 2;
        continue;
      }
    }
    // 斜体 * / _（_ 同受 intraword 抑制：a_b_c 不触发）
    if ((ch === "*" || ch === "_") && huggedOpen(text, i + 1)) {
      const end = text.indexOf(ch, i + 1);
      const intrawordOk = ch === "*" || (!isWordChar(text, i - 1) && !isWordChar(text, end + 1));
      if (end > i + 1 && huggedClose(text, end) && intrawordOk) {
        flush();
        const inner = parseInline(text.slice(i + 1, end), depth + 1);
        spans.push(...withStyle(inner, { italic: true }));
        i = end + 1;
        continue;
      }
    }
    lit += ch;
    i += 1;
  }
  flush();
  return spans;
}

// ---------------------------------------------------------------------------
// 块级解析
// ---------------------------------------------------------------------------

const FENCE_RE = /^\s{0,3}(```|~~~)\s*(\S*)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const ULIST_RE = /^(\s*)[-*+]\s+(.*)$/;
const OLIST_RE = /^(\s*)(\d+)([.)]\s+(.*))$/;

/** 块级渲染：逻辑行 → 带样式行序列（行宽 width；首行按 firstRowIndent 收缩预算）。 */
function renderBlocks(lines: string[], width: number, opts: MarkdownRenderOptions): MarkdownRow[] {
  const indent = opts.firstRowIndent ?? 0;
  const rows: MarkdownRow[] = [];
  let fence: { marker: string; lang: string; content: string[] } | undefined;

  const pushWrapped = (spans: MarkdownSpan[], isFirstLogical: boolean): void => {
    const budget = Math.max(1, isFirstLogical ? width - indent : width);
    for (const row of wrapSpans(spans, budget)) rows.push(row);
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    const isFirstLogical = li === 0;

    // 围栏态：收集内容或闭栏
    if (fence !== undefined) {
      const close = FENCE_RE.exec(line);
      if (close !== null && close[1] === fence.marker) {
        rows.push(...renderFence(fence.lang, fence.content, width));
        fence = undefined;
      } else {
        fence.content.push(line);
      }
      continue;
    }
    const open = FENCE_RE.exec(line);
    if (open !== null) {
      fence = { marker: open[1]!, lang: (open[2] ?? "").toLowerCase(), content: [] };
      continue;
    }

    // 空行：结构分隔原样保留
    if (line.trim() === "") {
      rows.push({ spans: [] });
      continue;
    }

    // ATX 标题：标记剥离，整行样式化
    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      pushWrapped([{ text: heading[2]!, style: STYLE_HEADING }], isFirstLogical);
      continue;
    }

    // 无序列表：标记换 •（缩进保留）
    const ulist = ULIST_RE.exec(line);
    if (ulist !== null) {
      const spans: MarkdownSpan[] = [{ text: `${ulist[1]}• ` }, ...parseInline(ulist[2]!, 0)];
      pushWrapped(spans, isFirstLogical);
      continue;
    }

    // 有序列表：原样透传（编号本身可读）
    if (OLIST_RE.test(line)) {
      pushWrapped(parseInline(line, 0), isFirstLogical);
      continue;
    }

    // 普通段落行
    pushWrapped(parseInline(line, 0), isFirstLogical);
  }
  // 未闭合围栏：残余内容按代码块收尾（优雅降级）
  if (fence !== undefined) {
    rows.push(...renderFence(fence.lang, fence.content, width));
  }
  return rows;
}

/** 围栏块渲染：latex/mermaid 走现成器官（纯 string[]、不抛异常）；其余 dim。 */
function renderFence(lang: string, content: string[], width: number): MarkdownRow[] {
  const src = content.join("\n");
  if (lang === "latex" || lang === "tex" || lang === "math") {
    try {
      return renderLatex(src).map((t) => ({ spans: [{ text: t }] }));
    } catch {
      return dimRows(content); // 器官异常退化为 dim 代码块
    }
  }
  if (lang === "mermaid") {
    try {
      return renderMermaid(src, { cols: width }).map((t) => ({ spans: [{ text: t }] }));
    } catch {
      return dimRows(content);
    }
  }
  return dimRows(content);
}

function dimRows(lines: string[]): MarkdownRow[] {
  return lines.map((t) => ({ spans: [{ text: t, style: STYLE_CODE_BLOCK }] }));
}

// ---------------------------------------------------------------------------
// 样式感知折行（码点贪心）
// ---------------------------------------------------------------------------

/** 单元样式等价键（与 DiffRenderer styleKey 同字段集）。 */
function styleKeyOf(style: CellStyle | undefined): string {
  return `${style?.fg ?? ""}|${style?.bg ?? ""}|${style?.bold ? 1 : 0}|${style?.dim ? 1 : 0}|${style?.italic ? 1 : 0}`;
}

/** 把单行 spans 按显示列宽贪心折行；同样式相邻码点合并回分段（样式跨行延续）。 */
function wrapSpans(spans: MarkdownSpan[], width: number): MarkdownRow[] {
  interface Ch {
    text: string;
    w: number;
    key: string;
    style?: CellStyle;
  }
  const chars: Ch[] = [];
  for (const s of spans) {
    const key = styleKeyOf(s.style);
    for (const ch of s.text) {
      chars.push({ text: ch, w: charWidth(ch), key, ...(s.style !== undefined ? { style: s.style } : {}) });
    }
  }
  const rows: MarkdownRow[] = [];
  let cur: Ch[] = [];
  let curW = 0;
  const emit = (): void => {
    rows.push({ spans: mergeChars(cur) });
    cur = [];
    curW = 0;
  };
  for (const c of chars) {
    if (c.w > 0 && curW > 0 && curW + c.w > width) emit();
    cur.push(c);
    curW += c.w;
  }
  if (cur.length > 0 || rows.length === 0) emit();
  return rows;
}

/** 相邻同样式码点合并为分段（保持顺序与文本逐字还原）。 */
function mergeChars(chars: { text: string; key: string; style?: CellStyle }[]): MarkdownSpan[] {
  const spans: Array<{ text: string; style?: CellStyle }> = [];
  for (const c of chars) {
    const last = spans.at(-1);
    if (last !== undefined && styleKeyOf(last.style) === c.key) {
      last.text += c.text;
    } else {
      spans.push({ text: c.text, ...(c.style !== undefined ? { style: c.style } : {}) });
    }
  }
  return spans;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 渲染 markdown 文本为带样式视图行（永不抛异常：解析器内部全容错，外层
 * try/catch 兜底——任何意外错误退化为逐逻辑行纯文本）。
 */
export function renderMarkdown(text: string, width: number, opts: MarkdownRenderOptions = {}): MarkdownRow[] {
  const safeWidth = Math.max(1, Math.trunc(width));
  try {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    return renderBlocks(lines, safeWidth, opts);
  } catch {
    // 兜底：纯文本逐行（复用同一折行路径）
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const indent = opts.firstRowIndent ?? 0;
    const rows: MarkdownRow[] = [];
    for (let i = 0; i < lines.length; i++) {
      const budget = Math.max(1, i === 0 ? safeWidth - indent : safeWidth);
      rows.push(...wrapSpans([{ text: lines[i]! }], budget));
    }
    return rows;
  }
}
