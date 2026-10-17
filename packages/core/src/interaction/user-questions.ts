/**
 * BI-07.10 — 交互式用户提问门与计时挂起恢复器（差异工单）。
 *
 * 职责（工单钉死）：
 * - ask_user_question 模型工具面的服务核：mode=block 创建 PendingQuestion 并
 *   等待 resolve(callId, answers)（宿主/TUI 注入调用）落定 Promise；
 * - mode=timed：注入计时器（Clock 端口）到点后向调用方返回
 *   { pending: true, callId }（模型可先推进其他步骤）；用户迟到提交经
 *   lateAnswer(callId, answers) 转化为 UserMessage 注入待发队列
 *   （takeLateAnswers() 一次性消费）；
 * - resolve 幂等：已答再答 / 未知 callId / 非法 answers 结构化拒绝（返回 false）；
 * - 推荐 (Recommended) 标记透传选项结构（纯数据；TUI 渲染归 BI-19，
 *   决策输出即纯数据，本模块不做任何渲染排版）。
 * - cancel：未答状态可取消（落定 cancelled）；timed 到点后不可取消（已回执模型）。
 */
import type { Clock } from "../guard/deadline";
import { systemClock } from "../guard/deadline";

export interface UserQuestionOption {
  label: string;
  description?: string;
  /** 推荐 (Recommended) 标记：纯数据透传，消费方决定如何呈现。 */
  recommended?: boolean;
}

export interface UserQuestion {
  id: string;
  question: string;
  header: string;
  options: UserQuestionOption[];
}

export interface UserAnswer {
  questionId: string;
  selected: string[];
}

/** 迟到回答转化出的 UserMessage（纯数据；text 为确定性序列化，供转录/注入）。 */
export interface LateAnswerMessage {
  role: "user";
  callId: string;
  answers: UserAnswer[];
  text: string;
}

export type AskResult =
  | { pending: false; callId: string; answers: UserAnswer[]; cancelled: false }
  | { pending: false; callId: string; answers: null; cancelled: true }
  | { pending: true; callId: string; timeoutMs: number };

export type PendingStatus = "pending" | "answered" | "cancelled" | "timed-out";

export interface PendingQuestion {
  callId: string;
  questions: UserQuestion[];
  mode: "block" | "timed";
  createdAt: number;
  /** timed 模式的绝对到点时刻；block 为 null。 */
  deadlineAt: number | null;
  status: PendingStatus;
}

export type UserQuestionErrorCode =
  | "invalid-request"
  | "unknown-call"
  | "not-pending"
  | "not-timed-out"
  | "invalid-answers";

/** 结构化错误（判别方式：code 字段；工具面映射为 ok:false 结果）。 */
export class UserQuestionError extends Error {
  readonly code: UserQuestionErrorCode;

  constructor(code: UserQuestionErrorCode, message: string) {
    super(message);
    this.name = "UserQuestionError";
    this.code = code;
  }
}

export interface UserQuestionServiceOptions {
  /** 注入时钟：计时器（setTimeout/clearTimeout）与时刻基准。 */
  readonly clock?: Clock;
  readonly idGen?: () => string;
}

function defaultAskIdGen(): () => string {
  let n = 0;
  return () => `q-${++n}`;
}

interface PendingRecord {
  callId: string;
  questions: UserQuestion[];
  mode: "block" | "timed";
  createdAt: number;
  deadlineAt: number | null;
  status: PendingStatus;
  timer: unknown;
  settle: (result: AskResult) => void;
}

export interface AskRequest {
  questions: UserQuestion[];
  mode?: "block" | "timed";
  timeoutMs?: number;
}

export class UserQuestionService {
  readonly #clock: Clock;
  readonly #idGen: () => string;
  readonly #records = new Map<string, PendingRecord>();
  readonly #lateQueue: LateAnswerMessage[] = [];

  constructor(options: UserQuestionServiceOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#idGen = options.idGen ?? defaultAskIdGen();
  }

