---
description: 缺陷修复流程：debugger 定位根因 → builder 修复 → tester 补回归 → reviewer 过审
---

对以下缺陷执行修复流程：$ARGUMENTS

按顺序派发，后一个角色以前一个角色的输出为输入：

1. **debugger**（label: debug-1）：固定复现步骤，二分缩小范围，输出根因证据链（文件:行号 + 机制解释）与修复方向。不修改文件。
2. **builder**（label: fix-1）：按 debugger 的根因与修复方向精确修复，遵循仓库约定，每步跑完成标准命令。不扩大范围。
3. **tester**（label: test-1）：先跑基线，再补针对该根因的回归用例，并验证测试会红（改坏实现确认）。只许改测试。
4. **reviewer**（label: review-1）：独立审查修复与测试，按 [阻塞]/[建议]/[nit] 分级。

主代理职责：每步自包含描述任务并分配 label；子代理完成必要任务即发 agent_done 信号并继续执行；chain 派发；汇总时抽查证据。debugger 未定位到根因时停下来向用户报告，不要带病修复。
