/**
 * BI-06.4 外部生命周期钩子系统 —— 类型与协议定义
 *
 * 对应 config.toml 的 `[[hooks]]` 分区（与 BI-01.1 的 hooks 分区结构对齐）：
 *
 *   [[hooks]]
 *   event = "PreToolUse"
 *   command = "bun run /path/to/guard.js"
 *   timeoutMs = 5000
 *   blocking = true
 *
 * 注意：hooks 配置的装载/校验归 config 模块（BI-01.1）负责，本模块只消费 HooksConfig。
 *
 * 子进程协议（kimi externalHooks 32KB 轮子的合约级重实现）：
 * - stdin  ：HookInput JSON（一次性写入后关闭）
 * - stdout ：取最后一个非空行解析为 HookOutput JSON；解析失败 = 坏输出（fail-open 放行 + 告警）
 *
 * 双层安全语义（正交，钉死）：
 * 1. fail-closed 准入门：拒绝的是"执行外部代码"这件事（不 spawn，逐条 skip + 审计记录），
 *    被拒的是钩子本身，主流程不被阻断。两道门：
 *    a. 信任门（BI-06.9 workspace-trust）：工作区非 'trusted'（untrusted/none）一律不执行；
 *    b. 执行准入扫描（BI-06.8 shell-scan + opaque-guard）：脚本 opaque（及 dangerous）
 *       一律不执行——工单钉死的 opaque 拒执为其最小集。
 * 2. fail-open 执行面：钩子自身故障（spawn 失败/非零退出/超时/坏输出）不阻断主流程
 *    （fail-open for availability）；只有显式 JSON { action:"block" } 决策（且 blocking !== false）
 *    才阻断主流程。
 */

/**
 * 20 种生命周期事件（枚举完备性由测试钉死：HOOK_EVENTS.length === 20）。
 */
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'SessionStart',
  'SessionEnd',
  'PreCompact',
  'PostCompact',
  'PreUndo',
  'PostUndo',
  'PreFileWrite',
  'PostFileWrite',
  'PreBash',
  'PostBash',
  'Interrupted',
  'DateChange',
  'ModelFallback',
  'ContextOverflow',
  'SessionFork',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** 钩子默认超时：10s */
export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;

/** 单条钩子定义（对应 config.toml 的一个 [[hooks]] 条目） */
export interface HookDefinition {
  /** 触发事件 */
  event: HookEvent;
  /** 外部 shell 命令行（经 shell 执行；内容需可通过 BI-06.8 shell-scan 的 opaque 判定） */
  command: string;
  /** 超时毫秒数，缺省 10_000；超时杀进程 → 结构化 hook-timeout 记录（fail-open） */
  timeoutMs?: number;
  /** 是否允许其 block 决策阻断主流程，缺省 true；false = 咨询性钩子（block 被降级为记录） */
  blocking?: boolean;
  /**
   * 工具名正则匹配器：仅 PreToolUse / PostToolUse 事件生效（其余事件忽略），
   * 缺省/空串 = 匹配全部工具。config 装载层（hooks-adapter）已校验正则形态；
   * 程序化直构传入非法正则时按不匹配处理（该钩子不触发，主流程不受影响）。
   */
  matcher?: string;
}

/**
 * hooks 配置根（对应 config.toml `[[hooks]]` 分区）。
 * 装载与校验归 BI-01.1 config 模块：config.toml / schema 层使用 snake_case 字段与
 * schema 侧事件枚举，由 config 装载适配层映射为本领域类型后传入；本模块只消费 HooksConfig。
 */
export interface HooksConfig {
  hooks: HookDefinition[];
}

/** 传给钩子子进程 stdin 的输入（JSON 序列化） */
export interface HookInput {
  event: HookEvent;
  sessionId?: string;
  tool?: string;
  args?: unknown;
  cwd: string;
  timestamp: string;
}

/** 钩子决策动作 */
export type HookAction = 'allow' | 'block' | 'ask';

/** 钩子 stdout 末行 JSON 决策协议 */
export interface HookOutput {
  action: HookAction;
  reason?: string;
}

/** 单条钩子执行审计记录 */
export interface HookRunRecord {
  /** 钩子标识：config.hooks 中的下标，如 "hooks[2]" */
  hookId: string;
  event: HookEvent;
  command: string;
  /**
   * 执行状态：
   * - ran                ：正常执行且输出可解析（决策见 decision）
   * - skipped-untrusted  ：fail-closed 信任门拦截（未受信工作区，拒绝执行）
   * - skipped-opaque     ：BI-06.8 shell-scan 判定脚本内容 opaque，拒绝执行
   * - timeout            ：结构化 hook-timeout（fail-open，不阻断）
   * - crash              ：spawn 失败或非零退出（fail-open，不阻断）
   * - bad-output         ：末行 JSON 解析失败（fail-open 放行 + 告警）
   */
  status:
    | 'ran'
    | 'skipped-untrusted'
    | 'skipped-opaque'
    | 'timeout'
    | 'crash'
    | 'bad-output';
  /** 解析出的钩子决策（status === 'ran' 时存在） */
  decision?: HookAction;
  /** 该钩子是否真正阻断了主流程 */
  blocked?: boolean;
  exitCode?: number | null;
  timedOut?: boolean;
  durationMs: number;
  /** block 原因或结构化标签（如 "hook-timeout"） */
  reason?: string;
  /** 告警信息（如坏输出详情） */
  warning?: string;
}

/** run() 聚合结果：首个有效 block 短路返回；否则全放行 */
export interface HookOutcome {
  action: 'allow' | 'block';
  /** block 时为钩子给出的 reason */
  reason?: string;
  /** 阻断来源钩子标识 */
  hookId?: string;
  /** 实际执行（spawn 过）的钩子数，skip 不计入 */
  ran: number;
  /** 全量审计记录（含 skipped） */
  records: HookRunRecord[];
}
