/**
 * BI-04.4 — per-message 推理强度标记冻结传递（freezeEffort）。
 *
 * # 设计总纲
 *
 * ## 1. 冻结语义
 *
 * 会话中途切换推理强度（effort）时，**已发送消息的强度标记必须冻结**：
 * 每条消息带着自己被发送时的 effort 标记回放，历史不改写。否则：
 *
 * - 改写历史标记 → 请求字节变化 → 已存 KV 前缀全部失效（命中率崩塌）；
 * - 语义上，历史轮次的思考深度是既成事实，不该被新设置追溯改写。
 *
 * ## 2. 追加式传递（不破坏 KV 前缀）
 *
 *   规则：**没有标记的消息视为新消息，只给它们追加标记；已带标记的消息
 *   原样返回（同一对象引用，字节不变）。**
 *
 * 生命周期：首次 freeze 发生在派发前（前缀尚未入缓存，全量标记安全）；
 * 此后每轮只有上轮新增的尾部消息缺标记 → 只有尾部被改写 → 首部前缀
 * 逐字节稳定。
 *
 * 标记落在消息对象的 `effort` 元数据字段上，**绝不改写 `content`**——
 * wire 字节由 content 决定，元数据不进缓存键。
 */

import type { ThinkingEffort } from './deepseek-adapter';

/** 带 per-message 冻结标记的消息（复用 BI-04.2 语义层消息形状）。 */
export interface EffortMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: string; [key: string]: unknown }>;
  /** 冻结的推理强度标记；undefined = 未标记（视为新消息）。 */
  effort?: ThinkingEffort;
}

/**
 * 追加式冻结传递（见文件头 §2）：未标记（effort === undefined）的消息视为
 * 新消息，返回带新标记的**新对象**（content 引用原样保留，绝不改写）；
 * 已标记消息**原引用返回**，字节与身份均不变。输入数组不被就地修改。
 */
export function freezeEffort<T extends EffortMessage>(
  messages: readonly T[],
  effort: ThinkingEffort,
): T[] {
  return messages.map((message) =>
    message.effort === undefined ? (Object.assign({}, message, { effort }) as T) : message,
  );
}

/** 读取尾端生效标记：从尾向前扫描，最后一个非 undefined 的 effort；全无则 null。 */
export function lastEffortMarker<T extends EffortMessage>(messages: readonly T[]): ThinkingEffort | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const effort = messages[i].effort;
    if (effort !== undefined) return effort;
  }
  return null;
}
