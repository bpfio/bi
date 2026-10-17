/**
 * BI-03.1 会话时光倒流与物理文件差分回滚引擎 测试。
 *
 * 覆盖面（工单要求 ≥18 用例）：
 *  - patch 往返：多 hunk / 中文 / 空行 / 尾部无换行 / 空文件边界；
 *  - rewind 字节级还原；diverged 拒绝（工作区被独立改动后拒盲目回滚）；
 *  - reverse 正确性（+↔- 互换、坐标互换、两次反转还原）；
 *  - 接缝④：与 file-history（BI-03.2 blob 轨）并存，各写各的数据区。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "./blob-store";
import { EMPTY_SHA256, FileHistoryService } from "./file-history";
import type { SnapshotContext } from "./file-history";
import {
  FileRewindEngine,
  PatchApplyError,
  applyPatch,
  computeFilePatch,
  reversePatch,
  rewindFile,
  splitLines,
} from "./file-rewind";

let dir: string | undefined;

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

async function makeDir(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "bi-file-rewind-"));
  return dir;
}

async function writeText(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8");
}

async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

/** 往返断言：正向 apply 与逆向 rewind 均须逐字节还原。 */
function expectRoundTrip(before: string, after: string): void {
  const patch = computeFilePatch(before, after);
  expect(applyPatch(before, patch)).toBe(after);
  expect(rewindFile(after, patch)).toBe(before);
}

/* --------------------------------- 行切分与补丁构造 --------------------------------- */

describe("splitLines", () => {
  test("每行保留行尾换行，末行无换行时不带（join 还原原文）", () => {
    expect(splitLines("a\nb\n")).toEqual(["a\n", "b\n"]);
    expect(splitLines("a\nb")).toEqual(["a\n", "b"]);
    expect(splitLines("")).toEqual([]);
    expect(splitLines("\n")).toEqual(["\n"]);
  });
});

describe("computeFilePatch", () => {
  test("恒等补丁：内容相同 → hunks 为空、前后哈希相等", () => {
    const patch = computeFilePatch("same\ncontent\n", "same\ncontent\n");
    expect(patch.hunks).toEqual([]);
    expect(patch.beforeHash).toBe(patch.afterHash);
    expect(patch.beforeHash).toBe(sha256Hex(new TextEncoder().encode("same\ncontent\n")));
  });

  test("单行修改 → 单 hunk，含 '-' 与 '+' 行，old/new 坐标正确", () => {
    const patch = computeFilePatch("a\nb\nc\n", "a\nX\nc\n");
    expect(patch.hunks.length).toBe(1);
    const hunk = patch.hunks[0];
    expect(hunk).toBeDefined();
    expect(hunk?.oldStart).toBe(1);
    // oldLines = 上下文'a' + 删除'b' + 上下文'c'；newLines = 'a' + 'X' + 'c'。
    expect(hunk?.oldLines).toBe(3);
    expect(hunk?.newStart).toBe(1);
    expect(hunk?.newLines).toBe(3);
    expect(hunk?.lines.map((l) => l.op)).toEqual([" ", "-", "+", " "]);
    expect(hunk?.lines.map((l) => l.text)).toEqual(["a\n", "b\n", "X\n", "c\n"]);
    expect(patch.beforeHash).not.toBe(patch.afterHash);
  });

  test("远距两处修改 → 两个 hunk（变更间距 > 2×上下文半径）", () => {
    const before = Array.from({ length: 12 }, (_, i) => `L${i + 1}\n`).join("");
    const after = before.replace("L2\n", "X2\n").replace("L10\n", "X10\n");
    const patch = computeFilePatch(before, after);
    expect(patch.hunks.length).toBe(2);
    // hunk1: L1..L5（改 L2，后带 3 行上下文）；hunk2: L7..L12（改 L10，前带 3 行上下文）。
    expect(patch.hunks[0]?.oldStart).toBe(1);
    expect(patch.hunks[1]?.oldStart).toBe(7);
    expect(applyPatch(before, patch)).toBe(after);
    expect(rewindFile(after, patch)).toBe(before);
  });

  test("补丁行保留行尾换行（末行无换行的源文件除外）", () => {
    const patch = computeFilePatch("a\nb\nc\n", "a\nb\nc");
    // 尾行去换行：hunk 内上下文行带 '\n'，变更行 '-' 带换行、'+' 不带。
    const hunk = patch.hunks[0];
    expect(hunk?.lines.map((l) => l.text)).toEqual(["a\n", "b\n", "c\n", "c"]);
    expect(hunk?.lines.map((l) => l.op)).toEqual([" ", " ", "-", "+"]);
  });
});

/* --------------------------------- 往返与反向 --------------------------------- */

