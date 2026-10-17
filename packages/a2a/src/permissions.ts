/**
 * BI-15.3 · A2A 角色能力矩阵与高危动作分类 —— L3 授权面。
 *
 * deny-by-default：能力必须显式列入矩阵才放行，矩阵之外一律拒绝
 * （拒绝也必须有稳定 reason，可编程判断）。
 *
 * 三层模型中本模块是最内层授权面，与 L2 封套验签（./auth.ts）、
 * L1 传输鉴权（BI-15.1 邮件网关 / BI-15.2 GitHub 中枢）正交叠加：
 * 一条 A2A 请求要被执行，须同时通过 L1 通道鉴权、L2 五步验签与
 * L3 能力矩阵断言；高危动作再叠加人类在环审查（classifyHighRisk）。
 *
 * 角色语义（对齐 BI-15 四角色）：
 * - coordinator：编排者，全能力（唯一可 delegate）；
 * - scout：外部抓取角色，只许 read + network，禁写；
 * - auditor：精算角色，execute 仅限沙箱语义，禁 network（数据一律经 Blackboard 投递）；
 * - reporter：起草角色，write 仅限交付产物目录，路径约束归上层宿主。
 */

export type A2aRole = "coordinator" | "scout" | "auditor" | "reporter";

export type Capability = "read" | "write" | "execute" | "network" | "delegate";

/** 角色全集（供矩阵全表遍历与传输层入参校验）。 */
export const A2A_ROLES: readonly A2aRole[] = ["coordinator", "scout", "auditor", "reporter"];

/** 能力全集（供矩阵全表遍历与传输层入参校验）。 */
export const CAPABILITIES: readonly Capability[] = [
  "read",
  "write",
  "execute",
  "network",
  "delegate",
];

export function isA2aRole(value: string): value is A2aRole {
  return (A2A_ROLES as readonly string[]).includes(value);
}

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

/**
 * 角色能力矩阵（授权白名单常量表，deny-by-default —— 未列出的能力一律拒绝）：
 *
 * - coordinator：read / write / execute / network / delegate 全量。
 *   编排者负责拆解与委派，delegate 仅此一家（防子角色自我繁殖）。
 * - scout：read + network。
 *   外部抓取角色，**禁写**（write 拒绝）——严禁改动代码与交付产物；
 *   禁 execute（不运行任何生成代码）、禁 delegate（不许再派生子任务）。
 * - auditor：read + execute。
 *   精算角色；execute 仅为**沙箱语义**——唯一接入点是 BI-16 Python 沙箱
 *   （packages/a2a/src/audit.ts）与 BI-16.1 CodeMode 内存沙箱
 *   （packages/a2a/src/codemode/），宿主必须在沙箱边界内执行，矩阵只声明能力面；
 *   **禁 network**（精算数据一律经 Blackboard 投递，不许自行外联防窃密）、
 *   禁 write、禁 delegate。
 * - reporter：read + write。
 *   起草角色；write 仅限**交付产物目录**——具体路径白名单与目录约束
 *   归上层宿主判定（本矩阵只声明能力面，不做路径级判定）；
 *   禁 execute、禁 network、禁 delegate。
 */
export const ROLE_CAPABILITIES: Readonly<Record<A2aRole, ReadonlySet<Capability>>> = {
  coordinator: new Set<Capability>(["read", "write", "execute", "network", "delegate"]),
  scout: new Set<Capability>(["read", "network"]),
  auditor: new Set<Capability>(["read", "execute"]),
  reporter: new Set<Capability>(["read", "write"]),
};

