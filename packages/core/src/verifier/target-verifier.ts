/**
 * BI-21.1 — 任务完工前置自验看门狗（Target Contract Verifier）。
 *
 * 定位：Agent 循环在自称"任务完成"之前必须跑过的最后一道闸。它把"完成"
 * 形式化为 TargetContract（产物清单 + 验收检查），在 verify() 时以磁盘为
 * 唯一真相源重新核验；未通过则产出结构化差距清单（gaps）供调用方回注模型
 * 自愈续跑，对齐工单原文"未通过阻断退出并返回差距清单自愈续跑"。
 *
 * 核心语义（本卡工单钉死，测试逐条钉死防回退）：
 *
 * 1. 防作弊——读盘唯一真相源：
 *    - deliverables 核验全部经 node:fs/promises 的 stat/readFile 真实读盘，
 *      本模块不缓存任何文件内容；同一 verifier 实例对同一 contract 两次
 *      verify 之间文件被删除，第二次必须立即失败（测试钉死）。
 *    - predicate 是调用方注入的纯函数直调，本模块不给它任何内存态产物缓存，
 *      只提供 workspaceRoot / contract 上下文。
 *
 * 2. 防诱导——command 白名单：
 *    - TargetVerifier 只执行 TargetContract.checks 中 verbatim 显式声明的
 *      command 串（isCommandAllowed 即白名单谓词）。
 *    - verify() 在入口对 contract.checks 的命令串做快照冻结，循环内执行前
 *      逐一对照快照：运行期向 contract.checks 夹带新命令 → CommandNotAllowedError
 *      拒绝且该命令绝不触达 runner（测试钉死）。
 *    - 白名单外的任何命令串一律 CommandNotAllowedError，不执行、不降级、
 *      不因 tolerance 而豁免（安全闸，非验收语义）。
 *
 * 3. command 检查：
 *    - 经注入 runner 执行（缺省 node:child_process shell runner），捕获
 *      stdout/stderr，超时可配（缺省 60s），exit 0 且未超时为过。
 *    - 超时与退出码独立断言：timedOut=true 时即使 exitCode=0 也判失败；
 *      非零退出也不得被误报为超时（测试钉死）。
 *    - 缺省 runner 以 error.killed && error.signal === "SIGTERM" 判定超时
 *      （exec timeout 到点杀进程的既有约定）。已知局限：进程被外部 SIGTERM
 *      会被同判为超时——看门狗语义下宁可误报超时也不放过挂死，接受并钉死。
 *
 * 4. tolerance 语义：
 *    - strict（缺省）：command 检查失败（非零退出/超时/runner 抛错）立即以
 *      CommandCheckError 中止 verify（硬失败优先于收集更多 gap）。
 *    - best-effort：command 失败降级为结构化 gap，继续跑完其余检查。
 *    - deliverable 缺失/内容缺失与 predicate 失败在两种模式下都只记 gap
 *      （产物差距本就是"自愈清单"的一部分，无需中止）。
 *
 * 5. gap 结构：{ checkId, expected, actual } 三字段，checkId 对 deliverable
 *    合成为 "deliverable[<i>]:<path>" / "deliverable[<i>].mustContain[<j>]:<path>"，
 *    对 checks 用其声明 id——调用方据此回注模型自愈续跑。
 */
import { exec } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import * as nodePath from "node:path";

/** command 检查缺省限时（毫秒，工单钉死 60s，可配）。 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

/** gap 实际值在格式化输出中的截断上限（字符）。 */
const GAP_DETAIL_MAX_CHARS = 300;

/** A declared artifact of the task. Paths are resolved against the workspace root. */
export interface Deliverable {
  /** Workspace-relative（或绝对）路径。相对路径以 verify() 的 workspaceRoot 解析。 */
  path: string;
  /** true：缺失即 gap；false：缺失被容忍（存在时仍执行 mustContain 核验）。 */
  mustExist: boolean;
  /** 必须逐条命中的子串清单（对文件内容做 includes 子串检查，不做正则）。 */
  mustContain?: string[];
}

/** Context handed to predicate checks. */
export interface CheckContext {
  workspaceRoot: string;
  contract: TargetContract;
}

