/**
 * BI-10 · 80% 高水位静默自动紧缩器（AutoCompactor）。
 *
 * 协作契约（钉死）：
 *  - 水位未超 → 返回 null（零开销静默路径）；
 *  - 水位超 → 调 summarizer（模型调用端口，注入）生成摘要 → 产出
 *    CompactionEntry { summary, tokensBefore, prunedFiles, keptMessages } →
 *    新消息序列 = [头部 system 消息...] + CompactionEntry 占位 + 保留轮次；
 *  - 组装必须过 BI-10.2 findSafeCut 门禁：保留起点向回扩窗直到切点安全
 *    （open=0 且 orphan=0）；
 *  - summarizer 抛错 → 结构化失败记入 lastFailure，返回 null，不炸调用方，
 *    熔断器不计数（紧缩未发生）；
 *  - 连续 3 次紧缩后水位仍超（WindowManager 3 击熔断）→ 第 4 次尝试抛
 *    CompactionCircuitOpenError（结构化告警）。
 *
 * 裁定（工单未覆盖处）：
 *  1. 保留起点 preferred = 倒数第 keepRecentTurns 个 user 消息；user 轮数
 *     不足或 preferred=0（无历史可摘要）→ 返回 null，不空转紧缩；
 *  2. findSafeCut 扩窗到 0（头部即不可配平的病态序列）→ 同上返回 null；
 *  3. summarizer 输入为切点前的**会话部分**（剥离头部 system run）；
 *  4. CompactionEntry 占位 = { role: "user", content: "[compacted] <summary>" }
 *     （user 形态对上游 API 兼容性最稳）；
 *  5. prunedFiles 从切点前消息启发式提取：对象内容按
 *     file_path/path/filename/file 键深走查，字符串内容按绝对 POSIX 路径
 *     正则；写入类工具名（write/edit/patch/apply/create/save/move/remove/
 *     delete）归 modifiedFiles，其余归 readFiles；同桶去重保序。
 */

import { findSafeCut, type Msg } from "./tool-pairing";
import { COMPACT_WATERMARK, type WindowManager } from "./window-manager";

/** 模型调用端口；测试注入 stub。 */
export type Summarizer = (msgs: Msg[]) => Promise<string>;

export interface TouchedFiles {
  readFiles: string[];
  modifiedFiles: string[];
}

export interface CompactionEntry {
  summary: string;
  /** 紧缩前最后一次用量读数（promptTokens）。 */
  tokensBefore: number;
  prunedFiles: TouchedFiles;
  keptMessages: Msg[];
}

export interface CompactResult {
  messages: Msg[];
  entry: CompactionEntry;
}

export interface AutoCompactorDeps {
  summarizer: Summarizer;
  window: WindowManager;
  /** 逐字保留的最近 user 轮数。默认 2。 */
  keepRecentTurns?: number;
}

/** summarizer 端口失败的结构化留痕（不抛出，记入 lastFailure）。 */
export interface CompactionFailure {
  code: "BI-COMPACTION-SUMMARIZER-FAILED";
  message: string;
}

/** 熔断告警：连续 3 次紧缩后水位仍超。 */
export class CompactionCircuitOpenError extends Error {
  readonly code = "BI-COMPACTION-CIRCUIT-OPEN";
  constructor(
    message: string,
    readonly strikes: number,
    readonly ratio: number,
  ) {
    super(message);
    this.name = "CompactionCircuitOpenError";
  }
}

const WRITE_TOOL_RE = /(write|edit|patch|apply|create|save|move|remove|delete)/i;
const FILE_KEYS = new Set(["file_path", "path", "filename", "file"]);
const PATH_RE = /\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/g;

/** 对象内容深走查（限深）：收集文件键上的字符串值。 */
function collectObjectPaths(v: unknown, out: string[], depth: number): void {
  if (depth > 3 || v === null || typeof v !== "object") return;
  if (Array.isArray(v)) {
    for (const item of v) collectObjectPaths(item, out, depth + 1);
    return;
  }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (FILE_KEYS.has(k) && typeof val === "string") out.push(val);
    else collectObjectPaths(val, out, depth + 1);
  }
}

/** 字符串内容：提取绝对 POSIX 风格路径（≥ 两段，尾点修剪）。 */
function stringPaths(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(PATH_RE)) {
    const p = (m[0] ?? "").replace(/\.+$/, "");
    if (p.length > 1) out.push(p);
  }
  return out;
}

