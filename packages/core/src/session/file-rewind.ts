/**
 * 会话时光倒流与物理文件差分回滚引擎（BI-03.1）：diff 轨。
 *
 * 职责：
 *  - `computeFilePatch(before, after)`：行级 LCS diff（自实现，零外部依赖）→
 *    结构化 hunk（oldStart/oldLines/newStart/newLines + 行级 op 列表），
 *    携带前后内容 SHA-256（错位回滚防护锚点）。
 *  - `applyPatch`：正向应用（逐 hunk 上下文校验，不匹配抛 PatchApplyError）；
 *    `reversePatch`：反向重排（+↔- 互换、old/new 坐标互换、哈希互换）；
 *    `rewindFile(current, patch)` = applyPatch(current, reversePatch(patch))。
 *  - `FileRewindEngine`：`snapshotBeforeEdit`（读现文件存基线内容哈希）+
 *    `rewind`（校验当前内容哈希 == patch.afterHash 后才回滚；经
 *    ../utils/atomic-write 原子写回；返回 restoredSha）。哈希不符 →
 *    { ok:false, code:'diverged' }：工作区已被独立改动，拒绝盲目回滚
 *    （物理级无损的前提）。
 *
 * 行文本约定（字节级无损的关键）：line.text 保留该行的行尾换行符；
 * 仅当该行是源文件末行且文件不以换行结尾时，text 不含换行。
 * 因此 patch 行序列与文件行序列（splitLines 产物）逐字节可比，
 * apply/reverse 全程无换行歧义（含尾部无换行、空行、中文）。
 *
 * 接缝④：本模块与 file-history.ts（BI-03.2 blob 轨）两轨并存——
 *  - 本模块严禁写 FileHistory 的数据区（BlobStore/index.jsonl）；
 *  - 可选联动 deps.readHistory 只开放只读查询端口（FileHistoryReadOnlyPort），
 *    缺省不联动；联动仅用于把 blob 轨最近一次先验哈希附在快照上供观测。
 *
 * 复杂度：公共前后缀修剪 + 中段 LCS DP（O(m·n) 时间/空间）；
 * 中段规模超过 MAX_LCS_CELLS 时降级为「中段整体替换」补丁（正确性不变，粒度变粗）。
 */
import { readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { sha256Hex } from "./blob-store";
import type { FileHistoryRecord, HistoryQuery } from "./file-history";
import { atomicWriteFile } from "../utils/atomic-write";

/** 上下文半径：每个 hunk 在变更两侧各携带的上下文行数。 */
const CONTEXT_RADIUS = 3;

/** 中段 LCS DP 的规模上限（格数）；超过即降级为整体替换补丁。 */
const MAX_LCS_CELLS = 4_000_000;

const EMPTY_BYTES = new Uint8Array(0);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 补丁行操作：' '=上下文 / '+'=新增 / '-'=删除。 */
export type PatchOp = " " | "+" | "-";

/** 补丁行。text 保留行尾换行（源文件末行无换行时除外，见模块 doc）。 */
export interface PatchLine {
  op: PatchOp;
  text: string;
}

/** 结构化 hunk：old* 描述 before 坐标，new* 描述 after 坐标（行号 1-based）。 */
export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: PatchLine[];
}

/** 文件差分补丁（含前后内容哈希，用于错位回滚防护与反向校验）。 */
export interface FilePatch {
  beforeHash: string;
  afterHash: string;
  hunks: PatchHunk[];
}

/** 补丁无法应用于当前内容（上下文/定位校验失败）。 */
export class PatchApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchApplyError";
  }
}

/** 按行切分内容：每行保留行尾 '\n'，仅末行（无换行结尾时）不带。join('') 即原文字节。 */
export function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines: string[] = [];
  let start = 0;
  for (;;) {
    const nl = content.indexOf("\n", start);
    if (nl === -1) {
      lines.push(content.slice(start));
      break;
    }
    lines.push(content.slice(start, nl + 1));
    start = nl + 1;
    if (start === content.length) break; // 以换行结尾：不产出幽灵空行
  }
  return lines;
}

/**
 * 行级差分：LCS 自实现 → 结构化补丁。
 * before === after 时 hunks 为空数组（恒等补丁）。
 */
