/**
 * BI-14 · 声明式 DAG 工作流调度引擎。
 *
 * 接缝①（工单钉死）：持久化与调度全量复用 durable/ 的 DurableStore /
 * DurableScheduler / task-state 转移表，本模块零私有存储——每个工作流步骤
 * 即一条 kind='wf-step' 的持久任务（确定性 id = `wf:{workflowId}:{stepId}`），
 * 步骤完成时 handler 返回值经调度器落为该任务的 checkpoint（结果信封）。
 *
 * DSL（parseWorkflow）：手写最小 YAML 子集——仅认顶层 `steps:` 块列表，
 * 每步 { id, run, depends_on, params }；depends_on 支持内联 [a, b] 与块列表
 * 两种形态，params 仅支持块标量映射。环引用 / 未知依赖 / 重复 id / 缺字段
 * 一律结构化报错（WorkflowParseError.code）。完整 YAML（锚点、多文档、嵌套
 * 结构、流式集合等）归后续增强，本卡不认。
 *
 * 调度模型（DagEngine）：拓扑分层——无依赖同层并行（Promise.all），有依赖
 * 跨层串行。引擎是 kind='wf-step' 记录的合法状态机驱动者：同步认领
 * （get→assertTransition→put，与调度器同一防插队纪律）→ 执行用户 handler →
 * 状态守卫收尾（仅当库内仍为 running 才写 completed，写后以库内权威 checkpoint
 * 回读）——跨实例/跨驱动者（多个引擎实例共享同一 store）不会重复执行已完成
 * 步骤，也无需实例内存 waiter（awaitSettled 的 waiter 是实例私有的，不跨实例
 * 汇聚）。每步至多 STEP_MAX_ATTEMPTS=2 次执行段：1 段真实执行 + 1 段崩溃重放
 * 余量（与 BI-14.5 "防崩溃死循环"同一哲学——同一步骤两次崩溃即 failed 终态，
 * 不再复活）。
 *
 * 步骤失败语义：用户 handler 抛错不产生调度器 failed 任务——'wf-step' 适配器
 * 把异常捕获为 { ok:false, error } 结果信封（任务 completed，checkpoint 留痕），
 * 引擎据此把下游步骤标 skipped（跳过是纯派生态，不落额外记录：重算上游失败/
 * 跳过即可推导）。同层兄弟与无关支路不受失败影响。
 *
 * 断点自愈（recover()）：先复用 BI-14.5 scheduler.recover() 清理 running 孤儿
 * （replay 回 pending），再走与 run() 同一条分层驱动通路——已完成步骤凭 store
 * checkpoint 直接取结果不重跑，未完成步骤（pending，含"提交后未认领"断点）
 * 续跑至收敛。run() 本身即幂等可续跑：确定性任务 id + 已完成短路，重入同
 * workflowId 不会重复执行已完成步骤。
 *
 * 装配约束：scheduler 构造时必须注册 makeWfStepHandler(engine.handlers) 为
 * kind='wf-step' 的 handler（submit 口 fail-fast 校验；注册后 scheduler.run()
 * 亦可驱动 wf-step 任务，与引擎双驱动的重复执行由状态守卫防住）；engine 与
 * scheduler 建议注入同一时钟保持同源。
 */
import {
  DurableScheduler,
  isSuspendSignal,
} from "./durable/durable-scheduler";
import type { TaskHandler } from "./durable/durable-scheduler";
import { assertTransition } from "./durable/task-state";
import type { JsonValue, TaskRecord } from "./durable/task-state";

/** 最小 DSL 中的一个工作流步骤（params 由 parseWorkflow 恒填充，缺省 {}）。 */
export interface WorkflowStep {
  id: string;
  run: string;
  depends_on: string[];
  params?: Record<string, JsonValue>;
}

/** 解析产物：步骤列表（顺序 = 声明顺序）。 */
export interface WorkflowSpec {
  steps: WorkflowStep[];
}

/** 结构化解析/规格错误（判别方式：code 字段）。 */
export class WorkflowParseError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkflowParseError";
    this.code = code;
  }
}

