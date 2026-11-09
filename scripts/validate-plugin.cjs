#!/usr/bin/env node
// 校验 agent-team 插件：manifest 必填字段、glob 是否命中文件、frontmatter 必填字段
const fs = require('fs');
const path = require('path');

const root = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'agent-team');
const errors = [];

function fail(msg) { errors.push(msg); }

// --- manifest ---
const manifestPath = path.join(root, 'step.plugin.json');
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (e) {
  fail(`step.plugin.json 不是合法 JSON: ${e.message}`);
}
if (manifest) {
  if (manifest.size > 512 * 1024) fail('manifest 超过 512 KiB 上限');
  for (const k of ['id', 'name', 'description', 'version']) {
    if (!manifest[k]) fail(`manifest 缺少必填字段 ${k}`);
  }
  if (manifest.entry) fail('entry 仅记录不加载，本插件不应声明');
  if (manifest.mcpServers) {
    for (const [name, srv] of Object.entries(manifest.mcpServers)) {
      if (!srv.command) fail(`mcpServers.${name} 缺少 command`);
      for (const a of srv.args ?? []) {
        if (typeof a === 'string' && a.startsWith('.')) {
          const p = path.join(root, a);
          if (!fs.existsSync(p)) fail(`mcpServers.${name}.args 相对路径不存在: ${a}`);
          else console.log(`OK  mcpServers.${name}: ${a} 存在`);
        }
      }
    }
  }
  for (const [field, patterns] of Object.entries({ agents: manifest.agents, skills: manifest.skills, commands: manifest.commands })) {
    if (!patterns) continue;
    for (const p of patterns) {
      // 支持两种形态：目录路径（./agents）与末尾带文件模式的 glob（agents/*.md）
      const parts = p.split('/');
      const dir = path.join(root, ...parts.slice(0, -1));
      const filePat = parts[parts.length - 1];
      const isDir = fs.existsSync(path.join(root, p)) && fs.statSync(path.join(root, p)).isDirectory();
      if (isDir) {
        const hits = [];
        const walk = (d) => {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith('.md')) hits.push(path.relative(root, full));
          }
        };
        walk(path.join(root, p));
        if (hits.length === 0) fail(`${field} "${p}" 目录下没有 .md 文件`);
        else console.log(`OK  ${field}: ${p} -> ${hits.join(', ')}`);
        continue;
      }
      if (!fs.existsSync(dir)) { fail(`${field} glob "${p}" 目录不存在: ${dir}`); continue; }
      const rx = new RegExp('^' + filePat.replace(/\./g, '\\.').replace(/\*/g, '[^/]*') + '$');
      const hits = [];
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) walk(full);
          else if (rx.test(e.name)) hits.push(path.relative(root, full));
        }
      };
      walk(dir);
      if (hits.length === 0) fail(`${field} glob "${p}" 未命中任何文件`);
      else console.log(`OK  ${field}: ${p} -> ${hits.join(', ')}`);
    }
  }
}

// --- frontmatter ---
function parseFrontmatter(file) {
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { error: '缺少 frontmatter 块', body: text };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { fm, body: m[2] };
}

for (const f of fs.readdirSync(path.join(root, 'agents'))) {
  if (!f.endsWith('.md')) continue;
  const full = path.join(root, 'agents', f);
  const { fm, error } = parseFrontmatter(full);
  if (error) { fail(`agents/${f}: ${error}`); continue; }
  for (const k of ['name', 'description']) if (!fm[k]) fail(`agents/${f}: 缺少必填字段 ${k}`);
  if (fm.name && fm.name !== f.replace(/\.md$/, '')) fail(`agents/${f}: name "${fm.name}" 与文件名不一致`);
  if (fm.tools) {
    const tools = fm.tools.split(',').map((t) => t.trim());
    const known = new Set(['read_file', 'write_file', 'edit_file', 'run_command', 'find_files', 'search_files', 'list_directory', 'subagent', 'workflow']);
    for (const t of tools) if (!known.has(t) && !t.startsWith('mcp__')) fail(`agents/${f}: 未知工具名 "${t}"`);
    const required = ['mcp__team-gate__agent_report', 'mcp__team-gate__agent_done', 'mcp__team-gate__team_status', 'mcp__team-gate__agent_send', 'mcp__team-gate__agent_recv'];
    for (const r of required) if (!tools.includes(r)) fail(`agents/${f}: tools 缺少 ${r}`);
  }
  console.log(`OK  agents/${f}: name=${fm.name} tools=${fm.tools || '(默认)'}`);
}

const skillPath = path.join(root, 'skills', 'team-playbook', 'SKILL.md');
{
  const { fm, error } = parseFrontmatter(skillPath);
  if (error) fail(`skills/team-playbook/SKILL.md: ${error}`);
  else {
    for (const k of ['name', 'description']) if (!fm[k]) fail(`SKILL.md: 缺少必填字段 ${k}`);
    console.log(`OK  skills/team-playbook/SKILL.md: name=${fm.name}`);
  }
}

for (const f of fs.readdirSync(path.join(root, 'commands'))) {
  if (!f.endsWith('.md')) continue;
  const { fm, error } = parseFrontmatter(path.join(root, 'commands', f));
  if (error) { fail(`commands/${f}: ${error}`); continue; }
  if (!fm.description) fail(`commands/${f}: 缺少 description`);
  console.log(`OK  commands/${f}: ${fm.description.slice(0, 40)}...`);
  // server 三层文件均须存在且语法正确
  const srvDir = path.join(root, 'server');
  if (!fs.existsSync(srvDir)) {
    fail('server 目录不存在');
  } else {
    const { execFileSync } = require('child_process');
    for (const req of ['state.mjs', 'tools.mjs', 'team-gate.mjs']) {
      const p = path.join(srvDir, req);
      if (!fs.existsSync(p)) { fail(`server 缺少 ${req}`); continue; }
      try {
        execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' });
        console.log(`OK  server/${req} 语法`);
      } catch {
        fail(`server/${req} 语法错误`);
      }
    }
  }
}

if (errors.length) {
  console.error('\n校验失败:');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log('\n全部校验通过');
