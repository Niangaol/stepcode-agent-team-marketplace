#!/usr/bin/env node
/**
 * team-gate 端到端自测：以真实 MCP stdio 客户端方式驱动 server/team-gate.mjs
 * 覆盖：initialize / tools/list / agent_done 记录 / team_wait 满足 / 超时 / any /
 *       阻塞等待被后续信号唤醒 / 参数与错误路径 / 通知无响应
 */
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

const server = path.join(__dirname, '..', 'agent-team', 'server', 'team-gate.mjs');
const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'pipe'] });

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
child.stderr.on('data', () => {}); // server 日志走 stderr，忽略

function rpc(method, params, timeoutMs = 10000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => reject(new Error(`RPC ${method} 超时`)), timeoutMs);
  });
}
function call(name, args) {
  return rpc('tools/call', { name, arguments: args }).then((m) => {
    if (m.error) return { error: m.error };
    return { payload: JSON.parse(m.result.content[0].text), isError: m.result.isError === true };
  });
}

(async () => {
  // 1. initialize
  const init = await rpc('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(init.result.serverInfo.name, 'team-gate');
  assert.deepEqual(Object.keys(init.result.capabilities), ['tools']);
  console.log(`OK  initialize (protocolVersion=${init.result.protocolVersion})`);

  // 2. tools/list
  const list = await rpc('tools/list');
  const names = list.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['agent_done', 'agent_recv', 'agent_report', 'agent_send', 'team_status', 'team_wait']);
  for (const t of list.result.tools) assert.ok(t.inputSchema && t.description, `${t.name} 缺 schema/description`);
  console.log(`OK  tools/list: ${names.join(', ')}`);

  // 3. agent_done 记录信号
  const d1 = await call('agent_done', { label: 'build-core', status: 'success', summary: '改了 3 个文件', artifacts: ['a.ts'] });
  assert.equal(d1.payload.ok, true);
  assert.equal(d1.payload.totalSignals, 1);
  assert.equal(d1.payload.recorded.label, 'build-core');
  console.log('OK  agent_done 记录信号');

  // 4. team_wait all：信号已存在，应立即满足
  const t0 = Date.now();
  const w1 = await call('team_wait', { expect: ['build-core'], timeoutMs: 5000 });
  assert.equal(w1.payload.status, 'satisfied');
  assert.ok(Date.now() - t0 < 2000, '已满足时必须立即返回');
  console.log(`OK  team_wait(all) 已满足立即返回 (${w1.payload.waitedMs}ms)`);

  // 5. team_wait 缺信号 → 超时并给出 pending
  const w2 = await call('team_wait', { expect: ['nope-1', 'nope-2'], timeoutMs: 1500 });
  assert.equal(w2.payload.status, 'timeout');
  assert.deepEqual([...w2.payload.pending].sort(), ['nope-1', 'nope-2']);
  assert.ok(w2.payload.waitedMs >= 1400 && w2.payload.waitedMs < 4000, '超时时长应接近 timeoutMs');
  console.log(`OK  team_wait(all) 超时返回 pending: ${w2.payload.pending.join(', ')} (${w2.payload.waitedMs}ms)`);

  // 6. team_wait any：期望列表中任一存在即满足
  const w3 = await call('team_wait', { expect: ['build-core', 'other'], mode: 'any', timeoutMs: 3000 });
  assert.equal(w3.payload.status, 'satisfied');
  console.log('OK  team_wait(any) 任一信号即满足');

  // 7. 阻塞等待被后续信号唤醒（不等满超时）
  const t5 = Date.now();
  const wPromise = call('team_wait', { expect: ['late-bird'], timeoutMs: 8000 });
  setTimeout(() => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: 'agent_done', arguments: { label: 'late-bird', status: 'success', summary: '迟到的里程碑信号' } } }) + '\n');
  }, 600);
  const w5 = await wPromise;
  const elapsed = Date.now() - t5;
  assert.equal(w5.payload.status, 'satisfied', '信号到达后应满足');
  assert.ok(elapsed < 4000, `信号到达后应尽快返回，实际 ${elapsed}ms`);
  console.log(`OK  team_wait 阻塞中被后续信号唤醒 (${elapsed}ms)`);

  // 8. 参数与错误路径
  const d2 = await call('agent_done', { label: '' });
  assert.equal(d2.payload.ok, false);
  assert.ok(d2.payload.error);
  const bad = await call('no_such_tool', {});
  assert.ok(bad.error, '未知工具应返回 JSON-RPC error');
  console.log('OK  参数校验与未知工具错误路径');

  // 9. 通知无响应（发了不应崩，也不应有挂起 pending）
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(pending.size, 0, '通知不应产生挂起请求');
  console.log('OK  通知被正确忽略');

  // ===== A2A：状态注册 / 实时总览 / 点对点与广播消息 =====

  // 10. agent_report：两个 agent 注册存在与当前任务
  const r1 = await call('agent_report', { label: 'scout-1', role: 'scout', task: '摸清支付模块调用链' });
  assert.equal(r1.payload.ok, true);
  assert.equal(r1.payload.onlineCount, 1);
  const r2 = await call('agent_report', { label: 'builder-1', role: 'builder', task: '修改 core/pay.ts 的重试逻辑' });
  assert.equal(r2.payload.onlineCount, 2);
  // upsert：同 label 再报一次只更新不新增
  const r3 = await call('agent_report', { label: 'builder-1', task: '修改 core/pay.ts 并补测试', status: 'running' });
  assert.equal(r3.payload.onlineCount, 2);
  assert.equal(r3.payload.presence.task, '修改 core/pay.ts 并补测试');
  console.log('OK  agent_report 注册与 upsert（onlineCount=2）');

  // 11. team_status：全团队实时总览
  const s1 = await call('team_status', {});
  assert.equal(s1.payload.onlineCount, 2);
  const scout = s1.payload.roster.find((r) => r.label === 'scout-1');
  const builder = s1.payload.roster.find((r) => r.label === 'builder-1');
  assert.equal(scout.task, '摸清支付模块调用链');
  assert.equal(builder.task, '修改 core/pay.ts 并补测试');
  assert.equal(scout.status, 'running');
  console.log('OK  team_status 总览：可见各 agent 的状态与正在进行的任务');

  // 12. A2A 点对点消息 + 已读语义
  const m1 = await call('agent_send', { from: 'scout-1', to: 'builder-1', content: '入口是 pay/router.ts:42，别动 legacy 目录' });
  assert.equal(m1.payload.ok, true);
  const recv1 = await call('agent_recv', { label: 'builder-1' });
  assert.equal(recv1.payload.count, 1);
  assert.equal(recv1.payload.unread[0].from, 'scout-1');
  const recv2 = await call('agent_recv', { label: 'builder-1' });
  assert.equal(recv2.payload.count, 0, '第二次读取应为空（已标记已读）');
  const recv3 = await call('agent_recv', { label: 'scout-1', markRead: false });
  assert.equal(recv3.payload.count, 0, '非接收方不应收到点对点消息');
  console.log('OK  A2A 点对点消息 + 已读语义');

  // 13. 广播消息：所有 agent_recv 可见
  const m2 = await call('agent_send', { from: 'scout-1', to: '*', content: '支付模块有 3 个调用方，都要兼容' });
  const b1 = await call('agent_recv', { label: 'builder-1' });
  const b2 = await call('agent_recv', { label: 'tester-9' });
  assert.ok(b1.payload.count >= 1 && b2.payload.count >= 1, '广播应被所有 label 收到');
  assert.equal(b1.payload.unread[0].content, '支付模块有 3 个调用方，都要兼容');
  console.log('OK  广播消息触达所有 agent');

  // 14. agent_done 同步在线状态
  const dd = await call('agent_done', { label: 'builder-1', status: 'success', summary: '改完并验证' });
  const s2 = await call('team_status', {});
  assert.equal(s2.payload.roster.find((r) => r.label === 'builder-1').status, 'done');
  console.log('OK  agent_done 后 team_status 显示 done');

  // 15. team_wait 返回在线名单快照（含等待中的 waits）
  const t15 = Date.now();
  const waitP = call('team_wait', { expect: ['never-comes'], timeoutMs: 1500 });
  await new Promise((r) => setTimeout(r, 300));
  const s3 = await call('team_status', {});
  assert.equal(s3.payload.waits.length, 1, '等待中应可见主智能体的 team_wait');
  assert.deepEqual(s3.payload.waits[0].expect, ['never-comes']);
  const w15 = await waitP;
  assert.equal(w15.payload.status, 'timeout');
  assert.ok(Array.isArray(w15.payload.roster) && w15.payload.roster.length === 2, 'team_wait 结果应含在线名单');
  console.log(`OK  team_wait 可见 waits + 返回 roster 快照 (${Date.now() - t15}ms)`);

  // 16. reset 清空全部状态
  const w16 = await call('team_wait', { reset: true, expect: ['scout-1'], timeoutMs: 1500 });
  const s4 = await call('team_status', {});
  assert.equal(s4.payload.onlineCount, 0, 'reset 后应无在线 agent');
  assert.equal(s4.payload.recentSignals.length, 0, 'reset 后应无信号');
  console.log('OK  reset 清空信号/在线状态/消息');

  console.log('\n端到端自测全部通过');
  child.kill();
  process.exit(0);
})().catch((err) => {
  console.error('\n自测失败:', err.message);
  child.kill();
  process.exit(1);
});
