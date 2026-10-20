/**
 * X4 波次二 —— main 接线验收：config [tools] code_mode=true → 工具面含 run_js。
 *
 * e2e 面走 RunBiOptions.config 注入（model 替身，零磁盘零网络）：脚本化模型第一
 * 回合发起 run_js 工具调用，第二回合收尾；断言模型收到的 tool_result 含沙箱结果。
 * 缺省（未声明 code_mode）→ run_js 不在表 → 调用报 unknown-tool（工具面零变动）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBi } from "./main";
import type { ModelPort } from "./headless";
import type { AgentMessage, StreamEvent } from "../adapters/deepseek-adapter";
import { createDefaultConfig, type BiConfig } from "../config/schema";

function scriptedModel(rounds: StreamEvent[][]): {
  port: ModelPort;
  received: Array<{ messages: readonly AgentMessage[] }>;
} {
  const received: Array<{ messages: readonly AgentMessage[] }> = [];
  let cursor = 0;
  const port: ModelPort = {
    async *stream(input) {
      const round = rounds[cursor];
      cursor += 1;
      if (round === undefined) throw new Error(`scripted-model: 第 ${cursor} 回合无脚本`);
      received.push({ messages: [...input.messages] });
      for (const event of round) yield event;
    },
  };
  return { port, received };
}

function runJsCallRound(): StreamEvent[] {
  return [
    { type: "tool_call_delta", index: 0, id: "call_1", name: "run_js", argumentsDelta: '{"code":"6 * 7"}' },
    { type: "done", stopReason: "tool_use" },
  ];
}

function finalRound(): StreamEvent[] {
  return [{ type: "content_delta", delta: "完成。" }, { type: "done", stopReason: "stop" }];
}

function configWith(patch: (config: BiConfig) => void): BiConfig {
  const config = createDefaultConfig();
  patch(config);
  return config;
}

async function makeWorkspace(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "bi-codemode-main-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("X4 main: [tools] code_mode → run_js 工具面", () => {
  test("code_mode=true → run_js 注册且执行（tool_result 含沙箱结果 42）", async () => {
    const { root, cleanup } = await makeWorkspace();
    try {
      const { port, received } = scriptedModel([runJsCallRound(), finalRound()]);
      const code = await runBi(["--prompt", "hi"], {
        model: port,
        out: () => {},
        err: () => {},
        config: configWith((c) => {
          c.ptc = { enabled: true, timeout_ms: 30_000, max_tool_calls: 64 };
          c.tools.code_mode = true;
        }),
        headless: { cwd: root, sessionsRoot: join(root, "sessions") },
      });
      expect(code).toBe(0);
      const second = JSON.stringify(received[1]!.messages);
      expect(second).toContain("run_js");
      // tool_result content 为 run_js 沙箱输出 JSON 字符串
      const toolResult = received[1]!.messages.find((m) => JSON.stringify(m).includes("tool_result")) as unknown as {
        content: Array<{ type: string; content: string }>;
      };
      const block = toolResult.content.find((c) => c.type === "tool_result");
      expect(block).toBeDefined();
      expect(JSON.parse(block!.content)).toEqual({ ok: true, value: 42 });
    } finally {
      await cleanup();
    }
  });

  test("缺省（未声明 code_mode）→ run_js 不在工具面（调用报 unknown-tool）", async () => {
    const { root, cleanup } = await makeWorkspace();
    try {
      const { port, received } = scriptedModel([runJsCallRound(), finalRound()]);
      const code = await runBi(["--prompt", "hi"], {
        model: port,
        out: () => {},
        err: () => {},
        config: configWith((c) => {
          c.ptc = { enabled: true, timeout_ms: 30_000, max_tool_calls: 64 };
        }),
        headless: { cwd: root, sessionsRoot: join(root, "sessions") },
      });
      expect(code).toBe(0);
      const second = JSON.stringify(received[1]!.messages);
      expect(second).toContain("run_js");
      expect(second).toContain("unknown-tool");
      expect(second).not.toContain("\"value\":42");
    } finally {
      await cleanup();
    }
  });
});
