/**
 * BI-07.10 — `ask_user_question({ questions, mode?, timeoutMs? })` 模型工具处理器。
 *
 * 工具面薄壳：结构校验委托 UserQuestionService（结构化拒绝映射为
 * { ok:false, code, message }，拒绝不走异常控制流）；提问结构、mode/timed
 * 语义、迟到回答队列均由服务核承载。block 模式下本工具调用将挂起至用户
 * 应答或取消（宿主运行环决定是否并发推进其他步骤）。
 */
import type {
	AskResult,
	UserQuestionService,
} from "./user-questions";

export interface AskUserToolSpec {
  readonly name: "AskUserQuestion";
  readonly description: string;
  readonly inputSchema: unknown;
}

export const ASK_USER_QUESTION_TOOL_SPEC: AskUserToolSpec = {
  name: "AskUserQuestion",
  description:
    "向用户发起交互式提问并等待决策。" +
    "mode=block 挂起等待应答；mode=timed 超时先返回 pending 回执" +
    "（模型可先推进其他步骤），用户迟到回答将转为 UserMessage 注入后续上下文。" +
    "决策输出为纯数据（recommended 标记透传；终端呈现由宿主完成）。",
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description: "提问列表（1..n），每项 { id, question, header, options }",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "问题唯一 id（answers 按 id 对齐）" },
            question: { type: "string", description: "问题正文" },
            header: { type: "string", description: "短标签（选项区标题）" },
            options: {
              type: "array",
              description: "选项列表（非空），每项 { label, description?, recommended? }",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "选项名" },
                  description: { type: "string", description: "选项说明" },
                  recommended: { type: "boolean", description: "推荐标记（纯数据透传）" },
                },
                required: ["label"],
              },
            },
          },
          required: ["id", "question", "header", "options"],
        },
      },
      mode: { type: "string", description: "block（缺省）挂起等待；timed 计时挂起" },
      timeoutMs: { type: "integer", description: "timed 模式超时毫秒（须为正整数）" },
    },
    required: ["questions"],
  },
};

export type AskUserToolResult =
  | ({ ok: true } & AskResult)
  | { ok: false; code: string; message: string }
  /** 交互降级：非可交互（headless / 无 TTY）场景的结构化回执，绝不悬挂、绝不抛。 */
  | { answered: false; reason: "no-interactive" };

/** AskUserTool 选项：是否处于可交互（TTY）环境。 */
export interface AskUserToolOptions {
  /**
   * 可交互（TTY）环境？缺省 true（不降级，走既有 IO 挂起语义）。
   * headless 装配置 false：run 直接结构化返回 {answered:false,reason:"no-interactive"}，
   * 绝不调用 service.ask（block 模式会无限挂起），不悬挂不抛。
   */
  readonly interactive?: boolean;
}

function plainArgs(args: unknown): Record<string, unknown> | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  return args as Record<string, unknown>;
}

export class AskUserTool {
  readonly spec = ASK_USER_QUESTION_TOOL_SPEC;
  readonly #service: UserQuestionService;
  readonly #interactive: boolean;

  constructor(service: UserQuestionService, options: AskUserToolOptions = {}) {
    this.#service = service;
    this.#interactive = options.interactive ?? true;
  }

  /** 工具入口。结构化结果，绝不 throw（block 模式 Promise 挂起至应答/取消）。 */
  async run(args: unknown): Promise<AskUserToolResult> {
    // 交互降级安全：非可交互场景直接结构化返回，绝不触碰 service.ask（防 block 悬挂）。
    if (!this.#interactive) {
      return { answered: false, reason: "no-interactive" };
    }
    const input = plainArgs(args);
    if (input === undefined) {
      return { ok: false, code: "invalid-request", message: "参数须为对象" };
    }
    try {
      const result = await this.#service.ask({
        questions: input["questions"] as never,
        mode: input["mode"] as "block" | "timed" | undefined,
        timeoutMs: input["timeoutMs"] as number | undefined,
      });
      return { ok: true, ...result };
    } catch (err) {
      if ((err as { name?: string }).name === "UserQuestionError") {
        return { ok: false, code: (err as { code: string }).code, message: (err as Error).message };
      }
      return { ok: false, code: "internal", message: (err as Error).message };
    }
  }
}
