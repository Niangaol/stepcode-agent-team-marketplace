/**
 * tools.mjs — team-gate 工具层
 *
 * 职责：六个 MCP 工具的定义与实现，全部支持 team（团队）参数做状态隔离。
 *   team_wait      主智能体主动暂停，等待指定/任意子代理的任务完成信号
 *   agent_done     子智能体发送任务完成信号（里程碑，非终止）
 *   agent_report   子智能体注册/更新自己的状态与当前任务
 *   team_status    任何 agent 实时总览（含 stale 检测）
 *   agent_send     A2A 点对点/广播消息
 *   agent_recv     读取发给我的未读消息
 * 本层不感知 MCP 协议与 stdio 细节；阻塞轮询只操作内存中的 store。
 */
import { DEFAULT_TEAM, TeamStore, normalizeTeamId } from './state.mjs';

const POLL_MS = 150;
const WAIT_MIN_MS = 1000;
const WAIT_MAX_MS = 300000;
const WAIT_DEFAULT_MS = 90000;
const STALE_DEFAULT_MS = 300000;

const TEAM_PARAM = {
  team: {
    type: 'string',
    description:
      '团队标识：同一团队内的 label / 信号 / 消息互相可见，不同团队完全隔离。' +
      '使用主智能体派发时分配的团队名；省略时为 default。仅限字母数字 . _ - ，最长 64 字符。',
  },
};

