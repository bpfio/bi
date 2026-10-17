/**
 * @bi/worktree 测试 —— BI-12 Git Worktree 物理并发沙箱引擎。
 *
 * 分两层：
 * - 真实 git fixture：每个用例在 tmp 目录 `git init` 真实仓库（全本机零网络），
 *   覆盖 create/list/get/remove/discard/mergeBack 全生命周期与冲突审查门语义；
 * - stub gitRunner：注入桩执行器覆盖引擎纯逻辑（argv 顺序契约、结构化错误、stderr 脱敏）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorktreeEngine,
  WorktreeError,
  branchName,
  ensureUniqueBranch,
  isWorktreeError,
  isValidTaskId,
  parseBranchName,
  sanitizeGitStderr,
} from "./index";
import type { GitRunner, WorktreeErrorCode } from "./index";

// ---------- 测试基建 ----------

let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "bi-worktree-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

/** 测试侧真实 git 调用（仅用于搭建/校验 fixture，非被测对象）。 */
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
  baseCommit: string;
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
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "baseline"]);
  const engine = new WorktreeEngine({ reposRoot: repo, worktreesRoot: worktrees });
  const baseCommit = (await git(repo, ["rev-parse", "HEAD"])).trim();
  return { root, repo, worktrees, engine, baseCommit };
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function expectCode(fn: () => Promise<unknown>, code: WorktreeErrorCode): Promise<WorktreeError> {
  try {
    await fn();
  } catch (err) {
    if (!isWorktreeError(err)) throw err;
    expect(err.code).toBe(code);
    return err;
  }
  throw new Error(`期望抛出 WorktreeError(${code})，但调用成功了`);
}

// ---------- branch.ts：命名与路径安全 ----------

describe("branch 命名与路径安全", () => {
  test("taskId 白名单合法样本", () => {
    for (const id of ["t1", "BI-12", "a.b_c-d", "9", "Task.Fix_1-2", "x".repeat(128)]) {
      expect(isValidTaskId(id)).toBe(true);
    }
  });

  test("taskId 非法样本拒绝（含 .. 穿越与 . 与超长）", () => {
    for (const id of ["", "..", ".", "a..b", "../escape", "a/b", "a b", "a@b", "a\tb", "中", "a".repeat(129)]) {
      expect(isValidTaskId(id)).toBe(false);
    }
  });

  test("branchName 对非法 taskId 抛结构化错误 invalid-task-id", () => {
    try {
      branchName("../escape");
      throw new Error("应当抛错");
    } catch (err) {
      expect(isWorktreeError(err)).toBe(true);
      if (isWorktreeError(err)) {
        expect(err.code).toBe("invalid-task-id");
        expect(err.message).toContain("..");
      }
    }
  });

  test("branchName ↔ parseBranchName 双向映射", () => {
    for (const id of ["t1", "BI-12", "a.b_c-d"]) {
      const branch = branchName(id);
      expect(branch).toBe(`bi-task-${id}`);
      expect(parseBranchName(branch)).toBe(id);
    }
  });

  test("parseBranchName 对非本域分支与坏后缀返回 null", () => {
    for (const b of ["main", "feature/x", "bi-task-", "bi-task-a/b", "bi-task-..", "task-bi-1"]) {
      expect(parseBranchName(b)).toBeNull();
    }
  });

  test("ensureUniqueBranch：空闲原样返回 / 冲突追加最小数字后缀", () => {
    expect(ensureUniqueBranch("bi-task-t1", [])).toBe("bi-task-t1");
    expect(ensureUniqueBranch("bi-task-t1", ["bi-task-t1"])).toBe("bi-task-t1.2");
    expect(ensureUniqueBranch("bi-task-t1", ["bi-task-t1", "bi-task-t1.2"])).toBe("bi-task-t1.3");
    expect(ensureUniqueBranch("bi-task-t1", new Set(["bi-task-t1", "bi-task-t1.2", "bi-task-t1.3"]))).toBe(
      "bi-task-t1.4",
    );
  });
});

// ---------- WorktreeEngine · 真实 git fixture ----------

