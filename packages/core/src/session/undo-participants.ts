/**
 * 会话级联撤销参与者总线（BI-03.4）：ContextUndoneEvent / UndoParticipant /
 * UndoParticipantRegistry / FileHistoryParticipant。
 *
 * 总线解耦原则：
 *   - 撤销服务（undo-service.ts）只依赖本文件的抽象（UndoParticipant /
 *     UndoParticipantRegistry），不感知任何具体参与方；
 *   - 参与方内部错误一律不上抛：onContextUndone 内部逐项 try/catch 并把失败
 *     收进 Result.errors（FileHistoryParticipant 的既有语义）；若参与方实现
 *     仍然抛出（编程错误），由服务端总线兜底捕获并合成为错误结果，其余
 *     参与方照常执行（广播隔离）；
 *   - 未来的第二参与方（如 BI-03.1 的 diff 回滚轨）直接注册接入，本文件不
 *     预留其代码，仅保证总线可多注册。
 *
 * 撤销窗口契约：ContextUndoneEvent.undoneFileRecords 按 createdAt 降序排列
 * （最新在前，与 FileHistoryService.query 的既有排序一致）。参与方必须按该
 * 顺序逐条还原——后还原的旧快照会覆盖先还原的新快照，最终落盘状态即切点
 * 时刻的文件状态（级联撤销的正确性依赖此顺序）。
 */
import type { FileHistoryRecord, FileHistoryService, RestoreResult } from "./file-history";
import type { SessionEntry } from "./types";
import type { UndoCut } from "./undo-service";

/** 撤销事件：会话上下文被回退到切点时广播给全部参与方的载体。 */
export interface ContextUndoneEvent {
  /** 会话 id。 */
  sessionId: string;
  /** 本次撤销切点（与撤销服务返回的 cut 同一对象语义）。 */
  cut: UndoCut;
  /**
   * 本次【新增】被撤销的会话条目（时间升序；重复撤销时已被撤销过的条目
   * 不会再次出现在此列表——幂等短路由撤销服务负责）。
   */
  undoneEntries: SessionEntry[];
  /**
   * 撤销窗口内的写前快照记录（createdAt 降序，最新在前；见文件头注释的
   * 顺序契约）。撤销服务未注入文件历史查询端口时为空数组。
   */
  undoneFileRecords: FileHistoryRecord[];
}

/** 参与方结果中的一条还原明细。 */
export interface UndoRestoredItem {
  /** 关联记录 id（文件历史记录 id；无记录语义的参与方可自定 id）。 */
  recordId: string;
  /** 被还原的目标文件（绝对路径）。 */
  filePath: string;
  /** 还原前内容 SHA-256；目标不存在时为 null。 */
  beforeSha: string | null;
  /** 还原后内容 SHA-256。 */
  afterSha: string;
}

/** 参与方结果中的一条失败明细（逐项收集，不上抛）。 */
export interface UndoParticipantError {
  /** 关联记录 id；与具体记录无关的总线级失败为 null。 */
  recordId: string | null;
  /** 错误消息（Error.message 或 String(error)）。 */
  message: string;
}

/** 参与方执行结果：per-participant restored/errors 汇总。 */
export interface UndoParticipantResult {
  /** 参与方 id（与 UndoParticipant.id 一致，便于结果对位）。 */
  id: string;
  /** 成功还原明细（按执行顺序）。 */
  restored: UndoRestoredItem[];
  /** 失败明细（逐项收集；参与方内部错误不上抛）。 */
  errors: UndoParticipantError[];
}

/** 撤销参与方：会话上下文被撤销时的回滚动作实现。 */
export interface UndoParticipant {
  /** 全局唯一 id（注册表按此去重）。 */
  readonly id: string;
  /** 收到撤销事件；实现必须自行收集内部错误，不得上抛（总线隔离原则）。 */
  onContextUndone(event: ContextUndoneEvent): Promise<UndoParticipantResult>;
}

/** 注册表 id 冲突：同 id 重复注册。 */
export class DuplicateParticipantError extends Error {
  readonly participantId: string;

  constructor(participantId: string) {
    super(`撤销参与方 id 已注册: ${participantId}`);
    this.name = "DuplicateParticipantError";
    this.participantId = participantId;
  }
}

/**
 * 参与方注册表：register/unregister/get/list，按 id 去重（重复注册抛
 * DuplicateParticipantError，显式失败优于静默覆盖）；list 保持注册顺序
 * （广播顺序 = 注册顺序）。
 */
export class UndoParticipantRegistry {
  readonly #participants = new Map<string, UndoParticipant>();

  /** 注册参与方；id 重复抛 DuplicateParticipantError。 */
  register(participant: UndoParticipant): void {
    if (this.#participants.has(participant.id)) {
      throw new DuplicateParticipantError(participant.id);
    }
    this.#participants.set(participant.id, participant);
  }

  /** 注销参与方；存在返回 true，不存在返回 false。 */
  unregister(id: string): boolean {
    return this.#participants.delete(id);
  }

  /** 按 id 查找；不存在返回 undefined。 */
  get(id: string): UndoParticipant | undefined {
    return this.#participants.get(id);
  }

  /** 全部参与方（注册顺序）。 */
  list(): UndoParticipant[] {
    return [...this.#participants.values()];
  }
}

/**
 * 文件历史参与方：对撤销窗口内的写前快照逐条 restore（字节级物理还原）。
 *
 * - 顺序：按 event.undoneFileRecords 顺序（createdAt 降序，最新在前）执行，
 *   最终落盘状态 = 窗口内最早快照的内容 = 切点时刻的文件状态；
 * - 幂等：FileHistoryService.restore 本身幂等（同 blob 再写同字节），重复
 *   广播/重复还原不改变文件终态；
 * - 隔离：单条 restore 失败（如记录缺失、blob 损坏）逐项收进 errors，不
 *   中断其余记录的还原，也不上抛。
 */
export class FileHistoryParticipant implements UndoParticipant {
  readonly id = "file-history";
  readonly #fileHistory: FileHistoryService;

  constructor(fileHistory: FileHistoryService) {
    this.#fileHistory = fileHistory;
  }

  async onContextUndone(event: ContextUndoneEvent): Promise<UndoParticipantResult> {
    const restored: UndoRestoredItem[] = [];
    const errors: UndoParticipantError[] = [];
    for (const record of event.undoneFileRecords) {
      try {
        const result: RestoreResult = await this.#fileHistory.restore(record.id);
        restored.push({
          recordId: result.recordId,
          filePath: result.filePath,
          beforeSha: result.beforeSha256,
          afterSha: result.afterSha256,
        });
      } catch (error) {
        errors.push({
          recordId: record.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { id: this.id, restored, errors };
  }
}
