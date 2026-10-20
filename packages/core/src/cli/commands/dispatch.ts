/**
 * BI-24.1 —— 子命令分发接线（init/session/fork/export/transfer/acp/upgrade/doctor/vis/config/copy）。
 *
 * 职责：把 main 切出的子命令名与原始剩余 argv 派发到真实处理器，统一退出码语义：
 *   0 = 成功；
 *   1 = 运行期失败（目标缺失 / IO / doctor 有异常发现项）；
 *   2 = 用法错误（未知参数、缺位置参数、非法值）；
 *   3 = 装配凭据类（归 main 无头路径专用，本层不用）；
 *   4 = 已识别但能力不在位（upgrade 无 manifest 源等"能力未配置"场景）。
 * 未知子命令仍 exit 2。
 *
 * 命令落位（器官在库即用，缺器官做结构化 v1，绝不假冒成功）：
 *   init     = 脚手架 .bi/local.toml 模板（resolveConfigPaths 三级拓扑，已存在不覆盖、
 *              报告路径）；追加 BI-05.2 BI.md 草稿面：detectStack + draftBiMd 在 cwd
 *              写 BI.md（已存在不覆盖，检测失败/不支持栈结构化提示，绝不假冒）。
 *   config   = 低频清账：全局 ~/.bi/config.toml 键值面（get/set/list），键面由 schema
 *              默认树推导，写回复用 writeback 注释保留引擎；未知键/非法值结构化报错。
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
 *   upgrade  = BI-29.2 自升级真链（cli/update/upgrade-subcommand.ts 编排 BI-20.7
 *              器官：manifest 下载 → sha256 门 → native-swap 原子换装）。
 *              manifest 源解析：--manifest-url > BI_UPGRADE_MANIFEST_URL > 无源
 *              结构化 exit 4（不假冒检查成功）；--check 只比对不换装。
 *              母体替身（python3 upstream_sync.py 锚点循环门）退役。
 *   doctor   = src/doctor.ts runDoctor 器官（检查项/端口注入，退出码按发现项：
 *              allOk → 0，存在异常 → 1）。
 *   vis      = commands/vis.ts handleVis（BI-20.5b 本地 Web 会话可视化：
 *              Bun.serve 拉起，缺省 127.0.0.1 + 随机端口；非回环强制
 *              BI_VIS_AUTH_TOKEN；只读 API 暴露会话列表 / 消息流 / 分支树 / 工具配对）。
 *
 * 注入面（SubcommandDeps）：会话根目录 / cwd / homeDir / ACP IO 通道 /
 * acp 模型端口工厂（buildModelPort，生产路径由 main/bin 传入）/
 * upgrade 替身 / doctor 检查项替身。测试零外呼：全部用例走注入，零网络。
 */
import { access, mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { resolveConfigPaths } from "../../config/paths";
import { detectStack, draftBiMd } from "../../rules/init-service";
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
import { HTML_THEMES } from "../../export/html-exporter";
import { ForkError, forkSession } from "./fork";
import { listSessions } from "./session";
import { transferCommand } from "./transfer";
import { handleVis } from "./vis";
import {
  runUpgradeSubcommand,
  type UpgradeSubcommandOptions,
} from "../update/upgrade-subcommand";
import { handleConfig } from "./config";
import { handleCopy } from "./copy";

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
  "vis",
  "config",
  "copy",
];

/**
 * 子命令一句话摘要（主 help 对齐列表 + 各子命令 help 头部复用）。
 * 文案与 dispatch 内各 handler 的真实参数面一致（先读 handler 再写，不臆造）。
 */
export const SUBCOMMAND_SUMMARIES: Readonly<Record<string, string>> = {
  init: "脚手架工作区配置（.bi/local.toml）与 BI.md 草稿",
  session: "列出会话元数据（JSON 行，最新在前）",
  fork: "从指定节点分叉新会话",
  export: "导出会话为 markdown / json / html",
  transfer: "脱敏归档导出 / 归档导入",
  acp: "stdio 会话桥接（JSON-RPC 帧）",
  upgrade: "自升级：manifest → sha256 门 → 原子换装",
  doctor: "全链路配置 / 凭据 / 网络体检",
  vis: "本地 Web 会话可视化（Bun.serve）",
  config: "全局配置键值读写（get / set / list）",
  copy: "复制会话字段到剪贴板（或 stdout 降级）",
};

/**
 * 各子命令完整 usage 文案（help 面）。严格对应 dispatch/各 command handler 的真实
 * 参数解析面：位置参数、旗标、合法值范围、真实示例，均从源码实测，不臆造选项。
 * help 优先于用法校验——仅在 handleSubcommand 入口按 --help/-h 短路，不经过各 handler
 * 的 parse 步骤，故不影响任何既有行为语义与退出码。
 */
