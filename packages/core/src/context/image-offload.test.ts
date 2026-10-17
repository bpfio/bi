/**
 * BI-08.2 · offloadOldestImages 图像渐进卸载测试。
 *
 * 钉死语义（与 image-offload.ts 文件头注释一一对应）：
 * - 结构不变式：消息数 / 消息引用 / content entry 数 / 非 image 块引用
 *   全部原样（toBe 级断言），只替换 image 槽位；
 * - 替换形态：{ type: "text", text: 占位符, offloaded: true }；
 * - 深度优先索引：跨消息连续 0 基，嵌套 content 向内递归计数；
 * - keepRecentN：末尾 N 张保留，缺省 0，非法值 RangeError；
 * - byteSize：base64 padding 修正口径（"AAAA"→3、"AAA="→2、"AA=="→1）。
 */
import { describe, expect, test } from "bun:test";
import {
  IMAGE_OFFLOAD_PLACEHOLDER,
  offloadOldestImages,
  type OffloadRecord,
} from "./image-offload";

/** 造一个 inline base64 image 块（data 为指定 base64 文本）。 */
function img(data: string): { type: "image"; source: { type: "base64"; data: string } } {
  return { type: "image", source: { type: "base64", data } };
}

/** 造一个文本块。 */
function txt(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

describe("offloadOldestImages · 基础卸载与占位符", () => {
  test("单图卸载：image 块被替换为占位文本块并标记 offloaded", () => {
    const original = img("AAAA");
    const messages = [{ role: "user", content: [txt("hello"), original] }];
    const records = offloadOldestImages(messages);
    expect(records).toEqual([{ index: 1, byteSize: 3 }]);
    const entry = (messages[0] as { content: unknown[] }).content[1] as Record<string, unknown>;
    expect(entry["type"]).toBe("text");
    expect(entry["text"]).toBe(IMAGE_OFFLOAD_PLACEHOLDER);
    expect(entry["offloaded"]).toBe(true);
  });

  test("占位符文本常量与替换文本精确一致", () => {
    expect(IMAGE_OFFLOAD_PLACEHOLDER).toBe("[Image omitted to conserve context window]");
    const messages = [{ role: "user", content: [img("AAAA")], }];
    offloadOldestImages(messages);
    const entry = (messages[0] as { content: unknown[] }).content[0] as Record<string, unknown>;
    expect(entry["text"]).toBe("[Image omitted to conserve context window]");
  });

  test("多图卸载顺序：深度优先序最旧优先，records.index 递增", () => {
    const m0a = img("AAAA");
    const m0b = img("AAAA");
    const m1a = img("AAAA");
    const messages = [
      { role: "user", content: [m0a, m0b] },
      { role: "assistant", content: [txt("ok")] },
      { role: "user", content: [m1a] },
    ];
    const seen: OffloadRecord[] = [];
    const records = offloadOldestImages(messages, { onOffload: (r) => seen.push({ ...r }) });
    // DFS 序：m0a=0, m0b=1, txt=2, m1a=3。
    expect(records).toEqual([
      { index: 0, byteSize: 3 },
      { index: 1, byteSize: 3 },
      { index: 3, byteSize: 3 },
    ]);
    expect(seen).toEqual(records); // onOffload 与返回值同序同值（最旧优先）。
  });

  test("纯文本消息序列：零卸载，返回空数组且内容引用不变", () => {
    const t = txt("keep me");
    const messages = [
      { role: "user", content: [t] },
      { role: "assistant", content: "plain string content" },
    ];
    const before = structuredClone(messages);
    const records = offloadOldestImages(messages);
    expect(records).toEqual([]);
    expect((messages[0] as { content: unknown[] }).content[0]).toBe(t);
    expect(messages).toEqual(before);
  });
});

describe("offloadOldestImages · 结构完整性（Session 事件序列不破坏）", () => {
  test("entry 数不变：消息数、content 数组长度、消息对象引用全部原样", () => {
    const messages = [
      { role: "user", content: [img("AAAA"), txt("a")] },
      { role: "assistant", content: [txt("b")] },
      { role: "user", content: [img("AAAA"), img("AAAA"), txt("c")] },
    ] as { role: string; content: unknown[] }[];
    const msgRefs = [...messages];
    const lengthsBefore = messages.map((m) => m.content.length);
    const textRefs = [
      (messages[0]!.content[1] as unknown),
      (messages[1]!.content[0] as unknown),
      (messages[2]!.content[2] as unknown),
    ];

    offloadOldestImages(messages);

    expect(messages.length).toBe(3);
    expect(messages.map((m) => m.content.length)).toEqual(lengthsBefore); // entry 数不变
    expect(messages[0]).toBe(msgRefs[0]);
    expect(messages[1]).toBe(msgRefs[1]);
    expect(messages[2]).toBe(msgRefs[2]);
    // 非 image 块引用不变（toBe 级）。
    expect(messages[0]!.content[1]).toBe(textRefs[0]);
    expect(messages[1]!.content[0]).toBe(textRefs[1]);
    expect(messages[2]!.content[2]).toBe(textRefs[2]);
  });

  test("混合序列只替换 image 槽位：其余槽位内容逐位不变", () => {
    const messages = [
      { role: "user", content: [txt("before"), img("AAAA"), txt("after")] },
    ];
    offloadOldestImages(messages);
    const content = (messages[0] as { content: unknown[] }).content;
    expect(content.length).toBe(3);
    expect((content[0] as { text: string }).text).toBe("before");
    expect((content[1] as Record<string, unknown>).offloaded).toBe(true);
    expect((content[2] as { text: string }).text).toBe("after");
  });

  test("嵌套 tool_result content 内的 image 块同样按深度优先序卸载", () => {
    const nestedImg = img("AAAA");
    const messages = [
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "t1", content: [txt("in"), nestedImg] },
          img("AAAA"),
        ],
      },
    ];
    const records = offloadOldestImages(messages);
    // DFS：tool_result 块=0，txt("in")=1，nestedImg=2，顶层 img=3。
    expect(records.map((r) => r.index)).toEqual([2, 3]);
    const outer = (messages[0] as { content: unknown[] }).content;
    expect(outer.length).toBe(2); // 顶层 entry 数不变
    const inner = ((outer[0] as Record<string, unknown>)["content"] as unknown[]);
    expect(inner.length).toBe(2); // 嵌套 entry 数不变
    expect((inner[1] as Record<string, unknown>)["offloaded"]).toBe(true);
    expect((outer[1] as Record<string, unknown>)["offloaded"]).toBe(true);
  });
});

