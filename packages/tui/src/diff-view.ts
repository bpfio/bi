/**
 * BI-20 / E 工位 —— 交互式 Git Unified Diff 审查门。
 *
 * 三层职责,全部纯函数 + 注入回调,零第三方依赖:
 *   1. parseDiff          —— 容忍 --no-index / 新增 / 删除 / 重命名 / 二进制头的 hunk 解析 → DiffModel
 *   2. renderDiff         —— DiffModel → 带色终端行数组(增绿/删红/文件头青,纯 ANSI)
 *   3. presentDiff        —— 审查门:渲染视图交给注入的 confirm 回调,产出 approve/reject 决策
 *
 * 另提供 buildDiffFromFiles:直接由旧/新文件文本对构建 DiffModel(内置 LCS 行级 diff)。
 */

// ---------------------------------------------------------------------------
// ANSI 常量(纯转义序列,无任何渲染库)
// ---------------------------------------------------------------------------

export const ANSI = {
  reset: '\u001b[0m',
  green: '\u001b[32m',
  red: '\u001b[31m',
  cyan: '\u001b[36m',
  dim: '\u001b[2m',
} as const;

function paint(color: string, text: string): string {
  return `${color}${text}${ANSI.reset}`;
}

// ---------------------------------------------------------------------------
// DiffModel 结构
// ---------------------------------------------------------------------------

export type DiffLineKind = 'add' | 'del' | 'context' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  /** 行内容(不含 +/-/空格 前缀;meta 行保留原文) */
  text: string;
  /** 旧文件 1-based 行号;该行不属于旧文件时为 null */
  oldNum: number | null;
  /** 新文件 1-based 行号;该行不属于新文件时为 null */
  newNum: number | null;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** @@ ... @@ 之后的节标题,可空 */
  heading: string | null;
  lines: DiffLine[];
}

export type DiffFileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'binary';

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: DiffFileStatus;
  isBinary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface DiffModel {
  files: DiffFile[];
  additions: number;
  deletions: number;
}

// ---------------------------------------------------------------------------
// 解析:git diff 文本 → DiffModel
// ---------------------------------------------------------------------------

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

interface DraftHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  heading: string | null;
  oldCursor: number;
  newCursor: number;
  remainingOld: number;
  remainingNew: number;
  lines: DiffLine[];
}

interface DraftFile {
  gitAPath: string | null;
  gitBPath: string | null;
  /** --- 头解析结果;null = /dev/null;undefined = 该行未出现 */
  oldHeaderPath: string | null | undefined;
  newHeaderPath: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  marked: 'added' | 'deleted' | null;
  isBinary: boolean;
  hunks: DiffHunk[];
}

function emptyDraft(): DraftFile {
  return {
    gitAPath: null,
    gitBPath: null,
    oldHeaderPath: undefined,
    newHeaderPath: undefined,
    renameFrom: null,
    renameTo: null,
    marked: null,
    isBinary: false,
    hunks: [],
  };
}

function stripPathPrefix(p: string): string {
  const unquoted = p.replace(/^"(.*)"$/, '$1');
  if (unquoted.startsWith('a/') || unquoted.startsWith('b/')) return unquoted.slice(2);
  return unquoted;
}

/** 解析 ---/+++ 头路径;返回 null 表示 /dev/null */
function parseHeaderPath(raw: string): string | null {
  const first = raw.split('\t')[0] ?? '';
  const s = first.trim();
  if (s === '' || s === '/dev/null') return null;
  return stripPathPrefix(s);
}

function draftFromGitHeader(line: string): DraftFile {
  const rest = line.slice('diff --git '.length);
  const idx = rest.indexOf(' b/');
  const aPart = idx >= 0 ? rest.slice(0, idx) : rest;
  const bPart = idx >= 0 ? rest.slice(idx + 3) : '';
  const d = emptyDraft();
  d.gitAPath = stripPathPrefix(aPart);
  d.gitBPath = stripPathPrefix(bPart);
  return d;
}

function startHunk(m: RegExpExecArray): DraftHunk {
  const oldStart = Number(m[1] ?? 0);
  const oldCount = m[2] !== undefined ? Number(m[2]) : 1;
  const newStart = Number(m[3] ?? 0);
  const newCount = m[4] !== undefined ? Number(m[4]) : 1;
  const heading = (m[5] ?? '').trim();
  return {
    oldStart,
    oldCount,
    newStart,
    newCount,
    heading: heading === '' ? null : heading,
    oldCursor: oldStart,
    newCursor: newStart,
    remainingOld: oldCount,
    remainingNew: newCount,
    lines: [],
  };
}

