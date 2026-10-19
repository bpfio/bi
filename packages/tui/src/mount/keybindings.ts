/**
 * TUI-ALIGN-4a —— 键位可配置注册表（kimi keybindings 对齐）。
 *
 * 设计取舍（对齐 kimi 的「动作→键位注册表 + 覆盖语义」，但不搬其
 * @moonshot-ai/pi-tui 依赖）：
 * - 单一事实源：`DEFAULT_KEYBINDINGS`（动作名 → 规范化键串）。当前值逐条对照
 *   repl.ts / agent-tui.ts 的硬编码键位整理，确保**行为零变化**。
 * - `normalizeKey`：大小写 + `ctrl-`/`ctrl+` 前缀规范化（"Ctrl+A" / "CTRL+a" /
 *   "ctrl-a" 全归一到 "ctrl+a"）；非法键串返回 null。
 * - `loadKeybindings(path)`：读 JSON（{ 动作: "ctrl+a" }）覆盖默认；文件缺失 =
 *   纯默认；未知动作 / 非法键串结构化忽略并计入返回值；两动作绑同键 = 后到覆盖，
 *   冲突对记入告警列表随加载结果返回（简单策略，不过度设计）。
 * - `actionForKey` / `keyMatches`：解析后的 ParsedKey 反查动作（消费面纯函数，可测）。
 *
 * 消费面：repl.ts（LineEditor + 转录搜索转发）、agent-tui.ts（搜索态 Enter/Esc/
 * Ctrl+G、Ctrl+F 开搜索、审批 y/n）经选项注入 Keybindings；bin/bi.ts 装配处加载
 * 一次传入。
 */

import { readFile } from "node:fs/promises";
import type { ParsedKey } from "../engine/diff-renderer";

// ---------------------------------------------------------------------------
// 动作名与默认表（逐条对照现码硬编码键位）
// ---------------------------------------------------------------------------

/** 可配置键位动作名。 */
export type KeybindingAction =
	| "editor.beginning-of-line"
	| "editor.backward-char"
	| "editor.external-edit"
	| "editor.kill-line"
	| "editor.kill-line-to-start"
	| "editor.kill-word-backward"
	| "editor.yank"
	| "editor.undo"
	| "editor.clear-or-exit"
	| "editor.exit"
	| "search.open"
	| "search.previous"
	| "search.next"
	| "search.close"
	| "approval.allow"
	| "approval.deny";

/** 动作名 → 规范化键串 的注册表。 */
export type Keybindings = Readonly<Record<KeybindingAction, string>>;

/**
 * 默认键位表（= 当前全部硬编码键位，行为零变化）：
 * - D7 emacs 键（repl.ts LineEditor.feed 的 ctrl 分支）：
 *   ctrl+a=行首 / ctrl+b=左移 / ctrl+e=外编桥 / ctrl+k=删至行尾 /
 *   ctrl+u=删至行首 / ctrl+w=删词 / ctrl+y=yank / ctrl+z=undo /
 *   ctrl+c=清空或退出 / ctrl+d=退出弃稿；
 * - 转录搜索（agent-tui.ts handleKey）：ctrl+f=开搜索 / ctrl+g=上一命中 /
 *   enter=下一命中（搜索态）/ esc=关闭搜索（搜索态）；
 * - 审批回路（agent-tui.ts ApprovalOverlay）：y=允许 / n=拒绝。
 */
export const DEFAULT_KEYBINDINGS: Keybindings = {
	"editor.beginning-of-line": "ctrl+a",
	"editor.backward-char": "ctrl+b",
	"editor.external-edit": "ctrl+e",
	"editor.kill-line": "ctrl+k",
	"editor.kill-line-to-start": "ctrl+u",
	"editor.kill-word-backward": "ctrl+w",
	"editor.yank": "ctrl+y",
	"editor.undo": "ctrl+z",
	"editor.clear-or-exit": "ctrl+c",
	"editor.exit": "ctrl+d",
	"search.open": "ctrl+f",
	"search.previous": "ctrl+g",
	"search.next": "enter",
	"search.close": "esc",
	"approval.allow": "y",
	"approval.deny": "n",
};

// ---------------------------------------------------------------------------
// 规范化与匹配（纯函数）
// ---------------------------------------------------------------------------

/** 具名键 kind（非 ctrl / 非单字符）。 */
const NAMED_KINDS = new Set([
	"enter",
	"tab",
	"backspace",
	"esc",
	"up",
	"down",
	"left",
	"right",
	"pageup",
	"pagedown",
	"home",
	"end",
]);

/**
 * 规范化键串：大小写不敏感；支持 "ctrl+<字母/数字>"（含 "ctrl-" 连字符写法）。
 * - "ctrl+a" / "CTRL+A" / "ctrl-a" → "ctrl+a"；
 * - 具名 kind（enter/esc/tab/backspace/up/down/left/right/pageup/pagedown/home/
 *   end）→ 小写原样；
 * - 单字符（长度 1）→ 该字符（小写）。
 * 非法（空/无法归类）→ null。
 */
