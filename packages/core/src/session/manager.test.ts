import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionFileCorruptError,
  SessionManager,
  SessionNotFoundError,
  clearResumeTarget,
  defaultSessionsRoot,
  registerResumeTarget,
} from "./manager";
import type { JsonValue } from "./types";

let dir: string | undefined;

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

/** 每个测试独立的临时会话目录 + 固定时钟（绝不触碰真实 ~/.bi）。 */
async function makeManager(now: () => number = () => 1700000000000): Promise<SessionManager> {
  dir = await mkdtemp(join(tmpdir(), "bi-session-"));
  return new SessionManager({ rootDir: join(dir, "sessions"), now });
}

function fileOf(mgr: SessionManager, sessionId: string): string {
  return join(mgr.rootDir, `${sessionId}.jsonl`);
}

async function rawOf(mgr: SessionManager, sessionId: string): Promise<string> {
  return readFile(fileOf(mgr, sessionId), "utf8");
}

/** 构造一条 4 节点链：根 → a → b → c，返回各节点 id（显式元组，测试免下标判空）。 */
async function setupChain(): Promise<{
  mgr: SessionManager;
  sessionId: string;
  ids: [string, string, string, string];
}> {
  const mgr = await makeManager();
  const meta = await mgr.createSession({ title: "主线", cwd: "/w" });
  const e1 = await mgr.append(meta.sessionId, null, { type: "user", payload: { text: "问1" } });
  const e2 = await mgr.append(meta.sessionId, e1.id, { type: "assistant", payload: { text: "答1" } });
  const e3 = await mgr.append(meta.sessionId, e2.id, { type: "user", payload: { text: "问2" } });
  const e4 = await mgr.append(meta.sessionId, e3.id, { type: "assistant", payload: { text: "答2" } });
  return { mgr, sessionId: meta.sessionId, ids: [e1.id, e2.id, e3.id, e4.id] };
}

describe("SessionManager.createSession", () => {
  test("落盘 meta 首行并 fsync，元数据可读回", async () => {
    const mgr = await makeManager();
    const meta = await mgr.createSession({ title: "测试会话", cwd: "/work/dir" });
    expect(meta.title).toBe("测试会话");
    expect(meta.cwd).toBe("/work/dir");
    const raw = await rawOf(mgr, meta.sessionId);
    const firstLine = JSON.parse(raw.split("\n")[0] as string) as Record<string, unknown>;
    expect(firstLine.kind).toBe("meta");
    expect(firstLine.sessionId).toBe(meta.sessionId);
    expect(firstLine.title).toBe("测试会话");
    expect(firstLine.cwd).toBe("/work/dir");
    expect(raw.endsWith("\n")).toBe(true);
    expect(await mgr.getSessionMeta(meta.sessionId)).toEqual(meta);
  });

  test("重复创建同名会话被拒绝", async () => {
    const mgr = await makeManager();
    const meta = await mgr.createSession({ sessionId: "fixed-id-01" });
    await expect(mgr.createSession({ sessionId: meta.sessionId })).rejects.toThrow("会话已存在");
  });

  test("非法 sessionId（路径穿越）被拒绝", async () => {
    const mgr = await makeManager();
    await expect(mgr.createSession({ sessionId: "../evil" })).rejects.toThrow("非法会话 id");
  });

  test("不存在的会话返回 undefined / SessionNotFoundError", async () => {
    const mgr = await makeManager();
    expect(await mgr.getSessionMeta("no-such-session")).toBeUndefined();
    await expect(mgr.entries("no-such-session")).rejects.toThrow(SessionNotFoundError);
  });
});

