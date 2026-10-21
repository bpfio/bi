/**
 * BI-20.2 · 全局参数矩阵 parseGlobalArgs 测试。
 *
 * 覆盖：四个长参（空格/等号传值）、--add-dir 可重复聚合、-- 终止符、
 * 裸位置参数收集、未知参数/缺值（末尾与后随 flag/单独 -）/非法值/
 * 重复单值 flag 的结构化报错、GLOBAL_ARGS 矩阵定义完整性。
 */
import { describe, expect, test } from "bun:test";
import { ArgParseError, GLOBAL_ARGS, parseGlobalArgs, parseResumeArg } from "./args";

function catchCode(run: () => unknown): { code: ArgParseError["code"]; flag?: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof ArgParseError) return { code: error.code, flag: error.flag };
    throw error;
  }
  throw new Error("预期解析失败，但成功了");
}

describe("BI-20.2 parseGlobalArgs：正常解析", () => {
  test("四个长参空格传值全解析", () => {
    const parsed = parseGlobalArgs([
      "--agent-file",
      "agents/bi.md",
      "--add-dir",
      "/tmp/x",
      "--prompt",
      "帮我看看",
      "--output-format",
      "stream-json",
    ]);
    expect(parsed.agentFile).toBe("agents/bi.md");
    expect(parsed.addDirs).toEqual(["/tmp/x"]);
    expect(parsed.prompt).toBe("帮我看看");
    expect(parsed.outputFormat).toBe("stream-json");
    expect(parsed.positionals).toEqual([]);
  });

  test("等号形式传值", () => {
    const parsed = parseGlobalArgs(["--agent-file=a.md", "--prompt=你好"]);
    expect(parsed.agentFile).toBe("a.md");
    expect(parsed.prompt).toBe("你好");
  });

  test("--add-dir 可重复出现并按顺序聚合", () => {
    const parsed = parseGlobalArgs(["--add-dir", "/a", "--add-dir=/b", "--add-dir", "/c"]);
    expect(parsed.addDirs).toEqual(["/a", "/b", "/c"]);
  });

  test("裸位置参数收集进 positionals（子命令派发归属装配方）", () => {
    const parsed = parseGlobalArgs(["init", "--prompt", "p"]);
    expect(parsed.positionals).toEqual(["init"]);
    expect(parsed.prompt).toBe("p");
  });

  test("-- 终止符之后全部视为位置参数", () => {
    const parsed = parseGlobalArgs(["--", "x", "--prompt", "-y"]);
    expect(parsed.positionals).toEqual(["x", "--prompt", "-y"]);
    expect(parsed.prompt).toBeUndefined();
  });

  test("空 argv → 空结果", () => {
    expect(parseGlobalArgs([])).toEqual({ addDirs: [], positionals: [] });
  });

  test("等号形式可传 `-` 开头的字面值", () => {
    const parsed = parseGlobalArgs(["--prompt=--continue"]);
    expect(parsed.prompt).toBe("--continue");
  });
});

