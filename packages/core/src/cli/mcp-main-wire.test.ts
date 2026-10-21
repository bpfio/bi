/**
 * FIX-A F2 · MCP 挂载与 [ptc] 解耦验收（main 装配面）。
 *
 * 关注面：
 * - config [mcp.servers] 非空即挂载（**不配 [ptc] 也挂**）——远端工具以
 *   mcp__<id>__<tool> 命名进无头会话工具面（模型可见）。
 * - [mcp.servers] 为空（缺省）→ 不挂载任何 MCP 工具（缺省零行为差）。
 * - [ptc] 仍只管 run_ptc_script 工具（不因本次改动而增减）。
 *
 * 最小 stdio echo server 作子进程（bun 内联脚本落盘临时文件，零外呼）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBi } from "./main";
import type { ModelPort } from "./headless";
import type { StreamEvent } from "../adapters/deepseek-adapter";
import { createDefaultConfig, type BiConfig } from "../config/schema";

const ECHO_SERVER = `
let buf = "";
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
function handle(line) {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch { return; }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "echo", version: "1.0.0" } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [ { name: "echo", description: "回显文本", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } ] } });
  } else if (msg.method === "tools/call") {
    const text = (msg.params && msg.params.arguments && msg.params.arguments.text) || "";
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [ { type: "text", text: String(text) } ], isError: false } });
  }
}
for await (const chunk of process.stdin) {
  const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
  buf += text;
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    handle(line);
  }
}
`;

let dirs: string[] = [];

afterEach(async () => {
	await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
	dirs = [];
});

async function writeEchoServer(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "bi-mcp-wire-"));
	dirs.push(dir);
	const file = join(dir, "echo-server.mjs");
	await writeFile(file, ECHO_SERVER, "utf8");
	return file;
}

/** 记录模型收到的工具名集合。 */
function scriptedModel(): { port: ModelPort; toolNames: () => string[] } {
	const seen: string[] = [];
	const port: ModelPort = {
		async *stream(input): AsyncGenerator<StreamEvent> {
			seen.push(...input.tools.map((t) => t.name));
			yield { type: "content_delta", delta: "好。" };
			yield { type: "done", stopReason: "stop" };
		},
	};
	return { port, toolNames: () => [...seen] };
}

function configWith(patch: (config: BiConfig) => void): BiConfig {
	const config = createDefaultConfig();
	patch(config);
	return config;
}

describe("FIX-A F2 · [mcp.servers] 非空即挂载（与 [ptc] 解耦）", () => {
	test("配了 [mcp.servers] 但未配 [ptc]：MCP 远端工具仍进无头会话工具面", async () => {
		const server = await writeEchoServer();
		const root = await mkdtemp(join(tmpdir(), "bi-mcp-wire-"));
		dirs.push(root);
		const { port, toolNames } = scriptedModel();
		const code = await runBi(["--prompt", "用 echo 打个招呼"], {
			model: port,
			out: () => {},
			err: () => {},
			config: configWith((c) => {
				c.mcp.servers = {
					echo1: { command: process.execPath, args: [server], env: {}, url: "", enabled: true },
				};
				// [ptc] 未声明（enabled 缺省 false）——旧行为下 MCP 静默不挂载。
			}),
			headless: { cwd: root, sessionsRoot: join(root, "sessions") },
		});
		expect(code).toBe(0);
		expect(toolNames()).toContain("mcp__echo1__echo");
	});

	test("[mcp.servers] 为空（缺省）：工具面不含任何 mcp__ 工具（零行为差）", async () => {
		const root = await mkdtemp(join(tmpdir(), "bi-mcp-wire-"));
		dirs.push(root);
		const { port, toolNames } = scriptedModel();
		const code = await runBi(["--prompt", "你好"], {
			model: port,
			out: () => {},
			err: () => {},
			config: configWith(() => {}),
			headless: { cwd: root, sessionsRoot: join(root, "sessions") },
		});
		expect(code).toBe(0);
		expect(toolNames().filter((n) => n.startsWith("mcp__"))).toEqual([]);
	});
});