/**
 * 尝试把一行归入当前 hunk。
 * 以 hunk 头声明的新旧计数为准消费 +/-/上下文行,天然容忍内容行以特殊字符开头。
 * 返回 false 表示该行不属于 hunk(计数已耗尽或为头行),由调用方回落到文件级处理。
 */
function tryConsumeHunkLine(h: DraftHunk, line: string): boolean {
  // "\ No newline at end of file" 标记行
  if (line.startsWith('\\')) {
    h.lines.push({ kind: 'meta', text: line, oldNum: null, newNum: null });
    return true;
  }
  if (line === '') {
    // 邮件管道常剥掉上下文行的前导空格:空行且计数未满时按上下文容忍
    if (h.remainingOld > 0 && h.remainingNew > 0) {
      h.lines.push({ kind: 'context', text: '', oldNum: h.oldCursor++, newNum: h.newCursor++ });
      h.remainingOld--;
      h.remainingNew--;
      return true;
    }
    if (h.remainingOld > 0) {
      h.lines.push({ kind: 'context', text: '', oldNum: h.oldCursor++, newNum: null });
      h.remainingOld--;
      return true;
    }
    if (h.remainingNew > 0) {
      h.lines.push({ kind: 'context', text: '', oldNum: null, newNum: h.newCursor++ });
      h.remainingNew--;
      return true;
    }
    return false;
  }
  const c = line.charAt(0);
  if (c === '+' && h.remainingNew > 0) {
    h.lines.push({ kind: 'add', text: line.slice(1), oldNum: null, newNum: h.newCursor++ });
    h.remainingNew--;
    return true;
  }
  if (c === '-' && h.remainingOld > 0) {
    h.lines.push({ kind: 'del', text: line.slice(1), oldNum: h.oldCursor++, newNum: null });
    h.remainingOld--;
    return true;
  }
  if (c === ' ' && h.remainingOld > 0 && h.remainingNew > 0) {
    h.lines.push({ kind: 'context', text: line.slice(1), oldNum: h.oldCursor++, newNum: h.newCursor++ });
    h.remainingOld--;
    h.remainingNew--;
    return true;
  }
  // 计数失衡的畸形 diff:按仍有余量的一侧记账,保持行号推进
  if (c === ' ' && h.remainingOld > 0) {
    h.lines.push({ kind: 'context', text: line.slice(1), oldNum: h.oldCursor++, newNum: null });
    h.remainingOld--;
    return true;
  }
  if (c === ' ' && h.remainingNew > 0) {
    h.lines.push({ kind: 'context', text: line.slice(1), oldNum: null, newNum: h.newCursor++ });
    h.remainingNew--;
    return true;
  }
  return false;
}

function finishFile(d: DraftFile): DiffFile {
  let additions = 0;
  let deletions = 0;
  for (const h of d.hunks) {
    for (const l of h.lines) {
      if (l.kind === 'add') additions++;
      else if (l.kind === 'del') deletions++;
    }
  }
  const status: DiffFileStatus = d.isBinary
    ? 'binary'
    : d.renameFrom !== null
      ? 'renamed'
      : d.marked === 'added' || (d.oldHeaderPath === null && d.oldHeaderPath !== undefined)
        ? 'added'
        : d.marked === 'deleted' || (d.newHeaderPath === null && d.newHeaderPath !== undefined)
          ? 'deleted'
          : 'modified';
  const path =
    d.newHeaderPath ?? d.renameTo ?? d.gitBPath ?? d.oldHeaderPath ?? d.gitAPath ?? '(unknown)';
  const oldPath =
    d.renameFrom ?? (status === 'added' ? null : d.oldHeaderPath ?? d.gitAPath ?? null);
  return { path, oldPath, status, isBinary: d.isBinary, additions, deletions, hunks: d.hunks };
}

/**
 * 解析 git unified diff 文本(或任意 unified diff)为结构化 DiffModel。
 * 容忍:--no-index 路径、new file / deleted file 模式、rename 头、
 * Binary files ... differ / GIT binary patch、\ No newline 标记、省略计数的 hunk 头。
 */
