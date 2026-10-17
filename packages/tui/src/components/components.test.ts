import { describe, expect, test } from "bun:test";
import { VirtualTerminal } from "../engine/virtual-terminal";
import { EL } from "../engine/diff-renderer";
import type { ParsedKey } from "../engine/diff-renderer";
import { MemoryWriter } from "../testing";
import { TuiApp } from "./tui-app";
import type { Component } from "./tui-app";
import { PasteBanner } from "./paste-banner";
import { ReadGroup } from "./read-group";
import { SwarmProgress } from "./swarm-progress";
import { ThoughtCard } from "./thought-card";

const enter: ParsedKey = { kind: "enter" };
const esc: ParsedKey = { kind: "esc" };
const charA: ParsedKey = { kind: "char", char: "a" };

/** 在 4×24 网格上渲染组件并返回第 y 行文本。 */
function renderRow(c: Component, y: number, rows = 4, cols = 24): string {
  const vt = new VirtualTerminal(rows, cols);
  c.render(vt);
  return vt.rowText(y);
}

// ---------------------------------------------------------------------------
// TuiApp —— 组件栈
// ---------------------------------------------------------------------------

describe("TuiApp —— 组件栈渲染与派发", () => {
  class Writer implements Component {
    constructor(
      private readonly text: string,
      private readonly x = 0,
      private readonly y = 0,
    ) {}
    render(term: VirtualTerminal): void {
      term.write(this.x, this.y, this.text);
    }
  }

  class KeySpy implements Component {
    seen: ParsedKey[] = [];
    wants: ((k: ParsedKey) => boolean) | null = null;
    render(): void {}
    handleKey(key: ParsedKey): void {
      this.seen.push(key);
    }
    wantsKey(key: ParsedKey): boolean {
      return this.wants ? this.wants(key) : true;
    }
  }

  test("渲染顺序栈底 → 栈顶：后画者覆盖先画者", () => {
    const w = new MemoryWriter();
    const app = new TuiApp(w, 2, 8);
    app.push(new Writer("AA"));
    app.push(new Writer("BB"));
    app.render();
    expect(w.output).toBe(`\x1b[1;1HBB${" ".repeat(6)}${EL}`);
  });

  test("按键派发给栈顶带 handleKey 的组件", () => {
    const app = new TuiApp(new MemoryWriter(), 2, 8);
    const bottom = new KeySpy();
    const top = new KeySpy();
    app.push(bottom);
    app.push(top);
    app.dispatchKey(charA);
    expect(top.seen).toEqual([charA]);
    expect(bottom.seen).toEqual([]);
  });

  test("wantsKey=false 放行到下层组件（idle 状态行不拦截）", () => {
    const app = new TuiApp(new MemoryWriter(), 2, 8);
    const bottom = new KeySpy();
    const top = new KeySpy();
    top.wants = () => false;
    app.push(bottom);
    app.push(top);
    app.dispatchKey(charA);
    expect(top.seen).toEqual([]);
    expect(bottom.seen).toEqual([charA]);
  });

  test("push/pop 与 depth", () => {
    const app = new TuiApp(new MemoryWriter(), 2, 8);
    const c: Component = { render: () => {} };
    expect(app.depth).toBe(0);
    app.push(c);
    app.push(c);
    expect(app.depth).toBe(2);
    expect(app.pop()).toBe(c);
    expect(app.depth).toBe(1);
  });

  test("TuiApp 相同内容两帧 → 第二帧零输出（差分 CPU 特性贯通组件栈）", () => {
    const w = new MemoryWriter();
    const app = new TuiApp(w, 2, 8);
    app.push(new Writer("x"));
    app.render();
    expect(w.count).toBe(1);
    app.render();
    expect(w.count).toBe(1);
    app.push(new Writer("y", 1, 1));
    app.render();
    expect(w.count).toBe(2);
    expect(w.chunks[1]).toBe(`\x1b[2;1H y${" ".repeat(6)}${EL}`);
  });

  test("resize 透传渲染器：尺寸变化后全量重绘", () => {
    const w = new MemoryWriter();
    const app = new TuiApp(w, 2, 8);
    app.push(new Writer("x"));
    app.render();
    app.resize(3, 8);
    app.render();
    expect(w.chunks[1]).toBe(`\x1b[1;1Hx${" ".repeat(7)}${EL}`);
  });
});

// ---------------------------------------------------------------------------
// PasteBanner —— 粘贴待确认状态机
// ---------------------------------------------------------------------------

