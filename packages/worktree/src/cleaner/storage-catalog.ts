/**
 * @bi/worktree —— 工作区临时存储目录字典扫描器（BI-12.1）。
 *
 * 物理真相扫描：`git worktree list --porcelain`（git 元数据命令，只读允许）+
 * fs 目录枚举，产出受管目录字典 `StorageCatalog`。条目形态：
 *   { path, kind: 'worktree'|'log'|'cache'|'orphan', lastUsedAt, merged, branch? }
 *
 * 目录来源：worktreesRoot（与 BI-12 引擎路径约定一致，注入）+ 显式注册的
 * 附属目录（extraRoots，kind 限定 'log'|'cache'）。
 *
 * 孤儿判定（kind='orphan'：目录存在但已失去工作树身份）：
 * - 目录存在但 `worktree list` 不含之；或
 * - 列表含之但分支引用已删（rev-parse 失败）/ 游离态（无可用分支身份）。
 *
 * merged 判定：`git merge-base --is-ancestor <branch> HEAD`（相对主仓库当前
 * HEAD）；判定非 0 一律按未合并处理（保守侧 → 更长保留期）。
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { WorktreeError } from "../branch";
import { defaultGitRunner, sanitizeGitStderr } from "../engine";
import type { GitRunner } from "../engine";

/** 目录条目类别。 */
export type CatalogKind = "worktree" | "log" | "cache" | "orphan";

/** 单个被扫到的物理目录条目。 */
export interface CatalogEntry {
  /** 绝对路径（resolve 规范化） */
  path: string;
  kind: CatalogKind;
  /** 最近使用时间（fs mtime，epoch ms；stat 失败回退扫描时刻，偏保守） */
  lastUsedAt: number;
  /** 分支是否已合入主仓库 HEAD（仅 kind='worktree' 有意义） */
  merged: boolean;
  /** 关联分支短名（worktree / 遗留分支已删的 orphan 才有） */
  branch?: string;
}

/** 存储目录字典：规范路径 -> 条目。 */
export type StorageCatalog = Map<string, CatalogEntry>;

/** `git worktree list --porcelain` 单条解析结果。 */
export interface ParsedWorktree {
  path: string;
  head?: string;
  /** 短分支名（剥离 refs/heads/ 前缀）；裸/游离态为 undefined */
  branch?: string;
  bare: boolean;
  detached: boolean;
}

/** 附属注册目录（显式登记进白名单的 log/cache 目录）。 */
export interface RegisteredRoot {
  path: string;
  kind: "log" | "cache";
}

/** 扫描选项。 */
export interface ScanStorageOptions {
  /** worktree 池根目录（与 WorktreeEngine.worktreesRoot 同一约定） */
  worktreesRoot: string;
  /** 附属受管目录（log/cache），显式注册 */
  extraRoots?: readonly RegisteredRoot[];
  /** git 命令执行目录（主仓库根）；缺省为 worktreesRoot 本身 */
  cwd?: string;
  /** 注入时钟（仅作 stat 失败时的 lastUsedAt 回退值） */
  now?: () => number;
  /** git 执行器；默认复用引擎 defaultGitRunner */
  gitRunner?: GitRunner;
}

/**
 * 解析 `git worktree list --porcelain` 输出（与引擎内解析约定一致：
 * branch 剥离 refs/heads/ 前缀，空行分条，bare/detached 为标记行）。
 */
export function parseWorktreePorcelain(text: string): ParsedWorktree[] {
  const entries: ParsedWorktree[] = [];
  let current: ParsedWorktree | null = null;
  const flush = (): void => {
    if (current !== null) {
      entries.push(current);
      current = null;
    }
  };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    if (line === "") {
      flush();
      continue;
    }
    const sep = line.indexOf(" ");
    if (sep < 0) {
      // 无值标记行：bare / detached
      if (current !== null && line === "bare") current.bare = true;
      else if (current !== null && line === "detached") current.detached = true;
      continue;
    }
    const key = line.slice(0, sep);
    const value = line.slice(sep + 1);
    if (key === "worktree") {
      flush();
      current = { path: value, bare: false, detached: false };
      continue;
    }
    if (current === null) continue;
    if (key === "HEAD") {
      current.head = value;
    } else if (key === "branch") {
      current.branch = value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
    } else if (key === "bare") {
      current.bare = true;
    } else if (key === "detached") {
      current.detached = true;
    }
  }
  flush();
  return entries;
}

