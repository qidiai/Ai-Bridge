#!/usr/bin/env node
'use strict';

/**
 * AI Bridge 审计修复验收测试(指挥官亲笔,编码手禁改)
 *
 * 覆盖 2026-10-22 审计后的四个修复项:
 *   A) CliAdapter 超长 prompt 落盘:并发同工作区不得互踩/互删,文件名含 taskId,用完自删
 *   B) tools.json 超时值:agent 型 CLI 不因 tool.timeout 首次生效而被 120s 击杀
 *   C) output-cleaner:删除匹配白名单化(已知工具前缀),不再通配任意 *_<13位数字> 目录
 *   D) server.js 接线:清理逻辑必须经由 output-cleaner 模块(旧内联实现移除)
 *
 * 运行:node test-audit-fixes.mjs   退出码:0 全通过 / 1 有失败
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);

let passed = 0;
let failed = 0;
const failures = [];
function check (name, cond, detail) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ❌ ${name}` + (detail ? ` — ${String(detail).slice(0, 300)}` : '')); }
}
function section (t) { console.log(`\n── ${t} ──`); }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aifix-'));
const tmpWs = path.join(tmpRoot, 'ws');
const tmpOut = path.join(tmpRoot, 'out');
fs.mkdirSync(tmpWs, { recursive: true });
fs.mkdirSync(tmpOut, { recursive: true });

// ── A) long-task 并发竞态 ──
section('A) long-task 并发唯一性与自删(cli-adapter)');
try {
  const { CliAdapter } = require('./adapters/cli-adapter.js');
  // 假 CLI:从 argv 里的任务文本提取 long-task 文件指针,读该文件前 6 字符回显
  const READ_SCRIPT = [
    'const fs=require("fs");',
    'const t=process.argv[1]||"";',
    "const m=t.match(/ai-bridge-long-task[^\\s\"']*/);",
    'if(m){try{console.log("READ:"+fs.readFileSync(m[0],"utf-8").slice(0,6));}catch(e){console.log("ERR:"+e.code);}}',
    'else console.log("NOPTR");'
  ].join('\n');
  const mkAdapter = () => new CliAdapter({
    name: 'aifix',
    command: 'node',
    args: ['-e', READ_SCRIPT, '{{task}}'],
    inputMode: 'arg',
    outputMode: 'stdout-text',
    timeout: 60000
  });
  const A = 'ALPHA' + 'a'.repeat(25000);
  const B = 'BETA' + 'b'.repeat(25000);
  const [ra, rb] = await Promise.all([
    mkAdapter().execute(A, { taskId: 'aifixA', outputDir: path.join(tmpOut, 'a'), workspaceDir: tmpWs }),
    mkAdapter().execute(B, { taskId: 'aifixB', outputDir: path.join(tmpOut, 'b'), workspaceDir: tmpWs })
  ]);
  check('任务A读到自己且未被B覆盖', (ra.content || '').includes('READ:ALPHA'), JSON.stringify(ra).slice(0, 200));
  check('任务B读到自己(共享文件名时此项必挂)', (rb.content || '').includes('READ:BETA'), JSON.stringify(rb).slice(0, 200));
  check('无 ERR(先完成者未误删对方落盘文件)', !(ra.content || '').includes('ERR') && !(rb.content || '').includes('ERR'), (ra.content || '') + ' | ' + (rb.content || ''));
  const residue = fs.readdirSync(tmpWs).filter(n => n.includes('ai-bridge-long-task'));
  check('执行后工作区无 long-task 残留', residue.length === 0, residue.join(','));
} catch (e) {
  check('long-task 并发用例执行未抛异常', false, e.message);
}

// ── B) tools.json 超时值 ──
section('B) tools.json 超时(tool.timeout 生效后不得误杀慢 agent)');
{
  const tools = JSON.parse(fs.readFileSync('./tools.json', 'utf-8'));
  const byName = Object.fromEntries(tools.map(t => [t.name, t]));
  for (const n of ['openclaw', 'qoder', 'workbuddy']) {
    check(`${n} timeout>=600000`, (byName[n]?.timeout || 0) >= 600000, 'timeout=' + byName[n]?.timeout);
  }
  check('atom-code timeout=300000', byName['atom-code']?.timeout === 300000, 'timeout=' + byName['atom-code']?.timeout);
  for (const n of ['opencode', 'opencode-k3', 'opencode-flash']) {
    check(`${n} timeout=600000`, byName[n]?.timeout === 600000, 'timeout=' + byName[n]?.timeout);
  }
  check('mimo-code 已下线', !byName['mimo-code']);
}

// ── C) output-cleaner 语义 ──
section('C) output-cleaner 匹配白名单 + 24h 窗口');
let cleaner = null;
try { cleaner = require('./output-cleaner.js'); } catch (e) { cleaner = null; }
const PREFIXES = ['openclaw', 'atom-code', 'claude-code', 'qoder', 'workbuddy', 'codely', 'codely-k3', 'opencode', 'opencode-k3', 'opencode-flash', 'aifix'];
if (!cleaner) {
  check('output-cleaner.js 模块存在', false, 'require 失败');
} else {
  const isStale = cleaner.isStaleTaskDir;
  check('桥接生成的 <tool>_<13位ts> 判为可清理', isStale('qoder_qoder_1762000000000', PREFIXES) === true);
  check('旧反代 cli-task-* 判为可清理', isStale('cli-task-x', PREFIXES) === true);
  check('review 任务目录判为可清理', isStale('opencode_review_dispatch_1762000000000_abc123', PREFIXES) === true);
  check('用户备份目录 backup_20260101120000 不匹配', isStale('backup_20260101120000', PREFIXES) === false);
  check('未知前缀 notes_1762000000000 不匹配', isStale('notes_1762000000000', PREFIXES) === false);
  check('纯文本目录名不匹配', isStale('output', PREFIXES) === false);

  const root = path.join(tmpRoot, 'clean');
  fs.mkdirSync(root);
  const mk = (name, ageMs) => {
    const d = path.join(root, name);
    fs.mkdirSync(d);
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(d, when, when);
  };
  mk('qoder_qoder_1762000000000', 25 * 3600 * 1000); // 匹配+超龄 → 删
  mk('qoder_qoder_1762000000999', 3600 * 1000);      // 匹配+未超龄 → 留
  mk('backup_20260101120000', 30 * 24 * 3600 * 1000); // 不匹配+超龄 → 留
  const out = cleaner.cleanupStaleTaskDirs({ roots: [root], prefixes: PREFIXES, maxAgeMs: 24 * 3600 * 1000 });
  const left = fs.readdirSync(root);
  check('超龄匹配目录被删', !left.includes('qoder_qoder_1762000000000'), JSON.stringify(out));
  check('未超龄匹配目录保留', left.includes('qoder_qoder_1762000000999'), left.join(','));
  check('非白名单目录绝不删除', left.includes('backup_20260101120000'), left.join(','));
}