describe("patch 往返（applyPatch 正向 + rewindFile 逆向）", () => {
  test("基础多行修改往返", () => {
    expectRoundTrip("line1\nline2\nline3\n", "line1\nchanged\nline3\n");
  });

  test("中文内容往返", () => {
    expectRoundTrip(
      "第一行：会话时光倒流\n第二行：物理文件差分回滚\n第三行：引擎\n",
      "第一行：会话时光倒流\n第二行：差分补丁已重写\n第三行：引擎\n",
    );
  });

  test("空行插入与删除往返", () => {
    expectRoundTrip("a\n\nb\n", "a\nb\n");
    expectRoundTrip("a\nb\n", "a\n\n\nb\n");
  });

  test("尾部无换行：追加带换行的行往返", () => {
    expectRoundTrip("a\nb", "a\nb\nc\n");
  });

  test("尾部去换行往返", () => {
    expectRoundTrip("a\nb\n", "a\nb");
  });

  test("空文件 → 有内容：纯插入 hunk（oldStart=0/oldLines=0）往返", () => {
    const patch = computeFilePatch("", "x\ny\n");
    expect(patch.hunks.length).toBe(1);
    expect(patch.hunks[0]?.oldStart).toBe(0);
    expect(patch.hunks[0]?.oldLines).toBe(0);
    expect(patch.hunks[0]?.newStart).toBe(1);
    expectRoundTrip("", "x\ny\n");
  });

  test("有内容 → 空文件：纯删除 hunk（newStart=0）往返", () => {
    const patch = computeFilePatch("x\ny\n", "");
    expect(patch.hunks.length).toBe(1);
    expect(patch.hunks[0]?.newStart).toBe(0);
    expect(patch.hunks[0]?.newLines).toBe(0);
    expectRoundTrip("x\ny\n", "");
  });

  test("整段重排（删除+移动式重写）往返", () => {
    expectRoundTrip(
      "alpha\nbeta\ngamma\ndelta\n",
      "delta\ngamma\nbeta\nalpha\n",
    );
  });
});

describe("applyPatch 校验与 reversePatch 正确性", () => {
  test("上下文不匹配 → PatchApplyError（拒绝错位应用）", () => {
    const patch = computeFilePatch("a\nb\nc\n", "a\nX\nc\n");
    expect(() => applyPatch("完全不同的内容\n第二行\n", patch)).toThrow(PatchApplyError);
  });

  test("reverse 两次还原为原补丁（深相等）", () => {
    const before = Array.from({ length: 10 }, (_, i) => `行${i + 1}\n`).join("");
    const after = before.replace("行3\n", "改3\n").replace("行8\n", "改8\n");
    const patch = computeFilePatch(before, after);
    expect(reversePatch(reversePatch(patch))).toEqual(patch);
  });

  test("reverse：+↔- 互换、old/new 坐标互换、哈希互换", () => {
    const patch = computeFilePatch("a\nb\nc\n", "a\nX\nc\n");
    const rev = reversePatch(patch);
    expect(rev.beforeHash).toBe(patch.afterHash);
    expect(rev.afterHash).toBe(patch.beforeHash);
    const hunk = rev.hunks[0];
    expect(hunk?.oldStart).toBe(patch.hunks[0]?.newStart);
    expect(hunk?.newStart).toBe(patch.hunks[0]?.oldStart);
    expect(hunk?.lines.map((l) => l.op)).toEqual([" ", "+", "-", " "]);
    // 逆补丁正向应用于 after 内容即还原 before。
    expect(applyPatch("a\nX\nc\n", rev)).toBe("a\nb\nc\n");
  });

  test("rewindFile 等价于 applyPatch(current, reversePatch(patch))", () => {
    const before = "p\nq\nr\n";
    const after = "p\nQ\nr\n";
    const patch = computeFilePatch(before, after);
    expect(rewindFile(after, patch)).toBe(applyPatch(after, reversePatch(patch)));
  });
});

/* --------------------------------- FileRewindEngine --------------------------------- */