describe("SessionManager.append", () => {
  test("根节点追加与读回（JSON 往返一致）", async () => {
    const mgr = await makeManager();
    const meta = await mgr.createSession({ title: "追加" });
    const root = await mgr.append(meta.sessionId, null, {
      type: "user",
      payload: { content: "你好，世界 🎉", nested: { arr: [1, 2.5, null, true] } },
    });
    expect(root.seq).toBe(1);
    expect(root.parentId).toBeNull();
    expect(root.type).toBe("user");
    expect(root.createdAt).toBe(1700000000000);
    const entries = await mgr.entries(meta.sessionId);
    expect(entries).toEqual([root]);
  });

  test("第二个根被拒绝；未知父节点被拒绝", async () => {
    const mgr = await makeManager();
    const meta = await mgr.createSession();
    await mgr.append(meta.sessionId, null, { type: "user", payload: "r" });
    await expect(
      mgr.append(meta.sessionId, null, { type: "user", payload: "second root" }),
    ).rejects.toThrow("不允许第二个根");
    await expect(
      mgr.append(meta.sessionId, "missing-parent", { type: "user", payload: "x" }),
    ).rejects.toThrow("父节点不存在");
  });

  test("非法类型与 undefined payload 被拒绝", async () => {
    const mgr = await makeManager();
    const meta = await mgr.createSession();
    await expect(
      mgr.append(meta.sessionId, null, {
        type: "bogus" as "user",
        payload: "x",
      }),
    ).rejects.toThrow("非法条目类型");
    await expect(
      mgr.append(meta.sessionId, null, {
        type: "user",
        payload: undefined as unknown as JsonValue,
      }),
    ).rejects.toThrow("payload");
  });

  test("tool_call/tool_result 预留字段完整往返", async () => {
    const mgr = await makeManager();
    const meta = await mgr.createSession();
    const root = await mgr.append(meta.sessionId, null, { type: "user", payload: "跑一下" });
    const call = await mgr.append(meta.sessionId, root.id, {
      type: "tool_call",
      payload: { command: "ls -la" },
      toolCallId: "call-001",
      toolName: "bash",
    });
    const result = await mgr.append(meta.sessionId, call.id, {
      type: "tool_result",
      payload: { output: "total 0" },
      toolCallId: "call-001",
    });
    const entries = await mgr.entries(meta.sessionId);
    expect(entries[2]?.toolCallId).toBe("call-001"); // 配对字段 BI-10.2 归属，本卡仅透传
    expect(entries).toEqual([root, call, result]);
  });
});

describe("SessionManager.history", () => {
  test("沿 parent 链回溯根→节点路径", async () => {
    const mgr = await makeManager();
    const meta = await mgr.createSession();
    const e1 = await mgr.append(meta.sessionId, null, { type: "user", payload: "一" });
    const e2 = await mgr.append(meta.sessionId, e1.id, { type: "assistant", payload: "二" });
    const e3 = await mgr.append(meta.sessionId, e2.id, { type: "user", payload: "三" });
    expect((await mgr.history(meta.sessionId, e3.id)).map((e) => e.id)).toEqual([e1.id, e2.id, e3.id]);
    expect((await mgr.history(meta.sessionId, e1.id)).map((e) => e.id)).toEqual([e1.id]);
    expect((await mgr.entries(meta.sessionId)).map((e) => e.seq)).toEqual([1, 2, 3]);
    await expect(mgr.history(meta.sessionId, "missing-node")).rejects.toThrow("节点不存在");
  });
});

