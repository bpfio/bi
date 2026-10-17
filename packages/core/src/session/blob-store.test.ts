import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BlobNotFoundError,
  BlobStore,
  CorruptBlobError,
  defaultBlobsRoot,
  sha256Hex,
} from "./blob-store";

let dir: string | undefined;

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

/** 每个测试独立的临时 blob 根目录（绝不触碰真实 ~/.bi）。 */
async function makeStore(): Promise<{ store: BlobStore; root: string }> {
  dir = await mkdtemp(join(tmpdir(), "bi-blob-"));
  const root = join(dir, "blobs");
  return { store: new BlobStore({ rootDir: root }), root };
}

/** 递归枚举根目录下全部文件（相对路径，排序后返回）。 */
async function listFilesRec(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string): Promise<void> {
    const entries = await readdir(join(root, rel), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const childRel = rel.length === 0 ? entry.name : join(rel, entry.name);
      if (entry.isDirectory()) await walk(childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  }
  await walk("");
  return out.sort();
}

describe("BlobStore.put/get（内容寻址）", () => {
  test("put 后按 <sha 前 2 位>/<sha> 落盘，get 取回字节一致，meta 携带物理路径", async () => {
    const { store, root } = await makeStore();
    const data = Buffer.from("你好，blob 仓\nsecond line", "utf8");
    const ref = await store.put(data);

    expect(ref.sha256).toBe(sha256Hex(data));
    expect(ref.byteSize).toBe(data.byteLength);
    const files = await listFilesRec(root);
    expect(files).toEqual([`${ref.sha256.slice(0, 2)}/${ref.sha256}`]);

    const got = await store.get(ref);
    expect(Buffer.from(got).equals(data)).toBe(true);

    const meta = await store.meta(ref);
    expect(meta).toBeDefined();
    expect(meta?.path).toBe(join(root, ref.sha256.slice(0, 2), ref.sha256));
    expect(meta?.byteSize).toBe(data.byteLength);
    expect(await store.has(ref)).toBe(true);
  });

  test("内容寻址去重：两次同内容 put 只有一个物理 blob", async () => {
    const { store, root } = await makeStore();
    const data = Buffer.from("同内容去重 payload", "utf8");
    const r1 = await store.put(data);
    const r2 = await store.put(data);
    expect(r1).toEqual(r2);
    expect(await listFilesRec(root)).toHaveLength(1);

    const other = await store.put(Buffer.from("不同内容", "utf8"));
    expect(other.sha256).not.toBe(r1.sha256);
    expect(await listFilesRec(root)).toHaveLength(2);
  });

  test("二进制 payload（全 256 字节值含 0x00）字节级往返一致", async () => {
    const { store } = await makeStore();
    const data = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const ref = await store.put(data);
    const got = await store.get(ref);
    expect(Buffer.from(got).equals(data)).toBe(true);
  });

  test("空内容可入仓（created-before 空快照依赖此能力）", async () => {
    const { store } = await makeStore();
    const ref = await store.put(new Uint8Array(0));
    expect(ref.byteSize).toBe(0);
    expect(ref.sha256).toBe(sha256Hex(new Uint8Array(0)));
    expect(Buffer.from(await store.get(ref)).length).toBe(0);
  });

  test("不存在的 blob：get 抛 BlobNotFoundError（FileNotFoundError 语义），has 返回 false", async () => {
    const { store } = await makeStore();
    const ghost: { sha256: string; byteSize: number } = {
      sha256: "ab" + "0".repeat(62),
      byteSize: 0,
    };
    expect(await store.has(ghost)).toBe(false);
    expect(await store.meta(ghost)).toBeUndefined();
    await expect(store.get(ghost)).rejects.toBeInstanceOf(BlobNotFoundError);
  });
});

describe("BlobStore 完整性与安全", () => {
  test("blob 字节被篡改后 get 重算哈希抛 CorruptBlobError（期望/实际均结构化暴露）", async () => {
    const { store, root } = await makeStore();
    const ref = await store.put(Buffer.from("integrity-check", "utf8"));
    const blobPath = join(root, ref.sha256.slice(0, 2), ref.sha256);
    await writeFile(blobPath, Buffer.from("tampered-bytes!", "utf8"));

    try {
      await store.get(ref);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CorruptBlobError);
      const corrupt = error as CorruptBlobError;
      expect(corrupt.expected).toBe(ref.sha256);
      expect(corrupt.actual).toBe(sha256Hex(Buffer.from("tampered-bytes!", "utf8")));
    }
    // 篡改后 put 同内容仍命中存在性去重（信任模型：写入路径由原子性保证完整，
    // 外部篡改不在 put 时重读校验，一律在 get 时暴露）
    const hit = await store.put(Buffer.from("integrity-check", "utf8"));
    expect(hit.sha256).toBe(ref.sha256);
    await expect(store.get(hit)).rejects.toBeInstanceOf(CorruptBlobError);
  });

  test("非法 sha256 引用（路径穿越/大写/长度不符）被拒绝", async () => {
    const { store } = await makeStore();
    const evil = { sha256: "../evil", byteSize: 0 };
    await expect(store.get(evil)).rejects.toThrow("非法 blob 引用");
    await expect(store.has(evil)).rejects.toThrow("非法 blob 引用");
    await expect(store.get({ sha256: "AB" + "0".repeat(62), byteSize: 0 })).rejects.toThrow(
      "非法 blob 引用",
    );
    await expect(store.get({ sha256: "ab00", byteSize: 0 })).rejects.toThrow("非法 blob 引用");
  });
});

describe("BlobStore.listBlobs / delete", () => {
  test("listBlobs 枚举全部 blob（分片目录内，脏文件忽略），根目录缺失返回空", async () => {
    const { store, root } = await makeStore();
    expect(await store.listBlobs()).toEqual([]);

    const refs = [
      await store.put(Buffer.from("alpha", "utf8")),
      await store.put(Buffer.from("beta", "utf8")),
    ];
    await writeFile(join(root, "not-a-shard.txt"), "junk");
    const listed = await store.listBlobs();
    expect(listed).toHaveLength(2);
    expect(listed.map((r) => r.sha256).sort()).toEqual(refs.map((r) => r.sha256).sort());
    for (const ref of listed) expect(ref.byteSize).toBeGreaterThan(0);

    await rm(join(root, "not-a-shard.txt"));
    // 损坏文件（名字不合规范形）被过滤，不影响合法 blob 枚举
    await writeFile(join(root, refs[0]!.sha256.slice(0, 2), "garbage-name"), "junk");
    expect((await store.listBlobs()).map((r) => r.sha256)).toEqual(
      [refs[0]!.sha256, refs[1]!.sha256],
    );
  });

  test("delete：删除返回 true，重复删除返回 false，物理文件消失", async () => {
    const { store, root } = await makeStore();
    const ref = await store.put(Buffer.from("to-be-deleted", "utf8"));
    expect(await store.delete(ref)).toBe(true);
    expect(await store.has(ref)).toBe(false);
    expect(await store.delete(ref)).toBe(false);
    expect(await listFilesRec(root)).toEqual([]);
  });
});

describe("BlobStore 默认根目录", () => {
  test("defaultBlobsRoot 解析到 ~/.bi/blobs（不创建、不触碰）", () => {
    expect(defaultBlobsRoot()).toContain(".bi");
    expect(defaultBlobsRoot().endsWith("blobs")).toBe(true);
  });
});
