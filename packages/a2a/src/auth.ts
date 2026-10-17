/**
 * BI-15.3 · A2A 三级鉴权体系 —— L2 协议层鉴权面（HMAC-SHA256 封套签名与五步验证）。
 *
 * 三层模型（本模块为 L2，与 L1/L3 正交叠加）：
 * - L1 传输层：通道鉴权与加密（BI-15.1 邮件信令网关 / BI-15.2 GitHub 中枢 / BI-15.4 WSS 中继）；
 * - L2 协议层（本文件）：任何跨网 A2A 封套必须通过 HMAC-SHA256 签名 +
 *   5 分钟时间戳窗 + 发件人白名单 + nonce 防重放 + 常时验签五步验证
 *   （对齐 devplan 分歧场景 5 与 BI-15.3 工单第 1 点）；
 * - L3 授权层：角色能力矩阵与高危动作分类（见 ./permissions.ts）。
 *
 * 安全红线：
 * - 密钥全量使用本包本地 Secret 品牌类型 `A2aSharedSecret`（零运行时开销，
 *   编译期禁止裸 string 混入密钥位）。本包保持独立，不 import @bi/core。
 * - Secret 严禁进入日志、序列化输出与错误消息；VerifyResult 只回稳定原因码，
 *   不携带任何密钥材料。
 * - 零外部 npm 依赖：仅 node:crypto。
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Secret 品牌（本地自定义，独立于 @bi/core 的凭据体系）
// ---------------------------------------------------------------------------

declare const secretBrand: unique symbol;

/**
 * A2A 共享密钥（compile-time brand，零运行时开销）。
 * 由 `a2aSecret()` 构造；签名/验签入口只接受本类型，
 * 裸 string 无法通过编译混入密钥位。
 */
export type A2aSharedSecret = string & { readonly [secretBrand]: "a2a-shared-secret" };

/** 给明文密钥打 Secret 品牌标记（不拷贝、不改写；仅拒绝空串防呆）。 */
export function a2aSecret(raw: string): A2aSharedSecret {
  if (raw.length === 0) {
    throw new RangeError("A2aSharedSecret 不能为空串");
  }
  return raw as A2aSharedSecret;
}

// ---------------------------------------------------------------------------
// 封套类型
// ---------------------------------------------------------------------------

/** A2A 协议封套：跨网协作消息的标准载体（payload 必须是 JSON 可达结构）。 */
export interface A2aEnvelope<T = unknown> {
  /** 发件人身份（须落在收件方白名单内，见 VerifyOptions.allowFrom）。 */
  from: string;
  /** 收件人身份。 */
  to: string;
  /** 发送时刻（epoch 毫秒）。验证时要求 |now - ts| ≤ skewMs。 */
  ts: number;
  /** 一次性随机串（防重放幂等键，建议 crypto.randomUUID()）。 */
  nonce: string;
  /** 业务载荷（纯 JSON 数据；带自定义 toJSON 的对象不保证签名稳定）。 */
  payload: T;
}

/** 已签名封套：五个协议字段 + base64url 签名。签名只覆盖五个协议字段。 */
export interface SignedEnvelope<T = unknown> extends A2aEnvelope<T> {
  /** HMAC-SHA256(canonicalJson({from,to,ts,nonce,payload}), secret) 的 base64url 编码（无填充）。 */
  signature: string;
}

/** 默认时钟偏斜容忍窗：5 分钟（对齐 BI-15.3「5分钟时钟偏斜」）。 */
export const DEFAULT_SKEW_MS = 300_000;

// ---------------------------------------------------------------------------
// 规范化序列化
// ---------------------------------------------------------------------------

/**
 * 规范化 JSON 序列化：递归按 Unicode 码点排序对象键名后序列化，
 * 输出与属性插入顺序无关（键序扰动不改变输出，签名因此稳定）。
 *
 * 规则：
 * - 对象键名递归排序（含顶层 from/to/ts/nonce/payload 与 payload 内部）；
 * - 数组保持原顺序（数组顺序是语义的一部分，不参与排序）；
 * - undefined 字段在对象中剔除、在数组中落为 null（与 JSON.stringify 语义一致）。
 */
export function canonicalJson(value: unknown): string {
  return canonicalWalk(value);
}

function canonicalWalk(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const atom = JSON.stringify(value);
    return atom === undefined ? "null" : atom;
  }
  if (Array.isArray(value)) {
    const items = value.map((element) => canonicalWalk(element));
    return `[${items.join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const child = record[key];
    if (child === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalWalk(child)}`);
  }
  return `{${parts.join(",")}}`;
}

// ---------------------------------------------------------------------------
// nonce 防重放库
// ---------------------------------------------------------------------------

/**
 * nonce 防重放库存端口。
 * `has`/`mark` 均以注入时钟 `now` 驱动 TTL（可测、可对齐多机时钟）；
 * 生产部署可替换为持久化实现（如 Redis SET NX + TTL）。
 */
