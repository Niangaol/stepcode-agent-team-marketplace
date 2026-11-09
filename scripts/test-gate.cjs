#!/usr/bin/env node
/**
 * team-gate 端到端自测（v2.0 架构）
 *
 * 以真实 MCP stdio 客户端方式驱动 server/team-gate.mjs，覆盖：
 *   协议：initialize / tools/list / 通知忽略 / 未知工具 / 参数校验
 *   信号：agent_done 记录 / team_wait 满足 / 超时 / any / 阻塞中被唤醒
 *   A2A：agent_report 注册 upsert / team_status 总览 / 点对点 / 广播 / 已读语义
 *   团队：team 参数隔离（信号、在线、消息互不可见）/ reset 只清本团队 / 非法 team 报错
 *   韧性：stale 失联检测 / 重启后状态恢复（持久化）
 */
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const server = path.join(__dirname, '..', 'agent-team', 'server', 'team-gate.mjs');
const stateFile = path.join(os.tmpdir(), `team-gate-test-${process.pid}.json`);
for (const f of [stateFile, `${stateFile}.tmp`]) {
  try { fs.unlinkSync(f); } catch { /* 忽略 */ }
}
const env = { ...process.env, TEAM_GATE_STATE_FILE: stateFile };

function spawnServer() {
  const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'pipe'], env });
  let buf = '';
  const pending = new Map();
  let nextId = 1;
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  child.stderr.on('data', () => {});
  const rpc = (method, params, timeoutMs = 10000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => reject(new Error(`RPC ${method} 超时`)), timeoutMs);
    });
  const call = (name, args) =>
    rpc('tools/call', { name, arguments: args }).then((m) => {
      if (m.error) return { error: m.error };
      return { payload: JSON.parse(m.result.content[0].text), isError: m.result.isError === true };
    });
  return { child, rpc, call, nextIdRef: () => nextId++, write: (obj) => child.stdin.write(JSON.stringify(obj) + '\n') };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const s = spawnServer();

  // ===== 协议层 =====
  const init = await s.rpc('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(init.result.serverInfo.name, 'team-gate');
  assert.equal(init.result.serverInfo.version, '2.0.0');
  console.log('OK  initialize（server v2.0.0）');

  const list = await s.rpc('tools/list');
  const names = list.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['agent_done', 'agent_recv', 'agent_report', 'agent_send', 'team_status', 'team_wait']);
  for (const t of list.result.tools) {
    assert.ok(t.inputSchema?.properties?.team, `${t.name} 应有 team 参数`);
  }
  console.log(`OK  tools/list: ${names.join(', ')}（均带 team 参数）`);

  s.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await sleep(200);
  const bad = await s.call('no_such_tool', {});
  assert.ok(bad.error, '未知工具应返回 JSON-RPC error');
  console.log('OK  通知忽略 + 未知工具报错');

  // ===== 信号与等待 =====
  const d1 = await s.call('agent_done', { label: 'build-core', status: 'success', summary: '改了 3 个文件', artifacts: ['a.ts'] });
  assert.equal(d1.payload.ok, true);
  assert.equal(d1.payload.team, 'default');
  console.log('OK  agent_done 记录信号（默认团队 default）');

  const t0 = Date.now();
  const w1 = await s.call('team_wait', { expect: ['build-core'], timeoutMs: 5000 });
  assert.equal(w1.payload.status, 'satisfied');
  assert.ok(Date.now() - t0 < 2000, '已满足时必须立即返回');
  console.log(`OK  team_wait(all) 已满足立即返回 (${w1.payload.waitedMs}ms)`);

  const w2 = await s.call('team_wait', { expect: ['nope-1', 'nope-2'], timeoutMs: 1500 });
  assert.equal(w2.payload.status, 'timeout');
  assert.deepEqual([...w2.payload.pending].sort(), ['nope-1', 'nope-2']);
  assert.deepEqual(w2.payload.unreported.sort(), ['nope-1', 'nope-2'], '未上报的标签应进 unreported');
  console.log(`OK  team_wait(all) 超时返回 pending/unreported (${w2.payload.waitedMs}ms)`);

  const w3 = await s.call('team_wait', { expect: ['build-core', 'other'], mode: 'any', timeoutMs: 3000 });
  assert.equal(w3.payload.status, 'satisfied');
  console.log('OK  team_wait(any) 任一信号即满足');

  const t5 = Date.now();
  const wPromise = s.call('team_wait', { expect: ['late-bird'], timeoutMs: 8000 });
  setTimeout(() => s.write({ jsonrpc: '2.0', id: s.nextIdRef(), method: 'tools/call', params: { name: 'agent_done', arguments: { label: 'late-bird', status: 'success', summary: '迟到的里程碑信号' } } }), 600);
  const w5 = await wPromise;
  const elapsed = Date.now() - t5;
  assert.equal(w5.payload.status, 'satisfied');
  assert.ok(elapsed < 4000, `信号到达后应尽快返回，实际 ${elapsed}ms`);
  assert.ok(Array.isArray(w5.payload.roster), 'team_wait 应返回 roster');
  assert.ok(Array.isArray(w5.payload.teams), 'team_wait 应返回 teams 总览');
  console.log(`OK  team_wait 阻塞中被后续信号唤醒 (${elapsed}ms)`);

  // ===== A2A 基础 =====
  const r1 = await s.call('agent_report', { label: 'scout-1', role: 'scout', task: '摸清支付模块调用链' });
  assert.equal(r1.payload.ok, true);
  const r2 = await s.call('agent_report', { label: 'builder-1', role: 'builder', task: '修改 core/pay.ts 并补测试' });
  assert.equal(r2.payload.onlineCount, 2);
  const r3 = await s.call('agent_report', { label: 'builder-1', task: '修改 core/pay.ts 的重试逻辑' });
  assert.equal(r3.payload.onlineCount, 2);
  assert.equal(r3.payload.presence.task, '修改 core/pay.ts 的重试逻辑');
  console.log('OK  agent_report 注册与 upsert');

  const s1 = await s.call('team_status', {});
  assert.equal(s1.payload.onlineCount, 2);
  assert.equal(s1.payload.roster.find((r) => r.label === 'scout-1').task, '摸清支付模块调用链');
  console.log('OK  team_status 实时总览');

  const m1 = await s.call('agent_send', { from: 'scout-1', to: 'builder-1', content: '入口是 pay/router.ts:42' });
  assert.equal(m1.payload.ok, true);
  const recv1 = await s.call('agent_recv', { label: 'builder-1' });
  assert.equal(recv1.payload.count, 1);
  const recv2 = await s.call('agent_recv', { label: 'builder-1' });
  assert.equal(recv2.payload.count, 0, '第二次应为空（已读）');
  const m2 = await s.call('agent_send', { from: 'scout-1', to: '*', content: '支付模块有 3 个调用方' });
  const b1 = await s.call('agent_recv', { label: 'builder-1' });
  const b2 = await s.call('agent_recv', { label: 'tester-9' });
  assert.ok(b1.payload.count >= 1 && b2.payload.count >= 1, '广播应被所有 label 收到');
  console.log('OK  A2A 点对点 + 已读语义 + 广播');

  // ===== 团队隔离 =====
  await s.call('agent_report', { team: 'alpha', label: 'a-1', role: 'scout', task: 'alpha 团队侦察' });
  await s.call('agent_report', { team: 'beta', label: 'b-1', role: 'builder', task: 'beta 团队实现' });
  await s.call('agent_done', { team: 'beta', label: 'b-1', status: 'success', summary: 'beta 完成' });
  await s.call('agent_send', { team: 'alpha', from: 'a-1', to: 'a-1', content: 'alpha 内部消息' });

  const sa = await s.call('team_status', { team: 'alpha' });
  assert.equal(sa.payload.onlineCount, 1);
  assert.equal(sa.payload.roster[0].label, 'a-1');
  assert.equal(sa.payload.recentSignals.length, 0, 'alpha 不应看到 beta 的信号');
  assert.equal(sa.payload.teams.length >= 2, true, 'teams 总览应包含多个团队');

  const sb = await s.call('team_status', { team: 'beta' });
  assert.equal(sb.payload.roster[0].status, 'done', 'beta 的 b-1 应已 done');
  assert.equal(sb.payload.recentSignals.length, 1);

  // alpha 等待 beta 的标签：必须超时（信号属于 beta）
  const wx = await s.call('team_wait', { team: 'alpha', expect: ['b-1'], timeoutMs: 1200 });
  assert.equal(wx.payload.status, 'timeout', 'alpha 不应看到 beta 的信号');
  // beta 等待自己的标签：立即满足
  const wy = await s.call('team_wait', { team: 'beta', expect: ['b-1'], timeoutMs: 2000 });
  assert.equal(wy.payload.status, 'satisfied');
  // 消息隔离：beta 收不到 alpha 的点对点消息
  const rb = await s.call('agent_recv', { team: 'beta', label: 'b-1' });
  assert.equal(rb.payload.count, 0, 'beta 不应收到 alpha 的消息');
  console.log('OK  团队隔离：信号 / 在线状态 / 消息互不可见');

  // reset 只清本团队
  const rr = await s.call('team_wait', { team: 'alpha', reset: true, expect: ['a-1'], timeoutMs: 1200 });
  assert.equal(rr.payload.status, 'timeout');
  const sa2 = await s.call('team_status', { team: 'alpha' });
  assert.equal(sa2.payload.onlineCount, 0, 'reset 后 alpha 应无在线 agent');
  const sb2 = await s.call('team_status', { team: 'beta' });
  assert.equal(sb2.payload.onlineCount, 1, 'reset 不应影响 beta');
  console.log('OK  reset 只清当前团队');

  // 非法 team 参数
  const bad2 = await s.call('agent_report', { team: 'bad id!', label: 'x' });
  assert.equal(bad2.payload.ok, false);
  assert.ok(bad2.payload.error.includes('team'));
  console.log('OK  非法 team 参数报错');

  // ===== stale 检测 =====
  await s.call('agent_report', { team: 'stale-1', label: 's-1', role: 'builder', task: '长任务' });
  await sleep(1200);
  const ws = await s.call('team_wait', { team: 'stale-1', expect: ['s-1'], timeoutMs: 1200, staleAfterMs: 800 });
  assert.equal(ws.payload.status, 'timeout');
  assert.equal(ws.payload.stale.length, 1, '长时间未上报的标签应判失联');
  assert.equal(ws.payload.stale[0].label, 's-1');
  assert.ok(ws.payload.hint.includes('失联'), 'hint 应提示失联');
  console.log(`OK  stale 失联检测（age=${ws.payload.stale[0].ageMs}ms）`);

  // ===== 持久化：重启后恢复 =====
  await s.call('agent_done', { team: 'persist-1', label: 'p-1', status: 'success', summary: '重启前发出的信号' });
  await s.call('agent_report', { team: 'persist-1', label: 'p-2', role: 'tester', task: '重启前注册' });
  await sleep(300); // 等防抖落盘
  s.child.kill();
  await sleep(200);

  const s2 = spawnServer();
  const init2 = await s2.rpc('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(init2.result.serverInfo.name, 'team-gate');
  const wp = await s2.call('team_wait', { team: 'persist-1', expect: ['p-1'], timeoutMs: 3000 });
  assert.equal(wp.payload.status, 'satisfied', '重启后应恢复重启前的信号');
  const sp = await s2.call('team_status', { team: 'persist-1' });
  assert.equal(sp.payload.roster.find((r) => r.label === 'p-2').task, '重启前注册', '重启后应恢复在线状态');
  s2.child.kill();
  console.log('OK  持久化：重启后信号与在线状态恢复');

  for (const f of [stateFile, `${stateFile}.tmp`]) {
    try { fs.unlinkSync(f); } catch { /* 忽略 */ }
  }
  console.log('\n端到端自测全部通过（v2.0 架构）');
  process.exit(0);
})().catch((err) => {
  console.error('\n自测失败:', err.message);
  process.exit(1);
});
