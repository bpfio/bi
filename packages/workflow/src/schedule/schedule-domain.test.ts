/**
 * BI-07.14 调度域原语测试 (schedule-domain)。
 *
 * 覆盖矩阵:
 * 1. parseCron 合法矩阵（26 表达式: `*`/步进/列表/区间/区间步进/Vixie a/n/
 *    空白归一/组合）与非法矩阵（18 表达式: 越界/缺字段/坏步进/坏区间/空项）；
 * 2. nextCronFire: 分钟边界严格递进、闰年 2 月 29 日命中（含 2100 世纪年
 *    非闰跳过）、400 年硬边界返回 null、月日越界跳月（4 月 31 → 5 月 31）、
 *    dom/dow 经典 OR 语义、跨时区命中；
 * 3. localWallToUtc / utcToLocalWall: 东八/UTC/加德满都(+5:45)/纽约冬令时
 *    参数化、闰日接受与 2 月 30 日 fail-fast、往返保真、非法 tz 报错；
 * 4. nextFire 六原语统一入口: after/at/every/daily/weekly/cron 分派、
 *    every 纪元对齐与 60s 下限、at 迟到补发语义、边界严格晚于。
 */
import { describe, expect, test } from 'bun:test';
import {
  CRON_HORIZON_DAYS,
  EVERY_MIN_INTERVAL_MS,
  civilFromDays,
  daysFromCivil,
  daysInMonth,
  isGregorianLeap,
  localWallToUtc,
  nextCronFire,
  nextFire,
  parseCron,
  utcToLocalWall,
  weekdayFromDays,
} from './schedule-domain';
import type { ParsedCron, ScheduleSpec } from './schedule-domain';

/** UTC 时刻速记。 */
const T = (iso: string): number => Date.parse(iso);

const range = (lo: number, hi: number, step = 1): number[] => {
  const out: number[] = [];
  for (let v = lo; v <= hi; v += step) out.push(v);
  return out;
};

interface CronExpectation {
  m?: number[];
  h?: number[];
  dom?: number[];
  mo?: number[];
  dw?: number[];
  domStar?: boolean;
  dowStar?: boolean;
}

function expectCron(parsed: ParsedCron, want: CronExpectation): void {
  if (want.m !== undefined) expect(parsed.minutes).toEqual(new Set(want.m));
  if (want.h !== undefined) expect(parsed.hours).toEqual(new Set(want.h));
  if (want.dom !== undefined) expect(parsed.doms).toEqual(new Set(want.dom));
  if (want.mo !== undefined) expect(parsed.months).toEqual(new Set(want.mo));
  if (want.dw !== undefined) expect(parsed.dows).toEqual(new Set(want.dw));
  if (want.domStar !== undefined) expect(parsed.domStar).toBe(want.domStar);
  if (want.dowStar !== undefined) expect(parsed.dowStar).toBe(want.dowStar);
}

// 事实锚点: 2026-01-01 为周四；01-02 周五、01-04 周日、01-05 周一、01-08 周四、
// 01-11 周日、01-12 周一、01-15 周四。