export interface ReplayStore {
  /** 该 nonce 是否仍在防重放窗内（窗内视为已见过 → 重放）。 */
  has(nonce: string, now: number): boolean;
  /** 登记 nonce；过期时刻由实现按 now + TTL 决定。 */
  mark(nonce: string, now: number): void;
}

/**
 * 默认内存 ReplayStore：Map + 惰性 TTL 清理。
 * 清理由注入时钟驱动（不读真实时钟），TTL 默认与时间窗对齐（DEFAULT_SKEW_MS）。
 */
export class MemoryReplayStore implements ReplayStore {
  readonly #entries = new Map<string, number>();
  readonly #ttlMs: number;

  constructor(ttlMs: number = DEFAULT_SKEW_MS) {
    this.#ttlMs = ttlMs;
  }

  has(nonce: string, now: number): boolean {
    this.#prune(now);
    return this.#entries.has(nonce);
  }

  mark(nonce: string, now: number): void {
    this.#prune(now);
    this.#entries.set(nonce, now + this.#ttlMs);
  }

  /** 当前在册 nonce 数（观测与测试用）。 */
  get size(): number {
    return this.#entries.size;
  }

  #prune(now: number): void {
    for (const [nonce, expiresAt] of this.#entries) {
      if (expiresAt <= now) this.#entries.delete(nonce);
    }
  }
}

/** 缺省防重放库（进程级内存实现）。verifyEnvelope 未显式注入 replayStore 时使用。 */
export const defaultReplayStore: MemoryReplayStore = new MemoryReplayStore();

// ---------------------------------------------------------------------------
// 签名与验证
// ---------------------------------------------------------------------------

/** HMAC-SHA256 over 规范化五字段（签名输入恒定为 from,to,ts,nonce,payload，不含 signature 与附加键）。 */
function macOf(envelope: A2aEnvelope<unknown>, secret: A2aSharedSecret): Buffer {
  const canonical = canonicalJson({
    from: envelope.from,
    to: envelope.to,
    ts: envelope.ts,
    nonce: envelope.nonce,
    payload: envelope.payload,
  });
  return createHmac("sha256", secret).update(canonical, "utf8").digest();
}

/** 签名封套：对五个协议字段的规范化 JSON 计算 HMAC-SHA256，签名以 base64url（无填充）编码。 */
export function signEnvelope<T>(
  envelope: A2aEnvelope<T>,
  secret: A2aSharedSecret,
): SignedEnvelope<T> {
  assertSecret(secret);
  const signature = macOf(envelope, secret).toString("base64url");
  // 只携带五个协议字段 + signature：附加字段不获得完整性保护，直接丢弃（与 verify 严格键集对齐）。
  return {
    from: envelope.from,
    to: envelope.to,
    ts: envelope.ts,
    nonce: envelope.nonce,
    payload: envelope.payload,
    signature,
  };
}

/** 验证失败原因（稳定可编程判断，可测）。 */
export type VerifyFailureReason =
  | "malformed"
  | "unknown-sender"
  | "expired"
  | "replayed"
  | "bad-signature";

export interface VerifyOptions {
  /** 验证方共享密钥（与 signEnvelope 同钥）。 */
  secret: A2aSharedSecret;
  /** 发件人白名单。fail-closed：空数组拒绝一切发件人。 */
  allowFrom: readonly string[];
  /** 时钟偏斜容忍窗（毫秒），默认 DEFAULT_SKEW_MS（300_000）。 */
  skewMs?: number;
  /** 注入时钟（epoch 毫秒）。缺省 Date.now()；测试与多机时钟对齐用。 */
  now?: number;
  /** nonce 防重放库。缺省进程级 defaultReplayStore；生产建议注入持久实现。 */
  replayStore?: ReplayStore;
}

export type VerifyResult<T = unknown> =
  | { readonly valid: true; readonly envelope: A2aEnvelope<T> }
  | { readonly valid: false; readonly reason: VerifyFailureReason };

/** 已签名封套的合法键集（排序后），附加键一律视为 malformed——防未签名元数据注入。 */
const SIGNED_ENVELOPE_KEY_SET = "from,nonce,payload,signature,to,ts";

/**
 * 五步验证（全部通过才 valid，任一步失败即短路返回稳定原因码）：
 *
 * 0. 前置结构校验：键集恰为 from/to/ts/nonce/payload/signature 且类型正确，否则 `malformed`；
 * ① 发件人白名单（fail-closed），否则 `unknown-sender`；
 * ② 时间窗 |now - ts| ≤ skewMs，否则 `expired`（未来时间戳同样落此窗，理由码复用）；
 * ③ nonce 防重放（has 命中即 `replayed`；登记推迟到签名通过之后，
 *    防止未鉴权消息污染 nonce 库造成合法发件人被 DoS）；
 * ④⑤ 常时验签：重算 HMAC-SHA256 与封套签名做常时字节比较（长度不齐先哈希对齐），
 *    不一致 `bad-signature`。
 *
 * 验证通过时登记 nonce（mark）并返回鉴权后的封套内容。
 */
