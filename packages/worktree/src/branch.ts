/**
 * @bi/worktree —— 分支命名与 taskId 路径安全基元（含 worktree 域结构化错误类型）。
 *
 * - taskId 白名单 `[A-Za-z0-9._-]+`，显式拒绝 `..` 路径穿越与 `.` 全点目录，防 worktree 路径逃逸；
 * - 分支名与 taskId 严格双向映射：`parseBranchName(branchName(t)) === t`；
 * - `ensureUniqueBranch` 为外部调用方提供确定性后缀去重（`.2`/`.3`/…）；
 * - 域内统一错误载体 `WorktreeError`：`code` 结构化 + `stderr` 已脱敏，供上层审查门/编排层程序化分流。
 */

/** bi-task 专用分支前缀。 */
export const BRANCH_PREFIX = "bi-task-";

/** taskId 白名单：字母、数字、点、下划线、连字符。 */
export const TASK_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** taskId 长度上限（防御 fs/引用长度上限类错误）。 */
export const MAX_TASK_ID_LENGTH = 128;

/** worktree 域结构化错误码。 */
export type WorktreeErrorCode =
  | "invalid-task-id"
  | "invalid-argument"
  | "repo-missing"
  | "worktree-exists"
  | "worktree-missing"
  | "git-error";

/** worktree 域统一结构化错误：code 供程序分流，stderr 为脱敏后的 git 输出。 */
export class WorktreeError extends Error {
  readonly code: WorktreeErrorCode;
  readonly taskId?: string;
  readonly stderr?: string;

  constructor(
    code: WorktreeErrorCode,
    message: string,
    opts: { taskId?: string; stderr?: string; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "WorktreeError";
    this.code = code;
    this.taskId = opts.taskId;
    this.stderr = opts.stderr;
  }
}

/** 类型守卫：是否为 worktree 域结构化错误。 */
export function isWorktreeError(value: unknown): value is WorktreeError {
  return value instanceof WorktreeError;
}

/** taskId 是否合法：白名单 + 拒绝 `..`（路径穿越）+ 拒绝 `.` + 长度上限。 */
export function isValidTaskId(taskId: string): boolean {
  if (taskId.length === 0 || taskId.length > MAX_TASK_ID_LENGTH) return false;
  if (!TASK_ID_PATTERN.test(taskId)) return false;
  if (taskId.includes("..")) return false;
  if (taskId === ".") return false;
  return true;
}

/** 断言 taskId 合法，非法时抛出结构化错误 invalid-task-id。 */
export function assertValidTaskId(taskId: string): string {
  if (!isValidTaskId(taskId)) {
    throw new WorktreeError(
      "invalid-task-id",
      `非法 taskId：${JSON.stringify(taskId)}（白名单 [A-Za-z0-9._-]+，拒绝 ".." 路径穿越与 "."）`,
      { taskId },
    );
  }
  return taskId;
}

/** taskId → 任务分支名 `bi-task-<taskId>`（非法 taskId 直接抛 invalid-task-id）。 */
export function branchName(taskId: string): string {
  assertValidTaskId(taskId);
  return `${BRANCH_PREFIX}${taskId}`;
}

/** 任务分支名 → taskId（反向映射；非本域分支或后缀非法时返回 null）。 */
export function parseBranchName(branch: string): string | null {
  if (!branch.startsWith(BRANCH_PREFIX)) return null;
  const taskId = branch.slice(BRANCH_PREFIX.length);
  return isValidTaskId(taskId) ? taskId : null;
}

/** 确定性分支名去重：候选名空闲则原样返回，否则追加最小数字后缀 `.2`/`.3`/…。 */
export function ensureUniqueBranch(candidate: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  if (!taken.has(candidate)) return candidate;
  for (let i = 2; ; i += 1) {
    const suffixed = `${candidate}.${i}`;
    if (!taken.has(suffixed)) return suffixed;
  }
}
