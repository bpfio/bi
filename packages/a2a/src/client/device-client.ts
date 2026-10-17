/**
 * BI-15.4 · A2A 穿透式 WebSocket 中继控制通道 —— 客户端（Device / Controller）。
 *
 * - DeviceClient（bi 侧）：connect(relayUrl, deviceId, opts) 发起「出站」
 *   WebSocket 并向中继注册 —— 零公网入站端口的核心：只出站，不监听任何端口。
 *   onPayload(cb) 收 controller 经中继转发的 A2A 载荷；sendToController(data)
 *   反向发送；断线自动重连（指数退避 1s→30s 封顶，sleep 可注入，注册成功即重置）；
 *   onState(cb) 状态机 disconnected / connecting / registered / bridge-open。
 * - ControllerClient（远程端）：attach(relayUrl, deviceId) 出站连接声明控制目标；
 *   send(payload) / sendEnvelope(envelope) / onEvent(cb)。未注册 deviceId →
 *   结构化拒绝（RelayRejectedError: DEVICE_NOT_REGISTERED）。v1 无自动重连
 *   （重连策略归调用方；device 侧自动重连是零入站语义的韧性核心）。
 * - 心跳：自动应答中继应用层 ping（pong）。
 * - 安全语义（v1）：信任中继 + 传输层 TLS；端到端加密归后续卡。
 *   envelope（BI-15.3 SignedEnvelope）由端点 sign / verify，客户端同样只透传。
 * - 零外部 npm 依赖：WebSocket 用 Bun 原生全局 WebSocket 客户端。
 */

import {
  RelayProtocolError,
  RelayRejectedError,
  decodeRelayFrame,
  encodeRelayFrame,
  type RelayControlFrame,
  type RelayEnvelope,
  type RelayPayloadFrame,
  type RelayWireFrame,
} from "../transports/remote-relay";

// ---------------------------------------------------------------------------
// 客户端类型
// ---------------------------------------------------------------------------

/** DeviceClient 状态机：disconnected → connecting → registered → bridge-open */
export type DeviceClientState =
  | "disconnected"
  | "connecting"
  | "registered"
  | "bridge-open";

/** ControllerClient 状态机：disconnected → connecting → attached（桥已建立） */
export type ControllerClientState = "disconnected" | "connecting" | "attached";

export interface RelayClientOptions {
  /** 注入重连退避 sleep；默认真实 setTimeout */
  sleep?: (ms: number) => Promise<void>;
  /** 注入时钟（预留：客户端计时语义对齐测试） */
  clock?: () => number;
  /** 重连退避基值，默认 1_000ms */
  reconnectBaseDelayMs?: number;
  /** 重连退避封顶，默认 30_000ms */
  reconnectMaxDelayMs?: number;
  /** 握手（registered / attached 确认）超时，默认 10_000ms */
  handshakeTimeoutMs?: number;
}

export type PayloadListener = (frame: RelayPayloadFrame) => void;
export type StateListener<S> = (state: S) => void;

export interface RelayErrorInfo {
  code?: string;
  reason: string;
}
export type ErrorListener = (err: RelayErrorInfo) => void;

export type PeerStateListener = (peer: {
  state: "connected" | "disconnected";
  peerId: string;
}) => void;

/** 控制帧构造助手（避免各处手写字面量）。 */
export function controlFrame(
  action: RelayControlFrame["action"],
  fields: Omit<RelayControlFrame, "v" | "type" | "action"> = {},
): RelayControlFrame {
  return { v: 1, type: "control", action, ...fields };
}

// ---------------------------------------------------------------------------
// 内部：选项解析
// ---------------------------------------------------------------------------

const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