/** A command-run outcome produced by the injected runner. */
export interface CommandRunOutcome {
  /** 进程退出码；被信号杀死 / runner 抛错时为 null。 */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when the command was killed because it exceeded the time budget. */
  timedOut: boolean;
}

/** Injectable command runner（缺省 node:child_process shell runner，测试注入脚本化假 runner）。 */
export interface CommandRunner {
  run(command: string, opts: { timeoutMs: number; cwd: string }): Promise<CommandRunOutcome>;
}

export type Check =
  | {
      id: string;
      kind: "command";
      /** Command string; must be declared verbatim here to be whitelisted. */
      command: string;
      description: string;
    }
  | {
      id: string;
      kind: "predicate";
      predicate: (ctx: CheckContext) => boolean | Promise<boolean>;
      description: string;
    };

export type CommandCheck = Extract<Check, { kind: "command" }>;
export type PredicateCheck = Extract<Check, { kind: "predicate" }>;

/** The contract describing what "done" means for a task. */
export interface TargetContract {
  /** 原始需求陈述（回注 gap 清单时供模型对齐目标）。 */
  objective: string;
  deliverables: Deliverable[];
  checks: Check[];
  /**
   * strict（缺省）：command 检查失败 → 立即抛 CommandCheckError 中止 verify。
   * best-effort：command 失败降级为结构化 gap，继续跑完其余检查。
   */
  tolerance?: "strict" | "best-effort";
}

/** One structured, self-healable difference between expectation and reality. */
export interface VerificationGap {
  checkId: string;
  expected: string;
  actual: string;
}

export interface VerificationResult {
  passed: boolean;
  gaps: VerificationGap[];
  /** ISO-8601 timestamp of when verification ran. */
  ranAt: string;
  durationMs: number;
}

export interface TargetVerifierOptions {
  /** Defaults to a node:child_process shell runner. */
  runner?: CommandRunner;
  /** Per-command time budget in ms. Default 60_000. */
  commandTimeoutMs?: number;
}

/** Thrown by gateOrThrow when the contract is not satisfied. */
export class TargetIncompleteError extends Error {
  readonly gaps: VerificationGap[];

  constructor(gaps: VerificationGap[]) {
    const first = gaps[0];
    const detail = first ? `; first gap: [${first.checkId}] ${first.actual}` : "";
    super(`target incomplete: ${gaps.length} gap(s)${detail}`);
    this.name = "TargetIncompleteError";
    this.gaps = gaps;
  }
}

/** strict 模式下白名单内 command 检查失败（非零退出/超时/runner 抛错）时抛出。 */
export class CommandCheckError extends Error {
  readonly checkId: string;
  readonly outcome: CommandRunOutcome;

  constructor(checkId: string, outcome: CommandRunOutcome) {
    super(
      `command check "${checkId}" failed (exit=${outcome.exitCode}, timedOut=${outcome.timedOut})`,
    );
    this.name = "CommandCheckError";
    this.checkId = checkId;
    this.outcome = outcome;
  }
}

/** 白名单外命令拒绝——不执行、不降级、不受 tolerance 豁免。 */
export class CommandNotAllowedError extends Error {
  readonly command: string;

  constructor(command: string) {
    super(`command not declared in contract whitelist, refused: ${command}`);
    this.name = "CommandNotAllowedError";
    this.command = command;
  }
}

