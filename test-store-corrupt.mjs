#!/usr/bin/env node
'use strict';

/**
 * P0 静默清库对抗测试(隔离临时目录,无网络,指挥官亲笔 —— 锁定文件,编码手禁改)
 *
 * 针对的真实缺陷(两路独立审计收敛确认):
 *   store.js load()/loadList() 用 catch(_) 吞掉 JSON.parse 失败返回 {}/[]，
 *   而 loadMemory()(store.js:205-214)/loadACL()(store.js:421-427) 把缺字段补成"合法空结构"，
 *   随后 saveSync(store.js:53-58/76-78) 无条件 tmp+rename 覆写 —— 一次文件损坏或手改坏
 *   就会把任务历史洗成只剩 1 条、把 clients-acl.json 的 blocklist 清空(准入控制静默失效)。
 *
 * 契约(P0 要求):
 *   C1 解析失败 → 原坏文件必须被改名保全为 <file>.corrupt-<...>，不得被空结构覆写；
 *   C2 该 key 进入脏状态：本进程内后续对该 key 的写一律拒绝(返回 false)，不落新文件；
 *   C3 拒绝/备份必须有 error 级日志留痕(logs.jsonl 可见)；
 *   C4 可用性不塌：load 仍返回空结构(调用方不得因此抛错/500)；
 *   C5 不得永久瘫：坏文件已被移走后，新进程(脏标志随之消失)必须能正常写新文件；
 *   C6 正常路径(文件不存在)绝不产生 .corrupt- 产物，且写入照常成功。
 *
 * 运行:node test-store-corrupt.mjs   退出码:0 全通过 / 1 有失败
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(__dirname, 'store.js');
const TMP = path.join(os.tmpdir(), `ai-bridge-corrupt-test-${process.pid}-${Date.now()}`);
fs.mkdirSync(TMP, { recursive: true });

let passed = 0;
let failed = 0;
const failures = [];
function check (name, cond, detail) {
  if (cond) { passed++; process.stdout.write(`  [PASS] ${name}\n`); }
  else { failed++; failures.push(name); process.stdout.write(`  [FAIL] ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).substring(0, 300) : ''}\n`); }
}
function section (t) { process.stdout.write(`\n── ${t} ──\n`); }

// 场景执行器：每个场景用独立 DATA_DIR + 独立 node 进程(store.js 在加载时解析数据目录，
// 且脏标志是进程内状态，只有新进程才能代表"重启后"的语义)
const RUNNER = path.join(TMP, 'runner.cjs');
fs.writeFileSync(RUNNER, `'use strict';
const fs = require('fs');
const path = require('path');
const store = require(${JSON.stringify(STORE)});
const scenario = process.argv[2];
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');

if (scenario === 'normal') {
  const before = store.load('memory');
  const wrote = store.saveSync('memory', { tasks: [{ id: 'x1' }], experiences: [], preferences: {}, meetings: [] });
  out({ before, wrote, file: fs.existsSync(store.FILES ? store.FILES.memory : path.join(process.env.AI_BRIDGE_DATA_DIR, 'memory.json')), dir: fs.readdirSync(process.env.AI_BRIDGE_DATA_DIR) });
} else if (scenario === 'memory') {
  const mem = store.loadMemory();
  const wrote = store.recordTask({ id: 't-new', task: '新任务', tools: ['a'], results: [], successCount: 1, totalTokens: 10 });
  const wrote2 = store.saveSync('memory', { tasks: [], experiences: [], preferences: {}, meetings: [] });
  out({ memTasks: (mem.tasks || []).length, wrote, wrote2, dir: fs.readdirSync(process.env.AI_BRIDGE_DATA_DIR) });
} else if (scenario === 'acl') {
  const acl = store.loadACL();
  const wrote = store.saveACL({ allowlist: [], blocklist: [], pending: [] });
  out({ blocklistNow: acl.blocklist, allowlistNow: acl.allowlist, wrote, dir: fs.readdirSync(process.env.AI_BRIDGE_DATA_DIR) });
} else if (scenario === 'sticky') {
  store.loadMemory();
  const r = [store.saveSync('memory', { tasks: [] }), store.saveSync('memory', { tasks: [] }), store.saveSync('memory', { tasks: [] })];
  out({ r, dir: fs.readdirSync(process.env.AI_BRIDGE_DATA_DIR) });
} else if (scenario === 'switches') {
  const sw = store.load('switches');
  const wrote = store.saveSync('switches', {});
  out({ swEmpty: Object.keys(sw).length === 0, wrote, dir: fs.readdirSync(process.env.AI_BRIDGE_DATA_DIR) });
} else {
  process.exitCode = 3;
  out({ error: 'unknown scenario ' + scenario });
}
`);

function runScenario (name, scenario, seed) {
  const dataDir = path.join(TMP, `data-${name}-${Date.now()}`);
  fs.mkdirSync(dataDir, { recursive: true });
  if (seed) for (const [f, content] of Object.entries(seed)) fs.writeFileSync(path.join(dataDir, f), content, 'utf-8');
  const r = spawnSync(process.execPath, [RUNNER, scenario], {
    env: { ...process.env, AI_BRIDGE_DATA_DIR: dataDir, AI_BRIDGE_TOKEN: '' },
    encoding: 'utf-8', timeout: 20000
  });
  let parsed = null;
  try { parsed = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { /* 交给断言判失败 */ }
  return { parsed, stdout: r.stdout || '', stderr: r.stderr || '', status: r.status, dataDir };
}

