/**
 * BI-21 工位 H 域级演练 G —— MCP / A2A 跨进程协作面。
 *
 * 链路 1(MCP):McpClient × 进程内 fixture transport(回环 JSON-RPC 服务器)
 * → initialize 握手 → tools/list 分页列举 → tools/call 指标查询。
 * 链路 2(A2A):A2aHost 派生四角色 + 黑板能力门控写 + fixture 传输回环投递
 * (签名/验签/防重放)。
 *
 * 注入仅限 I/O 边界:transport 与时钟;协议层、验签、能力矩阵全部真实代码。
 */

import { describe, expect, test } from "bun:test";

import { McpClient, McpRegistry, jsonRpcResponse, MCP_PROTOCOL_VERSION } from "../../../mcp/src/index";
import type { JsonRpcMessage, TransportCloseEvent } from "../../../mcp/src/index";
import { A2aHost } from "../../../a2a/src/index";
import { a2aSecret, signEnvelope, verifyEnvelope } from "../../../a2a/src/index";
import { Blackboard, BlackboardWriteDeniedError } from "../../../a2a/src/index";
import { assertCapability, capabilitiesOf, A2A_ROLES } from "../../../a2a/src/index";
import type { TransportPort, SignedEnvelope } from "../../../a2a/src/index";

// ---------------------------------------------------------------------------
// MCP 进程内 fixture server(回环 transport,I/O 边界)
// ---------------------------------------------------------------------------

class LoopbackMcpTransport {
	#onMessageCb: ((m: JsonRpcMessage) => void) | null = null;
	readonly seenMethods: string[] = [];
	readonly seenRequests: unknown[] = [];

	async start(): Promise<void> {}
	async send(message: JsonRpcMessage): Promise<void> {
		if (!("method" in message) || typeof message.method !== "string") return;
		this.seenMethods.push(message.method);
		if ("id" in message && message.id !== undefined) {
			this.seenRequests.push(message);
			void this.respond(message as { id: number | string; method: string; params?: unknown });
		}
	}
	onMessage(cb: (m: JsonRpcMessage) => void): void {
		this.#onMessageCb = cb;
	}
	onClose(_cb: (event: TransportCloseEvent) => void): void {}
	async close(): Promise<void> {}

	async respond(req: { id: number | string; method: string; params?: unknown }): Promise<void> {
		let result: unknown;
		switch (req.method) {
			case "initialize":
				result = {
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: "gazette-mcp-fixture", version: "1.0.0" },
					instructions: "公报指标查询夹具",
				};
				break;
			case "tools/list": {
				const page1 = {
					tools: [
						{
							name: "gazette_lookup",
							description: "按文号查公报指标",
							inputSchema: { type: "object", properties: { docNumber: { type: "string" } } },
						},
						{ name: "ledger_audit", description: "账簿勾稽", inputSchema: { type: "object" } },
					],
					nextCursor: "page-2",
				};
				result = (req.params as { cursor?: string } | undefined)?.cursor === undefined ? page1 : { tools: [{ name: "gdp_series", description: "GDP 时序", inputSchema: { type: "object" } }] };
				break;
			}
			case "tools/call":
				result = {
					content: [{ type: "text", text: "国内生产总值 953680 亿元,同比增长 4.8%" }],
					isError: false,
				};
				break;
			case "ping":
				result = {};
				break;
			default:
				result = {};
		}
		// 异步回环:模拟跨进程消息边界
		await Promise.resolve();
		this.#onMessageCb?.(jsonRpcResponse(req.id, result));
	}
}

