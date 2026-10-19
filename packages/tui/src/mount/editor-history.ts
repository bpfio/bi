/**
 * editor-history —— D7 · 编辑器体感强化（提案 C 编辑器体感）：Emacs 式
 * KillRing / UndoStack 与字素级 word 导航。纯逻辑，零新增依赖（Intl.Segmenter
 * 为运行时内置）。吸收 kimi kill-ring.ts / undo-stack.ts / word-navigation.ts
 * 语义（仅阅读锚点，bi 侧重实现；不引新依赖）。
 *
 * - KillRing：kill（删除）文本入环；连续同方向 kill 可累积为单条目；yank 取
 *   最近一条，rotate 轮换（yank-pop 备用，本卡暂不接键位）；
 * - UndoStack：克隆式快照栈，pop 即还原；
 * - findWordBackward / findWordForward：readline 惯例子集——跳过空白后跨过非空白
 *   连续段（CJK 无空白则整段视为单"词"，与字素粒度一致）。
 */

/** Emacs 式 kill ring：保存被删文本，支持连续累积与 yank 轮换。 */
export class KillRing {
  #ring: string[] = [];

  /**
   * 入环。accumulate=true 时与最近一条合并（前置或追加），否则新建一条。
   * 空文本不入环。
   */
  push(text: string, opts: { prepend: boolean; accumulate?: boolean }): void {
    if (text.length === 0) return;
    if (opts.accumulate && this.#ring.length > 0) {
      const last = this.#ring.pop()!;
      this.#ring.push(opts.prepend ? text + last : last + text);
    } else {
      this.#ring.push(text);
    }
  }

  /** 取最近一条（不修改环）。 */
  peek(): string | undefined {
    return this.#ring.length > 0 ? this.#ring[this.#ring.length - 1] : undefined;
  }

  /** 把最近一条移到环首（yank-pop 轮换；环长 ≤1 无操作）。 */
  rotate(): void {
    if (this.#ring.length > 1) {
      const last = this.#ring.pop()!;
      this.#ring.unshift(last);
    }
  }

  get length(): number {
    return this.#ring.length;
  }
}

/** 泛型撤销栈：克隆式快照；pop 直接返回已脱离的快照。 */
export class UndoStack<S> {
  #stack: S[] = [];

  /** 压入状态克隆快照（浅克隆即可；本卡状态为 { draft, cursor } 纯原始值）。 */
  push(state: S): void {
    this.#stack.push({ ...state } as S);
  }

  /** 弹出最近快照（空栈返回 undefined）。 */
  pop(): S | undefined {
    return this.#stack.pop();
  }

  /** 清空。 */
  clear(): void {
    this.#stack.length = 0;
  }

  get length(): number {
    return this.#stack.length;
  }
}

function isWhitespaceChar(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

/**
 * 从 cursor 起向左跳一个词：先跳过尾部空白，再回退过一个非空白连续段。
 * 光标已在最左或左侧无内容则返回 0。纯函数。
 */
export function findWordBackward(text: string, cursor: number): number {
  if (cursor <= 0) return 0;
  let i = cursor;
  while (i > 0 && isWhitespaceChar(text[i - 1]!)) i -= 1; // 跳过尾部空白
  while (i > 0 && !isWhitespaceChar(text[i - 1]!)) i -= 1; // 回退一个词
  return i;
}

/**
 * 从 cursor 起向右跳一个词：先跳过头部空白，再前进过一个非空白连续段。
 * 光标已在最右或右侧无内容则返回 text.length。纯函数。
 */
export function findWordForward(text: string, cursor: number): number {
  if (cursor >= text.length) return text.length;
  let i = cursor;
  while (i < text.length && isWhitespaceChar(text[i]!)) i += 1; // 跳过头部空白
  while (i < text.length && !isWhitespaceChar(text[i]!)) i += 1; // 前进一个词
  return i;
}
