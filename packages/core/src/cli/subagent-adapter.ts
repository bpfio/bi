/**
 * BI-07.4 / BI-07.6 · 子会话装配适配层（生产装配面）。
 *
 * 把器官侧 SubagentRunner 的 LoopFactory 端口组合为真实 AgentLoop（BI-07）子循环，
 * 并桥接会话写端口到 SessionManager（child 会话与父持久化隔离）。器官本体
 * （packages/core/src/subagent/*）只读消费，本文件是装配层、不改动器官。
 *
 * 子循环语义（v1 最小诚实，缺省路径零变化是硬约束）：
 * - 继承父 model port：loopFactory 闭包捕获父 ModelPort，子循环直接复用；
 * - 只读工具子集：父工具集中按 READ_ONLY_SUBAGENT_TOOLS 取交（read_file/grep/
 *   glob/web_fetch/web_search），子循环仅见这五件；
 * - 超时与最大轮次有界：超时经 AbortController 协作取消（流中断结构化收束，
 *   不炸不悬挂）；轮次超上限结构化失败（不抛）；
 * - 子会话持久化与父隔离：sessionWriter 适配器为每条 childSessionId 单独建文件
 *   并自管 parentId 链，绝不触碰父会话文件；主会话历史零追加（spawn 不带
 *   parentSessionId 由调用方决定）。
 *
 * 防递归：运行器官已剥离 Agent/spawn/AskUserQuestion（RecursionHazardTools）；
 * 本适配层只暴露只读工具，子循环无法再派生子智能体（结构性杜绝无限递归）。
 */
import { AgentLoop, type ToolCall, type ToolResult } from "../agent";
import { ToolCallAssembler, type ModelPort, type ToolBinding } from "./headless";
import type {
	AgentMessage,
	StopReason,
	ToolDefinition,
	ToolResultBlock,
	ToolUseBlock,
} from "../adapters/deepseek-adapter";
import {
	SubagentRunner,
	type LoopFactory,
	type SubLoop,
	type SubLoopOutcome,
	type SubLoopSessionCtx,
	type SubagentProfile,
	type SubagentSessionWriter,
	type SubagentEventDraft,
} from "../subagent/runner";
import { SessionManager } from "../session/manager";
import type { AppendEntryInput, JsonValue, SessionEntry } from "../session/types";

/** 子会话继承的只读工具子集（父工具集名 → 子循环可见面）。 */
export const READ_ONLY_SUBAGENT_TOOLS = ["read_file", "grep", "glob", "web_fetch", "web_search"] as const;

function safeStringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

export interface SubagentLoopFactoryDeps {
	/** 父模型端口（继承父对话驱动）。 */
	readonly model: ModelPort;
	/** 父工具集中被授权给子循环的只读子集（已按 READ_ONLY_SUBAGENT_TOOLS 过滤）。 */
	readonly readOnlyTools: readonly ToolBinding[];
	/** 子循环最大回合上限（有界，防止失控）。 */
	readonly maxRounds: number;
	/** 子循环单轮超时毫秒（>0 时启用协作取消；0/≤0 = 不限制）。 */
	readonly timeoutMs: number;
}

/**
 * 组合 AgentLoop 为 SubagentRunner 的 LoopFactory。
 *
 * - profile 仅由运行器官用于决议工具/系统提示；本适配层以注入的只读子集为
 *   实际子循环工具面（v1：子会话恒为只读沙箱，与交付目标一致）；
 * - ctx 提供子循环上下文（prompt / systemPrompt / emit 落盘口 / 历史切片等），
 *   本层用于拼装消息、驱动模型、并把每笔事件 emit 进 childSessionId；
 * - 超时：AbortController 协作取消——模型流监听 signal，超时即 abort，流中断
 *   被捕获为结构化失败（不抛、不悬挂）；
 * - steer 消费（父→子）本期不实现：子循环工具集为只读且不含 SendMessage/
 *   RespondToCoordinator（均属递归危害工具已被剥离），无需 steer 通道。
 */
