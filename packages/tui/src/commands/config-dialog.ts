/**
 * `/config` 设置面板 —— 类型化命令契约（占位实现）。
 *
 * 依赖边界（BI-19 将接管）：
 * - 本文件只冻结命令名、参数类型与"打开面板"的接口签名；面板渲染与交互实现由 BI-19 提供。
 * - BI-19 实现渲染时，应替换 `createConfigDialogCommand` 返回的 stub handler，
 *   并复用这里声明的 `ConfigDialogPanel` / `ConfigDialogArgs` / `ConfigDialogResult` 契约，
 *   不得绕过 `ConfigService` 直接读写 TOML 文件（合并优先级、热重载与脱敏都收敛在 ConfigService）。
 * - 数据来源：`@bi/core/config` 的 `ConfigService`（快照读取 / writeback / reload）。
 *
 * 关联命令：`/reload`、`/reload-tui` 的命令名契约同样在此登记；
 * 它们的 handler 现已可用（直接委托 `ConfigService.reload()` / `reloadTui()`），渲染反馈由 BI-19 补齐。
 */

import type {
  BiConfigSectionName,
  ConfigService,
} from "@bi/core/config";

/** `/config` 命令名。 */
export const CONFIG_COMMAND_NAME = "config";

/** `/reload` 命令名（全量热重载）。 */
export const RELOAD_COMMAND_NAME = "reload";

/** `/reload-tui` 命令名（仅终端外观偏好热重载）。 */
export const RELOAD_TUI_COMMAND_NAME = "reload-tui";

/** `/config` 面板参数。 */
export interface ConfigDialogArgs {
  /** 直接打开指定分区（如 "providers"）；省略 = 打开分区索引页。 */
  section?: BiConfigSectionName;
  /** 分区内目标键（相对该分区的点分路径，如 "entries.openai.api_key_env"）。 */
  key?: string;
}

/** 面板动作结果。 */
export interface ConfigDialogResult {
  /** 面板是否成功打开并处理。 */
  handled: boolean;
  /** 未处理时的原因（如渲染实现未落地）。 */
  reason?: string;
}

/**
 * 交互式设置面板接口 —— BI-19 提供渲染实现。
 */
export interface ConfigDialogPanel {
  /** 打开设置面板（索引页或指定分区）。 */
  open(args: ConfigDialogArgs): Promise<ConfigDialogResult>;
}

/** 命令工厂依赖注入。 */
export interface ConfigDialogServices {
  /** 配置中枢：读取快照、执行 writeback、reload / reloadTui。 */
  config: ConfigService;
}

/** TUI 命令统一形态（BI-19 的命令注册器消费）。 */
export interface TuiCommand<A = unknown> {
  /** 斜杠命令名（不含前导 "/"）。 */
  name: string;
  /** 补全列表里的摘要。 */
  summary: string;
  /** handler。 */
  run(args?: A): Promise<ConfigDialogResult>;
}

/**
 * `/config` 命令工厂。
 *
 * 当前为占位：返回的 handler 不做渲染，返回 `handled: false` 与指引原因；
 * BI-19 落地渲染后替换 `panel` 实现即可，命令名与参数契约保持不变。
 */
export function createConfigDialogCommand(services: ConfigDialogServices): TuiCommand<ConfigDialogArgs> & ConfigDialogPanel {
  void services.config; // 契约占位：BI-19 渲染实现将经由 services.config 读取快照与回写
  return {
    name: CONFIG_COMMAND_NAME,
    summary: "打开交互式设置面板（查看 / 修改三级 TOML 配置）",
    async open(_args?: ConfigDialogArgs): Promise<ConfigDialogResult> {
      return {
        handled: false,
        reason: "设置面板渲染由 BI-19 提供（config-dialog 契约占位）；运行期可用 /reload、/reload-tui 热重载配置。",
      };
    },
    async run(args?: ConfigDialogArgs): Promise<ConfigDialogResult> {
      return this.open(args ?? {});
    },
  };
}

/** `/reload` 命令：全量热重载（默认值 ← 三层 TOML ← 环境变量 ← CLI）。 */
export function createReloadCommand(services: ConfigDialogServices): TuiCommand {
  return {
    name: RELOAD_COMMAND_NAME,
    summary: "免重启热重载全部配置（config.toml / tui.toml / local.toml）",
    async run(): Promise<ConfigDialogResult> {
      await services.config.reload();
      return { handled: true };
    },
  };
}

/** `/reload-tui` 命令：仅热重载终端外观偏好（tui.toml）。 */
export function createReloadTuiCommand(services: ConfigDialogServices): TuiCommand {
  return {
    name: RELOAD_TUI_COMMAND_NAME,
    summary: "免重启热重载终端外观偏好（tui.toml）",
    async run(): Promise<ConfigDialogResult> {
      await services.config.reloadTui();
      return { handled: true };
    },
  };
}

/** BI-19 需要注册的全部配置域命令（命令名契约的单一来源）。 */
export function createConfigCommands(services: ConfigDialogServices): Array<TuiCommand<ConfigDialogArgs> | TuiCommand> {
  return [
    createConfigDialogCommand(services),
    createReloadCommand(services),
    createReloadTuiCommand(services),
  ];
}
