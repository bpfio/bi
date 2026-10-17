import { describe, expect, test } from "bun:test";
import {
  editExternally,
  resolveEditorSpec,
  stripUtf8Bom,
  tokenizeEditorCommand,
} from "./external-editor";
import type { EditorFileSystem, EditorSpawnFn, EditResult } from "./external-editor";
import { editPromptCommand } from "../commands/edit-prompt";
import type { PromptEditOutcome } from "../commands/edit-prompt";

// ---------------------------------------------------------------------------
// 注入基建（全离屏）
// ---------------------------------------------------------------------------

interface FsHarness {
  fs: EditorFileSystem;
  tmp: string;
  suffixes: string[];
  written: { path: string; text: string }[];
  read: string[];
  unlinked: string[];
}

function makeFs(opts: { tmp?: string; readBack?: string } = {}): FsHarness {
  const tmp = opts.tmp ?? "/tmp/bi-test/prompt.md";
  const h: FsHarness = {
    tmp,
    suffixes: [],
    written: [],
    read: [],
    unlinked: [],
    fs: {
      tmpPath: (suffix) => {
        h.suffixes.push(suffix ?? "");
        return tmp;
      },
      writeFile: async (path, text) => {
        h.written.push({ path, text });
      },
      readFile: async (path) => {
        h.read.push(path);
        return opts.readBack ?? "";
      },
      unlink: async (path) => {
        h.unlinked.push(path);
      },
    },
  };
  return h;
}

interface SpawnHarness {
  calls: { command: string; args: string[]; env: Record<string, string | undefined> }[];
  exitCode: number | null;
  fn: EditorSpawnFn;
}

function makeSpawn(exitCode: number | null = 0): SpawnHarness {
  const h: SpawnHarness = { calls: [], exitCode, fn: undefined as never };
  h.fn = (command, args, opts) => {
    h.calls.push({ command, args, env: opts.env });
    return {
      on: (event, listener) => {
        if (event === "exit") queueMicrotask(() => listener(h.exitCode));
        return undefined;
      },
    };
  };
  return h;
}

const run = async (opts: Parameters<typeof editExternally>[1]): Promise<EditResult> =>
  editExternally("初始文本", opts);

// ---------------------------------------------------------------------------
// 编辑器探测与命令解析
// ---------------------------------------------------------------------------

describe("resolveEditorSpec / tokenize —— 探测顺序与拆分", () => {
  test("探测顺序 VISUAL > EDITOR > vi", () => {
    expect(resolveEditorSpec({ VISUAL: "hx", EDITOR: "ex" })).toBe("hx");
    expect(resolveEditorSpec({ EDITOR: "ex" })).toBe("ex");
    expect(resolveEditorSpec({})).toBe("vi");
    expect(resolveEditorSpec({ VISUAL: undefined, EDITOR: undefined })).toBe("vi");
  });

  test("空值 / 纯空白视为未设，落到下一优先级", () => {
    expect(resolveEditorSpec({ VISUAL: "", EDITOR: "ex" })).toBe("ex");
    expect(resolveEditorSpec({ VISUAL: "   ", EDITOR: "ex" })).toBe("ex");
    expect(resolveEditorSpec({ VISUAL: "  " })).toBe("vi");
  });

  test("tokenize：空白拆分与引号聚合空格", () => {
    expect(tokenizeEditorCommand("code -w")).toEqual(["code", "-w"]);
    expect(tokenizeEditorCommand('"my editor" -w')).toEqual(["my editor", "-w"]);
    expect(tokenizeEditorCommand("'a b'  c")).toEqual(["a b", "c"]);
    expect(tokenizeEditorCommand("vi")).toEqual(["vi"]);
    expect(tokenizeEditorCommand("   ")).toEqual([]);
  });

  test("VISUAL 优先并按 token 拆分进 spawn（含 --wait 类参数透传）", async () => {
    const fh = makeFs();
    const sp = makeSpawn();
    await run({
      env: { VISUAL: "code --wait --new-window", EDITOR: "emacs" },
      fs: fh.fs,
      spawn: sp.fn,
    });
    expect(sp.calls).toHaveLength(1);
    expect(sp.calls[0]!.command).toBe("code");
    expect(sp.calls[0]!.args).toEqual(["--wait", "--new-window"]);
  });

  test("EDITOR 兜底；两者缺省回落 vi", async () => {
    const fhA = makeFs();
    const spA = makeSpawn();
    await run({ env: { EDITOR: "nano" }, fs: fhA.fs, spawn: spA.fn });
    expect(spA.calls[0]!.command).toBe("nano");

    const fhB = makeFs();
    const spB = makeSpawn();
    await run({ env: {}, fs: fhB.fs, spawn: spB.fn });
    expect(spB.calls[0]!.command).toBe("vi");
  });

  test("引号聚合的编辑器路径整体作为命令", async () => {
    const fh = makeFs();
    const sp = makeSpawn();
    await run({ env: { VISUAL: '"/opt/my editor/bin/ed" -w' }, fs: fh.fs, spawn: sp.fn });
    expect(sp.calls[0]!.command).toBe("/opt/my editor/bin/ed");
    expect(sp.calls[0]!.args).toEqual(["-w"]);
  });

  test("注入 env 快照原样传给 spawn", async () => {
    const fh = makeFs();
    const sp = makeSpawn();
    const env = { VISUAL: "vi", TERM: "xterm-256color" };
    await run({ env, fs: fh.fs, spawn: sp.fn });
    expect(sp.calls[0]!.env).toEqual(env);
  });
});