/** 能力断言结果：ok=false 时携带稳定 reason。 */
export interface CapabilityCheck {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * 能力断言（deny-by-default）。
 * reason 稳定可测：
 * - "unknown-role"：角色不在 A2A_ROLES 内；
 * - "unknown-capability"：能力不在 CAPABILITIES 内；
 * - "denied-by-matrix"：角色合法但该能力未列入矩阵（默认拒绝）。
 */
export function assertCapability(role: string, capability: string): CapabilityCheck {
  if (!isA2aRole(role)) {
    return { ok: false, reason: "unknown-role" };
  }
  if (!isCapability(capability)) {
    return { ok: false, reason: "unknown-capability" };
  }
  if (!ROLE_CAPABILITIES[role].has(capability)) {
    return { ok: false, reason: "denied-by-matrix" };
  }
  return { ok: true };
}

/** 角色能力投影视图（只读快照）。未知角色返回空数组（deny-by-default）。 */
export function capabilitiesOf(role: string): readonly Capability[] {
  return isA2aRole(role) ? [...ROLE_CAPABILITIES[role]] : [];
}

// ---------------------------------------------------------------------------
// 高危动作分类（人类在环决策）
// ---------------------------------------------------------------------------

/** 高危分类输入：kind 为动作类别词（建议小写「动词-宾语」式，如 "code-edit"），target 为可选对象描述。 */
export interface HighRiskAction {
  readonly kind: string;
  readonly target?: string;
}

/** 高危分类决策：humanReview=true 时携带稳定 reason。 */
export interface HighRiskVerdict {
  readonly humanReview: boolean;
  readonly reason?: string;
}

/** 修改代码类动作 kind（含裸动词兜底）。 */
const CODE_MODIFICATION_KINDS: ReadonlySet<string> = new Set([
  "code-edit",
  "code-write",
  "code-patch",
  "file-write",
  "file-edit",
  "file-patch",
  "edit",
  "write",
  "patch",
  "modify",
]);

/** 直接判定高危的破坏类 kind（不依赖 target）。 */
const DESTRUCTIVE_DIRECT_KINDS: ReadonlySet<string> = new Set([
  "rm",
  "kill",
  "pkill",
  "killall",
  "kill-process",
  "delete-file",
  "force-delete",
]);

/** 壳执行类 kind：命中破坏性命令特征才判高危（如 `ls` 不判）。 */
const SHELL_EXEC_KINDS: ReadonlySet<string> = new Set([
  "shell",
  "shell-exec",
  "bash",
  "sh",
  "exec",
  "command",
  "run-command",
]);

/** 破坏性命令特征（rm/kill 为工单点名词，其余为常规致命命令兜底）。 */
const DESTRUCTIVE_TARGET_RE = /\b(?:rm|kill|pkill|killall|mkfs|dd|shutdown|reboot)\b/i;

/** 合并/推送类 kind：目标为主干分支时判高危。 */
const MERGE_KINDS: ReadonlySet<string> = new Set([
  "git-merge",
  "merge",
  "pr-merge",
  "git-push",
  "push",
  "git-rebase",
  "rebase",
]);

/** 主干分支特征：匹配分支名末段（容忍 origin/ 与 refs/heads/ 前缀）。 */
const MAINLINE_BRANCH_RE = /(?:^|\/)(?:main|master|trunk)\/?$/i;

/** 直接判定高危的凭据访问 kind。 */
const CREDENTIAL_KINDS: ReadonlySet<string> = new Set([
  "credential-read",
  "credential-write",
  "credential-access",
  "credential-list",
  "secret-read",
  "secret-write",
  "secret-access",
  "api-key-read",
]);

/**
 * 凭据路径特征：
 * - 隐藏凭据目录/文件：.ssh / .aws / .gnupg / .gpg / .kube / .docker / .netrc / .env / .bi
 *   （.bi 为本机三级配置目录，含 provider api_key，见 BI-01.1）；
 * - 私钥文件：id_rsa / id_ed25519 / id_ecdsa；
 * - 凭据文件名：credentials(.json)。
 */
const CREDENTIAL_TARGET_PATTERNS: readonly RegExp[] = [
  // 尾段容许 ./- 续接，覆盖 .env.local / .env.production 等变体（.environment 不误伤）。
  /(?:^|[/\\])\.(?:ssh|aws|gnupg|gpg|kube|docker|netrc|env|bi)(?:$|[/\\.-])/i,
  /(?:^|[/\\])id_(?:rsa|ed25519|ecdsa)(?:$|\.)/i,
  /(?:^|[/\\])\.netrc$/i,
  /(?:^|[/\\])credentials?(?:$|[/\\.])/i,
];

interface HighRiskRule {
  readonly reason: string;
  readonly match: (kind: string, target: string | undefined) => boolean;
}

/**
 * 高危规则表（固定顺序，首个命中即定 reason —— 决策稳定可测）。
 * 对齐 RULE-BI-05 高危动作人类在环；**实际弹窗与 Unified Diff 审查门归 BI-20**，
 * 本函数只产出决策（humanReview + reason），不执行任何门禁。
 */
const HIGH_RISK_RULES: readonly HighRiskRule[] = [
  {
    reason: "code-modification",
    match: (kind) => CODE_MODIFICATION_KINDS.has(kind),
  },
  {
    reason: "merge-to-mainline",
    match: (kind, target) =>
      MERGE_KINDS.has(kind) && target !== undefined && MAINLINE_BRANCH_RE.test(target.trim()),
  },
  {
    reason: "destructive-command",
    match: (kind, target) =>
      DESTRUCTIVE_DIRECT_KINDS.has(kind) ||
      (SHELL_EXEC_KINDS.has(kind) &&
        target !== undefined &&
        DESTRUCTIVE_TARGET_RE.test(target)),
  },
  {
    reason: "credential-path-access",
    match: (kind, target) =>
      CREDENTIAL_KINDS.has(kind) ||
      (target !== undefined &&
        CREDENTIAL_TARGET_PATTERNS.some((pattern) => pattern.test(target))),
  },
];

/**
 * 高危动作分类：修改代码 / 合并主分支 / rm / kill / 凭据路径访问 → humanReview: true。
 *
 * - kind 大小写不敏感（内部统一小写化）；target 原样参与正则匹配；
 * - 未命中任何高危规则的动作为 humanReview: false（风险门是增量叠加，
 *   不替代 L3 能力矩阵——无能力的角色即使动作良性也放不过 assertCapability）。
 */
export function classifyHighRisk(action: HighRiskAction): HighRiskVerdict {
  const kind = typeof action.kind === "string" ? action.kind.toLowerCase() : "";
  const target = typeof action.target === "string" ? action.target : undefined;
  for (const rule of HIGH_RISK_RULES) {
    if (rule.match(kind, target)) {
      return { humanReview: true, reason: rule.reason };
    }
  }
  return { humanReview: false };
}
