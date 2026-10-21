/**
 * BI-23.2 —— TUI 挂载与事件流：把 BI-23.1 的对话驱动器挂上 BI-19/20 渲染器官。
 * BI-27.2 —— 流式渲染：content_delta 追加 #streamText 缓冲并按 80ms 节流
 *   出帧（时钟走注入 clock.now，缺省 Date.now）；StreamView 组件在状态行
 *   上方（rows-3）单行预览缓冲尾部（前缀 ▌、≤160 码元、超宽截断加 …），缓冲
 *   空不渲染；流收束（正常/取消/异常）清空缓冲并让 StreamView 退场，完整
 *   文本按既有逻辑 transcribe 进投影（落盘行为不变）。running 状态行追加
 *   已用秒数（turnStartedAt 起算，随每帧自然刷新）。
 * BI-27.3 —— 富文本转录：assistant 条目正文走 renderMarkdown（手写零依赖，
 *   标题/粗斜体/行内代码/围栏代码块/列表；latex/mermaid 围栏复用 BI-19.8 /
 *   BI-19.6 现成器官），视图层由 StyledTranscript 承载（与 TranscriptProjection
 *   并行消费同一份 L1 条目；plain 条目文本与 L3 逐字节一致，仅样式新增）。
 *   全部落格走 VirtualTerminal.write 的 Cell 样式面，无裸转义序列。
 * BI-27.4 —— 候选与命令菜单：mount/candidate-menu.ts 提供候选面端口
 *   （CandidatesProvider，缺省 builtinSlashCandidates，与 core
 *   SlashCommandSurfaceEntry 字段同构便于宿主接线）+ CandidateMenu 状态机；
 *   斜杠草稿自动开菜单（前缀/模糊过滤、↑↓ 移动、Tab/Enter 接受、Esc 关闭），
 *   菜单视图画状态行上方（永不触碰状态行/提示行）；非斜杠 Tab 经 provider
 *   前缀延伸补全（mount/repl.ts 路由）。命令真实分发归宿主装配（缝已留）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ADR（BI-27.5）：REPL 视口方案裁定 —— 维持 inline（正常屏幕）
 * - 裁定：REPL 继续以「正常屏幕 + 行内重绘窗」为视口架构。不启用 alt-screen
 *   （备用屏全屏 TUI），不引入 scroll region（滚动区域）混合方案。
 * - 理由：kimi Code CLI 基线（RULE-BI-07）为 inline 式 REPL，bi 遵循 shell
 *   基线——stdout 可直接被管道/重定向/日志采集消费；终端原生选择复制、
 *   搜索与滚动习惯零成本保留；进程崩溃不留备用屏残骸。
 * - 语义：转录窗（rows-2 尾窗）是 inline 视口上的差分重绘窗，不是终端
 *   scrollback 本身；窗内历史滚回由本卡滚轮偏移（scrollTranscript，SGR
 *   1000/1006 鼠标上报）承担，不依赖终端原生 scrollback。
 * - 代价（接受）：alt-screen 式全屏布局/原地进度条不在本架构内；重绘窗与
 *   终端原生 scrollback 内容在真实终端上并存（不视为缺陷，不加消除逻辑）。
 * - 复核条件：若未来需要全屏面板（多窗格/内嵌滚动列表编辑器），另立 ADR
 *   评审，不在本卡内渐进混入。
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 挂载面（kimi 装配序 tui 段；器官全量复用、不改动）：
 * - **双缓冲投影**：TranscriptProjection（BI-19.1 同构 L1→L3）承载会话视图，
 *   TuiApp/DiffRenderer（begin/end 差分帧）负责双缓冲提交；onFrame 钩子回吐
 *   每帧可见行集（注入渲染面断言点）。BI-27.3 起渲染面为 StyledTranscript
 *   （富文本），投影保留 L4 导出与同构不变式职责；resize 双侧同步重算
 *   （BI-27.5 折行宽跟随，滚动锚底语义不变）。
 * - **审批 ask 回路**：manual 模式下 PermissionGate 'ask' 决策 → 栈顶审批浮层
 *   （y=允许 / n=拒绝 / Esc=拒绝），回答经 Promise 回喂装配执行体；deny 以
 *   结构化 permission-denied 回喂模型（与无头降级同一回喂语义，不再假冒）。
 * - **Esc 二段取消**：turn 进行中第一段 Esc → AgentLoop.cancelRequest() 等
 *   在飞工具落定转 paused（thinking→paused，BI-07 迁移表），驱动器同步 abort
 *   模型流并优雅收束本回合；cancelWindowMs 窗口内第二段 → exit 终态。paused
 *   会话的下次 submit() 经 resume()（paused→thinking）续转。idle 态 Esc 不消费。
 * - 输入面：本卡以 submit() 挂事件流；行编辑器 REPL 接线（editor 器官挂载）
 *   归后续装配卡。钩子 runner 暂为无头路径专属（挂载卡交付面=投影/审批/取消）。
 */

import {
	AgentLoop,
	type ToolCall,
	type ToolExecutor,
	type ToolResult,
} from "../../../core/src/agent";
import { ToolCallAssembler, type ModelPort, type ToolBinding } from "../../../core/src/cli/headless";
import { PermissionGate } from "../../../core/src/guard/permission-gate";
import type { Clock } from "../../../core/src/guard/deadline";
import { ToolTimeoutPolicy } from "../../../core/src/guard/timeout-policy";
import { DEFAULT_IDENTITY_NAME, type IdentitySection } from "../../../core/src/config/schema";
import type { PermissionRequest, PermissionMode } from "../../../core/src/guard/types";
import { SessionManager } from "../../../core/src/session/manager";
import { type BtwService, type BtwAnswer } from "../../../core/src/subagent/btw-service";
import type { AppendEntryInput, JsonValue } from "../../../core/src/session/types";
import {
	type AgentMessage,
	type ContentBlock,
	type StopReason,
	type TextBlock,
	type ToolResultBlock,
	type ToolUseBlock,
} from "../../../core/src/adapters/deepseek-adapter";

import { TuiApp, type Component } from "../components/tui-app";
import type { ParsedKey, Writer } from "../engine/diff-renderer";
import { VirtualTerminal } from "../engine/virtual-terminal";
import { charWidth, textWidth } from "../components/cjk-width";
import { TranscriptProjection, type TranscriptKind } from "../transcript-projection";
import { StyledTranscript } from "../transcript-styled";
import type { MarkdownRow } from "../render/markdown";
import { builtinSlashCandidates, CandidateMenu, COMMAND_CATALOG, type CandidatesProvider } from "./candidate-menu";
import { TranscriptSearch } from "./transcript-search";
import { DEFAULT_KEYBINDINGS, actionForKey, type KeybindingAction, type Keybindings } from "./keybindings";
import { TokenHudTracker } from "./token-hud";
import {
	dispatchGateCommand,
	isGateCommandLine,
	type GateCommandOverrides,
	type GateDispatchResult,
} from "./gate-commands";
import { DEFAULT_WORK_MODE, dispatchModeCommand, isModeCommandLine } from "./mode-command";
import { DiffReviewOverlay } from "./diff-review";
import type { DiffGateSummary } from "../diff-view";
import { renderModeIndicator } from "../components/mode-indicator";
import { ModeSelector, type ModeId } from "../../../core/src/modes/mode-selector";
import type { CommandContext } from "../../../core/src/commands/compact";

/** SGR 鼠标上报开关序列（BI-27.5 滚轮历史）：1000=按键上报，1006=SGR 编码。 */
export const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
export const MOUSE_DISABLE = "\x1b[?1006l\x1b[?1000l";

/**
 * 鼠标语义开关（FIX-B F6）：config [tui] mouse_mode 真接线——
 * 缺省 true = 启用 SGR 鼠标上报（BI-27.5 滚轮翻页）；false = 不启用。
 * 未声明（undefined）按 schema 缺省 true 处理。
 */
export function mouseModeEnabled(mouseMode: boolean | undefined): boolean {
	return mouseMode !== false;
}

/**
 * 鼠标语义开关的转义序列面（FIX-B F6）：启用态给出「开 + 还原」两序列；
 * 关闭态两序列皆空串（宿主据此不写任何鼠标转义——不启用即不还原）。
 */
export function mouseModeSequences(mouseMode: boolean | undefined): {
	readonly enable: string;
	readonly disable: string;
} {
	return mouseModeEnabled(mouseMode)
		? { enable: MOUSE_ENABLE, disable: MOUSE_DISABLE }
		: { enable: "", disable: "" };
}

/** 滚轮单格滚动行数（BI-27.5 滚轮历史；一格 = 三行，readline/分页器惯例）。 */
export const WHEEL_SCROLL_LINES = 3;

/** 流式帧节流窗口（毫秒，BI-27.2）：窗口内的 delta 合并到下一次出帧。 */
const STREAM_FRAME_THROTTLE_MS = 80;

