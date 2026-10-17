/**
 * 门铃式并发协调器（BI-03.5）——agent 运行环的双边界状态机。
 *
 * 单线程事件循环假设（同 inbox.ts）：相位迁移与边界收割均为同步方法，
 * 门铃派发走微任务，单线程内天然串行，无需锁。
 *
 * 相位机：idle →（beginRun）→ running →（atIdleBoundary）→ settling
 *   → 箱空 → idle（并 resolve awaitIdle / awaitSettlement）
 *   → 箱非空 → 保持 settling（残留工作已交还运行环，由 beginRun 开启下一 run）。
 *
 * 双边界协议（钉死）：
 * - atStepBoundary()：每步末调用，只收割 steer，绝不动 input；
 * - atIdleBoundary()：run 结束时调用，先收割残留 steer 再收割全部 input；
 *   箱空 → idle；input 只在此处与 run 启动拾取（beginRun 返回值）消费，
 *   step boundary 与 run 中途永不触碰；
 * - 门铃只在 idle/settling 触发；running 态 push 静默入箱（由边界收割），
 *   running 态绝不重入派生第二个 run（单飞铁律，beginRun 违规即抛错）。
 *
 * input 的全部消费点（共两处，其余时刻只进不出）：
 * 1. run 启动拾取：beginRun() 返回箱内现存工作（唤醒拉起新 run 的取件点）；
 * 2. idle boundary：atIdleBoundary() 收割残留 steer + 全部 input。
 * steer 的消费点：step boundary（run 中）与上述两处的先手收割。
 *
 * 微任务即串行化点：settling 窗口内的新 push 会响铃，但派发发生在微任务——
 * 此时运行环的 settling 后续（beginRun 或转 idle）已在同步段完成，相位已定，
 * 听众据此决断，天然消除"派生第二个 run"竞态。
 */

import { Inbox, type InboxItemKind, type WakeListener } from "./inbox";

/** 运行环相位。 */
export type RunPhase = "idle" | "running" | "settling";

/** 边界收割/启动拾取结果：先 steer 后 input，两箱分列交还运行环。 */
export interface BoundaryHarvest<T> {
  steers: T[];
  inputs: T[];
}

export interface RunCoordinatorOptions<T> {
  /** 注入既有收件箱（缺省自建；注入时 enqueuedAt 时钟以该收件箱为准）。 */
  inbox?: Inbox<T>;
  /** 注入时钟，转发给自建收件箱用于 enqueuedAt 打点（默认 Date.now）。 */
  clock?: () => number;
}

export class RunCoordinator<T> {
  /** 底层收件箱（公开只读，供高级接线/检视）。 */
  readonly inbox: Inbox<T>;
  #phase: RunPhase = "idle";
  #idleWaiters = new Set<() => void>();
  #settlementWaiters = new Set<() => void>();

  constructor(options: RunCoordinatorOptions<T> = {}) {
    this.inbox = options.inbox ?? new Inbox<T>({ clock: options.clock });
  }

  /** 当前相位（只读）。 */
  phase(): RunPhase {
    return this.#phase;
  }

  /** 提交步内纠偏：入箱；若协调器 idle/settling（闸门开）则响门铃拉起新 run。 */
  submitSteer(payload: T): void {
    this.#submit("steer", payload);
  }

  /** 提交常规输入：入箱；若协调器 idle/settling（闸门开）则响门铃拉起新 run。 */
  submitInput(payload: T): void {
    this.#submit("input", payload);
  }

  /**
   * 运行环开启一个 run：idle/settling → running。关闭门铃闸门、应答残留门铃，
   * 并返回 run 启动拾取（箱内现存工作，steer 在前）——唤醒拉起路径据此一次
   * 调用获得本 run 的工作（通常是触发门铃的那批提交）；从 atIdleBoundary
   * 交还路径续跑时拾取通常为空（残留工作已由收割返回值交付）。
   * running 态调用即单飞铁律违规，抛错（绝不重入派生第二个 run）。
   */
  beginRun(): BoundaryHarvest<T> {
    if (this.#phase === "running") {
      throw new Error("RunCoordinator.beginRun: 单飞铁律违规——run 进行中禁止派生第二个 run");
    }
    this.#phase = "running";
    this.inbox.closeWakeGate();
    this.inbox.clearWake();
    return { steers: this.inbox.takeSteers(), inputs: this.inbox.takeInputs() };
  }

  /**
   * step boundary：每步末调用，只返回 steer 列表（input 不动）。
   * 仅限 running 相位，否则协议违规抛错。
   */
  atStepBoundary(): T[] {
    if (this.#phase !== "running") {
      throw new Error(`RunCoordinator.atStepBoundary: 协议违规——仅限 running 相位（当前 ${this.#phase}）`);
    }
    return this.inbox.takeSteers();
  }

  /**
   * idle boundary：run 结束时调用。先收割残留 steer，再收割全部 input；
   * 箱空 → 相位转 idle 并 resolve awaitIdle 与 awaitSettlement；
   * 箱非空 → 保持 settling，收割结果交还运行环（由 beginRun 开启下一 run）。
   * 仅限 running 相位，否则协议违规抛错。
   */
  atIdleBoundary(): BoundaryHarvest<T> {
    if (this.#phase !== "running") {
      throw new Error(`RunCoordinator.atIdleBoundary: 协议违规——仅限 run 结束时调用（当前 ${this.#phase}）`);
    }
    this.#phase = "settling";
    this.inbox.openWakeGate();
    const steers = this.inbox.takeSteers();
    const inputs = this.inbox.takeInputs();
    if (steers.length === 0 && inputs.length === 0) {
      this.#phase = "idle";
      this.#resolveAll(this.#settlementWaiters);
      this.#resolveAll(this.#idleWaiters);
    } else {
      // run 本体已收尾结算；残留工作交还运行环，awaitIdle 继续等待真正空闲。
      this.#resolveAll(this.#settlementWaiters);
    }
    return { steers, inputs };
  }

  /**
   * 等待当前 run 收尾结算（idle boundary 协议完成）。
   * running 态 → 在下一次 atIdleBoundary 完成时 resolve；
   * idle/settling 态 → 立即 resolve（无进行中的 run）。多 waiter 集合，重复调用安全。
   */
  awaitSettlement(): Promise<void> {
    if (this.#phase !== "running") return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#settlementWaiters.add(resolve);
    });
  }

  /**
   * 等待完全空闲（箱空且相位 idle）。
   * idle 态 → 立即 resolve；否则在下一次箱空转 idle 时 resolve。
   * 多 waiter 集合，重复调用安全。
   */
  awaitIdle(): Promise<void> {
    if (this.#phase === "idle") return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#idleWaiters.add(resolve);
    });
  }

  /** 订阅门铃（运行环据此拉起新 run）；返回注销函数。 */
  onWake(listener: WakeListener): () => void {
    return this.inbox.onWake(listener);
  }

  #submit(kind: InboxItemKind, payload: T): void {
    this.inbox.push(kind, payload);
  }

  #resolveAll(waiters: Set<() => void>): void {
    const snapshot = [...waiters];
    waiters.clear();
    for (const resolve of snapshot) resolve();
  }
}
