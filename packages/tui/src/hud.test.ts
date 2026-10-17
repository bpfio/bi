import { describe, expect, test } from 'bun:test';
import {
  TokenHud,
  abbreviateTokens,
  executeHudCommand,
  parseHudCommand,
  type HudCommandPorts,
} from './hud';
import { renderModeIndicator } from './components/mode-indicator';

describe('BI-20.1 mode-indicator —— 徽标纯渲染', () => {
  test('plan -> [plan]', () => {
    expect(renderModeIndicator('plan')).toBe('[plan]');
  });

  test('edit -> [edit]', () => {
    expect(renderModeIndicator('edit')).toBe('[edit]');
  });

  test('build -> [build]', () => {
    expect(renderModeIndicator('build')).toBe('[build]');
  });

  test('yolo -> [yolo]', () => {
    expect(renderModeIndicator('yolo')).toBe('[yolo]');
  });

  test('纯函数幂等: 同输入同输出', () => {
    expect(renderModeIndicator('plan')).toBe(renderModeIndicator('plan'));
  });
});

describe('BI-11 TokenHud —— 渲染矩阵', () => {
  const hud = new TokenHud();

  test('钉死样例: 42k/128k (32%) | Cache: 88%', () => {
    expect(hud.render({ promptTokens: 42000, maxTokens: 128000, cacheHitRate: 0.88 })).toBe(
      'Tokens: 42k/128k (32%) | Cache: 88%',
    );
  });

  test('零边界: 0/128000 -> (0%)', () => {
    expect(hud.render({ promptTokens: 0, maxTokens: 128000 })).toBe('Tokens: 0/128k (0%)');
  });

  test('满边界: 128000/128000 -> (100%)', () => {
    expect(hud.render({ promptTokens: 128000, maxTokens: 128000 })).toBe('Tokens: 128k/128k (100%)');
  });

  test('cacheHitRate 缺省省略 Cache 段', () => {
    const line = hud.render({ promptTokens: 1000, maxTokens: 2000 });
    expect(line).toBe('Tokens: 1k/2k (50%)');
    expect(line.includes('Cache')).toBe(false);
  });

  test('cacheHitRate 0.5 -> 50%; 0 -> 0%; 1 -> 100%', () => {
    expect(hud.render({ promptTokens: 1, maxTokens: 1, cacheHitRate: 0.5 })).toContain('Cache: 50%');
    expect(hud.render({ promptTokens: 1, maxTokens: 1, cacheHitRate: 0 })).toContain('Cache: 0%');
    expect(hud.render({ promptTokens: 1, maxTokens: 1, cacheHitRate: 1 })).toContain('Cache: 100%');
  });

  test('超限钳制: prompt > max -> (100%)', () => {
    expect(hud.render({ promptTokens: 200000, maxTokens: 128000 })).toContain('(100%)');
  });

  test('k 缩写规则钉死: <1000 原样, >=1000 取整后缀 k', () => {
    expect(abbreviateTokens(0)).toBe('0');
    expect(abbreviateTokens(999)).toBe('999');
    expect(abbreviateTokens(1000)).toBe('1k');
    expect(abbreviateTokens(42000)).toBe('42k');
    expect(abbreviateTokens(128000)).toBe('128k');
    expect(abbreviateTokens(42500)).toBe('43k');
  });

  test('maxTokens 为 0 时百分比回落 0%', () => {
    expect(hud.render({ promptTokens: 0, maxTokens: 0 })).toBe('Tokens: 0/0 (0%)');
  });

  test('确定性: 同状态两次渲染逐字节一致', () => {
    const state = { promptTokens: 42000, maxTokens: 128000, cacheHitRate: 0.88 };
    expect(hud.render(state)).toBe(hud.render(state));
  });
});

describe('BI-11 手动门 —— 三命令解析矩阵', () => {
  test('/compact 无参 -> ok, prompt undefined', () => {
    expect(parseHudCommand('/compact')).toEqual({
      ok: true,
      command: { type: 'compact', prompt: undefined },
    });
  });

  test('/compact 带提示词 -> 整体透传', () => {
    expect(parseHudCommand('/compact 保留架构决策')).toEqual({
      ok: true,
      command: { type: 'compact', prompt: '保留架构决策' },
    });
  });

  test('/rewind 3 -> ok, steps 3', () => {
    expect(parseHudCommand('/rewind 3')).toEqual({ ok: true, command: { type: 'rewind', steps: 3 } });
  });

  test('/rewind 无参 -> invalid-steps', () => {
    const result = parseHudCommand('/rewind');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-steps');
    }
  });

  test('/rewind abc / 0 / -1 / 2.5 -> invalid-steps', () => {
    for (const line of ['/rewind abc', '/rewind 0', '/rewind -1', '/rewind 2.5']) {
      const result = parseHudCommand(line);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invalid-steps');
      }
    }
  });

  test('/clear -> ok', () => {
    expect(parseHudCommand('/clear')).toEqual({ ok: true, command: { type: 'clear' } });
  });

  test('/clear extra -> unexpected-argument', () => {
    const result = parseHudCommand('/clear now');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unexpected-argument');
    }
  });

  test('未知命令与空输入的结构化错误', () => {
    const unknown = parseHudCommand('/nope x');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.code).toBe('unknown-command');
    }
    const bare = parseHudCommand('hello');
    expect(bare.ok).toBe(false);
    if (!bare.ok) {
      expect(bare.error.code).toBe('unknown-command');
    }
    const empty = parseHudCommand('   ');
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.error.code).toBe('empty-input');
    }
  });
});

describe('BI-11 手动门 —— 回调透传', () => {
  function capturePorts(): { ports: HudCommandPorts; calls: string[] } {
    const calls: string[] = [];
    const ports: HudCommandPorts = {
      onCompact(prompt) {
        calls.push(`compact:${prompt ?? ''}`);
      },
      onRewind(steps) {
        calls.push(`rewind:${steps}`);
      },
      onClear() {
        calls.push('clear');
      },
    };
    return { ports, calls };
  }

  test('compact 回调收到 prompt', () => {
    const { ports, calls } = capturePorts();
    const parsed = parseHudCommand('/compact 提炼要点');
    if (parsed.ok) {
      expect(executeHudCommand(parsed.command, ports)).toBe('dispatched');
    }
    expect(calls).toEqual(['compact:提炼要点']);
  });

  test('rewind 回调收到 steps', () => {
    const { ports, calls } = capturePorts();
    const parsed = parseHudCommand('/rewind 2');
    if (parsed.ok) {
      expect(executeHudCommand(parsed.command, ports)).toBe('dispatched');
    }
    expect(calls).toEqual(['rewind:2']);
  });

  test('clear 回调无参触发', () => {
    const { ports, calls } = capturePorts();
    const parsed = parseHudCommand('/clear');
    if (parsed.ok) {
      expect(executeHudCommand(parsed.command, ports)).toBe('dispatched');
    }
    expect(calls).toEqual(['clear']);
  });

  test('端口缺失返回 no-port 且不抛错', () => {
    const parsed = parseHudCommand('/compact');
    if (parsed.ok) {
      expect(executeHudCommand(parsed.command, {})).toBe('no-port');
    }
    const clear = parseHudCommand('/clear');
    if (clear.ok) {
      expect(executeHudCommand(clear.command, {})).toBe('no-port');
    }
  });
});
