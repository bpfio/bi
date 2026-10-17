/**
 * BI-15.1 · A2aHost —— 跨网协作角色编排面（分布式 A2A 协议宿主）。
 *
 * 职责（BI-15 工单卡设计）：
 * a. 角色派生 derive(role, spec)：生成跨网协作角色运行句柄
 *    { role, capabilities（经 permissions 矩阵投影）, inbox/outbox（本包内简版 FIFO 队列）, sessionRef }。
 *    角色执行循环经注入 handler 端口驱动——宿主只做编排、验签与路由，不内建任何模型调用。
 * b. 双总线接线端口 attachTransport({ name, send, onMessage })：传输无关——
 *    邮件 / WSS / GitHub 等传输各自实现该三方法端口（归各传输卡，如 BI-15.4）。
 *    入站：verifyEnvelope 五步验签，失败 → 审计拒绝（rejections），成功 → 分发到目标角色 in 队列；
 *    出站：signEnvelope 封装（secret 注入）后 fan-out 至全部已接线传输。
 * c. dispatch()：按角色 drain in 队列交 handler；handler 返回的 OutboundMessage
 *    由宿主签名出站；outbox 队列消息同批 flush。
 *
 * 分层声明（与单机 Sub-agent 的边界）：
 * - A2aHost 派生的是「跨网协作角色」：面向分布式 A2A 协议——信封 HMAC 签名、
 *   五步验签、双总线传输与跨网角色能力矩阵；句柄不承载进程内执行栈。
 * - 单机「进程内子代理」编排归 BI-07.3（已关单）的 Sub-agent 层。
 * - 两层互不复用、不混用：host 不派生进程内子代理，子代理层不走 A2A 信封/传输。
 *
 * 安全与依赖红线：
 * - 密钥位仅接受 auth.ts 的 A2aSharedSecret 品牌类型（裸 string 无法通过编译混入）；
 * - nonce 防重放库缺省宿主私有（MemoryReplayStore 每宿主一例），不用进程级共享缺省库，
 *   防跨宿主/跨测试 nonce 污染；
 * - 零外部 npm 依赖：仅 node:crypto 与本包 auth/permissions/blackboard（只 import 不改动）。
 */

import { randomUUID } from "node:crypto";
import {
  MemoryReplayStore,
  signEnvelope,
  verifyEnvelope,
  type A2aEnvelope,
  type A2aSharedSecret,
  type ReplayStore,
  type SignedEnvelope,
} from "./auth";
import { Blackboard, type Clock } from "./blackboard";
import { A2A_ROLES, capabilitiesOf, isA2aRole, type A2aRole, type Capability } from "./permissions";

/** 出站消息（宿主封装签名前）。 */
export interface OutboundMessage {
  from: A2aRole;
  to: A2aRole;
  payload: unknown;
}

/** 入站投递（验签通过后交 handler；sessionRef 为目标角色句柄的会话引用）。 */
export interface InboundDelivery {
  from: A2aRole;
  to: A2aRole;
  payload: unknown;
  nonce: string;
  ts: number;
  sessionRef: string;
  transport: string;
}

/**
 * 角色执行端口：注入 handler，宿主不内建模型调用。
 * 返回 OutboundMessage 即由宿主封装签名出站；无出站时显式返回 undefined。
 */
export type RoleHandler = (
  delivery: InboundDelivery,
) => OutboundMessage | undefined | Promise<OutboundMessage | undefined>;

/** 角色派生规格。 */
export interface RoleSpec {
  handler: RoleHandler;
  /** 会话引用（缺省由宿主生成 UUID）。 */
  sessionRef?: string;
}

/** 角色运行句柄（A2aHost.derive 产物）。 */
export interface RoleHandle {
  readonly role: A2aRole;
  /** 经 permissions 能力矩阵投影的角色能力（只读快照）。 */
  readonly capabilities: readonly Capability[];
  /** 出站队列（本包内简版 FIFO；复用 core Inbox 语义但跨包不引用）。 */
  readonly outbox: SimpleInbox<OutboundMessage>;
  /** 入站队列（经验签信封排队，等待 dispatch）。 */
  readonly inbox: SimpleInbox<InboundDelivery>;
  readonly sessionRef: string;
}

