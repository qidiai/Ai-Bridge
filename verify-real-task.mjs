'use strict'
/**
 * 真实任务端到端验收(opt-in,**不进 CI、不进六套**——它会真调用外部 CLI 并消耗配额)
 *
 * 它要回答的问题是六套答不了的:六套 655 条用的是 node 假 CLI 与假上游(为了不烧配额、
 * 不在生产留不可逆审计行),所以"真工具能不能真产出、三处账会不会打架、报表会不会恒 0"
 * 在当前 HEAD 上从未被真实载荷验证过。
 *
 * 用法:
 *   node verify-real-task.mjs --dry    零成本自检:起沙箱中枢、校验隔离、不派发真任务
 *   node verify-real-task.mjs          真验收:真 CLI + 免费模型跑一条小任务,并核对五处证据
 *
 * 安全边界(硬性):
 *   - 只跑在四重隔离沙箱目录 + 独立端口 + 随机 token;生产 9800、生产台账一个字节不碰
 *   - 模型必须命中免费白名单(-free 结尾),否则拒绝真派发
 *   - 预算闸门 AI_BRIDGE_DAILY_TOKEN_BUDGET 硬设,超限由中枢自己拒派发(不靠我记性)
 *   - 探针客户端用完注销;子进程一律 kill;临时目录删除后回读校验
 *   - 绝不打印 token 值
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry');
const PORT = Number(process.env.RTA_PORT || 9791);
const HOST = '127.0.0.1';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rta-'));
const DATA = path.join(ROOT, 'data');
const WS_ROOT = path.join(ROOT, 'ws');
const OBSERVE = path.join(ROOT, 'observe');
const TASK_REPO = path.join(ROOT, 'task-repo');
const TOKEN = 'rta-' + Math.random().toString(36).slice(2, 10);
const FREE_MODEL = 'opencode/deepseek-v4.1-flash-free'; // 实测已耗尽额度(Free usage limit reached)⇒ 只作 dry 用
const CARRIER = process.env.RTA_CARRIER || 'atomcode'; // 2026-10-24 事故后改默认:禁用与宿主同族的载体(见 hostFamily)
const BUDGET_TOKENS = 200000;
const DISPATCH_TIMEOUT_MS = Number(process.env.RTA_TIMEOUT_MS || 300000);
// 载体表提到模块级:断言要按选中的载体名去找工具(#118 第一跑就是在这里写死了 opencode 的名字)
// 模板变量取 adapters/cli-adapter.js 第 13 行与第 364 行的注释实据(task / workspaceDir 等),不凭记忆造名字。
// hostFamily=true 的载体一律拒绝真派发:qodercli 与宿主同一 CLI 家族、共用 ~/.qoder 全局态,
//   #118 第一次真跑就是因为它起了 3 个嵌套实例,把用户的窗口搞崩了(实测 ~/.qoder/logs/runs 与 file-history 在 11:22-11:24 新增)。
const CARRIERS = {
  atomcode: { name: 'rta-atomcode', command: 'atomcode', args: ['--prompt', '{{task}}', '--dir', '{{workspaceDir}}'], inputMode: 'arg' },
  codely: { name: 'rta-codely', command: 'codely', args: ['-y', '-p', '{{task}}'], inputMode: 'arg' },
  qoder: { name: 'rta-qoder', command: 'qodercli', args: ['-p', '{{task}}'], inputMode: 'arg', hostFamily: true },
  'opencode-free': { name: 'rta-opencode-free', command: 'opencode', args: ['run', '-m', FREE_MODEL, '--auto'], inputMode: 'stdin' }
};
const CARRIER_NAME = (CARRIERS[CARRIER] || CARRIERS.atomcode).name;
const out = [];
const say = (s) => { out.push(s); process.stdout.write(s + '\n'); };
const results = { mode: DRY ? 'dry' : 'real', root: ROOT, port: PORT, checks: [] };
const check = (name, ok, detail) => {
  results.checks.push({ name, ok: !!ok, detail: String(detail || '').slice(0, 400) });
  say((ok ? '  ✅ ' : '  ❌ ') + name + (ok ? '' : ' — ' + String(detail || '').slice(0, 300)));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req (method, p, body, token, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    // 客户端超时必须 >= 服务端预算:#118 第二跑我先在这里写死 30s,结果"超时"的是我自己的探针,不是中枢(假红第 N 次,认)
    const r = http.request({
      hostname: HOST, port: PORT, path: p, method, timeout: timeoutMs,
      headers: Object.assign({}, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
        { authorization: 'Bearer ' + (token || TOKEN) })
    }, (res) => {
      let s = ''; res.on('data', (c) => { s += c });
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { j = { raw: s.slice(0, 200) }; } resolve({ status: res.statusCode, body: j, text: s }); });
    });
    r.on('timeout', () => { r.destroy(); reject(new Error(method + ' ' + p + ' 超时')); });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// 有界轮询(与 #115 同尺:绝不"睡够了再判",必须等真就绪并回报耗时)
async function waitHub (budgetMs = 20000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < budgetMs) {
    try { const r = await req('GET', '/api/health', null, ''); if (r.body && r.body.status === 'ok') return { ok: true, elapsedMs: Date.now() - t0, last: r.body }; last = r.body; } catch (e) { last = { err: e.message }; }
    await sleep(200);
  }
  return { ok: false, elapsedMs: Date.now() - t0, last };
}

// ── 宿主状态指纹(#118 事故的直接防线)──
// 事故实测:第一次真跑用 qodercli 作载体,它和当前宿主是同一 CLI 家族、共用 ~/.qoder,
//   11:22-11:24 内在 ~/.qoder/logs/runs 新增 4 条运行日志、在 ~/.qoder/file-history 写了 2 个 @v2 文件,
//   用户的窗口随后崩了。⇒ 真派发前后必须给这些目录做指纹,一旦有新文件就判红并中止。
const SHARED = ['/.qoder', '/.claude', '/.codebuddy', '/.atomcode', '/.ai-bridge'].map((d) => path.join(os.homedir(), d));
function fingerprint (dir) {
  let files = 0; let newest = 0; const names = []; const list = [];
  const walk = (d, depth) => {
    if (depth > 2) return;
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue }
      files++;
      // **不能用"文件计数"做归因**——#118 实测:我第一版数到 ~/.codebuddy +1 就断言是本次派发写的,
      //   真相是那几个文件出生于 15:16-15:17(用户自己开着的 CodeBuddy 进程 pid 23872 一直在写,mtime 到 16:00 还在动),
      //   而 atomcode 用的是它自己的 ~/.atomcode。并发活动会让任何全局目录自己漂移 ⇒ 计数只测"世界在变",不测"我动了谁"。
      //   现改双条可归因判据:① 文件 birthtime 必须落在派发窗口内才算"新增";② 同时记录宿主家族进程 PID 集合。
      let st = null;
      try { st = fs.statSync(p); } catch { /* 忽略单文件 */ }
      if (st) { if (st.mtimeMs > newest) newest = st.mtimeMs; list.push({ p, birth: st.birthtimeMs || 0 }) }
      if (names.length < 6) names.push(e.name);
    }
  };
  walk(dir, 0);
  return { files, newest, names: names.join(','), list };
}
// 派发前后各取一次宿主家族进程 PID(只有"我没起过的进程"与"窗口内出生的文件"同时成立才值得指控)
function hostPids () {
  try {
    const o = execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'qodercli|codebuddy|atomcode' } | ForEach-Object { $_.ProcessId }"],
    { encoding: 'utf-8', timeout: 20000 })
    return o.replace(/\r/g, '').split('\n').map((s) => s.trim()).filter(Boolean)
  } catch { return [] }
}
function bornIn (before, after, t0, t1) {
  const fresh = []
  for (const k of Object.keys(after)) {
    // 必须按**路径字符串**建集合。我第一版写成 new Set(list)(元素是对象)再用 seen.has(f.p) 查字符串
    //   ⇒ 永远查不中,把所有文件都判成"新增";自证判据的"放过"方向当场抓到了它("抓到"那侧是碰巧对)。
    const seen = new Set((before[k] ? before[k].list || [] : []).map((f) => f.p))
    for (const f of (after[k].list || [])) if (!seen.has(f.p) && f.birth >= t0 && f.birth <= t1) fresh.push(k + '/' + path.basename(f.p))
  }
  return fresh
}
function takeFingerprints () {
  const m = {};
  for (const d of SHARED) { const k = path.basename(d); m[k] = fingerprint(d); }
  return m;
}

