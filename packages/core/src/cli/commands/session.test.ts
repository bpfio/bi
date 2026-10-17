/**
 * BI-20.2 · `session` 子命令群（list + pruneOrphans）测试。
 *
 * 覆盖：listSessions 复用（排序/limit/坏文件跳过）；pruneOrphans 安全阀
 * （缺省 dry-run 只列、force 才删、dryRun:true 否决 force、dryRun:false 无
 * force 不删、路径白名单外拒绝、非 .jsonl 与符号链接不碰、目录不存在）。
 * 全部用例注入临时会话目录，绝不触碰 ~/.bi。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../session/manager";
import { PruneError, listSessions, pruneOrphans } from "./session";

let dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

function makeIdGen(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `n${n}`;
  };
}

/** 临时会话目录 + 递增时钟（每次调用 +1000ms，保证 createdAt 可排序）。 */
async function tmpManager(): Promise<SessionManager> {
  const root = await mkdtemp(join(tmpdir(), "bi-sessioncmd-"));
  dirs.push(root);
  let t = 1700000000000;
  return new SessionManager({
    rootDir: join(root, "sessions"),
    now: () => (t += 1000),
    generateId: makeIdGen(),
  });
}

/** 建一个健康会话（显式 id 便于断言）。 */
async function seedHealthy(mgr: SessionManager, id: string, title: string): Promise<void> {
  await mgr.createSession({ sessionId: id, title });
  await mgr.append(id, null, { type: "user", payload: { text: "问1" } });
}

/** 在会话目录写一个裸文件（绕过 manager，模拟损坏/孤儿）。 */
async function seedRawFile(mgr: SessionManager, fileName: string, content: string): Promise<string> {
  await mkdir(mgr.rootDir, { recursive: true });
  const file = join(mgr.rootDir, fileName);
  await writeFile(file, content, "utf8");
  return file;
}

async function errorCode(promise: Promise<unknown>): Promise<PruneError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PruneError) return error;
    throw error;
  }
  throw new Error("预期清理失败，但成功了");
}

describe("BI-20.2 session：listSessions", () => {
  test("复用 manager.listSessions：createdAt 最新在前", async () => {
    const mgr = await tmpManager();
    await seedHealthy(mgr, "s-old", "早");
    await seedHealthy(mgr, "s-new", "晚");
    const metas = await listSessions(mgr);
    expect(metas.map((m) => m.sessionId)).toEqual(["s-new", "s-old"]);
  });

  test("limit 截断返回条数", async () => {
    const mgr = await tmpManager();
    await seedHealthy(mgr, "s-1", "一");
    await seedHealthy(mgr, "s-2", "二");
    await seedHealthy(mgr, "s-3", "三");
    const metas = await listSessions(mgr, { limit: 2 });
    expect(metas).toHaveLength(2);
    expect(metas[0]!.sessionId).toBe("s-3");
  });

  test("limit 为 0 / 负数 / 非整数 → 空数组", async () => {
    const mgr = await tmpManager();
    await seedHealthy(mgr, "s-1", "一");
    expect(await listSessions(mgr, { limit: 0 })).toEqual([]);
    expect(await listSessions(mgr, { limit: -1 })).toEqual([]);
    expect(await listSessions(mgr, { limit: 1.5 })).toEqual([]);
  });

  test("坏文件跳过语义继承：损坏文件不出现在列表", async () => {
    const mgr = await tmpManager();
    await seedHealthy(mgr, "s-good", "好");
    await seedRawFile(mgr, "s-bad.jsonl", "垃圾内容\n");
    const metas = await listSessions(mgr);
    expect(metas.map((m) => m.sessionId)).toEqual(["s-good"]);
  });
});

