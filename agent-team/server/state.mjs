/**
 * state.mjs — team-gate 状态层
 *
 * 职责：团队（team）隔离的状态存储 + 原子持久化。
 *   - 每个 team 有独立的 signals / presence / messages，互不串扰
 *   - 状态落盘到 <插件目录>/state/teams.json（可用 TEAM_GATE_STATE_FILE 覆盖），
 *     MCP server 重启后恢复，进行到一半的团队不丢状态
 *   - 写入防抖 50ms + 临时文件原子替换 + 进程退出前同步落盘
 * 本层不感知 MCP 协议，也不含工具逻辑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_TEAM = 'default';
const MAX_SIGNALS = 200;
const MAX_MESSAGES = 200;
const MAX_TEAMS = 50;
const FLUSH_DEBOUNCE_MS = 50;
const TEAM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function resolveStatePath() {
  if (process.env.TEAM_GATE_STATE_FILE?.trim()) return process.env.TEAM_GATE_STATE_FILE.trim();
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, '..', 'state', 'teams.json');
}

/** 归一化团队标识；非法返回 null。 */
export function normalizeTeamId(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return DEFAULT_TEAM;
  return TEAM_ID_RE.test(t) ? t : null;
}

function emptyTeam(now) {
  return { signals: [], presence: {}, messages: [], createdAt: now, updatedAt: now };
}

function capList(list, max) {
  if (list.length > max) list.splice(0, list.length - max);
}

export class TeamStore {
  constructor(file = resolveStatePath(), { log = () => {} } = {}) {
    this.file = file;
    this.log = log;
    /** @type {Map<string, {signals:any[],presence:Record<string,any>,messages:any[],createdAt:string,updatedAt:string}>} */
    this.teams = new Map();
    this.nextMessageId = 1;
    this._timer = null;
    this._load();
    process.on('exit', () => this.flushNow());
  }

  // ---------- 持久化 ----------

  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return; // 首次运行或状态被清，从空开始
    }
    try {
      const parsed = JSON.parse(raw);
      const teams = parsed?.teams;
      if (teams && typeof teams === 'object') {
        for (const [id, value] of Object.entries(teams)) {
          if (!normalizeTeamId(id) || !value || typeof value !== 'object') continue;
          const team = emptyTeam(value.createdAt ?? new Date().toISOString());
          team.updatedAt = value.updatedAt ?? team.createdAt;
          if (Array.isArray(value.signals)) team.signals = value.signals.slice(-MAX_SIGNALS);
          if (value.presence && typeof value.presence === 'object' && !Array.isArray(value.presence)) {
            team.presence = value.presence;
          }
          if (Array.isArray(value.messages)) team.messages = value.messages.slice(-MAX_MESSAGES);
          this.teams.set(id, team);
        }
      }
      if (Number.isFinite(parsed?.nextMessageId)) this.nextMessageId = parsed.nextMessageId;
      this.log(`状态已恢复：${this.teams.size} 个团队`);
    } catch (err) {
      // 损坏的状态文件不能阻止 server 启动：改名备份，从空开始
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        this.log('状态文件损坏，已备份并从空状态启动');
      } catch {
        this.log('状态文件损坏且无法备份，从空状态启动');
      }
    }
  }

  _serialize() {
    return JSON.stringify({ version: 2, nextMessageId: this.nextMessageId, teams: Object.fromEntries(this.teams) });
  }

  scheduleFlush() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flushNow();
    }, FLUSH_DEBOUNCE_MS);
    this._timer.unref?.();
  }

  flushNow() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, this._serialize());
      fs.renameSync(tmp, this.file); // 同目录原子替换
      return true;
    } catch (err) {
      this.log('状态落盘失败:', String(err?.message ?? err));
      try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
      return false;
    }
  }

  // ---------- 团队管理 ----------

  team(id) {
    let team = this.teams.get(id);
    if (!team) {
      this._evictIfNeeded();
      team = emptyTeam(new Date().toISOString());
      this.teams.set(id, team);
    }
    return team;
  }

  _evictIfNeeded() {
    if (this.teams.size < MAX_TEAMS) return;
    const oldest = [...this.teams.entries()].sort((a, b) => String(a[1].updatedAt).localeCompare(String(b[1].updatedAt)))[0];
    if (oldest) {
      this.teams.delete(oldest[0]);
      this.log(`团队数超过 ${MAX_TEAMS}，淘汰最久未更新的团队 ${oldest[0]}`);
    }
  }

  _touch(id) {
    this.team(id).updatedAt = new Date().toISOString();
    this.scheduleFlush();
  }

  resetTeam(id) {
    const team = this.team(id);
    team.signals = [];
    team.presence = {};
    team.messages = [];
    this._touch(id);
  }

  listTeams() {
    return [...this.teams.entries()]
      .map(([id, t]) => ({
        id,
        onlineCount: Object.keys(t.presence).length,
        signalCount: t.signals.length,
        messageCount: t.messages.length,
        updatedAt: t.updatedAt,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  // ---------- 信号 ----------

  recordSignal(id, signal) {
    const team = this.team(id);
    team.signals.push(signal);
    capList(team.signals, MAX_SIGNALS);
    const p = team.presence[signal.label];
    if (p) {
      p.status = signal.status === 'success' ? 'done' : signal.status === 'failure' ? 'failed' : 'blocked';
      p.updatedAt = signal.at;
    }
    this._touch(id);
  }

  signalLabels(id) {
    return new Set(this.team(id).signals.map((s) => s.label));
  }

  // ---------- 在线状态 ----------

  upsertPresence(id, { label, role, task, status }) {
    const team = this.team(id);
    const prev = team.presence[label];
    const now = new Date().toISOString();
    team.presence[label] = {
      label,
      role: role ?? prev?.role ?? 'agent',
      task: task ?? prev?.task ?? '',
      status,
      joinedAt: prev?.joinedAt ?? now,
      updatedAt: now,
    };
    this._touch(id);
    return team.presence[label];
  }

  roster(id) {
    return Object.values(this.team(id).presence).sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  }

  presenceOf(id, label) {
    return this.team(id).presence[label] ?? null;
  }

  // ---------- 消息 ----------

  addMessage(id, { from, to, content }) {
    const team = this.team(id);
    const msg = { id: this.nextMessageId++, from, to, content, at: new Date().toISOString(), readBy: [] };
    team.messages.push(msg);
    capList(team.messages, MAX_MESSAGES);
    this._touch(id);
    return msg;
  }

  unreadFor(id, label) {
    return this.team(id).messages.filter((m) => (m.to === label || m.to === '*') && !m.readBy.includes(label));
  }

  markRead(id, label, msgs) {
    for (const m of msgs) if (!m.readBy.includes(label)) m.readBy.push(label);
    if (msgs.length) this._touch(id);
  }
}
