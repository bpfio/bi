/**
 * chord/state-projection —— 投影层：订阅 DeltaTracker 的 delta 流，
 * 向多订阅者投递 { patches, version, snapshot } 事件。
 *
 * BI-19.7 房规：多订阅者异常隔离——单个订阅者抛错被捕获吞掉，不影响其他
 * 订阅者收信、不影响追踪器 mutate 调用方、不影响后续投递。
 */

import type { DeepReadonly, DeltaTracker, JsonPatch } from "./delta-tracker";

export interface ProjectionEvent<T> {
  patches: JsonPatch[];
  version: number;
  snapshot: DeepReadonly<T>;
}

export type ProjectionSubscriber<T> = (event: ProjectionEvent<T>) => void;

export type Unsubscribe = () => void;

export class Projector<T extends object> {
  readonly #tracker: DeltaTracker<T>;
  readonly #subscribers = new Map<number, ProjectionSubscriber<T>>();
  #nextId = 1;
  #version = 0;
  #unsub: () => void;

  constructor(tracker: DeltaTracker<T>) {
    this.#tracker = tracker;
    this.#unsub = tracker.onDelta((patches) => {
      this.#version += 1;
      const event: ProjectionEvent<T> = {
        patches,
        version: this.#version,
        snapshot: tracker.snapshot(),
      };
      // 异常隔离：快照订阅者列表逐个投递，单点抛错不中断
      for (const sub of [...this.#subscribers.values()]) {
        try {
          sub(event);
        } catch {
          // 房规：订阅者异常吞掉，仅隔离该订阅者自身
        }
      }
    });
  }

  /** 订阅投影事件；返回退订函数。 */
  subscribe(fn: ProjectionSubscriber<T>): Unsubscribe {
    const id = this.#nextId++;
    this.#subscribers.set(id, fn);
    return () => {
      this.#subscribers.delete(id);
    };
  }

  /** 投影已收到的 delta 事件数（与状态实际变更次数一致）。 */
  get version(): number {
    return this.#version;
  }

  /** 当前投影到的状态快照。 */
  get snapshot(): DeepReadonly<T> {
    return this.#tracker.snapshot();
  }

  /** 关闭投影：退订追踪器并清空订阅者。 */
  close(): void {
    this.#unsub();
    this.#subscribers.clear();
  }
}
