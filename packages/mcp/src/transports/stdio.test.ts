import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpClient, type McpInitializeResult } from "../client";
import {
	JsonRpcErrorCode,
	McpError,
	type StdioRestartEvent,
	type TransportCloseEvent,
} from "../protocol";
import { StdioClientTransport } from "./stdio";

/**
 * MCP stdio fixture 服务器（由本测试写入临时目录，用 bun 运行）。
 * 实现 initialize / tools/list / tools/call(echo|boom|hang|crash) / ping，
 * 附 stderr 诊断输出；环境开关：
 *   MCP_FIXTURE_CRASH_ON_CALL  收到指定 tools/call 名称立即 exit(70)，不回包
 *   MCP_FIXTURE_STDERR_FLOOD   启动时先向 stderr 写 N 字节噪声，再写 ready 行
 *   MCP_FIXTURE_MALFORMED      首条请求处理前向 stdout 写一行非法 JSON
 *   MCP_FIXTURE_DELAYED_ECHO   echo 回包按 id 奇偶乱序延迟，验证按 id 关联
 *   MCP_FIXTURE_IGNORE_SIGTERM 置 1 时吞掉 SIGTERM（用于验证宽限后 SIGKILL 升级）
 */
const FIXTURE_SOURCE = String.raw`const env = process.env;

if (env.MCP_FIXTURE_STDERR_FLOOD) {
  process.stderr.write("x".repeat(Number(env.MCP_FIXTURE_STDERR_FLOOD)) + "\n");
}
process.stderr.write("mcp-fixture: ready\n");
process.on("SIGTERM", function () {
  if (!env.MCP_FIXTURE_IGNORE_SIGTERM) { process.exit(0); }
});

function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function respond(id, result) { send({ jsonrpc: "2.0", id: id, result: result }); }
function respondError(id, code, message) { send({ jsonrpc: "2.0", id: id, error: { code: code, message: message } }); }

var TOOLS = [
  { name: "echo", description: "回显输入文本", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  { name: "boom", description: "返回 isError=true 的调用结果", inputSchema: { type: "object" } },
  { name: "hang", description: "永不回包", inputSchema: { type: "object" } },
  { name: "crash", description: "让服务器进程立即退出", inputSchema: { type: "object" } }
];

var malformedSent = false;

function handleLine(line) {
  if (env.MCP_FIXTURE_MALFORMED && !malformedSent) {
    malformedSent = true;
    process.stdout.write("<<<not-json>>>\n");
  }
  var msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.method === "initialize") {
    respond(msg.id, {
      protocolVersion: (msg.params && msg.params.protocolVersion) || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "mcp-fixture", version: "0.1.0" }
    });
    return;
  }
  if (msg.method === "notifications/initialized") { return; }
  if (msg.method === "ping") { respond(msg.id, {}); return; }
  if (msg.method === "tools/list") { respond(msg.id, { tools: TOOLS }); return; }
  if (msg.method === "tools/call") {
    var name = msg.params && msg.params.name;
    if (env.MCP_FIXTURE_CRASH_ON_CALL && name === env.MCP_FIXTURE_CRASH_ON_CALL) {
      process.stderr.write("mcp-fixture: crash on " + name + "\n");
      process.exit(70);
    }
    if (name === "echo") {
      var text = (msg.params && msg.params.arguments && msg.params.arguments.text) || "";
      if (env.MCP_FIXTURE_DELAYED_ECHO) {
        var delay = msg.id % 2 === 0 ? 1 : 20;
        setTimeout(function () { respond(msg.id, { content: [{ type: "text", text: text }], isError: false }); }, delay);
      } else {
        respond(msg.id, { content: [{ type: "text", text: text }], isError: false });
      }
      return;
    }
    if (name === "boom") {
      respond(msg.id, { content: [{ type: "text", text: "boom failed" }], isError: true });
      return;
    }
    if (name === "hang") { return; }
    respondError(msg.id, -32602, "unknown tool: " + String(name));
    return;
  }
  if (msg.id !== undefined) { respondError(msg.id, -32601, "method not found: " + String(msg.method)); }
}

var decoder = new TextDecoder();
var buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  var idx = buffer.indexOf("\n");
  while (idx !== -1) {
    var line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line.length > 0) { handleLine(line); }
    idx = buffer.indexOf("\n");
  }
}
`;

let fixturePath: string | null = null;
async function getFixturePath(): Promise<string> {
	if (fixturePath === null) {
		const dir = await mkdtemp(join(tmpdir(), "bi-mcp-fixture-"));
		fixturePath = join(dir, "mcp-fixture-server.ts");
		await writeFile(fixturePath, FIXTURE_SOURCE, "utf8");
	}
	return fixturePath;
}

interface Harness {
	transport: StdioClientTransport;
	client: McpClient;
	initResult: McpInitializeResult;
	closeEvents: TransportCloseEvent[];
	restartEvents: StdioRestartEvent[];
}

const live: Harness[] = [];