/**
 * 从消息中提取触碰过的文件。分类依据：消息自带或配对调用的 toolName
 * 命中写入类 → modified，否则 read（无工具名上下文的路径默认 read）。
 */
export function extractTouchedFiles(messages: Msg[]): TouchedFiles {
  // toolCallId → 该调用（或结果）可用的工具名。
  const nameById = new Map<string, string>();
  for (const m of messages) {
    const name = typeof m.toolName === "string" ? m.toolName : undefined;
    if (name !== undefined && typeof m.toolCallId === "string" && !nameById.has(m.toolCallId)) {
      nameById.set(m.toolCallId, name);
    }
  }

  const readFiles: string[] = [];
  const modifiedFiles: string[] = [];
  for (const m of messages) {
    const name = typeof m.toolName === "string" && m.toolName !== ""
      ? m.toolName
      : typeof m.toolCallId === "string"
        ? nameById.get(m.toolCallId)
        : undefined;
    const write = name !== undefined && WRITE_TOOL_RE.test(name);
    const paths: string[] = [];
    if (typeof m.content === "string") paths.push(...stringPaths(m.content));
    else collectObjectPaths(m.content, paths, 0);
    const bucket = write ? modifiedFiles : readFiles;
    for (const p of paths) {
      if (!bucket.includes(p)) bucket.push(p);
    }
  }
  return { readFiles, modifiedFiles };
}

function compactionPlaceholder(summary: string): Msg {
  return { role: "user", content: `[compacted] ${summary}` };
}

export class AutoCompactor {
  private readonly summarizer: Summarizer;
  private readonly window: WindowManager;
  readonly keepRecentTurns: number;
  private failure: CompactionFailure | null = null;

  constructor(deps: AutoCompactorDeps) {
    this.summarizer = deps.summarizer;
    this.window = deps.window;
    this.keepRecentTurns = deps.keepRecentTurns ?? 2;
  }

  get lastFailure(): CompactionFailure | null {
    return this.failure;
  }

  async maybeCompact(messages: Msg[]): Promise<CompactResult | null> {
    this.failure = null;
    if (this.window.isTripped()) {
      throw new CompactionCircuitOpenError(
        `compaction circuit open: ${this.window.strikes()} consecutive compactions left ratio >= ${COMPACT_WATERMARK}`,
        this.window.strikes(),
        this.window.ratio(),
      );
    }
    if (!this.window.shouldCompact()) return null;

    // preferred 保留起点：倒数第 keepRecentTurns 个 user 消息的位置。
    const userIdx: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m !== undefined && m.role === "user") userIdx.push(i);
    }
    if (userIdx.length < this.keepRecentTurns) return null; // 轮数不足：无历史可摘要
    const preferred = userIdx.length > 0 ? (userIdx[userIdx.length - this.keepRecentTurns] ?? 0) : 0;
    if (preferred <= 0) return null; // 保留窗已覆盖全历史：不空转紧缩

    // BI-10.2 安全切点门禁：切点不安全则向回扩窗直到安全。
    const cut = findSafeCut(messages, preferred);
    if (cut <= 0) return null; // 病态序列无法配平：放弃紧缩（裁定 2）

    const kept = messages.slice(cut);
    const olderAll = messages.slice(0, cut);
    // 剥离头部 system run：system 提示不是会话内容，不进 summarizer（裁定 3）。
    let headSys = 0;
    while (headSys < olderAll.length && olderAll[headSys]?.role === "system") headSys++;
    const olderConversation = olderAll.slice(headSys);

    let summary: string;
    try {
      summary = await this.summarizer(olderConversation);
    } catch (err) {
      this.failure = {
        code: "BI-COMPACTION-SUMMARIZER-FAILED",
        message: err instanceof Error ? err.message : String(err),
      };
      return null; // 不炸调用方；熔断器不计数
    }

    const entry: CompactionEntry = {
      summary,
      tokensBefore: this.window.snapshot().promptTokens,
      prunedFiles: extractTouchedFiles(olderAll),
      keptMessages: kept,
    };
    const newMessages = [...olderAll.slice(0, headSys), compactionPlaceholder(summary), ...kept];
    this.window.recordCompaction();
    return { messages: newMessages, entry };
  }
}
