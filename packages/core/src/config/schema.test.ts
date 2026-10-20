import { describe, expect, test } from "bun:test";
import {
  BI_CONFIG_SCHEMA,
  DEFAULT_BI_CONFIG,
  buildEnvLayer,
  createDefaultConfig,
  deepMergeLayer,
  setDottedPath,
  validateConfigLayer,
  type BiConfig,
  type BiConfigLayer,
  type ConfigIssue,
} from "./schema";

function validate(raw: unknown): { layer: BiConfigLayer | undefined; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  const layer = validateConfigLayer(raw, issues);
  return { layer, issues };
}

describe("schema: 分区与默认值", () => {
  test("根配置包含 17 个强类型分区（≥15 达标）", () => {
    const keys = Object.keys(DEFAULT_BI_CONFIG).sort();
    expect(keys).toEqual(
      [
        "a2a",
        "hooks",
        "identity",
        "image",
        "loop_control",
        "mcp",
        "models",
        "permission",
        "providers",
        "read",
        "secondary_model",
        "telemetry",
        "thinking",
        "tools",
        "tui",
        "watch",
        "workspace",
      ].sort(),
    );
  });

  test("内置默认值关键项正确", () => {
    expect(DEFAULT_BI_CONFIG.thinking.effort).toBe("medium");
    expect(DEFAULT_BI_CONFIG.thinking.enabled).toBe(true);
    expect(DEFAULT_BI_CONFIG.tools.allow).toEqual([]);
    // BI-08.3 / BI-07.11：挂载式门控缺省 false（工具面零变动）。
    expect(DEFAULT_BI_CONFIG.tools.media).toBe(false);
    expect(DEFAULT_BI_CONFIG.tools.job_tools).toBe(false);
    expect(DEFAULT_BI_CONFIG.providers.entries).toEqual({});
    expect(DEFAULT_BI_CONFIG.tui.theme).toBe("dark");
    expect(DEFAULT_BI_CONFIG.read.max_file_size_kb).toBe(512);
    expect(DEFAULT_BI_CONFIG.permission.mode).toBe("default");
    expect(DEFAULT_BI_CONFIG.telemetry.enabled).toBe(false);
    expect(DEFAULT_BI_CONFIG.identity.name).toBe("bi");
    expect(DEFAULT_BI_CONFIG.watch.debounce_ms).toBe(300);
  });

  test("createDefaultConfig 每次返回全新深拷贝（不共享可变引用）", () => {
    const a = createDefaultConfig();
    const b = createDefaultConfig();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    a.tools.allow.push("hacked");
    a.tui.keybindings["x"] = "y";
    expect(b.tools.allow).toEqual([]);
    expect(b.tui.keybindings).toEqual({});
  });
});