/** 流式预览尾部字符上限（UTF-16 码元；超出取尾，再按终端列宽二次截断）。 */
const STREAM_PREVIEW_CHARS = 160;

/** 流式预览行前缀。 */
const STREAM_PREFIX = "▌";

/**
 * 流式预览单行（BI-27.2）：缓冲尾部 ≤160 码元、换行摊平为 ⏎（单行组件，
 * 防裸换行在网格写入时顶走下方状态行）、按显示列宽截断（CJK 宽字符计 2 列，
 * 装不下时以 … 收尾）。缓冲为空返回空串（调用方据此跳过渲染与帧行）。
 * render 与 #frame 帧探针共用的单一来源。
 */
function streamPreviewLine(buffer: string, cols: number): string {
	if (buffer.length === 0) return "";
	const tail = buffer.length > STREAM_PREVIEW_CHARS ? buffer.slice(-STREAM_PREVIEW_CHARS) : buffer;
	const flat = tail.replace(/\r\n?|\n/g, "⏎");
	const budget = Math.max(0, cols - textWidth(STREAM_PREFIX) - 1); // 预留 … 一格
	let out = "";
	let used = 0;
	for (const ch of flat) {
		const w = charWidth(ch);
		if (used + w > budget) {
			out += "…";
			break;
		}
		out += ch;
		used += w;
	}
	return `${STREAM_PREFIX}${out}`;
}

/** TUI 会话级错误（结构化面，调用方据此上报）。 */
export class TuiSessionError extends Error {
	readonly code: "adapter-error" | "rounds-exceeded" | "not-started" | "session-exited";
	constructor(code: TuiSessionError["code"], message: string) {
		super(message);
		this.name = "TuiSessionError";
		this.code = code;
	}
}

/** 渲染面探针：每帧提交后回吐（验收断言点）。 */
export interface TuiSessionHooks {
	/** 每次双缓冲帧提交后的可见行集（投影 L3 尾窗 + 状态行）。 */
	readonly onFrame?: (frame: readonly string[], info: FrameInfo) => void;
}

export interface FrameInfo {
	/** 审批浮层是否在栈顶可见。 */
	readonly approvalVisible: boolean;
	/** 驱动器状态。 */
	readonly state: TuiSessionState;
}

/**
 * 驱动器状态。
 * - idle：编辑态（提示行可编辑）；running：模型回合在飞；
 * - awaiting-approval：权限审批浮层在栈顶（按键派给浮层）；
 * - awaiting-confirm：diff 审查门确认浮层在栈顶（FIX-B F5；按键派给浮层）；
 * - exited：会话终场。
 */
export type TuiSessionState =
	| "idle"
	| "running"
	| "awaiting-approval"
	| "awaiting-confirm"
	| "exited";

export interface TuiSessionOptions {
	readonly model: ModelPort;
	readonly tools: readonly ToolBinding[];
	readonly cwd: string;
	readonly sessionsRoot?: string;
	/** 权限门初始模式；TUI 挂载的 ask 回路只有 manual 模式可达。 */
	readonly permissionMode?: "manual" | "auto" | "yolo";
	/** 会话回合上限（缺省 16，与 CLI/headless 缺省对齐）。 */
	readonly maxRounds?: number;
	/**
	 * 单回合工具调用上限（对应 config [loop_control] max_tool_calls_per_turn）。
	 * 超限调用不执行，回填结构化拒绝；缺省 / ≤0 = 不限。
	 */
	readonly maxToolCallsPerTurn?: number;
	/**
	 * 工具限时看门狗缺省时限（对应 config [loop_control] step_timeout_ms）。
	 * >0 且未显式提供 timeoutPolicy 时装配缺省 ToolTimeoutPolicy；0 = 关闭看门狗。
	 */
	readonly stepTimeoutMs?: number;
	/** 工具限时看门狗显式注入面（优先于 stepTimeoutMs 自建）。 */
	readonly timeoutPolicy?: ToolTimeoutPolicy;
	/**
	 * [identity] 分区（config identity.*）：横幅产品名（name）与副题行（tagline）。
	 * 缺省不提供 = 横幅零变化（沿用现状单行提示）。
	 */
	readonly identity?: IdentitySection;
	/** Esc 二段取消窗口毫秒（透传 BI-07 AgentLoop；缺省 800）。 */
	readonly cancelWindowMs?: number;
	/** 渲染面尺寸（缺省 24x80）。 */
	readonly rows?: number;
	readonly cols?: number;
	/**
	 * 候选面（BI-27.4）：斜杠菜单与非斜杠 Tab 补全的候选源；缺省
	 * builtinSlashCandidates。宿主接线自定义命令：
	 * `(draft) => slashCommandSurface(discoverSlashCommands(dirs, fs).commands)`。
	 */
	readonly candidates?: CandidatesProvider;
	/**
	 * 注入门禁（BI-28.3 接线）：装配层与斜杠命令面共享同一 PermissionGate
	 * 实例时注入；缺省按 permissionMode 自建（manual）。
	 */
	readonly gate?: PermissionGate;
	/**
	 * 斜杠命令拦截（BI-28.3 接线；BI-30.1 执行面）：注入后,`/` 开头的提交改走
	 * 命令面，返回两形态：
	 * - `string` = 本地回执（/permissions 回执、未知命令应答、自定义命令展开
	 *   失败的错误文本）——不入模型回合、不落会话 JSONL,输出以 system 行转录
	 *   上屏,endedAs=finish；
	 * - `{ prompt: string }` = 展开后的用户提示词（自定义斜杠命令执行面）——
	 *   按普通提交进模型回合：JSONL 记 user/assistant 条目、转录 [user] /
	 *   [assistant] 行（不出 system 本地行）,回合自然收尾 endedAs=finish。
	 * 缺省不拦截（/ 开头照常进模型）。
	 */
	readonly slashCommand?: (line: string) => Promise<string | { prompt: string }>;
	readonly clock?: Clock;
	readonly hooks?: TuiSessionHooks;
	/** 帧字节输出面（缺省 no-op；真实终端注入 WriteStream，BI-24.2 REPL 挂载用）。 */
	readonly writer?: Writer;
	/** 键位注册表（TUI-ALIGN-4a；缺省 DEFAULT_KEYBINDINGS）。 */
	readonly keybindings?: Keybindings;
	/**
	 * /btw 旁路问答服务（BI-07.6）：注入后 REPL 内 `/btw <问题>` 走旁路子会话回答，
	 * 主对话循环不被打断、主会话历史不被污染；未注入则 `/btw` 回本地结构化提示
	 * （绝不假冒回答）。host 运行环（bin/bi.ts）按 config [subagent] btw_enabled
	 * 实例化并注入；本卡仅消费此装配面。
	 */
	readonly btwService?: BtwService;
	/**
	 * 上下文窗口上限（BI-11 接线：TokenHud 分母；缺省 128000）。
	 * 宿主按模型 context_limit 注入；HUD 百分比与 k 缩写由 TokenHud 契约承担。
	 */
	readonly contextTokens?: number;
	/**
	 * 手动门三命令执行体替身注入（BI-11 接线）：逐项覆盖 /compact /rewind /
	 * /clear 的执行体；缺省项走会话内建执行体（上下文摘要紧缩 / 回退最近 N 轮
	 * 用户输入 / 清空上下文与转录）。返回 Promise 的执行体由会话等待落定。
	 */
	readonly gateCommands?: GateCommandOverrides;
	/**
	 * 工作模式初值（BI-20.1 接线）：四态 plan/edit/build/yolo；缺省 build
	 * （plan 为只读态，会拦写——不作为缺省，避免开箱即拒写）。
	 */
	readonly workMode?: ModeId;
}

export interface TuiSessionResult {
	readonly sessionId: string;
	readonly finalText: string;
	readonly rounds: number;
	readonly toolResults: readonly ToolResult[];
	readonly permissionDecisions: ReadonlyArray<{ tool: string; decision: string }>;
	/** finish=自然收尾；cancelled=Esc 一段暂停收束；exit=Esc 二段退出。 */
	readonly endedAs: "finish" | "cancelled" | "exit";
}

/** 浮层行集契约（帧探针与网格渲染共用的单一来源）。 */
interface OverlayLines {
	lines(): readonly string[];
}

/** 审批浮层：y=允许 / n=拒绝 / Esc=拒绝；栈顶拦截按键直至回答。 */
class ApprovalOverlay implements Component {
	#resolve: ((answer: "allow" | "deny") => void) | undefined;

	constructor(
		private readonly toolName: string,
		private readonly argSummary: string,
		private readonly onChange: () => void,
		private readonly bindings: Keybindings,
	) {}

	get active(): boolean {
		return this.#resolve !== undefined;
	}

