/**
 * BI-08.3 · region 裁剪器（字节级实现）——纯字节/元数据层，零 IO 零依赖。
 *
 * 职责（工单钉死）：
 * - 媒体字节嗅探：PNG 签名 + IHDR 宽高（大端 BE32）、JPEG SOI + SOF0 标记
 *   扫描（SOF 段布局：precision(1) + height(2 BE) + width(2 BE)，height 在
 *   前 width 在后；同布局的 SOF1/SOF2 兼容识别，跳过 DHT/JPG/DAC）；
 * - region 参数校验：`[x1, y1, x2, y2]` 原始像素坐标（devplan 钉死形态），
 *   整数、0 ≤ x1 < x2 ≤ width、0 ≤ y1 < y2 ≤ height；
 * - 字节级裁剪实现 = 提取完整原文件字节（原引用直出，未重编码）+ region
 *   元数据标注。
 *
 * 边界声明（doc，钉死）：PNG/JPEG 无原生 codec 无法重编码出行级裁剪像素，
 * 像素级裁剪与缩放归后续原生增强（native codec 层）；本模块交付的
 * bytes 恒为完整原文件，region 仅以元数据标注（REGION_CROP_NOTE）。
 */

/** 字节级边界声明（随 region 结果向调用方/模型透出）。 */
export const REGION_CROP_NOTE =
  "byte-level implementation: pixel-level cropping requires a native image codec (future native enhancement); full original bytes are returned with region annotation only";

/** PNG 签名（8 字节魔数）。 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** 已识别的媒体种类（本卡字节层仅 PNG/JPEG；其余格式归后续扩展）。 */
export type MediaKind = "png" | "jpeg";

/** 媒体固有尺寸（像素）。 */
export interface MediaDimensions {
  readonly width: number;
  readonly height: number;
}

/** 媒体检视结果：种类 + MIME + 尺寸。 */
export interface MediaInspection {
  readonly kind: MediaKind;
  readonly mimeType: "image/png" | "image/jpeg";
  readonly dimensions: MediaDimensions;
}

/** region 四元组：[x1, y1, x2, y2] 原始像素坐标（左上/右下，右下开区间）。 */
export type MediaRegion = readonly [number, number, number, number];

/** BE16 大端读取。 */
function readBE16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

/** BE32 大端读取。 */
function readBE32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!
  );
}

/** 解析 PNG IHDR 宽高；签名/首块不合规或尺寸非正 → null。 */
function parsePng(bytes: Uint8Array): MediaInspection | null {
  if (bytes.length < 24) return null;
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }
  // 首块必须是 IHDR：offset 8..11 = 块长（≥8），12..15 = "IHDR"。
  if (readBE32(bytes, 8) < 8) return null;
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const width = readBE32(bytes, 16);
  const height = readBE32(bytes, 20);
  if (width <= 0 || height <= 0) return null;
  return { kind: "png", mimeType: "image/png", dimensions: { width, height } };
}

/** 解析 JPEG SOF 段宽高（标记扫描，段长跳进）；无 SOF/结构截断 → null。 */
function parseJpeg(bytes: Uint8Array): MediaInspection | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let pos = 2;
  while (pos + 1 < bytes.length) {
    // 标记码：0xFF 填充字节可重复。
    if (bytes[pos] !== 0xff) return null;
    let marker = bytes[pos + 1]!;
    while (marker === 0xff && pos + 2 < bytes.length) {
      pos++;
      marker = bytes[pos + 1]!;
    }
    if (marker === 0xff) return null;
    // 独立标记（TEM/RSTn/SOI）：无长度字段。
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      if (marker === 0xd9) return null; // EOI 先于 SOF：无图像尺寸。
      pos += 2;
      continue;
    }
    // 段标记：2 字节段长（含自身）。
    if (pos + 4 > bytes.length) return null;
    const length = readBE16(bytes, pos + 2);
    if (length < 2) return null;
    // SOF0..SOF15（剔除 DHT/JPG/DAC）：precision(1)+height(2)+width(2)+…。
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (length < 8 || pos + 9 > bytes.length) return null;
      // JPEG SOF 段布局：height 在前、width 在后（与 PNG 相反）。
      const height = readBE16(bytes, pos + 5);
      const width = readBE16(bytes, pos + 7);
      if (width <= 0 || height <= 0) return null;
      return { kind: "jpeg", mimeType: "image/jpeg", dimensions: { width, height } };
    }
    pos += 2 + length;
  }
  return null;
}