export const TOOLS = [
  {
    name: 'team_wait',
    description:
      '主智能体专用：主动暂停当前执行，阻塞等待子智能体的任务完成信号（里程碑信号，非子智能体终止）。' +
      'mode=all 时等待 expect 列出的全部标签都发来信号；mode=any 时任意一个信号到达即返回。' +
      '超时未满足会返回 pending 列表，可再次调用继续等待。返回即恢复主智能体执行。' +
      '注意：收到信号只说明对应必要任务已完成，子智能体可能仍在继续执行后续工作。',
    inputSchema: {
      type: 'object',
      properties: {
        ...TEAM_PARAM,
        expect: {
          type: 'array',
          items: { type: 'string' },
          description: '要等待的子智能体标签列表（派发任务时分配给子代理的 label）。mode=all 时必填。',
        },
        mode: {
          type: 'string',
          enum: ['all', 'any'],
          description: 'all=等待 expect 中所有标签（默认）；any=任意一个期望标签到达即返回。',
        },
        timeoutMs: {
          type: 'number',
          description: `最长阻塞毫秒数，默认 ${WAIT_DEFAULT_MS}，范围 ${WAIT_MIN_MS}-${WAIT_MAX_MS}。超时返回当前进度。`,
        },
        staleAfterMs: {
          type: 'number',
          description: `判定子智能体失联的毫秒数（依据其最后一次 agent_report），默认 ${STALE_DEFAULT_MS}。超时返回时会在 stale 字段列出失联标签，避免干等。`,
        },
        reset: {
          type: 'boolean',
          description: 'true 时先清空本团队的信号、在线状态与消息，再开始等待（新团队任务开始时使用）。只影响当前 team。',
        },
      },
      required: [],
    },
  },
  {
    name: 'agent_done',
    description:
      '子智能体专用：向团队门禁发送任务完成信号（里程碑信号，不表示子智能体终止）。' +
      '完成主智能体分配的必要任务后立即调用；主智能体的 team_wait 会在等待条件满足时被唤醒。' +
      '发送信号后子智能体应继续执行后续工作（自检、补充验证等），不要停止。label 使用派发任务时给定的标签。',
    inputSchema: {
      type: 'object',
      properties: {
        ...TEAM_PARAM,
        label: {
          type: 'string',
          description: '本次任务的标签，必须与主智能体派发时分配的 label 一致，如 scout-1、review-security。',
        },
        status: {
          type: 'string',
          enum: ['success', 'failure', 'blocked'],
          description: 'success=必要任务已完成；failure=必要任务尝试后失败；blocked=必要任务被外部因素阻塞。仅描述任务状态，与子智能体是否继续运行无关。',
        },
        summary: {
          type: 'string',
          description: '结果摘要：做了什么、关键结论、验证证据（命令与真实输出）。',
        },
        artifacts: {
          type: 'array',
          items: { type: 'string' },
          description: '产出物路径或关键位置清单，如修改的文件、报告路径。',
        },
      },
      required: ['label'],
    },
  },
  {
    name: 'agent_report',
    description:
      '子智能体专用：注册或更新自己的存在与当前任务（upsert）。开始执行时调用一次（label/role/task），' +
      '任务变化或阶段推进时再次调用以更新 task 与 status。其他 agent 通过 team_status 实时看到你的状态与正在进行的任务。' +
      '长时间任务中定期调用可续期，避免被判定为失联。',
    inputSchema: {
      type: 'object',
      properties: {
        ...TEAM_PARAM,
        label: { type: 'string', description: '你的任务标签（与派发时分配的一致）。' },
        role: { type: 'string', description: '角色名，如 scout/builder/reviewer。' },
        task: { type: 'string', description: '当前正在执行的任务描述（会展示给其他 agent）。' },
        status: {
          type: 'string',
          enum: ['running', 'waiting', 'done', 'failed', 'blocked'],
          description: 'running=执行中（默认）；waiting=等待其他 agent 或外部输入；done/failed/blocked 一般由 agent_done 维护。',
        },
      },
      required: ['label'],
    },
  },
  {
    name: 'team_status',
    description:
      '任何 agent 可用：实时总览本团队状态——每个 agent 的 label、角色、当前任务、状态与最后更新时间，' +
      '最近的完成信号，主智能体正在等待的标签，以及疑似失联（stale）的 agent。协调前先用它确认同伴进展，避免重复劳动。' +
      '结果附带 teams 字段列出所有团队的规模，便于发现其他并行团队。',
    inputSchema: {
      type: 'object',
      properties: {
        ...TEAM_PARAM,
        label: { type: 'string', description: '可选。只查看某个标签的详情（含未读消息数）；省略返回本团队总览。' },
      },
    },
  },
  {
    name: 'agent_send',
    description:
      '任何 agent 可用：A2A 点对点/广播消息，仅在本团队内投递。to 填目标 agent 的 label，或 "*" 广播给本团队所有 agent，' +
      '接收方用 agent_recv 读取。消息用于传递上下文、结论、警告，不替代各自的任务输出。',
    inputSchema: {
      type: 'object',
      properties: {
        ...TEAM_PARAM,
        from: { type: 'string', description: '发送方 label。' },
        to: { type: 'string', description: '接收方 label，或 "*" 广播。' },
        content: { type: 'string', description: '消息内容：结论、依赖、警告、需要的输入。' },
      },
      required: ['from', 'to', 'content'],
    },
  },
  {
    name: 'agent_recv',
    description:
      '任何 agent 可用：读取本团队中发给我的未读消息（含广播），默认标记为已读。' +
      '在动手前与关键节点调用，获取同伴的最新结论与警告。',
    inputSchema: {
      type: 'object',
      properties: {
        ...TEAM_PARAM,
        label: { type: 'string', description: '我的 label。' },
        markRead: { type: 'boolean', description: '是否标记已读，默认 true。' },
      },
      required: ['label'],
    },
  },
];

/** 创建工具运行上下文：一个 store + 运行时的等待登记表（等待是瞬态，不落盘）。 */
export function createToolContext({ log = () => {} } = {}) {
  const store = new TeamStore(resolveStateFile(), { log });
  const activeWaits = new Map();
  let nextWaitId = 1;
  return { store, activeWaits, nextWaitId: () => nextWaitId++ };
}

function resolveStateFile() {
  // 允许测试注入；默认由 state.mjs 解析（插件目录/state/teams.json）
  return process.env.TEAM_GATE_STATE_FILE?.trim() || undefined;
}

function textResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function clampTimeout(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return WAIT_DEFAULT_MS;
  return Math.min(Math.max(n, WAIT_MIN_MS), WAIT_MAX_MS);
}

function teamOrError(args) {
  const team = normalizeTeamId(args.team);
  if (team === null) {
    return { error: textResult({ ok: false, error: 'team 参数非法：仅限字母数字 . _ - ，最长 64 字符' }) };
  }
  return { team };
}

function staleInfo(store, teamId, labels, staleAfterMs) {
  const now = Date.now();
  const stale = [];
  const unreported = [];
  for (const label of labels) {
    const p = store.presenceOf(teamId, label);
    if (!p) {
      unreported.push(label);
      continue;
    }
    const age = now - new Date(p.updatedAt).getTime();
    if (Number.isFinite(age) && age > staleAfterMs) {
      stale.push({ label, lastSeen: p.updatedAt, task: p.task, status: p.status, ageMs: age });
    }
  }
  return { stale, unreported };
}

export async function callTool(name, args, ctx) {
  switch (name) {
    case 'team_wait':
      return teamWait(args, ctx);
    case 'agent_done':
      return agentDone(args, ctx);
    case 'agent_report':
      return agentReport(args, ctx);
    case 'team_status':
      return teamStatus(args, ctx);
    case 'agent_send':
      return agentSend(args, ctx);
    case 'agent_recv':
      return agentRecv(args, ctx);
    default:
      return { error: `未知工具: ${String(name)}` };
  }
}

