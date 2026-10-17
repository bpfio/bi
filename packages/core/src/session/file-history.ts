/**
 * 写前物理快照与无损文件历史回滚器（BI-03.2）：`FileHistoryService`。
 *
 * 职责：在任何修改文件的工具（edit/write/bash）执行【前】调用
 * `snapshotBefore(filePath, context)`，把文件现字节以内容寻址方式存入
 * `BlobStore` 并登记元数据记录；随后可用 `restore(recordId)` 做字节级精确还原。
 * 完全独立于 Git——本模块不执行任何 git 命令。
 *
 * 语义约定：
 *   - 被快照文件不存在 → 记为 created-before 空快照：快照内容为零字节
 *     （priorSha256 = SHA-256("")，byteSize = 0，空内容同样入 blob 仓）；
 *     restore 即把零字节原子写回（快照的是「字节状态」而非「存在性」）。
 *   - priorSha256 与 blobRef.sha256 恒等（快照内容哈希），作为还原断言锚点。
 *   - filePath 一律经 path.resolve 归一化为绝对路径后登记/查询。
 *
 * 索引：内存 Map 为主，可选持久化 `<rootDir>/index.jsonl`（默认开启，
 * 每次变更后经 atomicWriteFile 整文件重写——记录量小；加载时跳过非法行，
 * 容忍手改/异常残留）。按 sessionId / turnId / filePath（外加 phase）可查。
 *
 * 并发：实例内单队列串行（快照/还原/prune/查询全部入队），同文件并发快照
 * 天然互斥；读文件支持注入（测试确定性）。
 */
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { atomicWriteFile } from "../utils/atomic-write";
import type { BlobRef } from "./blob-store";
import { BlobStore, sha256Hex } from "./blob-store";
import { uuid7 } from "./uuid7";

/** 文件历史索引根目录默认值：~/.bi/file-history（index.jsonl 所在）。 */
export function defaultFileHistoryRoot(): string {
  return join(homedir(), ".bi", "file-history");
}

/** 触发快照的工具阶段（修改文件的三类工具）。 */
export const SNAPSHOT_PHASES = ["edit", "write", "bash"] as const;
export type SnapshotPhase = (typeof SNAPSHOT_PHASES)[number];

/** 运行时校验阶段值（用于入参校验与索引回放）。 */
export function isSnapshotPhase(value: unknown): value is SnapshotPhase {
  return typeof value === "string" && (SNAPSHOT_PHASES as readonly string[]).includes(value);
}

/** 快照上下文：谁（会话）、哪一轮（turn）、哪个工具阶段触发。 */
export interface SnapshotContext {
  /** 所属会话 id（非空）。 */
  sessionId: string;
  /** 所属回合 id（非空）。 */
  turnId: string;
  /** 触发快照的工具阶段。 */
  phase: SnapshotPhase;
}

/** 一条写前快照元数据记录。 */
export interface FileHistoryRecord {
  /** 记录唯一 id（UUIDv7，默认）。 */
  id: string;
  /** 所属会话 id。 */
  sessionId: string;
  /** 所属回合 id。 */
  turnId: string;
  /** 触发快照的工具阶段。 */
  phase: SnapshotPhase;
  /** 被快照文件的绝对路径（path.resolve 归一化）。 */
  filePath: string;
  /** 快照内容在 BlobStore 中的引用。 */
  blobRef: BlobRef;
  /** 快照内容 SHA-256（与 blobRef.sha256 恒等；created-before 时为 SHA-256("")）。 */
  priorSha256: string;
  /** 快照字节数（created-before 时为 0）。 */
  byteSize: number;
  /** 快照时间（unix 毫秒）。 */
  createdAt: number;
}

/** restore 的结果：还原前后 SHA-256 供断言。 */
export interface RestoreResult {
  /** 被还原的记录 id。 */
  recordId: string;
  /** 还原的目标文件（绝对路径）。 */
  filePath: string;
  /** 还原前目标文件内容的 SHA-256；目标不存在时为 null。 */
  beforeSha256: string | null;
  /** 还原后内容的 SHA-256（等于 record.priorSha256）。 */
  afterSha256: string;
  /** 还原写入的字节数。 */
  byteSize: number;
}

/** 历史查询过滤条件（全部可选，按 AND 组合；结果 createdAt 倒序）。 */
export interface HistoryQuery {
  sessionId?: string;
  turnId?: string;
  filePath?: string;
  phase?: SnapshotPhase;
}

