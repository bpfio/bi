import { describe, expect, test } from 'bun:test';
import {
  DOCTOR_CHECK_NAMES,
  buildDefaultChecks,
  buildDefaultPorts,
  formatDoctorReport,
  runDoctor,
  type DoctorCheck,
  type DoctorPorts,
  type ExecOutcome,
} from './doctor';

const NOW = 1_700_000_000_000;

/** 全绿基线端口:每条用例按需覆盖单项制造失败 */
function okPorts(overrides: Partial<DoctorPorts> = {}): DoctorPorts {
  const base: DoctorPorts = {
    endpointUrl: 'https://open.bigmodel.cn',
    timeoutMs: 3000,
    probeNetwork: async () => ({ reachable: true, detail: 'open.bigmodel.cn (1.2.3.4:443) DNS/TCP 可达' }),
    readCredentials: () => ({ provider: 'zhipu', expiresAtMs: NOW + 86_400_000 }),
    exec: async (cmd) =>
      cmd.includes('--version')
        ? { code: 0, stdout: 'Python 3.11.2\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    configDirWritable: () => ({ ok: true, detail: '配置目录可写: /home/u/.bi' }),
    now: () => NOW,
    configDir: '/home/u/.bi',
  };
  return { ...base, ...overrides };
}

describe('BI-20 doctor —— 四项检查 ok/fail 分支', () => {
  test('全部健康:allOk=true,四项全过', async () => {
    const report = await runDoctor({ ports: okPorts() });
    expect(report.allOk).toBe(true);
    expect(report.checks.length).toBe(4);
    expect(report.checks.every((c) => c.ok)).toBe(true);
  });

  test('检查项名称与固定顺序:网络可达/凭据有效期/Python 环境/工作区完整性', async () => {
    const report = await runDoctor({ ports: okPorts() });
    expect(report.checks.map((c) => c.name)).toEqual([
      DOCTOR_CHECK_NAMES.network,
      DOCTOR_CHECK_NAMES.credentials,
      DOCTOR_CHECK_NAMES.python,
      DOCTOR_CHECK_NAMES.workspace,
    ]);
  });

  test('网络不可达:fail,detail 透传探测结果,fix 指向端点', async () => {
    const report = await runDoctor({
      ports: okPorts({
        probeNetwork: async () => ({ reachable: false, detail: 'DNS 解析超时: open.bigmodel.cn' }),
      }),
    });
    const net = report.checks[0]!;
    expect(net.ok).toBe(false);
    expect(net.detail).toBe('DNS 解析超时: open.bigmodel.cn');
    expect(net.fix).toContain('open.bigmodel.cn');
    expect(report.allOk).toBe(false);
  });

  test('probeNetwork 收到缺省端点与 3000ms 超时', async () => {
    const seen: Array<[string, number]> = [];
    await runDoctor({
      ports: okPorts({
        probeNetwork: async (url, timeoutMs) => {
          seen.push([url, timeoutMs]);
          return { reachable: true, detail: 'ok' };
        },
      }),
    });
    expect(seen).toEqual([['https://open.bigmodel.cn', 3000]]);
  });

  test('端点 URL 可配:探测端口收到自定义 URL', async () => {
    const seen: string[] = [];
    await runDoctor({
      ports: okPorts({
        endpointUrl: 'https://mirror.example.internal',
        probeNetwork: async (url) => {
          seen.push(url);
          return { reachable: true, detail: 'ok' };
        },
      }),
    });
    expect(seen).toEqual(['https://mirror.example.internal']);
  });

  test('凭据缺失(null):fail + bi login 修复建议', async () => {
    const report = await runDoctor({ ports: okPorts({ readCredentials: () => null }) });
    const cred = report.checks[1]!;
    expect(cred.ok).toBe(false);
    expect(cred.detail).toContain('未找到 API 凭据');
    expect(cred.fix).toContain('bi login');
    expect(cred.fix).toContain('BI_API_KEY');
  });

  test('凭据过期(expiresAtMs <= now):fail + 刷新建议', async () => {
    const report = await runDoctor({
      ports: okPorts({ readCredentials: () => ({ provider: 'zhipu', expiresAtMs: NOW - 1000 }) }),
    });
    const cred = report.checks[1]!;
    expect(cred.ok).toBe(false);
    expect(cred.detail).toContain('已过期');
    expect(cred.fix).toContain('bi login');
  });

  test('凭据恰好等于当前时刻视为过期(边界)', async () => {
    const report = await runDoctor({
      ports: okPorts({ readCredentials: () => ({ expiresAtMs: NOW }) }),
    });
    expect(report.checks[1]!.ok).toBe(false);
  });

  test('凭据有效(带过期时间):ok,detail 含 provider 与过期时间', async () => {
    const report = await runDoctor({ ports: okPorts() });
    const cred = report.checks[1]!;
    expect(cred.ok).toBe(true);
    expect(cred.detail).toContain('zhipu');
    expect(cred.detail).toContain(new Date(NOW + 86_400_000).toISOString());
  });

  test('凭据无过期语义(expiresAtMs=null):ok', async () => {
    const report = await runDoctor({
      ports: okPorts({ readCredentials: () => ({ provider: 'static-key', expiresAtMs: null }) }),
    });
    expect(report.checks[1]!.ok).toBe(true);
    expect(report.checks[1]!.detail).toContain('static-key');
  });

  test('python3 命令失败:fail + 安装 Python 3 建议', async () => {
    const report = await runDoctor({
      ports: okPorts({
        exec: async () => ({ code: 1, stdout: '', stderr: 'command not found' } satisfies ExecOutcome),
      }),
    });
    const py = report.checks[2]!;
    expect(py.ok).toBe(false);
    expect(py.detail).toContain('python3 不可用');
    expect(py.detail).toContain('command not found');
    expect(py.fix).toContain('python3');
  });

  test('python3 可用但缺 pandas/openpyxl:fail + pip install 建议', async () => {
    const report = await runDoctor({
      ports: okPorts({
        exec: async (cmd) =>
          cmd.includes('--version')
            ? { code: 0, stdout: 'Python 3.10.12\n', stderr: '' }
            : {
                code: 1,
                stdout: '',
                stderr: "ModuleNotFoundError: No module named 'pandas'",
              },
      }),
    });
    const py = report.checks[2]!;
    expect(py.ok).toBe(false);
    expect(py.detail).toContain('Python 3.10.12');
    expect(py.detail).toContain("No module named 'pandas'");
    expect(py.fix).toBe('pip install pandas openpyxl');
    expect(report.allOk).toBe(false);
  });

  test('python3 探测的命令序列:--version 然后 import pandas, openpyxl', async () => {
    const calls: string[] = [];
    await runDoctor({
      ports: okPorts({
        exec: async (cmd) => {
          calls.push(cmd.join(' '));
          return { code: 0, stdout: 'Python 3.11.2\n', stderr: '' };
        },
      }),
    });
    expect(calls).toEqual(['python3 --version', 'python3 -c import pandas, openpyxl']);
  });

  test('配置目录不可写:fail + 权限/BI_CONFIG_DIR 修复建议', async () => {
    const report = await runDoctor({
      ports: okPorts({
        configDirWritable: () => ({ ok: false, detail: '配置目录不可写: /home/u/.bi (EACCES)' }),
      }),
    });
    const ws = report.checks[3]!;
    expect(ws.ok).toBe(false);
    expect(ws.detail).toContain('EACCES');
    expect(ws.fix).toContain('BI_CONFIG_DIR');
    expect(report.allOk).toBe(false);
  });
});

describe('BI-20 doctor —— 汇总与注入', () => {
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

  test('buildDefaultChecks 接受同步/异步端口返回(凭据同步、探测异步)', async () => {
    const ports = buildDefaultPorts(okPorts());
    const checks = buildDefaultChecks(ports);
    expect(checks.length).toBe(4);
    const results = await Promise.all(checks.map((c) => c()));
    expect(results.every((r) => r.ok)).toBe(true);
  });

  test('formatDoctorReport:✓/✗ 前缀、修复建议缩进、汇总行计数', async () => {
    const report = await runDoctor({
      ports: okPorts({
        readCredentials: () => null,
        configDirWritable: () => ({ ok: false, detail: '目录冻结' }),
      }),
    });
    const text = formatDoctorReport(report);
    const lines = text.split('\n');
    expect(lines[0]).toBe('BI Doctor 体检报告');
    expect(text).toContain('✓ 网络可达');
    expect(text).toContain('✗ 凭据有效期 — 未找到 API 凭据');
    expect(text).toContain('✗ 工作区完整性 — 目录冻结');
    expect(text).toContain('    修复建议: 运行 bi login');
    expect(text).toContain('    修复建议: 检查目录属主/权限');
    expect(text).toContain('汇总: 2/4 通过 — 存在异常');
  });

  test('formatDoctorReport 全绿:含「全部健康」汇总且无修复建议行', async () => {
    const report = await runDoctor({ ports: okPorts() });
    const text = formatDoctorReport(report);
    expect(text).toContain('汇总: 4/4 通过 — 全部健康');
    expect(text).not.toContain('修复建议');
    expect(text.split('\n').filter((l) => l.startsWith('✓')).length).toBe(4);
  });
});
