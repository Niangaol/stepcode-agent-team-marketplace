# agent-team 插件

一支覆盖成熟工程团队完整环节的智能体团队，通过 Step Code 插件市场（路线 B）分发，附带 team-gate 协作门禁（A2A）。**v2.0.0**：server 重构为三层架构，新增团队隔离、状态持久化、stale 检测。

## 十二个角色

| 环节 | 角色 | 职责 | 工具边界 |
| - | - | - | - |
| 需求澄清 | analyst | 把模糊需求变成可判定的验收标准、边界与影响面 | 只读 |
| 代码调研 | scout | 定位文件、调用链、现有约定，带证据 | 只读 |
| 缺陷定位 | debugger | 复现收敛、二分定位、根因证据链（不修） | 只读 + 只读命令 |
| 方案设计 | architect | 编号执行步骤，每步带完成标准与回滚 | 只读 + 只读命令 |
| 编码实现 | builder | 按方案精确实现并自验 | 读写 |
| 测试保障 | tester | 基线 + 补测，验证测试会红，只许改测试 | 读写（限测试） |
| 功能审查 | reviewer | 正确性/回归/约定，分级问题清单 | 只读 + 只读命令 |
| 安全审计 | security-auditor | 注入、越权、密钥、敏感数据、依赖风险 | 只读 + 只读命令 |
| 性能把关 | perf-engineer | 热点、复杂度、IO，用测量数字说话 | 只读 + 只读命令 |
| 界面审查 | ux-reviewer | 状态覆盖、交互反馈、文案、可访问性 | 只读 |
| 文档同步 | docs-writer | README/API/CHANGELOG 与代码事实一致 | 写文档 |
| 交付发布 | release-engineer | 构建验证、版本检查、发布清单与回滚方案 | 读写交付文件 |

附带 `team-playbook` skill（环节映射 + 五种编排模式）与 `/team-implement`、`/team-debug`、`/team-review`、`/team-ship` 四条命令。

## team-gate：六个协作工具

零依赖 stdio MCP server（Node ≥ 18），全部工具接受 `team` 参数做团队隔离：

| 工具 | 使用者 | 作用 |
| - | - | - |
| `mcp__team-gate__team_wait` | 主智能体 | **主动暂停运行**，阻塞等待任务完成信号。`expect: [标签...]` 等全部；`mode: "any"` 等任意一个；`timeoutMs` 超时返回 pending + **stale 失联清单**；`reset` 只清本团队 |
| `mcp__team-gate__agent_done` | 子智能体 | 发送**任务完成信号**（label / status / summary / artifacts） |
| `mcp__team-gate__agent_report` | 子智能体 | 注册/更新自己的存在与**当前任务**（upsert，定期调用可续期防失联） |
| `mcp__team-gate__team_status` | 任何 agent | **实时总览**：本团队 label、角色、当前任务、状态、最后更新、stale 清单、主代理等待中的标签、所有团队规模 |
| `mcp__team-gate__agent_send` | 任何 agent | **A2A 消息**：点对点（to=对方 label）或广播（to="*"），仅本团队内投递 |
| `mcp__team-gate__agent_recv` | 任何 agent | 读取发给我的未读消息（含广播），默认标记已读 |

## 架构（v2.0.0 三层，零依赖）

```text
agent-team/server/
├── state.mjs      状态层：团队隔离存储 + 原子持久化
│                  · 每个 team 独立 signals/presence/messages
│                  · 落盘 <插件目录>/state/teams.json（TEAM_GATE_STATE_FILE 可覆盖）
│                  · 防抖 50ms + tmp 原子替换 + 退出前同步；重启自动恢复
│                  · 损坏文件自动备份从空启动；团队数上限 50（LRU 淘汰）
├── tools.mjs      工具层：六个工具的定义与实现，team 参数解析、stale 检测
└── team-gate.mjs  协议层：MCP over stdio JSON-RPC 2.0 收发（stdout 只走协议）
```

**设计取舍**：
- **团队隔离**：并发跑多个团队时 label 不再串扰；`reset` 只影响当前团队；`team_status` 的 `teams` 字段可发现其他并行团队。
- **持久化**：进行到一半的团队在 MCP server/应用重启后恢复，信号、在线状态、消息不丢。
- **stale 检测**：子代理超过 `staleAfterMs`（默认 5 分钟）未 `agent_report` 即判失联，`team_wait` 超时返回时列出，避免主代理干等；长任务中子代理定期 `agent_report` 续期。

