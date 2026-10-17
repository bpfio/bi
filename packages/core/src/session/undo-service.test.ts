import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore, sha256Hex } from "./blob-store";
import { FileHistoryService } from "./file-history";
import type { FileHistoryRecord } from "./file-history";
import { SessionManager, SessionNotFoundError } from "./manager";
import { FileHistoryParticipant, UndoParticipantRegistry } from "./undo-participants";
import type { ContextUndoneEvent, UndoParticipant } from "./undo-participants";
import { AgentConversationUndoService, UndoCutError, computeUndoCut } from "./undo-service";
import type { SessionEntry, SessionEntryType } from "./types";

let dir: string | undefined;

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

/* ---------------------------------- 测试基建 ---------------------------------- */

/** 纯内存条目工厂（computeUndoCut 矩阵用；parentId 与 undo 无关）。 */
function entryOf(id: string, type: SessionEntryType, seq: number): SessionEntry {
  return { id, parentId: null, type, payload: null, createdAt: 1700000000000 + seq, seq };
}

function cutErrorOf(fn: () => unknown): UndoCutError {
  try {
    fn();
  } catch (error) {
    if (error instanceof UndoCutError) return error;
    throw error;
  }
  throw new Error("预期抛出 UndoCutError，但未抛错");
}

/** 自增注入时钟：每次读取 +10ms，时间戳严格单调（append/snapshot 调用序即时间序）。 */
function makeClock(): { now: () => number } {
  let t = 1700000000000;
  return { now: () => (t += 10) };
}

interface Rig {
  d: string;
  sessionManager: SessionManager;
  fileHistory: FileHistoryService;
  registry: UndoParticipantRegistry;
  service: AgentConversationUndoService;
}

/** 真实组装 SessionManager + BlobStore + FileHistoryService + 服务（全临时目录）。
 * 组合发生在组装方：默认注册 FileHistoryParticipant；总线专项测试可关闭。 */
async function makeRig(opts: { registerFileParticipant?: boolean } = {}): Promise<Rig> {
  dir = await mkdtemp(join(tmpdir(), "bi-undo-service-"));
  const d = dir;
  const clock = makeClock();
  const sessionManager = new SessionManager({ rootDir: join(d, "sessions"), now: clock.now });
  const blobStore = new BlobStore({ rootDir: join(d, "blobs") });
  const fileHistory = new FileHistoryService({
    rootDir: join(d, "history"),
    blobStore,
    now: clock.now,
  });
  const registry = new UndoParticipantRegistry();
  if (opts.registerFileParticipant ?? true) {
    registry.register(new FileHistoryParticipant(fileHistory));
  }
  const service = new AgentConversationUndoService({ sessionManager, registry, fileHistory });
  return { d, sessionManager, fileHistory, registry, service };
}

interface TurnOutcome {
  user: SessionEntry;
  toolCall: SessionEntry;
  toolResult: SessionEntry;
  record: FileHistoryRecord;
}

/** 模拟一轮「用户消息 → 写前快照 → 工具改写文件 → tool_call/tool_result」。
 * 各操作的注入时钟按调用序自增，时间戳严格递增且全局可比。 */
async function appendTurn(
  rig: Rig,
  sessionId: string,
  parentId: string | null,
  opts: { text: string; file: string; newContent: string },
): Promise<TurnOutcome> {
  const user = await rig.sessionManager.append(sessionId, parentId, {
    type: "user",
    payload: { text: opts.text },
  });
  const record = await rig.fileHistory.snapshotBefore(opts.file, {
    sessionId,
    turnId: user.id,
    phase: "edit",
  });
  await writeFile(opts.file, opts.newContent, "utf8");
  const toolCall = await rig.sessionManager.append(sessionId, user.id, {
    type: "tool_call",
    payload: { tool: "edit", file: opts.file },
    toolCallId: `${user.id}:tc`,
    toolName: "edit",
  });
  const toolResult = await rig.sessionManager.append(sessionId, toolCall.id, {
    type: "tool_result",
    payload: { ok: true },
    toolCallId: `${user.id}:tc`,
  });
  return { user, toolCall, toolResult, record };
}