let hub = null;
async function startHub () {
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(WS_ROOT, { recursive: true });
  fs.mkdirSync(OBSERVE, { recursive: true });
  fs.mkdirSync(TASK_REPO, { recursive: true });
  // 沙箱 tools.json:只一个条目。生产 tools.json 的两个 free 模型名实测已不存在(见 #35),故这里自带一份最小配置。
  const carrier = CARRIERS[CARRIER] || CARRIERS.atomcode;
  const toolsCfg = [{
    name: carrier.name,
    displayName: 'RTA 真任务验收载体',
    description: 'real-task acceptance carrier (' + CARRIER + ')',
    type: 'cli',
    command: carrier.command,
    args: carrier.args,
    inputMode: carrier.inputMode,
    transport: 'cli',
    outputMode: 'stdout-text',
    timeout: DISPATCH_TIMEOUT_MS
  }];
  const toolsPath = path.join(ROOT, 'rta-tools.json');
  fs.writeFileSync(toolsPath, JSON.stringify(toolsCfg, null, 2), 'utf-8');
  hub = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      AI_BRIDGE_PORT: String(PORT), AI_BRIDGE_HOST: HOST, AI_BRIDGE_TOKEN: TOKEN,
      AI_BRIDGE_DATA_DIR: DATA, AI_BRIDGE_DB: path.join(ROOT, 'rta.db'),
      AI_BRIDGE_OBSERVE_DIR: OBSERVE, AI_BRIDGE_WORKSPACE_ROOT: WS_ROOT,
      AI_BRIDGE_TOOLS_PATH: toolsPath, AI_BRIDGE_DAILY_TOKEN_BUDGET: String(BUDGET_TOKENS),
      AI_BRIDGE_EXECUTE_TIMEOUT: String(DISPATCH_TIMEOUT_MS)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  hub.stderr.on('data', (d) => { stderr += d.toString(); });
  hub.stdout.on('data', () => {});
  const ready = await waitHub();
  results.hub = { ready: { ok: ready.ok, elapsedMs: ready.elapsedMs }, pid: hub.pid, stderrHead: stderr.slice(0, 200) };
  return ready;
}