/** 引擎运行期结构化错误（判别方式：code 字段）。 */
export class WorkflowError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// parseWorkflow —— 手写最小 YAML 子集
// ---------------------------------------------------------------------------

/** 扫描产物：一行有意义文本（注释/空行已剔除）。 */
interface SourceLine {
  readonly indent: number;
  readonly text: string;
  readonly no: number;
}

function isDashItem(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

/** 引号外且行首或前置空白的 `#` 起注释；引号内不切。 */
function stripComment(text: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === "\\" && quote === '"') {
        i++; // 双引号串内最小转义：\" 跳过
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || text[i - 1] === " " || text[i - 1] === "\t")) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text;
}

function scanLines(spec: string): SourceLine[] {
  const out: SourceLine[] = [];
  const raw = spec.split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i]!;
    const stripped = line.replace(/^ +/, "");
    const indent = line.length - stripped.length;
    if (stripped.length === 0) continue;
    if (stripped.startsWith("\t")) {
      throw new WorkflowParseError(
        "bad-indent",
        `第 ${i + 1} 行：缩进不允许 Tab（最小 DSL 只认空格）`,
      );
    }
    const text = stripComment(stripped).trimEnd();
    if (text.length === 0) continue;
    out.push({ indent, text, no: i + 1 });
  }
  return out;
}

function parseSingleQuoted(raw: string, where: string): string {
  if (raw.length < 2 || !raw.endsWith("'")) {
    throw new WorkflowParseError("bad-scalar", `${where}：单引号标量未闭合`);
  }
  return raw.slice(1, -1).replace("''", "'");
}

function parseDoubleQuoted(raw: string, where: string): string {
  if (raw.length < 2 || !raw.endsWith('"')) {
    throw new WorkflowParseError("bad-scalar", `${where}：双引号标量未闭合`);
  }
  const body = raw.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) {
      throw new WorkflowParseError("bad-scalar", `${where}：悬空反斜杠转义`);
    }
    if (next === '"') out += '"';
    else if (next === "\\") out += "\\";
    else if (next === "n") out += "\n";
    else if (next === "t") out += "\t";
    else {
      throw new WorkflowParseError(
        "bad-scalar",
        `${where}：不支持的转义 \\${next}（最小 DSL 只认 \\" \\\\ \\n \\t）`,
      );
    }
    i++;
  }
  return out;
}

/** 标量宽表：引号串 / null / 布尔 / 整数 / 浮点，其余按字面字符串。 */
function parseScalar(raw: string, where: string): JsonValue {
  const t = raw.trim();
  if (t.length === 0) return null;
  if (t.startsWith("'")) return parseSingleQuoted(t, where);
  if (t.startsWith('"')) return parseDoubleQuoted(t, where);
  if (t === "null" || t === "~" || t === "Null" || t === "NULL") return null;
  if (t === "true" || t === "True" || t === "TRUE") return true;
  if (t === "false" || t === "False" || t === "FALSE") return false;
  if (/^[+-]?\d+$/.test(t)) return Number(t);
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+[eE][+-]?\d+|(\d+\.\d*|\.\d+)[eE][+-]?\d+)$/.test(t)) {
    return Number(t);
  }
  return t;
}

/** 步骤字段的原始收集形态。 */
interface RawField {
  readonly key: string;
  readonly raw: string;
  readonly children: readonly SourceLine[];
  readonly no: number;
}

const STEP_FIELD_KEYS: ReadonlySet<string> = new Set(["id", "run", "depends_on", "params"]);

function scalarString(field: RawField | undefined, key: string, stepNo: number): string {
  if (field === undefined) {
    throw new WorkflowParseError("bad-step", `第 ${stepNo} 行：步骤缺必填字段 "${key}"`);
  }
  if (field.children.length > 0) {
    throw new WorkflowParseError(
      "bad-step",
      `第 ${field.no} 行：标量字段 "${key}" 不接受块子节点`,
    );
  }
  const v = parseScalar(field.raw, `第 ${field.no} 行字段 "${key}"`);
  if (typeof v !== "string" || v.length === 0) {
    throw new WorkflowParseError("bad-step", `第 ${field.no} 行：字段 "${key}" 须为非空字符串`);
  }
  return v;
}

