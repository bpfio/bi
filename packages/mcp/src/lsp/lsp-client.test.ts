import { describe, expect, test } from "bun:test";
import type { JsonRpcMessage } from "../protocol";
import { jsonRpcResponse } from "../protocol";
import { LspError, LspStdioTransport, type LspCloseEvent } from "./lsp-stdio-transport";
import { LspClient, pathToUri, uriToPath } from "./lsp-client";
import { LspFrameReader, encodeLspFrame } from "./lsp-stdio-transport";

// ---------- 测试基建 ----------

function expectLspError(promise: Promise<unknown>, code: LspError["code"]): Promise<LspError> {
	return promise.then(
		() => {
			throw new Error(`期望 LspError(${code})，但成功返回`);
		},
		(error: unknown) => {
			if (!(error instanceof LspError)) {
				throw error;
			}
			expect(error.code).toBe(code);
			return error;
		},
	);
}

/** 注入流模式的 LSP 服务器桩（帧协议解析 + 脚本化应答）。 */
class ScriptedLspServer {
	readonly toClient: ReadableStream<Uint8Array>;
	private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	private readonly frameReader = new LspFrameReader();
	readonly received: JsonRpcMessage[] = [];
	handlers: Record<string, (params: unknown) => unknown> = {};
	readonly silent = new Set<string>();

	constructor() {
		this.toClient = new ReadableStream<Uint8Array>({
			start: (controller) => {
				this.controller = controller;
			},
		});
	}