describe("SessionManager.fork", () => {
  test("从中间节点开分支：路径拷贝、源会话不动", async () => {
    const { mgr, sessionId, ids } = await setupChain();
    const [idRoot, idA] = ids;
    const fork = await mgr.fork(sessionId, idA);
    expect(fork.forkedFrom).toBe(sessionId);
    expect(fork.branchTip).toBe(idA);
    expect(fork.copied).toBe(2);

    const forkMeta = await mgr.getSessionMeta(fork.sessionId);
    expect(forkMeta?.forkedFrom).toBe(sessionId);
    expect(forkMeta?.title).toBe("主线 (fork)");
    expect(forkMeta?.cwd).toBe("/w");

    const forkEntries = await mgr.entries(fork.sessionId);
    expect(forkEntries.map((e) => e.id)).toEqual([idRoot, idA]);
    expect(forkEntries.map((e) => e.seq)).toEqual([1, 2]);
    expect((await mgr.history(fork.sessionId, fork.branchTip)).map((e) => e.id)).toEqual([
      idRoot,
      idA,
    ]);

    // 源会话物理文件不受影响
    expect(await mgr.entries(sessionId)).toHaveLength(4);
    expect((await mgr.listSessions()).map((m) => m.sessionId).sort()).toEqual(
      [sessionId, fork.sessionId].sort(),
    );
  });

  test("分支内继续追加形成完整子树", async () => {
    const { mgr, sessionId, ids } = await setupChain();
    const [idRoot, idA] = ids;
    const fork = await mgr.fork(sessionId, idA, { title: "侧线" });
    expect((await mgr.getSessionMeta(fork.sessionId))?.title).toBe("侧线");
    const next = await mgr.append(fork.sessionId, fork.branchTip, {
      type: "user",
      payload: { text: "分支续问" },
    });
    expect(next.parentId).toBe(idA);
    expect((await mgr.history(fork.sessionId, next.id)).map((e) => e.id)).toEqual([
      idRoot,
      idA,
      next.id,
    ]);
  });

  test("从末端节点 fork 拷贝全量路径；未知节点拒绝", async () => {
    const { mgr, sessionId, ids } = await setupChain();
    const fork = await mgr.fork(sessionId, ids[3]);
    expect(fork.copied).toBe(4);
    expect((await mgr.entries(fork.sessionId)).map((e) => e.id)).toEqual(ids);
    await expect(mgr.fork(sessionId, "missing-node")).rejects.toThrow("节点不存在");
  });
});

describe("SessionManager.rewindTo（append-only：物理历史永不删除）", () => {
  test("倒流返回游标，物理记录与文件保持原样，续写形成新分支", async () => {
    const { mgr, sessionId, ids } = await setupChain(); // 4 条
    const [idRoot, idA, idB, idC] = ids;
    const rawBefore = await rawOf(mgr, sessionId);

    const cursor = await mgr.rewindTo(sessionId, idA);
    expect(cursor.nextParentId).toBe(idA);
    expect(cursor.pathLength).toBe(2);
    expect(cursor.totalEntries).toBe(4);

    // 物理文件逐字节未变
    expect(await rawOf(mgr, sessionId)).toBe(rawBefore);
    expect(await mgr.entries(sessionId)).toHaveLength(4);

    // 以游标继续追加：新分支挂在 idA 下，老分支 b/c 仍在盘上
    const renewed = await mgr.append(sessionId, cursor.nextParentId, {
      type: "user",
      payload: { text: "换个思路重来" },
    });
    expect(renewed.parentId).toBe(idA);
    expect((await mgr.history(sessionId, renewed.id)).map((e) => e.id)).toEqual([
      idRoot,
      idA,
      renewed.id,
    ]);
    const after = await mgr.entries(sessionId);
    expect(after).toHaveLength(5);
    expect(after.map((e) => e.id)).toContain(idB);
    expect(after.map((e) => e.id)).toContain(idC);

    await expect(mgr.rewindTo(sessionId, "missing-node")).rejects.toThrow("节点不存在");
  });
});

