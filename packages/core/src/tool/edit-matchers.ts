/**
 * BI-07.1 · 8 级阶梯弹性文件匹配引擎。
 *
 * 目标：Edit 类工具的 old_text 几乎总能命中——模型给出的"待替换文本"常带
 * 中英弯引号、行号前缀复读、缩进漂移、行尾空白噪声乃至中间内容改写。本引擎
 * 自上而下逐级降级尝试，低级命中即停，8 级全败才判 unmatched。
 *
 * 阶梯（工单钉死，顺序即优先级，越靠前语义越严格）：
 *  1 exact                 —— 精确子串匹配
 *  2 quote_normalized      —— 中英弯引号 ↔ 直引号双向归一（逐字符 1:1 保长映射，索引直映回原文）
 *  3 line_number_stripped  —— 剥离行首 `N→` / `N:` 行号前缀（模型常复读行号）
 *  4 whitespace_normalized —— 制表符统一 4 空格 + 每行尾随空白剥离
 *  5 indentation_flexible  —— 块内相对缩进保持、绝对缩进重锚到目标文件上下文
 *  6 line_trimmed          —— 逐行 trim 后整块比较
 *  7 block_anchor          —— 块首尾各取一行作锚，中间以相似度 ≥0.8 的模糊对齐
 *  8 context_fallback      —— 唯一出现上下文行 ±2 的窗口重锚（返回更小但精确的锚窗）
 *
 * 设计约束（工单钉死）：
 * - 每级独立导出、纯函数、零 IO、零外部 npm 依赖，可单测；
 * - 相似度函数自实现 Levenshtein 比率：时间 O(lenA×lenB)、空间 O(min(lenA,lenB))
 *   （滚动单行）。复杂度保护两层：
 *     a) 64KB 上限——fileContent 或 oldText 任一超过 FUZZY_MATCH_LIMIT_CHARS 时
 *        直接降级跳过第 7/8 级（阶梯只走 1-6）；
 *     b) 单元预算——similarityRatio 内部对 lenA×lenB 超过 SIMILARITY_CELL_BUDGET
 *        的输入按"不相似"处理（返回 0，仅保留恒等捷径），保证模糊级最坏耗时
 *        有界（≈1M 状态单元，毫秒级），绝不挂死。
 * - index/matched 恒指向原始文件内容：命中时
 *   `fileContent.slice(index, index + matched.length) === matched` 恒成立，
 *   调用方可直接以 newText 替换该切片；matched 保留文件原有的 CRLF 等行尾
 *   原貌（行式匹配的窗口按"完整行"取片，不重写行尾）。
 * - 多点歧义：任一级命中多处时按 opts.onAmbiguous 处理——"report"（默认）
 *   返回 { ambiguous: true, occurrences, index: -1, matched: "" } 并终止阶梯；
 *   "first" 取第一处命中。block_anchor 取最高相似度为胜者，唯一最高分不算
 *   歧义，仅并列最高分才走歧义策略。
 * - 8 级 context_fallback 返回的是重锚窗口（唯一锚行 ±2 行，边界钳制），
 *   可能小于 oldText——调用方替换的是这个更小但精确的窗口，属预期行为。
 */

/** 模糊级（7/8）的输入规模上限（UTF-16 码元数，约 64KB 量级）。 */
export const FUZZY_MATCH_LIMIT_CHARS = 64 * 1024;

/** similarityRatio 内部单元预算：lenA×lenB 超过即按不相似处理（防挂死）。 */
export const SIMILARITY_CELL_BUDGET = 1_000_000;

/** 匹配命中的阶梯级别；unmatched 表示 8 级全败。 */
export type MatchLevel =
  | "exact"
  | "quote_normalized"
  | "line_number_stripped"
  | "whitespace_normalized"
  | "indentation_flexible"
  | "line_trimmed"
  | "block_anchor"
  | "context_fallback";

export type MatchOutcome = MatchLevel | "unmatched";

