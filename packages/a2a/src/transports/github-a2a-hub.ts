/**
 * BI-15.2 · GitHub A2A 任务中枢 (Data & Task Plane) —— REST 直呼合约级重实现。
 *
 * 零外部 npm 依赖：GitHub REST API v3 经注入 fetchImpl 直呼（无 octokit、无 sdk），
 * 将 A2A 任务生命周期映射到 GitHub 仓库资产：
 *   - 任务分支： bi-task-<taskId>                  （从 base 分支（缺省 main）创建）
 *   - 任务规格： bi-tasks/<taskId>/spec.json       （dispatchTask）
 *   - 任务结果： bi-tasks/<taskId>/result.json     （postResult）
 *   - 交付审查： PR head=bi-task-<taskId> base=main（openPr / listOpenPrs / mergePr）
 *
 * REST 端点与 octokit 语义对照（合约落地说明）：
 *   - 分支创建：GitHub REST v3 无 `POST /repos/{o}/{r}/branches` 字面端点；octokit 语义下
 *     「从 main 创建 bi-task-<id>」= GET /repos/{o}/{r}/git/ref/heads/<base> 解析 base sha
 *     → POST /repos/{o}/{r}/git/refs { ref: "refs/heads/bi-task-<id>", sha }（git.createRef）。
 *   - 内容写入：PUT /repos/{o}/{r}/contents/<path>（contents API 无独立 PATCH 方法）——
 *     SHA 流程「先 GET 查存在 → 存在则 PATCH」落地为：GET contents?ref=<branch> 取 sha，
 *     无 sha = create（201），携带 sha = update（200，即 PATCH 语义）。
 *   - PR：POST /repos/{o}/{r}/pulls（open）；GET /repos/{o}/{r}/pulls?state=open 分页
 *     （Link rel="next" 驱动）；PUT /repos/{o}/{r}/pulls/{n}/merge（合并）。
 *
 * RULE-BI-05 人类审查语义（merge gate）：
 *   - mergePr 必须显式注入非空 approvedBy（人类审查人标识），否则本地拒绝、
 *     零网络调用；合并决策写入审计环（mergeDecisions()）。
 *
 * 错误结构化（GitHub REST 状态 → 五分类映射表）：
 *   | 状态 / 来源                                   | code          |
 *   |-----------------------------------------------|---------------|
 *   | 401                                           | auth          |
 *   | 403（且 x-ratelimit-remaining: 0）            | rate_limited  |
 *   | 403（其余）                                   | auth          |
 *   | 404                                           | not_found     |
 *   | 409、422                                      | conflict      |
 *   | 429                                           | rate_limited  |
 *   | 5xx                                           | network       |
 *   | 其余 4xx                                      | conflict      |
 *   | fetchImpl 抛错 / 响应体损坏                   | network       |
 *
 * 安全红线（零数据外泄）：
 *   - token 仅接受 GithubToken 品牌类型（裸 string 无法通过编译混入密钥位）；
 *   - 请求头 / 请求体一律不落日志；日志与错误消息全量经 redact()，token 片段以 *** 落盘；
 *   - taskId 经分支安全正则校验（拒绝路径穿越 / refname 注入字符）后才拼接 URL 与路径；
 *   - 测试一律走注入 fetch stub（脚本化响应），不触碰真实 GitHub、零真实 token。
 */

import { randomUUID } from "node:crypto";
import {
  signEnvelope,
  verifyEnvelope,
  type A2aEnvelope,
  type A2aSharedSecret,
  type SignedEnvelope,
  type VerifyFailureReason,
  type VerifyOptions,
} from "../auth";
import type { TransportPort } from "../host";

// ---------------------------------------------------------------------------
// Secret 品牌（对齐 auth.ts 的品牌模式：零运行时开销，编译期拒绝裸 string）
// ---------------------------------------------------------------------------

declare const tokenBrand: unique symbol;

/** GitHub 访问令牌（compile-time brand）。由 githubToken() 构造；严禁进入日志/错误消息。 */
export type GithubToken = string & { readonly [tokenBrand]: "github-token" };

