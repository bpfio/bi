/**
 * transcript-projection —— CJK 排版与同构 Transcript 状态投影层。
 *
 * BI-19.1 合约（未读取 /home/yupeng/references/ 下任何源码；设计依据本工单）：
 * - 四层同构投影：
 *     L1 memory 条目（会话事件，append() 进入，只读快照可回放）；
 *     L2 history 行模型（逻辑行，未折行；首行带角色前缀 `[kind]`）；
 *     L3 view 行（经 cjk-width 度量贪心折行：宽字符占 2 列、行宽可配默认
 *     120、边界折行不拆宽字符/字素簇；折行无损，join 后还原原行）；
 *     L4 markdown 导出（与 L3 行行同构、保序：view 行 ↔ markdown 行 1:1，
 *     条目首行角色前缀加粗为 `**[kind]**`，其余行原样透传）。
 * - append(entry) 增量构建：新条目只做增量折行，既有层不重算；
 * - render(): string[] 返回 L3；toMarkdown(): string 返回 L4（\n 连接，
 *   空投影为空串，对应 0 行）。
 * - 不变式（assertProjectionInvariants 运行期断言）：
 *     a. L3 行数 === L4 行数；
 *     b. 同条目三投影语义一致：L2 按逻辑行 join 精确等于 `[kind]` +
 *        归一化 L1 文本；L3/L4 按宿主逻辑行分组、组内拼接（折行无损）
 *        后逐逻辑行精确等于 L2。
 *
 * 度量复用已关单资产 components/cjk-width.ts（charWidth/textWidth），
 * 只 import 不修改。
 */

import { charWidth, textWidth } from "./components/cjk-width";

/** 会话事件角色。 */
export type TranscriptKind = "user" | "assistant" | "system" | "tool";

const TRANSCRIPT_KINDS: readonly TranscriptKind[] = [
  "user",
  "assistant",
  "system",
  "tool",
];

/** L3 视图默认行宽（显示列）。 */
export const DEFAULT_VIEW_WIDTH = 120;

/** L1 memory 条目（会话事件）。 */
export interface TranscriptEntry {
  readonly kind: TranscriptKind;
  readonly text: string;
  /** 预留元数据：随 L1 透传保存，当前各投影层不渲染。 */
  readonly meta?: Readonly<Record<string, string>>;
}

export interface TranscriptProjectionOptions {
  /** L3 视图行宽（显示列数），默认 120；必须为正整数。 */
  readonly width?: number;
}

/** L2 history 行模型中的一行（逻辑行，未折行）。 */
export interface HistoryLine {
  readonly entryIndex: number;
  readonly kind: TranscriptKind;
  /** 条目内逻辑行序号。 */
  readonly seq: number;
  /** 是否为条目首行（携带角色前缀的那一行）。 */
  readonly isEntryStart: boolean;
  readonly text: string;
}

/** L3 view 行及其 L4 markdown 同构行（1:1 成对）。 */
export interface ViewLine {
  readonly entryIndex: number;
  readonly kind: TranscriptKind;
  /** 宿主逻辑行序号（对应 HistoryLine.seq；折行不跨逻辑行）。 */
  readonly seq: number;
  /** 是否为条目在 L3 中的首条视图行。 */
  readonly isEntryStart: boolean;
  readonly text: string;
  readonly markdown: string;
}

// ---------------------------------------------------------------------------
// L1 → L2：逻辑行拆分
// ---------------------------------------------------------------------------

/** 行尾归一：CRLF 与孤立 CR 统一为 LF。 */
function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function entryHeader(kind: TranscriptKind): string {
  return `[${kind}]`;
}

/** L1 → L2：条目文本拆逻辑行，首行带角色前缀（空文本仅剩前缀行）。 */
function buildHistory(entryIndex: number, entry: TranscriptEntry): HistoryLine[] {
  const header = entryHeader(entry.kind);
  const body = normalizeText(entry.text);
  const full = body.length > 0 ? `${header} ${body}` : header;
  return full.split("\n").map((text, seq) => ({
    entryIndex,
    kind: entry.kind,
    seq,
    isEntryStart: seq === 0,
    text,
  }));
}

// ---------------------------------------------------------------------------
// L2 → L3：CJK 度量折行
// ---------------------------------------------------------------------------

/** 不可拆分的排版单元：基准码点 + 附着其后的零宽/修饰/连接序列。 */
interface LayoutUnit {
  readonly text: string;
  readonly width: number;
}

const ZWJ = 0x200d;

function isRegionalIndicator(cp: number): boolean {
  return cp >= 0x1f1e6 && cp <= 0x1f1ff;
}

function isSkinToneModifier(cp: number): boolean {
  return cp >= 0x1f3fb && cp <= 0x1f3ff;
}

