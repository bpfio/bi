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
import { ConfigError } from "../packages/core/src/config/schema";
import { resolveModelPort, ModelPortConfigError } from "../packages/core/src/cli/model-port";
import { buildDefaultToolset } from "../packages/core/src/cli/toolset";
import { runBi } from "../packages/core/src/cli/main";
import { AgentTuiSession, MOUSE_DISABLE, MOUSE_ENABLE } from "../packages/tui/src/mount/agent-tui";
import { KeyStream, runRepl } from "../packages/tui/src/mount/repl";
import { InputLoop } from "../packages/tui/src/engine/diff-renderer";
import { PermissionGate } from "../packages/core/src/guard/permission-gate";
import { permissionModeFromConfig, PermissionSessionController } from "../packages/core/src/cli/permission-mode";
import {
  PERMISSIONS_USAGE,
  permissionsCommand,
} from "../packages/core/src/cli/commands/permissions-command";
import { discoverSlashCommands, slashCommandSurface } from "../packages/core/src/commands/custom-commands";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";

import { builtinSlashCandidates } from "../packages/tui/src/mount/candidate-menu";

type RawCapableStdin = AsyncIterable<Uint8Array> & { isTTY?: boolean; setRawMode?: (on: boolean) => void };

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
			menuCandidates = [...slashCommandSurface(discovered.commands), ...builtinFallback];
		} catch {
			menuCandidates = [...builtinFallback];
		}

		// /permissions 执行面接线(BI-28.3):其余 / 开头行走本地未知命令应答,
		// 均不入模型回合(agent-tui submit 拦截)。
		const slashCommand = async (line: string): Promise<string> => {
			const head = line.trim().split(/\s+/)[0] ?? "";
			if (head === "/permissions") {
				// parse 吃的是去前缀参数体("/permissions" 本身不入参)
				const body = line.trim().replace(/^\/permissions\b/, "").trim();
				const parsed = permissionsCommand.parse(body);
				if (!parsed.ok) return `${parsed.error.message}\n用法: ${PERMISSIONS_USAGE}`;
				return permissionsCommand.execute(parsed.args, controller.toPorts()).join("\n");
			}
			const known = menuCandidates.some((c) => `/${c.name}` === head);
			return known
				? `斜杠命令 ${head} 的执行面尚未接线(候选菜单可用,执行归后续卡)。`
				: `未知斜杠命令: ${head}(可用: /permissions)`;
		};

		const session = new AgentTuiSession({
			model: selection.port,
			tools: buildDefaultToolset(process.cwd()),
			cwd: process.cwd(),
			gate,
			candidates: () => menuCandidates,
			slashCommand,
			// 真实终端尺寸（BI-24.3）：此前缺省 24×80，大终端上提示符钉在第 24 行、
			// 转录画在第 1 行，画面与视口脱节。
			rows: process.stdout.rows ?? 24,
			cols: process.stdout.columns ?? 80,
			writer: { write: (data) => process.stdout.write(data) },
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
			const result = await runRepl({ session, keys, title: "bi repl" });
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
		: await runBi(argv, { headless: { tools: buildDefaultToolset(process.cwd()) } });
