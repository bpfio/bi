/**
 * ReadGroup —— 多文件读取折叠聚合卡。
 *
 * BI-19 合约（Kimi Code 增强 pi-tui 底座 · 重实现，未读取任何参考源码）：
 * - N 个文件读取事件折叠为单行：`Read ×N: a.ts, b.ts (+2 more)`
 *   （默认最多展示 2 个文件名，溢出以 (+k more) 计数）；
 * - 可展开标记：折叠行尾缀 `[+]`，展开态头行尾缀 `[-]`，其下每行一个文件；
 * - 纯渲染组件：不触碰文件系统，只聚合调用方喂入的路径事件。
 */

import type { Component } from "./tui-app";
import type { VirtualTerminal } from "../engine/virtual-terminal";

export class ReadGroup implements Component {
  private files: string[] = [];
  private expanded = false;
  private readonly maxShown: number;

  constructor(maxShown: number = 2) {
    if (!Number.isInteger(maxShown) || maxShown < 1) {
      throw new RangeError(`maxShown 非法: ${maxShown}`);
    }
    this.maxShown = maxShown;
  }

  /** 登记一次文件读取事件（同一路径可重复出现，按事件计数）。 */
  add(path: string): void {
    this.files.push(path);
  }

  /** 已登记的读取事件数。 */
  get count(): number {
    return this.files.length;
  }

  /** 已登记路径（快照）。 */
  get paths(): readonly string[] {
    return [...this.files];
  }

  get isExpanded(): boolean {
    return this.expanded;
  }

  expand(): void {
    this.expanded = true;
  }

  collapse(): void {
    this.expanded = false;
  }

  toggle(): void {
    this.expanded = !this.expanded;
  }

  /** 清空事件（新一轮聚合）。 */
  reset(): void {
    this.files = [];
    this.expanded = false;
  }

  render(term: VirtualTerminal, x: number = 0, y: number = 0): void {
    if (this.files.length === 0) return;
    if (!this.expanded) {
      term.write(x, y, this.collapsedLine());
      return;
    }
    term.write(x, y, `Read ×${this.files.length} [-]`);
    for (let i = 0; i < this.files.length; i++) {
      term.write(x + 2, y + 1 + i, this.files[i] as string);
    }
  }

  /** 折叠单行：`Read ×N: a.ts, b.ts (+2 more) [+]`。 */
  private collapsedLine(): string {
    const n = this.files.length;
    const shown = this.files.slice(0, this.maxShown).join(", ");
    const more = n - this.maxShown;
    const morePart = more > 0 ? ` (+${more} more)` : "";
    return `Read ×${n}: ${shown}${morePart} [+]`;
  }
}
