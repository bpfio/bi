/**
 * BI-06.9 — 工作区钩子信任准入门（WorkspaceTrustGate）。
 *
 * 信任判定（工单钉死）：`.bi/hooks/trust.json` 存在且其内容
 * { acceptedAt, fingerprint } 与当前 hooks 清单指纹一致 → 'trusted'。
 * 清单指纹 = 对 `.bi/hooks/` 下每个钩子文件（trust.json 本身为接受记录，
 * 不计入清单）取 `文件名:sha256(内容)` 行，按行排序后 join('\n') 整体再取
 * sha256——文件新增/删除/内容篡改任一都会改变指纹，从而检出 stale 接受。
 *
 * 三态语义：
 * - 'none'：无 hooks 目录（无可信任面），或目录存在但无钩子且从无接受记录；
 * - 'untrusted'：有钩子但无接受记录 / trust.json 损坏或缺 fingerprint /
 *   指纹不匹配（含接受后钩子清单发生变更的 stale 接受）；
 * - 'trusted'：指纹匹配。
 *
 * promptTrust 永不直接放行：仅返回带当前指纹与钩子清单的待接受决策；
 * 信任落盘由用户显式触发的 acceptTrust 完成。verifyHook 对非 'trusted'
 * 态的钩子执行请求一律 { allowed: false, reason: 'untrusted-workspace' }
 * （fail closed，封堵供应链静默执行）。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type WorkspaceTrustState = "trusted" | "untrusted" | "none";

/** trust.json 的持久化记录。 */
export interface HookTrustRecord {
  acceptedAt?: string;
  fingerprint?: string;
}

/** 可注入文件系统（测试用内存实现替换，零真实盘 IO）。 */
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
  decision: "pending-acceptance";
}

/** 钩子执行准入裁决。 */
export interface TrustDecision {
  allowed: boolean;
  /** 拒绝原因：'untrusted-workspace'（untrusted / none 一律此值）。 */
  reason?: string;
}

/** hooks 目录相对工作区根的固定路径。 */
export const HOOKS_DIR_RELATIVE = ".bi/hooks";
/** 接受记录文件名（清单指纹计算时排除自身）。 */
export const TRUST_RECORD_NAME = "trust.json";
/** trust.json 相对工作区根的固定路径。 */
export const TRUST_FILE_RELATIVE = ".bi/hooks/trust.json";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** 单行清单项：`文件名:sha256(内容)`。 */
export function hookEntryLine(name: string, content: string): string {
  return `${name}:${sha256Hex(content)}`;
}

/** hooks 清单指纹：行排序后 join('\n') 再取 sha256（空清单 = sha256('')）。 */
export function hooksFingerprint(
  entries: Array<{ name: string; content: string }>,
): string {
  const lines = entries.map((entry) => hookEntryLine(entry.name, entry.content)).sort();
  return sha256Hex(lines.join("\n"));
}

/** 缺省真实文件系统适配（node:fs 同步面；读失败统一折叠为 null，不抛错）。 */
export const nodeTrustFs: TrustFs = {
  exists: (path) => existsSync(path),
  readFile: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  listFiles: (path) => {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort();
    } catch {
      return null;
    }
  },
  writeFile: (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  },
};

export class WorkspaceTrustGate {
  readonly #defaultFs: TrustFs | undefined;

  /** 可注入缺省 fs；方法级 injectFs 优先（工单签名 trustState(root, injectFs)）。 */
  constructor(defaultFs?: TrustFs) {
    this.#defaultFs = defaultFs;
  }