describe("offloadOldestImages · keepRecentN 语义", () => {
  test("keepRecentN=1：仅卸载最旧一张，最近一张原引用保留", () => {
    const oldest = img("AAAA");
    const newest = img("AAAA");
    const messages = [{ role: "user", content: [oldest, newest] }];
    const records = offloadOldestImages(messages, { keepRecentN: 1 });
    expect(records).toEqual([{ index: 0, byteSize: 3 }]);
    const content = (messages[0] as { content: unknown[] }).content;
    expect((content[0] as Record<string, unknown>)["offloaded"]).toBe(true);
    expect(content[1]).toBe(newest); // 最近一张原样保留
  });

  test("keepRecentN=0（缺省）：全部卸载", () => {
    const messages = [{ role: "user", content: [img("AAAA"), img("AAAA"), img("AAAA")] }];
    const records = offloadOldestImages(messages);
    expect(records.length).toBe(3);
  });

  test("keepRecentN 超过图片总数：一张都不卸载，返回空数组", () => {
    const a = img("AAAA");
    const messages = [{ role: "user", content: [a] }];
    const records = offloadOldestImages(messages, { keepRecentN: 99 });
    expect(records).toEqual([]);
    expect((messages[0] as { content: unknown[] }).content[0]).toBe(a);
  });

  test("keepRecentN 非法值（负数/小数/NaN/Infinity）→ RangeError", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => offloadOldestImages([], { keepRecentN: bad })).toThrow(RangeError);
    }
  });
});

describe("offloadOldestImages · 幂等与 byteSize 口径", () => {
  test("幂等：已卸载条目（offloaded 文本块）二次调用不再卸载、不再计数", () => {
    const messages = [{ role: "user", content: [img("AAAA"), img("AAAA")] }];
    offloadOldestImages(messages);
    const records2 = offloadOldestImages(messages);
    expect(records2).toEqual([]);
    const content = (messages[0] as { content: unknown[] }).content;
    expect(content.length).toBe(2); // 二次调用 entry 数仍不变
  });

  test("byteSize 按 base64 padding 修正：'AA=='→1、'AAA='→2、'AAAA'→3", () => {
    const messages = [
      { role: "user", content: [img("AA=="), img("AAA="), img("AAAA")] },
    ];
    const records = offloadOldestImages(messages);
    expect(records.map((r) => r.byteSize)).toEqual([1, 2, 3]);
  });

  test("byteSize：84 字符 base64 → 63 字节；file 引用型（无 inline data）记 0", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", data: "A".repeat(84) } },
          { type: "image", source: { type: "file", file_id: "f_123" } },
        ],
      },
    ];
    const records = offloadOldestImages(messages);
    expect(records.map((r) => r.byteSize)).toEqual([63, 0]);
  });

  test("病态输入（null 消息 / 无 content / 字符串 content）不炸不计数", () => {
    const messages = [null, { role: "user" }, { role: "user", content: "string" }, 42];
    expect(offloadOldestImages(messages)).toEqual([]);
  });
});
