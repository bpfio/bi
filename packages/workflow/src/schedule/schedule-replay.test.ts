/**
 * BI-07.14 持久化重放中枢测试 (schedule-replay)。
 *
 * 覆盖矩阵（注入时钟为主，:memory: SQLite）:
 * 1. createSchedule 记录形体 + 接缝①包封证据（TaskRecord{kind='schedule',
 *    state='completed' 桶位, checkpoint 载荷}）；
 * 2. tick: 未到期不触发、到期触发、游标推进、同一 now 不重复；
 * 3. 防重放轰炸: now 落后多周期只补发一轮，nextFireAt 直接推进至 > now；
 * 4. 一次性（after/at）到点 → completed 终态不再触发；at 过去时刻迟到补发；
 * 5. cron（defaultTz 注入东八区）触发与游标推进到下一命中；
 * 6. pause/resume（游标保留、错过期合并补发一轮、幂等、未知 id 结构化报错）；
 * 7. delete 幂等；
 * 8. 崩溃自愈: 创建 → "重启"（新实例接同一 store）→ tick 不重复不遗漏，
 *    completed 终态跨实例持久；
 * 9. MemoryDurableStore 同语义（DurableStore 接口解耦验证）。
 */
import { describe, expect, test } from 'bun:test';
import { MemoryDurableStore, SqliteDurableStore } from '../durable/storage';
import type { DurableStore } from '../durable/storage';
import { localWallToUtc } from './schedule-domain';
import { ScheduleError, ScheduleReplay, SCHEDULE_KIND } from './schedule-replay';
import type { ScheduleRecord } from './schedule-replay';

/** 测试基准时刻: 2026-01-15T00:00:00Z（恰为 60s 纪元对齐点）。 */
const BASE = Date.parse('2026-01-15T00:00:00Z');
const MIN = 60_000;
const SH = 'Asia/Shanghai';

/** 注入时钟（可手动拨动）。 */
function manualClock(start: number): { now: () => number; set: (t: number) => void } {
  let t = start;
  return { now: () => t, set: (v) => (t = v) };
}

const everyMinute = { kind: 'every' as const, intervalMs: MIN };

function sqliteStore(): SqliteDurableStore {
  return new SqliteDurableStore(':memory:');
}

/** nextFireAt 非空断言速记（测试可读性）。 */
function dueOf(record: ScheduleRecord): number {
  if (record.nextFireAt === null) throw new Error(`调度 ${record.id} 无 nextFireAt`);
  return record.nextFireAt;
}

describe('BI-07.14 createSchedule 记录形体与接缝①包封', () => {
  test('记录字段齐备且 nextFireAt 即时推算', () => {
    const clock = manualClock(BASE);
    const rp = new ScheduleReplay({ store: sqliteStore(), clock: clock.now });
    const rec = rp.createSchedule(everyMinute, { title: '每分钟' });
    expect(rec.id.startsWith('sch-')).toBe(true);
    expect(rec.state).toBe('active');
    expect(rec.title).toBe('每分钟');
    expect(rec.createdAt).toBe(BASE);
    expect(rec.deliveryCursor).toBe(BASE);
    expect(rec.firedCount).toBe(0);
    expect(rec.lastFiredAt).toBeUndefined();
    expect(rec.nextFireAt).toBe(BASE + MIN); // 纪元对齐（BASE 恰为对齐点）
  });

  test('接缝①: 经 DurableStore 以 TaskRecord 包封落库（kind=.schedule，桶位 completed）', () => {
    const store = sqliteStore();
    const rp = new ScheduleReplay({ store, clock: manualClock(BASE).now });
    const rec = rp.createSchedule(everyMinute);
    const task = store.get(rec.id);
    expect(task).not.toBeNull();
    expect(task?.kind).toBe(SCHEDULE_KIND);
    expect(task?.state).toBe('completed'); // 14.5 不可达的绝对终态桶
    expect(task?.attempts).toBe(0);
    const checkpoint = task?.checkpoint as { v?: unknown; scheduleState?: unknown };
    expect(checkpoint?.v).toBe(1);
    expect(checkpoint?.scheduleState).toBe('active');
  });

  test('listSchedules 往返保真（三原语混合）', () => {
    const rp = new ScheduleReplay({ store: sqliteStore(), clock: manualClock(BASE).now });
    const a = rp.createSchedule(everyMinute, { title: 'A' });
    const b = rp.createSchedule({ kind: 'daily', hh: 8, mm: 30, tz: SH }, { title: 'B' });
    const c = rp.createSchedule({ kind: 'at', isoLocal: '2026-01-20T09:00', tz: SH }, { title: 'C' });
    const list = rp.listSchedules();
    expect(list.length).toBe(3);
    expect(list.find((r) => r.id === a.id)).toEqual(a);
    expect(list.find((r) => r.id === b.id)).toEqual(b);
    expect(list.find((r) => r.id === c.id)).toEqual(c);
  });
});

