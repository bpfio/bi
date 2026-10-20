/**
 * BI 配置 Schema —— 15+ 分区强类型定义与内置默认值（单一事实来源）。
 *
 * 设计要点：
 * - 每个分区用一个声明式 Schema 组合子描述：类型校验与默认值一体定义；
 * - TS 静态类型（BiConfig 及各分区类型）直接从 Schema 推导，避免"类型 + 默认值"两份手写漂移；
 * - 校验器面向"单层配置源"（config.toml / tui.toml / local.toml / 环境变量 / CLI 覆盖），
 *   返回"仅含本层显式提供键"的深层偏对象；未知键与类型不符的键会被丢弃并记录 ConfigIssue；
 * - 深度合并语义（对齐工单）：对象键级递归合并；数组整体替换；标量后层覆盖前层。
 */

/** 单条配置诊断（类型不符、未知键等），不阻断加载，供上层提示与调试。 */
export interface ConfigIssue {
  /** 配置点分路径，如 "tools.allow"；根级问题为 ""。 */
  path: string;
  message: string;
  /** 来源层标签（由 ConfigService 标注），如 "config.toml"、"local.toml"、"env"、"cli"。 */
  source?: string;
}

/** 配置域错误：加载失败（TOML 语法错误）、语义校验失败、密钥解析失败等。 */
export class ConfigError extends Error {
  readonly issues: ConfigIssue[];

  constructor(message: string, issues: ConfigIssue[] = []) {
    super(message);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// 声明式 Schema 组合子
// ---------------------------------------------------------------------------

/**
 * 校验器统一形态：
 * - `validateLayer` 接收一个配置层的原始解析值（unknown），返回"仅含本层显式提供键"的偏对象；
 *   值为 `undefined` 表示本层未提供该键（不是"清空"）。
 * - `defaultValue` 返回内置默认值（每次调用均返回全新深拷贝，避免共享可变引用）。
 * - `backfill`（可选，仅容器类组合子提供）：对已合成的完整对象就地回填缺失的叶子默认值——
 *   记录条目（providers.entries.* 等）在合并时从空表起步，条目内未提供的字段需要该遍历补默认。
 */
export interface Schema<T> {
  /** 仅用于类型推断的幻影字段。 */
  readonly __type?: T;
  validateLayer(raw: unknown, path: string, issues: ConfigIssue[]): unknown;
  defaultValue(): T;
  backfill?(value: unknown): void;
}

/** 从 Schema 实例推导其承载的强类型。 */
export type InferSchema<V> = V extends Schema<infer T> ? T : never;

/** 深层偏对象：对象逐键可选；数组保持整体（要么整体提供要么不提供）。 */
export type PartialDeep<T> = T extends (infer U)[]
  ? U[]
  : T extends Record<string, unknown>
    ? { [K in keyof T]?: PartialDeep<T[K]> }
    : T;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function joinPath(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

function pushIssue(issues: ConfigIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

/** 点分路径写入嵌套对象（用于环境变量层构造），中间层自动创建。 */
export function setDottedPath(target: Record<string, unknown>, dottedPath: string, value: unknown): void {
  const segments = dottedPath.split(".");
  let cursor = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    if (segment === undefined) continue; // 不可达：split 结果不含 undefined
    const next = cursor[segment];
    if (isPlainObject(next)) {
      cursor = next;
    } else {
      const created: Record<string, unknown> = {};
      cursor[segment] = created;
      cursor = created;
    }
  }
  const last = segments[segments.length - 1];
  if (last !== undefined) cursor[last] = value;
}

function makeSchema<T>(
  validate: (raw: unknown, path: string, issues: ConfigIssue[]) => unknown,
  produceDefault: () => T,
  backfill?: (value: unknown) => void,
): Schema<T> {
  return {
    __type: undefined,
    validateLayer: validate,
    defaultValue: produceDefault,
    ...(backfill !== undefined ? { backfill } : {}),
  } as Schema<T>;
}

// ----- 标量组合子 -----

export function sStr(def: string): Schema<string> {
  return makeSchema((raw, path, issues) => {
    if (raw === undefined) return undefined;
    if (typeof raw !== "string") {
      pushIssue(issues, path, `期望 string，实际 ${describeValue(raw)}，已回退默认值`);
      return undefined;
    }
    return raw;
  }, () => def);
}

export function sBool(def: boolean): Schema<boolean> {
  return makeSchema((raw, path, issues) => {
    if (raw === undefined) return undefined;
    if (typeof raw !== "boolean") {
      pushIssue(issues, path, `期望 boolean，实际 ${describeValue(raw)}，已回退默认值`);
      return undefined;
    }
    return raw;
  }, () => def);
}

export function sNum(def: number): Schema<number> {
  return makeSchema((raw, path, issues) => {
    if (raw === undefined) return undefined;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      pushIssue(issues, path, `期望有限 number，实际 ${describeValue(raw)}，已回退默认值`);
      return undefined;
    }
    return raw;
  }, () => def);
}

export function sInt(def: number): Schema<number> {
  return makeSchema((raw, path, issues) => {
    if (raw === undefined) return undefined;
    if (typeof raw !== "number" || !Number.isInteger(raw)) {
      pushIssue(issues, path, `期望整数 number，实际 ${describeValue(raw)}，已回退默认值`);
      return undefined;
    }
    return raw;
  }, () => def);
}

export function sEnum<T extends string>(values: readonly T[], def: T): Schema<T> {
  const allowed = new Set<string>(values);
  return makeSchema((raw, path, issues) => {
    if (raw === undefined) return undefined;
    if (typeof raw !== "string" || !allowed.has(raw)) {
      pushIssue(issues, path, `期望枚举 [${values.join(" | ")}] 之一，实际 ${describeValue(raw)}，已回退默认值`);
      return undefined;
    }
    return raw as T;
  }, () => def);
}

// ----- 容器组合子 -----

/**
 * 字符串数组。容错：TOML 里误写成单字符串时自动包一层（`deny = "rm"` → `["rm"]`）。
 * 数组语义 = 整体替换（后层完全覆盖前层的同名数组）。
 */
export function sStrList(def: string[]): Schema<string[]> {
  return makeSchema((raw, path, issues) => {
    if (raw === undefined) return undefined;
    if (typeof raw === "string") return [raw];
    if (!Array.isArray(raw)) {
      pushIssue(issues, path, `期望 string 数组，实际 ${describeValue(raw)}，已回退默认值`);
      return undefined;
    }
    const out: string[] = [];
    for (let i = 0; i < raw.length; i += 1) {
      const element = raw[i];
      if (typeof element === "string") {
        out.push(element);
      } else {
        pushIssue(issues, joinPath(path, String(i)), `期望 string 元素，实际 ${describeValue(element)}，该元素已丢弃`);
      }
    }
    return out;
  }, () => def.slice());
}

/** 泛型数组（元素级校验，非法元素丢弃并记录），用于规则 / hooks 等对象数组。 */
export function sListOf<T>(entry: Schema<T>, def: T[]): Schema<T[]> {
  return makeSchema((raw, path, issues) => {
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw)) {
      pushIssue(issues, path, `期望数组，实际 ${describeValue(raw)}，已回退默认值`);
      return undefined;
    }
    const out: T[] = [];
    for (let i = 0; i < raw.length; i += 1) {
      const validated = entry.validateLayer(raw[i], joinPath(path, String(i)), issues);
      if (validated !== undefined) out.push(validated as T);
    }
    return out;
  }, () => structuredClone(def), (value) => {
    if (!Array.isArray(value)) return;
    for (const element of value) {
      if (element !== null && typeof element === "object") entry.backfill?.(element);
    }
  });
}

