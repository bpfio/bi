import { describe, expect, test } from 'bun:test';
import {
  MODE_LABELS,
  MODE_ORDER,
  ModeSelector,
  type ReadOnlyPort,
} from './mode-selector';

/** 只读端口桩: 白名单内只读, 其余写。 */
function stubPort(readOnlyTools: string[]): ReadOnlyPort {
  return {
    isReadOnly(tool: string, _args: string): boolean {
      return readOnlyTools.includes(tool);
    },
  };
}

describe('BI-20.1 ModeSelector —— 四态与 Shift+Tab 循环', () => {
  test('初始模式缺省为 plan', () => {
    const selector = new ModeSelector(stubPort(['read']));
    expect(selector.getMode()).toBe('plan');
  });

  test('初始模式可显式指定', () => {
    const selector = new ModeSelector(stubPort(['read']), 'yolo');
    expect(selector.getMode()).toBe('yolo');
  });

  test('MODE_ORDER 顺序钉死: plan/edit/build/yolo', () => {
    expect([...MODE_ORDER]).toEqual(['plan', 'edit', 'build', 'yolo']);
  });

  test('cycle: plan -> edit', () => {
    const selector = new ModeSelector(stubPort([]));
    expect(selector.cycle()).toBe('edit');
    expect(selector.getMode()).toBe('edit');
  });

  test('cycle: edit -> build', () => {
    const selector = new ModeSelector(stubPort([]), 'edit');
    expect(selector.cycle()).toBe('build');
  });

  test('cycle: build -> yolo', () => {
    const selector = new ModeSelector(stubPort([]), 'build');
    expect(selector.cycle()).toBe('yolo');
  });

  test('cycle: yolo 回绕到 plan', () => {
    const selector = new ModeSelector(stubPort([]), 'yolo');
    expect(selector.cycle()).toBe('plan');
  });

  test('cycle 四连击回到原点 (完整环)', () => {
    const selector = new ModeSelector(stubPort([]));
    selector.cycle();
    selector.cycle();
    selector.cycle();
    selector.cycle();
    expect(selector.getMode()).toBe('plan');
  });

  test('setMode 直接置位任意态', () => {
    const selector = new ModeSelector(stubPort([]));
    selector.setMode('build');
    expect(selector.getMode()).toBe('build');
  });

  test('setMode 相同值不触发事件', () => {
    const selector = new ModeSelector(stubPort([]));
    let fired = 0;
    selector.onChange(() => {
      fired += 1;
    });
    selector.setMode('plan');
    expect(fired).toBe(0);
  });

  test('MODE_LABELS 徽标映射钉死', () => {
    expect(MODE_LABELS).toEqual({
      plan: '[plan]',
      edit: '[edit]',
      build: '[build]',
      yolo: '[yolo]',
    });
  });
});

describe('BI-20.1 ModeSelector —— 状态变更事件回调', () => {
  test('onChange 收到 from/to', () => {
    const selector = new ModeSelector(stubPort([]));
    const events: Array<{ from: string; to: string }> = [];
    selector.onChange((event) => {
      events.push({ from: event.from, to: event.to });
    });
    selector.setMode('edit');
    selector.setMode('yolo');
    expect(events).toEqual([
      { from: 'plan', to: 'edit' },
      { from: 'edit', to: 'yolo' },
    ]);
  });

  test('cycle 同样触发事件', () => {
    const selector = new ModeSelector(stubPort([]));
    const events: Array<{ from: string; to: string }> = [];
    selector.onChange((event) => {
      events.push({ from: event.from, to: event.to });
    });
    selector.cycle();
    expect(events).toEqual([{ from: 'plan', to: 'edit' }]);
  });

  test('退订函数生效, 不再收到事件', () => {
    const selector = new ModeSelector(stubPort([]));
    let fired = 0;
    const unsubscribe = selector.onChange(() => {
      fired += 1;
    });
    selector.setMode('edit');
    unsubscribe();
    selector.setMode('build');
    expect(fired).toBe(1);
  });

  test('多监听者按注册顺序同步收到', () => {
    const selector = new ModeSelector(stubPort([]));
    const order: string[] = [];
    selector.onChange(() => {
      order.push('first');
    });
    selector.onChange(() => {
      order.push('second');
    });
    selector.setMode('edit');
    expect(order).toEqual(['first', 'second']);
  });
});

describe('BI-20.1 ModeSelector —— plan 只读拦截矩阵 (接缝②)', () => {
  test('plan 态只读工具放行', () => {
    const selector = new ModeSelector(stubPort(['read', 'grep']));
    const result = selector.intercept('read', 'src/index.ts');
    expect(result).toEqual({ allowed: true, mode: 'plan', tool: 'read' });
    expect(result.code).toBeUndefined();
  });

  test('plan 态写工具被拦截, 结构化拒绝 plan-mode-readonly', () => {
    const selector = new ModeSelector(stubPort(['read']));
    const result = selector.intercept('edit', 'src/index.ts');
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('plan-mode-readonly');
    expect(result.mode).toBe('plan');
    expect(result.tool).toBe('edit');
  });

  test('edit 态不拦截写工具', () => {
    const selector = new ModeSelector(stubPort(['read']), 'edit');
    expect(selector.intercept('edit', 'a.ts').allowed).toBe(true);
  });

  test('build 态不拦截写工具', () => {
    const selector = new ModeSelector(stubPort(['read']), 'build');
    expect(selector.intercept('edit', 'a.ts').allowed).toBe(true);
  });

  test('yolo 态不拦截写工具', () => {
    const selector = new ModeSelector(stubPort(['read']), 'yolo');
    expect(selector.intercept('edit', 'a.ts').allowed).toBe(true);
  });

  test('端口按 args 判定: 同工具不同参数可分别放行/拦截', () => {
    const port: ReadOnlyPort = {
      isReadOnly(tool: string, args: string): boolean {
        return tool === 'bash' && args.startsWith('git status');
      },
    };
    const selector = new ModeSelector(port);
    expect(selector.intercept('bash', 'git status').allowed).toBe(true);
    const blocked = selector.intercept('bash', 'rm -rf /');
    expect(blocked.allowed).toBe(false);
    expect(blocked.code).toBe('plan-mode-readonly');
  });

  test('全写端口下 plan 态一律拦截', () => {
    const selector = new ModeSelector(stubPort([]));
    for (const tool of ['read', 'edit', 'bash', 'write']) {
      expect(selector.intercept(tool, '').allowed).toBe(false);
    }
  });

  test('切离 plan 后原先被拦截的调用放行', () => {
    const selector = new ModeSelector(stubPort(['read']));
    expect(selector.intercept('write', 'a.ts').allowed).toBe(false);
    selector.cycle(); // plan -> edit
    expect(selector.intercept('write', 'a.ts').allowed).toBe(true);
  });
});
