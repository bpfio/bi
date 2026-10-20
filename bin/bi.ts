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
import { runBi } from "../packages/core/src/cli/main";
import { AgentTuiSession, MOUSE_DISABLE, MOUSE_ENABLE } from "../packages/tui/src/mount/agent-tui";
import { KeyStream, runRepl } from "../packages/tui/src/mount/repl";
import { loadKeybindings } from "../packages/tui/src/mount/keybindings";
import { InputLoop } from "../packages/tui/src/engine/diff-renderer";
import { PermissionGate } from "../packages/core/src/guard/permission-gate";
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
async function runReplMain(stdin: RawCapableStdin): Promise<number> {
	try {
		const service = new ConfigService();
		const config = await service.load();
		const selection = resolveModelPort(config, {
			resolveApiKey: (name) => service.resolveProviderApiKey(name),
		});
		process.stderr.write(`bi: 模型已装配 provider=${selection.providerName} mode=${selection.mode} model=${selection.wireModel}\n`);

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
			// 交互式确认回调未注册 → 门禁按 fail-closed 判拒绝并如实回报
			// (备案:宿主可经 confirm 端口接交互确认;另一入口——edit/write 工具
			//  执行前的 diff 预览——留待后续卡,见 mount/diff-gate.ts 头注)。
			if (head === "/diff") {
				const args = parseDiffArgs(trimmed.slice(head.length).trim());
				if (!args.ok) return args.error;
				const result = await runDiffGate({ cwd: process.cwd() });
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

		const session = new AgentTuiSession({
			model: selection.port,
			tools: buildDefaultToolset(process.cwd(), {
				// BI-16.2：config [ptc] enabled 才注入 PTC 执行边界（缺省不挂，零变化）。
				...(config.ptc?.enabled === true
					? { ptcDeps: { timeoutMs: config.ptc.timeout_ms, maxToolCalls: config.ptc.max_tool_calls } }
					: {}),
				// BI-08.3 / BI-07.11：挂载式门控（config [tools] media / job_tools 显式开启才挂载）。
				media: config.tools?.media === true,
				jobs: config.tools?.job_tools === true,
				// BI-13.2：lsp_navigate 挂载门（config [tools] lsp，键已加齐）；
				// lspClient 由宿主 LSP server 连接面注入（本卡不接 server 装配）。
				lsp: config.tools?.lsp === true,
				// BI-07.8：AgentSwarm 随子代理使能联动；swarmRunner 实例一并传入。
				swarm: subagentSection?.enabled === true,
				swarmRunner,
			// BI-07.9：Skill 常挂（恒传 true）；skills 目录缺失由器官容错 no-skills。
			skill: true,
			// BI-13.1/BI-13.3：select_tools 挂载门（config [tools] select_tools，缺省 false）。
			select_tools: config.tools?.select_tools === true,
		}),
			cwd: process.cwd(),
			gate,
			candidates: () => menuCandidates,
			slashCommand,
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
		if (stdin.isTTY === true) {
			try {
				stdin.setRawMode?.(true); // raw-mode 尽力而为；失败退化为行式输入
				process.stdout.write(MOUSE_ENABLE); // BI-27.5 滚轮历史:SGR 鼠标上报
			} catch {
				// 忽略：非交互/受限终端
			}
		}
		loop.start();
		try {
			const result = await runRepl({ session, keys, title: "bi repl", keybindings: kb.bindings });
			return result.endedAs === "session-exited" ? 4 : 0;
		} finally {
			loop.stop();
			if (stdin.isTTY === true) {
				try {
					process.stdout.write(MOUSE_DISABLE); // 离场还原鼠标语义
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
process.exitCode =
	argv.length === 0
		? await runReplMain(process.stdin as RawCapableStdin)
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
