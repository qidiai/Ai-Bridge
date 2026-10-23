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
//   该 err.message 会经 server.js:514 `reason: error.message` 与 :600 `error: execError.message`
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
//   ① 反代入站 server.js:296 存**上游原样** {prompt_tokens, completion_tokens}
//   ② 派发回写 server.js:630 存**归一化后** {input, output, total, reported|estimated}
//   ③ events 表用**列** input_tokens/output_tokens(db.js:1132 一带)
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

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}

console.log('\n========================================');
console.log(`总计: ${passed}/${passed + failed} 通过`);
if (failed) { console.log('失败用例: ' + failures.join(', ')); process.exit(1); }
