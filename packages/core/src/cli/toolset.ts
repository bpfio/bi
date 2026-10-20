/**
 * 缺省工具注册表面：buildDefaultToolset(cwd, options?) → ToolBinding[]。
 *
 * 职责边界（装配层只包装，器官零改动；ToolBinding 合约见 cli/headless.ts）：
 * - read_file：参考 cli/headless.test.ts readFileSyncBinding 形状（resolve + 逃逸
 *   守卫 + Bun.file 读文本）。守卫边界较参考形状收紧一档：路径段级前缀
 *   （root + sep），兄弟目录同前缀（/w → /w2）不再漏放。
 * - web_fetch：挂 BI-07.15 fetchWebPage（手动重定向/超时预算/字节上限/结构化
 *   WebFetchError 全在器官内）；readOnly:true = 无文件写语义。
 * - web_search：挂 BI-07.15 webSearch + DeepSeekSearchProvider（唯一已装配
 *   ProviderPort）。密钥走 api_key_env 同款间接引用语义：执行时读环境变量
 *   （缺省 DEEPSEEK_API_KEY），未设置 = 结构化报错，绝不假冒结果。
 * - bash（BI-28.1）：spawn(["bash","-c",command])，cwd=工具集根，stdin:"ignore"；
 *   默认超时 60_000ms，超时 kill 并标注 timedOut；stdout+stderr 合并，仅保留
 *   末尾 100KB（头部截断加标记行）；返回 JSON {exitCode, output, timedOut?,
 *   truncated?}；exitCode 非 0 不抛错（命令失败是正常工具结果）。spawn 经
 *   options.spawnImpl 注入（缺省真实 Bun.spawn；测试全走注入替身，零实弹）。
 * - edit / write（BI-28.2）：路径守卫 →（edit: 唯一性替换）→ atomicWriteFile
 *   原子写（utils/atomic-write.ts，同目录临时文件 + rename）。edit 的
 *   old_string 0 命中、或 >1 命中且未 replace_all = 结构化报错（报匹配数）；
 *   write 允许新建文件，父目录必须已存在。edit/write 的守卫在读写之前执行
 *   （较工单顺序更紧一档：根外路径一律 path-escape，绝不读入其内容）。
 * - glob / grep（BI-28.5）：只读两件。glob = Bun.Glob 扫描（零依赖；--embed rg
 *   面维持缓议，本卡不接，见 globBinding 注释）。grep = 递归正则扫描：跳过
 *   node_modules/隐藏条目（.git/.bi 等点开头目录与文件）、二进制文件（NUL
 *   启发式）、超 1MB 单文件；命中 200 条封顶 + 输出超 10KB 保留尾部（与 bash
 *   截断风格一致）。两件都走 assertInsideRoot + PathJail read 裁决；grep 再
 *   逐文件过 PathJail read（凭据文件名/工作区 .env 不入扫描结果，防内容外泄，
 *   与器官读语义一致）。
 * - run_js（BI-16.1）：CodeMode JS 沙箱（器官 = a2a 包 vm-runner，node:vm 纯计算，
 *   零工具注入）——禁网络/禁 fs；timeout_ms 请求值 clamp 上限 1000ms；execute 返回
 *   JSON {ok:true,value,console?} / {ok:false,error}。门控 codemode 开启才挂载。
 * - 信号透传：web 两器官自身不带 AbortSignal，绑定层 withSignal 竞出 abort
 *   （中止即 reject，绝不悬挂）；bash 自带 abort 竞出（先 kill 子进程再
 *   reject）；edit/write 的 fs 段走 withSignal；read_file 同步读无需透传。
 *
 * 安全接线（BI-28.1/28.2 探明结论与边界备案）：
 * - shell-scan（src/sandbox/shell-scan.ts，注意在 sandbox/ 非 guard/）：bash 的
 *   argSummary 经 scanShell 纯函数分类，dangerous/opaque 时在命令摘要尾部追加
 *   `[shell-scan:…]` 标注（审批浮层可见；不阻断执行，manual 态 ask 由门禁出）。
 *   标注为后缀形态：前缀锚定的权限规则（如 `Bash(git *)`）不受影响；带标注的
 *   参数串会话记忆键与无标注串不同（dangerous 请求须单独裁决，属期望语义）。
 * - os-sandbox（src/sandbox/os-sandbox.ts）：landlock/bwrap/seatbelt 探针与
 *   OsSandbox 包装属重量级运行时装配（probe + 平台后端选择），本卡不接线；
 *   子进程沙箱 e2e 归 BI-28.4（工单允许的成本备案，不阻塞）。
 * - PathJail（src/sandbox/path-jail.ts）：edit/write 在段级前缀逃逸守卫之外，
 *   接入 checkPath(abs,"write") 第二层（家目录保护清单 / 工作区 .env / 凭据
 *   文件名 / 工作区外写拦）。bash 不接 PathJail——它是路径级器官，命令词级
 *   路径策略（checkScan 组合裁决）归 BI-28.4 评估。
 * - 原子写：复用 utils/atomic-write.ts atomicWriteFile（零新造轮子）。
 * - tools/bash.ts 已有更重的 runBash 器官（进程组击杀/环形缓冲/cwd 标记帧），
 *   本卡按工单规格在绑定层直实现；与 runBash 的合流归 BI-28.4 评估。
 *
 * 执行测试零外呼零实弹：fetch 经 BuildDefaultToolsetOptions.fetchImpl 注入
 * 替身；bash 经 BuildDefaultToolsetOptions.spawnImpl 注入替身（绝不真实执行
 * 命令）；fs 用临时目录。
 */

import { readFileSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import type { ToolBinding } from "./headless";
import { fetchWebPage, type FetchExecutor } from "../tools/web-fetch";
import {
	webSearch,
	TokenBucketRateLimiter,
	TtlResultCache,
	DEFAULT_SEARCH_RPS,
} from "../tools/web-search";
import { DeepSeekSearchProvider } from "../tools/search-providers/deepseek-search";
import { scanShell } from "../sandbox/shell-scan";
import { PathJail } from "../sandbox/path-jail";
import { atomicWriteFile } from "../utils/atomic-write";
import { ReadFileStateMap } from "../tool/read-file-state";
import { matchOldText } from "../tool/edit-matchers";
// BI-16.1：CodeMode JS 沙箱工具面（run_js；器官 = a2a 包 vm-runner，经相对路径桥接）。
import { makeCodemodeTool } from "../tool/codemode-tool";
import { UserQuestionService } from "../interaction/user-questions";
import { AskUserTool, ASK_USER_QUESTION_TOOL_SPEC } from "../interaction/ask-user-tool";
import { SubagentRunner } from "../subagent/runner";
import { spawnSubagentBinding } from "./subagent-adapter";
import { runPtcScript, type PtcRunResult } from "../ptc/ptc-runner";
import { CronService, type CronEntry } from "../cron/cron-service";
import { CronTools } from "../cron/cron-tools";
import { readMediaFile, type ReadMediaFileArgs, type ReadMediaFileDeps, type ReadMediaFileResult } from "../tool/handlers/read-media-file";
import { JobRegistry, type JobId } from "../jobs/job-registry";
import { JobTools, JOB_LIST_TOOL_SPEC, JOB_OUTPUT_TOOL_SPEC, JOB_KILL_TOOL_SPEC } from "../jobs/job-tools";
// BI-13.2：LSP 符号级导航器官（@bi/mcp 包，核心层按相对路径桥接；server 经 lspClient 注入缝）。
import { createLspTool, LSP_OPERATIONS, type LspToolClientLike } from "../../../mcp/src/lsp/lsp-tool";
// BI-07.8：AgentSwarm 蜂群器官（runner 经 swarmRunner 注入缝）。
import { AgentSwarmTool, AGENT_SWARM_TOOL_SPEC } from "../subagent/swarm/agent-swarm-tool";
import type { SwarmService } from "../subagent/swarm/swarm-service";
// BI-07.9：Skill 声明式技能器官（registry 经 skillRegistry 注入缝；缺省 node:fs 端口）。
import { SkillTool, SKILL_TOOL_SPEC } from "../subagent/skill-tool";
import { SkillRegistry, type SkillFsPort } from "../subagent/skill-executor";
// BI-13.1/BI-13.3：select_tools 工具接线（registry 后端 = buildCatalog 紧凑名录）。
// 器官零改动：createToolActivator 处理器 + buildCatalog/flattenBudget 名录压缩器均为只读器官。
import {
	createToolActivator,
	type ActivatedToolLike,
	type SelectToolsRegistryLike,
	type UnknownToolRefusalLike,
	type SurfaceByteStatsLike,
} from "../tools/tool-activator";
import {
	buildCatalog,
	flattenBudget,
	type CatalogRoot,
	type CatalogSource,
} from "../mcp/tool-catalog";
import { summarizeToolLine } from "../mcp/catalog-summarizer";

// ---------------------------------------------------------------------------
// 公共面
// ---------------------------------------------------------------------------

/** web_search 密钥缺省环境变量名（api_key_env 间接引用语义）。 */
export const DEFAULT_SEARCH_API_KEY_ENV = "DEEPSEEK_API_KEY";

/** bash 子进程结构最小面（Bun.spawn 返回值的结构子集；测试注入替身用）。 */
export interface SpawnedProcess {
	/** 进程退出码（kill 后照常落定，如 SIGKILL → 137）。 */
	readonly exited: Promise<number>;
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
	/** 超时/中止路径的击杀入口（缺省实现发 SIGKILL）。 */
	kill(): void;
}

/** bash spawn 选项（绑定层所需的最小面）。 */
export interface BashSpawnOptions {
	readonly cwd: string;
	readonly stdin: "ignore";
	readonly stdout: "pipe";
	readonly stderr: "pipe";
}

/** spawn 注入面：bash 工具离屏测试的唯一出口（缺省真实 Bun.spawn）。 */
export type SpawnImpl = (cmd: readonly string[], options: BashSpawnOptions) => SpawnedProcess;

/** bash 默认超时（毫秒）。 */
export const DEFAULT_BASH_TOOL_TIMEOUT_MS = 60_000;
/** bash 输出保留末尾的字节上限（100KB，超出截头部并加标记行）。 */
export const BASH_OUTPUT_TAIL_LIMIT_BYTES = 100 * 1024;
/** bash argSummary 命令截断长度（权限门审计面）。 */
export const BASH_ARG_SUMMARY_MAX = 120;
/** bash 输出截断标记行（加在保留尾部之前）。 */
export const BASH_TRUNCATION_MARKER = "[bi] bash 输出超过 100KB，仅保留末尾 100KB（头部已截断）";

/** glob 结果条数上限（超出截断并标注 truncated；防巨型树拖垮上下文）。 */
export const GLOB_RESULT_LIMIT = 500;
/** grep 命中条数上限（超出截断并标注 truncated）。 */
export const GREP_MATCH_LIMIT = 200;
/** grep 输出保留末尾的字节上限（10KB，风格与 bash 尾部截断一致）。 */
export const GREP_OUTPUT_TAIL_LIMIT_BYTES = 10 * 1024;
/** grep 单文件参与扫描的大小上限（超过整文件跳过，防巨文件/伪装文本拖垮）。 */
export const GREP_FILE_SIZE_LIMIT_BYTES = 1024 * 1024;
/** grep 输出截断标记行（加在保留尾部之前）。 */
export const GREP_TRUNCATION_MARKER = "[bi] grep 输出超过 10KB，仅保留末尾 10KB（头部已截断）";

/** 缺省 spawn 实现：真实 Bun.spawn（测试绝不触达——全部经 spawnImpl 注入替身）。 */
const defaultSpawnImpl: SpawnImpl = (cmd, options) => {
	const proc = Bun.spawn([...cmd], { ...options });
	return {
		exited: proc.exited,
		stdout: proc.stdout as ReadableStream<Uint8Array>,
		stderr: proc.stderr as ReadableStream<Uint8Array>,
		kill: () => proc.kill("SIGKILL"),
	};
};

/** buildDefaultToolset 选项（全部可选；主控接线只需 buildDefaultToolset(cwd)）。 */
export interface BuildDefaultToolsetOptions {
	/** 注入 fetch 执行器（web 两工具离屏执行测试用）；缺省全局 fetch。 */
	readonly fetchImpl?: FetchExecutor;
	/** web_search 密钥环境变量名；缺省 DEFAULT_SEARCH_API_KEY_ENV。 */
	readonly searchApiKeyEnv?: string;
	/** 环境变量源（密钥解析用）；缺省 process.env。 */
	readonly env?: Record<string, string | undefined>;
	/** 注入 spawn 执行器（bash 工具离屏测试用，零实弹）；缺省真实 Bun.spawn。 */
	readonly spawnImpl?: SpawnImpl;
	/**
	 * 注入 UserQuestionService：提供后 ask_user_question 工具才注册进工具数组
	 * （缺省不挂，保持既有 8 件工具注册表面零变动）。host 运行环负责实例与
	 * 回答注入；本卡仅做绑定装配。
	 */
	readonly userQuestionService?: UserQuestionService;
	/**
	 * ask_user_question 可交互（TTY）开关：缺省按 process.stdout.isTTY 判定。
	 * headless（无 TTY）场景置 false：工具结构化返回 {answered:false,reason:"no-interactive"}，
	 * 不悬挂不抛。仅当 userQuestionService 提供时生效。
	 */
	readonly askUserInteractive?: boolean;
	/**
	 * 注入 SubagentRunner：提供后 spawn_subagent 工具才注册进工具数组（缺省不挂，
	 * 保持既有工具注册表面零变动）。host 运行环（cli/main.ts headless 装配）按
	 * config [subagent] enabled 实例化并注入；本卡仅做绑定装配。子循环只读沙箱
	 * 由运行器官（SubagentRunner + subagent-adapter 的 LoopFactory）保证。
	 */
	readonly subagentRunner?: SubagentRunner;
	/**
	 * BI-16.2 PTC 注册门：提供即注册 run_ptc_script 工具（缺省不挂，既有工具面零变动）。
	 * host 按 config [ptc] enabled 实例化并注入；本卡仅做绑定装配。脚本内
	 * `await tools.<name>(args)` 程序化调用的工具被钉死为 5 件只读子集，详见
	 * runPtcScriptBinding 头注（安全边界）。timeout_ms/max_tool_calls 透传 PtcRunner。
	 */
	readonly ptcDeps?: { readonly timeoutMs?: number; readonly maxToolCalls?: number };
	/**
	 * BI-07.7 会话内 Cron 注册门：提供即注册 cron_schedule/cron_list/cron_remove 三工具
	 * （缺省不挂，既有工具面零变动）。CronService 由 host 注入（已带 CronCorePort——
	 * core 不 import workflow，端口来自宿主运行环）；本卡只做条目管理/列表/注销三动作
	 * 的注册，定时触发归 host 运行环 tick，绝不假冒"已可定时执行"。
	 */
	readonly cronService?: CronService;
	/**
	 * BI-08.3 read_media_file 挂载门：true 才注册 read_media_file 工具（缺省不挂，
	 * 维持既有工具面零变动）。host 按 config [tools] media 实例化并注入；本卡仅做绑定装配。
	 */
	readonly media?: boolean;
	/**
	 * BI-07.11 JobList/JobOutput/JobKill 三件挂载门：true 才注册三件（缺省不挂，
	 * 维持既有工具面零变动）。host 按 config [tools] job_tools 实例化并注入；本卡仅做绑定装配。
	 */
	readonly jobs?: boolean;
	/**
	 * BI-13.2 lsp_navigate 挂载门：true 才注册 lsp_navigate 工具（缺省不挂，
	 * 维持既有工具面零变动）。host 按 config [tools] lsp 实例化并注入；本卡仅做绑定装配。
	 * lspClient 为 LSP server 注入接缝——未注入（server 未连）时工具仍挂载，
	 * execute 结构化返回 {ok:false,code:"lsp-unavailable"}，不抛裸异常（依赖缺失不伪造能力）。
	 */
	readonly lsp?: boolean;
	/** LSP server 客户端注入面（LspToolClientLike 结构类型）；未注入 = execute 返回 lsp-unavailable。 */
	readonly lspClient?: LspToolClientLike;
	/**
	 * BI-07.8 AgentSwarm 挂载门：true 才注册 AgentSwarm 工具（缺省不挂）。
	 * 随 BI-25 子代理使能联动（config [subagent] enabled）；swarmRunner 实例一并注入
	 * （SwarmService，由宿主经 SubagentRunner 派生面装配）。runner 未注入时开关无效
	 * （不挂载，依赖注入缺失不伪造能力）。
	 */
	readonly swarm?: boolean;
	/** AgentSwarm 调度器注入面（SwarmService）；未注入 = 开关无效，不挂载。 */
	readonly swarmRunner?: SwarmService;
	/**
	 * BI-07.9 Skill 挂载门：true 才注册 Skill 工具（缺省不挂）。常挂语义——host 恒
	 * 传 true；器官自身容错：skills 目录缺失时 execute 返回结构化 {ok:false,code:"no-skills"}。
	 * skillRegistry 为注入缝（测试替身用）；缺省由绑定层按 node:fs 端口自建注册表
	 * （零真实网络/子进程）。
	 */
	readonly skill?: boolean;
	/** SkillRegistry 注入面（测试替身用）；缺省由绑定层按 node:fs 端口自建。 */
	readonly skillRegistry?: SkillRegistry;
	/**
	 * BI-13.1 select_tools 挂载门：true 才注册 select_tools 工具（缺省不挂，
	 * 维持既有工具面零变动；BI-13.3 合流——catalog 为名录后端）。
	 * registry 注入 = 当前工具集定义列表（经 buildCatalog 建紧凑名录）；
	 * 模型传工具名 → 换全量 inputSchema。false 时本项不挂载、零变动。
	 */
	readonly select_tools?: boolean;
	/**
	 * BI-16.1 run_js 挂载门：true 才注册 run_js 工具（缺省不挂，维持既有工具面
	 * 零变动）。host 按 config [tools] code_mode 实例化并注入；本卡仅做绑定装配。
	 * 工具内跑 node:vm 纯计算沙箱（禁网络/禁 fs/禁工具注入），超时上限 1000ms。
	 */
	readonly codemode?: boolean;
}

/**
 * 缺省工具注册表面（BI-25.1 + BI-28.1/28.2 + BI-28.5）：read_file / web_fetch /
 * web_search / glob / grep（只读五件在前）+ bash / edit / write（写语义三件）。
 * 每个绑定 = definition（喂模型）+ readOnly + argSummary（截断摘要）+ execute
 * （真实器官调用，信号透传）。
 */
export function buildDefaultToolset(cwd: string, options: BuildDefaultToolsetOptions = {}): ToolBinding[] {
	const root = resolve(cwd);
	const fetchImpl: FetchExecutor = options.fetchImpl ?? ((input, init) => fetch(input, init));
	const env = options.env ?? process.env;
	const apiKeyEnv = options.searchApiKeyEnv ?? DEFAULT_SEARCH_API_KEY_ENV;
	const spawnImpl: SpawnImpl = options.spawnImpl ?? defaultSpawnImpl;
	// PathJail 裁决（edit/write 第二层写策略；glob/grep 读策略；home 取真实用户家目录）。
	const pathJail = new PathJail({ home: homedir(), workspaceRoot: root });
	// FX-A / F-ST-03 · Read-Before-Write 门禁状态机（binding 级生产装配）：
	// read_file 写入/刷新基线，write/edit 写前断言，落盘后 noteEdited 刷新基线。
	// 闭包内单一实例共享——同一次工具集会话里的读取认知贯通到写守门。
	const readFileState = new ReadFileStateMap();
	// 会话级缓存/限速：随工具集实例隔离（默认全局单例会跨测试与跨会话串味）。
	const searchCache = new TtlResultCache();
	const searchLimiter = new TokenBucketRateLimiter(DEFAULT_SEARCH_RPS);
	const tools: ToolBinding[] = [
		readFileBinding(root, readFileState),
		webFetchBinding(fetchImpl),
		webSearchBinding({ fetchImpl, env, apiKeyEnv, cache: searchCache, limiter: searchLimiter }),
		globBinding(root, pathJail),
		grepBinding(root, pathJail),
		bashBinding({ root, spawnImpl }),
		editBinding(root, pathJail, readFileState),
		writeBinding(root, pathJail, readFileState),
	];
	// ask_user_question：仅当 host 注入 UserQuestionService 才注册（保持缺省 8 件不变）。
	if (options.userQuestionService !== undefined) {
		const interactive = options.askUserInteractive ?? (process.stdout.isTTY === true);
		tools.push(askUserBinding({ service: options.userQuestionService, interactive }));
	}
	// spawn_subagent：仅当 host 注入 SubagentRunner 才注册（保持缺省工具面零变动）。
	if (options.subagentRunner !== undefined) {
		tools.push(spawnSubagentBinding(options.subagentRunner));
	}
	// BI-16.2：run_ptc_script —— 仅当 host 注入 ptcDeps 才注册（缺省不挂）。
	// 脚本内程序化调用的工具钉死为 5 件只读子集（见 runPtcScriptBinding 头注）。
	if (options.ptcDeps !== undefined) {
		tools.push(
			runPtcScriptBinding(root, pathJail, {
				fetchImpl,
				env,
				apiKeyEnv,
				cache: searchCache,
				limiter: searchLimiter,
			}, options.ptcDeps),
		);
	}
	// BI-07.7：cron_schedule/cron_list/cron_remove —— 仅当 host 注入 cronService 才注册（缺省不挂）。
	if (options.cronService !== undefined) {
		tools.push(...cronBindings(options.cronService));
	}
	// BI-08.3：read_media_file —— 仅当 host 显式开启 media 门控才注册（缺省不挂，工具面零变动）。
	if (options.media === true) {
		tools.push(mediaInspectBinding(root, pathJail));
	}
	// BI-07.11：JobList/JobOutput/JobKill —— 仅当 host 显式开启 jobs 门控才注册（缺省不挂，工具面零变动）。
	if (options.jobs === true) {
		const registry = new JobRegistry();
		const jobTools = new JobTools(registry);
		tools.push(
			jobListBinding(jobTools),
			jobOutputBinding(jobTools),
			jobKillBinding(jobTools),
		);
	}
	// BI-13.2：lsp_navigate —— 仅当 host 显式开启 lsp 门控才注册（缺省不挂，工具面零变动）。
	// lspClient 未注入（server 未连）= 工具仍挂载，execute 结构化返回 lsp-unavailable（不抛裸异常）。
	if (options.lsp === true) {
		tools.push(lspNavigateBinding(options.lspClient));
	}
	// BI-07.8：AgentSwarm —— 仅当 swarm 门开且 runner 注入才注册（缺省不挂）。
	// runner 未注入时开关无效（不挂载，依赖注入缺失不伪造能力）。
	if (options.swarm === true && options.swarmRunner !== undefined) {
		tools.push(agentSwarmBinding(options.swarmRunner));
	}
	// BI-07.9：Skill —— 仅当 host 显式开启（常挂：恒传 true）才注册（缺省不挂，工具面零变动）。
	if (options.skill === true) {
		tools.push(skillBinding(options.skillRegistry));
	}
	// BI-13.1/BI-13.3：select_tools —— 仅当 host 显式开启 select_tools 门控才注册
	// （缺省不挂，工具面零变动）。registry 后端 = 当前工具集（内置）经 buildCatalog
	// 建的紧凑名录；模型传工具名 → 换全量 inputSchema。MCP 面工具（packages/mcp
	// client 的 toolsAcrossServers）本单暂不接，扩展缝见 makeSelectToolsRegistry 注释。
	if (options.select_tools === true) {
		const registry = makeSelectToolsRegistry(tools);
		tools.push(selectToolsBinding(registry));
	}
	// BI-16.1：run_js —— 仅当 host 显式开启 codemode 门控才注册（缺省不挂，工具面零变动）。
	if (options.codemode === true) {
		tools.push(makeCodemodeTool());
	}
	return tools;
}

// ---------------------------------------------------------------------------
// read_file —— 工作区文本读取（器官：Bun.file，绑定层守卫）
// ---------------------------------------------------------------------------

/**
 * cwd 逃逸守卫（read_file/edit/write 共用；边界为路径段级前缀 root+sep，
 * 兄弟目录同前缀（/w → /w2）不漏放）。edit/write 复用本函数后再过 PathJail。
 */
function assertInsideRoot(root: string, abs: string): void {
	if (abs !== root && !abs.startsWith(root + sep)) throw new Error("path-escape");
}

/**
 * edit/write 的写路径守卫：段级前缀逃逸守卫 + PathJail write 模式裁决。
 * 返回解析后的绝对路径（供读改写流水线使用）。
 */
function guardWritePath(root: string, jail: PathJail, rawPath: string): string {
	const abs = resolve(root, rawPath);
	assertInsideRoot(root, abs);
	const verdict = jail.checkPath(abs, "write");
	if (!verdict.allowed) throw new Error(`path-protected: ${verdict.reason ?? "protected"}`);
	return abs;
}

function readFileBinding(root: string, state: ReadFileStateMap): ToolBinding {
	return {
		definition: {
			name: "read_file",
			description: "读取工作区内文本文件（UTF-8）。超出了工作区根的路径一律拒绝。",
			inputSchema: {
				type: "object",
				properties: { path: { type: "string", description: "相对工作区根的文件路径" } },
				required: ["path"],
			},
		},
		readOnly: true,
		argSummary: (args) => summarizeArg(args, "path"),
		execute: async (args, signal) => {
			const path = takeStringArg(args, "path");
			const abs = resolve(root, path);
			assertInsideRoot(root, abs);
			return await withSignal(signal, async () => {
				// 读成功后才落基线（FX-A Read-Before-Write：读即认知）。
				const text = await Bun.file(abs).text();
				const st = statSync(abs);
				state.recordRead(abs, { mtimeMs: st.mtimeMs, size: st.size });
				return text;
			});
		},
	};
}

// ---------------------------------------------------------------------------
// glob / grep —— 工作区只读检索（BI-28.5；路径守卫 + PathJail read 裁决）
// ---------------------------------------------------------------------------

/**
 * glob/grep 的读路径守卫：空 = 工作区根；段级前缀逃逸守卫 + PathJail read
 * 裁决（第二层防御；根外路径一律 path-escape，绝不读入其内容）。
 * 返回解析后的绝对路径（glob 扫描起点 / grep 搜索目标）。
 */
function guardReadPath(root: string, jail: PathJail, rawPath: string): string {
	const abs = rawPath === "" ? root : resolve(root, rawPath);
	assertInsideRoot(root, abs);
	const verdict = jail.checkPath(abs, "read");
	if (!verdict.allowed) throw new Error(`path-protected: ${verdict.reason ?? "protected"}`);
	return abs;
}

/**
 * glob —— 工作区文件模式匹配（Bun.Glob 扫描，零依赖）。
 * rg --embed 内嵌检索面维持缓议（工单原文），本卡不接 rg。
 * Bun.Glob 纯语义：不做 gitignore/node_modules 排除（dot:false 仅挡隐藏条目）；
 * 巨型树由 GLOB_RESULT_LIMIT 封顶防护。匹配只泄漏文件名不泄漏内容，故不做
 * 逐文件 PathJail 复核（grep 侧内容外泄面才需要，见 grepBinding）。
 */
function globBinding(root: string, jail: PathJail): ToolBinding {
	return {
		definition: {
			name: "glob",
			description:
				"按 glob 模式列出工作区内文件（Bun.Glob 语义，隐藏条目不参与）。path 可选（相对工作区根的扫描起点，缺省根）。返回 JSON {matches, count, truncated?}；matches 为按字典序排序的相对路径，上限 500 条。",
			inputSchema: {
				type: "object",
				properties: {
					pattern: { type: "string", description: "glob 模式（如 **/*.ts）" },
					path: { type: "string", description: "扫描起点（相对工作区根，可选，缺省根）" },
				},
				required: ["pattern"],
			},
		},
		readOnly: true,
		argSummary: (args) => summarizeSearchArgs(args, "glob"),
		execute: async (args, signal) => {
			const pattern = takeStringArg(args, "pattern");
			const pathArg = optionalStringArg(args, "path");
			return await withSignal(signal, async () => {
				const base = guardReadPath(root, jail, pathArg);
				const glob = new Bun.Glob(pattern);
				const matches: string[] = [];
				let truncated = false;
				for await (const rel of glob.scan({ cwd: base, onlyFiles: true, dot: false })) {
					if (matches.length >= GLOB_RESULT_LIMIT) {
						truncated = true;
						break;
					}
					// scan 产出相对扫描起点的路径；统一改写为相对工作区根（与 grep 呈现一致）。
					matches.push(relative(root, resolve(base, rel)));
				}
				matches.sort();
				return JSON.stringify({ matches, count: matches.length, ...(truncated ? { truncated: true } : {}) });
			});
		},
	};
}

/**
 * grep —— 工作区递归正则搜索（只读；零依赖，不用 rg）。
 * 跳过面：node_modules、点开头条目（.git/.bi 与隐藏文件，rg 同款缺省）、
 * 二进制文件（内容含 NUL 即判）、超 GREP_FILE_SIZE_LIMIT_BYTES 的单文件；
 * 符号链接一律不跟随（杜绝环与越界）。命中 file:line:text 行，条数与输出
 * 双封顶（GREP_MATCH_LIMIT / GREP_OUTPUT_TAIL_LIMIT_BYTES，尾部截断风格与
 * bash 一致）。
 */
function grepBinding(root: string, jail: PathJail): ToolBinding {
	return {
		definition: {
			name: "grep",
			description:
				"在工作区内递归正则搜索文本文件（区分大小写）。跳过 node_modules/隐藏条目/二进制文件，单文件 1MB 上限；返回 JSON {count, output, truncated?, outputTruncated?}，output 为 file:line:text 行（上限 200 条，超 10KB 保留尾部）。include 可选（glob 过滤：无 / 时对文件名匹配如 *.ts，含 / 时对工作区相对路径匹配）。",
			inputSchema: {
				type: "object",
				properties: {
					pattern: { type: "string", description: "正则表达式（ECMAScript 语法）" },
					path: { type: "string", description: "搜索起点（文件或目录，相对工作区根，可选，缺省根）" },
					include: { type: "string", description: "文件名过滤 glob（如 *.ts；可选）" },
				},
				required: ["pattern"],
			},
		},
		readOnly: true,
		argSummary: (args) => summarizeSearchArgs(args, "grep"),
		execute: async (args, signal) => {
			const pattern = takeStringArg(args, "pattern");
			const pathArg = optionalStringArg(args, "path");
			const include = optionalStringArg(args, "include");
			return await withSignal(signal, async () => {
				let regex: RegExp;
				try {
					regex = new RegExp(pattern);
				} catch (cause) {
					throw new Error(`grep-pattern-invalid: ${cause instanceof Error ? cause.message : String(cause)}`);
				}
				const base = guardReadPath(root, jail, pathArg);
				const includeGlob = include === "" ? undefined : new Bun.Glob(include);
				const files = await collectGrepFiles(base);
				const matches: string[] = [];
				let truncated = false;
				search: for (const file of files) {
					const rel = relative(root, file);
					// include 过滤（rg 同款语义）：无 "/" 的 glob 对文件名匹配（*.ts 命中
					// 任意深度的 .ts，如 sub/b.ts），含 "/" 的 glob 对工作区相对路径匹配。
					if (includeGlob !== undefined && !includeGlob.match(include.includes("/") ? rel : basename(rel))) {
						continue;
					}
					// 逐文件 PathJail read 复核：凭据文件名/工作区 .env 不入扫描结果（防内容外泄）。
					if (!jail.checkPath(file, "read").allowed) continue;
					let size = 0;
					try {
						size = statSync(file).size;
					} catch {
						continue; // 探测不到（竞态删除/权限）一律跳过——扫描面绝不让异常冒泡中断。
					}
					if (size > GREP_FILE_SIZE_LIMIT_BYTES) continue;
					let text: string;
					try {
						text = await Bun.file(file).text();
					} catch {
						continue;
					}
					if (text.includes("\u0000")) continue; // 二进制启发式：含 NUL 即跳过
					const lines = text.split("\n");
					for (let i = 0; i < lines.length; i++) {
						const line = lines[i] ?? "";
						if (!regex.test(line)) continue;
						if (matches.length >= GREP_MATCH_LIMIT) {
							truncated = true;
							break search;
						}
						matches.push(`${rel}:${i + 1}:${line}`);
					}
				}
				return formatGrepResult(matches, truncated);
			});
		},
	};
}

/**
 * grep 扫描目标收集：目录 = 深度优先收集普通文件（跳过 node_modules 与
 * 点开头条目；符号链接既非 isDirectory 也非 isFile，天然不跟随）；单文件 =
 * 单元素。目标不存在 = 结构化报错。收集后按全路径字典序排序（确定性输出）。
 */
async function collectGrepFiles(base: string): Promise<string[]> {
	let baseIsDir = false;
	try {
		baseIsDir = statSync(base).isDirectory();
	} catch {
		throw new Error("grep-path-not-found");
	}
	if (!baseIsDir) return [base];
	const files: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return; // 不可读目录跳过（不中断整体扫描）
		}
		const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of sorted) {
			if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (entry.isFile()) files.push(full);
		}
	};
	await walk(base);
	return files;
}

