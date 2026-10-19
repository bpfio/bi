import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DOCTOR_CHECK_NAMES,
  buildDefaultChecks,
  buildDefaultPorts,
  formatDoctorReport,
  runDoctor,
  type DoctorCheck,
  type DoctorPorts,
} from './doctor';

const NOW = 1_700_000_000_000;

/** 临时主目录 fixture:写入可装配的 config.toml(providers/models 两段)。 */
function fixtureHome(configLines: readonly string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'bi-doctor-'));
  mkdirSync(join(home, '.bi'), { recursive: true });
  writeFileSync(join(home, '.bi', 'config.toml'), configLines.join('\n'), { mode: 0o600 });
  return home;
}

const VALID_CONFIG = [
  '[providers.entries.fake]',
  'api_key_env = "BI_DOCTOR_TEST_KEY"',
  'base_url = "https://mimo.example.internal/v1"',
  'kind = "openai"',
  'models = ["fake-mini"]',
  '',
  '[providers]',
  'default = "fake"',
  '',
  '[models]',
  'default = "main"',
  '',
  '[models.entries.main]',
  'provider = "fake"',
  'model = "fake-mini"',
  '',
] as const;

const VALID_ENV = { BI_DOCTOR_TEST_KEY: 'k-test' } as Record<string, string | undefined>;

/** 全绿基线端口:真实装配链(临时主目录)+ 全部探针注入为绿。 */
function okPorts(overrides: Partial<DoctorPorts> = {}): DoctorPorts {
  const base: DoctorPorts = {
    env: VALID_ENV,
    homeDir: fixtureHome(VALID_CONFIG),
    timeoutMs: 3000,
    probeNetwork: async () => ({
      reachable: true,
      detail: 'mimo.example.internal (1.2.3.4:443) DNS/TCP 可达',
    }),
    probeSandbox: () => ({ available: true, detail: '沙箱后端可用: landlock (abi=5)' }),
    probeToolset: () => ({
      ok: true,
      detail: '6 个工具注册: read_file, web_fetch, web_search, bash, edit, write',
    }),
  };
  return { ...base, ...overrides };
}

