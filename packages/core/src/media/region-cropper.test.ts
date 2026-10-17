/**
 * BI-08.3 · region-cropper 字节级媒体检视测试（手造字节 fixture，零真实媒体）。
 *
 * 钉死语义（与 region-cropper.ts 文件头注释一一对应）：
 * - PNG：8 字节签名 + 首块 IHDR，宽高 BE32（offset 16/20）；
 * - JPEG：SOI + 标记扫描，SOF 段 height 在前 width 在后（BE16）；
 * - 字节级裁剪 = 完整原文件原引用直出 + region 元数据标注；
 * - region 四元组整数坐标，越界/退化/非法形态 RangeError。
 */
import { describe, expect, test } from "bun:test";
import {
  REGION_CROP_NOTE,
  cropRegion,
  inspectMedia,
  parseRegion,
} from "./region-cropper";

/** 手造 PNG 字节：签名 + IHDR（data 长 13：宽高 + 5 字节像素描述）+ CRC 占位。 */
function pngBytes(width: number, height: number): Uint8Array {
  const out = new Uint8Array(33);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(8, 13, false); // IHDR data length
  out.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  dv.setUint32(16, width, false);
  dv.setUint32(20, height, false);
  out[24] = 8; // bit depth
  out[25] = 6; // color type RGBA
  return out;
}

/** 手造 JPEG 字节：SOI + [APP0] + SOF 标记段 + EOI。 */
function jpegBytes(
  width: number,
  height: number,
  opts: { sof?: number; withApp0?: boolean } = {},
): Uint8Array {
  const sof = opts.sof ?? 0xc0;
  const parts: number[][] = [[0xff, 0xd8]];
  if (opts.withApp0 !== false) {
    // APP0/JFIF：段长 16（含自身 2 字节）。
    parts.push([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  }
  // SOF 段：precision 8 + height + width + 1 分量（段长 11 含长度域自身）。
  parts.push([0xff, sof, 0x00, 0x0b, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x01, 0x01, 0x00, 0x00]);
  parts.push([0xff, 0xd9]); // EOI
  return new Uint8Array(parts.flat());
}

describe("inspectMedia · PNG IHDR 头解析", () => {
  test("PNG 签名 + IHDR：宽高按大端解析，kind/mimeType 正确", () => {
    const inspection = inspectMedia(pngBytes(3, 2));
    expect(inspection).toEqual({ kind: "png", mimeType: "image/png", dimensions: { width: 3, height: 2 } });
  });

  test("PNG 宽高大端序边界：0x00010000 = 65536", () => {
    const inspection = inspectMedia(pngBytes(0x00010000, 0x00000100));
    expect(inspection?.dimensions).toEqual({ width: 65536, height: 256 });
  });

  test("PNG 签名对但首块类型不是 IHDR（手造 'JFXX'）→ null", () => {
    const bytes = pngBytes(3, 2);
    bytes.set([0x4a, 0x46, 0x58, 0x58], 12); // "JFXX"
    expect(inspectMedia(bytes)).toBeNull();
  });

  test("PNG 截断（不足 24 字节无法容纳 IHDR 宽高）→ null", () => {
    expect(inspectMedia(pngBytes(3, 2).slice(0, 23))).toBeNull();
  });
});

describe("inspectMedia · JPEG SOF 标记扫描", () => {
  test("JPEG SOF0：段内 height 在前 width 在后，解析结果 {width, height} 正确", () => {
    const inspection = inspectMedia(jpegBytes(8, 4));
    expect(inspection).toEqual({ kind: "jpeg", mimeType: "image/jpeg", dimensions: { width: 8, height: 4 } });
  });

  test("JPEG SOF2（progressive）同布局兼容识别", () => {
    const inspection = inspectMedia(jpegBytes(8, 4, { sof: 0xc2 }));
    expect(inspection?.dimensions).toEqual({ width: 8, height: 4 });
  });

  test("JPEG 无 APP0 直接 SOF0 亦可解析", () => {
    const inspection = inspectMedia(jpegBytes(8, 4, { withApp0: false }));
    expect(inspection?.dimensions).toEqual({ width: 8, height: 4 });
  });

  test("JPEG SOI 后直接 EOI（无 SOF 段）→ null", () => {
    expect(inspectMedia(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  });

  test("JPEG 段长非法（length < 2）→ null", () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0xff, 0xd9]);
    expect(inspectMedia(bytes)).toBeNull();
  });

  test("非媒体字节（纯文本）与空流 → null", () => {
    expect(inspectMedia(new TextEncoder().encode("plain text, not media"))).toBeNull();
    expect(inspectMedia(new Uint8Array([]))).toBeNull();
  });

  test("GIF/WebP 签名不误判为 PNG/JPEG（字节层范围锁定）", () => {
    expect(inspectMedia(new TextEncoder().encode("GIF89a...."))).toBeNull();
    expect(inspectMedia(new TextEncoder().encode("RIFF....WEBP"))).toBeNull();
  });
});

describe("cropRegion · 字节级裁剪与 region 校验", () => {
  test("region 合法：bytes 原引用直出（未重编码）、region 回显、note 为字节级声明", () => {
    const bytes = pngBytes(3, 2);
    const result = cropRegion(bytes, [1, 0, 3, 2]);
    expect(result.bytes).toBe(bytes); // 原引用（同一对象）
    expect(result.region).toEqual([1, 0, 3, 2]);
    expect(result.dimensions).toEqual({ width: 3, height: 2 });
    expect(result.note).toBe(REGION_CROP_NOTE);
  });

  test("region 越界（x2 > width / y2 > height）→ RangeError 且信息携带固有尺寸", () => {
    expect(() => cropRegion(pngBytes(3, 2), [0, 0, 4, 2])).toThrow(/3x2/);
    expect(() => cropRegion(pngBytes(3, 2), [0, 0, 3, 3])).toThrow(RangeError);
  });

  test("region 区间退化（x1 >= x2 / y1 >= y2）与负坐标 → RangeError", () => {
    expect(() => cropRegion(pngBytes(3, 2), [2, 0, 2, 2])).toThrow(RangeError);
    expect(() => cropRegion(pngBytes(3, 2), [2, 0, 1, 2])).toThrow(RangeError);
    expect(() => cropRegion(pngBytes(3, 2), [-1, 0, 2, 2])).toThrow(RangeError);
  });

  test("非 PNG/JPEG 字节无法取得校验基准尺寸 → RangeError", () => {
    expect(() => cropRegion(new TextEncoder().encode("not media"), [0, 0, 1, 1])).toThrow(RangeError);
  });

  test("parseRegion：3 元组 / 非数字 / 浮点坐标 / 非数组 → RangeError", () => {
    expect(() => parseRegion([0, 0, 1])).toThrow(RangeError);
    expect(() => parseRegion([0, 0, 1, "2"])).toThrow(RangeError);
    expect(() => parseRegion([0.5, 0, 1, 1])).toThrow(RangeError);
    expect(() => parseRegion("0,0,1,1")).toThrow(RangeError);
    expect(() => parseRegion([0, 0, 1, 1])).not.toThrow();
  });
});
