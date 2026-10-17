/**
 * PasteBanner —— 粘贴待确认状态行（防误提交状态机）。
 *
 * BI-19 合约（Kimi Code 增强 pi-tui 底座 · 重实现，未读取任何参考源码）：
 * - 粘贴到达（PasteBurst 的 paste 聚合回调）→ 进入 armed 状态，底部显示
 *   `[paste: N chars — Enter 发送 / Esc 取消]`（N 为码点数，CJK 不虚报）；
 * - 状态机：armed 后 Enter = 确认发送（onConfirm(text)，注入回调）、
 *   Esc = 取消（onCancel()），动作后回到 idle；
 * - idle 态不渲染、不消费按键（wantsKey=false 放行下层组件）。
 */

import type { Component } from "./tui-app";
import type { ParsedKey } from "../engine/diff-renderer";
import type { VirtualTerminal } from "../engine/virtual-terminal";

/** 注入回调：粘贴确认 / 取消。 */
export interface PasteBannerCallbacks {
  /** Enter 确认发送：携带整段粘贴文本。 */
  onConfirm?: (text: string) => void;
  /** Esc 取消。 */
  onCancel?: () => void;
}

export class PasteBanner implements Component {
  private readonly callbacks: PasteBannerCallbacks;
  private pendingText: string | null = null;

  constructor(callbacks: PasteBannerCallbacks = {}) {
    this.callbacks = callbacks;
  }

  /** 是否处于待确认（armed）状态。 */
  get armed(): boolean {
    return this.pendingText !== null;
  }

  /** 当前待确认文本（idle 为 null）。 */
  get pending(): string | null {
    return this.pendingText;
  }

  /** 粘贴到达：进入待确认状态（重复到达覆盖前一段）。 */
  acceptPaste(text: string): void {
    this.pendingText = text;
  }

  /** 手动撤销待确认（不触发任何回调）。 */
  dismiss(): void {
    this.pendingText = null;
  }

  handleKey(key: ParsedKey): void {
    const text = this.pendingText;
    if (text === null) return;
    if (key.kind === "enter") {
      this.pendingText = null;
      this.callbacks.onConfirm?.(text);
      return;
    }
    if (key.kind === "esc") {
      this.pendingText = null;
      this.callbacks.onCancel?.();
    }
  }

  /** 仅在 armed 且按键为 Enter/Esc 时消费。 */
  wantsKey(key: ParsedKey): boolean {
    return (
      this.pendingText !== null && (key.kind === "enter" || key.kind === "esc")
    );
  }

  /** armed 时在底部行渲染状态条；idle 不画任何东西。 */
  render(term: VirtualTerminal): void {
    const text = this.pendingText;
    if (text === null) return;
    const chars = [...text].length;
    term.write(
      0,
      term.rows - 1,
      `[paste: ${chars} chars — Enter 发送 / Esc 取消]`,
      { dim: true },
    );
  }
}
