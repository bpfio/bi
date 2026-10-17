/**
 * BI-08.3 · ReadMediaFile 多模态检视 handler——fs 注入 + 纯字节/元数据层。
 *
 * 职责（工单钉死）：读取媒体文件（fs 注入）→ `<system>` 结构化元数据
 * （MimeType / 字节数 / 原始宽高像素——PNG IHDR、JPEG SOF0 纯字节头解析，
 * 复用 media/region-cropper 的 inspectMedia）+ base64 数据直出或 region
 * 裁剪（字节级 = 完整原文件 + region 元数据标注）+ fullResolution 全分辨率
 * 直出开关。
 *
 * 校验顺序（钉死，fail-fast 且不含 IO 的检查先行）：
 *   1. args 形态：path 非空字符串、fullResolution 布尔 → 否则 invalid-args；
 *   2. region 形态：4 元整数组 → 否则 invalid-region（不发 IO）；
 *   3. 读取：ENOENT → not-found；EACCES/EPERM/其余 → not-readable；
 *   4. 字节上限：bytes > maxBytes（默认 10,000,000 十进制）→ too-large；
 *   5. 媒体嗅探：非 PNG/JPEG 或头损坏 → not-media（fail-closed，本卡字节层
 *      仅支持 PNG/JPEG，其余格式归后续扩展）；
 *   6. region 越界（对照解析出的固有尺寸）→ invalid-region；
 *   7. 放行 → ok。
 *
 * 交付语义（字节层裁定）：字节级实现不做任何降采样/重编码——
 *   - region 命中 → delivery "region-annotated"，bytes/base64 仍为完整原文件，
 *     region 以元数据标注（note 声明像素裁剪归后续原生 codec 增强）；
 *   - fullResolution=true → delivery "full-resolution"（直出全分辨率原文件）；
 *   - 缺省 → delivery "inline-base64"。三者在本字节层交付同一份原文件字节，
 *     delivery 差异供模型/调用方与未来原生 codec 层（降采样）消歧。
 */

import { Buffer } from "node:buffer";
import { cropRegion, inspectMedia, parseRegion, REGION_CROP_NOTE, type MediaRegion } from "../../media/region-cropper";

/** 注入的文件读取端口（存在/可读校验由错误映射承担）。 */
export interface FsPort {
  readFile(path: string): Promise<Uint8Array>;
}

/** region 四元组：[x1, y1, x2, y2] 原始像素坐标。 */
export type MediaRegionArg = MediaRegion;

export interface ReadMediaFileArgs {
  /** 媒体文件路径（透传给注入 fs，不做路径改写）。 */
  path: string;
  /** 局部高精检视区域 [x1, y1, x2, y2] 原始像素坐标（可选）。 */
  region?: MediaRegionArg;
  /** 全分辨率直出开关（可选；字节层恒直出原文件，仅 delivery 消歧）。 */
  fullResolution?: boolean;
}

/** 默认字节上限：10MB（十进制 10,000,000 字节）。 */
export const DEFAULT_READ_MEDIA_MAX_BYTES = 10_000_000;

export interface ReadMediaFileDeps {
  /** 注入 fs 端口。 */
  readonly fs: FsPort;
  /** 字节上限，缺省 DEFAULT_READ_MEDIA_MAX_BYTES；非整数/负数抛 RangeError。 */
  readonly maxBytes?: number;
}

/** 交付方式：region 标注 / 全分辨率直出 / 缺省 base64 直出。 */
export type ReadMediaDelivery = "region-annotated" | "full-resolution" | "inline-base64";

export interface ReadMediaMetadata {
  readonly mimeType: "image/png" | "image/jpeg";
  /** 文件字节数。 */
  readonly bytes: number;
  /** 原始宽度（像素）。 */
  readonly width: number;
  /** 原始高度（像素）。 */
  readonly height: number;
  readonly delivery: ReadMediaDelivery;
  /** region 命中时的元数据标注（含派生宽高）。 */
  readonly region?: {
    readonly x1: number;
    readonly y1: number;
    readonly x2: number;
    readonly y2: number;
    readonly width: number;
    readonly height: number;
  };
  /** region 命中时的字节级边界声明。 */
  readonly note?: string;
}

/** 结构化失败码（钉死六类）。 */
export type ReadMediaErrorCode =
  | "invalid-args"
  | "invalid-region"
  | "not-found"
  | "not-readable"
  | "not-media"
  | "too-large";

export type ReadMediaFileResult =
  | {
      readonly ok: true;
      readonly metadata: ReadMediaMetadata;
      /** 直接可嵌入工具输出的 `<system>` 结构化元数据段。 */
      readonly systemTag: string;
      /** 完整原文件的 base64 编码。 */
      readonly base64: string;
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: ReadMediaErrorCode; readonly message: string };
    };