/** 组装 grep 工具结果 JSON：条数 + 输出尾部 10KB 截断 + truncated/outputTruncated 标注。 */
function formatGrepResult(matches: string[], truncated: boolean): string {
	let output = matches.join("\n");
	let outputTruncated = false;
	const bytes = new TextEncoder().encode(output);
	if (bytes.byteLength > GREP_OUTPUT_TAIL_LIMIT_BYTES) {
		const tail = bytes.subarray(bytes.byteLength - GREP_OUTPUT_TAIL_LIMIT_BYTES);
		output = `${GREP_TRUNCATION_MARKER}\n${new TextDecoder().decode(tail)}`;
		outputTruncated = true;
	}
	return JSON.stringify({
		count: matches.length,
		output,
		...(truncated ? { truncated: true } : {}),
		...(outputTruncated ? { outputTruncated: true } : {}),
	});
}

/** glob/grep argSummary：模式 + 起点 + 过滤器（审批浮层审计面）。 */
function summarizeSearchArgs(args: unknown, tool: "glob" | "grep"): string {
	const pattern = optionalStringArg(args, "pattern");
	const path = optionalStringArg(args, "path");
	const include = optionalStringArg(args, "include");
	const head = pattern.length > 80 ? `${pattern.slice(0, 80)}…` : pattern;
	const base = path === "" ? "." : path;
	return tool === "glob"
		? `pattern=${head} path=${base}`
		: `pattern=${head} path=${base}${include === "" ? "" : ` include=${include}`}`;
}

