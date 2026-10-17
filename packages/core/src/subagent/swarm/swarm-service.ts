/**
 * BI-07.8 — 并行子智能体蜂群并发调度器（差异工单）。
 *
 * 职责（工单钉死）：
 * - 模板扇出：每条目渲染 promptTemplate 的 {{item}} 占位（全部出现处替换）；
 * - 派生轻量子代理：经注入 spawnFn 端口（= BI-07.3 SubagentRunner 句柄语义，
 *   生产由宿主装配注入，测试注入 stub）；
 * - 并发槽位池：同 WorkerPool 房规自实现——上限内并行、超限 FIFO 排队
 *   （游标式共享队列：worker 循环取号，单线程事件循环内取号原子）；
 * - 单条超时：复用 BI-06.3 withDeadline（ToolTimeoutPolicy 看门狗，注入 Clock）；
 *   单条超时/失败不拖全群——其余条目照常聚合；
 * - 结果聚合：{ results: [{ item, ok, output, durationMs }], failed: n }，
 *   results 与输入同序（完成序无关）。
 */
import { systemClock, type Clock } from "../../guard/deadline";
import { ToolTimeoutPolicy } from "../../guard/timeout-policy";
import {
	SWARM_DEFAULT_CONCURRENCY,
	SwarmError,
	type SpawnFn,
	type SwarmItemResult,
	type SwarmOptions,
	type SwarmResult,
	renderSwarmPrompt,
	validateSwarmConcurrency,
	validateSwarmTasks,
	validateSwarmTemplate,
	validateSwarmTimeoutMs,
} from "./types";

export type { SpawnFn, SwarmItemResult, SwarmOptions, SwarmResult } from "./types";
export { SwarmError, renderSwarmPrompt, SWARM_DEFAULT_CONCURRENCY, SWARM_MAX_TASKS } from "./types";

export interface SwarmServiceOptions {
  /** 实例级缺省并发上限（调用方可覆盖）。 */
  readonly maxConcurrency?: number;
  /** 实例级缺省单条超时（调用方可覆盖）。 */
  readonly timeoutMs?: number;
  /** 可注入时钟（durationMs 计量与超时看门狗共用）。 */
  readonly clock?: Clock;
}

export class SwarmService {
  readonly #spawnFn: SpawnFn;
  readonly #defaultConcurrency: number;
  readonly #defaultTimeoutMs: number | undefined;
  readonly #clock: Clock;
  readonly #policy: ToolTimeoutPolicy;

  constructor(spawnFn: SpawnFn, options: SwarmServiceOptions = {}) {
    this.#spawnFn = spawnFn;
    this.#defaultConcurrency = validateSwarmConcurrency(
      options.maxConcurrency ?? SWARM_DEFAULT_CONCURRENCY,
    )!;
    this.#defaultTimeoutMs = validateSwarmTimeoutMs(options.timeoutMs);
    this.#clock = options.clock ?? systemClock;
    this.#policy = new ToolTimeoutPolicy({ clock: this.#clock });
  }

  /** 模板扇出 + 槽位池并发执行；results 保持输入顺序。 */
  async swarm(tasks: string[], opts: SwarmOptions): Promise<SwarmResult> {
    const items = validateSwarmTasks(tasks);
    const template = validateSwarmTemplate(opts.promptTemplate);
    const maxConcurrency =
      validateSwarmConcurrency(opts.maxConcurrency) ?? this.#defaultConcurrency;
    const timeoutMs = validateSwarmTimeoutMs(opts.timeoutMs) ?? this.#defaultTimeoutMs;

    const total = items.length;
    const results: Array<SwarmItemResult | undefined> = new Array(total);
    let failed = 0;
    let cursor = 0;

    const runOne = async (item: string): Promise<SwarmItemResult> => {
      const startedAt = this.#clock.now();
      const prompt = renderSwarmPrompt(template, item);
      let ok = true;
      let output = "";
      let error: string | undefined;
      try {
        if (timeoutMs === undefined) {
          output = await this.#spawnFn(prompt);
        } else {
          output = await this.#policy.withDeadline(
            "AgentSwarm",
            () => this.#spawnFn(prompt),
            { deadlineMs: timeoutMs },
          );
        }
      } catch (err) {
        ok = false;
        error = err instanceof Error ? err.message : String(err);
      }
      const durationMs = this.#clock.now() - startedAt;
      if (!ok) failed++;
      const result: SwarmItemResult = { item, ok, output, durationMs };
      return error === undefined ? result : { ...result, error };
    };

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        if (index >= total) return;
        results[index] = await runOne(items[index]!);
      }
    };

    const slots = Math.min(maxConcurrency, total);
    await Promise.all(Array.from({ length: slots }, () => worker()));
    return { results: results as readonly SwarmItemResult[], failed, total };
  }
}
