import { describe, expect, test } from "bun:test";
import { VirtualTerminal } from "./virtual-terminal";

describe("VirtualTerminal —— 构造与网格", () => {
  test("非法尺寸抛 RangeError", () => {
    expect(() => new VirtualTerminal(0, 10)).toThrow(RangeError);
    expect(() => new VirtualTerminal(3, 0)).toThrow(RangeError);
    expect(() => new VirtualTerminal(-1, 5)).toThrow(RangeError);
    expect(() => new VirtualTerminal(2.5, 5)).toThrow(RangeError);
  });

  test("新建即为全空白网格", () => {
    const vt = new VirtualTerminal(2, 4);
    expect(vt.toString()).toBe("    \n    ");
    expect(vt.isRowBlank(0)).toBe(true);
    expect(vt.isRowBlank(1)).toBe(true);
  });

  test("write + toString 基础放置", () => {
    const vt = new VirtualTerminal(3, 5);
    vt.write(0, 0, "hi");
    vt.write(2, 1, "ok");
    expect(vt.toString()).toBe("hi   \n  ok \n     ");
  });

  test("write 不影响未触及行列", () => {
    const vt = new VirtualTerminal(2, 6);
    vt.write(1, 0, "abc");
    expect(vt.rowText(0)).toBe(" abc  ");
    expect(vt.rowText(1)).toBe("      ");
  });

  test("行尾溢出字符被丢弃", () => {
    const vt = new VirtualTerminal(1, 3);
    vt.write(1, 0, "abcdef");
    expect(vt.rowText(0)).toBe(" ab");
  });

  test("text 含 \\n 换行回到下一行行首", () => {
    const vt = new VirtualTerminal(3, 4);
    vt.write(0, 0, "ab\ncd");
    expect(vt.toString()).toBe("ab  \ncd  \n    ");
  });

  test("越界行写入为无操作（不抛异常）", () => {
    const vt = new VirtualTerminal(2, 4);
    vt.write(0, 5, "x");
    expect(vt.toString()).toBe("    \n    ");
  });
});

describe("VirtualTerminal —— CJK 宽字符", () => {
  test("宽字符占两格，第二格为延续占位", () => {
    const vt = new VirtualTerminal(1, 4);
    vt.write(0, 0, "中");
    expect(vt.rowText(0)).toBe("中  "); // 中 + 3 空格（宽尾列在文本中折叠）
    const cells = vt.rowCells(0);
    expect(cells[0]!.char).toBe("中");
    expect(cells[1]!.wideTail).toBe(true);
  });

  test("宽字符置于最后一列退化为空格", () => {
    const vt = new VirtualTerminal(1, 3);
    vt.write(2, 0, "中");
    expect(vt.rowText(0)).toBe("   ");
  });

  test("覆盖宽字符头部 → 尾部占位清空", () => {
    const vt = new VirtualTerminal(1, 4);
    vt.write(0, 0, "中");
    vt.write(0, 0, "a");
    expect(vt.rowText(0)).toBe("a   ");
    expect(vt.rowCells(0)[1]!.wideTail).toBeUndefined();
  });

  test("覆盖宽字符尾部 → 头部清空", () => {
    const vt = new VirtualTerminal(1, 4);
    vt.write(0, 0, "中");
    vt.write(1, 0, "b");
    expect(vt.rowText(0)).toBe(" b  ");
  });

  test("组合字符附着到前一个宿主字符", () => {
    const vt = new VirtualTerminal(1, 4);
    vt.write(0, 0, "e\u0301");
    expect(vt.rowText(0)).toBe("e\u0301   ");
  });

  test("连续 CJK 文本成对占格", () => {
    const vt = new VirtualTerminal(1, 8);
    vt.write(0, 0, "中文");
    expect(vt.rowText(0)).toBe("中文    ");
  });
});

describe("VirtualTerminal —— scroll / clear", () => {
  test("scroll(1) 上滚一行，底部补空白", () => {
    const vt = new VirtualTerminal(3, 3);
    vt.write(0, 0, "a");
    vt.write(0, 1, "b");
    vt.write(0, 2, "c");
    vt.scroll(1);
    expect(vt.toString()).toBe("b  \nc  \n   ");
  });

  test("scroll(0) 与 scroll(负数) 无操作", () => {
    const vt = new VirtualTerminal(2, 2);
    vt.write(0, 0, "x");
    vt.scroll(0);
    vt.scroll(-3);
    expect(vt.rowText(0)).toBe("x ");
  });

  test("scroll(n ≥ rows) 等价 clear", () => {
    const vt = new VirtualTerminal(2, 3);
    vt.write(0, 0, "x");
    vt.scroll(5);
    expect(vt.toString()).toBe("   \n   ");
  });

  test("clear 清空整屏", () => {
    const vt = new VirtualTerminal(2, 3);
    vt.write(0, 0, "hello");
    vt.clear();
    expect(vt.isRowBlank(0)).toBe(true);
  });
});

describe("VirtualTerminal —— diff 三态", () => {
  test("unchanged / changed / erase 三态判定", () => {
    const src = new VirtualTerminal(3, 5);
    src.write(0, 0, "aaa");
    src.write(0, 1, "bbb");
    src.write(0, 2, "ccc");
    const dst = new VirtualTerminal(3, 5);
    dst.write(0, 0, "aaa"); // unchanged
    dst.write(0, 1, "zzz"); // changed
    // row2 留空 → erase
    const ops = src.diff(dst);
    expect(ops).toEqual([
      { kind: "unchanged", row: 0 },
      { kind: "changed", row: 1, text: "zzz  " },
      { kind: "erase", row: 2 },
    ]);
  });

  test("changed.text 携带目标行文本", () => {
    const src = new VirtualTerminal(1, 6);
    const dst = new VirtualTerminal(1, 6);
    dst.write(0, 0, "hello");
    expect(src.diff(dst)).toEqual([
      { kind: "changed", row: 0, text: "hello " },
    ]);
  });

  test("样式变化判为 changed", () => {
    const a = new VirtualTerminal(1, 3);
    a.write(0, 0, "hi");
    const b = new VirtualTerminal(1, 3);
    b.write(0, 0, "hi", { bold: true });
    const ops = a.diff(b);
    expect(ops[0]!.kind).toBe("changed");
  });

  test("尺寸不匹配抛 RangeError", () => {
    const a = new VirtualTerminal(2, 4);
    const b = new VirtualTerminal(3, 4);
    expect(() => a.diff(b)).toThrow(RangeError);
  });

  test("自身 diff 自身为全 unchanged", () => {
    const vt = new VirtualTerminal(2, 3);
    vt.write(0, 0, "中");
    const ops = vt.diff(vt);
    expect(ops).toEqual([
      { kind: "unchanged", row: 0 },
      { kind: "unchanged", row: 1 },
    ]);
  });
});