/**
 * 把一行切成不可拆分的排版单元（字素簇的务实近似）：
 * - 基准码点后附着：零宽字符（组合符号/变体选择符等，charWidth=0）、
 *   ZWJ 及其连接的下一码点（emoji 组合序列）、肤色修饰符、成对区域
 *   指示符（国旗）；
 * - 单元宽度 = 成员码点宽度之和（cjk-width 度量）。
 * 单元序列拼接后严格还原原字符串（含未配对代理等退化码点）。
 */
function splitUnits(line: string): LayoutUnit[] {
  const units: LayoutUnit[] = [];
  let cur = "";
  let curWidth = 0;
  let prevCp = -1;
  let riCount = 0;
  let started = false;
  for (const ch of line) {
    const cp = ch.codePointAt(0) ?? -1;
    const w = charWidth(ch);
    const attaches =
      started &&
      (w === 0 ||
        prevCp === ZWJ ||
        isSkinToneModifier(cp) ||
        (isRegionalIndicator(cp) && riCount === 1));
    if (attaches) {
      cur += ch;
      curWidth += w;
      if (isRegionalIndicator(cp)) riCount += 1;
    } else {
      if (started) units.push({ text: cur, width: curWidth });
      cur = ch;
      curWidth = w;
      riCount = isRegionalIndicator(cp) ? 1 : 0;
      started = true;
    }
    prevCp = cp;
  }
  if (started) units.push({ text: cur, width: curWidth });
  return units;
}

/**
 * 贪心按显示列宽折行：
 * - 单元整体换行，绝不拆开单元（宽字符与 emoji 组合序列保持完整）；
 * - 单元自身超宽（行宽小于一个宽字符/组合序列）时独立成行硬放：
 *   「不拆」优先于「不超」；
 * - 折行无损：join("\n") 后逐字还原原行（不插连字符、不吞空白）。
 *
 * BI-27.3 起导出复用（styled 转录对非 assistant 条目取同一折行路径，
 * 保证视口文本与 L3 逐字节一致）。
 */