export function normalizeKey(input: string): string | null {
	const s = input.trim().toLowerCase();
	if (s === "") return null;
	const ctrlMatch = /^ctrl[-+](.+)$/.exec(s);
	if (ctrlMatch !== null) {
		const letter = ctrlMatch[1]!;
		if (/^[a-z0-9]$/.test(letter)) return `ctrl+${letter}`;
		return null;
	}
	if (NAMED_KINDS.has(s)) return s;
	if (s.length === 1) return s; // 单字符 = 普通字符键（如 "y"）
	return null;
}

/** ParsedKey → 规范化键串（反向匹配的单一来源）。 */
function canonicalKey(key: ParsedKey): string {
	if (key.kind === "ctrl") return `ctrl+${(key.char ?? "").toLowerCase()}`;
	if (key.kind === "char") return (key.char ?? "").toLowerCase();
	return key.kind; // enter / esc / tab / backspace / 方向 / 分页 / home / end
}

/** 按键是否匹配给定键串（内部已规范化；非法键串恒 false）。 */
export function keyMatches(key: ParsedKey, binding: string): boolean {
	const norm = normalizeKey(binding);
	if (norm === null) return false;
	return canonicalKey(key) === norm;
}

/**
 * 反查：给定 ParsedKey，返回其当前绑定的动作（无则返回 undefined）。
 * 线性扫描注册表（动作数固定且极小，O(1) 量级；消费面每键一次，开销可忽略）。
 */
export function actionForKey(bindings: Keybindings, key: ParsedKey): KeybindingAction | undefined {
	const target = canonicalKey(key);
	for (const action of Object.keys(bindings) as KeybindingAction[]) {
		if (normalizeKey(bindings[action]!) === target) return action;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// 加载（JSON 覆盖 + 冲突/忽略结构化返回）
// ---------------------------------------------------------------------------

/** 被忽略的覆盖条目（结构化）。 */
export interface IgnoredEntry {
	readonly action?: string;
	readonly key?: string;
	readonly reason: "unknown-action" | "illegal-key" | "non-string" | "parse-error" | "read-error";
}

/** 冲突对：后到动作 by 覆盖已被 overridden 占用的键 key。 */
export interface ConflictEntry {
	readonly key: string;
	readonly overridden: KeybindingAction;
	readonly by: KeybindingAction;
}

/** loadKeybindings 返回值。 */
export interface LoadResult {
	/** 合并后的最终注册表（文件缺失/错误 = 纯默认）。 */
	readonly bindings: Keybindings;
	/** 被忽略的覆盖条目（未知动作 / 非法键串 / 非字符串 / 解析或读错误）。 */
	readonly ignored: readonly IgnoredEntry[];
	/** 冲突对（两动作绑同键，后到覆盖）。 */
	readonly conflicts: readonly ConflictEntry[];
}

/** 反向查找：当前已把 norm 绑给哪个动作（用于冲突检测）。 */
function reverseLookup(bindings: Record<string, string>, norm: string): KeybindingAction | undefined {
	for (const action of Object.keys(bindings)) {
		if (normalizeKey(bindings[action]!) === norm) return action as KeybindingAction;
	}
	return undefined;
}

/**
 * 加载键位覆盖文件（JSON：{ 动作: "ctrl+a" }）。
 * - 文件缺失（ENOENT）= 纯默认，ignored/conflicts 为空；
 * - 读/解析错误 → 纯默认 + 一条 ignored（read-error / parse-error）；
 * - 未知动作 / 非法键串 / 非字符串值 → 忽略并计入 ignored；
 * - 两动作绑同键 → 后到覆盖，冲突对记入 conflicts（随结果返回，不抛错）。
 * 永不 reject（装配面安全：任何失败回退纯默认）。
 */
export async function loadKeybindings(path: string): Promise<LoadResult> {
	const bindings: Record<string, string> = { ...DEFAULT_KEYBINDINGS };
	const ignored: IgnoredEntry[] = [];
	const conflicts: ConflictEntry[] = [];

	let raw: unknown;
	try {
		const text = await readFile(path, "utf8");
		try {
			raw = JSON.parse(text);
		} catch {
			ignored.push({ reason: "parse-error" });
			return { bindings: bindings as Keybindings, ignored, conflicts };
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return { bindings: bindings as Keybindings, ignored, conflicts };
		}
		ignored.push({ reason: "read-error" });
		return { bindings: bindings as Keybindings, ignored, conflicts };
	}

	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		ignored.push({ reason: "parse-error" });
		return { bindings: bindings as Keybindings, ignored, conflicts };
	}

	for (const [action, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value !== "string") {
			ignored.push({ action, reason: "non-string" });
			continue;
		}
		if (!(action in DEFAULT_KEYBINDINGS)) {
			ignored.push({ action, reason: "unknown-action" });
			continue;
		}
		const norm = normalizeKey(value);
		if (norm === null) {
			ignored.push({ action, key: value, reason: "illegal-key" });
			continue;
		}
		const existing = reverseLookup(bindings, norm);
		if (existing !== undefined && existing !== (action as KeybindingAction)) {
			conflicts.push({ key: norm, overridden: existing, by: action as KeybindingAction });
		}
		bindings[action] = norm;
	}

	return { bindings: bindings as Keybindings, ignored, conflicts };
}
