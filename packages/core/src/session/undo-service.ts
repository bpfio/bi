/**
 * 会话级联撤销状态机（BI-03.4）：`AgentConversationUndoService`。
 *
 * 职责：把会话活跃上下文回退到「倒数第 N 个 user 轮之前」，并向参与者总线
 * 广播 ContextUndoneEvent（文件字节还原等具体回滚由参与方完成）。
 *
 * 切点语义（computeUndoCut）：
 *   - 定位倒数第 N 条 type="user" 的 entry，切点 = 该 entry 之前——该 user
 *     消息及其后的所有 entries 均为 undone；
 *   - cutEntryId = 切点前【最后一条保留条目】的 id（即 rewindTo 目标，后续
 *     追加以 cursor.nextParentId = cutEntryId 开新分支）；切点前无保留条目
 *     （含全撤）时为 null；
 *   - N 超过 user 轮数 → 整会话撤销：{ cutEntryId: null, cutIndex: 0,
 *     undoneCount: 全部 }（全撤到根语义；本卡测试钉死，不抛错）；
 *   - 空会话 / n 非法 → UndoCutError（结构化错误）。
 *
 * 状态机（幂等来源）：undo 的物理层是 append-only 的——rewindTo 不写盘，
 * 被撤销条目仍物理存在，仅凭文件无法区分「未撤销」与「已撤销」。服务实例
 * 内为每个会话维护已撤销条目 id 集合（#undone）：
 *   - 本次候选 undone 条目已全部在集合中 → 返回 { noop: true } 短路（不
 *     rewind、不广播、不还原，文件不再变动）——同参数重复 undo 幂等；
 *   - 撤销加深（undo(1) 后再 undo(2)）：候选集超出已撤销集合的部分为
 *     「新增撤销」，事件只携带新增部分，已还原过的记录不重复广播；
 *   - 撤销后继续会话（在 cursor.nextParentId 下追加新分支）：新分支条目
 *     不在集合中，后续 undo 正常作用于新分支；废弃分支条目已不在活跃路径
 *     上，天然不参与切点计算。
 * 局限：状态为实例内存态，进程重启后同参数 undo 会重复执行一次（各参与方
 * 动作均幂等——restore 同 blob 再写同字节、rewindTo 同节点同游标，终态不
 * 变）；持久化撤销水位归属后续卡片。
 *
 * 组装解耦：本服务不 import FileHistoryService 实现，仅声明最小查询端口
 * UndoFileHistoryPort（类型层面结构兼容 FileHistoryService，由组装方注入
 * 实例）；FileHistoryParticipant 亦由组装方注册进总线。
 */
import type { FileHistoryRecord, HistoryQuery } from "./file-history";
import type { RewindCursor, SessionEntry } from "./types";
import type {
  ContextUndoneEvent,
  UndoParticipantRegistry,
  UndoParticipantResult,
} from "./undo-participants";

/** 撤销切点：entries[0..cutIndex-1] 保留，entries[cutIndex..] 撤销。 */
export interface UndoCut {
  /**
   * 切点前最后一条保留条目的 id（rewindTo 目标，后续追加在其下开新分支）；
   * null = 全撤到根（切点前无任何保留条目）。
   */
  cutEntryId: string | null;
  /** 切点下标（保留前缀长度；全撤为 0）。 */
  cutIndex: number;
  /** 撤销条目数（entries.length - cutIndex）。 */
  undoneCount: number;
}

/** 撤销切点结构化错误。 */
export class UndoCutError extends Error {
  /** 错误码：invalid-n（n 非法）| empty-session（空会话）。 */
  readonly code: "invalid-n" | "empty-session";

  constructor(code: "invalid-n" | "empty-session", message: string) {
    super(message);
    this.name = "UndoCutError";
    this.code = code;
  }
}

/**
 * 计算撤销切点：撤销 N 个 user 轮之前的一切（详见文件头注释）。
 * 非 user 类型条目不参与轮次计数，只跟随所在区间一起撤销/保留。
 */