describe('BI-07.14 tick 触发与游标推进', () => {
  test('未到期不触发', () => {
    const rp = new ScheduleReplay({ store: sqliteStore(), clock: manualClock(BASE).now });
    rp.createSchedule(everyMinute); // nextFireAt = BASE + MIN
    expect(rp.tick(BASE + 30_000)).toEqual([]);
  });

  test('到期触发一次 + 游标推进 + 同一 now 不重复', () => {
    const rp = new ScheduleReplay({ store: sqliteStore(), clock: manualClock(BASE).now });
    const rec = rp.createSchedule(everyMinute);
    const due = dueOf(rec);
    const fired = rp.tick(due);
    expect(fired.length).toBe(1);
    expect(fired[0]?.scheduleId).toBe(rec.id);
    expect(fired[0]?.firedAt).toBe(due);
    expect(fired[0]?.spec).toEqual(everyMinute);
    const after = rp.listSchedules().find((r) => r.id === rec.id);
    expect(after?.lastFiredAt).toBe(due);
    expect(after?.deliveryCursor).toBe(due);
    expect(after?.firedCount).toBe(1);
    expect(after?.nextFireAt).toBe(due + MIN);
    expect(rp.tick(due)).toEqual([]); // 游标已推进: 不重复
  });

  test('防重放轰炸: now 落后 10 个周期只补发一轮，nextFireAt 推进至 > now', () => {
    const rp = new ScheduleReplay({ store: sqliteStore(), clock: manualClock(BASE).now });
    const rec = rp.createSchedule(everyMinute);
    const far = BASE + 10 * MIN + 1234;
    const fired = rp.tick(far);
    expect(fired.length).toBe(1); // 落后 10 周期仍只补发一轮
    const after = rp.listSchedules().find((r) => r.id === rec.id);
    expect(after?.firedCount).toBe(1);
    expect(after?.nextFireAt).toBe((Math.floor(far / MIN) + 1) * MIN);
    expect(after?.nextFireAt as number).toBeGreaterThan(far);
  });

  test('混合到期只触发到期者，未到期者记录原样', () => {
    const rp = new ScheduleReplay({ store: sqliteStore(), clock: manualClock(BASE).now });
    const a = rp.createSchedule(everyMinute);
    const b = rp.createSchedule({ kind: 'after', delayMs: 10 * MIN });
    const fired = rp.tick(BASE + 5 * MIN);
    expect(fired.length).toBe(1);
    expect(fired[0]?.scheduleId).toBe(a.id);
    expect(rp.listSchedules().find((r) => r.id === b.id)?.nextFireAt).toBe(BASE + 10 * MIN);
  });

  test('tick 空仓库返回空数组', () => {
    const rp = new ScheduleReplay({ store: sqliteStore(), clock: manualClock(BASE).now });
    expect(rp.tick(BASE)).toEqual([]);
  });
});

describe('BI-07.14 一次性原语终态', () => {
  test('after: 到点触发 → completed 终态，不再触发', () => {
    const rp = new ScheduleReplay({ store: sqliteStore(), clock: manualClock(BASE).now });
    const rec = rp.createSchedule({ kind: 'after', delayMs: 5_000 });
    expect(rec.nextFireAt).toBe(BASE + 5_000);
    expect(rp.tick(BASE + 4_999)).toEqual([]);
    const fired = rp.tick(BASE + 5_000);
    expect(fired.length).toBe(1);
    const after = rp.listSchedules().find((r) => r.id === rec.id);
    expect(after?.state).toBe('completed');
    expect(after?.nextFireAt).toBeNull();
    expect(rp.tick(BASE + 6_000)).toEqual([]); // 终态不再触发
  });

  test('at: 东八区本地墙钟到点触发 → completed', () => {
    const rp = new ScheduleReplay({ store: sqliteStore(), clock: manualClock(BASE).now });
    const rec = rp.createSchedule({ kind: 'at', isoLocal: '2026-01-15T01:00:00', tz: SH });
    expect(rec.nextFireAt).toBe(Date.parse('2026-01-14T17:00:00Z'));
    expect(rp.tick(Date.parse('2026-01-14T16:59:59Z'))).toEqual([]);
    expect(rp.tick(Date.parse('2026-01-14T17:00:00Z')).length).toBe(1);
    expect(rp.listSchedules().find((r) => r.id === rec.id)?.state).toBe('completed');
  });

  test('at: 创建即已过期 → 首个 tick 迟到补发一轮后 completed', () => {
    const rp = new ScheduleReplay({ store: sqliteStore(), clock: manualClock(BASE).now });
    const rec = rp.createSchedule({ kind: 'at', isoLocal: '2020-01-01T00:00', tz: 'UTC' });
    expect(rec.nextFireAt).toBe(Date.parse('2020-01-01T00:00:00Z'));
    expect(rp.tick(BASE).length).toBe(1);
    const after = rp.listSchedules().find((r) => r.id === rec.id);
    expect(after?.state).toBe('completed');
    expect(after?.firedCount).toBe(1);
    expect(rp.tick(BASE + 1)).toEqual([]);
  });
});