	/** 等待用户回答（handleKey 解析后 resolve）。 */
	wait(): Promise<"allow" | "deny"> {
		return new Promise((resolve) => {
			this.#resolve = resolve;
		});
	}

	/** 浮层行集（render 与帧探针共用的单一来源）。 */
	lines(): string[] {
		return [
			"┌─ 权限审批 ─────────────────────────────┐",
			`│ 工具: ${this.toolName} ${this.argSummary}`,
			"│ [y] 允许   [n] 拒绝   [Esc] 拒绝",
			"└────────────────────────────────────────┘",
		];
	}

	render(term: VirtualTerminal): void {
		this.lines().forEach((line, i) => term.write(0, i, line));
	}

	handleKey(key: ParsedKey): void {
		const action = actionForKey(this.bindings, key);
		let answer: "allow" | "deny" | undefined;
		if (action === "approval.allow") answer = "allow";
		else if (action === "approval.deny") answer = "deny";
		else if (key.kind === "esc") answer = "deny"; // 结构性取消键，保留硬编码兜底
		if (answer !== undefined) {
			const resolve = this.#resolve;
			this.#resolve = undefined;
			this.onChange();
			resolve?.(answer);
		}
	}
}

/** 会话视图组件：富文本视图行（BI-27.3 StyledTranscript）+ 状态行；不消费按键
 * （放行浮层）。布局（BI-24.3 修复同格叠写）：状态条独占倒数第二行，最底行
 * 让给 REPL 提示行——此前状态行与 PromptView 同写最底行，"❯ "仅 2 格宽盖掉
 * "[manual]"前两格，真机呈现 `❯ anual] 就绪` 乱码。滚动偏移（BI-27.5）下
 * 窗口行数可少于 viewRows，按区域底部锚定绘制（状态行下方不留悬空）。 */
class TranscriptView implements Component {
	constructor(private readonly session: AgentTuiSession) {}

	render(term: VirtualTerminal): void {
		const rows = this.session.visibleTranscriptRows();
		const viewRows = Math.max(1, this.session.rows - 2);
		const startY = Math.max(0, viewRows - rows.length);
		for (let i = 0; i < rows.length; i++) {
			let x = 0;
			for (const span of rows[i]!.spans) {
				term.write(x, startY + i, span.text, span.style);
				x += textWidth(span.text);
			}
		}
		term.write(0, this.session.rows - 2, this.session.statusText());
	}

	wantsKey(_key: ParsedKey): boolean {
		return false;
	}
}

/** 流式预览组件（BI-27.2）：状态行上方（rows-3）单行预览流缓冲尾部；
 * 缓冲空不渲染（让位转录尾窗）；不消费按键（放行浮层与 REPL 路由）。 */
class StreamView implements Component {
	constructor(private readonly session: AgentTuiSession) {}

	render(term: VirtualTerminal): void {
		const line = streamPreviewLine(this.session.streamBuffer, this.session.cols);
		if (line !== "") term.write(0, this.session.rows - 3, line);
	}

	wantsKey(_key: ParsedKey): boolean {
		return false;
	}
}

/**
 * 候选菜单视图组件（BI-27.4）：菜单可见时把菜单行画在状态行上方区域
 * （最底行菜单行 = rows-3，向上生长），覆盖转录尾窗底部（瞬态覆盖，菜单
 * 关闭后由转录差分重绘还原）。永不触碰状态行（rows-2）与提示行（rows-1）
 * ——BI-24.3 布局合约。按键不在此消费（runRepl 主回路显式路由 up/down/
 * Tab/Enter/Esc，字符键照常进编辑器）。
 */
class CandidateMenuView implements Component {
	constructor(private readonly session: AgentTuiSession) {}

	render(term: VirtualTerminal): void {
		const menu = this.session.candidateMenu;
		if (!menu.visible) return;
		const lines = menu.lines(this.session.cols);
		// 自底向上画：菜单最后一行贴 rows-3（状态行正上方），行数增长向上伸展。
		const bottomY = this.session.rows - 3;
		for (let i = 0; i < lines.length; i++) {
			const y = bottomY - (lines.length - 1 - i);
			if (y < 0) break; // 窗口过小：放不下的行丢弃（网格安全）
			term.write(0, y, lines[i]!);
		}
	}

	wantsKey(_key: ParsedKey): boolean {
		return false;
	}
}

/**
 * 转录内搜索条（BI-19.1-search）：搜索激活态下画在转录状态行（rows-2）正上方
 * （rows-3，与流式预览/候选菜单同位但栈顶覆盖）。仅回显查询与命中计数
 * `n/N`；命中高亮与滚回由 AgentTuiSession 消费 TranscriptSearch 状态实现。
 * 不消费按键（搜索态按键由 AgentTuiSession.handleKey 显式路由）。
 */
class SearchBarView implements Component {
	constructor(
		private readonly session: AgentTuiSession,
		private readonly search: TranscriptSearch,
	) {}

	render(term: VirtualTerminal): void {
		if (!this.search.active) return; // 非激活态不落格（不触碰状态行/转录）
		const y = Math.max(0, this.session.rows - 3);
		const query = this.search.query;
		const count = this.search.matchCount;
		const idx = this.search.currentIndex;
		const status = query === "" ? "" : count === 0 ? "  无匹配" : `  ${idx + 1}/${count}`;
		term.write(0, y, `find: ${query}${status}`);
	}

	wantsKey(_key: ParsedKey): boolean {
		return false;
	}
}

/** TUI 挂载会话：submit() 驱动的交互式对话流（投影渲染 + 审批回路 + Esc 二段取消）。 */
export class AgentTuiSession {
	readonly projection: TranscriptProjection;
	readonly app: TuiApp;
	readonly #model: ModelPort;
	#rows: number;
	#cols: number;
	readonly #hooks: TuiSessionHooks;
	readonly #gate: PermissionGate;
	readonly #registry = new Map<string, ToolBinding>();
	readonly #agentLoop: AgentLoop;
	readonly #manager: SessionManager;
	readonly #toolResults: ToolResult[] = [];
	readonly #permissionDecisions: Array<{ tool: string; decision: string }> = [];
	readonly #maxRounds: number;
	/** [identity] 分区（config identity.*）：横幅产品名与副题行；缺省 undefined = 横幅零变化。 */
	readonly #identity: IdentitySection | undefined;
	#sessionId: string | undefined;
	#messages: AgentMessage[] = [];
	#turnController: AbortController | undefined;
	#turnCancelled = false;
	#exitRequested = false;
	/** 经 /exit·/quit 命令退出的标记（与 Esc 二段退出的 state=exited 区分；诊断面）。 */
	#exitedViaCommand = false;
	#state: TuiSessionState = "idle";
	#rounds = 0;
	#activeOverlay: OverlayLines | undefined;
	/** BI-27.3：富文本转录视图（与 projection 并行消费同一份 L1 条目）。 */
	readonly #styled: StyledTranscript;
	/** BI-27.5：转录窗滚回偏移（0 = 实时锚底；向上为正，按可见窗高钳制）。 */
	#scrollOffset = 0;
	/** BI-27.4：候选菜单（斜杠草稿开合/过滤/选择；repl 主回路驱动）。 */
	readonly candidateMenu: CandidateMenu;
	/** BI-27.2：流式预览缓冲（content_delta 追加；流收束清空，文本改走 transcribe）。 */
	#streamText = "";
	/** BI-19.1-search：转录内搜索控制器（纯状态机）。 */
	readonly #search = new TranscriptSearch();
	/** BI-19.1-search：搜索激活前保存的滚回偏移，关闭时复原转录视图。 */
	#searchSavedScroll = 0;
	/** BI-27.2：上次流式出帧时刻（-∞ 保证首个 delta 立即出帧）。 */
	#lastStreamFrameAt = Number.NEGATIVE_INFINITY;
	/** BI-27.2：本回合起始时刻（状态行秒数源；回合收束清位）。 */
	#turnStartedAt: number | undefined;
	/** BI-27.2：注入时钟（节流与秒数共用；缺省 Date.now）。 */
	readonly #clock: Clock | undefined;
	/** 斜杠命令拦截（BI-28.3 接线 / BI-30.1 执行面；缺省 undefined = 不拦截）。 */
	readonly #slashCommand: ((line: string) => Promise<string | { prompt: string }>) | undefined;
	/** /btw 旁路问答服务（BI-07.6；缺省 undefined = 未装配，/btw 回结构化提示）。 */
	readonly #btwService: BtwService | undefined;
	/** 键位注册表（TUI-ALIGN-4a；缺省 DEFAULT_KEYBINDINGS）。 */
	readonly #bindings: Keybindings;
	/** BI-11 接线：TokenHud 读数跟踪（适配器 usage 事件 → 状态行 HUD 段）。 */
	readonly #hud: TokenHudTracker;
	/** BI-11 接线：三命令执行体替身（缺省项走内建执行体）。 */
	readonly #gateOverrides: GateCommandOverrides | undefined;
	/** BI-11 接线：本次三命令分发的回执文本（执行体写入；缺省走兜底文案）。 */
	#gateReport: string | undefined;
	/** BI-11 接线：本次三命令分发的异步执行体（分发后等待落定）。 */
	#gateWork: Promise<void> | undefined;
	/** BI-11 接线：会话根条目是否已落盘（/clear 后不再建第二个根）。 */
	#rootCreated = false;
	/** BI-20.1 接线：四态工作模式状态机（plan 只读 / edit / build / yolo）。 */
	readonly #modeSelector: ModeSelector;
	/** BI-20.1 接线：进入 plan 前权限面模式（离 plan 时复原）。 */
	#gateModeBeforePlan: PermissionMode | undefined;

