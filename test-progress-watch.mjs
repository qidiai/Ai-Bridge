#!/usr/bin/env node
'use strict';

/**
 * #130 派工心跳观察器 —— 对抗测试(指挥官亲笔,锁定文件,编码手禁改)
 *
 * 真实缺口(2026-10-25 本会话实测,零推测):
 *   1) 中枢派发的多轮 CLI 只回传末条 stdout: 一次 291.6s 的真实审稿只交回 68 字符;另一次跑到 600s 被 SIGTERM,
 *      正文仅剩尾部 247 字符(#131/#134)。2) 对进行中的派发,指挥官能看到的只有一个计数
 *      (GET /api/health => activeDispatches=1),没有任何"它在干什么"。
 *   3) Qoder 子代理侧平台不推流,但被派工者可以**自己每步落盘**: T127 用的 progress.jsonl(9 步,plan→handback)
 *      已被证明可用,本格把它固化成契约 + 常驻观察器。
 *
 * 判活口径(用户 2026-10-25 明确纠正,写死在此): **看新步骤(seq 推进),不看字节增长。**
 *   "输出没增长就收割"是错判据,会把"想得多/慢"的合法深思误杀 ⇒ 必须多态而非二态。
 *
 * 被测对象(编码手只许新增这一个文件): ai-bridge/watch-agent-progress.mjs
 *   用法: node ai-bridge/watch-agent-progress.mjs --file <progress.jsonl 绝对路径> --budget-ms <n>
 *                [--stale-ms <n>] [--interval-ms <n>] [--once]
 *   默认 stale-ms=60000 interval-ms=5000。阈值必须是具名常量 DEFAULT_STALE_MS / DEFAULT_INTERVAL_MS。
 *   心跳契约(每行一个 JSON): {"ts":"<ISO>","seq":<从1递增>,"step":"plan|read|write|test-run|test-result|blocker|handback",
 *                            "detail":"<≤200字符>","files":[...],"checks":{...}}
 *
 * 输出协议(断言只解析这些标记,不锁任何自然语言措辞):
 *   VERDICT=<WORKING|THINKING|STALLED|STALE|STALE-NO-HEARTBEAT|HANDED-BACK|BLOCKED>
 *   metrics: seq=<n> distinct=<n> heartbeat_age_s=<f> budget_used_ms=<n> budget_limit_ms=<n> files=<n>
 *   仅当存在解析失败的行时输出: CONTRACT-BAD-LINE: <行号,行号,...>
 *   状态判据(必须严格按此实现,七态互斥且完备):
 *     STALE-NO-HEARTBEAT  文件不存在或无一条可解析 ⇒ exit 1
 *     HANDED-BACK         **最后一条心跳(按 ts 最大;ts 相等取文件里靠后者)的 step=handback** ⇒ exit 0，优先级高于静默钟
 *     BLOCKED             **最后一条心跳的 step=blocker** ⇒ exit 0，同上（自我申报停工不等于卡死）
 *     STALE               非终态且 heartbeat_age_ms > stale_ms 且 budget_used_ms > budget_ms ⇒ exit 1
 *     STALLED             非终态且 heartbeat_age_ms > stale_ms 但预算未超 ⇒ exit 0(只报,不建议收割)
 *     WORKING             年龄新鲜且 distinct seq ≥ 2 ⇒ exit 0
 *     THINKING            年龄新鲜但 distinct seq ≤ 1(在同一个判断里)⇒ exit 0
 *   #135 的本会话实测红：交工后静默会被时间判据误判 STALE（可收割），而 handback/blocker 是
 *   被派工者自己申报的**终止态**；但终态判据必须只看"按 ts 最后那一条"，否则一个文件里只要
 *   出现过 handback 就永不判死，STALE 会被新缺陷抵消。
 *   #143 追加口径：**"按 ts 最后那一条"在 ts 相等(平局)时必须取文件里靠后的那条**(后写者胜)。
 *   选 lastBeat 若用严格 `>`,平局会保留先出现的那条 ⇒ 同秒写 [read,handback] 时交工申报被吞、
 *   已交工的仍被判 STALE/退 1;同秒写 [handback,read] 时又会把还在干活的钉成终态。
 *   契约只要求 ts 是 ISO、**不强制毫秒精度**,故宿主写秒级粒度时同秒两步必然并列,这不是极端输入。
 *   detail 超长必须截断且带标记(…(已截断,原长 N 字符) 或等价的"截断/truncat"字样),
 *   且**任何单行输出 ≤ 400 字符**(防灌爆指挥官终端)。
 *   只许读: 不得有任何写盘 API;不得有任何终止/中断能力(收割由指挥官决定)。
 *   参数非法(非正整数)⇒ 退出码 2 并点名是哪个参数(与 #96/#101 env-int 同族口径)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCHER = path.join(__dirname, 'watch-agent-progress.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'p130-'));

let passed = 0; let failed = 0; const fails = [];
function check (name, cond, detail) {
  if (cond) { passed++; process.stdout.write('  ✅ ' + name + (detail ? '  [' + detail + ']' : '') + '\n'); }
  else { failed++; fails.push(name); process.stdout.write('  ❌ ' + name + '  原因: ' + detail + '\n'); }
}
function run (args) {
  const r = spawnSync(process.execPath, [WATCHER, ...args], { encoding: 'utf-8', timeout: 60000 });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const m = out.match(/VERDICT=([A-Z-]+)/);
  return { code: r.status, out, verdict: m ? m[1] : null };
}
function mk (name, lines) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf-8');
  return p;
}
const now = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();
const hb = (seq, ageMs, step, detail) => JSON.stringify({ ts: iso(now() - ageMs), seq, step: step || 'read', detail: detail || ('第 ' + seq + ' 步'), files: ['ai-bridge/x.js'], checks: {} });
// 平局用例必须共享同一个 ts 字面量:两次 now() 会差亚毫秒,判据就变成随机锁(#115 同族的假红)
const hbTs = (seq, tsIso, step, detail) => JSON.stringify({ ts: tsIso, seq, step: step || 'read', detail: detail || ('第 ' + seq + ' 步'), files: ['ai-bridge/x.js'], checks: {} });

process.stdout.write('#130 派工心跳观察器对抗测试 (隔离临时目录,无网络,不占端口)\n');

try {
  check('#130a0 观察器脚本存在(基线预期红:尚未实现)', fs.existsSync(WATCHER),
    fs.existsSync(WATCHER) ? WATCHER : '文件不存在: ai-bridge/watch-agent-progress.mjs(红基线预期)');

  if (!fs.existsSync(WATCHER)) {
    for (const n of ['#130a1', '#130a2', '#130a2b', '#130a3', '#130a4', '#130a5', '#130a6', '#130a7', '#130a8', '#130a9a', '#130a9b', '#130a9c', '#130a10', '#135a1', '#135a2', '#135a3', '#135a4', '#135a5', '#143a1', '#143a2', '#143a3', '#143a4']) {
      check(n + ' (依赖观察器实现)', false, '观察器尚未实现');
    }
  } else {
    const f1 = mk('p-working.jsonl', [hb(1, 3000), hb(2, 2000), hb(3, 1000, 'write')]);
    const r1 = run(['--file', f1, '--budget-ms', '600000', '--stale-ms', '60000', '--once']);
    check('#130a1 seq 推进且心跳新鲜 ⇒ VERDICT=WORKING 且退出码 0',
      r1.verdict === 'WORKING' && r1.code === 0, 'verdict=' + r1.verdict + ' 退出码=' + r1.code + ' 输出=' + JSON.stringify(r1.out.replace(/\r?\n/g, ' | ').substring(0, 200)));

    const f2 = mk('p-thinking.jsonl', [hb(4, 45000), hb(4, 2000)]);
    const r2 = run(['--file', f2, '--budget-ms', '600000', '--stale-ms', '60000', '--once']);
    check('#130a2 心跳在更新但 seq 没动 ⇒ VERDICT=THINKING 且退出码 0(慢/想得多的模型不得被误杀)',
      r2.verdict === 'THINKING' && r2.code === 0, 'verdict=' + r2.verdict + ' 退出码=' + r2.code);

    const r2b = run(['--file', f2, '--budget-ms', '1000', '--stale-ms', '60000', '--once']);
    check('#130a2b 预算已超但心跳新鲜 ⇒ 仍不得判 STALE(钉住"超预算"单独不构成判死条件)',
      r2b.verdict !== 'STALE' && r2b.code === 0, 'verdict=' + r2b.verdict + ' 退出码=' + r2b.code);

    const f3 = mk('p-stale.jsonl', [hb(5, 120000, 'test-run')]);
    const r3 = run(['--file', f3, '--budget-ms', '120000', '--stale-ms', '30000', '--once']);
    check('#130a3 静默 120s 超 stale 且预算已用满 ⇒ VERDICT=STALE 且退出码 1',
      r3.verdict === 'STALE' && r3.code === 1, 'verdict=' + r3.verdict + ' 退出码=' + r3.code);

    const r4 = run(['--file', path.join(TMP, 'no-such.jsonl'), '--budget-ms', '600000', '--once']);
    check('#130a4 没有心跳文件 ⇒ VERDICT=STALE-NO-HEARTBEAT 且退出码 1(不许当"在想"放过)',
      r4.verdict === 'STALE-NO-HEARTBEAT' && r4.code === 1, 'verdict=' + r4.verdict + ' 退出码=' + r4.code);

    const f5 = mk('p-quiet-in-budget.jsonl', [hb(2, 90000)]);
    const r5 = run(['--file', f5, '--budget-ms', '600000', '--stale-ms', '30000', '--once']);
    check('#130a5 静默超 stale 但预算只用 15% ⇒ 必须判 STALLED 且退出码 0(两条件同时成立才叫 STALE)',
      r5.verdict === 'STALLED' && r5.code === 0, 'verdict=' + r5.verdict + ' 退出码=' + r5.code);

    const f6 = path.join(TMP, 'p-broken.jsonl');
    fs.writeFileSync(f6, hb(1, 1000) + '\n这一行不是 JSON\n' + hb(2, 500) + '\n', 'utf-8');
    const r6 = run(['--file', f6, '--budget-ms', '600000', '--once']);
    check('#130a6 心跳文件里有坏行 ⇒ 必须输出 CONTRACT-BAD-LINE 并点名第 2 行,不得静默当不存在',
      /CONTRACT-BAD-LINE:[^\n]*\b2\b/.test(r6.out), '退出码=' + r6.code + ' 输出=' + JSON.stringify(r6.out.replace(/\r?\n/g, ' | ').substring(0, 240)));

    const r7 = run(['--file', f1, '--budget-ms', 'abc', '--once']);
    check('#130a7 --budget-ms 非法值 ⇒ 退出码 2 且点名该参数(不得静默回落默认值)',
      r7.code === 2 && /budget-ms/.test(r7.out), '退出码=' + r7.code + ' 输出=' + JSON.stringify(r7.out.replace(/\r?\n/g, ' | ').substring(0, 180)));

    const f8 = mk('p-longdetail.jsonl', [hb(1, 1000, 'read', '长'.repeat(3000))]);
    const r8 = run(['--file', f8, '--budget-ms', '600000', '--once']);
    const longest = r8.out.split(/\r?\n/).reduce((a, b) => (b.length > a.length ? b : a), '');
    check('#130a8 detail 3000 字符 ⇒ 任何单行输出 ≤400 字符且带截断留痕(防灌爆指挥官终端)',
      longest.length <= 400 && /截断|truncat/i.test(r8.out), '最长行=' + longest.length + ' 含截断标记=' + /截断|truncat/i.test(r8.out));

    const src = fs.readFileSync(WATCHER, 'utf-8');
    const writeApis = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync', 'createWriteStream', 'copyFileSync'];
    const hitW = writeApis.filter((a) => src.includes(a + '('));
    check('#130a9a 观察器零写盘 API(只许读心跳)', hitW.length === 0, '命中: ' + JSON.stringify(hitW));
    const killish = /\.kill\(|TaskStop|AbortController|\babort\(|SIGTERM/;
    check('#130a9b 观察器不得含任何终止能力(只报告,收割由指挥官手动决定)', !killish.test(src), '终止类命中=' + killish.test(src));
    check('#130a9c 阈值必须具名常量(禁内联字面量,#108 同族)', /DEFAULT_STALE_MS/.test(src) && /DEFAULT_INTERVAL_MS/.test(src),
      'DEFAULT_STALE_MS=' + /DEFAULT_STALE_MS/.test(src) + ' DEFAULT_INTERVAL_MS=' + /DEFAULT_INTERVAL_MS/.test(src));

    // a10 完备性: 五态判定互斥且可全绿 ⇒ 用同一份新鲜多步文件连跑两次,verdict 必须稳定(不随内部顺序漂移)
    const r1b = run(['--file', f1, '--budget-ms', '600000', '--stale-ms', '60000', '--once']);
    check('#130a10 同一份输入两次判定必须一致(判据不许掺随机或依赖遍历顺序)',
      r1b.verdict === r1.verdict && r1b.code === r1.code, '第一次=' + r1.verdict + '/' + r1.code + ' 第二次=' + r1b.verdict + '/' + r1b.code);

    // ── #135 终止态与卡死分开(交工/停工的自我申报不得被静默钟判死) ──
    const t1 = mk('p135-handback-stale.jsonl', [hb(1, 120000, 'read'), hb(2, 110000, 'handback')]);
    const q1 = run(['--file', t1, '--budget-ms', '60000', '--stale-ms', '30000', '--once']);
    check('#135a1 已交工(handback)且静默超 stale、预算用满 ⇒ 必须 HANDED-BACK 且退出码 0,绝不可判 STALE(判死=建议收割已完成的工作)',
      q1.verdict === 'HANDED-BACK' && q1.code === 0, 'verdict=' + q1.verdict + ' 退出码=' + q1.code + ' 输出=' + JSON.stringify(q1.out.replace(/\r?\n/g, ' | ').substring(0, 200)));

    const t2 = mk('p135-blocker-stale.jsonl', [hb(1, 120000, 'read'), hb(2, 110000, 'blocker')]);
    const q2 = run(['--file', t2, '--budget-ms', '60000', '--stale-ms', '30000', '--once']);
    check('#135a2 自报停工(blocker)且静默超 stale、预算用满 ⇒ 必须 BLOCKED 且退出码 0(停工是被派工者申报的终态,不是卡死)',
      q2.verdict === 'BLOCKED' && q2.code === 0, 'verdict=' + q2.verdict + ' 退出码=' + q2.code + ' 输出=' + JSON.stringify(q2.out.replace(/\r?\n/g, ' | ').substring(0, 200)));

    const t3 = mk('p135-handback-fresh.jsonl', [hb(1, 3000, 'read'), hb(2, 1000, 'handback')]);
    const q3 = run(['--file', t3, '--budget-ms', '600000', '--stale-ms', '60000', '--once']);
    check('#135a3 刚交工完 1 秒(新鲜)⇒ 仍是 HANDED-BACK,不得因"新鲜+多步"被判 WORKING/THINKING(终态优先于活跃度)',
      q3.verdict === 'HANDED-BACK' && q3.code === 0, 'verdict=' + q3.verdict + ' 退出码=' + q3.code);

    const t4 = mk('p135-testrun-stale.jsonl', [hb(1, 120000, 'read'), hb(2, 110000, 'test-run')]);
    const q4 = run(['--file', t4, '--budget-ms', '60000', '--stale-ms', '30000', '--once']);
    check('#135a4 反向锁:同样静默 110s+预算超满但末步是 test-run ⇒ 仍必须 STALE 且退出码 1(修终态不许把判死能力阉掉)',
      q4.verdict === 'STALE' && q4.code === 1, 'verdict=' + q4.verdict + ' 退出码=' + q4.code);

    const t5 = mk('p135-handback-then-work.jsonl', [hb(1, 110000, 'handback'), hb(2, 1000, 'read')]);
    const q5 = run(['--file', t5, '--budget-ms', '600000', '--stale-ms', '60000', '--once']);
    check('#135a5 反向锁:文件里出现过 handback 但按 ts 最后一条是 read ⇒ 不得判终态(终态只看最后一条,否则带 handback 的文件永不判死)',
      q5.verdict !== 'HANDED-BACK' && q5.verdict !== 'BLOCKED' && q5.verdict === 'WORKING' && q5.code === 0,
      'verdict=' + q5.verdict + ' 退出码=' + q5.code);

    // ── #143 ts 平局(同一毫秒/秒级粒度)时"末条"归属 ──
    // 病灶:选 lastBeat 用严格大于 ⇒ 同 ts 打平时保留文件里**先出现**的那条,与规则自己写的
    // "按 ts 最后那一条"相反。契约只要求 ts 是 ISO、不强制毫秒精度,宿主写秒级粒度时同秒两步必然并列。
    const T_stale = iso(now() - 120000);   // 静默 120s:超 stale(30s) 且超预算(60s)
    const T_fresh = iso(now() - 2000);     // 新鲜:远低于 stale(60s)

    const z1 = mk('p143-tie-fresh.jsonl', [hbTs(1, T_fresh, 'read'), hbTs(2, T_fresh, 'handback')]);
    const z1r = run(['--file', z1, '--budget-ms', '600000', '--stale-ms', '60000', '--once']);
    check('#143a1 同一 ts 的 [read, handback](新鲜)⇒ 必须 HANDED-BACK 且退出码 0(后写者胜,交工申报不得被平局吞掉)',
      z1r.verdict === 'HANDED-BACK' && z1r.code === 0,
      'verdict=' + z1r.verdict + ' 退出码=' + z1r.code + ' 两行 ts 完全相同=' + JSON.stringify(T_fresh));

    const z2 = mk('p143-tie-stale.jsonl', [hbTs(1, T_stale, 'read'), hbTs(2, T_stale, 'handback')]);
    const z2r = run(['--file', z2, '--budget-ms', '60000', '--stale-ms', '30000', '--once']);
    check('#143a2 同一 ts 的 [read, handback](静默超 stale 且预算用满)⇒ 仍必须 HANDED-BACK 退出码 0,绝不可判 STALE(#135 的误判在平局场景复活)',
      z2r.verdict === 'HANDED-BACK' && z2r.code === 0,
      'verdict=' + z2r.verdict + ' 退出码=' + z2r.code + ' 输出=' + JSON.stringify(z2r.out.replace(/\r?\n/g, ' | ').substring(0, 200)));

    const z3 = mk('p143-tie-reverse.jsonl', [hbTs(1, T_fresh, 'handback'), hbTs(2, T_fresh, 'read')]);
    const z3r = run(['--file', z3, '--budget-ms', '600000', '--stale-ms', '60000', '--once']);
    check('#143a3 反向锁:同一 ts 的 [handback, read] ⇒ 末条是 read,不得判终态(修平局不许把"见过 handback"变成永久免死)',
      z3r.verdict !== 'HANDED-BACK' && z3r.verdict !== 'BLOCKED' && z3r.verdict === 'WORKING' && z3r.code === 0,
      'verdict=' + z3r.verdict + ' 退出码=' + z3r.code);

    const z4base = now();   // 单一基准:两条只差 1ms 必须由同一时刻派生,否则两次 now() 的耗时会抹平甚至反超该差值
    const z4lines = [hbTs(1, iso(z4base - 120000), 'read'), hbTs(2, iso(z4base - 119999), 'handback')];
    const z4 = mk('p143-nontie-control.jsonl', z4lines);
    const z4r = run(['--file', z4, '--budget-ms', '60000', '--stale-ms', '30000', '--once']);
    check('#143a4 对照组:ts 只差 1ms(非平局)的 [read, handback] ⇒ HANDED-BACK 退出码 0(钉死 #143a1/a2 的根因是平局,不是终态逻辑本身)',
      z4r.verdict === 'HANDED-BACK' && z4r.code === 0,
      'verdict=' + z4r.verdict + ' 退出码=' + z4r.code);


  }
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { process.stdout.write('清理临时目录失败: ' + e.message + '\n'); }
}

process.stdout.write(`总计: ${passed}/${passed + failed} 通过\n`);
if (failed) process.stdout.write('红项: ' + fails.join(', ') + '\n');
process.exit(failed ? 1 : 0);