export interface MatchOptions {
  /**
   * 多点命中策略：`"report"`（默认）= 报歧义、不选择；`"first"` = 取第一处命中。
   */
  readonly onAmbiguous?: "report" | "first";
  /** block_anchor 中段相似度阈值（默认 0.8，达到即视为候选）。 */
  readonly similarityThreshold?: number;
}

export interface MatchResult {
  /** 命中级别；unmatched 表示全败（此时 index=-1、matched=""）。 */
  readonly level: MatchOutcome;
  /** 命中起始字符下标（指向原始 fileContent）；歧义/未命中为 -1。 */
  readonly index: number;
  /**
   * 命中的原始文本切片（保留文件原貌，含 CRLF）；
   * `fileContent.slice(index, index + matched.length) === matched` 恒成立。
   */
  readonly matched: string;
  /** 该级别多点命中且 onAmbiguous="report" 时为 true（此时 index=-1）。 */
  readonly ambiguous?: boolean;
  /** 歧义时的命中处数。 */
  readonly occurrences?: number;
}

interface ResolvedOptions {
  readonly onAmbiguous: "report" | "first";
  readonly similarityThreshold: number;
}

function resolveOptions(opts: MatchOptions): ResolvedOptions {
  return {
    onAmbiguous: opts.onAmbiguous ?? "report",
    similarityThreshold: opts.similarityThreshold ?? 0.8,
  };
}

const UNMATCHED: MatchResult = { level: "unmatched", index: -1, matched: "" };

function unmatched(): MatchResult {
  return { ...UNMATCHED };
}

/* ------------------------------------------------------------------ */
/* 相似度：自实现 Levenshtein 比率                                      */
/* ------------------------------------------------------------------ */

/**
 * Levenshtein 编辑距离。时间 O(lenA×lenB)，空间 O(min(lenA,lenB))（滚动行）。
 * 相同输入短路返回 0；任一侧为空返回另一侧长度。
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // 保证 b 为较短侧，滚动行开在短侧上。
  if (b.length > a.length) [a, b] = [b, a];
  const width = b.length;
  let prev: number[] = new Array(width + 1);
  let curr: number[] = new Array(width + 1);
  for (let j = 0; j <= width; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= width; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const deletion = prev[j]! + 1;
      const insertion = curr[j - 1]! + 1;
      const substitution = prev[j - 1]! + cost;
      curr[j] = Math.min(deletion, insertion, substitution);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[width]!;
}

/**
 * Levenshtein 相似度比率：(lenA + lenB - distance) / (lenA + lenB)。
 * 恒等 → 1；完全无关 → 趋近 0。空对空定义为 1。
 *
 * 复杂度保护：任一侧超过 FUZZY_MATCH_LIMIT_CHARS，或 lenA×lenB 超过
 * SIMILARITY_CELL_BUDGET（且非恒等）→ 直接返回 0（按不相似处理，调用方
 * 据此降级），保证最坏耗时有界。
 */
export function similarityRatio(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length > FUZZY_MATCH_LIMIT_CHARS || b.length > FUZZY_MATCH_LIMIT_CHARS) return 0;
  if (a.length * b.length > SIMILARITY_CELL_BUDGET) return 0;
  if (a.length === 0 || b.length === 0) {
    // 一侧为空：距离即另一侧长度，比率退化为 0。
    return 0;
  }
  const dist = levenshteinDistance(a, b);
  return (a.length + b.length - dist) / (a.length + b.length);
}

/* ------------------------------------------------------------------ */
/* 行切分：保留每行的原文起止与行尾终止符（\n / \r\n / \r）              */
/* ------------------------------------------------------------------ */

export interface LineSpan {
  /** 行内容（不含行尾终止符；\r 已与 \n 分离）。 */
  readonly text: string;
  /** 行首字符下标（指向原文）。 */
  readonly start: number;
  /** 行尾字符下标（不含终止符，指向原文）。 */
  readonly end: number;
  /** 该行的行尾终止符（"" 表示文件末行无终止符）。 */
  readonly term: string;
}

