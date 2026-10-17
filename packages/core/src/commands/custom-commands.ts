/**
 * BI-01.2 — 自定义斜杠命令引擎: ~/.bi/commands/ 与 .bi/commands/ 下的 *.md 命令文件。
 *
 * frontmatter 声明 name/description/args; 模板体支持类 Shell 参数注入:
 * $ARGUMENTS 全文、$1..$n 位置参数、{{args}} 双花括号形态。
 * 未提供参数的必选占位 → 结构化错误 (不抛异常, 与 compact.ts 同风格)。
 *
 * 安全边界: 本文件只做命令发现与文本展开, 不执行任何 Shell/子进程;
 * 文件系统经 injectFs 注入 (零 node:fs 依赖), 变量展开归 shell-expansion.ts,
 * 命令真实执行归 BI-06 调度表面。零依赖; strict。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 注入文件系统端口: 发现器经此读目录与文件 (禁止直接 import node:fs)。 */
export interface CommandFs {
  /** 列出目录下的条目名 (不含路径; 目录不存在时应 reject 或返回空)。 */
  readdir(path: string): Promise<string[]>;
  /** 读取 UTF-8 文本文件; 文件不可读时 reject。 */
  readFile(path: string): Promise<string>;
}

/** 单条自定义命令的解析产物。 */
export interface SlashCommand {
  /** 斜杠名 (不含前导 /): frontmatter name 优先, 缺省取文件名去 .md。 */
  name: string;
  /** 描述 (TUI 补全用); 缺省空串。 */
  description: string;
  /** args 声明原文 (如 `<query> [limit]`); 缺省空串。 */
  argsSpec: string;
  /** 必选位置参数名 (argsSpec 中 `<...>` 依序)。 */
  requiredArgs: string[];
  /** 可选位置参数名 (argsSpec 中 `[...]` 依序)。 */
  optionalArgs: string[];
  /** 来源文件路径 (发现顺序内的拼接路径)。 */
  sourceFile: string;
  /** frontmatter 之后的模板体 (原样保留, 展开 在 expandCommand 进行)。 */
  body: string;
}

/** 结构化错误 (与 compact.ts 的 CommandError 判别联合同风格)。 */
export type SlashCommandError =
  | { code: 'missing-required'; message: string; missing: string[] }
  | { code: 'invalid-frontmatter'; message: string; file: string };

export type SlashParse = { ok: true; text: string } | { ok: false; error: SlashCommandError };

/** 单文件发现失败告警 (不中断整体发现)。 */
export interface DiscoveryWarning {
  file: string;
  message: string;
}

/** 发现结果: 命令注册表 + 非致命告警。 */
export interface DiscoveryResult {
  commands: SlashCommand[];
  warnings: DiscoveryWarning[];
}

/** TUI 补全列表条目形态 (调度表面的最小表面)。 */
export interface SlashCommandSurfaceEntry {
  name: string;
  description: string;
}

// ---------------------------------------------------------------------------
// frontmatter 解析
// ---------------------------------------------------------------------------

/** 提取文件名末端段 (零 path 依赖, 手工拼接已由调用方保证分隔符)。 */
export function baseName(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/** 拼接目录与条目名 (容忍目录尾随 /)。 */
export function joinPath(dir: string, entry: string): string {
  if (dir.endsWith('/')) return dir + entry;
  return dir + '/' + entry;
}

/**
 * 解析 frontmatter: 仅识别文件头部 `---` 围栏内的 `key: value` 行。
 * 返回 null 表示无 frontmatter 围栏 (首行非 ---); 围栏未闭合视为畸形。
 */
export function parseFrontmatter(
  source: string,
): { fields: Record<string, string>; body: string; malformed: boolean } {
  const lines = source.split('\n');
  if ((lines[0] ?? '').trim() !== '---') {
    return { fields: {}, body: source, malformed: false };
  }
  const fields: Record<string, string> = {};
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() === '---') {
      endIdx = i;
      break;
    }
    const line = lines[i] ?? '';
    const sep = line.indexOf(':');
    if (sep <= 0) continue; // 非法行静默跳过 (注释/空行)
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key !== '') fields[key] = value;
  }
  if (endIdx === -1) {
    // 围栏未闭合: 畸形, 全文当 body 交由上层告警
    return { fields: {}, body: source, malformed: true };
  }
  const body = lines.slice(endIdx + 1).join('\n');
  return { fields, body, malformed: false };
}

/**
 * 解析 args 声明: `<name>` = 必选位置参数, `[name]` = 可选位置参数 (依序)。
 * 其余字符 (空格、字面词) 忽略。返回 [必选名数组, 可选名数组]。
 */
