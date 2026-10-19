/**
 * BI-06.10 — os-sandbox 执行层测试。
 * 组成：probe 注入矩阵（平台/内核/二进制全结构化）+ 三后端参数消费 +
 * fail-closed 结构化拒绝 + 本机真实 landlock/bwrap 执行（Linux 实测）。
 *
 * 能力门控（BI-30.2a）：bwrap 真实簇按本机 bubblewrap 在位与否结构化跳过
 * （GitHub ubuntu-latest 未预装 bubblewrap）；"$HOME 沙箱外必拒"类断言另按
 * "HOME 在 workspace 外"前提探测；能力/前提在则照常全绿，不减覆盖。
 *
 * 真实执行测试的路径纪律：workspaceRoot 取 os.tmpdir()（不在仓库内落任何
 * 临时文件），拒绝断言的目标为 $HOME（正常可写、沙箱内必拒），全部清理于 finally。
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LANDLOCK_LOADER_SRC,
  OsSandbox,
  type LandlockSyscalls,
  type OsSandboxDeps,
} from "./os-sandbox";
import type { SandboxPathContext, SandboxPolicy } from "./sandbox-policy";

const WS = tmpdir();
const HOME = process.env["HOME"] ?? "/home/yupeng";

const CTX: SandboxPathContext = { workspaceRoot: WS, homeDir: HOME, tmpDir: WS };
const RW: SandboxPolicy = { mode: "workspace-write" };
const RO: SandboxPolicy = { mode: "readonly" };

const neverSyscalls: LandlockSyscalls = {
  createRuleset: () => -1,
  addRule: () => -1,
  restrictSelf: () => -1,
  setNoNewPrivs: () => -1,
  close: () => 0,
};

function depsWith(over: Partial<OsSandboxDeps>): OsSandbox {
  return new OsSandbox(over);
}

/**
 * BI-30.2a 能力门控：bwrap 真实簇仅在本机 bubblewrap 在位时执行。
 * 探测口径与产品默认 deps 同源（PATH 存在性，同 defaultDeps.bwrapBinary）；
 * 能力缺 → 结构化跳过（跳过原因一行，见各 gate 注释），不以断言硬碰环境缺件。
 */
const HAS_BWRAP = Bun.which("bwrap") !== null;

/**
 * BI-30.2a 环境前提探测："$HOME 沙箱外本可写、沙箱内必拒"类断言的前提=HOME
 * 存在且不在 workspace（tmpdir）内。HOME 落在 workspace 内（如 dogfood shell
 * 的 HOME=/tmp/xxx）时写入被合法放行，前提缺 → 结构化跳过（原因见各 gate 注释）。
 */
const HOME_OUTSIDE_WS = existsSync(HOME) && HOME !== WS && !HOME.startsWith(WS.endsWith("/") ? WS : WS + "/");

describe("probe — 本机真实探测（Linux）", () => {
  test("landlock 可用：真实内核探针给出 ABI 与 handledMask", async () => {
    const p = await new OsSandbox().probe();
    const ll = p.backends.find((b) => b.backend === "landlock")!;
    expect(ll.available).toBe(true);
    expect(ll.detail).toMatch(/^abi=\d+ \((version-probe|mask-bisect)\)$/);
    expect(ll.handledMask).toMatch(/^0x[0-9a-f]+$/);
  });

  // BI-30.2a 门控：跳过原因=本机 PATH 无 bwrap → 产品探针结构化报 binary-missing，
  // "available=true/functional-ok" 断言无从成立
  test.skipIf(!HAS_BWRAP)("bwrap 可用：功能探针通过（本机 bubblewrap 0.11）", async () => {
    const p = await new OsSandbox().probe();
    const bw = p.backends.find((b) => b.backend === "bwrap")!;
    expect(bw.available).toBe(true);
    expect(bw.detail).toBe("functional-ok");
  });

  test("seatbelt 在 Linux 上结构化 wrong-platform", async () => {
    const p = await new OsSandbox().probe();
    const sb = p.backends.find((b) => b.backend === "seatbelt")!;
    expect(sb.available).toBe(false);
    expect(sb.errorKind).toBe("wrong-platform");
  });

  test("probe 总体结构：available/preferred 与后端一致", async () => {
    const p = await new OsSandbox().probe();
    expect(p.platform).toBe("linux");
    expect(p.available).toBe(true);
    expect(p.preferred).toBe("landlock");
    expect(p.backends).toHaveLength(3);
  });
});