export function computeUndoCut(entries: SessionEntry[], n: number): UndoCut {
  if (!Number.isInteger(n) || n < 1) {
    throw new UndoCutError("invalid-n", `撤销轮数 n 须为 ≥1 的整数，收到: ${n}`);
  }
  if (entries.length === 0) {
    throw new UndoCutError("empty-session", "空会话无可撤销条目");
  }
  const userIndices: number[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i]?.type === "user") userIndices.push(i);
  }
  // N 超过 user 轮数 → 整会话撤销（全撤到根：无保留条目，cutEntryId=null）。
  if (n > userIndices.length) {
    return { cutEntryId: null, cutIndex: 0, undoneCount: entries.length };
  }
  const cutAt = userIndices[userIndices.length - n];
  if (cutAt === undefined) {
    // 防御：上方 n <= userIndices.length 已保证存在，正常不可达。
    throw new UndoCutError("invalid-n", `无法定位倒数第 ${n} 个 user 轮`);
  }
  const lastKept = cutAt > 0 ? entries[cutAt - 1] : undefined;
  return {
    cutEntryId: lastKept !== undefined ? lastKept.id : null,
    cutIndex: cutAt,
    undoneCount: entries.length - cutAt,
  };
}

/**
 * 文件历史查询端口：撤销服务用于收集撤销窗口内的写前快照。结构兼容
 * FileHistoryService（组装方直接注入其实例），服务自身不 import 其实现。
 */
export interface UndoFileHistoryPort {
  query(filter?: HistoryQuery): Promise<FileHistoryRecord[]>;
}

export interface AgentConversationUndoServiceOptions {
  /** 会话管理器（entries/history/rewindTo，append-only）。 */
  sessionManager: SessionManagerLike;
  /** 参与者总线（广播目标）。 */
  registry: UndoParticipantRegistry;
  /**
   * 文件历史查询端口（可选）：注入后撤销事件携带 undoneFileRecords
   * （撤销窗口 = createdAt ≥ 首条新增撤销条目 createdAt 的本会话快照，
   * 按.createdAt 降序排列）；缺省时事件中该列表为空数组。
   */
  fileHistory?: UndoFileHistoryPort;
}

/** 撤销服务对会话管理器的最小依赖面（SessionManager 结构满足）。 */
export interface SessionManagerLike {
  /** 全量干净条目（seq 升序）；会话不存在抛 SessionNotFoundError。 */
  entries(sessionId: string): Promise<SessionEntry[]>;
  /** 根 → nodeId 活跃路径。 */
  history(sessionId: string, nodeId: string): Promise<SessionEntry[]>;
  /** 时光倒流（纯游标，零物理删除）。 */
  rewindTo(sessionId: string, nodeId: string): Promise<RewindCursor>;
}

/** undo 的返回：切点、会话游标与各参与方结果汇总。 */
export interface UndoResult {
  /** 会话 id。 */
  sessionId: string;
  /** 本次计算出的撤销切点（针对活跃路径的全量候选）。 */
  cut: UndoCut;
  /**
   * 会话游标（rewindTo(cutEntryId) 的结果，后续追加以 nextParentId 开新
   * 分支）；全撤到根或 noop 短路时为 null（无可继续追加的保留节点）。
   */
  cursor: RewindCursor | null;
  /** 幂等短路标记：候选条目已全部撤销过（true 时未发生任何 rewind/广播/还原）。 */
  noop?: true;
  /** 参与方结果（注册顺序；noop 时空数组）。 */
  participants: UndoParticipantResult[];
}

export class AgentConversationUndoService {
  readonly #sessionManager: SessionManagerLike;
  readonly #registry: UndoParticipantRegistry;
  readonly #fileHistory: UndoFileHistoryPort | undefined;
  /** 状态机：sessionId → 已撤销 entry id 集合（实例内存态，见文件头注释）。 */
  readonly #undone = new Map<string, Set<string>>();

