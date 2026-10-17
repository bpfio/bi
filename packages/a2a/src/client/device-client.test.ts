/**
 * BI-15.4 · DeviceClient / ControllerClient 测试 —— 127.0.0.1 本地中继 fixture。
 * 覆盖：零入站语义（双方仅出站连接）/ 状态机 / 双向收发 / 未注册拒绝 /
 * 断线自动重连指数退避（注入 sleep，1s→30s 封顶、成功重置）/ 心跳自动 pong /
 * 端到端 BI-15.3 SignedEnvelope sign→verify 往返（中继透传不验签）。
 */

import { describe, expect, test } from "bun:test";
import { ControllerClient, DeviceClient, type DeviceClientState } from "./device-client";
import {
  RelayRejectedError,
  RelayServer,
  decodeRelayFrame,
  type RelayPayloadFrame,
  type RelayWireFrame,
} from "../transports/remote-relay";
import {
  MemoryReplayStore,
  a2aSecret,
  signEnvelope,
  verifyEnvelope,
  type SignedEnvelope,
} from "../auth";

// ---------------------------------------------------------------------------
// 本地 fixture 工具
// ---------------------------------------------------------------------------

interface RawConn {
  ws: WebSocket;
  closed: Promise<{ code: number; reason: string }>;
  send(frame: RelayWireFrame): void;
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
  (action: string) =>
  (frame: RelayWireFrame): boolean =>
    frame.type === "control" && frame.action === action;

async function rawConnect(url: string): Promise<RawConn> {
  const ws = new WebSocket(url);
  const frames: RelayWireFrame[] = [];
  const waiters: Array<{ pred: (f: RelayWireFrame) => boolean; resolve: (f: RelayWireFrame) => void }> = [];
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
    try {
      dispatch(decodeRelayFrame(data));
    } catch {
      dispatch({ v: 1, type: "control", action: "error", reason: "undecodable frame" });
    }
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.addEventListener("close", () => resolve({ code: 1006, reason: "" }));
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error(`raw connect failed: ${url}`)));
  });
  return {
    ws,
    closed,
    send: (frame) => {
      ws.send(JSON.stringify(frame));
    },
    waitFor: (pred, label = "frame") =>
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
      }),
  };
}

function startRelay(): RelayServer {
  const relay = new RelayServer();
  relay.start();
  return relay;
}

/** 注入 sleep：记录退避序列后立即放行（重连节奏由断言驱动、时间由真实网络驱动）。 */
function sleepSpy(sleeps: number[]): (ms: number) => Promise<void> {
  return (ms: number) => {
    sleeps.push(ms);
    return Promise.resolve();
  };
}

// ---------------------------------------------------------------------------
// DeviceClient / ControllerClient（端到端，经真实本地中继）
// ---------------------------------------------------------------------------

