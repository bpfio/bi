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
import { ConfigError } from "../config/schema";
import { parseGlobalArgs, ArgParseError } from "./commands/args";
import {
	findSubcommandIndex,
	handleSubcommand,
	SUBCOMMANDS,
	type SubcommandDeps,
} from "./commands/dispatch";
import { ModelPortConfigError, resolveModelPort } from "./model-port";
import { runHeadless, type HeadlessOptions, type ModelPort } from "./headless";
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
}

const USAGE = `bi — CLI Agent（行走骨架）

用法:
  bi --prompt "<text>" [--output-format stream-json]   无头会话（骨架真实路径）
  bi <subcommand> [args]                               子命令（见下）
  bi --version                                         版本

子命令: ${SUBCOMMANDS.join(" / ")}
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
	if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
		err(USAGE);
		return argv.length === 0 ? 2 : 0;
	}

	// BI-24.1：子命令 argv 切分——首个子命令裸词之后的 token 不进全局参数矩阵，
	// 原样交给子命令自持旗标面（--limit / --format / --no-net 等不由全局解析报错）。
	const subIndex = findSubcommandIndex(argv);

	let parsed;
	try {
		parsed = parseGlobalArgs(subIndex === -1 ? argv : argv.slice(0, subIndex));
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

	const h = options.headless ?? {};
	let model = options.model;
	let configGate: PermissionGate | undefined;
	if (model === undefined) {
		// BI-23.3：真实驱动装配 = 配置装载（三级 TOML+env）→ BI-02 凭据门 → BI-04.2 双模态适配器。
		try {
			const service = new ConfigService({
				...(h.homeDir !== undefined ? { homeDir: h.homeDir } : {}),
				...(h.cwd !== undefined ? { workDir: h.cwd } : {}),
			});
			const config = await service.load();
			const selection = resolveModelPort(config, {
				resolveApiKey: (name) => service.resolveProviderApiKey(name),
			});
			err(`bi: 模型已装配 provider=${selection.providerName} mode=${selection.mode} model=${selection.wireModel}`);
			model = selection.port;
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
	}

	try {
		const result = await runHeadless({
			prompt: parsed.prompt,
			cwd: h.cwd ?? process.cwd(),
			model,
			tools: h.tools ?? [],
			...(h.hooks !== undefined ? { hooks: h.hooks } : {}),
			...(h.sessionsRoot !== undefined ? { sessionsRoot: h.sessionsRoot } : {}),
			...(h.permissionMode !== undefined ? { permissionMode: h.permissionMode } : {}),
			...(h.gate !== undefined ? { gate: h.gate } : {}),
			...(configGate !== undefined ? { gate: configGate } : {}),
			...(h.trust !== undefined ? { trust: h.trust } : {}),
			...(h.hookSpawn !== undefined ? { hookSpawn: h.hookSpawn } : {}),
			...(h.maxRounds !== undefined ? { maxRounds: h.maxRounds } : {}),
			...(options.out !== undefined ? { out: options.out } : {}),
		});
		return result.exitCode;
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		err(`bi: 会话失败: ${message}`);
		return 1;
	}
}
