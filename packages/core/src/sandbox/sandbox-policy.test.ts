/**
 * BI-06.10 — sandbox-policy 三后端参数生成测试。
 * 全部纯函数级：无进程、无内核依赖，机器相关路径（tmpdir/home）两侧一致构造。
 */

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import {
  SandboxPolicyError,
  bwrapProfile,
  landlockProfile,
  landlockProfileArgs,
  seatbeltProfile,
  type SandboxPathContext,
  type SandboxPolicy,
} from "./sandbox-policy";

const CTX: SandboxPathContext = {
  workspaceRoot: "/home/yupeng/bi",
  homeDir: homedir(),
  tmpDir: tmpdir(),
};

const RO: SandboxPolicy = { mode: "readonly" };
const RW: SandboxPolicy = { mode: "workspace-write" };

describe("landlockProfile", () => {
  test("readonly：只读 / 无任何写路径", () => {
    const p = landlockProfile(RO, CTX);
    expect(p.readOnly).toEqual(["/"]);
    expect(p.readWrite).toEqual([]);
  });

  test("workspace-write：写路径含 workspace 与 tmpdir", () => {
    const p = landlockProfile(RW, CTX);
    expect(p.readOnly).toEqual(["/"]);
    expect(p.readWrite).toContain("/home/yupeng/bi");
    expect(p.readWrite).toContain(tmpdir());
  });

  test("extraWritePaths 追加且去重保序", () => {
    const p = landlockProfile(
      { mode: "workspace-write", extraWritePaths: ["/opt/data", "/opt/data", "/var/log"] },
      CTX,
    );
    expect(p.readWrite).toEqual(["/home/yupeng/bi", tmpdir(), "/opt/data", "/var/log"]);
  });

  test("extraReadOnly 记录进 extraReadOnlyRecorded（landlock no-op 声明）", () => {
    const p = landlockProfile(
      { mode: "workspace-write", extraReadOnly: ["/etc/ssl"], extraWritePaths: ["/etc/ssl"] },
      CTX,
    );
    expect(p.extraReadOnlyRecorded).toEqual(["/etc/ssl"]);
    // landlock 加法型 LSM：位于写集合内的 extraReadOnly 不影响 readWrite 列表
    expect(p.readWrite).toContain("/etc/ssl");
  });

  test("off：三列表全空", () => {
    const p = landlockProfile({ mode: "off" }, CTX);
    expect(p.readOnly).toEqual([]);
    expect(p.readWrite).toEqual([]);
    expect(p.extraReadOnlyRecorded).toEqual([]);
  });
});

describe("landlockProfileArgs", () => {
  test("返回单个 JSON 参数且含 handledMask 十六进制", () => {
    const args = landlockProfileArgs(RW, CTX, { handledMask: 0xffffn });
    expect(args).toHaveLength(1);
    const parsed = JSON.parse(args[0]!) as { mask: string; readOnly: string[]; readWrite: string[] };
    expect(parsed.mask).toBe("0xffff");
    expect(parsed.readOnly).toEqual(["/"]);
    expect(parsed.readWrite).toContain("/home/yupeng/bi");
  });

  test("缺省 handledMask 时 mask 为 null（loader 兜底路径）", () => {
    const parsed = JSON.parse(landlockProfileArgs(RW, CTX)[0]!) as { mask: string | null };
    expect(parsed.mask).toBeNull();
  });

  test("off → 空参数（os-sandbox 旁路）", () => {
    expect(landlockProfileArgs({ mode: "off" }, CTX)).toEqual([]);
  });

  test("JSON 序列化确定性（同输入同输出）", () => {
    const a = landlockProfileArgs(RW, CTX, { handledMask: 0x7fffn });
    const b = landlockProfileArgs(RW, CTX, { handledMask: 0x7fffn });
    expect(a[0]).toBe(b[0]);
  });
});

describe("seatbeltProfile", () => {
  test("readonly：deny default + 全量 file-read* + 无写授权", () => {
    const s = seatbeltProfile(RO, CTX);
    expect(s).toContain("(version 1)");
    expect(s).toContain("(deny default)");
    expect(s).toContain("(allow file-read*)");
    expect(s).not.toContain("file-write*");
  });

  test("workspace-write：对 workspace 与 tmp 授 subpath 写", () => {
    const s = seatbeltProfile(RW, CTX);
    expect(s).toContain(`(allow file-write* (subpath "/home/yupeng/bi") (subpath "${tmpdir()}"))`);
  });

  test("extraReadOnly 在 allow 之后以 deny 覆盖（SBPL 顺序语义）", () => {
    const s = seatbeltProfile(
      { mode: "workspace-write", extraWritePaths: ["/home/yupeng/bi/secret"], extraReadOnly: ["/home/yupeng/bi/secret"] },
      CTX,
    );
    const allowIdx = s.indexOf(`(allow file-write* (subpath "/home/yupeng/bi") (subpath "${tmpdir()}") (subpath "/home/yupeng/bi/secret"))`);
    const denyIdx = s.indexOf(`(deny file-write* (subpath "/home/yupeng/bi/secret"))`);
    expect(allowIdx).toBeGreaterThan(-1);
    expect(denyIdx).toBeGreaterThan(allowIdx);
  });

  test("off → 空串", () => {
    expect(seatbeltProfile({ mode: "off" }, CTX)).toBe("");
  });

  test("profile 字符串确定性", () => {
    expect(seatbeltProfile(RW, CTX)).toBe(seatbeltProfile(RW, CTX));
  });
});

