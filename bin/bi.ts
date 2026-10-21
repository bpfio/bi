#!/usr/bin/env bun
/**
 * bi 真入口：BI-20.2 建立、BI-23.1 接 main 分发、BI-24.2 接 REPL 主路径。
 *
 * 装配序（kimi 装配参考 main→cli→tui 段）：
 * - 无参 = 交互 REPL：配置装配（三级 TOML+env）→ BI-02 凭据门 → BI-04.2 真实
 *   驱动 → AgentTuiSession（writer=stdout）→ runRepl（InputLoop→KeyStream 真实桥）；
 *   凭据/配置失败结构化退出码 3（与 headless 同一面）。
 * - 带参 = runBi 全局分发（--version/--help/--prompt 无头/八子命令，BI-24.1）。
 */
import { ConfigService } from "../packages/core/src/config/config-service";
import { ConfigError, type BiConfig } from "../packages/core/src/config/schema";
import { resolveModelPort, ModelPortConfigError } from "../packages/core/src/cli/model-port";
import { buildDefaultToolset } from "../packages/core/src/cli/toolset";
import { mountMcpServers } from "../packages/core/src/cli/mcp-mount";
import { CronService } from "../packages/core/src/cron/cron-service";
import { workflowCronCorePort } from "../packages/core/src/cli/cron-kernel";
import { runBi } from "../packages/core/src/cli/main";
import { parseResumeArg } from "../packages/core/src/cli/commands/args";
import { resumeContextMessages, withResumeHistory } from "../packages/core/src/cli/resume-context";
import { SessionManager } from "../packages/core/src/session/manager";
import type { AgentMessage } from "../packages/core/src/adapters/deepseek-adapter";
import { AgentTuiSession, mouseModeSequences } from "../packages/tui/src/mount/agent-tui";
import { KeyStream, runRepl, type ReplInitialSession } from "../packages/tui/src/mount/repl";
import { attachConfigWatch } from "../packages/tui/src/mount/config-watch";
import { loadKeybindings } from "../packages/tui/src/mount/keybindings";
import { InputLoop } from "../packages/tui/src/engine/diff-renderer";
import { PermissionGate } from "../packages/core/src/guard/permission-gate";
import type { PermissionRule } from "../packages/core/src/guard/types";
import { permissionModeFromConfig, PermissionSessionController } from "../packages/core/src/cli/permission-mode";
import {
  createSubagentRunner,
  SUBAGENT_DEFAULT_MAX_ITERATIONS,
  SUBAGENT_DEFAULT_TIMEOUT_MS,
} from "../packages/core/src/cli/subagent-adapter";
import { SwarmService } from "../packages/core/src/subagent/swarm/swarm-service";
import {
  PERMISSIONS_USAGE,
  permissionsCommand,
} from "../packages/core/src/cli/commands/permissions-command";
import {
	discoverSlashCommands,
	expandCommand,
	slashCommandSurface,
	type SlashCommand,
} from "../packages/core/src/commands/custom-commands";
import { GATE_COMMAND_NAMES } from "../packages/tui/src/mount/gate-commands";
import { parseDiffArgs, runDiffGate } from "../packages/tui/src/mount/diff-gate";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";

import { builtinSlashCandidates, COMMAND_CATALOG } from "../packages/tui/src/mount/candidate-menu";
import { createVisTokenAuthority } from "../packages/tui/src/vis/vis-token-authority";

type RawCapableStdin = AsyncIterable<Uint8Array> & { isTTY?: boolean; setRawMode?: (on: boolean) => void };

/**
 * 模型上下文窗口（BI-11 接线：TokenHud 分母）——取 config
 * models.entries[modelId].context_limit；0/未配 = undefined（会话走缺省 128000）。
 */
function contextLimitOf(config: BiConfig, modelId: string): number | undefined {
	const limit = config.models.entries[modelId]?.context_limit ?? 0;
	return limit > 0 ? limit : undefined;
}

/** BI-27.4 内置候选兜底(tui 命令面最小集;发现失败/空目录时仍可用)。 */
const builtinFallback = builtinSlashCandidates;

