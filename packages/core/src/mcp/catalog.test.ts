import { describe, expect, test } from "bun:test";
import { buildCatalog, expandNamespace, estTokens, flattenBudget } from "./tool-catalog";
import { summarizeTool, summarizeToolLine } from "./catalog-summarizer";

const SRC_A = {
  name: "logbook",
  tools: [
    { name: "task_query", description: "查询任务看板", inputSchema: { type: "object", properties: { project: { type: "string" }, limit: { type: "integer" } }, required: ["project"] } },
    { name: "devlog_record", description: "录入排查手记", inputSchema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title"] } },
  ],
};
const SRC_B = {
  name: "web",
  tools: [
    { name: "fetch", description: "抓取网页", inputSchema: { type: "object", properties: { url: { type: "string" }, mode: { enum: ["a", "b"] } }, required: ["url"] } },
    { name: "search", description: "搜索" },
  ],
};
const EMPTY_C = { name: "empty", tools: [] };

describe("buildCatalog", () => {
  test("多源树状规约", () => {
    const root = buildCatalog([SRC_A, SRC_B, EMPTY_C]);
    expect(root.namespaces.length).toBe(3);
    expect(root.totalTools).toBe(4);
    expect(root.namespaces[0].toolCount).toBe(2);
    expect(root.namespaces[0].hasSchema).toBe(true);
    expect(root.namespaces[1].tools[1].inputSchema).toBeUndefined();
    expect(root.namespaces[2].toolCount).toBe(0);
  });
  test("空源列表", () => {
    const root = buildCatalog([]);
    expect(root.totalTools).toBe(0);
    expect(root.namespaces).toEqual([]);
  });
  test("深拷贝隔离：改源不影响 catalog", () => {
    const src = { name: "x", tools: [{ name: "t" }] };
    const root = buildCatalog([src]);
    src.tools[0]!.name = "mutated";
    expect(root.namespaces[0]!.tools[0]!.name).toBe("t");
  });
});

describe("flattenBudget 渐进式展现", () => {
  test("预算充足：全部细粒度，无摘要行", () => {
    const root = buildCatalog([SRC_A, SRC_B]);
    const lines = flattenBudget(root, 10_000);
    expect(lines.length).toBe(4);
    expect(lines.some((l) => l.includes(": 2 tools"))).toBe(false);
  });
  test("预算耗尽：保持摘要行", () => {
    const root = buildCatalog([SRC_A, SRC_B]);
    const lines = flattenBudget(root, 1);
    expect(lines.length).toBe(0);
  });
  test("中间预算：部分展开+剩余摘要行", () => {
    const root = buildCatalog([SRC_A, SRC_B]);
    const full = flattenBudget(root, 10_000);
    const fullCost = full.reduce((a, l) => a + estTokens(l), 0);
    const lines = flattenBudget(root, Math.floor(fullCost / 2));
    expect(lines.some((l) => l.startsWith("- logbook:"))).toBe(true);
    expect(lines.length).toBeLessThan(full.length);
  });
  test("一行放不下整行跳过", () => {
    const longDesc = { name: "big", description: "x".repeat(600) };
    const root = buildCatalog([{ name: "ns", tools: [{ name: "small", description: "s" }, longDesc] }]);
    const summaryCost = estTokens("- ns: 2 tools");
    const smallLine = summarizeToolLine("ns", root.namespaces[0]!.tools[0]!);
    const lines = flattenBudget(root, summaryCost + estTokens(smallLine) + 1);
    expect(lines).toContain("- ns: 2 tools");
    expect(lines).toContain(smallLine);
    expect(lines.some((l) => l.includes("big"))).toBe(false);
  });
  test("pinned 保顶：超预算也输出并先行占用", () => {
    const root = buildCatalog([SRC_A]);
    const lines = flattenBudget(root, 1, { pinned: ["task_query"] });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("logbook.task_query");
  });
  test("pinned 保顶后剩余预算照常分配", () => {
    const root = buildCatalog([SRC_A]);
    const lines = flattenBudget(root, 10_000, { pinned: ["task_query"] });
    expect(lines[0]).toContain("logbook.task_query");
    expect(lines.some((l) => l.includes("devlog_record"))).toBe(true);
    expect(lines.some((l) => l.includes(": 1 tools"))).toBe(false);
  });
  test("确定性：两次渲染逐字节相等", () => {
    const root = buildCatalog([SRC_A, SRC_B]);
    const a = flattenBudget(root, 500);
    const b = flattenBudget(root, 500);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
  test("1000 工具 <50ms", () => {
    const big = { name: "huge", tools: Array.from({ length: 1000 }, (_, i) => ({ name: `t${i}`, description: "d" })) };
    const root = buildCatalog([big]);
    const t0 = performance.now();
    flattenBudget(root, 2000);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

describe("expandNamespace", () => {
  test("强制细粒度+其余摘要", () => {
    const root = buildCatalog([SRC_A, SRC_B]);
    const lines = expandNamespace(root, "logbook", 1);
    expect(lines.filter((l) => l.startsWith("- logbook.")).length).toBe(2);
    expect(lines).toContain("- web: 2 tools");
  });
  test("未知命名空间抛 RangeError", () => {
    const root = buildCatalog([SRC_A]);
    expect(() => expandNamespace(root, "nope", 100)).toThrow(RangeError);
  });
});

describe("summarizeTool 类型映射", () => {
  test("基础类型+必填可选", () => {
    const sig = summarizeTool({ name: "f", inputSchema: { type: "object", properties: { a: { type: "string" }, b: { type: "number" }, c: { type: "boolean" }, d: { type: "string" } }, required: ["a", "d"] } });
    expect(sig).toBe("f(args: { a: string, b?: number, c?: boolean, d: string }): unknown");
  });
  test("enum 联合", () => {
    const sig = summarizeTool({ name: "g", inputSchema: { type: "object", properties: { mode: { enum: ["fast", "slow"] } }, required: ["mode"] } });
    expect(sig).toContain("mode: 'fast' | 'slow'");
  });
  test("array→items 类型", () => {
    const sig = summarizeTool({ name: "h", inputSchema: { type: "object", properties: { xs: { type: "array", items: { type: "number" } } }, required: ["xs"] } });
    expect(sig).toContain("xs: number[]");
  });
  test("嵌套 object 折叠到 maxDepth", () => {
    const sig = summarizeTool({ name: "i", inputSchema: { type: "object", properties: { deep: { type: "object", properties: { inner: { type: "object", properties: { x: { type: "object", properties: { y: { type: "string" } } } } } } } }, required: ["deep"] } });
    expect(sig).toContain("deep: { inner?: { x?: object } }");
  });
  test("anyOf/oneOf/无类型→any", () => {
    expect(summarizeTool({ name: "j", inputSchema: { type: "object", properties: { a: { anyOf: [{ type: "string" }] } }, required: ["a"] } })).toContain("a: any");
    expect(summarizeTool({ name: "k", inputSchema: { type: "object", properties: { a: {} }, required: ["a"] } })).toContain("a: any");
  });
  test("空 schema→缺省 args 形态", () => {
    expect(summarizeTool({ name: "l" })).toBe("l(args?: Record<string, never>): unknown");
  });
  test("description 截 120 字符+省略号", () => {
    const sig = summarizeTool({ name: "m", description: "x".repeat(200) });
    expect(sig.endsWith("…" + "x".repeat(0)) || sig.includes("…")).toBe(true);
    expect(sig.length).toBeLessThan(200);
  });
  test("行形态含命名空间前缀", () => {
    const line = summarizeToolLine("ns", { name: "t", inputSchema: { type: "object", properties: {}, required: [] } });
    expect(line.startsWith("- ns.t(")).toBe(true);
  });
  test("token 估算 chars/4 向上取整", () => {
    expect(estTokens("")).toBe(0);
    expect(estTokens("abcd")).toBe(1);
    expect(estTokens("abcde")).toBe(2);
  });
});