  /**
   * 模型工具面入口。block 模式返回落定 Promise（等待 resolve/cancel）；
   * timed 模式到点经注入计时器回执 { pending: true, callId }。
   */
  ask(request: AskRequest): Promise<AskResult> {
    const questions = this.#validateRequest(request);
    const mode = request.mode ?? "block";
    const callId = this.#idGen();
    const createdAt = this.#clock.now();
    let deadlineAt: number | null = null;
    let timer: unknown = null;
    if (mode === "timed") {
      const timeoutMs = request.timeoutMs as number;
      deadlineAt = createdAt + timeoutMs;
      timer = this.#clock.setTimeout(() => this.#fireTimeout(callId), timeoutMs);
    }
    return new Promise<AskResult>((resolve) => {
      this.#records.set(callId, {
        callId,
        questions,
        mode,
        createdAt,
        deadlineAt,
        status: "pending",
        timer,
        settle: resolve,
      });
    });
  }

  /**
   * 宿主注入回答：仅 pending 可 resolve（已答再答 / 非法 answers / 未知
   * callId 一律 false 结构化拒绝）；成功落定 ask Promise 并清理计时器。
   */
  resolve(callId: string, answers: UserAnswer[]): boolean {
    const record = this.#records.get(callId);
    if (record === undefined) return false;
    if (record.status !== "pending") return false;
    if (!this.#validAnswers(record, answers)) return false;
    this.#clearTimer(record);
    record.status = "answered";
    record.settle({
      pending: false,
      callId,
      answers: cloneAnswers(answers),
      cancelled: false,
    });
    return true;
  }

  /** 迟到提交（timed 已超时后）：校验后转化为 UserMessage 入待发队列。 */
  lateAnswer(callId: string, answers: UserAnswer[]): boolean {
    const record = this.#records.get(callId);
    if (record === undefined) return false;
    if (record.status !== "timed-out") return false;
    if (!this.#validAnswers(record, answers)) return false;
    record.status = "answered";
    const cloned = cloneAnswers(answers);
    this.#lateQueue.push({
      role: "user",
      callId,
      answers: cloned,
      text: lateAnswerText(callId, cloned),
    });
    return true;
  }

  /** 一次性消费迟到回答队列（空队列返回空数组）。 */
  takeLateAnswers(): LateAnswerMessage[] {
    return this.#lateQueue.splice(0, this.#lateQueue.length);
  }

  /** 取消挂起提问：仅 pending 可取消；timed 到点后不可取消（已回执）。 */
  cancel(callId: string): boolean {
    const record = this.#records.get(callId);
    if (record === undefined) return false;
    if (record.status !== "pending") return false;
    this.#clearTimer(record);
    record.status = "cancelled";
    record.settle({ pending: false, callId, answers: null, cancelled: true });
    return true;
  }

  /** 当前挂起/已超时待迟到回答的提问快照（深拷贝，外改不污染内部）。 */
  pending(): PendingQuestion[] {
    const out: PendingQuestion[] = [];
    for (const record of this.#records.values()) {
      if (record.status !== "pending" && record.status !== "timed-out") continue;
      out.push({
        callId: record.callId,
        mode: record.mode,
        createdAt: record.createdAt,
        deadlineAt: record.deadlineAt,
        status: record.status,
        questions: structuredClone(record.questions),
      });
    }
    return out;
  }

  #fireTimeout(callId: string): void {
    const record = this.#records.get(callId);
    if (record === undefined || record.status !== "pending") return;
    record.status = "timed-out";
    record.settle({
      pending: true,
      callId,
      timeoutMs: (record.deadlineAt as number) - record.createdAt,
    });
  }

  #clearTimer(record: PendingRecord): void {
    if (record.timer !== null) {
      this.#clock.clearTimeout(record.timer);
      record.timer = null;
    }
  }

  #validateRequest(request: AskRequest): UserQuestion[] {
    if (typeof request !== "object" || request === null || Array.isArray(request)) {
      throw new UserQuestionError("invalid-request", "请求须为对象");
    }
    const raw = (request as { questions?: unknown }).questions;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new UserQuestionError("invalid-request", "questions 须为非空数组");
    }
    const ids = new Set<string>();
    const questions: UserQuestion[] = [];
    for (const q of raw as Array<Record<string, unknown>>) {
      if (typeof q !== "object" || q === null) {
        throw new UserQuestionError("invalid-request", "question 须为对象");
      }
      const { id, question, header, options } = q as Record<string, unknown>;
      if (typeof id !== "string" || id.length === 0) {
        throw new UserQuestionError("invalid-request", "question.id 须为非空字符串");
      }
      if (typeof question !== "string" || question.length === 0) {
        throw new UserQuestionError("invalid-request", `question[${id}].question 须为非空字符串`);
      }
      if (typeof header !== "string" || header.length === 0) {
        throw new UserQuestionError("invalid-request", `question[${id}].header 须为非空字符串`);
      }
      if (!Array.isArray(options) || options.length === 0) {
        throw new UserQuestionError("invalid-request", `question[${id}].options 须为非空数组`);
      }
      if (ids.has(id)) {
        throw new UserQuestionError("invalid-request", `question id 重复: ${id}`);
      }
      ids.add(id);
      const labels = new Set<string>();
      const clonedOptions: UserQuestionOption[] = [];
      for (const o of options as Array<Record<string, unknown>>) {
        if (typeof o !== "object" || o === null) {
          throw new UserQuestionError("invalid-request", `question[${id}] option 须为对象`);
        }
        const { label, description, recommended } = o;
        if (typeof label !== "string" || label.length === 0) {
          throw new UserQuestionError("invalid-request", `question[${id}] option.label 须为非空字符串`);
        }
        if (labels.has(label)) {
          throw new UserQuestionError("invalid-request", `question[${id}] option.label 重复: ${label}`);
        }
        labels.add(label);
        const option: UserQuestionOption = { label };
        if (description !== undefined) option.description = description as string;
        if (recommended !== undefined) option.recommended = recommended as boolean;
        clonedOptions.push(option);
      }
      questions.push({ id, question, header, options: clonedOptions });
    }
    const mode = (request as { mode?: unknown }).mode ?? "block";
    if (mode !== "block" && mode !== "timed") {
      throw new UserQuestionError("invalid-request", `mode 须为 block|timed: ${String(mode)}`);
    }
    if (mode === "timed") {
      const timeoutMs = (request as { timeoutMs?: unknown }).timeoutMs;
      if (!Number.isInteger(timeoutMs) || (timeoutMs as number) <= 0) {
        throw new UserQuestionError("invalid-request", `timed 模式须有正整数 timeoutMs: ${String(timeoutMs)}`);
      }
    }
    return questions;
  }

  #validAnswers(record: PendingRecord, answers: UserAnswer[]): boolean {
    if (!Array.isArray(answers) || answers.length === 0) return false;
    const byId = new Map(record.questions.map((q) => [q.id, q]));
    const seen = new Set<string>();
    for (const answer of answers) {
      if (typeof answer !== "object" || answer === null) return false;
      const { questionId, selected } = answer;
      if (typeof questionId !== "string" || !byId.has(questionId)) return false;
      if (seen.has(questionId)) return false;
      seen.add(questionId);
      if (!Array.isArray(selected) || selected.length === 0) return false;
      const labels = new Set(byId.get(questionId)!.options.map((o) => o.label));
      for (const label of selected) {
        if (typeof label !== "string" || !labels.has(label)) return false;
      }
    }
    return true;
  }
}

/** 确定性迟到消息文本（纯数据序列化；TUI 呈现归 BI-19）。 */
export function lateAnswerText(callId: string, answers: UserAnswer[]): string {
  const parts = answers.map((a) => `${a.questionId}=${a.selected.join("/")}`);
  return `[迟到用户回答] 提问 ${callId}：${parts.join("；")}`;
}

function cloneAnswers(answers: UserAnswer[]): UserAnswer[] {
  return answers.map((a) => ({ questionId: a.questionId, selected: [...a.selected] }));
}