describe('BI-07.14 parseCron 合法矩阵', () => {
  const cases: Array<[string, CronExpectation]> = [
    ['* * * * *', { m: range(0, 59), h: range(0, 23), dom: range(1, 31), mo: range(1, 12), dw: range(0, 6), domStar: true, dowStar: true }],
    ['0 * * * *', { m: [0] }],
    ['59 * * * *', { m: [59] }],
    ['*/5 * * * *', { m: range(0, 55, 5) }],
    ['0,30 * * * *', { m: [0, 30] }],
    ['1,2,3 4,5 * * *', { m: [1, 2, 3], h: [4, 5] }],
    ['10-20 * * * *', { m: range(10, 20) }],
    ['0 9-17 * * *', { h: range(9, 17) }],
    ['0-30/10 * * * *', { m: [0, 10, 20, 30] }],
    ['10-30/5 * * * *', { m: [10, 15, 20, 25, 30] }],
    ['5,10-20/5,55 * * * *', { m: [5, 10, 15, 20, 55] }],
    ['5,10-30/5,55 * * * *', { m: [5, 10, 15, 20, 25, 30, 55] }],
    ['0 0 1 * *', { dom: [1] }],
    ['0 0 1,15 * *', { dom: [1, 15] }],
    ['0 0 * 1 *', { mo: [1] }],
    ['0 0 * 1,7,12 *', { mo: [1, 7, 12] }],
    ['0 0 * * 0', { dw: [0] }],
    ['0 0 * * 1-5', { dw: [1, 2, 3, 4, 5] }],
    ['0 0 1 1 *', { dom: [1], mo: [1] }],
    ['30 4 1,15 3,9 0,6', { m: [30], h: [4], dom: [1, 15], mo: [3, 9], dw: [0, 6] }],
    ['0 */6 * * *', { h: [0, 6, 12, 18] }],
    ['*/15 0 * * *', { m: [0, 15, 30, 45], h: [0] }],
    ['5/10 * * * *', { m: [5, 15, 25, 35, 45, 55] }],
    ['  5   4 *  *  *', { m: [5], h: [4] }],
    ['* * 28-31 * *', { dom: [28, 29, 30, 31] }],
    ['0 0 * 2 0', { mo: [2], dw: [0] }],
    ['20-30/10 12 15 6 0-6', { m: [20, 30], h: [12], dom: [15], mo: [6], dw: range(0, 6) }],
  ];

  test.each(cases)('parseCron(%j)', (expr, want) => {
    expectCron(parseCron(expr), want);
  });
});

describe('BI-07.14 parseCron 非法矩阵（一律抛错）', () => {
  const bad = [
    '61 * * * *', // 分 > 59
    '-1 * * * *', // 负值伪装区间
    '* 24 * * *', // 时 > 23
    '0 0 32 * *', // 日 > 31
    '0 0 * 13 *', // 月 > 12
    '0 0 * * 7', // 周 > 6（严格 0-6）
    '* * * *', // 4 字段
    '* * * * * *', // 6 字段
    'a * * * *', // 非数值
    '*/0 * * * *', // 步进 0
    '*/-2 * * * *', // 负步进
    '5-1 * * * *', // 倒序区间
    '1,,2 * * * *', // 空列表项
    '0-70/10 * * * *', // 区间上界越界
    '/5 * * * *', // 缺基数
    '5/ * * * *', // 缺步进值
    '1.5 * * * *', // 非整数
    '', // 空表达式
  ];

  test.each(bad.map((expr) => [expr] as const))('parseCron(%j) 抛错', (expr) => {
    expect(() => parseCron(expr)).toThrow();
  });
});