  constructor(options: AgentConversationUndoServiceOptions) {
    this.#sessionManager = options.sessionManager;
    this.#registry = options.registry;
    this.#fileHistory = options.fileHistory;
  }

  /**
   * 撤销会话最近 N 个 user 轮：计算切点 → 收集撤销窗口内快照 → rewindTo
   * → 标记状态机 → 串行广播 ContextUndoneEvent。流程详见文件头注释。
   */
  async undo(sessionId: string, n: number): Promise<UndoResult> {
    // 加载全量条目（经 SessionManager 的 jsonl 读取能力；不存在自然上抛
    // SessionNotFoundError）。append-only 铁律：物理文件永不增删改写。
    const entries = await this.#sessionManager.entries(sessionId);
    if (entries.length === 0) {
      throw new UndoCutError("empty-session", `会话 ${sessionId} 为空会话，无可撤销条目`);
    }
    // 活跃路径 = 根 → 物理末条目（当前分支尖端；废弃分支不在其上，
    // 不参与切点计算，也不应被再次撤销）。
    const tip = entries[entries.length - 1];
    if (tip === undefined) {
      throw new UndoCutError("empty-session", `会话 ${sessionId} 无有效条目`);
    }
    const activePath = await this.#sessionManager.history(sessionId, tip.id);
    const cut = computeUndoCut(activePath, n);
    const candidates = activePath.slice(cut.cutIndex);
    const undoneSet = this.#undone.get(sessionId);
    const newlyUndone = undoneSet === undefined
      ? candidates
      : candidates.filter((entry) => !undoneSet.has(entry.id));

    // 幂等短路：候选已全部撤销过 → 不 rewind / 不广播 / 不还原。
    if (newlyUndone.length === 0) {
      return { sessionId, cut, cursor: null, noop: true, participants: [] };
    }

    // 先收集撤销窗口内的写前快照（边界取自 entry 时间戳而非 Date.now()，
    // 保证注入时钟下的确定性与可回放性）。窗口下界 = 首条新增撤销条目的
    // createdAt（含）；上界不设限（尾部在途快照一并保守回滚）。
    const undoneFileRecords = await this.#collectFileRecords(sessionId, newlyUndone[0]!.createdAt);

    // 取得会话游标；全撤到根（cutEntryId=null）时无保留节点，cursor=null。
    const cursor = cut.cutEntryId !== null
      ? await this.#sessionManager.rewindTo(sessionId, cut.cutEntryId)
      : null;

    // 先标记状态机再广播：中途崩溃时状态与已发生的 rewind 保持一致。
    const markSet = undoneSet ?? new Set<string>();
    for (const entry of newlyUndone) markSet.add(entry.id);
    this.#undone.set(sessionId, markSet);

    // 串行广播：逐个 await，注册顺序即广播顺序；单参与方抛错被总线隔离
    // （合成为错误结果），其余照常执行。
    const event: ContextUndoneEvent = {
      sessionId,
      cut,
      undoneEntries: newlyUndone,
      undoneFileRecords,
    };
    const participants: UndoParticipantResult[] = [];
    for (const participant of this.#registry.list()) {
      try {
        participants.push(await participant.onContextUndone(event));
      } catch (error) {
        participants.push({
          id: participant.id,
          restored: [],
          errors: [
            {
              recordId: null,
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        });
      }
    }
    return { sessionId, cut, cursor, participants };
  }

  /** 查询并过滤撤销窗口内快照：createdAt ≥ 窗口下界，按 createdAt 降序。 */
  async #collectFileRecords(sessionId: string, windowStartMs: number): Promise<FileHistoryRecord[]> {
    if (this.#fileHistory === undefined) return [];
    const records = await this.#fileHistory.query({ sessionId });
    return records
      .filter((record) => record.createdAt >= windowStartMs)
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  }
}