/** 给明文 token 打品牌标记（不拷贝、不改写；拒绝空串防呆）。 */
export function githubToken(raw: string): GithubToken {
  if (raw.length === 0) {
    throw new RangeError("GithubToken 不能为空串");
  }
  return raw as GithubToken;
}

// ---------------------------------------------------------------------------
// 错误模型：auth / rate_limited / not_found / conflict / network 五分类
// ---------------------------------------------------------------------------

export type GithubA2aErrorCode = "auth" | "rate_limited" | "not_found" | "conflict" | "network";

/** 结构化 REST 错误：五分类 code + 可选 HTTP status；消息已脱敏。 */
export class GithubA2aError extends Error {
  readonly code: GithubA2aErrorCode;
  readonly status?: number;

  constructor(code: GithubA2aErrorCode, message: string, status?: number) {
    super(`[github-a2a-hub:${code}] ${message}`);
    this.name = "GithubA2aError";
    this.code = code;
    this.status = status;
  }
}

/** GitHub REST 状态 → 五分类映射（见文件头映射表）。 */
function classifyStatus(status: number, rateRemaining: string | null): GithubA2aErrorCode {
  if (status === 401) return "auth";
  if (status === 403 && rateRemaining === "0") return "rate_limited";
  if (status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 409 || status === 422) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "network";
  return "conflict";
}

// ---------------------------------------------------------------------------
// 常量与 taskId 防注入校验
// ---------------------------------------------------------------------------

export const TASK_BRANCH_PREFIX = "bi-task-" as const;
export const TASKS_DIR = "bi-tasks" as const;
const DEFAULT_API_BASE = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "bi-a2a-hub/0.1.0 (BI-15.2)";
const PER_PAGE = 100;
const MAX_PAGES = 50;
const MAX_LOG_LINES = 500;

/** 分支/路径安全 taskId：字母数字开头，仅 [A-Za-z0-9._-]，≤64，且不含 ".."（refname 安全）。 */
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** taskId 防注入校验：错误消息只回显长度，不回显原文（拒绝内容不得污染日志）。 */
export function assertTaskId(taskId: string): void {
  if (typeof taskId !== "string" || !TASK_ID_RE.test(taskId) || taskId.includes("..")) {
    throw new RangeError(
      `taskId 非法（须匹配 ${TASK_ID_RE.source} 且不含 ".."）：长度 ${String(taskId?.length ?? 0)}`,
    );
  }
}

function assertApprovedBy(approvedBy: string): string {
  const trimmed = typeof approvedBy === "string" ? approvedBy.trim() : "";
  if (trimmed.length === 0 || trimmed.length > 128 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new RangeError(
      "mergePr 拒绝：merge gate 要求非空 approvedBy（RULE-BI-05 人类审查语义），零网络调用",
    );
  }
  return trimmed;
}

/** 任务载荷 JSON 序列化（稳定两空格缩进 + 末尾换行；测试与写入共用同一形态）。 */
export function encodeTaskJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// 领域类型
// ---------------------------------------------------------------------------

/** 任务规格（spec.json 载荷；createdAt 由调用方决定，中枢不改写）。 */
export interface TaskSpec {
  readonly kind: string;
  readonly payload: unknown;
  readonly createdAt?: string;
}

/** 任务结果（result.json 载荷）。 */
export interface TaskResult {
  readonly taskId: string;
  readonly ok: boolean;
  readonly payload: unknown;
  readonly finishedAt?: string;
}

export interface OpenPrInput {
  readonly title: string;
  readonly body: string;
}

/** PR 引用（hub 视角：附带从 head 分支派生的 taskId）。 */
export interface PrRef {
  readonly number: number;
  readonly taskId: string;
  readonly title: string;
  readonly head: string;
  readonly base: string;
  readonly url: string;
}

/** 合并决策审计（RULE-BI-05：谁批准、何时、结果）。 */
export interface MergeDecision {
  readonly prNumber: number;
  readonly approvedBy: string;
  readonly merged: boolean;
  readonly sha: string;
  readonly ts: number;
}