describe('BI-07.14 nextCronFire', () => {
  test('* * * * * → 下一分钟边界（严格晚于 afterMs）', () => {
    expect(nextCronFire('* * * * *', T('2026-01-15T12:00:00Z'), 'UTC')).toBe(T('2026-01-15T12:01:00Z'));
    expect(nextCronFire('* * * * *', T('2026-01-15T12:00:30.500Z'), 'UTC')).toBe(T('2026-01-15T12:01:00Z'));
    expect(nextCronFire('* * * * *', T('2026-01-15T12:01:00Z'), 'UTC')).toBe(T('2026-01-15T12:02:00Z'));
  });

  test('0 0 * * * → 下一 UTC 午夜；恰在午夜则次日凌晨', () => {
    expect(nextCronFire('0 0 * * *', T('2026-01-15T12:00:00Z'), 'UTC')).toBe(T('2026-01-16T00:00:00Z'));
    expect(nextCronFire('0 0 * * *', T('2026-01-15T00:00:00Z'), 'UTC')).toBe(T('2026-01-16T00:00:00Z'));
  });

  test('小时内分钟跳转', () => {
    expect(nextCronFire('30 10 * * *', T('2026-01-15T09:45:00Z'), 'UTC')).toBe(T('2026-01-15T10:30:00Z'));
    expect(nextCronFire('30 10 * * *', T('2026-01-15T11:00:00Z'), 'UTC')).toBe(T('2026-01-16T10:30:00Z'));
  });

  test('分钟列表当日跳过', () => {
    expect(nextCronFire('0,30 9 * * *', T('2026-01-15T09:31:00Z'), 'UTC')).toBe(T('2026-01-16T09:00:00Z'));
  });

  test('闰年 2 月 29 日命中（2026 → 2028）', () => {
    expect(nextCronFire('0 0 29 2 *', T('2026-01-01T00:00:00Z'), 'UTC')).toBe(T('2028-02-29T00:00:00Z'));
  });

  test('世纪年 2100 非闰跳过（2096-03-01 → 2104-02-29）', () => {
    expect(nextCronFire('0 0 29 2 *', T('2096-03-01T00:00:00Z'), 'UTC')).toBe(T('2104-02-29T00:00:00Z'));
  });

  test('400 年硬边界: 2 月 30/31 日、4 月 31 日永不存在 → null 防死循环', () => {
    expect(nextCronFire('0 0 30 2 *', T('2026-01-01T00:00:00Z'), 'UTC')).toBeNull();
    expect(nextCronFire('0 0 31 2 *', T('2026-01-01T00:00:00Z'), 'UTC')).toBeNull();
    expect(nextCronFire('0 0 31 4 *', T('2026-01-01T00:00:00Z'), 'UTC')).toBeNull();
  });

  test('月日越界跳月: 4 月无 31 日 → 落 5 月 31 日', () => {
    expect(nextCronFire('0 0 31 * *', T('2026-04-01T00:00:00Z'), 'UTC')).toBe(T('2026-05-31T00:00:00Z'));
  });

  test('星期字段命中: 周一', () => {
    expect(nextCronFire('0 0 * * 1', T('2026-01-08T00:00:00Z'), 'UTC')).toBe(T('2026-01-12T00:00:00Z'));
  });

  test('dom 与 dow 同时受限按经典 OR 语义（周五 01-02 先于 13 日）', () => {
    expect(nextCronFire('0 0 13 * 5', T('2026-01-01T00:00:00Z'), 'UTC')).toBe(T('2026-01-02T00:00:00Z'));
  });

  test('月份列表跨半年推算', () => {
    expect(nextCronFire('0 0 1 6,7 *', T('2026-01-01T00:00:00Z'), 'UTC')).toBe(T('2026-06-01T00:00:00Z'));
  });

  test('跨时区: 东八区午夜 = 前日 16:00Z', () => {
    expect(nextCronFire('0 0 * * *', T('2026-01-15T12:00:00Z'), 'Asia/Shanghai')).toBe(T('2026-01-15T16:00:00Z'));
    expect(nextCronFire('59 23 * * *', T('2026-01-15T15:30:00Z'), 'Asia/Shanghai')).toBe(T('2026-01-15T15:59:00Z'));
  });

  test('非法表达式 / 非法时区抛错', () => {
    expect(() => nextCronFire('61 * * * *', T('2026-01-15T00:00:00Z'), 'UTC')).toThrow();
    expect(() => nextCronFire('* * * * *', T('2026-01-15T00:00:00Z'), 'Not/AZone')).toThrow();
  });
});

