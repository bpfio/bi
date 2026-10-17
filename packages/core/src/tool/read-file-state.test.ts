import { describe, expect, test } from "bun:test";
import { ReadFileStateMap, type FileStat } from "./read-file-state";

/** 注入用 stat 工厂：判定所需最小字段集。 */
function stat(mtimeMs: number, size: number): FileStat {
  return { mtimeMs, size };
}

describe("三态判定 assertCleanForWrite", () => {
	test("① 从未读过 → not-read 拒绝（Read-Before-Write 铁律）", () => {
		const map = new ReadFileStateMap();
		const verdict = map.assertCleanForWrite("/w/a.ts", stat(1, 10));
		expect(verdict).toEqual({ allowed: false, reason: "not-read" });
	});

	test("② 磁盘 mtime 与读取时不符 → externally-modified 拒绝", () => {
		const map = new ReadFileStateMap();
		map.recordRead("/w/a.ts", stat(100, 10));
		const verdict = map.assertCleanForWrite("/w/a.ts", stat(200, 10));
		expect(verdict).toEqual({ allowed: false, reason: "externally-modified" });
	});

	test("② 磁盘 size 与读取时不符（mtime 相同）→ externally-modified 拒绝", () => {
		const map = new ReadFileStateMap();
		map.recordRead("/w/a.ts", stat(100, 10));
		const verdict = map.assertCleanForWrite("/w/a.ts", stat(100, 99));
		expect(verdict).toEqual({ allowed: false, reason: "externally-modified" });
	});

	test("② 双字段同时被外部篡改 → externally-modified 拒绝", () => {
		const map = new ReadFileStateMap();
		map.recordRead("/w/a.ts", stat(100, 10));
		expect(map.assertCleanForWrite("/w/a.ts", stat(300, 42))).toEqual({
			allowed: false,
			reason: "externally-modified",
		});
	});

	test("③ 双字段全等 → allowed（严格相等，无浮点容差）", () => {
		const map = new ReadFileStateMap();
		map.recordRead("/w/a.ts", stat(100.5, 10));
		expect(map.assertCleanForWrite("/w/a.ts", stat(100.5, 10))).toEqual({ allowed: true });
	});

	test("mtime 相同 size 相同但为不同对象引用：仍按值全等放行", () => {
		const map = new ReadFileStateMap();
		const injected = stat(123, 7);
		map.recordRead("/w/a.ts", injected);
		expect(map.assertCleanForWrite("/w/a.ts", { mtimeMs: 123, size: 7 })).toEqual({
			allowed: true,
		});
	});
});

describe("基线维护 recordRead / noteEdited", () => {
	test("重复读取以最新一次为准（last-write-wins）", () => {
		const map = new ReadFileStateMap();
		map.recordRead("/w/a.ts", stat(100, 10));
		map.recordRead("/w/a.ts", stat(200, 12));
		// 新基线生效：与最新读取一致放行。
		expect(map.assertCleanForWrite("/w/a.ts", stat(200, 12))).toEqual({ allowed: true });
		// 与旧读取一致反而拒绝（磁盘已变）。
		expect(map.assertCleanForWrite("/w/a.ts", stat(100, 10))).toEqual({
			allowed: false,
			reason: "externally-modified",
		});
	});

	test("noteEdited 刷新基线：编辑后的 stat 成为新基准", () => {
		const map = new ReadFileStateMap();
		map.recordRead("/w/a.ts", stat(100, 10));
		// 自己写入后的磁盘态。
		map.noteEdited("/w/a.ts", stat(150, 20));
		expect(map.assertCleanForWrite("/w/a.ts", stat(150, 20))).toEqual({ allowed: true });
		expect(map.assertCleanForWrite("/w/a.ts", stat(100, 10))).toEqual({
			allowed: false,
			reason: "externally-modified",
		});
	});

	test("noteEdited 无需先 recordRead：编辑即认知（建立基线）", () => {
		const map = new ReadFileStateMap();
		map.noteEdited("/w/new.ts", stat(50, 3));
		expect(map.assertCleanForWrite("/w/new.ts", stat(50, 3))).toEqual({ allowed: true });
	});

	test("编辑后基线刷新也能挡住后续外部篡改", () => {
		const map = new ReadFileStateMap();
		map.recordRead("/w/a.ts", stat(100, 10));
		map.noteEdited("/w/a.ts", stat(150, 20));
		// 编辑之后磁盘又被外部改动。
		expect(map.assertCleanForWrite("/w/a.ts", stat(999, 20))).toEqual({
			allowed: false,
			reason: "externally-modified",
		});
	});
});

describe("路径键归一化", () => {
	test("相对/绝对写法指向同一物理文件：落在同一条目", () => {
		const map = new ReadFileStateMap();
		map.recordRead("./w/a.ts", stat(100, 10));
		expect(map.isKnown("w/a.ts")).toBe(true);
		expect(map.assertCleanForWrite("w/a.ts", stat(100, 10))).toEqual({ allowed: true });
	});

	test("不同路径互相独立", () => {
		const map = new ReadFileStateMap();
		map.recordRead("/w/a.ts", stat(100, 10));
		expect(map.assertCleanForWrite("/w/b.ts", stat(100, 10))).toEqual({
			allowed: false,
			reason: "not-read",
		});
	});
});