export function parseArgsSpec(spec: string): [string[], string[]] {
  const required: string[] = [];
  const optional: string[] = [];
  const pattern = /<([^<>]+)>|\[([^\[\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(spec)) !== null) {
    if (m[1] !== undefined) {
      required.push(m[1].trim());
    } else if (m[2] !== undefined) {
      optional.push(m[2].trim());
    }
  }
  return [required, optional];
}

// ---------------------------------------------------------------------------
// 参数注入
// ---------------------------------------------------------------------------

/**
 * 类 Shell 参数注入到模板体:
 * - `$ARGUMENTS` 与 `{{args}}` → argv 全文 (单空格连接);
 * - `$1..$n` → 第 n 个位置参数 (越界 → 空串; `$0` 不展开, 保留字面);
 * - 越界的可选位置 → 空串。
 * 必选占位不足 → missing-required 结构化错误。
 */
export function expandCommand(cmd: SlashCommand, argv: string[]): SlashParse {
  const missing: string[] = [];
  for (let i = 0; i < cmd.requiredArgs.length; i++) {
    const name = cmd.requiredArgs[i] ?? '';
    if (argv[i] === undefined || argv[i] === '') missing.push(name);
  }
  if (missing.length > 0) {
    return {
      ok: false,
      error: {
        code: 'missing-required',
        message: `/${cmd.name} 缺少必选参数: ${missing.join(', ')} (声明: ${cmd.argsSpec})`,
        missing,
      },
    };
  }
  const full = argv.join(' ');
  // 单遍扫描: 展开产物只写入输出、永不被重扫 (参数内容含 $1/$ARGUMENTS/{{args}}
  // 字面时不二次展开 —— 注入安全)。
  const body = cmd.body;
  let out = '';
  let i = 0;
  while (i < body.length) {
    if (body.startsWith('{{args}}', i)) {
      out += full;
      i += '{{args}}'.length;
      continue;
    }
    if (body.startsWith('$ARGUMENTS', i)) {
      out += full;
      i += '$ARGUMENTS'.length;
      continue;
    }
    const ch = body[i] ?? '';
    if (ch === '$') {
      let j = i + 1;
      let digits = '';
      while (j < body.length && (body[j] ?? '') >= '0' && (body[j] ?? '') <= '9') {
        digits += body[j] ?? '';
        j += 1;
      }
      if (digits !== '') {
        const n = Number(digits);
        if (n > 0) {
          out += argv[n - 1] ?? ''; // 越界可选 → 空串; $0 走下方字面
          i = j;
          continue;
        }
      }
    }
    out += ch; // $0、$(、$$ 等非位置形态保留字面
    i += 1;
  }
  return { ok: true, text: out };
}

// ---------------------------------------------------------------------------
// 发现
// ---------------------------------------------------------------------------

/** 单目录展开: 读取 *.md 并解析为 SlashCommand; 缺目录 → 空 (容忍)。 */
async function discoverDir(dir: string, fs: CommandFs): Promise<[SlashCommand[], DiscoveryWarning[]]> {
  const commands: SlashCommand[] = [];
  const warnings: DiscoveryWarning[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [commands, warnings]; // 缺目录容错: 静默跳过
  }
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const file = joinPath(dir, entry);
    let source: string;
    try {
      source = await fs.readFile(file);
    } catch (err) {
      warnings.push({ file, message: `读取失败: ${String(err)}` });
      continue;
    }
    const fm = parseFrontmatter(source);
    if (fm.malformed) {
      warnings.push({ file, message: 'frontmatter 围栏未闭合 (---)' });
      continue;
    }
    const fallbackName = entry.slice(0, -3);
    const declaredName = fm.fields['name'] ?? '';
    const [requiredArgs, optionalArgs] = parseArgsSpec(fm.fields['args'] ?? '');
    commands.push({
      name: declaredName !== '' ? declaredName : fallbackName,
      description: fm.fields['description'] ?? '',
      argsSpec: fm.fields['args'] ?? '',
      requiredArgs,
      optionalArgs,
      sourceFile: file,
      body: fm.body,
    });
  }
  return [commands, warnings];
}

/**
 * 扫描多目录的 *.md 自定义命令。dirs 依优先序排列: 同名冲突时
 * 下标靠前者优先 (先到先得, 后到者丢弃)。缺目录不报错 (跳过)。
 */
export async function discoverSlashCommands(dirs: string[], injectFs: CommandFs): Promise<DiscoveryResult> {
  const commands: SlashCommand[] = [];
  const warnings: DiscoveryWarning[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const [dirCommands, dirWarnings] = await discoverDir(dir, injectFs);
    for (const w of dirWarnings) warnings.push(w);
    for (const cmd of dirCommands) {
      if (seen.has(cmd.name)) continue; // 优先序: 先注册者胜
      seen.add(cmd.name);
      commands.push(cmd);
    }
  }
  return { commands, warnings };
}

// ---------------------------------------------------------------------------
// 调度表面
// ---------------------------------------------------------------------------

/**
 * 返回 TUI 补全列表形态的注册表 (name + description)。
 * 纯函数: 保序输出 (即发现优先序), 不排序不去重 (发现器已去重)。
 */
export function slashCommandSurface(commands: readonly SlashCommand[]): SlashCommandSurfaceEntry[] {
  return commands.map((cmd) => ({ name: cmd.name, description: cmd.description }));
}