async function teamWait(args, ctx) {
  const { team, error } = teamOrError(args);
  if (error) return error;
  const { store, activeWaits } = ctx;
  if (args.reset === true) store.resetTeam(team);

  const mode = args.mode === 'any' ? 'any' : 'all';
  const expect = Array.isArray(args.expect)
    ? args.expect.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
    : [];
  const timeoutMs = clampTimeout(args.timeoutMs);
  const staleAfterMs = Number.isFinite(Number(args.staleAfterMs)) && Number(args.staleAfterMs) > 0
    ? Number(args.staleAfterMs)
    : STALE_DEFAULT_MS;
  const started = store.team(team).signals.length;

  const done = () => {
    const labels = store.signalLabels(team);
    if (mode === 'any') {
      if (expect.length > 0) return expect.some((l) => labels.has(l));
      return store.team(team).signals.length > started;
    }
    if (expect.length === 0) return false; // all 模式未给 expect：只能等超时并提示
    return expect.every((l) => labels.has(l));
  };

  const t0 = Date.now();
  const waitId = ctx.nextWaitId();
  activeWaits.set(waitId, { team, expect, mode, since: new Date(t0).toISOString() });
  try {
    while (!done()) {
      if (Date.now() - t0 >= timeoutMs) break;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } finally {
    activeWaits.delete(waitId);
  }

  const labels = store.signalLabels(team);
  const satisfied = done();
  const pending = expect.filter((l) => !labels.has(l));
  const { stale, unreported } = staleInfo(store, team, pending, staleAfterMs);
  return textResult({
    ok: true,
    team,
    status: satisfied ? 'satisfied' : 'timeout',
    mode,
    expect,
    pending,
    stale,
    unreported,
    newSignals: store.team(team).signals.slice(started),
    roster: store.roster(team).map((p) => ({ label: p.label, role: p.role, task: p.task, status: p.status, updatedAt: p.updatedAt })),
    recentSignals: store.team(team).signals.slice(-50),
    teams: store.listTeams(),
    waitedMs: Date.now() - t0,
    hint: satisfied
      ? '期望的任务里程碑信号已收齐。注意子智能体可能仍在继续执行；检查 newSignals 中的 status 与 summary 后决定汇总或继续等待。'
      : expect.length === 0
        ? 'mode=all 但未提供 expect：无法判断等待条件，已超时返回。请给出 expect 标签列表，或用 mode=any 等待任意信号。'
        : stale.length > 0
          ? `超时未收齐，且 ${stale.length} 个标签疑似失联（长时间未 agent_report）：${stale.map((s) => s.label).join(', ')}。可重新派发或用 team_status 确认。`
          : '超时未收齐。可再次调用 team_wait 继续等待；若怀疑标签不匹配，用 recentSignals 核对实际 label。',
  });
}

function agentDone(args, ctx) {
  const { team, error } = teamOrError(args);
  if (error) return error;
  const label = String(args.label ?? '').trim();
  if (!label) {
    return textResult({ ok: false, error: 'label 必填：使用主智能体派发任务时分配的标签' });
  }
  const status = ['success', 'failure', 'blocked'].includes(args.status) ? args.status : 'success';
  const signal = {
    label,
    status,
    summary: String(args.summary ?? '').slice(0, 8000),
    artifacts: Array.isArray(args.artifacts) ? args.artifacts.slice(0, 100).map(String) : [],
    at: new Date().toISOString(),
  };
  ctx.store.recordSignal(team, signal);
  return textResult({
    ok: true,
    team,
    recorded: signal,
    totalSignals: ctx.store.team(team).signals.length,
    hint: '任务完成信号已记录。主智能体的 team_wait 会在等待条件满足时立即返回；你可以继续执行后续工作，不要停止。',
  });
}

function agentReport(args, ctx) {
  const { team, error } = teamOrError(args);
  if (error) return error;
  const label = String(args.label ?? '').trim();
  if (!label) return textResult({ ok: false, error: 'label 必填' });
  const status = ['running', 'waiting', 'done', 'failed', 'blocked'].includes(args.status) ? args.status : 'running';
  const presence = ctx.store.upsertPresence(team, {
    label,
    role: args.role === undefined ? undefined : String(args.role).slice(0, 60),
    task: args.task === undefined ? undefined : String(args.task).slice(0, 2000),
    status,
  });
  return textResult({ ok: true, team, presence, onlineCount: ctx.store.roster(team).length });
}

function teamStatus(args, ctx) {
  const { team, error } = teamOrError(args);
  if (error) return error;
  const { store } = ctx;
  const label = args.label ? String(args.label) : null;
  const roster = store.roster(team);
  const now = Date.now();
  const stale = roster
    .filter((p) => now - new Date(p.updatedAt).getTime() > STALE_DEFAULT_MS)
    .map((p) => ({ label: p.label, lastSeen: p.updatedAt, task: p.task, status: p.status }));
  const base = {
    ok: true,
    team,
    onlineCount: roster.length,
    roster,
    stale,
    waits: [...ctx.activeWaits.values()].map((w) => ({ ...w })),
    recentSignals: store.team(team).signals.slice(-20),
    teams: store.listTeams(),
  };
  if (label) {
    base.me = roster.find((r) => r.label === label) ?? null;
    base.unreadMessages = store.unreadFor(team, label).length;
  }
  return textResult(base);
}

function agentSend(args, ctx) {
  const { team, error } = teamOrError(args);
  if (error) return error;
  const from = String(args.from ?? '').trim();
  const to = String(args.to ?? '').trim();
  const content = String(args.content ?? '').trim();
  if (!from || !to || !content) return textResult({ ok: false, error: 'from/to/content 均必填' });
  const msg = ctx.store.addMessage(team, { from, to, content: content.slice(0, 8000) });
  return textResult({
    ok: true,
    team,
    id: msg.id,
    to: msg.to,
    hint: to === '*' ? '已广播给本团队，所有 agent 调用 agent_recv 均可读取。' : `已发送给 ${to}，对方调用 agent_recv 读取。`,
  });
}

function agentRecv(args, ctx) {
  const { team, error } = teamOrError(args);
  if (error) return error;
  const label = String(args.label ?? '').trim();
  if (!label) return textResult({ ok: false, error: 'label 必填' });
  const mine = ctx.store.unreadFor(team, label);
  if (args.markRead !== false) ctx.store.markRead(team, label, mine);
  return textResult({ ok: true, team, count: mine.length, unread: mine });
}

export { DEFAULT_TEAM };
