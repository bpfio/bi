/**
 * BI-24.1 —— 八子命令分发接线（init/session/fork/export/transfer/acp/upgrade/doctor）。
 *
 * 职责：把 main 切出的子命令名与原始剩余 argv 派发到真实处理器，统一退出码语义：
 *   0 = 成功；
 *   1 = 运行期失败（目标缺失 / IO / doctor 有异常发现项）；
 *   2 = 用法错误（未知参数、缺位置参数、非法值）；
 *   3 = 装配凭据类（归 main 无头路径专用，本层不用）；
 *   4 = 已识别但能力不在位（upgrade 锚点引擎脚本缺失等"器官不在库"场景）。
 * 未知子命令仍 exit 2。
 *
 * 命令落位（器官在库即用，缺器官做结构化 v1，绝不假冒成功）：
 *   init     = 新建 v1：脚手架 .bi/local.toml 模板（resolveConfigPaths 三级拓扑，
 *              已存在不覆盖、报告路径）。BI-05.2 的 BI.md 草稿面（cli/sub/init.ts）
 *              不在本卡范围，留待后续装配卡合并。
 *   session  = commands/session.ts listSessions（BI-03 SessionManager.listSessions
 *              列举 + 元数据，JSON 行输出）。
 *   fork     = commands/fork.ts forkSession（BI-03 manager.fork 的 CLI 面）。
 *   export   = commands/export.ts exportSession（markdown / json 渲染 + 落盘）。
 *   transfer = commands/transfer.ts transferCommand（脱敏导出 / 归档导入）。
 *   acp      = BI-25.2 会话桥接面（commands/acp-session.ts，core 侧镜像
 *              @bi/mcp AcpBridge 协议形状）：v1 握手帧 + session/new
 *              （SessionManager 落 JSONL，回 sessionId）+ session/prompt
 *              （模型端口经 SubcommandDeps.buildModelPort 注入，文本增量以
 *              session/update 通知流式回执，单会话单飞忙拒绝 -32004）+
 *              session/end（优雅收束）。工具调用更新帧/取消语义/多会话并行
 *              归后续卡（诚实边界见 acp-session.ts 头注）。
 *   upgrade  = 新建 v1：BI-00 锚点循环门语义——探测
 *              /home/yupeng/bi-ledger-ops/upstream_sync.py 存在性并执行 check
 *              子命令（--no-net 透传）。真实子进程仅生产路径；测试一律注入
 *              probe/check 替身。脚本缺失 → 结构化 exit 4，不执行 check。
 *   doctor   = src/doctor.ts runDoctor 器官（检查项/端口注入，退出码按发现项：
 *              allOk → 0，存在异常 → 1）。
 *
 * 注入面（SubcommandDeps）：会话根目录 / cwd / homeDir / ACP IO 通道 /
 * acp 模型端口工厂（buildModelPort，生产路径由 main/bin 传入）/
 * upgrade 替身 / doctor 检查项替身。测试零外呼：全部用例走注入，零网络。
 */
import { execFile } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { resolveConfigPaths } from "../../config/paths";
import { SessionManager } from "../../session/manager";
import { TransferError } from "../../session/transfer";
import {
  formatDoctorReport,
  runDoctor,
  type DoctorCheck,
  type DoctorPorts,
} from "../../doctor";
import type { ModelPort } from "../headless";
import { createStdioChannels } from "./acp-command";
import { AcpSessionConnection } from "./acp-session";
import { ExportError, exportSession, type ExportOptions } from "./export";
import { ForkError, forkSession } from "./fork";
import { listSessions } from "./session";
import { transferCommand } from "./transfer";

/** 已接线的子命令全集（main 用法文本与子命令定位共用）。 */
export const SUBCOMMANDS: readonly string[] = [
  "init",
  "session",
  "fork",
  "export",
  "transfer",
  "acp",
  "upgrade",
  "doctor",
];

/** BI-00 锚点引擎（仓库外执行体；RULE-BI-08 升级追踪铁律的循环门载体）。 */
export const DEFAULT_UPGRADE_SCRIPT = "/home/yupeng/bi-ledger-ops/upstream_sync.py";