const TRUNC_MEMORY = '{"tasks":[{"id":"hist-1","task":"历史任务A"},{"id":"hist-2"}';
const TRUNC_ACL = '{"allowlist":["good-client"],"blocklist":["bad-client"]';
const TRUNC_SWITCHES = '{"opencode":false,"atom-code":false';

const corrupt = (dir) => (dir || []).filter(f => /\.corrupt-/.test(f));
const readBackup = (res, match) => {
  const f = corrupt(res.parsed && res.parsed.dir).find(x => x.startsWith(match));
  if (!f) return null;
  try { return fs.readFileSync(path.join(res.dataDir, f), 'utf-8'); } catch { return null; }
};

process.stdout.write('ai-bridge P0 静默清库对抗测试\n' + '='.repeat(40) + '\n');

section('C6 正常路径:文件不存在不得产生 corrupt 产物,写入照常成功');
const norm = runScenario('normal', 'normal');
check('正常 load 返回空结构且不抛错', norm.parsed && typeof norm.parsed.before === 'object', norm.stdout + norm.stderr);
check('正常 saveSync 落盘成功', norm.parsed && norm.parsed.wrote !== false && norm.parsed.file === true, norm.parsed && norm.parsed.dir);
check('正常路径不得出现 .corrupt- 产物', norm.parsed && corrupt(norm.parsed.dir).length === 0, norm.parsed && norm.parsed.dir);

section('C1/C2/C4 损坏 memory.json:保全 + 拒绝覆写 + 仍可用');
const mem = runScenario('memory', 'memory', { 'memory.json': TRUNC_MEMORY });
check('loadMemory 不抛错且返回空 tasks(可用性保住)', mem.parsed && mem.parsed.memTasks === 0, mem.parsed || mem.stderr);
check('生成 memory.json.corrupt-* 备份', mem.parsed && corrupt(mem.parsed.dir).some(f => f.startsWith('memory.json.corrupt-')), mem.parsed && mem.parsed.dir);
check('备份内容保全原始字节(可人工恢复)', readBackup(mem, 'memory.json.corrupt-') === TRUNC_MEMORY, readBackup(mem, 'memory.json.corrupt-'));
check('recordTask/saveSync 被拒绝(返回 false)', mem.parsed && mem.parsed.wrote === false && mem.parsed.wrote2 === false, mem.parsed && { wrote: mem.parsed.wrote, wrote2: mem.parsed.wrote2 });
check('拒绝期间不得凭空写出 memory.json', mem.parsed && !mem.parsed.dir.includes('memory.json'), mem.parsed && mem.parsed.dir);

