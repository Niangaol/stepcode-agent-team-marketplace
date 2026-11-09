# agent-team-marketplace

智能体团队（agent-team）的插件市场仓库。本仓库本身就是一个 Step Code 市场，添加一条命令即可使用。

## 安装

在 Step Code 会话中：

```text
/plugin marketplace add <本仓库URL>
/plugin install agent-team
```

也可以 fork 后用你自己的仓库 URL。安装后重启 Step Code，用 `/mcp` 确认 `team-gate` 已加载（6 个工具），用 `/plugin` 确认插件已安装。

## 插件内容

- **12 个角色**：analyst（需求）、scout（调研）、debugger（调试定位）、architect（设计）、builder（实现）、tester（测试）、reviewer（功能审查）、security-auditor（安全）、perf-engineer（性能）、ux-reviewer（界面）、docs-writer（文档）、release-engineer（交付）
- **team-gate 协作门禁**（零依赖 stdio MCP server，Node ≥ 18）：`team_wait`（主智能体主动暂停等待）、`agent_done`（任务完成信号）、`agent_report`（状态注册）、`team_status`（实时总览）、`agent_send`/`agent_recv`（A2A 消息）
- **team-playbook** 编排手册 + `/team-implement`、`/team-debug`、`/team-review`、`/team-ship` 四条命令

详见 [agent-team/README.md](agent-team/README.md)。

## 兼容性

- Step Code：读取 `agent-team/step.plugin.json`
- Claude Code：同目录附带 `.claude-plugin/plugin.json`，可直接作为 Claude Code 插件使用

## 本地校验

```bash
node scripts/validate-plugin.cjs   # manifest 与 frontmatter 校验
node scripts/test-gate.cjs         # team-gate 协议端到端自测
```

## 许可

MIT
