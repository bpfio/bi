/**
 * 分工声明：本卡（BI-10.5）管「中断截断轮」的自愈注入与「日期跨越」披露；
 * 与 10.2（切点安全）、10.4（历史内容规整）互补——10.4 兜底未闭合调用的
 * 结果补齐，本卡在中断轮进入下一轮前生成一次性提醒，不判定切点、不改写
 * 历史。
 *
 * BI-10.5 · 中断状态上下文自愈注入器。
 *
 * buildInterruptionNotice：捕获 Ctrl+C 截断轮，过滤残缺空内容块后判定：
 *  - 残缺 = assistant 消息含未闭合 tool_use（toolUseIds 非空）或空内容
 *    （content 为 null/undefined、空白串、或块数组过滤后无实质块——空块
 *    定义：null/undefined、空白串、无键空对象）；
 *  - 残缺 → 生成规范提醒（INTERRUPTION_NOTICE_TEXT，逐字钉死）；
 *  - 完整轮 → { text: "", interrupted: false }，不注入。
 *
 * InterruptionInjector：一次性消费托管。offer 登记截断轮（新证据覆盖旧
 * 待发提醒——后续完整轮意味着上一提醒已过期，裁定），take 取走即清空。
 * 注入位置契约：组装方把 take() 的文本作为下一轮 user 消息之前的独立
 * user 消息注入；本卡只生成与托管，不做消息数组拼接（与 BI-10.1 同哲学）。
 */

/** 规范提醒文案（工单钉死，逐字断言基准）。 */
export const INTERRUPTION_NOTICE_TEXT =
  "The previous turn was interrupted by the user before completion. " +
  "Resume the task from the last verified state; do not apologize.";

/** 中断轮描述：被 Ctrl+C 打断的 assistant 消息。 */
export interface InterruptedTurn {
  role: 'assistant';
  content: unknown;
  /** 该轮已发出的 tool_use id 列表；非空即视为含未闭合 tool_use。 */
  toolUseIds?: readonly string[];
}

export interface InterruptionNotice {
  /** 规范提醒文案（残缺时非空；完整轮为空串） */
  text: string;
  /** 是否判定为残缺轮（残缺才注入） */
  interrupted: boolean;
}

/** 空块判定：null/undefined、空白串、无键空对象。 */
function isEmptyBlock(block: unknown): boolean {
  if (block === null || block === undefined) return true;
  if (typeof block === "string") return block.trim() === "";
  if (typeof block === "object" && !Array.isArray(block)) {
    return Object.keys(block as Record<string, unknown>).length === 0;
  }
  return false;
}

/** 空内容判定：null/undefined、空白串、或块数组过滤空块后无实质块。 */
function isEmptyContent(content: unknown): boolean {
  if (content === null || content === undefined) return true;
  if (typeof content === "string") return content.trim() === "";
  if (Array.isArray(content)) {
    return !content.some((b) => !isEmptyBlock(b));
  }
  return false; // 其余形态（有键对象等）视为有内容
}

/**
 * 构建中断提醒：过滤残缺空内容块后判定并生成规范提醒（纯函数）。
 * 残缺判定 = 含未闭合 tool_use（toolUseIds 非空）或空内容。
 */
export function buildInterruptionNotice(turn: InterruptedTurn): InterruptionNotice {
  const unclosedToolUse = turn.toolUseIds !== undefined && turn.toolUseIds.length > 0;
  const interrupted = unclosedToolUse || isEmptyContent(turn.content);
  if (!interrupted) return { text: "", interrupted: false };
  return { text: INTERRUPTION_NOTICE_TEXT, interrupted: true };
}

/** 一次性消费托管器：offer 登记、take 取走即清空。 */
export class InterruptionInjector {
  private pendingText: string | null = null;

  /**
   * 登记截断轮：残缺 → 规范提醒成为待发（覆盖旧待发）；完整轮 → 清空待发
   * （裁定：后续完整轮意味着上一提醒已过期）。返回是否产生待发提醒。
   */
  offer(turn: InterruptedTurn): boolean {
    const notice = buildInterruptionNotice(turn);
    this.pendingText = notice.interrupted ? notice.text : null;
    return this.pendingText !== null;
  }

  /** 一次性消费：返回待发提醒文本并清空；无待发 → null。 */
  take(): string | null {
    const text = this.pendingText;
    this.pendingText = null;
    return text;
  }

  /** 是否有待发提醒。 */
  get hasPending(): boolean {
    return this.pendingText !== null;
  }
}
