/**
 * editor-history —— D7 编辑器体感强化：KillRing / UndoStack / 字素级 word 导航单测。
 * 纯逻辑，零网络、零 TTY。
 */
import { describe, expect, test } from "bun:test";
import { KillRing, UndoStack, findWordBackward, findWordForward } from "./editor-history";

describe("editor-history · KillRing", () => {
  test("push/peek/rotate：连续 kill 各成条目；yank 取最近", () => {
    const k = new KillRing();
    expect(k.peek()).toBeUndefined();
    k.push("abc", { prepend: false, accumulate: false });
    k.push("def", { prepend: false, accumulate: false });
    expect(k.length).toBe(2);
    expect(k.peek()).toBe("def");
    k.rotate();
    expect(k.peek()).toBe("abc");
    k.rotate();
    expect(k.peek()).toBe("def");
  });

  test("accumulate：连续同方向 kill 累积为单条目", () => {
    const k = new KillRing();
    k.push("x", { prepend: true, accumulate: false });
    k.push("y", { prepend: true, accumulate: true }); // 累积前置
    expect(k.length).toBe(1);
    expect(k.peek()).toBe("yx");
    k.push("z", { prepend: false, accumulate: true }); // 累积追加
    expect(k.peek()).toBe("yxz");
  });

  test("空文本不入环", () => {
    const k = new KillRing();
    k.push("", { prepend: false });
    expect(k.length).toBe(0);
  });
});

describe("editor-history · UndoStack", () => {
  test("push/pop 还原快照；空栈 pop 返回 undefined", () => {
    const u = new UndoStack<{ v: string; c: number }>();
    expect(u.pop()).toBeUndefined();
    u.push({ v: "a", c: 0 });
    u.push({ v: "b", c: 1 });
    expect(u.pop()).toEqual({ v: "b", c: 1 });
    expect(u.pop()).toEqual({ v: "a", c: 0 });
    expect(u.length).toBe(0);
  });
});

describe("editor-history · word 导航", () => {
  test("findWordForward：跳过空白后跨过非空白段", () => {
    expect(findWordForward("hello world", 0)).toBe(5);
    expect(findWordForward("hello world", 6)).toBe(11);
    expect(findWordForward("hello", 5)).toBe(5);
  });

  test("findWordBackward：跳过尾部空白后回退非空白段", () => {
    expect(findWordBackward("hello world", 11)).toBe(6);
    expect(findWordBackward("hello world", 5)).toBe(0);
    expect(findWordBackward("hello", 0)).toBe(0);
  });

  test("CJK 无空白：整段视为单“词”", () => {
    expect(findWordForward("你好世界", 0)).toBe(4);
    expect(findWordBackward("你好世界", 4)).toBe(0);
  });

  test("尾部词删除语义：foo bar 从行尾 ctrl-w 删 “bar”", () => {
    expect(findWordBackward("foo bar", 7)).toBe(4);
  });
});
