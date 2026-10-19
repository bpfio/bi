/**
 * BI-24.2 —— 行编辑器 REPL 接线：交互主回路。
 * BI-25.3 —— REPL 增强：up/down 历史翻页、tab 补全、多行输入语义。
 * BI-27.1 —— 输入补齐：光标可视化（▏1 格条）、多行粘贴（换行原样入稿）、
 *   pageup/pagedown 十条跳页。
 *
 * BI-27.4 —— 候选与命令菜单接线：斜杠草稿（"/" 开头无空白）自动开候选菜单
 *   （session.candidateMenu；前缀/模糊过滤、↑↓ 移动、Tab/Enter 接受补全
 *   "/name "、Esc 关闭）；菜单可见时上述键先于历史翻页/补全/编辑器裁决，
 *   字符键照常进编辑器（菜单随草稿刷新过滤）；非斜杠 Tab 在缺省历史补全
 *   无进益时经候选菜单 provider 前缀延伸补全。候选面注入点 =
 *   AgentTuiSession options.candidates（菜单视图组件在 agent-tui.ts 落格，
 *   状态行/提示行两行永不侵占）；命令真实分发归宿主装配（bin/** 缝）。
 * BI-27.5 —— 视口接线：wheel-up/wheel-down（SGR 1000/1006 鼠标上报）全态
 *   转发 session.handleKey = 转录窗滚回（步长 3 行/格，锚底钳顶，审批挂起/
 *   回合在飞时同样可翻历史且不触碰审批/取消路由）。
 * TUI-ALIGN-4b —— 鼠标点击定位光标（kimi input.ts handleMouse 对齐）：idle
 *   编辑态下提示行（rows-1）左键按下（InputLoop SGR 解析 mouse-click）经
 *   promptClickToCursor（mount/mouse-cursor.ts 纯函数）换算为光标码元位——
 *   横滚窗口起始列 + 前缀宽、光标条 ▏ 占列扣回、CJK 宽字符右半对齐码元
 *   起点、超末尾贴尾；转录区点击 / 搜索态 / 审批态点击忽略（v1）。坐标
 *   事件非键位，不进键位注册表（TUI-ALIGN-4a）；LineEditor.setCursor 为
 *   本卡新增最小接口。
 *
 * 挂载面（器官全量复用、不改动；本文件为 mount 层新配件）：
 * - **LineEditor**：基于 ParsedKey（diff-renderer.ts）的单行编辑器。可见字符
 *   追加/插入、backspace、left/right/home/end 光标移动、Enter 提交非空行
 *   （空行含纯空白忽略）、Ctrl+C（非空=清空草稿，空=退出 REPL）、Ctrl+D=退出、
 *   Ctrl+E=外部编辑器桥（editPromptCommand 校验：空文本/编辑器异常=取消保稿）、
 *   paste（PasteBurst 聚合事件）走 insertRaw 原样入稿（BI-27.1：换行不摊平）。
 *   Esc 不在编辑器内消费——会话取消
 *   语义由 runRepl 主回路按会话状态路由。
 * - **PromptHistory（BI-25.3）**：已提交行入史；空草稿 up=最近一条，连续
 *   up/down 来回移动（最旧处钳制不绕回）；编辑过草稿在第一次离开草稿槽时
 *   先暂存，down 越回草稿槽时还原（无暂存=空稿）；回想条目上的再编辑不二次
 *   暂存（再次回到草稿槽即丢失，见头注边界）。
 * - **tab 补全（BI-25.3）**：ReplOptions.completions 可注入候选面（缺省
 *   historyCompletions = 历史前缀匹配，排除与草稿全等的项）。Tab：唯一候选
 *   整稿补全；多候选取第一共同前缀（UTF-16 码元逐位，不劈开代理对）；无候选
 *   或共同前缀不带来进益 no-op。
 * - **多行输入语义（BI-25.3 / BI-27.1）**：外编回填（Ctrl+E）文本中的换行
 *   原样保留并整体提交（LineEditor.replaceAllRaw 不摊平）；粘贴（BI-27.1
 *   语义变更）同样走 insertRaw 原样入稿，Enter 单次提交含换行整稿（runRepl
 *   提交逻辑不变）；编辑行显示端把换行摊平为 ⏎（草稿内态保留原样；onPrompt
 *   探针回吐原稿含换行）；历史条目含换行时回想同样保留原样。
 * - **runRepl**：主循环——注入键流 → 编辑器 → 提交行 → session.submit()
 *   （transcript 渲染由 session 的 onFrame 钩子/组件栈承担，REPL 不重复画；
 *   提示行经 session.app 组件栈走 session 注入渲染面）→ 回到提示行。
 *   Ctrl+C 空 / Ctrl+D 退出返回 ReplResult；会话 Esc 二段退出（exited 态）
 *   时 REPL 同步终场（endedAs=session-exited）。
 * - **KeyStream**：可推送按键队列（AsyncIterable<ParsedKey> 注入面）。测试
 *   直接 push 键；真实终端侧由 InputLoop（diff-renderer.ts）onKey → push 桥接
 *   ——raw-mode 真实终端接线归后续装配卡。
 *
 * 键位路由（runRepl 单一裁决点）：
 * - awaiting-approval：全部键经 session.app.dispatchKey（审批浮层栈顶消费
 *   y/n/Esc，其余落空）；
 * - running：Esc → session.handleKey（二段取消语义， awaited）；其余键经
 *   dispatchKey 透传（无浮层则落空）；
 * - 编辑态（idle）：up/down=历史逐条翻页、pageup/pagedown=十条跳页（BI-27.1，
 *   复用同一暂存语义）、tab=补全先于编辑器裁决；mouse-click（TUI-ALIGN-4b，
 *   提示行落点）=定位光标（非提示行落点/其余态忽略，v1）；其余交
 *   LineEditor.feed；Esc 落空（session.handleKey 对 idle 不消费）。
 *
 * 诚实边界（最小可用面，超出部分显式不做）：
 * - 单行编辑器：光标按 UTF-16 码元移动（不感知字形簇/组合 emoji）；多行草稿
 *   在编辑器内仍为单"行"内态（光标跨换行按码元计）；
 * - 光标可视化（BI-27.1）：提示行渲染 `❯ ` + draft[:cursor] + `▏` +
 *   draft[cursor:]——1 格光标条把右侧文本推右（v1 语义，非原位覆写）。切分
 *   按 UTF-16 码元直切（与光标移动同粒度）：cursor 落在代理对中间时左半为
 *   孤立代理（VirtualTerminal 按宽 0 丢弃，条位视觉偏移一格）；cursor 落在
 *   \r\n 两码元中间时两侧各摊平出一个 ⏎（双 ⏎ 边界，备案不做合并）；
 * - 历史翻页为钳制语义（最旧处 up 原地踏步，非绕回循环）；回想条目上的再
 *   编辑不二次暂存；pageup/pagedown 为连续十次 up()/down()（BI-27.1），暂存
 *   只在首次离开草稿槽发生一次（后续调用游标已离槽，不重复覆盖，PromptHistory
 *   单测备案）；历史无去重（相邻重复提交各占一条）；
 * - tab 多候选不展示候选菜单（仅第一共同前缀进益，菜单归后续卡）；
 * - 粘贴（BI-27.1 语义变更）：\r/\n 原样入稿不摊平（显示端再摊平为 ⏎、
 *   提交原样）；外编回填另去尾部空白（编辑器补写的换行属噪音）
 *   但内部换行原样保留（BI-25.3）；
 * - 提示行组件回合在飞时隐藏（让位状态行）；帧绘制依赖 DiffRenderer 差分，
 *   内容不变则零字节；
 * - EOF（输入流耗尽）时若回合仍在飞（含审批挂起）则等待其落定后返回；
 * - KeyStream 为单消费者队列（多消费竞争未定义）；runRepl 退出时对上游迭代器
 *   的 return() 只触发不等待（后台收流，真实终端侧 InputLoop 常驻由宿主管理）；
 * - pageup/pagedown 键面：ParsedKey 已含两键（BI-19 csiTildeKey 解析
 *   CSI 5~/6~，本卡零改动）；带修饰变体（CSI 5;5~ 等）不支持——csiTildeKey
 *   全参匹配落 null 忽略。
 */

