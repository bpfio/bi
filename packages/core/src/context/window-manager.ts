/**
 * BI-10 / BI-10.3（前置）· 上下文视窗用量追踪器：水位事件 + 3 击熔断器。
 *
 * 有效视窗 = maxTokens − outputReserve，outputReserve 默认
 * min(64_000, floor(maxTokens / 4))。
 * 注：此为对齐 BI-10.3 的前置语义；完整 output-reserve 策略归 BI-10.3
 * 全量版，可经构造参数 outputReserve 覆盖本默认。
 *
 * 水位协议（钉死）：
 *  - ratio = promptTokens / effectiveWindow；
 *  - ratio 上行穿越 COMPACT_WATERMARK（0.8）→ 进入告警态并发出**一次性**
 *    上行沿事件（crossedWatermark 消费制，一个水位回合只发一次）；
 *  - ratio 回落至 RESET_WATERMARK（0.35）→ 告警态复位（沿事件重新武装）；
 *    0.35~0.8 之间徘徊：保持当前告警态，不发新沿；
 *  - 每次紧缩记一击；低于水位的用量读数证明紧缩有效，清零连击；
 *    连续 BREAKER_STRIKES（3）击仍高于水位 → 熔断（isTripped），
 *    由 AutoCompactor 以结构化错误上抛。
 */

export const COMPACT_WATERMARK = 0.8;
export const RESET_WATERMARK = 0.35;
export const DEFAULT_OUTPUT_RESERVE_CAP = 64_000;
export const BREAKER_STRIKES = 3;

/** 默认 output reserve：min(64_000, floor(maxTokens / 4))。 */
export function defaultOutputReserve(maxTokens: number): number {
  return Math.min(DEFAULT_OUTPUT_RESERVE_CAP, Math.floor(maxTokens / 4));
}

export interface WatermarkSnapshot {
  promptTokens: number;
  maxTokens: number;
  outputReserve: number;
  effectiveWindow: number;
  ratio: number;
  alertActive: boolean;
  strikes: number;
  tripped: boolean;
}

export interface WindowManagerOpts {
  /** 固定 output reserve 覆盖值；缺省用 defaultOutputReserve。 */
  outputReserve?: number;
}

export class WindowManager {
  private promptTokens = 0;
  private maxTokens = 0;
  private readonly reserveOverride: number | undefined;
  private alertActive = false;
  private pendingCross = false;
  private strikeCount = 0;
  private trippedFlag = false;

  constructor(opts: WindowManagerOpts = {}) {
    if (
      opts.outputReserve !== undefined &&
      (!Number.isFinite(opts.outputReserve) || opts.outputReserve < 0)
    ) {
      throw new RangeError(`outputReserve must be a finite number >= 0, got ${String(opts.outputReserve)}`);
    }
    this.reserveOverride = opts.outputReserve;
  }

  private outputReserveFor(maxTokens: number): number {
    return this.reserveOverride ?? defaultOutputReserve(maxTokens);
  }

  /** 记录最新用量并推进水位状态机。非法（负数/非有限数）输入抛 RangeError。 */
  updateUsage(promptTokens: number, maxTokens: number): void {
    if (!Number.isFinite(promptTokens) || promptTokens < 0) {
      throw new RangeError(`promptTokens must be a finite number >= 0, got ${String(promptTokens)}`);
    }
    if (!Number.isFinite(maxTokens) || maxTokens < 0) {
      throw new RangeError(`maxTokens must be a finite number >= 0, got ${String(maxTokens)}`);
    }
    this.promptTokens = promptTokens;
    this.maxTokens = maxTokens;
    const r = this.ratio();
    if (r >= COMPACT_WATERMARK) {
      if (!this.alertActive) {
        this.alertActive = true;
        this.pendingCross = true; // 上行沿：仅此一处置位（一次性事件）
      }
    } else {
      // 低于水位的读数证明上一次紧缩有效：清零连击。
      this.strikeCount = 0;
      if (this.alertActive && r <= RESET_WATERMARK) {
        this.alertActive = false;
        this.pendingCross = false;
      }
    }
  }

  ratio(): number {
    const eff = this.effectiveWindow();
    if (eff <= 0) return this.promptTokens > 0 ? Number.POSITIVE_INFINITY : 0;
    return this.promptTokens / eff;
  }

  effectiveWindow(): number {
    return Math.max(0, this.maxTokens - this.outputReserveFor(this.maxTokens));
  }

  /** 当前水位是否达到紧缩水位（纯电平语义，与沿事件解耦）。 */
  shouldCompact(): boolean {
    return this.ratio() >= COMPACT_WATERMARK;
  }

  /** 一次性上行沿事件：回合内首次读取返回 true 并复位。 */
  crossedWatermark(): boolean {
    const fired = this.pendingCross;
    this.pendingCross = false;
    return fired;
  }

  /** AutoCompactor 每产出一次紧缩序列即记一击；第 3 击熔断。 */
  recordCompaction(): void {
    this.strikeCount++;
    if (this.strikeCount >= BREAKER_STRIKES) this.trippedFlag = true;
  }

  isTripped(): boolean {
    return this.trippedFlag;
  }

  strikes(): number {
    return this.strikeCount;
  }

  /** 全量复位（水位态、沿事件、连击、熔断、用量读数）。 */
  reset(): void {
    this.promptTokens = 0;
    this.maxTokens = 0;
    this.alertActive = false;
    this.pendingCross = false;
    this.strikeCount = 0;
    this.trippedFlag = false;
  }

  snapshot(): WatermarkSnapshot {
    return {
      promptTokens: this.promptTokens,
      maxTokens: this.maxTokens,
      outputReserve: this.outputReserveFor(this.maxTokens),
      effectiveWindow: this.effectiveWindow(),
      ratio: this.ratio(),
      alertActive: this.alertActive,
      strikes: this.strikeCount,
      tripped: this.trippedFlag,
    };
  }
}
