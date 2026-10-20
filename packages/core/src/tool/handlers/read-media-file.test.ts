/**
 * BI-08.3 · ReadMediaFile handler 测试（fs 全注入，零真实磁盘 IO）。
 *
 * 钉死语义（与 read-media-file.ts 文件头注释一一对应）：
 * - 校验顺序：args 形态 → region 形态（零 IO 先行）→ 读取 → maxBytes →
 *   媒体嗅探（fail-closed，仅 PNG/JPEG）→ region 越界 → 放行；
 * - `<system>` 段行格式钉死，全文可精确断言；
 * - 交付语义：字节层恒直出完整原文件，delivery 三态消歧
 *   （inline-base64 / full-resolution / region-annotated）。
 */
import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  DEFAULT_READ_MEDIA_MAX_BYTES,
  readMediaFile,
  type FsPort,
  type ReadMediaFileResult,
} from "./read-media-file";
import { REGION_CROP_NOTE } from "../../media/region-cropper";

/** 手造 PNG：签名 + IHDR（3x2）。导出供装配层测试复用（勿自造第二份 PNG fixture）。 */
export function pngBytes(width = 3, height = 2): Uint8Array {
  const out = new Uint8Array(33);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(8, 13, false);
  out.set([0x49, 0x48, 0x44, 0x52], 12);
  dv.setUint32(16, width, false);
  dv.setUint32(20, height, false);
  out[24] = 8;
  out[25] = 6;
  return out;
}

/** 手造 JPEG：SOI + SOF0（8x4）+ EOI。 */
function jpegBytes(width = 8, height = 4): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x01, 0x01, 0x00, 0x00,
    0xff, 0xd9,
  ]);
}

/** 注入 fs：记录调用路径；payload 为 Error 时模拟读失败。 */
function fsOf(payload: Uint8Array | Error, calls: string[] = []): FsPort {
  return {
    readFile: async (path: string) => {
      calls.push(path);
      if (payload instanceof Error) throw payload;
      return payload;
    },
  };
}

