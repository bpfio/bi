/**
 * @bi/worktree —— Git Worktree 物理并发沙箱引擎（BI-12）。
 *
 * 每个任务在独立物理工作树（`<worktreesRoot>/<taskId>`）+ 独立分支（`bi-task-<taskId>`）上施工，
 * 多任务并行物理隔离，主仓库零污染。生命周期：
 * - `create`    ：`git worktree add <worktreesRoot>/<taskId> -b bi-task-<taskId> [baseRef]`；
 * - `mergeBack` ：审查通过后的原子合回（主仓库 `merge --no-ff`）；冲突返回 `conflict:true`
 *               并 `merge --abort` 回滚现场，引擎绝不自动解决冲突（人类审查门语义，RULE-BI-05）；
 * - `discard`   ：撤销语义，静默清空（force 移除 + 分支删除，丢弃全部改动）；
 * - `remove`    ：`git worktree remove [--force]` + `git branch -D`，幂等。
 *
 * 所有 git 失败均以结构化 `WorktreeError` 呈现（`code` + 脱敏后的 `stderr`）。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  WorktreeError,
  assertValidTaskId,
  branchName,
  isValidTaskId,
  parseBranchName,
} from "./branch";

/** 单次 git 命令执行结果。runner 契约：永不抛出，失败也以非零 code 返回。 */
export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** git 执行器：测试可注入 stub；默认实现为真实 execFile git。 */
export type GitRunner = (args: readonly string[], opts: { cwd: string }) => Promise<GitRunResult>;

/** 默认 git 执行器：execFile("git", args)，无 shell 参与、无网络。 */
export const defaultGitRunner: GitRunner = (args, opts) =>
  new Promise((resolve) => {
    execFile(
      "git",
      [...args],
      { cwd: opts.cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const out = typeof stdout === "string" ? stdout : "";
        const err = typeof stderr === "string" ? stderr : "";
        if (error === null) {
          resolve({ code: 0, stdout: out, stderr: err });
          return;
        }
        const rawCode: unknown = (error as { code?: unknown }).code;
        resolve({
          code: typeof rawCode === "number" ? rawCode : 1,
          stdout: out,
          stderr: err !== "" ? err : error.message,
        });
      },
    );
  });

const MAX_STDERR_LENGTH = 2000;
const ANSI_PATTERN = /\x1B\[[0-9;]*[A-Za-z]/g;
const URL_CREDENTIALS_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+):[^@\s]+@/g;

/**
 * stderr 脱敏：剥离 ANSI 色码；URL 内嵌凭据打码为 `***`；本机敏感路径
 * （仓库根 / worktreesRoot / 用户主目录）替换为占位符；超长截断。
 */
export function sanitizeGitStderr(
  raw: string,
  opts: { repoRoot?: string; worktreesRoot?: string } = {},
): string {
  const candidates: Array<[string | undefined, string]> = [
    [opts.repoRoot, "<repo>"],
    [opts.worktreesRoot, "<worktrees>"],
    [homedir(), "~"],
  ];
  const replacements = candidates
    .filter((pair): pair is [string, string] => typeof pair[0] === "string" && pair[0] !== "")
    .map(([from, to]) => ({ from, to }))
    .sort((a, b) => b.from.length - a.from.length);
  let text = raw.replace(ANSI_PATTERN, "").trim();
  for (const { from, to } of replacements) {
    text = text.split(from).join(to);
  }
  text = text.replace(URL_CREDENTIALS_PATTERN, "$1:***@");
  if (text.length > MAX_STDERR_LENGTH) {
    text = `${text.slice(0, MAX_STDERR_LENGTH)}…(truncated)`;
  }
  return text;
}

/** 引擎构造项。 */
export interface WorktreeEngineOptions {
  /** 主仓库根目录（缺省时每次调用必须显式传入 repo）。 */
  reposRoot?: string;
  /** 物理工作树池根目录；默认 `~/.bi/worktrees`。测试必须注入 tmp 目录。 */
  worktreesRoot?: string;
  /** git 执行器；默认真实 execFile git。 */
  gitRunner?: GitRunner;
  /** 时钟；默认系统时间（用于 createdAt）。 */
  now?: () => Date;
}

/** 工作树快照。list/get 视角的 baseCommit 优先取 create 时的基线记录，否则回退当前 HEAD。 */
export interface WorktreeInfo {
  taskId: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
  createdAt?: string;
}