export function createSubagentLoopFactory(deps: SubagentLoopFactoryDeps): LoopFactory {
	const { model, readOnlyTools, maxRounds, timeoutMs } = deps;
	const registry = new Map<string, ToolBinding>();
	for (const tool of readOnlyTools) registry.set(tool.definition.name, tool);
	const readOnlySet = new Set(readOnlyTools.filter((t) => t.readOnly).map((t) => t.definition.name));

	return (_profile: SubagentProfile, ctx: SubLoopSessionCtx): SubLoop => {
		return {
			async run(): Promise<SubLoopOutcome> {
				// 子循环**不走** [loop_control] 装配面（保持现状）：子代理自带
				// max_iterations / timeout_ms 语义（见 deps.maxRounds / deps.timeoutMs），
				// 与主会话的 [loop_control] 四键互不干涉。
				const agentLoop = new AgentLoop({
					execute: async (call: ToolCall, signal: AbortSignal): Promise<unknown> => {
						const binding = registry.get(call.name);
						if (binding === undefined) throw new Error(`subagent: 未知子工具 ${call.name}`);
						return binding.execute(call.args, signal);
					},
					readOnlyTools: readOnlySet,
				});

				const messages: AgentMessage[] = [];
				if (ctx.systemPrompt.trim() !== "") {
					messages.push({ role: "system", content: ctx.systemPrompt });
				}
				messages.push({ role: "user", content: ctx.prompt });

				let finalText = "";
				let rounds = 0;
				const controller = new AbortController();
				const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
				try {
					while (rounds < maxRounds) {
						rounds += 1;
						if (agentLoop.state === "idle") agentLoop.beginTurn();
						let text = "";
						const assembler = new ToolCallAssembler();
						let stop: StopReason = null;
						try {
							for await (const event of model.stream({
								messages,
								tools: [...registry.values()].map((t) => t.definition as ToolDefinition),
								signal: controller.signal,
							})) {
								if (event.type === "content_delta") {
									text += event.delta;
								} else if (event.type === "tool_call_delta") {
									assembler.push(event);
								} else if (event.type === "done") {
									stop = event.stopReason;
								} else if (event.type === "error") {
									if (controller.signal.aborted) break; // 超时/中止的优雅收束
									return { ok: false, summary: `subagent: 模型错误 ${event.error.code}: ${event.error.message}` };
								}
							}
						} catch (err) {
							// 超时/中止导致流中断：结构化收束（绝不抛、绝不悬挂）。
							if (controller.signal.aborted) {
								return { ok: false, summary: `subagent: 子会话超时（>${timeoutMs}ms）或被取消` };
							}
							const message = err instanceof Error ? err.message : String(err);
							return { ok: false, summary: `subagent: 子循环异常: ${message}` };
						}

						if (stop === "stop" || stop === null) {
							finalText = text;
							if (text !== "") {
								await ctx.emit({ type: "assistant", payload: { text } });
							}
							agentLoop.finishTurn();
							return { ok: true, summary: finalText };
						}

						if (stop !== "tool_use") {
							agentLoop.finishTurn();
							return { ok: false, summary: `subagent: 不可继续的停止原因: ${String(stop)}` };
						}

						// tool_use 回合：assistant(含 tool_use) → 执行 → tool_result 回填，并 emit 进 childSessionId。
						const calls = assembler.drain();
						const useBlocks: ToolUseBlock[] = calls.map((call) => ({
							type: "tool_use",
							id: call.id,
							name: call.name,
							input: call.args,
						}));
						messages.push({ role: "assistant", content: [...useBlocks] });
						await ctx.emit({ type: "assistant", payload: { content: useBlocks } as unknown as JsonValue });

						const results: readonly ToolResult[] = await agentLoop.executeTools(calls);
						const resultBlocks: ToolResultBlock[] = [];
						for (const call of calls) {
							const result = results.find((r) => r.id === call.id);
							const content =
								result === undefined
									? "lost-result"
									: result.ok
										? safeStringify(result.value)
										: `error: ${result.error ?? "unknown"}`;
							resultBlocks.push({
								type: "tool_result",
								toolUseId: call.id,
								content,
								isError: result === undefined || !result.ok,
							});
							await ctx.emit({ type: "tool_call", payload: { name: call.name, args: call.args } as unknown as JsonValue });
							await ctx.emit({
								type: "tool_result",
								payload: { name: call.name, content } as unknown as JsonValue,
							});
						}
						messages.push({ role: "user", content: resultBlocks });
					}
					return { ok: false, summary: `subagent: 子会话回合超上限 ${maxRounds}` };
				} finally {
					if (timer !== undefined) clearTimeout(timer);
				}
			},
		};
	};
}

/**
 * 会话写端口适配器：把 SubagentRunner 的 SubagentSessionWriter（duck-type
 * 单 append 面）桥接到 SessionManager。每条 childSessionId 独立建文件并自管
 * parentId 链（首条 = 根，其后挂前一条），与父会话物理隔离。
 */
export function createSessionWriterAdapter(manager: SessionManager): SubagentSessionWriter {
	const created = new Set<string>();
	const lastId = new Map<string, string | null>();
	return {
		async append(sessionId: string, draft: SubagentEventDraft): Promise<SessionEntry> {
			if (!created.has(sessionId)) {
				await manager.createSession({ sessionId, title: `subagent:${sessionId}` });
				created.add(sessionId);
				lastId.set(sessionId, null);
			}
			const parentId = lastId.get(sessionId) ?? null;
			const input: AppendEntryInput = { type: draft.type, payload: draft.payload };
			if (draft.toolCallId !== undefined) input.toolCallId = draft.toolCallId;
			if (draft.toolName !== undefined) input.toolName = draft.toolName;
			const entry = await manager.append(sessionId, parentId, input);
			lastId.set(sessionId, entry.id);
			return entry;
		},
	};
}

