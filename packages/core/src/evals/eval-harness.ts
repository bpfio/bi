/**
 * BI-21.3 — 确定性无头 Agent 评测套件与基准打分引擎（测试装置）。
 *
 * 与 BI-03.6 的分工（职责边界，勿混淆）：
 * - BI-03.6 影子回放 = 生产轨迹回归校验；权威轨迹 Schema 归 03.6 所有。
 * - 本卡（BI-21.3）= 预编排用例（modelScript 确定性回放序列）的确定性新跑；
 *   五类 Check 断言矩阵与基线对比（eval-report.ts）归本卡。
 * - 两者消费同一 Mock 工具夹具形态：ToolStub = (args) => result。
 *
 * 设计铁律：
 * - 本文件不内建 agent loop。被测系统通过构造函数注入 AgentLoopPort；
 *   本文件只提供机械驱动：虚拟工作区沙箱、脚本化模型喂入、工具 stub 执行与
 *   全量记录、超时中止、逐 Check 断言、有界并发池汇总。
 * - 评测全程零真实 API：模型行为 = ModelTurn 预编排序列回放；工具 = 注入 stub。
 * - 纯命令行执行器形态：被测 loop 是运行在 cwd + 脚本化模型 + stub 工具上的
 *   无头会话；循环策略（何时停、什么是最终输出）全部属于被测系统。
 *
 * Zero external dependencies.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// 用例模型
// ---------------------------------------------------------------------------

/** 虚拟工作区中的一个文件。path 相对沙箱根，禁止 `..` / 绝对路径逃逸。 */
export interface WorkspaceFile {
  path: string;
  content: string;
}

/** 模型在某轮发出的工具调用请求。 */
export interface ToolCallRequest {
  name: string;
  args: unknown;
}

/**
 * 预编排的单轮模型响应（确定性回放，非真实模型）：
 * - toolCalls: 本轮请求执行的工具（由装置经 toolStubs 执行并记录）。
 * - text: 本轮助手文本；最终输出语义由被测 loop 决定（参考实现取最后一轮 text）。
 */
export interface ModelTurn {
  toolCalls?: ToolCallRequest[];
  text?: string;
}

/** Mock 工具夹具形态（与 BI-03.6 共享）。同步或异步返回皆可。 */
export type ToolStub = (args: unknown) => unknown;

export type ToolStubMap = Record<string, ToolStub>;

export type CheckKind =
  | "tool-called"
  | "tool-order"
  | "output-contains"
  | "output-matches"
  | "max-turns";

/**
 * 断言矩阵。id 缺省时自动编号为 `${kind}#${index}`。
 * - tool-called: 名为 name 的工具被调用 minTimes(默认 1)..maxTimes 次。
 * - tool-order: recorded 工具名序列中 expected 按序出现（允许穿插额外调用）。
 * - output-contains: 最终输出包含 text（ignoreCase 可选，默认区分大小写）。
 * - output-matches: 最终输出匹配 pattern（RegExp 源文本 + 可选 flags）。
 * - max-turns: 实际消费的模型轮数 <= limit（软预算；硬墙是 timeoutMs）。
 * 空 expectations 视为冒烟用例（恒过，除非装置级出错）。
 */
export type Check =
  | { kind: "tool-called"; id?: string; name: string; minTimes?: number; maxTimes?: number }
  | { kind: "tool-order"; id?: string; expected: string[] }
  | { kind: "output-contains"; id?: string; text: string; ignoreCase?: boolean }
  | { kind: "output-matches"; id?: string; pattern: string; flags?: string }
  | { kind: "max-turns"; id?: string; limit: number };

/** 用例定义（纯数据；被测 loop 不属于用例数据，经 EvalHarness 构造注入）。 */
export interface EvalCase {
  id: string;
  name: string;
  /** 虚拟工作区：runCase 时写入一次性隔离沙箱目录。 */
  workspace: { files: WorkspaceFile[] };
  /** 注入的 Mock 工具集合。 */
  toolStubs: ToolStubMap;
  /** 预编排模型响应序列（确定性回放）。 */
  modelScript: ModelTurn[];
  /** 逐条断言。 */
  expectations: Check[];
}

