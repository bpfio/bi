/**
 * TUI-ALIGN-4b —— 鼠标点击 → 提示行光标换算验收（kimi input.ts handleMouse 对齐）。
 *
 * 覆盖（工单用例集）：
 * 1. 行首：点中前缀 ❯ / 左半 / 光标条 → 光标 0（窗口未滚）；
 * 2. 行中：光标条左右两侧逐列换算（含 ▏ 占列扣回）；
 * 3. 横滚窗口两侧边界：滚后点窗口首列/末列/越界列 / 点前缀 → 窗口起点；
 * 4. CJK 宽字符对齐：左右两半均落字素码元起点；
 * 5. 超末尾：落点超出草稿显示宽 → 贴末尾；空前缀区同 0；
 * 6. 空草稿：任意提示行落点 → 0；
 * 7. 行判定：非提示行（转录区/状态行）→ undefined；非 mouse-click 事件 → undefined；
 * 8. 换行摊平：\n → ⏎ 位映射回换行序列起点（多行草稿）。
 */

import { describe, expect, test } from "bun:test";

import { promptClickToCursor, type PromptClickLayout } from "./mouse-cursor";
import { layoutPromptLine } from "../components/cjk-width";
import type { ParsedKey } from "../engine/diff-renderer";

function click(x: number, y: number): ParsedKey {
  return { kind: "mouse-click", x, y };
}

/** rows=6 → 提示行 = 第 5 行（0 基）。 */
const ROW = 5;

function layout(draft: string, cursor: number, cols = 60): PromptClickLayout {
  return { draft, cursor, cols, promptRow: ROW };
}

describe("TUI-ALIGN-4b · promptClickToCursor 行首/行中", () => {
  test("行首：点中前缀/光标条/首字符左半 → 0；逐字符推进", () => {
    const L = layout("abcdefghij", 0);
    expect(promptClickToCursor(click(0, ROW), L)).toBe(0); // 前缀 ❯ 左
    expect(promptClickToCursor(click(1, ROW), L)).toBe(0); // 前缀右格
    expect(promptClickToCursor(click(2, ROW), L)).toBe(0); // 光标条 ▏ 列
    expect(promptClickToCursor(click(3, ROW), L)).toBe(0); // 'a'（条右移 1 列）
    expect(promptClickToCursor(click(4, ROW), L)).toBe(1); // 'b'
    expect(promptClickToCursor(click(6, ROW), L)).toBe(3); // 'd'
  });

  test("行中：光标条两侧逐列换算（▏ 占列扣回；条上=原位）", () => {
    const L = layout("abcdefghij", 5); // 渲染 ❯ abcde▏fghij
    expect(layoutPromptLine("abcdefghij", 5, 60)).toBe("❯ abcde▏fghij");
    expect(promptClickToCursor(click(2, ROW), L)).toBe(0); // 'a'
    expect(promptClickToCursor(click(6, ROW), L)).toBe(4); // 'e'（条左）
    expect(promptClickToCursor(click(7, ROW), L)).toBe(5); // 条上 = 光标原位
    expect(promptClickToCursor(click(8, ROW), L)).toBe(5); // 'f'（条右 1 格）
    expect(promptClickToCursor(click(9, ROW), L)).toBe(6); // 'g'
    expect(promptClickToCursor(click(12, ROW), L)).toBe(9); // 'j'
    expect(promptClickToCursor(click(13, ROW), L)).toBe(10); // 越界 → 贴末尾
  });

  test("CJK：宽字符左右两半均对齐该字素码元起点", () => {
    const L = layout("中文测试", 0); // 渲染 ❯ ▏中文测试（中@3-4 文@5-6 测@7-8 试@9-10）
    expect(promptClickToCursor(click(3, ROW), L)).toBe(0); // 中 左半
    expect(promptClickToCursor(click(4, ROW), L)).toBe(0); // 中 右半 → 起点 0
    expect(promptClickToCursor(click(5, ROW), L)).toBe(1); // 文 左半
    expect(promptClickToCursor(click(6, ROW), L)).toBe(1); // 文 右半 → 起点 1
    expect(promptClickToCursor(click(9, ROW), L)).toBe(3); // 试 左半
    expect(promptClickToCursor(click(10, ROW), L)).toBe(3); // 试 右半 → 起点 3
    expect(promptClickToCursor(click(11, ROW), L)).toBe(4); // 超末尾 → 贴尾
  });

  test("CJK 行中：条右移后点击右侧汉字仍对齐字素起点", () => {
    const L = layout("中文", 1); // 渲染 ❯ 中▏文（中@2-3 条@4 文@5-6）
    expect(layoutPromptLine("中文", 1, 60)).toBe("❯ 中▏文");
    expect(promptClickToCursor(click(3, ROW), L)).toBe(0); // 中 右半 → 起点 0
    expect(promptClickToCursor(click(4, ROW), L)).toBe(1); // 条上 = 原位
    expect(promptClickToCursor(click(5, ROW), L)).toBe(1); // 文 左半（条右移扣回）
    expect(promptClickToCursor(click(6, ROW), L)).toBe(1); // 文 右半 → 起点 1
  });
});

