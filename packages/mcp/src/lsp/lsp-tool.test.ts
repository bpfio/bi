import { describe, expect, test } from "bun:test";
import { LspError } from "./lsp-stdio-transport";
import type { LspNavigationResult } from "./lsp-client";
import { createLspTool, LSP_OPERATIONS, type LspToolClientLike } from "./lsp-tool";

// ---------- 测试基建 ----------

interface RecordedCall {
	operation: string;
	filePath: string;
	line: number;
	character: number;
}

function emptyNavigation(operation: LspNavigationResult["operation"]): LspNavigationResult {
	return { operation, locations: [], totalLocations: 0, omittedLocations: 0, truncated: false, rendered: "" };
}

/** 调用记录型 stub 客户端（可注入异常）。 */
function stubClient(behavior?: { lspError?: LspError; rawError?: Error }) {
	const calls: RecordedCall[] = [];
	const record = (operation: string) => async (filePath: string, line: number, character: number) => {
		calls.push({ operation, filePath, line, character });
		if (behavior?.lspError !== undefined) {
			throw behavior.lspError;
		}
		if (behavior?.rawError !== undefined) {
			throw behavior.rawError;
		}
		return emptyNavigation(operation as LspNavigationResult["operation"]);
	};
	const client = {
		calls,
		goToDefinition: record("goToDefinition"),
		findReferences: record("findReferences"),
		goToImplementation: record("goToImplementation"),
		hover: async (filePath: string, line: number, character: number) => {
			calls.push({ operation: "hover", filePath, line, character });
			if (behavior?.lspError !== undefined) {
				throw behavior.lspError;
			}
			if (behavior?.rawError !== undefined) {
				throw behavior.rawError;
			}
			return {
				operation: "hover" as const,
				found: true,
				contents: "hover 文档",
				rendered: "hover 文档",
				truncated: false,
			};
		},
	};
	return client as typeof client & LspToolClientLike;
}

// ---------- 工具规格 ----------

describe("createLspTool 工具规格", () => {
	test("name/description/inputSchema：lsp + 四操作枚举 + 四字段必填", () => {
		const { tool } = createLspTool(stubClient());
		expect(tool.name).toBe("lsp");
		expect(tool.description).toContain("goToDefinition");
		const schema = tool.inputSchema as Record<string, unknown>;
		expect(schema["required"]).toEqual(["operation", "file_path", "line", "character"]);
		const operation = ((schema["properties"] as Record<string, Record<string, unknown>>)["operation"] ??
			{}) as Record<string, unknown>;
		expect(operation["enum"]).toEqual([...LSP_OPERATIONS]);
	});
});

// ---------- 输入校验 ----------

describe("createLspTool.handle 输入校验", () => {
	test("非法 operation / 空 file_path / 非整数行列：invalid-params 附 issues", async () => {
		const { handle } = createLspTool(stubClient());
		for (const input of [
			{ operation: "jumpTo", file_path: "/a.ts", line: 0, character: 0 },
			{ operation: "goToDefinition", file_path: "  ", line: 0, character: 0 },
			{ operation: "goToDefinition", file_path: "/a.ts", line: -1, character: 0 },
			{ operation: "goToDefinition", file_path: "/a.ts", line: 1.5, character: 0 },
			{ operation: "goToDefinition", file_path: "/a.ts", line: 0, character: "0" },
			{ operation: "goToDefinition", file_path: "/a.ts", line: 0 },
		]) {
			const outcome = await handle(input);
			expect(outcome.ok).toBe(false);
			if (outcome.ok) {
				return;
			}
			expect(outcome.error.kind).toBe("invalid-params");
			expect(outcome.error.issues?.length ?? 0).toBeGreaterThan(0);
		}
	});

	test("非对象输入：invalid-params", async () => {
		const { handle } = createLspTool(stubClient());
		for (const input of [null, "lsp", 7, ["hover"]]) {
			const outcome = await handle(input);
			expect(outcome.ok).toBe(false);
			if (outcome.ok) {
				return;
			}
			expect(outcome.error.kind).toBe("invalid-params");
		}
	});

	test("合法输入：按操作分发并透传 0 基行列", async () => {
		const client = stubClient();
		const { handle } = createLspTool(client);
		for (const operation of LSP_OPERATIONS) {
			const outcome = await handle({ operation, file_path: "/repo/main.ts", line: 12, character: 7 });
			expect(outcome.ok).toBe(true);
			if (!outcome.ok) {
				return;
			}
			expect(outcome.result.operation).toBe(operation);
			expect(outcome.result.operation === "hover" ? outcome.result.found : outcome.result.truncated).toBeDefined();
		}
		expect(client.calls.length).toBe(4);
		const recordedOps = client.calls.map((call) => call.operation);
		expect([...recordedOps].sort()).toEqual([...LSP_OPERATIONS].sort());
		expect(client.calls[0]?.filePath).toBe("/repo/main.ts");
		expect(client.calls[0]?.line).toBe(12);
		expect(client.calls[0]?.character).toBe(7);
	});

	test("hover 成功结果原样透传", async () => {
		const client = stubClient();
		const { handle } = createLspTool(client);
		const outcome = await handle({ operation: "hover", file_path: "/a.ts", line: 0, character: 0 });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) {
			return;
		}
		expect(outcome.result).toMatchObject({ operation: "hover", found: true, contents: "hover 文档" });
	});
});

// ---------- 错误分类 ----------

describe("createLspTool.handle 错误分类", () => {
	test("capability-unsupported：结构化透传 code", async () => {
		const { handle } = createLspTool(
			stubClient({
				lspError: new LspError(
					"capability-unsupported",
					"服务器未声明 definitionProvider 能力",
					{ capability: "definitionProvider" },
				),
			}),
		);
		const outcome = await handle({ operation: "goToDefinition", file_path: "/a.ts", line: 0, character: 0 });
		expect(outcome.ok).toBe(false);
		if (outcome.ok) {
			return;
		}
		expect(outcome.error.kind).toBe("capability-unsupported");
		expect(outcome.error.message).toContain("definitionProvider");
	});

	test("timeout：结构化透传 code", async () => {
		const { handle } = createLspTool(
			stubClient({ lspError: new LspError("timeout", "请求超时", { timeoutMs: 500 }) }),
		);
		const outcome = await handle({ operation: "hover", file_path: "/a.ts", line: 0, character: 0 });
		expect(outcome.ok).toBe(false);
		if (outcome.ok) {
			return;
		}
		expect(outcome.error.kind).toBe("timeout");
	});

	test("server-missing：结构化透传 code", async () => {
		const { handle } = createLspTool(
			stubClient({ lspError: new LspError("server-missing", "无法启动 LSP 服务器进程: gopls") }),
		);
		const outcome = await handle({ operation: "goToImplementation", file_path: "/a.ts", line: 0, character: 0 });
		expect(outcome.ok).toBe(false);
		if (outcome.ok) {
			return;
		}
		expect(outcome.error.kind).toBe("server-missing");
	});

	test("未知异常：归一为 protocol-error", async () => {
		const { handle } = createLspTool(stubClient({ rawError: new Error("boom") }));
		const outcome = await handle({ operation: "findReferences", file_path: "/a.ts", line: 0, character: 0 });
		expect(outcome.ok).toBe(false);
		if (outcome.ok) {
			return;
		}
		expect(outcome.error.kind).toBe("protocol-error");
		expect(outcome.error.message).toContain("boom");
	});
});
