/**
 * BI-21.2 · 最终产出物显式交付工具（PresentTool）。
 *
 * 模型可见的 `present({ files, summary })` 终局交付处理器：把生成的研报、表格、
 * 图表等正式声明为交付资产。合约（工单钉死）：
 * - files 必须真实存在——任一缺失/非常规文件 → 结构化 `invalid-files`（missing
 *   列出缺失项），拒绝交付，不产生任何记录；
 * - 合法 → 组装 `DeliveryRecord`（逐文件 bytes + sha256，摘要，注入时钟的
 *   deliveredAt），渲染确定性交付卡片（`📦 Deliverables` 标题 + 文件清单 + 摘要，
 *   纯文本形态，可快照），并记录后返回 `{ ok, record, card }`；
 * - 重复交付防护：同一指纹（全部文件 sha256 按序 + summary）幂等拒绝——返回
 *   `already-delivered`（code），并回带首次交付的 record；
 * - 记录落点（接缝①，与 BI-14 durable 同底座）：注入 DurableStore 形状的 sink
 *   则持久化为 kind='delivery' 的 completed 任务（checkpoint 即 DeliveryRecord，
 *   确定性 id = `delivery:<指纹>`，跨实例/重启幂等查重）；缺省内存 sink。
 *
 * 零外部依赖：sha256 来自 node:crypto，文件读取来自 node:fs。
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { DurableStore, ScanPage } from "../durable/storage";
import { DEFAULT_PAGE_SIZE, normalizePageSize } from "../durable/storage";
import type { JsonValue, TaskRecord, TaskState } from "../durable/task-state";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** present 工具入参（模型可见 schema）。 */
export interface PresentInput {
  /** 交付文件路径列表（相对路径按注入 cwd 解析；不可为空）。 */
  files: string[];
  /** 交付摘要（不可为空）。 */
  summary: string;
}

/** 交付记录中的单个文件条目（type alias：隐式索引签名，保 JsonValue 可赋值落 checkpoint）。 */
export type DeliveredFile = {
  /** 模型提供的原始路径（保持原样，便于人读）。 */
  path: string;
  /** 文件字节数。 */
  bytes: number;
  /** 内容 sha256（hex）。 */
  sha256: string;
};

/** 一次显式交付的完整记录（type alias：全字段 JsonValue 兼容，可直接落 checkpoint）。 */
export type DeliveryRecord = {
  files: DeliveredFile[];
  summary: string;
  /** ISO 8601 时间串（注入时钟）。 */
  deliveredAt: string;
};

/** 结构化结果（永不抛错；失败经 code 判别）。 */
export interface PresentResult {
  ok: boolean;
  record?: DeliveryRecord;
  card?: string;
  /** 失败码：invalid-input / invalid-files / already-delivered。 */
  code?: "invalid-input" | "invalid-files" | "already-delivered";
  /** invalid-files：缺失或非常规文件的路径列表（保持入参顺序）。 */
  missing?: string[];
  /** already-delivered：true 表示幂等命中（record 为首次交付记录）。 */
  alreadyDelivered?: boolean;
  error?: string;
}

/** 交付记录 sink：与 DurableStore 的 get/put 同形（结构子集，可直接传 store）。 */
export interface DeliveryStore {
  get(id: string): TaskRecord | null;
  put(record: TaskRecord): void;
}

export interface PresentToolOptions {
  /** 持久化 sink（接缝①）：缺省内存 sink（进程内幂等）。 */
  store?: DeliveryStore;
  /** 时钟注入（缺省 Date.now，毫秒）。 */
  clock?: () => number;
  /** 相对路径解析基准（缺省 process.cwd()）。 */
  cwd?: string;
}

// ---------------------------------------------------------------------------
// 内存 sink（缺省兜底）
// ---------------------------------------------------------------------------

/**
 * 纯内存 DeliveryStore 缺省兜底：完整 DurableStore 形状（get/put/scanStates，
 * 语义与 MemoryDurableStore 对齐——upsert 式 put、按 id 升序游标分页、存取均
 * structuredClone 深拷贝），可直接当 durable store 注入多个 PresentTool 共享。
 */
