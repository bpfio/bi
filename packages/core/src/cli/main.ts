/**
 * BI-23.1 —— bi 主分发（kimi 装配参考形状：main → handleMainCommand → TUI/无头）。
 *
 * 接线现状（骨架期，诚实边界）：
 * - 真实路径：无头会话（--prompt，注入式 ModelPort；真实 SSE 驱动随 BI-23.3）；
 * - 已识别未接线：init/session/fork/export/transfer/acp/upgrade 等子命令的处理器
 *   均已在库（BI-20.2/20.6/20.7/BI-03 交付），逐个挂上分发归后续装配卡——本层
 *   结构化上报 "not-wired"，不假冒执行；
 * - --version 直读 @bi/core VERSION。
 */
import { parseGlobalArgs, ArgParseError } from "./commands/args";
import { runHeadless, type HeadlessOptions, type ModelPort } from "./headless";

/** 已识别但尚未挂接的子命令（逐个接线归 BI-23.2/23.3 及后续装配卡）。 */
const RECOGNIZED_UNWIRED: readonly string[] = [
	"init",
	"session",
	"fork",
	"export",
	"transfer",
	"acp",
	"upgrade",
	"doctor",
];

export interface RunBiOptions {
	/** 无头模型端口（骨架期注入；真实驱动 BI-23.3）。 */
	model?: ModelPort;
	/** 透传 runHeadless 其余选项（测试注入 sessionsRoot/cwd/tools/hooks 等）。 */
	headless?: Partial<Pick<HeadlessOptions, "cwd" | "sessionsRoot" | "tools" | "hooks" | "permissionMode" | "trust" | "hookSpawn" | "maxRounds">>;
	/** 输出汇（缺省 stdout）。 */
	out?: (line: string) => void;
	/** 诊断输出汇（缺省 stderr）。 */
	err?: (line: string) => void;
}

const USAGE = `bi — CLI Agent（行走骨架）

用法:
  bi --prompt "<text>" [--output-format stream-json]   无头会话（骨架真实路径）
  bi <subcommand> [args]                               子命令（见下）
  bi --version                                         版本

子命令: ${RECOGNIZED_UNWIRED.join(" / ")}（骨架期未接线，结构化上报）
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

	let parsed;
	try {
		parsed = parseGlobalArgs(argv);
	} catch (cause) {
		if (cause instanceof ArgParseError) {
			err(`bi: 参数错误 [${cause.code}]: ${cause.message}`);
			return 2;
		}
		throw cause;
	}

	const subcommand = parsed.positionals[0];
	if (subcommand !== undefined) {
		if (RECOGNIZED_UNWIRED.includes(subcommand)) {
			err(`bi: 子命令 "${subcommand}" 已识别但装配未接线（BI-23.2/23.3 及后续装配卡），本次退出。`);
			return 4;
		}
		err(`bi: 未知子命令 "${subcommand}"`);
		err(USAGE);
		return 2;
	}

	if (parsed.prompt === undefined || parsed.prompt === "") {
		err('bi: 无头会话需要 --prompt "<text>"');
		return 2;
	}
	if (options.model === undefined) {
		err("bi: 无模型端口（骨架期 ModelPort 为注入式；真实 SSE 驱动随 BI-23.3 接入）。");
		return 3;
	}

	try {
		const h = options.headless ?? {};
		const result = await runHeadless({
			prompt: parsed.prompt,
			cwd: h.cwd ?? process.cwd(),
			model: options.model,
			tools: h.tools ?? [],
			...(h.hooks !== undefined ? { hooks: h.hooks } : {}),
			...(h.sessionsRoot !== undefined ? { sessionsRoot: h.sessionsRoot } : {}),
			...(h.permissionMode !== undefined ? { permissionMode: h.permissionMode } : {}),
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
