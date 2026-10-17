/**
 * BI-14.3 · Todo 动态清单服务——单向状态流转 + 进度防漂移守卫。
 *
 * 状态机（显式、单向，与 durable/task-state.ts 同一哲学）：
 *
 *   pending ──▶ in_progress ──▶ completed（终态）
 *       └─────────▶──────────────┘   （pending 可直跳 completed）
 *
 * 合法边（恰 3 条前进边）：pending→in_progress、in_progress→completed、
 * pending→completed。任何回退（completed→pending / completed→in_progress /
 * in_progress→pending）→ 结构化拒绝（TodoError.code="status-regression"），
 * 工单钉死 completed→pending 拒绝；completed 为终态无出边。
 *
 * 进度防漂移守卫：同刻至多一条 in_progress（TodoError.code=
 * "in-progress-conflict"）——清单反映"当前正在做什么"的单一事实，防止多条
 * 并发 in_progress 把进度语义漂移成"全都开着"。同态 update 幂等（no-op）。
 *
 * 工具面：add（新条目恒 pending）/ update（不存在 id → "unknown-todo"）/
 * list（返回深拷贝快照，外部突变不污染内部态）。无删除面（清单即承诺，
 * 删除归后续增强）。
 */

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

/** 结构化 Todo 错误（判别方式：code 字段）。 */
export class TodoError extends Error {
  readonly code:
    | "unknown-todo"
    | "duplicate-todo"
    | "status-regression"
    | "in-progress-conflict"
    | "empty-content";

  constructor(
    code:
      | "unknown-todo"
      | "duplicate-todo"
      | "status-regression"
      | "in-progress-conflict"
      | "empty-content",
    message: string,
  ) {
    super(message);
    this.name = "TodoError";
    this.code = code;
  }
}

/** 转移表：每态列出合法去向（恰 3 条前进边；completed 为终态）。 */
export const TODO_TRANSITIONS: Readonly<Record<TodoStatus, readonly TodoStatus[]>> = {
  pending: ["in_progress", "completed"],
  in_progress: ["completed"],
  completed: [],
};

/** 状态顺序（进度比较用；仅前进方向单调）。 */
const STATUS_ORDER: Readonly<Record<TodoStatus, number>> = {
  pending: 0,
  in_progress: 1,
  completed: 2,
};

export class TodoService {
  readonly #items = new Map<string, TodoItem>();

  /** 新增条目（恒以 pending 起步；重复 id / 空 content → 结构化拒绝）。 */
  add(id: string, content: string): TodoItem {
    if (id.length === 0) {
      throw new TodoError("empty-content", "todo id 不可为空");
    }
    if (content.length === 0) {
      throw new TodoError("empty-content", `todo "${id}" 的 content 不可为空`);
    }
    if (this.#items.has(id)) {
      throw new TodoError("duplicate-todo", `todo "${id}" 已存在`);
    }
    const item: TodoItem = { id, content, status: "pending" };
    this.#items.set(id, item);
    return { ...item };
  }

  /**
   * 状态流转（唯一可变入口）：只放行前进边，回退 → "status-regression"；
   * 同刻至多一条 in_progress，冲突 → "in-progress-conflict"；同态更新幂等
   * no-op；不存在 id → "unknown-todo"。
   */
  update(id: string, status: TodoStatus): TodoItem {
    const item = this.#items.get(id);
    if (item === undefined) {
      throw new TodoError("unknown-todo", `todo "${id}" 不存在`);
    }
    if (item.status === status) {
      return { ...item }; // 同态幂等：不流转、不触发任何守卫
    }
    if (!TODO_TRANSITIONS[item.status].includes(status)) {
      throw new TodoError(
        "status-regression",
        `todo "${id}" 状态回退被拒绝：${item.status} -> ${status}（单向流转，completed 为终态）`,
      );
    }
    if (status === "in_progress") {
      const active = this.#activeId();
      if (active !== null && active !== id) {
        throw new TodoError(
          "in-progress-conflict",
          `todo "${active}" 正在 in_progress，同刻至多一条（先完成或保持，再启动 "${id}"）`,
        );
      }
    }
    const next: TodoItem = { ...item, status };
    this.#items.set(id, next);
    return { ...next };
  }

  /** 快照（插入顺序；深拷贝，外部突变不影响内部态）。 */
  list(): TodoItem[] {
    return [...this.#items.values()].map((item) => ({ ...item }));
  }

  /** 进度：[已完成数, 总数]。 */
  progress(): [completed: number, total: number] {
    const items = [...this.#items.values()];
    const done = items.filter((i) => i.status === "completed").length;
    return [done, items.length];
  }

  /** 当前 in_progress 的条目 id（无 → null）。 */
  #activeId(): string | null {
    for (const item of this.#items.values()) {
      if (item.status === "in_progress") return item.id;
    }
    return null;
  }
}

/** 导出状态序比较（reminder/展示层判定"是否前进"用；单向保证单调）。 */
export function todoStatusRank(status: TodoStatus): number {
  return STATUS_ORDER[status];
}
