/**
 * BI-20.4 —— 会话全拓扑脱敏导出导入与匿名调试归档器（transfer）。
 *
 * OpenCode transfer 轮子的合约级重实现（零依赖、strict）。
 *
 * ── 脱敏清单（脱敏的是内容，不是结构）────────────────────────────
 * 脱敏项：
 *   1. 真实绝对路径（workspaceRoot / homeDir 之下的路径 token）
 *      → `[redacted:path:pN]`；同一路径 → 同一占位（pN 稳定，利于调试对照）；
 *      文件名（含扩展名）保留：文件形路径输出 `[redacted:path:pN:app.py]`，
 *      目录语义全部脱敏（仅保留扩展名语义，见 pathPlaceholder）。
 *   2. 敏感代码 patch：`patch` / `diff` 键下（或以 `diff --git ` 开头）的
 *      文本按 unified-diff 逐行脱敏，代码行 → `+/-/空格 [redacted:patch:cN]`；
 *      `@@` hunk 头、`diff --git` / `index` / `---` / `+++` 文件头保留，
 *      其中的绝对路径仍走路径脱敏（hunk 计数驱动正文判定，避免 `--- x`
 *      形态的被删行被误当文件头）。
 *   3. 提示词文本：user 条目 payload 顶层字符串与任意层级 `text` 字段
 *      → `[redacted:prompt:tN]`；同一文本 → 同一占位。
 * 保留项（逐字段原样）：
 *   - Token 消耗底账：payload 中 usage/tokens 等数值字段不动（脱敏只改字符串）；
 *   - 时间戳与序号：createdAt / seq 原样保留；
 *   - DAG 结构：id / parentId 原样保留（归档内不换 id，树拓扑可完整复原）；
 *   - 工具调用骨架：type / toolName / toolCallId 原样保留；tool_call 参数的
 *     对象形状（键结构、数值/布尔标量）原样保留，仅字符串内绝对路径被占位替换。
 * ── 导入重建语义 ────────────────────────────────────────────────
 * importSanitized 以「重放 append」逆向重建：旧 id → 新 id（manager 分配
 * UUIDv7）按归档顺序拓扑映射，parentId 同步换算；树形状、类型序列、计数、
 * payload 内容（已脱敏）与归档完全一致；时间戳底账保留在归档 JSON 内，
 * 重建会话的物理时间戳为导入时刻（结构等价副本，见 structuralFingerprint）。
 *
 * CLI 处理器见 cli/commands/transfer.ts（本模块只提供库面）。
 */
import { homedir } from "node:os";
import {
  SessionFileCorruptError,
  SessionNotFoundError,
  type SessionManager,
} from "./manager";
import type { JsonValue, LoadedSession, SessionEntry, SessionEntryType } from "./types";
import { isSessionEntryType } from "./types";

// ── 错误与结果类型 ──────────────────────────────────────────────

export type TransferErrorCode =
  | "usage"
  | "session-missing"
  | "session-corrupt"
  | "invalid-archive"
  | "session-exists"
  | "file-missing"
  | "io-error";

export class TransferError extends Error {
  constructor(
    readonly code: TransferErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TransferError";
  }
}

/** 脱敏后的条目：形状与 SessionEntry 一致，payload 内容已被脱敏。 */
export type SanitizedEntry = SessionEntry;

export interface SanitizedArchiveMeta {
  sessionId: string;
  title: string;
  createdAt: number;
  /** 脱敏后的 cwd（占位符）。 */
  cwd?: string;
  forkedFrom?: string;
  /** 归档生成时间（unix 毫秒）。 */
  exportedAt: number;
  version: 1;
  counts: { entries: number; byType: Record<string, number> };
  /** 结构指纹（树形状 + 类型序列 + 工具名骨架），用于往返一致性断言。 */
  fingerprint: string;
}

export interface SanitizedArchive {
  meta: SanitizedArchiveMeta;
  entries: SanitizedEntry[];
}

