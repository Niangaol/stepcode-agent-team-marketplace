#!/usr/bin/env node
/**
 * team-gate — 智能体团队协作门禁（MCP stdio server，零依赖）
 *
 * 架构（三层，均无第三方依赖）：
 *   server/state.mjs    状态层：团队隔离 + 原子持久化（state/teams.json）
 *   server/tools.mjs    工具层：六个工具的定义与实现（team_wait / agent_done /
 *                        agent_report / team_status / agent_send / agent_recv）
 *   server/team-gate.mjs 协议层（本文件）：MCP over stdio 的 JSON-RPC 2.0 收发
 *
 * 协议：换行分隔的 JSON-RPC 2.0。stdout 只走协议，日志走 stderr。
 */
import { createInterface } from 'node:readline';
import { TOOLS, callTool, createToolContext } from './tools.mjs';

const PROTOCOL_FALLBACK = '2024-11-05';
const SERVER_VERSION = '2.0.0';

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

const ctx = createToolContext({ log });

async function handleRequest(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      send(id, {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_FALLBACK,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'team-gate', version: SERVER_VERSION },
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
        const result = await callTool(name, args, ctx);
        if (result?.error && typeof result.error === 'string') {
          sendError(id, -32602, result.error);
          return;
        }
        send(id, result);
      } catch (err) {
        log('工具执行失败:', String(err?.stack ?? err));
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

log(`team-gate MCP server v${SERVER_VERSION} 已启动（stdio）`);
