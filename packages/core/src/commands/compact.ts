/**
 * BI-11 — 手动门命令对象: /compact [prompt] | /rewind [steps] | /clear。
 *
 * 参数校验 + 结构化错误; 执行回调注入 (CompactPort 归 BI-10 已关单资产,
 * 经端口引入, 本文件不实现紧缩逻辑)。零依赖; strict。
 */

/** 紧缩端口: 实际实现由 BI-10 已关单资产提供 (注入)。 */
export interface CompactPort {
  compact(prompt?: string): void;
}

/** 回退端口。 */
export interface RewindPort {
  rewind(steps: number): void;
}

/** 清空端口。 */
export interface ClearPort {
  clear(): void;
}

/** 执行上下文: 三个端口的注入点。 */
export interface CommandContext {
  compact: CompactPort;
  rewind: RewindPort;
  clear: ClearPort;
}

export type CommandError =
  | { code: 'empty-input'; message: string }
  | { code: 'unknown-command'; message: string }
  | { code: 'invalid-steps'; message: string }
  | { code: 'unexpected-argument'; message: string };

export type CommandParse<A> = { ok: true; args: A } | { ok: false; error: CommandError };

/** 手动门命令对象统一形状。 */
export interface GateCommand<A> {
  name: 'compact' | 'rewind' | 'clear';
  usage: string;
  parse(args: string): CommandParse<A>;
  execute(args: A, ctx: CommandContext): void;
}

/** /compact [prompt] —— 其余参数整体作为紧缩提示词 (空缺省 undefined)。 */
export const compactCommand: GateCommand<{ prompt?: string }> = {
  name: 'compact',
  usage: '/compact [prompt]',
  parse(args: string) {
    const prompt = args.trim();
    return { ok: true, args: { prompt: prompt === '' ? undefined : prompt } };
  },
  execute(args, ctx) {
    ctx.compact.compact(args.prompt);
  },
};

/** /rewind [steps] —— steps 必须为正整数, 否则 invalid-steps。 */
export const rewindCommand: GateCommand<{ steps: number }> = {
  name: 'rewind',
  usage: '/rewind [steps]',
  parse(args: string) {
    const trimmed = args.trim();
    if (trimmed === '') {
      return {
        ok: false,
        error: { code: 'invalid-steps', message: '缺少 steps 参数 (用法: /rewind [steps])' },
      };
    }
    const steps = Number(trimmed);
    if (!Number.isInteger(steps) || steps < 1) {
      return {
        ok: false,
        error: { code: 'invalid-steps', message: `steps 必须为正整数, 收到: ${trimmed}` },
      };
    }
    return { ok: true, args: { steps } };
  },
  execute(args, ctx) {
    ctx.rewind.rewind(args.steps);
  },
};

/** /clear —— 不接受任何参数, 否则 unexpected-argument。 */
export const clearCommand: GateCommand<undefined> = {
  name: 'clear',
  usage: '/clear',
  parse(args: string) {
    const trimmed = args.trim();
    if (trimmed !== '') {
      return { ok: false, error: { code: 'unexpected-argument', message: '/clear 不接受参数' } };
    }
    return { ok: true, args: undefined };
  },
  execute(_args, ctx) {
    ctx.clear.clear();
  },
};

/** 三命令对象的联合 (异构泛型的公共上界)。 */
export type AnyGateCommand =
  | GateCommand<{ prompt?: string }>
  | GateCommand<{ steps: number }>
  | GateCommand<undefined>;

const GATE_REGISTRY: Record<'compact' | 'rewind' | 'clear', AnyGateCommand> = {
  compact: compactCommand,
  rewind: rewindCommand,
  clear: clearCommand,
};

/** 按名称取命令对象。 */
export function findGateCommand(name: string): AnyGateCommand | undefined {
  if (name === 'compact' || name === 'rewind' || name === 'clear') {
    return GATE_REGISTRY[name];
  }
  return undefined;
}
