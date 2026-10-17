import { describe, expect, test } from "bun:test";
import {
  DEFAULT_VIEW_WIDTH,
  TranscriptProjection,
  assertProjectionInvariants,
} from "./transcript-projection";
import type { TranscriptEntry, TranscriptKind } from "./transcript-projection";
import { textWidth } from "./components/cjk-width";

const entry = (kind: TranscriptKind, text: string): TranscriptEntry => ({ kind, text });

const KINDS: readonly TranscriptKind[] = ["user", "assistant", "system", "tool"];

describe("TranscriptProjection —— 基础投影（L1/L2）", () => {
  test("默认行宽 120，可配置覆盖", () => {
    expect(new TranscriptProjection().width).toBe(DEFAULT_VIEW_WIDTH);
    expect(DEFAULT_VIEW_WIDTH).toBe(120);
    expect(new TranscriptProjection({ width: 80 }).width).toBe(80);
  });

  test("空投影：render 为空数组、markdown 为空串、不变式成立", () => {
    const p = new TranscriptProjection();
    expect(p.render()).toEqual([]);
    expect(p.toMarkdown()).toBe("");
    expect(p.viewLines()).toEqual([]);
    expect(p.historyLines()).toEqual([]);
    expect(() => assertProjectionInvariants(p)).not.toThrow();
  });

  test("空条目（text 为空串）渲染为单行角色前缀", () => {
    const p = new TranscriptProjection();
    p.append(entry("system", ""));
    expect(p.render()).toEqual(["[system]"]);
    expect(p.toMarkdown()).toBe("**[system]**");
  });

  test("短文本单行渲染，带角色前缀", () => {
    const p = new TranscriptProjection();
    p.append(entry("user", "hello"));
    expect(p.render()).toEqual(["[user] hello"]);
  });

  test("四种 kind 前缀正确且 markdown 对应加粗", () => {
    const p = new TranscriptProjection();
    for (const k of KINDS) p.append(entry(k, "x"));
    expect(p.render()).toEqual([
      "[user] x",
      "[assistant] x",
      "[system] x",
      "[tool] x",
    ]);
    expect(p.toMarkdown().split("\n")).toEqual([
      "**[user]** x",
      "**[assistant]** x",
      "**[system]** x",
      "**[tool]** x",
    ]);
  });

  test("非法 kind / 非 string text 抛 TypeError", () => {
    const p = new TranscriptProjection();
    expect(() => p.append({ kind: "nope" as never, text: "x" })).toThrow(TypeError);
    expect(() => p.append({ kind: "user", text: 42 as never })).toThrow(TypeError);
  });

  test("非法行宽（0 / 负数 / 非整数）抛 RangeError", () => {
    expect(() => new TranscriptProjection({ width: 0 })).toThrow(RangeError);
    expect(() => new TranscriptProjection({ width: -5 })).toThrow(RangeError);
    expect(() => new TranscriptProjection({ width: 1.5 })).toThrow(RangeError);
  });

  test("\\r\\n 与孤立 \\r 归一化为 \\n 逻辑行", () => {
    const p = new TranscriptProjection();
    p.append(entry("user", "a\r\nb\rc"));
    expect(p.render()).toEqual(["[user] a", "b", "c"]);
  });

  test("entries/historyLines 为只读快照且 entryIndex 顺序稳定", () => {
    const p = new TranscriptProjection();
    p.append(entry("user", "一"));
    p.append(entry("tool", "二"));
    const snap = p.entries as TranscriptEntry[];
    expect(snap.map((e) => e.kind)).toEqual(["user", "tool"]);
    snap.push(entry("user", "hack")); // 快照污染不影响投影
    expect(p.entries).toHaveLength(2);
    const hist = p.historyLines();
    expect(hist.map((l) => l.text)).toEqual(["[user] 一", "[tool] 二"]);
    expect(hist.map((l) => l.entryIndex)).toEqual([0, 1]);
    expect(hist.map((l) => l.isEntryStart)).toEqual([true, true]);
  });

  test("meta 随 L1 透传且不影响投影行", () => {
    const p = new TranscriptProjection();
    p.append({ kind: "tool", text: "run", meta: { cmd: "bun test" } });
    expect(p.entries[0]!.meta).toEqual({ cmd: "bun test" });
    expect(p.render()).toEqual(["[tool] run"]);
  });

  test("尾部换行生成空行且 L4 同构保留", () => {
    const p = new TranscriptProjection();
    p.append(entry("user", "end\n"));
    expect(p.render()).toEqual(["[user] end", ""]);
    expect(p.toMarkdown()).toBe("**[user]** end\n");
  });
});