// ---------------------------------------------------------------------------
// bash —— 工作区命令执行（BI-28.1；spawn 注入面 + shell-scan 标注）
// ---------------------------------------------------------------------------

interface BashDeps {
	readonly root: string;
	readonly spawnImpl: SpawnImpl;
}

function bashBinding(deps: BashDeps): ToolBinding {
	return {
		definition: {
			name: "bash",
			description:
				"在工作区根执行 bash 命令。返回 JSON {exitCode, output, timedOut?, truncated?}；exitCode 非 0 不抛错（命令失败是正常工具结果）。默认超时 60 秒（timeout_ms 可调），超时击杀并标注；stdout+stderr 合并，仅保留末尾 100KB。",
			inputSchema: {
				type: "object",
				properties: {
					command: { type: "string", description: "要执行的 bash 命令" },
					timeout_ms: { type: "number", description: "超时毫秒数（缺省 60000）" },
				},
				required: ["command"],
			},
		},
		readOnly: false,
		argSummary: bashArgSummary,
		execute: (args, signal) => {
			const command = takeStringArg(args, "command");
			const timeoutMs = takeOptionalPositiveInt(args, "timeout_ms") ?? DEFAULT_BASH_TOOL_TIMEOUT_MS;
			return runBashCommand({ ...deps, command, timeoutMs, signal });
		},
	};
}

/**
 * bash argSummary：命令截断 120 字符 + shell-scan 分类标注（后缀）。
 * dangerous（确定性危险清单命中）与 opaque（扫描器不认识的构造，fail-closed）
 * 都标注——审批浮层对"看不懂的命令"同样要显眼；分类器自身故障标 error。
 */
function bashArgSummary(args: unknown): string {
	let command = "";
	if (args !== null && typeof args === "object") {
		const raw = (args as Record<string, unknown>)["command"];
		if (typeof raw === "string") command = raw;
	}
	const head = command.length > BASH_ARG_SUMMARY_MAX ? `${command.slice(0, BASH_ARG_SUMMARY_MAX)}…` : command;
	const tag = shellScanTag(command);
	return tag === "" ? head : `${head} ${tag}`;
}

/** shell-scan 分类标注（纯函数、零 IO；异常 fail-visible 标 error）。 */
function shellScanTag(command: string): string {
	if (command.trim() === "") return "";
	try {
		const scan = scanShell(command);
		const tags: string[] = [];
		if (scan.dangerous) tags.push("dangerous");
		if (scan.opaque) tags.push("opaque");
		return tags.length > 0 ? `[shell-scan:${tags.join("+")}]` : "";
	} catch {
		return "[shell-scan:error]";
	}
}

/** 执行 bash 命令：spawn → 超时/中止竞出 → 合并输出 → 尾部 100KB → JSON 结果。 */
async function runBashCommand(input: {
	readonly root: string;
	readonly spawnImpl: SpawnImpl;
	readonly command: string;
	readonly timeoutMs: number;
	readonly signal: AbortSignal;
}): Promise<string> {
	const { root, spawnImpl, command, timeoutMs, signal } = input;
	if (signal.aborted) throw new Error("aborted");
	const proc = spawnImpl(["bash", "-c", command], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });

	const chunks: string[] = [];
	let timedOut = false;
	let settled = false;
	let onAbort = (): void => {};
	const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
		const decoder = new TextDecoder();
		const reader = stream.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value !== undefined) chunks.push(decoder.decode(value, { stream: true }));
			}
		} catch {
			// 被击杀进程的流可能以错误收尾：已收到的块照常计入。
		} finally {
			// releaseLock 防御：子进程管道异常收尾（实测嵌套 bun test 触发）时，
			// 已出错的原生流 reader 释放锁可能抛原生错误——锁释放失败不影响已收
			// 块，吞掉即可，绝不让 pump 的 finally 打翻整条结果管线。
			try {
				reader.releaseLock();
			} catch {
				// 忽略：流已出错时的锁释放失败。
			}
		}
	};

	return await new Promise<string>((resolveResult, rejectResult) => {
		const settle = (finish: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			finish();
		};
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				proc.kill();
			} catch {
				// 已退出的进程 kill 会抛：照常走 exited 落定路径。
			}
		}, timeoutMs);
		onAbort = () => {
			try {
				proc.kill();
			} catch {
				// 同上。
			}
			settle(() => rejectResult(new Error("aborted")));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		void pump(proc.stdout).then(() => pump(proc.stderr)).then(() => proc.exited).then(
			(exitCode) => settle(() => resolveResult(formatBashResult(exitCode, chunks.join(""), timedOut))),
			(error) => settle(() => rejectResult(error instanceof Error ? error : new Error(String(error)))),
		);
	});
}

