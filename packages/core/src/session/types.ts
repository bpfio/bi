/**
 * 会话条目与会话元数据强类型（BI-03）。
 *
 * 存储模型：append-only JSONL，每行一条自描述记录；条目间以
 * UUIDv7 `id` / `parentId` 构成森林（每会话一棵树，根节点 parentId=null），
 * 天然支持 fork 分支与 rewind 时光倒流（物理记录永不删除）。
 */

/** JSON 安全值（JSON.parse 的输出必然满足该类型）。 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** 会话条目类型联合。 */
export type SessionEntryType =
  | "user" // 用户输入
  | "assistant" // 模型输出
  | "tool_call" // 工具调用请求（与 tool_result 配对，配对门禁归属 BI-10.2）
  | "tool_result" // 工具执行结果（与 tool_call 配对，配对门禁归属 BI-10.2）
  | "system" // 系统注入（提醒/错误/环境事件）
  | "compaction"; // 压缩摘要条目（归属 BI-10 Auto-Compactor）

const ENTRY_TYPES: readonly SessionEntryType[] = [
  "user",
  "assistant",
  "tool_call",
  "tool_result",
  "system",
  "compaction",
];

/** 运行时校验条目类型（用于加载外部数据与索引重建）。 */
export function isSessionEntryType(value: unknown): value is SessionEntryType {
  return typeof value === "string" && (ENTRY_TYPES as readonly string[]).includes(value);
}

/** 会话条目：JSONL 中每个 entry 记录的形状。 */
export interface SessionEntry {
  /** 条目唯一 id（UUIDv7，字典序即时间序）。 */
  id: string;
  /** 父条目 id；根节点为 null。每个会话至多一个根（首条目）。 */
  parentId: string | null;
  /** 条目类型。 */
  type: SessionEntryType;
  /** 业务负载（JSON 值；各类型的具体 schema 归属上层模块）。 */
  payload: JsonValue;
  /** 创建时间（unix 毫秒时间戳）。 */
  createdAt: number;
  /** 会话内单调递增序号（从 1 开始，按物理追加顺序）。 */
  seq: number;
  /**
   * 工具配对预留字段（BI-10.2 原子配对门禁归属，本卡仅占位不校验）：
   * tool_call 与 tool_result 通过同一 toolCallId 关联。
   */
  toolCallId?: string;
  /** 工具配对预留字段：触发的工具名。 */
  toolName?: string;
}

/** 会话元数据：每个会话 JSONL 文件的首行（meta 记录），创建后不可变。 */
export interface SessionMeta {
  /** 会话 id（UUIDv7，即文件名 <sessionId>.jsonl）。 */
  sessionId: string;
  /** 会话标题。 */
  title: string;
  /** 会话创建时间（unix 毫秒时间戳）。 */
  createdAt: number;
  /** 创建会话时的工作目录。 */
  cwd?: string;
  /** 若由 fork 派生，记录源会话 id。 */
  forkedFrom?: string;
}

/** append 的输入：仅业务字段，id/createdAt/seq 由 SessionManager 分配。 */
export interface AppendEntryInput {
  /** 条目类型。 */
  type: SessionEntryType;
  /** 业务负载（JSON 值）。 */
  payload: JsonValue;
  /** 工具配对预留字段（仅 tool_call / tool_result 使用）。 */
  toolCallId?: string;
  /** 工具配对预留字段（仅 tool_call / tool_result 使用）。 */
  toolName?: string;
}

/** loadSession 的完整结果：含崩溃容忍的截断位点信息。 */
export interface LoadedSession {
  /** 会话元数据（首行）。 */
  meta: SessionMeta;
  /** 干净条目（残缺尾部已丢弃），按 seq 升序。 */
  entries: SessionEntry[];
  /** 文件是否存在末尾残缺区（已被丢弃，待下次追加前物理截断）。 */
  truncated: boolean;
  /** 干净字节边界：截断位点（未残缺时等于文件字节数）。 */
  cleanLength: number;
}

/** fork 的结果：新分支会话句柄。 */
export interface ForkResult {
  /** 新会话 id（其 JSONL 已含拷贝的祖先路径）。 */
  sessionId: string;
  /** 源会话 id。 */
  forkedFrom: string;
  /** 分叉点节点 id（新会话的末节点）。 */
  branchTip: string;
  /** 拷贝进新会话的条目数（根 → 分叉点路径）。 */
  copied: number;
}

/** rewindTo 的结果：应继续的分支游标（物理历史永不删除）。 */
export interface RewindCursor {
  /** 会话 id。 */
  sessionId: string;
  /** 倒流目标节点 id。 */
  nodeId: string;
  /** 继续追加时应传入 append 的 parentId（即 nodeId，形成新分支）。 */
  nextParentId: string;
  /** 活跃路径（根 → nodeId）长度。 */
  pathLength: number;
  /** 会话内总条目数（含倒流丢弃与既有废弃分支的物理记录，全部保留在盘上）。 */
  totalEntries: number;
}