describe("TranscriptProjection —— CJK 度量折行（L2→L3）", () => {
  test("行宽边界：前缀计入度量，宽字符在边界整字折行（60/61 汉字）", () => {
    // "[user] " 前缀 7 列；width=127 时正文恰容 60 个汉字（120 列）
    const p = new TranscriptProjection({ width: 127 });
    p.append(entry("user", "汉".repeat(60)));
    expect(p.render()).toEqual(["[user] " + "汉".repeat(60)]);

    const q = new TranscriptProjection({ width: 127 });
    q.append(entry("user", "汉".repeat(61)));
    expect(q.render()).toEqual(["[user] " + "汉".repeat(60), "汉"]);
  });

  test("默认行宽 120：逐行不超列，首行在前缀后整字截断", () => {
    const p = new TranscriptProjection();
    p.append(entry("user", "测".repeat(200)));
    const lines = p.render();
    for (const line of lines) {
      expect(textWidth(line)).toBeLessThanOrEqual(120);
    }
    // 7 列前缀 + 56 个汉字 = 119 列；第 57 字放不下整体换行
    expect(lines[0]).toBe("[user] " + "测".repeat(56));
  });

  test("剩余 1 列时宽字符整体换行，不拆宽字符", () => {
    const p = new TranscriptProjection({ width: 11 });
    p.append(entry("user", "一二三四五六"));
    const lines = p.render();
    // 7 列前缀 + 一(9) + 二(11)；三 需 13 列 → 整体换行
    expect(lines).toEqual(["[user] 一二", "三四五六"]);
    for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(11);
    expect(lines.join("")).toBe("[user] " + "一二三四五六");
  });

  test("折行扫掠（宽度 2..40）：逐行不超列且折行无损", () => {
    const text = "中文abc mixed コンソール with 🚀 and ñ";
    for (let w = 2; w <= 40; w++) {
      const p = new TranscriptProjection({ width: w });
      p.append(entry("user", text));
      const lines = p.render();
      expect(lines.join("")).toBe("[user] " + text); // 拼接还原原行（折行无损）
      for (const line of lines) {
        expect(textWidth(line)).toBeLessThanOrEqual(w);
      }
    }
  });

  test("ASCII 混排按列度量折行", () => {
    const p = new TranscriptProjection({ width: 5 });
    p.append(entry("user", "ab日本語cd"));
    const lines = p.render();
    // 5 列容器：前缀 "[user" 占满首行后 ] 与正文逐列硬折，宽字符整字迁移
    expect(lines).toEqual(["[user", "] ab", "日本", "語cd"]);
    expect(lines.join("")).toBe("[user] ab日本語cd");
  });

  test("长 ASCII 串无空格断点时按列硬折", () => {
    const p = new TranscriptProjection({ width: 9 });
    p.append(entry("user", "abcdefghijkl"));
    const lines = p.render();
    // 7 列前缀 + ab（9 列）后 c 超出；续行按 9 列硬折
    expect(lines).toEqual(["[user] ab", "cdefghijk", "l"]);
  });

  test("emoji 组合序列（ZWJ 家族）不拆行", () => {
    const family = "👨‍👩‍👦"; // 3 人 + 2 ZWJ，单元宽 6 列
    const p = new TranscriptProjection({ width: 8 });
    p.append(entry("user", `ok${family}!`));
    const lines = p.render();
    expect(lines.join("")).toBe(`[user] ok${family}!`);
    // family 是 6 列整体单元：跨行边界时整块迁移，不拆
    expect(lines[1]).toBe(`k${family}!`);
  });

  test("组合单元自身超宽时独立成行硬放（不拆优先于不超）", () => {
    const family = "👨‍👩‍👦";
    const p = new TranscriptProjection({ width: 4 });
    p.append(entry("user", `x${family}y`));
    expect(p.render()).toEqual(["[use", "r] x", family, "y"]);
  });

  test("变体选择符附着基准字符，不拆行", () => {
    const vs = "✅︎"; // U+2705 + U+FE0E，单元宽 2 列
    const p = new TranscriptProjection({ width: 10 });
    p.append(entry("user", `a${vs}b`));
    expect(p.render()).toEqual([`[user] a${vs}`, "b"]);
  });

  test("区域指示符成对（国旗）不拆行", () => {
    const flag = "🇨🇳"; // U+1F1E8 U+1F1F3，单元宽 2 列
    const p = new TranscriptProjection({ width: 10 });
    p.append(entry("user", `a${flag}b`));
    expect(p.render()).toEqual([`[user] a${flag}`, "b"]);

    const q = new TranscriptProjection({ width: 9 });
    q.append(entry("user", `a${flag}b`));
    expect(q.render()).toEqual(["[user] a", `${flag}b`]);
  });

  test("空逻辑行在 L3 中保留", () => {
    const p = new TranscriptProjection();
    p.append(entry("user", "a\n\nb"));
    expect(p.render()).toEqual(["[user] a", "", "b"]);
  });
});