interface ResolvedClientOptions {
  sleep: (ms: number) => Promise<void>;
  clock: () => number;
  reconnectBaseDelayMs: number;
  reconnectMaxDelayMs: number;
  handshakeTimeoutMs: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function resolveOptions(
  raw?: RelayClientOptions,
): ResolvedClientOptions {
  return {
    sleep: raw?.sleep ?? defaultSleep,
    clock: raw?.clock ?? Date.now,
    reconnectBaseDelayMs: raw?.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS,
    reconnectMaxDelayMs: raw?.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS,
    handshakeTimeoutMs: raw?.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
  };
}

// ---------------------------------------------------------------------------
// 内部：出站 socket 封装（握手 + 帧路由）
// ---------------------------------------------------------------------------

interface SocketHooks {
  /** 握手 ack（registered / attached），每次（重）连成功都会触发 */
  onAck(frame: RelayControlFrame): void;
  /** 中继结构化拒绝 */
  onRejected(frame: RelayControlFrame): void;
  /** 桥建立（device 收到 controller 加入 / 重注册复桥） */
  onBridgeOpen(frame: RelayControlFrame): void;
  onPeerState(state: "connected" | "disconnected", peerId: string): void;
  onPayload(frame: RelayPayloadFrame): void;
  onProtocolError(info: RelayErrorInfo): void;
  /** 瞬态错误（error 帧 / superseded 帧），连接保持 */
  onTransientError(info: RelayErrorInfo): void;
  /** 传输层断开（每次真实 close 且未被代际失效时触发一次） */
  onClosed(code: number, reason: string): void;
}

class OutboundSocket {
  #ws: WebSocket | null = null;
  #gen = 0;
  #pendingSettle: ((error?: unknown) => void) | null = null;

  get generation(): number {
    return this.#gen;
  }

  get isOpen(): boolean {
    return this.#ws !== null && this.#ws.readyState === 1;
  }

  /**
   * 出站连接 + 发送 hello + 等待 ack。resolve 于 ack 帧；reject 于
   * rejected 帧（RelayRejectedError）/ 握手超时 / 连接失败 / 握手期断开。
   */
  connect(
    url: string,
    hello: RelayControlFrame,
    ackAction: "registered" | "attached",
    handshakeTimeoutMs: number,
    hooks: SocketHooks,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const gen = ++this.#gen;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const settle = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        this.#pendingSettle = null;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        if (error === undefined) resolve();
        else reject(error);
      };
      this.#pendingSettle = settle;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (error) {
        settle(error instanceof Error ? error : new Error(`WebSocket construction failed: ${String(error)}`));
        return;
      }
      this.#ws = ws;
      if (handshakeTimeoutMs > 0 && Number.isFinite(handshakeTimeoutMs)) {
        timer = setTimeout(() => {
          settle(new Error(`relay handshake timeout after ${handshakeTimeoutMs}ms`));
          try {
            ws.close();
          } catch {
            // 忽略
          }
        }, handshakeTimeoutMs);
      }
      ws.addEventListener("open", () => {
        if (gen !== this.#gen) {
          try {
            ws.close();
          } catch {
            // 忽略
          }
          return;
        }
        try {
          ws.send(encodeRelayFrame(hello));
        } catch (error) {
          settle(error instanceof Error ? error : new Error(String(error)));
        }
      });
      ws.addEventListener("message", (ev) => {
        if (gen !== this.#gen) return;
        const raw: unknown = (ev as { data: unknown }).data;
        if (typeof raw !== "string") return;
        let frame: RelayWireFrame;
        try {
          frame = decodeRelayFrame(raw);
        } catch (error) {
          if (error instanceof RelayProtocolError) {
            hooks.onProtocolError({ code: error.code, reason: error.message });
          } else {
            hooks.onProtocolError({ reason: String(error) });
          }
          return;
        }
        if (!settled && frame.type === "control") {
          if (frame.action === ackAction) {
            settle();
          } else if (frame.action === "rejected") {
            settle(new RelayRejectedError(frame.code ?? "INVALID_IDENTITY", frame.reason ?? "rejected by relay"));
          }
        }
        this.#route(frame, hooks);
      });
      ws.addEventListener("close", (ev) => {
        if (gen !== this.#gen) return;
        const closeEv = ev as { code?: number; reason?: string };
        settle(new Error(`relay connection closed during handshake (code=${closeEv.code ?? 1006}, reason=${closeEv.reason || "n/a"})`));
        this.#ws = null;
        hooks.onClosed(closeEv.code ?? 1006, closeEv.reason ?? "");
      });
      ws.addEventListener("error", () => {
        if (gen !== this.#gen) return;
        settle(new Error("relay connection error"));
        // close 事件随后必然到达；断开语义统一走 onClosed
      });
    });
  }

