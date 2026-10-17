/**
 * BI-07.8 — `AgentSwarm({ tasks, prompt_template, max_concurrency, timeout_ms })`
 * 模型工具处理器。
 *
 * 输入校验（工单钉死）：tasks 非空且 ≤64、全为字符串；prompt_template 必须含
 * {{item}} 占位；max_concurrency 正整数；timeout_ms 正数。拒绝不走异常控制流
 * （房规 mini 校验），返回 { ok:false, code, message } 结构化结果。
 */
import { SwarmError, type SwarmResult, type SwarmService } from "./swarm-service";

export interface AgentSwarmToolSpec {
  readonly name: "AgentSwarm";
  readonly description: string;
  readonly inputSchema: unknown;
}

export const AGENT_SWARM_TOOL_SPEC: AgentSwarmToolSpec = {
  name: "AgentSwarm",
  description:
    "并行子智能体蜂群：将 prompt_template 渲染到每个条目（{{item}} 占位），" +
    "按并发上限派生轻量子代理同时执行，聚合全部结果；单条超时/失败不拖全群。",
  inputSchema: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        items: { type: "string" },
        description: "条目列表（非空，≤64 条，渲染进模板 {{item}} 占位）",
      },
      prompt_template: {
        type: "string",
        description: "提示模板，必须包含 {{item}} 占位符（每条目渲染一次）",
      },
      max_concurrency: {
        type: "integer",
        description: "并发上限（缺省 3；超出上限的条目 FIFO 排队）",
      },
      timeout_ms: { type: "number", description: "单条超时毫秒（缺省不限时）" },
    },
    required: ["tasks", "prompt_template"],
  },
};

export type AgentSwarmToolResult =
  | ({ readonly ok: true } & SwarmResult)
  | { readonly ok: false; readonly code: string; readonly message: string };

function plainArgs(args: unknown): Record<string, unknown> | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  return args as Record<string, unknown>;
}

export class AgentSwarmTool {
  readonly spec = AGENT_SWARM_TOOL_SPEC;
  readonly #service: SwarmService;

  constructor(service: SwarmService) {
    this.#service = service;
  }

  /** 工具入口。结构化结果，绝不 throw。 */
  async run(args: unknown): Promise<AgentSwarmToolResult> {
    const input = plainArgs(args);
    if (input === undefined) {
      return { ok: false, code: "invalid-input", message: "参数须为对象" };
    }
    const tasks = input["tasks"];
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return { ok: false, code: "invalid-input", message: "tasks 须为非空数组（≤64 条字符串）" };
    }
    if (tasks.length > 64) {
      return { ok: false, code: "invalid-input", message: "tasks 条目数超上限 64" };
    }
    for (const item of tasks) {
      if (typeof item !== "string") {
        return { ok: false, code: "invalid-input", message: "tasks 条目须全为字符串" };
      }
    }
    const template = input["prompt_template"];
    if (typeof template !== "string" || !template.includes("{{item}}")) {
      return {
        ok: false,
        code: "invalid-input",
        message: "prompt_template 须为包含 {{item}} 占位符的字符串",
      };
    }
    const maxConcurrency = input["max_concurrency"];
    if (
      maxConcurrency !== undefined &&
      (!Number.isInteger(maxConcurrency) || (maxConcurrency as number) < 1)
    ) {
      return { ok: false, code: "invalid-input", message: "max_concurrency 须为 ≥1 的整数" };
    }
    const timeoutMs = input["timeout_ms"];
    if (
      timeoutMs !== undefined &&
      (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
    ) {
      return { ok: false, code: "invalid-input", message: "timeout_ms 须为正数" };
    }
    try {
      const result = await this.#service.swarm(tasks as string[], {
        promptTemplate: template,
        maxConcurrency: maxConcurrency as number | undefined,
        timeoutMs: timeoutMs as number | undefined,
      });
      return { ok: true, ...result };
    } catch (err) {
      if (err instanceof SwarmError) {
        return { ok: false, code: err.code, message: err.message };
      }
      return { ok: false, code: "internal", message: (err as Error).message };
    }
  }
}