export const SUBCOMMAND_HELP: Readonly<Record<string, string>> = {
  init: `bi init [--dir <目录>]

  脚手架当前工作区的 .bi/local.toml 模板与 BI.md 草稿。
  已存在则不覆盖（幂等成功）。

参数:
  --dir <目录>   目标工作目录（缺省当前目录）

示例:
  bi init
  bi init --dir ./packages/core`,
  session: `bi session [--limit <n>]

  列出会话元数据（JSON 行，最新在前），汇总条数走 stderr。

参数:
  --limit <n>   最多输出 n 个会话（非负整数；缺省全部）

示例:
  bi session
  bi session --limit 10`,
  fork: `bi fork <sessionId> <nodeId> [--title <标题>]

  从源会话的指定节点分叉出新会话。目标缺失 → 结构化 exit 1。

参数:
  sessionId       源会话 ID（必填）
  nodeId          分叉点节点 ID（必填）
  --title <标题>   新会话标题（可选）

示例:
  bi fork abc123 node456
  bi fork abc123 node456 --title 实验分支`,
  export: `bi export <sessionId> [--format markdown|json|html] [--theme dark|light] [--out <path>]

  导出会话为 markdown / json / html；无 --out 时内容直出 stdout。

参数:
  sessionId          目标会话 ID（必填）
  --format <fmt>     渲染格式：markdown | json | html（缺省 markdown）
  --theme <t>        html 主题：dark | light（仅 --format html 生效）
  --out <path>       落盘路径（缺省直出 stdout）

示例:
  bi export abc123
  bi export abc123 --format html --theme dark --out conv.html
  bi export abc123 --format json`,
  transfer: `bi transfer export --sanitize <sessionId> [--out <path>]
bi transfer import <archive.json>

  脱敏归档导出 / 归档导入（零外呼，脱敏通道）。

子命令:
  export --sanitize <sessionId> [--out <path>]   脱敏导出会话为归档 JSON
  import <archive.json>                           从归档 JSON 重建会话

示例:
  bi transfer export --sanitize abc123
  bi transfer export --sanitize abc123 --out archive.json
  bi transfer import archive.json`,
  acp: `bi acp

  stdio 会话桥接面（JSON-RPC 帧）：v1 握手 + session/new +
  session/prompt + session/end。不吃任何命令行参数，只吃 stdio 帧。

示例:
  bi acp < framed-requests.json`,
  upgrade: `bi upgrade [--check] [--manifest-url <url>]

  自升级真链：manifest 源解析 → sha256 门 → 原子换装。
  无 manifest 源 → 结构化 exit 4（不假冒检查成功）。

参数:
  --check               只比对版本，不换装
  --manifest-url <url>   指定 manifest 源（覆盖 BI_UPGRADE_MANIFEST_URL 环境变量）

示例:
  bi upgrade --check
  bi upgrade --manifest-url https://example.com/manifest.json`,
  doctor: `bi doctor

  全链路体检：配置装载 / 凭据门 / 所配 provider 网络 / 沙箱探针 / 工具注册面。
  exit 按发现项（全部 ok → 0，存在异常 → 1）。

示例:
  bi doctor`,
  vis: `bi vis [sessionId] [--port N] [--host H]

  本地 Web 会话可视化（Bun.serve）。缺省绑 127.0.0.1 + 随机端口。
  非回环绑定强制 BI_VIS_AUTH_TOKEN，缺失则拒绝启动（exit 1）。

参数:
  sessionId        可选，启动后直链到该会话
  --port N         监听端口（0-65535，缺省 0 = 内核随机选空闲）
  --host H         监听地址（缺省 127.0.0.1）

示例:
  bi vis
  bi vis abc123 --port 8080
  bi vis --host 127.0.0.1 --port 5173`,
  config: `bi config get <key> | bi config set <key> <value> | bi config list

  全局 ~/.bi/config.toml 键值面（低频清账）。键面由 schema 默认树推导。

子命令:
  get <key>           读生效值（合并后）
  set <key> <value>   写回全局配置（注释保留引擎；非法值结构化报错）
  list                列出全部合法键 + 当前生效值

示例:
  bi config list
  bi config get identity.name
  bi config set telemetry.enabled true`,
  copy: `bi copy [sessionId] [-f field]

  复制会话字段到剪贴板（或 stdout 降级）。缺省复制「最近会话」的 id。
  三平台剪贴板全缺失 → 降级 stdout（exit 0，不假冒）。

参数:
  sessionId      目标会话 ID（缺省最近会话）
  -f <field>     字段：id | title | last-reply（缺省 id）

示例:
  bi copy
  bi copy abc123 -f title
  bi copy abc123 -f last-reply`,
};

