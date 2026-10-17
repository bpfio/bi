/**
 * BI-15.4 · A2A 穿透式 WebSocket 中继控制通道 —— Relay 服务端（中继桥）。
 *
 * 设计要点（工单 BI-15.4）：
 * - 零公网入站端口：device 与 controller 双方都只发起「出站」WebSocket 连接到
 *   中继；中继按注册表在两条出站连接之间桥接转发。本服务端默认仅绑定
 *   127.0.0.1（测试 fixture 用随机端口），不承担生产入站暴露面。
 * - 帧协议：JSON 文本帧，顶层两种 type：
 *     'a2a-payload' —— A2A 业务载荷帧；envelope 字段即 BI-15.3 SignedEnvelope
 *       形态。中继对本帧「透传不验签」（原样转发原始 JSON 文本，不做任何改写），
 *       验签归端点（device / controller 各自持钥校验）。
 *     'control' —— 控制面帧（register / attach / ping / pong / registered /
 *       attached / bridge-open / peer-state / superseded / rejected / error）。
 * - 注册表：device 出站连接注册 { deviceId, socket }；controller 出站连接
 *   attach { controllerId, targetDeviceId }；桥接仅转发已注册配对。
 * - 未注册 deviceId 的 attach → 结构化拒绝（rejected: DEVICE_NOT_REGISTERED + 关闭）。
 * - 同 deviceId 重复注册 → 新连接胜出：旧连接先收 superseded 帧再被踢（4001）；
 *   设备重注册时自动恢复与既有 controller 的桥（bridge-open）。
 * - 心跳：应用层 ping/pong；超时判定时钟可注入；僵尸连接超时清理（4408）。
 * - 错误分级：`rejected` 帧 = 注册/attach 协议拒绝（伴随关闭 4400）；
 *   `error` 帧 = 瞬态桥接失败（不关闭，发送方可继续重试）。
 * - 安全语义（v1）：信任中继 + 传输层 TLS；端到端加密归后续卡。
 * - 零外部 npm 依赖：WebSocket 用 Bun 原生 Bun.serve websocket（本机 localhost 测试授权）。
 */

import type { ServerWebSocket } from "bun";

export const RELAY_PROTOCOL_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// 帧协议类型
// ---------------------------------------------------------------------------

/** BI-15.3 SignedEnvelope 形态（中继不理解其内部结构，透传不验签） */
export type RelayEnvelope = Record<string, unknown>;

/** A2A 业务载荷帧（双向：controller→device 与 device→controller） */
export interface RelayPayloadFrame {
  v: typeof RELAY_PROTOCOL_VERSION;
  type: "a2a-payload";
  /** BI-15.3 SignedEnvelope（中继透传不验签） */
  envelope?: RelayEnvelope;
  /** 任意 JSON 可序列化业务载荷 */
  payload?: unknown;
}

export type RelayControlAction =
  | "register"
  | "attach"
  | "ping"
  | "pong"
  | "registered"
  | "attached"
  | "bridge-open"
  | "peer-state"
  | "superseded"
  | "rejected"
  | "error";

/** 结构化拒绝码 */
export type RelayRejectionCode =
  | "MALFORMED_FRAME"
  | "PROTOCOL_VERSION"
  | "INVALID_IDENTITY"
  | "DEVICE_NOT_REGISTERED"
  | "DEVICE_NOT_CONNECTED"
  | "NOT_ATTACHED";

export interface RelayControlFrame {
  v: typeof RELAY_PROTOCOL_VERSION;
  type: "control";
  action: RelayControlAction;
  deviceId?: string;
  controllerId?: string;
  targetDeviceId?: string;
  /** peer-state 的对端身份 */
  peerId?: string;
  /** peer-state 状态 */
  state?: "connected" | "disconnected";
  /** rejected / error 的结构化码 */
  code?: RelayRejectionCode;
  reason?: string;
}

export type RelayWireFrame = RelayPayloadFrame | RelayControlFrame;

/** 中继主动关闭码 */
export const RELAY_CLOSE_CODE = {
  /** 同身份重复注册，新连接胜出 */
  SUPERSEDED: 4001,
  /** 服务端停机（Bun 会把 1001 在线上映射为 1000，故中继语义一律走 4xxx 段） */
  SHUTDOWN: 4002,
  /** 注册 / attach 协议拒绝 */
  REJECTED: 4400,
  /** 心跳超时清理 */
  HEARTBEAT_TIMEOUT: 4408,
} as const;

