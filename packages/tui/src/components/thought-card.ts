/**
 * ThoughtCard —— R1 思考流卡片（折叠/展开两态）。
 *
 * BI-19 合约（Kimi Code 增强 pi-tui 底座 · 重实现，未读取任何参考源码）：
 * - 折叠态：单行显示首行 + `(N lines collapsed)`（N = 思考流总行数）；
 * - 展开态：头行 + 逐行展示全部思考内容；
 * - 纯渲染组件：折叠状态由调用方（或测试）切换。
 */

import type { Component } from "./tui-app";
import type { VirtualTerminal } from "../engine/virtual-terminal";

export class ThoughtCard implements Component {
  private lines: string[];
  private collapsed = true;

  constructor(lines: string[] = []) {
    this.lines = [...lines];
  }

  /** 替换思考流内容（保持当前折叠态）。 */
  setLines(lines: string[]): void {
    this.lines = [...lines];
  }

  get lineCount(): number {
    return this.lines.length;
  }

  get isCollapsed(): boolean {
    return this.collapsed;
  }

  expand(): void {
    this.collapsed = false;
  }

  collapse(): void {
    this.collapsed = true;
  }

  toggle(): void {
    this.collapsed = !this.collapsed;
  }

  render(term: VirtualTerminal, x: number = 0, y: number = 0): void {
    if (this.lines.length === 0) return;
    if (this.collapsed) {
      const first = this.lines[0] as string;
      term.write(x, y, `▸ ${first} (${this.lines.length} lines collapsed)`);
      return;
    }
    term.write(x, y, `▾ thought`);
    for (let i = 0; i < this.lines.length; i++) {
      term.write(x + 2, y + 1 + i, this.lines[i] as string);
    }
  }
}