describe("editExternally —— 临时文件、BOM 与清理", () => {
  test("生命周期：prompt.md 落盘 → 读回 → finally 清理（路径一致）", async () => {
    const fh = makeFs({ readBack: "初始文本" });
    const sp = makeSpawn();
    const out = await run({ env: { VISUAL: "vi" }, fs: fh.fs, spawn: sp.fn });
    expect(fh.suffixes).toEqual(["prompt.md"]);
    expect(fh.written).toEqual([{ path: fh.tmp, text: "初始文本" }]);
    expect(fh.read).toEqual([fh.tmp]);
    expect(fh.unlinked).toEqual([fh.tmp]);
    expect(out).toEqual({ text: "初始文本", modified: false });
  });

  test("UTF-8 BOM 剥离：\\uFEFF 开头的回读正文被剥掉", async () => {
    const fh = makeFs({ readBack: "\uFEFF编辑后的正文" });
    const sp = makeSpawn();
    const out = await run({ env: { VISUAL: "vi" }, fs: fh.fs, spawn: sp.fn });
    expect(out.text).toBe("编辑后的正文");
    expect(out.modified).toBe(true); // 与初始文本不同
  });

  test("仅 BOM 差异不判为修改（剥离后与初始一致 → modified=false）", async () => {
    const fh = makeFs({ readBack: "\uFEFF初始文本" });
    const sp = makeSpawn();
    const out = await run({ env: { VISUAL: "vi" }, fs: fh.fs, spawn: sp.fn });
    expect(out.text).toBe("初始文本");
    expect(out.modified).toBe(false);
  });

  test("编辑器非零退出：抛结构化错误，finally 仍清理临时文件", async () => {
    const fh = makeFs();
    const sp = makeSpawn(1);
    expect(run({ env: { VISUAL: "vi" }, fs: fh.fs, spawn: sp.fn })).rejects.toThrow(
      "外部编辑器异常退出: vi (exit 1)",
    );
    await new Promise((r) => setTimeout(r, 0)); // 等 microtask 链走完
    expect(fh.unlinked).toEqual([fh.tmp]);
  });

  test("exit null（被信号终止）同样抛错并清理", async () => {
    const fh = makeFs();
    const sp = makeSpawn(null);
    await expect(run({ env: { EDITOR: "vi" }, fs: fh.fs, spawn: sp.fn })).rejects.toThrow(
      "外部编辑器异常退出: vi (exit null)",
    );
    expect(fh.unlinked).toEqual([fh.tmp]);
  });

  test("stripUtf8Bom 直测", () => {
    expect(stripUtf8Bom("\uFEFFabc")).toBe("abc");
    expect(stripUtf8Bom("abc")).toBe("abc");
    expect(stripUtf8Bom("\uFEFF")).toBe("");
    expect(stripUtf8Bom("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// edit-prompt 命令桥
// ---------------------------------------------------------------------------

describe("editPromptCommand —— 挂起与回填校验", () => {
  test("提交路径：suspend → editor → submitted 回填 → resume（顺序稳定）", async () => {
    const order: string[] = [];
    const submitted: string[] = [];
    const out = await editPromptCommand("旧稿", {
      editor: async (text) => {
        order.push("edit");
        return { text: `${text} 新增`, modified: true };
      },
      onSuspend: () => order.push("suspend"),
      onResume: () => order.push("resume"),
      onSubmitted: (t) => submitted.push(t),
    });
    expect(out).toEqual({ status: "submitted", text: "旧稿 新增", modified: true });
    expect(submitted).toEqual(["旧稿 新增"]);
    expect(order).toEqual(["suspend", "edit", "resume"]);
  });

  test("空文本 = 取消：返回原稿，onCancelled(empty)，不回填", async () => {
    const submitted: string[] = [];
    const cancelled: [string, string][] = [];
    const out = await editPromptCommand("原稿", {
      editor: async () => ({ text: "", modified: true }),
      onSubmitted: (t) => submitted.push(t),
      onCancelled: (reason, draft) => cancelled.push([reason, draft]),
    });
    expect(out.status).toBe("cancelled");
    if (out.status === "cancelled") {
      expect(out.reason).toBe("empty");
      expect(out.text).toBe("原稿");
    }
    expect(submitted).toHaveLength(0);
    expect(cancelled).toEqual([["empty", "原稿"]]);
  });

  test("纯空白视为空文本取消", async () => {
    const out = await editPromptCommand("原稿", {
      editor: async () => ({ text: "  \n\t ", modified: true }),
    });
    expect(out.status).toBe("cancelled");
    if (out.status === "cancelled") expect(out.reason).toBe("empty");
  });

  test("编辑器异常 = 取消：返回原稿，resume 仍触发，不向 TUI 外抛", async () => {
    const order: string[] = [];
    const cancelled: string[] = [];
    const out = await editPromptCommand("原稿", {
      editor: async () => {
        order.push("edit");
        throw new Error("editor crashed");
      },
      onSuspend: () => order.push("suspend"),
      onResume: () => order.push("resume"),
      onCancelled: (reason) => cancelled.push(reason),
    });
    expect(out.status).toBe("cancelled");
    if (out.status === "cancelled") {
      expect(out.reason).toBe("editor-error");
      expect(out.text).toBe("原稿");
    }
    expect(cancelled).toEqual(["editor-error"]);
    expect(order).toEqual(["suspend", "edit", "resume"]);
  });

  test("未改动提交：submitted 且 modified=false，仍走回填", async () => {
    const submitted: string[] = [];
    const out = await editPromptCommand("同文", {
      editor: async (text) => ({ text, modified: false }),
      onSubmitted: (t) => submitted.push(t),
    });
    expect(out.status).toBe("submitted");
    if (out.status === "submitted") {
      expect(out.modified).toBe(false);
      expect(out.text).toBe("同文");
    }
    expect(submitted).toEqual(["同文"]);
  });

  test("outcome 判别联合：submitted 与 cancelled 互斥字段完备", async () => {
    const ok: PromptEditOutcome = await editPromptCommand("", {
      editor: async () => ({ text: "x", modified: true }),
    });
    const bad: PromptEditOutcome = await editPromptCommand("", {
      editor: async () => ({ text: "", modified: false }),
    });
    expect("modified" in ok).toBe(true);
    expect("reason" in bad).toBe(true);
  });
});