describe("PasteBanner —— 防误提交状态机", () => {
  function make() {
    const confirmed: string[] = [];
    let cancelled = 0;
    const banner = new PasteBanner({
      onConfirm: (t) => confirmed.push(t),
      onCancel: () => {
        cancelled += 1;
      },
    });
    return { banner, confirmed, cancelled: () => cancelled };
  }

  test("idle：不渲染、不消费任何按键", () => {
    const { banner } = make();
    const vt = new VirtualTerminal(3, 40);
    banner.render(vt);
    expect(vt.toString().trim()).toBe("");
    expect(banner.wantsKey(enter)).toBe(false);
    expect(banner.wantsKey(esc)).toBe(false);
    expect(banner.armed).toBe(false);
  });

  test("armed：底部行显示合约格式的状态条", () => {
    const { banner } = make();
    banner.acceptPaste("hello");
    expect(banner.armed).toBe(true);
    const vt = new VirtualTerminal(4, 48);
    banner.render(vt);
    // 状态条 4 个 CJK 宽字符的宽尾列在行文本中折叠：48 - 36 - 4 = 8 尾随空格
    expect(vt.rowText(3)).toBe(
      "[paste: 5 chars — Enter 发送 / Esc 取消]" + " ".repeat(8),
    );
  });

  test("CJK 粘贴按码点计数不虚报", () => {
    const { banner } = make();
    banner.acceptPaste("中文ab");
    const vt = new VirtualTerminal(2, 48);
    banner.render(vt);
    expect(vt.rowText(1)).toContain("[paste: 4 chars");
  });

  test("armed + Enter → onConfirm(text) 一次并回到 idle", () => {
    const { banner, confirmed } = make();
    banner.acceptPaste("hello");
    banner.handleKey(enter);
    expect(confirmed).toEqual(["hello"]);
    expect(banner.armed).toBe(false);
    banner.handleKey(enter); // idle 再按 Enter 不重复触发
    expect(confirmed).toHaveLength(1);
  });

  test("armed + Esc → onCancel 一次并回到 idle", () => {
    const { banner, cancelled } = make();
    banner.acceptPaste("hello");
    banner.handleKey(esc);
    expect(cancelled()).toBe(1);
    expect(banner.armed).toBe(false);
  });

  test("armed + 其他键不消费、保持 armed", () => {
    const { banner, confirmed, cancelled } = make();
    banner.acceptPaste("hello");
    expect(banner.wantsKey(charA)).toBe(false);
    banner.handleKey(charA);
    expect(banner.armed).toBe(true);
    expect(confirmed).toHaveLength(0);
    expect(cancelled()).toBe(0);
  });

  test("wantsKey：armed 时仅拦截 Enter/Esc", () => {
    const { banner } = make();
    banner.acceptPaste("x");
    expect(banner.wantsKey(enter)).toBe(true);
    expect(banner.wantsKey(esc)).toBe(true);
    expect(banner.wantsKey(charA)).toBe(false);
  });

  test("重复粘贴覆盖前段；dismiss 静默撤销不触发回调", () => {
    const { banner, confirmed, cancelled } = make();
    banner.acceptPaste("first");
    banner.acceptPaste("second");
    banner.dismiss();
    expect(banner.armed).toBe(false);
    expect(confirmed).toHaveLength(0);
    expect(cancelled()).toBe(0);
    banner.acceptPaste("third");
    banner.handleKey(enter);
    expect(confirmed).toEqual(["third"]);
  });

  test("TuiApp 集成：armed 状态行拦截 Enter，下层组件不再收到", () => {
    const w = new MemoryWriter();
    const app = new TuiApp(w, 2, 40);
    const confirmed: string[] = [];
    const banner = new PasteBanner({ onConfirm: (t) => confirmed.push(t) });
    const lower: Component = {
      render: () => {},
      handleKey: (k) => {
        if (k.kind === "enter") confirmed.push("LEAK");
      },
    };
    app.push(lower);
    app.push(banner);
    banner.acceptPaste("hi");
    app.dispatchKey(enter);
    expect(confirmed).toEqual(["hi"]); // 无 "LEAK"
  });
});

// ---------------------------------------------------------------------------
// ReadGroup —— 多文件读取折叠聚合
// ---------------------------------------------------------------------------

describe("ReadGroup —— 折叠聚合卡", () => {
  test("无事件不渲染", () => {
    const rg = new ReadGroup();
    expect(renderRow(rg, 0).trim()).toBe("");
  });

  test("不超过展示上限：Read ×N: 全列 + [+] 标记", () => {
    const rg = new ReadGroup();
    rg.add("a.ts");
    rg.add("b.ts");
    expect(rg.count).toBe(2);
    expect(renderRow(rg, 0)).toBe("Read ×2: a.ts, b.ts [+]".padEnd(24));
  });

  test("溢出折叠：Read ×4: a.ts, b.ts (+2 more) [+]（合约格式）", () => {
    const rg = new ReadGroup();
    for (const f of ["a.ts", "b.ts", "c.ts", "d.ts"]) rg.add(f);
    expect(renderRow(rg, 0, 4, 40)).toBe(
      "Read ×4: a.ts, b.ts (+2 more) [+]".padEnd(40),
    );
  });

  test("展开态：头行 [-] + 逐文件行；再折叠还原", () => {
    const rg = new ReadGroup();
    rg.add("a.ts");
    rg.add("b.ts");
    rg.add("c.ts");
    rg.expand();
    expect(rg.isExpanded).toBe(true);
    expect(renderRow(rg, 0, 4, 40)).toBe("Read ×3 [-]".padEnd(40));
    expect(renderRow(rg, 1, 4, 40)).toBe("  a.ts".padEnd(40));
    expect(renderRow(rg, 2, 4, 40)).toBe("  b.ts".padEnd(40));
    expect(renderRow(rg, 3, 4, 40)).toBe("  c.ts".padEnd(40));
    rg.collapse();
    expect(renderRow(rg, 0, 4, 40)).toBe(
      "Read ×3: a.ts, b.ts (+1 more) [+]".padEnd(40),
    );
  });

  test("toggle 双向切换；reset 清空；paths 快照", () => {
    const rg = new ReadGroup();
    rg.add("x.ts");
    rg.toggle();
    expect(rg.isExpanded).toBe(true);
    rg.toggle();
    expect(rg.isExpanded).toBe(false);
    expect(rg.paths).toEqual(["x.ts"]);
    rg.reset();
    expect(rg.count).toBe(0);
    expect(rg.paths).toEqual([]);
  });

  test("自定义 maxShown=1", () => {
    const rg = new ReadGroup(1);
    rg.add("a.ts");
    rg.add("b.ts");
    expect(renderRow(rg, 0, 4, 32)).toBe("Read ×2: a.ts (+1 more) [+]".padEnd(32));
  });
});