/**
 * 把文本切成行元数据。编辑器语义：文件以终止符结尾时，终止符归属末行，
 * 不产生额外的空尾行；空串产生一个空行。
 */
export function splitLines(text: string): LineSpan[] {
  const lines: LineSpan[] = [];
  let i = 0;
  let start = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\n" || ch === "\r") {
      const term = ch === "\r" && text[i + 1] === "\n" ? "\r\n" : ch;
      lines.push({ text: text.slice(start, i), start, end: i, term });
      i += term.length;
      start = i;
    } else {
      i += 1;
    }
  }
  if (start < text.length || lines.length === 0) {
    lines.push({ text: text.slice(start), start, end: text.length, term: "" });
  }
  return lines;
}

function endsWithLineTerminator(text: string): boolean {
  return text.endsWith("\n") || text.endsWith("\r");
}

/* ------------------------------------------------------------------ */
/* 歧义裁决与窗口取片                                                   */
/* ------------------------------------------------------------------ */

function charFinalize(
  level: MatchLevel,
  fileContent: string,
  occurrences: number[],
  spanLength: number,
  opts: ResolvedOptions,
): MatchResult | null {
  if (occurrences.length === 0) return null;
  if (occurrences.length > 1 && opts.onAmbiguous === "report") {
    return { level, index: -1, matched: "", ambiguous: true, occurrences: occurrences.length };
  }
  const index = occurrences[0]!;
  return { level, index, matched: fileContent.slice(index, index + spanLength) };
}

/**
 * 行窗口裁决：windows 为按行号给出的候选 [startLine, endLineExclusive)。
 * 唯一命中（或 onAmbiguous="first"）时取片为"完整行"原文片段；
 * oldText 以行尾终止符结尾且窗口末行在文件中确有终止符时，把终止符并入切片，
 * 保证"删一行"类替换语义正确。
 */
function lineFinalize(
  level: MatchLevel,
  fileContent: string,
  fileLines: LineSpan[],
  windows: Array<[number, number]>,
  oldText: string,
  opts: ResolvedOptions,
  extendTrailing: boolean,
): MatchResult | null {
  if (windows.length === 0) return null;
  if (windows.length > 1 && opts.onAmbiguous === "report") {
    return { level, index: -1, matched: "", ambiguous: true, occurrences: windows.length };
  }
  const [startLine, endLine] = windows[0]!;
  const first = fileLines[startLine]!;
  const last = fileLines[endLine - 1]!;
  let endChar = last.end;
  if (extendTrailing && endsWithLineTerminator(oldText)) endChar += last.term.length;
  return { level, index: first.start, matched: fileContent.slice(first.start, endChar) };
}

/* ------------------------------------------------------------------ */
/* 第 1/2 级：字符域（索引直映原文）                                     */
/* ------------------------------------------------------------------ */

function findCharOccurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    out.push(at);
    from = at + 1;
  }
  return out;
}

/** 第 1 级：精确子串匹配。 */
export function matchExact(
  fileContent: string,
  oldText: string,
  opts: MatchOptions = {},
): MatchResult | null {
  const resolved = resolveOptions(opts);
  const occurrences = findCharOccurrences(fileContent, oldText);
  return charFinalize("exact", fileContent, occurrences, oldText.length, resolved);
}

/**
 * 中英弯引号 ↔ 直引号双向归一：成对弯引号统一折算为直引号后匹配。
 * 归一为逐字符 1:1 保长映射，归一域中的下标与原文一一对应。
 */
function normalizeQuotes(text: string): string {
  return text
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
}