export interface SanitizeOptions {
  /** 工作区根目录：其下的绝对路径一律脱敏；缺省不启用 workspace 匹配。 */
  workspaceRoot?: string;
  /** home 目录：其下的绝对路径一律脱敏；缺省取 os.homedir()，传 "" 关闭。 */
  homeDir?: string;
}

export interface ExportSanitizeOptions extends SanitizeOptions {
  /** 归档时间源（测试注入）；默认 Date.now。 */
  now?: () => number;
}

export interface ImportResult {
  /** 重建的会话 id（与归档 meta.sessionId 一致）。 */
  sessionId: string;
  /** 重建后的条目（新 id / 新时间戳，结构指纹与归档一致）。 */
  entries: SessionEntry[];
}

// ── 脱敏器 ──────────────────────────────────────────────────────

/** 占位符格式（与合约一致）。 */
const PATH_TAG = "redacted:path";
const PATCH_TAG = "redacted:patch";
const PROMPT_TAG = "redacted:prompt";

interface RedactorState {
  /** 参与匹配的根目录（去空、去重、按长度降序，长度 >= 2）。 */
  roots: string[];
  pathIds: Map<string, number>;
  promptIds: Map<string, number>;
  patchIds: Map<string, number>;
}

/** 路径 token 的终止字符（token 消费在这些字符处停止）。 */
const TOKEN_TERMINATOR = /[\s"'`()[\]{}<>,;:|*?\\]/;
/** 判定「前一字符属于更长 token」的路径字符（防止 /home/u 误吞 /home/user）。 */
const PATH_CONTINUATION = /[A-Za-z0-9_.\-/~]/;
/** 尾部需要剥离的句读标点（避免把句子结尾的句点吃进文件名）。 */
const TRAILING_PUNCT = /[.,;!?]+$/;

function createRedactorState(opts: SanitizeOptions): RedactorState {
  const home = opts.homeDir !== undefined ? opts.homeDir : homedir();
  const roots = [opts.workspaceRoot, home]
    .filter((r): r is string => typeof r === "string" && r.length >= 2)
    .map((r) => (r.length > 1 ? r.replace(/\/+$/, "") : r))
    .filter((r, i, all) => all.indexOf(r) === i)
    .sort((a, b) => b.length - a.length);
  return { roots, pathIds: new Map(), promptIds: new Map(), patchIds: new Map() };
}

function nextId(map: Map<string, number>, key: string): number {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const id = map.size + 1;
  map.set(key, id);
  return id;
}

/**
 * 把文本中所有落在根目录之下的绝对路径 token 替换为占位符。
 * 文件形路径（末段含点）保留文件名：`[redacted:path:pN:app.py]`。
 */
function pathRedact(text: string, state: RedactorState): string {
  if (state.roots.length === 0) return text;
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    let root: string | undefined;
    for (const candidate of state.roots) {
      if (text.startsWith(candidate, i)) {
        root = candidate;
        break;
      }
    }
    if (root === undefined) {
      out += text.charAt(i);
      i += 1;
      continue;
    }
    // 边界：前一字符仍是路径的一部分 → 该命中只是更长 token 的中段。
    const prev = i > 0 ? text.charAt(i - 1) : "";
    if (i > 0 && PATH_CONTINUATION.test(prev)) {
      out += text.charAt(i);
      i += 1;
      continue;
    }
    const afterRoot = i + root.length;
    const nextCh = text.charAt(afterRoot);
    if (nextCh !== "" && nextCh !== "/" && !TOKEN_TERMINATOR.test(nextCh)) {
      // root 后紧跟路径延续字符（如 /home/u vs /home/user）：非根内路径，跳过。
      out += text.charAt(i);
      i += 1;
      continue;
    }
    if (nextCh !== "/") {
      // 根目录本身作为完整 token（后随终止符或文本结尾）。
      out += pathPlaceholder(root, state);
      i = afterRoot;
      continue;
    }
    let j = afterRoot;
    while (j < n && !TOKEN_TERMINATOR.test(text.charAt(j))) j += 1;
    const token = text.slice(i, j).replace(TRAILING_PUNCT, "");
    if (token.length === 0) {
      out += text.charAt(i);
      i += 1;
      continue;
    }
    out += pathPlaceholder(token, state);
    i += token.length;
  }
  return out;
}

