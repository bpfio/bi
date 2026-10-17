/**
 * BI-15.4 · RelayServer 测试 —— 仅绑定 127.0.0.1 本地中继 fixture（本机 localhost 测试授权）。
 * 覆盖：注册 / attach / 桥接透传（字节级）/ 双向 / 未注册拒绝 / 重复注册踢旧 /
 * 心跳超时清理（注入时钟）/ peer-state / fan-out / stop / stats / 帧校验。
 */

import { describe, expect, test } from "bun:test";
import {
  RelayProtocolError,
  RelayServer,
  RELAY_CLOSE_CODE,
  decodeRelayFrame,
  type RelayControlAction,
  type RelayControlFrame,
  type RelayPayloadFrame,
  type RelayServerOptions,
  type RelayWireFrame,
} from "./remote-relay";

// ---------------------------------------------------------------------------
// 本地 fixture 工具（原始 WebSocket 客户端，用于协议层断言）
// ---------------------------------------------------------------------------

interface RawConn {
  ws: WebSocket;
  /** 收到的原始文本帧（字节级透传断言用） */
  rawIn: string[];
  frames: RelayWireFrame[];
  closed: Promise<{ code: number; reason: string }>;
  isClosed(): boolean;
  send(frame: RelayWireFrame): void;
  sendRaw(text: string): void;
  waitFor<S extends RelayWireFrame>(
    pred: (frame: RelayWireFrame) => frame is S,
    label?: string,
  ): Promise<S>;
  waitFor(pred: (frame: RelayWireFrame) => boolean, label?: string): Promise<RelayWireFrame>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

async function until(cond: () => boolean, label = "condition", timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`until timeout: ${label}`);
    await realSleep(5);
  }
}

const isControl =
  (action: RelayControlAction) =>
  (frame: RelayWireFrame): frame is RelayControlFrame =>
    frame.type === "control" && frame.action === action;

const isErrorFrame = (frame: RelayWireFrame): frame is RelayControlFrame =>
  frame.type === "control" && frame.action === "error";

const isPayloadFrame = (frame: RelayWireFrame): frame is RelayPayloadFrame =>
  frame.type === "a2a-payload";

async function rawConnect(url: string): Promise<RawConn> {
  const ws = new WebSocket(url);
  const rawIn: string[] = [];
  const frames: RelayWireFrame[] = [];
  const waiters: Array<{ pred: (f: RelayWireFrame) => boolean; resolve: (f: RelayWireFrame) => void }> = [];
  let closedSettled = false;
  const dispatch = (frame: RelayWireFrame): void => {
    frames.push(frame);
    const index = waiters.findIndex((w) => w.pred(frame));
    if (index >= 0) {
      const [matched] = waiters.splice(index, 1);
      matched?.resolve(frame);
    }
  };
  ws.addEventListener("message", (ev) => {
    const data: unknown = (ev as { data: unknown }).data;
    if (typeof data !== "string") return;
    rawIn.push(data);
    try {
      dispatch(decodeRelayFrame(data));
    } catch {
      dispatch({ v: 1, type: "control", action: "error", reason: "undecodable frame" });
    }
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.addEventListener("close", (ev) => {
      closedSettled = true;
      const e = ev as { code?: number; reason?: string };
      resolve({ code: e.code ?? 1006, reason: e.reason ?? "" });
    });
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error(`raw connect failed: ${url}`)));
  });
  const waitFor = (
    pred: (frame: RelayWireFrame) => boolean,
    label = "frame",
  ): Promise<RelayWireFrame> =>
    new Promise<RelayWireFrame>((resolve, reject) => {
      const found = frames.find(pred);
      if (found !== undefined) {
        resolve(found);
        return;
      }
      const timer = setTimeout(() => reject(new Error(`waitFor timeout: ${label}`)), 2_000);
      waiters.push({
        pred: (f) => {
          if (!pred(f)) return false;
          clearTimeout(timer);
          return true;
        },
        resolve,
      });
    });
  return {
    ws,
    rawIn,
    frames,
    closed,
    isClosed: () => closedSettled,
    send: (frame) => {
      ws.send(JSON.stringify(frame));
    },
    sendRaw: (text) => {
      ws.send(text);
    },
    waitFor: waitFor as RawConn["waitFor"],
  };
}