/**
 * 字符串键记录（`Record<string, T>`）。对象语义 = 键级递归合并：
 * 后层只需提供要新增 / 覆盖的键，其余键自前层继承。
 */
export function sRecord<V>(entry: Schema<V>): Schema<Record<string, V>> {
  return makeSchema((raw, path, issues) => {
    if (raw === undefined) return undefined;
    if (!isPlainObject(raw)) {
      pushIssue(issues, path, `期望 table，实际 ${describeValue(raw)}，已回退默认值`);
      return undefined;
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(raw)) {
      const validated = entry.validateLayer(raw[key], joinPath(path, key), issues);
      if (validated !== undefined) out[key] = validated;
    }
    return out;
  }, () => ({}), (value) => {
    if (!isPlainObject(value)) return;
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (child !== null && typeof child === "object") entry.backfill?.(child);
    }
  });
}

/** 固定形状对象（分区 / 子表）。未知键丢弃并记录；本层未提供的键不出现（合并时继承前层）。 */
export function sObj<S extends Record<string, Schema<unknown>>>(
  shape: S,
): Schema<{ [K in keyof S]: InferSchema<S[K]> }> {
  return makeSchema((raw, path, issues) => {
    if (raw === undefined) return undefined;
    if (!isPlainObject(raw)) {
      pushIssue(issues, path, `期望 table，实际 ${describeValue(raw)}，已回退默认值`);
      return undefined;
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(raw)) {
      const sub = shape[key];
      if (!sub) {
        pushIssue(issues, joinPath(path, key), "未知配置键，已忽略");
        continue;
      }
      const validated = sub.validateLayer(raw[key], joinPath(path, key), issues);
      if (validated !== undefined) out[key] = validated;
    }
    // 全部键无效（或本层为空表）时返回 undefined：合并语义等同于"本层未提供"，默认值兜底
    if (Object.keys(out).length === 0) return undefined;
    return out;
  }, () => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(shape)) {
      const sub = shape[key] as Schema<unknown> | undefined;
      if (sub) out[key] = sub.defaultValue();
    }
    return out as { [K in keyof S]: InferSchema<S[K]> };
  }, (value) => {
    if (!isPlainObject(value)) return;
    for (const key of Object.keys(shape)) {
      const sub = shape[key] as Schema<unknown> | undefined;
      if (sub === undefined) continue;
      if (value[key] === undefined) {
        value[key] = sub.defaultValue();
      } else {
        sub.backfill?.(value[key]);
      }
    }
  });
}

/**
 * 严格实体（fail-closed）：用于记录条目 / 数组元素等"结构单元"。
 * 任一字段校验失败或出现未知键 → 整个条目丢弃并记录诊断，
 * 避免半残条目（如缺 tool 的权限规则、缺 command 的 hook）进入生效配置。
 */
export function sEntity<S extends Record<string, Schema<unknown>>>(
  shape: S,
): Schema<{ [K in keyof S]: InferSchema<S[K]> }> {
  const inner = sObj(shape);
  return makeSchema((raw, path, issues) => {
    if (raw === undefined) return undefined;
    if (!isPlainObject(raw)) {
      pushIssue(issues, path, `期望 table，实际 ${describeValue(raw)}，该条目已整体丢弃`);
      return undefined;
    }
    const childIssues: ConfigIssue[] = [];
    const validated = inner.validateLayer(raw, path, childIssues);
    if (childIssues.length > 0 || validated === undefined) {
      pushIssue(issues, path, "条目结构无效（存在类型不符字段或未知键），整个条目已丢弃");
      issues.push(...childIssues);
      return undefined;
    }
    return validated;
  }, () => inner.defaultValue(), inner.backfill);
}

