import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BlobRef, BlobStoreOptions } from "./blob-store";
import { BlobStore, CorruptBlobError, sha256Hex } from "./blob-store";
import { EMPTY_SHA256, FileHistoryService, RecordNotFoundError } from "./file-history";
import type { SnapshotContext, SnapshotPhase } from "./file-history";

let dir: string | undefined;

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

/* ---------------------------------- 测试基建 ---------------------------------- */

async function makeDir(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "bi-file-history-"));
  return dir;
}

interface ServiceOpts {
  now?: () => number;
  persistIndex?: boolean;
  blobStore?: BlobStore;
  readFile?: (filePath: string) => Promise<Uint8Array>;
}

function makeService(d: string, opts: ServiceOpts = {}): FileHistoryService {
  return new FileHistoryService({
    rootDir: join(d, "history"),
    blobRoot: join(d, "blobs"),
    now: opts.now,
    persistIndex: opts.persistIndex,
    blobStore: opts.blobStore,
    readFile: opts.readFile,
  });
}

const CTX: SnapshotContext = { sessionId: "sess-bi032", turnId: "turn-1", phase: "edit" };

const UUID7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitUntil 超时");
    await sleep(5);
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 第一次 put 挂起在 gate 上的 BlobStore（并发互斥测试的确定性探针）。 */
class GatedBlobStore extends BlobStore {
  firstPutEntered = false;
  readonly #gate: Promise<void>;
  readonly #release: () => void;

  constructor(options: BlobStoreOptions) {
    super(options);
    let release!: () => void;
    this.#gate = new Promise<void>((res) => {
      release = res;
    });
    this.#release = release;
  }

  releaseFirstPut(): void {
    this.#release();
  }

  override async put(data: Uint8Array): Promise<BlobRef> {
    if (!this.firstPutEntered) {
      this.firstPutEntered = true;
      await this.#gate; // 模拟慢 IO：第一次 put 挂起
    }
    return super.put(data);
  }
}

/* ------------------------------ 快照 → 修改 → 还原 ------------------------------ */

describe("snapshotBefore → restore 字节级无损回滚", () => {
  test("中文 payload：快照→修改→还原字节级一致，SHA 断言链完整，记录形状正确", async () => {
    const d = await makeDir();
    const svc = makeService(d, { now: () => 1700000000000 });
    const f = join(d, "doc.txt");
    const original = Buffer.from("你好，世界\n第二行中文内容——回滚目标", "utf8");
    const modified = Buffer.from("modified: 已被工具改写", "utf8");

    await writeFile(f, original);
    const rec = await svc.snapshotBefore(f, CTX);

    expect(rec.id).toMatch(UUID7_PATTERN);
    expect(rec.sessionId).toBe("sess-bi032");
    expect(rec.turnId).toBe("turn-1");
    expect(rec.phase).toBe("edit");
    expect(rec.filePath).toBe(f); // 绝对路径登记
    expect(rec.byteSize).toBe(original.byteLength);
    expect(rec.priorSha256).toBe(sha256Hex(original));
    expect(rec.blobRef.sha256).toBe(rec.priorSha256); // 快照内容哈希恒等
    expect(rec.blobRef.byteSize).toBe(original.byteLength);
    expect(rec.createdAt).toBe(1700000000000);

    await writeFile(f, modified);
    const res = await svc.restore(rec.id);

    expect(res.recordId).toBe(rec.id);
    expect(res.filePath).toBe(f);
    expect(res.beforeSha256).toBe(sha256Hex(modified)); // 还原前 = 被改写内容
    expect(res.afterSha256).toBe(sha256Hex(original)); // 还原后 = 原内容
    expect(res.byteSize).toBe(original.byteLength);
    expect(Buffer.from(await readFile(f)).equals(original)).toBe(true); // 字节级精确还原
  });

  test("二进制 payload（全 256 字节值含 0x00/0xFF）：字节级往返一致", async () => {
    const d = await makeDir();
    const svc = makeService(d);
    const f = join(d, "bin.dat");
    const original = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const modified = Buffer.from([0xff, 0x00, 0x01, 0xfe]);

    await writeFile(f, original);
    const rec = await svc.snapshotBefore(f, { ...CTX, phase: "write" });
    await writeFile(f, modified);
    const res = await svc.restore(rec.id);

    expect(res.byteSize).toBe(256);
    expect(Buffer.from(await readFile(f)).equals(original)).toBe(true);
    expect(res.afterSha256).toBe(rec.priorSha256);
  });

  test("同内容两次快照：内容寻址去重，物理 blob 只有一份", async () => {
    const d = await makeDir();
    const svc = makeService(d);
    const f = join(d, "same.txt");
    await writeFile(f, "stable-content");

    const r1 = await svc.snapshotBefore(f, CTX);
    const r2 = await svc.snapshotBefore(f, { ...CTX, phase: "bash" });
    expect(r1.blobRef).toEqual(r2.blobRef);
    expect(await svc.blobStore.listBlobs()).toHaveLength(1);
  });

  test("blob 被篡改后 restore 抛 CorruptBlobError，目标文件保持不变", async () => {
    const d = await makeDir();
    const blobRoot = join(d, "blobs");
    const svc = makeService(d, { blobStore: new BlobStore({ rootDir: blobRoot }) });
    const f = join(d, "victim.txt");
    await writeFile(f, "original-bytes");
    const rec = await svc.snapshotBefore(f, CTX);
    await writeFile(f, "tampered-target");

    const blobPath = join(blobRoot, rec.blobRef.sha256.slice(0, 2), rec.blobRef.sha256);
    await writeFile(blobPath, "corrupted!!");

    await expect(svc.restore(rec.id)).rejects.toBeInstanceOf(CorruptBlobError);
    // 还原失败不污染目标文件
    expect((await readFile(f)).toString("utf8")).toBe("tampered-target");
  });

  test("还原不存在的记录 id 抛 RecordNotFoundError", async () => {
    const d = await makeDir();
    const svc = makeService(d);
    await expect(svc.restore("no-such-record")).rejects.toBeInstanceOf(RecordNotFoundError);
  });
});