/** 第 2 级：引号归一匹配（弯引号与直引号互相兼容）。 */
export function matchQuoteNormalized(
  fileContent: string,
  oldText: string,
  opts: MatchOptions = {},
): MatchResult | null {
  const resolved = resolveOptions(opts);
  const normFile = normalizeQuotes(fileContent);
  const normOld = normalizeQuotes(oldText);
  const occurrences = findCharOccurrences(normFile, normOld);
  // 保长映射：归一域下标即原文下标。
  return charFinalize("quote_normalized", fileContent, occurrences, oldText.length, resolved);
}

/* ------------------------------------------------------------------ */
/* 第 3-6 级：行变换域（每行独立变换后按整块行窗口对齐）                  */
/* ------------------------------------------------------------------ */

const LINE_NUMBER_PREFIX = /^[\t ]*\d+(?:→|:)[\t ]*/;

/** 剥离行首 `N→` / `N:` 行号前缀（前缀与其后内容间的分隔空白一并剥除）。 */
function stripLineNumberPrefix(line: string): string {
  return line.replace(LINE_NUMBER_PREFIX, "");
}

/** 制表符统一 4 空格 + 剥离行尾随空白。 */
function normalizeWhitespace(line: string): string {
  return line.replace(/\t/g, "    ").replace(/[ \t]+$/, "");
}

/** 逐行 trim。 */
function trimLine(line: string): string {
  return line.trim();
}

/**
 * 行窗口通用匹配器：对文件与 oldText 的每一行施加同一 transform，
 * 在变换域里找与 oldText 行数相同的连续窗口。
 */
function matchLineWindow(
  level: MatchLevel,
  fileContent: string,
  oldText: string,
  transform: (line: string) => string,
  opts: ResolvedOptions,
  extendTrailing = true,
): MatchResult | null {
  if (oldText.length === 0) return null;
  const oldLines = splitLines(oldText).map((l) => transform(l.text));
  const fileLines = splitLines(fileContent);
  const norm = fileLines.map((l) => transform(l.text));
  const k = oldLines.length;
  const windows: Array<[number, number]> = [];
  outer: for (let i = 0; i + k <= norm.length; i++) {
    for (let j = 0; j < k; j++) {
      if (norm[i + j] !== oldLines[j]) continue outer;
    }
    windows.push([i, i + k]);
  }
  return lineFinalize(level, fileContent, fileLines, windows, oldText, opts, extendTrailing);
}

/** 第 3 级：剥离行号前缀后匹配。 */
export function matchLineNumberStripped(
  fileContent: string,
  oldText: string,
  opts: MatchOptions = {},
): MatchResult | null {
  return matchLineWindow("line_number_stripped", fileContent, oldText, stripLineNumberPrefix, resolveOptions(opts));
}

/** 第 4 级：空白归一匹配（制表符 → 4 空格、剥行尾空白）。 */
export function matchWhitespaceNormalized(
  fileContent: string,
  oldText: string,
  opts: MatchOptions = {},
): MatchResult | null {
  return matchLineWindow("whitespace_normalized", fileContent, oldText, normalizeWhitespace, resolveOptions(opts));
}

/** 第 6 级：逐行（先剥行号前缀再）trim 后整块比较。trim 前剥前缀是 L3 语义的组合：
 * 否则"模型复读行号 + 行内缩进漂移"的组合场景会在 3-6 级全数穿透；
 * L3（剥前缀+精确行匹配）先行命中更严格情形，本级为最宽松行级兜底，不影响 1-5 级优先级。 */
export function matchLineTrimmed(
  fileContent: string,
  oldText: string,
  opts: MatchOptions = {},
): MatchResult | null {
  return matchLineWindow(
    "line_trimmed",
    fileContent,
    oldText,
    (line) => trimLine(stripLineNumberPrefix(line)),
    resolveOptions(opts),
  );
}

/* ------------------------------------------------------------------ */
/* 第 5 级：缩进弹性（块级 dedent，非逐行变换）                          */
/* ------------------------------------------------------------------ */

/** 行首缩进（仅空格/制表符计入）。 */
function leadingIndent(line: string): string {
  const m = /^[\t ]+/.exec(line);
  return m === null ? "" : m[0];
}

