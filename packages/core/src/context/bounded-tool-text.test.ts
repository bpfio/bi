/**
 * BI-08 · boundToolText 有界截断测试。
 *
 * 钉死语义（与 bounded-tool-text.ts 文件头注释一一对应）：
 * - 64,000 码点上限，恰好等于上限不截；计数按 Unicode 码点，行按 \n 分割。
 * - 两级预算：行优先（头 200 + 尾 200 + 标记行），字符兜底（超长行按码点
 *   边界从内侧收紧，多字节字符绝不截半）。
 * - 标记行格式 `[... output truncated: N chars / M lines omitted ...]` 必在，
 *   M 可为 0。
 * - 落盘接缝：logDir 默认落盘、未配置跳过、注入 writer 完全接管。
 *
 * 精确值断言的预算推导（默认 maxChars=64000，标记行上界 = formatMarker(
 * totalChars, totalLines).length，两侧各分 (上限 − 上界 − 分隔符) 的一半），
 * 每个用例的期望值均在注释中给出推导，防止魔法数失据。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_CHARS, boundToolText } from "./bounded-tool-text";
import type { BoundedToolTextResult } from "./bounded-tool-text";

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

/** 断言便捷：收窄到 bounded 分支。 */
function expectBounded(text: string, options?: Parameters<typeof boundToolText>[1]): BoundedToolTextResult {
  const result = boundToolText(text, options);
  if (!result.bounded) throw new Error("expected bounded=true");
  return result;
}

/** 按码点数计长。 */
function cpLen(s: string): number {
  return [...s].length;
}

/** 生成 "L0000"… 编号的 n 行文本（每行 5 码点，行号可读便于断言头尾）。 */
function numberedLines(n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(`L${String(i).padStart(4, "0")}`);
  return parts.join("\n");
}

describe("BI-08 64K 码点边界", () => {
  test("63999 码点：不截", () => {
    const output = "x".repeat(63_999);
    const result = boundToolText(output);
    expect(result.bounded).toBe(false);
    if (!result.bounded) return;
    expect(result.text).toBe(output);
  });

  test("64000 码点（恰好等于上限）：不截", () => {
    const output = "x".repeat(64_000);
    const result = boundToolText(output);
    expect(result.bounded).toBe(false);
    if (!result.bounded) return;
    expect(result.text).toBe(output);
  });

  test("64001 码点：截断，originalChars/originalLines 正确", () => {
    const output = "x".repeat(64_001);
    const r = expectBounded(output);
    expect(r.originalChars).toBe(64_001);
    expect(r.originalLines).toBe(1);
    expect(cpLen(r.text)).toBeLessThanOrEqual(64_000);
    expect(r.omittedChars).toBeGreaterThan(0);
  });

  test("自定义 maxChars 边界：等于不截、超过才截（极小预算走标记行退化路径）", () => {
    expect(boundToolText("abcde", { maxChars: 5 })).toEqual({ bounded: false, text: "abcde" });
    const r = expectBounded("abcdef", { maxChars: 5 });
    expect(r.originalChars).toBe(6);
    // 退化路径（bounded-tool-text.ts 文件头钉死）：标记行上界 53 > maxChars 5，
    // 两侧预算钳 0，输出仅含标记行，允许略超 maxChars。
    expect(r.text).toBe("[... output truncated: 6 chars / 1 lines omitted ...]");
  });

  test("空串与纯空白：不截、原样返回", () => {
    expect(boundToolText("")).toEqual({ bounded: false, text: "" });
    const ws = "  \n\t \n  ";
    expect(boundToolText(ws)).toEqual({ bounded: false, text: ws });
  });

  test("DEFAULT_MAX_CHARS 导出值为 64000", () => {
    expect(DEFAULT_MAX_CHARS).toBe(64_000);
  });

  test("maxChars 非法配置：0 / 负数 / NaN 抛 RangeError", () => {
    expect(() => boundToolText("x", { maxChars: 0 })).toThrow(RangeError);
    expect(() => boundToolText("x", { maxChars: -5 })).toThrow(RangeError);
    expect(() => boundToolText("x", { maxChars: Number.NaN })).toThrow(RangeError);
  });
});

