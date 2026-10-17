import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConfigService, type ConfigChangeMeta } from "./config-service";
import { createTempDirs, ensureBiDirs, writeHomeConfig, writeLocalConfig, waitFor, type TempDirs } from "./test-helpers";

let temp: TempDirs;
let home = "";
let work = "";
let service: ConfigService | undefined;

beforeEach(async () => {
  temp = await createTempDirs("bi-watch");
  home = temp.home;
  work = temp.work;
  await ensureBiDirs(home, work);
});

afterEach(() => {
  service?.stopWatch();
  service = undefined;
  return temp.cleanup();
});

describe("ConfigService: fs.watch 热重载", () => {
  test("config.toml 变更 → 防抖后自动 reload 并通知 watch 触发", async () => {
    service = new ConfigService({ homeDir: home, workDir: work, env: {}, watchDebounceMs: 40 });
    await service.load();
    const metas: ConfigChangeMeta[] = [];
    service.onChange((_config, meta) => metas.push(meta));
    service.startWatch();

    await writeHomeConfig(home, "config.toml", "[read]\nmax_file_size_kb = 64\n");
    await waitFor(() => service?.currentOrNull?.read.max_file_size_kb === 64);
    expect(metas.some((m) => m.trigger === "watch" && m.filePath?.endsWith("config.toml"))).toBe(true);
  });

  test("local.toml 变更触发工作区层重载", async () => {
    service = new ConfigService({ homeDir: home, workDir: work, env: {}, watchDebounceMs: 40 });
    await service.load();
    service.startWatch();

    await writeLocalConfig(work, "[tools]\ndeny = ['rm', 'dd']\n");
    await waitFor(() => (service?.currentOrNull?.tools.deny.length ?? 0) === 2);
    expect(service.current.tools.deny).toEqual(["rm", "dd"]);
  });

  test("tui.toml 变更走 reloadTui 路径", async () => {
    service = new ConfigService({ homeDir: home, workDir: work, env: {}, watchDebounceMs: 40 });
    await service.load();
    service.startWatch();

    await writeHomeConfig(home, "tui.toml", "theme = 'night'\n");
    await waitFor(() => service?.currentOrNull?.tui.theme === "night");
  });

  test("防抖：连续多次写文件只触发一次重载", async () => {
    service = new ConfigService({ homeDir: home, workDir: work, env: {}, watchDebounceMs: 120 });
    await service.load();
    let notifications = 0;
    service.onChange(() => {
      notifications += 1;
    });
    service.startWatch();

    for (let i = 0; i < 5; i += 1) {
      await writeHomeConfig(home, "config.toml", `[read]\nmax_file_size_kb = ${100 + i}\n`);
      await new Promise((resolve) => setTimeout(resolve, 30)); // 间隔小于防抖窗口
    }
    await waitFor(() => service?.currentOrNull?.read.max_file_size_kb === 104);
    await new Promise((resolve) => setTimeout(resolve, 200)); // 等潜在的第二波触发
    expect(notifications).toBe(1);
    expect(service.current.read.max_file_size_kb).toBe(104);
  });

  test("watch 期间文件无效：保留上次快照且监听不中断，恢复后继续重载", async () => {
    service = new ConfigService({ homeDir: home, workDir: work, env: {}, watchDebounceMs: 40 });
    await writeHomeConfig(home, "config.toml", "[read]\nmax_file_size_kb = 64\n");
    await service.load();
    service.startWatch();

    await writeHomeConfig(home, "config.toml", "not [ valid\n");
    await waitFor(() => service?.watchError !== undefined);
    expect(service.currentOrNull?.read.max_file_size_kb).toBe(64); // last-good 快照

    await writeHomeConfig(home, "config.toml", "[read]\nmax_file_size_kb = 32\n");
    await waitFor(() => service?.currentOrNull?.read.max_file_size_kb === 32); // 监听仍存活
    expect(service.watchError).toBeUndefined(); // 成功重载后错误被清除
  });

  test("stopWatch 后不再响应文件变更", async () => {
    service = new ConfigService({ homeDir: home, workDir: work, env: {}, watchDebounceMs: 40 });
    await writeHomeConfig(home, "config.toml", "[read]\nmax_file_size_kb = 64\n");
    await service.load();
    service.startWatch();
    service.stopWatch();

    await writeHomeConfig(home, "config.toml", "[read]\nmax_file_size_kb = 128\n");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(service.currentOrNull?.read.max_file_size_kb).toBe(64);
  });

  test("重复 startWatch 幂等", async () => {
    service = new ConfigService({ homeDir: home, workDir: work, env: {}, watchDebounceMs: 40 });
    await service.load();
    service.startWatch();
    service.startWatch(); // 第二次为空操作
    await writeHomeConfig(home, "config.toml", "[read]\nmax_file_size_kb = 77\n");
    await waitFor(() => service?.currentOrNull?.read.max_file_size_kb === 77);
    service.stopWatch();
  });
});