/* ------------------------- created-before 空快照语义 ------------------------- */

describe("文件不存在时的快照与还原语义", () => {
  test("created-before：零字节空快照入仓，还原写回零字节（字节状态语义）", async () => {
    const d = await makeDir();
    const svc = makeService(d);
    const f = join(d, "not-yet.txt");

    const rec = await svc.snapshotBefore(f, CTX);
    expect(rec.byteSize).toBe(0);
    expect(rec.priorSha256).toBe(EMPTY_SHA256);
    expect(rec.blobRef.byteSize).toBe(0);
    expect(await svc.blobStore.has(rec.blobRef)).toBe(true); // 空内容同样入仓

    await writeFile(f, "tool created this file");
    const res = await svc.restore(rec.id);
    expect(res.beforeSha256).toBe(sha256Hex(Buffer.from("tool created this file", "utf8")));
    expect(res.afterSha256).toBe(EMPTY_SHA256);
    expect((await readFile(f)).byteLength).toBe(0); // 还原为零字节
  });

  test("还原时目标已被删除：beforeSha256 为 null，仍字节级写回", async () => {
    const d = await makeDir();
    const svc = makeService(d);
    const f = join(d, "gone.txt");
    await writeFile(f, "precious");
    const rec = await svc.snapshotBefore(f, CTX);
    await unlink(f);

    const res = await svc.restore(rec.id);
    expect(res.beforeSha256).toBeNull();
    expect(res.afterSha256).toBe(rec.priorSha256);
    expect((await readFile(f)).toString("utf8")).toBe("precious");
  });

  test("还原时目标目录缺失：自动补建目录后原子写回", async () => {
    const d = await makeDir();
    const svc = makeService(d);
    const f = join(d, "sub", "inner.txt");
    await mkdir(join(d, "sub"), { recursive: true });
    await writeFile(f, "inside-dir");
    const rec = await svc.snapshotBefore(f, CTX);
    await rm(join(d, "sub"), { recursive: true });

    const res = await svc.restore(rec.id);
    expect(res.afterSha256).toBe(rec.priorSha256);
    expect((await readFile(f)).toString("utf8")).toBe("inside-dir");
  });
});

/* ---------------------------------- 三维查询 ---------------------------------- */