/** dispatchTask / postResult 返回（created=false 即 PATCH 语义更新）。 */
export interface ContentWriteResult {
  readonly path: string;
  readonly created: boolean;
}

export interface GithubA2aPort {
  dispatchTask(taskId: string, spec: TaskSpec): Promise<ContentWriteResult & { branch: string }>;
  openPr(taskId: string, input: OpenPrInput): Promise<PrRef>;
  listOpenPrs(): Promise<PrRef[]>;
  mergePr(prNumber: number, approvedBy: string): Promise<{ merged: boolean; sha: string }>;
  postResult(taskId: string, result: TaskResult): Promise<ContentWriteResult>;
}

/**
 * 注入 fetch 的最小结构类型（Bun 全局 fetch 带 preconnect 附加属性；
 * 注入面取最小 callable 结构——全局 fetch 与测试 stub 均天然可赋值）。
 */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface GithubA2aHubOptions {
  /** 注入 fetch 实现（测试注入脚本化 stub，零真实网络）。 */
  fetchImpl: FetchLike;
  owner: string;
  repo: string;
  /** GitHub 访问令牌（GithubToken 品牌；绝不入日志）。 */
  token: GithubToken;
  /** 任务分支的 base 分支（缺省 main）。 */
  baseBranch?: string;
  /** REST API base（缺省 https://api.github.com）。 */
  apiBase?: string;
  /** 注入时钟（审计 ts；缺省 Date.now）。 */
  clock?: () => number;
}

// ---------------------------------------------------------------------------
// GitHub REST 响应形状（防御式读取；octokit 语义直呼产物）
// ---------------------------------------------------------------------------

interface GitRefResponse {
  object?: { sha?: unknown };
}

interface ContentInfoResponse {
  sha?: unknown;
  /** GitHub contents GET：正文 base64（含换行折行）。 */
  content?: unknown;
  encoding?: unknown;
}

interface PullResponse {
  number?: unknown;
  title?: unknown;
  html_url?: unknown;
  head?: { ref?: unknown };
  base?: { ref?: unknown };
}

interface MergeResponse {
  merged?: unknown;
  sha?: unknown;
}

function taskBranchOf(taskId: string): string {
  return `${TASK_BRANCH_PREFIX}${taskId}`;
}

function taskSpecPath(taskId: string): string {
  return `${TASKS_DIR}/${taskId}/spec.json`;
}

function taskResultPath(taskId: string): string {
  return `${TASKS_DIR}/${taskId}/result.json`;
}

function toPrRef(json: PullResponse, fallbackTaskId: string): PrRef {
  const headRef = typeof json.head?.ref === "string" ? json.head.ref : "";
  const taskId = headRef.startsWith(TASK_BRANCH_PREFIX)
    ? headRef.slice(TASK_BRANCH_PREFIX.length)
    : fallbackTaskId;
  return {
    number: typeof json.number === "number" ? json.number : 0,
    taskId,
    title: typeof json.title === "string" ? json.title : "",
    head: headRef,
    base: typeof json.base?.ref === "string" ? json.base.ref : "",
    url: typeof json.html_url === "string" ? json.html_url : "",
  };
}

/** Link 头 rel="next" 探测（GitHub 分页语义的最小子集）。 */
function linkHasNext(res: Response): boolean {
  const link = res.headers.get("link");
  return link !== null && /<[^>]*>;\s*rel="?next"?/.test(link);
}

// ---------------------------------------------------------------------------
// A2A 信封封装（export/import 复用 BI-15.3 signEnvelope / verifyEnvelope）
// ---------------------------------------------------------------------------

export type TaskEnvelopeKind = "spec" | "result";

/** 任务信封载荷：键集恰为 taskId/kind/data（形状校验对齐包内信封严格键集风格）。 */
export interface TaskEnvelopePayload {
  readonly taskId: string;
  readonly kind: TaskEnvelopeKind;
  readonly data: unknown;
}

export interface TaskExportMeta {
  readonly from: string;
  readonly to: string;
  /** 缺省 Date.now()。 */
  readonly ts?: number;
  /** 缺省 crypto.randomUUID()。 */
  readonly nonce?: string;
}