/** 子命令输出汇（与 main 的 out/err 同形）。 */
export interface SubcommandIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** ACP 输出通道（协议帧字节汇；测试注入收集器）。 */
export interface AcpOutputChannel {
  write(chunk: Uint8Array): void | Promise<void>;
}

/** upgrade check 步结果（注入替身与真实子进程共用形状）。 */
export interface UpgradeCheckResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 子命令注入面：临时根目录 / IO / upgrade 检查替身 / doctor 检查项替身。 */
export interface SubcommandDeps {
  /** 工作目录（init 脚手架定位等；缺省 process.cwd()）。 */
  cwd?: string;
  /** 用户主目录（resolveConfigPaths 三级拓扑注入；测试必须给临时目录）。 */
  homeDir?: string;
  /** 会话存储根目录（session/fork/export/transfer；缺省 ~/.bi/sessions）。 */
  sessionsRoot?: string;
  /** ACP 注入 stdin（缺省真实 stdio；测试必须注入）。 */
  acpInput?: ReadableStream<Uint8Array>;
  /** ACP 注入 stdout（缺省真实 stdout；测试必须注入）。 */
  acpOutput?: AcpOutputChannel;
  /**
   * ACP 注入：模型端口工厂（session/prompt 每回合调用一次）。生产路径由
   * main/bin 传入配置装配的真实端口（BI-23.3 resolveModelPort）；测试注入
   * 脚本化替身。未注入时 session/prompt 结构化 -32005 拒绝执行（不假冒）。
   */
  buildModelPort?: () => ModelPort | Promise<ModelPort>;
  /** 锚点引擎脚本路径（缺省 DEFAULT_UPGRADE_SCRIPT）。 */
  upgradeScriptPath?: string;
  /** 注入：脚本存在性探测替身（缺省 fs.access 真实探测）。 */
  upgradeProbe?: (scriptPath: string) => boolean | Promise<boolean>;
  /** 注入：check 步替身（缺省 python3 真实子进程；测试一律注入，零外呼）。 */
  upgradeCheck?: (input: {
    scriptPath: string;
    args: readonly string[];
  }) => Promise<UpgradeCheckResult>;
  /** doctor 注入：全量检查项替身（优先于 ports；缺省走真实探测端口）。 */
  doctorChecks?: readonly DoctorCheck[];
  /** doctor 注入：部分端口覆盖（未注入 checks 时生效）。 */
  doctorPorts?: Partial<DoctorPorts>;
}

// ---------------------------------------------------------------------------
// 子命令 argv 切分与轻量旗标解析
// ---------------------------------------------------------------------------

/**
 * 定位子命令 token：跳过全局旗标及其值之后的首个裸词。
 *
 * 为什么在 main 之外重扫：parseGlobalArgs 的旗标矩阵只认 4 个全局旗标，
 * 子命令自己的旗标（--limit / --format / --no-net …）一旦混进全局解析会被
 * 误报 unknown-flag。因此首个子命令裸词之后的 token 全部原样切给
 * handleSubcommand，由各命令自持旗标面解析。
 * `--prompt session` 这类"值恰为子命令名"的写法不受影响（值已被消费跳过）。
 */
export function findSubcommandIndex(argv: readonly string[]): number {
  const valueFlags = new Set(GLOBAL_FLAG_NAMES);
  let afterDoubleDash = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) break; // noUncheckedIndexedAccess 防御
    if (afterDoubleDash) {
      // `--` 之后全是位置参数：首词与裸词子命令同判
      return SUBCOMMANDS.includes(token) ? i : -1;
    }
    if (token === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (valueFlags.has(token)) {
      i += 1; // 单值全局旗标：消费其值
      continue;
    }
    if (token.startsWith("--")) continue; // =value 形式 / 未知旗标交 parseGlobalArgs 报错
    return SUBCOMMANDS.includes(token) ? i : -1;
  }
  return -1;
}

/** 全局旗标名（与 commands/args.ts GLOBAL_ARGS 保持同名单；避免循环依赖不 import）。 */
const GLOBAL_FLAG_NAMES: readonly string[] = ["--agent-file", "--add-dir", "--prompt", "--output-format"];

