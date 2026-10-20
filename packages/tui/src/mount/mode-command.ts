/**
 * BI-20.1 接线 —— 四态工作模式命令面（/mode）。
 *
 * 器官：core/src/modes/mode-selector.ts（ModeSelector：四态状态机 + plan 只读
 * 拦截）。本卡只做接线——斜杠候选面（可发现）+ 分发面：
 *   - /mode        → 显示当前态；
 *   - /mode <id>   → 切换到 plan/edit/build/yolo；
 *   - /mode <非法> → 结构化拒绝（unknown-mode），不静默忽略。
 *
 * 与权限面的关系（BI-28.3 权限三态门 manual/auto/yolo 并存不合并）：
 * mode-selector 是「工作模式」（plan = 只读语义），权限面继续走 permission-mode；
 * plan 态下宿主把 PermissionGate 切到 manual，并以 ModeSelector.intercept
 * 施加只读约束（宿主侧接线见 mount/agent-tui.ts）。本模块只负责「切到哪一态」
 * 与回执文案，不碰权限门（避免两套模式语义在此处合并）。
 *
 * 徽标文本取 tui/components/mode-indicator.ts（与 core 的 MODE_LABELS 同一映射）。
 */

import { MODE_ORDER, type ModeId, type ModeSelector } from "../../../core/src/modes/mode-selector";
import { renderModeIndicator } from "../components/mode-indicator";
import type { Candidate } from "./candidate-menu";

/** 命令名（候选面与分发面的公共名表；不含前导 "/"）。 */
export const MODE_COMMAND_NAME = "mode" as const;

/** 缺省工作模式（非 plan：不拦写；plan 为只读态，宿主按需显式切入）。 */
export const DEFAULT_WORK_MODE: ModeId = "build";

/** /mode 的候选面条目（斜杠菜单可发现）。 */
export const modeCommandCandidates: readonly Candidate[] = [
	{
		name: MODE_COMMAND_NAME,
		description: "切换工作模式（plan 只读 / edit / build / yolo；无参显示当前态）",
	},
];

/** 结构化错误码。 */
export type ModeCommandErrorCode = "unknown-command" | "unknown-mode";

/** 结构化错误（回执文本原样上屏）。 */
export interface ModeCommandError {
	readonly code: ModeCommandErrorCode;
	readonly message: string;
}

/** 分发结果：ok=已执行（changed=false 表示切到当前态）；!ok=结构化拒绝。 */
export type ModeCommandResult =
	| { readonly ok: true; readonly mode: ModeId; readonly changed: boolean; readonly text: string }
	| { readonly ok: false; readonly error: ModeCommandError };

/** 取命令头（"/mode" → "mode"；非斜杠行或他命令返回 undefined）。 */
export function modeCommandName(line: string): string | undefined {
	const head = line.trim().split(/\s+/)[0] ?? "";
	if (!head.startsWith("/")) return undefined;
	const name = head.slice(1);
	return name === MODE_COMMAND_NAME ? name : undefined;
}

/** 行首是否命中 /mode（会话在模型回合前据此分流）。 */
export function isModeCommandLine(line: string): boolean {
	return modeCommandName(line) !== undefined;
}

/** 模式 id 是否合法（四态表：plan/edit/build/yolo）。 */
export function isModeId(value: string): value is ModeId {
	return (MODE_ORDER as readonly string[]).includes(value);
}

/** plan 态只读提示（结构化拒绝码随行透出，宿主/模型据此识别）。 */
function readonlyHint(): string {
	return "只读生效：写操作被 plan-mode-readonly 拒绝";
}

/**
 * 分发：行 → 模式 id → 器官 setMode → 回执。
 * 器官负责状态机与变更事件；本函数只做参数解析与文案，不改权限门。
 */
export function dispatchModeCommand(line: string, selector: ModeSelector): ModeCommandResult {
	const trimmed = line.trim();
	const head = trimmed.split(/\s+/)[0] ?? "";
	const name = modeCommandName(trimmed);
	if (name === undefined) {
		return { ok: false, error: { code: "unknown-command", message: `未知命令: ${head}` } };
	}
	const rest = trimmed.slice(head.length).trim();
	const badge = renderModeIndicator(selector.getMode());
	if (rest === "") {
		const mode = selector.getMode();
		const suffix = mode === "plan" ? `（${readonlyHint()}）` : "";
		return {
			ok: true,
			mode,
			changed: false,
			text: `${badge} 当前模式: ${mode}${suffix}`,
		};
	}
	if (!isModeId(rest)) {
		return {
			ok: false,
			error: {
				code: "unknown-mode",
				message: `未知模式: ${rest}（可选 ${MODE_ORDER.join("/")}）`,
			},
		};
	}
	const previous = selector.getMode();
	selector.setMode(rest);
	const changed = selector.getMode() !== previous;
	const modeBadge = renderModeIndicator(rest);
	const suffix = rest === "plan" ? `（${readonlyHint()}）` : "";
	const prefix = changed ? "已切换到" : "当前已是";
	return {
		ok: true,
		mode: rest,
		changed,
		text: `${modeBadge} ${prefix} ${rest}${suffix}`,
	};
}
