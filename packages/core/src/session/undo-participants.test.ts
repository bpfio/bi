import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "./blob-store";
import { FileHistoryService } from "./file-history";
import {
  DuplicateParticipantError,
  FileHistoryParticipant,
  UndoParticipantRegistry,
} from "./undo-participants";
import type {
  ContextUndoneEvent,
  UndoParticipant,
  UndoParticipantResult,
} from "./undo-participants";
import type { UndoCut } from "./undo-service";
import type { SessionEntry } from "./types";

let dir: string | undefined;

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

async function makeDir(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "bi-undo-participants-"));
  return dir;
}

const CUT: UndoCut = { cutEntryId: null, cutIndex: 0, undoneCount: 2 };

function makeEvent(overrides: Partial<ContextUndoneEvent> = {}): ContextUndoneEvent {
  return {
    sessionId: "sess-undo-p",
    cut: CUT,
    undoneEntries: [],
    undoneFileRecords: [],
    ...overrides,
  };
}

/** 恒等参与方：原样回执（总线/注册表测试用）。 */
function makeParticipant(id: string, result?: Partial<UndoParticipantResult>): UndoParticipant {
  return {
    id,
    onContextUndone: async () => ({ id, restored: [], errors: [], ...result }),
  };
}

/* ---------------------------- UndoParticipantRegistry ---------------------------- */

describe("UndoParticipantRegistry", () => {
  test("register/list 保持注册顺序，get 按 id 查找", () => {
    const registry = new UndoParticipantRegistry();
    const p1 = makeParticipant("p1");
    const p2 = makeParticipant("p2");
    registry.register(p1);
    registry.register(p2);
    expect(registry.list()).toEqual([p1, p2]);
    expect(registry.get("p2")).toBe(p2);
    expect(registry.get("nope")).toBeUndefined();
  });

  test("id 去重：同 id 重复注册抛 DuplicateParticipantError，列表不膨胀", () => {
    const registry = new UndoParticipantRegistry();
    registry.register(makeParticipant("dup"));
    expect(() => registry.register(makeParticipant("dup"))).toThrow(DuplicateParticipantError);
    expect(() => registry.register(makeParticipant("dup"))).toThrow("撤销参与方 id 已注册: dup");
    expect(registry.list()).toHaveLength(1);
  });

  test("unregister：存在返回 true 并移除，不存在返回 false", () => {
    const registry = new UndoParticipantRegistry();
    registry.register(makeParticipant("p1"));
    expect(registry.unregister("p1")).toBe(true);
    expect(registry.get("p1")).toBeUndefined();
    expect(registry.unregister("p1")).toBe(false);
  });
});

/* ---------------------------- FileHistoryParticipant ---------------------------- */

