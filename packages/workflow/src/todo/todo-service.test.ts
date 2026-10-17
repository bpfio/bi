/**
 * BI-14.3 · TodoService 测试——流转矩阵、回退拒绝、单 in_progress 约束、
 * 结构化错误、快照隔离。
 */
import { describe, expect, test } from "bun:test";
import { TodoError, TodoService, todoStatusRank } from "./todo-service";

/** 断言同步调用抛出指定 code 的 TodoError。 */
function expectTodoCode(fn: () => unknown, code: TodoError["code"]): TodoError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(TodoError);
  const err = caught as TodoError;
  expect(err.code).toBe(code);
  return err;
}

describe("BI-14.3 · TodoService（工具面 add/update/list）", () => {
  test("add 默认 pending、list 保持插入顺序", () => {
    const svc = new TodoService();
    svc.add("t1", "第一件");
    svc.add("t2", "第二件");
    expect(svc.list()).toEqual([
      { id: "t1", content: "第一件", status: "pending" },
      { id: "t2", content: "第二件", status: "pending" },
    ]);
  });

  test("add 重复 id → duplicate-todo；空 content / 空 id → empty-content", () => {
    const svc = new TodoService();
    svc.add("t1", "第一件");
    expectTodoCode(() => svc.add("t1", "重复"), "duplicate-todo");
    expectTodoCode(() => svc.add("t2", ""), "empty-content");
    expectTodoCode(() => svc.add("", "无 id"), "empty-content");
  });

  test("前进边全放行：pending→in_progress→completed 与 pending→completed 直跳", () => {
    const svc = new TodoService();
    svc.add("a", "任务a");
    svc.add("b", "任务b");
    expect(svc.update("a", "in_progress").status).toBe("in_progress");
    expect(svc.update("a", "completed").status).toBe("completed");
    expect(svc.update("b", "completed").status).toBe("completed"); // 直跳终态合法
  });

  test("completed→pending 拒绝（工单钉死的回退）→ status-regression", () => {
    const svc = new TodoService();
    svc.add("t", "任务");
    svc.update("t", "completed");
    const err = expectTodoCode(() => svc.update("t", "pending"), "status-regression");
    expect(err.message).toContain("completed -> pending");
    expect(svc.list()[0]!.status).toBe("completed"); // 状态未被改动
  });

  test("completed→in_progress（复活）与 in_progress→pending（倒退）同样拒绝", () => {
    const svc = new TodoService();
    svc.add("t", "任务");
    svc.update("t", "in_progress");
    expectTodoCode(() => svc.update("t", "pending"), "status-regression");
    svc.update("t", "completed");
    expectTodoCode(() => svc.update("t", "in_progress"), "status-regression");
  });

  test("同态 update 幂等 no-op（不触发守卫、不报错）", () => {
    const svc = new TodoService();
    svc.add("t", "任务");
    expect(svc.update("t", "pending").status).toBe("pending");
    svc.update("t", "in_progress");
    expect(svc.update("t", "in_progress").status).toBe("in_progress");
    svc.update("t", "completed");
    expect(svc.update("t", "completed").status).toBe("completed");
  });

  test("update 不存在 id → unknown-todo", () => {
    const svc = new TodoService();
    expectTodoCode(() => svc.update("ghost", "in_progress"), "unknown-todo");
  });

  test("单 in_progress 约束：占用中启动另一条 → in-progress-conflict", () => {
    const svc = new TodoService();
    svc.add("a", "任务a");
    svc.add("b", "任务b");
    svc.update("a", "in_progress");
    const err = expectTodoCode(() => svc.update("b", "in_progress"), "in-progress-conflict");
    expect(err.message).toContain('"a"');
    // a 完成后即可启动 b（约束是"同刻至多一条"，不是"全局只许一条"）
    svc.update("a", "completed");
    expect(svc.update("b", "in_progress").status).toBe("in_progress");
  });

  test("同条重复 update in_progress 不自冲突；list 返回副本（外部突变不污染）", () => {
    const svc = new TodoService();
    svc.add("t", "任务");
    svc.update("t", "in_progress");
    expect(svc.update("t", "in_progress").status).toBe("in_progress");
    const snapshot = svc.list();
    snapshot[0]!.status = "completed"; // 外部突变
    expect(svc.list()[0]!.status).toBe("in_progress"); // 内部态不受影响
  });

  test("progress 与 todoStatusRank：单调前进", () => {
    const svc = new TodoService();
    svc.add("a", "任务a");
    svc.add("b", "任务b");
    svc.add("c", "任务c");
    expect(svc.progress()).toEqual([0, 3]);
    svc.update("a", "completed");
    svc.update("b", "in_progress");
    expect(svc.progress()).toEqual([1, 3]);
    svc.update("b", "completed");
    svc.update("c", "completed");
    expect(svc.progress()).toEqual([3, 3]);
    expect(todoStatusRank("pending")).toBeLessThan(todoStatusRank("in_progress"));
    expect(todoStatusRank("in_progress")).toBeLessThan(todoStatusRank("completed"));
  });
});
