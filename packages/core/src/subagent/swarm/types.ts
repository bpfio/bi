/**
 * BI-07.8 — 蜂群共享类型与校验常量。
 *
 * spawnFn 端口 = BI-07.3 SubagentRunner 句柄语义（生产由宿主装配注入
 * SubagentRunner 的派生面，测试注入 stub）；本包内只认端口，不反依赖 runner。
 */

/** 模板占位符（工单钉死 {{item}}；渲染时全部出现处替换）。 */
export const SWARM_ITEM_PLACEHOLDER = "{{item}}";

/** 单次蜂群条目上限（工单钉死 64）。 */
export const SWARM_MAX_TASKS = 64;

/** 缺省并发上限（工单钉死 3）。 */
export const SWARM_DEFAULT_CONCURRENCY = 3;

/** 轻量子代理派生端口（BI-07.3 SubagentRunner 句柄语义）。 */
export type SpawnFn = (prompt: string) => Promise<string>;

export interface SwarmOptions {
  /** 提示模板，必须包含 {{item}} 占位符。 */
  readonly promptTemplate: string;
  /** 并发槽位上限（缺省 3；房规：上限内并行、超限 FIFO 排队）。 */
  readonly maxConcurrency?: number;
  /** 单条超时毫秒（缺省不限时；复用 BI-06.3 withDeadline 看门狗）。 */
  readonly timeoutMs?: number;
}

export interface SwarmItemResult {
  /** 原始条目（未渲染）。 */
  readonly item: string;
  readonly ok: boolean;
  /** 成功：spawnFn 输出；失败：空串。 */
  readonly output: string;
  readonly durationMs: number;
  /** 失败原因（超时 / spawnFn 拒绝）。 */
  readonly error?: string;
}

export interface SwarmResult {
  /** 与输入同序（完成序无关）。 */
  readonly results: readonly SwarmItemResult[];
  readonly failed: number;
  readonly total: number;
}

export type SwarmErrorCode =
  | "invalid-tasks"
  | "invalid-template"
  | "invalid-options";

/** SwarmService 结构化错误（判别方式：code 字段）。 */
export class SwarmError extends Error {
  readonly code: SwarmErrorCode;

  constructor(code: SwarmErrorCode, message: string) {
    super(message);
    this.name = "SwarmError";
    this.code = code;
  }
}

/** 模板渲染：{{item}} 全部出现处替换为条目原文（无转义、确定性）。 */
export function renderSwarmPrompt(template: string, item: string): string {
  return template.split(SWARM_ITEM_PLACEHOLDER).join(item);
}

/** tasks 入参校验：非空字符串数组、非空、≤64。 */
export function validateSwarmTasks(tasks: unknown): string[] {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new SwarmError("invalid-tasks", "tasks 须为非空数组");
  }
  if (tasks.length > SWARM_MAX_TASKS) {
    throw new SwarmError("invalid-tasks", `tasks 条目数超上限 ${SWARM_MAX_TASKS}: ${tasks.length}`);
  }
  for (const item of tasks) {
    if (typeof item !== "string") {
      throw new SwarmError("invalid-tasks", "tasks 条目须全为字符串");
    }
  }
  return tasks as string[];
}

/** 模板校验：字符串且含 {{item}} 占位。 */
export function validateSwarmTemplate(template: unknown): string {
  if (typeof template !== "string" || !template.includes(SWARM_ITEM_PLACEHOLDER)) {
    throw new SwarmError("invalid-template", `promptTemplate 须为包含 ${SWARM_ITEM_PLACEHOLDER} 占位符的字符串`);
  }
  return template;
}

/** 并发上限校验：正整数。 */
export function validateSwarmConcurrency(maxConcurrency: unknown): number | undefined {
  if (maxConcurrency === undefined) return undefined;
  if (!Number.isInteger(maxConcurrency) || (maxConcurrency as number) < 1) {
    throw new SwarmError("invalid-options", `maxConcurrency 须为 ≥1 的整数: ${maxConcurrency}`);
  }
  return maxConcurrency as number;
}

/** 单条超时校验：正数（缺省 undefined = 不限时）。 */
export function validateSwarmTimeoutMs(timeoutMs: unknown): number | undefined {
  if (timeoutMs === undefined) return undefined;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new SwarmError("invalid-options", `timeoutMs 须为正数: ${timeoutMs}`);
  }
  return timeoutMs;
}