/** 子命令轻量旗标解析结果：值旗标存字符串，布尔旗标存 true。 */
interface SubArgs {
  positionals: string[];
  flags: Map<string, string | true>;
}

/** 子命令用法错误（handleSubcommand 统一归 exit 2）。 */
class SubUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubUsageError";
  }
}

/**
 * 解析 `--flag value` / `--flag=value` / 布尔 `--flag` 三种形态；
 * 未知旗标、缺值、重复出现一律抛 SubUsageError。
 */
function parseSubArgs(
  rest: readonly string[],
  valueFlags: ReadonlySet<string>,
  booleanFlags: ReadonlySet<string> = new Set<string>(),
): SubArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  let i = 0;
  while (i < rest.length) {
    const token = rest[i];
    i += 1;
    if (token === undefined) break; // noUncheckedIndexedAccess 防御
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const flag = eq === -1 ? token : token.slice(0, eq);
    if (valueFlags.has(flag)) {
      const rawValue = eq === -1 ? rest[i++] : token.slice(eq + 1);
      if (rawValue === undefined || rawValue === "" || rawValue.startsWith("-")) {
        throw new SubUsageError(`参数 ${flag} 缺少值`);
      }
      if (flags.has(flag)) throw new SubUsageError(`参数重复: ${flag}`);
      flags.set(flag, rawValue);
      continue;
    }
    if (booleanFlags.has(flag)) {
      if (eq !== -1) throw new SubUsageError(`参数 ${flag} 不接受值（布尔旗标）`);
      if (flags.has(flag)) throw new SubUsageError(`参数重复: ${flag}`);
      flags.set(flag, true);
      continue;
    }
    throw new SubUsageError(`未知参数: ${token}`);
  }
  return { positionals, flags };
}

/** 会话管理器装配：sessionsRoot 注入优先，缺省 ~/.bi/sessions（生产路径）。 */
function makeSessionManager(deps: SubcommandDeps): SessionManager {
  return new SessionManager(
    deps.sessionsRoot !== undefined ? { rootDir: deps.sessionsRoot } : {},
  );
}

// ---------------------------------------------------------------------------
// init —— 脚手架 .bi/local.toml 模板（新建 v1）
// ---------------------------------------------------------------------------

/** local.toml 模板：只列 workspace 分区的典型覆盖项，注释说明三级拓扑。 */
const LOCAL_TOML_TEMPLATE = `# bi 工作区私有覆盖（.bi/local.toml，不入版本库）
# 三级拓扑: ~/.bi/config.toml（全局运行）→ ~/.bi/tui.toml（外观）→ .bi/local.toml（工作区私有）
# 只写需要覆盖的键；删除键或留空 = 沿用全局缺省。

[workspace]
# 附加可访问工作目录（主工作目录之外额外授权访问）；空串 = 未启用
additional_dir = ""
# 文件遍历是否尊重 .gitignore
respect_gitignore = true
`;

/** `bi init [--dir <目录>]`：脚手架 .bi/local.toml 模板；已存在不覆盖（幂等成功）。 */
async function handleInit(rest: readonly string[], io: SubcommandIo, deps: SubcommandDeps): Promise<number> {
  const args = parseSubArgs(rest, new Set<string>(["--dir"]));
  if (args.positionals.length > 0) {
    throw new SubUsageError(`init 不接受位置参数: ${args.positionals.join(" ")}`);
  }
  const dirArg = args.flags.get("--dir");
  const workDir = resolve(deps.cwd ?? process.cwd(), typeof dirArg === "string" ? dirArg : ".");
  const paths = resolveConfigPaths({
    ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
    workDir,
  });
  const target = paths.localConfig;
  let exists = true;
  try {
    await access(target);
  } catch {
    exists = false;
  }
  if (exists) {
    io.out(`bi init: ${target} 已存在，不覆盖（如需重建请先手动移除）。`);
    return 0;
  }
  await mkdir(paths.localDir, { recursive: true });
  await writeFile(target, LOCAL_TOML_TEMPLATE, "utf8");
  io.out(`bi init: 已写入工作区模板 ${target}`);
  return 0;
}

