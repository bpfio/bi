/**
 * BI-16 · Python 沙箱代码运行即验与 Traceback 自愈。
 *
 * 设计要点：
 * - `runPython` 以本机 `python3 -I -c <code>` 运行（-I 隔离模式：忽略 PYTHON* 环境变量、
 *   不加载用户 site-packages、不把 cwd 加进 sys.path），纯计算用途，零真实网络依赖。
 * - stdout/stderr 有界捕获（`maxOutputBytes`，默认 1 MiB/流），超出部分截断并打标。
 * - `PySandboxError` 结构化三分类：spawn-failed / timeout / python-missing。
 *   runPython 本身在基础设施故障时抛错；`selfHealLoop` 内部将其转换为结构化
 *   PyRunResult（`error` 字段），保证自愈环"结构化、不抛"。
 * - RULE-BI-02 落地：数值结论必须以 stdout 为唯一事实依据——`verify(stdout, expect)`
 *   就是"运行即验"的门：代码说了什么不算数，stdout 打印出来的才算数。
 *
 * @module
 */

/** PySandboxError 三分类错误码。 */
export type PySandboxErrorCode = "spawn-failed" | "timeout" | "python-missing";

/** Python 沙箱基础设施故障（spawn 失败 / 超时 / python3 缺失）。 */
export class PySandboxError extends Error {
  readonly code: PySandboxErrorCode;
  /** 超时场景下已捕获的部分 stdout（可能为空：Python 默认管道缓冲）。 */
  readonly partialStdout: string;
  /** 超时场景下已捕获的部分 stderr。 */
  readonly partialStderr: string;

  constructor(
    code: PySandboxErrorCode,
    message: string,
    opts?: { partialStdout?: string; partialStderr?: string; cause?: unknown },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "PySandboxError";
    this.code = code;
    this.partialStdout = opts?.partialStdout ?? "";
    this.partialStderr = opts?.partialStderr ?? "";
  }
}

export interface PyRunResult {
  /** exitCode === 0 且无基础设施故障。 */
  ok: boolean;
  stdout: string;
  stderr: string;
  /** 进程退出码；被信号杀死或未及退出时为 null。 */
  exitCode: number | null;
  durationMs: number;
  /** stderr 中的 Traceback 块（自 "Traceback (most recent call last):" 起至末尾）。 */
  traceback?: string;
  /** stdout 超出 maxOutputBytes 被截断。 */
  stdoutTruncated?: boolean;
  /** stderr 超出 maxOutputBytes 被截断。 */
  stderrTruncated?: boolean;
  /**
   * 仅由 selfHealLoop 填充：runPython 抛出的基础设施故障被转换后的结构化信息
   * （runPython 本身抛 PySandboxError，自愈环内部转为该字段，保证不抛）。
   */
  error?: { code: PySandboxErrorCode; message: string };
}