const CONTROL_ACTIONS: ReadonlySet<string> = new Set<RelayControlAction>([
  "register",
  "attach",
  "ping",
  "pong",
  "registered",
  "attached",
  "bridge-open",
  "peer-state",
  "superseded",
  "rejected",
  "error",
]);

export class RelayProtocolError extends Error {
  readonly code: RelayRejectionCode;
  constructor(code: RelayRejectionCode, reason: string) {
    super(reason);
    this.name = "RelayProtocolError";
    this.code = code;
  }
}

/** 客户端侧：收到中继结构化拒绝（rejected 帧）时抛出 */
export class RelayRejectedError extends Error {
  readonly code: RelayRejectionCode;
  readonly reason: string;
  constructor(code: RelayRejectionCode, reason: string) {
    super(`relay rejected: ${code} (${reason})`);
    this.name = "RelayRejectedError";
    this.code = code;
    this.reason = reason;
  }
}

export function encodeRelayFrame(frame: RelayWireFrame): string {
  return JSON.stringify(frame);
}

function isJsonObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 严格解码一帧。非法 JSON / 未知 type / 未知 action / envelope 非对象 /
 * 协议版本不符 → 抛 RelayProtocolError（MALFORMED_FRAME / PROTOCOL_VERSION）。
 */
export function decodeRelayFrame(raw: unknown): RelayWireFrame {
  let parsed: unknown;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new RelayProtocolError("MALFORMED_FRAME", "frame is not valid JSON");
    }
  } else if (isJsonObject(raw)) {
    parsed = raw; // 进程内直接传对象（已解析形态）
  } else {
    throw new RelayProtocolError("MALFORMED_FRAME", "frame must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.v !== RELAY_PROTOCOL_VERSION) {
    throw new RelayProtocolError(
      "PROTOCOL_VERSION",
      `unsupported protocol version: ${JSON.stringify(record.v) ?? "undefined"}`,
    );
  }
  if (record.type === "a2a-payload") {
    if (record.envelope !== undefined && !isJsonObject(record.envelope)) {
      throw new RelayProtocolError("MALFORMED_FRAME", "envelope must be a JSON object");
    }
    return parsed as RelayPayloadFrame;
  }
  if (record.type === "control") {
    const action = record.action;
    if (typeof action !== "string" || !CONTROL_ACTIONS.has(action)) {
      throw new RelayProtocolError(
        "MALFORMED_FRAME",
        `unknown control action: ${JSON.stringify(action) ?? "undefined"}`,
      );
    }
    return parsed as RelayControlFrame;
  }
  throw new RelayProtocolError(
    "MALFORMED_FRAME",
    `unknown frame type: ${JSON.stringify(record.type) ?? "undefined"}`,
  );
}

/** 身份合法性：非空、≤128 字符、无首尾空白（防呆级别校验，鉴权归 L2/L3）。 */
function isValidIdentity(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value
  );
}

// ---------------------------------------------------------------------------
// Relay 服务端
// ---------------------------------------------------------------------------

export interface RelayServerOptions {
  /** 仅允许 localhost（默认 '127.0.0.1'）；生产入站暴露面不在本卡范围 */
  hostname?: string;
  /** 默认 0 = 随机端口（测试 fixture） */
  port?: number;
  /** 注入时钟（心跳超时判定），默认 Date.now */
  clock?: () => number;
  /** 服务端 ping 周期，默认 30_000ms */
  heartbeatIntervalMs?: number;
  /** 距最近一次入站消息（含 pong）超过该时长即清理，默认 90_000ms */
  heartbeatTimeoutMs?: number;
  /** 单帧字符上限（防呆），默认 1 MiB */
  maxFrameBytes?: number;
}

export interface RelayStats {
  devices: number;
  controllers: number;
  /** 已建立的 device↔controller 配对数（controller 的目标设备当前在线） */
  bridges: number;
}

export interface RelaySocketData {
  connId: string;
}

type RelayKind = "fresh" | "device" | "controller";

interface RelayConn {
  readonly connId: string;
  socket: ServerWebSocket<RelaySocketData>;
  /** 'fresh'：尚未 register/attach */
  kind: RelayKind;
  /** device 的 deviceId 或 controller 的 controllerId；fresh 为空串 */
  id: string;
  /** controller 的目标设备 */
  targetDeviceId: string | undefined;
  /** 最近一次入站消息时刻（注入时钟域） */
  lastSeenAt: number;
  closed: boolean;
}

