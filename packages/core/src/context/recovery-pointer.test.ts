/**
 * BI-10.1 · recovery-pointer 测试。
 *
 * 覆盖：块渲染快照（字段序固定）、区间记录与边界（空 window / 乱序自动
 * 排序 / 校验抛错）、确定性两次渲染逐字节相等、行号 1 基语义、
 * RecoveryIndex 链式登记与 footer 同构。
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RECOVERY_TIP,
  RecoveryIndex,
  buildRecoveryFooter,
  type RecoveryWindowRange,
} from "./recovery-pointer";

describe("BI-10.1 · buildRecoveryFooter 渲染契约", () => {
  test("首行固定为 ## Context Recovery", () => {
    const block = buildRecoveryFooter({ logPath: "/tmp/s.jsonl", windows: [] });
    expect(block.startsWith("## Context Recovery\n")).toBe(true);
  });

  test("字段序固定：logPath → windows → tip（快照）", () => {
    const windows: RecoveryWindowRange[] = [
      { from: 1, to: 120, summary: "首轮探索：读取入口文件" },
      { from: 121, to: 208, summary: "工具调用与修复" },
    ];
    const block = buildRecoveryFooter({ logPath: "/var/log/session.jsonl", windows });
    expect(block).toBe(
      [
        "## Context Recovery",
        "logPath: /var/log/session.jsonl",
        "windows:",
        "- lines: 1-120",
        "  summary: 首轮探索：读取入口文件",
        "- lines: 121-208",
        "  summary: 工具调用与修复",
        `tip: ${DEFAULT_RECOVERY_TIP}`,
      ].join("\n"),
    );
  });

  test("缺省 tip 逐字等于工单文案", () => {
    const block = buildRecoveryFooter({ logPath: "/x.jsonl", windows: [] });
    expect(block.endsWith(`tip: 需要历史原始输出时按行号 grep+read 检视，勿凭记忆复述`)).toBe(true);
    expect(DEFAULT_RECOVERY_TIP).toBe("需要历史原始输出时按行号 grep+read 检视，勿凭记忆复述");
  });

  test("自定义 tip 覆盖缺省", () => {
    const block = buildRecoveryFooter({
      logPath: "/x.jsonl",
      windows: [],
      tip: "custom tip",
    });
    expect(block.endsWith("tip: custom tip")).toBe(true);
  });

  test("window 渲染为两行：- lines: from-to + 缩进 summary", () => {
    const block = buildRecoveryFooter({
      logPath: "/x.jsonl",
      windows: [{ from: 7, to: 9, summary: "s" }],
    });
    expect(block).toContain("- lines: 7-9\n  summary: s");
  });

  test("空 windows：windows: 行存在且无条目", () => {
    const block = buildRecoveryFooter({ logPath: "/x.jsonl", windows: [] });
    const lines = block.split("\n");
    expect(lines).toContain("windows:");
    expect(lines.filter((l) => l.startsWith("- lines:"))).toEqual([]);
    expect(lines.length).toBe(4); // header + logPath + windows: + tip
  });

  test("空 summary 渲染为裸 summary: （无尾随空格）", () => {
    const block = buildRecoveryFooter({
      logPath: "/x.jsonl",
      windows: [{ from: 1, to: 2, summary: "" }],
    });
    expect(block).toContain("  summary:");
    expect(block.includes("  summary: \n")).toBe(false);
  });
});

describe("BI-10.1 · 确定性", () => {
  const windows: RecoveryWindowRange[] = [
    { from: 55, to: 90, summary: "b" },
    { from: 1, to: 54, summary: "a" },
  ];

  test("两次渲染逐字节相等（===）", () => {
    const a = buildRecoveryFooter({ logPath: "/x.jsonl", windows });
    const b = buildRecoveryFooter({ logPath: "/x.jsonl", windows });
    expect(a).toBe(b);
  });

  test("乱序输入自动排序：输出按 from 升序且两次乱序方向互为相等", () => {
    const asc = buildRecoveryFooter({ logPath: "/x.jsonl", windows });
    const desc = buildRecoveryFooter({
      logPath: "/x.jsonl",
      windows: [...windows].reverse(),
    });
    expect(asc.indexOf("lines: 1-54")).toBeLessThan(asc.indexOf("lines: 55-90"));
    expect(asc).toBe(desc);
  });

  test("from 并列按 to 升序", () => {
    const block = buildRecoveryFooter({
      logPath: "/x.jsonl",
      windows: [
        { from: 1, to: 30, summary: "second" },
        { from: 1, to: 20, summary: "first" },
      ],
    });
    expect(block.indexOf("lines: 1-20")).toBeLessThan(block.indexOf("lines: 1-30"));
  });

  test("字段键序不影响输出（确定性来自字段访问而非键序）", () => {
    const a = buildRecoveryFooter({
      logPath: "/x.jsonl",
      windows: [{ from: 1, to: 5, summary: "s" }],
    });
    const b = buildRecoveryFooter({
      logPath: "/x.jsonl",
      windows: [{ summary: "s", to: 5, from: 1 } as RecoveryWindowRange],
    });
    expect(a).toBe(b);
  });

  test("summary 含换行展平为空格（块内每 window 恰两行）", () => {
    const block = buildRecoveryFooter({
      logPath: "/x.jsonl",
      windows: [{ from: 1, to: 2, summary: "l1\r\nl2\nl3" }],
    });
    expect(block).toContain("  summary: l1 l2 l3");
    // header + logPath + windows: + 两行 window + tip = 6 行
    expect(block.split("\n").length).toBe(6);
  });

  test("渲染不改写调用方 windows 数组顺序", () => {
    const input: RecoveryWindowRange[] = [{ from: 9, to: 10, summary: "x" }, { from: 1, to: 2, summary: "y" }];
    buildRecoveryFooter({ logPath: "/x.jsonl", windows: input });
    expect(input[0]?.from).toBe(9);
  });
});

describe("BI-10.1 · 行号 1 基语义与校验", () => {
  test("from=1 即 wire 第 1 行：渲染 lines: 1-N", () => {
    const block = buildRecoveryFooter({
      logPath: "/x.jsonl",
      windows: [{ from: 1, to: 3, summary: "s" }],
    });
    expect(block).toContain("- lines: 1-3");
  });

  test("from=0 违反 1 基语义：RangeError", () => {
    expect(() =>
      buildRecoveryFooter({ logPath: "/x", windows: [{ from: 0, to: 5, summary: "s" }] }),
    ).toThrow(RangeError);
  });

  test("非整数行号：RangeError", () => {
    expect(() =>
      buildRecoveryFooter({ logPath: "/x", windows: [{ from: 1.5, to: 5, summary: "s" }] }),
    ).toThrow(RangeError);
    expect(() =>
      buildRecoveryFooter({ logPath: "/x", windows: [{ from: 1, to: Number.NaN, summary: "s" }] }),
    ).toThrow(RangeError);
  });

  test("from > to 倒挂区间：RangeError", () => {
    expect(() =>
      buildRecoveryFooter({ logPath: "/x", windows: [{ from: 5, to: 4, summary: "s" }] }),
    ).toThrow(RangeError);
  });

  test("from === to 单行 window 合法", () => {
    const block = buildRecoveryFooter({
      logPath: "/x",
      windows: [{ from: 5, to: 5, summary: "single" }],
    });
    expect(block).toContain("- lines: 5-5");
  });
});

describe("BI-10.1 · RecoveryIndex", () => {
  test("record 链式登记，footer 与 buildRecoveryFooter 同构", () => {
    const idx = new RecoveryIndex()
      .record(1, 100, "前半段")
      .record(101, 150, "后半段");
    expect(idx.count).toBe(2);
    expect(idx.footer("/wire.jsonl")).toBe(
      buildRecoveryFooter({
        logPath: "/wire.jsonl",
        windows: [
          { from: 1, to: 100, summary: "前半段" },
          { from: 101, to: 150, summary: "后半段" },
        ],
      }),
    );
  });

  test("空索引 footer：零 window 条目", () => {
    const idx = new RecoveryIndex();
    expect(idx.count).toBe(0);
    const block = idx.footer("/w.jsonl");
    expect(block.split("\n").filter((l) => l.startsWith("- lines:"))).toEqual([]);
  });

  test("乱序 record 自动排序", () => {
    const block = new RecoveryIndex().record(201, 300, "late").record(1, 200, "early").footer("/w");
    expect(block.indexOf("lines: 1-200")).toBeLessThan(block.indexOf("lines: 201-300"));
  });

  test("record 校验：倒挂与 0 行号抛 RangeError", () => {
    expect(() => new RecoveryIndex().record(5, 1, "bad")).toThrow(RangeError);
    expect(() => new RecoveryIndex().record(0, 1, "bad")).toThrow(RangeError);
  });

  test("重复 record 同区间：按登记序双条目保留（追加语义，不去重）", () => {
    const idx = new RecoveryIndex().record(1, 10, "a").record(1, 10, "a");
    expect(idx.count).toBe(2);
    expect(idx.footer("/w").split("- lines: 1-10").length).toBe(3);
  });
});