function isTaskEnvelopePayload(value: unknown): value is TaskEnvelopePayload {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  if (Object.keys(rec).sort().join(",") !== "data,kind,taskId") return false;
  const taskIdOk =
    typeof rec.taskId === "string" && TASK_ID_RE.test(rec.taskId) && !rec.taskId.includes("..");
  return taskIdOk && (rec.kind === "spec" || rec.kind === "result") && "data" in rec;
}

/**
 * 导出任务信封：五字段封装后经 signEnvelope HMAC 签名（密钥经 a2aSecret() 品牌注入）。
 */
export function exportTaskEnvelope(
  taskId: string,
  kind: TaskEnvelopeKind,
  data: unknown,
  meta: TaskExportMeta,
  secret: A2aSharedSecret,
): SignedEnvelope<TaskEnvelopePayload> {
  assertTaskId(taskId);
  if (kind !== "spec" && kind !== "result") {
    throw new RangeError(`任务信封 kind 非法（只许 spec|result）：${String(kind)}`);
  }
  const envelope: A2aEnvelope<TaskEnvelopePayload> = {
    from: meta.from,
    to: meta.to,
    ts: meta.ts ?? Date.now(),
    nonce: meta.nonce ?? randomUUID(),
    payload: { taskId, kind, data },
  };
  return signEnvelope(envelope, secret);
}

export type ImportTaskVerdict =
  | {
      readonly valid: true;
      readonly taskId: string;
      readonly kind: TaskEnvelopeKind;
      readonly data: unknown;
      readonly envelope: A2aEnvelope<TaskEnvelopePayload>;
    }
  | { readonly valid: false; readonly reason: VerifyFailureReason };

/**
 * 导入任务信封：verifyEnvelope 五步验证 → 载荷形状校验（运行时防御：签名者可被信任，
 * 载荷结构不可信）。失败返回稳定 reason（malformed 覆盖载荷形状破坏）。
 */
export function importTaskEnvelope(
  signed: SignedEnvelope<TaskEnvelopePayload>,
  opts: VerifyOptions,
): ImportTaskVerdict {
  const verdict = verifyEnvelope(signed, opts);
  if (!verdict.valid) {
    return { valid: false, reason: verdict.reason };
  }
  const payload = verdict.envelope.payload;
  if (!isTaskEnvelopePayload(payload)) {
    return { valid: false, reason: "malformed" };
  }
  return {
    valid: true,
    taskId: payload.taskId,
    kind: payload.kind,
    data: payload.data,
    envelope: verdict.envelope,
  };
}

// ---------------------------------------------------------------------------
// GithubA2aHub
// ---------------------------------------------------------------------------

interface RequestCall {
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

/**
 * GitHub A2A 任务中枢：任务派发 / 交付审查 / 载荷落盘的数据与任务面。
 * 实现 host.TransportPort 形态的门面（asTransport()），入站透传不验签
 * （验签归端点，对齐 remote-relay 分层），出站只负责持久化信封资产。
 */
export class GithubA2aHub implements GithubA2aPort {
  readonly #fetchImpl: FetchLike;
  readonly #owner: string;
  readonly #repo: string;
  readonly #token: GithubToken;
  readonly #baseBranch: string;
  readonly #apiBase: string;
  readonly #clock: () => number;
  readonly #logs: string[] = [];
  readonly #mergeDecisions: MergeDecision[] = [];
  readonly #inboundCbs: ((raw: unknown) => void)[] = [];

