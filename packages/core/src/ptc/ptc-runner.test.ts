/**
 * BI-16.2 · ptc-runner 测试(注入式伪工具执行器,纯内存)。
 *
 * 覆盖:静态扫描拒绝清单(import/require/process/eval/Function/globalThis/
 * __proto__/constructor/Bun/setInterval)、注释剥离、字符串 fail-closed;
 * 单工具调用、循环批量、Promise.all 并发、分支路由、超时熔断、调用上限、
 * 未知工具拒绝、executor 抛错、纯计算零调用、undefined→null、语法错误、
 * 台账完整性。
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DENY_PATTERNS,
  PtcCallLimitError,
  PtcStaticScanError,
  PtcTimeoutError,
  PtcUnknownToolError,
  runPtcScript,
  staticScan,
  stripJsComments,
  type PtcToolExecutor,
} from "./ptc-runner";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

type Handler = (args: unknown) => unknown | Promise<unknown>;

/** 注入式伪执行器:按工具名路由,记录调用并追踪并发在途数。 */
function makeHarness(routes: Record<string, Handler>): {
  executor: PtcToolExecutor;
  invocations: { tool: string; args: unknown }[];
  maxInFlight: () => number;
} {
  const invocations: { tool: string; args: unknown }[] = [];
  let inFlight = 0;
  let peak = 0;
  const executor: PtcToolExecutor = async (name, args) => {
    invocations.push({ tool: name, args });
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      const handler = routes[name];
      if (!handler) throw new Error(`no route: ${name}`);
      return await handler(args);
    } finally {
      inFlight--;
    }
  };
  return { executor, invocations, maxInFlight: () => peak };
}