  /** 发送一帧；socket 未开或发送失败返回 false（不抛）。 */
  send(frame: RelayWireFrame): boolean {
    const ws = this.#ws;
    if (ws === null || ws.readyState !== 1) return false;
    try {
      ws.send(encodeRelayFrame(frame));
      return true;
    } catch {
      return false;
    }
  }

  /** 本地主动关闭：代际递增使后续事件失效，并终结未决握手。 */
  closeLocal(): void {
    this.#gen++;
    this.#pendingSettle?.(new Error("closed by client"));
    this.#pendingSettle = null;
    const ws = this.#ws;
    this.#ws = null;
    if (ws !== null) {
      try {
        ws.close(1000, "client close");
      } catch {
        // 忽略
      }
    }
  }

  #route(frame: RelayWireFrame, hooks: SocketHooks): void {
    if (frame.type === "a2a-payload") {
      hooks.onPayload(frame);
      return;
    }
    switch (frame.action) {
      case "ping": {
        this.send({ v: 1, type: "control", action: "pong" });
        return;
      }
      case "bridge-open": {
        hooks.onBridgeOpen(frame);
        return;
      }
      case "peer-state": {
        if (frame.state !== undefined && frame.peerId !== undefined) {
          hooks.onPeerState(frame.state, frame.peerId);
        }
        return;
      }
      case "error": {
        hooks.onTransientError({ code: frame.code, reason: frame.reason ?? "relay error" });
        return;
      }
      case "rejected": {
        hooks.onRejected(frame);
        return;
      }
      case "superseded": {
        hooks.onTransientError({ reason: frame.reason ?? "superseded by a newer connection" });
        return;
      }
      case "registered":
      case "attached": {
        hooks.onAck(frame);
        return;
      }
      default: {
        // register / attach / pong 不会从服务端下发
        return;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// DeviceClient（bi 侧设备端）
// ---------------------------------------------------------------------------

export class DeviceClient {
  readonly #socket = new OutboundSocket();
  #rawOptions: RelayClientOptions;
  #options: ResolvedClientOptions;
  #relayUrl: string | undefined;
  #deviceId: string | undefined;
  #state: DeviceClientState = "disconnected";
  /** connect() 期望保持连接；true = 断线自动重连开启 */
  #desired = false;
  /** 连续重连失败次数（注册成功即清零，驱动指数退避） */
  #attempts = 0;
  readonly #connectedControllers = new Set<string>();
  readonly #payloadListeners = new Set<PayloadListener>();
  readonly #stateListeners = new Set<StateListener<DeviceClientState>>();
  readonly #errorListeners = new Set<ErrorListener>();
  readonly #peerListeners = new Set<PeerStateListener>();

  constructor(options?: RelayClientOptions) {
    this.#rawOptions = options ?? {};
    this.#options = resolveOptions(this.#rawOptions);
  }

  get state(): DeviceClientState {
    return this.#state;
  }

  get deviceId(): string | undefined {
    return this.#deviceId;
  }

  onPayload(cb: PayloadListener): () => void {
    this.#payloadListeners.add(cb);
    return () => {
      this.#payloadListeners.delete(cb);
    };
  }

  onState(cb: StateListener<DeviceClientState>): () => void {
    this.#stateListeners.add(cb);
    return () => {
      this.#stateListeners.delete(cb);
    };
  }

  onError(cb: ErrorListener): () => void {
    this.#errorListeners.add(cb);
    return () => {
      this.#errorListeners.delete(cb);
    };
  }

  onPeerState(cb: PeerStateListener): () => void {
    this.#peerListeners.add(cb);
    return () => {
      this.#peerListeners.delete(cb);
    };
  }

  /**
   * 出站连接中继并注册 deviceId。resolve 于收到 registered 确认；
   * 结构化拒绝 → reject RelayRejectedError（并停止重连）；网络失败 →
   * 向调用方抛出的同时交由自动重连循环接管（指数退避 base*2^n 封顶 max）。
   */
  async connect(relayUrl: string, deviceId: string, opts?: RelayClientOptions): Promise<void> {
    if (this.#desired) {
      throw new Error("DeviceClient: connect() called while active — call close() first");
    }
    this.#rawOptions = { ...this.#rawOptions, ...opts };
    this.#options = resolveOptions(this.#rawOptions);
    this.#relayUrl = relayUrl;
    this.#deviceId = deviceId;
    this.#desired = true;
    this.#attempts = 0;
    this.#setState("connecting");
    try {
      await this.#registerOnce();
    } catch (error) {
      if (error instanceof RelayRejectedError) {
        // 结构化拒绝：重试无意义
        this.#desired = false;
        this.#setState("disconnected");
        throw error;
      }
      if (!this.#desired) {
        this.#setState("disconnected");
        throw error;
      }
      // 网络失败：onClosed 已启动自动重连循环；此处仅向调用方暴露首连失败
      throw error;
    }
  }

  /** 向（经中继桥接的）controller 发送业务载荷。未连接时抛错。 */
  sendToController(payload?: unknown): void {
    this.#requireOpen();
    if (!this.#socket.send({ v: 1, type: "a2a-payload", payload })) {
      throw new Error("DeviceClient: send failed (socket not open)");
    }
  }

  /** 向 controller 发送 BI-15.3 SignedEnvelope（envelope 字段，透传不验签）。 */
  sendEnvelopeToController(envelope: RelayEnvelope): void {
    this.#requireOpen();
    if (!this.#socket.send({ v: 1, type: "a2a-payload", envelope })) {
      throw new Error("DeviceClient: send failed (socket not open)");
    }
  }

  /** 主动关闭：取消自动重连，状态 disconnected。 */
  close(): void {
    this.#desired = false;
    this.#socket.closeLocal();
    this.#connectedControllers.clear();
    this.#setState("disconnected");
  }

  // -------------------------------------------------------------------------

  async #registerOnce(): Promise<void> {
    const url = this.#relayUrl;
    const deviceId = this.#deviceId;
    if (url === undefined || deviceId === undefined) {
      throw new Error("DeviceClient: relayUrl/deviceId missing");
    }
    await this.#socket.connect(
      url,
      controlFrame("register", { deviceId }),
      "registered",
      this.#options.handshakeTimeoutMs,
      {
        onAck: () => {
          this.#attempts = 0;
          this.#setState("registered");
        },
        onRejected: (frame) => {
          this.#emitError({ code: frame.code, reason: frame.reason ?? "rejected by relay" });
        },
        onBridgeOpen: (frame) => {
          if (frame.controllerId !== undefined) {
            this.#connectedControllers.add(frame.controllerId);
            this.#emitPeer({ state: "connected", peerId: frame.controllerId });
          }
          this.#syncBridgeState();
        },
        onPeerState: (state, peerId) => {
          if (state === "connected") this.#connectedControllers.add(peerId);
          else this.#connectedControllers.delete(peerId);
          this.#emitPeer({ state, peerId });
          this.#syncBridgeState();
        },
        onPayload: (frame) => {
          this.#emitPayload(frame);
        },
        onProtocolError: (info) => {
          this.#emitError(info);
        },
        onTransientError: (info) => {
          this.#emitError(info);
        },
        onClosed: () => {
          this.#handleClosed();
        },
      },
    );
  }

  #handleClosed(): void {
    this.#connectedControllers.clear();
    if (!this.#desired) {
      this.#setState("disconnected");
      return;
    }
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (!this.#desired) return;
    const attempt = this.#attempts + 1;
    this.#attempts = attempt;
    const base = this.#options.reconnectBaseDelayMs;
    const max = this.#options.reconnectMaxDelayMs;
    const delay = Math.min(base * 2 ** (attempt - 1), max);
    this.#setState("connecting");
    void (async () => {
      if (!this.#desired) return;
      await this.#options.sleep(delay);
      if (!this.#desired) return;
      try {
        await this.#registerOnce();
      } catch (error) {
        if (!this.#desired) return;
        if (error instanceof RelayRejectedError) {
          // 重连期被中继结构化拒绝：停止重连
          this.#desired = false;
          this.#setState("disconnected");
          this.#emitError({ code: error.code, reason: error.reason });
          return;
        }
        // 网络失败：onClosed 已再次进入 scheduleReconnect；此处无需重复调度
      }
    })();
  }

  #syncBridgeState(): void {
    if (this.#state !== "registered" && this.#state !== "bridge-open") return;
    this.#setState(this.#connectedControllers.size > 0 ? "bridge-open" : "registered");
  }

  #requireOpen(): void {
    if (this.#state !== "registered" && this.#state !== "bridge-open") {
      throw new Error(`DeviceClient: not connected (state=${this.#state})`);
    }
  }

  #setState(state: DeviceClientState): void {
    if (state === this.#state) return;
    this.#state = state;
    for (const listener of [...this.#stateListeners]) {
      try {
        listener(state);
      } catch {
        // 监听器异常不外溢
      }
    }
  }

  #emitPayload(frame: RelayPayloadFrame): void {
    for (const listener of [...this.#payloadListeners]) {
      try {
        listener(frame);
      } catch {
        // 监听器异常不外溢
      }
    }
  }

  #emitError(info: RelayErrorInfo): void {
    for (const listener of [...this.#errorListeners]) {
      try {
        listener(info);
      } catch {
        // 监听器异常不外溢
      }
    }
  }

  #emitPeer(peer: { state: "connected" | "disconnected"; peerId: string }): void {
    for (const listener of [...this.#peerListeners]) {
      try {
        listener(peer);
      } catch {
        // 监听器异常不外溢
      }
    }
  }
}

// ---------------------------------------------------------------------------
// ControllerClient（远程控制端）
// ---------------------------------------------------------------------------

export class ControllerClient {
  readonly #socket = new OutboundSocket();
  #rawOptions: RelayClientOptions & { controllerId?: string };
  #options: ResolvedClientOptions;
  #relayUrl: string | undefined;
  #controllerId: string | undefined;
  #state: ControllerClientState = "disconnected";
  /** attach 生效标记（防重复 attach；v1 无自动重连） */
  #attached = false;
  readonly #eventListeners = new Set<PayloadListener>();
  readonly #stateListeners = new Set<StateListener<ControllerClientState>>();
  readonly #errorListeners = new Set<ErrorListener>();
  readonly #peerListeners = new Set<PeerStateListener>();

  constructor(options?: RelayClientOptions & { controllerId?: string }) {
    this.#rawOptions = options ?? {};
    this.#options = resolveOptions(this.#rawOptions);
  }

  get state(): ControllerClientState {
    return this.#state;
  }

  get controllerId(): string | undefined {
    return this.#controllerId;
  }

  /** 收 device 经中继转发的 A2A 载荷（onPayload 的 controller 侧命名）。 */
  onEvent(cb: PayloadListener): () => void {
    this.#eventListeners.add(cb);
    return () => {
      this.#eventListeners.delete(cb);
    };
  }

  onState(cb: StateListener<ControllerClientState>): () => void {
    this.#stateListeners.add(cb);
    return () => {
      this.#stateListeners.delete(cb);
    };
  }

  onError(cb: ErrorListener): () => void {
    this.#errorListeners.add(cb);
    return () => {
      this.#errorListeners.delete(cb);
    };
  }

  onPeerState(cb: PeerStateListener): () => void {
    this.#peerListeners.add(cb);
    return () => {
      this.#peerListeners.delete(cb);
    };
  }

  /**
   * 出站连接中继并声明控制目标 targetDeviceId。
   * 目标设备未注册 → reject RelayRejectedError('DEVICE_NOT_REGISTERED')；
   * resolve 于收到 attached 确认（桥已建立）。
   */
  async attach(relayUrl: string, targetDeviceId: string, opts?: RelayClientOptions): Promise<void> {
    if (this.#attached || this.#state !== "disconnected") {
      throw new Error("ControllerClient: attach() called while active — call close() first");
    }
    this.#rawOptions = { ...this.#rawOptions, ...opts };
    this.#options = resolveOptions(this.#rawOptions);
    const controllerId = this.#rawOptions.controllerId ?? `ctrl-${crypto.randomUUID()}`;
    this.#relayUrl = relayUrl;
    this.#controllerId = controllerId;
    this.#attached = true;
    this.#setState("connecting");
    try {
      await this.#socket.connect(
        relayUrl,
        controlFrame("attach", { controllerId, targetDeviceId }),
        "attached",
        this.#options.handshakeTimeoutMs,
        {
          onAck: () => {
            this.#setState("attached");
          },
          onRejected: (frame) => {
            this.#emitError({ code: frame.code, reason: frame.reason ?? "rejected by relay" });
          },
          onBridgeOpen: (frame) => {
            // 目标设备重注册复桥
            if (frame.deviceId !== undefined) {
              this.#emitPeer({ state: "connected", peerId: frame.deviceId });
            }
          },
          onPeerState: (state, peerId) => {
            this.#emitPeer({ state, peerId });
          },
          onPayload: (frame) => {
            this.#emitEvent(frame);
          },
          onProtocolError: (info) => {
            this.#emitError(info);
          },
          onTransientError: (info) => {
            this.#emitError(info);
          },
          onClosed: () => {
            this.#attached = false;
            this.#setState("disconnected");
          },
        },
      );
    } catch (error) {
      this.#attached = false;
      this.#setState("disconnected");
      throw error;
    }
  }

  /** 向设备发送业务载荷（经中继桥接转发）。未连接时抛错。 */
  send(payload?: unknown): void {
    this.#requireOpen();
    if (!this.#socket.send({ v: 1, type: "a2a-payload", payload })) {
      throw new Error("ControllerClient: send failed (socket not open)");
    }
  }

  /** 向设备发送 BI-15.3 SignedEnvelope（envelope 字段，透传不验签）。 */
  sendEnvelope(envelope: RelayEnvelope): void {
    this.#requireOpen();
    if (!this.#socket.send({ v: 1, type: "a2a-payload", envelope })) {
      throw new Error("ControllerClient: send failed (socket not open)");
    }
  }

  close(): void {
    this.#attached = false;
    this.#socket.closeLocal();
    this.#setState("disconnected");
  }

  // -------------------------------------------------------------------------

  #requireOpen(): void {
    if (this.#state !== "attached") {
      throw new Error(`ControllerClient: not attached (state=${this.#state})`);
    }
  }

  #setState(state: ControllerClientState): void {
    if (state === this.#state) return;
    this.#state = state;
    for (const listener of [...this.#stateListeners]) {
      try {
        listener(state);
      } catch {
        // 监听器异常不外溢
      }
    }
  }

  #emitEvent(frame: RelayPayloadFrame): void {
    for (const listener of [...this.#eventListeners]) {
      try {
        listener(frame);
      } catch {
        // 监听器异常不外溢
      }
    }
  }

  #emitError(info: RelayErrorInfo): void {
    for (const listener of [...this.#errorListeners]) {
      try {
        listener(info);
      } catch {
        // 监听器异常不外溢
      }
    }
  }

  #emitPeer(peer: { state: "connected" | "disconnected"; peerId: string }): void {
    for (const listener of [...this.#peerListeners]) {
      try {
        listener(peer);
      } catch {
        // 监听器异常不外溢
      }
    }
  }
}
