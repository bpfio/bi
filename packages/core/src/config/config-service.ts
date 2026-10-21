/**
 * 配置中枢 ConfigService —— 三级 TOML 多源优先级合并与动态热重载引擎。
 *
 * 合并优先级（对齐工单，从低到高）：
 *   内置默认值 < config.toml / tui.toml < local.toml < 环境变量 < CLI Flags
 *
 * 深度合并语义：
 * - 对象：键级递归合并（后层只覆盖其显式提供的键）；
 * - 数组：整体替换（后层同名数组完全覆盖前层）；
 * - 标量：后层覆盖前层；`undefined`（本层未提供）跳过。
 *
 * `api_key_env` 间接引用：provider 条目仅保存环境变量名，解析时读取环境变量；
 * 未设置时抛出携带修复指引的 ConfigError——配置文件中永不落明文密钥。
 *
 * 热重载：`reload()` / `reloadTui()` 免重启重载；`startWatch()` 以 fs.watch + 防抖
 * （默认 300ms，可注入）监听三个配置文件，变更后自动重载并通知监听者。
 *
 * watch ignore 语义（钉死）：`startWatch()` 收到文件事件时，事件文件名先过
 * `watchIgnore` glob 列表（`**` 跨段、`*` 单段内、`?` 单字符）过滤；命中则丢弃
 * 不触发重载。ignore 在构造期由 `watchIgnore` 选项固化（缺省取 config
 * [watch].ignore 内置默认），startWatch 启动后不随运行时配置变更而变（边界：
 * 启动后增删 watch 键经 reload/reloadTui 本身生效/失效不做，仅 enabled 管启动开关）。
 */

import { existsSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { parse as tomlParse } from "smol-toml";
import { redactSecrets } from "./redact";
import { resolveConfigPaths, type ConfigPaths } from "./paths";
import {
  BI_CONFIG_SCHEMA,
  buildEnvLayer,
  ConfigError,
  createDefaultConfig,
  deepMergeLayer,
  tuiSchema,
  validateConfigLayer,
  type BiConfig,
  type BiConfigLayer,
  type ConfigIssue,
} from "./schema";
import {
  writebackConfigFile,
  writebackTableToFile,
  type PlannedWriteback,
  type TomlValue,
  type WritebackEdit,
} from "./writeback";

/** 配置热重载的默认防抖毫秒数。 */
export const DEFAULT_WATCH_DEBOUNCE_MS = 300;

/** 配置源层标签（诊断归属）。 */
export type ConfigSourceLabel = "config.toml" | "tui.toml" | "local.toml" | "env" | "cli";

export interface ConfigServiceOptions {
  /** 覆盖用户主目录（测试必须注入临时目录，禁止读写真实 ~/.bi）。 */
  homeDir?: string;
  /** 覆盖工作目录（测试注入用）。 */
  workDir?: string;
  /** 环境变量源；缺省 process.env（测试注入以避免污染真实环境）。 */
  env?: Record<string, string | undefined>;
  /** CLI Flags 覆盖层（最高优先级，形态为 BiConfig 深层偏对象）。 */
  cliOverrides?: BiConfigLayer;
  /** fs.watch 防抖毫秒数；默认 300。 */
  watchDebounceMs?: number;
  /** watch 文件事件忽略 glob 列表（** 跨段 / * 单段内 / ? 单字符）；缺省取 config [watch].ignore 内置默认。 */
  watchIgnore?: string[];
}

export interface ConfigChangeMeta {
  trigger: "reload" | "reloadTui" | "watch";
  /** watch 触发时发生变更的文件路径。 */
  filePath?: string;
}

export type ConfigChangeListener = (config: BiConfig, meta: ConfigChangeMeta) => void;

interface CachedLayers {
  global?: BiConfigLayer;
  local?: BiConfigLayer;
  env?: BiConfigLayer;
  cli?: BiConfigLayer;
}

export class ConfigService {
  /** 三级配置文件路径（可注入根目录）。 */
  readonly paths: ConfigPaths;

  private readonly env: Record<string, string | undefined>;
  private readonly cliLayer: BiConfigLayer | undefined;
  private readonly watchDebounceMs: number;
  private readonly watchIgnore: string[];
  private snapshot: BiConfig | undefined;
  private readonly issuesBySource = new Map<ConfigSourceLabel, ConfigIssue[]>();
  private cachedLayers: CachedLayers = {};
  private readonly listeners = new Set<ConfigChangeListener>();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastWatchError: unknown;

  constructor(options: ConfigServiceOptions = {}) {
    this.paths = resolveConfigPaths({ homeDir: options.homeDir, workDir: options.workDir });
    this.env = options.env ?? process.env;
    this.watchDebounceMs = options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
    this.watchIgnore = options.watchIgnore ?? createDefaultConfig().watch.ignore;
    if (options.cliOverrides !== undefined) {
      const cliIssues: ConfigIssue[] = [];
      const validated = validateConfigLayer(options.cliOverrides, cliIssues);
      if (validated === undefined) {
        throw new ConfigError("CLI 覆盖层校验失败：结构不是合法的配置对象", withSource(cliIssues, "cli"));
      }
      this.cliLayer = validated;
      this.issuesBySource.set("cli", withSource(cliIssues, "cli"));
    }
  }

  // ---------------------------------------------------------------------------
  // 加载 / 重载
  // ---------------------------------------------------------------------------

  /** 全量加载：默认值 → config.toml / tui.toml → local.toml → 环境变量 → CLI。首次加载不发变更通知。 */
  async load(): Promise<BiConfig> {
    const issues: ConfigIssue[] = [];
    const global = await this.readTomlLayer(this.paths.globalConfig, "config.toml", issues, "root");
    const tui = await this.readTomlLayer(this.paths.tuiConfig, "tui.toml", issues, "tuiSection");
    const local = await this.readTomlLayer(this.paths.localConfig, "local.toml", issues, "root");
    const env = this.envLayer(issues);
    this.cachedLayers = { global, local, env, cli: this.cliLayer };
    this.snapshot = this.compose(global, tui, local, env, this.cliLayer);
    return this.snapshot;
  }

  /**
   * 免重启全量热重载（重读全部三层文件）。
   * @param notify 是否通知 onChange 监听者（watch 内部调用时传 false 以避免双重通知）。
   */
  async reload(notify = true): Promise<BiConfig> {
    const snapshot = await this.load();
    if (notify) this.notify(snapshot, { trigger: "reload" });
    return snapshot;
  }

  /**
   * 终端外观偏好热重载：仅重读 tui.toml，其余层用加载时缓存重新合成。
   * @param notify 是否通知 onChange 监听者。
   */
  async reloadTui(notify = true): Promise<BiConfig> {
    const issues: ConfigIssue[] = [];
    const tui = await this.readTomlLayer(this.paths.tuiConfig, "tui.toml", issues, "tuiSection");
    this.snapshot = this.compose(
      this.cachedLayers.global,
      tui,
      this.cachedLayers.local,
      this.cachedLayers.env,
      this.cachedLayers.cli,
    );
    if (notify) this.notify(this.snapshot, { trigger: "reloadTui" });
    return this.snapshot;
  }

  /** 当前配置快照（未加载时抛错）。 */
  get current(): BiConfig {
    if (this.snapshot === undefined) {
      throw new ConfigError("配置尚未加载：请先 await configService.load()");
    }
    return this.snapshot;
  }

  /** 当前配置快照；未加载时返回 undefined。 */
  get currentOrNull(): BiConfig | undefined {
    return this.snapshot;
  }

  /** 最近一次加载的合并诊断（类型回退、未知键等），按来源层排序。 */
  get issues(): ConfigIssue[] {
    const order: ConfigSourceLabel[] = ["config.toml", "tui.toml", "local.toml", "env", "cli"];
    const out: ConfigIssue[] = [];
    for (const label of order) {
      const items = this.issuesBySource.get(label);
      if (items !== undefined) out.push(...items);
    }
    return out;
  }

  /** watch 触发重载失败时的最近一次错误（如文件处于半写入态、语法错误）；快照保持上次成功值。 */
  get watchError(): unknown {
    return this.lastWatchError;
  }

  // ---------------------------------------------------------------------------
  // provider 密钥解析（api_key_env 间接引用）
  // ---------------------------------------------------------------------------

  /**
   * 解析 provider 的 API Key：读 `api_key_env` 指向的环境变量。
   * - provider 不存在 → ConfigError（附已配置列表）；
   * - 未声明 api_key_env → 返回 undefined（该 provider 走 OAuth / 本地端点等无静态 Key 鉴权）；
   * - 环境变量未设置 → ConfigError，报错信息包含环境变量名与修复指引。
   */
  resolveProviderApiKey(providerName: string): string | undefined {
    const providers = this.current.providers;
    const entry = providers.entries[providerName];
    if (entry === undefined) {
      const known = Object.keys(providers.entries);
      throw new ConfigError(
        `未知的 provider "${providerName}"。已配置: ${known.length > 0 ? known.join(", ") : "(无)"}。` +
          `请在 config.toml 或 .bi/local.toml 的 [providers.entries] 中先定义。`,
      );
    }
    const envName = entry.api_key_env;
    if (envName === "") return undefined;
    const value = this.env[envName];
    if (value === undefined || value === "") {
      throw new ConfigError(
        `环境变量 ${envName} 未设置：provider "${providerName}" 通过 api_key_env 间接引用 API 密钥` +
          `（配置文件中不落明文）。请在 shell 配置（如 ~/.bashrc、~/.zshrc）或运行环境中设置 ` +
          `${envName} 后重试；若该 provider 无需静态密钥（如 OAuth、本地推理），请在配置中清空 api_key_env。` +
          `\n运行 bi doctor 可体检定位配置问题`,
      );
    }
    return value;
  }

  /** 返回可直接跨进程 / TUI / A2A 传输的脱敏快照（SecretValue 与敏感键名值自动遮蔽）。 */
  redactedSnapshot(): BiConfig {
    return redactSecrets(this.current);
  }

  // ---------------------------------------------------------------------------
  // 回写（供 /config 面板与 BI-19 使用）
  // ---------------------------------------------------------------------------

  /**
   * 对指定层文件执行注释保留原子回写。
   * @param file 目标层：global=config.toml，tui=tui.toml，local=local.toml。
   */
  async writeback(file: "global" | "tui" | "local", edits: readonly WritebackEdit[]): Promise<PlannedWriteback> {
    const filePath =
      file === "global" ? this.paths.globalConfig : file === "tui" ? this.paths.tuiConfig : this.paths.localConfig;
    return writebackConfigFile(filePath, edits);
  }

  /** 对指定层文件执行整表同步回写（tablePath 相对文档根，如 ["providers","entries","openai"]）。 */
  async writebackTable(
    file: "global" | "tui" | "local",
    tablePath: string[],
    table: Record<string, TomlValue>,
  ): Promise<PlannedWriteback> {
    const filePath =
      file === "global" ? this.paths.globalConfig : file === "tui" ? this.paths.tuiConfig : this.paths.localConfig;
    return writebackTableToFile(filePath, tablePath, table);
  }

  // ---------------------------------------------------------------------------
  // 文件监听与热重载
  // ---------------------------------------------------------------------------

  /**
   * 开始监听三级配置文件（fs.watch 目录级 + 按文件防抖）。
   * 目录不存在时跳过该项监听（首次运行场景）；重复调用为幂等空操作。
   */
  startWatch(): void {
    if (this.watchers.size > 0) return;
    const dirs = new Set<string>([dirname(this.paths.globalConfig), dirname(this.paths.localConfig)]);
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      try {
        const watcher = fsWatch(dir, (_event, filename) => {
          this.onWatchEvent(filename);
        });
        this.watchers.set(dir, watcher);
      } catch {
        // 目录不可监听（权限等）则跳过，不阻断启动；不影响显式 reload()。
      }
    }
  }

  /** 停止监听并清理防抖定时器。 */
  stopWatch(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  /** 订阅配置变更（reload / reloadTui / watch 均触发）；返回退订函数。 */
  onChange(listener: ConfigChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---------------------------------------------------------------------------
  // 内部
  // ---------------------------------------------------------------------------

  private compose(
    global: BiConfigLayer | undefined,
    tui: BiConfigLayer | undefined,
    local: BiConfigLayer | undefined,
    env: BiConfigLayer | undefined,
    cli: BiConfigLayer | undefined,
  ): BiConfig {
    const base = createDefaultConfig();
    deepMergeLayer(base, global);
    deepMergeLayer(base, tui);
    deepMergeLayer(base, local);
    deepMergeLayer(base, env);
    deepMergeLayer(base, cli);
    // 记录条目（providers.entries.* / mcp.servers.* 等）在合并时从空表起步，条目内未提供的
    // 字段不会经过默认值。用 Schema 的 backfill 遍历就地回填这些叶子的内置默认，
    // 保证消费方（resolveProviderApiKey 等）读到完整的强类型对象（api_key_env === "" 而非 undefined）。
    BI_CONFIG_SCHEMA.backfill?.(base);
    return base;
  }

  private async readTomlLayer(
    filePath: string,
    label: ConfigSourceLabel,
    issues: ConfigIssue[],
    scope: "root" | "tuiSection",
  ): Promise<BiConfigLayer | undefined> {
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        this.issuesBySource.set(label, []); // 文件不存在 = 空层（首次运行），非诊断
        return undefined;
      }
      throw new ConfigError(`无法读取配置文件 ${filePath}: ${errorText(error)}`);
    }
    if (text.trim() === "") {
      this.issuesBySource.set(label, []);
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = tomlParse(text);
    } catch (error) {
      throw new ConfigError(`${label} 解析失败（${filePath}）: ${errorText(error)}` + `\n运行 bi doctor 可体检定位配置问题`);
    }
    const layerIssues: ConfigIssue[] = [];
    let layer: BiConfigLayer | undefined;
    if (scope === "tuiSection") {
      // tui.toml 的顶层即 tui 分区字段（对用户更友好），校验后包装为 { tui: ... } 层。
      const section = tuiSchema.validateLayer(parsed, "", layerIssues);
      layer = section === undefined ? undefined : ({ tui: section } as BiConfigLayer);
    } else {
      layer = validateConfigLayer(parsed, layerIssues);
    }
    const tagged = withSource(layerIssues, label);
    this.issuesBySource.set(label, tagged);
    issues.push(...tagged);
    return layer;
  }

  private envLayer(issues: ConfigIssue[]): BiConfigLayer | undefined {
    const layerIssues: ConfigIssue[] = [];
    const validated = validateConfigLayer(buildEnvLayer(this.env), layerIssues);
    const tagged = withSource(layerIssues, "env");
    this.issuesBySource.set("env", tagged);
    issues.push(...tagged);
    return validated;
  }

  private notify(config: BiConfig, meta: ConfigChangeMeta): void {
    for (const listener of this.listeners) {
      try {
        listener(config, meta);
      } catch {
        // 监听者异常不阻断其他监听者与重载流程。
      }
    }
  }

  /** 事件文件名是否命中 ignore glob（** 跨段 / * 单段内 / ? 单字符）。 */
  private isIgnored(filename: string): boolean {
    return this.watchIgnore.some((pattern) => globMatches(pattern, filename));
  }

  private onWatchEvent(filename: string | null): void {
    if (filename !== null && this.isIgnored(filename)) return; // 命中 ignore 丢弃
    if (filename === null) {
      // 平台不保证提供文件名：退化为全量重载
      this.scheduleWatchReload(this.paths.globalConfig, "reload");
      this.scheduleWatchReload(this.paths.localConfig, "reload");
      this.scheduleWatchReload(this.paths.tuiConfig, "reloadTui");
      return;
    }
    switch (basename(filename)) {
      case "config.toml":
        this.scheduleWatchReload(this.paths.globalConfig, "reload");
        break;
      case "local.toml":
        this.scheduleWatchReload(this.paths.localConfig, "reload");
        break;
      case "tui.toml":
        this.scheduleWatchReload(this.paths.tuiConfig, "reloadTui");
        break;
      default:
        break; // 无关文件（如编辑器临时文件）忽略
    }
  }

  private scheduleWatchReload(filePath: string, kind: "reload" | "reloadTui"): void {
    const existing = this.debounceTimers.get(filePath);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      void this.runWatchReload(filePath, kind);
    }, this.watchDebounceMs);
    timer.unref?.();
    this.debounceTimers.set(filePath, timer);
  }

  private async runWatchReload(filePath: string, kind: "reload" | "reloadTui"): Promise<void> {
    try {
      const config =
        kind === "reloadTui" ? await this.reloadTui(false) : await this.reload(false);
      this.lastWatchError = undefined;
      this.notify(config, { trigger: "watch", filePath });
    } catch (error) {
      // 热重载遇到无效文件（半写入 / 语法错误）：保留上一次成功快照，不中断监听。
      this.lastWatchError = error;
    }
  }
}

function withSource(issues: ConfigIssue[], source: ConfigSourceLabel): ConfigIssue[] {
  return issues.map((issue) => ({ ...issue, source }));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 文件名 glob 匹配（watch ignore 过滤，最小实现）：
 * - `**` 跨段通配（跨 /，含零段）；其后若紧跟 `/` 一并消费；
 * - `*` 单段内通配（不含 /）；`?` 单字符；其余字符按字面（正则元字符转义）。
 * 锚定 ^...$。
 */
function globMatches(pattern: string, name: string): boolean {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 2;
        if (pattern[i] === "/") i += 1;
        continue;
      }
      re += "[^/]*";
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
    i += 1;
  }
  re += "$";
  return new RegExp(re).test(name);
}
