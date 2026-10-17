/**
 * BI-14.5 · Durable 存储底座测试（SqliteDurableStore × MemoryDurableStore）。
 *
 * 覆盖工单钉死的存储矩阵：
 * 1. 两实现 put/get/delete 全生命周期（含 missing → null、upsert 覆盖）；
 * 2. 游标分页协议：600 行 pageSize=137 无重无漏、中段续扫、默认 256、
 *    空 states 返回空页、nextCursor=null 终止；
 * 3. 两 store 等价性：同操作序列 → get/scan 快照逐字段一致（接缝①可互换）；
 * 4. Sqlite WAL 生效（tmp 文件库 journal_mode=wal）、checkpoint JSON 保真；
 * 5. Memory 版存取深拷贝（外部改写不污染库内）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PAGE_SIZE,
  MemoryDurableStore,
  SqliteDurableStore,
} from "./storage";
import type { DurableStore, ScanPage } from "./storage";
import type { JsonValue, TaskRecord, TaskState } from "./task-state";

/** 记录工厂（attempts/maxAttempts/updatedAt 定值，聚焦状态与 checkpoint）。 */
const rec = (id: string, state: TaskState, checkpoint: JsonValue = null): TaskRecord => ({
  id,
  kind: "job",
  state,
  checkpoint,
  attempts: 0,
  maxAttempts: 3,
  updatedAt: 1_000,
});

/** tmp 文件 SQLite 库（WAL 断言等需要真实文件路径的场景），随 cleanup 删除。 */
function tmpSqlite(): { store: SqliteDurableStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "bi-durable-store-"));
  const store = new SqliteDurableStore(join(dir, "tasks.db"));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 游标分页全量拉齐（测试侧独立实现，与 store 内部实现互证）。 */
function collectAll(
  store: DurableStore,
  states: TaskState[],
  pageSize: number,
): { ids: string[]; pages: number } {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const page: ScanPage = store.scanStates(states, cursor, pageSize);
    pages++;
    for (const item of page.items) ids.push(item.id);
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return { ids, pages };
}

/** 600 行混合状态数据集：偶数序号 pending、奇数序号 suspended（ASCII 有序 id）。 */
function seed600(store: DurableStore): void {
  for (let i = 0; i < 600; i++) {
    const id = `r${String(i).padStart(3, "0")}`;
    store.put(rec(id, i % 2 === 0 ? "pending" : "suspended", { seq: i }));
  }
}

describe("BI-14.5 DurableStore 全生命周期", () => {
  test("Memory：put/get/delete，missing 返回 null", () => {
    const store = new MemoryDurableStore();
    expect(store.get("nope")).toBeNull();
    store.put(rec("m1", "pending", { v: 1 }));
    expect(store.get("m1")).toEqual(rec("m1", "pending", { v: 1 }));
    store.delete("m1");
    expect(store.get("m1")).toBeNull();
    store.delete("m1"); // 重复删除不报错
  });

  test("Sqlite：put/get/delete，missing 返回 null", () => {
    const store = new SqliteDurableStore(); // :memory: 代码路径同生产
    expect(store.get("nope")).toBeNull();
    store.put(rec("s1", "pending", { v: 1 }));
    expect(store.get("s1")).toEqual(rec("s1", "pending", { v: 1 }));
    store.delete("s1");
    expect(store.get("s1")).toBeNull();
    store.close();
  });

  test("Memory：put 为 upsert 语义（同 id 覆盖）", () => {
    const store = new MemoryDurableStore();
    store.put(rec("u1", "pending"));
    store.put(rec("u1", "running", { step: 2 }));
    expect(store.get("u1")?.state).toBe("running");
    expect(store.get("u1")?.checkpoint).toEqual({ step: 2 });
  });

  test("Sqlite：put 为 upsert 语义（同 id 覆盖）", () => {
    const store = new SqliteDurableStore();
    store.put(rec("u1", "pending"));
    store.put(rec("u1", "running", { step: 2 }));
    expect(store.get("u1")?.state).toBe("running");
    expect(store.get("u1")?.checkpoint).toEqual({ step: 2 });
    store.close();
  });

  test("Sqlite：checkpoint 对象/数组/标量 JSON 保真 round-trip", () => {
    const store = new SqliteDurableStore();
    const samples: JsonValue[] = [
      { nested: { list: [1, "two", null, true, { deep: 3 }] } },
      [1, 2, 3],
      "plain",
      42,
      true,
      null,
    ];
    samples.forEach((checkpoint, i) => {
      store.put(rec(`j${i}`, "pending", checkpoint));
    });
    samples.forEach((checkpoint, i) => {
      expect(store.get(`j${i}`)?.checkpoint).toEqual(checkpoint);
    });
    store.close();
  });

  test("Memory：get 返回深拷贝，外部改写不污染库内", () => {
    const store = new MemoryDurableStore();
    store.put(rec("c1", "pending", { n: 1 }));
    const fetched = store.get("c1");
    expect(fetched).not.toBeNull();
    fetched!.state = "completed";
    if (fetched!.checkpoint !== null && typeof fetched!.checkpoint === "object") {
      (fetched!.checkpoint as { n: number }).n = 999;
    }
    expect(store.get("c1")?.state).toBe("pending");
    expect(store.get("c1")?.checkpoint).toEqual({ n: 1 });
  });
});