describe("sessionId/turnId/filePath/phase 组合查询与 historyFor", () => {
  test("任意维度组合过滤，结果 createdAt 倒序", async () => {
    const d = await makeDir();
    const clock = { t: 1000 };
    const svc = makeService(d, { now: () => clock.t });
    const f1 = join(d, "one.txt");
    const f2 = join(d, "two.txt");

    const r1 = await svc.snapshotBefore(f1, { sessionId: "s1", turnId: "t1", phase: "edit" });
    clock.t = 1001;
    const r2 = await svc.snapshotBefore(f1, { sessionId: "s1", turnId: "t1", phase: "write" });
    clock.t = 1002;
    const r3 = await svc.snapshotBefore(f2, { sessionId: "s1", turnId: "t2", phase: "edit" });
    clock.t = 1003;
    const r4 = await svc.snapshotBefore(f1, { sessionId: "s2", turnId: "t3", phase: "edit" });

    expect((await svc.query()).map((r) => r.id)).toEqual([r4.id, r3.id, r2.id, r1.id]);
    expect((await svc.query({ sessionId: "s1" })).map((r) => r.id)).toEqual([r3.id, r2.id, r1.id]);
    expect((await svc.query({ sessionId: "s1", turnId: "t1" })).map((r) => r.id)).toEqual([
      r2.id,
      r1.id,
    ]);
    expect((await svc.query({ sessionId: "s1", turnId: "t1", phase: "edit" })).map((r) => r.id)).toEqual([r1.id]);
    expect((await svc.query({ filePath: f1 })).map((r) => r.id)).toEqual([r4.id, r2.id, r1.id]);
    expect((await svc.query({ phase: "write" })).map((r) => r.id)).toEqual([r2.id]);
    expect((await svc.query({ turnId: "t3" })).map((r) => r.id)).toEqual([r4.id]);
    expect(await svc.query({ sessionId: "no-such" })).toEqual([]);
  });

  test("historyFor：单文件全部快照 createdAt 倒序，同毫秒按 id 降序破平局；相对路径查询归一化命中", async () => {
    const d = await makeDir();
    const svc = makeService(d, { now: () => 1000 }); // 固定时钟：同毫秒
    const f = join(d, "target.txt");
    await writeFile(f, "v");
    const r1 = await svc.snapshotBefore(f, CTX);
    const r2 = await svc.snapshotBefore(f, CTX);
    const r3 = await svc.snapshotBefore(f, CTX);

    expect((await svc.historyFor(f)).map((r) => r.id)).toEqual([r3.id, r2.id, r1.id]);
    // 相对路径 / 含 . 的路径经 resolve 归一化后可命中同一文件
    expect((await svc.historyFor(join(d, "sub", "..", "target.txt"))).map((r) => r.id)).toEqual([
      r3.id,
      r2.id,
      r1.id,
    ]);
    expect(await svc.historyFor(join(d, "other.txt"))).toEqual([]);
  });

  test("getRecord：单条读取（返回副本，外部改动不影响索引）", async () => {
    const d = await makeDir();
    const svc = makeService(d);
    const f = join(d, "x.txt");
    await writeFile(f, "x");
    const rec = await svc.snapshotBefore(f, CTX);

    const got = await svc.getRecord(rec.id);
    expect(got?.id).toBe(rec.id);
    if (got) got.byteSize = -1; // 副本篡改
    expect((await svc.getRecord(rec.id))?.byteSize).toBe(rec.byteSize);
    expect(await svc.getRecord("missing")).toBeUndefined();
  });

  test("入参校验：空 sessionId/turnId、非法 phase、相对路径归一化登记", async () => {
    const d = await makeDir();
    const svc = makeService(d);
    const f = join(d, "v.txt");

    await expect(
      svc.snapshotBefore(f, { sessionId: "", turnId: "t", phase: "edit" }),
    ).rejects.toThrow("sessionId");
    await expect(
      svc.snapshotBefore(f, { sessionId: "s", turnId: "", phase: "edit" }),
    ).rejects.toThrow("turnId");
    await expect(
      svc.snapshotBefore(f, {
        sessionId: "s",
        turnId: "t",
        phase: "rm" as unknown as SnapshotPhase,
      }),
    ).rejects.toThrow("非法快照阶段");

    // 相对路径登记为 resolve 后的绝对路径，且查询可命中
    const rel = "bi-032-no-such-relative.txt";
    const rec = await svc.snapshotBefore(rel, CTX);
    expect(rec.filePath).toBe(resolve(rel));
    expect(rec.byteSize).toBe(0); // 相对路径在 cwd 下不存在 → created-before 空快照
    expect((await svc.historyFor(rel)).map((r) => r.id)).toEqual([rec.id]);
  });
});

