/**
 * `/undo` 撤销候选选择器 —— 类型化命令契约（stub）。
 *
 * 依赖边界（BI-19 将接管）：
 * - 本文件只冻结候选/选择的数据形状与 `openUndoSelector` 的接口签名；
 *   候选列表的终端渲染与键盘交互实现归属 BI-19。
 * - `@bi/tui` 的 package.json 未提供引用 @bi/core 会话域的子路径导出，为
 *   避免改动 package.json，本 stub 的全部类型本地自定义，不 import @bi/core；
 *   BI-19 落地渲染时如需 core 的 UndoResult/UndoCut 等类型，应先补导出
 *   子路径再替换此处同构类型。
 * - 契约：候选 = 撤销轮数 N 及其摘要（将撤销条目数 / 涉及文件数，文件数
 *   为去重后计数）；用户选定返回 UndoSelection，放弃（Esc/取消/关闭）
 *   返回 null。
 */

/** 一个撤销候选：撤销 N 个 user 轮及其摘要。 */
export interface UndoCandidate {
  /** 撤销轮数 N（≥1 的整数）。 */
  n: number;
  /** 该候选将撤销的会话条目数。 */
  entryCount: number;
  /** 该候选涉及的文件数（按快照记录的 filePath 去重）。 */
  fileCount: number;
  /** 摘要文案（候选列表展示用，如「撤销 2 轮 · 4 条 · 2 个文件」）。 */
  summary: string;
}

/** 用户的选择：选定的撤销轮数 N。 */
export interface UndoSelection {
  /** 用户选定的撤销轮数 N（与候选 n 一致）。 */
  n: number;
}

/**
 * 打开撤销候选选择器（stub）。
 *
 * BI-19 接管前为占位实现：不做任何渲染，直接返回 null（等价于用户取消），
 * 保证上层调用方可安全接入而不产生副作用。BI-19 实现渲染后：展示候选 →
 * 用户选定返回 { n }，放弃返回 null。
 */
export async function openUndoSelector(candidates: UndoCandidate[]): Promise<UndoSelection | null> {
  void candidates; // 占位：BI-19 渲染实现将消费候选列表
  return null;
}