describe("WorktreeEngine · 真实 git fixture", () => {
  test("create 基本流：目录/分支/baseCommit 全部就位", async () => {
    const fx = await setupFixture();
    const info = await fx.engine.create("t1");

    expect(info.taskId).toBe("t1");
    expect(info.worktreePath).toBe(join(fx.worktrees, "t1"));
    expect(info.branch).toBe("bi-task-t1");
    expect(info.baseCommit).toBe(fx.baseCommit);
    expect(typeof info.createdAt).toBe("string");
    expect(existsSync(join(fx.worktrees, "t1"))).toBe(true);
    expect(await branchExists(fx.repo, "bi-task-t1")).toBe(true);
    expect((await git(fx.repo, ["rev-parse", "bi-task-t1"])).trim()).toBe(fx.baseCommit);
    expect(fx.engine.reposRoot).toBe(fx.repo);
  });

  test("create 支持 baseRef：分支指向指定基线提交", async () => {
    const fx = await setupFixture();
    writeFileSync(join(fx.repo, "README.md"), "# second\n");
    await git(fx.repo, ["add", "."]);
    await git(fx.repo, ["commit", "-m", "second"]);
    const firstCommit = (await git(fx.repo, ["rev-parse", "HEAD~1"])).trim();

    const info = await fx.engine.create("t-br", { baseRef: firstCommit });
    expect(info.baseCommit).toBe(firstCommit);
    expect((await git(fx.repo, ["rev-parse", "bi-task-t-br"])).trim()).toBe(firstCommit);
  });

  test("create 重复 taskId → worktree-exists", async () => {
    const fx = await setupFixture();
    await fx.engine.create("dup");
    await expectCode(() => fx.engine.create("dup"), "worktree-exists");
  });

  test("create 路径被占用 → worktree-exists（路径冲突同理）", async () => {
    const fx = await setupFixture();
    mkdirSync(join(fx.worktrees, "occupied"), { recursive: true });
    const err = await expectCode(() => fx.engine.create("occupied"), "worktree-exists");
    expect(err.message).toContain("占用");
  });

  test("create 遗留分支冲突 → worktree-exists", async () => {
    const fx = await setupFixture();
    await git(fx.repo, ["branch", "bi-task-legacy"]);
    await expectCode(() => fx.engine.create("legacy"), "worktree-exists");
  });

  test("两个 worktree 并行存在且互不干扰", async () => {
    const fx = await setupFixture();
    await fx.engine.create("t1");
    await fx.engine.create("t2");

    expect(existsSync(join(fx.worktrees, "t1"))).toBe(true);
    expect(existsSync(join(fx.worktrees, "t2"))).toBe(true);
    expect(await branchExists(fx.repo, "bi-task-t1")).toBe(true);
    expect(await branchExists(fx.repo, "bi-task-t2")).toBe(true);

    writeFileSync(join(fx.worktrees, "t1", "only-t1.txt"), "1\n");
    writeFileSync(join(fx.worktrees, "t2", "only-t2.txt"), "2\n");
    expect(existsSync(join(fx.worktrees, "t1", "only-t2.txt"))).toBe(false);
    expect(existsSync(join(fx.worktrees, "t2", "only-t1.txt"))).toBe(false);

    const all = await fx.engine.list();
    expect(all.map((i) => i.taskId)).toEqual(["t1", "t2"]);
  });

  test("list 返回本引擎管辖条目（路径/分支/基线）", async () => {
    const fx = await setupFixture();
    await fx.engine.create("alpha");
    const infos = await fx.engine.list();
    expect(infos).toHaveLength(1);
    expect(infos[0]?.taskId).toBe("alpha");
    expect(infos[0]?.worktreePath).toBe(join(fx.worktrees, "alpha"));
    expect(infos[0]?.branch).toBe("bi-task-alpha");
    expect(infos[0]?.baseCommit).toBe(fx.baseCommit);
  });

  test("get：命中返回快照 / 未命中返回 null / 非法 taskId 返回 null", async () => {
    const fx = await setupFixture();
    await fx.engine.create("t1");

    const hit = await fx.engine.get("t1");
    expect(hit?.taskId).toBe("t1");
    expect(hit?.branch).toBe("bi-task-t1");
    expect(hit?.worktreePath).toBe(join(fx.worktrees, "t1"));
    expect(await fx.engine.get("absent")).toBeNull();
    expect(await fx.engine.get("../evil")).toBeNull();
  });

  test("remove：移除目录并清理分支", async () => {
    const fx = await setupFixture();
    await fx.engine.create("t1");
    const result = await fx.engine.remove("t1");

    expect(result).toEqual({ taskId: "t1", removed: true, branchDeleted: true });
    expect(existsSync(join(fx.worktrees, "t1"))).toBe(false);
    expect(await branchExists(fx.repo, "bi-task-t1")).toBe(false);
    expect(await fx.engine.get("t1")).toBeNull();
  });

  test("remove 幂等：已移除后再次 remove 返回 removed:false 不抛错", async () => {
    const fx = await setupFixture();
    const ghost = await fx.engine.remove("ghost");
    expect(ghost).toEqual({ taskId: "ghost", removed: false, branchDeleted: false });

    await fx.engine.create("t1");
    expect((await fx.engine.remove("t1")).removed).toBe(true);
    const again = await fx.engine.remove("t1");
    expect(again).toEqual({ taskId: "t1", removed: false, branchDeleted: false });
  });

  test("remove 脏工作树需 force（未提交改动保护）", async () => {
    const fx = await setupFixture();
    await fx.engine.create("dirty");
    writeFileSync(join(fx.worktrees, "dirty", "base.txt"), "dirty\n");

    await expectCode(() => fx.engine.remove("dirty"), "git-error");
    expect(existsSync(join(fx.worktrees, "dirty"))).toBe(true);

    const forced = await fx.engine.remove("dirty", { force: true });
    expect(forced.removed).toBe(true);
    expect(existsSync(join(fx.worktrees, "dirty"))).toBe(false);
  });

  test("mergeBack 成功：--no-ff 合回 + 自动清理，主仓库拿到改动", async () => {
    const fx = await setupFixture();
    const wt = join(fx.worktrees, "mt");
    await fx.engine.create("mt");
    writeFileSync(join(wt, "base.txt"), "line-one-worktree\n");
    writeFileSync(join(wt, "feat.txt"), "feat\n");
    await git(wt, ["add", "."]);
    await git(wt, ["commit", "-m", "task work"]);

    const result = await fx.engine.mergeBack("mt", { message: "审查通过：合回任务 mt" });
    if (!result.merged) throw new Error(`期望合并成功，实际 conflict: ${result.stderr}`);

    expect(result.removed).toBe(true);
    // --no-ff：merge commit 双亲
    const parents = (await git(fx.repo, ["cat-file", "-p", result.commit]))
      .split("\n")
      .filter((line) => line.startsWith("parent "));
    expect(parents).toHaveLength(2);
    // 主仓库内容更新
    expect(readFileSync(join(fx.repo, "base.txt"), "utf8")).toBe("line-one-worktree\n");
    expect(existsSync(join(fx.repo, "feat.txt"))).toBe(true);
    // 自动清理：工作树与分支均消失
    expect(existsSync(wt)).toBe(false);
    expect(await branchExists(fx.repo, "bi-task-mt")).toBe(false);
    expect(await fx.engine.list()).toHaveLength(0);
  });

  test("mergeBack 冲突：conflict:true 且主仓库零污染、不自动解决", async () => {
    const fx = await setupFixture();
    const wt = join(fx.worktrees, "cf");
    await fx.engine.create("cf");
    writeFileSync(join(wt, "base.txt"), "worktree-change\n");
    await git(wt, ["add", "."]);
    await git(wt, ["commit", "-m", "wt side"]);
    writeFileSync(join(fx.repo, "base.txt"), "main-change\n");
    await git(fx.repo, ["add", "."]);
    await git(fx.repo, ["commit", "-m", "main side"]);

    const result = await fx.engine.mergeBack("cf", { message: "审查通过" });
    expect(result).toMatchObject({ taskId: "cf", merged: false, conflict: true });
    if (!result.merged) expect(result.stderr).toContain("CONFLICT");

    // 主仓库未被污染：merge --abort 已回滚现场
    expect(await git(fx.repo, ["status", "--porcelain"])).toBe("");
    let mergeHead = "";
    try {
      mergeHead = (await git(fx.repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).trim();
    } catch {
      mergeHead = "";
    }
    expect(mergeHead).toBe("");
    expect(readFileSync(join(fx.repo, "base.txt"), "utf8")).toBe("main-change\n");
    // 工作树与分支原样保留，交人类审查门裁决
    expect(existsSync(wt)).toBe(true);
    expect(await branchExists(fx.repo, "bi-task-cf")).toBe(true);
    expect((await fx.engine.list()).map((i) => i.taskId)).toContain("cf");
  });

  test("mergeBack 分支缺失 → worktree-missing", async () => {
    const fx = await setupFixture();
    const err = await expectCode(() => fx.engine.mergeBack("nope", { message: "x" }), "worktree-missing");
    expect(err.message).toContain("bi-task-nope");
  });

  test("mergeBack 空 message → invalid-argument", async () => {
    const fx = await setupFixture();
    await fx.engine.create("t1");
    await expectCode(() => fx.engine.mergeBack("t1", { message: "  " }), "invalid-argument");
  });

  test("discard 静默清空：已提交与未提交改动一并丢弃", async () => {
    const fx = await setupFixture();
    const wt = join(fx.worktrees, "drop");
    await fx.engine.create("drop");
    writeFileSync(join(wt, "base.txt"), "will-be-dropped\n");
    await git(wt, ["add", "."]);
    await git(wt, ["commit", "-m", "to discard"]);
    writeFileSync(join(wt, "uncommitted.txt"), "junk\n");

    const result = await fx.engine.discard("drop");
    expect(result).toEqual({ taskId: "drop", removed: true, branchDeleted: true });
    expect(existsSync(wt)).toBe(false);
    expect(await branchExists(fx.repo, "bi-task-drop")).toBe(false);
    // 主仓库零污染：丢弃的改动从未进入 main
    expect(readFileSync(join(fx.repo, "base.txt"), "utf8")).toBe("line-one\n");
    expect(existsSync(join(fx.repo, "uncommitted.txt"))).toBe(false);
  });

  test("taskId 路径穿越拒绝：.. 与 / 均拒，且无目录逃逸", async () => {
    const fx = await setupFixture();
    for (const bad of ["../escape", "a..b", "..", "a/b"]) {
      await expectCode(() => fx.engine.create(bad), "invalid-task-id");
    }
    expect(existsSync(join(fx.root, "escape"))).toBe(false);
    expect(existsSync(join(fx.worktrees, "escape"))).toBe(false);
    expect(existsSync(join(fx.root, "b"))).toBe(false);
  });

  test("未指定仓库（构造与调用均缺省）→ repo-missing", async () => {
    const root = makeTmp();
    const engine = new WorktreeEngine({ worktreesRoot: join(root, "wts") });
    const err = await expectCode(() => engine.create("t1"), "repo-missing");
    expect(err.message).toContain("reposRoot");
  });

  test("目标目录不是 git 仓库 → repo-missing", async () => {
    const root = makeTmp();
    const plain = join(root, "plain");
    mkdirSync(plain, { recursive: true });
    const engine = new WorktreeEngine({ reposRoot: plain, worktreesRoot: join(root, "wts") });
    await expectCode(() => engine.create("t1"), "repo-missing");
  });
});

// ---------- WorktreeEngine · stub gitRunner ----------

interface StubCall {
  args: readonly string[];
  cwd: string;
}

function makeStub(handler: (args: readonly string[]) => { code: number; stdout?: string; stderr?: string }): {
  runner: GitRunner;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const runner: GitRunner = async (args, opts) => {
    calls.push({ args, cwd: opts.cwd });
    const res = handler(args);
    return { code: res.code, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  };
  return { runner, calls };
}

describe("WorktreeEngine · stub gitRunner", () => {
  test("create 的 git argv 遵守工单顺序：worktree add <path> -b <branch> [baseRef]", async () => {
    const root = makeTmp();
    const repo = join(root, "repo");
    const wts = join(root, "wts");
    const { runner, calls } = makeStub((args) => {
      const joined = args.join(" ");
      if (joined === "rev-parse --show-toplevel") return { code: 0, stdout: repo };
      if (joined === "worktree list --porcelain") return { code: 0, stdout: "" };
      if (args[0] === "rev-parse" && args[1] === "--verify") return { code: 1 };
      if (args[0] === "worktree" && args[1] === "add") return { code: 0 };
      if (args[0] === "rev-parse" && args[1] === "bi-task-argv") return { code: 0, stdout: "abc123\n" };
      return { code: 0 };
    });
    const engine = new WorktreeEngine({ reposRoot: repo, worktreesRoot: wts, gitRunner: runner });

    const info = await engine.create("argv", { baseRef: "HEAD~2" });
    expect(info.baseCommit).toBe("abc123");
    const add = calls.find((c) => c.args[0] === "worktree" && c.args[1] === "add");
    expect(add?.args).toEqual(["worktree", "add", join(wts, "argv"), "-b", "bi-task-argv", "HEAD~2"]);
    expect(add?.cwd).toBe(repo);

    // 无 baseRef 时 argv 以分支名收尾
    const { runner: runner2, calls: calls2 } = makeStub((args) => {
      const joined = args.join(" ");
      if (joined === "rev-parse --show-toplevel") return { code: 0, stdout: repo };
      if (joined === "worktree list --porcelain") return { code: 0, stdout: "" };
      if (args[0] === "rev-parse" && args[1] === "--verify") return { code: 1 };
      if (args[0] === "worktree" && args[1] === "add") return { code: 0 };
      if (args[0] === "rev-parse" && args[1] === "bi-task-argv2") return { code: 0, stdout: "def456\n" };
      return { code: 0 };
    });
    const engine2 = new WorktreeEngine({ reposRoot: repo, worktreesRoot: wts, gitRunner: runner2 });
    await engine2.create("argv2");
    const add2 = calls2.find((c) => c.args[0] === "worktree" && c.args[1] === "add");
    expect(add2?.args).toEqual(["worktree", "add", join(wts, "argv2"), "-b", "bi-task-argv2"]);
  });

  test("git 失败结构化：code=git-error 且 stderr 已脱敏（凭据打码、敏感路径占位）", async () => {
    const root = makeTmp();
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    const home = homedir();
    const { runner } = makeStub((args) => {
      if (args.join(" ") === "rev-parse --show-toplevel") return { code: 0, stdout: repo };
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          code: 128,
          stderr: `fatal: unable to access 'https://ops:ghp_secret123@github.com/bpfio/bi.git'\nhint: config at ${join(home, ".bi", "config")}`,
        };
      }
      return { code: 0 };
    });
    const engine = new WorktreeEngine({ reposRoot: repo, worktreesRoot: join(root, "wts"), gitRunner: runner });
    const err = await expectCode(() => engine.create("t1"), "git-error");

    expect(err.stderr).toContain("***");
    expect(err.stderr).not.toContain("ghp_secret123");
    expect(err.stderr).not.toContain(home);
    expect(err.stderr).toContain("~");
    expect(err.taskId).toBe("t1");
  });

  test("gitRunner 抛异常时包装为 git-error 结构化错误", async () => {
    const root = makeTmp();
    const runner: GitRunner = async () => {
      throw new Error("boom");
    };
    const engine = new WorktreeEngine({ reposRoot: join(root, "repo"), worktreesRoot: join(root, "wts"), gitRunner: runner });
    const err = await expectCode(() => engine.create("t1"), "git-error");
    expect(err.stderr).toContain("boom");
  });

  test("默认 worktreesRoot 为 ~/.bi/worktrees", () => {
    const engine = new WorktreeEngine();
    expect(engine.worktreesRoot).toBe(join(homedir(), ".bi", "worktrees"));
  });

  test("sanitizeGitStderr：凭据打码 / 路径占位 / 超长截断", () => {
    const masked = sanitizeGitStderr("fatal: https://user:token123@example.com/x.git rejected", {});
    expect(masked).toContain("user:***@example.com");
    expect(masked).not.toContain("token123");

    const home = homedir();
    const replaced = sanitizeGitStderr(
      `fatal: repo /tmp/fake-repo, wts /tmp/fake-repo/.wts/t1, home ${join(home, "x")}`,
      {
        repoRoot: "/tmp/fake-repo",
        worktreesRoot: "/tmp/fake-repo/.wts",
      },
    );
    expect(replaced).toContain("<repo>");
    expect(replaced).toContain("<worktrees>/t1");
    expect(replaced).toContain("~/x");
    expect(replaced).not.toContain(home);
    expect(replaced).not.toContain("/tmp/fake-repo");

    const truncated = sanitizeGitStderr("a".repeat(3000), {});
    expect(truncated.length).toBeLessThan(3000);
    expect(truncated.endsWith("…(truncated)")).toBe(true);
  });
});

// 全量 WorktreeError 导出一致性（含类型守卫）
describe("WorktreeError", () => {
  test("isWorktreeError 类型守卫与 cause 透传", () => {
    const cause = new Error("root");
    const err = new WorktreeError("git-error", "wrapper", { cause, stderr: "s" });
    expect(isWorktreeError(err)).toBe(true);
    expect(isWorktreeError(new Error("plain"))).toBe(false);
    expect(err.cause).toBe(cause);
    expect(err.stderr).toBe("s");
    expect(err.name).toBe("WorktreeError");
  });
});