export class MemoryDeliveryStore implements DurableStore {
  readonly #rows = new Map<string, TaskRecord>();

  get(id: string): TaskRecord | null {
    const row = this.#rows.get(id);
    return row === undefined ? null : structuredClone(row);
  }

  put(record: TaskRecord): void {
    this.#rows.set(record.id, structuredClone(record));
  }

  delete(id: string): void {
    this.#rows.delete(id);
  }

  scanStates(
    states: readonly TaskState[],
    cursor?: string | null,
    pageSize?: number,
  ): ScanPage {
    const size = normalizePageSize(pageSize ?? DEFAULT_PAGE_SIZE);
    const allowed = new Set(states);
    const matched: TaskRecord[] = [];
    for (const row of this.#rows.values()) {
      if (!allowed.has(row.state)) continue;
      if (cursor !== undefined && cursor !== null && !(cursor < row.id)) continue;
      matched.push(row);
    }
    matched.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const items = matched.slice(0, size).map((row) => structuredClone(row));
    const last = items.at(-1);
    return {
      items,
      nextCursor: items.length === size && last !== undefined ? last.id : null,
    };
  }
}

// ---------------------------------------------------------------------------
// 纯函数（导出供测试直接钉行为）
// ---------------------------------------------------------------------------

/** 交付指纹：全部文件 sha256 按序 + summary（工单钉死幂等键 = sha256 + summary）。 */
export function deliveryFingerprint(fileShas: readonly string[], summary: string): string {
  return createHash("sha256").update(`${fileShas.join("\n")}\n\u0000${summary}`).digest("hex");
}

/** 交付记录的确定性持久化 id（指纹直接寻址，跨实例幂等查重）。 */
export function deliveryRecordId(fingerprint: string): string {
  return `delivery:${fingerprint}`;
}

/** 从 TaskRecord checkpoint 安全取回 DeliveryRecord（防手工篡改库内记录）。 */
export function asDeliveryRecord(checkpoint: JsonValue): DeliveryRecord | null {
  if (typeof checkpoint !== "object" || checkpoint === null || Array.isArray(checkpoint)) {
    return null;
  }
  const r = checkpoint as Record<string, JsonValue>;
  if (typeof r.summary !== "string" || typeof r.deliveredAt !== "string" || !Array.isArray(r.files)) {
    return null;
  }
  const files: DeliveredFile[] = [];
  for (const item of r.files) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const f = item as Record<string, JsonValue>;
    if (typeof f.path !== "string" || typeof f.bytes !== "number" || typeof f.sha256 !== "string") {
      return null;
    }
    files.push({ path: f.path, bytes: f.bytes, sha256: f.sha256 });
  }
  return { files, summary: r.summary, deliveredAt: r.deliveredAt };
}

const CARD_RULE = "──────────────────────────────────────";

/** 字节数格式化（确定性：B/KB/MB，一位小数，KB=1024）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 渲染确定性交付卡片（纯文本，可快照）：`📦 Deliverables` 标题 + 文件清单
 * （序号 + 路径 + 字节 + 截断 sha256）+ 摘要 + 交付时间。输入相同则输出逐字节相同。
 */
