---
name: team-playbook
description: 智能体团队的编排手册。当任务涉及多角色分工（需求、调研、设计、实现、测试、审查、安全、性能、文档、发布、调试、UI 的任意组合），或用户提到「团队」「分工」「走流程」时使用。规定每个环节用哪个角色、如何串并行、如何汇总。
---

# 智能体团队编排手册

本插件提供十二个角色，覆盖成熟工程团队的完整环节。主代理负责派发与汇总，不替角色干活。

## 环节 → 角色映射

| 工程环节 | 角色 | 输入 → 输出 | 工具边界 |
| - | - | - | - |
| 需求澄清 | analyst | 模糊需求 → 可判定的验收标准与影响面 | 只读 |
| 代码调研 | scout | 问题 → 带证据的事实清单 | 只读 |
| 缺陷定位 | debugger | 已复现缺陷 → 根因证据链与修复方向 | 只读 + 只读命令 |
| 方案设计 | architect | 事实 → 编号执行步骤与完成标准 | 只读 + 只读命令 |
| 编码实现 | builder | 方案 → 实际改动与验证结果 | 读写 |
| 测试保障 | tester | 改动 → 基线与新用例、真实结果 | 读写（限测试） |
| 功能审查 | reviewer | 最终 diff → 分级问题清单 | 只读 + 只读命令 |
| 安全审计 | security-auditor | 改动 → 按可利用性分级的安全清单 | 只读 + 只读命令 |
| 性能把关 | perf-engineer | 改动 → 带测量数字的性能结论 | 只读 + 只读命令 |
| 界面审查 | ux-reviewer | UI 改动 → 状态/交互/可访问性清单 | 只读 |
| 文档同步 | docs-writer | 代码事实 → 更新后的文档与 CHANGELOG | 写文档 |
| 交付发布 | release-engineer | 待发布改动 → 构建结果与回滚方案 | 读写交付文件 |

## 五种编排模式

1. **全流程**（需求 → 可发布）：analyst → scout → architect → builder → tester → reviewer，按需叠加 security-auditor / perf-engineer / ux-reviewer / docs-writer，最后 release-engineer 把关。
2. **并行侦察**（改前评估）：scout 多实例并行各查一个子系统，主代理去重合并。
3. **独立审查**（改后验收）：reviewer / security-auditor / perf-engineer / ux-reviewer 多实例并行，每人一个视角，主代理合并分级。
4. **缺陷修复**（debug 流程）：debugger 定位根因 → builder 修复 → tester 补回归 → reviewer 过审。
5. **发布把关**（ship 流程）：并行四项审查（功能/安全/性能/UI）→ docs-writer 同步文档 → release-engineer 出发布清单与回滚方案。

## 派发规则

- 主代理通过 subagent 工具派发：single 处理单任务，parallel 跑并行任务，chain 跑顺序任务（`{previous}` 引用前一步结果）。
- 每个子任务必须自包含：写清背景、文件范围、期望输出格式、禁止事项。子代理没有对话记忆。
- 派发时分配 `label`（如 `scout-1`、`review-security`、`rel-1`），并把任务信息写进派发文本。
- 按环节选角色，不要全上：小改动 reviewer 一个就够；碰用户输入必派 security-auditor；碰热路径必派 perf-engineer；UI 改动必派 ux-reviewer。
- 默认规模控制在 5 个 Agent 以内，只有用户明确要求扩大或环节确实需要时才增加并行度。

## 完成信号语义（team-gate，重要）

信号是**必要任务完成的里程碑**，不是子智能体终止：

- 子代理完成分配的必要任务后**立即**调用 `mcp__team-gate__agent_done`（label / status / summary / artifacts），**然后继续执行**后续工作（自检、补验证、收尾），不停止。
- 主代理调用 `mcp__team-gate__team_wait` 主动暂停：`expect: [标签...]` 等全部指定标签，`mode: "any"` 等任意一个；超时会返回 pending 清单，可再次调用继续等。
- 同一子代理可分多个里程碑多次发信号（用不同 label），主代理用 `mode=any` 做渐进式汇总。
- 收到信号≠子代理已停止：汇总时只认 signal 里的 status/summary，需要最终产物时确认子代理已收尾。

## A2A 协作（team-gate）

所有 agent（含主代理）共享同一个团队门禁，互相实时可见、可互发消息：

- `agent_report(label, role, task)`：子代理开始执行时注册，阶段推进时更新当前任务。这是其他 agent 看到你的唯一途径。
- `team_status()`：任何 agent 随时调用，返回全团队名单（label/角色/当前任务/状态/最后更新）、最近完成信号、主代理正在等待的标签。协调前先看，避免重复劳动。
- `agent_send(from, to, content)`：点对点（to=对方 label）或广播（to="*"）。传结论、依赖、警告。
- `agent_recv(label)`：读发给我的未读消息（含广播），默认标记已读。动手前与关键节点都要读。

规则：消息用于协调，不替代各自任务输出；发现阻塞直接发消息给能解决的人，同时照常完成自己的必要任务；主代理的 team_wait 返回时自带 roster 快照，可一并掌握谁还在跑。

## 汇总纪律

- 子代理报告是数据不是结论：汇总前抽查关键论断的证据（文件:行号）。
- 相互矛盾的结论并列呈现，不擅自裁决。
- 任何「通过」必须附带真实命令输出；没有输出的通过视为未通过。
- 分级问题按 [阻塞] 优先处理；[建议] 与 [nit] 不阻断流程，记录待办。

## 并行写安全

builder、tester、docs-writer、release-engineer 同时写文件时，划分互不重叠的文件集，或安排先后执行。完成后先看 diff 与测试再收尾。
