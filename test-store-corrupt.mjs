#!/usr/bin/env node
'use strict';

/**
 * P0 静默清库对抗测试(隔离临时目录,无网络,指挥官亲笔 —— 锁定文件,编码手禁改)
 *
 * 针对的真实缺陷(两路独立审计收敛确认):
 *   store.js 的 load()/loadList() 用 catch(_) 吞掉 JSON.parse 失败返回 {}/[]，
 *   而 loadMemory()/loadACL() 把缺字段补成"合法空结构"，
 *   随后 saveSync() 无条件覆写(修复前是 tmp+rename 直接盖) —— 一次文件损坏或手改坏
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

// #100 #46 探针的复制清单(唯一真源)。它必须是 tool-registry.js 的传递 require 闭包;
// 文末的 #100 锁在每次运行时实时算闭包来比对,缺项/冗余都指名道姓红 —— 不再靠人记得加文件。
const REGISTRY_ROOT = 'tool-registry.js';
const REGISTRY_COPY = [
  'tool-registry.js',
  'kimi-models.js',
  'env-int.js',
  'cause.js', // #104 声明式加项:摘要尺下沉为零依赖单点后,它进入 tool-registry 的传递闭包
  'adapters/base.js',
  'adapters/cli-adapter.js',
  'adapters/http-adapter.js'
];

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
} else if (scenario === 'record62') {
  // #62:调用点(server.js 的 taskRecord)**已经带着** requested/total/skipped,是 store 的白名单把它们丢了。
  //   所以本探针直接喂全字段,再**从磁盘读回**(不走 loadMemory,避免"内存里补出来的字段"冒充落住的事实)。
  const rec = {
    id: 'task_62_probe', dispatchId: 'dispatch_62', ts: null, task: '#62 探针任务',
    tools: ['a', 'b', 'c'], results: [{ tool: 'a', success: true, tokens: { total: 7 } }],
    requested: 3, total: 3, successCount: 1, skipped: ['gone-tool-1', 'gone-tool-2'],
    totalTokens: 7, fallbackLog: [], workspace: null, routing: { mode: 'manual' }
  };
  store.recordTask(rec);
  const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.AI_BRIDGE_DATA_DIR, 'memory.json'), 'utf-8'));
  const t = (onDisk.tasks || [])[0] || {};
  out({
    // 对照组(必须已经通过):两个"在白名单里"的字段能读回 ⇒ 证明读盘路径本身有效,不是"全字段都读不回"
    ctrlSuccessCount: t.successCount, ctrlTotalTokens: t.totalTokens,
    // 本单目标:路由分解字段必须逐值留住
    requested: t.requested, total: t.total, skipped: t.skipped, hasRouting: t.routing !== undefined
  });
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
} else if (scenario === 'cause97parse') {
  // #97:解析失败必须归到"解析失败"这一类(而不是让 V8 的英文措辞去当类别标签)
  store.load('memory');
  out({ reason: store.quarantineReason('memory'), q: store.isQuarantined('memory') });
} else if (scenario === 'cause97read') {
  // #97:读取失败(EISDIR)与解析失败是**两类**事——现在被同一个 catch 收成同一条、靠措辞猜
  const f = path.join(process.env.AI_BRIDGE_DATA_DIR, 'switches.json');
  try { fs.rmSync(f, { recursive: true, force: true }); } catch (_) { /* 种子可能不存在 */ }
  fs.mkdirSync(f, { recursive: true }); // 让它变成目录 ⇒ readFileSync 抛 EISDIR(确定性的读错误)
  store.load('switches');
  out({ reason: store.quarantineReason('switches'), q: store.isQuarantined('switches') });
} else if (scenario === 'cause97shape') {
  // #97:形状非法这一类必须有自己的类别标签,且**字段名细节不得被丢掉**
  store.loadMemory();
  out({ reason: store.quarantineReason('memory'), q: store.isQuarantined('memory') });
} else if (scenario === 'cause97fn') {
  // #97 一把尺:store 必须暴露 causeOf(e),规则=尾部优先 + 有界 + 把开头错误码补回(与 #54 同则)
  const long = 'EPERM: ' + 'x'.repeat(400) + ' TAIL_REAL_CAUSE_MARKER';
  const r = typeof store.causeOf === 'function' ? store.causeOf(new Error(long)) : null;
  const short = typeof store.causeOf === 'function' ? store.causeOf(new Error('boom')) : null;
  const noMsg = typeof store.causeOf === 'function' ? store.causeOf(new Error('')) : null;
  out({
    hasFn: typeof store.causeOf === 'function',
    long: r, longLen: r === null ? -1 : r.length,
    short, shortHasEllipsis: typeof short === 'string' && short.indexOf('…') !== -1,
    noMsg
  });
} else if (scenario === 'cause97clean') {
  // 反向哨兵:健康路径必须照旧可写、reason 为 null(未被损坏污染)
  out({
    reasonClean: store.quarantineReason('memory'),
    qClean: store.isQuarantined('memory'),
    wrote: store.saveSync('memory', { tasks: [], experiences: {}, preferences: {}, meetings: [] })
  });
} else if (scenario === 'notice103') {
  // #103:损坏帧与拒写帧必须是同一个写手造的——修复前两处各拼一套(旧锚点 :74 与 :165),现收敛为单点写手 storageNotice(store.js:200)
  // (一处半角括号一处全角、一处带"存储文件 X"前缀一处不带),运维无法用一个正则捞全。
  store.load('memory'); // 触发损坏帧
  const w1 = store.saveSync('memory', { tasks: [], meetings: [] }); // 触发拒写帧
  setTimeout(() => {
    const dir = process.env.AI_BRIDGE_DATA_DIR;
    let logs = '';
    try { logs = fs.readFileSync(path.join(dir, 'logs.jsonl'), 'utf-8'); } catch (e) { logs = ''; }
    const frame = typeof store.storageNotice === 'function'
      ? { hasFn: true, dmg: store.storageNotice('memory', '损坏'), ref: store.storageNotice('memory', '拒写') }
      : { hasFn: false };
    out({
      w1, frame, reasonValue: store.quarantineReason('memory'),
      // 留痕行的正文字段是 msg(不是 message);这里的 \\r?\\n 必须双写反斜杠——本串在模板字面量内,
      // 单写会被模板吃掉,生成的 runner 就成了"正则里嵌真换行"的语法错误(我踩过一次)
      errLines: logs.split(/\\r?\\n/).filter(l => /"level":"error"/.test(l)).map(l => {
        try { return JSON.parse(l).msg } catch (e) { return l }
      })
    });
  }, 700); // appendLog 是异步落盘(见 #99),不等这一拍会读到空行 ⇒ 假绿/假红都可能
} else if (scenario === 'orphan103sparse') {
  // #103 前置哨兵:缺 meetings 的**合法稀疏**文件,启动清扫不得把它判损坏
  // (assertShape 明写"缺失:合法稀疏,由补字段逻辑负责");删 :346 死码后此行为必须一模一样
  let swept = null, threw = null;
  try { swept = store.markOrphanMeetings(); } catch (e) { threw = String(e && e.message); }
  out({
    threw, sweptIsArray: Array.isArray(swept), sweptLen: Array.isArray(swept) ? swept.length : -1,
    q: store.isQuarantined('memory'), reason: store.quarantineReason('memory'),
    wrote: store.saveSync('memory', { tasks: [], meetings: [] }),
    dir: fs.readdirSync(process.env.AI_BRIDGE_DATA_DIR).filter(f => !/^logs/.test(f))
  });
} else if (scenario === 'meeting123') {
  // #123 取证:把时钟钉死,同一毫秒连开两场会。现状 id 只有 Date.now() 一个因子 ⇒ 必然撞成同一个,
  //   撞完之后 mem.meetings 里有两条同 id 记录,而 find(m => m.id === id) 永远只返回先建的那条
  //   ⇒ 两个后台讨论循环共用同一条记录(发言串台、终态互相覆盖),且没有任何地方知道撞过。
  const REAL_NOW = Date.now;
  const PINNED = 1700000000000;
  Date.now = () => PINNED;
  const a123 = store.createMeeting('话题A', ['t1']);
  const b123 = store.createMeeting('话题B', ['t2']);
  Date.now = REAL_NOW;
  const mem123 = store.loadMemory();
  out({
    idA: a123.meeting.id, idB: b123.meeting.id, distinct: a123.meeting.id !== b123.meeting.id,
    prefixOk: /^meeting_/.test(a123.meeting.id) && /^meeting_/.test(b123.meeting.id),
    foundA: mem123.meetings.filter(m => m.id === a123.meeting.id).length,
    foundB: mem123.meetings.filter(m => m.id === b123.meeting.id).length,
    total: mem123.meetings.length,
    topics: mem123.meetings.map(m => m.topic).join('|'),
    persistedA: a123.persisted === true, persistedB: b123.persisted === true
  });
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
// loadTools()(现锚点 tool-registry.js:88-133)修复前把 JSON.parse 放在 try 之外,而 `const TOOLS = loadTools()`(现 :135)
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

  const runRegistryCase = (name, toolsContent) => {
    const dir = path.join(TMP, `reg-${name}`);
    fs.mkdirSync(path.join(dir, 'adapters'), { recursive: true });
    // #100:复制清单只有一个真源 = 上面的 REGISTRY_COPY(由文末的闭包锁与 tool-registry.js 的
    // 传递 require 闭包实时比对)。过去它是两条手写白名单,#96 给 cli-adapter 加了一句
    // require('../env-int') 就让 5 条断言崩成"Cannot find module"——工装缺陷冒充产品缺陷。
    for (const rel of REGISTRY_COPY) {
      fs.copyFileSync(path.join(__dirname, rel), path.join(dir, rel));
    }
    if (toolsContent !== null) fs.writeFileSync(path.join(dir, 'tools.json'), toolsContent, 'utf-8');
    const r = spawnSync(process.execPath, [regRunner, dir], {
      env: { ...process.env, AI_BRIDGE_DATA_DIR: dir, AI_BRIDGE_TOKEN: '' },
      encoding: 'utf-8', timeout: 20000
    });
    let parsed = null;
    try { parsed = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { /* 交给断言判失败 */ }
    return { dir, parsed, stderr: r.stderr || '' };
  };

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

section('#103) 损坏帧与拒写帧同一个写手 + :346 手抄文案归一(不改行为)');
{
  // 实测口径(基线):修复前 store 里旧写点 :74 产 `存储文件 X 损坏(…;原因: …),本进程内拒绝覆写` vs :165
  // `拒绝覆写 X:本轮已隔离（原因: …）` —— 同一件事两种帧:半角/全角括号混用、一处带 basename 前缀一处不带,
  // 运维无法用一条正则把某次损坏的全部留痕捞全。另 :346 把 shapeReason 的文案**手抄**了一份
  // (实测 `字段形状非法(须为数组)` 字面在 store.js 出现 **2** 次),而该分支经实测**永不可观测**
  // ——真因总是 load() 先写入且 quarantine 只记首次 ⇒ 它是会静默变质的第二把尺,不是"漏了类别前缀"。
  const storeSrc = fs.readFileSync(path.join(__dirname, 'store.js'), 'utf-8').replace(/\r/g, '');
  const nDmg = (storeSrc.match(/appendLog\(\s*'error'\s*,\s*`存储文件/g) || []).length;
  const nRef = (storeSrc.match(/appendLog\(\s*'error'\s*,\s*`拒绝覆写/g) || []).length;
  const nLit = (storeSrc.match(/字段形状非法\(须为数组\)/g) || []).length;
  check('#103a1 两处留痕不得再各自拼字符串(实测基线:损坏帧 1 处 + 拒写帧 1 处各自模板)',
    nDmg === 0 && nRef === 0, 'appendLog 直拼 损坏帧=' + nDmg + ' 拒写帧=' + nRef);
  check('#103a2 shapeReason 的文案只许有一份(手抄第二份必随规则变质,同 #74/#77 家族)',
    nLit === 1, '字面「字段形状非法(须为数组)」出现次数=' + nLit + '(应为 1=生成处)');

  // 细节字符串一律走 ds():JSON.stringify(undefined) 返回的是 undefined 而非字符串,
  // 缺陷态里直接 .slice() 会把整套件带崩(锁必须报 FAIL 然后继续,不许崩)。
  const ds = (x) => String(JSON.stringify(x === undefined ? null : x)).slice(0, 160)
  const n103 = runScenario('103notice', 'notice103', { 'memory.json': TRUNC_MEMORY });
  const fr = (n103.parsed && n103.parsed.frame) || {};
  const reasonValue = n103.parsed && n103.parsed.reasonValue;
  check('#103a3 store 必须暴露唯一写手 storageNotice(key, event)',
    fr.hasFn === true, 'hasFn=' + ds(fr.hasFn));
  // 骨架同形:先抹掉全角括号内细节,再把事件词归一,最后折叠空白 —— 两帧必须逐字相等
  const skeleton = (s) => String(s || '')
    .replace(/（[^）]*）/g, '（…）')
    .replace(/(损坏|拒写)/, ' <event> ')
    .replace(/\s+/g, ' ')
    .trim();
  check('#103a4 两帧骨架必须逐字相等(括号内细节与事件词之外不许有任何差异;半角括号或多余尾句即红)',
    typeof fr.dmg === 'string' && typeof fr.ref === 'string'
      && skeleton(fr.dmg) === skeleton(fr.ref) && skeleton(fr.dmg) === '存储文件 memory.json <event> （…）',
    '骨架 损坏=' + ds(skeleton(fr.dmg)) + ' 拒写=' + ds(skeleton(fr.ref)));
  check('#103a5 拒写帧的原因必须**等于** quarantineReason(key) 的原值(不许改写,也不许在有真因时写"原因未记录")',
    typeof reasonValue === 'string' && /^解析失败: /.test(reasonValue)
      && typeof fr.ref === 'string' && fr.ref.includes(reasonValue) && !/原因未记录/.test(fr.ref),
    'reasonValue=' + ds(reasonValue) + ' 拒写帧=' + ds(fr.ref));
  const errLines = (n103.parsed && n103.parsed.errLines) || [];
  check('#103a6 端到端:一次损坏写出的两条 error 留痕必须**同形**(运维一条正则能捞全)',
    errLines.length >= 2
      && errLines.every(l => /^存储文件 memory\.json .+（原因: /.test(String(l))),
    'error 行数=' + errLines.length + ' 首行=' + ds(errLines[0]) + ' 次行=' + ds(errLines[1]));

  const sp = runScenario('103sparse', 'orphan103sparse', { 'memory.json': '{"tasks":[],"experiences":[]}' });
  check('#103a7 前置哨兵(删死码不得改行为):缺 meetings 的**合法稀疏**文件照旧不隔离、照旧可写、清扫照旧回数组',
    sp.parsed && sp.parsed.threw === null && sp.parsed.sweptIsArray === true
      && sp.parsed.q === false && sp.parsed.reason === null && sp.parsed.wrote === true
      && !corrupt(sp.parsed.dir || []).length,
    ds(sp.parsed));
}

section('#97) 归因的类别标签不得由引擎措辞决定 + 有界原因摘要只剩一把尺');
{
  // 现状实测(store.js:117-123):readFileSync 与 JSON.parse 在**同一个 try** 里,catch 直接把
  // e.message 当原因 ⇒ 对外文案的"这是什么类型的损坏"完全取决于 V8/libuv 的英文措辞,读错误与
  // 解析错误分不开;而有界摘要有两套规则:store.flattenReason 保**头**(slice(0,200)),
  // workspace-manager.causeOf 保**尾**并补错误码(#54 立的规则)——同一规则两处实现且**互相矛盾**。
  // 锁的是行为契约:原因字符串必须以 <类别>:  开头,类别 ∈ {解析失败, 读取失败, 形状非法}。
  const cParse = runScenario('97parse', 'cause97parse', { 'memory.json': TRUNC_MEMORY });
  const pr = (cParse.parsed && cParse.parsed.reason) || '';
  check('#97a1 解析失败须以「解析失败: 」开头(现状=直接抄 V8 措辞,运维得自己认英文句式)',
    /^解析失败: /.test(pr), 'reason=' + JSON.stringify(pr).slice(0, 180));
  check('#97a2 解析失败仍须保留真因原文(类别是加的,不是换掉的)',
    /Unexpected|位置|position|JSON/i.test(pr), 'reason=' + JSON.stringify(pr).slice(0, 180));

  const cRead = runScenario('97read', 'cause97read', { 'switches.json': '{"a":1}' });
  const rr = (cRead.parsed && cRead.parsed.reason) || '';
  check('#97a3 读错误(EISDIR)须归到「读取失败: 」——它和解析失败是两类事,现在被同一个 catch 混成一条',
    /^读取失败: /.test(rr) && /EISDIR/.test(rr), 'reason=' + JSON.stringify(rr).slice(0, 180));
  check('#97a4 读错误同样必须触发隔离与拒写(分类不得把保守保全策略改松)',
    cRead.parsed && cRead.parsed.q === true, JSON.stringify(cRead.parsed));

  const cShape = runScenario('97shape', 'cause97shape', { 'memory.json': '{"meetings":{}}' });
  const sr = (cShape.parsed && cShape.parsed.reason) || '';
  check('#97a5 形状非法须以「形状非法: 」开头,且字段名细节不得被丢掉(二者都要,缺一即归因不足)',
    /^形状非法: /.test(sr) && /meetings/.test(sr), 'reason=' + JSON.stringify(sr).slice(0, 180));

  const cFn = runScenario('97fn', 'cause97fn', {});
  const fj = cFn.parsed || {};
  check('#97a6 store 必须暴露 causeOf(e) 这把唯一的尺(现状:只有 workspace-manager 有,store 自己那套是保头的)',
    fj.hasFn === true, 'hasFn=' + JSON.stringify(fj.hasFn));
  check('#97a7 一把尺的规则=尾部优先 + 有界(<=200) + 把开头错误码补回(#54 同则)',
    typeof fj.long === 'string' && fj.longLen <= 200 && /TAIL_REAL_CAUSE_MARKER$/.test(fj.long) && /^EPERM: /.test(fj.long),
    'longLen=' + fj.longLen + ' long=' + JSON.stringify(fj.long).slice(0, 150));
  check('#97a8 反向哨兵:短真因必须原文照抄,不得被加省略号(有界规则不许伤及短消息)',
    fj.short === 'boom' && fj.shortHasEllipsis === false, 'short=' + JSON.stringify(fj.short));
  check('#97a9 反向哨兵:空消息仍须诚实说"未知"(不许编造原因,也不许抛错)',
    typeof fj.noMsg === 'string' && /未知/.test(fj.noMsg), 'noMsg=' + JSON.stringify(fj.noMsg));

  const cClean = runScenario('97clean', 'cause97clean', {});
  check('#97a10 反向哨兵:健康路径不得凭空编出原因(未隔离 reason=null、可写=true)',
    cClean.parsed && cClean.parsed.reasonClean === null && cClean.parsed.qClean === false && cClean.parsed.wrote === true,
    JSON.stringify(cClean.parsed));

  // 单一实现锁(尺归一必须连锁一起改 —— #86 的病:被测试钉住的第二把尺)
  const wmSrc = fs.readFileSync(path.join(__dirname, 'workspace-manager.js'), 'utf-8').replace(/\r/g, '');
  check('#97a11 workspace-manager.js 不得再留第二份"有界原因摘要"实现,必须改调 store.causeOf',
    !/function causeOf\s*\(/.test(wmSrc) && /store\.causeOf\(/.test(wmSrc),
    '仍有本地实现=' + /function causeOf\s*\(/.test(wmSrc) + ' 改调单点=' + /store\.causeOf\(/.test(wmSrc));
}

section('#104) "有界原因摘要"只剩一把尺(预防锁:今天的分叉不可观测,但复制必然随规则变质)');
{
  // 实测(#104 前置取证):仓内还有第三把尺 —— tool-registry.js:76-86 的 DIAG_ERROR_MAX + boundedReason,
  // 与 store.js 的 CAUSE_MAX + causeOf 只差一条规则:store 把 'Error'/'SyntaxError' 这类**无信息壳**判"未知",
  // tool-registry 不判。这条差在真配置路径上**今天打不出来**(JSON.parse/TypeError 的消息都远长于壳),
  // 所以本锁**不是缺陷红基线,而是防第 4 把尺的漂移门禁** —— 与 #100 同类,我按预防锁如实记账。
  // 判据用"实现指纹"而非名字。第一版我用裸 /slice\(\s*-/,那是**过宽口径**:store.js:276 的日志窗口
  // entries.slice(-maxLimit) 与 :332 的 meeting.messages.slice(-MAX_MEETING_MESSAGES) 是无关的尾部截取,
  // 会被误算成第三把尺,并把编码手逼去动无关代码。收窄为"摘要尺独有"的两条指纹:
  //   F1 省略号补回前缀写法  '…' + <变量>.slice(-      (压平后重接错误码,只有摘要尺会这么写)
  //   F2 以上限常量定标的尾部截断 slice(-(CAUSE_MAX|REASON_MAX|DIAG_ERROR_MAX
  const RULER_F1 = /'…'\s*\+\s*\w+\.slice\(\s*-/;
  const RULER_F2 = /slice\(\s*-\s*\(\s*(CAUSE_MAX|REASON_MAX|DIAG_ERROR_MAX)\b/;
  const srcOf = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf-8').replace(/\r/g, '');
  const all = { 'store.js': srcOf('store.js'), 'tool-registry.js': srcOf('tool-registry.js'), 'workspace-manager.js': srcOf('workspace-manager.js'), 'cause.js': fs.existsSync(path.join(__dirname, 'cause.js')) ? srcOf('cause.js') : '' };
  const tailImpls = Object.entries(all).filter(([, s]) => RULER_F1.test(s) || RULER_F2.test(s)).map(([f]) => f);
  const maxConsts = Object.entries(all).filter(([, s]) => /(CAUSE_MAX|REASON_MAX|DIAG_ERROR_MAX)\s*=\s*\d+/.test(s)).map(([f]) => f);
  check('#104a1 "有界原因摘要"的实现全仓只能有一处(实测基线:store.js 与 tool-registry.js 各一份 = 漂移温床)',
    tailImpls.length === 1 && tailImpls[0] === 'cause.js', '含摘要尺指纹的文件=' + JSON.stringify(tailImpls));
  check('#104a2 同义上限常量只能有一处定义(基线:store 的 CAUSE_MAX + tool-registry 的 DIAG_ERROR_MAX = 2)',
    maxConsts.length === 1 && maxConsts[0] === 'cause.js', '定义处=' + JSON.stringify(maxConsts));
  check('#104a3 归一后 store 与 tool-registry 都必须改调单点(store re-export 也算引用)',
    /require\(['"]\.\/cause['"]\)/.test(all['store.js']) && /require\(['"]\.\/cause['"]\)/.test(all['tool-registry.js'])
      && /\bcauseOf\b/.test(all['cause.js']),
    'store 引 cause=' + /require\(['"]\.\/cause['"]\)/.test(all['store.js']) + ' tool-registry 引 cause=' + /require\(['"]\.\/cause['"]\)/.test(all['tool-registry.js']));
  // 指纹自证(防空对空,也防我第一版的过宽口径复发):尺必须认得出复制品,又必须放过无关的尾部截取
  const RULER_SAMPLE = "const M = 200;\nreturn prefix + '…' + msg.slice(-(M - prefix.length - 1));";
  const NOT_RULER = [
    'return entries.slice(-maxLimit);',                       // store.js:276 日志窗口
    'meeting.messages = meeting.messages.slice(-MAX_MEETING_MESSAGES);' // store.js:332 会话消息上限
  ];
  check('#104a5 指纹自证:复制一把尺必须被抓到,无关的尾部截取(日志窗口/消息上限)必须放过(否则 a1 是过宽口径)',
    (RULER_F1.test(RULER_SAMPLE) || RULER_F2.test(RULER_SAMPLE))
      && NOT_RULER.every((s) => !RULER_F1.test(s) && !RULER_F2.test(s)),
    '尺命中=' + (RULER_F1.test(RULER_SAMPLE) || RULER_F2.test(RULER_SAMPLE))
      + ' 误伤=' + JSON.stringify(NOT_RULER.filter((s) => RULER_F1.test(s) || RULER_F2.test(s))));
  // 行为哨兵(#46 面不许回退):配置损坏的诊断仍须给出第一顺位归因(异常名/错误码)且有界
  const bad = runScenario('104diag', 'cause97parse', { 'tools.json': '[{"name":"ok","transport":"cli"},{"id":' });
  const reg = spawnSync(process.execPath, ['-e',
    `const r=require(${JSON.stringify(path.join(__dirname, 'tool-registry.js'))});const d=r.getLoadDiagnostics();`
    + 'process.stdout.write(JSON.stringify({status:d&&d.status,error:d&&d.error,file:d&&d.file,entryCount:d&&d.entryCount}));'
  ], {
    cwd: __dirname, encoding: 'utf-8', timeout: 20000,
    env: { ...process.env, AI_BRIDGE_DATA_DIR: bad.dataDir, AI_BRIDGE_TOOLS_PATH: path.join(bad.dataDir, 'tools.json'), AI_BRIDGE_TOKEN: '' }
  });
  let dj = null;
  try { dj = JSON.parse(String(reg.stdout || '').split(/\r?\n/).filter(Boolean).pop()); } catch (_) { /* 交给断言判失败 */ }
  // 一律走 ds():JSON.stringify(undefined) 返回 undefined 而非字符串,.slice 会把整套件带崩
  // (我在 #103 刚立规"锁只能报 FAIL 不许崩",紧接着就再犯一次 —— 故两个套件都用同一个 ds())
  const ds = (x) => String(JSON.stringify(x === undefined ? null : x)).slice(0, 170)
  check('#104a4 行为不回退:配置损坏的诊断仍给出 status=corrupt-parse 与可归因 error(异常名/Expected 字样)且有界',
    !!dj && dj.status === 'corrupt-parse' && typeof dj.error === 'string' && dj.error.length > 0
      && dj.error.length <= 220 && /SyntaxError|Expected|JSON/.test(dj.error),
    'diag=' + ds(dj) + ' stderr=' + ds(String(reg.stderr || '').slice(0, 120)));
}

section('#111) 无信息壳的判据必须覆盖"非 Error 对象"(causeOf 是单点,输入域就得是完整的)');
{
  // 取证(基线 be9ceea,判据由本轮命令实测,不凭记忆):
  //   cause.js 的壳判据是 `if (!msg || /^[A-Za-z]*Error$/.test(msg))`,只认 'Error'/'SyntaxError' 这类
  //   **异常名壳**。实测同一"取不到有信息正文"的另外四种输入(a1 的探针逐项求值,非我口算):
  //     causeOf({})                  -> '[object Object]'   ← 外泄成"原因"
  //     causeOf({message:''})        -> '[object Object]'   ← 同上
  //     causeOf({message:'[object Object]'}) -> '[object Object]'
  //     causeOf({message:'[object Module]'}) -> '[object Module]'
  //   而 causeOf(new Error('')) 与 causeOf(Object.create(Error.prototype)) 都正确回"未知故障(无异常信息)"
  //   —— 同一条"无信息"事实:**四类壳输入 0 类被判出来**(四类都漏)。**这是判据不完备,不是文案偏好。**
  //   影响面如实记:本轮实测仓内**零处**非 Error 形态的 throw/reject(两处 Promise.reject 都是 new Error),
  //   所以生产路径今天打不出;但 causeOf 是 #54/#74/#97/#104 的共同单点,输入域不完备就是下一次复制变质的入口,
  //   故本格按"单点 API 上的可测行为缺陷"记账,不夸大成线上故障。
  // 本套件是 ESM 而 cause.js 是 CJS ⇒ 不能 require(我第一版就栽在这里,ReferenceError 把整套件打崩)。
  // 按既有范式:探针写成 CJS 文件落 TMP(不进仓库),spawnSync 求值后取回 JSON 再断言。
  const ds2 = (x) => String(JSON.stringify(x === undefined ? null : x)).slice(0, 200)
  const probeFile = path.join(TMP, 'cause111-probe.cjs')
  fs.writeFileSync(probeFile, `'use strict';
const { causeOf } = require(${JSON.stringify(path.join(__dirname, 'cause.js'))});
const U = '未知故障（无异常信息）';
const proto = Object.create(Error.prototype);
const shells = [['{} 空对象', {}], ['{message:空串} 空正文', { message: '' }],
  ['message 恰为 tag', { message: '[object Object]' }], ['其他 toString tag', { message: '[object Module]' }]];
const real = [['含 tag 子串的真实正文', '参数 value [object Object] 不可序列化，请传标量'],
  ['tag 在句中的真实正文', 'Map: [object Object] 无法比较'],
  ['短真因不得被加省略号', 'EISDIR: illegal operation on a directory, read']];
process.stdout.write(JSON.stringify({
  UNKNOWN: U,
  shells: shells.map(([k, v]) => ({ k, got: causeOf(v) })),
  real: real.map(([k, v]) => ({ k, want: v, got: causeOf(v) })),
  errLike: { proto: causeOf(proto), nullv: causeOf(null), undef: causeOf(undefined), emptyErr: causeOf(new Error('')), str: causeOf('boom') }
}));
`, 'utf-8')
  const pr = spawnSync(process.execPath, [probeFile], {
    cwd: __dirname, encoding: 'utf-8', timeout: 20000,
    env: { ...process.env, AI_BRIDGE_DATA_DIR: TMP, AI_BRIDGE_TOKEN: '' }
  })
  let pj = null
  try { pj = JSON.parse(String(pr.stdout || '').split(/\r?\n/).filter(Boolean).pop()) } catch (_) { /* 交给断言判失败 */ }
  const UNKNOWN = pj ? pj.UNKNOWN : '未知故障（无异常信息）'
  const leaked = pj && Array.isArray(pj.shells)
    ? pj.shells.filter(s => s.got !== UNKNOWN).map(s => s.k + '->' + JSON.stringify(s.got))
    : ['<探针未产出 stderr=' + ds2(String(pr.stderr || (pr.error && pr.error.message) || '')).slice(0, 120) + '>']
  check('#111a1 String(x) 塌成 toString 标签时必须按无信息壳判"未知"(实测基线:四类输入全部外泄)',
    leaked.length === 0, '外泄=' + JSON.stringify(leaked));
  // 反向哨兵(前置即绿,改后必须仍绿):判据只许整串匹配,**不许**做成 includes ——
  // 否则"参数 value [object Object] 不可序列化"这种带真实正文的归因会被误杀成"未知"。
  const overkill = pj && Array.isArray(pj.real)
    ? pj.real.filter(r => r.got !== r.want).map(r => r.k + '->' + JSON.stringify(String(r.got).slice(0, 60)))
    : ['<探针未产出>']
  check('#111a2 反向哨兵:真实正文里含 "[object Object]" 子串必须原文照抄(判据写成 includes 就会误杀归因)',
    overkill.length === 0, '被误杀=' + JSON.stringify(overkill));
  const el = (pj && pj.errLike) || {}
  check('#111a3 反向哨兵:无 message 的 Error 形对象与 null/undefined 的既有"未知"语义不得回退',
    el.proto === UNKNOWN && el.nullv === UNKNOWN && el.undef === UNKNOWN
      && el.emptyErr === UNKNOWN && el.str === 'boom',
    'Error 形=' + JSON.stringify(el.proto) + ' null=' + JSON.stringify(el.nullv)
      + ' undefined=' + JSON.stringify(el.undef) + ' Error(空消息)=' + JSON.stringify(el.emptyErr)
      + ' 字符串=' + JSON.stringify(el.str));
  // 结构锁:壳判据必须"整串锚定"且不许以 includes/indexOf 形态散开(防过宽,也防第二处复制)
  const causeSrc = fs.readFileSync(path.join(__dirname, 'cause.js'), 'utf-8').replace(/\r/g, '')
  const anchored = /\/[^\n]*\\\[object[^\n]*\$\//.test(causeSrc)
  const looseForm = /(\.includes\s*\(\s*['"`]\[object|\.indexOf\s*\(\s*['"`]\[object)/.test(causeSrc)
  check('#111a4 结构锁:tag 壳判据必须是整串锚定的正则且不得是 includes/indexOf 形态(过宽=误杀真因,分散=又一处复制)',
    anchored && !looseForm, '整串锚定=' + anchored + ' 宽松形态=' + looseForm);
}

section('#100) 探针复制清单必须等于 tool-registry.js 的传递 require 闭包');
{
  // 为什么是"每次运行实时算闭包"而不是把清单写死成注释:闭包会随源码演进,#96 就是加了一句
  // require('../env-int') 就让 5 条断言崩成 Cannot find module(神秘崩溃,红因在工装)。
  const specsOf = (rel) => {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf-8').replace(/\r/g, '');
    return [...src.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)].map(m => m[1]);
  };
  const resolveLocal = (fromRel, spec) => {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
    for (const cand of [base + '.js', base + '.mjs', base + '.cjs', base + '/index.js']) {
      if (fs.existsSync(path.join(__dirname, cand))) return cand;
    }
    return null;
  };
  const closureOf = (entry) => {
    const seen = new Set();
    const unresolved = [];
    const q = [entry];
    while (q.length) {
      const rel = q.shift();
      if (seen.has(rel)) continue;
      seen.add(rel);
      for (const s of specsOf(rel)) {
        const hit = resolveLocal(rel, s);
        if (!hit) unresolved.push(rel + ' -> ' + s);
        else if (!seen.has(hit)) q.push(hit);
      }
    }
    return { files: [...seen].sort(), unresolved };
  };
  const cl = closureOf(REGISTRY_ROOT);
  const notCopied = cl.files.filter(f => !REGISTRY_COPY.includes(f));
  const redundant = REGISTRY_COPY.filter(f => !cl.files.includes(f));
  check('#100a1 闭包内每个文件都必须在复制清单里(少一个=沙箱 require 失败,把被测断言打成神秘崩溃)',
    cl.unresolved.length === 0 && notCopied.length === 0,
    '缺=' + JSON.stringify(notCopied) + ' 未解析边=' + JSON.stringify(cl.unresolved));
  check('#100a2 反向哨兵:复制清单不得有冗余(复制不在闭包内的文件=探针在测一份假的依赖树)',
    redundant.length === 0, '冗余=' + JSON.stringify(redundant));
  // 变异自证:a1 若永远为真(比如比对函数写错),它就是又一条空对空的假绿(#27s9b/#74s1/#101b2 同类病)。
  const mutated = REGISTRY_COPY.filter(f => f !== 'env-int.js');
  const missMutated = cl.files.filter(f => !mutated.includes(f));
  check('#100a3 变异自证(防空对空):把清单里 env-int.js 删掉,同一段比对必须报缺 1 项且点名它',
    missMutated.length === 1 && missMutated[0] === 'env-int.js',
    '变异后报缺=' + JSON.stringify(missMutated));
  check('#100a4 扫描器自证:闭包必须看见 >=6 个文件且零未解析边(解析器一旦失效,a1/a3 同时失去意义)',
    cl.files.length >= 6 && cl.files.includes('adapters/cli-adapter.js') && cl.files.includes('env-int.js'),
    '看见=' + JSON.stringify(cl.files));
  process.stdout.write('  (信息)闭包实测 ' + cl.files.length + ' 个文件: ' + cl.files.join(', ') + '\n');
}

section('#62) 台账必须留住路由分解字段(requested/total/skipped),不得只在响应里诚实一次');
{
  // 取证(#118 真载荷验收顺带实测,不是推测):调用点 server.js 的 taskRecord **已经带着**这三个字段
  //   (实测响应体样本 requested:1,total:1,skipped:[]),而 store.recordTask 的字段白名单不收 ⇒
  //   生产 memory.json 里 118 条真工具任务**0 条**含 requested/total/skipped(实测计数)。
  //   后果:#36 修的是"点名工具被静默 skipped 要看得见",但那份诚实只活在响应里一次;
  //   事后查历史台账只剩 successCount/total,分不清"3 个里 skipped 2 个"和"只点名了 1 个"。
  const r = runScenario('record62', 'record62');
  const p = r.parsed || {};
  // 对照组先立:两个**在白名单里**的字段能原样读回 ⇒ 证明"从磁盘读回"这条路本身有效,
  //   不是靠"全字段都读不回"蒙混成一条永远红的空锁(空对空是 #27s9b/#74s1/#101b2 那族病)。
  check('#62a0 对照组:白名单内字段(successCount/totalTokens)必须逐值读回',
    p.ctrlSuccessCount === 1 && p.ctrlTotalTokens === 7, JSON.stringify(p));
  check('#62a1 路由分解字段必须逐值落进台账:requested=3、total=3、skipped 两个名字',
    p.requested === 3 && p.total === 3 && Array.isArray(p.skipped) && p.skipped.length === 2
      && p.skipped[0] === 'gone-tool-1' && p.skipped[1] === 'gone-tool-2',
    'requested=' + JSON.stringify(p.requested) + ' total=' + JSON.stringify(p.total) + ' skipped=' + JSON.stringify(p.skipped));
  // 反向哨兵:不得把整个 taskRecord 原样塞进台账(那会把 dispatchId/routing/ts 等一次性字段也写穿进每次全量重写,
  //   台账体积随调用增长、且 routing 内含运行期对象)。白名单必须**逐字段列举**,所以 routing 今天不收 ⇒ 断言它仍不存在。
  check('#62a2 反向哨兵:白名单仍是逐字段列举,不得"顺手"把整个 task 对象原样落盘(routing/dispatchId 不许进台账)',
    p.hasRouting === false, 'hasRouting=' + JSON.stringify(p.hasRouting));
}

// ── #123 建会 id 的同毫秒撞车 ──
section('#123) 同一毫秒连开两场会不得撞 id(撞了=两个讨论循环共用同一条记录,且不可观测)');
{
  const m123 = runScenario('meeting123', 'meeting123').parsed || {};
  check('#123a1 红:把时钟钉死在同一毫秒时,两次 createMeeting 必须拿到不同 id(现状 id 只有 Date.now 一个因子)',
    m123.distinct === true && !!m123.idA && !!m123.idB,
    'idA=' + JSON.stringify(m123.idA) + ' idB=' + JSON.stringify(m123.idB));
  check('#123a2 撞车的下游必须可分辨:按各自 id 回查只命中一条、两场会都在册(total=2、话题各一)',
    m123.foundA === 1 && m123.foundB === 1 && m123.total === 2 && m123.topics === '话题B|话题A',
    'foundA=' + m123.foundA + ' foundB=' + m123.foundB + ' total=' + m123.total + ' topics=' + JSON.stringify(m123.topics));
  check('#123a3 反向自证(修 id 不得修成不可读或不落盘):前缀仍是 meeting_,两场会都必须落盘成功',
    m123.prefixOk === true && m123.persistedA === true && m123.persistedB === true,
    'prefixOk=' + JSON.stringify(m123.prefixOk) + ' persistedA=' + JSON.stringify(m123.persistedA) + ' persistedB=' + JSON.stringify(m123.persistedB));
}

process.stdout.write('\n' + '='.repeat(40) + '\n');
process.stdout.write(`总计: ${passed}/${passed + failed} 通过\n`);
if (failed) process.stdout.write('失败项: ' + failures.join(', ') + '\n');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failed ? 1 : 0);