/**
 * 字节级媒体检视：PNG/JPEG 签名 + 尺寸头解析（纯字节，不解码像素）。
 *
 * @returns 未识别或头损坏 → null（调用方按 not-media 处理，fail-closed）。
 */
export function inspectMedia(bytes: Uint8Array): MediaInspection | null {
  if (bytes.length >= 8 && bytes[0] === 0x89) return parsePng(bytes);
  if (bytes.length >= 2 && bytes[0] === 0xff) return parseJpeg(bytes);
  return null;
}

/**
 * region 形态校验：必须是 4 元数字组且全为整数，否则 RangeError
 * （不涉及媒体尺寸的越界检查——那需要先解析尺寸，由 cropRegion 负责）。
 */
export function parseRegion(region: unknown): MediaRegion {
  if (
    !Array.isArray(region) ||
    region.length !== 4 ||
    region.some((v) => typeof v !== "number" || !Number.isFinite(v))
  ) {
    throw new RangeError(`region must be a [x1, y1, x2, y2] tuple of finite numbers, got ${JSON.stringify(region)}`);
  }
  const [x1, y1, x2, y2] = region as readonly number[];
  if (![x1, y1, x2, y2].every((v) => Number.isInteger(v))) {
    throw new RangeError(`region coordinates must be integers (raw pixel coordinates), got ${JSON.stringify(region)}`);
  }
  return [x1!, y1!, x2!, y2!] as const;
}

export interface RegionCropResult {
  /** 完整原文件字节（原引用直出，未重编码——字节级边界声明见 note）。 */
  readonly bytes: Uint8Array;
  /** region 原样回显（校验通过后）。 */
  readonly region: MediaRegion;
  /** 媒体固有尺寸（像素）。 */
  readonly dimensions: MediaDimensions;
  /** 字节级实现的边界声明（常量 REGION_CROP_NOTE）。 */
  readonly note: string;
}

/**
 * region 字节级裁剪：解析媒体尺寸 → 校验 region 越界 → 完整原文件字节 +
 * region 元数据标注。见文件头注释（像素级裁剪归后续原生增强）。
 *
 * @throws RangeError region 形态非法（parseRegion），或坐标越界/区间退化
 *   （错误信息携带媒体固有尺寸）。
 * @throws RangeError 字节流不是可识别的 PNG/JPEG（无法取得校验基准尺寸）。
 */
export function cropRegion(bytes: Uint8Array, region: MediaRegion): RegionCropResult {
  const inspection = inspectMedia(bytes);
  if (inspection === null) {
    throw new RangeError("cannot crop: bytes are not a recognizable PNG/JPEG media file (byte-level layer)");
  }
  const [x1, y1, x2, y2] = parseRegion(region);
  const { width, height } = inspection.dimensions;
  if (!(x1 >= 0 && y1 >= 0 && x1 < x2 && y1 < y2 && x2 <= width && y2 <= height)) {
    throw new RangeError(
      `region [${x1}, ${y1}, ${x2}, ${y2}] out of bounds for ${width}x${height} media (require 0 <= x1 < x2 <= width, 0 <= y1 < y2 <= height)`,
    );
  }
  return { bytes, region: [x1, y1, x2, y2] as const, dimensions: inspection.dimensions, note: REGION_CROP_NOTE };
}
