/**
 * BI-06.9 — 工作区钩子信任准入门。
 *
 * 信任判定：`.bi/hooks/trust.json` 存在且其 { acceptedAt, fingerprint }
 * 与当前 hooks 清单指纹一致 → 'trusted'。清单指纹 = 对每个钩子文件取
 * `文件名:sha256(内容)` 行，按行排序后 join('\n') 整体再取 sha256
 * （trust.json 本身为接受记录，不计入清单）。
 * 未受信工作区的钩子执行请求一律拒绝（封堵供应链静默执行）。
 */
import { createHash } from 'node:crypto';

export type WorkspaceTrustState = 'trusted' | 'untrusted' | 'none';

/** trust.json 的持久化记录。 */
export interface HookTrustRecord {
  acceptedAt?: string;
  fingerprint?: string;
}

/** 可注入文件系统（测试用内存实现替换）。 */
export interface TrustFs {
  exists(path: string): boolean;
  readFile(path: string): string | null;
  /** 列出目录下的普通文件名；目录不存在返回 null。 */
  listFiles(path: string): string[] | null;
  writeFile(path: string, content: string): void;
}

/** promptTrust 返回的待接受决策（永不直接放行）。 */
export interface TrustPrompt {
  state: WorkspaceTrustState;
  /** 当前 hooks 清单指纹（供用户核对后接受）。 */
  fingerprint: string;
  /** 清单内的钩子文件名（排序）。 */
  hooks: string[];
  /** 已有（可能过期）的接受记录时间。 */
  acceptedAt?: string;
  /** promptTrust 永不直接放行：仅返回待接受决策。 */
  decision: 'pending-acceptance';
}

/** 钩子执行准入裁决。 */
export interface TrustDecision {
  allowed: boolean;
  reason?: string;
}

/** trust.json 相对工作区根的固定路径。 */
export const TRUST_FILE_RELATIVE = '.bi/hooks/trust.json';

/** 单行清单项：`文件名:sha256(内容)`。 */
export function hookEntryLine(name: string, content: string): string {
  throw new Error('BI-06.9 not implemented');
}

/** hooks 清单指纹：行排序后 join('\n') 再取 sha256（空清单为 sha256('')）。 */
export function hooksFingerprint(
  _entries: Array<{ name: string; content: string }>,
): string {
  throw new Error('BI-06.9 not implemented');
}

export class WorkspaceTrustGate {
  /**
   * 判定工作区信任态：
   * - 无 hooks 目录（或清单为空且无接受记录）→ 'none'；
   * - trust.json 缺失/损坏/指纹不匹配（含 stale 接受）→ 'untrusted'；
   * - trust.json 指纹与当前清单一致 → 'trusted'。
   */
  trustState(_workspaceRoot: string, _fs?: TrustFs): WorkspaceTrustState {
    throw new Error('BI-06.9 not implemented');
  }

  /** 返回待接受决策（不写入、不直接放行）。 */
  promptTrust(_workspaceRoot: string, _fs?: TrustFs): TrustPrompt {
    throw new Error('BI-06.9 not implemented');
  }

  /** 以当前清单指纹落盘接受记录（信任必须由用户显式触发）。 */
  acceptTrust(_workspaceRoot: string, _fs?: TrustFs): HookTrustRecord {
    throw new Error('BI-06.9 not implemented');
  }

  /**
   * 钩子执行准入：仅 'trusted' 放行；'untrusted' / 'none' 一律
   * { allowed: false, reason: 'untrusted-workspace' }（fail closed）。
   */
  verifyHook(_hookPath: string, _state: WorkspaceTrustState): TrustDecision {
    throw new Error('BI-06.9 not implemented');
  }
}
