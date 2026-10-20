/**
 * BI-16.1 装配验收 —— run_js 注册进 buildDefaultToolset（条件注册门）。
 *
 * 关注面（先例照抄 select_tools / lsp 门控）：
 * - 缺省（不传 codemode）/ codemode:false → 工具名集合不含 run_js（既有工具面零变动）。
 * - codemode:true → run_js 在表（readOnly=true）；definition 面齐备。
 * - execute 走真实沙箱：算术通、非法 code 结构化错。
 */
import { describe, expect, test } from "bun:test";
import { buildDefaultToolset, type SpawnImpl } from "./toolset";
import type { ToolBinding } from "./headless";

const SIGNAL = new AbortController().signal;

function explodingSpawn(): SpawnImpl {
  return () => {
    throw new Error("test-guard: spawn 不应被调用");
  };
}

function byName(tools: readonly ToolBinding[], name: string): ToolBinding {
  const found = tools.find((t) => t.definition.name === name);
  if (found === undefined) throw new Error(`test-setup: 工具 ${name} 未注册`);
  return found;
}

function namesOf(tools: readonly ToolBinding[]): string[] {
  return tools.map((t) => t.definition.name);
}

describe("BI-16.1 · 注册门：仅 codemode:true 才挂 run_js", () => {
  test("缺省 buildDefaultToolset 不含 run_js（既有工具面零变动）", () => {
    expect(namesOf(buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn() }))).not.toContain("run_js");
  });

  test("codemode:false → 仍不含 run_js", () => {
    const names = namesOf(buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn(), codemode: false }));
    expect(names).not.toContain("run_js");
  });

  test("codemode:true → 含 run_js（readOnly=true）；definition 面齐备", () => {
    const tools = buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn(), codemode: true });
    const names = namesOf(tools);
    expect(names).toContain("run_js");

    const tool = byName(tools, "run_js");
    expect(tool.readOnly).toBe(true);
    expect(tool.definition.name).toBe("run_js");
    expect(tool.definition.description).toContain("隔离");
    const schema = tool.definition.inputSchema as {
      properties: Record<string, { type: string }>;
      required: string[];
    };
    expect(schema.properties["code"]?.type).toBe("string");
    expect(schema.properties["timeout_ms"]?.type).toBe("number");
    expect(schema.required).toEqual(["code"]);
  });

  test("codemode:true → execute 走沙箱：算术通、非法 code 结构化错", async () => {
    const tools = buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn(), codemode: true });
    const tool = byName(tools, "run_js");

    const okRaw = await tool.execute({ code: "6 * 7" }, SIGNAL);
    expect(JSON.parse(String(okRaw))).toEqual({ ok: true, value: 42 });

    const errRaw = await tool.execute({ code: "const = ;" }, SIGNAL);
    const err = JSON.parse(String(errRaw)) as { ok: boolean; error: string };
    expect(err.ok).toBe(false);
    expect(err.error.startsWith("compile:")).toBe(true);
  });
});