/**
 * 扫描物理目录，产出存储字典。规则：
 * - worktreesRoot 的每个子目录：在册且分支存活 → 'worktree'；否则 → 'orphan'；
 * - extraRoots 的每个子目录：登记为注册 kind（'log'|'cache'）；
 * - 仅收录目录（普通文件与符号链接一律不收录，防路径逃逸）；
 * - 根目录不存在 → 空结果（不视为错误）；porcelain 失败 → 结构化 git-error。
 */
export async function scanStorage(opts: ScanStorageOptions): Promise<StorageCatalog> {
  const worktreesRoot = resolve(opts.worktreesRoot);
  const cwd = opts.cwd === undefined ? worktreesRoot : resolve(opts.cwd);
  const gitRunner = opts.gitRunner ?? defaultGitRunner;

  const porcelain = await gitRunner(["worktree", "list", "--porcelain"], { cwd });
  if (porcelain.code !== 0) {
    throw new WorktreeError("git-error", "git worktree list --porcelain 失败（存储扫描中止）", {
      stderr: sanitizeGitStderr(`${porcelain.stdout}\n${porcelain.stderr}`, {
        repoRoot: cwd,
        worktreesRoot,
      }),
    });
  }
  const listed = parseWorktreePorcelain(porcelain.stdout);
  const liveByPath = new Map<string, ParsedWorktree>();
  for (const wt of listed) {
    liveByPath.set(resolve(wt.path), wt);
  }

  // 分支存活核查与 merged 判定（对在册 worktree 逐条执行，只读元数据命令）
  const branchAlive = new Map<string, boolean>();
  const mergedIntoHead = new Map<string, boolean>();
  for (const wt of listed) {
    if (wt.branch === undefined) continue;
    if (branchAlive.has(wt.branch)) continue;
    const verify = await gitRunner(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${wt.branch}`],
      { cwd },
    );
    const alive = verify.code === 0;
    branchAlive.set(wt.branch, alive);
    if (alive) {
      const ancestor = await gitRunner(
        ["merge-base", "--is-ancestor", wt.branch, "HEAD"],
        { cwd },
      );
      mergedIntoHead.set(wt.branch, ancestor.code === 0);
    }
  }

  const fallbackNow = (opts.now ?? Date.now)();
  const catalog: StorageCatalog = new Map();
  const roots: Array<{ path: string; kind: "worktrees" | "log" | "cache" }> = [
    { path: worktreesRoot, kind: "worktrees" },
    ...(opts.extraRoots ?? []).map((root) => ({ path: resolve(root.path), kind: root.kind })),
  ];

  for (const root of roots) {
    if (!existsSync(root.path)) continue;
    const children = readdirSync(root.path, { withFileTypes: true });
    for (const child of children) {
      if (!child.isDirectory()) continue; // 普通文件与符号链接不收录
      const path = resolve(join(root.path, child.name));
      if (catalog.has(path)) continue; // 根重叠时先到先得
      let lastUsedAt = fallbackNow;
      try {
        lastUsedAt = statSync(path).mtimeMs;
      } catch {
        // stat 失败保持回退值（偏新 → 偏保守，少删不误删）
      }
      if (root.kind === "worktrees") {
        const live = liveByPath.get(path);
        const branch = live?.branch;
        if (live === undefined || branch === undefined || branchAlive.get(branch) !== true) {
          const orphan: CatalogEntry = { path, kind: "orphan", lastUsedAt, merged: false };
          if (branch !== undefined) orphan.branch = branch; // 遗留分支名留档
          catalog.set(path, orphan);
          continue;
        }
        catalog.set(path, {
          path,
          kind: "worktree",
          lastUsedAt,
          merged: mergedIntoHead.get(branch) === true,
          branch,
        });
        continue;
      }
      catalog.set(path, { path, kind: root.kind, lastUsedAt, merged: false });
    }
  }
  return catalog;
}