describe("FileRewindEngine", () => {
  test("snapshotBeforeEdit：存在文件 → 基线哈希/字节数/exists", async () => {
    const d = await makeDir();
    const path = join(d, "notes.txt");
    await writeText(path, "v1\n");
    const engine = new FileRewindEngine();
    const snap = await engine.snapshotBeforeEdit(path);
    expect(snap.exists).toBe(true);
    expect(snap.size).toBe(3);
    expect(snap.sha256).toBe(sha256Hex(new TextEncoder().encode("v1\n")));
    expect(snap.path).toBe(path);
    expect(snap.historyPriorSha256).toBeUndefined(); // 缺省不联动（接缝④）
  });

  test("snapshotBeforeEdit：文件不存在 → 空字节快照（SHA-256(\"\")）", async () => {
    const d = await makeDir();
    const engine = new FileRewindEngine();
    const snap = await engine.snapshotBeforeEdit(join(d, "ghost.txt"));
    expect(snap.exists).toBe(false);
    expect(snap.size).toBe(0);
    expect(snap.sha256).toBe(EMPTY_SHA256);
  });

  test("rewind：哈希校验通过 → 字节级还原并返回 restoredSha == beforeHash", async () => {
    const d = await makeDir();
    const path = join(d, "code.txt");
    const v1 = "fn a():\n  return 1\nfn b():\n  return 2\n";
    const v2 = "fn a():\n  return 100\nfn b():\n  return 2\n";
    await writeText(path, v1);
    const engine = new FileRewindEngine();
    await engine.snapshotBeforeEdit(path);
    const patch = computeFilePatch(v1, v2);
    await writeText(path, v2); // 模拟 edit 落盘

    const result = await engine.rewind(path, patch);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.restoredSha).toBe(patch.beforeHash);
    }
    expect(await readText(path)).toBe(v1); // 字节级还原
  });

  test("rewind：尾部无换行文件也能字节级还原", async () => {
    const d = await makeDir();
    const path = join(d, "no-nl.txt");
    const v1 = "第一行\n尾行无换行";
    const v2 = "第一行\n中间插入\n尾行无换行";
    await writeText(path, v1);
    const engine = new FileRewindEngine();
    await engine.snapshotBeforeEdit(path);
    const patch = computeFilePatch(v1, v2);
    await writeText(path, v2);

    const result = await engine.rewind(path, patch);
    expect(result.ok).toBe(true);
    expect(await readText(path)).toBe(v1);
  });

  test("rewind：当前哈希 != afterHash → diverged 拒绝且文件保持被改后的内容", async () => {
    const d = await makeDir();
    const path = join(d, "diverged.txt");
    const v1 = "one\ntwo\n";
    const v2 = "one\nTWO\n";
    await writeText(path, v1);
    const engine = new FileRewindEngine();
    await engine.snapshotBeforeEdit(path);
    const patch = computeFilePatch(v1, v2);
    await writeText(path, v2);
    await writeText(path, "独立改动\n谁也别想猜到\n"); // 工作区已被另一路径改动

    const result = await engine.rewind(path, patch);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("diverged");
      expect(result.expectedHash).toBe(patch.afterHash);
      expect(result.actualHash).toBe(
        sha256Hex(new TextEncoder().encode("独立改动\n谁也别想猜到\n")),
      );
    }
    expect(await readText(path)).toBe("独立改动\n谁也别想猜到\n");
  });

  test("rewind：可重复编辑—回滚循环（回滚后再快照可再来一轮）", async () => {
    const d = await makeDir();
    const path = join(d, "loop.txt");
    const v1 = "r1\nr2\n";
    const v2 = "r1\nR2\n";
    const v3 = "r1\nR2\nR3\n";
    await writeText(path, v1);
    const engine = new FileRewindEngine();

    const patchA = computeFilePatch(v1, v2);
    await writeText(path, v2);
    expect((await engine.rewind(path, patchA)).ok).toBe(true);
    expect(await readText(path)).toBe(v1);

    await engine.snapshotBeforeEdit(path);
    const patchB = computeFilePatch(v1, v3);
    await writeText(path, v3);
    expect((await engine.rewind(path, patchB)).ok).toBe(true);
    expect(await readText(path)).toBe(v1);
  });

  test("rewind：对「编辑前不存在」的文件回滚 → 恢复为零字节态", async () => {
    const d = await makeDir();
    const path = join(d, "created.txt");
    const engine = new FileRewindEngine();
    await engine.snapshotBeforeEdit(path); // 不存在 → 空字节基线
    const patch = computeFilePatch("", "新文件内容\n");
    await writeText(path, "新文件内容\n");

    const result = await engine.rewind(path, patch);
    expect(result.ok).toBe(true);
    expect(await readText(path)).toBe("");
  });
});

/* --------------------------------- 接缝④：与 blob 轨并存 --------------------------------- */

describe("接缝④：file-rewind（diff 轨）与 file-history（blob 轨）并存", () => {
  test("各写各的数据区：引擎回滚不写 fileHistory 的 blob/index，联动仅只读", async () => {
    const d = await makeDir();
    const path = join(d, "shared.txt");
    const v1 = "轨道共存实验 v1\n第二行\n";
    const v2 = "轨道共存实验 v1\n第二行被改\n";
    await writeText(path, v1);

    // blob 轨（BI-03.2 资产）：写自己的数据区（blobs/ + index.jsonl）。
    const history = new FileHistoryService({
      rootDir: join(d, "history"),
      blobRoot: join(d, "blobs"),
    });
    const ctx: SnapshotContext = { sessionId: "sess-seam4", turnId: "turn-1", phase: "edit" };
    const record = await history.snapshotBefore(path, ctx);
    const recordsBefore = await history.query();
    const blobsBefore = await history.blobStore.listBlobs();
    const indexBefore = await readFile(history.indexPath, "utf8");

    // diff 轨（本卡）：注入只读联动端口（FileHistoryService 结构满足）。
    const engine = new FileRewindEngine({ readHistory: history });
    const snap = await engine.snapshotBeforeEdit(path);
    expect(snap.historyPriorSha256).toBe(record.priorSha256); // 只读观测

    const patch = computeFilePatch(v1, v2);
    await writeText(path, v2);
    const result = await engine.rewind(path, patch);
    expect(result.ok).toBe(true);
    expect(await readText(path)).toBe(v1);

    // 接缝④断言：引擎回滚后 blob 轨数据区零变化。
    expect(await history.query()).toEqual(recordsBefore);
    expect(await history.blobStore.listBlobs()).toEqual(blobsBefore);
    expect(await readFile(history.indexPath, "utf8")).toBe(indexBefore);
  });
});
