/**
 * BI-20.2 —— 全局参数矩阵定义与解析器（只做定义与解析，不做消费接线）。
 *
 * kimi 对应物: apps/kimi-code/src/cli/sub/args.ts（全局旗标面）
 * 差异边界:
 *   - 本卡仅提供 GLOBAL_ARGS 矩阵 + parseGlobalArgs 纯解析器；解析结果的
 *     消费（--agent-file 加载 agent 定义、--add-dir 注入可访问目录、
 *     --prompt 无头启动、--output-format 流式输出）归属 BI-20.1 / 后续装配方；
 *   - 仅支持长参：`--flag value` 与 `--flag=value` 两种传值形式；不支持
 *     短参捆绑；单值 flag 重复出现 → duplicate-flag；可重复 flag（--add-dir）
 *     聚合为数组；
 *   - 结构化错误：unknown-flag / missing-value / invalid-value / duplicate-flag；
 *   - 空格传值时，后随以 `-` 开头的 token 视为缺值（需要 `-` 开头的字面值
 *     请用等号形式，如 `--prompt=--continue`）；单独 `-` 同理视为缺值；
 *   - `--` 之后一律视为位置参数；裸位置参数（如子命令名）收进 positionals，
 *     子命令派发归属装配方，不在本解析器报错。
 */

export interface GlobalArgSpec {
  /** 长参名（含前导 --）。 */
  flag: string;
  /** 值占位说明（如 "<path.md>"）。 */
  valueName: string;
  /** 一句话说明（帮助渲染用）。 */
  description: string;
  /** 是否可重复出现（重复时聚合为数组）。 */
  repeatable: boolean;
  /** 合法值白名单；缺省不校验值域。 */
  allowedValues?: readonly string[];
}

/** 全局参数矩阵（合约定义；消费接线归属 BI-20.1 / 后续装配方）。 */
export const GLOBAL_ARGS: readonly GlobalArgSpec[] = [
  {
    flag: "--agent-file",
    valueName: "<path.md>",
    description: "agent 定义文件（markdown）路径",
    repeatable: false,
  },
  {
    flag: "--add-dir",
    valueName: "<dir>",
    description: "附加可访问工作目录（可多次出现）",
    repeatable: true,
  },
  {
    flag: "--prompt",
    valueName: "<text>",
    description: "无头模式提示词",
    repeatable: false,
  },
  {
    flag: "--output-format",
    valueName: "<format>",
    description: "输出格式",
    repeatable: false,
    allowedValues: ["stream-json"],
  },
];

export type OutputFormat = "stream-json";

export interface ParsedArgs {
  /** --agent-file 的值。 */
  agentFile?: string;
  /** --add-dir 聚合值（保持出现顺序）。 */
  addDirs: string[];
  /** --prompt 的值。 */
  prompt?: string;
  /** --output-format 的值（已过白名单校验）。 */
  outputFormat?: OutputFormat;
  /** 位置参数（`--` 后或裸词；子命令派发归属装配方）。 */
  positionals: string[];
}

export type ArgErrorCode = "unknown-flag" | "missing-value" | "invalid-value" | "duplicate-flag";

export class ArgParseError extends Error {
  constructor(
    readonly code: ArgErrorCode,
    message: string,
    readonly flag?: string,
  ) {
    super(message);
    this.name = "ArgParseError";
  }
}

/** 解析全局参数矩阵；未知/缺值/非法值/重复单值均抛结构化 ArgParseError。 */
export function parseGlobalArgs(argv: readonly string[]): ParsedArgs {
  const specs = new Map(GLOBAL_ARGS.map((spec) => [spec.flag, spec]));
  const result: ParsedArgs = { addDirs: [], positionals: [] };
  const seen = new Set<string>();
  let afterDoubleDash = false;

  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    i += 1;
    if (token === undefined) break; // noUncheckedIndexedAccess 防御

    if (afterDoubleDash) {
      result.positionals.push(token);
      continue;
    }
    if (token === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!token.startsWith("--")) {
      result.positionals.push(token); // 裸词（子命令名等），派发归属装配方
      continue;
    }

    let flag = token;
    let inlineValue: string | undefined;
    const eq = token.indexOf("=");
    if (eq !== -1) {
      flag = token.slice(0, eq);
      inlineValue = token.slice(eq + 1);
    }

    const spec = specs.get(flag);
    if (spec === undefined) {
      throw new ArgParseError(
        "unknown-flag",
        `未知参数: ${flag}（支持: ${GLOBAL_ARGS.map((s) => s.flag).join(" ")}）`,
        flag,
      );
    }
    if (!spec.repeatable && seen.has(flag)) {
      throw new ArgParseError("duplicate-flag", `参数重复: ${flag}（该参数只允许出现一次）`, flag);
    }
    seen.add(flag);

    let value = inlineValue;
    if (value === undefined) {
      const next = argv[i];
      if (next === undefined || next.startsWith("-")) {
        throw new ArgParseError(
          "missing-value",
          `参数 ${flag} 缺少值（需要 ${spec.valueName}）`,
          flag,
        );
      }
      value = next;
      i += 1;
    }

    if (spec.allowedValues !== undefined && !spec.allowedValues.includes(value)) {
      throw new ArgParseError(
        "invalid-value",
        `参数 ${flag} 的值非法: ${value}（允许: ${spec.allowedValues.join(" | ")}）`,
        flag,
      );
    }

    if (spec.flag === "--agent-file") result.agentFile = value;
    else if (spec.flag === "--add-dir") result.addDirs.push(value);
    else if (spec.flag === "--prompt") result.prompt = value;
    else if (spec.flag === "--output-format") result.outputFormat = value as OutputFormat;
  }

  return result;
}
