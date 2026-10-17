import { describe, expect, test } from "bun:test";
import { Inbox, type InboxItem, type WakeListener } from "./inbox";

/** 排空微任务队列：setTimeout(0) 宏任务保证此前所有微任务（含门铃派发）已完成。 */
const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("Inbox（双边界收件箱）", () => {
  describe("分箱与 FIFO", () => {
    test("steer/input 分箱：sizes/hasSteers/hasInputs 如实反映两箱", () => {
      const inbox = new Inbox<string>();
      expect(inbox.hasSteers()).toBe(false);
      expect(inbox.hasInputs()).toBe(false);
      expect(inbox.sizes()).toEqual({ steers: 0, inputs: 0 });

      inbox.push("steer", "s1");
      expect(inbox.hasSteers()).toBe(true);
      expect(inbox.hasInputs()).toBe(false);
      expect(inbox.sizes()).toEqual({ steers: 1, inputs: 0 });

      inbox.push("input", "i1");
      inbox.push("input", "i2");
      expect(inbox.sizes()).toEqual({ steers: 1, inputs: 2 });
    });

    test("takeSteers 保持 FIFO 入箱顺序", () => {
      const inbox = new Inbox<number>();
      for (const n of [1, 2, 3]) inbox.push("steer", n);
      expect(inbox.takeSteers()).toEqual([1, 2, 3]);
    });

    test("takeInputs 保持 FIFO 入箱顺序", () => {
      const inbox = new Inbox<number>();
      for (const n of [7, 8, 9]) inbox.push("input", n);
      expect(inbox.takeInputs()).toEqual([7, 8, 9]);
    });

    test("takeInputs(n) 取前 n 条且余量按序保留", () => {
      const inbox = new Inbox<number>();
      for (const n of [1, 2, 3, 4, 5]) inbox.push("input", n);
      expect(inbox.takeInputs(2)).toEqual([1, 2]);
      expect(inbox.sizes()).toEqual({ steers: 0, inputs: 3 });
      expect(inbox.takeInputs()).toEqual([3, 4, 5]);
    });

    test("takeInputs 边界：n=0 返回空；n 超量取全部", () => {
      const inbox = new Inbox<number>();
      inbox.push("input", 1);
      expect(inbox.takeInputs(0)).toEqual([]);
      expect(inbox.sizes()).toEqual({ steers: 0, inputs: 1 });
      expect(inbox.takeInputs(99)).toEqual([1]);
      expect(inbox.sizes()).toEqual({ steers: 0, inputs: 0 });
    });

    test("takeSteers 清空性：二次调用返回空且 hasSteers 归假", () => {
      const inbox = new Inbox<string>();
      inbox.push("steer", "a");
      expect(inbox.takeSteers()).toEqual(["a"]);
      expect(inbox.takeSteers()).toEqual([]);
      expect(inbox.hasSteers()).toBe(false);
    });

    test("takeInputs 清空性：全量取后二次调用返回空", () => {
      const inbox = new Inbox<string>();
      inbox.push("input", "x");
      expect(inbox.takeInputs()).toEqual(["x"]);
      expect(inbox.takeInputs()).toEqual([]);
      expect(inbox.hasInputs()).toBe(false);
    });

    test("两箱隔离：takeSteers 绝不动 input；takeInputs 绝不动 steer", () => {
      const inbox = new Inbox<string>();
      inbox.push("steer", "s1");
      inbox.push("input", "i1");
      inbox.push("steer", "s2");
      inbox.push("input", "i2");

      expect(inbox.takeSteers()).toEqual(["s1", "s2"]);
      expect(inbox.sizes()).toEqual({ steers: 0, inputs: 2 });
      expect(inbox.takeInputs()).toEqual(["i1", "i2"]);
      expect(inbox.sizes()).toEqual({ steers: 0, inputs: 0 });
    });

    test("push 非法 kind 抛 TypeError", () => {
      const inbox = new Inbox<string>();
      // @ts-expect-error 运行时防线：绕过类型系统传入非法 kind
      expect(() => inbox.push("bogus", "x")).toThrow(TypeError);
    });
  });

  describe("enqueuedAt 与 snapshot", () => {
    test("注入时钟：enqueuedAt 按入箱瞬间时钟值打点", () => {
      let tick = 100;
      const clock = (): number => ++tick;
      const inbox = new Inbox<string>({ clock });
      inbox.push("steer", "a"); // 101
      inbox.push("input", "b"); // 102
      inbox.push("steer", "c"); // 103

      const snapshot = inbox.snapshot();
      expect(snapshot.map((item) => item.enqueuedAt)).toEqual([101, 103, 102]); // snapshot：先 steer 后 input
      expect(snapshot.map((item) => item.kind)).toEqual(["steer", "steer", "input"]);
      expect(snapshot.map((item) => item.payload)).toEqual(["a", "c", "b"]);
    });

    test("默认时钟 Date.now：enqueuedAt 落在 push 前后区间内", () => {
      const before = Date.now();
      const inbox = new Inbox<string>();
      inbox.push("input", "x");
      const after = Date.now();
      const snapshot: InboxItem<string>[] = inbox.snapshot();
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0]!.enqueuedAt).toBeGreaterThanOrEqual(before);
      expect(snapshot[0]!.enqueuedAt).toBeLessThanOrEqual(after);
    });

    test("snapshot 防御性拷贝：改写快照数组与条目外壳不影响箱内结构（payload 为共享引用，与 take* 一致）", () => {
      const inbox = new Inbox<{ v: number }>();
      inbox.push("input", { v: 1 });
      inbox.push("input", { v: 2 });
      const snapshot = inbox.snapshot();
      snapshot.pop();
      snapshot[0]!.kind = "steer";
      expect(inbox.snapshot()).toHaveLength(2);
      expect(inbox.snapshot()[0]!.kind).toBe("input");
      expect(inbox.sizes()).toEqual({ steers: 0, inputs: 2 });
    });
  });

  describe("门铃（pendingWake）", () => {
    test("idle 态 push：同步不触发，微任务后恰好触发一次", async () => {
      const inbox = new Inbox<string>();
      let wakes = 0;
      inbox.onWake(() => {
        wakes += 1;
      });
      inbox.push("input", "a");
      expect(wakes).toBe(0); // 同步置位，微任务派发——消费方零轮询
      await flushMicrotasks();
      expect(wakes).toBe(1);
    });

    test("防惊群：同纪元多次 push 合并为一次 wake；派发后新 push 开启新纪元", async () => {
      const inbox = new Inbox<string>();
      let wakes = 0;
      inbox.onWake(() => {
        wakes += 1;
      });
      inbox.push("input", "a");
      inbox.push("input", "b");
      inbox.push("steer", "c");
      await flushMicrotasks();
      expect(wakes).toBe(1);

      inbox.push("input", "d");
      await flushMicrotasks();
      expect(wakes).toBe(2);
    });

    test("闸门关闭（running 态）push 静默：不置位、不派发", async () => {
      const inbox = new Inbox<string>();
      let wakes = 0;
      inbox.onWake(() => {
        wakes += 1;
      });
      inbox.closeWakeGate();
      inbox.push("input", "a");
      inbox.push("steer", "b");
      await flushMicrotasks();
      expect(wakes).toBe(0);
      expect(inbox.sizes()).toEqual({ steers: 1, inputs: 1 }); // 静默入箱
    });

    test("闸门重开后 push 恢复响铃", async () => {
      const inbox = new Inbox<string>();
      let wakes = 0;
      inbox.onWake(() => {
        wakes += 1;
      });
      inbox.closeWakeGate();
      inbox.push("input", "a"); // 静默
      inbox.openWakeGate();
      inbox.push("input", "b"); // 响铃
      await flushMicrotasks();
      expect(wakes).toBe(1);
    });

    test("clearWake 取消未派发门铃；此后新 push 正常响铃", async () => {
      const inbox = new Inbox<string>();
      let wakes = 0;
      inbox.onWake(() => {
        wakes += 1;
      });
      inbox.push("input", "a");
      inbox.clearWake();
      await flushMicrotasks();
      expect(wakes).toBe(0);

      inbox.push("input", "b");
      await flushMicrotasks();
      expect(wakes).toBe(1);
    });

    test("多听众均收到同一次 wake；注销后不再收到", async () => {
      const inbox = new Inbox<string>();
      let a = 0;
      let b = 0;
      const unA = inbox.onWake(() => {
        a += 1;
      });
      inbox.onWake(() => {
        b += 1;
      });
      inbox.push("input", "x");
      await flushMicrotasks();
      expect(a).toBe(1);
      expect(b).toBe(1);

      unA();
      inbox.push("input", "y");
      await flushMicrotasks();
      expect(a).toBe(1); // 已注销
      expect(b).toBe(2);
    });

    test("重复注册同一听众去重：一次 wake 只回调一次", async () => {
      const inbox = new Inbox<string>();
      let wakes = 0;
      const listener: WakeListener = () => {
        wakes += 1;
      };
      inbox.onWake(listener);
      inbox.onWake(listener); // Set 去重
      inbox.push("input", "x");
      await flushMicrotasks();
      expect(wakes).toBe(1);
    });

    test("派发前注册的听众能赶上本次 wake（快照派发）", async () => {
      const inbox = new Inbox<string>();
      let wakes = 0;
      inbox.push("input", "x"); // 已调度微任务，尚未派发
      inbox.onWake(() => {
        wakes += 1;
      });
      await flushMicrotasks();
      expect(wakes).toBe(1);
    });

    test("无听众时 push 不报错（门铃可无人应答）", async () => {
      const inbox = new Inbox<string>();
      inbox.push("input", "x");
      await flushMicrotasks();
      expect(inbox.sizes()).toEqual({ steers: 0, inputs: 1 });
    });
  });
});