describe("BI-21 域 G —— MCP / A2A 协作面", () => {
	test("G1 MCP client × fixture server:握手 / 分页列举 / 工具调用 / 注册表前缀路由", async () => {
		const transport = new LoopbackMcpTransport();
		const client = new McpClient(transport, { requestTimeoutMs: 2000 });

		// 握手:协议版本与服务器信息透传
		const init = await client.initialize();
		expect(init.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
		expect(init.serverInfo.name).toBe("gazette-mcp-fixture");
		expect(init.instructions).toBe("公报指标查询夹具");
		// 请求序列:initialize → notifications/initialized(通知,无 id)
		expect(transport.seenMethods[0]).toBe("initialize");
		expect(transport.seenMethods).toContain("notifications/initialized");
		// JSON-RPC 2.0 信封
		expect(transport.seenRequests[0]).toMatchObject({ jsonrpc: "2.0", method: "initialize" });

		// 分页列举:nextCursor 自动跟随,三件工具全量收齐
		const tools = await client.listTools();
		expect(tools.map((t) => t.name)).toEqual(["gazette_lookup", "ledger_audit", "gdp_series"]);

		// 工具调用:content 透传 + isError 语义
		const call = await client.callTool("gazette_lookup", { docNumber: "国统字〔2026〕87 号" });
		expect(call.isError).toBe(false);
		expect(JSON.stringify(call.content)).toContain("953680");
		await expect(client.ping()).resolves.toBeUndefined();

		// 注册表:多 server 前缀路由(第二个夹具 server)
		const transport2 = new LoopbackMcpTransport();
		const client2 = new McpClient(transport2, { requestTimeoutMs: 2000 });
		await client2.initialize();
		const registry = new McpRegistry();
		registry.register("gazette", client);
		registry.register("audit", client2);
		const across = await registry.toolsAcrossServers();
		expect(across.map((t) => t.prefixedName)).toContain("gazette.gazette_lookup");
		const routed = await registry.callTool("audit.gazette_lookup", { docNumber: "x" });
		expect(routed.isError).toBe(false);
		await client.close();
		await client2.close();
	}, 30_000);

	test("G2 A2A host + blackboard:能力门控写 + 传输回环 + 签名/防重放", async () => {
		const clockNow = { value: 1_700_000_000_000 };
		const clock = { now: () => clockNow.value };
		const blackboard = new Blackboard({ clock });
		const secret = a2aSecret("bi21-drill-shared-secret");

		const host = new A2aHost({ secret, clock, blackboard });
		const coordinator = host.derive("coordinator", {
			handler: () => ({ from: "coordinator", to: "scout", payload: { task: "探查公报指标" } }),
		});
		host.derive("scout", {
			handler: (delivery) => {
				// scout 无 write 能力:黑板写必须被拒
				expect(() => blackboard.write("audit/direct", { value: "越权", source: "scout" })).toThrow(BlackboardWriteDeniedError);
				// 转交 reporter(有 write 能力)落板
				return { from: "scout", to: "reporter", payload: delivery.payload };
			},
		});
		host.derive("auditor", { handler: () => undefined });
		host.derive("reporter", {
			handler: (delivery) => {
				blackboard.write("audit/gazette", { value: { text: "953680 亿元,同比 4.8%", from: delivery.from }, source: "reporter" });
				return undefined;
			},
		});
		// 能力投影与矩阵断言
		expect(capabilitiesOf("coordinator")).toContain("write");
		expect(capabilitiesOf("scout")).toEqual(["read", "network"]);
		expect(assertCapability("scout", "write").ok).toBe(false);
		expect(assertCapability("reporter", "write").ok).toBe(true);
		expect(capabilitiesOf("stranger")).toEqual([]); // 未知角色 deny-by-default
		// 重复派生同一角色:结构化拒绝
		expect(() => host.derive("coordinator", { handler: () => undefined })).toThrow(/已派生/);

		// fixture 回环传输:send → 回灌本 host(模拟跨网投递边界)
		const bus: { feed: ((raw: unknown) => void) | null } = { feed: null };
		const transport: TransportPort = {
			name: "drill-loopback",
			send: (envelope: SignedEnvelope) => {
				setImmediate(() => bus.feed?.(envelope));
			},
			onMessage: (cb) => {
				bus.feed = cb;
			},
		};
		host.attachTransport(transport);

		// 起始:协调器出站任务 → 回环 → scout 收件
		coordinator.outbox.push({ from: "coordinator", to: "scout", payload: { task: "探查公报指标" } });
		await host.dispatch("coordinator");
		await new Promise((r) => setTimeout(r, 10));
		const handledScout = await host.dispatch("scout");
		expect(handledScout).toBe(1); // scout 收到 1 条投递并转交 reporter
		await new Promise((r) => setTimeout(r, 10)); // scout→reporter 信封经回环边界
		await host.dispatch("reporter");

		// 黑板:reporter 落板,scout 直写被拒(上面已断言),读回一致
		const fact = blackboard.read("audit/gazette");
		expect(fact?.source).toBe("reporter");
		expect((fact?.value as { text: string }).text).toContain("953680");

		// 验签:伪造签名被拒(bad-signature)
		const envelope = { from: "coordinator", to: "auditor", ts: clock.now(), nonce: "n-1", payload: { x: 1 } };
		const signed = signEnvelope(envelope, secret);
		const tampered = { ...signed, signature: "AAAA" };
		expect(verifyEnvelope(tampered, { secret, now: clock.now(), allowFrom: [...A2A_ROLES] }).valid).toBe(false);
		// 正确签名通过
		expect(verifyEnvelope(signed, { secret, now: clock.now(), allowFrom: [...A2A_ROLES] }).valid).toBe(true);
		// 防重放:同一信封二次入站 → replayed
		bus.feed?.(signed);
		await new Promise((r) => setTimeout(r, 5));
		bus.feed?.(signed);
		await new Promise((r) => setTimeout(r, 5));
		const verdict = verifyEnvelope(signed, { secret, now: clock.now(), allowFrom: [...A2A_ROLES] });
		expect(verdict.valid).toBe(false);
		if (!verdict.valid) expect(verdict.reason).toBe("replayed");
	}, 30_000);
});
