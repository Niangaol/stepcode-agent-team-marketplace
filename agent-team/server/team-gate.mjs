#!/usr/bin/env node
/**
 * team-gate — 智能体团队协作门禁（MCP stdio server，零依赖）
 *
 * 提供两个工具：
 *   team_wait  主智能体主动暂停运行，等待指定（或任意）子智能体发送结束信号
 *   agent_done 子智能体发送结束信号（label/status/summary/artifacts）
 *
 * 协议：MCP over stdio，换行分隔的 JSON-RPC 2.0。stdout 只走协议，日志走 stderr。
 */
import { createInterface } from 'node:readline';

const PROTOCOL_FALLBACK = '2024-11-05';
const MAX_SIGNALS = 200;
const POLL_MS = 150;
const WAIT_MIN_MS = 1000;
const WAIT_MAX_MS = 300000;
const WAIT_DEFAULT_MS = 90000;

/** @type {{label:string,status:string,summary:string,artifacts:string[],at:string}[]} */
const signals = [];

/** @type {Map<string,{label:string,role:string,task:string,status:string,joinedAt:string,updatedAt:string}>} */
const presence = new Map();
/** @type {{id:number,from:string,to:string,content:string,at:string,readBy:string[]}[]} */
const messages = [];
/** @type {Map<number,{expect:string[],mode:string,since:string}>} */
const activeWaits = new Map();
let nextMessageId = 1;
let nextWaitId = 1;
const MAX_MESSAGES = 200;

const TOOLS = [
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
        reset: {
          type: 'boolean',
          description: 'true 时先清空已记录的全部结束信号，再开始等待（新团队任务开始时使用）。',
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
      '任务变化或阶段推进时再次调用以更新 task 与 status。其他 agent 通过 team_status 实时看到你的状态与正在进行的任务。',
    inputSchema: {
      type: 'object',
      properties: {
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
      '任何 agent 可用：实时总览团队状态——每个 agent 的 label、角色、当前任务、状态与最后更新时间，' +
      '最近的完成信号，以及主智能体正在等待的标签。协调前先用它确认同伴进展，避免重复劳动。',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: '可选。只查看某个标签的详情（含未读消息数）；省略返回全团队总览。' },
      },
    },
  },
  {
    name: 'agent_send',
    description:
      '任何 agent 可用：A2A 点对点/广播消息。to 填目标 agent 的 label，或 "*" 广播给所有 agent，' +
      '接收方用 agent_recv 读取。消息用于传递上下文、结论、警告，不替代各自的任务输出。',
    inputSchema: {
      type: 'object',
      properties: {
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
      '任何 agent 可用：读取发给我的未读消息（含广播），默认标记为已读。' +
      '在动手前与关键节点调用，获取同伴的最新结论与警告。',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: '我的 label。' },
        markRead: { type: 'boolean', description: '是否标记已读，默认 true。' },
      },
      required: ['label'],
    },
  },
];

function log(...args) {
  process.stderr.write(`[team-gate] ${args.join(' ')}\n`);
}

// 宿主提前关闭 stdio 管道时安静退出，不抛未捕获的 EPIPE
for (const stream of [process.stdout, process.stdin]) {
  stream.on('error', (err) => {
    if (err?.code === 'EPIPE') process.exit(0);
    log('stream 错误:', String(err?.message ?? err));
  });
}

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

function textResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function clampTimeout(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return WAIT_DEFAULT_MS;
  return Math.min(Math.max(n, WAIT_MIN_MS), WAIT_MAX_MS);
}

