/**
 * BI-08 · 端侧媒体门禁（gateMedia）——零依赖尺寸 + MIME 白名单双重门禁。
 *
 * 范围裁定（工单钉死）：本卡**只做元数据级门禁**（字节数 + MIME 类型），
 * 不做像素级降采样/重编码——那需要原生图像 codec（libpng/libjpeg 等），
 * 零外部依赖约束下不可行，归 BI-08.3 ReadMediaFile 决策卡接管。本卡在
 * 超限/未知类型时以占位文本替换媒体数据（fail-closed），data 不外泄。
 *
 * 决策顺序（钉死，工单 c 条"未知 mime → placeholder"须先于 a 条放行，
 * 否则小体积未知类型会漏过白名单）：
 *   1. MIME 白名单：默认 image/png | image/jpeg | image/webp | gif（可配）。
 *      不在名单 → placeholder（fail-closed，无论体积大小），占位文本注明
 *      不支持的类型。
 *   2. 尺寸预算：data 字节数 ≤ budget（默认 25KB = 25,000 字节，十进制，
 *      与验收边界 25000/25001 对齐）→ passthrough；超限 → placeholder，
 *      占位文本格式：`[Image omitted: 84.5KB exceeds 25KB budget (image/png)]`。
 *
 * 字节量格式化规则（钉死，保证占位文本确定性）：
 * - < 1,000 → `${n}B`；< 1,000,000 → `${(n/1000) 保留 1 位小数}KB`（整数值
 *   去掉 ".0" 后缀，故 25,000 → "25KB"、84,500 → "84.5KB"）；其余同理 MB。
 * - MIME 大小写不敏感（image/PNG 视同 image/png）；其余逐字符精确匹配。
 *
 * 边界行为（钉死）：恰好等于预算 → passthrough；0 字节媒体 → passthrough
 * （本卡不解码内容，损坏数据由上层渲染兜底）；kind 仅支持 "image"，未来
 * 音频/视频种类由后续卡扩展输入联合类型。
 */

/** 默认尺寸预算：25KB，按十进制 25,000 字节（工单验收边界 25000/25001）。 */
export const DEFAULT_MEDIA_BUDGET_BYTES = 25_000;

/** 默认图像 MIME 白名单（工单钉死四类）。 */
export const DEFAULT_ALLOWED_IMAGE_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

/** 门禁输入（BI-08 仅图像；后续卡扩展 kind 联合）。 */
export interface MediaGateInput {
  readonly kind: "image";
  /** 原始媒体字节。 */
  readonly data: Uint8Array;
  /** 声明的 MIME 类型。 */
  readonly mimeType: string;
}

/** gateMedia 选项（budget / 白名单均可配）。 */
export interface MediaGateOptions {
  /** 字节预算，默认 25,000；非有限数或 < 0 抛 RangeError。 */
  readonly budgetBytes?: number;
  /** MIME 白名单，默认 DEFAULT_ALLOWED_IMAGE_MIME_TYPES。 */
  readonly allowedMimeTypes?: readonly string[];
}

/** 放行：调用方继续使用原始 data（本结果不携带 data，避免重复持有）。 */
export interface MediaPassthroughResult {
  readonly action: "passthrough";
}

/** 拦截：以 placeholder 文本替换媒体，meta 供上层审计；data 不出现在结果中。 */
export interface MediaPlaceholderResult {
  readonly action: "placeholder";
  /** 直接可嵌入模型消息的占位文本。 */
  readonly placeholder: string;
  readonly meta: {
    /** 原始字节数。 */
    readonly bytes: number;
    /** 声明的 MIME 类型（原样回显）。 */
    readonly mimeType: string;
  };
}

/** gateMedia 结果：按 action 判别。 */
export type MediaGateResult = MediaPassthroughResult | MediaPlaceholderResult;

/**
 * 字节量人性化格式：< 1,000 → "750B"；< 1,000,000 → 1 位小数 KB（整数去
 * ".0"，如 "25KB"/"84.5KB"）；其余 1 位小数 MB（同规则）。
 */
export function formatByteSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes}B`;
  if (bytes < 1_000_000) return trimDecimal(bytes / 1_000) + "KB";
  return trimDecimal(bytes / 1_000_000) + "MB";
}

/** 保留 1 位小数，整数值去掉 ".0" 后缀（25 → "25"，84.5 → "84.5"）。 */
function trimDecimal(value: number): string {
  const fixed = value.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

/**
 * 端侧媒体门禁（纯决策，零 IO、零依赖）。见文件头注释（决策顺序/格式规则）。
 *
 * @throws RangeError 当 budgetBytes 非有限数或 < 0。
 */
export function gateMedia(input: MediaGateInput, options: MediaGateOptions = {}): MediaGateResult {
  const budgetBytes = options.budgetBytes ?? DEFAULT_MEDIA_BUDGET_BYTES;
  if (!Number.isFinite(budgetBytes) || budgetBytes < 0) {
    throw new RangeError(`budgetBytes must be a finite number >= 0, got ${String(budgetBytes)}`);
  }
  const allowed = options.allowedMimeTypes ?? DEFAULT_ALLOWED_IMAGE_MIME_TYPES;
  const bytes = input.data.length;
  const mimeType = input.mimeType;

  // 决策 1：MIME 白名单先行（fail-closed）——小体积未知类型同样拦截，
  // 且超限 + 未知类型并存时优先报告类型问题（更本质的拒绝原因）。
  const normalized = mimeType.toLowerCase();
  if (!allowed.some((entry) => entry.toLowerCase() === normalized)) {
    return {
      action: "placeholder",
      placeholder: `[Image omitted: unsupported media type '${mimeType}' (allowlist: ${allowed.join(", ")})]`,
      meta: { bytes, mimeType },
    };
  }

  // 决策 2：尺寸预算（恰好等于预算放行）。
  if (bytes <= budgetBytes) {
    return { action: "passthrough" };
  }
  return {
    action: "placeholder",
    placeholder: `[Image omitted: ${formatByteSize(bytes)} exceeds ${formatByteSize(budgetBytes)} budget (${mimeType})]`,
    meta: { bytes, mimeType },
  };
}