	constructor(options: TuiSessionOptions) {
		this.#rows = options.rows ?? 24;
		this.#cols = options.cols ?? 80;
		this.#hooks = options.hooks ?? {};
		this.#maxRounds = options.maxRounds ?? 16;
		this.#identity = options.identity;
		this.#model = options.model;
		this.#clock = options.clock;
		this.projection = new TranscriptProjection({ width: this.#cols });
		// 帧字节面：真实终端经 options.writer 注入（BI-24.2）；缺省 no-op（测试注入 hooks.onFrame 断言行集）。
		const writer: Writer = options.writer ?? { write: () => undefined };
		this.app = new TuiApp(writer, this.#rows, this.#cols);
		this.app.push(new TranscriptView(this));
		this.app.push(new StreamView(this)); // BI-27.2：流式预览（缓冲空时不落格）
		this.app.push(new CandidateMenuView(this)); // BI-27.4：斜杠候选菜单（不可见时不落格）
		this.app.push(new SearchBarView(this, this.#search)); // BI-19.1-search：转录内搜索条（激活态落格）
		this.#styled = new StyledTranscript(this.#cols);
		this.candidateMenu = new CandidateMenu(options.candidates ?? (() => builtinSlashCandidates));
		this.#gate = options.gate ?? new PermissionGate({ mode: options.permissionMode ?? "manual" });
		this.#slashCommand = options.slashCommand;
		this.#btwService = options.btwService;
		this.#bindings = options.keybindings ?? DEFAULT_KEYBINDINGS;
		this.#hud = new TokenHudTracker(options.contextTokens);
		this.#gateOverrides = options.gateCommands;
		for (const binding of options.tools) this.#registry.set(binding.definition.name, binding);
		const readOnlyTools = new Set(options.tools.filter((t) => t.readOnly).map((t) => t.definition.name));
		// BI-20.1 接线：工作模式状态机。只读端口取工具注册表的 readOnly 标记
		//（与 AgentLoop 的只读排重集同源）；plan 态据此拦写。
		this.#modeSelector = new ModeSelector(
			{ isReadOnly: (tool: string, _args: string): boolean => this.#registry.get(tool)?.readOnly === true },
			options.workMode ?? DEFAULT_WORK_MODE,
		);
		// plan 态激活 → 权限面切 manual（只读期的写操作逐条问）；离 plan 复原。
		// 两套模式并存不合并：工作模式管只读语义，权限面管三态授权。
		this.#modeSelector.onChange(({ from, to }) => {
			if (to === "plan") {
				if (this.#gateModeBeforePlan === undefined) {
					this.#gateModeBeforePlan = this.#gate.mode;
				}
				this.#gate.setMode("manual");
				return;
			}
			if (from === "plan" && this.#gateModeBeforePlan !== undefined) {
				this.#gate.setMode(this.#gateModeBeforePlan);
				this.#gateModeBeforePlan = undefined;
			}
		});
		this.#manager = new SessionManager(options.sessionsRoot !== undefined ? { rootDir: options.sessionsRoot } : {});
		const executor: ToolExecutor = async (call: ToolCall, signal: AbortSignal): Promise<unknown> =>
			this.#execute(call, signal);
		this.#agentLoop = new AgentLoop({
			execute: executor,
			readOnlyTools,
			...(options.cancelWindowMs !== undefined ? { cancelWindowMs: options.cancelWindowMs } : {}),
			...(options.clock !== undefined ? { clock: options.clock } : {}),
			// [loop_control] max_tool_calls_per_turn：单回合工具调用上限（0/未提供 = 不限）。
			...(options.maxToolCallsPerTurn !== undefined && options.maxToolCallsPerTurn > 0
				? { maxToolCallsPerTurn: options.maxToolCallsPerTurn }
				: {}),
			// [loop_control] step_timeout_ms：工具限时看门狗缺省时限。显式注入优先；
			// 未注入且 >0 时自建缺省看门狗（未知工具按此上限）；0 = 关闭看门狗。
			...(options.timeoutPolicy !== undefined
				? { timeoutPolicy: options.timeoutPolicy }
				: options.stepTimeoutMs !== undefined && options.stepTimeoutMs > 0
					? { timeoutPolicy: new ToolTimeoutPolicy({ defaultTimeoutMs: options.stepTimeoutMs }) }
					: {}),
		});
	}

	/** 会话初始化（JSONL 落盘根条目）；submit 前必须调用。 */
	async start(title: string): Promise<string> {
		const session = await this.#manager.createSession({ title: title.slice(0, 80), cwd: "" });
		this.#sessionId = session.sessionId;
		return session.sessionId;
	}

	get sessionId(): string | undefined {
		return this.#sessionId;
	}

	get state(): TuiSessionState {
		return this.#state;
	}

	/** 转录搜索模态是否激活（D7/BI-19.1-search：供 repl.ts 转发路由按键）。 */
	get searchActive(): boolean {
		return this.#search.active;
	}

	/** 当前渲染行数（resize 可变；TranscriptView 布局单一来源）。 */
	get rows(): number {
		return this.#rows;
	}

	/** 当前渲染列数（resize 可变；StreamView 截断布局单一来源，BI-27.2）。 */
	get cols(): number {
		return this.#cols;
	}

	/** 流式预览缓冲（只读视图；StreamView 与帧探针消费，BI-27.2）。 */
	get streamBuffer(): string {
		return this.#streamText;
	}

	/** 时刻源（BI-27.2）：注入 clock.now 缺省 Date.now（节流与秒数共用）。 */
	#now(): number {
		return this.#clock !== undefined ? this.#clock.now() : Date.now();
	}

	/**
	 * 流式帧节流（BI-27.2）：80ms 窗口内的 content_delta 合并重绘；首 delta
	 * 立即出帧（lastStreamFrameAt 初始 -∞，submit 起点复位）。时钟注入面可控
	 * 推进（测试零真实延时）。
	 */
	#maybeStreamFrame(): void {
		const now = this.#now();
		if (now - this.#lastStreamFrameAt < STREAM_FRAME_THROTTLE_MS) return;
		this.#lastStreamFrameAt = now;
		this.#frame();
	}

	/** 当前工作模式（BI-20.1 接线；宿主/测试观察面）。 */
	get workMode(): ModeId {
		return this.#modeSelector.getMode();
	}

	/** AgentLoop 内态诊断面（thinking/paused/exit/...；测试与状态条用）。 */
	get agentState(): string {
		return this.#agentLoop.state;
	}

	statusText(): string {
		const mode = this.#gate.mode;
		const base = this.#statusBase(mode);
		// BI-20.1 接线：工作模式徽标置于状态行首位（工作模式在前、权限三态在后，
		// 两套模式并存不合并）；HUD 段挂尾部（无 usage 读数则整段缺席）。
		const withMode = `${renderModeIndicator(this.#modeSelector.getMode())} ${base}`;
		const hud = this.#hud.line;
		return hud === "" ? withMode : `${withMode} | ${hud}`;
	}

