/**
 * ai-bridge/store.js — 持久化存储(JSON 文件,带锁)
 *
 * 三类数据:
 *   switches.json    — 工具开关
 *   token-stats.json — Token 统计
 *   memory.json      — 项目记忆(任务历史/经验/工具偏好)
 *   logs.jsonl       — 运行日志(每行一条 JSON,按时间追加)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 生产默认仍落在 ai-bridge 目录；测试可通过环境变量使用独立运行目录，
// 避免隔离端口的 E2E 在执行期间改写生产服务正在读取的 JSON 文件。
const DATA_DIR = process.env.AI_BRIDGE_DATA_DIR
  ? path.resolve(process.env.AI_BRIDGE_DATA_DIR)
  : __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const FILES = {
  switches: path.join(DATA_DIR, 'switches.json'),
  stats: path.join(DATA_DIR, 'token-stats.json'),
  memory: path.join(DATA_DIR, 'memory.json'),
  logs: path.join(DATA_DIR, 'logs.jsonl'),
  acl: path.join(DATA_DIR, 'clients-acl.json'),
  workspaces: path.join(DATA_DIR, 'workspaces.json')
};

// 本轮进程内已确认损坏的 key 集合。为什么要它:load 读不回合法 JSON 时调用方拿到的是
// 空结构,若随后仍然落盘就会把空结构写成"新真相"——一次手改坏/半写入即静默清库
// (ACL blocklist 被洗空 = 准入失效;switches 被洗空 = 已关工具全部回启)。
const _corrupt = new Set();

// #74:隔离真因的可查状态。真因(load 的 e.message / shapeReason 的结果)此前只进 appendLog,
// 下游查不到,于是三处对外文案各自硬编猜测类别,形状非法场景也被统写成解析类 → 归因方向被
// 带偏(#54/#74 同族)。这里把 key→真因 存成进程内状态,由 quarantineReason() 统一暴露。
const _corruptReason = new Map();

// #97/#104:有界原因摘要的唯一实现在 ./cause(零依赖纯函数,store 与 tool-registry 共用此把尺)
const { causeOf } = require('./cause');

// 保全坏文件并置脏标志:原字节改名留档,后续该 key 的写一律被闸门拒绝。
// 绝不抛错(load 是在业务路径上被调的,抛错会让会议中途夭折并堵死并发闸门)。
function quarantine (key, reason) {
  if (_corrupt.has(key)) return;
  _corrupt.add(key); // 先置脏:即使下面改名失败,这道闸门也必须生效
  _corruptReason.set(key, reason); // 只记首次:第一个真因才是真因,后续不得覆盖
  // #97:reason 必须由调用方以唯一尺组合为 <类别>: <causeOf(...)>(已压平且有界);
  // 此处不得再截断——重新过秤会把类别前缀截没(归因事故),保守策略保持原样。
  let bakInfo = '保全改名失败,原坏文件仍在但绝不覆写';
  if (fs.existsSync(FILES[key])) {
    const bak = FILES[key] + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-');
    try {
      fs.renameSync(FILES[key], bak);
      bakInfo = `已保全为 ${path.basename(bak)}`;
    } catch (_) { /* 权限/占用:保持无备份名,脏标志不回退 */ }
  }
  // #103:损坏帧改由唯一写手 storageNotice 产出(过去这里是半角括号 + 尾部多余的「,本进程内
  // 拒绝覆写」,与 :165 的拒写帧不同形)。原因取自 quarantineReason(key)——上面已 set,顺序不动。
  appendLog('error', storageNotice(key, '损坏', bakInfo));
}

// 每 key 的字段形状契约(#44)。只对"文件里实际存在的字段"检查类型,缺失属合法稀疏,
// 由 loadMemory/loadACL 的补字段逻辑处理;switches/stats 只锁顶层,值类型语义留给 #45/#46。
// 为什么不在这里对数组元素设卡:历史数据里的 results/fallbackLog 内部字段演化过多次,
// 硬加"每元素必须含 X/Y"会误拒在用文件,把可用状态打成隔离状态。
const SHAPES = {
  memory: { tasks: 'array', experiences: 'array', meetings: 'array', preferences: 'object' },
  acl: { allowlist: 'array', blocklist: 'array', pending: 'array' },
  workspaces: { workspaces: 'array' },
  switches: {},
  stats: {}
};