export function wrapLine(line: string, width: number): string[] {
  if (textWidth(line) <= width) return [line];
  const units = splitUnits(line);
  const out: string[] = [];
  let cur = "";
  let curWidth = 0;
  for (const unit of units) {
    if (cur.length > 0 && curWidth + unit.width > width) {
      out.push(cur);
      cur = unit.text;
      curWidth = unit.width;
    } else {
      cur += unit.text;
      curWidth += unit.width;
    }
  }
  if (cur.length > 0 || out.length === 0) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// L3 → L4：markdown 同构映射
// ---------------------------------------------------------------------------

/**
 * 单行 markdown 变换：条目首行把角色前缀加粗为 `**[kind]**`，其余行
 * 原样透传。行宽小于前缀宽度时首行可能不含完整前缀（前缀本身被折行），
 * 此时退化为透传，保证 L4 与 L3 严格行行同构。
 */
function markdownFor(kind: TranscriptKind, isEntryStart: boolean, text: string): string {
  if (!isEntryStart) return text;
  const header = entryHeader(kind);
  if (!text.startsWith(header)) return text;
  return `**${header}**${text.slice(header.length)}`;
}

function buildView(history: readonly HistoryLine[], width: number): ViewLine[] {
  const out: ViewLine[] = [];
  for (const hl of history) {
    let first = true;
    for (const piece of wrapLine(hl.text, width)) {
      const isEntryStart = hl.isEntryStart && first;
      out.push({
        entryIndex: hl.entryIndex,
        kind: hl.kind,
        seq: hl.seq,
        isEntryStart,
        text: piece,
        markdown: markdownFor(hl.kind, isEntryStart, piece),
      });
      first = false;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 投影主体
// ---------------------------------------------------------------------------

interface EntryLayers {
  readonly entry: TranscriptEntry;
  readonly history: readonly HistoryLine[];
  readonly view: readonly ViewLine[];
}

/** 同构 Transcript 投影：L1 条目 → L2 逻辑行 → L3 折行视图 → L4 markdown。 */
export class TranscriptProjection {
  private viewWidth: number;
  private readonly entryList: TranscriptEntry[] = [];
  private layerList: EntryLayers[] = [];

  constructor(opts: TranscriptProjectionOptions = {}) {
    const width = opts.width ?? DEFAULT_VIEW_WIDTH;
    if (!Number.isInteger(width) || width < 1) {
      throw new RangeError(`TranscriptProjection 行宽非法: ${String(opts.width)}`);
    }
    this.viewWidth = width;
  }

  /** 视图行宽（显示列）。 */
  get width(): number {
    return this.viewWidth;
  }

  /**
   * 视口行宽变更（BI-27.5 resize 折行宽跟随）：按新宽度对全部条目重算 L3/L4
   * 视图层。L2 history 与宽度无关不重算（增量构建的单向推进性保持：既有
   * append 语义不变）；重算后四层同构不变式依旧成立（assertProjectionInvariants
   * 可随时复验）。宽度等值时 no-op。
   */
  resize(width: number): void {
    if (!Number.isInteger(width) || width < 1) {
      throw new RangeError(`TranscriptProjection 行宽非法: ${String(width)}`);
    }
    if (width === this.viewWidth) return;
    this.viewWidth = width;
    this.layerList = this.layerList.map((l) => ({
      entry: l.entry,
      history: l.history,
      view: buildView(l.history, width),
    }));
  }

  /** L1 只读快照（append 顺序；快照变动不影响投影）。 */
  get entries(): readonly TranscriptEntry[] {
    return [...this.entryList];
  }

  /**
   * 追加一条会话事件（增量构建：仅新条目参与折行，既有层不重算）。
   * kind 非法或 text 非 string 抛 TypeError。
   */
  append(entry: TranscriptEntry): void {
    if (!TRANSCRIPT_KINDS.includes(entry.kind)) {
      throw new TypeError(`非法会话事件 kind: ${String(entry.kind)}`);
    }
    if (typeof entry.text !== "string") {
      throw new TypeError("非法会话事件 text: 必须为 string");
    }
    const entryIndex = this.entryList.length;
    const history = buildHistory(entryIndex, entry);
    const view = buildView(history, this.viewWidth);
    this.entryList.push(entry);
    this.layerList.push({ entry, history, view });
  }

  /** L2 history 行模型（只读快照）。 */
  historyLines(): readonly HistoryLine[] {
    return this.layerList.flatMap((l) => [...l.history]);
  }

  /**
   * 清空投影（BI-11 接线：/clear 执行体）——丢弃全部条目与派生层，
   * 宽度保持不变；清空后投影等价于新建空投影（不变式依旧成立）。
   */
  clear(): void {
    this.entryList.length = 0;
    this.layerList = [];
  }

  /** L3/L4 成对视图行（只读快照）。 */
  viewLines(): readonly ViewLine[] {
    return this.layerList.flatMap((l) => [...l.view]);
  }

  /** L3 view 行序列。 */
  render(): string[] {
    return this.viewLines().map((l) => l.text);
  }

  /** L4 markdown 导出：与 L3 行行同构保序，\n 连接；空投影为空串。 */
  toMarkdown(): string {
    return this.viewLines()
      .map((l) => l.markdown)
      .join("\n");
  }
}

// ---------------------------------------------------------------------------
// 不变式断言
// ---------------------------------------------------------------------------

/**
 * 运行期断言四层同构不变式：
 * 1. L3 行数 === L4 行数（空投影两侧均为 0 行）；
 * 2. 逐条目逐逻辑行：L2 逻辑行文本 === L3 同逻辑行视图片拼接 ===
 *    L4 同逻辑行 markdown 片去修饰拼接（折行无损 + markdown 1:1 同构）。
 * 违反时抛 Error（message 指明条目/逻辑行与层）。
 */
export function assertProjectionInvariants(p: TranscriptProjection): void {
  const views = p.viewLines();
  const markdown = p.toMarkdown();
  const mdLines = markdown.length === 0 ? [] : markdown.split("\n");
  if (mdLines.length !== views.length) {
    throw new Error(
      `不变式破坏: L3 行数 ${views.length} ≠ L4 行数 ${mdLines.length}`,
    );
  }
  const history = p.historyLines();
  const entries = p.entries;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const header = entryHeader(entry.kind);
    const body = normalizeText(entry.text);
    const expectedFull = body.length > 0 ? `${header} ${body}` : header;
    const logicalLines = expectedFull.split("\n");

    const boldHeader = `**${header}**`;
    const l2BySeq = new Map<number, string>();
    const l3BySeq = new Map<number, string>();
    const l4BySeq = new Map<number, string>();
    for (const hl of history) {
      if (hl.entryIndex !== i) continue;
      l2BySeq.set(hl.seq, (l2BySeq.get(hl.seq) ?? "") + hl.text);
    }
    for (const vl of views) {
      if (vl.entryIndex !== i) continue;
      l3BySeq.set(vl.seq, (l3BySeq.get(vl.seq) ?? "") + vl.text);
      const unmarked =
        vl.isEntryStart && vl.markdown.startsWith(boldHeader)
          ? header + vl.markdown.slice(boldHeader.length)
          : vl.markdown;
      l4BySeq.set(vl.seq, (l4BySeq.get(vl.seq) ?? "") + unmarked);
    }
    for (let seq = 0; seq < logicalLines.length; seq++) {
      const expected = logicalLines[seq]!;
      if (l2BySeq.get(seq) !== expected) {
        throw new Error(`不变式破坏: 条目 #${i} 逻辑行 ${seq} L2 与 L1 语义不一致`);
      }
      if (l3BySeq.get(seq) !== expected) {
        throw new Error(
          `不变式破坏: 条目 #${i} 逻辑行 ${seq} L3 与 L1 语义不一致（折行有损）`,
        );
      }
      if (l4BySeq.get(seq) !== expected) {
        throw new Error(`不变式破坏: 条目 #${i} 逻辑行 ${seq} L4 与 L1 语义不一致`);
      }
    }
  }
}