/** prune 保留策略：满足任一条件的记录被清理（keepLastN 为每文件保留最新 N 条）。 */
export interface PruneOptions {
  /** 每个文件保留最新 N 条快照（其余清理）。 */
  keepLastN?: number;
  /** 清理 createdAt 早于 now - olderThanMs 的记录。 */
  olderThanMs?: number;
}

/** prune 结果：清理的记录数与无引用 blob 数。 */
export interface PruneResult {
  removedRecords: number;
  removedBlobs: number;
}

/** 记录 id 不存在。 */
export class RecordNotFoundError extends Error {
  readonly recordId: string;

  constructor(recordId: string) {
    super(`文件历史记录不存在: ${recordId}`);
    this.name = "RecordNotFoundError";
    this.recordId = recordId;
  }
}

export interface FileHistoryOptions {
  /** 注入既有 BlobStore（共享场景）；未注入时按 blobRoot 自建。 */
  blobStore?: BlobStore;
  /** 自建 BlobStore 的根目录；默认 ~/.bi/blobs。测试必须注入临时目录。 */
  blobRoot?: string;
  /** 索引目录（index.jsonl 所在）；默认 ~/.bi/file-history。测试必须注入临时目录。 */
  rootDir?: string;
  /** 是否持久化 index.jsonl；默认 true。 */
  persistIndex?: boolean;
  /** 时间源（测试/回放注入）；默认 Date.now。 */
  now?: () => number;
  /** 记录 id 生成器（测试注入）；默认 uuid7。 */
  generateId?: () => string;
  /** 读被快照文件的实现（测试确定性注入）；默认 node:fs/promises readFile。 */
  readFile?: (filePath: string) => Promise<Uint8Array>;
}

const EMPTY_BYTES = new Uint8Array(0);

/** SHA-256("")——created-before 空快照的先验哈希。 */
export const EMPTY_SHA256 = sha256Hex(EMPTY_BYTES);

// 索引行校验用哈希白名单，与 blob-store 的 SHA256_PATTERN 同形。
const SHA256_PATTERN_FOR_INDEX = /^[0-9a-f]{64}$/;

export class FileHistoryService {
  readonly #blobStore: BlobStore;
  readonly #rootDir: string;
  readonly #persistIndex: boolean;
  readonly #now: () => number;
  readonly #generateId: () => string;
  readonly #readFile: (filePath: string) => Promise<Uint8Array>;
  /** 内存索引：recordId -> record。 */
  readonly #records = new Map<string, FileHistoryRecord>();
  /** 实例内串行队列：所有公开操作入队，保证并发同文件快照互斥与索引写不交叠。 */
  #queue: Promise<unknown> = Promise.resolve();
  /** 惰性加载 promise（持久化索引只在首次操作时读盘一次）。 */
  #loadPromise: Promise<void> | undefined;

  constructor(options: FileHistoryOptions = {}) {
    this.#blobStore = options.blobStore ?? new BlobStore({ rootDir: options.blobRoot });
    this.#rootDir = options.rootDir ?? defaultFileHistoryRoot();
    this.#persistIndex = options.persistIndex ?? true;
    this.#now = options.now ?? Date.now;
    this.#generateId = options.generateId ?? uuid7;
    this.#readFile = options.readFile ?? ((filePath: string) => readFile(filePath));
  }

  /** 底层 blob 仓（测试与上层工具用）。 */
  get blobStore(): BlobStore {
    return this.#blobStore;
  }

