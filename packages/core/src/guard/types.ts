/**
 * BI-06.5 · 模式级工具权限匹配器与三态授权门禁 —— 类型定义。
 *
 * 本模块是纯决策引擎的数据面（零 IO、零 TUI）：
 * - PermissionRule：picomatch 语法的权限规则，形态 `Tool(pattern)`
 *   （如 `Read(*.ts)`、`Bash(git *)`、`Write(src/**)`、`Bash(rm -rf *)`）；
 * - PermissionMode：manual / yolo / auto 三态运行模式；
 * - PermissionRequest / PermissionDecision：门禁 check 的输入与输出。
 *
 * 语义裁定（钉死，供上层与审计复核）见 permission-gate.ts 类注释。
 */

/** 规则动作：放行或拒绝。 */
export type PermissionAction = "allow" | "deny";

/**
 * 规则生命周期标注：
 * - "always"：跨会话持久偏好（配置态规则缺省值；落盘交由持久层）；
 * - "session"：仅当前会话有效。
 * 纯内存引擎内两种 scope 的规则同效（均在实例存活期参与 evaluateRules），
 * 差异语义（是否持久化）由调用方/持久层解读，引擎不据此分支。
 */
export type PermissionScope = "always" | "session";

/** 单条工具权限规则：工具名 + picomatch 参数模式 + 动作 + 生命周期。 */
export interface PermissionRule {
  /** 工具名，精确匹配（大小写敏感），如 "Bash"、"Read"、"mcp__fs__read_file"。 */
  readonly tool: string;
  /** picomatch 模式；"*" 或空串表示该工具全匹配（含空参数串）。 */
  readonly pattern: string;
  /** 命中后的动作。 */
  readonly action: PermissionAction;
  /** 规则生命周期标注。 */
  readonly scope: PermissionScope;
}

/** 三态运行权限模式（devplan BI-06.5 原义）。 */
export type PermissionMode = "manual" | "yolo" | "auto";

/** 门禁裁决类型：放行 / 询问人类 / 拒绝。 */
export type PermissionDecisionType = "allow" | "ask" | "deny";

/** 权限检查请求。 */
export interface PermissionRequest {
  /** 工具名（与规则的 tool 精确比对）。 */
  readonly tool: string;
  /**
   * 用于模式匹配的参数串（如完整命令行、目标文件路径）。
   * 会话记忆键取本串经 normalizeArgSummary 归一化后的值。
   */
  readonly argSummary: string;
  /**
   * 请求方随请求透传的三态模式快照（供上层审计/展示）。
   * 注意：本字段不参与决策——门禁运行态 mode（构造注入 + setMode）是唯一
   * 权威模式源，防止调用侧在请求上私盖 mode 自我提权绕过 manual 门禁。
   */
  readonly mode: PermissionMode;
}

/** 门禁裁决结果。 */
export interface PermissionDecision {
  /** 裁决：allow 放行 / ask 询问人类 / deny 拒绝。 */
  readonly decision: PermissionDecisionType;
  /** 命中的静态规则（仅规则命中时携带；记忆命中与三态默认不携带）。 */
  readonly matchedRule?: PermissionRule;
  /**
   * 拒绝反馈：用户拒绝（deny/ask 场景）时输入的意见原样透传，
   * 供 agent 回注模型动态调整策略。来源：remember(req, "deny", feedback)。
   */
  readonly feedback?: string;
  /** 会话记忆命中标记（决策来自 remember 存储的既有裁决时为 true）。 */
  readonly remembered?: boolean;
  /**
   * auto 态默认放行标记（BI-06.5 语义裁定）：仅当 mode=auto 且无规则命中、
   * 无会话记忆时置 true，与 yolo 的普通放行、规则命中放行相区分，供上层审计。
   */
  readonly reasonedDefault?: boolean;
}

/** parseRule 失败码。 */
export type ParseErrorCode = "empty" | "bad_form" | "bad_tool";

/**
 * parseRule 解析失败结果。
 * 判别方式：对 `PermissionRule | ParseError` 联合用 `"ok" in result`
 * 收窄（PermissionRule 无 ok 字段，ParseError 恒 ok:false）。
 */
export interface ParseError {
  /** 恒为 false，判别用。 */
  readonly ok: false;
  /** 失败码：empty=空串 / bad_form=括号形态非法 / bad_tool=工具名非法。 */
  readonly code: ParseErrorCode;
  /** 人类可读失败原因（中文）。 */
  readonly message: string;
}
