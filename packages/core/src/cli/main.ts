/**
 * BI-23.1 —— bi 主分发（kimi 装配参考形状：main → handleMainCommand → TUI/无头）。
 *
 * 接线现状（BI-24.1 起八子命令查表派发）：
 * - 真实路径：无头会话（--prompt）——ModelPort 未注入时从配置装配（BI-02 凭据门 +
 *   BI-04.2 双模态 SSE 驱动），装配失败结构化退出码 3；
 * - 子命令：init/session/fork/export/transfer/acp/upgrade/doctor 全部经
 *   cli/commands/dispatch.ts handleSubcommand 派发到真实处理器（器官在库即用，
 *   缺器官结构化上报，不假冒成功）；未知子命令仍 exit 2；
 * - --version 直读 @bi/core VERSION。
 */
import { ConfigService } from "../config/config-service";
import { ConfigError, type BiConfig } from "../config/schema";
import { sanitizeErrorPayload } from "../observability/endpoint-sanitizer";
import { parseGlobalArgs, ArgParseError } from "./commands/args";
import {
	findSubcommandIndex,
	handleSubcommand,
	SUBCOMMANDS,
	SUBCOMMAND_SUMMARIES,
	type SubcommandDeps,
} from "./commands/dispatch";
import { ModelPortConfigError, resolveModelPort } from "./model-port";
import { assembleModelRouter, type ModelRouter } from "./model-router";
import { buildVerifyContract, runHeadless, type HeadlessOptions, type ModelPort } from "./headless";
import { buildDefaultToolset } from "./toolset";
import {
	createSubagentRunner,
	SUBAGENT_DEFAULT_MAX_ITERATIONS,
	SUBAGENT_DEFAULT_TIMEOUT_MS,
} from "./subagent-adapter";
import { SwarmService } from "../subagent/swarm/swarm-service";
import { statSync } from "node:fs";
import { PermissionGate } from "../guard/permission-gate";
import type { PermissionRule } from "../guard/types";
import { permissionModeFromConfig } from "./permission-mode";

export interface RunBiOptions {
	/** 无头模型端口（缺省 = 从配置文件装配真实 BI-04.2 驱动；测试注入替身）。 */
	model?: ModelPort;
	/** 透传 runHeadless 其余选项（测试注入 sessionsRoot/cwd/tools/hooks 等；homeDir 供 ConfigService 注入）。 */
	headless?: Partial<
		Pick<HeadlessOptions, "cwd" | "sessionsRoot" | "tools" | "hooks" | "permissionMode" | "trust" | "hookSpawn" | "maxRounds" | "gate"> & { homeDir: string }
	>;
	/** 输出汇（缺省 stdout）。 */
	out?: (line: string) => void;
	/** 诊断输出汇（缺省 stderr）。 */
	err?: (line: string) => void;
	/** BI-24.1 子命令注入面（临时根目录/IO/upgrade 检查替身等，详见 dispatch.ts）。 */
	deps?: SubcommandDeps;
	/**
	 * 注入已装载配置（测试 / 装配复用面）。用于 model 注入场景：据此提取
	 * 三开关而不触磁盘；model 未注入时仍走 ConfigService 真实装载（现状路径）。
	 * 注入了 model 而未注本面 = 无配置面 = 三开关恒不生效（缺省路径逐字节等价）。
	 */
	config?: BiConfig;
}

/** 渲染对齐的子命令清单（子命令 + 一句话摘要，纯文本对齐，kimi/zcode 风格）。 */
function renderSubcommandList(): string {
	const width = SUBCOMMANDS.reduce((max, s) => Math.max(max, s.length), 0);
	return SUBCOMMANDS.map((s) => `  ${s.padEnd(width)}  ${SUBCOMMAND_SUMMARIES[s] ?? ""}`).join("\n");
}

const USAGE = `bi — CLI Agent（行走骨架）

用法:
  bi --prompt "<text>" [--output-format stream-json]   无头会话（骨架真实路径）
  bi <subcommand> [args]                               子命令（见下）
  bi --version                                         版本
  bi --help                                            本帮助

子命令:
${renderSubcommandList()}

运行 bi <subcommand> --help 查看各子命令完整用法。
`;

