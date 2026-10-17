import { describe, expect, test } from "bun:test";
import {
  COPY_COMMAND_NAME,
  COPY_EMPTY_MESSAGE,
  COPY_WRITE_FAILED_MESSAGE,
  formatForClipboard,
  runCopyCommand,
} from "./copy";
import type { CopyWriter } from "./copy";

// ---------------------------------------------------------------------------
// 注入基建（spy 写入器，全离屏）
// ---------------------------------------------------------------------------

interface WriteSpy {
  calls: string[];
  write: CopyWriter;
}

function makeWrite(opts: { ok?: boolean; throw?: Error } = {}): WriteSpy {
  const calls: string[] = [];
  const write: CopyWriter = async (text) => {
    calls.push(text);
    if (opts.throw !== undefined) throw opts.throw;
    return opts.ok ?? true;
  };
  return { calls, write };
}

// ---------------------------------------------------------------------------
// runCopyCommand —— 成功 / 空输入 / 写失败
// ---------------------------------------------------------------------------

describe("runCopyCommand", () => {
  test("命令名 = copy", () => {
    expect(COPY_COMMAND_NAME).toBe("copy");
  });

  test("成功 → write 收到格式化后文本，摘要含字符数与行数", async () => {
    const { calls, write } = makeWrite();
    const msg = await runCopyCommand("你好，世界\n\n第二行", { write });
    expect(calls).toEqual(["你好，世界\n\n第二行"]);
    expect(msg.startsWith("/copy：")).toBe(true);
    expect(msg).toContain("已复制");
    expect(msg).toContain("10 字符"); // 5 + 2 + 3
    expect(msg).toContain("3 行");
  });

  test("空字符串 → 空输入文案，write 未被调用", async () => {
    const { calls, write } = makeWrite();
    const msg = await runCopyCommand("", { write });
    expect(msg).toBe(COPY_EMPTY_MESSAGE);
    expect(calls).toHaveLength(0);
  });

  test("纯空白（空格 / 制表 / 换行）→ 空输入文案，write 未被调用", async () => {
    const { calls, write } = makeWrite();
    const msg = await runCopyCommand("  \n\t \n", { write });
    expect(msg).toBe(COPY_EMPTY_MESSAGE);
    expect(calls).toHaveLength(0);
  });

  test("undefined / null 输入 → 空输入文案", async () => {
    const { calls, write } = makeWrite();
    expect(await runCopyCommand(undefined, { write })).toBe(COPY_EMPTY_MESSAGE);
    expect(await runCopyCommand(null, { write })).toBe(COPY_EMPTY_MESSAGE);
    expect(calls).toHaveLength(0);
  });

  test("write 返回 false → 写失败文案", async () => {
    const { calls, write } = makeWrite({ ok: false });
    const msg = await runCopyCommand("有一点内容", { write });
    expect(msg).toBe(COPY_WRITE_FAILED_MESSAGE);
    expect(msg).toContain("写入系统剪贴板失败");
    expect(calls).toHaveLength(1);
  });

  test("write 抛错 → 写失败文案且带原因", async () => {
    const { write } = makeWrite({ throw: new Error("ENOENT: xclip") });
    const msg = await runCopyCommand("有一点内容", { write });
    expect(msg.startsWith("/copy：写入系统剪贴板失败（")).toBe(true);
    expect(msg).toContain("ENOENT: xclip");
  });

  test("write 收到的文本 = formatForClipboard 结果（整合验证）", async () => {
    const raw = "\r\nA\r\n\r\n\r\n\r\n```txt\nx\n\n\ny\n```\r\n\r\n";
    const expected = "A\n\n\n```txt\nx\n\n\ny\n```";
    const { calls, write } = makeWrite();
    await runCopyCommand(raw, { write });
    expect(calls[0]).toBe(expected);
    // "A"(1) + "\n\n\n"(3) + "```txt"(6) + "\n"(1) + "x"(1) + "\n\n\n"(3) + "y"(1) + "\n"(1) + "```"(3) = 20
    const msg = await runCopyCommand(raw, { write });
    expect(msg).toContain("20 字符");
    expect(msg).toContain("9 行");
  });
});

// ---------------------------------------------------------------------------
// formatForClipboard —— 保留代码块的格式化
// ---------------------------------------------------------------------------

describe("formatForClipboard", () => {
  test("CRLF / 孤立 CR 归一为 LF", () => {
    expect(formatForClipboard("a\r\nb\rc")).toBe("a\nb\nc");
  });

  test("裁掉首尾空行", () => {
    expect(formatForClipboard("\n\n\n内容\n\n\n")).toBe("内容");
  });

  test("正文区连续 ≥3 空行折叠为 2 行（1–2 行保持原样）", () => {
    expect(formatForClipboard("a\n\n\n\n\nb")).toBe("a\n\n\nb");
    expect(formatForClipboard("a\n\nb")).toBe("a\n\nb");
    expect(formatForClipboard("a\nb")).toBe("a\nb");
  });

  test("围栏代码块内部逐字节保留：空行不折叠、空白不触碰", () => {
    const code = "```ts\n  const a = 1;   \n\n  const b = 2;\n```";
    expect(formatForClipboard(`前言\n\n${code}\n\n后记`)).toBe(`前言\n\n${code}\n\n后记`);
  });

  test("块内多空行原样保留，仅正文区折叠", () => {
    const out = formatForClipboard("a\n\n\n\n\n```js\nconst x = 1;\n\n\n\nconst y = 2;\n```\n\n\n\nb");
    expect(out.split("\n")).toEqual([
      "a",
      "",
      "",
      "```js",
      "const x = 1;",
      "",
      "",
      "",
      "const y = 2;",
      "```",
      "",
      "",
      "b",
    ]);
  });

  test("缩进围栏（≤3 空格）也识别为代码块边界", () => {
    const out = formatForClipboard("a\n\n\n\n  ```py\nx\n  ```\n\n\n\nb");
    expect(out).toBe("a\n\n\n  ```py\nx\n  ```\n\n\nb");
  });

  test("未闭合围栏：视为块内保守保全", () => {
    const out = formatForClipboard("a\n\n\n\n```\nline1\n\n\nline2");
    expect(out).toBe("a\n\n\n```\nline1\n\n\nline2");
  });

  test("单行文本原样返回", () => {
    expect(formatForClipboard("only line")).toBe("only line");
  });
});
