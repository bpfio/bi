/**
 * BI-06.5 · 三态授权门禁测试（纯内存，零 IO）。
 *
 * 钉死的语义裁定（与 permission-gate.ts 类注释一一对应）：
 * 1. 三态默认：manual → ask；yolo → allow（无标记）；auto → allow +
 *    reasonedDefault: true（devplan 原义“永不打断人类，全自动决策”，
 *    auto 若对未知操作 ask 即矛盾语义——本裁定为工单明文结论）。
 * 2. 模式权威源：gate.mode（构造注入 + setMode）唯一权威；
 *    PermissionRequest.mode 仅为快照，不参与决策（防请求自我提权）。
 * 3. 决策顺序：会话记忆 → 静态规则 → 三态默认（工单钉死）。
 */
import { describe, expect, test } from "bun:test";
import { PermissionGate, SessionApprovalStore, normalizeArgSummary } from "./permission-gate";
import type { PermissionRequest, PermissionRule } from "./types";

/** 可手动拨动的测试时钟。 */
function makeClock() {
  let now = 1_700_000_000_000;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const req = (tool: string, argSummary: string, mode: PermissionRequest["mode"] = "manual"): PermissionRequest => ({
  tool,
  argSummary,
  mode,
});

const rule = (
  tool: string,
  pattern: string,
  action: "allow" | "deny",
  scope: "always" | "session" = "always",
): PermissionRule => ({ tool, pattern, action, scope });

describe("BI-06.5 三态矩阵（无规则命中时的默认裁决）", () => {
  test("manual：未知操作 → ask（字段正交：无 matchedRule/remembered/reasonedDefault）", () => {
    const gate = new PermissionGate({ mode: "manual" });
    expect(gate.check(req("Bash", "curl example.com"))).toEqual({ decision: "ask" });
    const d = gate.check(req("Bash", "curl example.com"));
    expect(d.matchedRule).toBeUndefined();
    expect(d.remembered).toBeUndefined();
    expect(d.reasonedDefault).toBeUndefined();
  });

  test("yolo：未知操作 → allow，且不带 reasonedDefault（与 auto 放行相区分）", () => {
    const gate = new PermissionGate({ mode: "yolo" });
    expect(gate.check(req("Bash", "bun install"))).toEqual({ decision: "allow" });
    expect(gate.check(req("Bash", "bun install")).reasonedDefault).toBeUndefined();
  });

  test("auto：未知操作 → allow + reasonedDefault: true（BI-06.5 语义裁定，见文件头注释）", () => {
    const gate = new PermissionGate({ mode: "auto" });
    const decision = gate.check(req("Bash", "bun test"));
    expect(decision.decision).toBe("allow");
    expect(decision.reasonedDefault).toBe(true);
  });

  test("manual + allow 规则命中 → allow（规则优先于三态默认，不落 ask）", () => {
    const allow = rule("Bash", "git *", "allow");
    const gate = new PermissionGate({ rules: [allow], mode: "manual" });
    const decision = gate.check(req("Bash", "git status"));
    expect(decision.decision).toBe("allow");
    expect(decision.matchedRule).toBe(allow);
    expect(decision.reasonedDefault).toBeUndefined();
  });

  test("yolo + deny 规则命中 → deny（规则压过 yolo 自动放行）", () => {
    const deny = rule("Bash", "rm -rf *", "deny");
    const gate = new PermissionGate({ rules: [deny], mode: "yolo" });
    const decision = gate.check(req("Bash", "rm -rf build"));
    expect(decision.decision).toBe("deny");
    expect(decision.matchedRule).toBe(deny);
  });

  test("auto + deny 规则命中 → deny（规则压过 auto 全自动默认放行）", () => {
    const deny = rule("Bash", "rm -rf *", "deny");
    const gate = new PermissionGate({ rules: [deny], mode: "auto" });
    expect(gate.check(req("Bash", "rm -rf build")).decision).toBe("deny");
  });

  test("auto + allow 规则命中 → 带 matchedRule，不带 reasonedDefault（标记只属于默认放行）", () => {
    const allow = rule("Read", "*.ts", "allow");
    const gate = new PermissionGate({ rules: [allow], mode: "auto" });
    const decision = gate.check(req("Read", "a.ts"));
    expect(decision.decision).toBe("allow");
    expect(decision.matchedRule).toBe(allow);
    expect(decision.reasonedDefault).toBeUndefined();
  });
});

describe("BI-06.5 模式权威源裁定（req.mode 不参与决策）", () => {
  test("manual 门禁收到 req.mode='yolo' 的请求 → 仍 ask（请求快照不得自我提权）", () => {
    const gate = new PermissionGate({ mode: "manual" });
    expect(gate.check(req("Bash", "curl example.com", "yolo")).decision).toBe("ask");
  });

  test("manual 门禁收到 req.mode='auto' 的请求 → 仍 ask", () => {
    const gate = new PermissionGate({ mode: "manual" });
    expect(gate.check(req("Bash", "bun publish", "auto")).decision).toBe("ask");
  });

  test("yolo 门禁收到 req.mode='manual' 的请求 → 仍 allow（请求快照也不得自我收紧门禁态）", () => {
    const gate = new PermissionGate({ mode: "yolo" });
    expect(gate.check(req("Bash", "bun install", "manual")).decision).toBe("allow");
  });

  test("setMode 运行期切换：manual→ask、yolo→allow、auto→reasonedDefault", () => {
    const gate = new PermissionGate({ mode: "manual" });
    expect(gate.check(req("Bash", "make build")).decision).toBe("ask");
    gate.setMode("yolo");
    expect(gate.mode).toBe("yolo");
    expect(gate.check(req("Bash", "make build")).decision).toBe("allow");
    gate.setMode("auto");
    const decision = gate.check(req("Bash", "make build"));
    expect(decision.decision).toBe("allow");
    expect(decision.reasonedDefault).toBe(true);
  });

  test("缺省构造：mode=manual（最安全缺省）、rules 空表 → ask", () => {
    const gate = new PermissionGate();
    expect(gate.mode).toBe("manual");
    expect(gate.rules).toEqual([]);
    expect(gate.check(req("Bash", "anything")).decision).toBe("ask");
  });
});

describe("BI-06.5 会话记忆（remember → 后续 check 自动裁决）", () => {
  test("ask 后人工 remember allow → 同 tool 同参数串 check 命中 remembered", () => {
    const gate = new PermissionGate({ mode: "manual" });
    const ask = gate.check(req("Bash", "bun add zod"));
    expect(ask.decision).toBe("ask");
    gate.remember(req("Bash", "bun add zod"), "allow");
    const decision = gate.check(req("Bash", "bun add zod"));
    expect(decision.decision).toBe("allow");
    expect(decision.remembered).toBe(true);
  });

  test("记忆命中不带 matchedRule 与 reasonedDefault（字段正交）", () => {
    const gate = new PermissionGate({ rules: [rule("Bash", "*", "allow")], mode: "auto" });
    gate.remember(req("Bash", "bun add zod"), "allow");
    const decision = gate.check(req("Bash", "bun add zod"));
    expect(decision).toEqual({ decision: "allow", remembered: true });
  });

  test("不同参数串不命中记忆 → manual 下回退 ask", () => {
    const gate = new PermissionGate({ mode: "manual" });
    gate.remember(req("Bash", "git status"), "allow");
    expect(gate.check(req("Bash", "git push")).decision).toBe("ask");
  });

  test("不同 tool 不命中记忆（即使参数串相同）", () => {
    const gate = new PermissionGate({ mode: "manual" });
    gate.remember(req("Bash", "src/a.ts"), "allow");
    expect(gate.check(req("Write", "src/a.ts")).decision).toBe("ask");
  });

  test("参数串归一化相等即同键：./ 前缀、反斜杠、尾斜杠", () => {
    expect(normalizeArgSummary("./src/a.ts")).toBe("src/a.ts");
    expect(normalizeArgSummary("src\\a.ts")).toBe("src/a.ts");
    expect(normalizeArgSummary("src/a.ts/")).toBe("src/a.ts");
    const gate = new PermissionGate({ mode: "manual" });
    gate.remember(req("Read", "src/a.ts"), "allow");
    expect(gate.check(req("Read", "./src/a.ts")).remembered).toBe(true);
    expect(gate.check(req("Read", "src\\a.ts")).remembered).toBe(true);
    expect(gate.check(req("Read", "src/a.ts/")).remembered).toBe(true);
  });

  test("deny 记忆 → 后续同参 check 自动 deny（即便存在 allow 规则：记忆先于规则）", () => {
    const gate = new PermissionGate({
      rules: [rule("Bash", "git *", "allow")],
      mode: "manual",
    });
    gate.remember(req("Bash", "git push --force"), "deny");
    const decision = gate.check(req("Bash", "git push --force"));
    expect(decision.decision).toBe("deny");
    expect(decision.remembered).toBe(true);
  });

  test("deny 记忆 feedback 原样透传", () => {
    const gate = new PermissionGate({ mode: "manual" });
    const feedback = "用户拒绝：不要动 prod 环境，改用 staging";
    gate.remember(req("Bash", "kubectl delete pod x"), "deny", feedback);
    const decision = gate.check(req("Bash", "kubectl delete pod x"));
    expect(decision.decision).toBe("deny");
    expect(decision.remembered).toBe(true);
    expect(decision.feedback).toBe(feedback);
  });

  test("remember 工单签名形态：第三参为字符串时视为 feedback", () => {
    const gate = new PermissionGate({ mode: "manual" });
    gate.remember(req("Bash", "npm publish"), "deny", "禁止发包");
    expect(gate.check(req("Bash", "npm publish")).feedback).toBe("禁止发包");
  });

  test("同键重复 remember 覆盖：后写入的裁决生效", () => {
    const gate = new PermissionGate({ mode: "manual" });
    gate.remember(req("Bash", "bun add zod"), "deny", "先拒绝");
    gate.remember(req("Bash", "bun add zod"), "allow");
    const decision = gate.check(req("Bash", "bun add zod"));
    expect(decision.decision).toBe("allow");
    expect(decision.remembered).toBe(true);
    expect(decision.feedback).toBeUndefined();
  });

  test("记忆先于规则的顺序钉死：allow 记忆压过 deny 规则（工单矩阵顺序；缓解见 clearRemembered）", () => {
    // 工单矩阵第 1 步是会话记忆、第 2 步才是规则。用户对本条参数串的显式
    // 批准压过通用配置（对称地，“曾拒绝”也压过 blanket allow 规则）。
    // 已知边界：中途热更新新增 deny 规则可能被既有 allow 记忆压过，
    // 调用方应在规则热更新时调用 clearRemembered() 清空会话记忆。
    const gate = new PermissionGate({
      rules: [rule("Bash", "rm -rf *", "deny")],
      mode: "manual",
    });
    // 时刻 1：规则尚未生效前的 ask → 人工批准 → 记忆。
    gate.remember(req("Bash", "rm -rf build-cache"), "allow");
    // 时刻 2：deny 规则已存在，但同参 allow 记忆按工单顺序先命中。
    const decision = gate.check(req("Bash", "rm -rf build-cache"));
    expect(decision.decision).toBe("allow");
    expect(decision.remembered).toBe(true);
    // 缓解路径：清空记忆后 deny 规则立即生效。
    gate.clearRemembered();
    expect(gate.check(req("Bash", "rm -rf build-cache")).decision).toBe("deny");
  });

  test("clearRemembered 后回退三态默认（manual → ask）", () => {
    const gate = new PermissionGate({ mode: "manual" });
    gate.remember(req("Bash", "bun add zod"), "allow");
    expect(gate.rememberedCount).toBe(1);
    gate.clearRemembered();
    expect(gate.rememberedCount).toBe(0);
    expect(gate.check(req("Bash", "bun add zod")).decision).toBe("ask");
  });

  test("feedback 全链路：ask → 人工拒绝带反馈回灌 → 同参 deny+feedback，异参仍 ask", () => {
    const gate = new PermissionGate({ mode: "manual" });
    const ask = gate.check(req("Bash", "bun add left-pad"));
    expect(ask.decision).toBe("ask");
    gate.remember(req("Bash", "bun add left-pad"), "deny", "用 zod 替代 left-pad，不要引入废弃包");
    const denied = gate.check(req("Bash", "bun add left-pad"));
    expect(denied.decision).toBe("deny");
    expect(denied.feedback).toBe("用 zod 替代 left-pad，不要引入废弃包");
    // 不同参数串是全新请求：记忆不扩大化，仍按三态询问。
    expect(gate.check(req("Bash", "bun add zod")).decision).toBe("ask");
  });
});

describe("BI-06.5 会话记忆 TTL（注入时钟）", () => {
  test("ttlMs 内命中 remembered；过期后回退 ask 且记忆条目惰性清除", () => {
    const clock = makeClock();
    const gate = new PermissionGate({ mode: "manual", now: clock.now });
    gate.remember(req("Bash", "bun add zod"), "allow", { ttlMs: 1000 });
    clock.advance(500);
    expect(gate.check(req("Bash", "bun add zod")).remembered).toBe(true);
    clock.advance(600); // 累计 1100ms > ttl 1000ms（expiresAt <= now 判过期）
    const decision = gate.check(req("Bash", "bun add zod"));
    expect(decision.decision).toBe("ask");
    expect(decision.remembered).toBeUndefined();
    expect(gate.rememberedCount).toBe(0); // 过期条目已惰性清除
  });

  test("默认无 TTL：时钟大幅前进仍命中（会话级记忆）", () => {
    const clock = makeClock();
    const gate = new PermissionGate({ mode: "manual", now: clock.now });
    gate.remember(req("Bash", "bun add zod"), "allow");
    clock.advance(365 * 24 * 3600 * 1000);
    expect(gate.check(req("Bash", "bun add zod")).remembered).toBe(true);
  });

  test("deny 记忆同样受 TTL 约束：过期后不再自动 deny", () => {
    const clock = makeClock();
    const gate = new PermissionGate({ mode: "manual", now: clock.now });
    gate.remember(req("Bash", "bun add left-pad"), "deny", { feedback: "废弃包", ttlMs: 3_600_000 });
    clock.advance(60_000);
    expect(gate.check(req("Bash", "bun add left-pad")).decision).toBe("deny");
    clock.advance(3_600_000);
    expect(gate.check(req("Bash", "bun add left-pad")).decision).toBe("ask");
  });

  test("TTL 过期回退三态：yolo 模式下过期 → allow 且无 remembered 标记", () => {
    const clock = makeClock();
    const gate = new PermissionGate({ mode: "yolo", now: clock.now });
    gate.remember(req("Bash", "bun add zod"), "allow", { ttlMs: 500 });
    clock.advance(501);
    const decision = gate.check(req("Bash", "bun add zod"));
    expect(decision.decision).toBe("allow");
    expect(decision.remembered).toBeUndefined();
    expect(decision.reasonedDefault).toBeUndefined();
  });
});

describe("BI-06.5 规则运行期变更与并发稳定性", () => {
  test("addRules 运行期生效：先 ask，追加 allow 规则后 allow", () => {
    const gate = new PermissionGate({ mode: "manual" });
    expect(gate.check(req("Read", "src/a.ts")).decision).toBe("ask");
    const allow = rule("Read", "src/*.ts", "allow");
    gate.addRules([allow]);
    const decision = gate.check(req("Read", "src/a.ts"));
    expect(decision.decision).toBe("allow");
    expect(decision.matchedRule).toBe(allow);
  });

  test("addRules 保持配置顺序：先加者优先（首中生效），后加的 deny 不回溯", () => {
    const gate = new PermissionGate({ mode: "manual" });
    const allow = rule("Bash", "git *", "allow");
    gate.addRules([allow]);
    gate.addRules([rule("Bash", "git *", "deny")]);
    expect(gate.check(req("Bash", "git push")).matchedRule).toBe(allow);
  });

  test("同步交错 addRules + setMode + check 序列结果确定（JS 单线程程序序一致）", () => {
    const gate = new PermissionGate({ mode: "manual" });
    const outcomes: string[] = [];
    for (let i = 0; i < 50; i++) {
      gate.setMode(i % 2 === 0 ? "manual" : "yolo");
      gate.addRules([rule(`Tool${i}`, "*", "allow")]);
      outcomes.push(gate.check(req(`Tool${i}`, "x")).decision);
      outcomes.push(gate.check(req(`Other${i}`, "y")).decision);
    }
    for (let i = 0; i < 50; i++) {
      expect(outcomes[i * 2]).toBe("allow"); // 当轮追加的专属规则命中，压过任意三态默认
      expect(outcomes[i * 2 + 1]).toBe(i % 2 === 0 ? "ask" : "allow"); // 未命中规则 → 三态默认
    }
  });

  test("构造注入规则表顺序即优先级：deny 在前拦截 allow 在后", () => {
    const deny = rule("Bash", "rm *", "deny");
    const allow = rule("Bash", "rm -rf *", "allow");
    const gate = new PermissionGate({ rules: [deny, allow], mode: "yolo" });
    expect(gate.check(req("Bash", "rm -rf build")).decision).toBe("deny");
    expect(gate.check(req("Bash", "rm -rf build")).matchedRule).toBe(deny);
  });
});

describe("BI-06.5 SessionApprovalStore（Map 实现，独立可注入时钟）", () => {
  test("record/lookup 键含工具名与归一化参数串", () => {
    const store = new SessionApprovalStore();
    store.record("Bash", "./src/a.ts", "allow");
    expect(store.lookup("Bash", "src/a.ts")?.decision).toBe("allow");
    expect(store.lookup("Bash", "src/b.ts")).toBeUndefined();
    expect(store.lookup("Write", "src/a.ts")).toBeUndefined();
  });

  test("TTL 过期返回 undefined 并惰性清除（expiresAt <= now 判过期）", () => {
    const clock = makeClock();
    const store = new SessionApprovalStore({ now: clock.now });
    store.record("Bash", "git status", "deny", { ttlMs: 100 });
    clock.advance(99);
    expect(store.lookup("Bash", "git status")).toBeDefined();
    clock.advance(1); // 恰好到达 expiresAt：判过期
    expect(store.lookup("Bash", "git status")).toBeUndefined();
    expect(store.size).toBe(0);
  });

  test("clear 清空全部；size 反映条目数", () => {
    const store = new SessionApprovalStore();
    store.record("Bash", "a", "allow");
    store.record("Bash", "b", "deny");
    store.record("Read", "a", "allow");
    expect(store.size).toBe(3);
    store.clear();
    expect(store.size).toBe(0);
    expect(store.lookup("Bash", "a")).toBeUndefined();
  });

  test("deny 条目携带 feedback 原文", () => {
    const store = new SessionApprovalStore();
    store.record("Bash", "npm publish", "deny", { feedback: "禁止自动发包" });
    expect(store.lookup("Bash", "npm publish")?.feedback).toBe("禁止自动发包");
  });
});
