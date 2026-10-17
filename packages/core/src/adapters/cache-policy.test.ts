/**
 * BI-04.4 — cache-policy + effort-updates 测试。
 *
 * 覆盖：4 级断点硬预算（优先级占槽 + cap 截断）、滑动尾窗（末条 → 中点 →
 * 等距回退，窗宽 min(messageBlocks,8)）、跨厂商矩阵（anthropic/bedrock 全
 * 断点、qwen 跳工具断点、gemini 隐式恒空）、同块去重；freezeEffort 追加式
 * 冻结（已标记原引用、content 不改写、输入不就地变异）+ lastEffortMarker。
 * 全部纯内存，零网络。
 */

import { describe, expect, test } from 'bun:test';

import type { BreakpointPosition, CachePolicySections } from './cache-policy';
import { MESSAGE_TAIL_WINDOW, allocateBreakpoints } from './cache-policy';
import { freezeEffort, lastEffortMarker, type EffortMessage } from './effort-updates';

const SECTIONS_FULL: CachePolicySections = { toolBlocks: 3, systemBlocks: 2, messageBlocks: 10 };
// toolBlocks 3 + systemBlocks 2 + messageBlocks 10 → 总块 15（索引 0..14）。

function positionsOf(plan: ReturnType<typeof allocateBreakpoints>): string {
  return plan.positions.map((p: BreakpointPosition) => `${p.segment}@${p.blockIndex}`).join(',');
}

// ---------------------------------------------------------------------------
// 4 级断点硬预算
// ---------------------------------------------------------------------------

