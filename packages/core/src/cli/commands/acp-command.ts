/**
 * BI-20.6 —— `bi acp` 入口：stdio 模式启动 ACP 桥接面（core 侧装配）。
 *
 * 接缝⑤（端口注入，不跨包 import）：@bi/core 为独立叶包（房规同 a2a/workflow），
 * 不声明 @bi/mcp 依赖，因此：
 *   - 桥接面本体（JSON-RPC over stdio / 头帧 / 方法分派）在 @bi/mcp
 *     `packages/mcp/src/acp/acp-bridge.ts`，经 `createBridge` 工厂注入本命令；
 *   - 本文件提供：端口结构契约的 core 侧镜像（AcpAgentPortLike）+
 *     AgentLoop 装配的默认端口实现（createAcpAgentPort）+ stdio 通道 + 命令编排。
 * BI-20.1 装配方把两者对接：createBridge = (channels) => new AcpBridge(channels)。
 *
 * AgentLoop 装配语义（BI-07 房规复用）：
 *   - 每 prompt 一枚新 AgentLoop 实例（idle→thinking→tool-executing→…→idle 单回合）；
 *   - `plan` 注入点把 prompt 文本映射为工具调用计划（LLM 接线归属后续装配方）；
 *   - 工具执行体被包裹：执行前发 `tool_call`（in_progress）、执行后发
 *     `tool_call_update`（completed/failed）流式回执；
 *   - `respond` 注入点产出最终回复文本 → `agent_message_chunk`；
 *   - 客户端 abort → AgentLoop.cancelRequest 二段取消（房规协作式收尾），
 *     被取消调用补发 failed 回执，stopReason = "cancelled"。
 */
import { AgentLoop, type ToolCall, type ToolExecutor, type WriteGatePort } from "../../agent";
import type { Clock } from "../../guard/deadline";

// ---------- 端口结构契约（与 @bi/mcp acp-bridge 结构等价的 core 侧镜像） ----------

/** 工具调用回执形态（与 @bi/mcp AcpSessionUpdate 结构等价）。 */
export type AcpSessionUpdateLike =
	| { sessionUpdate: "agent_message_chunk"; content: { type: "text"; text: string } }
	| { sessionUpdate: "agent_thought_chunk"; content: { type: "text"; text: string } }
	| {
			sessionUpdate: "tool_call";
			toolCallId: string;
			title: string;
			kind?: string;
			status?: string;
			rawInput?: unknown;
	  }
	| {
			sessionUpdate: "tool_call_update";
			toolCallId: string;
			status?: string;
			output?: unknown;
			error?: string;
	  };

/** prompt 输入（与 @bi/mcp AcpPromptInput 结构等价）。 */
export interface AcpPromptInputLike {
	text: string;
	blocks: readonly unknown[];
}

/** prompt 执行上下文（与 @bi/mcp AcpPromptContext 结构等价）。 */
export interface AcpPromptContextLike {
	sessionId: string;
	signal: AbortSignal;
	emit(update: AcpSessionUpdateLike): void;
}

/** agent 执行端口（与 @bi/mcp AcpAgentPort 结构等价；接缝⑤对接面）。 */
export interface AcpAgentPortLike {
	prompt(
		input: AcpPromptInputLike,
		ctx: AcpPromptContextLike,
	): Promise<{ stopReason: string }>;
}

/** 桥接面最小结构契约（与 @bi/mcp AcpBridge 交集；接缝⑤对接面）。 */
export interface AcpBridgeLike {
	start(): Promise<void>;
	stop(): Promise<void>;
	/** 桥接面自然结束（stdin EOF）时 resolve 的可选完成信号。 */
	done?: Promise<void>;
}

// ---------- AgentLoop 装配的默认 agent 端口 ----------