// 判定 data 是否符合 key 的形状契约:顶层必须是 plain object,声明字段存在时必须类型正确。
// 返回 true=合法;false=非法(调用方须按"解析失败同口径"处理:quarantine + 返回空结构)。
// 为什么单独抽出来:#44 的三种真实恶果(字段类型错/容器类型错/顶层类型错)都是"能解析但形状错"
// ——loadMemory/loadACL 的补字段逻辑对 primitive/null 要么抛 TypeError 要么静默丢弃,
// 两者都会让守卫绕过,把在用的真实数据洗掉。守卫只需覆盖 load 这一个入口
// (另一入口已随 #31 的零调用方清理一并删除,不再有绕过 load 的第二个读入口),
// 不在调用方散落补丁(避免 #52 那种"只给 meetings 一个点"的补丁式回归)。
function assertShape (key, data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  const fields = SHAPES[key];
  if (!fields) return true; // FILES 里有、SHAPES 未声明形状的 key(当前仅 logs)及未知 key 只把顶层,不引入本单未规定的约束
  for (const name of Object.keys(fields)) {
    if (!(name in data)) continue; // 缺失:合法稀疏,由补字段逻辑负责
    const v = data[name];
    const kind = fields[name];
    if (kind === 'array') {
      if (!Array.isArray(v)) return false;
    } else if (kind === 'object') {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
    }
  }
  return true;
}

function shapeReason (key, data) {
  if (typeof data !== 'object' || data === null) return '顶层非对象(null/primitive/函数)';
  if (Array.isArray(data)) return '顶层为数组(须 plain object)';
  const fields = SHAPES[key] || {};
  for (const name of Object.keys(fields)) {
    if (!(name in data)) continue;
    const v = data[name];
    const kind = fields[name];
    if (kind === 'array' && !Array.isArray(v)) return `${name} 字段形状非法(须为数组)`;
    if (kind === 'object' && (typeof v !== 'object' || v === null || Array.isArray(v))) return `${name} 字段形状非法(须为 plain object)`;
  }
  return '形状非法';
}

function load (key) {
  const f = FILES[key];
  if (!f || !fs.existsSync(f)) return {}; // 文件不存在:合法的空,不是损坏,不隔离
  // #97:"读"与"解析"是两类故障,不得塞进同一个 try 靠 e.message 的引擎措辞猜类别
  // (V8/libuv 句式不是类别标签)。原因统一组合为 <类别>: <causeOf(错误)>,
  // 保守策略不变:仍隔离、仍返回空结构、绝不抛错。
  let raw;
  try {
    raw = fs.readFileSync(f, 'utf-8');
  } catch (e) {
    // 读阶段失败(EISDIR/EPERM/EBUSY 之类):连字节都没拿到,与"拿到了但不是合法 JSON"不同类
    quarantine(key, `读取失败: ${causeOf(e)}`);
    return {}; // 仍返回空结构保住可用性,绝不抛错
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // 解析阶段失败(JSON.parse 依规范只抛 SyntaxError):字节读到了但不是合法 JSON
    quarantine(key, `解析失败: ${causeOf(e)}`);
    return {}; // 仍返回空结构保住可用性,绝不抛错
  }
  // #44:能解析但形状非法(字段类型/容器/顶层三种错)与解析失败同口径,
  // 保守保全+拒写,绝不抛错(调用方在业务路径与启动序列上,抛错会把保守策略升级成故障)。
  if (!assertShape(key, parsed)) {
    // 形状非法有自己的类别,且 shapeReason() 的字段名细节保留在冒号之后(二者都要)
    quarantine(key, `形状非法: ${causeOf(shapeReason(key, parsed))}`);
    return {};
  }
  return parsed;
}

const _syncLocks = new Map();

