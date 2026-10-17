/**
 * BI-16.1 · JS/TS 零依赖内存精算沙箱 CodeMode —— node:vm 纯计算运行器。
 *
 * **接缝③（卡间分工，硬边界）**：本卡 = node:vm 纯计算沙箱，**零工具注入**。
 * 沙箱上下文白名单只有：捕获版 console、JSON、Math（后两者为 guest realm 自带
 * 内建对象，无需也不应从宿主 realm 注入）、注入的 `data` 变量。
 * **任何工具绑定（tool bindings / function-calling 桥接）的生成与注入一律归
 * BI-16.2（core/ptc，将来卡）**，本模块不留工具钩子。
 *
 * 白名单语义（node:vm 默认即如此，测试断言记录）：
 * - 全新 guest realm：`process` / `require` / `Bun` / `fetch` 等宿主全局一律不可见；
 * - 超时兜底：vm.Script 的 timeout 选项中断死循环；
 * - 内存/调用深度无原生硬限（V8 未对 context 暴露内存配额），用超时 + 代码长度
 *   上限 64KB 兜底——这是已知局限：超长循环内的内存增长在超时前无法被拦截。
 *
 * 安全性声明（文档级，必读）：node:vm 不是安全边界。guest 代码与宿主共享同一
 * 进程，`data` 按引用传入宿主 realm 对象时会暴露宿主原型链（经典的
 * `constructor.constructor` 逃逸面仍在）。本沙箱面向**可信代码的精算隔离**
 * （防误伤、防死循环、防全局污染），不面向防恶意。
 *
 * @module
 */

import vm from "node:vm";

/** VmRunError 分类：timeout=脚本超时被中断；runtime=执行期异常；too-long=超出代码长度上限。 */
export type VmErrorCode = "timeout" | "runtime" | "too-long";

/** 沙箱执行异常（结构化，不裸抛宿主原始错误）。 */
export class VmRunError extends Error {
  readonly code: VmErrorCode;

  constructor(code: VmErrorCode, message: string, opts?: { cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "VmRunError";
    this.code = code;
  }
}

export interface VmRunOptions {
  /** 脚本执行超时毫秒数。默认 100（精算小任务量级，防止死循环拖垮事件循环）。 */
  timeoutMs?: number;
  /** 代码长度上限（字符数），超出直接拒跑。默认 64KB（65536）。 */
  maxCodeLength?: number;
  /** 注入沙箱的 `data` 变量（按引用共享，见模块头安全性声明）。 */
  data?: Record<string, unknown>;
  /** 堆栈与脚本标识用的文件名。默认 "codemode-sandbox.js"。 */
  filename?: string;
  /** console 捕获条数上限，超出丢弃并追加一条截断标记。默认 10_000。 */
  maxConsoleEntries?: number;
}

export interface VmRunResult {
  /** 脚本完成值（最后一个表达式的值；语句块为 undefined）。 */
  result: unknown;
  /** 捕获的 console 输出行（log/info/warn/error/debug 扁平按序）。 */
  console: string[];
  durationMs: number;
}

export const DEFAULT_VM_TIMEOUT_MS = 100;
export const DEFAULT_VM_MAX_CODE_LENGTH = 64 * 1024;
export const DEFAULT_VM_MAX_CONSOLE_ENTRIES = 10_000;

/**
 * 在零依赖内存沙箱中运行一段纯计算 JS 代码。
 *
 * - 上下文白名单：`console`（捕获版，不写宿主 stdout）、`JSON`、`Math`
 *   （guest realm 内建）、`data`（opts.data，可选）；
 * - 超时（默认 100ms）由 vm.Script timeout 选项硬中断，抛 `VmRunError('timeout')`；
 * - 执行期异常（TypeError/RangeError/用户 throw）统一包装为 `VmRunError('runtime')`；
 * - 代码长度超限在执行前拒绝，抛 `VmRunError('too-long')`；
 * - 不注入任何工具/IO 能力——接缝③，工具绑定归 BI-16.2。
 */
export function runInVm(code: string, opts?: VmRunOptions): VmRunResult {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_VM_TIMEOUT_MS;
  const maxCodeLength = opts?.maxCodeLength ?? DEFAULT_VM_MAX_CODE_LENGTH;
  const maxConsoleEntries = opts?.maxConsoleEntries ?? DEFAULT_VM_MAX_CONSOLE_ENTRIES;

  if (typeof code !== "string") {
    throw new VmRunError("runtime", `code must be a string, got ${typeof code}`);
  }
  if (code.length > maxCodeLength) {
    throw new VmRunError("too-long", `code length ${code.length} exceeds limit ${maxCodeLength} chars`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new VmRunError("runtime", `timeoutMs must be a positive finite number, got ${timeoutMs}`);
  }

  const captured: string[] = [];
  let consoleTruncated = false;
  const pushLine = (line: string): void => {
    if (captured.length >= maxConsoleEntries) {
      if (!consoleTruncated) {
        consoleTruncated = true;
        captured.push("<console truncated>");
      }
      return;
    }
    captured.push(line);
  };
  const capturingConsole = {
    log: (...args: unknown[]) => pushLine(formatLine(args)),
    info: (...args: unknown[]) => pushLine(formatLine(args)),
    warn: (...args: unknown[]) => pushLine(formatLine(args)),
    error: (...args: unknown[]) => pushLine(formatLine(args)),
    debug: (...args: unknown[]) => pushLine(formatLine(args)),
  };

  // 白名单上下文：console（捕获版）+ data。JSON/Math 由 guest realm 内建提供，
  // 不从宿主注入（避免把宿主 realm 对象暴露进 guest，扩大逃逸面）。
  const sandbox: Record<string, unknown> = { console: capturingConsole };
  if (opts?.data !== undefined) {
    sandbox.data = opts.data;
  }
  const context = vm.createContext(sandbox);

  const script = new vm.Script(code, { filename: opts?.filename ?? "codemode-sandbox.js" });
  const t0 = performance.now();
  let result: unknown;
  try {
    result = script.runInContext(context, { timeout: timeoutMs, displayErrors: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/timed out/i.test(message)) {
      throw new VmRunError("timeout", `script execution timed out after ${timeoutMs}ms`, { cause: err });
    }
    throw new VmRunError("runtime", message, { cause: err });
  }
  return { result, console: captured, durationMs: performance.now() - t0 };
}

/** console 行格式化：字符串原样，其余安全序列化（循环引用/不可序列化降级 String()）。 */
function formatLine(args: unknown[]): string {
  return args
    .map((v) => {
      if (typeof v === "string") return v;
      if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
        return String(v);
      }
      try {
        return JSON.stringify(v) ?? String(v);
      } catch {
        return String(v);
      }
    })
    .join(" ");
}
