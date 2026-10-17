import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { parse as tomlParse } from "smol-toml";
import { ConfigError } from "./schema";
import { planConfigWriteback, planTableSync, writebackConfigFile, type WritebackEdit } from "./writeback";

const SAMPLE = [
  "# 全局运行配置示例",
  "# 由 /config 面板维护",
  "",
  "[read]",
  "# 单文件读取上限",
  "max_file_size_kb = 128  # 原始上限注释",
  "ignore = [",
  '  "node_modules/**",',
  '  "dist/**",  # 构建产物',
  "]",
  "",
  "[providers.entries.openai]",
  'api_key_env = "OPENAI_API_KEY"  # 间接引用，不落明文',
  "",
].join("\n");

describe("writeback: 注释保留", () => {
  test("替换已有标量：整行注释保留，其余行字节不变", () => {
    const plan = planConfigWriteback(SAMPLE, [{ path: ["read", "max_file_size_kb"], value: 256 }]);
    expect(plan.changed).toBe(true);
    const nextLines = plan.nextText.split("\n");
    expect(nextLines).toContain("max_file_size_kb = 256  # 原始上限注释");
    // 未触及的行字节级保留
    expect(plan.nextText).toContain("# 由 /config 面板维护");
    expect(plan.nextText).toContain("# 单文件读取上限");
    expect(plan.nextText).toContain('api_key_env = "OPENAI_API_KEY"  # 间接引用，不落明文');
    expect(plan.nextText).toContain("[providers.entries.openai]");
    // 语义校验
    const parsed = tomlParse(plan.nextText) as { read: { max_file_size_kb: number } };
    expect(parsed.read.max_file_size_kb).toBe(256);
  });

  test("跨行数组整体替换为单行值，数组外注释保留", () => {
    const plan = planConfigWriteback(SAMPLE, [
      { path: ["read", "ignore"], value: ["vendor/**", "target/**"] },
    ]);
    const parsed = tomlParse(plan.nextText) as { read: { ignore: string[] } };
    expect(parsed.read.ignore).toEqual(["vendor/**", "target/**"]);
    expect(plan.nextText).toContain("# 单文件读取上限");
    expect(plan.nextText).toContain('api_key_env = "OPENAI_API_KEY"  # 间接引用，不落明文');
    expect(plan.nextText).not.toContain("# 构建产物"); // 旧数组内部注释随 span 替换消失
  });

  test("向已有表插入新键：插在块内最后一个键之后", () => {
    const plan = planConfigWriteback(SAMPLE, [{ path: ["read", "max_output_chars"], value: 1000 }]);
    const lines = plan.nextText.split("\n");
    const inserted = lines.findIndex((l) => l.startsWith("max_output_chars"));
    const apiKey = lines.findIndex((l) => l.startsWith("[providers.entries.openai]"));
    expect(inserted).toBeGreaterThan(0);
    expect(inserted).toBeLessThan(apiKey);
    const parsed = tomlParse(plan.nextText) as { read: { max_output_chars: number } };
    expect(parsed.read.max_output_chars).toBe(1000);
  });

  test("新建表 + 键：追加到文档末尾并报告 createdTables", () => {
    const plan = planConfigWriteback(SAMPLE, [{ path: ["providers", "default"], value: "openai" }]);
    expect(plan.createdTables).toContainEqual(["providers"]);
    const parsed = tomlParse(plan.nextText) as { providers: { default: string } };
    expect(parsed.providers.default).toBe("openai");
    // 原有内容不受影响
    expect(plan.nextText).toContain('api_key_env = "OPENAI_API_KEY"  # 间接引用，不落明文');
  });

  test("多级新表一次性声明（[a.b.c]）", () => {
    const plan = planConfigWriteback("", [{ path: ["mcp", "servers", "fetch", "command"], value: "uvx" }]);
    const parsed = tomlParse(plan.nextText) as { mcp: { servers: { fetch: { command: string } } } };
    expect(parsed.mcp.servers.fetch.command).toBe("uvx");
    expect(plan.createdTables).toContainEqual(["mcp", "servers", "fetch"]);
  });

  test("删除键：上方说明注释保留", () => {
    const plan = planConfigWriteback(SAMPLE, [{ path: ["read", "max_file_size_kb"] }]);
    expect(plan.nextText).not.toContain("max_file_size_kb");
    expect(plan.nextText).toContain("# 单文件读取上限");
    const parsed = tomlParse(plan.nextText) as { read: Record<string, unknown> };
    expect("max_file_size_kb" in parsed.read).toBe(false);
  });

  test("字符串值转义往返（引号 / 换行 / #）", () => {
    const tricky = 'he said "hi"\n# not a comment\ttab';
    const plan = planConfigWriteback(SAMPLE, [{ path: ["identity", "extra_instructions"], value: tricky }]);
    const parsed = tomlParse(plan.nextText) as { identity: { extra_instructions: string } };
    expect(parsed.identity.extra_instructions).toBe(tricky);
    expect(plan.nextText).toContain("# 全局运行配置示例");
  });

  test("空操作编辑：changed = false", () => {
    const plan = planConfigWriteback(SAMPLE, [{ path: ["nope", "missing"] }]);
    expect(plan.changed).toBe(false);
    expect(plan.nextText).toBe(SAMPLE);
  });

  test("根级点分键寻址（无表头前缀的 a.b = v）", () => {
    const src = 'workspace.additional_dir = "../a"\n';
    const plan = planConfigWriteback(src, [{ path: ["workspace", "additional_dir"], value: "../b" }]);
    expect(plan.nextText).toBe('workspace.additional_dir = "../b"\n');
  });
});

