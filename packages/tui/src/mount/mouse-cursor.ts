/**
 * TUI-ALIGN-4b —— 鼠标点击 → 提示行光标换算（kimi input.ts handleMouse 对齐）。
 *
 * 背景：InputLoop 把 SGR 左键按下解析为 `{ kind: "mouse-click", x, y }`（0 基
 * 终端坐标，diff-renderer.ts parseSgrMouse）；本模块把落点坐标换算为编辑器
 * 光标（UTF-16 码元下标）。与 kimi 的差异：bi 为 inline 架构，提示行恒在底行
 * （rows-1），行判定用 promptRow 而非 kimi 的 y===0；光标条 ▏ 为插入式占列
 * （kimi 为原位反显不占列），落点在光标右侧时换算需扣回 1 列。
 *
 * 语义（点击落点矩阵，v1）：
 * - 行判定：点击行 ≠ promptRow → undefined（转录区 / 状态行点击忽略）；
 * - 非 mouse-click 事件 → undefined（防御，调用方只应传点击）；
 * - 列换算：可见列 = max(0, 屏列 − 前缀宽 2)；目标显示列 = 窗口起始列 + 可见列，
 *   落点屏列超过光标显示列时扣回光标条占的 1 列（bar shift）；
 * - 字素定位：按字素宽度步行——目标列落在宽字符右半 → 对齐该字素码元起点；
 *   目标列 ≥ 草稿总显示宽 → 贴草稿末尾；空草稿 → 0；点中前缀 ❯ → 窗口起点；
 * - 换行：草稿经摊平（\r\n?/\n → ⏎，与 layoutPromptLine 同语义）后按显示列
 *   定位，再经 map 映射回草稿码元（⏎ 位映射到换行序列起点，即 \r/\n 之前）。
 *
 * 纯函数，零 TTY 依赖：InputLoop pump + 本函数即可端到端离屏测试。
 */

import { PROMPT_PREFIX_WIDTH, promptLineWindow, segmentGraphemes, textWidth } from "../components/cjk-width";
import type { ParsedKey } from "../engine/diff-renderer";

/** 换算上下文：编辑器草稿内态 + 提示行布局参数。 */
export interface PromptClickLayout {
  /** 当前草稿（编辑器内态；多行草稿含换行原样）。 */
  readonly draft: string;
  /** 当前光标（UTF-16 码元下标；决定横滚窗口位置，即当前渲染窗口）。 */
  readonly cursor: number;
  /** 终端列数。 */
  readonly cols: number;
  /** 提示行所在行（0 基；inline 架构恒为 rows-1）。 */
  readonly promptRow: number;
}

/**
 * 提示行点击 → 目标光标（UTF-16 码元下标，0..draft.length）。
 * 返回 undefined = 本次点击不移动光标（非提示行 / 非点击事件）。
 */
export function promptClickToCursor(click: ParsedKey, layout: PromptClickLayout): number | undefined {
  if (click.kind !== "mouse-click") return undefined;
  const x = click.x ?? 0;
  const y = click.y ?? 0;
  if (y !== layout.promptRow) return undefined; // 转录区 / 状态行：忽略
  const { draft, cursor, cols } = layout;
  const win = promptLineWindow(draft, cursor, cols);
  // 输入区可见列（点中前缀 ❯ 或其左 → 0）。
  const visibleCol = Math.max(0, x - PROMPT_PREFIX_WIDTH);
  // 光标条 ▏ 插入式占 1 列：落点屏列超过光标列时，其后文本整体右移 1，换算扣回。
  const shifted = visibleCol > win.cursorCol - win.startCol;
  const targetCol = win.startCol + visibleCol - (shifted ? 1 : 0);
  const { flat, map } = flattenDraft(draft);
  let acc = 0;
  for (const g of segmentGraphemes(flat)) {
    const w = textWidth(g.segment);
    if (targetCol < acc + w) return map[g.index] ?? 0; // 宽字符右半落点 → 字素码元起点
    acc += w;
  }
  return draft.length; // 超出草稿显示宽度（含空草稿）：贴末尾
}

/**
 * 显示摊平 + 码元映射（与 cjk-width.displayDraftLine 同语义的本地副本：
 * \r\n?/\n → ⏎）。map[i] = 摊平稿第 i 个码元对应的草稿码元下标（换行序列
 * 起点；\r\n 两码元共享同一个 ⏎ 位）。
 */
function flattenDraft(draft: string): { flat: string; map: readonly number[] } {
  let flat = "";
  const map: number[] = [];
  const re = /\r\n?|\n/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(draft)) !== null) {
    for (let i = last; i < m.index; i++) {
      flat += draft[i];
      map.push(i);
    }
    flat += "⏎";
    map.push(m.index);
    last = m.index + m[0].length;
  }
  for (let i = last; i < draft.length; i++) {
    flat += draft[i];
    map.push(i);
  }
  return { flat, map };
}