export function parseDiff(text: string): DiffModel {
  const lines = text.split(/\r?\n/);
  const files: DiffFile[] = [];
  let cur: DraftFile | null = null;
  let hunk: DraftHunk | null = null;

  const closeHunk = (): void => {
    if (!hunk || !cur) {
      hunk = null;
      return;
    }
    cur.hunks.push({
      oldStart: hunk.oldStart,
      oldCount: hunk.oldCount,
      newStart: hunk.newStart,
      newCount: hunk.newCount,
      heading: hunk.heading,
      lines: hunk.lines,
    });
    hunk = null;
  };
  const closeFile = (): void => {
    closeHunk();
    if (cur) {
      files.push(finishFile(cur));
      cur = null;
    }
  };

  for (let i = 0; i < lines.length; ) {
    const line = lines[i] ?? '';

    // ---- hunk 内容优先(计数权威) ----
    if (hunk) {
      if (tryConsumeHunkLine(hunk, line)) {
        i++;
        continue;
      }
      closeHunk(); // 计数耗尽或遇到头行 → 结束 hunk,本行回落文件级
    }

    // ---- hunk 头 ----
    const m = HUNK_RE.exec(line);
    if (m) {
      hunk = startHunk(m);
      i++;
      continue;
    }

    // ---- 文件级头行 ----
    if (line.startsWith('diff --git ')) {
      closeFile();
      cur = draftFromGitHeader(line);
      i++;
      continue;
    }
    if (line.startsWith('new file mode')) {
      cur ??= emptyDraft();
      cur.marked = 'added';
      i++;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      cur ??= emptyDraft();
      cur.marked = 'deleted';
      i++;
      continue;
    }
    if (line.startsWith('rename from ')) {
      cur ??= emptyDraft();
      cur.renameFrom = stripPathPrefix(line.slice('rename from '.length).trim());
      i++;
      continue;
    }
    if (line.startsWith('rename to ')) {
      cur ??= emptyDraft();
      cur.renameTo = stripPathPrefix(line.slice('rename to '.length).trim());
      i++;
      continue;
    }
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      cur ??= emptyDraft();
      cur.isBinary = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const p = parseHeaderPath(line.slice(4));
      if (!cur) cur = emptyDraft();
      cur.oldHeaderPath = p;
      i++;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = parseHeaderPath(line.slice(4));
      if (!cur) cur = emptyDraft();
      cur.newHeaderPath = p;
      i++;
      continue;
    }

    // index / similarity / mode 变更及其他杂项头行:忽略
    i++;
  }
  closeFile();

  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return { files, additions, deletions };
}

// ---------------------------------------------------------------------------
// 渲染:DiffModel → 带色终端行数组
// ---------------------------------------------------------------------------

export function formatHunkHeader(h: DiffHunk): string {
  const head = `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`;
  return h.heading ? `${head} ${h.heading}` : head;
}

function fileTag(f: DiffFile): string {
  if (f.isBinary) return 'B';
  switch (f.status) {
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    default:
      return 'M';
  }
}

/**
 * 渲染为带色终端行数组:增行绿、删行红、文件头与 hunk 头青、meta 暗淡、上下文无色。
 */