// ── D) server.js 接线 ──
section('D) server.js 经由 output-cleaner(旧内联通配实现移除)');
{
  const src = fs.readFileSync('./server.js', 'utf-8');
  check("server.js require('./output-cleaner.js')", /require\(['"]\.\/output-cleaner\.js['"]\)/.test(src));
  check('server.js 不再自带 isStaleTaskDir 内联实现', !/function isStaleTaskDir/.test(src));
  check('server.js 清理调用传入工具名前缀', /prefixes/.test(src));
}

// ── E) no_targets 归因面(#50 R1,指挥官亲笔,编码手禁改) ──
// 背景:#50 的 F3 让 no_targets 对每个点名目标给出具体落选原因,方向对,但交付实现有两处会撒谎:
//   ① 对"能在 availableTools 里解析到的客户端"仍可能输出"未声明 sampling 能力"——而客户端能进
//      availableTools 就意味着 getAllTools(server.js:379) 已经核验过 supportsSampling===true,
//      于是"有资格"被说成"没资格",正是 #50a4 要消灭的那类误导文案(它在正常单线程路径不可达,
//      只在开关并发翻转时可达,可达即撒谎)。
//   ② 自动路由(根本没点名)也走同一模板,why 为空数组 → 输出"点名目标: 无",既把"未点名"说成
//      "点名了但全落选",又丢掉了 workspace 任务要求 exec 这条真实解释(server.js:755-757 的
//      dispatchableTools 过滤就是为此存在)。
// 锁的是行为形状,不是字符串回声:①归因行不得把 tool.*(已入册可解析)与 sampling 缺失绑在一起;
// ②必须先判"有没有点名";③给 exec 解释时必须以 workspace 为条件。
section('E) no_targets 归因不得撒谎(#50 R1)');
{
  const src = fs.readFileSync('./server.js', 'utf-8');
  const anchor = src.indexOf('if (targets.length === 0)');
  check('E0 能定位到 targets 为空的归因块', anchor >= 0, `indexOf=${anchor}`);
  const retAt = src.indexOf("code: 'no_targets'", anchor);
  const block = anchor >= 0 && retAt >= 0 ? src.slice(anchor, src.indexOf('\n', retAt)) : '';
  const lines = block.split('\n');
  // ① 任何一行同时出现 `tool.` 与 "未声明 sampling" ⇒ 把已入册客户端说成无资格
  const lying = lines.filter(l => /tool\./.test(l) && /未声明 sampling/.test(l));
  check('E1 已解析到 availableTools 的客户端绝不得被判成"未声明 sampling"', lying.length === 0, lying.map(l => l.trim()).join(' | ').substring(0, 240));
  // ② 归因块必须先区分"点名派发"与"自动路由"(对 toolNames 做存在性判断)
  check('E2 归因块必须区分点名派发与自动路由(不得对未点名输出"点名目标: 无")',
    /toolNames\s*(&&|\.length\s*[>!=])/.test(block) || /if\s*\(\s*toolNames\s*\)/.test(block),
    block.substring(0, 240));
  // ③ exec 解释必须以 workspace 为条件(无 workspace 时谈 exec 是误导)。
  //   锁的是"确实对 workspace 变量做了条件判断",不是块里出现过 workspace 这个词——防止只补文案不改分支。
  const execLines = lines.filter(l => /exec/.test(l));
  const gatesOnWorkspace = /if\s*\(\s*workspace[\s)&|]/.test(block) || /workspace\s*(&&|\?)/.test(block);
  check('E3 exec 相关归因必须以 workspace 为条件分支', execLines.length === 0 || gatesOnWorkspace,
    `gatesOnWorkspace=${gatesOnWorkspace} | ${execLines.map(l => l.trim()).join(' | ').substring(0, 200)}`);
}

// ── F) 超时预算关系锁(#53/#48,指挥官亲笔,编码手禁改) ──
// 根因是**数值关系**而非文案:桥的 HTTP 上限(600000)比中枢的单次执行窗口(900000)还短,
// 长任务必然先被桥侧判"请求超时",而中枢仍在执行——误报失败并写脏台账。GET 又比 POST 短一截
// 且硬编码不可传参。这里锁"预算必须包住窗口并留余量 + GET/POST 同源 + callTool 有总超时",
// 数值全部回源解析,不写死数字常量当答案(改窗口时锁会跟着动)。
section('F) 超时预算关系锁(#53/#48)');
{
  const srv = fs.readFileSync('./server.js', 'utf-8');
  const br = fs.readFileSync('./bridge-stdio.js', 'utf-8');
  // 兜底值的三形态必须同尺(编码手 #49a 实测出第三种):
  //   旧式 parseInt(env)||N 、 新式 parsePositiveInt(env,N) 、 带变量名的 parsePositiveInt(env,N,'NAME')。
  //   我先前"取语句末尾那个数字"的取法在第三形态下抓不到 N(末尾是字符串实参),结果锁的形状要求反过来
  //   逼迫实现**省略 name 参数**——那是锁的缺陷,不是需求(编码手如实披露了这个取舍,记合格)。
  //   规则:先认 `) || N`(旧式);否则认 `, N` 后紧跟 `,` 或 `)`(新式默认值 = 最后一个数值实参之前那层)。
  //   已知局限:默认值写成算术表达式(如 `10 * 60 * 1000`)时会取到末尾的 1000;本文件三条锁都不依赖那类站点。
  const defaultOf = (stmt) => {
    const old = (stmt || '').match(/\)\s*\|\|\s*(\d+)/);
    if (old) return Number(old[1]);
    const nw = (stmt || '').match(/,\s*(\d+)\s*(?:[,)])/);
    return nw ? Number(nw[1]) : NaN;
  };
  const S = defaultOf((srv.match(/EXECUTE_TIMEOUT:[^\n]*/) || [''])[0]);
  check('F0 能解析中枢单次执行窗口(server.js CONFIG.EXECUTE_TIMEOUT 兜底值)', Number.isFinite(S) && S > 0, `S=${S}`);
  // 数值解析器:默认值可以写字面量,也可以写共享常量标识符(鼓励后者:GET/POST/总超时同源)
  const resolveDefault = (expr) => {
    if (/^\d+$/.test(expr)) return Number(expr);
    const line = br.match(new RegExp('(?:const|let|var)\\s+' + expr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*[^;]*;'));
    return line ? defaultOf(line[0]) : NaN;
  };
  const pm = br.match(/function\s+httpPost\s*\([^)]*?timeoutMs\s*=\s*(\d+|[A-Za-z_$][\w$]*)/);
  const B = pm ? resolveDefault(pm[1]) : NaN;
  check('F1 桥的 POST 上限必须 ≥ 中枢窗口 + 30000 余量(否则长任务被桥侧误报失败)',
    Number.isFinite(B) && B >= S + 30000, `POST=${B} 窗口=${S} 要求>=${S + 30000}`);
  const gm = br.match(/function\s+httpGet\s*\(([^)]*)\)/);
  check('F2 httpGet 必须形参化超时(消除 GET 硬编码 30000 与 POST 的语义不对称)',
    !!gm && /timeoutMs/.test(gm[1]), gm ? `签名=(${gm[1].trim()})` : '未匹配到 httpGet 签名');
  // F3:env 必须被读取且**同步类预算**的兜底值要包住中枢窗口。
  //   注意取 matchAll 的最大值而不是首个:GET 允许有独立的短兜底(poll 快速失败是自愈路径的关键,
  //   若把 GET 默认也抬到 960s,#38a 的黑洞测试会从 30010ms 变成永久悬空 → 制造回归)。
  const brCode = br.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const ems = [...brCode.matchAll(/^.*AI_BRIDGE_HTTP_TIMEOUT.*$/gm)]
    .map(mm => defaultOf(mm[0]))
    .filter(Number.isFinite);
  const BMAX = ems.length ? Math.max(...ems) : NaN;
  check('F3 预算必须可用 AI_BRIDGE_HTTP_TIMEOUT 配置,且同步类兜底值同样包住中枢窗口(GET 可另设更短兜底)',
    ems.length > 0 && BMAX >= S + 30000, ems.length ? `候选兜底=[${ems.join(',')}] 取最大=${BMAX} 窗口=${S}` : '桥侧未读取 AI_BRIDGE_HTTP_TIMEOUT');
  // callTool 体内必须有总超时(串行多次 HTTP 的累加时间也要被包住)
  const anchor = br.indexOf('async function callTool (');
  let body = '';
  if (anchor >= 0) {
    let depth = 0, i = br.indexOf('{', anchor);
    for (; i < br.length; i++) {
      if (br[i] === '{') depth++;
      else if (br[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    body = br.slice(anchor, i);
  }
  check('F4 callTool 必须有总超时包装(单次工具调用的累加耗时不得无界)',
    anchor >= 0 && /Promise\s*\.\s*race\s*\(/.test(body), `bodyLength=${body.length} 命中 Promise.race=${/Promise\s*\.\s*race\s*\(/.test(body)}`);
}

// ── G) 任务态写入禁止整体替换对象(#41 结构守卫,指挥官亲笔,编码手禁改) ──
// 背景:executeClient 入队(server.js:684)与 /api/poll 取任务(:1711/:1736)、/api/result 回写(:1760)
//   四处都用 `connectedClients.set(key, { ...存活对象, 改动字段 })` 整体替换。危险在于 spread 取的是
//   **局部变量的快照**:若期间另一条路径(超时清理 :672-679 就是就地 mutate 同一对象)已经改过真身,
//   整体替换会把被清空的 pendingTask/被释放的 _busy "复活"成旧值——任务态错乱、租约误占用。
//   真模型审计把并发窗口评为"窄",我复算后同意(单线程事件循环下检查与写入之间无 await),
//   短期造不出稳定红用例,因此本单从"红基线修复"降级为**静态结构守卫**:禁止整体替换 + 就地写必须保留
//   原有语义字段(防"为了过锁把清理逻辑删了")。并发正确性由 #55 北极星端到端兜。
//   阈值全部来自规格逐条推导,不是拍脑袋:
//     pendingTask 就地赋值 ≥4 = 入队(1)+poll(2)+超时清理(1,:673 已有)
//     taskPending ≥3 = poll(2)+result(1);_busy ≥2 = 超时清理(1)+result(1);lastSeen ≥2 = register(1)+result(1)
section('G) 任务态 map 禁止整体替换(#41)');
{
  const src = fs.readFileSync('./server.js', 'utf-8');
  const wholeReplace = src.match(/connectedClients\.set\([^,)]+,\s*\{\s*\.\.\./g) || [];
  check('G1 不得用 spread 整体替换存活客户端(局部快照会复活已被清空的字段)',
    wholeReplace.length === 0, `命中 ${wholeReplace.length} 处: ` + wholeReplace.map(s => s.replace(/\s+/g, ' ').substring(0, 46)).join(' | '));
  const cnt = (re) => (src.match(re) || []).length;
  const nPT = cnt(/\w+\.pendingTask\s*=\s*[^=]/g);
  const nTP = cnt(/\w+\.taskPending\s*=\s*[^=]/g);
  const nBusy = cnt(/\w+\._busy\s*=\s*[^=]/g);
  const nSeen = cnt(/\w+\.lastSeen\s*=\s*[^=]/g);
  check('G2a 入队/poll/超时清理四处都必须就地写 pendingTask(≥4)', nPT >= 4, `实测=${nPT} 要求>=4`);
  check('G2b /api/result 与 poll 必须就地写 taskPending(≥3)', nTP >= 3, `实测=${nTP} 要求>=3`);
  check('G2c 超时清理与 /api/result 必须就地释放 _busy(≥2,否则客户端永久 busy)', nBusy >= 2, `实测=${nBusy} 要求>=2`);
  check('G2d /api/result 必须就地刷新 lastSeen(≥2,否则回写后被判 stale)', nSeen >= 2, `实测=${nSeen} 要求>=2`);
}

// ── H) 超时/被杀的真实归因(#54,指挥官亲笔,编码手禁改) ──
// 实况(生产取证 2026-10-23):atom-code 一次超时在台账里记成
//   reason="Command exited with code null: Console code pages: input 936, output 9…"
// ——"code null" 是被信号杀死的表征,后半段根本不是失败原因,而是 CLI 自己的启动横幅。
// 根因在 adapters/cli-adapter.js:runCommand 的 close 处理器:
//   ① `child.on('close', (code) => …)` 把第二参数 signal 整个丢了(本机实测 spawn({timeout}) 杀死时
//      close 回 code=null, signal='SIGTERM', killed=true,与"进程自己以 0 以外的码退出"无法区分);
//   ② 详情取 `(stderr || stdout).substring(0, 200)` 的**头部**,而真因几乎总在末尾,头部常是横幅。
//   该 err.message 会经 server.js:577 `reason: error.message` 与 :665 `error: execError.message`
//   原样进台账/流量记录 —— 中枢侧无需改动,修点只在适配器。
// 锁的是"归因必须指向真因",不锁具体措辞:允许"被信号 SIGTERM 终止/超时"等任一表达,只要
// ①不再出现 `code null` 这种无归因字面,②详情含尾部真因,③结构化 signal 可被上层判定器使用,
// ④普通非零退出仍照旧如实报码(防修 signal 时把常规失败弄丢)。
section('H) 超时归因不得误导(#54)');
try {
  const { CliAdapter } = require('./adapters/cli-adapter.js');
  const mk = (script, timeout) => new CliAdapter({
    name: 'h54', command: 'node', args: ['-e', script], inputMode: 'arg',
    outputMode: 'stdout-text', timeout
  });
  const grab = async (adapter, task) => {
    try { await adapter.execute(task, { taskId: 'h54', outputDir: path.join(tmpOut, 'h'), workspaceDir: tmpWs }); return { ok: true, err: null }; }
    catch (e) { return { ok: false, err: e }; }
  };
  // H1/H3:超时被信号杀 → 必须点明信号/超时,并带结构化 signal 供上层判定
  const hang = await grab(mk('console.log("H_BANNER_HEAD");setTimeout(()=>{},5000)', 700), 'x');
  const hangMsg = hang.err ? String(hang.err.message) : '';
  check('H1 被信号终止不得记成"code null"空归因(必须点明信号或超时)',
    hang.ok === false && /SIGTERM|信号|超时|终止/.test(hangMsg) && !/code null/.test(hangMsg),
    hang.ok ? '居然未抛错(超时没生效,视为红)' : `message=${hangMsg.substring(0, 160)}`);
  check('H3 抛错必须携带结构化 signal(本机实测应为 SIGTERM),供判定器区分被杀与非零退出',
    hang.ok === false && hang.err.signal === 'SIGTERM', `signal=${JSON.stringify(hang.err && hang.err.signal)} code=${JSON.stringify(hang.err && hang.err.code)}`);
  // H2:真因在末尾,详情必须给尾部(现实现取头 200 字节,只会拿到头部噪声)
  const tailScript = 'console.error("HEAD_NOISE_" + "x".repeat(400) + "TAIL_REAL_CAUSE");process.exit(3);';
  const tail = await grab(mk(tailScript, 30000), 'y');
  const tailMsg = tail.err ? String(tail.err.message) : '';
  check('H2 失败详情必须包含尾部真因(不得只截头部 200 字节的启动噪声)',
    tail.ok === false && tailMsg.includes('TAIL_REAL_CAUSE'), `message 头部=${tailMsg.substring(0, 120)}`);
  // H4:普通非零退出的码不得被修丢
  check('H4 非零正常退出仍须如实携带退出码(防修 signal 时把常规失败弄丢)',
    tail.ok === false && tail.err.code === 3, `code=${JSON.stringify(tail.err && tail.err.code)}`);
} catch (e) {
  check('H 段用例执行未抛异常', false, e.message);
}

// ── I) 桥侧汇总口径不得有三种分母、不得把对象直接 join(#36 结构锁,指挥官亲笔) ──
// 同一句"N/M 成功"在 bridge-stdio.js 里有三处实现::317 用 r.total(dispatch 响应),
// :382 与 :397 用 t.results?.length(历史/任务列表)。今天它们数值相等所以不显形;一旦 #36
// 让"被跳过的点名目标"进入显著信号,三处会立刻分叉——同一规则多处实现正是 #38/#49 的根因族。
// 另外 :318 现在对 skipped 直接 .join(', '):skipped 由 string[] 升级为 {ref,reason}[] 后,
// join 会渲染成 "[object Object]",把一个修好的归因问题换成一个更糟的展示缺陷。
// 故锁:①禁止再用 results.length 当分母;②禁止对 skipped 直接 join;③汇总文案必须能体现点名请求数。
section('I) 桥侧汇总口径统一(#36)');
{
  const br = fs.readFileSync('./bridge-stdio.js', 'utf-8');
  const thirdDenom = br.match(/successCount\}\/\$\{[^}]*results\?\.length/g) || [];
  check('I1 不得存在第三种分母(历史视图用 results.length 而非 total)', thirdDenom.length === 0, `命中 ${thirdDenom.length} 处: ` + thirdDenom.map(s => s.substring(0, 50)).join(' | '));
  check('I2 skipped 不得被直接 join(升级为对象数组后会渲染成 [object Object])', !/skipped\.join\(/.test(br), (br.match(/[^\n]*skipped\.join\([^\n]*/) || ['(无)'])[0].trim().substring(0, 120));
  // I3 收紧版:必须在 dispatch 工具的渲染区间里引用"点名请求数",且不接受 requestedAt(待审批时间)
  // 这类无关子串——首版我写的是全文 /requested/,被 :480 的 pd.requestedAt 蒙成假绿,已认。
  const dStart = br.indexOf("case 'dispatch'");
  const dEnd = br.indexOf("case '", dStart + 5);
  const dBlock = dStart >= 0 ? br.slice(dStart, dEnd > dStart ? dEnd : br.length) : '';
  const reqRef = dBlock.replace(/requestedAt/g, '').match(/\brequested\b/);
  check('I3 dispatch 汇总文案必须体现点名请求数(否则"1/1 成功"继续掩盖"点名 2 个只跑 1 个")',
    dStart >= 0 && !!reqRef, dStart < 0 ? '未定位到 dispatch 分支' : `dispatch 渲染块长度=${dBlock.length},块内 requested 命中=${!!reqRef}`);
}

// ── J) Web UI 必须能自证身份(#42 结构锁,指挥官亲笔) ──
// 中枢设了 AI_BRIDGE_TOKEN 后,/api/* 全部要求 Bearer;而 ui.html 的取数辅助函数
// (ui.html:318 `async function api(path,opts){const r=await fetch(path,opts);return r.json()}`)
// 从不带 Authorization —— 实测全文件 grep 'Authorization' = 0 命中。
// 结果是"要安全就得牺牲自己":一设 token,自己的管理界面就被 401 打死,只能回去关 token。
// 本锁只要求最小能力:能出示凭据(Authorization/Bearer)且有一个拿到凭据的来源
// (localStorage 或用户输入),不锁具体实现与文案。
section('J) Web UI 凭据自证(#42)');
{
  const ui = fs.readFileSync('./ui.html', 'utf-8');
  const hasAuth = /Authorization/.test(ui) && /Bearer/.test(ui);
  const hasSource = /localStorage|sessionStorage|prompt\s*\(/.test(ui);
  check('J1 ui.html 必须能出示凭据(Authorization: Bearer …)', hasAuth, 'Authorization 命中=' + /Authorization/.test(ui) + ' Bearer 命中=' + /Bearer/.test(ui));
  check('J2 ui.html 必须有拿到凭据的来源(存储或用户输入),否则设 token 即自锁', hasSource, 'storage/prompt 命中=' + hasSource);
  // J3:凭据注入必须覆盖**每一个**网络调用点。#42 R1 的真实教训:api() 被改造了,但 UI 的流式聊天
  //   走的是另一条裸 fetch(ui.html:620 → /v1/chat/completions),门一扩就 401 打死,而锁看不见它。
  //   合法实现有两种:每个调用点显式 withAuth(…),或全文件装一个对所有请求生效的注入点(window.fetch 包装)。
  //   两者都算通过——本锁禁止的是"漏掉某个调用点",不指定写法。
  const fetchSites = ui.split(/\r\n|\n/).map((l, i) => ({ n: i + 1, l })).filter(x => /\bfetch\s*\(/.test(x.l) && !/function\s+fetch/.test(x.l));
  const unwrapped = fetchSites.filter(x => !/withAuth\s*\(/.test(x.l) && !/window\.fetch\s*=/.test(x.l));
  const hasGlobalWrapper = /window\.fetch\s*=/.test(ui);
  check('J3 每个 fetch 调用点都必须被凭据注入覆盖(不得有漏网调用点)',
    fetchSites.length > 0 && (unwrapped.length === 0 || hasGlobalWrapper),
    `调用点=${fetchSites.length} 未包裹=[${unwrapped.map(x => ':' + x.n).join(',')}] 全局包装=${hasGlobalWrapper}`);
  // J4:流式对话分支必须检查响应状态,否则 401 的 JSON 会被当 SSE 解析,界面渲染成"(空响应)"——
  //   静默空白正是 #42 要消灭的病,不能一边修好一边留着。
  const chatAt = ui.indexOf('/v1/chat/completions');
  const chatBlock = chatAt >= 0 ? ui.slice(chatAt, chatAt + 2200) : '';
  check('J4 流式请求分支必须检查 resp.ok/resp.status(401 不得被当 SSE 静默吞掉)',
    chatAt >= 0 && /resp\.ok|resp\.status|\.ok\b/.test(chatBlock),
    chatAt < 0 ? '未找到流式调用点' : '块内状态检查命中=' + /resp\.ok|resp\.status|\.ok\b/.test(chatBlock));
}

// ── K) 死码账本必须归零,活账本不得被顺手删(#31,指挥官亲笔,编码手禁改) ──
// 背景:"流量"同时存在两套账 —— store.js 的 JSONL(traffic.jsonl)与 db.js 的 SQLite traffic 表。
//   实测(JSONL 那套早已是死账):生产 traffic.jsonl 停在 07-26 19:14、1274 字节,此后再无写入;
//   原因是 store.appendTraffic / readTraffic / clearTraffic **全仓零调用方**(grep 只命中定义与导出本身),
//   而 /api/traffic 读的是 db.queryTraffic(...) 再并上 AgnesCode 外部日志。
//   留着这套死码的真实代价不是"几行没人跑的代码":store 与 db **导出同名 clearTraffic**,
//   而 server.js:1880 调的是 db.clearTraffic() —— 清库清的是活账本,死文件原样留在数据目录里;
//   后来者按名字找会清错对象。同理 store 侧 `async save` 与 `loadList` 也零调用方,
//   且 loadList 在 #44 之后已成"名叫 List 却拒绝顶层数组"的名实不符者(#44 规格明令本单才删)。
// 本段是**双向锁**:既锁"死的必须真删干净",也锁"活的半条腿不许一起删"(K3/K4/K5)。
section('K) 死码账本归零 + 活账本不被误删(#31)');
{
  const storeSrc = fs.readFileSync('./store.js', 'utf-8');
  const dbSrc = fs.readFileSync('./db.js', 'utf-8');
  const srvSrc = fs.readFileSync('./server.js', 'utf-8');
  const expBlock = storeSrc.slice(storeSrc.indexOf('module.exports'));
  const deadSyms = ['appendTraffic', 'readTraffic', 'rotateTrafficIfNeeded', 'flushTrafficQueue', '_trafficQueue', '_trafficWriting', 'TRAFFIC_MAX_FILE_SIZE'];
  const hits = deadSyms.filter(t => storeSrc.includes(t));
  check('K1 store.js 不得残留 JSONL 流量账本的写入/轮转/读取面(零调用方的死账本,留着只会与 SQLite 活账本同名混淆)',
    hits.length === 0, '仍命中 ' + hits.length + ' 处: ' + hits.join(','));
  check('K2 store.js 不得再有零调用方的异步 save 与名实不符的 loadList(含导出与注释里的自我声明)',
    !/function loadList\s*\(/.test(storeSrc) && !/async function save\s*\(/.test(storeSrc) && !/\bloadList\b/.test(storeSrc),
    'loadList 提及=' + (storeSrc.match(/\bloadList\b/g) || []).length + ' 异步 save=' + /async function save\s*\(/.test(storeSrc));
  check('K2b 导出面必须同步收窄(删了实现却还导出 = 悬空符号,比死码更坏)',
    !/\bsave\b/.test(expBlock) && !/\bloadList\b/.test(expBlock) && !/\bappendTraffic\b/.test(expBlock) && !/\breadTraffic\b/.test(expBlock) && !/\bclearTraffic\b/.test(expBlock),
    '导出仍含死符号: ' + ['save', 'loadList', 'appendTraffic', 'readTraffic', 'clearTraffic'].filter(t => new RegExp('\\b' + t + '\\b').test(expBlock)).join(','));
  check('K3 FILES 不得再声明 traffic 路径(声明着就会让读者以为还有第二本账),但日志账本 FILES.logs 必须原样在',
    !/traffic:/.test(storeSrc) && /logs:\s*path\.join/.test(storeSrc),
    'traffic 声明=' + /traffic:/.test(storeSrc) + ' logs 声明=' + /logs:\s*path\.join/.test(storeSrc));
  // 反向锁(现状即绿,专防"清理死码时顺手把活的也删了"):活账本 SQLite traffic 必须一条腿不断
  check('K3b 反向锁:db.js 的活账本三件套 recordTraffic/queryTraffic/clearTraffic 必须仍在导出里',
    ['recordTraffic', 'queryTraffic', 'clearTraffic'].every(t => new RegExp('\\b' + t + '\\b').test(dbSrc)),
    '缺失: ' + ['recordTraffic', 'queryTraffic', 'clearTraffic'].filter(t => !new RegExp('\\b' + t + '\\b').test(dbSrc)).join(','));
  check('K4 反向锁:/api/traffic 仍必须走 db.queryTraffic,/api/traffic/clear 仍必须调 db.clearTraffic()(读路径与清库都不许断链)',
    /db\.queryTraffic\(/.test(srvSrc) && /db\.clearTraffic\(\)/.test(srvSrc),
    'queryTraffic=' + /db\.queryTraffic\(/.test(srvSrc) + ' clearTraffic=' + /db\.clearTraffic\(\)/.test(srvSrc));
  // K5) 清理不得**新造**孤儿:`async save` 是 _locks 的唯一使用者,删了 save 却没删 _locks,
  //   等于在一张"死代码清理"单里留下一个新死符号(eslint 也报 no-unused-vars)。
  //   同时 assertShape 的注释示例仍写 `未知 key(logs/traffic 等)`,而 traffic 已不再是 FILES 键
  //   ——注释指向不存在的符号就是 #61 那类文档漂移的病源。两处一起锁。
  const lockDecl = /const\s+_locks\s*=\s*new\s+Map/.test(storeSrc);
  const lockUses = (storeSrc.match(/\b_locks\b/g) || []).length;
  check('K5 清理不得新造孤儿:_locks 不得作为零引用声明残留(它原本只被已删除的 async save 使用),且注释示例不得指向已删除的 traffic 键',
    !lockDecl && !/logs\/traffic/.test(storeSrc),
    '_locks 声明残留=' + lockDecl + ' 全文提及=' + lockUses + ' 注释仍举例 logs/traffic=' + /logs\/traffic/.test(storeSrc));
}

// ── L) 用量报表恒 0:#45 红集(指挥官亲笔,编码手禁改) ──
// 背景:traffic.usage 至少有四种形状各写一遍,而聚合只认其中一种键名:
//   ① 反代入站 server.js:2126 存**上游原样** {prompt_tokens, completion_tokens}
//   ② 派发回写 server.js:702 存**归一化后** {input, output, total, reported|estimated}
//   ③ events 表用**列** input_tokens/output_tokens(db.js:65)
//   ④ token-stats.json 又是第五种(按工具累计 + estimate 路径)
//   而 db.js 的 usageReport()(byDay/byTool)与 todayTokens() 只 SUM
//   `json_extract(usage,'$.prompt_tokens') + json_extract(usage,'$.completion_tokens')`。
// 生产实测(2026-10-23,只读 API):最近 500 条 traffic 里 usage 非空 52 条,**52 条全是形状②**,
//   `/api/usage/report?days=30` 每一行 tokens=0;带凭据 `/api/health` 的 usage={todayTokens:0}
//   → `AI_BRIDGE_DAILY_TOKEN_BUDGET` 告警永不触发(输入恒 0)。同库 `/api/db/stats` 的 dispatches.tokens=638931。
// 载体用**子进程 + 独立 AI_BRIDGE_DB**(与 test-store-corrupt 同法):
//   绝不在本进程 require db.js——模块顶层会按 env 解析库路径,env 设晚了就会连到生产 ~/.ai-bridge/bridge.db。
//   L0 就是这把枪的保险栓:runner 必须回显它实际打开的库路径,且必须落在本套件的临时根里。
section('L) 用量报表恒 0(#45 · 三形状一聚合)');
{
  const usageRunner = path.join(tmpRoot, 'usage45-runner.cjs');
  const SUITE_DIR = import.meta.dirname;
  fs.writeFileSync(usageRunner, `'use strict';
const db = require(${JSON.stringify(path.join(SUITE_DIR, 'db.js'))});
const TOOL = 'usage45-shape-tool';
const now = new Date().toISOString();
const rows = [
  { tool: TOOL, direction: 'in', ts: now, success: true, type: 'openai-proxy', usage: { prompt_tokens: 100, completion_tokens: 50 } },
  { tool: TOOL, direction: 'in', ts: now, success: true, type: 'dispatch', usage: { input: 200, output: 60, total: 260, reported: true } },
  { tool: TOOL, direction: 'in', ts: now, success: true, type: 'client-report', usage: { input_tokens: 30, output_tokens: 20 } },
  { tool: TOOL, direction: 'in', ts: now, success: true, type: 'no-usage', usage: null },
];
for (const r of rows) db.recordTraffic(r);
db.recordEvent({ ts: now, source: 'openai-proxy', channel: TOOL, model: 'm', inputTokens: 111, outputTokens: 22 });
const rep = db.usageReport(7);
const one = (rep.byTool || []).find(x => x.tool === TOOL) || null;
const day = (rep.byDay || []).find(x => x.tool === TOOL) || null;
process.stdout.write(JSON.stringify({
  dbPath: (db.stats && db.stats().dbPath) || null,
  byTool: one, byDay: day,
  todayTokens: db.todayTokens(),
  events: db.stats().events
}) + '\\n');
`, 'utf-8');
  const usageDb = path.join(tmpRoot, 'usage45.db');
  const ur = spawnSync(process.execPath, [usageRunner], {
    cwd: SUITE_DIR,
    env: { ...process.env, AI_BRIDGE_DB: usageDb, AI_BRIDGE_DATA_DIR: tmpRoot },
    encoding: 'utf-8', timeout: 20000
  });
  let uo = null;
  try { uo = JSON.parse((ur.stdout || '').trim().split('\n').pop()); } catch (_) { /* 交给断言判失败 */ }
  const inTmp = !!(uo && uo.dbPath) && path.resolve(uo.dbPath).toLowerCase() === path.resolve(usageDb).toLowerCase();
  check('L0 保险栓:runner 实际打开的必须是本套件的隔离库(设错 env 就会写生产 ~/.ai-bridge/bridge.db)',
    inTmp, uo && uo.dbPath);
  check('L1 报表必须把三种 usage 形状都算进 tokens(现状只认 prompt/completion:期望 460,实测会=150)',
    !!uo && !!uo.byTool && uo.byTool.tokens === 460,
    uo && uo.byTool ? 'byTool=' + JSON.stringify(uo.byTool) : 'runner 无输出: ' + (ur.stderr || '').substring(0, 120));
  check('L2 byDay 同口径(#45 的报表页就是靠它;形状②/③ 不得被静默丢弃)',
    !!uo && !!uo.byDay && uo.byDay.tokens === 460, uo && uo.byDay ? JSON.stringify(uo.byDay) : 'n/a');
  check('L3 todayTokens 同口径(它是 AI_BRIDGE_DAILY_TOKEN_BUDGET 告警的唯一输入,恒 0 = 预算闸门形同虚设)',
    !!uo && uo.todayTokens === 460, 'todayTokens=' + (uo && uo.todayTokens));
  check('L3b 无 usage 的行必须仍计入 calls 而不得被猜出 tokens(null 不是 0 的替身)',
    !!uo && !!uo.byTool && uo.byTool.calls === 4, 'byTool=' + JSON.stringify(uo && uo.byTool));
  // 反向锁(现状即绿):events 走列名聚合,不得被本次改动牵连
  check('L4 反向锁:events 表按列(input_tokens+output_tokens)聚合的 133 必须不受影响',
    !!uo && !!uo.events && uo.events.n >= 1 && uo.events.tokens === 133,
    'events=' + JSON.stringify(uo && uo.events));
  // 写侧形状统一:入站反代记录不得再直接存上游原样(否则新数据继续生产形状①,读侧兼容只是止血)
  const srv = fs.readFileSync('./server.js', 'utf-8');
  const rawWrite = /usage:\s*parsed\.usage\s*\|\|/.test(srv);
  check('L5 写侧必须收敛成单一形状:入站反代不得再把上游原样 usage 直接写进 traffic(形状①是病源)',
    !rawWrite, '仍在写上游原样的处数=' + (srv.match(/usage:\s*parsed\.usage\s*\|\|/g) || []).length);
}

// ── M) 吞异常棘轮门禁(#26 指定红集) ──
//   采纳口径(全部经实测定死,写在基线里可追溯):
//     CatchClause:not(:has(CallExpression)):not(:has(ThrowStatement)):not(:has(ReturnStatement))
//   语义 = catch 块里既不记录(无调用)、也不做任何决定(无 return / throw) —— 纯吞。
//   为什么不用更严的"无 CallExpression"一刀切:catch { return false } 这类"有决定的降级"
//   (db.js / sse-replay.js 的命中全属此类)不是留白;把它们也算红,只会逼出无意义的 log 换绿灯。
//   为什么门禁是"旁挂脚本 + 基线棘轮"而不是写进 .eslintrc.json:实测源码 45 处 / 11 文件,
//   写成 error 会当场把 lint 基线从 0 error 打成 45 error(等于毁掉那道"必须 0 error"的门),
//   写成 warn 又无人看 —— 只有"逐文件只降不升 + 基线与实测同源"能既不爆破又真咬人。
section('M) 吞异常棘轮门禁不存在(#26 红集)');
{
  const SELECTOR = 'CatchClause:not(:has(CallExpression)):not(:has(ThrowStatement)):not(:has(ReturnStatement))';
  const GATE = path.join(import.meta.dirname, 'check-swallow-ratchet.mjs');
  const BASELINE = path.join(import.meta.dirname, 'swallow-baseline.json');
  const gateRun = (args) => spawnSync(process.execPath, [GATE, ...args], { cwd: import.meta.dirname, encoding: 'utf-8', timeout: 180000 });

  // 三个语义夹具:空吞 / 注释伪装的空吞 / 有决定的 catch
  fs.writeFileSync(path.join(tmpRoot, 'sw-empty.js'),
    "'use strict';\nfunction a () {\n  try { throw new Error('x'); } catch (e) { }\n}\nmodule.exports = a;\n", 'utf-8');
  fs.writeFileSync(path.join(tmpRoot, 'sw-comment.js'),
    "'use strict';\nfunction b () {\n  try { throw new Error('x'); } catch (e) { /* 有意忽略 */ }\n}\nmodule.exports = b;\n", 'utf-8');
  fs.writeFileSync(path.join(tmpRoot, 'sw-decided.js'),
    "'use strict';\nfunction c () {\n  try { throw new Error('x'); } catch (e) { return false; }\n}\nfunction d () {\n  try { throw new Error('x'); } catch (e) { console.log('降级留痕'); }\n}\nmodule.exports = { c, d };\n", 'utf-8');
  const countOf = (name) => String(gateRun(['--count', path.join(tmpRoot, name)]).stdout || '');

  const run1 = gateRun([]);
  const out1 = String(run1.stdout || '');
  check('#26m1 棘轮门禁必须存在且能在真实树上跑通(退出码 0 并自报 STATUS=ok)',
    run1.status === 0 && /STATUS=ok/.test(out1),
    'status=' + run1.status + ' out=' + out1.substring(0, 120) + ' err=' + String(run1.stderr || '').substring(0, 120));
  check('#26m2 基线必须记录口径原文与逐文件计数,且其 total 必须等于脚本实测 TOTAL(防换口径悄悄降数 / 基线与源码漂移)',
    fs.existsSync(BASELINE) && JSON.parse(fs.readFileSync(BASELINE, 'utf-8')).selector === SELECTOR
      && /TOTAL=(\d+)/.test(out1)
      && JSON.parse(fs.readFileSync(BASELINE, 'utf-8')).total === Number((out1.match(/TOTAL=(\d+)/) || [])[1]),
    '基线在=' + fs.existsSync(BASELINE) + ' out1=' + out1.substring(0, 100));
  check('#26m3 --count 计数语义:纯吞的空 catch 必须算 1 处',
    /COUNT=1/.test(countOf('sw-empty.js')), 'out=' + countOf('sw-empty.js').substring(0, 100));
  check('#26m4 注释不是 AST 节点:带 /*有意忽略*/ 的空 catch 同样必须算 1 处(写注释绕不过门禁)',
    /COUNT=1/.test(countOf('sw-comment.js')), 'out=' + countOf('sw-comment.js').substring(0, 100));
  check('#26m5 哨兵(防逼出噪声):有决定的 catch(return 值 / 调用记录函数)必须算 0 处',
    /COUNT=0/.test(countOf('sw-decided.js')), 'out=' + countOf('sw-decided.js').substring(0, 120));
  // #26m6 棘轮必须真咬:把基线里某个文件的计数改成"实测-1"(假装它已更干净),必须非 0 退出并点名该文件
  const tamperedDir = path.join(tmpRoot, 'sw-tamper');
  fs.mkdirSync(tamperedDir, { recursive: true });
  const tampered = path.join(tamperedDir, 'tampered-baseline.json');
  let target = '';
  if (fs.existsSync(BASELINE)) {
    const bl = JSON.parse(fs.readFileSync(BASELINE, 'utf-8'));
    const files = bl.files || {};
    target = Object.keys(files).sort((a, b) => files[b] - files[a])[0] || '';
    if (target && files[target] > 1) {
      bl.files[target] = files[target] - 1;
      bl.total = bl.total - 1;
      fs.writeFileSync(tampered, JSON.stringify(bl, null, 2), 'utf-8');
      const runT = gateRun(['--baseline', tampered]);
      const shown = String(runT.stdout || '') + String(runT.stderr || '');
      check('#26m6 棘轮必须真咬:基线比源码"更干净"一分(' + target + ' 少计 1)时,必须以非 0 退出并点名该文件',
        runT.status !== 0 && shown.includes(target),
        'status=' + runT.status + ' out=' + shown.substring(0, 180));
    } else {
      check('#26m6 棘轮必须真咬:基线比源码"更干净"一分时,必须以非 0 退出并点名该文件',
        false, '基线里找不到计数 >1 的文件,无法构造增长场景: files=' + JSON.stringify(files).substring(0, 120));
    }
  } else {
    check('#26m6 棘轮必须真咬:基线比源码"更干净"一分时,必须以非 0 退出并点名该文件',
      false, '基线文件不存在,无从构造篡改场景');
  }
  const lintRun = spawnSync('npx', ['eslint', '.', '-f', 'json'], { cwd: import.meta.dirname, encoding: 'utf-8', timeout: 180000, shell: process.platform === 'win32' });
  let lintErr = 0, lintWarn = 0; // -f json 无汇总行,逐文件累加(上一版误从 -1 起算,把 0/18 读成 -1/17)
  try {
    const arr = JSON.parse(String(lintRun.stdout || '[]'));
    for (const f of arr) { lintErr += f.errorCount; lintWarn += f.warningCount; }
  } catch (_) { /* 交给断言判失败 */ }
  check('#26m7 哨兵(不回退):门禁必须是旁挂脚本 —— npx eslint . 仍 0 error / 18 warning(把它写进 .eslintrc 的 error 会当场把源码 45 处打成 45 error,爆破"必须 0 error"这道门)',
    lintErr === 0 && lintWarn === 18, 'errors=' + lintErr + ' warnings=' + lintWarn + ' (解析失败时会是 0/0 或负值,均判失败)');
}

// ── N) 仓库卫生门禁(#29,指挥官亲笔,编码手禁改) ──────────────────────────
//   为什么写成行为锁而不是读 .gitignore 文本:判据必须是"git 眼里的世界",不是"文件里写了啥"。
//   实测现状(2026-10-23):ai-bridge/ 下有 5 个 *.bak-cleanup-* / *.bak-pre-register-* 与
//   test-runtime-data/ 以 `??` 出现在 git status 里(.gitignore 第 130 行只有 `ai-bridge/*.bak`,
//   带后缀的 .bak-cleanup-2026-10-14 不匹配该模式);另 .corrupt-* 保全件(#30/#71 的产物)同样没被
//   忽略——一旦生产真出损坏,取证文件会以"未跟踪垃圾"的形式暴露在工作树里,极易被 `git add -A` 扫进
//   仓库(本项目还有一个公开镜像仓)。反向锁 h4 防"一把梭把 ai-bridge/ 整目录 ignore 掉"这种
//   让配置从版本控制里消失的假修复。
section('N) 仓库卫生:落盘垃圾必须被忽略、配置必须仍被跟踪(#29)');
{
  const REPO = path.resolve(import.meta.dirname, '..'); // 本文件既有约定就是 import.meta.dirname(:419/:485/:540),ESM 里没有 __dirname
  const git = (args) => spawnSync('git', args, { cwd: REPO, encoding: 'utf-8' });
  const ignored = (p) => git(['check-ignore', '-q', p]).status === 0; // 0=被忽略,1=未被忽略
  const porcelain = () => String(git(['status', '--porcelain', 'ai-bridge']).stdout || '').split('\n').filter(Boolean);

  // 真实的垃圾文件名(存在就用真名,不存在就用同形态样本 —— 防套件因目录被清理而假绿/假红)
  const realBak = porcelain().map(l => l.replace(/^\?\?\s*/, '').replace(/^ai-bridge\//, '')).filter(n => /\.bak-/.test(n));
  const bakSample = realBak.length ? 'ai-bridge/' + realBak[0] : 'ai-bridge/switches.json.bak-cleanup-2026-10-14';
  check('#29h1 落盘备份必须被忽略:`ai-bridge/*.bak-*` 这类带后缀的备份不得以未跟踪垃圾出现在工作树'
    + '(现状:' + (realBak.length || '样本') + ' 个;根因是 .gitignore 只有 `*.bak`,不匹配 `.bak-<日期>` 形态)',
    ignored(bakSample), '样本=' + bakSample + ' ignored=' + ignored(bakSample));
  check('#29h2 测试运行目录必须被忽略:`ai-bridge/test-runtime-data/` 是套件自建的落盘目录(#63),不该进工作树',
    ignored('ai-bridge/test-runtime-data/probe.txt'), 'ignored=' + ignored('ai-bridge/test-runtime-data/probe.txt'));
  check('#29h3 损坏保全件必须被忽略:`ai-bridge/*.corrupt-*` 是 #30 的取证产物,既不能被提交、也不该以垃圾示人(#71)',
    ignored('ai-bridge/memory.json.corrupt-2026-01-01T00-00-00-000Z'), 'ignored=' + ignored('ai-bridge/memory.json.corrupt-2026-01-01T00-00-00-000Z'));
  check('#29h4 反向哨兵:配置与源码**必须仍被 git 跟踪**(防"整目录 ignore"式假修复 —— 那会让 tools.json/models.json 从版本控制里消失)',
    !ignored('ai-bridge/tools.json') && !ignored('ai-bridge/server.js')
      && git(['ls-files', '--', 'ai-bridge/tools.json', 'ai-bridge/models.json', 'ai-bridge/server.js']).stdout.split('\n').filter(Boolean).length === 3,
    'tools.json ignored=' + ignored('ai-bridge/tools.json') + ' server.js ignored=' + ignored('ai-bridge/server.js'));
  // 出口判据:git status 里真的不再有 ai-bridge 的 ?? 垃圾(这才是"看起来干净"的定义)
  const stillUntracked = porcelain().filter(l => l.startsWith('?? ')).map(l => l.replace(/^\?\?\s*/, ''))
    .filter(n => /\.bak-|test-runtime-data[/.]|\.corrupt-/.test(n));
  check('#29h5 出口判据(行为级):`git status --porcelain ai-bridge` 不得再出现 .bak-/test-runtime-data/.corrupt- 的未跟踪条目',
    stillUntracked.length === 0, '残留=' + JSON.stringify(stillUntracked).substring(0, 200));
}

// ── O) 文档保真门禁(#61,指挥官亲笔,编码手禁改) ──────────────────────────
//   为什么现在必须把它变成锁:本会话我犯了 6 次"凭记忆写数字/符号"的错(descHasNoSpace 这条
//   根本不存在的锁名、"134 处 sendJSON/5 种键组合"实为 135/66、"13 个 env 未入表"等)。
//   教训已证明:**写成规约文字会复发,只有变成红灯才不再复发**。
//   本段只锁两类零误判的漂移;需要人工裁定的"历史提及/反面提及"类不写成硬锁(见 #61 说明)。
section('O) 文档保真:env 表与源码同源、文档锚点必须可解析(#61)');
{
  const SUITE_DIR = import.meta.dirname; // :419 那个同名常量是 L 段的块内作用域,这里取不到 ⇒ 本段自己声明(文件既有约定就是 import.meta.dirname)
  const SRC_EXT = ['.js', '.mjs', '.cjs'];
  const srcFiles = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (SRC_EXT.includes(path.extname(e.name))) srcFiles.push(p);
    }
  };
  walk(SUITE_DIR);
  const envSrc = new Set();
  for (const f of srcFiles) {
    for (const v of (fs.readFileSync(f, 'utf-8').match(/AI_BRIDGE_[A-Z0-9_]+/g) || [])) envSrc.add(v);
  }
  const docOf = (rel) => fs.readFileSync(path.join(SUITE_DIR, rel), 'utf-8').replace(/\r/g, '');
  const readme = docOf('README.md');
  const arch = docOf('ARCHITECTURE.md');
  const envDoc = new Set([...(readme.match(/AI_BRIDGE_[A-Z0-9_]+/g) || []), ...(arch.match(/AI_BRIDGE_[A-Z0-9_]+/g) || [])]);

  // 严格判据:变量名必须坐在 env 表格的**首格**。
  // 为什么不用"全文出现即算过":那正是我这条锁最初的空子 —— 正文随便提一句名字就能绿,
  // 而运维真正要的是"表里查得到"。本判据先在当前 README 上验证过:33/33 全在首格、
  // 零误杀(误杀=任何正确实现都过不了,是我犯过 6 次的那类不可满足锁)。
  const inEnvTableRow = (varName) => {
    for (const line of readme.split('\n')) {
      if (!/^\s*\|/.test(line)) continue;
      const cells = line.split('|').slice(1, -1).map(s => s.trim());
      if (!cells.length) continue;
      const names = [...cells[0].matchAll(/`?([A-Z][A-Z0-9_]+)`?/g)].map(x => x[1]);
      if (names.includes(varName)) return true;
    }
    return false;
  };
  const undocumented = [...envSrc].filter(v => !inEnvTableRow(v)).sort();
  check('#61a1 源码里每一个 AI_BRIDGE_* 都必须坐在 README env **表格首格**(不是"正文提一句就算过"——'
    + '那正是这条锁最初的空子;运维只查表。现状实测漏 ' + undocumented.length + ' 个)',
    undocumented.length === 0, '不在表内=' + JSON.stringify(undocumented));
  const ghostEnv = [...envDoc].filter(v => !envSrc.has(v)).sort();
  check('#61a2 反向哨兵(不回退):文档里写的每个 AI_BRIDGE_* 都必须真在源码被读取 —— 防"为了实现文档而新增变量"'
    + '的反向漂移,也防我写文档时顺手编一个名字(现状幽灵=' + ghostEnv.length + ')',
    ghostEnv.length === 0, '幽灵=' + JSON.stringify(ghostEnv));

  // 锚点:`xxx.js:NNN` 必须能从 ai-bridge/ 解析到真实文件且行号不越界。
  // 实测病例:ARCHITECTURE 曾把路径写成裸名 `cli-adapter.js` 的第 139 行,真路径是 `adapters/cli-adapter.js` ⇒ 按文档找不到。
  const anchorOf = (text) => {
    const bad = [];
    for (const m of text.matchAll(/([A-Za-z0-9_.\-/]+\.(?:js|mjs|cjs|json|html)):(\d+)/g)) {
      const rel = m[1]; const ln = Number(m[2]);
      const abs = path.join(SUITE_DIR, rel);
      if (!fs.existsSync(abs)) { bad.push(rel + ':' + ln + '(路径不可达)'); continue }
      const n = fs.readFileSync(abs, 'utf-8').replace(/\r/g, '').split('\n').length;
      if (ln > n) bad.push(rel + ':' + ln + '(越界,全文 ' + n + ' 行)');
    }
    return bad;
  };
  const badR = anchorOf(readme); const badA = anchorOf(arch);
  check('#61a3 README 的每个 `文件:行号` 锚点必须可达且行号在界内(锚点失效=按文档去定位的人会找错地方;'
    + '#47/#81 我两次哈希记错就是同一病的路径面)。现状失效=' + badR.length,
    badR.length === 0, JSON.stringify(badR).substring(0, 220));
  check('#61a4 ARCHITECTURE 同上(现状失效=' + badA.length + ',实测病例:裸写 cli-adapter.js:139 而真路径是 adapters/cli-adapter.js)',
    badA.length === 0, JSON.stringify(badA).substring(0, 220));
}

// ── L78) 一本日历(#78 现行发作:todayTokens 用本地日、byDay 用 UTC 日) ────────
//   实测病灶:db.js 的 todayTokens 用**本地**日期组 today,却拿它比 substr(ts,1,10)(存的是 **UTC** ISO);
//   usageReport 的 byDay 也按 `substr(ts,1,10)` 即 **UTC 日**分组 ⇒ 两套日历并存。
//   业务后果(不是洁癖):`AI_BRIDGE_DAILY_TOKEN_BUDGET` 的唯一输入就是 todayTokens,
//   每天本地零点后的那几个小时里它恒 0 —— 预算闸门实际是盲的(指挥官就是在 00:05 撞上 78/79 的)。
//   种子刻意取"本地今天的 00:30 与 23:30"两行:一本日历下它们必然同日、同被计入今日(合计 150);
//   而 UTC/本地混用下 00:30 那行的 UTC 日属于**昨天** ⇒ 分成两天且今日只算 50 ——
//   这样**任何钟点跑都是确定性红灯**,不依赖跑测试的时刻(我上一版锁 L3 就是靠"现在",才会随挂钟翻红)。
section('L78) 用量只能有一本日历(#78)');
{
  const calRunner = path.join(tmpRoot, 'cal78-runner.cjs');
  fs.writeFileSync(calRunner, `'use strict';
const db = require(${JSON.stringify(path.join(import.meta.dirname, 'db.js'))});
const TOOL = 'cal78-tool';
// 本地今天的两个时刻 → toISOString 落成 UTC 存进 ts(写侧格式必须不变,见 c3)
const d = new Date();
const early = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 30, 0).toISOString();
const late = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 30, 0).toISOString();
db.recordTraffic({ tool: TOOL, direction: 'in', ts: early, success: true, type: 'dispatch', usage: { input: 100, output: 0, total: 100 } });
db.recordTraffic({ tool: TOOL, direction: 'in', ts: late, success: true, type: 'dispatch', usage: { input: 50, output: 0, total: 50 } });
const rep = db.usageReport(7);
const days = (rep.byDay || []).filter(x => x.tool === TOOL).map(x => ({ day: x.day, tokens: x.tokens }));
const tss = db.trafficList ? null : null;
process.stdout.write(JSON.stringify({
  todayTokens: db.todayTokens(), days,
  early, late,
  tz: new Date().getTimezoneOffset(),
  // c3 反向锁要用的原始 ts 形状:必须是 UTC ISO(Z 结尾),不得为省事先改成本地串
  tsIsUtc: /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$/.test(early)
}) + '\\n');`, 'utf-8');
  const cr = spawnSync(process.execPath, [calRunner], {
    cwd: import.meta.dirname,
    env: { ...process.env, AI_BRIDGE_DB: path.join(tmpRoot, 'cal78.db'), AI_BRIDGE_DATA_DIR: tmpRoot },
    encoding: 'utf-8', timeout: 20000
  });
  let co = null;
  try { co = JSON.parse((cr.stdout || '').trim().split('\n').pop()); } catch (_) { /* 交给断言判失败 */ }

  check('#78c1 byDay 必须按**同一本日历**分组:本地今天的 00:30 与 23:30 两行必须落在同一个 day 键、'
    + 'tokens 合计 150(现状 byDay 用 substr(ts,1,10)=UTC 日 ⇒ 被劈成两天,报表页与预算页说的不是同一个"今天")',
    !!co && Array.isArray(co.days) && co.days.length === 1 && co.days[0].tokens === 150,
    'days=' + JSON.stringify(co && co.days) + ' tz偏移=' + (co && co.tz) + ' stderr=' + String(cr.stderr || '').substring(0, 90));
  check('#78c2 todayTokens 与 byDay 的"今天"必须相等(一本日历的直接推论;它是 AI_BRIDGE_DAILY_TOKEN_BUDGET '
    + '唯一输入,现状本地零点后那几小时里只算到 50 甚至 0 ⇒ 闸门盲)',
    !!co && co.todayTokens === 150, 'todayTokens=' + (co && co.todayTokens) + ' days=' + JSON.stringify(co && co.days));
  check('#78c3 反向哨兵:修读侧不得顺手改写侧 —— ts 落库必须仍是 UTC ISO(带 Z)。'
    + '改成本地串会让既有历史(全部 UTC)与新数据混在两套格式里,才是真毁账本',
    !!co && co.tsIsUtc === true && /Z$/.test(String(co.early)) && /Z$/.test(String(co.late)),
    'early=' + (co && co.early) + ' late=' + (co && co.late));
  // 跨时区同结论:同一份种子在 TZ=UTC 与 TZ=Asia/Shanghai 下必须给出**相同**的 c1/c2 判定,
  // 否则实现只是"碰巧对本机时区成立"。这里显式再跑一次 UTC。
  const crUtc = spawnSync(process.execPath, [calRunner], {
    cwd: import.meta.dirname,
    env: { ...process.env, TZ: 'UTC', AI_BRIDGE_DB: path.join(tmpRoot, 'cal78-utc.db'), AI_BRIDGE_DATA_DIR: tmpRoot },
    encoding: 'utf-8', timeout: 20000
  });
  let cu = null;
  try { cu = JSON.parse((crUtc.stdout || '').trim().split('\n').pop()); } catch (_) { /* 交给断言判失败 */ }
  // 只比"必须与挂钟无关"的量:天数、tokens 合计、todayTokens。
  // **不比 day 键字面值** —— 正确的实现在 TZ=UTC 与 TZ=Asia/Shanghai 下本来就会给出不同的日期字符串
  // (同一个瞬时对应的本地日不同),拿键面值比会写出"任何正确实现都过不了"的不可满足锁(我犯过 8 次)。
  const sumDays = (o) => ((o && o.days) || []).reduce((a, x) => a + (x.tokens || 0), 0);
  check('#78c4 时区无关性:同一份种子在 TZ=UTC 与本机时区下,**天数、tokens 合计、todayTokens** 三者必须一致'
    + '(防实现只是碰巧对本机时区成立;刻意不比 day 键字面值,那本来就该随时区变)',
    !!cu && !!co && cu.todayTokens === co.todayTokens && (cu.days || []).length === (co.days || []).length
      && sumDays(cu) === sumDays(co),
    'UTC=' + JSON.stringify(cu && { t: cu.todayTokens, n: (cu.days || []).length, sum: sumDays(cu) })
      + ' 本机=' + JSON.stringify(co && { t: co.todayTokens, n: (co.days || []).length, sum: sumDays(co) }));
}

section('#96b) CLI 输出上限必须走 env 数字单点(#96)');
{
  // 病根(adapters/cli-adapter.js:293-294,实测唯一残留的手搓 env 数字解析):
  //   parseInt("1e7")=1 ⇒ MAX_OUTPUT_CHARS=1 ⇒ 任何正常输出都被"输出超过 1 字符上限"误杀,
  //   且这条路径**零留痕**。README:78 把这个 env 写进表里当作可配项,配错就静默自杀。
  //   锁的是行为(经真 runCommand 派发真子进程),不是措辞:允许任一实现,只要非法值回落默认。
  const cliRunner = path.join(tmpRoot, 'cli96-runner.cjs');
  fs.writeFileSync(cliRunner, `'use strict';
const { runCommand } = require(${JSON.stringify(path.join(import.meta.dirname, 'adapters', 'cli-adapter.js'))});
const n = Number(process.env.CASE_N);
runCommand(process.execPath, ['-e', 'process.stdout.write("z".repeat(' + n + '))'], { timeout: 20000 })
  .then(out => process.stdout.write(JSON.stringify({ ok: true, len: out.length }) + '\\n'))
  .catch(e => process.stdout.write(JSON.stringify({ ok: false, msg: String(e && e.message) }) + '\\n'));`, 'utf-8');
  const runCli = (envVal, n) => {
    const env = { ...process.env, CASE_N: String(n) };
    if (envVal === null) delete env.AI_BRIDGE_CLI_MAX_OUTPUT_CHARS;
    else env.AI_BRIDGE_CLI_MAX_OUTPUT_CHARS = envVal;
    const r = spawnSync(process.execPath, [cliRunner], { cwd: import.meta.dirname, env, encoding: 'utf-8', timeout: 40000 });
    let o = null;
    try { o = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch (_) { /* 交给断言判失败 */ }
    return o;
  };
  const bad = runCli('1e7', 500);
  check('#96b1 非法值 "1e7" 不得被当成 1 字符上限:500 字符的正常输出必须成功(现被误杀=派发全灭)',
    !!bad && bad.ok === true, bad ? 'msg=' + String(bad.msg).slice(0, 140) : 'runner 无 JSON 输出');
  const small = runCli('100', 5000);
  check('#96b2 反向哨兵:合法小上限 100 必须仍能终止 5000 字符输出(不许把钳制改成"一律放行")',
    !!small && small.ok === false && /上限/.test(String(small.msg)), JSON.stringify(small));
  const dflt = runCli(null, 20000);
  check('#96b3 反向哨兵:未设置该 env 仍走默认 10MB(2 万字符必须成功)',
    !!dflt && dflt.ok === true, JSON.stringify(dflt));
  const cliSrc = fs.readFileSync(path.join(import.meta.dirname, 'adapters', 'cli-adapter.js'), 'utf-8');
  const nParse = (cliSrc.match(/parseInt\(\s*process\.env\./g) || []).length;
  const nNumber = (cliSrc.match(/Number\(\s*process\.env\./g) || []).length;
  check('#96b4 单一写手:cli-adapter.js 内不得再出现对 process.env 的 parseInt/Number 直解(实测残留 :293)',
    nParse === 0 && nNumber === 0, `parseInt(process.env.)=${nParse} Number(process.env.)=${nNumber}`);
  check('#96b5 单一写手:cli-adapter.js 必须引用 env-int 单点',
    /env-int/.test(cliSrc), '未找到 env-int 引用');
}

section('#101) env 钳制的每一处都必须点名(#101)');
{
  // acorn 与零依赖扫描器双口径对表实测(基线 965b9b1):调用点 18 个,其中 5 个**没传第三个参数 name**
  //   server.js:66 MAX_CONCURRENT_DISPATCH(默认 5)、:67 RESULT_MAX_CHARS(2000)、:70 CLIENT_TTL(300000)
  //   、:225 CACHE_TTL(600000)、:226 CACHE_MAX(100)
  // 病根与 #96 同源但表现不同:env-int 单点在**没拿到 name 时无痕回落**。#96 之后整串匹配已经会拒绝
  // "1e3" 这类前缀写法,于是这三个字变成:运维写 AI_BRIDGE_RESULT_MAX_CHARS=1e3(想要 1000)⇒
  // 改前被 parseInt 宽容成 **1**(dispatch 结果被截到 1 字符)、改后回落 2000 —— 两者**都不告知**。
  // 锁的是行为:真启动中枢,读它自己的 stderr。
  const FIVE = ['AI_BRIDGE_MAX_CONCURRENT_DISPATCH', 'AI_BRIDGE_RESULT_MAX_CHARS', 'AI_BRIDGE_CLIENT_TTL', 'AI_BRIDGE_CACHE_TTL', 'AI_BRIDGE_CACHE_MAX'];
  const HUB_PORT = '9846';
  const d101 = path.join(tmpRoot, 'env101');
  fs.mkdirSync(path.join(d101, 'workspaces'), { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, 'tools.json'), path.join(d101, 'tools.json'));
  const bootHub = (extra) => spawnSync(process.execPath, ['server.js'], {
    cwd: import.meta.dirname,
    env: {
      ...process.env,
      AI_BRIDGE_PORT: HUB_PORT,
      AI_BRIDGE_HOST: '127.0.0.1',
      AI_BRIDGE_DATA_DIR: d101,
      AI_BRIDGE_DB: path.join(d101, 'b.db'),
      AI_BRIDGE_WORKSPACE_ROOT: path.join(d101, 'workspaces'),
      AI_BRIDGE_TOOLS_PATH: path.join(d101, 'tools.json'),
      AI_BRIDGE_TOKEN: 't101-sandbox',
      ...extra
    },
    encoding: 'utf-8', timeout: 3000, maxBuffer: 8 * 1024 * 1024
  });
  const bad = bootHub(Object.fromEntries(FIVE.map(v => [v, '1e3'])));
  const badErr = String(bad.stderr || '');
  const named = FIVE.filter(v => badErr.includes(v));
  check('#101a1 真启动中枢:五个静默回落点必须各自在 stderr 点名(实测缺 name 的正是这 5 处)',
    named.length === 5, '点名 ' + named.length + '/5;' + JSON.stringify(FIVE.filter(v => !named.includes(v)))
      + ' [env] 行数=' + (badErr.match(/\[env\]/g) || []).length);
  const clean = bootHub({});
  check('#101a2 反向哨兵:一个非法值都不设时启动必须零 [env] 留痕(钳制不得被改成噪音)',
    !/\[env\]/.test(String(clean.stderr || '')), 'stderr 摘要=' + String(clean.stderr || '').replace(/\s+/g, ' ').slice(0, 200));
  check('#101a3 非法 env 回落默认后中枢仍须活到超时(钳制改动不得把中枢弄得起不来)',
    !!bad.error && bad.error.code === 'ETIMEDOUT' && !!clean.error && clean.error.code === 'ETIMEDOUT',
    'bad.error=' + JSON.stringify(bad.error && bad.error.code) + ' status=' + bad.status
      + ' clean.error=' + JSON.stringify(clean.error && clean.error.code));
  // 结构锁:调用点级"必须传 name"。用零依赖扫描器(acorn 只是 eslint 的传递依赖,锁定测试不得挂在它上面)。
  // 口径:名+左括号 → 括号配平 → 数顶层逗号;跳过行注释/块注释里的同名词。与 acorn 对表实测 18/5。
  const scanCalls = (src, names) => {
    const out = []
    for (const nm of names) {
      let at = -1
      while ((at = src.indexOf(nm + '(', at + 1)) !== -1) {
        const lineStart = src.lastIndexOf('\n', at) + 1
        const before = src.slice(lineStart, at)
        if (before.includes('//') || before.includes('/*') || before.includes('* ')) continue
        let depth = 0, commas = 0, j = at + nm.length, closed = false, str = null
        for (; j < src.length; j++) {
          const ch = src[j]
          if (str) { if (ch === '\\') { j++; continue } if (ch === str) str = null; continue }
          if (ch === '"' || ch === "'" || ch === '`') { str = ch; continue }
          if (ch === '(' || ch === '[' || ch === '{') depth++
          else if (ch === ')' || ch === ']' || ch === '}') { depth--; if (depth === 0 && ch === ')') { closed = true; break } }
          else if (ch === ',' && depth === 1) commas++
        }
        if (!closed) continue
        const inner = src.slice(at + nm.length + 1, j)
        out.push({ line: src.slice(0, at).split('\n').length, argc: inner.trim() === '' ? 0 : commas + 1 })
      }
    }
    return out
  };
  const walkSrc = (d, acc = []) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { if (!['node_modules', 'test-runtime-data', 'workspaces', 'output', '.git'].includes(e.name)) walkSrc(p, acc) } else if (/\.(js|mjs|cjs)$/.test(e.name) && !/^test-/.test(e.name) && e.name !== 'env-int.js') acc.push(p)
    }
    return acc
  };
  const sites = [];
  for (const f of walkSrc(import.meta.dirname)) {
    for (const s of scanCalls(fs.readFileSync(f, 'utf-8').replace(/\r/g, ''), ['parsePositiveInt', 'parseNonNegativeInt'])) {
      sites.push({ file: path.relative(import.meta.dirname, f).replace(/\\/g, '/'), ...s })
    }
  }
  const missing = sites.filter(s => s.argc < 3);
  check('#101b1 每一个 parse*Int 调用点都必须传第三个参数 name(实测缺 5 处)',
    missing.length === 0, '缺 name=' + missing.map(m => m.file + ':' + m.line).join(','));
  check('#101b2 反向哨兵:扫描器必须仍看见 >= 18 个调用点(否则 b1 是"空对空"的假绿——#27s9b/#74s1 同类病)',
    sites.length >= 18, '扫描器看见=' + sites.length + '(acorn 对表实测 18)');
}

section('#102) CLI 输出上限的留痕时机:启动即点名,且同一变量每进程最多一次(#102)');
{
  // 现状(#96 之后):`adapters/cli-adapter.js:295` 把上限求值写在 runCommand 内部 ⇒ 两个可观测缺陷:
  //   ① 配置写错时中枢**启动完全正常、零痕迹**,运维永远不知道自己写错过(直到第一条派发);
  //   ② 反过来,一旦派发就开始**每次调用重复刷同一条 warn**,噪声随任务数线性增长。
  // 锁的是行为,不指定实现:允许模块顶层求值、构造期求值或"已留痕"去重,只要满足 a1(启动即点名)与 a2(每进程至多一次)。
  const CLI_ENV = 'AI_BRIDGE_CLI_MAX_OUTPUT_CHARS';
  const HUB_PORT_102 = '9852';
  const d102 = path.join(tmpRoot, 'cli102');
  fs.mkdirSync(path.join(d102, 'workspaces'), { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, 'tools.json'), path.join(d102, 'tools.json'));
  const hubEnv = (extra) => ({
    ...process.env,
    AI_BRIDGE_PORT: HUB_PORT_102,
    AI_BRIDGE_HOST: '127.0.0.1',
    AI_BRIDGE_DATA_DIR: d102,
    AI_BRIDGE_DB: path.join(d102, 'b.db'),
    AI_BRIDGE_WORKSPACE_ROOT: path.join(d102, 'workspaces'),
    AI_BRIDGE_TOOLS_PATH: path.join(d102, 'tools.json'),
    AI_BRIDGE_TOKEN: 't102-sandbox',
    ...extra
  });
  const traceCount = (text) => (String(text || '').match(/\[env\][^\n]*AI_BRIDGE_CLI_MAX_OUTPUT_CHARS/g) || []).length;

  const boot = (env) => spawnSync(process.execPath, ['server.js'], {
    cwd: import.meta.dirname, env, encoding: 'utf-8', timeout: 3000, maxBuffer: 8 * 1024 * 1024
  });
  const noisy = boot(hubEnv({ [CLI_ENV]: '1e7' }));
  check('#102a1 中枢启动即须点名该 env(派发前就该说,现状是零痕迹 ⇒ 配置写错无人知晓)',
    traceCount(noisy.stderr) >= 1, '[env] 行数=' + traceCount(noisy.stderr) + ' stderr 摘要=' + String(noisy.stderr || '').replace(/\s+/g, ' ').slice(0, 160));

  const dbl = path.join(tmpRoot, 'cli102-double.cjs');
  fs.writeFileSync(dbl, `'use strict';
const { runCommand } = require(${JSON.stringify(path.join(import.meta.dirname, 'adapters', 'cli-adapter.js'))});
const one = () => runCommand(process.execPath, ['-e', 'process.stdout.write("y".repeat(50))'], { timeout: 20000 });
(async () => {
  const a = await one();
  const b = await one();
  process.stdout.write(JSON.stringify({ ok: true, la: a.length, lb: b.length }) + '\\n');
})().catch(e => process.stdout.write(JSON.stringify({ ok: false, msg: String(e && e.message) }) + '\\n'));`, 'utf-8');
  const twice = spawnSync(process.execPath, [dbl], {
    cwd: import.meta.dirname, env: { ...hubEnv({ [CLI_ENV]: '1e7' }) }, encoding: 'utf-8', timeout: 40000, maxBuffer: 8 * 1024 * 1024
  });
  let tw = null;
  try { tw = JSON.parse((twice.stdout || '').trim().split('\n').pop()); } catch (_) { /* 交给断言判失败 */ }
  check('#102a2 同一变量的非法留痕每进程最多一次(现状每次 runCommand 刷一条 ⇒ 噪声随任务数线性增长)',
    tw && tw.ok === true && traceCount(twice.stderr) === 1,
    '留痕=' + traceCount(twice.stderr) + ' 结果=' + JSON.stringify(tw));

  const clean = boot(hubEnv({}));
  check('#102a3 反向哨兵:该 env 未设置时启动必须零留痕(点名不得变成开机噪音)',
    traceCount(clean.stderr) === 0, '[env] 行数=' + traceCount(clean.stderr));

  const bigRun = spawnSync(process.execPath, [dbl], {
    cwd: import.meta.dirname, env: { ...hubEnv({ [CLI_ENV]: '10' }) }, encoding: 'utf-8', timeout: 40000, maxBuffer: 8 * 1024 * 1024
  });
  const smallRun = spawnSync(process.execPath, [dbl], {
    cwd: import.meta.dirname, env: { ...hubEnv({ [CLI_ENV]: '100' }) }, encoding: 'utf-8', timeout: 40000, maxBuffer: 8 * 1024 * 1024
  });
  const parseOut = (r) => { try { return JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch (_) { return null } };
  const big = parseOut(bigRun);
  const small = parseOut(smallRun);
  check('#102a4 反向哨兵:把求值挪到启动期后,合法上限仍必须真的生效(10 字符上限须终止 50 字符输出)',
    big && big.ok === false && /上限/.test(String(big.msg)), '上限=10 那栏=' + JSON.stringify(big));
  check('#102a5 反向哨兵:合法上限 100 下 50 字符输出必须成功,且零留痕(钳制既没空转也没噪音)',
    small && small.ok === true && small.la === 50 && small.lb === 50 && traceCount(smallRun.stderr) === 0,
    '上限=100 那栏=' + JSON.stringify(small) + ' 留痕=' + traceCount(smallRun.stderr));
}

section('#105) 隔离期 ACL 写被拒不得报成功(真启动中枢 + 真 HTTP)');
{
  // 实测取证(基线 dfa0e97,四重隔离沙箱 9863 的真中枢):clients-acl.json 被隔离时
  //   POST /api/clients/approve ⇒ HTTP 200 {"success":true,"status":"approved"}
  //   同一进程却写出了「存储文件 clients-acl.json 拒写（原因: 解析失败: …）」,且活文件不在
  //   (只剩 .corrupt-* 保全件)⇒ **批准没落盘却告诉调用方成功**。这是 #43 收过的病
  //   ("写被拒却报 200 成功")换到 ACL 面:#43 当年只修工作区路径,server.js 里 5 处
  //   store.saveACL(acl) 全是**裸调用、返回值被丢**(实测 :1674/:1683/:1699/:1715/:1745)。
  // 口径按 #43/#73:隔离期必须回 503 并带原因,不许 200,也不许用 404 假装。
  const SERVER = path.join(import.meta.dirname, 'server.js');
  const mkChild = (mode, port) => {
    const dir = path.join(tmpRoot, 'acl105-' + mode);
    const wsRoot = path.join(dir, 'workspaces');
    fs.mkdirSync(wsRoot, { recursive: true });
    fs.copyFileSync(path.join(import.meta.dirname, 'tools.json'), path.join(dir, 'tools.json'));
    fs.writeFileSync(path.join(dir, 'clients-acl.json'),
      mode === 'dirty' ? '{"allowlist":["good-client"],"blocklist":["bad-client"'
        : '{"allowlist":["good-client"],"blocklist":[],"pending":[]}', 'utf-8');
    const runner = path.join(tmpRoot, 'acl105-runner-' + mode + '.cjs');
    fs.writeFileSync(runner, `'use strict';
const http = require('http');
const port = Number(process.env.CASE_PORT);
const tok = process.env.CASE_TOK;
require(process.env.CASE_SERVER);
const call = (method, p, body) => new Promise(res => {
  const data = JSON.stringify(body || {});
  const q = http.request({ hostname: '127.0.0.1', port, path: p, method, headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, rr => {
    let b = '';
    rr.on('data', d => { b += d });
    rr.on('end', () => res({ status: rr.statusCode, body: b }));
  });
  q.on('error', e => res({ status: 0, body: String(e.code) }));
  q.end(data);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let health = { status: 0 };
  for (let i = 0; i < 40; i++) {
    health = await call('GET', '/api/health', {});
    if (health.status === 200) break;
    await sleep(300);
  }
  const approve = await call('POST', '/api/clients/approve', { clientId: 'p105' });
  const deny = await call('POST', '/api/clients/deny', { clientId: 'p105' });
  const kick = await call('POST', '/api/clients/kick', { clientId: 'p105' });
  const list = await call('GET', '/api/clients', {});
  await sleep(900);
  // 末行才是本探针的结果:中枢自己会往 stdout 写启动横幅,整段 JSON.parse 必失败
  process.stdout.write(JSON.stringify({ health: health.status, approve, deny, kick, listStatus: list.status }) + '\\n');
  process.exit(0);
})();`, 'utf-8');
    const r = spawnSync(process.execPath, [runner], {
      cwd: import.meta.dirname,
      env: {
        ...process.env,
        CASE_SERVER: SERVER, CASE_PORT: String(port), CASE_TOK: 't105-' + mode,
        AI_BRIDGE_PORT: String(port), AI_BRIDGE_HOST: '127.0.0.1',
        AI_BRIDGE_DATA_DIR: dir, AI_BRIDGE_DB: path.join(dir, 'b.db'),
        AI_BRIDGE_WORKSPACE_ROOT: wsRoot, AI_BRIDGE_TOOLS_PATH: path.join(dir, 'tools.json'),
        AI_BRIDGE_TOKEN: 't105-' + mode
      },
      encoding: 'utf-8', timeout: 45000, maxBuffer: 8 * 1024 * 1024
    });
    let j = null;
    // 只取 stdout 的最后一个非空行(前面的都是中枢自己的横幅);拿不到就报 null 让断言红得有形状
    const lastLine = String(r.stdout || '').split(/\r?\n/).filter(Boolean).pop();
    try { j = JSON.parse(lastLine); } catch (_) { /* 交给断言判失败 */ }
    let live = null;
    try { live = fs.readFileSync(path.join(dir, 'clients-acl.json'), 'utf-8'); } catch (_) { live = null; }
    return { j, live, stderr: String(r.stderr || '') };
  };

  const dirty = mkChild('dirty', 9881);
  const clean = mkChild('clean', 9882);
  // 统一的"诚实拒绝"判据:5xx + 正文不许有 success:true + 必须给出原因(#43/#73 口径)
  const refusedHonestly = (x) => !!x && x.status >= 500 && !/"success"\s*:\s*true/.test(x.body) && /原因/.test(x.body);
  check('#105a1 隔离期 approve 不得报成功(须 5xx 且正文含原因;实测基线是 200 success:true)',
    refusedHonestly(dirty.j && dirty.j.approve),
    'approve=' + JSON.stringify(dirty.j && dirty.j.approve).slice(0, 200));
  check('#105a2 隔离期 deny 同样不得报成功(它还会顺手踢掉在线客户端,更要说清没落盘)',
    refusedHonestly(dirty.j && dirty.j.deny),
    'deny=' + JSON.stringify(dirty.j && dirty.j.deny).slice(0, 200));
  check('#105a3 隔离期 kick 同样不得报成功',
    refusedHonestly(dirty.j && dirty.j.kick),
    'kick=' + JSON.stringify(dirty.j && dirty.j.kick).slice(0, 200));
  check('#105a4 被拒的批准确实没落盘(活 clients-acl.json 里不得出现 p105;原件已改名保全也算通过)',
    !!dirty.j && !(typeof dirty.live === 'string' && dirty.live.includes('p105')),
    '活文件存在=' + (dirty.live !== null) + ' 内容前 120=' + JSON.stringify(String(dirty.live).slice(0, 120)));
  check('#105a5 反向哨兵:隔离期只影响写,读面必须照旧 200(降级不崩,#44/#52 同口径)',
    !!dirty.j && dirty.j.health === 200 && dirty.j.listStatus === 200,
    'health=' + (dirty.j && dirty.j.health) + ' GET /api/clients=' + (dirty.j && dirty.j.listStatus));
  check('#105a6 反向哨兵:健康态 approve 必须照旧 200 success:true 且真的落盘(修复不许把正常路径一起拒掉)',
    !!clean.j && clean.j.approve.status === 200 && /"success"\s*:\s*true/.test(clean.j.approve.body)
      && typeof clean.live === 'string' && clean.live.includes('p105'),
    'approve=' + JSON.stringify(clean.j && clean.j.approve).slice(0, 160) + ' 落盘含 p105=' + (typeof clean.live === 'string' && clean.live.includes('p105')));

  const srvSrc = fs.readFileSync(SERVER, 'utf-8').replace(/\r/g, '');
  const bare = srvSrc.split('\n').filter(L => /^\s*store\.saveACL\([^)]*\);\s*$/.test(L));
  check('#105a7 结构锁:server.js 内每一处 store.saveACL 都必须消费返回值(实测基线 5 处裸调用)',
    bare.length === 0, '裸调用=' + bare.length + ' 行号=' + srvSrc.split('\n')
      .map((L, i) => [L, i + 1]).filter(([L]) => /^\s*store\.saveACL\([^)]*\);\s*$/.test(L)).map(([, i]) => i).join(','));
}

section('#106) 隔离期建会不得报成功(真启动中枢 + 真 HTTP + 读盘核对)');
{
  // 取证(基线 6f497e4 之后的树,四重隔离沙箱 9902,memory.json 启动即坏 ⇒ 中枢当场隔离):
  //   POST /api/discuss ⇒ HTTP 200 {"meetingId":"meeting_1792789570943","status":"discussing",…}
  //   同一次运行 logs.jsonl 却有:`存储文件 memory.json 拒写（原因: 解析失败: …）`,且 memory.json 已不在原位
  //   ⇒ 会议**哪都没存住**(store 无缓存:每次读都走 load();createMeeting 自己也 saveSync),后续任何按该 id 的
  //   interrupt/inject/status 实测都回 404「会议不存在」。这是 #43/#105 同型的谎:响应宣称已开始,落盘被拒。
  // 台账更正:此前把本单写成"6 处丢弃返回值(含 :88/:89 包装)"——实测整句丢弃型只有 **5** 处,
  //   且其中 interrupt/inject/后台 updateMeeting 三处在隔离态**根本走不到**(读不到会议就先 404),
  //   真正可达并说谎的是**建会回执**;:88/:89 那个包装函数是有 return 的,由调用点决定,不计入。
  const SERVER = path.join(import.meta.dirname, 'server.js');
  const d106 = (mode, port) => {
    const dir = path.join(tmpRoot, 'disc106-' + mode);
    fs.mkdirSync(path.join(dir, 'workspaces'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'ws'), { recursive: true });
    fs.copyFileSync(path.join(import.meta.dirname, 'tools.json'), path.join(dir, 'tools.json'));
    if (mode === 'dirty') fs.writeFileSync(path.join(dir, 'memory.json'), '{"tasks":[],"meetings":[{"id":"x"', 'utf-8');
    const runner = path.join(tmpRoot, 'disc106-runner.cjs');
    fs.writeFileSync(runner, `'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const port = Number(process.env.CASE_PORT);
const tok = process.env.CASE_TOK;
const dir = process.env.AI_BRIDGE_DATA_DIR;
require(process.env.CASE_SERVER); // 在本进程内起真中枢
const call = (method, p, body) => new Promise(res => {
  const data = JSON.stringify(body || {});
  const q = http.request({ hostname: '127.0.0.1', port, path: p, method, headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, rr => {
    let b = '';
    rr.on('data', d => { b += d });
    rr.on('end', () => res({ status: rr.statusCode, raw: b }));
  });
  q.on('error', e => res({ status: 0, raw: String(e.code) }));
  q.setTimeout(8000, () => { q.destroy(); res({ status: 0, raw: 'TIMEOUT' }) });
  q.end(data);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jsonOf = (r) => { try { return JSON.parse(r.raw) } catch (e) { return null } };
(async () => {
  let health = { status: 0 };
  for (let i = 0; i < 40; i++) { health = await call('GET', '/api/health'); if (health.status === 200) break; await sleep(300) }
  // max_tokens=0 ⇒ 首位发言者前即自动止损:不派发任何真 CLI、不花配额(与 e2e 既有做法同)
  const created = await call('POST', '/api/discuss', { topic: '#106 取证', participants: [], round2: false, implement: false, max_tokens: 0 });
  const cb = jsonOf(created) || {};
  const mid = cb.meetingId || null;
  const it = await call('POST', '/api/discuss/interrupt', { meetingId: mid || 'no-such', reason: '#106' });
  const inj = await call('POST', '/api/discuss/inject', { meetingId: mid || 'no-such', message: 'm' });
  const lst = await call('GET', '/api/meetings');
  let onDisk = false;
  for (let i = 0; i < 12 && !onDisk; i++) {
    await sleep(300);
    try { onDisk = String(fs.readFileSync(path.join(dir, 'memory.json'), 'utf-8')).indexOf(String(mid)) !== -1 } catch (e) { onDisk = false }
  }
  process.stdout.write(JSON.stringify({
    health: health.status, createdStatus: created.status, createdRaw: String(created.raw).slice(0, 240), mid,
    itStatus: it.status, injStatus: inj.status, lstStatus: lst.status, onDisk
  }) + '\\n');
  process.exit(0);
})();`, 'utf-8');
    const r = spawnSync(process.execPath, [runner], {
      cwd: import.meta.dirname,
      env: {
        ...process.env,
        CASE_SERVER: SERVER, CASE_PORT: String(port), CASE_TOK: 't106-' + mode,
        AI_BRIDGE_PORT: String(port), AI_BRIDGE_HOST: '127.0.0.1',
        AI_BRIDGE_DATA_DIR: dir, AI_BRIDGE_DB: path.join(dir, 'b.db'),
        AI_BRIDGE_WORKSPACE_ROOT: path.join(dir, 'ws'),
        AI_BRIDGE_TOOLS_PATH: path.join(dir, 'tools.json'),
        AI_BRIDGE_TOKEN: 't106-' + mode
      },
      encoding: 'utf-8', timeout: 60000, maxBuffer: 8 * 1024 * 1024
    });
    let j = null;
    // 只取末行:中枢自己的横幅与 stdout 日志在同一条流上(整段 parse 必失败——我踩过一次)
    const last = String(r.stdout || '').split(/\r?\n/).filter(Boolean).pop();
    try { j = JSON.parse(last); } catch (_) { /* 交给断言判失败 */ }
    return j;
  };

  const dirty = d106('dirty', 9903);
  check('#106a1 隔离期建会不得回 2xx 宣称开会成功(必须 5xx 且给出原因;实测基线 200+meetingId)',
    !!dirty && dirty.createdStatus >= 500 && /原因/.test(String(dirty.createdRaw)),
    'createdStatus=' + (dirty && dirty.createdStatus) + ' body=' + JSON.stringify(dirty && dirty.createdRaw).slice(0, 200));
  check('#106a2 旁证说谎前提:该会议确实没落到 memory.json(读盘核对 meetingId 不在)',
    !!dirty && dirty.mid !== null && dirty.onDisk === false,
    'mid=' + JSON.stringify(dirty && dirty.mid) + ' onDisk=' + JSON.stringify(dirty && dirty.onDisk));
  check('#106a3 隔离期按该 id 的 interrupt/inject 必须仍 404(不得变 500,也不得谎报成功)',
    !!dirty && dirty.itStatus === 404 && dirty.injStatus === 404,
    'interrupt=' + (dirty && dirty.itStatus) + ' inject=' + (dirty && dirty.injStatus));
  check('#106a4 反向哨兵:隔离期读面照旧 200(health 与 /api/meetings 都不许崩;#44/#52 降级不崩的口径)',
    !!dirty && dirty.health === 200 && dirty.lstStatus === 200,
    'health=' + (dirty && dirty.health) + ' meetings=' + (dirty && dirty.lstStatus));
  const clean = d106('clean', 9904);
  check('#106a5 反向哨兵:健康态建会必须照旧 200 + meetingId 且**真的落盘**(修复不许把正常路径一起拒掉)',
    !!clean && clean.createdStatus === 200 && !!clean.mid && clean.onDisk === true,
    JSON.stringify(clean));

  const srvSrc = fs.readFileSync(SERVER, 'utf-8').replace(/\r/g, '');
  const bareSync = srvSrc.split('\n').map((L, i) => [L, i + 1]).filter(([L]) => /^\s*store\.saveSync\(/.test(L));
  check('#106a6 结构锁:server.js 不得再有整句丢弃 store.saveSync 返回值的写点(实测基线 5 处)',
    bareSync.length === 0, '裸调用=' + bareSync.length + ' 行号=' + bareSync.map(([, i]) => i).join(','));
}

section('#109) store 内部的建会写点也必须把"落盘事实"回传(同一纪律不许有两把尺)');
{
  // 取证(基线 66e7925 的树,判据本轮由 measure 脚本回源实测,不沿用台账旧行号):
  //   store.js 的 saveSync 调用点共 7 处(:294/:318/:338/:366/:397/:410/:525),其中 6 处都消费了返回值
  //   (return saveSync / !saveSync 条件),**唯一一处整句丢弃是 :294 的 createMeeting**
  //   —— 台账写的 :310 是 #104 之前(-16 行)的旧号。
  //   后果不是"HTTP 说谎"(那一面 #106 已在调用方堵住:server.js 建会后 loadMemory().find() 反查,
  //   找不到即 503),而是**诚实来源放错了地方**:store 知道真假却不回传,调用方只能"再读一遍碰巧找不到"
  //   去猜(同一规则两处实现,#73/#81/#86/#104 家族)。第二个调用方一旦不猜,就会直接拿到游离对象。
  //   本格把事实回传给调用方:判据 a2 钉 store 契约、a3 钉 server 消费,行为面由 #106a1~a5 全程不回退来守。
  const STORE = path.join(import.meta.dirname, 'store.js');
  const storeSrc = fs.readFileSync(STORE, 'utf-8').replace(/\r/g, '');
  const srvSrc2 = fs.readFileSync(path.join(import.meta.dirname, 'server.js'), 'utf-8').replace(/\r/g, '');
  const bareStore = storeSrc.split('\n').map((l, i) => [l, i + 1]).filter(([l]) => /^\s*saveSync\s*\([^)]*\);\s*$/.test(l));
  check('#109a1 结构锁:store.js 内每一处 saveSync 都必须消费返回值(实测基线 1 处裸调=:294 createMeeting)',
    bareStore.length === 0,
    '裸调用=' + bareStore.length + ' 行号=' + bareStore.map(([, i]) => i).join(','));
  const cm = storeSrc.match(/function createMeeting \([\s\S]*?\n\}/);
  check('#109a2 createMeeting 必须把落盘事实回传给调用方(段内须消费 saveSync 返回值,不得再裸调)',
    !!cm && /return\s+(saveSync|\{[^}]*persisted)/.test(cm[0]) && !/^\s*saveSync\s*\([^)]*\);\s*$/m.test(cm[0]),
    '段命中=' + (!!cm) + ' 段内消费=' + (cm ? /return\s+(saveSync|\{[^}]*persisted)/.test(cm[0]) : 'n/a')
      + ' 段内仍裸调=' + (cm ? /^\s*saveSync\s*\([^)]*\);\s*$/m.test(cm[0]) : 'n/a'));
  check('#109a3 server 建会路径的诚实来源必须是 store 回传的 persisted(不得只靠"再读一遍找不到"反查)',
    /const\s*\{\s*meeting\s*,\s*persisted\s*\}\s*=\s*store\.createMeeting\(/.test(srvSrc2)
      && /let\s+metadataSaved\s*=\s*persisted\b/.test(srvSrc2),
    '解构 persisted=' + /const\s*\{\s*meeting\s*,\s*persisted\s*\}\s*=\s*store\.createMeeting\(/.test(srvSrc2)
      + ' metadataSaved 初值=persisted=' + /let\s+metadataSaved\s*=\s*persisted\b/.test(srvSrc2));
  // 反向哨兵:编码手不得"顺手"把 store 其余写点的消费形态改坏(它们各锁着自己的行为面)
  const retN = (storeSrc.match(/return\s+saveSync\s*\(/g) || []).length;
  const condN = (storeSrc.match(/!\s*saveSync\s*\(/g) || []).length;
  const allN = (storeSrc.match(/saveSync\s*\(/g) || []).length;
  check('#109a4 反向哨兵:store 其余 saveSync 消费形态不得被重构顺手带走(return 5 处、条件 1 处、含定义共 8 处)',
    retN === 5 && condN === 1 && allN === 8, 'return=' + retN + ' 条件=' + condN + ' 总数=' + allN);
  check('#109a5 反向哨兵:建会 503 必须仍带 meetingId(#106a2"说谎前提"的旁证不许断)',
    /meetingId:\s*meeting\.id/.test(srvSrc2), 'meetingId 透出=' + /meetingId:\s*meeting\.id/.test(srvSrc2));
}

section('#110) 讨论循环中途 memory 被隔离必须自动止损(不留幽灵循环、不继续烧派发)');
{
  // 取证(基线 3f9f7a6 的树,判据本轮实测):
  //   讨论循环里的持久化点 = 闭包函数 `updateMeeting()`(server.js:2607,8 个调用点)+ `store.addMessage()`(11 处)
  //   + `store.closeMeeting()`(1 处)。#106 R4 只让 updateMeeting **回传** null,注释自己写着
  //   「现有调用点全部忽略返回值」⇒ 循环跑到一半 memory.json 被隔离时:每轮照派下一个发言者、
  //   止损判定/轮次/统计全在闭包里走、磁盘一无所获,并且继续花真实派发配额(幽灵循环的存量变种)。
  //   本段用「3 个本地假 CLI 参与者 + 首位发言者在途时把 memory.json 改成截断字节」把这件事变成
  //   **可数的行为**:计数文件里假 CLI 被调几次。修好 ⇒ ≤1 次(看门狗在 2 次持久化失败后走
  //   finalizeAutoStop 收尾,后续发言者根本不该被派发);现状 ⇒ 全部发言者都派完。
  //   反向哨兵 a4 钉住"健康会议不许被看门狗误杀":同样的 3 个参与者、不损坏文件 ⇒ 必须照旧全派完。
  const SERVER110 = path.join(import.meta.dirname, 'server.js');
  const mkSandbox = (tag) => {
    const dir = path.join(tmpRoot, 'disc110-' + tag);
    fs.mkdirSync(path.join(dir, 'workspaces'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'ws'), { recursive: true });
    const counter = path.join(dir, 'counter.txt').replace(/\\/g, '/');
    const fake = path.join(dir, 'fake110.cjs');
    fs.writeFileSync(fake, `'use strict';
const fs = require('fs');
try { fs.appendFileSync(${JSON.stringify(counter)}, String(Date.now()) + '\\n', 'utf-8'); } catch (e) {}
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600); // 每位发言者 600ms,给"中途损坏"留出在途窗口
console.log('观点:应加持久化看门狗 Z110_MARK');
`, 'utf-8');
    const tools = ['z110a', 'z110b', 'z110c'].map(n => ({
      name: n, displayName: n, description: '#110 本地假 CLI(零网络零配额)',
      transport: 'cli', command: process.execPath.replace(/\\/g, '/'), args: [fake.replace(/\\/g, '/')], timeout: 20000
    }));
    fs.writeFileSync(path.join(dir, 'tools.json'), JSON.stringify(tools), 'utf-8');
    return { dir, counter };
  };
  const runner110 = path.join(tmpRoot, 'disc110-runner.cjs');
  fs.writeFileSync(runner110, `'use strict';
const http=require('http'),fs=require('fs'),path=require('path');
const port=Number(process.env.CASE_PORT),tok=process.env.CASE_TOK,dir=process.env.AI_BRIDGE_DATA_DIR;
const corrupt=process.env.CASE_CORRUPT==='1';
require(process.env.CASE_SERVER);
const call=(m,p,b)=>new Promise(res=>{const d=JSON.stringify(b||{});
 const q=http.request({hostname:'127.0.0.1',port,path:p,method:m,headers:{authorization:'Bearer '+tok,'content-type':'application/json','content-length':Buffer.byteLength(d)}},rr=>{let x='';rr.on('data',y=>{x+=y});rr.on('end',()=>res({status:rr.statusCode,raw:x}))});
 q.on('error',e=>res({status:0,raw:String(e.code)}));q.setTimeout(9000,()=>{q.destroy();res({status:0,raw:'TIMEOUT'})});q.end(d)});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const count=()=>{try{return fs.readFileSync(path.join(dir,'counter.txt'),'utf-8').split(/\\r?\\n/).filter(Boolean).length}catch(e){return 0}};
const lines=(f)=>{try{return String(fs.readFileSync(path.join(dir,f),'utf-8')).split(/\\r?\\n/).filter(Boolean)}catch(e){return []}};
(async()=>{
 let h={status:0};
 for(let i=0;i<45;i++){h=await call('GET','/api/health');if(h.status===200)break;await sleep(300)}
 const created=await call('POST','/api/discuss',{topic:'#110 取证',participants:['z110a','z110b','z110c'],round2:false,implement:false});
 const cb=(()=>{try{return JSON.parse(created.raw)}catch(e){return {}}})();
 const mid=cb.meetingId||null;
 if(corrupt){await sleep(120);try{fs.writeFileSync(path.join(dir,'memory.json'),'{"tasks":[],"meetings":[{"id":"x"','utf-8')}catch(e){}}
 await sleep(14000); // 留足一拍:#99 appendLog 异步落盘,读 logs.jsonl 前必须等
 const logs=lines('logs.jsonl');
 process.stdout.write(JSON.stringify({
  health:h.status, createdStatus:created.status, mid,
  dispatches:count(),
  stopLines:logs.filter(l=>/自动止损/.test(l)).map(l=>l.slice(0,200)),
  refuseLines:logs.filter(l=>/memory\\.json/.test(l)&&/(拒写|损坏|隔离)/.test(l)).length,
  ghostLines:logs.filter(l=>mid&&/会议 /.test(l)&&l.indexOf(mid)!==-1&&/发言完成|第一轮开始|第二轮开始/.test(l)).length
 })+'\\n');
 process.exit(0);
})();`, 'utf-8')
  const run110 = (tag, port, corrupt) => {
    const sb = mkSandbox(tag)
    const r = spawnSync(process.execPath, [runner110], {
      cwd: import.meta.dirname,
      env: {
        ...process.env,
        CASE_SERVER: SERVER110, CASE_PORT: String(port), CASE_TOK: 't110-' + tag, CASE_CORRUPT: corrupt ? '1' : '0',
        AI_BRIDGE_PORT: String(port), AI_BRIDGE_HOST: '127.0.0.1',
        AI_BRIDGE_DATA_DIR: sb.dir, AI_BRIDGE_DB: path.join(sb.dir, 'b.db'),
        AI_BRIDGE_WORKSPACE_ROOT: path.join(sb.dir, 'ws'), AI_BRIDGE_TOOLS_PATH: path.join(sb.dir, 'tools.json'),
        AI_BRIDGE_TOKEN: 't110-' + tag
      },
      encoding: 'utf-8', timeout: 90000, maxBuffer: 16 * 1024 * 1024
    })
    const last = String(r.stdout || '').split(/\r?\n/).filter(Boolean).pop()
    let j = null
    try { j = JSON.parse(last) } catch (_) { /* 交给断言判失败 */ }
    return { j, sb }
  }
  const dmg = run110('dmg', 9906, true)
  const d = dmg.j
  check('#110a1 中途被隔离后,剩余发言者不得继续被派发(看门狗在连续 2 次持久化失败后收手;实测基线=第一轮 3 位全派完)',
    !!d && d.dispatches <= 2,
    JSON.stringify(d && { dispatches: d.dispatches, createdStatus: d.createdStatus, stopLines: d.stopLines.length, refuseLines: d.refuseLines }).substring(0, 240));
  check('#110a2 必须走既有自动止损路径,且原因写清真因(存储拒写/隔离),不得只留一句 warn',
    !!d && Array.isArray(d.stopLines) && d.stopLines.length >= 1 && d.stopLines.some(l => /存储|拒写|隔离|memory/.test(l)),
    '止损留痕=' + JSON.stringify(d && d.stopLines).substring(0, 300));
  check('#110a3 反向哨兵:隔离不得把进程打死(health 仍 200、建会回执仍给出真实结果、memory 拒写留痕确实在)',
    !!d && d.health === 200 && d.refuseLines >= 1,
    JSON.stringify(d && { health: d.health, createdStatus: d.createdStatus, refuseLines: d.refuseLines }).substring(0, 200));
  const hl = run110('healthy', 9907, false)
  const h = hl.j
  check('#110a4 反向哨兵:未被隔离的健康会议必须照旧全部派完并正常收尾(看门狗不许误杀正常路径;实测健康态派发 7 次=3 位发言+共识/投票等后续步)',
    !!h && h.dispatches === 7 && h.refuseLines === 0 && h.health === 200,
    JSON.stringify(h && { dispatches: h.dispatches, refuseLines: h.refuseLines, ghostLines: h.ghostLines, health: h.health }).substring(0, 240));
  // 结构锁:循环内的持久化调用点不得再整句丢弃返回值(#106 R4 回传了 null 却没人接)
  const loopSrc = fs.readFileSync(SERVER110, 'utf-8').replace(/\r/g, '')
  // 判据第一版写成 `…\);\s*$`,把带**随行尾注释**的 `updateMeeting({ totalTokens }); // …` 放过去了
  // ——实测漏 3 处(原基线真值是 20 而非 17)。这是 #77「L5 锁漏抓第三处写手」的同一病,由编码手 P2 提醒后我加固。
  const bareRe = /^\s*(updateMeeting|store\.addMessage|store\.closeMeeting)\([^;]*\);\s*(\/\/.*)?$/
  const bare110 = loopSrc.split('\n').map((l, i) => [l, i + 1]).filter(([l]) => bareRe.test(l)).map(([, i]) => i)
  check('#110a5 结构锁:server.js 内 updateMeeting/store.addMessage/store.closeMeeting 不得有整句丢弃返回值的调用点(判据含尾注释形态;原基线实测 20 处,第一版漏抓 3 处)',
    bare110.length === 0, '裸调用=' + bare110.length + ' 行号=' + bare110.slice(0, 24).join(','));
  // P1(#109 核准并入本单):interrupt/inject 的 503 必须走同族薄封装,不得各写一遍 persistRefusal
  const hasMR = /function meetingRefusal\s*\(/.test(loopSrc)
  const dupRefusal = loopSrc.split('\n').filter(l => /persistRefusal\('memory',\s*`(中断会议|主持人注入)/.test(l)).length
  check('#110a6 会议族 503 必须有单一构造器 meetingRefusal(interrupt/inject 不再各抄一遍 persistRefusal)',
    hasMR && dupRefusal === 0, 'meetingRefusal 定义=' + hasMR + ' 仍在原地手抄=' + dupRefusal);
}

section('#114) 隔离期止损的"为何停止"必须还能被读回(第二落点健康,不随 memory 一起丢)');
{
  // 病灶(#110 的下游残项):finalizeAutoStop 的三处写入 updateMeeting / store.addMessage / closeMeeting
  //   全部经 saveSync('memory') —— 而 memory 此刻已被隔离并改名,三次写入必然全被拒绝 ⇒
  //   「(自动止损: 存储拒写…,讨论提前结束)」这句**只活在 logs.jsonl 与进程计数器里**;
  //   GET /api/discuss/status/<id> 走 store.getMeeting,此时读不到会议 ⇒ 直接 404,
  //   宿主/人来看"这场会为什么停了"得到的回答是"会议不存在"——把"存储故障"谎报成"没这回事"。
  // 口径:止损原因必须另有一个**健康落点**(SQLite events,经既有 db.recordEvent 单点写),
  //   并且 status 视图在 memory 读不到时仍要能从该落点把原因说回来。
  // 三把反向自证防"实现图省事把它做成永远有答案":① 正常收尾的健康会议不得凭空多出止损记录;
  //   ② 真正不存在的会议 id 仍必须 404;③ 不得为此再造第三个 JSON 侧文件(单 sink 纪律)。
  const SERVER114 = path.join(import.meta.dirname, 'server.js');
  const mkSandbox114 = (tag) => {
    const dir = path.join(tmpRoot, 'sb114-' + tag);
    fs.mkdirSync(dir, { recursive: true });
    const counter = path.join(dir, 'counter.txt');
    const fake = path.join(dir, 'fake114.cjs');
    fs.writeFileSync(fake, `'use strict';
const fs = require('fs');
try { fs.appendFileSync(${JSON.stringify(counter)}, String(Date.now()) + '\\n', 'utf-8'); } catch (e) {}
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600); // 每位发言者 600ms,给"中途损坏"留在途窗口
console.log('观点:止损原因要落进第二落点 Z114_MARK');
`, 'utf-8');
    const tools = ['z114a', 'z114b', 'z114c'].map(n => ({
      name: n, displayName: n, description: '#114 本地假 CLI(零网络零配额)',
      transport: 'cli', command: process.execPath.replace(/\\/g, '/'), args: [fake.replace(/\\/g, '/')], timeout: 20000
    }));
    fs.writeFileSync(path.join(dir, 'tools.json'), JSON.stringify(tools), 'utf-8');
    return { dir, counter };
  };
  const runner114 = path.join(tmpRoot, 'disc114-runner.cjs');
  fs.writeFileSync(runner114, `'use strict';
const http=require('http'),fs=require('fs'),path=require('path');
const port=Number(process.env.CASE_PORT),tok=process.env.CASE_TOK,dir=process.env.AI_BRIDGE_DATA_DIR;
const corrupt=process.env.CASE_CORRUPT==='1';
require(process.env.CASE_SERVER);
const call=(m,p,b)=>new Promise(res=>{const d=JSON.stringify(b||{});
 const q=http.request({hostname:'127.0.0.1',port,path:p,method:m,headers:{authorization:'Bearer '+tok,'content-type':'application/json','content-length':Buffer.byteLength(d)}},rr=>{let x='';rr.on('data',y=>{x+=y});rr.on('end',()=>res({status:rr.statusCode,raw:x}))});
 q.on('error',e=>res({status:0,raw:String(e.code)}));q.setTimeout(9000,()=>{q.destroy();res({status:0,raw:'TIMEOUT'})});q.end(d)});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const count=()=>{try{return fs.readFileSync(path.join(dir,'counter.txt'),'utf-8').split(/\\r?\\n/).filter(Boolean).length}catch(e){return 0}};
const lines=(f)=>{try{return String(fs.readFileSync(path.join(dir,f),'utf-8')).split(/\\r?\\n/).filter(Boolean)}catch(e){return []}};
(async()=>{
 let h={status:0};
 for(let i=0;i<45;i++){h=await call('GET','/api/health');if(h.status===200)break;await sleep(300)}
 const created=await call('POST','/api/discuss',{topic:'#114 取证',participants:['z114a','z114b','z114c'],round2:false,implement:false});
 const cb=(()=>{try{return JSON.parse(created.raw)}catch(e){return {}}})();
 const mid=cb.meetingId||null;
 if(corrupt){await sleep(120);try{fs.writeFileSync(path.join(dir,'memory.json'),'{"tasks":[],"meetings":[{"id":"x"','utf-8')}catch(e){}}
 await sleep(13000); // 留足一拍:止损收尾 + appendLog 异步落盘
 const st=await call('GET','/api/discuss/status/'+(mid||'none'));
 const ghost=await call('GET','/api/discuss/status/m114-does-not-exist');
 let memReason=null;
 try{memReason=String(fs.readFileSync(path.join(dir,'memory.json'),'utf-8')).includes('自动止损')}catch(e){memReason='NO-FILE'}
 const jsonFiles=fs.readdirSync(dir).filter(f=>f.endsWith('.json')).sort().join(',');
 const sideStop=fs.readdirSync(dir).filter(f=>/stop|auto/i.test(f)&&f.endsWith('.json')).join(',');
 process.stdout.write(JSON.stringify({
  health:h.status, createdStatus:created.status, mid,
  dispatches:count(),
  statusView:{http:st.status, body:String(st.raw).slice(0,900)},
  ghostView:{http:ghost.status, body:String(ghost.raw).slice(0,160)},
  memReason, jsonFiles, sideStop,
  stopLines:lines('logs.jsonl').filter(l=>/自动止损/.test(l)).map(l=>l.slice(0,160)),
  corruptFiles:fs.readdirSync(dir).filter(f=>f.includes('.corrupt-')).length
 })+'\\n');
 process.exit(0);
})();`, 'utf-8')
  const run114 = (tag, port, corrupt) => {
    const sb = mkSandbox114(tag)
    const r = spawnSync(process.execPath, [runner114], {
      cwd: import.meta.dirname,
      env: {
        ...process.env,
        CASE_SERVER: SERVER114, CASE_PORT: String(port), CASE_TOK: 't114-' + tag, CASE_CORRUPT: corrupt ? '1' : '0',
        AI_BRIDGE_PORT: String(port), AI_BRIDGE_HOST: '127.0.0.1',
        AI_BRIDGE_DATA_DIR: sb.dir, AI_BRIDGE_DB: path.join(sb.dir, 'b.db'),
        AI_BRIDGE_WORKSPACE_ROOT: path.join(sb.dir, 'ws'), AI_BRIDGE_TOOLS_PATH: path.join(sb.dir, 'tools.json'),
        AI_BRIDGE_TOKEN: 't114-' + tag
      },
      encoding: 'utf-8', timeout: 90000, maxBuffer: 16 * 1024 * 1024
    })
    const last = String(r.stdout || '').split(/\r?\n/).filter(Boolean).pop()
    let j = null
    try { j = JSON.parse(last) } catch (_) { /* 交给断言判失败,绝不静默绿 */ }
    return { j, sb }
  }
  const dmg114 = run114('dmg', 9908, true)
  const hl114 = run114('hlth', 9909, false)
  const D = dmg114.j || {}, H = hl114.j || {}
  const reasonIn = (s) => /自动止损|存储拒写|隔离/.test(String(s || ''))
  check('#114a1 红:中途被隔离后 GET /api/discuss/status/<id> 仍必须把"为何停止"说回来(现状=读不到会议,直接 404)',
    D.statusView?.http === 200 && reasonIn(D.statusView.body),
    'status=' + (D.statusView && D.statusView.http) + ' body=' + JSON.stringify(String(D.statusView && D.statusView.body).substring(0, 300)) + ' mid=' + D.mid)
  // 注意:隔离会把 memory.json 改名成 .corrupt-* 保全 ⇒ "原因不在 memory 落点"有两种真实形态
  //   (文件已不在 = 'NO-FILE',或文件仍在但其中没有止损文案 = false)。判据必须两者都算,
  //   否则就是"实现修好了也永远打不绿"的不可满足锁(本会话已栽过 6 次,这条注释就是防第 7 次)。
  const memLacksReason = D.memReason === false || D.memReason === 'NO-FILE'
  check('#114a2 单落点证明:该原因**不在** memory.json 落点里(写确实被拒/文件已被改名保全)却仍能从 API 读回 ⇒ 证明确实来自第二个落点,不是内存侥幸;'
    + '同时 logs.jsonl 的止损留痕不得因此回退',
    memLacksReason && D.statusView?.http === 200 && Array.isArray(D.stopLines) && D.stopLines.length >= 1,
    'memory 落点状态=' + JSON.stringify(D.memReason) + ' status=' + (D.statusView && D.statusView.http) + ' 止损日志行=' + (D.stopLines || []).length)
  check('#114a3 反向自证(不得把止损做成永远有答案):未被隔离的健康会议 status 必须 200 且不得凭空出现止损记录',
    H.statusView?.http === 200 && !/自动止损|auto_stop/.test(String(H.statusView.body)),
    'status=' + (H.statusView && H.statusView.http) + ' body含止损字样=' + /自动止损|auto_stop/.test(String(H.statusView && H.statusView.body)) + ' 派发货数=' + H.dispatches)
  check('#114a4 反向自证:真正不存在的会议 id 仍必须 404(加了 SQLite 回读后不得把所有 id 都答成 200)',
    D.ghostView?.http === 404, 'status=' + (D.ghostView && D.ghostView.http) + ' body=' + JSON.stringify(String(D.ghostView && D.ghostView.body).substring(0, 140)))
  check('#114a5 单 sink 纪律:不得为止损新增第三个 JSON 侧文件(DATA_DIR 里不应出现 stop/auto 形态的 json)',
    D.sideStop === '' && (Array.isArray(D.corruptFiles) ? D.corruptFiles : Number(D.corruptFiles || 0)) >= 1,
    '侧文件=' + JSON.stringify(D.sideStop) + ' DATA_DIR json=' + JSON.stringify(D.jsonFiles) + ' 保全件数=' + JSON.stringify(D.corruptFiles))
  const src114 = fs.readFileSync(SERVER114, 'utf-8').replace(/\r/g, '')
  const inlineInsert = (src114.match(/INSERT INTO events/g) || []).length
  check('#114a6 结构锁:事件写入必须走 db.recordEvent 单点(server.js 内 INSERT INTO events 必须 0 处,防第二套 SQL 手写)',
    inlineInsert === 0 && /db\.recordEvent/.test(src114),
    'server.js 内 INSERT INTO events=' + inlineInsert + ' 含 db.recordEvent=' + /db\.recordEvent/.test(src114))
}

section('#112) 行号锚点保真:源码/测试注释与说明书里的"点号锚点"必须指向真实非空行');
{
  // 取证(基线 237d04a,分母由判据自身重算,不沿用盘点脚本输出——#100 的教训):
  //   只认 `文件.ext:NNN` 形态的**点号锚点**。为什么不扫裸 `:NNN`:本轮实测三类假阳性
  //   —— db.js:279 的 `{input:200` 是 token 数、adapters/http-adapter.js:9 的 `localhost:8500` 是 URL 端口、
  //   bridge-stdio.js:378 的 `server.js:1342,:1347` 里后者是对 server.js 的**续指**(按本文件行数判就成了假越界)。
  //   基线实测(判据自己扫出来的数,非盘点脚本):源码+测试注释里点号锚点 84 处,失效 9 处
  //   —— 7 处指向空行、1 处越界(把 db.js 第 1132 行当锚点,而 db.js 全文仅 369 行)、1 处目标不存在(裸名 cli-adapter 的第 139 行,
  //   真路径带 adapters/ 前缀,即 #61a4 早就在文档里点名的那一例);README 37 处失效 1(server.js 第 1104 行是空行)、ARCHITECTURE 55 处失效 0。
  //   失效 9 处**全在测试文件注释里,源码注释 0 处** ⇒ 本格零源码改动、不派编码手、不重启中枢。
  //   订正后实测:失效 0(锚点总数随注释增删浮动,不钉死;green 时判据不打印,red 时明细带总数)。
  //   本段自己的取证注释也进了自扫范围:写这段时我举的两个反例(db.js 1132 / server.js 1104)以锚点形态落进注释,
  //   被 a1 当堂打回 2 处失效 ⇒ 改成"第 NNNN 行"的非锚点措辞。判据对作者同视,不豁免。
  //   #61a3/a4 只查"路径可达 + 不越界",从不看那一行是不是空行,也不覆盖任何源码/测试注释 ⇒ 本段把两样都补上。
  //   (本段自己也在自扫描范围内:写这段时我留下两处失效锚点当堂被抓,已就地改成合法锚点或去掉锚点形态。)
  const D112 = import.meta.dirname
  const ANCHOR_RE = /([A-Za-z0-9_.\-/]*\.(?:js|mjs|cjs|json|html)):(\d{1,5})(?!\d)/g
  const lcCache = {}
  const linesOf = (rel) => {
    if (!(rel in lcCache)) {
      const abs = path.join(D112, rel)
      lcCache[rel] = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8').replace(/\r/g, '').split('\n') : null
    }
    return lcCache[rel]
  }
  const scanTargets = fs.readdirSync(D112).filter((e) => /\.(js|mjs)$/.test(e))
  const deadSrc = []
  let nSrc = 0
  for (const f of scanTargets) {
    const L = linesOf(f) || []
    L.forEach((l, i) => {
      if (!/(\/\/|^\s*\*|\/\*)/.test(l)) return
      for (const m of l.matchAll(ANCHOR_RE)) {
        nSrc++
        const t = linesOf(m[1])
        if (!t) { deadSrc.push(f + ':' + (i + 1) + ' `' + m[0] + '` 目标文件不存在'); continue }
        const ln = Number(m[2])
        if (ln > t.length) deadSrc.push(f + ':' + (i + 1) + ' `' + m[0] + '` 越界(' + m[1] + ' 共 ' + t.length + ' 行)')
        else if (!String(t[ln - 1] || '').trim()) deadSrc.push(f + ':' + (i + 1) + ' `' + m[0] + '` 指向空行')
      }
    })
  }
  check('#112a1 源码与测试注释里的点号锚点必须可达、不越界且不指向空行(判据自扫 38 个 .js/.mjs,实测基线 84 处中 9 处失效,全在测试注释;源码注释 0 处)',
    deadSrc.length === 0, '扫描=' + scanTargets.length + ' 个文件 锚点=' + nSrc + ' 失效=' + deadSrc.length + ' :: ' + JSON.stringify(deadSrc).substring(0, 600))
  const docDead = []
  let nDoc = 0
  for (const doc of ['README.md', 'ARCHITECTURE.md']) {
    const L = linesOf(doc) || []
    L.forEach((l, i) => {
      for (const m of l.matchAll(ANCHOR_RE)) {
        nDoc++
        const t = linesOf(m[1])
        if (!t) { docDead.push(doc + ':' + (i + 1) + ' `' + m[0] + '` 目标不存在'); continue }
        const ln = Number(m[2])
        if (ln > t.length) docDead.push(doc + ':' + (i + 1) + ' `' + m[0] + '` 越界(' + t.length + ')')
        else if (!String(t[ln - 1] || '').trim()) docDead.push(doc + ':' + (i + 1) + ' `' + m[0] + '` 指向空行')
      }
    })
  }
  check('#112a2 说明书锚点在 #61a3/a4 的"可达不越界"之上再补"不得指向空行"(实测基线 README 37 处失效 1、ARCHITECTURE 55 处失效 0)',
    docDead.length === 0, '说明书锚点=' + nDoc + ' 失效=' + docDead.length + ' :: ' + JSON.stringify(docDead).substring(0, 300))
  // 反向自证(双向,防过宽也防空转):三类"看着像行号"的东西必须 0 命中,而真锚点样本必须原样抓到 2 个。
  const FP_SAMPLES = [
    'const budget = {input:200, output:0};',                    // token 数,不是行号
    'endpoint: "http://localhost:8500/generate",',             // URL 端口,不是行号
    '// 节奏归入待审批档(5 秒,与 :985 同);见 :467 的守卫'        // 裸 :NNN(本文件/续指),不纳入点号判据
  ]
  const fpHits = FP_SAMPLES.map((s) => [...s.matchAll(ANCHOR_RE)].map((m) => m[0]))
  const fpFlat = fpHits.flat()
  const TP = '// 中枢只校验 tool(server.js:1342),cause.js:20 另有上限常量'
  const tpHits = [...TP.matchAll(ANCHOR_RE)].map((m) => m[0])
  check('#112a3 指纹双向自证:点号判据须放过 token 数/URL 端口/裸 :NNN 三类假阳性,且必须抓到真锚点(过宽=永远红,过窄=永远绿)',
    fpFlat.length === 0 && tpHits.length === 2,
    '误伤=' + JSON.stringify(fpFlat) + ' 真锚点抓到=' + JSON.stringify(tpHits))

  // a4) README env 表**语义**锁:a1 只看"行存在且非空",看不见"行非空但说的是别的变量"这种漂移。
  //   判据:env 表里**整行只有 1 个点号锚点**的行,该锚点所在行必须点名该 env(或剥掉 AI_BRIDGE_ 前缀的尾名)。
  //   红基线(可复现:git show 162d873:ai-bridge/README.md 喂给本判据,源码取当前树)= 单锚点 env 行 14、红 11:
  //     CONFIG 块 6 行整体错位 1-2 行(如 AI_BRIDGE_CORS 指 `};` 而非 CORS_ORIGIN 那行)、桥侧视觉/反向 sampling
  //     4 处落在报表文本拼接行(如 AI_BRIDGE_VISION_PORT 指 lines.push('## 黑名单'))、PROXY_TIMEOUT 指空行。
  //   为什么不判多锚点行(实测 3 行)与无锚点行(实测 16 行):前者合法地引用旁证行(README 的 AI_BRIDGE_CLOUD_URL
  //   一行点了 edge-agent 的读取/抛错/https 校验三处,只有第一处点名 env),要求每个锚点都点名=打假红;
  //   后者文档根本没声称位置,无所谓漂移。这条边界由 a4c 的反向自证钉住,不靠注释自觉。
  const envRowOf = (l) => {
    const em = l.match(/^\|\s*`(AI_BRIDGE_[A-Z0-9_]+)`/)
    return em ? em[1] : null
  }
  const semBad = (env, line) => {
    const ms = [...line.matchAll(ANCHOR_RE)]
    if (ms.length !== 1) return false
    const t = linesOf(ms[0][1])
    const ln = Number(ms[0][2])
    if (!t || ln > t.length) return true // 结构失效同样算语义不合(a1 已判,这里不豁免)
    const target = String(t[ln - 1] || '')
    return !(target.includes(env) || target.includes(env.replace(/^AI_BRIDGE_/, '')))
  }
  const allBad = (env, line) => [...line.matchAll(ANCHOR_RE)].some((m) => {
    const t = linesOf(m[1])
    const ln = Number(m[2])
    if (!t || ln > t.length) return true
    const target = String(t[ln - 1] || '')
    return !(target.includes(env) || target.includes(env.replace(/^AI_BRIDGE_/, '')))
  })
  const envLines = linesOf('README.md') || []
  const semHits = []
  let nSingle = 0
  let nMulti = 0
  let nNone = 0
  envLines.forEach((l, i) => {
    const env = envRowOf(l)
    if (!env) return
    const k = [...l.matchAll(ANCHOR_RE)].length
    if (k === 0) { nNone++; return }
    if (k > 1) { nMulti++; return }
    nSingle++
    if (semBad(env, l)) semHits.push('README.md:' + (i + 1) + ' ' + env)
  })
  check('#112a4 README env 表单锚点行必须落在真点名该 env 的那一行(基线红 11/14,现须 0)',
    semHits.length === 0, '单锚点=' + nSingle + ' 多锚点=' + nMulti + ' 无锚点=' + nNone + ' 语义不合=' + semHits.length + ' :: ' + JSON.stringify(semHits).substring(0, 400))
  // a4b/a4c 双向自证:同一判据对"错位锚点"样本必须红、对真行必须绿;过宽版(要求行内每个锚点都点名)必须把
  // 多锚点样本判红而本判据必须放过 —— 否则说明本判据根本没在收窄,而是永远为真或永远为假。
  // 样本用具名 env + 显式第二锚点构造(不依赖某个真行的内容会不会变),真行只用来证明"豁免分支确实被走到"。
  const corsReal = envLines.find((l) => envRowOf(l) === 'AI_BRIDGE_CORS') || ''
  const corsMoved = corsReal.replace(/server\.js:\d+/, 'server.js:1') // server.js:1 = shebang,非空且不点名 CORS
  const wideSample = '| `AI_BRIDGE_CORS` | x | 值（`server.js:74`），另见鉴权门（`server.js:1`） |'
  check('#112a4b 判据有牙齿:CORS 真行判绿、其单锚点改指 shebang 判红;多锚点样本过宽版判红而本判据放过;豁免分支确被真数据走到',
    nSingle > 0 && nMulti > 0 && corsReal.includes('server.js:') && !semBad('AI_BRIDGE_CORS', corsReal) && semBad('AI_BRIDGE_CORS', corsMoved)
      && [...wideSample.matchAll(ANCHOR_RE)].length === 2 && allBad('AI_BRIDGE_CORS', wideSample) && !semBad('AI_BRIDGE_CORS', wideSample),
    '单锚点=' + nSingle + ' 多锚点=' + nMulti + ' CORS 真行判=' + semBad('AI_BRIDGE_CORS', corsReal)
      + ' 错位样本判=' + semBad('AI_BRIDGE_CORS', corsMoved) + ' 宽样本锚点数=' + [...wideSample.matchAll(ANCHOR_RE)].length
      + ' 过宽版判=' + allBad('AI_BRIDGE_CORS', wideSample) + ' 本判据判=' + semBad('AI_BRIDGE_CORS', wideSample))
}

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}

console.log('\n========================================');
console.log(`总计: ${passed}/${passed + failed} 通过`);
if (failed) { console.log('失败用例: ' + failures.join(', ')); process.exit(1); }
