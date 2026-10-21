/**
 * BI-24.x —— `bi config` 子命令：全局 `~/.bi/config.toml` 键值面（低频清账）。
 *
 * 动作面：
 *   bi config get <key>          读生效值（合并后）；未知键结构化报错并列出合法键
 *   bi config set <key> <value>  写回 globalConfig；非法值结构化报错（schema 校验）
 *   bi config list               列出全部合法键 + 当前生效值
 *
 * 键面（单一事实来源）：由 `createDefaultConfig()` 默认配置树推导的所有标量叶子
 * （string / number / boolean / string[]），跳过表 / 记录 / 实体 / 实体数组。
 * 不硬编码任何键名，零与 schema 漂移。
 *
 * 写回策略（诚实备案）：复用 writeback 引擎（planConfigWriteback）做注释保留的
 * 键级回写，并经 smol-toml 语法守卫；原子落盘（同目录临时文件 + rename）。
 * 不硬性保证格式/顺序之外的任何呈现（保留注释与顺序是引擎附带收益，非契约）。
 *
 * 注入面：homeDir 经由 SubcommandDeps 注入（与 dispatch 既有模式一致），测试走
 * 临时目录，绝不触碰真实 ~/.bi。
 */
import type { SubcommandDeps, SubcommandIo } from "./dispatch";
import { ConfigService } from "../../config/config-service";
import { resolveConfigPaths } from "../../config/paths";
import {
  writebackConfigFile,
  type TomlValue,
  type WritebackEdit,
} from "../../config/writeback";
import {
  createDefaultConfig,
  setDottedPath,
  validateConfigLayer,
  verifySchema,
  subagentSchema,
  ptcSchema,
  cronSchema,
  contextSchema,
  memorySchema,
  sessionSchema,
  visSchema,
  type BiConfig,
  type ConfigIssue,
  type Schema,
} from "../../config/schema";

/** 子命令用法错误（handleSubcommand 统一归 exit 2）。 */
class ConfigUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigUsageError";
  }
}

/** 在嵌套对象中按点分路径取叶子值；路径不存在返回 undefined。 */
function navigate(node: unknown, dotted: string): unknown {
  let cursor: unknown = node;
  for (const segment of dotted.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** 把配置值渲染为可读单行：布尔→true/false，数字→字符串，数组→TOML 数组字面量。 */
export function renderConfigValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return `[ ${value.map((v) => (typeof v === "string" ? JSON.stringify(v) : String(v))).join(", ")} ]`;
  }
  if (value === null || value === undefined) return "(未设置)";
  return String(value);
}

/**
 * 挂载式分区（不进 DEFAULT_BI_CONFIG 的 17 根键，但可经 `bi config` 配置）。
 * 单一事实来源 = schema.ts 的分区 schema；本表只做"键面挂载"与"缺省解析"两件事，
 * 不引入任何硬编码键名，零与 schema 漂移。
 */
export const MOUNTED_SECTIONS: Readonly<Record<string, Schema<unknown>>> = {
  verify: verifySchema,
  subagent: subagentSchema,
  ptc: ptcSchema,
  cron: cronSchema,
  context: contextSchema,
  memory: memorySchema,
  session: sessionSchema,
  vis: visSchema,
};

/**
 * 把挂载式分区的 schema 缺省回填进配置树：仅当该分区在合并结果中未显式声明时
 * 才补其 schema 默认（缺省路径零行为差——消费方读到的值与器官装配门读取点一致：
 * 未声明时恒为分区 schema 缺省）。已声明分区保持合并值不动。
 * 用于 get/list 读取缺省态、set 选取强类型化样本。绝不改动 schema 的
 * DEFAULT_BI_CONFIG 根键表（恒 17 根）。
 */
export function withMountedDefaults(config: BiConfig): BiConfig {
  const merged = { ...config } as Record<string, unknown>;
  for (const name of Object.keys(MOUNTED_SECTIONS)) {
    if (merged[name] === undefined) {
      merged[name] = MOUNTED_SECTIONS[name]!.defaultValue();
    }
  }
  return merged as BiConfig;
}

/**
 * 推导键值面：默认配置树中所有标量叶子（含 string[]），跳过表 / 记录 / 实体 / 实体数组。
 * 由 schema 默认树推导，单一事实来源：
 *   - 原始值（string/number/boolean）= 叶子；
 *   - 数组：空数组或全字符串数组视为可设置 string[] 叶子（实体表默认空，设值会被 schema 校验拒绝）；
 *   - 非字符串非空数组（实体表）跳过；对象（表/记录）递归。
 * 另挂载八分区（verify/subagent/ptc/cron/context/memory/session/vis）的 schema 叶子（分区前径），
 * 其缺省不进 DEFAULT_BI_CONFIG 根键树，故单独从分区 schema 默认推导。
 */
export function configKeySurface(): string[] {
  const defaults = createDefaultConfig();
  const keys: string[] = [];
  const walk = (node: unknown, prefix: string[]): void => {
    if (Array.isArray(node)) {
      const isStringList = node.length === 0 || node.every((e) => typeof e === "string");
      if (isStringList) keys.push(prefix.join("."));
      return;
    }
    if (node === null || typeof node !== "object") {
      keys.push(prefix.join("."));
      return;
    }
    for (const key of Object.keys(node as Record<string, unknown>)) {
      walk((node as Record<string, unknown>)[key], [...prefix, key]);
    }
  };
  walk(defaults, []);
  for (const [name, schema] of Object.entries(MOUNTED_SECTIONS)) {
    walk(schema.defaultValue(), [name]);
  }
  return keys.sort();
}

