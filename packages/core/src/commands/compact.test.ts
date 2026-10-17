import { describe, expect, test } from 'bun:test';
import {
  clearCommand,
  compactCommand,
  findGateCommand,
  rewindCommand,
  type CommandContext,
} from './compact';

function captureContext(): { ctx: CommandContext; calls: string[] } {
  const calls: string[] = [];
  const ctx: CommandContext = {
    compact: {
      compact(prompt) {
        calls.push(`compact:${prompt ?? ''}`);
      },
    },
    rewind: {
      rewind(steps) {
        calls.push(`rewind:${steps}`);
      },
    },
    clear: {
      clear() {
        calls.push('clear');
      },
    },
  };
  return { ctx, calls };
}

describe('BI-11 compactCommand —— /compact [prompt]', () => {
  test('usage 字符串钉死', () => {
    expect(compactCommand.usage).toBe('/compact [prompt]');
    expect(compactCommand.name).toBe('compact');
  });

  test('parse 空参 -> prompt undefined', () => {
    const result = compactCommand.parse('');
    expect(result).toEqual({ ok: true, args: { prompt: undefined } });
  });

  test('parse 提示词整体透传 (trim)', () => {
    const result = compactCommand.parse('  保留架构决策与未决项  ');
    expect(result).toEqual({ ok: true, args: { prompt: '保留架构决策与未决项' } });
  });

  test('execute 回调透传 prompt 到 CompactPort', () => {
    const { ctx, calls } = captureContext();
    const parsed = compactCommand.parse('提炼要点');
    if (parsed.ok) {
      compactCommand.execute(parsed.args, ctx);
    }
    expect(calls).toEqual(['compact:提炼要点']);
  });

  test('execute 空参 -> CompactPort 收到 undefined', () => {
    const { ctx, calls } = captureContext();
    const parsed = compactCommand.parse('');
    if (parsed.ok) {
      compactCommand.execute(parsed.args, ctx);
    }
    expect(calls).toEqual(['compact:']);
  });
});

describe('BI-11 rewindCommand —— /rewind [steps]', () => {
  test('usage 字符串钉死', () => {
    expect(rewindCommand.usage).toBe('/rewind [steps]');
    expect(rewindCommand.name).toBe('rewind');
  });

  test('parse 正整数 -> ok', () => {
    expect(rewindCommand.parse('3')).toEqual({ ok: true, args: { steps: 3 } });
  });

  test('parse 空参 -> invalid-steps', () => {
    const result = rewindCommand.parse('');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-steps');
    }
  });

  test('parse 非法值矩阵: abc / 0 / -1 / 2.5 -> invalid-steps', () => {
    for (const raw of ['abc', '0', '-1', '2.5']) {
      const result = rewindCommand.parse(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invalid-steps');
      }
    }
  });

  test('execute 回调透传 steps 到 RewindPort', () => {
    const { ctx, calls } = captureContext();
    const parsed = rewindCommand.parse('5');
    if (parsed.ok) {
      rewindCommand.execute(parsed.args, ctx);
    }
    expect(calls).toEqual(['rewind:5']);
  });
});

describe('BI-11 clearCommand —— /clear', () => {
  test('usage 字符串钉死', () => {
    expect(clearCommand.usage).toBe('/clear');
    expect(clearCommand.name).toBe('clear');
  });

  test('parse 空参 -> ok', () => {
    expect(clearCommand.parse('')).toEqual({ ok: true, args: undefined });
  });

  test('parse 带参 -> unexpected-argument', () => {
    const result = clearCommand.parse(' now');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unexpected-argument');
    }
  });

  test('execute 回调触发 ClearPort', () => {
    const { ctx, calls } = captureContext();
    const parsed = clearCommand.parse('');
    if (parsed.ok) {
      clearCommand.execute(parsed.args, ctx);
    }
    expect(calls).toEqual(['clear']);
  });
});

describe('BI-11 命令注册表', () => {
  test('findGateCommand 按名取三命令对象', () => {
    expect(findGateCommand('compact')).toBe(compactCommand);
    expect(findGateCommand('rewind')).toBe(rewindCommand);
    expect(findGateCommand('clear')).toBe(clearCommand);
  });

  test('findGateCommand 未知名称返回 undefined', () => {
    expect(findGateCommand('nope')).toBeUndefined();
    expect(findGateCommand('')).toBeUndefined();
  });
});
