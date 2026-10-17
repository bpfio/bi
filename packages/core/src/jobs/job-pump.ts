/**
 * BI-07.11 — 输出泵（Pump）：异步拉取 runner 的注入 stream 写入 OutputRing。
 *
 * 终结语义：
 * - 流正常耗尽 → done；流抛错 → failed（error 留痕）；stop() 置位（kill 支路）
 *   → 不再写环、终结为 killed；
 * - stop 后到达的 chunk 一律丢弃（写入前置停机位检查）；
 * - pump 只认环与流，不持有任务表——终态落账与唤醒由 JobRegistry 收口
 *   （kill 路径 registry 先落 killed，pump 迟到 outcome 被 finalize 守卫丢弃）。
 */
import type { JobRunner, OutputRing } from "./job-registry";

export interface PumpOutcome {
  status: "done" | "failed" | "killed";
  error?: string;
  /** 已写入环的块数。 */
  chunks: number;
}

export class JobPump {
  readonly #ring: OutputRing;
  #stopped = false;
  #chunks = 0;

  constructor(ring: OutputRing) {
    this.#ring = ring;
  }

  /** 是否已置停机位。 */
  get stopped(): boolean {
    return this.#stopped;
  }

  /** 已写入块数（观测用）。 */
  get chunkCount(): number {
    return this.#chunks;
  }

  /** 置停机位（JobRegistry.kill 调用）：后续 chunk 丢弃，终结为 killed。 */
  stop(): void {
    this.#stopped = true;
  }

  async run(runner: JobRunner): Promise<PumpOutcome> {
    try {
      for await (const chunk of runner.stream) {
        if (this.#stopped) {
          return { status: "killed", chunks: this.#chunks };
        }
        this.#ring.write(chunk);
        this.#chunks++;
      }
    } catch (err) {
      if (this.#stopped) return { status: "killed", chunks: this.#chunks };
      return { status: "failed", error: (err as Error).message, chunks: this.#chunks };
    }
    return this.#stopped
      ? { status: "killed", chunks: this.#chunks }
      : { status: "done", chunks: this.#chunks };
  }
}
