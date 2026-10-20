/**
 * BI-14 · `bi dag run <spec.json> [--workflow-id <id>]` 子命令：DAG 工作流调度
 * 引擎（packages/workflow/src 的 DagEngine）的 CLI 面。
 *
 * 引擎器官在库即用；本模块只做「文件 → spec → 引擎 → 分层结果」的外壳：
 *   - spec = WorkflowSpec JSON（{ steps: [{ id, run, depends_on, params }] }）；
 *     结构校验失败复用 WorkflowParseError → exit 2（与引擎同语义）；
 *   - handlers 注册 "shell"：节点 params.command 经 Bun.spawn 执行，超时 / 退出码
 *     结构化回填（{ ok, exitCode, stdout, stderr, timedOut, elapsedMs }）；
 *     非 0 退出码折进结果值（不抛），仅运行时异常才标步骤失败；
 *   - 输出分层调度结果（每步 id / outcome / 耗时），汇总走 stderr；
 *   - store 仅 CLI 进程生命周期：缺省每次调用新建 MemoryDurableStore（轻量内存底座，
 *     取自 workflow 包 durable/storage），测试经 deps.dagStore 注入共享 store 验幂等。
 *
 * 退出码：0 调度收敛（status=completed）/ 1 运行期失败（spec 文件不可读 / 步骤失败）/
 * 2 规格错误（JSON 非法 / 结构非法 / 环 / 未知依赖 / 重复 id）。
 */
import { basename, isAbsolute, join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  DagEngine,
  WorkflowParseError,
  makeWfStepHandler,
  type RunResult,
  type StepHandler,
  type WorkflowSpec,
} from "../../../../workflow/src/engine";
import { DurableScheduler } from "../../../../workflow/src/durable/durable-scheduler";
import { MemoryDurableStore } from "../../../../workflow/src/durable/storage";
import type { DurableStore } from "../../../../workflow/src/durable/storage";
import type { JsonValue } from "../../../../workflow/src/durable/task-state";
import type { SubcommandDeps, SubcommandIo } from "./dispatch";

/** 本模块用法错误（dispatch 按类名兜底捕获 → exit 2）。 */
class SubUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubUsageError";
  }
}

/** shell 步骤执行结果（结构化回填：退出码 / 超时 / 耗时）。 */
export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  elapsedMs: number;
}

/** shell 执行器契约：执行命令串，返回结构化结果（缺省 Bun.spawn 实现）。 */
export type ShellExecutor = (
  command: string,
  opts: { timeoutMs: number },
) => Promise<ShellResult>;

/** 缺省 shell 超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** 消费可读流为文本（进程被 kill 时可能抛错，吞掉返回已缓冲内容）。 */
async function streamToText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (stream === null) return "";
  try {
    return await new Response(stream).text();
  } catch {
    return "";
  }
}

/** 缺省 shell 执行器：经 /bin/sh -c 托管（支持管道/重定向/内建），超时 kill，结构化回填。 */
export const defaultShellExecutor: ShellExecutor = async (command, { timeoutMs }) => {
  const start = Date.now();
  const proc = Bun.spawn(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      /* 进程已退出 */
    }
  }, timeoutMs);
  let exitCode = 0;
  let stdout = "";
  let stderr = "";
  try {
    const [code, out, err] = await Promise.all([
      proc.exited.catch(() => -1),
      streamToText(proc.stdout),
      streamToText(proc.stderr),
    ]);
    exitCode = code;
    stdout = out;
    stderr = err;
  } catch {
    /* 读取流异常：保留已收集内容 */
  } finally {
    clearTimeout(timer);
  }
  return {
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    timedOut,
    elapsedMs: Date.now() - start,
  };
};

