/**
 * BI-08.2 · 图像渐进卸载器（offloadOldestImages）——纯内容层变换，零 IO 零依赖。
 *
 * 职责（工单钉死）：识别消息历史中最早未卸载的多模态图片块（image 类型
 * content 块），就地标记 offloaded 并替换为占位符
 * `[Image omitted to conserve context window]`，释放上下文窗口中的 base64
 * 图像负载；卸载记录 { index, byteSize } 供统计。
 *
 * 结构不变式（钉死，验收核心）：
 * - Session 事件序列不被破坏：消息数量、消息顺序、消息对象引用、每条消息
 *   content 数组的 entry 数全部保持原样；
 * - 消息深度优先索引不被破坏：index = 跨消息按深度优先序枚举内容块的
 *   0 基稳定序号（嵌套 tool_result 之类携带 content 数组的块向内递归），
 *   本函数只替换 image 槽位上的块对象，不增删不移任何 entry；
 * - 非 image 块一律原引用保留（toBe 级不变）。
 *
 * 替换形态（裁定）：image 块所在槽位整体替换为轻量文本块
 * `{ type: "text", text: 占位符, offloaded: true }`——type 保持可序列化安全
 * （下游不会遇到"声明为 image 却无数据"的畸形块），offloaded 标记使重入
 * 天然幂等（文本块不再是 image 块，二次调用自动跳过）。
 *
 * byteSize 统计口径（钉死）：取块内 inline base64 负载（block.source.data 或
 * block.data 字符串）按标准 base64 解码字节数（去 '=' 后 floor(len*3/4)，
 * padding 修正）；无 inline 负载（如 file 引用型块）记 0（未知不虚报）。
 *
 * keepRecentN 语义（钉死）：深度优先序末尾 N 张未卸载图像保留（最近优先
 * 存活），其余全部按最旧优先卸载；缺省 0（全部可卸载）；非整数/负数/非有限
 * 抛 RangeError（对齐 gateMedia 校验风格）。
 */

/** 卸载占位符文本（工单钉死格式）。 */
export const IMAGE_OFFLOAD_PLACEHOLDER = "[Image omitted to conserve context window]";

/** 单次卸载记录：index = 深度优先内容块索引，byteSize = 原图像负载字节数。 */
export interface OffloadRecord {
  readonly index: number;
  readonly byteSize: number;
}

export interface OffloadOptions {
  /** 保留最近 N 张未卸载图像（深度优先序末尾 N 张）。缺省 0。 */
  readonly keepRecentN?: number;
  /** 每卸载一张回调一次（最旧优先；抛错则中断且不回滚——调用方自决）。 */
  readonly onOffload?: (record: OffloadRecord) => void;
}

/** 待卸载图像块的内部定位：容器数组 + 槽位 + 深度优先索引。 */
interface ImageSlot {
  readonly index: number;
  readonly container: unknown[];
  readonly position: number;
  readonly byteSize: number;
}

/**
 * 计算 base64 字符串的解码字节数（padding 修正）：
 * 去 '=' 尾后 floor(len*3/4)。"AAAA"→3、"AAA="→2、"AA=="→1、""→0。
 */
function decodedBase64Size(data: string): number {
  let end = data.length;
  while (end > 0 && data.charCodeAt(end - 1) === 61 /* '=' */) end--;
  return Math.floor((end * 3) / 4);
}

/** 提取 image 块的 inline base64 负载字节数；无负载记 0。 */
function imageByteSize(block: Record<string, unknown>): number {
  const source = block["source"];
  if (typeof source === "object" && source !== null) {
    const data = (source as Record<string, unknown>)["data"];
    if (typeof data === "string") return decodedBase64Size(data);
  }
  const direct = block["data"];
  if (typeof direct === "string") return decodedBase64Size(direct);
  return 0;
}

/** 判定一个 content 块是否为 image 类型块（鸭子类型：对象 + type==="image"）。 */
function isImageBlock(block: unknown): block is Record<string, unknown> {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as Record<string, unknown>)["type"] === "image"
  );
}

/**
 * 深度优先枚举所有内容块，收集 image 块槽位。
 * 计数口径：每个被访问的块（含非 image 块）都占一个深度优先序号；
 * 块携带数组型 content（tool_result 形态）时向内递归，序号跨消息连续。
 */
function collectImageSlots(messages: unknown[]): ImageSlot[] {
  const slots: ImageSlot[] = [];
  let index = 0;

  const walkBlocks = (blocks: unknown[], container: unknown[]): void => {
    for (let position = 0; position < blocks.length; position++) {
      const block = blocks[position];
      const current = index++;
      if (isImageBlock(block)) {
        slots.push({ index: current, container, position, byteSize: imageByteSize(block) });
      }
      // 嵌套 content（tool_result / 多层包装形态）：深度优先向内。
      if (typeof block === "object" && block !== null) {
        const nested = (block as Record<string, unknown>)["content"];
        if (Array.isArray(nested)) walkBlocks(nested, nested);
      }
    }
  };

  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const content = (message as Record<string, unknown>)["content"];
    if (Array.isArray(content)) walkBlocks(content, content);
  }
  return slots;
}

/**
 * 图像渐进卸载（就地变换）。见文件头注释（结构不变式 / 替换形态 / 语义钉死）。
 *
 * @returns 本次调用实际发生的卸载记录（最旧优先），未发生卸载返回 []。
 * @throws RangeError 当 keepRecentN 非整数、负数或非有限数。
 */
export function offloadOldestImages(messages: unknown[], opts: OffloadOptions = {}): OffloadRecord[] {
  const keepRecentN = opts.keepRecentN ?? 0;
  if (!Number.isFinite(keepRecentN) || !Number.isInteger(keepRecentN) || keepRecentN < 0) {
    throw new RangeError(`keepRecentN must be a non-negative integer, got ${String(opts.keepRecentN)}`);
  }

  const slots = collectImageSlots(messages);
  // 末尾 keepRecentN 张保留（最近存活），其余按最旧优先卸载。
  const keepCount = Math.min(keepRecentN, slots.length);
  const offloadCount = slots.length - keepCount;
  if (offloadCount <= 0) return [];

  const records: OffloadRecord[] = [];
  for (let i = 0; i < offloadCount; i++) {
    const slot = slots[i] as ImageSlot;
    // 只替换 image 槽位内容，entry 数与顺序原样（结构不变式）。
    slot.container[slot.position] = {
      type: "text",
      text: IMAGE_OFFLOAD_PLACEHOLDER,
      offloaded: true,
    };
    const record: OffloadRecord = { index: slot.index, byteSize: slot.byteSize };
    records.push(record);
    opts.onOffload?.(record);
  }
  return records;
}