/** 双总线传输端口：邮件/WSS/GitHub 等传输各自实现该三方法端口。 */
export interface TransportPort {
  readonly name: string;
  send(envelope: SignedEnvelope): void | Promise<void>;
  onMessage(cb: (raw: unknown) => void): void;
}

/** 本包内简版 FIFO 队列（Inbox 语义：push 入队、drain 清仓、size 观测）。 */
export class SimpleInbox<T> {
  readonly #items: T[] = [];

  push(item: T): void {
    this.#items.push(item);
  }

  /** 清仓：按 FIFO 顺序返回全部条目并清空队列。 */
  drain(): T[] {
    return this.#items.splice(0, this.#items.length);
  }

  get size(): number {
    return this.#items.length;
  }
}

/** 审计拒绝记录（入站验签/路由拒绝与出站投递失败共用；稳定 reason 可编程判断）。 */
export interface RejectionRecord {
  readonly transport: string;
  readonly reason: string;
  readonly ts: number;
}

/** handler 失败记录（dispatch 错误隔离：单条失败不影响后续投递）。 */
export interface HandlerFailure {
  readonly role: A2aRole;
  readonly error: unknown;
}

/** A2aHost 构造选项。 */
export interface HostOptions {
  /** A2A 共享密钥（经 a2aSecret() 品牌注入；出站签名与入站验签同钥）。 */
  secret: A2aSharedSecret;
  /** 注入时钟（envelope ts、验签 now、审计 ts 共用；缺省系统时钟）。 */
  clock?: Clock;
  /** 注入共享黑板（缺省自建，共享同一时钟）。 */
  blackboard?: Blackboard;
  /** 入站发件人白名单（fail-closed；缺省全四角色）。 */
  allowFrom?: readonly string[];
  /** 验签时钟偏斜窗（毫秒；缺省 DEFAULT_SKEW_MS）。 */
  skewMs?: number;
  /** nonce 防重放库（缺省宿主私有 MemoryReplayStore，防跨宿主 nonce 污染）。 */
  replayStore?: ReplayStore;
}

/** 跨网协作角色编排面。 */
export class A2aHost {
  readonly #secret: A2aSharedSecret;
  readonly #clock: Clock;
  readonly #blackboard: Blackboard;
  readonly #allowFrom: readonly string[];
  readonly #skewMs: number | undefined;
  readonly #replayStore: ReplayStore;
  readonly #roles = new Map<A2aRole, { spec: RoleSpec; handle: RoleHandle }>();
  readonly #transports = new Map<string, TransportPort>();
  readonly #rejections: RejectionRecord[] = [];
  readonly #failures: HandlerFailure[] = [];

  constructor(opts: HostOptions) {
    this.#secret = opts.secret;
    this.#clock = opts.clock ?? { now: () => Date.now() };
    this.#blackboard = opts.blackboard ?? new Blackboard({ clock: this.#clock });
    this.#allowFrom = opts.allowFrom ?? [...A2A_ROLES];
    this.#skewMs = opts.skewMs;
    this.#replayStore = opts.replayStore ?? new MemoryReplayStore();
  }

  /** 共享黑板（注入实例或自建实例）。 */
  get blackboard(): Blackboard {
    return this.#blackboard;
  }

  /** 审计拒绝记录（入站验签失败/无法路由/出站投递失败）。 */
  get rejections(): readonly RejectionRecord[] {
    return this.#rejections;
  }

  /** handler 失败记录（错误隔离审计）。 */
  get failures(): readonly HandlerFailure[] {
    return this.#failures;
  }

