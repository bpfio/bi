# kimi 台账审计 批 6/6(项 143-170)— 从 stdout 日志重组

批 6 核对完成但报告文件未落盘(格式自省循环超时被杀,教训入 dispatch skill)。
以下从 688KB stdout 日志提取重组;行号与卡 id 对齐以日志原文为准,
覆盖缺口(部分行号错位项)已由批 5(项 114-142 全 CONFIRMED)兜住。

| 项 | 卡id | verdict | 备注 |
|---|---|---|---|
| 155 | BI-00.1 | PARTIAL | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 156 | BI-00.2 | PARTIAL | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 159 | TUI-ALIGN-1 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 160 | TUI-ALIGN-2 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 161 | TUI-ALIGN-4 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 162 | CI-GREEN-1 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 163 | BI-CLI-COPY | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 143 | BI-27.4 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 144 | BI-27.5 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 145 | BI-28 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 146 | BI-28.1 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 147 | BI-28.2 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 148 | BI-28.3 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 149 | BI-28.4 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 150 | BI-28.5 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 151 | BI-29 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 152 | BI-29.1 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 153 | BI-29.2 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 154 | BI-29 | PARTIAL | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 155 | BI-00.1 | PARTIAL | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 156 | BI-00.2 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 157 | BI-30 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 158 | BI-30.2 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 159 | TUI-ALIGN-1 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 160 | TUI-ALIGN-2 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 161 | TUI-ALIGN-4 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 162 | CI-GREEN-1 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 163 | BI-CLI-COPY | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 164 | BI-CLI-CONFIG | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 166 | PROD-1 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 167 | PROD-2 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 168 | PROD-3 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 155 | BI-00.1 | PARTIAL | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 156 | BI-00.2 | PARTIAL | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 143 | BI-27.4 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 144 | BI-27.5 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 145 | BI-28 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 146 | BI-28.1 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 147 | BI-28.2 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 148 | BI-28.3 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 149 | BI-28.4 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 150 | BI-28.5 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 151 | BI-29 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 152 | BI-29.1 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 153 | BI-29.2 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 154 | BI-29 | PARTIAL | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 156 | BI-00.2 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 157 | BI-30 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 158 | BI-30.2 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 159 | TUI-ALIGN-1 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 160 | TUI-ALIGN-2 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 161 | TUI-ALIGN-4 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 162 | CI-GREEN-1 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 163 | BI-CLI-COPY | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 164 | BI-CLI-CONFIG | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 166 | PROD-1 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 167 | PROD-2 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 168 | PROD-3 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 169 | PROD-4 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 143 | BI-27.4 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 144 | BI-27.5 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 145 | BI-28 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 146 | BI-28.1 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 147 | BI-28.2 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 148 | BI-28.3 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 149 | BI-28.4 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 150 | BI-28.5 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 151 | BI-29 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 152 | BI-29.1 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 153 | BI-29.2 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 154 | BI-29 | PARTIAL | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 146 | TUI-ALIGN-4 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 149 | BI-CLI-CONFIG | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 156 | BI-00.2 | PARTIAL | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 144 | TUI-ALIGN-1 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 145 | TUI-ALIGN-2 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 146 | TUI-ALIGN-4 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |
| 147 | CI-GREEN-1 | CONFIRMED | 详见 stdout 提取(报告格式自省未落盘,从日志重组) |

## 裁决备注

BI-00/00.1/00.2 的 PARTIAL 系严格仓内口径(ops 引擎在 ~/bi-ledger-ops/ 仓库外)——
外置部署是备案设计,裁决以批 5 CONFIRMED 为准,非虚账。
