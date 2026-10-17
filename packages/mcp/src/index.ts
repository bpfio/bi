/**
 * @bi/mcp —— MCP 域：Model Context Protocol 服务的接入与工具桥接。
 *
 * 桶导出：协议面（JSON-RPC 2.0 信封/错误码/传输契约）、
 * stdio 与 SSE 双传输通道、客户端会话与多服务器注册表。
 */
export const DESCRIPTION = "MCP 域：Model Context Protocol 服务的接入与工具桥接。";

export * from "./protocol";
export * from "./client";
export * from "./transports/stdio";
export * from "./transports/sse";
