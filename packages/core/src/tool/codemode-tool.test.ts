/**
 * BI-16.1 · run_js 工具面验收（直接 execute；零外呼零实弹，纯内存沙箱）。
 *
 * 覆盖：
 * 1. 正常路径：算术 / 字符串完成值；console 捕获（无输出时不含 console 键）。
 * 2. 沙箱边界：fetch / require / process 在 guest 内不可见（禁网络/禁 fs）。
 * 3. 结构化错误：语法错（compile）、运行时抛错（runtime）、死循环超时（timeout）、
 *    参数非法（invalid-args）——一律 {ok:false,error}，不抛裸异常。
 * 4. 超时封顶：timeout_ms 请求值 clamp 到 1000ms（防滥用）。
 */
import { describe, expect, test } from "bun:test";
import {
  CODEMODE_MAX_TIMEOUT_MS,
  CODEMODE_TOOL_NAME,
  clampCodemodeTimeoutMs,
  makeCodemodeTool,
} from "./codemode-tool";

const SIGNAL = new AbortController().signal;

interface OkPayload {
  ok: true;
  value: unknown;
  console?: string[];
}
interface ErrPayload {
  ok: false;
  error: string;
}

/** 跑一次 run_js 并解析结构化返回面。 */
async function run(args: unknown): Promise<OkPayload | ErrPayload> {
  const tool = makeCodemodeTool();
  const raw = await tool.execute(args, SIGNAL);
  return JSON.parse(String(raw)) as OkPayload | ErrPayload;
}

describe("BI-16.1 · run_js 正常路径", () => {
  test("算术表达式：完成值返回", async () => {
    const out = await run({ code: "1 + 2 * 3" });
    expect(out.ok).toBe(true);
    expect((out as OkPayload).value).toBe(7);
  });

  test("字符串运算：完成值返回", async () => {
    const out = await run({ code: `["bi", "codemode"].join("-").toUpperCase()` });
    expect(out.ok).toBe(true);
    expect((out as OkPayload).value).toBe("BI-CODEMODE");
  });

  test("对象/数组完成值：结构化回传", async () => {
    const out = await run({ code: `JSON.stringify({ a: 1, b: [2, 3] })` });
    expect((out as OkPayload).value).toBe('{"a":1,"b":[2,3]}');
    const arr = await run({ code: `[1, 2, 3].map((x) => x * 2)` });
    expect((arr as OkPayload).value).toEqual([2, 4, 6]);
  });

  test("console 输出被捕获；无输出时不含 console 键", async () => {
    const withLog = await run({ code: `console.log("hi", 1); 1 + 2` });
    expect((withLog as OkPayload).value).toBe(3);
    expect((withLog as OkPayload).console).toEqual(["hi 1"]);

    const noLog = await run({ code: `1 + 2` });
    expect(noLog.ok).toBe(true);
    expect((noLog as OkPayload).console).toBeUndefined();
  });
});

describe("BI-16.1 · run_js 沙箱边界（禁网络/禁 fs/禁宿主全局）", () => {
  test("fetch / require / process 在 guest 内不可见", async () => {
    expect((await run({ code: `String(typeof fetch)` })) as OkPayload).toMatchObject({ value: "undefined" });
    expect((await run({ code: `String(typeof require)` })) as OkPayload).toMatchObject({ value: "undefined" });
    expect((await run({ code: `String(typeof process)` })) as OkPayload).toMatchObject({ value: "undefined" });
  });
});

describe("BI-16.1 · run_js 结构化错误", () => {
  test("语法错 → compile 结构化错（不抛裸异常）", async () => {
    const out = await run({ code: `const = ;` });
    expect(out.ok).toBe(false);
    expect((out as ErrPayload).error.startsWith("compile:")).toBe(true);
  });

  test("运行时异常 → runtime 结构化错", async () => {
    const out = await run({ code: `throw new Error("boom")` });
    expect(out.ok).toBe(false);
    expect((out as ErrPayload).error.startsWith("runtime:")).toBe(true);
    expect((out as ErrPayload).error).toContain("boom");
  });

  test("死循环 → timeout 结构化错", async () => {
    const out = await run({ code: `while (true) {}`, timeout_ms: 50 });
    expect(out.ok).toBe(false);
    expect((out as ErrPayload).error.startsWith("timeout:")).toBe(true);
  });

  test("参数非法 → invalid-args 结构化错（code 缺参 / timeout_ms 非法）", async () => {
    expect(((await run({})) as ErrPayload).error.startsWith("invalid-args:")).toBe(true);
    expect(((await run({ code: "  " })) as ErrPayload).error.startsWith("invalid-args:")).toBe(true);
    expect(((await run({ code: "1", timeout_ms: 0 })) as ErrPayload).error.startsWith("invalid-args:")).toBe(true);
    expect(((await run({ code: "1", timeout_ms: "x" })) as ErrPayload).error.startsWith("invalid-args:")).toBe(true);
  });

  test("已中止信号 → aborted 结构化错（不起跑沙箱）", async () => {
    const tool = makeCodemodeTool();
    const raw = await tool.execute({ code: "1" }, AbortSignal.abort());
    const out = JSON.parse(String(raw)) as ErrPayload;
    expect(out.ok).toBe(false);
    expect(out.error.startsWith("aborted:")).toBe(true);
  });
});

describe("BI-16.1 · run_js 超时封顶（防滥用）", () => {
  test("clamp：缺省 → 100ms；超限 → 1000ms；小额原样", () => {
    expect(clampCodemodeTimeoutMs(undefined)).toBe(100);
    expect(clampCodemodeTimeoutMs(50)).toBe(50);
    expect(clampCodemodeTimeoutMs(99_999)).toBe(CODEMODE_MAX_TIMEOUT_MS);
    expect(CODEMODE_MAX_TIMEOUT_MS).toBe(1000);
  });

  test("工具面：timeout_ms 请求超限被夹到 1000ms（死循环仍按封顶超时）", async () => {
    const out = await run({ code: `while (true) {}`, timeout_ms: 999_999 });
    expect(out.ok).toBe(false);
    expect((out as ErrPayload).error.startsWith("timeout:")).toBe(true);
    expect((out as ErrPayload).error).toContain("1000ms");
  });
});

describe("BI-16.1 · run_js 定义面", () => {
  test("name / description / inputSchema 齐备（code 必填、timeout_ms 可选）", () => {
    const tool = makeCodemodeTool();
    expect(tool.definition.name).toBe(CODEMODE_TOOL_NAME);
    expect(tool.definition.description).toContain("隔离");
    const schema = tool.definition.inputSchema as {
      properties: Record<string, { type: string }>;
      required: string[];
    };
    expect(schema.properties["code"]?.type).toBe("string");
    expect(schema.properties["timeout_ms"]?.type).toBe("number");
    expect(schema.required).toEqual(["code"]);
  });
});