/* --------------------------------- 保留策略 prune --------------------------------- */

describe("prune 保留策略与 blob 引用计数", () => {
  test("keepLastN：每文件保留最新 N 条；被剩余记录引用的 blob 存活，无引用 blob 清除", async () => {
    const d = await makeDir();
    const clock = { t: 1000 };
    const svc = makeService(d, { now: () => clock.t });
    const f1 = join(d, "f1.txt");
    const f2 = join(d, "f2.txt");

    await writeFile(f1, "X");
    const r1 = await svc.snapshotBefore(f1, { sessionId: "s", turnId: "t1", phase: "edit" });
    clock.t = 1001;
    await writeFile(f2, "X"); // 与 f1 同内容 → blob 去重共享
    const r2 = await svc.snapshotBefore(f2, { sessionId: "s", turnId: "t2", phase: "write" });
    clock.t = 1002;
    await writeFile(f1, "Y");
    const r3 = await svc.snapshotBefore(f1, { sessionId: "s", turnId: "t3", phase: "bash" });
    clock.t = 1003;
    await writeFile(f1, "Z");
    const r4 = await svc.snapshotBefore(f1, { sessionId: "s", turnId: "t4", phase: "edit" });

    const pruned = await svc.prune({ keepLastN: 1 });
    expect(pruned).toEqual({ removedRecords: 2, removedBlobs: 1 });
    expect((await svc.historyFor(f1)).map((r) => r.id)).toEqual([r4.id]);
    expect((await svc.historyFor(f2)).map((r) => r.id)).toEqual([r2.id]);

    // 引用计数：X 仍被存活的 r2 引用 → 存活；Y 无引用 → 清除；Z 被 r4 引用 → 存活
    const refOf = (r: { blobRef: BlobRef }) => r.blobRef;
    expect(await svc.blobStore.has(refOf(r1))).toBe(true);
    expect(await svc.blobStore.has(refOf(r3))).toBe(false);
    expect(await svc.blobStore.has(refOf(r4))).toBe(true);
  });

  test("olderThanMs：到期记录连同无引用 blob 清理，未到期存活", async () => {
    const d = await makeDir();
    const clock = { t: 1000 };
    const svc = makeService(d, { now: () => clock.t });
    const f = join(d, "aged.txt");

    await writeFile(f, "v1");
    await svc.snapshotBefore(f, { sessionId: "s", turnId: "t1", phase: "edit" });
    clock.t = 2000;
    await writeFile(f, "v2");
    await svc.snapshotBefore(f, { sessionId: "s", turnId: "t2", phase: "edit" });
    clock.t = 3000;
    await writeFile(f, "v3");
    const kept = await svc.snapshotBefore(f, { sessionId: "s", turnId: "t3", phase: "edit" });

    const pruned = await svc.prune({ olderThanMs: 500 }); // cutoff = 2500
    expect(pruned).toEqual({ removedRecords: 2, removedBlobs: 2 });
    expect((await svc.historyFor(f)).map((r) => r.id)).toEqual([kept.id]);
    expect(await svc.blobStore.listBlobs()).toHaveLength(1);
  });

  test("组合条件 OR：keepLastN 与 olderThanMs 任一命中即清理", async () => {
    const d = await makeDir();
    const clock = { t: 1000 };
    const svc = makeService(d, { now: () => clock.t });
    const f = join(d, "mix.txt");
    const ids: string[] = [];
    for (const v of ["v1", "v2", "v3", "v4"]) {
      await writeFile(f, v);
      const rec = await svc.snapshotBefore(f, { sessionId: "s", turnId: `t-${v}`, phase: "edit" });
      ids.push(rec.id);
      clock.t += 1000;
    }
    clock.t = 4000; // 记录 createdAt: 1000/2000/3000/4000
    const pruned = await svc.prune({ keepLastN: 2, olderThanMs: 2500 }); // cutoff = 1500
    // t=1000 太老（too old）；t=2000 超出 keepLastN（beyond keep）→ 各由一条策略命中
    expect(pruned).toEqual({ removedRecords: 2, removedBlobs: 2 });
    expect((await svc.historyFor(f)).map((r) => r.id)).toEqual(ids.slice(2).reverse());
  });

  test("prune 无策略参数或非法参数抛错", async () => {
    const d = await makeDir();
    const svc = makeService(d);
    await expect(svc.prune()).rejects.toThrow("至少一个保留策略条件");
    await expect(svc.prune({ keepLastN: 0 })).rejects.toThrow("keepLastN");
    await expect(svc.prune({ olderThanMs: -1 })).rejects.toThrow("olderThanMs");
  });
});