function saveSync (key, data) {
  if (_corrupt.has(key)) {
    // 不抛错,只回传 false:损坏期间的任何"补救性写入"都是二次破坏
    // #74:日志说清真因,不硬编类别猜测(形状非法被写成"解析损坏"会带偏归因方向)
    // #103:拒写帧改由唯一写手 storageNotice 产出,与损坏帧同形(原因同样取 quarantineReason(key))
    appendLog('error', storageNotice(key, '拒写'));
    return false;
  }
  // 自旋等待锁(同步版,最多等 2 秒)
  let waited = 0;
  while (_syncLocks.get(key) && waited < 2000) {
    const start = Date.now();
    // 同步等待:用 Atomics.wait 或简单 spin
    const buf = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buf, 0, 0, 10);
    waited += 10;
  }
  _syncLocks.set(key, true);
  try {
    const f = FILES[key];
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, f);
  } finally {
    _syncLocks.set(key, false);
  }
  return true;
}

// #73 隔离态的只读访问器:让调用方能查"这个 key 本轮是否已被隔离",而不用自造第二把尺去猜
// (#81/#86 的病:同一规则多处实现)。纯读——不写日志、不改状态、不抛错;未知/非法 key 返回 false。
// 刻意不提供 clearQuarantine/resetQuarantine:隔离是进程级脏标志,"重启即恢复"是既有语义(#30)。
function isQuarantined (key) {
  return _corrupt.has(key);
}

// #74 与 isQuarantined 同处、同粒度的真因访问器:让对外文案能由**真因**组合,而不是调用点
// 各自硬编猜测类别(解析失败 ≠ 形状非法)。纯读——不写日志、不改状态、不抛错;
// 未隔离/未知 key 返回 null(锁定测试按 null 断言)。
function quarantineReason (key) {
  return _corruptReason.has(key) ? _corruptReason.get(key) : null;
}

// #103 损坏留痕与拒写留痕的唯一写手:过去 store.js 有两套句式各拼各的
// (:74「存储文件 X 损坏(…;原因: …),本进程内拒绝覆写」半角括号+尾部多余句 vs
// :165「拒绝覆写 X:本轮已隔离（原因: …）」全角括号+无 basename 前缀),同一件事两种帧形状,
// 运维无法用一条正则把某次损坏的全部留痕捞全(与 #97 收拾过的"多处硬编文案"同族病)。
// 收敛为固定骨架:存储文件 <basename> <event>（原因: <reason>[; <detail>]）——
//   括号一律全角「（）」;「原因: 」用半角冒号+空格;detail(如保全改名结果)存在时以
//   「; <detail>」放在同一对括号内、原因之后。
// reason 一律取自 quarantineReason(key)(损坏/拒写两事件同源 ⇒ 两帧的原因子串天然相等),
// basename 由 FILES[key] 求、未知 key 用 String(key) 兜底(绝不抛错)。
// 纯函数:不写日志、不改状态、不抛错。
function storageNotice (key, event, detail) {
  const base = FILES[key] ? path.basename(FILES[key]) : String(key);
  const reason = quarantineReason(key) || '原因未记录';
  return `存储文件 ${base} ${event}（原因: ${reason}${detail ? '; ' + detail : ''}）`;
}

// ── 日志(JSONL 追加,带简单锁防交错 + 按大小轮转) ──

let _logQueue = [];
let _logWriting = false;

// 日志单文件上限 5MB,超出则轮转为 .1(最多保留 current + .1,总量约 10MB 封顶)
const LOG_MAX_BYTES = 5 * 1024 * 1024;

function rotateLogsIfNeeded (incomingBytes) {
  try {
    if (!fs.existsSync(FILES.logs)) return;
    const size = fs.statSync(FILES.logs).size;
    if (size + incomingBytes > LOG_MAX_BYTES) {
      // 当前日志转为 .1(覆盖旧的 .1),新日志从空开始
      fs.renameSync(FILES.logs, FILES.logs + '.1');
    }
  } catch (_) { /* 轮转失败不阻塞写入 */ }
}

function flushLogQueue () {
  if (_logWriting || _logQueue.length === 0) return;
  _logWriting = true;
  const batch = _logQueue.join('\n') + '\n';
  _logQueue = [];
  rotateLogsIfNeeded(Buffer.byteLength(batch));
  fs.appendFile(FILES.logs, batch, 'utf-8', (err) => {
    _logWriting = false;
    if (err) console.error('[store] 日志写入失败:', err.message);
    if (_logQueue.length > 0) flushLogQueue();
  });
}