/**
 * 深度合并一层偏对象到完整基准对象上（原地修改 base）。
 * 语义：对象键级递归；数组整体替换；标量覆盖；`undefined` 跳过。
 */
export function deepMergeLayer<T>(base: T, layer: PartialDeep<T> | undefined): T {
  if (layer === undefined) return base;
  const baseRecord = base as Record<string, unknown>;
  const layerRecord = layer as Record<string, unknown>;
  for (const key of Object.keys(layerRecord)) {
    const incoming = layerRecord[key];
    if (incoming === undefined) continue;
    const current = baseRecord[key];
    if (isPlainObject(incoming) && isPlainObject(current)) {
      deepMergeLayer(current, incoming as PartialDeep<Record<string, unknown>>);
    } else {
      baseRecord[key] = incoming;
    }
  }
  return base;
}

// ---------------------------------------------------------------------------
// 分区 Schema（17 个分区）
// ---------------------------------------------------------------------------

/** 工作区：附加目录与忽略策略。local.toml 的典型覆盖项。 */
export const workspaceSchema = sObj({
  /** 工作区附加目录（在主工作目录之外额外授权访问的目录）；空串 = 未启用。 */
  additional_dir: sStr(""),
  /** 文件遍历是否尊重 .gitignore。 */
  respect_gitignore: sBool(true),
});
export type WorkspaceSection = InferSchema<typeof workspaceSchema>;