/** 断言便捷：收窄到 ok 分支。 */
function expectOk(result: ReadMediaFileResult): Extract<ReadMediaFileResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok=true, got ${JSON.stringify(result)}`);
  return result;
}

/** 断言便捷：收窄到失败分支。 */
function expectErr(result: ReadMediaFileResult): Extract<ReadMediaFileResult, { ok: false }> {
  if (result.ok) throw new Error(`expected ok=false, got ${JSON.stringify(result)}`);
  return result;
}

describe("readMediaFile · 读取与元数据", () => {
  test("PNG：ok=true，mime/bytes/dimensions/delivery 齐备，base64 可往返还原", async () => {
    const bytes = pngBytes(3, 2);
    const result = expectOk(await readMediaFile({ path: "/media/a.png" }, { fs: fsOf(bytes) }));
    expect(result.metadata.mimeType).toBe("image/png");
    expect(result.metadata.bytes).toBe(33);
    expect(result.metadata.width).toBe(3);
    expect(result.metadata.height).toBe(2);
    expect(result.metadata.delivery).toBe("inline-base64");
    // base64 往返：解码后与原字节逐位一致。
    expect(Buffer.from(result.base64, "base64").equals(Buffer.from(bytes))).toBe(true);
  });

  test("JPEG：SOF0 头解析，mime image/jpeg，尺寸 8x4", async () => {
    const result = expectOk(await readMediaFile({ path: "/m/b.jpg" }, { fs: fsOf(jpegBytes()) }));
    expect(result.metadata.mimeType).toBe("image/jpeg");
    expect(result.metadata.width).toBe(8);
    expect(result.metadata.height).toBe(4);
  });

  test("<system> 段全文精确匹配（行格式钉死）", async () => {
    const result = expectOk(await readMediaFile({ path: "/m/a.png" }, { fs: fsOf(pngBytes(3, 2)) }));
    expect(result.systemTag).toBe(
      ["<system>", "mime: image/png", "bytes: 33", "dimensions: 3x2", "delivery: inline-base64", "</system>"].join("\n"),
    );
  });

  test("fs 注入生效：readFile 收到的 path 与 args.path 一致", async () => {
    const calls: string[] = [];
    await readMediaFile({ path: "/media/pic.PNG" }, { fs: fsOf(pngBytes(), calls) });
    expect(calls).toEqual(["/media/pic.PNG"]);
  });

  test("fullResolution=true → delivery 'full-resolution'（字节层仍直出原文件）", async () => {
    const bytes = pngBytes();
    const result = expectOk(await readMediaFile({ path: "/m/a.png", fullResolution: true }, { fs: fsOf(bytes) }));
    expect(result.metadata.delivery).toBe("full-resolution");
    expect(result.base64.length).toBeGreaterThan(0);
  });
});

describe("readMediaFile · region 局部检视", () => {
  test("region 合法 → delivery 'region-annotated'，metadata.region 回显并派生宽高，note 为字节级声明", async () => {
    const result = expectOk(
      await readMediaFile({ path: "/m/a.png", region: [1, 0, 3, 2] }, { fs: fsOf(pngBytes(3, 2)) }),
    );
    expect(result.metadata.delivery).toBe("region-annotated");
    expect(result.metadata.region).toEqual({ x1: 1, y1: 0, x2: 3, y2: 2, width: 2, height: 2 });
    expect(result.metadata.note).toBe(REGION_CROP_NOTE);
    expect(result.systemTag).toContain("region: [1, 0, 3, 2] (2x2 px)");
    expect(result.systemTag).toContain(`note: ${REGION_CROP_NOTE}`);
  });

  test("region 越界（对照解析出的固有尺寸）→ invalid-region", async () => {
    const result = expectErr(await readMediaFile({ path: "/m/a.png", region: [0, 0, 9, 9] }, { fs: fsOf(pngBytes(3, 2)) }));
    expect(result.error.code).toBe("invalid-region");
    expect(result.error.message).toContain("3x2");
  });

  test("region 形态非法（3 元组/浮点）→ invalid-region，且零 IO（fs 未被调用）", async () => {
    const calls: string[] = [];
    const fs = fsOf(pngBytes(), calls);
    const r1 = await readMediaFile({ path: "/m/a.png", region: [0, 0, 1] as unknown as [number, number, number, number] }, { fs });
    const r2 = await readMediaFile({ path: "/m/a.png", region: [0.5, 0, 1, 1] }, { fs });
    expect(expectErr(r1).error.code).toBe("invalid-region");
    expect(expectErr(r2).error.code).toBe("invalid-region");
    expect(calls).toEqual([]); // fail-fast：不发 IO
  });
});

describe("readMediaFile · 路径与文件校验", () => {
  test("path 非法（空串/非字符串）→ invalid-args；fullResolution 非布尔 → invalid-args", async () => {
    const fs = fsOf(pngBytes());
    expect(expectErr(await readMediaFile({ path: "" }, { fs })).error.code).toBe("invalid-args");
    expect(expectErr(await readMediaFile({ path: 42 as unknown as string }, { fs })).error.code).toBe("invalid-args");
    expect(
      expectErr(await readMediaFile({ path: "/m/a.png", fullResolution: "yes" as unknown as boolean }, { fs })).error.code,
    ).toBe("invalid-args");
  });

  test("ENOENT → not-found；EACCES 与普通错误 → not-readable", async () => {
    const fs = fsOf(pngBytes());
    const enoent = expectErr(
      await readMediaFile({ path: "/gone.png" }, { fs: fsOf(Object.assign(new Error("no entry"), { code: "ENOENT" })) }),
    );
    expect(enoent.error.code).toBe("not-found");
    const eacces = expectErr(
      await readMediaFile({ path: "/secret.png" }, { fs: fsOf(Object.assign(new Error("denied"), { code: "EACCES" })) }),
    );
    expect(eacces.error.code).toBe("not-readable");
    const plain = expectErr(await readMediaFile({ path: "/x.png" }, { fs: fsOf(new Error("disk exploded")) }));
    expect(plain.error.code).toBe("not-readable");
  });

  test("非媒体文件（纯文本）与空文件 → not-media（fail-closed）", async () => {
    expect(expectErr(await readMediaFile({ path: "/t.txt" }, { fs: fsOf(new TextEncoder().encode("hello")) })).error.code).toBe("not-media");
    expect(expectErr(await readMediaFile({ path: "/empty" }, { fs: fsOf(new Uint8Array([])) })).error.code).toBe("not-media");
  });

  test("GIF89a 字节 → not-media（本卡字节层仅 PNG/JPEG，范围锁定）", async () => {
    const result = expectErr(
      await readMediaFile({ path: "/g.gif" }, { fs: fsOf(new TextEncoder().encode("GIF89a............")) }),
    );
    expect(result.error.code).toBe("not-media");
  });

  test("大文件字节上限：bytes > maxBytes → too-large（信息含实际与上限）", async () => {
    const bytes = pngBytes(); // 33 字节
    const result = expectErr(await readMediaFile({ path: "/m/a.png" }, { fs: fsOf(bytes), maxBytes: 5 }));
    expect(result.error.code).toBe("too-large");
    expect(result.error.message).toContain("33");
    expect(result.error.message).toContain("5");
  });

  test("字节上限边界：bytes == maxBytes 放行（恰好等于不拒绝）", async () => {
    const bytes = pngBytes(); // 33 字节
    const result = expectOk(await readMediaFile({ path: "/m/a.png" }, { fs: fsOf(bytes), maxBytes: 33 }));
    expect(result.metadata.bytes).toBe(33);
  });

  test("缺省上限 = DEFAULT_READ_MEDIA_MAX_BYTES（10,000,000 十进制）", () => {
    expect(DEFAULT_READ_MEDIA_MAX_BYTES).toBe(10_000_000);
  });
});

describe("readMediaFile · 注入契约", () => {
  test("deps.fs 缺失或 readFile 不可调用 → rejects TypeError（编程错误不结构化）", async () => {
    // async handler 的编程错误以 rejected promise 形态出现。
    await expect(readMediaFile({ path: "/m/a.png" }, undefined as unknown as { fs: FsPort })).rejects.toThrow(TypeError);
    await expect(readMediaFile({ path: "/m/a.png" }, { fs: {} as FsPort })).rejects.toThrow(TypeError);
  });

  test("maxBytes 非法（负数/小数/NaN）→ rejects RangeError（对齐 gateMedia 校验风格）", async () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      await expect(readMediaFile({ path: "/m/a.png" }, { fs: fsOf(pngBytes()), maxBytes: bad })).rejects.toThrow(RangeError);
    }
  });
});