// ---------------------------------------------------------------------------
// session —— 列表 + 元数据（BI-20.2 库面）
// ---------------------------------------------------------------------------

/** `bi session [--limit <n>]`：JSON 行逐条输出会话元数据（最新在前），汇总行走 err。 */
async function handleSession(rest: readonly string[], io: SubcommandIo, deps: SubcommandDeps): Promise<number> {
  const args = parseSubArgs(rest, new Set<string>(["--limit"]));
  if (args.positionals.length > 0) {
    throw new SubUsageError(`session 不接受位置参数: ${args.positionals.join(" ")}`);
  }
  let limit: number | undefined;
  const rawLimit = args.flags.get("--limit");
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== "string" || !/^\d+$/.test(rawLimit)) {
      throw new SubUsageError(`--limit 需要非负整数: ${typeof rawLimit === "string" ? rawLimit : String(rawLimit)}`);
    }
    limit = Number.parseInt(rawLimit, 10);
  }
  const manager = makeSessionManager(deps);
  const metas = await listSessions(manager, limit === undefined ? {} : { limit });
  for (const meta of metas) {
    io.out(JSON.stringify(meta));
  }
  io.err(`bi session: 共 ${metas.length} 个会话`);
  return 0;
}

// ---------------------------------------------------------------------------
// fork —— 会话分支（BI-20.2 库面）
// ---------------------------------------------------------------------------

/** `bi fork <sessionId> <nodeId> [--title <标题>]`；目标缺失 → exit 1 结构化。 */
async function handleFork(rest: readonly string[], io: SubcommandIo, deps: SubcommandDeps): Promise<number> {
  const args = parseSubArgs(rest, new Set<string>(["--title"]));
  if (args.positionals.length !== 2) {
    throw new SubUsageError("用法: bi fork <sessionId> <nodeId> [--title <标题>]");
  }
  const sourceId = args.positionals[0];
  const atNode = args.positionals[1];
  if (sourceId === undefined || atNode === undefined) {
    throw new SubUsageError("用法: bi fork <sessionId> <nodeId> [--title <标题>]");
  }
  const manager = makeSessionManager(deps);
  const title = args.flags.get("--title");
  try {
    const result = await forkSession(
      manager,
      sourceId,
      atNode,
      typeof title === "string" ? { title } : {},
    );
    io.out(`bi fork: 新会话 ${result.newSessionId}（分叉点 ${result.branchFrom}，自 ${sourceId}）`);
    return 0;
  } catch (cause) {
    if (cause instanceof ForkError) {
      io.err(`bi fork: ${cause.message}`);
      return 1;
    }
    throw cause;
  }
}

// ---------------------------------------------------------------------------
// export —— 会话导出 markdown/json（BI-20.2 库面）
// ---------------------------------------------------------------------------

/** `bi export <sessionId> [--format markdown|json] [--out <path>]`；无 --out 时内容直出。 */
async function handleExport(rest: readonly string[], io: SubcommandIo, deps: SubcommandDeps): Promise<number> {
  const args = parseSubArgs(rest, new Set<string>(["--format", "--out"]));
  if (args.positionals.length !== 1) {
    throw new SubUsageError("用法: bi export <sessionId> [--format markdown|json] [--out <path>]");
  }
  const sessionId = args.positionals[0];
  if (sessionId === undefined) {
    throw new SubUsageError("用法: bi export <sessionId> [--format markdown|json] [--out <path>]");
  }
  const format = args.flags.get("--format");
  if (format !== undefined && format !== "markdown" && format !== "json") {
    throw new SubUsageError(`--format 非法: ${String(format)}（允许: markdown | json）`);
  }
  const outPath = args.flags.get("--out");
  const options: ExportOptions = {};
  if (format === "markdown" || format === "json") options.format = format;
  if (typeof outPath === "string") options.out = outPath;

  const manager = makeSessionManager(deps);
  try {
    const result = await exportSession(manager, sessionId, options);
    if (result.writtenTo !== undefined) {
      io.out(`bi export: 已写入 ${result.writtenTo}`);
    } else {
      io.out(result.content);
    }
    return 0;
  } catch (cause) {
    if (cause instanceof ExportError) {
      io.err(`bi export: ${cause.message}`);
      return cause.code === "invalid-format" ? 2 : 1;
    }
    throw cause;
  }
}

