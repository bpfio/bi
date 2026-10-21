# bi CLI 覆盖测试 T1-B + T1-C 结果

- 被测物：`bun /home/yupeng/bi/bin/bi.ts`（仓库版 bi 0.3.0；未用 PATH 上的旧 npm 包）
- 环境：`HOME=/tmp/cov-t1/home`，伪端点 `http://127.0.0.1:46531`（anthropic 形态 echo），`BI_COV_KEY=dummy`
- 证据目录：`/tmp/cov-t1/logs/`（各命令原始 stdout/stderr 均落盘）
- 退出码判定：全部脱离管道直取（`cmd; E=$?`）

## T1-B（七组）

PASS B1a —— `bi upgrade --help` 面完整：exit=0，含「bi upgrade [--check] [--manifest-url <url>]」+ 2 参数说明 + 2 示例
PASS B1b —— upgrade 只读检查存在且不换装：`bi upgrade --check --manifest-url http://127.0.0.1:46532/manifest.json` → exit=0，输出「最新版本 99.0.0;当前 0.3.0;去掉 --check 执行升级」（仅拉 manifest 比对版本，不下载不替换）；无 manifest 源时 exit=4 +「未配置 manifest 源」
PASS B2a —— vis 页面可取：`bi vis --port 46540` → `GET /` http=200（8304 字节 HTML）、`GET /api/sessions` http=200（JSON 数组）
PASS B2b —— vis 令牌面生效（`BI_VIS_TOKEN_ROTATE=1`，启动行打印「访问链接（含令牌）→ …?t=<token>」）：无 token `GET /api/sessions` → http=401 `{"error":"unauthorized"}`；带 `?t=<token>` → http=200（JSON 会话数组）
PASS B2c —— vis SIGINT 干净退出：kill -INT 后 wait 退出码=130，stderr 空、无原始栈（`^\s+at ` 零命中）
PASS B3 —— acp initialize 帧：`Content-Length: 95\r\n\r\n{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}` 喂 stdin → 回帧 `{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{},"authMethods":[]}}`，exit=0（stderr 汇总 initialize=1 parseError=0）
PASS B4a —— worktree create：临时 git 仓 `git init`+commit 后 `bi worktree create --task t1` → exit=0，`{"action":"create","taskId":"t1","branch":"bi-task-t1","worktreePath":"…/.bi/worktrees/t1"}`
PASS B4b —— worktree list 可见：`bi worktree list` → exit=0，stdout 1 行 t1 JSON + stderr「共 1 个工作树」
PASS B4c —— worktree merge 回主支：`bi worktree merge --task t1` → exit=0，`{"action":"merge","merged":true,"commit":"df91e58…","removed":true}`；主支实测 `git log` 顶部=df91e58 bi: merge back task t1、`feature.txt` 已入 master、工作树已清理
PASS B4d —— worktree discard 第二个：`bi worktree create --task t2` exit=0 → `bi worktree discard --task t2` exit=0 `{"removed":true,"branchDeleted":true}`；`bi worktree list` 收尾 exit=0「共 0 个工作树」、`git branch` 仅剩 master
PASS B5a —— dag run 成功：`bi dag run spec-ok.json --workflow-id wf-ok`（a→b,c 并行→d，shell handler echo）→ exit=0，4 步 outcome=ok，stderr「status=completed steps=4 skipped=0」
PASS B5b —— dag 必败步骤结构化失败：把 b 改成 `exit 3` → exit=1，stdout `{"step":"b","outcome":"failed","error":"shell 步骤 \"b\" 退出码 3"}` + `{"step":"d","outcome":"skipped"}`，stderr「status=failed … failed=b」
PASS B5c —— dag 修复后重跑：b 改回 echo → `bi dag run spec-fixed.json --workflow-id wf-fixed` → exit=0，stderr「status=completed steps=4 skipped=0」
FAIL B6a —— a2a 无 token 请求未被拒：`bi a2a host`（`BI_A2A_TOKEN=abc`）后 `curl http://127.0.0.1:36339/` → **http=200** `{"service":"bi-a2a","status":"ok"}`（期望 401/403）；非回环绑定复测 `listen="0.0.0.0:46550"` + `BI_A2A_TOKEN=secret-token` → 无 token 仍 http=200；HTTP 层完全不校验令牌（`core/src/cli/a2a-host.ts:107` 的 fetch 无条件返回探活 JSON，token 只交给未接线的 A2aHost 对象）
  复现：`HOME=/tmp/cov-t1/home BI_A2A_TOKEN=abc bun /home/yupeng/bi/bin/bi.ts a2a host` → 记 stdout 的 `"address"`，再 `curl -i http://<address>/` → 期望 401，实测 200
