/**
 * 会话语料 SQLite 库（BI-03.7）：`SqliteCorpus`。
 *
 * 存储：bun:sqlite（零外部依赖），WAL 模式；entries 表
 * (id 自增主键, session_id, type, tool, text, ts)——ts 为 ISO 8601 字符串
 * （由 SessionEntry.createdAt 毫秒折算），供 after: 谓词比较。
 *
 * ingest：流式读会话 JSONL（chunk 切行，跨块行正确拼接），逐行解析
 * （meta 行取 session_id，entry 行投影入库；残缺行跳过不拖垮——与会话引擎
 * 容错语义一致），批量事务插入 + 进度回调。
 *
 * search：keyset 分页（WHERE id > cursor ORDER BY id），谓词在 JS 侧求值
 * （FilterPredicate 为函数，无法下推 SQL）；内部分批扫描直到集满 pageSize
 * 或扫尽，nextCursor = 本页最后扫描到的原始行 id——无重无漏的关键。
 */
import { createReadStream } from "node:fs";
import { Database } from "bun:sqlite";
import type { Statement } from "bun:sqlite";
import type { FilterPredicate } from "./filter-compiler";
import type { JsonValue } from "../types";

export interface CorpusEntry {
  id: number;
  sessionId: string;
  type: string;
  tool: string | null;
  text: string;
  ts: string;
}

export interface SearchOpts {
  /** keyset 游标：上一页返回的 nextCursor（本页只含 id > cursor 的行）。 */
  cursor?: number;
  /** 页大小（1..1000，缺省 50）。 */
  pageSize?: number;
}

export interface SearchResult {
  items: CorpusEntry[];
  /** null = 已扫尽；否则传回 search 即取下一页。 */
  nextCursor: number | null;
}

export interface IngestProgress {
  /** 已读取的物理行数。 */
  lines: number;
  /** 已插入的条目数。 */
  inserted: number;
}

export interface IngestResult {
  lines: number;
  inserted: number;
}

export interface SqliteCorpusOptions {
  /** SQLite 数据库文件路径（目录须已存在；文件不存在自动创建）。 */
  dbPath: string;
}

interface RawRow {
  id: number;
  session_id: string;
  type: string;
  tool: string | null;
  text: string;
  ts: string;
}

type RowTuple = [string, string, string | null, string, string];

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 1000;
const SCAN_BATCH = 200;
const DEFAULT_BATCH_SIZE = 500;

/** 从 payload 提取可检索文本：优先常见文本键，其余 JSON 串化。 */
function extractText(payload: JsonValue): string {
  if (typeof payload === "string") return payload;
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    for (const key of ["text", "result", "summary", "content"] as const) {
      const value = (payload as Record<string, unknown>)[key];
      if (typeof value === "string") return value;
    }
  }
  const serialized = JSON.stringify(payload);
  return serialized ?? "";
}

export class SqliteCorpus {
  readonly #db: Database;
  readonly #insertStmt: Statement<RowTuple>;