export function renderDeliveryCard(record: DeliveryRecord): string {
  const lines: string[] = [];
  lines.push("📦 Deliverables");
  lines.push(CARD_RULE);
  record.files.forEach((file, i) => {
    lines.push(`${i + 1}. ${file.path} (${formatBytes(file.bytes)} · sha256:${file.sha256.slice(0, 12)})`);
  });
  lines.push(CARD_RULE);
  lines.push(`Summary: ${record.summary}`);
  lines.push(`Delivered at: ${record.deliveredAt}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// PresentTool
// ---------------------------------------------------------------------------

/**
 * 列举 sink 中的 delivery 任务（观测/测试用）。sink 只承诺 get/put 形状；
 * 注入方同时提供 DurableStore 全形（含 scanStates）时才可枚举，否则返回空表
 * （幂等查重不依赖枚举——确定性 id 直接 get 寻址）。
 */
function scanDeliveryTasks(store: DeliveryStore): TaskRecord[] {
  const full = store as DurableStore;
  if (typeof full.scanStates !== "function") return [];
  const items: TaskRecord[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = full.scanStates(["completed"], cursor, 256);
    for (const task of page.items) {
      if (task.kind === "delivery") items.push(task);
    }
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return items;
}

/** 模型可见的 present 终局交付工具。 */
export class PresentTool {
  readonly #store: DeliveryStore;
  readonly #now: () => number;
  readonly #cwd: string;

  constructor(options: PresentToolOptions = {}) {
    this.#store = options.store ?? new MemoryDeliveryStore();
    this.#now = options.clock ?? Date.now;
    this.#cwd = options.cwd ?? process.cwd();
  }

  /** 实际使用的 sink（观测/测试断言用）。 */
  get store(): DeliveryStore {
    return this.#store;
  }

  /** 列出已持久化的全部交付记录（按 id 序；观测/测试用）。 */
  listDeliveries(): DeliveryRecord[] {
    const out: DeliveryRecord[] = [];
    for (const task of scanDeliveryTasks(this.#store)) {
      const record = asDeliveryRecord(task.checkpoint);
      if (record !== null) out.push(record);
    }
    return out;
  }

  /**
   * present 处理器：校验 → 查重 → 组装记录 → 落库 → 渲染卡片。永不抛错。
   */
  handle(input: PresentInput): PresentResult {
    // -- 入参形状校验 ---------------------------------------------------------
    if (typeof input !== "object" || input === null) {
      return { ok: false, code: "invalid-input", error: "present 入参必须为对象 { files, summary }" };
    }
    const { files, summary } = input as { files?: unknown; summary?: unknown };
    if (!Array.isArray(files) || files.length === 0 || !files.every((f) => typeof f === "string" && f.length > 0)) {
      return {
        ok: false,
        code: "invalid-input",
        error: "files 必须为非空字符串数组且至少包含一项",
      };
    }
    if (typeof summary !== "string" || summary.trim().length === 0) {
      return { ok: false, code: "invalid-input", error: "summary 必须为非空字符串" };
    }

    // -- 存在性校验（缺失 → invalid-files，拒绝交付）---------------------------
    const missing: string[] = [];
    for (const p of files) {
      const abs = resolve(this.#cwd, p);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(abs);
      } catch {
        missing.push(p);
        continue;
      }
      if (!stat.isFile()) missing.push(p); // 目录等非常规文件视同不可交付
    }
    if (missing.length > 0) {
      return {
        ok: false,
        code: "invalid-files",
        missing,
        error: `交付拒绝：以下 ${missing.length} 个文件缺失或非常规文件：${missing.join(", ")}`,
      };
    }

    // -- 指纹与幂等查重（同 sha256 + 同 summary → already-delivered）-----------
    const fileShas: string[] = [];
    const delivered: DeliveredFile[] = [];
    for (const p of files) {
      const abs = resolve(this.#cwd, p);
      const content = readFileSync(abs);
      const sha256 = createHash("sha256").update(content).digest("hex");
      fileShas.push(sha256);
      delivered.push({ path: p, bytes: content.byteLength, sha256 });
    }
    const id = deliveryRecordId(deliveryFingerprint(fileShas, summary));
    const prior = this.#store.get(id);
    if (prior !== null) {
      const record = asDeliveryRecord(prior.checkpoint);
      return {
        ok: false,
        code: "already-delivered",
        alreadyDelivered: true,
        record: record ?? undefined,
        error: `重复交付：相同文件集与摘要已于 ${record?.deliveredAt ?? "未知时间"} 交付过（幂等拒绝，不重复记录）`,
      };
    }

    // -- 组装记录并落库（kind='delivery'，checkpoint 即 DeliveryRecord）---------
    const record: DeliveryRecord = {
      files: delivered,
      summary,
      deliveredAt: new Date(this.#now()).toISOString(),
    };
    const task: TaskRecord = {
      id,
      kind: "delivery",
      state: "completed",
      checkpoint: record,
      attempts: 0,
      maxAttempts: 1,
      updatedAt: this.#now(),
    };
    this.#store.put(task);
    return { ok: true, record, card: renderDeliveryCard(record) };
  }
}