describe("TUI-ALIGN-4b · promptClickToCursor 横滚窗口边界", () => {
  // cols=20 → 可用列 17；草稿 30  ASCII，光标在尾 → 窗口起点列 22（'w'）。
  const wide = "abcdefghijklmnopqrstuvwxyz0123"; // 30 chars
  const L = layout(wide, wide.length, 20); // 渲染 ❯ wxyz0123▏（w@2 … 3@9 条@10）
  test("窗口左边界：点首列/前缀 → 窗口起点（非草稿首）", () => {
    expect(layoutPromptLine(wide, wide.length, 20)).toBe("❯ wxyz0123▏");
    expect(promptClickToCursor(click(2, ROW), L)).toBe(22); // 'w' 窗口首列
    expect(promptClickToCursor(click(0, ROW), L)).toBe(22); // 点前缀 → 窗口起点
    expect(promptClickToCursor(click(1, ROW), L)).toBe(22);
  });

  test("窗口右边界：点末列/条/越界列 → 贴草稿末尾", () => {
    expect(promptClickToCursor(click(9, ROW), L)).toBe(29); // '3' 窗口末列
    expect(promptClickToCursor(click(10, ROW), L)).toBe(30); // 条上（光标在尾）
    expect(promptClickToCursor(click(11, ROW), L)).toBe(30); // 窗口右界外
    expect(promptClickToCursor(click(40, ROW), L)).toBe(30); // 远端越界
  });

  test("窗口内中部落点：按可见列换算", () => {
    expect(promptClickToCursor(click(5, ROW), L)).toBe(25); // 'z'
    expect(promptClickToCursor(click(6, ROW), L)).toBe(26); // '0'
  });
});

describe("TUI-ALIGN-4b · promptClickToCursor 空草稿/超末尾/行判定", () => {
  test("空草稿：任意提示行落点 → 0", () => {
    const L = layout("", 0);
    expect(promptClickToCursor(click(0, ROW), L)).toBe(0);
    expect(promptClickToCursor(click(30, ROW), L)).toBe(0);
  });

  test("超末尾：短草稿远端落点贴末尾", () => {
    const L = layout("abc", 3);
    expect(promptClickToCursor(click(5, ROW), L)).toBe(3);
    expect(promptClickToCursor(click(200, ROW), L)).toBe(3);
  });

  test("行判定：非提示行（转录区/状态行）→ undefined", () => {
    const L = layout("abc", 3);
    expect(promptClickToCursor(click(3, 4), L)).toBeUndefined(); // 转录区
    expect(promptClickToCursor(click(3, 0), L)).toBeUndefined(); // 顶部行
    expect(promptClickToCursor(click(3, ROW), L)).toBe(1); // 提示行本体：x=3 命中 'b' → 码元 1
  });

  test("非 mouse-click 事件 → undefined（防御）", () => {
    const L = layout("abc", 3);
    expect(promptClickToCursor({ kind: "char", char: "a" }, L)).toBeUndefined();
    expect(promptClickToCursor({ kind: "wheel-up" }, L)).toBeUndefined();
  });

  test("换行摊平：⏎ 位映射到换行序列起点", () => {
    const L = layout("甲\n乙", 3); // 渲染 ❯ 甲⏎乙▏（甲@2-3 ⏎@4 乙@5-6 条@7）
    expect(layoutPromptLine("甲\n乙", 3, 60)).toBe("❯ 甲⏎乙▏");
    expect(promptClickToCursor(click(4, ROW), L)).toBe(1); // ⏎ 位 → 换行前（码元 1）
    expect(promptClickToCursor(click(5, ROW), L)).toBe(2); // 乙 左半 → 码元 2
    expect(promptClickToCursor(click(6, ROW), L)).toBe(2); // 乙 右半 → 码元 2
    expect(promptClickToCursor(click(7, ROW), L)).toBe(3); // 条上（尾）
  });

  test("换行 + 行中光标：条右移扣回后落点仍正确", () => {
    const L = layout("甲\n乙", 2); // 渲染 ❯ 甲⏎▏乙（条@5 乙@6-7）
    expect(layoutPromptLine("甲\n乙", 2, 60)).toBe("❯ 甲⏎▏乙");
    expect(promptClickToCursor(click(4, ROW), L)).toBe(1); // ⏎ 位
    expect(promptClickToCursor(click(5, ROW), L)).toBe(2); // 条上 = 原位
    expect(promptClickToCursor(click(6, ROW), L)).toBe(2); // 乙 左半（扣回条列）
    expect(promptClickToCursor(click(7, ROW), L)).toBe(2); // 乙 右半
  });
});