describe("BI-20.2 session：pruneOrphans 安全阀", () => {
  test("缺省 dry-run：列出孤儿清单但不删除，dryRun=true", async () => {
    const mgr = await tmpManager();
    await seedHealthy(mgr, "s-good", "好");
    const emptyFile = await seedRawFile(mgr, "s-empty.jsonl", "");
    const garbageFile = await seedRawFile(mgr, "s-garbage.jsonl", "不是 meta 行\n");
    const result = await pruneOrphans(mgr.rootDir, mgr);
    expect(result.dryRun).toBe(true);
    expect(result.deleted).toEqual([]);
    expect(result.orphans.map((o) => o.file).sort()).toEqual([emptyFile, garbageFile].sort());
    // dry-run 后文件仍在
    expect(await Bun.file(emptyFile).exists()).toBe(true);
    expect(await Bun.file(garbageFile).exists()).toBe(true);
  });

  test("reason 分类：空文件/meta 残缺 → no-meta；非法会话 id 文件名 → unreadable", async () => {
    const mgr = await tmpManager();
    await seedRawFile(mgr, "s-empty.jsonl", "");
    await seedRawFile(mgr, "s-garbage.jsonl", "不是 meta 行\n");
    await seedRawFile(mgr, "bad id.jsonl", ""); // 空格 → 非法会话 id
    const result = await pruneOrphans(mgr.rootDir, mgr);
    const byFile = new Map(result.orphans.map((o) => [o.file.split("/").pop(), o.reason]));
    expect(byFile.get("s-empty.jsonl")).toBe("no-meta");
    expect(byFile.get("s-garbage.jsonl")).toBe("no-meta");
    expect(byFile.get("bad id.jsonl")).toBe("unreadable");
  });

  test("force 删除：孤儿消失，健康会话保留，dryRun=false", async () => {
    const mgr = await tmpManager();
    await seedHealthy(mgr, "s-good", "好");
    const emptyFile = await seedRawFile(mgr, "s-empty.jsonl", "");
    const garbageFile = await seedRawFile(mgr, "s-garbage.jsonl", "垃圾\n");
    const result = await pruneOrphans(mgr.rootDir, mgr, { force: true });
    expect(result.dryRun).toBe(false);
    expect(result.deleted.sort()).toEqual([emptyFile, garbageFile].sort());
    expect(await Bun.file(emptyFile).exists()).toBe(false);
    expect(await Bun.file(garbageFile).exists()).toBe(false);
    expect(await Bun.file(join(mgr.rootDir, "s-good.jsonl")).exists()).toBe(true);
    // 删除后复跑：无孤儿
    const again = await pruneOrphans(mgr.rootDir, mgr, { force: true });
    expect(again.orphans).toEqual([]);
    expect(again.deleted).toEqual([]);
  });

  test("dryRun:true 可否决 force（dry-run 优先）", async () => {
    const mgr = await tmpManager();
    const orphan = await seedRawFile(mgr, "s-empty.jsonl", "");
    const result = await pruneOrphans(mgr.rootDir, mgr, { dryRun: true, force: true });
    expect(result.dryRun).toBe(true);
    expect(result.deleted).toEqual([]);
    expect(result.orphans.map((o) => o.file)).toEqual([orphan]);
    expect(await Bun.file(orphan).exists()).toBe(true);
  });

  test("dryRun:false 但缺 force → 仍不删（force 是删除的必要条件）", async () => {
    const mgr = await tmpManager();
    const orphan = await seedRawFile(mgr, "s-empty.jsonl", "");
    const result = await pruneOrphans(mgr.rootDir, mgr, { dryRun: false });
    expect(result.deleted).toEqual([]);
    expect(result.dryRun).toBe(true);
    expect(await Bun.file(orphan).exists()).toBe(true);
  });

  test("路径白名单外拒绝：传入其他真实目录 → path-not-allowed", async () => {
    const mgr = await tmpManager();
    const elsewhere = join(mgr.rootDir, "..", "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(elsewhere, "x.jsonl"), "", "utf8");
    const error = await errorCode(pruneOrphans(elsewhere, mgr, { force: true }));
    expect(error.code).toBe("path-not-allowed");
    expect(await Bun.file(join(elsewhere, "x.jsonl")).exists()).toBe(true);
  });

  test("路径白名单外拒绝：目录不存在也先拒绝（不做任何读操作）", async () => {
    const mgr = await tmpManager();
    const error = await errorCode(pruneOrphans(join(mgr.rootDir, "..", "no-such-dir"), mgr));
    expect(error.code).toBe("path-not-allowed");
  });

  test("非 .jsonl 文件不列出也不删除", async () => {
    const mgr = await tmpManager();
    const notes = await seedRawFile(mgr, "notes.txt", "普通文件");
    const result = await pruneOrphans(mgr.rootDir, mgr, { force: true });
    expect(result.orphans).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(await Bun.file(notes).exists()).toBe(true);
  });

  test("符号链接不碰（lstat 非常规文件保守跳过）", async () => {
    const mgr = await tmpManager();
    await seedHealthy(mgr, "s-good", "好");
    const link = join(mgr.rootDir, "s-link.jsonl");
    await symlink(join(mgr.rootDir, "s-good.jsonl"), link);
    const result = await pruneOrphans(mgr.rootDir, mgr, { force: true });
    expect(result.orphans).toEqual([]);
    expect(await Bun.file(link).exists()).toBe(true); // lstat 视角存在
    expect(await Bun.file(join(mgr.rootDir, "s-good.jsonl")).exists()).toBe(true);
  });

  test("健康会话文件全部在列 → 无孤儿，不误删", async () => {
    const mgr = await tmpManager();
    await seedHealthy(mgr, "s-a", "甲");
    await seedHealthy(mgr, "s-b", "乙");
    const result = await pruneOrphans(mgr.rootDir, mgr, { force: true });
    expect(result.orphans).toEqual([]);
    expect(result.deleted).toEqual([]);
  });

  test("会话目录不存在（未创建）→ 空 orphans，不报错", async () => {
    const mgr = await tmpManager(); // 未做任何 createSession，rootDir 未 mkdir
    const result = await pruneOrphans(mgr.rootDir, mgr);
    expect(result).toEqual({ orphans: [], deleted: [], dryRun: true });
  });
});