/** 组装 bash 工具结果 JSON：尾部 100KB 截断 + timedOut/truncated 标注。 */
function formatBashResult(exitCode: number, output: string, timedOut: boolean): string {
	let text = output;
	let truncated = false;
	const bytes = new TextEncoder().encode(text);
	if (bytes.byteLength > BASH_OUTPUT_TAIL_LIMIT_BYTES) {
		const tail = bytes.subarray(bytes.byteLength - BASH_OUTPUT_TAIL_LIMIT_BYTES);
		text = `${BASH_TRUNCATION_MARKER}\n${new TextDecoder().decode(tail)}`;
		truncated = true;
	}
	return JSON.stringify({
		exitCode,
		output: text,
		...(timedOut ? { timedOut: true } : {}),
		...(truncated ? { truncated: true } : {}),
	});
}

// ---------------------------------------------------------------------------
// edit / write —— 工作区原子写（BI-28.2；唯一性替换 + PathJail 写裁决）
// ---------------------------------------------------------------------------

function editBinding(root: string, jail: PathJail, state: ReadFileStateMap): ToolBinding {
	return {
		definition: {
			name: "edit",
			description:
				"替换工作区内文本文件的片段（UTF-8 精确匹配）。old_string 必须恰有一处命中；多处命中需 replace_all=true 全量替换，零命中报错。替换为 new_string（可为空串=删除）。原子写落盘。",
			inputSchema: {
				type: "object",
				properties: {
					path: { type: "string", description: "相对工作区根的文件路径" },
					old_string: { type: "string", description: "待替换原文（须唯一命中）" },
					new_string: { type: "string", description: "替换为的新文本（可为空串）" },
					replace_all: { type: "boolean", description: "多处命中时全量替换（缺省 false）" },
				},
				required: ["path", "old_string", "new_string"],
			},
		},
		readOnly: false,
		argSummary: (args) => summarizeEditArgs(root, args),
		execute: async (args, signal) => {
			const path = takeStringArg(args, "path");
			const oldString = takeRawStringArg(args, "old_string");
			const newString = takeRawStringArg(args, "new_string");
			const replaceAll = takeOptionalBooleanArg(args, "replace_all");
			return await withSignal(signal, async () => {
				// 守卫先于读写（较工单顺序更紧：根外路径绝不读入内容）。
				const abs = guardWritePath(root, jail, path);
				if (!(await Bun.file(abs).exists())) throw new Error("file-not-found");
				// FX-A Read-Before-Write：edit 自身读内容不算认知，须先经 read_file 建立基线。
				const preGate = state.assertCleanForWrite(abs, statSync(abs));
				if (!preGate.allowed) {
					throw new Error(`${preGate.reason}: ${abs} (先用 read_file 读取后再写)`);
				}
				const content = await Bun.file(abs).text();

				// 第 1 级（精确）优先：走既有逐字节不变路径（split/join + 精确计数 + replace_all 语义）。
				const exactCount = content.split(oldString).length - 1;
				if (exactCount > 0) {
					if (exactCount > 1 && !replaceAll) {
						throw new Error(`edit-ambiguous: matches=${exactCount} (set replace_all=true)`);
					}
					// split/join 字面替换：绕开 String.replace 的 $ 模式展开语义。
					const next = content.split(oldString).join(newString);
					await atomicWriteFile(abs, next);
					state.noteEdited(abs, statSync(abs));
					return JSON.stringify({ ok: true, path, matches: exactCount });
				}

				// 精确 0 命中 → 8 级阶梯弹性降级（各级命中附 matchLevel 备注，不改成功/失败语义）。
				const match = matchOldText(content, oldString, { onAmbiguous: replaceAll ? "first" : "report" });
				if (match.level === "unmatched") throw new Error("edit-no-match: matches=0");
				if (match.ambiguous) {
					// 仅 replaceAll=false 会到此处（replaceAll=true 走 first 已取第一处）；防御性保持歧义报错。
					throw new Error(`edit-ambiguous: matches=${match.occurrences} (set replace_all=true)`);
				}
				// 单点降级命中：替换唯一匹配切片，四周字节原样保留（matched 直映原文切片）。
				const next =
					content.slice(0, match.index) + newString + content.slice(match.index + match.matched.length);
				await atomicWriteFile(abs, next);
				state.noteEdited(abs, statSync(abs));
				return JSON.stringify({ ok: true, path, matches: 1, matchLevel: match.level });
			});
		},
	};
}

function writeBinding(root: string, jail: PathJail, state: ReadFileStateMap): ToolBinding {
	return {
		definition: {
			name: "write",
			description:
				"整文件写入工作区（UTF-8，覆盖或新建）。允许新建文件，但父目录必须已存在。原子写落盘。",
			inputSchema: {
				type: "object",
				properties: {
					path: { type: "string", description: "相对工作区根的文件路径" },
					content: { type: "string", description: "完整文件内容（可为空串）" },
				},
				required: ["path", "content"],
			},
		},
		readOnly: false,
		argSummary: (args) => summarizeWriteArgs(args),
		execute: async (args, signal) => {
			const path = takeStringArg(args, "path");
			const content = takeRawStringArg(args, "content");
			return await withSignal(signal, async () => {
				const abs = guardWritePath(root, jail, path);
				let parentIsDir = false;
				try {
					parentIsDir = statSync(dirname(abs)).isDirectory();
				} catch {
					parentIsDir = false;
				}
				if (!parentIsDir) throw new Error("parent-dir-not-found");
				// FX-A Read-Before-Write：已存在文件必须先经 read_file 认知；新文件直接放行。
				if (await Bun.file(abs).exists()) {
					const preGate = state.assertCleanForWrite(abs, statSync(abs));
					if (!preGate.allowed) {
						throw new Error(`${preGate.reason}: ${abs} (先用 read_file 读取后再写)`);
					}
				}
				await atomicWriteFile(abs, content);
				state.noteEdited(abs, statSync(abs));
				return JSON.stringify({ ok: true, path, bytes: byteLengthOf(content) });
			});
		},
	};
}

// ---------------------------------------------------------------------------
// ask_user_question —— 交互提问工具面（BI-07.10 薄壳；headless 降级安全）
// ---------------------------------------------------------------------------

interface AskUserDeps {
	readonly service: UserQuestionService;
	readonly interactive: boolean;
}

/**
 * ask_user_question 绑定：喂模型定义 + 安全降级执行。
 * 非可交互（headless / 无 TTY）时 AskUserTool 直接结构化返回
 * {answered:false,reason:"no-interactive"}——绝不调用 service.ask（block 会悬挂），
 * 不悬挂不抛。默认不改变其他任何工具行为。
 */
function askUserBinding(deps: AskUserDeps): ToolBinding {
	const tool = new AskUserTool(deps.service, { interactive: deps.interactive });
	return {
		definition: {
			...ASK_USER_QUESTION_TOOL_SPEC,
			inputSchema: ASK_USER_QUESTION_TOOL_SPEC.inputSchema as Record<string, unknown>,
		},
		readOnly: true,
		argSummary: (args) => summarizeArg(args, "questions"),
		execute: async (args) => {
			const result = await tool.run(args);
			return JSON.stringify(result);
		},
	};
}

// ---------------------------------------------------------------------------
// edit/write argSummary —— 路径 + 替换计数/字节数 + 片段（审批浮层审计面）
// ---------------------------------------------------------------------------

/** edit argSummary：路径 + 真实匹配计数（尽力而为同步读）+ old/new 首行片段。 */
function summarizeEditArgs(root: string, args: unknown, snippetMax = 60): string {
	const path = optionalStringArg(args, "path");
	const oldString = optionalStringArg(args, "old_string");
	const newString = optionalStringArg(args, "new_string");
	const replaceAll = optionalBooleanArg(args, "replace_all");
	let matches = "?";
	if (path !== "" && oldString !== "") {
		try {
			const abs = resolve(root, path);
			if (abs === root || abs.startsWith(root + sep)) {
				matches = String(readFileSync(abs, "utf8").split(oldString).length - 1);
			}
		} catch {
			// 读不到（不存在/是目录/二进制）一律 matches=?，绝不抛错——argSummary 是审计面。
		}
	}
	const all = replaceAll ? " replace_all" : "";
	return `path=${path} matches=${matches}${all} old=${snippet(oldString, snippetMax)} new=${snippet(newString, snippetMax)}`;
}

/** write argSummary：路径 + 内容字节数。 */
function summarizeWriteArgs(args: unknown): string {
	const path = optionalStringArg(args, "path");
	const content = optionalStringArg(args, "content");
	return `path=${path} bytes=${byteLengthOf(content)}`;
}

/** 首行片段（JSON.stringify 定界 + 截断；多行追加省略号）。 */
function snippet(text: string, max: number): string {
	const nl = text.indexOf("\n");
	const first = nl === -1 ? text : text.slice(0, nl);
	const elided = nl !== -1 ? "…" : "";
	const clipped = first.length > max ? `${first.slice(0, max)}…` : first;
	return JSON.stringify(`${clipped}${elided}`);
}