import type { ParsedKey } from "../engine/diff-renderer";
import type { VirtualTerminal } from "../engine/virtual-terminal";
import type { Component } from "../components/tui-app";
import { editPromptCommand } from "../commands/edit-prompt";
import { editExternally as defaultEditExternally, type EditResult } from "../editor/external-editor";
import { cwd } from "node:process";

import { AgentTuiSession, type TuiSessionResult, type TuiSessionState } from "./agent-tui";
import { DEFAULT_KEYBINDINGS, actionForKey, type Keybindings } from "./keybindings";
import { promptClickToCursor } from "./mouse-cursor";
import { layoutPromptLine, segmentGraphemes } from "../components/cjk-width";
import { applyFileCompletion, completeFileAtCursor, extractToken, isPathLikePrefix } from "./file-completion";
import { KillRing, UndoStack, findWordBackward, findWordForward } from "./editor-history";

/** pageup/pagedown 单键跳页条数（BI-27.1；连发累计，最旧/草稿槽双端钳制）。 */
const PAGE_JUMP_LINES = 10;

// ---------------------------------------------------------------------------
// LineEditor —— 单行编辑器（mount 层纯内态配件，不触终端）
// ---------------------------------------------------------------------------

/** 行编辑动作（feed 的结构化裁决；REPL 主回路据此路由）。 */
export type LineEditAction =
  | { readonly kind: "none" }
  | { readonly kind: "edit" }
  | { readonly kind: "submit"; readonly line: string }
  | { readonly kind: "exit"; readonly key: "ctrl-c" | "ctrl-d" }
  | { readonly kind: "external-edit" };

/**
 * 单行编辑器：草稿 + 光标（UTF-16 码元下标）。纯内态，不触终端。
 * D7 强化：光标移动 / 删除按字素粒度（segmentGraphemes）；Emacs 式
 * kill/kill-ring/yank/word/undo（editor-history）。光标下标仍用码元以便与
 * insert/insertRaw/replaceWithCursor 等码元接口共存；字素↔码元换算经
 * segmentGraphemes 的 index 字段完成。
 */
export class LineEditor {
  #draft = "";
  #cursor = 0;
  readonly #killRing = new KillRing();
  readonly #undoStack = new UndoStack<{ draft: string; cursor: number }>();
  #lastWasKill = false;
  /** 键位注册表（缺省 = 默认表；经 runRepl 选项注入，保持纯函数可测）。 */
  readonly #bindings: Keybindings;

  constructor(bindings: Keybindings = DEFAULT_KEYBINDINGS) {
    this.#bindings = bindings;
  }