describe("BI-16.2 静态扫描", () => {
  test("拒绝 import 语句与动态 import()", () => {
    expect(staticScan(`import fs from "node:fs";`).ok).toBe(false);
    expect(staticScan(`const m = await import("node:fs");`).ok).toBe(false);
  });

  test("拒绝 require / process 访问", () => {
    const r1 = staticScan(`const fs = require("node:fs"); return fs;`);
    expect(r1.ok).toBe(false);
    expect(r1.violations.some((v) => v.includes("require"))).toBe(true);
    const r2 = staticScan(`return process.env.PATH;`);
    expect(r2.ok).toBe(false);
    expect(r2.violations.some((v) => v.includes("process"))).toBe(true);
  });

  test("拒绝 eval / new Function / globalThis / __proto__ / constructor", () => {
    expect(staticScan(`return eval("1+1");`).ok).toBe(false);
    expect(staticScan(`const f = new Function("return 1");`).ok).toBe(false);
    expect(staticScan(`return globalThis;`).ok).toBe(false);
    expect(staticScan(`const t = tools; return t["__proto__"];`).ok).toBe(false);
    expect(staticScan(`return "".constructor.constructor("return 1")();`).ok).toBe(false);
  });

  test("拒绝 Bun 全局与 setInterval(默认黑名单补强)", () => {
    expect(staticScan(`await Bun.write("/tmp/x", "y");`).ok).toBe(false);
    expect(staticScan(`setInterval(() => {}, 1000);`).ok).toBe(false);
  });

  test("良性脚本(循环+并发+分支)通过扫描", () => {
    const benign = `
      const batch = [];
      for (let i = 0; i < 3; i++) batch.push(tools.double({ n: i }));
      const [a, b] = await Promise.all(batch);
      const flag = a > b ? "a" : "b";
      return { a, b, flag };
    `;
    const r = staticScan(benign);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  test("注释提及敏感词不误伤(行注释与块注释均剥离)", () => {
    const script = [
      "// process each item below",
      "/* import data here */",
      "const x = 1;",
      "return x;",
    ].join("\n");
    expect(staticScan(script).ok).toBe(true);
  });

  test("字符串字面量中的敏感词仍拒绝(fail-closed)", () => {
    expect(staticScan(`return "process";`).ok).toBe(false);
  });

  test("stripJsComments:块注释替换为空格保留换行,字符串内 // 不剥离", () => {
    const out = stripJsComments("a;/*x\ny*/b\nconst u = \"http://e.com\";");
    expect(out).not.toContain("x");
    expect(out).toContain("\n");
    expect(out).toContain("http://e.com");
  });
});

describe("BI-16.2 runPtcScript 执行", () => {
  test("单工具调用:结果透传、args 深相等、台账与统计完整", async () => {
    const h = makeHarness({ double: (args) => (args as { n: number }).n * 2 });
    const r = await runPtcScript(
      `const r = await tools.double({ n: 21 }); return r;`,
      { executor: h.executor },
    );
    expect(r.ok).toBe(true);
    expect(r.result).toBe(42);
    expect(r.totalCalls).toBe(1);
    expect(r.timedOut).toBe(false);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.calls).toHaveLength(1);
    const c0 = r.calls[0];
    expect(c0?.tool).toBe("double");
    expect(c0?.args).toEqual({ n: 21 });
    expect(c0?.ok).toBe(true);
    expect(c0?.result).toBe(42);
    expect(c0?.seq).toBe(1);
    expect(c0?.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("循环批量:5 次顺序调用,台账 seq 与结果顺序一致", async () => {
    const h = makeHarness({ tick: (args) => (args as { i: number }).i * 10 });
    const r = await runPtcScript(
      `
      const out = [];
      for (let i = 0; i < 5; i++) out.push(await tools.tick({ i }));
      return out;
      `,
      { executor: h.executor },
    );
    expect(r.ok).toBe(true);
    expect(r.result).toEqual([0, 10, 20, 30, 40]);
    expect(r.totalCalls).toBe(5);
    expect(r.calls.map((c) => c.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(r.calls.map((c) => c.args)).toEqual([
      { i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }, { i: 4 },
    ]);
    expect(h.invocations).toHaveLength(5);
  });

  test("Promise.all 并发:伪执行器在途峰值 >= 2,结果按序合并", async () => {
    const h = makeHarness({
      slow: async (args) => {
        await sleep(20);
        return (args as { v: number }).v;
      },
    });
    const r = await runPtcScript(
      `
      const [a, b, c] = await Promise.all([
        tools.slow({ v: 1 }),
        tools.slow({ v: 2 }),
        tools.slow({ v: 3 }),
      ]);
      return a + b + c;
      `,
      { executor: h.executor },
    );
    expect(r.ok).toBe(true);
    expect(r.result).toBe(6);
    expect(r.totalCalls).toBe(3);
    expect(h.maxInFlight()).toBeGreaterThanOrEqual(2);
  });

  test("分支路由:按工具返回值走 if/else,只调用命中一侧", async () => {
    const h = makeHarness({
      coin: () => "heads",
      heads: () => "H",
      tails: () => "T",
    });
    const r = await runPtcScript(
      `
      const face = await tools.coin();
      if (face === "heads") return await tools.heads();
      return await tools.tails();
      `,
      { executor: h.executor },
    );
    expect(r.ok).toBe(true);
    expect(r.result).toBe("H");
    expect(h.invocations.map((c) => c.tool)).toEqual(["coin", "heads"]);
  });

  test("超时熔断:可配超时触发 timedOut,结果失败并保留台账", async () => {
    const h = makeHarness({ ping: () => "pong" });
    const r = await runPtcScript(
      `
      await tools.ping();
      await new Promise(() => {}); // 永不完成
      return "unreachable";
      `,
      { executor: h.executor, timeoutMs: 80 },
    );
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.error).toContain("超时");
    expect(r.totalCalls).toBe(1);
    expect(r.calls).toHaveLength(1);
  });

  test("调用次数上限:超出即拒绝,台账记录被拒尝试且不再派发", async () => {
    const h = makeHarness({ tick: (args) => (args as { i: number }).i });
    const r = await runPtcScript(
      `
      for (let i = 0; i < 5; i++) await tools.tick({ i });
      return "done";
      `,
      { executor: h.executor, maxToolCalls: 3 },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("上限");
    expect(r.totalCalls).toBe(3);
    expect(h.invocations).toHaveLength(3);
    expect(r.calls).toHaveLength(4);
    const rejected = r.calls[3];
    expect(rejected?.ok).toBe(false);
    expect(rejected?.error).toContain("上限");
    expect(rejected?.tool).toBe("tick");
  });

  test("maxToolCalls = 0:本轮禁止任何工具调用", async () => {
    const h = makeHarness({ a: () => 1 });
    const r = await runPtcScript(`return await tools.a();`, {
      executor: h.executor,
      maxToolCalls: 0,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("上限");
    expect(h.invocations).toHaveLength(0);
  });

  test("未知工具拒绝:knownTools 之外不派发,台账记录失败", async () => {
    const h = makeHarness({ a: () => 1 });
    const r = await runPtcScript(`return await tools.mystery({ x: 1 });`, {
      executor: h.executor,
      knownTools: ["a"],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("未知工具");
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.tool).toBe("mystery");
    expect(r.calls[0]?.error).toContain("未知工具");
    expect(h.invocations).toHaveLength(0);
    expect(PtcUnknownToolError).toBeDefined();
  });

  test("工具执行器抛错:整轮失败,错误与失败台账透出", async () => {
    const h = makeHarness({
      boom: () => {
        throw new Error("boom");
      },
    });
    const r = await runPtcScript(`return await tools.boom();`, {
      executor: h.executor,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("boom");
    expect(r.calls[0]?.ok).toBe(false);
    expect(r.calls[0]?.error).toBe("boom");
    expect(r.timedOut).toBe(false);
  });

  test("纯计算零调用:不触碰工具也能返回结果", async () => {
    const h = makeHarness({});
    const r = await runPtcScript(
      `const xs = [1, 2, 3].map((x) => x * x); return xs.reduce((a, b) => a + b, 0);`,
      { executor: h.executor },
    );
    expect(r.ok).toBe(true);
    expect(r.result).toBe(14);
    expect(r.calls).toEqual([]);
    expect(r.totalCalls).toBe(0);
  });

  test("脚本无 return / return undefined:结果归一为 null", async () => {
    const h = makeHarness({});
    const r1 = await runPtcScript(`const a = 1;`, { executor: h.executor });
    expect(r1.ok).toBe(true);
    expect(r1.result).toBeNull();
    const r2 = await runPtcScript(`return undefined;`, { executor: h.executor });
    expect(r2.ok).toBe(true);
    expect(r2.result).toBeNull();
  });

  test("脚本语法错误:返回失败结果而非抛出", async () => {
    const h = makeHarness({});
    const r = await runPtcScript(`const x = ;`, { executor: h.executor });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("语法错误");
  });

  test("静态扫描拒绝的脚本不进入执行:错误类型与空台账", async () => {
    const h = makeHarness({ a: () => 1 });
    const r = await runPtcScript(
      `return process.env.SECRET;`,
      { executor: h.executor },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("静态扫描拒绝");
    expect(r.calls).toEqual([]);
    expect(r.totalCalls).toBe(0);
    expect(h.invocations).toHaveLength(0);
    expect(PtcStaticScanError).toBeDefined();
    expect(PtcCallLimitError).toBeDefined();
    expect(PtcTimeoutError).toBeDefined();
  });

  test("denyPatterns 可覆盖默认黑名单(仅拒绝指定模式)", async () => {
    const h = makeHarness({ a: () => 1 });
    // 默认黑名单下 require 被拒;换成只查 eval 的自定义黑名单后可执行。
    const r = await runPtcScript(`const w = "require"; return await tools.a();`, {
      executor: h.executor,
      denyPatterns: [/\beval\b/],
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe(1);
    expect(DEFAULT_DENY_PATTERNS.length).toBeGreaterThanOrEqual(10);
  });
});
