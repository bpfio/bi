/**
 * @bi/worktree —— Tower 多 Agent 工作区协作协议（BI-12.2）。
 *
 * `.tower/comms/` 信件协议：TowerMessage 以 JSON 落盘
 * `.tower/comms/<seq>-<kind>.json`，append-only（只新增、绝不改写既有信件）。
 * seq 为信箱目录内单调递增流水号（零填充 6 位，字典序=数值序）。
 * 时钟注入（now），ts 由协议在 post 时盖章，消费方不做时钟假设。
 *
 * 信箱投递模型：信件按发件人（from）广播 —— `readInbox(role)` 返回
 * "他人来信"（from !== role），可选按 taskId 过滤，按 ts 升序。
 * 由此角色信箱天然隔离：worker 收不到自己的 finding，reviewer 收不到
 * 自己的 review，initiator 汇聚全量裁决与上报。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Tower 角色。 */
export type TowerRole = "worker" | "reviewer" | "initiator";

/** 信件类别（工单枚举，不可扩展）。 */
export type TowerMessageKind = "plan" | "finding" | "review" | "merge-request" | "status";

/** Tower 信件。 */
export interface TowerMessage {
  /** `<零填充seq>-<kind>`，与文件名 stem 一致 */
  id: string;
  from: TowerRole;
  kind: TowerMessageKind;
  taskId: string;
  body: string;
  /** epoch ms（注入时钟在 post 时盖章） */
  ts: number;
  /** review 信专用：approved=true 才能开启合并门禁 */
  approved?: boolean;
}

/** `.tower` 固定目录名。 */
export const TOWER_DIR = ".tower";

/** `.tower/comms` 信箱目录名。 */
export const TOWER_COMMS_DIR = ".tower/comms";

/** 全塔广播信的任务号（init 等塔级信件使用）。 */
export const TOWER_BROADCAST_TASK_ID = "*";

/** 协议构造项。 */
export interface TowerProtocolOptions {
  /** 塔根目录（`.tower/` 的宿主目录；共享工作区/主仓库旁路均可） */
  towerRoot: string;
  /** 注入时钟；缺省系统时间 */
  now?: () => number;
}

const SEQ_WIDTH = 6;
const SEQ_PATTERN = /^(\d{6})-[A-Za-z0-9-]+\.json$/;
const MAX_SEQ_RETRY = 5;

function zeroPad(seq: number): string {
  return String(seq).padStart(SEQ_WIDTH, "0");
}

/** Tower 信件协议存取器（append-only JSON 落盘）。 */
export class TowerProtocol {
  readonly #commsDir: string;
  readonly #now: () => number;

  constructor(opts: TowerProtocolOptions) {
    this.#commsDir = resolve(opts.towerRoot, TOWER_DIR, "comms");
    this.#now = opts.now ?? (() => Date.now());
  }

  /** 信箱目录绝对路径。 */
  get commsDir(): string {
    return this.#commsDir;
  }

  /** 扫描既有流水号并取下一个（零填充）。 */
  #nextSeq(): number {
    if (!existsSync(this.#commsDir)) return 1;
    let max = 0;
    for (const name of readdirSync(this.#commsDir)) {
      const match = SEQ_PATTERN.exec(name);
      if (match === null) continue;
      const seq = Number(match[1]);
      if (Number.isFinite(seq) && seq > max) max = seq;
    }
    return max + 1;
  }

  /**
   * 投递一封信：分配 seq + 盖时钟戳 + JSON 落盘（'wx' 独占创建，
   * 撞号重扫重试 —— append-only，绝不改写既有信件）。
   */
  post(input: {
    from: TowerRole;
    kind: TowerMessageKind;
    taskId: string;
    body: string;
    approved?: boolean;
  }): TowerMessage {
    mkdirSync(this.#commsDir, { recursive: true });
    for (let attempt = 0; attempt < MAX_SEQ_RETRY; attempt += 1) {
      const seq = this.#nextSeq();
      const id = `${zeroPad(seq)}-${input.kind}`;
      const message: TowerMessage = {
        id,
        from: input.from,
        kind: input.kind,
        taskId: input.taskId,
        body: input.body,
        ts: this.#now(),
      };
      if (input.approved !== undefined) message.approved = input.approved;
      const file = join(this.#commsDir, `${id}.json`);
      try {
        writeFileSync(file, `${JSON.stringify(message, null, 2)}\n`, { flag: "wx" });
        return message;
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        if (code !== "EEXIST") throw err;
        // 撞号：重扫 seq 再试（并发/手工预置文件场景）
      }
    }
    throw new Error(`TowerProtocol：信件 seq 分配连续冲突（${MAX_SEQ_RETRY} 次），放弃投递`);
  }

  /** 全量信件（seq 升序）；损坏文件跳过（append-only 存储的容错读取）。 */
  list(): TowerMessage[] {
    if (!existsSync(this.#commsDir)) return [];
    const messages: TowerMessage[] = [];
    for (const name of readdirSync(this.#commsDir).sort()) {
      if (!SEQ_PATTERN.test(name)) continue;
      try {
        const raw = readFileSync(join(this.#commsDir, name), "utf8");
        const parsed = JSON.parse(raw) as TowerMessage;
        if (typeof parsed?.id === "string" && typeof parsed?.kind === "string") {
          messages.push(parsed);
        }
      } catch {
        // 损坏信件跳过，不阻断信箱读取
      }
    }
    return messages;
  }

  /** 指定任务的信件（seq 升序）。 */
  readFor(taskId: string): TowerMessage[] {
    return this.list().filter((message) => message.taskId === taskId);
  }

  /**
   * 角色信箱：他人来信（from !== role），ts 升序；可选按 taskId 过滤。
   * 广播信（taskId='*'）在未过滤视角同样可见。
   */
  readInbox(role: TowerRole, taskId?: string): TowerMessage[] {
    const inbox = this.list().filter((message) => message.from !== role);
    if (taskId === undefined) return inbox;
    return inbox.filter(
      (message) => message.taskId === taskId || message.taskId === TOWER_BROADCAST_TASK_ID,
    );
  }
}
