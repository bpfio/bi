/**
 * BI-16.2 · PTC (Programmatic Tool Calling) —— 精算脚本执行器。
 *
 * 执行模型回传的单轮脚本:脚本内以 `await tools.<name>(args)` 程序化调用
 * 工具,工具调用经注入的 executor 回调落地;脚本原生支持循环/分支/
 * Promise.all 并发,因为 `tools` 代理每次调用都返回真实 Promise。
 *
 * 硬约束(全部强制):
 *   - 静态扫描:执行前剥离注释后扫描,拒绝 import / require / process /
 *     globalThis / eval / Function / constructor / __proto__ / Bun /
 *     setInterval 等逃逸面(默认黑名单,可覆盖);
 *   - 受限作用域:`new Function` 注入 tools,并以同名形参遮蔽
 *     process/require/globalThis/Function/module/exports/Buffer;
 *   - 执行超时:Promise.race 熔断,可配,缺省 30s;
 *   - 调用次数上限:代理侧同步计数,超出即拒绝(缺省 64 次);
 *   - 只回传最终结果与调用台账(calls 台账含每次尝试;totalCalls 只计
 *     真正派发到 executor 的次数)。
 *
 * 说明:单线程内无法打断已阻塞的同步死循环;超时以 race 放弃该轮执行,
 * 上层应配合进程级看门狗使用。
 */

export type PtcToolExecutor = (name: string, args: unknown) => Promise<unknown>;

/** 单次调用台账记录(含被上限/未知工具拒绝的尝试)。 */
export interface PtcCallRecord {
  /** 全局递增序号,从 1 开始(按尝试顺序)。 */
  seq: number;
  tool: string;
  args: unknown;
  ok: boolean;
  /** 成功时的工具返回值(未成功不出现)。 */
  result?: unknown;
  /** 失败原因(工具抛错/未知工具/超上限),未成功必出现。 */
  error?: string;
  durationMs: number;
}

export interface PtcRunResult {
  ok: boolean;
  /** 脚本最终 return 值;undefined 归一为 null。失败时不出现。 */
  result?: unknown;
  /** 失败原因(静态扫描/超时/调用上限/脚本异常)。 */
  error?: string;
  /** 调用台账(含被拒绝的尝试)。 */
  calls: PtcCallRecord[];
  /** 真正派发到 executor 的调用次数。 */
  totalCalls: number;
  durationMs: number;
  timedOut: boolean;
}

export interface PtcRunnerOptions {
  /** 工具执行器:按工具名与参数派发(注入式,便于测试与真实工具桥接)。 */
  executor: PtcToolExecutor;
  /** 执行超时毫秒数,缺省 30000。 */
  timeoutMs?: number;
  /** 工具调用次数上限,缺省 64;0 表示本轮禁止调用。 */
  maxToolCalls?: number;
  /** 静态扫描拒绝模式(RegExp 源或字符串),缺省 DEFAULT_DENY_PATTERNS。 */
  denyPatterns?: readonly (RegExp | string)[];
  /** 声明过的工具名集合;提供后调用未声明工具将被拒绝且不派发。 */
  knownTools?: readonly string[];
}

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

export class PtcError extends Error {
  override readonly name: string = "PtcError";
}

/** 静态扫描拒绝。 */
export class PtcStaticScanError extends PtcError {
  override readonly name = "PtcStaticScanError";
  constructor(message: string, readonly violations: readonly string[]) {
    super(message);
  }
}

/** 执行超时熔断。 */
export class PtcTimeoutError extends PtcError {
  override readonly name = "PtcTimeoutError";
}

/** 超出调用次数上限。 */
export class PtcCallLimitError extends PtcError {
  override readonly name = "PtcCallLimitError";
}

/** 调用未声明工具。 */
export class PtcUnknownToolError extends PtcError {
  override readonly name = "PtcUnknownToolError";
}

// ---------------------------------------------------------------------------
// 静态扫描
// ---------------------------------------------------------------------------

/** 默认逃逸面黑名单:合约硬性三项(import/require/process)+ 常见逃逸补强。 */
export const DEFAULT_DENY_PATTERNS: readonly RegExp[] = [
  /\bimport\b/,
  /\brequire\b/,
  /\bprocess\b/,
  /\bglobalThis\b/,
  /\beval\b/,
  /\bFunction\b/,
  /\bconstructor\b/,
  /\b__proto__\b/,
  /\bBun\b/,
  /\bsetInterval\b/,
];

/**
 * 剥离 JS 注释(行注释与块注释,块注释内容替换为空格以保留行列),
 * 使静态扫描不被注释中的单词误伤。字符串字面量整体保留(不剥离)。
 */
export function stripJsComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = i + 1 < n ? src[i + 1] : "";
    if (ch === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && i + 1 < n && src[i + 1] === "/")) {
        i++;
      }
      i += 2;
      out += " ";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        const c = src[i];
        out += c;
        if (c === "\\" && i + 1 < n) {
          out += src[i + 1];
          i += 2;
          continue;
        }
        i++;
        if (c === quote) break;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** 静态扫描:命中任一拒绝模式即拒绝,返回违规描述列表。 */
