/**
 * BI-08.1 · SpillStore 测试（一律使用 tmp 注入根目录，绝不写真机 ~/.bi）。
 *
 * 覆盖：save/load 往返、handle 字段契约、preview 头 200 字符、自动建目录、
 * sweep 新旧分界与严格大于边界、根目录缺失容错、路径穿越拒绝、
 * 以及 64KB → spill → 8192 修剪的纵深管线组合。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { boundToolText } from "./bounded-tool-text";
import { SpillStore, defaultSpillRoot } from "./spill-store";
import { pruneToolResult } from "./tool-result-pruner";

function makeTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "bi-spill-test-"));
}

describe("BI-08.1 SpillStore · 落盘与读回", () => {
  test("save → load 往返一致", () => {
    const root = makeTmpRoot();
    try {
      const store = new SpillStore(root);
      const text = "line1\nline2\n".repeat(500);
      const h = store.save(text);
      expect(store.load(h)).toBe(text);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("handle 字段契约：UUID 形态 id、root 下 .spill 路径、UTF-8 字节数", () => {
    const root = makeTmpRoot();
    try {
      const store = new SpillStore(root);
      const h = store.save("中文abc"); // 中文 3 字节/字
      expect(h.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(h.path.startsWith(root)).toBe(true);
      expect(h.path.endsWith(".spill")).toBe(true);
      expect(h.bytes).toBe(3 * 2 + 3);
      expect(existsSync(h.path)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preview = 头 200 字符（码点安全）", () => {
    const root = makeTmpRoot();
    try {
      const store = new SpillStore(root);
      const text = "x".repeat(300) + "😀".repeat(50);
      const h = store.save(text);
      expect(h.preview).toBe("x".repeat(200));
      expect(h.preview.length).toBe(200);
      // 纯 emoji 输入的 preview 也不截半（200 码点 = 400 UTF-16 单元）。
      const h2 = store.save("😀".repeat(300));
      expect(h2.preview).toBe("😀".repeat(200));
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(h2.preview)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("root 目录不存在：save 自动递归创建", () => {
    const root = join(makeTmpRoot(), "deep", "nested");
    try {
      const store = new SpillStore(root);
      const h = store.save("payload");
      expect(existsSync(h.path)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("load 路径逃逸根目录：拒绝（路径穿越防护）", () => {
    const root = makeTmpRoot();
    const store = new SpillStore(root);
    expect(() =>
      store.load({ id: "x", path: join(root, "..", "evil.txt"), bytes: 1, preview: "" }),
    ).toThrow(RangeError);
    rmSync(root, { recursive: true, force: true });
  });

  test("默认根目录函数：~/.bi/spill", () => {
    expect(defaultSpillRoot()).toContain(".bi");
    expect(defaultSpillRoot().endsWith("spill")).toBe(true);
  });
});

describe("BI-08.1 SpillStore · sweep 文件级 GC", () => {
  test("旧文件删除、新文件保留；只碰 *.spill", () => {
    const root = makeTmpRoot();
    try {
      const fixedNow = 1_000_000_000_000;
      const store = new SpillStore(root, { now: () => fixedNow });
      const oldH = store.save("old");
      const newH = store.save("new");
      const bystander = join(root, "keep-me.txt");
      // 手工造旁观文件与旧 mtime。
      writeFileSync(bystander, "hands off", "utf8");
      utimesSync(oldH.path, new Date(fixedNow - 10_000), new Date(fixedNow - 10_000));
      utimesSync(newH.path, new Date(fixedNow - 100), new Date(fixedNow - 100));

      const removed = store.sweep(5_000);
      expect(removed).toBe(1);
      expect(existsSync(oldH.path)).toBe(false);
      expect(existsSync(newH.path)).toBe(true);
      expect(existsSync(bystander)).toBe(true); // 非 .spill 绝不删
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("年龄恰好等于阈值：保留（严格大于才删）", () => {
    const root = makeTmpRoot();
    try {
      const fixedNow = 2_000_000_000_000;
      const store = new SpillStore(root, { now: () => fixedNow });
      const h = store.save("edge");
      utimesSync(h.path, new Date(fixedNow - 5_000), new Date(fixedNow - 5_000));
      expect(store.sweep(5_000)).toBe(0);
      expect(existsSync(h.path)).toBe(true);
      expect(store.sweep(4_999)).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("根目录不存在 / 空目录：返回 0 不抛错", () => {
    const store = new SpillStore(join(makeTmpRoot(), "nonexistent"));
    expect(store.sweep(0)).toBe(0);
    const empty = makeTmpRoot();
    expect(new SpillStore(empty).sweep(0)).toBe(0);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe("BI-08.1 · 纵深管线组合（64KB → spill → 8192 修剪）", () => {
  test("第一层粗截 → 第二层细剪 → spill 保全原文", () => {
    const root = makeTmpRoot();
    try {
      const store = new SpillStore(root);
      // 70,000 码点单行输出：BI-08 粗截到 ~64K，本卡细剪到 ~5.2K。
      const original = `${"HEAD".repeat(500)}${"M".repeat(66000)}${"TAIL".repeat(1250)}`;
      expect(original.length).toBe(73_000);

      // 调用方先 spill 原文（引用自管），再做两层有界化。
      const handle = store.save(original);
      const layer1 = boundToolText(original);
      expect(layer1.bounded).toBe(true);
      const layer2 = pruneToolResult(layer1.text);

      expect(layer2).toContain("[... tool result middle pruned:");
      expect(layer2.length).toBeLessThan(8192);
      // 细剪头 4096 码点 = 粗截文本的前 4096 码点（HEAD*500 + M*2096）。
      expect(layer2.startsWith("HEAD".repeat(500) + "M".repeat(2096))).toBe(true);
      // spill 读回 = 原文，一个字节都不少。
      expect(store.load(handle)).toBe(original);
      expect(handle.bytes).toBe(Buffer.byteLength(original, "utf8"));
      expect(readdirSync(root).filter((n) => n.endsWith(".spill")).length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
