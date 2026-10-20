/**
 * BI-24.x —— `bi config` 子命令验收（get/set/list/未知键/非法值）。
 *
 * 全部走 runBi 主分发 + SubcommandDeps.homeDir 注入临时目录，零网络、绝不触碰真实 ~/.bi：
 *   - list：列出全部合法键 + 当前生效值；
 *   - get：读生效值；未知键结构化报错并列出合法键；
 *   - set：写回 config.toml（注释保留引擎），非法布尔/数字/枚举值结构化报错；
 *   - 缺/多位置参数、缺动作、未知动作 → exit 2。
 * 另含 configKeySurface / coerceConfigValue / renderConfigValue 单元断言（键面由 schema 推导）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBi } from "./main";
import {
  configKeySurface,
  coerceConfigValue,
  handleConfig,
  renderConfigValue,
} from "./commands/config";
import type { SubcommandIo } from "./commands/dispatch";

let dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

async function tmpHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bi-config-"));
  dirs.push(dir);
  return dir;
}

function collect(): { io: SubcommandIo; outs: string[]; errs: string[] } {
  const outs: string[] = [];
  const errs: string[] = [];
  return { io: { out: (l) => outs.push(l), err: (l) => errs.push(l) }, outs, errs };
}

describe("BI-24.x config · 键面与单元", () => {
  test("configKeySurface：由 schema 默认树推导标量叶子，含典型键、排除表/记录", () => {
    const surface = configKeySurface();
    expect(surface).toContain("identity.name");
    expect(surface).toContain("workspace.additional_dir");
    expect(surface).toContain("telemetry.enabled");
    expect(surface).toContain("thinking.effort");
    expect(surface).toContain("tools.allow");
    expect(surface).toContain("read.max_file_size_kb");
    // 表/记录（对象）不应作为叶子出现；空数组叶子（实体表默认空）按 string[] 纳入，设值由 schema 校验拦截
    expect(surface).not.toContain("providers.entries");
    expect(surface).not.toContain("models.entries");
    expect(surface).not.toContain("mcp.servers");
    expect(surface).not.toContain("tui.keybindings");
  });

  test("coerceConfigValue：按目标类型强类型化", () => {
    expect(coerceConfigValue("true", false)).toEqual({ value: true });
    expect(coerceConfigValue("FALSE", false)).toEqual({ value: false });
    expect(coerceConfigValue("yes", false)?.error).toContain("非法布尔值");
    expect(coerceConfigValue("1024", 0)).toEqual({ value: 1024 });
    expect(coerceConfigValue("7.5", 0)).toEqual({ value: 7.5 });
    expect(coerceConfigValue("abc", 0)?.error).toContain("非法数字");
    expect(coerceConfigValue("rm,git", ["x"])).toEqual({ value: ["rm", "git"] });
    expect(coerceConfigValue("  a , b ", ["x"])).toEqual({ value: ["a", "b"] });
    expect(coerceConfigValue("hello", "")).toEqual({ value: "hello" });
  });

  test("renderConfigValue：可读单行渲染", () => {
    expect(renderConfigValue(true)).toBe("true");
    expect(renderConfigValue(512)).toBe("512");
    expect(renderConfigValue(["rm", "git"])).toBe('[ "rm", "git" ]');
    expect(renderConfigValue("bi")).toBe("bi");
    expect(renderConfigValue(undefined)).toBe("(未设置)");
  });
});

describe("BI-24.x config · 子命令（临时目录注入）", () => {
  test("list：列出合法键 + 当前生效值", async () => {
    const home = await tmpHome();
    const { io, outs } = collect();
    expect(await runBi(["config", "list"], { ...io, deps: { homeDir: home } })).toBe(0);
    const text = outs.join("\n");
    expect(text).toContain("identity.name = bi"); // 默认生效值
    expect(text).toContain("telemetry.enabled = false");
    expect(text).toContain("workspace.additional_dir = ");
  });

  test("get 未知键 → exit 2 并列出合法键", async () => {
    const home = await tmpHome();
    const { io, errs } = collect();
    expect(await runBi(["config", "get", "no.such.key"], { ...io, deps: { homeDir: home } })).toBe(2);
    const text = errs.join("\n");
    expect(text).toContain("未知配置键");
    expect(text).toContain("identity.name"); // 合法键清单
  });

  test("set/get 往返：string / bool / number / string[]", async () => {
    const home = await tmpHome();

    const set1 = collect();
    expect(await runBi(["config", "set", "identity.name", "my-assistant"], { ...set1.io, deps: { homeDir: home } })).toBe(0);
    expect(set1.outs.join("\n")).toContain("已写入 identity.name = my-assistant");

    const set2 = collect();
    expect(await runBi(["config", "set", "telemetry.enabled", "true"], { ...set2.io, deps: { homeDir: home } })).toBe(0);
    const set3 = collect();
    expect(await runBi(["config", "set", "read.max_file_size_kb", "1024"], { ...set3.io, deps: { homeDir: home } })).toBe(0);
    const set4 = collect();
    expect(await runBi(["config", "set", "tools.allow", "rm,git"], { ...set4.io, deps: { homeDir: home } })).toBe(0);

    const get = collect();
    expect(await runBi(["config", "get", "identity.name"], { ...get.io, deps: { homeDir: home } })).toBe(0);
    expect(get.outs.join("\n")).toContain("my-assistant");
    const getNum = collect();
    expect(await runBi(["config", "get", "read.max_file_size_kb"], { ...getNum.io, deps: { homeDir: home } })).toBe(0);
    expect(getNum.outs.join("\n")).toContain("1024");
    const getArr = collect();
    expect(await runBi(["config", "get", "tools.allow"], { ...getArr.io, deps: { homeDir: home } })).toBe(0);
    expect(getArr.outs.join("\n")).toContain('[ "rm", "git" ]');
    const getBool = collect();
    expect(await runBi(["config", "get", "telemetry.enabled"], { ...getBool.io, deps: { homeDir: home } })).toBe(0);
    expect(getBool.outs.join("\n")).toContain("true");
  });

  test("非法值：枚举越界（thinking.effort）与非法布尔 → exit 2", async () => {
    const home = await tmpHome();
    const e = collect();
    expect(await runBi(["config", "set", "thinking.effort", "bogus"], { ...e.io, deps: { homeDir: home } })).toBe(2);
    expect(e.errs.join("\n")).toContain("非法值");
    expect(e.errs.join("\n")).toContain("期望枚举");

    const b = collect();
    expect(await runBi(["config", "set", "telemetry.enabled", "maybe"], { ...b.io, deps: { homeDir: home } })).toBe(2);
    expect(b.errs.join("\n")).toContain("非法布尔值");
  });

  test("非法数字：read.max_file_size_kb 设非数字 → exit 2", async () => {
    const home = await tmpHome();
    const n = collect();
    expect(await runBi(["config", "set", "read.max_file_size_kb", "huge"], { ...n.io, deps: { homeDir: home } })).toBe(2);
    expect(n.errs.join("\n")).toContain("非法数字");
  });

  test("set 未知键 → exit 2 并列出合法键", async () => {
    const home = await tmpHome();
    const u = collect();
    expect(await runBi(["config", "set", "providers.entries.openai.api_key_env", "X"], { ...u.io, deps: { homeDir: home } })).toBe(2);
    expect(u.errs.join("\n")).toContain("未知配置键");
  });

  test("用法错误：缺动作 / 缺位置参数 / 多位置参数 → exit 2", async () => {
    const home = await tmpHome();
    const none = collect();
    expect(await runBi(["config"], { ...none.io, deps: { homeDir: home } })).toBe(2);

    const getNoArg = collect();
    expect(await runBi(["config", "get"], { ...getNoArg.io, deps: { homeDir: home } })).toBe(2);

    const setNoVal = collect();
    expect(await runBi(["config", "set", "identity.name"], { ...setNoVal.io, deps: { homeDir: home } })).toBe(2);

    const tooMany = collect();
    expect(await runBi(["config", "set", "identity.name", "a", "b"], { ...tooMany.io, deps: { homeDir: home } })).toBe(2);

    const badAction = collect();
    expect(await runBi(["config", "frobnicate"], { ...badAction.io, deps: { homeDir: home } })).toBe(2);
  });

  test("写回真实落盘：config.toml 包含设置项（注释保留引擎）", async () => {
    const home = await tmpHome();
    const io = collect();
    await runBi(["config", "set", "identity.name", "persisted"], { ...io.io, deps: { homeDir: home } });
    const cfg = await import("node:fs/promises").then((m) => m.readFile(join(home, ".bi", "config.toml"), "utf8"));
    expect(cfg).toContain("[identity]");
    expect(cfg).toContain('name = "persisted"');
  });

  test("handleConfig 直接调用：未知键经结构化错误（单元级）", async () => {
    const home = await tmpHome();
    const { io, errs } = collect();
    const code = await handleConfig(["get", "nope.x"], io, { homeDir: home });
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("未知配置键");
  });
});

describe("PROD-2 config · help 面", () => {
  test("bi config --help → exit 0 且含用法关键词", async () => {
    const home = await tmpHome();
    const { io, outs } = collect();
    expect(await runBi(["config", "--help"], { ...io, deps: { homeDir: home } })).toBe(0);
    expect(outs.join("\n")).toContain("get <key>");
    // 帮助本身不应附带"运行 bi config --help 查看用法"提示（提示只挂在用法错误上）。
    expect(outs.join("\n")).not.toContain("运行 bi config --help 查看用法");
  });

  test("用法错误尾部追加 help 提示（未知动作 → exit 2）", async () => {
    const home = await tmpHome();
    const { io, errs } = collect();
    expect(await runBi(["config", "frobnicate"], { ...io, deps: { homeDir: home } })).toBe(2);
    expect(errs.join("\n")).toContain("运行 bi config --help 查看用法");
  });
});

describe("PROD-3 config · 六挂载分区键面（verify/subagent/ptc/cron/context/memory）", () => {
  // —— 缺省态 get：分区缺省不在 DEFAULT_BI_CONFIG，须从分区 schema 缺省解析 ——
  test("get 缺省态：六分区标量键读分区 schema 缺省", async () => {
    const home = await tmpHome();
    const cases: Array<[string, string]> = [
      ["ptc.enabled", "false"],
      ["ptc.timeout_ms", "30000"],
      ["ptc.max_tool_calls", "64"],
      ["cron.enabled", "false"],
      ["subagent.enabled", "false"],
      ["subagent.default_profile", "explore"],
      ["subagent.max_iterations", "8"],
      ["context.time_context", "false"],
      ["context.max_history_entries", "0"],
      ["context.timezone", "Asia/Shanghai"],
      ["memory.dream_enabled", "false"],
      ["memory.inject_enabled", "false"],
      ["verify.on_completion", "false"],
      ["verify.objective", ""],
    ];
    for (const [key, expected] of cases) {
      const { io, outs } = collect();
      expect(await runBi(["config", "get", key], { ...io, deps: { homeDir: home } })).toBe(0);
      expect(outs.join("\n"), `缺省态 ${key}`).toContain(expected);
    }
  });

  // —— list：输出含六分区新键 ——
  test("list：含六分区挂载键", async () => {
    const home = await tmpHome();
    const { io, outs } = collect();
    expect(await runBi(["config", "list"], { ...io, deps: { homeDir: home } })).toBe(0);
    const text = outs.join("\n");
    for (const key of [
      "ptc.enabled",
      "ptc.timeout_ms",
      "ptc.max_tool_calls",
      "cron.enabled",
      "subagent.enabled",
      "subagent.default_profile",
      "context.time_context",
      "context.timezone",
      "memory.dream_enabled",
      "memory.inject_enabled",
      "verify.on_completion",
    ]) {
      expect(text, `list 含 ${key}`).toContain(`${key} =`);
    }
  });

  // —— set/get 往返：bool / int / string / enum 四类 ——
  test("set/get 往返：ptc.enabled(bool) / context.max_history_entries(int) / context.timezone(str) / subagent.default_profile(enum)", async () => {
    const home = await tmpHome();

    const s1 = collect();
    expect(await runBi(["config", "set", "ptc.enabled", "true"], { ...s1.io, deps: { homeDir: home } })).toBe(0);
    expect(s1.outs.join("\n")).toContain("已写入 ptc.enabled = true");

    const s2 = collect();
    expect(await runBi(["config", "set", "context.max_history_entries", "50"], { ...s2.io, deps: { homeDir: home } })).toBe(0);
    expect(s2.outs.join("\n")).toContain("已写入 context.max_history_entries = 50");

    const s3 = collect();
    expect(await runBi(["config", "set", "context.timezone", "UTC"], { ...s3.io, deps: { homeDir: home } })).toBe(0);
    expect(s3.outs.join("\n")).toContain("已写入 context.timezone = UTC");

    const s4 = collect();
    expect(await runBi(["config", "set", "subagent.default_profile", "coder"], { ...s4.io, deps: { homeDir: home } })).toBe(0);
    expect(s4.outs.join("\n")).toContain("已写入 subagent.default_profile = coder");

    // 回读
    const g1 = collect();
    expect(await runBi(["config", "get", "ptc.enabled"], { ...g1.io, deps: { homeDir: home } })).toBe(0);
    expect(g1.outs.join("\n")).toContain("true");
    const g2 = collect();
    expect(await runBi(["config", "get", "context.max_history_entries"], { ...g2.io, deps: { homeDir: home } })).toBe(0);
    expect(g2.outs.join("\n")).toContain("50");
    const g3 = collect();
    expect(await runBi(["config", "get", "context.timezone"], { ...g3.io, deps: { homeDir: home } })).toBe(0);
    expect(g3.outs.join("\n")).toContain("UTC");
    const g4 = collect();
    expect(await runBi(["config", "get", "subagent.default_profile"], { ...g4.io, deps: { homeDir: home } })).toBe(0);
    expect(g4.outs.join("\n")).toContain("coder");
  });

  // —— 写回真实落盘：config.toml 含挂载分区表 ——
  test("写回落盘：config.toml 含 [ptc] 表与设置项", async () => {
    const home = await tmpHome();
    const io = collect();
    await runBi(["config", "set", "ptc.enabled", "true"], { ...io.io, deps: { homeDir: home } });
    const cfg = await import("node:fs/promises").then((m) => m.readFile(join(home, ".bi", "config.toml"), "utf8"));
    expect(cfg).toContain("[ptc]");
    expect(cfg).toContain("enabled = true");
  });

  // —— 非法值：跟随分区 schema 类型，结构化报错 exit 2 ——
  test("非法值：ptc.enabled(bool 越界) / context.max_history_entries(非数字) / subagent.default_profile(枚举越界) / ptc.timeout_ms(非数字)", async () => {
    const home = await tmpHome();

    const b = collect();
    expect(await runBi(["config", "set", "ptc.enabled", "yes"], { ...b.io, deps: { homeDir: home } })).toBe(2);
    expect(b.errs.join("\n")).toContain("非法布尔值");

    const n = collect();
    expect(await runBi(["config", "set", "context.max_history_entries", "huge"], { ...n.io, deps: { homeDir: home } })).toBe(2);
    expect(n.errs.join("\n")).toContain("非法数字");

    const e = collect();
    expect(await runBi(["config", "set", "subagent.default_profile", "wizard"], { ...e.io, deps: { homeDir: home } })).toBe(2);
    expect(e.errs.join("\n")).toContain("期望枚举");

    const t = collect();
    expect(await runBi(["config", "set", "ptc.timeout_ms", "soon"], { ...t.io, deps: { homeDir: home } })).toBe(2);
    expect(t.errs.join("\n")).toContain("非法数字");
  });

  // —— 实体数组叶子（verify.deliverables / verify.checks）注册为键但不可单值 set（schema 校验拦截）——
  test("verify 实体数组叶子：list 含键、get 读缺省空数组、单值 set 被 schema 校验拦截 exit 2", async () => {
    const home = await tmpHome();
    const l = collect();
    expect(await runBi(["config", "list"], { ...l.io, deps: { homeDir: home } })).toBe(0);
    expect(l.outs.join("\n")).toContain("verify.deliverables =");
    expect(l.outs.join("\n")).toContain("verify.checks =");

    const g = collect();
    expect(await runBi(["config", "get", "verify.deliverables"], { ...g.io, deps: { homeDir: home } })).toBe(0);
    expect(g.outs.join("\n")).toContain("[  ]");

    const s = collect();
    expect(await runBi(["config", "set", "verify.deliverables", "foo"], { ...s.io, deps: { homeDir: home } })).toBe(2);
    expect(s.errs.join("\n")).toContain("非法值");
  });

  // —— 未知键仍报 exit 2（六分区键已识别，但虚构子键仍非法）——
  test("未知键（虚构挂载子键） → exit 2", async () => {
    const home = await tmpHome();
    const u = collect();
    expect(await runBi(["config", "get", "ptc.nope"], { ...u.io, deps: { homeDir: home } })).toBe(2);
    expect(u.errs.join("\n")).toContain("未知配置键");
    expect(u.errs.join("\n")).toContain("ptc.enabled"); // 合法键清单含新键
  });
});