// ---------------------------------------------------------------------------
// transfer —— 脱敏导出 / 归档导入（BI-20.4 库面）
// ---------------------------------------------------------------------------

/** `bi transfer export --sanitize <id> [--out <p>] | bi transfer import <archive.json>`。 */
async function handleTransfer(rest: readonly string[], io: SubcommandIo, deps: SubcommandDeps): Promise<number> {
  const manager = makeSessionManager(deps);
  try {
    const result = await transferCommand(manager, rest);
    if (result.command === "export") {
      if (result.writtenTo !== undefined) {
        io.out(`bi transfer: 脱敏归档已写入 ${result.writtenTo}`);
      } else {
        io.out(result.content);
      }
      io.err(`bi transfer: export ${result.sessionId}（${result.entries} 条）`);
    } else {
      io.out(`bi transfer: 已导入 ${result.sessionId}（${result.entries} 条）`);
    }
    return 0;
  } catch (cause) {
    if (cause instanceof TransferError) {
      io.err(`bi transfer: ${cause.message}`);
      return cause.code === "usage" ? 2 : 1;
    }
    throw cause;
  }
}

// ---------------------------------------------------------------------------
// acp —— 会话桥接面（BI-25.2；协议本体在 commands/acp-session.ts）
// ---------------------------------------------------------------------------