function startRelay(options?: RelayServerOptions): RelayServer {
  const relay = new RelayServer(options);
  relay.start();
  return relay;
}

async function rawRegister(url: string, deviceId: string): Promise<RawConn> {
  const conn = await rawConnect(url);
  conn.send({ v: 1, type: "control", action: "register", deviceId });
  await conn.waitFor(isControl("registered"), "registered");
  return conn;
}

async function rawAttach(url: string, controllerId: string, targetDeviceId: string): Promise<RawConn> {
  const conn = await rawConnect(url);
  conn.send({ v: 1, type: "control", action: "attach", controllerId, targetDeviceId });
  await conn.waitFor(isControl("attached"), "attached");
  return conn;
}

// ---------------------------------------------------------------------------
// 服务端协议层
// ---------------------------------------------------------------------------

describe("BI-15.4 · RelayServer（中继桥）", () => {
  test("绑定 127.0.0.1 随机端口（零入站暴露面：仅 localhost fixture）", () => {
    const relay = startRelay();
    try {
      expect(relay.port).toBeGreaterThan(0);
      expect(relay.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
      expect(relay.stats()).toEqual({ devices: 0, controllers: 0, bridges: 0 });
    } finally {
      relay.stop();
    }
  });

  test("device 出站注册 → registered 确认帧（含 deviceId 回显）", async () => {
    const relay = startRelay();
    try {
      const device = await rawRegister(relay.url, "d1");
      const ack = device.frames.find(isControl("registered"));
      expect(ack?.deviceId).toBe("d1");
      expect(relay.stats().devices).toBe(1);
      device.ws.close();
    } finally {
      relay.stop();
    }
  });

  test("attach 未注册 deviceId → 结构化拒绝 DEVICE_NOT_REGISTERED + 关闭 4400", async () => {
    const relay = startRelay();
    try {
      const controller = await rawConnect(relay.url);
      controller.send({ v: 1, type: "control", action: "attach", controllerId: "c1", targetDeviceId: "ghost" });
      const rejected = await controller.waitFor(isControl("rejected"), "rejected");
      expect(rejected.code).toBe("DEVICE_NOT_REGISTERED");
      const closed = await controller.closed;
      expect(closed.code).toBe(RELAY_CLOSE_CODE.REJECTED);
    } finally {
      relay.stop();
    }
  });

  test("attach 已注册设备 → attached；device 收 bridge-open；bridges=1", async () => {
    const relay = startRelay();
    try {
      const device = await rawRegister(relay.url, "d1");
      const controller = await rawAttach(relay.url, "c1", "d1");
      const bridge = await device.waitFor(isControl("bridge-open"), "bridge-open");
      expect(bridge.deviceId).toBe("d1");
      expect(bridge.controllerId).toBe("c1");
      const attached = controller.frames.find(isControl("attached"));
      expect(attached?.targetDeviceId).toBe("d1");
      expect(relay.stats().bridges).toBe(1);
      device.ws.close();
      controller.ws.close();
    } finally {
      relay.stop();
    }
  });

  test("controller→device 桥接：a2a-payload 原样字节级透传（envelope 不改写）", async () => {
    const relay = startRelay();
    try {
      const device = await rawRegister(relay.url, "d1");
      const controller = await rawAttach(relay.url, "c1", "d1");
      const payloadText = JSON.stringify({
        v: 1,
        type: "a2a-payload",
        envelope: { alg: "HMAC-SHA256", signature: "Abc123_-", from: "c1" },
        payload: { op: "run", nested: { z: 1, a: [1, 2, 3] } },
      });
      controller.sendRaw(payloadText);
      await until(() => device.rawIn.includes(payloadText), "device receives forwarded payload");
      expect(device.rawIn.includes(payloadText)).toBe(true); // 字节级一致：元素全等
      device.ws.close();
      controller.ws.close();
    } finally {
      relay.stop();
    }
  });

  test("device→controller 反向桥接（双向通道）", async () => {
    const relay = startRelay();
    try {
      const device = await rawRegister(relay.url, "d1");
      const controller = await rawAttach(relay.url, "c1", "d1");
      const eventText = JSON.stringify({ v: 1, type: "a2a-payload", payload: { ev: "telemetry", n: 7 } });
      device.sendRaw(eventText);
      await until(() => controller.rawIn.length >= 2, "controller receives device event");
      expect(controller.rawIn[controller.rawIn.length - 1]).toBe(eventText);
      device.ws.close();
      controller.ws.close();
    } finally {
      relay.stop();
    }
  });

  test("已注册设备无 controller 时发载荷 → error NOT_ATTACHED（瞬态，连接保持）", async () => {
    const relay = startRelay();
    try {
      const device = await rawRegister(relay.url, "d1");
      device.send({ v: 1, type: "a2a-payload", payload: { x: 1 } });
      const error = await device.waitFor(isErrorFrame, "error");
      expect(error.code).toBe("NOT_ATTACHED");
      await realSleep(30);
      expect(device.isClosed()).toBe(false);
      device.ws.close();
    } finally {
      relay.stop();
    }
  });

  test("目标设备掉线后 controller 发载荷 → error DEVICE_NOT_CONNECTED（连接保持）", async () => {
    const relay = startRelay();
    try {
      const device = await rawRegister(relay.url, "d1");
      const controller = await rawAttach(relay.url, "c1", "d1");
      device.ws.close();
      await controller.waitFor(isControl("peer-state"), "peer-state");
      controller.send({ v: 1, type: "a2a-payload", payload: { op: "x" } });
      const error = await controller.waitFor(isErrorFrame, "error");
      expect(error.code).toBe("DEVICE_NOT_CONNECTED");
      await realSleep(30);
      expect(controller.isClosed()).toBe(false);
      controller.ws.close();
    } finally {
      relay.stop();
    }
  });

  test("同 deviceId 重复注册：旧连接收 superseded 后被踢（4001），新连接胜出", async () => {
    const relay = startRelay();
    try {
      const oldConn = await rawRegister(relay.url, "dup");
      const newConn = await rawConnect(relay.url);
      newConn.send({ v: 1, type: "control", action: "register", deviceId: "dup" });
      const superseded = await oldConn.waitFor(isControl("superseded"), "superseded");
      expect(superseded.reason).toContain("dup");
      const oldClosed = await oldConn.closed;
      expect(oldClosed.code).toBe(RELAY_CLOSE_CODE.SUPERSEDED);
      await newConn.waitFor(isControl("registered"), "registered (new wins)");
      expect(relay.stats().devices).toBe(1);
      newConn.ws.close();
    } finally {
      relay.stop();
    }
  });

  test("同 controllerId 重复 attach：旧连接被踢，注册表保持单份", async () => {
    const relay = startRelay();
    try {
      await rawRegister(relay.url, "d1");
      const oldConn = await rawAttach(relay.url, "c-same", "d1");
      const newConn = await rawConnect(relay.url);
      newConn.send({ v: 1, type: "control", action: "attach", controllerId: "c-same", targetDeviceId: "d1" });
      await oldConn.waitFor(isControl("superseded"), "superseded");
      expect((await oldConn.closed).code).toBe(RELAY_CLOSE_CODE.SUPERSEDED);
      await newConn.waitFor(isControl("attached"), "attached (new wins)");
      expect(relay.stats().controllers).toBe(1);
      newConn.ws.close();
    } finally {
      relay.stop();
    }
  });

  test("注入时钟：不回 pong 的连接超时被清理（关闭码 4408）", async () => {
    let now = 1_000_000;
    const relay = startRelay({ clock: () => now, heartbeatIntervalMs: 3_600_000, heartbeatTimeoutMs: 5_000 });
    try {
      const device = await rawRegister(relay.url, "d-hb");
      now += 6_000;
      relay.heartbeatCheck();
      const closed = await device.closed;
      expect(closed.code).toBe(RELAY_CLOSE_CODE.HEARTBEAT_TIMEOUT);
      expect(relay.stats().devices).toBe(0);
    } finally {
      relay.stop();
    }
  });

  test("注入时钟：手动 pong 保活多轮存活；静默超阈值后仍被清理", async () => {
    let now = 2_000_000;
    const relay = startRelay({ clock: () => now, heartbeatIntervalMs: 3_600_000, heartbeatTimeoutMs: 5_000 });
    try {
      const device = await rawRegister(relay.url, "d-pong");
      for (let round = 0; round < 3; round++) {
        now += 2_000;
        relay.heartbeatCheck();
        await device.waitFor(isControl("ping"), "ping");
        device.send({ v: 1, type: "control", action: "pong" });
        await realSleep(20); // 等 pong 往返落账（lastSeen 刷新）
      }
      expect(relay.stats().devices).toBe(1);
      now += 9_000;
      relay.heartbeatCheck();
      const closed = await device.closed;
      expect(closed.code).toBe(RELAY_CLOSE_CODE.HEARTBEAT_TIMEOUT);
    } finally {
      relay.stop();
    }
  });

  test("device 掉线 → 已 attach 的 controller 收 peer-state disconnected(deviceId)", async () => {
    const relay = startRelay();
    try {
      const device = await rawRegister(relay.url, "d1");
      const controller = await rawAttach(relay.url, "c1", "d1");
      device.ws.close();
      const peer = await controller.waitFor(isControl("peer-state"), "peer-state");
      expect(peer.state).toBe("disconnected");
      expect(peer.peerId).toBe("d1");
      controller.ws.close();
    } finally {
      relay.stop();
    }
  });

  test("controller 掉线 → device 收 peer-state disconnected(controllerId)", async () => {
    const relay = startRelay();
    try {
      const device = await rawRegister(relay.url, "d1");
      const controller = await rawAttach(relay.url, "c1", "d1");
      controller.ws.close();
      const peer = await device.waitFor(isControl("peer-state"), "peer-state");
      expect(peer.state).toBe("disconnected");
      expect(peer.peerId).toBe("c1");
      device.ws.close();
    } finally {
      relay.stop();
    }
  });

  test("多 controller attach 同一 device：device 载荷 fan-out 给全部 controller", async () => {
    const relay = startRelay();
    try {
      const device = await rawRegister(relay.url, "d1");
      const c1 = await rawAttach(relay.url, "c1", "d1");
      const c2 = await rawAttach(relay.url, "c2", "d1");
      expect(relay.stats().bridges).toBe(2);
      device.send({ v: 1, type: "a2a-payload", payload: { n: 1 } });
      await c1.waitFor(isPayloadFrame, "c1 payload");
      await c2.waitFor(isPayloadFrame, "c2 payload");
      device.ws.close();
      c1.ws.close();
      c2.ws.close();
    } finally {
      relay.stop();
    }
  });

  test("非法 JSON 帧 → rejected MALFORMED_FRAME + 关闭 4400", async () => {
    const relay = startRelay();
    try {
      const conn = await rawConnect(relay.url);
      conn.sendRaw("this is not json{");
      const rejected = await conn.waitFor(isControl("rejected"), "rejected");
      expect(rejected.code).toBe("MALFORMED_FRAME");
      expect((await conn.closed).code).toBe(RELAY_CLOSE_CODE.REJECTED);
    } finally {
      relay.stop();
    }
  });

  test("协议版本不符（v:2）→ rejected PROTOCOL_VERSION", async () => {
    const relay = startRelay();
    try {
      const conn = await rawConnect(relay.url);
      conn.sendRaw(JSON.stringify({ v: 2, type: "control", action: "register", deviceId: "x" }));
      const rejected = await conn.waitFor(isControl("rejected"), "rejected");
      expect(rejected.code).toBe("PROTOCOL_VERSION");
      expect((await conn.closed).code).toBe(RELAY_CLOSE_CODE.REJECTED);
    } finally {
      relay.stop();
    }
  });

  test("register 缺 deviceId → rejected INVALID_IDENTITY", async () => {
    const relay = startRelay();
    try {
      const conn = await rawConnect(relay.url);
      conn.send({ v: 1, type: "control", action: "register" });
      const rejected = await conn.waitFor(isControl("rejected"), "rejected");
      expect(rejected.code).toBe("INVALID_IDENTITY");
      expect((await conn.closed).code).toBe(RELAY_CLOSE_CODE.REJECTED);
    } finally {
      relay.stop();
    }
  });

  test("二进制帧 → rejected MALFORMED_FRAME（v1 仅 JSON 文本帧）", async () => {
    const relay = startRelay();
    try {
      const conn = await rawConnect(relay.url);
      conn.ws.send(new Uint8Array([1, 2, 3]));
      const rejected = await conn.waitFor(isControl("rejected"), "rejected");
      expect(rejected.code).toBe("MALFORMED_FRAME");
      expect((await conn.closed).code).toBe(RELAY_CLOSE_CODE.REJECTED);
    } finally {
      relay.stop();
    }
  });

  test("fresh 连接未 register/attach 先发载荷 → rejected NOT_ATTACHED", async () => {
    const relay = startRelay();
    try {
      const conn = await rawConnect(relay.url);
      conn.send({ v: 1, type: "a2a-payload", payload: {} });
      const rejected = await conn.waitFor(isControl("rejected"), "rejected");
      expect(rejected.code).toBe("NOT_ATTACHED");
      expect((await conn.closed).code).toBe(RELAY_CLOSE_CODE.REJECTED);
    } finally {
      relay.stop();
    }
  });

  test("stop() 关闭全部存活连接（4002 server shutdown；Bun 把 1001 线上映射为 1000）", async () => {
    const relay = startRelay();
    const device = await rawRegister(relay.url, "d1");
    const controller = await rawAttach(relay.url, "c1", "d1");
    relay.stop();
    expect((await device.closed).code).toBe(RELAY_CLOSE_CODE.SHUTDOWN);
    expect((await controller.closed).code).toBe(RELAY_CLOSE_CODE.SHUTDOWN);
  });

  test("stats() 精确反映注册表与桥数变化", async () => {
    const relay = startRelay();
    try {
      const device = await rawRegister(relay.url, "d1");
      const controller = await rawAttach(relay.url, "c1", "d1");
      expect(relay.stats()).toEqual({ devices: 1, controllers: 1, bridges: 1 });
      controller.ws.close();
      await until(() => relay.stats().controllers === 0, "controller detached");
      expect(relay.stats()).toEqual({ devices: 1, controllers: 0, bridges: 0 });
      device.ws.close();
    } finally {
      relay.stop();
    }
  });

  test("envelope 深层对象（含 unicode）经中继往返后值完整（透传不验签）", async () => {
    const relay = startRelay();
    try {
      const device = await rawRegister(relay.url, "d1");
      const controller = await rawAttach(relay.url, "控制器-01", "d1");
      const envelope = {
        alg: "HMAC-SHA256",
        signature: "aB-cdEf123",
        from: "控制器-01",
        payload: { 深层: { list: [1, "二", { x: null }], flag: true } },
      };
      controller.send({ v: 1, type: "a2a-payload", envelope });
      const frame = await device.waitFor(isPayloadFrame, "payload");
      expect(frame.envelope).toEqual(envelope);
      device.ws.close();
      controller.ws.close();
    } finally {
      relay.stop();
    }
  });

  test("decodeRelayFrame 单元：malformed / 版本 / 未知 action 抛 RelayProtocolError", () => {
    try {
      decodeRelayFrame("nope");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RelayProtocolError);
      expect((error as RelayProtocolError).code).toBe("MALFORMED_FRAME");
    }
    try {
      decodeRelayFrame(JSON.stringify({ v: 9, type: "control", action: "ping" }));
      expect.unreachable();
    } catch (error) {
      expect((error as RelayProtocolError).code).toBe("PROTOCOL_VERSION");
    }
    try {
      decodeRelayFrame(JSON.stringify({ v: 1, type: "control", action: "nope" }));
      expect.unreachable();
    } catch (error) {
      expect((error as RelayProtocolError).code).toBe("MALFORMED_FRAME");
    }
    const ok = decodeRelayFrame(JSON.stringify({ v: 1, type: "a2a-payload", envelope: {}, payload: 1 }));
    expect(ok.type).toBe("a2a-payload");
  });
});
