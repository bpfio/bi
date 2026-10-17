/**
 * 会话索引抽象（BI-03）：`SessionIndex` 接口 + 双引擎实现。
 *
 *   - `SqliteIndexEngine`：bun:sqlite 内建驱动，`PRAGMA journal_mode=WAL`，
 *     表结构 sessions + entries，毫秒级历史列表；
 *   - `MemoryIndexEngine`：纯 TS 内存实现，Bun Compile 零 C 依赖兜底。
 *
 * 两引擎经同一操作序列等价性测试保证可互换（见 index.test.ts）。
 * 边界声明：kimi MiniDB 完整 LSM-Tree 移植为后续增量（锚点已备案），
 * 本卡以 Memory + SQLite 双引擎交付。
 *
 * 接口全同步：bun:sqlite 本身为同步 API；rebuild 走 node:fs 同步读，
 * 属一次性批量操作，阻塞可接受。
 */
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseSessionFileContent } from "./jsonl";
import type { JsonValue, SessionEntry, SessionMeta } from "./types";
import { isSessionEntryType } from "./types";

export interface SessionIndex {
  /** upsert 会话元数据（幂等，按 sessionId 覆盖）。 */
  upsert(meta: SessionMeta): void;
  /** 增量 upsert 单条条目（幂等，按 (sessionId, entry.id) 覆盖）。 */
  upsertEntry(sessionId: string, entry: SessionEntry): void;
  /** 全部会话元数据（createdAt 降序，最新在前；次序键 sessionId 保证确定性）。 */
  list(): SessionMeta[];
  /** 单会话元数据；不存在返回 undefined。 */
  getSession(sessionId: string): SessionMeta | undefined;
  /** 单会话条目（seq 升序）；会话不存在返回 []。 */
  getBySession(sessionId: string): SessionEntry[];
  /** 从 JSONL 会话目录（`<rootDir>/*.jsonl`）全量重建索引：先清空再落库，返回重建的会话数。 */
  rebuild(rootDir: string): number;
  /** 释放底层资源（内存引擎为空操作）。 */
  close(): void;
}

/** 双引擎共享的 JSONL 目录摄取逻辑。 */
interface IndexSink {
  upsert(meta: SessionMeta): void;
  upsertEntry(sessionId: string, entry: SessionEntry): void;
  clear(): void;
}

function ingestFromJsonlDir(rootDir: string, sink: IndexSink): number {
  let names: string[];
  try {
    names = readdirSync(rootDir);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return 0;
    throw error;
  }
  names.sort(); // 固定顺序，保证两引擎摄取序列一致
  let count = 0;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const parsed = parseSessionFileContent(readFileSync(join(rootDir, name)));
    if (!parsed.ok) continue; // 损坏文件跳过
    sink.upsert(parsed.meta);
    for (const entry of parsed.entries) {
      sink.upsertEntry(parsed.meta.sessionId, entry);
    }
    count += 1;
  }
  return count;
}

/* -------------------------------------------------------------------------- */
/*                             MemoryIndexEngine                              */
/* -------------------------------------------------------------------------- */

/** 纯 TS 内存实现：Bun Compile 零 C 依赖兜底。 */
export class MemoryIndexEngine implements SessionIndex {
  readonly #sessions = new Map<string, SessionMeta>();
  /** sessionId -> (entryId -> entry) */
  readonly #entries = new Map<string, Map<string, SessionEntry>>();

  upsert(meta: SessionMeta): void {
    this.#sessions.set(meta.sessionId, { ...meta });
  }

  upsertEntry(sessionId: string, entry: SessionEntry): void {
    let bucket = this.#entries.get(sessionId);
    if (bucket === undefined) {
      bucket = new Map<string, SessionEntry>();
      this.#entries.set(sessionId, bucket);
    }
    bucket.set(entry.id, { ...entry });
  }

  list(): SessionMeta[] {
    return [...this.#sessions.values()].sort(compareMetaDesc).map((meta) => ({ ...meta }));
  }

  getSession(sessionId: string): SessionMeta | undefined {
    const meta = this.#sessions.get(sessionId);
    return meta === undefined ? undefined : { ...meta };
  }

  getBySession(sessionId: string): SessionEntry[] {
    const bucket = this.#entries.get(sessionId);
    if (bucket === undefined) return [];
    return [...bucket.values()].sort(compareEntriesAsc).map((entry) => ({ ...entry }));
  }

  /** 清空索引（rebuild 的前置步骤，也可独立用于测试）。 */
  clear(): void {
    this.#sessions.clear();
    this.#entries.clear();
  }

  rebuild(rootDir: string): number {
    this.clear();
    return ingestFromJsonlDir(rootDir, this);
  }

  close(): void {
    // 内存引擎无外部资源。
  }
}

/* -------------------------------------------------------------------------- */
/*                             SqliteIndexEngine                              */
/* -------------------------------------------------------------------------- */

interface SessionRow {
  session_id: string;
  title: string;
  created_at: number;
  cwd: string | null;
  forked_from: string | null;
}

interface EntryRow {
  id: string;
  parent_id: string | null;
  type: string;
  payload: string;
  created_at: number;
  seq: number;
  tool_call_id: string | null;
  tool_name: string | null;
}

/** bun:sqlite 内建引擎（WAL 模式）。path 默认 ":memory:"，生产传入文件路径。 */
export class SqliteIndexEngine implements SessionIndex {
  readonly #db: Database;

