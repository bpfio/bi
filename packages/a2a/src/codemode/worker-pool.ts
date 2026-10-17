/**
 * BI-16.1 · 零依赖内存精算沙箱 CodeMode —— 顺序并发池。
 *
 * **定位（v1，文档声明）**：`WorkerPool` 是 promise 队列限流池——限制**同时在飞**
 * 的异步任务数量（并发上限 n 槽，超出的排队），用于批量精算任务限流与错误隔离。
 * 它**不是真 worker 线程并行**：任务仍在当前事件循环上顺序执行，CPU 密集任务
 * 之间不会 multicore 加速。真 worker_threads / 进程级并行归后续卡（文档留位）。
 *
 * 错误隔离：每个任务独立 promise 链，单个任务 reject 只影响其自身调用方，
 * 不污染队列、不阻塞后续任务、不影响池的可用性。
 *
 * @module
 */

export class WorkerPool {
  readonly size: number;

  #active = 0;
  readonly #queue: Array<{
    fn: () => unknown | Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }> = [];

  /** @param size 并发槽数，正整数。 */
  constructor(size: number) {
    if (!Number.isInteger(size) || size < 1) {
      throw new RangeError(`WorkerPool size must be a positive integer, got ${size}`);
    }
    this.size = size;
  }

  /** 当前在飞任务数。 */
  get activeCount(): number {
    return this.#active;
  }

  /** 当前排队任务数。 */
  get pendingCount(): number {
    return this.#queue.length;
  }

  /**
   * 提交一个任务（fn 可同步可异步），按 FIFO 排队，达到并发上限时等待空槽。
   * 返回该任务自己的 promise——它的 reject 只传给它自己（错误隔离）。
   */
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#queue.push({ fn: fn as () => unknown | Promise<unknown>, resolve: resolve as (v: unknown) => void, reject });
      this.#drain();
    });
  }

  /** 等待全部在飞与排队任务清空（含已失败任务；不抛）。轮询实现，v1 简单可靠。 */
  async idle(): Promise<void> {
    while (this.#active > 0 || this.#queue.length > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
  }

  #drain(): void {
    while (this.#active < this.size && this.#queue.length > 0) {
      const job = this.#queue.shift();
      if (job === undefined) break;
      this.#active++;
      // 独立 promise 链 = 错误隔离：reject 只达 job 自己的调用方。
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.#active--;
          this.#drain();
        });
    }
  }
}