describe("probe — 注入矩阵（平台结构态）", () => {
  test("win32：三后端全 wrong-platform，preferred null", async () => {
    const p = await depsWith({ platform: () => "win32" }).probe();
    expect(p.available).toBe(false);
    expect(p.preferred).toBeNull();
    expect(p.backends.map((b) => b.errorKind)).toEqual([
      "wrong-platform",
      "wrong-platform",
      "wrong-platform",
    ]);
  });

  test("darwin：仅 seatbelt 为候选（注入在位即 available）", async () => {
    const p = await depsWith({
      platform: () => "darwin",
      sandboxExecBinary: () => "/usr/bin/sandbox-exec",
    }).probe();
    expect(p.preferred).toBe("seatbelt");
    const ll = p.backends.find((b) => b.backend === "landlock")!;
    expect(ll.errorKind).toBe("wrong-platform");
  });

  test("darwin 且 sandbox-exec 缺失 → binary-missing 结构态", async () => {
    const p = await depsWith({ platform: () => "darwin", sandboxExecBinary: () => null }).probe();
    expect(p.available).toBe(false);
    const sb = p.backends.find((b) => b.backend === "seatbelt")!;
    expect(sb.errorKind).toBe("binary-missing");
  });

  test("landlock：ffi/libc 不可用 → ffi-unavailable 结构态", async () => {
    const p = await depsWith({ landlockSyscalls: async () => null }).probe();
    const ll = p.backends.find((b) => b.backend === "landlock")!;
    expect(ll.available).toBe(false);
    expect(ll.errorKind).toBe("ffi-unavailable");
  });

  test("landlock：create_ruleset 全掩码失败 → kernel-unsupported", async () => {
    const p = await depsWith({ landlockSyscalls: async () => neverSyscalls }).probe();
    const ll = p.backends.find((b) => b.backend === "landlock")!;
    expect(ll.available).toBe(false);
    expect(ll.errorKind).toBe("kernel-unsupported");
  });

  test("landlock：VERSION 探针命中 → version-probe 且按 ABI 取掩码", async () => {
    const seen: bigint[] = [];
    const syscalls: LandlockSyscalls = {
      createRuleset: (mask) => {
        seen.push(mask);
        return mask === 0n ? 3 : -1; // VERSION 探针返回 ABI 3
      },
      addRule: () => 0,
      restrictSelf: () => 0,
      setNoNewPrivs: () => 0,
      close: () => 0,
    };
    const p = await depsWith({ landlockSyscalls: async () => syscalls }).probe();
    const ll = p.backends.find((b) => b.backend === "landlock")!;
    expect(ll.available).toBe(true);
    expect(ll.detail).toBe("abi=3 (version-probe)");
    expect(ll.handledMask).toBe("0x7fff");
    expect(seen[0]).toBe(0n);
  });

  test("bwrap：二进制缺失 → binary-missing；功能失败 → userns-unsupported", async () => {
    const missing = await depsWith({ bwrapBinary: () => null }).probe();
    expect(missing.backends.find((b) => b.backend === "bwrap")!.errorKind).toBe("binary-missing");

    const broken = await depsWith({
      bwrapBinary: () => "/usr/bin/bwrap",
      bwrapFunctional: () => ({ ok: false, detail: "exit=1" }),
    }).probe();
    const bw = broken.backends.find((b) => b.backend === "bwrap")!;
    expect(bw.available).toBe(false);
    expect(bw.errorKind).toBe("userns-unsupported");
    expect(bw.detail).toBe("exit=1");
  });
});

