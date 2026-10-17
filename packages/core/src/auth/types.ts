/**
 * BI-02 · 智谱 BigModel 双轨特权认证引擎 —— 凭据端口定义。
 *
 * ICredentialStore 是全项目凭据的唯一权威端口（AUDIT-10 接缝⑤）：
 * BI-01.1 config secret、kimi oauth 等后续凭据消费方一律通过本端口读写，
 * 严禁各写各的落盘。凭据值必须经 role("secret", ...) 标记后才能进入端口。
 */

declare const secretBrand: unique symbol;

/**
 * role("secret") 标记的凭据值（compile-time brand，零运行时开销）。
 * 任何 Secret 在日志、序列化、调试输出中必须脱敏（见 ../auth/http 的 redact* 工具）。
 */
export type Secret = string & { readonly [secretBrand]: "secret" };

/** 凭据角色标记。当前仅支持 "secret"，为未来角色扩展保留命名位。 */
export type CredentialRole = "secret";

/**
 * 给明文字符串打上凭据角色标记。
 *
 * @param kind - 角色名，当前仅接受 "secret"
 * @param value - 明文凭据值（来自端点响应或用户输入）
 * @returns 标记为 Secret 的同一字符串（不拷贝、不改写）
 */
export function role(kind: "secret", value: string): Secret {
  if (kind !== "secret") {
    throw new CredentialStoreError("format", `未知凭据角色: ${kind}`);
  }
  return value as Secret;
}

/** 单条凭据记录（端口读出的完整形态）。 */
export interface CredentialRecord {
  /** 凭据键名，命名空间式（如 "bigmodel:pat"、"kimi:refresh-token"）。 */
  readonly key: string;
  /** 凭据值，必须经 role("secret") 标记。 */
  readonly value: Secret;
  /** 首次写入时间（epoch 毫秒，refresh 保留）。 */
  readonly createdAt: number;
  /** 最近一次写入/轮换时间（epoch 毫秒）。 */
  readonly updatedAt: number;
  /** 过期时间（epoch 毫秒），缺省表示长期有效。 */
  readonly expiresAt?: number;
}

/** 写入凭据时的可选项。 */
export interface CredentialWriteOptions {
  /** 过期时间（epoch 毫秒）。 */
  readonly expiresAt?: number;
}

/**
 * 全项目凭据唯一权威端口。
 *
 * 语义约定：
 * - `get`：读取凭据；不存在或已过期返回 undefined（过期记录惰性清除，不自动落盘）。
 * - `set`：新建或整条覆盖（createdAt 重置为当前时间）。
 * - `refresh`：原位轮换——仅允许对已存在凭据执行，保留 createdAt、更新值与 updatedAt；
 *   过期时间默认沿用旧值，可在 options 中覆盖。对不存在的键抛 CredentialStoreError("not_found")。
 * - `clear`：删除凭据；对不存在的键幂等成功。
 */
export interface ICredentialStore {
  get(key: string): Promise<CredentialRecord | undefined>;
  set(key: string, value: Secret, options?: CredentialWriteOptions): Promise<void>;
  refresh(key: string, value: Secret, options?: CredentialWriteOptions): Promise<void>;
  clear(key: string): Promise<void>;
}

/** 凭据存储错误。code 稳定可编程判断，message 已脱敏（不含凭据原文）。 */
export class CredentialStoreError extends Error {
  readonly code:
    | "machine_key"
    | "decrypt"
    | "format"
    | "io"
    | "not_found";

  constructor(
    code: CredentialStoreError["code"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CredentialStoreError";
    this.code = code;
  }
}