export function verifyEnvelope<T = unknown>(
  signed: SignedEnvelope<T>,
  opts: VerifyOptions,
): VerifyResult<T> {
  assertSecret(opts.secret);

  // 步骤 0：结构校验（运行时防御——JS 调用方 / 传输解码产物不可信）。
  if (!isWellFormedSignedEnvelope(signed)) {
    return { valid: false, reason: "malformed" };
  }
  const { from, to, ts, nonce, payload, signature } = signed;

  // 步骤 ①：发件人白名单（fail-closed：allowFrom 为空 ⇒ 全部拒绝）。
  if (!opts.allowFrom.includes(from)) {
    return { valid: false, reason: "unknown-sender" };
  }

  // 步骤 ②：时间窗（now 可注入；now 本身非法时按过期处理，不抛异常）。
  const skewMs = opts.skewMs ?? DEFAULT_SKEW_MS;
  const now = opts.now ?? Date.now();
  if (!Number.isFinite(now) || Math.abs(now - ts) > skewMs) {
    return { valid: false, reason: "expired" };
  }

  // 步骤 ③：nonce 防重放检查。
  const store = opts.replayStore ?? defaultReplayStore;
  if (store.has(nonce, now)) {
    return { valid: false, reason: "replayed" };
  }

  // 步骤 ④⑤：规范化重算签名 + 常时比较。
  const expected = macOf({ from, to, ts, nonce, payload }, opts.secret);
  const provided = decodeBase64Url(signature);
  if (provided === null || !constantTimeEqual(provided, expected)) {
    return { valid: false, reason: "bad-signature" };
  }

  // 五步全过：登记 nonce（防污染——验签失败的消息不占坑），返回鉴权后封套。
  store.mark(nonce, now);
  return { valid: true, envelope: { from, to, ts, nonce, payload } };
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function assertSecret(secret: A2aSharedSecret): void {
  if (typeof secret !== "string" || secret.length === 0) {
    // 错误消息不含密钥材料本身。
    throw new RangeError("A2aSharedSecret 必须是经 a2aSecret() 标记的非空字符串");
  }
}

function isWellFormedSignedEnvelope(
  signed: SignedEnvelope<unknown>,
): signed is SignedEnvelope<unknown> {
  if (signed === null || typeof signed !== "object" || Array.isArray(signed)) {
    return false;
  }
  // 键集恰好为六个协议键（防未签名附加字段注入）。
  if (Object.keys(signed).sort().join(",") !== SIGNED_ENVELOPE_KEY_SET) {
    return false;
  }
  return (
    isNonEmptyString(signed.from) &&
    isNonEmptyString(signed.to) &&
    isNonEmptyString(signed.nonce) &&
    isNonEmptyString(signed.signature) &&
    typeof signed.ts === "number" &&
    Number.isSafeInteger(signed.ts) &&
    "payload" in signed
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * 严格 base64url（无填充）解码：先做字符集校验，再做往返一致性校验，
 * 拒绝 Buffer 解码器静默吞掉的畸形输入（错误补位 / 悬挂字符）。
 */
function decodeBase64Url(text: string): Buffer | null {
  if (!BASE64URL_RE.test(text)) return null;
  const buf = Buffer.from(text, "base64url");
  return buf.toString("base64url") === text ? buf : null;
}

/**
 * 常时字节比较（密码学比较唯一合法通道）。
 *
 * 为何严禁 `===` 比较 MAC：JS 字符串/Buffer 的 `===`（及 Buffer.equals 之外的
 * 手写循环）在首个不一致字节处短路返回，响应耗时随匹配前缀长度线性变化；
 * 攻击者可用计时侧信道逐字节爆破签名（对每个候选前缀测量响应时间）。
 * crypto.timingSafeEqual 保证比较耗时与内容无关。
 *
 * 长度不齐路径：timingSafeEqual 要求两侧等长（不等长直接抛错，抛错/早退本身
 * 也是时间旁路），故先用 SHA-256 将两侧对齐到固定 32 字节再做常时比较；
 * 比较结果与长度检查取与——长度不同必然不是有效签名，但哈希比较照常执行，
 * 耗时仍被抹平（SHA-256 抗碰撞，哈希路径不会把错误长度签名误判为有效）。
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length === b.length) {
    return timingSafeEqual(a, b);
  }
  const alignedA = createHash("sha256").update(a).digest();
  const alignedB = createHash("sha256").update(b).digest();
  return timingSafeEqual(alignedA, alignedB) && a.length === b.length;
}
