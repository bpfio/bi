/**
 * @bi/worktree —— Tower 多 Agent 工作区分支协作服务（BI-12.2）。
 *
 * 基座：组合已关单的 WorktreeEngine（import，不改）——每 Tower 任务 =
 * 一个 worktree + 分支（`bi-task-<taskId>`），不另建隔离机制。
 *
 * 13 个 Tower* 操作：Init / Plan / Spawn / Merge / Rebase / Review / Finding /
 * Mission / Inbox / Status / Abort / Promote / Diff。除三个只读操作
 * （Inbox / Status / Diff）外，每个操作 = 组合引擎动作 + `.tower/comms/`
 * 信件读写（协议见 tower-protocol.ts）。
 *
 * TowerMerge = 信件门禁：必须存在 kind='review' 且 approved=true 且
 * from='reviewer' 的信，才调 engine.mergeBack；否则拒绝
 * `merge-gate-blocked`（RULE-BI-05 人类审查门精神，人工弹窗归 BI-20）。
 * TowerAbort → engine.discard（静默清空，改动全弃）；信件 append-only
 * 保留全程审计链。TowerPromote（结案）复用同一审查门禁。
 */
import { isWorktreeError, WorktreeError } from "../branch";
import { defaultGitRunner, sanitizeGitStderr, WorktreeEngine } from "../engine";
import type { GitRunner, MergeBackResult, RemoveWorktreeResult, WorktreeInfo } from "../engine";
import { TOWER_BROADCAST_TASK_ID, TowerProtocol } from "./tower-protocol";
import type { TowerMessage, TowerMessageKind, TowerRole } from "./tower-protocol";

/** Rebase / Diff 的默认基线引用。 */
export const DEFAULT_TOWER_BASE_REF = "main";

/** Tower 操作统一返回：领域失败以 ok=false + code 结构化呈现（不抛出）。 */
export interface TowerOpResult<T = unknown> {
  ok: boolean;
  /** 失败原因码：引擎错误码透传（worktree-exists / repo-missing / …）或塔语义码 */
  code?: string;
  detail?: string;
  data?: T;
}

/** TowerStatus 聚合数据。 */
export interface TowerStatusData {
  taskId: string;
  worktree: WorktreeInfo | null;
  letterCount: number;
  letterKinds: Record<TowerMessageKind, number>;
  /** 合并门禁是否已开（存在 reviewer 的 approved review 信） */
  mergeGateOpen: boolean;
}

/** TowerService 构造项。 */
export interface TowerServiceOptions {
  /** 组合复用的 BI-12 引擎（只调用不修改） */
  engine: WorktreeEngine;
  /** 塔根目录（`.tower/` 的宿主目录） */
  towerRoot: string;
  /** 注入时钟（信件 ts 盖章） */
  now?: () => number;
  /** 协议存取器注入（缺省按 towerRoot 内部构造） */
  protocol?: TowerProtocol;
  /** git 执行器（Rebase/Diff 用；缺省复用引擎 defaultGitRunner） */
  gitRunner?: GitRunner;
  /** Rebase/Diff 基线；缺省 main */
  baseRef?: string;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Tower 多 Agent 工作区协作服务。 */
export class TowerService {
  readonly #engine: WorktreeEngine;
  readonly #protocol: TowerProtocol;
  readonly #gitRunner: GitRunner;
  readonly #baseRef: string;

  constructor(opts: TowerServiceOptions) {
    this.#engine = opts.engine;
    this.#protocol =
      opts.protocol ?? new TowerProtocol({ towerRoot: opts.towerRoot, now: opts.now });
    this.#gitRunner = opts.gitRunner ?? defaultGitRunner;
    this.#baseRef = opts.baseRef ?? DEFAULT_TOWER_BASE_REF;
  }

  /** 组合的引擎实例。 */
  get engine(): WorktreeEngine {
    return this.#engine;
  }

  /** 信件协议存取器。 */
  get protocol(): TowerProtocol {
    return this.#protocol;
  }

  #fail(err: unknown): TowerOpResult<never> {
    if (isWorktreeError(err)) {
      return { ok: false, code: err.code, detail: err.stderr ?? err.message };
    }
    return { ok: false, code: "internal-error", detail: messageOf(err) };
  }