describe("schema: 单层校验", () => {
  test("合法偏对象只保留显式提供的键；空表等价于未提供", () => {
    const { layer, issues } = validate({ thinking: { effort: "high" }, read: { max_output_chars: 1000 } });
    expect(issues).toEqual([]);
    expect(layer).toEqual({ thinking: { effort: "high" }, read: { max_output_chars: 1000 } });

    const emptySection = validate({ thinking: { effort: "high" }, read: {} });
    expect(emptySection.issues).toEqual([]);
    expect(emptySection.layer).toEqual({ thinking: { effort: "high" } });
  });

  test("未知键被丢弃并记录诊断", () => {
    const { layer, issues } = validate({ nope: 1, tools: { unknown_key: true, deny: ["rm"] } });
    expect(layer).toEqual({ tools: { deny: ["rm"] } });
    expect(issues.some((i) => i.path === "nope")).toBe(true);
    expect(issues.some((i) => i.path === "tools.unknown_key")).toBe(true);
  });

  test("类型不符的键被丢弃并记录诊断（不影响兄弟键）", () => {
    const { layer, issues } = validate({ thinking: { enabled: "yes", effort: "low" } });
    expect(layer).toEqual({ thinking: { effort: "low" } });
    const issue = issues.find((i) => i.path === "thinking.enabled");
    expect(issue).toBeDefined();
    expect(issue?.message).toContain("boolean");
  });

  test("枚举值非法时报诊断（整个分区无有效键则等价于未提供）", () => {
    const { layer, issues } = validate({ thinking: { effort: "ultra" } });
    expect(layer).toBeUndefined();
    expect(issues.some((i) => i.path === "thinking.effort" && i.message.includes("枚举"))).toBe(true);
  });

  test("sStrList 容错：误写单字符串自动包装；非法元素逐个丢弃", () => {
    const coerced = validate({ tools: { deny: "rm" } });
    expect(coerced.layer).toEqual({ tools: { deny: ["rm"] } });

    const { layer, issues } = validate({ tools: { allow: ["a", 42, "b"] } });
    expect(layer).toEqual({ tools: { allow: ["a", "b"] } });
    expect(issues.some((i) => i.path === "tools.allow.1")).toBe(true);
  });

  test("对象数组元素级校验（permission.rules）", () => {
    const { layer, issues } = validate({
      permission: {
        rules: [
          { tool: "bash", pattern: "git *", action: "allow" },
          { tool: 42, action: "allow" },
        ],
      },
    });
    const rules = (layer?.permission as { rules?: unknown[] } | undefined)?.rules;
    expect(rules).toHaveLength(1);
    expect(issues.some((i) => i.path === "permission.rules.1.tool")).toBe(true);
  });

  test("记录（Record）键级校验：非法条目丢弃", () => {
    const { layer, issues } = validate({
      providers: {
        entries: {
          openai: { api_key_env: "OPENAI_API_KEY", kind: "openai" },
          bad: { kind: "not-a-kind" },
        },
      },
    });
    const providers = layer?.providers as { entries?: Record<string, unknown> } | undefined;
    expect(providers?.entries?.["openai"]).toBeDefined();
    expect(providers?.entries?.["bad"]).toBeUndefined();
    expect(issues.some((i) => i.path === "providers.entries.bad.kind")).toBe(true);
  });

  test("整层不是 table 时报诊断并返回 undefined", () => {
    const { layer, issues } = validate("not-a-table");
    expect(layer).toBeUndefined();
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe("schema: 深度合并语义", () => {
  test("对象键级递归合并（记录可只覆盖单个条目）", () => {
    const base = createDefaultConfig();
    const layer = validate({
      providers: { entries: { openai: { api_key_env: "OPENAI_API_KEY" } } },
    }).layer;
    deepMergeLayer(base, layer);
    expect(Object.keys(base.providers.entries)).toEqual(["openai"]);
    expect(base.providers.entries["openai"]?.api_key_env).toBe("OPENAI_API_KEY");
  });

  test("数组整体替换", () => {
    const base = createDefaultConfig();
    base.tools.allow = ["a", "b", "c"];
    deepMergeLayer(base, validate({ tools: { allow: ["z"] } }).layer);
    expect(base.tools.allow).toEqual(["z"]);
  });

  test("undefined（本层未提供）跳过，标量后层覆盖前层", () => {
    const base = createDefaultConfig();
    base.read.max_file_size_kb = 128;
    deepMergeLayer(base, validate({ read: { max_output_chars: 1000 } }).layer);
    expect(base.read.max_file_size_kb).toBe(128);
    expect(base.read.max_output_chars).toBe(1000);
  });

  test("合并后仍满足根类型（默认值打底保证完整性）", () => {
    const base = createDefaultConfig();
    deepMergeLayer(base, validate({ models: { default: "m1" } }).layer);
    const complete: BiConfig = base;
    expect(complete.models.default).toBe("m1");
    expect(complete.loop_control.max_iterations).toBe(200);
  });
});

describe("schema: 环境变量层", () => {
  test("ENV 映射到对应路径", () => {
    const layer = validate(
      buildEnvLayer({
        BI_PROVIDER: "openai",
        BI_MODEL: "m-env",
        BI_SECONDARY_MODEL: "sub-m",
        BI_THINKING_EFFORT: "high",
        BI_PERMISSION_MODE: "yolo",
        BI_IDENTITY_NAME: "worker",
        BI_WORKSPACE_ADDITIONAL_DIR: "../shared",
        BI_TOOLS_ALLOW: "read, grep",
        BI_TOOLS_DENY: "rm, dd,,",
      }),
    ).layer;
    expect(layer).toEqual({
      providers: { default: "openai" },
      models: { default: "m-env" },
      secondary_model: { subagent: "sub-m" },
      thinking: { effort: "high" },
      permission: { mode: "yolo" },
      identity: { name: "worker" },
      workspace: { additional_dir: "../shared" },
      tools: { allow: ["read", "grep"], deny: ["rm", "dd"] },
    });
  });

  test("空串环境变量视为未设置", () => {
    const layer = validate(buildEnvLayer({ BI_MODEL: "" })).layer;
    expect(layer).toBeUndefined();
  });

  test("非法枚举环境变量产生诊断且不进层", () => {
    const { layer, issues } = validate(buildEnvLayer({ BI_THINKING_EFFORT: "bogus" }));
    expect(layer).toBeUndefined();
    expect(issues.some((i) => i.source === "env" || i.path === "thinking.effort")).toBe(true);
  });
});

describe("schema: 工具函数", () => {
  test("setDottedPath 创建中间层并写值", () => {
    const target: Record<string, unknown> = {};
    setDottedPath(target, "providers.entries.openai.api_key_env", "X");
    const providers = target["providers"] as Record<string, unknown>;
    const entries = providers["entries"] as Record<string, unknown>;
    const openai = entries["openai"] as Record<string, unknown>;
    expect(openai["api_key_env"]).toBe("X");
  });

  test("根 Schema 默认值与 DEFAULT_BI_CONFIG 一致", () => {
    expect(BI_CONFIG_SCHEMA.defaultValue()).toEqual(DEFAULT_BI_CONFIG);
  });
});

describe("schema: provider extra_headers", () => {
  /** 装载路径（对齐 ConfigService.compose）：校验 → 合并到默认底 → backfill 回填叶子默认。 */
  function load(raw: unknown): { config: BiConfig; issues: ConfigIssue[] } {
    const { layer, issues } = validate(raw);
    const base = createDefaultConfig();
    deepMergeLayer(base, layer);
    BI_CONFIG_SCHEMA.backfill?.(base);
    return { config: base, issues };
  }

  test("字面量装载往返：extra_headers 原样进入 provider 条目", () => {
    const extraHeaders = { "x-opencode-session": "auto", "user-agent": "bi-test/1.0" };
    const { config, issues } = load({
      providers: {
        entries: { p1: { api_key_env: "BI_TEST_KEY", kind: "openai", extra_headers: extraHeaders } },
      },
    });
    expect(issues).toEqual([]);
    expect(config.providers.entries["p1"]?.extra_headers).toEqual(extraHeaders);
    expect(config.providers.entries["p1"]?.kind).toBe("openai");
  });

  test("未声明 extra_headers 的条目：装载后为 {}（强类型缺省，非 undefined）", () => {
    const { config, issues } = load({
      providers: { entries: { p1: { api_key_env: "BI_TEST_KEY", kind: "openai" } } },
    });
    expect(issues).toEqual([]);
    const entry = config.providers.entries["p1"];
    expect(entry?.extra_headers).toEqual({});
    expect(entry?.extra_headers).not.toBeUndefined();
  });

  test("extra_headers 值为非字符串 → 该键丢弃并记录诊断（条目 fail-closed 整体丢弃）", () => {
    const { layer, issues } = validate({
      providers: {
        entries: { p1: { kind: "openai", extra_headers: { "x-bad": 42, "x-ok": "v" } } },
      },
    });
    const entries = (layer?.providers as { entries?: Record<string, unknown> } | undefined)?.entries;
    expect(entries?.["p1"]).toBeUndefined();
    expect(issues.some((i) => i.path === "providers.entries.p1.extra_headers.x-bad")).toBe(true);
  });
});

describe("schema: BI-08.3 / BI-07.11 挂载式门控键", () => {
  /** 装载路径（对齐 ConfigService.compose）：校验 → 合并到默认底 → backfill 回填叶子默认。 */
  function load(raw: unknown): { config: BiConfig; issues: ConfigIssue[] } {
    const { layer, issues } = validate(raw);
    const base = createDefaultConfig();
    deepMergeLayer(base, layer);
    BI_CONFIG_SCHEMA.backfill?.(base);
    return { config: base, issues };
  }

  test("未声明 [tools] media / job_tools → 缺省 false（工具面零变动）", () => {
    const { config, issues } = load({});
    expect(issues).toEqual([]);
    expect(config.tools.media).toBe(false);
    expect(config.tools.job_tools).toBe(false);
  });

  test("显式声明 true/false → 原样透传；类型不符的键丢弃并诊断", () => {
    const { config, issues } = load({ tools: { media: true, job_tools: false } });
    expect(issues).toEqual([]);
    expect(config.tools.media).toBe(true);
    expect(config.tools.job_tools).toBe(false);
    const bad = load({ tools: { media: "yes" } });
    expect(bad.config.tools.media).toBe(false);
    expect(bad.issues.some((i) => i.path === "tools.media")).toBe(true);
  });
});

describe("schema: 虚账清偿 wave0 挂载式键（lsp / select_tools / image_offload / auto_compactor）", () => {
  /** 装载路径（对齐 ConfigService.compose）：校验 → 合并到默认底 → backfill 回填叶子默认。 */
  function load(raw: unknown): { config: BiConfig; issues: ConfigIssue[] } {
    const { layer, issues } = validate(raw);
    const base = createDefaultConfig();
    deepMergeLayer(base, layer);
    BI_CONFIG_SCHEMA.backfill?.(base);
    return { config: base, issues };
  }

  test("缺省 false（缺省路径逐字节等价，工具面零变动）", () => {
    const { config, issues } = load({});
    expect(issues).toEqual([]);
    // tools 为根分区，恒物化：两键缺省 false。
    expect(config.tools.lsp).toBe(false);
    expect(config.tools.select_tools).toBe(false);
    // context 为挂载分区：声明任一有效子键才物化，其余经 backfill 补默认 false。
    const withCtx = load({ context: { time_context: true } }).config;
    expect(withCtx.context?.time_context).toBe(true);
    expect(withCtx.context?.image_offload).toBe(false);
    expect(withCtx.context?.auto_compactor).toBe(false);
  });

  test("显式声明 true/false → 原样透传；类型不符的键丢弃并诊断", () => {
    const { config, issues } = load({
      tools: { lsp: true, select_tools: false },
      context: { image_offload: true, auto_compactor: false },
    });
    expect(issues).toEqual([]);
    expect(config.tools.lsp).toBe(true);
    expect(config.tools.select_tools).toBe(false);
    expect(config.context?.image_offload).toBe(true);
    expect(config.context?.auto_compactor).toBe(false);

    // 类型不符：tools.lsp 整键无效 → 缺省 false；context 整层无效 → 未物化。
    const bad = load({ tools: { lsp: "yes" }, context: { image_offload: 1 } });
    expect(bad.config.tools.lsp).toBe(false);
    expect(bad.config.context).toBeUndefined();
    expect(bad.issues.some((i) => i.path === "tools.lsp")).toBe(true);
    expect(bad.issues.some((i) => i.path === "context.image_offload")).toBe(true);
  });
});

describe("schema: permission.mode 五词面（0.3.0 测试发现修复）", () => {
  function loadMode(mode: unknown): string | undefined {
    const { layer } = validate({ permission: { mode } });
    const perm = layer?.permission as { mode?: string } | undefined;
    return perm?.mode;
  }
  test("auto 与 manual 为合法词面，原样装载（不再静默回退 default）", () => {
    expect(loadMode("auto")).toBe("auto");
    expect(loadMode("manual")).toBe("manual");
  });
  test("原有三态 default/plan/yolo 装载不变", () => {
    expect(loadMode("yolo")).toBe("yolo");
    expect(loadMode("default")).toBe("default");
    expect(loadMode("plan")).toBe("plan");
  });
  test("非法词面仍回退缺省 default", () => {
    expect(loadMode("bogus")).toBeUndefined();
    const { config } = (() => {
      const r = validate({ permission: { mode: "bogus" } });
      const base = createDefaultConfig();
      deepMergeLayer(base, r.layer);
      BI_CONFIG_SCHEMA.backfill?.(base);
      return { config: base };
    })();
    expect(config.permission.mode).toBe("default");
  });
});