async function connect(opts?: {
	env?: Record<string, string>;
	transport?: Partial<ConstructorParameters<typeof StdioClientTransport>[0]>;
	client?: ConstructorParameters<typeof McpClient>[1];
}): Promise<Harness> {
	const path = await getFixturePath();
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [path],
		env: opts?.env,
		killGraceMs: 3000,
		restartBackoffSleep: async () => {},
		...opts?.transport,
	});
	const client = new McpClient(transport, {
		requestTimeoutMs: 5000,
		...opts?.client,
	});
	const closeEvents: TransportCloseEvent[] = [];
	const restartEvents: StdioRestartEvent[] = [];
	transport.onClose((event) => closeEvents.push(event));
	transport.onRestart((event) => restartEvents.push(event));
	await transport.start();
	const harness: Harness = {
		transport,
		client,
		closeEvents,
		restartEvents,
		initResult: await client.initialize(),
	};
	live.push(harness);
	return harness;
}

afterEach(async () => {
	while (live.length > 0) {
		const harness = live.pop();
		if (harness) {
			try {
				await harness.client.close();
			} catch {
				// 已终态的实例忽略关闭错误
			}
		}
	}
});

async function expectMcpError(
	promise: Promise<unknown>,
	code: import("../protocol").McpErrorCode,
): Promise<McpError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(McpError);
		const mcpError = error as McpError;
		expect(mcpError.code).toBe(code);
		return mcpError;
	}
	throw new Error(`期望抛出 McpError(${code})，但请求成功了`);
}

function errorData<T>(error: McpError): T {
	return error.data as T;
}

async function waitFor(
	condition: () => boolean,
	timeoutMs = 4000,
	stepMs = 10,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("waitFor 等待超时");
		}
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
}

describe("stdio 传输：握手与会话", () => {
	test("initialize 握手成功，serverInfo 与协商版本回传", async () => {
		const { client, initResult } = await connect();
		expect(client.getState()).toBe("ready");
		expect(initResult.serverInfo.name).toBe("mcp-fixture");
		expect(initResult.protocolVersion).toBe("2025-06-18");
	});

	test("listTools 返回工具清单与 inputSchema", async () => {
		const { client } = await connect();
		const tools = await client.listTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual(["boom", "crash", "echo", "hang"]);
		const echo = tools.find((tool) => tool.name === "echo");
		expect(echo?.description).toBe("回显输入文本");
		expect((echo?.inputSchema as { type: string }).type).toBe("object");
	});

	test("callTool echo：content 数组透传", async () => {
		const { client } = await connect();
		const result = await client.callTool("echo", { text: "hello mcp" });
		expect(result.isError).toBe(false);
		expect(result.content).toEqual([{ type: "text", text: "hello mcp" }]);
	});

	test("callTool boom：isError=true 语义透传", async () => {
		const { client } = await connect();
		const result = await client.callTool("boom");
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "boom failed" }]);
	});

	test("ping 存活探测", async () => {
		const { client } = await connect();
		await expect(client.ping()).resolves.toBeUndefined();
	});

	test("并发请求按 id 关联（fixture 乱序回包）", async () => {
		const { client } = await connect({ env: { MCP_FIXTURE_DELAYED_ECHO: "1" } });
		const [first, second] = await Promise.all([
			client.callTool("echo", { text: "first" }),
			client.callTool("echo", { text: "second" }),
		]);
		expect(first.content).toEqual([{ type: "text", text: "first" }]);
		expect(second.content).toEqual([{ type: "text", text: "second" }]);
	});

	test("未知工具返回 rpc-error(-32602)", async () => {
		const { client } = await connect();
		const error = await expectMcpError(client.callTool("no-such-tool"), "rpc-error");
		expect(errorData<{ rpcCode: number }>(error).rpcCode).toBe(JsonRpcErrorCode.InvalidParams);
	});

	test("请求超时返回结构化 timeout 错误", async () => {
		const { client } = await connect({
			// 1000ms：既可容忍 bun 冷启动完成握手，又让 hang 工具的超时断言足够快
			client: { requestTimeoutMs: 1000 },
		});
		const error = await expectMcpError(client.callTool("hang"), "timeout");
		expect(errorData<{ timeoutMs: number; method: string }>(error).timeoutMs).toBe(1000);
		expect(errorData<{ timeoutMs: number; method: string }>(error).method).toBe("tools/call");
	});

	test("畸形 JSON 行被跳过并计数，会话不受影响", async () => {
		const { client, transport } = await connect({ env: { MCP_FIXTURE_MALFORMED: "1" } });
		expect(client.getState()).toBe("ready");
		expect(transport.getMalformedCount()).toBe(1);
		expect((await client.ping())).toBeUndefined();
	});

	test("stderr 有界缓冲：保留尾部并标记截断", async () => {
		const { transport } = await connect({
			env: { MCP_FIXTURE_STDERR_FLOOD: "3000" },
			transport: { maxStderrBytes: 128 },
		});
		await waitFor(() => transport.getStderrTail().includes("ready"));
		expect(transport.isStderrTruncated()).toBe(true);
		expect(transport.getStderrTail().length).toBeLessThanOrEqual(128);
		expect(transport.getStderrTail()).toContain("ready");
	});
});

