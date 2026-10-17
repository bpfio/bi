/**
 * BI-14.5 · Durable 存储底座——SqliteDurableStore（bun:sqlite，WAL）+ MemoryDurableStore（纯 TS 兜底）。
 *
 * 接缝①（工单钉死）：持久化走单一 SQLite 底座，禁私建存储格式。两实现同一
 * DurableStore 接口、同一语义（upsert 式 put、按 id 升序游标分页），可互换
 * （等价性测试钉死）。Memory 版供零 IO 场景（单测/嵌入式）兜底；生产装配
 * Sqlite 版（bun:sqlite 内建，零外部 npm 依赖）。
 *
 * 分页协议（游标 = 上一页最后一条的 id，严格大于语义）：
 *   scanStates(states, cursor?, pageSize?) → { items, nextCursor }
 *   - 按 id 升序稳定排序，nextCursor 非 null 即"可能还有下一页"；
 *   - 取满一页（items.length === pageSize）才发 nextCursor，翻页直到 null 即全量拉齐；
 *   - pageSize 缺省 256（工单钉死），非法值回退默认。
 */
import { Database } from "bun:sqlite";
import type { JsonValue, TaskRecord, TaskState } from "./task-state";

/** 缺省分页大小（工单钉死 256）。 */
export const DEFAULT_PAGE_SIZE = 256;

/** 一次分页扫描的返回：items 为本页记录，nextCursor 为 null 表示扫描终止。 */
export interface ScanPage {
  items: TaskRecord[];
  nextCursor: string | null;
}

/** Durable 存储接口：get / put（upsert）/ delete / 游标分页扫描。 */
export interface DurableStore {
  get(id: string): TaskRecord | null;
  put(record: TaskRecord): void;
  delete(id: string): void;
  scanStates(
    states: readonly TaskState[],
    cursor?: string | null,
    pageSize?: number,
  ): ScanPage;
}

/** 分页大小规范化：非法（非有限 / <1）回退默认 256。 */
export function normalizePageSize(pageSize: number): number {
  if (!Number.isFinite(pageSize) || pageSize < 1) return DEFAULT_PAGE_SIZE;
  return Math.trunc(pageSize);
}

/** id 比较（码元序；两实现保持同一排序语义，等价性测试用 ASCII id 钉死）。 */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 纯内存 DurableStore 兜底实现。存取均深拷贝（structuredClone），外部改写
 * 返回值不污染库内记录——与 Sqlite 版"每次查询产出独立对象"的行为对齐。
 */
export class MemoryDurableStore implements DurableStore {
  readonly #rows = new Map<string, TaskRecord>();

  get(id: string): TaskRecord | null {
    const row = this.#rows.get(id);
    return row === undefined ? null : structuredClone(row);
  }

  put(record: TaskRecord): void {
    this.#rows.set(record.id, structuredClone(record));
  }

  delete(id: string): void {
    this.#rows.delete(id);
  }

  scanStates(
    states: readonly TaskState[],
    cursor?: string | null,
    pageSize?: number,
  ): ScanPage {
    const size = normalizePageSize(pageSize ?? DEFAULT_PAGE_SIZE);
    const allowed = new Set(states);
    const matched: TaskRecord[] = [];
    for (const row of this.#rows.values()) {
      if (!allowed.has(row.state)) continue;
      if (cursor !== undefined && cursor !== null && !(cursor < row.id)) continue;
      matched.push(row);
    }
    matched.sort((a, b) => compareIds(a.id, b.id));
    const items = matched.slice(0, size).map((row) => structuredClone(row));
    const last = items.at(-1);
    return {
      items,
      nextCursor: items.length === size && last !== undefined ? last.id : null,
    };
  }
}

/** tasks 表 DDL：单表 + (state, id) 索引，恰够 scanStates 走索引有序扫描。 */
const TASKS_DDL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,
    state        TEXT NOT NULL,
    checkpoint   TEXT NOT NULL,
    attempts     INTEGER NOT NULL,
    max_attempts INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks (state, id);
`;

/** bun:sqlite 行 → TaskRecord（checkpoint 反序列化 JSON）。 */
function rowToRecord(row: Record<string, unknown>): TaskRecord {
  return {
    id: row.id as string,
    kind: row.kind as string,
    state: row.state as TaskState,
    checkpoint: JSON.parse(row.checkpoint as string) as JsonValue,
    attempts: row.attempts as number,
    maxAttempts: row.max_attempts as number,
    updatedAt: row.updated_at as number,
  };
}

/**
 * bun:sqlite 内建驱动（WAL 模式）的 DurableStore。path 缺省 ":memory:"，
 * 生产传入文件路径。checkpoint 以 JSON 文本落盘（单一 SQLite 底座，无私有格式）。
 */
export class SqliteDurableStore implements DurableStore {
  readonly #db: Database;

  constructor(path: string = ":memory:") {
    this.#db = new Database(path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec(TASKS_DDL);
  }

  /** 当前 journal_mode（自检/测试用，验证 WAL 生效）。 */
  get journalMode(): string {
    const row = this.#db.query("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    return row.journal_mode;
  }

  /** 关闭底层连接（测试清理 / 优雅停机用）。 */
  close(): void {
    this.#db.close();
  }

  get(id: string): TaskRecord | null {
    const row = this.#db
      .query("SELECT * FROM tasks WHERE id = ?")
      .get(id) as Record<string, unknown> | null;
    return row === null ? null : rowToRecord(row);
  }

  put(record: TaskRecord): void {
    this.#db
      .query(
        `INSERT INTO tasks (id, kind, state, checkpoint, attempts, max_attempts, updated_at)
         VALUES ($id, $kind, $state, $checkpoint, $attempts, $maxAttempts, $updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           kind         = excluded.kind,
           state        = excluded.state,
           checkpoint   = excluded.checkpoint,
           attempts     = excluded.attempts,
           max_attempts = excluded.max_attempts,
           updated_at   = excluded.updated_at`,
      )
      .run({
        $id: record.id,
        $kind: record.kind,
        $state: record.state,
        $checkpoint: JSON.stringify(record.checkpoint),
        $attempts: record.attempts,
        $maxAttempts: record.maxAttempts,
        $updatedAt: record.updatedAt,
      });
  }

  delete(id: string): void {
    this.#db.query("DELETE FROM tasks WHERE id = ?").run(id);
  }

  scanStates(
    states: readonly TaskState[],
    cursor?: string | null,
    pageSize?: number,
  ): ScanPage {
    const size = normalizePageSize(pageSize ?? DEFAULT_PAGE_SIZE);
    if (states.length === 0) return { items: [], nextCursor: null };
    const from = cursor ?? "";
    const placeholders = states.map(() => "?").join(", ");
    const rows = this.#db
      .query(
        `SELECT * FROM tasks
         WHERE state IN (${placeholders}) AND id > ?
         ORDER BY id
         LIMIT ?`,
      )
      .all(...states, from, size) as Array<Record<string, unknown>>;
    const items = rows.map(rowToRecord);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length === size && last !== undefined ? last.id : null,
    };
  }
}