function pathPlaceholder(token: string, state: RedactorState): string {
  const id = nextId(state.pathIds, token);
  const lastSlash = token.lastIndexOf("/");
  const base = lastSlash >= 0 ? token.slice(lastSlash + 1) : token;
  const basePart = base.includes(".") ? `:${base}` : "";
  return `[${PATH_TAG}:p${id}${basePart}]`;
}

function promptPlaceholder(text: string, state: RedactorState): string {
  return `[${PROMPT_TAG}:t${nextId(state.promptIds, text)}]`;
}

/** patch 占位：同一行内容 → 同一 id（内容映射稳定）。 */
function patchPlaceholder(lineBody: string, state: RedactorState): string {
  return `[${PATCH_TAG}:c${nextId(state.patchIds, lineBody)}]`;
}

/** 解析 `@@ -a[,b] +c[,d] @@` 的 hunk 行数（b/d 缺省 1）。 */
function parseHunkCounts(line: string): { oldCount: number; newCount: number } {
  const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (m === null) return { oldCount: 0, newCount: 0 };
  const oldCount = m[1] !== undefined ? Number.parseInt(m[1], 10) : 1;
  const newCount = m[2] !== undefined ? Number.parseInt(m[2], 10) : 1;
  return {
    oldCount: Number.isFinite(oldCount) ? oldCount : 0,
    newCount: Number.isFinite(newCount) ? newCount : 0,
  };
}

const HUNK_LINE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

/**
 * unified-diff 逐行脱敏：hunk 计数驱动的正文判定（计数字段按 +/-/上下文
 * 消耗），正文代码行 → `<sign>[redacted:patch:cN]`；文件头/hunk 头保留并
 * 对其中的绝对路径做路径脱敏；无法解析的杂行保守走路径脱敏。
 */
function patchRedact(text: string, state: RedactorState): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inHunk = false;
  let oldCount = 0;
  let newCount = 0;
  for (const line of lines) {
    if (inHunk && (oldCount > 0 || newCount > 0)) {
      const sign = line.charAt(0);
      const body = line.slice(1);
      if (sign === "+") {
        newCount = Math.max(0, newCount - 1);
        out.push(body.length === 0 ? line : `+${patchPlaceholder(body, state)}`);
        continue;
      }
      if (sign === "-") {
        oldCount = Math.max(0, oldCount - 1);
        out.push(body.length === 0 ? line : `-${patchPlaceholder(body, state)}`);
        continue;
      }
      if (sign === " ") {
        oldCount = Math.max(0, oldCount - 1);
        newCount = Math.max(0, newCount - 1);
        out.push(body.length === 0 ? line : ` ${patchPlaceholder(body, state)}`);
        continue;
      }
      if (sign === "\\" || line.length === 0) {
        out.push(line); // "\ No newline at end of file" / 空行
        continue;
      }
      out.push(patchPlaceholder(line, state)); // hunk 内异常行：保守脱敏
      continue;
    }
    if (inHunk) inHunk = false; // 计数耗尽，回到文件头状态

    if (HUNK_LINE.test(line)) {
      inHunk = true;
      const counts = parseHunkCounts(line);
      oldCount = counts.oldCount;
      newCount = counts.newCount;
      out.push(line);
      continue;
    }
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("\\") ||
      line.length === 0
    ) {
      out.push(pathRedact(line, state));
      continue;
    }
    const sign = line.charAt(0);
    if (sign === "+" || sign === "-" || sign === " ") {
      const body = line.slice(1);
      out.push(body.length === 0 ? line : `${sign}${patchPlaceholder(body, state)}`);
      continue;
    }
    out.push(pathRedact(line, state)); // 非 diff 结构的杂行：仅路径脱敏
  }
  return out.join("\n");
}

