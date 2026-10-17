/**
 * BI-07.4 · Live Event Mirror Sink（实时镜像观测总线）。
 *
 * 「只镜不落库」铁律（钉死）：
 * - 子工具事件（tool_call / tool_result）以 `source: "subagent"` 实时外送
 *   全部订阅者（TUI 动效卡片等）；事件发生在落盘之前（tap 点在 runner 的
 *   事件泵内），但镜像流与持久化流**物理分离**——本类不持有任何
 *   sessionWriter 引用，镜像事件绝不回流 JSONL；
 * - 非工具事件（user / assistant / system）不镜像，保持观测面聚焦且小窗。
 *
 * 结构保证：MirrorSink 是纯外送总线 + 有界环形观测缓冲（快照仅供调试），
 * 无任何写盘路径；持久化唯一入口是 runner 注入的 sessionWriter。
 */
import { systemClock, type Clock } from "../guard/deadline";
import type { JsonValue } from "../session/types";
import type { SubagentEventDraft, SubagentMirrorPort } from "./runner";

/** 镜像事件：持久化流中绝不允许出现的形状（测试以此断言零污染）。 */
export interface MirrorEvent {
  readonly source: "subagent";
  readonly childSessionId: string;
  /** 总线单调序号（跨子会话递增）。 */
  readonly seq: number;
  /** 镜像打点（注入时钟）。 */
  readonly at: number;
  readonly type: "tool_call" | "tool_result";
  readonly payload: JsonValue;
  readonly toolCallId?: string;
  readonly toolName?: string;
}

/** 订阅口（TUI 动效卡片等观测方）。 */
export type MirrorListener = (event: MirrorEvent) => void;

export interface MirrorSinkOptions {
  /** 注入时钟（镜像打点；默认系统时钟）。 */
  readonly clock?: Clock;
  /** 环形观测缓冲容量（缺省 256，超出丢最旧）。 */
  readonly capacity?: number;
}

export class MirrorSink implements SubagentMirrorPort {
  readonly #clock: Clock;
  readonly #capacity: number;
  readonly #listeners = new Set<MirrorListener>();
  #ring: MirrorEvent[] = [];
  #seq = 0;
  #listenerErrors = 0;

  constructor(options: MirrorSinkOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#capacity = Math.max(1, options.capacity ?? 256);
  }

  /** 订阅镜像流；返回注销函数（重复注册同一回调以 Set 去重）。 */
  subscribe(listener: MirrorListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * 镜像一个子事件（SubagentMirrorPort 实现）。只镜工具事件；
   * 广播逐监听器隔离：坏监听器抛错只计数，不拖垮其他监听器与子任务。
   */
  mirror(childSessionId: string, event: SubagentEventDraft): void {
    if (event.type !== "tool_call" && event.type !== "tool_result") return;
    this.#seq += 1;
    const mirror: MirrorEvent = {
      source: "subagent",
      childSessionId,
      seq: this.#seq,
      at: this.#clock.now(),
      type: event.type,
      payload: event.payload,
      ...(event.toolCallId !== undefined ? { toolCallId: event.toolCallId } : {}),
      ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
    };
    this.#ring.push(mirror);
    if (this.#ring.length > this.#capacity) {
      this.#ring.shift();
    }
    for (const listener of [...this.#listeners]) {
      try {
        listener(mirror);
      } catch {
        // 单监听器异常隔离：观测面故障绝不反噬子任务运行。
        this.#listenerErrors += 1;
      }
    }
  }

  /** 观测缓冲快照（调试用；镜像流本体是即发即弃的外送）。 */
  snapshot(): readonly MirrorEvent[] {
    return [...this.#ring];
  }

  /** 累计镜像事件数（单调）。 */
  totalMirrored(): number {
    return this.#seq;
  }

  /** 被隔离的监听器异常累计数。 */
  listenerErrors(): number {
    return this.#listenerErrors;
  }
}
