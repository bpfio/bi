import { describe, expect, test } from "bun:test";
import { renderMermaid } from "./mermaid-renderer";

describe("renderMermaid —— graph TD 布局", () => {
  test("两节点竖排快照：逐行字符画断言", () => {
    const lines = renderMermaid("graph TD\nA[Start] --> B[End]", { cols: 40 });
    // 层 0 盒（x=15, w=9）、箭头带（x=19）、层 1 盒（x=16, w=7）
    expect(lines).toEqual([
      "",
      " ".repeat(15) + "┌───────┐",
      " ".repeat(15) + "│ Start │",
      " ".repeat(15) + "└───────┘",
      " ".repeat(19) + "│",
      " ".repeat(19) + "│",
      " ".repeat(19) + "v",
      " ".repeat(16) + "┌─────┐",
      " ".repeat(16) + "│ End │",
      " ".repeat(16) + "└─────┘",
      "",
    ]);
  });

  test("边标签 -->|文字| 出现在箭头带中行", () => {
    const lines = renderMermaid("graph TD\nA[Start] -->|yes| B[End]", { cols: 40 });
    expect(lines[5]).toBe(" ".repeat(19) + "│ yes");
    expect(lines[6]).toBe(" ".repeat(19) + "v");
  });

  test("分支布局：同层两节点水平分布，L 形走线", () => {
    const lines = renderMermaid("graph TD\nRoot[A] --> Left[Left]\nRoot --> Right[Right]", { cols: 60 });
    // 分叉行：左角(22) — 13 格横线 — 右角(36)
    expect(lines[4]).toBe(" ".repeat(22) + "+" + "─".repeat(13) + "+");
    // 两个分支盒同一行并排（标签在盒内中部行）
    expect(lines[8]).toContain("│ Left │");
    expect(lines[8]).toContain("│ Right │");
    // 箭头头部落在各分支盒中轴上方一行
    expect(lines[6]).toContain("v");
  });

  test("三层链式逐层下移：layer(y) 严格递增", () => {
    const lines = renderMermaid("graph TD\nA --> B --> C", { cols: 40 });
    expect(lines[4]).toBe(" ".repeat(19) + "│");
    expect(lines[10]).toBe(" ".repeat(19) + "│");
    // C 层盒顶 = 1 + 2*6 = 13
    expect(lines[13]).toBe(" ".repeat(17) + "┌───┐");
    expect(lines[15]).toBe(" ".repeat(17) + "└───┘");
  });

  test("菱形判断节点 { } 以 ◇ 角渲染", () => {
    const lines = renderMermaid("graph TD\nA{Q?} --> B", { cols: 40 });
    expect(lines[1]).toContain("◇");
    expect(lines[2]).toContain("Q?");
  });

  test("圆角节点 ( ) 以 ╭╮╰╯ 渲染", () => {
    const lines = renderMermaid("graph TD\nA(ROUND) --> B", { cols: 40 });
    expect(lines[1]).toContain("╭");
    expect(lines[1]).toContain("╮");
  });

  test("链式单行 + 分号分隔语句均可解析", () => {
    const lines = renderMermaid("graph TD; A --> B --> C", { cols: 40 });
    expect(lines[2]).toContain("│ A │");
    expect(lines[14]).toContain("│ C │");
  });
});

describe("renderMermaid —— graph LR 布局", () => {
  test("水平排布：源盒右缘 → 目标盒左缘的同行箭头", () => {
    const lines = renderMermaid("graph LR\nA[One] --> B[Two]", { cols: 60 });
    // 箭头贴着两盒中部行：源右缘(27) 5 格横线 → '>'(32) → 目标左缘(33)
    expect(lines[2]).toBe(" ".repeat(20) + "│ One │─────>│ Two │");
    expect(lines[1]).toContain("┌─────┐");
    expect(lines[3]).toContain("└─────┘");
  });

  test("LR 分支：两目标左右列排布", () => {
    const lines = renderMermaid("graph LR\nA --> B[Two]\nA --> C[Three]", { cols: 80 });
    // 同列节点垂直堆叠（B 上 C 下），A 在最左列
    const rowsWithB = lines.findIndex((l) => l.includes("Two"));
    const rowsWithC = lines.findIndex((l) => l.includes("Three"));
    expect(rowsWithB).toBeGreaterThanOrEqual(0);
    expect(rowsWithC).toBeGreaterThan(rowsWithB);
    const rowA = lines.findIndex((l) => l.includes("│ A │"));
    expect(rowA).toBeGreaterThanOrEqual(0);
  });
});

