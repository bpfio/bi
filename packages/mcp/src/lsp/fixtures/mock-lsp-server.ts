/**
 * 测试夹具：最小 LSP stdio 服务器（由 bun 直接运行）。
 *
 * 支持 initialize / textDocument/definition / shutdown 三个请求与 exit 通知，
 * 用于验证 LspStdioTransport / LspClient 的真实子进程端到端头帧协议。
 * 仅供测试 spawn，不参与生产导出。
 */
import { LspFrameReader, encodeLspFrame } from "../lsp-stdio-transport";

interface FixtureMessage {
	jsonrpc?: string;
	method?: string;
	id?: number | string;
	params?: unknown;
}

const frameReader = new LspFrameReader();

function send(message: unknown): void {
	process.stdout.write(encodeLspFrame(JSON.stringify(message)));
}

function respond(id: number | string, result: unknown): void {
	send({ jsonrpc: "2.0", id, result });
}

for await (const chunk of Bun.stdin.stream()) {
	const { frames } = frameReader.push(chunk);
	for (const frame of frames) {
		const message = JSON.parse(frame) as FixtureMessage;
		if (typeof message.method !== "string") {
			continue;
		}
		if (message.id === undefined) {
			if (message.method === "exit") {
				process.exit(0);
			}
			continue;
		}
		switch (message.method) {
			case "initialize":
				respond(message.id, {
					capabilities: { definitionProvider: true, positionEncoding: "utf-16" },
					serverInfo: { name: "mock-lsp", version: "0.1.0" },
				});
				break;
			case "textDocument/definition":
				respond(message.id, {
					uri: "file:///tmp/mock-main.ts",
					range: { start: { line: 11, character: 4 }, end: { line: 11, character: 16 } },
				});
				break;
			case "shutdown":
				respond(message.id, null);
				break;
			default:
				send({
					jsonrpc: "2.0",
					id: message.id,
					error: { code: -32601, message: `no handler: ${message.method}` },
				});
		}
	}
}