function appendLog (level, msg, extra = {}) {
  // 基础字段在前,extra 在后但不允许覆盖 ts/level/msg
  const { ts: _x, level: _y, msg: _z, ...safeExtra } = extra;
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: typeof msg === 'string' ? msg : JSON.stringify(msg),
    ...safeExtra
  });
  _logQueue.push(entry);
  flushLogQueue();
}

function readLogs (opts = {}) {
  const { level, limit = 50, since } = opts;
  const maxLimit = Math.max(1, Math.min(limit || 50, 500));
  try {
    if (!fs.existsSync(FILES.logs)) return [];
    const lines = fs.readFileSync(FILES.logs, 'utf-8').trim().split('\n').filter(Boolean);
    let entries = lines.map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    if (level) entries = entries.filter(e => e.level === level);
    if (since) entries = entries.filter(e => { try { return new Date(e.ts) > new Date(since); } catch (_) { return false; } });
    return entries.slice(-maxLimit);
  } catch (_) { return []; }
}

function clearLogs () {
  try { fs.writeFileSync(FILES.logs, '', 'utf-8'); } catch (_) {}
  try { if (fs.existsSync(FILES.logs + '.1')) fs.unlinkSync(FILES.logs + '.1'); } catch (_) {}
}

// ── 记忆(任务历史 + 经验 + 工具偏好 + 会议) ──

function loadMemory () {
  const mem = load('memory');
  if (!mem.tasks) mem.tasks = [];
  if (!mem.experiences) mem.experiences = [];
  if (!mem.preferences) mem.preferences = {};
  if (!mem.meetings) mem.meetings = [];
  return mem;
}

// ── 会议(多 Agent 讨论) ──

