/**
 * BI-21.2 · 工作区变更追踪器（WorkspaceTracker）。
 *
 * 自动记录本轮会话触发的 Git 变更集并渲染变更统计看板。合约（工单钉死）：
 * - `captureBaseline()`：开工时记录 HEAD + porcelain 快照（`git status --porcelain
 *   -z`）——基线时刻已存在的脏文件/未跟踪文件是"存量噪音"，此后不重复上报；
 * - `changesSinceBaseline()`：已提交部分走 `git diff --numstat <base>..HEAD`
 *   （numstat 解析，二进制文件 ins/del 为 `-` → binary:true 计 0 行）；未提交
 *   部分走当前 porcelain，与基线快照差分出新增 dirty（含 staged）与新增
 *   untracked → 汇总 { committedFiles, untracked, dirty, totalInsertions,
 *   totalDeletions }；
 * - `renderChangeCard(report)`：变更统计看板（文件清单 + 增删行数 + 汇总行
 *   `N files changed, +X -Y`），确定性渲染可快照；无变更零噪音（单行 No changes）；
 * - 非 git 目录：captureBaseline 结构化抛 `not-a-git-repo`；未建基线即查询抛
 *   `no-baseline`；其余 git 失败抛 `git-failed`（stderr 首行截断）。
 *
 * git 执行器（BI-12 前例同款合约）：runner 永不抛出，失败以非零 code 返回；
 * 缺省 node:child_process execFile git（无 shell、无网络）。测试可注入 stub。
 *
 * 基线无提交（空仓库开工）且期间出现首批提交时，以空树（`git hash-object -t
 * tree /dev/null`，POSIX）为 diff 起点计入 committedFiles。
 */
import { execFile } from "node:child_process";

// ---------------------------------------------------------------------------
// git 执行器（与 @bi/worktree 的 GitRunner 同形合约）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 结构化错误
// ---------------------------------------------------------------------------

/** 追踪器结构化错误（判别方式：code 字段）。 */
export class TrackerError extends Error {
  readonly code: "not-a-git-repo" | "no-baseline" | "git-failed";

  constructor(code: "not-a-git-repo" | "no-baseline" | "git-failed", message: string) {
    super(message);
    this.name = "TrackerError";
    this.code = code;
  }
}

/** 判别 TrackerError（跨 package 捕获用类型守卫）。 */
export function isTrackerError(err: unknown): err is TrackerError {
  return err instanceof TrackerError;
}

function gitFailedError(op: string, res: GitRunResult): TrackerError {
  const stderr = (res.stderr.trim().split("\n")[0] ?? "").slice(0, 500);
  return new TrackerError("git-failed", `git ${op} 失败（exit ${res.code}）：${stderr}`);
}

// ---------------------------------------------------------------------------
// 报告类型
// ---------------------------------------------------------------------------

/** 已提交变更的单文件统计（numstat 解析产物）。 */
export interface CommittedFileChange {
  path: string;
  insertions: number;
  deletions: number;
  /** 二进制文件（numstat 的 `-`）：行数计 0，以 binary 标记区分真 0 行。 */
  binary: boolean;
}

/** 变更报告：基线以来已提交 + 未提交（dirty/untracked）的汇总。 */
export interface ChangeReport {
  /** 基线 HEAD（建基线时仓库尚无提交则为 null）。 */
  baseHead: string | null;
  committedFiles: CommittedFileChange[];
  untracked: string[];
  dirty: string[];
  totalInsertions: number;
  totalDeletions: number;
}

export interface WorkspaceTrackerOptions {
  /** 仓库根（工作树根；tmp fixture 注入）。 */
  repoRoot: string;
  /** git 执行器（缺省 defaultGitRunner）。 */
  gitRunner?: GitRunner;
  /** 时钟注入（缺省 Date.now；记录基线建立时刻用）。 */
  clock?: () => number;
}

/** 基线快照：HEAD + 建基线时刻 + porcelain 状态（存量噪音，此后不上报）。 */
interface Baseline {
  head: string | null;
  capturedAt: number;
  /** path → "XY" 状态对（untracked 为 "??"）。 */
  porcelain: Map<string, string>;
}

// ---------------------------------------------------------------------------
// 纯函数（导出供测试直接钉行为）
// ---------------------------------------------------------------------------

