/**
 * BI-06.5 · 三态授权门禁（PermissionGate）——纯决策引擎，零 IO、零 TUI。
 *
 * check() 决策矩阵（顺序钉死，工单原文）：
 *   1. 先查会话记忆：命中 allow 且未过期 → allow(remembered: true)；
 *      命中 deny → deny（remembered: true，附存储的 feedback 原文）。
 *   2. evaluateRules（配置顺序、首个命中生效）：命中 deny → deny；命中
 *      allow → allow；二者均附 matchedRule。
 *   3. 无任何命中时按三态默认（见下方语义裁定）。
 *
 * 三态语义裁定（BI-06.5，本卡工单钉死，供主控复核）：
 * - manual → ask：未显式授权均询问人类（devplan 原义“未显式授权均弹窗”）。
 * - yolo → allow（不带 reasonedDefault）：常规操作自动执行；高危操作的
 *   二次询问语义由 BI-06.8 dangerous 分类在调用侧叠加，本纯决策引擎只输出
 *   allow，不感知“高危”概念。
 * - auto → allow 且 reasonedDefault: true：裁定依据是 devplan 原文
 *   “auto（永不打断人类，全自动决策）”——若 auto 对无规则命中的未知操作
 *   返回 ask，则与“永不打断人类”自相矛盾，属矛盾语义，故按 devplan 原义
 *   实现为全自动默认放行，并以 reasonedDefault 标记与 yolo 放行、规则命中
 *   放行相区分，供上层审计/事后复核。本裁定是工单明文结论，非实现即兴发挥。
 *
 * 模式权威源裁定：门禁运行态 mode（构造注入 + setMode 运行期切换）是唯一
 * 权威模式源，check() 以 gate.mode 决策三态默认；PermissionRequest.mode 是
 * 请求方随请求透传的模式快照（供上层审计/展示），不参与决策——防止调用侧
 * （模型产物）在请求上私盖 mode:"yolo" 自我提权绕过 manual 门禁。
 *
 * 会话记忆顺序语义：记忆先于静态规则是工单钉死的矩阵顺序。产品语义：
 * 用户对本条参数串的显式裁决（批准/拒绝）压过通用配置默认——尤其
 * “用户曾对同一命令说过不”必须压过 blanket allow 规则，这只有记忆优先才能
 * 成立。已知边界：会话中途热更新新增 deny 规则，可能被此前“ask→人工批准”
 * 留下的 allow 记忆压过；缓解手段是调用方在规则热更新时调用
 * clearRemembered() 清空会话记忆（本类提供该方法）。
 */
import { evaluateRules } from "./permission-matcher";
import type {
  PermissionDecision,
  PermissionDecisionType,
  PermissionMode,
  PermissionRequest,
  PermissionRule,
} from "./types";

/** 会话记忆存取与 TTL 选项。 */
export interface SessionApprovalStoreOptions {
  /** 时钟注入（测试 TTL 语义），缺省 Date.now。 */
  readonly now?: () => number;
}

/** 单条会话审批记忆。 */
export interface SessionApprovalEntry {
  /** 工具名（精确）。 */
  readonly tool: string;
  /** 归一化后的参数串（见 normalizeArgSummary）。 */
  readonly pattern: string;
  /** 人工裁决。 */
  readonly decision: "allow" | "deny";
  /** 拒绝时用户输入的反馈原文（原样存储、原样透传）。 */
  readonly feedback?: string;
  /** 记录时刻（注入时钟的 epoch 毫秒）。 */
  readonly recordedAt: number;
  /** 过期时刻（epoch 毫秒）；undefined = 无过期（会话级，随实例存活）。 */
  readonly expiresAt?: number;
}

/** 会话记忆写入选项（remember 第三参的对象形态）。 */
export interface SessionRememberOptions {
  /** 用户反馈原文（deny 时建议携带，allow 时忽略）。 */
  readonly feedback?: string;
  /** 存活时长（毫秒）；缺省无过期（会话级）。 */
  readonly ttlMs?: number;
}

/**
 * 参数串归一化（picomatch/POSIX 语义）：
 * 1. 反斜杠统一视作路径分隔符（POSIX 归一化）；
 * 2. 剥离 "./" 前缀；
 * 3. 去除尾部一个或多个 "/"。
 * 归一化后字符串相等即视为同一会话记忆键（工单语义：“参数串 picomatch
 * 归一化后相等”）。注意这是相等归一化，不是 glob 匹配：记忆键不展开通配。
 */
export function normalizeArgSummary(argSummary: string): string {
  let s = argSummary.replaceAll("\\", "/");
  while (s.startsWith("./")) s = s.slice(2);
  s = s.replace(/\/+$/, "");
  return s;
}

/**
 * 会话审批记忆库：Map 实现，可注入时钟支持 TTL，默认无过期（会话级）。
 * 键 = `tool + "\u0000" + normalizeArgSummary(argSummary)`；过期条目在
 * lookup 时惰性清除。
 */
export class SessionApprovalStore {
  readonly #entries = new Map<string, SessionApprovalEntry>();
  readonly #now: () => number;