describe("崩溃容忍（掉电模拟）", () => {
  async function makeTwoEntrySession(): Promise<{ mgr: SessionManager; sessionId: string }> {
    const mgr = await makeManager();
    const meta = await mgr.createSession({ title: "掉电" });
    const root = await mgr.append(meta.sessionId, null, { type: "user", payload: { t: "one" } });
    await mgr.append(meta.sessionId, root.id, { type: "assistant", payload: { t: "two" } });
    return { mgr, sessionId: meta.sessionId };
  }

  test("写半行掉电 → 重开丢弃残缺尾并返回截断位点 → 继续追加先截到干净边界", async () => {
    const { mgr, sessionId } = await makeTwoEntrySession();
    const rawClean = await rawOf(mgr, sessionId);
    // 模拟掉电：整行只写了一半，无换行符
    await appendFile(fileOf(mgr, sessionId), '{"kind":"entry","entry":{"id":"torn","pare');

    const fresh = new SessionManager({ rootDir: mgr.rootDir });
    const loaded = await fresh.loadSession(sessionId);
    expect(loaded.truncated).toBe(true);
    expect(loaded.entries).toHaveLength(2);
    expect(loaded.cleanLength).toBe(Buffer.byteLength(rawClean, "utf8"));

    // 掉电残留未清理前文件仍是坏的
    expect(await rawOf(fresh, sessionId)).not.toBe(rawClean);

    // 继续追加：先物理截断到干净边界，再落新行
    const tip = loaded.entries[loaded.entries.length - 1];
    if (tip === undefined) throw new Error("unreachable");
    const e3 = await fresh.append(sessionId, tip.id, { type: "user", payload: { t: "three" } });
    expect(e3.seq).toBe(3);
    const rawAfter = await rawOf(fresh, sessionId);
    expect(rawAfter).not.toContain('"torn"');
    expect(rawAfter.endsWith("\n")).toBe(true);
    expect(rawAfter.split("\n")).toHaveLength(5); // meta + 3 entries + 末尾空串
    // 再重开一个管理器读回一致（seq 连续）
    const again = new SessionManager({ rootDir: fresh.rootDir });
    expect((await again.entries(sessionId)).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  test("中文 payload 下截断位点按字节计算不漂移", async () => {
    const mgr = await makeManager();
    const meta = await mgr.createSession({ title: "中文" });
    const sessionId = meta.sessionId;
    const root = await mgr.append(sessionId, null, {
      type: "user",
      payload: { content: "中文内容🎉多字节" },
    });
    await mgr.append(sessionId, root.id, {
      type: "assistant",
      payload: { content: "回复：好的，已确认。" },
    });
    const rawClean = await rawOf(mgr, sessionId);
    await appendFile(fileOf(mgr, sessionId), '{"kind":"entry","entry":{"id":"x"'); // 半行

    const fresh = new SessionManager({ rootDir: mgr.rootDir });
    const loaded = await fresh.loadSession(sessionId);
    expect(loaded.truncated).toBe(true);
    expect(loaded.cleanLength).toBe(Buffer.byteLength(rawClean, "utf8"));
    const tip = loaded.entries[loaded.entries.length - 1];
    if (tip === undefined) throw new Error("unreachable");
    await fresh.append(sessionId, tip.id, { type: "user", payload: { content: "续" } });
    expect((await fresh.entries(sessionId)).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  test("坏行带换行符（中部垃圾）→ 从首个坏行起全部丢弃", async () => {
    const { mgr, sessionId } = await makeTwoEntrySession();
    const rawClean = await rawOf(mgr, sessionId);
    await appendFile(fileOf(mgr, sessionId), "not-json-at-all\n{\"kind\":\"entry\",\"entry\":{\"id\":");

    const fresh = new SessionManager({ rootDir: mgr.rootDir });
    const loaded = await fresh.loadSession(sessionId);
    expect(loaded.truncated).toBe(true);
    expect(loaded.entries).toHaveLength(2);
    expect(loaded.cleanLength).toBe(Buffer.byteLength(rawClean, "utf8"));
  });

  test("空文件 / meta 行残缺 / meta 与文件名不符 → 按损坏处理且不拖垮 listSessions", async () => {
    const { mgr, sessionId } = await makeTwoEntrySession();
    const brokenId = "broken-session";
    await writeFile(fileOf(mgr, brokenId), "");
    await writeFile(
      fileOf(mgr, "torn-meta-01"),
      '{"kind":"meta","v":1,"sessionId":"torn-meta-01","ti', // 半行，无换行
    );
    await writeFile(
      fileOf(mgr, "mismatch-id-01"),
      `${JSON.stringify({ kind: "meta", v: 1, sessionId: "other", title: "t", createdAt: 1 })}\n`,
    );

    const fresh = new SessionManager({ rootDir: mgr.rootDir });
    await expect(fresh.loadSession(brokenId)).rejects.toThrow(SessionFileCorruptError);
    await expect(fresh.loadSession("torn-meta-01")).rejects.toThrow(SessionFileCorruptError);
    await expect(fresh.loadSession("mismatch-id-01")).rejects.toThrow(SessionFileCorruptError);
    // 好会话不受影响，坏会话被列表跳过
    const listed = (await fresh.listSessions()).map((m) => m.sessionId);
    expect(listed).toEqual([sessionId]);
  });
});

describe("SessionManager.listSessions", () => {
  test("按 createdAt 降序（最新在前），默认根目录解析正确", async () => {
    let tick = 1700000000000;
    dir = await mkdtemp(join(tmpdir(), "bi-session-"));
    const mgr = new SessionManager({ rootDir: join(dir, "sessions"), now: () => (tick += 10) });
    const s1 = await mgr.createSession({ title: "s1" });
    const s2 = await mgr.createSession({ title: "s2" });
    const s3 = await mgr.createSession({ title: "s3" });
    const listed = await mgr.listSessions();
    expect(listed.map((m) => m.sessionId)).toEqual([s3.sessionId, s2.sessionId, s1.sessionId]);
    expect(defaultSessionsRoot()).toBe(join(homedir(), ".bi", "sessions"));
  });

  test("目录不存在时返回空列表", async () => {
    dir = await mkdtemp(join(tmpdir(), "bi-session-"));
    const mgr = new SessionManager({ rootDir: join(dir, "never-created") });
    expect(await mgr.listSessions()).toEqual([]);
  });
});

describe("FIX-A F4 · SessionManager.reopenSession（续会话缝）", () => {
  test("重开既有会话：返回 id/标题/全部条目 + 追加游标 tailId", async () => {
    const { mgr, sessionId, ids } = await setupChain();
    const reopened = await mgr.reopenSession(sessionId);
    expect(reopened.sessionId).toBe(sessionId);
    expect(reopened.title).toBe("主线");
    expect(reopened.entries).toHaveLength(4);
    expect(reopened.tailId).toBe(ids[3]);
  });

  test("空会话：tailId = null（首条新条目开根）", async () => {
    const mgr = await makeManager();
    const meta = await mgr.createSession({ title: "空会话" });
    const reopened = await mgr.reopenSession(meta.sessionId);
    expect(reopened.entries).toHaveLength(0);
    expect(reopened.tailId).toBe(null);
  });

  test("会话不存在：抛 SessionNotFoundError（宿主据此结构化报错退出）", async () => {
    const mgr = await makeManager();
    await expect(mgr.reopenSession("no-such-session")).rejects.toThrow(SessionNotFoundError);
  });
});

describe("FIX-A F4 · 续会话接管（会话 id 连续 + JSONL 续写）", () => {
  test("登记续会话目标后 createSession 复用既有会话（不新建文件、不覆盖历史）", async () => {
    const { mgr, sessionId, ids } = await setupChain();
    const before = await rawOf(mgr, sessionId);
    registerResumeTarget(sessionId);
    try {
      const meta = await mgr.createSession({ title: "新标题应被忽略" });
      expect(meta.sessionId).toBe(sessionId); // 复用既有会话（id 连续）
      expect(meta.title).toBe("主线"); // 既有标题不被覆盖
      expect(await rawOf(mgr, sessionId)).toBe(before); // 历史逐字节未动
    } finally {
      clearResumeTarget();
    }
  });

  test("接管后首条新条目挂到既有末条目（追加链连续，不开第二个根）", async () => {
    const { mgr, sessionId, ids } = await setupChain();
    registerResumeTarget(sessionId);
    try {
      const meta = await mgr.createSession({ title: "续会话" });
      const appended = await mgr.append(meta.sessionId, null, { type: "user", payload: { text: "续问" } });
      expect(appended.parentId).toBe(ids[3]); // 挂到末条目
      const entries = await mgr.entries(sessionId);
      expect(entries).toHaveLength(5);
      expect(entries[4]!.payload).toEqual({ text: "续问" });
    } finally {
      clearResumeTarget();
    }
  });

  test("未接管的会话：第二个根条目仍被拒绝（既有契约不变）", async () => {
    const { mgr, sessionId } = await setupChain();
    await expect(
      mgr.append(sessionId, null, { type: "user", payload: { text: "第二个根" } }),
    ).rejects.toThrow(/已存在根条目/);
  });

  test("登记是一次性的：消费后不复用（后续 createSession 走新建）", async () => {
    const { mgr, sessionId } = await setupChain();
    registerResumeTarget(sessionId);
    const reused = await mgr.createSession({ title: "续会话" });
    expect(reused.sessionId).toBe(sessionId);
    const fresh = await mgr.createSession({ title: "新会话" });
    expect(fresh.sessionId).not.toBe(sessionId);
  });
});