/**
 * 解析 `git diff --numstat` 输出（非 -z 形态）：每行
 * `<insertions>\t<deletions>\t<path>`；二进制文件 ins/del 均为 `-` → binary:true。
 * rename 显示为 `old => new` / `old => {prefix => suffix}new`，按显示文本原样记录。
 */
export function parseNumstat(stdout: string): CommittedFileChange[] {
  const out: CommittedFileChange[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const first = line.indexOf("\t");
    const second = line.indexOf("\t", first + 1);
    if (first < 0 || second < 0) continue; // 防御：残缺行跳过
    const ins = line.slice(0, first);
    const del = line.slice(first + 1, second);
    const path = line.slice(second + 1);
    if (ins === "-" || del === "-") {
      out.push({ path, insertions: 0, deletions: 0, binary: true });
      continue;
    }
    out.push({ path, insertions: Number(ins), deletions: Number(del), binary: false });
  }
  return out;
}

/**
 * 解析 `git status --porcelain -z`：条目以 NUL 分隔，每条目首两字符为 XY 状态、
 * 第三字符为空格、其余为路径；rename/copy 条目后跟第二个 NUL 分隔的原始路径
 * （取新路径入表，消费掉原始路径字段）。返回 path → XY 映射（git 输出本身按
 * 路径排序；-z 形态不受 core.quotePath 影响，非 ASCII 路径不转义）。
 */
export function parsePorcelainZ(stdout: string): Map<string, string> {
  const map = new Map<string, string>();
  const fields = stdout.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]!;
    if (entry.length < 4) continue; // 尾部空字段 / 残缺（最短合法条目 "XY P" 为 4 字符）
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    map.set(path, xy);
    if (xy.includes("R") || xy.includes("C")) {
      i++; // rename/copy：下一字段为原始路径，一并消费
    }
  }
  return map;
}

const CARD_RULE = "──────────────────────────────────────";

function shortHead(head: string | null): string {
  return head === null ? "<none>" : head.slice(0, 7);
}

function plural(n: number, word: string): string {
  return n === 1 ? `1 ${word}` : `${n} ${word}s`;
}

/**
 * 渲染确定性变更统计看板（纯文本，可快照）：`📊 Workspace Changes` 标题 + 分节
 * 文件清单（Committed/Untracked/Dirty，空节省略）+ 汇总行
 * `N files changed, +X -Y`（尾部附非零的 untracked/dirty 计数）。零变更时仅一行
 * No changes（零噪音）。
 */