  constructor(options: SqliteCorpusOptions) {
    this.#db = new Database(options.dbPath);
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        tool TEXT,
        text TEXT NOT NULL DEFAULT '',
        ts TEXT NOT NULL
      );
    `);
    this.#db.exec("CREATE INDEX IF NOT EXISTS idx_entries_id ON entries(id);");
    this.#insertStmt = this.#db.prepare(
      "INSERT INTO entries (session_id, type, tool, text, ts) VALUES (?, ?, ?, ?, ?)",
    );
  }

  /** 条目总数（测试与运维检查用）。 */
  count(): number {
    const row = this.#db.query("SELECT COUNT(*) AS c FROM entries").get() as { c: number } | null;
    return row?.c ?? 0;
  }

  /** 清空语料（rebuildIndex 清表重灌用；不影响表结构）。 */
  clear(): void {
    this.#db.exec("DELETE FROM entries;");
    this.#db.exec("DELETE FROM sqlite_sequence WHERE name='entries';");
  }

  /**
   * 流式灌入一个会话 JSONL 文件：meta 行提供 session_id，entry 行投影入库，
   * 残缺/非法行跳过；批量事务插入，每批触发 onProgress。
   */
  async ingest(
    jsonlPath: string,
    options: { onProgress?: (progress: IngestProgress) => void; batchSize?: number } = {},
  ): Promise<IngestResult> {
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    const insertBatch = this.#db.transaction((rows: RowTuple[]) => {
      for (const row of rows) this.#insertStmt.run(...row);
    });

    let pending: RowTuple[] = [];
    let inserted = 0;
    let lines = 0;
    let sessionId = "";

    const flush = (): void => {
      if (pending.length === 0) return;
      insertBatch(pending);
      inserted += pending.length;
      pending = [];
      options.onProgress?.({ lines, inserted });
    };

    const handleLine = (line: string): void => {
      lines += 1;
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let value: unknown;
      try {
        value = JSON.parse(trimmed);
      } catch {
        return; // 残缺行跳过
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) return;
      const record = value as Record<string, unknown>;
      if (record.kind === "meta") {
        if (typeof record.sessionId === "string" && record.sessionId.length > 0) {
          sessionId = record.sessionId;
        }
        return;
      }
      if (record.kind !== "entry") return;
      const entry = record.entry;
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return;
      const e = entry as Record<string, unknown>;
      if (typeof e.type !== "string" || typeof e.createdAt !== "number") return;
      if (sessionId.length === 0) return; // meta 前的孤儿条目：跳过
      const tool = typeof e.toolName === "string" ? e.toolName : null;
      const ts = new Date(e.createdAt).toISOString();
      pending.push([sessionId, e.type, tool, extractText(e.payload as JsonValue), ts]);
      if (pending.length >= batchSize) flush();
    };

    const stream = createReadStream(jsonlPath, { encoding: "utf8" });
    let buffer = "";
    for await (const chunk of stream) {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    }
    if (buffer.length > 0) handleLine(buffer); // 无换行结尾的末行
    flush();
    return { lines, inserted };
  }

  /**
   * keyset 分页检索：谓词 JS 侧求值，内部批量扫描直到集满或扫尽；
   * nextCursor = 本页最后扫描到的原始行 id（无重无漏）。
   */
  search(predicate: FilterPredicate, options: SearchOpts = {}): SearchResult {
    const pageSize = Math.min(
      Math.max(Math.trunc(options.pageSize ?? DEFAULT_PAGE_SIZE), 1),
      MAX_PAGE_SIZE,
    );
    let cursor = options.cursor ?? 0;
    const items: CorpusEntry[] = [];
    let exhausted = false;

    const stmt = this.#db.prepare(
      "SELECT id, session_id, type, tool, text, ts FROM entries WHERE id > ? ORDER BY id LIMIT ?",
    );
    while (items.length < pageSize && !exhausted) {
      const rows = stmt.all(cursor, SCAN_BATCH) as RawRow[];
      if (rows.length === 0) {
        exhausted = true;
        break;
      }
      const lastIdx = rows.length - 1;
      let filled = false;
      for (let idx = 0; idx <= lastIdx; idx++) {
        const row = rows[idx] as RawRow;
        cursor = row.id;
        const entry: CorpusEntry = {
          id: row.id,
          sessionId: row.session_id,
          type: row.type,
          tool: row.tool,
          text: row.text,
          ts: row.ts,
        };
        if (!predicate(entry)) continue;
        items.push(entry);
        if (items.length >= pageSize) {
          filled = true;
          // 页满算「扫尽」仅当：恰好停在本批最后一行，且本批不足一批（表尾）。
          if (idx === lastIdx && rows.length < SCAN_BATCH) exhausted = true;
          break;
        }
      }
      // 页未满且本批逐行消费完毕：本批不足一批即表尾。
      if (!filled && rows.length < SCAN_BATCH) exhausted = true;
    }
    return { items, nextCursor: exhausted ? null : cursor };
  }

  /** 关闭数据库句柄（测试 afterEach 用）。 */
  close(): void {
    this.#db.close();
  }
}