  constructor(options: GithubA2aHubOptions) {
    if (typeof options.fetchImpl !== "function") {
      throw new RangeError("GithubA2aHub: options.fetchImpl 必填（注入 fetch 实现）");
    }
    if (typeof options.owner !== "string" || options.owner.length === 0) {
      throw new RangeError("GithubA2aHub: options.owner 必填");
    }
    if (typeof options.repo !== "string" || options.repo.length === 0) {
      throw new RangeError("GithubA2aHub: options.repo 必填");
    }
    if (typeof options.token !== "string" || options.token.length === 0) {
      throw new RangeError("GithubA2aHub: options.token 必须是经 githubToken() 标记的非空字符串");
    }
    this.#fetchImpl = options.fetchImpl;
    this.#owner = options.owner;
    this.#repo = options.repo;
    this.#token = options.token;
    this.#baseBranch = options.baseBranch ?? "main";
    const apiBase = options.apiBase ?? DEFAULT_API_BASE;
    this.#apiBase = apiBase.endsWith("/") ? apiBase.slice(0, -1) : apiBase;
    this.#clock = options.clock ?? Date.now;
  }

  // -------------------------------------------------------------------------
  // 观测面（测试与运维；全量已脱敏）
  // -------------------------------------------------------------------------

  /** 结构化日志环（method+path+status；不含请求头/请求体；token 片段已 ***）。 */
  logs(): string[] {
    return [...this.#logs];
  }

  /** 合并决策审计环（RULE-BI-05）。 */
  mergeDecisions(): readonly MergeDecision[] {
    return [...this.#mergeDecisions];
  }

  #log(line: string): void {
    const safe = this.#redact(line);
    if (this.#logs.length >= MAX_LOG_LINES) this.#logs.shift();
    this.#logs.push(safe);
  }

  #redact(text: string): string {
    return text.split(this.#token).join("***");
  }

  // -------------------------------------------------------------------------
  // REST 直呼内核
  // -------------------------------------------------------------------------

  async #request(method: "GET" | "POST" | "PUT", req: RequestCall): Promise<Response> {
    const url = new URL(
      `${this.#apiBase}/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repo)}/${req.path}`,
    );
    for (const [key, value] of Object.entries(req.query ?? {})) {
      url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": API_VERSION,
      Authorization: `Bearer ${this.#token}`,
    };
    const init: RequestInit = { method, headers };
    if (req.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(req.body);
    }
    let res: Response;
    try {
      res = await this.#fetchImpl(url.toString(), init);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.#log(`github ${method} ${url.pathname} -> network-error ${reason}`);
      throw new GithubA2aError("network", `${method} ${url.pathname} 传输失败: ${reason}`);
    }
    this.#log(`github ${method} ${url.pathname} -> ${res.status}`);
    if (!res.ok) {
      throw await this.#mapHttpError(method, url.pathname, res);
    }
    return res;
  }

  async #mapHttpError(method: string, path: string, res: Response): Promise<GithubA2aError> {
    const status = res.status;
    let detail = "";
    try {
      const text = await res.text();
      try {
        const parsed = JSON.parse(text) as { message?: unknown };
        if (typeof parsed.message === "string") detail = parsed.message;
      } catch {
        detail = text.slice(0, 200);
      }
    } catch {
      // 响应体读取失败：detail 保持空
    }
    const code = classifyStatus(status, res.headers.get("x-ratelimit-remaining"));
    this.#log(`github-error ${method} ${path} -> ${status} code=${code}`);
    return new GithubA2aError(
      code,
      `${method} ${path} → ${status}${detail.length > 0 ? `: ${this.#redact(detail)}` : ""}`,
      status,
    );
  }

  async #readJson<T>(res: Response, what: string): Promise<T> {
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new GithubA2aError("network", `${what} 响应体读取失败`, res.status);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GithubA2aError("network", `${what} 响应体不是合法 JSON`, res.status);
    }
  }