describe('BI-07.14 cron 调度（defaultTz 注入）', () => {
  test('每日午夜（东八区）触发 + 游标推进到下一命中', () => {
    const rp = new ScheduleReplay({ store: sqliteStore(), clock: manualClock(BASE).now, defaultTz: SH });
    const rec = rp.createSchedule({ kind: 'cron', expr: '0 0 * * *' });
    // BASE = 00:00Z = 08:00 CST 01-15 → 下一本地午夜 = 01-16 00:00 CST
    expect(rec.nextFireAt).toBe(localWallToUtc(2026, 1, 16, 0, 0, SH));
    const due = dueOf(rec);
    const fired = rp.tick(due);
    expect(fired.length).toBe(1);
    const after = rp.listSchedules().find((r) => r.id === rec.id);
    expect(after?.nextFireAt).toBe(localWallToUtc(2026, 1, 17, 0, 0, SH));
    expect(rp.tick(due)).toEqual([]);
  });

  test('defaultTz 缺省 UTC', () => {
    const rp = new ScheduleReplay({ store: sqliteStore(), clock: manualClock(BASE).now });
    const rec = rp.createSchedule({ kind: 'cron', expr: '30 2 * * *' });
    expect(rec.nextFireAt).toBe(Date.parse('2026-01-15T02:30:00Z'));
  });
});

describe('BI-07.14 pause / resume / delete', () => {
  test('pause 停止触发且游标保留; resume 后错过期合并补发一轮', () => {
    const rp = new ScheduleReplay({ store: sqliteStore(), clock: manualClock(BASE).now });
    const rec = rp.createSchedule(everyMinute);
    const due = dueOf(rec);
    rp.pause(rec.id);
    expect(rp.listSchedules().find((r) => r.id === rec.id)?.state).toBe('paused');
    expect(rp.tick(due)).toEqual([]); // 暂停不触发
    rp.resume(rec.id);
    const fired = rp.tick(due); // 游标保留: 恢复后首个 tick 补发一轮
    expect(fired.length).toBe(1);
    expect(fired[0]?.scheduleId).toBe(rec.id);
  });

  test('pause/resume 幂等（重复调用与终态 no-op）', () => {
    const rp = new ScheduleReplay({ store: sqliteStore(), clock: manualClock(BASE).now });
    const rec = rp.createSchedule(everyMinute);
    rp.pause(rec.id);
    rp.pause(rec.id);
    expect(rp.listSchedules().find((r) => r.id === rec.id)?.state).toBe('paused');
    rp.resume(rec.id);
    rp.resume(rec.id);
    expect(rp.listSchedules().find((r) => r.id === rec.id)?.state).toBe('active');
    // completed 终态: pause/resume 幂等 no-op
    const once = rp.createSchedule({ kind: 'after', delayMs: 1_000 });
    rp.tick(BASE + 1_000);
    expect(() => rp.pause(once.id)).not.toThrow();
    expect(() => rp.resume(once.id)).not.toThrow();
    expect(rp.listSchedules().find((r) => r.id === once.id)?.state).toBe('completed');
  });

  test('pause/resume 未知 id 结构化报错（code=unknown-schedule）', () => {
    const rp = new ScheduleReplay({ store: sqliteStore(), clock: manualClock(BASE).now });
    expect(() => rp.pause('sch-none')).toThrow(ScheduleError);
    expect(() => rp.resume('sch-none')).toThrow(ScheduleError);
    try {
      rp.pause('sch-none');
      expect.unreachable();
    } catch (error) {
      expect((error as ScheduleError).code).toBe('unknown-schedule');
    }
  });

  test('delete 幂等: 删除后不触发、重复删除不抛错', () => {
    const rp = new ScheduleReplay({ store: sqliteStore(), clock: manualClock(BASE).now });
    const rec = rp.createSchedule(everyMinute);
    rp.delete(rec.id);
    expect(rp.listSchedules()).toEqual([]);
    expect(rp.tick(dueOf(rec))).toEqual([]);
    expect(() => rp.delete(rec.id)).not.toThrow();
    expect(() => rp.delete('sch-never-existed')).not.toThrow();
  });
});