/** 注册 "shell" handler：取 params.command 经 sh 执行；非零退出/超时即抛（步骤失败语义）。 */
function makeShellHandler(executor: ShellExecutor): StepHandler {
  return async (payload) => {
    const command = payload.step?.params?.command;
    if (typeof command !== "string" || command.trim() === "") {
      throw new Error(`shell 步骤 "${payload.step?.id ?? "?"}" 缺 command 字段`);
    }
    const result = await executor(command, { timeoutMs: DEFAULT_TIMEOUT_MS });
    if (result.timedOut) {
      throw new Error(`shell 步骤 "${payload.step?.id ?? "?"}" 超时（${DEFAULT_TIMEOUT_MS}ms）`);
    }
    if (result.exitCode !== 0) {
      const tail = result.stderr.trim().slice(0, 200);
      throw new Error(
        `shell 步骤 "${payload.step?.id ?? "?"}" 退出码 ${result.exitCode}${tail ? `: ${tail}` : ""}`,
      );
    }
    return {
      ok: true,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: false,
      elapsedMs: result.elapsedMs,
    };
  };
}

/** 运行 DAG 的可注入依赖（供 CLI 与测试共用；store 可跨次调用共享验幂等）。 */
export interface RunDagDeps {
  /** 持久化存储（缺省新建内存 store；测试注入共享 store）。 */
  store?: DurableStore;
  /** shell 执行器替身（缺省 Bun.spawn；测试注入计数替身）。 */
  shellExecutor?: ShellExecutor;
  /** 时钟（与引擎同源；缺省 Date.now）。 */
  clock?: () => number;
}

/**
 * 运行一个工作流：装配 scheduler（注册 kind='wf-step' handler）+ DagEngine，驱动至收敛。
 * 返回 RunResult（结构化：status / outputs / failedStep / error / skipped）。规格错误
 * （环 / 未知依赖 / 重复 id / 空）由引擎抛 WorkflowParseError，调用方负责映射 exit 2。
 */
export async function runDagWorkflow(
  workflowId: string,
  spec: WorkflowSpec,
  deps: RunDagDeps = {},
): Promise<RunResult> {
  const store: DurableStore = deps.store ?? new MemoryDurableStore();
  const clock = deps.clock ?? Date.now;
  const executor = deps.shellExecutor ?? defaultShellExecutor;
  const handlers: Record<string, StepHandler> = { shell: makeShellHandler(executor) };
  const scheduler = new DurableScheduler({
    store,
    clock,
    handlers: { "wf-step": makeWfStepHandler(handlers) },
  });
  const engine = new DagEngine({ scheduler, handlers, clock });
  return await engine.run(workflowId, spec);
}

/** dag 子命令 argv 解析结果。 */
interface DagArgs {
  positionals: string[];
  flags: Map<string, string>;
}

/** 解析 `bi dag run <spec.json> [--workflow-id <id>]`。 */
function parseDagArgs(rest: readonly string[]): DagArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  let i = 0;
  while (i < rest.length) {
    const token = rest[i];
    i += 1;
    if (token === undefined) break;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const flag = eq === -1 ? token : token.slice(0, eq);
    if (flag !== "--workflow-id") throw new SubUsageError(`未知参数: ${token}`);
    const raw = eq === -1 ? rest[i++] : token.slice(eq + 1);
    if (raw === undefined || raw === "" || raw.startsWith("-")) {
      throw new SubUsageError(`参数 ${flag} 缺少值`);
    }
    if (flags.has(flag)) throw new SubUsageError(`参数重复: ${flag}`);
    flags.set(flag, raw);
  }
  return { positionals, flags };
}

/** 从 spec 路径推导缺省 workflowId（去掉扩展名；无效则 "default"）。 */
function defaultWorkflowId(specPath: string): string {
  const base = basename(specPath);
  const noExt = base.replace(/\.[^.]+$/, "");
  return noExt.length > 0 ? noExt : "default";
}

/** 结构校验 WorkflowSpec JSON（对齐 engine 的 WorkflowStep 字段面）。 */
function validateSpec(raw: unknown): WorkflowSpec {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WorkflowParseError("bad-spec", "spec 必须是含 steps 字段的对象");
  }
  const obj = raw as Record<string, unknown>;
  const steps = obj.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new WorkflowParseError("empty-steps", "spec.steps 至少需一个步骤");
  }
  for (const s of steps) {
    if (typeof s !== "object" || s === null || Array.isArray(s)) {
      throw new WorkflowParseError("bad-step", "步骤须为对象");
    }
    const st = s as Record<string, unknown>;
    if (typeof st.id !== "string" || st.id.length === 0) {
      throw new WorkflowParseError("bad-step", "步骤缺合法 id（非空字符串）");
    }
    if (typeof st.run !== "string" || st.run.length === 0) {
      throw new WorkflowParseError("bad-step", "步骤缺合法 run（非空字符串）");
    }
    if (!Array.isArray(st.depends_on) || !st.depends_on.every((d) => typeof d === "string")) {
      throw new WorkflowParseError("bad-step", "depends_on 须为字符串数组");
    }
  }
  return raw as WorkflowSpec;
}