describe("bwrapProfile", () => {
  test("readonly：只读根视图 + dev/proc，无任何可写挂载", () => {
    const args = bwrapProfile(RO, CTX);
    expect(args).toEqual([
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--die-with-parent",
      "--new-session",
    ]);
  });

  test("workspace-write：追加 --bind workspace 与 tmp", () => {
    const args = bwrapProfile(RW, CTX);
    expect(args.slice(0, 9)).toEqual(["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--die-with-parent", "--new-session"]);
    expect(args).toContain("--bind");
    expect(args.indexOf("--bind", args.indexOf("--bind") + 1)).toBeGreaterThan(-1);
    expect(args).toEqual([
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--proc", "/proc",
      "--die-with-parent",
      "--new-session",
      "--bind", "/home/yupeng/bi", "/home/yupeng/bi",
      "--bind", tmpdir(), tmpdir(),
    ]);
  });

  test("extraReadOnly 的 --ro-bind 追加在 --bind 之后（后挂载遮蔽）", () => {
    const args = bwrapProfile(
      { mode: "workspace-write", extraWritePaths: ["/home/yupeng/bi/sub"], extraReadOnly: ["/home/yupeng/bi/sub"] },
      CTX,
    );
    const bindIdx = args.indexOf("--bind");
    const roIdx = args.lastIndexOf("--ro-bind");
    expect(bindIdx).toBeGreaterThan(-1);
    expect(roIdx).toBeGreaterThan(bindIdx);
    expect(args.slice(-3)).toEqual(["--ro-bind", "/home/yupeng/bi/sub", "/home/yupeng/bi/sub"]);
  });

  test("off → 空参数", () => {
    expect(bwrapProfile({ mode: "off" }, CTX)).toEqual([]);
  });
});

describe("策略校验（fail-closed）", () => {
  test("无法解析的路径（非 HOME 变量展开）→ SandboxPolicyError", () => {
    expect(() => landlockProfile({ mode: "workspace-write", extraWritePaths: ["$XDG_DATA_HOME/x"] }, CTX)).toThrow(
      SandboxPolicyError,
    );
  });

  test("错误对象携带原始路径与归一化 reason", () => {
    try {
      bwrapProfile({ mode: "workspace-write", extraWritePaths: ["~user/x"] }, { workspaceRoot: "/home/yupeng/bi" });
      throw new Error("should-have-thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SandboxPolicyError);
      const err = e as SandboxPolicyError;
      expect(err.reason).toBe("unresolvable-tilde-user");
      expect(err.path).toBe("~user/x");
    }
  });

  test("空 workspaceRoot → workspace-root-required", () => {
    expect(() => landlockProfile(RW, { workspaceRoot: "" })).toThrow(SandboxPolicyError);
  });

  test("~ 与 $HOME 经 path-jail normalizePath 解析为 home 绝对路径", () => {
    const home = homedir();
    const p = landlockProfile({ mode: "workspace-write", extraWritePaths: ["~"] }, { workspaceRoot: "/home/yupeng/bi", homeDir: home });
    expect(p.readWrite).toContain(home);
  });
});

describe("三后端写路径一致性", () => {
  test("同一 policy/ctx 下三生成器授权同一写路径集合", () => {
    const policy: SandboxPolicy = {
      mode: "workspace-write",
      extraWritePaths: ["/opt/shared"],
      extraReadOnly: ["/home/yupeng/bi/dist"],
    };
    const ll = landlockProfile(policy, CTX);
    const bwrap = bwrapProfile(policy, CTX);
    const seatbelt = seatbeltProfile(policy, CTX);
    const writeSet = ["/home/yupeng/bi", tmpdir(), "/opt/shared"];
    for (const p of writeSet) {
      expect(ll.readWrite).toContain(p);
      expect(bwrap).toContain(p);
      expect(seatbelt).toContain(p);
    }
    // landlock 记录而不执行 extraReadOnly；另两后端有对应覆盖
    expect(ll.extraReadOnlyRecorded).toEqual(["/home/yupeng/bi/dist"]);
    expect(seatbelt).toContain('(deny file-write* (subpath "/home/yupeng/bi/dist"))');
    expect(bwrap.slice(-3)).toEqual(["--ro-bind", "/home/yupeng/bi/dist", "/home/yupeng/bi/dist"]);
  });
});
