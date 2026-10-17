/**
 * BI-02 · ICredentialStore 端口的文件实现 —— 加密落盘凭据库。
 *
 * 安全设计：
 * - 落盘 `~/.bi/credentials.json`（路径可注入），静态加密 AES-256-GCM，
 *   权限 0600；写盘走 ../utils/atomic-write 的 atomicWriteFile 原子替换。
 * - 主密钥来自 `~/.bi/.machine-key`（0600，首次自动生成 32 字节；路径可注入），
 *   每个凭据文件再经 HKDF-SHA256 + 随机 salt 派生独立存储密钥，避免主密钥直用。
 * - 每次写入使用随机 12 字节 IV 与 16 字节 authTag，信封含 version/cipher/kdf 字段。
 * - 权限硬ening：借助 process.umask(0o077) 让 atomicWriteFile 的临时文件
 *   一创建即 0600（用完立即恢复），消除明文/密文临时文件暴露窗口；
 *   读取时若发现权限松弛则自愈 chmod 0600。
 */
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { atomicWriteFile } from "../utils/atomic-write";
import {
  CredentialStoreError,
  role,
  type CredentialRecord,
  type CredentialWriteOptions,
  type ICredentialStore,
  type Secret,
} from "./types";

/** 默认凭据文件路径：~/.bi/credentials.json */
export const DEFAULT_CREDENTIALS_PATH = join(homedir(), ".bi", "credentials.json");
/** 默认机器密钥路径：~/.bi/.machine-key */
export const DEFAULT_MACHINE_KEY_PATH = join(homedir(), ".bi", ".machine-key");

const FILE_MODE = 0o600;
const CREDENTIALS_FORMAT_VERSION = 1;
const CIPHER_NAME = "AES-256-GCM";
const KDF_NAME = "HKDF-SHA256";
const AAD = Buffer.from("bi-credentials-v1", "utf8");
const MACHINE_KEY_BYTES = 32;

/** 加密信封（credentials.json 的磁盘形态）。 */
interface EncryptedEnvelope {
  version: number;
  cipher: string;
  kdf: string;
  /** base64，16 字节随机 salt（每次写盘重新生成）。 */
  salt: string;
  /** base64，12 字节随机 IV。 */
  iv: string;
  /** base64，16 字节 GCM authTag。 */
  authTag: string;
  /** base64，内层 JSON 明文的密文。 */
  payload: string;
}

export interface FileCredentialStoreOptions {
  /** 凭据文件路径，缺省 ~/.bi/credentials.json。 */
  readonly filePath?: string;
  /** 机器密钥路径，缺省 ~/.bi/.machine-key。 */
  readonly keyPath?: string;
  /** 时钟注入（测试过期语义），缺省 Date.now。 */
  readonly now?: () => number;
}

/**
 * 在受限 umask 下执行写盘：临时文件创建即 0600，杜绝暴露窗口。
 * umask 设置失败（异构运行时）时静默降级为普通写入，落盘后仍有 chmod 兜底。
 */
async function withRestrictedUmask<T>(fn: () => Promise<T>): Promise<T> {
  let previous: number | undefined;
  try {
    previous = process.umask(0o077);
  } catch {
    previous = undefined;
  }
  try {
    return await fn();
  } finally {
    if (previous !== undefined) {
      try {
        process.umask(previous);
      } catch {
        // 恢复失败不影响主流程。
      }
    }
  }
}

function deriveStoreKey(machineKey: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", machineKey, salt, "bi/credentials/v1", 32));
}

function encryptPayload(storeKey: Buffer, iv: Buffer, plaintext: string): {
  ciphertext: Buffer;
  authTag: Buffer;
} {
  const cipher = createCipheriv("aes-256-gcm", storeKey, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext, authTag: cipher.getAuthTag() };
}