export function renderChangeCard(report: ChangeReport): string {
  const lines: string[] = [];
  lines.push(`📊 Workspace Changes · base ${shortHead(report.baseHead)}`);
  lines.push(CARD_RULE);
  if (
    report.committedFiles.length === 0 &&
    report.untracked.length === 0 &&
    report.dirty.length === 0
  ) {
    lines.push("No changes since baseline.");
  } else {
    if (report.committedFiles.length > 0) {
      lines.push("Committed:");
      report.committedFiles.forEach((f, i) => {
        const delta = f.binary ? "binary" : `+${f.insertions} -${f.deletions}`;
        lines.push(`  ${i + 1}. ${delta}  ${f.path}`);
      });
    }
    if (report.untracked.length > 0) {
      lines.push("Untracked:");
      for (const p of report.untracked) lines.push(`  ?? ${p}`);
    }
    if (report.dirty.length > 0) {
      lines.push("Dirty:");
      for (const p of report.dirty) lines.push(`  M  ${p}`);
    }
  }
  lines.push(CARD_RULE);
  const extras: string[] = [];
  if (report.untracked.length > 0) extras.push(plural(report.untracked.length, "untracked"));
  if (report.dirty.length > 0) extras.push(plural(report.dirty.length, "dirty"));
  const tail = extras.length > 0 ? ` · ${extras.join(" · ")}` : "";
  lines.push(
    `${plural(report.committedFiles.length, "file")} changed, +${report.totalInsertions} -${report.totalDeletions}${tail}`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// WorkspaceTracker
// ---------------------------------------------------------------------------

/** 工作区变更追踪器：开工建基线，随时汇出变更看板。 */
export class WorkspaceTracker {
  readonly #repoRoot: string;
  readonly #git: GitRunner;
  readonly #now: () => number;
  #baseline: Baseline | null = null;

  constructor(options: WorkspaceTrackerOptions) {
    this.#repoRoot = options.repoRoot;
    this.#git = options.gitRunner ?? defaultGitRunner;
    this.#now = options.clock ?? Date.now;
  }

  /** 当前基线 HEAD（未建为 null；观测/测试用）。 */
  get baseline(): string | null {
    return this.#baseline?.head ?? null;
  }

  /** 基线建立时刻（注入时钟，毫秒；未建为 null）。 */
  get capturedAt(): number | null {
    return this.#baseline?.capturedAt ?? null;
  }

  async #run(args: readonly string[], op: string): Promise<string> {
    const res = await this.#git(args, { cwd: this.#repoRoot });
    if (res.code !== 0) throw gitFailedError(op, res);
    return res.stdout;
  }

  /** 当前 porcelain 状态（-z 解析）。 */
  async #porcelain(): Promise<Map<string, string>> {
    return parsePorcelainZ(await this.#run(["status", "--porcelain", "-z"], "status --porcelain"));
  }

  /** 当前 HEAD；仓库尚无提交返回 null。 */
  async #head(): Promise<string | null> {
    const res = await this.#git(["rev-parse", "HEAD"], { cwd: this.#repoRoot });
    if (res.code === 0) return res.stdout.trim();
    // 仓库存在但无提交（ambiguous argument 'HEAD': unknown revision）→ 合法空基线
    if (res.stderr.includes("ambiguous argument") || res.stderr.includes("unknown revision")) {
      return null;
    }
    throw gitFailedError("rev-parse HEAD", res);
  }

  /**
   * 开工建基线：记录 HEAD + porcelain 快照。非 git 工作树 → 结构化
   * `not-a-git-repo`。重复调用即重置基线（新一轮会话语义）。
   */
  async captureBaseline(): Promise<void> {
    const inside = await this.#git(["rev-parse", "--is-inside-work-tree"], { cwd: this.#repoRoot });
    if (inside.code !== 0 || inside.stdout.trim() !== "true") {
      const stderr = (inside.stderr.trim().split("\n")[0] ?? "").slice(0, 500);
      throw new TrackerError(
        "not-a-git-repo",
        `workspace-tracker：${this.#repoRoot} 不是 git 工作树（git rev-parse exit ${inside.code}）${stderr ? `：${stderr}` : ""}`,
      );
    }
    this.#baseline = {
      head: await this.#head(),
      capturedAt: this.#now(),
      porcelain: await this.#porcelain(),
    };
  }

  /**
   * 汇出基线以来的变更报告。未建基线 → 结构化 `no-baseline`。
   * - committedFiles：`git diff --numstat <base>..HEAD`（基线无提交且期间出现
   *   首批提交时，以空树为 diff 起点计入）；
   * - dirty：当前 porcelain 非 `??` 条目中，基线快照没有的（存量脏文件不上报）；
   * - untracked：当前 `??` 条目中，基线快照没有的。
   */
  async changesSinceBaseline(): Promise<ChangeReport> {
    if (this.#baseline === null) {
      throw new TrackerError("no-baseline", "workspace-tracker：尚未 captureBaseline()，无基线可比");
    }
    const base = this.#baseline;

    // 已提交变更：base..HEAD（head 未动则跳过 diff，零噪音）
    const committedFiles: CommittedFileChange[] = [];
    const headNow = await this.#head();
    if (headNow !== null && headNow !== base.head) {
      const start = base.head ?? (await this.#run(["hash-object", "-t", "tree", "/dev/null"], "hash-object")).trim();
      committedFiles.push(
        ...parseNumstat(await this.#run(["diff", "--numstat", `${start}..${headNow}`], "diff --numstat")),
      );
    }

    // 未提交变更：与基线 porcelain 差分（存量噪音不上报）
    const untracked: string[] = [];
    const dirty: string[] = [];
    for (const [path, xy] of await this.#porcelain()) {
      if (base.porcelain.has(path)) continue; // 基线时刻已存在的状态不再上报
      if (xy === "??") untracked.push(path);
      else dirty.push(path);
    }

    let totalInsertions = 0;
    let totalDeletions = 0;
    for (const f of committedFiles) {
      totalInsertions += f.insertions;
      totalDeletions += f.deletions;
    }
    return {
      baseHead: base.head,
      committedFiles,
      untracked,
      dirty,
      totalInsertions,
      totalDeletions,
    };
  }

  /** 渲染变更统计看板（确定性纯函数转发，可快照）。 */
  renderChangeCard(report: ChangeReport): string {
    return renderChangeCard(report);
  }
}
