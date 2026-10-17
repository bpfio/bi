/**
 * nudge-service —— 等待审批超时催办看门狗（桌面通知 + 终端蜂鸣）。
 *
 * BI-19.3 合约（未读取 /home/yupeng/references/ 下任何源码；设计依据本工单）：
 * - 等待审批超时（默认 10min，可配 timeoutMs）触发一次 nudge：
 *   终端蜂鸣 `\a`（BEL，写注入 writer）+ 桌面通知（notifier 注入，
 *   缺省 sendDesktopNotify）；
 * - 一次性防重复：同一 pending 决策只催一次——超时已催后再 beginWait
 *   同一 id 不再重排计时、不再催办；
 * - 审批到达（resolve）取消计时；重复 beginWait（尚未催办）重置计时；
 * - 调度器注入（缺省 setTimeout；测试注入手动调度器全离屏确定性，
 *   复用 engine/paste-burst 的 Scheduler/Timer 契约）。
 */

import { sendDesktopNotify } from "./desktop-notify";
import type { NotifyOutcome } from "./desktop-notify";
import { defaultScheduler } from "../engine/paste-burst";
import type { Scheduler } from "../engine/paste-burst";

/** 默认催办超时：10 分钟。 */
export const DEFAULT_NUDGE_TIMEOUT_MS = 10 * 60 * 1000;

/** 终端蜂鸣字符（BEL，等价 \a）。 */
export const TERMINAL_BELL = "\x07";

/** 终端蜂鸣写入目标（process.stdout 或测试内存缓冲均可注入）。 */
export interface NudgeBellWriter {
  write(data: string): void;
}

/** 桌面通知函数契约（缺省 sendDesktopNotify；测试注入 spy）。 */
export type NudgeNotifier = (title: string, body: string) => NotifyOutcome;

const defaultBell: NudgeBellWriter = {
  write: (data: string) => {
    process.stdout.write(data);
  },
};

const defaultNotifier: NudgeNotifier = (title: string, body: string) =>
  sendDesktopNotify(title, body);

export interface NudgeDeps {
  /** 终端蜂鸣写入目标（缺省 process.stdout；测试注入内存缓冲）。 */
  readonly bell?: NudgeBellWriter;
  /** 桌面通知（缺省 sendDesktopNotify；测试注入 spy）。 */
  readonly notifier?: NudgeNotifier;
  /** 定时调度器（缺省 setTimeout；测试注入手动调度器）。 */
  readonly scheduler?: Scheduler;
  /** 催办超时（毫秒），默认 10min；必须为正整数。 */
  readonly timeoutMs?: number;
  /** 通知标题（缺省「BI 助手」）。 */
  readonly title?: string;
}

export type NudgeStatus = "waiting" | "nudged" | "resolved" | "unknown";

interface NudgeEntry {
  label?: string;
  timer: { cancel(): void } | null;
  status: "waiting" | "nudged" | "resolved";
}

/** 审批等待催办看门狗。 */
export class NudgeService {
  private readonly bell: NudgeBellWriter;
  private readonly notifier: NudgeNotifier;
  private readonly scheduler: Scheduler;
  private readonly timeoutMs: number;
  private readonly title: string;
  private readonly entries = new Map<string, NudgeEntry>();

  constructor(deps: NudgeDeps = {}) {
    this.bell = deps.bell ?? defaultBell;
    this.notifier = deps.notifier ?? defaultNotifier;
    this.scheduler = deps.scheduler ?? defaultScheduler;
    const timeoutMs = deps.timeoutMs ?? DEFAULT_NUDGE_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new RangeError(`NudgeService 超时非法: ${String(deps.timeoutMs)}`);
    }
    this.timeoutMs = timeoutMs;
    this.title = deps.title ?? "BI 助手";
  }

  /** 当前受管决策数（观察用）。 */
  get size(): number {
    return this.entries.size;
  }

  /**
   * 开始等待某决策的审批（开始/重置计时）。
   * 该决策已催办过（nudged）→ 幂等 no-op（一次性防重复）；
   * 尚未催办 → 取消旧计时并按 timeoutMs 重新武装。
   */
  beginWait(id: string, label?: string): void {
    const existing = this.entries.get(id);
    if (existing !== undefined) {
      if (existing.status === "nudged") return;
      if (existing.timer !== null) {
        existing.timer.cancel();
        existing.timer = null;
      }
      existing.status = "waiting";
      existing.label = label ?? existing.label;
      this.arm(existing);
      return;
    }
    const entry: NudgeEntry = { label, timer: null, status: "waiting" };
    this.entries.set(id, entry);
    this.arm(entry);
  }

  /** 审批到达：取消计时并落定为 resolved（未知 id 为 no-op）。 */
  resolve(id: string): void {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    if (entry.timer !== null) {
      entry.timer.cancel();
      entry.timer = null;
    }
    entry.status = "resolved";
  }

  /** 决策状态：waiting（等待中）/ nudged（已催一次）/ resolved / unknown。 */
  statusOf(id: string): NudgeStatus {
    return this.entries.get(id)?.status ?? "unknown";
  }

  /** 某决策是否已催办过（一次性防重复观察口）。 */
  hasNudged(id: string): boolean {
    return this.entries.get(id)?.status === "nudged";
  }

  private arm(entry: NudgeEntry): void {
    entry.timer = this.scheduler.schedule(this.timeoutMs, () => {
      entry.timer = null;
      if (entry.status !== "waiting") return; // 已取消/已催办：不重复
      entry.status = "nudged";
      this.bell.write(TERMINAL_BELL);
      const body = entry.label
        ? `${entry.label} 等待审批超时，请回终端处理`
        : "有决策等待审批超时，请回终端处理";
      this.notifier(this.title, body);
    });
  }
}