function decryptPayload(storeKey: Buffer, iv: Buffer, authTag: Buffer, ciphertext: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", storeKey, iv);
  decipher.setAAD(AAD);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 文件凭据库：ICredentialStore 的权威实现。
 * 实例内串行化读写（互斥队列），跨进程并发依赖 atomicWriteFile 的原子替换语义。
 */
export class FileCredentialStore implements ICredentialStore {
  readonly #filePath: string;
  readonly #keyPath: string;
  readonly #now: () => number;
  #machineKeyCache: Buffer | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: FileCredentialStoreOptions = {}) {
    this.#filePath = options.filePath ?? DEFAULT_CREDENTIALS_PATH;
    this.#keyPath = options.keyPath ?? DEFAULT_MACHINE_KEY_PATH;
    this.#now = options.now ?? Date.now;
  }

  async get(key: string): Promise<CredentialRecord | undefined> {
    return this.#enqueue(async () => {
      const entries = await this.#load();
      const record = entries.get(key);
      if (!record) return undefined;
      if (record.expiresAt !== undefined && record.expiresAt <= this.#now()) {
        return undefined;
      }
      return record;
    });
  }

  async set(key: string, value: Secret, options?: CredentialWriteOptions): Promise<void> {
    await this.#enqueue(async () => {
      const entries = await this.#load();
      const at = this.#now();
      entries.set(key, {
        key,
        value,
        createdAt: at, // set 为整条覆盖，createdAt 重置
        updatedAt: at,
        expiresAt: options?.expiresAt,
      });
      await this.#persist(entries);
    });
  }

  async refresh(key: string, value: Secret, options?: CredentialWriteOptions): Promise<void> {
    await this.#enqueue(async () => {
      const entries = await this.#load();
      const existing = entries.get(key);
      if (!existing) {
        throw new CredentialStoreError("not_found", `凭据不存在，无法轮换: ${key}`);
      }
      entries.set(key, {
        key,
        value,
        createdAt: existing.createdAt,
        updatedAt: this.#now(),
        expiresAt: options?.expiresAt ?? existing.expiresAt,
      });
      await this.#persist(entries);
    });
  }

  async clear(key: string): Promise<void> {
    await this.#enqueue(async () => {
      const entries = await this.#load();
      if (!entries.delete(key)) return;
      await this.#persist(entries);
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(operation, operation);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 读取或首次生成 32 字节机器密钥（0600，实例内缓存）。 */
  async #machineKey(): Promise<Buffer> {
    if (this.#machineKeyCache) return this.#machineKeyCache;
    let raw: string | undefined;
    try {
      raw = await readFile(this.#keyPath, "utf8");
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw new CredentialStoreError("machine_key", `机器密钥文件不可读: ${this.#keyPath}`, {
          cause: error,
        });
      }
    }
    if (raw !== undefined && raw.trim() !== "") {
      const key = decodeMachineKey(raw);
      this.#machineKeyCache = key;
      await this.#hardenPermissions(this.#keyPath);
      return key;
    }
    // 首次生成（或文件为空）：32 字节安全随机，受限 umask 下原子落盘后 0600。
    const key = randomBytes(MACHINE_KEY_BYTES);
    await mkdir(dirname(this.#keyPath), { recursive: true });
    await withRestrictedUmask(() => atomicWriteFile(this.#keyPath, key.toString("base64")));
    await chmod(this.#keyPath, FILE_MODE);
    this.#machineKeyCache = key;
    return key;
  }

  async #hardenPermissions(path: string): Promise<void> {
    try {
      const stats = await stat(path);
      if ((stats.mode & 0o777) !== FILE_MODE) {
        await chmod(path, FILE_MODE);
      }
    } catch {
      // 权限自愈失败不阻断读取。
    }
  }

  /** 读盘解密为内存映射；文件不存在视为空库。 */
  async #load(): Promise<Map<string, CredentialRecord>> {
    let raw: string;
    try {
      raw = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return new Map();
      }
      throw new CredentialStoreError("io", `凭据文件不可读: ${this.#filePath}`, { cause: error });
    }
    await this.#hardenPermissions(this.#filePath);

    let envelope: unknown;
    try {
      envelope = JSON.parse(raw);
    } catch (error) {
      throw new CredentialStoreError("format", "凭据文件不是合法 JSON 信封", { cause: error });
    }
    if (!isRecord(envelope)) {
      throw new CredentialStoreError("format", "凭据信封结构非法");
    }
    if (
      envelope.version !== CREDENTIALS_FORMAT_VERSION ||
      envelope.cipher !== CIPHER_NAME ||
      envelope.kdf !== KDF_NAME ||
      typeof envelope.salt !== "string" ||
      typeof envelope.iv !== "string" ||
      typeof envelope.authTag !== "string" ||
      typeof envelope.payload !== "string"
    ) {
      throw new CredentialStoreError("format", "凭据信封字段缺失或不匹配");
    }

    const machineKey = await this.#machineKey();
    const storeKey = deriveStoreKey(machineKey, Buffer.from(envelope.salt, "base64"));
    let plaintext: string;
    try {
      plaintext = decryptPayload(
        storeKey,
        Buffer.from(envelope.iv, "base64"),
        Buffer.from(envelope.authTag, "base64"),
        Buffer.from(envelope.payload, "base64"),
      );
    } catch (error) {
      throw new CredentialStoreError(
        "decrypt",
        "凭据解密失败（机器密钥不匹配或数据被篡改）",
        { cause: error },
      );
    }

    let entriesRaw: unknown;
    try {
      entriesRaw = JSON.parse(plaintext);
    } catch (error) {
      throw new CredentialStoreError("format", "凭据明文不是合法 JSON", { cause: error });
    }
    if (!isRecord(entriesRaw)) {
      throw new CredentialStoreError("format", "凭据明文结构非法");
    }
    const entries = new Map<string, CredentialRecord>();
    for (const [key, value] of Object.entries(entriesRaw)) {
      if (!isRecord(value) || typeof value.value !== "string") {
        throw new CredentialStoreError("format", `凭据条目非法: ${key}`);
      }
      entries.set(key, {
        key,
        value: role("secret", value.value),
        createdAt: readTimestamp(value.createdAt),
        updatedAt: readTimestamp(value.updatedAt),
        expiresAt: value.expiresAt === undefined ? undefined : readTimestamp(value.expiresAt),
      });
    }
    return entries;
  }

  /** 加密并原子落盘（随机 salt + IV，0600）。 */
  async #persist(entries: Map<string, CredentialRecord>): Promise<void> {
    const machineKey = await this.#machineKey();
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const storeKey = deriveStoreKey(machineKey, salt);
    const plainObject: Record<string, Record<string, unknown>> = {};
    for (const [key, record] of entries) {
      plainObject[key] = {
        value: record.value,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
      };
    }
    const { ciphertext, authTag } = encryptPayload(
      storeKey,
      iv,
      JSON.stringify(plainObject),
    );
    const envelope: EncryptedEnvelope = {
      version: CREDENTIALS_FORMAT_VERSION,
      cipher: CIPHER_NAME,
      kdf: KDF_NAME,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
      payload: ciphertext.toString("base64"),
    };
    await mkdir(dirname(this.#filePath), { recursive: true });
    await withRestrictedUmask(() =>
      atomicWriteFile(this.#filePath, JSON.stringify(envelope, null, 2)),
    );
    await chmod(this.#filePath, FILE_MODE);
  }
}

function decodeMachineKey(raw: string): Buffer {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(raw.trim(), "base64");
  } catch (error) {
    throw new CredentialStoreError("machine_key", "机器密钥不是合法 base64", { cause: error });
  }
  if (decoded.length !== MACHINE_KEY_BYTES) {
    throw new CredentialStoreError(
      "machine_key",
      `机器密钥长度非法：期望 ${MACHINE_KEY_BYTES} 字节，实际 ${decoded.length} 字节`,
    );
  }
  return decoded;
}

function readTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new CredentialStoreError("format", "凭据时间戳非法");
  }
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}
