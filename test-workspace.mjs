#!/usr/bin/env node
'use strict';

/**
 * workspace-manager 单元/集成测试(隔离临时目录,无网络)
 *
 * 覆盖:
 *   - managed/linked 创建、名称与路径唯一性、路径安全校验
 *   - 名称/ID/路径三种引用解析、归档/恢复、运行租约与独占
 *   - 受管目录回收边界(登记目录只解除登记,绝不删文件)
 *   - CliAdapter:workspaceDir 作为 cwd + {{workspaceDir}} 模板
 *
 * 运行:node test-workspace.mjs   退出码:0 全通过 / 1 有失败
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const TMP = path.join(os.tmpdir(), `ai-bridge-ws-test-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TMP, 'data');
const ROOT = path.join(TMP, 'workspaces-root');
const EXTERNAL = path.join(TMP, 'external-project');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(EXTERNAL, { recursive: true });

// 必须在 require 任何业务模块前设置,store.js 在加载时解析 DATA_DIR
process.env.AI_BRIDGE_DATA_DIR = DATA_DIR;
process.env.AI_BRIDGE_WORKSPACE_ROOT = ROOT;

const ws = require('./workspace-manager.js');
const store = require('./store.js');
const { CliAdapter } = require('./adapters/cli-adapter.js');

let passed = 0;
let failed = 0;
const failures = [];
function check (name, cond, detail) {
  if (cond) { passed++; process.stdout.write(`  [PASS] ${name}\n`); }
  else { failed++; failures.push(name); process.stdout.write(`  [FAIL] ${name}${detail !== undefined ? ' — ' + detail : ''}\n`); }
}
function section (title) { process.stdout.write(`\n── ${title} ──\n`); }
function errorCode (fn) {
  try { fn(); return null; } catch (e) { return e.statusCode || 'no-status'; }
}
function samePath (a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

async function main () {
  process.stdout.write('workspace-manager 测试\n' + '='.repeat(40) + '\n');

  section('创建:managed / linked');
  const managed = ws.create({ name: 'demo project', description: 'P0 workspace' });
  check('managed 工作区创建成功', managed.mode === ws.MODE_MANAGED && managed.status === ws.STATUS_ACTIVE);
  check('managed 目录位于受管根目录并已创建', ws.isInside(managed.path, ROOT) && fs.statSync(managed.path).isDirectory(), managed.path);
  check('workspaceRoot 读取环境变量', samePath(ws.workspaceRoot(), ROOT));

  const linked = ws.create({ name: 'external', path: EXTERNAL });
  check('linked 工作区登记成功且路径为真实路径', linked.mode === ws.MODE_LINKED && samePath(linked.path, fs.realpathSync.native(EXTERNAL)), linked.path);
  check('summary 统计正确', ws.summary().total === 2 && ws.summary().managed === 1 && ws.summary().linked === 1);

  section('唯一性与路径安全');
  check('名称重复被拒(大小写不敏感)', errorCode(() => ws.create({ name: 'DEMO PROJECT' })) === 409);
  check('路径重复登记被拒', errorCode(() => ws.create({ name: 'external-dup', path: EXTERNAL })) === 409);
  check('相对路径被拒', errorCode(() => ws.create({ path: 'relative/dir' })) === 400);
  check('不存在的路径被拒', errorCode(() => ws.create({ path: path.join(TMP, 'not-exist') })) === 400);
  check('文件系统根目录被拒', errorCode(() => ws.create({ path: path.parse(TMP).root })) === 400);
  check('非法名称字符被拒', errorCode(() => ws.create({ name: 'bad/name' })) === 400);
  check('isInside 拒绝相等与越界路径', ws.isInside(path.join(ROOT, 'a'), ROOT) && !ws.isInside(ROOT, ROOT) && !ws.isInside(EXTERNAL, ROOT));

  // #51 "提供了 path 但为空白"被当成"没提供" → 静默新建空 managed 目录
  //   实况 workspace-manager.js:236 `wantsLinked = input.path != null && String(input.path).trim() !== ''`:
  //   调用方给了 path(哪怕只有空格)本意是"登记这个已有目录",空白是**它的输入错误**;
  //   现状却悄悄改建一个空受管目录并落盘,调用方拿到 201 与一个从没人要的工作区(后续派发的文件都写进那里)。
  section('#51 空白 path 不得被当作"未提供"(须 400 且不留痕)');
  {
    const n0 = ws.list().length;
    const dirs0 = fs.readdirSync(ROOT).length;
    const blanks = [['space', '   '], ['empty', ''], ['tab', ' \t '], ['newline', '\n']];
    for (const [label, p] of blanks) {
      let code = null, msg = '', created = null;
      try { created = ws.create({ name: 'blank-' + label, path: p }); code = 'CREATED:' + created.mode; }
      catch (e) { code = e.statusCode || 'no-status'; msg = String(e.message || ''); }
      check('#51a1-' + label + ' 提供了但空白的 path 必须以 400 拒绝(现状:被当作未提供 → 静默建 managed;实参=' + JSON.stringify(p) + ')',
        code === 400, 'code=' + code + ' msg=' + msg.substring(0, 60));
      check('#51a2-' + label + ' 拒绝不得留下注册记录,也不得在受管根里mkdir 出新目录',
        ws.list().length === n0 && fs.readdirSync(ROOT).length === dirs0,
        '记录=' + ws.list().length + '/' + n0 + ' 受管根目录数=' + fs.readdirSync(ROOT).length + '/' + dirs0);
      check('#51a3-' + label + ' 拒绝文案必须点名 path 并说清"空白"(不得伪装成"路径不存在",#54/#74 同族归因误导)',
        /path/.test(msg) && /(空白|为空|不能为空|必须提供)/.test(msg) && !/不存在/.test(msg), 'msg=' + msg.substring(0, 80));
    }
    // 哨兵三则:真正的"未提供"与合法 linked 都必须照旧 —— 防"一律拒绝"式假修复
    const absent = ws.create({ name: 'absent-ok' });
    check('#51a4 哨兵:完全不提 path 仍必须照旧建 managed(禁止把空白检查扩成禁用 managed)',
      absent.mode === ws.MODE_MANAGED && fs.existsSync(absent.path), absent.mode + ' exists=' + fs.existsSync(absent.path));
    const undef = ws.create({ name: 'undef-ok', path: undefined });
    check('#51a5 哨兵:path 显式 undefined 等同未提供,仍照旧 managed', undef.mode === ws.MODE_MANAGED, String(undef.mode));
    const realDir = path.join(TMP, 'real-linked');
    fs.mkdirSync(realDir, { recursive: true });
    const okLinked = ws.create({ name: 'linked-ok', path: realDir });
    check('#51a6 哨兵:合法绝对路径仍照旧 linked(正向路径不回退)', okLinked.mode === ws.MODE_LINKED, okLinked.mode + ' ' + okLinked.path);
  }

  section('引用解析:名称 / ID / 路径');
  check('按 ID 解析', ws.get(managed.id)?.name === 'demo project');
  check('按名称解析(大小写不敏感)', ws.get('DEMO PROJECT')?.id === managed.id);
  check('按绝对路径解析', ws.get(managed.path)?.id === managed.id);
  check('dispatch 解析返回存在性字段', ws.resolveForDispatch('demo project').isDirectory === true);

  section('运行租约:普通 / 独占 / 归档保护');
  const lease1 = ws.beginRun(managed.id, 'run-1');
  const lease2 = ws.beginRun(managed.id, 'run-2');
  check('普通工作区允许多个 run 并行', ws.get(managed.id).activeRuns === 2, JSON.stringify(ws.get(managed.id)));
  check('使用次数与最近使用时间已记录', ws.get(managed.id).useCount === 2 && !!ws.get(managed.id).lastUsedAt);
  ws.endRun(managed.id, lease1.runId);
  ws.endRun(managed.id, lease2.runId);
  check('endRun 后活动租约清零', ws.get(managed.id).activeRuns === 0);

  const exclusive = ws.create({ name: 'exclusive-ws', exclusive: true });
  const exLease1 = ws.beginRun(exclusive.id, 'ex-1');
  check('独占工作区第二个 run 被拒', errorCode(() => ws.beginRun(exclusive.id, 'ex-2')) === 409);
  ws.endRun(exclusive.id, exLease1.runId);
  const exLease2 = ws.beginRun(exclusive.id, 'ex-3');
  check('独占租约释放后可再次占用', !!exLease2.runId);
  ws.endRun(exclusive.id, exLease2.runId);

  const guarded = ws.create({ name: 'guarded' });
  const guardedLease = ws.beginRun(guarded.id, 'g-1');
  check('运行中的工作区不可归档', errorCode(() => ws.archive(guarded.id)) === 409);
  ws.endRun(guarded.id, guardedLease.runId);
  check('运行结束后可归档', ws.archive(guarded.id).status === ws.STATUS_ARCHIVED);
  check('归档后不可 dispatch', errorCode(() => ws.resolveForDispatch(guarded.id)) === 409);
  check('归档后恢复成功', ws.restore(guarded.id).status === ws.STATUS_ACTIVE);

  section('删除:登记目录只解绑 / 受管目录可回收');
  const removedLinked = ws.remove(linked.id);
  check('登记目录删除仅解除登记', removedLinked.filesDeleted === false && fs.statSync(EXTERNAL).isDirectory());
  check('登记目录记录已移除', ws.get(linked.id) === null);

  const linked2 = ws.create({ name: 'external-2', path: EXTERNAL });
  check('登记目录拒绝 deleteFiles', errorCode(() => ws.remove(linked2.id, { deleteFiles: true })) === 400);
  check('拒绝后目录与记录仍在', fs.existsSync(EXTERNAL) && ws.get(linked2.id) !== null);
  ws.remove(linked2.id);

  fs.writeFileSync(path.join(managed.path, 'artifact.txt'), 'hello', 'utf-8');
  const removedManaged = ws.remove(managed.id, { deleteFiles: true });
  check('受管目录可连同文件回收', removedManaged.filesDeleted === true && !fs.existsSync(managed.path));
  check('受管记录已移除', ws.get(managed.id) === null);

  section('#43 写失败不得先删文件(删除/创建路径的写序与归因守卫)');
  {
    // 确定性写失败注入:store.saveSync 先写 <file>.tmp 再 rename —— 把 tmp 做成目录,
    // writeFileSync 必抛 EISDIR。不碰生产、不需网络、不需要权限。
    const inj = ws.create({ name: 'inj-order', description: '#43b 写失败注入' });
    const tmpPath = path.join(DATA_DIR, 'workspaces.json.tmp');
    const injectOn = () => fs.mkdirSync(tmpPath, { recursive: true });
    const injectOff = () => fs.rmSync(tmpPath, { recursive: true, force: true });
    const codeOf = (e) => (typeof e.statusCode === 'number' ? e.statusCode : null);

    // ① 创建期(注入在时)——失败必须 5xx、不留孤儿目录、且原因不被吞
    injectOn();
    let cCode = null, cMsg = '', cPath = null;
    try { cPath = ws.create({ name: 'inj-create', description: '#43c1 创建期写失败' }).path; }
    catch (e) { cCode = codeOf(e); cMsg = e.message; }
    check('#43c1 创建期落盘失败须回传 5xx、不得留下孤儿目录、错误须含底层原因签名(EISDIR 不得被吞)',
      (cCode === 500 || cCode === 503) && (cPath === null || !fs.existsSync(cPath)) && /EISDIR|illegal operation/.test(cMsg),
      'code=' + cCode + ' 目录在=' + (cPath === null ? 'n/a' : fs.existsSync(cPath)) + ' msg=' + cMsg.substring(0, 80));

    // ② 归档期(同一把尺子:同函数族不得两套口径)
    let aCode = null, aMsg = '';
    try { ws.archive(inj.id); } catch (e) { aCode = codeOf(e); aMsg = e.message; }
    check('#43d1 归档期落盘失败须回传 5xx 且含底层原因签名(防"只修创建/删除两条路径"的半修)',
      (aCode === 500 || aCode === 503) && /EISDIR|illegal operation/.test(aMsg),
      'code=' + aCode + ' msg=' + aMsg.substring(0, 80));

    // ③ 恢复期:先把记录真的写成 archived(撤注入→归档成功→再注入),再触发 restore 落盘失败
    injectOff();
    let armedArchive = null;
    try { armedArchive = ws.archive(inj.id); } catch (e) { armedArchive = { err: e.message }; }
    injectOn();
    let rCode = null, rMsg = '';
    try { ws.restore(inj.id); } catch (e) { rCode = codeOf(e); rMsg = e.message; }
    check('#43d2 恢复期落盘失败须回传 5xx 且含底层原因签名(前置:归档确实已落盘=' + (armedArchive && armedArchive.status) + ')',
      (rCode === 500 || rCode === 503) && /EISDIR|illegal operation/.test(rMsg),
      'code=' + rCode + ' msg=' + rMsg.substring(0, 80));

    // ④ 删除期:先落盘后回收
    let injCode = null, injMsg = '';
    try { ws.remove(inj.id, { deleteFiles: true }); } catch (e) { injCode = codeOf(e); injMsg = e.message; }
    check('#43b1 注册表落盘失败时不得删除受管目录(现状:rmSync 已先删掉目录,落盘随后才失败)',
      fs.existsSync(inj.path), '目录仍在=' + fs.existsSync(inj.path) + ' err=' + injMsg.substring(0, 70));
    check('#43b2 不得留下"注册表仍指向、目录已消失"的悬空记录(现状:记录在 + 目录没 = 后续 dispatch 必失败且难归因)',
      !(ws.get(inj.id) !== null && !fs.existsSync(inj.path)),
      '记录存在=' + (ws.get(inj.id) !== null) + ' 目录存在=' + fs.existsSync(inj.path));
    check('#43b3 失败必须以带状态码的领域错误上报(现状:裸 EISDIR,statusCode 缺失)',
      injCode === 500 || injCode === 503, 'statusCode=' + injCode + ' msg=' + injMsg.substring(0, 70));
    check('#43b6 删除期落盘失败的错误必须含底层原因签名(现状:只报"未能落盘",原因被吞 → 运维分不清权限/磁盘/隔离,#54 同族)',
      /EISDIR|illegal operation/.test(injMsg), 'msg=' + injMsg.substring(0, 90));

    // ⑤ 撤掉注入 → 正常路径必须照旧(防"一律拒写/永不删文件"式假修复)
    injectOff();
    let retry = null, retryErr = '';
    try { retry = ws.remove(inj.id, { deleteFiles: true }); } catch (e) { retryErr = e.message; }
    check('#43b4 哨兵:注入物移除后正常删除必须仍成功(目录与记录一并消失)——防"永不删文件"式假修复',
      !!retry && retry.filesDeleted === true && !fs.existsSync(inj.path) && ws.get(inj.id) === null,
      'filesDeleted=' + (retry && retry.filesDeleted) + ' 目录在=' + fs.existsSync(inj.path) + ' 记录在=' + (ws.get(inj.id) !== null) + ' err=' + retryErr.substring(0, 60));
  }

  section('持久化');
  const state = JSON.parse(fs.readFileSync(store.FILES.workspaces, 'utf-8'));
  check('workspaces.json 已落盘且与内存视图一致', Array.isArray(state.workspaces) && state.workspaces.length === ws.list().length, String(state.workspaces?.length));

  section('CliAdapter:workspaceDir 作为执行目录');
  const probeWs = ws.create({ name: 'probe-ws' });
  const adapter = new CliAdapter({
    name: 'cwd-probe',
    displayName: 'CWD Probe',
    command: process.execPath,
    args: ['-e', 'console.log(process.cwd() + "|" + process.argv[1])', '{{workspaceDir}}'],
    inputMode: 'arg',
    outputMode: 'stdout-text',
    timeout: 15000
  });
  const outputDir = path.join(TMP, 'cli-output');
  const probe = await adapter.execute('ignored', { taskId: 'probe', workspaceDir: probeWs.path, outputDir });
  const [probeCwd, probeArg] = probe.content.trim().split('|');
  check('子进程 cwd = 工作区目录', samePath(probeCwd, probeWs.path), probeCwd);
  check('{{workspaceDir}} 模板已注入', samePath(probeArg, probeWs.path), probeArg);
  check('桥接中间产物仍写入 outputDir', fs.existsSync(outputDir));

  let missingError = '';
  try {
    await adapter.execute('x', { taskId: 'missing', workspaceDir: path.join(TMP, 'missing-ws'), outputDir });
  } catch (e) { missingError = e.message; }
  check('workspaceDir 不存在时明确报错', /工作区目录不存在/.test(missingError), missingError);

  // ── #81 可用位与执行解析两套逻辑不对称(指挥官亲笔锁定,编码手禁改) ──
  //   实况(全部经独立探针实测,见基线 commit):CliAdapter 有**两套**"命令在哪里"的判断 ——
  //     detect()(adapters/cli-adapter.js:51-60)  :  查 commandPaths(existsSync+isFile) → 否则 findInPath(command)
  //                                               findInPath(:216-226) 用 Windows `where`;而
  //                                               `where "C:\Program Files\nodejs\node.exe"` **退出码 2**
  //                                               (把盘符 C: 当成模式) ⇒ 绝对路径命令永远判不可用
  //     执行期 resolveWindowsCommand(:229-244)   :  先 isAbsolute+existsSync,再相对路径 existsSync,最后 where
  //                                               ⇒ 同一条配置"跑得动却被标不可用",被 server.js:787
  //                                                  的 availableTools 过滤挡在派发之外,拒绝文案还是
  //                                                  "未知工具/no_targets"(归因误导,#54 同族)
  //   第三个形态(预检时新挖出):commandPaths 命中而裸名 command 不在 PATH ⇒ detect=true 但 execute 抛
  //     "命令未找到或无法安全解析" —— commandPaths 成了一条"只喂可用位、不喂执行"的半截通道。
  //     生产实况:tools.json 里 3 条用了 commandPaths,其中 codely/codely-k3 指向的文件**实测不存在**,
  //     全靠裸名 codely 还在 PATH 才掩盖住(今天不发病,PATH 一变就成形态③,且零留痕)。
  //   主锁是**回环**(detect() === execute 是否成功):对修法不设形状要求 ——
  //     允许"诚实判不可用"或"执行期也认 commandPaths"两种正解,但禁止两侧不同尺。
  section('#81 可用位与执行解析必须同尺');
  {
    const echoArgs = ['-e', 'console.log("RAN81")'];
    const mk = (extra) => new CliAdapter({
      name: 'shape-probe', displayName: 'Shape Probe', transport: 'cli',
      inputMode: 'stdin', outputMode: 'stdout-text', timeout: 15000, ...extra
    });
    const outDir = path.join(TMP, 'shape-output');
    const relNode = path.relative(process.cwd(), process.execPath);
    const shapes = [
      { id: '绝对路径-无commandPaths', cfg: { command: process.execPath, args: echoArgs }, wantAvailable: true },
      { id: '相对cwd存在', cfg: { command: relNode, args: echoArgs }, wantAvailable: true },
      { id: '绝对路径不存在', cfg: { command: path.join(TMP, 'ghost-81.exe'), args: echoArgs }, wantAvailable: false },
      { id: '裸名不在PATH且无commandPaths', cfg: { command: 'zz-not-a-real-cmd-81', args: echoArgs }, wantAvailable: false },
      { id: 'commandPaths命中但裸名不可执行', cfg: { command: 'zz-not-a-real-cmd-81', commandPaths: [process.execPath], args: echoArgs }, wantAvailable: null },
      { id: 'commandPaths也不存在且裸名不可执行', cfg: { command: 'zz-not-a-real-cmd-81', commandPaths: [path.join(TMP, 'ghost-81b.exe')], args: echoArgs }, wantAvailable: false }
    ];
    const rows = [];
    for (const s of shapes) {
      let avail = null, ran = false, err = '';
      try { avail = await mk(s.cfg).detect(); } catch (e) { avail = 'THROW:' + e.message.substring(0, 40); }
      try {
        const r = await mk(s.cfg).execute('hi', { taskId: 'shape-81', outputDir: outDir });
        ran = /RAN81/.test(r.content || '');
      } catch (e) { ran = false; err = String(e.message || e.code || e).substring(0, 70); }
      rows.push({ id: s.id, want: s.wantAvailable, avail, ran, err });
    }
    const fmt = (r) => r.id + ': detect=' + JSON.stringify(r.avail) + ' execute成功=' + r.ran + (r.err ? ' err=' + r.err : '');
    const by = (id) => rows.find(r => r.id === id) || {};

    check('#81a1 红:绝对路径 command(未写 commandPaths)的 detect 必须为 true —— 它明明跑得动(现状 false,因 where 不认绝对路径)',
      by('绝对路径-无commandPaths').avail === true, fmt(by('绝对路径-无commandPaths')));
    check('#81a2 红:相对 cwd 存在的 command 的 detect 必须为 true(现状 false,而 execute 成功)',
      by('相对cwd存在').avail === true, fmt(by('相对cwd存在')));
    check('#81a3 哨兵:绝对路径指向不存在文件时 detect 必须仍为 false(禁止"一律返回 true"式假修复)',
      by('绝对路径不存在').avail === false && by('绝对路径不存在').ran === false, fmt(by('绝对路径不存在')));
    check('#81a4 哨兵:裸名不在 PATH 且无 commandPaths 时 detect 必须仍为 false',
      by('裸名不在PATH且无commandPaths').avail === false && by('裸名不在PATH且无commandPaths').ran === false, fmt(by('裸名不在PATH且无commandPaths')));
    check('#81a5 主锁(回环):全部 6 个形态必须 detect() 与 execute() 同尺 —— 对修法不设形状要求,'
      + '允许"诚实判不可用"或"执行期也认 commandPaths",但禁止"标着可用却派发即失败"(形态③)与"跑得动却标不可用"(形态①②)',
      rows.every(r => r.avail === r.ran), rows.map(fmt).join(' | '));
    check('#81a6 哨兵:不可执行时的报错必须带上那个 command 名(禁止泛化成"启动失败",#54 同族归因误导)',
      /zz-not-a-real-cmd-81/.test(by('裸名不在PATH且无commandPaths').err || ''), 'err=' + JSON.stringify(by('裸名不在PATH且无commandPaths').err));
  }

  // ── #73:隔离(quarantine)期间的按 id 寻址必须报"存储降级",绝不宣称"不存在" ──────────
  //   病根:`workspaces` 被隔离后 store.load 返回空结构,记录"看不见";而 requireRecord 把
  //   "看不见"直接判成"不存在" ⇒ 404。可事实是记录还在 .corrupt-* 保全件里(实测可证),
  //   受管目录也还在磁盘上。404 是一次**假的断言**,宿主/运维据此会去做错误决定(重建工作区、
  //   以为数据丢了)。与 #54/#74 同族(归因误导),与 #33/#34 同源(损坏状态不上报)。
  //   位置刻意放在全套件最后:注入会污染该 key 的后续读写。
  section('#73 隔离期间按 id 寻址必须 503 降级(不得谎报"不存在")');
  {
    const codeOf = (e) => (typeof e.statusCode === 'number' ? e.statusCode : null);
    const grab = (fn) => { try { return { ok: true, v: fn(), code: null, msg: '' }; } catch (e) { return { ok: false, v: null, code: codeOf(e), msg: String(e.message || e) }; } };

    const q = ws.create({ name: 'q73', description: '#73 隔离探针' });
    const BOGUS = 'ws_never_existed_73';

    // 前置(防恒真):未隔离时该 id 必须真在册,且"未知 id 必须 404"——这条同时是反向哨兵,
    //   防实现退化成"一律 503"(那等于把所有归因都糊成存储故障)。
    check('#73p0 前置:未隔离时 q73 必须真的在册(get 非 null)', ws.get(q.id) !== null, 'get=' + JSON.stringify(ws.get(q.id) && ws.get(q.id).name));
    check('#73r1 反向哨兵:未隔离时未知 id 必须仍是 404(防"一律 503"式假修复)',
      grab(() => ws.archive(BOGUS)).code === 404, 'code=' + grab(() => ws.archive(BOGUS)).code);
    check('#73r2 反向哨兵:未隔离时 archive(真 id) 必须成功(防"永远拒写"式假修复)',
      grab(() => ws.archive(q.id)).ok === true, 'msg=' + grab(() => ws.archive(q.id)).msg.substring(0, 70));
    grab(() => ws.restore(q.id)); // 复位,让后面四条走同一条"在册"路径

    // 注入损坏 → 触发隔离(实测形状:当前文件被改名成 workspaces.json.corrupt-*,load 回空结构)
    //   注意(我第一版锁在这里写错,已当场改):`.corrupt-*` 存的是**坏字节本身**(取证用),
    //   不是"上一次的好数据"。所以"把保全件拷回去就能恢复记录"是不可满足的断言——恢复的正解是
    //   运维用**自己修好的内容**放回文件再重启。下面按这个真实语义写。
    const goodBytes = fs.readFileSync(store.FILES.workspaces, 'utf-8'); // 损坏前的最后好状态(模拟运维手里的备份)
    fs.writeFileSync(store.FILES.workspaces, '{ "workspaces": [ 坏掉的 JSON', 'utf-8');
    const loaded = store.load('workspaces');
    const bak = fs.readdirSync(path.dirname(store.FILES.workspaces)).filter(f => /workspaces\.json\.corrupt-/.test(f));
    check('#73p1 前置:损坏注入必须真的把该 key 打进隔离态(有 .corrupt-* 保全件 且 原文件已不在原位)',
      bak.length === 1 && !fs.existsSync(store.FILES.workspaces) && !(loaded.workspaces || []).length,
      '保全件=' + JSON.stringify(bak) + ' 原文件在=' + fs.existsSync(store.FILES.workspaces) + ' load.workspaces=' + JSON.stringify((loaded.workspaces || []).length));
    check('#73p2 前置事实(取证语义):保全件存的是**坏字节**、不是好数据 —— 所以恢复必须靠修好的内容,别把"拷回保全件"当恢复路径',
      fs.readFileSync(path.join(path.dirname(store.FILES.workspaces), bak[0]), 'utf-8').includes('坏掉的 JSON') && !goodBytes.includes('坏掉的 JSON'),
      '保全件内含注入串=' + fs.readFileSync(path.join(path.dirname(store.FILES.workspaces), bak[0]), 'utf-8').includes('坏掉的 JSON') + ' 好字节大小=' + goodBytes.length);

    const a1 = grab(() => ws.archive(q.id));
    const a2 = grab(() => ws.restore(q.id));
    const a3 = grab(() => ws.remove(q.id, { deleteFiles: true }));
    const a4 = grab(() => ws.resolveForDispatch(q.id));
    const a5 = grab(() => ws.beginRun(q.id, 'run-73'));
    check('#73a1 隔离期 archive(在册 id) 必须 503 降级,不得 404 谎称"不存在"',
      a1.code === 503 && !/不存在/.test(a1.msg), 'code=' + a1.code + ' msg=' + a1.msg.substring(0, 90));
    check('#73a2 隔离期 restore(在册 id) 必须 503 —— 同一条 requireRecord 上的每个 op 都得同尺,防半修',
      a2.code === 503 && !/不存在/.test(a2.msg), 'code=' + a2.code + ' msg=' + a2.msg.substring(0, 90));
    check('#73a3 隔离期 remove(在册 id) 必须 503,且绝不因"看不见"就删受管目录(数据保全优先)',
      a3.code === 503 && fs.existsSync(q.path), 'code=' + a3.code + ' 目录在=' + fs.existsSync(q.path) + ' msg=' + a3.msg.substring(0, 70));
    check('#73a4 隔离期 resolveForDispatch(在册 id) 必须 503(派发前的"不存在"会把存储故障伪装成用户错误)',
      a4.code === 503 && !/不存在/.test(a4.msg), 'code=' + a4.code + ' msg=' + a4.msg.substring(0, 90));
    check('#73a5 隔离期 beginRun 必须 503 —— 租约路径不得绕过这道门(它经 resolveForDispatch,必须自动继承)',
      a5.code === 503, 'code=' + a5.code + ' msg=' + a5.msg.substring(0, 90));
    check('#73a6 隔离期连"未知 id"也不得判 404:此时无法证明任何记录不存在,只能说"无法判定"(503)',
      grab(() => ws.archive(BOGUS)).code === 503, 'code=' + grab(() => ws.archive(BOGUS)).code + ' msg=' + grab(() => ws.archive(BOGUS)).msg.substring(0, 70));
    check('#73a7 归因必须可操作:文案点名 workspaces 与隔离/降级,并给出去哪查(logs.jsonl 或 .corrupt-*),#54/#74 同族',
      /workspaces/.test(a1.msg) && /隔离|降级|损坏|无法判定/.test(a1.msg) && /logs\.jsonl|corrupt/.test(a1.msg),
      'msg=' + a1.msg.substring(0, 150));
    check('#73s1 隔离态必须是**单一真相源可查**的:store 导出 isQuarantined(key),防各调用点自造第二把尺(#81 同族病)',
      typeof store.isQuarantined === 'function' && store.isQuarantined('workspaces') === true && store.isQuarantined('switches') === false,
      'typeof=' + typeof store.isQuarantined + ' workspaces=' + (typeof store.isQuarantined === 'function' ? store.isQuarantined('workspaces') : 'n/a'));
    check('#73s2 反向:未受污染的 key 不得被连带判隔离(隔离判定必须按 key 粒度,不得全局熔断)',
      typeof store.isQuarantined === 'function' && store.isQuarantined('memory') === false,
      'memory=' + (typeof store.isQuarantined === 'function' ? store.isQuarantined('memory') : 'n/a'));

    // 收尾:把**修好的内容**放回原位(模拟运维用备份恢复),免得清理阶段撞上"注册表文件不存在"
    fs.writeFileSync(store.FILES.workspaces, goodBytes, 'utf-8');
    // 隔离是**进程级**脏标志(#30 的设计),所以"重启即恢复"这条语义必须被锁住:
    //   新进程读同一个数据目录 ⇒ 认得记录、且未知 id 回到 404。
    //   注意本文件是 ESM,没有 __dirname ⇒ 用 fileURLToPath 取模块目录。
    const { fileURLToPath } = require('node:url');
    const { execFileSync } = require('node:child_process');
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const childFile = path.join(TMP, 'child-73.cjs');
    fs.writeFileSync(childFile, [
      'process.env.AI_BRIDGE_DATA_DIR = ' + JSON.stringify(DATA_DIR) + ';',
      'process.env.AI_BRIDGE_WORKSPACE_ROOT = ' + JSON.stringify(ROOT) + ';',
      'const w = require(' + JSON.stringify(path.join(HERE, 'workspace-manager.js')) + ');',
      'let bogus = "no-throw";',
      'try { w.archive(' + JSON.stringify(BOGUS) + '); } catch (e) { bogus = String(e.statusCode); }',
      'console.log(JSON.stringify({ found: w.get(' + JSON.stringify(q.id) + ') !== null, bogus }));'
    ].join('\n'), 'utf-8');
    let childView = { found: false, bogus: 'child-failed', err: '' };
    try {
      const out = execFileSync(process.execPath, [childFile], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      childView = JSON.parse(out.trim().split('\n').pop());
    } catch (e) { childView.err = String(e.message || e).substring(0, 80); }
    check('#73s3 恢复文件后新进程必须重新认得该记录,且未知 id 回到 404(锁住"隔离=进程级脏标志,重启即恢复"的语义,防实现把它做成永久熔断)',
      childView.found === true && childView.bogus === '404',
      'found=' + childView.found + ' bogus=' + childView.bogus + ' err=' + childView.err);
  }

  // ── #74:隔离原因必须是**真因**,不得三处硬编"解析损坏" ──────────────────────
  //   实测(2026-10-23):把 workspaces.json 写成**顶层数组**(JSON 完全可解析,只是违反 SHAPES)
  //   触发隔离后,三条对外正文全部谎称"已因解析损坏被隔离":
  //     · workspace-manager.js:109 REFUSED_CAUSE(写被拒 ⇒ 500)
  //     · workspace-manager.js:198 #73 那条 503 —— **这处是我上一格自己造的**:我在规格里
  //       只要求文案含"隔离/降级/损坏"之一,却没区分"解析失败"与"形状非法"两类,于是放行了硬编的猜测
  //     · store.js:125 写闸门日志
  //   真因 store 一直知道:load 的 catch 给 e.message(解析类),assertShape 失败给 shapeReason()
  //   (如"顶层为数组(须 plain object)")。缺的只是把它存下来供下游组合。
  //   两个场景各起**独立子进程**:`_corrupt` 是进程级脏标志,同进程里先隔离过的 key 不会因
  //   换文件而重新分类(我差点在同一进程里改 env 做对照 —— 那是假对照)。
  section('#74 隔离原因必须说清真因(形状非法 ≠ 解析损坏)');
  {
    const { execFileSync } = require('node:child_process');
    const { fileURLToPath } = require('node:url');
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const childSrc = (mode) => [
      'const fs = require("fs");',
      'process.env.AI_BRIDGE_DATA_DIR = ' + JSON.stringify(path.join(TMP, '74-' + mode)) + ';',
      'process.env.AI_BRIDGE_WORKSPACE_ROOT = ' + JSON.stringify(path.join(TMP, '74root-' + mode)) + ';',
      'const store = require(' + JSON.stringify(path.join(HERE, 'store.js')) + ');',
      'const ws = require(' + JSON.stringify(path.join(HERE, 'workspace-manager.js')) + ');',
      'fs.writeFileSync(store.FILES.workspaces, ' + JSON.stringify(
        mode === 'shape' ? JSON.stringify([{ id: 'ghost' }])
          : mode === 'parse' ? '{ "workspaces": [ 坏 JSON'
            : JSON.stringify({ workspaces: [], version: 1 })) + ', "utf-8");',
      'store.load("workspaces");',
      'const out = { reason: typeof store.quarantineReason === "function" ? store.quarantineReason("workspaces") : "__NO_ACCESSOR__" };',
      mode === 'healthy'
        ? 'try { const r = ws.create({ name: "ok74" }); out.create = "ok"; try { ws.archive(r.id); out.archive = "ok"; } catch (e) { out.archive = String(e.statusCode) + "|" + String(e.message); } } catch (e) { out.create = String(e.statusCode) + "|" + String(e.message); out.archive = "skipped"; }'
        : 'try { ws.create({ name: "c74" }); out.create = "no-throw"; } catch (e) { out.create = String(e.statusCode) + "|" + String(e.message); }',
      mode !== 'healthy' ? 'try { ws.archive("ws_never_74"); out.archive2 = "no-throw"; } catch (e) { out.archive2 = String(e.statusCode) + "|" + String(e.message); }' : '',
      'console.log(JSON.stringify(out));'
    ].join('\n');
    const runChild = (mode) => {
      const file = path.join(TMP, '74-child-' + mode + '.cjs');
      fs.writeFileSync(file, childSrc(mode), 'utf-8');
      try {
        const out = execFileSync(process.execPath, [file], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
        return JSON.parse(out.trim().split('\n').pop());
      } catch (e) {
        return { crash: String(e.message || e).substring(0, 140) };
      }
    };
    const shape = runChild('shape');
    const parse = runChild('parse');
    const healthy = runChild('healthy');
    const txt = (o, k) => String((o && o[k]) || '');

    // 注意判据必须排除哨兵值本身:第一版我只查"非空字符串",而访问器不存在时子进程回的是
    // 字符串 "__NO_ACCESSOR__" ⇒ 锁在缺陷状态下**假绿**(实测这一版基线里 s1 竟然 PASS)。
    // 这是我自己第 7 次"锁数量对、内容错",在取基线时就地抓到并改掉。
    check('#74s1 单一真相源:store 必须暴露 quarantineReason(key) —— 隔离后返回**真因**(形状场景实测='
      + JSON.stringify(txt(shape, 'reason')).substring(0, 60) + ')',
      typeof shape.reason === 'string' && shape.reason.length > 0 && shape.reason !== '__NO_ACCESSOR__',
      'reason=' + JSON.stringify(shape.reason).substring(0, 120) + ' crash=' + txt(shape, 'crash'));
    check('#74s2 形状非法时写被拒的 500 正文必须说清是形状问题、**不得谎称"解析损坏"**'
      + '(现状:workspace-manager.js:109 的 REFUSED_CAUSE 硬编)',
      txt(shape, 'create').startsWith('500|') && !/解析损坏|解析失败/.test(txt(shape, 'create')) && /形状|顶层|数组/.test(txt(shape, 'create')),
      '正文=' + txt(shape, 'create').substring(0, 190));
    check('#74s3 形状非法时 #73 那条 503 同样不得谎称"解析损坏"(现状:workspace-manager.js:198 硬编)',
      txt(shape, 'archive2').startsWith('503|') && !/解析损坏|解析失败/.test(txt(shape, 'archive2')) && /形状|顶层|数组/.test(txt(shape, 'archive2')),
      '正文=' + txt(shape, 'archive2').substring(0, 190));
    check('#74s4 对照(反向):解析失败场景必须说"解析/JSON",不得反过来把解析错误报成形状问题 —— 防只改一边',
      txt(parse, 'create').startsWith('500|') && /解析|JSON/.test(txt(parse, 'create')) && !/形状非法|顶层为数组/.test(txt(parse, 'create')),
      '正文=' + txt(parse, 'create').substring(0, 190));
    // 判据刻意只约束"无换行 + 原因本身有界 + 总长有宽松上限(防堆栈整坨)",不锁死具体字数:
    // 若规定总长 ≤210,任何把原因写到 200 的正确实现都会红 —— 那是我犯过 6 次的不可满足锁。
    check('#74s5 原因必须压平且有界(不许塞整坨堆栈/换行,#54 同族):文案无 \\n、reason ≤200、总长 <400',
      !/\n/.test(txt(shape, 'create')) && String(shape.reason || '').length <= 200 && txt(shape, 'create').length < 400,
      'create 长=' + txt(shape, 'create').length + ' reason 长=' + String(shape.reason || '').length);
    // 围栏(结构锁):三处硬编的字面量必须归零。行为锁 s2~s4 是主证,这条只防"再抄第四处"
    const bs = fs.readFileSync(path.join(HERE, 'store.js'), 'utf-8').replace(/\r/g, '');
    const wm = fs.readFileSync(path.join(HERE, 'workspace-manager.js'), 'utf-8').replace(/\r/g, '');
    const hardwired = (bs + wm).split('本轮已因解析损坏被隔离').length - 1;
    check('#74s6 围栏:源码里硬编"本轮已因解析损坏被隔离"的字面量必须归零(实测三处:store.js:125、'
      + 'workspace-manager.js:109、:198)——文案要由 quarantineReason 组合,否则第 4 处迟早再冒出来',
      hardwired === 0, '残留字面量=' + hardwired);
    // 健康态反向哨兵**也必须起子进程**:主进程里 workspaces 已被 #73 段打过脏标志且永不复位
    // (那是 #30 的设计),在主进程里断言"健康"会得到一条假红 —— 我第一版就差点这么写。
    check('#74s7 反向哨兵:健康进程里 quarantineReason 必须是 null/false,且 create+archive 照旧成功'
      + '(防"一律 503/永久熔断"式假修复)',
      (healthy.reason === null || healthy.reason === false) && txt(healthy, 'create') === 'ok' && txt(healthy, 'archive') === 'ok',
      'reason=' + JSON.stringify(healthy.reason) + ' create=' + txt(healthy, 'create') + ' archive=' + txt(healthy, 'archive') + ' crash=' + txt(healthy, 'crash'));
  }

  // ── #75:回收失败且回滚也失败时,响应不得宣称"已恢复注册表登记" ──────────────
  //   病灶(workspace-manager.js:373-378):rmSync 抛错 → trySaveState(state) 回滚;回滚**失败**时
  //   先 appendLog('error', '…回滚失败,注册表与磁盘不一致需人工核查…'),紧接着却
  //   throw fail(500, '工作区目录回收失败，已恢复注册表登记: …') —— 同一个函数里一边记"没恢复"、
  //   一边对宿主宣称"恢复了"。比吞异常更坏:这是一句**积极错误的断言**,运维据此会认为无需人工核查。
  //   两场景各起独立子进程:注入 = 替换 fs.rmSync 模拟 OS 拒删,并在"假删除失败"的回调里顺手把
  //   workspaces 打成隔离态(模拟回滚时磁盘已坏)。全部在子进程内完成,主进程不受污染、仓库里不留钩子。
  section('#75 回滚失败时不得宣称"已恢复注册表登记"');
  {
    const { execFileSync } = require('node:child_process');
    const { fileURLToPath } = require('node:url');
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const runCase = (tag, body) => {
      const file = path.join(TMP, '75-child-' + tag + '.cjs');
      fs.writeFileSync(file, [
        'const fs = require("fs"), path = require("path");',
        'process.env.AI_BRIDGE_DATA_DIR = ' + JSON.stringify(path.join(TMP, '75-' + tag)) + ';',
        'process.env.AI_BRIDGE_WORKSPACE_ROOT = ' + JSON.stringify(path.join(TMP, '75root-' + tag)) + ';',
        'const store = require(' + JSON.stringify(path.join(HERE, 'store.js')) + ');',
        'const ws = require(' + JSON.stringify(path.join(HERE, 'workspace-manager.js')) + ');',
        'const rec = ws.create({ name: "r75" });',
        body,
        'console.log(JSON.stringify(out));'
      ].join('\n'), 'utf-8');
      try {
        const o = execFileSync(process.execPath, [file], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
        return JSON.parse(o.trim().split('\n').pop());
      } catch (e) { return { crash: String(e.message || e).substring(0, 150) }; }
    };
    // 场景①:回收失败 + 回滚也失败
    // 注:store.appendLog 是**异步落盘**(flushLogQueue 用 _logWriting 位防交错),短命子进程可能在
    //   写完成前就退出 —— 我第一版因此读到"日志行=0",那是**我的探针时序错**,不是产品没记。
    //   故这里等 600ms 再读日志(实测 400ms 内必落盘,留余量)。
    const both = runCase('both', [
      'const LOGP = path.join(process.env.AI_BRIDGE_DATA_DIR, "logs.jsonl");',
      'const realRm = fs.rmSync;',
      'fs.rmSync = (p, o) => {',
      '  fs.writeFileSync(store.FILES.workspaces, "{ bad", "utf-8"); store.load("workspaces");',
      '  const err = new Error("EBUSY: resource busy or locked (simulated)"); err.code = "EBUSY"; throw err;',
      '};',
      'const out = {};',
      'try { ws.remove(rec.id, { deleteFiles: true }); out.threw = "no-throw"; }',
      'catch (e) { out.code = e.statusCode; out.msg = String(e.message); }',
      'fs.rmSync = realRm;',
      'setTimeout(() => {',
      '  out.logs = fs.existsSync(LOGP) ? fs.readFileSync(LOGP, "utf-8").split("\\n").filter(Boolean).filter(l => /回滚|不一致|核查/.test(l)) : [];',
      '  console.log(JSON.stringify(out));',
      '}, 600);'
    ].join('\n'));
    // 场景②:回收失败但回滚**成功** —— 此时"已恢复注册表登记"是实话,必须仍然这么说(反向哨兵)
    const rbOk = runCase('rollback-ok', [
      'fs.rmSync = () => { const err = new Error("EBUSY (simulated)"); err.code = "EBUSY"; throw err; };',
      'const out = {};',
      'try { ws.remove(rec.id, { deleteFiles: true }); out.threw = "no-throw"; }',
      'catch (e) { out.code = e.statusCode; out.msg = String(e.message); }',
      'out.stillListed = ws.get(rec.id) !== null;'
    ].join('\n'));

    check('#75a1 回滚也失败时抛出的正文**不得宣称"已恢复注册表登记"**(现状:日志写"回滚失败…需人工核查"、'
      + '响应却写"已恢复"),状态码仍须 500',
      !!both.msg && !/已恢复注册表登记/.test(both.msg) && both.code === 500,
      'code=' + (both.code || 'n/a') + ' msg=' + String(both.msg || both.crash || both.threw || 'n/a').substring(0, 190));
    check('#75a2 正文必须如实说出"回滚未成功/需人工核查",并保留两条原因(回收原因 + 回滚原因,#54 同族)',
      !!both.msg && /回滚.*失败|未能恢复|不一致|人工核查/.test(both.msg) && /EBUSY/.test(both.msg),
      'msg=' + String(both.msg || '').substring(0, 200) + ' crash=' + String(both.crash || '').substring(0, 90));
    check('#75a3 日志与响应同真同假:回滚失败必须留 error 日志,且日志里不得混入"已恢复注册表登记"',
      Array.isArray(both.logs) && both.logs.length >= 1 && !/已恢复注册表登记/.test(both.logs.join('\n')),
      '日志行=' + (both.logs || []).length + ' 摘录=' + String((both.logs || [])[0] || '无').substring(0, 150));
    check('#75a4 反向哨兵:回滚**成功**时仍要说"已恢复注册表登记"且记录确实回到册内'
      + '(防实现为省事把文案一律改成"未知状态" —— 那是把诚实修成新的模糊)',
      !!rbOk.msg && /已恢复注册表登记/.test(rbOk.msg) && rbOk.code === 500 && rbOk.stillListed === true,
      'msg=' + String(rbOk.msg || rbOk.crash || 'n/a').substring(0, 170) + ' 在册=' + rbOk.stillListed);
  }
}

main()
  .catch(e => { failed++; failures.push('主流程异常'); process.stdout.write(`\n[ERROR] 异常: ${e.message}\n`); })
  .finally(() => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ }
    process.stdout.write('\n' + '='.repeat(40) + '\n');
    process.stdout.write(`总计: ${passed}/${passed + failed} 通过\n`);
    if (failed > 0) process.stdout.write(`失败: ${failures.join(', ')}\n`);
    process.exit(failed > 0 ? 1 : 0);
  });