describe('BI-07.14 localWallToUtc / utcToLocalWall', () => {
  test('UTC 直算', () => {
    expect(localWallToUtc(2026, 1, 15, 12, 0, 'UTC')).toBe(T('2026-01-15T12:00:00Z'));
  });

  test('东八区（UTC+8，无 DST）', () => {
    expect(localWallToUtc(2026, 1, 15, 12, 0, 'Asia/Shanghai')).toBe(T('2026-01-15T04:00:00Z'));
  });

  test('加德满都（UTC+5:45，无 DST）', () => {
    expect(localWallToUtc(2026, 1, 15, 12, 0, 'Asia/Kathmandu')).toBe(T('2026-01-15T06:15:00Z'));
  });

  test('纽约冬令时（EST=UTC-5，非跳变日，偏差备案不适用）', () => {
    expect(localWallToUtc(2026, 1, 15, 12, 0, 'America/New_York')).toBe(T('2026-01-15T17:00:00Z'));
  });

  test('闰日 2028-02-29 接受；2027-02-29 与 2 月 30 日 fail-fast', () => {
    expect(localWallToUtc(2028, 2, 29, 0, 0, 'UTC')).toBe(T('2028-02-29T00:00:00Z'));
    expect(() => localWallToUtc(2027, 2, 29, 0, 0, 'UTC')).toThrow();
    expect(() => localWallToUtc(2026, 2, 30, 0, 0, 'UTC')).toThrow();
    expect(() => localWallToUtc(2026, 13, 1, 0, 0, 'UTC')).toThrow();
    expect(() => localWallToUtc(2026, 1, 15, 24, 0, 'UTC')).toThrow();
  });

  test('往返保真（SH / UTC / Kathmandu）', () => {
    for (const tz of ['Asia/Shanghai', 'UTC', 'Asia/Kathmandu']) {
      const utc = localWallToUtc(2026, 6, 10, 8, 30, tz);
      const wall = utcToLocalWall(tz, utc);
      expect([wall.y, wall.mo, wall.d, wall.h, wall.mi]).toEqual([2026, 6, 10, 8, 30]);
    }
  });

  test('星期推算: 2026-01-15 为周四(4)', () => {
    expect(utcToLocalWall('UTC', T('2026-01-15T00:00:00Z')).weekday).toBe(4);
  });

  test('非法 IANA 时区抛错', () => {
    expect(() => localWallToUtc(2026, 1, 15, 12, 0, 'Not/AZone')).toThrow();
  });

  test('日历核心互证: civil 算法与天数/星期自洽', () => {
    expect(isGregorianLeap(2028)).toBe(true);
    expect(isGregorianLeap(2100)).toBe(false);
    expect(isGregorianLeap(2000)).toBe(true);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2027, 2)).toBe(28);
    expect(daysFromCivil(1970, 1, 1)).toBe(0);
    expect(civilFromDays(0)).toEqual({ y: 1970, mo: 1, d: 1 });
    expect(weekdayFromDays(daysFromCivil(2026, 1, 15))).toBe(4);
    expect(daysFromCivil(2026, 1, 15)).toBe(20468);
  });
});

