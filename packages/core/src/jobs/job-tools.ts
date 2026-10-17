/**
 * BI-07.11 — 后台任务模型工具三件套：job_list / job_output / job_kill。
 *
 * 模型可见语义：巡检后台任务列表、tail 读取输出、终止任务。
 * 参数校验走房规 mini 校验（拒绝不走异常控制流），未知 id / 非法状态
 * 结构化拒绝（映射 JobError.code）。
 */
import { JobError, type Job, type JobRegistry } from "./job-registry";

export interface JobToolSpec {
  readonly name: "JobList" | "JobOutput" | "JobKill";
  readonly description: string;
  readonly inputSchema: unknown;
}

export const JOB_LIST_TOOL_SPEC: JobToolSpec = {
  name: "JobList",
  description: "列出后台任务（id/kind/状态/起止时刻），巡检异步任务用。",
  inputSchema: { type: "object", properties: {} },
};

export const JOB_OUTPUT_TOOL_SPEC: JobToolSpec = {
  name: "JobOutput",
  description:
    "读取后台任务输出（环形缓冲，超容量保留最新 64KB）。" +
    "tail 指定自尾部读取的字符数；缺省全量驻留内容。",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "JobList 返回的任务 id" },
      tail: { type: "integer", description: "自尾部读取字符数（正整数，缺省全量）" },
    },
    required: ["id"],
  },
};

export const JOB_KILL_TOOL_SPEC: JobToolSpec = {
  name: "JobKill",
  description: "终止一个运行中的后台任务（killed 终态）；已结束任务返回状态拒绝。",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "JobList 返回的任务 id" } },
    required: ["id"],
  },
};

export type JobToolResult =
  | { ok: true; jobs: readonly Job[] }
  | { ok: true; job: Job; output: string }
  | { ok: true; killed: true; id: string }
  | { ok: false; code: string; message: string };

function plainArgs(args: unknown): Record<string, unknown> | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  return args as Record<string, unknown>;
}

export class JobTools {
  readonly #registry: JobRegistry;

  constructor(registry: JobRegistry) {
    this.#registry = registry;
  }

  /** job_list 入口。 */
  runList(): JobToolResult {
    return { ok: true, jobs: this.#registry.list() };
  }

  /** job_output 入口：{ id, tail? }。 */
  runOutput(args: unknown): JobToolResult {
    const input = plainArgs(args);
    if (input === undefined) {
      return { ok: false, code: "invalid-input", message: "参数须为对象" };
    }
    const id = input["id"];
    if (typeof id !== "string" || id.length === 0) {
      return { ok: false, code: "invalid-input", message: "id 须为非空字符串" };
    }
    const tail = input["tail"];
    if (tail !== undefined && (!Number.isInteger(tail) || (tail as number) < 1)) {
      return { ok: false, code: "invalid-input", message: "tail 须为正整数" };
    }
    try {
      const { job, output } = this.#registry.output(id, { tail: tail as number | undefined });
      return { ok: true, job, output };
    } catch (err) {
      return JobTools.#toError(err);
    }
  }

  /** job_kill 入口：{ id }。 */
  runKill(args: unknown): JobToolResult {
    const input = plainArgs(args);
    if (input === undefined) {
      return { ok: false, code: "invalid-input", message: "参数须为对象" };
    }
    const id = input["id"];
    if (typeof id !== "string" || id.length === 0) {
      return { ok: false, code: "invalid-input", message: "id 须为非空字符串" };
    }
    if (this.#registry.get(id) === undefined) {
      return { ok: false, code: "unknown-job", message: `未知任务: ${id}` };
    }
    if (!this.#registry.kill(id)) {
      return { ok: false, code: "not-running", message: `任务非运行态，无法终止: ${id}` };
    }
    return { ok: true, killed: true, id };
  }

  static #toError(err: unknown): JobToolResult {
    if (err instanceof JobError) {
      return { ok: false, code: err.code, message: err.message };
    }
    return { ok: false, code: "internal", message: (err as Error).message };
  }
}
