/**
 * merman/canvas —— 字符网格画布。
 *
 * BI-19.6 合约：cols x rows 字符网格，setCell / text / box(边框) / arrow(正交
 * 折线) / render(): string[]。宽度计算复用 components/cjk-width（CJK 全角占
 * 两格、零宽字符跳过）。所有越界写入静默忽略（画布即视口）。
 */

import { textWidth } from "../components/cjk-width";

/** 宽字符的第二格占位标记：render 时跳过，保证 CJK 恰占两列。 */
const CONT = "\0";

export type BoxShape = "rect" | "rounded" | "diamond";

export interface BoxOpts {
  shape?: BoxShape;
  label?: string;
}

export interface ArrowOpts {
  /** "h" = 先横后竖（落点竖直进入），"v" = 先竖后横（落点水平进入）。缺省按长轴自适应。 */
  route?: "h" | "v";
}

/** 各形状四角字符：[左上, 右上, 左下, 右下]。 */
const CORNERS: Record<BoxShape, readonly [string, string, string, string]> = {
  rect: ["┌", "┐", "└", "┘"],
  rounded: ["╭", "╮", "╰", "╯"],
  diamond: ["◇", "◇", "◇", "◇"],
};

export class Canvas {
  readonly cols: number;
  readonly rows: number;
  readonly #cells: string[][];

  constructor(cols: number, rows: number) {
    this.cols = Math.max(1, Math.floor(cols));
    this.rows = Math.max(1, Math.floor(rows));
    this.#cells = [];
    for (let y = 0; y < this.rows; y++) {
      this.#cells.push(new Array<string>(this.cols).fill(" "));
    }
  }

  #inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.cols && y < this.rows;
  }

  /** 单格写入：取传入串的首个码点；越界静默忽略。 */
  setCell(x: number, y: number, ch: string): void {
    if (!this.#inBounds(x, y)) return;
    const c = [...ch][0] ?? " ";
    this.#cells[y]![x] = c;
  }

  /** 文本写入：按码点游走，CJK 宽字符占两格（第二格置 CONT），零宽字符跳过。 */
  text(x: number, y: number, s: string): void {
    let cx = x;
    for (const ch of s) {
      const w = textWidth(ch);
      if (w <= 0) continue;
      if (w === 1) {
        if (this.#inBounds(cx, y)) this.#cells[y]![cx] = ch;
        cx += 1;
      } else {
        if (cx >= 0 && cx + 1 < this.cols && y >= 0 && y < this.rows) {
          this.#cells[y]![cx] = ch;
          this.#cells[y]![cx + 1] = CONT;
        }
        cx += 2;
      }
    }
  }

  /** 文本显示宽度（终端列数）。 */
  static width(s: string): number {
    return textWidth(s);
  }

  /** 画边框盒：w/h 含边框；label 居中嵌入上边框（两侧至少各留 1 格横线）。 */
  box(x: number, y: number, w: number, h: number, opts?: BoxOpts): void {
    if (w < 2 || h < 2) return;
    const shape = opts?.shape ?? "rect";
    const [tl, tr, bl, br] = CORNERS[shape]!;
    const right = x + w - 1;
    const bottom = y + h - 1;
    this.setCell(x, y, tl);
    this.setCell(right, y, tr);
    this.setCell(x, bottom, bl);
    this.setCell(right, bottom, br);
    for (let i = x + 1; i < right; i++) {
      this.setCell(i, y, "─");
      this.setCell(i, bottom, "─");
    }
    for (let j = y + 1; j < bottom; j++) {
      this.setCell(x, j, "│");
      this.setCell(right, j, "│");
    }
    const label = opts?.label;
    if (label !== undefined) {
      const lw = textWidth(label);
      if (lw > 0 && lw <= w - 4) {
        // 标签嵌在盒内中部行（h=3 时即中间行）
        const labelRow = Math.min(y + Math.max(1, Math.floor((h - 1) / 2)), bottom - 1);
        this.text(x + Math.floor((w - lw) / 2), labelRow, label);
      }
    }
  }

  /**
   * 正交折线箭头：(x1,y1) → (x2,y2)，箭头头部落在 (x2,y2) 指向目标。
   * 同行/同列走直线；否则 L 形：route "h" 先横后竖（角在 (x2,y1)），
   * route "v" 先竖后横（角在 (x1,y2)）。线段 ─/│，转角 +。
   */
  arrow(x1: number, y1: number, x2: number, y2: number, opts?: ArrowOpts): void {
    if (x1 === x2 && y1 === y2) return;
    const route = opts?.route ?? (Math.abs(x2 - x1) >= Math.abs(y2 - y1) ? "h" : "v");
    if (y1 === y2) {
      this.#walkH(x1, x2, y1);
      this.#head(x2, y2, x2 > x1 ? ">" : "<");
      return;
    }
    if (x1 === x2) {
      this.#walkV(x1, y1, y2);
      this.#head(x2, y2, y2 > y1 ? "v" : "^");
      return;
    }
    const dx = x2 > x1 ? 1 : -1;
    const dy = y2 > y1 ? 1 : -1;
    if (route === "h") {
      this.#walkH(x1, x2, y1);
      this.setCell(x2, y1, "+");
      let cy = y1 + dy;
      while (cy !== y2) {
        this.setCell(x2, cy, "│");
        cy += dy;
      }
      this.#head(x2, y2, dy > 0 ? "v" : "^");
    } else {
      this.#walkV(x1, y1, y2);
      this.setCell(x1, y2, "+");
      let cx = x1 + dx;
      while (cx !== x2) {
        this.setCell(cx, y2, "─");
        cx += dx;
      }
      this.#head(x2, y2, dx > 0 ? ">" : "<");
    }
  }

  /** 从 xa 向 xb 行走画横线（不含终点 xb）。 */
  #walkH(xa: number, xb: number, y: number): void {
    const dx = xb > xa ? 1 : -1;
    let cx = xa;
    while (cx !== xb) {
      this.setCell(cx, y, "─");
      cx += dx;
    }
  }

  /** 从 ya 向 yb 行走画竖线（不含终点 yb）。 */
  #walkV(x: number, ya: number, yb: number): void {
    const dy = yb > ya ? 1 : -1;
    let cy = ya;
    while (cy !== yb) {
      this.setCell(x, cy, "│");
      cy += dy;
    }
  }

  #head(x: number, y: number, ch: string): void {
    this.setCell(x, y, ch);
  }

  /** 渲染为行数组：宽字符续格跳过，行尾空白裁剪。 */
  render(): string[] {
    const out: string[] = [];
    for (let y = 0; y < this.rows; y++) {
      let line = "";
      const row = this.#cells[y]!;
      for (let x = 0; x < this.cols; x++) {
        const c = row[x]!;
        if (c !== CONT) line += c;
      }
      out.push(line.replace(/\s+$/, ""));
    }
    return out;
  }
}
