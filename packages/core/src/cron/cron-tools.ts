/**
 * BI-07.7 — Cron 模型工具三件套（CronCreate / CronList / CronDelete）。
 *
 * 模型可见语义（工单钉死）：三工具面为会话内 cron 的注册/巡检/注销入口。
 * 触发动作（action 回调）不属于模型参数——由装配层在构造 CronTools 时经
 * onFire 端口注入（"触发→action 回调注入"），CronCreate 仅登记名称与表达式。
 * FIX-A F1 备案：登记/巡检/注销已接真实工作；**到点自动触发仍未接线**
 * （onFire 无人注入、tick 无宿主推进）——工具描述如实陈述，不冒充"到点会自动执行"。
 * 参数校验走房规 mini 校验：拒绝不走异常控制流，返回 { ok:false, code, message }。
 */
import { CronError, type CronEntry, type CronService } from "./cron-service";

export interface CronToolSpec {
  readonly name: "CronCreate" | "CronList" | "CronDelete";
  readonly description: string;
  readonly inputSchema: unknown;
}

export const CRON_CREATE_TOOL_SPEC: CronToolSpec = {
  name: "CronCreate",
  description:
    "在当前会话内登记一条 cron 周期任务（5 字段表达式：分 时 日 月 周）。" +
    "当前版本只登记条目（计算下次触发时刻），到点自动触发尚未接线，不会自动执行任何动作；" +
    "同名重复登记幂等返回既有条目。",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "任务名（会话内唯一，幂等键）" },
      cron_expr: { type: "string", description: "5 字段 cron 表达式：分 时 日 月 周" },
    },
    required: ["name", "cron_expr"],
  },
};

export const CRON_LIST_TOOL_SPEC: CronToolSpec = {
  name: "CronList",
  description:
    "列出当前会话内已登记的 cron 任务（含下次触发时刻；自动触发接线前「最近触发」留痕恒空）。",
  inputSchema: { type: "object", properties: {} },
};

export const CRON_DELETE_TOOL_SPEC: CronToolSpec = {
  name: "CronDelete",
  description: "按 id 注销一条会话内 cron 任务。",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "CronList 返回的任务 id" } },
    required: ["id"],
  },
};

export type CronToolResult =
  | { readonly ok: true; readonly entry: CronEntry }
  | { readonly ok: true; readonly entries: readonly CronEntry[] }
  | { readonly ok: true; readonly deleted: true; readonly id: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface CronToolsDeps {
  readonly service: CronService;
  /** 装配层注入的触发回调（CronCreate 登记的条目到期时被 CronService 调用）。 */
  readonly onFire?: (entry: CronEntry) => void | Promise<void>;
}

function plainArgs(args: unknown): Record<string, unknown> | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  return args as Record<string, unknown>;
}

export class CronTools {
  readonly #deps: CronToolsDeps;

  constructor(deps: CronToolsDeps) {
    this.#deps = deps;
  }

  /** CronCreate 入口。结构化结果，绝不 throw。 */
  async runCreate(args: unknown): Promise<CronToolResult> {
    const input = plainArgs(args);
    if (input === undefined) {
      return { ok: false, code: "invalid-input", message: "参数须为对象" };
    }
    const name = input["name"];
    const cronExpr = input["cron_expr"];
    if (typeof name !== "string" || name.trim().length === 0) {
      return { ok: false, code: "invalid-input", message: "name 须为非空字符串" };
    }
    if (typeof cronExpr !== "string" || cronExpr.trim().length === 0) {
      return { ok: false, code: "invalid-input", message: "cron_expr 须为非空字符串" };
    }
    try {
      const entry = this.#deps.service.create(name, cronExpr, (fired) =>
        this.#deps.onFire?.(fired),
      );
      return { ok: true, entry };
    } catch (err) {
      return CronTools.#toError(err);
    }
  }

  /** CronList 入口。 */
  runList(): CronToolResult {
    return { ok: true, entries: this.#deps.service.list() };
  }

  /** CronDelete 入口。 */
  runDelete(args: unknown): CronToolResult {
    const input = plainArgs(args);
    if (input === undefined) {
      return { ok: false, code: "invalid-input", message: "参数须为对象" };
    }
    const id = input["id"];
    if (typeof id !== "string" || id.length === 0) {
      return { ok: false, code: "invalid-input", message: "id 须为非空字符串" };
    }
    if (!this.#deps.service.delete(id)) {
      return { ok: false, code: "unknown-cron", message: `未知 cron 任务: ${id}` };
    }
    return { ok: true, deleted: true, id };
  }

  static #toError(err: unknown): CronToolResult {
    if (err instanceof CronError) {
      return { ok: false, code: err.code, message: err.message };
    }
    return { ok: false, code: "internal", message: (err as Error).message };
  }
}