async function countJsonlLines(rig: Rig, sessionId: string): Promise<number> {
  const raw = await readFile(join(rig.sessionManager.rootDir, `${sessionId}.jsonl`), "utf8");
  return raw.split("\n").filter((line) => line.length > 0).length;
}

/** 记录广播的探针参与方。 */
function makeSpy(id: string, sink: ContextUndoneEvent[]): UndoParticipant {
  return {
    id,
    onContextUndone: async (event) => {
      sink.push(event);
      return { id, restored: [], errors: [] };
    },
  };
}

/* ------------------------------ computeUndoCut 矩阵 ------------------------------ */

describe("computeUndoCut 矩阵", () => {
  test("N=1：切点 = 倒数第 1 个 user 之前，该 user 及其后全部 undone", () => {
    const entries = [
      entryOf("u1", "user", 1),
      entryOf("a1", "assistant", 2),
      entryOf("u2", "user", 3),
      entryOf("a2", "assistant", 4),
    ];
    expect(computeUndoCut(entries, 1)).toEqual({
      cutEntryId: "a1",
      cutIndex: 2,
      undoneCount: 2,
    });
  });

  test("N=2（等于 user 轮数）：切掉全部 user 轮，首条即 user → 无保留条目（cutEntryId=null）", () => {
    const entries = [
      entryOf("u1", "user", 1),
      entryOf("a1", "assistant", 2),
      entryOf("u2", "user", 3),
      entryOf("a2", "assistant", 4),
    ];
    expect(computeUndoCut(entries, 2)).toEqual({
      cutEntryId: null,
      cutIndex: 0,
      undoneCount: 4,
    });
  });

  test("跨多 user 轮：3 轮会话 N=2 → 保留第 1 轮，撤销后 2 轮", () => {
    const entries = [
      entryOf("u1", "user", 1),
      entryOf("a1", "assistant", 2),
      entryOf("u2", "user", 3),
      entryOf("a2", "assistant", 4),
      entryOf("u3", "user", 5),
      entryOf("a3", "assistant", 6),
    ];
    expect(computeUndoCut(entries, 2)).toEqual({
      cutEntryId: "a1",
      cutIndex: 2,
      undoneCount: 4,
    });
  });

  test("N 大于总 user 轮数 → 整会话撤销（全撤到根：cutEntryId=null/cutIndex=0/全量）", () => {
    const entries = [
      entryOf("u1", "user", 1),
      entryOf("a1", "assistant", 2),
      entryOf("u2", "user", 3),
      entryOf("a2", "assistant", 4),
      entryOf("u3", "user", 5),
      entryOf("a3", "assistant", 6),
    ];
    expect(computeUndoCut(entries, 4)).toEqual({ cutEntryId: null, cutIndex: 0, undoneCount: 6 });
    expect(computeUndoCut(entries, 99)).toEqual({ cutEntryId: null, cutIndex: 0, undoneCount: 6 });
  });

  test("无 user 条目：N 超过 0 轮 → 整会话撤销（非 user 条目一并全撤）", () => {
    const entries = [entryOf("s1", "system", 1), entryOf("a1", "assistant", 2)];
    expect(computeUndoCut(entries, 1)).toEqual({ cutEntryId: null, cutIndex: 0, undoneCount: 2 });
  });

  test("非 user 类型不影响计数：system 穿插与尾部 system 只跟随区间", () => {
    const withSystem = [
      entryOf("s0", "system", 1),
      entryOf("u1", "user", 2),
      entryOf("a1", "assistant", 3),
      entryOf("u2", "user", 4),
    ];
    expect(computeUndoCut(withSystem, 1)).toEqual({
      cutEntryId: "a1",
      cutIndex: 3,
      undoneCount: 1,
    });
    const trailingSystem = [entryOf("u1", "user", 1), entryOf("u2", "user", 2), entryOf("s2", "system", 3)];
    expect(computeUndoCut(trailingSystem, 1)).toEqual({
      cutEntryId: "u1",
      cutIndex: 1,
      undoneCount: 2,
    });
  });

  test("空会话 → 结构化错误（code=empty-session）", () => {
    const error = cutErrorOf(() => computeUndoCut([], 1));
    expect(error.code).toBe("empty-session");
  });

  test("n 非法（0/负数/非整数/NaN）→ 结构化错误（code=invalid-n）", () => {
    const entries = [entryOf("u1", "user", 1)];
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const error = cutErrorOf(() => computeUndoCut(entries, bad));
      expect(error.code).toBe("invalid-n");
    }
  });
});

