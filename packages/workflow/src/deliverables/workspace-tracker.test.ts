/**
 * @bi/workflow 测试 —— BI-21.2 工作区变更追踪器（workspace-tracker）。
 *
 * 分两层：
 * - 真实 tmp git fixture（BI-12 前例授权形态，本卡核心依赖 git diff）：
 *   capture → 改文件 → commit → changesSinceBaseline 全矩阵
 *   （committed/untracked/dirty 各态 + 混合 + 存量噪音差分 + 空仓库空树 diff
 *   + 二进制 numstat + 二次建基线重置）；
 * - 纯函数与 stub：parseNumstat（`-` 二进制、路径含空格）、parsePorcelainZ
 *   （rename 双字段）、renderChangeCard 精确快照、结构化错误
 *   （not-a-git-repo / no-baseline / git-failed）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TrackerError,
  WorkspaceTracker,
  isTrackerError,
  parseNumstat,
  parsePorcelainZ,
  renderChangeCard,
} from "./workspace-tracker";
import type { ChangeReport, GitRunner } from "./workspace-tracker";

// ---------- 测试基建 ----------

let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "bi-tracker-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

/** 测试内 git 执行（BI-12 前例：tmp fixture 仓库的 git 命令授权）。 */
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`git ${args.join(" ")} 失败：${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

const T0 = 1_700_000_000_000;
const clock = (): number => T0;

/** 真实仓库夹具：init + 基线提交 base.txt。 */
async function makeRepo(): Promise<{ root: string; tracker: WorkspaceTracker; baseHead: string }> {
  const root = makeTmp();
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.name", "bi-test"]);
  await git(root, ["config", "user.email", "bi-test@example.invalid"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(root, "base.txt"), "seed\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "baseline"]);
  const baseHead = (await git(root, ["rev-parse", "HEAD"])).trim();
  return { root, tracker: new WorkspaceTracker({ repoRoot: root, clock }), baseHead };
}

// ---------- captureBaseline ----------

describe("WorkspaceTracker.captureBaseline", () => {
  test("非 git 目录 → 结构化 not-a-git-repo", async () => {
    const root = makeTmp(); // 无 git init
    const tracker = new WorkspaceTracker({ repoRoot: root });
    let caught: unknown = null;
    try {
      await tracker.captureBaseline();
    } catch (err) {
      caught = err;
    }
    expect(isTrackerError(caught)).toBe(true);
    expect((caught as TrackerError).code).toBe("not-a-git-repo");
  });

  test("正常仓库：baseline 记录 HEAD，capturedAt 注入时钟", async () => {
    const { root, tracker, baseHead } = await makeRepo();
    await tracker.captureBaseline();
    expect(tracker.baseline).toBe(baseHead);
    expect(tracker.capturedAt).toBe(T0);
  });

  test("空仓库（init 无提交）：captureBaseline 成功，baseline 为 null", async () => {
    const root = makeTmp();
    await git(root, ["init", "-q", "-b", "main"]);
    await git(root, ["config", "user.name", "bi-test"]);
    await git(root, ["config", "user.email", "bi-test@example.invalid"]);
    const tracker = new WorkspaceTracker({ repoRoot: root, clock });
    await tracker.captureBaseline();
    expect(tracker.baseline).toBeNull();
  });
});

// ---------- changesSinceBaseline · 全矩阵 ----------

describe("WorkspaceTracker.changesSinceBaseline · 矩阵", () => {
  test("无变更：全空 + 总计 0（零噪音）", async () => {
    const { tracker } = await makeRepo();
    await tracker.captureBaseline();
    const report = await tracker.changesSinceBaseline();
    expect(report).toEqual({
      baseHead: tracker.baseline,
      committedFiles: [],
      untracked: [],
      dirty: [],
      totalInsertions: 0,
      totalDeletions: 0,
    });
  });

  test("untracked：新文件入 untracked，不入 dirty/committed", async () => {
    const { root, tracker } = await makeRepo();
    await tracker.captureBaseline();
    writeFileSync(join(root, "new.txt"), "n\n");
    const report = await tracker.changesSinceBaseline();
    expect(report.untracked).toEqual(["new.txt"]);
    expect(report.dirty).toEqual([]);
    expect(report.committedFiles).toEqual([]);
  });

  test("dirty（未暂存修改已跟踪文件）", async () => {
    const { root, tracker } = await makeRepo();
    await tracker.captureBaseline();
    writeFileSync(join(root, "base.txt"), "changed\n");
    const report = await tracker.changesSinceBaseline();
    expect(report.dirty).toEqual(["base.txt"]);
    expect(report.untracked).toEqual([]);
    expect(report.committedFiles).toEqual([]);
  });

  test("dirty（staged：git add 新文件 → A 状态归 dirty）", async () => {
    const { root, tracker } = await makeRepo();
    await tracker.captureBaseline();
    writeFileSync(join(root, "staged.txt"), "s\n");
    await git(root, ["add", "staged.txt"]);
    const report = await tracker.changesSinceBaseline();
    expect(report.dirty).toEqual(["staged.txt"]);
    expect(report.untracked).toEqual([]);
  });

  test("dirty（staged 删除：git rm → D 状态）", async () => {
    const { root, tracker } = await makeRepo();
    await tracker.captureBaseline();
    await git(root, ["rm", "-q", "base.txt"]);
    const report = await tracker.changesSinceBaseline();
    expect(report.dirty).toEqual(["base.txt"]);
  });

  test("committed：修改后提交 → numstat 增删行数精确（+1 -2），各态归位", async () => {
    const { root, tracker } = await makeRepo();
    writeFileSync(join(root, "edit.txt"), "alpha\nbeta\ngamma\n");
    await git(root, ["add", "edit.txt"]);
    await git(root, ["commit", "-qm", "add edit"]);
    await tracker.captureBaseline(); // 基线含 edit.txt 的初版
    writeFileSync(join(root, "edit.txt"), "alpha\nGamma\n");
    await git(root, ["add", "edit.txt"]);
    await git(root, ["commit", "-qm", "edit edit"]);

    const report = await tracker.changesSinceBaseline();
    expect(report.committedFiles).toEqual([{ path: "edit.txt", insertions: 1, deletions: 2, binary: false }]);
    expect(report.totalInsertions).toBe(1);
    expect(report.totalDeletions).toBe(2);
    expect(report.dirty).toEqual([]);
    expect(report.untracked).toEqual([]);
  });

  test("混合矩阵：committed + untracked + dirty 各归其位，总计只算 committed", async () => {
    const { root, tracker, baseHead } = await makeRepo();
    await tracker.captureBaseline();
    // committed：新文件直接提交
    writeFileSync(join(root, "c.txt"), "l1\nl2\n");
    await git(root, ["add", "c.txt"]);
    await git(root, ["commit", "-qm", "c"]);
    // dirty：改已跟踪文件（未提交）
    writeFileSync(join(root, "base.txt"), "dirty\n");
    // untracked：裸新文件
    writeFileSync(join(root, "u.txt"), "u\n");

    const report = await tracker.changesSinceBaseline();
    expect(report.baseHead).toBe(baseHead);
    expect(report.committedFiles).toEqual([{ path: "c.txt", insertions: 2, deletions: 0, binary: false }]);
    expect(report.dirty).toEqual(["base.txt"]);
    expect(report.untracked).toEqual(["u.txt"]);
    expect(report.totalInsertions).toBe(2);
    expect(report.totalDeletions).toBe(0);
  });

  test("二进制文件：numstat `-` 解析为 binary:true，行数计 0", async () => {
    const { root, tracker } = await makeRepo();
    await tracker.captureBaseline();
    writeFileSync(join(root, "bin.dat"), new Uint8Array([0x00, 0x01, 0xff, 0x02, 0x00]));
    await git(root, ["add", "bin.dat"]);
    await git(root, ["commit", "-qm", "bin"]);

    const report = await tracker.changesSinceBaseline();
    expect(report.committedFiles).toEqual([{ path: "bin.dat", insertions: 0, deletions: 0, binary: true }]);
    expect(report.totalInsertions).toBe(0);
    expect(report.totalDeletions).toBe(0);
  });

  test("空仓库首批提交：基线无 HEAD，以空树为 diff 起点计入 committed", async () => {
    const root = makeTmp();
    await git(root, ["init", "-q", "-b", "main"]);
    await git(root, ["config", "user.name", "bi-test"]);
    await git(root, ["config", "user.email", "bi-test@example.invalid"]);
    const tracker = new WorkspaceTracker({ repoRoot: root, clock });
    await tracker.captureBaseline();
    expect(tracker.baseline).toBeNull();

    writeFileSync(join(root, "first.txt"), "a\nb\nc\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-qm", "first"]);

    const report = await tracker.changesSinceBaseline();
    expect(report.baseHead).toBeNull();
    expect(report.committedFiles).toEqual([
      { path: "first.txt", insertions: 3, deletions: 0, binary: false },
    ]);
    expect(report.totalInsertions).toBe(3);
  });

  test("存量噪音差分：基线前已 dirty 的文件不上报；提交后转为 committed 计入", async () => {
    const { root, tracker } = await makeRepo();
    writeFileSync(join(root, "base.txt"), "pre-dirty\n"); // 建基线前就脏
    await tracker.captureBaseline();
    // 建基线后又追加修改，仍未提交 → 仍属存量噪音，不上报
    writeFileSync(join(root, "base.txt"), "pre-dirty-more\n");
    let report = await tracker.changesSinceBaseline();
    expect(report.dirty).toEqual([]);
    expect(report.committedFiles).toEqual([]);

    // 提交后：以基线 HEAD 为起点的 diff 全额计入 committed
    await git(root, ["add", "base.txt"]);
    await git(root, ["commit", "-qm", "commit the dirt"]);
    report = await tracker.changesSinceBaseline();
    expect(report.committedFiles).toEqual([
      { path: "base.txt", insertions: 1, deletions: 1, binary: false },
    ]);
    expect(report.dirty).toEqual([]);
  });

  test("存量噪音差分：基线前已 untracked 的文件不上报；add+commit 后计入 committed", async () => {
    const { root, tracker } = await makeRepo();
    writeFileSync(join(root, "ghost.txt"), "g1\ng2\n"); // 基线前就 untracked
    await tracker.captureBaseline();
    let report = await tracker.changesSinceBaseline();
    expect(report.untracked).toEqual([]);

    await git(root, ["add", "ghost.txt"]);
    await git(root, ["commit", "-qm", "adopt ghost"]);
    report = await tracker.changesSinceBaseline();
    expect(report.untracked).toEqual([]);
    expect(report.committedFiles).toEqual([
      { path: "ghost.txt", insertions: 2, deletions: 0, binary: false },
    ]);
  });

  test("二次 captureBaseline 重置基线：旧变更不再上报", async () => {
    const { root, tracker } = await makeRepo();
    await tracker.captureBaseline();
    writeFileSync(join(root, "m.txt"), "m\n");
    await git(root, ["add", "m.txt"]);
    await git(root, ["commit", "-qm", "m"]);
    const first = await tracker.changesSinceBaseline();
    expect(first.committedFiles).toEqual([{ path: "m.txt", insertions: 1, deletions: 0, binary: false }]);

    await tracker.captureBaseline(); // 重置：新 HEAD 为基线
    const second = await tracker.changesSinceBaseline();
    expect(second.committedFiles).toEqual([]);
    expect(second.baseHead).toBe((await git(root, ["rev-parse", "HEAD"])).trim());
  });
});

// ---------- 结构化错误 ----------

describe("WorkspaceTracker · 结构化错误", () => {
  test("未建基线即查询 → no-baseline", async () => {
    const { tracker } = await makeRepo();
    let caught: unknown = null;
    try {
      await tracker.changesSinceBaseline();
    } catch (err) {
      caught = err;
    }
    expect(isTrackerError(caught)).toBe(true);
    expect((caught as TrackerError).code).toBe("no-baseline");
  });

  test("stub runner git 失败 → git-failed（含子命令与 stderr 首行）", async () => {
    const root = makeTmp();
    let headCalls = 0; // 首次（建基线）与再次（查报告）返回不同 HEAD，才会走到 diff
    const runner: GitRunner = async (args) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        headCalls++;
        return { code: 0, stdout: headCalls === 1 ? "aaa111bbb\n" : "ccc222ddd\n", stderr: "" };
      }
      if (args[0] === "status") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "diff") {
        return { code: 128, stdout: "", stderr: "fatal: boom\n" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const tracker = new WorkspaceTracker({ repoRoot: root, gitRunner: runner });
    await tracker.captureBaseline();
    let caught: unknown = null;
    try {
      await tracker.changesSinceBaseline();
    } catch (err) {
      caught = err;
    }
    expect(isTrackerError(caught)).toBe(true);
    expect((caught as TrackerError).code).toBe("git-failed");
    expect((caught as TrackerError).message).toContain("diff --numstat");
    expect((caught as TrackerError).message).toContain("boom");
  });
});

// ---------- 纯函数 ----------

describe("parseNumstat（纯函数）", () => {
  test("多文件 + 二进制 `-` + 纯删除 + 路径含空格", () => {
    const text = [
      "10\t2\tsrc/a.ts",
      "-\t-\tassets/logo.png",
      "0\t5\told/deleted.txt",
      "3\t1\tdocs/my file.md",
      "",
    ].join("\n");
    expect(parseNumstat(text)).toEqual([
      { path: "src/a.ts", insertions: 10, deletions: 2, binary: false },
      { path: "assets/logo.png", insertions: 0, deletions: 0, binary: true },
      { path: "old/deleted.txt", insertions: 0, deletions: 5, binary: false },
      { path: "docs/my file.md", insertions: 3, deletions: 1, binary: false },
    ]);
  });

  test("空输出 → 空数组；残缺行跳过", () => {
    expect(parseNumstat("")).toEqual([]);
    expect(parseNumstat("\n\n")).toEqual([]);
    expect(parseNumstat("not-a-numstat-line")).toEqual([]);
  });
});

describe("parsePorcelainZ（纯函数）", () => {
  test("untracked/staged/unstaged/delete 各态；rename 双字段取新路径", () => {
    const text = "?? new.txt\0A  staged.txt\0 M mod.txt\0R  renamed.txt\0old-name.txt\0D  gone.txt\0";
    const map = parsePorcelainZ(text);
    expect(map.get("new.txt")).toBe("??");
    expect(map.get("staged.txt")).toBe("A ");
    expect(map.get("mod.txt")).toBe(" M");
    expect(map.get("renamed.txt")).toBe("R ");
    expect(map.has("old-name.txt")).toBe(false); // 原始路径被消费
    expect(map.get("gone.txt")).toBe("D ");
    expect(map.size).toBe(5);
  });

  test("空输出 / 尾部空字段 → 空映射", () => {
    expect(parsePorcelainZ("").size).toBe(0);
    expect(parsePorcelainZ("\0\0").size).toBe(0);
  });
});

// ---------- renderChangeCard 快照 ----------

describe("renderChangeCard（纯函数快照）", () => {
  const RULE = "──────────────────────────────────────";

  test("空报告：零噪音（单行 No changes + 0 files changed 汇总）", () => {
    const report: ChangeReport = {
      baseHead: "abc1234567890",
      committedFiles: [],
      untracked: [],
      dirty: [],
      totalInsertions: 0,
      totalDeletions: 0,
    };
    expect(renderChangeCard(report)).toBe(
      [
        "📊 Workspace Changes · base abc1234",
        RULE,
        "No changes since baseline.",
        RULE,
        "0 files changed, +0 -0",
      ].join("\n"),
    );
  });

  test("混合报告：Committed/Untracked/Dirty 分节 + 汇总行", () => {
    const report: ChangeReport = {
      baseHead: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      committedFiles: [
        { path: "src/a.ts", insertions: 10, deletions: 2, binary: false },
        { path: "assets/logo.png", insertions: 0, deletions: 0, binary: true },
      ],
      untracked: ["data/new.json"],
      dirty: ["src/b.ts"],
      totalInsertions: 10,
      totalDeletions: 2,
    };
    expect(renderChangeCard(report)).toBe(
      [
        "📊 Workspace Changes · base deadbee",
        RULE,
        "Committed:",
        "  1. +10 -2  src/a.ts",
        "  2. binary  assets/logo.png",
        "Untracked:",
        "  ?? data/new.json",
        "Dirty:",
        "  M  src/b.ts",
        RULE,
        "2 files changed, +10 -2 · 1 untracked · 1 dirty",
      ].join("\n"),
    );
  });

  test("单 committed 时单数形态（1 file changed）且无尾部噪音", () => {
    const report: ChangeReport = {
      baseHead: null,
      committedFiles: [{ path: "x.txt", insertions: 1, deletions: 0, binary: false }],
      untracked: [],
      dirty: [],
      totalInsertions: 1,
      totalDeletions: 0,
    };
    expect(renderChangeCard(report)).toBe(
      [
        "📊 Workspace Changes · base <none>",
        RULE,
        "Committed:",
        "  1. +1 -0  x.txt",
        RULE,
        "1 file changed, +1 -0",
      ].join("\n"),
    );
  });

  test("tracker 实例渲染与纯函数一致", async () => {
    const { tracker } = await makeRepo();
    await tracker.captureBaseline();
    const report = await tracker.changesSinceBaseline();
    expect(tracker.renderChangeCard(report)).toBe(renderChangeCard(report));
  });
});