describe("并发 recordRead 时序", () => {
	test("同一拍内多次 recordRead：后调用者定基线（同步 last-write-wins）", () => {
		const map = new ReadFileStateMap();
		map.recordRead("/w/a.ts", stat(1, 1));
		map.recordRead("/w/a.ts", stat(2, 2));
		map.recordRead("/w/a.ts", stat(3, 3));
		expect(map.baselineOf("/w/a.ts")).toEqual({ mtimeMs: 3, size: 3 });
	});

	test("交错时序：每条路径各自独立，互不串扰", () => {
		const map = new ReadFileStateMap();
		map.recordRead("/w/a.ts", stat(1, 1));
		map.recordRead("/w/b.ts", stat(9, 9));
		map.recordRead("/w/a.ts", stat(2, 2));
		expect(map.baselineOf("/w/a.ts")).toEqual({ mtimeMs: 2, size: 2 });
		expect(map.baselineOf("/w/b.ts")).toEqual({ mtimeMs: 9, size: 9 });
	});
});

describe("snapshot / restoreForTests", () => {
	test("snapshot 导出全量基线；导出对象与内部状态脱钩", () => {
		const map = new ReadFileStateMap();
		map.recordRead("/w/a.ts", stat(100, 10));
		const snap = map.snapshot();
		expect(snap.size).toBe(1);
		// 改动导出物不影响内部状态。
		(snap as Map<string, FileStat>).set("/w/a.ts", stat(1, 1));
		expect(map.baselineOf("/w/a.ts")).toEqual({ mtimeMs: 100, size: 10 });
	});

	test("restoreForTests 整体替换状态（含清空多余条目）", () => {
		const map = new ReadFileStateMap();
		map.recordRead("/w/a.ts", stat(100, 10));
		map.recordRead("/w/b.ts", stat(200, 20));
		const donor = new ReadFileStateMap();
		donor.recordRead("/w/c.ts", stat(300, 30));
		map.restoreForTests(donor.snapshot());
		expect(map.isKnown("/w/a.ts")).toBe(false);
		expect(map.isKnown("/w/b.ts")).toBe(false);
		expect(map.assertCleanForWrite("/w/c.ts", stat(300, 30))).toEqual({ allowed: true });
	});

	test("restore 深拷贝：donor 后续变化不回流", () => {
		const map = new ReadFileStateMap();
		const donor = new ReadFileStateMap();
		donor.recordRead("/w/a.ts", stat(1, 1));
		map.restoreForTests(donor.snapshot());
		donor.recordRead("/w/a.ts", stat(2, 2));
		expect(map.baselineOf("/w/a.ts")).toEqual({ mtimeMs: 1, size: 1 });
	});
});

describe("只读观测与清理", () => {
	test("isKnown / baselineOf：未知路径 isKnown=false、baselineOf=undefined", () => {
		const map = new ReadFileStateMap();
		expect(map.isKnown("/w/ghost.ts")).toBe(false);
		expect(map.baselineOf("/w/ghost.ts")).toBeUndefined();
	});

	test("baselineOf 返回副本：改写返回值不影响内部基线", () => {
		const map = new ReadFileStateMap();
		map.recordRead("/w/a.ts", stat(100, 10));
		const seen = map.baselineOf("/w/a.ts")!;
		(seen as { mtimeMs: number }).mtimeMs = 1;
		expect(map.baselineOf("/w/a.ts")).toEqual({ mtimeMs: 100, size: 10 });
	});

	test("clear 清空全部基线，回到全 not-read 态", () => {
		const map = new ReadFileStateMap();
		map.recordRead("/w/a.ts", stat(100, 10));
		map.clear();
		expect(map.isKnown("/w/a.ts")).toBe(false);
		expect(map.assertCleanForWrite("/w/a.ts", stat(100, 10))).toEqual({
			allowed: false,
			reason: "not-read",
		});
	});
});

describe("全生命周期", () => {
	test("not-read → 读 → 放行 → 外部篡改 → 拒 → 重读 → 放行 → 自编辑 → 放行", () => {
		const map = new ReadFileStateMap();
		expect(map.assertCleanForWrite("/w/a.ts", stat(1, 10))).toEqual({
			allowed: false,
			reason: "not-read",
		});
		map.recordRead("/w/a.ts", stat(1, 10));
		expect(map.assertCleanForWrite("/w/a.ts", stat(1, 10))).toEqual({ allowed: true });
		// 外部进程改了文件。
		expect(map.assertCleanForWrite("/w/a.ts", stat(2, 11))).toEqual({
			allowed: false,
			reason: "externally-modified",
		});
		// 强制重读后恢复认知。
		map.recordRead("/w/a.ts", stat(2, 11));
		expect(map.assertCleanForWrite("/w/a.ts", stat(2, 11))).toEqual({ allowed: true });
		// 自己再编辑一次。
		map.noteEdited("/w/a.ts", stat(3, 12));
		expect(map.assertCleanForWrite("/w/a.ts", stat(3, 12))).toEqual({ allowed: true });
	});
});