// ---------------------------------------------------------------------------
// 注入端口（被测系统 = agent loop 本体）
// ---------------------------------------------------------------------------

/** 装置递给被测 agent loop 的无头会话上下文。 */
export interface AgentLoopContext {
  /** 沙箱工作区绝对路径（虚拟工作区文件已就位）。 */
  cwd: string;
  /** 拉取下一条预编排模型轮；脚本耗尽后返回 null。 */
  nextModelTurn(): Promise<ModelTurn | null>;
  /** 经注入 stub 执行工具并记录调用；未注册工具 / stub 抛错时 reject。 */
  executeTool(name: string, args: unknown): Promise<unknown>;
  /** 超时中止信号；被测 loop 应尽快退出。 */
  signal: AbortSignal;
}

/**
 * 被测系统注入端口（即被测 agent loop）。
 * 合约：消费 nextModelTurn() 直到自行判定会话结束，resolve 最终输出文本。
 */
export type AgentLoopPort = (ctx: AgentLoopContext) => Promise<string>;

// ---------------------------------------------------------------------------
// 结果模型
// ---------------------------------------------------------------------------

/** 一次工具调用的全量记录。 */
export interface ToolCallRecord {
  /** 全局递增序号（从 1 起）。 */
  seq: number;
  /** 发生时已消费的模型轮数（0 = 模型首轮之前的调用）。 */
  turn: number;
  name: string;
  args: unknown;
  result?: unknown;
  error?: string;
  durationMs: number;
}

export interface CheckResult {
  id: string;
  kind: CheckKind;
  pass: boolean;
  detail: string;
}

/** 单用例结果。 */
export interface CaseResult {
  caseId: string;
  caseName: string;
  passed: boolean;
  checks: CheckResult[];
  /** 实际消费的模型轮数。 */
  turns: number;
  durationMs: number;
  toolCalls: ToolCallRecord[];
  /** 被测 loop 的最终输出（装置级出错时为空串）。 */
  output: string;
  /** 装置级错误（超时 / port 抛错 / 沙箱异常）；undefined = 无。 */
  error?: string;
  timedOut?: boolean;
}

export interface TimingStats {
  min: number;
  median: number;
  p95: number;
  max: number;
}

export interface ToolCallFrequency {
  name: string;
  count: number;
}

export interface SuiteReport {
  suiteId: string;
  total: number;
  passed: number;
  failed: number;
  /** 0..1 */
  passRate: number;
  totalMs: number;
  cases: CaseResult[];
  toolCallFreq: ToolCallFrequency[];
  /** 仅供程序化消费；报告渲染一律从 cases 现算，避免双源分歧。 */
  stats: {
    turns: TimingStats | null;
    durationMs: TimingStats | null;
  };
}

// ---------------------------------------------------------------------------
// 统计基元（报告层复用；median/p95 用线性插值，可手算对齐）
// ---------------------------------------------------------------------------

/** 线性插值百分位（PERCENTILE.INC / numpy 'linear'）。sorted 升序，q∈[0,1]。 */
export function percentile(sorted: readonly number[], q: number): number {
  const n = sorted.length;
  if (n === 0) throw new Error("percentile() of empty array");
  if (n === 1) return sorted[0] as number;
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo] as number;
  const frac = pos - lo;
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * frac;
}

/** 空输入返回 null；否则 min/median/p95/max（线性插值）。 */
export function computeTimingStats(values: readonly number[]): TimingStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0] as number,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1] as number,
  };
}