  /** 当前草稿。 */
  get draft(): string {
    return this.#draft;
  }

  /** 光标（UTF-16 码元下标，0..draft.length）。 */
  get cursor(): number {
    return this.#cursor;
  }

  /** kill-ring 视图（测试观察面）。 */
  get killRing(): KillRing {
    return this.#killRing;
  }

  /** 撤销栈深度（测试观察面）。 */
  get undoLength(): number {
    return this.#undoStack.length;
  }

  /** 清空草稿（光标归零）。 */
  clear(): void {
    this.#draft = "";
    this.#cursor = 0;
    this.#lastWasKill = false;
  }

  /** 整稿替换（外编回填路径；内部复用 insert 摊平语义）。 */
  replaceAll(text: string): void {
    this.clear();
    this.insert(text);
  }

  /**
   * 整稿替换并显式置光标（文件补全光标数学需要精确落点，replaceAllRaw 恒置行尾不适用）。
   */
  replaceWithCursor(text: string, cursor: number): void {
    this.#draft = text;
    this.#cursor = Math.max(0, Math.min(cursor, text.length));
    this.#lastWasKill = false;
  }

  /**
   * 显式置光标（TUI-ALIGN-4b 鼠标点击定位）：越界钳制到 0..draft.length；
   * 不动草稿、不压撤销（纯定位动作，与 home/end 同级）。
   */
  setCursor(n: number): void {
    this.#cursor = Math.max(0, Math.min(n, this.#draft.length));
    this.#lastWasKill = false;
  }

  /**
   * 整稿替换（换行原样保留；BI-25.3 多行语义专用路径：外编回填与历史回想），
   * 光标归行尾。与 replaceAll 的差异：不摊平 \r/\n、不经过 insert 过滤。
   */
  replaceAllRaw(text: string): void {
    this.#draft = text;
    this.#cursor = text.length;
    this.#lastWasKill = false;
  }

  /**
   * 光标处插入原始文本（BI-27.1 多行粘贴专用路径）：\r/\n 原样入稿不摊平、
   * 不做控制字节过滤——paste 事件来自 PasteBurst 聚合，语义上已是用户整段
   * 意图文本（Enter 提交时单次带换行整稿上送）。显示端摊平归 PromptView。
   */
  insertRaw(text: string): void {
    if (text.length === 0) return;
    this.#draft = this.#draft.slice(0, this.#cursor) + text + this.#draft.slice(this.#cursor);
    this.#cursor += text.length;
    this.#lastWasKill = false;
  }

  /** 光标处插入文本；\r/\n 摊平为空格（char 路径单行边界；BI-27.1 起 paste 不再走此路径）。 */
  insert(text: string): void {
    if (text.length === 0) return;
    const flat = text.replace(/\r\n?|\n/g, " ");
    this.#draft = this.#draft.slice(0, this.#cursor) + flat + this.#draft.slice(this.#cursor);
    this.#cursor += flat.length;
    this.#lastWasKill = false;
  }