	/** 状态行主文案（各状态分支；HUD 段由 statusText 追加）。 */
	#statusBase(mode: string): string {
		switch (this.#state) {
			case "running": {
				// BI-27.2：运行态追加已用秒数（turnStartedAt 起算；随每帧自然刷新）。
				const started = this.#turnStartedAt;
				const secs = started === undefined ? undefined : Math.max(0, Math.floor((this.#now() - started) / 1000));
				return secs === undefined
					? `[${mode}] 运行中 — Esc 取消（双击退出）`
					: `[${mode}] 运行中 ${secs}s — Esc 取消（双击退出）`;
			}
			case "awaiting-approval":
				return `[${mode}] 等待审批 — y 允许 / n 拒绝`;
			case "awaiting-confirm":
				return `[${mode}] 等待审查确认 — y 批准 / n 拒绝`;
			case "exited":
				return "[已退出]";
			default:
				return `[${mode}] 就绪`;
		}
	}

	// ------------------------------------------------------------------
	// 渲染与键位
	// ------------------------------------------------------------------

	/** 转录窗可见行数上限（rows-2：状态行与提示行之外的全部网格行）。 */
	#viewRows(): number {
		return Math.max(1, this.#rows - 2);
	}

	/** 滚回偏移上限（视图行超出窗高的部分；不足一窗时为 0）。 */
	#maxScrollOffset(): number {
		return Math.max(0, this.#styled.rows().length - this.#viewRows());
	}

	/**
	 * 转录窗可见富文本行（BI-27.3 StyledTranscript + BI-27.5 滚回窗口）：
	 * styled 全量视图行按滚回偏移取尾窗（offset=0 实时锚底；offset>0 冻结
	 * 历史视图，新条目照常入投影但窗口不跟随）；越界偏移按当前窗高钳制。
	 * TranscriptView 渲染单一来源（网格面）；onFrame 帧探针仍走 projection
	 * L3 尾窗（投影探针语义，不随视图滚回偏移）。
	 */
	visibleTranscriptRows(): MarkdownRow[] {
		const all = this.#styled.rows();
		const viewRows = this.#viewRows();
		const offset = Math.min(this.#scrollOffset, this.#maxScrollOffset());
		const end = Math.max(0, all.length - offset);
		const start = Math.max(0, end - viewRows);
		return all.slice(start, end);
	}

	/** 当前滚回偏移（测试与诊断观察面）。 */
	get scrollOffset(): number {
		return this.#scrollOffset;
	}

	/**
	 * 转录窗滚回（BI-27.5 滚轮历史）：delta>0 向更旧（上滚）、delta<0 向更新
	 * （下滚）；0 为实时锚底下界、#maxScrollOffset 为顶界（不悬空）。偏移
	 * 变化即出帧。
	 */
	scrollTranscript(delta: number): void {
		const next = Math.max(0, Math.min(this.#scrollOffset + Math.trunc(delta), this.#maxScrollOffset()));
		if (next === this.#scrollOffset) return;
		this.#scrollOffset = next;
		this.#frame();
	}

	/**
	 * 转录全量源行（BI-19.1-search）：StyledTranscript 全部视图行拼为纯文本，
	 * 供搜索语料构建（ANSI 已无——视图行为样式分段文本，聚合即纯文本面）。
	 */
	#transcriptSourceLines(): string[] {
		return this.#styled.rows().map((row) => row.spans.map((span) => span.text).join(""));
	}

	/** BI-19.1-search：按当前命中把转录窗滚回，使命中点进入可见尾窗（无命中不滚）。 */
	#scrollToSearchMatch(): void {
		const match = this.#search.currentMatch;
		if (match === undefined) return;
		const total = this.#styled.rows().length;
		// 让命中行落在尾窗底部附近：offset = total - (row + 1)，按当前窗高钳制。
		const target = Math.max(0, total - (match.row + 1));
		this.#scrollOffset = Math.min(target, this.#maxScrollOffset());
	}

	/** BI-19.1-search：以新查询重算命中并复位到首个命中（增量缓存）。 */
	#setSearchQuery(query: string): void {
		this.#search.setQuery(this.#transcriptSourceLines(), query);
	}

	#frame(): void {
		this.app.render();
		const lines = this.projection.render();
		const viewRows = Math.max(1, this.#rows - 2);
		const overlay = this.#activeOverlay?.lines() ?? [];
		// BI-27.2：流式预览行插在转录尾窗与状态行之间（缓冲空 = 无行；
		// 备案边界——审批浮层同帧时网格上浮层覆盖 rows-3，帧数组仍含流式行）。
		const streamLine = streamPreviewLine(this.#streamText, this.#cols);
		const frame = [
			...overlay,
			...lines.slice(-(viewRows - overlay.length)),
			...(streamLine === "" ? [] : [streamLine]),
			this.statusText(),
		];
		this.#hooks.onFrame?.(frame, { approvalVisible: this.#state === "awaiting-approval", state: this.#state });
	}

	/**
	 * 终端尺寸变更（SIGWINCH 桥，BI-24.3）：双缓冲与转录窗同步重绘。
	 * BI-27.5：折叠行宽跟随——projection/styled 双侧按新宽度全量重算折行
	 * （L2 history 与宽度无关不重算，L3/L4 与 styled 视图行重排），滚动锚底
	 * 语义不变（BI-24.3 备案的「已渲染行不重排」就此消除：重排后仍锚底，
	 * 滚回偏移按新窗高钳制）。
	 */
	resize(rows: number, cols: number): void {
		if (rows === this.#rows && cols === this.#cols) return;
		this.#rows = rows;
		this.#cols = cols;
		this.projection.resize(cols);
		this.#styled.resize(cols);
		// 重排后行数变化：滚回偏移按新窗高钳制（顶部不悬空，锚底语义保持）。
		this.#scrollOffset = Math.min(this.#scrollOffset, this.#maxScrollOffset());
		this.app.resize(rows, cols);
		this.#frame();
	}

	#transcribe(kind: TranscriptKind, text: string): void {
		const entry = { kind, text };
		this.projection.append(entry);
		this.#styled.append(entry); // BI-27.3：富文本视图同步消费同一份 L1 条目
	}

	/**
	 * Esc 键位（宿主键派发调用点）：运行中=二段取消语义；审批浮层/Esc 由浮层
	 * 经 TuiApp.dispatchKey 自行消费；idle 不消费。
	 * BI-27.5：wheel-up/wheel-down（SGR 鼠标滚轮，InputLoop 解析）= 转录窗
	 * 滚回（全态可用——审批挂起/回合在飞时同样可翻历史）。
	 */
	async handleKey(key: ParsedKey): Promise<void> {
		// ── BI-19.1-search：转录内搜索（激活态优先拦截全部按键）──
		// 对齐 kimi tui.altScreen.search/searchNext/searchPrevious/searchClose 语义：
		// 激活态下 Enter=下一命中、Ctrl+G=上一命中、Esc=关闭清零并复原转录。
		if (this.#search.active) {
			const action = actionForKey(this.#bindings, key);
			if (action === "search.close") {
				this.#search.close();
				this.#scrollOffset = this.#searchSavedScroll; // 复原转录滚回偏移
			} else if (action === "search.next") {
				this.#search.next();
				this.#scrollToSearchMatch();
			} else if (action === "search.previous") {
				this.#search.prev();
				this.#scrollToSearchMatch();
			} else if (key.kind === "backspace") {
				this.#setSearchQuery(this.#search.query.slice(0, -1));
			} else if (key.kind === "char") {
				this.#setSearchQuery(this.#search.query + key.char);
			}
			// 其余按键（方向/分页/Tab/其它 Ctrl）在搜索态吞掉，避免误触转录/取消
			this.#frame();
			return;
		}
		// 激活搜索条：Ctrl+F（对齐 kimi tui.altScreen.search 语义；键位=search.open，经 repl 路由转发）
		if (actionForKey(this.#bindings, key) === "search.open") {
			this.#searchSavedScroll = this.#scrollOffset;
			this.#search.open();
			this.#frame();
			return;
		}
		if (key.kind === "wheel-up") {
			this.scrollTranscript(WHEEL_SCROLL_LINES);
			return;
		}
		if (key.kind === "wheel-down") {
			this.scrollTranscript(-WHEEL_SCROLL_LINES);
			return;
		}
		if (key.kind !== "esc" || this.#state !== "running") return;
		const outcome = await this.#agentLoop.cancelRequest();
		if (outcome.action === "exit") {
			this.#exitRequested = true;
			this.#turnController?.abort();
			this.#state = "exited";
		} else if (outcome.action === "paused") {
			// thinking→paused（BI-07）：abort 模型流，本回合经流 error 分支优雅收束。
			this.#turnCancelled = true;
			this.#turnController?.abort();
		} else if (outcome.action === "noop" && this.#agentLoop.state === "idle") {
			// 回合尚未 beginTurn（submit 仍在会话落盘窗口）：Esc 仍须兑现取消语义。
			this.#turnCancelled = true;
			this.#turnController?.abort();
		}
		this.#frame();
	}

	// ------------------------------------------------------------------
	// 对话驱动（与 headless 同一回合合约，交互面替换输出面）
	// ------------------------------------------------------------------

	/** 提交一条用户输入并跑完对话回合（resolve 于自然收尾/暂停收束；exit 抛错）。 */
	async submit(prompt: string): Promise<TuiSessionResult> {
		if (this.#sessionId === undefined) throw new TuiSessionError("not-started", "会话未初始化：先调用 start()");
		if (this.#state === "exited" || this.#agentLoop.state === "exit") {
			throw new TuiSessionError("session-exited", "会话已退出（Esc 二段），不可继续提交");
		}
		// /btw 旁路问答（BI-07.6）：先于模型循环与 #slashCommand 拦截——主循环零打断、
		// 主会话 JSONL 零追加（仅屏幕转录，#transcribe 不落盘），structured answer 上屏。
		if (prompt.startsWith("/btw")) {
			return await this.#handleBtw(prompt.slice("/btw".length).trim());
		}
		// BI-11 接线：手动门三命令（/compact /rewind /clear）在模型回合前分流——
		// 命令对象走 core 注册表（mount/gate-commands.ts），执行体经端口注入；
		// 本地回执上屏（不入模型回合、主会话 JSONL 零追加，同 /btw 语义）。
		if (isGateCommandLine(prompt)) {
			return await this.#handleGateCommand(prompt);
		}
		// BI-20.1 接线：四态工作模式命令（/mode）在模型回合前分流——本地回执
		// 上屏（不入模型回合、主会话 JSONL 零追加，同 /btw 与手动门语义）。
		if (isModeCommandLine(prompt)) {
			return await this.#handleModeCommand(prompt);
		}
		// F-ST-01：/help 本地回执（指令表 + 键位表，不入模型回合、不落 JSONL）。
		// F-ST-11：候选菜单接受补全会缀尾空格——一律以 trim 后的头比对，防 "/exit " 跌进兜底。
		const commandHead = prompt.trim();
		if (commandHead === "/help") {
			return await this.#handleHelp();
		}
		// F-ST-06 工单：/exit（/quit 别名）优雅退出 REPL（同 /mode 本地回执语义，置 exited 态）。
		if (commandHead === "/exit" || commandHead === "/quit") {
			return await this.#handleExit();
		}
		// 斜杠命令拦截（BI-28.3 接线 / BI-30.1 执行面）：/ 开头且装配层注入了
		// handler 时走命令面,返回两形态——
		// - string = 本地回执:不入模型回合、不落会话 JSONL,输出以 system 行
		//   转录上屏,endedAs=finish（非模型回合语义）;
		// - { prompt } = 展开后的用户提示词:改写本回合的用户输入,落到下方普通
		//   模型回合（user/assistant 双入 JSONL 与转录,自然收尾 endedAs=finish）。
		let turnPrompt = prompt;
		if (prompt.startsWith("/") && this.#slashCommand !== undefined) {
			const outcome = await this.#slashCommand(prompt);
			if (typeof outcome === "string") {
				this.#transcribe("system", outcome);
				this.#frame();
				return {
					sessionId: this.#sessionId,
					finalText: outcome,
					rounds: this.#rounds,
					toolResults: [...this.#toolResults],
					permissionDecisions: [...this.#permissionDecisions],
					endedAs: "finish",
				};
			}
			turnPrompt = outcome.prompt;
		}
		this.#turnCancelled = false;
		this.#exitRequested = false;
		this.#turnController = new AbortController();
		this.#state = "running";
		// BI-27.2：回合起点复位流式面（秒数源 + 节流基线 + 预览缓冲）。
		this.#turnStartedAt = this.#now();
		this.#lastStreamFrameAt = Number.NEGATIVE_INFINITY;
		this.#streamText = "";

		// 会话持久化：根条目（仅首个 submit 建立）与链式追加（{ prompt } 形态
		// 落展开后的用户提示词,BI-30.1）。
		// BI-11 接线：根条目只建一次——/clear 清空上下文后消息表为空，若按
		// 「消息表为空」判定会撞 SessionManager 的「同会话不允许第二个根」；
		// 故改用独立的根条目标志位，清面后提交一律挂链。
		if (!this.#rootCreated) {
			const rootEntry = await this.#manager.append(this.#sessionId, null, {
				type: "user",
				payload: { text: turnPrompt } as unknown as JsonValue,
			});
			this.#parentId = rootEntry.id;
			this.#rootCreated = true;
		} else {
			await this.#appendChained({ type: "user", payload: { text: turnPrompt } as unknown as JsonValue });
		}
		this.#messages = [...this.#messages, { role: "user", content: turnPrompt }];
		this.#transcribe("user", turnPrompt);
		this.#frame();

		try {
			while (this.#rounds < this.#maxRounds) {
				this.#rounds += 1;
				// 状态机契约：beginTurn 只走 idle→thinking；paused→thinking 走 resume()。
				if (this.#agentLoop.state === "idle") this.#agentLoop.beginTurn();
				else if (this.#agentLoop.state === "paused") this.#agentLoop.resume();
				let text = "";
				const blocks: ContentBlock[] = [];
				const assembler = new ToolCallAssembler();
				let stop: StopReason = null;
				for await (const event of this.#model.stream({
					messages: this.#messages,
					tools: [...this.#registry.values()].map((t) => t.definition),
					signal: this.#turnController.signal,
				})) {
					if (event.type === "content_delta") {
						text += event.delta;
						// BI-27.2：流式预览缓冲追加 + 节流出帧（80ms 合并，时钟注入）。
						this.#streamText += event.delta;
						this.#maybeStreamFrame();
					}
					else if (event.type === "tool_call_delta") assembler.push(event);
					else if (event.type === "usage") {
						// BI-11 接线：usage 读数喂 TokenHud（状态行 HUD 段随帧刷新）。
						this.#hud.update(event.usage);
						this.#frame();
					}
					else if (event.type === "done") stop = event.stopReason;
					else if (event.type === "error") {
						if (this.#turnCancelled || this.#exitRequested) break; // abort 的优雅收束
						throw new TuiSessionError("adapter-error", `${event.error.code}: ${event.error.message}`);
					}
				}
				// 流收束（BI-27.2）：清空预览缓冲并出帧让 StreamView 退场。文本按
				// 既有逻辑转写——finish/cancel 分支 transcribe 进投影，tool_use 回合
				// 维持既有不转写行为（落盘不变）。
				this.#streamText = "";
				this.#frame();
				// Esc 收束：cancelled=一段暂停（保留 paused 态待 resume）；exit=二段终态。
				if (this.#exitRequested || this.#turnCancelled) {
					const endedAs = this.#exitRequested ? "exit" : "cancelled";
					if (text !== "") {
						const partial: ContentBlock[] = [{ type: "text", text }];
						this.#messages.push({ role: "assistant", content: partial });
						this.#transcribe("assistant", text);
						await this.#appendChained({ type: "assistant", payload: { content: partial } as unknown as JsonValue });
					}
					return this.#result(endedAs, text);
				}
				if (stop === "stop" || stop === null) {
					if (text !== "") blocks.push({ type: "text", text } satisfies TextBlock);
					this.#messages.push({ role: "assistant", content: blocks });
					if (text !== "") this.#transcribe("assistant", text);
					await this.#appendChained({ type: "assistant", payload: { content: blocks } as unknown as JsonValue });
					this.#agentLoop.finishTurn();
					this.#state = "idle";
					this.#frame();
					return this.#result("finish", text);
				}
				if (stop !== "tool_use") {
					this.#agentLoop.finishTurn();
					throw new TuiSessionError("adapter-error", `不可继续的停止原因: ${String(stop)}`);
				}

				// tool_use 回合：assistant(含 tool_use 块) → 工具流水线 → tool_result 回填
				const calls = assembler.drain();
				const useBlocks: ToolUseBlock[] = calls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.args }));
				this.#messages.push({ role: "assistant", content: [...blocks, ...useBlocks] });
				await this.#appendChained({ type: "assistant", payload: { content: [...blocks, ...useBlocks] } as unknown as JsonValue });

				const results = await this.#agentLoop.executeTools(calls);
				this.#toolResults.push(...results);

				const resultBlocks: ToolResultBlock[] = [];
				for (const call of calls) {
					const result = results.find((r) => r.id === call.id);
					const summary =
						result === undefined
							? "lost-result"
							: result.ok
								? typeof result.value === "string"
									? result.value
									: JSON.stringify(result.value)
								: `error: ${result.error ?? "unknown"}`;
					resultBlocks.push({
						type: "tool_result",
						toolUseId: call.id,
						content: summary,
						isError: result === undefined || !result.ok,
					});
					this.#transcribe("tool", `${call.name}(${truncate(call.args)} → ${summary === "" ? "空" : truncate(summary)})`);
					await this.#appendChained({ type: "tool_call", payload: { name: call.name, args: call.args } as unknown as JsonValue, toolCallId: call.id, toolName: call.name });
					await this.#appendChained({
						type: "tool_result",
						payload: (result === undefined ? { ok: false } : { ok: result.ok, ...(result.ok ? { value: result.value } : { error: result.error }) }) as unknown as JsonValue,
						toolCallId: call.id,
						toolName: call.name,
					});
				}
				this.#messages.push({ role: "user", content: resultBlocks });
				this.#frame();
			}
			throw new TuiSessionError("rounds-exceeded", `回合超上限 ${this.#maxRounds}`);
		} finally {
			// BI-27.2：流式面收束兜底（异常抛出路径在流循环外，预览清空 + 秒数源清位）。
			this.#streamText = "";
			this.#turnStartedAt = undefined;
			this.#state = String(this.#agentLoop.state) === "exit" ? "exited" : "idle";
			this.#frame();
		}
	}

	#parentId: string | undefined;

	/**
	 * diff 审查门交互确认面（FIX-B F5）：挂审查浮层（y=批准 / n·Esc=拒绝），
	 * 等待用户裁决后收场。返回 true=批准、false=拒绝。
	 *
	 * 会话态置 awaiting-confirm——REPL 据此把按键派给组件栈顶（与审批浮层同路，
	 * 浮层消费 y/n/Esc，其余键落空）。裁决后复原原会话态并出帧（浮层撤场，
	 * 转录面复原）；斜杠命令路径不进模型回合，原态恒为 idle。
	 *
	 * 诚实边界：浮层只展示当前屏高内的 diff 头部（超出行数显式标注省略），
	 * 完整 diff 在裁决后随命令回执上屏转录。
	 */
	async confirmReview(view: readonly string[], summary: DiffGateSummary): Promise<boolean> {
		const overlay = new DiffReviewOverlay(
			view,
			summary,
			() => this.#frame(),
			this.#bindings,
			Math.max(3, this.#rows - 2),
		);
		const previous = this.#state;
		this.app.push(overlay);
		this.#activeOverlay = overlay;
		this.#state = "awaiting-confirm";
		this.#frame();
		try {
			const verdict = await overlay.wait();
			return verdict === "approve";
		} finally {
			const popped = this.app.pop();
			if (popped !== undefined && popped !== overlay) this.app.push(popped);
			this.#activeOverlay = undefined;
			this.#state = previous;
			this.#frame();
		}
	}

	#result(endedAs: TuiSessionResult["endedAs"], finalText: string): TuiSessionResult {
		return {
			sessionId: this.#sessionId!,
			finalText,
			rounds: this.#rounds,
			toolResults: this.#toolResults,
			permissionDecisions: this.#permissionDecisions,
			endedAs,
		};
	}

	/**
	 * /btw 旁路问答（BI-07.6）：主循环零打断、主会话历史零污染。
	 * - 已注入 BtwService：经旁路子会话取回答，结构化上屏（屏幕转录，不落主会话 JSONL）。
	 * - 未装配：结构化本地提示，绝不假冒回答（诚实边界）。
	 */
	async #handleBtw(question: string): Promise<TuiSessionResult> {
		if (this.#sessionId === undefined) {
			throw new TuiSessionError("not-started", "会话未初始化：先调用 start()");
		}
		if (this.#btwService === undefined) {
			this.#transcribe("system", "[btw] 旁路问答未装配（config [subagent] btw_enabled=false 或运行环未注入 BtwService）。");
			this.#frame();
			return this.#result("finish", "");
		}
		const answer = await this.#btwService.ask(question, { sessionId: this.#sessionId });
		this.#transcribe("system", formatBtwAnswer(answer));
		this.#frame();
		return this.#result("finish", answer.answer);
	}

	async #appendChained(input: AppendEntryInput): Promise<void> {
		const entry = await this.#manager.append(this.#sessionId!, this.#parentId ?? null, input);
		this.#parentId = entry.id;
	}

	// ------------------------------------------------------------------
	// BI-11 接线：手动门三命令（/compact /rewind /clear）
	// ------------------------------------------------------------------

	/**
	 * 三命令分发（BI-11 接线）：命令对象走 core 注册表（mount/gate-commands.ts
	 * → core/commands/compact.ts），执行体经 CommandContext 端口注入。
	 * - 参数非法 → 结构化错误文本本地回执上屏（不入模型回合）；
	 * - 执行体可异步（端口返回 Promise）——分发后等待落定再回执；
	 * - 回执以 system 行上屏（主会话 JSONL 零追加，同 /btw 语义）。
	 */
	async #handleGateCommand(line: string): Promise<TuiSessionResult> {
		if (this.#sessionId === undefined) {
			throw new TuiSessionError("not-started", "会话未初始化：先调用 start()");
		}
		this.#gateReport = undefined;
		this.#gateWork = undefined;
		let outcome: GateDispatchResult;
		try {
			outcome = dispatchGateCommand(line, this.#gateContext());
		} catch (error) {
			// 执行体抛错 → 结构化本地回执（不炸会话、不入模型回合）。
			const detail = error instanceof Error ? error.message : String(error);
			const message = `命令执行失败: ${detail}`;
			this.#transcribe("system", message);
			this.#frame();
			return this.#result("finish", message);
		}
		if (!outcome.ok) {
			this.#transcribe("system", outcome.error.message);
			this.#frame();
			return this.#result("finish", outcome.error.message);
		}
		if (this.#gateWork !== undefined) {
			try {
				await this.#gateWork;
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				this.#gateReport = `[${outcome.command}] 执行失败: ${detail}`;
			}
		}
		const report = this.#gateReport ?? `[${outcome.command}] 已执行`;
		this.#transcribe("system", report);
		this.#frame();
		return this.#result("finish", report);
	}

	/**
	 * /mode 分发（BI-20.1 接线）：状态机走 core 器官（mount/mode-command.ts →
	 * core/modes/mode-selector.ts）；plan 态的权限面联动（切 manual）与只读
	 * 拦截在器官事件回调与工具执行面生效（见构造器与 #execute）。
	 * 回执以 system 行上屏（主会话 JSONL 零追加，同 /btw 与手动门语义）。
	 */
	async #handleModeCommand(line: string): Promise<TuiSessionResult> {
		if (this.#sessionId === undefined) {
			throw new TuiSessionError("not-started", "会话未初始化：先调用 start()");
		}
		const outcome = dispatchModeCommand(line, this.#modeSelector);
		if (!outcome.ok) {
			this.#transcribe("system", outcome.error.message);
			this.#frame();
			return this.#result("finish", outcome.error.message);
		}
		this.#transcribe("system", outcome.text);
		this.#frame();
		return this.#result("finish", outcome.text);
	}

	/**
	 * /help（F-ST-01）：本地回执——列指令表（COMMAND_CATALOG 单一事实源）
	 * + 键位表（对齐当前键位注册表；Esc 取消/二段退出为硬编码语义）。
	 * 不入模型回合、不落会话 JSONL（同 /mode 语义），以 system 行转录上屏。
	 */
	async #handleHelp(): Promise<TuiSessionResult> {
		if (this.#sessionId === undefined) {
			throw new TuiSessionError("not-started", "会话未初始化：先调用 start()");
		}
		const rows: string[] = ["── 指令 ───────────────────────────────"];
		for (const c of COMMAND_CATALOG) {
			rows.push(`${c.usage.padEnd(22)} ${c.description}`);
		}
		rows.push("── 键位 ───────────────────────────────");
		rows.push(`${this.#keyLabel("editor.clear-or-exit", "ctrl+c")}  空稿退出 / 非空清空草稿`);
		rows.push(`${this.#keyLabel("editor.exit", "ctrl+d")}  退出 REPL（弃稿）`);
		rows.push("Esc               回合中取消 / 二段退出");
		rows.push(`${this.#keyLabel("search.open", "ctrl+f")}  转录内搜索`);
		rows.push(`${this.#keyLabel("editor.external-edit", "ctrl+e")}  外部编辑器桥`);
		this.#transcribe("system", rows.join("\n"));
		this.#frame();
		return this.#result("finish", "");
	}

	/**
	 * /exit（/quit 别名，F-ST-06 工单）：优雅退出 REPL。
	 * - idle：置 exited 态（会话按当前持久化状态收束，不落额外条目）；
	 * - running（防御：当前 REPL 架构下 /exit 不可在回合中经编辑器提交，此处兜底）：
	 *   先置 exitRequested + abort 在飞回合，再置 exited 态；
	 * 回执 system 行上屏（同 /mode 语义），返回 endedAs=exit。REPL 主回路据
	 * 此终场（endedAs=command-exit → 进程 exit 0）。
	 */
	async #handleExit(): Promise<TuiSessionResult> {
		if (this.#sessionId === undefined) {
			throw new TuiSessionError("not-started", "会话未初始化：先调用 start()");
		}
		if (this.#state === "running") {
			this.#exitRequested = true;
			this.#turnController?.abort();
		}
		this.#exitedViaCommand = true;
		this.#state = "exited";
		this.#transcribe("system", "[exit] 已退出 REPL（会话按当前状态收束）");
		this.#frame();
		return this.#result("exit", "");
	}

	/** 键位注册表中的动作映射为展示标签（ctrl+c → Ctrl+C；缺省回退）。 */
	#keyLabel(action: KeybindingAction, fallback: string): string {
		const bound = this.#bindings[action] ?? fallback;
		const label = bound.startsWith("ctrl+") ? `Ctrl+${bound.slice("ctrl+".length).toUpperCase()}` : bound.toUpperCase();
		return label.length < 6 ? label.padEnd(6) : label;
	}

