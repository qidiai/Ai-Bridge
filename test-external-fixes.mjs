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
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

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
// #64 本格额外起的中枢/假上游,统一登记给 finally 收尾(不留孤儿进程占端口)
const extraProcs = [];

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

  // ── T4 模型透传:单元级(CliAdapter + 校验 + 无 modelFlag 免疫) ──
  section('T4: CLI 模型透传(-m 覆盖/注入拒绝/无声明免疫/追加形态)');
  const { CliAdapter } = require('./adapters/cli-adapter.js');
  const fakeArgv = path.join(TEST_RUNTIME, 'fake_argv.js');
  fs.writeFileSync(fakeArgv, 'console.log(JSON.stringify(process.argv.slice(2)))\n', 'utf-8');
  const t4out = testDataPath('t4out');
  const mkCfg = (args, extra) => ({ name: 't4fake', displayName: 'T4 Fake', description: '', command: process.execPath, args, inputMode: 'arg', timeout: 30000, ...extra });

  try {
    const ad1 = new CliAdapter(mkCfg([fakeArgv, '-m', 'default/model'], { modelFlag: '-m' }));
    const r1 = await ad1.execute('hi', { outputDir: t4out, model: 'foo/bar' });
    const argv1 = JSON.parse(String(r1.content || '').trim());
    check('U-1 modelFlag 覆盖默认模型(替换首个 -m 的下一参数)', argv1.includes('-m') && argv1[argv1.indexOf('-m') + 1] === 'foo/bar' && !argv1.includes('default/model'), JSON.stringify(argv1));
  } catch (e) { check('U-1 modelFlag 覆盖默认模型(替换首个 -m 的下一参数)', false, e.message); }

  try {
    const ad2 = new CliAdapter(mkCfg([fakeArgv, '-m', 'default/model'], { modelFlag: '-m' }));
    let injErr = null;
    try { await ad2.execute('hi', { outputDir: t4out, model: 'bad model;rm -rf x' }); } catch (e) { injErr = e; }
    check('U-2 含空格/元字符的模型名被拒绝(执行前抛错,不 spawn)', injErr !== null && /不合法/.test(String(injErr && injErr.message)), injErr ? String(injErr.message).substring(0, 120) : 'no-throw');
  } catch (e) { check('U-2 含空格/元字符的模型名被拒绝(执行前抛错,不 spawn)', false, e.message); }

  try {
    const ad3 = new CliAdapter(mkCfg([fakeArgv, '-m', 'default/model']));
    const r3 = await ad3.execute('hi', { outputDir: t4out, model: 'foo/bar' });
    const argv3 = JSON.parse(String(r3.content || '').trim());
    check('U-3 未声明 modelFlag 的工具对 model 覆盖免疫(参数原样)', argv3.includes('default/model') && !argv3.includes('foo/bar'), JSON.stringify(argv3));
  } catch (e) { check('U-3 未声明 modelFlag 的工具对 model 覆盖免疫(参数原样)', false, e.message); }

  try {
    const ad4 = new CliAdapter(mkCfg([fakeArgv], { modelFlag: '-m' }));
    const r4 = await ad4.execute('hi', { outputDir: t4out, model: 'x/y' });
    const argv4 = JSON.parse(String(r4.content || '').trim());
    check('U-4 args 无默认 -m 时追加 [modelFlag, model] 到末尾', argv4.slice(-2).join('|') === '-m|x/y', JSON.stringify(argv4));
  } catch (e) { check('U-4 args 无默认 -m 时追加 [modelFlag, model] 到末尾', false, e.message); }

  // ── T4 模型发现端点(服务端行为) ──
  section('T4: GET /api/discover-models 模型发现');
  const dm1 = await req('GET', '/api/discover-models?tool=ext-no-such-tool');
  check('U-5a 未知工具 → 400', dm1.status === 400 && typeof dm1.body.error === 'string', `status=${dm1.status}`);
  const dm2 = await req('GET', '/api/discover-models?tool=qoder');
  check('U-5b 未声明 modelListCmd 的工具 → 400 且提示不支持', dm2.status === 400 && /不支持|无/.test(dm2.body.error || ''), `status=${dm2.status} ${JSON.stringify(dm2.body).substring(0, 120)}`);
  const dm3 = await req('GET', '/api/discover-models?tool=opencode');
  check('U-5c opencode 探测:200+models数组 或 503(命令不可用,均视为环境合规)', (dm3.status === 200 && Array.isArray(dm3.body.models)) || dm3.status === 503, `status=${dm3.status} ${JSON.stringify(dm3.body).substring(0, 150)}`);

  // ── T5 用量自报协议(usage-reporter 单元) ──
  section('T5: usage-reporter [USAGE] 自报协议');
  let ur = null;
  try { ur = require('./usage-reporter.js'); } catch (e) { /* 缺失时下方逐项判红 */ }
  check('V-1 usage-reporter 模块存在且导出后缀常量', !!ur && typeof ur.USAGE_REPORT_SUFFIX === 'string' && /\[USAGE\] input=/.test(ur.USAGE_REPORT_SUFFIX) && /自报/.test(ur.USAGE_REPORT_SUFFIX), ur ? 'exports=' + Object.keys(ur).join(',') : 'require failed');
  const need = typeof ur?.parseUsageReport === 'function' ? ur.parseUsageReport : () => ({ content: '(unavailable)', usage: undefined });
  {
    const a = need('结果代码\n[USAGE] input=123 output=45');
    check('V-2 末行标记被剥离且用量转正式 reported(123/45/168)', a.content === '结果代码' && a.usage?.input === 123 && a.usage?.output === 45 && a.usage?.total === 168 && a.usage?.reported === true, JSON.stringify(a).substring(0, 200));
    const b = need('AB\r\n[USAGE]  input = 10  output = 20  \r\n');
    check('V-3 CRLF/多空格/等号两侧空白容错(10/20/30)', b.content.startsWith('AB') && b.usage?.input === 10 && b.usage?.output === 20 && b.usage?.total === 30, JSON.stringify(b).substring(0, 200));
    const c = need('no marker here');
    check('V-4 无标记时 content 原样且 usage=null', c.content === 'no marker here' && c.usage === null, JSON.stringify(c).substring(0, 120));
    const d = need('x\n[USAGE] input=1 output=2\ny\n[USAGE] input=7 output=8');
    check('V-5 多个标记取最后一个(仅剥离该行)', d.usage?.input === 7 && d.usage?.output === 8 && String(d.content).split('\n').pop() === 'y', JSON.stringify(d).substring(0, 200));
    const f = need('big\n[USAGE] input=999999999 output=999999999');
    check('V-6 超 1e8 视为无效值:仍剥离但 usage=null', f.content === 'big' && f.usage === null, JSON.stringify(f).substring(0, 150));
  }

  // ── #64 免鉴权面的对端约束(/proxy/ 与 Web UI 声称"仅本地"却无人核实) ──
  // 病灶:server.js 全文 0 处 remoteAddress 检查,而 AI_BRIDGE_HOST 可被设成 0.0.0.0;
  //   /proxy/ 在鉴权门之前分发,任何非本地对端都能拿中枢当免费中继(能花钱、能观测)。
  // 判据口径:一律取"上游到底收到几个请求"这一直接证据,不看响应文案(文案是实现细节,锁它=锁一张嘴)。
  section('#64: 免鉴权面必须核实对端(非回环不得无凭据借道 /proxy/ 与 Web UI)');
  const R64_LAN_PORT = 9818, R64_UP_PORT = 9817, R64_BARE_PORT = 9819;
  const R64_TOKEN = 'r64-token';
  const lanIp = (() => {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
    }
    return null;
  })();
  const srcNow = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf-8');
  let upHits = 0; const upPeers = [];
  const upSrv = http.createServer((q, s) => {
    upHits++; upPeers.push(q.socket.remoteAddress);
    s.writeHead(200, { 'Content-Type': 'application/json' });
    s.end(JSON.stringify({ choices: [{ message: { content: 'UP_HIT' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }));
  });

  // 通用请求器(全局 req 把 HOST/PORT 写死了,本格的第三方中枢要按指定 host/port 打)
  const reqTo = (hostname, port, method, p, body, headers) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { ...(headers || {}) };
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ hostname, port, path: p, method, headers: h, timeout: 8000 }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d || '{}'), raw: d }); } catch { resolve({ status: res.statusCode, body: null, raw: d }); } });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('reqTo 超时 ' + p)); });
    if (data) r.write(data);
    r.end();
  });

  // 有界轮询起中枢(本格新写的等待必须遵守 #115 立的规矩:固定 sleep 不算就绪判据)
  const bootHub = (port, env, dirName) => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: {
        ...process.env, AI_BRIDGE_PORT: String(port), AI_BRIDGE_HOST: '0.0.0.0',
        AI_BRIDGE_DATA_DIR: testDataPath(dirName), AI_BRIDGE_DB: testDataPath(path.join(dirName, 'lan.db')),
        AI_BRIDGE_OBSERVE_DIR: testDataPath(path.join(dirName, 'observe')), AI_BRIDGE_WORKSPACE_ROOT: testDataPath(path.join(dirName, 'ws')),
        AI_BRIDGE_TOKEN: '', ...env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    extraProcs.push(proc);
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { out += d.toString(); });
    const t0 = Date.now(); let tried = 0;
    const tick = async () => {
      if (Date.now() - t0 > 20000) { reject(new Error('中枢启动超时(20s) stdout=' + out.substring(0, 300))); return; }
      tried++;
      try {
        const r = await reqTo('127.0.0.1', port, 'GET', '/api/health', null, null);
        if (r.status === 200) { resolve({ proc, out: () => out, polls: tried, elapsedMs: Date.now() - t0 }); return; }
      } catch { /* 还没起来,继续轮询 */ }
      setTimeout(tick, 100);
    };
    setTimeout(tick, 50);
  });

  try {
    if (!lanIp) throw new Error('本机没有非回环 IPv4,无法构造非本地对端(本格判据不能假装绿)');
    await new Promise((res, rej) => { upSrv.once('error', rej); upSrv.listen(R64_UP_PORT, '0.0.0.0', res); });
    extraProcs.push(upSrv);
    const lan = await bootHub(R64_LAN_PORT, { AI_BRIDGE_TOKEN: R64_TOKEN }, 'lan-hub');

    // 控制组先跑:路由登记要凭据(证明门还在工作),且登记成功是后面所有判据的前提
    const regRoute = await reqTo('127.0.0.1', R64_LAN_PORT, 'POST', '/api/observe/route',
      { source: 'r64src', key: 'r64key', upstream: `http://127.0.0.1:${R64_UP_PORT}` }, { authorization: `Bearer ${R64_TOKEN}` });
    const regNoAuth = await reqTo('127.0.0.1', R64_LAN_PORT, 'POST', '/api/observe/route', { source: 'x', key: 'y', upstream: 'http://127.0.0.1:1' }, null);
    check('#64a0 控制组:登记路由须凭据(有 token 200 / 无 token 401),且假上游服务已就位',
      regRoute.status === 200 && regNoAuth.status === 401 && upHits === 0,
      `带凭据=${regRoute.status} 无凭据=${regNoAuth.status} 上游已收到=${upHits}`);

    // ── 红:非回环无凭据借道 /proxy/ ──
    const hitBeforeRemote = upHits;
    const proxyRemote = await reqTo(lanIp, R64_LAN_PORT, 'POST', '/proxy/r64src/r64key/v1/chat/completions', { model: 'm', messages: [] }, null);
    check('#64a1 红:非回环对端无凭据打 /proxy/ 必须被拒且上游零收到(现状=免鉴权直接透传,上游收到 1 次)',
      upHits - hitBeforeRemote === 0 && (proxyRemote.status === 401 || proxyRemote.status === 403),
      `上游增量=${upHits - hitBeforeRemote} status=${proxyRemote.status} 对端=${lanIp}`);

    // ── 红:X-Forwarded-For 伪造"我在本地"不得生效(判据必须读 socket,不读可伪造的头) ──
    const hitBeforeSpoof = upHits;
    const proxySpoof = await reqTo(lanIp, R64_LAN_PORT, 'POST', '/proxy/r64src/r64key/v1/chat/completions',
      { model: 'm', messages: [] }, { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' });
    check('#64a4 红:非回环对端伪造 X-Forwarded-For:127.0.0.1 仍须被拒(判据取 socket,不取请求头)',
      upHits - hitBeforeSpoof === 0 && (proxySpoof.status === 401 || proxySpoof.status === 403),
      `上游增量=${upHits - hitBeforeSpoof} status=${proxySpoof.status}`);

    // ── 红:Web UI 的"只允许本地访问"同样无人核实 ──
    const uiRemote = await reqTo(lanIp, R64_LAN_PORT, 'GET', '/', null, null);
    const uiHtml = /<html|<!doctype/i.test(String(uiRemote.raw || ''));
    check('#64a2 红:非回环对端取 Web UI 根路径不得拿到页面(现状=注释声称仅本地但 0 处 remoteAddress 检查)',
      !uiHtml && (uiRemote.status === 401 || uiRemote.status === 403),
      `status=${uiRemote.status} 拿到HTML=${uiHtml} 长度=${String(uiRemote.raw || '').length}`);

    // ── 反向自证:约束不得过宽(本地工具接管不能被打断,LAN 显式带凭据必须仍可) ──
    const hitBeforeLocal = upHits;
    const proxyLocal = await reqTo('127.0.0.1', R64_LAN_PORT, 'POST', '/proxy/r64src/r64key/v1/chat/completions', { model: 'm', messages: [] }, null);
    const deltaLocal = upHits - hitBeforeLocal;
    const hitBeforeAuthed = upHits;
    const proxyRemoteAuthed = await reqTo(lanIp, R64_LAN_PORT, 'POST', '/proxy/r64src/r64key/v1/chat/completions',
      { model: 'm', messages: [] }, { authorization: `Bearer ${R64_TOKEN}` });
    const deltaAuthed = upHits - hitBeforeAuthed;
    check('#64a3 反向自证(过宽即打红):回环免凭据仍可透传、非回环带凭据仍可透传,各让上游 +1',
      deltaLocal === 1 && proxyLocal.status === 200 && deltaAuthed === 1 && (proxyRemoteAuthed.status === 200 || proxyRemoteAuthed.status === 502),
      `回环增量=${deltaLocal}(应=1) status=${proxyLocal.status} | 带凭据增量=${deltaAuthed}(应=1) status=${proxyRemoteAuthed.status}`);

    // ── checkAuth:等长异字节也必须 401(恒定时间比较的前置语义),且实现须用 crypto.timingSafeEqual ──
    const sameLenBad = R64_TOKEN.substring(0, R64_TOKEN.length - 1) + 'X';
    const aWrong = await reqTo('127.0.0.1', R64_LAN_PORT, 'GET', '/api/tools', null, { authorization: 'Bearer ' + R64_TOKEN + 'zzz' });
    const aSameLen = await reqTo('127.0.0.1', R64_LAN_PORT, 'GET', '/api/tools', null, { authorization: 'Bearer ' + sameLenBad });
    const aRight = await reqTo('127.0.0.1', R64_LAN_PORT, 'GET', '/api/tools', null, { authorization: 'Bearer ' + R64_TOKEN });
    check('#64a5 红:checkAuth 语义不变(错 token/等长异字节 401、正确 200)且比较改为 crypto.timingSafeEqual 恒定时间',
      aWrong.status === 401 && aSameLen.status === 401 && aRight.status === 200 && /timingSafeEqual/.test(srcNow),
      `长度不同=${aWrong.status} 等长异字节=${aSameLen.status} 正确=${aRight.status} 源码含timingSafeEqual=${/timingSafeEqual/.test(srcNow)}`);

    // ── 反向自证第二面:收紧不得把"外部监控存活探针"一起打死(#68 已裁定 health 在鉴权门之前、免凭据) ──
    //   若实现把对端判定整体上移到请求入口(最省事的写法),这条会当堂打红。
    const healthRemote = await reqTo(lanIp, R64_LAN_PORT, 'GET', '/api/health', null, null);
    check('#64a6 反向自证(收紧不得越界):非回环无凭据取 /api/health 仍须 200 且 status=ok(#68 的裁定面)',
      healthRemote.status === 200 && healthRemote.body?.status === 'ok',
      `status=${healthRemote.status} body=${JSON.stringify(healthRemote.body || {}).substring(0, 160)}`);

    // ── 红(#64 第一轮规格的漏洞,编码手 PROPOSALS#3 报回):未配置凭据时"回环 或 已鉴权"退化成全放行 ──
    //   checkAuth 在 AI_BRIDGE_TOKEN 未设时恒 true(自用零负担),于是非回环对端"不出示任何东西"也算通过该支路;
    //   若同时把 AI_BRIDGE_HOST 设成 0.0.0.0,/proxy/ 对局域网依旧是免费中继。收紧口径=非回环必须出示**已配置的**凭据。
    const bare = await bootHub(R64_BARE_PORT, {}, 'bare-hub');
    const bareUpPort = R64_UP_PORT;
    const regBare = await reqTo('127.0.0.1', R64_BARE_PORT, 'POST', '/api/observe/route',
      { source: 'r64bare', key: 'r64key', upstream: `http://127.0.0.1:${bareUpPort}` }, null);
    const hitBeforeBare = upHits;
    const proxyNoTokenHub = await reqTo(lanIp, R64_BARE_PORT, 'POST', '/proxy/r64bare/r64key/v1/chat/completions', { model: 'm', messages: [] }, null);
    check('#64a8 红:未配置 AI_BRIDGE_TOKEN 的中枢被非回环对端借道 /proxy/ 仍须拒(现状=checkAuth 恒真使"回环或已鉴权"退化为全放行)',
      regBare.status === 200 && upHits - hitBeforeBare === 0 && (proxyNoTokenHub.status === 401 || proxyNoTokenHub.status === 403),
      `登记路由=${regBare.status} 上游增量=${upHits - hitBeforeBare}(应=0) status=${proxyNoTokenHub.status} 对端=${lanIp}`);
    // 反向自证:同一个未配凭据的中枢,回环对端仍必须可用(自用实例零负担,收紧不得把自己人也打掉)
    const hitBeforeBareLocal = upHits;
    const proxyNoTokenLocal = await reqTo('127.0.0.1', R64_BARE_PORT, 'POST', '/proxy/r64bare/r64key/v1/chat/completions', { model: 'm', messages: [] }, null);
    check('#64a8b 反向自证:未配凭据中枢的回环 /proxy/ 仍可透传(上游 +1、200),自用零负担语义不回退',
      upHits - hitBeforeBareLocal === 1 && proxyNoTokenLocal.status === 200,
      `增量=${upHits - hitBeforeBareLocal}(应=1) status=${proxyNoTokenLocal.status}`);
    try { bare.proc.kill(); } catch { /* 已退出 */ }

    await (async () => { try { lan.proc.kill(); } catch { /* 已退出 */ } } )();

    // ── 结构锁:对端判定必须收敛为单一写手 ──
    //   手写第二处 remoteAddress 比较是本类缺陷复发的主路径(漏 ::1 / ::ffff:127.0.0.1 就是漏判),
    //   且 /proxy/ 与 Web UI 两条路必须共用同一把尺,否则下一条新路由又会各写一遍。
    const rawPeerReads = (srcNow.match(/socket\.remoteAddress/g) || []).length;
    const guardUses = (srcNow.match(/isLoopbackPeer/g) || []).length;
    const proxyBody = srcNow.slice(srcNow.indexOf('async function handleProxy'));
    const proxySlice = proxyBody.slice(0, proxyBody.indexOf('\n}'));
    const uiBranch = srcNow.slice(srcNow.indexOf("if (p === '/' && req.method === 'GET')"));
    const uiSlice = uiBranch.slice(0, uiBranch.indexOf('\n    }'));
    check('#64a7 结构锁:全文只许一处 socket.remoteAddress 读点,且 /proxy/ 与 UI 两条路都走 isLoopbackPeer(现状 0 处判定)',
      rawPeerReads === 1 && guardUses >= 3 && /isLoopbackPeer/.test(proxySlice) && /isLoopbackPeer/.test(uiSlice),
      `socket.remoteAddress 读点=${rawPeerReads}(应=1) isLoopbackPeer 出现=${guardUses}(应>=3) proxy 引用=${/isLoopbackPeer/.test(proxySlice)} UI 引用=${/isLoopbackPeer/.test(uiSlice)}`);
  } catch (e) {
    check('#64 本格 harness 可用(拿不到非回环对端/起不来中枢都必须显式红,不得静默绿)', false, e.message);
  } finally {
    // extraProcs 里既有子进程(spawn)也有本进程内的 http.Server,两者关闭方式不同,混用 .kill() 会静默抛错漏关
    for (const p of extraProcs) { try { if (typeof p.kill === 'function') p.kill(); else p.close(); } catch { /* 已退出 */ } }
    extraProcs.length = 0;
    try { upSrv.close(); } catch { /* 已关闭 */ }
  }

  // ── 静态接线检查 ──
  section('静态接线:server.js / README');
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf-8');
  check('S-1 路由读取 body.fallback_scope 并透传', /body\.fallback_scope/.test(src));
  check('S-2 错误码枚举齐全(invalid_request/workspace_error/workspace_busy/no_targets/too_many)', ['invalid_request', 'workspace_error', 'workspace_busy', 'no_targets', 'too_many'].every(c => src.includes(`'${c}'`)));
  check('S-3 chat 工具分支流量记录 type=openai-tool', /openai-tool/.test(src));
  const readme = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf-8');
  check('S-4 README 写明 Node.js 22+ 硬依赖', /Node(\.js)? 22/.test(readme));
  check('S-5 README 含 opencode 免费模型接入指引', /opencode/i.test(readme) && /(免费|free)/i.test(readme));
  const tjson = JSON.parse(fs.readFileSync(path.join(__dirname, 'tools.json'), 'utf-8'));
  const opencodeish = tjson.filter(t => String(t.name).startsWith('opencode'));
  check('S-6 tools.json 四个 opencode 工具声明 modelFlag=-m 与 modelListCmd', opencodeish.length === 4 && opencodeish.every(t => t.modelFlag === '-m' && t.modelListCmd && t.modelListCmd.command === 'opencode' && Array.isArray(t.modelListCmd.args)), opencodeish.map(t => t.name + ':' + JSON.stringify(t.modelFlag || null)).join(','));
  check('S-7 server.js 接线 model_override 与 discover-models', /model_override/.test(src) && /discover-models/.test(src));
  const adapterSrc = fs.readFileSync(path.join(__dirname, 'adapters', 'cli-adapter.js'), 'utf-8');
  check('S-8 cli-adapter 接线 modelFlag 且校验拒绝文案含"不合法"', /modelFlag/.test(adapterSrc) && /不合法/.test(adapterSrc));
  check('S-9 server.js 接线 usage-reporter(require+CLI 门控+reported 合并)', /usage-reporter/.test(src) && /reported/.test(src));
  check('S-10 README 含模型透传与用量自报说明', /model_override/.test(readme) && /\[USAGE\]/.test(readme));

  process.stdout.write('\n' + '='.repeat(40) + '\n');
  process.stdout.write(`结果: ${passed} 通过 / ${failed} 失败\n`);
  if (failed) { process.stdout.write('失败项: ' + failures.join('; ') + '\n'); if (serverErr) process.stdout.write('server stderr 尾部:\n' + serverErr.slice(-2000) + '\n'); }
}

main().catch(e => {
  process.stderr.write('测试框架异常: ' + e.stack + '\n');
  process.exitCode = 1;
}).finally(async () => {
  for (const p of [probeProc, otherProc, serverProc]) { try { p && p.kill(); } catch { /* ignore */ } }
  // 收尾:先等子进程释放文件句柄再删临时目录——Windows 上 node:sqlite 的 .db 仍被占用时 rmSync 会失败,
  // 留下 test-runtime-data-ext/ 污染工作区(实测:中断的运行会让孤儿 hub 长期占端口)
  await new Promise(r => setTimeout(r, 800));
  try { fs.rmSync(TEST_RUNTIME, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
});
