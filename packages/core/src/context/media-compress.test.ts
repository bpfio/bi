/**
 * BI-08 · gateMedia 端侧媒体门禁测试。
 *
 * 钉死语义（与 media-compress.ts 文件头注释一一对应）：
 * - 决策顺序：MIME 白名单先行（fail-closed）→ 尺寸预算。
 * - 默认预算 25KB = 25,000 字节（十进制），恰好等于预算放行。
 * - 占位文本确定性格式（含工单原例 84.5KB）；data 绝不出现在结果中。
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ALLOWED_IMAGE_MIME_TYPES,
  DEFAULT_MEDIA_BUDGET_BYTES,
  formatByteSize,
  gateMedia,
} from "./media-compress";

const png = (bytes: number): Uint8Array => new Uint8Array(bytes);

describe("BI-08 尺寸门禁", () => {
  test("小体积 png：passthrough", () => {
    const r = gateMedia({ kind: "image", data: png(1024), mimeType: "image/png" });
    expect(r).toEqual({ action: "passthrough" });
  });

  test("恰好 25000 字节（等于预算）：passthrough", () => {
    const r = gateMedia({ kind: "image", data: png(25_000), mimeType: "image/png" });
    expect(r.action).toBe("passthrough");
  });

  test("25001 字节：placeholder，占位文本与 meta 精确", () => {
    const r = gateMedia({ kind: "image", data: png(25_001), mimeType: "image/png" });
    if (r.action !== "placeholder") throw new Error("expected placeholder");
    expect(r.placeholder).toBe("[Image omitted: 25KB exceeds 25KB budget (image/png)]");
    expect(r.meta).toEqual({ bytes: 25_001, mimeType: "image/png" });
  });

  test("84500 字节：工单原例格式 84.5KB", () => {
    const r = gateMedia({ kind: "image", data: png(84_500), mimeType: "image/png" });
    if (r.action !== "placeholder") throw new Error("expected placeholder");
    expect(r.placeholder).toBe("[Image omitted: 84.5KB exceeds 25KB budget (image/png)]");
  });

  test("自定义预算 10 字节：B 级格式 11B exceeds 10B budget", () => {
    const r = gateMedia({ kind: "image", data: png(11), mimeType: "image/png" }, { budgetBytes: 10 });
    if (r.action !== "placeholder") throw new Error("expected placeholder");
    expect(r.placeholder).toBe("[Image omitted: 11B exceeds 10B budget (image/png)]");
  });

  test("budgetBytes=0：任何非空数据都拦截", () => {
    const r = gateMedia({ kind: "image", data: png(1), mimeType: "image/gif" }, { budgetBytes: 0 });
    expect(r.action).toBe("placeholder");
  });

  test("0 字节已声明图像：passthrough（本卡不解码内容，损坏由上层兜底）", () => {
    const r = gateMedia({ kind: "image", data: png(0), mimeType: "image/png" });
    expect(r.action).toBe("passthrough");
  });

  test("budgetBytes 非法：负数 / NaN 抛 RangeError", () => {
    expect(() => gateMedia({ kind: "image", data: png(1), mimeType: "image/png" }, { budgetBytes: -1 })).toThrow(
      RangeError,
    );
    expect(() =>
      gateMedia({ kind: "image", data: png(1), mimeType: "image/png" }, { budgetBytes: Number.NaN }),
    ).toThrow(RangeError);
  });

  test("DEFAULT_MEDIA_BUDGET_BYTES 为十进制 25000", () => {
    expect(DEFAULT_MEDIA_BUDGET_BYTES).toBe(25_000);
  });
});

describe("BI-08 MIME 白名单（fail-closed）", () => {
  test("默认白名单四类全部放行（小体积）", () => {
    for (const mime of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
      expect(gateMedia({ kind: "image", data: png(100), mimeType: mime }).action).toBe("passthrough");
    }
  });

  test("未知 mime 小体积：placeholder（fail-closed，不因体积小而漏过）", () => {
    const r = gateMedia({ kind: "image", data: png(100), mimeType: "image/svg+xml" });
    if (r.action !== "placeholder") throw new Error("expected placeholder");
    expect(r.placeholder).toBe(
      "[Image omitted: unsupported media type 'image/svg+xml' (allowlist: image/png, image/jpeg, image/webp, image/gif)]",
    );
    expect(r.meta).toEqual({ bytes: 100, mimeType: "image/svg+xml" });
  });

  test("未知 mime 大体积：优先报告类型问题（白名单先于尺寸决策）", () => {
    const r = gateMedia({ kind: "image", data: png(84_500), mimeType: "application/pdf" });
    if (r.action !== "placeholder") throw new Error("expected placeholder");
    expect(r.placeholder.includes("unsupported media type 'application/pdf'")).toBe(true);
    expect(r.placeholder.includes("exceeds")).toBe(false);
  });

  test("白名单外前缀相似类型不放行（image/png2、image/x-png）", () => {
    expect(gateMedia({ kind: "image", data: png(10), mimeType: "image/png2" }).action).toBe("placeholder");
    expect(gateMedia({ kind: "image", data: png(10), mimeType: "image/x-png" }).action).toBe("placeholder");
  });

  test("MIME 大小写不敏感：IMAGE/PNG 视同 image/png", () => {
    expect(gateMedia({ kind: "image", data: png(100), mimeType: "IMAGE/PNG" }).action).toBe("passthrough");
  });

  test("自定义白名单：image/avif 可放行；默认名单下 avif 被拦截", () => {
    const avif = { kind: "image" as const, data: png(50), mimeType: "image/avif" };
    expect(gateMedia(avif, { allowedMimeTypes: ["image/avif"] }).action).toBe("passthrough");
    expect(gateMedia(avif).action).toBe("placeholder");
  });

  test("DEFAULT_ALLOWED_IMAGE_MIME_TYPES 为工单钉死四类", () => {
    expect(DEFAULT_ALLOWED_IMAGE_MIME_TYPES).toEqual(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  });

  test("placeholder 结果不外泄 data：结果对象仅 action/placeholder/meta 三字段", () => {
    const data = png(84_500);
    const r = gateMedia({ kind: "image", data, mimeType: "image/png" });
    if (r.action !== "placeholder") throw new Error("expected placeholder");
    expect(Object.keys(r).sort()).toEqual(["action", "meta", "placeholder"]);
    expect(r.meta).toEqual({ bytes: 84_500, mimeType: "image/png" });
  });
});

describe("BI-08 formatByteSize（占位文本确定性基础）", () => {
  test("B / KB / MB 分段与整数去 .0 规则", () => {
    expect(formatByteSize(999)).toBe("999B");
    expect(formatByteSize(1000)).toBe("1KB");
    expect(formatByteSize(1500)).toBe("1.5KB");
    expect(formatByteSize(25_000)).toBe("25KB");
    expect(formatByteSize(84_500)).toBe("84.5KB");
    expect(formatByteSize(999_999)).toBe("1000KB");
    expect(formatByteSize(1_234_567)).toBe("1.2MB");
  });
});
