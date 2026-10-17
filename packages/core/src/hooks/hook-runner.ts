/**
 * BI-06.4 外部生命周期钩子执行器与安全阻断网关
 *
 * 职责：按事件匹配 HooksConfig 中的钩子，逐条执行外部 shell 命令并聚合决策。
 *
 * 执行流水（每条匹配钩子，config 顺序即执行顺序）：
 *   1. fail-closed 信任门（BI-06.9 workspace-trust）：工作区非 'trusted' → 不 spawn，
 *      记录 skipped-untrusted（审计拒绝），主流程继续；
 *   2. 执行准入扫描（BI-06.8 shell-scan + opaque-guard）：脚本 opaque（及 dangerous）
 *      一律不 spawn，记录 skipped-opaque（审计拒绝），主流程继续；
 *   3. spawn 执行：stdin = HookInput JSON（run() 的 event 参数权威，覆盖 input.event）；
 *      超时杀 → 结构化 hook-timeout 记录；spawn 失败/非零退出 = 失败不阻断 + crash 记录；
 *      stdout 末行（最后非空行）解析为 HookOutput，解析失败 = 默认放行 + 告警记录；
 *   4. 聚合：首个有效 block（显式 JSON 且 blocking !== false）即短路返回
 *      { action:'block', reason, hookId, ran, records }；全部放行 → { action:'allow', ran, records }。
 *
 * 双层安全语义（正交，钉死）：
 * - fail-closed 准入门（信任门 + opaque 门）：拒绝的是【执行外部代码】这件事（不 spawn），
 *   被拒的是钩子本身，主流程不被阻断；
 * - fail-open 执行面：钩子自身故障（spawn 失败/非零退出/超时/坏输出）不阻断主流程
 *   （fail-open for availability）；只有显式 JSON { action:"block" } 决策（且 blocking !== false）
 *   才阻断主流程。
 *
 * 'ask' 决策在本层不产生阻断（交由上层权限系统的扩展点），按放行记录。
 * ran = 实际 spawn 过的钩子数（含超时/崩溃，不含 skipped）。
 * 无匹配钩子时短路返回，不查询信任门（避免无谓 IO）。
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { assertExecutable, type GuardVerdict } from '../sandbox/opaque-guard';
import type { ScanResult } from '../sandbox/shell-scan';
import type { WorkspaceTrustState } from '../guard/workspace-trust';
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  type HookDefinition,
  type HookEvent,
  type HookInput,
  type HookOutcome,
  type HookOutput,
  type HookRunRecord,
  type HooksConfig,
} from './types';

/** 默认 spawn 实现的结果（Bun/Node child_process 语义收敛为纯数据） */
export interface HookSpawnResult {
  /** 退出码；进程被信号杀死或 spawn 失败时为 null */
  code: number | null;
  /** 终止信号（如 "SIGKILL"） */
  signal: string | null;
  stdout: string;
  stderr: string;
  /** 是否因超时被杀死（结构化 hook-timeout 依据） */
  timedOut: boolean;
  /** spawn 本身失败（如命令不存在）时的错误说明 */
  error?: string;
}

/**
 * 可注入的 spawn 实现（测试用 stub 替换，零真实盘 IO）。
 * 语义约定 —— 以 shell 执行 command；写入 stdin 并关闭；等待退出；
 * 超过 timeoutMs 杀掉进程并返回 timedOut: true；约定永不 reject（失败收敛为 error 字段），
 * 违约抛错也会被 run() 折叠为 crash 记录（fail-open）。
 */
export type HookSpawnImpl = (
  command: string,
  opts: { cwd: string; stdin: string; timeoutMs: number },
) => Promise<HookSpawnResult>;

