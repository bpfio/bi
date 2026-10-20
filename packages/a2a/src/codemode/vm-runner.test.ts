import { describe, expect, test } from "bun:test";
import { DEFAULT_VM_MAX_CODE_LENGTH, DEFAULT_VM_TIMEOUT_MS, VmRunError, runInVm } from "./vm-runner";

/** 提取结构化 VmRunError（断言辅助：非 VmRunError 直接翻车）。 */
function catchVmError(fn: () => unknown): VmRunError {
  try {
    fn();
  } catch (err) {
    if (err instanceof VmRunError) return err;
    throw new Error(`expected VmRunError, got ${String(err)}`);
  }
  throw new Error("expected VmRunError, but nothing was thrown");
}

describe("runInVm · 纯计算正确性", () => {
  test("算术表达式：完成值返回", () => {
    expect(runInVm("1 + 2 * 3").result).toBe(7);
  });

  test("字符串运算", () => {
    const r = runInVm(`const parts = ["bi", "codemode"]; parts.join("-").toUpperCase()`);
    expect(r.result).toBe("BI-CODEMODE");
  });

  test("JSON 白名单内建可用", () => {
    expect(runInVm(`JSON.stringify({ a: 1, b: [2, 3] })`).result).toBe('{"a":1,"b":[2,3]}');
    expect(runInVm(`JSON.parse("[1,2]").length`).result).toBe(2);
  });

  test("Math 白名单内建可用", () => {
    expect(runInVm("Math.floor(3.7) + Math.max(1, 9) * Math.PI ** 0").result).toBe(12);
  });

  test("返回值结构与 durationMs", () => {
    const r = runInVm(`let s = 0; for (let i = 0; i < 100000; i++) s += i; s`);
    expect(r.result).toBe(4_999_950_000);
    expect(typeof r.durationMs).toBe("number");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("语句块无完成值：result undefined", () => {
    expect(runInVm(`const x = 1;`).result).toBeUndefined();
  });
});

describe("runInVm · data 变量注入", () => {
  test("标量字段精算", () => {
    const r = runInVm("data.price * data.qty", { data: { price: 10, qty: 3 } });
    expect(r.result).toBe(30);
  });

  test("嵌套结构与数组方法链", () => {
    const r = runInVm(
      `data.items.filter((x) => x.v > 1).reduce((acc, x) => acc + x.v, 0) * data.factor`,
      { data: { items: [{ v: 1 }, { v: 2 }, { v: 3 }], factor: 10 } },
    );
    expect(r.result).toBe(50);
  });

  test("data 按引用共享：沙箱内变更宿主可见（文档化语义）", () => {
    const data = { counter: 0 };
    runInVm("data.counter = data.counter + 5", { data });
    expect(data.counter).toBe(5);
  });

  test("未注入 data 时访问报 runtime 错（ReferenceError）", () => {
    const e = catchVmError(() => runInVm("data.x"));
    expect(e.code).toBe("runtime");
    expect(e.message).toContain("data");
  });
});

describe("runInVm · console 捕获", () => {
  test("多级别按序扁平捕获 + 格式化", () => {
    const r = runInVm(`console.log("line-1");
console.log("v =", 42);
console.info("i");
console.warn({ k: 1 });
console.error("e");
console.debug(true);`);
    expect(r.result).toBeUndefined();
    expect(r.console).toEqual(["line-1", "v = 42", "i", '{"k":1}', "e", "true"]);
  });

  test("maxConsoleEntries 上限：超出截断并打标", () => {
    const r = runInVm(`for (let i = 0; i < 50; i++) console.log(i);`, { maxConsoleEntries: 10 });
    expect(r.console.length).toBe(11);
    expect(r.console[9]).toBe("9");
    expect(r.console[10]).toBe("<console truncated>");
  });
});

describe("runInVm · 超时与异常结构化", () => {
  test("死循环：timeoutMs 硬中断 → VmRunError('timeout')", () => {
    const e = catchVmError(() => runInVm("while (true) {}", { timeoutMs: 50 }));
    expect(e.code).toBe("timeout");
    expect(e.message).toContain("50");
  });

  test("默认超时 100ms 生效", () => {
    expect(DEFAULT_VM_TIMEOUT_MS).toBe(100);
    const started = Date.now();
    const e = catchVmError(() => runInVm("while (true) {}"));
    expect(e.code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("运行期错误：null.f() → VmRunError('runtime')", () => {
    const e = catchVmError(() => runInVm("null.f()"));
    expect(e.code).toBe("runtime");
    expect(e.message).toContain("null");
  });

  test("用户 throw → VmRunError('runtime')，message 保留", () => {
    const e = catchVmError(() => runInVm(`throw new Error("boom-codemode-xyz")`));
    expect(e.code).toBe("runtime");
    expect(e.message).toContain("boom-codemode-xyz");
  });

  test("深递归 RangeError → 'runtime'（深度无原生限额，栈溢出即异常收场）", () => {
    const e = catchVmError(() => runInVm(`function f(n) { return n === 0 ? 0 : 1 + f(n - 1); } f(10000000)`));
    expect(e.code).toBe("runtime");
    expect(e.message).toContain("call stack");
  });

  test("代码超长：>64KB 执行前拒绝 → 'too-long'", () => {
    expect(DEFAULT_VM_MAX_CODE_LENGTH).toBe(65536);
    const e = catchVmError(() => runInVm("1" + " ".repeat(64 * 1024)));
    expect(e.code).toBe("too-long");
    expect(e.message).toContain("65537");
    // 边界：恰好 64KB 通过守卫正常执行
    expect(runInVm(" ".repeat(64 * 1024)).result).toBeUndefined();
  });

  test("超时后沙箱与宿主进程均不受损，可继续运行", () => {
    const e = catchVmError(() => runInVm("while (true) {}", { timeoutMs: 30 }));
    expect(e.code).toBe("timeout");
    expect(runInVm("6 * 7").result).toBe(42);
    expect(typeof process.pid).toBe("number");
  });
});

describe("runInVm · 白名单外 global 受限语义（node:vm 默认，断言记录）", () => {
  test("宿主全局在 guest realm 不可见：process/require/Bun/fetch 全 undefined", () => {
    const r = runInVm(
      `[typeof process, typeof require, typeof Bun, typeof fetch, typeof globalThis.process].join(",")`,
    );
    expect(r.result).toBe("undefined,undefined,undefined,undefined,undefined");
    // 宿主 realm 完全不受沙箱影响
    expect(typeof process).toBe("object");
  });

  test("guest 内声明不泄漏到宿主 globalThis", () => {
    runInVm(`var leakedAttempt = 12345;`);
    expect((globalThis as Record<string, unknown>)["leakedAttempt"]).toBeUndefined();
  });
});

describe("runInVm · TypeScript 类型擦除（BI-16.1 补齐 TS 半边）", () => {
  test("TS 类型注解 + 算术：const x: number = 1 可执行", () => {
    const r = runInVm(`const x: number = 1;
const y: number = 2;
x * y + 10`);
    expect(r.result).toBe(12);
  });

  test("interface 声明被擦除 + 带类型参数的函数精算", () => {
    const r = runInVm(`interface Pt { x: number; y: number }
function len(p: Pt): number {
  return Math.sqrt(p.x * p.x + p.y * p.y);
}
len({ x: 3, y: 4 })`);
    expect(r.result).toBe(5);
    // interface 自身不应作为值泄漏进运行时
    const e = catchVmError(() => runInVm(`interface Pt { x: number } Pt.x = 1; Pt`));
    expect(e.code).toBe("runtime");
  });

  test("泛型函数调用：identity<T> 类型参数被擦除，执行语义不变", () => {
    const r = runInVm(`function identity<T>(v: T): T { return v; }
identity<number>(42) + identity<number>(8)`);
    expect(r.result).toBe(50);
  });

  test("JS 经转译后幂等：原始 JS 用例语义不变（类型擦除零行为变化）", () => {
    expect(runInVm("1 + 2 * 3").result).toBe(7);
    expect(runInVm(`const parts = ["bi", "codemode"]; parts.join("-").toUpperCase()`).result).toBe("BI-CODEMODE");
    expect(runInVm("Math.floor(3.7) + Math.max(1, 9) * Math.PI ** 0").result).toBe(12);
    expect(runInVm(`const x = 1;`).result).toBeUndefined();
  });
});

describe("runInVm · 转译（编译）失败结构化", () => {
  test("非法 TS 语法 → VmRunError('compile')，message 含 Bun 报错要点且非裸抛", () => {
    const e = catchVmError(() => runInVm(`const x: : 1`));
    expect(e.code).toBe("compile");
    expect(e.message).toContain("transpile failed");
    // Bun 原始报错要点随 message 透传，并通过 cause 保留
    expect(e.message.length).toBeGreaterThan("code transpile failed: ".length);
    expect(e.cause).toBeDefined();
  });
});