/**
 * 解析最小 YAML 子集为 WorkflowSpec。
 * 结构化错误码：missing-steps / empty-steps / bad-indent / bad-step /
 * bad-scalar / bad-field / unknown-field / duplicate-field / unsupported-param /
 * duplicate-step / unknown-dep / cycle-detected。
 */
export function parseWorkflow(spec: string): WorkflowSpec {
  const lines = scanLines(spec);
  const root = lines[0];
  if (root === undefined || root.indent !== 0 || root.text !== "steps:") {
    throw new WorkflowParseError("missing-steps", "spec 必须以顶层 `steps:` 开头");
  }

  const steps: WorkflowStep[] = [];
  let i = 1;
  while (i < lines.length) {
    const head = lines[i]!;
    if (head.indent === 0) {
      throw new WorkflowParseError(
        "unknown-field",
        `第 ${head.no} 行：顶层仅允许 steps 键，出现「${head.text}」`,
      );
    }
    if (!isDashItem(head.text)) {
      throw new WorkflowParseError(
        "bad-step",
        `第 ${head.no} 行：steps 下须为 "- " 步骤条目，出现「${head.text}」`,
      );
    }
    const itemIndent = head.indent;
    const dashRest = head.text === "-" ? "" : head.text.slice(2).trim();
    if (dashRest !== "" && !dashRest.includes(":")) {
      throw new WorkflowParseError(
        "bad-step",
        `第 ${head.no} 行：步骤条目首行须为 "key: value" 形态，出现「${dashRest}」`,
      );
    }

    const fields = new Map<string, RawField>();
    const registerField = (line: SourceLine, childStart: number): number => {
      const ci = line.text.indexOf(":");
      if (ci <= 0) {
        throw new WorkflowParseError(
          "bad-field",
          `第 ${line.no} 行：字段须为 "key: value" 形态，出现「${line.text}」`,
        );
      }
      const key = line.text.slice(0, ci).trim();
      const raw = line.text.slice(ci + 1).trim();
      if (!STEP_FIELD_KEYS.has(key)) {
        throw new WorkflowParseError(
          "unknown-field",
          `第 ${line.no} 行：未知步骤字段 "${key}"（最小 DSL 只认 id/run/depends_on/params）`,
        );
      }
      if (fields.has(key)) {
        throw new WorkflowParseError("duplicate-field", `第 ${line.no} 行：字段 "${key}" 重复`);
      }
      const children: SourceLine[] = [];
      let j = childStart;
      while (j < lines.length && lines[j]!.indent > line.indent) {
        children.push(lines[j]!);
        j++;
      }
      fields.set(key, { key, raw, children, no: line.no });
      return j;
    };

    let fieldIndent: number | null = null;
    let pos = i + 1;
    if (dashRest !== "") {
      // 首字段内联在条目行上（"- id: x"），虚拟缩进取 itemIndent + 2 供块子节点归属
      const virtualLine: SourceLine = { indent: itemIndent + 2, text: dashRest, no: head.no };
      fieldIndent = virtualLine.indent;
      pos = registerField(virtualLine, pos);
    }
    while (pos < lines.length) {
      const line = lines[pos]!;
      if (line.indent <= itemIndent) break; // 下一条目 / 结束
      if (fieldIndent === null) {
        if (isDashItem(line.text)) {
          throw new WorkflowParseError(
            "bad-step",
            `第 ${line.no} 行：字段区起首不允许裸列表项「${line.text}」`,
          );
        }
        fieldIndent = line.indent;
      }
      if (line.indent < fieldIndent) {
        throw new WorkflowParseError(
          "bad-indent",
          `第 ${line.no} 行：步骤字段未对齐（期望缩进 ${fieldIndent} 空格）`,
        );
      }
      if (line.indent === fieldIndent) {
        if (isDashItem(line.text)) {
          throw new WorkflowParseError(
            "bad-step",
            `第 ${line.no} 行：列表项不属于任何字段「${line.text}」`,
          );
        }
        pos = registerField(line, pos + 1);
      } else {
        throw new WorkflowParseError(
          "bad-indent",
          `第 ${line.no} 行：意外深层缩进「${line.text}」（未被任何字段收养）`,
        );
      }
    }

    const id = scalarString(fields.get("id"), "id", head.no);
    const run = scalarString(fields.get("run"), "run", head.no);

    const depsField = fields.get("depends_on");
    let depends_on: string[] = [];
    if (depsField !== undefined) {
      if (depsField.raw === "") {
        for (const child of depsField.children) {
          if (!isDashItem(child.text)) {
            throw new WorkflowParseError(
              "bad-step",
              `第 ${child.no} 行：depends_on 块子节点须为 "- 项" 形态，出现「${child.text}」`,
            );
          }
          const item = child.text === "-" ? "" : child.text.slice(2).trim();
          const v = parseScalar(item, `第 ${child.no} 行 depends_on 项`);
          if (typeof v !== "string" || v.length === 0) {
            throw new WorkflowParseError(
              "bad-step",
              `第 ${child.no} 行：depends_on 项须为非空字符串`,
            );
          }
          depends_on.push(v);
        }
      } else {
        const m = /^\[(.*)\]$/.exec(depsField.raw);
        if (m === null) {
          throw new WorkflowParseError(
            "bad-step",
            `第 ${depsField.no} 行：depends_on 内联形态须为 [a, b]（完整 YAML 归后续增强）`,
          );
        }
        const body = m[1] ?? "";
        depends_on = body.length === 0 ? [] : body.split(",").map((piece) => {
          const v = parseScalar(piece, `第 ${depsField.no} 行 depends_on 项`);
          if (typeof v !== "string" || v.length === 0) {
            throw new WorkflowParseError(
              "bad-step",
              `第 ${depsField.no} 行：depends_on 项须为非空字符串`,
            );
          }
          return v;
        });
      }
    }

    const paramsField = fields.get("params");
    let params: Record<string, JsonValue> = {};
    if (paramsField !== undefined) {
      if (paramsField.raw === "") {
        for (const child of paramsField.children) {
          if (isDashItem(child.text)) {
            throw new WorkflowParseError(
              "unsupported-param",
              `第 ${child.no} 行：params 暂不支持列表值（完整 YAML 归后续增强）`,
            );
          }
          const ci = child.text.indexOf(":");
          if (ci <= 0) {
            throw new WorkflowParseError(
              "bad-field",
              `第 ${child.no} 行：params 项须为 "key: value" 形态`,
            );
          }
          const k = child.text.slice(0, ci).trim();
          params[k] = parseScalar(child.text.slice(ci + 1), `第 ${child.no} 行参数 "${k}"`);
        }
      } else if (paramsField.raw === "{}") {
        params = {};
      } else {
        throw new WorkflowParseError(
          "unsupported-param",
          `第 ${paramsField.no} 行：params 暂只支持块映射与 {}（完整 YAML 归后续增强）`,
        );
      }
    }

    steps.push({ id, run, depends_on, params });
    i = pos;
  }

  if (steps.length === 0) {
    throw new WorkflowParseError("empty-steps", "steps 下至少需要一个步骤条目");
  }
  const byId = new Map<string, WorkflowStep>();
  for (const s of steps) {
    if (byId.has(s.id)) {
      throw new WorkflowParseError("duplicate-step", `步骤 id "${s.id}" 重复`);
    }
    byId.set(s.id, s);
  }
  for (const s of steps) {
    for (const d of s.depends_on) {
      if (!byId.has(d)) {
        throw new WorkflowParseError(
          "unknown-dep",
          `步骤 "${s.id}" 依赖不存在的步骤 "${d}"`,
        );
      }
    }
  }
  assertAcyclic(steps);
  return { steps };
}

