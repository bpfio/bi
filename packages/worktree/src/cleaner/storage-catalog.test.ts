/**
 * @bi/worktree 测试 —— BI-12.1 存储目录字典扫描器（storage-catalog）。
 *
 * 分两层：
 * - 真实 git fixture：tmp 目录真实仓库 + 引擎 create，覆盖在册/孤儿/merged 判定；
 * - stub gitRunner：伪造 porcelain 输出，覆盖纯分类逻辑与结构化错误。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeEngine, isWorktreeError, parseWorktreePorcelain, scanStorage } from "../index";
import type { GitRunner } from "../index";

// ---------- 测试基建 ----------

let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "bi-catalog-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`git ${args.join(" ")} 失败：${typeof stderr === "string" ? stderr : String(stderr)}`));
        return;
      }
      resolve(typeof stdout === "string" ? stdout : String(stdout));
    });
  });
}

interface Fixture {
  root: string;
  repo: string;
  worktrees: string;
  engine: WorktreeEngine;
}

async function setupFixture(): Promise<Fixture> {
  const root = makeTmp();
  const repo = join(root, "repo");
  const worktrees = join(root, "worktrees");
  mkdirSync(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "bi-test"]);
  await git(repo, ["config", "user.email", "bi-test@example.invalid"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repo, "base.txt"), "line-one\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "baseline"]);
  const engine = new WorktreeEngine({ reposRoot: repo, worktreesRoot: worktrees });
  return { root, repo, worktrees, engine };
}

function makeStub(handler: (args: readonly string[]) => { code: number; stdout?: string; stderr?: string }): GitRunner {
  return async (args) => {
    const res = handler(args);
    return { code: res.code, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  };
}

// ---------- parseWorktreePorcelain（纯函数） ----------

describe("parseWorktreePorcelain", () => {
  test("多条目解析：worktree/HEAD/branch 剥前缀/空行分条", () => {
    const text = [
      "worktree /repo",
      "HEAD abc111",
      "branch refs/heads/main",
      "",
      "worktree /wts/t1",
      "HEAD def222",
      "branch refs/heads/bi-task-t1",
      "",
    ].join("\n");
    const entries = parseWorktreePorcelain(text);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ path: "/repo", head: "abc111", branch: "main", bare: false, detached: false });
    expect(entries[1]).toEqual({ path: "/wts/t1", head: "def222", branch: "bi-task-t1", bare: false, detached: false });
  });

  test("bare 与 detached 标记行：无 branch 字段", () => {
    const text = [
      "worktree /repo",
      "bare",
      "",
      "worktree /wts/t2",
      "HEAD 789ccc",
      "detached",
      "",
    ].join("\n");
    const entries = parseWorktreePorcelain(text);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.path).toBe("/repo");
    expect(entries[0]?.bare).toBe(true);
    expect(entries[0]?.branch).toBeUndefined();
    expect(entries[1]).toMatchObject({ path: "/wts/t2", detached: true, bare: false });
    expect(entries[1]?.branch).toBeUndefined();
  });

  test("空输入与无尾随空行均安全", () => {
    expect(parseWorktreePorcelain("")).toEqual([]);
    expect(parseWorktreePorcelain("worktree /solo\nHEAD x\nbranch refs/heads/bi-task-s\n")).toHaveLength(1);
  });
});

// ---------- scanStorage · 真实 git fixture ----------

describe("scanStorage · 真实 git fixture", () => {
  test("引擎 create 的工作树 → kind worktree，branch/merged/lastUsedAt 就位", async () => {
    const fx = await setupFixture();
    await fx.engine.create("t1");
    const catalog = await scanStorage({ worktreesRoot: fx.worktrees, cwd: fx.repo });

    const entry = catalog.get(join(fx.worktrees, "t1"));
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe("worktree");
    expect(entry?.branch).toBe("bi-task-t1");
    expect(entry?.merged).toBe(true); // 分支停在基线（HEAD 祖先）→ 已合并语义
    expect(entry?.lastUsedAt).toBeGreaterThan(0);
    expect(entry?.lastUsedAt).toBeLessThanOrEqual(Date.now() + 1000);
    expect(catalog.size).toBe(1); // 主仓库本体不在 worktreesRoot 下，不收录
  });

  test("分支领先 HEAD → merged=false（未合并语义）", async () => {
    const fx = await setupFixture();
    await fx.engine.create("t1");
    const wt = join(fx.worktrees, "t1");
    writeFileSync(join(wt, "feat.txt"), "work\n");
    await git(wt, ["add", "."]);
    await git(wt, ["commit", "-m", "task work"]);

    const catalog = await scanStorage({ worktreesRoot: fx.worktrees, cwd: fx.repo });
    expect(catalog.get(wt)?.merged).toBe(false);
  });

  test("目录存在但 worktree list 不含 → orphan", async () => {
    const fx = await setupFixture();
    await fx.engine.create("t1");
    mkdirSync(join(fx.worktrees, "ghost"), { recursive: true });

    const catalog = await scanStorage({ worktreesRoot: fx.worktrees, cwd: fx.repo });
    const ghost = catalog.get(join(fx.worktrees, "ghost"));
    expect(ghost?.kind).toBe("orphan");
    expect(ghost?.merged).toBe(false);
    expect(catalog.get(join(fx.worktrees, "t1"))?.kind).toBe("worktree");
  });

  test("分支已删（detach 后 -D）→ orphan，且工作树目录原样存在", async () => {
    const fx = await setupFixture();
    const wt = join(fx.worktrees, "t1");
    await fx.engine.create("t1");
    await git(wt, ["checkout", "--detach"]);
    await git(fx.repo, ["branch", "-D", "bi-task-t1"]);

    const catalog = await scanStorage({ worktreesRoot: fx.worktrees, cwd: fx.repo });
    expect(catalog.get(wt)?.kind).toBe("orphan");
    // 孤儿不等于立即删除：判定与删除分离，删除是 CleanPlan 的职责
    expect(await git(fx.repo, ["worktree", "list", "--porcelain"])).toContain(wt);
  });

  test("普通文件与符号链接子项不收录（防路径逃逸）", async () => {
    const fx = await setupFixture();
    mkdirSync(fx.worktrees, { recursive: true });
    writeFileSync(join(fx.worktrees, "note.txt"), "junk\n");
    mkdirSync(join(fx.root, "elsewhere"), { recursive: true });
    symlinkSync(join(fx.root, "elsewhere"), join(fx.worktrees, "link"), "dir");

    const catalog = await scanStorage({ worktreesRoot: fx.worktrees, cwd: fx.repo });
    expect(catalog.size).toBe(0);
  });

  test("extraRoots 注册 log/cache 目录，kind 按注册归类", async () => {
    const fx = await setupFixture();
    const logs = join(fx.root, "logs");
    const caches = join(fx.root, "caches");
    mkdirSync(join(logs, "run-1"), { recursive: true });
    mkdirSync(join(caches, "chunk-9"), { recursive: true });

    const catalog = await scanStorage({
      worktreesRoot: fx.worktrees,
      cwd: fx.repo,
      extraRoots: [
        { path: logs, kind: "log" },
        { path: caches, kind: "cache" },
      ],
    });
    expect(catalog.get(join(logs, "run-1"))?.kind).toBe("log");
    expect(catalog.get(join(caches, "chunk-9"))?.kind).toBe("cache");
    expect(catalog.get(join(caches, "chunk-9"))?.merged).toBe(false);
  });

  test("根目录不存在 → 空 catalog，不抛错", async () => {
    const fx = await setupFixture();
    const catalog = await scanStorage({
      worktreesRoot: join(fx.root, "absent-wts"),
      cwd: fx.repo,
      extraRoots: [{ path: join(fx.root, "absent-logs"), kind: "log" }],
    });
    expect(catalog.size).toBe(0);
  });
});

// ---------- scanStorage · stub gitRunner ----------

describe("scanStorage · stub gitRunner", () => {
  test("伪造 porcelain + fs 目录 → 分类正确（worktree / 孤儿 / merged 按桩值）", async () => {
    const root = makeTmp();
    const wts = join(root, "wts");
    const repo = join(root, "repo");
    mkdirSync(join(wts, "t1"), { recursive: true });
    mkdirSync(join(wts, "ghost"), { recursive: true });
    const runner = makeStub((args) => {
      const joined = args.join(" ");
      if (joined === "worktree list --porcelain") {
        return {
          code: 0,
          stdout: `worktree ${join(wts, "t1")}\nHEAD abc\nbranch refs/heads/bi-task-t1\n\n`,
        };
      }
      if (joined === "rev-parse --verify --quiet refs/heads/bi-task-t1") return { code: 0 };
      if (joined === "merge-base --is-ancestor bi-task-t1 HEAD") return { code: 1 };
      return { code: 0 };
    });

    const catalog = await scanStorage({ worktreesRoot: wts, cwd: repo, gitRunner: runner });
    expect(catalog.get(join(wts, "t1"))).toMatchObject({
      kind: "worktree",
      branch: "bi-task-t1",
      merged: false,
    });
    expect(catalog.get(join(wts, "ghost"))?.kind).toBe("orphan");
  });

  test("在册但分支引用已删（rev-parse 失败）→ orphan 且保留遗留分支名", async () => {
    const root = makeTmp();
    const wts = join(root, "wts");
    const repo = join(root, "repo");
    mkdirSync(join(wts, "t1"), { recursive: true });
    const runner = makeStub((args) => {
      const joined = args.join(" ");
      if (joined === "worktree list --porcelain") {
        return {
          code: 0,
          stdout: `worktree ${join(wts, "t1")}\nHEAD abc\nbranch refs/heads/bi-task-t1\n\n`,
        };
      }
      if (joined === "rev-parse --verify --quiet refs/heads/bi-task-t1") return { code: 1 };
      return { code: 0 };
    });

    const catalog = await scanStorage({ worktreesRoot: wts, cwd: repo, gitRunner: runner });
    expect(catalog.get(join(wts, "t1"))).toMatchObject({ kind: "orphan", branch: "bi-task-t1", merged: false });
  });

  test("porcelain 失败 → 结构化 git-error，stderr 已脱敏", async () => {
    const root = makeTmp();
    const wts = join(root, "wts");
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    const runner = makeStub((args) => {
      if (args.join(" ") === "worktree list --porcelain") {
        return { code: 128, stderr: "fatal: https://ops:ghp_secret@github.com/x.git denied" };
      }
      return { code: 0 };
    });

    try {
      await scanStorage({ worktreesRoot: wts, cwd: repo, gitRunner: runner });
      throw new Error("应当抛错");
    } catch (err) {
      expect(isWorktreeError(err)).toBe(true);
      if (isWorktreeError(err)) {
        expect(err.code).toBe("git-error");
        expect(err.stderr).toContain("***");
        expect(err.stderr).not.toContain("ghp_secret");
      }
    }
  });

  test("now 注入：porcelain 为空 → 目录归类 orphan，lastUsedAt 取自 mtime", async () => {
    const root = makeTmp();
    const wts = join(root, "wts");
    mkdirSync(join(wts, "kid"), { recursive: true });
    const runner = makeStub(() => ({ code: 0, stdout: "" }));
    const catalog = await scanStorage({
      worktreesRoot: wts,
      cwd: root,
      gitRunner: runner,
      now: () => 12345,
    });
    const entry = catalog.get(join(wts, "kid"));
    expect(entry?.kind).toBe("orphan");
    expect(entry?.lastUsedAt).toBeGreaterThan(0); // mtime 正常时以 mtime 为准，而非注入回退值
  });
});
