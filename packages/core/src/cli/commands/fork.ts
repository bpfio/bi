/**
 * BI-20.2 —— `fork` 子命令（从既有会话的任意节点分叉出新会话）。
 *
 * kimi 对应物: apps/kimi-code/src/cli/sub/fork.ts
 * 差异边界:
 *   - 分叉本体是 BI-03 SessionManager.fork（append-only 路径拷贝），本模块
 *     只做 CLI 面组合：源会话/分叉点校验 → 结构化错误 → 透传 title；
 *   - title 缺省不注入，交由 manager 缺省策略（`<源标题> (fork)`），避免
 *     CLI 层二次包装造成双份后缀；
 *   - atNode 不在源会话干净条目中 → 结构化 node-missing（先于 manager.fork
 *     校验，避免引擎泛型 Error 漏出）；源会话不存在 → session-missing；
 *     引擎级 SessionFileCorruptError 原样透传（已是强类型错误）；
 *   - 返回 { newSessionId, branchFrom }（branchFrom = 分叉点节点 id）。
 *
 * 消费接线（CLI argv → 本模块）归属 BI-20.1 / 后续装配方；本卡只提供库面。
 */
import { SessionNotFoundError, type SessionManager } from "../../session/manager";

export interface ForkOptions {
  /** 新会话标题；缺省由 manager 取 `<源标题> (fork)`。 */
  title?: string;
}

export interface ForkResult {
  /** 新会话 id（其 JSONL 已含拷贝的祖先路径）。 */
  newSessionId: string;
  /** 分叉点节点 id（新会话的末节点）。 */
  branchFrom: string;
}

export type ForkErrorCode = "session-missing" | "node-missing";

export class ForkError extends Error {
  constructor(
    readonly code: ForkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ForkError";
  }
}

/** 从源会话的 atNode 节点分叉出新会话。 */
export async function forkSession(
  manager: SessionManager,
  sourceId: string,
  atNode: string,
  opts: ForkOptions = {},
): Promise<ForkResult> {
  let loaded;
  try {
    loaded = await manager.loadSession(sourceId);
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      throw new ForkError("session-missing", `源会话不存在: ${sourceId}`);
    }
    throw error;
  }

  if (!loaded.entries.some((entry) => entry.id === atNode)) {
    throw new ForkError("node-missing", `分叉点不存在: ${atNode}（会话 ${sourceId}）`);
  }

  const result = await manager.fork(sourceId, atNode, { title: opts.title });
  return { newSessionId: result.sessionId, branchFrom: result.branchTip };
}
