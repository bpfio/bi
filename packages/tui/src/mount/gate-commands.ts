/**
 * BI-11 接线 —— 手动门三命令（/compact /rewind /clear）的候选面与分发面。
 *
 * 命令对象来自 core（packages/core/src/commands/compact.ts，只读不改）：本卡
 * 只做注册表接线——把三命令挂进斜杠候选面（可发现），并提供统一分发入口
 * （按名取命令对象 → parse 参数 → execute 注入端口）。
 *
 * 诚实边界：
 * - 执行体不在本文件：三命令的真实语义（紧缩/回退/清空）由宿主经端口注入
 *   （CommandContext），本卡只保证「可被发现 + 可被分发」；
 * - 参数校验沿用 core 命令对象（rewind 步数须正整数、clear 不接受参数、
 *   compact 余参整体作提示词），结构化错误原样透出。
 */

import {
	findGateCommand,
	type CommandContext,
	type CommandError,
} from "../../../core/src/commands/compact";
import type { Candidate } from "./candidate-menu";

/** 三命令名（候选面与分发面的公共名表）。 */
export const GATE_COMMAND_NAMES = ["compact", "rewind", "clear"] as const;

/** 三命令的候选面条目（斜杠菜单可发现；name 不含前导 "/"）。 */
export const gateCommandCandidates: readonly Candidate[] = [
	{ name: "compact", description: "紧缩当前上下文（可带提示词）" },
	{ name: "rewind", description: "回退最近 N 轮对话" },
	{ name: "clear", description: "清空当前会话上下文与转录" },
];

/** 分发结果：ok=命令已执行；!ok=参数校验失败（结构化错误原样透出）。 */
export type GateDispatchResult =
	| { readonly ok: true; readonly command: (typeof GATE_COMMAND_NAMES)[number] }
	| { readonly ok: false; readonly error: CommandError };

/**
 * 三命令执行体替身注入面：宿主可逐项覆盖（测试注入假执行体；缺省项走宿主
 * 内建执行体）。返回 Promise 的执行体由会话在分发后等待落定。
 */
export interface GateCommandOverrides {
	/** /compact 执行体。 */
	readonly compact?: (prompt?: string) => void | Promise<void>;
	/** /rewind 执行体。 */
	readonly rewind?: (steps: number) => void | Promise<void>;
	/** /clear 执行体。 */
	readonly clear?: () => void | Promise<void>;
}

/**
 * 类型擦除后的命令视图：core 的 AnyGateCommand 是异构泛型联合
 * （GateCommand<{prompt?}> | GateCommand<{steps}> | GateCommand<undefined>），
 * 直接调用 parse/execute 会因签名不兼容而不可调用；本卡在分发面一次性擦除
 * 参数类型，参数校验仍由各命令对象的 parse 承担。
 */
interface ErasedGateCommand {
	parse(args: string): { ok: true; args: unknown } | { ok: false; error: CommandError };
	execute(args: unknown, ctx: CommandContext): void;
}

/** 取命令头（"/compact" → "compact"；非斜杠行返回 undefined）。 */
export function gateCommandName(line: string): string | undefined {
	const head = line.trim().split(/\s+/)[0] ?? "";
	if (!head.startsWith("/")) return undefined;
	const name = head.slice(1);
	return findGateCommand(name) !== undefined ? name : undefined;
}

/** 行首是否命中三命令（会话在模型回合前据此分流）。 */
export function isGateCommandLine(line: string): boolean {
	return gateCommandName(line) !== undefined;
}

/**
 * 分发：行 → 命令对象（core 注册表）→ parse 参数 → execute（端口注入）。
 * 命令名不在注册表 → unknown-command；参数非法 → 命令对象自身的结构化错误。
 */
export function dispatchGateCommand(line: string, ctx: CommandContext): GateDispatchResult {
	const trimmed = line.trim();
	const head = trimmed.split(/\s+/)[0] ?? "";
	const name = gateCommandName(trimmed);
	if (name === undefined) {
		return { ok: false, error: { code: "unknown-command", message: `未知命令: ${head}` } };
	}
	const command = findGateCommand(name) as unknown as ErasedGateCommand | undefined;
	if (command === undefined) {
		return { ok: false, error: { code: "unknown-command", message: `未知命令: ${head}` } };
	}
	const rest = trimmed.slice(head.length).trim();
	const parsed = command.parse(rest);
	if (!parsed.ok) return { ok: false, error: parsed.error };
	command.execute(parsed.args, ctx);
	return { ok: true, command: name as (typeof GATE_COMMAND_NAMES)[number] };
}
