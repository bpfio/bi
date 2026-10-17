/**
 * BI-10.1 · 历史回溯定位指针与断点自恢复协议。
 *
 * 生成 `## Context Recovery` 结构化尾块：把已压缩 window 在持久化 JSONL
 * wire 中的行号区间（1 基，含首尾）随摘要一起持久化。断点恢复后，模型
 * 可按行号 grep+read 回溯历史原始输出，而非凭记忆复述。
 *
 * 渲染契约（钉死）：
 *  - 首行 `## Context Recovery`；字段序固定：logPath → windows → tip；
 *  - 每个 window 两行：`- lines: <from>-<to>` 与 `  summary: <摘要>`；
 *  - windows 按 from 升序（并列按 to）——乱序输入自动排序，输出确定；
 *  - 无时间戳、无随机源：同输入两次渲染逐字节相等；
 *  - summary/tip 中的换行（\r\n|\r|\n）展平为单个空格，保证块内每个
 *    window 恰好两行、`lines: ` grep 模式不被破坏（裁定）。
 *
 * 行号语义：1 基——JSONL wire 第 1 行即 from=1。record/build 校验：
 * 非整数、from < 1、to < from 一律 RangeError（from === to 是单行 window，
 * 合法）。
 *
 * 协作契约：与 BI-10 compactor 的 CompactionEntry 协作——组装方负责把本卡
 * 生成的 footer 拼进摘要尾（CompactionEntry.summary 之后），本卡只生成、
 * 不拼接；行号区间由组装方在写 wire 时登记，本卡不读 wire。
 */

export const DEFAULT_RECOVERY_TIP =
  "需要历史原始输出时按行号 grep+read 检视，勿凭记忆复述";

const HEADER = "## Context Recovery";

export interface RecoveryWindowRange {
  /** window 在持久化 JSONL wire 中的起始行号（1 基，含） */
  from: number;
  /** window 在持久化 JSONL wire 中的结束行号（1 基，含） */
  to: number;
  /** 该 window 的内容摘要 */
  summary: string;
}

export interface RecoveryFooterOptions {
  /** 持久化 JSONL wire 路径（由注入方提供） */
  logPath: string;
  /** 各 window 的历史行号区间与摘要 */
  windows: readonly RecoveryWindowRange[];
  /** 回溯提示语（缺省使用内置 tip） */
  tip?: string;
}

function flatten(value: string): string {
  return value.replace(/\r\n|\r|\n/g, " ");
}

/** 行号区间校验：整数、1 基（from >= 1）、to >= from。 */
function assertValidRange(from: number, to: number): void {
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    throw new RangeError(
      `window line numbers must be integers, got from=${String(from)} to=${String(to)}`,
    );
  }
  if (from < 1) {
    throw new RangeError(`window line numbers are 1-based, got from=${String(from)}`);
  }
  if (to < from) {
    throw new RangeError(`window range inverted: from=${String(from)} to=${String(to)}`);
  }
}

/**
 * 生成 `## Context Recovery` 结构化块（确定性渲染，字段序固定）。
 * 输入 windows 乱序时自动按 (from, to) 排序，不改变调用方数组。
 */
export function buildRecoveryFooter(opts: RecoveryFooterOptions): string {
  const windows = [...opts.windows].sort((a, b) => a.from - b.from || a.to - b.to);
  for (const w of windows) assertValidRange(w.from, w.to);

  const lines: string[] = [HEADER, `logPath: ${opts.logPath}`, "windows:"];
  for (const w of windows) {
    lines.push(`- lines: ${w.from}-${w.to}`);
    const summary = flatten(w.summary);
    lines.push(summary === "" ? "  summary:" : `  summary: ${summary}`);
  }
  lines.push(`tip: ${flatten(opts.tip ?? DEFAULT_RECOVERY_TIP)}`);
  return lines.join("\n");
}

/**
 * 回溯索引：追加式登记各 window 行号区间，按需产出 footer 块。
 * 与 CompactionEntry 的对应关系：组装方每完成一次紧缩（写 wire 落行）后
 * 调 record 登记 window 区间；最终 footer(logPath) 产出拼尾块。
 */
export class RecoveryIndex {
  private readonly windows: RecoveryWindowRange[] = [];

  /** 追加一条 window 区间记录（乱序输入由渲染侧排序）；链式。 */
  record(windowStartLine: number, windowEndLine: number, summary: string): this {
    assertValidRange(windowStartLine, windowEndLine);
    this.windows.push({ from: windowStartLine, to: windowEndLine, summary });
    return this;
  }

  /** 已登记 window 数。 */
  get count(): number {
    return this.windows.length;
  }

  /** 产出 `## Context Recovery` footer 块（确定性，与 buildRecoveryFooter 同构）。 */
  footer(logPath: string): string {
    return buildRecoveryFooter({ logPath, windows: this.windows });
  }
}
