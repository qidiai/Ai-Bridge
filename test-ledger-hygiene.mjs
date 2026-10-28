#!/usr/bin/env node
'use strict';

/**
 * #127 台账新鲜度守卫 —— 对抗测试(指挥官亲笔,锁定文件,编码手禁改)
 *
 * 针对的真实缺陷(本会话人工回源才查出,三处账实不符):
 *   1) 台账 head 指针写着实现轮,但按该提交的树逐面回算只命中一部分(文档面在后一个落账轮才改);
 *   2) 台账 updated 字段连续五轮没涨,而台账尾部已写到最新一轮;
 *   3) source_faces_owner 有十面没点名"该面最后一次被哪次提交改动"。
 *   既有锁一致性校验拿 hash-object 比工作树,工作树与落账轮同内容所以恒绿 —— 抓不到"指针与树不同名"。
 *
 * 被测对象(规格,编码手只许新增这一个文件):
 *   ai-bridge/check-ledger-hygiene.mjs   旁挂只读守卫,不在六套之内,不进 package.json 脚本面
 *   用法: node ai-bridge/check-ledger-hygiene.mjs [--repo <仓库根>] [--ledger <台账绝对路径>]
 *   默认 --repo 取守卫自身所在仓库根,--ledger 取 <repo>/ai-bridge/TEST-LOCK.json
 *
 * 输出契约(必须逐字满足,判据靠它匹配):
 *   J1 <PASS|FAIL> hits=<n>/<N> [missing: 面名,面名]
 *   J2 <PASS|FAIL> hits=<n>/<1> [missing: <实测槽位列表>]
 *   J3 <PASS|FAIL> hits=<n>/<N> [missing: 面名,面名]
 *   STATUS=ok 或 STATUS=drift
 *   退出码 0=全绿, 1=任一判据 FAIL(drift), 2=用法/环境错(含非 git 目录、台账不可解析)
 *   浅克隆必须显式 FAIL(退出码 1,并在 J1 行或其后一行点名 shallow),不得静默跳过
 *
 * 规格口径(逐条对应 CodeBuddy step-5 审稿的阻断项,指挥官已核准):
 *   B1 路径基准钉死: cwd=仓库根,git 路径一律 ai-bridge/<面名>;git 报路径不存在必须 FAIL 并点名,不得计为 0 命中静默通过
 *   B4 短哈希长度钉死: 一律 git rev-parse --short=7,禁止依赖 core.abbrev 浮动的 %h
 *   B3 J3 的唯一判据 = owner 文本含"该面末次提交"的 --short=7 哈希;槽位号**不作替代**
 *      (理由: 一条 owner 里并列六七个历史槽位号,"含 #NN" 无法区分点名与顺带提及;早期 T 系列提交根本没有槽位号)
 *   C6 反向自证必须有注入缝: 只能靠 --ledger 指拷贝件,真实台账只读不改
 *   C7 面数必须动态取 Object.keys(source_faces).length,禁止字面量;守卫自身要收编为台账的一员
 *   C8 head 语义: 使全部面与账面逐字节一致的那个 commit;TEST-LOCK 永不自列为面(否则文件要在自身内容里记自己的 blob 哈希,不可能不动点)
 *   补1 三条判据统一参照 head 所指提交(J2 的槽位也取自 head 的 subject,不取 git HEAD)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_CANDIDATES = [__dirname, path.resolve(__dirname, '..')];
const REPO = REPO_CANDIDATES.find((p) => fs.existsSync(p + '/.git')) || REPO_CANDIDATES[0];
const GUARD = path.join(__dirname, 'check-ledger-hygiene.mjs');
const LEDGER_CANDIDATES = [
  path.join(__dirname, '.local', 'TEST-LOCK.json'),
  path.join(__dirname, 'TEST-LOCK.json'),
  path.join(REPO, 'ai-bridge', 'TEST-LOCK.json'),
  path.join(REPO, 'TEST-LOCK.json')
];
const REAL_LEDGER = LEDGER_CANDIDATES.find((p) => fs.existsSync(p)) || null;
if (!REAL_LEDGER) {
  // TEST-LOCK.json is an internal ledger and is not part of the public repo.
  console.log('SKIP test-ledger-hygiene: TEST-LOCK.json not present (internal ledger, .local/)');
  process.exit(0);
}
const TMP = path.join(__dirname, 'test-runtime-data', 'ledger-hygiene-' + Date.now() + '-' + process.pid);

let passed = 0; let failed = 0; const fails = [];
let outsideRepo = null;
function check (name, cond, detail) {
  if (cond) { passed++; process.stdout.write('  ✅ ' + name + (detail ? '  [' + detail + ']' : '') + '\n'); }
  else { failed++; fails.push(name); process.stdout.write('  ❌ ' + name + '  原因: ' + detail + '\n'); }
}

function runGuard (args) {
  const r = spawnSync(process.execPath, args, { encoding: 'utf-8', cwd: REPO, timeout: 60000 });
  const out = String(r.stdout || '') + String(r.stderr || '');
  return { code: r.status, out, missing: r.error ? String(r.error.code || r.error.message) : null };
}
function lineOf (out, tag) {
  const m = out.split(/\r?\n/).find(l => l.trim().startsWith(tag + ' '));
  return m || null;
}
function hitsOf (line) {
  if (!line) return null;
  const m = line.match(/hits=(\d+)\/(\d+)/);
  return m ? { n: Number(m[1]), total: Number(m[2]) } : null;
}
function verdictOf (line) { return !line ? null : (line.includes('PASS') ? 'PASS' : line.includes('FAIL') ? 'FAIL' : null); }

fs.mkdirSync(TMP, { recursive: true });
const realLedgerText = fs.readFileSync(REAL_LEDGER, 'utf-8');
const realLedger = JSON.parse(realLedgerText);
const faceNames = Object.keys(realLedger.source_faces);
const N = faceNames.length;
process.stdout.write(`#127 台账新鲜度守卫对抗测试  真实台账面数(动态取)=${N}  head=${realLedger.head}\n`);

function writeFixture (name, mutate) {
  const j = JSON.parse(realLedgerText);
  mutate(j);
  const p = path.join(TMP, name);
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n', 'utf-8');
  return p;
}

try {
  // ── a0 守卫存在且可执行(基线预期红:文件尚未实现) ──
  check('#127a0 守卫脚本存在且能跑起来(非零退出码不等于跑不起来)',
    fs.existsSync(GUARD),
    fs.existsSync(GUARD) ? GUARD : '文件不存在: ai-bridge/check-ledger-hygiene.mjs(红基线预期)');

  if (!fs.existsSync(GUARD)) {
    process.stdout.write('守卫未实现,后续判据无法执行 —— 逐条记红(不许静默绿)\n');
    for (const nm of ['#127a1', '#127a1b', '#127a2', '#127a2b', '#127a2c', '#127a3', '#127a4', '#127a5', '#127a6', '#127a6b', '#127a7', '#127a8', '#127a10', '#127a10b']) {
      check(nm + ' (依赖守卫实现)', false, '守卫脚本尚未实现');
    }
  } else {
    // ── a1 现状必须全绿(可满足性自证:正确实现下 STATUS=ok) ──
    const g1 = runGuard([GUARD, '--repo', REPO, '--ledger', REAL_LEDGER]);
    const l1 = lineOf(g1.out, 'J1'); const l2 = lineOf(g1.out, 'J2'); const l3 = lineOf(g1.out, 'J3');
    const h1 = hitsOf(l1); const h3 = hitsOf(l3);
    check('#127a1 全绿路径成立: 真台账下 J1 必须 PASS 且 hits 等于动态面数(禁字面量)',
      verdictOf(l1) === 'PASS' && h1 && h1.total === N && h1.n === h1.total,
      'J1行=' + JSON.stringify(l1) + ' 退出码=' + g1.code);
    check('#127a1b 全绿路径成立: J2/J3 同时 PASS(J3 命中数亦等于动态面数)且末行 STATUS=ok 退出码 0',
      verdictOf(l2) === 'PASS' && verdictOf(l3) === 'PASS' && h3 && h3.n === h3.total && h3.total === N && /STATUS=ok/.test(g1.out) && g1.code === 0,
      'J2行=' + JSON.stringify(l2) + ' J3行=' + JSON.stringify(l3) + ' J3命中=' + JSON.stringify(h3) + ' 退出码=' + g1.code + ' 输出尾=' + g1.out.trim().split(/\r?\n/).slice(-1)[0]);

    // ── a2 注入 head 指回旧实现轮(B1/D1 的真实错案): 必须红且逐面报名 ──
    // 真值脱靶集合由测试自己算(不采信守卫的自述),再要求守卫的 [missing: ...] 与之严格相等。
    // 原写法拿扩展名猜"文档面"(README/ARCHITECTURE/ui.html)并要求全部出现在报名里 —— 实测 ce6ac9f 只漂两面、ui.html 未漂,
    // 于是任何按规格"missing 只列脱靶面"的实现都满足不了该断言(#47 同族错,指挥官自账)。
    const expectedDrift = faceNames.filter(f => {
      const r = spawnSync('git', ['-C', REPO, 'rev-parse', '--verify', 'ce6ac9f:ai-bridge/' + f], { encoding: 'utf-8' });
      const got = String(r.stdout || '').trim();
      return got !== realLedger.source_faces[f];
    });
    const nonDrift = faceNames.filter(f => !expectedDrift.includes(f));
    const missingOf = (line) => {
      const m = String(line || '').match(/\[missing:\s*([^\]]*)\]/);
      return m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : null;
    };
    const f2 = writeFixture('ledger-head-old.json', j => { j.head = 'ce6ac9f'; });
    const g2 = runGuard([GUARD, '--repo', REPO, '--ledger', f2]);
    const h2 = hitsOf(lineOf(g2.out, 'J1'));
    const miss2 = missingOf(lineOf(g2.out, 'J1'));
    check('#127a2 注入"head 指旧轮"后 J1 必须 FAIL 且 hits 严格小于面数(17/19 那类错案被抓)',
      verdictOf(lineOf(g2.out, 'J1')) === 'FAIL' && h2 && h2.n < h2.total && h2.total - h2.n === expectedDrift.length,
      'J1行=' + JSON.stringify(lineOf(g2.out, 'J1')) + ' 测试自算真值脱靶数=' + expectedDrift.length);
    check('#127a2b 守卫报的脱靶集合必须与测试独立算出的真值集合严格相等(少报=定位不了,多报=名单凑数)',
      Array.isArray(miss2) && expectedDrift.length > 0 && miss2.length === expectedDrift.length && expectedDrift.every(f => miss2.includes(f)) && /STATUS=drift/.test(g2.out) && g2.code === 1,
      '真值=' + JSON.stringify(expectedDrift) + ' 守卫报=' + JSON.stringify(miss2));
    check('#127a2c 反向锁:未漂移的面绝不允许出现在 missing 里(堵住"另打一行全量面清单"来糊弄报名判据这条路)',
      Array.isArray(miss2) && !miss2.some(f => nonDrift.includes(f)),
      'missing=' + JSON.stringify(miss2) + ' 其中不该出现的未漂面=' + JSON.stringify(miss2 ? miss2.filter(f => nonDrift.includes(f)) : null));

    // ── a3 摘掉某面 owner 的末次提交标签: J3 必须红且只点名该面 ──
    const victim = 'store.js';
    const f3 = writeFixture('ledger-owner-stripped.json', j => { j.source_faces_owner[victim] = '故意抹掉一切可回源引用的文本(编码手不得用此口径凑绿)'; });
    const g3 = runGuard([GUARD, '--repo', REPO, '--ledger', f3]);
    const l3b = lineOf(g3.out, 'J3');
    check('#127a3 owner 被抹掉末次提交 ⇒ J3 FAIL、hits 少一、且点名该面而不点别的面',
      verdictOf(l3b) === 'FAIL' && String(l3b).includes(victim) && !String(l3b).includes('db.js'),
      'J3行=' + JSON.stringify(l3b));

    // ── a4 面名指向不存在路径(重命名/大小写攻击, B1 口径) ──
    const f4 = writeFixture('ledger-ghost-face.json', j => { j.source_faces['ghost-not-exist.js'] = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; j.source_faces_owner['ghost-not-exist.js'] = '不存在的面(应被抓出而非静默计数)'; });
    const g4 = runGuard([GUARD, '--repo', REPO, '--ledger', f4]);
    check('#127a4 台账里多出一个仓库中不存在的面 ⇒ 必须 FAIL 并点名该面,不得因"git 取不到"退化为 0 命中静默通过',
      (/ghost-not-exist\.js/.test(g4.out)) && g4.code === 1 && !/STATUS=ok/.test(g4.out),
      '退出码=' + g4.code + ' 输出片段=' + g4.out.replace(/\r?\n/g, ' | ').substring(0, 240));

    // ── a5 owner 里的哈希被拦腰截断(本会话真实教训: 摘录把 1220113 切成 12201) ──
    // 注意: 截断必须切在哈希上。哈希出现在 owner 开头(形如 #123(b0ca963)),截尾反而碰不到它 —— 那会让本条在任何正确实现下都打不绿。
    const fullOwner = String(realLedger.source_faces_owner[victim]);
    const hashAt = fullOwner.match(/\(([0-9a-f]{7})\)/);
    const cut = hashAt ? fullOwner.replace('(' + hashAt[1], '(' + hashAt[1].substring(0, 4)) : fullOwner.substring(0, fullOwner.length - 4);
    const f5 = writeFixture('ledger-owner-truncated.json', j => { j.source_faces_owner[victim] = cut; });
    const g5 = runGuard([GUARD, '--repo', REPO, '--ledger', f5]);
    check('#127a5 owner 文本里的末次提交哈希被截断成 4 位 ⇒ J3 必须 FAIL(截断即红,禁止"看起来像就过")',
      verdictOf(lineOf(g5.out, 'J3')) === 'FAIL' && String(lineOf(g5.out, 'J3')).includes(victim),
      'J3行=' + JSON.stringify(lineOf(g5.out, 'J3')) + ' 注入内容=' + JSON.stringify(cut.substring(0, 24)) + ' 原哈希=' + (hashAt ? hashAt[1] : '未定位'));

    // ── a6 非 git 目录 ⇒ 用法/环境错,退出码 2,不得当全绿 ──
    // fixture 必须真在仓库之外:原先建在 <仓库根>/ai-bridge/test-runtime-data 下,git 向上能找到仓库,
    // is-inside-work-tree 返回 true,这条其实没测到"非 git 目录"(编码手 PROPOSALS#2 报回,采纳)。
    const notRepo = path.join(os.tmpdir(), 'lh127-not-a-repo-' + process.pid);
    outsideRepo = notRepo;
    fs.mkdirSync(notRepo, { recursive: true });
    const g6 = runGuard([GUARD, '--repo', notRepo, '--ledger', REAL_LEDGER]);
    check('#127a6 --repo 指向仓库外的非 git 目录 ⇒ 退出码 2 且给出原因(不得静默返回 ok)',
      g6.code === 2 && /git|仓库|repo/i.test(g6.out),
      '退出码=' + g6.code + ' 输出片段=' + g6.out.replace(/\r?\n/g, ' | ').substring(0, 200));
    // a6b: 合法仓库的**子目录**当 --repo ⇒ 也必须退 2(把编码手申报的"偏离①:--repo 必须等于 --show-toplevel"锁进判据,
    // 不留给实现自由裁量;理由已实测:cwd 落在子目录时 git log 的路径口径会变,守卫曾静默给出 J3 全脱靶的误导读数)
    const g6b = runGuard([GUARD, '--repo', path.join(REPO, 'ai-bridge'), '--ledger', REAL_LEDGER]);
    check('#127a6b --repo 指仓库子目录(路径基准被破坏,会造成 J3 静默全脱靶的误导读数) ⇒ 退出码 2 并点名仓库根',
      g6b.code === 2 && /仓库根|toplevel|repo/i.test(g6b.out),
      '退出码=' + g6b.code + ' 输出片段=' + g6b.out.replace(/\r?\n/g, ' | ').substring(0, 200));

    // ── a7 浅克隆必须显式红(不得静默跳过;这是 CI 侧的前提自验) ──
    const shallow = path.join(TMP, 'shallow-clone');
    const clone = spawnSync('git', ['clone', '--depth', '1', '-q', 'file:///' + REPO.replace(/\\/g, '/'), shallow], { encoding: 'utf-8', timeout: 120000 });
    const isShallow = spawnSync('git', ['-C', shallow, 'rev-parse', '--is-shallow-repository'], { encoding: 'utf-8' });
    if (clone.status !== 0 || String(isShallow.stdout || '').trim() !== 'true') {
      check('#127a7 浅克隆必须显式 FAIL(工装未能建出浅仓库,如实记红而不是跳过)', false,
        'clone状态=' + clone.status + ' is-shallow读数=' + JSON.stringify(String(isShallow.stdout || '').trim()) + ' err=' + String(clone.stderr || '').substring(0, 140));
    } else {
      const g7 = runGuard([GUARD, '--repo', shallow, '--ledger', path.join(shallow, 'ai-bridge', 'TEST-LOCK.json')]);
      check('#127a7 浅克隆仓库下守卫必须 FAIL 并点名浅历史(退出码非 0,绝不输出 STATUS=ok)',
        g7.code !== 0 && !/STATUS=ok/.test(g7.out) && /shallow|浅/i.test(g7.out),
        '退出码=' + g7.code + ' 输出片段=' + g7.out.replace(/\r?\n/g, ' | ').substring(0, 220));
    }

    // ── a8 结构锁: 只读守卫不得有任何写盘能力,且面数不得写死 ──
    const src = fs.readFileSync(GUARD, 'utf-8');
    const writeApis = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync', 'createWriteStream', 'copyFileSync'];
    const hitsWrite = writeApis.filter(a => src.includes(a + '('));
    check('#127a8a 守卫全文必须零写盘 API(它只许读 git 与台账;写盘即污染受测对象)',
      hitsWrite.length === 0, '命中: ' + JSON.stringify(hitsWrite));
    check('#127a8b 面数必须动态取,禁止把当前 19 写死进判据',
      !/===\s*19\b|==\s*19\b/.test(src) && /Object\.keys\(/.test(src),
      '含字面 19 比较=' + (/===\s*19\b|==\s*19\b/.test(src)) + ' 含 Object.keys=' + /Object\.keys\(/.test(src));
    check('#127a8c 短哈希必须钉死为 short=7 口径(不依赖 core.abbrev 浮动的 %h)',
      /--short=7/.test(src), '源码含 --short=7=' + /--short=7/.test(src));
    // ── a10 台账 head 是外部可控文本:以 - 开头可能被 git 当选项解析(选项注入面) ──
    // 分两把尺,别再犯"锁文案"第 9 次:
    //   a10  行为锁(现状已安全 ⇒ 本条应为绿,作用是防未来回归):注入 - 开头的 head 后,守卫必须 drift、逐面点名、回显原值
    //   a10c 结构锁(现状缺 ⇒ 本条应为红):源码必须在把 head 交给 git **之前**做形状白名单,或用 --end-of-options 阻断选项解析
    const evil = writeFixture('ledger-head-injection.json', j => { j.head = '--show-toplevel'; });
    const g10 = runGuard([GUARD, '--repo', REPO, '--ledger', evil]);
    const h10 = hitsOf(lineOf(g10.out, 'J1'));
    check('#127a10 行为锁:注入以 - 开头的 head ⇒ 必须 drift(退出码非0、无 STATUS=ok)、J1 逐面点名、且原值被回显(不锁任何措辞)',
      g10.code === 1 && !/STATUS=ok/.test(g10.out) && verdictOf(lineOf(g10.out, 'J1')) === 'FAIL' && h10 && h10.n === 0 && h10.total === N && g10.out.includes('--show-toplevel'),
      '退出码=' + g10.code + ' J1=' + JSON.stringify(lineOf(g10.out, 'J1')) + ' 回显原值=' + g10.out.includes('--show-toplevel'));
    check('#127a10b 行为锁补牙:仓库根路径绝不得被当成"解析成功的 head"写入(选项被 git 吞掉时的最坏形态)',
      !lineOf(g10.out, 'J1').includes(REPO.replace(/\\/g, '/')) && g10.code === 1,
      'J1行=' + JSON.stringify(lineOf(g10.out, 'J1')));
    const src10 = fs.readFileSync(GUARD, 'utf-8');
    const hasShapeGate = /--end-of-options/.test(src10) || /headRaw[^\n]*(startsWith\(['-]|match\(|test\()/.test(src10) || /\^\[-[0-9a-zA-Z]/.test(src10);
    check('#127a10c 结构锁:head 交给 git 之前必须有形状白名单或 --end-of-options(否则台账文本可直接影响命令行解析,属注入面)',
      hasShapeGate,
      '含 --end-of-options=' + /--end-of-options/.test(src10) + ' 含 head 形状校验=' + /headRaw[^\n]*(startsWith\(|match\(|test\()/.test(src10));
  }

  // ── a9 真实台账全程只读(反向自证绝不允许污染原件) ──
  const after = fs.readFileSync(REAL_LEDGER, 'utf-8');
  check('#127a9 跑完全部注入用例后真实台账逐字节未变(所有漂移都只活在拷贝里)',
    after === realLedgerText,
    '原长=' + Buffer.byteLength(realLedgerText, 'utf-8') + ' 现长=' + Buffer.byteLength(after, 'utf-8'));
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { process.stdout.write('清理临时目录失败: ' + e.message + '\n'); }
  if (outsideRepo) { try { fs.rmSync(outsideRepo, { recursive: true, force: true }); } catch (e) { process.stdout.write('清理仓库外临时目录失败: ' + e.message + '\n'); } }
}

process.stdout.write(`总计: ${passed}/${passed + failed} 通过\n`);
if (failed) process.stdout.write('红项: ' + fails.join(', ') + '\n');
process.exit(failed ? 1 : 0);