function isPatchKey(key: string | null): boolean {
  return key === "patch" || key === "diff";
}

/**
 * payload 递归脱敏：
 *   - patch 键子树 / `diff --git` 开头字符串 → patchRedact；
 *   - user 条目（isPrompt）的顶层字符串与 `text` 字段 → promptPlaceholder；
 *   - 其余字符串 → pathRedact；非字符串值原样保留（底账/形状不丢）。
 */
function walkPayload(
  value: unknown,
  state: RedactorState,
  key: string | null,
  isPrompt: boolean,
  inPatch: boolean,
): JsonValue {
  if (typeof value === "string") {
    if (value.length === 0) return value;
    if (inPatch || isPatchKey(key) || value.startsWith("diff --git ")) {
      return patchRedact(value, state);
    }
    if (isPrompt && (key === null || key === "text")) {
      return promptPlaceholder(value, state);
    }
    return pathRedact(value, state);
  }
  if (Array.isArray(value)) {
    const childInPatch = inPatch || isPatchKey(key);
    return value.map((item) => walkPayload(item, state, key, isPrompt, childInPatch));
  }
  if (isPlainObject(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = walkPayload(v, state, k, isPrompt, inPatch);
    }
    return out;
  }
  if (value === undefined) return null; // JSON 安全兜底
  return value as JsonValue; // number / boolean / null
}

/** 单条条目脱敏；形状非法（缺 id/类型非法等）返回 null（调用方丢弃）。 */
function sanitizeEntry(raw: unknown, state: RedactorState): SanitizedEntry | null {
  if (!isPlainObject(raw)) return null;
  const { id, parentId, type, createdAt, seq } = raw;
  if (typeof id !== "string" || id.length === 0) return null;
  if (!(parentId === null || (typeof parentId === "string" && parentId.length > 0))) return null;
  if (!isSessionEntryType(type)) return null;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) return null;
  if (!("payload" in raw)) return null;
  const isPrompt = type === "user";
  const entry: SanitizedEntry = {
    id,
    parentId,
    type,
    payload: walkPayload(raw.payload, state, null, isPrompt, false),
    createdAt,
    seq,
  };
  if (typeof raw.toolCallId === "string") entry.toolCallId = raw.toolCallId;
  if (typeof raw.toolName === "string") entry.toolName = raw.toolName;
  return entry;
}

// ── 公开库面 ────────────────────────────────────────────────────

/**
 * 脱敏管线：逐条脱敏，形状非法的条目直接丢弃（容错，绝不抛异常）。
 * id/parentId/type/createdAt/seq/toolCallId/toolName 原样保留（结构不脱敏）。
 */
export function sanitizeMessages(
  entries: readonly unknown[],
  opts: SanitizeOptions = {},
): SanitizedEntry[] {
  const state = createRedactorState(opts);
  const out: SanitizedEntry[] = [];
  for (const raw of entries) {
    const entry = sanitizeEntry(raw, state);
    if (entry !== null) out.push(entry);
  }
  return out;
}

/**
 * 结构指纹：树形状（父节点槽位）+ 类型序列 + 工具名骨架 + 计数。
 * 与具体 id 无关（父节点以「在数组中的槽位」表达），往返前后可比较。
 * parentIndex：根（parentId=null）为 -1；父节点缺失为 -2。
 */
export function structuralFingerprint(
  entries: readonly {
    id: string;
    parentId: string | null;
    type: string;
    toolName?: string;
  }[],
): string {
  const slotOfId = new Map<string, number>();
  entries.forEach((entry, index) => {
    if (!slotOfId.has(entry.id)) slotOfId.set(entry.id, index);
  });
  const shape = entries.map((entry) => {
    let parentIndex: number;
    if (entry.parentId === null) {
      parentIndex = -1;
    } else {
      const slot = slotOfId.get(entry.parentId);
      parentIndex = slot === undefined ? -2 : slot;
    }
    return [entry.type, entry.toolName ?? null, parentIndex];
  });
  return JSON.stringify(shape);
}