/** bi 主入口：argv 分发，返回进程退出码。 */
export async function runBi(argv: readonly string[], options: RunBiOptions = {}): Promise<number> {
	const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
	const err = options.err ?? ((line: string) => process.stderr.write(`${line}\n`));

	if (argv.includes("--version")) {
		const { VERSION } = await import("../index");
		out(`bi ${VERSION}`);
		return 0;
	}
	if (argv.length === 0) {
		err(USAGE);
		return 2;
	}

	// BI-24.1：子命令 argv 切分——首个子命令裸词之后的 token 不进全局参数矩阵，
	// 原样交给子命令自持旗标面（--limit / --format / --no-net 等不由全局解析报错）。
	const subIndex = findSubcommandIndex(argv);
	const hasSubcommand = subIndex !== -1;

	// 顶层 help 仅当"无子命令"时显示主 help；带子命令的 --help/-h 由其自身
	// handleSubcommand 拦截（帮助优先于用法校验），不在此短路。
	if (!hasSubcommand && (argv.includes("--help") || argv.includes("-h"))) {
		err(USAGE);
		return 0;
	}

	let parsed;
	try {
		// 仅解析子命令之前的全局 token；剥离顶层 --help/-h（子命令级 --help 由
		// handleSubcommand 处理），避免 unknown-flag。
		const globalArgv = (hasSubcommand ? argv.slice(0, subIndex) : argv).filter(
			(t) => t !== "--help" && t !== "-h",
		);
		parsed = parseGlobalArgs(globalArgv);
	} catch (cause) {
		if (cause instanceof ArgParseError) {
			err(`bi: 参数错误 [${cause.code}]: ${cause.message}`);
			return 2;
		}
		throw cause;
	}

	const subcommand = subIndex === -1 ? parsed.positionals[0] : argv[subIndex];
	if (subcommand !== undefined) {
		if (!SUBCOMMANDS.includes(subcommand)) {
			err(`bi: 未知子命令 "${subcommand}"`);
			err(USAGE);
			return 2;
		}
		// 查表派发：headless 注入面（cwd/homeDir/sessionsRoot）同时作为子命令缺省
		// 注入（deps 显式值优先），两条路径共享同一注入语义。
		const h = options.headless ?? {};
		const deps: SubcommandDeps = {
			...(h.cwd !== undefined ? { cwd: h.cwd } : {}),
			...(h.homeDir !== undefined ? { homeDir: h.homeDir } : {}),
			...(h.sessionsRoot !== undefined ? { sessionsRoot: h.sessionsRoot } : {}),
			...options.deps,
		};
		if (deps.buildModelPort === undefined) {
			// BI-25.2：acp session/prompt 生产面——配置装配惰性 memo 化（每进程装配一次）。
			// homeDir 取 deps.homeDir ?? h.homeDir：测试可注入空目录实现零外呼确定性。
			const factoryHomeDir = deps.homeDir ?? h.homeDir;
			let memoPort: Promise<ModelPort> | undefined;
			deps.buildModelPort = () => {
				memoPort ??= (async () => {
					const service = new ConfigService({
						...(factoryHomeDir !== undefined ? { homeDir: factoryHomeDir } : {}),
					});
					const config = await service.load();
					const selection = resolveModelPort(config, {
						resolveApiKey: (name) => service.resolveProviderApiKey(name),
					});
					err(`bi: 模型已装配 provider=${selection.providerName} mode=${selection.mode} model=${selection.wireModel}`);
					return selection.port;
				})();
				return memoPort;
			};
		}
		const restArgs = subIndex === -1 ? parsed.positionals.slice(1) : argv.slice(subIndex + 1);
		return handleSubcommand(subcommand, restArgs, { out, err }, deps);
	}

	if (parsed.prompt === undefined || parsed.prompt === "") {
		err('bi: 无头会话需要 --prompt "<text>"');
		return 2;
	}

	// BI-20.2b：解析后无人消费的全局 flag 接进装配面——最小诚实消费，绝不假冒成功。
	// 1) --agent-file：读 Markdown 定义文件，内容作为系统指令注入无头会话；
	//    文件缺失/不可读 = 结构化参数错误 exit 2。kimi 为 agentFiles 复数，bi 保持
	//    单文件契约（差异在最终回复备案）。
	let agentInstruction: string | undefined;
	if (parsed.agentFile !== undefined) {
		try {
			agentInstruction = await Bun.file(parsed.agentFile).text();
		} catch (cause) {
			err(`bi: 参数错误 [param-error]: --agent-file 不可读或不存在: ${parsed.agentFile}（${cause instanceof Error ? cause.message : String(cause)}）`);
			return 2;
		}
	}
	// 2) --add-dir（可重复）：存在性 + 目录校验（缺失/非目录 = 结构化 exit 2）；
	//    透传进无头会话上下文（toolset 暂单根，仅校验+透传+备案边界，不静默丢弃）。
	let additionalDirs: string[] = [];
	if (parsed.addDirs.length > 0) {
		for (const dir of parsed.addDirs) {
			try {
				if (!statSync(dir).isDirectory()) {
					err(`bi: 参数错误 [param-error]: --add-dir 不是目录: ${dir}`);
					return 2;
				}
			} catch (cause) {
				err(`bi: 参数错误 [param-error]: --add-dir 不可访问或不存在: ${dir}（${cause instanceof Error ? cause.message : String(cause)}）`);
				return 2;
			}
		}
		additionalDirs = parsed.addDirs;
	}

	const h = options.headless ?? {};
	let model = options.model;
	let configGate: PermissionGate | undefined;
	/** 已装载配置（真实装载或注入面）；缺省 = 无配置面，三开关恒不生效。 */
	let loadedConfig: BiConfig | undefined;
	/** 工单 H：模型插槽路由器（仅真实装配路径物化；注入 model 的路径不装配，subagent 直用主端口 = 等价回退语义）。 */
	let modelRouter: ModelRouter | undefined;
	if (model === undefined) {
		// BI-23.3：真实驱动装配 = 配置装载（三级 TOML+env）→ BI-02 凭据门 → BI-04.2 双模态适配器。
		try {
			const service = new ConfigService({
				...(h.homeDir !== undefined ? { homeDir: h.homeDir } : {}),
				...(h.cwd !== undefined ? { workDir: h.cwd } : {}),
			});
			const config = await service.load();
			loadedConfig = config;
			const selection = resolveModelPort(config, {
				resolveApiKey: (name) => service.resolveProviderApiKey(name),
			});
			err(`bi: 模型已装配 provider=${selection.providerName} mode=${selection.mode} model=${selection.wireModel}`);
			model = selection.port;
			// 工单 H（BI-04 缺件补齐）：模型插槽路由器装配——secondary_model 三键
			// （subagent/background/summarize）逐个尝试装配；失败置空 + stderr 一行
			// 日志（不阻断），route() 永不因插槽缺失失败（回退主端口是缺省语义）。
			// resolvePort 复用 resolveModelPort 全链（凭据门/thinking/extra_headers 同构）。
			// background/summarize 消费点随后续紧缩接线跟进，本波只交付 route() 面。
			{
				const resolveSlotPort = (providerName: string, modelName: string): ModelPort => {
					const slotConfig: BiConfig = {
						...config,
						providers: { ...config.providers, default: providerName },
						models: {
							...config.models,
							default: "__bi_slot__",
							entries: {
								__bi_slot__: {
									provider: providerName,
									model: modelName,
									max_tokens: 0,
									temperature: 0.7,
									context_limit: 0,
								},
							},
						},
					};
					return resolveModelPort(slotConfig, {
						resolveApiKey: (name) => service.resolveProviderApiKey(name),
					}).port;
				};
				modelRouter = assembleModelRouter(config, resolveSlotPort, {
					main: model,
					log: (line) => err(line),
				});
			}
			// BI-28.3 接线:config [permission] mode → 门禁三态;规则表灌入(config 规则
			// 无 scope 字段,静态规则缺省 scope="always");与 /permissions 共享实例由
			// gate 注入面承载(无头路径无命令面,直接装配)。
			configGate = new PermissionGate({ mode: permissionModeFromConfig(config.permission?.mode) });
			// config 规则的 ask 动作 = 缺省语义,门禁静态层(allow/deny)不表,装配时剔除;
			// 显式构造(不用展开+窄化推断,与仓库 TS 版本的推断行为解耦)。
			const staticRules: PermissionRule[] = [];
			for (const rule of config.permission?.rules ?? []) {
				if (rule.action === "ask") continue;
				staticRules.push({ tool: rule.tool, pattern: rule.pattern, action: rule.action, scope: "always" });
			}
			configGate.addRules(staticRules);
		} catch (cause) {
			if (cause instanceof ConfigError || cause instanceof ModelPortConfigError) {
				err(`bi: ${cause.message}`);
				return 3;
			}
			throw cause;
		}
	} else if (options.config !== undefined) {
		// 注入式装配：跳过磁盘装载，直接用注入配置提取三开关（测试确定性）。
		loadedConfig = options.config;
	}

	// BI-08.1 / BI-11.1 / BI-21.1 三开关：仅 config 显式开启时才传进无头面；
	// 缺省键值（0 / false / 未声明）= 不传 = 现状路径逐字节等价。
	const outputLimitBytes = loadedConfig?.tools.output_limit_bytes ?? 0;
	const sanitizeErrors = loadedConfig?.telemetry.sanitize_errors ?? false;
	const verifySection = loadedConfig?.verify;

	// BI-07.4：config [subagent] enabled 时装配 SubagentRunner 并经 headless 注入
	// spawn_subagent 工具（缺省 enabled=false = 不装配，既有工具面与对话流零变动）。
	const subagentSection = loadedConfig?.subagent;
	// BI-16.2：config [ptc] 分区；enabled 缺省 false。
	const ptcSection = loadedConfig?.ptc;
	// BI-05.3（W3-D7）：config [context] 挂载式分区；任一子键显式声明才物化，
	// 缺省 config.context === undefined → 不传 → headless 全部开关恒关（逐字节等价）。
	const contextSection = loadedConfig?.context;
	// BI-05.1（W4-D9）：config [memory] 挂载式分区；缺省 config.memory === undefined
	// → 不传 → headless 沉淀/注入全关（逐字节等价）。仅显式声明才物化，子键按
	// dream_enabled / inject_enabled 各自下发，未开启的子面不进 option（零行为差）。
	const memorySection = loadedConfig?.memory;
	const subagentRunner =
		subagentSection?.enabled === true
			? createSubagentRunner({
					// 工单 H：子智能体模型走插槽路由（secondary_model.subagent 装配成功
					// → 插槽端口；未配置/装配失败 → 回退主端口，永不因插槽缺失失败）。
					model: modelRouter?.route("subagent") ?? model,
					tools: h.tools ?? [],
				sessionsRoot: h.sessionsRoot,
				maxRounds: subagentSection.max_iterations ?? SUBAGENT_DEFAULT_MAX_ITERATIONS,
				timeoutMs: subagentSection.timeout_ms ?? SUBAGENT_DEFAULT_TIMEOUT_MS,
				})
			: undefined;

	// BI-07.8：AgentSwarm 调度器装配（随 BI-25 子代理使能联动）。SwarmService 的
	// spawnFn 端口委托 SubagentRunner 派生面（每条目渲染为 prompt 派生子代理）。
	// 仅当 subagent 使能且 SubagentRunner 已实例化才装配；否则 swarmRunner 为
	// undefined —— 此时 toolset 的 swarm 门无效、不挂载 AgentSwarm（依赖缺失不伪造能力）。
	const swarmRunner =
		subagentRunner !== undefined
			? new SwarmService((prompt) =>
				subagentRunner.spawn("explore", prompt, {}).then((r) => (r.ok ? r.summary : (r.error ?? "subagent-failed"))),
			)
			: undefined;

	try {
		const result = await runHeadless({
			prompt: parsed.prompt,
			cwd: h.cwd ?? process.cwd(),
			model,
			// BI-16.2：仅 config [ptc] enabled 时才自建工具集（含 ptc 边界）；
			// 未开启保持既有缺省 []——不改变直连调用方（测试/嵌入）的工具面。
			tools:
				h.tools ??
				(ptcSection?.enabled === true
					? buildDefaultToolset(h.cwd ?? process.cwd(), {
							ptcDeps: {
								timeoutMs: ptcSection.timeout_ms,
								maxToolCalls: ptcSection.max_tool_calls,
							},
							// BI-08.3 / BI-07.11：无头路径 tools 整体仍受 [ptc] enabled 门控（现状不动），
							// 仅在其内传递各开关（config [tools] media / job_tools / lsp 显式开启才挂载）。
							media: loadedConfig?.tools.media === true,
							jobs: loadedConfig?.tools.job_tools === true,
							// BI-13.2：lsp_navigate 挂载门（config [tools] lsp，键已加齐）；
							// lspClient 由宿主 LSP server 连接面注入（本卡不接 server 装配——
							// 未连时工具结构化返回 lsp-unavailable）。
							lsp: loadedConfig?.tools.lsp === true,
							// BI-07.8：AgentSwarm 随子代理使能联动（swarm 门 = [subagent] enabled）；
							// swarmRunner 实例一并传入（上一步装配）。
							swarm: subagentSection?.enabled === true,
							swarmRunner,
						// BI-07.9：Skill 常挂（恒传 true）；skills 目录缺失由器官容错 no-skills。
						skill: true,
						// BI-13.1/BI-13.3：select_tools 挂载门（config [tools] select_tools，缺省 false）。
						select_tools: loadedConfig?.tools.select_tools === true,
					})
					: []),
			...(h.hooks !== undefined ? { hooks: h.hooks } : {}),
			...(h.sessionsRoot !== undefined ? { sessionsRoot: h.sessionsRoot } : {}),
			...(h.permissionMode !== undefined ? { permissionMode: h.permissionMode } : {}),
			...(h.gate !== undefined ? { gate: h.gate } : {}),
			...(configGate !== undefined ? { gate: configGate } : {}),
			...(h.trust !== undefined ? { trust: h.trust } : {}),
			...(h.hookSpawn !== undefined ? { hookSpawn: h.hookSpawn } : {}),
			// BI-30.3 接线：CLI --output-format 接进无头输出面（缺省 stream-json 由 headless 决定）。
			...(parsed.outputFormat !== undefined ? { outputFormat: parsed.outputFormat } : {}),
			// BI-20.2b 接线：--agent-file → 系统指令注入面；--add-dir → 附加目录透传面。
			...(agentInstruction !== undefined ? { systemInstruction: agentInstruction } : {}),
			...(additionalDirs.length > 0 ? { additionalDirs } : {}),
			// BI-08.1 / BI-11.1 / BI-21.1 三开关（config 显式开启才生效）。
			...(outputLimitBytes > 0 ? { outputLimitBytes } : {}),
			...(sanitizeErrors ? { sanitizeErrors: true } : {}),
			...(verifySection?.on_completion === true
				? { verify: { contract: buildVerifyContract(verifySection) } }
				: {}),
			// CLI --max-rounds 优先于 deps 透传（BI-30 dogfood 发现：真实工单 8 回合不够）。
			...((parsed.maxRounds ?? h.maxRounds) !== undefined
				? { maxRounds: parsed.maxRounds ?? h.maxRounds }
				: {}),
			// BI-07.4：子智能体装配（config [subagent] enabled 才注入 spawn_subagent 工具）。
			...(subagentRunner !== undefined ? { subagentRunner } : {}),
			// BI-05.3：上下文引擎装配（config [context] 声明才下发；各开关缺省关，
			// 子键经映射传入 headless 装配面，未声明 = 不传 = 现状路径逐字节等价）。
			...(contextSection !== undefined
				? {
						context: {
							timeContext: contextSection.time_context === true,
							dateChangeSensor: contextSection.date_change_sensor === true,
							toolResultPrune: contextSection.tool_result_prune === true,
							maxHistoryEntries: contextSection.max_history_entries > 0 ? contextSection.max_history_entries : 0,
							timezone: contextSection.timezone,
							// 虚账清偿波次 1：BI-08.2 / BI-10 两开关（config 显式声明才可能
							// 为 true；缺省 false = headless 侧零变动）。
							imageOffload: contextSection.image_offload === true,
							autoCompactor: contextSection.auto_compactor === true,
						},
					}
				: {}),
			// BI-05.1（W4-D9）：记忆沉淀装配（config [memory] 声明才下发；子键各自按
			// 开关映射，未开启的子面不进 option。dir 缺省取 cwd（沉淀/注入读取同根）。
			...(memorySection !== undefined
				? {
						memory: {
							...(memorySection.dream_enabled === true ? { dream: { dir: h.cwd ?? process.cwd() } } : {}),
							...(memorySection.inject_enabled === true ? { inject: { dir: h.cwd ?? process.cwd() } } : {}),
						},
					}
				: {}),
			...(options.out !== undefined ? { out: options.out } : {}),
		});
		return result.exitCode;
	} catch (cause) {
		// BI-11.1：会话错误文本输出前按 config [telemetry] sanitize_errors 脱敏
		// （无配置面 = 现状原样输出）。
		const rawMessage = cause instanceof Error ? cause.message : String(cause);
		const message = sanitizeErrors ? sanitizeErrorPayload(rawMessage) : rawMessage;
		err(`bi: 会话失败: ${message}`);
		return 1;
	}
}
