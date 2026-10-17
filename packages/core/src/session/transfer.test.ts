import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./manager";
import {
  exportSanitized,
  importSanitized,
  sanitizeMessages,
  structuralFingerprint,
  TransferError,
} from "./transfer";
import type { JsonValue, SessionEntry } from "./types";

let dir: string | undefined;

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

/** 独立临时根 + workspace/home 双目录注入（绝不触碰真实 ~/.bi）。 */
async function makeFixture(): Promise<{ ws: string; home: string; manager: SessionManager }> {
  dir = await mkdtemp(join(tmpdir(), "bi-transfer-"));
  const ws = join(dir, "ws");
  const home = join(dir, "home");
  return { ws, home, manager: new SessionManager({ rootDir: join(dir, "sessions") }) };
}

let nextRawId = 0;

/** 构造裸条目（绕过 manager，用于脱敏矩阵测试）。 */
function rawEntry(overrides: Partial<SessionEntry> & { payload: JsonValue }): SessionEntry {
  nextRawId += 1;
  return {
    id: overrides.id ?? `raw-${String(nextRawId).padStart(4, "0")}`,
    parentId: overrides.parentId ?? null,
    type: overrides.type ?? "assistant",
    payload: overrides.payload,
    createdAt: overrides.createdAt ?? 1700000000000,
    seq: overrides.seq ?? nextRawId,
    ...(overrides.toolCallId !== undefined ? { toolCallId: overrides.toolCallId } : {}),
    ...(overrides.toolName !== undefined ? { toolName: overrides.toolName } : {}),
  };
}

describe("sanitizeMessages · 路径脱敏", () => {
  test("workspace 绝对路径 → 占位，文件名（扩展名）保留", () => {
    const out = sanitizeMessages(
      [rawEntry({ payload: { text: "看下 /tmp/x/ws/src/app.py 的实现" } })],
      { workspaceRoot: "/tmp/x/ws", homeDir: "" },
    );
    expect(out).toHaveLength(1);
    expect((out[0]?.payload as { text: string }).text).toBe(
      "看下 [redacted:path:p1:app.py] 的实现",
    );
  });

  test("同一路径多次出现 → 同一占位 id（对照调试稳定）", () => {
    const out = sanitizeMessages(
      [
        rawEntry({ payload: { text: "/tmp/x/ws/a.ts 和 /tmp/x/ws/a.ts" } }),
      ],
      { workspaceRoot: "/tmp/x/ws", homeDir: "" },
    );
    expect((out[0]?.payload as { text: string }).text).toBe(
      "[redacted:path:p1:a.ts] 和 [redacted:path:p1:a.ts]",
    );
  });

  test("不同路径 → 按首现顺序分配递增 id", () => {
    const out = sanitizeMessages(
      [rawEntry({ payload: { text: "/tmp/x/ws/b.ts 然后 /tmp/x/ws/c.ts" } })],
      { workspaceRoot: "/tmp/x/ws", homeDir: "" },
    );
    expect((out[0]?.payload as { text: string }).text).toBe(
      "[redacted:path:p1:b.ts] 然后 [redacted:path:p2:c.ts]",
    );
  });

  test("home 目录之下路径同样脱敏", () => {
    const out = sanitizeMessages(
      [rawEntry({ payload: { text: "配置在 /home/alice/notes/config.json" } })],
      { workspaceRoot: "/tmp/x/ws", homeDir: "/home/alice" },
    );
    expect((out[0]?.payload as { text: string }).text).toBe(
      "配置在 [redacted:path:p1:config.json]",
    );
  });

  test("根目录之外的路径原样保留", () => {
    const out = sanitizeMessages(
      [rawEntry({ payload: { text: "外部依赖 /opt/other/lib.so 不动" } })],
      { workspaceRoot: "/tmp/x/ws", homeDir: "" },
    );
    expect((out[0]?.payload as { text: string }).text).toBe(
      "外部依赖 /opt/other/lib.so 不动",
    );
  });

  test("目录形路径（根本身）→ 无文件名段的占位", () => {
    const out = sanitizeMessages(
      [rawEntry({ payload: { text: "项目在 /tmp/x/ws 下" } })],
      { workspaceRoot: "/tmp/x/ws", homeDir: "" },
    );
    expect((out[0]?.payload as { text: string }).text).toBe("项目在 [redacted:path:p1] 下");
  });

  test("file:line 形态 → 路径占位 + 行号保留", () => {
    const out = sanitizeMessages(
      [rawEntry({ payload: { text: "报错在 /tmp/x/ws/src/a.ts:42 附近" } })],
      { workspaceRoot: "/tmp/x/ws", homeDir: "" },
    );
    expect((out[0]?.payload as { text: string }).text).toBe(
      "报错在 [redacted:path:p1:a.ts]:42 附近",
    );
  });

  test("homeDir 传空串可关闭 home 匹配（默认 homedir 不再介入）", () => {
    const out = sanitizeMessages(
      [rawEntry({ payload: { text: "/home/anyone/a.ts" } })],
      { workspaceRoot: "/tmp/x/ws", homeDir: "" },
    );
    expect((out[0]?.payload as { text: string }).text).toBe("/home/anyone/a.ts");
  });

  test("中文目录与文件名：占位保留多字节文件名语义", () => {
    const out = sanitizeMessages(
      [rawEntry({ payload: { text: "修改 /tmp/x/ws/目录/文件.ts 的注释" } })],
      { workspaceRoot: "/tmp/x/ws", homeDir: "" },
    );
    expect((out[0]?.payload as { text: string }).text).toBe(
      "修改 [redacted:path:p1:文件.ts] 的注释",
    );
  });
});

