/**
 * DiffRenderer —— 双缓冲差分渲染器 + InputLoop 按键解析。
 *
 * BI-19 合约（Kimi Code 增强 pi-tui 底座 · 重实现，未读取任何参考源码）：
 * - 双缓冲：front（已渲染基线）/ back（草稿）；begin()..end() 之间组件画到 back；
 *   end() 计算 front vs back 行级差分 → 最小 ANSI 输出：跳过 unchanged 行；
 *   changed 行 = CUP `\x1b[{row};1H`（row 为 1 基）+ 该行内容 + 行尾清除 `\x1b[K`；
 *   erase 行 = CUP + `\x1b[K`；随后 front/back 交换；
 * - CPU 特性：全帧重渲但内容相同时，end() 不产生任何输出字节；
 * - resize(rows, cols) 尺寸协商（下一帧强制全量重绘）；Writer 注入（测试用内存缓冲）；
 * - InputLoop：解析按键字节流（普通字符、ESC 序列、方向键/PgUp/PgDn/Home/End/
 *   Tab/Enter/BackSpace/Ctrl 字母），回调 onKey(ParsedKey)；ESC 歧义超时拆包——
 *   ESC 单独到达 30ms 无后续 = ESC 键（时钟+调度器注入）；粘贴检测委托 PasteBurst。
 */

import { VirtualTerminal } from "./virtual-terminal";
import type { FrameOp } from "./virtual-terminal";
import { PasteBurst } from "./paste-burst";
import type { Clock, Scheduler, Timer } from "./paste-burst";
import { defaultClock, defaultScheduler } from "./paste-burst";

/** 最小写入接口（Node/Bun WriteStream 或内存缓冲均可注入）。 */
export interface Writer {
  write(data: string): void;
}

/** 解析后的按键。paste 事件由 PasteBurst 聚合产生，text 为整段粘贴文本。
 * wheel-up/wheel-down（BI-27.5）为 SGR 鼠标滚轮上报（1000/1006 模式）。 */
export interface ParsedKey {
  kind:
    | "char"
    | "enter"
    | "tab"
    | "backspace"
    | "esc"
    | "up"
    | "down"
    | "left"
    | "right"
    | "pageup"
    | "pagedown"
    | "home"
    | "end"
    | "ctrl"
    | "paste"
    | "wheel-up"
    | "wheel-down";
  /** kind === "char" 时的字符；kind === "ctrl" 时的字母（小写）。 */
  char?: string;
  /** kind === "paste" 时的聚合文本。 */
  text?: string;
}

/** ESC 歧义消解超时（毫秒）：单独到达的 ESC 等待该时长后判定为 ESC 键。 */
export const ESC_ALONE_TIMEOUT_MS = 30;

// ---------------------------------------------------------------------------
// ANSI 序列常量（合约固定格式）
// ---------------------------------------------------------------------------

/** 光标行定位（row 为 1 基，列 1）。 */
export function cup(row1Based: number): string {
  return `\x1b[${row1Based};1H`;
}

/** 行尾清除（EL0，光标起至行末）。 */
export const EL = "\x1b[K";

// SGR 样式发射（BI-27.3）：网格单元携带 fg/bg/bold/dim/italic 时按最小 SGR
// 差量发射；无样式行字节面与旧契约完全一致（纯文本 + EL）。

/** 前景色名 → SGR 编号（30-37 基本色；未知色名忽略，网格安全）。 */
const SGR_FG: Record<string, string> = {
  black: "30",
  red: "31",
  green: "32",
  yellow: "33",
  blue: "34",
  magenta: "35",
  cyan: "36",
  white: "37",
};

/** 背景色名 → SGR 编号（40-47）。 */
const SGR_BG: Record<string, string> = {
  black: "40",
  red: "41",
  green: "42",
  yellow: "43",
  blue: "44",
  magenta: "45",
  cyan: "46",
  white: "47",
};

/** SGR 复位。 */
const SGR_RESET = "\x1b[0m";

/** 单元样式 → SGR 序列（无任何样式返回 null）。 */
function sgrOf(fg?: string, bg?: string, bold?: boolean, dim?: boolean, italic?: boolean): string | null {
  const params: string[] = [];
  if (bold) params.push("1");
  if (dim) params.push("2");
  if (italic) params.push("3");
  if (fg !== undefined) {
    const code = SGR_FG[fg];
    if (code !== undefined) params.push(code);
  }
  if (bg !== undefined) {
    const code = SGR_BG[bg];
    if (code !== undefined) params.push(code);
  }
  return params.length === 0 ? null : `\x1b[${params.join(";")}m`;
}