	/** 是否为 /exit·/quit 退出命令（REPL 主回路据此立即终场；trim 比对防菜单补全尾空格，F-ST-11）。 */
	isExitCommand(line: string): boolean {
		const head = line.trim();
		return head === "/exit" || head === "/quit";
	}

	/** 首屏操作提示（F-ST-01 工单）：REPL 启动首帧前调用一次，落 system 行。 */
	showBanner(): void {
		if (this.#sessionId === undefined) return;
		// [identity] 横幅身份行：config 声明时用 identity.name 替代产品名、tagline 作副题行；
		// 未声明（name = 缺省产品名且 tagline 空）→ 零变化（不额外落行）。
		const identityName = this.#identity?.name?.trim() ?? "";
		const identityTagline = this.#identity?.tagline?.trim() ?? "";
		if (identityName !== "" && identityName !== DEFAULT_IDENTITY_NAME) {
			this.#transcribe("system", identityName);
		}
		if (identityTagline !== "") {
			this.#transcribe("system", identityTagline);
		}
		this.#transcribe("system", "？ 指令与键位：输入 /help 查看 · 退出：Ctrl+D 或 /exit");
		this.#frame();
	}

	/**
	 * 三命令执行体端口（CommandContext）：宿主替身（options.gateCommands）优先，
	 * 缺省项走会话内建执行体。端口为 void 契约，异步执行体经 #gateWork 承接。
	 */
	#gateContext(): CommandContext {
		const overrides = this.#gateOverrides;
		return {
			compact: {
				compact: (prompt?: string) => {
					const work = overrides?.compact !== undefined ? overrides.compact(prompt) : this.#compactContext(prompt);
					this.#gateWork = Promise.resolve(work).then(() => undefined);
				},
			},
			rewind: {
				rewind: (steps: number) => {
					const work = overrides?.rewind !== undefined ? overrides.rewind(steps) : this.#rewindContext(steps);
					this.#gateWork = Promise.resolve(work).then(() => undefined);
				},
			},
			clear: {
				clear: () => {
					const work = overrides?.clear !== undefined ? overrides.clear() : this.#clearContext();
					this.#gateWork = Promise.resolve(work).then(() => undefined);
				},
			},
		};
	}

