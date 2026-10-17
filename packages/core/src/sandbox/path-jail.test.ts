import { describe, expect, test } from "bun:test";
import { normalizePath, PathJail } from "./path-jail";
import { scanShell } from "./shell-scan";

const HOME = "/home/alice";
const WS = "/home/alice/projects/bi";

function jail(extraProtected?: string[]): PathJail {
  return new PathJail({ home: HOME, workspaceRoot: WS, extraProtected });
}

// ---------------------------------------------------------------------------
// normalizePath
// ---------------------------------------------------------------------------

describe("normalizePath", () => {
  const opts = { home: HOME, workspaceRoot: WS };

  test("expands leading ~ to home", () => {
    expect(normalizePath("~/.ssh/id_rsa", opts)).toEqual({ ok: true, path: `${HOME}/.ssh/id_rsa` });
  });

  test("expands bare ~ to home", () => {
    expect(normalizePath("~", opts)).toEqual({ ok: true, path: HOME });
  });

  test("expands $HOME and ${HOME} conservatively and literally", () => {
    expect(normalizePath("$HOME/.aws/credentials", opts)).toEqual({
      ok: true,
      path: `${HOME}/.aws/credentials`,
    });
    expect(normalizePath("${HOME}/.kube/config", opts)).toEqual({
      ok: true,
      path: `${HOME}/.kube/config`,
    });
  });

  test("does not expand $HOME-prefixed names ($HOMEx stays unresolvable)", () => {
    expect(normalizePath("$HOMEx/data", opts)).toEqual({ ok: false, reason: "unresolvable-expansion" });
  });

  test("strips surrounding single and double quotes (spaces preserved)", () => {
    expect(normalizePath("'~/a b/c.txt'", opts)).toEqual({ ok: true, path: `${HOME}/a b/c.txt` });
    expect(normalizePath('"/etc/passwd"', opts)).toEqual({ ok: true, path: "/etc/passwd" });
  });

  test("strips residual quote characters inside the word", () => {
    expect(normalizePath("~/'.ssh'/id_rsa", opts)).toEqual({ ok: true, path: `${HOME}/.ssh/id_rsa` });
  });

  test("resolves relative paths against the workspace root", () => {
    expect(normalizePath("src/main.ts", opts)).toEqual({ ok: true, path: `${WS}/src/main.ts` });
  });

  test("folds .. within the workspace", () => {
    expect(normalizePath("src/a/../b.ts", opts)).toEqual({ ok: true, path: `${WS}/src/b.ts` });
  });

  test("folds .. escapes above the workspace into absolute paths", () => {
    expect(normalizePath("../../../../etc/passwd", opts)).toEqual({ ok: true, path: "/etc/passwd" });
    expect(normalizePath("../sibling.txt", opts)).toEqual({
      ok: true,
      path: "/home/alice/projects/sibling.txt",
    });
  });

  test("folds ~ based .. escapes", () => {
    expect(normalizePath("~/../../etc/shadow", opts)).toEqual({ ok: true, path: "/etc/shadow" });
  });

  test("collapses duplicate slashes and dot segments", () => {
    expect(normalizePath("//a///b/./c/", opts)).toEqual({ ok: true, path: "/a/b/c" });
  });

  test("rejects other variables conservatively", () => {
    expect(normalizePath("$FOO/x", opts).ok).toBe(false);
    expect(normalizePath("$KEY", opts).ok).toBe(false);
  });

  test("rejects command substitution and backticks", () => {
    expect(normalizePath("$(pwd)/x", opts).ok).toBe(false);
    expect(normalizePath("`whoami`/x", opts).ok).toBe(false);
  });

  test("rejects ~user forms", () => {
    expect(normalizePath("~root/passwd", opts)).toEqual({ ok: false, reason: "unresolvable-tilde-user" });
  });

  test("rejects empty and quote-only inputs", () => {
    expect(normalizePath("", opts).ok).toBe(false);
    expect(normalizePath("''", opts).ok).toBe(false);
  });

  test("is idempotent on its own output", () => {
    for (const raw of ["~/a/../b", "../../etc", "src/./x.ts", "$HOME/.ssh"]) {
      const first = normalizePath(raw, opts);
      if (!first.ok) continue;
      const second = normalizePath(first.path, opts);
      expect(second).toEqual(first);
    }
  });
});

