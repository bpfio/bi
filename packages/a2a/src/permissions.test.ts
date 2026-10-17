import { describe, expect, test } from "bun:test";
import {
  A2A_ROLES,
  CAPABILITIES,
  ROLE_CAPABILITIES,
  type A2aRole,
  assertCapability,
  capabilitiesOf,
  classifyHighRisk,
  type Capability,
  isA2aRole,
  isCapability,
} from "./permissions";

/** 期望矩阵（与工单卡设计逐一对应，测试独立手写而非引用实现，防实现自证）。 */
const EXPECTED_MATRIX: Record<A2aRole, ReadonlySet<Capability>> = {
  coordinator: new Set<Capability>(["read", "write", "execute", "network", "delegate"]),
  scout: new Set<Capability>(["read", "network"]),
  auditor: new Set<Capability>(["read", "execute"]),
  reporter: new Set<Capability>(["read", "write"]),
};

// ---------------------------------------------------------------------------
// 角色能力矩阵
// ---------------------------------------------------------------------------

describe("permissions: 角色能力矩阵（四角色 × 五能力）", () => {
  test("coordinator：全部能力放行", () => {
    for (const capability of CAPABILITIES) {
      expect(assertCapability("coordinator", capability)).toEqual({ ok: true });
    }
  });

  test("scout：read + network 放行；**禁写**，禁 execute，禁 delegate", () => {
    expect(assertCapability("scout", "read").ok).toBe(true);
    expect(assertCapability("scout", "network").ok).toBe(true);
    const denied = assertCapability("scout", "write");
    expect(denied).toEqual({ ok: false, reason: "denied-by-matrix" });
    expect(assertCapability("scout", "execute")).toEqual({ ok: false, reason: "denied-by-matrix" });
    expect(assertCapability("scout", "delegate")).toEqual({ ok: false, reason: "denied-by-matrix" });
  });

  test("auditor：read + execute 放行（execute 仅沙箱语义）；禁 network、禁 write、禁 delegate", () => {
    expect(assertCapability("auditor", "read").ok).toBe(true);
    expect(assertCapability("auditor", "execute").ok).toBe(true);
    expect(assertCapability("auditor", "network")).toEqual({ ok: false, reason: "denied-by-matrix" });
    expect(assertCapability("auditor", "write")).toEqual({ ok: false, reason: "denied-by-matrix" });
    expect(assertCapability("auditor", "delegate")).toEqual({ ok: false, reason: "denied-by-matrix" });
  });

  test("reporter：read + write 放行（写仅限交付产物目录，路径约束归上层）；禁 execute、禁 network、禁 delegate", () => {
    expect(assertCapability("reporter", "read").ok).toBe(true);
    expect(assertCapability("reporter", "write").ok).toBe(true);
    expect(assertCapability("reporter", "execute")).toEqual({ ok: false, reason: "denied-by-matrix" });
    expect(assertCapability("reporter", "network")).toEqual({ ok: false, reason: "denied-by-matrix" });
    expect(assertCapability("reporter", "delegate")).toEqual({ ok: false, reason: "denied-by-matrix" });
  });

  test("全表遍历：4 角色 × 5 能力每一格与期望矩阵一致（含 deny-by-default）", () => {
    expect(A2A_ROLES).toHaveLength(4);
    expect(CAPABILITIES).toHaveLength(5);
    for (const role of A2A_ROLES) {
      for (const capability of CAPABILITIES) {
        const granted = EXPECTED_MATRIX[role].has(capability);
        const verdict = assertCapability(role, capability);
        expect(verdict.ok).toBe(granted);
        if (!granted) expect(verdict).toEqual({ ok: false, reason: "denied-by-matrix" });
      }
    }
  });

  test("ROLE_CAPABILITIES 常量表与期望矩阵深度一致", () => {
    expect(ROLE_CAPABILITIES).toEqual(EXPECTED_MATRIX);
  });

  test("deny-by-default：未知角色 / 未知能力 / 大小写敏感均拒绝，reason 稳定", () => {
    expect(assertCapability("ghost", "read")).toEqual({ ok: false, reason: "unknown-role" });
    expect(assertCapability("scout", "teleport")).toEqual({ ok: false, reason: "unknown-capability" });
    expect(assertCapability("SCOUT", "read")).toEqual({ ok: false, reason: "unknown-role" });
    expect(assertCapability("", "read")).toEqual({ ok: false, reason: "unknown-role" });
    expect(assertCapability("", "")).toEqual({ ok: false, reason: "unknown-role" });
  });

  test("capabilitiesOf 投影：coordinator 5 项、scout 2 项、未知角色空数组", () => {
    expect(capabilitiesOf("coordinator")).toHaveLength(5);
    expect([...capabilitiesOf("scout")].sort()).toEqual(["network", "read"]);
    expect(capabilitiesOf("ghost")).toEqual([]);
  });

  test("isA2aRole / isCapability 守卫", () => {
    expect(isA2aRole("auditor")).toBe(true);
    expect(isA2aRole("auditor-x")).toBe(false);
    expect(isCapability("network")).toBe(true);
    expect(isCapability("Network")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 高危动作分类
// ---------------------------------------------------------------------------

describe("permissions: classifyHighRisk 高危分类", () => {
  test("修改代码类（code-edit / file-write / patch / write，大小写不敏感）→ code-modification", () => {
    expect(classifyHighRisk({ kind: "code-edit", target: "packages/a2a/src/auth.ts" })).toEqual({
      humanReview: true,
      reason: "code-modification",
    });
    expect(classifyHighRisk({ kind: "file-write", target: "report.md" }).reason).toBe("code-modification");
    expect(classifyHighRisk({ kind: "patch" }).humanReview).toBe(true);
    expect(classifyHighRisk({ kind: "Write" }).humanReview).toBe(true);
    expect(classifyHighRisk({ kind: "CODE-EDIT" }).reason).toBe("code-modification");
  });

  test("合并主分支：main / origin/master / refs/heads/trunk → merge-to-mainline；feature 分支不判", () => {
    expect(classifyHighRisk({ kind: "git-merge", target: "main" })).toEqual({
      humanReview: true,
      reason: "merge-to-mainline",
    });
    expect(classifyHighRisk({ kind: "git-push", target: "origin/master" }).humanReview).toBe(true);
    expect(classifyHighRisk({ kind: "merge", target: "refs/heads/trunk" }).reason).toBe("merge-to-mainline");
    expect(classifyHighRisk({ kind: "git-merge", target: "feature/bi-153" }).humanReview).toBe(false);
    expect(classifyHighRisk({ kind: "git-merge", target: "mainframe-docs" }).humanReview).toBe(false);
    expect(classifyHighRisk({ kind: "git-merge" }).humanReview).toBe(false);
  });

  test("rm / kill：kind 直接命中或壳命令特征命中 → destructive-command；良性命令不判", () => {
    expect(classifyHighRisk({ kind: "rm", target: "/" })).toEqual({
      humanReview: true,
      reason: "destructive-command",
    });
    expect(classifyHighRisk({ kind: "kill" }).humanReview).toBe(true);
    expect(classifyHighRisk({ kind: "shell", target: "rm -rf dist" })).toEqual({
      humanReview: true,
      reason: "destructive-command",
    });
    expect(classifyHighRisk({ kind: "shell", target: "kill -9 4242" }).reason).toBe("destructive-command");
    expect(classifyHighRisk({ kind: "bash", target: "sudo rm -rf /tmp/x" }).humanReview).toBe(true);
    expect(classifyHighRisk({ kind: "shell", target: "ls -la" }).humanReview).toBe(false);
    expect(classifyHighRisk({ kind: "shell", target: "bun test packages/a2a" }).humanReview).toBe(false);
    expect(classifyHighRisk({ kind: "shell", target: "echo confirm" }).humanReview).toBe(false);
  });

  test("凭据路径访问：.ssh / .env / credentials / .bi 配置与 credential 类 kind → credential-path-access", () => {
    expect(classifyHighRisk({ kind: "shell", target: "cat ~/.ssh/id_rsa" })).toEqual({
      humanReview: true,
      reason: "credential-path-access",
    });
    expect(classifyHighRisk({ kind: "read", target: ".env" }).reason).toBe("credential-path-access");
    expect(classifyHighRisk({ kind: "read", target: "apps/web/.env.local" }).humanReview).toBe(true);
    expect(classifyHighRisk({ kind: "read", target: "secrets/credentials.json" }).humanReview).toBe(true);
    expect(classifyHighRisk({ kind: "read", target: "/home/u/.bi/config.toml" }).humanReview).toBe(true);
    expect(classifyHighRisk({ kind: "credential-read" }).humanReview).toBe(true);
    // 非凭据路径不误伤
    expect(classifyHighRisk({ kind: "read", target: "packages/a2a/src/auth.ts" }).humanReview).toBe(false);
    expect(classifyHighRisk({ kind: "read", target: "src/report.md" }).humanReview).toBe(false);
  });

  test("良性动作与未知 kind → humanReview: false（风险门为增量叠加，不替代能力矩阵）", () => {
    expect(classifyHighRisk({ kind: "read", target: "README.md" })).toEqual({ humanReview: false });
    expect(classifyHighRisk({ kind: "list-files", target: "packages/a2a/src" })).toEqual({ humanReview: false });
    expect(classifyHighRisk({ kind: "blackboard-publish", target: "fact:yield-metrics" })).toEqual({
      humanReview: false,
    });
  });

  test("规则顺序固定：同 action 命中多条规则时取首个 reason（决策稳定可测）", () => {
    // 壳命令同时携带凭据路径与 rm：破坏性规则先于凭据规则
    const verdict = classifyHighRisk({ kind: "shell", target: "cat ~/.ssh/id_rsa && rm -rf /" });
    expect(verdict).toEqual({ humanReview: true, reason: "destructive-command" });
    expect(classifyHighRisk({ kind: "shell", target: "cat ~/.ssh/id_rsa" }).reason).toBe("credential-path-access");
  });

  test("幂等：同输入两次分类结果逐字节一致", () => {
    const action = { kind: "git-merge", target: "main" };
    expect(classifyHighRisk(action)).toEqual(classifyHighRisk(action));
  });
});