/**
 * `bi dag run <spec.json> [--workflow-id <id>]`：读 spec → 校验 → 引擎分层调度 →
 * 输出每步 id/outcome/耗时。spec 文件不可读 → exit 1；JSON / 结构 / DAG 规格错误
 * → exit 2；调度失败（步骤失败）→ exit 1。
 */
export async function handleDag(
  rest: readonly string[],
  io: SubcommandIo,
  deps: SubcommandDeps,
): Promise<number> {
  const args = parseDagArgs(rest);
  const action = args.positionals[0];
  if (action !== "run") {
    throw new SubUsageError(`未知 action: ${action ?? "(空)"}（允许: run）`);
  }
  const specPath = args.positionals[1];
  if (specPath === undefined) {
    throw new SubUsageError("用法: bi dag run <spec.json> [--workflow-id <id>]");
  }
  const workflowId = args.flags.get("--workflow-id") ?? defaultWorkflowId(specPath);
  const cwd = deps.cwd ?? process.cwd();
  const absPath = isAbsolute(specPath) ? specPath : join(cwd, specPath);

  let text: string;
  try {
    text = await readFile(absPath, "utf8");
  } catch (cause) {
    io.err(
      `bi dag: 无法读取 spec 文件 ${absPath}（${cause instanceof Error ? cause.message : String(cause)}）`,
    );
    return 1;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    io.err(`bi dag: spec 不是合法 JSON（${cause instanceof Error ? cause.message : String(cause)}）`);
    return 2;
  }

  let spec: WorkflowSpec;
  try {
    spec = validateSpec(parsed);
  } catch (cause) {
    if (cause instanceof WorkflowParseError) {
      io.err(`bi dag: 规格错误 [${cause.code}]: ${cause.message}`);
      return 2;
    }
    throw cause;
  }

  // store/executor 用 runDagWorkflow 内建缺省（MemoryDurableStore + 真实 spawn）；
  // 测试缝合走 runDagWorkflow 的可选 deps 参数，不经 SubcommandDeps。
  const runDeps: RunDagDeps = {};

  let result: RunResult;
  try {
    result = await runDagWorkflow(workflowId, spec, runDeps);
  } catch (cause) {
    if (cause instanceof WorkflowParseError) {
      io.err(`bi dag: 规格错误 [${cause.code}]: ${cause.message}`);
      return 2;
    }
    if (cause instanceof Error) {
      io.err(`bi dag: 运行失败: ${cause.message}`);
      return 1;
    }
    throw cause;
  }

  // 分层调度结果：每步 id / outcome / 耗时（stdout 只出数据）。
  for (const [id, value] of Object.entries(result.outputs)) {
    const elapsed = (value as { elapsedMs?: unknown } | null)?.elapsedMs;
    io.out(
      JSON.stringify({
        step: id,
        outcome: "ok",
        value,
        elapsedMs: typeof elapsed === "number" ? elapsed : null,
      }),
    );
  }
  for (const id of result.skipped) {
    io.out(JSON.stringify({ step: id, outcome: "skipped" }));
  }
  if (result.failedStep !== null) {
    io.out(JSON.stringify({ step: result.failedStep, outcome: "failed", error: result.error }));
  }
  io.err(
    `bi dag: workflow=${workflowId} status=${result.status} ` +
      `steps=${Object.keys(result.outputs).length} skipped=${result.skipped.length}` +
      (result.failedStep !== null ? ` failed=${result.failedStep}` : ""),
  );
  return result.status === "completed" ? 0 : 1;
}
