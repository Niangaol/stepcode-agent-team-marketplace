---
description: 发布把关流程：功能/安全/性能/UI 四路并行审查 → 文档同步 → 交付检查与回滚方案
---

对当前工作区改动执行发布前把关。

第一步，parallel 并行派发四路审查，各自只读，分配 label：
- **reviewer**（label: ship-func）：正确性、回归、约定违反。
- **security-auditor**（label: ship-sec）：注入、越权、密钥、敏感数据、依赖风险。
- **perf-engineer**（label: ship-perf）：热路径、复杂度、IO，输出测量数字。
- **ux-reviewer**（label: ship-ui）：状态覆盖、交互反馈、文案、可访问性；需视觉确认的点列出来。

派发后调用 mcp__team-gate__team_wait（expect 为四个 label）主动暂停，收齐信号后合并：按 [阻塞]/[高危] 优先排序，给出「可以发布 / 需修改后发布」结论。

第二步（仅无阻塞项时继续）：
- **docs-writer**（label: ship-docs）：按代码事实同步 README/API/CHANGELOG。
- **release-engineer**（label: ship-rel）：跑构建与打包、检查版本号与 CHANGELOG、输出发布清单与回滚方案（含可逆性结论）。

最终汇总：阻塞项清单（若有）、构建真实输出、发布清单、回滚步骤。全程不修改业务代码。
