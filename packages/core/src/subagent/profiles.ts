/**
 * BI-07.3 · 子智能体声明式角色档案（SubagentProfile 注册表）。
 *
 * 四内建角色（钉死）：
 * - explore：只读禁写，专职文件与代码扫盘（Read/Grep/Glob）；
 * - coder：带写实施专家（只读集 + Bash + Write/Edit）；
 * - plan：只读 + 结构化规划输出纪律（systemAddon 钉死输出形状）；
 * - fork：克隆父级——toolPolicy 留空为占位（运行时由 SubagentRunner 用
 *   父级精确工具集替换），**无 systemAddon**（拼任何字符都会破坏
 *   父级 systemPrompt 的字节级克隆，Prompt Cache 复用即失效）。
 *
 * 防递归危害工具（RECURSION_HAZARD_TOOLS）：子 profile 工具集里凡出现
 * `Agent` / `spawn`（递归派生）或 `AskUserQuestion`（子会话无人应答），
 * 一律由 SubagentRunner 剥离并留审计——彻底根除无限递归派生。
 */

/** 子智能体角色类型（内建四类闭联集）。 */
export type SubagentProfileType = "explore" | "coder" | "plan" | "fork";

/** 声明式角色档案：工具白名单 + 可选 system 附加纪律。 */
export interface SubagentProfile {
  readonly type: SubagentProfileType;
  /** 工具白名单（fork 角色为空数组占位，运行时替换为父级精确工具集）。 */
  readonly toolPolicy: readonly string[];
  /** 追加到子循环 system prompt 的纪律文本（fork 角色必须缺省）。 */
  readonly systemAddon?: string;
}

/** 全部内建角色类型（穷举测试用）。 */
export const SUBAGENT_PROFILE_TYPES: readonly SubagentProfileType[] = [
  "explore",
  "coder",
  "plan",
  "fork",
];

/** 防递归危害工具名单：子工具集出现即剥离 + 审计。 */
export const RECURSION_HAZARD_TOOLS: readonly string[] = ["Agent", "spawn", "AskUserQuestion"];

/** 只读工具集（explore/plan 共用）。 */
const READ_ONLY_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];

/** coder 工具集：只读集 + 执行 + 写。 */
const CODER_TOOLS: readonly string[] = [...READ_ONLY_TOOLS, "Bash", "Write", "Edit"];

const EXPLORE_ADDON =
  "只读探查纪律：专职文件与代码扫盘。禁止写入、编辑或执行任何变更性操作；" +
  "发现以紧凑清单回报，不做实施。";

const CODER_ADDON =
  "实施专家：允许在授权范围内读写与编辑。改动前先读（Read-Before-Write）；" +
  "改动后简报变更点。";

const PLAN_ADDON =
  "高阶规划纪律：只读研判，不做实施。输出必须是结构化规划：" +
  "## 目标 / ## 步骤 / ## 风险 / ## 验收标准。";

/** 内建角色注册表（冻结：运行期不可篡改策略面）。 */
export const SUBAGENT_PROFILES: Readonly<Record<SubagentProfileType, SubagentProfile>> = Object.freeze({
  explore: Object.freeze({
    type: "explore" as const,
    toolPolicy: Object.freeze([...READ_ONLY_TOOLS]),
    systemAddon: EXPLORE_ADDON,
  }),
  coder: Object.freeze({
    type: "coder" as const,
    toolPolicy: Object.freeze([...CODER_TOOLS]),
    systemAddon: CODER_ADDON,
  }),
  plan: Object.freeze({
    type: "plan" as const,
    toolPolicy: Object.freeze([...READ_ONLY_TOOLS]),
    systemAddon: PLAN_ADDON,
  }),
  fork: Object.freeze({
    type: "fork" as const,
    toolPolicy: Object.freeze([]),
  }),
});

/** 按类型取档案（未知类型返回 undefined，由调用方结构化拒绝）。 */
export function getSubagentProfile(type: string): SubagentProfile | undefined {
  return (SUBAGENT_PROFILES as Readonly<Record<string, SubagentProfile | undefined>>)[type];
}