async function teamWait(args = {}) {
  if (args.reset === true) { signals.length = 0; presence.clear(); messages.length = 0; activeWaits.clear(); }
  const mode = args.mode === 'any' ? 'any' : 'all';
  const expect = Array.isArray(args.expect)
    ? args.expect.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
    : [];
  const timeoutMs = clampTimeout(args.timeoutMs);
  const started = signals.length;

  const done = () => {
    const labels = new Set(signals.map((s) => s.label));
    if (mode === 'any') {
      if (expect.length > 0) return expect.some((l) => labels.has(l));
      return signals.length > started;
    }
    if (expect.length === 0) return false; // all 模式未给 expect：只能等超时并提示
    return expect.every((l) => labels.has(l));
  };

  const t0 = Date.now();
  const waitId = nextWaitId++;
  activeWaits.set(waitId, { expect, mode, since: new Date(t0).toISOString() });
  try {
    while (!done()) {
      if (Date.now() - t0 >= timeoutMs) break;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } finally {
    activeWaits.delete(waitId);
  }

  const labels = new Set(signals.map((s) => s.label));
  const satisfied = done();
  return textResult({
    status: satisfied ? 'satisfied' : 'timeout',
    mode,
    expect,
    pending: expect.filter((l) => !labels.has(l)),
    newSignals: signals.slice(started),
    roster: [...presence.values()].map((p) => ({ label: p.label, role: p.role, task: p.task, status: p.status, updatedAt: p.updatedAt })),
    recentSignals: signals.slice(-50),
    waitedMs: Date.now() - t0,
    hint: satisfied
      ? '期望的任务里程碑信号已收齐。注意子智能体可能仍在继续执行；检查 newSignals 中的 status 与 summary 后决定汇总或继续等待。'
      : expect.length === 0
        ? 'mode=all 但未提供 expect：无法判断等待条件，已超时返回。请给出 expect 标签列表，或用 mode=any 等待任意信号。'
        : '超时未收齐。可再次调用 team_wait 继续等待；若怀疑标签不匹配，用 recentSignals 核对实际 label。',
  });
}

function agentDone(args = {}) {
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
  signals.push(signal);
  if (signals.length > MAX_SIGNALS) signals.splice(0, signals.length - MAX_SIGNALS);
  const p = presence.get(label);
  if (p) {
    p.status = status === 'success' ? 'done' : status === 'failure' ? 'failed' : 'blocked';
    p.updatedAt = signal.at;
  }
  return textResult({
    ok: true,
    recorded: signal,
    totalSignals: signals.length,
    hint: '任务完成信号已记录。主智能体的 team_wait 会在等待条件满足时立即返回；你可以继续执行后续工作，不要停止。',
  });
}

function agentReport(args = {}) {
  const label = String(args.label ?? '').trim();
  if (!label) return textResult({ ok: false, error: 'label 必填' });
  const now = new Date().toISOString();
  const status = ['running', 'waiting', 'done', 'failed', 'blocked'].includes(args.status) ? args.status : 'running';
  const prev = presence.get(label);
  presence.set(label, {
    label,
    role: String(args.role ?? prev?.role ?? 'agent').slice(0, 60),
    task: String(args.task ?? prev?.task ?? '').slice(0, 2000),
    status,
    joinedAt: prev?.joinedAt ?? now,
    updatedAt: now,
  });
  return textResult({ ok: true, presence: presence.get(label), onlineCount: presence.size });
}

function teamStatus(args = {}) {
  const label = args.label ? String(args.label) : null;
  const roster = [...presence.values()].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  const base = {
    onlineCount: roster.length,
    roster,
    waits: [...activeWaits.values()].map((w) => ({ ...w })),
    recentSignals: signals.slice(-20),
  };
  if (label) {
    base.me = roster.find((r) => r.label === label) ?? null;
    base.unreadMessages = messages.filter((m) => (m.to === label || m.to === '*') && !m.readBy.includes(label)).length;
  }
  return textResult(base);
}

function agentSend(args = {}) {
  const from = String(args.from ?? '').trim();
  const to = String(args.to ?? '').trim();
  const content = String(args.content ?? '').trim();
  if (!from || !to || !content) return textResult({ ok: false, error: 'from/to/content 均必填' });
  const msg = { id: nextMessageId++, from, to, content: content.slice(0, 8000), at: new Date().toISOString(), readBy: [] };
  messages.push(msg);
  if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES);
  return textResult({
    ok: true,
    id: msg.id,
    to: msg.to,
    hint: to === '*' ? '已广播，所有 agent 调用 agent_recv 均可读取。' : `已发送给 ${to}，对方调用 agent_recv 读取。`,
  });
}

function agentRecv(args = {}) {
  const label = String(args.label ?? '').trim();
  if (!label) return textResult({ ok: false, error: 'label 必填' });
  const mine = messages.filter((m) => (m.to === label || m.to === '*') && !m.readBy.includes(label));
  if (args.markRead !== false) for (const m of mine) m.readBy.push(label);
  return textResult({ ok: true, count: mine.length, unread: mine });
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      send(id, {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_FALLBACK,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'team-gate', version: '1.0.0' },
      });
      return;
    case 'ping':
      send(id, {});
      return;
    case 'tools/list':
      send(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      try {
        if (name === 'team_wait') send(id, await teamWait(args));
        else if (name === 'agent_done') send(id, agentDone(args));
        else if (name === 'agent_report') send(id, agentReport(args));
        else if (name === 'team_status') send(id, teamStatus(args));
        else if (name === 'agent_send') send(id, agentSend(args));
        else if (name === 'agent_recv') send(id, agentRecv(args));
        else sendError(id, -32602, `未知工具: ${String(name)}`);
      } catch (err) {
        send(id, {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: String(err?.message ?? err) }) }],
          isError: true,
        });
      }
      return;
    }
    default:
      if (id !== undefined && id !== null) sendError(id, -32601, `方法不存在: ${String(method)}`);
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    log('忽略无法解析的输入行');
    return;
  }
  if (typeof msg?.method === 'string' && msg.method.startsWith('notifications/')) return;
  if (msg?.id === undefined || msg?.id === null) return; // 通知无响应
  handleRequest(msg).catch((err) => {
    log('处理请求失败:', String(err?.stack ?? err));
    if (msg?.id !== undefined) sendError(msg.id, -32603, '内部错误');
  });
});

log('team-gate MCP server 已启动（stdio）');
