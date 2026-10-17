import { describe, expect, test } from "bun:test";
import { DeltaTracker } from "./delta-tracker";
import type { JsonPatch } from "./delta-tracker";
import { Projector } from "./state-projection";

interface Doc {
  count: number;
  name: string;
  nested: { a: { b: number }; keep: string; extra?: string };
  items: string[];
  meta?: Record<string, unknown>;
}

function makeTracker(): DeltaTracker<Doc> {
  return new DeltaTracker<Doc>({
    count: 1,
    name: "doc",
    nested: { a: { b: 2 }, keep: "k" },
    items: ["x", "y"],
  });
}

describe("DeltaTracker —— patch 生成矩阵", () => {
  test("顶层标量替换 → replace", () => {
    const t = makeTracker();
    const patches = t.mutate((d) => {
      d.count = 5;
    });
    expect(patches).toEqual([{ op: "replace", path: "/count", value: 5 }]);
  });

  test("嵌套对象深层修改 → 指针路径 replace /nested/a/b", () => {
    const t = makeTracker();
    const patches = t.mutate((d) => {
      d.nested.a.b = 42;
    });
    expect(patches).toEqual([{ op: "replace", path: "/nested/a/b", value: 42 }]);
  });

  test("新增对象键 → add（含嵌套值）", () => {
    const t = makeTracker();
    const patches = t.mutate((d) => {
      d.meta = { created: true, tags: ["p", "q"] };
    });
    expect(patches).toEqual([
      { op: "add", path: "/meta", value: { created: true, tags: ["p", "q"] } },
    ]);
  });

  test("删除对象键 → remove", () => {
    const t = makeTracker();
    t.mutate((d) => {
      d.meta = { gone: 1, stay: 2 };
    });
    const patches = t.mutate((d) => {
      delete d.meta!.gone;
    });
    expect(patches).toEqual([{ op: "remove", path: "/meta/gone" }]);
  });

  test("数组 push → 尾部序号 add /items/2", () => {
    const t = makeTracker();
    const patches = t.mutate((d) => {
      d.items.push("z");
    });
    expect(patches).toEqual([{ op: "add", path: "/items/2", value: "z" }]);
  });

  test("数组中部元素替换 → replace /items/0", () => {
    const t = makeTracker();
    const patches = t.mutate((d) => {
      d.items[0] = "X";
    });
    expect(patches).toEqual([{ op: "replace", path: "/items/0", value: "X" }]);
  });

  test("数组收缩多位 → remove 按降序序号（应用时索引不漂移）", () => {
    const t = new DeltaTracker<{ arr: number[] }>({ arr: [1, 2, 3, 4] });
    const patches = t.mutate((d) => {
      d.arr = [1];
    });
    expect(patches).toEqual([
      { op: "remove", path: "/arr/3" },
      { op: "remove", path: "/arr/2" },
      { op: "remove", path: "/arr/1" },
    ]);
  });

  test("数组扩多位 → add 升序序号", () => {
    const t = new DeltaTracker<{ arr: number[] }>({ arr: [1] });
    const patches = t.mutate((d) => {
      d.arr = [1, 2, 3];
    });
    expect(patches).toEqual([
      { op: "add", path: "/arr/1", value: 2 },
      { op: "add", path: "/arr/2", value: 3 },
    ]);
  });

  test("写同值 / 无变化 → 空 patch、不进历史、版本不动", () => {
    const t = makeTracker();
    const patches = t.mutate((d) => {
      d.count = 1;
      d.items[1] = "y";
    });
    expect(patches).toEqual([]);
    expect(t.history.length).toBe(0);
    expect(t.version).toBe(0);
  });

  test("RFC 6902 形状：add/replace 带 value，remove 无 value；路径含 ~ / 转义", () => {
    const t = new DeltaTracker<Record<string, unknown>>({ "a/b": 1, "c~d": { "e/f": 2 } });
    const p1 = t.mutate((d) => {
      d["a/b"] = 9;
      (d["c~d"] as Record<string, unknown>)["e/f"] = 10;
    });
    expect(p1).toEqual([
      { op: "replace", path: "/a~1b", value: 9 },
      { op: "replace", path: "/c~0d/e~1f", value: 10 },
    ]);
    const p2 = t.mutate((d) => {
      d["new"] = true;
      delete d["c~d"];
    });
    expect(p2).toEqual([
      { op: "add", path: "/new", value: true },
      { op: "remove", path: "/c~0d" },
    ]);
    const patches = [...p1, ...p2];
    for (const p of patches) {
      expect(["add", "remove", "replace"]).toContain(p.op);
      if (p.op === "remove") expect("value" in p).toBe(false);
      else expect("value" in p).toBe(true);
    }
    // 转义路径可被自身 apply 正确回放
    const t2 = new DeltaTracker<Record<string, unknown>>({ "a/b": 1, "c~d": { "e/f": 2 } });
    t2.apply(patches);
    expect(t2.snapshot()).toEqual({ "a/b": 9, new: true });
  });
});