// ---------------------------------------------------------------------------
// SwarmProgress —— 泳道进度
// ---------------------------------------------------------------------------

describe("SwarmProgress —— 状态条渲染", () => {
  test("合约示例：3/7 宽 8 → [████----] 3/7", () => {
    const sp = new SwarmProgress([{ name: "task", done: 3, total: 7 }]);
    expect(renderRow(sp, 0, 2, 24).trimEnd()).toBe("task [████----] 3/7");
  });

  test("边界：0/7 全空、7/7 全满", () => {
    const sp = new SwarmProgress([
      { name: "a", done: 0, total: 7 },
      { name: "b", done: 7, total: 7 },
    ]);
    expect(renderRow(sp, 0).trimEnd()).toBe("a [--------] 0/7");
    expect(renderRow(sp, 1).trimEnd()).toBe("b [████████] 7/7");
  });

  test("total=0 除零安全", () => {
    const sp = new SwarmProgress([{ name: "idle", done: 0, total: 0 }]);
    expect(renderRow(sp, 0).trimEnd()).toBe("idle [--------] 0/0");
  });

  test("barWidth 可调与越界钳制", () => {
    const sp = new SwarmProgress(
      [
        { name: "half", done: 1, total: 2 },
        { name: "over", done: 10, total: 7 },
      ],
      4,
    );
    expect(renderRow(sp, 0).trimEnd()).toBe("half [██--] 1/2");
    expect(renderRow(sp, 1).trimEnd()).toBe("over [████] 10/7");
  });

  test("bar() 单独可取；多泳道按行渲染", () => {
    const sp = new SwarmProgress([
      { name: "t1", done: 2, total: 4 },
      { name: "t2", done: 4, total: 4 },
    ]);
    expect(sp.bar({ name: "t", done: 3, total: 7 })).toBe("[████----] 3/7");
    const vt = new VirtualTerminal(3, 20);
    sp.render(vt, 1, 1);
    expect(vt.rowText(1).trimEnd()).toBe(" t1 [████----] 2/4");
    expect(vt.rowText(2).trimEnd()).toBe(" t2 [████████] 4/4");
  });
});

// ---------------------------------------------------------------------------
// ThoughtCard —— R1 思考流卡片
// ---------------------------------------------------------------------------

describe("ThoughtCard —— 折叠/展开两态", () => {
  const lines = ["first line", "second", "third"];

  test("默认折叠：首行 + (N lines collapsed)", () => {
    const card = new ThoughtCard(lines);
    expect(card.isCollapsed).toBe(true);
    expect(renderRow(card, 0, 4, 40)).toBe(
      "▸ first line (3 lines collapsed)".padEnd(40),
    );
  });

  test("展开态：头行 + 全部思考行", () => {
    const card = new ThoughtCard(lines);
    card.expand();
    expect(renderRow(card, 0, 4, 40)).toBe("▾ thought".padEnd(40));
    expect(renderRow(card, 1, 4, 40)).toBe("  first line".padEnd(40));
    expect(renderRow(card, 2, 4, 40)).toBe("  second".padEnd(40));
    expect(renderRow(card, 3, 4, 40)).toBe("  third".padEnd(40));
  });

  test("toggle 双向切换", () => {
    const card = new ThoughtCard(lines);
    card.toggle();
    expect(card.isCollapsed).toBe(false);
    card.toggle();
    expect(card.isCollapsed).toBe(true);
    expect(renderRow(card, 0, 4, 40)).toContain("(3 lines collapsed)");
  });

  test("空内容不渲染；setLines 更新行数", () => {
    const card = new ThoughtCard();
    expect(renderRow(card, 0).trim()).toBe("");
    card.setLines(["only"]);
    expect(card.lineCount).toBe(1);
    expect(renderRow(card, 0, 4, 40)).toContain("only (1 lines collapsed)");
  });
});
