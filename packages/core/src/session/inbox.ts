/**
 * 双边界会话待办收件箱（BI-03.5）。
 *
 * 单线程事件循环假设：本模块全部并发原语基于 JavaScript 单线程事件循环构建，
 * 不使用任何互斥锁/原子量。`push` / `take*` / `has*` 等同步方法在单线程下天然
 * 原子；唯一的异步行为是门铃（pendingWake）的微任务派发，同一轮同步代码内
 * 不存在交错风险，因此无需锁。
 *
 * 双边界语义（与 RunCoordinator 配合，钉死）：
 * - steer（步内纠偏）：高优先，只在 step boundary 消费；
 * - input（常规输入）：只在 idle boundary 消费；
 * - 门铃：只在门铃闸门开启（对应协调器 idle/settling）时触发，running 态静默。
 *
 * 门铃（doorbell / pendingWake）：
 * - `push` 在闸门开启时同步置位 pendingWake，并通过微任务派发唤醒回调——
 *   消费方零轮询；
 * - 多次 push 合并为一次 wake（防惊群）：同一 pendingWake 纪元内只派发一次；
 * - `clearWake()` 清除待决唤醒（取消尚未派发的门铃）；
 * - 派发时快照当前听众列表并逐个调用（后注册的听众若赶在派发前也能收到）。
 */

/** 待办种类：steer = 步内纠偏高优先；input = 常规排队。 */
export type InboxItemKind = "steer" | "input";

/** 收件箱条目。enqueuedAt 由注入时钟打点（默认 Date.now）。 */
export interface InboxItem<T> {
  kind: InboxItemKind;
  payload: T;
  enqueuedAt: number;
}

/** 门铃回调。 */
export type WakeListener = () => void;

export interface InboxOptions {
  /** 注入时钟，用于条目 enqueuedAt 打点（默认 Date.now）。 */
  clock?: () => number;
}

const ITEM_KINDS: readonly InboxItemKind[] = ["steer", "input"];

export class Inbox<T> {
  readonly #clock: () => number;
  #steers: InboxItem<T>[] = [];
  #inputs: InboxItem<T>[] = [];
  #listeners = new Set<WakeListener>();
  /** 门铃待决标志：true 表示有唤醒待派发（可能尚未派发）。 */
  #pendingWake = false;
  /** 门铃闸门：开启时 push 触发门铃（对应协调器 idle/settling）；关闭时静默（running）。 */
  #wakeGateOpen = true;

  constructor(options: InboxOptions = {}) {
    this.#clock = options.clock ?? Date.now;
  }

  /**
   * 入箱：steer 入高优先箱，input 入常规箱（两箱各自 FIFO）。
   * 条目 enqueuedAt 由注入时钟在入箱瞬间打点。
   * 若门铃闸门开启（idle/settling）且当前无待决唤醒，则同步置位 pendingWake
   * 并调度一次微任务派发（合并语义：同纪元多次 push 只响一次铃）。
   * 闸门关闭（running）时静默入箱，不置位、不派发。
   */
  push(kind: InboxItemKind, payload: T): void {
    if (!ITEM_KINDS.includes(kind)) {
      throw new TypeError(`Inbox.push: 非法 kind: ${String(kind)}`);
    }
    const item: InboxItem<T> = { kind, payload, enqueuedAt: this.#clock() };
    if (kind === "steer") {
      this.#steers.push(item);
    } else {
      this.#inputs.push(item);
    }
    if (this.#wakeGateOpen && !this.#pendingWake) {
      this.#pendingWake = true;
      queueMicrotask(() => this.#dispatchWake());
    }
  }

  /** 取走全部 steer（FIFO，清空性调用），绝不动 input 箱。 */
  takeSteers(): T[] {
    const items = this.#steers;
    this.#steers = [];
    return items.map((item) => item.payload);
  }

  /** 取走至多 n 条 input（FIFO）；n 缺省取全部。绝不动 steer 箱。 */
  takeInputs(n?: number): T[] {
    if (n === undefined) {
      const items = this.#inputs;
      this.#inputs = [];
      return items.map((item) => item.payload);
    }
    if (n <= 0) return [];
    const taken = this.#inputs.slice(0, n);
    this.#inputs = this.#inputs.slice(n);
    return taken.map((item) => item.payload);
  }

  hasSteers(): boolean {
    return this.#steers.length > 0;
  }

  hasInputs(): boolean {
    return this.#inputs.length > 0;
  }

  sizes(): { steers: number; inputs: number } {
    return { steers: this.#steers.length, inputs: this.#inputs.length };
  }

  /** 非消费式检视：当前全部条目的防御性快照（steer 在前，各箱 FIFO），供调试与测试。 */
  snapshot(): InboxItem<T>[] {
    return [...this.#steers, ...this.#inputs].map((item) => ({ ...item }));
  }

  /** 注册门铃听众；返回注销函数。重复注册同一回调以 Set 去重。 */
  onWake(listener: WakeListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** 清除待决唤醒（取消尚未派发的门铃；已派发过则为空操作）。 */
  clearWake(): void {
    this.#pendingWake = false;
  }

  /** 开启门铃闸门（协调器 idle/settling 态）。 */
  openWakeGate(): void {
    this.#wakeGateOpen = true;
  }

  /** 关闭门铃闸门（协调器 running 态：push 静默入箱）。 */
  closeWakeGate(): void {
    this.#wakeGateOpen = false;
  }

  /**
   * 微任务派发：入口校验待决标志（被 clearWake 取消则静默退出），随后消费标志
   * （防陈旧唤醒滞留导致门铃失灵），再校验闸门（闸门已关闭说明协调器已在同步段
   * 应答/接管，跳过响铃），最后快照听众逐个调用。
   * 听众异常不做隔离吞并（fail-fast，消费方应自行兜底）。
   */
  #dispatchWake(): void {
    if (!this.#pendingWake) return;
    this.#pendingWake = false;
    if (!this.#wakeGateOpen) return;
    for (const listener of [...this.#listeners]) {
      listener();
    }
  }
}