describe("BI-08 行级预算（头 200 + 尾 200 + 标记行）", () => {
  test("501 行：头 200 + 尾 200 + 中段 101 行替换为标记行（头尾字符预算未触发）", () => {
    // total = 501*5 + 500 = 3005；标记上界 = formatMarker(3005, 501) = 58；
    // available = 2800 − 58 − 2 = 2740，两侧各 1370 ≥ 1199（200 行全量）。
    const output = numberedLines(501);
    const r = expectBounded(output, { maxChars: 2800 });
    expect(r.originalLines).toBe(501);
    expect(r.keptHeadLines).toBe(200);
    expect(r.keptTailLines).toBe(200);
    // omitted = 3005 − (1199 + 1199) = 607。
    expect(r.omittedChars).toBe(607);

    const textLines = r.text.split("\n");
    expect(textLines.length).toBe(401);
    expect(textLines[0]).toBe("L0000");
    expect(textLines[199]).toBe("L0199");
    expect(textLines[200]).toBe("[... output truncated: 607 chars / 101 lines omitted ...]");
    expect(textLines[201]).toBe("L0301");
    expect(textLines[400]).toBe("L0500");
    // 中段行（省略区 101 行 = L0200…L0300）不得出现。
    expect(r.text.includes("L0200")).toBe(false);
    expect(r.text.includes("L0250")).toBe(false);
    expect(r.text.includes("L0300")).toBe(false);
  });

  test("头尾内容保序且逐字保真（截断区外无任何改动）", () => {
    // 600 行 total = 3599；maxChars 2800 → 两侧预算 1370/1371 ≥ 1199，全量保留。
    const output = numberedLines(600);
    const r = expectBounded(output, { maxChars: 2800 });
    const textLines = r.text.split("\n");
    expect(textLines.slice(0, 200).join("\n")).toBe(numberedLines(200));
    expect(textLines.slice(201).join("\n")).toBe(
      Array.from({ length: 200 }, (_, i) => `L${String(i + 400).padStart(4, "0")}`).join("\n"),
    );
  });

  test("401 行：恰好省略 1 行（M=1），中段行绝迹", () => {
    // 每行 159 码点（3 位行号 + 156 个 x），total = 401*159 + 400 = 64159 > 64000。
    // 标记上界 = formatMarker(64159, 401) = 59；available = 63939，头 31969 / 尾 31970。
    // 头侧：199 整行（31839）+ 第 200 行前 129 码点 = 31969（keptHead=200，边界行计 1）；
    // 尾侧对称：199 整行 + 第 200 行后 130 码点。omitted = 64159 − 63939 − 31970 = 220
    // （中段行 159 + 头侧边界行损 30 + 尾侧边界行损 29 + 2 个 \n）。
    const lines = Array.from({ length: 401 }, (_, i) => String(i).padStart(3, "0") + "x".repeat(156));
    const output = lines.join("\n");
    const r = expectBounded(output);
    expect(r.keptHeadLines).toBe(200);
    expect(r.keptTailLines).toBe(200);

    const textLines = r.text.split("\n");
    expect(textLines.length).toBe(401);
    expect(textLines[0]).toBe(lines[0]);
    expect(textLines[199]).toBe("199" + "x".repeat(126)); // 头侧边界行：前 129 码点
    expect(textLines[200]).toBe("[... output truncated: 220 chars / 1 lines omitted ...]");
    expect(textLines[201]).toBe("x".repeat(130)); // 尾侧边界行：后 130 码点
    expect(textLines[400]).toBe(lines[400]);
    expect(r.text.includes(lines[200] as string)).toBe(false); // 中段行（L200）绝迹
  });

  test("行数 ≤ 400 但字符超限：字符兜底从内侧收紧、尾侧整段保留", () => {
    // 300 行 × 300 码点，total = 90299。标记上界 = formatMarker(90299, 300) = 59，
    // available = 63939，头预算 31969：106 整行（31905）+ 第 107 行前 63 码点；
    // 尾预算 31970 ≥ 100 行全量（30099）→ 尾侧 100 行完整保留。
    // omittedChars = 90299 − 31969 − 30099 = 28231；M = 300 − 107 − 100 = 93。
    const lines = Array.from({ length: 300 }, (_, i) => `L${String(i).padStart(4, "0")}` + "y".repeat(295));
    const output = lines.join("\n");
    const r = expectBounded(output);
    expect(r.keptHeadLines).toBe(107);
    expect(r.keptTailLines).toBe(100);
    expect(r.omittedChars).toBe(28_231);
    expect(r.text.includes("[... output truncated: 28231 chars / 93 lines omitted ...]")).toBe(true);
    expect(r.text.startsWith(lines[0] as string)).toBe(true);
    expect(r.text.endsWith(lines[299] as string)).toBe(true);
    expect(cpLen(r.text)).toBeLessThanOrEqual(64_000);
  });

  test("超长单行（64001 码点 1 行）：字符兜底截该行，M=0", () => {
    // 标记上界 = formatMarker(64001, 1) = 56；available = 63943，头预算 31971。
    const output = "a".repeat(64_001);
    const r = expectBounded(output);
    expect(r.originalLines).toBe(1);
    expect(r.keptHeadLines).toBe(1);
    expect(r.keptTailLines).toBe(0);
    const markerLine = r.text.split("\n").pop() as string;
    expect(markerLine.startsWith("[... output truncated: ")).toBe(true);
    expect(markerLine.endsWith("chars / 0 lines omitted ...]")).toBe(true);
    // 头侧保留部分 = originalChars − omittedChars，且为原样前缀。
    const headPart = r.text.slice(0, r.text.indexOf("\n"));
    expect(r.originalChars - r.omittedChars).toBe(cpLen(headPart));
    expect(headPart).toBe("a".repeat(cpLen(headPart)));
    expect(cpLen(r.text)).toBeLessThanOrEqual(64_000);
  });

  test("200 条超长行（每行 1000 码点）：字符兜底防撑爆，结果 ≤ 上限", () => {
    // total = 200199；标记上界 = formatMarker(200199, 200) = 60；tailCount = 0
    // （200 行全归头侧）→ available = 63939；F-EV-05：尾侧为空时尾侧预算整段并入
    // 头侧（头预算 = 63939）：63 整行（63062）+ 第 64 行前 876 码点。
    // omitted = 200199 − 63939 = 136260，M = 200 − 64 = 136。
    const lines = Array.from({ length: 200 }, (_, i) => String(i).padStart(3, "0") + "z".repeat(997));
    const output = lines.join("\n");
    const r = expectBounded(output);
    expect(cpLen(r.text)).toBeLessThanOrEqual(64_000);
    expect(r.keptHeadLines).toBe(64);
    expect(r.keptTailLines).toBe(0);
    expect(r.text.startsWith(lines[0] as string)).toBe(true);
    expect(r.text.endsWith("063" + "z".repeat(873) + "\n[... output truncated: 136260 chars / 136 lines omitted ...]")).toBe(true);
  });

  test("F-EV-05：单行超长文本（200KB）尾侧为空 → 尾侧预算并入头侧，保足 maxChars", () => {
    // 200KB 单行（204800 码点 / 1 行）→ 行级切分后 tailCount = 0（尾侧为空）。
    // 标记上界 = formatMarker(204800, 1) = 58；available = 65536 − 58 − 1 = 65477。
    // 修复前：头侧只拿对半（32738）→ 仅留约 32K 码点（尾侧预算整段浪费）；
    // 修复后：头侧拿满 65477 → 文本 65477 + 1 + 58 = 65536 码点（= maxChars）。
    const output = "A".repeat(200 * 1024);
    const r = expectBounded(output, { maxChars: 65_536 });
    expect(r.originalChars).toBe(204_800);
    expect(r.originalLines).toBe(1);
    expect(r.keptHeadLines).toBe(1);
    expect(r.keptTailLines).toBe(0);
    expect(cpLen(r.text)).toBeGreaterThanOrEqual(65_000);
    expect(cpLen(r.text)).toBeLessThanOrEqual(65_536);
    expect(cpLen(r.text)).toBe(65_536);
    expect(r.omittedChars).toBe(204_800 - 65_477);
    expect(r.text.startsWith("A".repeat(65_477))).toBe(true);
    expect(r.text.endsWith("[... output truncated: 139323 chars / 0 lines omitted ...]")).toBe(true);
  });

  test("标记行计入预算：截断结果总码点数恒 ≤ maxChars（含极小预算）", () => {
    const output = numberedLines(2000) + "\n" + "w".repeat(80_000);
    for (const maxChars of [100, 1000, 5000, 64_000]) {
      const r = expectBounded(output, { maxChars });
      expect(cpLen(r.text)).toBeLessThanOrEqual(maxChars);
      expect(r.text.includes("[... output truncated:")).toBe(true);
    }
  });

  test("极小 maxChars=1：预算钳 0，退化输出仅标记行（文档钉死的退化行为）", () => {
    const r = expectBounded("x".repeat(50), { maxChars: 1 });
    expect(r.text.startsWith("[... output truncated: ")).toBe(true);
  });
});