/** help 旗标（短/长）。handleSubcommand 入口短路，帮助优先于用法校验。 */
const SUBCOMMAND_HELP_FLAGS = new Set(["--help", "-h"]);

/** 子命令输出汇（与 main 的 out/err 同形）。 */
export interface SubcommandIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** ACP 输出通道（协议帧字节汇；测试注入收集器）。 */
export interface AcpOutputChannel {
  write(chunk: Uint8Array): void | Promise<void>;
}

/** 子命令注入面：临时根目录 / IO / upgrade 真链注入 / doctor 检查项替身。 */
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
  /** upgrade 注入面（BI-29.2:manifest 源 + 全步替身 checkFn/downloadFn/swapFn/lockFn;测试零外呼）。 */
  upgradeDeps?: UpgradeSubcommandOptions;
  /** doctor 注入：全量检查项替身（优先于 ports；缺省走真实探测端口）。 */
  doctorChecks?: readonly DoctorCheck[];
  /** doctor 注入：部分端口覆盖（未注入 checks 时生效）。 */
  doctorPorts?: Partial<DoctorPorts>;
  /** copy 注入：命令执行替身（探活 + 写入剪贴板）；测试零外呼，缺省走真实进程。 */
  cmdRunner?: import("./copy").CmdRunner;
  /** copy 注入：平台覆盖（缺省由 OSTYPE/process.platform 探测）；测试覆盖三平台分派。 */
  osPlatform?: NodeJS.Platform;
  /** copy 注入：OSTYPE 环境变量覆盖（如 msys/cygwin/linux/darwin）；测试覆盖 GitBash 等。 */
  osType?: string;
  /**
   * vis 注入：令牌轮转权威工厂（BI-20.5 接线）。core 不依赖 tui——轮转引擎在
   * tui 侧，由宿主（bin/bi.ts）注入；仅在 env BI_VIS_TOKEN_ROTATE=1 时生效。
   */
  visTokenAuthority?: import("./vis").VisTokenAuthorityFactory;
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

  // ---- .bi/local.toml 脚手架（语义不变：已存在不覆盖）----
  let localExists = true;
  try {
    await access(paths.localConfig);
  } catch {
    localExists = false;
  }
  if (localExists) {
    io.out(`bi init: ${paths.localConfig} 已存在，不覆盖（如需重建请先手动移除）。`);
  } else {
    await mkdir(paths.localDir, { recursive: true });
    await writeFile(paths.localConfig, LOCAL_TOML_TEMPLATE, "utf8");
    io.out(`bi init: 已写入工作区模板 ${paths.localConfig}`);
  }

  // ---- BI-05.2 BI.md 草稿生成（追加）：detectStack → draftBiMd → 写盘（已存在不覆盖）----
  const biMdPath = join(workDir, "BI.md");
  let biMdExists = true;
  try {
    await access(biMdPath);
  } catch {
    biMdExists = false;
  }
  if (biMdExists) {
    io.out(`bi init: ${biMdPath} 已存在，不覆盖（如需重建请先手动移除）。`);
    return 0;
  }
  let profile;
  try {
    profile = detectStack(workDir);
  } catch (cause) {
    // 检测失败：结构化提示，不假冒成功；脚手架已完成，退出码语义不变
    io.err(
      `bi init: 技术栈探测异常（${cause instanceof Error ? cause.message : String(cause)}）；跳过 BI.md 生成，仅完成脚手架。`,
    );
    return 0;
  }
  const { draft } = draftBiMd(profile, { projectName: basename(workDir) });
  await writeFile(biMdPath, draft, "utf8");
  io.out(`bi init: 已生成 BI.md 草稿 ${biMdPath}（待人工审查，确认后生效）`);
  // 不支持栈（未检测到任何已知清单）：结构化提示，不假冒检测结果
  if (profile.manifests.length === 0) {
    io.err(
      "bi init: 未检测到支持的栈清单（package.json / Cargo.toml / pyproject.toml / go.mod / Makefile / pnpm-workspace.yaml）；" +
        "已生成标注「未检测到」的 BI.md 草稿，请人工补全技术栈信息。",
    );
  }
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
// export —— 会话导出 markdown/json/html（BI-20.2 / BI-20.3 库面）
// ---------------------------------------------------------------------------

