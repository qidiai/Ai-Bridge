'use strict';

/**
 * ai-bridge/db.js — 电脑全局 SQLite 数据库(node:sqlite 内置模块,零外部依赖)
 *
 * 定位:跨项目/跨重启的结果沉淀层。JSON 文件(store.js)仍是运行时真源,
 * 本库是"写穿"副本 + 长期查询层——任何 DB 故障都不得影响中枢主链路(全部操作静默降级)。
 *
 * 默认路径:~/.ai-bridge/bridge.db(全局);env AI_BRIDGE_DB 可覆盖(测试隔离)。
 *
 * 五张表:
 *   dispatches  — 每次 dispatch 的最终结果(含路由依据)
 *   meetings    — 每场讨论会的终态(话题/状态/token/止损原因/共识总结)
 *   reviews     — 交叉评审记录(生产者/评审者/意见)
 *   async_tasks — 异步任务队列(queued/running/done/failed/orphaned)
 *   events      — 全局观测事件流(代理透传/telemetry 上报;只存用量摘要,不存正文/密钥)
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

let _db = null;
let _available = false;
let _lastError = null;
let _dbPath = null;

function resolveDbPath () {
  if (process.env.AI_BRIDGE_DB) return process.env.AI_BRIDGE_DB;
  return path.join(os.homedir(), '.ai-bridge', 'bridge.db');
}

function getDb () {
  if (_db) return _db;
  if (_lastError) return null; // 初始化失败过,不反复重试
  try {
    const { DatabaseSync } = require('node:sqlite');
    _dbPath = resolveDbPath();
    fs.mkdirSync(path.dirname(_dbPath), { recursive: true });
    _db = new DatabaseSync(_dbPath);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS dispatches (
        id TEXT PRIMARY KEY, ts TEXT NOT NULL, task TEXT, tools TEXT,
        success_count INTEGER, total INTEGER, total_tokens INTEGER,
        elapsed_ms INTEGER, routing TEXT, results TEXT
      );
      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY, ts TEXT NOT NULL, topic TEXT, participants TEXT,
        status TEXT, total_tokens INTEGER, interrupt_reason TEXT,
        summary TEXT, closed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY, dispatch_id TEXT, ts TEXT NOT NULL,
        producer TEXT, reviewer TEXT, skipped INTEGER DEFAULT 0,
        reason TEXT, content TEXT, tokens INTEGER
      );
      CREATE TABLE IF NOT EXISTS async_tasks (
        id TEXT PRIMARY KEY, ts TEXT NOT NULL, task TEXT,
        status TEXT NOT NULL, result TEXT, finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL, source TEXT NOT NULL, channel TEXT NOT NULL,
        event_type TEXT NOT NULL, model TEXT,
        input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0, success INTEGER DEFAULT 1, detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_dispatches_ts ON dispatches(ts);
      CREATE INDEX IF NOT EXISTS idx_meetings_ts ON meetings(ts);
      CREATE INDEX IF NOT EXISTS idx_async_status ON async_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
      CREATE INDEX IF NOT EXISTS idx_events_source ON events(source);
      CREATE TABLE IF NOT EXISTS traffic (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        direction TEXT NOT NULL,
        tool TEXT NOT NULL,
        task_id TEXT,
        type TEXT,
        success INTEGER,
        duration TEXT,
        error TEXT,
        content TEXT,
        code_blocks TEXT,
        usage TEXT,
        source TEXT DEFAULT 'bridge'
      );
      CREATE INDEX IF NOT EXISTS idx_traffic_ts ON traffic(ts);
      CREATE INDEX IF NOT EXISTS idx_traffic_tool ON traffic(tool);
      CREATE INDEX IF NOT EXISTS idx_traffic_direction ON traffic(direction);
      CREATE INDEX IF NOT EXISTS idx_traffic_source ON traffic(source);
    `);
    _available = true;
    return _db;
  } catch (e) {
    _lastError = e.message;
    _available = false;
    return null;
  }
}

// 所有写操作静默降级:DB 挂了绝不拖垮中枢
function safeRun (fn) {
  const db = getDb();
  if (!db) return false;
  try { fn(db); return true; } catch (e) { _lastError = e.message; return false; }
}

function recordDispatch (rec) {
  return safeRun(db => {
    db.prepare(`INSERT OR REPLACE INTO dispatches
      (id, ts, task, tools, success_count, total, total_tokens, elapsed_ms, routing, results)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(rec.dispatchId, new Date().toISOString(), (rec.task || '').substring(0, 500),
        JSON.stringify(rec.tools || []), rec.successCount || 0, rec.total || 0,
        rec.totalTokens || 0, rec.elapsedMs || 0,
        rec.routing ? JSON.stringify(rec.routing) : null,
        JSON.stringify((rec.results || []).map(r => ({ tool: r.tool, success: r.success, tokens: r.tokens?.total || 0, fallback: r.fallback || false }))));
  });
}

function recordMeeting (m) {
  if (!m) return false;
  return safeRun(db => {
    db.prepare(`INSERT OR REPLACE INTO meetings
      (id, ts, topic, participants, status, total_tokens, interrupt_reason, summary, closed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(m.id, m.ts || new Date().toISOString(), (m.topic || '').substring(0, 500),
        JSON.stringify(m.participants || []), m.status || 'unknown', m.totalTokens || 0,
        m.interruptReason || null, m.summary || null, m.closedAt || null);
  });
}

function recordReview (r) {
  return safeRun(db => {
    db.prepare(`INSERT OR REPLACE INTO reviews
      (id, dispatch_id, ts, producer, reviewer, skipped, reason, content, tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(r.id, r.dispatchId || null, new Date().toISOString(), r.producer || null,
        r.reviewer || null, r.skipped ? 1 : 0, r.reason || null,
        (r.content || '').substring(0, 8000), r.tokens || 0);
  });
}

// ── 异步任务队列 ──

function createAsyncTask (id, task) {
  return safeRun(db => {
    db.prepare('INSERT INTO async_tasks (id, ts, task, status) VALUES (?, ?, ?, ?)')
      .run(id, new Date().toISOString(), (task || '').substring(0, 500), 'running');
  });
}

function finishAsyncTask (id, status, result) {
  return safeRun(db => {
    db.prepare('UPDATE async_tasks SET status = ?, result = ?, finished_at = ? WHERE id = ?')
      .run(status, result ? JSON.stringify(result) : null, new Date().toISOString(), id);
  });
}

function getAsyncTask (id) {
  const db = getDb();
  if (!db) return null;
  try {
    const row = db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(id);
    if (!row) return null;
    return { ...row, result: row.result ? JSON.parse(row.result) : null };
  } catch (e) { _lastError = e.message; return null; }
}

// 中枢重启后,未完成的异步任务标记为孤儿(执行进度已丢失,不谎报 running)
function markOrphanTasks () {
  let count = 0;
  safeRun(db => {
    const r = db.prepare("UPDATE async_tasks SET status = 'orphaned', finished_at = ? WHERE status IN ('queued', 'running')")
      .run(new Date().toISOString());
    count = r.changes || 0;
  });
  return count;
}

// ── 全局观测事件流 ──

// detail 列上限:2000 字是合法上限(恰好 2000 一字不改),超长才截。
const EVENT_DETAIL_MAX = 2000;

// 只存用量摘要:detail 由调用方负责截断+脱敏,本层再做一道硬截断兜底。
// 兜底不许静默:超长时把尾部标记接在截断前缀之后(#124),句式沿用内存层截断的那一句
// 「…(已截断,原长 N 字符)」——读回方(含讨论止损原因的降级视图)才能看出"这句被截过",
// 而不是把一句断话当成完整原因。未超长/恰好到上限一律原样落库,留痕不得变成噪音。
function clipEventDetail (detail) {
  if (!detail) return null;
  const text = String(detail);
  if (text.length <= EVENT_DETAIL_MAX) return text;
  return text.substring(0, EVENT_DETAIL_MAX) + `\n…(已截断,原长 ${text.length} 字符)`;
}

function recordEvent (ev) {
  return safeRun(db => {
    db.prepare(`INSERT INTO events
      (ts, source, channel, event_type, model, input_tokens, output_tokens, duration_ms, success, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(new Date().toISOString(), String(ev.source || 'unknown').substring(0, 60),
        String(ev.channel || 'telemetry').substring(0, 20), String(ev.type || 'unknown').substring(0, 40),
        ev.model ? String(ev.model).substring(0, 120) : null,
        Number.isFinite(ev.inputTokens) ? ev.inputTokens : 0,
        Number.isFinite(ev.outputTokens) ? ev.outputTokens : 0,
        Number.isFinite(ev.durationMs) ? ev.durationMs : 0,
        ev.success === false ? 0 : 1,
        clipEventDetail(ev.detail));
  });
}

function eventsSummary (days) {
  const db = getDb();
  if (!db) return null;
  try {
    const since = new Date(Date.now() - (days || 7) * 86400000).toISOString();
    return {
      bySource: db.prepare(`SELECT source, channel, COUNT(*) AS n,
          SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
          SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) AS successes, AVG(duration_ms) AS avg_ms
        FROM events WHERE ts >= ? GROUP BY source, channel ORDER BY n DESC`).all(since),
      byDay: db.prepare(`SELECT ${dayExpr()} AS day, source, COUNT(*) AS n,
          SUM(input_tokens + output_tokens) AS tokens
        FROM events WHERE ts >= ? GROUP BY day, source ORDER BY day DESC`).all(since),
      recent: db.prepare(`SELECT ts, source, channel, event_type, model,
          input_tokens, output_tokens, duration_ms, success
        FROM events ORDER BY id DESC LIMIT 20`).all()
    };
  } catch (e) { _lastError = e.message; return null; }
}

// 观测事件读回:按 source / eventType 过滤,时间倒序。
// 安全约束:source 可能来自 URL 路径分段(外部可控),因此所有条件一律走 prepare 的绑定参数,
// 绝不把调用方字符串拼进 SQL;条件片段本身是常量,拼接只发生在常量之间。
// 失败安全与 queryTraffic 同形:取不到库或查询出错都回空数组而不抛,并沿用本文件的留痕字段。
function queryEvents (opts = {}) {
  const db = getDb();
  if (!db) return [];
  try {
    const conditions = [];
    const params = [];
    if (opts.source) { conditions.push('source = ?'); params.push(String(opts.source)); }
    if (opts.eventType) { conditions.push('event_type = ?'); params.push(String(opts.eventType)); }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const limit = Math.max(1, Math.min(opts.limit || 20, 200));
    const rows = db.prepare(`SELECT ts, source, channel, event_type, duration_ms, success, detail
      FROM events ${where} ORDER BY ts DESC, id DESC LIMIT ?`).all(...params, limit);
    return rows.map(r => ({
      ts: r.ts,
      source: r.source,
      channel: r.channel,
      type: r.event_type,
      success: !!r.success,
      detail: r.detail,
      durationMs: r.duration_ms
    }));
  } catch (e) { _lastError = e.message; return []; }
}

// ── 查询/统计 ──

// ── 流量记录(完整内容,不截断) ──

function recordTraffic (entry) {
  return safeRun(db => {
    db.prepare(`INSERT INTO traffic
      (ts, direction, tool, task_id, type, success, duration, error, content, code_blocks, usage, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        entry.ts || new Date().toISOString(),
        entry.direction || 'out',
        String(entry.tool || 'unknown').substring(0, 120),
        entry.taskId || null,
        entry.type || null,
        entry.success === false ? 0 : (entry.success === true ? 1 : null),
        entry.duration || null,
        entry.error || null,
        entry.content || '',
        entry.codeBlocks ? JSON.stringify(entry.codeBlocks) : null,
        entry.usage ? JSON.stringify(entry.usage) : null,
        entry.source || 'bridge'
      );
  });
}

function queryTraffic (opts = {}) {
  const db = getDb();
  if (!db) return [];
  try {
    const conditions = [];
    const params = [];
    if (opts.tool) { conditions.push('tool = ?'); params.push(opts.tool); }
    if (opts.direction) { conditions.push('direction = ?'); params.push(opts.direction); }
    if (opts.source) { conditions.push('source = ?'); params.push(opts.source); }
    if (opts.since) { conditions.push('ts > ?'); params.push(opts.since); }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const limit = Math.max(1, Math.min(opts.limit || 50, 500));
    const rows = db.prepare(`SELECT * FROM traffic ${where} ORDER BY id DESC LIMIT ?`).all(...params, limit);
    return rows.map(r => ({
      ...r,
      success: r.success === null ? null : !!r.success,
      code_blocks: r.code_blocks ? JSON.parse(r.code_blocks) : null,
      usage: r.usage ? JSON.parse(r.usage) : null
    }));
  } catch (e) { _lastError = e.message; return []; }
}

function clearTraffic () {
  return safeRun(db => {
    db.prepare('DELETE FROM traffic').run();
  });
}

// ── 用量报表:按天/按工具聚合(traffic 表,反代调用;events 表,透传观测) ──

// S1 单点:traffic.usage(JSON 文本列)算 tokens 的唯一 SQL 表达式生成器。
// 规则:COALESCE 链(取第一个非空键),不得把两种键名相加——同一行里
// {input:200 与 OpenAI 原样键} 只能算 260 入,不能翻倍(重复计数陷阱,历史复发过)。
// 覆盖已落库的三种形态:归一化 {input,output} / 上游原样 / 客户端上报 {input_tokens,output_tokens}。
// 三处聚合(byDay、byTool、todayTokens)必须共用此表达式,不得各自再手写键名。
function usageTokensSql (col = 'usage') {
  const j = (key) => `CAST(json_extract(${col}, '$.${key}') AS INTEGER)`;
  return `COALESCE(${j('input')}, ${j('prompt_tokens')}, ${j('input_tokens')}, 0)`
    + ` + COALESCE(${j('output')}, ${j('completion_tokens')}, ${j('output_tokens')}, 0)`;
}

// S1 单点:用量统计只能有一本日历。凡按"日"分组/比较者(usageReport.byDay、
// todayTokens 的比较、eventsSummary.byDay)一律经此表达式,不得再各写各的 UTC 日截取。
// 读侧统一按**本地日**(datetime(...,'localtime') 跟随进程时区),与 todayTokens 用
// getFullYear/getMonth/getDate 拼出的本地 today 同源;写侧 ts 仍落 UTC ISO(带 Z),
// 本改动只读不写(#78c3 锁着落库格式)。
function dayExpr (col = 'ts') {
  return `substr(datetime(${col}, 'localtime'), 1, 10)`;
}

function usageReport (days = 7) {
  const db = getDb();
  if (!db) return { available: false, byDay: [], byTool: [] };
  try {
    const since = new Date(Date.now() - Math.max(1, days) * 86400000).toISOString();
    const byDay = db.prepare(`
      SELECT ${dayExpr()} AS day, tool,
             COUNT(*) AS calls,
             SUM(CASE WHEN success THEN 1 ELSE 0 END) AS ok,
             COALESCE(SUM(${usageTokensSql()}), 0) AS tokens
      FROM traffic
      WHERE direction = 'in' AND ts >= ?
      GROUP BY day, tool
      ORDER BY day DESC, tokens DESC
    `).all(since).map(r => ({ ...r, ok: !!r.ok }));
    const byTool = db.prepare(`
      SELECT tool, COUNT(*) AS calls,
             COALESCE(SUM(${usageTokensSql()}), 0) AS tokens
      FROM traffic
      WHERE direction = 'in' AND ts >= ?
      GROUP BY tool ORDER BY tokens DESC
    `).all(since);
    return { available: true, days, byDay, byTool };
  } catch (e) { _lastError = e.message; return { available: false, byDay: [], byTool: [] }; }
}

// 今日 token 总量(AI_BRIDGE_DAILY_TOKEN_BUDGET 告警唯一输入):本地 today 串与 SQL 比较两侧
// 共用 dayExpr() 这同一本本地日历;写侧 ts 仍按 UTC ISO 落库,不受此处读法影响。
function todayTokens () {
  const db = getDb();
  if (!db) return 0;
  try {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const row = db.prepare(`
      SELECT COALESCE(SUM(${usageTokensSql()}), 0) AS tokens
      FROM traffic WHERE direction = 'in' AND ${dayExpr()} = ?
    `).get(today);
    return row?.tokens || 0;
  } catch (e) { _lastError = e.message; return 0; }
}

function stats () {
  const db = getDb();
  const base = { available: _available, dbPath: _dbPath, lastError: _lastError };
  if (!db) return base;
  try {
    const one = (sql) => db.prepare(sql).get();
    return {
      ...base,
      dispatches: one('SELECT COUNT(*) AS n, COALESCE(SUM(total_tokens),0) AS tokens FROM dispatches'),
      meetings: one('SELECT COUNT(*) AS n, COALESCE(SUM(total_tokens),0) AS tokens FROM meetings'),
      reviews: one('SELECT COUNT(*) AS n FROM reviews'),
      events: one('SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens + output_tokens),0) AS tokens FROM events'),
      asyncTasks: one("SELECT COUNT(*) AS n, SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done, SUM(CASE WHEN status='orphaned' THEN 1 ELSE 0 END) AS orphaned FROM async_tasks"),
      recentDispatches: db.prepare('SELECT id, ts, task, success_count, total, total_tokens FROM dispatches ORDER BY ts DESC LIMIT 5').all(),
      recentMeetings: db.prepare('SELECT id, ts, topic, status, total_tokens FROM meetings ORDER BY ts DESC LIMIT 5').all()
    };
  } catch (e) { _lastError = e.message; return { ...base, lastError: _lastError }; }
}

module.exports = {
  getDb, recordDispatch, recordMeeting, recordReview,
  createAsyncTask, finishAsyncTask, getAsyncTask, markOrphanTasks,
  recordEvent, eventsSummary, queryEvents,
  recordTraffic, queryTraffic, clearTraffic,
  usageReport, todayTokens, usageTokensSql,
  stats,
  get available () { return _available; },
  get dbPath () { return _dbPath; }
};