describe("stdio 传输：进程生命周期", () => {
	test("spawn 失败：start() 以 spawn-failed 拒绝", async () => {
		const transport = new StdioClientTransport({ command: "/nonexistent-binary-xyz" });
		const error = await expectMcpError(transport.start(), "spawn-failed");
		expect(String(error.message)).toContain("/nonexistent-binary-xyz");
	});

	test("优雅关闭：SIGTERM 生效，closed 终态携带退出码 0", async () => {
		const { client, closeEvents } = await connect();
		await client.close();
		expect(client.getState()).toBe("closed");
		expect(closeEvents.length).toBe(1);
		expect(closeEvents[0]?.code).toBe("closed");
		expect(closeEvents[0]?.restarting).toBe(false);
		expect(closeEvents[0]?.exitCode).toBe(0);
	});

	test("宽限期未退出：升级 SIGKILL，终态携带信号名", async () => {
		const { client, closeEvents } = await connect({
			env: { MCP_FIXTURE_IGNORE_SIGTERM: "1" },
			transport: { killGraceMs: 300 },
		});
		await client.close();
		expect(closeEvents.length).toBe(1);
		expect(closeEvents[0]?.code).toBe("closed");
		expect(closeEvents[0]?.signal).toBe("SIGKILL");
		expect(client.getState()).toBe("closed");
	});

	test("进程崩溃：未决请求以 server-exited 拒绝并收到 onClose", async () => {
		const { client, closeEvents } = await connect({ env: { MCP_FIXTURE_CRASH_ON_CALL: "crash" } });
		const error = await expectMcpError(client.callTool("crash"), "server-exited");
		expect(error).toBeInstanceOf(McpError);
		await waitFor(() => closeEvents.length > 0);
		expect(closeEvents[0]?.code).toBe("server-exited");
		expect(closeEvents[0]?.restarting).toBe(false);
		expect(closeEvents[0]?.exitCode).toBe(70);
		expect(client.getState()).toBe("closed");
	});

	test("重启策略 once：崩溃后自动重启并重握手，会话恢复", async () => {
		const { client, closeEvents, restartEvents } = await connect({
			env: { MCP_FIXTURE_CRASH_ON_CALL: "crash" },
			transport: { restartPolicy: "once" },
		});
		await expectMcpError(client.callTool("crash"), "server-exited");
		await waitFor(() => client.getState() === "ready");
		expect(restartEvents.map((event) => event.attempt)).toEqual([1]);
		const result = await client.callTool("echo", { text: "reborn" });
		expect(result.content).toEqual([{ type: "text", text: "reborn" }]);
		expect(closeEvents.every((event) => event.code !== "restart-exhausted")).toBe(true);
	});

	test("重启次数用尽：restart-exhausted 终态，后续调用 transport-closed", async () => {
		const { client, closeEvents } = await connect({
			env: { MCP_FIXTURE_CRASH_ON_CALL: "crash" },
			transport: { restartPolicy: { maxRetries: 1, backoffMs: 5 } },
		});
		await expectMcpError(client.callTool("crash"), "server-exited");
		await waitFor(() => client.getState() === "ready");
		// 第二次崩溃：重启额度（1 次）已用尽 → 终态
		await expectMcpError(client.callTool("crash"), "restart-exhausted");
		await waitFor(() => closeEvents.some((event) => event.code === "restart-exhausted"));
		expect(client.getState()).toBe("closed");
		await expectMcpError(client.callTool("echo", { text: "x" }), "transport-closed");
	});

	test("重启窗口 fail-fast：请求立即以 restarting 拒绝", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { client } = await connect({
			env: { MCP_FIXTURE_CRASH_ON_CALL: "crash" },
			transport: {
				restartPolicy: { maxRetries: 1, backoffMs: 1 },
				restartBackoffSleep: () => gate,
			},
		});
		await expectMcpError(client.callTool("crash"), "server-exited");
		// 退避被 gate 挂起 → 重启窗口稳定
		await expectMcpError(client.callTool("echo", { text: "x" }), "restarting");
		release();
		await waitFor(() => client.getState() === "ready");
	});

	test("重启窗口 queue：请求排队至重握手后完成", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { client } = await connect({
			env: { MCP_FIXTURE_CRASH_ON_CALL: "crash" },
			transport: {
				restartPolicy: { maxRetries: 1, backoffMs: 1 },
				restartBackoffSleep: () => gate,
			},
			client: { restartBehavior: "queue" },
		});
		await expectMcpError(client.callTool("crash"), "server-exited");
		const queued = client.callTool("echo", { text: "queued" });
		expect(client.getState()).toBe("restarting");
		release();
		await waitFor(() => client.getState() === "ready");
		const result = await queued;
		expect(result.content).toEqual([{ type: "text", text: "queued" }]);
	});
});