  /** 索引文件路径（测试与运维检查用）。 */
  get indexPath(): string {
    return join(this.#rootDir, "index.jsonl");
  }

  /**
   * 写前快照：在任何修改文件的工具执行前调用。读取现文件字节
   * （不存在则记为 created-before 空快照语义），put 入 BlobStore（内容寻址去重）
   * 并登记元数据记录。同一实例内并发快照按队列串行，互斥无交错。
   */
  async snapshotBefore(rawPath: string, context: SnapshotContext): Promise<FileHistoryRecord> {
    assertSnapshotContext(context);
    const filePath = resolve(rawPath);
    return this.#runExclusive(async () => {
      await this.#ensureLoaded();
      let bytes: Uint8Array;
      try {
        bytes = await this.#readFile(filePath);
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
        bytes = EMPTY_BYTES; // created-before 空快照语义
      }
      const priorSha256 = sha256Hex(bytes);
      const blobRef = await this.#blobStore.put(bytes);
      const record: FileHistoryRecord = {
        id: this.#generateId(),
        sessionId: context.sessionId,
        turnId: context.turnId,
        phase: context.phase,
        filePath,
        blobRef,
        priorSha256,
        byteSize: bytes.byteLength,
        createdAt: this.#now(),
      };
      this.#records.set(record.id, record);
      await this.#saveIndex();
      return record;
    });
  }

  /**
   * 无损还原：从 blob 取回字节（内部重算 SHA-256 完整性校验），原子写回
   * filePath（字节级精确还原；目标目录缺失时先补建）。返回还原前后 SHA-256
   * 供断言（afterSha256 === record.priorSha256）。
   */
  async restore(recordId: string): Promise<RestoreResult> {
    return this.#runExclusive(async () => {
      await this.#ensureLoaded();
      const record = this.#records.get(recordId);
      if (record === undefined) throw new RecordNotFoundError(recordId);
      const bytes = await this.#blobStore.get(record.blobRef);
      let beforeSha256: string | null = null;
      try {
        beforeSha256 = sha256Hex(await this.#readFile(record.filePath));
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error; // 还原前目标不存在
      }
      await mkdir(dirname(record.filePath), { recursive: true });
      await atomicWriteFile(record.filePath, bytes);
      return {
        recordId,
        filePath: record.filePath,
        beforeSha256,
        afterSha256: sha256Hex(bytes),
        byteSize: bytes.byteLength,
      };
    });
  }

  /** 单条记录；不存在返回 undefined。 */
  async getRecord(recordId: string): Promise<FileHistoryRecord | undefined> {
    return this.#runExclusive(async () => {
      await this.#ensureLoaded();
      return copyRecord(this.#records.get(recordId));
    });
  }

  /** 某文件的全部快照，createdAt 倒序（最新在前；次序键 id，uuid7 字典序即时间序）。 */
  async historyFor(filePath: string): Promise<FileHistoryRecord[]> {
    return this.query({ filePath });
  }

  /** 三维（sessionId/turnId/filePath）+ phase 任意组合查询，createdAt 倒序。 */
  async query(filter: HistoryQuery = {}): Promise<FileHistoryRecord[]> {
    return this.#runExclusive(async () => {
      await this.#ensureLoaded();
      const filePath = filter.filePath !== undefined ? resolve(filter.filePath) : undefined;
      const out: FileHistoryRecord[] = [];
      for (const record of this.#records.values()) {
        if (filter.sessionId !== undefined && record.sessionId !== filter.sessionId) continue;
        if (filter.turnId !== undefined && record.turnId !== filter.turnId) continue;
        if (filePath !== undefined && record.filePath !== filePath) continue;
        if (filter.phase !== undefined && record.phase !== filter.phase) continue;
        out.push(copyRecord(record));
      }
      return out.sort(compareRecordsDesc);
    });
  }

  /**
   * 保留策略：满足任一条件的记录被清理——keepLastN（每文件保留最新 N 条）
   * 或 olderThanMs（createdAt 早于 now - olderThanMs）。清理后按引用计数删除
   * 无引用 blob：被任何剩余记录引用的 blob 一律不删（引用同一 blob 的其他
   * 记录存活即存活）。prune 前提：BlobStore 专属于本服务（单租户）。
   */
  async prune(options: PruneOptions = {}): Promise<PruneResult> {
    const { keepLastN, olderThanMs } = options;
    if (keepLastN === undefined && olderThanMs === undefined) {
      throw new Error("prune 需要至少一个保留策略条件: keepLastN 或 olderThanMs");
    }
    if (keepLastN !== undefined && (!Number.isInteger(keepLastN) || keepLastN < 1)) {
      throw new Error(`keepLastN 须为正整数: ${keepLastN}`);
    }
    if (olderThanMs !== undefined && (!Number.isFinite(olderThanMs) || olderThanMs < 0)) {
      throw new Error(`olderThanMs 须为非负有限数: ${olderThanMs}`);
    }
    return this.#runExclusive(async () => {
      await this.#ensureLoaded();
      const nowMs = this.#now();
      const cutoff = olderThanMs !== undefined ? nowMs - olderThanMs : null;

      // 按 filePath 分组，组内 createdAt 升序（id 升序破平局），超出 keepLastN 的为待删。
      const byFile = new Map<string, FileHistoryRecord[]>();
      for (const record of this.#records.values()) {
        const bucket = byFile.get(record.filePath);
        if (bucket === undefined) byFile.set(record.filePath, [record]);
        else bucket.push(record);
      }
      const doomed = new Set<string>();
      for (const records of byFile.values()) {
        records.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
        records.forEach((record, index) => {
          const rankFromNewest = records.length - index; // 1 = 最新
          const beyondKeep = keepLastN !== undefined && rankFromNewest > keepLastN;
          const tooOld = cutoff !== null && record.createdAt < cutoff;
          if (beyondKeep || tooOld) doomed.add(record.id);
        });
      }
      let removedRecords = 0;
      for (const id of doomed) {
        this.#records.delete(id);
        removedRecords += 1;
      }

      // 引用计数：剩余记录引用的 blob 全部保留，其余删除。
      const referenced = new Set<string>();
      for (const record of this.#records.values()) referenced.add(record.blobRef.sha256);
      let removedBlobs = 0;
      for (const ref of await this.#blobStore.listBlobs()) {
        if (referenced.has(ref.sha256)) continue;
        if (await this.#blobStore.delete(ref)) removedBlobs += 1;
      }

      if (removedRecords > 0) await this.#saveIndex();
      return { removedRecords, removedBlobs };
    });
  }

  /* ------------------------------ 内部：队列与索引 ------------------------------ */

  #runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn, fn); // 前序成败均不阻断后续
    this.#queue = next.catch(() => {}); // 队尾吞错，保持链条存活
    return next;
  }

  #ensureLoaded(): Promise<void> {
    if (!this.#persistIndex) return Promise.resolve();
    this.#loadPromise ??= this.#loadIndex();
    return this.#loadPromise;
  }

  async #loadIndex(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.indexPath, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const record = parseRecordLine(trimmed);
      if (record !== null) this.#records.set(record.id, record); // 非法行跳过，不拖垮
    }
  }

  /** 整文件重写索引（记录量小；原子替换，掉电不损旧索引）。 */
  async #saveIndex(): Promise<void> {
    if (!this.#persistIndex) return;
    const lines = [...this.#records.values()]
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
      .map((record) => JSON.stringify(record));
    await mkdir(this.#rootDir, { recursive: true });
    await atomicWriteFile(this.indexPath, lines.length === 0 ? "" : lines.join("\n") + "\n");
  }
}

/* ---------------------------------- 内部工具 ---------------------------------- */

function assertSnapshotContext(context: SnapshotContext): void {
  if (typeof context.sessionId !== "string" || context.sessionId.length === 0) {
    throw new Error("snapshotBefore 需要 context.sessionId（非空字符串）");
  }
  if (typeof context.turnId !== "string" || context.turnId.length === 0) {
    throw new Error("snapshotBefore 需要 context.turnId（非空字符串）");
  }
  if (!isSnapshotPhase(context.phase)) {
    throw new Error(
      `非法快照阶段: ${JSON.stringify(context.phase ?? null)}（允许: ${SNAPSHOT_PHASES.join("/")}）`,
    );
  }
}

/** createdAt 降序（最新在前），id 降序破平局（uuid7 字典序即时间序）。 */
function compareRecordsDesc(a: FileHistoryRecord, b: FileHistoryRecord): number {
  return b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1);
}

