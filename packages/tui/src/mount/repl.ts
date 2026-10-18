/**
 * BI-24.2 —— 行编辑器 REPL 接线：交互主回路。
 *
 * 挂载面（器官全量复用、不改动；本文件为 mount 层新配件）：
 * - **LineEditor**：基于 ParsedKey（diff-renderer.ts）的单行编辑器。可见字符
 *   追加/插入、backspace、left/right/home/end 光标移动、Enter 提交非空行
 *   （空行含纯空白忽略）、Ctrl+C（非空=清空草稿，空=退出 REPL）、Ctrl+D=退出、
 *   Ctrl+E=外部编辑器桥（editPromptCommand 校验：空文本/编辑器异常=取消保稿）、
 *   paste（PasteBurst 聚合事件）整段插入。Esc 不在编辑器内消费——会话取消
 *   语义由 runRepl 主回路按会话状态路由。
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
 * - 编辑态（idle）：LineEditor.feed；Esc 落空（session.handleKey 对 idle 不消费）。
 *
 * 诚实边界（最小可用面，超出部分显式不做）：
 * - 单行编辑器：光标按 UTF-16 码元移动（不感知字形簇/组合 emoji）；提示行
 *   渲染不可视化光标位置（left/right 仅改编辑器内态，经 editor.cursor 观察）；
 * - 粘贴/外编回填把 \r/\n 摊平为空格（外编回填另去尾部空白——编辑器补写的
 *   换行属噪音）；多行输入归后续卡；
 * - 提示行组件回合在飞时隐藏（让位状态行）；帧绘制依赖 DiffRenderer 差分，
 *   内容不变则零字节；
 * - EOF（输入流耗尽）时若回合仍在飞（含审批挂起）则等待其落定后返回；
 * - KeyStream 为单消费者队列（多消费竞争未定义）；runRepl 退出时对上游迭代器
 *   的 return() 只触发不等待（后台收流，真实终端侧 InputLoop 常驻由宿主管理）；
 * - up/down/pageup/pageup 历史翻页、tab 补全归后续卡。
 */

import type { ParsedKey } from "../engine/diff-renderer";
import type { VirtualTerminal } from "../engine/virtual-terminal";
import type { Component } from "../components/tui-app";
import { editPromptCommand } from "../commands/edit-prompt";
import { editExternally as defaultEditExternally, type EditResult } from "../editor/external-editor";

import { AgentTuiSession, type TuiSessionResult, type TuiSessionState } from "./agent-tui";

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

/** 单行编辑器：草稿 + 光标（UTF-16 码元下标）。纯内态，不触终端。 */
export class LineEditor {
  #draft = "";
  #cursor = 0;

  /** 当前草稿。 */
  get draft(): string {
    return this.#draft;
  }

  /** 光标（UTF-16 码元下标，0..draft.length）。 */
  get cursor(): number {
    return this.#cursor;
  }

  /** 清空草稿（光标归零）。 */
  clear(): void {
    this.#draft = "";
    this.#cursor = 0;
  }

  /** 整稿替换（外编回填路径；内部复用 insert 摊平语义）。 */
  replaceAll(text: string): void {
    this.clear();
    this.insert(text);
  }

  /** 光标处插入文本；\r/\n 摊平为空格（单行编辑器边界，见头注）。 */
  insert(text: string): void {
    if (text.length === 0) return;
    const flat = text.replace(/\r\n?|\n/g, " ");
    this.#draft = this.#draft.slice(0, this.#cursor) + flat + this.#draft.slice(this.#cursor);
    this.#cursor += flat.length;
  }

  /**
   * 按键喂入。Esc 不在此消费（会话取消语义由 REPL 主回路路由）；submit 时
   * 草稿自清并把原文随动作带回。可见字符以控制字节过滤（<0x20 / 0x7f 不入稿）。
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
        const text = key.text ?? "";
        if (text.length === 0) return { kind: "none" };
        this.insert(text);
        return { kind: "edit" };
      }
      case "backspace": {
        if (this.#cursor === 0) return { kind: "none" };
        this.#draft = this.#draft.slice(0, this.#cursor - 1) + this.#draft.slice(this.#cursor);
        this.#cursor -= 1;
        return { kind: "edit" };
      }
      case "enter":
        // 空行（含纯空白）忽略；非空提交原文并自清草稿。
        if (this.#draft.trim().length === 0) return { kind: "none" };
        {
          const line = this.#draft;
          this.clear();
          return { kind: "submit", line };
        }
      case "left":
        if (this.#cursor > 0) {
          this.#cursor -= 1;
          return { kind: "edit" };
        }
        return { kind: "none" };
      case "right":
        if (this.#cursor < this.#draft.length) {
          this.#cursor += 1;
          return { kind: "edit" };
        }
        return { kind: "none" };
      case "home":
        if (this.#cursor !== 0) {
          this.#cursor = 0;
          return { kind: "edit" };
        }
        return { kind: "none" };
      case "end":
        if (this.#cursor !== this.#draft.length) {
          this.#cursor = this.#draft.length;
          return { kind: "edit" };
        }
        return { kind: "none" };
      case "ctrl": {
        switch (key.char) {
          case "c":
            // 非空=清空草稿（撤销重敲）；空=退出 REPL。
            if (this.#draft.length > 0) {
              this.clear();
              return { kind: "edit" };
            }
            return { kind: "exit", key: "ctrl-c" };
          case "d":
            // EOF 语义：退出并弃稿。
            this.clear();
            return { kind: "exit", key: "ctrl-d" };
          case "e":
            // 长文本外编桥：草稿保留，由主回路执行 editPromptCommand 回填。
            return { kind: "external-edit" };
          default:
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

/** REPL 提示行组件：底部行渲染 `❯ {草稿}`；回合在飞时隐藏（状态行透出）。 */
class PromptView implements Component {
  #draft = "";
  #active = true;

  /** 更新草稿并置于可见态（编辑态每次变化调用）。 */
  update(draft: string): void {
    this.#draft = draft;
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
    term.write(0, term.rows - 1, `❯ ${this.#draft}`);
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
  const editor = new LineEditor();
  const prompt = new PromptView();

  if (session.sessionId === undefined) await session.start(options.title ?? "bi repl");
  session.app.push(prompt);
  prompt.update(editor.draft);
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
      prompt.activate(); // 回到提示行
      session.app.render();
    });
  };

  const iterator = keys[Symbol.asyncIterator]();
  try {
    let next = await iterator.next();
    while (next.done !== true) {
      const key: ParsedKey = next.value;

      // 会话已退出（Esc 二段终态）：REPL 同步终场。
      if (stateOf(session) === "exited") {
        endedAs = "session-exited";
        break;
      }

      // 审批浮层在栈顶：全部键交 TuiApp 派发（浮层消费 y/n/Esc，其余落空）。
      if (stateOf(session) === "awaiting-approval") {
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
        // 编辑态（idle）：行编辑器裁决。
        const action = editor.feed(key);
        if (action.kind === "edit") {
          prompt.update(editor.draft);
          onPrompt(editor.draft);
          session.app.render();
        } else if (action.kind === "submit") {
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
          const outcome = await editPromptCommand(editor.draft, { editor: editBridge });
          if (outcome.status === "submitted") {
            editor.replaceAll(outcome.text.trimEnd()); // 编辑器补写的尾部换行属噪音
          }
          prompt.update(editor.draft);
          onPrompt(editor.draft);
          session.app.render();
        }
        // none：空 Enter/无关键落空。
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
