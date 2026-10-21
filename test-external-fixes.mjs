#!/usr/bin/env node
'use strict';

/**
 * 外人体验修复批次锁定验收测试(指挥官亲笔,2026-10-22,禁止编码手修改)
 *
 * 覆盖三个任务:
 *   T1 fallback_scope:auto 默认把接力约束在显式白名单内(修 QA-B BUG-B1 越权烧配额)
 *   T2 /api/dispatch 同步路径早期错误返回 4xx + {error, code} 同构 JSON
 *   T3 /v1/models 暴露全部启用工具;/v1/chat/completions 支持 model=<工具名>
 *
 * 隔离:端口 9811、独立数据目录/库,测前禁用全部真实 CLI 工具(防烧外部配额、防不确定性)。
 * 运行:node test-external-fixes.mjs ;退出码 0 全绿 / 1 有失败
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = 9811;
const HOST = '127.0.0.1';
const PROBE = 'ext-probe';
const OTHER = 'ext-other';
const TEST_RUNTIME = path.join(__dirname, 'test-runtime-data-ext');
function testDataPath (n) { return path.join(TEST_RUNTIME, n); }

let passed = 0, failed = 0;
const failures = [];
function check (name, cond, detail) {
  if (cond) { passed++; process.stdout.write(`  ✅ ${name}\n`); }
  else { failed++; failures.push(name); process.stdout.write(`  ❌ ${name}${detail ? ' — ' + detail : ''}\n`); }
}
function section (t) { process.stdout.write(`\n── ${t} ──\n`); }

function req (method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: HOST, port: PORT, path: p, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      timeout: 60000
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d || '{}') }); } catch { resolve({ status: res.statusCode, body: d }); } });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('http timeout ' + p)); });
    if (data) r.write(data);
    r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 每个通道计数收到的反向调用次数;makeText 决定该客户端对任务的应答
function makeChannel (child, makeText) {
  let buf = '';
  const pending = new Map();
  let idc = 0;
  const stats = { sampling: 0 };
  child.stdout.on('data', d => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.method === 'sampling/createMessage' && msg.id !== undefined) {
        const task = msg.params?.messages?.[0]?.content || '';
        stats.sampling++;
        child.stdin.write(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { content: { type: 'text', text: makeText(task) }, usage: { inputTokens: 12, outputTokens: 34 } }
        }) + '\n');
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id).resolve(msg);
        pending.delete(msg.id);
      }
    }
  });
  return {
    stats,
    request (method, params) {
      const id = ++idc;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('mcp timeout: ' + method)); } }, 60000);
      });
    }
  };
}

const probeText = t => t.trimStart().startsWith('EMPTYOUT_MARK') ? ''
  : '```python\ndef add(a, b):\n    return a + b  # FROM_PROBE\n```';
const otherText = () => '```python\ndef add(a, b):\n    return a + b  # FROM_OTHER\n```';

async function waitServerReady (timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await req('GET', '/api/health'); if (r.status === 200 && r.body.status === 'ok') return; } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error('server 启动超时');
}
async function waitClientConnected (name, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await req('GET', '/api/clients');
      if ((r.body.clients || []).some(c => c.id === name && c.online === true)) return;
    } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error('客户端连接超时: ' + name);
}

let serverProc = null, probeProc = null, otherProc = null, serverErr = '';

async function main () {
  process.stdout.write('外人体验修复批次 锁定验收测试\n' + '='.repeat(40) + '\n');
  fs.rmSync(TEST_RUNTIME, { recursive: true, force: true });
  fs.mkdirSync(TEST_RUNTIME, { recursive: true });
  fs.writeFileSync(testDataPath('clients-acl.json'),
    JSON.stringify({ allowlist: [PROBE, OTHER], blocklist: [], pending: [] }, null, 2));

  serverProc = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, AI_BRIDGE_PORT: String(PORT), AI_BRIDGE_HOST: HOST, AI_BRIDGE_DATA_DIR: TEST_RUNTIME, AI_BRIDGE_DB: testDataPath('ext-bridge.db'), AI_BRIDGE_OBSERVE_DIR: testDataPath('observe'), AI_BRIDGE_WORKSPACE_ROOT: testDataPath('workspaces'), AI_BRIDGE_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProc.stderr.on('data', d => { serverErr += d.toString(); });
  await waitServerReady();

  probeProc = spawn(process.execPath, ['bridge-stdio.js'], {
    cwd: __dirname, env: { ...process.env, AI_BRIDGE_PORT: String(PORT), AI_BRIDGE_HOST: HOST, AI_BRIDGE_CLIENT: PROBE }, stdio: ['pipe', 'pipe', 'pipe'] });
  const probe = makeChannel(probeProc, probeText);
  await waitClientConnected(PROBE);
  await probe.request('initialize', { capabilities: { sampling: {} } });

  otherProc = spawn(process.execPath, ['bridge-stdio.js'], {
    cwd: __dirname, env: { ...process.env, AI_BRIDGE_PORT: String(PORT), AI_BRIDGE_HOST: HOST, AI_BRIDGE_CLIENT: OTHER }, stdio: ['pipe', 'pipe', 'pipe'] });
  const other = makeChannel(otherProc, otherText);
  await waitClientConnected(OTHER);
  await other.request('initialize', { capabilities: { sampling: {} } });
  await sleep(300);

  // 0) 卫生前置:禁用全部真实 CLI/非客户端工具,防 fallback 池触及外部配额、保证确定性
  section('前置:禁用真实 CLI 工具,仅保留两个 mock 客户端');
  const toolsView = await req('GET', '/api/tools');
  let disabledCount = 0;
  for (const t of toolsView.body.tools || []) {
    if (t.type !== 'client' && t.enabled !== false) {
      await req('POST', '/api/toggle', { tool: t.id || t.name, enabled: false });
      disabledCount++;
    }
  }
  const toolsAfter = await req('GET', '/api/tools');
  const enabledNonClient = (toolsAfter.body.tools || []).filter(t => t.type !== 'client' && t.enabled !== false);
  check('真实 CLI 工具全部禁用(数量与清单核对)', disabledCount > 0 && enabledNonClient.length === 0, `disabled=${disabledCount} stillEnabled=${enabledNonClient.length}`);

  // ── T1 fallback_scope ──
  section('T1: fallback_scope 默认把接力约束在显式白名单内');
  const p0 = probe.stats.sampling, o0 = other.stats.sampling;
  const d1 = await req('POST', '/api/dispatch', { task: 'EMPTYOUT_MARK 默认作用域不得越白名单', tools: [PROBE] });
  check('T1-1 默认(auto): 白名单外工具零调用', d1.status === 200 && other.stats.sampling === o0 && probe.stats.sampling === p0 + 1,
    `status=${d1.status} probe=${probe.stats.sampling - p0} other=${other.stats.sampling - o0}`);
  check('T1-2 默认(auto): 失败且无接力,successCount=0', d1.body.successCount === 0, JSON.stringify(d1.body).substring(0, 250));
  check('T1-3 默认(auto): fallbackLog 记录被作用域抑制的接力', (d1.body.fallbackLog || []).some(e => e.from === PROBE && e.suppressed === true),
    JSON.stringify(d1.body.fallbackLog || []));

  const p1 = probe.stats.sampling, o1 = other.stats.sampling;
  const d2 = await req('POST', '/api/dispatch', { task: 'EMPTYOUT_MARK 显式 all 允许池回退', tools: [PROBE], fallback_scope: 'all' });
  check('T1-4 scope=all: 白名单外接力成功', d2.status === 200 && d2.body.successCount === 1 && other.stats.sampling === o1 + 1,
    `status=${d2.status} successCount=${d2.body.successCount} otherDelta=${other.stats.sampling - o1}`);
  const r2 = (d2.body.results || [])[0] || {};
  check('T1-5 scope=all: 结果替换为接力工具且带 fallback 标记', r2.tool === OTHER && r2.fallback === true && String(r2.content || '').includes('FROM_OTHER'), JSON.stringify(r2).substring(0, 200));

  const o2 = other.stats.sampling;
  const d3 = await req('POST', '/api/dispatch', { task: 'EMPTYOUT_MARK 显式 none 禁一切接力', tools: [PROBE], fallback_scope: 'none' });
  check('T1-6 scope=none: 失败且接力链完全跳过(fallbackLog 空)', d3.status === 200 && d3.body.successCount === 0 && other.stats.sampling === o2 && (d3.body.fallbackLog || []).length === 0,
    `status=${d3.status} successCount=${d3.body.successCount} otherDelta=${other.stats.sampling - o2} fbLog=${JSON.stringify(d3.body.fallbackLog || [])}`);

  const o3 = other.stats.sampling;
  const d4 = await req('POST', '/api/dispatch', { task: 'EMPTYOUT_MARK 非法作用域值按 auto 处理', tools: [PROBE], fallback_scope: 'blah' });
  check('T1-7 非法 fallback_scope 按 auto 处理(不越白名单)', d4.status === 200 && d4.body.successCount === 0 && other.stats.sampling === o3, `otherDelta=${other.stats.sampling - o3}`);

  // ── T2 早期错误 4xx 同构 ──
  section('T2: dispatch 早期错误 4xx + {error, code} 同构');
  const e1 = await req('POST', '/api/dispatch', {});
  check('T2-1 缺 task → 400 invalid_request', e1.status === 400 && typeof e1.body.error === 'string' && e1.body.code === 'invalid_request', `status=${e1.status} ${JSON.stringify(e1.body).substring(0, 150)}`);
  const e2 = await req('POST', '/api/dispatch', { task: 'x'.repeat(50001) });
  check('T2-2 超长 task → 400 invalid_request 且原因含"过长"', e2.status === 400 && e2.body.code === 'invalid_request' && /过长/.test(e2.body.error || ''), `status=${e2.status}`);
  const e3 = await req('POST', '/api/dispatch', { task: 'ok', workspace: 'ext-nonexistent-ws' });
  check('T2-3 工作区不存在 → 400 workspace_error', e3.status === 400 && e3.body.code === 'workspace_error', `status=${e3.status} ${JSON.stringify(e3.body).substring(0, 150)}`);
  const e4 = await req('POST', '/api/dispatch', { task: 'ok', tools: ['ext-no-such-tool'] });
  check('T2-4 无可执行目标 → 409 no_targets', e4.status === 409 && e4.body.code === 'no_targets', `status=${e4.status} ${JSON.stringify(e4.body).substring(0, 150)}`);
  const e5 = await req('POST', '/api/dispatch', { async: true });
  check('T2-5 async 缺 task → 400 同构(不产生孤儿任务)', e5.status === 400 && typeof e5.body.error === 'string', `status=${e5.status}`);
  const e6 = await req('POST', '/api/dispatch', { task: 'EMPTYOUT_MARK 正常路径不受影响', tools: [PROBE], fallback_scope: 'none' });
  check('T2-6 工具级失败仍为 200 结果体(非早期错误)', e6.status === 200 && e6.body.successCount === 0 && !e6.body.error, `status=${e6.status}`);

  // ── T3 /v1 对齐 ──
  section('T3: /v1/models 暴露启用工具 + /v1/chat/completions 支持工具名模型');
  await req('POST', '/api/toggle', { tool: 'claude-code', enabled: true });
  await req('POST', '/api/toggle', { tool: 'opencode', enabled: true });
  await sleep(500); // models/tools 缓存
  const m1 = await req('GET', '/v1/models');
  const ids = (m1.body.data || []).map(x => x.id);
  check('T3-1 /v1/models 含重新启用的工具 claude-code', ids.includes('claude-code'), 'ids=' + ids.join(','));
  check('T3-2 /v1/models 仍列出被禁工具之外的两个客户端', ids.includes(PROBE) && ids.includes(OTHER));
  check('T3-3 /v1/models 不含被禁用工具 opencode-flash', !ids.includes('opencode-flash'), 'ids=' + ids.filter(i => i.includes('opencode')).join(','));
  check('T3-4 id=opencode 全局唯一(models.json 优先,不与工具重复)', ids.filter(i => i === 'opencode').length === 1, 'count=' + ids.filter(i => i === 'opencode').length);

  const c1 = await req('POST', '/v1/chat/completions', { model: PROBE, messages: [{ role: 'user', content: '写一个 add 函数' }] });
  const msg = c1.body.choices?.[0]?.message;
  check('T3-5 model=客户端工具名 → 200 chat.completion 且内容来自该工具', c1.status === 200 && c1.body.object === 'chat.completion' && String(msg?.content || '').includes('FROM_PROBE'),
    `status=${c1.status} ${JSON.stringify(c1.body).substring(0, 200)}`);
  check('T3-6 响应含 usage.total_tokens>0 且 choices[0].message.role=assistant', typeof c1.body.usage?.total_tokens === 'number' && c1.body.usage.total_tokens > 0 && msg?.role === 'assistant', JSON.stringify(c1.body.usage || {}));

  const c2 = await req('POST', '/v1/chat/completions', { model: 'ext-nonexistent-model', messages: [{ role: 'user', content: 'x' }] });
  check('T3-7 未知模型 → 404 且提示可用清单', c2.status === 404 && /\/v1\/models|可用模型/.test(String(c2.body.error || '')), `status=${c2.status}`);
  const c3 = await req('POST', '/v1/chat/completions', { model: PROBE, messages: [{ role: 'user', content: 'EMPTYOUT_MARK 静默失败应报错' }] });
  check('T3-8 工具空产出 → 502 同构错误(不返回空 completion)', c3.status === 502 && typeof c3.body.error === 'string', `status=${c3.status} ${JSON.stringify(c3.body).substring(0, 150)}`);

  // ── 静态接线检查 ──
  section('静态接线:server.js / README');
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf-8');
  check('S-1 路由读取 body.fallback_scope 并透传', /body\.fallback_scope/.test(src));
  check('S-2 错误码枚举齐全(invalid_request/workspace_error/workspace_busy/no_targets/too_many)', ['invalid_request', 'workspace_error', 'workspace_busy', 'no_targets', 'too_many'].every(c => src.includes(`'${c}'`)));
  check('S-3 chat 工具分支流量记录 type=openai-tool', /openai-tool/.test(src));
  const readme = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf-8');
  check('S-4 README 写明 Node.js 22+ 硬依赖', /Node(\.js)? 22/.test(readme));
  check('S-5 README 含 opencode 免费模型接入指引', /opencode/i.test(readme) && /(免费|free)/i.test(readme));

  process.stdout.write('\n' + '='.repeat(40) + '\n');
  process.stdout.write(`结果: ${passed} 通过 / ${failed} 失败\n`);
  if (failed) { process.stdout.write('失败项: ' + failures.join('; ') + '\n'); if (serverErr) process.stdout.write('server stderr 尾部:\n' + serverErr.slice(-2000) + '\n'); }
}

main().catch(e => {
  process.stderr.write('测试框架异常: ' + e.stack + '\n');
  process.exitCode = 1;
}).finally(() => {
  for (const p of [probeProc, otherProc, serverProc]) { try { p && p.kill(); } catch { /* ignore */ } }
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
});
