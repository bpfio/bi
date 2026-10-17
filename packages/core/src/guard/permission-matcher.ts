/**
 * BI-06.5 · 权限规则解析与匹配器（纯函数，零 IO）。
 *
 * 规则形态：`Tool(pattern)`，pattern 为 picomatch 语法（括号内可含任意
 * picomatch 语法，含 extglob 等带括号的写法）；无括号 = 整工具匹配。
 * 匹配语义：工具名精确匹配 + picomatch(pattern)(argSummary)；
 * pattern "*" 或空串 = 该工具全匹配（含空参数串，显式短路，见 matchRule）。
 * evaluateRules 按配置顺序取首个命中（first-hit-wins），调用方据此决定
 * 放行 / 拦截 / 询问。
 */
import picomatch from "picomatch";
import type { ParseError, PermissionAction, PermissionRequest, PermissionRule, PermissionScope } from "./types";

/** 全匹配 pattern 规范形态（parseRule 将空 pattern / 无括号规则归一化到它）。 */
const WILDCARD = "*";

/** 门禁匹配统一启用的 picomatch 选项。 */
const MATCH_OPTIONS = { dot: true } as const;

/**
 * dot 裁定：权限引擎统一启用 dot:true，让 `*` 与 `**` 也命中点开头的
 * 路径段（如 `.hidden.ts`、`src/.env/config`）。理由：权限匹配宁可多命中
 * 多拦截多询问（fail-closed），不可因 dotfile 语义漏配 deny 规则。
 */

/** 工具名合法字符：字母数字与 _.:-（覆盖 Bash、Read、mcp__server__tool、tool.v2 等形态）。 */
const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]+$/;

/** parseRule 的动作/作用域缺省值容器。 */
export interface ParseDefaults {
  /** 缺省动作，缺省 "allow"（配置 deny 节应显式传 "deny"）。 */
  readonly action?: PermissionAction;
  /** 缺省生命周期，缺省 "always"（parseRule 面向配置态规则；会话记忆走 remember，不经此处）。 */
  readonly scope?: PermissionScope;
}

/**
 * 解析 `Tool(pattern)` 形态的规则原文为 PermissionRule。
 *
 * 语法与归一化规则：
 * - 无括号（如 `"Bash"`）= 整工具匹配，pattern 归一化为 "*"；
 * - 空括号（如 `"Bash()"`）= 该工具全匹配，pattern 归一化为 "*"；
 * - 括号内可含任意 picomatch 语法（含 extglob 的嵌套括号），取首个 "("
 *   与最后一个 ")" 之间的内容；pattern 首尾空白 trim（命令 padding 视为
 *   笔误），中间空白原样保留（`git *` 的空格是语义的一部分）；
 * - 最后一个 ")" 之后存在非空白尾随内容（如 `"Bash(git *) junk"`）视为
 *   形态非法；
 * - 工具名须匹配 /^[A-Za-z0-9_.:-]+$/，否则 bad_tool。
 *
 * @returns 合法时返回 PermissionRule（无 ok 字段）；非法时返回 ParseError
 * （恒 ok:false）。判别用 `"ok" in result` 收窄。
 */
export function parseRule(raw: string, defaults: ParseDefaults = {}): PermissionRule | ParseError {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, code: "empty", message: "权限规则为空字符串" };
  }

  const open = trimmed.indexOf("(");
  if (open === -1) {
    // 无括号 = 整工具匹配。
    if (!TOOL_NAME_RE.test(trimmed)) {
      return { ok: false, code: "bad_tool", message: `工具名非法: ${JSON.stringify(trimmed)}` };
    }
    return {
      tool: trimmed,
      pattern: WILDCARD,
      action: defaults.action ?? "allow",
      scope: defaults.scope ?? "always",
    };
  }

  // 有 "("：必须存在位于其后的 ")"，且 ")" 之后不得有非空白尾随内容。
  const close = trimmed.lastIndexOf(")");
  if (close < open) {
    return {
      ok: false,
      code: "bad_form",
      message: `规则缺少与 "(" 配对的 ")": ${JSON.stringify(raw)}`,
    };
  }
  if (trimmed.slice(close + 1).trim() !== "") {
    return {
      ok: false,
      code: "bad_form",
      message: `规则在 ")" 之后存在尾随内容: ${JSON.stringify(raw)}`,
    };
  }

  const tool = trimmed.slice(0, open).trim();
  if (tool === "" || !TOOL_NAME_RE.test(tool)) {
    return { ok: false, code: "bad_tool", message: `工具名非法: ${JSON.stringify(tool)}` };
  }

  const pattern = trimmed.slice(open + 1, close).trim();
  return {
    tool,
    pattern: pattern === "" ? WILDCARD : pattern,
    action: defaults.action ?? "allow",
    scope: defaults.scope ?? "always",
  };
}

/**
 * 判定单条规则是否命中请求：工具名精确匹配（大小写敏感）+ 参数串模式匹配。
 *
 * 全匹配短路：pattern 为 "*" 或空串时直接返回 true（含空参数串）——
 * picomatch 自身对 `picomatch("*")("")` 返回 false，故必须在此显式短路，
 * 不能依赖 picomatch 语义。
 */
export function matchRule(rule: PermissionRule, req: PermissionRequest): boolean {
  if (rule.tool !== req.tool) return false;
  if (rule.pattern === WILDCARD || rule.pattern === "") return true;
  return picomatch(rule.pattern, MATCH_OPTIONS)(req.argSummary);
}

/**
 * 按配置顺序评估规则表，返回首个命中的规则（first-hit-wins）；
 * 无命中返回 undefined。调用方据命中规则的 action 决定放行/拦截，
 * 据是否命中决定是否落到三态默认。
 */
export function evaluateRules(
  rules: readonly PermissionRule[],
  req: PermissionRequest,
): PermissionRule | undefined {
  for (const rule of rules) {
    if (matchRule(rule, req)) return rule;
  }
  return undefined;
}