describe("renderMermaid —— sequenceDiagram", () => {
  test("双参与者 + 实线消息 + 生命线 + 底部盒", () => {
    const lines = renderMermaid(
      ["sequenceDiagram", "participant Alice", "participant Bob", "Alice->>Bob: Hello", "Bob-->>Alice: Hi"].join("\n"),
      { cols: 60 },
    );
    expect(lines[1]).toContain("│ Alice │");
    expect(lines[1]).toContain("│ Bob │");
    // 消息文字行：文字从源生命线右移 2 格起
    expect(lines[4]).toBe(" ".repeat(22) + "│ Hello" + " ".repeat(9) + "│");
    // 实线：22..38 之间 15 格 ─，头部 > 在目标生命线上
    expect(lines[5]).toBe(" ".repeat(22) + "│" + "─".repeat(15) + ">");
    // 回程虚线，头 < 指回 Alice
    expect(lines[6]).toContain("Hi");
    expect(lines[7]).toBe(" ".repeat(22) + "<" + "╌".repeat(15) + "│");
    // 底部参与者盒
    expect(lines[10]).toContain("│ Alice │");
    expect(lines[10]).toContain("│ Bob │");
  });

  test("participant as 别名生效", () => {
    const lines = renderMermaid(["sequenceDiagram", "participant A as 后端", "participant B", "A->>B: 请求"].join("\n"), {
      cols: 60,
    });
    expect(lines.join("\n")).toContain("后端");
  });

  test("自消息渲染小回环", () => {
    const lines = renderMermaid(["sequenceDiagram", "participant A", "A->>A: loop"].join("\n"), { cols: 40 });
    expect(lines.join("\n")).toContain("loop");
    expect(lines.some((l) => l.includes("┐"))).toBe(true);
    expect(lines.some((l) => l.includes("┘"))).toBe(true);
  });

  test("未声明 participant 由消息自动登记", () => {
    const lines = renderMermaid("sequenceDiagram\nX->>Y: ping", { cols: 60 });
    expect(lines.join("\n")).toContain("X");
    expect(lines.join("\n")).toContain("Y");
  });
});

describe("renderMermaid —— 宽度与健壮性", () => {
  test("CJK 标签盒宽按显示宽度计算", () => {
    const lines = renderMermaid("graph TD\nA[中文] --> B", { cols: 40 });
    expect(lines[1]).toBe(" ".repeat(16) + "┌──────┐");
    expect(lines[2]).toBe(" ".repeat(16) + "│ 中文 │");
  });

  test("超宽标签截断到画布列数内", () => {
    const lines = renderMermaid("graph TD\nA[甲乙丙丁戊己庚辛壬癸] --> B", { cols: 20 });
    const boxLine = lines[2]!;
    expect(boxLine.startsWith("│")).toBe(true);
    expect(boxLine).toContain("庚辛"); // 截到第 8 个字
    expect(boxLine).not.toContain("壬"); // 第 9 字起被截掉
    expect(lines.join("\n")).toContain("│ B │");
  });

  test("不支持语法 → 结构化错误行（不抛异常）", () => {
    const lines = renderMermaid(["graph TD", "A --> B", "C --x D"].join("\n"));
    expect(lines[0]).toBe("⚠ mermaid: unsupported or invalid syntax");
    expect(lines[1]).toBe('  L3: unsupported syntax: "--x D"');
    expect(lines.length).toBe(2);
  });

  test("不支持图型 → 结构化错误行", () => {
    const lines = renderMermaid("pie\n A: 1");
    expect(lines[0]).toBe("⚠ mermaid: unsupported or invalid syntax");
    expect(lines[1]).toBe('  L1: unsupported diagram header: "pie"');
  });

  test("空输入 → 结构化错误行", () => {
    expect(renderMermaid("")).toEqual(["⚠ mermaid: unsupported or invalid syntax", "  L0: empty diagram"]);
    expect(renderMermaid("   \n  %% 仅注释\n")).toEqual([
      "⚠ mermaid: unsupported or invalid syntax",
      "  L0: empty diagram",
    ]);
  });

  test("%% 注释行跳过且行号映射正确", () => {
    const lines = renderMermaid(["%% top comment", "graph TD", "A --> B"].join("\n"), { cols: 40 });
    expect(lines[2]).toContain("│ A │");
    const bad = renderMermaid(["%% c", "graph TD", "A --> B", "C ==>> D"].join("\n"));
    expect(bad[1]).toBe('  L4: unsupported syntax: "==>> D"');
  });

  test("flowchart 关键字与 tb 方向别名等价于 graph TD", () => {
    const a = renderMermaid("flowchart TB\nA --> B", { cols: 40 });
    expect(a[2]).toContain("│ A │");
    expect(a[4]).toContain("│");
  });

  test("多语句边标签链 + 分支混合不炸", () => {
    const lines = renderMermaid(
      ["graph TD", "A[Start] -->|go| B[Mid]", "B --> C", "B --> D", "C --> E[End]"].join("\n"),
      { cols: 60 },
    );
    expect(lines.join("\n")).toContain("Start");
    expect(lines.join("\n")).toContain("go");
    expect(lines.join("\n")).toContain("End");
    expect(lines[0]).not.toContain("⚠");
  });
});
