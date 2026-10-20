/**
 * transcript-styled —— 富文本转录视图模型（BI-27.3）。
 *
 * 与 TranscriptProjection（L1→L2→L3 同构投影）并行消费同一份 L1 条目，产出
 * 带样式视图行（MarkdownRow），供 TranscriptView/帧探针渲染：
 * - assistant 条目：正文走 renderMarkdown（BI-27.3 富文本），首行前方垫
 *   `[assistant] ` 前缀分段（dim；首行折行预算相应收缩）；
 * - user/system/tool 条目：与 L3 逐字节同文本——`[kind] ` 前缀 + 正文走
 *   transcript-projection.wrapLine 同一折行路径，仅前缀分段附加 dim 样式
 *   （文本面不变，样式面新增）；
 * - resize(width)（BI-27.5）：按新宽度重算全部条目的视图行（折行宽跟随），
 *   行序与条目序保序（滚动锚定由消费方按行号裁窗）。
 *
 * 本模型是纯派生缓存（append-only + 全量重算 resize），不承担落盘/导出职责
 * ——L4 markdown 导出仍归 TranscriptProjection.toMarkdown()。
 */

import type { TranscriptEntry } from "./transcript-projection";
import { wrapLine } from "./transcript-projection";
import { renderMarkdown, type MarkdownRow } from "./render/markdown";

/** 行尾归一：与投影层 buildHistory 同一语义（CRLF/孤立 CR → LF）。 */
function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** 单条目 → 带样式视图行。 */
function renderEntry(entry: TranscriptEntry, width: number): MarkdownRow[] {
  const header = `[${entry.kind}]`;
  const body = normalizeText(entry.text);
  // 空正文：与 L3 一致，仅剩前缀行（L3 的 full = header，无尾随空格）
  if (body.length === 0) {
    return [{ spans: [{ text: header, style: { dim: true } }] }];
  }
  if (entry.kind === "assistant") {
    const rows = renderMarkdown(body, width, { firstRowIndent: header.length + 1 });
    if (rows.length === 0) {
      return [{ spans: [{ text: `${header} `, style: { dim: true } }] }];
    }
    const [first, ...rest] = rows;
    return [
      { spans: [{ text: `${header} `, style: { dim: true } }, ...first!.spans] },
      ...rest,
    ];
  }
  // plain 条目：与 L3 同一折行路径（wrapLine 导出复用）——先按 \n 拆逻辑行
  // （L3 buildHistory 同序），逐行折行；文本逐字节一致，仅前缀分段附加 dim 样式。
  // （不拆行会让换行留在分段内，TranscriptView 落格时 \n 顶入下一行、破坏窗口布局。）
  const full = `${header} ${body}`;
  const pieces: string[] = [];
  for (const logical of full.split("\n")) pieces.push(...wrapLine(logical, width));
  return pieces.map((text, i) => {
    if (i === 0 && text.startsWith(`${header} `)) {
      return { spans: [{ text: `${header} `, style: { dim: true } }, { text: text.slice(header.length + 1) }] };
    }
    return { spans: [{ text }] };
  });
}

/** 富文本转录视图：L1 条目的带样式派生缓存（append 增量 / resize 全量重算）。 */
export class StyledTranscript {
  #width: number;
  readonly #entries: TranscriptEntry[] = [];
  #rowsPerEntry: MarkdownRow[][] = [];

  constructor(width: number) {
    if (!Number.isInteger(width) || width < 1) {
      throw new RangeError(`StyledTranscript 行宽非法: ${String(width)}`);
    }
    this.#width = width;
  }

  /** 当前视图行宽（显示列）。 */
  get width(): number {
    return this.#width;
  }

  /** 已消费条目数（与 L1 快照同长）。 */
  get size(): number {
    return this.#entries.length;
  }

  /** 追加条目（增量渲染该条目；条目序列与 L1 保持一致）。 */
  append(entry: TranscriptEntry): void {
    this.#entries.push(entry);
    this.#rowsPerEntry.push(renderEntry(entry, this.#width));
  }

  /**
   * 清空富文本视图（BI-11 接线：/clear 执行体）——丢弃全部条目与派生行，
   * 宽度保持不变；清空后视图等价于新建空视图。
   */
  clear(): void {
    this.#entries.length = 0;
    this.#rowsPerEntry = [];
  }

  /** 视口行宽变更（BI-27.5）：全量重算视图行；宽度等值 no-op。 */
  resize(width: number): void {
    if (!Number.isInteger(width) || width < 1) {
      throw new RangeError(`StyledTranscript 行宽非法: ${String(width)}`);
    }
    if (width === this.#width) return;
    this.#width = width;
    this.#rowsPerEntry = this.#entries.map((entry) => renderEntry(entry, width));
  }

  /** 全部视图行（条目序拼接的只读快照）。 */
  rows(): MarkdownRow[] {
    return this.#rowsPerEntry.flat();
  }
}
