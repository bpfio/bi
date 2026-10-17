import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigService } from "./config-service";
import { ConfigError } from "./schema";
import type { BiConfigLayer } from "./schema";
import { createTempDirs, ensureBiDirs, writeHomeConfig, writeLocalConfig, type TempDirs } from "./test-helpers";

let temp: TempDirs;
let home = "";
let work = "";

beforeEach(async () => {
  temp = await createTempDirs("bi-svc");
  home = temp.home;
  work = temp.work;
  await ensureBiDirs(home, work);
});

afterEach(async () => {
  await temp.cleanup();
});

describe("ConfigService: 路径注入", () => {
  test("三级文件全部落在注入的临时目录", () => {
    const service = new ConfigService({ homeDir: home, workDir: work });
    expect(service.paths.homeDir).toBe(home);
    expect(service.paths.workDir).toBe(work);
    expect(service.paths.globalConfig).toBe(join(home, ".bi", "config.toml"));
    expect(service.paths.tuiConfig).toBe(join(home, ".bi", "tui.toml"));
    expect(service.paths.localConfig).toBe(join(work, ".bi", "local.toml"));
  });

  test("空目录首次加载：全部默认值，不抛错", async () => {
    const service = new ConfigService({ homeDir: home, workDir: work, env: {} });
    const config = await service.load();
    expect(config.identity.name).toBe("bi");
    expect(config.tui.theme).toBe("dark");
    expect(service.issues).toEqual([]);
  });
});

