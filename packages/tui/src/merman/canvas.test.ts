import { describe, expect, test } from "bun:test";
import { Canvas } from "./canvas";

describe("Canvas —— 字符网格", () => {
  test("setCell/text/render 基本写入", () => {
    const c = new Canvas(5, 3);
    c.setCell(0, 0, "x");
    c.text(2, 1, "ab");
    expect(c.render()).toEqual(["x", "  ab", ""]);
  });

  test("CJK 宽字符占两格，后续文本按显示宽度落位", () => {
    const c = new Canvas(8, 1);
    c.text(0, 0, "中文a");
    c.text(5, 0, "b"); // 0-1 中, 2-3 文, 4 a → b 落在第 5 列
    expect(c.render()[0]).toBe("中文ab");
  });

  test("CJK 宽字符不越过右边界（半格丢弃）", () => {
    const c = new Canvas(2, 1);
    c.text(1, 0, "中"); // 需要列 1-2，第 2 列越界 → 整字丢弃
    c.text(0, 0, "中"); // 0-1 恰好放下
    expect(c.render()[0]).toBe("中");
  });

  test("box 方角边框", () => {
    const c = new Canvas(5, 3);
    c.box(0, 0, 5, 3);
    expect(c.render()).toEqual(["┌───┐", "│   │", "└───┘"]);
  });

  test("box 圆角边框", () => {
    const c = new Canvas(4, 3);
    c.box(0, 0, 4, 3, { shape: "rounded" });
    expect(c.render()).toEqual(["╭──╮", "│  │", "╰──╯"]);
  });

  test("box label 居中嵌入盒内中部行", () => {
    const c = new Canvas(9, 3);
    c.box(0, 0, 9, 3, { label: "Start" });
    expect(c.render()[0]).toBe("┌───────┐");
    expect(c.render()[1]).toBe("│ Start │");
  });

  test("box 越界静默忽略不炸", () => {
    const c = new Canvas(3, 3);
    c.box(-2, -2, 40, 40);
    c.setCell(-1, 0, "x");
    c.text(-5, 1, "ab");
    expect(c.render()).toEqual(["", "", ""]);
  });

  test("arrow 水平直线 + 箭头头部", () => {
    const c = new Canvas(6, 1);
    c.arrow(0, 0, 5, 0);
    expect(c.render()[0]).toBe("─────>");
  });

  test("arrow 垂直直线 + 箭头头部", () => {
    const c = new Canvas(1, 4);
    c.arrow(0, 0, 0, 3);
    expect(c.render()).toEqual(["│", "│", "│", "v"]);
  });

  test("arrow 反向水平（左指箭头）", () => {
    const c = new Canvas(6, 1);
    c.arrow(5, 0, 0, 0);
    expect(c.render()[0]).toBe("<─────");
  });

  test("arrow L 形 route=h：先横后竖，角在 (x2,y1)", () => {
    const c = new Canvas(5, 3);
    c.arrow(0, 0, 4, 2, { route: "h" });
    expect(c.render()).toEqual(["────+", "    │", "    v"]);
  });

  test("arrow L 形 route=v：先竖后横，角在 (x1,y2)", () => {
    const c = new Canvas(5, 3);
    c.arrow(0, 0, 4, 2, { route: "v" });
    expect(c.render()).toEqual(["│", "│", "+───>"]);
  });

  test("render 行尾空白裁剪且 CONT 续格不产生多余字符", () => {
    const c = new Canvas(10, 2);
    c.text(0, 0, "汉");
    expect(c.render()).toEqual(["汉", ""]);
    // 汉字 1 个码点占 2 列：续格被跳过，不会渲染成 "汉 "
    expect(c.render()[0]!.length).toBe(1);
  });
});