/** `bi export <sessionId> [--format markdown|json|html] [--theme dark|light] [--out <path>]`；无 --out 时内容直出。 */
async function handleExport(rest: readonly string[], io: SubcommandIo, deps: SubcommandDeps): Promise<number> {
  const args = parseSubArgs(rest, new Set<string>(["--format", "--out", "--theme"]));
  if (args.positionals.length !== 1) {
    throw new SubUsageError("用法: bi export <sessionId> [--format markdown|json|html] [--theme dark|light] [--out <path>]");
  }
  const sessionId = args.positionals[0];
  if (sessionId === undefined) {
    throw new SubUsageError("用法: bi export <sessionId> [--format markdown|json|html] [--theme dark|light] [--out <path>]");
  }
  const format = args.flags.get("--format");
  if (format !== undefined && format !== "markdown" && format !== "json" && format !== "html") {
    throw new SubUsageError(`--format 非法: ${String(format)}（允许: markdown | json | html）`);
  }
  const outPath = args.flags.get("--out");
  const theme = args.flags.get("--theme");
  if (
    theme !== undefined &&
    (typeof theme !== "string" || !HTML_THEMES.includes(theme as (typeof HTML_THEMES)[number]))
  ) {
    throw new SubUsageError(`--theme 非法: ${String(theme)}（允许: dark | light）`);
  }
  const options: ExportOptions = {};
  if (format === "markdown" || format === "json" || format === "html") options.format = format;
  if (typeof outPath === "string") options.out = outPath;
  if (theme !== undefined && format === "html") options.theme = theme as (typeof HTML_THEMES)[number];

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
// upgrade —— 自升级真链（BI-29.2;BI-20.7 器官上妆,母体锚点替身退役）
// ---------------------------------------------------------------------------

/** `bi upgrade [--check] [--manifest-url <url>]`:manifest 源解析 → 真实升级链。 */
async function handleUpgrade(rest: readonly string[], io: SubcommandIo, deps: SubcommandDeps): Promise<number> {
  const args = parseSubArgs(rest, new Set<string>(["--manifest-url"]), new Set<string>(["--check"]));
  if (args.positionals.length > 0) {
    throw new SubUsageError(`upgrade 不接受位置参数: ${args.positionals.join(" ")}`);
  }
  const flagUrl = args.flags.get("--manifest-url");
  const manifestUrl =
    typeof flagUrl === "string"
      ? flagUrl
      : (deps.upgradeDeps?.manifestUrl ?? process.env.BI_UPGRADE_MANIFEST_URL ?? "");
  return runUpgradeSubcommand(
    {
      ...(deps.upgradeDeps !== undefined ? deps.upgradeDeps : {}),
      checkOnly: args.flags.has("--check"),
      manifestUrl,
    },
    io,
  );
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
// vis —— 本地 Web 会话可视化（BI-20.5b；cli/commands/vis.ts 处理器）
// ---------------------------------------------------------------------------

/** `bi vis [sessionId] [--port N] [--host H]`：本地 Web 会话可视化（缺省 127.0.0.1 + 随机端口；非回环强制 BI_VIS_AUTH_TOKEN）。 */
async function handleVisCommand(rest: readonly string[], io: SubcommandIo, deps: SubcommandDeps): Promise<number> {
  return handleVis(rest, io, deps, {
    attachSignals: false,
    // BI-20.5 接线：令牌轮转权威（宿主注入；env BI_VIS_TOKEN_ROTATE=1 时才启用）。
    ...(deps.visTokenAuthority !== undefined ? { tokenAuthority: deps.visTokenAuthority } : {}),
  });
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
  vis: handleVisCommand,
  config: handleConfig,
  copy: handleCopy,
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
  // 帮助面：帮助优先于用法校验——入口按 --help/-h 短路，不经 handler 的 parse 步骤，
  // 不影响任何既有行为语义与退出码（约束 #1：只加帮助面）。
  if (restArgs.some((token) => SUBCOMMAND_HELP_FLAGS.has(token))) {
    io.out(SUBCOMMAND_HELP[name] ?? `bi ${name}: 暂无用法说明。`);
    return 0;
  }
  try {
    return await handler(restArgs, io, deps);
  } catch (cause) {
    // 用法错误：本层 SubUsageError（init/session/fork/export/acp/upgrade/doctor）
    // 与 vis.ts 自带同名 SubUsageError 共用类名——按名兜底捕获，避免跨模块循环依赖；
    // 统一归 exit 2 并追加 help 提示。
    const isUsageError =
      cause instanceof SubUsageError ||
      (cause instanceof Error && cause.name === "SubUsageError");
    if (isUsageError) {
      io.err(`bi ${name}: ${(cause as Error).message}`);
      io.err(`运行 bi ${name} --help 查看用法`);
      return 2;
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    io.err(`bi ${name}: 失败: ${message}`);
    return 1;
  }
}