/** `bi acp`：stdio 会话桥接（注入 IO + 注入模型端口；汇总走 err，协议 stdout 纯净）。 */
async function handleAcp(rest: readonly string[], io: SubcommandIo, deps: SubcommandDeps): Promise<number> {
  if (rest.length > 0) {
    throw new SubUsageError("acp 不接受参数（会话桥接面只吃 stdio 帧）");
  }
  // 仅在缺注入时才装配真实 stdio（测试两通道齐注 → 不触碰真实 stdin）
  const needsStdio = deps.acpInput === undefined || deps.acpOutput === undefined;
  const stdio = needsStdio ? createStdioChannels() : undefined;
  const input = deps.acpInput ?? stdio?.input;
  const output = deps.acpOutput ?? stdio?.output;
  if (input === undefined || output === undefined) {
    io.err("bi acp: IO 通道装配失败（注入不完整）");
    return 1;
  }
  const manager = makeSessionManager(deps);
  try {
    const stats = await new AcpSessionConnection({
      input,
      output,
      manager,
      ...(deps.buildModelPort !== undefined ? { buildModelPort: deps.buildModelPort } : {}),
    }).run();
    io.err(
      `bi acp: 连接收束 initialize=${stats.initialize} sessionNew=${stats.sessionNew}` +
        ` prompt=${stats.promptTurns} busy=${stats.busyRefusals} sessionEnd=${stats.sessionEnds}` +
        ` notify=${stats.notifications} methodNotFound=${stats.methodNotFound} parseError=${stats.parseErrors}` +
        "（BI-25.2 会话桥接：session/new + session/prompt + session/end；" +
        "工具调用更新帧/取消语义/多会话并行归后续卡）",
    );
    return 0;
  } catch (cause) {
    io.err(`bi acp: 通道异常: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// upgrade —— BI-00 锚点循环门（新建 v1；真实子进程仅生产路径）
// ---------------------------------------------------------------------------

const execFileP = promisify(execFile);

/** 缺省脚本存在性探测：fs.access。 */
async function probeScriptPresent(scriptPath: string): Promise<boolean> {
  try {
    await access(scriptPath);
    return true;
  } catch {
    return false;
  }
}

/** 缺省 check 步：python3 真实子进程执行 upstream_sync.py check（仅生产路径）。 */
async function realUpgradeCheck(scriptPath: string, args: readonly string[]): Promise<UpgradeCheckResult> {
  try {
    const r = await execFileP("python3", [scriptPath, ...args], {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (error) {
    const e = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? String(error),
    };
  }
}

/** `bi upgrade [--no-net]`：探测锚点引擎存在性 → 执行 check；脚本缺失 → exit 4。 */
async function handleUpgrade(rest: readonly string[], io: SubcommandIo, deps: SubcommandDeps): Promise<number> {
  const args = parseSubArgs(rest, new Set<string>(), new Set<string>(["--no-net"]));
  if (args.positionals.length > 0) {
    throw new SubUsageError(`upgrade 不接受位置参数: ${args.positionals.join(" ")}`);
  }
  const scriptPath = deps.upgradeScriptPath ?? DEFAULT_UPGRADE_SCRIPT;
  const present =
    deps.upgradeProbe !== undefined ? await deps.upgradeProbe(scriptPath) : await probeScriptPresent(scriptPath);
  if (!present) {
    io.err(`bi upgrade: 锚点引擎不在位（${scriptPath}）——BI-00 锚点循环门未装配，本次退出。`);
    return 4;
  }
  const checkArgs = args.flags.has("--no-net") ? ["check", "--no-net"] : ["check"];
  const result =
    deps.upgradeCheck !== undefined
      ? await deps.upgradeCheck({ scriptPath, args: checkArgs })
      : await realUpgradeCheck(scriptPath, checkArgs);
  if (result.stdout.trim().length > 0) {
    io.out(result.stdout.replace(/\n$/, ""));
  }
  if (result.code === 0) {
    io.err(`bi upgrade: check 完成（${scriptPath}）`);
    return 0;
  }
  if (result.stderr.trim().length > 0) {
    io.err(result.stderr.replace(/\n$/, ""));
  }
  io.err(`bi upgrade: check 失败（exit ${result.code}）`);
  return 1;
}

// ---------------------------------------------------------------------------
// doctor —— 全链路体检（src/doctor.ts 器官）
// ---------------------------------------------------------------------------

/** `bi doctor`：注入检查项/端口 → 结构化报告；exit 按发现项（allOk → 0，异常 → 1）。 */
async function handleDoctor(rest: readonly string[], io: SubcommandIo, deps: SubcommandDeps): Promise<number> {
  const args = parseSubArgs(rest, new Set<string>(), new Set<string>());
  if (args.positionals.length > 0) {
    throw new SubUsageError(`doctor 不接受位置参数: ${args.positionals.join(" ")}`);
  }
  const report = await runDoctor({
    ...(deps.doctorChecks !== undefined ? { checks: deps.doctorChecks } : {}),
    ...(deps.doctorPorts !== undefined ? { ports: deps.doctorPorts } : {}),
  });
  io.out(formatDoctorReport(report));
  return report.allOk ? 0 : 1;
}

// ---------------------------------------------------------------------------
// 查表派发入口
// ---------------------------------------------------------------------------

type SubcommandHandler = (
  rest: readonly string[],
  io: SubcommandIo,
  deps: SubcommandDeps,
) => Promise<number>;

const DISPATCH: Readonly<Record<string, SubcommandHandler>> = {
  init: handleInit,
  session: handleSession,
  fork: handleFork,
  export: handleExport,
  transfer: handleTransfer,
  acp: handleAcp,
  upgrade: handleUpgrade,
  doctor: handleDoctor,
};

/**
 * 八子命令派发入口：查表执行；用法错误统一 exit 2，未捕获运行期错误
 * 结构化上报后 exit 1（不假冒成功、不漏栈）。
 */
export async function handleSubcommand(
  name: string,
  restArgs: readonly string[],
  io: SubcommandIo,
  deps: SubcommandDeps = {},
): Promise<number> {
  const handler = DISPATCH[name];
  if (handler === undefined) {
    io.err(`bi: 未知子命令 "${name}"`);
    return 2;
  }
  try {
    return await handler(restArgs, io, deps);
  } catch (cause) {
    if (cause instanceof SubUsageError) {
      io.err(`bi ${name}: ${cause.message}`);
      return 2;
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    io.err(`bi ${name}: 失败: ${message}`);
    return 1;
  }
}