describe('BI-29.1 doctor —— 五项检查 ok/fail 分支', () => {
  test('全部健康:allOk=true,五项全过', async () => {
    const report = await runDoctor({ ports: okPorts() });
    expect(report.allOk).toBe(true);
    expect(report.checks.length).toBe(5);
    expect(report.checks.every((c) => c.ok)).toBe(true);
  });

  test('检查项名称与固定顺序:配置装载/凭据门/所配 provider 网络/沙箱探针/工具注册面', async () => {
    const report = await runDoctor({ ports: okPorts() });
    expect(report.checks.map((c) => c.name)).toEqual([
      DOCTOR_CHECK_NAMES.config,
      DOCTOR_CHECK_NAMES.credentials,
      DOCTOR_CHECK_NAMES.network,
      DOCTOR_CHECK_NAMES.sandbox,
      DOCTOR_CHECK_NAMES.tools,
    ]);
  });

  test('配置装载 ok:detail 汇总 provider/model 数与默认模型', async () => {
    const report = await runDoctor({ ports: okPorts() });
    const cfg = report.checks[0]!;
    expect(cfg.ok).toBe(true);
    expect(cfg.detail).toContain('1 provider / 1 model');
    expect(cfg.detail).toContain('默认模型 main');
    expect(cfg.detail).toContain('provider fake');
    expect(cfg.detail).toContain('openai 协议');
  });

  test('凭据门 ok:detail 含 api_key_env 名称', async () => {
    const report = await runDoctor({ ports: okPorts() });
    const cred = report.checks[1]!;
    expect(cred.ok).toBe(true);
    expect(cred.detail).toContain('provider "fake"');
    expect(cred.detail).toContain('api_key_env=BI_DOCTOR_TEST_KEY');
  });

  test('网络探测端口收到所配 provider base_url 与 3000ms 超时(不再探测母体端点)', async () => {
    const seen: Array<[string, number]> = [];
    await runDoctor({
      ports: okPorts({
        probeNetwork: async (url, timeoutMs) => {
          seen.push([url, timeoutMs]);
          return { reachable: true, detail: 'ok' };
        },
      }),
    });
    expect(seen).toEqual([['https://mimo.example.internal/v1', 3000]]);
  });

  test('凭据缺失(env 未设 api_key_env):凭据门 fail 带导出指引,配置装载仍 ok,网络级联 fail', async () => {
    const report = await runDoctor({
      ports: okPorts({ env: {} as Record<string, string | undefined> }),
    });
    const cfg = report.checks[0]!;
    const cred = report.checks[1]!;
    const net = report.checks[2]!;
    expect(cfg.ok).toBe(true);
    expect(cred.ok).toBe(false);
    expect(cred.detail).toContain('BI_DOCTOR_TEST_KEY');
    expect(cred.fix).toContain('环境变量');
    expect(net.ok).toBe(false);
    expect(net.detail).toContain('配置未就绪');
    expect(report.allOk).toBe(false);
  });

  test('api_key_env 为空串 = 无静态 Key 形态(OAuth/本地端点):凭据门 ok', async () => {
    const home = fixtureHome(
      VALID_CONFIG.map((l) => l.replace('api_key_env = "BI_DOCTOR_TEST_KEY"', 'api_key_env = ""')),
    );
    const report = await runDoctor({ ports: okPorts({ homeDir: home, env: {} }) });
    expect(report.checks[1]!.ok).toBe(true);
    expect(report.checks[1]!.detail).toContain('无静态 Key');
  });

  test('配置文件缺失:配置装载 fail 提 bi init,凭据门/网络级联 fail', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bi-doctor-'));
    mkdirSync(join(home, '.bi'), { recursive: true });
    const report = await runDoctor({ ports: okPorts({ homeDir: home }) });
    const cfg = report.checks[0]!;
    expect(cfg.ok).toBe(false);
    expect(cfg.detail).toContain('配置文件不存在');
    expect(cfg.fix).toContain('bi init');
    expect(report.checks[1]!.ok).toBe(false);
    expect(report.checks[2]!.ok).toBe(false);
    expect(report.allOk).toBe(false);
  });

  test('TOML 语法错误:配置装载 fail 带解析错误信息', async () => {
    const home = fixtureHome(['[providers.entries', 'base_url = "', '']);
    const report = await runDoctor({ ports: okPorts({ homeDir: home }) });
    const cfg = report.checks[0]!;
    expect(cfg.ok).toBe(false);
    expect(cfg.detail.length).toBeGreaterThan(0);
    expect(report.allOk).toBe(false);
  });

  test('网络不可达:fail,detail 透传探测结果,fix 指向所配 base_url', async () => {
    const report = await runDoctor({
      ports: okPorts({
        probeNetwork: async () => ({ reachable: false, detail: 'DNS 解析超时: mimo.example.internal' }),
      }),
    });
    const net = report.checks[2]!;
    expect(net.ok).toBe(false);
    expect(net.detail).toBe('DNS 解析超时: mimo.example.internal');
    expect(net.fix).toContain('https://mimo.example.internal/v1');
    expect(report.allOk).toBe(false);
  });

  test('沙箱探针不可用:fail + 安装/内核修复建议', async () => {
    const report = await runDoctor({
      ports: okPorts({
        probeSandbox: () => ({
          available: false,
          detail: '无可用沙箱后端 — landlock: create_ruleset 全掩码失败; bwrap: bwrap 不在 PATH',
        }),
      }),
    });
    const sb = report.checks[3]!;
    expect(sb.ok).toBe(false);
    expect(sb.detail).toContain('bwrap 不在 PATH');
    expect(sb.fix).toContain('bubblewrap');
    expect(report.allOk).toBe(false);
  });

  test('工具注册面注入 fail:fail,detail 透传', async () => {
    const report = await runDoctor({
      ports: okPorts({ probeToolset: () => ({ ok: false, detail: '工具重名: read_file' }) }),
    });
    const tools = report.checks[4]!;
    expect(tools.ok).toBe(false);
    expect(tools.detail).toBe('工具重名: read_file');
    expect(report.allOk).toBe(false);
  });
});

