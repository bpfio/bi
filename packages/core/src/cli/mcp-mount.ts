/**
 * FX-F · MCP stdio 最小装配（消配置键陷阱）。
 *
 * config [mcp.servers] 键面早已入 schema（schema.ts mcpServerEntrySchema /
 * mcpSchema，进 ROOT_SECTION_SCHEMAS），但生产零装配——用户配置后静默无效。
 * 本卡做最小可用装配：遍历 [mcp.servers] 中 enabled!==false 且有 command 的条目，
 * 为每条启动 StdioClientTransport + McpClient，initialize 后 tools/list，把每个
 * 远端工具包成 ToolBinding 挂进工具集，命名 mcp__<serverId>__<toolName>
 * （description/inputSchema 透传；execute 转调 client.callTool 并 JSON 序列化结果）。
 *
 * 健壮面（绝不阻塞主流程）：
 * - 某条目启动/列举失败：stderr 结构化警告行
 *   `bi: mcp server <id> 装配失败: <原因>` + 跳过该条；
 * - url/SSE 型（无 command）：本轮未支持，同格式警告
 *   `bi: mcp server <id> SSE 型本轮未支持` + 跳过。
 *
 * 生命周期：返回的客户端实例随会话生命周期；调用方（cli/main.ts）在会话结束后
 * 调用 closeAll() 尽力而为地关闭（释放子进程，进程退出不悬挂）。
 */
import { McpClient, StdioClientTransport, type McpToolDefinition } from "../../../mcp/src";
import type { McpSection } from "../config/schema";
import type { ToolBinding } from "./headless";

/** 结构化警告前缀（stderr 单行）。 */
const MCP_WARN_PREFIX = "bi: mcp server";

/** 装配产物：远端工具绑定 + 关闭句柄（尽力而为释放子进程）。 */
export interface MountMcpResult {
	/** 挂载进工具集的远端工具绑定（命名 mcp__<serverId>__<toolName>）。 */
	readonly tools: ToolBinding[];
	/** 关闭全部已启动的 MCP 客户端（释放子进程），失败静默吞。 */
	closeAll(): Promise<void>;
}

/**
 * 装配 config [mcp.servers]：返回远端工具绑定与关闭句柄。
 * warn 注入面用于测试捕获结构化警告（缺省写 stderr）。
 */
export async function mountMcpServers(
	mcp: McpSection,
	root: string,
	opts: { warn?: (line: string) => void } = {},
): Promise<MountMcpResult> {
	const warn = opts.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
	const tools: ToolBinding[] = [];
	const clients: McpClient[] = [];

	const servers = mcp.servers ?? {};
	for (const [id, entry] of Object.entries(servers)) {
		// 显式 enabled=false → 完全跳过（含不告警）。
		if (entry.enabled === false) continue;
		// url/SSE 型（无 command）：本轮未支持，结构化警告后跳过、绝不启动子进程。
		if (!entry.command || entry.command.trim() === "") {
			warn(`${MCP_WARN_PREFIX} ${id} SSE 型本轮未支持`);
			continue;
		}
		let client: McpClient | undefined;
		try {
			const transport = new StdioClientTransport({
				command: entry.command,
				args: entry.args,
				env: entry.env && Object.keys(entry.env).length > 0 ? entry.env : undefined,
				cwd: root,
				restartPolicy: "never",
			});
			await transport.start();
			client = new McpClient(transport, { requestTimeoutMs: 30_000 });
			await client.initialize();
			const remoteTools: McpToolDefinition[] = await client.listTools();
			clients.push(client);
			for (const remoteTool of remoteTools) {
				tools.push(makeMcpToolBinding(id, remoteTool, client));
			}
		} catch (cause) {
			warn(`${MCP_WARN_PREFIX} ${id} 装配失败: ${cause instanceof Error ? cause.message : String(cause)}`);
			await client?.close().catch(() => {});
			continue;
		}
	}

	const closeAll = async (): Promise<void> => {
		await Promise.all(
			clients.map((c) =>
				c.close().then(
					() => undefined,
					() => undefined,
				),
			),
		);
	};
	return { tools, closeAll };
}

/** 把单个远端工具包成 ToolBinding（命名 mcp__<serverId>__<toolName>）。 */
function makeMcpToolBinding(serverId: string, tool: McpToolDefinition, client: McpClient): ToolBinding {
	const name = `mcp__${serverId}__${tool.name}`;
	return {
		definition: {
			name,
			description: tool.description ?? `MCP 远端工具（server=${serverId}, tool=${tool.name}）`,
			inputSchema:
				(tool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {}, required: [] },
		},
		readOnly: false,
		argSummary: (args) => mcpArgSummary(name, args),
		execute: async (args, signal) => {
			if (signal.aborted) throw new Error("aborted");
			const result = await client.callTool(tool.name, args);
			return JSON.stringify(result);
		},
	};
}

/** MCP 工具 argSummary（权限门审计面）：工具名 + 截断参数。 */
function mcpArgSummary(name: string, args: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(args) ?? String(args);
	} catch {
		text = String(args);
	}
	const max = 200;
	return text.length > max ? `${name} ${text.slice(0, max)}…` : `${name} ${text}`;
}
