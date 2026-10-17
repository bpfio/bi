/**
 * BI-20.1 — 四大协作模式选择器 (plan / edit / build / yolo)。
 *
 * 接缝②: 本文件的 plan 态与已关单资产 workflow/src/plan/plan-mode.ts 是
 * 同一实现的两处表面 —— 拦截语义(只读策略)保持一致; /mode 入口归 TUI。
 * 零依赖; 确定性; strict。
 */

/** 四态模式标识, Shift+Tab 沿此顺序循环。 */
export type ModeId = 'plan' | 'edit' | 'build' | 'yolo';

/** 注入端口: 由宿主判定某工具调用是否只读 (plan 态据此拦截写操作)。 */
export interface ReadOnlyPort {
  isReadOnly(tool: string, args: string): boolean;
}

/** 结构化拦截结果。拒绝时 code 固定为 'plan-mode-readonly'。 */
export interface InterceptResult {
  allowed: boolean;
  code?: 'plan-mode-readonly';
  mode: ModeId;
  tool: string;
}

/** 状态变更事件。 */
export interface ModeChangeEvent {
  from: ModeId;
  to: ModeId;
}

export type ModeChangeHandler = (event: ModeChangeEvent) => void;

/** 循环顺序 (钉死): plan -> edit -> build -> yolo -> plan。 */
export const MODE_ORDER: readonly ModeId[] = ['plan', 'edit', 'build', 'yolo'] as const;

/** 模式徽标文本 (确定性, tui/components/mode-indicator.ts 保持同一映射)。 */
export const MODE_LABELS: Record<ModeId, string> = {
  plan: '[plan]',
  edit: '[edit]',
  build: '[build]',
  yolo: '[yolo]',
};

export class ModeSelector {
  private current: ModeId;
  private readonly readOnlyPort: ReadOnlyPort;
  private readonly listeners: ModeChangeHandler[] = [];

  constructor(readOnlyPort: ReadOnlyPort, initial: ModeId = 'plan') {
    this.readOnlyPort = readOnlyPort;
    this.current = initial;
  }

  getMode(): ModeId {
    return this.current;
  }

  /** Shift+Tab 语义: 沿 MODE_ORDER 循环前进一格并触发事件。 */
  cycle(): ModeId {
    const idx = MODE_ORDER.indexOf(this.current);
    const base = idx < 0 ? 0 : idx;
    const next = MODE_ORDER[(base + 1) % MODE_ORDER.length] ?? 'plan';
    this.setMode(next);
    return next;
  }

  /** 直接置位; 仅在实际变化时触发事件回调。 */
  setMode(next: ModeId): void {
    if (next === this.current) {
      return;
    }
    const from = this.current;
    this.current = next;
    for (const listener of [...this.listeners]) {
      listener({ from, to: next });
    }
  }

  /**
   * plan 态经只读端口拦截写操作, 结构化拒绝 plan-mode-readonly;
   * 其余三态不拦截。
   */
  intercept(tool: string, args: string): InterceptResult {
    if (this.current === 'plan' && !this.readOnlyPort.isReadOnly(tool, args)) {
      return { allowed: false, code: 'plan-mode-readonly', mode: 'plan', tool };
    }
    return { allowed: true, mode: this.current, tool };
  }

  /** 注册状态变更回调, 返回退订函数。 */
  onChange(handler: ModeChangeHandler): () => void {
    this.listeners.push(handler);
    return () => {
      const idx = this.listeners.indexOf(handler);
      if (idx >= 0) {
        this.listeners.splice(idx, 1);
      }
    };
  }
}