function byteLengthOf(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

// ---------------------------------------------------------------------------
// web_fetch / web_search —— BI-07.15 web 器官包装（readOnly = 无文件写语义）
// ---------------------------------------------------------------------------

function webFetchBinding(fetchImpl: FetchExecutor): ToolBinding {
	return {
		definition: {
			name: "web_fetch",
			description: "抓取网页并归一化为 Markdown/文本（HTML 取主内容；重定向、超时与字节上限受控）。",
			inputSchema: {
				type: "object",
				properties: { url: { type: "string", description: "http(s) 完整 URL" } },
				required: ["url"],
			},
		},
		readOnly: true,
		argSummary: (args) => summarizeArg(args, "url"),
		execute: (args, signal) => {
			const url = takeStringArg(args, "url");
			return withSignal(signal, () => fetchWebPage(url, { fetchImpl }));
		},
	};
}

interface WebSearchDeps {
	readonly fetchImpl: FetchExecutor;
	readonly env: Record<string, string | undefined>;
	readonly apiKeyEnv: string;
	readonly cache: TtlResultCache;
	readonly limiter: TokenBucketRateLimiter;
}

function webSearchBinding(deps: WebSearchDeps): ToolBinding {
	return {
		definition: {
			name: "web_search",
			description: "Web 搜索（DeepSeek provider）。返回 { title, url, snippet } 结果列表；需经环境变量配置 API 密钥。",
			inputSchema: {
				type: "object",
				properties: { query: { type: "string", description: "搜索词" } },
				required: ["query"],
			},
		},
		readOnly: true,
		argSummary: (args) => summarizeArg(args, "query"),
		execute: async (args, signal) => {
			const query = takeStringArg(args, "query");
			// 密钥门：执行时解析（api_key_env 间接引用语义），未设置结构化报错，不假冒结果。
			const apiKey = (deps.env[deps.apiKeyEnv] ?? "").trim();
			if (apiKey === "") {
				throw new Error(`web_search 未配置：环境变量 ${deps.apiKeyEnv} 未设置（api_key_env 间接引用语义；导出后重试）`);
			}
			const provider = new DeepSeekSearchProvider({ apiKey, fetchImpl: deps.fetchImpl });
			return await withSignal(signal, () =>
				webSearch(query, {
					provider,
					cache: deps.cache,
					limiter: deps.limiter,
				}),
			);
		},
	};
}

// ---------------------------------------------------------------------------
// 绑定层小件：参数取值 / 摘要截断 / 信号竞出
// ---------------------------------------------------------------------------

/** 取字符串参数（缺省/非字符串/空串统一结构化报错）。 */
function takeStringArg(args: unknown, key: string): string {
	const raw = args !== null && typeof args === "object" ? (args as Record<string, unknown>)[key] : undefined;
	if (typeof raw !== "string" || raw.trim() === "") throw new Error(`${key} required`);
	return raw;
}

/**
 * 取字符串参数（允许空串：new_string=删除、content=清空文件是合法语义）。
 * 仅做类型检查：缺省/非字符串 = 结构化报错。
 */
function takeRawStringArg(args: unknown, key: string): string {
	const raw = args !== null && typeof args === "object" ? (args as Record<string, unknown>)[key] : undefined;
	if (typeof raw !== "string") throw new Error(`${key} required`);
	return raw;
}

/** 取可选布尔参数（缺省 false；非布尔 = 结构化报错）。 */
function takeOptionalBooleanArg(args: unknown, key: string): boolean {
	const raw = args !== null && typeof args === "object" ? (args as Record<string, unknown>)[key] : undefined;
	if (raw === undefined) return false;
	if (typeof raw !== "boolean") throw new Error(`${key} invalid`);
	return raw;
}

/** 取可选正整数参数（如 timeout_ms；undefined=缺省；非法 = 结构化报错）。 */
function takeOptionalPositiveInt(args: unknown, key: string): number | undefined {
	const raw = args !== null && typeof args === "object" ? (args as Record<string, unknown>)[key] : undefined;
	if (raw === undefined) return undefined;
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) throw new Error(`${key} invalid`);
	return raw;
}

/** 静默取字符串（argSummary 容错面：缺省/非字符串回空串，绝不抛）。 */
function optionalStringArg(args: unknown, key: string): string {
	const raw = args !== null && typeof args === "object" ? (args as Record<string, unknown>)[key] : undefined;
	return typeof raw === "string" ? raw : "";
}

/** 静默取布尔（argSummary 容错面）。 */
function optionalBooleanArg(args: unknown, key: string): boolean {
	const raw = args !== null && typeof args === "object" ? (args as Record<string, unknown>)[key] : undefined;
	return raw === true;
}

