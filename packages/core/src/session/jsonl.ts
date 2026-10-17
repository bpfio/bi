/**
 * JSONL 行编解码与容错解析（BI-03 内部模块）。
 *
 * 每个会话文件 `<sessionId>.jsonl` 的物理布局：
 *   第 1 行  {"kind":"meta", ...}   会话元数据（创建后不可变）
 *   第 2+ 行 {"kind":"entry", ...}  会话条目（append-only，永不改写/删除）
 *
 * 崩溃容忍规则（append-only 抗掉电）：
 *   - 一次追加 = 单次 write(整行+`\n`)；掉电可能留下任意前缀。
 *   - 因此【不以换行结尾的末行】一律视为残缺（即使凑巧能 parse，也宁丢勿错）；
 *   - 从第一条无法通过解析/校验的行起，其后所有内容视为残缺区整体丢弃，
 *     cleanLength 即残缺区起始字节偏移（下次追加前物理截断到该位点）。
 *   - 字节偏移一律在 UTF-8 字节空间计算（按 Buffer 切行），避免中文 payload
 *     下用字符数截断导致的位点错位。
 */
import type { JsonValue, SessionEntry, SessionEntryType, SessionMeta } from "./types";
import { isSessionEntryType } from "./types";

/** JSONL 记录格式版本（写入 v 字段，向前兼容预留）。 */
export const JSONL_VERSION = 1 as const;

/** meta 行记录形状。 */
export interface MetaRecord {
  kind: "meta";
  v: number;
  sessionId: string;
  title: string;
  createdAt: number;
  cwd?: string;
  forkedFrom?: string;
}

/** entry 行记录形状。 */
export interface EntryRecord {
  kind: "entry";
  v: number;
  entry: SessionEntry;
}

export type JsonlRecord = MetaRecord | EntryRecord;

/** 序列化 meta 行（不含行尾换行符）。 */
export function formatMetaRecord(meta: SessionMeta): string {
  const record: MetaRecord = { kind: "meta", v: JSONL_VERSION, ...stripUndefined(meta) };
  return JSON.stringify(record);
}

/** 序列化 entry 行（不含行尾换行符）。 */
export function formatEntryRecord(entry: SessionEntry): string {
  const record: EntryRecord = { kind: "entry", v: JSONL_VERSION, entry };
  return JSON.stringify(record);
}

export type ParseResult =
  | {
      ok: true;
      /** 会话元数据（首行）。 */
      meta: SessionMeta;
      /** 干净条目（残缺尾部已丢弃），按物理顺序排列。 */
      entries: SessionEntry[];
      /** 是否存在被丢弃的残缺尾部。 */
      truncated: boolean;
      /** 干净字节边界（残缺区起始偏移；未残缺时等于总字节数）。 */
      cleanLength: number;
    }
  | { ok: false; reason: "empty" | "invalid-meta" };

/**
 * 解析会话文件字节内容（容错：残缺尾部丢弃并报告位点；首行损坏则整体不可用）。
 */
export function parseSessionFileContent(buf: Buffer): ParseResult {
  if (buf.length === 0) return { ok: false, reason: "empty" };

  // meta 行必须以换行结尾（createSession 单次写入整行+`\n`）；
  // 无换行说明 meta 行本身写了一半，会话不可用。
  const firstNl = buf.indexOf(0x0a, 0);
  if (firstNl === -1) return { ok: false, reason: "invalid-meta" };
  let metaLine = buf.subarray(0, firstNl);
  if (metaLine.length > 0 && metaLine[metaLine.length - 1] === 0x0d) {
    metaLine = metaLine.subarray(0, metaLine.length - 1);
  }
  const meta = parseMetaLine(metaLine.toString("utf8"));
  if (!meta) return { ok: false, reason: "invalid-meta" };

  const entries: SessionEntry[] = [];
  let pos = firstNl + 1;

  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos); // '\n'
    const hasNewline = nl !== -1;
    const end = hasNewline ? nl : buf.length;
    let line = buf.subarray(pos, end);
    // 容忍 \r\n（本模块只写 \n，仅为兼容手工编辑的文件）。
    if (line.length > 0 && line[line.length - 1] === 0x0d) {
      line = line.subarray(0, line.length - 1);
    }
    const entry = parseEntryLine(line.toString("utf8"));
    if (entry === null || !hasNewline) {
      // 首个坏行（或没有换行结尾的末行）即残缺区起点，其后全部丢弃。
      return {
        ok: true,
        meta,
        entries,
        truncated: true,
        cleanLength: pos,
      };
    }
    entries.push(entry);
    pos = hasNewline ? nl + 1 : buf.length;
  }

  return { ok: true, meta, entries, truncated: false, cleanLength: buf.length };
}

function parseMetaLine(text: string): SessionMeta | null {
  const rec = safeParse(text);
  if (!rec || rec.kind !== "meta") return null;
  const { sessionId, title, createdAt } = rec;
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  if (typeof title !== "string") return null;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  const meta: SessionMeta = { sessionId, title, createdAt };
  if (typeof rec.cwd === "string") meta.cwd = rec.cwd;
  if (typeof rec.forkedFrom === "string") meta.forkedFrom = rec.forkedFrom;
  return meta;
}

function parseEntryLine(text: string): SessionEntry | null {
  const rec = safeParse(text);
  if (!rec || rec.kind !== "entry") return null;
  const e = rec.entry;
  if (!isPlainObject(e)) return null;
  const { id, parentId, type, payload, createdAt, seq } = e;
  if (typeof id !== "string" || id.length === 0) return null;
  if (!(parentId === null || (typeof parentId === "string" && parentId.length > 0))) return null;
  if (!isSessionEntryType(type)) return null;
  if (!("payload" in e)) return null;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) return null;
  const entry: SessionEntry = {
    id,
    parentId,
    type: type as SessionEntryType,
    payload: payload as JsonValue,
    createdAt,
    seq,
  };
  if (typeof e.toolCallId === "string") entry.toolCallId = e.toolCallId;
  if (typeof e.toolName === "string") entry.toolName = e.toolName;
  return entry;
}

function safeParse(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 去掉值为 undefined 的键，保证 JSON.stringify 输出稳定（不产生 "key":undefined）。 */
function stripUndefined(meta: SessionMeta): SessionMeta {
  const out: SessionMeta = {
    sessionId: meta.sessionId,
    title: meta.title,
    createdAt: meta.createdAt,
  };
  if (meta.cwd !== undefined) out.cwd = meta.cwd;
  if (meta.forkedFrom !== undefined) out.forkedFrom = meta.forkedFrom;
  return out;
}
