/**
 * edit-prompt —— 长提示词外部编辑命令桥。
 *
 * BI-19.5 合约（未读取 /home/yupeng/references/ 下任何源码；设计依据本工单）：
 * - 挂起输入语义：编辑期间挂起本地行编辑输入（onSuspend / onResume 回调
 *   注入；onResume 在 finally 中保证触发——编辑器报错也不吞输入）；
 * - 结果回填校验：空文本（含纯空白）= 取消，返回原稿（reason "empty"）；
 *   编辑器异常 = 取消，返回原稿（reason "editor-error"，不向 TUI 外抛）；
 *   其余提交回填新文本（onSubmitted 回调注入）；
 * - editor 依赖注入（通常为绑定了配置的 editExternally；测试注入 stub）。
 */

import type { EditResult } from "../editor/external-editor";

export type PromptEditOutcome =
  | { readonly status: "submitted"; readonly text: string; readonly modified: boolean }
  | { readonly status: "cancelled"; readonly text: string; readonly reason: "empty" | "editor-error" };

export type PromptCancelReason = "empty" | "editor-error";

export interface EditPromptDeps {
  /** 编辑执行（通常 editExternally 绑定注入；测试注入 stub）。 */
  readonly editor: (text: string) => Promise<EditResult>;
  /** 编辑开始：挂起本地行编辑输入。 */
  readonly onSuspend?: () => void;
  /** 编辑结束（无论成败）：恢复本地行编辑输入（finally 保证）。 */
  readonly onResume?: () => void;
  /** 提交回填。 */
  readonly onSubmitted?: (text: string) => void;
  /** 取消回填（空文本或编辑器异常；draft 为应恢复显示的原稿）。 */
  readonly onCancelled?: (reason: PromptCancelReason, draft: string) => void;
}

/** 挂起输入 → 外部编辑 → 结果回填校验。空文本=取消返回原稿。 */
export async function editPromptCommand(
  currentDraft: string,
  deps: EditPromptDeps,
): Promise<PromptEditOutcome> {
  deps.onSuspend?.();
  try {
    let result: EditResult;
    try {
      result = await deps.editor(currentDraft);
    } catch {
      deps.onCancelled?.("editor-error", currentDraft);
      return { status: "cancelled", text: currentDraft, reason: "editor-error" };
    }
    if (result.text.trim().length === 0) {
      deps.onCancelled?.("empty", currentDraft);
      return { status: "cancelled", text: currentDraft, reason: "empty" };
    }
    deps.onSubmitted?.(result.text);
    return {
      status: "submitted",
      text: result.text,
      modified: result.text !== currentDraft,
    };
  } finally {
    deps.onResume?.();
  }
}
