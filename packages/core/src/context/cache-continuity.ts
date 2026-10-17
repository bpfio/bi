/**
 * BI-10.3 · 有效视窗输出预留折减与缓存连续性保护。
 *
 * 三件事：
 *  1. effectiveWindow：maxTokens 折减 outputReserve 得有效输入视窗。
 *     公式源唯一性裁定：window-manager 已落 reserve 策略
 *     （defaultOutputReserve = min(64_000, floor(maxTokens/4))），本卡缺省
 *     路径**委托**该函数再包装（effective = max(0, maxTokens − reserve)，
 *     钳制与 WindowManager.effectiveWindow 对齐），不造第二套公式；本卡不
 *     改既有文件（租约 import-only），故「提炼共享函数供其 import」路线
 *     不可行。显式 maxOutputTokens 路径为工单钉死的调用方封顶：
 *     reserve = min(maxOutputTokens, 64_000)——即调用方直接声明输出预算，
 *     与 WindowManager 构造参数 outputReserve 覆盖语义等价。
 *  2. compactRequest：生成紧缩请求。tools 定义**原样保留**（KV 前缀缓存
 *     不被打断——工具 schema 是请求前缀的一部分，重建即失效），仅向消息
 *     尾追加一条指令 user 消息约束「不要调用工具，仅输出摘要」。裁定：
 *     opts 可注入 tools，result.tools 原样（同引用）回传，使「恒等保留」
 *     可被调用方断言；不注入则结果不含 tools 字段。
 *  3. handleOverflowError：识别 400/413 溢出形态（err.status/statusCode/
 *     code，数值或数字串）→ willRetry:true + action:'compact'（走紧缩重
 *     试）；其余（5xx/429/未知/非对象）→ false + 'escalate'。
 */

import { DEFAULT_OUTPUT_RESERVE_CAP, defaultOutputReserve } from "./window-manager";

export interface EffectiveWindowOptions {
  /** 调用方声明的输出 token 预算；缺省走 window-manager 的 quarter 规则。 */
  maxOutputTokens?: number;
}

/**
 * 有效输入视窗 = max(0, maxTokens − outputReserve)。
 * reserve：显式 maxOutputTokens → min(maxOutputTokens, 64_000)；缺省 →
 * window-manager.defaultOutputReserve（唯一策略公式源）。
 *
 * @throws RangeError maxTokens 非有限/负数，或 maxOutputTokens 非有限/负数。
 */
export function effectiveWindow(maxTokens: number, opts?: EffectiveWindowOptions): number {
  if (!Number.isFinite(maxTokens) || maxTokens < 0) {
    throw new RangeError(`maxTokens must be a finite number >= 0, got ${String(maxTokens)}`);
  }
  let reserve: number;
  if (opts?.maxOutputTokens !== undefined) {
    const cap = opts.maxOutputTokens;
    if (!Number.isFinite(cap) || cap < 0) {
      throw new RangeError(`maxOutputTokens must be a finite number >= 0, got ${String(cap)}`);
    }
    reserve = Math.min(cap, DEFAULT_OUTPUT_RESERVE_CAP);
  } else {
    reserve = defaultOutputReserve(maxTokens);
  }
  return Math.max(0, maxTokens - reserve);
}

export interface CompactRequestOptions {
  /** 注入指令区的内容（缺省为「不要调用工具，仅输出摘要」约束文案）。 */
  instruction?: string;
  /**
   * 裁定：调用方可把本次请求的 tools 定义注入以便恒等回传；不注入则
   * 结果不含 tools 字段。本函数对 tools 零改写（同引用回传）。
   */
  tools?: readonly unknown[];
}

export interface CompactRequestResult<T = unknown> {
  /** 原 messages（逐元素原样）+ 追加的指令 user 消息。 */
  messages: T[];
  /** 恒为 true：tools 定义原样保留，KV 前缀缓存不被打断。 */
  preservedToolDefs: true;
  /** 仅当 opts.tools 注入时存在：同引用回传。 */
  tools?: readonly unknown[];
}

/** 缺省紧缩指令（工单钉死语义：不要调用工具，仅输出摘要）。 */
export const DEFAULT_COMPACT_INSTRUCTION =
  "上下文已接近有效视窗上限。不要调用工具，仅输出摘要。";

/**
 * 生成紧缩请求：不改写任何原消息（KV 前缀缓存友好），只在消息尾追加一条
 * 指令 user 消息。泛型保持元素类型（Msg[] 入 → Msg[] 出）。
 */
export function compactRequest<T>(
  messages: readonly T[],
  opts?: CompactRequestOptions,
): CompactRequestResult<T> {
  const instruction = opts?.instruction ?? DEFAULT_COMPACT_INSTRUCTION;
  const appended = { role: "user", content: instruction } as T;
  const result: CompactRequestResult<T> = {
    messages: [...messages, appended],
    preservedToolDefs: true,
  };
  if (opts?.tools !== undefined) {
    result.tools = opts.tools; // 同引用：零改写
  }
  return result;
}

export interface OverflowVerdict {
  willRetry: boolean;
  action: 'compact' | 'escalate';
}

const OVERFLOW_STATUSES = new Set([400, 413]);

/** 从 err 的 status / statusCode / code 提取整数状态码（数值或纯数字串）。 */
function statusOf(err: unknown): number | null {
  if (err === null || typeof err !== "object") return null;
  const rec = err as Record<string, unknown>;
  for (const key of ["status", "statusCode", "code"]) {
    const v = rec[key];
    if (typeof v === "number" && Number.isInteger(v)) return v;
    if (typeof v === "string" && /^\d+$/.test(v)) return Number.parseInt(v, 10);
  }
  return null;
}

/**
 * 溢出判级：400/413（含注入形态）→ { willRetry: true, action: 'compact' }；
 * 其余（5xx、429、无状态、非对象）→ { willRetry: false, action: 'escalate' }。
 */
export function handleOverflowError(err: unknown): OverflowVerdict {
  const status = statusOf(err);
  if (status !== null && OVERFLOW_STATUSES.has(status)) {
    return { willRetry: true, action: "compact" };
  }
  return { willRetry: false, action: "escalate" };
}
