/**
 * BI-20.1 — TUI 表面: 模式徽标纯渲染。
 *
 * 与 core/src/modes/mode-selector.ts 的 MODE_LABELS 保持同一映射
 * (结构等价的字符串联合, 避免跨包导出耦合; 两侧测试钉死一致)。
 * 纯函数, 确定性输出, 零依赖。
 */

/** 与 core ModeId 结构等价的本地联合类型。 */
export type IndicatorMode = 'plan' | 'edit' | 'build' | 'yolo';

const BADGES: Record<IndicatorMode, string> = {
  plan: '[plan]',
  edit: '[edit]',
  build: '[build]',
  yolo: '[yolo]',
};

/** 返回当前模式徽标, 如 `[plan]`。 */
export function renderModeIndicator(mode: IndicatorMode): string {
  return BADGES[mode];
}