describe('BI-07.14 崩溃自愈（同 store 重启）', () => {
  test('创建 → 重启（新实例接同 store）→ tick 不重复不遗漏', () => {
    const store = sqliteStore();
    const clock = manualClock(BASE);
    const i1 = new ScheduleReplay({ store, clock: clock.now });
    const every = i1.createSchedule(everyMinute, { title: 'A-每分钟' });
    const cron = i1.createSchedule({ kind: 'cron', expr: '30 2 * * *' }, { title: 'B-每日 02:30Z' });
    const once = i1.createSchedule({ kind: 'after', delayMs: 30_000 }, { title: 'C-一次性' });

    const crashAt = BASE + 3 * MIN; // A 到期（落后 3 周期）、C 到期、B 未到期
    const fired1 = i1.tick(crashAt);
    expect(fired1.map((f) => f.scheduleId).sort()).toEqual([every.id, once.id].sort());
    expect(fired1.filter((f) => f.scheduleId === every.id).length).toBe(1); // 防轰炸单轮

    // "重启": 全新实例接同一 store（权威态全在 store）
    const i2 = new ScheduleReplay({ store, clock: clock.now });
    expect(i2.tick(crashAt)).toEqual([]); // 游标已持久化: 不重复
    const fired2 = i2.tick(crashAt + MIN); // 不遗漏: 下一周期照常
    expect(fired2.length).toBe(1);
    expect(fired2[0]?.scheduleId).toBe(every.id);

    // 终态与活跃态跨实例持久
    const records = i2.listSchedules();
    expect(records.find((r) => r.id === once.id)?.state).toBe('completed');
    expect(records.find((r) => r.id === once.id)?.nextFireAt).toBeNull();
    expect(records.find((r) => r.id === cron.id)?.state).toBe('active');
    // B 未到期未被触碰: nextFireAt 保持创建值（01-15 02:30Z）
    expect(records.find((r) => r.id === cron.id)?.nextFireAt).toBe(Date.parse('2026-01-15T02:30:00Z'));
  });

  test('触发后重启: deliveryCursor / firedCount / lastFiredAt 跨实例可见', () => {
    const store = sqliteStore();
    const clock = manualClock(BASE);
    const i1 = new ScheduleReplay({ store, clock: clock.now });
    const rec = i1.createSchedule(everyMinute);
    const due = dueOf(rec);
    expect(i1.tick(due).length).toBe(1);
    const i2 = new ScheduleReplay({ store, clock: clock.now });
    const after = i2.listSchedules().find((r) => r.id === rec.id);
    expect(after?.deliveryCursor).toBe(due);
    expect(after?.lastFiredAt).toBe(due);
    expect(after?.firedCount).toBe(1);
    expect(i2.tick(due)).toEqual([]); // 游标防重复触发的核心机制
  });

  test('重启于两次触发之间: 到期点照常触发（不遗漏）', () => {
    const store = sqliteStore();
    const clock = manualClock(BASE);
    const i1 = new ScheduleReplay({ store, clock: clock.now });
    const rec = i1.createSchedule({ kind: 'cron', expr: '0 12 * * *' }); // 每日 12:00 UTC
    expect(rec.nextFireAt).toBe(Date.parse('2026-01-15T12:00:00Z'));
    const i2 = new ScheduleReplay({ store, clock: clock.now }); // 未 tick 即"崩溃"
    const fired = i2.tick(Date.parse('2026-01-15T12:00:00Z'));
    expect(fired.length).toBe(1);
    expect(i2.listSchedules().find((r) => r.id === rec.id)?.nextFireAt).toBe(
      Date.parse('2026-01-16T12:00:00Z'),
    );
  });
});

describe('BI-07.14 spec 校验与 store 解耦', () => {
  test('createSchedule 非法 spec fail-fast（60s 下限）且 store 无残留', () => {
    const store = sqliteStore();
    const rp = new ScheduleReplay({ store, clock: manualClock(BASE).now });
    expect(() => rp.createSchedule({ kind: 'every', intervalMs: 59_999 })).toThrow();
    expect(rp.listSchedules()).toEqual([]);
  });

  test('MemoryDurableStore 同语义（DurableStore 接口解耦）', () => {
    const store: DurableStore = new MemoryDurableStore();
    const clock = manualClock(BASE);
    const i1 = new ScheduleReplay({ store, clock: clock.now });
    const rec = i1.createSchedule(everyMinute);
    const due = dueOf(rec);
    expect(i1.tick(due).length).toBe(1);
    const i2 = new ScheduleReplay({ store, clock: clock.now });
    expect(i2.tick(due)).toEqual([]); // 游标在 store: 不重复
    expect(i2.tick(due + MIN).length).toBe(1); // 不遗漏
  });
});