/** 供应商协议类型（决定 API 线协议适配方式）。 */
export const PROVIDER_KINDS = ["openai", "anthropic", "google"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const providerEntrySchema = sEntity({
  /**
   * 间接引用：从该环境变量读取 API Key，配置文件中不落明文（防泄漏）。
   * 空串 = 该 provider 不走静态 Key（如 OAuth / 本地推理端点）。
   */
  api_key_env: sStr(""),
  /** API 端点；空串 = 使用该协议的官方默认端点。 */
  base_url: sStr(""),
  kind: sEnum(PROVIDER_KINDS, "openai"),
  /** 该 provider 下可用的模型名列表（提示用，数组整体替换）。 */
  models: sStrList([]),
  /**
   * 附加请求头：原样合并进该 provider 的每次 wire 请求（同键覆盖缺省头）。
   * 特例：`x-opencode-session = "auto"` 由装配层解析为每装配一个稳定随机 UUID
   * （opencode Go 网关要求会话级稳定 ID 做路由与 prompt 缓存）。
   */
  extra_headers: sRecord(sStr("")),
});
export type ProviderEntry = InferSchema<typeof providerEntrySchema>;

/** 模型供应商分区。entries 键级合并，可在 local.toml 只覆盖单个 provider。 */
export const providersSchema = sObj({
  /** 默认 provider 名；空串 = 使用 entries 中的第一个。 */
  default: sStr(""),
  entries: sRecord(providerEntrySchema),
});
export type ProvidersSection = InferSchema<typeof providersSchema>;

export const modelEntrySchema = sEntity({
  /** 引用的 provider 名（providers.entries 的键）。 */
  provider: sStr(""),
  /** 供应商侧模型名（如 "kimi-k2-turbo-preview"）。 */
  model: sStr(""),
  /** 0 = 使用供应商默认。 */
  max_tokens: sInt(0),
  temperature: sNum(0.7),
  /** 0 = 未知 / 不限制。 */
  context_limit: sInt(0),
});
export type ModelEntry = InferSchema<typeof modelEntrySchema>;

/** 模型注册表：default 为默认主对话模型 ID（models.entries 的键）。 */
export const modelsSchema = sObj({
  default: sStr(""),
  entries: sRecord(modelEntrySchema),
});
export type ModelsSection = InferSchema<typeof modelsSchema>;

/** 次级模型池：子智能体与后台降级模型的 ID 引用（models.entries 的键）。 */
export const secondaryModelSchema = sObj({
  /** 子智能体（subagent）使用的模型 ID。 */
  subagent: sStr(""),
  /** 后台低优先级任务的降级模型 ID。 */
  background: sStr(""),
  /** 上下文压缩 / 摘要模型 ID。 */
  summarize: sStr(""),
});
export type SecondaryModelSection = InferSchema<typeof secondaryModelSchema>;

/** 思考（extended thinking）控制。 */
export const thinkingSchema = sObj({
  enabled: sBool(true),
  effort: sEnum(["minimal", "low", "medium", "high"] as const, "medium"),
  /** 思考预算 token 数；0 = 由 effort 推导。 */
  budget_tokens: sInt(0),
});
export type ThinkingSection = InferSchema<typeof thinkingSchema>;

/** Agent 主循环控制。 */
export const loopControlSchema = sObj({
  /** 单次会话最大迭代轮数。 */
  max_iterations: sInt(200),
  /** 单轮最大工具调用次数。 */
  max_tool_calls_per_turn: sInt(80),
  /** 单步超时毫秒。 */
  step_timeout_ms: sInt(120_000),
  /** 单轮总超时毫秒；0 = 不限。 */
  turn_timeout_ms: sInt(0),
});
export type LoopControlSection = InferSchema<typeof loopControlSchema>;

/** 工具白/黑名单。allow 为空 = 不限制；deny 优先级高于 allow。数组整体替换。 */
export const toolsSchema = sObj({
  allow: sStrList([]),
  deny: sStrList([]),
  /**
   * BI-08.1：单次工具输出有界截断上限（Unicode 码点）。
   * 0（缺省）= 关闭；>0 时无头工具成功输出超限经 boundToolText 两级预算
   * 截断（附结构化标记行）。≤0 一律按关闭处理——配置错误恒降级为现状，
   * 不放大故障面。
   */
  output_limit_bytes: sInt(0),
  /**
   * BI-08.3：read_media_file 挂载门控。true = 注册 read_media_file 工具；缺省
   * false 工具面零变动（同款门控模式：config 显式开启才挂载，否则维持既有注册面）。
   */
  media: sBool(false),
  /**
   * BI-07.11：JobList/JobOutput/JobKill 三件挂载门控。true = 注册三件；缺省
   * false 工具面零变动（同款门控模式：config 显式开启才挂载，否则维持既有注册面）。
   */
  job_tools: sBool(false),
  /**
   * BI-13.2：lsp_navigate 挂载门控。true = 注册 lsp_navigate 工具；缺省 false
   * 工具面零变动（同款门控模式：config 显式开启才挂载，否则维持既有注册面）。
   */
  lsp: sBool(false),
  /**
   * BI-13.1：select_tools 挂载门控。true = 注册 select_tools 工具；缺省 false
   * 工具面零变动（同款门控模式：config 显式开启才挂载，否则维持既有注册面）。
   */
  select_tools: sBool(false),
});
export type ToolsSection = InferSchema<typeof toolsSchema>;

export const permissionRuleSchema = sEntity({
  /** 工具名，支持前缀通配（如 "bash*" / "*"）。 */
  tool: sStr(""),
  /** 参数 glob 模式（如 "git *"）；空串 = 匹配全部参数。 */
  pattern: sStr(""),
  action: sEnum(["allow", "deny", "ask"] as const, "ask"),
});
export type PermissionRule = InferSchema<typeof permissionRuleSchema>;

/** 权限分区：批准模式 + 有序规则表（先命中先生效）。 */
export const permissionSchema = sObj({
  /**
   * 批准模式词面：default/plan/yolo 为 BI-28.3 config 原有三态；
   * auto/manual 为权限会话面同义词（permissionModeFromConfig 桥接：
   * auto→auto 全自动放行，manual→manual，default/plan→manual）。
   * 0.3.0 前枚举缺 auto/manual：用户写 "auto" 被静默回退 default、实际
   * 行为 manual——headless 工具面全军 ask 拒绝（0.3.0 自助测试发现修复）。
   */
  mode: sEnum(["default", "plan", "yolo", "auto", "manual"] as const, "default"),
  rules: sListOf(permissionRuleSchema, []),
});
export type PermissionSection = InferSchema<typeof permissionSchema>;

/** 文件读取策略。 */
export const readSchema = sObj({
  /** 单文件读取上限（KB）。 */
  max_file_size_kb: sInt(512),
  /** 读取时忽略的 glob 列表（数组整体替换）。 */
  ignore: sStrList(["node_modules/**", ".git/**", "dist/**"]),
  /** 单次读取输出截断字符数。 */
  max_output_chars: sInt(50_000),
});
export type ReadSection = InferSchema<typeof readSchema>;

/** 图片输入策略。 */
export const imageSchema = sObj({
  max_size_mb: sNum(5),
  allowed_types: sStrList(["png", "jpeg", "jpg", "gif", "webp"]),
});
export type ImageSection = InferSchema<typeof imageSchema>;

/** 助手身份。 */
export const identitySchema = sObj({
  name: sStr("bi"),
  tagline: sStr(""),
  /** 自定义系统提示词文件路径；空串 = 使用内置。 */
  system_prompt_path: sStr(""),
  /** 追加到系统提示词末尾的附加指令。 */
  extra_instructions: sStr(""),
});
export type IdentitySection = InferSchema<typeof identitySchema>;

/** 工作区文件监听策略。 */
export const watchSchema = sObj({
  enabled: sBool(false),
  /** 文件事件防抖毫秒数。 */
  debounce_ms: sInt(300),
  ignore: sStrList(["node_modules/**", ".git/**", "dist/**"]),
});
export type WatchSection = InferSchema<typeof watchSchema>;

/**
 * hooks 事件面：hook-runner（BI-06.4）20 事件 PascalCase 契约的 snake_case 规范镜像。
 * 两套名字机械互转（纯 Pascal 词序，无连续大写/数字），装载映射归 hooks-adapter。
 */
export const HOOK_EVENTS = [
  "pre_tool_use",
  "post_tool_use",
  "post_tool_use_failure",
  "permission_request",
  "permission_denied",
  "session_start",
  "session_end",
  "pre_compact",
  "post_compact",
  "pre_undo",
  "post_undo",
  "pre_file_write",
  "post_file_write",
  "pre_bash",
  "post_bash",
  "interrupted",
  "date_change",
  "model_fallback",
  "context_overflow",
  "session_fork",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * 早期 5 事件面的兼容别名。prompt_submitted 不在册：hook-runner 20 事件契约无
 * 对应触发点，保留即为永不生效的死配置（schema 校验期整条丢弃并记 issue）。
 */
export const HOOK_EVENT_ALIASES = {
  pre_tool: "pre_tool_use",
  post_tool: "post_tool_use",
} as const;
export type HookEventAlias = keyof typeof HOOK_EVENT_ALIASES;

/** 配置面接受的事件名全集 = 规范 20 事件 + 兼容别名。 */
export const HOOK_EVENT_NAMES = [...HOOK_EVENTS, "pre_tool", "post_tool"] as const;

export const hookEntrySchema = sEntity({
  event: sEnum(HOOK_EVENT_NAMES, "pre_tool_use"),
  /** 待执行的 shell 命令。 */
  command: sStr(""),
  /** 命令超时毫秒。 */
  timeout_ms: sInt(10_000),
  /**
   * 工具名正则匹配器：仅 pre_tool_use / post_tool_use（含兼容别名）事件生效，
   * 其余事件忽略此字段；空串 = 匹配全部工具。装载层（hooks-adapter）校验正则
   * 形态，非法正则整条丢弃。
   */
  matcher: sStr(""),
  /** 是否允许钩子的 block 决策阻断主流程（false = 咨询性钩子，block 降级为记录）。 */
  blocking: sBool(true),
});
export type HookEntry = InferSchema<typeof hookEntrySchema>;

/** Hooks 分区。entries 为数组（整体替换）。 */
export const hooksSchema = sObj({
  enabled: sBool(true),
  entries: sListOf(hookEntrySchema, []),
});
export type HooksSection = InferSchema<typeof hooksSchema>;

/** 遥测（默认关闭）。 */
export const telemetrySchema = sObj({
  enabled: sBool(false),
  /**
   * BI-11.1：true = 会话错误文本输出前经 endpoint-sanitizer 脱敏
   * （main err 面 + headless 错误路径）；缺省 false = 原样输出（现状）。
   */
  sanitize_errors: sBool(false),
});
export type TelemetrySection = InferSchema<typeof telemetrySchema>;

// ---------------------------------------------------------------------------
// [verify] 分区（BI-21.1 任务完工前置自验看门狗）
// ---------------------------------------------------------------------------

/**
 * [verify] deliverable 条目（fail-closed：未知键/类型不符整条丢弃）。
 * path 相对路径由 verifier 以会话 cwd 为 workspaceRoot 解析。
 */
export const verifyDeliverableEntrySchema = sEntity({
  path: sStr(""),
  /** true = 缺失即 gap；false = 缺失容忍（存在时仍核验 must_contain）。 */
  must_exist: sBool(true),
  /** 必须逐条命中的子串清单（数组整体替换）。 */
  must_contain: sStrList([]),
});
export type VerifyDeliverableEntry = InferSchema<typeof verifyDeliverableEntrySchema>;

/**
 * [verify] command 检查条目。TOML 只能声明 command 检查——predicate 是
 * 代码面（不可序列化），config 声明面不假冒该能力。
 */
export const verifyCheckEntrySchema = sEntity({
  /** 检查 ID（gap 清单 checkId）。 */
  id: sStr(""),
  /** 待执行命令串（verifier 白名单仅放行此处 verbatim 声明的命令）。 */
  command: sStr(""),
  /** 人类可读说明。 */
  description: sStr(""),
});
export type VerifyCheckEntry = InferSchema<typeof verifyCheckEntrySchema>;

/** [verify] 分区：完工自验开关 + 目标契约声明面。 */
export const verifySchema = sObj({
  /** true = 无头会话收尾前跑 TargetVerifier；缺省 false = off（零开销零行为差）。 */
  on_completion: sBool(false),
  /** 原始需求陈述（gap 回注时供模型对齐目标）。 */
  objective: sStr(""),
  /** 产物清单（数组整体替换）。 */
  deliverables: sListOf(verifyDeliverableEntrySchema, []),
  /** command 检查清单（数组整体替换）。 */
  checks: sListOf(verifyCheckEntrySchema, []),
});
export type VerifySection = InferSchema<typeof verifySchema>;

export const mcpServerEntrySchema = sEntity({
  /** stdio 启动命令；与 url 二选一。 */
  command: sStr(""),
  args: sStrList([]),
  /** 注入子进程的环境变量（键级合并）。 */
  env: sRecord(sStr("")),
  /** HTTP/SSE 端点（远程 MCP）。 */
  url: sStr(""),
  enabled: sBool(true),
});
export type McpServerEntry = InferSchema<typeof mcpServerEntrySchema>;

/** MCP 服务器注册表（键级合并）。 */
export const mcpSchema = sObj({
  servers: sRecord(mcpServerEntrySchema),
});
export type McpSection = InferSchema<typeof mcpSchema>;

/** A2A（agent-to-agent）服务暴露。 */
export const a2aSchema = sObj({
  enabled: sBool(false),
  listen: sStr("127.0.0.1:0"),
  /** 允许接入的对端标识白名单；空 = 仅本机。 */
  allow: sStrList([]),
});
export type A2aSection = InferSchema<typeof a2aSchema>;

/**
 * 终端外观偏好（`~/.bi/tui.toml` 的顶层即本分区字段）。
 * 渲染实现由 BI-19 消费。
 */
export const tuiSchema = sObj({
  theme: sStr("dark"),
  /** 是否展示思考过程流。 */
  show_thoughts: sBool(true),
  mouse_mode: sBool(true),
  notifications: sBool(true),
  /** 键位绑定：动作名 → 按键序列（键级合并）。 */
  keybindings: sRecord(sStr("")),
});
export type TuiSection = InferSchema<typeof tuiSchema>;

// ---------------------------------------------------------------------------
// [subagent] 分区（BI-07.4 子智能体 + BI-07.6 /btw 旁路问答总开关）
// ---------------------------------------------------------------------------

/**
 * [subagent] 分区：子智能体装配与 /btw 旁路问答的总开关。
 * 缺省 enabled=false = 不装配（缺省路径零变化，既有工具注册表与对话流逐字节等价）。
 * 仅 config 显式声明 [subagent] 才物化（挂载式拓扑，见 BI_CONFIG_SCHEMA 注释），
 * 未声明时恒 undefined，消费方 Optional chaining。
 */
// ---------------------------------------------------------------------------
// [ptc] 分区（BI-16.2 PTC 程序化工具调用 · 注册门）
// ---------------------------------------------------------------------------

/**
 * [ptc] 分区：PTC（Programmatic Tool Calling）脚本工具 run_ptc_script 的注册门
 * 与执行边界。缺省 enabled=false = 不注册（既有工具面零变化）；仅显式声明 [ptc]
 * 才物化（挂载式拓扑，同 [subagent]/[verify]），未声明时恒 undefined。
 * 脚本内 `await tools.<name>(args)` 程序化调用的工具被钉死为 5 件只读子集
 * （read_file/grep/glob/web_search/web_fetch）；bash/edit/write 不开放（程序化
 * 调用禁写禁执行，安全边界在 cli/toolset.ts 工具头注钉死）。
 */
export const ptcSchema = sObj({
  /** true = 注册 run_ptc_script 工具；缺省 false = 不注册（既有工具面零变动）。 */
  enabled: sBool(false),
  /** 单轮脚本执行超时毫秒（缺省 30_000；与 PtcRunner 缺省一致）。 */
  timeout_ms: sInt(30_000),
  /** 工具调用次数上限（缺省 64；与 PtcRunner 缺省一致；0 = 禁止调用）。 */
  max_tool_calls: sInt(64),
});
export type PtcSection = InferSchema<typeof ptcSchema>;

// ---------------------------------------------------------------------------
// [cron] 分区（BI-07.7 会话内 Cron 调度器 · 注册门）
// ---------------------------------------------------------------------------

/**
 * [cron] 分区：会话内 cron 三件套（cron_schedule/cron_list/cron_remove）注册门。
 * 缺省 enabled=false = 不注册（既有工具面零变动）；仅显式声明 [cron] 才物化
 * （挂载式拓扑，同 [subagent]/[verify]）。实际定时触发（CronService.tick）归宿主
 * 运行环——本分区只管条目管理/列表/注销三工具的注册，绝不假冒"已可定时执行"
 * （触发动作 onFire 由 host 注入，core CLI 不 import workflow 的 CronCorePort）。
 */
export const cronSchema = sObj({
  /** true = 注册 cron_schedule/cron_list/cron_remove 三工具；缺省 false = 不注册（既有工具面零变动）。 */
  enabled: sBool(false),
});
export type CronSection = InferSchema<typeof cronSchema>;

// ---------------------------------------------------------------------------
// BI-05.3（W3-D7）· 上下文引擎挂载式分区
// ---------------------------------------------------------------------------

/**
 * [context] 挂载式分区（仿 [verify]/[subagent]/[ptc]/[cron]，不进 17 根键）。
 *
 * 语义钉死：
 * - 全部开关缺省关闭（false / 0），未显式声明时 `config.context === undefined`，
 *   合并结果同样不含 context 键——缺省路径逐字节等价于现状；
 * - 显式声明才物化，并经 backfill 补全叶子默认；
 * - 子键未知/类型不符照常记 issue（不冒充合法）。
 *
 * 接入器官（最小诚实装配，W3-D7）：
 * - time_context：注入当前时钟上下文到 system 面（time-context 器官）；
 * - date_change_sensor：跨日翻转披露（date-change-sensor 器官）；
 * - tool_result_prune：工具结果二级修剪，紧接 boundToolText（tool-result-pruner 器官）；
 * - max_history_entries：历史条目上限裁剪，window-manager 视窗门禁驱动（>0 生效，0 = off）；
 * - timezone：time_context / date_change_sensor 共用的 IANA 时区。
 */
export const contextSchema = sObj({
  /** true = 向 system 面注入当前时钟上下文（时区自适应）；缺省 false = off（逐字节等价）。 */
  time_context: sBool(false),
  /** true = 跨日翻转披露（host 时钟过 00:00 时每自然日至多一次注入提示）；缺省 false = off。 */
  date_change_sensor: sBool(false),
  /** true = 工具结果二级修剪（紧接 boundToolText 之后，>8192 码点保头尾抹中段）；缺省 false = off。 */
  tool_result_prune: sBool(false),
  /** 历史条目上限裁剪（window-manager 视窗门禁驱动）：>0 时每轮保留最近 N 条历史；0 = off（缺省，逐字节等价）。 */
  max_history_entries: sInt(0),
  /** IANA 时区（time_context / date_change_sensor 共用）。缺省 Asia/Shanghai。 */
  timezone: sStr("Asia/Shanghai"),
  /**
   * BI-08.2：image-offload 渐进图像卸载管线门控。true = 接入 image-offload
   * 管线（渐进图像卸载）；缺省 false 行为零变动（逐字节等价于现状）。
   */
  image_offload: sBool(false),
  /**
   * BI-10：AutoCompactor token 水位紧缩门控。true = 接入 AutoCompactor
   * token 水位紧缩；缺省 false 走既有条目数门禁裁剪（逐字节等价于现状）。
   */
  auto_compactor: sBool(false),
});
export type ContextSection = InferSchema<typeof contextSchema>;

/**
 * [memory] 挂载式分区（仿 [verify]/[subagent]/[ptc]/[cron]/[context]，不进 17 根键）。
 *
 * 语义钉死：
 * - 全部开关缺省关闭（false），未显式声明时 `config.memory === undefined`，
 *   合并结果同样不含 memory 键——缺省路径逐字节等价于现状；
 * - 显式声明才物化，并经 backfill 补全叶子默认；
 * - 子键未知/类型不符照常记 issue（不冒充合法）。
 *
 * 接入面（最小诚实装配，W4-D9）：
 * - dream_enabled：无头会话收尾（finalText 落定/正常退出）时调 dream 器官做
 *   沉淀（空闲阈值用器官既有常量、锁文件防并发）；缺省 false = 不沉淀。
 * - inject_enabled：无头会话启动读 <cwd>/BI.dream.md，存在则内容经 systemInstruction
 *   前缀注入（与 --agent-file 共存时 agent-file 优先，dream 追加其后）；缺省 false = 不注入。
 */
export const memorySchema = sObj({
  /** true = 无头会话收尾调 dream 器官沉淀到 <cwd>/BI.dream.md；缺省 false = 不沉淀（缺省路径零变化）。 */
  dream_enabled: sBool(false),
  /** true = 无头会话启动注入 <cwd>/BI.dream.md 内容到 system 面；缺省 false = 不注入。 */
  inject_enabled: sBool(false),
});
export type MemorySection = InferSchema<typeof memorySchema>;

export const subagentSchema = sObj({
  /** true = 注入 SubagentRunner 并经装配面注册 spawn_subagent 模型工具；缺省 false = 不注册（既有工具面零变动）。 */
  enabled: sBool(false),
  /** 子循环最大回合上限（有界，防失控）。 */
  max_iterations: sInt(8),
  /** 子循环单轮超时毫秒（>0 启用协作取消；0 = 不限制，与现状路径等价）。 */
  timeout_ms: sInt(60_000),
  /** 缺省子角色（spawn_subagent 未显式指定 profile 时采用）。 */
  default_profile: sEnum(["explore", "coder", "plan", "fork"] as const, "explore"),
  /** true = 装配 BtwService 供 /btw 旁路问答使用；缺省 false = 不装配。 */
  btw_enabled: sBool(false),
});
export type SubagentSection = InferSchema<typeof subagentSchema>;

// ---------------------------------------------------------------------------
// 根 Schema 与内置默认值
// ---------------------------------------------------------------------------

/**
 * 根分区表（17 个强类型分区；单一事实来源，键序即 DEFAULT_BI_CONFIG 键序）。
 * [verify] 不在表内——挂载方式见 BI_CONFIG_SCHEMA 注释。
 */
const ROOT_SECTION_SCHEMAS = {
  workspace: workspaceSchema,
  providers: providersSchema,
  models: modelsSchema,
  secondary_model: secondaryModelSchema,
  thinking: thinkingSchema,
  loop_control: loopControlSchema,
  tools: toolsSchema,
  permission: permissionSchema,
  read: readSchema,
  image: imageSchema,
  identity: identitySchema,
  watch: watchSchema,
  hooks: hooksSchema,
  telemetry: telemetrySchema,
  mcp: mcpSchema,
  a2a: a2aSchema,
  tui: tuiSchema,
};

const rootSectionsSchema = sObj(ROOT_SECTION_SCHEMAS);

/**
 * BI 根配置 Schema（17 个强类型分区 + 挂载式 [verify]）。
 *
 * 与纯 sObj 根的唯一差异：[verify] 在**校验期**从原始输入摘出单独校验
 * （verifySchema），不进入默认值形状、也不由 backfill 注入——因此
 * DEFAULT_BI_CONFIG / createDefaultConfig() 恒为 17 个根键（既有钉死断言
 * 不红），配置层未声明 [verify] 时合并结果同样不含 verify 键（缺省路径
 * 逐字节等价于现状）；显式声明了才物化，并由 backfill 补全叶子默认。
 * [verify] 子键未知/类型不符照常记 issue（不冒充合法）。
 */
export const BI_CONFIG_SCHEMA: Schema<BiConfig> = makeSchema<BiConfig>(
  (raw, path, issues) => {
    const verifyRaw = isPlainObject(raw) ? raw["verify"] : undefined;
    const subagentRaw = isPlainObject(raw) ? raw["subagent"] : undefined;
    const ptcRaw = isPlainObject(raw) ? raw["ptc"] : undefined;
    const cronRaw = isPlainObject(raw) ? raw["cron"] : undefined;
    const contextRaw = isPlainObject(raw) ? raw["context"] : undefined;
    const memoryRaw = isPlainObject(raw) ? raw["memory"] : undefined;
    const withoutMounted = isPlainObject(raw)
      ? Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "verify" && key !== "subagent" && key !== "ptc" && key !== "cron" && key !== "context" && key !== "memory"))
      : raw;
    const sections = rootSectionsSchema.validateLayer(withoutMounted, path, issues);
    const verifyLayer = verifySchema.validateLayer(verifyRaw, joinPath(path, "verify"), issues);
    const subagentLayer = subagentSchema.validateLayer(subagentRaw, joinPath(path, "subagent"), issues);
    const ptcLayer = ptcSchema.validateLayer(ptcRaw, joinPath(path, "ptc"), issues);
    const cronLayer = cronSchema.validateLayer(cronRaw, joinPath(path, "cron"), issues);
    const contextLayer = contextSchema.validateLayer(contextRaw, joinPath(path, "context"), issues);
    const memoryLayer = memorySchema.validateLayer(memoryRaw, joinPath(path, "memory"), issues);
    if (
      sections === undefined &&
      verifyLayer === undefined &&
      subagentLayer === undefined &&
      ptcLayer === undefined &&
      cronLayer === undefined &&
      contextLayer === undefined &&
      memoryLayer === undefined
    )
      return undefined;
    return {
      ...(isPlainObject(sections) ? sections : {}),
      ...(verifyLayer !== undefined ? { verify: verifyLayer } : {}),
      ...(subagentLayer !== undefined ? { subagent: subagentLayer } : {}),
      ...(ptcLayer !== undefined ? { ptc: ptcLayer } : {}),
      ...(cronLayer !== undefined ? { cron: cronLayer } : {}),
      ...(contextLayer !== undefined ? { context: contextLayer } : {}),
      ...(memoryLayer !== undefined ? { memory: memoryLayer } : {}),
    };
  },
  () => rootSectionsSchema.defaultValue(),
  (value) => {
    rootSectionsSchema.backfill?.(value);
    if (isPlainObject(value) && isPlainObject(value["verify"])) {
      verifySchema.backfill?.(value["verify"]);
    }
    if (isPlainObject(value) && isPlainObject(value["subagent"])) {
      subagentSchema.backfill?.(value["subagent"]);
    }
    if (isPlainObject(value) && isPlainObject(value["ptc"])) {
      ptcSchema.backfill?.(value["ptc"]);
    }
    if (isPlainObject(value) && isPlainObject(value["cron"])) {
      cronSchema.backfill?.(value["cron"]);
    }
    if (isPlainObject(value) && isPlainObject(value["context"])) {
      contextSchema.backfill?.(value["context"]);
    }
    if (isPlainObject(value) && isPlainObject(value["memory"])) {
      memorySchema.backfill?.(value["memory"]);
    }
  },
);