/** 单元样式等价键（同一运行合并；与 rowEquals 同字段集）。 */
function styleKey(fg?: string, bg?: string, bold?: boolean, dim?: boolean, italic?: boolean): string {
  return `${fg ?? ""}|${bg ?? ""}|${bold ? 1 : 0}|${dim ? 1 : 0}|${italic ? 1 : 0}`;
}

/** 差分渲染器：双缓冲 + 最小 ANSI 输出。 */
export class DiffRenderer {
  private readonly out: Writer;
  private rows: number;
  private cols: number;
  /** 已渲染基线；null 表示尚未渲染过任何帧（终端基线为全空白）。 */
  private front: VirtualTerminal | null = null;
  private back: VirtualTerminal;

  constructor(out: Writer, rows: number = 24, cols: number = 80) {
    this.out = out;
    this.rows = rows;
    this.cols = cols;
    this.back = new VirtualTerminal(rows, cols);
  }

  /** 开始一帧：返回草稿缓冲，组件把内容画进去（幂等；缓冲在 end() 交换后本就是全新空白）。 */
  begin(): VirtualTerminal {
    return this.back;
  }

  /** 结束一帧：差分 back vs front → 最小 ANSI 输出 → swap。changed 行按单元
   * 样式发射 SGR 运行（BI-27.3）；无样式行输出与旧契约逐字节一致。 */
  end(): void {
    const ops = this.computeOps();
    let payload = "";
    for (const op of ops) {
      if (op.kind === "unchanged") continue;
      payload += cup(op.row + 1);
      if (op.kind === "changed") payload += this.renderStyledRow(op.row);
      payload += EL;
    }
    if (payload.length > 0) this.out.write(payload);
    this.front = this.back;
    this.back = new VirtualTerminal(this.rows, this.cols);
  }

  /** 渲染目标行：按连续同样式单元分段发射 SGR；纯文本行退化为 rowText 等价。 */
  private renderStyledRow(row: number): string {
    const cells = this.back.rowCells(row);
    let out = "";
    let activeKey: string | null = null; // 当前 SGR 运行样式键；null = 无样式
    let styled = false; // 本行是否发射过任何 SGR（行尾复位判定）
    for (const cell of cells) {
      if (cell.wideTail) continue; // 宽字符右半延续：与 rowText 同步跳过
      const key = styleKey(cell.fg, cell.bg, cell.bold, cell.dim, cell.italic);
      if (key !== activeKey) {
        if (activeKey !== null && activeKey !== styleKey(undefined)) out += SGR_RESET;
        const sgr =
          key === styleKey(undefined)
            ? null
            : sgrOf(cell.fg, cell.bg, cell.bold, cell.dim, cell.italic);
        if (sgr !== null) {
          out += sgr;
          styled = true;
        }
        activeKey = key;
      }
      out += cell.char;
    }
    if (styled) out += SGR_RESET; // 行尾复位，SGR 不越过 EL/CUP 泄漏到后续行
    return out;
  }

  /** 差分计算：首帧只绘非空行（终端基线即空白）；后续帧全行三态差分。 */
  private computeOps(): FrameOp[] {
    if (this.front === null) {
      const ops: FrameOp[] = [];
      for (let y = 0; y < this.rows; y++) {
        if (this.back.isRowBlank(y)) continue;
        ops.push({ kind: "changed", row: y, text: this.back.rowText(y) });
      }
      return ops;
    }
    return this.front.diff(this.back);
  }

  /** 终端尺寸协商：重建双缓冲，下一帧强制全量重绘。 */
  resize(rows: number, cols: number): void {
    this.rows = rows;
    this.cols = cols;
    this.front = null;
    this.back = new VirtualTerminal(rows, cols);
  }
}

// ---------------------------------------------------------------------------
// InputLoop —— 字节流 → 按键
// ---------------------------------------------------------------------------

/** ESC 字节。 */
const ESC = 0x1b;

/** InputLoop：从异步字节流解析按键并回调；测试可经 pump() 离屏驱动。 */
export class InputLoop {
  private readonly reader: AsyncIterable<Uint8Array>;
  private readonly onKey: (key: ParsedKey) => void;
  private readonly clock: Clock;
  private readonly scheduler: Scheduler;

  /** 节奏看门狗：粘贴聚合 → paste 键；正常字节 → parseRun。 */
  private readonly burst: PasteBurst;

  private running = false;
  private stopped = false;

  /** UTF-8 流式解码器：跨块保持不完整多字节序列状态。 */
  private readonly decoder = new TextDecoder("utf-8");

  /** 以 ESC 开头的悬挂序列（等待歧义消解或续接）。 */
  private escHold: number[] = [];
  /** 悬挂 ESC 首字节到达时刻。 */
  private escAt = Number.NEGATIVE_INFINITY;
  private escTimer: Timer | null = null;

