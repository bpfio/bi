/**
 * FX-F · mountMcpServers 集成验收（stdio 最小装配）。
 *
 * 最小 stdio echo server 作为子进程（bun 内联脚本落盘临时文件，零外呼），
 * 经 StdioClientTransport 真实连接并 tools/list + tools/call：
 *   - 工具面出现 mcp__<id>__echo；
 *   - execute 返回 echo 结果；
 *   - 坏 command → 结构化警告且不炸工具集；
 *   - url/SSE 型（无 command）→ 跳过 + 结构化警告，不启动子进程；
 *   - enabled=false → 完全跳过（含不告警）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountMcpServers } from "./mcp-mount";
import type { McpSection } from "../config/schema";

// 最小 MCP stdio echo server：逐行读 stdin JSON-RPC，应答 initialize/tools/list/tools/call。
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
    const text = (msg.params && msg.params.arguments && msg.params.arguments.text) ?? "";
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
	const dir = await mkdtemp(join(tmpdir(), "bi-mcp-echo-"));
	dirs.push(dir);
	const file = join(dir, "echo-server.mjs");
	await writeFile(file, ECHO_SERVER, "utf8");
	return file;
}

describe("FX-F mountMcpServers · stdio 最小装配", () => {
	test("echo server：工具面出现 mcp__<id>__echo，execute 返回 echo 结果", async () => {
		const server = await writeEchoServer();
		const warns: string[] = [];
		const mcp: McpSection = {
			servers: { echo1: { command: process.execPath, args: [server], env: {}, url: "", enabled: true } },
		};
		const { tools, closeAll } = await mountMcpServers(mcp, tmpdir(), { warn: (l) => warns.push(l) });
		try {
			const names = tools.map((t) => t.definition.name);
			expect(names).toContain("mcp__echo1__echo");
			const echo = tools.find((t) => t.definition.name === "mcp__echo1__echo")!;
			const out = await echo.execute({ text: "hello-fx" }, new AbortController().signal);
			expect(typeof out).toBe("string");
			expect(out).toContain("hello-fx");
		} finally {
			await closeAll();
		}
		expect(warns).toHaveLength(0);
	});

	test("坏 command：结构化警告且工具面不炸（无工具、不抛）", async () => {
		const warns: string[] = [];
		const mcp: McpSection = {
			servers: {
				bad1: { command: "no-such-binary-xyz-12345", args: [], env: {}, url: "", enabled: true },
			},
		};
		const { tools, closeAll } = await mountMcpServers(mcp, tmpdir(), { warn: (l) => warns.push(l) });
		try {
			expect(tools).toHaveLength(0);
		} finally {
			await closeAll();
		}
		expect(warns).toHaveLength(1);
		expect(warns[0]).toContain("bi: mcp server bad1 装配失败");
	});

	test("SSE 型（无 command）：跳过 + 结构化警告，不启动子进程", async () => {
		const warns: string[] = [];
		const mcp: McpSection = {
			servers: {
				sse1: { command: "", args: [], env: {}, url: "http://localhost:9999/mcp", enabled: true },
			},
		};
		const { tools, closeAll } = await mountMcpServers(mcp, tmpdir(), { warn: (l) => warns.push(l) });
		try {
			expect(tools).toHaveLength(0);
		} finally {
			await closeAll();
		}
		expect(warns).toHaveLength(1);
		expect(warns[0]).toContain("bi: mcp server sse1 SSE 型本轮未支持");
	});

	test("enabled=false：完全跳过（含不告警）", async () => {
		const server = await writeEchoServer();
		const warns: string[] = [];
		const mcp: McpSection = {
			servers: { off1: { command: process.execPath, args: [server], env: {}, url: "", enabled: false } },
		};
		const { tools, closeAll } = await mountMcpServers(mcp, tmpdir(), { warn: (l) => warns.push(l) });
		try {
			expect(tools).toHaveLength(0);
		} finally {
			await closeAll();
		}
		expect(warns).toHaveLength(0);
	});
});