  #post(
    from: TowerRole,
    kind: TowerMessageKind,
    taskId: string,
    body: string,
    approved?: boolean,
  ): TowerMessage {
    return this.#protocol.post(approved === undefined ? { from, kind, taskId, body } : { from, kind, taskId, body, approved });
  }

  /** 合并/结案共用门禁：reviewer 的 approved review 信（首个命中）。 */
  #approvedReview(taskId: string): TowerMessage | undefined {
    return this.#protocol
      .readFor(taskId)
      .find((letter) => letter.kind === "review" && letter.from === "reviewer" && letter.approved === true);
  }

  /** TowerInit：建立 `.tower/comms/` 并落塔级广播信。 */
  async init(): Promise<TowerOpResult<{ commsDir: string; letterId: string }>> {
    const letter = this.#post("initiator", "status", TOWER_BROADCAST_TASK_ID, "tower initialized");
    return { ok: true, data: { commsDir: this.#protocol.commsDir, letterId: letter.id } };
  }

  /** TowerPlan：initiator 落技术方案信（kind='plan'）。 */
  async plan(taskId: string, body: string): Promise<TowerOpResult<TowerMessage>> {
    if (typeof body !== "string" || body.trim() === "") {
      return { ok: false, code: "invalid-argument", detail: "plan 正文不能为空" };
    }
    return { ok: true, data: this.#post("initiator", "plan", taskId, body) };
  }

  /** TowerMission：initiator 给 worker 下任务书（kind='status'，body 加 mission: 前缀）。 */
  async mission(taskId: string, body: string): Promise<TowerOpResult<TowerMessage>> {
    if (typeof body !== "string" || body.trim() === "") {
      return { ok: false, code: "invalid-argument", detail: "mission 正文不能为空" };
    }
    return { ok: true, data: this.#post("initiator", "status", taskId, `mission: ${body}`) };
  }

  /** TowerSpawn：engine.create + spawn 信（工作树与分支物理落地）。 */
  async spawn(taskId: string): Promise<TowerOpResult<WorktreeInfo>> {
    try {
      const info = await this.#engine.create(taskId);
      this.#post(
        "initiator",
        "status",
        taskId,
        `spawned: worktree=${info.worktreePath} branch=${info.branch}`,
      );
      return { ok: true, data: info };
    } catch (err) {
      return this.#fail(err);
    }
  }

  /**
   * TowerMerge：信件门禁 —— 无 reviewer 的 approved review 信 →
   * `merge-gate-blocked`（引擎绝不被调用）；过门禁后落 merge-request
   * 审计信再 engine.mergeBack；冲突 → `merge-conflict`（现场已回滚）。
   */
  async merge(
    taskId: string,
    opts: { message?: string } = {},
  ): Promise<TowerOpResult<MergeBackResult>> {
    const review = this.#approvedReview(taskId);
    if (review === undefined) {
      return {
        ok: false,
        code: "merge-gate-blocked",
        detail: `合并门禁拒绝：任务 ${taskId} 缺少 reviewer 的 approved review 信（RULE-BI-05）`,
      };
    }
    this.#post("worker", "merge-request", taskId, `merge requested per review ${review.id}`);
    try {
      const result = await this.#engine.mergeBack(taskId, {
        message: opts.message ?? `Tower merge for ${taskId} (approved by ${review.id})`,
      });
      if (result.merged) {
        this.#post("initiator", "status", taskId, `merged: commit=${result.commit}`);
        return { ok: true, data: result };
      }
      return {
        ok: false,
        code: "merge-conflict",
        detail: "合并冲突：现场已 merge --abort 回滚，交人类审查门裁决",
        data: result,
      };
    } catch (err) {
      return this.#fail(err);
    }
  }

  /** TowerRebase：engine.get 定位工作树后在其内 `git rebase <baseRef>`。 */
  async rebase(
    taskId: string,
    opts: { baseRef?: string } = {},
  ): Promise<TowerOpResult<{ worktreePath: string; branch: string; output: string }>> {
    let info: WorktreeInfo | null;
    try {
      info = await this.#engine.get(taskId);
    } catch (err) {
      return this.#fail(err);
    }
    if (info === null) {
      return { ok: false, code: "worktree-missing", detail: `任务工作树不存在：${taskId}` };
    }
    const baseRef = opts.baseRef ?? this.#baseRef;
    const res = await this.#gitRunner(["rebase", baseRef], { cwd: info.worktreePath });
    if (res.code !== 0) {
      const output = sanitizeGitStderr(`${res.stdout}\n${res.stderr}`, {
        repoRoot: this.#engine.reposRoot,
        worktreesRoot: this.#engine.worktreesRoot,
      });
      return {
        ok: false,
        code: "git-error",
        detail: `rebase 失败（退出码 ${res.code}）`,
        data: { worktreePath: info.worktreePath, branch: info.branch, output },
      };
    }
    this.#post("worker", "status", taskId, `rebased onto ${baseRef}`);
    return {
      ok: true,
      data: { worktreePath: info.worktreePath, branch: info.branch, output: res.stdout },
    };
  }

  /** TowerReview：reviewer 落裁决信（approved=true 开启合并门禁）。 */
  async review(taskId: string, approved: boolean, body: string): Promise<TowerOpResult<TowerMessage>> {
    if (typeof body !== "string" || body.trim() === "") {
      return { ok: false, code: "invalid-argument", detail: "review 意见不能为空" };
    }
    return { ok: true, data: this.#post("reviewer", "review", taskId, body, approved) };
  }

  /** TowerFinding：worker 落发现/风险上报信（kind='finding'）。 */
  async finding(taskId: string, body: string): Promise<TowerOpResult<TowerMessage>> {
    if (typeof body !== "string" || body.trim() === "") {
      return { ok: false, code: "invalid-argument", detail: "finding 正文不能为空" };
    }
    return { ok: true, data: this.#post("worker", "finding", taskId, body) };
  }

  /** TowerInbox：readInbox(role)（他人来信，可选按 taskId 过滤）。 */
  async inbox(role: TowerRole, taskId?: string): Promise<TowerOpResult<TowerMessage[]>> {
    return { ok: true, data: this.#protocol.readInbox(role, taskId) };
  }

  /** TowerStatus：引擎工作树快照 + 信件统计 + 门禁状态聚合（只读不落信）。 */
  async status(taskId: string): Promise<TowerOpResult<TowerStatusData>> {
    let worktree: WorktreeInfo | null;
    try {
      worktree = await this.#engine.get(taskId);
    } catch (err) {
      return this.#fail(err);
    }
    const letters = this.#protocol.readFor(taskId);
    const letterKinds: Record<TowerMessageKind, number> = {
      plan: 0,
      finding: 0,
      review: 0,
      "merge-request": 0,
      status: 0,
    };
    for (const letter of letters) letterKinds[letter.kind] += 1;
    return {
      ok: true,
      data: {
        taskId,
        worktree,
        letterCount: letters.length,
        letterKinds,
        mergeGateOpen: this.#approvedReview(taskId) !== undefined,
      },
    };
  }

  /** TowerAbort：engine.discard 静默清空（改动全弃）+ abort 信；信件链保留。 */
  async abort(taskId: string, reason: string): Promise<TowerOpResult<RemoveWorktreeResult>> {
    try {
      const result = await this.#engine.discard(taskId);
      this.#post("initiator", "status", taskId, `abort: ${reason}`);
      return { ok: true, data: result };
    } catch (err) {
      return this.#fail(err);
    }
  }

  /** TowerPromote：结案 —— 复用审查门禁，过门禁落 promoted 结案信。 */
  async promote(taskId: string): Promise<TowerOpResult<{ letterId: string }>> {
    const review = this.#approvedReview(taskId);
    if (review === undefined) {
      return {
        ok: false,
        code: "promote-gate-blocked",
        detail: `结案门禁拒绝：任务 ${taskId} 缺少 reviewer 的 approved review 信`,
      };
    }
    const letter = this.#post(
      "initiator",
      "status",
      taskId,
      `promoted: task ${taskId} closed per review ${review.id}`,
    );
    return { ok: true, data: { letterId: letter.id } };
  }

  /** TowerDiff：任务分支相对基线的差异（只读不落信）。 */
  async diff(
    taskId: string,
    opts: { baseRef?: string } = {},
  ): Promise<TowerOpResult<{ diff: string }>> {
    let info: WorktreeInfo | null;
    try {
      info = await this.#engine.get(taskId);
    } catch (err) {
      return this.#fail(err);
    }
    if (info === null) {
      return { ok: false, code: "worktree-missing", detail: `任务工作树不存在：${taskId}` };
    }
    const baseRef = opts.baseRef ?? this.#baseRef;
    const res = await this.#gitRunner(["diff", `${baseRef}...${info.branch}`], {
      cwd: info.worktreePath,
    });
    if (res.code !== 0) {
      const diff = sanitizeGitStderr(`${res.stdout}\n${res.stderr}`, {
        repoRoot: this.#engine.reposRoot,
        worktreesRoot: this.#engine.worktreesRoot,
      });
      return { ok: false, code: "git-error", detail: `diff 失败（退出码 ${res.code}）`, data: { diff } };
    }
    return { ok: true, data: { diff: res.stdout } };
  }
}