// #109:隔离期 saveSync 返回 false 不抛错,调用方必须知道建会有没有落盘;本函数是 store 内唯一曾丢弃该返回值的写点,故回传 { meeting, persisted }。
// #123:Date.now 只有毫秒精度,同毫秒并发建会会撞出同一个 id;此时按 id 回查永远只命中先建的那条,
// 两个讨论循环共用同一条记录(发言串台、终态互相覆盖),且撞车不可观测。故 id 追加 3 字节随机(6 位十六进制)保证同毫秒也唯一。
function createMeeting (topic, participants) {
  const mem = loadMemory();
  const meeting = {
    id: `meeting_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    ts: new Date().toISOString(),
    topic,
    participants: participants || [],
    messages: [],
    status: 'active'
  };
  mem.meetings.unshift(meeting);
  if (mem.meetings.length > 50) mem.meetings = mem.meetings.slice(0, 50);
  const persisted = saveSync('memory', mem);
  return { meeting, persisted };
}

// 单条发言内容上限与单会议发言条数上限(缓解 memory.json 全量重写膨胀)
const MAX_MSG_CONTENT = 8000;
const MAX_MEETING_MESSAGES = 200;

function addMessage (meetingId, speaker, content) {
  const mem = loadMemory();
  const meeting = mem.meetings.find(m => m.id === meetingId);
  if (!meeting) return null;
  if (meeting.status === 'closed') return null;
  let text = typeof content === 'string' ? content : JSON.stringify(content);
  if (text.length > MAX_MSG_CONTENT) text = text.substring(0, MAX_MSG_CONTENT) + `\n…(已截断,原长 ${text.length} 字符)`;
  meeting.messages.push({
    ts: new Date().toISOString(),
    speaker,
    content: text
  });
  // 单会议发言条数上限:超出则保留最新的
  if (meeting.messages.length > MAX_MEETING_MESSAGES) {
    meeting.messages = meeting.messages.slice(-MAX_MEETING_MESSAGES);
  }
  return saveSync('memory', mem);
}

function getMeeting (meetingId) {
  const mem = loadMemory();
  return mem.meetings.find(m => m.id === meetingId) || null;
}

function getRecentMeetings (limit = 10) {
  const safeLimit = Math.max(1, Math.min(limit || 10, 50));
  return loadMemory().meetings.slice(0, safeLimit);
}

function closeMeeting (meetingId, summary) {
  const mem = loadMemory();
  const meeting = mem.meetings.find(m => m.id === meetingId);
  if (!meeting) return null;
  meeting.status = 'closed';
  meeting.summary = summary || '';
  meeting.closedAt = new Date().toISOString();
  return saveSync('memory', mem);
}

// 启动清扫:中枢崩溃/被杀会让非终态会议永久残留,而并发闸门只按这三种状态计数,
// 累积到 MAX_CONCURRENT_MEETINGS 就把 /api/discuss 的额度占死(整体死锁且难归因),故启动时必须释放。
// 字段形状与人工中断路径(server.js /api/discuss/interrupt)逐字段一致,不改 closedAt/summary/messages。
function markOrphanMeetings () {
  const mem = loadMemory();
  // #103:此处曾有 quarantine('memory', <手抄 shapeReason 文案>) —— 实测永不可观测:
  //   meetings 形状真非法时,loadMemory 内部的 load() 已按「形状非法: <字段名> …」写入真因,
  //   而 quarantine 只记首次(first-write-wins,:61 早退),手抄文案进不了 _corruptReason;
  //   若只是「缺 meetings 的合法稀疏对象」,loadMemory 已补齐为 [] 数组,更进不到本分支。
  //   留着它只会随 shapeReason 规则静默变质(#74/#77 家族的第二把尺),故删除该调用。
  // 守卫本体保留:若上游绕过 load 传入非数组 meetings,启动清扫按既有语义返回 [] 且绝不抛错——
  //   启动期数据异常只能降级功能,不能阻止进程起来(#52:该函数在 server.js 顶层启动序列被调用)。
  if (!Array.isArray(mem.meetings)) {
    return [];
  }
  const swept = [];
  (mem.meetings || []).forEach(m => {
    if (m.status === 'discussing' || m.status === 'active' || m.status === 'implementing') {
      m.interrupted = true;
      m.interruptReason = '中枢重启导致执行中断(启动清扫)';
      m.status = 'interrupted';
      swept.push(m);
    }
  });
  // 无孤儿不写盘:避免每次重启都无谓覆写 memory.json
  if (swept.length > 0 && !saveSync('memory', mem)) {
    appendLog('error', `启动清扫 ${swept.length} 个孤儿会议失败:memory.json 处于隔离状态,闸门额度未释放`);
  }
  return swept;
}

function recordTask (task) {
  const mem = loadMemory();
  mem.tasks.unshift({
    id: task.id,
    ts: new Date().toISOString(),
    task: task.task?.substring(0, 200),
    tools: task.tools,
    results: (task.results || []).map(r => ({
      tool: r.tool,
      toolId: r.toolId || null,
      canonicalId: r.canonicalId || null,
      success: r.success,
      tokens: r.tokens?.total || 0,
      duration: r.duration,
      codeBlocks: r.codeBlocks?.length || 0,
      fallback: r.fallback || false,
      fallbackFrom: r.fallbackFrom
    })),
    successCount: task.successCount,
    // #62:调用点(server.js 的 taskRecord)本就带着路由分解结果,但白名单曾把它们丢掉 ⇒
    //   事后查台账只剩 successCount,分不清"3 个里 skipped 2 个"和"只点名了 1 个"。
    //   原样赋值、不加兜底(与相邻 successCount 同构),且仍逐字段列举——不整对象落盘(#62a2 反哨)。
    requested: task.requested,
    total: task.total,
    skipped: task.skipped,
    totalTokens: task.totalTokens,
    fallbackLog: task.fallbackLog,
    workspace: task.workspace || null
  });
  // 保留最近 200 条
  if (mem.tasks.length > 200) mem.tasks = mem.tasks.slice(0, 200);
  return saveSync('memory', mem);
}

function writeExperience (category, content, tags = []) {
  const mem = loadMemory();
  mem.experiences.unshift({
    id: `exp_${Date.now()}`,
    ts: new Date().toISOString(),
    category,
    content,
    tags
  });
  if (mem.experiences.length > 100) mem.experiences = mem.experiences.slice(0, 100);
  return saveSync('memory', mem);
}

function searchMemory (query) {
  const mem = loadMemory();
  const q = (query || '').trim().toLowerCase();
  if (!q) return { tasks: mem.tasks.slice(0, 10), experiences: mem.experiences.slice(0, 10) };
  const taskMatches = mem.tasks.filter(t =>
    t.task?.toLowerCase().includes(q) ||
    t.tools?.some(tool => tool.toLowerCase().includes(q))
  ).slice(0, 10);

  const expMatches = mem.experiences.filter(e =>
    e.content?.toLowerCase().includes(q) ||
    e.category?.toLowerCase().includes(q) ||
    e.tags?.some(tag => tag.toLowerCase().includes(q))
  ).slice(0, 10);

  return { tasks: taskMatches, experiences: expMatches };
}

function getToolStats () {
  const mem = loadMemory();
  const stats = {};
  for (const t of mem.tasks) {
    for (const r of (t.results || [])) {
      const key = r.toolId || r.tool;
      if (!key) continue;
      if (!stats[key]) stats[key] = { calls: 0, successes: 0, failures: 0, fallbacks: 0, totalTokens: 0 };
      stats[key].calls++;
      if (r.success) stats[key].successes++;
      else stats[key].failures++;
      if (r.fallback) stats[key].fallbacks++;
      stats[key].totalTokens += r.tokens || 0;
    }
  }
  return stats;
}

function getToolObservations (keys) {
  const wanted = new Set((keys || []).filter(Boolean));
  const observations = [];
  for (const task of loadMemory().tasks) {
    const observedTools = new Set();
    for (const result of (task.results || [])) {
      const key = result.toolId || result.tool;
      observedTools.add(result.tool);
      if (!wanted.has(key) && !wanted.has(result.tool)) continue;
      observations.push({
        key,
        tool: result.tool,
        toolId: result.toolId || null,
        ts: task.ts,
        task: task.task || '',
        success: result.success === true,
        fallback: result.fallback === true,
        duration: result.duration,
        tokens: result.tokens || 0
      });
    }
    // 旧记录会把原失败结果替换成接力成功结果；从 fallbackLog 补回原工具失败，
    // 否则路由画像会系统性高估经常触发接力的工具。
    for (const fb of (task.fallbackLog || [])) {
      if (!fb.from || fb.skipped) continue;
      // 旧记录会丢失原目标失败；仅在 results 中没有该工具时补回，避免重复计数。
      if (!observedTools.has(fb.from) && wanted.has(fb.from)) {
        observations.push({
          key: fb.from,
          tool: fb.from,
          toolId: null,
          ts: task.ts,
          task: task.task || '',
          success: false,
          fallback: false,
          duration: null,
          tokens: 0,
          inferredFromFallback: true
        });
      }
      // 失败的接力目标同样是真实失败样本；此前遗漏会让 fallback 候选长期保持零失败假象。
      if (fb.to && fb.success === false && !observedTools.has(fb.to) && wanted.has(fb.to)) {
        observations.push({
          key: fb.to,
          tool: fb.to,
          toolId: null,
          ts: task.ts,
          task: task.task || '',
          success: false,
          fallback: true,
          duration: null,
          tokens: 0,
          inferredFromFallbackTarget: true
        });
      }
    }
  }
  return observations;
}

function getRecentTasks (limit = 10) {
  const safeLimit = Math.max(1, Math.min(limit || 10, 200));
  return loadMemory().tasks.slice(0, safeLimit);
}

// ── 客户端准入控制(白名单 + 黑名单 + 待审批) ──

function loadACL () {
  const acl = load('acl');
  if (!Array.isArray(acl.allowlist)) acl.allowlist = [];
  if (!Array.isArray(acl.blocklist)) acl.blocklist = [];
  if (!Array.isArray(acl.pending)) acl.pending = [];
  return acl;
}

function saveACL (acl) {
  return saveSync('acl', acl);
}

module.exports = {
  FILES,
  load, saveSync, isQuarantined, quarantineReason, causeOf, storageNotice,
  appendLog, readLogs, clearLogs,
  loadMemory, recordTask, writeExperience, searchMemory, getToolStats, getToolObservations, getRecentTasks,
  createMeeting, addMessage, getMeeting, getRecentMeetings, closeMeeting, markOrphanMeetings,
  loadACL, saveACL
};