export function computeFilePatch(before: string, after: string): FilePatch {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const annotated = buildAnnotatedOps(beforeLines, afterLines);
  return {
    beforeHash: sha256Hex(encoder.encode(before)),
    afterHash: sha256Hex(encoder.encode(after)),
    hunks: assembleHunks(annotated),
  };
}

/** 正向应用：逐 hunk 复制未触及区、逐行校验上下文/删除行与现内容一致。 */
export function applyPatch(fileContent: string, patch: FilePatch): string {
  const lines = splitLines(fileContent);
  const out: string[] = [];
  let src = 0; // 下一个待消费的现内容行（0-based）
  for (const hunk of patch.hunks) {
    // oldLines === 0 为纯插入 hunk：oldStart 语义为「插到第 oldStart 行之后」。
    const target = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
    if (target < src || target > lines.length) {
      throw new PatchApplyError(
        `hunk 定位越界或交叠: oldStart=${hunk.oldStart} oldLines=${hunk.oldLines}（已消费 ${src} 行，现内容共 ${lines.length} 行）`,
      );
    }
    for (let k = src; k < target; k++) out.push(lines[k] as string);
    src = target;
    for (const line of hunk.lines) {
      if (line.op === "+") {
        out.push(line.text);
        continue;
      }
      const actual = lines[src];
      if (actual === undefined || actual !== line.text) {
        throw new PatchApplyError(
          `hunk 上下文校验失败（现内容第 ${src + 1} 行）: 期望 ${JSON.stringify(line.text)}，实际 ${JSON.stringify(actual ?? null)}`,
        );
      }
      if (line.op === " ") out.push(actual); // '-' 仅消费校验，不进入输出
      src += 1;
    }
  }
  for (let k = src; k < lines.length; k++) out.push(lines[k] as string);
  return out.join("");
}

/** 反向重排：+↔- 互换，old/new 坐标互换，哈希互换（逆补丁的逆=原补丁）。 */
export function reversePatch(patch: FilePatch): FilePatch {
  return {
    beforeHash: patch.afterHash,
    afterHash: patch.beforeHash,
    hunks: patch.hunks.map((hunk) => ({
      oldStart: hunk.newStart,
      oldLines: hunk.newLines,
      newStart: hunk.oldStart,
      newLines: hunk.oldLines,
      lines: hunk.lines.map((line): PatchLine => ({
        op: line.op === " " ? " " : line.op === "+" ? "-" : "+",
        text: line.text,
      })),
    })),
  };
}

/** 时光倒流 = 对当前内容应用逆补丁。 */
export function rewindFile(current: string, patch: FilePatch): string {
  return applyPatch(current, reversePatch(patch));
}

/* ------------------------------ FileRewindEngine ------------------------------ */

/**
 * fileHistory 只读联动端口（接缝④）：仅暴露查询；引擎永不调用
 * snapshotBefore/restore 等写路径，不产生任何 blob/index 写入。
 * FileHistoryService 结构上满足该端口。
 */
export interface FileHistoryReadOnlyPort {
  query(filter?: HistoryQuery): Promise<FileHistoryRecord[]>;
}

export interface FileRewindDeps {
  /** 读文件端口（测试确定性注入）；默认 node:fs/promises readFile。 */
  fs?: {
    readFile(path: string): Promise<Uint8Array>;
  };
  /** 可选 fileHistory 只读联动；缺省不联动（接缝④：两轨并存，互不写对方数据区）。 */
  readHistory?: FileHistoryReadOnlyPort;
}

/** 写前基线快照：patch 上下文（基线内容哈希）。 */
export interface FileSnapshot {
  /** 归一化绝对路径。 */
  path: string;
  /** 快照内容 SHA-256（文件不存在时为 SHA-256("")）。 */
  sha256: string;
  /** 快照字节数。 */
  size: number;
  /** 快照时文件是否存在。 */
  exists: boolean;
  /** 只读联动观测项：blob 轨该文件最近一条记录的 priorSha256（无联动/无记录时不设）。 */
  historyPriorSha256?: string;
}

export type RewindResult =
  | { ok: true; restoredSha: string }
  | { ok: false; code: "diverged"; expectedHash: string; actualHash: string };

function defaultReadFile(path: string): Promise<Uint8Array> {
  return readFile(path);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code
  );
}

/**
 * 物理文件差分回滚引擎。
 * 回滚语义为「字节状态」（与 file-history 的 created-before 零字节语义一致）：
 * 只回写字节，不翻转文件存在性。
 */