  /**
   * contents API SHA 流程：GET 查存在（404 = 新建）→ PUT（无 sha = create 201；
   * 携带 sha = update 200，即 PATCH 语义）。
   */
  async #putContents(path: string, branch: string, text: string, message: string): Promise<ContentWriteResult> {
    let sha: string | undefined;
    try {
      const existing = await this.#request("GET", {
        path: `contents/${path}`,
        query: { ref: branch },
      });
      const info = await this.#readJson<ContentInfoResponse>(existing, "contents GET");
      if (typeof info.sha === "string" && info.sha.length > 0) {
        sha = info.sha;
      } else {
        throw new GithubA2aError("network", "contents GET 响应缺少 sha", existing.status);
      }
    } catch (error) {
      if (!(error instanceof GithubA2aError) || error.code !== "not_found") {
        throw error;
      }
    }
    const body: Record<string, unknown> = {
      message,
      content: Buffer.from(text, "utf8").toString("base64"),
      branch,
    };
    if (sha !== undefined) {
      body.sha = sha;
    }
    const res = await this.#request("PUT", { path: `contents/${path}`, body });
    return { path, created: res.status === 201 };
  }

  // -------------------------------------------------------------------------
  // 任务派发
  // -------------------------------------------------------------------------

  /** 派发任务：创建 bi-task-<taskId> 分支（从 base）+ 写 spec.json（SHA 幂等流程）。 */
  async dispatchTask(taskId: string, spec: TaskSpec): Promise<ContentWriteResult & { branch: string }> {
    assertTaskId(taskId);
    const branch = taskBranchOf(taskId);
    // 1. 解析 base sha（从 main 创建的前置）
    const refRes = await this.#request("GET", {
      path: `git/ref/heads/${encodeURIComponent(this.#baseBranch)}`,
    });
    const ref = await this.#readJson<GitRefResponse>(refRes, "base ref");
    const baseSha = ref.object?.sha;
    if (typeof baseSha !== "string" || baseSha.length === 0) {
      throw new GithubA2aError("network", "base ref 响应缺少 object.sha", refRes.status);
    }
    // 2. 创建任务分支（octokit git.createRef 语义；422 = 分支已存在 → conflict）
    await this.#request("POST", {
      path: "git/refs",
      body: { ref: `refs/heads/${branch}`, sha: baseSha },
    });
    // 3. spec.json 落盘（GET 查存在 → PUT/PATCH）
    const written = await this.#putContents(
      taskSpecPath(taskId),
      branch,
      encodeTaskJson(spec),
      `bi-a2a: dispatch task ${taskId} (spec)`,
    );
    return { branch, path: written.path, created: written.created };
  }

  // -------------------------------------------------------------------------
  // 交付与审查
  // -------------------------------------------------------------------------

  /** 开启交付 PR：head=bi-task-<taskId> base=<base>。 */
  async openPr(taskId: string, input: OpenPrInput): Promise<PrRef> {
    assertTaskId(taskId);
    const res = await this.#request("POST", {
      path: "pulls",
      body: { title: input.title, head: taskBranchOf(taskId), base: this.#baseBranch, body: input.body },
    });
    const json = await this.#readJson<PullResponse>(res, "openPr");
    return toPrRef(json, taskId);
  }

  /** 列出任务中枢视角的开放 PR（只含 head 为 bi-task-* 的 PR；Link rel=next 分页）。 */
  async listOpenPrs(): Promise<PrRef[]> {
    const out: PrRef[] = [];
    let page = 1;
    for (;;) {
      const res = await this.#request("GET", {
        path: "pulls",
        query: { state: "open", per_page: String(PER_PAGE), page: String(page) },
      });
      const items = await this.#readJson<PullResponse[]>(res, "listOpenPrs");
      if (!Array.isArray(items)) {
        throw new GithubA2aError("network", "listOpenPrs 响应不是数组", res.status);
      }
      for (const item of items) {
        const headRef = typeof item.head?.ref === "string" ? item.head.ref : "";
        if (!headRef.startsWith(TASK_BRANCH_PREFIX)) continue;
        out.push(toPrRef(item, headRef.slice(TASK_BRANCH_PREFIX.length)));
      }
      if (!linkHasNext(res) || items.length === 0 || page >= MAX_PAGES) break;
      page += 1;
    }
    return out;
  }

  /**
   * 合并 PR —— merge gate：必须注入非空 approvedBy（人类审查语义 RULE-BI-05），
   * 否则本地 RangeError 拒绝、零网络调用。决策落审计环。
   */
  async mergePr(prNumber: number, approvedBy: string): Promise<{ merged: boolean; sha: string }> {
    const reviewer = assertApprovedBy(approvedBy);
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
      throw new RangeError(`mergePr 拒绝：prNumber 非法（须为正整数）：${String(prNumber)}`);
    }
    const res = await this.#request("PUT", {
      path: `pulls/${prNumber}/merge`,
      body: { merge_method: "merge" },
    });
    const json = await this.#readJson<MergeResponse>(res, "mergePr");
    const merged = json.merged === true;
    const sha = typeof json.sha === "string" ? json.sha : "";
    this.#mergeDecisions.push({ prNumber, approvedBy: reviewer, merged, sha, ts: this.#clock() });
    return { merged, sha };
  }

  // -------------------------------------------------------------------------
  // 载荷面
  // -------------------------------------------------------------------------

  /** 落盘任务结果：bi-tasks/<taskId>/result.json（GET 查存在 → PUT/PATCH）。 */
  async postResult(taskId: string, result: TaskResult): Promise<ContentWriteResult> {
    assertTaskId(taskId);
    return this.#putContents(
      taskResultPath(taskId),
      this.#baseBranch,
      encodeTaskJson(result),
      `bi-a2a: result for task ${taskId}`,
    );
  }

  // -------------------------------------------------------------------------
  // host.TransportPort 形态门面（传输无关三方法端口）
  // -------------------------------------------------------------------------

  /**
   * 导出 host 双总线传输端口形态的门面：
   * - send(signed)：出站信封持久化到仓库（payload.taskId → bi-tasks/<id>/envelope.json；
   *   缺 taskId 回退 bi-a2a/messages/<nonce>.json）；失败抛错（host 审计 send-failed）。
   * - onMessage(cb)：入站订阅；由 pollResult 驱动（透传不验签，验签归端点）。
   */
  asTransport(): TransportPort {
    const self = this;
    return {
      name: "github-a2a-hub",
      send(signed: SignedEnvelope): void | Promise<void> {
        return self.publishEnvelope(signed);
      },
      onMessage(cb: (raw: unknown) => void): void {
        self.#inboundCbs.push(cb);
      },
    };
  }

  /** 出站信封落盘（send 的实现体）。 */
  async publishEnvelope(signed: SignedEnvelope): Promise<void> {
    const payload = (signed as { payload?: unknown }).payload;
    const candidate =
      typeof payload === "object" && payload !== null
        ? (payload as { taskId?: unknown }).taskId
        : undefined;
    let path: string;
    if (typeof candidate === "string") {
      assertTaskId(candidate);
      path = `${TASKS_DIR}/${candidate}/envelope.json`;
    } else {
      const nonce = typeof (signed as { nonce?: unknown }).nonce === "string"
        ? (signed as { nonce: string }).nonce
        : "unknown";
      path = `bi-a2a/messages/${nonce.replace(/[^A-Za-z0-9._-]/g, "-")}.json`;
    }
    await this.#putContents(
      path,
      this.#baseBranch,
      JSON.stringify(signed),
      `bi-a2a: envelope ${path}`,
    );
  }

  /**
   * 入站驱动：GET bi-tasks/<taskId>/result.json（base 分支），base64 解码后 JSON 解析，
   * 透传给全部 onMessage 订阅者（不做验签——验签归端点）。返回 true = 已投递。
   */
  async pollResult(taskId: string): Promise<boolean> {
    assertTaskId(taskId);
    const res = await this.#request("GET", {
      path: `contents/${taskResultPath(taskId)}`,
      query: { ref: this.#baseBranch },
    });
    const info = await this.#readJson<ContentInfoResponse>(res, "pollResult");
    if (typeof info.content !== "string") {
      throw new GithubA2aError("network", "pollResult 响应缺少 content", res.status);
    }
    let raw: unknown;
    try {
      const text = Buffer.from(info.content.replace(/\n/g, ""), "base64").toString("utf8");
      raw = JSON.parse(text) as unknown;
    } catch {
      throw new GithubA2aError("network", "pollResult 内容不是合法 JSON", res.status);
    }
    for (const cb of this.#inboundCbs) {
      cb(raw);
    }
    return true;
  }
}

export default GithubA2aHub;
