/**
 * BI-28.3 · 权限模式产品化 —— 会话级权限控制器（模式切换 + "始终允许"授权记忆）。
 *
 * 职责边界：PermissionGate（guard/permission-gate.ts）是纯决策引擎（会话记忆 →
 * 静态规则 → 三态默认）；本模块是产品面装配——把 gate 的 setMode / remember /
 * clearRemembered / remembered 包成会话级控制器，供斜杠命令
 * （commands/permissions-command.ts）与装配层共用同一实例（工具执行回路走
 * controller.gate.check，命令面走 switchMode/grantAlways，两端共享会话记忆）。
 *
 * 模式切换与会话记忆的关系（裁定，BI-28.3 工单"decide sensibly"项）：
 * switchMode 不清空会话授权。会话记忆是用户对本条参数串的显式裁决
 * （"本会话始终允许/始终拒绝"），语义强于三态默认——manual 回切后未被记忆
 * 覆盖的操作照旧 ask，记忆放行是用户明示意愿的延续，不构成失守；一次性
 * 收回走 revokeGrant / clearGrants（/permissions revoke|clear）。
 *
 * 安全边界：本模块零决策逻辑零 IO；yolo/auto 只改变 ask 门行为，PathJail/
 * shell-scan 器官照常运行（器官在工具绑定层，门禁在装配层，两层互不取代）。
 * 默认模式 manual（最安全缺省，BI-28.3 默认不变）。
 */
import { PermissionGate, type SessionApprovalEntry } from "../guard/permission-gate";
import type { PermissionsPorts } from "./commands/permissions-command";
import type { PermissionDecision, PermissionMode, PermissionRequest } from "../guard/types";

/** 三态模式合法词面（parsePermissionMode 用；其余一律拒绝，不猜别名、不认大写）。 */
const PERMISSION_MODES: readonly PermissionMode[] = ["manual", "auto", "yolo"];

/** 解析用户输入的三态模式词面；非法返回 undefined（调用方结构化报错）。 */
export function parsePermissionMode(text: string): PermissionMode | undefined {
  return (PERMISSION_MODES as readonly string[]).includes(text) ? (text as PermissionMode) : undefined;
}

/**
 * config.toml [permission] mode → 门禁三态映射（BI-28.3 配置面）。
 * config/schema.ts permissionSchema 的词面是 default/plan/yolo，门禁词面是
 * manual/auto/yolo：default（ask 门）→ manual；plan（只读规划档，写语义最
 * 保守）→ manual；yolo 直通；manual/auto 为门禁原生词面直通（env
 * BI_PERMISSION_MODE 前向兼容）。未配置/未知一律 → manual（默认不变）。
 */
export function permissionModeFromConfig(value: string | undefined | null): PermissionMode {
  switch (value) {
    case "yolo":
      return "yolo";
    case "auto":
      return "auto";
    case "manual":
      return "manual";
    case "default":
    case "plan":
      return "manual";
    default:
      return "manual";
  }
}

/** 控制器构造选项（缺省自建 manual 门禁；装配层可注入既有实例）。 */
export interface PermissionSessionControllerOptions {
  /** 注入门禁（装配层与命令面共用既有实例时注入）；缺省新建。 */
  readonly gate?: PermissionGate;
  /** 自建门禁时的初始模式（gate 注入时忽略）；缺省 manual。 */
  readonly mode?: PermissionMode;
  /** 时钟注入（会话记忆 TTL 测试用）。 */
  readonly now?: () => number;
}

/**
 * 会话级权限控制器：模式切换 + "始终允许/始终拒绝"授权记忆的产品面。
 * 授权记忆直接落到 gate 的 SessionApprovalStore（会话级、随实例存活），
 * 后续 check 命中 remembered 自动裁决——这正是"always allow this
 * tool/command for this session"喂给门禁会话记忆层的通道。
 */
export class PermissionSessionController {
  readonly #gate: PermissionGate;

  constructor(options: PermissionSessionControllerOptions = {}) {
    this.#gate =
      options.gate ??
      new PermissionGate({
        ...(options.mode !== undefined ? { mode: options.mode } : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
  }

  /** 底层门禁（装配层工具执行回路的决策入口；与命令面共享同一实例）。 */
  get gate(): PermissionGate {
    return this.#gate;
  }

  /** 当前三态模式。 */
  get mode(): PermissionMode {
    return this.#gate.mode;
  }

  /** 运行期切换三态模式（不清空会话授权，裁定见文件头）。 */
  switchMode(mode: PermissionMode): void {
    this.#gate.setMode(mode);
  }

  /** 记住本会话始终允许（tool + argSummary 定键，参数串按门禁语义归一化）。 */
  grantAlways(tool: string, argSummary: string): void {
    this.#gate.remember({ tool, argSummary }, "allow");
  }

  /** 记住本会话始终拒绝（feedback 原样透传到后续 deny 决策）。 */
  denyAlways(tool: string, argSummary: string, feedback?: string): void {
    this.#gate.remember({ tool, argSummary }, "deny", feedback !== undefined ? { feedback } : {});
  }

  /** 撤销单条会话授权；命中并删除返回 true。 */
  revokeGrant(tool: string, argSummary: string): boolean {
    return this.#gate.revokeRemembered(tool, argSummary);
  }

  /** 清空全部会话授权。 */
  clearGrants(): void {
    this.#gate.clearRemembered();
  }

  /** 会话授权快照（插入序；展示面用）。 */
  grants(): readonly SessionApprovalEntry[] {
    return this.#gate.remembered();
  }

  /** 权限决策（透传门禁三层矩阵：会话记忆 → 静态规则 → 三态默认）。 */
  check(req: PermissionRequest): PermissionDecision {
    return this.#gate.check(req);
  }

  /**
   * PermissionsPorts 投影（BI-28.3 接线缝）：/permissions 命令面的注入面。
   * 控制器的 mode 是属性、端口面约定是方法——此适配是唯一换算点，宿主
   * （bin/TUI 拦截层）一律经 toPorts() 注入，禁止手搓第二个适配。
   */
  toPorts(): PermissionsPorts {
    return {
      mode: () => this.mode,
      setMode: (mode) => this.switchMode(mode),
      grants: () => this.grants(),
      grantAlways: (tool, argSummary) => this.grantAlways(tool, argSummary),
      denyAlways: (tool, argSummary) => this.denyAlways(tool, argSummary),
      revokeGrant: (tool, argSummary) => this.revokeGrant(tool, argSummary),
      clearGrants: () => this.clearGrants(),
    };
  }
}