  constructor(path: string = ":memory:") {
    this.#db = new Database(path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id  TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        cwd         TEXT,
        forked_from TEXT
      );
      CREATE TABLE IF NOT EXISTS entries (
        session_id   TEXT NOT NULL,
        id           TEXT NOT NULL,
        parent_id    TEXT,
        type         TEXT NOT NULL,
        payload      TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        seq          INTEGER NOT NULL,
        tool_call_id TEXT,
        tool_name    TEXT,
        PRIMARY KEY (session_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_entries_session_seq ON entries (session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions (created_at DESC, session_id DESC);
    `);
  }

  /** 当前 journal_mode（自检/测试用，验证 WAL 生效）。 */
  get journalMode(): string {
    const row = this.#db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    return row.journal_mode;
  }

  upsert(meta: SessionMeta): void {
    this.#db.query(
      `INSERT INTO sessions (session_id, title, created_at, cwd, forked_from)
       VALUES ($sessionId, $title, $createdAt, $cwd, $forkedFrom)
       ON CONFLICT(session_id) DO UPDATE SET
         title       = excluded.title,
         created_at  = excluded.created_at,
         cwd         = excluded.cwd,
         forked_from = excluded.forked_from`,
    ).run({
      $sessionId: meta.sessionId,
      $title: meta.title,
      $createdAt: meta.createdAt,
      $cwd: meta.cwd ?? null,
      $forkedFrom: meta.forkedFrom ?? null,
    });
  }

  upsertEntry(sessionId: string, entry: SessionEntry): void {
    this.#db.query(
      `INSERT INTO entries (session_id, id, parent_id, type, payload, created_at, seq, tool_call_id, tool_name)
       VALUES ($sessionId, $id, $parentId, $type, $payload, $createdAt, $seq, $toolCallId, $toolName)
       ON CONFLICT(session_id, id) DO UPDATE SET
         parent_id    = excluded.parent_id,
         type         = excluded.type,
         payload      = excluded.payload,
         created_at   = excluded.created_at,
         seq          = excluded.seq,
         tool_call_id = excluded.tool_call_id,
         tool_name    = excluded.tool_name`,
    ).run({
      $sessionId: sessionId,
      $id: entry.id,
      $parentId: entry.parentId ?? null,
      $type: entry.type,
      $payload: JSON.stringify(entry.payload),
      $createdAt: entry.createdAt,
      $seq: entry.seq,
      $toolCallId: entry.toolCallId ?? null,
      $toolName: entry.toolName ?? null,
    });
  }

  list(): SessionMeta[] {
    const rows = this.#db.query(
      "SELECT session_id, title, created_at, cwd, forked_from FROM sessions",
    ).all() as SessionRow[];
    return rows
      .map(rowToMeta)
      .sort(compareMetaDesc);
  }

  getSession(sessionId: string): SessionMeta | undefined {
    const row = this.#db.query(
      "SELECT session_id, title, created_at, cwd, forked_from FROM sessions WHERE session_id = ?",
    ).get(sessionId) as SessionRow | undefined | null;
    return row ? rowToMeta(row) : undefined;
  }

  getBySession(sessionId: string): SessionEntry[] {
    const rows = this.#db.query(
      `SELECT id, parent_id, type, payload, created_at, seq, tool_call_id, tool_name
       FROM entries WHERE session_id = ? ORDER BY seq ASC, id ASC`,
    ).all(sessionId) as EntryRow[];
    return rows.map(rowToEntry);
  }

  rebuild(rootDir: string): number {
    const ingest = this.#db.transaction((dir: string): number => {
      this.clear();
      return ingestFromJsonlDir(dir, this);
    });
    return ingest(rootDir);
  }

  /** 清空索引（rebuild 的前置步骤；事务内调用以保原子性）。 */
  clear(): void {
    this.#db.exec("DELETE FROM sessions");
    this.#db.exec("DELETE FROM entries");
  }

  close(): void {
    this.#db.close();
  }
}

/* -------------------------------------------------------------------------- */
/*                                  共享工具                                   */
/* -------------------------------------------------------------------------- */

function rowToMeta(row: SessionRow): SessionMeta {
  const meta: SessionMeta = {
    sessionId: row.session_id,
    title: row.title,
    createdAt: row.created_at,
  };
  if (row.cwd !== null) meta.cwd = row.cwd;
  if (row.forked_from !== null) meta.forkedFrom = row.forked_from;
  return meta;
}

function rowToEntry(row: EntryRow): SessionEntry {
  if (!isSessionEntryType(row.type)) {
    throw new Error(`索引中发现非法条目类型: ${JSON.stringify(row.type)}`);
  }
  const entry: SessionEntry = {
    id: row.id,
    parentId: row.parent_id,
    type: row.type,
    payload: JSON.parse(row.payload) as JsonValue,
    createdAt: row.created_at,
    seq: row.seq,
  };
  if (row.tool_call_id !== null) entry.toolCallId = row.tool_call_id;
  if (row.tool_name !== null) entry.toolName = row.tool_name;
  return entry;
}

/** 元数据排序：createdAt 降序（最新在前），sessionId 降序破平局。 */
function compareMetaDesc(a: SessionMeta, b: SessionMeta): number {
  return b.createdAt - a.createdAt || (a.sessionId > b.sessionId ? -1 : 1);
}

/** 条目排序：seq 升序，entry id 升序破平局。 */
function compareEntriesAsc(a: SessionEntry, b: SessionEntry): number {
  return a.seq - b.seq || (a.id > b.id ? 1 : -1);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code
  );
}