/** 17 个根分区的推导类型（[verify] 之外的完整面）。 */
type RootBiConfig = {
  [K in keyof typeof ROOT_SECTION_SCHEMAS]: InferSchema<(typeof ROOT_SECTION_SCHEMAS)[K]>;
};

/**
 * BI 配置根类型（17 个强类型分区 + 可选 [verify]）。
 * verify 为可选：仅当配置层显式声明 [verify] 时物化（挂载式拓扑，见
 * BI_CONFIG_SCHEMA 注释）；未声明时恒 undefined，消费方 Optional chaining。
 * 可变性与其余 17 分区一致（装载/测试面按分区赋值）。
 */
export type BiConfig = RootBiConfig & { verify?: VerifySection; subagent?: SubagentSection; ptc?: PtcSection; cron?: CronSection; context?: ContextSection; memory?: MemorySection };

/** BiConfig 的顶层分区名联合（供 TUI /config 面板导航使用）。 */
export type BiConfigSectionName = keyof BiConfig;

/** BiConfig 的深层偏类型（配置层 / CLI 覆盖的形态）。 */
export type BiConfigLayer = PartialDeep<BiConfig>;

/** 内置默认值（完整对象；每次访问请通过 `createDefaultConfig()` 获取全新副本）。 */
export const DEFAULT_BI_CONFIG: BiConfig = BI_CONFIG_SCHEMA.defaultValue();