describe("sanitizeMessages · 提示词脱敏", () => {
  test("user 条目字符串 payload → 提示词占位（内部路径一并覆盖）", () => {
    const out = sanitizeMessages(
      [rawEntry({ type: "user", payload: "请帮我看看 /tmp/x/ws/a.ts" })],
      { workspaceRoot: "/tmp/x/ws", homeDir: "" },
    );
    expect(out[0]?.payload).toBe("[redacted:prompt:t1]");
  });

  test("user 条目对象 payload：text 字段占位，其余字段保留", () => {
    const out = sanitizeMessages(
      [rawEntry({ type: "user", payload: { text: "问题A", mode: "fast", retries: 2 } })],
      { workspaceRoot: "/tmp/x/ws", homeDir: "" },
    );
    expect(out[0]?.payload).toEqual({ text: "[redacted:prompt:t1]", mode: "fast", retries: 2 });
  });

  test("相同提示词文本 → 同一占位 id；不同文本递增", () => {
    const out = sanitizeMessages(
      [
        rawEntry({ type: "user", payload: { text: "重复的问题" } }),
        rawEntry({ type: "user", payload: { text: "重复的问题" } }),
        rawEntry({ type: "user", payload: { text: "另一个问题" } }),
      ],
      { workspaceRoot: "/tmp/x/ws", homeDir: "" },
    );
    expect(out[0]?.payload).toEqual({ text: "[redacted:prompt:t1]" });
    expect(out[1]?.payload).toEqual({ text: "[redacted:prompt:t1]" });
    expect(out[2]?.payload).toEqual({ text: "[redacted:prompt:t2]" });
  });

  test("assistant 文本不按提示词脱敏（只做路径脱敏）", () => {
    const out = sanitizeMessages(
      [rawEntry({ type: "assistant", payload: { text: "回答：见 /tmp/x/ws/a.ts" } })],
      { workspaceRoot: "/tmp/x/ws", homeDir: "" },
    );
    expect(out[0]?.payload).toEqual({ text: "回答：见 [redacted:path:p1:a.ts]" });
  });
});

describe("sanitizeMessages · patch/diff 脱敏", () => {
  test("patch 键：代码行占位，diff --git/index/文件头/hunk 头保留，头内绝对路径脱敏", () => {
    const diff = [
      "diff --git a/app.py b/app.py",
      "index 111..222 100644",
      "--- /tmp/x/ws/app.py",
      "+++ /tmp/x/ws/app.py",
      "@@ -1,2 +1,2 @@",
      "-old secret",
      "+new secret",
      " context",
      "",
    ].join("\n");
    const out = sanitizeMessages(
      [rawEntry({ type: "tool_call", toolName: "edit", payload: { patch: diff } })],
      { workspaceRoot: "/tmp/x/ws", homeDir: "" },
    );
    expect(out[0]?.payload).toEqual({
      patch: [
        "diff --git a/app.py b/app.py",
        "index 111..222 100644",
        "--- [redacted:path:p1:app.py]",
        "+++ [redacted:path:p1:app.py]",
        "@@ -1,2 +1,2 @@",
        "-[redacted:patch:c1]",
        "+[redacted:patch:c2]",
        " [redacted:patch:c3]",
        "",
      ].join("\n"),
    });
  });

  test("hunk 计数驱动：hunk 内以 --- 开头的被删行不会被误判为文件头", () => {
    const diff = ["@@ -1,1 +1,1 @@", "--- secret line", "+new line"].join("\n");
    const out = sanitizeMessages(
      [rawEntry({ type: "tool_call", payload: { diff } })],
      { workspaceRoot: "/tmp/x/ws", homeDir: "" },
    );
    expect(out[0]?.payload).toEqual({
      diff: ["@@ -1,1 +1,1 @@", "-[redacted:patch:c1]", "+[redacted:patch:c2]"].join("\n"),
    });
  });

  test("无 patch 键但字符串以 diff --git 开头 → 仍按 patch 脱敏", () => {
    const diff = ["diff --git a/x.py b/x.py", "@@ -1,1 +1,1 @@", "+patched"].join("\n");
    const out = sanitizeMessages(
      [rawEntry({ type: "tool_call", payload: { content: diff } })],
      { workspaceRoot: "/tmp/x/ws", homeDir: "" },
    );
    expect(out[0]?.payload).toEqual({
      content: ["diff --git a/x.py b/x.py", "@@ -1,1 +1,1 @@", "+[redacted:patch:c1]"].join(
        "\n",
      ),
    });
  });
});

