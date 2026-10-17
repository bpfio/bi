/**
 * BI-16.2 · tool-compiler 测试(纯内存,零 IO)。
 *
 * 覆盖:TS/Python 双形态输出、六类类型映射(string/number/boolean/array/
 * object/enum)、required 可选标记、标识符净化与 @originalName、净化碰撞
 * 去重、零参/Record 兜底、JSDoc 块注释终止序列中和、maxDepth 回退、确定性快照。
 */
import { describe, expect, test } from "bun:test";
import {
  compilePyiToolSurface,
  compileToolDeclarations,
  compileTsToolSurface,
  sanitizeIdent,
  type ToolManifest,
} from "./tool-compiler";

const WEATHER: ToolManifest = {
  name: "get_weather",
  description: "Query current weather by city.",
  inputSchema: {
    type: "object",
    properties: {
      city: { type: "string" },
      unit: { type: "string", enum: ["C", "F"] },
      days: { type: "integer" },
      detail: {
        type: "object",
        properties: { lang: { type: "string" }, strict: { type: "boolean" } },
      },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["city"],
  },
};

describe("BI-16.2 sanitizeIdent 标识符净化", () => {
  test("非法字符替换为下划线,数字开头补前缀", () => {
    expect(sanitizeIdent("get-weather", "ts")).toBe("get_weather");
    expect(sanitizeIdent("a.b/c", "ts")).toBe("a_b_c");
    expect(sanitizeIdent("9lives", "ts")).toBe("_9lives");
  });

  test("Python 侧 $ 非法、硬关键字补 `_` 后缀;TS 侧关键字与 $ 合法", () => {
    expect(sanitizeIdent("import", "python")).toBe("import_");
    expect(sanitizeIdent("class", "python")).toBe("class_");
    expect(sanitizeIdent("import", "ts")).toBe("import");
    expect(sanitizeIdent("a$b", "python")).toBe("a_b");
    expect(sanitizeIdent("a$b", "ts")).toBe("a$b");
  });
});

describe("BI-16.2 TS 声明面编译", () => {
  test("单工具:头部、declare const tools、Promise<ToolResult> 完整快照", () => {
    expect(compileTsToolSurface([WEATHER])).toBe(
      [
        "// PTC tool surface (compiled by BI-16.2 tool-compiler)",
        "declare const tools: {",
        "  /**",
        "   * Query current weather by city.",
        "   */",
        '  get_weather(args: { city: string; unit?: "C" | "F"; days?: number; detail?: { lang?: string; strict?: boolean }; tags?: Array<string> }): Promise<ToolResult>;',
        "};",
      ].join("\n"),
    );
  });

  test("基础类型映射:string / number / integer→number / boolean / unknown 兜底", () => {
    const out = compileTsToolSurface([
      {
        name: "t",
        inputSchema: {
          type: "object",
          properties: {
            a: { type: "string" },
            b: { type: "number" },
            c: { type: "integer" },
            d: { type: "boolean" },
            e: { type: "null" },
            f: { type: "string", enum: ["x"] },
            g: {},
          },
          required: ["a", "b", "c", "d", "e", "f", "g"],
        },
      },
    ]);
    expect(out).toContain(
      "t(args: { a: string; b: number; c: number; d: boolean; e: null; f: \"x\"; g: unknown })",
    );
  });

  test("required 之外属性带 `?` 可选标记", () => {
    const out = compileTsToolSurface([
      {
        name: "t",
        inputSchema: {
          type: "object",
          properties: { need: { type: "string" }, opt: { type: "number" } },
          required: ["need"],
        },
      },
    ]);
    expect(out).toContain("t(args: { need: string; opt?: number })");
  });

  test("enum 字面量联合:字符串带引号、数字/布尔/null 原样", () => {
    const out = compileTsToolSurface([
      {
        name: "t",
        inputSchema: {
          type: "object",
          properties: {
            s: { enum: ["a", "b"] },
            n: { enum: [1, 2] },
            b: { enum: [true, false] },
            z: { enum: [null] },
          },
          required: ["s", "n", "b", "z"],
        },
      },
    ]);
    expect(out).toContain(
      't(args: { s: "a" | "b"; n: 1 | 2; b: true | false; z: null })',
    );
  });

  test("array 映射:有 items / 无 items / 元组 items", () => {
    const out = compileTsToolSurface([
      {
        name: "t",
        inputSchema: {
          type: "object",
          properties: {
            xs: { type: "array", items: { type: "string" } },
            ys: { type: "array" },
            zs: { type: "array", items: [{ type: "string" }, { type: "number" }] },
          },
          required: ["xs", "ys", "zs"],
        },
      },
    ]);
    expect(out).toContain(
      "t(args: { xs: Array<string>; ys: Array<unknown>; zs: [string, number] })",
    );
  });

  test("type 联合数组映射为 TS 联合类型", () => {
    const out = compileTsToolSurface([
      {
        name: "t",
        inputSchema: {
          type: "object",
          properties: { v: { type: ["string", "null"] } },
          required: ["v"],
        },
      },
    ]);
    expect(out).toContain("t(args: { v: string | null })");
  });

  test("无 inputSchema 零参;有 schema 无 properties 用 Record 兜底", () => {
    const out = compileTsToolSurface([
      { name: "ping" },
      { name: "raw", inputSchema: { type: "object" } },
      { name: "empty", inputSchema: { type: "object", properties: {} } },
    ]);
    expect(out).toContain("ping(): Promise<ToolResult>;");
    expect(out).toContain("raw(args: Record<string, unknown>): Promise<ToolResult>;");
    expect(out).toContain("empty(args: Record<string, unknown>): Promise<ToolResult>;");
  });

  test("description 渲染进 JSDoc,`*/` 序列被中和不破坏注释", () => {
    const out = compileTsToolSurface([
      { name: "t", description: "a */ b\nc */ d" },
    ]);
    expect(out).toContain("   * a *\\/ b");
    expect(out).toContain("   * c *\\/ d");
    expect(out.indexOf("*/", out.indexOf("a *\\/ b"))).toBeGreaterThan(0);
  });

  test("净化重命名:连字符工具名保留 @originalName 注记", () => {
    const out = compileTsToolSurface([{ name: "get-weather", description: "d" }]);
    expect(out).toContain("get_weather(");
    expect(out).toContain(" * @originalName get-weather");
  });

  test("净化碰撞去重:同名净化结果追加 _2 后缀且两个工具都在", () => {
    const out = compileTsToolSurface([
      { name: "a-b" },
      { name: "a_b" },
    ]);
    expect(out).toContain("a_b(");
    expect(out).toContain("a_b_2(");
    expect(out).toContain("@originalName a-b");
    expect(out).toContain("@originalName a_b");
  });

  test("maxDepth 回退:超出深度的嵌套 object 折叠为 Record<string, unknown>", () => {
    const out = compileTsToolSurface(
      [
        {
          name: "t",
          inputSchema: {
            type: "object",
            properties: {
              a: {
                type: "object",
                properties: { b: { type: "object", properties: { c: { type: "string" } } } },
              },
            },
            required: ["a"],
          },
        },
      ],
      { maxDepth: 1 },
    );
    expect(out).toContain("t(args: { a: { b?: Record<string, unknown> } })");
  });

  test("resultType 可配置并包裹为 Promise<T>", () => {
    const out = compileTsToolSurface([{ name: "t" }], { resultType: "CallResult" });
    expect(out).toContain("t(): Promise<CallResult>;");
  });
});

describe("BI-16.2 Python .pyi 片段编译", () => {
  test("完整快照:导入头、async def、required 前置、Optional 缺省", () => {
    expect(compilePyiToolSurface([WEATHER], { indent: "    " })).toBe(
      [
        "# PTC tool surface (compiled by BI-16.2 tool-compiler)",
        "from typing import Any, Literal, Optional",
        "",
        "class Tools:",
        '    """Programmatic tool calling surface (compiled by BI-16.2 tool-compiler)."""',
        "",
        "    async def get_weather(self, city: str, unit: Optional[Literal[\"C\", \"F\"]] = ..., days: Optional[int] = ..., detail: Optional[dict[str, Any]] = ..., tags: Optional[list[str]] = ...) -> ToolResult:",
        '        """Query current weather by city."""',
        "        ...",
      ].join("\n"),
    );
  });

  test("类型映射:str/int/float/bool/list/dict/Literal", () => {
    const out = compilePyiToolSurface([
      {
        name: "t",
        inputSchema: {
          type: "object",
          properties: {
            a: { type: "string" },
            b: { type: "integer" },
            c: { type: "number" },
            d: { type: "boolean" },
            e: { type: "array", items: { type: "number" } },
            f: { type: "object", properties: { x: { type: "string" } } },
            g: { enum: ["a", "b"] },
            h: { enum: [true, false] },
            i: { enum: [null] },
          },
          required: ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
        },
      },
    ]);
    expect(out).toContain(
      "async def t(self, a: str, b: int, c: float, d: bool, e: list[float], f: dict[str, Any], g: Literal[\"a\", \"b\"], h: Literal[True, False], i: Literal[None]) -> ToolResult:",
    );
  });

  test("optional 参数排到 required 之后并带 `= ...` 缺省(schema 乱序也会重排)", () => {
    const out = compilePyiToolSurface([
      {
        name: "t",
        inputSchema: {
          type: "object",
          properties: {
            opt: { type: "string" },
            need: { type: "string" },
          },
          required: ["need"],
        },
      },
    ]);
    expect(out).toContain(
      "async def t(self, need: str, opt: Optional[str] = ...) -> ToolResult:",
    );
  });

  test("无 inputSchema 零参;无 properties 用 payload: dict[str, Any] 兜底", () => {
    const out = compilePyiToolSurface([
      { name: "ping" },
      { name: "raw", inputSchema: { type: "object" } },
    ]);
    expect(out).toContain("async def ping(self) -> ToolResult:");
    expect(out).toContain("async def raw(self, payload: dict[str, Any]) -> ToolResult:");
  });

  test("Python 关键字工具名补 `_`,并以注释保留原名;Docstring 中和 `\"\"\"`", () => {
    const out = compilePyiToolSurface([
      { name: "import", description: 'say """ hi' },
    ]);
    expect(out).toContain("# original name: import");
    expect(out).toContain("async def import_(self) -> ToolResult:");
    expect(out).toContain('"""say \\"\\"\\" hi"""');
  });
});

describe("BI-16.2 编译器通用约定", () => {
  test("空清单:TS 输出空对象字面量,Python 输出仅带 Docstring 的类", () => {
    const ts = compileToolDeclarations([], { language: "ts" });
    expect(ts).toBe(
      [
        "// PTC tool surface (compiled by BI-16.2 tool-compiler)",
        "declare const tools: {",
        "};",
      ].join("\n"),
    );
    const py = compileToolDeclarations([], { language: "python" });
    expect(py).toContain("class Tools:");
    expect(py).toContain('"""Programmatic tool calling surface');
    expect(py).not.toContain("async def");
  });

  test("多工具快照:两工具声明面逐字节确定(两次编译完全一致)", () => {
    const manifests: readonly ToolManifest[] = [
      WEATHER,
      { name: "db.query", description: "Run read-only SQL.", inputSchema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] } },
    ];
    const a = compileTsToolSurface(manifests);
    const b = compileTsToolSurface(manifests);
    expect(a).toBe(b);
    expect(a).toContain("get_weather(args: { city: string;");
    expect(a).toContain("db_query(args: { sql: string }): Promise<ToolResult>;");
    expect(a).toContain(" * @originalName db.query");
  });
});