	/**
	 * /compact 内建执行体：把当前模型侧上下文摘要成一条 [compacted] 消息
	 * （摘要经模型调用生成，提示词可选附加关注点）。
	 * - 失败（模型报错/摘要为空）→ 上下文原样保留，回执如实报失败；
	 * - 成功后 JSONL 追加 compaction 条目（摘要落盘，供 BI-10.1 恢复指针检索）。
	 */
	async #compactContext(prompt?: string): Promise<void> {
		const before = this.#messages.length;
		if (before === 0) {
			this.#gateReport = "[compact] 无上下文可紧缩";
			return;
		}
		const focus = prompt !== undefined && prompt !== "" ? `关注点：${prompt}\n` : "";
		const instruction =
			`请把下面的对话压缩为要点摘要（保留事实、结论与未决事项，丢弃寒暄与重复）：\n${focus}\n` +
			this.#messages.map((message) => `[${message.role}] ${messageToText(message)}`).join("\n");
		let summary = "";
		try {
			for await (const event of this.#model.stream({
				messages: [{ role: "user", content: instruction }],
				tools: [],
			})) {
				if (event.type === "content_delta") summary += event.delta;
				else if (event.type === "error") throw new Error(`${event.error.code}: ${event.error.message}`);
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.#gateReport = `[compact] 紧缩失败（上下文未改动）：${detail}`;
			return;
		}
		const text = summary.trim();
		if (text === "") {
			this.#gateReport = "[compact] 摘要为空（上下文未改动）";
			return;
		}
		this.#messages = [{ role: "user", content: `[compacted] ${text}` }];
		await this.#appendChained({
			type: "compaction",
			payload: { summary: text, messagesBefore: before } as unknown as JsonValue,
		});
		this.#gateReport = `[compact] 上下文已紧缩：${before} 条消息 → 1 条摘要（${text.length} 字）`;
	}

	/**
	 * /rewind 内建执行体：回退最近 N 轮用户输入（轮次 = 一条文本 user 消息
	 * 及其后续消息；工具结果回填不算新一轮）。
	 * JSONL 追加链不截断（append-only 铁律）——回退只作用于模型侧上下文。
	 */
	async #rewindContext(steps: number): Promise<void> {
		const starts = this.#messages
			.map((message, index) => ({ message, index }))
			.filter(({ message }) => message.role === "user" && typeof message.content === "string")
			.map(({ index }) => index);
		const drop = Math.min(steps, starts.length);
		if (drop === 0) {
			this.#gateReport = "[rewind] 无可回退轮次";
			return;
		}
		const cut = starts[starts.length - drop]!;
		this.#messages = this.#messages.slice(0, cut);
		this.#gateReport = `[rewind] 已回退 ${drop} 轮（剩余 ${this.#messages.length} 条消息；JSONL 追加链不截断）`;
	}

	/**
	 * /clear 内建执行体：清空模型侧上下文与转录视图（滚回偏移归零）。
	 * JSONL 追加链不截断（append-only 铁律）；根条目不重建（会话仅一个根）。
	 */
	async #clearContext(): Promise<void> {
		this.#messages = [];
		this.projection.clear();
		this.#styled.clear();
		this.#scrollOffset = 0;
		this.#gateReport = "[clear] 会话上下文与转录已清空（JSONL 追加链保留）";
	}

	/** 装配执行体：权限门（manual ask → 审批浮层回路）→ 真实工具。 */
	async #execute(call: ToolCall, signal: AbortSignal): Promise<unknown> {
		const binding = this.#registry.get(call.name);
		if (binding === undefined) throw new Error(`unknown-tool: ${call.name}`);
		const argSummary = binding.argSummary?.(call.args) ?? String(JSON.stringify(call.args) ?? "undefined").slice(0, 200);
		// BI-20.1 接线：plan 态只读拦截（先于权限门——只读是工作模式语义，
		// 写操作在 plan 态直接结构化拒绝，不进权限裁决回路）。
		const modeCheck = this.#modeSelector.intercept(call.name, argSummary);
		if (!modeCheck.allowed) {
			this.#permissionDecisions.push({ tool: call.name, decision: "deny(plan-mode-readonly)" });
			throw new Error(`plan-mode-readonly: plan 态只读，拒绝工具 ${call.name}`);
		}
		const request = { tool: call.name, argSummary, mode: this.#gate.mode } satisfies PermissionRequest;
		const decision = this.#gate.check(request);
		this.#permissionDecisions.push({ tool: call.name, decision: decision.decision });
		if (decision.decision === "deny") {
			throw new Error(`permission-denied${decision.feedback !== undefined ? `: ${decision.feedback}` : ""}`);
		}
		if (decision.decision === "ask") {
			const overlay = new ApprovalOverlay(call.name, argSummary, () => this.#frame(), this.#bindings);
			this.app.push(overlay);
			this.#activeOverlay = overlay;
			this.#state = "awaiting-approval";
			this.#frame();
			const answer = await overlay.wait();
			this.app.pop();
			this.#activeOverlay = undefined;
			this.#state = "running";
			if (answer === "deny") throw new Error("permission-denied: 用户拒绝（TUI 审批回路）");
			this.#permissionDecisions.push({ tool: call.name, decision: "allow(approved)" });
		}
		if (this.#exitRequested) throw new Error("session-exited");
		return await binding.execute(call.args, signal);
	}
}

function truncate(value: unknown, max = 60): string {
	const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "undefined");
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 消息 → 摘要用纯文本（内容块逐块取代表文本；思考块只留标记）。 */
function messageToText(message: AgentMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.map((block) => {
			switch (block.type) {
				case "text":
					return block.text;
				case "thinking":
					return "(思考过程已省略)";
				case "tool_use":
					return `(调用工具 ${block.name}) ${JSON.stringify(block.input) ?? ""}`;
				case "tool_result":
					return `(工具结果) ${block.content}`;
			}
		})
		.join("\n");
}

/**
 * /btw 回答上屏格式化（BI-07.6）：结构化呈现回答 + 旁路元信息（工具调用次数、
 * 排队耗时、旁路会话 id、失败原因），与常规 assistant 转录区分可读。
 */
function formatBtwAnswer(answer: BtwAnswer): string {
	const head = `[btw] ${answer.ok ? "回答" : "未完成"}`;
	const meta =
		`工具调用 ${answer.toolCalls} 次 · 排队 ${answer.queuedMs}ms` +
		(answer.childSessionId !== undefined ? ` · 旁路会话 ${answer.childSessionId}` : "") +
		(answer.error !== undefined ? ` · 错误: ${answer.error}` : "");
	const body = answer.answer === "" ? "（无回答）" : answer.answer;
	return `${head}\n${body}\n${meta}`;
}