describe("FileHistoryParticipant", () => {
  test("按事件顺序逐条 restore：restored 明细含 recordId/filePath/beforeSha/afterSha，字节级还原", async () => {
    const d = await makeDir();
    const svc = new FileHistoryService({
      rootDir: join(d, "history"),
      blobRoot: join(d, "blobs"),
      now: () => 1700000000000,
    });
    const fileA = join(d, "a.txt");
    const fileB = join(d, "b.txt");
    const ctx = { sessionId: "sess-undo-p", turnId: "turn-1", phase: "edit" } as const;
    await writeFile(fileA, "A-v0");
    await writeFile(fileB, "B-w0");
    const recA = await svc.snapshotBefore(fileA, ctx);
    const recB = await svc.snapshotBefore(fileB, ctx);
    await writeFile(fileA, "A-v1");
    await writeFile(fileB, "B-w1");

    // 事件契约：undoneFileRecords 按 createdAt 降序（最新在前）。
    const participant = new FileHistoryParticipant(svc);
    const result = await participant.onContextUndone(
      makeEvent({ undoneFileRecords: [recB, recA] }),
    );

    expect(result.id).toBe("file-history");
    expect(result.errors).toEqual([]);
    expect(result.restored).toHaveLength(2);
    const [restoredB, restoredA] = result.restored;
    expect(restoredB).toEqual({
      recordId: recB.id,
      filePath: fileB,
      beforeSha: sha256Hex(Buffer.from("B-w1", "utf8")),
      afterSha: sha256Hex(Buffer.from("B-w0", "utf8")),
    });
    expect(restoredA).toEqual({
      recordId: recA.id,
      filePath: fileA,
      beforeSha: sha256Hex(Buffer.from("A-v1", "utf8")),
      afterSha: sha256Hex(Buffer.from("A-v0", "utf8")),
    });
    expect(await readFile(fileA, "utf8")).toBe("A-v0");
    expect(await readFile(fileB, "utf8")).toBe("B-w0");
  });

  test("隔离原则：单条 restore 失败逐项收进 errors，其余记录照常还原，不上抛", async () => {
    const d = await makeDir();
    const svc = new FileHistoryService({
      rootDir: join(d, "history"),
      blobRoot: join(d, "blobs"),
      now: () => 1700000000000,
    });
    const fileA = join(d, "a.txt");
    await writeFile(fileA, "A-v0");
    const recA = await svc.snapshotBefore(fileA, {
      sessionId: "sess-undo-p",
      turnId: "turn-1",
      phase: "edit",
    });
    await writeFile(fileA, "A-v1");

    // recGhost 不存在于索引 → 该条失败；recA 正常还原。
    const ghostRecord = { ...recA, id: "00000000-0000-7fff-8fff-000000000000" };
    const participant = new FileHistoryParticipant(svc);
    const result = await participant.onContextUndone(
      makeEvent({ undoneFileRecords: [ghostRecord, recA] }),
    );

    expect(result.restored).toHaveLength(1);
    expect(result.restored[0]?.recordId).toBe(recA.id);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.recordId).toBe(ghostRecord.id);
    expect(result.errors[0]?.message).toContain("文件历史记录不存在");
    expect(await readFile(fileA, "utf8")).toBe("A-v0"); // 未被失败条目拖累
  });

  test("restore 幂等语义：重复广播同批记录，文件终态不变", async () => {
    const d = await makeDir();
    const svc = new FileHistoryService({
      rootDir: join(d, "history"),
      blobRoot: join(d, "blobs"),
      now: () => 1700000000000,
    });
    const fileA = join(d, "a.txt");
    await writeFile(fileA, "A-v0");
    const recA = await svc.snapshotBefore(fileA, {
      sessionId: "sess-undo-p",
      turnId: "turn-1",
      phase: "edit",
    });
    await writeFile(fileA, "A-v1");
    const participant = new FileHistoryParticipant(svc);
    const event = makeEvent({ undoneFileRecords: [recA] });

    await participant.onContextUndone(event);
    expect(await readFile(fileA, "utf8")).toBe("A-v0");
    const second = await participant.onContextUndone(event);
    expect(second.errors).toEqual([]);
    expect(await readFile(fileA, "utf8")).toBe("A-v0"); // 同 blob 再写同字节
    expect(second.restored[0]?.afterSha).toBe(recA.priorSha256);
  });
});

/* ---------------------------------- 类型形状 ---------------------------------- */

describe("ContextUndoneEvent 形状", () => {
  test("事件携带 sessionId/cut/undoneEntries/undoneFileRecords 四要素", () => {
    const entry: SessionEntry = {
      id: "e1",
      parentId: null,
      type: "user",
      payload: { text: "问" },
      createdAt: 1700000000000,
      seq: 1,
    };
    const event = makeEvent({ undoneEntries: [entry] });
    expect(event.sessionId).toBe("sess-undo-p");
    expect(event.cut).toEqual(CUT);
    expect(event.undoneEntries).toEqual([entry]);
    expect(event.undoneFileRecords).toEqual([]);
  });
});
