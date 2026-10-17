/**
 * @bi/workflow 测试 —— BI-21.2 显式交付工具（present-tool）。
 *
 * 覆盖：合法交付全流程（bytes/sha256/deliveredAt 注入时钟）、卡片确定性快照、
 * 缺失文件结构化 invalid-files、入参 invalid-input、同指纹幂等 already-delivered、
 * 接缝①持久化（注入 MemoryDurableStore 跨实例幂等）与纯函数钉行为。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDurableStore } from "../durable/storage";
import type { TaskRecord } from "../durable/task-state";
import {
  MemoryDeliveryStore,
  PresentTool,
  asDeliveryRecord,
  deliveryFingerprint,
  deliveryRecordId,
  formatBytes,
  renderDeliveryCard,
} from "./present-tool";
import type { DeliveryRecord } from "./present-tool";

// ---------- 测试基建 ----------

let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "bi-present-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

const T0 = 1_700_000_000_000;
const T0_ISO = new Date(T0).toISOString(); // 2023-11-14T22:13:20.000Z
const clock = (): number => T0;

function sha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function makeTool(): { tool: PresentTool; root: string } {
  const root = makeTmp();
  return { tool: new PresentTool({ clock, cwd: root }), root };
}

// ---------- 合法交付全流程 ----------

describe("PresentTool.handle · 合法交付", () => {
  test("record 字段齐全：bytes/sha256/deliveredAt（注入时钟），path 保持入参原样", () => {
    const { tool, root } = makeTool();
    mkdirSync(join(root, "out"));
    writeFileSync(join(root, "report.md"), "hello\n");
    writeFileSync(join(root, "out", "data.json"), '{"a":1}\n');

    const res = tool.handle({ files: ["report.md", "out/data.json"], summary: "分析完成" });

    expect(res.ok).toBe(true);
    expect(res.code).toBeUndefined();
    expect(res.record).toEqual({
      files: [
        { path: "report.md", bytes: 6, sha256: sha("hello\n") },
        { path: "out/data.json", bytes: 8, sha256: sha('{"a":1}\n') },
      ],
      summary: "分析完成",
      deliveredAt: T0_ISO,
    });
    expect(typeof res.card).toBe("string");
  });

  test("卡片确定性快照：标题 + 文件清单 + 摘要 + 交付时间", () => {
    const { tool, root } = makeTool();
    writeFileSync(join(root, "report.md"), "hello\n");
    writeFileSync(join(root, "data.json"), '{"a":1}\n');

    const res = tool.handle({ files: ["report.md", "data.json"], summary: "交付两份文件" });

    expect(res.card).toBe(
      [
        "📦 Deliverables",
        "──────────────────────────────────────",
        `1. report.md (6 B · sha256:${sha("hello\n").slice(0, 12)})`,
        `2. data.json (8 B · sha256:${sha('{"a":1}\n').slice(0, 12)})`,
        "──────────────────────────────────────",
        "Summary: 交付两份文件",
        `Delivered at: ${T0_ISO}`,
      ].join("\n"),
    );
    // 同 record 重渲染逐字节一致
    expect(renderDeliveryCard(res.record!)).toBe(res.card!);
  });

  test("sha256 已知向量钉死：hello\\n → 5891b5…", () => {
    const { tool, root } = makeTool();
    writeFileSync(join(root, "h.txt"), "hello\n");
    const res = tool.handle({ files: ["h.txt"], summary: "s" });
    expect(res.record!.files[0]!.sha256).toBe(
      "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
    );
  });

  test("相对路径按注入 cwd 解析", () => {
    const root = makeTmp();
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "f.txt"), "x");
    const tool = new PresentTool({ clock, cwd: join(root, "nested") });
    const res = tool.handle({ files: ["f.txt"], summary: "s" });
    expect(res.ok).toBe(true);
    expect(res.record!.files[0]!.path).toBe("f.txt");
  });
});

// ---------- 持久化（接缝①） ----------

describe("PresentTool · 持久化接缝①", () => {
  test("注入 DurableStore：落 kind='delivery' 的 completed 任务，checkpoint 即 record", () => {
    const store = new MemoryDurableStore();
    const root = makeTmp();
    writeFileSync(join(root, "a.txt"), "content\n");
    const tool = new PresentTool({ clock, cwd: root, store });

    const res = tool.handle({ files: ["a.txt"], summary: "s" });
    expect(res.ok).toBe(true);

    const id = deliveryRecordId(deliveryFingerprint([sha("content\n")], "s"));
    const task = store.get(id);
    expect(task).not.toBeNull();
    expect(task!.kind).toBe("delivery");
    expect(task!.state).toBe("completed");
    expect(task!.attempts).toBe(0);
    expect(task!.maxAttempts).toBe(1);
    expect(task!.updatedAt).toBe(T0);
    expect(asDeliveryRecord(task!.checkpoint)).toEqual(res.record!);
    expect(tool.listDeliveries()).toEqual([res.record!]);  });

  test("跨实例幂等（重启语义）：共享 store 的第二个实例同输入 → already-delivered", () => {
    const store = new MemoryDurableStore();
    const root = makeTmp();
    writeFileSync(join(root, "a.txt"), "same\n");
    const first = new PresentTool({ clock, cwd: root, store });
    const second = new PresentTool({ clock, cwd: root, store });

    const r1 = first.handle({ files: ["a.txt"], summary: "same" });
    const r2 = second.handle({ files: ["a.txt"], summary: "same" });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    expect(r2.code).toBe("already-delivered");
    expect(r2.alreadyDelivered).toBe(true);
    expect(r2.record).toEqual(r1.record);
    expect(store.get(deliveryRecordId(deliveryFingerprint([sha("same\n")], "same")))).not.toBeNull();
  });

  test("缺省内存 sink：实例内幂等生效，实例间互不可见", () => {
    const root = makeTmp();
    writeFileSync(join(root, "a.txt"), "m\n");
    const t1 = new PresentTool({ clock, cwd: root });
    const t2 = new PresentTool({ clock, cwd: root });

    expect(t1.handle({ files: ["a.txt"], summary: "m" }).ok).toBe(true);
    const dup = t1.handle({ files: ["a.txt"], summary: "m" });
    expect(dup.ok).toBe(false);
    expect(dup.code).toBe("already-delivered");
    // 另一实例的内存 sink 为空 → 可正常交付（缺省语义：进程内幂等）
    expect(t2.handle({ files: ["a.txt"], summary: "m" }).ok).toBe(true);
  });

  test("极简 sink（仅 get/put）：幂等查重照常生效，listDeliveries 优雅返回空表", () => {
    const rows = new Map<string, TaskRecord>();
    const minimal = {
      get: (id: string) => rows.get(id) ?? null,
      put: (r: TaskRecord) => void rows.set(r.id, structuredClone(r)),
    };
    const root = makeTmp();
    writeFileSync(join(root, "a.txt"), "m\n");
    const tool = new PresentTool({ clock, cwd: root, store: minimal });

    expect(tool.handle({ files: ["a.txt"], summary: "m" }).ok).toBe(true);
    expect(tool.listDeliveries()).toEqual([]); // 无 scanStates → 枚举不可用
    expect(tool.handle({ files: ["a.txt"], summary: "m" }).code).toBe("already-delivered");
  });
});

// ---------- 校验与拒绝 ----------

describe("PresentTool.handle · 校验拒绝", () => {
  test("缺失文件 → invalid-files，missing 精确列出缺失项（与合法项混提），拒绝交付", () => {
    const { tool, root } = makeTool();
    writeFileSync(join(root, "exists.txt"), "x");

    const res = tool.handle({ files: ["exists.txt", "ghost.txt", "no/such.bin"], summary: "s" });

    expect(res.ok).toBe(false);
    expect(res.code).toBe("invalid-files");
    expect(res.missing).toEqual(["ghost.txt", "no/such.bin"]);
    expect(res.record).toBeUndefined();
    expect(tool.listDeliveries()).toEqual([]);
  });

  test("目录视同不可交付（invalid-files）", () => {
    const { tool, root } = makeTool();
    mkdirSync(join(root, "dir"));
    const res = tool.handle({ files: ["dir"], summary: "s" });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("invalid-files");
    expect(res.missing).toEqual(["dir"]);
  });

  test("入参形状：空 files / 含空串 / 空 summary / files 非数组 → invalid-input", () => {
    const { tool, root } = makeTool();
    writeFileSync(join(root, "a.txt"), "x");
    expect(tool.handle({ files: [], summary: "s" }).code).toBe("invalid-input");
    expect(tool.handle({ files: [""], summary: "s" }).code).toBe("invalid-input");
    expect(tool.handle({ files: ["a.txt"], summary: "" }).code).toBe("invalid-input");
    expect(tool.handle({ files: ["a.txt"], summary: "   " }).code).toBe("invalid-input");
    expect(tool.handle({ files: "a.txt" } as never).code).toBe("invalid-input");
  });
});

// ---------- 幂等防护 ----------

describe("PresentTool.handle · 幂等防护", () => {
  test("同文件集+同 summary 二次交付 → already-delivered，回带首次 record，库内仍一条", () => {
    const { tool, root } = makeTool();
    writeFileSync(join(root, "a.txt"), "v1\n");
    const first = tool.handle({ files: ["a.txt"], summary: "交付" });
    expect(first.ok).toBe(true);

    const second = tool.handle({ files: ["a.txt"], summary: "交付" });
    expect(second.ok).toBe(false);
    expect(second.code).toBe("already-delivered");
    expect(second.alreadyDelivered).toBe(true);
    expect(second.record).toEqual(first.record);
    expect(second.card).toBeUndefined();
    expect(tool.listDeliveries()).toHaveLength(1);
  });

  test("同文件集不同 summary → 允许（新记录）", () => {
    const { tool, root } = makeTool();
    writeFileSync(join(root, "a.txt"), "v1\n");
    expect(tool.handle({ files: ["a.txt"], summary: "s1" }).ok).toBe(true);
    const res = tool.handle({ files: ["a.txt"], summary: "s2" });
    expect(res.ok).toBe(true);
    expect(res.record!.summary).toBe("s2");
    expect(tool.listDeliveries()).toHaveLength(2);
  });

  test("同路径内容变化 + 同 summary → 允许（sha256 指纹变化）", () => {
    const { tool, root } = makeTool();
    writeFileSync(join(root, "a.txt"), "v1\n");
    expect(tool.handle({ files: ["a.txt"], summary: "s" }).ok).toBe(true);
    writeFileSync(join(root, "a.txt"), "v2\n");
    const res = tool.handle({ files: ["a.txt"], summary: "s" });
    expect(res.ok).toBe(true);
    expect(res.record!.files[0]!.sha256).toBe(sha("v2\n"));
  });
});

// ---------- 纯函数 ----------

describe("present-tool 纯函数", () => {
  test("deliveryFingerprint：确定性，summary 参与，文件序敏感", () => {
    expect(deliveryFingerprint(["aa", "bb"], "s")).toBe(deliveryFingerprint(["aa", "bb"], "s"));
    expect(deliveryFingerprint(["aa"], "s1")).not.toBe(deliveryFingerprint(["aa"], "s2"));
    expect(deliveryFingerprint(["aa", "bb"], "s")).not.toBe(deliveryFingerprint(["bb", "aa"], "s"));
  });

  test("formatBytes：B/KB/MB 阈值确定性", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(3 * 1024 * 1024 + 512 * 1024)).toBe("3.5 MB");
  });

  test("asDeliveryRecord：合法往返；篡改/缺字段 checkpoint → null", () => {
    const record: DeliveryRecord = {
      files: [{ path: "p", bytes: 1, sha256: "ab" }],
      summary: "s",
      deliveredAt: T0_ISO,
    };
    expect(asDeliveryRecord(structuredClone(record))).toEqual(record);
    expect(asDeliveryRecord(null)).toBeNull();
    expect(asDeliveryRecord("x")).toBeNull();
    expect(asDeliveryRecord({ files: "no" })).toBeNull();
    expect(asDeliveryRecord({ files: [{ path: 1 }], summary: "s", deliveredAt: "t" })).toBeNull();
  });
});