/** 构造 `<system>` 结构化元数据段（行格式钉死，保证可断言）。 */
function buildSystemTag(metadata: ReadMediaMetadata): string {
  const lines: string[] = [
    "<system>",
    `mime: ${metadata.mimeType}`,
    `bytes: ${metadata.bytes}`,
    `dimensions: ${metadata.width}x${metadata.height}`,
    `delivery: ${metadata.delivery}`,
  ];
  if (metadata.region) {
    const r = metadata.region;
    lines.push(`region: [${r.x1}, ${r.y1}, ${r.x2}, ${r.y2}] (${r.width}x${r.height} px)`);
  }
  if (metadata.note) {
    lines.push(`note: ${metadata.note}`);
  }
  lines.push("</system>");
  return lines.join("\n");
}

/** fs 错误 → 结构化失败码（存在/可读两类）。 */
function mapFsError(err: unknown): { code: Extract<ReadMediaErrorCode, "not-found" | "not-readable">; message: string } {
  const code = (err as { code?: unknown } | null | undefined)?.["code"];
  const detail = err instanceof Error ? err.message : String(err);
  if (code === "ENOENT") {
    return { code: "not-found", message: `file not found: ${detail}` };
  }
  return { code: "not-readable", message: `file not readable: ${detail}` };
}

/**
 * ReadMediaFile 多模态检视。见文件头注释（校验顺序 / 交付语义 / 边界声明）。
 *
 * @returns 判别联合：ok=true 携带 metadata + systemTag + base64；
 *   ok=false 携带结构化错误（六类码）。
 * @throws TypeError deps.fs 缺失或 readFile 不可调用（编程错误，不结构化）。
 * @throws RangeError deps.maxBytes 非整数/负数（编程错误，对齐 gateMedia）。
 */
export async function readMediaFile(args: ReadMediaFileArgs, deps: ReadMediaFileDeps): Promise<ReadMediaFileResult> {
  if (typeof deps?.fs?.readFile !== "function") {
    throw new TypeError("readMediaFile requires an injected fs port with readFile(path)");
  }
  const maxBytes = deps.maxBytes ?? DEFAULT_READ_MEDIA_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(`maxBytes must be a non-negative integer, got ${String(deps.maxBytes)}`);
  }

  // 1. args 形态校验（零 IO 先行）。
  if (typeof args?.path !== "string" || args.path.length === 0) {
    return { ok: false, error: { code: "invalid-args", message: `path must be a non-empty string, got ${JSON.stringify(args?.path)}` } };
  }
  if (args.fullResolution !== undefined && typeof args.fullResolution !== "boolean") {
    return { ok: false, error: { code: "invalid-args", message: `fullResolution must be a boolean, got ${typeof args.fullResolution}` } };
  }

  // 2. region 形态校验（零 IO 先行）。
  let region: MediaRegion | undefined;
  if (args.region !== undefined) {
    try {
      region = parseRegion(args.region);
    } catch (err) {
      return { ok: false, error: { code: "invalid-region", message: (err as Error).message } };
    }
  }

  // 3. 读取（注入 fs）。
  let bytes: Uint8Array;
  try {
    bytes = await deps.fs.readFile(args.path);
  } catch (err) {
    const mapped = mapFsError(err);
    return { ok: false, error: mapped };
  }

  // 4. 字节上限。
  if (bytes.length > maxBytes) {
    return {
      ok: false,
      error: { code: "too-large", message: `media file is ${bytes.length} bytes, exceeds maxBytes ${maxBytes}` },
    };
  }

  // 5. 媒体嗅探（fail-closed：非 PNG/JPEG 一律 not-media）。
  const inspection = inspectMedia(bytes);
  if (inspection === null) {
    return {
      ok: false,
      error: {
        code: "not-media",
        message: `not a supported media file (byte-level layer supports PNG/JPEG only, got ${bytes.length} bytes)`,
      },
    };
  }

  // 6. region 越界校验（对照解析出的固有尺寸；cropRegion 内含同规则校验）。
  let regionMeta: ReadMediaMetadata["region"];
  let note: string | undefined;
  if (region) {
    let cropped: ReturnType<typeof cropRegion>;
    try {
      cropped = cropRegion(bytes, region);
    } catch (err) {
      return { ok: false, error: { code: "invalid-region", message: (err as Error).message } };
    }
    const [x1, y1, x2, y2] = cropped.region;
    regionMeta = { x1, y1, x2, y2, width: x2 - x1, height: y2 - y1 };
    note = REGION_CROP_NOTE;
  }

  // 7. 放行：组装元数据 + <system> 段 + base64 直出。
  const metadata: ReadMediaMetadata = {
    mimeType: inspection.mimeType,
    bytes: bytes.length,
    width: inspection.dimensions.width,
    height: inspection.dimensions.height,
    delivery: regionMeta ? "region-annotated" : args.fullResolution === true ? "full-resolution" : "inline-base64",
    ...(regionMeta ? { region: regionMeta, note } : {}),
  };
  return {
    ok: true,
    metadata,
    systemTag: buildSystemTag(metadata),
    base64: Buffer.from(bytes).toString("base64"),
  };
}