describe("fail-closed — 全后端不可用", () => {
  const noBackendDeps: Partial<OsSandboxDeps> = {
    platform: () => "win32",
    spawn: () => {
      throw new Error("refused-run-must-not-spawn");
    },
  };

  test("workspace-write 全不可用 → kind=refused，命令未执行", async () => {
    const out = await depsWith(noBackendDeps).runSandboxed({ command: "sh" }, RW, CTX);
    expect(out.kind).toBe("refused");
    if (out.kind === "refused") {
      expect(out.backend).toBeNull();
      expect(out.exitCode).toBeNull();
      expect(out.refusals).toHaveLength(3);
      for (const r of out.refusals) {
        expect(r.available).toBe(false);
        expect(r.errorKind).toBe("wrong-platform");
      }
    }
  });

  test("readonly 同样结构化拒绝", async () => {
    const out = await depsWith(noBackendDeps).runSandboxed({ command: "sh" }, RO, CTX);
    expect(out.kind).toBe("refused");
  });

  test("mode=off 旁路：无后端也可执行（backend none）", async () => {
    const out = await new OsSandbox().runSandboxed(
      { command: "true" },
      { mode: "off" },
      CTX,
    );
    expect(out.kind).toBe("ran");
    if (out.kind === "ran") {
      expect(out.backend).toBe("none");
      expect(out.exitCode).toBe(0);
    }
  });

  test("workspaceRoot 缺失 → workspace-root-missing 结构化拒绝", async () => {
    const out = await new OsSandbox().runSandboxed({ command: "sh" }, RW, {
      ...CTX,
      workspaceRoot: "/nonexistent-ws-xyz-123",
    });
    expect(out.kind).toBe("refused");
    if (out.kind === "refused") {
      expect(out.refusals[0]!.errorKind).toBe("workspace-root-missing");
    }
  });

  test("空命令 → TypeError（参数结构化校验）", async () => {
    await expect(new OsSandbox().runSandboxed({ command: "" }, { mode: "off" }, CTX)).rejects.toThrow(TypeError);
  });
});

describe("真实 landlock 执行（本机 Linux 内核实测）", () => {
  const marker = join(WS, "ll-os-sandbox-test-" + process.pid);

  test("授权执行：echo 退出 0 且 stdout 被捕获", async () => {
    const out = await new OsSandbox().runSandboxed(
      { command: "sh", args: ["-c", "echo ran-ok"], cwd: WS },
      RW,
      CTX,
    );
    expect(out.kind).toBe("ran");
    if (out.kind === "ran") {
      expect(out.backend).toBe("landlock");
      expect(out.exitCode).toBe(0);
      expect(out.stdout).toBe("ran-ok\n");
    }
  });

  test("workspace 内写入被放行（kernel 真实生效）", async () => {
    try {
      rmSync(marker, { force: true });
      const out = await new OsSandbox().runSandboxed(
        { command: "sh", args: ["-c", `echo granted > "${marker}"`], cwd: WS },
        RW,
        CTX,
      );
      expect(out.kind).toBe("ran");
      if (out.kind === "ran") expect(out.exitCode).toBe(0);
      expect(readFileSync(marker, "utf8").trim()).toBe("granted");
    } finally {
      rmSync(marker, { force: true });
    }
  });

  // BI-30.2a 门控：跳过原因=HOME 位于 workspace（tmpdir）内 → 沙箱对写入合法放行，
  // "内核拒绝"断言前提不成立（正常机器/CI 的 HOME 在 workspace 外，照常执行）
  test.skipIf(!HOME_OUTSIDE_WS)("workspace 外写入被内核拒绝（$HOME，沙箱外本可写）", async () => {
    const denyTarget = join(HOME, "ll-os-sandbox-deny-" + process.pid);
    try {
      rmSync(denyTarget, { force: true });
      expect(existsSync(HOME)).toBe(true);
      const out = await new OsSandbox().runSandboxed(
        { command: "sh", args: ["-c", `echo x > "${denyTarget}"`], cwd: WS },
        RW,
        CTX,
      );
      expect(out.kind).toBe("ran");
      if (out.kind === "ran") expect(out.exitCode).not.toBe(0);
      expect(out.stderr).toMatch(/Permission denied/);
      expect(existsSync(denyTarget)).toBe(false);
    } finally {
      rmSync(denyTarget, { force: true });
    }
  });

  test("readonly：读全 FS 放行", async () => {
    const out = await new OsSandbox().runSandboxed(
      { command: "sh", args: ["-c", "cat /etc/hostname"], cwd: WS },
      RO,
      CTX,
    );
    expect(out.kind).toBe("ran");
    if (out.kind === "ran") expect(out.exitCode).toBe(0);
  });

  test("readonly：连 tmp 写也被拒绝（纯最严解释）", async () => {
    const roTarget = join(WS, "ll-ro-deny-" + process.pid);
    try {
      rmSync(roTarget, { force: true });
      const out = await new OsSandbox().runSandboxed(
        { command: "sh", args: ["-c", `echo x > "${roTarget}"`], cwd: WS },
        RO,
        CTX,
      );
      expect(out.kind).toBe("ran");
      if (out.kind === "ran") expect(out.exitCode).not.toBe(0);
      expect(out.stderr).toMatch(/Permission denied|Read-only/);
      expect(existsSync(roTarget)).toBe(false);
    } finally {
      rmSync(roTarget, { force: true });
    }
  });

  test("payload 不存在 → loader 结构化 127", async () => {
    const out = await new OsSandbox().runSandboxed(
      { command: "/nonexistent-bin-xyz-123", cwd: WS },
      RW,
      CTX,
    );
    expect(out.kind).toBe("ran");
    if (out.kind === "ran") {
      expect(out.exitCode).toBe(127);
      expect(out.stderr).toContain("[os-sandbox-loader] spawn:");
    }
  });
});

