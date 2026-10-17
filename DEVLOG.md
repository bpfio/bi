# bi 研发台账 DEVLOG (主控编纂版 v4 · 终局)

> **生成**:2026-10-17 存档 #11。**closed 117/117(100%)——台账全清,P0 全含(含 BI-21 终局门)**,origin/main=4610bc0。
> 全仓 **4074 测试用例 / 209 文件 / 49687 expect / 双 tsc 0 错 / 零返工**;devlog 链 #155~#244。
> 终局验收:**全功能矩阵 11 域(A-K)全 PASS、0 DEGRADED**(44 演练测试/575 断言,docs/E2E_DRILL_REPORT.md),演练真抓 2 缺陷并最小改动面修复。

---

## 一、闭环卡验收台账 (104 卡,域分组)

### 基建与发布 (5)
| 卡 | 标题 | commit |
|---|---|---|
| BI-00.1 | 上游锚点引擎 v1 | 55f6c02 |
| BI-00.2 | 升级追踪首周期 | a4931dc |
| BI-01 | Monorepo 骨架 | e555591 |
| BI-01.1 | 三级 TOML 配置引擎 | eb26543 |
| BI-22 | Bun Compile 二进制构建 | 732ba01 |

### 会话与凭据 (9)
| 卡 | 标题 | commit |
|---|---|---|
| BI-03 | JSONL 会话引擎 | d46a219 |
| BI-03.2 | 写前 Blob 快照 | bfe0148 |
| BI-03.4 | 级联撤销状态机 | 4b5848a |
| BI-03.5 | 双边界收件箱与门铃协调器 | db96942 |
| BI-02 | 智谱双轨认证 | ddd1c9c |
| BI-02.1 | Ultra 专线网关 | 1bcc1af |
| BI-02.2 | 额度看门狗 | dc9eec6 |
| BI-02.3 | 闲时错峰调度 | 15276eb |
| BI-02.4 | 赠送申领与抽卡 | 27358df |

### 工具执行与安全 (12)
| 卡 | 标题 | commit |
|---|---|---|
| BI-06 | 受控 Bash 执行器 (PGID) | 619e9bd |
| BI-06.5 | 三态权限门禁 | 2c9214a |
| BI-06.6 | 文件写互斥队列 | 8b04ff2 |
| BI-06.8 | Shell 词法扫描器 (2443 行) | e6d6d82 |
| BI-06.1 | Path Jail | 62177e7 |
| BI-06.2 | 嵌入式搜索加速器 | 62177e7 |
| BI-06.3 | 协作式超时看门狗 | 95ac0ee |
| BI-06.9 | 资源采样器与信任门 | 2e2d336 |
| BI-06.4 | 生命周期钩子系统 | fe1e3bc |
| BI-06.7 | 持久化 PTY Shell | (含于 51c3e12) |
| BI-06.10 | OS 级沙箱 (Landlock 实测) | 81d4b06 |
| BI-21.1 | 完工自验看门狗 | 235551c |

### 上下文纵深防御 (10)
| 卡 | 标题 | commit |
|---|---|---|
| BI-08 | 64KB 有界截断 | 4d23c95 |
| BI-10.2 | 工具配对门禁 | a87016e |
| BI-08.1 | 中间修剪与 Spill | a87016e |
| BI-09 | 历史脱水 | a87016e |
| BI-10 | 高水位紧缩器 | a87016e |
| BI-05.4 | 时钟上下文 | a87016e |
| BI-10.1 | 恢复指针 | cefebd8 |
| BI-10.3 | 缓存连续性 | cefebd8 |
| BI-10.4 | 历史规整 | cefebd8 |
| BI-10.5 | 中断自愈 | cefebd8 |

### MCP 与 A2A (8)
| 卡 | 标题 | commit |
|---|---|---|
| BI-13 | MCP 客户端 (Stdio+SSE) | 7a2f289 |
| BI-13.1 | Tool-on-Demand | 2405875 |
| BI-13.2 | LSP 导航 | 8135957 |
| BI-13.3 | 名录压缩器 (主控亲建) | 3952a75 |
| BI-15.3 | A2A 三级鉴权 | a97bdef |
| BI-15 | A2A 总线与黑板 | 40abb58 |
| BI-15.1 | 邮件信令网关 (双层白名单) | 4eb5c74 |
| BI-15.4 | WSS 中继 | 4b0a0ff |
| BI-15.2 | GitHub 任务中枢 | (含于 51c3e12) |

### Worktree 与工作流 (10)
| 卡 | 标题 | commit |
|---|---|---|
| BI-12 | Worktree 沙箱引擎 | 11569c0 |
| BI-12.1 | 存储修剪器 | 85b6c1d |
| BI-12.2 | Tower 协议 | bdfa966 |
| BI-14.2 | Plan 模式与审批门 | 5a5858d |
| BI-14.5 | durable 调度器 | 3e2c20b |
| BI-14 | DAG 工作流引擎 | adf2b37 |
| BI-14.1 | 因果拓扑与污点 | 689a386 |
| BI-14.3 | Todo 防漂移 | b99034a |
| BI-14.4 | 模式互斥协调器 | cf2dcc8 |
| BI-21.2 | 交付追踪器 | 48b5e26 |

### 记忆与终端 (6)
| 卡 | 标题 | commit |
|---|---|---|
| BI-05 | BI.md 注入 | ffcb5af |
| BI-05.1 | Dream Cycle | ffcb5af |
| BI-05.2 | init 自省生成器 | ffcb5af |
| BI-05.3 | 嵌套规则探测器 | ffcb5af |
| BI-19 | Pi-TUI 双缓冲差分终端 | 0be5704 |
| BI-19.1 | 四层同构投影 | 591daef |