describe('BI-07.14 nextFire 六原语统一入口', () => {
  test('after: afterMs + delayMs；负延时抛错', () => {
    expect(nextFire({ kind: 'after', delayMs: 5_000 }, 1_000)).toBe(6_000);
    expect(() => nextFire({ kind: 'after', delayMs: -1 }, 1_000)).toThrow();
  });

  test('at: 东八区本地墙钟换算', () => {
    expect(
      nextFire({ kind: 'at', isoLocal: '2026-03-10T08:30', tz: 'Asia/Shanghai' }, 0),
    ).toBe(T('2026-03-10T00:30:00Z'));
  });

  test('at: tz 缺省回落 nextFire 参数（UTC）', () => {
    expect(nextFire({ kind: 'at', isoLocal: '2026-03-10T08:30' }, 0, 'UTC')).toBe(T('2026-03-10T08:30:00Z'));
  });

  test('at: 秒级精度与空格分隔形式', () => {
    expect(nextFire({ kind: 'at', isoLocal: '2026-03-10T08:30:45' }, 0, 'UTC')).toBe(T('2026-03-10T08:30:45Z'));
    expect(nextFire({ kind: 'at', isoLocal: '2026-03-10 08:30' }, 0, 'UTC')).toBe(T('2026-03-10T08:30:00Z'));
  });

  test('at: 过去时刻原样返回（迟到补发/崩溃自愈同机制，由重放中枢落终态）', () => {
    expect(nextFire({ kind: 'at', isoLocal: '2020-01-01T00:00' }, T('2026-01-01T00:00:00Z'), 'UTC')).toBe(T('2020-01-01T00:00:00Z'));
  });

  test('at: 非法格式与月日越界抛错', () => {
    expect(() => nextFire({ kind: 'at', isoLocal: '2026-03-10' }, 0, 'UTC')).toThrow();
    expect(() => nextFire({ kind: 'at', isoLocal: '2026-02-30T00:00' }, 0, 'UTC')).toThrow();
    expect(() => nextFire({ kind: 'at', isoLocal: '2026-03-10T08:30Z' }, 0, 'UTC')).toThrow();
  });

  test('every: 纪元对齐，严格 > afterMs；负 afterMs 亦收敛', () => {
    expect(nextFire({ kind: 'every', intervalMs: 60_000 }, 1_000_000)).toBe(1_020_000);
    expect(nextFire({ kind: 'every', intervalMs: 60_000 }, 1_020_000)).toBe(1_080_000);
    expect(nextFire({ kind: 'every', intervalMs: 60_000 }, -5)).toBe(0);
  });

  test('every: 60s 下限执行', () => {
    expect(EVERY_MIN_INTERVAL_MS).toBe(60_000);
    expect(nextFire({ kind: 'every', intervalMs: 60_000 }, 0)).toBe(60_000);
    expect(() => nextFire({ kind: 'every', intervalMs: 59_999 }, 0)).toThrow();
    expect(() => nextFire({ kind: 'every', intervalMs: 60_000.5 }, 0)).toThrow();
  });

  test('daily: 当日未到当日触发，已过推次日；恰在 hh:mm 严格推次日', () => {
    const spec: ScheduleSpec = { kind: 'daily', hh: 8, mm: 30, tz: 'Asia/Shanghai' };
    expect(nextFire(spec, T('2026-01-15T00:00:00Z'))).toBe(T('2026-01-15T00:30:00Z'));
    expect(nextFire(spec, T('2026-01-15T00:45:00Z'))).toBe(T('2026-01-16T00:30:00Z'));
    expect(nextFire(spec, localWallToUtc(2026, 1, 15, 8, 30, 'Asia/Shanghai'))).toBe(T('2026-01-16T00:30:00Z'));
  });

  test('daily: tz 缺省回落参数时区', () => {
    expect(nextFire({ kind: 'daily', hh: 9, mm: 0 }, T('2026-01-15T10:00:00Z'), 'UTC')).toBe(T('2026-01-16T09:00:00Z'));
  });

  test('weekly: 本周已过推下周（跨周）', () => {
    const spec: ScheduleSpec = { kind: 'weekly', weekday: 1, hh: 9, mm: 0, tz: 'UTC' };
    expect(nextFire(spec, T('2026-01-05T10:00:00Z'))).toBe(T('2026-01-12T09:00:00Z'));
    expect(nextFire(spec, T('2026-01-04T12:00:00Z'))).toBe(T('2026-01-05T09:00:00Z'));
  });

  test('weekly: 恰在目标时刻严格推下周；weekday 7 抛错', () => {
    const spec: ScheduleSpec = { kind: 'weekly', weekday: 0, hh: 9, mm: 0, tz: 'UTC' };
    expect(nextFire(spec, T('2026-01-11T09:00:00Z'))).toBe(T('2026-01-18T09:00:00Z'));
    expect(() => nextFire({ kind: 'weekly', weekday: 7, hh: 0, mm: 0, tz: 'UTC' }, 0)).toThrow();
  });

  test('cron 分派与 nextCronFire 一致', () => {
    const after = T('2026-01-15T12:00:00Z');
    expect(nextFire({ kind: 'cron', expr: '0 0 * * *' }, after, 'UTC')).toBe(
      nextCronFire('0 0 * * *', after, 'UTC'),
    );
  });

  test('非法 afterMs / 未知原语抛错', () => {
    expect(() => nextFire({ kind: 'after', delayMs: 1 }, Number.NaN)).toThrow();
    const impostor = { kind: 'alien' } as unknown as ScheduleSpec;
    expect(() => nextFire(impostor, 0)).toThrow();
  });
});

// CRON_HORIZON_DAYS 常量契约（400 年硬边界的扫描窗口）
describe('BI-07.14 常量契约', () => {
  test('400 年 = 146097 天，且整除一周（星期对齐同周期复现）', () => {
    expect(CRON_HORIZON_DAYS).toBe(146_097);
    expect(CRON_HORIZON_DAYS % 7).toBe(0);
    expect(146_097 / 400).toBeCloseTo(365.2425, 4);
  });
});