export class FileRewindEngine {
  readonly #readFile: (path: string) => Promise<Uint8Array>;
  readonly #readHistory: FileHistoryReadOnlyPort | undefined;
  /** patch 上下文基线（最近一次 snapshotBeforeEdit，按归一化路径存放）。 */
  readonly #snapshots = new Map<string, FileSnapshot>();

  constructor(deps: FileRewindDeps = {}) {
    this.#readFile = deps.fs?.readFile ?? defaultReadFile;
    this.#readHistory = deps.readHistory;
  }

  /**
   * 编辑前快照：读现文件存基线内容哈希（不存在记为空字节快照）。
   * 注入 readHistory 时附加 blob 轨最近先验哈希（只读，联动失败不阻断）。
   */
  async snapshotBeforeEdit(rawPath: string): Promise<FileSnapshot> {
    const path = resolve(rawPath);
    let bytes: Uint8Array;
    let exists = true;
    try {
      bytes = await this.#readFile(path);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      bytes = EMPTY_BYTES;
      exists = false;
    }
    const snapshot: FileSnapshot = {
      path,
      sha256: sha256Hex(bytes),
      size: bytes.byteLength,
      exists,
    };
    if (this.#readHistory !== undefined) {
      try {
        const latest = (await this.#readHistory.query({ filePath: path }))[0];
        if (latest !== undefined) snapshot.historyPriorSha256 = latest.priorSha256;
      } catch {
        // 只读联动属观测增强，失败不阻断快照主流程。
      }
    }
    this.#snapshots.set(path, snapshot);
    return { ...snapshot };
  }

  /** 最近一次基线快照（未快照过返回 undefined）。 */
  lastSnapshot(rawPath: string): FileSnapshot | undefined {
    const snapshot = this.#snapshots.get(resolve(rawPath));
    return snapshot === undefined ? undefined : { ...snapshot };
  }

  /**
   * 时光倒流：校验当前内容哈希 == patch.afterHash（防错位回滚）→
   * 应用逆补丁 → 原子写回。哈希不符返回 diverged（工作区已被独立改动，
   * 拒绝盲目回滚——物理级无损的前提）。
   */
  async rewind(rawPath: string, patch: FilePatch): Promise<RewindResult> {
    const path = resolve(rawPath);
    let bytes: Uint8Array;
    try {
      bytes = await this.#readFile(path);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      bytes = EMPTY_BYTES;
    }
    const actualHash = sha256Hex(bytes);
    if (actualHash !== patch.afterHash) {
      return { ok: false, code: "diverged", expectedHash: patch.afterHash, actualHash };
    }
    const restored = rewindFile(decoder.decode(bytes), patch);
    const restoredBytes = encoder.encode(restored);
    const restoredSha = sha256Hex(restoredBytes);
    if (restoredSha !== patch.beforeHash) {
      // 结构性不变量（computeFilePatch/apply 造补丁必满足）；触发即 bug。
      throw new Error(
        `回滚不变量破坏: restoredSha=${restoredSha} != patch.beforeHash=${patch.beforeHash}`,
      );
    }
    await mkdir(dirname(path), { recursive: true });
    await atomicWriteFile(path, restoredBytes);
    return { ok: true, restoredSha };
  }
}

/* ---------------------------------- 内部：LCS 与 hunk 装配 ---------------------------------- */

interface AnnotatedOp {
  op: PatchOp;
  text: string;
  /** 该行在 before 中的 1-based 行号（'+' 行为插入位次的旧计数）。 */
  oldNo: number;
  /** 该行在 after 中的 1-based 行号（'-' 行为删除位次的新计数）。 */
  newNo: number;
}

/** 全文件操作序列：公共前后缀修剪 + 中段 LCS 回走（'-' 先于 '+' 的规范序）。 */
function buildAnnotatedOps(a: string[], b: string[]): AnnotatedOp[] {
  const ops: AnnotatedOp[] = [];
  let oldNo = 1;
  let newNo = 1;

  const minLen = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < minLen && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < minLen - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
    suffix += 1;
  }

  const emitContext = (text: string): void => {
    ops.push({ op: " ", text, oldNo, newNo });
    oldNo += 1;
    newNo += 1;
  };