export function staticScan(
  script: string,
  patterns: readonly (RegExp | string)[] = DEFAULT_DENY_PATTERNS,
): { ok: boolean; violations: string[] } {
  const stripped = stripJsComments(script);
  const violations: string[] = [];
  for (const p of patterns) {
    const re = typeof p === "string" ? new RegExp(p) : p;
    if (re.test(stripped)) violations.push(`/${re.source}/`);
  }
  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// 执行器
// ---------------------------------------------------------------------------

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_TOOL_CALLS = 64;

/** 运行时遮蔽名单:同名形参切断脚本对宿主全局的直接引用。 */
const SHADOW_PARAMS = ["process", "require", "globalThis", "Function", "module", "exports", "Buffer"] as const;

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * 执行一段模型生成的 PTC 精算脚本(单轮)。
 *
 * 脚本体内可用绑定:`tools`(工具代理,`await tools.<name>(args)`)以及
 * 标准内建(Promise/Math/JSON/Object 等);process/require/globalThis 等
 * 宿主引用已被遮蔽,且静态扫描会在执行前拒绝。
 */
export async function runPtcScript(
  script: string,
  options: PtcRunnerOptions,
): Promise<PtcRunResult> {
  const executor = options.executor;
  const timeoutMs =
    typeof options.timeoutMs === "number" && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const maxToolCalls =
    typeof options.maxToolCalls === "number" && Number.isFinite(options.maxToolCalls)
      ? Math.max(0, Math.floor(options.maxToolCalls))
      : DEFAULT_MAX_TOOL_CALLS;
  const denyPatterns = options.denyPatterns ?? DEFAULT_DENY_PATTERNS;
  const knownTools = options.knownTools ? new Set<string>(options.knownTools) : undefined;

  const startedAt = performance.now();
  const finish = () => performance.now() - startedAt;

  // 台账状态先于 fail 助手声明(避免 TDZ)。
  const calls: PtcCallRecord[] = [];
  let seq = 0;
  let dispatched = 0;

  const fail = (error: string, extra?: Partial<PtcRunResult>): PtcRunResult => ({
    ok: false,
    error,
    calls,
    totalCalls: dispatched,
    durationMs: finish(),
    timedOut: false,
    ...extra,
  });

  // 1) 静态扫描:先于一切执行。
  const scan = staticScan(script, denyPatterns);
  if (!scan.ok) {
    const err = new PtcStaticScanError(
      `PTC 静态扫描拒绝: ${scan.violations.join("; ")}`,
      scan.violations,
    );
    return fail(err.message);
  }

  // 2) 工具代理:每次属性访问产出独立派发函数,同步计数、记录台账。
  const makeToolsProxy = (): unknown => {
    const target = Object.create(null) as Record<string, unknown>;
    return new Proxy(target, {
      get(_t, prop) {
        // 防止代理被当作 thenable/特殊协议对象使用。
        if (typeof prop !== "string" || prop === "then" || prop === "toJSON") {
          return undefined;
        }
        const tool = prop;
        return (args?: unknown): Promise<unknown> => {
          const record: PtcCallRecord = {
            seq: ++seq,
            tool,
            args,
            ok: false,
            error: "",
            durationMs: 0,
          };
          calls.push(record);
          const rejectWith = (err: PtcError): Promise<never> => {
            record.error = err.message;
            record.durationMs = performance.now() - startedAt;
            return Promise.reject(err);
          };
          if (knownTools && !knownTools.has(tool)) {
            return rejectWith(new PtcUnknownToolError(`未知工具: ${tool}`));
          }
          if (dispatched >= maxToolCalls) {
            return rejectWith(
              new PtcCallLimitError(`PTC 调用次数上限(${maxToolCalls})已耗尽`),
            );
          }
          dispatched++;
          const callStart = performance.now();
          return Promise.resolve()
            .then(() => executor(tool, args))
            .then(
              (result) => {
                record.ok = true;
                record.result = result;
                record.durationMs = performance.now() - callStart;
                return result;
              },
              (err: unknown) => {
                record.error = errorMessage(err);
                record.durationMs = performance.now() - callStart;
                throw err;
              },
            );
        };
      },
    });
  };

  // 3) 受限作用域编译:new Function 形参遮蔽宿主引用。
  const body = `"use strict";\nreturn (async () => {\n${script}\n})();`;
  let factory: Function;
  try {
    factory = new Function("tools", ...SHADOW_PARAMS, body);
  } catch (err) {
    return fail(`PTC 脚本语法错误: ${errorMessage(err)}`);
  }

  const runPromise = (factory as (...args: unknown[]) => unknown)(
    makeToolsProxy(),
    ...SHADOW_PARAMS.map(() => undefined),
  );
  if (!(runPromise instanceof Promise)) {
    return fail("PTC 脚本未返回 Promise(内部异常)");
  }

  // 4) 超时熔断:race 放弃本轮,清理定时器。
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new PtcTimeoutError(`PTC 执行超时(${timeoutMs}ms)`)),
      timeoutMs,
    );
  });

  try {
    const result = await Promise.race([runPromise, timeoutPromise]);
    return {
      ok: true,
      result: result === undefined ? null : result,
      calls,
      totalCalls: dispatched,
      durationMs: finish(),
      timedOut: false,
    };
  } catch (err) {
    const timedOut = err instanceof PtcTimeoutError;
    const prefix = timedOut ? "" : "PTC 脚本执行失败: ";
    return fail(`${prefix}${errorMessage(err)}`, { timedOut });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