/** remove/discard 结果。幂等：目标已不存在时 removed/branchDeleted 均为 false。 */
export interface RemoveWorktreeResult {
  taskId: string;
  removed: boolean;
  branchDeleted: boolean;
}

/** mergeBack 结果：成功合回（含自动清理标记）或冲突（现场已回滚，交人类审查门）。 */
export type MergeBackResult =
  | {
      taskId: string;
      merged: true;
      /** --no-ff 合并提交；分支内容已合入时为当前 HEAD。 */
      commit: string;
      /** 自动清理是否成功；false 表示工作树存在未提交遗留，保留现场交人工复查。 */
      removed: boolean;
    }
  | {
      taskId: string;
      merged: false;
      conflict: true;
      /** 脱敏后的 git 冲突输出（现场已 merge --abort 回滚，主仓库零污染）。 */
      stderr: string;
    };

interface GitWorktreeEntry {
  path: string;
  head: string | null;
  /** 短分支名（已剥离 refs/heads/ 前缀）；裸/游离态为 null。 */
  branch: string | null;
}

interface WorktreeRecord {
  createdAt: string;
  baseCommit: string;
}

interface TaskCtx {
  taskId?: string;
}

/** Git Worktree 物理并发沙箱引擎。 */
export class WorktreeEngine {
  readonly #reposRoot?: string;
  readonly #worktreesRoot: string;
  readonly #gitRunner: GitRunner;
  readonly #now: () => Date;
  /** 本实例 create 过的工作树元数据（基线提交与创建时刻；磁盘真相以 git 为准）。 */
  readonly #records = new Map<string, WorktreeRecord>();

  constructor(opts: WorktreeEngineOptions = {}) {
    this.#reposRoot = opts.reposRoot === undefined ? undefined : resolve(opts.reposRoot);
    this.#worktreesRoot = resolve(opts.worktreesRoot ?? join(homedir(), ".bi", "worktrees"));
    this.#gitRunner = opts.gitRunner ?? defaultGitRunner;
    this.#now = opts.now ?? (() => new Date());
  }

  /** 工作树池根目录。 */
  get worktreesRoot(): string {
    return this.#worktreesRoot;
  }

  /** 构造时注入的默认主仓库根目录（可能为 undefined）。 */
  get reposRoot(): string | undefined {
    return this.#reposRoot;
  }