describe("BI-15.4 · DeviceClient（bi 侧，零公网入站端口）", () => {
  test("connect：出站注册成功 resolve，状态机 connecting → registered", async () => {
    const relay = startRelay();
    try {
      const states: DeviceClientState[] = [];
      const device = new DeviceClient();
      device.onState((s) => states.push(s));
      await device.connect(relay.url, "d-flow");
      expect(device.state).toBe("registered");
      expect(device.deviceId).toBe("d-flow");
      expect(states).toEqual(["connecting", "registered"]);
      device.close();
    } finally {
      relay.stop();
    }
  });

  test("controller attach 后 device 状态 bridge-open；controller 掉线回落 registered", async () => {
    const relay = startRelay();
    try {
      const device = new DeviceClient();
      await device.connect(relay.url, "d-bridge");
      const peers: Array<{ state: string; peerId: string }> = [];
      device.onPeerState((p) => peers.push(p));
      const controller = new ControllerClient();
      const cStates: string[] = [];
      controller.onState((s) => cStates.push(s));
      await controller.attach(relay.url, "d-bridge");
      await until(() => device.state === "bridge-open", "device bridge-open");
      expect(controller.state).toBe("attached");
      expect(cStates).toEqual(["connecting", "attached"]);
      controller.close();
      await until(() => device.state === "registered", "device back to registered");
      expect(peers.some((p) => p.state === "disconnected" && p.peerId === controller.controllerId)).toBe(true);
      device.close();
    } finally {
      relay.stop();
    }
  });

  test("connect 空 deviceId → RelayRejectedError INVALID_IDENTITY（中继为协议权威，客户端透传拒绝）", async () => {
    const relay = startRelay();
    try {
      const device = new DeviceClient();
      try {
        await device.connect(relay.url, "   ");
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(RelayRejectedError);
        expect((error as RelayRejectedError).code).toBe("INVALID_IDENTITY");
      }
      expect(device.state).toBe("disconnected");
    } finally {
      relay.stop();
    }
  });

  test("未连接时 sendToController 抛错", () => {
    const device = new DeviceClient();
    expect(() => device.sendToController({})).toThrow();
  });

  test("断线自动重连：指数退避序列 1s→2s→4s→8s（注入 sleep），close() 后不再调度", async () => {
    const relay = startRelay();
    const sleeps: number[] = [];
    const device = new DeviceClient({ sleep: sleepSpy(sleeps) });
    try {
      await device.connect(relay.url, "d-backoff");
      expect(device.state).toBe("registered");
      relay.stop(); // 传输层断开 → 自动重连循环
      await until(() => sleeps.length >= 4, "backoff sequence");
      expect(sleeps.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);
      expect(device.state).toBe("connecting");
      device.close();
      expect(device.state).toBe("disconnected");
      const recorded = sleeps.length;
      await realSleep(60);
      expect(sleeps.length).toBe(recorded); // close() 取消后续退避
    } finally {
      relay.stop();
    }
  });

  test("重连退避封顶 30s（1k,2k,4k,8k,16k,30k,30k）", async () => {
    const relay = startRelay();
    const sleeps: number[] = [];
    const device = new DeviceClient({ sleep: sleepSpy(sleeps) });
    try {
      await device.connect(relay.url, "d-cap");
      relay.stop();
      await until(() => sleeps.length >= 7, "capped backoff");
      expect(sleeps.slice(0, 7)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
      device.close();
    } finally {
      relay.stop();
    }
  });

  test("被同 deviceId 新连接踢掉后自动重连并重新注册（退避重置）", async () => {
    const relay = startRelay();
    const sleeps: number[] = [];
    const device = new DeviceClient({ sleep: sleepSpy(sleeps) });
    try {
      await device.connect(relay.url, "d-kick");
      const usurper = await rawConnect(relay.url);
      usurper.send({ v: 1, type: "control", action: "register", deviceId: "d-kick" });
      await usurper.waitFor(isControl("registered"), "usurper registered");
      await until(
        () => device.state === "registered" && sleeps.length >= 1,
        "device auto-reconnected after supersede",
      );
      expect(sleeps).toEqual([1_000]); // 成功注册即重置，无第二跳
      await until(() => relay.stats().devices === 1, "registry back to single device");
      device.close();
      usurper.ws.close();
    } finally {
      relay.stop();
    }
  });

  test("心跳自动 pong 保活（注入时钟多轮存活；静默超阈值被同步清扫）", async () => {
    let now = 50_000;
    const relay = new RelayServer({ clock: () => now, heartbeatIntervalMs: 3_600_000, heartbeatTimeoutMs: 5_000 });
    relay.start();
    const device = new DeviceClient();
    try {
      await device.connect(relay.url, "d-keepalive");
      for (let round = 0; round < 3; round++) {
        now += 2_000;
        relay.heartbeatCheck();
        await realSleep(20); // ping→pong 往返（客户端自动应答）
      }
      expect(relay.stats().devices).toBe(1);
      expect(device.state).toBe("registered");
      now += 9_000;
      relay.heartbeatCheck();
      expect(relay.stats().devices).toBe(0); // 清扫同步生效
      device.close();
    } finally {
      relay.stop();
    }
  });
});

describe("BI-15.4 · ControllerClient（远程控制端）", () => {
  test("attach 未注册 deviceId → RelayRejectedError DEVICE_NOT_REGISTERED", async () => {
    const relay = startRelay();
    try {
      const controller = new ControllerClient();
      try {
        await controller.attach(relay.url, "no-such-device");
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(RelayRejectedError);
        expect((error as RelayRejectedError).code).toBe("DEVICE_NOT_REGISTERED");
      }
      expect(controller.state).toBe("disconnected");
    } finally {
      relay.stop();
    }
  });

  test("controller.send → device.onPayload 收到业务载荷（桥接下行）", async () => {
    const relay = startRelay();
    try {
      const device = new DeviceClient();
      await device.connect(relay.url, "d1");
      const controller = new ControllerClient();
      await controller.attach(relay.url, "d1");
      const got: RelayPayloadFrame[] = [];
      device.onPayload((f) => got.push(f));
      controller.send({ op: "query", n: 42 });
      await until(() => got.length >= 1, "device receives controller payload");
      expect(got[0]?.payload).toEqual({ op: "query", n: 42 });
      device.close();
      controller.close();
    } finally {
      relay.stop();
    }
  });

  test("device.sendToController → controller.onEvent 收到事件（桥接上行）", async () => {
    const relay = startRelay();
    try {
      const device = new DeviceClient();
      await device.connect(relay.url, "d1");
      const controller = new ControllerClient();
      await controller.attach(relay.url, "d1");
      const got: RelayPayloadFrame[] = [];
      controller.onEvent((f) => got.push(f));
      device.sendToController({ ev: "ready", pid: 7 });
      await until(() => got.length >= 1, "controller receives device event");
      expect(got[0]?.payload).toEqual({ ev: "ready", pid: 7 });
      device.close();
      controller.close();
    } finally {
      relay.stop();
    }
  });

  test("未 attach 时 send 抛错", () => {
    const controller = new ControllerClient();
    expect(() => controller.send({})).toThrow();
  });

  test("device 无 controller 时发载荷 → 中继瞬态错误经 onError 暴露（NOT_ATTACHED）", async () => {
    const relay = startRelay();
    try {
      const device = new DeviceClient();
      await device.connect(relay.url, "d-lonely");
      const errors: Array<{ code?: string; reason: string }> = [];
      device.onError((e) => errors.push(e));
      device.sendToController({ ping: true });
      await until(() => errors.length >= 1, "transient error surfaced");
      expect(errors[0]?.code).toBe("NOT_ATTACHED");
      expect(device.state).toBe("registered"); // 瞬态错误不断开
      device.close();
    } finally {
      relay.stop();
    }
  });

  test("E2E SignedEnvelope（controller→device）：经中继透传后 BI-15.3 五步验证通过且 payload 完整", async () => {
    const relay = startRelay();
    try {
      const device = new DeviceClient();
      await device.connect(relay.url, "d-e2e");
      const controller = new ControllerClient({ controllerId: "controller-1" });
      await controller.attach(relay.url, "d-e2e");

      const secret = a2aSecret("bi-15-4-e2e-shared-secret");
      const payload = { cmd: "pivot.query", args: { cube: "orders", dims: ["region"], limit: 3 } };
      const signed = signEnvelope(
        { from: "controller-1", to: "d-e2e", ts: Date.now(), nonce: crypto.randomUUID(), payload },
        secret,
      );

      const got: RelayPayloadFrame[] = [];
      device.onPayload((f) => got.push(f));
      controller.sendEnvelope(signed as unknown as Record<string, unknown>);
      await until(() => got.length >= 1, "envelope arrives at device");

      const envelope = got[0]?.envelope;
      expect(envelope).toBeDefined();
      const result = verifyEnvelope(envelope as unknown as SignedEnvelope, {
        secret,
        allowFrom: ["controller-1"],
        replayStore: new MemoryReplayStore(),
      });
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.envelope.from).toBe("controller-1");
        expect(result.envelope.to).toBe("d-e2e");
        expect(result.envelope.payload).toEqual(payload);
      }
      device.close();
      controller.close();
    } finally {
      relay.stop();
    }
  });

  test("E2E SignedEnvelope 反向（device→controller）：上行透传后验签通过", async () => {
    const relay = startRelay();
    try {
      const device = new DeviceClient();
      await device.connect(relay.url, "d-e2e");
      const controller = new ControllerClient();
      await controller.attach(relay.url, "d-e2e");

      const secret = a2aSecret("bi-15-4-e2e-shared-secret");
      const payload = { ev: "job.done", rows: 128, tags: ["报表", "出口退税"] };
      const signed = signEnvelope(
        { from: "d-e2e", to: "controller-remote", ts: Date.now(), nonce: crypto.randomUUID(), payload },
        secret,
      );

      const got: RelayPayloadFrame[] = [];
      controller.onEvent((f) => got.push(f));
      device.sendEnvelopeToController(signed as unknown as Record<string, unknown>);
      await until(() => got.length >= 1, "envelope arrives at controller");

      const result = verifyEnvelope(got[0]?.envelope as unknown as SignedEnvelope, {
        secret,
        allowFrom: ["d-e2e"],
        replayStore: new MemoryReplayStore(),
      });
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.envelope.payload).toEqual(payload);
      }
      device.close();
      controller.close();
    } finally {
      relay.stop();
    }
  });
});