function commonWhitespacePrefix(a: string, b: string): string {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return a.slice(0, i);
}

/**
 * 块级 dedent：以块内非空行行首缩进的最长公共前缀为基线剥除，
 * 相对缩进原样保留，空白行为行归一为 ""。由此"绝对缩进漂移"被抹平，
 * "相对结构差异"仍然暴露。
 */
function dedentLines(lines: string[]): string[] {
  let base: string | null = null;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const ws = leadingIndent(line);
    base = base === null ? ws : commonWhitespacePrefix(base, ws);
    if (base === "") break;
  }
  const prefix = base ?? "";
  return lines.map((line) => (line.trim() === "" ? "" : line.slice(prefix.length)));
}

/**
 * 第 5 级：块内相对缩进保持、绝对缩进重锚。
 * 把 oldText 与每个等行数文件窗口各自 dedent 后逐行比较；
 * 内容本体（除缩进外）仍需逐字符一致。空行不参与基线计算。
 */
export function matchIndentationFlexible(
  fileContent: string,
  oldText: string,
  opts: MatchOptions = {},
): MatchResult | null {
  const resolved = resolveOptions(opts);
  if (oldText.length === 0) return null;
  const fileLines = splitLines(fileContent);
  const oldLines = splitLines(oldText).map((l) => l.text);
  const oldRel = dedentLines(oldLines);
  const k = oldLines.length;
  const windows: Array<[number, number]> = [];
  for (let i = 0; i + k <= fileLines.length; i++) {
    const slice: string[] = [];
    for (let j = 0; j < k; j++) slice.push(fileLines[i + j]!.text);
    const rel = dedentLines(slice);
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (rel[j] !== oldRel[j]) {
        ok = false;
        break;
      }
    }
    if (ok) windows.push([i, i + k]);
  }
  return lineFinalize("indentation_flexible", fileContent, fileLines, windows, oldText, resolved, true);
}

/* ------------------------------------------------------------------ */
/* 第 7 级：块锚 + 中段模糊对齐                                         */
/* ------------------------------------------------------------------ */

/**
 * 第 7 级：块首尾各取一行（trim 后相等）作锚，中间行合并后以
 * similarityRatio ≥ similarityThreshold（默认 0.8）模糊对齐。
 * 胜者取最高相似度（同分取最早起点）；唯一最高分不歧义，
 * 并列最高分按歧义策略裁决。
 */