  /** taskId 对应的物理工作树路径（非法 taskId 抛 invalid-task-id）。 */
  worktreePathFor(taskId: string): string {
    assertValidTaskId(taskId);
    return join(this.#worktreesRoot, taskId);
  }

  /**
   * 创建任务工作树：`git worktree add <worktreesRoot>/<taskId> -b bi-task-<taskId> [baseRef]`。
   * taskId 已存在（工作树或遗留分支）或路径被占用 → 结构化错误 worktree-exists。
   */
  async create(taskId: string, opts: { baseRef?: string; repo?: string } = {}): Promise<WorktreeInfo> {
    assertValidTaskId(taskId);
    const ctx: TaskCtx = { taskId };
    const branch = branchName(taskId);
    const worktreePath = join(this.#worktreesRoot, taskId);
    const repo = await this.#repoDir(opts.repo, ctx);

    const entries = await this.#listEntries(repo, ctx);
    for (const entry of entries) {
      if (this.#taskIdOfEntry(entry) === taskId) {
        throw new WorktreeError("worktree-exists", `taskId 已存在工作树：${entry.path}`, ctx);
      }
    }
    const branchTaken = await this.#run(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      repo,
      ctx,
    );
    if (branchTaken.code === 0) {
      throw new WorktreeError("worktree-exists", `分支已存在（历史遗留）：${branch}`, ctx);
    }
    if (existsSync(worktreePath)) {
      throw new WorktreeError("worktree-exists", `工作树路径已被占用：${worktreePath}`, ctx);
    }

    mkdirSync(this.#worktreesRoot, { recursive: true });
    // 工单规定顺序：worktree add <path> -b <branch> [baseRef]
    const args = ["worktree", "add", worktreePath, "-b", branch];
    if (opts.baseRef !== undefined) {
      if (opts.baseRef.trim() === "") {
        throw new WorktreeError("invalid-argument", "baseRef 不能为空字符串", ctx);
      }
      args.push(opts.baseRef);
    }
    await this.#runOk(args, repo, ctx);

    const baseCommit = (await this.#runOk(["rev-parse", branch], repo, ctx)).stdout.trim();
    const createdAt = this.#now().toISOString();
    this.#records.set(taskId, { createdAt, baseCommit });
    return { taskId, worktreePath, branch, baseCommit, createdAt };
  }

  /** 列出本引擎管辖的工作树（分支名可解析为合法 taskId 的条目），按 taskId 排序。 */
  async list(opts: { repo?: string } = {}): Promise<WorktreeInfo[]> {
    const repo = await this.#repoDir(opts.repo);
    const entries = await this.#listEntries(repo);
    const infos: WorktreeInfo[] = [];
    for (const entry of entries) {
      const taskId = this.#taskIdOfEntry(entry);
      if (taskId !== null) infos.push(this.#toInfo(entry, taskId));
    }
    infos.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
    return infos;
  }

  /** 查询单个工作树快照；不存在（含非法 taskId）返回 null。 */
  async get(taskId: string, opts: { repo?: string } = {}): Promise<WorktreeInfo | null> {
    if (!isValidTaskId(taskId)) return null;
    const ctx: TaskCtx = { taskId };
    const repo = await this.#repoDir(opts.repo, ctx);
    const entries = await this.#listEntries(repo, ctx);
    for (const entry of entries) {
      if (this.#taskIdOfEntry(entry) === taskId) return this.#toInfo(entry, taskId);
    }
    return null;
  }

  /**
   * 移除工作树并清理分支：`git worktree remove [--force]` + `git branch -D`。
   * 幂等：目标不存在时返回 removed:false 且不抛错。
   */
  async remove(taskId: string, opts: { force?: boolean; repo?: string } = {}): Promise<RemoveWorktreeResult> {
    assertValidTaskId(taskId);
    const ctx: TaskCtx = { taskId };
    const branch = branchName(taskId);
    const repo = await this.#repoDir(opts.repo, ctx);

    let removed = false;
    const entries = await this.#listEntries(repo, ctx);
    for (const entry of entries) {
      if (this.#taskIdOfEntry(entry) !== taskId) continue;
      const args = ["worktree", "remove", entry.path];
      if (opts.force === true) args.push("--force");
      await this.#runOk(args, repo, ctx);
      removed = true;
      break;
    }

    // 分支清理：仅当分支真实存在时执行 -D，天然幂等（不存在即静默跳过）
    let branchDeleted = false;
    const exists = await this.#run(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      repo,
      ctx,
    );
    if (exists.code === 0) {
      await this.#runOk(["branch", "-D", branch], repo, ctx);
      branchDeleted = true;
    }

    this.#records.delete(taskId);
    return { taskId, removed, branchDeleted };
  }

  /** 撤销语义：静默清空该任务的全部改动（force 移除工作树 + 分支删除）。 */
  async discard(taskId: string, opts: { repo?: string } = {}): Promise<RemoveWorktreeResult> {
    return this.remove(taskId, { force: true, repo: opts.repo });
  }

  /**
   * 审查通过后的原子合回：主仓库执行 `merge --no-ff bi-task-<taskId> -m <message>`。
   * - 冲突：`merge --abort` 回滚现场，返回 `{ merged:false, conflict:true }`，绝不自动解决
   *   （人类审查门语义，RULE-BI-05）；工作树与分支原样保留。
   * - 成功：返回 `{ merged:true, commit }`（--no-ff 合并提交），随后自动 remove(taskId)
   *   （非 force：工作树若有未提交遗留则保留现场，removed:false 交人工复查）。
   */
  async mergeBack(taskId: string, opts: { message: string; repo?: string }): Promise<MergeBackResult> {
    assertValidTaskId(taskId);
    if (typeof opts.message !== "string" || opts.message.trim() === "") {
      throw new WorktreeError("invalid-argument", "mergeBack 需要 merge message（审查通过凭证）", { taskId });
    }
    const ctx: TaskCtx = { taskId };
    const branch = branchName(taskId);
    const repo = await this.#repoDir(opts.repo, ctx);

    const branchExists = await this.#run(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      repo,
      ctx,
    );
    if (branchExists.code !== 0) {
      throw new WorktreeError("worktree-missing", `分支不存在，无可合回内容：${branch}`, ctx);
    }

    const merge = await this.#run(["merge", "--no-ff", branch, "-m", opts.message], repo, ctx);
    if (merge.code !== 0) {
      const combined = `${merge.stdout}\n${merge.stderr}`;
      if (/CONFLICT|Automatic merge failed/.test(combined)) {
        // 人类审查门：不自动解决冲突，回滚合并现场保持主仓库零污染
        let stderr = combined;
        try {
          await this.#runOk(["merge", "--abort"], repo, ctx);
        } catch (err) {
          const detail = err instanceof WorktreeError ? (err.stderr ?? err.message) : String(err);
          stderr = `${combined}\n[merge --abort 失败] ${detail}`;
        }
        return { taskId, merged: false, conflict: true, stderr: this.#sanitize(stderr, repo) };
      }
      throw new WorktreeError("git-error", `git merge --no-ff 失败（退出码 ${merge.code}）`, {
        ...ctx,
        stderr: this.#sanitize(combined, repo),
      });
    }

    const commit = (await this.#runOk(["rev-parse", "HEAD"], repo, ctx)).stdout.trim();

    let removed = false;
    try {
      removed = (await this.remove(taskId, { repo })).removed;
    } catch {
      // merge 已成功，清理失败不推翻事实；removed=false 由调用方经 list() 复查现场
      removed = false;
    }
    return { taskId, merged: true, commit, removed };
  }

  async #repoDir(repo?: string, ctx: TaskCtx = {}): Promise<string> {
    const dir = repo ?? this.#reposRoot;
    if (dir === undefined || dir === "") {
      throw new WorktreeError("repo-missing", "未指定主仓库：需构造时注入 reposRoot 或调用时传入 repo", ctx);
    }
    const check = await this.#run(["rev-parse", "--show-toplevel"], dir, ctx);
    if (check.code !== 0) {
      throw new WorktreeError("repo-missing", `目录不是 git 仓库：${dir}`, {
        ...ctx,
        stderr: this.#sanitize(check.stderr, dir),
      });
    }
    return resolve(dir);
  }

  async #listEntries(repo: string, ctx: TaskCtx = {}): Promise<GitWorktreeEntry[]> {
    const res = await this.#runOk(["worktree", "list", "--porcelain"], repo, ctx);
    const entries: GitWorktreeEntry[] = [];
    let current: GitWorktreeEntry | null = null;
    for (const line of res.stdout.split("\n")) {
      if (line === "") {
        current = null;
        continue;
      }
      const sep = line.indexOf(" ");
      if (sep < 0) continue;
      const key = line.slice(0, sep);
      const value = line.slice(sep + 1);
      if (key === "worktree") {
        current = { path: value, head: null, branch: null };
        entries.push(current);
      } else if (current !== null && key === "HEAD") {
        current.head = value;
      } else if (current !== null && key === "branch") {
        current.branch = value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
      }
    }
    return entries;
  }

  #taskIdOfEntry(entry: GitWorktreeEntry): string | null {
    return entry.branch === null ? null : parseBranchName(entry.branch);
  }

  #toInfo(entry: GitWorktreeEntry, taskId: string): WorktreeInfo {
    const record = this.#records.get(taskId);
    return {
      taskId,
      worktreePath: entry.path,
      branch: entry.branch ?? branchName(taskId),
      baseCommit: record?.baseCommit ?? entry.head ?? "",
      createdAt: record?.createdAt,
    };
  }

  async #run(args: readonly string[], cwd: string, ctx: TaskCtx = {}): Promise<GitRunResult> {
    let res: GitRunResult;
    try {
      res = await this.#gitRunner(args, { cwd });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new WorktreeError("git-error", `git 执行器异常（git ${args[0] ?? ""}）`, {
        ...ctx,
        stderr: this.#sanitize(detail, cwd),
        cause: err,
      });
    }
    if (!Number.isInteger(Number(res?.code))) {
      throw new WorktreeError("git-error", "gitRunner 返回结果缺少合法的数值 code 字段", ctx);
    }
    return res;
  }

  async #runOk(args: readonly string[], cwd: string, ctx: TaskCtx = {}): Promise<GitRunResult> {
    const res = await this.#run(args, cwd, ctx);
    if (res.code !== 0) {
      throw new WorktreeError("git-error", `git ${args[0] ?? ""} 失败（退出码 ${res.code}）`, {
        ...ctx,
        stderr: this.#sanitize(`${res.stdout}\n${res.stderr}`, cwd),
      });
    }
    return res;
  }

  #sanitize(stderr: string, repoRoot: string): string {
    return sanitizeGitStderr(stderr, { repoRoot, worktreesRoot: this.#worktreesRoot });
  }
}