  /** 已接线传输名（按接线顺序）。 */
  get transportNames(): readonly string[] {
    return [...this.#transports.keys()];
  }

  /** 派生跨网协作角色运行句柄（同角色不可重复派生；未知角色运行时拒绝）。 */
  derive(role: A2aRole, spec: RoleSpec): RoleHandle {
    if (!isA2aRole(role)) {
      throw new RangeError(`derive 拒绝未知角色：${String(role)}`);
    }
    if (this.#roles.has(role)) {
      throw new RangeError(`角色已派生，不可重复派生：${role}`);
    }
    const handle: RoleHandle = {
      role,
      capabilities: capabilitiesOf(role),
      outbox: new SimpleInbox<OutboundMessage>(),
      inbox: new SimpleInbox<InboundDelivery>(),
      sessionRef: spec.sessionRef ?? randomUUID(),
    };
    this.#roles.set(role, { spec, handle });
    return handle;
  }

  /** 接线一条传输（可多条构成双总线）；重名拒绝。 */
  attachTransport(transport: TransportPort): void {
    if (this.#transports.has(transport.name)) {
      throw new RangeError(`传输名已接线：${transport.name}`);
    }
    this.#transports.set(transport.name, transport);
    transport.onMessage((raw) => this.#onRawMessage(transport.name, raw));
  }

  /**
   * 按角色 drain in 队列交 handler（缺省派发全部派生角色）。
   * - handler 返回 OutboundMessage → 宿主封装签名后 fan-out 出站；
   * - outbox 队列同批 flush；
   * - 返回处理的入站条数；handler 抛错被隔离记录（failures），不中断后续投递。
   */
  async dispatch(role?: A2aRole): Promise<number> {
    if (role !== undefined && !this.#roles.has(role)) {
      throw new RangeError(`dispatch 拒绝未派生角色：${String(role)}`);
    }
    const targets = role === undefined ? [...this.#roles.keys()] : [role];
    let handled = 0;
    for (const target of targets) {
      const entry = this.#roles.get(target);
      if (entry === undefined) continue;
      for (const delivery of entry.handle.inbox.drain()) {
        let outbound: OutboundMessage | undefined;
        try {
          outbound = await entry.spec.handler(delivery);
        } catch (error) {
          this.#failures.push({ role: target, error });
        }
        if (outbound !== undefined) {
          this.#emitOutbound(outbound);
        }
        handled += 1;
      }
      for (const message of entry.handle.outbox.drain()) {
        this.#emitOutbound(message);
      }
    }
    return handled;
  }

  /** 入站：raw 经五步验签；失败审计拒绝，成功路由至目标角色 in 队列。 */
  #onRawMessage(transportName: string, raw: unknown): void {
    const now = this.#clock.now();
    const result = verifyEnvelope(raw as SignedEnvelope, {
      secret: this.#secret,
      allowFrom: this.#allowFrom,
      skewMs: this.#skewMs,
      now,
      replayStore: this.#replayStore,
    });
    if (!result.valid) {
      this.#rejections.push({ transport: transportName, reason: result.reason, ts: now });
      return;
    }
    const { from, to, payload, nonce, ts } = result.envelope;
    if (!isA2aRole(from)) {
      this.#rejections.push({ transport: transportName, reason: "unknown-sender-role", ts: now });
      return;
    }
    if (!isA2aRole(to)) {
      this.#rejections.push({ transport: transportName, reason: "unknown-target", ts: now });
      return;
    }
    const target = this.#roles.get(to);
    if (target === undefined) {
      this.#rejections.push({ transport: transportName, reason: "unknown-target", ts: now });
      return;
    }
    target.handle.inbox.push({
      from,
      to,
      payload,
      nonce,
      ts,
      sessionRef: target.handle.sessionRef,
      transport: transportName,
    });
  }

  /** 出站：校验角色 → 封装五字段信封（注入时钟 ts + UUID nonce）→ signEnvelope → 双总线 fan-out。 */
  #emitOutbound(message: OutboundMessage): void {
    if (!isA2aRole(message.from)) {
      throw new RangeError(`出站消息 from 非法角色：${String(message.from)}`);
    }
    if (!isA2aRole(message.to)) {
      throw new RangeError(`出站消息 to 非法角色：${String(message.to)}`);
    }
    if (this.#transports.size === 0) {
      throw new Error("出站投递失败：宿主未接线任何传输（attachTransport）");
    }
    const envelope: A2aEnvelope = {
      from: message.from,
      to: message.to,
      ts: this.#clock.now(),
      nonce: randomUUID(),
      payload: message.payload,
    };
    const signed = signEnvelope(envelope, this.#secret);
    for (const transport of this.#transports.values()) {
      try {
        const sent = transport.send(signed);
        if (sent instanceof Promise) {
          sent.catch(() => {
            this.#rejections.push({
              transport: transport.name,
              reason: "send-failed",
              ts: this.#clock.now(),
            });
          });
        }
      } catch {
        this.#rejections.push({ transport: transport.name, reason: "send-failed", ts: this.#clock.now() });
      }
    }
  }
}