describe("sanitizeMessages · 结构保留（脱敏的是内容不是结构）", () => {
  test("id/parentId/type/createdAt/seq/toolCallId/toolName 全部原样", () => {
    const raw = rawEntry({
      id: "keep-1",
      parentId: "keep-0",
      type: "tool_result",
      toolCallId: "call-9",
      toolName: "edit",
      createdAt: 1720000000123,
      seq: 7,
      payload: { output: "ok /tmp/x/ws/a.ts" },
    });
    const out = sanitizeMessages([raw], { workspaceRoot: "/tmp/x/ws", homeDir: "" });
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("keep-1");
    expect(out[0]?.parentId).toBe("keep-0");
    expect(out[0]?.type).toBe("tool_result");
    expect(out[0]?.createdAt).toBe(1720000000123);
    expect(out[0]?.seq).toBe(7);
    expect(out[0]?.toolCallId).toBe("call-9");
    expect(out[0]?.toolName).toBe("edit");
  });

  test("Token 消耗底账（usage 数值）原样保留", () => {
    const out = sanitizeMessages(
      [
        rawEntry({
          payload: { text: "答 /tmp/x/ws/a.ts", usage: { input: 120, output: 34, cache: 0 } },
        }),
      ],
      { workspaceRoot: "/tmp/x/ws", homeDir: "" },
    );
    expect(out[0]?.payload).toEqual({
      text: "答 [redacted:path:p1:a.ts]",
      usage: { input: 120, output: 34, cache: 0 },
    });
  });

  test("tool_call 参数形状保留：键结构与非路径标量不动，路径字符串占位", () => {
    const out = sanitizeMessages(
      [
        rawEntry({
          type: "tool_call",
          toolName: "read",
          payload: { args: { path: "/tmp/x/ws/src/a.ts", depth: 3, recursive: true } },
        }),
      ],
      { workspaceRoot: "/tmp/x/ws", homeDir: "" },
    );
    expect(out[0]?.payload).toEqual({
      args: { path: "[redacted:path:p1:a.ts]", depth: 3, recursive: true },
    });
  });
});