/** HookRunner 依赖注入 */
export interface HookRunnerDeps {
  /** hooks 配置（来自 config.toml `[[hooks]]` 分区；装载与 schema 映射归 BI-01.1 config） */
  config: HooksConfig;
  /** spawn 实现，缺省为 node:child_process 的 shell 执行封装 */
  spawnImpl?: HookSpawnImpl;
  /** 时钟（用于 durationMs 统计），缺省 Date.now */
  clock?: () => number;
  /** BI-06.9 workspace-trust：查询工作区信任状态（仅 'trusted' 允许执行钩子） */
  trust: (root: string) => WorkspaceTrustState;
  /** BI-06.8 shell-scan：脚本内容扫描（opaque/dangerous → 拒绝执行） */
  scanShell: (cmd: string) => ScanResult;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * 从 stdout 提取最后一个非空行并解析为 HookOutput 决策。
 * 不可解析（空输出 / 非 JSON / 非对象 / action 非法）时返回结构化错误，
 * 由调用方按 fail-open 语义放行并记录告警。
 * 注意：stdout 必须以末行承载决策 JSON；之前的行均为噪声（透传日志）。
 */
export function parseHookOutput(
  stdout: string,
): { ok: true; output: HookOutput } | { ok: false; error: string } {
  const lines = stdout.split(/\r?\n/);
  let lastLine = '';
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line !== undefined && line.trim() !== '') {
      lastLine = line.trim();
      break;
    }
  }
  if (lastLine === '') return { ok: false, error: 'empty-stdout' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(lastLine);
  } catch (err) {
    return { ok: false, error: `json-parse-failed: ${errorMessage(err)}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `not-a-json-object: ${lastLine.slice(0, 80)}` };
  }
  const record = parsed as Record<string, unknown>;
  const action = record['action'];
  if (action !== 'allow' && action !== 'block' && action !== 'ask') {
    return { ok: false, error: `invalid-action: ${String(action)}` };
  }
  const reason = record['reason'];
  return {
    ok: true,
    output: {
      action,
      ...(typeof reason === 'string' && reason !== '' ? { reason } : {}),
    },
  };
}

/**
 * 缺省 spawn 实现：node:child_process spawn + shell 执行 + 超时进程组 SIGKILL。
 * stdin 一次性写入 HookInput JSON 后关闭；子进程提前退出时的 EPIPE 被吞掉。
 *
 * 进程组要点（对齐 tools/process-group.ts 的 PGID 设施）：POSIX 下以 detached 派生，
 * 子进程即组长；超时按 deadline 语义（额度已用尽，不做 SIGTERM 宽限）直接
 * kill(-pgid, 'SIGKILL') 整组击杀。若只杀 shell 本体，shell fork 出的孙进程会继续
 * 持有 stdio 管道，'close' 事件要等孙进程退出才能触发，超时判定将失效。
 */
const defaultSpawnImpl: HookSpawnImpl = (command, opts) => {
  return new Promise<HookSpawnResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = nodeSpawn(command, {
        shell: true,
        cwd: opts.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        error: errorMessage(err),
      });
      return;
    }
    const killHard = (): void => {
      try {
        if (process.platform !== 'win32' && typeof child.pid === 'number' && child.pid > 0) {
          process.kill(-child.pid, 'SIGKILL');
          return;
        }
        child.kill('SIGKILL');
      } catch {
        // 进程已退出（ESRCH 等），忽略
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killHard();
    }, opts.timeoutMs);
    const finish = (code: number | null, signal: string | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, ...(error === undefined ? {} : { error }) });
    };
    child.stdout?.on('data', (chunk: unknown) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk: unknown) => {
      stderr += String(chunk);
    });
    child.stdin?.on('error', () => {});
    child.on('error', (err: unknown) => finish(null, null, errorMessage(err)));
    child.on('close', (code, signal) => finish(code ?? null, signal ?? null));
    child.stdin?.end(opts.stdin);
  });
};

/**
 * 钩子执行器与安全阻断网关。
 */
export class HookRunner {
  constructor(private readonly deps: HookRunnerDeps) {}

  /**
   * 触发某事件的所有钩子并聚合决策（语义见文件头）。
   */
  async run(event: HookEvent, input: HookInput): Promise<HookOutcome> {
    const spawnImpl = this.deps.spawnImpl ?? defaultSpawnImpl;
    const clock = this.deps.clock ?? Date.now;
    const allHooks = this.deps.config.hooks ?? [];
    const records: HookRunRecord[] = [];
    let ran = 0;

    // 事件匹配：config 声明顺序即执行顺序；hookId 取 config.hooks 下标，保证全局唯一
    const matched: Array<{ hook: HookDefinition; hookId: string }> = [];
    for (let i = 0; i < allHooks.length; i += 1) {
      const hook = allHooks[i];
      if (hook !== undefined && hook.event === event) {
        matched.push({ hook, hookId: `hooks[${i}]` });
      }
    }
    if (matched.length === 0) {
      return { action: 'allow', ran: 0, records };
    }

    // ---- fail-closed 信任门（BI-06.9）：非 'trusted' 一律不执行（不 spawn）----
    // 信任状态与钩子无关，一次查询、逐条审计记录；root = 工作区根（input.cwd）。
    const trustState: WorkspaceTrustState = this.deps.trust(input.cwd);
    const trusted = trustState === 'trusted';

    for (const { hook, hookId } of matched) {
      const base = { hookId, event, command: hook.command };

      if (!trusted) {
        records.push({
          ...base,
          status: 'skipped-untrusted',
          durationMs: 0,
          reason: `untrusted-workspace: ${trustState}`,
        });
        continue;
      }

      // ---- 执行准入（BI-06.8）：opaque/dangerous 脚本一律不 spawn ----
      let verdict: GuardVerdict;
      try {
        verdict = assertExecutable(this.deps.scanShell(hook.command));
      } catch (err) {
        records.push({
          ...base,
          status: 'skipped-opaque',
          durationMs: 0,
          reason: `scan-threw: ${errorMessage(err)}`,
        });
        continue;
      }
      if (!verdict.allowed) {
        records.push({
          ...base,
          status: 'skipped-opaque',
          durationMs: 0,
          reason: verdict.reasons.join('; '),
        });
        continue;
      }

      // ---- spawn 执行（stdin = HookInput JSON；event 以 run() 参数为准）----
      const startedAt = clock();
      let result: HookSpawnResult;
      try {
        result = await spawnImpl(hook.command, {
          cwd: input.cwd,
          stdin: JSON.stringify({ ...input, event }),
          timeoutMs: hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
        });
      } catch (err) {
        records.push({
          ...base,
          status: 'crash',
          durationMs: clock() - startedAt,
          reason: `spawn-threw: ${errorMessage(err)}`,
        });
        continue;
      }
      ran += 1;
      const durationMs = clock() - startedAt;

      // fail-open：钩子自身故障一律不阻断，仅记录后继续
      if (result.timedOut) {
        records.push({
          ...base,
          status: 'timeout',
          timedOut: true,
          durationMs,
          exitCode: result.code,
          reason: 'hook-timeout',
        });
        continue;
      }
      if (result.error !== undefined) {
        records.push({
          ...base,
          status: 'crash',
          durationMs,
          exitCode: result.code,
          reason: `spawn-error: ${result.error}`,
        });
        continue;
      }
      if (result.code !== 0) {
        records.push({
          ...base,
          status: 'crash',
          durationMs,
          exitCode: result.code,
          reason:
            result.signal !== null
              ? `killed-by-signal: ${result.signal}`
              : `non-zero-exit: ${String(result.code)}`,
        });
        continue;
      }

      // stdout 末行解析；解析失败 = 默认放行 + 告警记录（fail-open）
      const parsed = parseHookOutput(result.stdout);
      if (!parsed.ok) {
        records.push({
          ...base,
          status: 'bad-output',
          durationMs,
          exitCode: result.code,
          warning: `hook-output-unparseable (${parsed.error}) → fail-open allow`,
        });
        continue;
      }

      const decision = parsed.output;
      if (decision.action === 'block') {
        if (hook.blocking === false) {
          // 咨询性钩子：block 决策降级为记录，不阻断
          records.push({
            ...base,
            status: 'ran',
            decision: 'block',
            blocked: false,
            durationMs,
            exitCode: result.code,
            reason: decision.reason,
            warning: 'advisory-block-ignored (blocking=false)',
          });
          continue;
        }
        records.push({
          ...base,
          status: 'ran',
          decision: 'block',
          blocked: true,
          durationMs,
          exitCode: result.code,
          reason: decision.reason,
        });
        return { action: 'block', reason: decision.reason, hookId, ran, records };
      }
      records.push({
        ...base,
        status: 'ran',
        decision: decision.action,
        blocked: false,
        durationMs,
        exitCode: result.code,
        reason: decision.reason,
      });
    }

    return { action: 'allow', ran, records };
  }
}
