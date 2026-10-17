import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndexEngine, SqliteIndexEngine } from "./index";
import type { SessionIndex } from "./index";
import { SessionManager } from "./manager";
import type { SessionEntry, SessionMeta } from "./types";

let dir: string | undefined;

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

/** 确定性构造条目（id 形如 UUIDv7 但仅作索引键使用）。 */
function mkEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  const seq = overrides.seq ?? 0;
  return {
    id: overrides.id ?? `00000000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    parentId: null,
    type: "user",
    payload: { seq },
    createdAt: 1700000000000 + seq,
    seq,
    ...overrides,
  };
}

/** 双引擎跑同一操作序列（含 upsert 覆盖、工具字段、中文与复合 JSON）。 */
function runOps(ix: SessionIndex): void {
  const m1: SessionMeta = { sessionId: "s-1", title: "Alpha 主线", createdAt: 100, cwd: "/a" };
  const m2: SessionMeta = { sessionId: "s-2", title: "Beta", createdAt: 200 };
  const m3: SessionMeta = { sessionId: "s-3", title: "Gamma 分支", createdAt: 150, forkedFrom: "s-1" };
  ix.upsert(m1);
  ix.upsert(m2);
  ix.upsert(m3);

  ix.upsertEntry("s-1", mkEntry({ id: "e-1", parentId: null, seq: 1, payload: { text: "中文问题" } }));
  ix.upsertEntry(
    "s-1",
    mkEntry({
      id: "e-2",
      parentId: "e-1",
      seq: 2,
      type: "assistant",
      payload: ["数组", 42, null, true, { nested: { deep: "值" } }],
    }),
  );
  ix.upsertEntry(
    "s-1",
    mkEntry({
      id: "e-3",
      parentId: "e-2",
      seq: 3,
      type: "tool_call",
      payload: { command: "ls -la" },
      toolCallId: "call-001",
      toolName: "bash",
    }),
  );
  ix.upsertEntry(
    "s-2",
    mkEntry({
      id: "e-4",
      parentId: null,
      seq: 1,
      type: "tool_result",
      payload: "结果文本",
      toolCallId: "call-001",
    }),
  );
  // 孤儿条目：会话元数据不存在，两引擎行为需一致
  ix.upsertEntry("s-orphan", mkEntry({ id: "e-orphan", seq: 1 }));

  // 幂等覆盖：元数据 title 更新
  ix.upsert({ ...m2, title: "Beta2" });
  // 幂等覆盖：同 id 条目 payload 更新
  ix.upsertEntry(
    "s-2",
    mkEntry({ id: "e-4", seq: 1, type: "tool_result", payload: "结果文本v2", toolCallId: "call-001" }),
  );
}

describe("SessionIndex 双引擎等价性", () => {
  test("同一操作序列下 Memory 与 Sqlite 查询结果完全一致", () => {
    const memory = new MemoryIndexEngine();
    const sqlite = new SqliteIndexEngine(); // 默认 :memory:
    try {
      runOps(memory);
      runOps(sqlite);

      expect(memory.list()).toEqual(sqlite.list());
      expect(memory.list().map((m) => m.sessionId)).toEqual(["s-2", "s-3", "s-1"]); // createdAt 降序
      expect(memory.list()[2]?.title).toBe("Alpha 主线");
      expect(memory.getSession("s-1")).toEqual(sqlite.getSession("s-1"));
      expect(memory.getSession("s-2")?.title).toBe("Beta2"); // upsert 覆盖生效
      expect(memory.getSession("missing")).toEqual(sqlite.getSession("missing")); // 双 undefined
      expect(memory.getBySession("s-1")).toEqual(sqlite.getBySession("s-1"));
      expect(memory.getBySession("s-2")).toEqual(sqlite.getBySession("s-2"));
      expect(memory.getBySession("missing")).toEqual(sqlite.getBySession("missing")); // 双 []
      expect(memory.getBySession("s-orphan")).toEqual(sqlite.getBySession("s-orphan"));

      // 工具配对字段与复杂 JSON 完整往返
      const e3 = memory.getBySession("s-1")[2];
      expect(e3?.toolCallId).toBe("call-001");
      expect(e3?.toolName).toBe("bash");
      const e2Payload = memory.getBySession("s-1")[1]?.payload;
      expect(e2Payload).toEqual(["数组", 42, null, true, { nested: { deep: "值" } }]);
      const e4 = memory.getBySession("s-2")[0];
      expect(e4?.payload).toBe("结果文本v2"); // upsertEntry 覆盖生效
    } finally {
      memory.close();
      sqlite.close();
    }
  });
});

describe("SqliteIndexEngine", () => {
  test("WAL 日志模式生效", async () => {
    dir = await mkdtemp(join(tmpdir(), "bi-index-"));
    const engine = new SqliteIndexEngine(join(dir, "idx.db"));
    try {
      expect(engine.journalMode).toBe("wal");
    } finally {
      engine.close();
    }
  });
});

describe("SessionIndex.rebuild（从 JSONL 全量恢复）", () => {
  test("两引擎从 SessionManager 落盘数据重建出一致且正确的索引", async () => {
    dir = await mkdtemp(join(tmpdir(), "bi-index-"));
    const root = join(dir, "sessions");
    let tick = 1700000000000;
    const mgr = new SessionManager({ rootDir: root, now: () => (tick += 1000) });

    const s1 = await mgr.createSession({ title: "主线会话", cwd: "/work" });
    const r1 = await mgr.append(s1.sessionId, null, { type: "user", payload: { q: "第一问" } });
    const r2 = await mgr.append(s1.sessionId, r1.id, {
      type: "assistant",
      payload: { a: "第一答" },
    });
    const fork = await mgr.fork(s1.sessionId, r1.id, { title: "分支会话" });
    const f1 = await mgr.append(fork.sessionId, fork.branchTip, {
      type: "tool_call",
      payload: { command: "pwd" },
      toolCallId: "call-042",
      toolName: "bash",
    });

    const memory = new MemoryIndexEngine();
    const sqlite = new SqliteIndexEngine();
    try {
      expect(memory.rebuild(root)).toBe(2);
      expect(sqlite.rebuild(root)).toBe(2);

      // 两引擎重建结果一致
      expect(memory.list()).toEqual(sqlite.list());
      expect(memory.list()).toEqual(await mgr.listSessions()); // 与 JSONL 事实一致
      expect(memory.getBySession(s1.sessionId)).toEqual(sqlite.getBySession(s1.sessionId));
      expect(memory.getBySession(fork.sessionId)).toEqual(sqlite.getBySession(fork.sessionId));

      // 内容正确性
      expect(sqlite.getSession(s1.sessionId)).toEqual(s1);
      expect(sqlite.getSession(fork.sessionId)?.forkedFrom).toBe(s1.sessionId);
      expect(sqlite.getBySession(s1.sessionId)).toEqual([r1, r2]);
      // fork 会话 = 拷贝的根→分叉点路径（r1）+ 分叉后追加的 f1
      expect(sqlite.getBySession(fork.sessionId)).toEqual([r1, f1]);

      // 重建是全量替换：先塞入垃圾会话，rebuild 后消失
      sqlite.upsert({ sessionId: "ghost", title: "幽灵", createdAt: 1 });
      expect(sqlite.list()).toHaveLength(3);
      expect(sqlite.rebuild(root)).toBe(2);
      expect(sqlite.getSession("ghost")).toBeUndefined();
      expect(sqlite.list()).toHaveLength(2);

      // 幂等：重复重建结果不变
      expect(sqlite.rebuild(root)).toBe(2);
      expect(sqlite.list()).toEqual(memory.list());
    } finally {
      memory.close();
      sqlite.close();
    }
  });

  test("目录不存在时 rebuild 返回 0", async () => {
    dir = await mkdtemp(join(tmpdir(), "bi-index-"));
    const memory = new MemoryIndexEngine();
    const sqlite = new SqliteIndexEngine();
    try {
      expect(memory.rebuild(join(dir, "nope"))).toBe(0);
      expect(sqlite.rebuild(join(dir, "nope"))).toBe(0);
      expect(memory.list()).toEqual([]);
      expect(sqlite.list()).toEqual([]);
    } finally {
      memory.close();
      sqlite.close();
    }
  });
});