/**
 * 导出脱敏归档：经 SessionManager 加载（含残缺行容忍）→ 逐条 sanitize
 * → { meta(cwd=占位、含计数与结构指纹), entries }。
 * workspaceRoot 取会话 meta.cwd；homeDir 缺省 os.homedir()（可注入/关闭）。
 */
export async function exportSanitized(
  manager: SessionManager,
  sessionId: string,
  opts: ExportSanitizeOptions = {},
): Promise<SanitizedArchive> {
  let loaded: LoadedSession;
  try {
    loaded = await manager.loadSession(sessionId);
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      throw new TransferError("session-missing", `会话不存在: ${sessionId}`);
    }
    if (error instanceof SessionFileCorruptError) {
      throw new TransferError("session-corrupt", errorMessage(error));
    }
    throw error;
  }
  const now = opts.now ?? Date.now;
  const meta = loaded.meta;
  const cwd = typeof meta.cwd === "string" && meta.cwd.length > 0 ? meta.cwd : undefined;

  const state = createRedactorState({ ...opts, workspaceRoot: cwd });
  // meta 字段先于条目脱敏：cwd 占位稳定为 p1（归档首行语义）。
  const sanitizedTitle = pathRedact(meta.title, state);
  const sanitizedCwd = cwd !== undefined ? pathRedact(cwd, state) : undefined;

  const entries: SanitizedEntry[] = [];
  for (const raw of loaded.entries) {
    const entry = sanitizeEntry(raw, state);
    if (entry !== null) entries.push(entry);
  }

  const byType: Record<string, number> = {};
  for (const entry of entries) {
    byType[entry.type] = (byType[entry.type] ?? 0) + 1;
  }

  const archiveMeta: SanitizedArchiveMeta = {
    sessionId: meta.sessionId,
    title: sanitizedTitle,
    createdAt: meta.createdAt,
    exportedAt: now(),
    version: 1,
    counts: { entries: entries.length, byType },
    fingerprint: structuralFingerprint(entries),
  };
  if (sanitizedCwd !== undefined) archiveMeta.cwd = sanitizedCwd;
  if (meta.forkedFrom !== undefined) archiveMeta.forkedFrom = meta.forkedFrom;

  return { meta: archiveMeta, entries };
}

// 会话 id 白名单（与 manager.ts 的私有正则保持一致；模块私有无法 import）。
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface RawArchiveEntry {
  id: string;
  parentId: string | null;
  type: SessionEntryType;
  payload: JsonValue;
  toolCallId?: string;
  toolName?: string;
}

/**
 * 归档校验：结构、类型白名单、payload 存在性、id 唯一、拓扑序
 * （首条 parentId 必须为 null，其后每条 parent 必须先于自身出现）。
 */