describe("writeback: 整表同步（planTableSync）", () => {
  test("更新 / 追加 / 删除键级 diff，注释保留", () => {
    const plan = planTableSync(SAMPLE, ["providers", "entries", "openai"], {
      api_key_env: "OPENAI_API_KEY_NEW",
      base_url: "https://api.openai.com/v1",
      kind: "openai",
    });
    expect(plan.changed).toBe(true);
    const parsed = tomlParse(plan.nextText) as {
      providers: { entries: { openai: Record<string, unknown> } };
    };
    const entry = parsed.providers.entries["openai"];
    expect(entry["api_key_env"]).toBe("OPENAI_API_KEY_NEW");
    expect(entry["base_url"]).toBe("https://api.openai.com/v1");
    expect(entry["kind"]).toBe("openai");
    // 更新的行保留行尾注释
    expect(plan.nextText).toContain('api_key_env = "OPENAI_API_KEY_NEW"  # 间接引用，不落明文');
  });

  test("从表中移除未在新对象里的键", () => {
    const src = [
      "[read]",
      "# 上限说明",
      "max_file_size_kb = 64  # 旧值",
      "extra_key = 1",
      "",
    ].join("\n");
    const plan = planTableSync(src, ["read"], { max_file_size_kb: 128 });
    const parsed = tomlParse(plan.nextText) as { read: Record<string, unknown> };
    expect(parsed.read["max_file_size_kb"]).toBe(128);
    expect("extra_key" in parsed.read).toBe(false);
    expect(plan.nextText).toContain("# 上限说明");
    expect(plan.nextText).toContain("max_file_size_kb = 128  # 旧值");
  });
});

describe("writeback: 解析守卫", () => {
  test("会产生冲突的计划（内联表再展开）直接报错拒绝", () => {
    const src = "[a]\nb = { c = 1 }\n";
    expect(() => planConfigWriteback(src, [{ path: ["a", "b", "d"], value: 2 }])).toThrow(ConfigError);
  });

  test("非法编辑路径报错", () => {
    expect(() => planConfigWriteback(SAMPLE, [{ path: [], value: 1 }])).toThrow(ConfigError);
  });
});

describe("writeback: 原子落盘（writebackConfigFile）", () => {
  test("文件不存在：创建目录与文件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bi-wb-"));
    try {
      const filePath = join(dir, "nested", ".bi", "config.toml");
      const plan = await writebackConfigFile(filePath, [
        { path: ["read", "max_file_size_kb"], value: 64 },
      ]);
      expect(plan.changed).toBe(true);
      const written = await readFile(filePath, "utf8");
      expect(written).toBe(plan.nextText);
      const parsed = tomlParse(written) as { read: { max_file_size_kb: number } };
      expect(parsed.read.max_file_size_kb).toBe(64);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("已有文件：只改目标行，注释字节保留", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bi-wb2-"));
    try {
      const filePath = join(dir, "config.toml");
      await writebackConfigFile(filePath, [
        { path: ["read", "max_file_size_kb"], value: 128 },
        { path: ["identity", "name"], value: "bi" },
      ]);
      const plan = await writebackConfigFile(filePath, [
        { path: ["read", "max_file_size_kb"], value: 256 },
      ]);
      const written = await readFile(filePath, "utf8");
      expect(written).toBe(plan.nextText);
      expect(written).toContain('name = "bi"');
      expect(written).toContain("max_file_size_kb = 256");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("无变化的计划不落盘（changed=false）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bi-wb3-"));
    try {
      const filePath = join(dir, "config.toml");
      await writebackConfigFile(filePath, [{ path: ["read", "max_file_size_kb"], value: 64 }]);
      const before = await readFile(filePath, "utf8");
      const plan = await writebackConfigFile(filePath, [{ path: ["nothing", "here"] }]);
      expect(plan.changed).toBe(false);
      expect(await readFile(filePath, "utf8")).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("writeback: 编辑计划可审阅", () => {
  test("plan 返回原始文本与编辑清单", () => {
    const edits: WritebackEdit[] = [{ path: ["read", "max_file_size_kb"], value: 256 }];
    const plan = planConfigWriteback(SAMPLE, edits);
    expect(plan.originalText).toBe(SAMPLE);
    expect(plan.edits).toEqual(edits);
  });
});
