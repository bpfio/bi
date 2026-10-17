/**
 * BI-14.3 · TodoReminder 测试——注入块确定性渲染、进度 N/M、完成态零噪音、
 * 空清单边界、只读不突变。
 */
import { describe, expect, test } from "bun:test";
import { TodoReminder } from "./todo-reminder";
import { TodoService } from "./todo-service";
import type { TodoItem } from "./todo-service";

function buildFixture(): { svc: TodoService; reminder: TodoReminder } {
  const svc = new TodoService();
  svc.add("t1", "先取数");
  svc.add("t2", "再建模");
  svc.add("t3", "后成稿");
  return { svc, reminder: new TodoReminder() };
}

describe("BI-14.3 · TodoReminder（beforeStep 主动注入）", () => {
  test("存在未完成条目 → 确定性注入块（快照精确匹配）", () => {
    const { svc, reminder } = buildFixture();
    svc.update("t1", "in_progress");
    svc.update("t2", "completed");
    const block = reminder.beforeStep(svc.list());
    expect(block).toBe(
      [
        '<todo-reminder progress="1/3">',
        "- [~] t1: 先取数",
        "- [x] t2: 再建模",
        "- [ ] t3: 后成稿",
        "</todo-reminder>",
      ].join("\n"),
    );
  });

  test("进度 N/M 正确（0 完成 → 0/3，全完成走 null 分支前 3/3）", () => {
    const { svc, reminder } = buildFixture();
    expect(reminder.beforeStep(svc.list())).toContain('progress="0/3"');
    svc.update("t1", "completed");
    svc.update("t2", "completed");
    expect(reminder.beforeStep(svc.list())).toContain('progress="2/3"');
    svc.update("t3", "completed");
    expect(reminder.beforeStep(svc.list())).toBeNull(); // 全完成 → 零噪音
  });

  test("渲染确定性：同一 state 两次调用逐字节一致", () => {
    const { svc, reminder } = buildFixture();
    svc.update("t2", "in_progress");
    const first = reminder.beforeStep(svc.list());
    const second = reminder.beforeStep(svc.list());
    expect(first).not.toBeNull();
    expect(first).toBe(second);
  });

  test("空清单 → null（边界零噪音）；只读不突变入参快照", () => {
    const reminder = new TodoReminder();
    expect(reminder.beforeStep([])).toBeNull();
    const { svc } = buildFixture();
    const snapshot: TodoItem[] = svc.list();
    const before = JSON.stringify(snapshot);
    reminder.beforeStep(snapshot);
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  test("仅剩 in_progress 条目也算未完成（有活儿就注入）", () => {
    const { svc, reminder } = buildFixture();
    svc.update("t1", "in_progress");
    const block = reminder.beforeStep(svc.list());
    expect(block).not.toBeNull();
    expect(block).toContain("[~] t1");
  });
});
