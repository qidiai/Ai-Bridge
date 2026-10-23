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
 *   C7 (#44) 「能解析但形状非法」与「解析失败」同口径:容器/字段/顶层三种类型错都算损坏
 *      —— 不得"补成合法空结构"后覆写原文件,必须保全 + 置脏 + 拒写 + 不抛错。
 *      (#52 只给了 meetings 一个点的守卫,本契约要的是同一把尺子量所有形状非法。)
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
} else if (scenario === 'shapememory') {
  // #52 回归场景:meetings 是合法 JSON 但形状错(对象)——启动清扫不得抛错
  let threw = null, swept = null;
  try { swept = store.markOrphanMeetings(); } catch (e) { threw = e.message; }
  const wrote = store.saveSync('memory', { tasks: [] });
  out({ threw, sweptLen: Array.isArray(swept) ? swept.length : -1, wrote, dir: fs.readdirSync(process.env.AI_BRIDGE_DATA_DIR) });
} else if (scenario === 'sticky') {
  store.loadMemory();
  const r = [store.saveSync('memory', { tasks: [] }), store.saveSync('memory', { tasks: [] }), store.saveSync('memory', { tasks: [] })];
  out({ r, dir: fs.readdirSync(process.env.AI_BRIDGE_DATA_DIR) });
} else if (scenario === 'switches') {
  const sw = store.load('switches');
  const wrote = store.saveSync('switches', {});
  out({ swEmpty: Object.keys(sw).length === 0, wrote, dir: fs.readdirSync(process.env.AI_BRIDGE_DATA_DIR) });
} else if (scenario === 'shape44aclfield') {
  // #44:合法 JSON 但字段形状非法(acl.blocklist 是对象)——今天会被"补成合法空结构"后覆写
  let threw = null, aclShape = null;
  try { const a = store.loadACL(); aclShape = { blocklistIsArray: Array.isArray(a.blocklist), allowlistNow: a.allowlist }; } catch (e) { threw = e.message; }
  const wrote = store.saveACL({ allowlist: ['x'], blocklist: [], pending: [] });
  out({ threw, aclShape, wrote, dir: fs.readdirSync(process.env.AI_BRIDGE_DATA_DIR) });
} else if (scenario === 'shape44tasks') {
  // #44:memory.tasks 是对象而非数组——recordTask 里 mem.tasks.unshift 是方法调用
  let threw = null;
  try { store.loadMemory(); } catch (e) { threw = 'load:' + e.message; }
  let wrote = null;
  try { wrote = store.recordTask({ id: 't', task: 'x', tools: ['a'], results: [], successCount: 0, totalTokens: 0 }); } catch (e) { threw = (threw || '') + ' recordTask:' + e.message; }
  out({ threw, wrote, dir: fs.readdirSync(process.env.AI_BRIDGE_DATA_DIR) });
} else if (scenario === 'shape44acltop') {
  // #44:acl 顶层是 null(能解析)——loadACL 直接读 acl.allowlist
  let threw = null;
  try { store.loadACL(); } catch (e) { threw = e.message; }
  let wrote = null;
  try { wrote = store.saveACL({ allowlist: [], blocklist: [], pending: [] }); } catch (e) { threw = (threw || '') + ' save:' + e.message; }
  out({ threw, wrote, dir: fs.readdirSync(process.env.AI_BRIDGE_DATA_DIR) });
} else if (scenario === 'shape44memstr') {
  // #44:memory 顶层是字符串(能解析)——补字段是往 primitive 上赋值(sloppy 模式静默丢弃)
  let mem = null;
  try { mem = store.loadMemory(); } catch (e) { return out({ threw: e.message, dir: fs.readdirSync(process.env.AI_BRIDGE_DATA_DIR) }); }
  const wrote = store.saveSync('memory', mem);
  out({ threw: null, memType: typeof mem, wrote, dir: fs.readdirSync(process.env.AI_BRIDGE_DATA_DIR) });
} else if (scenario === 'shape44legal') {
  // 哨兵:形状完全合法的文件必须照旧可写(守卫不得把正常路径一起拒掉)
  const wrote = store.saveACL({ allowlist: ['a'], blocklist: ['b'], pending: [] });
  out({ wrote, dir: fs.readdirSync(process.env.AI_BRIDGE_DATA_DIR) });
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

section('#52 坏形状 meetings 不得让启动清扫抛错(指挥官回归修复)');
const shape = runScenario('shape', 'shapememory', { 'memory.json': JSON.stringify({ tasks: [], experiences: [], preferences: {}, meetings: { bad: { status: 'discussing' } } }) });
check('#52a1 markOrphanMeetings 遇 meetings=对象 不得抛错', shape.parsed && shape.parsed.threw === null, shape.parsed && shape.parsed.threw);
check('#52a2 返回空清扫列表(跳过而非崩溃)', shape.parsed && shape.parsed.sweptLen === 0, shape.parsed && { sweptLen: shape.parsed.sweptLen });
check('#52a3 形状异常同样按损坏保全(生成 .corrupt- 且拒绝覆写)',
  shape.parsed && shape.parsed.wrote === false && corrupt(shape.parsed.dir).some(f => f.startsWith('memory.json.corrupt-')),
  shape.parsed && shape.parsed.dir);

section('#44 合法 JSON 但形状非法:必须与"解析失败"同口径(C7),不得补成空结构后覆写');
// 三种真实形态(每种都先用探针取过现状,红集按实测写):
//   ① 字段类型错(acl.blocklist 是对象)——现状:补成 [] 后 saveACL **成功覆写**,原 blocklist 蒸发
//   ② 容器类型错(memory.tasks 是对象)——现状:recordTask 内 mem.tasks.unshift **抛 TypeError**
//   ③ 顶层类型错(acl 是 null / 数组;memory 是字符串)——现状:null 抛 TypeError,其余静默放行
const SHAPE_ACL_FIELD = JSON.stringify({ allowlist: ['real-client'], blocklist: { evil: 1 }, pending: [] });
const SHAPE_MEM_TASKS = JSON.stringify({ tasks: { '0': { id: 'hist-1' } }, experiences: [], preferences: {}, meetings: [] });
const SHAPE_ACL_NULL = 'null';
const SHAPE_ACL_ARRAY = JSON.stringify(['good-client', 'another']);
const SHAPE_MEM_STRING = JSON.stringify('just a string');

const s44acl = runScenario('s44aclfield', 'shape44aclfield', { 'clients-acl.json': SHAPE_ACL_FIELD });
check('#44a1 loadACL 遇 blocklist 非数组不得抛错(可用性必须保住)',
  s44acl.parsed && s44acl.parsed.threw === null, s44acl.parsed && s44acl.parsed.threw);
check('#44a2 saveACL 必须被拒绝(现状 wrote=true:把坏形状"修好"就顺手覆写了真数据)',
  s44acl.parsed && s44acl.parsed.wrote === false, s44acl.parsed && { wrote: s44acl.parsed.wrote });
check('#44a3 必须保全 clients-acl.json.corrupt-*(现状 0 个保全产物,坏文件被就地洗白)',
  s44acl.parsed && corrupt(s44acl.parsed.dir).some(f => f.startsWith('clients-acl.json.corrupt-')), s44acl.parsed && s44acl.parsed.dir);
check('#44a4 原 allowlist 必须还能从保全件里取回(real-client 不得蒸发)',
  (readBackup(s44acl, 'clients-acl.json.corrupt-') || '').includes('real-client'), readBackup(s44acl, 'clients-acl.json.corrupt-'));

const s44tasks = runScenario('s44tasks', 'shape44tasks', { 'memory.json': SHAPE_MEM_TASKS });
check('#44b1 recordTask 遇 tasks 非数组不得抛 TypeError(现状直接炸调用方)',
  s44tasks.parsed && s44tasks.parsed.threw === null, s44tasks.parsed && s44tasks.parsed.threw);
check('#44b2 recordTask 必须返回 false 而非落盘',
  s44tasks.parsed && s44tasks.parsed.wrote === false, s44tasks.parsed && { wrote: s44tasks.parsed.wrote });
check('#44b3 必须保全 memory.json.corrupt-*',
  s44tasks.parsed && corrupt(s44tasks.parsed.dir).some(f => f.startsWith('memory.json.corrupt-')), s44tasks.parsed && s44tasks.parsed.dir);

const s44null = runScenario('s44aclnull', 'shape44acltop', { 'clients-acl.json': SHAPE_ACL_NULL });
check('#44c1 acl 顶层为 null 时 loadACL 不得抛(现状 "Cannot read properties of null")',
  s44null.parsed && s44null.parsed.threw === null, s44null.parsed && s44null.parsed.threw);
check('#44c2 顶层 null 同样须拒绝覆写并保全',
  s44null.parsed && s44null.parsed.wrote === false && corrupt(s44null.parsed.dir).some(f => f.startsWith('clients-acl.json.corrupt-')),
  s44null.parsed && { wrote: s44null.parsed.wrote, dir: s44null.parsed.dir });

const s44arr = runScenario('s44aclarray', 'shape44acltop', { 'clients-acl.json': SHAPE_ACL_ARRAY });
check('#44d1 acl 顶层为数组(形状非法但可解析)须被拒写并保全,不得静默改写为对象',
  s44arr.parsed && s44arr.parsed.wrote === false && corrupt(s44arr.parsed.dir).some(f => f.startsWith('clients-acl.json.corrupt-')),
  s44arr.parsed && { wrote: s44arr.parsed.wrote, dir: s44arr.parsed.dir });

const s44mem = runScenario('s44memstr', 'shape44memstr', { 'memory.json': SHAPE_MEM_STRING });
check('#44e1 memory 顶层为字符串时 loadMemory 不得抛错',
  s44mem.parsed && (s44mem.parsed.threw === null || s44mem.parsed.threw === undefined), s44mem.parsed && s44mem.parsed.threw);
check('#44e2 顶层字符串同样须拒写 + 保全(现状:往 primitive 补字段被静默丢弃,守卫完全没生效)',
  s44mem.parsed && s44mem.parsed.wrote === false && corrupt(s44mem.parsed.dir).some(f => f.startsWith('memory.json.corrupt-')),
  s44mem.parsed && { wrote: s44mem.parsed.wrote, dir: s44mem.parsed.dir });

// 哨兵(现状即绿,不是红集):守卫不得把合法路径一起拒掉,也不得凭空产生保全产物
const s44ok = runScenario('s44legal', 'shape44legal', { 'clients-acl.json': JSON.stringify({ allowlist: ['a'], blocklist: ['b'], pending: [] }) });
check('#44s1 形状合法的 acl 必须照旧可写(不为过锁而放宽守卫/不为守卫而误拒)',
  s44ok.parsed && s44ok.parsed.wrote !== false, s44ok.parsed && { wrote: s44ok.parsed.wrote });
check('#44s2 合法路径不得出现 .corrupt- 产物', s44ok.parsed && corrupt(s44ok.parsed.dir).length === 0, s44ok.parsed && s44ok.parsed.dir);

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

section('#46 tools.json 损坏不得让进程起不来(与 P0 同尺,但配置原件不许被自动改动)');
// 现状实测(把 tool-registry.js / kimi-models.js / adapters/{base,cli-adapter,http-adapter}.js 复制进
// 临时目录当配置根,逐种顶层形状试):截断→ SyntaxError;`null`/`42` → TypeError: configs is not iterable;
// `"a string"` → 不抛但**静默 0 工具、零留痕**;`[]` → 0 工具(合法)。
// loadTools()(tool-registry.js:70-81)把 JSON.parse 放在 try 之外,而 `const TOOLS = loadTools()`(:84)
// 在模块加载期执行 → server.js:16 一 require 就崩,watchdog 会重启到熔断。同一套哲学(store P0/#52/#44)
// 对数据文件早就"降级不崩",配置文件却是双重标准。
// 与数据文件的关键差别:tools.json 是 **git 跟踪的配置原件**,自动改名/隔离它(P0 对数据做的动作)
// 在这里是过度干预 —— 本段用 #46a5 把"原件必须原样在、字节不变"锁住,防止照搬隔离动作。
{
  const regRunner = path.join(TMP, 'registry-runner.cjs');
  fs.writeFileSync(regRunner, `'use strict';
const path = require('path');
const dir = process.argv[2];
let reg = null, threw = null;
try { reg = require(path.join(dir, 'tool-registry.js')); }
catch (e) { threw = { name: e.constructor.name, msg: String(e.message || e).substring(0, 140) }; }
let diag = null;
if (reg && typeof reg.getLoadDiagnostics === 'function') {
  try { diag = reg.getLoadDiagnostics(); } catch (_) { diag = null; }
}
const out = {
  threw,
  hasDiagFn: !!(reg && typeof reg.getLoadDiagnostics === 'function'),
  diag: diag || null,
  tools: (reg && Array.isArray(reg.TOOLS)) ? reg.TOOLS.map(t => t.name) : null
};
process.stdout.write(JSON.stringify(out) + '\\n');
process.exit(0);
`, 'utf-8');

  function runRegistryCase (name, toolsContent) {
    const dir = path.join(TMP, `reg-${name}`);
    fs.mkdirSync(path.join(dir, 'adapters'), { recursive: true });
    for (const f of ['tool-registry.js', 'kimi-models.js']) fs.copyFileSync(path.join(__dirname, f), path.join(dir, f));
    for (const f of ['base.js', 'cli-adapter.js', 'http-adapter.js']) fs.copyFileSync(path.join(__dirname, 'adapters', f), path.join(dir, 'adapters', f));
    if (toolsContent !== null) fs.writeFileSync(path.join(dir, 'tools.json'), toolsContent, 'utf-8');
    const r = spawnSync(process.execPath, [regRunner, dir], {
      env: { ...process.env, AI_BRIDGE_DATA_DIR: dir, AI_BRIDGE_TOKEN: '' },
      encoding: 'utf-8', timeout: 20000
    });
    let parsed = null;
    try { parsed = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { /* 交给断言判失败 */ }
    return { dir, parsed, stderr: r.stderr || '' };
  }

  const TRUNC_TOOLS = '[{"name":"ok-tool","transport":"cli"},{"id":';
  const cTrunc = runRegistryCase('trunc', TRUNC_TOOLS);
  check('#46a1 截断的 tools.json 不得抛(现状 SyntaxError: Unexpected end of JSON input;模块抛=进程起不来)',
    cTrunc.parsed && cTrunc.parsed.threw === null, cTrunc.parsed && cTrunc.parsed.threw);
  const cNull = runRegistryCase('nulltop', 'null');
  check('#46a2 顶层为 null 不得抛(现状 TypeError: configs is not iterable)',
    cNull.parsed && cNull.parsed.threw === null, cNull.parsed && cNull.parsed.threw);
  const cStr = runRegistryCase('strtop', JSON.stringify('a string'));
  check('#46a3 顶层为字符串:不抛 **且必须留下形状诊断**(现状静默 0 工具、零留痕 = 运维无从知道配置被忽略)',
    cStr.parsed && cStr.parsed.threw === null && cStr.parsed.hasDiagFn
    && cStr.parsed.diag && /corrupt-shape/.test(String(cStr.parsed.diag.status)),
    cStr.parsed && JSON.stringify({ threw: cStr.parsed.threw, hasDiagFn: cStr.parsed.hasDiagFn, diag: cStr.parsed.diag }));
  const st = cTrunc.parsed && cTrunc.parsed.threw === null
    ? (() => { try { return fs.readFileSync(path.join(cTrunc.dir, 'tools.json'), 'utf-8'); } catch (e) { return '读取失败:' + e.message; } })()
    : null;
  check('#46a5 反向锁:损坏的配置原件必须原样在、字节不变(不得改名/删除/覆写——P0 那套隔离是给运行数据的,配置原件被服务进程动过才是更大的意外)',
    st === TRUNC_TOOLS, typeof st === 'string' && st !== TRUNC_TOOLS ? st.substring(0, 80) : cTrunc.parsed && cTrunc.parsed.threw);
  const HEALTHY = JSON.stringify([{ name: 'probe-tool-ok', transport: 'cli', command: 'node', args: ['-e', '0'] }]);
  const cOk = runRegistryCase('healthy', HEALTHY);
  check('#46a6 哨兵:合法数组必须照旧全量加载(防"一律忽略配置"式假修复)',
    cOk.parsed && cOk.parsed.threw === null && Array.isArray(cOk.parsed.tools) && cOk.parsed.tools.includes('probe-tool-ok'),
    cOk.parsed && JSON.stringify({ threw: cOk.parsed.threw, tools: cOk.parsed.tools }));
  // #46a4 结构锁:留痕必须进可查账本(logs.jsonl),且不得为此给 tool-registry 新增 store 依赖
  //   (bridge-stdio.js:12 也 require tool-registry —— 一旦它依赖 store,每个 MCP 桥进程都会在加载期 mkdir 数据目录)
  const regSrc = fs.readFileSync(path.join(__dirname, 'tool-registry.js'), 'utf-8');
  const srvSrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf-8');
  const regRequiresStore = /require\(['"]\.\/store['"]\)/.test(regSrc);
  const srvLogsDiag = /getLoadDiagnostics/.test(srvSrc) && /appendLog\(\s*['"]error['"]/.test(srvSrc);
  check('#46a4 诊断必须由 server.js 落进 logs.jsonl(error 级),且 tool-registry 不得为此新增 store 依赖',
    !regRequiresStore && srvLogsDiag, 'tool-registry 依赖 store=' + regRequiresStore + ' server 落账=' + srvLogsDiag);
}

process.stdout.write('\n' + '='.repeat(40) + '\n');
process.stdout.write(`总计: ${passed}/${passed + failed} 通过\n`);
if (failed) process.stdout.write('失败项: ' + failures.join(', ') + '\n');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failed ? 1 : 0);
