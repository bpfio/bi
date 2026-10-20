/**
 * BI-16.1 · run_js —— CodeMode JS 沙箱接成模型工具（薄壳，零新造轮子）。
 *
 * 器官：packages/a2a/src/codemode/vm-runner.ts（node:vm 纯计算沙箱）本卡零改动，
 * 本文件只做「工具面接线」：喂模型定义 + 参数校验 + 超时封顶 + 结果结构化。
 *
 * 沙箱边界（与器官一致，本卡不放宽）：
 * - 全新 guest realm：process / require / Bun / fetch 等宿主全局一律不可见；
 * - 零网络 / 零 fs：guest 无 require / 无 import，只能算；
 * - 零工具注入：脚本内拿不到任何模型工具句柄（接缝③，工具绑定归 BI-16.2 PTC）。
 *
 * 超时封顶（防滥用）：timeout_ms 请求值 clamp 到 CODEMODE_MAX_TIMEOUT_MS（1000ms），
 * 缺省 100ms（器官缺省）——模型不能申请长时间占用事件循环。
 *
 * 返回面（JSON 字符串）：
 * - 成功 {ok:true, value, console?}：value 为完成值（undefined 归一为 null），
 *   console 仅在捕获到输出时出现；
 * - 失败 {ok:false, error:"<VmErrorCode>: <message>"}：timeout / runtime /
 *   too-long / compile 四类结构化错误，不抛裸异常。
 *
 * 完成值口径（器官现状，本卡不掩盖）：器官跑前经 Bun 转译器做 TS→JS 类型擦除，
 * 转译器会丢弃「纯表达式语句」（如 `42`、`typeof fetch`），故末尾表达式不一定
 * 成为完成值——此时 value 为 null。可靠回传请用 console.log（console 字段按序
 * 回传）。本卡如实透传，不额外加工。
 */

import { DEFAULT_VM_TIMEOUT_MS, VmRunError, runInVm } from "../../../a2a/src/codemode/vm-runner";
import type { ToolBinding } from "../cli/headless";

/** 工具名（模型可见名 + 挂载面名，单一事实源）。 */
export const CODEMODE_TOOL_NAME = "run_js";

/** timeout_ms 请求上限（毫秒）——超出一律 clamp，防长时间占用事件循环。 */
export const CODEMODE_MAX_TIMEOUT_MS = 1000;

/** run_js 工具装配选项（缺省即生产形态）。 */
export interface CodemodeToolOptions {
  /** timeout_ms 封顶值（缺省 CODEMODE_MAX_TIMEOUT_MS）。 */
  readonly maxTimeoutMs?: number;
}

/**
 * 超时 clamp：缺省 → 器官缺省 100ms；上限 → maxTimeoutMs；下限 → 1ms。
 * 非法值（NaN / Infinity / ≤0）已在 execute 的参数校验层拦下，此处只做夹取。
 */
export function clampCodemodeTimeoutMs(
  requested: number | undefined,
  maxTimeoutMs: number = CODEMODE_MAX_TIMEOUT_MS,
): number {
  if (requested === undefined) return DEFAULT_VM_TIMEOUT_MS;
  const capped = Math.min(Math.floor(requested), maxTimeoutMs);
  return capped >= 1 ? capped : 1;
}

/**
 * 装配 run_js 工具绑定（器官零改动，只做接线）。
 * readOnly:true —— 沙箱无 fs 写语义（与器官白名单一致：无 require / 无 import）。
 */
export function makeCodemodeTool(options: CodemodeToolOptions = {}): ToolBinding {
  const maxTimeoutMs = options.maxTimeoutMs ?? CODEMODE_MAX_TIMEOUT_MS;
  return {
    definition: {
      name: CODEMODE_TOOL_NAME,
      description:
        "在工作区隔离 vm 中执行纯计算 JS（禁网络/禁 fs/禁工具注入）。" +
        "返回 JSON {ok:true, value, console?} 或 {ok:false, error}。" +
        "value 为最后一条表达式的值（语句块为 null）；可靠回传请用 console.log（console 字段按序回传）。" +
        "默认超时 100ms（timeout_ms 可调，上限 1000ms）。",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "要执行的 JS 源码（最后一个表达式为完成值）" },
          timeout_ms: { type: "number", description: "超时毫秒数（缺省 100，上限 1000）" },
        },
        required: ["code"],
      },
    },
    readOnly: true,
    argSummary: (args) => summarizeCode(args),
    execute: async (args, signal): Promise<string> => {
      // vm 执行是同步的（占事件循环），abort 无法中途抢占——只在起跑前判一次。
      if (signal.aborted) {
        return JSON.stringify({ ok: false, error: "aborted: 执行已取消" });
      }
      const record = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
      const rawCode = record["code"];
      if (typeof rawCode !== "string" || rawCode.trim() === "") {
        return JSON.stringify({ ok: false, error: "invalid-args: code required（非空字符串）" });
      }
      const rawTimeout = record["timeout_ms"];
      if (rawTimeout !== undefined && (typeof rawTimeout !== "number" || !Number.isFinite(rawTimeout) || rawTimeout <= 0)) {
        return JSON.stringify({ ok: false, error: "invalid-args: timeout_ms invalid（正数毫秒）" });
      }
      const timeoutMs = clampCodemodeTimeoutMs(rawTimeout as number | undefined, maxTimeoutMs);
      try {
        const { result, console: captured } = runInVm(rawCode, { timeoutMs });
        const payload: Record<string, unknown> = {
          ok: true,
          value: result === undefined ? null : toJsonSafe(result),
        };
        if (captured.length > 0) payload["console"] = [...captured];
        return JSON.stringify(payload);
      } catch (err) {
        if (err instanceof VmRunError) {
          return JSON.stringify({ ok: false, error: `${err.code}: ${err.message}` });
        }
        const message = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ ok: false, error: `runtime: ${message}` });
      }
    },
  };
}

/** argSummary：代码片段（权限门审计面，截断 80 字符）。 */
function summarizeCode(args: unknown): string {
  const record = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const code = typeof record["code"] === "string" ? (record["code"] as string) : "";
  const head = code.length > 80 ? `${code.slice(0, 80)}…` : code;
  return `code=${JSON.stringify(head)}`;
}

/**
 * JSON 安全化（guest realm 值 → 可序列化结构）：
 * bigint → "123n"；函数 → "[Function name]"；循环引用 → "[Circular]"；
 * 非有限数字 → 字符串标注。跨 realm 安全：不依赖 instanceof（guest 原型链不同）。
 */
function toJsonSafe(value: unknown, seen: Set<object> = new Set()): unknown {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === "bigint") return `${(value as bigint).toString()}n`;
  if (kind === "function") return `[Function ${(value as { name?: string }).name || "anonymous"}]`;
  if (kind === "symbol") return String(value);
  if (kind === "number") return Number.isFinite(value as number) ? value : String(value);
  if (kind !== "object") return value;
  const obj = value as object;
  if (seen.has(obj)) return "[Circular]";
  seen.add(obj);
  try {
    if (Array.isArray(obj)) return obj.map((item) => toJsonSafe(item, seen));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(obj as Record<string, unknown>)) {
      out[key] = toJsonSafe(item, seen);
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}
