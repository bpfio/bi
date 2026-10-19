/**
 * BI-28.3 · /permissions 斜杠命令对象 —— 权限模式展示/切换 + 会话授权记忆管理。
 *
 * 形状沿 src/commands/compact.ts 的 GateCommand 惯例（parse → 结构化错误判别
 * 联合，execute → 注入端口，零决策逻辑零 IO）。端口由 cli/permission-mode.ts
 * 的 PermissionSessionController 承载（决策矩阵在 guard/permission-gate.ts）。
 *
 * 语法面：
 *   /permissions                                  展示当前模式 + 会话授权清单
 *   /permissions manual|auto|yolo                 运行期切换三态模式
 *   /permissions grant  <tool> <参数串>           本会话始终允许（喂门禁会话记忆）
 *   /permissions deny   <tool> <参数串> [反馈]    本会话始终拒绝
 *   /permissions revoke <tool> <参数串>           撤销单条会话授权
 *   /permissions clear                            清空全部会话授权
 *
 * 注册进 REPL 斜杠分发表属 TUI/装配层接线（reserved 文件），一行接线备案见
 * BI-28.3 交付报告 OUTSIDE-TERRITORY WIRING。
 */
import type { SessionApprovalEntry } from "../../guard/permission-gate";
import type { PermissionMode } from "../../guard/types";
import { parsePermissionMode } from "../permission-mode";

/** 结构化错误（与 compact.ts CommandError 同风格的判别联合）。 */
export type PermissionsError =
  | { code: "unknown-action"; message: string }
  | { code: "invalid-mode"; message: string }
  | { code: "unexpected-argument"; message: string }
  | { code: "missing-tool"; message: string }
  | { code: "missing-args"; message: string };

export type PermissionsParse<A> = { ok: true; args: A } | { ok: false; error: PermissionsError };

/** 解析产物（判别联合：execute 按 action 穷举，无需非空断言）。 */
export type PermissionsArgs =
  | { action: "show" }
  | { action: "mode"; mode: PermissionMode }
  | { action: "grant" | "deny" | "revoke"; tool: string; argSummary: string }
  | { action: "clear" };

/** 执行端口：PermissionSessionController 的最小投影（测试注入替身用）。 */
export interface PermissionsPorts {
  mode(): PermissionMode;
  setMode(mode: PermissionMode): void;
  grants(): readonly SessionApprovalEntry[];
  grantAlways(tool: string, argSummary: string): void;
  denyAlways(tool: string, argSummary: string): void;
  revokeGrant(tool: string, argSummary: string): boolean;
  clearGrants(): void;
}

/** 用法原文（parse 错误信息内嵌；TUI 补全提示同源）。 */
export const PERMISSIONS_USAGE =
  "/permissions | /permissions <manual|auto|yolo> | /permissions grant|deny|revoke <tool> <参数串> | /permissions clear";

/** /permissions 命令对象：parse（纯语法）+ execute（端口回写 + 展示行产出）。 */
export const permissionsCommand = {
  name: "permissions" as const,
  usage: PERMISSIONS_USAGE,

  parse(raw: string): PermissionsParse<PermissionsArgs> {
    const trimmed = raw.trim();
    if (trimmed === "") return { ok: true, args: { action: "show" } };
    const [head = "", ...rest] = trimmed.split(/\s+/);
    switch (head) {
      case "show":
        return rest.length > 0
          ? { ok: false, error: { code: "unexpected-argument", message: `show 不接受参数（用法: /permissions）` } }
          : { ok: true, args: { action: "show" } };
      case "clear":
        return rest.length > 0
          ? { ok: false, error: { code: "unexpected-argument", message: `clear 不接受参数（用法: /permissions clear）` } }
          : { ok: true, args: { action: "clear" } };
      case "manual":
      case "auto":
      case "yolo": {
        // head 命中三态词面即合法模式（parsePermissionMode 对同词面恒通过）。
        const mode = parsePermissionMode(head);
        if (mode === undefined || rest.length > 0) {
          return { ok: false, error: { code: "unexpected-argument", message: `模式切换不接受参数（用法: /permissions ${head}）` } };
        }
        return { ok: true, args: { action: "mode", mode } };
      }
      case "grant":
      case "deny":
      case "revoke": {
        const tool = rest[0];
        if (tool === undefined || tool === "") {
          return { ok: false, error: { code: "missing-tool", message: `用法: /permissions ${head} <tool> <参数串>` } };
        }
        const argSummary = rest.slice(1).join(" ");
        if (argSummary === "") {
          // 空参数串 = 该工具全量放行/拒绝，过宽故拒绝解析（fail-closed）。
          return { ok: false, error: { code: "missing-args", message: `用法: /permissions ${head} <tool> <参数串>（参数串不可为空）` } };
        }
        return { ok: true, args: { action: head, tool, argSummary } };
      }
      default:
        return { ok: false, error: { code: "unknown-action", message: `未知子命令: ${head}（${PERMISSIONS_USAGE}）` } };
    }
  },

  /** 执行：回写端口 + 产出展示行（TUI 逐行上屏；测试逐行断言）。 */
  execute(args: PermissionsArgs, ports: PermissionsPorts): string[] {
    switch (args.action) {
      case "show":
        return showLines(ports);
      case "mode": {
        const before = ports.mode();
        ports.setMode(args.mode);
        return [`权限模式: ${before} → ${args.mode}`];
      }
      case "grant": {
        ports.grantAlways(args.tool, args.argSummary);
        return [`已记住（本会话）始终允许: ${args.tool} ${args.argSummary}`];
      }
      case "deny": {
        ports.denyAlways(args.tool, args.argSummary);
        return [`已记住（本会话）始终拒绝: ${args.tool} ${args.argSummary}`];
      }
      case "revoke": {
        const removed = ports.revokeGrant(args.tool, args.argSummary);
        return [
          removed
            ? `已撤销会话授权: ${args.tool} ${args.argSummary}`
            : `未找到会话授权: ${args.tool} ${args.argSummary}`,
        ];
      }
      case "clear": {
        const count = ports.grants().length;
        ports.clearGrants();
        return [`已清空会话授权（${count} 条）`];
      }
    }
  },
};

/** show 输出：模式行（带三态语义注记）+ 授权计数 + 逐条清单（+ allow / - deny）。 */
function showLines(ports: PermissionsPorts): string[] {
  const lines = [
    `权限模式: ${ports.mode()}（manual=逐项询问 auto=自动放行+审计标记 yolo=自动放行）`,
    `会话授权: ${ports.grants().length} 条`,
  ];
  for (const entry of ports.grants()) {
    lines.push(`  ${entry.decision === "allow" ? "+" : "-"} ${entry.tool} ${entry.pattern}`);
  }
  return lines;
}