describe("sanitizeMessages · 容错与边界", () => {
  test("恶意/畸形条目被丢弃，合法条目不受影响，绝不抛异常", () => {
    const good = rawEntry({ payload: { text: "ok" } });
    const out = sanitizeMessages(
      [
        null as unknown as SessionEntry,
        42 as unknown as SessionEntry,
        "string" as unknown as SessionEntry,
        {} as unknown as SessionEntry,
        rawEntry({ id: "", payload: null }),
        rawEntry({ id: "bad-type", type: "bogus" as unknown as SessionEntry["type"], payload: null }),
        { id: "no-payload", parentId: null, type: "user", createdAt: 1, seq: 1 },
        good,
      ],
      { workspaceRoot: "/tmp/x/ws", homeDir: "" },
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe(good.id);
  });

  test("空数组 → 空输出", () => {
    expect(sanitizeMessages([], { workspaceRoot: "/tmp/x/ws" })).toEqual([]);
  });

  test("空字符串不做占位替换", () => {
    const out = sanitizeMessages(
      [rawEntry({ type: "user", payload: { text: "" } })],
      { workspaceRoot: "/tmp/x/ws" },
    );
    expect(out[0]?.payload).toEqual({ text: "" });
  });
});

describe("structuralFingerprint", () => {
  test("与具体 id 无关：整体重映射 id/parentId 后指纹一致", () => {
    const entries = [
      rawEntry({ id: "a1", parentId: null, type: "user", payload: null }),
      rawEntry({ id: "a2", parentId: "a1", type: "assistant", payload: null }),
      rawEntry({ id: "a3", parentId: "a2", type: "tool_call", toolName: "edit", payload: null }),
    ];
    const remapped = [
      { id: "b9", parentId: null, type: "user" },
      { id: "b8", parentId: "b9", type: "assistant" },
      { id: "b7", parentId: "b8", type: "tool_call", toolName: "edit" },
    ];
    expect(structuralFingerprint(entries)).toBe(structuralFingerprint(remapped));
  });

  test("树形状/类型序列不同 → 指纹不同", () => {
    const base = [
      rawEntry({ id: "a1", parentId: null, type: "user", payload: null }),
      rawEntry({ id: "a2", parentId: "a1", type: "assistant", payload: null }),
    ];
    const branched = [
      base[0] as SessionEntry,
      base[1] as SessionEntry,
      rawEntry({ id: "a3", parentId: "a2", type: "system", payload: null }),
    ];
    expect(structuralFingerprint(base)).not.toBe(structuralFingerprint(branched));
  });
});

describe("exportSanitized / importSanitized · 往返", () => {
  /** 构造含分支的会话：根 → assistant → tool_call → tool_result；assistant 另分支出 user → system。 */
  async function makeTreeSession(manager: SessionManager): Promise<string> {
    const meta = await manager.createSession({ title: "拓扑会话", cwd: "/tmp/x/ws" });
    const sid = meta.sessionId;
    const root = await manager.append(sid, null, {
      type: "user",
      payload: { text: "修一下 /tmp/x/ws/src/app.py 的编译错误" },
    });
    const reply = await manager.append(sid, root.id, {
      type: "assistant",
      payload: { text: "看 /tmp/x/ws/src/app.py:42", usage: { input: 10, output: 5 } },
    });
    const call = await manager.append(sid, reply.id, {
      type: "tool_call",
      toolName: "edit",
      toolCallId: "call-1",
      payload: {
        args: { path: "/tmp/x/ws/src/app.py" },
        patch: "@@ -1,1 +1,1 @@\n-broken\n+fixed\n",
      },
    });
    await manager.append(sid, call.id, {
      type: "tool_result",
      toolName: "edit",
      toolCallId: "call-1",
      payload: { output: "ok" },
    });
    const branch = await manager.append(sid, reply.id, {
      type: "user",
      payload: { text: "换个思路重试" },
    });
    await manager.append(sid, branch.id, { type: "system", payload: "note" });
    return sid;
  }

  test("导出：meta.cwd 占位、计数、指纹齐备，条目全部脱敏", async () => {
    const { manager } = await makeFixture();
    const sid = await makeTreeSession(manager);
    const archive = await exportSanitized(manager, sid);
    expect(archive.meta.sessionId).toBe(sid);
    expect(archive.meta.title).toBe("拓扑会话");
    expect(archive.meta.cwd).toBe("[redacted:path:p1]");
    expect(archive.meta.version).toBe(1);
    expect(archive.meta.counts.entries).toBe(6);
    expect(archive.meta.counts.byType).toEqual({
      user: 2,
      assistant: 1,
      tool_call: 1,
      tool_result: 1,
      system: 1,
    });
    expect(archive.meta.fingerprint).toBe(structuralFingerprint(archive.entries));
    const call = archive.entries.find((entry) => entry.type === "tool_call");
    expect(call?.toolName).toBe("edit");
    expect(call?.toolCallId).toBe("call-1");
    expect(JSON.stringify(call?.payload)).not.toContain("/tmp/x/ws");
    expect(JSON.stringify(archive)).not.toContain("/tmp/x/ws");
  });

  test("导出：会话不存在 / 损坏 → 结构化错误", async () => {
    const { manager } = await makeFixture();
    try {
      await exportSanitized(manager, "ghost1");
      throw new Error("应抛 session-missing");
    } catch (error) {
      expect(error).toBeInstanceOf(TransferError);
      expect((error as TransferError).code).toBe("session-missing");
    }
    await mkdir(manager.rootDir, { recursive: true });
    await writeFile(join(manager.rootDir, "corrupt1.jsonl"), "not-json-at-all\n", "utf8");
    try {
      await exportSanitized(manager, "corrupt1");
      throw new Error("应抛 session-corrupt");
    } catch (error) {
      expect(error).toBeInstanceOf(TransferError);
      expect((error as TransferError).code).toBe("session-corrupt");
    }
  });

  test("往返：结构指纹/类型序列/计数/payload 内容一致，旧→新 id 1:1 且父子对应", async () => {
    const a = await makeFixture();
    const sid = await makeTreeSession(a.manager);
    const archive = await exportSanitized(a.manager, sid);

    const b = await makeFixture();
    const imported = await importSanitized(JSON.parse(JSON.stringify(archive)), b.manager);

    expect(imported.sessionId).toBe(sid);
    expect(imported.entries).toHaveLength(archive.entries.length);
    expect(structuralFingerprint(imported.entries)).toBe(archive.meta.fingerprint);
    expect(structuralFingerprint(imported.entries)).toBe(
      structuralFingerprint(archive.entries),
    );
    expect(imported.entries.map((entry) => entry.type)).toEqual(
      archive.entries.map((entry) => entry.type),
    );
    // 旧 id → 新 id 一一对应，parentId 关系随之换算（树形状保真）。
    const idMap = new Map<string, string>();
    archive.entries.forEach((entry, index) => {
      const fresh = imported.entries[index];
      expect(fresh).toBeDefined();
      if (fresh !== undefined) idMap.set(entry.id, fresh.id);
    });
    expect(idMap.size).toBe(archive.entries.length);
    archive.entries.forEach((entry, index) => {
      const fresh = imported.entries[index];
      expect(fresh).toBeDefined();
      if (fresh === undefined) return;
      if (entry.parentId === null) {
        expect(fresh.parentId).toBeNull();
      } else {
        const expectedParent = idMap.get(entry.parentId);
        expect(expectedParent).toBeDefined();
        if (expectedParent !== undefined) expect(fresh.parentId).toBe(expectedParent);
      }
      expect(JSON.stringify(fresh.payload)).toBe(JSON.stringify(entry.payload));
      expect(fresh.toolName).toBe(entry.toolName);
      expect(fresh.toolCallId).toBe(entry.toolCallId);
      expect(fresh.seq).toBe(entry.seq);
    });
    // 导入侧全文件不含任何真实路径残留。
    expect(JSON.stringify(imported)).not.toContain("/tmp/x/ws");
  });

  test("导入：空条目归档 → 空会话创建成功", async () => {
    const { manager } = await makeFixture();
    const imported = await importSanitized(
      { meta: { sessionId: "empty1", title: "空会话" }, entries: [] },
      manager,
    );
    expect(imported.entries).toHaveLength(0);
    const entries = await manager.entries("empty1");
    expect(entries).toHaveLength(0);
  });

  test("导入：目标会话已存在 → session-exists", async () => {
    const { manager } = await makeFixture();
    const archive = { meta: { sessionId: "dup1", title: "t" }, entries: [] };
    await importSanitized(archive, manager);
    try {
      await importSanitized(archive, manager);
      throw new Error("应抛 session-exists");
    } catch (error) {
      expect((error as TransferError).code).toBe("session-exists");
    }
  });

  test("导入：恶意归档矩阵 → invalid-archive（不落半成品）", async () => {
    const { manager } = await makeFixture();
    const cases: unknown[] = [
      null,
      "string",
      42,
      {},
      { entries: [] },
      { meta: { sessionId: "../escape", title: "t" }, entries: [] },
      { meta: { sessionId: "ok1" }, entries: "nope" },
      { meta: { sessionId: "ok1" }, entries: ["nope"] },
      { meta: { sessionId: "ok1" }, entries: [{ id: "x", parentId: null, type: "user" }] },
      {
        meta: { sessionId: "ok1" },
        entries: [
          { id: "x", parentId: null, type: "user", payload: null },
          { id: "x", parentId: "x", type: "system", payload: null },
        ],
      },
      {
        meta: { sessionId: "ok1" },
        entries: [{ id: "x", parentId: "ghost", type: "user", payload: null }],
      },
      {
        meta: { sessionId: "ok1" },
        entries: [
          { id: "x", parentId: null, type: "user", payload: null },
          { id: "y", parentId: null, type: "system", payload: null },
        ],
      },
      {
        meta: { sessionId: "ok1" },
        entries: [{ id: "x", parentId: null, type: "nope", payload: null }],
      },
    ];
    for (const bad of cases) {
      try {
        await importSanitized(bad, manager);
        throw new Error(`应抛 invalid-archive: ${JSON.stringify(bad)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(TransferError);
        expect((error as TransferError).code).toBe("invalid-archive");
      }
    }
    // 全部被拒后不产生任何半成品会话。
    const sessions = await manager.listSessions();
    expect(sessions).toHaveLength(0);
  });
});