/** 工具调用频次，降序；同频按名称字典序（确定性）。 */
export function computeToolCallFreq(
  cases: ReadonlyArray<Pick<CaseResult, "toolCalls">>,
): ToolCallFrequency[] {
  const counts = new Map<string, number>();
  for (const c of cases) {
    for (const t of c.toolCalls) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
}

// ---------------------------------------------------------------------------
// 装置选项
// ---------------------------------------------------------------------------

export interface RunCaseOptions {
  /** 注入的沙箱父目录；缺省用系统临时目录。每用例仍创建唯一隔离子目录。 */
  sandboxRoot?: string;
  /** 单用例墙钟超时（毫秒）；超时触发 abort 信号并判负。 */
  timeoutMs?: number;
  /** 保留沙箱目录以便调试（默认用后即焚）。 */
  keepSandbox?: boolean;
  /** 覆盖构造时注入的被测端口。 */
  port?: AgentLoopPort;
}

export interface RunSuiteOptions extends Omit<RunCaseOptions, "port"> {
  suiteId?: string;
  /** 有界并发池大小；结果顺序与输入序对齐。默认 4。 */
  concurrency?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CONCURRENCY = 4;

/** 装置内部沙箱句柄。 */
interface SandboxHandle {
  root: string;
  dispose(): Promise<void>;
}

type RaceOutcome =
  | { ok: true; value: string }
  | { ok: false; error: unknown }
  | "timeout";

const DETAIL_OUTPUT_EXCERPT = 200;

// ---------------------------------------------------------------------------
// EvalHarness
// ---------------------------------------------------------------------------

export class EvalHarness {
  private readonly port: AgentLoopPort;

  constructor(port: AgentLoopPort) {
    this.port = port;
  }

  /** 运行单用例：搭沙箱 → 驱动注入端口 → 记录 → 断言。本方法不抛异常。 */
  async runCase(c: EvalCase, opts: RunCaseOptions = {}): Promise<CaseResult> {
    const startedAt = Date.now();
    const toolCalls: ToolCallRecord[] = [];
    let turns = 0;
    let output = "";
    let error: string | undefined;
    let timedOut = false;

    let sandbox: SandboxHandle | undefined;
    try {
      sandbox = await this.createSandbox(c, opts);

      const controller = new AbortController();
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      // 脚本化模型端口：确定性逐轮回放 modelScript。
      const script: readonly ModelTurn[] = c.modelScript ?? [];
      let cursor = 0;
      const nextModelTurn = async (): Promise<ModelTurn | null> => {
        if (controller.signal.aborted) throw new Error("eval aborted (timeout)");
        if (cursor >= script.length) return null;
        const turn = script[cursor] ?? null;
        cursor += 1;
        if (turn !== null) turns += 1;
        return turn;
      };

      // 工具执行器：stub 调用 + 全量记录（含未注册工具与 stub 抛错）。
      const stubs: ToolStubMap = c.toolStubs ?? {};
      const executeTool = async (name: string, args: unknown): Promise<unknown> => {
        const rec: ToolCallRecord = {
          seq: toolCalls.length + 1,
          turn: turns,
          name,
          args,
          durationMs: 0,
        };
        toolCalls.push(rec);
        const t0 = Date.now();
        try {
          const stub = stubs[name];
          if (typeof stub !== "function") {
            rec.error = `unknown tool "${name}" (no stub registered)`;
            throw new Error(rec.error);
          }
          rec.result = await stub(args);
          return rec.result;
        } catch (e) {
          if (rec.error === undefined) {
            rec.error = e instanceof Error ? e.message : String(e);
          }
          throw e instanceof Error ? e : new Error(String(e));
        } finally {
          rec.durationMs = Date.now() - t0;
        }
      };

      const port = opts.port ?? this.port;
      const runPromise = port({
        cwd: sandbox.root,
        nextModelTurn,
        executeTool,
        signal: controller.signal,
      });
      runPromise.catch(() => {}); // 超时获胜时吞掉迟到的 rejection，防 unhandled

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<"timeout">((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout("timeout"), timeoutMs);
      });
      const runOutcome: Promise<RaceOutcome> = runPromise.then(
        (value): RaceOutcome => ({
          ok: true,
          value: typeof value === "string" ? value : String(value ?? ""),
        }),
        (e: unknown): RaceOutcome => ({ ok: false, error: e }),
      );

      const outcome: RaceOutcome = await Promise.race([runOutcome, timeoutPromise]);
      clearTimeout(timer);

      if (outcome === "timeout") {
        timedOut = true;
        error = `case timed out after ${timeoutMs}ms`;
        controller.abort();
      } else if (outcome.ok) {
        output = outcome.value;
      } else {
        error = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      if (sandbox && opts.keepSandbox !== true) {
        await sandbox.dispose().catch(() => {});
      }
    }

    const checks = (c.expectations ?? []).map((chk, i) =>
      evaluateCheck(chk, i, { toolCalls, output, turns, error }),
    );
    const passed = error === undefined && checks.every((r) => r.pass);

    return {
      caseId: c.id,
      caseName: c.name,
      passed,
      checks,
      turns,
      durationMs: Date.now() - startedAt,
      toolCalls,
      output,
      error,
      timedOut,
    };
  }

  /** 运行套件：有界并发池 + 逐案例隔离沙箱；结果按输入序排列。 */
  async runSuite(cases: readonly EvalCase[], opts: RunSuiteOptions = {}): Promise<SuiteReport> {
    const startedAt = Date.now();
    const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_CONCURRENCY));

    // 注入 sandboxRoot 时，套件内再开一层隔离目录，逐案例各得唯一子目录。
    let suiteBase: string | undefined;
    if (opts.sandboxRoot !== undefined) {
      suiteBase = await mkdtemp(join(opts.sandboxRoot, "bi-evals-suite-"));
    }
    const perCase: RunCaseOptions = {};
    if (opts.sandboxRoot !== undefined) perCase.sandboxRoot = suiteBase;
    if (opts.timeoutMs !== undefined) perCase.timeoutMs = opts.timeoutMs;
    if (opts.keepSandbox !== undefined) perCase.keepSandbox = opts.keepSandbox;

    const results: CaseResult[] = new Array(cases.length);
    let nextIdx = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const idx = nextIdx;
        nextIdx += 1;
        const c = cases[idx];
        if (c === undefined) return;
        results[idx] = await this.runCase(c, perCase);
      }
    };
    const poolSize = Math.min(concurrency, Math.max(cases.length, 1));
    await Promise.all(Array.from({ length: poolSize }, () => worker()));

    if (suiteBase !== undefined && opts.keepSandbox !== true) {
      await rm(suiteBase, { recursive: true, force: true }).catch(() => {});
    }

    const passedCount = results.filter((r) => r.passed).length;
    return {
      suiteId: opts.suiteId ?? "eval-suite",
      total: results.length,
      passed: passedCount,
      failed: results.length - passedCount,
      passRate: results.length === 0 ? 0 : passedCount / results.length,
      totalMs: Date.now() - startedAt,
      cases: results,
      toolCallFreq: computeToolCallFreq(results),
      stats: {
        turns: computeTimingStats(results.map((r) => r.turns)),
        durationMs: computeTimingStats(results.map((r) => r.durationMs)),
      },
    };
  }

  /** 建沙箱：注入根目录（或系统临时目录）下 mkdtemp 唯一隔离子目录，写虚拟工作区。 */
  private async createSandbox(c: EvalCase, opts: RunCaseOptions): Promise<SandboxHandle> {
    const files = c.workspace?.files ?? [];
    // 磁盘动作前先做结构校验；逃逸的权威判定在 root 就位后逐文件进行。
    for (const f of files) {
      if (typeof f.path !== "string" || f.path.length === 0) {
        throw new Error("workspace file path must be a non-empty string");
      }
    }
    const ownsBase = opts.sandboxRoot === undefined;
    const base = ownsBase ? await mkdtemp(join(tmpdir(), "bi-evals-")) : (opts.sandboxRoot as string);
    const root = await mkdtemp(join(base, `case-${sanitizeId(c.id)}-`));
    try {
      for (const f of files) {
        const target = resolve(root, f.path);
        if (target !== root && !target.startsWith(root + sep)) {
          throw new Error(`workspace file path escapes sandbox: "${f.path}"`);
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, f.content, "utf8");
      }
    } catch (e) {
      // 写盘阶段任何失败（含逃逸）都必须清掉半成品沙箱，不留垃圾目录。
      await rm(root, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
    return {
      root,
      dispose: async () => {
        await rm(root, { recursive: true, force: true });
        if (ownsBase) await rm(base, { recursive: true, force: true });
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Check 断言矩阵
// ---------------------------------------------------------------------------

function evaluateCheck(
  chk: Check,
  index: number,
  ctx: { toolCalls: readonly ToolCallRecord[]; output: string; turns: number; error?: string },
): CheckResult {
  const id = chk.id ?? `${chk.kind}#${index}`;
  const errPrefix = ctx.error === undefined ? "" : `[case error: ${ctx.error}] `;
  switch (chk.kind) {
    case "tool-called": {
      const count = ctx.toolCalls.filter((t) => t.name === chk.name).length;
      const min = chk.minTimes ?? 1;
      const max = chk.maxTimes;
      const pass = count >= min && (max === undefined || count <= max);
      const range = max === undefined ? `>=${min}` : `${min}..${max}`;
      return {
        id,
        kind: chk.kind,
        pass,
        detail: `${errPrefix}tool "${chk.name}" called ${count} time(s), expected ${range}`,
      };
    }
    case "tool-order": {
      const names = ctx.toolCalls.map((t) => t.name);
      let k = 0;
      for (const n of names) {
        if (k < chk.expected.length && n === chk.expected[k]) k += 1;
      }
      const pass = k >= chk.expected.length;
      return {
        id,
        kind: chk.kind,
        pass,
        detail: pass
          ? `${errPrefix}tool order matched ${JSON.stringify(chk.expected)}`
          : `${errPrefix}expected tool order ${JSON.stringify(chk.expected)}, recorded ${JSON.stringify(names)}`,
      };
    }
    case "output-contains": {
      const hay = chk.ignoreCase ? ctx.output.toLowerCase() : ctx.output;
      const needle = chk.ignoreCase ? chk.text.toLowerCase() : chk.text;
      const pass = hay.includes(needle);
      return {
        id,
        kind: chk.kind,
        pass,
        detail: pass
          ? `output contains ${JSON.stringify(chk.text)}`
          : `${errPrefix}output does not contain ${JSON.stringify(chk.text)}; actual: ${excerpt(ctx.output)}`,
      };
    }
    case "output-matches": {
      let re: RegExp;
      try {
        re = new RegExp(chk.pattern, chk.flags ?? "");
      } catch (e) {
        return {
          id,
          kind: chk.kind,
          pass: false,
          detail: `invalid pattern ${JSON.stringify(chk.pattern)}: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      const pass = re.test(ctx.output);
      return {
        id,
        kind: chk.kind,
        pass,
        detail: pass
          ? `output matches /${chk.pattern}/${chk.flags ?? ""}`
          : `${errPrefix}output does not match /${chk.pattern}/${chk.flags ?? ""}; actual: ${excerpt(ctx.output)}`,
      };
    }
    case "max-turns": {
      const pass = ctx.turns <= chk.limit;
      return {
        id,
        kind: chk.kind,
        pass,
        detail: `${errPrefix}consumed ${ctx.turns} model turn(s), limit ${chk.limit}`,
      };
    }
  }
}

function excerpt(s: string): string {
  if (s.length <= DETAIL_OUTPUT_EXCERPT) return JSON.stringify(s);
  return `${JSON.stringify(s.slice(0, DETAIL_OUTPUT_EXCERPT))}...(len=${s.length})`;
}

function sanitizeId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe.length === 0 ? "case" : safe.slice(0, 64);
}
