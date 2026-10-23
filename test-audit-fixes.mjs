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
  const sm = srv.match(/EXECUTE_TIMEOUT:\s*parseInt\([^)]*\)\s*\|\|\s*(\d+)/);
  const S = sm ? Number(sm[1]) : NaN;
  check('F0 能解析中枢单次执行窗口(server.js CONFIG.EXECUTE_TIMEOUT 兜底值)', Number.isFinite(S) && S > 0, `S=${S}`);
  // 数值解析器:默认值可以写字面量,也可以写共享常量标识符(鼓励后者:GET/POST/总超时同源)
  const resolveDefault = (expr) => {
    if (/^\d+$/.test(expr)) return Number(expr);
    const m2 = br.match(new RegExp('(?:const|let|var)\\s+' + expr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*[^;]*?\\|\\|\\s*(\\d+)'));
    return m2 ? Number(m2[1]) : NaN;
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
  const ems = [...br.matchAll(/AI_BRIDGE_HTTP_TIMEOUT[^)\n]*\)?\s*\|\|\s*(\d+)/g)].map(m => Number(m[1]));
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

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}

console.log('\n========================================');
console.log(`总计: ${passed}/${passed + failed} 通过`);
if (failed) { console.log('失败用例: ' + failures.join(', ')); process.exit(1); }
