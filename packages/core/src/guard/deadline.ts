/**
 * BI-06.3 — 协作式截止时间预算（Deadline）。
 *
 * 截止预算以绝对到期时刻表示，父子 Deadline 共享同一到期线：
 * child() 派生子预算时继承父剩余预算；请求超出父剩余的子预算会被
 * 钳制到父剩余（子操作不得超越父截止——越界请求被拒绝生效）。
 *
 * 所有时间读取经由可注入 Clock，测试可注入虚拟时钟零等待验证。
 */

/** 可注入时钟抽象：业务代码不直接触达 Date.now / setTimeout。 */
export interface Clock {
  /** 当前虚拟/真实时刻（毫秒）。 */
  now(): number;
  /** 语义对齐全局 setTimeout，返回不透明句柄。 */
  setTimeout(handler: () => void, ms: number): unknown;
  /** 语义对齐全局 clearTimeout。 */
  clearTimeout(handle: unknown): void;
}

/** 真实系统时钟（缺省注入）。 */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** throwIfExpired() 在截止已过时抛出的结构化错误。 */
export class DeadlineExpiredError extends Error {
  readonly code = "DEADLINE_EXPIRED";

  constructor(message = "deadline expired") {
    super(message);
    this.name = "DeadlineExpiredError";
  }
}

/** 截止时间预算（父子继承、不得越界）。 */
export class Deadline {
  constructor(
    /** 绝对到期时刻（毫秒，与 Clock.now() 同一基准）。 */
    readonly expiresAtMs: number,
    private readonly clock: Clock,
  ) {}

  /** 剩余预算毫秒数（已过期则为 0，不为负）。 */
  remainingMs(): number {
    return Math.max(0, this.expiresAtMs - this.clock.now());
  }

  /** 截止是否已到（剩余为 0 即视为过期）。 */
  get expired(): boolean {
    return this.remainingMs() <= 0;
  }

  /** 已过期则抛出 DeadlineExpiredError，否则静默通过。 */
  throwIfExpired(): void {
    if (this.expired) throw new DeadlineExpiredError();
  }

  /**
   * 派生子预算：
   * - 缺省继承父剩余预算（子到期线 = 父到期线）；
   * - 传入 requestedMs 时取 min(requestedMs, 父剩余)——请求超出父剩余
   *   一律钳制到父剩余（子操作不得超越父截止）；
   * - 负数/0 请求得到一个即刻过期的子预算。
   */
  child(requestedMs?: number): Deadline {
    const remaining = this.remainingMs();
    const budget = requestedMs === undefined ? remaining : Math.min(requestedMs, remaining);
    return new Deadline(this.clock.now() + Math.max(0, budget), this.clock);
  }
}

/** 由相对预算 ms 构造 Deadline（clock 缺省为系统时钟；负数按 0 处理）。 */
export function deadlineFrom(ms: number, clock: Clock = systemClock): Deadline {
  return new Deadline(clock.now() + Math.max(0, ms), clock);
}