function validateArchive(archive: unknown): {
  sessionId: string;
  title: string;
  cwd?: string;
  entries: RawArchiveEntry[];
} {
  if (!isPlainObject(archive)) {
    throw new TransferError("invalid-archive", "归档必须是 JSON 对象");
  }
  const rawMeta = archive["meta"];
  if (!isPlainObject(rawMeta)) {
    throw new TransferError("invalid-archive", "归档缺少 meta 对象");
  }
  const sessionId = rawMeta["sessionId"];
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new TransferError(
      "invalid-archive",
      `归档 meta.sessionId 非法（只允许 [A-Za-z0-9._-]，且不以符号开头）: ${String(sessionId)}`,
    );
  }
  const title = typeof rawMeta["title"] === "string" ? rawMeta["title"] : "未命名会话";
  const cwd = typeof rawMeta["cwd"] === "string" ? rawMeta["cwd"] : undefined;

  const rawEntries = archive["entries"];
  if (!Array.isArray(rawEntries)) {
    throw new TransferError("invalid-archive", "归档 entries 必须是数组");
  }

  const seen = new Set<string>();
  const entries: RawArchiveEntry[] = rawEntries.map((raw, index) => {
    const where = `第 ${index} 条条目`;
    if (!isPlainObject(raw)) {
      throw new TransferError("invalid-archive", `${where} 不是对象`);
    }
    const id = raw["id"];
    if (typeof id !== "string" || id.length === 0) {
      throw new TransferError("invalid-archive", `${where} 缺少非空 id`);
    }
    if (seen.has(id)) {
      throw new TransferError("invalid-archive", `${where} id 重复: ${id}`);
    }
    const parentId = raw["parentId"];
    if (index === 0) {
      if (parentId !== null) {
        throw new TransferError("invalid-archive", `${where} 是首条目，parentId 必须为 null`);
      }
    } else {
      if (typeof parentId !== "string" || parentId.length === 0) {
        throw new TransferError("invalid-archive", `${where} parentId 非法: ${String(parentId)}`);
      }
      if (!seen.has(parentId)) {
        throw new TransferError(
          "invalid-archive",
          `${where} 的父节点 ${parentId} 未在更早位置出现（非拓扑序）`,
        );
      }
    }
    const type = raw["type"];
    if (!isSessionEntryType(type)) {
      throw new TransferError("invalid-archive", `${where} 类型非法: ${String(type)}`);
    }
    if (!("payload" in raw) || raw["payload"] === undefined) {
      throw new TransferError("invalid-archive", `${where} 缺少 payload`);
    }
    seen.add(id);
    const entry: RawArchiveEntry = {
      id,
      parentId: parentId as string | null,
      type,
      payload: raw["payload"] as JsonValue,
    };
    if (typeof raw["toolCallId"] === "string") entry.toolCallId = raw["toolCallId"];
    if (typeof raw["toolName"] === "string") entry.toolName = raw["toolName"];
    return entry;
  });

  return { sessionId, title, cwd, entries };
}

/**
 * 导入重建：校验归档 → createSession（保留 sessionId/title/cwd）→
 * 按归档顺序重放 append（旧 id → 新 id 拓扑映射，parentId 同步换算）。
 * 树形状/类型序列/计数/payload 与归档一致（structuralFingerprint 可断言）；
 * 归档内原始 id/时间戳底账不受影响。目标 sessionId 已存在 → session-exists。
 */
export async function importSanitized(
  archive: unknown,
  manager: SessionManager,
): Promise<ImportResult> {
  const validated = validateArchive(archive);
  const existing = await manager.getSessionMeta(validated.sessionId);
  if (existing !== undefined) {
    throw new TransferError("session-exists", `目标会话已存在: ${validated.sessionId}`);
  }
  await manager.createSession({
    sessionId: validated.sessionId,
    title: validated.title,
    ...(validated.cwd !== undefined ? { cwd: validated.cwd } : {}),
  });

  const oldToNew = new Map<string, string>();
  const imported: SessionEntry[] = [];
  for (const entry of validated.entries) {
    let parentId: string | null = null;
    if (entry.parentId !== null) {
      const mapped = oldToNew.get(entry.parentId);
      if (mapped === undefined) {
        // 校验已保证拓扑序，此处为防御性兜底。
        throw new TransferError("invalid-archive", `父节点映射缺失: ${entry.parentId}`);
      }
      parentId = mapped;
    }
    const created = await manager.append(validated.sessionId, parentId, {
      type: entry.type,
      payload: entry.payload,
      ...(entry.toolCallId !== undefined ? { toolCallId: entry.toolCallId } : {}),
      ...(entry.toolName !== undefined ? { toolName: entry.toolName } : {}),
    });
    oldToNew.set(entry.id, created.id);
    imported.push(created);
  }
  return { sessionId: validated.sessionId, entries: imported };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