/* ------------------------------ 服务级错误与装配 ------------------------------ */

describe("AgentConversationUndoService 错误路径", () => {
  test("会话不存在 → SessionNotFoundError 原样上抛", async () => {
    const rig = await makeRig();
    await expect(rig.service.undo("sess-missing-1", 1)).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  test("空会话（仅 meta 无条目）→ UndoCutError（empty-session）", async () => {
    const rig = await makeRig();
    const meta = await rig.sessionManager.createSession({ title: "空会话" });
    try {
      await rig.service.undo(meta.sessionId, 1);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UndoCutError);
      expect((error as UndoCutError).code).toBe("empty-session");
    }
  });

  test("n 非法经服务透传 → UndoCutError（invalid-n）", async () => {
    const rig = await makeRig();
    const meta = await rig.sessionManager.createSession({ title: "x" });
    const u1 = await rig.sessionManager.append(meta.sessionId, null, {
      type: "user",
      payload: { text: "问" },
    });
    await rig.sessionManager.append(meta.sessionId, u1.id, {
      type: "assistant",
      payload: { text: "答" },
    });
    try {
      await rig.service.undo(meta.sessionId, 0);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UndoCutError);
      expect((error as UndoCutError).code).toBe("invalid-n");
    }
  });
});

/* ---------------------------------- 端到端流 ---------------------------------- */