describe('BI-04.4 · allocateBreakpoints 硬预算', () => {
  test('anthropic 全段满预算：4 槽 = [tools-tail, system-head, system-tail, message-tail 末块]', () => {
    const plan = allocateBreakpoints(4, SECTIONS_FULL, 'anthropic');
    expect(plan.cap).toBe(4);
    expect(plan.used).toBe(4);
    expect(positionsOf(plan)).toBe('tools-tail@2,system-head@3,system-tail@4,message-tail@14');
  });

  test('优先级 1/2：cap=2 只保 [tools-tail, system-tail]', () => {
    const plan = allocateBreakpoints(2, SECTIONS_FULL, 'anthropic');
    expect(positionsOf(plan)).toBe('tools-tail@2,system-tail@4');
    expect(plan.used).toBe(2);
  });

  test('优先级 3：cap=3 补 system-head，仍无 message-tail', () => {
    const plan = allocateBreakpoints(3, SECTIONS_FULL, 'anthropic');
    expect(positionsOf(plan)).toBe('tools-tail@2,system-head@3,system-tail@4');
  });

  test('cap=1：tools-tail 独占（覆盖最大静态段）', () => {
    const plan = allocateBreakpoints(1, SECTIONS_FULL, 'anthropic');
    expect(positionsOf(plan)).toBe('tools-tail@2');
  });

  test('缺省 cap=4（不传 cap 与 anthropic 缺省生效）', () => {
    const plan = allocateBreakpoints(undefined, SECTIONS_FULL);
    expect(plan.cap).toBe(4);
    expect(plan.vendor).toBe('anthropic');
    expect(plan.used).toBe(4);
  });

  test('滑动尾窗：messageBlocks=30 > 窗宽 8，断点贴末块且窗内等距', () => {
    const plan = allocateBreakpoints(4, { toolBlocks: 2, systemBlocks: 2, messageBlocks: 30 }, 'anthropic');
    const tail = plan.positions.filter((p) => p.segment === 'message-tail');
    expect(MESSAGE_TAIL_WINDOW).toBe(8);
    expect(tail.length).toBe(1);
    expect(tail[0]!.blockIndex).toBe(33); // 总块 34，末块索引 33
    expect(tail[0]!.blockIndex).toBeGreaterThanOrEqual(34 - MESSAGE_TAIL_WINDOW);
  });

  test('滑动尾窗余量 2 槽：末条 + 中点（floor(i×w/k) 公式）', () => {
    // systemBlocks=1 → system-head 与 tail 同块去重，余量 2 → k=2, w=8 → 回退 0 与 4。
    const plan = allocateBreakpoints(4, { toolBlocks: 1, systemBlocks: 1, messageBlocks: 10 }, 'anthropic');
    expect(positionsOf(plan)).toBe('tools-tail@0,system-tail@1,message-tail@7,message-tail@11');
    expect(plan.used).toBe(4);
  });

  test('systemBlocks=1 去重：无独立 system-head 断点', () => {
    const plan = allocateBreakpoints(4, { toolBlocks: 0, systemBlocks: 1, messageBlocks: 5 }, 'anthropic');
    expect(plan.positions.some((p) => p.segment === 'system-head')).toBe(false);
  });

  test('toolBlocks=0：跳过 tools-tail，余量流向尾窗（末条 + 中点）', () => {
    const plan = allocateBreakpoints(4, { toolBlocks: 0, systemBlocks: 2, messageBlocks: 8 }, 'anthropic');
    expect(plan.positions.some((p) => p.segment === 'tools-tail')).toBe(false);
    const tails = plan.positions.filter((p) => p.segment === 'message-tail').map((p) => p.blockIndex);
    expect(tails).toEqual([5, 9]); // 总块 10：末块 9 + 中点回退 4 → 5
  });

  test('messageBlocks=0：无 message-tail 断点', () => {
    const plan = allocateBreakpoints(4, { toolBlocks: 2, systemBlocks: 2, messageBlocks: 0 }, 'anthropic');
    expect(plan.positions.some((p) => p.segment === 'message-tail')).toBe(false);
    expect(plan.used).toBe(3);
  });

  test('全空 sections：plan 恒空', () => {
    const plan = allocateBreakpoints(4, { toolBlocks: 0, systemBlocks: 0, messageBlocks: 0 }, 'anthropic');
    expect(plan.positions).toEqual([]);
    expect(plan.used).toBe(0);
  });

  test('确定性：同输入恒同计划', () => {
    const a = allocateBreakpoints(4, SECTIONS_FULL, 'anthropic');
    const b = allocateBreakpoints(4, SECTIONS_FULL, 'anthropic');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ---------------------------------------------------------------------------
// 跨厂商矩阵
// ---------------------------------------------------------------------------

describe('BI-04.4 · 跨厂商矩阵', () => {
  test('bedrock 与 anthropic 全断点等价（仅 vendor 字段不同）', () => {
    const a = allocateBreakpoints(4, SECTIONS_FULL, 'anthropic');
    const b = allocateBreakpoints(4, SECTIONS_FULL, 'bedrock');
    expect(positionsOf(b)).toBe(positionsOf(a));
    expect(b.vendor).toBe('bedrock');
  });

  test('qwen 跳过 tools-tail：tools 并入系统，余量流向尾窗', () => {
    const plan = allocateBreakpoints(4, SECTIONS_FULL, 'qwen');
    expect(plan.positions.some((p) => p.segment === 'tools-tail')).toBe(false);
    // 静态占 2（system-tail@4, system-head@3）→ 尾窗 k=2 → 末块 14 + 中点回退 4 → 10。
    expect(positionsOf(plan)).toBe('system-head@3,system-tail@4,message-tail@10,message-tail@14');
    expect(plan.used).toBe(4);
  });

  test('qwen 与 anthropic 的差异恰为 tools-tail 槽位重分配', () => {
    const q = allocateBreakpoints(4, SECTIONS_FULL, 'qwen');
    const a = allocateBreakpoints(4, SECTIONS_FULL, 'anthropic');
    expect(a.positions.some((p) => p.segment === 'tools-tail')).toBe(true);
    expect(q.positions.filter((p) => p.segment === 'message-tail').length).toBeGreaterThan(
      a.positions.filter((p) => p.segment === 'message-tail').length,
    );
  });

  test('gemini 隐式缓存：显式断点恒空', () => {
    const plan = allocateBreakpoints(4, SECTIONS_FULL, 'gemini');
    expect(plan.positions).toEqual([]);
    expect(plan.used).toBe(0);
    expect(plan.vendor).toBe('gemini');
  });

  test('qwen 无系统块时仅尾窗兜底', () => {
    const plan = allocateBreakpoints(4, { toolBlocks: 3, systemBlocks: 0, messageBlocks: 6 }, 'qwen');
    // k=4, w=6, 总块 9：回退 floor(i×6/4)=0,1,3,4 → 末块 8,7,5,4。
    expect(positionsOf(plan)).toBe('message-tail@4,message-tail@5,message-tail@7,message-tail@8');
    expect(plan.used).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// freezeEffort 冻结传递
// ---------------------------------------------------------------------------

describe('BI-04.4 · freezeEffort', () => {
  const msg = (role: EffortMessage['role'], content: string, effort?: EffortMessage['effort']): EffortMessage => ({
    role,
    content,
    ...(effort !== undefined ? { effort } : {}),
  });

  test('未标记消息追加当前 effort 标记（content 字节不变）', () => {
    const out = freezeEffort([msg('user', 'hi')], 'high');
    expect(out[0]!.effort).toBe('high');
    expect(out[0]!.content).toBe('hi');
  });

  test('已标记消息原引用返回（身份不变、标记不被改写）', () => {
    const frozen = msg('user', 'q', 'low');
    const out = freezeEffort([frozen], 'high');
    expect(out[0]).toBe(frozen);
    expect(out[0]!.effort).toBe('low');
  });

  test('中途切换强度：历史冻结 low、新尾部追加 high（前缀字节稳定）', () => {
    const head = msg('user', 'q1', 'low');
    const assistant = msg('assistant', 'a1', 'low');
    const fresh = msg('user', 'q2');
    const out = freezeEffort([head, assistant, fresh], 'high');
    expect(out[0]).toBe(head);
    expect(out[1]).toBe(assistant);
    expect(out[2]!.effort).toBe('high');
    expect(out.map((m) => m.effort)).toEqual(['low', 'low', 'high']);
  });

  test('不就地变异：输入数组元素保持无标记', () => {
    const input = [msg('user', 'hi')];
    freezeEffort(input, 'max');
    expect(input[0]!.effort).toBeUndefined();
    expect(input.length).toBe(1);
  });

  test('块状 content（Array）引用原样保留，绝不改写 content', () => {
    const blocks = [{ type: 'text', text: 'hello' }];
    const input: EffortMessage[] = [{ role: 'user', content: blocks }];
    const out = freezeEffort(input, 'off');
    expect(out[0]!.content).toBe(blocks);
    expect(blocks[0]!.text).toBe('hello');
  });

  test('空数组恒空数组', () => {
    expect(freezeEffort([], 'low')).toEqual([]);
  });

  test('追加式生命周期：二次 freeze 只触碰新增尾部（首部引用恒定）', () => {
    const m1 = msg('user', 'q1');
    const round1 = freezeEffort([m1], 'low');
    const m2 = msg('assistant', 'a1');
    const round2 = freezeEffort([...round1, m2], 'low');
    expect(round2[0]).toBe(round1[0]); // 已冻结首部：原引用恒定
    expect(round2[1]).not.toBe(m2); // 新尾部：新对象带标记
    expect(round2[1]!.effort).toBe('low');
    expect(round2[1]!.content).toBe('a1');
  });
});

describe('BI-04.4 · lastEffortMarker', () => {
  test('空数组 → null', () => {
    expect(lastEffortMarker([])).toBeNull();
  });

  test('全部未标记 → null', () => {
    const msgs: EffortMessage[] = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
    expect(lastEffortMarker(msgs)).toBeNull();
  });

  test('尾端生效标记 = 最后一个非 undefined 的 effort', () => {
    const msgs: EffortMessage[] = [
      { role: 'system', content: 's', effort: 'off' },
      { role: 'user', content: 'a', effort: 'high' },
      { role: 'assistant', content: 'b', effort: 'low' },
    ];
    expect(lastEffortMarker(msgs)).toBe('low');
  });

  test('尾部未标记消息被跳过，回溯到最近标记', () => {
    const msgs: EffortMessage[] = [
      { role: 'user', content: 'a', effort: 'max' },
      { role: 'assistant', content: 'b' },
    ];
    expect(lastEffortMarker(msgs)).toBe('max');
  });
});