section('C1/C2 损坏 clients-acl.json:拉黑记录不得被洗掉');
const acl = runScenario('acl', 'acl', { 'clients-acl.json': TRUNC_ACL });
check('loadACL 不抛错(空结构继续可用)', acl.parsed && Array.isArray(acl.parsed.blocklistNow) && acl.parsed.blocklistNow.length === 0, acl.parsed || acl.stderr);
check('生成 clients-acl.json.corrupt-* 备份', acl.parsed && corrupt(acl.parsed.dir).some(f => f.startsWith('clients-acl.json.corrupt-')), acl.parsed && acl.parsed.dir);
check('备份里仍能取回原 blocklist(含 bad-client)', (readBackup(acl, 'clients-acl.json.corrupt-') || '').includes('bad-client'), readBackup(acl, 'clients-acl.json.corrupt-'));
check('saveACL 空结构被拒绝(准入边界不得被静默重写)', acl.parsed && acl.parsed.wrote === false, acl.parsed && { wrote: acl.parsed.wrote });
check('拒绝期间不得写出新的 clients-acl.json', acl.parsed && !acl.parsed.dir.includes('clients-acl.json'), acl.parsed && acl.parsed.dir);

section('C2 脏标志粘性:同进程内多次写全部拒绝');
const sticky = runScenario('sticky', 'sticky', { 'memory.json': TRUNC_MEMORY });
check('连续 3 次 saveSync 全部拒绝', sticky.parsed && sticky.parsed.r.every(x => x === false), sticky.parsed && sticky.parsed.r);

section('C1/C2/C4 损坏 switches.json:开关状态不得被空对象持久化');
const sw = runScenario('switches', 'switches', { 'switches.json': TRUNC_SWITCHES });
check('load(switches) 返回空对象(不因损坏抛错)', sw.parsed && sw.parsed.swEmpty === true, sw.parsed || sw.stderr);
check('saveSync(switches) 被拒绝(防"全部默认启用"落盘)', sw.parsed && sw.parsed.wrote === false, sw.parsed && { wrote: sw.parsed.wrote });
check('switches 损坏也产生备份', sw.parsed && corrupt(sw.parsed.dir).some(f => f.startsWith('switches.json.corrupt-')), sw.parsed && sw.parsed.dir);

section('C5 不得永久瘫:坏文件移走后,新进程可正常写');
const restartDir = path.join(TMP, 'restart-probe');
fs.mkdirSync(restartDir, { recursive: true });
fs.writeFileSync(path.join(restartDir, 'memory.json'), TRUNC_MEMORY, 'utf-8');
const first = spawnSync(process.execPath, [RUNNER, 'memory'], { env: { ...process.env, AI_BRIDGE_DATA_DIR: restartDir }, encoding: 'utf-8', timeout: 20000 });
const firstParsed = JSON.parse((first.stdout || '').trim().split('\n').pop() || '{}');
const second = spawnSync(process.execPath, [RUNNER, 'normal'], { env: { ...process.env, AI_BRIDGE_DATA_DIR: restartDir }, encoding: 'utf-8', timeout: 20000 });
const secondParsed = JSON.parse((second.stdout || '').trim().split('\n').pop() || '{}');
check('首轮:损坏被保全且拒绝覆写', corrupt(firstParsed.dir || []).length >= 1 && firstParsed.wrote === false, firstParsed);
check('重启后(坏文件已移走)写入恢复正常', secondParsed.wrote !== false && secondParsed.file === true, secondParsed);

section('C3 留痕:损坏与拒绝必须进 error 级日志');
const allLogs = fs.readdirSync(mem.dataDir).filter(f => /logs\.jsonl/.test(f));
const logsText = allLogs.map(f => fs.readFileSync(path.join(mem.dataDir, f), 'utf-8')).join('\n');
check('logs.jsonl 有损坏/拒绝的 error 级留痕', /"level":"error"/.test(logsText) && /(损坏|corrupt|拒绝|覆写)/.test(logsText), logsText.split('\n').filter(Boolean).slice(-3));

process.stdout.write('\n' + '='.repeat(40) + '\n');
process.stdout.write(`总计: ${passed}/${passed + failed} 通过\n`);
if (failed) process.stdout.write('失败项: ' + failures.join(', ') + '\n');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failed ? 1 : 0);
