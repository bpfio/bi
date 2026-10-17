/**
 * BI-06.5 · 权限规则解析与匹配器测试（纯内存，零 IO）。
 *
 * 匹配语义以 picomatch 4.0.7 实测行为为锚点钉死：
 * - 单星模式不跨路径段（标准 glob）；src 下多段递归模式命中 src 本身；
 * - 双星递归模式经零段 globstar 命中 src/a.ts；
 * - picomatch("*")("") 为 false，故全匹配短路由 matchRule 显式实现；
 * - 本引擎统一 dot:true：通配符也命中点开头段（fail-closed）。
 */
import { describe, expect, test } from "bun:test";
import { evaluateRules, matchRule, parseRule } from "./permission-matcher";
import type { PermissionRequest, PermissionRule } from "./types";

/** 断言 parseRule 结果为合法规则并返回之（ParseError 则令测试失败）。 */
function assertRule(parsed: PermissionRule | ReturnType<typeof parseRule>): PermissionRule {
  if ("ok" in parsed) {
    throw new Error(`期望合法规则，实际 ParseError(${parsed.code}): ${parsed.message}`);
  }
  return parsed;
}

/** 断言 parseRule 结果为 ParseError 并返回之（合法规则则令测试失败）。 */
function assertError(parsed: PermissionRule | ReturnType<typeof parseRule>): Extract<ReturnType<typeof parseRule>, { ok: false }> {
  if (!("ok" in parsed)) {
    throw new Error(`期望 ParseError，实际得到规则 ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

const req = (tool: string, argSummary: string, mode: PermissionRequest["mode"] = "manual"): PermissionRequest => ({
  tool,
  argSummary,
  mode,
});

describe("BI-06.5 parseRule：Tool(pattern) 解析矩阵", () => {
  test("Bash(git *)：完整字段与缺省 action/scope", () => {
    const rule = assertRule(parseRule("Bash(git *)"));
    expect(rule).toEqual({ tool: "Bash", pattern: "git *", action: "allow", scope: "always" });
  });

  test("Read(*.ts)：basename 通配 pattern 原样保留", () => {
    expect(assertRule(parseRule("Read(*.ts)")).pattern).toBe("*.ts");
  });

  test("Write(src/**)：多段递归 pattern 原样保留", () => {
    const rule = assertRule(parseRule("Write(src/**)"));
    expect(rule.tool).toBe("Write");
    expect(rule.pattern).toBe("src/**");
  });

  test("Bash(rm -rf *)：危险命令 pattern 原样保留", () => {
    expect(assertRule(parseRule("Bash(rm -rf *)")).pattern).toBe("rm -rf *");
  });

  test("无括号 Bash = 整工具匹配，pattern 归一化为 *", () => {
    expect(assertRule(parseRule("Bash"))).toEqual({
      tool: "Bash",
      pattern: "*",
      action: "allow",
      scope: "always",
    });
  });

  test("空括号 Bash() = 该工具全匹配，pattern 归一化为 *", () => {
    expect(assertRule(parseRule("Bash()")).pattern).toBe("*");
  });

  test("规则原文首尾空白 trim", () => {
    expect(assertRule(parseRule("  Bash(git *)  ")).pattern).toBe("git *");
  });

  test("括号内首尾 padding trim，中间空白原样保留", () => {
    expect(assertRule(parseRule("Bash(  git  *  )")).pattern).toBe("git  *");
  });

  test("extglob 嵌套括号 pattern 完整保留（取首 ( 到末 ) 之间）", () => {
    expect(assertRule(parseRule("Bash(!(git|npm) *)")).pattern).toBe("!(git|npm) *");
  });

  test("mcp 命名空间工具名（下划线）合法", () => {
    const rule = assertRule(parseRule("mcp__fs__read_file(src/**)"));
    expect(rule.tool).toBe("mcp__fs__read_file");
    expect(rule.pattern).toBe("src/**");
  });

  test("defaults.action：deny 节解析", () => {
    expect(assertRule(parseRule("Bash(rm -rf *)", { action: "deny" })).action).toBe("deny");
  });

  test("defaults.scope：session 生命周期标注", () => {
    expect(assertRule(parseRule("Bash(git *)", { scope: "session" })).scope).toBe("session");
  });

  test("空串 → ParseError(empty)", () => {
    const err = assertError(parseRule(""));
    expect(err.code).toBe("empty");
    expect(err.ok).toBe(false);
  });

  test("纯空白 → ParseError(empty)", () => {
    expect(assertError(parseRule("   \t ")).code).toBe("empty");
  });

  test("未闭合括号 Bash(git * → ParseError(bad_form)", () => {
    expect(assertError(parseRule("Bash(git *")).code).toBe("bad_form");
  });

  test(") 先于 ( 出现 → ParseError(bad_form)", () => {
    expect(assertError(parseRule("Bash)git (*")).code).toBe("bad_form");
  });

  test("只有括号无工具名 (git *) → ParseError(bad_tool)", () => {
    expect(assertError(parseRule("(git *)")).code).toBe("bad_tool");
  });

  test("工具名含空白 Ba sh(git *) → ParseError(bad_tool)", () => {
    expect(assertError(parseRule("Ba sh(git *)")).code).toBe("bad_tool");
  });

  test(") 之后存在尾随内容 Bash(git *) junk → ParseError(bad_form)", () => {
    expect(assertError(parseRule("Bash(git *) junk")).code).toBe("bad_form");
  });

  test("判别收窄契约：合法规则无 ok 字段，ParseError 恒 ok:false", () => {
    const ok = parseRule("Bash");
    expect("ok" in ok).toBe(false);
    const bad = parseRule("!!!");
    expect("ok" in bad).toBe(true);
  });
});

describe("BI-06.5 matchRule：工具精确匹配 + picomatch 参数匹配", () => {
  const rule = (tool: string, pattern: string): PermissionRule => ({
    tool,
    pattern,
    action: "allow",
    scope: "always",
  });

  test("精确工具 + 精确参数串命中", () => {
    expect(matchRule(rule("Read", "src/a.ts"), req("Read", "src/a.ts"))).toBe(true);
  });

  test("工具名不同不命中（参数串相同也不命中）", () => {
    expect(matchRule(rule("Read", "src/a.ts"), req("Write", "src/a.ts"))).toBe(false);
  });

  test("工具名大小写敏感", () => {
    expect(matchRule(rule("bash", "*"), req("Bash", "ls"))).toBe(false);
  });

  test("pattern * 全匹配（含空参数串：picomatch('*')('') 为 false，须显式短路）", () => {
    expect(matchRule(rule("Bash", "*"), req("Bash", "any command"))).toBe(true);
    expect(matchRule(rule("Bash", "*"), req("Bash", ""))).toBe(true);
  });

  test("pattern 空串全匹配（含空参数串）", () => {
    expect(matchRule(rule("Bash", ""), req("Bash", "ls -la"))).toBe(true);
    expect(matchRule(rule("Bash", ""), req("Bash", ""))).toBe(true);
  });

  test("前缀模式 Bash(git *)：命中 git 子命令，不命中其他命令", () => {
    const git = rule("Bash", "git *");
    expect(matchRule(git, req("Bash", "git status"))).toBe(true);
    expect(matchRule(git, req("Bash", "git push -f origin main"))).toBe(true);
    expect(matchRule(git, req("Bash", "npm i"))).toBe(false);
  });

  test("Read(*.ts)：命中单段文件名，不跨路径段（picomatch 标准 glob 语义钉死）", () => {
    const ts = rule("Read", "*.ts");
    expect(matchRule(ts, req("Read", "a.ts"))).toBe(true);
    expect(matchRule(ts, req("Read", "src/a.ts"))).toBe(false);
  });

  test("dot 裁定：Read(*.ts) 命中点开头文件（引擎统一 dot:true，fail-closed）", () => {
    expect(matchRule(rule("Read", "*.ts"), req("Read", ".hidden.ts"))).toBe(true);
  });

  test("Write(src/**)：命中目录本身与任意深度子路径，不命中前缀相近目录", () => {
    const writeSrc = rule("Write", "src/**");
    expect(matchRule(writeSrc, req("Write", "src"))).toBe(true);
    expect(matchRule(writeSrc, req("Write", "src/a/b/c.ts"))).toBe(true);
    expect(matchRule(writeSrc, req("Write", "srcx/a"))).toBe(false);
  });

  test("Read(src/**/*.ts)：零段 globstar 命中 src/a.ts，深嵌套命中，扩展名不匹配不命中", () => {
    const nested = rule("Read", "src/**/*.ts");
    expect(matchRule(nested, req("Read", "src/a.ts"))).toBe(true);
    expect(matchRule(nested, req("Read", "src/x/y/z.ts"))).toBe(true);
    expect(matchRule(nested, req("Read", "src/a.js"))).toBe(false);
  });

  test("嵌套路径 **/node_modules/**：根级与深嵌套均命中", () => {
    const nm = rule("Read", "**/node_modules/**");
    expect(matchRule(nm, req("Read", "node_modules/x/y"))).toBe(true);
    expect(matchRule(nm, req("Read", "a/b/node_modules/x/y"))).toBe(true);
  });

  test("空参数串不命中非全匹配 pattern", () => {
    expect(matchRule(rule("Bash", "git *"), req("Bash", ""))).toBe(false);
  });

  test("extglob pattern：!(git|npm) * 命中其他命令", () => {
    expect(matchRule(rule("Bash", "!(git|npm) *"), req("Bash", "cargo build"))).toBe(true);
    expect(matchRule(rule("Bash", "!(git|npm) *"), req("Bash", "git status"))).toBe(false);
  });
});

describe("BI-06.5 evaluateRules：配置顺序、首个命中生效", () => {
  const rule = (tool: string, pattern: string, action: "allow" | "deny"): PermissionRule => ({
    tool,
    pattern,
    action,
    scope: "always",
  });

  test("首中生效：同 scope 重复覆盖时返回配置顺序第一条", () => {
    const first = rule("Bash", "git *", "allow");
    const second = rule("Bash", "git *", "deny");
    expect(evaluateRules([first, second], req("Bash", "git push"))).toBe(first);
  });

  test("deny 在前拦截 allow 在后：首个命中决定结果", () => {
    const deny = rule("Bash", "rm *", "deny");
    const allow = rule("Bash", "rm x", "allow");
    const hit = evaluateRules([deny, allow], req("Bash", "rm x"));
    expect(hit).toBe(deny);
    expect(hit?.action).toBe("deny");
  });

  test("无命中返回 undefined", () => {
    expect(evaluateRules([rule("Read", "*.ts", "allow")], req("Bash", "ls"))).toBeUndefined();
  });

  test("跨工具规则被跳过，不影响目标工具命中", () => {
    const allow = rule("Bash", "git *", "allow");
    expect(evaluateRules([rule("Read", "*", "deny"), allow], req("Bash", "git push"))).toBe(allow);
  });

  test("空规则表返回 undefined", () => {
    expect(evaluateRules([], req("Bash", "anything"))).toBeUndefined();
  });

  test("pattern * 规则兜底命中该工具全部请求", () => {
    const catchAll = rule("Bash", "*", "deny");
    expect(evaluateRules([catchAll], req("Bash", ""))).toBe(catchAll);
  });
});
