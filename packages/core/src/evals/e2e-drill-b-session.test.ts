/**
 * BI-21 工位 H 域级演练 B —— 会话生命周期全链。
 *
 * 链路:SessionManager 建会话 → append(含工具配对) → fork → rewindTo →
 * undo(cut,FileHistoryParticipant 级联回滚) → transfer 导出/导入 →
 * 结构指纹一致;FileHistoryService restore 字节级回滚。
 *
 * 被测组件全部真实代码;注入仅限 I/O 边界(存储根目录/时钟/id 生成器/读文件)。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "../session/manager";
import {
	exportSanitized,
	importSanitized,
	structuralFingerprint,
} from "../session/transfer";
import { AgentConversationUndoService } from "../session/undo-service";
import {
	FileHistoryParticipant,
	UndoParticipantRegistry,
} from "../session/undo-participants";
import { FileHistoryService } from "../session/file-history";

const roots: string[] = [];

afterAll(async () => {
	while (roots.length > 0) {
		const dir = roots.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

async function injectRoot(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), `bi21-b-${prefix}-`));
	roots.push(dir);
	return dir;
}

describe("BI-21 域 B —— 会话生命周期", () => {
	test("B1 会话骨架:append 工具配对 → fork 前缀同构 → rewindTo 游标分支", async () => {
		const mgr = new SessionManager({ rootDir: await injectRoot("mgr") });
		const s = await mgr.createSession({ title: "政策审计会话", cwd: "/tmp/ws" });

		// append 链:user → assistant → tool_call → tool_result → user
		const e1 = await mgr.append(s.sessionId, null, { type: "user", payload: { text: "拉取 2026 前三季度公报" } });
		const e2 = await mgr.append(s.sessionId, e1.id, { type: "assistant", payload: { text: "执行抓取" } });
		const e3 = await mgr.append(s.sessionId, e2.id, {
			type: "tool_call",
			payload: { argv: ["web-fetch", "https://gongbao.example.gov.cn/2026-87.htm"] },
			toolCallId: "call-1",
			toolName: "web-fetch",
		});
		const e4 = await mgr.append(s.sessionId, e3.id, {
			type: "tool_result",
			payload: { text: "953680 亿元,同比增长 4.8%" },
			toolCallId: "call-1",
			toolName: "web-fetch",
		});
		const e5 = await mgr.append(s.sessionId, e4.id, { type: "user", payload: { text: "勾稽账簿核对" } });

		// seq 单调与根唯一
		expect(e1.seq).toBe(1);
		expect(e5.seq).toBe(5);
		await expect(mgr.append(s.sessionId, null, { type: "user", payload: null })).rejects.toThrow(/根条目/);

		// fork 从 tool_call 节点开分支:前缀整体拷贝,id/parentId 不变
		const fork = await mgr.fork(s.sessionId, e3.id, { title: "审计备线" });
		expect(fork.copied).toBe(3);
		const forkEntries = await mgr.entries(fork.sessionId);
		expect(forkEntries.map((e) => e.id)).toEqual([e1.id, e2.id, e3.id]);
		expect(forkEntries.map((e) => e.seq)).toEqual([1, 2, 3]);
		// 源会话不受影响
		expect((await mgr.entries(s.sessionId)).length).toBe(5);

		// 结构指纹:fork 前缀与源会话前 3 条同构(树形状+类型+工具骨架)
		const src = await mgr.entries(s.sessionId);
		expect(
			structuralFingerprint(forkEntries.map((e) => ({ id: e.id, parentId: e.parentId, type: e.type, toolName: e.toolName }))),
		).toBe(structuralFingerprint(src.slice(0, 3).map((e) => ({ id: e.id, parentId: e.parentId, type: e.type, toolName: e.toolName }))));

		// rewindTo:游标指向 e2,不物理删除;在其下追加开新分支
		const cursor = await mgr.rewindTo(s.sessionId, e2.id);
		expect(cursor.nextParentId).toBe(e2.id);
		expect(cursor.totalEntries).toBe(5);
		const alt = await mgr.append(s.sessionId, cursor.nextParentId, { type: "assistant", payload: { text: "改走双栏版面抽取" } });
		expect(alt.parentId).toBe(e2.id);
		// 活跃路径沿新分支:根 → e1 → e2 → alt;历史物理保留
		const active = await mgr.history(s.sessionId, alt.id);
		expect(active.map((e) => e.id)).toEqual([e1.id, e2.id, alt.id]);
		expect((await mgr.entries(s.sessionId)).length).toBe(6);
	}, 30_000);

	test("B2 undo(cut):切点计算 + 参与方级联 + 幂等短路", async () => {
		const mgr = new SessionManager({ rootDir: await injectRoot("undo") });
		const s = await mgr.createSession({ title: "撤销演练" });
		const u1 = await mgr.append(s.sessionId, null, { type: "user", payload: { text: "第一轮" } });
		const u2 = await mgr.append(s.sessionId, u1.id, { type: "user", payload: { text: "第二轮" } });
		const u3 = await mgr.append(s.sessionId, u2.id, { type: "user", payload: { text: "第三轮" } });

		const events: unknown[] = [];
		const registry = new UndoParticipantRegistry();
		registry.register({ id: "drill-observer", onContextUndone: (ev) => { events.push(ev); return Promise.resolve({ id: "drill-observer", restored: [], errors: [] }); } });

		const svc = new AgentConversationUndoService({ sessionManager: mgr, registry });
		const r = await svc.undo(s.sessionId, 2);
		expect(r.cut.undoneCount).toBe(2);
		expect(r.cut.cutEntryId).toBe(u1.id);
		expect(r.cursor?.nextParentId).toBe(u1.id);
		expect(r.participants).toHaveLength(1);
		const ev = events[0] as { undoneEntries: { id: string }[] };
		expect(ev.undoneEntries.map((e) => e.id)).toEqual([u2.id, u3.id]);

		// 幂等短路:不追加新轮次,重复撤销同一窗口 → noop,零广播
		const r2 = await svc.undo(s.sessionId, 2);
		expect(r2.noop).toBe(true);
		expect(r2.participants).toHaveLength(0);
		expect(events).toHaveLength(1);

		// 撤销后活跃路径只剩 u1;新追加挂在 u1 下,新轮次可被再次撤销
		const after = await mgr.append(s.sessionId, r.cursor!.nextParentId, { type: "user", payload: { text: "重来" } });
		expect((await mgr.history(s.sessionId, after.id)).map((e) => e.id)).toEqual([u1.id, after.id]);

		// 全撤到根:cutEntryId=null,cursor=null
		const svc2 = new AgentConversationUndoService({ sessionManager: mgr, registry: new UndoParticipantRegistry() });
		const r3 = await svc2.undo(s.sessionId, 99);
		expect(r3.cut.cutEntryId).toBeNull();
		expect(r3.cursor).toBeNull();
	}, 30_000);

	test("B3 file-history restore 字节级回滚 + undo 级联(真实落盘)", async () => {
		const workDir = await injectRoot("files");
		const target = join(workDir, "ledger.txt");
		await writeFile(target, "v1: 65000+25000=90000\n", "utf8");

		const fh = new FileHistoryService({
			blobRoot: await injectRoot("blobs"),
			rootDir: await injectRoot("fh-index"),
		});
		// 会话轮次先落,快照时间落在撤销窗口内(createdAt ≥ 首条撤销条目)
		const mgr = new SessionManager({ rootDir: await injectRoot("undo2") });
		const s = await mgr.createSession({ title: "级联撤销" });
		const a1 = await mgr.append(s.sessionId, null, { type: "user", payload: { text: "写入 v1/v2" } });

		await writeFile(target, "v1: 65000+25000=90000\n", "utf8");
		const snap1 = await fh.snapshotBefore(target, { sessionId: s.sessionId, turnId: "t1", phase: "edit" });
		expect(snap1.priorSha256).toBe(snap1.blobRef.sha256);

		await writeFile(target, "v2: 90050(注错账)\n", "utf8");
		const snap2 = await fh.snapshotBefore(target, { sessionId: s.sessionId, turnId: "t2", phase: "edit" });
		await writeFile(target, "v3: 损坏态\n", "utf8");

		// 字节级 restore:回到 v1,sha 与字节数逐位断言
		const restored = await fh.restore(snap1.id);
		expect(restored.afterSha256).toBe(snap1.priorSha256);
		expect(restored.byteSize).toBe(Buffer.byteLength("v1: 65000+25000=90000\n"));
		expect((await readFile(target, "utf8"))).toBe("v1: 65000+25000=90000\n");

		// undo 级联:FileHistoryParticipant 按窗口降序逐条 restore → 终态 = 最旧快照
		await writeFile(target, "v4: 又写坏了\n", "utf8");
		const a2 = await mgr.append(s.sessionId, a1.id, { type: "user", payload: { text: "写入 v4" } });
		const registry = new UndoParticipantRegistry();
		registry.register(new FileHistoryParticipant(fh));
		const svc = new AgentConversationUndoService({ sessionManager: mgr, registry, fileHistory: fh });
		const res = await svc.undo(s.sessionId, 2);
		expect(res.participants[0]!.id).toBe("file-history");
		expect(res.participants[0]!.restored.length).toBe(2);
		// 降序级联:先 v2 后 v1,终态即切点时刻(最旧快照 v1)
		expect(await readFile(target, "utf8")).toBe("v1: 65000+25000=90000\n");
		expect(res.cut.undoneCount).toBe(2);
		expect(res.cut.cutEntryId).toBeNull();
		void a2;
	}, 30_000);

	test("B4 transfer 导出/导入:脱敏归档 + 结构指纹跨实例一致", async () => {
		const rootA = await injectRoot("exp");
		const rootB = await injectRoot("imp");
		const mgrA = new SessionManager({ rootDir: rootA });
		const mgrB = new SessionManager({ rootDir: rootB });
		const s = await mgrA.createSession({ title: "迁移演练", cwd: "/tmp/ws-drill" });
		const e1 = await mgrA.append(s.sessionId, null, { type: "user", payload: { text: "读取 /tmp/ws-drill/ledger.txt 并核对 953680" } });
		const e2 = await mgrA.append(s.sessionId, e1.id, {
			type: "tool_call",
			payload: { argv: ["bash", "cat /tmp/ws-drill/ledger.txt"] },
			toolCallId: "c1",
			toolName: "bash",
		});

		const archive = await exportSanitized(mgrA, s.sessionId, { homeDir: "" });
		// 归档脱敏:workspaceRoot(=meta.cwd)下的绝对路径替换为占位符
		const serialized = JSON.stringify(archive);
		expect(serialized).not.toContain("/tmp/ws-drill");
		expect(serialized).toContain("redacted:path");
		expect(archive.meta.fingerprint).toBe(
			structuralFingerprint(archive.entries.map((e) => ({ id: e.id, parentId: e.parentId, type: e.type, toolName: e.toolName }))),
		);

		const imp = await importSanitized(archive, mgrB);
		// 结构指纹跨实例一致;id/时间戳重建
		expect(
			structuralFingerprint(imp.entries.map((e) => ({ id: e.id, parentId: e.parentId, type: e.type, toolName: e.toolName }))),
		).toBe(archive.meta.fingerprint);
		expect(imp.entries).toHaveLength(archive.entries.length);
		expect(imp.entries[0]!.id).not.toBe(e1.id);
		expect(imp.entries[1]!.toolName).toBe("bash");
		expect(imp.entries[1]!.toolCallId).toBe("c1");

		// 重复导入同 id → 结构化拒绝
		await expect(importSanitized(archive, mgrB)).rejects.toThrow(/已存在/);
	}, 30_000);
});
