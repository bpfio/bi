/**
 * BI-20 / E 工位 —— /doctor 全链路体检。
 *
 * 四个检查项(网络可达 / 凭据有效期 / Python 环境 / 工作区完整性)全部走注入式探测端口,
 * 逐项产出 {name, ok, detail, fix?};测试离屏注入假端口,零真实 IO 依赖。
 * runDoctor 汇总为 DoctorReport(allOk + 逐项),formatDoctorReport 输出终端友好文本。
 */

import { lookup } from 'node:dns/promises';
import { connect } from 'node:net';
import { execFile } from 'node:child_process';
import { access, constants, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// 端口与结果类型
// ---------------------------------------------------------------------------

export interface DoctorCheckResult {
  name: string;
  ok: boolean;
  detail: string;
  /** ok=false 时的修复建议 */
  fix?: string;
}

export type DoctorCheck = () => Promise<DoctorCheckResult> | DoctorCheckResult;

export interface ProbeOutcome {
  reachable: boolean;
  detail: string;
}

export interface DoctorCredentials {
  provider?: string;
  /** 凭据过期时间戳(ms);null/undefined = 无过期语义 */
  expiresAtMs?: number | null;
}

export interface ExecOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

export interface WritableProbeOutcome {
  ok: boolean;
  detail: string;
}

export interface DoctorPorts {
  /** 网络探测端点,缺省智谱开放平台 */
  endpointUrl: string;
  /** 探测超时(ms),缺省 3000 */
  timeoutMs: number;
  /** 仅 DNS/TCP 语义的可达性探测(不发业务请求) */
  probeNetwork: (url: string, timeoutMs: number) => Promise<ProbeOutcome>;
  /** 凭据端口:返回 null 表示未配置任何凭据 */
  readCredentials: () => Promise<DoctorCredentials | null> | DoctorCredentials | null;
  /** 命令执行端口(用于 python3 探测) */
  exec: (cmd: readonly string[]) => Promise<ExecOutcome>;
  /** bi 配置目录可写性探测 */
  configDirWritable: () => Promise<WritableProbeOutcome> | WritableProbeOutcome;
  /** 时钟端口(凭据过期判定) */
  now: () => number;
  /** bi 配置目录 */
  configDir: string;
}

export const DOCTOR_CHECK_NAMES = {
  network: '网络可达',
  credentials: '凭据有效期',
  python: 'Python 环境',
  workspace: '工作区完整性',
} as const;

// ---------------------------------------------------------------------------
// 缺省端口实现(真实 IO;测试一律注入假端口,不走到这里)
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} (${ms}ms)`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** DNS 解析 + TCP 连通,语义仅到传输层,不发 HTTP */
async function defaultProbeNetwork(url: string, timeoutMs: number): Promise<ProbeOutcome> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { reachable: false, detail: `无效端点 URL: ${url}` };
  }
  const host = parsed.hostname;
  const port = parsed.port !== '' ? Number(parsed.port) : parsed.protocol === 'http:' ? 80 : 443;
  let address: string;
  try {
    const resolved = await withTimeout(lookup(host), timeoutMs, `DNS 解析超时: ${host}`);
    address = typeof resolved === 'string' ? resolved : resolved.address;
  } catch (e) {
    return { reachable: false, detail: e instanceof Error ? e.message : String(e) };
  }
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const socket = connect({ host: address, port });
        const done = (err?: Error): void => {
          socket.destroy();
          if (err) reject(err);
          else resolve();
        };
        socket.once('connect', () => done());
        socket.once('error', (err: Error) => done(err));
      }),
      timeoutMs,
      `TCP 连接超时: ${address}:${port}`,
    );
    return { reachable: true, detail: `${host} (${address}:${port}) DNS/TCP 可达` };
  } catch (e) {
    return { reachable: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

function defaultReadCredentials(): DoctorCredentials | null {
  const apiKey =
    process.env.BI_API_KEY ?? process.env.ZHIPU_API_KEY ?? process.env.ZHIPUAI_API_KEY;
  if (!apiKey) return null;
  const raw = process.env.BI_CREDENTIAL_EXPIRES_AT_MS;
  const parsed = raw !== undefined ? Number(raw) : NaN;
  return {
    provider: 'zhipu',
    expiresAtMs: Number.isFinite(parsed) ? parsed : null,
  };
}

async function defaultExec(cmd: readonly string[]): Promise<ExecOutcome> {
  const file = cmd[0];
  if (file === undefined) return { code: 1, stdout: '', stderr: '空命令' };
  try {
    const r = await execFileP(file, cmd.slice(1).map(String), {
      timeout: 5000,
      encoding: 'utf8',
    });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message ?? String(e),
    };
  }
}

async function defaultConfigDirWritable(dir: string): Promise<WritableProbeOutcome> {
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
    return { ok: true, detail: `配置目录可写: ${dir}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, detail: `配置目录不可写: ${dir} (${msg})` };
  }
}

export function buildDefaultPorts(overrides: Partial<DoctorPorts> = {}): DoctorPorts {
  const configDir = overrides.configDir ?? process.env.BI_CONFIG_DIR ?? join(homedir(), '.bi');
  return {
    endpointUrl: overrides.endpointUrl ?? 'https://open.bigmodel.cn',
    timeoutMs: overrides.timeoutMs ?? 3000,
    probeNetwork: overrides.probeNetwork ?? defaultProbeNetwork,
    readCredentials: overrides.readCredentials ?? defaultReadCredentials,
    exec: overrides.exec ?? defaultExec,
    configDirWritable: overrides.configDirWritable ?? (() => defaultConfigDirWritable(configDir)),
    now: overrides.now ?? (() => Date.now()),
    configDir,
  };
}

