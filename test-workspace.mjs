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
    fs.mkdirSync(tmpPath, { recursive: true });

    // ① 创建期(注入仍在时)——先测这条,因为它和删除期共用同一个注入物
    let cCode = null, cMsg = '', cPath = null;
    try { cPath = ws.create({ name: 'inj-create', description: '#43c1 创建期写失败' }).path; }
    catch (e) { cCode = (typeof e.statusCode === 'number' ? e.statusCode : null); cMsg = e.message; }
    check('#43c1 创建期落盘失败须回传 5xx、不得留下孤儿目录、错误须含底层原因签名(EISDIR 不得被吞)',
      (cCode === 500 || cCode === 503) && (cPath === null || !fs.existsSync(cPath)) && /EISDIR|illegal operation/.test(cMsg),
      'code=' + cCode + ' 目录在=' + (cPath === null ? 'n/a' : fs.existsSync(cPath)) + ' msg=' + cMsg.substring(0, 80));

    // ② 删除期:先落盘后回收
    let injCode = null, injMsg = '';
    try { ws.remove(inj.id, { deleteFiles: true }); } catch (e) { injCode = (typeof e.statusCode === 'number' ? e.statusCode : (typeof e.status === 'number' ? e.status : null)); injMsg = e.message; }
    check('#43b1 注册表落盘失败时不得删除受管目录(现状:rmSync 已先删掉目录,落盘随后才失败)',
      fs.existsSync(inj.path), '目录仍在=' + fs.existsSync(inj.path) + ' err=' + injMsg.substring(0, 70));
    check('#43b2 不得留下"注册表仍指向、目录已消失"的悬空记录(现状:记录在 + 目录没 = 后续 dispatch 必失败且难归因)',
      !(ws.get(inj.id) !== null && !fs.existsSync(inj.path)),
      '记录存在=' + (ws.get(inj.id) !== null) + ' 目录存在=' + fs.existsSync(inj.path));
    check('#43b3 失败必须以带状态码的领域错误上报(现状:裸 EISDIR,statusCode 缺失)',
      injCode === 500 || injCode === 503, 'statusCode=' + injCode + ' msg=' + injMsg.substring(0, 70));
    check('#43b6 删除期落盘失败的错误必须含底层原因签名(现状:只报"未能落盘",原因被吞 → 运维分不清权限/磁盘/隔离,#54 同族)',
      /EISDIR|illegal operation/.test(injMsg), 'msg=' + injMsg.substring(0, 90));

    // ③ 撤掉注入 → 正常路径必须照旧(防"一律拒写/永不删文件"式假修复)
    fs.rmSync(tmpPath, { recursive: true, force: true });
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