  #resolveFs(injectFs?: TrustFs): TrustFs {
    return injectFs ?? this.#defaultFs ?? nodeTrustFs;
  }

  #hooksDir(workspaceRoot: string): string {
    return join(workspaceRoot, ".bi", "hooks");
  }

  #trustPath(workspaceRoot: string): string {
    return join(workspaceRoot, ".bi", "hooks", TRUST_RECORD_NAME);
  }

  /** 当前清单（钩子名排序 + 指纹）；无 hooks 目录返回 null。 */
  #manifest(
    workspaceRoot: string,
    fs: TrustFs,
  ): { hooks: string[]; fingerprint: string } | null {
    const dir = this.#hooksDir(workspaceRoot);
    const names = fs.listFiles(dir);
    if (names === null) return null;
    const hooks = names.filter((name) => name !== TRUST_RECORD_NAME).sort();
    const entries = hooks.map((name) => ({
      name,
      content: fs.readFile(join(dir, name)) ?? "",
    }));
    return { hooks, fingerprint: hooksFingerprint(entries) };
  }

  /** 读取接受记录；缺失或损坏（非 JSON / 结构不符）返回 null。 */
  #readRecord(workspaceRoot: string, fs: TrustFs): HookTrustRecord | null {
    const raw = fs.readFile(this.#trustPath(workspaceRoot));
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object") return null;
      const record = parsed as Record<string, unknown>;
      return {
        ...(typeof record.acceptedAt === "string" ? { acceptedAt: record.acceptedAt } : {}),
        ...(typeof record.fingerprint === "string" ? { fingerprint: record.fingerprint } : {}),
      };
    } catch {
      return null;
    }
  }

  #decide(
    manifest: { hooks: string[]; fingerprint: string } | null,
    record: HookTrustRecord | null,
    hasTrustFile: boolean,
  ): WorkspaceTrustState {
    if (manifest === null) return "none";
    if (record === null) {
      // 无记录：无钩子且从无接受记录 = 无可信任面；有钩子 = 未信任。
      // 有文件但损坏：信任工件存在却不可解析，fail closed。
      if (hasTrustFile) return "untrusted";
      return manifest.hooks.length === 0 ? "none" : "untrusted";
    }
    if (record.fingerprint === undefined) return "untrusted";
    return record.fingerprint === manifest.fingerprint ? "trusted" : "untrusted";
  }

  /**
   * 判定工作区信任态（三态语义见文件头注释）。
   * @param injectFs 可注入文件系统（缺省 node:fs 适配）。
   */
  trustState(workspaceRoot: string, injectFs?: TrustFs): WorkspaceTrustState {
    const fs = this.#resolveFs(injectFs);
    const manifest = this.#manifest(workspaceRoot, fs);
    const record = this.#readRecord(workspaceRoot, fs);
    return this.#decide(manifest, record, fs.exists(this.#trustPath(workspaceRoot)));
  }

  /** 返回待接受决策（不写入、不直接放行）。 */
  promptTrust(workspaceRoot: string, injectFs?: TrustFs): TrustPrompt {
    const fs = this.#resolveFs(injectFs);
    const manifest = this.#manifest(workspaceRoot, fs);
    const record = this.#readRecord(workspaceRoot, fs);
    const state = this.#decide(manifest, record, fs.exists(this.#trustPath(workspaceRoot)));
    return {
      state,
      fingerprint: manifest?.fingerprint ?? hooksFingerprint([]),
      hooks: manifest?.hooks ?? [],
      ...(record?.acceptedAt !== undefined ? { acceptedAt: record.acceptedAt } : {}),
      decision: "pending-acceptance",
    };
  }

  /** 以当前清单指纹落盘接受记录（信任必须由用户显式触发；幂等重写）。 */
  acceptTrust(workspaceRoot: string, injectFs?: TrustFs): HookTrustRecord {
    const fs = this.#resolveFs(injectFs);
    const manifest = this.#manifest(workspaceRoot, fs);
    const record: HookTrustRecord = {
      acceptedAt: new Date().toISOString(),
      fingerprint: manifest?.fingerprint ?? hooksFingerprint([]),
    };
    fs.writeFile(
      this.#trustPath(workspaceRoot),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    return record;
  }

  /**
   * 钩子执行准入：仅 'trusted' 放行；'untrusted' / 'none' 一律
   * { allowed: false, reason: 'untrusted-workspace' }（fail closed）。
   * hookPath 仅作审计身份随裁决返回场景使用；清单完整性由指纹在
   * trustState 判定时刻保证，本门不做二次哈希。
   */
  verifyHook(hookPath: string, state: WorkspaceTrustState): TrustDecision {
    if (state === "trusted") {
      return { allowed: true };
    }
    return { allowed: false, reason: "untrusted-workspace" };
  }
}
