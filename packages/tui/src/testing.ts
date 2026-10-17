/**
 * testing —— BI-19 TUI 离屏测试基建（不开真实 TTY）。
 *
 * - FakeClock：手动推进的假时钟；
 * - ManualScheduler：手动触发的定时调度器（配合 FakeClock 全确定性）；
 * - MemoryWriter：内存 ANSI 输出捕获；
 * - enc / emptyReader：字节与空 reader 小工具。
 */

import type { Clock, Scheduler, Timer } from "./engine/paste-burst";
import type { Writer } from "./engine/diff-renderer";

/** 手动推进的假时钟。 */
export class FakeClock implements Clock {
  private t: number;

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  advance(ms: number): void {
    this.t += ms;
  }
}

interface PendingEntry {
  fn: () => void;
  canceled: boolean;
}

/** 手动调度器：排定的回调由测试显式触发（runDue）。 */
export class ManualScheduler implements Scheduler {
  private pending: PendingEntry[] = [];

  schedule(_ms: number, fn: () => void): Timer {
    const entry: PendingEntry = { fn, canceled: false };
    this.pending.push(entry);
    return {
      cancel: () => {
        entry.canceled = true;
      },
    };
  }

  /** 触发当前所有挂起回调（一次性；期间新排定的留给下一次调用）。 */
  runDue(): void {
    const snapshot = [...this.pending];
    this.pending = [];
    for (const entry of snapshot) {
      if (entry.canceled) continue;
      entry.fn();
    }
  }

  /** 挂起回调数（未取消）。 */
  get size(): number {
    return this.pending.filter((e) => !e.canceled).length;
  }
}

/** 内存输出捕获（Writer 注入）。 */
export class MemoryWriter implements Writer {
  chunks: string[] = [];

  write(data: string): void {
    this.chunks.push(data);
  }

  /** 全部输出拼接。 */
  get output(): string {
    return this.chunks.join("");
  }

  /** 输出条数（帧数观察）。 */
  get count(): number {
    return this.chunks.length;
  }

  clear(): void {
    this.chunks = [];
  }
}

/** UTF-8 编码快捷方式。 */
export const enc = new TextEncoder();

/** 空异步 reader（InputLoop 构造占位，测试用 pump 离屏驱动）。 */
export async function* emptyReader(): AsyncIterable<Uint8Array> {
  return;
}
