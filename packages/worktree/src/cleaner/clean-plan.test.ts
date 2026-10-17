/**
 * @bi/worktree 测试 —— BI-12.1 清理计划与安全执行器（clean-plan）。
 *
 * 覆盖：7 天/1 天保留边界（now 注入）、orphan 无保留期、阈值可配、
 * 白名单安全阀（构建与执行双侧拒绝）、dryRun、原子删除失败回滚、
 * open-worktree / 根本体 / 已消失 三类 skipped 保护、trash 命名冲突回退。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync as fsRenameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CleanPlan, WorktreeError, isWorktreeError } from "../index";
import type { CatalogEntry, StorageCatalog } from "../index";

// ---------- 测试基建 ----------

let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "bi-cleanplan-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function entry(partial: Partial<CatalogEntry> & { path: string }): CatalogEntry {
  return { kind: "worktree", lastUsedAt: 0, merged: false, ...partial };
}

function catalogOf(...entries: CatalogEntry[]): StorageCatalog {
  const catalog: StorageCatalog = new Map();
  for (const item of entries) catalog.set(item.path, item);
  return catalog;
}

function expectCode(fn: () => unknown, code: "invalid-argument"): WorktreeError {
  try {
    fn();
    throw new Error(`期望抛出 WorktreeError(${code})，但调用成功了`);
  } catch (err) {
    if (!isWorktreeError(err)) throw err;
    expect(err.code).toBe(code);
    return err;
  }
}

const DAY = 24 * 60 * 60 * 1000;
const BASE_T = 1_700_000_000_000;

// ---------- buildPlan：保留策略与安全阀 ----------

describe("CleanPlan.buildPlan · 保留策略", () => {
  test("未合并 7 天边界：整点保留，+1ms 过期（expired-unmerged）", () => {
    const planner = new CleanPlan({ allowedRoots: ["/managed"] });
    const path = "/managed/t1";
    const catalog = catalogOf(entry({ path, kind: "worktree", merged: false, lastUsedAt: BASE_T }));

    expect(planner.buildPlan(catalog, BASE_T + 7 * DAY)).toEqual([]);
    expect(planner.buildPlan(catalog, BASE_T + 7 * DAY + 1)).toEqual([
      { path, reason: "expired-unmerged" },
    ]);
  });

  test("已合并 1 天边界：整点保留，+1ms 过期（expired-merged）", () => {
    const planner = new CleanPlan({ allowedRoots: ["/managed"] });
    const path = "/managed/t2";
    const catalog = catalogOf(entry({ path, kind: "worktree", merged: true, lastUsedAt: BASE_T }));

    expect(planner.buildPlan(catalog, BASE_T + 1 * DAY)).toEqual([]);
    expect(planner.buildPlan(catalog, BASE_T + 1 * DAY + 1)).toEqual([
      { path, reason: "expired-merged" },
    ]);
  });

  test("orphan 无保留期：刚出现即入计划，reason=orphan", () => {
    const planner = new CleanPlan({ allowedRoots: ["/managed"] });
    const path = "/managed/ghost";
    const catalog = catalogOf(entry({ path, kind: "orphan", lastUsedAt: BASE_T }));

    expect(planner.buildPlan(catalog, BASE_T)).toEqual([{ path, reason: "orphan" }]);
  });

  test("阈值可配：unmergedTtlMs/mergedTtlMs 覆盖默认值", () => {
    const planner = new CleanPlan({
      allowedRoots: ["/managed"],
      unmergedTtlMs: 100,
      mergedTtlMs: 50,
    });
    const catalog = catalogOf(
      entry({ path: "/managed/u", kind: "worktree", merged: false, lastUsedAt: BASE_T }),
      entry({ path: "/managed/m", kind: "worktree", merged: true, lastUsedAt: BASE_T }),
    );
    expect(planner.buildPlan(catalog, BASE_T + 49)).toEqual([]); // u:49<100 且 m:49<50，双双保留
    const halfway = planner.buildPlan(catalog, BASE_T + 51); // m 过期（51>50），u 未到（51<100）
    expect(halfway).toEqual([{ path: "/managed/m", reason: "expired-merged" }]);
    const plan = planner.buildPlan(catalog, BASE_T + 101);
    expect(plan).toContainEqual({ path: "/managed/u", reason: "expired-unmerged" });
    expect(plan).toContainEqual({ path: "/managed/m", reason: "expired-merged" });
  });

  test("log/cache 条目按未合并 TTL 处理；now 接受 Date 与 number 等价", () => {
    const planner = new CleanPlan({ allowedRoots: ["/managed"] });
    const catalog = catalogOf(entry({ path: "/managed/logs/a", kind: "log", lastUsedAt: BASE_T }));
    const asNumber = planner.buildPlan(catalog, BASE_T + 7 * DAY + 1);
    const asDate = planner.buildPlan(catalog, new Date(BASE_T + 7 * DAY + 1));
    expect(asNumber).toEqual(asDate);
    expect(asNumber).toEqual([{ path: "/managed/logs/a", reason: "expired-unmerged" }]);
  });

  test("混合目录字典：过期/保留/orphan 各归其位", () => {
    const planner = new CleanPlan({ allowedRoots: ["/managed"] });
    const catalog = catalogOf(
      entry({ path: "/managed/fresh", kind: "worktree", merged: false, lastUsedAt: BASE_T }),
      entry({ path: "/managed/old", kind: "worktree", merged: false, lastUsedAt: BASE_T - 8 * DAY }),
      entry({ path: "/managed/merged-old", kind: "worktree", merged: true, lastUsedAt: BASE_T - 2 * DAY }),
      entry({ path: "/managed/ghost", kind: "orphan", lastUsedAt: BASE_T }),
    );
    const plan = planner.buildPlan(catalog, BASE_T);
    expect(plan).toHaveLength(3);
    const byPath = new Map(plan.map((item) => [item.path, item.reason] as const));
    expect(byPath.get("/managed/fresh")).toBeUndefined();
    expect(byPath.get("/managed/old")).toBe("expired-unmerged");
    expect(byPath.get("/managed/merged-old")).toBe("expired-merged");
    expect(byPath.get("/managed/ghost")).toBe("orphan");
  });
});

describe("CleanPlan 安全阀", () => {
  test("白名单外路径一律拒绝（构建侧 throw invalid-argument）", () => {
    const planner = new CleanPlan({ allowedRoots: ["/managed"] });
    const catalog = catalogOf(
      entry({ path: "/managed/ok", kind: "orphan", lastUsedAt: BASE_T }),
      entry({ path: "/etc/evil", kind: "orphan", lastUsedAt: BASE_T }),
    );
    const err = expectCode(() => planner.buildPlan(catalog, BASE_T), "invalid-argument");
    expect(err.message).toContain("白名单");
  });

  test("allowedRoots 未配置 → 构造即拒绝（拒绝无界清理）", () => {
    expectCode(() => new CleanPlan({}), "invalid-argument");
    expectCode(() => new CleanPlan({ allowedRoots: [] }), "invalid-argument");
  });

  test(".. 穿越路径 resolve 后仍出白名单 → 拒绝", () => {
    const planner = new CleanPlan({ allowedRoots: ["/managed/wts"] });
    const catalog = catalogOf(entry({ path: "/managed/wts/../escape", kind: "orphan" }));
    expectCode(() => planner.buildPlan(catalog, BASE_T), "invalid-argument");
  });

  test("负数 TTL 阈值 → 构造即拒绝", () => {
    expectCode(() => new CleanPlan({ allowedRoots: ["/m"], unmergedTtlMs: -1 }), "invalid-argument");
  });
});

// ---------- execute：skipped 保护 / dryRun / 原子删除 ----------

describe("CleanPlan.execute · 跳过保护", () => {
  test("openWorktreePaths 命中 → skipped=open-worktree，目录原样保留", () => {
    const root = makeTmp();
    const target = join(root, "wts", "t1");
    mkdirSync(target, { recursive: true });
    const planner = new CleanPlan({ allowedRoots: [join(root, "wts")] });

    const result = planner.execute(
      [{ path: target, reason: "orphan" }],
      { openWorktreePaths: [target] },
    );

    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([{ path: target, reason: "orphan", why: "open-worktree" }]);
    expect(existsSync(target)).toBe(true);
  });

  test("白名单根目录本体 → root-protected，永不自删", () => {
    const root = makeTmp();
    const wts = join(root, "wts");
    mkdirSync(wts, { recursive: true });
    const planner = new CleanPlan({ allowedRoots: [wts] });

    const result = planner.execute([{ path: wts, reason: "orphan" }], {});
    expect(result.skipped).toEqual([{ path: wts, reason: "orphan", why: "root-protected" }]);
    expect(existsSync(wts)).toBe(true);
  });

  test("已消失路径 → skipped=missing（幂等，不报失败）", () => {
    const root = makeTmp();
    const absent = join(root, "wts", "gone");
    const planner = new CleanPlan({ allowedRoots: [join(root, "wts")] });

    const result = planner.execute([{ path: absent, reason: "expired-unmerged" }], {});
    expect(result.skipped).toEqual([{ path: absent, reason: "expired-unmerged", why: "missing" }]);
    expect(result.failed).toEqual([]);
  });

  test("白名单外条目整批拒绝：先于一切磁盘动作（坏条目在前，好条目不删）", () => {
    const root = makeTmp();
    const good = join(root, "wts", "good");
    mkdirSync(good, { recursive: true });
    const planner = new CleanPlan({ allowedRoots: [join(root, "wts")] });

    const err = expectCode(
      () => planner.execute([{ path: "/etc/evil", reason: "orphan" }, { path: good, reason: "orphan" }], {}),
      "invalid-argument",
    );
    expect(err.message).toContain("白名单");
    expect(existsSync(good)).toBe(true);
  });
});

describe("CleanPlan.execute · dryRun 与真删", () => {
  test("dryRun：零磁盘动作，removed=将被删除列表，原目录全部保留", () => {
    const root = makeTmp();
    const wts = join(root, "wts");
    const a = join(wts, "a");
    const b = join(wts, "b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, "keep.txt"), "data\n");
    const planner = new CleanPlan({ allowedRoots: [wts] });

    const result = planner.execute(
      [
        { path: a, reason: "orphan" },
        { path: b, reason: "expired-merged" },
      ],
      { dryRun: true },
    );

    expect(result.dryRun).toBe(true);
    expect(result.removed).toEqual([
      { path: a, reason: "orphan" },
      { path: b, reason: "expired-merged" },
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(existsSync(join(a, "keep.txt"))).toBe(true);
    expect(existsSync(b)).toBe(true);
  });

  test("真删：目标目录递归消失，removed 记录原因", () => {
    const root = makeTmp();
    const wts = join(root, "wts");
    const target = join(wts, "orphan-dir");
    mkdirSync(join(target, "nested"), { recursive: true });
    writeFileSync(join(target, "nested", "f.txt"), "x\n");
    const planner = new CleanPlan({ allowedRoots: [wts] });

    const result = planner.execute([{ path: target, reason: "orphan" }], {});

    expect(result.removed).toEqual([{ path: target, reason: "orphan" }]);
    expect(result.failed).toEqual([]);
    expect(existsSync(target)).toBe(false);
    // 同目录无 trash 残留
    expect(readdirSync(wts).filter((name) => name.includes(".trash-"))).toEqual([]);
  });

  test("trash 命名冲突：同名 trash 已存在 → 回退 -<n> 后缀", () => {
    const root = makeTmp();
    const wts = join(root, "wts");
    const target = join(wts, "t1");
    mkdirSync(target, { recursive: true });
    const now = () => 12345;
    mkdirSync(`${target}.trash-12345`, { recursive: true }); // 预占同名 trash
    const planner = new CleanPlan({ allowedRoots: [wts] });
    const noopRemove = (): void => {}; // remove 置空以观察 rename 目标

    const result = planner.execute([{ path: target, reason: "orphan" }], { now, ops: { remove: noopRemove } });

    expect(result.removed).toHaveLength(1);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(`${target}.trash-12345-1`)).toBe(true); // 回退后缀落位
  });
});

describe("CleanPlan.execute · 原子删除失败恢复", () => {
  test("rm 失败 → rename 回滚恢复原路径，failed 记录，无 trash 残留", () => {
    const root = makeTmp();
    const wts = join(root, "wts");
    const target = join(wts, "t1");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "data.txt"), "precious\n");
    const planner = new CleanPlan({ allowedRoots: [wts] });

    const result = planner.execute([{ path: target, reason: "orphan" }], {
      ops: { remove: () => { throw new Error("EACCES: mock rm failure"); } },
    });

    expect(result.removed).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.path).toBe(target);
    expect(result.failed[0]?.error).toContain("回滚");
    // 原路径与内容完整恢复
    expect(existsSync(join(target, "data.txt"))).toBe(true);
    expect(readdirSync(wts).filter((name) => name.includes(".trash-"))).toEqual([]);
  });

  test("rename 失败 → failed 记录，原路径未动（零副作用）", () => {
    const root = makeTmp();
    const wts = join(root, "wts");
    const target = join(wts, "t1");
    mkdirSync(target, { recursive: true });
    const planner = new CleanPlan({ allowedRoots: [wts] });

    const result = planner.execute([{ path: target, reason: "expired-merged" }], {
      ops: { rename: () => { throw new Error("EXDEV: mock rename failure"); } },
    });

    expect(result.removed).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.error).toContain("rename 失败");
    expect(existsSync(target)).toBe(true);
  });

  test("混批执行：可删的正常删，失败的原样保留，互不阻断", () => {
    const root = makeTmp();
    const wts = join(root, "wts");
    const good = join(wts, "good");
    const bad = join(wts, "bad");
    mkdirSync(good, { recursive: true });
    mkdirSync(bad, { recursive: true });
    const planner = new CleanPlan({ allowedRoots: [wts] });

    const result = planner.execute(
      [
        { path: bad, reason: "orphan" },
        { path: good, reason: "orphan" },
      ],
      {
        ops: {
          rename: (from, to) => {
            if (from === bad) throw new Error("mock: locked");
            fsRenameSync(from, to);
          },
        },
      },
    );

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.path).toBe(bad);
    expect(result.removed).toEqual([{ path: good, reason: "orphan" }]);
    expect(existsSync(bad)).toBe(true);
    expect(existsSync(good)).toBe(false);
  });
});
