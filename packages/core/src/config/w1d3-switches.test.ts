/**
 * W1-D3（BI-08.1 + BI-11.1 + BI-21.1）· config 面验收。
 *
 * 三开关的 schema 语义、缺省值与合并行为，以及 [verify] 挂载式拓扑：
 * - [tools] output_limit_bytes（缺省 0=off）/ [telemetry] sanitize_errors（缺省 false）
 *   为既有分区的追加键（最小扩展）；
 * - [verify] 为挂载式分区：DEFAULT_BI_CONFIG 恒 17 个根键（既有钉死断言不红），
 *   仅配置层显式声明时物化进合并结果（缺省 config.verify === undefined，
 *   缺省路径逐字节等价于现状）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BI_CONFIG_SCHEMA,
  DEFAULT_BI_CONFIG,
  buildEnvLayer,
  createDefaultConfig,
  deepMergeLayer,
  validateConfigLayer,
  type BiConfig,
  type BiConfigLayer,
  type ConfigIssue,
} from "./schema";
import { ConfigService } from "./config-service";

function validate(raw: unknown): { layer: BiConfigLayer | undefined; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  const layer = validateConfigLayer(raw, issues);
  return { layer, issues };
}

describe("W1-D3 config: 缺省值与 17 根键拓扑（回归）", () => {
  test("三开关缺省键值：output_limit_bytes=0 / sanitize_errors=false / verify 缺省", () => {
    expect(DEFAULT_BI_CONFIG.tools.output_limit_bytes).toBe(0);
    expect(DEFAULT_BI_CONFIG.telemetry.sanitize_errors).toBe(false);
  });

  test("根配置仍为 17 个强类型分区：DEFAULT_BI_CONFIG 不含 verify 键（挂载式拓扑）", () => {
    expect(Object.keys(DEFAULT_BI_CONFIG).sort()).toEqual([
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
    ]);
    expect("verify" in DEFAULT_BI_CONFIG).toBe(false);
    expect(createDefaultConfig().verify).toBeUndefined();
  });

  test("BI_CONFIG_SCHEMA 默认值与 DEFAULT_BI_CONFIG 一致（含新增键）", () => {
    expect(BI_CONFIG_SCHEMA.defaultValue()).toEqual(DEFAULT_BI_CONFIG);
  });

  test("createDefaultConfig 深拷贝不共享（新键同理）", () => {
    const a = createDefaultConfig();
    const b = createDefaultConfig();
    a.tools.output_limit_bytes = 4096;
    a.telemetry.sanitize_errors = true;
    expect(b.tools.output_limit_bytes).toBe(0);
    expect(b.telemetry.sanitize_errors).toBe(false);
  });
});

describe("W1-D3 config: 单层校验（[tools] / [telemetry] 追加键）", () => {
  test("output_limit_bytes：合法整数进层；非整数/非有限记诊断并回退默认", () => {
    const ok = validate({ tools: { output_limit_bytes: 65_536 } });
    expect(ok.issues).toEqual([]);
    expect(ok.layer).toEqual({ tools: { output_limit_bytes: 65_536 } });

    const bad = validate({ tools: { output_limit_bytes: 1.5, deny: ["rm"] } });
    expect(bad.layer).toEqual({ tools: { deny: ["rm"] } });
    expect(bad.issues.some((i) => i.path === "tools.output_limit_bytes")).toBe(true);

    const nan = validate({ tools: { output_limit_bytes: "64k" } });
    expect(nan.layer).toBeUndefined();
    expect(nan.issues.some((i) => i.path === "tools.output_limit_bytes" && i.message.includes("整数"))).toBe(true);
  });

  test("output_limit_bytes 负值通过 schema（≤0 由装配层按关闭处理，不放大故障面）", () => {
    const { layer, issues } = validate({ tools: { output_limit_bytes: -1 } });
    expect(issues).toEqual([]);
    expect(layer).toEqual({ tools: { output_limit_bytes: -1 } });
  });

  test("sanitize_errors：布尔校验 + 类型不符诊断", () => {
    const ok = validate({ telemetry: { sanitize_errors: true } });
    expect(ok.issues).toEqual([]);
    expect(ok.layer).toEqual({ telemetry: { sanitize_errors: true } });

    const bad = validate({ telemetry: { sanitize_errors: "yes", enabled: true } });
    expect(bad.layer).toEqual({ telemetry: { enabled: true } });
    expect(bad.issues.some((i) => i.path === "telemetry.sanitize_errors" && i.message.includes("boolean"))).toBe(true);
  });
});

describe("W1-D3 config: [verify] 挂载式分区", () => {
  test("合法 [verify] 层：显式键进层，缺省键不出现（合并期继承/backfill）", () => {
    const { layer, issues } = validate({
      verify: {
        on_completion: true,
        objective: "修复计算器",
        deliverables: [{ path: "calc.test.ts", must_exist: true, must_contain: ["add"] }],
        checks: [{ id: "tests", command: "bun test", description: "跑测试" }],
      },
    });
    expect(issues).toEqual([]);
    expect(layer).toEqual({
      verify: {
        on_completion: true,
        objective: "修复计算器",
        deliverables: [{ path: "calc.test.ts", must_exist: true, must_contain: ["add"] }],
        checks: [{ id: "tests", command: "bun test", description: "跑测试" }],
      },
    });
  });

  test("[verify] 子键类型不符/未知键记诊断；deliverable/check 条目 fail-closed 整条丢弃", () => {
    const { layer, issues } = validate({
      verify: {
        on_completion: "yes",
        deliverables: [
          { path: "a.txt", must_exist: true },
          { path: 42 },
          { path: "b.txt", unknown_field: 1 },
        ],
        checks: [{ id: "t", command: "true", description: "d", kind: "predicate" }],
      },
    });
    // on_completion 类型不符被丢弃；合法 deliverable 保留（层内仅含显式提供的键，
    // must_contain 未提供故缺省——backfill 才补默认）；两条非法 deliverable 与
    // 夹带未知键的 check 条目 fail-closed 整条丢弃（不留半残条目）。
    const verify = layer?.verify as { deliverables?: unknown[]; checks?: unknown[] } | undefined;
    expect(verify?.deliverables).toEqual([{ path: "a.txt", must_exist: true }]);
    expect(verify?.checks).toEqual([]);
    expect(issues.some((i) => i.path === "verify.on_completion")).toBe(true);
    expect(issues.some((i) => i.path === "verify.deliverables.1.path")).toBe(true);
    expect(issues.some((i) => i.path === "verify.deliverables.2.unknown_field")).toBe(true);
    expect(issues.some((i) => i.path === "verify.checks.0.kind")).toBe(true);
  });

  test("[verify] 空表 / 非 table：等价于未提供（默认路径无 verify 键）", () => {
    expect(validate({ verify: {} }).layer).toBeUndefined();
    const bad = validate({ verify: 42 });
    expect(bad.layer).toBeUndefined();
    expect(bad.issues.some((i) => i.path === "verify")).toBe(true);
  });

  test("[verify] 与既有分区同层共存：未知根键照常诊断（verify 不再误报未知键）", () => {
    const { layer, issues } = validate({ nope: 1, tools: { deny: ["rm"] }, verify: { on_completion: true } });
    expect(layer).toEqual({ tools: { deny: ["rm"] }, verify: { on_completion: true } });
    expect(issues.some((i) => i.path === "nope")).toBe(true);
    expect(issues.some((i) => i.path === "verify")).toBe(false);
  });

  test("合并 + backfill：仅声明 checks 的 [verify] 物化后叶子默认补齐", () => {
    const base = createDefaultConfig();
    deepMergeLayer(base, validate({ verify: { checks: [{ id: "t", command: "true", description: "d" }] } }).layer);
    BI_CONFIG_SCHEMA.backfill?.(base);
    expect(base.verify).toEqual({
      on_completion: false,
      objective: "",
      deliverables: [],
      checks: [{ id: "t", command: "true", description: "d" }],
    });
  });

  test("合并：未声明 [verify] 的层合入后 base 仍无 verify 键（缺省等价）", () => {
    const base = createDefaultConfig();
    deepMergeLayer(base, validate({ tools: { output_limit_bytes: 1024 } }).layer);
    BI_CONFIG_SCHEMA.backfill?.(base);
    expect("verify" in base).toBe(false);
    expect(base.tools.output_limit_bytes).toBe(1024);
  });

  test("整层非 table：诊断 + undefined（与既有根行为一致）", () => {
    const { layer, issues } = validate("not-a-table");
    expect(layer).toBeUndefined();
    expect(issues.length).toBeGreaterThan(0);
  });

  test("env 层不引入 verify（ENV_OVERRIDES 未收录，保持既有映射面）", () => {
    const layer = validate(buildEnvLayer({ BI_TOOLS_ALLOW: "read" })).layer;
    expect(layer).toEqual({ tools: { allow: ["read"] } });
  });
});

describe("W1-D3 config: ConfigService 三级 TOML 端到端", () => {
  async function withHome(files: { config?: string; local?: string }): Promise<{
    home: string;
    work: string;
    cleanup: () => Promise<void>;
  }> {
    const home = await mkdtemp(join(tmpdir(), "bi-w1d3-home-"));
    const work = await mkdtemp(join(tmpdir(), "bi-w1d3-work-"));
    await mkdir(join(home, ".bi"), { recursive: true });
    if (files.config !== undefined) await writeFile(join(home, ".bi", "config.toml"), files.config, "utf8");
    if (files.local !== undefined) {
      await mkdir(join(work, ".bi"), { recursive: true });
      await writeFile(join(work, ".bi", "local.toml"), files.local, "utf8");
    }
    const cleanup = async (): Promise<void> => {
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    };
    return { home, work, cleanup };
  }

  test("config.toml 声明 [verify]：load() 物化且叶子默认补齐", async () => {
    const { home, work, cleanup } = await withHome({
      config: `
[tools]
output_limit_bytes = 2048

[telemetry]
sanitize_errors = true

[verify]
on_completion = true
objective = "交付报告"

[[verify.deliverables]]
path = "report.md"
must_exist = true
must_contain = ["结论"]

[[verify.checks]]
id = "build"
command = "bun run build"
description = "构建"
`,
    });
    try {
      const service = new ConfigService({ homeDir: home, workDir: work });
      const config: BiConfig = await service.load();
      expect(service.issues).toEqual([]);
      expect(config.tools.output_limit_bytes).toBe(2048);
      expect(config.telemetry.sanitize_errors).toBe(true);
      expect(config.verify).toEqual({
        on_completion: true,
        objective: "交付报告",
        deliverables: [{ path: "report.md", must_exist: true, must_contain: ["结论"] }],
        checks: [{ id: "build", command: "bun run build", description: "构建" }],
      });
    } finally {
      await cleanup();
    }
  });

  test("未声明 [verify]：load() 无 verify 键（缺省路径逐字节等价）", async () => {
    const { home, work, cleanup } = await withHome({
      config: `
[tools]
output_limit_bytes = 0
`,
    });
    try {
      const config = await new ConfigService({ homeDir: home, workDir: work }).load();
      expect(config.tools.output_limit_bytes).toBe(0);
      expect(config.telemetry.sanitize_errors).toBe(false);
      expect(config.verify).toBeUndefined();
      expect("verify" in config).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("local.toml 覆盖 config.toml：[verify].on_completion 可被工作区层关闭", async () => {
    const { home, work, cleanup } = await withHome({
      config: `
[verify]
on_completion = true
objective = "x"
`,
      local: `
[verify]
on_completion = false
`,
    });
    try {
      const config = await new ConfigService({ homeDir: home, workDir: work }).load();
      expect(config.verify?.on_completion).toBe(false);
      expect(config.verify?.objective).toBe("x"); // 键级合并：未覆盖的键继承
    } finally {
      await cleanup();
    }
  });

  test("config.toml 的 [verify] 子键非法：记 issue，[verify] 以默认值物化且开关恒 off（不静默放行也不误开）", async () => {
    const { home, work, cleanup } = await withHome({
      config: `
[verify]
on_completion = "yes"

[[verify.deliverables]]
path = 42
`,
    });
    try {
      const service = new ConfigService({ homeDir: home, workDir: work });
      const config = await service.load();
      // 与既有分区同语义：显式声明的表物化，非法键/条目被丢弃并记 issue，
      // 叶子默认经 backfill 补齐——on_completion 恒 false（fail-safe 到 off）。
      expect(config.verify?.on_completion).toBe(false);
      expect(config.verify?.deliverables).toEqual([]);
      expect(service.issues.some((i) => i.path.startsWith("verify"))).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