export interface PyRunOptions {
  /** 子进程工作目录（可注入）。默认继承当前进程。 */
  cwd?: string;
  /** 超时毫秒数（可注入），超时 kill -9。默认 10_000。 */
  timeoutMs?: number;
  /** stdout/stderr 各自的捕获字节上限（有界捕获）。默认 1 MiB。 */
  maxOutputBytes?: number;
  /** python 可执行文件路径，默认 "python3"（测试可注入探测故障）。 */
  pythonPath?: string;
  /** 附加环境变量（覆盖继承的同名项）。注意 -I 模式下 PYTHON* 一律被忽略。 */
  env?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * 运行一段 Python 纯计算代码：`python3 -I -c <code>`。
 *
 * 基础设施故障抛 {@link PySandboxError}：
 * - `python-missing`：python3 可执行文件不存在（降级说明：宿主未装 python3，沙箱不可用）；
 * - `timeout`：超过 timeoutMs，进程被 kill -9（partialStdout/partialStderr 携带已捕获部分；
 *   注意 Python 管道输出默认全缓冲，超时时 stdout 可能为空）;
 * - `spawn-failed`：其余 spawn 失败。
 *
 * 代码本身跑挂（非零退出 / Traceback）不抛错——那是正常的 PyRunResult（ok=false）。
 */
export async function runPython(code: string, opts?: PyRunOptions): Promise<PyRunResult> {
  const pythonPath = opts?.pythonPath ?? "python3";
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = opts?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  const t0 = performance.now();
  try {
    proc = Bun.spawn([pythonPath, "-I", "-c", code], {
      cwd: opts?.cwd,
      // 直接 exec、不经 shell；stdin 关闭避免脚本等待输入。
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: opts?.env === undefined ? undefined : { ...process.env, ...opts.env },
    });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    const missing =
      e?.code === "ENOENT" || (typeof e?.message === "string" && /ENOENT|Executable not found|not found/i.test(e.message));
    if (missing) {
      throw new PySandboxError(
        "python-missing",
        `python3 unavailable: executable "${pythonPath}" not found on this host; ` +
          `python sandbox degrades to unavailable (install python3 to enable run-to-verify).`,
        { cause: err },
      );
    }
    throw new PySandboxError("spawn-failed", `failed to spawn ${pythonPath}: ${e?.message ?? String(err)}`, {
      cause: err,
    });
  }

  const stdoutRead = readBounded(proc.stdout, maxOutputBytes);
  const stderrRead = readBounded(proc.stderr, maxOutputBytes);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill(9);
    } catch {
      /* 进程可能已退出 */
    }
  }, timeoutMs);

  let stdout: { text: string; truncated: boolean };
  let stderr: { text: string; truncated: boolean };
  let exitCode: number | null;
  try {
    [stdout, stderr, exitCode] = await Promise.all([stdoutRead, stderrRead, proc.exited]);
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) {
    throw new PySandboxError(
      "timeout",
      `python sandbox run timed out after ${timeoutMs}ms and was killed (SIGKILL)`,
      { partialStdout: stdout.text, partialStderr: stderr.text },
    );
  }

  const result: PyRunResult = {
    ok: exitCode === 0,
    stdout: stdout.text,
    stderr: stderr.text,
    exitCode,
    durationMs: performance.now() - t0,
  };
  const traceback = extractTraceback(stderr.text);
  if (traceback !== undefined) result.traceback = traceback;
  if (stdout.truncated) result.stdoutTruncated = true;
  if (stderr.truncated) result.stderrTruncated = true;
  return result;
}

/** 有界读取一个字节流：超出 cap 的字节被丢弃并打截断标（进程自然跑完，不因截断被杀）。 */
async function readBounded(
  stream: ReadableStream<Uint8Array>,
  cap: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes >= cap) {
      truncated = true;
      continue;
    }
    const room = cap - bytes;
    if (value.length <= room) {
      text += decoder.decode(value, { stream: true });
      bytes += value.length;
    } else {
      text += decoder.decode(value.subarray(0, room), { stream: true });
      bytes = cap;
      truncated = true;
    }
  }
  text += decoder.decode();
  return { text, truncated };
}