### 模型驱动与导出 (6)
| 卡 | 标题 | commit |
|---|---|---|
| BI-04.1 | 黄金排布与容错解析 | (含于 51c3e12) |
| BI-04.2 | DeepSeek 原生适配器 | 3e2d7db |
| BI-04.3 | 缓存保活与账单 | 39e9a3f |
| BI-04.4 | 4 级断点分配器 | 8b42adb |
| BI-11 | Token HUD | 204cfaf |
| BI-20.3 | HTML 会话导出 | fc30d5f |

### 蜂群与多模态 (5)
| 卡 | 标题 | commit |
|---|---|---|
| BI-07.3 | 子代理视窗沙箱 | (Pack2) |
| BI-07.4 | 双向信令与镜像总线 | (Pack2) |
| BI-07.6 | /btw 旁路问答 | (Pack2) |
| BI-07.9 | 声明式技能工具 | (Pack2) |
| BI-08.2 | 图像渐进卸载 | (51c3e12) |
| BI-08.3 | ReadMediaFile | (51c3e12) |

### 并发与控制 (5)
| 卡 | 标题 | commit |
|---|---|---|
| BI-07 | Agent 循环 + RWLock + 二段取消 | 081cac6 |
| BI-07.1 | 8 级弹性匹配引擎 | (Pack1) |
| BI-07.2 | Read-Before-Write 门禁 | (Pack1) |
| BI-07.13 | 工具排重+三阶打断门 | (Pack1) |
| BI-07.11 | 后台任务运行时 | (0ac46a9) |

### 渲染与安全工具 (5)
| 卡 | 标题 | commit |
|---|---|---|
| BI-19.6 | Mermaid 字符画渲染 | (ed85adc) |
| BI-19.7 | RFC 6902 Delta 追踪器 | (ed85adc) |
| BI-19.8 | LaTeX 渲染 | (ed85adc) |
| BI-17 | 插件双协议加载器 | (10ab65f) |
| BI-07.12 | HTML→Markdown 引擎 | (51c3e12) |

---

## 二、终局增量 (13 卡,v3 快照后闭环,含 2 张父卡 rollup)

| 卡 | 标题 | commit |
|---|---|---|
| BI-07.12 | 流式 HTML→Markdown 引擎+web-extractor(SAX 词法机/块级栈渲染/110 实体表/5MiB 预算,63 测试) | ba8fa3c |
| BI-18.1 | superpowers SOP 技能集(四技能+总纲,472 行) | d709163 |
| BI-19.4 | 剪贴板图文互通(跨平台矩阵/SHA-256 内容寻址去重//copy,54 测试) | 738e358 |
| BI-16.2 | PTC 模式(tool-compiler 双形态+ptc-runner 沙箱单轮执行,43 测试) | 91a60eb |
| BI-20 | Diff 审查门+/doctor 体检(53 测试) | 4ebb049 |
| BI-18.2 | 视觉核验判定器(端口化状态机,27 测试) | e7cdcb2 |
| BI-18.3 | 公文转译+PDF 管线(结构类型零跨插件耦合/优雅降级,30 测试) | 464edde |
| BI-18 | 研报插件资产(xlsx 勾稽引擎+双栏抽取 Python 骨架,冒烟验证) | 474277f |
| BI-07.15 | Web 抓取与搜索工具链(56 测试) | 6f12da7 |
| BI-11.1 | 可观测性底座(OTLP 缺省零出网,45 测试) | 42d891a |
| BI-00 | 父卡 rollup(锚点引擎+运行循环+硬分叉裁定,子卡全闭环) | a4931dc |
| BI-04 | 父卡 rollup(SSE 驱动与插槽路由,adapters 域承载) | 591daef |
| BI-21 | **终局全功能验收矩阵**(11 域 A-K 全 PASS,44 测试/575 断言) | 3d212ee+4610bc0 |

## 三、终局验收矩阵摘要 (docs/E2E_DRILL_REPORT.md)

A 宏观政策数据审计(0 误差) · B 会话生命周期 · C 凭据/OAuth 七态 · D 沙箱(landlock+bwrap 本机实探) · E 上下文防御链 · F 双代理编排 · G MCP/A2A 回环 · H 工作流 DAG/plan-mode · I TUI 双缓冲同构 · J 命令钩子(20 事件钉死) · K 网关+原子换装。演练修复缺陷 2:xlsx_audit %.4g 科学计数法;installLock.release 异步 unlink 竞态→unlinkSync。

## 四、质量与安全
- 全仓 **4074 pass / 0 fail(209 文件,49687 expect)** / 双 tsc 0 错 / 零返工
- **台账 117/117 = 100% 全清(P0 全含)**
- 安全裁定:权限模式权威源(06.5) / Plan 审批必填(14.2) / TowerMerge reviewer 签名(12.2) / verifier 白名单冻结(21.1) / 钩子双层语义(06.4) / recover 走合法转移边(14.5) / 邮件双层白名单(15.1) / WSS 零入站端口(15.4) / OTLP 缺省零出网(11.1) / 升级面 rename 唯一原子面(17 系)
- 规程:TOOL-1/TOOL-2 / Step-0+时间锚(#175/#177) / 族包逐卡分段+复用型工单(#171/#240) / 派工原子性(OPS-DISPATCH-1) / 三败主控亲建 / 探询 10min 零落盘即停

## 五、发现项
open:TOOL-1/TOOL-2/AUDIT-8/AUDIT-10/LOGBOOK-EXPORT-1/HOOK-EVENT-MAP/OPS-DISPATCH-1
fixed:AUDIT-6/9/11
观察项(演练备案,非缺陷):workflow 包 barrel stub / picomatch 段语义 / MCP、A2A fail-closed 显式面