  for (let k = 0; k < prefix; k++) emitContext(a[k] as string);

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const m = midA.length;
  const n = midB.length;
  let i = 0;
  let j = 0;
  if (m * n > MAX_LCS_CELLS) {
    // 规模降级：中段整体替换（正确性不变，仅粒度变粗；防 DP 内存失控）。
    while (i < m || j < n) {
      if (i < m) {
        ops.push({ op: "-", text: midA[i] as string, oldNo, newNo });
        i += 1;
        oldNo += 1;
        continue;
      }
      ops.push({ op: "+", text: midB[j] as string, oldNo, newNo });
      j += 1;
      newNo += 1;
    }
  } else {
    const table = buildLcsTable(midA, midB);
    const width = n + 1;
    const lcsAt = (row: number, col: number): number => table[row * width + col] ?? 0;
    while (i < m || j < n) {
      if (i >= m) {
        ops.push({ op: "+", text: midB[j] as string, oldNo, newNo });
        j += 1;
        newNo += 1;
        continue;
      }
      if (j >= n) {
        ops.push({ op: "-", text: midA[i] as string, oldNo, newNo });
        i += 1;
        oldNo += 1;
        continue;
      }
      if (midA[i] === midB[j]) {
        ops.push({ op: " ", text: midA[i] as string, oldNo, newNo });
        i += 1;
        j += 1;
        oldNo += 1;
        newNo += 1;
        continue;
      }
      if (lcsAt(i + 1, j) >= lcsAt(i, j + 1)) {
        ops.push({ op: "-", text: midA[i] as string, oldNo, newNo });
        i += 1;
        oldNo += 1;
      } else {
        ops.push({ op: "+", text: midB[j] as string, oldNo, newNo });
        j += 1;
        newNo += 1;
      }
    }
  }

  for (let k = a.length - suffix; k < a.length; k++) emitContext(a[k] as string);
  return ops;
}

/** LCS 长度后缀表：table[i*(n+1)+j] = LCS(midA[i..], midB[j..])。 */
function buildLcsTable(a: string[], b: string[]): Uint32Array {
  const m = a.length;
  const n = b.length;
  const width = n + 1;
  const table = new Uint32Array((m + 1) * width);
  for (let i = m - 1; i >= 0; i--) {
    const av = a[i] as string;
    for (let j = n - 1; j >= 0; j--) {
      const diag = table[(i + 1) * width + (j + 1)] ?? 0;
      const down = table[(i + 1) * width + j] ?? 0;
      const right = table[i * width + (j + 1)] ?? 0;
      table[i * width + j] = av === b[j] ? diag + 1 : Math.max(down, right);
    }
  }
  return table;
}

/** 操作序列 → hunk 列表：变更聚簇（簇间上下文空隙 ≤ 2×半径则并簇），两侧各带半径行上下文。 */
function assembleHunks(ops: AnnotatedOp[]): PatchHunk[] {
  const changeIdx: number[] = [];
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op !== undefined && op.op !== " ") changeIdx.push(k);
  }
  if (changeIdx.length === 0) return [];

  const groups: Array<{ start: number; end: number }> = [];
  let group = { start: changeIdx[0] as number, end: changeIdx[0] as number };
  for (let k = 1; k < changeIdx.length; k++) {
    const idx = changeIdx[k] as number;
    if (idx - group.end - 1 <= 2 * CONTEXT_RADIUS) {
      group.end = idx;
    } else {
      groups.push(group);
      group = { start: idx, end: idx };
    }
  }
  groups.push(group);

  const hunks: PatchHunk[] = [];
  for (const g of groups) {
    const emitStart = Math.max(0, g.start - CONTEXT_RADIUS);
    const emitEnd = Math.min(ops.length - 1, g.end + CONTEXT_RADIUS);
    const lines: PatchLine[] = [];
    let oldLines = 0;
    let newLines = 0;
    for (let k = emitStart; k <= emitEnd; k++) {
      const op = ops[k] as AnnotatedOp;
      lines.push({ op: op.op, text: op.text });
      if (op.op !== "+") oldLines += 1;
      if (op.op !== "-") newLines += 1;
    }
    const first = ops[emitStart] as AnnotatedOp;
    hunks.push({
      // 纯插入/纯删除 hunk 采用 git 惯例：空侧坐标 = 插入/删除位次 - 1（可为 0）。
      oldStart: oldLines > 0 ? first.oldNo : first.oldNo - 1,
      oldLines,
      newStart: newLines > 0 ? first.newNo : first.newNo - 1,
      newLines,
      lines,
    });
  }
  return hunks;
}