describe('BI-29.1 doctor —— 缺省探针实现(真实装配,非 IO 面)', () => {
  test('defaultProbeToolset(经 buildDefaultPorts):真实工具集装配,命名唯一且描述齐全', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'bi-doctor-work-'));
    const ports = buildDefaultPorts({ workDir, env: {} });
    const summary = await ports.probeToolset();
    expect(summary.ok).toBe(true);
    expect(summary.detail).toMatch(/\d+ 个工具注册: /);
    expect(summary.detail).toContain('read_file');
    expect(summary.detail).toContain('bash');
    expect(summary.detail).toContain('edit');
    expect(summary.detail).toContain('write');
  });

  test('defaultProbeSandbox(经 buildDefaultPorts):结构化 verdict,绝不抛出', async () => {
    const ports = buildDefaultPorts({ env: {} });
    const summary = await ports.probeSandbox();
    expect(typeof summary.available).toBe('boolean');
    expect(summary.detail.length).toBeGreaterThan(0);
  });

  test('buildDefaultPorts 缺省装配:env=process.env,timeoutMs=3000,三探针均在位', () => {
    const ports = buildDefaultPorts();
    expect(ports.env).toBe(process.env);
    expect(ports.timeoutMs).toBe(3000);
    expect(typeof ports.probeNetwork).toBe('function');
    expect(typeof ports.probeSandbox).toBe('function');
    expect(typeof ports.probeToolset).toBe('function');
  });
});

describe('BI-29.1 doctor —— 汇总与注入', () => {
  test('checks 数组全量注入:只跑注入项,结果顺序保持', async () => {
    const checks: DoctorCheck[] = [
      () => ({ name: '自定义A', ok: true, detail: '好' }),
      async () => ({ name: '自定义B', ok: false, detail: '坏', fix: '修它' }),
    ];
    const report = await runDoctor({ checks });
    expect(report.checks.map((c) => c.name)).toEqual(['自定义A', '自定义B']);
    expect(report.allOk).toBe(false);
  });

  test('单项探测抛异常:被捕获为 fail,detail 含探测异常', async () => {
    const report = await runDoctor({
      checks: [
        () => {
          throw new Error('port exploded');
        },
      ],
    });
    const item = report.checks[0]!;
    expect(item.ok).toBe(false);
    expect(item.detail).toContain('port exploded');
    expect(report.allOk).toBe(false);
  });

  test('buildDefaultChecks 接受同步/异步端口返回(沙箱同步、网络异步)', async () => {
    const checks = buildDefaultChecks(okPorts());
    expect(checks.length).toBe(5);
    const results = await Promise.all(checks.map((c) => c()));
    expect(results.every((r) => r.ok)).toBe(true);
  });

  test('formatDoctorReport:✓/✗ 前缀、修复建议缩进、汇总行计数', async () => {
    const report = await runDoctor({
      ports: okPorts({
        probeSandbox: () => ({ available: false, detail: '无可用沙箱后端' }),
      }),
    });
    const text = formatDoctorReport(report);
    const lines = text.split('\n');
    expect(lines[0]).toBe('BI Doctor 体检报告');
    expect(text).toContain('✓ 配置装载');
    expect(text).toContain('✗ 沙箱探针 — 无可用沙箱后端');
    expect(text).toContain('    修复建议: 安装 bubblewrap');
    expect(text).toContain('汇总: 4/5 通过 — 存在异常');
  });

  test('formatDoctorReport 全绿:含「全部健康」汇总且无修复建议行', async () => {
    const report = await runDoctor({ ports: okPorts() });
    const text = formatDoctorReport(report);
    expect(text).toContain('汇总: 5/5 通过 — 全部健康');
    expect(text).not.toContain('修复建议');
    expect(text.split('\n').filter((l) => l.startsWith('✓')).length).toBe(5);
  });
});