/* --------------------------------- 并发互斥 --------------------------------- */

describe("并发同文件快照互斥", () => {
  test("实例内队列串行：前序快照卡在 put 时，后续快照不进入读文件阶段", async () => {
    const d = await makeDir();
    const store = new GatedBlobStore({ rootDir: join(d, "blobs") });
    const script = [Buffer.from("v1", "utf8"), Buffer.from("v2", "utf8")];
    let reads = 0;
    const svc = makeService(d, {
      blobStore: store,
      readFile: async () => {
        const payload = script[reads] ?? Buffer.alloc(0);
        reads += 1;
        return payload;
      },
    });
    const f = join(d, "contended.txt");

    const p1 = svc.snapshotBefore(f, CTX);
    await waitUntil(() => store.firstPutEntered); // p1 已读取 v1 并卡在 put
    expect(reads).toBe(1);

    const p2 = svc.snapshotBefore(f, CTX);
    await sleep(30); // 给「无锁实现」留出竞态窗口
    expect(reads).toBe(1); // 互斥：p1 未完成前 p2 不得读文件

    store.releaseFirstPut();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.priorSha256).toBe(sha256Hex(script[0]!));
    expect(r2.priorSha256).toBe(sha256Hex(script[1]!));
    expect(reads).toBe(2);
  });
});

/* --------------------------------- 索引持久化 --------------------------------- */

describe("index.jsonl 持久化", () => {
  test("快照落索引（JSONL 每行一条），跨实例加载可查可还原", async () => {
    const d = await makeDir();
    const svc1 = makeService(d, { now: () => 1000 });
    const f = join(d, "persisted.txt");
    await writeFile(f, "v1");
    const r1 = await svc1.snapshotBefore(f, CTX);
    await writeFile(f, "v2");
    const r2 = await svc1.snapshotBefore(f, CTX);

    const raw = await readFile(svc1.indexPath, "utf8");
    const lines = raw.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)["id"]).toBe(r1.id);
    expect(JSON.parse(lines[1]!)["id"]).toBe(r2.id);

    const svc2 = makeService(d);
    expect((await svc2.historyFor(f)).map((r) => r.id)).toEqual([r2.id, r1.id]);
    const res = await svc2.restore(r1.id); // blob 共享，跨实例还原可用
    expect(res.afterSha256).toBe(r1.priorSha256);
    expect((await readFile(f)).toString("utf8")).toBe("v1");
  });

  test("索引中混入非法行：加载跳过非法行不拖垮（幂等续写安全）", async () => {
    const d = await makeDir();
    const svc1 = makeService(d);
    const f = join(d, "tolerant.txt");
    await writeFile(f, "data");
    const r1 = await svc1.snapshotBefore(f, CTX);
    await appendFile(svc1.indexPath, "this-line-is-not-json\n");

    const svc2 = makeService(d);
    expect((await svc2.historyFor(f)).map((r) => r.id)).toEqual([r1.id]);
  });

  test("persistIndex=false：纯内存模式不落索引，新实例看不到历史", async () => {
    const d = await makeDir();
    const svc1 = makeService(d, { persistIndex: false });
    const f = join(d, "memory-only.txt");
    await writeFile(f, "ephemeral");
    await svc1.snapshotBefore(f, CTX);

    expect(await fileExists(svc1.indexPath)).toBe(false);
    const svc2 = makeService(d); // 持久化开启的新实例
    expect(await svc2.historyFor(f)).toEqual([]);
  });

  test("prune 清理记录后索引同步重写，跨实例可见", async () => {
    const d = await makeDir();
    const svc1 = makeService(d, { now: () => 1000 });
    const f = join(d, "pruned.txt");
    await writeFile(f, "a");
    await svc1.snapshotBefore(f, CTX);
    await writeFile(f, "b");
    await svc1.snapshotBefore(f, CTX);
    await svc1.prune({ keepLastN: 1 });

    const svc2 = makeService(d);
    expect(await svc2.historyFor(f)).toHaveLength(1);
  });
});
