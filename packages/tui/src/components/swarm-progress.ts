/**
 * SwarmProgress —— 多子任务泳道进度（纯渲染，无业务）。
 *
 * BI-19 合约（Kimi Code 增强 pi-tui 底座 · 重实现，未读取任何参考源码）：
 * - 每个任务一行泳道：`任务名 [████----] 3/7`；
 * - 进度条：填充格 = ceil(done/total × barWidth)，夹在 [0, barWidth]；
 *   done=3/total=7/barWidth=8 → `[████----] 3/7`（合约示例一致）；
 * - total=0 视为 0 填充，除零安全。
 */

import type { Component } from "./tui-app";
import type { VirtualTerminal } from "../engine/virtual-terminal";

/** 一个子任务的进度快照。 */
export interface SwarmTask {
  /** 任务名。 */
  name: string;
  /** 已完成步数。 */
  done: number;
  /** 总步数。 */
  total: number;
}

export class SwarmProgress implements Component {
  private tasks: SwarmTask[];
  private readonly barWidth: number;

  constructor(tasks: SwarmTask[] = [], barWidth: number = 8) {
    if (!Number.isInteger(barWidth) || barWidth < 1) {
      throw new RangeError(`barWidth 非法: ${barWidth}`);
    }
    this.tasks = [...tasks];
    this.barWidth = barWidth;
  }

  /** 替换任务集（渲染前随时可更新）。 */
  setTasks(tasks: SwarmTask[]): void {
    this.tasks = [...tasks];
  }

  get snapshot(): readonly SwarmTask[] {
    return [...this.tasks];
  }

  /** 单个任务的进度条文本：`[████----] 3/7`。 */
  bar(task: SwarmTask): string {
    const w = this.barWidth;
    let filled = 0;
    if (task.total > 0 && task.done > 0) {
      filled = Math.ceil((task.done / task.total) * w);
      if (filled > w) filled = w;
    }
    return `[${"█".repeat(filled)}${"-".repeat(w - filled)}] ${task.done}/${task.total}`;
  }

  /** 从 (x, y) 起每任务一行泳道。 */
  render(term: VirtualTerminal, x: number = 0, y: number = 0): void {
    for (let i = 0; i < this.tasks.length; i++) {
      const task = this.tasks[i] as SwarmTask;
      term.write(x, y + i, `${task.name} ${this.bar(task)}`);
    }
  }
}