describe("TranscriptProjection —— L4 markdown 同构", () => {
  test("L3/L4 行行同构：行数一致且逐行保序映射", () => {
    const p = new TranscriptProjection({ width: 20 });
    p.append(entry("assistant", "中文内容需要折行的确很长的一串汉字文本"));
    p.append(entry("tool", "plain"));
    const views = p.viewLines();
    const mdLines = p.toMarkdown().split("\n");
    expect(mdLines).toHaveLength(views.length);
    views.forEach((v, i) => {
      const header = `[${v.kind}]`;
      if (v.isEntryStart && v.text.startsWith(header)) {
        expect(mdLines[i]).toBe(`**${header}**${v.text.slice(header.length)}`);
      } else {
        expect(mdLines[i]).toBe(v.text);
      }
    });
  });

  test("折行→markdown 往返：去修饰后逐条目还原 L1 文本", () => {
    const p = new TranscriptProjection({ width: 16 });
    p.append(entry("user", "你好，世界"));
    p.append(entry("assistant", "一段需要折行的较长中文回复文本。"));
    // L2 join 精确
    const expected = "[user] 你好，世界\n[assistant] 一段需要折行的较长中文回复文本。";
    expect(p.historyLines().map((l) => l.text).join("\n")).toBe(expected);
    // L3 折行无损（拼接还原）
    expect(p.render().join("")).toBe(expected.replace(/\n/g, ""));
    // L4 与 L3 行行同构：行数一致且去粗体后逐行等于 L3
    const views = p.viewLines();
    const mdLines = p.toMarkdown().split("\n");
    expect(mdLines).toHaveLength(views.length);
    const header0 = "[user]";
    const header1 = "[assistant]";
    expect(mdLines[0]).toBe(`**${header0}** 你好，世`);
    expect(mdLines[1]).toBe("界");
    expect(mdLines[2]).toBe(`**${header1}** 一段`);
    views.forEach((v, idx) => {
      const bold = `**[${v.kind}]**`;
      const unmarked =
        v.isEntryStart && v.markdown.startsWith(bold)
          ? `[${v.kind}]` + v.markdown.slice(bold.length)
          : v.markdown;
      expect(unmarked).toBe(v.text);
      expect(mdLines[idx]).toBe(v.markdown);
    });
  });

  test("markdown 语义往返与三投影不变式（混合 emoji/中文/多条目/空条目）", () => {
    const p = new TranscriptProjection({ width: 24 });
    p.append(entry("system", "会话开始"));
    p.append(entry("user", "请把这段超长的中文需求描述整理成结构化的任务清单，谢谢。"));
    p.append(entry("assistant", "Sure — here you go:\n1. 拆解\n2. 排期 👍"));
    p.append(entry("tool", ""));
    expect(() => assertProjectionInvariants(p)).not.toThrow();
  });

  test("行宽小于前缀宽度：前缀折行时 markdown 透传（不产生错误加粗）", () => {
    const p = new TranscriptProjection({ width: 3 });
    p.append(entry("user", "hi"));
    const views = p.viewLines();
    expect(views[0]!.isEntryStart).toBe(true);
    expect(views[0]!.markdown).toBe(views[0]!.text); // 无完整前缀 → 不加粗
    expect(p.render()).toEqual(["[us", "er]", " hi"]);
    expect(() => assertProjectionInvariants(p)).not.toThrow();
  });

  test("正文含 markdown 修饰字符（**）时不变式仍成立", () => {
    const p = new TranscriptProjection({ width: 40 });
    p.append(entry("user", "强调 **加粗** 与 **[user]** 字面量"));
    expect(() => assertProjectionInvariants(p)).not.toThrow();
  });
});

describe("TranscriptProjection —— 增量渲染", () => {
  test("append 增量：旧视图行保持不变，新条目追加在后", () => {
    const p = new TranscriptProjection({ width: 10 });
    p.append(entry("user", "第一条消息"));
    const before = p.render();
    p.append(entry("assistant", "第二条更长的消息内容继续折行"));
    const after = p.render();
    expect(after.slice(0, before.length)).toEqual(before);
    expect(before.join("")).toContain("第一条消息");
    expect(after.join("")).toContain("第二条");
  });

  test("多次 append 后整体折行结果与一次性等价（同构无序漂移）", () => {
    const items: readonly [TranscriptKind, string][] = [
      ["user", "alpha"],
      ["assistant", "beta 中文 long text 需要折行的一段话"],
      ["system", "gamma\ndelta"],
    ];
    const incremental = new TranscriptProjection({ width: 15 });
    for (const [k, t] of items) incremental.append(entry(k, t));
    const batch = new TranscriptProjection({ width: 15 });
    for (const [k, t] of items) batch.append(entry(k, t));
    expect(incremental.render()).toEqual(batch.render());
    expect(incremental.toMarkdown()).toBe(batch.toMarkdown());
  });
});