/** CLI 字符串值 → 按目标叶子类型强类型化；类型不符返回结构化错误。 */
export function coerceConfigValue(raw: string, sample: unknown): { value?: TomlValue; error?: string } {
  if (typeof sample === "boolean") {
    const low = raw.toLowerCase();
    if (low === "true") return { value: true };
    if (low === "false") return { value: false };
    return { error: `非法布尔值 "${raw}"（允许 true | false）` };
  }
  if (typeof sample === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) return { error: `非法数字 "${raw}"` };
    return { value: n };
  }
  if (Array.isArray(sample)) {
    // string[]：按逗号切分、去空白、丢弃空串
    const items = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    return { value: items };
  }
  // string 叶子：原样
  return { value: raw };
}

/**
 * `bi config` 派发：解析动作 + 位置参数，统一退出码语义
 * （0 成功 / 2 用法错误与未知键 / 其它运行期异常归 1）。
 */
export async function handleConfig(
  rest: readonly string[],
  io: SubcommandIo,
  deps: SubcommandDeps,
): Promise<number> {
  if (rest.length === 0) {
    io.err("bi config: 缺少动作（用法: bi config get <key> | bi config set <key> <value> | bi config list）");
    return 2;
  }
  const action = rest[0];
  const args = rest.slice(1);
  const surface = configKeySurface();

  try {
    if (action === "list") {
      if (args.length > 0) throw new ConfigUsageError("list 不接受参数");
      const service = new ConfigService({ homeDir: deps.homeDir, workDir: deps.homeDir });
      const config = withMountedDefaults(await service.load());
      for (const key of surface) {
        io.out(`${key} = ${renderConfigValue(navigate(config, key))}`);
      }
      return 0;
    }

    if (action === "get") {
      if (args.length !== 1) throw new ConfigUsageError("用法: bi config get <key>");
      const key = args[0]!;
      if (!surface.includes(key)) {
        throw new UnknownConfigKeyError(key, surface);
      }
      const service = new ConfigService({ homeDir: deps.homeDir, workDir: deps.homeDir });
      const value = navigate(withMountedDefaults(await service.load()), key);
      io.out(renderConfigValue(value));
      return 0;
    }

    if (action === "set") {
      if (args.length !== 2) throw new ConfigUsageError("用法: bi config set <key> <value>");
      const key = args[0]!;
      const rawValue = args[1]!;
      if (!surface.includes(key)) {
        throw new UnknownConfigKeyError(key, surface);
      }
      const sample = navigate(withMountedDefaults(createDefaultConfig()), key);
      const coerced = coerceConfigValue(rawValue, sample);
      if (coerced.error !== undefined) {
        io.err(`bi config: ${coerced.error}`);
        return 2;
      }
      // schema 校验：把强类型化值作为一层喂入，捕获枚举/类型/整型等非法值
      const layer: Record<string, unknown> = {};
      setDottedPath(layer, key, coerced.value);
      const issues: ConfigIssue[] = [];
      validateConfigLayer(layer, issues);
      const keyIssue = issues.find((i) => i.path === key || i.path.startsWith(`${key}.`));
      if (keyIssue !== undefined) {
        io.err(`bi config: 非法值 "${rawValue}" 用于 ${key}：${keyIssue.message}`);
        return 2;
      }
      const paths = resolveConfigPaths({
        ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
      });
      const edit: WritebackEdit = { path: key.split("."), value: coerced.value! };
      const plan = await writebackConfigFile(paths.globalConfig, [edit]);
      if (!plan.changed) {
        io.out(`bi config: ${key} 值未变化（${paths.globalConfig}）`);
      } else {
        io.out(`bi config: 已写入 ${key} = ${renderConfigValue(coerced.value)}（${paths.globalConfig}）`);
      }
      return 0;
    }

    throw new ConfigUsageError(`未知动作 "${action}"（允许: get | set | list）`);
  } catch (cause) {
    if (cause instanceof ConfigUsageError) {
      io.err(`bi config: ${cause.message}`);
      io.err("运行 bi config --help 查看用法");
      return 2;
    }
    if (cause instanceof UnknownConfigKeyError) {
      io.err(`bi config: 未知配置键 "${cause.key}"。`);
      io.err(`合法键（共 ${cause.legal.length} 个）: ${cause.legal.join(", ")}`);
      io.err("运行 bi config --help 查看用法");
      return 2;
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    io.err(`bi config: 失败: ${message}`);
    return 1;
  }
}

/** 未知配置键（结构化错误，附带合法键清单）。 */
class UnknownConfigKeyError extends Error {
  readonly key: string;
  readonly legal: readonly string[];
  constructor(key: string, legal: readonly string[]) {
    super(`未知配置键 "${key}"`);
    this.name = "UnknownConfigKeyError";
    this.key = key;
    this.legal = legal;
  }
}
