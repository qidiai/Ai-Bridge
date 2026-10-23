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