export function renderDiff(model: DiffModel): string[] {
  const out: string[] = [];
  for (const f of model.files) {
    const label =
      f.status === 'renamed' && f.oldPath !== null ? `${f.oldPath} -> ${f.path}` : f.path;
    const suffix = f.isBinary ? ' (binary)' : ` (+${f.additions} -${f.deletions})`;
    out.push(paint(ANSI.cyan, `[${fileTag(f)}] ${label}${suffix}`));
    for (const h of f.hunks) {
      out.push(paint(ANSI.cyan, formatHunkHeader(h)));
      for (const l of h.lines) {
        if (l.kind === 'add') out.push(paint(ANSI.green, `+${l.text}`));
        else if (l.kind === 'del') out.push(paint(ANSI.red, `-${l.text}`));
        else if (l.kind === 'meta') out.push(paint(ANSI.dim, l.text));
        else out.push(` ${l.text}`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 审查门:presentDiff
// ---------------------------------------------------------------------------

export interface DiffGateSummary {
  files: number;
  additions: number;
  deletions: number;
}

export interface DiffGateDecision {
  decision: 'approve' | 'reject';
  reason?: string;
}

export interface DiffGateOptions {
  /** 跳过人工确认直接放行(脚本/测试回路) */
  autoApprove?: boolean;
  /**
   * 审查回调:拿到渲染后的终端行与汇总,返回 true=approve / false=reject。
   * 测试注入假回调,不进真实 TUI。
   */
  confirm?: (view: readonly string[], summary: DiffGateSummary) => boolean | Promise<boolean>;
}

/**
 * 审查门。默认拒绝(fail-closed):
 *   - autoApprove      → approve,不触发回调
 *   - 空模型           → approve(无可审内容)
 *   - 未注入 confirm   → reject
 *   - 回调抛错         → reject
 */
export async function presentDiff(
  model: DiffModel,
  options: DiffGateOptions = {},
): Promise<DiffGateDecision> {
  const summary: DiffGateSummary = {
    files: model.files.length,
    additions: model.additions,
    deletions: model.deletions,
  };
  if (options.autoApprove) return { decision: 'approve' };
  if (summary.files === 0) return { decision: 'approve', reason: 'diff 为空,无需审查' };
  if (!options.confirm) return { decision: 'reject', reason: '未注册审查回调,默认拒绝' };

  const view = renderDiff(model);
  let verdict: boolean;
  try {
    verdict = await options.confirm(view, summary);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { decision: 'reject', reason: `审查回调异常: ${msg}` };
  }
  return verdict
    ? { decision: 'approve' }
    : { decision: 'reject', reason: '审查者否决了本次变更' };
}

// ---------------------------------------------------------------------------
// 旧/新文件对 → DiffModel(内置 LCS 行级 diff)
// ---------------------------------------------------------------------------

type LcsOp = { t: 'eq' | 'del' | 'add'; text: string };

function splitContent(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function diffLines(a: string[], b: string[]): LcsOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((text) => ({ t: 'add' as const, text }));
  if (m === 0) return a.map((text) => ({ t: 'del' as const, text }));
  if (n * m > 2_000_000) {
    // 超大文件兜底:放弃 LCS,整块替换,保证不爆内存
    return [
      ...a.map((text) => ({ t: 'del' as const, text })),
      ...b.map((text) => ({ t: 'add' as const, text })),
    ];
  }
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const ops: LcsOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: 'eq', text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ t: 'del', text: a[i]! });
      i++;
    } else {
      ops.push({ t: 'add', text: b[j]! });
      j++;
    }
  }
  while (i < n) {
    ops.push({ t: 'del', text: a[i]! });
    i++;
  }
  while (j < m) {
    ops.push({ t: 'add', text: b[j]! });
    j++;
  }
  return ops;
}

function opsToHunks(ops: LcsOp[], context: number): DiffHunk[] {
  const changed: number[] = [];
  for (let idx = 0; idx < ops.length; idx++) {
    const op = ops[idx];
    if (op && op.t !== 'eq') changed.push(idx);
  }
  if (changed.length === 0) return [];

  // 变更点向两侧扩 context,相邻区域合并
  const regions: Array<[number, number]> = [];
  const first = changed[0]!;
  let start = Math.max(0, first - context);
  let end = Math.min(ops.length - 1, first + context);
  for (let k = 1; k < changed.length; k++) {
    const c = changed[k]!;
    const s = Math.max(0, c - context);
    const e = Math.min(ops.length - 1, c + context);
    if (s <= end + 1) {
      end = e;
    } else {
      regions.push([start, end]);
      start = s;
      end = e;
    }
  }
  regions.push([start, end]);

  const hunks: DiffHunk[] = [];
  let oldNum = 1;
  let newNum = 1;
  for (const [s, e] of regions) {
    const lines: DiffLine[] = [];
    let oldCount = 0;
    let newCount = 0;
    let seenOldStart: number | null = null;
    let seenNewStart: number | null = null;
    // 纯增/纯删区域的起始行号按 git 惯例取前一行(文件头则为 0)
    const fallbackOldStart = Math.max(0, oldNum - 1);
    const fallbackNewStart = Math.max(0, newNum - 1);
    for (let idx = s; idx <= e; idx++) {
      const op = ops[idx]!;
      if (op.t === 'eq') {
        lines.push({ kind: 'context', text: op.text, oldNum, newNum });
        if (seenOldStart === null) seenOldStart = oldNum;
        if (seenNewStart === null) seenNewStart = newNum;
        oldCount++;
        newCount++;
        oldNum++;
        newNum++;
      } else if (op.t === 'del') {
        lines.push({ kind: 'del', text: op.text, oldNum, newNum: null });
        if (seenOldStart === null) seenOldStart = oldNum;
        oldCount++;
        oldNum++;
      } else {
        lines.push({ kind: 'add', text: op.text, oldNum: null, newNum });
        if (seenNewStart === null) seenNewStart = newNum;
        newCount++;
        newNum++;
      }
    }
    hunks.push({
      oldStart: seenOldStart ?? fallbackOldStart,
      oldCount,
      newStart: seenNewStart ?? fallbackNewStart,
      newCount,
      heading: null,
      lines,
    });
  }
  return hunks;
}

/**
 * 由旧/新文件文本对直接构建 DiffModel(等效单文件 git diff,context 缺省 3 行)。
 */
export function buildDiffFromFiles(
  oldText: string,
  newText: string,
  path: string,
  contextLines = 3,
): DiffModel {
  const a = splitContent(oldText);
  const b = splitContent(newText);
  const hunks = opsToHunks(diffLines(a, b), contextLines);
  let additions = 0;
  let deletions = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.kind === 'add') additions++;
      else if (l.kind === 'del') deletions++;
    }
  }
  const status: DiffFileStatus = a.length === 0 ? 'added' : b.length === 0 ? 'deleted' : 'modified';
  return {
    files: [
      {
        path,
        oldPath: status === 'added' ? null : path,
        status,
        isBinary: false,
        additions,
        deletions,
        hunks,
      },
    ],
    additions,
    deletions,
  };
}
