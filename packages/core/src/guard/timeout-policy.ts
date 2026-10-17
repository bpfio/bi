/**
 * BI-06.3 — 工具调用协作式超时看门狗。
 *
 * 职责与语义（工单钉死）：
 * - ToolTimeoutPolicy：工具限时注册表。内置默认表 web_search=30s / mcp=60s /
 *   python=120s / bash=120s；构造注入 timeouts 按键覆盖（其余键保留默认）；
 *   未知工具落 defaultTimeoutMs（缺省 60s）。
 * - withDeadline：自实现 AbortSignal.deadline 语义——内部 AbortController +
 *   注入 setTimeout，到点 abort（reason=ToolTimeoutError）+ 协作式取消：
 *   fn 接收 (signal, onProgress)，应监听 abort 自行收尾。
 *
 * 到点语义（对齐卡面"模型可自愈重试"）：
 * - 到点时 fn 未自行终止 → 拒绝为结构化 ToolTimeoutError（看门狗兜底，
 *   不等待 fn，挂死也照常拒绝）；
 * - fn 响应 abort 事件提前退出 → 同一 ToolTimeoutError（到点后 fn 的任何
 *   结算一律吞掉，防止 unhandled rejection）；
 * - 未到点时 fn 正常完成/抛错 → 原值/原错误透传。
 * - opts.signal（外部取消）任一时刻 abort（含构造前已 aborted）→ 视同到点，
 *   拒绝同一 ToolTimeoutError；预中止时 fn 不会被调用、定时器不泄漏。
 *
 * 进度语义：onProgress 仅作观测转发（tool/atMs/note），不延长硬截止。
 * 生效限时 = min(deadlineMs ?? timeoutFor(tool), opts.deadline?.remainingMs())，
 * 父 Deadline 已过期时按 0ms 处理（下一拍即超时）。到点即清理定时器；
 * fn 先于到点结算时同样清理，保证注入时钟下无残留定时器。
 */
import { Clock, Deadline, systemClock } from "./deadline";

/** 内置工具限时表（毫秒）。 */
export const DEFAULT_TOOL_TIMEOUTS: Readonly<Record<string, number>> = {
  web_search: 30_000,
  mcp: 60_000,
  python: 120_000,
  bash: 120_000,
};

/** 未知工具的缺省限时（毫秒）。 */
export const DEFAULT_UNKNOWN_TOOL_TIMEOUT_MS = 60_000;

/** 到点/取消时拒绝的结构化超时错误（模型可自愈重试）。 */
export class ToolTimeoutError extends Error {
  readonly code = "TOOL_TIMEOUT";
  readonly tool: string;
  readonly deadlineMs: number;

  constructor(tool: string, deadlineMs: number) {
    super(`tool "${tool}" exceeded deadline of ${deadlineMs}ms`);
    this.name = "ToolTimeoutError";
    this.tool = tool;
    this.deadlineMs = deadlineMs;
  }
}

/** fn 用于上报协作进度的回调（进度不延长硬截止）。 */
export type ProgressReporter = (note?: string) => void;

/** 进度事件（转发给 opts.onProgress）。 */
export interface ToolProgressEvent {
  readonly tool: string;
  readonly atMs: number;
  readonly note?: string;
}

/** 受看门狗监护的工具函数：接收协作取消信号与进度上报回调。 */
export type ToolFn<T> = (
  signal: AbortSignal,
  onProgress: ProgressReporter,
) => Promise<T> | T;

export interface WithDeadlineOptions {
  /** 覆盖注册表限时（毫秒）。 */
  readonly deadlineMs?: number;
  /** 覆盖策略时钟。 */
  readonly clock?: Clock;
  /** 父 Deadline：生效限时取 min(注册表限时, 调用时刻剩余预算)。 */
  readonly deadline?: Deadline;
  /** 外部取消信号：一旦 abort 视同到点处理（结构化 ToolTimeoutError）。 */
  readonly signal?: AbortSignal;
  /** 接收 fn 的进度上报。 */
  readonly onProgress?: (event: ToolProgressEvent) => void;
  /** 到点回调（在拒绝前调用，供调用方清理）。 */
  readonly onTimeout?: () => void;
}

export interface ToolTimeoutPolicyOptions {
  /** 按工具覆盖限时（与内置默认表按键合并，覆盖项优先）。 */
  readonly timeouts?: Record<string, number>;
  /** 未知工具缺省限时。 */
  readonly defaultTimeoutMs?: number;
  /** 可注入时钟（测试加速）。 */
  readonly clock?: Clock;
}

export class ToolTimeoutPolicy {
  readonly #timeouts: Record<string, number>;
  readonly #defaultTimeoutMs: number;
  readonly #clock: Clock;

  constructor(options: ToolTimeoutPolicyOptions = {}) {
    this.#timeouts = { ...DEFAULT_TOOL_TIMEOUTS, ...options.timeouts };
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_UNKNOWN_TOOL_TIMEOUT_MS;
    this.#clock = options.clock ?? systemClock;
  }

  /** 查询工具限时：覆盖项/内置默认表 > 未知工具缺省。 */
  timeoutFor(tool: string): number {
    return this.#timeouts[tool] ?? this.#defaultTimeoutMs;
  }

  /**
   * 在限时看门狗下执行 fn：
   * - 到点：abort 内部信号（reason=ToolTimeoutError）→ onTimeout → 拒绝；
   * - fn 先于到点结算：原值/原错误透传，并清理定时器与外部监听；
   * - 到点后 fn 的迟到结算一律吞掉（promise 已以 ToolTimeoutError 定局）。
   */
  withDeadline<T>(tool: string, fn: ToolFn<T>, opts: WithDeadlineOptions = {}): Promise<T> {
    const clock = opts.clock ?? this.#clock;
    const policyMs = opts.deadlineMs ?? this.timeoutFor(tool);
    const budgetMs = opts.deadline?.remainingMs();
    const effectiveMs = Math.max(0, Math.min(policyMs, budgetMs ?? Number.POSITIVE_INFINITY));

    const reporter: ProgressReporter = (note?: string): void => {
      if (opts.onProgress === undefined) return;
      const event: ToolProgressEvent = { tool, atMs: clock.now() };
      opts.onProgress(note === undefined ? event : { ...event, note });
    };

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const controller = new AbortController();
      const externalSignal = opts.signal;
      let handle: unknown;

      const finish = (commit: () => void): void => {
        if (settled) return;
        settled = true;
        clock.clearTimeout(handle);
        externalSignal?.removeEventListener("abort", onExternalAbort);
        commit();
      };

      const fireDeadline = (): void => {
        if (settled) return;
        const error = new ToolTimeoutError(tool, effectiveMs);
        controller.abort(error);
        opts.onTimeout?.();
        finish(() => reject(error));
      };

      const onExternalAbort = (): void => fireDeadline();

      // 预先已中止的外部信号：不启动 fn，直接按到点拒绝。
      if (externalSignal !== undefined && externalSignal.aborted) {
        fireDeadline();
        return;
      }

      handle = clock.setTimeout(fireDeadline, effectiveMs);

      if (externalSignal !== undefined) {
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      }

      let fnOutcome: Promise<T> | T;
      try {
        fnOutcome = fn(controller.signal, reporter);
      } catch (err) {
        finish(() => reject(err));
        return;
      }

      Promise.resolve(fnOutcome).then(
        (value) => finish(() => resolve(value)),
        (err) => finish(() => reject(err)),
      );
    });
  }
}