## A2A 协作模型

- **实时可见**：每个子代理开始执行时 `agent_report` 注册，阶段推进时更新 `task`；任何 agent 随时 `team_status` 看到谁在做什么、什么状态、主代理在等谁。
- **直接通信**：结论、依赖、警告用 `agent_send` 点对点或广播；接收方在动手前与关键节点 `agent_recv` 读取。消息用于协调，不替代各自的任务输出。
- **里程碑语义（关键）**：`agent_done` 信号标记的是「分配的必要任务已完成」这个里程碑，**不是子智能体终止**。子智能体发完信号后继续执行后续工作；主智能体 `team_wait` 收齐信号即恢复运行并汇总。同一子智能体可用不同 label 发多次里程碑信号，主智能体用 `mode=any` 渐进式汇总。
- **补充信息**：要向仍在运行的子智能体追加指令，single 模式后台通道用 `agent_send` 的 `reply`（内置工具，非本插件）；其他情况重新派发并沿用原 label。

**典型流程**：

1. 主智能体为本次任务分配团队名（如 `impl-1`），派发时把 label 与 team 写进任务文本。
2. 子智能体 `agent_report` 注册 → 执行中随时 `team_status`/`agent_recv` 掌握全局 → 必要时 `agent_send` 通知同伴。
3. 子智能体完成必要任务 → `agent_done` → 继续执行。
4. 主智能体 `team_wait` 暂停，收齐期望 label 的信号后恢复，按 status/summary 汇总。

## 编排模式

| 模式 | 角色链 | 命令 |
| - | - | - |
| 全流程 | analyst → scout → architect → builder → tester → reviewer（按需叠加安全/性能/UI/文档） | `/team-implement` |
| 缺陷修复 | debugger → builder → tester → reviewer | `/team-debug` |
| 并行审查 | reviewer / security-auditor / perf-engineer / ux-reviewer 多视角并行 | `/team-review`、`/team-ship` 前半 |
| 发布把关 | 四路并行审查 → docs-writer → release-engineer | `/team-ship` |

## 安装

在 Step Code 会话中把本目录加入市场源并安装：

```text
/plugin marketplace add ./agent-team
/plugin install agent-team
```

或在插件管理菜单 `/plugin` 中操作。**本插件含 MCP server，安装后需重启 Step Code**，再用 `/mcp` 确认 `team-gate` 已加载（应看到上表六个工具）。

## 目录结构

```text
agent-team/
├── step.plugin.json          # 插件清单（id 必填，含 mcpServers）
├── server/                   # team-gate 三层架构（state / tools / protocol）
├── agents/                   # 12 个角色定义（Markdown + frontmatter）
├── skills/team-playbook/     # 编排手册（环节映射 + A2A + 信号语义 + 团队隔离）
└── commands/                 # team-implement / team-debug / team-review / team-ship
```

## 安全说明

`server/*.mjs` 是 stdio MCP 服务器，按当前用户权限执行，但代码零依赖、只做进程内状态记录与本地状态文件（在线名单、信号、消息，各有 200 条上限；团队数 50 上限），不访问网络、不读取工作区文件、不请求凭据。角色 prompt 只引导子代理读写工作区文件。安装前可自行阅读全部源码。

## 排错

- `/mcp` 里看不到 team-gate：确认已重启；确认 Node 在 PATH 且版本 ≥ 18。
- 若相对路径 `./server/team-gate.mjs` 解析失败：把 `step.plugin.json` 中 `mcpServers.team-gate.args` 改为该文件的绝对路径。
- `team_wait` 一直超时：看返回里的 `stale`（失联标签）与 `recentSignals`，核对 label 与 `team` 是否一致。
- 状态异常：删除 `<插件目录>/state/teams.json` 后重启即可从零开始（不影响插件功能）。
- 看不到某个 agent：它还没 `agent_report`；消息没收到：确认 `agent_recv` 的 label 与发送时 `to` 一致、team 一致，或消息已被标记已读。