export interface AcpAgentPortOptions {
	/** 真实工具执行体（唯一必填端口；fs/mcp 等具体工具由装配层提供）。 */
	execute: ToolExecutor;
	/** prompt 文本 → 工具调用计划（LLM 接线归属后续装配方；缺省空计划）。 */
	plan?: (
		input: AcpPromptInputLike,
		ctx: AcpPromptContextLike,
	) => readonly ToolCall[] | Promise<readonly ToolCall[]>;
	/** 最终回复文本装配点（缺省不产出消息块）。 */
	respond?: (input: AcpPromptInputLike, ctx: AcpPromptContextLike) => string | Promise<string>;
	/** BI-07 只读工具名单（透传 AgentLoop）。 */
	readOnlyTools?: ReadonlySet<string>;
	/** BI-07 路径声明（透传 AgentLoop）。 */
	fileAccesses?: (call: ToolCall) => readonly string[];
	/** BI-07.2 写前门禁（透传 AgentLoop）。 */
	writeGate?: WriteGatePort;
	/** 注入时钟（透传 AgentLoop）。 */
	clock?: Clock;
}

/**
 * 用 AgentLoop 装配 ACP agent 端口：每 prompt 一枚新 AgentLoop；
 * 工具执行体包裹出 tool_call / tool_call_update 流式回执。
 */
export function createAcpAgentPort(options: AcpAgentPortOptions): AcpAgentPortLike {
	const { execute, plan, respond, readOnlyTools, fileAccesses, writeGate, clock } = options;
	return {
		async prompt(input, ctx): Promise<{ stopReason: string }> {
			if (ctx.signal.aborted) {
				return { stopReason: "cancelled" };
			}
			/** 回执包裹：执行前 tool_call（in_progress），执行后 tool_call_update。 */
			const wrapped: ToolExecutor = async (call, signal) => {
				ctx.emit({
					sessionUpdate: "tool_call",
					toolCallId: call.id,
					title: call.name,
					status: "in_progress",
					rawInput: call.args,
				});
				try {
					const value = await execute(call, signal);
					ctx.emit({
						sessionUpdate: "tool_call_update",
						toolCallId: call.id,
						status: "completed",
						output: value,
					});
					return value;
				} catch (cause) {
					ctx.emit({
						sessionUpdate: "tool_call_update",
						toolCallId: call.id,
						status: "failed",
						error: cause instanceof Error ? cause.message : String(cause),
					});
					throw cause; // 交回 AgentLoop 记为失败结果
				}
			};
			const loop = new AgentLoop({
				execute: wrapped,
				readOnlyTools,
				fileAccesses,
				writeGate,
				clock,
			});
			// 客户端 abort → AgentLoop 二段取消（快速连发两段，落在窗口内）。
			const onAbort = (): void => {
				void loop.cancelRequest().then(() => loop.cancelRequest());
			};
			ctx.signal.addEventListener("abort", onAbort, { once: true });
			try {
				loop.beginTurn();
				const calls = plan ? await plan(input, ctx) : [];
				if (calls.length > 0) {
					const results = await loop.executeTools(calls);
					// 被取消的调用未到达执行体（无回执），此处补发 failed 终态。
					for (const result of results) {
						if (result.cancelled) {
							ctx.emit({
								sessionUpdate: "tool_call_update",
								toolCallId: result.id,
								status: "failed",
								error: "cancelled",
							});
						}
					}
				}
				if (respond) {
					const message = await respond(input, ctx);
					if (message.length > 0) {
						ctx.emit({
							sessionUpdate: "agent_message_chunk",
							content: { type: "text", text: message },
						});
					}
				}
				if (ctx.signal.aborted) {
					return { stopReason: "cancelled" };
				}
				loop.finishTurn();
				return { stopReason: "end_turn" };
			} finally {
				ctx.signal.removeEventListener("abort", onAbort);
			}
		},
	};
}

// ---------- stdio 通道与命令编排 ----------

export interface AcpStdioChannels {
	input: ReadableStream<Uint8Array>;
	output: { write(chunk: Uint8Array): void | Promise<void> };
}

/** 进程 stdio 通道（默认装配；测试注入代替）。 */
export function createStdioChannels(): AcpStdioChannels {
	return {
		input: Bun.stdin.stream(),
		output: {
			write(chunk: Uint8Array): void {
				void import("node:process").then(({ stdout }) => {
					stdout.write(chunk);
				});
			},
		},
	};
}