describe("DeltaTracker —— 不可变快照与历史", () => {
  test("snapshot 深冻结：外部篡改抛 TypeError 且不影响追踪器", () => {
    const t = makeTracker();
    const snap = t.snapshot();
    expect(() => {
      (snap as { count: number }).count = 99;
    }).toThrow();
    expect(() => {
      (snap.items as string[]).push("hack");
    }).toThrow();
    expect(t.snapshot().count).toBe(1);
    expect(t.snapshot().items).toEqual(["x", "y"]);
  });

  test("snapshot 独立于后续 mutate", () => {
    const t = makeTracker();
    const snap = t.snapshot();
    t.mutate((d) => {
      d.count = 7;
      d.items.push("z");
    });
    expect(snap.count).toBe(1);
    expect(snap.items).toEqual(["x", "y"]);
    expect(t.snapshot().count).toBe(7);
  });

  test("history 存档每次 mutate 的 patch 序列", () => {
    const t = makeTracker();
    t.mutate((d) => {
      d.count = 2;
    });
    t.mutate((d) => {
      d.name = "n2";
    });
    t.mutate((d) => {
      d.items.push("z");
    });
    expect(t.history.length).toBe(3);
    expect(t.history[0]).toEqual([{ op: "replace", path: "/count", value: 2 }]);
    expect(t.history[1]).toEqual([{ op: "replace", path: "/name", value: "n2" }]);
    expect(t.history[2]).toEqual([{ op: "add", path: "/items/2", value: "z" }]);
    expect(t.version).toBe(3);
  });

  test("mutate 内 fn 抛错：状态与历史不变，错误上抛", () => {
    const t = makeTracker();
    expect(() =>
      t.mutate(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(t.version).toBe(0);
    expect(t.snapshot().count).toBe(1);
    expect(t.history.length).toBe(0);
  });
});

describe("DeltaTracker —— apply 与时间旅行", () => {
  test("apply 重放历史前缀 = travel 任意版本（undo 语义）", () => {
    const t = makeTracker();
    t.mutate((d) => {
      d.count = 10;
    });
    t.mutate((d) => {
      d.items.push("z");
    });
    t.mutate((d) => {
      d.name = "final";
    });
    // travel 到第 1、2、3 版
    expect(t.travel(1)).toEqual({ ...t.snapshot(), name: "doc", items: ["x", "y"] });
    expect(t.travel(2).name).toBe("doc");
    expect(t.travel(3).name).toBe("final");
    // undo：回到第 0 版 = 初态
    expect(t.travel(0)).toEqual({ count: 1, name: "doc", nested: { a: { b: 2 }, keep: "k" }, items: ["x", "y"] });
  });

  test("apply 反向 patch（手工逆补丁）实现 undo", () => {
    const t = makeTracker();
    t.mutate((d) => {
      d.count = 10;
      d.items.push("z");
    });
    // 逆补丁：replace 回旧值 + remove 新增元素
    const inverse: JsonPatch[] = [
      { op: "replace", path: "/count", value: 1 },
      { op: "remove", path: "/items/2" },
    ];
    t.apply(inverse);
    expect(t.snapshot()).toEqual({ count: 1, name: "doc", nested: { a: { b: 2 }, keep: "k" }, items: ["x", "y"] });
  });

  test("apply 的 RFC 6902 语义：add 到数组 = splice 插入，remove = 挤出", () => {
    const t = new DeltaTracker<{ arr: string[] }>({ arr: ["a", "c"] });
    const out = t.apply([
      { op: "add", path: "/arr/1", value: "b" },
      { op: "remove", path: "/arr/0" },
    ]);
    expect(out).toEqual({ arr: ["b", "c"] });
  });

  test("apply 对象 add 新键 / replace 既有键 / remove 缺键报错", () => {
    const t = new DeltaTracker<Record<string, number>>({ a: 1 });
    t.apply([{ op: "add", path: "/b", value: 2 }]);
    expect(t.snapshot()).toEqual({ a: 1, b: 2 });
    t.apply([{ op: "replace", path: "/b", value: 3 }]);
    expect(t.snapshot()).toEqual({ a: 1, b: 3 });
    expect(() => t.apply([{ op: "remove", path: "/nope" }])).toThrow();
    expect(() => t.apply([{ op: "replace", path: "/nope", value: 1 }])).toThrow();
  });

  test("diff 产物可直接喂回 apply（roundtrip 一致性）", () => {
    const t = makeTracker();
    const target: Doc = {
      count: 9,
      name: "renamed",
      nested: { a: { b: 3 }, keep: "k", extra: "e" },
      items: ["q"],
      meta: { m: 1 },
    };
    const patches: JsonPatch[] = [];
    t.mutate((d) => {
      Object.assign(d, structuredClone(target));
    });
    patches.push(...t.history[0]!);
    const t2 = makeTracker();
    t2.apply(patches);
    expect(t2.snapshot()).toEqual(target);
  });
});

describe("Projector —— 投影与订阅者隔离", () => {
  test("投递 { patches, version, snapshot }，版本随变更递增", () => {
    const t = makeTracker();
    const p = new Projector<Doc>(t);
    const seen: Array<{ version: number; paths: string[]; count: number }> = [];
    p.subscribe((e) => {
      seen.push({ version: e.version, paths: e.patches.map((x) => x.path), count: e.snapshot.count });
    });
    t.mutate((d) => {
      d.count = 2;
    });
    t.mutate((d) => {
      d.name = "n";
    });
    expect(seen.length).toBe(2);
    expect(seen[0]).toEqual({ version: 1, paths: ["/count"], count: 2 });
    expect(seen[1]!.version).toBe(2);
    expect(p.version).toBe(2);
  });

  test("多订阅者全部收到同一事件", () => {
    const t = makeTracker();
    const p = new Projector<Doc>(t);
    let a = 0;
    let b = 0;
    p.subscribe(() => {
      a += 1;
    });
    p.subscribe(() => {
      b += 1;
    });
    t.mutate((d) => {
      d.count = 3;
    });
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  test("异常隔离：抛错订阅者不影响他人、不影响 mutate 调用方", () => {
    const t = makeTracker();
    const p = new Projector<Doc>(t);
    let good = 0;
    p.subscribe(() => {
      throw new Error("bad subscriber");
    });
    p.subscribe(() => {
      good += 1;
    });
    expect(() =>
      t.mutate((d) => {
        d.count = 4;
      }),
    ).not.toThrow();
    expect(good).toBe(1);
    expect(t.version).toBe(1);
  });

  test("退订后不再收信；close 后全停", () => {
    const t = makeTracker();
    const p = new Projector<Doc>(t);
    let n = 0;
    const off = p.subscribe(() => {
      n += 1;
    });
    t.mutate((d) => {
      d.count = 2;
    });
    off();
    t.mutate((d) => {
      d.count = 3;
    });
    expect(n).toBe(1);
    p.close();
    // 版本计数的是投影层收到的追踪器 delta 事件（两次 mutate 均已收到）
    expect(p.version).toBe(2);
  });

  test("无变化 mutate 不产生投影事件", () => {
    const t = makeTracker();
    const p = new Projector<Doc>(t);
    let n = 0;
    p.subscribe(() => {
      n += 1;
    });
    t.mutate(() => {});
    expect(n).toBe(0);
  });
});
