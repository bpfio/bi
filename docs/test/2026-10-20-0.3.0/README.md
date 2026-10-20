# 0.3.0 全功能测试执行档案

- 计划：docs/test-plan-0.3.0.md（A-G 七组矩阵）
- 执行：A/C 组主控真机（longcat）；B/D/F 组派 codebuddy hy3 两单（t/t2）
- 事故实录：两单 exit 137——执行代理跑 D2 崩溃恢复测试时 kill -9 打击面失控误杀自身进程树；教训=崩溃类测试 kill 必须钉死单 PID（$! 形式），派工简报需显式约束
- 结果：results.md（A/B/C 组全 PASS+D 组主控接管补全）；五缺陷修复见 DEVLOG 二十三节