describe("AgentConversationUndoService 端到端", () => {
  test("undo(1)：文件字节级回到上一版 + 会话游标正确 + 物理记录零删除", async () => {
    const rig = await makeRig();
    const f = join(rig.d, "doc.txt");
    await writeFile(f, "v0", "utf8");
    const meta = await rig.sessionManager.createSession({ title: "undo-e2e" });
    const sid = meta.sessionId;
    const t1 = await appendTurn(rig, sid, null, { text: "第1轮", file: f, newContent: "v1" });
    const t2 = await appendTurn(rig, sid, t1.toolResult.id, {
      text: "第2轮",
      file: f,
      newContent: "v2",
    });
    const linesBefore = await countJsonlLines(rig, sid); // meta + 6 entries

    const result = await rig.service.undo(sid, 1);

    expect(result.noop).toBeUndefined();
    expect(result.sessionId).toBe(sid);
    expect(result.cut).toEqual({
      cutEntryId: t1.toolResult.id,
      cutIndex: 3,
      undoneCount: 3,
    });
    expect(result.cursor).toEqual({
      sessionId: sid,
      nodeId: t1.toolResult.id,
      nextParentId: t1.toolResult.id,
      pathLength: 3,
      totalEntries: 6,
    });
    // 字节级回到上一版（第 2 轮编辑前的状态）
    expect(await readFile(f, "utf8")).toBe("v1");
    // 参与方结果：只还原撤销窗口内（第 2 轮）的快照
    const fhResult = result.participants.find((p) => p.id === "file-history");
    expect(fhResult).toBeDefined();
    expect(fhResult?.errors).toEqual([]);
    expect(fhResult?.restored).toEqual([
      {
        recordId: t2.record.id,
        filePath: f,
        beforeSha: sha256Hex(Buffer.from("v2", "utf8")),
        afterSha: sha256Hex(Buffer.from("v1", "utf8")),
      },
    ]);
    // 物理记录永不删除：jsonl 行数不变，entries() 仍读回全量 6 条
    expect(await countJsonlLines(rig, sid)).toBe(linesBefore);
    expect(await rig.sessionManager.entries(sid)).toHaveLength(6);
  });

  test("undo(2) 跨两轮级联还原两文件（全撤语义：cutEntryId=null，cursor=null）", async () => {
    const rig = await makeRig();
    const fileA = join(rig.d, "a.txt");
    const fileB = join(rig.d, "b.txt");
    await writeFile(fileA, "A-v0", "utf8");
    await writeFile(fileB, "B-w0", "utf8");
    const meta = await rig.sessionManager.createSession({ title: "undo-two-files" });
    const sid = meta.sessionId;
    const t1 = await appendTurn(rig, sid, null, { text: "改A", file: fileA, newContent: "A-v1" });
    const t2 = await appendTurn(rig, sid, t1.toolResult.id, {
      text: "改B",
      file: fileB,
      newContent: "B-w1",
    });

    const result = await rig.service.undo(sid, 2);

    expect(result.cut).toEqual({ cutEntryId: null, cutIndex: 0, undoneCount: 6 });
    expect(result.cursor).toBeNull(); // 全撤到根：无保留节点
    expect(await readFile(fileA, "utf8")).toBe("A-v0");
    expect(await readFile(fileB, "utf8")).toBe("B-w0");
    const fhResult = result.participants.find((p) => p.id === "file-history");
    expect(fhResult?.restored.map((item) => item.recordId)).toEqual([t2.record.id, t1.record.id]);
    expect(fhResult?.errors).toEqual([]);
  });

  test("undo(2) 部分级联：3 轮改同一文件，按快照降序还原，终态 = 切点时刻版本", async () => {
    const rig = await makeRig();
    const f = join(rig.d, "seq.txt");
    await writeFile(f, "v0", "utf8");
    const meta = await rig.sessionManager.createSession({ title: "undo-cascade" });
    const sid = meta.sessionId;
    const t1 = await appendTurn(rig, sid, null, { text: "轮1", file: f, newContent: "v1" });
    const t2 = await appendTurn(rig, sid, t1.toolResult.id, { text: "轮2", file: f, newContent: "v2" });
    const t3 = await appendTurn(rig, sid, t2.toolResult.id, { text: "轮3", file: f, newContent: "v3" });

    const result = await rig.service.undo(sid, 2);

    expect(result.cut).toEqual({ cutEntryId: t1.toolResult.id, cutIndex: 3, undoneCount: 6 });
    expect(result.cursor?.pathLength).toBe(3);
    // 第 1 轮快照在窗口外（早于切点），不参与还原
    const fhResult = result.participants.find((p) => p.id === "file-history");
    expect(fhResult?.restored.map((item) => item.recordId)).toEqual([t3.record.id, t2.record.id]);
    // 降序还原后终态 = 最早窗口快照内容 = 切点时刻版本 v1
    expect(await readFile(f, "utf8")).toBe("v1");
  });

  test("幂等：同参数重复 undo → noop 短路，文件不再变动，不重复广播", async () => {
    const rig = await makeRig();
    const f = join(rig.d, "doc.txt");
    await writeFile(f, "v0", "utf8");
    const meta = await rig.sessionManager.createSession({ title: "undo-idempotent" });
    const sid = meta.sessionId;
    const broadcasts: ContextUndoneEvent[] = [];
    rig.registry.register(makeSpy("spy", broadcasts));
    const t1 = await appendTurn(rig, sid, null, { text: "第1轮", file: f, newContent: "v1" });
    const t2 = await appendTurn(rig, sid, t1.toolResult.id, {
      text: "第2轮",
      file: f,
      newContent: "v2",
    });
    const linesAfterFirstAppend = await countJsonlLines(rig, sid);

    const first = await rig.service.undo(sid, 1);
    expect(first.noop).toBeUndefined();
    expect(broadcasts).toHaveLength(1);
    expect(await readFile(f, "utf8")).toBe("v1");

    const second = await rig.service.undo(sid, 1);
    expect(second.noop).toBe(true);
    expect(second.participants).toEqual([]);
    expect(second.cursor).toBeNull();
    expect(second.cut).toEqual(first.cut);
    expect(broadcasts).toHaveLength(1); // 未重复广播
    expect(await readFile(f, "utf8")).toBe("v1"); // 文件不再变动
    expect(await countJsonlLines(rig, sid)).toBe(linesAfterFirstAppend); // 物理零写入
    expect(t2.record.id).toBeTruthy(); // 保持引用完整性（防误删字段）
  });

  test("撤销加深：undo(1) 后 undo(2) 只广播新增条目，级联还原到窗口最早快照", async () => {
    const rig = await makeRig();
    const f = join(rig.d, "doc.txt");
    await writeFile(f, "v0", "utf8");
    const meta = await rig.sessionManager.createSession({ title: "undo-deepen" });
    const sid = meta.sessionId;
    const broadcasts: ContextUndoneEvent[] = [];
    rig.registry.register(makeSpy("spy", broadcasts));
    const t1 = await appendTurn(rig, sid, null, { text: "第1轮", file: f, newContent: "v1" });
    const t2 = await appendTurn(rig, sid, t1.toolResult.id, {
      text: "第2轮",
      file: f,
      newContent: "v2",
    });

    await rig.service.undo(sid, 1);
    expect(await readFile(f, "utf8")).toBe("v1");

    const deepened = await rig.service.undo(sid, 2);
    expect(deepened.noop).toBeUndefined();
    expect(deepened.cut).toEqual({ cutEntryId: null, cutIndex: 0, undoneCount: 6 });
    expect(deepened.cursor).toBeNull();
    // 只广播新增撤销部分（第 1 轮的 3 条），已撤销的第 2 轮不重复进事件
    expect(broadcasts).toHaveLength(2);
    expect(broadcasts[1]?.undoneEntries.map((entry) => entry.id)).toEqual([
      t1.user.id,
      t1.toolCall.id,
      t1.toolResult.id,
    ]);
    expect(broadcasts[1]?.undoneFileRecords.map((record) => record.id)).toEqual([
      t2.record.id,
      t1.record.id,
    ]);
    const fhResult = deepened.participants.find((p) => p.id === "file-history");
    expect(fhResult?.restored.map((item) => item.recordId)).toEqual([t2.record.id, t1.record.id]);
    expect(await readFile(f, "utf8")).toBe("v0"); // 级联回到最初版本
  });

  test("撤销后沿游标继续会话：新分支参与后续 undo，废弃分支退出切点计算", async () => {
    const rig = await makeRig();
    const f = join(rig.d, "doc.txt");
    await writeFile(f, "v0", "utf8");
    const meta = await rig.sessionManager.createSession({ title: "undo-continue" });
    const sid = meta.sessionId;
    const t1 = await appendTurn(rig, sid, null, { text: "第1轮", file: f, newContent: "v1" });
    const t2 = await appendTurn(rig, sid, t1.toolResult.id, {
      text: "第2轮",
      file: f,
      newContent: "v2",
    });
    const linesBefore = await countJsonlLines(rig, sid);

    const undone = await rig.service.undo(sid, 1);
    expect(await countJsonlLines(rig, sid)).toBe(linesBefore); // undo 零物理写入

    // 沿 cursor.nextParentId 开新分支继续对话（第 3 轮，不改文件）
    const u3 = await rig.sessionManager.append(sid, undone.cursor?.nextParentId ?? null, {
      type: "user",
      payload: { text: "第3轮" },
    });
    expect(await countJsonlLines(rig, sid)).toBe(linesBefore + 1); // 只增不减
    expect(await rig.sessionManager.entries(sid)).toHaveLength(7); // 废弃分支仍在盘上

    const second = await rig.service.undo(sid, 1);
    expect(second.noop).toBeUndefined();
    // 活跃路径 [u1,tc1,tr1,u3]：倒数第 1 个 user = u3
    expect(second.cut).toEqual({ cutEntryId: t1.toolResult.id, cutIndex: 3, undoneCount: 1 });
    expect(second.participants.find((p) => p.id === "file-history")?.restored).toEqual([]);
    expect(u3.parentId).toBe(t1.toolResult.id);
  });
});