	readonly sink = {
		write: (chunk: Uint8Array): void => {
			const { frames } = this.frameReader.push(chunk);
			for (const frame of frames) {
				const message = JSON.parse(frame) as JsonRpcMessage;
				this.received.push(message);
				if ("method" in message && "id" in message && !this.silent.has(message.method)) {
					const handler = this.handlers[message.method];
					if (handler !== undefined) {
						this.pushToClient(jsonRpcResponse(message.id, handler(message.params)));
					} else {
						this.pushToClient({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no handler" } } as JsonRpcMessage);
					}
				}
			}
		},
	};

	pushToClient(message: JsonRpcMessage): void {
		const controller = this.controller;
		if (controller === null) {
			throw new Error("服务器流未初始化");
		}
		controller.enqueue(encodeLspFrame(JSON.stringify(message)));
	}
}

async function makeClient(options?: {
	capabilities?: Record<string, unknown>;
	clientOptions?: Partial<ConstructorParameters<typeof LspClient>[0]>;
}) {
	const server = new ScriptedLspServer();
	server.handlers = {
		initialize: () => ({ capabilities: options?.capabilities ?? {}, serverInfo: { name: "stub-lsp", version: "1.0" } }),
		shutdown: () => null,
	};
	const transport = new LspStdioTransport({
		input: server.toClient,
		output: server.sink,
		requestTimeoutMs: 1000,
	});
	await transport.start();
	const client = new LspClient({ transport, requestTimeoutMs: 1000, ...options?.clientOptions });
	return { server, transport, client };
}

function loc(uri: string, startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
	return {
		uri,
		range: {
			start: { line: startLine, character: startCharacter },
			end: { line: endLine, character: endCharacter },
		},
	};
}

function link(targetUri: string, startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
	return {
		targetUri,
		targetSelectionRange: {
			start: { line: startLine, character: startCharacter },
			end: { line: endLine, character: endCharacter },
		},
	};
}

// ---------- URI 与握手 ----------

describe("URI 转换", () => {
	test("pathToUri：绝对路径加 file:// 前缀，空格转义 %20", () => {
		expect(pathToUri("/repo/main.ts")).toBe("file:///repo/main.ts");
		expect(pathToUri("/repo/my file.ts")).toBe("file:///repo/my%20file.ts");
		expect(pathToUri("file:///already.ts")).toBe("file:///already.ts");
	});

	test("uriToPath：剥离 scheme 与 authority，反向解码", () => {
		expect(uriToPath("file:///repo/main.ts")).toBe("/repo/main.ts");
		expect(uriToPath("file://localhost/repo/main.ts")).toBe("/repo/main.ts");
		expect(uriToPath("file:///repo/my%20file.ts")).toBe("/repo/my file.ts");
		expect(uriToPath("/plain/path.ts")).toBe("/plain/path.ts");
	});
});

describe("LspClient 握手与能力协商", () => {
	test("connect：initialize 参数与 initialized 通知按序发出", async () => {
		const { server, client } = await makeClient();
		await client.connect();
		const first = server.received[0];
		const second = server.received[1];
		expect(first && "method" in first ? first.method : undefined).toBe("initialize");
		expect(second && "method" in second ? second.method : undefined).toBe("initialized");
		const params = (first && "params" in first ? first.params : undefined) as Record<string, unknown>;
		expect(typeof params["processId"]).toBe("number");
		expect(params["capabilities"]).toEqual({});
		expect(client.getInitializeInfo()?.serverName).toBe("stub-lsp");
		await client.close();
	});

	test("positionEncoding 缺省 utf-16（服务器未声明）", async () => {
		const { client } = await makeClient();
		await client.connect();
		expect(client.getPositionEncoding()).toBe("utf-16");
		await client.close();
	});

	test("服务器声明 utf-8 → 协商结果透传", async () => {
		const { client } = await makeClient({ capabilities: { positionEncoding: "utf-8" } });
		await client.connect();
		expect(client.getPositionEncoding()).toBe("utf-8");
		await client.close();
	});

	test("服务器声明非法编码 → 回退 utf-16", async () => {
		const { client } = await makeClient({ capabilities: { positionEncoding: "ucs2" } });
		await client.connect();
		expect(client.getPositionEncoding()).toBe("utf-16");
		await client.close();
	});

	test("connect 重复调用：invalid-state", async () => {
		const { client } = await makeClient();
		await client.connect();
		await expectLspError(client.connect(), "invalid-state");
		await client.close();
	});
});

// ---------- 四大导航操作 ----------

describe("LspClient 四大导航操作", () => {
	test("goToDefinition：方法名/参数正确，Location 归一（0 基透传）", async () => {
		const { server, client } = await makeClient({ capabilities: { definitionProvider: true } });
		await client.connect();
		let captured: unknown;
		server.handlers["textDocument/definition"] = (params) => {
			captured = params;
			return loc("file:///repo/main.ts", 11, 4, 11, 16);
		};
		const result = await client.goToDefinition("/repo/main.ts", 5, 8);
		expect(captured).toEqual({
			textDocument: { uri: "file:///repo/main.ts" },
			position: { line: 5, character: 8 },
		});
		expect(result.operation).toBe("goToDefinition");
		expect(result.locations).toEqual([
			{ uri: "file:///repo/main.ts", startLine: 11, startCharacter: 4, endLine: 11, endCharacter: 16 },
		]);
		expect(result.truncated).toBe(false);
		expect(result.rendered).toContain("/repo/main.ts");
		expect(result.rendered).toContain("L12:5-L12:17");
		await client.close();
	});

	test("goToDefinition：LocationLink 数组按 targetSelectionRange 归一", async () => {
		const { server, client } = await makeClient({ capabilities: { definitionProvider: true } });
		await client.connect();
		server.handlers["textDocument/definition"] = () => [
			link("file:///repo/impl.ts", 20, 2, 20, 10),
		];
		const result = await client.goToDefinition("/repo/main.ts", 0, 0);
		expect(result.locations).toEqual([
			{ uri: "file:///repo/impl.ts", startLine: 20, startCharacter: 2, endLine: 20, endCharacter: 10 },
		]);
		await client.close();
	});

	test("goToDefinition：null 结果 → 空位置列表", async () => {
		const { server, client } = await makeClient({ capabilities: { definitionProvider: true } });
		await client.connect();
		server.handlers["textDocument/definition"] = () => null;
		const result = await client.goToDefinition("/repo/main.ts", 0, 0);
		expect(result.locations).toEqual([]);
		expect(result.totalLocations).toBe(0);
		expect(result.truncated).toBe(false);
		await client.close();
	});

	test("findReferences：context.includeDeclaration 缺省 true，false 透传", async () => {
		const { server, client } = await makeClient({ capabilities: { referencesProvider: true } });
		await client.connect();
		const captured: unknown[] = [];
		server.handlers["textDocument/references"] = (params) => {
			captured.push(params);
			return [loc("file:///repo/use.ts", 1, 0, 1, 6)];
		};
		await client.findReferences("/repo/main.ts", 3, 4);
		await client.findReferences("/repo/main.ts", 3, 4, { includeDeclaration: false });
		expect(captured[0]).toEqual({
			textDocument: { uri: "file:///repo/main.ts" },
			position: { line: 3, character: 4 },
			context: { includeDeclaration: true },
		});
		expect(captured[1]).toEqual({
			textDocument: { uri: "file:///repo/main.ts" },
			position: { line: 3, character: 4 },
			context: { includeDeclaration: false },
		});
		await client.close();
	});

	test("goToImplementation：方法名 textDocument/implementation", async () => {
		const { server, client } = await makeClient({ capabilities: { implementationProvider: true } });
		await client.connect();
		server.handlers["textDocument/implementation"] = () => loc("file:///repo/impl.ts", 4, 0, 4, 8);
		const result = await client.goToImplementation("/repo/main.ts", 2, 3);
		const methods = server.received
			.filter((message) => "method" in message)
			.map((message) => ("method" in message ? message.method : ""));
		expect(methods).toContain("textDocument/implementation");
		expect(result.operation).toBe("goToImplementation");
		expect(result.locations[0]?.uri).toBe("file:///repo/impl.ts");
		await client.close();
	});
});

// ---------- 能力门禁与状态 ----------

describe("LspClient 能力门禁", () => {
	test("未 connect 直接调操作：not-connected", async () => {
		const { client } = await makeClient();
		await expectLspError(client.goToDefinition("/x.ts", 0, 0), "not-connected");
	});

	test("服务器未声明能力：capability-unsupported 携带 capability/method", async () => {
		const { client } = await makeClient({ capabilities: {} });
		await client.connect();
		const error = await expectLspError(client.goToDefinition("/x.ts", 0, 0), "capability-unsupported");
		expect((error.data as { capability?: string }).capability).toBe("definitionProvider");
		expect((error.data as { method?: string }).method).toBe("textDocument/definition");
		await client.close();
	});
});

// ---------- 输出保护 ----------

describe("LspClient 输出保护", () => {
	function manyLocations(count: number, uri = "file:///repo/big.ts") {
		return Array.from({ length: count }, (_, index) => loc(uri, index, 0, index, 5));
	}

	test("maxLocations=100：150 条引用截断为 100 并携带 omitted", async () => {
		const { server, client } = await makeClient({ capabilities: { referencesProvider: true } });
		await client.connect();
		server.handlers["textDocument/references"] = () => manyLocations(150);
		const result = await client.findReferences("/repo/main.ts", 0, 0);
		expect(result.totalLocations).toBe(150);
		expect(result.locations.length).toBe(100);
		expect(result.omittedLocations).toBe(50);
		expect(result.truncated).toBe(true);
		await client.close();
	});

	test("渲染按文件分组：文件名字典序、组内行列升序、1 基显示", async () => {
		const { server, client } = await makeClient({ capabilities: { referencesProvider: true } });
		await client.connect();
		server.handlers["textDocument/references"] = () => [
			loc("file:///repo/b.ts", 0, 0, 0, 3),
			loc("file:///repo/a.ts", 9, 1, 9, 5),
			loc("file:///repo/a.ts", 2, 0, 2, 4),
			loc("file:///repo/a.ts", 5, 2, 5, 6),
		];
		const result = await client.findReferences("/repo/main.ts", 0, 0);
		expect(result.rendered).toBe(
			[
				"/repo/a.ts",
				"  L3:1-L3:5",
				"  L6:3-L6:7",
				"  L10:2-L10:6",
				"/repo/b.ts",
				"  L1:1-L1:4",
			].join("\n"),
		);
		await client.close();
	});

	test("maxResultChars：渲染文本超限截断并标记", async () => {
		const { server, client } = await makeClient({
			capabilities: { referencesProvider: true },
			clientOptions: { maxResultChars: 50 },
		});
		await client.connect();
		server.handlers["textDocument/references"] = () => manyLocations(40);
		const result = await client.findReferences("/repo/main.ts", 0, 0);
		expect(result.truncated).toBe(true);
		expect(result.rendered.includes("…[结果超限截断]")).toBe(true);
		expect(result.rendered.slice(0, 50).length).toBe(50);
		await client.close();
	});

	test("hover 渲染超限截断", async () => {
		const { server, client } = await makeClient({
			capabilities: { hoverProvider: true },
			clientOptions: { maxResultChars: 20 },
		});
		await client.connect();
		server.handlers["textDocument/hover"] = () => ({
			contents: { kind: "markdown", value: "x".repeat(100) },
		});
		const result = await client.hover("/repo/main.ts", 0, 0);
		expect(result.found).toBe(true);
		expect(result.truncated).toBe(true);
		expect(result.rendered.includes("…[结果超限截断]")).toBe(true);
		await client.close();
	});
});

// ---------- hover 归一化 ----------

describe("LspClient hover 归一化", () => {
	test("MarkupContent：kind 与 value 提取，range 归一", async () => {
		const { server, client } = await makeClient({ capabilities: { hoverProvider: true } });
		await client.connect();
		server.handlers["textDocument/hover"] = () => ({
			contents: { kind: "markdown", value: "# 文档" },
			range: { start: { line: 1, character: 2 }, end: { line: 1, character: 9 } },
		});
		const result = await client.hover("/repo/main.ts", 1, 3);
		expect(result.found).toBe(true);
		expect(result.markupKind).toBe("markdown");
		expect(result.contents).toBe("# 文档");
		expect(result.range).toEqual({ startLine: 1, startCharacter: 2, endLine: 1, endCharacter: 9 });
		await client.close();
	});

	test("MarkedString：language 提取；数组内容按空行合并", async () => {
		const { server, client } = await makeClient({ capabilities: { hoverProvider: true } });
		await client.connect();
		server.handlers["textDocument/hover"] = () => ({
			contents: [{ language: "typescript", value: "const x = 1" }, "说明文字"],
		});
		const result = await client.hover("/repo/main.ts", 0, 0);
		expect(result.language).toBe("typescript");
		expect(result.contents).toBe("const x = 1\n\n说明文字");
		await client.close();
	});

	test("hover 为 null：found=false", async () => {
		const { server, client } = await makeClient({ capabilities: { hoverProvider: true } });
		await client.connect();
		server.handlers["textDocument/hover"] = () => null;
		const result = await client.hover("/repo/main.ts", 0, 0);
		expect(result.found).toBe(false);
		expect(result.contents).toBe("");
		await client.close();
	});
});

// ---------- 生命周期 ----------

describe("LspClient 生命周期", () => {
	test("close：shutdown 请求 + exit 通知按序发出，幂等", async () => {
		const { server, client } = await makeClient();
		await client.connect();
		await client.close();
		await client.close();
		const methods = server.received
			.filter((message) => "method" in message)
			.map((message) => ("method" in message ? message.method : ""));
		expect(methods).toEqual(["initialize", "initialized", "shutdown", "exit"]);
	});

	test("shutdown 无应答也不阻塞关闭（closeTimeoutMs 兜底）", async () => {
		const server = new ScriptedLspServer();
		server.handlers = { initialize: () => ({ capabilities: {} }) };
		server.silent.add("shutdown");
		const transport = new LspStdioTransport({ input: server.toClient, output: server.sink });
		await transport.start();
		const client = new LspClient({ transport, closeTimeoutMs: 50 });
		await client.connect();
		const events: LspCloseEvent[] = [];
		client.onClose((event) => events.push(event));
		await client.close();
		expect(events.length).toBe(1);
		expect(events[0]?.code).toBe("closed");
	}, 5000);

	test("真实 spawn 端到端：connect → goToDefinition → close", async () => {
		const fixture = `${import.meta.dir}/fixtures/mock-lsp-server.ts`;
		const client = new LspClient({ command: process.execPath, args: [fixture], requestTimeoutMs: 5000 });
		const info = await client.connect();
		expect(info.serverName).toBe("mock-lsp");
		expect(client.getPositionEncoding()).toBe("utf-16");
		const result = await client.goToDefinition("/tmp/mock-main.ts", 3, 7);
		expect(result.locations[0]?.uri).toBe("file:///tmp/mock-main.ts");
		expect(result.rendered).toContain("/tmp/mock-main.ts");
		await client.close();
	}, 15000);
});