  constructor(
    reader: AsyncIterable<Uint8Array>,
    onKey: (key: ParsedKey) => void,
    clock: Clock = defaultClock,
    scheduler: Scheduler = defaultScheduler,
  ) {
    this.reader = reader;
    this.onKey = onKey;
    this.clock = clock;
    this.scheduler = scheduler;
    this.burst = new PasteBurst({
      onBytes: (bytes) => this.parseRun(bytes),
      onPaste: (text) => this.onKey({ kind: "paste", text }),
      clock,
      scheduler,
    });
  }

  /** 开始消费 reader（幂等保护；异常不外抛）。 */
  start(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    void this.consume();
  }

  private async consume(): Promise<void> {
    try {
      for await (const chunk of this.reader) {
        if (this.stopped) break;
        this.pump(chunk);
      }
    } catch {
      // reader 异常（含正常关闭时的 return）按停止处理，不向 UI 层外抛。
    } finally {
      this.running = false;
    }
  }

  /** 停止消费：结算挂起状态（粘贴自然结算、ESC 按 ESC 键结算）。 */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.burst.dispose();
    this.settleEsc();
  }

  /**
   * 离屏驱动入口：喂入一块原始字节（等价真实 reader 的单次读取）。
   * 字节先过 PasteBurst 节奏门，再进按键解析状态机。
   */
  pump(chunk: Uint8Array): void {
    if (this.stopped) return;
    this.burst.feed(chunk);
  }

  /** 观察用：是否正处粘贴聚合中。 */
  get pasting(): boolean {
    return this.burst.pasting;
  }

  // -- 字节运行解析 ---------------------------------------------------------

  private parseRun(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const now = this.clock.now();
    if (this.escHold.length > 0) {
      const elapsed = now - this.escAt;
      if (elapsed <= ESC_ALONE_TIMEOUT_MS) {
        // 30ms 内续接：拼回悬挂序列继续匹配（ESC 跨块序列）。
        this.cancelEscTimer();
        const held = Uint8Array.from(this.escHold);
        this.escHold = [];
        const merged = new Uint8Array(held.length + bytes.length);
        merged.set(held, 0);
        merged.set(bytes, held.length);
        this.consumeRun(merged, now);
        return;
      }
      // 超过 30ms：悬挂序列按超时结算（ESC 键 + 残余按普通键），再解析新块。
      this.settleEsc();
    }
    this.consumeRun(bytes, now);
  }

  private consumeRun(bytes: Uint8Array, now: number): void {
    let i = 0;
    while (i < bytes.length) {
      const b = bytes[i] as number;
      if (this.escHold.length > 0) {
        i = this.extendEsc(b, bytes, i, now);
        continue;
      }
      if (b === ESC) {
        this.escHold = [b];
        this.escAt = now;
        i += 1;
        continue;
      }
      this.emitByteAsKey(b);
      i += 1;
    }
    // 运行结束仍悬挂：排定 30ms 歧义消解定时器。
    if (this.escHold.length > 0) this.armEscTimer();
  }

  /**
   * 悬挂 ESC 序列续接。返回消耗后的下一个字节下标。
   * - `ESC [` → CSI 收集（参数/中间字节 0x20-0x3F，终结字节 0x40-0x7E）；
   * - `ESC O` → SS3，下一字节定键；
   * - 其他字节 → ESC + 随机字节：按 ESC 键处理，该字节重新按普通键解析。
   */
  private extendEsc(b: number, bytes: Uint8Array, i: number, now: number): number {
    if (this.escHold.length === 1) {
      if (b === 0x5b) {
        // '[' → CSI
        this.escHold.push(b);
        return i + 1;
      }
      if (b === 0x4f) {
        // 'O' → SS3
        this.escHold.push(b);
        return i + 1;
      }
      if (b === ESC) {
        // ESC + ESC：前一个 ESC 单独成键，新的 ESC 重新开始悬挂。
        this.settleEsc();
        this.escHold = [b];
        this.escAt = now;
        return i + 1;
      }
      // ESC + 其他字节：ESC 单独成键，该字节按普通键重新解析。
      this.settleEsc();
      this.emitByteAsKey(b);
      return i + 1;
    }
    if (this.escHold[1] === 0x5b) {
      if (b >= 0x20 && b <= 0x3f) {
        this.escHold.push(b);
        return i + 1;
      }
      if (b >= 0x40 && b <= 0x7e) {
        this.escHold.push(b);
        this.dispatchCsi();
        return i + 1;
      }
      // CSI 内混入控制字节/ESC：序列作废，该字节重新解析（可能是新 ESC）。
      this.escHold = [];
      return i;
    }
    // SS3：固定两字节后缀。
    this.dispatchSs3(b);
    return i + 1;
  }

  /** CSI 终结分发：`this.escHold` = [ESC, '[', ...params, final]。 */
  private dispatchCsi(): void {
    const hold = this.escHold;
    this.escHold = [];
    const finalByte = hold[hold.length - 1] as number;
    const params = String.fromCharCode(...hold.slice(2, hold.length - 1));
    // SGR 鼠标上报（BI-27.5，1000/1006 模式）：`ESC [ < btn ; col ; row M`。
    // 滚轮 64=上 / 65=下，仅在按下终字 'M' 分发；其余按键/松开（'m'）忽略。
    if (finalByte === 0x4d && params.startsWith("<")) {
      const btn = params.slice(1).split(";")[0];
      if (btn === "64") this.onKey({ kind: "wheel-up" });
      else if (btn === "65") this.onKey({ kind: "wheel-down" });
      return; // 点击/拖拽等其余按钮码：合约按键集之外，忽略
    }
    let key: ParsedKey["kind"] | null = null;
    switch (finalByte) {
      case 0x41: // A
        key = "up";
        break;
      case 0x42: // B
        key = "down";
        break;
      case 0x43: // C
        key = "right";
        break;
      case 0x44: // D
        key = "left";
        break;
      case 0x48: // H
        key = "home";
        break;
      case 0x46: // F
        key = "end";
        break;
      case 0x7e: // '~'
        key = csiTildeKey(params);
        break;
      default:
        key = null; // Delete(3~)、F1-F4 等：合约按键集之外，忽略。
    }
    if (key !== null) this.onKey({ kind: key });
  }

  /** SS3 后缀分发：ESC O <byte>。 */
  private dispatchSs3(b: number): void {
    this.escHold = [];
    switch (b) {
      case 0x41:
        this.onKey({ kind: "up" });
        break;
      case 0x42:
        this.onKey({ kind: "down" });
        break;
      case 0x43:
        this.onKey({ kind: "right" });
        break;
      case 0x44:
        this.onKey({ kind: "left" });
        break;
      case 0x48:
        this.onKey({ kind: "home" });
        break;
      case 0x46:
        this.onKey({ kind: "end" });
        break;
      default:
        break; // P/Q/R/S（F1-F4）等：合约按键集之外，忽略。
    }
  }

  /** 30ms 歧义消解定时器。 */
  private armEscTimer(): void {
    this.cancelEscTimer();
    this.escTimer = this.scheduler.schedule(ESC_ALONE_TIMEOUT_MS, () => {
      this.escTimer = null;
      this.settleEsc();
    });
  }

  private cancelEscTimer(): void {
    if (this.escTimer !== null) {
      this.escTimer.cancel();
      this.escTimer = null;
    }
  }

  /** 结算悬挂 ESC：ESC → esc 键；残余字节按普通键逐个解析（best-effort）。 */
  private settleEsc(): void {
    this.cancelEscTimer();
    if (this.escHold.length === 0) return;
    const held = this.escHold;
    this.escHold = [];
    this.onKey({ kind: "esc" });
    for (let i = 1; i < held.length; i++) {
      this.emitByteAsKey(held[i] as number);
    }
  }

  /** 单字节 → 按键（控制字节 / 可打印 ASCII / UTF-8 多字节续传）。 */
  private emitByteAsKey(b: number): void {
    switch (b) {
      case 0x0d: // CR —— raw 模式下 Enter 主形态
      case 0x0a: // LF
        this.onKey({ kind: "enter" });
        return;
      case 0x09:
        this.onKey({ kind: "tab" });
        return;
      case 0x7f: // DEL —— Backspace 主形态
        this.onKey({ kind: "backspace" });
        return;
      default:
        break;
    }
    if (b >= 0x01 && b <= 0x1a) {
      // Ctrl+字母（0x01..0x1A → a..z；Tab/LF/CR 已提前处理）。
      this.onKey({ kind: "ctrl", char: String.fromCharCode(0x60 + b) });
      return;
    }
    if (b < 0x20 || b === 0x7f) return; // 其余控制字节（0x00、0x1C-0x1F…）：忽略
    if (b < 0x80) {
      this.onKey({ kind: "char", char: String.fromCharCode(b) });
      return;
    }
    // UTF-8 多字节：流式喂解码器，完成即发出（跨块不完整序列由解码器保持）。
    const text = this.decoder.decode(Uint8Array.of(b), { stream: true });
    for (const ch of text) {
      this.onKey({ kind: "char", char: ch });
    }
  }
}

/** CSI `~` 结尾序列的参数 → 按键（1~/4~ Home/End，5~/6~ PgUp/PgDn）。 */
function csiTildeKey(params: string): ParsedKey["kind"] | null {
  switch (params) {
    case "1":
      return "home";
    case "4":
      return "end";
    case "5":
      return "pageup";
    case "6":
      return "pagedown";
    default:
      return null; // 3~(Delete)、2~(Insert) 等：合约按键集之外。
  }
}
