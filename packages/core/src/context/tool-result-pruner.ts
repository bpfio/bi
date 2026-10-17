/**
 * BI-08.1 · 超大工具输出中间修剪器（pruneToolResult）——纯切片、零模型调用。
 *
 * 纵深关系（与 BI-08 boundToolText 分层，钉死）：
 *  - 第一层 BI-08：64KB 粗截（行级预算 + 字符兜底），扛灾难性体量；
 *  - 第二层 本卡：仍高于细粒度阈值（默认 8192 码点）的输出保头 4096 +
 *    尾 1024，中段整体收进一行显式标记。两层各自独立生效，构成纵深防御。
 *
 * 码点安全（复用 BI-08 房规自实现）：一切 char 计数按 Unicode 码点
 * （非 UTF-16 code unit）；头/尾切片必落在码点边界，代理对绝不截半
 * （中文 / emoji 安全）。原版码点原语为 bounded-tool-text 模块私有，
 * 不跨文件引出，故按同款房规在此自实现并导出供 spill-store 复用。
 *
 * 标记格式（工单钉死，直拼无分隔符）：
 *   `[... tool result middle pruned: N chars ...]`
 *   N = 被收进中段的码点数 = total − 头实保留 − 尾实保留。
 */

export const DEFAULT_PRUNE_THRESHOLD = 8192;
export const DEFAULT_HEAD_KEEP = 4096;
export const DEFAULT_TAIL_KEEP = 1024;

export interface PruneToolResultOpts {
  /** 触发修剪的总长阈值（码点），默认 8192。 */
  threshold?: number;
  /** 头侧保留码点数，默认 4096。 */
  headKeep?: number;
  /** 尾侧保留码点数，默认 1024。 */
  tailKeep?: number;
}

/** 统计 Unicode 码点数（合法代理对计 1，孤立代理项计 1）。BI-08 房规同款。 */
export function codePointLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; ) {
    const code = s.charCodeAt(i);
    const isPair =
      code >= 0xd800 && code <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff;
    i += isPair ? 2 : 1;
    n++;
  }
  return n;
}

/** 取前 maxCodePoints 个码点（前缀），截断点必落在码点边界。BI-08 房规同款。 */
export function takeCodePoints(s: string, maxCodePoints: number): string {
  if (maxCodePoints <= 0) return "";
  let counted = 0;
  let i = 0;
  while (i < s.length) {
    if (counted + 1 > maxCodePoints) break;
    const code = s.charCodeAt(i);
    const isPair =
      code >= 0xd800 && code <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff;
    counted++;
    i += isPair ? 2 : 1;
  }
  return s.slice(0, i);
}

/** 取后 maxCodePoints 个码点（后缀），截断点必落在码点边界。BI-08 房规同款。 */
export function takeLastCodePoints(s: string, maxCodePoints: number): string {
  if (maxCodePoints <= 0) return "";
  const total = codePointLength(s);
  if (total <= maxCodePoints) return s;
  const skip = total - maxCodePoints;
  let counted = 0;
  let i = 0;
  while (counted < skip && i < s.length) {
    const code = s.charCodeAt(i);
    const isPair =
      code >= 0xd800 && code <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff;
    i += isPair ? 2 : 1;
    counted++;
  }
  return s.slice(i);
}

function formatPruneMarker(omittedChars: number): string {
  return `[... tool result middle pruned: ${omittedChars} chars ...]`;
}

/**
 * 超阈值 → `头 + 标记 + 尾`；未超 → 原样返回（恰好等于阈值不剪，对齐
 * BI-08 "等于上限不截"语义）。头尾已覆盖全文（omitted ≤ 0，头尾预算之和
 * 超过总长的退化配置）时放弃修剪原样返回——修剪无收益还引入标记，不做。
 *
 * @throws RangeError 当 threshold 非有限数或 < 1、headKeep/tailKeep 非有限
 *   数或 < 0（配置错误当场暴露，对齐 BI-08 RangeError 房规）。
 */
export function pruneToolResult(text: string, opts: PruneToolResultOpts = {}): string {
  const threshold = opts.threshold ?? DEFAULT_PRUNE_THRESHOLD;
  const headKeep = opts.headKeep ?? DEFAULT_HEAD_KEEP;
  const tailKeep = opts.tailKeep ?? DEFAULT_TAIL_KEEP;
  if (!Number.isFinite(threshold) || threshold < 1) {
    throw new RangeError(`threshold must be a finite integer >= 1, got ${String(threshold)}`);
  }
  if (!Number.isFinite(headKeep) || headKeep < 0 || !Number.isFinite(tailKeep) || tailKeep < 0) {
    throw new RangeError(`headKeep/tailKeep must be finite numbers >= 0, got ${String(headKeep)}/${String(tailKeep)}`);
  }

  const total = codePointLength(text);
  if (total <= threshold) return text;

  const head = takeCodePoints(text, headKeep);
  const tail = takeLastCodePoints(text, tailKeep);
  const omitted = total - codePointLength(head) - codePointLength(tail);
  if (omitted <= 0) return text;

  return head + formatPruneMarker(omitted) + tail;
}