  constructor(options: SessionApprovalStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  /** 构造记忆键。 */
  static key(tool: string, normalizedPattern: string): string {
    return `${tool}\u0000${normalizedPattern}`;
  }

  /** 写入一条记忆；同键覆盖（最新裁决生效）。 */
  record(
    tool: string,
    pattern: string,
    decision: "allow" | "deny",
    options: SessionRememberOptions = {},
  ): void {
    const normalized = normalizeArgSummary(pattern);
    const now = this.#now();
    const entry: SessionApprovalEntry = {
      tool,
      pattern: normalized,
      decision,
      ...(options.feedback !== undefined ? { feedback: options.feedback } : {}),
      recordedAt: now,
      ...(options.ttlMs !== undefined ? { expiresAt: now + options.ttlMs } : {}),
    };
    this.#entries.set(SessionApprovalStore.key(tool, normalized), entry);
  }

  /** 读取记忆；不存在或已过期（expiresAt <= now）返回 undefined，过期条目惰性清除。 */
  lookup(tool: string, pattern: string): SessionApprovalEntry | undefined {
    const key = SessionApprovalStore.key(tool, normalizeArgSummary(pattern));
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /** 清空全部会话记忆（规则热更新时的缓解入口）。 */
  clear(): void {
    this.#entries.clear();
  }

  /** 当前有效记忆条数（不含已过期但未触达清除的条目）。 */
  get size(): number {
    return this.#entries.size;
  }
}

/** PermissionGate 构造选项。 */
export interface PermissionGateOptions {
  /** 初始规则表（配置顺序即优先级），缺省空表。 */
  readonly rules?: readonly PermissionRule[];
  /** 初始三态模式（唯一权威模式源），缺省 "manual"（最安全缺省）。 */
  readonly mode?: PermissionMode;
  /** 时钟注入（测试 TTL/记忆过期语义），缺省 Date.now。 */
  readonly now?: () => number;
}

/** remember 的请求参数（PermissionRequest 结构兼容，mode 字段此处不参与）。 */
export type RememberRequest = Pick<PermissionRequest, "tool" | "argSummary">;

/**
 * 三态授权门禁：会话记忆 → 静态规则 → 三态默认 的三层决策矩阵。
 * 实例为纯内存决策体：不弹窗、不读盘、不感知“高危”；ask 的呈现与
 * deny/allow 的人工确认结果由调用方回路到 remember()。
 */
export class PermissionGate {
  #rules: readonly PermissionRule[];
  #mode: PermissionMode;
  readonly #store: SessionApprovalStore;

  constructor(options: PermissionGateOptions = {}) {
    this.#rules = options.rules ?? [];
    this.#mode = options.mode ?? "manual";
    this.#store = new SessionApprovalStore({ now: options.now });
  }

  /** 当前三态模式（唯一权威模式源）。 */
  get mode(): PermissionMode {
    return this.#mode;
  }

  /** 当前规则表快照（配置顺序即优先级）。 */
  get rules(): readonly PermissionRule[] {
    return this.#rules;
  }

  /** 会话记忆条数（观测用）。 */
  get rememberedCount(): number {
    return this.#store.size;
  }

  /** 运行期切换三态模式（如 TUI Shift+Tab 模式切换回路）。 */
  setMode(mode: PermissionMode): void {
    this.#mode = mode;
  }

  /** 运行期追加规则（保持配置顺序：先加者优先；新数组快照，进行中的同步 check 不受影响）。 */
  addRules(rules: readonly PermissionRule[]): void {
    this.#rules = [...this.#rules, ...rules];
  }

  /** 清空会话记忆（规则热更新时调用，防止旧 allow 记忆压过新 deny 规则）。 */
  clearRemembered(): void {
    this.#store.clear();
  }

  /**
   * 记录一次人工裁决为会话记忆。
   *
   * @param req 触发裁决的请求（tool + argSummary 定键；mode 不参与）。
   * @param decision 人工裁决结果。
   * @param feedbackOrOptions 工单签名兼容形态：
   *   - 字符串：视为 feedback（deny 反馈原样存储）；
   *   - 对象：{ feedback?, ttlMs? }，ttlMs 缺省无过期（会话级）。
   */
  remember(
    req: RememberRequest,
    decision: "allow" | "deny",
    feedbackOrOptions?: string | SessionRememberOptions,
  ): void {
    const options: SessionRememberOptions =
      typeof feedbackOrOptions === "string" ? { feedback: feedbackOrOptions } : feedbackOrOptions ?? {};
    this.#store.record(req.tool, req.argSummary, decision, options);
  }

  /**
   * 三层决策矩阵：会话记忆 → 静态规则 → 三态默认。
   * 同步纯函数（除时钟注入外无副作用、无 await），JS 单线程下与
   * addRules/setMode 的交错调用保持程序序一致。
   */
  check(req: PermissionRequest): PermissionDecision {
    // 1) 会话记忆（工单钉死顺序：先于规则；allow 未过期 → allow(remembered)）。
    const entry = this.#store.lookup(req.tool, req.argSummary);
    if (entry !== undefined) {
      if (entry.decision === "allow") {
        return { decision: "allow", remembered: true };
      }
      return {
        decision: "deny",
        remembered: true,
        ...(entry.feedback !== undefined ? { feedback: entry.feedback } : {}),
      };
    }

    // 2) 静态规则：配置顺序首个命中生效。
    const matched = evaluateRules(this.#rules, req);
    if (matched !== undefined) {
      return matched.action === "deny"
        ? { decision: "deny", matchedRule: matched }
        : { decision: "allow", matchedRule: matched };
    }

    // 3) 三态默认（以 gate.mode 为权威源；req.mode 仅为快照，见类注释裁定）。
    const mode = this.#mode;
    if (mode === "manual") return { decision: "ask" };
    if (mode === "yolo") return { decision: "allow" };
    return { decision: "allow", reasonedDefault: true }; // auto：全自动默认放行 + 审计标记
  }
}

/** 决策类型再导出别名（供调用方标注 feedback 回路的目标裁决）。 */
export type { PermissionDecisionType };
