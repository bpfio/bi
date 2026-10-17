/**
 * TuiApp —— 组件模型：组件栈 + 帧渲染 + 按键派发。
 *
 * BI-19 合约（Kimi Code 增强 pi-tui 底座 · 重实现，未读取任何参考源码）：
 * - Component 接口：{ render(term: VirtualTerminal): void; handleKey?(key): void }；
 * - TuiApp 持有组件栈：render 顺序为栈底 → 栈顶（后画者覆盖先画者，即栈顶在视觉最上层）；
 * - 按键派发：自栈顶向栈底找第一个「想要该键」的组件（wantsKey 缺省 = 有
 *   handleKey 即消费），调用其 handleKey 并停止——模态语义：状态行（如粘贴
 *   待确认）拦截 Enter/Esc，避免下层组件把回车解释成提交。
 */

import type { VirtualTerminal } from "../engine/virtual-terminal";
import { DiffRenderer } from "../engine/diff-renderer";
import type { ParsedKey, Writer } from "../engine/diff-renderer";

/** TUI 组件最小接口。 */
export interface Component {
  /** 把本组件画到离屏终端网格上（可重叠书写，后画覆盖先画）。 */
  render(term: VirtualTerminal): void;
  /** 可选按键处理。仅当 TuiApp 派发判定本组件消费该键时调用。 */
  handleKey?(key: ParsedKey): void;
  /**
   * 可选按键意愿声明：返回 true 表示本组件要消费该键。
   * 未定义时缺省为 true（定义了 handleKey 即消费所有键）。
   * 状态行类组件在非激活态应返回 false 以放行下层组件。
   */
  wantsKey?(key: ParsedKey): boolean;
}

/** 组件栈宿主：差分渲染 + 按键派发。 */
export class TuiApp {
  private readonly renderer: DiffRenderer;
  private stack: Component[] = [];

  constructor(out: Writer, rows: number = 24, cols: number = 80) {
    this.renderer = new DiffRenderer(out, rows, cols);
  }

  /** 压栈（视觉最上层）。 */
  push(component: Component): void {
    this.stack.push(component);
  }

  /** 弹栈，返回被弹出的组件。 */
  pop(): Component | undefined {
    return this.stack.pop();
  }

  /** 当前栈深。 */
  get depth(): number {
    return this.stack.length;
  }

  /** 渲染一帧：begin → 栈底→栈顶依次画 → end（差分输出）。 */
  render(): void {
    const term = this.renderer.begin();
    for (const component of this.stack) {
      component.render(term);
    }
    this.renderer.end();
  }

  /** 按键派发：自栈顶向下找第一个消费该键的组件。 */
  dispatchKey(key: ParsedKey): void {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const component = this.stack[i] as Component;
      if (component.handleKey === undefined) continue;
      const wants = component.wantsKey?.(key) ?? true;
      if (!wants) continue;
      component.handleKey(key);
      return;
    }
  }

  /** 终端尺寸协商（透传渲染器）。 */
  resize(rows: number, cols: number): void {
    this.renderer.resize(rows, cols);
  }
}