// ---------------------------------------------------------------------------
// 检查项组装
// ---------------------------------------------------------------------------

function firstLine(s: string): string {
  const line = s.split('\n')[0] ?? '';
  return line.trim();
}

/** 由端口装配四个缺省检查项 */
export function buildDefaultChecks(ports: DoctorPorts): DoctorCheck[] {
  return [
    // 1. 网络可达(端点 URL 可配,仅 DNS/TCP 语义,缺省 3s 超时)
    async () => {
      const r = await ports.probeNetwork(ports.endpointUrl, ports.timeoutMs);
      return r.reachable
        ? { name: DOCTOR_CHECK_NAMES.network, ok: true, detail: r.detail }
        : {
            name: DOCTOR_CHECK_NAMES.network,
            ok: false,
            detail: r.detail,
            fix: `检查本机网络/代理,或调整探测端点 (${ports.endpointUrl})`,
          };
    },
    // 2. 凭据有效期
    async () => {
      const cred = await ports.readCredentials();
      if (!cred) {
        return {
          name: DOCTOR_CHECK_NAMES.credentials,
          ok: false,
          detail: '未找到 API 凭据',
          fix: '运行 bi login,或设置 BI_API_KEY 环境变量',
        };
      }
      const provider = cred.provider ?? 'default';
      if (cred.expiresAtMs !== null && cred.expiresAtMs !== undefined) {
        if (cred.expiresAtMs <= ports.now()) {
          return {
            name: DOCTOR_CHECK_NAMES.credentials,
            ok: false,
            detail: `${provider} 凭据已过期 (${new Date(cred.expiresAtMs).toISOString()})`,
            fix: '重新运行 bi login 刷新凭据',
          };
        }
        return {
          name: DOCTOR_CHECK_NAMES.credentials,
          ok: true,
          detail: `${provider} 凭据有效,过期时间 ${new Date(cred.expiresAtMs).toISOString()}`,
        };
      }
      return { name: DOCTOR_CHECK_NAMES.credentials, ok: true, detail: `${provider} 凭据有效` };
    },
    // 3. Python 环境(python3 可用 + pandas/openpyxl 可导入)
    async () => {
      const ver = await ports.exec(['python3', '--version']);
      if (ver.code !== 0) {
        return {
          name: DOCTOR_CHECK_NAMES.python,
          ok: false,
          detail: `python3 不可用: ${firstLine(ver.stderr) || firstLine(ver.stdout) || 'command not found'}`,
          fix: '安装 Python 3(如 apt install python3,或从 python.org 安装)',
        };
      }
      const imports = await ports.exec(['python3', '-c', 'import pandas, openpyxl']);
      if (imports.code !== 0) {
        return {
          name: DOCTOR_CHECK_NAMES.python,
          ok: false,
          detail: `python3 可用 (${firstLine(ver.stdout)}) 但缺依赖: ${firstLine(imports.stderr) || 'import pandas/openpyxl 失败'}`,
          fix: 'pip install pandas openpyxl',
        };
      }
      return {
        name: DOCTOR_CHECK_NAMES.python,
        ok: true,
        detail: `python3 可用 (${firstLine(ver.stdout)}),pandas/openpyxl 就绪`,
      };
    },
    // 4. 工作区完整性(bi 配置目录可写)
    async () => {
      const r = await ports.configDirWritable();
      return r.ok
        ? { name: DOCTOR_CHECK_NAMES.workspace, ok: true, detail: r.detail }
        : {
            name: DOCTOR_CHECK_NAMES.workspace,
            ok: false,
            detail: r.detail,
            fix: '检查目录属主/权限(chmod/chown),或用 BI_CONFIG_DIR 指向可写目录',
          };
    },
  ];
}

// ---------------------------------------------------------------------------
// 汇总与格式化
// ---------------------------------------------------------------------------

export interface DoctorReport {
  allOk: boolean;
  checks: DoctorCheckResult[];
}

export interface DoctorDeps {
  /** 全量注入检查项数组(优先于 ports 装配) */
  checks?: readonly DoctorCheck[];
  /** 注入/覆盖部分端口,未覆盖项用缺省实现 */
  ports?: Partial<DoctorPorts>;
}

/** 逐项执行检查;单项抛错被捕获为 fail,绝不拖垮整份体检 */
export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorReport> {
  const ports = buildDefaultPorts(deps.ports);
  const checks = deps.checks ?? buildDefaultChecks(ports);
  const results: DoctorCheckResult[] = [];
  for (const check of checks) {
    try {
      results.push(await check());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({
        name: check.name || '体检项',
        ok: false,
        detail: `探测异常: ${msg}`,
        fix: '重试或查看 bi doctor 日志定位端口实现',
      });
    }
  }
  return { allOk: results.length > 0 && results.every((r) => r.ok), checks: results };
}

/** 终端友好文本:✓/✗ 逐项 + 修复建议缩进 + 汇总行 */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = ['BI Doctor 体检报告', '──────────────────'];
  for (const c of report.checks) {
    lines.push(`${c.ok ? '✓' : '✗'} ${c.name} — ${c.detail}`);
    if (!c.ok && c.fix) lines.push(`    修复建议: ${c.fix}`);
  }
  const passed = report.checks.filter((c) => c.ok).length;
  lines.push(
    report.allOk
      ? `汇总: ${passed}/${report.checks.length} 通过 — 全部健康`
      : `汇总: ${passed}/${report.checks.length} 通过 — 存在异常,请按修复建议处理`,
  );
  return lines.join('\n');
}