describe("BI-08 多字节字符（码点边界）", () => {
  test("emoji（代理对）单行超限：截断不产生残码", () => {
    // 😀 = U+1F600（2 个 UTF-16 单元、1 个码点）。64001 码点 = 128002 单元。
    // 头预算 31971 码点 = 63942 单元（偶数，代理对完整）。
    const output = "\u{1F600}".repeat(64_001);
    const r = expectBounded(output);
    expect(r.originalChars).toBe(64_001);
    expect(output.length).toBe(128_002);
    const headPart = r.text.slice(0, r.text.indexOf("\n"));
    expect(headPart.length % 2).toBe(0);
    for (let i = 0; i < headPart.length; i += 2) {
      expect(headPart.codePointAt(i)).toBe(0x1f600);
    }
    expect(r.text.includes("\uFFFD")).toBe(false);
  });

  test("中文单行超限：头部保留区是原样前缀，无 U+FFFD", () => {
    const output = "汉".repeat(64_001);
    const r = expectBounded(output);
    const headPart = r.text.slice(0, r.text.indexOf("\n"));
    expect(headPart).toBe("汉".repeat(cpLen(headPart)));
    expect(r.text.includes("\uFFFD")).toBe(false);
    expect(cpLen(r.text)).toBeLessThanOrEqual(64_000);
  });

  test("中文多行超限：首末行逐字保真，无 U+FFFD", () => {
    const output = Array.from({ length: 1000 }, (_, i) => `第${i}行` + "字".repeat(80)).join("\n");
    const r = expectBounded(output, { maxChars: 10_000 });
    expect(r.text.includes("\uFFFD")).toBe(false);
    expect(r.text.startsWith("第0行" + "字".repeat(80))).toBe(true);
    expect(r.text.includes("第999行" + "字".repeat(80))).toBe(true);
  });

  test("代理对多行：任何保留行都不以孤立高位代理项结尾（边界必落码点缝隙）", () => {
    const output = Array.from({ length: 1000 }, (_, i) => `\u{1F600}${i}`).join("\n");
    const r = expectBounded(output, { maxChars: 500 });
    const lines = r.text.split("\n");
    const markerIdx = lines.findIndex((l) => l.startsWith("[... output truncated:"));
    expect(markerIdx).toBeGreaterThan(0);
    for (const line of lines) {
      if (line.startsWith("[...")) continue;
      const last = line.charCodeAt(line.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  test("尾侧截断（超长行从内侧取后缀）：码点边界完整、末行完整保留", () => {
    // 401 行：头 200 短行 + 1 中段 + 尾 200 行（每行 400 个 😀 + T 编号）。
    // maxChars 20000 → 两侧各 9970：头全量保留（约 800），尾 24 整行 + 边界行后缀。
    const headLines = Array.from({ length: 200 }, (_, i) => `H${i}`);
    const tailLines = Array.from({ length: 200 }, (_, i) => "\u{1F600}".repeat(400) + `T${i}`);
    const output = [...headLines, Array.from({ length: 400 }, () => "m").join(","), ...tailLines].join("\n");
    const r = expectBounded(output, { maxChars: 20_000 });
    expect(r.text.includes("\uFFFD")).toBe(false);
    expect(r.text.startsWith("H0\n")).toBe(true);
    expect(r.text.endsWith("\u{1F600}".repeat(400) + "T199")).toBe(true);
  });
});

describe("BI-08 落盘接缝", () => {
  test("logDir 配置：落盘且往返内容一致，文件名 <sha1 前12>-<ts>.txt", () => {
    tmpDir = join(tmpdir(), "bi-context-test-") + String(Date.now()) + "-a";
    const output = numberedLines(500);
    const r = expectBounded(output, { maxChars: 2000, logDir: tmpDir });
    expect(r.fullOutputPath).toBeDefined();
    const fullPath = r.fullOutputPath as string;
    expect(fullPath.startsWith(tmpDir + "/")).toBe(true);
    const name = fullPath.slice(tmpDir.length + 1);
    expect(name).toMatch(/^[0-9a-f]{12}-\d+\.txt$/);
    expect(readFileSync(fullPath, "utf8")).toBe(output);
  });

  test("logDir 目录不存在：自动递归创建", () => {
    tmpDir = join(tmpdir(), "bi-context-test-") + String(Date.now()) + "-b";
    const logDir = join(tmpDir, "nested", "logs");
    const r = expectBounded("x".repeat(64_001), { logDir });
    expect(r.fullOutputPath).toBeDefined();
    expect(readdirSync(logDir).length).toBe(1);
  });

  test("logDir 未配置：跳过落盘，fullOutputPath 为 undefined", () => {
    const r = expectBounded("x".repeat(64_001));
    expect(r.fullOutputPath).toBeUndefined();
    expect("fullOutputPath" in r).toBe(false);
  });

  test("注入 fullOutputLog：完全接管（收到原始全文，返回值成为 fullOutputPath，logDir 被忽略）", () => {
    const output = numberedLines(500);
    const received: string[] = [];
    const r = expectBounded(output, {
      maxChars: 2000,
      logDir: "/nonexistent-bi-test-dir",
      fullOutputLog: (full) => {
        received.push(full);
        return "/tmp/injected-path.txt";
      },
    });
    expect(received).toEqual([output]);
    expect(r.fullOutputPath).toBe("/tmp/injected-path.txt");
  });

  test("注入 fullOutputLog 返回 undefined：fullOutputPath 为 undefined", () => {
    const r = expectBounded("x".repeat(64_001), { fullOutputLog: () => undefined });
    expect(r.fullOutputPath).toBeUndefined();
  });

  test("未超限：落盘器不被调用", () => {
    let calls = 0;
    const result = boundToolText("small output", {
      logDir: "/nonexistent-bi-test-dir",
      fullOutputLog: () => {
        calls++;
        return "/tmp/should-not-happen.txt";
      },
    });
    expect(result.bounded).toBe(false);
    expect(calls).toBe(0);
  });

  test("落盘失败：向上抛错，不静默降级为 undefined（fullOutputPath 契约）", () => {
    expect(() =>
      boundToolText("x".repeat(64_001), {
        fullOutputLog: () => {
          throw new Error("disk full");
        },
      }),
    ).toThrow("disk full");
  });
});
