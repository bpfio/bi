import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeEndpoint } from "/home/yupeng/bi/scripts/fake-endpoint";
import { runBi } from "/home/yupeng/bi/packages/core/src/cli/main";

const scene = process.env.ORGAN_SCENE ?? "off";
const fake = startFakeEndpoint({ echo: true });
const FAKE_URL = fake.url;
const CLEANUPS: string[] = [];
const home = mkdtempSync(join(tmpdir(), "organ1-home-"));
const proj = mkdtempSync(join(tmpdir(), "organ1-proj-"));
CLEANUPS.push(home, proj);
mkdirSync(join(home, ".bi"), { recursive: true });
const SECTIONS: Record<string, string> = {
  memory: "[memory]\ndream_enabled = true\ninject_enabled = true",
  context: "[context]\ntime_context = true\ntimezone = \"Asia/Shanghai\"",
  subagent: "[subagent]\nenabled = true",
  ptc: "[ptc]\nenabled = true",
  cron: "[cron]\nenabled = true",
  off: "",
  all: "[context]\ntime_context = true\ndate_change_sensor = true\ntool_result_prune = true\ntimezone = \"Asia/Shanghai\"\n[subagent]\nenabled = true\n[ptc]\nenabled = true\n[cron]\nenabled = true\n[memory]\ndream_enabled = true\ninject_enabled = true",
};
writeFileSync(join(home, ".bi", "config.toml"), [
  "[providers.entries.fake]", 'api_key_env = "BI_FAKE_KEY"', `base_url = "${FAKE_URL}"`,
  'kind = "anthropic"', 'models = ["fake-echo"]', "", "[providers]", 'default = "fake"',
  "", "[models]", 'default = "main"', "", "[models.entries.main]", 'provider = "fake"', 'model = "fake-echo"',
  SECTIONS[scene] ?? "",
].join("\n"));
writeFileSync(join(proj, "BI.dream.md"), "- 记住:用户偏好简洁回复\n");
process.chdir(proj);
process.env.BI_FAKE_KEY = "smoke-key";
const timer = setTimeout(() => { console.log("VERDICT: HANG"); process.exit(9); }, 22000);
const code = await runBi(["--prompt", "冒烟", "--output-format", "stream-json"], {
  headless: { homeDir: home, permissionMode: "yolo" } as any,
});
clearTimeout(timer);
const req = fake.requests[fake.requests.length - 1];
const sys = JSON.stringify({ s: (req as any).system, m: req.messages?.filter((m: any) => m.role === "system") ?? [] });
const tools: string[] = (req.tools ?? []).map((t: any) => t.name);
console.log("VERDICT:", JSON.stringify({ scene, code, toolsN: tools.length, has: {
  spawn: tools.includes("spawn_subagent"), ptc: tools.includes("run_ptc_script"),
  cron: tools.includes("cron_schedule"), dream: sys.includes("记住:用户偏好简洁回复"),
  tz: /Asia\/Shanghai/.test(sys),
}}));
fake.stop?.();
for (const d of CLEANUPS) rmSync(d, { recursive: true, force: true });
process.exit(0);