// ---------------------------------------------------------------------------
// PathJail.checkPath
// ---------------------------------------------------------------------------

describe("PathJail.checkPath", () => {
  test("blocks reads of every home-protected entry", () => {
    const j = jail();
    for (const p of [
      `${HOME}/.ssh/id_rsa`,
      `${HOME}/.gnupg/trustdb.gpg`,
      `${HOME}/.aws/credentials`,
      `${HOME}/.kube/config`,
      `${HOME}/.bash_history`,
      `${HOME}/.env`,
    ]) {
      const verdict = j.checkPath(p, "read");
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe("protected-home-path");
    }
  });

  test("blocks writes into home-protected directories too", () => {
    const verdict = jail().checkPath(`${HOME}/.ssh/authorized_keys`, "write");
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("protected-home-path");
  });

  test("blocks reads under /etc", () => {
    const verdict = jail().checkPath("/etc/passwd", "read");
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("protected-etc-read");
  });

  test("blocks writes under /etc as outside-workspace", () => {
    const verdict = jail().checkPath("/etc/passwd", "write");
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("outside-workspace");
  });

  test("allows reads and writes inside the workspace", () => {
    const j = jail();
    expect(j.checkPath(`${WS}/src/main.ts`, "read").allowed).toBe(true);
    expect(j.checkPath(`${WS}/out.log`, "write").allowed).toBe(true);
  });

  test("blocks workspace .env for both modes", () => {
    const j = jail();
    expect(j.checkPath(`${WS}/.env`, "read")).toMatchObject({ allowed: false, reason: "workspace-env" });
    expect(j.checkPath(`${WS}/.env`, "write")).toMatchObject({ allowed: false, reason: "workspace-env" });
  });

  test("workspace .env block is non-recursive by declaration", () => {
    expect(jail().checkPath(`${WS}/src/.env.local`, "read").allowed).toBe(true);
  });

  test("home reads outside the protected list are allowed; writes are not", () => {
    const j = jail();
    const p = `${HOME}/notes.txt`;
    expect(j.checkPath(p, "read").allowed).toBe(true);
    expect(j.checkPath(p, "write")).toMatchObject({ allowed: false, reason: "outside-workspace" });
  });

  test("credential basename matrix: blocked names", () => {
    const j = jail();
    for (const name of ["id_rsa", "id_ed25519", "server.pem", "credentials", "secret.txt", "secret"]) {
      const verdict = j.checkPath(`${WS}/${name}`, "read");
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe("credential-filename");
    }
  });

  test("credential basename matrix: allowed look-alikes", () => {
    const j = jail();
    for (const name of ["id_rsa.pub", "mysecrets.txt", "credentials.json", "*.ts"]) {
      expect(j.checkPath(`${WS}/${name}`, "read").allowed).toBe(true);
    }
  });

  test("wildcard words that may expand to credentials are blocked conservatively", () => {
    const j = jail();
    for (const name of ["*.pem", "id_rsa*", "se*", "*"]) {
      const verdict = j.checkPath(`${WS}/${name}`, "read");
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe("credential-filename");
    }
  });

  test("extraProtected entries are blocked in both modes", () => {
    const j = jail(["/srv/secrets"]);
    expect(j.checkPath("/srv/secrets/api-key", "read")).toMatchObject({
      allowed: false,
      reason: "extra-protected",
    });
    expect(j.checkPath("/srv/secrets/api-key", "write")).toMatchObject({
      allowed: false,
      reason: "extra-protected",
    });
  });

  test("unresolvable paths fail closed in both modes", () => {
    const j = jail();
    expect(j.checkPath("$KEY_FILE", "read")).toMatchObject({ allowed: false, reason: "unresolvable-path" });
    expect(j.checkPath("$(pick_target)", "write")).toMatchObject({
      allowed: false,
      reason: "unresolvable-path",
    });
  });

  test("constructor rejects empty home / workspaceRoot", () => {
    expect(() => new PathJail({ home: "", workspaceRoot: WS })).toThrow();
    expect(() => new PathJail({ home: HOME, workspaceRoot: "" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// PathJail.checkScan — BI-06.8 语句树上的策略
// ---------------------------------------------------------------------------

describe("PathJail.checkScan", () => {
  test("blocks cat ~/.ssh/id_rsa and localizes the violation", () => {
    const verdict = jail().checkScan(scanShell("cat ~/.ssh/id_rsa"));
    expect(verdict.allowed).toBe(false);
    expect(verdict.violations).toHaveLength(1);
    expect(verdict.violations[0]).toMatchObject({
      path: `${HOME}/.ssh/id_rsa`,
      mode: "read",
      reason: "protected-home-path",
      statement: "cat ~/.ssh/id_rsa",
    });
  });

  test("allows an innocent echo", () => {
    const verdict = jail().checkScan(scanShell("echo hello world"));
    expect(verdict.allowed).toBe(true);
    expect(verdict.violations).toEqual([]);
    expect(verdict.opaque).toBe(false);
  });

  test("blocks redirecting into /etc/passwd (write mode)", () => {
    const verdict = jail().checkScan(scanShell("echo pwned > /etc/passwd"));
    expect(verdict.allowed).toBe(false);
    expect(verdict.violations[0]).toMatchObject({
      path: "/etc/passwd",
      mode: "write",
      reason: "outside-workspace",
    });
  });

  test("allows workspace-relative redirect writes", () => {
    expect(jail().checkScan(scanShell("echo run > build.log")).allowed).toBe(true);
    expect(jail().checkScan(scanShell("echo run > ./out/put.txt")).allowed).toBe(true);
  });

  test("blocks workspace .. escape on write", () => {
    const verdict = jail().checkScan(scanShell("echo x > ../outside.txt"));
    expect(verdict.allowed).toBe(false);
    expect(verdict.violations[0]).toMatchObject({
      path: "/home/alice/projects/outside.txt",
      mode: "write",
      reason: "outside-workspace",
    });
  });

  test("expands $HOME in scanned words", () => {
    const verdict = jail().checkScan(scanShell("cat $HOME/.ssh/id_rsa"));
    expect(verdict.allowed).toBe(false);
    expect(verdict.violations[0]?.path).toBe(`${HOME}/.ssh/id_rsa`);
  });

  test("folds .. escapes in scanned words down to /etc reads", () => {
    const verdict = jail().checkScan(scanShell("cat ~/../../../etc/shadow"));
    expect(verdict.allowed).toBe(false);
    expect(verdict.violations[0]).toMatchObject({
      path: "/etc/shadow",
      mode: "read",
      reason: "protected-etc-read",
    });
  });

  test("flags credential read and outside write in one statement", () => {
    const verdict = jail().checkScan(scanShell("cp secret.txt /tmp/"));
    expect(verdict.allowed).toBe(false);
    const reasons = verdict.violations.map((v) => `${v.mode}:${v.reason}`).sort();
    expect(reasons).toEqual(["read:credential-filename", "write:outside-workspace"]);
  });

  test("localizes the violation to the offending statement in a list", () => {
    const verdict = jail().checkScan(scanShell("echo ok && cat ~/.aws/credentials"));
    expect(verdict.allowed).toBe(false);
    expect(verdict.violations).toHaveLength(1);
    expect(verdict.violations[0]).toMatchObject({
      path: `${HOME}/.aws/credentials`,
      mode: "read",
      reason: "protected-home-path",
      statement: "cat ~/.aws/credentials",
    });
  });

  test("read redirects (<) are judged as reads", () => {
    const verdict = jail().checkScan(scanShell("grep token < credentials"));
    expect(verdict.allowed).toBe(false);
    expect(verdict.violations[0]).toMatchObject({
      path: `${WS}/credentials`,
      mode: "read",
      reason: "credential-filename",
    });
  });

  test("fd-dup and fd-prefixed redirects behave sanely", () => {
    expect(jail().checkScan(scanShell("ls 2>&1")).allowed).toBe(true);
    expect(jail().checkScan(scanShell("make 2> build.log")).allowed).toBe(true);
    expect(jail().checkScan(scanShell("make 2> /etc/make.log")).allowed).toBe(false);
  });

  test("passes pure opaque through without double-judging its words", () => {
    const verdict = jail().checkScan(scanShell("eval 'echo hi'"));
    expect(verdict.opaque).toBe(true);
    expect(verdict.violations).toEqual([]);
    expect(verdict.allowed).toBe(true); // 路径维度无违规；整体拦下交给 assertSafe
  });

  test("redirect targets are not double-judged as argument reads", () => {
    const verdict = jail().checkScan(scanShell("echo pwned > /etc/passwd"));
    expect(verdict.violations).toHaveLength(1);
    expect(verdict.violations[0]).toMatchObject({ mode: "write", reason: "outside-workspace" });
  });

  test("write-destination heuristic: tee operands and cp destination are writes", () => {
    const tee = jail().checkScan(scanShell("sudo tee /etc/passwd < /dev/null"));
    expect(tee.allowed).toBe(false);
    expect(tee.violations[0]).toMatchObject({
      path: "/etc/passwd",
      mode: "write",
      reason: "outside-workspace",
    });
    expect(jail().checkScan(scanShell("cp src/main.ts ./backup/")).allowed).toBe(true);
    expect(jail().checkScan(scanShell("mv id_rsa.pub /tmp/")).allowed).toBe(false);
  });

  test("conservatively blocks unresolvable words (documented false positive)", () => {
    const verdict = jail().checkScan(scanShell("echo $(pwd)"));
    expect(verdict.allowed).toBe(false);
    expect(verdict.violations[0]).toMatchObject({ mode: "read", reason: "unresolvable-path" });
    expect(jail().checkScan(scanShell("cat $KEY")).allowed).toBe(false);
  });

  test("honors the workspaceRoot override in opts", () => {
    const j = new PathJail({ home: HOME, workspaceRoot: "/home/alice/a" });
    const scan = scanShell("echo x > file.txt");
    expect(j.checkScan(scan, { workspaceRoot: "/home/alice/b" }).allowed).toBe(true);
    const absolute = scanShell("echo x > /home/alice/b/file.txt");
    expect(j.checkScan(absolute).allowed).toBe(false);
    expect(j.checkScan(absolute, { workspaceRoot: "/home/alice/b" }).allowed).toBe(true);
  });

  test("accumulates violations across statements and dedupes identical ones", () => {
    const verdict = jail().checkScan(scanShell("cat ~/.ssh/id_rsa; cat ~/.ssh/id_rsa; echo x > /etc/passwd"));
    expect(verdict.allowed).toBe(false);
    expect(verdict.violations).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// PathJail.assertSafe — opaque-guard 组合
// ---------------------------------------------------------------------------

describe("PathJail.assertSafe", () => {
  test("allows a fully safe scan", () => {
    const verdict = jail().assertSafe(scanShell("ls -la | head -20"));
    expect(verdict.allowed).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  test("blocks on a path violation with a path: reason", () => {
    const verdict = jail().assertSafe(scanShell("cat ~/.ssh/id_rsa"));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.some((r) => r.includes("path:read:") && r.includes("protected-home-path"))).toBe(true);
  });

  test("blocks on opaque statements via the composed guard", () => {
    const verdict = jail().assertSafe(scanShell("eval 'echo hi'"));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join("; ")).toContain("dynamic-execution:eval");
  });

  test("blocks on dangerous statements via the composed guard", () => {
    const verdict = jail().assertSafe(scanShell("rm -rf /"));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join("; ")).toContain("dangerous:rm-recursive-force-root");
  });

  test("blocks a mixed list (benign + credential exfil)", () => {
    const verdict = jail().assertSafe(scanShell("echo fine; cat ~/.ssh/id_rsa > exfil.txt"));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join("; ")).toContain("protected-home-path");
  });
});
