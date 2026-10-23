#!/usr/bin/env node
'use strict';

/**
 * AI Bridge 全链路 E2E 测试(整合自 10 个已弃用的遗留测试)
 *
 * 覆盖真正的生产路径:server.js 共享中枢 + bridge-stdio 客户端 + 反向调用(sampling)往返。
 * 取代旧的 spawn mcp-server.js 单进程测试(mcp-server.js 已弃用/移除)。
 *
 * 运行隔离:独立端口、JSON 数据目录、SQLite 和观测目录，测试期间不改写生产状态。
 *
 * 运行:node test-e2e.mjs
 * 退出码:0 全通过 / 1 有失败
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const PORT = 9810;
const HOST = '127.0.0.1';
const CLIENT = 'e2e-probe';
const STALE_CLIENT = 'e2e-stale-probe';
const REVIEWER = 'e2e-reviewer';
const CONFLICT_CLIENT = 'openclaw';
const CONFLICT_CLIENT_ID = 'client-openclaw';
const TEST_RUNTIME = path.join(__dirname, 'test-runtime-data'); // JSON 运行态隔离:开关/统计/记忆/日志/ACL
const TEST_DB = path.join(TEST_RUNTIME, 'test-bridge.db'); // 全局库隔离:测试专用库,测后随目录删除
const TEST_OBSERVE = path.join(TEST_RUNTIME, 'observe'); // 观测层隔离:路由/接管状态专用目录
function testDataPath (name) { return path.join(TEST_RUNTIME, name); }

// ── 断言框架 ──
let passed = 0;
let failed = 0;
const failures = [];
function check (name, cond, detail) {
  if (cond) { passed++; process.stdout.write(`  ✅ ${name}\n`); }
  else { failed++; failures.push(name); process.stdout.write(`  ❌ ${name}${detail ? ' — ' + detail : ''}\n`); }
}
function section (title) { process.stdout.write(`\n── ${title} ──\n`); }

// ── HTTP 客户端(直连中枢) ──
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── MCP stdio 双向通道(既发请求给桥接器,又应答桥接器的反向调用) ──
let lastSamplingTask = '';
function makeMcpChannel (child) {
  let buf = '';
  const pending = new Map();
  let idc = 0;
  child.stdout.on('data', d => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      // 反向调用:桥接器请求宿主(本测试)生成内容
      if (msg.method === 'sampling/createMessage' && msg.id !== undefined) {
        lastSamplingTask = msg.params?.messages?.[0]?.content || '';
        // 含 LONGOUT_MARK 标记时返回超长文本,用于验证 RESULT_MAX_CHARS 截断
        // 含 EMPTYOUT_MARK 标记时返回空文本,模拟 CLI exit0/无输出的静默失败(如额度耗尽)
        // 含 REPORT_MARK 标记时返回"谈论失败的长文"(无代码块),验证关键词判定不再误伤审计类交付物
        // 含 ERRORTEXT_MARK 标记时返回短错误行(无代码块),真实额度/限流失败必须仍被判定失败
        // 仅"以标记开头"时空产出:接力 prompt 会内嵌原任务文本,避免标记传播到接力工具
        // 评审 prompt(含"你是代码评审专家")带 REVIEW_EMPTY_MARK 时同样回空文本,验证评审空产出判失败
        const reportText = '审计报告(长文本,无代码块)。' + 'S1 鉴权只挡 /api/*,本机进程可零凭据经 /v1 触发工具执行并烧配额;S2 设 token 后 UI 全线 401;S3 闸门在崩溃遗留 3 个孤儿时永久 429;S4 双锁互不感知;S5 用量报表口径分叉,今日 tokens=0;S6 写被拒仍报 200 success:true;S7 先删文件后落盘;S8 形状错误的 JSON 仍被覆写。'.repeat(7) + '结论:以上均为静态阅读所得,置信度高。';
        const text = (lastSamplingTask.trimStart().startsWith('EMPTYOUT_MARK')
          || (lastSamplingTask.includes('你是代码评审专家') && lastSamplingTask.includes('REVIEW_EMPTY_MARK')))
          ? ''
          : lastSamplingTask.includes('REPORT_MARK')
            ? reportText
            : lastSamplingTask.includes('ERRORTEXT_MARK')
              ? 'Error: Go usage limit exceeded (429 Too Many Requests)'
              : lastSamplingTask.includes('LONGOUT_MARK')
                ? 'L'.repeat(5000)
                : '```python\ndef add(a, b):\n    return a + b\n```';
        const result = {
          content: { type: 'text', text },
          usage: { inputTokens: 12, outputTokens: 34 }
        };
        const reply = () => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
        if (lastSamplingTask.includes('BUSY_STATE_MARK')) setTimeout(reply, 500);
        else reply();
        continue;
      }
      // 桥接器对本测试请求的应答
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  return {
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

async function waitServerReady (timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // 就绪探针只验证 HTTP 主循环；/api/tools 会执行 CLI 可用性探测，不能作为启动判据。
    try {
      const r = await req('GET', '/api/health');
      if (r.status === 200 && r.body.status === 'ok') return true;
    } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error('server 启动超时');
}

async function waitClientConnected (name, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await req('GET', '/api/clients');
      if ((r.body.clients || []).some(c => c.id === name && c.online === true)) return true;
    } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error('客户端连接超时: ' + name);
}

async function waitClientDisconnected (name, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await req('GET', '/api/clients');
      const client = (r.body.clients || []).find(c => c.id === name);
      if (!client || client.state === 'approved_offline') return true;
    } catch { /* retry */ }
    await sleep(100);
  }
  return false;
}

// 轮询会议直到进入终态(closed/interrupted),返回最终状态体;超时抛错
async function pollMeetingClosed (id, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await req('GET', '/api/discuss/status/' + id);
    if (r.status === 200 && (r.body.status === 'closed' || r.body.status === 'interrupted')) return r.body;
    await sleep(200);
  }
  throw new Error('会议未在预期时间内结束: ' + id);
}

// ── 主流程 ──
let serverProc = null;
let bridgeProc = null;
let reviewerProc = null;
let conflictProc = null;
let serverErr = '';