function extractTraceback(stderr: string): string | undefined {
  const idx = stderr.indexOf("Traceback (most recent call last):");
  if (idx !== -1) {
    const block = stderr.slice(idx).trimEnd();
    return block.length > 0 ? block : undefined;
  }
  // Python 3.13+ 的语法错误为短格式：无 Traceback 头，直接以 `File "<string>", line N` 开头。
  const m = /^[ \t]*File "<[^"]*>", line \d+/m.exec(stderr);
  if (m !== null) {
    const block = stderr.slice(m.index).trimEnd();
    return block.length > 0 ? block : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// verify —— 运行即验的门（RULE-BI-02）
// ---------------------------------------------------------------------------

/** 数值容差 matcher。 */
export interface PyNumberExpect {
  kind: "number";
  /** 期望数值（唯一事实依据来自 stdout 提取）。 */
  expected: number;
  /** 容差，默认 0（精确相等，含浮点字面量相等）。 */
  tolerance?: number;
  /** true 时 tolerance 按 expected 的相对比例解释：|x - expected| <= tolerance * |expected|。 */
  relative?: boolean;
  /** 数值提取正则（捕获组 1 为数字）。缺省：stdout 整体可解析为数字，否则取首个数字 token。 */
  pattern?: string | RegExp;
}

/** 单条期望：字符串=子串；RegExp=正则；对象=数值容差。 */
export type PyExpectItem = string | RegExp | PyNumberExpect;
/** 期望集：单条或数组（数组须全部通过）。 */
export type PyExpect = PyExpectItem | PyExpectItem[];

export type PyVerifyOutcome = { passed: true } | { passed: false; gap: string };

const NUMBER_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const NUMBER_TOKEN_RE = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/;

/**
 * 对 stdout 做期望断言（纯同步、零 I/O）。这是 RULE-BI-02 的落地门：
 * 数值结论只认 stdout，不认代码或模型口头声明。
 *
 * - 子串：`expect("3")` —— stdout.includes；
 * - 正则：`expect(/^1060$/m)` 或 `{ kind: "regex", ... }` 形式的 RegExp；
 * - 数值容差：`{ kind: "number", expected: 3.14, tolerance: 0.01 }`，
 *   可用 `pattern` 指定捕获组提取，缺省整段解析或首个数字 token。
 *
 * 不合 → `{ passed: false, gap }`，gap 为人读差异描述；数组期望取首条失败。
 */
export function verify(stdout: string, expect: PyExpect): PyVerifyOutcome {
  const items = Array.isArray(expect) ? expect : [expect];
  for (const item of items) {
    const outcome = verifyItem(stdout, item);
    if (!outcome.passed) return outcome;
  }
  return { passed: true };
}

function verifyItem(stdout: string, item: PyExpectItem): PyVerifyOutcome {
  if (typeof item === "string") {
    return stdout.includes(item)
      ? { passed: true }
      : { passed: false, gap: `substring mismatch: stdout does not contain ${JSON.stringify(item)}` };
  }
  if (item instanceof RegExp) {
    return item.test(stdout)
      ? { passed: true }
      : { passed: false, gap: `regex mismatch: /${item.source}/${item.flags} did not match stdout` };
  }
  // PyNumberExpect
  const actual = extractNumber(stdout, item.pattern);
  if (actual === undefined) {
    return {
      passed: false,
      gap: `number mismatch: no numeric value extractable from stdout${
        item.pattern ? ` with pattern ${String(item.pattern)}` : ""
      }`,
    };
  }
  const tolerance = item.tolerance ?? 0;
  const limit = item.relative === true ? Math.abs(tolerance * item.expected) : Math.abs(tolerance);
  const diff = Math.abs(actual - item.expected);
  if (diff <= limit) return { passed: true };
  return {
    passed: false,
    gap:
      `number mismatch: expected ${formatNum(item.expected)} ± ${formatNum(limit)}` +
      `${item.relative === true ? " (relative)" : ""}, got ${formatNum(actual)} (diff ${formatNum(diff)})`,
  };
}

function extractNumber(stdout: string, pattern?: string | RegExp): number | undefined {
  if (pattern !== undefined) {
    const re = typeof pattern === "string" ? new RegExp(pattern) : pattern;
    const m = re.exec(stdout);
    const raw = m?.[1];
    if (raw === undefined) return undefined;
    const v = Number(raw.trim());
    return Number.isFinite(v) ? v : undefined;
  }
  const trimmed = stdout.trim();
  if (NUMBER_RE.test(trimmed)) return Number(trimmed);
  const token = NUMBER_TOKEN_RE.exec(stdout);
  if (token === null) return undefined;
  const v = Number(token[0]);
  return Number.isFinite(v) ? v : undefined;
}

function formatNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toPrecision(12).replace(/\.?0+$/, "");
}

// ---------------------------------------------------------------------------
// selfHealLoop —— 运行→verify→回注修复→重跑
// ---------------------------------------------------------------------------

/** 自愈任务：初始代码 + 期望门 + 可选修复回调。 */
export interface PySelfHealTask {
  code: string;
  /** 期望门（同 verify 语义），对每轮 stdout 断言。 */
  verify: (stdout: string, run: PyRunResult) => PyVerifyOutcome;
  /**
   * 修复回调（注入点，模拟模型改码）：拿到失败轮的 stdout/stderr/traceback/gap，
   * 返回下一轮代码。缺省时无修复能力，首轮不过即止。
   */
  repair?: (feedback: PyRepairFeedback) => string | Promise<string>;
  /** 每轮 runPython 的运行参数（超时/上限/cwd 可注入）。 */
  runOpts?: PyRunOptions;
}