/* ---------------------------------- 参与者总线 ---------------------------------- */

describe("参与者总线", () => {
  test("多参与方串行广播：注册顺序即执行顺序，前序完成才启动后续", async () => {
    const rig = await makeRig({ registerFileParticipant: false });
    const meta = await rig.sessionManager.createSession({ title: "bus-order" });
    const sid = meta.sessionId;
    const u1 = await rig.sessionManager.append(sid, null, { type: "user", payload: { text: "问1" } });
    const a1 = await rig.sessionManager.append(sid, u1.id, { type: "assistant", payload: { text: "答1" } });
    const u2 = await rig.sessionManager.append(sid, a1.id, { type: "user", payload: { text: "问2" } });
    await rig.sessionManager.append(sid, u2.id, { type: "assistant", payload: { text: "答2" } });

    const trace: string[] = [];
    const received: ContextUndoneEvent[] = [];
    const mk = (id: string): UndoParticipant => ({
      id,
      onContextUndone: async (event) => {
        trace.push(`start:${id}`);
        received.push(event);
        await Promise.resolve(); // 让出微任务：若总线并行，start 会先于 end 全部出现
        trace.push(`end:${id}`);
        return { id, restored: [], errors: [] };
      },
    });
    rig.registry.register(mk("p1"));
    rig.registry.register(mk("p2"));
    rig.registry.register(mk("p3"));

    const result = await rig.service.undo(sid, 1);

    expect(trace).toEqual(["start:p1", "end:p1", "start:p2", "end:p2", "start:p3", "end:p3"]);
    expect(result.participants.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
    // 同一事件对象广播给全部参与方；未注入 fileHistory 端口时快照列表为空
    expect(received).toHaveLength(3);
    expect(received[0]).toBe(received[1]);
    expect(received[1]).toBe(received[2]);
    expect(received[0]?.undoneFileRecords).toEqual([]);
    expect(received[0]?.undoneEntries).toHaveLength(2);
  });

  test("单参与方抛错被总线隔离：合成错误结果，其余参与方照常执行", async () => {
    const rig = await makeRig({ registerFileParticipant: false });
    const meta = await rig.sessionManager.createSession({ title: "bus-isolation" });
    const sid = meta.sessionId;
    const u1 = await rig.sessionManager.append(sid, null, { type: "user", payload: { text: "问1" } });
    const a1 = await rig.sessionManager.append(sid, u1.id, { type: "assistant", payload: { text: "答1" } });
    const u2 = await rig.sessionManager.append(sid, a1.id, { type: "user", payload: { text: "问2" } });
    await rig.sessionManager.append(sid, u2.id, { type: "assistant", payload: { text: "答2" } });

    let goodSawEvent = false;
    rig.registry.register({
      id: "boom",
      onContextUndone: async () => {
        throw new Error("参与方内部爆炸");
      },
    });
    rig.registry.register({
      id: "good",
      onContextUndone: async (event) => {
        goodSawEvent = true;
        void event;
        return { id: "good", restored: [], errors: [] };
      },
    });

    const result = await rig.service.undo(sid, 1); // 不上抛

    expect(goodSawEvent).toBe(true);
    expect(result.participants).toHaveLength(2);
    expect(result.participants[0]).toEqual({
      id: "boom",
      restored: [],
      errors: [{ recordId: null, message: "参与方内部爆炸" }],
    });
    expect(result.participants[1]?.id).toBe("good");
    expect(result.participants[1]?.errors).toEqual([]);
    expect(result.cursor?.nodeId).toBe(a1.id); // rewind 照常完成
  });

  test("未注入 fileHistory 端口：事件快照列表为空，FileHistoryParticipant 无事可做", async () => {
    dir = await mkdtemp(join(tmpdir(), "bi-undo-noport-"));
    const d = dir;
    const sessionManager = new SessionManager({ rootDir: join(d, "sessions") });
    const registry = new UndoParticipantRegistry();
    const service = new AgentConversationUndoService({ sessionManager, registry });
    registry.register(new FileHistoryParticipant(new FileHistoryService({ persistIndex: false })));

    const meta = await sessionManager.createSession({ title: "no-port" });
    const u1 = await sessionManager.append(meta.sessionId, null, { type: "user", payload: { text: "问1" } });
    await sessionManager.append(meta.sessionId, u1.id, { type: "assistant", payload: { text: "答1" } });

    const result = await service.undo(meta.sessionId, 1);
    expect(result.participants[0]).toEqual({ id: "file-history", restored: [], errors: [] });
    expect(result.cut.undoneCount).toBe(2);
  });
});
