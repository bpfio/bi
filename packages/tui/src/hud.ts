/**
 * BI-11 — Token HUD 渲染 + 手动门命令解析 (/compact /rewind /clear)。
 *
 * k 缩写规则 (钉死): n < 1000 原样十进制; n >= 1000 取 Math.round(n/1000) 后缀 'k'。
 * 百分比规则 (钉死): 占用比取 Math.floor (钉死样例 42k/128k -> 32%); Cache 取 Math.round。
 * 渲染确定性单行: `Tokens: 42k/128k (32%) | Cache: 88%`; cacheHitRate 缺省时省略 Cache 段。
 * 实际紧缩执行归 BI-10 已关单资产 (经端口/回调注入), 本文件只做门面。
 * 零依赖; strict。
 */

export interface TokenHudState {
  promptTokens: number;
  maxTokens: number;
  /** 0..1 的小数; 缺省则整段省略。 */
  cacheHitRate?: number;
}

/** k 缩写规则实现 (钉死, 见文件头)。 */
export function abbreviateTokens(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  return `${Math.round(n / 1000)}k`;
}

export class TokenHud {
  /** 确定性单行渲染: `Tokens: 42k/128k (32%) | Cache: 88%`。 */
  render(state: TokenHudState): string {
    const used = abbreviateTokens(state.promptTokens);
    const total = abbreviateTokens(state.maxTokens);
    const pct =
      state.maxTokens > 0
        ? Math.min(100, Math.max(0, Math.floor((state.promptTokens / state.maxTokens) * 100)))
        : 0;
    const base = `Tokens: ${used}/${total} (${pct}%)`;
    if (state.cacheHitRate === undefined) {
      return base;
    }
    return `${base} | Cache: ${Math.round(state.cacheHitRate * 100)}%`;
  }
}

/** 手动门命令解析结果。 */
export type HudCommand =
  | { type: 'compact'; prompt?: string }
  | { type: 'rewind'; steps: number }
  | { type: 'clear' };

export type HudCommandError =
  | { code: 'empty-input'; message: string }
  | { code: 'unknown-command'; message: string }
  | { code: 'invalid-steps'; message: string }
  | { code: 'unexpected-argument'; message: string };

export type HudParseResult =
  | { ok: true; command: HudCommand }
  | { ok: false; error: HudCommandError };

/** 三命令行解析 (参数校验 + 结构化错误)。 */
export function parseHudCommand(line: string): HudParseResult {
  const trimmed = line.trim();
  if (trimmed === '') {
    return { ok: false, error: { code: 'empty-input', message: '空输入' } };
  }
  if (!trimmed.startsWith('/')) {
    return {
      ok: false,
      error: { code: 'unknown-command', message: `未知命令: ${trimmed.split(/\s+/)[0] ?? ''}` },
    };
  }
  const name = trimmed.slice(1).split(/\s+/)[0] ?? '';
  const rest = trimmed.slice(1 + name.length).trim();
  switch (name) {
    case 'compact':
      return { ok: true, command: { type: 'compact', prompt: rest === '' ? undefined : rest } };
    case 'rewind': {
      if (rest === '') {
        return {
          ok: false,
          error: { code: 'invalid-steps', message: '缺少 steps 参数 (用法: /rewind [steps])' },
        };
      }
      const steps = Number(rest);
      if (!Number.isInteger(steps) || steps < 1) {
        return {
          ok: false,
          error: { code: 'invalid-steps', message: `steps 必须为正整数, 收到: ${rest}` },
        };
      }
      return { ok: true, command: { type: 'rewind', steps } };
    }
    case 'clear':
      if (rest !== '') {
        return {
          ok: false,
          error: { code: 'unexpected-argument', message: '/clear 不接受参数' },
        };
      }
      return { ok: true, command: { type: 'clear' } };
    default:
      return { ok: false, error: { code: 'unknown-command', message: `未知命令: ${name}` } };
  }
}

/** 执行回调注入: 真实紧缩/回退/清空由宿主 (BI-10 资产) 提供。 */
export interface HudCommandPorts {
  onCompact?(prompt?: string): void;
  onRewind?(steps: number): void;
  onClear?(): void;
}

/** 分发到注入回调; 对应端口缺失返回 'no-port'。 */
export function executeHudCommand(
  command: HudCommand,
  ports: HudCommandPorts,
): 'dispatched' | 'no-port' {
  switch (command.type) {
    case 'compact':
      if (!ports.onCompact) {
        return 'no-port';
      }
      ports.onCompact(command.prompt);
      return 'dispatched';
    case 'rewind':
      if (!ports.onRewind) {
        return 'no-port';
      }
      ports.onRewind(command.steps);
      return 'dispatched';
    case 'clear':
      if (!ports.onClear) {
        return 'no-port';
      }
      ports.onClear();
      return 'dispatched';
  }
}