/** 交互 REPL 主路径（bin 层装配；REPL v1 纯对话，工具注册表面归后续装配卡）。 */
async function runReplMain(stdin: RawCapableStdin, resumeSessionId?: string): Promise<number> {
	try {
		// 先读配置取 [watch] 偏好（构造 ConfigService 的 watch 选项用；否则构造期无法读 config）
		const probe = new ConfigService();
		const probeConfig = await probe.load();
		const service = new ConfigService({
			watchDebounceMs: probeConfig.watch.debounce_ms,
			watchIgnore: probeConfig.watch.ignore,
		});
		const config = await service.load();
		// [watch] 三键接线：enabled 才开文件监听热重载（缺省 false 零行为差）。
		attachConfigWatch(service, config.watch);

		// FIX-A F4：--resume 续会话——经 SessionManager 重开既有会话（既有 API：
		// reopenSession 校验 + 取历史）。无效 id → 结构化报错并退出（exit 2）。
		// 校验前置到模型装配之前：坏 id 立即结构化失败，不被凭据/模型问题掩盖。
		let resumeHistory: AgentMessage[] = [];
		let initialSession: ReplInitialSession | undefined;
		if (resumeSessionId !== undefined) {
			const manager = new SessionManager();
			let reopened;
			try {
				reopened = await manager.reopenSession(resumeSessionId);
			} catch {
				process.stderr.write(
					`bi: 参数错误 [session-not-found]: --resume 会话不存在: ${resumeSessionId}\n`,
				);
				return 2;
			}
			resumeHistory = resumeContextMessages(reopened.entries);
			initialSession = { sessionId: reopened.sessionId, title: reopened.title };
			process.stderr.write(
				`bi: 已恢复会话 ${reopened.sessionId}（历史 ${resumeHistory.length} 条已注入模型上下文）\n`,
			);
		}

		const selection = resolveModelPort(config, {
			resolveApiKey: (name) => service.resolveProviderApiKey(name),
		});
		process.stderr.write(`bi: 模型已装配 provider=${selection.providerName} mode=${selection.mode} model=${selection.wireModel}\n`);
		// FIX-A F4：既有历史经模型端口包装前置到每次请求的 messages 首位（不改
		// agent-tui.ts 的私有消息面——TUI 侧无消息注入缝，包装是宿主层唯一无侵入口）。
		const modelPort = withResumeHistory(selection.port, resumeHistory);

		// BI-28.3 接线:权限面单实例——config [permission] mode/rules 建门禁(规则
		// 缺 scope 补 always),控制器喂 /permissions 命令面;工具回路与命令面共享。
		const gate = new PermissionGate({ mode: permissionModeFromConfig(config.permission?.mode) });
// config 规则的 ask 动作 = 缺省语义,门禁静态层(allow/deny)不表,装配时剔除
		const staticRules: PermissionRule[] = [];
		for (const rule of config.permission?.rules ?? []) {
			if (rule.action === "ask") continue;
			staticRules.push({ tool: rule.tool, pattern: rule.pattern, action: rule.action, scope: "always" });
		}
		gate.addRules(staticRules);
		const controller = new PermissionSessionController({ gate });

		// BI-27.4 接线:自定义斜杠命令入候选菜单(内置 + ~/.bi/commands + <cwd>/.bi/commands);
		// 发现失败退回内置候选,不影响 REPL 启动。
		// BI-30.1:完整命令注册表(SlashCommand[])保留——补全面取 name/description
		// 子集,执行面按名取命令对象喂 expandCommand;发现失败 = 空注册表。
		let customCommands: readonly SlashCommand[] = [];
		let menuCandidates: ReadonlyArray<{ name: string; description: string }> = [];
		try {
			const commandFs = {
				readdir: async (path: string): Promise<string[]> => {
					const entries = await readdir(path, { withFileTypes: true });
					return entries.filter((e) => e.isFile()).map((e) => e.name);
				},
				readFile: async (path: string): Promise<string> => readFile(path, "utf8"),
			};
			const discovered = await discoverSlashCommands(
				[join(homedir(), ".bi", "commands"), join(process.cwd(), ".bi", "commands")],
				commandFs,
			);
			customCommands = discovered.commands; // 完整注册表(执行面用,不只 surface 条目)
			menuCandidates = [...slashCommandSurface(discovered.commands), ...builtinFallback];
		} catch {
			customCommands = [];
			menuCandidates = [...builtinFallback];
		}

		// 斜杠命令执行面(BI-30.1;/permissions 归 BI-28.3):返回两形态——
		// - 已知自定义命令 → expandCommand(命令对象, 参数数组):
		//     ok → { prompt: 展开文本 } = 展开后的用户提示词,入模型回合;
		//     !ok → error.message = 本地错误文本(不入模型回合);
		// - /permissions 与未知命令:语义不变(本地文本回执,不入模型回合)。
		const slashCommand = async (line: string): Promise<string | { prompt: string }> => {
			const trimmed = line.trim();
			const head = trimmed.split(/\s+/)[0] ?? "";
			if (head === "/permissions") {
				// parse 吃的是去前缀参数体("/permissions" 本身不入参)
				const body = trimmed.replace(/^\/permissions\b/, "").trim();
				const parsed = permissionsCommand.parse(body);
				if (!parsed.ok) return `${parsed.error.message}\n用法: ${PERMISSIONS_USAGE}`;
				return permissionsCommand.execute(parsed.args, controller.toPorts()).join("\n");
			}
			// BI-20 接线：diff 审查门入口(REPL 斜杠命令,侵入面最小的一入口)——
			// 工作区 git diff → parseDiff → renderDiff → presentDiff 审查门。
			// FIX-B F5：审查门接真交互确认——confirm 端口注入会话的确认浮层
			// (y=批准 / n·Esc=拒绝；浮层态 awaiting-confirm,REPL 据此把按键
			// 派给浮层栈顶)。用户看到的是渲染后的真实 diff 内容。
			if (head === "/diff") {
				const args = parseDiffArgs(trimmed.slice(head.length).trim());
				if (!args.ok) return args.error;
				const result = await runDiffGate({
					cwd: process.cwd(),
					ports: {
						confirm: (view, summary) => session.confirmReview(view, summary),
					},
				});
				return result.text;
			}
			// BI-11 接线：手动门三命令由会话内建执行体处理（会话在模型回合前
			// 分流,命令对象走 core 注册表）——走到宿主命令面说明装配缺环,
			// 如实回报而非冒充未知命令。
			if (GATE_COMMAND_NAMES.includes(head.slice(1) as (typeof GATE_COMMAND_NAMES)[number])) {
				return `斜杠命令 ${head} 由会话内建执行体处理(未到宿主命令面)。`;
			}
			// BI-20.1 接线：/mode 由会话内建执行体处理（会话在模型回合前分流，
			// 状态机走 core 模式器官）——走到宿主命令面说明装配缺环,如实回报。
			if (head === "/mode") {
				return `斜杠命令 ${head} 由会话内建执行体处理(未到宿主命令面)。`;
			}
			const command = customCommands.find((c) => `/${c.name}` === head);
			if (command !== undefined) {
				// 参数体 = 去命令头后的余下文本,按空白切分喂位置参数($1..$n/$ARGUMENTS)。
				const rest = trimmed.slice(head.length).trim();
				const argv = rest === "" ? [] : rest.split(/\s+/);
				const expanded = expandCommand(command, argv);
				return expanded.ok ? { prompt: expanded.text } : expanded.error.message;
			}
			const known = menuCandidates.some((c) => `/${c.name}` === head);
			if (known) {
				return `斜杠命令 ${head} 的执行面尚未接线(内置候选,执行归后续卡)。`;
			}
			// F-ST-01：未知斜杠命令提示从 COMMAND_CATALOG（单一事实源）渲染完整指令列表。
			const catalog = COMMAND_CATALOG.map((c) => `/${c.name}`).join(" ");
			return `未知斜杠命令: ${head}\n可用指令: ${catalog}`;
		};

		// TUI-ALIGN-4a：键位注册表装配（~/.bi 优先,项目 .bi/ 兜底;文件缺失=纯默认;
		// 冲突/忽略告警 stderr 提示,不阻断启动）。
		const homeKeybindings = join(homedir(), ".bi", "keybindings.json");
		const projectKeybindings = join(process.cwd(), ".bi", "keybindings.json");
		const kb = await loadKeybindings(
			existsSync(homeKeybindings) ? homeKeybindings : projectKeybindings,
		);
		if (kb.conflicts.length > 0 || kb.ignored.length > 0) {
			process.stderr.write(`bi: 键位加载告警: 忽略 ${kb.ignored.length} 项, 冲突 ${kb.conflicts.length} 项\n`);
		}

		// BI-07.4 / BI-07.8：子代理使能时装配 SubagentRunner（仅用于支撑 AgentSwarm
		// 调度器 spawnFn；spawn_subagent 经 headless/tui 各自接缝挂载，本处不重复注册）。
		const subagentSection = config.subagent;
		const subagentRunner =
			subagentSection?.enabled === true
				? createSubagentRunner({
						model: selection.port,
						tools: [],
						maxRounds: subagentSection.max_iterations ?? SUBAGENT_DEFAULT_MAX_ITERATIONS,
						timeoutMs: subagentSection.timeout_ms ?? SUBAGENT_DEFAULT_TIMEOUT_MS,
					})
				: undefined;
		// BI-07.8：AgentSwarm 调度器（swarm 门 = [subagent] enabled；swarmRunner 一并传入）。
		const swarmRunner =
			subagentRunner !== undefined
				? new SwarmService((prompt) =>
						subagentRunner.spawn("explore", prompt, {}).then((r) => (r.ok ? r.summary : (r.error ?? "subagent-failed"))),
					)
				: undefined;

		// FIX-A F1：config [cron] enabled 时装配 CronService（调度核经 CronCorePort
		// 委托仓库现成 cron 解析核——workflow BI-07.14，适配器 cli/cron-kernel.ts），
		// 注入工具集缝 → cron_schedule/cron_list/cron_remove 三工具真正工作。
		// 备案：到点自动触发仍未接线（工具描述与 README 如实陈述）。
		const cronService =
			config.cron?.enabled === true ? new CronService({ core: workflowCronCorePort() }) : undefined;
		// FIX-A F2：config [mcp.servers] 非空即挂载（与 [ptc] 解耦——[ptc] 只管
		// run_ptc_script 工具）；客户端随 REPL 生命周期，退出时 closeAll 尽力关闭。
		const mcpServers = config.mcp?.servers ?? {};
		const mcpMount =
			Object.keys(mcpServers).length > 0
				? await mountMcpServers(config.mcp ?? { servers: {} }, process.cwd(), {
						warn: (line) => process.stderr.write(`${line}\n`),
					})
				: null;
		const mcpTools = mcpMount?.tools ?? [];

		const session = new AgentTuiSession({
			model: modelPort,
			tools: [
				...buildDefaultToolset(process.cwd(), {
					// BI-16.2：config [ptc] enabled 才注入 PTC 执行边界（缺省不挂，零变化）。
					...(config.ptc?.enabled === true
						? { ptcDeps: { timeoutMs: config.ptc.timeout_ms, maxToolCalls: config.ptc.max_tool_calls } }
						: {}),
					// BI-08.3 / BI-07.11：挂载式门控（config [tools] media / job_tools 显式开启才挂载）。
					media: config.tools?.media === true,
					jobs: config.tools?.job_tools === true,
					// BI-13.2：lsp_navigate 挂载门（config [tools] lsp，键已加齐）；
					// FIX-A F3：lspClient 未注入（宿主未提供 LSP server 装配）→ 工具不挂载
					// + 结构化警告（挂一个恒不可用的工具即虚账）。
					lsp: config.tools?.lsp === true,
					// FIX-A F3：结构化警告出口（stderr 诊断面）。
					warn: (line) => process.stderr.write(`${line}\n`),
					// BI-07.8：AgentSwarm 随子代理使能联动；swarmRunner 实例一并传入。
					swarm: subagentSection?.enabled === true,
					swarmRunner,
					// BI-07.9：Skill 常挂（恒传 true）；skills 目录缺失由器官容错 no-skills。
					skill: true,
					// BI-13.1/BI-13.3：select_tools 挂载门（config [tools] select_tools，缺省 false）。
					select_tools: config.tools?.select_tools === true,
					// FIX-A F1：[cron] enabled 时注入 CronService（cron 三件套挂载门）。
					...(cronService !== undefined ? { cronService } : {}),
				}),
				// FIX-A F2：MCP stdio 装配结果并入工具面（[mcp.servers] 非空时非空）。
				...mcpTools,
			],
			cwd: process.cwd(),
			gate,
			candidates: () => menuCandidates,
			slashCommand,
			// [loop_control] 三键接线（config 显式声明才生效；0 = 该键不生效）：
			// max_tool_calls_per_turn = 单回合工具调用上限；step_timeout_ms = 工具限时
			// 看门狗缺省时限（0 = 关闭看门狗）。
			...(config.loop_control?.max_tool_calls_per_turn !== undefined &&
			config.loop_control.max_tool_calls_per_turn > 0
				? { maxToolCallsPerTurn: config.loop_control.max_tool_calls_per_turn }
				: {}),
			...(config.loop_control?.step_timeout_ms !== undefined && config.loop_control.step_timeout_ms > 0
				? { stepTimeoutMs: config.loop_control.step_timeout_ms }
				: {}),
			// [identity] 横幅身份面（name = 产品名替代；tagline = 副题行）。
			...(config.identity !== undefined ? { identity: config.identity } : {}),
			// BI-11 接线：TokenHud 分母 = 模型上下文窗口（config context_limit；
			// 0/未配 = 会话缺省 128000）。
			...(contextLimitOf(config, selection.modelId) !== undefined
				? { contextTokens: contextLimitOf(config, selection.modelId)! }
				: {}),
			// 真实终端尺寸（BI-24.3）：此前缺省 24×80，大终端上提示符钉在第 24 行、
			// 转录画在第 1 行，画面与视口脱节。
			rows: process.stdout.rows ?? 24,
			cols: process.stdout.columns ?? 80,
			writer: { write: (data) => process.stdout.write(data) },
			keybindings: kb.bindings,
		});
		const keys = new KeyStream();
		// 终端尺寸变更跟随（SIGWINCH；非 TTY 无事件，保守注册）。
		process.on("SIGWINCH", () => {
			session.resize(process.stdout.rows ?? 24, process.stdout.columns ?? 80);
		});

		// 真实输入桥：stdin 字节 → InputLoop（粘贴聚合+按键解析）→ KeyStream。
		// EOF 桥：reader 耗尽（管道关闭/EOF）即 KeyStream.end()——InputLoop 静默
		// 吞掉 reader 结束，REPL 的 eof 终场需此显式信号。
		async function* stdinChunks(): AsyncIterable<Uint8Array> {
			try {
				for await (const chunk of stdin) yield chunk;
			} finally {
				keys.end();
			}
		}
		const loop = new InputLoop(stdinChunks(), (key) => keys.push(key));
		// FIX-B F6：config [tui] mouse_mode 真接线（schema 缺省 true）——
		// 关闭时既不启用 SGR 鼠标上报，也不写还原序列（不启用即不还原）。
		const mouse = mouseModeSequences(config.tui.mouse_mode);
		if (stdin.isTTY === true) {
			try {
				stdin.setRawMode?.(true); // raw-mode 尽力而为；失败退化为行式输入
				if (mouse.enable !== "") process.stdout.write(mouse.enable); // BI-27.5 滚轮历史:SGR 鼠标上报
			} catch {
				// 忽略：非交互/受限终端
			}
		}
		loop.start();
		try {
			const result = await runRepl({
				session,
				keys,
				title: "bi repl",
				keybindings: kb.bindings,
				// FIX-A F4：续会话——复用既有会话（会话 id 连续、JSONL 续写）。
				...(initialSession !== undefined ? { initialSession } : {}),
			});
			return result.endedAs === "session-exited" ? 4 : 0;
		} finally {
			loop.stop();
			// FIX-A F2：REPL 退出后尽力关闭 MCP 客户端（释放子进程），失败静默吞。
			await mcpMount?.closeAll().catch(() => {});
			if (stdin.isTTY === true) {
				try {
					if (mouse.disable !== "") process.stdout.write(mouse.disable); // 离场还原鼠标语义
					stdin.setRawMode?.(false);
				} catch {
					// 忽略
				}
			}
			// F-ST-06 修复：REPL 退出后显式中断 stdin 读取。否则 runRepl 返回后
			// `for await (stdin)` 仍挂起未结束的读（InputLoop.consume 仅在下一
			// chunk 抵达才 break），事件循环不排空，进程挂起直至被 SIGKILL（exit -9）。
			// destroy 令 stdinChunks 生成器 finally 触发 keys.end() 并收束 consume，
			// 进程得以 exit 0 干净退出（与 Ctrl+C 空稿退出路径同源）。
			const anyStdin = stdin as unknown as { destroy?: (err?: unknown) => void };
			if (typeof anyStdin.destroy === "function") {
				try {
					anyStdin.destroy();
				} catch {
					// 忽略：销毁失败不阻断退出
				}
			}
		}
	} catch (cause) {
		if (cause instanceof ConfigError || cause instanceof ModelPortConfigError) {
			process.stderr.write(`bi: ${cause.message}\n`);
			return 3;
		}
		throw cause;
	}
}

const argv = process.argv.slice(2);
// FIX-A F4：REPL 启动路径接受 --resume <sessionId>（仅此旗标可带；带 --prompt
// 等无头旗标时仍走无头路径——无头续会话本就有 --resume 入口）。
const resumeArg = parseResumeArg(argv);
const replMode = argv.length === 0 || (resumeArg.resume !== undefined && resumeArg.rest.length === 0);
process.exitCode =
	replMode
		? await runReplMain(process.stdin as RawCapableStdin, resumeArg.resume)
		: await runBi(argv, {
				headless: {},
				// BI-20.5 接线：vis 令牌轮转权威（tui 侧产物注入 core 的令牌权威端口
				// ——core 不依赖 tui，依赖方向不倒置）。仅 env BI_VIS_TOKEN_ROTATE=1
				// 时 core 侧才启用；缺省走现状静态令牌路径。
				deps: {
					visTokenAuthority: (onRotate) =>
						createVisTokenAuthority(onRotate !== undefined ? { onRotate } : {}),
				},
			});
