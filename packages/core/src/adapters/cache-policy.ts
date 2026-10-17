/**
 * BI-04.4 — 多级缓存断点硬预算分配（allocateBreakpoints）。
 *
 * # 设计总纲
 *
 * ## 1. 4 级断点硬预算
 *
 * 显式缓存断点（如 Anthropic `cache_control`）有数量上限（缺省 4）。断点
 * 打桩位置按优先级**硬预算**分配：
 *
 *   优先级 1  tools-tail    工具定义尾部（覆盖最大静态段）
 *   优先级 2  system-tail   系统指令尾
 *   优先级 3  system-head   系统指令首（次级锚点）
 *   优先级 4  message-tail  消息历史滑动尾部（余量全给尾窗）
 *
 * 统一块索引空间：tools 占 [0, toolBlocks)，system 占其后，messages 占
 * 最后。断点标记**附着于** blockIndex 所指块（即"截至该块为止"为缓存切点）。
 *
 * ### 1.1 滑动尾窗口径
 *
 * message-tail 断点只落在**尾窗**内（窗宽 = min(messageBlocks, 8)）：
 * 第 1 槽 = 窗内最后一条消息，第 2 槽 = 窗中点，依次向窗首等距回退。
 * 会话增长时窗随之滑动，断点始终贴着近期消息（旧消息自然滑出窗外，
 * 由前级静态断点兜底）。
 *
 * ## 2. 跨厂商感知矩阵（doc）
 *
 * | vendor    | tools-tail | system-head | system-tail | message-tail | 说明                                   |
 * |-----------|------------|-------------|-------------|--------------|----------------------------------------|
 * | anthropic | ✓          | ✓           | ✓           | ✓(余量)      | 全断点支持                              |
 * | bedrock   | ✓          | ✓           | ✓           | ✓(余量)      | 同 anthropic（Converse cachePoint 等价）|
 * | qwen      | ✗(并入系统)| ✓           | ✓           | ✓(余量)      | wire 上 tools 与 system 同属静态前缀，  |
 * |           |            |             |             |              | 独立工具断点无意义 → 预算并入系统段     |
 * | gemini    | —          | —           | —           | —            | 隐式缓存，不支持显式断点 → plan 为空    |
 */

export type VendorId = 'anthropic' | 'bedrock' | 'qwen' | 'gemini';

export type BreakpointSegment = 'tools-tail' | 'system-head' | 'system-tail' | 'message-tail';

export interface CachePolicySections {
  /** 工具定义块数。 */
  toolBlocks: number;
  /** 系统指令块数。 */
  systemBlocks: number;
  /** 历史消息块数。 */
  messageBlocks: number;
}

export interface BreakpointPosition {
  /** 统一块索引（断点附着于该块，见文件头 §1）。 */
  blockIndex: number;
  segment: BreakpointSegment;
}

export interface BreakpointPlan {
  vendor: VendorId;
  cap: number;
  used: number;
  positions: BreakpointPosition[];
}

/** 滑动尾窗最大窗宽（见文件头 §1.1）。 */
export const MESSAGE_TAIL_WINDOW = 8;

/** 缺省断点预算（Anthropic cache_control 上限口径）。 */
export const DEFAULT_BREAKPOINT_CAP = 4;

/**
 * 多级断点硬预算分配（doc 矩阵见文件头 §2）。
 *
 * 签名说明：骨架 (cap, sections) 之外补第三参 `vendor`（矩阵必须按厂商
 * 过滤，缺省 anthropic）。硬预算按优先级 1→4 依次占槽后截断（保证高优先
 * 级先得槽），输出按 blockIndex 升序排序（确定性布局）。
 *
 * 细则：
 * - system-head 与 system-tail 同块（systemBlocks=1）时跳过，槽位自然让渡
 *   给滑动尾窗（"余量全给尾窗"规则）。
 * - qwen 不设 tools-tail 断点（wire 上 tools 并入系统静态前缀，独立工具
 *   断点无意义），省下的槽位按"余量全给尾窗"流向 message-tail。
 * - gemini 隐式缓存：plan 恒空（used=0）。
 * - 滑动尾窗：窗宽 w=min(messageBlocks, 8)；第 i 槽（0 基）= 末块回退
 *   floor(i×w/k)（k=余量槽位数），去重后即为"末条 → 中点 → 等距回退"。
 */
export function allocateBreakpoints(
  breakpointCap?: number,
  sections?: CachePolicySections,
  vendor: VendorId = 'anthropic',
): BreakpointPlan {
  const cap = Math.max(0, Math.floor(breakpointCap ?? DEFAULT_BREAKPOINT_CAP));
  const s: CachePolicySections = sections ?? { toolBlocks: 0, systemBlocks: 0, messageBlocks: 0 };
  const plan: BreakpointPlan = { vendor, cap, used: 0, positions: [] };
  if (cap === 0 || vendor === 'gemini') return plan;

  const total = s.toolBlocks + s.systemBlocks + s.messageBlocks;

  // 优先级 1：tools-tail（qwen 矩阵跳过，见 doc §2）。
  if (vendor !== 'qwen' && s.toolBlocks > 0) {
    plan.positions.push({ blockIndex: s.toolBlocks - 1, segment: 'tools-tail' });
  }
  // 优先级 2：system-tail。
  if (s.systemBlocks > 0) {
    plan.positions.push({ blockIndex: s.toolBlocks + s.systemBlocks - 1, segment: 'system-tail' });
  }
  // 优先级 3：system-head（systemBlocks=1 时与 tail 同块 → 跳过去重）。
  if (s.systemBlocks > 1) {
    plan.positions.push({ blockIndex: s.toolBlocks, segment: 'system-head' });
  }

  // 优先级 4：message-tail —— 余量全给滑动尾窗（窗宽 min(messageBlocks, 8)）。
  const k = cap - plan.positions.length;
  if (k > 0 && s.messageBlocks > 0) {
    const w = Math.min(s.messageBlocks, MESSAGE_TAIL_WINDOW);
    const seen = new Set<number>();
    for (let i = 0; i < k; i++) {
      const idx = total - 1 - Math.floor((i * w) / k);
      if (idx >= 0 && !seen.has(idx)) {
        seen.add(idx);
        plan.positions.push({ blockIndex: idx, segment: 'message-tail' });
      }
    }
  }

  // 硬预算截断（优先级序已保证）+ 确定性输出（blockIndex 升序）。
  plan.positions = plan.positions.slice(0, cap).sort((a, b) => a.blockIndex - b.blockIndex);
  plan.used = plan.positions.length;
  return plan;
}