function copyRecord(record: FileHistoryRecord): FileHistoryRecord;
function copyRecord(record: FileHistoryRecord | undefined): FileHistoryRecord | undefined;
function copyRecord(record: FileHistoryRecord | undefined): FileHistoryRecord | undefined {
  if (record === undefined) return undefined;
  return { ...record, blobRef: { ...record.blobRef } };
}

/** 解析并校验索引行（结构化白名单校验，非法返回 null 由调用方跳过）。 */
function parseRecordLine(text: string): FileHistoryRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const { id, sessionId, turnId, phase, filePath, blobRef, priorSha256, byteSize, createdAt } = rec;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  if (typeof turnId !== "string" || turnId.length === 0) return null;
  if (!isSnapshotPhase(phase)) return null;
  if (typeof filePath !== "string" || filePath.length === 0) return null;
  if (typeof blobRef !== "object" || blobRef === null || Array.isArray(blobRef)) return null;
  const ref = blobRef as Record<string, unknown>;
  const { sha256, byteSize: refByteSize } = ref;
  if (typeof sha256 !== "string" || !SHA256_PATTERN_FOR_INDEX.test(sha256)) return null;  if (typeof refByteSize !== "number" || !Number.isInteger(refByteSize) || refByteSize < 0) {
    return null;
  }
  if (typeof priorSha256 !== "string" || !SHA256_PATTERN_FOR_INDEX.test(priorSha256)) return null;
  if (typeof byteSize !== "number" || !Number.isInteger(byteSize) || byteSize < 0) return null;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  return {
    id,
    sessionId,
    turnId,
    phase,
    filePath,
    blobRef: { sha256, byteSize: refByteSize },
    priorSha256,
    byteSize,
    createdAt,
  };
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code
  );
}
