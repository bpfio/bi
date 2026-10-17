/**
 * @bi/worktree 测试 —— BI-12.2 Tower 协作服务（tower-service）。
 *
 * 真实 git fixture + 组合已关单 WorktreeEngine（import 不改）：
 * 覆盖 13 个 Tower* 操作；重点为信件门禁（无 approved review →
 * merge-gate-blocked，引擎绝不被调用）、Spawn→Review→Merge 全流程、
 * Abort 静默清空与信件链保留、注入时钟时序、引擎结构化错误映射。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TowerService, WorktreeEngine } from "../index";
import type { TowerMessage } from "../index";

// ---------- 测试基建 ----------

let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "bi-tower-svc-test-"));
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
  towerRoot: string;
  engine: WorktreeEngine;
  tower: TowerService;
}

async function setupFixture(now: () => number = Date.now): Promise<Fixture> {
  const root = makeTmp();
  const repo = join(root, "repo");
  const worktrees = join(root, "worktrees");
  const towerRoot = join(root, "tower-home");
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
  const tower = new TowerService({ engine, towerRoot, now });
  return { root, repo, worktrees, towerRoot, engine, tower };
}

async function commitInWorktree(worktree: string, file: string, content: string): Promise<void> {
  writeFileSync(join(worktree, file), content);
  await git(worktree, ["add", "."]);
  await git(worktree, ["commit", "-m", `task: ${file}`]);
}

async function worktreeExists(repo: string, taskId: string): Promise<boolean> {
  const list = await git(repo, ["worktree", "list", "--porcelain"]);
  return list.split("\n").some((line) => line.endsWith(`/${taskId}`) || line.endsWith(`\\${taskId}`));
}

function bodies(letters: TowerMessage[]): string[] {
  return letters.map((letter) => letter.body);
}

// ---------- 塔级协议操作：Init / Plan / Mission / Finding ----------

describe("TowerService · 信件操作", () => {
  test("Init：建立 .tower/comms + 塔级广播信落盘", async () => {
    const fx = await setupFixture();
    const result = await fx.tower.init();

    expect(result.ok).toBe(true);
    expect(result.data?.commsDir).toBe(join(fx.towerRoot, ".tower", "comms"));
    expect(existsSync(join(fx.towerRoot, ".tower", "comms"))).toBe(true);
    expect(fx.tower.protocol.list()).toHaveLength(1);
    expect(fx.tower.protocol.list()[0]?.taskId).toBe("*");
  });

  test("Plan / Mission / Finding：kind 与 from 各归其位", async () => {
    const fx = await setupFixture();
    const plan = await fx.tower.plan("t1", "技术方案");
    const mission = await fx.tower.mission("t1", "实现功能 X");
    const finding = await fx.tower.finding("t1", "发现风险 Y");

    expect(plan.ok && plan.data?.from === "initiator" && plan.data?.kind === "plan").toBe(true);
    expect(mission.ok && mission.data?.from === "initiator" && mission.data?.kind === "status").toBe(true);
    expect(mission.data?.body.startsWith("mission: ")).toBe(true);
    expect(finding.ok && finding.data?.from === "worker" && finding.data?.kind === "finding").toBe(true);
    expect(fx.tower.protocol.readFor("t1")).toHaveLength(3);
  });

  test("Plan/Mission/Finding 空正文 → invalid-argument，不落信", async () => {
    const fx = await setupFixture();
    expect((await fx.tower.plan("t1", "  ")).code).toBe("invalid-argument");
    expect((await fx.tower.mission("t1", "")).code).toBe("invalid-argument");
    expect((await fx.tower.finding("t1", "  ")).code).toBe("invalid-argument");
    expect(fx.tower.protocol.list()).toHaveLength(0);
  });

  test("Inbox：角色信箱隔离 —— worker 收任务书与裁决，收不到自己的 finding", async () => {
    const fx = await setupFixture();
    await fx.tower.init();
    await fx.tower.mission("t1", "实现功能 X");
    await fx.tower.finding("t1", "发现风险 Y");
    await fx.tower.review("t1", true, "通过");

    const workerInbox = await fx.tower.inbox("worker", "t1");
    expect(workerInbox.ok).toBe(true);
    const list = workerInbox.data ?? [];
    expect(bodies(list)).toContain("mission: 实现功能 X");
    expect(bodies(list)).toContain("通过");
    expect(bodies(list)).not.toContain("发现风险 Y");
    expect(bodies(list)).toContain("tower initialized"); // 广播信在过滤视角可见

    const reviewerInbox = (await fx.tower.inbox("reviewer", "t1")).data ?? [];
    expect(bodies(reviewerInbox)).toContain("发现风险 Y");
    expect(bodies(reviewerInbox)).not.toContain("通过");
  });
});

// ---------- Spawn / Abort / Status ----------

describe("TowerService · Spawn / Abort / Status", () => {
  test("Spawn：工作树与分支物理落地 + spawn 信", async () => {
    const fx = await setupFixture();
    const result = await fx.tower.spawn("t1");

    expect(result.ok).toBe(true);
    expect(result.data?.worktreePath).toBe(join(fx.worktrees, "t1"));
    expect(existsSync(join(fx.worktrees, "t1"))).toBe(true);
    expect(await git(fx.repo, ["rev-parse", "--verify", "--quiet", "refs/heads/bi-task-t1"]).catch(() => "missing")).not.toBe("missing");
    const letters = fx.tower.protocol.readFor("t1");
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({ from: "initiator", kind: "status" });
    expect(letters[0]?.body).toContain("spawned");
  });

  test("Spawn 重复 taskId → 引擎结构化错误透传（worktree-exists）", async () => {
    const fx = await setupFixture();
    await fx.tower.spawn("dup");
    const again = await fx.tower.spawn("dup");
    expect(again.ok).toBe(false);
    expect(again.code).toBe("worktree-exists");
  });

  test("Spawn 无主仓库 → repo-missing 映射（引擎错误不抛出）", async () => {
    const root = makeTmp();
    const engine = new WorktreeEngine({ worktreesRoot: join(root, "wts") });
    const tower = new TowerService({ engine, towerRoot: join(root, "tower") });
    const result = await tower.spawn("t9");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("repo-missing");
  });

  test("Abort：静默清空工作树与分支，abort 信 append，历史信保留", async () => {
    const fx = await setupFixture();
    await fx.tower.spawn("ab");
    await commitInWorktree(join(fx.worktrees, "ab"), "wip.txt", "will be dropped\n");
    await fx.tower.finding("ab", "做不下去了");

    const result = await fx.tower.abort("ab", "方案不可行，重做");

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ taskId: "ab", removed: true, branchDeleted: true });
    expect(existsSync(join(fx.worktrees, "ab"))).toBe(false);
    expect(
      await git(fx.repo, ["rev-parse", "--verify", "--quiet", "refs/heads/bi-task-ab"]).catch(() => "missing"),
    ).toBe("missing");
    // 主仓库零污染
    expect(await git(fx.repo, ["status", "--porcelain"])).toBe("");
    // 信件 append-only：spawn/finding/abort 全链在案
    const letters = fx.tower.protocol.readFor("ab");
    expect(letters).toHaveLength(3);
    expect(bodies(letters)[2]).toBe("abort: 方案不可行，重做");
  });

  test("Abort 幂等：不存在的任务 → removed:false 仍 ok", async () => {
    const fx = await setupFixture();
    const result = await fx.tower.abort("ghost", "无事生非");
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ taskId: "ghost", removed: false, branchDeleted: false });
  });

  test("Status：信件统计 + 门禁状态随 review 翻转", async () => {
    const fx = await setupFixture();
    await fx.tower.spawn("st");
    const before = await fx.tower.status("st");
    expect(before.ok).toBe(true);
    expect(before.data?.worktree?.taskId).toBe("st");
    expect(before.data?.letterCount).toBe(1);
    expect(before.data?.mergeGateOpen).toBe(false);

    await fx.tower.review("st", true, "合格");
    const after = await fx.tower.status("st");
    expect(after.data?.mergeGateOpen).toBe(true);
    expect(after.data?.letterKinds).toMatchObject({ status: 1, review: 1, finding: 0 });
  });
});

// ---------- 合并门禁（RULE-BI-05 精神） ----------

describe("TowerService · TowerMerge 信件门禁", () => {
  test("无 review 信 → merge-gate-blocked，引擎绝不被调用", async () => {
    const fx = await setupFixture();
    await fx.tower.spawn("g1");
    const headBefore = (await git(fx.repo, ["rev-parse", "HEAD"])).trim();

    const result = await fx.tower.merge("g1");

    expect(result.ok).toBe(false);
    expect(result.code).toBe("merge-gate-blocked");
    expect(result.detail).toContain("RULE-BI-05");
    // 引擎未被调用：分支仍在、无新提交、无 merge-request 信
    expect(await worktreeExists(fx.repo, "g1")).toBe(true);
    expect((await git(fx.repo, ["rev-parse", "HEAD"])).trim()).toBe(headBefore);
    expect(fx.tower.protocol.readFor("g1").some((letter) => letter.kind === "merge-request")).toBe(false);
  });

  test("review 驳回（approved=false）→ 仍 blocked", async () => {
    const fx = await setupFixture();
    await fx.tower.spawn("g2");
    await fx.tower.review("g2", false, "不合格，返工");

    const result = await fx.tower.merge("g2");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("merge-gate-blocked");
  });

  test("非 reviewer 伪造的 approved review → 仍 blocked（门禁加严）", async () => {
    const fx = await setupFixture();
    await fx.tower.spawn("g3");
    fx.tower.protocol.post({ from: "worker", kind: "review", taskId: "g3", body: "自审通过", approved: true });

    const result = await fx.tower.merge("g3");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("merge-gate-blocked");
  });

  test("Spawn→Review→Merge 全流程：合回成功 + 审计信链 + 自动清理", async () => {
    const fx = await setupFixture();
    await fx.tower.spawn("flow");
    await commitInWorktree(join(fx.worktrees, "flow"), "feat.txt", "flow work\n");
    const review = await fx.tower.review("flow", true, "审查通过");
    const merge = await fx.tower.merge("flow");

    expect(merge.ok).toBe(true);
    expect(merge.data).toMatchObject({ taskId: "flow", merged: true, removed: true });
    // 主仓库拿到改动
    expect(readText(join(fx.repo, "feat.txt"))).toBe("flow work\n");
    // 工作树与分支已自动清理
    expect(existsSync(join(fx.worktrees, "flow"))).toBe(false);
    expect(await worktreeExists(fx.repo, "flow")).toBe(false);
    // 审计信链：spawned → review → merge-request → merged
    const letters = fx.tower.protocol.readFor("flow");
    expect(letters.map((letter) => letter.kind)).toEqual(["status", "review", "merge-request", "status"]);
    expect(letters[2]?.body).toContain(review.data?.id ?? "");
    expect(letters[3]?.body).toContain(`commit=${merge.data && merge.data.merged ? merge.data.commit : ""}`);
  });

  test("过门禁后合并冲突 → merge-conflict，主仓库零污染，现场保留", async () => {
    const fx = await setupFixture();
    await fx.tower.spawn("cf");
    await commitInWorktree(join(fx.worktrees, "cf"), "base.txt", "worktree-change\n");
    writeFileSync(join(fx.repo, "base.txt"), "main-change\n");
    await git(fx.repo, ["add", "."]);
    await git(fx.repo, ["commit", "-m", "main side"]);
    await fx.tower.review("cf", true, "内容本身没问题");

    const result = await fx.tower.merge("cf");

    expect(result.ok).toBe(false);
    expect(result.code).toBe("merge-conflict");
    expect(result.data).toMatchObject({ merged: false, conflict: true });
    // 现场已回滚：主仓库干净、工作树与分支保留
    expect(await git(fx.repo, ["status", "--porcelain"])).toBe("");
    expect(existsSync(join(fx.worktrees, "cf"))).toBe(true);
    expect(await worktreeExists(fx.repo, "cf")).toBe(true);
  });
});

// ---------- Rebase / Diff / Promote / 时钟 ----------

describe("TowerService · Rebase / Diff / Promote", () => {
  test("Rebase：任务分支追平前进后的 main，rebase 信落盘", async () => {
    const fx = await setupFixture();
    await fx.tower.spawn("rb");
    await commitInWorktree(join(fx.worktrees, "rb"), "task.txt", "task work\n");
    writeFileSync(join(fx.repo, "README.md"), "# advanced\n");
    await git(fx.repo, ["add", "."]);
    await git(fx.repo, ["commit", "-m", "main advance"]);

    const result = await fx.tower.rebase("rb");
    expect(result.ok).toBe(true);

    const log = await git(fx.repo, ["log", "--format=%s", "bi-task-rb"]);
    expect(log).toContain("main advance");
    expect(log).toContain("task: task.txt");
    expect(fx.tower.protocol.readFor("rb").some((letter) => letter.body === "rebased onto main")).toBe(true);
  });

  test("Rebase 不存在的任务 → worktree-missing", async () => {
    const fx = await setupFixture();
    const result = await fx.tower.rebase("nope");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("worktree-missing");
  });

  test("Diff：任务分支相对基线的差异文本", async () => {
    const fx = await setupFixture();
    await fx.tower.spawn("df");
    await commitInWorktree(join(fx.worktrees, "df"), "feat.txt", "diffable content\n");

    const result = await fx.tower.diff("df");
    expect(result.ok).toBe(true);
    expect(result.data?.diff).toContain("feat.txt");
    expect(result.data?.diff).toContain("diffable content");
  });

  test("Diff 不存在的任务 → worktree-missing", async () => {
    const fx = await setupFixture();
    const result = await fx.tower.diff("nope");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("worktree-missing");
  });

  test("Promote：无 approved review → promote-gate-blocked", async () => {
    const fx = await setupFixture();
    await fx.tower.spawn("p1");
    const result = await fx.tower.promote("p1");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("promote-gate-blocked");
  });

  test("Promote：过审查门禁 → 结案信落盘", async () => {
    const fx = await setupFixture();
    await fx.tower.spawn("p2");
    await fx.tower.review("p2", true, "验收通过");
    const result = await fx.tower.promote("p2");

    expect(result.ok).toBe(true);
    const letters = fx.tower.protocol.readFor("p2");
    expect(letters[letters.length - 1]?.body).toContain("promoted");
  });
});

describe("TowerService · 注入时钟", () => {
  test("信件 ts 随注入时钟单调递增，与操作顺序一致", async () => {
    let clock = 10_000;
    const fx = await setupFixture(() => (clock += 100));
    await fx.tower.spawn("clk");
    await fx.tower.finding("clk", "f");
    await fx.tower.review("clk", true, "ok");

    const letters = fx.tower.protocol.readFor("clk");
    expect(letters.map((letter) => letter.ts)).toEqual([10100, 10200, 10300]);
  });
});

// ---------- 小工具 ----------

function readText(file: string): string {
  return readFileSync(file, "utf8");
}