PASS B6b —— a2a 带 token 请求 200 且是合法 JSON：`curl -H "Authorization: Bearer abc" http://127.0.0.1:36339/` → http=200 `{"service":"bi-a2a","status":"ok"}`；`?t=abc` 同为 200
PASS B6c —— a2a SIGINT 干净收场：kill -INT → wait 退出码=0，stderr「bi a2a: host 已关闭（127.0.0.1:36339）」，无原始栈
PASS B7a —— plugins list：`~/.bi/plugins/demo/plugin.json`（name/version/description/mcpServers）+ `skills/hello/SKILL.md` → `bi plugins list` exit=0，stdout 1 行 `{"name":"demo","version":"1.0.0","protocol":"zcode","skills":1,"mcpservers":1}`
PASS B7b —— plugins validate：`bi plugins validate` exit=0，stdout `{"name":"demo","dir":"…","ok":true,"problems":[]}`
PASS B7c —— plugins 坏条目警告不阻塞：再加 `~/.bi/plugins/bad/plugin.json`（坏 JSON）→ `bi plugins list` 仍 exit=0 且仍出 1 条 good 插件，坏条目只进 stderr 警告「[manifest-malformed] 清单 JSON 解析失败」；`bi plugins validate` exit=1 并结构化报 `{"name":null,"ok":false,"problems":["[manifest-malformed] …"]}`

## T1-C（两组）

PASS C8a —— pty 启动横幅含提示：`python3 /home/yupeng/bi/scripts/pty-probe.py --rows 40 --cols 110 --keys '/help\r\r/exit\r\r' -- bun /home/yupeng/bi/bin/bi.ts` → 首屏 system 行「？ 指令与键位：输入 /help 查看 · 退出：Ctrl+D 或 /exit」，另有「bi: 模型已装配 provider=fake mode=messages model=fake-1」
PASS C8b —— /help 回执含指令目录：回执 system 行含「── 指令 ──」表，逐条列 `/btw <问题> /mode [plan|edit|build|yolo] /compact [提示词] /rewind [N] /clear /diff /copy /permissions /help /exit（别名 /quit）` +「── 键位 ──」表（Ctrl+C/Ctrl+D/Esc/Ctrl+F/Ctrl+E）
PASS C8c —— /exit 进程退出码 0：探针末尾 `---exit=0`；屏幕回执「[exit] 已退出 REPL（会话按当前状态收束）」+ 状态行「[build] [已退出]」（同序列的 `/help \r/exit \r` 变体亦 exit=0）
PASS C9a —— headless stream-json：`bi --prompt "形态一探针" --output-format stream-json` → exit=0，末帧 `{"type":"session_done","sessionId":"01a15bc1-f198-…","exit":"ok","rounds":1,"finalText":"ECHO:形态一探针"}`
PASS C9b —— headless text：`bi --prompt "形态二探针" --output-format text` → exit=0，stdout 仅 1 行 21 字节纯文本 `ECHO:形态二探针`（无事件帧、无 session_done）
PASS C9c —— headless json：`bi --prompt "形态三探针" --output-format json` → exit=0，stdout 单对象 1 行 `{"sessionId":"01a15bc1-f708-…","title":"形态三探针","rounds":1,"usage":{"inputTokens":8,"outputTokens":3},"reply":"ECHO:形态三探针","exit":"ok"}`（python 校验 keys_ok=True）
PASS C9d —— resume 续会话：`bi --resume 01a15bc1-f198-7896-8be3-ae5e8b669323 --prompt "再说一句" --output-format stream-json` → exit=0，末帧 session_done 同 sessionId、finalText="ECHO:再说一句"；`~/.bi/sessions` 原会话 jsonl 由 576 → 1032 字节（+456），追加 user/assistant 两条（seq=3/4，parentId 链式），会话文件数不变（续写原会话，符合「原会话追加」判据）

## 备注（非判定项）

- config schema（`packages/core/src/config/schema.ts`）**没有 `[vis]` 分区**（ROOT_SECTION_SCHEMAS 只有 workspace/providers/models/secondary_model/thinking/loop_control/tools/permission/read/image/identity/watch/hooks/telemetry/mcp/a2a/tui）。vis 只能走 CLI 旗标（`--port/--host`）+ 环境变量令牌。手工往 config.toml 加 `[vis] enabled=true` 后 `bi config list` exit=0 且该块被静默丢弃（既不进键表也无未知键告警）。
- TUI 斜杠命令的候选菜单会吃掉第一次 Enter（先补全会缀空格，第二次 Enter 才提交）；`/help`+Enter 一次不会出指令表，需再按一次 Enter。属 F-ST-11 既有设计，非崩溃。

PASS 总数：25
FAIL 总数：1

产品缺陷候选清单：
1. 【中危·安全】`bi a2a host` 的 HTTP 面完全不做令牌校验：`core/src/cli/a2a-host.ts` 的 `Bun.serve.fetch` 无条件返回 `{"service":"bi-a2a","status":"ok"}`，`BI_A2A_TOKEN` 只被塞进未接线的 `A2aHost`（只用于信封签名/验签，无 HTTP 校验路径）。后果：配了令牌仍可无凭据访问；`--listen 0.0.0.0:PORT` 时等于把服务裸奔暴露到网段。触发条件：config `[a2a] enabled=true` + 任意 listen。修复方向：fetch 内按 `Authorization: Bearer`/`?t=` 校验令牌，失败 401（对齐 `bi vis` 的令牌门禁）。
2. 【低危·配置面】vis 无 config 分区：`[vis]` 块被配置层静默丢弃（`bi config list` 无该键、无未知键告警），用户按文档直觉写 `[vis] enabled=true` 得不到任何效果也无提示。