describe("BI-14.5 游标分页协议", () => {
  test("Memory：600 行 pageSize=137 分页无重无漏，页数符合预期", () => {
    const store = new MemoryDurableStore();
    seed600(store);
    const all = collectAll(store, ["pending", "suspended"], 137);
    expect(all.ids).toHaveLength(600);
    expect(new Set(all.ids).size).toBe(600);
    // 137*4=548 < 600 ≤ 137*5=685 → 5 页
    expect(all.pages).toBe(5);
    expect(all.ids[0]).toBe("r000");
    expect(all.ids.at(-1)).toBe("r599");
  });

  test("Sqlite：600 行 pageSize=137 分页无重无漏，页数符合预期", () => {
    const store = new SqliteDurableStore();
    seed600(store);
    const all = collectAll(store, ["pending", "suspended"], 137);
    expect(all.ids).toHaveLength(600);
    expect(new Set(all.ids).size).toBe(600);
    expect(all.pages).toBe(5);
    store.close();
  });

  test("Memory：按状态过滤（600 行中 pending 恰 300，有序）", () => {
    const store = new MemoryDurableStore();
    seed600(store);
    const pending = collectAll(store, ["pending"], 64);
    expect(pending.ids).toHaveLength(300);
    pending.ids.forEach((id, i) => {
      expect(id).toBe(`r${String(i * 2).padStart(3, "0")}`);
    });
  });

  test("Sqlite：按状态过滤（600 行中 pending 恰 300，有序）", () => {
    const store = new SqliteDurableStore();
    seed600(store);
    const pending = collectAll(store, ["pending"], 64);
    expect(pending.ids).toHaveLength(300);
    pending.ids.forEach((id, i) => {
      expect(id).toBe(`r${String(i * 2).padStart(3, "0")}`);
    });
    store.close();
  });

  test("两 store：缺省 pageSize=256（601 行首屏恰 256）", () => {
    const memory = new MemoryDurableStore();
    const sqlite = new SqliteDurableStore();
    for (const store of [memory, sqlite]) {
      for (let i = 0; i < 601; i++) {
        store.put(rec(`p${String(i).padStart(3, "0")}`, "pending"));
      }
      const first = store.scanStates(["pending"]);
      expect(first.items).toHaveLength(DEFAULT_PAGE_SIZE);
      expect(first.nextCursor).toBe("p255");
      // 断言缺省值确实来自常量（工单钉死 256）
      expect(DEFAULT_PAGE_SIZE).toBe(256);
    }
    sqlite.close();
  });

  test("两 store：中段 cursor 续扫从严格大于处继续（边界不重不漏）", () => {
    const memory = new MemoryDurableStore();
    const sqlite = new SqliteDurableStore();
    for (const store of [memory, sqlite]) {
      for (let i = 0; i < 10; i++) {
        store.put(rec(`b${i}`, "pending"));
      }
      const mid = store.scanStates(["pending"], null, 4);
      expect(mid.items.map((r) => r.id)).toEqual(["b0", "b1", "b2", "b3"]);
      const rest = store.scanStates(["pending"], mid.nextCursor, 4);
      expect(rest.items.map((r) => r.id)).toEqual(["b4", "b5", "b6", "b7"]);
      const tail = store.scanStates(["pending"], rest.nextCursor, 4);
      expect(tail.items.map((r) => r.id)).toEqual(["b8", "b9"]);
      expect(tail.nextCursor).toBeNull(); // 未满页 → 终止
    }
    sqlite.close();
  });

  test("两 store：空 states 数组返回空页（不产生非法 SQL）", () => {
    const memory = new MemoryDurableStore();
    const sqlite = new SqliteDurableStore();
    memory.put(rec("x", "pending"));
    sqlite.put(rec("x", "pending"));
    for (const store of [memory, sqlite]) {
      const page = store.scanStates([]);
      expect(page.items).toEqual([]);
      expect(page.nextCursor).toBeNull();
    }
    sqlite.close();
  });

  test("Sqlite（tmp 文件库）：journal_mode=wal 生效", () => {
    const { store, cleanup } = tmpSqlite();
    try {
      expect(store.journalMode).toBe("wal");
    } finally {
      cleanup();
    }
  });
});

describe("BI-14.5 两 store 等价性（接缝①可互换）", () => {
  test("同操作序列（put 覆盖/删除/多态扫描）→ get+scan 快照逐字段一致", () => {
    const script = (store: DurableStore) => {
      store.put(rec("a", "pending", { n: 1 }));
      store.put(rec("b", "running", { n: 2 }));
      store.put(rec("c", "completed", "done"));
      store.put(rec("a", "running", { n: 1 })); // upsert 覆盖
      store.delete("b");
      store.put(rec("d", "suspended", [1, 2, 3]));
      return {
        a: store.get("a"),
        b: store.get("b"),
        missing: store.get("zz"),
        pending: store.scanStates(["pending"]).items,
        running: store.scanStates(["running"]).items,
        suspended: store.scanStates(["suspended"]).items,
        completed: store.scanStates(["completed"]).items,
        everything: store.scanStates([
          "pending",
          "running",
          "suspended",
          "completed",
          "failed",
        ]).items,
      };
    };
    const sqlite = new SqliteDurableStore();
    expect(script(new MemoryDurableStore())).toEqual(script(sqlite));
    sqlite.close();
  });

  test("600 行混合数据：两 store 全量扫描结果一致", () => {
    const memory = new MemoryDurableStore();
    const sqlite = new SqliteDurableStore();
    seed600(memory);
    seed600(sqlite);
    expect(collectAll(memory, ["pending", "suspended"], 97)).toEqual(
      collectAll(sqlite, ["pending", "suspended"], 97),
    );
    sqlite.close();
  });
});