/** 回注给 repair 的失败现场。 */
export interface PyRepairFeedback {
  /** 失败轮次（1 起）。 */
  attempt: number;
  /** 该轮运行的代码。 */
  code: string;
  /** 该轮结构化运行结果（stdout/stderr/traceback/error 齐全）。 */
  run: PyRunResult;
  /** verify 差距描述（verify 通过时不会进入 repair）。 */
  gap: string;
}

export interface PySelfHealOutcome {
  healed: boolean;
  /** 实际执行轮数（含成功轮）。 */
  rounds: number;
  lastResult: PyRunResult;
  history: Array<{ round: number; code: string; run: PyRunResult; verify: PyVerifyOutcome }>;
  /** 仅在异常终止时出现（如 repair 回调抛错 / 返回空代码）。 */
  note?: string;
}

/**
 * { code, verify } 自愈环：运行 → verify 不过 → 把 stdout/stderr/traceback/gap 回注给
 * repair → 重跑；最多 maxRounds 轮。全程结构化、不抛：
 *
 * - verify 通过 → `{ healed: true, rounds, lastResult }`；
 * - maxRounds 用尽仍不过 → `{ healed: false, rounds, lastResult, history }`；
 * - 基础设施故障（超时/python-missing/spawn-failed）被转换为 `lastResult.error` 继续参与回注；
 * - repair 回调抛错或返回空码 → 记入 note 后终止（同样不抛）。
 *
 * RULE-BI-02：healed=true 的唯一含义是最后一轮 stdout 通过了 verify 门。
 */
export async function selfHealLoop(task: PySelfHealTask, maxRounds = 3): Promise<PySelfHealOutcome> {
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new RangeError(`maxRounds must be a positive integer, got ${maxRounds}`);
  }
  const history: PySelfHealOutcome["history"] = [];
  let code = task.code;

  for (let round = 1; round <= maxRounds; round++) {
    const run = await runToResult(code, task.runOpts);
    let outcome: PyVerifyOutcome;
    try {
      outcome = task.verify(run.stdout, run);
    } catch (err) {
      outcome = { passed: false, gap: `verifier threw: ${err instanceof Error ? err.message : String(err)}` };
    }
    history.push({ round, code, run, verify: outcome });

    if (outcome.passed) {
      return { healed: true, rounds: round, lastResult: run, history };
    }

    const isLastRound = round === maxRounds;
    if (isLastRound || task.repair === undefined) {
      return { healed: false, rounds: round, lastResult: run, history };
    }

    let nextCode: string;
    try {
      nextCode = await task.repair({ attempt: round, code, run, gap: outcome.gap });
    } catch (err) {
      return {
        healed: false,
        rounds: round,
        lastResult: run,
        history,
        note: `repair callback threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (typeof nextCode !== "string" || nextCode.length === 0) {
      return { healed: false, rounds: round, lastResult: run, history, note: "repair returned empty code" };
    }
    code = nextCode;
  }
  // 不可达（循环内必返回）；类型兜底。
  throw new Error("unreachable: selfHealLoop exhausted rounds without returning");
}

/** runPython 的不抛包装：PySandboxError 转为带 error 字段的结构化 PyRunResult。 */
async function runToResult(code: string, opts?: PyRunOptions): Promise<PyRunResult> {
  try {
    return await runPython(code, opts);
  } catch (err) {
    if (err instanceof PySandboxError) {
      return {
        ok: false,
        stdout: err.partialStdout,
        stderr: err.partialStderr,
        exitCode: null,
        durationMs: 0,
        error: { code: err.code, message: err.message },
      };
    }
    return {
      ok: false,
      stdout: "",
      stderr: "",
      exitCode: null,
      durationMs: 0,
      error: { code: "spawn-failed", message: err instanceof Error ? err.message : String(err) },
    };
  }
}