/** argSummary：目标参数原文（缺省回退整参 JSON），截断到 200 字符（权限门审计面）。 */
function summarizeArg(args: unknown, key: string, max = 200): string {
	const raw = args !== null && typeof args === "object" ? (args as Record<string, unknown>)[key] : undefined;
	let text: string;
	if (typeof raw === "string") {
		text = raw;
	} else {
		try {
			text = JSON.stringify(args) ?? String(args);
		} catch {
			text = String(args);
		}
	}
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 信号透传（器官无 signal 入参时的绑定层补偿）：一旦 abort 立即 reject，
 * 不等器官自身超时。start 工厂惰性求值——已中止的信号不启动器官调用；
 * 竞出后器官侧结果/异常照常落定（已被本层接管，不产生未处理拒绝）。
 */
function withSignal<T>(signal: AbortSignal, start: () => Promise<T>): Promise<T> {
	if (signal.aborted) return Promise.reject(new Error("aborted"));
	let pending: Promise<T>;
	try {
		pending = start();
	} catch (error) {
		return Promise.reject(error);
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new Error("aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		pending.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

// ---------------------------------------------------------------------------
// BI-16.2 · run_ptc_script —— PTC 程序化工具调用（5 件只读子集白名单）
// ---------------------------------------------------------------------------

/**
 * PTC 安全边界（钉死，不可绕过）：脚本内 `await tools.<name>(args)` 程序化调用
 * 的工具被钉死为以下 5 件**只读**子集：read_file / grep / glob / web_search /
 * web_fetch。bash / edit / write 一律不开放——程序化调用不允许写与执行（防脚本
 * 经工具面逃逸出只读语义；逃逸面另由 PtcRunner 静态扫描 + 受限作用域双重拦截）。
 * 白名单外工具名 → 代理侧 PtcUnknownToolError 拒派发（双重保险）。
 */
export const PTC_READONLY_WHITELIST = ["read_file", "grep", "glob", "web_search", "web_fetch"] as const;

type PtcWebSearchDeps = {
	readonly fetchImpl: FetchExecutor;
	readonly env: Record<string, string | undefined>;
	readonly apiKeyEnv: string;
	readonly cache: TtlResultCache;
	readonly limiter: TokenBucketRateLimiter;
};

/**
 * run_ptc_script 绑定：喂模型定义 + 受限执行（白名单转发）。
 * 内部自建 5 件只读绑定（复用既有绑定工厂，零新造轮子），脚本内每次
 * tools.<name> 调用经 executor 转发到对应绑定 execute(args, signal)。
 * 不开放白名单外工具：executor 内不在白名单即拒绝，绝不派发到 bash/edit/write。
 */
function runPtcScriptBinding(
	root: string,
	jail: PathJail,
	webSearchDeps: PtcWebSearchDeps,
	deps: { readonly timeoutMs?: number; readonly maxToolCalls?: number },
): ToolBinding {
	const whitelist = new Set<string>(PTC_READONLY_WHITELIST);
	// 依白名单自建 5 件只读绑定（与缺省注册表同款实例，但只暴露只读面）。
	const byName = new Map<string, ToolBinding>(
		[
			readFileBinding(root, new ReadFileStateMap()),
			grepBinding(root, jail),
			globBinding(root, jail),
			webFetchBinding(webSearchDeps.fetchImpl),
			webSearchBinding(webSearchDeps),
		].map((b) => [b.definition.name, b] as const),
	);
	const knownTools = [...byName.keys()];
	return {
		definition: {
			name: "run_ptc_script",
			description:
				"执行一段模型生成的精算脚本（单轮）：脚本体内以 `await tools.<name>(args)` 程序化调用工具。" +
				"仅允许 5 件只读工具：read_file / grep / glob / web_search / web_fetch（程序化调用禁写禁执行）。" +
				"脚本支持循环/分支/Promise.all 并发；执行前静态扫描拒绝 import/require/eval 等逃逸面，并有超时与调用次数上限。",
			inputSchema: {
				type: "object",
				properties: {
					script: { type: "string", description: "PTC 脚本本体（内部 await tools.<name>(args) 程序化调用工具）" },
				},
				required: ["script"],
			},
		},
		readOnly: true,
		argSummary: (args) => summarizeArg(args, "script"),
		execute: async (args, signal) => {
			const script = takeStringArg(args, "script");
			const result: PtcRunResult = await runPtcScript(script, {
				executor: async (name, a) => {
					if (!whitelist.has(name)) {
						throw new Error(`ptc-tool-not-whitelisted: ${name}（仅允许 ${[...whitelist].join("/")}）`);
					}
					const tool = byName.get(name);
					if (tool === undefined) throw new Error(`ptc-tool-missing: ${name}`);
					return await tool.execute(a, signal);
				},
				timeoutMs: deps.timeoutMs,
				maxToolCalls: deps.maxToolCalls,
				knownTools,
			});
			return JSON.stringify(result);
		},
	};
}

// ---------------------------------------------------------------------------
// BI-07.7 · cron_schedule / cron_list / cron_remove —— 会话内 Cron 三件套
// ---------------------------------------------------------------------------

/**
 * 三件 cron 工具绑定（委托既有 CronTools，零新造轮子）。
 * 仅做条目管理（schedule 登记）/ 列表巡检（list）/ 注销（remove）三动作注册；
 * 定时触发（到点 action 回调）归宿主运行环经 CronService.tick 推进——本卡绝不
 * 假冒"已可定时执行"，触发动作 onFire 由 host 注入（core 不 import workflow 端口）。
 */
export function cronBindings(service: CronService): ToolBinding[] {
	const cronTools = new CronTools({ service });

	const scheduleBinding: ToolBinding = {
		definition: {
			name: "cron_schedule",
			description:
				"在当前会话内登记一条 cron 周期任务（5 字段表达式：分 时 日 月 周）。" +
				"到点由运行时触发宿主注入的动作回调（本工具仅登记名称与表达式，不执行）。同名重复登记幂等返回既有条目。",
			inputSchema: {
				type: "object",
				properties: {
					name: { type: "string", description: "任务名（会话内唯一，幂等键）" },
					cron_expr: { type: "string", description: "5 字段 cron 表达式：分 时 日 月 周" },
				},
				required: ["name", "cron_expr"],
			},
		},
		readOnly: true,
		argSummary: (args) => {
			const name = optionalStringArg(args, "name");
			const expr = optionalStringArg(args, "cron_expr");
			return `name=${name} cron_expr=${expr}`;
		},
		execute: async (args) => JSON.stringify(await cronTools.runCreate(args)),
	};

	const listBinding: ToolBinding = {
		definition: {
			name: "cron_list",
			description: "列出当前会话内已登记的 cron 任务（含下次触发时刻与最近触发留痕）。",
			inputSchema: { type: "object", properties: {} },
		},
		readOnly: true,
		argSummary: () => "cron_list",
		execute: () => JSON.stringify(cronTools.runList()),
	};

	const removeBinding: ToolBinding = {
		definition: {
			name: "cron_remove",
			description: "按 id 注销一条会话内 cron 任务（幂等；未知 id 结构化返回 unknown-cron）。",
			inputSchema: {
				type: "object",
				properties: { id: { type: "string", description: "cron_list 返回的任务 id" } },
				required: ["id"],
			},
		},
		readOnly: true,
		argSummary: (args) => `id=${optionalStringArg(args, "id")}`,
		execute: async (args) => JSON.stringify(cronTools.runDelete(args)),
	};

	return [scheduleBinding, listBinding, removeBinding];
}

/** 仅供测试/装配层取白名单面（依赖注入校验用）。 */
export function ptcReadonlyBindings(): readonly string[] {
	return [...PTC_READONLY_WHITELIST];
}

// ---------------------------------------------------------------------------
// BI-08.3 · read_media_file —— 媒体文件结构化检视（委托 ReadMediaFile 器官）
// ---------------------------------------------------------------------------

interface MediaInspectDeps {
	readonly root: string;
	readonly jail: PathJail;
}

/**
 * read_media_file 绑定：喂模型定义 + 安全执行（路径守卫 + fs 注入）。
 * path 为工作区内相对路径 → guardReadPath 裁决（段级前缀逃逸 + PathJail read）→
 * 调 readMediaFile 器官（fs 用 node:fs readFile 包成端口；Buffer 是 Uint8Array
 * 子类，直接满足 ReadMediaFileDeps fs 端口的 Uint8Array 返回面）。器官结构化
 * 返回面原样透传（保持结构化返回面，不 JSON.stringify）。
 */
function mediaInspectBinding(root: string, jail: PathJail): ToolBinding {
	const deps: MediaInspectDeps = { root, jail };
	const fsPort = { readFile: (p: string) => readFile(p) };
	return {
		definition: {
			name: "read_media_file",
			description:
				"读取工作区内 PNG/JPEG 媒体文件，返回结构化元数据（MIME 类型 / 字节数 / 固有宽高像素）+ base64 数据。" +
				"支持 region 四元组 [x1, y1, x2, y2]（原始像素坐标）局部高精检视，与 fullResolution 全分辨率直出开关。" +
				"超出工作区根的路径一律拒绝。",
			inputSchema: {
				type: "object",
				properties: {
					path: { type: "string", description: "工作区内媒体文件的相对路径" },
					region: {
						type: "array",
						description: "局部高精检视区域 [x1, y1, x2, y2] 原始像素坐标（可选）",
						items: { type: "integer" },
					},
					fullResolution: { type: "boolean", description: "全分辨率直出开关（可选，缺省 false）" },
				},
				required: ["path"],
			},
		},
		readOnly: true,
		argSummary: (args) => summarizeArg(args, "path"),
		execute: async (args, signal) => {
			const path = takeStringArg(args, "path");
			const abs = guardReadPath(deps.root, deps.jail, path);
			const mediaArgs: ReadMediaFileArgs = { path: abs };
			const region = (args !== null && typeof args === "object" ? (args as Record<string, unknown>)["region"] : undefined) as
				| ReadMediaFileArgs["region"]
				| undefined;
			if (region !== undefined) mediaArgs.region = region;
			const fullResolution = (args !== null && typeof args === "object" ? (args as Record<string, unknown>)["fullResolution"] : undefined);
			if (fullResolution !== undefined) mediaArgs.fullResolution = fullResolution === true;
			const rhDeps: ReadMediaFileDeps = { fs: fsPort };
			return await withSignal(signal, async () => {
				const result: ReadMediaFileResult = await readMediaFile(mediaArgs, rhDeps);
				// 器官结构化返回面原样透传（保持结构化返回面，不 JSON.stringify）。
				return result;
			});
		},
	};
}

// ---------------------------------------------------------------------------
// BI-07.11 · JobList / JobOutput / JobKill —— 后台任务模型工具三件套
// ---------------------------------------------------------------------------

/**
 * 三件 jobs 工具绑定（委托既有 JobTools，零新造轮子）。
 * name/description/inputSchema 以 job-tools.ts 的 JOB_*_TOOL_SPEC 为单一事实源
 * （直接引用 spec 常量，勿手抄二次维护）。JobList/JobOutput 为只读面
 * （readOnly:true）；JobKill 改写任务状态（readOnly:false）。
 */
function jobListBinding(jobTools: JobTools): ToolBinding {
	return {
		definition: {
			...JOB_LIST_TOOL_SPEC,
			inputSchema: JOB_LIST_TOOL_SPEC.inputSchema as Record<string, unknown>,
		},
		readOnly: true,
		argSummary: () => "JobList",
		execute: () => jobTools.runList(),
	};
}

function jobOutputBinding(jobTools: JobTools): ToolBinding {
	return {
		definition: {
			...JOB_OUTPUT_TOOL_SPEC,
			inputSchema: JOB_OUTPUT_TOOL_SPEC.inputSchema as Record<string, unknown>,
		},
		readOnly: true,
		argSummary: (args) => `id=${optionalStringArg(args, "id")}`,
		execute: async (args) => jobTools.runOutput(args),
	};
}

function jobKillBinding(jobTools: JobTools): ToolBinding {
	return {
		definition: {
			...JOB_KILL_TOOL_SPEC,
			inputSchema: JOB_KILL_TOOL_SPEC.inputSchema as Record<string, unknown>,
		},
		readOnly: false,
		argSummary: (args) => `id=${optionalStringArg(args, "id")}`,
		execute: async (args) => jobTools.runKill(args),
	};
}

// ---------------------------------------------------------------------------
// BI-13.2 · lsp_navigate —— LSP 符号级导航（委托 createLspTool 器官）
// ---------------------------------------------------------------------------

/**
 * lsp_navigate 绑定：喂模型定义 + 安全执行（server 注入缝）。
 * 注册名 lsp_navigate 对齐挂载门/配置键（器官 createLspTool 的 spec name 为 "lsp"，
 * 本绑定覆盖为 "lsp_navigate" 以对齐工具面；operation 枚举以器官 LSP_OPERATIONS 为
 * 单一事实源，其余描述/输入面照器官原文手写——器官无 lsp_navigate 同名 SPEC）。
 * readOnly:true（查询类）。lspClient 未注入（server 未连）= 工具仍挂载，
 * execute 结构化返回 {ok:false,code:"lsp-unavailable"}，不抛裸异常（依赖缺失不伪造能力）。
 */
function lspNavigateBinding(client: LspToolClientLike | undefined): ToolBinding {
	return {
		definition: {
			name: "lsp_navigate",
			description:
				"LSP 符号级代码导航：goToDefinition（跳定义）、findReferences（找引用）、" +
				"goToImplementation（跳实现）、hover（悬停文档）。" +
				"输入 0 基行列；输出按文件分组渲染（≤100 条位置、16000 字符保护截断）。" +
				"要求 LSP 服务器已连接且声明对应能力。",
			inputSchema: {
				type: "object",
				properties: {
					operation: {
						type: "string",
						enum: [...LSP_OPERATIONS],
						description: "导航操作",
					},
					file_path: { type: "string", minLength: 1, description: "文件绝对路径或 file:// URI" },
					line: { type: "integer", minimum: 0, description: "0 基行号" },
					character: { type: "integer", minimum: 0, description: "0 基列号（UTF-16 码元）" },
				},
				required: ["operation", "file_path", "line", "character"],
				additionalProperties: false,
			},
		},
		readOnly: true,
		argSummary: (args) => summarizeArg(args, "file_path"),
		execute: async (args) => {
			// server 注入接缝缺失：结构化降级，不抛裸异常（房规：依赖缺失不伪造能力）。
			if (client === undefined) {
				return JSON.stringify({
					ok: false,
					code: "lsp-unavailable",
					message: "LSP server 未连接（lspClient 未注入）",
				});
			}
			const outcome = await createLspTool(client).handle(args);
			return JSON.stringify(outcome);
		},
	};
}

// ---------------------------------------------------------------------------
// BI-07.8 · AgentSwarm —— 并行子智能体蜂群（委托 AgentSwarmTool 器官）
// ---------------------------------------------------------------------------

/**
 * AgentSwarm 绑定：喂模型定义 + 受限执行（runner 注入缝）。
 * definition 以器官 AGENT_SWARM_TOOL_SPEC 为单一事实源（直接引用 spec 常量）。
 * readOnly:false（派发子代理属写/派发语义，非查询）。runner 由宿主经 SubagentRunner
 * 派生面装配注入（SwarmService）；本绑定只做工具包装，不接 spawnFn 端口本身。
 */
function agentSwarmBinding(runner: SwarmService): ToolBinding {
	return {
		definition: {
			...AGENT_SWARM_TOOL_SPEC,
			inputSchema: AGENT_SWARM_TOOL_SPEC.inputSchema as Record<string, unknown>,
		},
		readOnly: false,
		argSummary: (args) => summarizeArg(args, "prompt_template"),
		execute: async (args) => {
			const result = await new AgentSwarmTool(runner).run(args);
			return JSON.stringify(result);
		},
	};
}

// ---------------------------------------------------------------------------
// BI-07.9 · Skill —— 声明式技能调度（委托 SkillTool 器官）
// ---------------------------------------------------------------------------

/** 生产缺省 node:fs 端口（零真实网络/子进程；测试注 memfs 等价 stub）。 */
const nodeSkillFsPort: SkillFsPort = {
	readdir: (dir) => readdir(dir),
	readFile: (path) => readFile(path, "utf8"),
	isDirectory: (path) => {
		try {
			return statSync(path).isDirectory();
		} catch {
			return false;
		}
	},
};

/**
 * Skill 绑定：喂模型定义 + 安全执行（registry 注入缝）。
 * definition 以器官 SKILL_TOOL_SPEC 为单一事实源（直接引用 spec 常量）。
 * readOnly:true（查询类：展开 SKILL.md 为注入 prompt，不执行脚本）。
 * 器官自身容错：skills 目录缺失/空 → registry.refresh 后 list 为空 → execute 结构化
 * 返回 {ok:false,code:"no-skills"}，不抛（房规：依赖缺失不伪造能力）。
 * registry 缺省按 node:fs 端口自建（双技能目录扫描；目录不存在由器官按"该层无技能"处理）。
 */
function skillBinding(registry: SkillRegistry | undefined): ToolBinding {
	const resolved = registry ?? new SkillRegistry({ fs: nodeSkillFsPort });
	return {
		definition: {
			...SKILL_TOOL_SPEC,
			inputSchema: SKILL_TOOL_SPEC.inputSchema as Record<string, unknown>,
		},
		readOnly: true,
		argSummary: (args) => summarizeArg(args, "skill"),
		execute: async (args) => {
			// 每次执行刷新注册表（skills 目录可能变动；零真实网络/子进程）。
			await resolved.refresh();
			// skills 目录缺失/空 → 结构化降级，不抛。
			if (resolved.list().length === 0) {
				return JSON.stringify({
					ok: false,
					code: "no-skills",
					message: "no skills available（skills 目录缺失或为空）",
				});
			}
			const result = await new SkillTool({ registry: resolved }).run(args);
			return JSON.stringify(result);
		},
	};
}

// ---------------------------------------------------------------------------
// BI-13.1/BI-13.3 · select_tools —— 按需激活工具（registry 后端 = buildCatalog 名录）
// ---------------------------------------------------------------------------

/** 内置工具集命名空间（MCP 扩展面留缝；当前仅覆盖内置工具集）。 */
const SELECT_TOOLS_NAMESPACE = "builtin";
/** 名录摘要渐进展现的 token 预算（BI-13.3 flattenBudget 口径：2,000 token）。 */
const SELECT_TOOLS_CATALOG_BUDGET = 2000;

/** 扁平化名录条目（带所属命名空间，供紧凑字节/全量字节统计复用）。 */
type FlatCatalogTool = {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema?: unknown;
	readonly namespace: string;
};

/**
 * 把当前工具集的 ToolBinding[] 薄适配为 SelectToolsRegistryLike（不改器官）。
 * - 名录后端 = buildCatalog（对内置工具集建分级命名空间 + 预算内渐进摘要）；
 * - select(names)：名录内名字 → 返回全量 inputSchema（含 server 路由）；
 *   未知名 → 返回最近候选建议（Levenshtein 近邻，阈值内）；
 * - surfaceByteStats：baseline（全量展开）/ initial（紧凑名录）/ current（已激活
 *   增量叠加）三态字节统计，喂器官 compressionStats（初态压降口径）。
 *
 * 备注（接缝，本单不实现）：
 * 1. MCP 面工具（packages/mcp client 的 toolsAcrossServers）暂不纳入名录——
 *    当前会话工具集以内置为主；MCP 扩展待后续单接入（只需在 sources 追加一个
 *    MCP 命名空间并桥接 toolsAcrossServers 即可，registry 接口保持不变）。
 * 2. usageStats 消费：catalog 当前不接收激活计数（buildCatalog 无该入参）；
 *    select 命中计数留待器官接口支持后再喂 catalog（接缝，本单留注释）。
 */
export function makeSelectToolsRegistry(
	bindings: readonly ToolBinding[],
): SelectToolsRegistryLike & {
	/** 当前工具集的紧凑名录（buildCatalog 产物，供测试/日志断言）。 */
	readonly catalog: CatalogRoot;
	/** 预算内渐进式名录摘要行（BI-13.3 flattenBudget，2,000 token）。 */
	catalogSummary(): string[];
} {
	const sources: CatalogSource[] = [
		{
			name: SELECT_TOOLS_NAMESPACE,
			tools: bindings.map((b) => ({
				name: b.definition.name,
				description: b.definition.description,
				inputSchema: b.definition.inputSchema,
			})),
		},
	];
	const catalog = buildCatalog(sources);
	const flat: FlatCatalogTool[] = catalog.namespaces.flatMap((ns) =>
		ns.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, namespace: ns.namespace })),
	);
	const byName = new Map<string, FlatCatalogTool>(flat.map((t) => [t.name, t]));
	const allNames = [...byName.keys()];
	const activated = new Set<string>();

	return {
		catalog,
		catalogSummary(): string[] {
			return flattenBudget(catalog, SELECT_TOOLS_CATALOG_BUDGET);
		},
		async select(names) {
			const activatedTools: ActivatedToolLike[] = [];
			const alreadyActive: string[] = [];
			const unknown: UnknownToolRefusalLike[] = [];
			for (const name of names) {
				const tool = byName.get(name);
				if (tool === undefined) {
					unknown.push({
						kind: "unknown-tool",
						name,
						message: `工具 "${name}" 不在工具目录中`,
						suggestions: nearestNames(name, allNames),
					});
					continue;
				}
				if (activated.has(name)) {
					alreadyActive.push(name);
				}
				activated.add(name);
				activatedTools.push({
					name: tool.name,
					server: SELECT_TOOLS_NAMESPACE,
					description: tool.description ?? "",
					inputSchema: tool.inputSchema,
				});
			}
			return { activated: activatedTools, alreadyActive, unknown };
		},
		surfaceByteStats(): SurfaceByteStatsLike {
			let baseline = 0;
			let initial = 0;
			for (const t of flat) {
				baseline += byteLengthOf(
					JSON.stringify({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema }),
				);
				initial += byteLengthOf(summarizeToolLine(t.namespace, t));
			}
			const current =
				initial +
				[...activated].reduce((sum, name) => {
					const t = byName.get(name);
					if (t === undefined) return sum;
					const full = byteLengthOf(
						JSON.stringify({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema }),
					);
					const compact = byteLengthOf(summarizeToolLine(t.namespace, t));
					return sum + Math.max(0, full - compact);
				}, 0);
			return { baselineBytes: baseline, initialBytes: initial, currentBytes: current };
		},
	};
}

/**
 * select_tools 绑定：喂模型定义（activator.tool 单一事实源）+ 受限执行。
 * execute 委托 createToolActivator.handle；非法输入结构化回传（ok:false,error），
 * 不抛裸异常；合法激活结果原样 JSON 序列化（含 activated/alreadyActive/unknown）。
 * readOnly:true（查询类，仅换回 schema，不执行其他工具）。
 */
function selectToolsBinding(registry: SelectToolsRegistryLike): ToolBinding {
	const activator = createToolActivator(registry);
	return {
		definition: {
			...activator.tool,
			inputSchema: activator.tool.inputSchema as Record<string, unknown>,
		},
		readOnly: true,
		argSummary: (args) => summarizeArg(args, "names"),
		execute: async (args) => {
			const outcome = await activator.handle(args);
			if (!outcome.ok) {
				return JSON.stringify({ ok: false, error: outcome.error });
			}
			return JSON.stringify(outcome.result);
		},
	};
}

/** 最近候选名（Levenshtein 近邻，阈值内；无近邻返回空数组）。 */
function nearestNames(name: string, candidates: readonly string[], limit = 3): string[] {
	const threshold = Math.max(2, Math.floor(name.length / 3));
	return candidates
		.map((c) => ({ c, d: levenshtein(name, c) }))
		.filter((x) => x.d <= threshold)
		.sort((a, b) => a.d - b.d)
		.slice(0, limit)
		.map((x) => x.c);
}

/** Levenshtein 编辑距离（薄实现，仅用于未知工具名候选建议）。 */
function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	let prev = new Array<number>(n + 1);
	let cur = new Array<number>(n + 1);
	for (let j = 0; j <= n; j++) prev[j] = j;
	for (let i = 1; i <= m; i++) {
		cur[0] = i;
		for (let j = 1; j <= n; j++) {
			const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
			const del = (prev[j] ?? 0) + 1;
			const ins = (cur[j - 1] ?? 0) + 1;
			const sub = (prev[j - 1] ?? 0) + cost;
			cur[j] = Math.min(del, ins, sub);
		}
		const swap = prev;
		prev = cur;
		cur = swap;
	}
	return prev[n] ?? 0;
}
