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
import type { PermissionRequest } from "../../../core/src/guard/types";
import { SessionManager } from "../../../core/src/session/manager";
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
import { builtinSlashCandidates, CandidateMenu, type CandidatesProvider } from "./candidate-menu";
import { TranscriptSearch } from "./transcript-search";

/** SGR 鼠标上报开关序列（BI-27.5 滚轮历史）：1000=按键上报，1006=SGR 编码。 */
export const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
export const MOUSE_DISABLE = "\x1b[?1006l\x1b[?1000l";

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

export type TuiSessionState = "idle" | "running" | "awaiting-approval" | "exited";

export interface TuiSessionOptions {
	readonly model: ModelPort;
	readonly tools: readonly ToolBinding[];
	readonly cwd: string;
	readonly sessionsRoot?: string;
	/** 权限门初始模式；TUI 挂载的 ask 回路只有 manual 模式可达。 */
	readonly permissionMode?: "manual" | "auto" | "yolo";
	readonly maxRounds?: number;
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

/** 审批浮层：y=允许 / n=拒绝 / Esc=拒绝；栈顶拦截按键直至回答。 */
class ApprovalOverlay implements Component {
	#resolve: ((answer: "allow" | "deny") => void) | undefined;

	constructor(
		private readonly toolName: string,
		private readonly argSummary: string,
		private readonly onChange: () => void,
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
		let answer: "allow" | "deny" | undefined;
		if (key.kind === "char" && key.char === "y") answer = "allow";
		else if (key.kind === "char" && key.char === "n") answer = "deny";
		else if (key.kind === "esc") answer = "deny";
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
	#sessionId: string | undefined;
	#messages: AgentMessage[] = [];
	#turnController: AbortController | undefined;
	#turnCancelled = false;
	#exitRequested = false;
	#state: TuiSessionState = "idle";
	#rounds = 0;
	#activeOverlay: ApprovalOverlay | undefined;
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

	constructor(options: TuiSessionOptions) {
		this.#rows = options.rows ?? 24;
		this.#cols = options.cols ?? 80;
		this.#hooks = options.hooks ?? {};
		this.#maxRounds = options.maxRounds ?? 8;
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
		for (const binding of options.tools) this.#registry.set(binding.definition.name, binding);
		const readOnlyTools = new Set(options.tools.filter((t) => t.readOnly).map((t) => t.definition.name));
		this.#manager = new SessionManager(options.sessionsRoot !== undefined ? { rootDir: options.sessionsRoot } : {});
		const executor: ToolExecutor = async (call: ToolCall, signal: AbortSignal): Promise<unknown> =>
			this.#execute(call, signal);
		this.#agentLoop = new AgentLoop({
			execute: executor,
			readOnlyTools,
			...(options.cancelWindowMs !== undefined ? { cancelWindowMs: options.cancelWindowMs } : {}),
			...(options.clock !== undefined ? { clock: options.clock } : {}),
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

	/** AgentLoop 内态诊断面（thinking/paused/exit/...；测试与状态条用）。 */
	get agentState(): string {
		return this.#agentLoop.state;
	}

	statusText(): string {
		const mode = this.#gate.mode;
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
			if (key.kind === "esc") {
				this.#search.close();
				this.#scrollOffset = this.#searchSavedScroll; // 复原转录滚回偏移
			} else if (key.kind === "enter") {
				this.#search.next();
				this.#scrollToSearchMatch();
			} else if (key.kind === "ctrl" && key.char === "g") {
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
		// 激活搜索条：Ctrl+F（对齐 kimi tui.altScreen.search 语义；键位经 repl 路由转发）
		if (key.kind === "ctrl" && key.char === "f") {
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
		if (this.#messages.length === 0) {
			const rootEntry = await this.#manager.append(this.#sessionId, null, {
				type: "user",
				payload: { text: turnPrompt } as unknown as JsonValue,
			});
			this.#parentId = rootEntry.id;
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

	async #appendChained(input: AppendEntryInput): Promise<void> {
		const entry = await this.#manager.append(this.#sessionId!, this.#parentId ?? null, input);
		this.#parentId = entry.id;
	}

	/** 装配执行体：权限门（manual ask → 审批浮层回路）→ 真实工具。 */
	async #execute(call: ToolCall, signal: AbortSignal): Promise<unknown> {
		const binding = this.#registry.get(call.name);
		if (binding === undefined) throw new Error(`unknown-tool: ${call.name}`);
		const argSummary = binding.argSummary?.(call.args) ?? String(JSON.stringify(call.args) ?? "undefined").slice(0, 200);
		const request = { tool: call.name, argSummary, mode: this.#gate.mode } satisfies PermissionRequest;
		const decision = this.#gate.check(request);
		this.#permissionDecisions.push({ tool: call.name, decision: decision.decision });
		if (decision.decision === "deny") {
			throw new Error(`permission-denied${decision.feedback !== undefined ? `: ${decision.feedback}` : ""}`);
		}
		if (decision.decision === "ask") {
			const overlay = new ApprovalOverlay(call.name, argSummary, () => this.#frame());
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
