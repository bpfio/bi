/**
 * @bi/worktree 测试 —— BI-12.2 Tower 信件协议（tower-protocol）。
 *
 * 覆盖：JSON 落盘往返、append-only（只增不改）、注入时钟盖章、
 * seq 扫描续号、taskId 过滤、角色信箱隔离（他人来信模型）、排序。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TowerProtocol } from "../index";

let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "bi-tower-proto-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

describe("TowerProtocol · 落盘与 append-only", () => {
  test("post：JSON 往返字段完整，文件名 <seq>-<kind>.json，id 与 stem 一致", () => {
    const proto = new TowerProtocol({ towerRoot: makeTmp(), now: () => 1000 });
    const letter = proto.post({ from: "initiator", kind: "plan", taskId: "t1", body: "方案正文" });

    expect(letter.id).toBe("000001-plan");
    expect(letter.ts).toBe(1000);
    const file = join(proto.commsDir, "000001-plan.json");
    expect(existsSync(file)).toBe(true);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as typeof letter;
    expect(parsed).toEqual(letter);
  });

  test("seq 单调递增；既有信件永不被改写（append-only）", () => {
    const proto = new TowerProtocol({ towerRoot: makeTmp(), now: () => 1000 });
    const a = proto.post({ from: "initiator", kind: "plan", taskId: "t1", body: "a" });
    const b = proto.post({ from: "worker", kind: "finding", taskId: "t1", body: "b" });
    const c = proto.post({ from: "reviewer", kind: "review", taskId: "t1", body: "c", approved: true });

    expect(a.id).toBe("000001-plan");
    expect(b.id).toBe("000002-finding");
    expect(c.id).toBe("000003-review");
    expect(readdirSync(proto.commsDir)).toHaveLength(3);

    const snapshot = readFileSync(join(proto.commsDir, "000001-plan.json"), "utf8");
    proto.post({ from: "initiator", kind: "status", taskId: "*", body: "more" });
    expect(readFileSync(join(proto.commsDir, "000001-plan.json"), "utf8")).toBe(snapshot);
    expect(readdirSync(proto.commsDir)).toHaveLength(4);
  });

  test("注入时钟：ts 取注入值；时钟推进 → 信件 ts 递增", () => {
    let clock = 5000;
    const proto = new TowerProtocol({ towerRoot: makeTmp(), now: () => clock });
    const first = proto.post({ from: "initiator", kind: "status", taskId: "t1", body: "one" });
    clock = 6000;
    const second = proto.post({ from: "worker", kind: "finding", taskId: "t1", body: "two" });

    expect(first.ts).toBe(5000);
    expect(second.ts).toBe(6000);
    const listed = proto.list();
    expect(listed.map((letter) => letter.ts)).toEqual([5000, 6000]);
  });

  test("手工预置高序号文件 → 下一封续号不撞车（seq 扫描）", () => {
    const root = makeTmp();
    const proto = new TowerProtocol({ towerRoot: root, now: () => 1 });
    mkdirSync(join(root, ".tower", "comms"), { recursive: true });
    writeFileSync(
      join(root, ".tower", "comms", "000042-status.json"),
      JSON.stringify({ id: "000042-status", from: "initiator", kind: "status", taskId: "*", body: "legacy", ts: 0 }) + "\n",
    );

    const letter = proto.post({ from: "worker", kind: "finding", taskId: "t1", body: "next" });
    expect(letter.id).toBe("000043-finding");
  });

  test("comms 目录不存在时 list 为空、post 自动建目录", () => {
    const proto = new TowerProtocol({ towerRoot: makeTmp(), now: () => 1 });
    expect(proto.list()).toEqual([]);
    expect(existsSync(proto.commsDir)).toBe(false);
    proto.post({ from: "initiator", kind: "status", taskId: "*", body: "boot" });
    expect(existsSync(proto.commsDir)).toBe(true);
    expect(proto.list()).toHaveLength(1);
  });

  test("review 信的 approved 标记持久化往返", () => {
    const proto = new TowerProtocol({ towerRoot: makeTmp(), now: () => 7 });
    const approved = proto.post({ from: "reviewer", kind: "review", taskId: "t1", body: "通过", approved: true });
    const rejected = proto.post({ from: "reviewer", kind: "review", taskId: "t1", body: "驳回", approved: false });
    const listed = proto.list();
    expect(listed.find((letter) => letter.id === approved.id)?.approved).toBe(true);
    expect(listed.find((letter) => letter.id === rejected.id)?.approved).toBe(false);
  });

  test("损坏 JSON 文件跳过不阻断（容错读取）", () => {
    const root = makeTmp();
    const proto = new TowerProtocol({ towerRoot: root, now: () => 1 });
    proto.post({ from: "initiator", kind: "status", taskId: "t1", body: "ok" });
    writeFileSync(join(proto.commsDir, "000002-status.json"), "{corrupt", "utf8");

    const listed = proto.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.body).toBe("ok");
  });
});

describe("TowerProtocol · 信箱投递模型", () => {
  test("readFor：按 taskId 过滤", () => {
    const proto = new TowerProtocol({ towerRoot: makeTmp(), now: () => 1 });
    proto.post({ from: "initiator", kind: "plan", taskId: "t1", body: "p1" });
    proto.post({ from: "worker", kind: "finding", taskId: "t2", body: "f2" });
    expect(proto.readFor("t1").map((letter) => letter.body)).toEqual(["p1"]);
  });

  test("角色信箱隔离：worker 收不到自己的 finding，reviewer 收不到自己的 review", () => {
    const proto = new TowerProtocol({ towerRoot: makeTmp(), now: () => 1 });
    proto.post({ from: "initiator", kind: "plan", taskId: "t1", body: "plan" });
    proto.post({ from: "worker", kind: "finding", taskId: "t1", body: "finding" });
    proto.post({ from: "reviewer", kind: "review", taskId: "t1", body: "verdict", approved: true });

    const workerInbox = proto.readInbox("worker", "t1");
    expect(workerInbox.map((letter) => letter.body).sort()).toEqual(["plan", "verdict"]);
    const reviewerInbox = proto.readInbox("reviewer", "t1");
    expect(reviewerInbox.map((letter) => letter.body).sort()).toEqual(["finding", "plan"]);
    const initiatorInbox = proto.readInbox("initiator", "t1");
    expect(initiatorInbox.map((letter) => letter.body).sort()).toEqual(["finding", "verdict"]);
  });

  test("readInbox 按 ts 升序（注入时钟时序）且广播信可见；taskId 过滤含广播", () => {
    let clock = 100;
    const proto = new TowerProtocol({ towerRoot: makeTmp(), now: () => (clock += 10) });
    proto.post({ from: "reviewer", kind: "review", taskId: "t2", body: "later", approved: true });
    proto.post({ from: "initiator", kind: "status", taskId: "*", body: "boot" });
    proto.post({ from: "reviewer", kind: "review", taskId: "t1", body: "early", approved: true });

    const inbox = proto.readInbox("worker");
    expect(inbox.map((letter) => letter.body)).toEqual(["later", "boot", "early"]);
    const filtered = proto.readInbox("worker", "t1");
    expect(filtered.map((letter) => letter.body)).toEqual(["boot", "early"]);
  });
});
