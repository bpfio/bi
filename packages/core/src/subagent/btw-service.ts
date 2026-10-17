/**
 * BI-07.6 · /btw 旁路零干扰问答微服务（Side-Channel Query）。
 *
 * 长任务进行中，用户以 `/btw <问题>` 发起无干扰侧向问答：
 * - 派生只读轻量 fork：经 SubagentRunner 派生 explore 角色，工具面以
 *   BTW_TOOL_LOCK 硬锁为 Read/Grep/Glob 三件套（与 profile 白名单求交，
 *   只收不放——profile 未来扩面也不会放大 btw 权限）；
 * - 直接复用现有上下文：getContextSlice 端口注入（主会话上下文切片，
 *   透传给子循环 ctx.contextSlice）；
 * - 主任务零干扰（结构保证，非约定保证）：
 *   · BtwService 内部持有**私有 SubagentRunner**——不接父 outbox、不接镜像，
 *     与主运行环零共享可变状态；
 *   · spawn 不带 parentSessionId → 主会话历史零追加；
 *   · btw 结果只返回调用方，绝不写入主会话/主 outbox；
 * - 并发 ask 串行排队（同一私有 runner 逐个服务，FIFO）。
 */
import { systemClock, type Clock } from "../guard/deadline";
import type { JsonValue } from "../session/types";
import {
  SubagentRunner,
  type LoopFactory,
  type SubagentRunnerDeps,
  type SubagentSessionWriter,
} from "./runner";

/** btw 工具硬锁：只读三件套（工单钉死，硬编码）。 */
export const BTW_TOOL_LOCK: readonly string[] = ["Read", "Grep", "Glob"];

/** 主任务状态快照（只读参考；btw 全程不改写）。 */
export interface BtwMainState {
  /** 主会话 id（getContextSlice 的取料口）。 */
  readonly sessionId: string;
  /** 主循环状态快照（可选；仅随上下文透传，btw 不改写）。 */
  readonly loopState?: string;
}

/** btw 回答（只返回调用方；不落主会话史）。 */
export interface BtwAnswer {
  readonly ok: boolean;
  /** 回答文本（失败时为结构化失败话术）。 */
  readonly answer: string;
  /** 旁路子会话 id（上下文取料失败等未派生场景缺省）。 */
  readonly childSessionId?: string;
  readonly toolCalls: number;
  /** 排队耗时毫秒（入队到出队）。 */
  readonly queuedMs: number;
  readonly error?: string;
}

/** 上下文切片端口：按主会话 id 取现有上下文的 JSON 快照。 */
export type GetBtwContextSlice = (mainSessionId: string) => JsonValue | Promise<JsonValue>;

export interface BtwServiceDeps {
  /** 子循环工厂端口（与主装配共享同一生产循环组合）。 */
  readonly loopFactory: LoopFactory;
  /** 会话写端口（只写旁路子会话；主会话历史由结构保证零触碰）。 */
  readonly sessionWriter: SubagentSessionWriter;
  /** 上下文切片端口（必填）。 */
  readonly getContextSlice: GetBtwContextSlice;
  /** 注入时钟（排队计时；默认系统时钟）。 */
  readonly clock?: Clock;
  /** 旁路子会话 id 生成器（默认 `btw-<uuid7>`）。 */
  readonly generateSessionId?: () => string;
  /** 额外 runner 依赖（测试注入口；生产勿用 outbox/mirror）。 */
  readonly runnerExtras?: Partial<Pick<SubagentRunnerDeps, "extraProfiles">>;
}

export class BtwService {
  /** 私有旁路 runner：无 outbox、无镜像、无父会话归属。 */
  readonly #runner: SubagentRunner;
  readonly #getContextSlice: GetBtwContextSlice;
  readonly #clock: Clock;
  /** 并发排队链：同一时刻至多一个 btw 在服务（FIFO）。 */
  #tail: Promise<unknown> = Promise.resolve();

  constructor(deps: BtwServiceDeps) {
    this.#runner = new SubagentRunner({
      loopFactory: deps.loopFactory,
      sessionWriter: deps.sessionWriter,
      clock: deps.clock ?? systemClock,
      generateSessionId: deps.generateSessionId ?? (() => `btw-${crypto.randomUUID()}`),
      ...deps.runnerExtras,
    });
    this.#getContextSlice = deps.getContextSlice;
    this.#clock = deps.clock ?? systemClock;
  }

  /** 私有旁路 runner（测试/检视；生产装配不消费）。 */
  get runner(): SubagentRunner {
    return this.#runner;
  }

  /**
   * 发起旁路问答。绝不 throw：一切失败折叠为 ok:false 的 BtwAnswer。
   * 并发调用自动串行排队（FIFO），排队期间主任务不受任何影响。
   */
  async ask(question: string, mainState: BtwMainState): Promise<BtwAnswer> {
    if (typeof question !== "string" || question.length === 0) {
      return {
        ok: false,
        answer: "",
        toolCalls: 0,
        queuedMs: 0,
        error: "btw 问题不能为空",
      };
    }
    const enqueuedAt = this.#clock.now();
    const task = this.#tail.then(() => this.#serve(question, mainState, enqueuedAt));
    this.#tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  /** 单次服务：取上下文切片 → 经私有 runner 派生只读轻量子会话。 */
  async #serve(question: string, mainState: BtwMainState, enqueuedAt: number): Promise<BtwAnswer> {
    const queuedMs = Math.max(0, this.#clock.now() - enqueuedAt);
    let slice: JsonValue;
    try {
      slice = await this.#getContextSlice(mainState.sessionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        answer: `[btw] 上下文取料失败: ${message}`,
        toolCalls: 0,
        queuedMs,
        error: message,
      };
    }

    const result = await this.#runner.spawn("explore", question, {
      contextSlice: slice,
      toolLock: BTW_TOOL_LOCK,
      // 不带 parentSessionId：主会话历史零追加（结构保证）。
    });
    return {
      ok: result.ok,
      answer: result.summary,
      childSessionId: result.childSessionId,
      toolCalls: result.toolCalls,
      queuedMs,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }
}
