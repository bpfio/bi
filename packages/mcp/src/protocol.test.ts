import { describe, expect, test } from "bun:test";
import {
	JSON_RPC_VERSION,
	JsonRpcErrorCode,
	LineSplitter,
	MCP_PROTOCOL_VERSION,
	jsonRpcError,
	jsonRpcNotification,
	jsonRpcRequest,
	jsonRpcResponse,
	isJsonRpcMessage,
	parseJsonRpcLine,
} from "./protocol";

describe("protocol: JSON-RPC 2.0 信封构造", () => {
	test("标准错误码常量取值正确", () => {
		expect(JsonRpcErrorCode.ParseError).toBe(-32700);
		expect(JsonRpcErrorCode.InvalidRequest).toBe(-32600);
		expect(JsonRpcErrorCode.MethodNotFound).toBe(-32601);
		expect(JsonRpcErrorCode.InvalidParams).toBe(-32602);
		expect(JsonRpcErrorCode.InternalError).toBe(-32603);
	});

	test("jsonRpcRequest 带 params", () => {
		expect(jsonRpcRequest(7, "tools/list", { cursor: "c1" })).toEqual({
			jsonrpc: JSON_RPC_VERSION,
			id: 7,
			method: "tools/list",
			params: { cursor: "c1" },
		});
	});

	test("jsonRpcRequest params 为 undefined 时省略字段", () => {
		const msg = jsonRpcRequest(1, "ping");
		expect("params" in msg).toBe(false);
		expect(msg.id).toBe(1);
	});

	test("jsonRpcNotification 不携带 id", () => {
		const msg = jsonRpcNotification("notifications/initialized");
		expect("id" in msg).toBe(false);
		expect(msg.method).toBe("notifications/initialized");
	});

	test("jsonRpcResponse 与 jsonRpcError 形态", () => {
		expect(jsonRpcResponse("a", { ok: true })).toEqual({
			jsonrpc: "2.0",
			id: "a",
			result: { ok: true },
		});
		expect(jsonRpcError(3, -32601, "no such method")).toEqual({
			jsonrpc: "2.0",
			id: 3,
			error: { code: -32601, message: "no such method" },
		});
		const withData = jsonRpcError(4, -32602, "bad", { detail: 1 });
		expect(withData.error.data).toEqual({ detail: 1 });
	});

	test("协议版本常量与信封版本一致", () => {
		expect(MCP_PROTOCOL_VERSION).toBe("2025-06-18");
		expect(JSON_RPC_VERSION).toBe("2.0");
	});
});

describe("protocol: isJsonRpcMessage 判别", () => {
	test("接受请求/通知/成功响应/失败响应", () => {
		expect(isJsonRpcMessage(jsonRpcRequest(1, "ping"))).toBe(true);
		expect(isJsonRpcMessage(jsonRpcNotification("initialized"))).toBe(true);
		expect(isJsonRpcMessage(jsonRpcResponse(1, null))).toBe(true);
		expect(isJsonRpcMessage(jsonRpcError(1, -32603, "x"))).toBe(true);
	});

	test("拒绝非 JSON-RPC 结构", () => {
		expect(isJsonRpcMessage(null)).toBe(false);
		expect(isJsonRpcMessage("str")).toBe(false);
		expect(isJsonRpcMessage({})).toBe(false);
		expect(isJsonRpcMessage({ jsonrpc: "1.0", id: 1, method: "m" })).toBe(false);
		expect(isJsonRpcMessage({ jsonrpc: "2.0", id: 1, method: 42 })).toBe(false);
		expect(isJsonRpcMessage({ jsonrpc: "2.0", id: 1 })).toBe(false); // 无 result/error
		expect(isJsonRpcMessage({ jsonrpc: "2.0", method: "m", id: true })).toBe(false); // id 非法
	});
});

describe("protocol: parseJsonRpcLine 畸形行容错", () => {
	test("合法行解析为消息", () => {
		const parsed = parseJsonRpcLine('{"jsonrpc":"2.0","id":1,"method":"ping"}');
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.message).toEqual(jsonRpcRequest(1, "ping"));
		}
	});

	test("非法 JSON 返回 invalid-json 而不抛异常", () => {
		const parsed = parseJsonRpcLine("<<<not-json>>>");
		expect(parsed).toEqual({ ok: false, reason: "invalid-json" });
	});

	test("非 JSON-RPC 对象返回 not-json-rpc", () => {
		expect(parseJsonRpcLine('{"hello":1}')).toEqual({ ok: false, reason: "not-json-rpc" });
	});

	test("空行与纯空白返回 empty-line", () => {
		expect(parseJsonRpcLine("")).toEqual({ ok: false, reason: "empty-line" });
		expect(parseJsonRpcLine("   \t ")).toEqual({ ok: false, reason: "empty-line" });
	});
});

describe("protocol: LineSplitter 分帧", () => {
	test("单块多行 + \\n 行尾", () => {
		const splitter = new LineSplitter();
		expect(splitter.push("a\nbb\nccc\n")).toEqual(["a", "bb", "ccc"]);
	});

	test("容忍 \\r\\n 行尾", () => {
		const splitter = new LineSplitter();
		expect(splitter.push("one\r\ntwo\r\n")).toEqual(["one", "two"]);
	});

	test("跨切块缓冲拼接", () => {
		const splitter = new LineSplitter();
		expect(splitter.push("hel")).toEqual([]);
		expect(splitter.push("lo\nwor")).toEqual(["hello"]);
		expect(splitter.push("ld\n")).toEqual(["world"]);
	});

	test("flush 吐出无行尾残留", () => {
		const splitter = new LineSplitter();
		expect(splitter.push("tail-without-newline")).toEqual([]);
		expect(splitter.flush()).toEqual(["tail-without-newline"]);
		expect(splitter.flush()).toEqual([]);
	});
});
