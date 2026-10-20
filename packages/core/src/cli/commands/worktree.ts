/**
 * BI-12 · `bi worktree` 子命令：Git Worktree 物理并发沙箱引擎的 CLI 面
 * （create / list / merge / discard）。
 *
 * 引擎器官在库即用（packages/worktree/src 的 WorktreeEngine）；本模块只做
 * 「argv → 引擎 → 结构化输出」的外壳，不复制引擎语义：
 *   create  = `create(taskId, { baseRef, repo })`，返回工作树快照；
 *   list    = `list({ repo })` 列举本引擎管辖的工作树（bi-task-* 分支）；
 *   merge   = `mergeBack(taskId, { message, repo })`，冲突如实报 conflict:true
 *             （引擎已 merge --abort 回滚现场，绝不自动解——人类审查门语义）；
 *   discard = `discard(taskId, { repo })` 静默清空（force 移除 + 分支删除，幂等）。
 *
 * 退出码语义对齐既有子命令：0 成功 / 1 运行期失败（目标缺失 / 冲突 / IO）/
 * 2 用法错误。stdout 出数据（JSON 行），汇总与诊断走 stderr（管道友好）。
 *
 * 测试零外呼 git 之外的依赖：repo = deps.cwd（缺省 process.cwd()），
 * worktreesRoot = deps.worktreesRoot（缺省 <repo>/.bi/worktrees）；测试注入临时目录。
 */
import { join } from "node:path";
import { WorktreeEngine, WorktreeError } from "../../../../worktree/src";
import type { SubcommandDeps, SubcommandIo } from "./dispatch";

/** 本模块用法错误（dispatch 按类名兜底捕获 → exit 2，与 query.ts 同一手法）。 */
class SubUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubUsageError";
  }
}

/** worktree 子命令 argv 解析结果。 */
interface WorktreeArgs {
  positionals: string[];
  flags: Map<string, string>;
}

/** 解析 `bi worktree <action> [--task <id>] [--base <ref>] [--message <msg>]`。 */
function parseWorktreeArgs(rest: readonly string[]): WorktreeArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  let i = 0;
  while (i < rest.length) {
    const token = rest[i];
    i += 1;
    if (token === undefined) break;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const flag = eq === -1 ? token : token.slice(0, eq);
    if (flag !== "--task" && flag !== "--base" && flag !== "--message") {
      throw new SubUsageError(`未知参数: ${token}`);
    }
    const raw = eq === -1 ? rest[i++] : token.slice(eq + 1);
    if (raw === undefined || raw === "" || raw.startsWith("-")) {
      throw new SubUsageError(`参数 ${flag} 缺少值`);
    }
    if (flags.has(flag)) throw new SubUsageError(`参数重复: ${flag}`);
    flags.set(flag, raw);
  }
  return { positionals, flags };
}

/** 装配引擎：仓库根取 cwd，worktrees 缺省落 <cwd>/.bi/worktrees。 */
function makeEngine(deps: SubcommandDeps): WorktreeEngine {
  const repo = deps.cwd ?? process.cwd();
  const worktreesRoot = join(repo, ".bi", "worktrees");
  return new WorktreeEngine({ reposRoot: repo, worktreesRoot });
}

/**
 * `bi worktree <create|list|merge|discard> ...`：定位 action 后派发到各 handler。
 * 引擎结构化错误（WorktreeError）归 exit 1；用法错误归 exit 2。
 */
export async function handleWorktree(
  rest: readonly string[],
  io: SubcommandIo,
  deps: SubcommandDeps,
): Promise<number> {
  const args = parseWorktreeArgs(rest);
  const action = args.positionals[0];
  if (action !== "create" && action !== "list" && action !== "merge" && action !== "discard") {
    throw new SubUsageError(
      `未知 action: ${action ?? "(空)"}（允许: create / list / merge / discard）`,
    );
  }
  const engine = makeEngine(deps);
  const repo = deps.cwd ?? process.cwd();
  try {
    switch (action) {
      case "create":
        return await doCreate(engine, args, io, repo);
      case "list":
        return await doList(engine, io, repo);
      case "merge":
        return await doMerge(engine, args, io, repo);
      case "discard":
        return await doDiscard(engine, args, io, repo);
    }
  } catch (cause) {
    if (cause instanceof WorktreeError) {
      const detail = cause.stderr !== undefined ? `\n${cause.stderr}` : "";
      io.err(`bi worktree ${action}: ${cause.message}${detail}`);
      return 1;
    }
    throw cause;
  }
}

/** `bi worktree create --task <id> [--base <ref>]`：创建工作树，输出快照 JSON。 */
async function doCreate(
  engine: WorktreeEngine,
  args: WorktreeArgs,
  io: SubcommandIo,
  repo: string,
): Promise<number> {
  const taskId = args.flags.get("--task");
  if (taskId === undefined) throw new SubUsageError("create 需要 --task <id>");
  const base = args.flags.get("--base");
  const info = await engine.create(taskId, { baseRef: base, repo });
  io.out(JSON.stringify({ action: "create", ...info }));
  io.err(`bi worktree: 已创建 ${info.taskId} @ ${info.branch}（${info.worktreePath}）`);
  return 0;
}

/** `bi worktree list`：列举工作树（JSON 行，按 taskId 排序）。 */
async function doList(
  engine: WorktreeEngine,
  io: SubcommandIo,
  repo: string,
): Promise<number> {
  const infos = await engine.list({ repo });
  for (const info of infos) io.out(JSON.stringify(info));
  io.err(`bi worktree: 共 ${infos.length} 个工作树`);
  return 0;
}

/** `bi worktree merge --task <id> [--message <msg>]`：原子合回；冲突如实报 conflict:true。 */
async function doMerge(
  engine: WorktreeEngine,
  args: WorktreeArgs,
  io: SubcommandIo,
  repo: string,
): Promise<number> {
  const taskId = args.flags.get("--task");
  if (taskId === undefined) throw new SubUsageError("merge 需要 --task <id>");
  const message = args.flags.get("--message") ?? `bi: merge back task ${taskId}`;
  const result = await engine.mergeBack(taskId, { message, repo });
  io.out(JSON.stringify({ action: "merge", ...result }));
  if (result.merged) {
    io.err(
      `bi worktree: 已合回 ${taskId}（commit ${result.commit}；工作树清理 ${result.removed ? "完成" : "保留"}）`,
    );
    return 0;
  }
  // 冲突：现场已回滚，交人类审查门；structured exit 1（合回未完成）。
  io.err(`bi worktree: 合回冲突（${taskId}），已回滚现场交人工审查`);
  return 1;
}

/** `bi worktree discard --task <id>`：撤销语义，静默清空（幂等）。 */
async function doDiscard(
  engine: WorktreeEngine,
  args: WorktreeArgs,
  io: SubcommandIo,
  repo: string,
): Promise<number> {
  const taskId = args.flags.get("--task");
  if (taskId === undefined) throw new SubUsageError("discard 需要 --task <id>");
  const result = await engine.discard(taskId, { repo });
  io.out(JSON.stringify({ action: "discard", ...result }));
  io.err(
    `bi worktree: 已撤销 ${taskId}（移除 ${result.removed} / 分支删除 ${result.branchDeleted}）`,
  );
  return 0;
}