async function main () {
  process.stdout.write('AI Bridge 全链路 E2E 测试\n');
  process.stdout.write('='.repeat(40) + '\n');

  // 清理上次遗留的测试运行目录并建立全新隔离状态。
  fs.rmSync(TEST_RUNTIME, { recursive: true, force: true });
  fs.mkdirSync(TEST_RUNTIME, { recursive: true });
  // 种子 ACL:预批准 e2e 客户端；另含与内置 CLI 同名的 openclaw，验证 client- 前缀 ID 回传链路
  fs.writeFileSync(testDataPath('clients-acl.json'),
    JSON.stringify({ allowlist: [CLIENT, STALE_CLIENT, REVIEWER, CONFLICT_CLIENT, CONFLICT_CLIENT_ID, 'e2e-seq-probe', 'e2e-race-probe'], blocklist: [], pending: [] }, null, 2));
  // 种子 memory:4 个遗留会议(3 个非终态=中枢崩溃留下的孤儿, 1 个已关闭=对照不得被改动)。
  // 用于 #39 启动清扫断言——必须在中枢启动前落盘,因为清扫只发生在启动序列里。
  fs.writeFileSync(testDataPath('memory.json'), JSON.stringify({
    tasks: [], experiences: [], preferences: {},
    meetings: [
      { id: 'orphan-1', status: 'discussing', topic: '崩溃遗留1', participants: [], messages: [], round: 1, interrupted: false },
      { id: 'orphan-2', status: 'active', topic: '崩溃遗留2', participants: [], messages: [], round: 1, interrupted: false },
      { id: 'orphan-3', status: 'implementing', topic: '崩溃遗留3', participants: [], messages: [], round: 2, interrupted: false },
      { id: 'done-1', status: 'closed', topic: '正常结束', participants: [], messages: [], summary: '既有结论', closedAt: '2026-01-01T00:00:00.000Z' }
    ]
  }, null, 2));

  // 1) 启动中枢(JSON/SQLite/观测数据全部指向测试专用目录)
  serverProc = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, AI_BRIDGE_PORT: String(PORT), AI_BRIDGE_HOST: HOST, AI_BRIDGE_DATA_DIR: TEST_RUNTIME, AI_BRIDGE_DB: TEST_DB, AI_BRIDGE_OBSERVE_DIR: TEST_OBSERVE, AI_BRIDGE_WORKSPACE_ROOT: path.join(TEST_RUNTIME, 'workspaces'), AI_BRIDGE_CLIENT_TTL: '1200', AI_BRIDGE_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProc.stderr.on('data', d => { serverErr += d.toString(); });
  await waitServerReady();
  process.stdout.write('中枢已就绪 (127.0.0.1:' + PORT + ')\n');

  // 1.5) 启动清扫:崩溃遗留的非终态会议必须被标记中断(#39 指定红集)
  //   根因:并发闸门(server.js:2184)按 memory.json 里 discussing/active/implementing 计数,
  //   上限 MAX_CONCURRENT_MEETINGS=3(server.js:52);中枢崩溃于讨论中途时这些状态永久残留,
  //   而启动序列只对 async_tasks 做孤儿标记(db.js:171-175, 调用点 server.js:2678),会议侧无对应清扫
  //   → 累积 3 个孤儿即让 /api/discuss 永久 429,讨论功能整体死锁且难以归因。
  //   判别式(零配额消耗):合法 topic + 不存在的参与者 → 闸门在参数校验之前,
  //   所以修复前必回 429、修复后必回 400(闸门放行后因无可用工具而 400)。
  section('启动清扫:崩溃遗留会议(#39 红集)');
  const bootActive = await req('GET', '/api/discuss/active');
  check('#39a 启动后无遗留非终态会议(active 计数为 0)', bootActive.status === 200 && bootActive.body.count === 0, JSON.stringify(bootActive.body).substring(0, 200));
  const bootMeetings = await req('GET', '/api/meetings?limit=20');
  const bm = (bootMeetings.body.meetings || []).reduce((a, m) => { a[m.id] = m; return a; }, {});
  check('#39b 三个遗留会议被清扫为 interrupted 且带原因',
    ['orphan-1', 'orphan-2', 'orphan-3'].every(id => bm[id] && bm[id].status === 'interrupted' && bm[id].interrupted === true && /重启|中断/.test(bm[id].interruptReason || '')),
    JSON.stringify(['orphan-1', 'orphan-2', 'orphan-3'].map(id => bm[id] && { s: bm[id].status, i: bm[id].interrupted, r: bm[id].interruptReason })));
  check('#39c 已关闭会议不得被清扫改动(状态/结论/时间戳原样)', bm['done-1'] && bm['done-1'].status === 'closed' && bm['done-1'].summary === '既有结论' && bm['done-1'].closedAt === '2026-01-01T00:00:00.000Z', JSON.stringify(bm['done-1'] || null).substring(0, 200));
  const gatePass = await req('POST', '/api/discuss', { topic: '清扫后应可通过闸门', participants: ['ghost-tool-not-exist'] });
  check('#39d 清扫后闸门放行(合法 topic+不存在参与者 → 400 而非 429)', gatePass.status === 400 && /没有可用的参与工具/.test(gatePass.body.error || ''), 'status=' + gatePass.status + ' ' + JSON.stringify(gatePass.body).substring(0, 160));
  const memAfterSweep = JSON.parse(fs.readFileSync(testDataPath('memory.json'), 'utf-8'));
  const orphanAfter = (memAfterSweep.meetings || []).find(m => m.id === 'orphan-1') || {};
  check('#39e 清扫结果已落盘(不是只在内存里改)', orphanAfter.status === 'interrupted', JSON.stringify(orphanAfter).substring(0, 180));

  // 1.6) 第二实例真启动探针(#52 指定红集):预置"合法 JSON 但形状错"的 memory.json
  //   (meetings 为对象)后启动一个独立中枢进程。现状(修复前):markOrphanMeetings 在顶层启动序列
  //   抛 TypeError 且调用点无 try(server.js:2694)→ 进程起不来 → watchdog 会重启至熔断=整体不可用。
  //   要求:坏形状数据只能让功能降级,绝不能阻止进程启动。
  section('坏形状数据不得阻止中枢启动:#52 红集(第二实例)');
  const BOOT_PORT = 9821;
  const bootDir = path.join(TEST_RUNTIME, 'boot-probe');
  const bootMem = { tasks: [], experiences: [], preferences: {}, meetings: { bad: { status: 'discussing' } } };
  fs.mkdirSync(bootDir, { recursive: true });
  fs.writeFileSync(path.join(bootDir, 'memory.json'), JSON.stringify(bootMem), 'utf-8');
  const bootProc = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, AI_BRIDGE_PORT: String(BOOT_PORT), AI_BRIDGE_HOST: HOST, AI_BRIDGE_DATA_DIR: bootDir, AI_BRIDGE_DB: path.join(bootDir, 'probe.db'), AI_BRIDGE_OBSERVE_DIR: path.join(bootDir, 'observe'), AI_BRIDGE_WORKSPACE_ROOT: path.join(bootDir, 'ws'), AI_BRIDGE_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let bootOut = '';
  bootProc.stderr.on('data', d => { bootOut += d.toString(); });
  bootProc.stdout.on('data', d => { bootOut += d.toString(); });
  await sleep(2000);
  let bootHealth = null;
  try {
    bootHealth = await new Promise((resolve, reject) => {
      const r = http.request({ hostname: HOST, port: BOOT_PORT, path: '/api/health', method: 'GET', timeout: 4000 }, res => {
        let s = ''; res.on('data', c => s += c); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve({ raw: s.substring(0, 80) }); } });
      });
      r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('health timeout')); }); r.end();
    });
  } catch (e) { bootHealth = { err: e.message }; }
  check('#52b1 预置畸形 memory.json 后中枢仍能启动并响应 /api/health', bootHealth && bootHealth.status === 'ok', JSON.stringify(bootHealth).substring(0, 120) + ' | stderr=' + bootOut.substring(0, 160));
  check('#52b2 启动进程未崩溃(仍在运行)', bootProc.exitCode === null, 'exitCode=' + bootProc.exitCode);
  try { bootProc.kill(); } catch { /* ignore */ }
  await sleep(400);

  // 1.7) 注册表配置文件路径接缝(#80 指定红集;它是 #40 唯一"真链路且零网络"的验收前提)
  //   实况:tool-registry.js:98 `configPath = path.join(__dirname, 'tools.json')` 硬编码,
  //   测试不能在不触碰生产 tools.json 的前提下把一个本地假 CLI 塞进**真派发链路**
  //   (CliAdapter 单测只能证明适配器,证明不了 executeTool 里的出站文本组装)。
  //   于是 #40 这类"CLI 侧拿不拿得到工作区简报"的缺陷只剩源码结构锁可依赖(弱),
  //   #79 的假上游接缝同样卡在这类"路径不可注入"上。
  //   要求:AI_BRIDGE_TOOLS_PATH 存在时按该文件装载;**未设时行为逐字节不变**(生产中性)。
  section('注册表路径接缝缺失:#80 红集(第二实例)');
  const TOOLS_PORT_DEF = 9833;
  const TOOLS_PORT_PROBE = 9834;
  const toolsDir = path.join(TEST_RUNTIME, 'tools-probe');
  const probeToolsPath = path.join(toolsDir, 'probe-tools.json');
  fs.mkdirSync(toolsDir, { recursive: true });
  // 探针 CLI 把收到的任务文本如实回吐成一行可判读的标记(纯本地 node -e,零网络零配额)
  const probeScript = "let s='';process.stdin.on('data',d=>{s+=d});process.stdin.on('end',()=>{"
    + "const m=s.match(/## 工作区目录\\r?\\n([^\\r\\n]*)/);"
    + "console.log('PROBE|len='+s.length+'|brief='+(s.indexOf('## 工作区目录')>=0)"
    + "+'|suffix='+(s.indexOf('[USAGE]')>=0)+'|wsline='+(m?m[1]:'none')+'|cwd='+process.cwd())})";
  fs.writeFileSync(probeToolsPath, JSON.stringify([{
    name: 'probe-cli',
    displayName: 'Probe CLI',
    description: '#80 零网络探针 CLI(把收到的任务文本回吐成标记)',
    transport: 'cli',
    command: process.execPath,
    // 我(指挥官)基线里的缺陷:只给了 command=绝对路径,漏了绝对路径的**既有登记通道** commandPaths。
    //   实测:CliAdapter.detect()(adapters/cli-adapter.js:51-60)先查 commandPaths 再 findInPath(command),
    //   而 Windows `where <绝对路径>` 恒退出码 2(把 C: 当盘符模式),于是可用位=false →
    //   server.js:787 的 availableTools 过滤把它挡在派发之外(execute() 本身却是好的)。
    //   该不对称是真缺陷,单列 #81 走自己的红基线;本探针不靠它,改用设计内的 commandPaths。
    commandPaths: [process.execPath],
    args: ['-e', probeScript],
    inputMode: 'stdin',
    outputMode: 'stdout-text',
    timeout: 20000
  }], null, 2), 'utf-8');

  const jreq = (port, method, urlPath, body) => new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {};
    const r = http.request({ hostname: HOST, port, path: urlPath, method, timeout: 15000, headers }, res => {
      let s = ''; res.on('data', c => s += c); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) { j = { raw: s.substring(0, 120) }; } resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', e => resolve({ status: 0, body: { err: e.message } }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: { err: 'timeout' } }); });
    if (data) r.write(data);
    r.end();
  });

  const spawnProbeHub = (port, extraEnv, dirName) => {
    const dir = path.join(toolsDir, dirName);
    fs.mkdirSync(dir, { recursive: true });
    const proc = spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: {
        ...process.env, AI_BRIDGE_PORT: String(port), AI_BRIDGE_HOST: HOST,
        AI_BRIDGE_DATA_DIR: dir, AI_BRIDGE_DB: path.join(dir, 'probe.db'),
        AI_BRIDGE_OBSERVE_DIR: path.join(dir, 'observe'),
        AI_BRIDGE_WORKSPACE_ROOT: path.join(dir, 'ws'), AI_BRIDGE_TOKEN: '',
        ...extraEnv
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    proc.stderr.on('data', () => {}); proc.stdout.on('data', () => {});
    return proc;
  };

  // ① 默认(未设 env):注册表必须仍读仓库内 tools.json —— 生产中性哨兵,现在就该绿,修完也必须绿
  const defProc = spawnProbeHub(TOOLS_PORT_DEF, {}, 'default');
  await sleep(2200);
  const defTools = await jreq(TOOLS_PORT_DEF, 'GET', '/api/tools');
  const defNames = (defTools.body.tools || []).map(t => t.name || t.id);
  check('#80a1 哨兵:未设 AI_BRIDGE_TOOLS_PATH 时注册表照旧读到仓库内 tools.json(生产中性,须全程为绿)',
    defTools.status === 200 && defNames.includes('openclaw'), 'count=' + defNames.length + ' names=' + defNames.slice(0, 6).join(','));
  try { defProc.kill(); } catch { /* ignore */ }
  await sleep(400);

  // ② 设 env:注册表必须改读隔离文件(现状:env 被无视 → 仍是生产 12 工具)
  const probeProc = spawnProbeHub(TOOLS_PORT_PROBE, { AI_BRIDGE_TOOLS_PATH: probeToolsPath }, 'probe');
  await sleep(2200);
  const probeTools = await jreq(TOOLS_PORT_PROBE, 'GET', '/api/tools');
  const probeNames = (probeTools.body.tools || []).map(t => t.name || t.id);
  check('#80a2 设 AI_BRIDGE_TOOLS_PATH 后注册表必须按该文件装载(现状:env 无效,静态工具仍来自仓库 tools.json)',
    probeNames.includes('probe-cli') && !probeNames.includes('openclaw'), 'names=' + probeNames.slice(0, 8).join(','));
  check('#80a3 载入诊断必须如实报出实际使用的文件名(现状:恒报 tools.json,派发失败时无法归因到配置源)',
    /probe-tools\.json/.test(JSON.stringify(probeTools.body)), JSON.stringify(probeTools.body.registry || probeTools.body.diag || probeTools.body.stats || '').substring(0, 160));

  // ③ 真链路:点名派发探针 CLI 并绑定工作区(现状因 #80a2 未满足而必然失败)
  const pWs = await jreq(TOOLS_PORT_PROBE, 'POST', '/api/workspaces', { name: 'probe-ws', description: '#80 探针工作区' });
  const pDispatch = await jreq(TOOLS_PORT_PROBE, 'POST', '/api/dispatch', { task: '说一句你好', tools: ['probe-cli'], workspace: 'probe-ws', auto_fallback: false });
  const pOut = String((pDispatch.body.results || [])[0]?.content || '');
  check('#80a4 哨兵:探针 CLI 必须真能被点名派发并执行(零网络;此绿是 #40 端到端验收的前提)',
    pWs.status === 201 && (pDispatch.body.successCount || 0) === 1 && /PROBE\|len=/.test(pOut),
    'ws=' + pWs.status + ' successCount=' + pDispatch.body.successCount + ' out=' + pOut.substring(0, 90) + ' err=' + JSON.stringify((pDispatch.body.results || [])[0]?.error || '').substring(0, 60));
  try { probeProc.kill(); } catch { /* ignore */ }
  await sleep(400);

  // 1.75) CLI 到底收到什么任务文本(#40 指定红集;靠 #80 接缝才可能端到端验)
  //   实况 server.js:571-573:
  //     const outboundTask = toolDef.type === 'client'
  //       ? (opts.workspace ? withWorkspaceBrief(task, opts.workspace.path) : task)
  //       : ((toolDef.type === 'client' && opts.workspace) ? withWorkspaceBrief(...) : task) + USAGE_REPORT_SUFFIX;
  //   else 分支只在 type!=='client' 时走到,其内部却又判 toolDef.type === 'client' —— **恒假**,
  //   于是 CLI 永远只拿到用量后缀,拿不到目录简报(而简报是"只在该目录内动文件"的唯一文字护栏;
  //   cli-adapter 虽给了 cwd,但简报缺失对越界读写没有任何显式劝阻,且文档/注释都当它存在)。
  //   验收面:探针 CLI 把自己**逐字节收到的 stdin** 以 base64 回吐 → 可断言"进程实收 == 台账所记 == 应有形状"。
  section('CLI 拿不到工作区简报:#40 红集(第二实例)');
  const P40_PORT = 9835;
  const p40Dir = path.join(toolsDir, 'brief');
  fs.mkdirSync(p40Dir, { recursive: true });
  const p40ToolsPath = path.join(p40Dir, 'brief-tools.json');
  const echoScript = "let s='';process.stdin.on('data',d=>{s+=d});process.stdin.on('end',()=>{"
    + "console.log('ECHO|b64='+Buffer.from(s,'utf8').toString('base64')+'|cwd='+process.cwd())})";
  fs.writeFileSync(p40ToolsPath, JSON.stringify([{
    name: 'echo-cli',
    displayName: 'Echo CLI',
    description: '#40 探针:把实收 stdin 逐字节 base64 回吐',
    transport: 'cli',
    command: process.execPath,
    // 绝对路径的可用位判定走设计内通道(见 #80a4 注释与 #81)
    commandPaths: [process.execPath],
    args: ['-e', echoScript],
    inputMode: 'stdin',
    outputMode: 'stdout-text',
    timeout: 20000
  }], null, 2), 'utf-8');

  const p40Proc = spawnProbeHub(P40_PORT, { AI_BRIDGE_TOOLS_PATH: p40ToolsPath }, 'brief-hub');
  await sleep(2200);
  const p40Ws = await jreq(P40_PORT, 'POST', '/api/workspaces', { name: 'brief-ws', description: '#40 工作区' });
  const p40WsPath = (p40Ws.body && p40Ws.body.path) || '';
  const p40Dispatch = await jreq(P40_PORT, 'POST', '/api/dispatch', { task: '只写一个 hello.txt', tools: ['echo-cli'], workspace: 'brief-ws', auto_fallback: false });
  await sleep(500);
  const p40Out = String((p40Dispatch.body.results || [])[0]?.content || '');
  const b64 = (p40Out.match(/b64=([A-Za-z0-9+/=]*)/) || [])[1] || '';
  const received = b64 ? Buffer.from(b64, 'base64').toString('utf8') : '';
  // 台账里的 tool 字段是工具 id(实测 `cli:echo-cli`),不是名字——用名字查会得到空结果(工装错而非缺陷)
  const p40Trf = await jreq(P40_PORT, 'GET', '/api/traffic?tool=' + encodeURIComponent('cli:echo-cli') + '&direction=out&limit=10');
  const logged = (p40Trf.body.traffic || []).map(t => t.content).filter(c => typeof c === 'string').pop() || '';

  check('#40e1 前置:探针必须真跑到并回吐实收文本(此绿是下面各条的证据基础)',
    p40Ws.status === 201 && (p40Dispatch.body.successCount || 0) === 1 && received.length > 0,
    'ws=' + p40Ws.status + ' successCount=' + p40Dispatch.body.successCount + ' recvLen=' + received.length + ' out=' + p40Out.substring(0, 60));
  check('#40e2 红:CLI 绑定工作区时,子进程实收任务文本必须含目录简报段,且简报路径就是该工作区绝对路径(现状:恒假分支让 CLI 永远收不到)',
    received.includes('## 工作区目录') && received.includes(p40WsPath),
    'wsPath=' + p40WsPath + ' recv=' + JSON.stringify(received.substring(0, 120)));
  check('#40e3 红:同一次派发必须同时带 [USAGE] 自报后缀——简报与后缀不得互吞(现状:只有后缀)',
    /\[USAGE\]/.test(received) && received.includes('## 工作区目录'),
    'hasUsage=' + /\[USAGE\]/.test(received) + ' hasBrief=' + received.includes('## 工作区目录'));
  const firstDiff = (a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return i;
    return Math.min(a.length, b.length);
  };
  check('#40e4 哨兵(单一写手):台账 out 记录必须与子进程实收文本逐字节相等——修任何一侧都必须同步另一侧',
    logged.length > 0 && logged === received,
    'loggedLen=' + logged.length + ' recvLen=' + received.length + ' 首处差异@' + firstDiff(logged, received));
  const p40NoWs = await jreq(P40_PORT, 'POST', '/api/dispatch', { task: '不用工作区打个招呼', tools: ['echo-cli'], auto_fallback: false });
  await sleep(400);
  const out2 = String((p40NoWs.body.results || [])[0]?.content || '');
  const recv2 = Buffer.from((out2.match(/b64=([A-Za-z0-9+/=]*)/) || ['', ''])[1], 'base64').toString('utf8');
  check('#40e5 哨兵(防半修):CLI 不带 workspace 时不得出现简报段,但 [USAGE] 后缀必须照旧',
    recv2.length > 0 && !recv2.includes('## 工作区目录') && /\[USAGE\]/.test(recv2),
    'recv2=' + JSON.stringify(recv2.substring(0, 120)));
  const srvSrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf-8').replace(/\r/g, '');
  const ternaryBlock = (srvSrc.match(/const outboundTask[\s\S]{0,600}?;/) || [''])[0];
  check('#40e6 结构兜底锁:outboundTask 的 else(CLI)分支内不得再出现 type===\'client\' 判据(恒假条件的机械指纹;主证是 e2/e3)',
    ternaryBlock.length > 0 && !/:\s*\(\(\s*toolDef\.type === 'client'/.test(ternaryBlock),
    '片段=' + JSON.stringify(ternaryBlock.substring(0, 180)));
  try { p40Proc.kill(); } catch { /* ignore */ }
  await sleep(400);

  // 1.8) 取走任务后不回结果,超时必须让任务态归位(#59 指定红集)
  //   实况:poll 取任务时置 taskPending=true(server.js:1709 立即支 / :1735 长轮询 interval 支),
  //   而 executeClient 的超时清理(:672-679)只清 pendingTask/pendingResolve/pendingReject/_busy,
  //   **独漏 taskPending**;clientState(:449) 又以 info.taskPending 作 online_busy 判据
  //   → 客户端取走任务却始终没回结果时,状态位永久停在 online_busy(路由与 UI 双向误报;
  //   打开的长轮询还会每秒续 lastSeen,连 stale 兜底都触发不了)。
  //   做法:第二实例设 AI_BRIDGE_EXECUTE_TIMEOUT=4000 使超时确定性发生(生产窗口 900000 不可改,
  //   故本段绝不在生产验);预置白名单免人工审批;先开一条 /api/poll 长轮询——#41 之后入队不再更换
  //   条目对象身份,interval 支会在 ≤1s 内直接下发,因此能稳定断言"任务确被该客户端取走",
  //   取走后故意不提交结果,等超时触发再断言状态必须回到 online_idle。
  section('超时后任务态必须归位:#59 红集(第二实例)');
  const TP_PORT = 9827;
  const TP_CLIENT = 'e2e-taskpend';
  const tpDir = path.join(TEST_RUNTIME, 'taskpend');
  fs.mkdirSync(tpDir, { recursive: true });
  fs.writeFileSync(path.join(tpDir, 'clients-acl.json'), JSON.stringify({ allowlist: [TP_CLIENT], blocklist: [], pending: [] }, null, 2));
  const tpProc = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, AI_BRIDGE_PORT: String(TP_PORT), AI_BRIDGE_HOST: HOST, AI_BRIDGE_DATA_DIR: tpDir, AI_BRIDGE_DB: path.join(tpDir, 'tp.db'), AI_BRIDGE_OBSERVE_DIR: path.join(tpDir, 'observe'), AI_BRIDGE_WORKSPACE_ROOT: path.join(tpDir, 'ws'), AI_BRIDGE_TOKEN: '', AI_BRIDGE_EXECUTE_TIMEOUT: '4000' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  tpProc.stderr.on('data', () => {});
  tpProc.stdout.on('data', () => {});
  const req2 = (method, urlPath, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ hostname: HOST, port: TP_PORT, path: urlPath, method, timeout: 30000, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, res => {
      let s = ''; res.on('data', c => s += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(s) }); } catch (e) { resolve({ status: res.statusCode, body: s }); } });
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('req2 timeout')); });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
  const tpView = async () => {
    try { const c = await req2('GET', '/api/clients'); return ((c.body && c.body.clients) || []).find(x => x.id === TP_CLIENT) || {}; } catch { return {}; }
  };
  await sleep(1800);
  const reg2 = await req2('POST', '/api/client/register', { name: TP_CLIENT, capabilities: { sampling: true } }).catch(e => ({ err: e.message }));
  check('#59a0 第二实例内客户端获准注册(否则走不到取任务路径)', reg2 && reg2.body && reg2.body.status === 'approved', JSON.stringify(reg2).substring(0, 150));
  // 先开长轮询(取任务的正是它),等 firstPollAt 生效后再派发
  let pollTask = null;
  const pollP = req2('POST', '/api/poll', { clientId: TP_CLIENT }).then(r => { pollTask = r && r.body && r.body.task; return r; }).catch(() => {});
  let polled = false;
  for (let i = 0; i < 20 && !polled; i++) { const c0 = await tpView(); polled = !!c0.firstPollAt; if (!polled) await sleep(200); }
  const dispP = req2('POST', '/api/dispatch', { task: '#59 取走任务但永不提交结果,超时必须让状态归位', tools: [TP_CLIENT], auto_fallback: false }).catch(e => ({ err: e.message }));
  let busySeen = false;
  for (let i = 0; i < 30; i++) { const c1 = await tpView(); if (c1.state === 'online_busy') { busySeen = true; break; } await sleep(120); }
  const dres = await dispP;
  await pollP;
  await sleep(900); // 超时(4000ms)此刻必已触发
  const after = await tpView();
  check('#59a1 任务确被该客户端 poll 取走(证明走的是 taskPending 路径,而非从未领取)', pollTask != null && busySeen === true, JSON.stringify({ taskTaken: pollTask != null, busySeen }).substring(0, 160));
  check('#59a2 不回结果时 dispatch 必须按超时判失败(不得假成功)', dres && dres.body && dres.body.successCount === 0 && /超时/.test(JSON.stringify(dres.body)), JSON.stringify(dres.body || {}).substring(0, 180));
  check('#59a3 超时后客户端必须恢复 online_idle(taskPending 不得残留)', after.state === 'online_idle', JSON.stringify({ state: after.state, busy: after.busy }).substring(0, 160));
  await sleep(1200);
  const after2 = await tpView();
  check('#59a4 再等 1.2s 仍为 online_idle(防靠采样时机侥幸蒙绿)', after2.state === 'online_idle', JSON.stringify({ state: after2.state, busy: after2.busy }).substring(0, 160));
  try { tpProc.stdin.end(); tpProc.kill(); } catch { /* ignore */ }
  await sleep(400);

  // 1.7) 注册能力不得被迟到的旧注册覆盖(#50 指定红集)
  //   实况(指挥官在生产上踩到):桥启动即发 register#1(sampling=false,宿主 initialize 尚未到达),
  //   宿主声明能力后桥再发 register#2(sampling=true)。两条在途请求乱序完成时,后到的旧请求会把
  //   supportsSampling 覆写回 false → 接入的编程软件永久失去执行资格("加载中枢把外部软件当子智能体"
  //   这条主链的第一道门),且没有自愈路径。
  //   契约:注册带单调 registerSeq;seq 更小的注册不得改动能力;seq 更大者允许真实撤回(必须可升可降,
  //   否则宿主真的不再支持 sampling 时留下虚高能力);不带 registerSeq 的旧客户端维持现有语义。
  section('注册顺序契约:#50 红集');
  const seqReg = (sampling, seq) => req('POST', '/api/client/register', {
    name: 'e2e-seq-probe',
    // 中枢只接受布尔能力声明(server.js: `typeof body.capabilities?.sampling === 'boolean'`),
    // 与桥侧 `hostSupportsSampling = !!params?.capabilities?.sampling` 的归一化结果同形
    capabilities: { sampling: sampling === true },
    ...(seq === undefined ? {} : { registerSeq: seq })
  });
  const clientView = async (id) => {
    const c = await req('GET', '/api/clients');
    return (c.body.clients || []).find(x => x.id === id) || {};
  };
  await seqReg(true, 1000);
  await req('POST', '/api/poll', { clientId: 'e2e-seq-probe' }).catch(() => {});
  const s1 = await clientView('e2e-seq-probe');
  check('#50a1 新注册(sampling=true)后能力应为 true', s1.supportsSampling === true, JSON.stringify(s1).substring(0, 150));
  await seqReg(false, 500);
  const s2 = await clientView('e2e-seq-probe');
  check('#50a2 迟到的旧注册(seq 更小)不得把能力降级', s2.supportsSampling === true, JSON.stringify(s2).substring(0, 150));
  await seqReg(false, 2000);
  const s3 = await clientView('e2e-seq-probe');
  check('#50a3 更新的注册仍须能真实撤回能力(不得做成只升不降)', s3.supportsSampling === false, JSON.stringify(s3).substring(0, 150));
  const noCap = await req('POST', '/api/dispatch', { task: 'x', tools: ['e2e-seq-probe'], auto_fallback: false });
  // 修正:该分支 code=no_targets 映射 409(server.js:1118),首版我误写 400 致其数学不可达
  check('#50a4 点名派发无资格客户端时错误须点名 sampling(而非泛泛的"未知工具/可能被禁用")',
    noCap.status === 409 && noCap.body.code === 'no_targets' && /sampling|推理型/i.test(JSON.stringify(noCap.body)), JSON.stringify(noCap.body).substring(0, 220));
  await req('POST', '/api/toggle', { tool: 'client:e2e-seq-probe', enabled: false }).catch(() => {});
  await req('POST', '/api/clients/kick', { clientId: 'e2e-seq-probe', block: false }).catch(() => {});

  // 真桥乱序复现:桥一起来就立刻发 initialize(不 await),与首条注册并发在途 → 最终必须拿到执行资格
  const raceProc = spawn(process.execPath, ['bridge-stdio.js'], {
    cwd: __dirname,
    env: { ...process.env, AI_BRIDGE_PORT: String(PORT), AI_BRIDGE_HOST: HOST, AI_BRIDGE_CLIENT: 'e2e-race-probe', AI_BRIDGE_CAP_EXEC: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const raceMcp = makeMcpChannel(raceProc);
  raceMcp.request('initialize', { capabilities: { sampling: {} } });
  let raceLast = {};
  let raceOk = false;
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    raceLast = await clientView('e2e-race-probe');
    if (raceLast.supportsSampling === true && raceLast.executionEligible === true) { raceOk = true; break; }
  }
  check('#50b1 真桥并发乱序注册后仍须具备执行资格(生产踩坑复现)', raceOk, JSON.stringify(raceLast).substring(0, 150));
  try { raceProc.stdin.end(); raceProc.kill(); } catch { /* ignore */ }
  await req('POST', '/api/toggle', { tool: 'client:e2e-race-probe', enabled: false }).catch(() => {});
  await req('POST', '/api/clients/kick', { clientId: 'e2e-race-probe', block: false }).catch(() => {});

  // 2) 准入管理全流程(HTTP 直连中枢)
  section('准入控制:陌生客户端 → 待审批 → 批准 → 踢出');
  const reg = await req('POST', '/api/client/register', { name: 'e2e-stranger' });
  check('陌生客户端进入待审批(pending)', reg.body.status === 'pending', JSON.stringify(reg.body));
  const cl1 = await req('GET', '/api/clients');
  check('待审批队列包含 e2e-stranger', (cl1.body.pending || []).some(p => p.clientId === 'e2e-stranger'));
  const ap = await req('POST', '/api/clients/approve', { clientId: 'e2e-stranger' });
  check('批准成功', ap.body.status === 'approved');
  const cl2 = await req('GET', '/api/clients');
  check('批准后进入白名单', (cl2.body.allowlist || []).includes('e2e-stranger'));
  const kick = await req('POST', '/api/clients/kick', { clientId: 'e2e-stranger' });
  check('踢出成功', kick.body.success === true);
  const cl3 = await req('GET', '/api/clients');
  check('踢出后移出白名单(防自动重连)', !(cl3.body.allowlist || []).includes('e2e-stranger'));

  // 2b) 同名注册必须幂等:网络层重试不能覆盖客户端状态或制造日志风暴
  section('准入控制:同名客户端重复注册幂等');
  const firstReg = await req('POST', '/api/client/register', { name: CLIENT });
  check('首次白名单注册标记 reused=false', firstReg.body.status === 'approved' && firstReg.body.reused === false, JSON.stringify(firstReg.body));
  const beforeDup = await req('GET', '/api/clients');
  const beforeDupClient = (beforeDup.body.clients || []).find(c => c.id === CLIENT);
  const connectedAtBefore = beforeDupClient?.connectedAt;
  check('注册后未首轮 poll 时为 connecting 而非在线', beforeDupClient?.state === 'connecting' && beforeDupClient?.online === false, JSON.stringify(beforeDupClient));
  const beforePollTools = await req('GET', '/api/tools');
  check('connecting 客户端不进入可调度工具列表', !(beforePollTools.body.tools || []).some(t => t.name === CLIENT));
  check('未声明 sampling 的控制连接无执行资格', beforeDupClient?.supportsSampling === false && beforeDupClient?.executionEligible === false, JSON.stringify(beforeDupClient));
  const secondReg = await req('POST', '/api/client/register', { name: CLIENT });
  const afterDup = await req('GET', '/api/clients');
  const connectedAtAfter = (afterDup.body.clients || []).find(c => c.id === CLIENT)?.connectedAt;
  check('重复注册标记 reused=true', secondReg.body.status === 'approved' && secondReg.body.reused === true, JSON.stringify(secondReg.body));
  check('重复注册保留原连接身份', !!connectedAtBefore && connectedAtAfter === connectedAtBefore, `${connectedAtBefore} -> ${connectedAtAfter}`);
  await req('POST', '/api/client/unregister', { clientId: CLIENT });
  const approvedOffline = await req('GET', '/api/clients');
  const offlineClient = (approvedOffline.body.clients || []).find(c => c.id === CLIENT);
  check('注销后保留 ACL 并显示 approved_offline', offlineClient?.state === 'approved_offline' && offlineClient?.approved === true && offlineClient?.online === false, JSON.stringify(offlineClient));

  // 2c) stale/reconnecting：超出 TTL 后状态应过期；重复注册后须重新 poll 才恢复在线。
  section('生命周期:stale → reconnecting → online_idle');
  const staleReg = await req('POST', '/api/client/register', { name: STALE_CLIENT });
  check('stale 用例重新注册成功', staleReg.body.status === 'approved');
  await sleep(1400);
  const staleView = await req('GET', '/api/clients');
  check('超过 TTL 且未 poll 显示 stale', (staleView.body.clients || []).find(c => c.id === STALE_CLIENT)?.state === 'stale');
  const reconnectReg = await req('POST', '/api/client/register', { name: STALE_CLIENT });
  check('stale 客户端重复注册进入 reconnecting', reconnectReg.body.reused === true && reconnectReg.body.lifecycle === 'reconnecting', JSON.stringify(reconnectReg.body));
  const reconnectView = await req('GET', '/api/clients');
  check('重连注册后仍未冒充在线', (reconnectView.body.clients || []).find(c => c.id === STALE_CLIENT)?.state === 'reconnecting' && !(reconnectView.body.clients || []).find(c => c.id === STALE_CLIENT)?.online);
  req('POST', '/api/poll', { clientId: STALE_CLIENT }).catch(() => {});
  await sleep(100);
  const reconnectedView = await req('GET', '/api/clients');
  check('重连完成首轮 poll 后恢复 online_idle', (reconnectedView.body.clients || []).find(c => c.id === STALE_CLIENT)?.state === 'online_idle');
  await req('POST', '/api/client/unregister', { clientId: STALE_CLIENT });

  // 2d) 客户端名与内置 CLI 重名时，桥接器必须保存服务端分配的 client- 前缀 ID
  section('准入控制:同名 CLI 冲突客户端使用服务端分配 ID');
  conflictProc = spawn(process.execPath, ['bridge-stdio.js'], {
    cwd: __dirname,
    env: { ...process.env, AI_BRIDGE_PORT: String(PORT), AI_BRIDGE_HOST: HOST, AI_BRIDGE_CLIENT: CONFLICT_CLIENT },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const conflictMcp = makeMcpChannel(conflictProc);
  await waitClientConnected(CONFLICT_CLIENT_ID);
  await conflictMcp.request('initialize', { capabilities: { sampling: {} } });
  await sleep(1200);
  const conflictClients = await req('GET', '/api/clients');
  check('同名客户端稳定连接为 client-openclaw', (conflictClients.body.clients || []).some(c => c.id === CONFLICT_CLIENT_ID && c.state === 'online_idle'));
  check('未出现错误原名 openclaw 在线连接条目', !(conflictClients.body.clients || []).some(c => c.id === CONFLICT_CLIENT && c.online));
  const conflictTools = await req('GET', '/api/tools');
  const cliOpenClaw = (conflictTools.body.tools || []).find(t => t.name === 'openclaw');
  const clientOpenClaw = (conflictTools.body.tools || []).find(t => t.name === CONFLICT_CLIENT_ID);
  check('CLI 与客户端共享 canonicalId 但实例 ID 隔离', cliOpenClaw?.id === 'cli:openclaw' && clientOpenClaw?.id === 'client:openclaw' && cliOpenClaw?.canonicalId === clientOpenClaw?.canonicalId);
  check('工具 API 返回 sourceId/aliases/type', clientOpenClaw?.sourceId === 'openclaw' && Array.isArray(clientOpenClaw?.aliases) && clientOpenClaw?.type === 'client');
  await req('POST', '/api/toggle', { tool: 'client:openclaw', enabled: false });
  const conflictToolsOff = await req('GET', '/api/tools');
  check('稳定实例键只关闭客户端 OpenClaw', conflictToolsOff.body.tools.find(t => t.id === 'client:openclaw')?.enabled === false && conflictToolsOff.body.tools.find(t => t.id === 'cli:openclaw')?.enabled !== false);
  await req('POST', '/api/toggle', { tool: 'client-openclaw', enabled: true });
  conflictProc.stdin.end();
  const conflictDisconnected = await waitClientDisconnected(CONFLICT_CLIENT_ID);
  check('stdio 正常关闭后立即注销客户端', conflictDisconnected);
  conflictProc.kill();
  conflictProc = null;
  const kickConflict = await req('POST', '/api/clients/kick', { clientId: CONFLICT_CLIENT_ID });
  const conflictAfterKick = await req('GET', '/api/clients');
  check('同名冲突客户端离线后踢出会移除原始授权', kickConflict.body.success === true && !(conflictAfterKick.body.allowlist || []).includes(CONFLICT_CLIENT) && !(conflictAfterKick.body.allowlist || []).includes(CONFLICT_CLIENT_ID));

  // 3) 启动 bridge-stdio 客户端(白名单直接批准)
  bridgeProc = spawn(process.execPath, ['bridge-stdio.js'], {
    cwd: __dirname,
    env: { ...process.env, AI_BRIDGE_PORT: String(PORT), AI_BRIDGE_HOST: HOST, AI_BRIDGE_CLIENT: CLIENT, AI_BRIDGE_CAP_EXEC: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const mcp = makeMcpChannel(bridgeProc);
  await waitClientConnected(CLIENT);

  // 3b) 启动第二个客户端(评审者,用于交叉评审/共识引擎的活体双客户端测试)
  reviewerProc = spawn(process.execPath, ['bridge-stdio.js'], {
    cwd: __dirname,
    env: { ...process.env, AI_BRIDGE_PORT: String(PORT), AI_BRIDGE_HOST: HOST, AI_BRIDGE_CLIENT: REVIEWER },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const reviewerMcp = makeMcpChannel(reviewerProc);
  await waitClientConnected(REVIEWER);
  await reviewerMcp.request('initialize', { capabilities: { sampling: {} } });

  // 4) MCP 协议握手 + 工具清单
  section('MCP 协议:initialize + tools/list');
  const init = await mcp.request('initialize', { capabilities: { sampling: {} } });
  check('initialize 返回 sampling capability', !!init.result?.capabilities?.sampling);
  await sleep(100);
  const capabilityView = await req('GET', '/api/clients');
  const capabilityClient = (capabilityView.body.clients || []).find(c => c.id === CLIENT);
  check('宿主声明 sampling 后客户端具备执行资格', capabilityClient?.supportsSampling === true && capabilityClient?.executionEligible === true, JSON.stringify(capabilityClient));
  const tl = await mcp.request('tools/list', {});
  const names = (tl.result?.tools || []).map(t => t.name);
  // T-A 后精确名单(15):approve/deny/kick 并入 manage_client,discuss 三件套并入 discuss
  const expected = ['dispatch', 'list_tools', 'toggle_tool', 'list_switches', 'token_stats', 'handoff',
    'memory_search', 'memory_recent', 'logs', 'discuss', 'list_clients', 'manage_client',
    'list_workspaces', 'create_workspace', 'recognize_image'];
  check('tools/list 暴露全部核心工具', expected.every(n => names.includes(n)), '缺失: ' + expected.filter(n => !names.includes(n)).join(','));
  check('被并工具已消失且总数 15', names.length === 15 && !['approve_client', 'deny_client', 'kick_client', 'discuss_status', 'discuss_interrupt', 'discuss_inject'].some(n => names.includes(n)), 'names=' + names.join(','));
  const dispatchTool = (tl.result?.tools || []).find(t => t.name === 'dispatch');
  check('dispatch 工具含 context 参数', !!dispatchTool?.inputSchema?.properties?.context);
  check('dispatch 工具含 workspace 参数', !!dispatchTool?.inputSchema?.properties?.workspace);
  check('工作区 MCP 工具已暴露', !!names.includes('list_workspaces') && !!names.includes('create_workspace'));

  // 4.5) 工作区:创建 → dispatch 绑定 → 归档/恢复 → 安全回收
  section('工作区管理:创建 → dispatch 绑定 → 归档 → 回收');
  const wsRoot = path.join(TEST_RUNTIME, 'workspaces');
  const wsList0 = await req('GET', '/api/workspaces');
  check('初始工作区列表为空且根目录指向测试目录', wsList0.status === 200 && wsList0.body.workspaces.length === 0 && path.resolve(wsList0.body.stats.root) === path.resolve(wsRoot), JSON.stringify(wsList0.body.stats));

  const wsCreate = await req('POST', '/api/workspaces', { name: 'e2e-ws', description: 'e2e workspace', exclusive: true });
  check('创建受管工作区(201)', wsCreate.status === 201 && wsCreate.body.mode === 'managed', JSON.stringify(wsCreate.body));
  check('受管目录已创建且在根目录内', fs.statSync(wsCreate.body.path).isDirectory() && path.resolve(wsCreate.body.path).startsWith(path.resolve(wsRoot) + path.sep), wsCreate.body.path);
  const wsDup = await req('POST', '/api/workspaces', { name: 'E2E-WS' });
  check('重名创建返回 409', wsDup.status === 409, 'status=' + wsDup.status);

  const wsDispatch = await req('POST', '/api/dispatch', { task: '写一个 Python cube(x) 函数', tools: [CLIENT], workspace: 'e2e-ws' });
  check('dispatch 绑定工作区成功', wsDispatch.body.successCount === 1 && wsDispatch.body.workspace?.name === 'e2e-ws', JSON.stringify(wsDispatch.body.workspace));
  check('exec 型客户端任务文本已注入工作区路径', lastSamplingTask.includes('## 工作区目录') && lastSamplingTask.includes(wsCreate.body.path), lastSamplingTask.slice(0, 120));
  // #40 反向锁:出站文本收成单一写手时,最容易把 CLI 的用量后缀顺手抹到客户端上——
  //   MCP sampling 已上报真实用量,追加自报后缀会污染对话(T5 既定豁免)。锁死该形状防"归一即抹平"。
  check('#40e7 反向锁(不回退):exec 型客户端必须拿到简报但**不得**被追加 [USAGE] 自报后缀(T5 豁免)',
    lastSamplingTask.includes('## 工作区目录') && !/\[USAGE\]/.test(lastSamplingTask), JSON.stringify(lastSamplingTask.slice(-120)));
  const wsDispatchNoExec = await req('POST', '/api/dispatch', { task: 'x', tools: [REVIEWER], workspace: 'e2e-ws', auto_fallback: false });
  check('sampling-only 客户端承接 workspace 任务被显式拒绝', wsDispatchNoExec.body.successCount === 0 && /推理型/.test(JSON.stringify(wsDispatchNoExec.body.results ?? wsDispatchNoExec.body)), JSON.stringify(wsDispatchNoExec.body.results?.[0] ?? wsDispatchNoExec.body).slice(0, 200));
  // 流量保真:准入拒绝必须发生在 'out' 记录之前(未发出的注入文本不得进流量);成功派发则必须如实记录注入后载荷
  await sleep(400);
  const trfCli = await req('GET', '/api/traffic?tool=' + encodeURIComponent('client:' + CLIENT) + '&direction=out&limit=100');
  check('成功派发的工作区注入简报已如实入流量', (trfCli.body.traffic || []).some(t => (t.content || '').includes('## 工作区目录')), JSON.stringify((trfCli.body.traffic || []).map(t => (t.content || '').slice(0, 40))).slice(0, 300));
  // #40 单一写手(客户端路):出站任务文本目前在 server.js:572 与 :685 各组装一次(今天恰好等值)。
  //   把组装收成一处时,最容易只改一侧 → 台账与实发漂移(比恒假分支更阴:一切"看起来成功"却记的不是发出去的字)。
  const cliLogged = ((trfCli.body.traffic || []).slice().pop() || {}).content || '';
  check('#40e8 哨兵(单一写手·客户端路):台账 out 内容必须与 exec 型客户端实收 sampling 文本逐字节相等',
    cliLogged.length > 0 && cliLogged === lastSamplingTask,
    'loggedLen=' + cliLogged.length + ' recvLen=' + lastSamplingTask.length + ' 首处差异@' + firstDiff(cliLogged, lastSamplingTask) + ' logged=' + JSON.stringify(cliLogged.slice(-60)));
  const trfRev = await req('GET', '/api/traffic?tool=' + encodeURIComponent('client:' + REVIEWER) + '&direction=out&limit=100');
  check('被拒的 workspace 派发不产生假发出流量', !(trfRev.body.traffic || []).some(t => (t.content || '').includes('## 工作区目录')), JSON.stringify((trfRev.body.traffic || []).map(t => (t.content || '').slice(0, 40))).slice(0, 300));
  const wsAfterUse = await req('GET', '/api/workspaces');
  const usedWs = (wsAfterUse.body.workspaces || []).find(w => w.name === 'e2e-ws');
  // useCount=2:成功派发 1 次 + 被拒绝的 sampling-only 派发 1 次(租约在派发准入时即计数)
  check('工作区使用统计已更新且租约已释放', usedWs?.useCount === 2 && usedWs?.activeRuns === 0, JSON.stringify(usedWs));

  const wsArchive = await req('POST', `/api/workspaces/${encodeURIComponent(wsCreate.body.id)}/archive`);
  check('归档工作区成功', wsArchive.status === 200 && wsArchive.body.status === 'archived', JSON.stringify(wsArchive.body));
  const wsDispatchArchived = await req('POST', '/api/dispatch', { task: 'x', tools: [CLIENT], workspace: 'e2e-ws' });
  check('归档工作区拒绝 dispatch', !!wsDispatchArchived.body.error && /归档/.test(wsDispatchArchived.body.error), JSON.stringify(wsDispatchArchived.body));
  const wsRestore = await req('POST', `/api/workspaces/${encodeURIComponent(wsCreate.body.id)}/restore`);
  check('恢复工作区成功', wsRestore.status === 200 && wsRestore.body.status === 'active');

  const wsLinked = await req('POST', '/api/workspaces', { name: 'e2e-linked', path: TEST_RUNTIME });
  check('登记已有目录为 linked 工作区', wsLinked.status === 201 && wsLinked.body.mode === 'linked', JSON.stringify(wsLinked.body));
  const wsBad = await req('POST', '/api/workspaces', { name: 'e2e-bad', path: 'relative/x' });
  check('相对路径登记被拒(400)', wsBad.status === 400, 'status=' + wsBad.status);

  const wsUnlink = await req('DELETE', `/api/workspaces/${encodeURIComponent(wsLinked.body.id)}`);
  check('登记目录删除仅解绑,目录未受影响', wsUnlink.body.success === true && wsUnlink.body.filesDeleted === false && fs.existsSync(TEST_RUNTIME), JSON.stringify(wsUnlink.body));
  const wsRecycle = await req('DELETE', `/api/workspaces/${encodeURIComponent(wsCreate.body.id)}?delete_files=1`);
  check('受管工作区连同文件回收', wsRecycle.body.success === true && wsRecycle.body.filesDeleted === true && !fs.existsSync(wsCreate.body.path), JSON.stringify(wsRecycle.body));

  // 5) 皇冠用例:dispatch 反向调用往返 + 上下文注入 + token 记录
  section('dispatch 反向调用往返(中枢 → 客户端 sampling → 结果回收)');
  const disp = await req('POST', '/api/dispatch', {
    task: '写一个 Python add(a,b) 函数', tools: [CLIENT], context: '这是 e2e 上下文标记 CTXMARK'
  });
  check('dispatch 往返成功(1/1)', disp.body.successCount === 1, JSON.stringify(disp.body).slice(0, 200));
  check('dispatch 产出代码块', (disp.body.results?.[0]?.codeBlocks || []).length > 0);
  check('dispatch 结果回显稳定身份', disp.body.results?.[0]?.toolId === 'client:e2e-probe' && disp.body.results?.[0]?.canonicalId === 'e2e-probe', JSON.stringify(disp.body.results?.[0]).slice(0, 180));
  check('上下文注入:子工具收到 context 标记', lastSamplingTask.includes('CTXMARK') && lastSamplingTask.includes('## 上下文'), lastSamplingTask.slice(0, 80));
  check('dispatch 记录 token 用量', (disp.body.totalTokens || 0) > 0, 'totalTokens=' + disp.body.totalTokens);
  check('dispatch 响应含追踪 id(dispatchId)', typeof disp.body.dispatchId === 'string' && disp.body.dispatchId.startsWith('dispatch_'), 'dispatchId=' + disp.body.dispatchId);
  check('dispatch 响应含耗时(elapsedMs)', typeof disp.body.elapsedMs === 'number' && disp.body.elapsedMs >= 0, 'elapsedMs=' + disp.body.elapsedMs);
  const busyDispatch = req('POST', '/api/dispatch', { task: '检查生命周期 BUSY_STATE_MARK', tools: [CLIENT] });
  await sleep(150);
  const duringBusy = await req('GET', '/api/clients');
  check('任务执行期间客户端为 online_busy', (duringBusy.body.clients || []).find(c => c.id === CLIENT)?.state === 'online_busy', JSON.stringify((duringBusy.body.clients || []).find(c => c.id === CLIENT)));
  await busyDispatch;
  const afterBusy = await req('GET', '/api/clients');
  check('任务完成后客户端恢复 online_idle', (afterBusy.body.clients || []).find(c => c.id === CLIENT)?.state === 'online_idle');

  // 6) handoff 接力(同样走反向调用)
  section('handoff 接力');
  const ho = await req('POST', '/api/handoff', { task: '补全减法并加错误处理', existing_code: 'def sub(a, b):\n    # TODO', from: 'atom-code', to: CLIENT });
  check('handoff 成功', ho.body.success === true, JSON.stringify(ho.body).slice(0, 150));
  check('handoff 有产出', (ho.body.codeBlocks || []).length > 0 || !!ho.body.content);

  // 7) 开关:toggle_tool 关/开 + list_switches 反映(dispatch 之后再测,避免阻断)
  section('开关:toggle_tool 关闭 → 打开');
  await req('POST', '/api/toggle', { tool: CLIENT, enabled: false });
  const t1 = await req('GET', '/api/tools');
  check('toggle 关闭生效', t1.body.tools.find(x => x.name === CLIENT)?.enabled === false);
  check('toggle 写入稳定客户端实例键', JSON.parse(fs.readFileSync(testDataPath('switches.json'), 'utf-8'))['client:e2e-probe'] === false);
  await req('POST', '/api/toggle', { tool: 'client:e2e-probe', enabled: true });
  const t2 = await req('GET', '/api/tools');
  check('稳定实例 ID toggle 打开生效', t2.body.tools.find(x => x.name === CLIENT)?.enabled === true);

  // 8) 统计 / 记忆 / 日志 结构
  section('统计 / 记忆 / 日志');
  const stats = await req('GET', '/api/stats');
  check('token_stats 新调用写入稳定客户端实例键', !!stats.body.tools?.['client:e2e-probe'] && stats.body.tools['client:e2e-probe'].calls > 0);
  const toolStatsView = await req('GET', '/api/tools');
  check('工具 API 聚合稳定实例统计', toolStatsView.body.tools.find(t => t.id === 'client:e2e-probe')?.calls > 0);
  const mem = await req('GET', '/api/memory/recent?limit=5');
  check('memory_recent 结构正确(tasks 数组)', Array.isArray(mem.body.tasks));
  check('memory_recent 记录了本次 dispatch', (mem.body.tasks || []).some(t => (t.tools || []).includes(CLIENT)));
  const logs = await req('GET', '/api/logs?limit=10');
  check('logs 结构正确(logs 数组)', Array.isArray(logs.body.logs));

  // 9) 通过 MCP tools/call 调用 list_clients(客户端侧管理工具链路)
  section('MCP tools/call:list_clients');
  const lc = await mcp.request('tools/call', { name: 'list_clients', arguments: {} });
  check('list_clients 工具可调用', !lc.result?.isError && /共享中枢/.test(lc.result?.content?.[0]?.text || ''));

  // 9.2) manage_client 活体闭环(T-A 载体断言,派工前红):假 clientId 走 approve→kick,
  //      专杀 client_key→clientId 请求体重映射 bug(原样透传 args 会被 server 400"缺少 clientId")
  section('MCP tools/call:manage_client');
  const mcA = await mcp.request('tools/call', { name: 'manage_client', arguments: { action: 'approve', client_key: 'e2e-fake-client' } });
  check('manage_client approve 假 clientId 成功', !mcA.error && !mcA.result?.isError, JSON.stringify(mcA.result?.content?.[0]?.text || mcA).substring(0, 160));
  const mcK = await mcp.request('tools/call', { name: 'manage_client', arguments: { action: 'kick', client_key: 'e2e-fake-client' } });
  check('manage_client kick 未连接 client 仍成功', !mcK.error && !mcK.result?.isError, JSON.stringify(mcK.result?.content?.[0]?.text || mcK).substring(0, 160));

  // 9.3) 桥层失败路径(T-D 指定红集=3):
  //   D1 中枢对不存在会议返回 404 {error:'会议不存在'}——桥 httpGet/httpPost 丢弃状态码,
  //      404 错误体被当 200 正常体渲染出 undefined 字段(F5 实况)。T-D 要求:isError 且文本含"会议不存在"、不泄露 undefined。
  //   D2 中枢离线时 tools/call 必须落成 isError 的 CallToolResult(现仅靠 handleMessage 的 jsonrpc -32603 兜底,
  //      非 MCP 规范形态),且桥进程绝不因单次调用失败而死。
  //   D3 中枢重启后长驻桥必须自动重注册并恢复(回归防护:根治不得破坏既有自愈路径)。
  section('桥层失败路径:T-D 根治红集');
  const dStatus = await mcp.request('tools/call', { name: 'discuss', arguments: { action: 'status', meetingId: 'no-such-meeting-e2e' } });
  const dText = (dStatus.result?.content || []).map(c => c.text || '').join('\n');
  check('D1 discuss status 假会议 → isError 且透传"会议不存在",不泄露 undefined',
    dStatus.result?.isError === true && /会议不存在/.test(dText) && !/undefined/.test(dText),
    JSON.stringify(dStatus).substring(0, 200));

  const DEAD_PORT = 9899;
  const deadProc = spawn(process.execPath, ['bridge-stdio.js'], {
    cwd: __dirname,
    env: { ...process.env, AI_BRIDGE_PORT: String(DEAD_PORT), AI_BRIDGE_HOST: HOST, AI_BRIDGE_CLIENT: 'e2e-dead-probe' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const deadMcp = makeMcpChannel(deadProc);
  const deadCall = deadMcp.request('tools/call', { name: 'list_tools', arguments: {} });
  const earlyExit = await Promise.race([
    deadCall.then(() => 'answered'),
    new Promise(res => deadProc.once('exit', code => res('exited:' + code)))
  ]);
  const aliveAfterDead = earlyExit === 'answered' && deadProc.exitCode === null;
  let deadResp = null;
  if (aliveAfterDead) { try { deadResp = await deadCall; } catch { deadResp = null; } }
  check('D2 中枢离线 tools/call → isError 优雅降级(CallToolResult 形态)', aliveAfterDead && deadResp?.result?.isError === true, JSON.stringify(deadResp || earlyExit).substring(0, 160));
  check('D2b 桥在调用失败后进程仍存活', aliveAfterDead, String(earlyExit));

  serverProc.kill();
  let hubDown = false;
  for (let i = 0; i < 40 && !hubDown; i++) { await sleep(150); try { await req('GET', '/api/health'); } catch { hubDown = true; } }
  serverProc = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, AI_BRIDGE_PORT: String(PORT), AI_BRIDGE_HOST: HOST, AI_BRIDGE_DATA_DIR: TEST_RUNTIME, AI_BRIDGE_DB: TEST_DB, AI_BRIDGE_OBSERVE_DIR: TEST_OBSERVE, AI_BRIDGE_WORKSPACE_ROOT: path.join(TEST_RUNTIME, 'workspaces'), AI_BRIDGE_CLIENT_TTL: '1200', AI_BRIDGE_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProc.stderr.on('data', d => { serverErr += d.toString(); });
  await waitServerReady();
  await waitClientConnected(CLIENT, 20000);
  const dAfterRecover = await mcp.request('tools/call', { name: 'list_tools', arguments: {} });
  const recoverText = ((dAfterRecover?.result?.content) || []).map(c => c.text || '').join('\n');
  check('D3 中枢重启后桥自动重注册并恢复服务', !dAfterRecover.error && dAfterRecover.result?.isError !== true && /e2e-probe/.test(recoverText), JSON.stringify(dAfterRecover).substring(0, 200));
  try { deadProc.stdin.end(); deadProc.kill(); } catch { /* ignore */ }

  // 9.4) discuss 路由字段与前置校验(T-D2 指定红集):
  //   用假中枢(spy)抓桥实际发出的请求体——这是 F5 那轮测试从未覆盖的盲区:
  //   桥侧的"本地前置校验"与"MCP 路由字段不得污染业务请求体"只有抓到出网报文才可机器验证。
  //   X1 红:interrupt 缺 meetingId 必须桥本地拦截(文案含"缺少 meetingId"),且不得打到中枢。
  //   X3 红:interrupt/inject 的 POST 请求体必须已剥离路由字段 action(status/inject 现有实现在透传 args)。
  section('discuss 前置校验与路由字段剥离:T-D2 红集');
  const SPY_PORT = 9813;
  const spyCalls = [];
  const spySrv = http.createServer((rq, rs) => {
    let b = '';
    rq.on('data', c => b += c);
    rq.on('end', () => {
      let j = null; try { j = JSON.parse(b || '{}'); } catch { /* 非 JSON 忽略 */ }
      spyCalls.push({ url: rq.url, body: j });
      rs.writeHead(200, { 'Content-Type': 'application/json' });
      rs.end(JSON.stringify({ ok: true, meetingId: 'spy-1', topic: 'spy', status: 'running', participants: [], messageCount: 0, totalTokens: 0 }));
    });
  });
  await new Promise(r => spySrv.listen(SPY_PORT, HOST, r));
  const spyProc = spawn(process.execPath, ['bridge-stdio.js'], {
    cwd: __dirname,
    env: { ...process.env, AI_BRIDGE_PORT: String(SPY_PORT), AI_BRIDGE_HOST: HOST, AI_BRIDGE_CLIENT: 'e2e-spy' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const spyMcp = makeMcpChannel(spyProc);
  await spyMcp.request('initialize', {});
  await sleep(500); // 放行启动期注册请求,随后只考察工具调用报文

  spyCalls.length = 0;
  const xItc = await spyMcp.request('tools/call', { name: 'discuss', arguments: { action: 'interrupt' } });
  const xItcText = (xItc.result?.content || []).map(c => c.text || '').join('\n');
  const hitInterrupt = spyCalls.filter(c => c.url === '/api/discuss/interrupt');
  check('X1a discuss interrupt 缺 meetingId → 桥本地 isError 且文案含"缺少 meetingId"',
    xItc.result?.isError === true && /缺少 meetingId/.test(xItcText), JSON.stringify(xItc).substring(0, 200));
  check('X1b 本地拦截后不得把空 meetingId 打到中枢', hitInterrupt.length === 0, JSON.stringify(spyCalls.map(c => c.url)));

  spyCalls.length = 0;
  const xItc2 = await spyMcp.request('tools/call', { name: 'discuss', arguments: { action: 'interrupt', meetingId: 'm-spy', reason: '止损' } });
  const itcBody = (spyCalls.find(c => c.url === '/api/discuss/interrupt') || {}).body;
  check('X3a interrupt 业务请求体已剥离路由字段 action(且保留 meetingId/reason)',
    !xItc2.result?.isError && !!itcBody && itcBody.meetingId === 'm-spy' && itcBody.reason === '止损' && !('action' in itcBody), JSON.stringify(itcBody));

  spyCalls.length = 0;
  const xInj2 = await spyMcp.request('tools/call', { name: 'discuss', arguments: { action: 'inject', meetingId: 'm-spy', message: '方向偏了' } });
  const injBody = (spyCalls.find(c => c.url === '/api/discuss/inject') || {}).body;
  check('X3b inject 业务请求体已剥离路由字段 action(且保留 meetingId/message)',
    !xInj2.result?.isError && !!injBody && injBody.meetingId === 'm-spy' && injBody.message === '方向偏了' && !('action' in injBody), JSON.stringify(injBody));

  spyCalls.length = 0;
  const xInj = await spyMcp.request('tools/call', { name: 'discuss', arguments: { action: 'inject', message: '无会议ID' } });
  const xInjText = (xInj.result?.content || []).map(c => c.text || '').join('\n');
  check('X2 inject 缺 meetingId 本地拦截且不打到中枢(回归防护)',
    xInj.result?.isError === true && /缺少 meetingId/.test(xInjText) && spyCalls.filter(c => c.url === '/api/discuss/inject').length === 0,
    JSON.stringify(xInj).substring(0, 160));

  try { spyProc.stdin.end(); spyProc.kill(); } catch { /* ignore */ }
  await new Promise(r => spySrv.close(r));

  // 9.4b) 被拉黑客户端的桥必须走 403 denied 慢重试(而非连接失败退避),且不得混入在线列表
  section('准入拒绝:403 denied 走慢重试(T-D L4 回归防护)');
  const blockedDeny = await req('POST', '/api/clients/deny', { clientId: 'e2e-blocked-probe' });
  const blockedAclView = await req('GET', '/api/clients');
  check('deny 端点把 e2e-blocked-probe 拉黑', blockedDeny.status === 200 && blockedDeny.body.success === true && (blockedAclView.body.blocklist || []).includes('e2e-blocked-probe'), JSON.stringify(blockedDeny.body).substring(0, 160));
  const blockedProc = spawn(process.execPath, ['bridge-stdio.js'], {
    cwd: __dirname,
    env: { ...process.env, AI_BRIDGE_PORT: String(PORT), AI_BRIDGE_HOST: HOST, AI_BRIDGE_CLIENT: 'e2e-blocked-probe' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let blockedErr = '';
  blockedProc.stderr.on('data', d => { blockedErr += d.toString(); });
  await sleep(2500);
  check('X4a 黑名单客户端:桥按 403 denied 打"已被管理员拒绝"并存活(非崩溃非退出)',
    blockedProc.exitCode === null && /已被管理员拒绝/.test(blockedErr), blockedErr.substring(0, 240));
  const blockedView = await req('GET', '/api/clients');
  check('X4b 黑名单客户端未混入在线客户端列表', !(blockedView.body.clients || []).some(c => c.id === 'e2e-blocked-probe' && c.online === true),
    JSON.stringify((blockedView.body.clients || []).map(c => c.id)).substring(0, 200));
  try { blockedProc.stdin.end(); blockedProc.kill(); } catch { /* ignore */ }

  // 9.6) GET 挂起必须自行超时(#38 指定红集)
  //   根因:bridge-stdio.js 的 httpPost 在 :232 挂了 req.on('timeout') 并 destroy+reject,
  //   而 httpGet(:241) 传了 timeout:30000 却**没有注册 timeout 监听**——Node 下无人监听 'timeout'
  //   即不会自动销毁 socket,请求永久悬空;callTool 外层无总超时,宿主只能靠自己那条 60s RPC 超时,
  //   桥侧 pending 与 socket 一直泄漏。两个手写 HTTP 封装的漂移就是"同一规则多处实现"的现场证据。
  //   做法:黑洞服务器只接受连接、永不回包 → 修复前 GET 永悬(断言以桥是否在 55s 内回 isError 判红),
  //   修复后约 30s 由 timeout 监听 destroy+reject → L2 统一降级 isError '桥调用失败: 请求超时'。
  section('GET 挂起超时:#38 红集');
  const HOLE_PORT = 9814;
  let holeHits = 0;
  const holeSrv = http.createServer((rq) => { holeHits++; /* 故意永不 res.end() */ });
  await new Promise(r => holeSrv.listen(HOLE_PORT, HOST, r));
  const holeProc = spawn(process.execPath, ['bridge-stdio.js'], {
    cwd: __dirname,
    env: { ...process.env, AI_BRIDGE_PORT: String(HOLE_PORT), AI_BRIDGE_HOST: HOST, AI_BRIDGE_CLIENT: 'e2e-hole' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const holeMcp = makeMcpChannel(holeProc);
  await holeMcp.request('initialize', {});
  const t0 = Date.now();
  let holeResp = null, holeErr = null;
  try { holeResp = await holeMcp.request('tools/call', { name: 'list_tools', arguments: {} }); } catch (e) { holeErr = e.message; }
  const holeMs = Date.now() - t0;
  const holeText = ((holeResp && holeResp.result && holeResp.result.content) || []).map(c => c.text || '').join('\n');
  check('#38a GET 挂起须自行超时并降级 isError(而非永久悬空/靠宿主超时)',
    holeErr === null && holeResp && holeResp.result && holeResp.result.isError === true && /超时/.test(holeText) && holeMs < 55000,
    holeErr ? ('harness ' + holeErr + ' / 用时=' + holeMs + 'ms') : JSON.stringify({ isError: holeResp.result.isError, text: holeText.substring(0, 80), ms: holeMs }));
  // 耗时无条件打印:绿跑也要能取证(修复前是 60015ms 宿主超时,修复后应约 30000ms 自行回话)
  process.stdout.write(`  ⏱ #38a 实测耗时=${holeMs}ms 黑洞命中=${holeHits} ${holeErr ? '宿主超时' : '桥自行回话'}\n`);
  check('#38b 黑洞确实收到 GET(证明是响应挂起,不是连不上)', holeHits > 0, 'hits=' + holeHits);
  check('#38c 超时后桥进程仍存活(不得因挂起请求崩溃)', holeProc.exitCode === null, 'exitCode=' + holeProc.exitCode);
  try { holeProc.stdin.end(); holeProc.kill(); } catch { /* ignore */ }
  await new Promise(r => holeSrv.close(r));

  // 9.9) HTTP 超时预算必须统一且可配(#53/#48 指定红集)
  //   实况:服务端单次执行窗口 EXECUTE_TIMEOUT=900000(server.js:47),而桥的 httpPost 默认上限
  //   只有 600000(bridge-stdio.js:210)且 /api/dispatch(:274)吃的就是这个默认值 → 长任务在桥侧
  //   比中枢早 300s 被判"请求超时",中枢其实还在正常执行(误报失败 + 台账脏数据)。
  //   同时 httpGet 的 30000ms 是硬编码字面量且无参(:242/:246),POST 能给预算、GET 不能,
  //   两条路径语义不对称,且都无法被使用者调整(只有一个 AI_BRIDGE_SAMPLING_TIMEOUT 管反向 sampling)。
  //   契约:一个 AI_BRIDGE_HTTP_TIMEOUT 同时管住 GET/POST 与 callTool 总超时;默认值必须高于
  //   服务端窗口且留余量(静态关系锁见 test-audit-fixes 段 F)。
  //   做法:黑洞端口 9815 只接连接不回包,并带 20s 泄压阀(强制销毁 socket)——修复前 POST 会等
  //   600s、GET 会等 30s,红跑分别以 ~20s(连接被毁)与 ~30s(自行超时)返回,不会挂住整个套件;
  //   修复后两者都应在 1.5s 预算内自行回 isError。
  section('HTTP 超时预算统一:#53/#48 红集');
  const HOLE2_PORT = 9815;
  let hole2Hits = 0;
  const hole2Srv = http.createServer(() => { hole2Hits++; /* 故意永不 res.end() */ });
  const hole2Socks = new Set();
  hole2Srv.on('connection', (s) => { hole2Socks.add(s); s.on('close', () => hole2Socks.delete(s)); });
  await new Promise(r => hole2Srv.listen(HOLE2_PORT, HOST, r));
  // 泄压阀周期触发:修复前 POST 默认 600000ms、GET 硬编码 30000ms,若不放阀红跑会被宿主 RPC 超时(60s)
  // 兜住并拖慢套件;每 20s 主动断连,让红跑在 ~20s 定性返回(断言阈值 8s,仍判红)。
  const valve = setInterval(() => { for (const s of hole2Socks) { try { s.destroy(); } catch { /* ignore */ } } }, 20000);
  const hole2Proc = spawn(process.execPath, ['bridge-stdio.js'], {
    cwd: __dirname,
    env: { ...process.env, AI_BRIDGE_PORT: String(HOLE2_PORT), AI_BRIDGE_HOST: HOST, AI_BRIDGE_CLIENT: 'e2e-httplimit', AI_BRIDGE_HTTP_TIMEOUT: '1500' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const hole2Mcp = makeMcpChannel(hole2Proc);
  await hole2Mcp.request('initialize', {});
  const callBudget = async (toolName, args) => {
    const t = Date.now();
    let resp = null, err = null;
    try { resp = await hole2Mcp.request('tools/call', { name: toolName, arguments: args }); } catch (e) { err = e.message; }
    const ms = Date.now() - t;
    const text = ((resp && resp.result && resp.result.content) || []).map(c => c.text || '').join('\n');
    return { ms, err, isError: !!(resp && resp.result && resp.result.isError), text };
  };
  // GET 先测:修复前是 30000ms 硬编码(env 无效),必然 >8000ms
  const g = await callBudget('list_tools', {});
  process.stdout.write(`  ⏱ #53a GET(list_tools) 实测耗时=${g.ms}ms 黑洞命中=${hole2Hits} ${g.err ? '宿主超时' : '桥自行回话:' + g.text.substring(0, 40)}\n`);
  check('#53a GET 必须吃 AI_BRIDGE_HTTP_TIMEOUT 预算(修复前硬编码 30000ms,env 完全无效)',
    g.err === null && g.isError === true && /请求超时/.test(g.text) && g.ms < 8000, JSON.stringify({ ms: g.ms, err: g.err, text: g.text.substring(0, 60) }));
  // POST 再测:修复前默认 600000ms,被 20s 泄压阀打断 → 同样 >8000ms
  const p = await callBudget('dispatch', { task: '#53 长任务预算复现(黑洞,不该等满中枢窗口)' });
  process.stdout.write(`  ⏱ #48a POST(dispatch) 实测耗时=${p.ms}ms ${p.err ? '宿主超时' : '桥自行回话:' + p.text.substring(0, 40)}\n`);
  check('#48a POST 必须与 GET 共用同一预算(修复前 600000ms,长任务在桥侧被中枢窗口之外误报失败)',
    p.err === null && p.isError === true && /请求超时/.test(p.text) && p.ms < 8000, JSON.stringify({ ms: p.ms, err: p.err, text: p.text.substring(0, 60) }));
  check('#53b 黑洞确实收到请求(证明是响应挂起,不是连不上)', hole2Hits > 0, 'hits=' + hole2Hits);
  check('#53c 预算到期后桥进程仍存活(不得因挂起请求崩溃)', hole2Proc.exitCode === null, 'exitCode=' + hole2Proc.exitCode);
  clearTimeout(valve);
  try { hole2Proc.stdin.end(); hole2Proc.kill(); } catch { /* ignore */ }
  // srv.close() 会等待在途连接结束;桥里可能还有未回的挂起请求,必须先强制断干净再关,否则整节卡住
  for (const s of hole2Socks) { try { s.destroy(); } catch { /* ignore */ } }
  await new Promise(r => hole2Srv.close(r));

  // 9.45) 出站 HTTP 的三处同源缺陷(#49 指定红集)
  //   a) 慢速续命:两个封装的超时都是 Node 的 **inactivity** 型 socket timeout——只要对端每 40ms 吐一个字节,
  //      `timeout` 事件永不触发,桥就永久挂在"看起来还活着"的连接上(黑洞只在"完全不动"时才管用,#38/#53 覆盖的是那一种)。
  //   b) 负数 env:`parseInt(env) || 默认` 对 0/非数字会落默认,但**负数原样直通**;
  //      已实测 `http.request({timeout:-1})` 同步抛 ERR_OUT_OF_RANGE ⇒ 一个手滑的负数让桥彻底失联,
  //      而且拿到的是裸错误码(归因误导,#54 同族)。仓内其实已有 `parsePositiveInt(v,def)`(server.js:57,另有 5 处在用)。
  //   c) 双写手:httpPost(:221) 与 httpGet(:253) 各自实现同一套状态码阶梯,文案已分叉
  //      ——`服务返回格式错误`(POST) vs `格式错误`(GET),这就是"两份实现必然漂"的现行证据。
  section('HTTP 单点/绝对 deadline/负数 env:#49 红集');
  {
    const DRIP_PORT = 9816;
    const NEG_HUB_PORT = 9817;
    let dripHits = 0;
    const dripSrv = http.createServer((rq, rs) => {
      dripHits++;
      rs.writeHead(200, { 'Content-Type': 'application/json' });
      const iv = setInterval(() => { try { rs.write('x'); } catch (_) { clearInterval(iv); } }, 40);
      rq.on('close', () => clearInterval(iv));
    });
    const dripSocks = new Set();
    dripSrv.on('connection', (s) => { dripSocks.add(s); s.on('close', () => dripSocks.delete(s)); });
    await new Promise(r => dripSrv.listen(DRIP_PORT, HOST, r));

    const budgetCall = async (mcp, name, args, capMs) => {
      const t0 = Date.now();
      let out = {};
      const capped = await Promise.race([
        mcp.request('tools/call', { name, arguments: args }).then(r => ({ r, err: null })).catch(e => ({ r: null, err: e.message })),
        new Promise(res => setTimeout(() => res(null), capMs))
      ]);
      if (capped === null) return { ms: Date.now() - t0, capped: true, isError: false, text: '' };
      out = capped;
      const text = (((out.r || {}).result || {}).content || []).map(c => c.text || '').join('\n');
      return { ms: Date.now() - t0, capped: false, isError: !!((out.r || {}).result || {}).isError, text, err: out.err };
    };

    const dripProc = spawn(process.execPath, ['bridge-stdio.js'], {
      cwd: __dirname,
      env: { ...process.env, AI_BRIDGE_PORT: String(DRIP_PORT), AI_BRIDGE_HOST: HOST, AI_BRIDGE_CLIENT: 'e2e-drip', AI_BRIDGE_HTTP_TIMEOUT: '1500' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    dripProc.stderr.on('data', () => {});
    const dripMcp = makeMcpChannel(dripProc);
    await dripMcp.request('initialize', {}).catch(() => {});
    const d = await budgetCall(dripMcp, 'list_tools', {}, 12000);
    process.stdout.write(`  ⏱ #49n2 drip 实测耗时=${d.ms}ms 命中=${dripHits} ${d.capped ? '桥未自行回话(被我方 12s 上限掐住)' : '桥回话:' + d.text.substring(0, 46)}\n`);
    check('#49n1 前置:慢速续命的服务端确实收到了请求(证明是"响应挂起"而不是连不上)', dripHits > 0, 'hits=' + dripHits);
    check('#49n2 红:每 40ms 吐 1 字节的响应必须被**绝对 deadline** 掐断(现状 inactivity 型 socket timeout 被续命,桥永不回话)',
      d.capped === false && d.isError === true, JSON.stringify({ capped: d.capped, ms: d.ms, isError: d.isError, text: d.text.substring(0, 60) }));
    check('#49n3 红:超时归因必须带上**实际生效的预算数值**(现在只会说"请求超时",运维分不清是 1500 的预算还是 960000 的窗口)',
      !d.capped && /1500/.test(d.text), 'text=' + d.text.substring(0, 120));
    clearTimeout(valve);
    try { dripProc.stdin.end(); dripProc.kill(); } catch { /* ignore */ }
    for (const s of dripSocks) { try { s.destroy(); } catch { /* ignore */ } }
    await new Promise(r => dripSrv.close(r));

    // 负数 env:需要一台**功能正常**的中枢(独立实例,不碰主实例的客户端计数),桥只带坏 env
    const negDir = path.join(TEST_RUNTIME, 'neg-env');
    fs.mkdirSync(negDir, { recursive: true });
    const negHub = spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: {
        ...process.env, AI_BRIDGE_PORT: String(NEG_HUB_PORT), AI_BRIDGE_HOST: HOST,
        AI_BRIDGE_DATA_DIR: negDir, AI_BRIDGE_DB: path.join(negDir, 'neg.db'),
        AI_BRIDGE_OBSERVE_DIR: path.join(negDir, 'observe'), AI_BRIDGE_WORKSPACE_ROOT: path.join(negDir, 'ws'),
        AI_BRIDGE_TOKEN: ''
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    negHub.stderr.on('data', () => {}); negHub.stdout.on('data', () => {});
    await sleep(2000);
    let negErr = '';
    const negProc = spawn(process.execPath, ['bridge-stdio.js'], {
      cwd: __dirname,
      env: { ...process.env, AI_BRIDGE_PORT: String(NEG_HUB_PORT), AI_BRIDGE_HOST: HOST, AI_BRIDGE_CLIENT: 'e2e-neg-env', AI_BRIDGE_HTTP_TIMEOUT: '-1' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    negProc.stderr.on('data', (chunk) => { negErr += chunk.toString(); });
    negProc.stdout.on('data', () => {});
    const negMcp = makeMcpChannel(negProc);
    await negMcp.request('initialize', {}).catch(() => {});
    const n = await budgetCall(negMcp, 'list_tools', {}, 12000);
    // 【我自己的锁缺陷,当场纠正】原判据要求 list_tools 的输出里匹配 /name/,但桥的 list_tools 返回的是中文
    //   Markdown 表(bridge-stdio.js:343-348:`| 工具 | 检测 | 开关 | tokens | 次数 |`),工具名都是 openclaw/
    //   codely 之类,**任何正确实现都不可能让它为真** —— 这是流水线第 4 次"锁数量对、内容错"(#47a1/a3 互斥、
    //   K4 被我写成 K3b 副本、#80 探针漏 commandPaths,同一族病)。编码手没有改测试也没有改响应文案,而是
    //   带证据报 SPEC GAP —— 判定成立,记合格。
    // 判据换成与响应文案**无关**的直接证据:① 桥侧这轮调用不出错;② 中枢确实看见该客户端注册上来
    //   (注册本身要走一次 httpPost 出站,egress 通不通由此直证;`ERR_OUT_OF_RANGE` 也必须不出现)。
    const negClients = await jreq(NEG_HUB_PORT, 'GET', '/api/clients');
    const negSeen = JSON.stringify(negClients.body || {}).includes('e2e-neg-env');
    check('#49n4 红:负数 AI_BRIDGE_HTTP_TIMEOUT 不得让桥彻底失联(现状 parseInt(env)||默认 让 -1 直通 → http.request 同步抛 ERR_OUT_OF_RANGE)',
      n.capped === false && n.isError === false && !/ERR_OUT_OF_RANGE/.test(n.text) && negSeen === true,
      JSON.stringify({ capped: n.capped, err: n.err, isError: n.isError, 中枢在册: negSeen, httpStatus: negClients.status, text: n.text.substring(0, 60) }) + ' stderr=' + negErr.substring(0, 80));
    check('#49n5 非法 env 必须留痕:stderr 要同时出现变量名与"非法/回落/正数"字样(静默落默认 = 设了却不生效且无人知道)',
      /AI_BRIDGE_HTTP_TIMEOUT/.test(negErr) && /非法|无效|不是正数|必须为正|回落/.test(negErr),
      'stderr=' + negErr.substring(0, 200));
    try { negProc.stdin.end(); negProc.kill(); } catch { /* ignore */ }
    try { negHub.kill(); } catch { /* ignore */ }
    await sleep(300);

    // 结构面(兜底,主证是上面四条):两份实现与 12 处 env 解析必须归一
    const brSrc = fs.readFileSync(path.join(__dirname, 'bridge-stdio.js'), 'utf-8').replace(/\r/g, '');
    const srvSrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf-8').replace(/\r/g, '');
    const unsafe = ((srvSrc + '\n' + brSrc).match(/parseInt\(process\.env\.AI_BRIDGE_[A-Z0-9_]+(, ?10)?\)[^;\n]*\|\|/g) || []);
    check('#49n6 红:12 处 parseInt(process.env.AI_BRIDGE_*) || 默认 必须全部迁到**已有**的 parsePositiveInt(server.js:57,已有 5 处在用)——那是"第二写手早就存在却没人调"',
      unsafe.length === 0, '残留=' + unsafe.length + ' :: ' + unsafe.map(s => s.substring(0, 46)).join(' | ').substring(0, 240));
    check('#49n7 红:GET/POST 的格式错误文案分叉必须收敛成一处(现状 POST="服务返回格式错误"、GET="格式错误",两份实现已在漂的直接证据)',
      !(/服务返回格式错误/.test(brSrc) && /'格式错误'/.test(brSrc)),
      'POST 文案=' + /服务返回格式错误/.test(brSrc) + ' GET 裸文案=' + /'格式错误'/.test(brSrc));
    check('#49n8 哨兵(不回退):GET 的 30000 短兜底不得被抬走(#38a 的黑洞自愈路径依赖它;抬到 960000 会让 GET 永久悬空)',
      /AI_BRIDGE_HTTP_TIMEOUT[^\n]*?30000/.test(brSrc), '未匹配到 GET 的 30000 兜底(两种写法都接受:`|| 30000` 与 `parsePositiveInt(…, 30000)`)');
  }

  // 9.5) 智能路由:关闭全部本机 CLI 工具(确定性),未指定 tools 时按综合评分自动选优
  section('智能路由:未指定 tools 使用可解释综合评分');
  const allT = await req('GET', '/api/tools');
  for (const t of allT.body.tools) {
    if (t.name !== CLIENT && t.name !== REVIEWER && t.enabled) await req('POST', '/api/toggle', { tool: t.name, enabled: false });
  }
  const auto = await req('POST', '/api/dispatch', { task: '写一个 Python max3(a,b,c) 函数' });
  check('routing.mode=auto 且回显 ranking 依据', auto.body.routing?.mode === 'auto' && Array.isArray(auto.body.routing.ranking), JSON.stringify(auto.body.routing || {}).slice(0, 200));
  check('综合路由策略与任务类别正确', auto.body.routing?.strategy === 'composite-v1' && auto.body.routing?.taskCategory === 'code', JSON.stringify(auto.body.routing || {}).slice(0, 250));
  const topRoute = auto.body.routing?.ranking?.[0];
  check('综合路由返回七个可解释分量', ['success', 'capability', 'latency', 'tokenCost', 'freshness', 'stability', 'confidence'].every(k => Number.isFinite(topRoute?.components?.[k])), JSON.stringify(topRoute || {}).slice(0, 350));
  check('综合路由返回选择原因与稳定 ID', typeof auto.body.routing?.selectedReason === 'string' && topRoute?.toolId === 'client:e2e-probe', JSON.stringify(auto.body.routing || {}).slice(0, 350));
  check('综合路由选中已验证工具(e2e-probe)', auto.body.routing?.selected === CLIENT, 'selected=' + auto.body.routing?.selected);
  check('智能路由 dispatch 往返成功', auto.body.successCount === 1, JSON.stringify(auto.body).slice(0, 120));

  // 9.6) 交叉评审闭环:生产者产出 → 独立评审者评审
  section('交叉评审:生成 → 另一工具评审');
  const rv = await req('POST', '/api/dispatch', { task: '写一个 Python mul(a,b) 函数', tools: [CLIENT], review: true, reviewer: REVIEWER });
  check('主产出成功', rv.body.successCount === 1, JSON.stringify(rv.body).slice(0, 120));
  check('评审由独立工具完成(reviewer≠producer)', rv.body.review?.reviewer === REVIEWER && rv.body.review?.producer === CLIENT, JSON.stringify(rv.body.review || {}).slice(0, 200));
  check('评审有实质内容', typeof rv.body.review?.content === 'string' && rv.body.review.content.length > 0);

  // 9.6a) 评审空产出:评审者返回空文本必须判失败,不得记成"评审成功但没内容"
  const rvEmpty = await req('POST', '/api/dispatch', { task: '写一个 Python pow2(x) 函数 REVIEW_EMPTY_MARK', tools: [CLIENT], review: true, reviewer: REVIEWER });
  check('评审空产出场景主产出仍成功', rvEmpty.body.successCount === 1, JSON.stringify(rvEmpty.body).slice(0, 160));
  check('评审空产出判失败(skipped+空产出原因)', rvEmpty.body.review?.skipped === true && /空产出/.test(rvEmpty.body.review?.reason || ''), JSON.stringify(rvEmpty.body.review || {}).slice(0, 200));

  // 9.65) 空产出假成功:exit0/无输出必须判失败,且能触发自动接力(此前 mimo 额度耗尽被记 1/1 成功)
  section('空产出判失败 + 接力链');
  const emptyDisp = await req('POST', '/api/dispatch', { task: 'EMPTYOUT_MARK 这个任务宿主返回空输出', tools: [CLIENT], auto_fallback: false });
  check('空产出判为失败(successCount=0)', emptyDisp.body.successCount === 0, JSON.stringify(emptyDisp.body).slice(0, 200));
  check('失败原因是空产出', /空产出/.test(emptyDisp.body.results?.[0]?.reason || ''), JSON.stringify(emptyDisp.body.results?.[0] || {}).slice(0, 200));
  // fallback_scope:'all' 显式保留"越白名单池回退"旧行为验证;默认(auto)已收紧为白名单内(见 test-external-fixes.mjs T1)
  const emptyFb = await req('POST', '/api/dispatch', { task: 'EMPTYOUT_MARK 应触发接力', tools: [CLIENT], fallback_scope: 'all' });
  check('空产出后自动接力换工具成功', emptyFb.body.successCount === 1 && emptyFb.body.results?.[0]?.fallback === true, JSON.stringify(emptyFb.body.results?.[0] || {}).slice(0, 220));
  check('接力目标为评审客户端', emptyFb.body.results?.[0]?.tool === REVIEWER, 'tool=' + emptyFb.body.results?.[0]?.tool);

  // 9.7) 异步任务队列:async dispatch 立即返回 taskId,轮询取结果
  section('异步任务队列:async dispatch + taskId 轮询');
  const at = await req('POST', '/api/dispatch', { task: '写一个 Python neg(x) 函数', tools: [CLIENT], async: true });
  check('async 模式返回 202 + taskId', at.status === 202 && typeof at.body.taskId === 'string', JSON.stringify(at.body).slice(0, 120));
  let atFinal = null;
  for (let i = 0; i < 40; i++) {
    const q = await req('GET', '/api/task/' + at.body.taskId);
    if (q.body.status === 'done' || q.body.status === 'failed') { atFinal = q.body; break; }
    await sleep(250);
  }
  check('异步任务完成(done)', atFinal?.status === 'done', 'status=' + atFinal?.status);
  check('异步结果可查(successCount=1)', atFinal?.result?.successCount === 1, JSON.stringify(atFinal?.result || {}).slice(0, 120));
  const nf = await req('GET', '/api/task/atask_notexist');
  check('不存在的任务返回 404', nf.status === 404, 'status=' + nf.status);

  // 9.8) 共识引擎:双参与者讨论正常结束后自动生成共识总结
  section('共识引擎:讨论结束自动生成共识总结');
  const cm = await req('POST', '/api/discuss', { topic: 'e2e 共识话题:加法函数实现方案', participants: [CLIENT, REVIEWER], round2: false, implement: false });
  check('双参与者讨论启动', cm.status === 200 && !!cm.body.meetingId, JSON.stringify(cm.body).slice(0, 120));
  const cmFinal = await pollMeetingClosed(cm.body.meetingId, 30000);
  check('会议正常关闭(非中断)', cmFinal.status === 'closed' && !cmFinal.interrupted, 'status=' + cmFinal.status + ' interrupted=' + cmFinal.interrupted);
  check('自动生成共识总结发言', (cmFinal.messages || []).some(m => m.speaker === '共识总结' && (m.content || '').length > 0), '发言者: ' + (cmFinal.messages || []).map(m => m.speaker).join(','));

  // 11) 健康检查端点(免鉴权/免工具检测)
  section('健康检查端点 /api/health');
  const health = await req('GET', '/api/health');
  check('/api/health 返回 ok', health.body.status === 'ok');
  check('/api/health 含 uptime/port/clients 字段', typeof health.body.uptime === 'number' && health.body.port === PORT && typeof health.body.clients === 'number');

  // 11.5) 主动干预:讨论会自动止损(token 预算 + 时长上限),防无限讨论
  //   置于并发闸门测试之前——后者会向 memory.json 注入 fake discussing 会议污染状态
  section('主动干预:讨论会自动止损(token 预算 / 时长上限)');
  // token 预算=0:首位发言者前即超预算,不调用任何真实 CLI 工具(确定性)
  const stopTok = await req('POST', '/api/discuss', { topic: '自动止损-token', participants: [CLIENT], round2: false, implement: false, max_tokens: 0 });
  check('discuss 启动并回显 budget.maxTokens=0', stopTok.status === 200 && stopTok.body.budget?.maxTokens === 0, JSON.stringify(stopTok.body.budget));
  const tokFinal = await pollMeetingClosed(stopTok.body.meetingId);
  check('token 预算耗尽触发自动止损(会议终止)', tokFinal.interrupted === true, 'status=' + tokFinal.status);
  check('止损原因含“自动止损”且含“token”', /自动止损/.test(tokFinal.interruptReason || '') && /token/.test(tokFinal.interruptReason || ''), tokFinal.interruptReason);

  // 时长上限=0:token 预算用默认,壁钟时长立即超限
  const stopMs = await req('POST', '/api/discuss', { topic: '自动止损-时长', participants: [CLIENT], round2: false, implement: false, max_ms: 0 });
  check('discuss 启动并回显 budget.maxMs=0', stopMs.status === 200 && stopMs.body.budget?.maxMs === 0, JSON.stringify(stopMs.body.budget));
  const msFinal = await pollMeetingClosed(stopMs.body.meetingId);
  check('时长超限触发自动止损(会议终止)', msFinal.interrupted === true, 'status=' + msFinal.status);
  check('止损原因含“自动止损”且含“时长”', /自动止损/.test(msFinal.interruptReason || '') && /时长/.test(msFinal.interruptReason || ''), msFinal.interruptReason);

  // 12) 讨论会并发闸门(注入 MAX 个 discussing 会议,验证第 4 个被拒)
  section('讨论会并发闸门 MAX_CONCURRENT_MEETINGS');
  const memPath = testDataPath('memory.json');
  const memObj = fs.existsSync(memPath) ? JSON.parse(fs.readFileSync(memPath, 'utf-8')) : {};
  memObj.meetings = [
    { id: 'm1', status: 'discussing', topic: 't1', participants: [], messages: [] },
    { id: 'm2', status: 'discussing', topic: 't2', participants: [], messages: [] },
    { id: 'm3', status: 'discussing', topic: 't3', participants: [], messages: [] }
  ];
  fs.writeFileSync(memPath, JSON.stringify(memObj, null, 2));
  const guard = await req('POST', '/api/discuss', { topic: '应被闸门拒绝', participants: [CLIENT] });
  check('并发达上限时 discuss 返回 429', guard.status === 429, 'status=' + guard.status);
  check('429 提示信息含“上限”', /上限/.test(guard.body.error || ''), guard.body.error);

  // 10) estimateTokens 单元校验(中文友好估算)
  section('estimateTokens 单元校验');
  const { estimateTokens } = require('./tool-registry.js');
  check('estimateTokens ASCII > 0', estimateTokens('hello world') > 0);
  check('estimateTokens CJK 密度更高', estimateTokens('这是一段中文测试文本内容') > estimateTokens('abcdefghijkl'));

  // 13) 可观测性:/api/metrics 运行指标端点
  section('运行指标端点 /api/metrics');
  const metrics = await req('GET', '/api/metrics');
  check('/api/metrics 返回 counters 结构', metrics.status === 200 && !!metrics.body.counters && typeof metrics.body.counters.dispatchTotal === 'number');
  check('/api/metrics 记录了至少一次 dispatch', metrics.body.counters.dispatchTotal >= 1, 'dispatchTotal=' + metrics.body.counters?.dispatchTotal);
  check('/api/metrics 含配置快照', typeof metrics.body.config?.maxConcurrentDispatch === 'number' && typeof metrics.body.config?.authEnabled === 'boolean');
  check('/api/metrics 含数据文件体积', metrics.body.dataFileBytes && typeof metrics.body.dataFileBytes.memory === 'number');
  check('/api/metrics 记录自动止损次数(meetingsAutoStopped>=2)', metrics.body.counters.meetingsAutoStopped >= 2, 'meetingsAutoStopped=' + metrics.body.counters?.meetingsAutoStopped);
  check('/api/metrics config 含会议预算硬顶', typeof metrics.body.config?.maxMeetingTokens === 'number' && typeof metrics.body.config?.meetingMaxMs === 'number', JSON.stringify(metrics.body.config));
  check('/api/metrics 含全局库状态', typeof metrics.body.db?.available === 'boolean', JSON.stringify(metrics.body.db));

  // 13.5) 全局数据库:结果沉淀校验(测试专用库,与生产库隔离)
  section('全局数据库沉淀 /api/db/stats');
  const dbs = await req('GET', '/api/db/stats');
  check('全局库可用(node:sqlite)', dbs.body.available === true, JSON.stringify(dbs.body).slice(0, 200));
  check('dispatch 结果已沉淀入库', (dbs.body.dispatches?.n || 0) >= 3, 'dispatches.n=' + dbs.body.dispatches?.n);
  check('交叉评审已沉淀入库', (dbs.body.reviews?.n || 0) >= 1, 'reviews.n=' + dbs.body.reviews?.n);
  check('会议终态已沉淀入库(含止损+共识会议)', (dbs.body.meetings?.n || 0) >= 3, 'meetings.n=' + dbs.body.meetings?.n);
  check('异步任务已沉淀入库(done>=1)', (dbs.body.asyncTasks?.done || 0) >= 1, JSON.stringify(dbs.body.asyncTasks));

  // 13.7) 全局观测:telemetry 上报 / 代理透传 / 用量洞察
  section('全局观测:telemetry 上报 + 透传代理 + insights');
  // telemetry 批量上报入库(含密钥脱敏)
  const tel = await req('POST', '/api/telemetry', {
    source: 'e2e-external-tool',
    events: [
      { type: 'session', model: 'test-model-a', inputTokens: 100, outputTokens: 50, durationMs: 1200 },
      { type: 'tool_use', success: false, detail: '密钥 sk-abcdefgh12345678 不应入库明文' }
    ]
  });
  check('telemetry 批量上报成功(recorded=2)', tel.status === 200 && tel.body.recorded === 2, JSON.stringify(tel.body));
  const telBad = await req('POST', '/api/telemetry', { source: 'x', events: '不是数组' });
  check('telemetry 畸形入参被拒(400)', telBad.status === 400, 'status=' + telBad.status);
  // bridge-stdio 每次 sampling 后自动上报(前面 dispatch 已触发多次)
  const ins0 = await req('GET', '/api/insights');
  check('insights 返回 bySource 汇总', ins0.status === 200 && Array.isArray(ins0.body.summary?.bySource), JSON.stringify(ins0.body).slice(0, 150));
  check('bridge-stdio sampling 自动上报已入库', (ins0.body.summary?.bySource || []).some(r => r.source === CLIENT && r.channel === 'telemetry'), JSON.stringify(ins0.body.summary?.bySource || []).slice(0, 300));
  // 透传代理:登记路由 → 请求经代理直达迷你上游 → 用量解析入库
  const upstreamSrv = http.createServer((q, s) => {
    let b = '';
    q.on('data', c => b += c);
    q.on('end', () => {
      s.writeHead(200, { 'Content-Type': 'application/json' });
      s.end(JSON.stringify({ id: 'cmpl-e2e', echoPath: q.url, choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 11, completion_tokens: 7 } }));
    });
  });
  await new Promise(r => upstreamSrv.listen(9821, HOST, r));
  const routeAdd = await req('POST', '/api/observe/route', { source: 'e2e-proxytool', key: 'main', upstream: 'http://127.0.0.1:9821/v1' });
  check('手动登记代理路由成功', routeAdd.status === 200 && routeAdd.body.success === true, JSON.stringify(routeAdd.body));
  const viaProxy = await req('POST', '/proxy/e2e-proxytool/main/chat/completions', { model: 'proxy-test-model', messages: [] });
  check('代理透传响应原样返回(含上游路径拼接)', viaProxy.status === 200 && viaProxy.body.id === 'cmpl-e2e' && viaProxy.body.echoPath === '/v1/chat/completions', JSON.stringify(viaProxy.body).slice(0, 150));
  const noRoute = await req('POST', '/proxy/nobody/nowhere/x', {});
  check('未登记路由返回 404', noRoute.status === 404, 'status=' + noRoute.status);
  await sleep(300); // 用量入库在响应结束后同 tick 写入,留余量
  const ins1 = await req('GET', '/api/insights');
  const proxyRow = (ins1.body.summary?.bySource || []).find(r => r.source === 'e2e-proxytool' && r.channel === 'proxy');
  check('代理请求用量解析入库(11/7 tokens)', !!proxyRow && proxyRow.input_tokens === 11 && proxyRow.output_tokens === 7, JSON.stringify(proxyRow || ins1.body.summary?.bySource || []).slice(0, 200));
  check('recent 事件含模型名', (ins1.body.summary?.recent || []).some(e => e.model === 'proxy-test-model'), JSON.stringify((ins1.body.summary?.recent || []).slice(0, 3)));
  upstreamSrv.close();
  // 接管护栏:不支持/未知工具直接拒绝,不碰任何真实配置
  const tkUnsupported = await req('POST', '/api/observe/takeover', { tool: 'codex' });
  check('不支持的工具接管被拒(400)', tkUnsupported.status === 400 && /暂不支持/.test(tkUnsupported.body.error || ''), JSON.stringify(tkUnsupported.body));
  const tkUnknown = await req('POST', '/api/observe/takeover', { tool: 'not-a-tool' });
  check('未知工具接管被拒(400)', tkUnknown.status === 400, 'status=' + tkUnknown.status);
  const obsStatus = await req('GET', '/api/observe/status');
  check('observe/status 返回五工具注册表', obsStatus.status === 200 && Object.keys(obsStatus.body.tools || {}).length === 5, JSON.stringify(Object.keys(obsStatus.body.tools || {})));
  check('注册表登记了手动路由', !!obsStatus.body.routes?.['e2e-proxytool/main'], JSON.stringify(obsStatus.body.routes || {}).slice(0, 150));

  // 14) 健壮性:畸形/越界入参优雅拒绝(不 5xx 崩溃)
  section('健壮性:畸形入参拒绝');
  const emptyTask = await req('POST', '/api/dispatch', { task: '', tools: [CLIENT] });
  check('空任务被拒(返回 error)', !!emptyTask.body.error, JSON.stringify(emptyTask.body).slice(0, 120));
  const hugeTask = await req('POST', '/api/dispatch', { task: 'x'.repeat(60000), tools: [CLIENT] });
  check('超长任务被拒(>MAX_TASK_LENGTH)', /过长/.test(hugeTask.body.error || ''), JSON.stringify(hugeTask.body).slice(0, 120));
  // 防回归:非字符串 topic 必须 400 拒绝(修复前会落盘孤儿会议永久占用并发闸门)
  const badTopic = await req('POST', '/api/discuss', { topic: 12345 });
  check('非字符串 topic 被拒(400,不产生孤儿会议)', badTopic.status === 400 && !!badTopic.body.error, 'status=' + badTopic.status + ' ' + JSON.stringify(badTopic.body).slice(0, 100));
  // 畸形入参连环后,中枢必须仍存活(健壮性的核心承诺:不因单次请求崩溃)
  const aliveAfter = await req('GET', '/api/health');
  check('畸形入参后中枢仍存活(不崩溃)', aliveAfter.status === 200 && aliveAfter.body.status === 'ok', JSON.stringify(aliveAfter.body).slice(0, 120));

  // 15) 指挥链加固:结果过期分支(已注册客户端但无 pending 任务时上报结果)
  section('指挥链加固:结果过期分支 /api/result');
  const expired = await req('POST', '/api/result', { clientId: CLIENT, taskId: 'e2e-no-pending-task', content: '迟到的结果' });
  check('无 pending 时结果被拒(success=false)', expired.status === 200 && expired.body.success === false, JSON.stringify(expired.body).slice(0, 120));
  check('拒绝原因含“超时”', /超时/.test(expired.body.reason || ''), 'reason=' + expired.body.reason);
  const aliveExpired = await req('GET', '/api/health');
  check('过期结果上报后中枢仍存活', aliveExpired.status === 200 && aliveExpired.body.status === 'ok');

  // 16) 指挥链加固:RESULT_MAX_CHARS 默认截断(端到端:mock 客户端返回 5000 字符,中枢应截到 2000)
  //   说明:未注入 AI_BRIDGE_RESULT_MAX_CHARS 环境变量,故这里验证的是 CONFIG 默认值 2000 的真实截断行为
  section('指挥链加固:RESULT_MAX_CHARS 默认截断');
  const longDisp = await req('POST', '/api/dispatch', { task: '产出超长文本 LONGOUT_MARK', tools: [CLIENT] });
  check('长产出 dispatch 往返成功', longDisp.body.successCount === 1, JSON.stringify(longDisp.body).slice(0, 120));
  const longContent = longDisp.body.results?.[0]?.content || '';
  check('结果 content 截断到默认 RESULT_MAX_CHARS=2000', longContent.length === 2000, 'content.length=' + longContent.length);

  // 17) 失败判定器不得把"谈论失败"当失败,且失败不得销毁交付物(#37 指定红集)
  //   放在主流程最末:前面几段依赖 CLIENT 的路由评分与产出记录,本段会故意制造"被判失败"的执行,
  //   若插在智能路由段之前会污染其评分(实测曾级联弄坏 5 条路由断言——那是插桩位置错,非产品缺陷)。
  //   实况:生产联测里 atom-code 交回 3434 字审计报告、opencode 交回 5022 字,两次都被判 success=false。
  //   根因链:server.js:513-514 在"产出无代码块"时对文本做关键词**子串**匹配(词表含 429/401/402/
  //   额度/限额/quota/exceeded/rate limit),报告里引用行号 `server.js:398-401` 或写"永久 429"即命中;
  //   接着 :515 把 reason 截成 200 字,再经 server.js:877 的失败条目映射**整条 content 被丢弃**——
  //   调用方只能去翻 SQLite 才能捞回正文。空产出判失败(:510-512)是正确行为,必须原样保留。
  section('失败判定器与失败态内容保留:#37 红集');
  const rep = await req('POST', '/api/dispatch', { task: '请以纯文字审计报告形式作答 REPORT_MARK,不要写代码', tools: [CLIENT], auto_fallback: false });
  const repR = (rep.body.results || [])[0] || {};
  check('#37a 长文报告(无代码块,内含 429/401/额度 等字样)必须判成功',
    rep.body.successCount === 1 && repR.success === true, JSON.stringify({ sc: rep.body.successCount, s: repR.success, reason: (repR.reason || '').substring(0, 90) }));
  check('#37b 判成功的交付物正文完整(未被截断销毁)', typeof repR.content === 'string' && repR.content.length > 800, 'content长度=' + (repR.content || '').length);
  const errRun = await req('POST', '/api/dispatch', { task: '模拟真实额度失败 ERRORTEXT_MARK', tools: [CLIENT], auto_fallback: false });
  const errR = (errRun.body.results || [])[0] || {};
  check('#37c 真实错误短文本仍须判失败(不得为绕过误伤而放水)',
    errR.success === false && /exceeded|429|限额|额度|rate limit/i.test(errR.reason || ''), JSON.stringify({ s: errR.success, reason: (errR.reason || '').substring(0, 90) }));
  await sleep(500);
  const errTraf = await req('GET', '/api/traffic?tool=' + encodeURIComponent('client:' + CLIENT) + '&direction=in&limit=20');
  const errRow = (errTraf.body.traffic || []).find(t => (t.content || '').includes('Go usage limit exceeded'));
  check('#37d 同一执行的流量账本 success 必须与 dispatch 判定一致(现恒记 true)',
    !!errRow && errRow.success === false, errRow ? JSON.stringify({ success: errRow.success, len: (errRow.content || '').length }) : '未找到对应入向流量行');
  check('#37e 失败条目必须保留正文(可短于成功态上限,但不得为空)',
    typeof errR.content === 'string' && errR.content.includes('Go usage limit exceeded'), '失败态 content=' + JSON.stringify((errR.content || '').substring(0, 60)));

  // 9.13) 鉴权覆盖面:能执行/能烧配额的入口一律要凭据(#42 指定红集)
  //   实况(全部只读回源):门只在 server.js:1232 `if (p.startsWith('/api/') && !checkAuth(req))`,
  //   而 `/v1/chat/completions`(:1967)在"model=<工具名>"分支里直接 executeTool(:1995)——
  //   本机任意进程可零凭据触发真实工具执行并烧配额;GET /v1/models 同样零凭据可枚举工具与模型面。
  //   另一面:ui.html:318 的 api() 辅助函数完全不带 Authorization(全文件 grep 'Authorization' = 0),
  //   所以一旦设了 AI_BRIDGE_TOKEN,自己的 Web UI 会被 401 打死——"能锁"与"可用"互相牺牲,是同一个缺陷的两半。
  //   本段用带 token 的第二实例(端口 9830,数据/DB/工作区/观测目录四重隔离)取证:
  //   执行面必须挡住、哨兵面(首页/带凭据访问/健康检查)必须仍然可用。
  //   注意成本纪律:触发执行的断言一律用**不存在的 model 名**,保证红跑也不会真的调用任何模型。
  section('鉴权覆盖面:#42 红集(第二实例·带 token)');
  {
    const AUTH_PORT = 9830, AUTH_TOK = 'e2e-42-token';
    const authDir = path.join(TEST_RUNTIME, 'auth-probe');
    fs.mkdirSync(authDir, { recursive: true });
    const authProc = spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: { ...process.env, AI_BRIDGE_PORT: String(AUTH_PORT), AI_BRIDGE_HOST: HOST, AI_BRIDGE_DATA_DIR: authDir, AI_BRIDGE_DB: path.join(authDir, 'auth.db'), AI_BRIDGE_OBSERVE_DIR: path.join(authDir, 'observe'), AI_BRIDGE_WORKSPACE_ROOT: path.join(authDir, 'ws'), AI_BRIDGE_TOKEN: AUTH_TOK },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    authProc.stderr.on('data', () => {}); authProc.stdout.on('data', () => {});
    const reqAuth = (method, urlPath, body, withToken) => new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const headers = {};
      if (withToken) headers.Authorization = 'Bearer ' + AUTH_TOK;
      if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
      const r = http.request({ hostname: HOST, port: AUTH_PORT, path: urlPath, method, timeout: 15000, headers }, res => {
        let s = ''; res.on('data', c => s += c); res.on('end', () => resolve({ status: res.statusCode, text: s }));
      });
      r.on('timeout', () => { r.destroy(); reject(new Error('auth 请求超时')); });
      r.on('error', reject); if (data) r.write(data); r.end();
    });
    let authUp = false;
    for (let i = 0; i < 40 && !authUp; i++) { await sleep(400); try { const h = await reqAuth('GET', '/api/health', null, true); authUp = h.status === 200; } catch (_) {} }
    check('#42a0 带 token 的第二实例可启动且带凭据可访问(哨兵:防把门焊死后无从取证)', authUp, 'authUp=' + authUp);
    if (authUp) {
      const m1 = await reqAuth('GET', '/v1/models', null, false);
      check('#42a1 零凭据不得枚举 /v1/models(现状 200 全量泄露模型与工具面)', m1.status === 401, 'status=' + m1.status + ' body=' + m1.text.substring(0, 70));
      const m2 = await reqAuth('POST', '/v1/chat/completions', { model: 'e2e-42-nonexistent-model', messages: [{ role: 'user', content: 'x' }] }, false);
      check('#42a2 零凭据不得进入 /v1 执行路径(model=<工具名> 会直接 executeTool 烧配额)', m2.status === 401, 'status=' + m2.status + ' body=' + m2.text.substring(0, 70));
      const m3 = await reqAuth('GET', '/v1/models', null, true);
      check('#42a3 带正确 token 访问 /v1/models 必须仍可用(反代接入不能被本轮改坏)', m3.status === 200, 'status=' + m3.status);
      const m4 = await reqAuth('GET', '/', null, false);
      check('#42a4 Web UI 首页本身不得被锁死(锁的是数据面,不是让页面消失)', m4.status === 200 && /<html|<!DOCTYPE/i.test(m4.text), 'status=' + m4.status + ' len=' + m4.text.length);

      // #68:/api/health 在门之前处理(server.js:1185,比 :1248 的门早 63 行),原注释称"供守护进程探活"
      //   却无人使用 —— watchdog.js 靠子进程 exit 事件判活(全仓对 /api/health 引用数 = 0),
      //   唯一使用方是 edge-agent.js:186 的 bridge:health(它自带 AI_BRIDGE_TOKEN)。实测修复前无凭据可读
      //   version/clients/activeDispatches/dispatchTotal + codely.tokenDaysLeft + usage 汇总。
      //   裁定:同一端点按鉴权态给两种视图 —— 无凭据只留存活与负载计数(clients 保留,既有锁
      //   test-e2e.mjs:901 断言它必须是 number,不得为收窄而改锁);codely/usage 仅带凭据可见。
      //   **实测更正(我首版的两处口径错)**:① 我把 db.stats()(db.js:318 起,形状含 dbPath)与门后的
      //   /api/db/stats 路由的形状当成 health 的,health 从来没有 db 字段,本锁把 db 列入禁止项属纵深防御、当前恒不存在;
      //   (端点按路由名定位不写行号——本轮实现净增 13 行就让它从 :1502 下移到 :1515,写死行号必然漂)
      //   ② 我原写成"UI 依赖完整视图",经核 ui.html 全文对 /api/health 引用数 = 0(:546/:598/:664 的
      //   usage 是 dispatch 任务记录,不是 health),依赖方只有 edge-agent —— 断言名已照此改正。
      const hAnon = await reqAuth('GET', '/api/health', null, false);
      // 前置守卫:reqAuth 返回的是 text 而非 body,JSON 解析失败必须判红 —— 否则"没读到字段"
      //   会被当成"没外带字段"蒙成绿(我首版就犯了这个错,这里显式封死)。
      let hb = null, hbParsed = true;
      try { hb = JSON.parse(hAnon.text); } catch (_) { hb = null; hbParsed = false; }
      const hbObj = (hb && typeof hb === 'object') ? hb : {};
      const leaked = ['db', 'codely', 'usage'].filter(k => hbObj[k] !== undefined);
      check('#68a0 无凭据 /api/health 必须是可解析的 JSON 对象(解析失败不得当成"没外带")',
        hAnon.status === 200 && hbParsed && hb !== null && typeof hb === 'object', 'status=' + hAnon.status + ' parsed=' + hbParsed + ' text=' + String(hAnon.text).substring(0, 60));
      check('#68a1 无凭据 /api/health 不得外带 db 路径/codely token 期限/usage 汇总',
        hAnon.status === 200 && hbParsed && leaked.length === 0,
        'status=' + hAnon.status + ' 外带字段=[' + leaked.join(',') + '] keys=' + Object.keys(hbObj).join(','));
      check('#68a2 收窄只许留存活与负载计数(不得顺手把 clients 也删掉——既有锁 :901 依赖它)',
        hbObj.status === 'ok' && typeof hbObj.uptime === 'number' && typeof hbObj.clients === 'number'
        && typeof hbObj.activeDispatches === 'number' && hbObj.port === AUTH_PORT,
        JSON.stringify({ status: hbObj.status, clients: hbObj.clients, ad: hbObj.activeDispatches, port: hbObj.port }).substring(0, 160));
      const hFull = await reqAuth('GET', '/api/health', null, true);
      let fb = null, fbParsed = true;
      try { fb = JSON.parse(hFull.text); } catch (_) { fb = null; fbParsed = false; }
      fb = (fb && typeof fb === 'object') ? fb : {};
      check('#68a3 带凭据必须仍能看到完整视图(codely 到期信息与 usage 一处不少:全仓唯一使用方 edge-agent.js:186 的 bridge:health 依赖它)',
        hFull.status === 200 && fbParsed && fb.codely !== undefined && fb.usage !== undefined,
        'status=' + hFull.status + ' parsed=' + fbParsed + ' keys=' + Object.keys(fb).join(','));

      // #68b 锁定 ?probe=1 的鉴权前置。这条是我的红基线漏项(补锁):probe 分支会 await
      //   getCodelyCliApiKey() + requestCodelyLiteLLM('/v1/models') —— 零凭据也能驱使中枢带着
      //   **真实签名**去打签名上游,既是探测放大器也有成本,故"未鉴权不得触发上游"必须常驻可回归。
      //   成本纪律:只断言未鉴权侧(401 + 无 upstream);带凭据侧会真打上游,不锁进套件。
      const pAnon = await reqAuth('GET', '/api/health?probe=1', null, false);
      check('#68b1 无凭据 ?probe=1 必须 401 且响应不得含 upstream(未鉴权绝不允许驱使中枢带真实签名打上游)',
        pAnon.status === 401 && !/"upstream"\s*:/.test(pAnon.text),
        'status=' + pAnon.status + ' body=' + pAnon.text.substring(0, 80));
      // 结构守卫:光断言 401 挡不住"顺序被调换"的回归(先探测、后判权 → 401 仍会返回,但上游已被打过)。
      //   故直接锁源码顺序:health 处理器段内,判权 401 必须先于 getCodelyCliApiKey / requestCodelyLiteLLM。
      const hSrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
      const segStart = hSrc.indexOf("p === '/api/health'");
      // 必须先剥掉注释再取索引:注释里会正儿八经写出 getCodelyCliApiKey() 的名字,不剥就会
      //   在"注释排在判权之前"的正常代码上假红(我第一版就踩了这个坑)。
      //   切行按 /\r?\n/、剥注释用 [^\r\n] 而非 .*$:CRLF 文件里 `.` 不匹配 \r,写 /\/\/.*$/
      //   会整条失配(实测 replace 原样返回字符串),注释剥不净 → 守卫假红。此坑我踩过两次,记此防复发。
      const segRaw = hSrc.substring(segStart, segStart + 4000);
      const seg = segRaw.split(/\r?\n/).map(l => l.replace(/\/\/[^\r\n]*/, '')).join('\n');
      const iAuth = seg.indexOf('if (!authorized)');
      const iKey = seg.indexOf('getCodelyCliApiKey()');
      const iReq = seg.indexOf('requestCodelyLiteLLM(');
      check('#68b2 源码顺序守卫:health 段内判权 401 必须先于 getCodelyCliApiKey/requestCodelyLiteLLM(先探测后判权=放大器复活)',
        segStart !== -1 && iAuth !== -1 && iKey !== -1 && iReq !== -1 && iAuth < iKey && iAuth < iReq,
        'segStart=' + segStart + ' iAuth=' + iAuth + ' iKey=' + iKey + ' iReq=' + iReq);
    }
    try { authProc.stdin.end(); authProc.kill(); } catch { /* ignore */ }
    await sleep(400);
  }

  // 9.11) 写被拒却报成功(#43 指定红集 · 第四实例)
  //   store.saveSync 在 key 被隔离后返回 false,而写端点把这个布尔**整个丢弃**
  //   (server.js:1319 saveJSONSync 不返回值;workspace-manager.js:99 saveState 亦然),
  //   随后照样 sendJSON(200,{success:true})。
  //   探针实测现状(端口 9841、独立 DATA_DIR):预置解析失败的 switches.json → GET /api/tools
  //   触发隔离(switches.json 被改名 .corrupt-*)→ POST /api/toggle 返回 200
  //   {"success":true,"tool":"openclaw","enabled":false},而磁盘上 switches.json 并不存在
  //   ——调用方以为工具被关了,重启后全部回启(与 P0 同族:静默配置丢失 + 谎言式成功)。
  section('写被拒不得报成功:#43a 红集(第四实例·switches 已隔离)');
  {
    const RW_PORT = 9841;
    const rwDir = path.join(TEST_RUNTIME, 'refuse-write-probe');
    fs.rmSync(rwDir, { recursive: true, force: true });
    fs.mkdirSync(rwDir, { recursive: true });
    fs.writeFileSync(path.join(rwDir, 'switches.json'), '{"openclaw":tru', 'utf-8'); // 截断=解析失败→隔离
    const rwProc = spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: { ...process.env, AI_BRIDGE_PORT: String(RW_PORT), AI_BRIDGE_HOST: HOST, AI_BRIDGE_DATA_DIR: rwDir, AI_BRIDGE_DB: path.join(rwDir, 'rw.db'), AI_BRIDGE_OBSERVE_DIR: path.join(rwDir, 'observe'), AI_BRIDGE_WORKSPACE_ROOT: path.join(rwDir, 'ws'), AI_BRIDGE_TOKEN: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    rwProc.stderr.on('data', () => {}); rwProc.stdout.on('data', () => {});
    const rwReq = (method, urlPath, body) => new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const headers = {};
      if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
      const r = http.request({ hostname: HOST, port: RW_PORT, path: urlPath, method, timeout: 8000, headers }, res => {
        let s = ''; res.on('data', c => s += c); res.on('end', () => resolve({ status: res.statusCode, text: s }));
      });
      r.on('timeout', () => { r.destroy(); reject(new Error('rw 请求超时')); });
      r.on('error', reject); if (data) r.write(data); r.end();
    });
    let rwUp = false;
    for (let i = 0; i < 30 && !rwUp; i++) { await sleep(400); try { const h = await rwReq('GET', '/api/health', null); rwUp = h.status === 200; } catch (_) {} }
    check('#43a0 哨兵:坏 switches.json 不得阻止中枢起来(现状即绿,防把保守策略做成崩溃)', rwUp, 'rwUp=' + rwUp);
    if (rwUp) {
      await rwReq('GET', '/api/tools', null); // 首次读取即触发 quarantine
      const tg = await rwReq('POST', '/api/toggle', { tool: 'openclaw', enabled: false });
      let tgb = null; try { tgb = JSON.parse(tg.text); } catch (_) {}
      check('#43a1 写被拒期间 /api/toggle 不得回 2xx,响应体也不得宣称 success:true(现状 200+success:true 而磁盘无 switches.json)',
        tg.status >= 400 && !(tgb && tgb.success === true),
        'status=' + tg.status + ' body=' + tg.text.substring(0, 110));
      check('#43a2 哨兵:拒写期间不得凭空写出 switches.json(现状即绿;防"为让 a1 变绿而随便造文件")',
        !fs.existsSync(path.join(rwDir, 'switches.json')), fs.readdirSync(rwDir).join(','));
      const wsOk = await rwReq('POST', '/api/workspaces', { name: 'rw-healthy', description: '#43a3 未隔离 key 必须照写' });
      const wsPersisted = (() => { try { const j = JSON.parse(fs.readFileSync(path.join(rwDir, 'workspaces.json'), 'utf-8')); return Array.isArray(j.workspaces) && j.workspaces.length > 0; } catch (_) { return false; } })();
      check('#43a3 哨兵:同实例上未被隔离的写入必须照常 2xx 且真的落盘(防"一律拒写"这种偷懒实现)',
        wsOk.status >= 200 && wsOk.status < 300 && wsPersisted,
        'status=' + wsOk.status + ' 落盘=' + wsPersisted + ' body=' + wsOk.text.substring(0, 90));
    }
    try { rwProc.stdin.end(); rwProc.kill(); } catch { /* ignore */ }
    await sleep(300);
  }

  // 9.12) 点名派发中被跳过的目标必须诚实呈现(#36 指定红集)
  //   实况:targets 只收"可解析且已启用"的工具(server.js:765-770),而"可解析但被禁用"的落进
  //   skipped(:804-807)。响应的 total = targets.length(:973)→ 被跳过者**不进分母**。
  //   于是点名 2 个只跑 1 个时,桥侧汇总行仍是「1/1 成功」(bridge-stdio.js:317),真实情况只在
  //   其后一行小字「⚠️ 跳过(关闭): …」(:318)——宿主模型读到的显著信号是那个撒谎的分母。
  //   且 skipped 只有裸名字,没有原因(是被关掉?还是没资格?),与 #50 已根治的 no_targets 归因
  //   形成双重标准。本段锁三件事:请求数可见、被跳过者带原因、分母不再掩盖。
  //   放在套件最末:此处 CLI 工具已被智能路由段禁用,天然是"可解析但被禁用"的来源;且禁用态
  //   由本段自己显式设定并逐字复位,不依赖前一段的副作用(上一格 #37 因插入位置污染过路由评分,
  //   教训在前)。
  section('被跳过的点名目标必须诚实呈现:#36 红集');
  {
    const allTools36 = (await req('GET', '/api/tools')).body.tools || [];
    // 选一个"检测得到、但可被禁用"的 CLI 工具作为被跳过者(不硬编码名字,防工具清单变动后失真)
    const cliCand = allTools36.find(t => t.type !== 'client' && t.name !== CLIENT && t.name !== REVIEWER && t.available);
    check('#36a0 存在可解析的 CLI 工具作为被跳过样本(否则本段无从取证)', !!cliCand, JSON.stringify(cliCand && { name: cliCand.name, enabled: cliCand.enabled }));
    if (cliCand) {
      const wasEnabled = cliCand.enabled !== false;
      try {
        await req('POST', '/api/toggle', { tool: cliCand.name, enabled: false });
        const d36 = await req('POST', '/api/dispatch', { task: '#36 点名两个:一个可跑一个已禁用 SKIP_36_MARK', tools: [CLIENT, cliCand.name], auto_fallback: false });
        const b36 = d36.body || {};
        check('#36a1 响应必须带点名总数 requested(=2),且 total 仍为实际被调度数(=1)',
          b36.requested === 2 && b36.total === 1, JSON.stringify({ requested: b36.requested, total: b36.total, successCount: b36.successCount }).substring(0, 180));
        const sk = b36.skipped || [];
        check('#36a2 skipped 必须是带原因的结构(被禁用者要点名"禁用",不得只留裸名字)',
          sk.length === 1 && sk[0] && typeof sk[0] === 'object' && sk[0].ref === cliCand.name && /禁用/.test(String(sk[0].reason || '')),
          JSON.stringify(sk).substring(0, 200));
        check('#36a3 被跳过者不得混进成功分母:实际执行数必须是 1 且跳过者无执行结果',
          b36.successCount === 1 && (b36.results || []).length === 1 && !(b36.results || []).some(r => r.tool === cliCand.name),
          JSON.stringify({ successCount: b36.successCount, results: (b36.results || []).map(r => r.tool) }).substring(0, 180));
      } finally {
        // 逐字复位,不给后续任何段落留副作用(本段虽在最末,复位纪律不变)
        if (wasEnabled) await req('POST', '/api/toggle', { tool: cliCand.name, enabled: true }).catch(() => {});
      }
    }
  }
}

async function cleanup () {
  try { if (bridgeProc) { bridgeProc.stdin.end(); bridgeProc.kill(); } } catch { /* ignore */ }
  try { if (reviewerProc) { reviewerProc.stdin.end(); reviewerProc.kill(); } } catch { /* ignore */ }
  try { if (conflictProc) { conflictProc.stdin.end(); conflictProc.kill(); } } catch { /* ignore */ }
  try { if (serverProc) serverProc.kill(); } catch { /* ignore */ }
  await sleep(500);
  // JSON/SQLite/观测数据全部位于测试运行目录，一次清理即可，不触碰任何生产文件。
  try { fs.rmSync(TEST_RUNTIME, { recursive: true, force: true }); } catch { /* ignore */ }
}

main()
  .catch(e => { failed++; failures.push('主流程异常'); process.stdout.write(`\n💥 主流程异常: ${e.message}\n`); if (serverErr) process.stdout.write(`server stderr:\n${serverErr.slice(0, 500)}\n`); })
  .finally(async () => {
    await cleanup();
    process.stdout.write('\n' + '='.repeat(40) + '\n');
    process.stdout.write(`总计: ${passed}/${passed + failed} 通过\n`);
    if (failed > 0) process.stdout.write(`失败用例: ${failures.join(', ')}\n`);
    process.stdout.write('测试运行目录已清理，生产数据未改写。\n');
    process.exit(failed > 0 ? 1 : 0);
  });