/** 缺省 runner：node:child_process shell 执行，捕获 stdout/stderr，超时杀进程。 */
const DEFAULT_SHELL_RUNNER: CommandRunner = {
  run(command, opts): Promise<CommandRunOutcome> {
    return new Promise((resolve) => {
      exec(
        command,
        { cwd: opts.cwd, timeout: opts.timeoutMs, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const exitCode =
            error == null ? 0 : typeof error.code === "number" ? error.code : null;
          const timedOut = Boolean(error != null && error.killed && error.signal === "SIGTERM");
          resolve({ exitCode, stdout: stdout ?? "", stderr: stderr ?? "", timedOut });
        },
      );
    });
  },
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 压平换行（回注与日志安全），并截断到上限。 */
function oneLine(value: string, maxChars = GAP_DETAIL_MAX_CHARS): string {
  const flat = value.replace(/\r?\n/g, "\\n");
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…(truncated)` : flat;
}

/** 非空输出拼为 "；label: 内容" 片段，空输出返回空串。 */
function detailTail(label: string, value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? `; ${label}: ${oneLine(trimmed)}` : "";
}

/** command 失败 → 结构化 gap（超时与退出码独立成 expected/actual 语义）。 */
function commandFailureGap(
  check: CommandCheck,
  outcome: CommandRunOutcome,
  timeoutMs: number,
): VerificationGap {
  if (outcome.timedOut) {
    return {
      checkId: check.id,
      expected: `command completes within ${timeoutMs}ms`,
      actual: `timed out after ${timeoutMs}ms${detailTail("stderr", outcome.stderr)}`,
    };
  }
  if (outcome.exitCode === null) {
    return {
      checkId: check.id,
      expected: "command runs successfully",
      actual: `runner failure${detailTail("stderr", outcome.stderr) || ": unknown error"}`,
    };
  }
  return {
    checkId: check.id,
    expected: "command exits with code 0",
    actual: `exit ${outcome.exitCode}${detailTail("stdout", outcome.stdout)}${detailTail(
      "stderr",
      outcome.stderr,
    )}`,
  };
}

export class TargetVerifier {
  /**
   * 白名单谓词：command 是否被 contract.checks verbatim 显式声明。
   * 这是"防 verifier 被诱导执行任意命令"的唯一权威判定。
   */
  isCommandAllowed(contract: TargetContract, command: string): boolean {
    return contract.checks.some((check) => check.kind === "command" && check.command === command);
  }

  /**
   * 单条 command 检查的独立执行入口（白名单校验 + 触达 runner）。
   * 仅负责执行与取回 outcome；失败时抛/降级的语义由 verify() 按 tolerance 决定。
   * 白名单外命令：CommandNotAllowedError，绝不触达 runner。
   */
  async runCommandCheck(
    contract: TargetContract,
    check: Check,
    workspaceRoot: string,
    opts?: TargetVerifierOptions,
  ): Promise<CommandRunOutcome> {
    if (check.kind !== "command") {
      throw new TypeError(`runCommandCheck requires a kind:"command" check, got "${check.kind}"`);
    }
    if (!this.isCommandAllowed(contract, check.command)) {
      throw new CommandNotAllowedError(check.command);
    }
    const runner = opts?.runner ?? DEFAULT_SHELL_RUNNER;
    const timeoutMs = opts?.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    return runner.run(check.command, { timeoutMs, cwd: workspaceRoot });
  }

  /**
   * 目标契约核验（工单钉死顺序）：
   * ① deliverables 逐项真实读盘核验（存在性 + mustContain 逐条子串）；
   * ② checks 逐条：command 经白名单快照 + 注入 runner 执行；predicate 直调；
   * ③ 汇总：任一 gap → passed:false。
   */
  async verify(
    contract: TargetContract,
    workspaceRoot: string,
    opts?: TargetVerifierOptions,
  ): Promise<VerificationResult> {
    const startedAtMs = Date.now();
    const ranAt = new Date().toISOString();
    const gaps: VerificationGap[] = [];
    const runner = opts?.runner ?? DEFAULT_SHELL_RUNNER;
    const timeoutMs = opts?.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const strict = (contract.tolerance ?? "strict") === "strict";

    // 白名单快照：verify 入口冻结声明的命令串；运行期向 contract.checks
    // 夹带新命令无法通过本集合（测试钉死），命令绝不触达 runner。
    const allowedCommands = new Set<string>();
    for (const check of contract.checks) {
      if (check.kind === "command") {
        allowedCommands.add(check.command);
      }
    }

    // ① deliverables：真实读盘（stat/readFile），无内存缓存，不可被内存态欺骗。
    for (const [index, deliverable] of contract.deliverables.entries()) {
      const resolved = nodePath.resolve(workspaceRoot, deliverable.path);
      const gapId = `deliverable[${index}]:${deliverable.path}`;

      let stats: Awaited<ReturnType<typeof stat>> | null = null;
      try {
        stats = await stat(resolved);
      } catch {
        stats = null;
      }

      if (stats === null) {
        // 不存在：mustExist → gap；mustExist:false → 容忍。两种情况下都无法
        // 读内容，故内容核验一并跳过（语义钉死：不存在即无从 mustContain）。
        if (deliverable.mustExist) {
          gaps.push({
            checkId: gapId,
            expected: `file exists: ${deliverable.path}`,
            actual: `missing (resolved: ${resolved})`,
          });
        }
        continue;
      }

      const wantsFile = deliverable.mustExist || (deliverable.mustContain?.length ?? 0) > 0;
      if (!stats.isFile()) {
        if (wantsFile) {
          gaps.push({
            checkId: gapId,
            expected: `regular file: ${deliverable.path}`,
            actual: `exists but is not a regular file (resolved: ${resolved})`,
          });
        }
        continue;
      }

      const needles = deliverable.mustContain ?? [];
      if (needles.length > 0) {
        let content: string;
        try {
          content = await readFile(resolved, "utf8");
        } catch (err) {
          gaps.push({
            checkId: gapId,
            expected: `readable file: ${deliverable.path}`,
            actual: `unreadable: ${errorMessage(err)}`,
          });
          continue;
        }
        // 逐条子串检查：每条缺失的 needle 独立成 gap。
        for (const [needleIndex, needle] of needles.entries()) {
          if (!content.includes(needle)) {
            gaps.push({
              checkId: `${gapId}.mustContain[${needleIndex}]`,
              expected: `content contains substring: ${JSON.stringify(needle)}`,
              actual: `substring not found in ${resolved}`,
            });
          }
        }
      }
    }

    // ② checks：command（白名单 + runner）与 predicate（直调注入函数）。
    for (const check of contract.checks) {
      if (check.kind === "command") {
        // 纵深防御：执行前对照入口快照，防运行期夹带。
        if (!allowedCommands.has(check.command)) {
          throw new CommandNotAllowedError(check.command);
        }
        let outcome: CommandRunOutcome;
        try {
          outcome = await runner.run(check.command, { timeoutMs, cwd: workspaceRoot });
        } catch (err) {
          const synthetic: CommandRunOutcome = {
            exitCode: null,
            stdout: "",
            stderr: `runner threw: ${errorMessage(err)}`,
            timedOut: false,
          };
          if (strict) {
            throw new CommandCheckError(check.id, synthetic);
          }
          gaps.push(commandFailureGap(check, synthetic, timeoutMs));
          continue;
        }
        // 超时与退出码独立断言：timedOut 优先判失败（即使 exitCode===0）。
        if (outcome.timedOut || outcome.exitCode !== 0) {
          if (strict) {
            throw new CommandCheckError(check.id, outcome);
          }
          gaps.push(commandFailureGap(check, outcome, timeoutMs));
        }
      } else {
        const ctx: CheckContext = { workspaceRoot, contract };
        try {
          const passed = (await check.predicate(ctx)) === true;
          if (!passed) {
            gaps.push({
              checkId: check.id,
              expected: `predicate "${check.description}" returns true`,
              actual: "predicate returned false",
            });
          }
        } catch (err) {
          gaps.push({
            checkId: check.id,
            expected: `predicate "${check.description}" returns true`,
            actual: `predicate threw: ${errorMessage(err)}`,
          });
        }
      }
    }

    // ③ 汇总：任一 gap → passed:false。
    return {
      passed: gaps.length === 0,
      gaps,
      ranAt,
      durationMs: Date.now() - startedAtMs,
    };
  }

  /**
   * 完工闸门：passed → 原样返回 result（调用方放行"自称完成"）；
   * 否则抛 TargetIncompleteError（携带完整 gaps），调用方=agent 循环捕获后
   * 将 gap 清单回注模型自愈续跑。
   */
  gateOrThrow(result: VerificationResult): VerificationResult {
    if (result.passed) {
      return result;
    }
    throw new TargetIncompleteError(result.gaps);
  }

  /**
   * 人类可读差距清单（供回注模型）。多行值压平为单行、超长截断，
   * 保证回注文本结构稳定。
   */
  formatGaps(result: VerificationResult): string {
    if (result.passed) {
      return "target verified: all checks passed (0 gaps)";
    }
    const lines = [`target incomplete: ${result.gaps.length} gap(s):`];
    for (const gap of result.gaps) {
      lines.push(
        `- [${gap.checkId}] expected: ${oneLine(gap.expected)}; actual: ${oneLine(gap.actual)}`,
      );
    }
    return lines.join("\n");
  }
}