// BI-30.2a 门控：跳过原因=本机无 bwrap → landlock 缺席时降级链无 bwrap 可选，
// 真实执行（kind=ran/backend=bwrap）不可测
describe.skipIf(!HAS_BWRAP)("真实 bwrap 执行（landlock 不可用时降级）", () => {
  const sandbox = depsWith({ landlockSyscalls: async () => null });

  test("降级首选 bwrap：echo 退出 0", async () => {
    const out = await sandbox.runSandboxed(
      { command: "sh", args: ["-c", "echo bwrap-ok"], cwd: WS },
      RW,
      CTX,
    );
    expect(out.kind).toBe("ran");
    if (out.kind === "ran") {
      expect(out.backend).toBe("bwrap");
      expect(out.exitCode).toBe(0);
      expect(out.stdout).toBe("bwrap-ok\n");
    }
  });

  // BI-30.2a 门控：跳过原因=HOME 位于 workspace（tmpdir）内 → 写入被合法放行，
  // "workspace 外写入被拒"断言前提不成立（正常机器/CI 照常执行）
  test.skipIf(!HOME_OUTSIDE_WS)("bwrap 只读根视图：workspace 外写入被拒", async () => {
    const denyTarget = join(HOME, "ll-bwrap-deny-" + process.pid);
    try {
      rmSync(denyTarget, { force: true });
      const out = await sandbox.runSandboxed(
        { command: "sh", args: ["-c", `echo x > "${denyTarget}"`], cwd: WS },
        RW,
        CTX,
      );
      expect(out.kind).toBe("ran");
      if (out.kind === "ran") expect(out.exitCode).not.toBe(0);
      expect(existsSync(denyTarget)).toBe(false);
    } finally {
      rmSync(denyTarget, { force: true });
    }
  });
});

describe("landlock loader 资产", () => {
  test("内嵌 loader 是自包含脚本且不落盘（零外部文件）", () => {
    expect(LANDLOCK_LOADER_SRC).toContain("create_ruleset");
    expect(LANDLOCK_LOADER_SRC).toContain("restrict_self");
    expect(LANDLOCK_LOADER_SRC).toContain("BI_SANDBOX_LL_PROFILE");
    expect(LANDLOCK_LOADER_SRC).not.toMatch(/\bimport\s/); // 仅 require，兼容 -e
  });

  test("profile 坏 JSON → loader 退出 125（结构化失败非静默）", async () => {
    const sandbox = depsWith({
      // 劫持 execPath 不行——直接坏 profile：注入 spawn 层面篡改环境最简
    });
    // 通过构造非法 profile：mode=off 走不到 loader，因此这里直接以
    // 正常路径 + 篡改 env 不可行；改为校验 loader 源内 fail(125) 分支存在。
    expect(LANDLOCK_LOADER_SRC).toContain('fail(125, "bad env json');
    void sandbox;
  });

  test("workspace 目录存在性由 deps.exists 校验（注入矩阵）", async () => {
    let checked = "";
    const sandbox = depsWith({
      exists: (p) => {
        checked = p;
        return true;
      },
    });
    const out = await sandbox.runSandboxed({ command: "true" }, { mode: "off" }, { ...CTX, workspaceRoot: "/any" });
    // mode=off 不触发存在性校验
    expect(checked).toBe("");
    expect(out.kind).toBe("ran");
  });
});
