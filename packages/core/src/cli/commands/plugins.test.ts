/**
 * X4 波次二 —— `bi plugins [list|validate]` 子命令验收。
 *
 * 临时目录造假插件（一好一坏，纯声明式，零代码执行）：
 * - good：.claude-plugin/plugin.json（claude 协议）+ 1 skill + 1 mcpServer 声明；
 * - bad：plugin.json 合法 JSON 但缺 name（loadPlugin 拒绝 → 警告；validate 报告 ok:false）。
 * 断言 list 行 JSON 面 / validate 报告面 / 退出码语义 / 警告不阻塞。
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handlePlugins } from "./plugins";
import type { SubcommandIo } from "./dispatch";

async function makeRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "bi-plugins-cmd-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function captureIo(): { io: SubcommandIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

interface ListLine {
  name: string;
  version: string;
  protocol: string;
  skills: number;
  mcpservers: number;
  dir: string;
}

interface ValidateLine {
  name: string | null;
  dir: string;
  ok: boolean;
  problems: string[];
}

async function seedPlugins(root: string): Promise<void> {
  const pluginsDir = join(root, ".bi", "plugins");
  // good：claude 协议 + 1 skill + 1 mcpServer
  const good = join(pluginsDir, "good", ".claude-plugin");
  await mkdir(good, { recursive: true });
  await mkdir(join(pluginsDir, "good", "skills", "greet"), { recursive: true });
  await writeFile(
    join(good, "plugin.json"),
    JSON.stringify({
      name: "good",
      version: "1.0.0",
      mcpServers: { local: { command: "echo" } },
    }),
    "utf8",
  );
  await writeFile(
    join(pluginsDir, "good", "skills", "greet", "SKILL.md"),
    "---\nname: greet\ndescription: 问候\n---\n正文。\n",
    "utf8",
  );
  // bad：合法 JSON 但缺 name
  const bad = join(pluginsDir, "bad", ".claude-plugin");
  await mkdir(bad, { recursive: true });
  await writeFile(join(bad, "plugin.json"), JSON.stringify({ version: "0.1.0" }), "utf8");
}

describe("X4 · bi plugins", () => {
  test("list：好插件一行 JSON 面 + 坏插件结构化警告不阻塞 + 尾注", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      await seedPlugins(root);
      const { io, out, err } = captureIo();
      const code = await handlePlugins(["list"], io, { homeDir: root, cwd: root });
      expect(code).toBe(0);
      const lines = out.map((l) => JSON.parse(l) as ListLine);
      expect(lines).toHaveLength(1);
      const good = lines[0]!;
      expect(good.name).toBe("good");
      expect(good.version).toBe("1.0.0");
      expect(good.protocol).toBe("claude");
      expect(good.skills).toBe(1);
      expect(good.mcpservers).toBe(1);
      expect(good.dir.endsWith(join(".bi", "plugins", "good"))).toBe(true);
      expect(err.some((l) => l.includes("bad") && l.includes("name-missing"))).toBe(true);
      expect(err.some((l) => l.includes("install/marketplace"))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("validate：好插件 ok:true；坏插件 ok:false → exit 1", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      await seedPlugins(root);
      const { io, out } = captureIo();
      const code = await handlePlugins(["validate"], io, { homeDir: root, cwd: root });
      expect(code).toBe(1);
      const lines = out.map((l) => JSON.parse(l) as ValidateLine);
      const good = lines.find((l) => l.name === "good");
      expect(good?.ok).toBe(true);
      expect(good?.problems).toEqual([]);
      const bad = lines.find((l) => l.name === null);
      expect(bad?.ok).toBe(false);
      expect(bad?.problems.join(" ")).toContain("name");
    } finally {
      await cleanup();
    }
  });

  test("--dir 覆盖扫描根；未知动作 exit 2", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const only = join(root, "only-plugins");
      await mkdir(join(only, "solo", ".claude-plugin"), { recursive: true });
      await writeFile(
        join(only, "solo", ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "solo" }),
        "utf8",
      );
      const { io, out } = captureIo();
      const code = await handlePlugins(["list", "--dir", only], io, { homeDir: root, cwd: root });
      expect(code).toBe(0);
      const lines = out.map((l) => JSON.parse(l) as ListLine);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.name).toBe("solo");
      expect(lines[0]!.protocol).toBe("claude");

      const { io: io2 } = captureIo();
      const badAction = await handlePlugins(["install"], io2, { homeDir: root, cwd: root });
      expect(badAction).toBe(2);
    } finally {
      await cleanup();
    }
  });
});
