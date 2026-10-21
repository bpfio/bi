/**
 * FIX-A F4 · 续会话上下文重放验收（cli/resume-context.ts）。
 *
 * 关注面：
 * 1. resumeContextMessages：既有会话条目的 user/assistant 文本轮按序还原为模型
 *    消息；assistant 兼容 {text} 与 {content:[{type:"text",text}]} 双形态；
 *    tool 轮不重放；空文本/脏 payload 跳过。
 * 2. withResumeHistory：把重放历史前置到每次模型请求的 messages 首位；历史为空
 *    时原样返回端口（零行为差）。
 */
import { describe, expect, test } from "bun:test";
import { resumeContextMessages, withResumeHistory } from "./resume-context";
import type { ModelPort } from "./headless";
import type { StreamEvent } from "../adapters/deepseek-adapter";
import type { SessionEntry } from "../session/types";

function entry(partial: Partial<SessionEntry> & { type: SessionEntry["type"] }): SessionEntry {
  return {
    id: partial.id ?? "e1",
    parentId: partial.parentId ?? null,
    seq: partial.seq ?? 1,
    createdAt: partial.createdAt ?? 1,
    payload: partial.payload ?? null,
    ...partial,
  } as SessionEntry;
}

describe("FIX-A F4 · resumeContextMessages（历史重放）", () => {
  test("user/assistant 文本轮按序还原；tool 轮不重放", () => {
    const messages = resumeContextMessages([
      entry({ id: "e1", seq: 1, type: "user", payload: { text: "问" } }),
      entry({ id: "e2", seq: 2, type: "assistant", payload: { text: "答" } }),
      entry({ id: "e3", seq: 3, type: "tool_call", payload: { name: "bash" } }),
    ]);
    expect(messages).toEqual([
      { role: "user", content: "问" },
      { role: "assistant", content: "答" },
    ]);
  });

  test("assistant 的 {content:[{type:'text',text}]} 形态还原为文本", () => {
    const messages = resumeContextMessages([
      entry({ type: "assistant", payload: { content: [{ type: "text", text: "甲" }, { type: "text", text: "乙" }] } }),
    ]);
    expect(messages).toEqual([{ role: "assistant", content: "甲乙" }]);
  });

  test("空文本 / 脏 payload 跳过（绝不把脏数据喂进模型上下文）", () => {
    const messages = resumeContextMessages([
      entry({ id: "e1", type: "user", payload: { text: "" } }),
      entry({ id: "e2", type: "user", payload: null }),
      entry({ id: "e3", type: "user", payload: { text: 42 } }),
    ]);
    expect(messages).toEqual([]);
  });
});

describe("FIX-A F4 · withResumeHistory（模型端口包装）", () => {
  test("历史前置到每次请求的 messages 首位", async () => {
    const seen: string[][] = [];
    const port: ModelPort = {
      async *stream(input): AsyncGenerator<StreamEvent> {
        seen.push(input.messages.map((m) => `${m.role}:${m.content}`));
        yield { type: "done", stopReason: "stop" };
      },
    };
    const wrapped = withResumeHistory(port, [{ role: "user", content: "旧问" }]);
    for await (const _ of wrapped.stream({ messages: [{ role: "user", content: "新问" }], tools: [] })) {
      // 消费即可
    }
    expect(seen).toEqual([["user:旧问", "user:新问"]]);
  });

  test("历史为空：原样返回端口（零行为差）", () => {
    const port: ModelPort = {
      async *stream(): AsyncGenerator<StreamEvent> {
        yield { type: "done", stopReason: "stop" };
      },
    };
    expect(withResumeHistory(port, [])).toBe(port);
  });
});