/** 桥接面工厂（BI-20.1 装配方注入 @bi/mcp 的 AcpBridge 构造）。 */
export type AcpBridgeFactory = (channels: {
	input: ReadableStream<Uint8Array>;
	output: { write(chunk: Uint8Array): void | Promise<void> };
	agent?: AcpAgentPortLike;
}) => AcpBridgeLike;

export interface AcpCommandOptions {
	/** 测试注入：代替 stdin。 */
	input?: ReadableStream<Uint8Array>;
	/** 测试注入：代替 stdout。 */
	output?: { write(chunk: Uint8Array): void | Promise<void> };
	/** agent 端口（缺省用 createAcpAgentPort 的最小装配）。 */
	agent?: AcpAgentPortLike;
	/** 桥接面工厂（接缝⑤；缺省 = 未装配，结构化报错退出）。 */
	createBridge?: AcpBridgeFactory;
	/** 信号处理注册替身（测试注入；缺省挂 SIGINT/SIGTERM）。 */
	onSignal?: (handler: () => void) => void;
}

export interface AcpCommandResult {
	/** 0 = 正常结束；2 = 装配缺失等启动失败。 */
	exitCode: number;
	/** 失败原因（exitCode 非 0 时携带）。 */
	reason?: string;
}

export const ACP_COMMAND_NAME = "acp";

/**
 * `bi acp` 处理器：stdio 模式启动桥接面并阻塞至自然结束/信号。
 * 未注入 createBridge 时结构化退出（exitCode 2），绝不静默。
 */
export async function runAcpCommand(options: AcpCommandOptions = {}): Promise<AcpCommandResult> {
	if (options.createBridge === undefined) {
		return {
			exitCode: 2,
			reason: "acp: 桥接面工厂未装配（接缝⑤：由 BI-20.1 装配方注入 @bi/mcp AcpBridge）",
		};
	}
	const channels: AcpStdioChannels =
		options.input !== undefined || options.output !== undefined
			? {
					input: options.input ?? createStdioChannels().input,
					output: options.output ?? createStdioChannels().output,
				}
			: createStdioChannels();
	const bridge = options.createBridge({ ...channels, agent: options.agent });
	const stopped = bridge.start()
		.then(() => "started" as const)
		.catch((cause: unknown) => {
			throw cause;
		});
	try {
		await stopped;
	} catch (cause) {
		return { exitCode: 2, reason: `acp: 桥接面启动失败: ${String(cause)}` };
	}
	let signalHit = false;
	let stopCalled = false;
	const stopOnce = async (): Promise<void> => {
		if (stopCalled) {
			return;
		}
		stopCalled = true;
		await bridge.stop();
	};
	const handleSignal = (): void => {
		signalHit = true;
		void stopOnce();
	};
	if (options.onSignal !== undefined) {
		options.onSignal(handleSignal);
	} else if (typeof process !== "undefined" && typeof process.on === "function") {
		process.on("SIGINT", handleSignal);
		process.on("SIGTERM", handleSignal);
	}
	if (bridge.done !== undefined) {
		await bridge.done;
	} else {
		// 无 done 信号（真实 stdio）：stdin 泵保持事件循环存活，等进程信号收尾。
		await new Promise<void>((resolve) => {
			const check = setInterval(() => {
				if (signalHit) {
					clearInterval(check);
					resolve();
				}
			}, 200);
			// 计时器不阻断进程退出（unref），仅作信号轮询兜底。
			(unrefTimer as (t: unknown) => void)(check);
		});
	}
	await stopOnce();
	return { exitCode: 0 };
}

/** 定时器 unref 兜底（Bun/node 双兼容；不可用时直通）。 */
function unrefTimer(timer: unknown): void {
	const candidate = timer as { unref?: () => void } | null;
	if (candidate !== null && typeof candidate === "object" && typeof candidate.unref === "function") {
		candidate.unref();
	}
}
