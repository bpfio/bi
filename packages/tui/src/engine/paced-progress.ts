/**
 * paced-progress —— 流式进度帧率自适应节流器。
 *
 * BI-19.2 合约（未读取 /home/yupeng/references/ 下任何源码；设计依据本工单）：
 * - 渲染间隔自适应，50ms 基准：上游快（事件间隔 < 50ms）→ 每 50ms 至多
 *   渲染一帧（事件循环保护）；上游慢（本次事件距上次渲染 ≥ 50ms）→ 直通
 *   立即渲染。统一判定式：now - lastRenderAt >= intervalMs（首帧直通）；
 * - 时钟注入：tick/shouldRender 均显式接收 nowMs（测试注入假时钟时间轴，
 *   全离屏确定性，不读系统时钟）；
 * - tick(nowMs)：记录上游推进并给出「此刻是否应当渲染」，判定为是时自动
 *   记录渲染时刻；shouldRender(nowMs)：纯查询，不改任何状态；
 *   nextDue()：下一次允许渲染的绝对时刻；markRendered(nowMs)：调用方以
 *   shouldRender + markRendered 组合使用时的显式记录入口。
 */

/** 默认渲染间隔基准（毫秒）。 */
export const DEFAULT_RENDER_INTERVAL_MS = 50;

export interface PacedProgressOptions {
  /** 渲染间隔基准（毫秒），默认 50；必须为正整数。 */
  readonly intervalMs?: number;
}

/** 帧率自适应节流器：高频上游下保住事件循环，稀疏上游下直通。 */
export class PacedProgress {
  private readonly interval: number;
  private lastRenderAt: number | undefined;
  private lastTick: number | undefined;
  private renderCount = 0;

  constructor(opts: PacedProgressOptions = {}) {
    const intervalMs = opts.intervalMs ?? DEFAULT_RENDER_INTERVAL_MS;
    if (!Number.isInteger(intervalMs) || intervalMs < 1) {
      throw new RangeError(`PacedProgress 间隔非法: ${String(opts.intervalMs)}`);
    }
    this.interval = intervalMs;
  }

  /** 渲染间隔基准（毫秒）。 */
  get intervalMs(): number {
    return this.interval;
  }

  /** 上游最后一次 tick 的时刻（未 tick 过为 undefined）。 */
  get lastTickAt(): number | undefined {
    return this.lastTick;
  }

  /** 最近一次渲染时刻（未渲染过为 undefined）。 */
  get lastRenderedAt(): number | undefined {
    return this.lastRenderAt;
  }

  /** 已发生的渲染次数（观察事件循环保护效果）。 */
  get renders(): number {
    return this.renderCount;
  }

  /** 纯查询：nowMs 时刻是否满足渲染窗口（不改状态）。 */
  shouldRender(nowMs: number): boolean {
    if (this.lastRenderAt === undefined) return true; // 首帧直通
    return nowMs - this.lastRenderAt >= this.interval;
  }

  /**
   * 上游推进一次（每次 push/进度事件调用）。返回此刻是否应当渲染；
   * 为 true 时自动记录渲染时刻（等价随后 markRendered(nowMs)）。
   */
  tick(nowMs: number): boolean {
    this.lastTick = nowMs;
    if (!this.shouldRender(nowMs)) return false;
    this.markRendered(nowMs);
    return true;
  }

  /** 显式记录一次渲染（shouldRender 返回 true 后由调用方调用；tick 已内含）。 */
  markRendered(nowMs: number): void {
    this.lastRenderAt = nowMs;
    this.renderCount += 1;
  }

  /** 下一次允许渲染的绝对时刻；尚未渲染过 = 立即到期（0 基准）。 */
  nextDue(): number {
    return this.lastRenderAt === undefined ? 0 : this.lastRenderAt + this.interval;
  }
}