const SERVER_DEFAULTS = {
  hostname: "127.0.0.1",
  heartbeatIntervalMs: 30_000,
  heartbeatTimeoutMs: 90_000,
  maxFrameBytes: 1_048_576,
} as const;

/**
 * A2A 穿透中继：维护 device / controller 两张出站连接注册表，在已注册配对间
 * 原样转发 'a2a-payload' 帧（透传不验签），并对控制面生命周期负责。
 */
export class RelayServer {
  readonly #options: {
    hostname: string;
    port: number;
    clock: () => number;
    heartbeatIntervalMs: number;
    heartbeatTimeoutMs: number;
    maxFrameBytes: number;
  };
  #server: ReturnType<typeof Bun.serve> | null = null;
  readonly #conns = new Map<string, RelayConn>();
  readonly #devices = new Map<string, RelayConn>();
  readonly #controllers = new Map<string, RelayConn>();
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #connSeq = 0;

  constructor(options?: RelayServerOptions) {
    this.#options = {
      hostname: options?.hostname ?? SERVER_DEFAULTS.hostname,
      port: options?.port ?? 0,
      clock: options?.clock ?? Date.now,
      heartbeatIntervalMs: options?.heartbeatIntervalMs ?? SERVER_DEFAULTS.heartbeatIntervalMs,
      heartbeatTimeoutMs: options?.heartbeatTimeoutMs ?? SERVER_DEFAULTS.heartbeatTimeoutMs,
      maxFrameBytes: options?.maxFrameBytes ?? SERVER_DEFAULTS.maxFrameBytes,
    };
  }

  /** 启动监听（Bun.serve websocket）。 */
  start(): void {
    if (this.#server !== null) {
      throw new Error("RelayServer: already started");
    }
    const self = this;
    this.#server = Bun.serve({
      hostname: this.#options.hostname,
      port: this.#options.port,
      fetch(req, server): Response | undefined {
        const connId = `c${++self.#connSeq}`;
        if (server.upgrade(req, { data: { connId } })) {
          return undefined;
        }
        return new Response("RelayServer: websocket upgrade required", { status: 426 });
      },
      websocket: {
        data: { connId: "" } as RelaySocketData, // 仅为类型推断（真实 data 由 upgrade 注入）
        open(ws) {
          self.#onOpen(ws);
        },
        message(ws, raw) {
          self.#onMessage(ws, raw);
        },
        close(ws, code, reason) {
          self.#onClose(ws, code, reason);
        },
      },
    });
    this.#heartbeatTimer = setInterval(() => {
      this.heartbeatCheck();
    }, this.#options.heartbeatIntervalMs);
    // 不阻止测试进程退出
    this.#heartbeatTimer.unref?.();
  }

  /** 停止：清理全部连接并关闭监听（幂等）。 */
  stop(): void {
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    for (const conn of [...this.#conns.values()]) {
      this.#detach(conn);
      try {
        conn.socket.close(RELAY_CLOSE_CODE.SHUTDOWN, "server shutdown");
      } catch {
        // 关闭失败不影响停机
      }
    }
    const server = this.#server;
    this.#server = null;
    if (server !== null) {
      server.stop(true);
    }
  }

  /** ws://<hostname>:<port>（start 后可用） */
  get url(): string {
    return `ws://${this.#options.hostname}:${this.port}`;
  }

  get port(): number {
    const server = this.#server;
    if (server === null) {
      throw new Error("RelayServer: not started");
    }
    const port = server.port;
    if (port === undefined) {
      throw new Error("RelayServer: listener has no TCP port (unix socket?)");
    }
    return port;
  }

  stats(): RelayStats {
    let bridges = 0;
    for (const controller of this.#controllers.values()) {
      const target = controller.targetDeviceId;
      const device = target === undefined ? undefined : this.#devices.get(target);
      if (device !== undefined && !device.closed) {
        bridges++;
      }
    }
    return { devices: this.#devices.size, controllers: this.#controllers.size, bridges };
  }

  /**
   * 心跳清扫：向全部存活连接发 ping，并按注入时钟清理超过 heartbeatTimeoutMs
   * 无入站消息的连接。自动定时器之外，测试可在注入时钟下手动驱动。
   */
  heartbeatCheck(): void {
    const now = this.#options.clock();
    for (const conn of [...this.#conns.values()]) {
      if (conn.closed) continue;
      if (now - conn.lastSeenAt > this.#options.heartbeatTimeoutMs) {
        this.#detach(conn);
        try {
          conn.socket.close(RELAY_CLOSE_CODE.HEARTBEAT_TIMEOUT, "heartbeat timeout");
        } catch {
          // 忽略
        }
        continue;
      }
      this.#send(conn, { v: 1, type: "control", action: "ping" });
    }
  }

  // -------------------------------------------------------------------------
  // 连接生命周期
  // -------------------------------------------------------------------------

  #onOpen(ws: ServerWebSocket<RelaySocketData>): void {
    const conn: RelayConn = {
      connId: ws.data.connId,
      socket: ws,
      kind: "fresh",
      id: "",
      targetDeviceId: undefined,
      lastSeenAt: this.#options.clock(),
      closed: false,
    };
    this.#conns.set(conn.connId, conn);
  }

  #onMessage(ws: ServerWebSocket<RelaySocketData>, raw: string | Buffer): void {
    const conn = this.#conns.get(ws.data.connId);
    if (conn === undefined || conn.closed) return;
    if (typeof raw !== "string") {
      this.#reject(conn, "MALFORMED_FRAME", "binary frames are not supported (v1: JSON text only)");
      return;
    }
    if (raw.length > this.#options.maxFrameBytes) {
      this.#reject(conn, "MALFORMED_FRAME", `frame exceeds maxFrameBytes=${this.#options.maxFrameBytes}`);
      return;
    }
    let frame: RelayWireFrame;
    try {
      frame = decodeRelayFrame(raw);
    } catch (error) {
      if (error instanceof RelayProtocolError) {
        this.#reject(conn, error.code, error.message);
      } else {
        this.#reject(conn, "MALFORMED_FRAME", String(error));
      }
      return;
    }
    conn.lastSeenAt = this.#options.clock();
    if (frame.type === "a2a-payload") {
      this.#routePayload(conn, raw);
      return;
    }
    this.#handleControl(conn, frame);
  }

  #onClose(ws: ServerWebSocket<RelaySocketData>, _code: number, _reason: string): void {
    const conn = this.#conns.get(ws.data.connId);
    if (conn === undefined) return;
    this.#detach(conn);
  }

  // -------------------------------------------------------------------------
  // 控制面
  // -------------------------------------------------------------------------

  #handleControl(conn: RelayConn, frame: RelayControlFrame): void {
    switch (frame.action) {
      case "register": {
        if (conn.kind !== "fresh") {
          this.#reject(conn, "INVALID_IDENTITY", "connection already registered/attached");
          return;
        }
        const { deviceId } = frame;
        if (!isValidIdentity(deviceId)) {
          this.#reject(conn, "INVALID_IDENTITY", "register requires a non-empty deviceId (≤128 chars, no surrounding whitespace)");
          return;
        }
        const existing = this.#devices.get(deviceId);
        if (existing !== undefined && !existing.closed) {
          // 同 deviceId 重复注册：新连接胜出，旧连接被踢
          this.#supersede(existing, `deviceId '${deviceId}' re-registered by a newer connection`);
        }
        conn.kind = "device";
        conn.id = deviceId;
        this.#devices.set(deviceId, conn);
        this.#send(conn, { v: 1, type: "control", action: "registered", deviceId });
        // 复桥：重注册的设备恢复与既有 attach 中 controller 的桥
        for (const controller of this.#controllers.values()) {
          if (controller.targetDeviceId === deviceId && !controller.closed) {
            this.#send(controller, { v: 1, type: "control", action: "bridge-open", deviceId, controllerId: controller.id });
            this.#send(conn, { v: 1, type: "control", action: "bridge-open", deviceId, controllerId: controller.id });
          }
        }
        return;
      }
      case "attach": {
        if (conn.kind !== "fresh") {
          this.#reject(conn, "INVALID_IDENTITY", "connection already registered/attached");
          return;
        }
        const { controllerId, targetDeviceId } = frame;
        if (!isValidIdentity(controllerId) || !isValidIdentity(targetDeviceId)) {
          this.#reject(conn, "INVALID_IDENTITY", "attach requires non-empty controllerId and targetDeviceId");
          return;
        }
        const device = this.#devices.get(targetDeviceId);
        if (device === undefined || device.closed) {
          this.#reject(conn, "DEVICE_NOT_REGISTERED", `target device '${targetDeviceId}' is not registered`);
          return;
        }
        const existing = this.#controllers.get(controllerId);
        if (existing !== undefined && !existing.closed) {
          this.#supersede(existing, `controllerId '${controllerId}' re-attached by a newer connection`);
        }
        conn.kind = "controller";
        conn.id = controllerId;
        conn.targetDeviceId = targetDeviceId;
        this.#controllers.set(controllerId, conn);
        this.#send(conn, {
          v: 1,
          type: "control",
          action: "attached",
          controllerId,
          targetDeviceId,
          deviceId: targetDeviceId,
        });
        this.#send(device, { v: 1, type: "control", action: "bridge-open", deviceId: targetDeviceId, controllerId });
        return;
      }
      case "pong": {
        // 心跳应答：lastSeenAt 已在入口统一刷新
        return;
      }
      case "ping": {
        this.#send(conn, { v: 1, type: "control", action: "pong" });
        return;
      }
      default: {
        // 服务端→客户端专用 action 出现在客户端侧：协议错位，发 error 帧但不断开
        this.#send(conn, {
          v: 1,
          type: "control",
          action: "error",
          code: "MALFORMED_FRAME",
          reason: `unexpected client action '${frame.action}'`,
        });
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 桥接（a2a-payload 透传，不验签）
  // -------------------------------------------------------------------------

  #routePayload(conn: RelayConn, raw: string): void {
    if (conn.kind === "fresh") {
      this.#reject(conn, "NOT_ATTACHED", "payload before register/attach is a protocol violation");
      return;
    }
    if (conn.kind === "device") {
      let forwarded = 0;
      for (const controller of this.#controllers.values()) {
        if (controller.targetDeviceId === conn.id && !controller.closed) {
          try {
            controller.socket.send(raw); // 原样转发：字节级透传
            forwarded++;
          } catch {
            // 发送失败由 close 事件负责清理
          }
        }
      }
      if (forwarded === 0) {
        this.#send(conn, {
          v: 1,
          type: "control",
          action: "error",
          code: "NOT_ATTACHED",
          reason: `no controller attached to device '${conn.id}'`,
        });
      }
      return;
    }
    // controller → 目标 device
    const target = conn.targetDeviceId;
    const device = target === undefined ? undefined : this.#devices.get(target);
    if (device === undefined || device.closed) {
      this.#send(conn, {
        v: 1,
        type: "control",
        action: "error",
        code: "DEVICE_NOT_CONNECTED",
        reason: `device '${target ?? ""}' is not connected`,
      });
      return;
    }
    try {
      device.socket.send(raw); // 原样转发：字节级透传
    } catch {
      // 发送失败由 close 事件负责清理
    }
  }

  // -------------------------------------------------------------------------
  // 内部工具
  // -------------------------------------------------------------------------

  #send(conn: RelayConn, frame: RelayWireFrame): void {
    if (conn.closed) return;
    try {
      conn.socket.send(encodeRelayFrame(frame));
    } catch {
      // 发送失败（对端已死）：由 close 事件负责清理
    }
  }

  /** 结构化拒绝：发 rejected 帧并关闭（4400）。 */
  #reject(conn: RelayConn, code: RelayRejectionCode, reason: string): void {
    this.#send(conn, { v: 1, type: "control", action: "rejected", code, reason });
    this.#detach(conn);
    try {
      conn.socket.close(RELAY_CLOSE_CODE.REJECTED, reason.slice(0, 120));
    } catch {
      // 忽略
    }
  }

  /** 重复身份：先发 superseded 帧再踢（4001）。 */
  #supersede(conn: RelayConn, reason: string): void {
    this.#send(conn, { v: 1, type: "control", action: "superseded", reason });
    this.#detach(conn);
    try {
      conn.socket.close(RELAY_CLOSE_CODE.SUPERSEDED, "superseded");
    } catch {
      // 忽略
    }
  }

  /** 从注册表摘除并通知对端（幂等）。 */
  #detach(conn: RelayConn): void {
    if (conn.closed) return;
    conn.closed = true;
    this.#conns.delete(conn.connId);
    if (conn.kind === "device") {
      if (this.#devices.get(conn.id) === conn) {
        this.#devices.delete(conn.id);
      }
      for (const controller of this.#controllers.values()) {
        if (controller.targetDeviceId === conn.id && !controller.closed) {
          this.#send(controller, { v: 1, type: "control", action: "peer-state", state: "disconnected", peerId: conn.id });
        }
      }
      return;
    }
    if (conn.kind === "controller") {
      if (this.#controllers.get(conn.id) === conn) {
        this.#controllers.delete(conn.id);
      }
      const device = conn.targetDeviceId === undefined ? undefined : this.#devices.get(conn.targetDeviceId);
      if (device !== undefined && !device.closed) {
        this.#send(device, { v: 1, type: "control", action: "peer-state", state: "disconnected", peerId: conn.id });
      }
    }
  }
}
