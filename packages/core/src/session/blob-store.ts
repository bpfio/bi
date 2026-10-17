/**
 * 内容寻址二进制仓（BI-03.2）：`BlobStore`。
 *
 * 存储布局：`<rootDir>/<sha256 前 2 位>/<sha256>`，路径根可注入
 * （默认 ~/.bi/blobs，测试必须注入临时目录）。内容寻址天然去重：
 * 同内容只存一份；写入走 `atomicWriteFile`（临时文件 + rename）保证原子性，
 * 因此「路径上已存在的 blob」必然是完整写入的（不会读到半截数据）。
 *
 * 完整性：`get` 时重算 SHA-256 与引用比对，不符抛 `CorruptBlobError`，
 * 引用的 blob 文件缺失抛 `BlobNotFoundError`（FileNotFoundError 语义）。
 * 查重（put 命中）只做存在性检查、不重读校验——写入路径由原子性保证完整，
 * 外部篡改一律在 get 时暴露。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "../utils/atomic-write";

/** blob 存储根目录默认值：~/.bi/blobs。 */
export function defaultBlobsRoot(): string {
  return join(homedir(), ".bi", "blobs");
}

/** SHA-256 十六进制小写规范形（64 位）；同时充当路径安全白名单（防路径穿越）。 */
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** 内容寻址引用：SHA-256 摘要 + 字节数。 */
export interface BlobRef {
  /** 内容 SHA-256（小写十六进制，64 字符）。 */
  sha256: string;
  /** 内容字节数。 */
  byteSize: number;
}

/** 已落盘 blob 的元数据。 */
export interface BlobMeta extends BlobRef {
  /** 物理存储路径（<rootDir>/<sha 前 2 位>/<sha>）。 */
  path: string;
}

/** blob 完整性校验失败（get 时重算哈希与引用不符）。 */
export class CorruptBlobError extends Error {
  /** 期望的内容哈希（即引用中的 sha256）。 */
  readonly expected: string;
  /** 实际计算出的哈希。 */
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super(`blob 完整性校验失败: sha256 期望 ${expected}，实际 ${actual}`);
    this.name = "CorruptBlobError";
    this.expected = expected;
    this.actual = actual;
  }
}

/** 引用的 blob 文件不存在（FileNotFoundError / ENOENT 语义）。 */
export class BlobNotFoundError extends Error {
  readonly sha256: string;

  constructor(sha256: string) {
    super(`blob 不存在: sha256=${sha256}`);
    this.name = "BlobNotFoundError";
    this.sha256 = sha256;
  }
}

export interface BlobStoreOptions {
  /** 存储根目录；默认 ~/.bi/blobs。测试必须注入临时目录。 */
  rootDir?: string;
}

/** 计算数据的 SHA-256（小写十六进制）。 */
export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function assertSha256(sha256: string): void {
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error(`非法 blob 引用（须为 64 位小写十六进制）: ${JSON.stringify(sha256)}`);
  }
}

/** 内容寻址二进制仓：同内容只存一份，写入原子，读取校验。 */
export class BlobStore {
  readonly #rootDir: string;

  constructor(options: BlobStoreOptions = {}) {
    this.#rootDir = options.rootDir ?? defaultBlobsRoot();
  }

  /** 存储根目录（测试与上层工具用）。 */
  get rootDir(): string {
    return this.#rootDir;
  }

  /** blob 物理路径；sha256 格式非法直接抛错（防路径穿越）。 */
  pathFor(ref: BlobRef): string {
    assertSha256(ref.sha256);
    return join(this.#rootDir, ref.sha256.slice(0, 2), ref.sha256);
  }

  /**
   * 写入内容：写前先查重，命中直接返回引用（不重复落盘）。
   * 未命中时先建分片目录再经 atomicWriteFile 原子写入。
   * 并发同内容 put 至多产生重复的原子 rename（内容相同，结果一致），无半截数据。
   */
  async put(data: Uint8Array): Promise<BlobRef> {
    const ref: BlobRef = { sha256: sha256Hex(data), byteSize: data.byteLength };
    const path = this.pathFor(ref);
    const exists = await this.has(ref);
    if (exists) return ref;
    await mkdir(join(this.#rootDir, ref.sha256.slice(0, 2)), { recursive: true });
    await atomicWriteFile(path, data);
    return ref;
  }

  /** 取回内容并校验完整性：重算 SHA-256 与引用不符抛 CorruptBlobError，文件缺失抛 BlobNotFoundError。 */
  async get(ref: BlobRef): Promise<Uint8Array> {
    let buf: Buffer;
    try {
      buf = await readFile(this.pathFor(ref));
    } catch (error) {
      if (isErrno(error, "ENOENT")) throw new BlobNotFoundError(ref.sha256);
      throw error;
    }
    const actual = sha256Hex(buf);
    if (actual !== ref.sha256) {
      throw new CorruptBlobError(ref.sha256, actual);
    }
    return buf;
  }

  /** 是否已有该内容的 blob（仅存在性检查，不校验内容）。 */
  async has(ref: BlobRef): Promise<boolean> {
    try {
      await stat(this.pathFor(ref));
      return true;
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }
  }

  /** blob 元数据；不存在返回 undefined。 */
  async meta(ref: BlobRef): Promise<BlobMeta | undefined> {
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(this.pathFor(ref));
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
    return { sha256: ref.sha256, byteSize: st.size, path: this.pathFor(ref) };
  }

  /** 删除 blob 文件；不存在返回 false，成功删除返回 true（供保留策略清理无引用 blob）。 */
  async delete(ref: BlobRef): Promise<boolean> {
    try {
      await unlink(this.pathFor(ref));
      return true;
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }
  }

  /**
   * 枚举仓内全部 blob（分片目录与文件名均按规范形过滤，脏文件忽略）。
   * 根目录不存在返回 []。
   */
  async listBlobs(): Promise<BlobRef[]> {
    let shards: string[];
    try {
      shards = await readdir(this.#rootDir);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }
    const refs: BlobRef[] = [];
    for (const shard of shards.sort()) {
      if (!/^[0-9a-f]{2}$/.test(shard)) continue;
      let names: string[];
      try {
        names = await readdir(join(this.#rootDir, shard));
      } catch (error) {
        if (isErrno(error, "ENOENT")) continue;
        throw error;
      }
      for (const name of names.sort()) {
        if (!SHA256_PATTERN.test(name)) continue;
        const path = join(this.#rootDir, shard, name);
        try {
          const st = await stat(path);
          if (!st.isFile()) continue;
          refs.push({ sha256: name, byteSize: st.size });
        } catch (error) {
          if (isErrno(error, "ENOENT")) continue; // 枚举间隙被删，跳过
          throw error;
        }
      }
    }
    return refs;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code
  );
}
