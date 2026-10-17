/**
 * BI-14.3 · Todo 进度防漂移守卫——工作流每步前的主动注入块。
 *
 * beforeStep(state)：存在未完成条目时生成确定性注入块（清单快照 + 进度 N/M），
 * 供工作流步骤执行前拼进上下文，纠正执行体对"还剩什么没做"的漂移；全部完成
 * → null（零噪音：完成的清单不再占用任何 prompt 预算）。
 *
 * Prompt Cache 纪律（工单钉死 doc 注明）：本块必须以【尾部追加】形态拼在
 * prompt 末尾——头部/中部插桩会改写已有 token 前缀，打爆 KV 前缀缓存；尾部
 * 追加只延长序列，既有前缀命中不受影响。调用方（引擎步骤/编排层）负责拼接
 * 位置，本模块只产出块文本。
 *
 * 渲染确定性：同一 state 两次调用逐字节一致——条目按入参顺序、checkbox 按
 * 状态固定映射（[x] 完成 / [~] 进行中 / [ ] 待办）、进度 N/M = 已完成/总数；
 * 只读入参，绝不突变调用方的清单快照。
 */
import type { TodoItem } from "./todo-service";

const CHECK_MARK: Readonly<Record<TodoItem["status"], string>> = {
  completed: "[x]",
  in_progress: "[~]",
  pending: "[ ]",
};

export class TodoReminder {
  /**
   * 步骤前注入块：存在未完成条目 → 确定性渲染的清单快照；全 completed 或
   * 空清单 → null（零噪音）。
   */
  beforeStep(state: readonly TodoItem[]): string | null {
    const unfinished = state.some((item) => item.status !== "completed");
    if (!unfinished) return null;
    const total = state.length;
    const done = state.filter((item) => item.status === "completed").length;
    const lines = state.map(
      (item) => `- ${CHECK_MARK[item.status]} ${item.id}: ${item.content}`,
    );
    return [`<todo-reminder progress="${done}/${total}">`, ...lines, "</todo-reminder>"].join(
      "\n",
    );
  }
}
