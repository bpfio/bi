import { describe, expect, test } from "bun:test";
import { Inbox } from "./inbox";
import { RunCoordinator } from "./run-coordinator";

/** 排空微任务队列：setTimeout(0) 宏任务保证此前所有微任务（含门铃派发与 promise 回调）已完成。 */
const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("RunCoordinator（门铃式并发协调器）", () => {
  describe("相位机与提交流", () => {
    test("初始相位 idle", () => {
      const c = new RunCoordinator<string>();
      expect(c.phase()).toBe("idle");
    });

    test("idle 态 submit：相位保持 idle，门铃响一次（拉起新 run 的信号）", async () => {
      const c = new RunCoordinator<string>();
      let wakes = 0;
      c.onWake(() => {
        wakes += 1;
      });
      c.submitInput("任务");
      expect(c.phase()).toBe("idle"); // 协调器是状态机不自跑，运行环据铃拉起 run
      expect(c.inbox.sizes()).toEqual({ steers: 0, inputs: 1 });
      await flushMicrotasks();
      expect(wakes).toBe(1);
    });

    test("idle 态混合提交（steer+input 多次）合并为一次门铃", async () => {
      const c = new RunCoordinator<string>();
      let wakes = 0;
      c.onWake(() => {
        wakes += 1;
      });
      c.submitSteer("s1");
      c.submitInput("i1");
      c.submitSteer("s2");
      await flushMicrotasks();
      expect(wakes).toBe(1);
      expect(c.inbox.sizes()).toEqual({ steers: 2, inputs: 1 });
    });

    test("beginRun：idle → running，并关闭门铃闸门", () => {
      const c = new RunCoordinator<string>();
      c.beginRun();
      expect(c.phase()).toBe("running");
    });

    test("单飞铁律：running 态 beginRun 抛错，绝不重入派生第二个 run", () => {
      const c = new RunCoordinator<string>();
      c.beginRun();
      expect(() => c.beginRun()).toThrow(/单飞铁律违规/);
    });

    test("running 态 submit 静默入箱：不响门铃", async () => {
      const c = new RunCoordinator<string>();
      let wakes = 0;
      c.onWake(() => {
        wakes += 1;
      });
      c.beginRun();
      c.submitInput("i1");
      c.submitSteer("s1");
      c.submitInput("i2");
      await flushMicrotasks();
      expect(wakes).toBe(0);
      expect(c.phase()).toBe("running");
      expect(c.inbox.sizes()).toEqual({ steers: 1, inputs: 2 });
    });
  });

  describe("step boundary（只吐 steer）", () => {
    test("atStepBoundary 只返回 steer 列表，input 纹丝不动", () => {
      const c = new RunCoordinator<string>();
      c.beginRun();
      c.submitSteer("s1");
      c.submitInput("i1");
      c.submitSteer("s2");
      expect(c.atStepBoundary()).toEqual(["s1", "s2"]);
      expect(c.inbox.sizes()).toEqual({ steers: 0, inputs: 1 });
      expect(c.phase()).toBe("running"); // 相位不变
    });

    test("无 steer 时 step boundary 返回空数组", () => {
      const c = new RunCoordinator<string>();
      c.beginRun();
      c.submitInput("i1");
      expect(c.atStepBoundary()).toEqual([]);
      expect(c.inbox.hasInputs()).toBe(true);
    });

    test("协议违规：非 running 相位调用 atStepBoundary 抛错", () => {
      const c = new RunCoordinator<string>();
      expect(() => c.atStepBoundary()).toThrow(/协议违规/); // idle

      c.beginRun();
      c.submitInput("x");
      c.atIdleBoundary(); // 箱非空 → settling
      expect(() => c.atStepBoundary()).toThrow(/协议违规/); // settling
    });
  });

  describe("idle boundary（先 steer 后 input）", () => {
    test("收割残留 steer 与全部 input，两箱分列且顺序正确", () => {
      const c = new RunCoordinator<string>();
      c.beginRun();
      c.submitInput("i1");
      c.atStepBoundary(); // input 不动
      c.submitSteer("迟到纠偏");
      c.submitInput("i2");
      const harvest = c.atIdleBoundary();
      expect(harvest).toEqual({ steers: ["迟到纠偏"], inputs: ["i1", "i2"] });
      expect(c.inbox.sizes()).toEqual({ steers: 0, inputs: 0 });
    });

    test("箱空 → 相位转 idle 并 resolve awaitIdle / awaitSettlement", async () => {
      const c = new RunCoordinator<string>();
      c.beginRun();
      let idle = false;
      let settled = false;
      void c.awaitIdle().then(() => {
        idle = true;
      });
      void c.awaitSettlement().then(() => {
        settled = true;
      });
      const harvest = c.atIdleBoundary();
      expect(harvest).toEqual({ steers: [], inputs: [] });
      expect(c.phase()).toBe("idle");
      await flushMicrotasks();
      expect(idle).toBe(true);
      expect(settled).toBe(true);
    });

    test("箱非空 → 保持 settling（残留工作交还运行环），awaitIdle 不 resolve", async () => {
      const c = new RunCoordinator<string>();
      c.beginRun();
      c.submitInput("job");
      let idle = false;
      void c.awaitIdle().then(() => {
        idle = true;
      });
      const harvest = c.atIdleBoundary();
      expect(harvest).toEqual({ steers: [], inputs: ["job"] });
      expect(c.phase()).toBe("settling");
      await flushMicrotasks();
      expect(idle).toBe(false);
    });

    test("settling → beginRun 开启下一 run，收割项已交还（箱清空）", () => {
      const c = new RunCoordinator<string>();
      c.beginRun();
      c.submitSteer("s");
      const harvest = c.atIdleBoundary();
      expect(harvest.steers).toEqual(["s"]);
      expect(c.phase()).toBe("settling");
      c.beginRun();
      expect(c.phase()).toBe("running");
      expect(c.inbox.sizes()).toEqual({ steers: 0, inputs: 0 });
    });

    test("协议违规：非 running 相位调用 atIdleBoundary 抛错（含 settling 重复调用）", () => {
      const c = new RunCoordinator<string>();
      expect(() => c.atIdleBoundary()).toThrow(/协议违规/); // idle

      c.beginRun();
      c.submitInput("x");
      c.atIdleBoundary(); // settling
      expect(() => c.atIdleBoundary()).toThrow(/协议违规/); // settling 二次调用
    });
  });

  describe("settling 窗口与门铃（单飞保障）", () => {
    test("settling 态 push 响铃（门铃只在 idle/settling 触发）；beginRun 应答后陈旧铃不重入", async () => {
      const c = new RunCoordinator<string>();
      let wakes = 0;
      c.onWake(() => {
        wakes += 1;
      });
      c.beginRun();
      c.submitInput("x"); // running 静默
      const harvest = c.atIdleBoundary();
      expect(harvest.inputs).toEqual(["x"]);
      expect(c.phase()).toBe("settling");

      c.submitInput("y"); // settling 闸门开 → 响铃（同步置位）
      expect(wakes).toBe(0); // 微任务未到，同步不派发
      const pickup = c.beginRun(); // 运行环应答门铃、开启下一 run：拾取 settling 窗口的 push 作为本 run 工作
      await flushMicrotasks();
      expect(wakes).toBe(0); // 陈旧铃已被应答/闸门拦截：running 态绝不重入派发
      expect(c.phase()).toBe("running");
      expect(pickup.inputs).toEqual(["y"]);

      const harvest2 = c.atIdleBoundary();
      expect(harvest2).toEqual({ steers: [], inputs: [] }); // 拾取已交付 y，箱空 → idle
      expect(c.phase()).toBe("idle");
    });

    test("settle 后转 idle：新 submit 重新拉起（门铃新纪元 + 启动拾取交付触发工作）", async () => {
      const c = new RunCoordinator<string>();
      let wakes = 0;
      c.onWake(() => {
        wakes += 1;
      });
      // 第一轮：idle 提交 → 门铃 → 拉起 run（拾取触发工作）→ 箱空收尾 → idle
      c.submitInput("第一轮");
      await flushMicrotasks();
      expect(wakes).toBe(1);
      const pickup1 = c.beginRun();
      expect(pickup1).toEqual({ steers: [], inputs: ["第一轮"] });
      expect(c.phase()).toBe("running");
      expect(c.atIdleBoundary()).toEqual({ steers: [], inputs: [] });
      expect(c.phase()).toBe("idle");

      // settle 后转 idle：新 submit 重新拉起
      c.submitInput("第二轮");
      await flushMicrotasks();
      expect(wakes).toBe(2); // 门铃新纪元
      const pickup2 = c.beginRun();
      expect(pickup2.inputs).toEqual(["第二轮"]);
      expect(c.phase()).toBe("running");
      expect(c.atIdleBoundary()).toEqual({ steers: [], inputs: [] });
      expect(c.phase()).toBe("idle");
    });
  });

  describe("awaitSettlement / awaitIdle", () => {
    test("awaitSettlement：running 态挂起，atIdleBoundary 完成时 resolve（空箱案）", async () => {
      const c = new RunCoordinator<string>();
      c.beginRun();
      let settled = false;
      void c.awaitSettlement().then(() => {
        settled = true;
      });
      await flushMicrotasks();
      expect(settled).toBe(false); // run 未结束
      c.atIdleBoundary();
      await flushMicrotasks();
      expect(settled).toBe(true);
    });

    test("awaitSettlement：非空收割同样算结算完成（run 本体已收尾）", async () => {
      const c = new RunCoordinator<string>();
      c.beginRun();
      c.submitInput("job");
      let settled = false;
      void c.awaitSettlement().then(() => {
        settled = true;
      });
      c.atIdleBoundary(); // settling
      await flushMicrotasks();
      expect(settled).toBe(true);
      expect(c.phase()).toBe("settling");
    });

    test("awaitSettlement：idle 与 settling 态立即 resolve（无进行中的 run）", async () => {
      const c = new RunCoordinator<string>();
      await c.awaitSettlement(); // idle → 立即

      c.beginRun();
      c.submitInput("x");
      c.atIdleBoundary(); // settling
      await c.awaitSettlement(); // settling → 立即
      expect(true).toBe(true);
    });

    test("awaitSettlement 多 waiter 集合，重复调用安全", async () => {
      const c = new RunCoordinator<string>();
      c.beginRun();
      const order: string[] = [];
      void c.awaitSettlement().then(() => order.push("w1"));
      void c.awaitSettlement().then(() => order.push("w2"));
      void c.awaitSettlement().then(() => order.push("w3"));
      c.atIdleBoundary();
      await flushMicrotasks();
      expect(order).toEqual(["w1", "w2", "w3"]);
    });

    test("awaitIdle：idle 态立即 resolve", async () => {
      const c = new RunCoordinator<string>();
      await c.awaitIdle();
      expect(c.phase()).toBe("idle");
    });

    test("awaitIdle 多 waiter 跨越多个 run 周期，直到真正空闲全部 resolve", async () => {
      const c = new RunCoordinator<string>();
      c.beginRun();
      const order: string[] = [];
      void c.awaitIdle().then(() => order.push("w1"));
      void c.awaitIdle().then(() => order.push("w2"));
      void c.awaitIdle().then(() => order.push("w3"));

      c.submitInput("job");
      c.atIdleBoundary(); // 非空 → settling，waiter 挂起
      await flushMicrotasks();
      expect(order).toEqual([]);

      c.beginRun(); // 消费收割，开启下一 run
      c.atIdleBoundary(); // 箱空 → idle
      await flushMicrotasks();
      expect(order).toEqual(["w1", "w2", "w3"]);
      expect(c.phase()).toBe("idle");
    });
  });

  describe("全链路：双边界各吐各的", () => {
    test("idle → 门铃 → run（step boundary 吐 steer）→ idle boundary 吐残留与 input → idle", async () => {
      const c = new RunCoordinator<string>();
      let wakes = 0;
      c.onWake(() => {
        wakes += 1;
      });

      // 用户在 idle 提交常规输入 → 门铃
      c.submitInput("任务1");
      await flushMicrotasks();
      expect(wakes).toBe(1);

      // 运行环据铃拉起 run；启动拾取交付触发工作；running 态挂起 awaitIdle（等本轮工作彻底排空）
      const pickup = c.beginRun();
      expect(pickup).toEqual({ steers: [], inputs: ["任务1"] });
      let idle = false;
      void c.awaitIdle().then(() => {
        idle = true;
      });
      expect(idle).toBe(false);

      // 运行中用户纠偏 + 尝试插队
      c.submitSteer("纠偏1");
      c.submitSteer("纠偏2");
      c.submitInput("排队请求");
      const steers = c.atStepBoundary(); // 步 boundary 只吐 steer
      expect(steers).toEqual(["纠偏1", "纠偏2"]);
      expect(c.inbox.hasInputs()).toBe(true); // input 纹丝不动

      expect(c.atStepBoundary()).toEqual([]); // 又一步，无新 steer

      // run 结束：残留 steer + run 中途 input 由 idle boundary 收割（"任务1"已由启动拾取交付）
      c.submitSteer("迟到的纠偏");
      const harvest = c.atIdleBoundary();
      expect(harvest).toEqual({ steers: ["迟到的纠偏"], inputs: ["排队请求"] });
      expect(c.phase()).toBe("settling");

      // 以残留工作开启下一 run，无新工作则收尾转 idle
      c.beginRun();
      const harvest2 = c.atIdleBoundary();
      expect(harvest2).toEqual({ steers: [], inputs: [] });
      expect(c.phase()).toBe("idle");
      await flushMicrotasks();
      expect(idle).toBe(true);
    });

    test("多轮 drain 循环直到箱空才 idle（awaitIdle 贯穿全程）", async () => {
      const c = new RunCoordinator<string>();
      let idle = false;
      c.beginRun();
      void c.awaitIdle().then(() => {
        idle = true;
      });
      c.submitInput("a");
      c.submitInput("b");
      // 第一轮收割
      expect(c.atIdleBoundary().inputs).toEqual(["a", "b"]);
      expect(c.phase()).toBe("settling");
      // 第二轮收割
      c.beginRun();
      expect(c.atIdleBoundary().inputs).toEqual([]);
      expect(c.phase()).toBe("idle");
      await flushMicrotasks();
      expect(idle).toBe(true);
    });
  });

  describe("构造注入", () => {
    test("注入时钟转发至收件箱 enqueuedAt 打点", () => {
      let tick = 0;
      const c = new RunCoordinator<string>({ clock: () => ++tick });
      c.submitSteer("a"); // tick=1
      c.submitInput("b"); // tick=2
      expect(c.inbox.snapshot().map((item) => item.enqueuedAt)).toEqual([1, 2]);
    });

    test("注入外部收件箱被采用（同一实例）", () => {
      const inbox = new Inbox<string>();
      const c = new RunCoordinator<string>({ inbox });
      expect(c.inbox).toBe(inbox);
      c.submitInput("x");
      expect(inbox.sizes()).toEqual({ steers: 0, inputs: 1 });
    });

    test("onWake 委托收件箱门铃；注销后不再触发", async () => {
      const c = new RunCoordinator<string>();
      let wakes = 0;
      const un = c.onWake(() => {
        wakes += 1;
      });
      c.submitInput("x");
      await flushMicrotasks();
      expect(wakes).toBe(1);
      un();
      c.submitInput("y");
      await flushMicrotasks();
      expect(wakes).toBe(1);
    });
  });
});