describe("ConfigService: 多源优先级合并", () => {
  test("CLI > env > local.toml > tui.toml > config.toml > 默认值", async () => {
    await writeHomeConfig(
      home,
      "config.toml",
      [
        "# 全局运行配置",
        "[read]",
        "max_file_size_kb = 128",
        "",
        "[tui]",
        "theme = 'global-dark'",
        "",
        "[providers.entries.openai]",
        'api_key_env = "OPENAI_API_KEY"',
        'base_url = "https://api.openai.com/v1"',
        "",
        "[providers.entries.local-llm]",
        'base_url = "http://127.0.0.1:8080"',
        "",
      ].join("\n"),
    );
    await writeHomeConfig(home, "tui.toml", "# 终端外观偏好\ntheme = 'tui-light'\n");
    await writeLocalConfig(
      work,
      [
        "# 工作区私有覆盖（不入 Git）",
        "[tools]",
        'deny = ["rm", "dd"]',
        "",
        "[models]",
        'default = "m-local"',
        "",
        "[workspace]",
        'additional_dir = "../shared-lib"',
        "",
      ].join("\n"),
    );

    const service = new ConfigService({
      homeDir: home,
      workDir: work,
      env: { BI_MODEL: "m-env", BI_TOOLS_ALLOW: "read, grep", OPENAI_API_KEY: "sk-test-1234567890abcd" },
      cliOverrides: { models: { default: "m-cli" } } satisfies BiConfigLayer,
    });
    const config = await service.load();

    // CLI Flags 最高
    expect(config.models.default).toBe("m-cli");
    // 环境变量次之（数组整体替换 local 的 deny 之外的字段；allow 只来自 env）
    expect(config.tools.allow).toEqual(["read", "grep"]);
    // local.toml 覆盖文件层与默认值
    expect(config.tools.deny).toEqual(["rm", "dd"]);
    expect(config.workspace.additional_dir).toBe("../shared-lib");
    // tui.toml 在 tui 分区上覆盖 config.toml
    expect(config.tui.theme).toBe("tui-light");
    // config.toml 生效于未被更高层覆盖的分区
    expect(config.read.max_file_size_kb).toBe(128);
    // 默认值兜底
    expect(config.identity.name).toBe("bi");
    expect(config.thinking.effort).toBe("medium");
  });

  test("诊断按来源层标注（未知键 / 类型错误）", async () => {
    await writeLocalConfig(work, "unknown_key = 1\n[read]\nmax_file_size_kb = 'oops'\n");
    const service = new ConfigService({ homeDir: home, workDir: work, env: {} });
    const config = await service.load();
    expect(config.read.max_file_size_kb).toBe(512); // 回退默认值
    const issues = service.issues;
    expect(issues.some((i) => i.source === "local.toml" && i.path === "unknown_key")).toBe(true);
    expect(issues.some((i) => i.source === "local.toml" && i.path === "read.max_file_size_kb")).toBe(true);
  });

  test("环境变量非法枚举：记录诊断并回退默认值", async () => {
    const service = new ConfigService({
      homeDir: home,
      workDir: work,
      env: { BI_THINKING_EFFORT: "bogus" },
    });
    const config = await service.load();
    expect(config.thinking.effort).toBe("medium");
    expect(service.issues.some((i) => i.source === "env" && i.path === "thinking.effort")).toBe(true);
  });

  test("config.toml 语法错误：load 拒绝并指向文件", async () => {
    await writeHomeConfig(home, "config.toml", "[read\nmax_file_size_kb = 128\n");
    const service = new ConfigService({ homeDir: home, workDir: work, env: {} });
    let message = "";
    try {
      await service.load();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toContain("config.toml 解析失败");
    expect(message).toContain(join(home, ".bi", "config.toml"));
  });
});

describe("ConfigService: api_key_env 间接引用", () => {
  async function serviceWithProvider(env: Record<string, string | undefined>): Promise<ConfigService> {
    await writeHomeConfig(
      home,
      "config.toml",
      [
        "[providers.entries.openai]",
        'api_key_env = "OPENAI_API_KEY"',
        "",
        "[providers.entries.local-llm]",
        'base_url = "http://127.0.0.1:8080"',
        "",
      ].join("\n"),
    );
    const service = new ConfigService({ homeDir: home, workDir: work, env });
    await service.load();
    return service;
  }

  test("环境变量已设置：返回原始密钥", async () => {
    const service = await serviceWithProvider({ OPENAI_API_KEY: "sk-test-1234567890abcd" });
    expect(service.resolveProviderApiKey("openai")).toBe("sk-test-1234567890abcd");
  });

  test("未声明 api_key_env：返回 undefined（OAuth / 本地端点）", async () => {
    const service = await serviceWithProvider({});
    expect(service.resolveProviderApiKey("local-llm")).toBeUndefined();
  });

  test("环境变量未设置：友好报错（含变量名、provider 名与指引）", async () => {
    const service = await serviceWithProvider({ OPENAI_API_KEY: undefined });
    let message = "";
    try {
      service.resolveProviderApiKey("openai");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toContain("OPENAI_API_KEY");
    expect(message).toContain("openai");
    expect(message).toContain("api_key_env");
    expect(message).toContain("~/.bashrc");
  });

  test("未知 provider：报错并列出已配置项", async () => {
    const service = await serviceWithProvider({});
    let message = "";
    try {
      service.resolveProviderApiKey("nope");
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toContain("未知的 provider");
    expect(message).toContain("openai");
    expect(message).toContain("local-llm");
  });

  test("记录条目缺失字段回填内置默认（合并回归）", async () => {
    // local-llm 条目只写了 base_url：其余字段必须为强类型默认值，而不是 undefined
    const config = await serviceWithProvider({});
    const entry = config.current.providers.entries["local-llm"];
    expect(entry?.api_key_env).toBe("");
    expect(entry?.kind).toBe("openai");
    expect(entry?.models).toEqual([]);
    expect(entry?.base_url).toBe("http://127.0.0.1:8080");
  });
});

describe("ConfigService: 热重载 reloadTui", () => {
  test("仅重读 tui.toml，其余层保持", async () => {
    await writeHomeConfig(home, "config.toml", "[read]\nmax_file_size_kb = 128\n");
    await writeHomeConfig(home, "tui.toml", "theme = 'tui-light'\n");
    const service = new ConfigService({ homeDir: home, workDir: work, env: {} });
    await service.load();

    await writeHomeConfig(home, "tui.toml", "theme = 'solarized-dark'\n");
    const reloaded = await service.reloadTui();
    expect(reloaded.tui.theme).toBe("solarized-dark");
    expect(reloaded.read.max_file_size_kb).toBe(128);

    // 全量 reload 同样能拿到新值
    await service.reload(false);
    expect(service.current.tui.theme).toBe("solarized-dark");
  });

  test("reload / reloadTui 触发 onChange 通知", async () => {
    const service = new ConfigService({ homeDir: home, workDir: work, env: {} });
    await service.load();
    const triggers: string[] = [];
    service.onChange((_config, meta) => {
      triggers.push(meta.trigger);
    });
    await service.reload();
    await service.reloadTui();
    expect(triggers).toEqual(["reload", "reloadTui"]);
  });
});

describe("ConfigService: 回写挂接", () => {
  test("writeback 落到指定层并可 reload 读回", async () => {
    const service = new ConfigService({ homeDir: home, workDir: work, env: {} });
    await service.load();
    await service.writeback("local", [{ path: ["workspace", "additional_dir"], value: "../other-lib" }]);
    const written = await readFile(join(work, ".bi", "local.toml"), "utf8");
    expect(written).toContain('additional_dir = "../other-lib"');

    await service.reload(false);
    expect(service.current.workspace.additional_dir).toBe("../other-lib");
  });

  test("writebackTable 整表同步到 provider 条目", async () => {
    const service = new ConfigService({ homeDir: home, workDir: work, env: {} });
    await service.load();
    await service.writebackTable("global", ["providers", "entries", "openai"], {
      api_key_env: "OPENAI_API_KEY",
      base_url: "https://api.openai.com/v1",
      kind: "openai",
      models: ["gpt-4o", "o3"],
    });
    await service.reload(false);
    const entry = service.current.providers.entries["openai"];
    expect(entry?.api_key_env).toBe("OPENAI_API_KEY");
    expect(entry?.kind).toBe("openai");
    expect(entry?.models).toEqual(["gpt-4o", "o3"]);
  });
});

describe("ConfigService: 脱敏快照", () => {
  test("redactedSnapshot 返回可传输视图", async () => {
    const service = new ConfigService({ homeDir: home, workDir: work, env: {} });
    await service.load();
    const view = service.redactedSnapshot();
    expect(view.identity.name).toBe("bi");
    expect(JSON.stringify(view)).not.toContain("undefined");
  });
});
