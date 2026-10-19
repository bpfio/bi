/**
 * transcript-styled —— BI-27.3 富文本转录视图模型验收（全离线）。
 *
 * 覆盖：
 * 1. plain 条目（user/system/tool）：视图行文本与 TranscriptProjection.wrapLine
 *    同路径逐字节一致（样式面新增、文本面不变），前缀分段 dim；
 * 2. assistant 条目：正文走 renderMarkdown（markdown 标记剥离 + 样式分段），
 *    首行垫 `[assistant] ` dim 前缀分段，首行折行预算收缩；
 * 3. 空正文：仅前缀行（与 L3 的 header-only 一致）；
 * 4. resize：宽度变更全量重算（折行跟随），等值 no-op；行序与条目序保序；
 * 5. 构造校验：非正整数宽度抛 RangeError。
 */
import { describe, expect, test } from "bun:test";

import { StyledTranscript } from "./transcript-styled";
import { wrapLine, type TranscriptEntry } from "./transcript-projection";
import { rowPlain } from "./render/markdown";

/** 拼接全部视图行文本。 */
function flatText(styled: StyledTranscript): string[] {
  return styled.rows().map((row) => rowPlain(row));
}

describe("BI-27.3 · StyledTranscript", () => {
  test("plain 条目：文本与 L3 wrapLine 逐字节一致，前缀分段 dim", () => {
    const styled = new StyledTranscript(20);
    const entry: TranscriptEntry = { kind: "user", text: "你好，这是一条比较长的用户消息需要折行处理" };
    styled.append(entry);
    const rows = styled.rows();
    // 与 L3 同一折行路径：逐字节一致
    expect(flatText(styled)).toEqual(wrapLine(`[user] ${entry.text}`, 20));
    // 前缀分段样式：首行前缀 dim，其余纯文本
    expect(rows[0]!.spans[0]).toEqual({ text: "[user] ", style: { dim: true } });
    expect(rowPlain(rows[0]!).startsWith("[user] 你好")).toBe(true);
    // 续行无前缀（整行单分段）
    if (rows.length > 1) {
      expect(rows[1]!.spans).toHaveLength(1);
      expect(rows[1]!.spans[0]!.style).toBeUndefined();
    }
  });

  test("assistant 条目：markdown 剥离 + 样式分段 + 首行前缀垫位", () => {
    const styled = new StyledTranscript(60);
    styled.append({ kind: "assistant", text: "# 计划\n- **第一步**：`run`" });
    const rows = styled.rows();
    const texts = flatText(styled);
    expect(texts[0]).toBe("[assistant] 计划"); // # 标记剥离
    expect(texts).toContain("• 第一步：run"); // 列表 + 粗体/行内代码标记剥离
    // 首行前缀 dim 分段 + 标题样式分段共存
    expect(rows[0]!.spans[0]).toEqual({ text: "[assistant] ", style: { dim: true } });
    expect(rows[0]!.spans[1]!.style).toEqual({ bold: true, fg: "cyan" });
    // 列表行带 bold 分段（**第一步**）
    const listRow = rows.find((r) => rowPlain(r) === "• 第一步：run");
    expect(listRow).toBeDefined();
    expect(listRow!.spans.some((s) => s.style?.bold === true)).toBe(true);
  });

  test("assistant 首行折行预算收缩：前缀宽度不计入正文首行", () => {
    const styled = new StyledTranscript(12);
    styled.append({ kind: "assistant", text: "aaa bb cc" });
    const rows = styled.rows();
    // 首行预算 12 - len("[assistant] ")=12 → 钳 1；续行整宽 12
    expect(rowPlain(rows[0]!)).toBe("[assistant] a");
    // 拼接还原正文（无损折行）
    const joined = rows.map((r) => rowPlain(r)).join("").slice("[assistant] ".length);
    expect(joined).toBe("aaa bb cc");
  });

  test("空正文：仅前缀行（与 L3 header-only 一致）", () => {
    const styled = new StyledTranscript(40);
    styled.append({ kind: "system", text: "" });
    expect(flatText(styled)).toEqual(["[system]"]);
    expect(styled.rows()[0]!.spans[0]!.style).toEqual({ dim: true });
  });

  test("tool 条目走 plain 路径（不误触发 markdown 解析）", () => {
    const styled = new StyledTranscript(40);
    styled.append({ kind: "tool", text: "bash(# **不**是 markdown) → ok" });
    expect(flatText(styled)).toEqual(wrapLine("[tool] bash(# **不**是 markdown) → ok", 40));
  });

  test("resize：折行宽跟随全量重算；等值 no-op；条目序保序", () => {
    const styled = new StyledTranscript(20);
    const entries: TranscriptEntry[] = [
      { kind: "user", text: "第一条用户消息" },
      { kind: "assistant", text: "**回答**正文" },
      { kind: "tool", text: "bash(…) → ok" },
    ];
    for (const entry of entries) styled.append(entry);
    const before = styled.size;
    expect(before).toBe(3);
    expect(styled.width).toBe(20);

    styled.resize(10);
    expect(styled.width).toBe(10);
    expect(styled.size).toBe(3); // 条目数不变
    // 折行跟随：user 条目视图行与 L3 新宽度一致
    const userRows = wrapLine(`[user] ${entries[0]!.text}`, 10);
    expect(flatText(styled).slice(0, userRows.length)).toEqual(userRows);
    // assistant 标记仍剥离（跨折行拼接判定——窄宽下「回答」可能被劈开）
    expect(flatText(styled).join("").includes("回答")).toBe(true);
    expect(flatText(styled).some((t) => t.includes("**"))).toBe(false);

    // 等值 no-op：宽度不变时视图行原样（重算幂等）
    const snapshot = flatText(styled);
    styled.resize(10);
    expect(flatText(styled)).toEqual(snapshot);
  });

  test("CRLF 归一：\\r\\n 与 L3 同语义（按 LF 拆逻辑行）", () => {
    const styled = new StyledTranscript(40);
    styled.append({ kind: "user", text: "甲\r\n乙" });
    // L3：全文本含 \r\n，wrapLine 不拆 \n —— textWidth 含控制字符；
    // styled：normalizeText 归一后按逻辑行拆分（两行）。
    const rows = flatText(styled);
    expect(rows[0]).toBe("[user] 甲");
    expect(rows[1]).toBe("乙");
  });

  test("构造校验：非正整数宽度抛 RangeError；resize 同校验", () => {
    expect(() => new StyledTranscript(0)).toThrow(RangeError);
    expect(() => new StyledTranscript(-1)).toThrow(RangeError);
    expect(() => new StyledTranscript(1.5)).toThrow(RangeError);
    const styled = new StyledTranscript(10);
    expect(() => styled.resize(0)).toThrow(RangeError);
    expect(() => styled.resize(2.5)).toThrow(RangeError);
  });
});
