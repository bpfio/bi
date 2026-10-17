/**
 * @bi/mcp —— LSP 符号级导航工具处理器（BI-13.2）。
 *
 * 把 LspClient 适配为模型可见的 `lsp` 工具：
 * `lsp({ operation, file_path, line, character })`，四操作分发：
 * goToDefinition / findReferences / goToImplementation / hover。
 * 输入校验（操作枚举、路径非空、行列非负整数）→ 结构化 invalid-params 拒绝；
 * LspError（server-missing / timeout / capability-unsupported / rpc-error…）
 * 捕获为结构化错误结果，不走异常控制流。
 * 输出保护（maxLocations / maxResultChars）由 LspClient 内层执行，本层透传。
 */
import type { LspErrorCode, LspHoverResult, LspNavigationResult } from "./lsp-client";
import { LspError } from "./lsp-stdio-transport";

/** 四个受支持的导航操作。 */
export const LSP_OPERATIONS = ["goToDefinition", "findReferences", "goToImplementation", "hover"] as const;

export type LspOperation = (typeof LSP_OPERATIONS)[number];

/** 客户端最小结构面（与 LspClient duck-type 兼容，测试可注入 stub）。 */
export interface LspToolClientLike {
	goToDefinition(filePath: string, line: number, character: number): Promise<LspNavigationResult>;
	findReferences(
		filePath: string,
		line: number,
		character: number,
		opts?: { includeDeclaration?: boolean },
	): Promise<LspNavigationResult>;
	goToImplementation(filePath: string, line: number, character: number): Promise<LspNavigationResult>;
	hover(filePath: string, line: number, character: number): Promise<LspHoverResult>;
}

export interface LspToolSpec {
	name: "lsp";
	description: string;
	inputSchema: unknown;
}

export interface LspToolError {
	kind: "invalid-params" | LspErrorCode;
	message: string;
	issues?: string[];
}

export type LspToolOutcome =
	| { ok: true; result: LspNavigationResult | LspHoverResult }
	| { ok: false; error: LspToolError };

export interface LspTool {
	tool: LspToolSpec;
	/** 输入校验 + 操作分发 + 结构化错误捕获。 */
	handle(input: unknown): Promise<LspToolOutcome>;
}

/** 构造模型可见的 `lsp` 导航工具。client 由调用方注入（结构类型）。 */
export function createLspTool(client: LspToolClientLike): LspTool {
	const tool: LspToolSpec = {
		name: "lsp",
		description:
			"LSP 符号级代码导航：goToDefinition（跳定义）、findReferences（找引用）、" +
			"goToImplementation（跳实现）、hover（悬停文档）。" +
			"输入 0 基行列；输出按文件分组渲染（≤100 条位置、16000 字符保护截断）。" +
			"要求 LSP 服务器已连接且声明对应能力。",
		inputSchema: {
			type: "object",
			properties: {
				operation: {
					type: "string",
					enum: [...LSP_OPERATIONS],
					description: "导航操作",
				},
				file_path: { type: "string", minLength: 1, description: "文件绝对路径或 file:// URI" },
				line: { type: "integer", minimum: 0, description: "0 基行号" },
				character: { type: "integer", minimum: 0, description: "0 基列号（UTF-16 码元）" },
			},
			required: ["operation", "file_path", "line", "character"],
			additionalProperties: false,
		},
	};

	return {
		tool,
		async handle(input: unknown): Promise<LspToolOutcome> {
			const issues: string[] = [];
			if (typeof input !== "object" || input === null || Array.isArray(input)) {
				return {
					ok: false,
					error: {
						kind: "invalid-params",
						message: "lsp 输入必须为对象 { operation, file_path, line, character }",
						issues: ["输入不是对象"],
					},
				};
			}
			const record = input as Record<string, unknown>;
			const operation = record["operation"];
			if (typeof operation !== "string" || !(LSP_OPERATIONS as readonly string[]).includes(operation)) {
				issues.push(`operation 必须为 ${LSP_OPERATIONS.join(" | ")} 之一`);
			}
			const filePath = record["file_path"];
			if (typeof filePath !== "string" || filePath.trim().length === 0) {
				issues.push("file_path 必须为非空字符串");
			}
			const line = record["line"];
			if (typeof line !== "number" || !Number.isInteger(line) || line < 0) {
				issues.push("line 必须为非负整数（0 基）");
			}
			const character = record["character"];
			if (typeof character !== "number" || !Number.isInteger(character) || character < 0) {
				issues.push("character 必须为非负整数（0 基）");
			}
			if (issues.length > 0) {
				return {
					ok: false,
					error: {
						kind: "invalid-params",
						message: `lsp 输入校验失败（${issues.length} 项）`,
						issues,
					},
				};
			}
			try {
				const result = await dispatch(
					client,
					operation as LspOperation,
					filePath as string,
					line as number,
					character as number,
				);
				return { ok: true, result };
			} catch (cause) {
				if (cause instanceof LspError) {
					return { ok: false, error: { kind: cause.code, message: cause.message } };
				}
				return { ok: false, error: { kind: "protocol-error", message: String(cause) } };
			}
		},
	};
}

function dispatch(
	client: LspToolClientLike,
	operation: LspOperation,
	filePath: string,
	line: number,
	character: number,
): Promise<LspNavigationResult | LspHoverResult> {
	switch (operation) {
		case "goToDefinition":
			return client.goToDefinition(filePath, line, character);
		case "findReferences":
			return client.findReferences(filePath, line, character);
		case "goToImplementation":
			return client.goToImplementation(filePath, line, character);
		case "hover":
			return client.hover(filePath, line, character);
	}
}
