import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeEndpoint } from "/home/yupeng/bi/scripts/fake-endpoint";
import { runBi } from "/home/yupeng/bi/packages/core/src/cli/main";

const CLEANUPS: string[] = [];
function mkRoot(p: string) { const d = mkdtempSync(join(tmpdir(), p)); CLEANUPS.push(d); return d; }
function writeConfig(home: string, body: string) {
  mkdirSync(join(home, ".bi"), { recursive: true });
  writeFileSync(join(home, ".bi", "config.toml"), body);
}
const BASE = (extra: string) => [
  "[providers.entries.fake]", 'api_key_env = "BI_FAKE_KEY"',
  '[base_url_placeholder]',
  'kind = "anthropic"', 'models = ["fake-echo"]',
  "", "[providers]", 'default = "fake"',
  "", "[models]", 'default = "main"',
  "", "[models.entries.main]", 'provider = "fake"', 'model = "fake-echo"',
  extra,
].join("\n").replace("[base_url_placeholder]", "base_url = \"" + FAKE_URL + "\"");

const fake = startFakeEndpoint({ echo: true });
const FAKE_URL = fake.url;
process.env.BI_FAKE_KEY = "smoke-key";

// ---- 场景 1:全开(六个器官 config 显式启用)----
const homeOn = mkRoot("organ-smoke-on-");
const projOn = mkRoot("organ-smoke-proj-");
writeFileSync(join(projOn, "BI.dream.md"), "- 记住:用户偏好简洁回复\n- 战役纪元 2026-10-19\n");
writeConfig(homeOn, BASE([
  "[context]", "time_context = true", "date_change_sensor = true", "tool_result_prune = true", 'timezone = "Asia/Shanghai"',
  "[subagent]", "enabled = true",
  "[ptc]", "enabled = true",
  "[cron]", "enabled = true",
  "[memory]", "dream_enabled = true", "inject_enabled = true",
].join("\n")));
process.chdir(projOn);
const codeOn = await runBi(["--prompt", "冒烟", "--output-format", "stream-json"], {
  headless: { homeDir: homeOn, permissionMode: "yolo" } as any,
});
const reqOn = fake.requests[fake.requests.length - 1];
const sysOn = JSON.stringify(reqOn.messages?.filter((m: any) => m.role === "system") ?? []);
const toolsOn: string[] = (reqOn.tools ?? []).map((t: any) => t.name);

// ---- 场景 2:缺省全关(仅凭据,零器官段)----
const homeOff = mkRoot("organ-smoke-off-");
writeConfig(homeOff, BASE(""));
const codeOff = await runBi(["--prompt", "冒烟", "--output-format", "stream-json"], {
  headless: { homeDir: homeOff, permissionMode: "yolo" } as any,
});
const reqOff = fake.requests[fake.requests.length - 1];
const sysOff = JSON.stringify(reqOff.messages?.filter((m: any) => m.role === "system") ?? []);
const toolsOff: string[] = (reqOff.tools ?? []).map((t: any) => t.name);

const checks = {
  "全开 exit 0": codeOn === 0,
  "缺省 exit 0": codeOff === 0,
  "全开: spawn_subagent 挂载": toolsOn.includes("spawn_subagent"),
  "全开: run_ptc_script 挂载": toolsOn.includes("run_ptc_script"),
  "全开: cron_schedule 挂载": toolsOn.includes("cron_schedule"),
  "全开: dream 记忆注入 system": sysOn.includes("记住:用户偏好简洁回复"),
  "全开: time-context 注入(含上海时区)": /Asia\/Shanghai|GMT\+8|08:00/.test(sysOn),
  "缺省: 无 dream 注入": !sysOff.includes("记住:用户偏好简洁回复"),
  "缺省: 无 time-context": !/Asia\/Shanghai/.test(sysOff),
  "缺省: 工具面=8 件(无 subagent/ptc/cron)": toolsOff.length === 8 && !toolsOff.includes("spawn_subagent") && !toolsOff.includes("run_ptc_script"),
};
console.log(JSON.stringify({ codeOn, codeOff, toolsOnCount: toolsOn.length, toolsOffCount: toolsOff.length, toolsOff, checks }, null, 1));
fake.stop?.();
for (const d of CLEANUPS) rmSync(d, { recursive: true, force: true });