/** 获取一份全新的内置默认配置（深拷贝，避免共享可变引用）。 */
export function createDefaultConfig(): BiConfig {
  return BI_CONFIG_SCHEMA.defaultValue();
}

/**
 * 校验一个配置层（TOML 解析结果 / 环境变量构造对象 / CLI 覆盖对象）。
 * 返回仅含本层显式提供键的偏对象；诊断写入 issues。
 */
export function validateConfigLayer(raw: unknown, issues: ConfigIssue[]): BiConfigLayer | undefined {
  return BI_CONFIG_SCHEMA.validateLayer(raw, "", issues) as BiConfigLayer | undefined;
}

// ---------------------------------------------------------------------------
// 环境变量覆盖映射
// ---------------------------------------------------------------------------

/** 单条环境变量覆盖映射。 */
export interface EnvOverrideSpec {
  env: string;
  /** 配置点分路径（写入根配置对象）。 */
  path: string;
  /** true = 按逗号切分为字符串数组。 */
  list?: boolean;
}

/**
 * 环境变量 → 配置路径映射（优先级高于所有 TOML 层，低于 CLI Flags）。
 * 仅收录标量 / 字符串数组路径；复杂结构请走 local.toml 或 CLI。
 */
export const ENV_OVERRIDES: readonly EnvOverrideSpec[] = [
  { env: "BI_PROVIDER", path: "providers.default" },
  { env: "BI_MODEL", path: "models.default" },
  { env: "BI_SECONDARY_MODEL", path: "secondary_model.subagent" },
  { env: "BI_BACKGROUND_MODEL", path: "secondary_model.background" },
  { env: "BI_THINKING_EFFORT", path: "thinking.effort" },
  { env: "BI_PERMISSION_MODE", path: "permission.mode" },
  { env: "BI_TOOLS_ALLOW", path: "tools.allow", list: true },
  { env: "BI_TOOLS_DENY", path: "tools.deny", list: true },
  { env: "BI_IDENTITY_NAME", path: "identity.name" },
  { env: "BI_WORKSPACE_ADDITIONAL_DIR", path: "workspace.additional_dir" },
] as const;

/**
 * 由环境变量构造一层配置（再经 `validateConfigLayer` 校验后参与合并）。
 * 空串环境变量视为未设置（避免 shell 里 `export BI_MODEL=` 误覆盖）。
 */
export function buildEnvLayer(env: Record<string, string | undefined>): Record<string, unknown> {
  const layer: Record<string, unknown> = {};
  for (const spec of ENV_OVERRIDES) {
    const raw = env[spec.env];
    if (raw === undefined || raw === "") continue;
    setDottedPath(layer, spec.path, spec.list === true ? raw.split(",").map((s) => s.trim()).filter((s) => s !== "") : raw);
  }
  return layer;
}