export function matchBlockAnchor(
  fileContent: string,
  oldText: string,
  opts: MatchOptions = {},
): MatchResult | null {
  const resolved = resolveOptions(opts);
  if (oldText.length === 0) return null;
  const fileLines = splitLines(fileContent);
  const oldLines = splitLines(oldText).map((l) => l.text);
  const k = oldLines.length;
  if (fileLines.length === 0) return null;
  const normFile = fileLines.map((l) => l.text.trim());
  const first = oldLines[0]!.trim();
  const last = oldLines[k - 1]!.trim();
  const middleOld = oldLines.slice(1, Math.max(1, k - 1)).join("\n");

  interface AnchorCandidate {
    readonly startLine: number;
    readonly endLine: number;
    readonly score: number;
  }
  const candidates: AnchorCandidate[] = [];
  for (let i = 0; i < fileLines.length; i++) {
    if (normFile[i] !== first) continue;
    if (k === 1) {
      // 单行块：锚即自身（阶梯语境下通常已被 1-6 级接住，此处兜底）。
      candidates.push({ startLine: i, endLine: i, score: 1 });
      continue;
    }
    for (let j = i + 1; j < fileLines.length; j++) {
      if (normFile[j] !== last) continue;
      const middle = fileLines
        .slice(i + 1, j)
        .map((l) => l.text)
        .join("\n");
      const score = similarityRatio(middle, middleOld);
      if (score >= resolved.similarityThreshold) {
        candidates.push({ startLine: i, endLine: j, score });
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort(
    (a, b) => b.score - a.score || a.startLine - b.startLine || a.endLine - b.endLine,
  );
  const top = candidates[0]!.score;
  const windows = candidates
    .filter((c) => c.score === top)
    .map((c) => [c.startLine, c.endLine + 1] as [number, number]);
  return lineFinalize("block_anchor", fileContent, fileLines, windows, oldText, resolved, true);
}

/* ------------------------------------------------------------------ */
/* 第 8 级：唯一上下文行 ±2 窗口重锚                                    */
/* ------------------------------------------------------------------ */

/**
 * 第 8 级：在 oldText 各行中找"在目标文件中恰好出现一次"（trim 后比较、
 * 按行序取最早者）的唯一上下文行作锚，返回锚行 ±2 行（边界钳制）的窗口。
 * 窗口可能小于 oldText——调用方替换这个更小但精确的锚窗。锚唯一，故本级
 * 不会产生多点歧义；不扩展行尾终止符。
 */
export function matchContextFallback(
  fileContent: string,
  oldText: string,
  opts: MatchOptions = {},
): MatchResult | null {
  const resolved = resolveOptions(opts);
  if (oldText.length === 0) return null;
  const fileLines = splitLines(fileContent);
  const oldLines = splitLines(oldText).map((l) => l.text);
  const counts = new Map<string, number>();
  for (const l of fileLines) {
    const key = l.text.trim();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let oldAnchor = -1;
  for (let idx = 0; idx < oldLines.length; idx++) {
    const key = oldLines[idx]!.trim();
    if (key === "") continue;
    if ((counts.get(key) ?? 0) === 1) {
      oldAnchor = idx;
      break;
    }
  }
  if (oldAnchor < 0) return null;
  const key = oldLines[oldAnchor]!.trim();
  let fileAnchor = -1;
  for (let i = 0; i < fileLines.length; i++) {
    if (fileLines[i]!.text.trim() === key) {
      fileAnchor = i;
      break;
    }
  }
  if (fileAnchor < 0) return null; // 计数得唯一却找不到，理论不可达，防御性返回。
  const from = Math.max(0, fileAnchor - 2);
  const to = Math.min(fileLines.length - 1, fileAnchor + 2);
  return lineFinalize(
    "context_fallback",
    fileContent,
    fileLines,
    [[from, to + 1]],
    oldText,
    resolved,
    false,
  );
}

/* ------------------------------------------------------------------ */
/* 阶梯总装                                                             */
/* ------------------------------------------------------------------ */

/**
 * 8 级阶梯弹性匹配主入口：逐级降级尝试，低级命中即停；第 7/8 级在
 * fileContent 或 oldText 超过 FUZZY_MATCH_LIMIT_CHARS 时直接跳过；
 * 8 级全败返回 { level: "unmatched", index: -1, matched: "" }。
 */
export function matchOldText(
  fileContent: string,
  oldText: string,
  opts: MatchOptions = {},
): MatchResult {
  if (oldText.length === 0 || fileContent.length === 0) return unmatched();
  const overLimit =
    fileContent.length > FUZZY_MATCH_LIMIT_CHARS || oldText.length > FUZZY_MATCH_LIMIT_CHARS;
  const ladder: Array<(() => MatchResult | null) | null> = [
    () => matchExact(fileContent, oldText, opts),
    () => matchQuoteNormalized(fileContent, oldText, opts),
    () => matchLineNumberStripped(fileContent, oldText, opts),
    () => matchWhitespaceNormalized(fileContent, oldText, opts),
    () => matchIndentationFlexible(fileContent, oldText, opts),
    () => matchLineTrimmed(fileContent, oldText, opts),
    overLimit ? null : () => matchBlockAnchor(fileContent, oldText, opts),
    overLimit ? null : () => matchContextFallback(fileContent, oldText, opts),
  ];
  for (const step of ladder) {
    const result = step?.();
    if (result !== null && result !== undefined) return result;
  }
  return unmatched();
}