  // ---- 撤销快照（每次结构性编辑前压栈） ----
  #pushUndo(): void {
    this.#undoStack.push({ draft: this.#draft, cursor: this.#cursor });
  }

  // ---- 字素级移动 / 删除（替代旧码元级） ----
  #moveLeftGrapheme(): LineEditAction {
    if (this.#cursor === 0) return { kind: "none" };
    const segs = segmentGraphemes(this.#draft.slice(0, this.#cursor));
    const last = segs[segs.length - 1];
    if (last !== undefined) this.#cursor = last.index;
    this.#lastWasKill = false;
    return { kind: "edit" };
  }

  #moveRightGrapheme(): LineEditAction {
    if (this.#cursor >= this.#draft.length) return { kind: "none" };
    const segs = segmentGraphemes(this.#draft.slice(this.#cursor));
    const first = segs[0];
    if (first !== undefined) this.#cursor += first.index + first.segment.length;
    this.#lastWasKill = false;
    return { kind: "edit" };
  }

  #deleteBackwardGrapheme(): LineEditAction {
    if (this.#cursor === 0) return { kind: "none" };
    const segs = segmentGraphemes(this.#draft.slice(0, this.#cursor));
    const last = segs[segs.length - 1];
    const start = last !== undefined ? last.index : 0;
    this.#pushUndo();
    this.#draft = this.#draft.slice(0, start) + this.#draft.slice(this.#cursor);
    this.#cursor = start;
    this.#lastWasKill = false;
    return { kind: "edit" };
  }

  #moveWordBackward(): LineEditAction {
    if (this.#cursor === 0) return { kind: "none" };
    this.#cursor = findWordBackward(this.#draft, this.#cursor);
    this.#lastWasKill = false;
    return { kind: "edit" };
  }

  #moveWordForward(): LineEditAction {
    if (this.#cursor >= this.#draft.length) return { kind: "none" };
    this.#cursor = findWordForward(this.#draft, this.#cursor);
    this.#lastWasKill = false;
    return { kind: "edit" };
  }

  // ---- Emacs 式 kill（删 + 入 kill-ring） ----
  #killToEnd(): LineEditAction {
    if (this.#cursor >= this.#draft.length) return { kind: "none" };
    const accumulate = this.#lastWasKill;
    this.#pushUndo();
    const deleted = this.#draft.slice(this.#cursor);
    this.#killRing.push(deleted, { prepend: false, accumulate });
    this.#draft = this.#draft.slice(0, this.#cursor);
    this.#lastWasKill = true;
    return { kind: "edit" };
  }

  #killToStart(): LineEditAction {
    if (this.#cursor === 0) return { kind: "none" };
    const accumulate = this.#lastWasKill;
    this.#pushUndo();
    const deleted = this.#draft.slice(0, this.#cursor);
    this.#killRing.push(deleted, { prepend: true, accumulate });
    this.#draft = this.#draft.slice(this.#cursor);
    this.#cursor = 0;
    this.#lastWasKill = true;
    return { kind: "edit" };
  }

  #killWordBackward(): LineEditAction {
    if (this.#cursor === 0) return { kind: "none" };
    const from = findWordBackward(this.#draft, this.#cursor);
    const deleted = this.#draft.slice(from, this.#cursor);
    const accumulate = this.#lastWasKill;
    this.#pushUndo();
    this.#killRing.push(deleted, { prepend: true, accumulate });
    this.#draft = this.#draft.slice(0, from) + this.#draft.slice(this.#cursor);
    this.#cursor = from;
    this.#lastWasKill = true;
    return { kind: "edit" };
  }

  #yank(): LineEditAction {
    const text = this.#killRing.peek();
    if (text === undefined) return { kind: "none" };
    this.#pushUndo();
    this.#draft = this.#draft.slice(0, this.#cursor) + text + this.#draft.slice(this.#cursor);
    this.#cursor += text.length;
    this.#lastWasKill = false;
    return { kind: "edit" };
  }

  #undo(): LineEditAction {
    const snap = this.#undoStack.pop();
    if (snap === undefined) return { kind: "none" };
    this.#draft = snap.draft;
    this.#cursor = snap.cursor;
    this.#lastWasKill = false;
    return { kind: "edit" };
  }

  /**
   * 按键喂入。Esc 不在此消费（会话取消语义由 REPL 主回路路由）；submit 时
   * 草稿自清并把原文随动作带回。可见字符以控制字节过滤（<0x20 / 0x7f 不入稿）。
   * Emacs 键位：ctrl-a=行首、ctrl-b=字素左、ctrl-d=退出（既有）、ctrl-e=外编桥
   * （既有）、ctrl-f=不消费（D5 转发搜索）、ctrl-k=删至行尾、ctrl-u=删至行首、
   * ctrl-w=删词、ctrl-y=yank、ctrl-z=undo；ctrl-c/d 既有行为不变。
   */
  feed(key: ParsedKey): LineEditAction {
    switch (key.kind) {
      case "char": {
        const ch = key.char ?? "";
        if (ch.length === 0) return { kind: "none" };
        const code = ch.charCodeAt(0);
        if (code < 0x20 || code === 0x7f) return { kind: "none" };
        this.insert(ch);
        return { kind: "edit" };
      }
      case "paste": {
        // BI-27.1：粘贴换行原样入稿（语义变更，见头注多行输入语义）。
        const text = key.text ?? "";
        if (text.length === 0) return { kind: "none" };
        this.insertRaw(text);
        return { kind: "edit" };
      }
      case "backspace":
        return this.#deleteBackwardGrapheme();
      case "enter":
        // 空行（含纯空白）忽略；非空提交原文并自清草稿。
        if (this.#draft.trim().length === 0) return { kind: "none" };
        {
          const line = this.#draft;
          this.clear();
          return { kind: "submit", line };
        }
      case "left":
        return this.#moveLeftGrapheme();
      case "right":
        return this.#moveRightGrapheme();
      case "home":
        if (this.#cursor !== 0) {
          this.#cursor = 0;
          this.#lastWasKill = false;
          return { kind: "edit" };
        }
        return { kind: "none" };
      case "end":
        if (this.#cursor !== this.#draft.length) {
          this.#cursor = this.#draft.length;
          this.#lastWasKill = false;
          return { kind: "edit" };
        }
        return { kind: "none" };
      case "ctrl": {
        // 经键位注册表反查动作（默认表逐条对照现码，行为零变化）。
        switch (actionForKey(this.#bindings, key)) {
          case "editor.clear-or-exit":
            // 非空=清空草稿（撤销重敲）；空=退出 REPL。
            if (this.#draft.length > 0) {
              this.clear();
              return { kind: "edit" };
            }
            return { kind: "exit", key: "ctrl-c" };
          case "editor.exit":
            // EOF 语义：退出并弃稿。
            this.clear();
            return { kind: "exit", key: "ctrl-d" };
          case "editor.external-edit":
            // 长文本外编桥：草稿保留，由主回路执行 editPromptCommand 回填（BI-25.3，保留）。
            return { kind: "external-edit" };
          case "editor.beginning-of-line":
            // readline：beginning-of-line。
            if (this.#cursor !== 0) {
              this.#cursor = 0;
              this.#lastWasKill = false;
              return { kind: "edit" };
            }
            return { kind: "none" };
          case "editor.backward-char":
            // readline：backward-char（字素粒度）。
            return this.#moveLeftGrapheme();
          case "editor.kill-line":
            // readline：kill-line（删至行尾，入 kill-ring）。
            return this.#killToEnd();
          case "editor.kill-line-to-start":
            // readline：unix-line-discard（删至行首，入 kill-ring）。
            return this.#killToStart();
          case "editor.kill-word-backward":
            // readline：unix-word-rubout（删词至行首方向，入 kill-ring）。
            return this.#killWordBackward();
          case "editor.yank":
            // readline：yank（粘贴最近 kill）。
            return this.#yank();
          case "editor.undo":
            // Emacs：undo（bi 输入层 ctrl+- 不可达，以 ctrl+z 承载）。
            return this.#undo();
          default:
            // 未绑定的 ctrl 键（含 search.open=ctrl+f，由 runRepl 层转发）不消费。
            return { kind: "none" };
        }
      }
      default:
        // esc/tab/方向键翻页键等：本编辑器不消费（取消/翻页/补全归外层或后续卡）。
        return { kind: "none" };
    }
  }
}

// ---------------------------------------------------------------------------
// PromptHistory —— 提交历史（BI-25.3：up/down 翻页 + 草稿暂存）
// ---------------------------------------------------------------------------

/**
 * 提交历史（BI-25.3）：runRepl 在提交动作处 record，编辑态 up/down 翻页。
 * 语义（readline 惯例的务实子集，"循环"= 来回移动、最旧处钳制不绕回）：
 * - record：非空行入史，游标复位到"草稿槽"（下标 = 行数）并弃暂存；
 * - up：无历史 no-op（返回 undefined）；自草稿槽出发且草稿非空 → 先暂存
 *   （仅第一次离开草稿槽时）；连续 up 向更旧方向移动；
 * - down：已在草稿槽 no-op；越回草稿槽时还原暂存（无暂存 = 空稿）。
 */
export class PromptHistory {
  #lines: string[] = [];
  #index = 0;
  #stash: string | undefined;

  /** 已提交历史（旧→新；数组快照语义，外部不持有的可变只读视图）。 */
  get lines(): readonly string[] {
    return this.#lines;
  }

  /** 被暂存的编辑草稿（down 越回草稿槽时还原；无暂存 = undefined）。 */
  get stashedDraft(): string | undefined {
    return this.#stash;
  }

  /** 提交入史：空串不入；游标复位草稿槽、弃暂存。 */
  record(line: string): void {
    if (line === "") return;
    this.#lines.push(line);
    this.#index = this.#lines.length;
    this.#stash = undefined;
  }

  /** up 翻页：返回新草稿文本；无历史返回 undefined（调用方 no-op）。 */
  up(draft: string): string | undefined {
    if (this.#lines.length === 0) return undefined;
    if (this.#index === this.#lines.length && draft !== "" && this.#stash === undefined) {
      this.#stash = draft; // 编辑过草稿先暂存
    }
    if (this.#index > 0) this.#index -= 1;
    return this.#lines[this.#index]!;
  }

  /** down 翻页：返回新草稿文本；已在草稿槽返回 undefined（no-op）。 */
  down(): string | undefined {
    if (this.#index >= this.#lines.length) return undefined;
    this.#index += 1;
    if (this.#index === this.#lines.length) {
      const restored = this.#stash ?? "";
      this.#stash = undefined;
      return restored;
    }
    return this.#lines[this.#index]!;
  }
}

// ---------------------------------------------------------------------------
// tab 补全（BI-25.3）：候选面 + 共同前缀 + 裁决
// ---------------------------------------------------------------------------

/** 补全候选面：给定草稿返回候选串（注入面；缺省 = 历史前缀匹配）。 */
export type CompletionsFn = (draft: string) => string[];

/**
 * 缺省补全面：历史前缀匹配（保持历史原序；排除与草稿全等的项——补全必须
 * 带来进益，等值候选参与只会产生 no-op）。
 */
export function historyCompletions(history: PromptHistory): CompletionsFn {
  return (draft) => history.lines.filter((line) => line.startsWith(draft) && line !== draft);
}

/** 候选集第一共同前缀（UTF-16 码元逐位比较；收尾高代理回退一位不劈开代理对）。 */
export function commonPrefix(values: readonly string[]): string {
  if (values.length === 0) return "";
  let prefix = values[0] ?? "";
  for (const value of values) {
    let i = 0;
    const n = Math.min(prefix.length, value.length);
    while (i < n && prefix[i] === value[i]) i += 1;
    prefix = prefix.slice(0, i);
    if (prefix === "") return "";
  }
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last !== undefined && last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
  return prefix;
}

/**
 * Tab 补全裁决：唯一候选整稿补全；多候选取第一共同前缀；候选须为草稿的
 * 前缀延伸（target !== draft 且 startsWith(draft)）才算进益，否则 undefined
 * （调用方 no-op，不动草稿）。
 */
export function completeDraft(draft: string, candidates: readonly string[]): string | undefined {
  if (candidates.length === 0) return undefined;
  const target = candidates.length === 1 ? candidates[0]! : commonPrefix(candidates);
  if (target === draft || !target.startsWith(draft)) return undefined;
  return target;
}

// ---------------------------------------------------------------------------
// KeyStream —— 可推送按键队列（AsyncIterable 注入面）
// ---------------------------------------------------------------------------

/**
 * 可推送按键队列：测试直接 push 键驱动 runRepl；真实终端侧由 InputLoop 的
 * onKey 回调 → push 桥接（raw-mode 接线归后续装配卡）。单消费者。
 */
export class KeyStream implements AsyncIterable<ParsedKey> {
  #buffer: ParsedKey[] = [];
  #notify: (() => void) | undefined;
  #closed = false;

  /** 推入一个按键（关闭后推送被忽略）。 */
  push(key: ParsedKey): void {
    if (this.#closed) return;
    this.#buffer.push(key);
    const notify = this.#notify;
    this.#notify = undefined;
    notify?.();
  }

  /** 关闭流：挂起中的消费者在吐完缓冲后自然收束（eof）。 */
  end(): void {
    this.#closed = true;
    const notify = this.#notify;
    this.#notify = undefined;
    notify?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ParsedKey> {
    while (true) {
      while (this.#buffer.length > 0) {
        const key = this.#buffer.shift();
        if (key !== undefined) yield key;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#notify = resolve;
      });
    }
  }
}

// ---------------------------------------------------------------------------
// PromptView —— 提示行组件（经 session.app 组件栈走 session 注入渲染面）
// ---------------------------------------------------------------------------

/** REPL 提示行组件：底部行渲染 `❯ {草稿}`（含 ▏光标条，BI-27.1）；回合在飞时隐藏（状态行透出）。 */
class PromptView implements Component {
  #draft = "";
  #cursor = 0;
  #active = true;

  /**
   * 更新草稿与光标并置于可见态（编辑态每次变化调用；cursor 由调用方传
   * editor.cursor，同粒度 UTF-16 码元，越界钳制到 0..draft.length）。
   */
  update(draft: string, cursor: number): void {
    this.#draft = draft;
    this.#cursor = Math.max(0, Math.min(cursor, draft.length));
    this.#active = true;
  }

  /** 隐藏（回合提交时调用，状态行透出）。 */
  hide(): void {
    this.#active = false;
  }

  /** 恢复可见（回合收束时调用，回到提示行）。 */
  activate(): void {
    this.#active = true;
  }

  render(term: VirtualTerminal): void {
    if (!this.#active) return;
    // D7：提示行经 layoutPromptLine 渲染——草稿超宽时横向滚动、光标条 ▏ 恒在
    // 可视窗口内（不劈宽字符 / 代理对）；未超宽退化为整行（含 ⏎ 摊平，v1 语义）。
    term.write(0, term.rows - 1, layoutPromptLine(this.#draft, this.#cursor, term.cols));
  }

  wantsKey(_key: ParsedKey): boolean {
    return false; // 按键由 runRepl 主回路路由，不参与 TuiApp 派发消费
  }
}

// ---------------------------------------------------------------------------
// runRepl —— 交互主回路
// ---------------------------------------------------------------------------

/** 读取会话态：经函数边界解除 TS 对 getter 属性链的控制流收窄（状态跨 await 可变）。 */
function stateOf(session: AgentTuiSession): TuiSessionState {
  return session.state;
}

export interface ReplOptions {
  /** 目标会话（调用方装配；未 start 时 REPL 以 title 自动初始化）。 */
  readonly session: AgentTuiSession;
  /** 注入按键流（AsyncIterable<ParsedKey>；真实终端侧 InputLoop→KeyStream 桥归后续卡）。 */
  readonly keys: AsyncIterable<ParsedKey>;
  /** 自动 start 的会话标题（缺省 "bi repl"；会话已 start 时忽略）。 */
  readonly title?: string;
  /** 提示行变化探针：草稿每次重绘回吐当前草稿（测试断言点）。 */
  readonly onPrompt?: (draft: string) => void;
  /** Ctrl+E 外编执行面（缺省真实 editExternally；测试注入离屏 fake）。 */
  readonly editExternally?: (initialText: string) => Promise<EditResult>;
  /** Tab 补全候选面（BI-25.3；缺省 historyCompletions = 历史前缀匹配）。
   * BI-27.4 起与候选菜单并存：历史补全无进益时经 session.candidateMenu 的
   * provider 前缀延伸补全（候选面注入点=AgentTuiSession options.candidates）。 */
  readonly completions?: CompletionsFn;
  /** 文件/路径/@ 补全基目录（BI-19.8；缺省 process.cwd()）。 */
  readonly cwd?: string;
  /** 键位注册表（TUI-ALIGN-4a；缺省 DEFAULT_KEYBINDINGS）。 */
  readonly keybindings?: Keybindings;
}

export interface ReplResult {
  /** 会话 id（未 start 过则 undefined）。 */
  readonly sessionId: string | undefined;
  /** 实际提交的输入行数（含后被取消/出错的回合）。 */
  readonly submittedLines: number;
  /** 退出原因：eof=输入流耗尽；exit-key=Ctrl+C 空/Ctrl+D；session-exited=会话 Esc 二段退出。 */
  readonly endedAs: "eof" | "exit-key" | "session-exited";
  /** endedAs === "exit-key" 时记录具体按键。 */
  readonly exitKey: "ctrl-c" | "ctrl-d" | undefined;
  /** 最后一回合的收束结果（无回合则 undefined）。 */
  readonly lastResult: TuiSessionResult | undefined;
  /** 最后一回合的异常（adapter-error/rounds-exceeded 等；正常收束为 undefined）。 */
  readonly lastError: unknown;
}

/**
 * 交互 REPL 主循环（BI-24.2）：注入键流 → LineEditor → session.submit()。
 * 会话未 start 时以 title 自动初始化；退出时弹出提示行组件还原会话组件栈。
 * 回合异常不终止 REPL（记入 lastError 后可继续输入）；会话 exited（Esc 二段）
 * 则 REPL 同步终场。
 */
export async function runRepl(options: ReplOptions): Promise<ReplResult> {
  const session = options.session;
  const keys = options.keys;
  const onPrompt = options.onPrompt ?? (() => undefined);
  const editBridge = options.editExternally ?? defaultEditExternally;
  const history = new PromptHistory();
  const completions = options.completions ?? historyCompletions(history);
  const basePath = options.cwd ?? cwd();
  const bindings = options.keybindings ?? DEFAULT_KEYBINDINGS;
  const editor = new LineEditor(bindings);
  const prompt = new PromptView();

  if (session.sessionId === undefined) await session.start(options.title ?? "bi repl");
  session.app.push(prompt);
  prompt.update(editor.draft, editor.cursor);
  onPrompt(editor.draft);
  session.app.render(); // 首帧：提示行落布（writer 面可见）

  let submittedLines = 0;
  let lastResult: TuiSessionResult | undefined;
  let lastError: unknown;
  let pendingTurn: Promise<void> | undefined;
  let endedAs: ReplResult["endedAs"] = "eof";
  let exitKey: ReplResult["exitKey"];

  /** 回合收束记账：结果/异常落账 + 回到提示行（挂在 promise 上，不轮询）。 */
  const trackTurn = (turn: Promise<TuiSessionResult>): void => {
    const settled = turn.then(
      (result) => {
        lastResult = result;
      },
      (error) => {
        lastError = error;
      },
    );
    pendingTurn = settled.finally(() => {
      pendingTurn = undefined;
      prompt.update(editor.draft, editor.cursor); // 回到提示行时同步当前草稿（提交后=空稿，不残留旧稿渲染）
      prompt.activate(); // 回到提示行
      session.app.render();
    });
  };

  const iterator = keys[Symbol.asyncIterator]();
  /** 草稿变化后的统一重绘：菜单同步（BI-27.4）→ 提示行 → 探针 → 帧。 */
  const redraw = (): void => {
    session.candidateMenu.sync(editor.draft);
    prompt.update(editor.draft, editor.cursor);
    onPrompt(editor.draft);
    session.app.render();
  };
  try {
    let next = await iterator.next();
    while (next.done !== true) {
      const key: ParsedKey = next.value;

      // 会话已退出（Esc 二段终态）：REPL 同步终场。
      if (stateOf(session) === "exited") {
        endedAs = "session-exited";
        break;
      }

      // BI-27.5：滚轮（SGR 鼠标上报）= 转录窗滚回，全态可用（审批挂起/
      // 回合在飞时同样可翻历史，不影响审批/取消路由）。
      if (key.kind === "wheel-up" || key.kind === "wheel-down") {
        await session.handleKey(key);
      } else if (key.kind === "mouse-click" && stateOf(session) === "idle" && !session.searchActive) {
        // TUI-ALIGN-4b：提示行点击定位光标。v1 边界——仅 idle 编辑态生效
        // （审批挂起/回合在飞时提示行隐藏、按键归浮层/透传，点击落空；搜索态
        // 按键全部归搜索，点击忽略）；落点非提示行（转录区/状态行）由
        // promptClickToCursor 行判定忽略。纯光标移动不走 onPrompt 探针
        // （草稿未变；prompt.update + 出帧，与候选菜单选择移动同 pattern）。
        const target = promptClickToCursor(key, {
          draft: editor.draft,
          cursor: editor.cursor,
          cols: session.cols,
          promptRow: session.rows - 1,
        });
        if (target !== undefined && target !== editor.cursor) {
          editor.setCursor(target);
          prompt.update(editor.draft, editor.cursor);
          session.app.render();
        }
      } else if (stateOf(session) === "awaiting-approval") {
        session.app.dispatchKey(key);
      } else if (stateOf(session) === "running") {
        // 回合在飞：Esc=二段取消语义（await 落定）；其余键透传组件栈。
        if (key.kind === "esc") {
          await session.handleKey(key);
          if (stateOf(session) === "exited") {
            endedAs = "session-exited"; // 窗口内二段 Esc：exit 终态
            break;
          }
        } else {
          session.app.dispatchKey(key);
        }
      } else {
        // 编辑态（idle）
        // D5 遗留接线：转录搜索模态激活时全部按键经 session.handleKey 路由
        // （开/查/关）；Ctrl+F（非编辑态触发）转发开转录搜索（agent-tui.handleKey
        // 已实现）。与 readline 的 C-f=forward-char 冲突，本卡让位给搜索，前进仍
        // 由 → 承载（kimi 同将 ctrl+f 与 right 并列绑为 cursorRight，bi 取舍）。
        if (session.searchActive) {
          await session.handleKey(key);
        } else if (actionForKey(bindings, key) === "search.open") {
          await session.handleKey(key); // 开转录搜索（BI-19.1-search；键位=search.open）
        } else {
        // 候选菜单（BI-27.4）先于历史翻页/补全裁决——菜单
        // 可见时 up/down=菜单选择移动、Tab/Enter=接受选中、Esc=关闭菜单
        // （均不落编辑器/历史；字符键照常进编辑器，redraw 内 sync 刷新过滤）。
        const menu = session.candidateMenu;
        if (menu.visible && (key.kind === "up" || key.kind === "down")) {
          if (key.kind === "up") menu.moveUp();
          else menu.moveDown();
          session.app.render(); // 仅选择移动：草稿不变，重绘菜单即可
        } else if (menu.visible && (key.kind === "tab" || key.kind === "enter")) {
          if (menu.mode === "file") {
            // BI-19.8：文件菜单选中 → 对光标前 token 做精确替换（含目录/文件后缀）。
            const item = menu.acceptFile();
            if (item !== undefined) {
              const res = applyFileCompletion(editor.draft, editor.cursor, item);
              editor.replaceWithCursor(res.draft, res.cursor);
              menu.dismiss(); // 接受即关文件菜单（sync 在 redraw 内复位状态）
              redraw();
            }
            // 防御：可见但无选中（空集不可见，理论不可达）——不吞提交，落空。
          } else {
            const accepted = menu.accept();
            if (accepted !== undefined) {
              editor.replaceAllRaw(accepted); // 补全草稿 "/name "（菜单随 sync 关闭）
              redraw();
            }
            // 防御：可见但无选中（空集不可见，理论不可达）——不吞提交，落空。
          }
        } else if (menu.visible && key.kind === "esc") {
          menu.dismiss(); // Esc 第一义=关菜单（会话取消语义不被触发）
          session.app.render();
        } else if (key.kind === "up" || key.kind === "down") {
          const recalled = key.kind === "up" ? history.up(editor.draft) : history.down();
          if (recalled !== undefined) {
            editor.replaceAllRaw(recalled); // 历史条目原样回填（多行条目保留换行）
            redraw();
          }
          // no-op（无历史/已在草稿槽）：草稿不动。
        } else if (key.kind === "pageup" || key.kind === "pagedown") {
          // BI-27.1：十条跳页——连续十次 up()/down()（最旧/草稿槽双端钳制，
          // 连发累计）。暂存复用 PromptHistory 语义且只发生一次：首调离开
          // 草稿槽时暂存当前草稿，后续调用游标已离槽、不重复覆盖（单测备案）。
          let recalled: string | undefined;
          for (let i = 0; i < PAGE_JUMP_LINES; i++) {
            const next = key.kind === "pageup" ? history.up(editor.draft) : history.down();
            if (next === undefined) break;
            recalled = next;
          }
          if (recalled !== undefined) {
            editor.replaceAllRaw(recalled);
            redraw();
          }
          // no-op（无历史/已在草稿槽）：草稿不动。
        } else if (key.kind === "tab") {
          // BI-19.8：文件/路径/@ 补全优先于历史补全（唯一→整稿、多候选→补公共
          // 前缀并开文件菜单、无候选→undefined 落空）；其后回退 BI-25.3 历史补全。
          // 仅当光标前 token 像路径（@/./~/含 /）才走文件补全，避免抢历史词前缀。
          const token = extractToken(editor.draft.slice(0, editor.cursor)).prefix;
          const file = isPathLikePrefix(token)
            ? completeFileAtCursor(editor.draft, editor.cursor, basePath)
            : undefined;
          if (file !== undefined && file.kind !== "none") {
            editor.replaceWithCursor(file.draft, file.cursor);
            if (file.kind === "common") {
              // 多候选：补首公共前缀后开文件菜单（不调用 redraw/sync 以免关菜单）。
              session.candidateMenu.showFileCandidates(file.items);
              prompt.update(editor.draft, editor.cursor);
              onPrompt(editor.draft);
              session.app.render();
            } else {
              redraw();
            }
          } else {
            // BI-25.3 缺省历史补全（既有语义不变）；无进益时经候选菜单的
            // provider 前缀延伸补全（BI-27.4；斜杠草稿归菜单，此处恒 undefined）。
            const completed =
              completeDraft(editor.draft, completions(editor.draft)) ??
              menu.completeNonSlash(editor.draft);
            if (completed !== undefined) {
              editor.replaceAllRaw(completed);
              redraw();
            }
            // 无候选/无进益：no-op。
          }
        } else {
          const action = editor.feed(key);
          if (action.kind === "edit") {
            redraw();
          } else if (action.kind === "submit") {
            history.record(action.line); // 已提交行入史（BI-25.3）
            session.candidateMenu.sync(editor.draft); // 草稿已自清：菜单随草稿关闭
            prompt.hide(); // 提示行让位，状态行透出
            session.app.render();
            submittedLines += 1;
            trackTurn(session.submit(action.line));
          } else if (action.kind === "exit") {
            endedAs = "exit-key";
            exitKey = action.key;
            break;
          } else if (action.kind === "external-edit") {
            // 长文本外编桥：空文本/编辑器异常=取消保稿（editPromptCommand 校验）。
            // 回填换行原样保留（BI-25.3 多行语义），仅去编辑器补写的尾部空白。
            const outcome = await editPromptCommand(editor.draft, { editor: editBridge });
            if (outcome.status === "submitted") {
              editor.replaceAllRaw(outcome.text.trimEnd());
            }
            redraw();
          }
          // none：空 Enter/无关键落空。
        }
        }
      }

      next = await iterator.next();
    }
  } finally {
    // 弹出提示行组件还原会话组件栈；若栈顶被审批浮层占据（异常收场），原样压回。
    const popped = session.app.pop();
    if (popped !== undefined && popped !== prompt) session.app.push(popped);
    // 上游迭代器收流只触发不等待（真实终端侧 InputLoop 常驻，生命周期归宿主）。
    try {
      const returned = iterator.return?.();
      if (returned !== undefined) void returned.then(() => undefined, () => undefined);
    } catch {
      // 收流尽力语义：同步异常忽略。
    }
  }

  // 输入流收场仍有在飞回合（含审批挂起）：等其落定后返回。
  if (pendingTurn !== undefined) await pendingTurn;

  return { sessionId: session.sessionId, submittedLines, endedAs, exitKey, lastResult, lastError };
}