/** Kahn 计数判环：拓扑收不满即有环，报 cycle-detected（附卡死步骤）。 */
function assertAcyclic(steps: readonly WorkflowStep[]): void {
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const s of steps) {
    indeg.set(s.id, s.depends_on.length);
    for (const d of s.depends_on) {
      const list = dependents.get(d);
      if (list === undefined) dependents.set(d, [s.id]);
      else list.push(s.id);
    }
  }
  let frontier = steps.filter((s) => s.depends_on.length === 0).map((s) => s.id);
  const done = new Set<string>();
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      done.add(id);
      for (const dep of dependents.get(id) ?? []) {
        const left = (indeg.get(dep) ?? 0) - 1;
        indeg.set(dep, left);
        if (left === 0) next.push(dep);
      }
    }
    frontier = next;
  }
  if (done.size < steps.length) {
    const stuck = steps.map((s) => s.id).filter((id) => !done.has(id));
    throw new WorkflowParseError(
      "cycle-detected",
      `依赖图存在环，卡死步骤: ${stuck.join(", ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// wf-step 任务协议（引擎 × DurableScheduler 的接缝载荷）
// ---------------------------------------------------------------------------

/** 步骤任务的 kind（工单钉死 'wf-step'）。 */
export const WF_STEP_KIND = "wf-step";

/** 每步执行段上限：1 段真实执行 + 1 段崩溃重放余量（两次崩溃 = failed 终态防死循环）。 */
export const STEP_MAX_ATTEMPTS = 2;

/** 步骤任务确定性 id：重启续跑 / 幂等重跑都靠它寻址。 */
export function stepTaskId(workflowId: string, stepId: string): string {
  return `wf:${workflowId}:${stepId}`;
}

/** wf-step 任务载荷（submit 时的 checkpoint；全部 JsonValue 可落盘）。 */
export type WfStepTaskPayload = {
  workflowId: string;
  stepId: string;
  run: string;
  params: Record<string, JsonValue>;
  dependsOn: string[];
  results: Record<string, JsonValue>;
};

/** 步骤结果信封（completed checkpoint 的形体）：ok=true 带返回值，ok=false 带错误文案。 */
export type StepOutcome = { ok: true; value: JsonValue } | { ok: false; error: string };

/** 用户侧步骤 handler：接收步骤载荷，返回值经 JSON 往返规范化后落 checkpoint。 */
export type StepHandler = (payload: StepPayload) => unknown | Promise<unknown>;

/** 传给用户 handler 的载荷：直接依赖的输出按依赖 id 注入 results。 */
export interface StepPayload {
  workflowId: string;
  step: WorkflowStep;
  results: Record<string, JsonValue>;
}

function readWfStepPayload(value: JsonValue): WfStepTaskPayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const r = value as Record<string, JsonValue>;
  if (typeof r.workflowId !== "string" || typeof r.stepId !== "string" || typeof r.run !== "string") {
    return null;
  }
  const { params, results, dependsOn } = r;
  if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
  if (typeof results !== "object" || results === null || Array.isArray(results)) return null;
  if (!Array.isArray(dependsOn) || !dependsOn.every((x) => typeof x === "string")) return null;
  return {
    workflowId: r.workflowId,
    stepId: r.stepId,
    run: r.run,
    params: params as Record<string, JsonValue>,
    dependsOn: dependsOn as string[],
    results: results as Record<string, JsonValue>,
  };
}

/** 把 handler 返回值规范化为结果信封：任何路径都不抛错（异常折进 ok:false）。 */
async function wfStepOutcome(
  checkpoint: JsonValue,
  handlers: Record<string, StepHandler>,
): Promise<StepOutcome> {
  const payload = readWfStepPayload(checkpoint);
  if (payload === null) {
    return { ok: false, error: "wf-step 载荷不合法（缺 workflowId/stepId/run/params/results）" };
  }
  const handler = handlers[payload.run];
  if (handler === undefined) {
    return {
      ok: false,
      error: `步骤 "${payload.stepId}" 未注册 run handler "${payload.run}"`,
    };
  }
  try {
    const out = await handler({
      workflowId: payload.workflowId,
      step: {
        id: payload.stepId,
        run: payload.run,
        depends_on: payload.dependsOn,
        params: payload.params,
      },
      results: payload.results,
    });
    if (isSuspendSignal(out)) {
      return {
        ok: false,
        error: `步骤 "${payload.stepId}" 返回值与调度器挂起协议冲突（done:false + checkpoint 形体），拒绝作为步骤结果`,
      };
    }
    if (out === undefined) return { ok: true, value: null };
    const value = JSON.parse(JSON.stringify(out)) as JsonValue;
    return { ok: true, value };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: `步骤 "${payload.stepId}" 执行失败：${message}` };
  }
}

/**
 * 装配接缝：把用户 handler 表适配为 DurableScheduler 的 kind='wf-step' handler。
 * 适配器永不抛错（异常折为 ok:false 信封），因此引擎步骤永不触发调度器退避
 * 重试路径；调度器级 failed 只会来自崩溃重放额度耗尽。
 */
export function makeWfStepHandler(handlers: Record<string, StepHandler>): TaskHandler {
  return async (task: TaskRecord): Promise<JsonValue> => await wfStepOutcome(task.checkpoint, handlers);
}

/** 校验 checkpoint 是否为步骤结果信封（防御手工篡改库内记录）。 */
export function asOutcome(checkpoint: JsonValue): StepOutcome {
  if (typeof checkpoint === "object" && checkpoint !== null && !Array.isArray(checkpoint)) {
    const ok = (checkpoint as { ok?: unknown }).ok;
    if (ok === true && "value" in checkpoint) {
      return { ok: true, value: (checkpoint as { value: JsonValue }).value };
    }
    const error = (checkpoint as { error?: unknown }).error;
    if (ok === false && typeof error === "string") {
      return { ok: false, error };
    }
  }
  return {
    ok: false,
    error: `checkpoint 非步骤结果信封：${JSON.stringify(checkpoint)}`,
  };
}

// ---------------------------------------------------------------------------
// DagEngine
// ---------------------------------------------------------------------------

export interface DagEngineOptions {
  /** 复用 durable/ 的持久化调度器（接缝①）：submit / scheduleAt / recover 全走它。 */
  scheduler: DurableScheduler;
  /** 用户步骤 handler 表（键 = 步骤的 run 名）。 */
  handlers: Record<string, StepHandler>;
  /** 时钟注入（建议与 scheduler 同源；缺省 Date.now）。 */
  clock?: () => number;
}

export interface RunResult {
  workflowId: string;
  status: "completed" | "failed";
  /** 成功步骤的返回值（按步骤 id）。 */
  outputs: Record<string, JsonValue>;
  /** 首个失败步骤（层序遍历意义下的第一个；无失败为 null）。 */
  failedStep: string | null;
  /** 首个失败的错误文案。 */
  error: string | null;
  /** 被跳过的步骤 id（层序遍历顺序）：上游失败/跳过的传递闭包。 */
  skipped: string[];
}

/** 一次分层驱动中单步骤的处理结果（引擎内部汇聚用）。 */
interface StepDrive {
  readonly id: string;
  readonly skipped: boolean;
  readonly outcome: StepOutcome | null;
}

/**
 * 声明式 DAG 工作流调度引擎：拓扑分层 + 同层并行 + checkpoint 落库 + 断点自愈。
 */
export class DagEngine {
  readonly #scheduler: DurableScheduler;
  readonly #handlers: Record<string, StepHandler>;
  readonly #now: () => number;
  #active = false;

  constructor(options: DagEngineOptions) {
    this.#scheduler = options.scheduler;
    this.#handlers = options.handlers;
    this.#now = options.clock ?? Date.now;
  }

  /** 底层存储（观测/测试断言用；引擎自身不私建任何存储）。 */
  get store(): DurableScheduler["store"] {
    return this.#scheduler.store;
  }

  /**
   * 运行（或续跑）一个工作流：分层调度至收敛。幂等——确定性任务 id + 已完成
   * 短路，重入同 workflowId 不会重复执行已完成步骤；失败不抛（结构化 RunResult），
   * 仅规格错误（环/空/未知依赖）以 WorkflowParseError 抛出。
   */
  async run(workflowId: string, spec: WorkflowSpec): Promise<RunResult> {
    return await this.#driveWorkflow(workflowId, spec);
  }

  /**
   * 断点自愈：先复用 BI-14.5 scheduler.recover() 清理 running 孤儿（默认 replay
   * 策略回 pending），再走与 run() 相同的分层驱动通路续跑至收敛。
   */
  async recover(workflowId: string, spec: WorkflowSpec): Promise<RunResult> {
    if (this.#active) {
      throw new WorkflowError(
        "engine-busy",
        "同一 DagEngine 实例禁止并发 run()/recover()",
      );
    }
    await this.#scheduler.recover();
    return await this.#driveWorkflow(workflowId, spec);
  }

  async #driveWorkflow(workflowId: string, spec: WorkflowSpec): Promise<RunResult> {
    if (this.#active) {
      throw new WorkflowError(
        "engine-busy",
        "同一 DagEngine 实例禁止并发 run()/recover()（先等前一次收敛）",
      );
    }
    this.#active = true;
    try {
      if (workflowId.length === 0) {
        throw new WorkflowParseError("bad-workflow-id", "workflowId 不可为空");
      }
      if (spec.steps.length === 0) {
        throw new WorkflowParseError("empty-steps", "工作流至少需要一个步骤");
      }
      const layers = buildLayers(spec.steps);
      const byId = new Map(spec.steps.map((s) => [s.id, s]));
      const outputs: Record<string, JsonValue> = {};
      const blocked = new Set<string>();
      const skipped: string[] = [];
      let failedStep: string | null = null;
      let error: string | null = null;

      for (const layer of layers) {
        const drives = await Promise.all(
          layer.map(async (id): Promise<StepDrive> => {
            const step = byId.get(id)!;
            if (step.depends_on.some((d) => blocked.has(d))) {
              return { id: step.id, skipped: true, outcome: null };
            }
            const results: Record<string, JsonValue> = {};
            for (const d of step.depends_on) {
              const upstream = outputs[d];
              if (upstream !== undefined) results[d] = upstream;
            }
            const outcome = await this.#driveStep(workflowId, step, results);
            return { id: step.id, skipped: false, outcome };
          }),
        );
        for (const drive of drives) {
          if (drive.skipped) {
            blocked.add(drive.id);
            skipped.push(drive.id);
            continue;
          }
          const outcome = drive.outcome;
          if (outcome === null) continue;
          if (outcome.ok) {
            outputs[drive.id] = outcome.value;
          } else {
            blocked.add(drive.id);
            if (failedStep === null) {
              failedStep = drive.id;
              error = outcome.error;
            }
          }
        }
      }

      return {
        workflowId,
        status: failedStep === null ? "completed" : "failed",
        outputs,
        failedStep,
        error,
        skipped,
      };
    } finally {
      this.#active = false;
    }
  }

  /**
   * 驱动单个步骤到终态并取回结果信封：
   * - 无记录 → submit（kind='wf-step'，maxAttempts=STEP_MAX_ATTEMPTS）；
   * - completed → 直接取库内 checkpoint 信封（重启续跑 / 幂等重跑 / 跨实例
   *   观察的短路路径——不依赖任何实例内存 waiter）；
   * - pending → 同步认领（get→assertTransition→put）后执行用户 handler，
   *   状态守卫收尾；
   * - failed / suspended / running → 结构化拒绝（各自对应重放耗尽 / 协议外 /
   *   并发驱动未先 recover）。
   */
  async #driveStep(
    workflowId: string,
    step: WorkflowStep,
    results: Record<string, JsonValue>,
  ): Promise<StepOutcome> {
    const id = stepTaskId(workflowId, step.id);
    const store = this.#scheduler.store;
    let record = store.get(id);
    if (record === null) {
      const payload: JsonValue = {
        workflowId,
        stepId: step.id,
        run: step.run,
        params: step.params ?? {},
        dependsOn: step.depends_on,
        results,
      };
      this.#scheduler.submit(WF_STEP_KIND, payload, { id, maxAttempts: STEP_MAX_ATTEMPTS });
      record = store.get(id);
    }
    if (record === null) {
      return { ok: false, error: `步骤任务 ${id} 提交后不可见（存储异常）` };
    }
    if (record.state === "completed") return asOutcome(record.checkpoint);
    if (record.state === "failed") {
      return {
        ok: false,
        error: `步骤任务 ${id} 已处 failed 终态（崩溃重放额度耗尽），续跑拒绝`,
      };
    }
    if (record.state === "suspended") {
      return { ok: false, error: `步骤任务 ${id} 处于 suspended：引擎步骤不支持挂起语义` };
    }
    if (record.state === "running") {
      return {
        ok: false,
        error: `步骤任务 ${id} 处于 running：请先 recover() 清理崩溃孤儿，并避免并发驱动同一工作流`,
      };
    }
    // pending：同步认领（get→assert→put 单线程无插队窗口），随后并发执行
    assertTransition(record.state, "running");
    const claimed: TaskRecord = {
      ...record,
      state: "running",
      attempts: record.attempts + 1,
      updatedAt: this.#now(),
    };
    store.put(claimed);
    const outcome = await wfStepOutcome(record.checkpoint, this.#handlers);
    return this.#finishStep(id, outcome);
  }

  /**
   * 状态守卫收尾：仅当库内仍为 running（本驱动者的认领未被他人收尾）才写
   * completed，写后返回本次结果；否则以库内权威 checkpoint 回读（跨实例安全：
   * 终态可能已被共享 store 上的其他驱动者写下，内存 waiter 不跨实例汇聚）。
   */
  #finishStep(id: string, outcome: StepOutcome): StepOutcome {
    const store = this.#scheduler.store;
    const current = store.get(id);
    if (current === null) return outcome;
    if (current.state === "running") {
      assertTransition("running", "completed");
      store.put({ ...current, state: "completed", checkpoint: outcome, updatedAt: this.#now() });
      return outcome;
    }
    if (current.state === "completed") return asOutcome(current.checkpoint);
    if (current.state === "failed") {
      return {
        ok: false,
        error: `步骤任务 ${id} 已处 failed 终态（崩溃重放额度耗尽），续跑拒绝`,
      };
    }
    return outcome;
  }
}

/**
 * 拓扑分层（Kahn）：第 k 层 = 依赖恰在 <k 层全部完成的步骤集合；层内成员保持
 * 声明顺序（确定性）。规格不合法（重复 id / 未知依赖 / 环）→ 结构化抛出。
 */
function buildLayers(steps: readonly WorkflowStep[]): string[][] {
  const byId = new Map<string, WorkflowStep>();
  for (const s of steps) {
    if (byId.has(s.id)) {
      throw new WorkflowParseError("duplicate-step", `步骤 id "${s.id}" 重复`);
    }
    byId.set(s.id, s);
  }
  for (const s of steps) {
    for (const d of s.depends_on) {
      if (!byId.has(d)) {
        throw new WorkflowParseError("unknown-dep", `步骤 "${s.id}" 依赖不存在的步骤 "${d}"`);
      }
    }
  }
  assertAcyclic(steps);
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const s of steps) {
    indeg.set(s.id, s.depends_on.length);
    for (const d of s.depends_on) {
      const list = dependents.get(d);
      if (list === undefined) dependents.set(d, [s.id]);
      else list.push(s.id);
    }
  }
  const layers: string[][] = [];
  let frontier = steps.filter((s) => s.depends_on.length === 0).map((s) => s.id);
  while (frontier.length > 0) {
    layers.push(frontier);
    const next: string[] = [];
    for (const id of frontier) {
      for (const dep of dependents.get(id) ?? []) {
        const left = (indeg.get(dep) ?? 0) - 1;
        indeg.set(dep, left);
        if (left === 0) next.push(dep);
      }
    }
    frontier = next;
  }
  return layers;
}
