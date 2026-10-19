/**
 * VirtualTerminal —— 离屏终端仿真（字符网格）。
 *
 * BI-19 合约（Kimi Code 增强 pi-tui 底座 · 重实现，未读取任何参考源码）：
 * - 维护 rows×cols 的字符网格 Cell { char, fg?, bg?, bold?, dim? }；
 * - `write(x, y, text, style?)` 按 CJK 宽度放置字符（宽字符占两格，第二格为
 *   延续占位；被部分覆盖的宽字符退化为空格，模拟真实终端行为）；
 * - `scroll(n)` 上滚 n 行（顶部消失，底部补空白）；
 * - `toString()` 剥离样式输出纯文本（测试断言用）；
 * - `diff(other)` 行级差分 → FrameOp[]：描述「把当前网格变为 other」的操作，
 *   row 为 0 基网格行号。unchanged / changed（携带目标行文本）/ erase（目标行为空行）。
 *
 * 渲染测试一律基于本仿真器离屏进行，不开真实 TTY。
 */

import { charWidth } from "../components/cjk-width";

/** 单个字符单元的样式与内容。 */
export interface Cell {
  char: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  /** 斜体（BI-27.3 富文本转录；DiffRenderer 发射 SGR 3）。 */
  italic?: boolean;
  /** 内部标记：该格是前一格宽字符的右半延续（toString 与渲染时跳过）。 */
  wideTail?: boolean;
}

/** 写入样式（除字符外的 Cell 字段）。 */
export type CellStyle = Omit<Cell, "char" | "wideTail">;

/** 行级差分操作类型。row 为 0 基行号；changed.text 为目标行纯文本。 */
export type FrameOp =
  | { kind: "unchanged"; row: number }
  | { kind: "changed"; row: number; text: string }
  | { kind: "erase"; row: number };

/** 空白单元格。 */
function blankCell(): Cell {
  return { char: " " };
}

export class VirtualTerminal {
  readonly rows: number;
  readonly cols: number;
  private grid: Cell[][];

