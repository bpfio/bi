/**
 * BI-02.1 · Ultra VIP 专线特权指纹标头组 —— 构造与日志脱敏。
 *
 * 上游 Coding Plan 专线通道凭一组「客户端指纹标头」识别特权客户端：
 * - `X-Coding-Plan-Api-Key`：Coding Plan 特权 key（注入的 Secret 品牌值，绝不落日志）；
 * - `User-Agent`：通道认可的客户端指纹，默认 `zcode-cli/0.1.8`，可配置；
 * - `x-zcode-trace-id`：请求级链路标识，默认 16 字节 hex，生成器可注入以便测试。
 *
 * 零数据外泄红线：
 * - key 只经 Secret 品牌值进入标头组；日志/错误路径一律经 redactFingerprint
 *   遮蔽为 `ze-***last4`（≤4 字符的值整体遮蔽为 `ze-***`，避免 last4 反向泄漏全文）；
 * - 构造参数校验失败时错误消息只描述问题，绝不回显凭据内容。
 * 零外部依赖：仅 node:crypto。
 */
import { randomBytes } from "node:crypto";

import type { Secret } from "../auth/types";

/** 通道认可的缺省客户端指纹（上游 Coding Plan 通道按此识别 zcode-cli）。 */
export const DEFAULT_USER_AGENT = "zcode-cli/0.1.8";

/** 特权 key 标头名（canonical 大小写；HTTP 语义上大小写不敏感）。 */
export const FINGERPRINT_HEADER_PLAN_KEY = "X-Coding-Plan-Api-Key";
/** 客户端指纹标头名。 */
export const FINGERPRINT_HEADER_USER_AGENT = "User-Agent";
/** 链路标识标头名。 */
export const FINGERPRINT_HEADER_TRACE_ID = "x-zcode-trace-id";

/** 日志/错误路径的指纹遮蔽前缀。 */
export const FINGERPRINT_MASK_PREFIX = "ze-***";

/** 触发遮蔽的标头名集合（小写比较，大小写不敏感匹配）。 */
const FINGERPRINT_KEYS_LOWERCASE: ReadonlySet<string> = new Set([
  FINGERPRINT_HEADER_PLAN_KEY.toLowerCase(),
  FINGERPRINT_HEADER_USER_AGENT.toLowerCase(),
  FINGERPRINT_HEADER_TRACE_ID.toLowerCase(),
]);

/** buildFingerprintHeaders 入参。 */
export interface FingerprintOptions {
  /** Coding Plan 特权 key（Secret 品牌值，必填非空）。 */
  readonly apiKey: Secret;
  /** 覆盖缺省 User-Agent 指纹。 */
  readonly userAgent?: string;
  /** 显式 traceId（优先级最高，高于 traceIdGenerator）。 */
  readonly traceId?: string;
  /** traceId 生成器注入（缺省 16 字节 crypto 随机 hex）。 */
  readonly traceIdGenerator?: () => string;
}

/**
 * 构造特权指纹标头组：恰好三个标头，无多余键。
 * traceId 解析优先级：显式 traceId > traceIdGenerator() > 缺省随机 16 字节 hex。
 */
export function buildFingerprintHeaders(options: FingerprintOptions): Record<string, string> {
  if (options.apiKey.length === 0) {
    // 只描述问题，不回显值本身，杜绝凭据内容进入错误消息。
    throw new TypeError("buildFingerprintHeaders: apiKey 不能为空串");
  }
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  if (userAgent.length === 0) {
    throw new TypeError("buildFingerprintHeaders: userAgent 不能为空串");
  }
  const traceId = options.traceId ?? options.traceIdGenerator?.() ?? defaultTraceId();
  return {
    [FINGERPRINT_HEADER_PLAN_KEY]: options.apiKey,
    [FINGERPRINT_HEADER_USER_AGENT]: userAgent,
    [FINGERPRINT_HEADER_TRACE_ID]: traceId,
  };
}

/** 缺省 traceId：16 字节 crypto 随机数的 32 位小写 hex。 */
export function defaultTraceId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * 日志/错误路径脱敏：三个指纹标头值遮蔽为 `ze-***last4`（大小写不敏感匹配），
 * 其余标头键名与值原样保留（不做额外改写，键大小写保持输入原样）。
 */
export function redactFingerprint(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = FINGERPRINT_KEYS_LOWERCASE.has(key.toLowerCase())
      ? maskFingerprintValue(value)
      : value;
  }
  return out;
}

/** 遮蔽为 `ze-***last4`；值长度 ≤4 时整体遮蔽为 `ze-***`（last4 会反向泄漏全文）。 */
function maskFingerprintValue(value: string): string {
  if (value.length <= 4) {
    return FINGERPRINT_MASK_PREFIX;
  }
  return FINGERPRINT_MASK_PREFIX + value.slice(-4);
}