export interface CreateSubagentRunnerDeps {
	/** 父模型端口。 */
	readonly model: ModelPort;
	/** 父工具集（将按 READ_ONLY_SUBAGENT_TOOLS 过滤出只读子集）。 */
	readonly tools: readonly ToolBinding[];
	/** 会话存储根（注入临时目录便于测试隔离）。 */
	readonly sessionsRoot?: string;
	/** 子循环最大回合上限。 */
	readonly maxRounds: number;
	/** 子循环单轮超时毫秒。 */
	readonly timeoutMs: number;
}

/** 生产装配快线：父 model + 父工具集 → 仅注入只读子集的 SubagentRunner。 */
export function createSubagentRunner(deps: CreateSubagentRunnerDeps): SubagentRunner {
	const readOnlyTools = deps.tools.filter((t) =>
		(READ_ONLY_SUBAGENT_TOOLS as readonly string[]).includes(t.definition.name),
	);
	const sessionWriter = createSessionWriterAdapter(
		new SessionManager(deps.sessionsRoot !== undefined ? { rootDir: deps.sessionsRoot } : {}),
	);
	return new SubagentRunner({
		loopFactory: createSubagentLoopFactory({
			model: deps.model,
			readOnlyTools,
			maxRounds: deps.maxRounds,
			timeoutMs: deps.timeoutMs,
		}),
		sessionWriter,
	});
}

/** spawn_subagent 模型工具名（与 SubagentRunner 端口对齐）。 */
export const SPAWN_SUBAGENT_TOOL = "spawn_subagent";

/**
 * config [subagent] 缺省值（与 schema.subagentSchema 默认值保持一致）。
 * 消费点（main.ts 装配 SubagentRunner）在配置层仅声明 enabled 时据此兜底
 * max_iterations / timeout_ms —— 配置层校验为「挂载式偏对象」（与 [verify] 同构，
 * 不回灌默认值），故未显式声明的字段在 BiConfigLayer 中为 undefined，需此处兜底。
 */
export const SUBAGENT_DEFAULT_MAX_ITERATIONS = 8;
export const SUBAGENT_DEFAULT_TIMEOUT_MS = 60_000;

/** 允许显式指定的子角色白名单（fork 需额外克隆源，普通派生恒可用）。 */
const KNOWN_SUBAGENT_PROFILES = ["explore", "coder", "plan", "fork"] as const;

/**
 * spawn_subagent 模型工具绑定（条件注册面，见 BuildDefaultToolsetOptions /
 * HeadlessOptions 的 subagentRunner 注入点）：
 * - 输入 { goal, profile? }；profile 缺省/非法 → 兜底 explore（绝不把非法角色
 *   透传给 SubagentRunner 导致 TypeError）；
 * - 实现 = 经注入的 SubagentRunner 派生只读沙箱子会话（继承父 model port、
 *   只读工具子集、超时与最大轮次有界，由 createSubagentRunner 装配）；
 * - 子会话 finalText（summary）作为工具结果回传父模型；子会话持久化由运行器官
 *   落到专属 childSessionId，与父会话历史隔离（spawn 不带 parentSessionId）。
 * - 绝不抛：一切失败已折叠为 SpawnResult.ok:false，工具结果结构化回传。
 */
export function spawnSubagentBinding(runner: SubagentRunner): ToolBinding {
	return {
		definition: {
			name: SPAWN_SUBAGENT_TOOL,
			description:
				"派生一个只读沙箱子智能体（explore/coder/plan/fork）去完成一个子任务：子循环继承主模型驱动，仅可见 read_file/grep/glob/web_fetch/web_search 五件只读工具，回合与超时均有界，绝不写入主会话历史。子智能体的最终汇总作为本工具结果回传。",
			inputSchema: {
				type: "object",
				properties: {
					goal: { type: "string", description: "子智能体要完成的目标/任务描述" },
					profile: { type: "string", description: "子角色：explore|coder|plan|fork（缺省 explore）" },
				},
				required: ["goal"],
			},
		},
		readOnly: true,
		argSummary: (args) => {
			const raw = args !== null && typeof args === "object" ? (args as Record<string, unknown>)["goal"] : undefined;
			return typeof raw === "string" ? raw.slice(0, 200) : "";
		},
		execute: async (args) => {
			const raw = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
			const goal = raw["goal"];
			if (typeof goal !== "string" || goal.trim() === "") {
				return JSON.stringify({ ok: false, summary: "spawn_subagent: goal 必填且非空" });
			}
			const profileRaw = typeof raw["profile"] === "string" ? (raw["profile"] as string) : "";
			const profile: string =
				profileRaw !== "" && (KNOWN_SUBAGENT_PROFILES as readonly string[]).includes(profileRaw) ? profileRaw : "explore";
			const result = await runner.spawn(profile, goal, {});
			return JSON.stringify({
				ok: result.ok,
				summary: result.summary,
				childSessionId: result.childSessionId,
				profileType: result.profileType,
				toolCalls: result.toolCalls,
				...(result.error !== undefined ? { error: result.error } : {}),
			});
		},
	};
}