  constructor(rows: number, cols: number) {
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows <= 0 || cols <= 0) {
      throw new RangeError(`VirtualTerminal 尺寸非法: rows=${rows}, cols=${cols}`);
    }
    this.rows = rows;
    this.cols = cols;
    this.grid = VirtualTerminal.makeGrid(rows, cols);
  }

  private static makeGrid(rows: number, cols: number): Cell[][] {
    const grid: Cell[][] = [];
    for (let y = 0; y < rows; y++) {
      const row: Cell[] = new Array(cols);
      for (let x = 0; x < cols; x++) row[x] = blankCell();
      grid.push(row);
    }
    return grid;
  }

  /** 把 text 写入 (x, y) 起点；text 中可含 \n（换行回到 x=0 的下一行）。越界部分丢弃。 */
  write(x: number, y: number, text: string, style?: CellStyle): void {
    let cx = Math.trunc(x);
    let cy = Math.trunc(y);
    // 本次写入中最近一个已放置可见字符的宿主格（组合字符附着目标）。
    let hostX = -1;
    let hostY = -1;
    for (const ch of text) {
      if (ch === "\n") {
        cx = 0;
        cy += 1;
        hostX = -1;
        continue;
      }
      if (ch === "\r" || ch === "\t") continue; // 网格模型不支持回车/制表推进
      if (cy < 0 || cy >= this.rows) return; // 换行越出底部即停止写入
      if (cx >= this.cols) continue; // 行尾溢出丢弃该字符
      const w = charWidth(ch);
      if (w === 0) {
        // 组合/零宽字符：附着到本次写入的前一个宿主字符上；无宿主则丢弃。
        if (hostX >= 0) {
          const host = this.grid[hostY]![hostX]!;
          if (!host.wideTail) host.char += ch;
        }
        continue;
      }
      if (w === 2 && cx + 1 >= this.cols) {
        // 宽字符放不进剩余两列：退化为空格（真实终端同款行为）。
        this.putCell(cx, cy, { char: " ", ...style });
        cx += 1;
        hostX = -1;
        continue;
      }
      this.prepareCellForOverwrite(cx, cy);
      this.putCell(cx, cy, { char: ch, ...style });
      if (w === 2) {
        this.prepareCellForOverwrite(cx + 1, cy);
        this.putCell(cx + 1, cy, { char: " ", ...style, wideTail: true });
        hostX = cx;
        hostY = cy;
        cx += 2;
      } else {
        hostX = cx;
        hostY = cy;
        cx += 1;
      }
    }
  }

  /** 覆盖前清理悬挂宽字符：命中宽头则清右半，命中宽尾则清左半。 */
  private prepareCellForOverwrite(x: number, y: number): void {
    const row = this.grid[y]!;
    const target = row[x]!;
    if (target.wideTail && x > 0) {
      const head = row[x - 1]!;
      if (!head.wideTail && charWidth(head.char) === 2) row[x - 1] = blankCell();
    } else if (!target.wideTail && charWidth(target.char) === 2) {
      const tail = row[x + 1];
      if (tail && tail.wideTail) row[x + 1] = blankCell();
    }
  }

  private putCell(x: number, y: number, cell: Cell): void {
    this.grid[y]![x] = cell;
  }

  /** 读取某行（返回该行单元格数组的副本引用集，测试与调试用）。 */
  rowCells(row: number): readonly Cell[] {
    this.assertRow(row);
    return [...this.grid[row]!];
  }

  /** 某行剥掉宽尾占位后的纯文本。 */
  rowText(row: number): string {
    this.assertRow(row);
    let out = "";
    for (const cell of this.grid[row]!) {
      if (cell.wideTail) continue;
      out += cell.char;
    }
    return out;
  }

  /** 行是否为纯空白。 */
  isRowBlank(row: number): boolean {
    this.assertRow(row);
    for (const cell of this.grid[row]!) {
      if (cell.wideTail) continue;
      if (cell.char !== " ") return false;
    }
    return true;
  }

  private assertRow(row: number): void {
    if (!Number.isInteger(row) || row < 0 || row >= this.rows) {
      throw new RangeError(`行号越界: ${row} (rows=${this.rows})`);
    }
  }

  /** 上滚 n 行：顶部 n 行消失，底部补空白。n<=0 无操作，n>=rows 等价 clear。 */
  scroll(n: number): void {
    const k = Math.trunc(n);
    if (k <= 0) return;
    if (k >= this.rows) {
      this.clear();
      return;
    }
    const blankRows = VirtualTerminal.makeGrid(k, this.cols);
    this.grid = [...this.grid.slice(k), ...blankRows];
  }

  /** 清空整屏为空白。 */
  clear(): void {
    this.grid = VirtualTerminal.makeGrid(this.rows, this.cols);
  }

  /** 样式剥离的整屏文本（行间 \n 连接，行宽恒等于 cols，不裁尾随空格）。 */
  toString(): string {
    const lines: string[] = [];
    for (let y = 0; y < this.rows; y++) lines.push(this.rowText(y));
    return lines.join("\n");
  }

  /** 两行内容+样式是否完全一致。 */
  private rowEquals(other: VirtualTerminal, row: number): boolean {
    const a = this.grid[row]!;
    const b = other.grid[row]!;
    for (let x = 0; x < this.cols; x++) {
      const ca = a[x]!;
      const cb = b[x]!;
      if (ca.char !== cb.char) return false;
      if (ca.fg !== cb.fg || ca.bg !== cb.bg) return false;
      if ((ca.bold ?? false) !== (cb.bold ?? false)) return false;
      if ((ca.dim ?? false) !== (cb.dim ?? false)) return false;
      if ((ca.italic ?? false) !== (cb.italic ?? false)) return false;
      if ((ca.wideTail ?? false) !== (cb.wideTail ?? false)) return false;
    }
    return true;
  }

  /**
   * 行级差分：返回把当前网格（源/front）变为 other（目标/back）的操作序列。
   * - 源行与目标行一致 → unchanged；
   * - 目标行为纯空白且源行非空白 → erase；
   * - 其余 → changed（text 为目标行纯文本，供 CUP+内容+EL 输出）。
   */
  diff(other: VirtualTerminal): FrameOp[] {
    if (other.rows !== this.rows || other.cols !== this.cols) {
      throw new RangeError(
        `diff 尺寸不匹配: this=${this.rows}x${this.cols}, other=${other.rows}x${other.cols}`,
      );
    }
    const ops: FrameOp[] = [];
    for (let y = 0; y < this.rows; y++) {
      if (this.rowEquals(other, y)) {
        ops.push({ kind: "unchanged", row: y });
      } else if (other.isRowBlank(y)) {
        ops.push({ kind: "erase", row: y });
      } else {
        ops.push({ kind: "changed", row: y, text: other.rowText(y) });
      }
    }
    return ops;
  }
}
