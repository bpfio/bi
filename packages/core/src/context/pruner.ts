/**
 * BI-09 · 历史老旧工具输出自动脱水修剪（dehydrateOldToolResults）。
 *
 * 规则（工单钉死）：
 *  - 轮次按 user 消息计：最近 N 轮（默认 5）内的 tool 结果保留原文；
 *  - 更早的 tool 结果 → 单行摘要标记
 *      `[pruned: <toolName> <首行 80 字符>... (<origBytes>B)]`
 *    （"..." 仅在首行被截断时追加；toolName 取消息自身 toolName 字段，
 *    缺失时回退配对 assistant 调用的 toolName，再缺失回退 "tool"）；
 *  - assistant 决策文本永不脱水；user/system 消息原样保留；
 *  - 返回值携带 CompactionEntry 语义留痕 { prunedCount, savedBytes }，
 *    savedBytes = Σ(原文字节数 − 摘要字节数)（UTF-8 字节）；
 *  - 纯函数：不写盘、不调模型。脱水只替换 content，不动消息结构，
 *    因此 BI-10.2 配对关系不受影响。
 */

import type { Msg } from "./tool-pairing";

export const DEFAULT_KEEP_TURNS = 5;

/** 摘要标记里首行保留的字符数（码点，工单钉死 80）。 */
export const SUMMARY_FIRST_LINE_CHARS = 80;

export interface DehydrateOpts {
  /** 保留原文的最近 N 轮（按 user 消息计）。默认 5。 */
  keepRecentTurns?: number;
}

/** CompactionEntry 语义留痕。 */
export interface DehydrateResult {
  messages: Msg[];
  prunedCount: number;
  savedBytes: number;
}

/** 码点安全取前 n 个字符（同 BI-08 房规，代理对不截半）。 */
function takeCodePoints(s: string, n: number): string {
  if (n <= 0) return "";
  let counted = 0;
  let i = 0;
  while (i < s.length) {
    if (counted + 1 > n) break;
    const code = s.charCodeAt(i);
    const isPair =
      code >= 0xd800 && code <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff;
    counted++;
    i += isPair ? 2 : 1;
  }
  return s.slice(0, i);
}

/** 结果内容的字符串形态：字符串原样，其余 JSON 序列化。 */
function contentString(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content) ?? "";
}

/** toolName 解析：消息自带字段优先，回退 "tool"。 */
function toolNameOf(m: Msg, callName: string | undefined): string {
  if (typeof m.toolName === "string" && m.toolName !== "") return m.toolName;
  if (callName !== undefined && callName !== "") return callName;
  return "tool";
}

/**
 * 脱水历史老旧工具输出。userMsgs.length ≤ N 时整条历史都在窗口内，
 * 原样返回（prunedCount = savedBytes = 0）；首个 user 消息之前的
 * 前缀（无轮次归属）在存在脱水窗口时同样视为"更早"。
 */
export function dehydrateOldToolResults(messages: Msg[], opts: DehydrateOpts = {}): DehydrateResult {
  const keepTurns = opts.keepRecentTurns ?? DEFAULT_KEEP_TURNS;
  if (!Number.isInteger(keepTurns) || keepTurns < 0) {
    throw new RangeError(`keepRecentTurns must be a non-negative integer, got ${String(keepTurns)}`);
  }

  const userIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m !== undefined && m.role === "user") userIdx.push(i);
  }
  // 窗口起点：倒数第 N 个 user 消息的位置（不足 N 条 → 全历史保留；
  // N=0 → 窗口起点推到末尾，全部 tool 结果视为"更早"）。
  const windowStartIdx = userIdx.length > keepTurns
    ? (userIdx[userIdx.length - keepTurns] ?? messages.length)
    : 0;
  const hasStale = userIdx.length > keepTurns;

  // 配对调用名回退表：toolCallId → 该 assistant 调用的 toolName。
  const callNameById = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant" && typeof m.toolCallId === "string" && typeof m.toolName === "string") {
      callNameById.set(m.toolCallId, m.toolName);
    }
  }

  let prunedCount = 0;
  let savedBytes = 0;
  const out: Msg[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as Msg;
    const isStaleToolResult = hasStale && i < windowStartIdx && m.role === "tool";
    if (!isStaleToolResult) {
      out.push(m);
      continue;
    }
    const text = contentString(m.content);
    const origBytes = Buffer.byteLength(text, "utf8");
    const firstLineRaw = text.split("\n", 1)[0] ?? "";
    const truncated = codePointsOf(firstLineRaw) > SUMMARY_FIRST_LINE_CHARS;
    const head = takeCodePoints(firstLineRaw, SUMMARY_FIRST_LINE_CHARS);
    const name = toolNameOf(m, typeof m.toolCallId === "string" ? callNameById.get(m.toolCallId) : undefined);
    const marker = `[pruned: ${name} ${head}${truncated ? "..." : ""} (${origBytes}B)]`;
    savedBytes += origBytes - Buffer.byteLength(marker, "utf8");
    prunedCount++;
    out.push({ ...m, content: marker });
  }

  return { messages: out, prunedCount, savedBytes };
}

function codePointsOf(s: string): number {
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