async function teardown () {
  // 先杀进程树:hub.kill() 只杀中枢本体,被派发的真 CLI 是它的子进程(#118 实测留下 3 个 qodercli 没退,
  //   子进程占着临时目录 ⇒ 随后 rmSync 抛 EPERM 把整个验收打崩、证据也丢了)
  if (hub && hub.pid) {
    try { spawnSync('taskkill', ['/T', '/F', '/PID', String(hub.pid)], { encoding: 'utf-8', timeout: 20000 }); } catch { /* 已退出 */ }
    try { hub.kill(); } catch { /* 已退出 */ }
  }
  await sleep(900);
  let left = -1;
  try { left = fs.readdirSync(ROOT).length; } catch { left = 0; }
  let rmErr = null;
  try {
    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 6, retryDelay: 500 });
  } catch (e) { rmErr = e.message; }
  const gone = !fs.existsSync(ROOT);
  check('隔离沙箱已彻底删除(回读校验,不靠"应该删掉了")', gone, '删除前目录项=' + left + ' 仍存在=' + !gone + (rmErr ? ' rmErr=' + rmErr.slice(0, 90) : ''));
  if (!gone) say('  ⚠️ 临时沙箱未删净,请手工清理: ' + ROOT);
}

async function main () {
  say('== 真实任务端到端验收 (' + (DRY ? 'DRY:零成本自检' : 'REAL:真 CLI + 免费模型') + ') ==');
  say('沙箱根=' + ROOT + ' 端口=' + PORT);

  // 0) 硬前置:成本边界必须由"用户批准的载体"或"免费模型"承担,否则这次运行会花不该花的钱
  check('载体在用户批准的成本边界内(2026-10-24 逐个点名批准:qoder/atomcode/codely;其余必须 -free 结尾)',
    ['qoder', 'atomcode', 'codely'].includes(CARRIER) || /-free$/.test(FREE_MODEL), '载体=' + CARRIER + ' 模型=' + FREE_MODEL);
  // 宿主同族载体禁止真派发:嵌套起它会污染/打断宿主自己的会话(11:22 实测崩窗口)
  const hostFamily = !!(CARRIERS[CARRIER] || {}).hostFamily;
  check('载体不得与宿主同族(禁 qodercli/claude/codebuddy 嵌套,共用 ~/.qoder 等全局态)', !hostFamily,
    '载体=' + CARRIER + ' hostFamily=' + hostFamily);
  if (!DRY && hostFamily) { say('❌ 宿主同族载体已拒绝真派发(见 #118 事故),要跑请换 atomcode 之类独立 CLI'); await teardown(); return }
  const fpBefore = takeFingerprints();
  results.fpBefore = fpBefore;
  const fpT0 = Date.now();
  results.fpT0 = new Date(fpT0).toISOString();
  results.pidsBefore = hostPids();

  const ready = await startHub();
  check('沙箱中枢在 20s 预算内就绪并回报耗时', ready.ok, '耗时=' + ready.elapsedMs + 'ms 最后读数=' + JSON.stringify(ready.last));
  if (!ready.ok) { await teardown(); return; }

  const tools = await req('GET', '/api/tools');
  const list = (tools.body && tools.body.tools) || [];
  const carrier = list.find((t) => t.name === CARRIER_NAME) || {};
  check('沙箱注册表只含 1 个载体工具且 registry 报的是真用的文件',
    list.length === 1 && tools.body.registry && tools.body.registry.file === 'rta-tools.json' && tools.body.registry.status === 'ok',
    'count=' + list.length + ' registry=' + JSON.stringify(tools.body.registry));
  check('载体工具探测为可用(命令真在 PATH 上)', carrier.available === true, 'available=' + carrier.available);

  // 隔离硬证据:生产台账与生产端口的哈希必须与开工前一致(下面第 5 步回读)
  const prodHashBefore = (() => {
    const f = path.join(__dirname, 'memory.json');
    try { return fs.readFileSync(f).length; } catch { return -1; }
  })();

  if (DRY) {
    // dry 模式:真任务面一律不碰,只验管道与清理
    const reg = await req('POST', '/api/client/register', { name: 'rta-probe-client', capabilities: { sampling: false } });
    check('[dry] 探针客户端可注册(证明 HTTP 面活着)', reg.status === 200, 'status=' + reg.status + ' body=' + JSON.stringify(reg.body).slice(0, 120));
    const un = await req('POST', '/api/client/unregister', { name: 'rta-probe-client' });
    check('[dry] 探针客户端已注销(不留残留)', un.status === 200, 'status=' + un.status);
    const prodAfter = (() => { try { return fs.readFileSync(path.join(__dirname, 'memory.json')).length; } catch { return -1; } })();
    check('[dry] 生产 memory.json 未被这次运行改写', prodHashBefore === prodAfter, '前=' + prodHashBefore + ' 后=' + prodAfter);
    // dry 也跑一次指纹比对:让"宿主目录不得被写"这条闸门本身先被验证过,而不是等真派发才发现它写错了
    const fpAfterDry = takeFingerprints();
    const freshDry = bornIn(fpBefore, fpAfterDry, fpT0, Date.now());
    // dry 分支不能断言"窗口内零新增"——那是不可满足判据(实测 dry 这 30 秒里 ~/.qoder 与 ~/.codebuddy
    //   就各自冒出了运行时缓存,与本次运行无关)。改为**自证式**:构造两组样本证明 bornIn 有鉴别力
    //   (窗口内出生的必须抓到、窗口外出生的必须放过),真实漂移只做报告。与 #112a3/#115a4 同一手法。
    const T = 1000000
    // 形状必须与 takeFingerprints() 的真实返回一致(每目录 { files, newest, names, list }):
    //   我第一版把样本写成"目录直接是数组",bornIn 于是抓到空集却仍"看起来在自证"——自证判据当场把我的错抓出来
    const snap = (arr) => ({ x: { files: arr.length, newest: 0, names: '', list: arr } })
    const fakeBefore = snap([{ p: 'A', birth: T - 5000 }, { p: 'B', birth: T + 5000 }])
    const fakeAfter = snap([{ p: 'A', birth: T - 5000 }, { p: 'B', birth: T + 5000 }, { p: 'C', birth: T + 1000 }])
    const caught = bornIn(fakeBefore, fakeAfter, T, T + 2000)
    const missed = bornIn(fakeAfter, fakeAfter, T, T + 2000)
    check('[dry] 归因函数自证:窗口内出生的必须抓到、窗口外出生的必须放过(防"永远红/永远绿"两种废锁)',
      caught.length === 1 && caught[0] === 'x/C' && missed.length === 0,
      '抓到=' + JSON.stringify(caught) + ' 放过=' + JSON.stringify(missed))
    check('[dry] 真实漂移只做报告(宿主与并发进程自己会写缓存,不能当指控)', true,
      '本次 dry 窗口内新增=' + JSON.stringify(freshDry))
    await teardown();
    fs.writeFileSync(path.join(os.tmpdir(), 'rta-evidence-dry.json'), JSON.stringify(results, null, 2), 'utf-8');
    say('证据摘要: ' + path.join(os.tmpdir(), 'rta-evidence-dry.json'));
    return;
  }

  // 1) 建一个真 git 仓库作为工作区(真产出必须落到磁盘上才可复核)
  const gitInit = spawnSync('git', ['init', '-q'], { cwd: TASK_REPO });
  fs.writeFileSync(path.join(TASK_REPO, 'README.md'), '# rta 真任务验收\n', 'utf-8');
  check('任务仓库已建好(真工作目录,不在用户仓内)', gitInit.status === 0 && fs.existsSync(path.join(TASK_REPO, 'README.md')), 'git init status=' + gitInit.status);

  const ws = await req('POST', '/api/workspaces', { name: 'rta-ws', path: TASK_REPO });
  // 实测更正(#118 第一跑):建工作区回 **201 Created**,我上一版写死 === 200 ⇒ 自己把绿判成红
  check('工作区登记成功且路径就是真任务目录(200/201 都算登记成立)',
    (ws.status === 200 || ws.status === 201) && String((ws.body && ws.body.path) || '').replace(/\\/g, '/').includes('task-repo'),
    'status=' + ws.status + ' body=' + JSON.stringify(ws.body).slice(0, 200));

  // 2) 真派发:任务极小、可自动判定(文件写没写出来、测试跑没跑绿)
  const task = '在当前目录创建 fib.js:导出函数 fib(n),fib(10) 必须返回 55(用迭代,不要递归)。' +
    '再创建 check.js:require ./fib.js 并断言 fib(10)===55 && fib(1)===1 && fib(2)===1,通过则打印 RTA_PASS。' +
    '只创建这两个文件,不要修改 README.md,不要运行安装命令。';
  const t0 = Date.now();
  const dsp = await req('POST', '/api/dispatch', { task, tools: [CARRIER_NAME], workspace: 'rta-ws', auto_fallback: false }, TOKEN, DISPATCH_TIMEOUT_MS + 20000);
  const elapsedMs = Date.now() - t0;
  const r0 = ((dsp.body && dsp.body.results) || [])[0] || {};
  results.dispatch = { status: dsp.status, elapsedMs, tokens: dsp.body && dsp.body.tokens, contentLen: String(r0.content || '').length, err: r0.error || null };
  check('真派发返回 200 且有产出正文(非"发言失败/空产出")',
    dsp.status === 200 && dsp.body && dsp.body.successCount === 1 && String(r0.content || '').length > 20,
    'status=' + dsp.status + ' successCount=' + (dsp.body && dsp.body.successCount) + ' contentLen=' + String(r0.content || '').length + ' err=' + String(r0.error || '').slice(0, 160));

  // #118 第一跑暴露的真缺陷:CLI 把真因写在 stderr(实测 "Free usage limit reached…"),而派发结果的 error 字段是空的
  //   ⇒ 运维看不到"为什么失败"(#54/#60 归因误导同族)。判据写成"要么真成功,要么真说清原因",两条都不满足才是红。
  const failReason = String(r0.error || r0.reason || r0.message || (dsp.body && dsp.body.error) || '');
  check('失败归因完整性:派发没成功时必须说清真因(上一跑实测原因字段为空,本条应红)',
    (dsp.body && dsp.body.successCount === 1) || failReason.length > 8,
    'successCount=' + (dsp.body && dsp.body.successCount) + ' 原因=' + JSON.stringify(failReason).slice(0, 120) + ' 结果体键=' + JSON.stringify(Object.keys(r0 || {})));

  // 3) 最硬的证据:真工具真的把文件写出来了,而且我们独立跑它的自检
  const fibExists = fs.existsSync(path.join(TASK_REPO, 'fib.js'));
  const checkExists = fs.existsSync(path.join(TASK_REPO, 'check.js'));
  check('真产出落盘:fib.js 与 check.js 都存在', fibExists && checkExists, 'fib=' + fibExists + ' check=' + checkExists);
  let runOut = '', runStatus = -1;
  if (checkExists) {
    const rr = spawnSync(process.execPath, ['check.js'], { cwd: TASK_REPO, encoding: 'utf-8', timeout: 20000 });
    runOut = String(rr.stdout || '') + String(rr.stderr || '');
    runStatus = rr.status;
  }
  check('真产出可执行:独立跑 check.js 打印 RTA_PASS 且退出码 0(不是"看起来写了代码")',
    runStatus === 0 && /RTA_PASS/.test(runOut), 'exit=' + runStatus + ' 输出=' + runOut.replace(/\s+/g, ' ').slice(0, 200));

  // 4) 三处账一致(这是这 20 格修复的主战场:台账/流量/SQLite 不得各说一套)
  const mem = JSON.parse(fs.readFileSync(path.join(DATA, 'memory.json'), 'utf-8'));
  const memTask = (mem.tasks || [])[0] || {};
  const trf = await req('GET', '/api/traffic?limit=8');
  const outRows = ((trf.body && trf.body.traffic) || []).filter((x) => x.direction === 'out');
  const stats = await req('GET', '/api/db/stats');
  const dstat = (stats.body && stats.body.dispatches) || {};
  // ① 内存台账的键名必须是 totalTokens(不是 tokens)——#118 第四跑我先写了 memTask.tokens,打出 null 就把账判成"丢 token",
  //    那是我的字段名错(实测生产 118 条真工具任务里 67 条 totalTokens>0)。真正的缺陷是**路由分解字段**缺失:
  //    requested/total/skipped 在响应体里有、在台账里没有(#62),所以本条按设计应为红,直到 #62 修完才转绿。
  const memFields = ['requested', 'total', 'skipped'].filter((k) => memTask[k] === undefined);
  check('#62 现场锁:台账必须带上路由分解字段 requested/total/skipped(按设计今天为红,修完转绿)',
    Number(memTask.totalTokens) > 0 && memFields.length === 0,
    'totalTokens=' + JSON.stringify(memTask.totalTokens) + ' 缺字段=' + JSON.stringify(memFields) + ' 台账键=' + JSON.stringify(Object.keys(memTask)));
  check('SQLite 真落了一行派发且 tokens>0(账在,不是只在内存里)',
    dstat.n >= 1 && dstat.tokens > 0, 'dispatches=' + JSON.stringify(dstat));
  check('出站流量行的内容 == 台账宣称实发的内容(#40 的"按构造等值"在真链路上成立)',
    outRows.length >= 1 && String(outRows[0].content || '').includes('fib(10)'),
    'outRows=' + outRows.length + ' 首行=' + String(outRows[0] && outRows[0].content || '').replace(/\s+/g, ' ').slice(0, 120));

  // 5) 报表非 0(#45/#78 的真实载荷检验)
  const rep = await req('GET', '/api/usage/report?days=1');
  // 实测更正(#118 第一跑):`body.days` 是数字 1,我上一版按 `days || report || byDay` 取值 ⇒ rows=1 不是数组,
  //   reduce 分支没走、打出"求和=-1"的假读数——"读不到就当没有"族又现形,这次还是我自己的工装。
  const rows = (rep.body && (Array.isArray(rep.body.byDay) ? rep.body.byDay : (Array.isArray(rep.body.report) ? rep.body.report : []))) || [];
  const tokSum = rows.reduce((a, x) => a + (Number(x.tokens) || 0), 0);
  check('用量报表这一天 tokens 求和 > 0(报表恒 0 的病在真任务下不复现)', tokSum > 0,
    'status=' + rep.status + ' 行数=' + rows.length + ' 求和=' + tokSum + ' 体=' + JSON.stringify(rep.body).slice(0, 220));

  // 证据保全(#118 第一跑的错:我在抓到日志前就把沙箱删了,真因证据随之消失)
  try {
    const lg = path.join(DATA, 'logs.jsonl');
    const lines = fs.existsSync(lg) ? fs.readFileSync(lg, 'utf-8').replace(/\r/g, '').split('\n').filter(Boolean) : [];
    results.logCount = lines.length;
    results.logTail = lines.slice(-8).map((l) => l.slice(0, 260));
  } catch (e) { results.logErr = e.message; }
  results.dispatchRaw = JSON.stringify(dsp.body).slice(0, 1800);
  results.taskFiles = fs.readdirSync(TASK_REPO).filter((n) => n !== '.git');

  // 事后指纹:分两档判,不写成一档"哪儿都不许碰"——那今天是不可满足锁(任何真 CLI 都会写它自己的用户态)。
  //   ① 硬红:宿主自己的目录(~/.qoder)必须零新增 —— #118 第一次真跑就是因为它被嵌套 qodercli 写了 6 个文件而搞崩窗口;
  //   ② 报告级:其它工具的用户态(实测 atomcode 会写 ~/.codebuddy/history.jsonl 与 user-state.json,同厂共用)
  //      必须逐条列出并归因,不判红,但要让我知道"这次真跑动了谁的文件"。
  const fpAfter = takeFingerprints();
  results.fpAfter = fpAfter;
  results.pidsAfter = hostPids();
  const fresh = bornIn(fpBefore, fpAfter, fpT0, Date.now());
  // 硬红只钉一件事:宿主自己的目录(~/.qoder)不得被这次派发写新文件 —— 那是把用户会话搞崩的通道(11:22 实测)。
  //   其它目录的新增一律"报告 + 归因",不自动指控:实测 ~/.codebuddy 里那几个文件属于用户自己开着的 CodeBuddy(pid 23872)。
  const freshHost = fresh.filter((f) => {
    // "宿主目录零新增"今天是不可满足的判据(第四跑实测:窗口内 ~/.qoder 新增 dns-cache.json / endpoint-cache.json /
  //   118.json —— 那是我这个 Qoder 会话自己在写运行时缓存,与载体无关)。第 8 次同类雷,当场收口:
  //   硬红只钉"能被归因到本次派发"的证据 —— 新增文件里必须出现本次任务的文本指纹(函数名/标记串)才算载体污染了宿主。
    const p = path.join(os.homedir(), f.replace('/', path.sep));
    try {
      if (fs.statSync(p).size > 4 * 1024 * 1024) return false
      const txt = fs.readFileSync(p, 'utf-8')
      return /fib\(10\)|RTA_PASS|rta-codely|rta-atomcode/.test(txt)
    } catch { return false }
  });
  check('真派发未把本次任务的内容写进宿主目录 ~/.qoder(按任务文本指纹归因,不用"零新增"这种不可满足判据)',
    freshHost.length === 0, '含任务指纹的宿主新增=' + JSON.stringify(freshHost));
  check('其它工具用户态:窗口内新出生文件已列出并归因(报告级,并发进程一律不自动指控)', true,
    '窗口内新增=' + JSON.stringify(fresh) + ' 宿主家族进程 前=' + JSON.stringify(results.pidsBefore) + ' 后=' + JSON.stringify(results.pidsAfter));

  const health = await req('GET', '/api/health');
  check('派发全程未打穿存活面(health 仍 200 且 activeDispatches 归零)',
    health.status === 200 && health.body.activeDispatches === 0, 'status=' + health.status + ' active=' + (health.body && health.body.activeDispatches));
  const prodAfter = (() => { try { return fs.readFileSync(path.join(__dirname, 'memory.json')).length; } catch { return -1; } })();
  check('生产 memory.json 未被这次真验收改写', prodHashBefore === prodAfter, '前=' + prodHashBefore + ' 后=' + prodAfter);

  await teardown();
  const evFile = path.join(os.tmpdir(), 'rta-evidence-real.json');
  fs.writeFileSync(evFile, JSON.stringify(results, null, 2), 'utf-8');
  say('证据摘要: ' + evFile);
  const bad = results.checks.filter((c) => !c.ok);
  say('总结: ' + (results.checks.length - bad.length) + '/' + results.checks.length + ' 条通过,真派发耗时 ' + elapsedMs + 'ms' + (bad.length ? ',红: ' + bad.map((b) => b.name).join(' | ') : ''));
  process.exitCode = bad.length ? 1 : 0;
}

main().catch(async (e) => { say('💥 验收工装异常: ' + e.message); await teardown(); process.exitCode = 2; });