describe("BI-20.2 parseGlobalArgs：结构化报错", () => {
  test("未知参数 → unknown-flag（flag 字段回传参名）", () => {
    const { code, flag } = catchCode(() => parseGlobalArgs(["--unknown"]));
    expect(code).toBe("unknown-flag");
    expect(flag).toBe("--unknown");
  });

  test("末尾缺值 → missing-value", () => {
    const { code, flag } = catchCode(() => parseGlobalArgs(["--agent-file"]));
    expect(code).toBe("missing-value");
    expect(flag).toBe("--agent-file");
  });

  test("后随另一 flag 视为缺值 → missing-value", () => {
    const { code, flag } = catchCode(() => parseGlobalArgs(["--prompt", "--add-dir", "/x"]));
    expect(code).toBe("missing-value");
    expect(flag).toBe("--prompt");
  });

  test("后随单独 `-` 视为缺值 → missing-value", () => {
    const { code } = catchCode(() => parseGlobalArgs(["--prompt", "-"]));
    expect(code).toBe("missing-value");
  });

  test("--output-format 非法值 → invalid-value", () => {
    const { code, flag } = catchCode(() => parseGlobalArgs(["--output-format", "yaml"]));
    expect(code).toBe("invalid-value");
    expect(flag).toBe("--output-format");
  });

  test("--output-format 合法值 stream-json / text / json 通过（BI-30.3 白名单 + F-ST-02 json）", () => {
    expect(parseGlobalArgs(["--output-format=stream-json"]).outputFormat).toBe("stream-json");
    expect(parseGlobalArgs(["--output-format", "text"]).outputFormat).toBe("text");
    expect(parseGlobalArgs(["--output-format", "json"]).outputFormat).toBe("json");
    expect(parseGlobalArgs(["--output-format=json"]).outputFormat).toBe("json");
  });

  test("单值 flag 重复出现 → duplicate-flag", () => {
    const { code, flag } = catchCode(() =>
      parseGlobalArgs(["--prompt", "a", "--prompt", "b"]),
    );
    expect(code).toBe("duplicate-flag");
    expect(flag).toBe("--prompt");
  });

  test("可重复 flag（--add-dir）重复不报 duplicate-flag", () => {
    expect(parseGlobalArgs(["--add-dir", "/a", "--add-dir", "/b"]).addDirs).toEqual(["/a", "/b"]);
  });

  test("--max-rounds 正整数通过并转 number", () => {
    expect(parseGlobalArgs(["--max-rounds", "24"]).maxRounds).toBe(24);
    expect(parseGlobalArgs(["--max-rounds=1"]).maxRounds).toBe(1);
  });

  test("--max-rounds 非正整数 → invalid-value", () => {
    // 负数以 "-" 开头,按既有契约走 missing-value（与 --prompt 遇 "-" 同规）。
    const { code } = catchCode(() => parseGlobalArgs(["--max-rounds", "-3"]));
    expect(code).toBe("missing-value");
    for (const bad of ["0", "2.5", "abc"]) {
      const { code, flag } = catchCode(() => parseGlobalArgs(["--max-rounds", bad]));
      expect(code).toBe("invalid-value");
      expect(flag).toBe("--max-rounds");
    }
  });
});

describe("BI-20.2 GLOBAL_ARGS：矩阵定义完整性", () => {
  test("包含六个合约旗标且定义字段齐备（--resume 为 0.3.0 测试发现补齐）", () => {
    expect(GLOBAL_ARGS.map((s) => s.flag)).toEqual([
      "--agent-file",
      "--add-dir",
      "--prompt",
      "--output-format",
      "--max-rounds",
      "--resume",
    ]);
    for (const spec of GLOBAL_ARGS) {
      expect(spec.flag.startsWith("--")).toBe(true);
      expect(spec.valueName.length).toBeGreaterThan(0);
      expect(spec.description.length).toBeGreaterThan(0);
      expect(typeof spec.repeatable).toBe("boolean");
    }
  });

  test("可重复性与值域约束按合约定义", () => {
    const byFlag = new Map(GLOBAL_ARGS.map((s) => [s.flag, s]));
    expect(byFlag.get("--add-dir")?.repeatable).toBe(true);
    expect(byFlag.get("--agent-file")?.repeatable).toBe(false);
    expect(byFlag.get("--prompt")?.repeatable).toBe(false);
    expect(byFlag.get("--output-format")?.allowedValues).toEqual(["stream-json", "text", "json"]);
    expect(byFlag.get("--agent-file")?.valueName).toBe("<path.md>");
  });
});

describe("FIX-A F4 · parseResumeArg（REPL 续会话目标提取）", () => {
  test("空格传值：提取 --resume <id>，其余 token 原样留在 rest", () => {
    const parsed = parseResumeArg(["--resume", "sess-1", "--prompt", "hi"]);
    expect(parsed.resume).toBe("sess-1");
    expect(parsed.rest).toEqual(["--prompt", "hi"]);
  });

  test("等号传值：提取 --resume=<id>（旗标与值都不留在 rest）", () => {
    const parsed = parseResumeArg(["--resume=sess-2"]);
    expect(parsed.resume).toBe("sess-2");
    expect(parsed.rest).toEqual([]);
  });

  test("无 --resume：resume 为 undefined，rest 原样返回", () => {
    const parsed = parseResumeArg(["--prompt", "hi"]);
    expect(parsed.resume).toBeUndefined();
    expect(parsed.rest).toEqual(["--prompt", "hi"]);
  });

  test("缺值：旗标留在 rest（交由全局解析器报 missing-value）", () => {
    const parsed = parseResumeArg(["--resume"]);
    expect(parsed.resume).toBeUndefined();
    expect(parsed.rest).toEqual(["--resume"]);
  });
});
