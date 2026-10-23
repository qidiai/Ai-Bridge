#!/usr/bin/env node
'use strict';

/**
 * AI Bridge HTTP 常驻服务 v1.1
 *
 * 修复:鉴权/CORS/并发安全/长轮询泄漏/graceful shutdown/常量配置化/全局错误处理
 */

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { TOOLS, findInPath, estimateTokens, extractCodeBlocks, getLoadDiagnostics } = require('./tool-registry');
const { getKimiProxyModels } = require('./kimi-models');
const qidiSync = require('./qidi-sync');
const {
  decorateToolIdentity,
  resolveToolReference,
  switchKeysFor,
  statsKeysFor
} = require('./tool-identity');
const {
  classifyTask,
  buildRoutingProfile,
  rankRoutingProfiles
} = require('./routing-score');
const { CliAdapter, runCommand } = require('./adapters/cli-adapter');
const store = require('./store');
const workspaceManager = require('./workspace-manager');
const db = require('./db');
const observe = require('./observe');
const { cleanupStaleTaskDirs } = require('./output-cleaner.js');
const { USAGE_REPORT_SUFFIX, parseUsageReport } = require('./usage-reporter');
// #47 流式命中缓存的 SSE 合成器(纯函数零依赖;行为锁 test-unit #47a0~a6)
const { isReplayableJson, sseFromChatJson } = require('./sse-replay');

// ── #46 tools.json 降级留痕:加载期损坏只降级功能、不拦进程起来;但"静态工具缺席"这一事实必须进可查账本 ──
//   落账必须在 server.js 做:tool-registry 不得为此依赖 store(#46a4 —— bridge-stdio 也 require 它,
//   加了依赖每个 MCP 桥进程都会在加载期 mkdir 数据目录)。'missing' 是合法部署态,不写 error 级。
//   本处不做 /api/health 上报(那属 #33 损坏状态上报);对原件不做任何写/改名/删除(#46a5)。
{
  const regDiag = getLoadDiagnostics();
  if (regDiag.status === 'corrupt-parse' || regDiag.status === 'corrupt-shape') {
    const statusCn = regDiag.status === 'corrupt-parse' ? '解析失败' : '顶层形状非法（期望 JSON 数组）';
    const diagMsg = `工具配置 ${regDiag.file} 已降级（${statusCn}；原因: ${regDiag.error}）：` +
      '静态工具已全部缺席，本进程仅剩自动同步工具；原件未被改动，需人工修复后方可恢复。';
    store.appendLog('error', diagMsg);
    console.error('[server] ' + diagMsg); // watchdog stdio 为 inherit：不能只进 logs.jsonl，stdout 也要看得到
  }
}

// ── 配置(集中管理,不再分散硬编码) ──
// 解析正整数 env:非数字/0/负数一律回退默认值
function parsePositiveInt (v, def) {
  const n = parseInt(v);
  return (Number.isFinite(n) && n > 0) ? n : def;
}
const CONFIG = {
  PORT: parseInt(process.env.AI_BRIDGE_PORT) || 9800,
  HOST: process.env.AI_BRIDGE_HOST || '127.0.0.1',
  EXECUTE_TIMEOUT: parseInt(process.env.AI_BRIDGE_EXECUTE_TIMEOUT) || 900000, // 可配:默认 15 分钟,慢客户端(如本地大模型宿主)可再放宽单次执行窗口
  POLL_TIMEOUT: 30000,
  MAX_TASK_LENGTH: 50000,
  MAX_CONCURRENT_DISPATCH: parsePositiveInt(process.env.AI_BRIDGE_MAX_CONCURRENT_DISPATCH, 5),
  RESULT_MAX_CHARS: parsePositiveInt(process.env.AI_BRIDGE_RESULT_MAX_CHARS, 2000), // dispatch 结果 content 截断上限(可配,防长产出被硬砍)
  MAX_CONCURRENT_MEETINGS: 3,
  TOOL_STATUS_TTL: 60000,
  CLIENT_TTL: parsePositiveInt(process.env.AI_BRIDGE_CLIENT_TTL, 5 * 60 * 1000),
  MAX_MEETING_TOKENS: parseInt(process.env.AI_BRIDGE_MEETING_MAX_TOKENS) || 100000,
  MEETING_MAX_MS: parseInt(process.env.AI_BRIDGE_MEETING_MAX_MS) || 10 * 60 * 1000,
  AUTH_TOKEN: process.env.AI_BRIDGE_TOKEN || null,
  CORS_ORIGIN: process.env.AI_BRIDGE_CORS || null
};

const CONFIG_DIR = __dirname;
const SWITCHES_FILE = store.FILES.switches;
const STATS_FILE = store.FILES.stats;

// ── 数据操作委托给 store.js ──
function loadJSON (file) {
  if (file === SWITCHES_FILE) return store.load('switches');
  if (file === STATS_FILE) return store.load('stats');
  return {};
}
function saveJSONSync (file, data) {
  if (file === SWITCHES_FILE || file === 'switches') return store.saveSync('switches', data);
  else if (file === STATS_FILE || file === 'stats') return store.saveSync('stats', data);
}

function recordTokens (tool, usage, duration) {
  // 新调用写入稳定实例键（cli:* / client:*）；历史裸名称继续只读聚合，不破坏旧数据。
  const statsKey = typeof tool === 'string' ? tool : tool.id;
  const stats = store.load('stats');
  if (!stats.total) stats.total = { input: 0, output: 0, total: 0, calls: 0 };
  if (!stats.tools) stats.tools = {};
  if (!stats.tools[statsKey]) stats.tools[statsKey] = { input: 0, output: 0, total: 0, calls: 0, lastUsed: null };
  const input = usage?.input || 0;
  const output = usage?.output || 0;
  const total = input + output;
  stats.tools[statsKey].input += input;
  stats.tools[statsKey].output += output;
  stats.tools[statsKey].total += total;
  stats.tools[statsKey].calls += 1;
  stats.tools[statsKey].lastUsed = new Date().toISOString();
  stats.tools[statsKey].lastDuration = duration;
  stats.total.input += input;
  stats.total.output += output;
  stats.total.total += total;
  stats.total.calls += 1;
  store.saveSync('stats', stats); // store.saveSync 内部有自旋锁保护
  store.appendLog('debug', `recordTokens: ${statsKey} ${JSON.stringify({input,output,total})}`, { tool: statsKey });
}

// ── 日志快捷方法 ──
function log (level, msg, extra) { store.appendLog(level, msg, extra); }

// ── AgnesCode 凭据读取(Windows Credential Manager) ──
const { execSync } = require('child_process');
let _agnesToken = null;
let _agnesTokenTime = 0;
const AGNES_TOKEN_TTL = 3600000;

function readAgnesToken () {
  if (_agnesToken && Date.now() - _agnesTokenTime < AGNES_TOKEN_TTL) return _agnesToken;
  try {
    const script = path.join(__dirname, 'read-cred.ps1');
    const result = execSync(
      `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}"`,
      { encoding: 'utf-8', timeout: 10000, windowsHide: true }
    ).trim();
    if (!result) return null;
    // 结果可能是 JSON: {"AGNES_AI_API_KEY":"..."}
    try {
      const parsed = JSON.parse(result);
      _agnesToken = parsed.AGNES_AI_API_KEY || parsed.api_key || parsed.token || result;
    } catch (_) {
      _agnesToken = result;
    }
    _agnesTokenTime = Date.now();
    log('info', 'AgnesCode token refreshed from Windows Credential Manager');
    return _agnesToken;
  } catch (e) {
    log('error', `Failed to read AgnesCode credential: ${e.message}`);
    return null;
  }
}

// ── AtomCode 凭据读取(auth.toml) ──
let _atomToken = null;
let _atomTokenTime = 0;

function readAtomToken () {
  if (_atomToken && Date.now() - _atomTokenTime < AGNES_TOKEN_TTL) return _atomToken;
  try {
    const authPath = path.join(os.homedir(), '.atomcode', 'auth.toml');
    if (!fs.existsSync(authPath)) return null;
    const content = fs.readFileSync(authPath, 'utf-8');
    const match = content.match(/access_token\s*=\s*"([^"]+)"/);
    if (!match) return null;
    _atomToken = match[1];
    _atomTokenTime = Date.now();
    log('info', 'AtomCode token refreshed from auth.toml');
    return _atomToken;
  } catch (e) {
    log('error', `Failed to read AtomCode credential: ${e.message}`);
    return null;
  }
}

// ── Codely(团结 Cowork)客户端:可选模块 ──
// 开源版不包含 codely-client.js(含官方签名逆向实现),缺失时该 transport 自动禁用
let codelyClient = null;
try {
  codelyClient = require('./codely-client');
} catch (e) {
  /* 开源版剔除:codely transport 不可用 */
}
const CODELY_LITELLM_BASE = codelyClient ? codelyClient.CODELY_LITELLM_BASE : null;
const fetchCodelyCliApiKey = codelyClient ? codelyClient.fetchCodelyCliApiKey : () => Promise.reject(new Error('codely-client 未包含(开源版剔除)'));
const getCodelyCliApiKey = codelyClient ? codelyClient.getCodelyCliApiKey : () => Promise.reject(new Error('codely-client 未包含(开源版剔除)'));
const invalidateCodelyKey = codelyClient ? codelyClient.invalidateCodelyKey : () => {};
const buildCodelyHeaders = codelyClient ? codelyClient.buildCodelyHeaders : () => ({});
const requestCodelyLiteLLM = codelyClient ? codelyClient.requestCodelyLiteLLM : () => { throw new Error('codely-client 未包含(开源版剔除)'); };
const codelyCliVersion = codelyClient ? codelyClient.codelyCliVersion : () => null;
const codelyTokenExpiryDays = codelyClient ? codelyClient.codelyTokenExpiryDays : () => null;

// ── OpenAI 兼容反代:模型注册表(配置驱动,新增模型只改 models.json,不改代码) ──
let _modelsCache = null;
let _modelsCacheTime = 0;
function loadModels () {
  if (_modelsCache && Date.now() - _modelsCacheTime < 30000) return _modelsCache;
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(__dirname, 'models.json'), 'utf-8'));
    _modelsCache = Array.isArray(arr) ? arr : [];
  } catch (e) {
    log('error', `models.json 加载失败: ${e.message}`);
    _modelsCache = [];
  }
  _modelsCacheTime = Date.now();
  return _modelsCache;
}

function findModel (id) {
  const wanted = String(id || '').toLowerCase();
  return loadAllModels().find(m => String(m.id).toLowerCase() === wanted) || null;
}

// 完整模型清单 = models.json(文件,可被 /api/models/sync 持久化改写)
// + kimi-code 自动同步条目(内存合并,不落盘;kimi config 变化后 30s 缓存到期自动生效)
function loadAllModels () {
  const file = loadModels();
  const seen = new Set(file.map(m => String(m.id).toLowerCase()));
  const auto = getKimiProxyModels().filter(m => !seen.has(String(m.id).toLowerCase()));
  return file.concat(auto);
}

// 模型是否可用:绑定的工具开关未被显式关闭(与 dispatch 共用 switches.json)
function modelEnabled (m) {
  return !m.switch || isToolEnabled(m.switch);
}

// ── 反代幂等缓存(内存 LRU,不落盘避免敏感内容持久化;仅缓存 200 成功响应) ──
const CACHE_TTL = parsePositiveInt(process.env.AI_BRIDGE_CACHE_TTL, 10 * 60 * 1000);
const CACHE_MAX = parsePositiveInt(process.env.AI_BRIDGE_CACHE_MAX, 100);
const _respCache = new Map(); // key → { value(Buffer), at }
function cacheKey (modelId, body) {
  // #47 明确决定:cacheKey **不按 stream 分键**。缓存值只存非流式 chat.completion JSON
  // (唯一写入口 `if (!isStream) cacheSet`),流式命中由 sse-replay 合成器负责适配 →
  // 非流式与流式互相受益(流式请求可白吃非流式预热过的缓存)。后人勿"补"stream 进键,
  // 那会让两侧缓存互相隔离、并让当前共享设计的行为锁(#47a5)失去意义。
  const stable = { model: body.model, messages: body.messages, temperature: body.temperature, top_p: body.top_p, max_tokens: body.max_tokens };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}
function cacheGet (key) {
  const hit = _respCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL) { _respCache.delete(key); return null; }
  _respCache.delete(key); _respCache.set(key, hit); // LRU 触碰
  return hit;
}
function cacheSet (key, value) {
  if (_respCache.size >= CACHE_MAX) _respCache.delete(_respCache.keys().next().value);
  _respCache.set(key, { value: Buffer.from(value), at: Date.now() });
}

// ── Codely LiteLLM 转发(流式/非流式;401/403 时换新 key 重试一次,应对服务端密钥轮换) ──
// ctx: { res, reqPath, reqData, messages, model, taskId, isStream, cliKey, retried }
// 非流式 200 响应写入幂等缓存;流式命中且缓存体可回放时由 sse-replay 合成多帧 SSE(#47),
// 不可回放则在命中分支逐出缓存后继续走本函数正常转发(见上方 if (cached) 块)
function forwardCodelyLiteLLM (ctx) {
  const { res, reqPath, reqData, messages, model, taskId, isStream } = ctx;
  const headers = buildCodelyHeaders(reqPath, ctx.cliKey, reqData);
  const targetUrl = ctx.reqUrl || `${CODELY_LITELLM_BASE}${reqPath}`;
  db.recordTraffic({ ts: new Date().toISOString(), direction: 'out', tool: model.id, taskId, type: 'openai-proxy', content: JSON.stringify(messages || (reqData ? JSON.parse(reqData).messages : [])).substring(0, 8000), source: 'bridge' });
  const proxyReq = https.request(targetUrl, {
    method: 'POST',
    headers
  }, (proxyRes) => {
    if ((proxyRes.statusCode === 401 || proxyRes.statusCode === 403) && !ctx.retried) {
      let errBody = '';
      proxyRes.on('data', d => errBody += d);
      proxyRes.on('end', async () => {
        invalidateCodelyKey();
        log('warn', `Codely 上游 ${proxyRes.statusCode},换新 cli_api_key 重试一次: ${errBody.substring(0, 200)}`);
        try {
          ctx.cliKey = await fetchCodelyCliApiKey();
          ctx.retried = true;
          forwardCodelyLiteLLM(ctx);
        } catch (e) {
          sendJSON(res, 502, { error: '重试时获取 Codely cli_api_key 失败', detail: String(e.message || e).substring(0, 300) });
        }
      });
      return;
    }
    if (proxyRes.statusCode === 401 || proxyRes.statusCode === 403) {
      // 重试仍 401:大概率官方更换了签名算法/内置盐(UA 已跟本地 exe 版本,只剩签名常量轮换这一种可能)
      let errBody = '';
      proxyRes.on('data', d => errBody += d);
      proxyRes.on('end', () => {
        log('error', `Codely 上游持续 ${proxyRes.statusCode},官方可能更换签名算法,需重新逆向 codely.exe: ${errBody.substring(0, 300)}`);
        sendJSON(res, proxyRes.statusCode, { error: '上游持续拒绝(签名或密钥失效)', detail: errBody.substring(0, 500) });
      });
      return;
    }
    if (proxyRes.statusCode !== 200) {
      let errBody = '';
      proxyRes.on('data', d => errBody += d);
      proxyRes.on('end', () => sendJSON(res, proxyRes.statusCode, { error: '上游错误', detail: errBody.substring(0, 500) }));
      return;
    }
    if (isStream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      let fullContent = '';
      proxyRes.on('data', chunk => {
        res.write(chunk);
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try { fullContent += JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || JSON.parse(line.slice(6)).delta?.text || ''; } catch (_) {}
          }
        }
      });
      proxyRes.on('end', () => {
        res.end();
        db.recordTraffic({ ts: new Date().toISOString(), direction: 'in', tool: model.id, taskId, type: 'openai-proxy', success: true, content: fullContent.substring(0, 8000), source: 'bridge' });
        recordTokens(model.id, { input: estimateTokens(JSON.stringify(messages || [])), output: estimateTokens(fullContent), estimated: true }, '—');
      });
    } else {
      let respData = '';
      proxyRes.on('data', d => respData += d);
      proxyRes.on('end', () => {
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(respData);
        try {
          const parsed = JSON.parse(respData);
          // 写侧归一(#45 S2):落库只写形状 {input,output,total},不再存上游原样 usage(形状①是病源)。
          // 上游键名在此仅用于"读取响应",不入库;HTTP 响应体(res.end(respData))原样透传,一个字节都不改。
          const usageTokens = parsed.usage ? { input: parsed.usage.prompt_tokens || parsed.usage.input_tokens || 0, output: parsed.usage.completion_tokens || parsed.usage.output_tokens || 0 } : { input: estimateTokens(JSON.stringify(messages || [])), output: estimateTokens(parsed.choices?.[0]?.message?.content || parsed.content?.[0]?.text || ''), estimated: true };
          usageTokens.total = usageTokens.input + usageTokens.output;
          db.recordTraffic({ ts: new Date().toISOString(), direction: 'in', tool: model.id, taskId, type: 'openai-proxy', success: true, content: (parsed.choices?.[0]?.message?.content || parsed.content?.[0]?.text || '').substring(0, 8000), usage: usageTokens, source: 'bridge' });
          recordTokens(model.id, usageTokens, '—');
        } catch (_) {}
      });
    }
  });
  proxyReq.on('error', e => { if (!res.headersSent) sendJSON(res, 502, { error: '上游请求失败', detail: e.message }); else res.end(); });
  proxyReq.write(reqData);
  proxyReq.end();
}

// OpenAI messages[] → 单条 prompt(CLI 型订阅一次性输入用;兼容 content 为字符串或分段数组)
function messagesToPrompt (messages) {
  if (!Array.isArray(messages)) return '';
  return messages.map(m => {
    const c = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content) ? m.content.map(x => (x && typeof x.text === 'string') ? x.text : '').join('') : '';
    return c ? `${m.role || 'user'}: ${c}` : '';
  }).filter(Boolean).join('\n\n');
}

// ── 状态 ──
let _toolStatus = null;
let _toolStatusTime = 0;
const connectedClients = new Map();
// 仅保留最近一次离线/过期原因，不参与调度；用于把 ACL 权限态与运行态分开呈现。
const clientTombstones = new Map();
const activeDispatches = new Set();
// 异步任务内存结果表(主查询层;全局库是持久化副本,重启后可查历史)
const asyncTaskResults = new Map();
function rememberAsyncTask (id, entry) {
  asyncTaskResults.set(id, entry);
  if (asyncTaskResults.size > 100) asyncTaskResults.delete(asyncTaskResults.keys().next().value);
}
let activeDispatchCount = 0;
let isShuttingDown = false;
const START_TIME = Date.now();

// ── 运行指标(可观测性:进程级轻量内存计数,重启归零) ──
const METRICS = {
  dispatchTotal: 0, dispatchSuccess: 0, dispatchFail: 0,
  fallbackTotal: 0, fallbackSuccess: 0,
  clientTimeouts: 0,
  meetingsStarted: 0,
  meetingsAutoStopped: 0,
  errors5xx: 0
};

let _statusPromise = null; // in-flight 去重:防并发刷新交叉写入同一缓存数组产生重复工具项
async function getToolStatus () {
  // 加 TTL,60 秒后自动刷新
  if (_toolStatus && Date.now() - _toolStatusTime < CONFIG.TOOL_STATUS_TTL) return _toolStatus;
  if (_statusPromise) return _statusPromise;
  _statusPromise = (async () => {
    try {
      const list = []; // 构建局部数组,完成后一次性赋值,避免半成品暴露
      for (const tool of TOOLS) {
        const available = await tool.detect();
        list.push({ name: tool.name, displayName: tool.displayName, description: tool.description, available });
      }
      _toolStatus = list;
      _toolStatusTime = Date.now();
      return list;
    } finally {
      _statusPromise = null;
    }
  })();
  return _statusPromise;
}

function refreshToolStatus () {
  _toolStatus = null;
  _toolStatusTime = 0;
}

async function getAllTools () {
  const status = await getToolStatus();
  const tools = status.map(t => decorateToolIdentity({ ...t, type: 'cli', sourceId: t.name }));
  for (const [name, info] of connectedClients) {
    // 只有完成首次 poll、连接健康且宿主明确支持 MCP sampling 的客户端才进入执行调度。
    // 不支持 sampling 的客户端仍保留控制连接，可调用 AI Bridge 工具，但不能承接反向任务。
    if (!info.firstPollAt || clientState(info) === 'stale' || info.supportsSampling !== true) continue;
    const clientTool = {
      name,
      sourceId: info.name,
      displayName: info.name,
      description: `已连接的 AI 编程软件 (${info.name})`,
      available: true,
      type: 'client',
      clientKey: name,
      supportsExec: info.supportsExec === true
    };
    tools.push(decorateToolIdentity(clientTool));
  }
  return tools;
}

function isToolEnabled (tool, switches = null) {
  const sw = switches || loadJSON(SWITCHES_FILE);
  const t = typeof tool === 'string' ? null : tool;
  if (!t) return sw[tool] !== false; // 模型开关等非工具调用保持兼容。
  const keys = switchKeysFor(t);
  const configured = keys.find(key => Object.prototype.hasOwnProperty.call(sw, key));
  return configured ? sw[configured] !== false : true;
}

function aggregateTokenStats (tool, stats, allTools) {
  const rows = stats.tools || {};
  const keys = statsKeysFor(tool, allTools);
  const summary = { input: 0, output: 0, total: 0, calls: 0, lastUsed: null, lastDuration: null };
  for (const key of keys) {
    const row = rows[key];
    if (!row) continue;
    summary.input += row.input || 0;
    summary.output += row.output || 0;
    summary.total += row.total || 0;
    summary.calls += row.calls || 0;
    if (row.lastUsed && (!summary.lastUsed || row.lastUsed > summary.lastUsed)) {
      summary.lastUsed = row.lastUsed;
      summary.lastDuration = row.lastDuration || null;
    }
  }
  return summary;
}

function buildToolRoutingProfile (tool, allTools, tokenStats, now = Date.now()) {
  const keys = statsKeysFor(tool, allTools);
  const observations = store.getToolObservations(keys);
  const usage = aggregateTokenStats(tool, tokenStats, allTools);
  return buildRoutingProfile(tool, observations, usage, now);
}

function assignedClientId (name) {
  return TOOLS.some(t => t.name === name) ? `client-${name}` : name;
}

function aclClientKeys (id) {
  const keys = new Set([id]);
  if (id.startsWith('client-')) {
    const source = id.substring('client-'.length);
    if (TOOLS.some(t => t.name === source)) keys.add(source);
  } else {
    keys.add(assignedClientId(id));
  }
  return [...keys];
}

function clientState (info, now = Date.now()) {
  if (!info) return 'approved_offline';
  if (now - (info.lastSeen || info.registeredAt || 0) > CONFIG.CLIENT_TTL) return 'stale';
  if (!info.firstPollAt) return info.reconnectCount > 0 ? 'reconnecting' : 'connecting';
  return (info.pendingResolve || info._busy || info.taskPending) ? 'online_busy' : 'online_idle';
}

function clientView (id, info, approved = true) {
  const state = clientState(info);
  return {
    id,
    name: info?.name || id.replace(/^client-/, ''),
    canonicalId: decorateToolIdentity({ name: id, sourceId: info?.name || id, type: 'client' }).canonicalId,
    type: 'client',
    approved,
    state,
    online: state === 'online_idle' || state === 'online_busy',
    busy: state === 'online_busy',
    connectedAt: info?.connectedAt || null,
    registeredAt: info?.registeredAt ? new Date(info.registeredAt).toISOString() : null,
    firstPollAt: info?.firstPollAt ? new Date(info.firstPollAt).toISOString() : null,
    lastSeen: info?.lastSeen ? new Date(info.lastSeen).toISOString() : null,
    lastError: info?.lastError || null,
    disconnectReason: info?.disconnectReason || null,
    reconnectCount: info?.reconnectCount || 0,
    supportsSampling: info?.supportsSampling === true,
    supportsExec: info?.supportsExec === true,
    executionEligible: (state === 'online_idle' || state === 'online_busy') && info?.supportsSampling === true
  };
}

function onlineClientCount () {
  let count = 0;
  for (const info of connectedClients.values()) {
    const state = clientState(info);
    if (state === 'online_idle' || state === 'online_busy') count++;
  }
  return count;
}

function rememberClientDisconnect (id, info, reason, lastError = null) {
  clientTombstones.set(id, {
    name: info?.name || id.replace(/^client-/, ''),
    disconnectedAt: Date.now(),
    lastSeen: info?.lastSeen || null,
    lastError,
    disconnectReason: reason
  });
  if (clientTombstones.size > 100) clientTombstones.delete(clientTombstones.keys().next().value);
}

/** sampling 反向调用只透传 task 字符串,工作区路径靠拼进任务文本下发 */
function withWorkspaceBrief (task, workspacePath) {
  return `${task}\n\n## 工作区目录\n${workspacePath}\n请在该目录内完成文件读写任务,不要动其它目录。`;
}

/** 空产出:无正文且无代码块——CLI 静默失败(额度耗尽)与客户端空回复的共同特征 */
function isEmptyOutput (result) {
  return !(result.content || '').trim() && (result.codeBlocks || []).length === 0;
}

// 真实 CLI 失败文案通常很短或以 Error:/错误: 开头;长文报告只是"谈论"失败,不该判失败
const ERR_HEAD_RE = /^\s*(?:\x1b\[[0-9;]*m\s*)*(error|错误|fatal|exception|usage limit|insufficient|请求超时|无法连接)/i;
function looksLikeError (raw) {
  const t = (raw || '').trim();
  return t.length <= 400 || ERR_HEAD_RE.test(t);
}

function isToolFailed (result, error) {
  if (error) return { failed: true, reason: error.message || String(error), partialCode: '' };
  const text = (result.content || '').toLowerCase();
  // exit 0 但零产出是 CLI 静默失败(典型:额度耗尽)的特征,不能算成功
  if (!(result.content || '').trim() && (result.codeBlocks || []).length === 0) {
    return { failed: true, reason: '空产出(进程正常退出但无输出,疑似额度耗尽/静默失败)', partialCode: '' };
  }
  const failKeywords = ['insufficient balance', '额度', '限额', 'rate limit', 'quota', 'exceeded', 'unauthorized', '402', '429', '401'];
  // 关键词命中须再加 looksLikeError 前置:审计/复盘类长文会引用 429、server.js:398-401 等字样,
  // "谈论失败"不等于"失败",否则长文交付物会被误判销毁(#37 根因 1)。
  if (result.codeBlocks.length === 0 && looksLikeError(result.content) && failKeywords.some(k => text.includes(k))) {
    return { failed: true, reason: text.substring(0, 200), partialCode: '' };
  }
  if (result.codeBlocks.length > 0 && result.codeBlocks[0].code.length < 50 && looksLikeError(result.content) && failKeywords.some(k => text.includes(k))) {
    return { failed: true, reason: text.substring(0, 200), partialCode: result.codeBlocks[0].code };
  }
  return { failed: false };
}

// ── 核心逻辑 ──

async function executeTool (name, task, opts = {}) {
  const allTools = await getAllTools();
  const toolDef = resolveToolReference(name, allTools);
  if (!toolDef) throw new Error(`未知或有歧义的工具: ${name}`);
  const executionName = toolDef.name;

  const taskId = opts.taskId || `${executionName}_${Date.now()}`;
  const startTime = Date.now();

  // 客户端工作区任务会把目录简报拼进任务文本,流量记录记实际下发的载荷。
  // 简报是"只在工作区内动文件"的唯一文字护栏,对 CLI 与 exec 型客户端一视同仁;
  // T5 自报协议:仅 CLI 类型工具(type!=='client')追加用量自报后缀;
  // 连接的客户端豁免——MCP sampling 已上报真实用量,追加后缀会污染对话。
  const brief = opts.workspace ? withWorkspaceBrief(task, opts.workspace.path) : task;
  const outboundTask = toolDef.type === 'client'
    ? brief
    : brief + USAGE_REPORT_SUFFIX;

  // 流量保真:exec 准入预检——未声明 exec 的客户端在 "'out' 流量记录" 之前就被拒绝,
  // 否则会把"注入过工作区简报但从未发出"的文本假如实入流量。
  // executeClient 内保留同一校验,防直接调用路径绕过此处。
  if (toolDef.type === 'client' && opts.workspace) {
    const clientKey = toolDef.clientKey || executionName;
    const clientInfo = connectedClients.get(clientKey);
    if (clientInfo && !clientInfo.supportsExec) {
      throw new Error(`客户端 ${clientKey} 是推理型(sampling)子智能体,无法在工作区执行文件任务;workspace 任务请派给 CLI 工具,或去掉 workspace 参数`);
    }
  }

  // 流量记录:发出
  db.recordTraffic({
    ts: new Date().toISOString(),
    direction: 'out',
    tool: toolDef.id,
    taskId,
    type: toolDef.type || 'cli',
    content: outboundTask
  });

  let result;
  let execError = null;
  try {
    if (toolDef.type === 'client') {
      result = await executeClient(toolDef.clientKey || executionName, outboundTask, opts);
    } else {
      const tool = TOOLS.find(t => t.name === executionName);
      result = await tool.execute(outboundTask, {
        taskId,
        timeout: opts.timeout || tool.timeout || CONFIG.EXECUTE_TIMEOUT,
        workspaceDir: opts.workspace?.path,
        // 模型透传:opts.model 交由适配器校验/覆盖(仅声明 modelFlag 的工具生效);客户端通道不受影响
        model: opts.model
      });
    }
  } catch (e) {
    execError = e;
    log('warn', `executeTool 异常: tool=${toolDef.id} taskId=${taskId} error=${(e.message || String(e)).substring(0, 200)}`);
  }

  // 流量记录:返回
  if (execError) {
    db.recordTraffic({
      ts: new Date().toISOString(),
      direction: 'in',
      tool: toolDef.id,
      taskId,
      type: toolDef.type || 'cli',
      success: false,
      error: execError.message,
      content: ''
    });
    throw execError;
  }

  // T5 用量自报:CLI 结果末行 [USAGE] 剥离并转正式用量(优先于估算);client 豁免。
  // 无效自报(如超阈值)也要剥离标记行;无标记时 content 原样,usage 缺失走既有 estimate 路径。
  if (toolDef.type !== 'client') {
    const reported = parseUsageReport(result.content || '');
    if (reported.usage) {
      result.content = reported.content;
      result.usage = { input: reported.usage.input, output: reported.usage.output, reported: true };
    } else {
      result.content = reported.content;
    }
  }

  // 单一事实来源:入向流量的 success 由同一判定函数得出,与 dispatch 判定不再双账本背离(#37 根因 4)
  const verdict = isToolFailed(result, null);
  db.recordTraffic({
    ts: new Date().toISOString(),
    direction: 'in',
    tool: toolDef.id,
    taskId,
    type: toolDef.type || 'cli',
    success: !verdict.failed,
    duration: ((Date.now() - startTime) / 1000).toFixed(1) + 's',
    content: result.content || '',
    codeBlocks: (result.codeBlocks || []).map(b => ({ language: b.language, code: b.code })),
    usage: result.usage || null
  });

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  // 统一 token 统计:total 永远 = input + output
  const rawUsage = result.usage;
  const usage = rawUsage
    ? { input: rawUsage.input || 0, output: rawUsage.output || 0, total: (rawUsage.input || 0) + (rawUsage.output || 0), estimated: rawUsage.estimated || false, reported: rawUsage.reported || false }
    : { input: estimateTokens(task), output: estimateTokens(result.content), total: 0, estimated: true };
  usage.total = usage.input + usage.output;
  recordTokens(toolDef, usage, `${duration}s`);
  return { tool: executionName, toolId: toolDef.id, canonicalId: toolDef.canonicalId, displayName: toolDef.displayName, success: true, duration: `${duration}s`, codeBlocks: result.codeBlocks || [], content: result.content, tokens: usage };
}

/** 反向调用客户端(防并发:一个 client 同时只处理一个任务)
 * outboundTask:executeTool 一次组装好的出站任务文本(client 型按需已含目录简报,
 * 永不追加 CLI 专用的 [USAGE] 自报后缀),本函数不再二次组装——台账所记即实发。 */
async function executeClient (clientName, outboundTask, opts = {}) {
  const client = connectedClients.get(clientName);
  if (!client) throw new Error(`客户端未连接: ${clientName}`);
  if (!client.firstPollAt) throw new Error(`客户端尚未完成首次轮询: ${clientName}`);
  if (clientState(client) === 'stale') throw new Error(`客户端连接已过期: ${clientName}`);

  // 工作区任务准入(入队前判定,不占用 pendingTask 槽位):
  // sampling 反向调用只能拿宿主模型做文本补全,没有文件工具,派了也无法在工作区里干活——
  // 与其静默"成功"不如显式失败;仅客户端注册时声明 capabilities.exec=true 才放行
  // (目录简报已在 executeTool 组装 outboundTask 时拼好,sampling 载荷只透传 task 字符串)。
  // 此处校验与 executeTool 的前置守卫刻意双存:防直接调用路径绕过准入。
  if (opts.workspace && !client.supportsExec) {
    throw new Error(`客户端 ${clientName} 是推理型(sampling)子智能体,无法在工作区执行文件任务;workspace 任务请派给 CLI 工具,或去掉 workspace 参数`);
  }

  // check-then-act:先检查再设置待办槽位,其"不会被穿插"只来自单线程事件循环下检查与写入之间没有 await;跨 await 的并发正确性由 #55 端到端验收兜
  if (client.pendingResolve) {
    throw new Error(`客户端 ${clientName} 正在处理另一个任务,请稍后重试`);
  }

  // 立即标记为 busy,防止并发请求绕过检查
  client._busy = true;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const c = connectedClients.get(clientName);
      if (c) {
        c.pendingTask = null;
        c.pendingResolve = null;
        c.pendingReject = null;
        c._busy = false;
        c.taskPending = false;
      }
      METRICS.clientTimeouts++;
      reject(new Error(`客户端 ${clientName} 响应超时`));
    }, opts.timeout || CONFIG.EXECUTE_TIMEOUT);

    client.pendingTask = {
      task: outboundTask,
      taskId: opts.taskId || `${clientName}_${Date.now()}`,
      workspace: opts.workspace ? { id: opts.workspace.id, name: opts.workspace.name, path: opts.workspace.path } : null
    };
    client.pendingResolve = (result) => {
      clearTimeout(timeout);
      const current = connectedClients.get(clientName);
      if (current) current._busy = false;
      resolve(result);
    };
    client.pendingReject = (err) => {
      clearTimeout(timeout);
      const current = connectedClients.get(clientName);
      if (current) current._busy = false;
      reject(err);
    };
  });
}

// #36:skipped 的归因文案。只返回字符串,不参与 no_targets 归因块(:812-847)的判定结构
// (那块内的 named 与「点名目标:」模板原样保留)。文案与 #50 归因块的同名字面严格一致,不另造同义词。
function skippedTargetReason (ref, availableTools) {
  const tool = resolveToolReference(ref, availableTools);
  // 可解析且处于禁用态:skipped 今天的唯一定义性来源(与 #50 归因块内同名分支同字面)
  if (tool && !isToolEnabled(tool)) return '已被开关禁用';
  // 归因瞬间已不满足上述条件(开关/集合并发翻转):只说不宣称能力的事实,复用 #50 同名字面
  return '状态在并发中变化(选中后可调度集合已改变)';
}

async function doDispatch (task, toolNames, autoFallback = true, context = '', withReview = false, reviewerPref = null, workspaceRef = null, fallbackScope = 'auto', modelOverride = null) {
  // 入参校验
  if (!task || typeof task !== 'string') return { error: '缺少 task 参数', code: 'invalid_request' };
  if (task.length > CONFIG.MAX_TASK_LENGTH) return { error: `任务描述过长(>${CONFIG.MAX_TASK_LENGTH}字符)`, code: 'invalid_request' };
  // tools 入参硬化:非数组一律视为未指定(回退全量可用工具),防畸形入参 crash
  if (toolNames != null && !Array.isArray(toolNames)) toolNames = null;
  // fallback_scope 归一化:非 'all'/'none' 的一切值(含 undefined/非法值)按 'auto'
  fallbackScope = ['all', 'none'].includes(fallbackScope) ? fallbackScope : 'auto';
  // model 透传归一化:非空字符串才生效,其余(undefined/空串/非字符串)视为未指定
  modelOverride = (typeof modelOverride === 'string' && modelOverride.trim()) ? modelOverride : null;

  // 工作区前置校验:不存在/已归档/目录缺失直接返回明确错误,不占用并发额度
  let workspace = null;
  if (workspaceRef != null && String(workspaceRef).trim() !== '') {
    try {
      workspace = workspaceManager.resolveForDispatch(workspaceRef);
    } catch (e) {
      return { error: e.message, code: 'workspace_error' };
    }
  }

  // 上下文注入:若有 context 则前置到任务(修复 HTTP 链路静默丢弃上下文的问题)
  const effectiveTask = (context && typeof context === 'string' && context.trim())
    ? `## 上下文\n${context}\n\n## 任务\n${task}`
    : task;

  // 并发限制
  if (activeDispatchCount >= CONFIG.MAX_CONCURRENT_DISPATCH) {
    return { error: `并发数已达上限(${CONFIG.MAX_CONCURRENT_DISPATCH}),请稍后重试`, code: 'too_many' };
  }
  activeDispatchCount++;
  const dispatchId = `dispatch_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const dispatchStart = Date.now();
  METRICS.dispatchTotal++;
  activeDispatches.add(dispatchId);
  let workspaceLease = null;

  try {
    // 占用工作区(独占模式可阻止两个 dispatch 同时写同一目录)
    if (workspace) {
      try {
        workspaceLease = workspaceManager.beginRun(workspace.id, dispatchId);
      } catch (e) {
        return { error: e.message, code: 'workspace_busy' };
      }
    }
    const allTools = await getAllTools();
    const availableTools = allTools.filter(t => t.available);
    // 带 workspace 时,默认路由/接力候选排除声明不了 exec 的客户端(手动点名仍放行,由 executeClient 给出明确拒绝原因)
    const dispatchableTools = workspace
      ? availableTools.filter(t => t.type !== 'client' || t.supportsExec)
      : availableTools;
    const availableNames = availableTools.map(t => t.name);
    // 智能路由:未指定 tools 时按真实历史构建可解释综合评分；失败仍有接力链兜底。
    let routing = { mode: 'manual' };
    let coolingToolIds = new Set();
    let targets;
    if (toolNames && toolNames.length > 0) {
      targets = toolNames
        .map(ref => resolveToolReference(ref, availableTools))
        .filter(Boolean)
        .filter(t => isToolEnabled(t))
        .map(t => t.name);
    } else {
      const enabledTools = dispatchableTools.filter(t => isToolEnabled(t));
      const tokenStats = loadJSON(STATS_FILE);
      const profiles = enabledTools.map(t => buildToolRoutingProfile(t, allTools, tokenStats));
      const ranking = rankRoutingProfiles(profiles, task).map(row => ({
        tool: row.tool,
        toolId: row.toolId,
        canonicalId: row.canonicalId,
        category: row.category,
        score: row.score,
        calls: row.calls,
        successes: row.successes,
        averageDurationMs: row.averageDurationMs,
        averageTokens: row.averageTokens,
        lastObservedAt: row.lastObservedAt,
        lastSuccessAt: row.lastSuccessAt,
        lastFailureAt: row.lastFailureAt,
        coolingDown: row.coolingDown,
        cooldownUntil: row.cooldownUntil,
        components: row.components,
        explorationBonus: row.explorationBonus,
        reason: row.reason
      }));
      coolingToolIds = new Set(ranking.filter(row => row.coolingDown).map(row => row.toolId));
      const selectable = ranking.filter(row => !row.coolingDown);
      targets = selectable.length > 0 ? [selectable[0].tool] : [];
      routing = {
        mode: 'auto',
        strategy: 'composite-v1',
        taskCategory: classifyTask(task),
        selected: targets[0] || null,
        selectedId: selectable[0]?.toolId || null,
        selectedReason: selectable[0]?.reason || null,
        ranking
      };
    }
    targets = [...new Set(targets)];
    // #36:被跳过者必须带原因(裸名字数组只告诉宿主"没跑",不告诉"为什么没跑")。
    // 入选条件与升级前逐字一致(可解析 && 已禁用),只把形状从 ref 换成 { ref, reason }。
    const skipped = (toolNames || []).filter(ref => {
      const tool = resolveToolReference(ref, availableTools);
      return tool && !isToolEnabled(tool);
    }).map(ref => ({ ref, reason: skippedTargetReason(ref, availableTools) }));
    // #36:点名请求数。未点名(自动路由,含 tools 传空数组/非数组被硬化为 null)时取 targets.length,
    // 绝不输出 requested:0 这种比现状更误导的值。total 的语义与取值一律不动(仍 = targets.length)。
    const requested = (Array.isArray(toolNames) && toolNames.length > 0) ? toolNames.length : targets.length;

    if (targets.length === 0) {
      // F3/#50a4:归因分"点名派发/自动路由"两条路径,先判有没有点名再下结论,防单模板把两类真因混成一句谎话
      const named = Array.isArray(toolNames) && toolNames.length > 0;
      let summary;
      if (named) {
        // 点名派发:逐 ref 给出具体落选原因。能力/资格结论只能取自 connectedClients 的 live 对象——
        // 能 resolve 到 availableTools 的客户端必是 getAllTools(server.js:379)过了 supportsSampling 门才进来的,
        // 对它宣称 sampling 缺失只会反向撒谎(仅在开关并发翻转时可达),故已解析已启用者只如实报"并发漂移"
        const why = toolNames.map(ref => {
          const tool = resolveToolReference(ref, availableTools);
          if (!tool) {
            const live = connectedClients.get(ref) || connectedClients.get(assignedClientId(ref));
            if (live) {
              if (!live.firstPollAt) return `${ref}: 客户端尚未完成首次轮询,暂不可调度`;
              if (live.supportsSampling !== true) return `${ref}: 客户端未声明 sampling 能力,无执行资格(宿主需在 MCP initialize 中声明 capabilities.sampling)`;
              if (clientState(live) === 'stale') return `${ref}: 客户端连接已过期(stale)`;
              // 已完成首 poll、已声明 sampling、未过期却不在可调度集合:同属并发漂移,如实报,不谎称过期
              return `${ref}: 状态在并发中变化(选中后可调度集合已改变)`;
            }
            return `${ref}: 未知工具`;
          }
          if (!isToolEnabled(tool)) return `${ref}: 已被开关禁用`;
          // 解析到且已启用却仍落选:正常单线程不可达(有它 targets 就非空),仅并发翻转可达;
          // 真因只能是"选中后可调度集合已改变",此处绝不宣称能力缺失
          return `${ref}: 状态在并发中变化(选中后可调度集合已改变)`;
        });
        summary = `点名目标: ${why.join('; ')}`;
      } else {
        // 自动路由(根本没点名):不得套"点名目标"模板;exec 解释须以 workspace 为条件,
        // 因为 dispatchableTools(server.js:756-758)只在带 workspace 时才把声明不了 exec 的客户端排除出候选
        summary = workspace
          ? '自动路由未点名工具,且 workspace 任务需要 exec 能力,当前没有具备 exec 的可调度目标'
          : '自动路由未点名工具,当前没有可调度目标(可能全部被开关禁用或处于失败冷却)';
      }
      return { error: `没有选中可执行的目标。${summary}。当前可调度工具: ${availableNames.join(', ') || '无'}`, code: 'no_targets' };
    }

    const rawResults = await Promise.allSettled(
      targets.map(async (name) => {
        try {
          const result = await executeTool(name, effectiveTask, { workspace, model: modelOverride });
          const check = isToolFailed(result, null);
          if (check.failed) {
            log('warn', `dispatch 判定工具失败: tool=${name} reason=${String(check.reason || '').substring(0, 200)}`);
            return { tool: name, failed: true, reason: check.reason, partialCode: check.partialCode, result };
          }
          return { tool: name, failed: false, result };
        } catch (e) {
          return { tool: name, failed: true, reason: e.message, partialCode: '' };
        }
      })
    );

    const fallbackLog = [];
    const usedFallback = new Set(); // 防止同一个接力工具被多个失败目标重复占用
    if (autoFallback && fallbackScope !== 'none') {
      // 接力作用域:'auto'+显式白名单时,接力候选仅限白名单内(白名单意图优先,防越权烧配额);
      // 'all' 或未指定 tools(自动路由)时维持现有全池行为
      const explicitWhitelist = (toolNames || []).length > 0;
      const scopeAll = fallbackScope === 'all' || !explicitWhitelist;
      const scopePool = scopeAll ? dispatchableTools : dispatchableTools.filter(t => targets.includes(t.name));
      for (let i = 0; i < rawResults.length; i++) {
        const r = rawResults[i];
        if (r.status !== 'fulfilled' || !r.value.failed) continue;
        const failed = r.value;
        const others = targets.filter(n => n !== failed.tool);
        const okFallback = others.find(n => { const idx = targets.indexOf(n); const rr = rawResults[idx]; return rr.status === 'fulfilled' && !rr.value.failed; });
        if (okFallback) {
          fallbackLog.push({ from: failed.tool, to: okFallback, success: true, skipped: '已有成功结果,无需接力' });
          continue;
        }
        // 接力链:依次尝试所有未用过的可用工具,直到有一个真正成功(而非只试第一个)
        const untried = scopePool.filter(t => !targets.includes(t.name) && isToolEnabled(t) && !usedFallback.has(t.name) && !coolingToolIds.has(t.id)).map(t => t.name);
        if (!scopeAll && untried.length === 0) {
          // 白名单目标均已尝试过,接力被作用域抑制 → 留痕,不静默烧白名单外配额
          fallbackLog.push({ from: failed.tool, suppressed: true, skipped: 'fallback_scope=auto 时接力仅限显式白名单内(白名单候选已用尽)' });
        }
        const handoffPrompt = `以下是之前另一个 AI 工具写到一半的代码(工具突然限额/断开),请在此基础上继续完成。\n\n## 任务\n${effectiveTask}\n\n## 已有代码(可能不完整)\n\`\`\`\n${failed.partialCode || '(无可用代码,请从头开始)'}\n\`\`\`\n\n请输出完整的最终代码。`;
        for (const fb of untried) {
          usedFallback.add(fb);
          METRICS.fallbackTotal++;
          try {
            const fbResult = await executeTool(fb, handoffPrompt, { workspace, model: modelOverride });
            // 接力结果二次校验:接力工具本身也可能限额/断连,别把失败回复当成功
            const fbCheck = isToolFailed(fbResult, null);
            if (fbCheck.failed) { log('warn', `接力工具仍失败: from=${failed.tool} to=${fb} reason=${String(fbCheck.reason || '').substring(0, 200)}`); fallbackLog.push({ from: failed.tool, to: fb, success: false, reason: fbCheck.reason }); continue; }
            fallbackLog.push({ from: failed.tool, to: fb, success: true, duration: fbResult.duration });
            rawResults[i] = { status: 'fulfilled', value: { tool: fb, failed: false, result: fbResult, fallback: true, fallbackFrom: failed.tool, fallbackTo: fb } };
            METRICS.fallbackSuccess++;
            break;
          } catch (e2) {
            fallbackLog.push({ from: failed.tool, to: fb, success: false, error: e2.message });
          }
        }
      }
    }

    const results = [];
    let successCount = 0, totalTokens = 0;
    for (let i = 0; i < rawResults.length; i++) {
      const r = rawResults[i];
      const name = targets[i];
      if (r.status === 'fulfilled' && !r.value.failed) {
        successCount++;
        const res = r.value.result;
        totalTokens += res.tokens.total || 0;
        results.push({ tool: r.value.tool || name, toolId: res.toolId, canonicalId: res.canonicalId, displayName: res.displayName, success: true, duration: res.duration, codeBlocks: res.codeBlocks, content: res.content.substring(0, CONFIG.RESULT_MAX_CHARS), tokens: res.tokens, fallback: r.value.fallback || false, fallbackFrom: r.value.fallbackFrom, fallbackTo: r.value.fallbackTo });
      } else if (r.status === 'fulfilled' && r.value.failed) {
        const failedTool = resolveToolReference(name, availableTools);
        // 失败不销毁交付物:异常分支(:816 那种)没有 result,保持只带 reason
        const fr = r.value.result || null;
        results.push({ tool: name, toolId: failedTool?.id || null, canonicalId: failedTool?.canonicalId || null, success: false, reason: r.value.reason,
          ...(fr ? { content: (fr.content || '').substring(0, CONFIG.RESULT_MAX_CHARS), codeBlocks: fr.codeBlocks || [], duration: fr.duration, tokens: fr.tokens || null } : {}) });
      } else {
        const failedTool = resolveToolReference(name, availableTools);
        results.push({ tool: name, toolId: failedTool?.id || null, canonicalId: failedTool?.canonicalId || null, success: false, reason: r.reason?.message });
      }
    }

    // 交叉评审闭环:产出后自动派另一工具评审(评审者必须不同于生产者,失败不阻断主结果)
    let review = null;
    if (withReview) {
      if (successCount === 0) {
        review = { skipped: true, reason: '无成功产出,无可评审内容' };
      } else {
        const producer = results.find(r => r.success);
        const tokenStats = loadJSON(STATS_FILE);
        const reviewerProfiles = availableTools
          .filter(t => isToolEnabled(t) && t.name !== producer.tool)
          .map(t => buildToolRoutingProfile(t, allTools, tokenStats));
        const candidates = rankRoutingProfiles(reviewerProfiles, '代码审查 review audit')
          .map(t => t.tool);
        const preferredReviewer = reviewerPref ? resolveToolReference(reviewerPref, availableTools)?.name : null;
        const reviewer = (preferredReviewer && candidates.includes(preferredReviewer)) ? preferredReviewer : candidates[0];
        if (!reviewer) {
          review = { skipped: true, reason: '没有可用的独立评审工具(评审者须不同于生产者)' };
        } else {
          try {
            const code = producer.codeBlocks?.[0]?.code || producer.content || '';
            const rvResult = await executeTool(reviewer, `你是代码评审专家。请评审以下由 ${producer.tool} 生成的代码,指出潜在问题与改进建议,简洁列点。\n\n## 原任务\n${task.substring(0, 2000)}\n\n## 产出代码\n\`\`\`\n${code.substring(0, 4000)}\n\`\`\``, { taskId: `review_${dispatchId}`, workspace });
            totalTokens += rvResult.tokens.total || 0; // 空产出同样消耗了 token,照常累加
            if (isEmptyOutput(rvResult)) {
              // 空产出评审者不得记成"评审成功但没内容"
              log('warn', `评审空产出判失败: reviewer=${reviewer} producer=${producer.tool} dispatchId=${dispatchId}`);
              review = { reviewer, producer: producer.tool, skipped: true, reason: '评审空产出(无输出,视为评审失败)' };
            } else {
              review = { reviewer, producer: producer.tool, content: rvResult.content.substring(0, 2000), tokens: rvResult.tokens.total || 0 };
            }
          } catch (e) {
            review = { skipped: true, reviewer, reason: `评审执行失败: ${e.message}` };
          }
        }
      }
      db.recordReview({ id: `review_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`, dispatchId, producer: review.producer || null, reviewer: review.reviewer || null, skipped: !!review.skipped, reason: review.reason || null, content: review.content || '', tokens: review.tokens || 0 });
    }

    // 记录任务到记忆 + 日志 + 全局库写穿
    const elapsedMs = Date.now() - dispatchStart;
    const workspaceInfo = workspace ? { id: workspace.id, name: workspace.name, path: workspace.path } : null;
    const taskRecord = { id: `task_${Date.now()}`, dispatchId, results, successCount, requested, total: targets.length, totalTokens, fallbackLog, skipped, task: task.substring(0, 200), tools: targets, routing, workspace: workspaceInfo };
    store.recordTask(taskRecord);
    db.recordDispatch({ ...taskRecord, elapsedMs });
    if (successCount > 0) METRICS.dispatchSuccess++; else METRICS.dispatchFail++;
    log('info', `dispatch 完成: ${successCount}/${targets.length} 成功, ${totalTokens} tokens`, { dispatchId, tools: targets, successCount, totalTokens, elapsedMs });
    return { dispatchId, results, successCount, requested, total: targets.length, totalTokens, elapsedMs, fallbackLog, skipped, routing, workspace: workspaceInfo, ...(review ? { review } : {}) };
  } finally {
    if (workspaceLease) workspaceManager.endRun(workspace.id, workspaceLease.runId);
    activeDispatches.delete(dispatchId);
    activeDispatchCount--;
  }
}

async function doHandoff (task, existingCode, fromTool, toTool, workspaceRef = null) {
  if (!task) return { error: '缺少 task' };
  if (!existingCode) return { error: '缺少 existing_code' };
  if (!toTool) return { error: '缺少 to' };

  const allTools = await getAllTools();
  const target = resolveToolReference(toTool, allTools);
  if (!target) return { error: `未知或有歧义的工具: ${toTool}` };
  if (!target.available) return { error: `${target.displayName} 不可用` };
  if (!isToolEnabled(target)) return { error: `${target.displayName} 开关已关闭` };

  let workspace = null;
  if (workspaceRef != null && String(workspaceRef).trim() !== '') {
    try {
      workspace = workspaceManager.resolveForDispatch(workspaceRef);
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
  let lease = null;
  if (workspace) {
    try {
      lease = workspaceManager.beginRun(workspace.id, `handoff_${Date.now()}`);
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  const handoffPrompt = `以下是之前另一个 AI 工具写到一半的代码,请在此基础上继续完成。\n\n## 还需要完成的任务\n${task}\n\n## 已有代码\n\`\`\`\n${existingCode}\n\`\`\`\n\n请基于已有代码继续完成,输出完整的最终代码。`;
  try {
    const result = await executeTool(target.name, handoffPrompt, { workspace });
    if (isEmptyOutput(result)) {
      // 接力空产出(疑似额度耗尽的静默失败)必须显式失败,不得返回假成功
      log('warn', `handoff 空产出: tool=${target.name} from=${fromTool || 'unknown'}`);
      return { success: false, error: '空产出(工具正常退出但无输出,疑似额度耗尽)' };
    }
    return { success: true, tool: target.name, toolId: target.id, canonicalId: target.canonicalId, displayName: target.displayName, duration: result.duration, codeBlocks: result.codeBlocks, content: result.content, tokens: result.tokens, from: fromTool || 'unknown', workspace: workspace ? { id: workspace.id, name: workspace.name, path: workspace.path } : null };
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    if (lease) workspaceManager.endRun(workspace.id, lease.runId);
  }
}

// ── HTTP 路由(带全局 try/catch + 鉴权 + CORS 限制) ──

function checkAuth (req) {
  if (!CONFIG.AUTH_TOKEN) return true;
  const auth = req.headers['authorization'];
  return auth === `Bearer ${CONFIG.AUTH_TOKEN}`;
}

function sendJSON (res, code, data) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  // CORS 只允许本地,不再通配
  if (CONFIG.CORS_ORIGIN) headers['Access-Control-Allow-Origin'] = CONFIG.CORS_ORIGIN;
  else headers['Access-Control-Allow-Origin'] = 'http://127.0.0.1:' + CONFIG.PORT;
  res.writeHead(code, headers);
  res.end(JSON.stringify(data));
}

function sendWorkspaceError (res, e) {
  const code = Number.isInteger(e?.statusCode) ? e.statusCode : 500;
  if (code >= 500) log('error', `工作区操作失败: ${e?.message || e}`);
  sendJSON(res, code, { error: e?.message || '工作区操作失败' });
}

function readBody (req, cap = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', c => {
      body += c; size += c.length;
      if (size > cap) { reject(new Error('请求体过大')); req.destroy(); return; }
    });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (_) { resolve({}); } });
    req.on('error', reject);
  });
}

// ── 透传代理(全局观测层):/proxy/<source>/<key>/<上游路径> ──
const PROXY_TIMEOUT = parseInt(process.env.AI_BRIDGE_PROXY_TIMEOUT) || 600000;
const PROXY_MAX_BODY = 20 * 1024 * 1024; // LLM 长上下文请求体可达数 MB,独立于 readBody 的 1MB 上限

function readRawBody (req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > cap) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 从响应文本尽力提取用量(OpenAI prompt/completion_tokens 与 Anthropic input/output_tokens 两种风格;SSE 取末次出现值)
function extractUsage (text) {
  if (!text) return null;
  const grab = (re) => { let m; let last = null; while ((m = re.exec(text))) last = parseInt(m[1]); return last; };
  const input = grab(/"prompt_tokens"\s*:\s*(\d+)/g) ?? grab(/"input_tokens"\s*:\s*(\d+)/g);
  const output = grab(/"completion_tokens"\s*:\s*(\d+)/g) ?? grab(/"output_tokens"\s*:\s*(\d+)/g);
  if (input === null && output === null) return null;
  return { input: input || 0, output: output || 0 };
}

async function handleProxy (req, res, p, search) {
  const parts = p.split('/').filter(Boolean); // ['proxy', source, key, ...rest]
  if (parts.length < 3) { sendJSON(res, 400, { error: '路径格式: /proxy/<source>/<key>/<上游路径>' }); return; }
  const source = parts[1];
  const key = parts[2];
  const route = observe.getRoute(source, key);
  if (!route) { sendJSON(res, 404, { error: `未登记的代理路由: ${source}/${key}` }); return; }
  const started = Date.now();
  let body;
  try { body = await readRawBody(req, PROXY_MAX_BODY); } catch (e) { sendJSON(res, 413, { error: e.message }); return; }
  // 只提取模型名用于观测,绝不落盘请求正文/鉴权头
  let model = null;
  try { if (body.length && body.length < 2 * 1024 * 1024) model = JSON.parse(body.toString('utf-8')).model || null; } catch (_) {}
  const restPath = parts.length > 3 ? '/' + parts.slice(3).join('/') : '';
  let upstreamUrl;
  try { upstreamUrl = new URL(route.upstream + restPath + (search || '')); } catch (e) { sendJSON(res, 502, { error: '上游 URL 非法: ' + e.message }); return; }
  const mod = upstreamUrl.protocol === 'https:' ? https : http;
  const headers = { ...req.headers };
  delete headers.host; delete headers.connection; delete headers['content-length'];
  headers['accept-encoding'] = 'identity'; // 禁压缩,便于解析用量;鉴权头原样透传(密钥始终留在客户端一侧)
  if (body.length) headers['content-length'] = body.length;
  const upReq = mod.request(upstreamUrl, { method: req.method, headers, timeout: PROXY_TIMEOUT }, upRes => {
    res.writeHead(upRes.statusCode, upRes.headers);
    let captured = ''; // 仅缓存前 256KB 文本供用量解析,流式内容原样直通
    upRes.on('data', c => { if (captured.length < 256 * 1024) captured += c.toString('utf-8'); res.write(c); });
    upRes.on('end', () => {
      res.end();
      const usage = extractUsage(captured);
      db.recordEvent({
        source, channel: 'proxy', type: 'llm_request', model,
        inputTokens: usage?.input || 0, outputTokens: usage?.output || 0,
        durationMs: Date.now() - started, success: upRes.statusCode < 400,
        detail: `${req.method} ${restPath || '/'} → ${upRes.statusCode}`
      });
    });
  });
  upReq.on('timeout', () => upReq.destroy(new Error('上游超时')));
  upReq.on('error', e => {
    db.recordEvent({
      source, channel: 'proxy', type: 'llm_request', model,
      durationMs: Date.now() - started, success: false,
      detail: ('上游错误: ' + e.message).substring(0, 200)
    });
    if (!res.headersSent) sendJSON(res, 502, { error: '上游请求失败: ' + e.message });
    else res.end();
  });
  if (body.length) upReq.write(body);
  upReq.end();
}

// /api/dispatch 早期错误 code → HTTP 状态码映射(工具级失败不在此列,仍走 200 结果体)
const DISPATCH_ERROR_HTTP = { invalid_request: 400, workspace_error: 400, workspace_busy: 409, no_targets: 409, too_many: 429 };

// ── 模型枚举(/api/discover-models)结果缓存:工具名 → { ts, models },60 秒 TTL,命中不再 spawn ──
const discoverModelCache = new Map();
const DISCOVER_MODEL_TTL = 60000;
const DISCOVER_MODEL_TIMEOUT = 15000;

const server = http.createServer(async (req, res) => {
  // 全局错误处理:任何未捕获异常不会崩溃服务
  try {
    if (isShuttingDown) { sendJSON(res, 503, { error: '服务正在关闭' }); return; }

    const url = new URL(req.url, `http://${CONFIG.HOST}:${CONFIG.PORT}`);
    const p = url.pathname;

    // CORS preflight(限制来源)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': CONFIG.CORS_ORIGIN || `http://127.0.0.1:${CONFIG.PORT}`,
        'Access-Control-Allow-Methods': 'GET,POST,DELETE',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      });
      res.end();
      return;
    }

    // 健康检查:免鉴权面只给"存活 + 负载计数",详细面(codely 到期情报 / usage 用量)须凭据在先。
    //   仍留在鉴权门(本文件下方 /api/ + /v1/ 那道门)之前 —— 外部监控要能不被 401 挡住才能判活(整体搬到门后会把
    //   "需要凭据"误报成"宕机",风险大于收益)。但门前提前不等于无密可守:#68 按鉴权态给两种视图。
    if (p === '/api/health' && req.method === 'GET') {
      // checkAuth 未设 AI_BRIDGE_TOKEN 时恒 true → 自用实例拿到的仍是完整视图(零负担)
      const authorized = checkAuth(req);
      const tokenDays = codelyTokenExpiryDays();
      if (tokenDays !== null && tokenDays <= 7) {
        log('warn', `Codely access_token 将在 ${tokenDays} 天后过期,请尽快打开 Codely CLI 重新登录(微信登录无 refresh_token,无法自动刷新)`);
      }
      const payload = {
        status: isShuttingDown ? 'shutting_down' : 'ok',
        uptime: Math.floor((Date.now() - START_TIME) / 1000),
        port: CONFIG.PORT,
        clients: onlineClientCount(),
        activeDispatches: activeDispatchCount,
        dispatchTotal: METRICS.dispatchTotal,
        version: '1.1'
      };
      if (authorized) {
        const dailyBudget = parseInt(process.env.AI_BRIDGE_DAILY_TOKEN_BUDGET) || 0;
        const today = db.todayTokens();
        payload.codely = {
          cliVersion: codelyCliVersion(),
          tokenDaysLeft: tokenDays,
          tokenWarning: tokenDays !== null && tokenDays <= 7 ? `access_token 剩 ${tokenDays} 天,请打开 Codely CLI 重新登录` : null
        };
        payload.usage = dailyBudget > 0 ? { todayTokens: today, dailyBudget, warning: today >= dailyBudget } : { todayTokens: today };
      }
      // ?probe=1:带签名探测 LiteLLM 上游真实连通性。
      //   这一分支会 await getCodelyCliApiKey() 并 requestCodelyLiteLLM() —— 每一次调用都驱使
      //   中枢带着**真实签名**去打上游,免鉴权时就是免费的探测/放大器(还有成本)。
      //   故:先判权再探测,未鉴权一律 401 且**绝不发起任何上游请求**(顺序不可颠倒)。
      if (url.searchParams.get('probe') === '1') {
        if (!authorized) {
          sendJSON(res, 401, { error: '未授权' });
          return;
        }
        const t0 = Date.now();
        try {
          const cliKey = await getCodelyCliApiKey();
          const upRes = await requestCodelyLiteLLM('/v1/models', { method: 'GET', cliKey, timeout: 10000 });
          let rd = '';
          upRes.on('data', d => rd += d);
          await new Promise((resolve, reject) => { upRes.on('end', resolve); upRes.on('error', reject); });
          let modelCount = null;
          try { modelCount = (JSON.parse(rd).data || []).length; } catch (_) {}
          payload.upstream = { ok: upRes.statusCode === 200, status: upRes.statusCode, latencyMs: Date.now() - t0, models: modelCount };
        } catch (e) {
          payload.upstream = { ok: false, error: String(e.message || e).substring(0, 200), latencyMs: Date.now() - t0 };
        }
      }
      sendJSON(res, 200, payload);
      return;
    }

    // 透传代理(免鉴权:被接管工具不感知中枢存在;仅监听本地回环,风险受控)
    if (p.startsWith('/proxy/')) {
      await handleProxy(req, res, p, url.search);
      return;
    }

    // 鉴权:API 端点 + /v1 反代面需要 Token(如果配置了)
    // /v1 不是"只读展示面":GET /v1/models 会枚举模型/工具全清单,POST /v1/chat/completions 的
    // model=<工具名> 分支直接 executeTool(烧真实配额) —— 能泄露、能执行、能花钱的入口一律要凭据。
    // 401 形状复用同一处 sendJSON,外部调用方(反代/桥)看到的错误体与 /api/ 完全一致,不得新造。
    if ((p.startsWith('/api/') || p.startsWith('/v1/')) && !checkAuth(req)) {
      sendJSON(res, 401, { error: '未授权' });
      return;
    }

    // Web UI(不需要鉴权,但只允许本地访问)
    if (p === '/' && req.method === 'GET') {
      const html = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (p === '/api/tools' && req.method === 'GET') {
      const allTools = await getAllTools();
      const sw = loadJSON(SWITCHES_FILE);
      const stats = loadJSON(STATS_FILE);
      const tools = allTools.map(t => {
        const usage = aggregateTokenStats(t, stats, allTools);
        return {
          name: t.name, id: t.id, canonicalId: t.canonicalId, sourceId: t.sourceId,
          aliases: t.aliases, displayName: t.displayName, description: t.description,
          available: t.available, enabled: isToolEnabled(t, sw),
          type: t.type || 'cli',
          tokens: usage.total, calls: usage.calls,
          lastUsed: usage.lastUsed, lastDuration: usage.lastDuration
        };
      });
      const total = stats.total || { input: 0, output: 0, total: 0, calls: 0 };
      // #80 registry:把注册表载入归因原样带出(status/file/entryCount),
      //   使派发失败时能定位到实际使用的配置源;字段必须来自 getLoadDiagnostics 单一写手,
      //   不得在此另行拼装(那是 #74 的"第二写手"反模式)。
      sendJSON(res, 200, { tools, total, registry: getLoadDiagnostics() });
      return;
    }

    // ── 模型发现:GET /api/discover-models?tool=<name>(命令串完全来自本地 tools.json 配置,不拼接任何请求内容,无注入面) ──
    if (p === '/api/discover-models' && req.method === 'GET') {
      const toolRef = String(url.searchParams.get('tool') || '').trim();
      const allTools = await getAllTools();
      const t = toolRef ? resolveToolReference(toolRef, allTools) : null;
      if (!t) { sendJSON(res, 400, { error: `未知工具: ${toolRef || '(空)'}` }); return; }
      const adapter = TOOLS.find(x => x.name === t.name);
      const listCmd = adapter && adapter.config && adapter.config.modelListCmd;
      if (!listCmd || typeof listCmd.command !== 'string' || !listCmd.command.trim()) {
        sendJSON(res, 400, { error: `工具 ${t.name} 不支持模型枚举(未声明 modelListCmd)` });
        return;
      }
      const cached = discoverModelCache.get(t.name);
      if (cached && Date.now() - cached.ts < DISCOVER_MODEL_TTL) {
        sendJSON(res, 200, { tool: t.name, models: cached.models, ts: cached.ts });
        return;
      }
      try {
        // 复用 cli-adapter 的无 shell 安全 spawn(Windows .cmd 走 cmd.exe /c,不走 shell:true)
        const stdout = await runCommand(listCmd.command.trim(), Array.isArray(listCmd.args) ? listCmd.args.map(String) : [], { timeout: DISCOVER_MODEL_TIMEOUT, cwd: __dirname });
        const models = String(stdout).split(/\r?\n/).map(s => s.trim()).filter(s => s !== '' && !s.startsWith('<'));
        const entry = { ts: Date.now(), models };
        discoverModelCache.set(t.name, entry);
        sendJSON(res, 200, { tool: t.name, models, ts: entry.ts });
      } catch (e) {
        sendJSON(res, 503, { error: `模型枚举失败: ${String(e.message || e).substring(0, 200)}` });
      }
      return;
    }

    if (p === '/api/toggle' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.tool) { sendJSON(res, 400, { error: '缺少 tool 参数' }); return; }
      const allTools = await getAllTools();
      const tool = resolveToolReference(body.tool, allTools);
      if (!tool) { sendJSON(res, 404, { error: `未知或有歧义的工具: ${body.tool}` }); return; }
      const sw = loadJSON(SWITCHES_FILE);
      sw[tool.id] = !!body.enabled;
      let saved;
      try { saved = saveJSONSync(SWITCHES_FILE, sw); } catch (_) { saved = false; }
      refreshToolStatus();
      if (saved === false) {
        sendJSON(res, 503, { error: '开关状态未能持久化（switches.json 处于隔离或写入故障状态）', persisted: false, runtimeOnly: true, tool: tool.name, toolId: tool.id, enabled: !!body.enabled });
        return;
      }
      sendJSON(res, 200, { success: true, tool: tool.name, toolId: tool.id, canonicalId: tool.canonicalId, enabled: !!body.enabled });
      return;
    }

    // ── 工作区管理(dispatch/handoff 的 CLI 执行目录) ──
    if (p === '/api/workspaces' && req.method === 'GET') {
      sendJSON(res, 200, { workspaces: workspaceManager.list(), stats: workspaceManager.summary() });
      return;
    }

    if (p === '/api/workspaces' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const ws = workspaceManager.create({
          name: body.name,
          path: body.path,
          description: body.description,
          exclusive: body.exclusive === true
        });
        log('info', `工作区已创建: ${ws.name} (${ws.mode}) ${ws.path}`);
        sendJSON(res, 201, ws);
      } catch (e) {
        sendWorkspaceError(res, e);
      }
      return;
    }

    if (p.startsWith('/api/workspaces/')) {
      const segs = p.slice('/api/workspaces/'.length).split('/').filter(Boolean);
      let id = '';
      try { id = decodeURIComponent(segs[0] || ''); } catch (_) { /* 非法编码按空 ID 处理 */ }
      const action = segs[1] || '';
      if (!id || segs.length > 2) { sendJSON(res, 404, { error: 'Not found' }); return; }

      if (!action && req.method === 'GET') {
        const ws = workspaceManager.get(id);
        if (!ws) sendJSON(res, 404, { error: `工作区不存在: ${id}` });
        else sendJSON(res, 200, ws);
        return;
      }

      if (!action && req.method === 'DELETE') {
        const flag = url.searchParams.get('delete_files');
        const deleteFiles = flag === '1' || flag === 'true' || flag === 'yes';
        try {
          const r = workspaceManager.remove(id, { deleteFiles });
          log('info', `工作区已删除: ${r.deleted.name} (文件${r.filesDeleted ? '已' : '未'}删除)`);
          sendJSON(res, 200, { success: true, ...r });
        } catch (e) {
          sendWorkspaceError(res, e);
        }
        return;
      }

      if (action === 'archive' && req.method === 'POST') {
        try {
          const ws = workspaceManager.archive(id);
          log('info', `工作区已归档: ${ws.name}`);
          sendJSON(res, 200, ws);
        } catch (e) { sendWorkspaceError(res, e); }
        return;
      }

      if (action === 'restore' && req.method === 'POST') {
        try {
          const ws = workspaceManager.restore(id);
          log('info', `工作区已恢复: ${ws.name}`);
          sendJSON(res, 200, ws);
        } catch (e) { sendWorkspaceError(res, e); }
        return;
      }

      sendJSON(res, 404, { error: 'Not found' });
      return;
    }

    // ── 全局观测:配置接管/还原/代理路由/事件上报/用量洞察 ──

    if (p === '/api/observe/status' && req.method === 'GET') {
      sendJSON(res, 200, observe.status());
      return;
    }

    if (p === '/api/observe/takeover' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.tool || typeof body.tool !== 'string') { sendJSON(res, 400, { error: '缺少 tool 参数' }); return; }
      try {
        const r = observe.takeover(body.tool, `http://127.0.0.1:${CONFIG.PORT}`);
        log('info', `观测接管: ${body.tool} (${r.changed.join(',')})`);
        sendJSON(res, 200, { success: true, ...r });
      } catch (e) { sendJSON(res, 400, { error: e.message }); }
      return;
    }

    if (p === '/api/observe/restore' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.tool || typeof body.tool !== 'string') { sendJSON(res, 400, { error: '缺少 tool 参数' }); return; }
      try {
        const r = observe.restore(body.tool);
        log('info', `观测还原: ${body.tool}`);
        sendJSON(res, 200, { success: true, ...r });
      } catch (e) { sendJSON(res, 400, { error: e.message }); }
      return;
    }

    // 手动登记代理路由(未进注册表的工具也能接入观测)
    if (p === '/api/observe/route' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.source || !body.key || !body.upstream) { sendJSON(res, 400, { error: 'source/key/upstream 必填' }); return; }
      try {
        observe.addRoute(String(body.source), String(body.key), String(body.upstream));
        sendJSON(res, 200, { success: true, route: `${body.source}/${body.key}` });
      } catch (e) { sendJSON(res, 400, { error: e.message }); }
      return;
    }

    // 事件上报(hooks/bridge-stdio 等工具侧主动推送)
    if (p === '/api/telemetry' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.source || typeof body.source !== 'string' || !Array.isArray(body.events)) {
        sendJSON(res, 400, { error: 'source(字符串)与 events(数组)必填' });
        return;
      }
      let recorded = 0;
      for (const ev of body.events.slice(0, 100)) {
        if (!ev || typeof ev !== 'object') continue;
        const detail = ev.detail ? String(ev.detail).substring(0, 2000).replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***') : null;
        const ok = db.recordEvent({
          source: body.source, channel: 'telemetry', type: ev.type, model: ev.model,
          inputTokens: Number(ev.inputTokens) || 0, outputTokens: Number(ev.outputTokens) || 0,
          durationMs: Number(ev.durationMs) || 0, success: ev.success !== false, detail
        });
        if (ok) recorded++;
      }
      sendJSON(res, 200, { success: true, recorded });
      return;
    }

    if (p === '/api/insights' && req.method === 'GET') {
      const days = Math.min(parseInt(url.searchParams.get('days')) || 7, 365);
      sendJSON(res, 200, { days, dbAvailable: db.available, summary: db.eventsSummary(days) });
      return;
    }

    if (p === '/api/refresh' && req.method === 'POST') {
      refreshToolStatus();
      sendJSON(res, 200, { success: true });
      return;
    }

    if (p === '/api/dispatch' && req.method === 'POST') {
      const body = await readBody(req);
      // 异步模式:立即返回 taskId,后台执行,结果写内存表+全局库(跨重启可查)
      if (body.async === true) {
        if (!body.task || typeof body.task !== 'string') { sendJSON(res, 400, { error: '缺少 task 参数', code: 'invalid_request' }); return; }
        if (body.task.length > CONFIG.MAX_TASK_LENGTH) { sendJSON(res, 400, { error: `任务描述过长(>${CONFIG.MAX_TASK_LENGTH}字符)`, code: 'invalid_request' }); return; }
        const taskId = `atask_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        rememberAsyncTask(taskId, { status: 'running', result: null, ts: new Date().toISOString() });
        db.createAsyncTask(taskId, body.task);
        doDispatch(body.task, body.tools, body.auto_fallback !== false, body.context, body.review === true, body.reviewer || null, body.workspace || null, body.fallback_scope, body.model)
          .then(r => {
            const status = r.error ? 'failed' : 'done';
            rememberAsyncTask(taskId, { status, result: r, ts: new Date().toISOString() });
            db.finishAsyncTask(taskId, status, r);
          })
          .catch(e => {
            rememberAsyncTask(taskId, { status: 'failed', result: { error: e.message }, ts: new Date().toISOString() });
            db.finishAsyncTask(taskId, 'failed', { error: e.message });
          });
        sendJSON(res, 202, { taskId, status: 'running', message: '任务已入队,用 GET /api/task/' + taskId + ' 查询结果' });
        return;
      }
      const result = await doDispatch(body.task, body.tools, body.auto_fallback !== false, body.context, body.review === true, body.reviewer || null, body.workspace || null, body.fallback_scope, body.model);
      if (result && result.error) {
        const code = result.code || 'invalid_request';
        sendJSON(res, DISPATCH_ERROR_HTTP[code] || 400, { error: result.error, code });
      } else {
        sendJSON(res, 200, result);
      }
      return;
    }

    // ── 异步任务查询(内存优先,其次全局库——重启后仍可查历史/孤儿状态) ──
    if (p.startsWith('/api/task/') && req.method === 'GET') {
      const id = p.split('/').pop();
      const inMem = asyncTaskResults.get(id);
      if (inMem) { sendJSON(res, 200, { taskId: id, ...inMem }); return; }
      const row = db.getAsyncTask(id);
      if (row) { sendJSON(res, 200, { taskId: id, status: row.status, result: row.result, ts: row.ts, finishedAt: row.finished_at }); return; }
      sendJSON(res, 404, { error: '任务不存在' });
      return;
    }

    // ── 全局库统计(跨重启/跨项目的长期沉淀层) ──
    if (p === '/api/db/stats' && req.method === 'GET') {
      sendJSON(res, 200, db.stats());
      return;
    }

    if (p === '/api/handoff' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await doHandoff(body.task, body.existing_code, body.from, body.to, body.workspace || null);
      sendJSON(res, 200, result);
      return;
    }

    if (p === '/api/stats' && req.method === 'GET') {
      sendJSON(res, 200, loadJSON(STATS_FILE));
      return;
    }

    // ── 运行指标(可观测性:计数器 + 配置快照 + 数据文件体积) ──
    if (p === '/api/metrics' && req.method === 'GET') {
      const dataFileBytes = {};
      for (const [k, f] of Object.entries(store.FILES)) {
        try { dataFileBytes[k] = fs.existsSync(f) ? fs.statSync(f).size : 0; } catch (_) { dataFileBytes[k] = -1; }
      }
      sendJSON(res, 200, {
        uptime: Math.floor((Date.now() - START_TIME) / 1000),
        clients: onlineClientCount(),
        activeDispatches: activeDispatchCount,
        counters: METRICS,
        config: {
          maxConcurrentDispatch: CONFIG.MAX_CONCURRENT_DISPATCH,
          maxConcurrentMeetings: CONFIG.MAX_CONCURRENT_MEETINGS,
          maxMeetingTokens: CONFIG.MAX_MEETING_TOKENS,
          meetingMaxMs: CONFIG.MEETING_MAX_MS,
          clientTtlMs: CONFIG.CLIENT_TTL,
          authEnabled: !!CONFIG.AUTH_TOKEN
        },
        dataFileBytes,
        db: { available: db.available, path: db.dbPath }
      });
      return;
    }

    if (p === '/api/clients' && req.method === 'GET') {
      const acl = store.loadACL();
      const approvedIds = new Set(acl.allowlist.map(assignedClientId));
      const allIds = new Set([...approvedIds, ...connectedClients.keys()]);
      const clients = [...allIds].map(id => {
        const live = connectedClients.get(id);
        if (live) return clientView(id, live, approvedIds.has(id) || acl.allowlist.includes(live.name));
        const tombstone = clientTombstones.get(id);
        return {
          ...clientView(id, null, true),
          name: tombstone?.name || id.replace(/^client-/, ''),
          lastSeen: tombstone?.lastSeen ? new Date(tombstone.lastSeen).toISOString() : null,
          lastError: tombstone?.lastError || null,
          disconnectReason: tombstone?.disconnectReason || null,
          disconnectedAt: tombstone?.disconnectedAt ? new Date(tombstone.disconnectedAt).toISOString() : null
        };
      }).sort((a, b) => Number(b.online) - Number(a.online) || a.id.localeCompare(b.id));
      const onlineCount = clients.filter(c => c.online).length;
      sendJSON(res, 200, { clients, count: onlineCount, totalApproved: approvedIds.size, pending: acl.pending, allowlist: acl.allowlist, blocklist: acl.blocklist });
      return;
    }

    if (p === '/api/client/register' && req.method === 'POST') {
      const body = await readBody(req);
      const clientId = body.name || `client-${Date.now()}`;
      // 防同名:如果已存在同名 CLI 工具,加前缀
      const finalName = assignedClientId(clientId);

      // ── 准入控制:白名单 + 手动审批 ──
      const acl = store.loadACL();
      // 1) 黑名单:直接拒绝
      if (acl.blocklist.includes(finalName) || acl.blocklist.includes(clientId)) {
        log('warn', `客户端 ${finalName} 在黑名单,拒绝加入`);
        sendJSON(res, 403, { success: false, status: 'denied', clientId: finalName, message: '已被管理员拒绝加入' });
        return;
      }
      // 2) 白名单:放行
      if (acl.allowlist.includes(finalName) || acl.allowlist.includes(clientId)) {
        const old = connectedClients.get(finalName);
        if (old) {
          // 注册接口幂等：保留在途任务。若旧连接已 stale，则显式进入 reconnecting，
          // 仍须重新完成一次 poll 才能恢复为在线。
          const wasStale = clientState(old) === 'stale';
          old.lastSeen = Date.now();
          // 乱序保护(F2/#50):注册带单调 registerSeq,seq 更小的陈旧注册不得改动能力
          // (防"桥启动即注册的 sampling=false 迟到覆写宿主声明的 true");
          // 不带 registerSeq 的旧客户端 seq=null → stale 恒为 false → 行为与既往完全一致(向后兼容)。
          // 注意这不是"只升不降":seq 更大者允许真实撤回能力(#50a3 哨兵)。
          const seq = Number.isFinite(body.registerSeq) ? body.registerSeq : null;
          const stale = seq !== null && typeof old.lastRegisterSeq === 'number' && seq < old.lastRegisterSeq;
          if (!stale) {
            if (typeof body.capabilities?.sampling === 'boolean') old.supportsSampling = body.capabilities.sampling;
            old.supportsExec = body.capabilities?.exec === true; // 能力只允许严格 opt-in
            if (seq !== null) old.lastRegisterSeq = seq;
          }
          if (wasStale) {
            old.firstPollAt = null;
            old.reconnectCount = (old.reconnectCount || 0) + 1;
            old.lastError = null;
            old.disconnectReason = null;
          }
          sendJSON(res, 200, { success: true, status: 'approved', clientId: finalName, reused: true, lifecycle: clientState(old) });
          return;
        }
        const now = Date.now();
        const tombstone = clientTombstones.get(finalName);
        connectedClients.set(finalName, {
          name: clientId,
          connectedAt: new Date(now).toISOString(),
          registeredAt: now,
          firstPollAt: null,
          lastSeen: now,
          reconnectCount: tombstone ? 1 : 0,
          supportsSampling: body.capabilities?.sampling === true,
          supportsExec: body.capabilities?.exec === true,
          lastRegisterSeq: Number.isFinite(body.registerSeq) ? body.registerSeq : null,
          lastError: null,
          disconnectReason: null
        });
        clientTombstones.delete(finalName);
        // 加入后从待审批队列清除
        if (acl.pending.some(pd => pd.clientId === finalName)) {
          acl.pending = acl.pending.filter(pd => pd.clientId !== finalName);
          store.saveACL(acl);
        }
        log('info', `客户端 ${finalName} 已加入(白名单)`);
        sendJSON(res, 200, { success: true, status: 'approved', clientId: finalName, reused: false, lifecycle: 'connecting', supportsSampling: body.capabilities?.sampling === true });
        return;
      }
      // 3) 陌生客户端:进待审批队列,不占用调度
      if (!acl.pending.some(pd => pd.clientId === finalName)) {
        acl.pending.push({ clientId: finalName, name: clientId, requestedAt: new Date().toISOString() });
        store.saveACL(acl);
      }
      log('info', `客户端 ${finalName} 请求加入,进入待审批队列`);
      sendJSON(res, 200, { success: false, status: 'pending', clientId: finalName, message: '等待管理员批准' });
      return;
    }

    // ── 准入管理:批准 ──
    if (p === '/api/clients/approve' && req.method === 'POST') {
      const body = await readBody(req);
      const id = body.clientId;
      if (!id) { sendJSON(res, 400, { error: '缺少 clientId' }); return; }
      const acl = store.loadACL();
      if (!acl.allowlist.includes(id)) acl.allowlist.push(id);
      acl.blocklist = acl.blocklist.filter(x => x !== id);
      acl.pending = acl.pending.filter(pd => pd.clientId !== id);
      store.saveACL(acl);
      log('info', `客户端 ${id} 已批准加入`);
      sendJSON(res, 200, { success: true, clientId: id, status: 'approved' });
      return;
    }

    // ── 准入管理:拒绝(拉黑) ──
    if (p === '/api/clients/deny' && req.method === 'POST') {
      const body = await readBody(req);
      const id = body.clientId;
      if (!id) { sendJSON(res, 400, { error: '缺少 clientId' }); return; }
      const acl = store.loadACL();
      const aclKeys = aclClientKeys(id);
      if (!acl.blocklist.includes(id)) acl.blocklist.push(id);
      acl.allowlist = acl.allowlist.filter(x => !aclKeys.includes(x));
      acl.pending = acl.pending.filter(pd => !aclKeys.includes(pd.clientId));
      store.saveACL(acl);
      // 若已连接,同时踢出
      const client = connectedClients.get(id);
      if (client) {
        if (client.pendingReject) client.pendingReject(new Error('已被管理员拒绝'));
        rememberClientDisconnect(id, client, 'admin_denied');
        connectedClients.delete(id);
      }
      log('info', `客户端 ${id} 已被拒绝并拉黑`);
      sendJSON(res, 200, { success: true, clientId: id, status: 'denied' });
      return;
    }

    // ── 准入管理:踢出(可选拉黑) ──
    if (p === '/api/clients/kick' && req.method === 'POST') {
      const body = await readBody(req);
      const id = body.clientId;
      if (!id) { sendJSON(res, 400, { error: '缺少 clientId' }); return; }
      const client = connectedClients.get(id);
      if (client) {
        if (client.pendingReject) client.pendingReject(new Error('已被管理员踢出'));
        rememberClientDisconnect(id, client, body.block ? 'admin_blocked' : 'admin_kicked');
        connectedClients.delete(id);
      }
      const acl = store.loadACL();
      const aclKeys = aclClientKeys(id);
      // 踢出同时移出白名单,避免立即自动重连(需重新审批);block=true 则拉黑。
      // 同时移除同名 CLI 冲突客户端的原始授权名（如 openclaw/client-openclaw）。
      acl.allowlist = acl.allowlist.filter(x => !aclKeys.includes(x));
      if (body.block && !acl.blocklist.includes(id)) acl.blocklist.push(id);
      store.saveACL(acl);
      log('info', `客户端 ${id} 已被踢出${body.block ? '并拉黑' : ''}`);
      sendJSON(res, 200, { success: true, clientId: id, kicked: !!client, blocked: !!body.block });
      return;
    }

    if (p === '/api/client/unregister' && req.method === 'POST') {
      const body = await readBody(req);
      const client = connectedClients.get(body.clientId);
      if (client?.pendingReject) client.pendingReject(new Error('客户端断开'));
      if (client) rememberClientDisconnect(body.clientId, client, body.reason || 'client_unregister', body.error || null);
      connectedClients.delete(body.clientId);
      sendJSON(res, 200, { success: true, lifecycle: 'approved_offline' });
      return;
    }

    // 长轮询(带 req 关闭检测,防泄漏)
    if (p === '/api/poll' && req.method === 'POST') {
      const body = await readBody(req);
      const client = connectedClients.get(body.clientId);
      if (!client) { sendJSON(res, 404, { error: '未注册' }); return; }
      const now = Date.now();
      client.lastSeen = now; // 轮询即视为活跃,TTL 按最后活动时间判定
      if (!client.firstPollAt) client.firstPollAt = now; // 首轮 poll 是健康在线的边界
      client.lastError = null;
      client.disconnectReason = null;

      if (client.pendingTask) {
        sendJSON(res, 200, { task: client.pendingTask });
        client.pendingTask = null;
        client.taskPending = true;
        return;
      }

      // 长轮询:等 30 秒,但 req 关闭时立即清理
      let resolved = false;
      const finish = (data) => {
        if (resolved) return;
        resolved = true;
        clearInterval(interval);
        clearTimeout(pollTimer); // 修:超时定时器一并清理,防每个已完成请求挂 30 秒闭包
        sendJSON(res, 200, data);
      };

      const interval = setInterval(() => {
        const c = connectedClients.get(body.clientId);
        // 必须仍是本次 poll 启动时捕获的连接对象。注销后同 ID 重注册会创建新对象，
        // 旧长轮询不得跨会话抢走新连接的任务。
        if (!c || c !== client) {
          finish({ task: null });
          return;
        }
        c.lastSeen = Date.now(); // 打开的长轮询就是活跃心跳
        if (c.pendingTask) {
          finish({ task: c.pendingTask });
          c.pendingTask = null;
          c.taskPending = true;
        }
      }, 1000);

      // 30 秒超时
      const pollTimer = setTimeout(() => finish({ task: null }), CONFIG.POLL_TIMEOUT);

      // req 关闭时清理(防泄漏)
      req.on('close', () => finish({ task: null }));
      return;
    }

    // 提交结果(防过期:检查 pendingResolve 是否存在)
    if (p === '/api/result' && req.method === 'POST') {
      const body = await readBody(req);
      const client = connectedClients.get(body.clientId);
      if (client && client.pendingResolve) {
        // 客户端明确上报 failed 时走 reject:让 dispatch 接力链/会议失败标注正确生效,不再把失败当成功记入成功率
        if (body.failed === true) {
          client.pendingReject(new Error((body.content || '客户端执行失败').substring(0, 300)));
        } else {
          const result = { content: body.content || '', codeBlocks: body.codeBlocks || [], usage: body.usage || null };
          client.pendingResolve(result);
        }
        client.pendingResolve = null;
        client.pendingReject = null;
        client.taskPending = false;
        client._busy = false;
        client.lastSeen = Date.now();
        client.lastError = body.failed === true ? (body.content || '客户端执行失败').substring(0, 300) : null;
        sendJSON(res, 200, { success: true });
      } else {
        // pendingResolve 已过期(超时被清了),通知客户端;留 warn 日志便于事后追查丢结果
        log('warn', `结果抵达但 pending 已被超时清空,结果丢弃: clientId=${body.clientId || ''} taskId=${body.taskId || ''} contentLength=${(body.content || '').length}`);
        sendJSON(res, 200, { success: false, reason: '任务已超时,结果被丢弃' });
      }
      return;
    }

    // ── 记忆 API ──
    if (p === '/api/memory/search' && req.method === 'POST') {
      const body = await readBody(req);
      const results = store.searchMemory(body.query || '');
      sendJSON(res, 200, results);
      return;
    }

    if (p === '/api/memory/recent' && req.method === 'GET') {
      const limit = Math.max(1, parseInt(url.searchParams.get('limit') || '10') || 10);
      sendJSON(res, 200, { tasks: store.getRecentTasks(limit) });
      return;
    }

    if (p === '/api/memory/experience' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.content) { sendJSON(res, 400, { error: '缺少 content' }); return; }
      store.writeExperience(body.category || 'general', body.content, body.tags || []);
      sendJSON(res, 200, { success: true });
      return;
    }

    if (p === '/api/memory/stats' && req.method === 'GET') {
      sendJSON(res, 200, store.getToolStats());
      return;
    }

    // ── 用量报表:按天/按模型聚合 token 与调用数(数据源:traffic 表反代入站记录) ──
    if (p === '/api/usage/report' && req.method === 'GET') {
      const days = Math.max(1, Math.min(parseInt(url.searchParams.get('days') || '7') || 7, 90));
      sendJSON(res, 200, db.usageReport(days));
      return;
    }

    // ── 日志 API ──
    if (p === '/api/logs' && req.method === 'GET') {
      const level = url.searchParams.get('level') || null;
      const limit = Math.max(1, parseInt(url.searchParams.get('limit') || '50') || 50);
      const since = url.searchParams.get('since') || null;
      sendJSON(res, 200, { logs: store.readLogs({ level, limit, since }) });
      return;
    }

    if (p === '/api/logs/clear' && req.method === 'POST') {
      store.clearLogs();
      sendJSON(res, 200, { success: true });
      return;
    }

    // ── 流量日志 API(完整内容,SQLite 查询) ──
    if (p === '/api/traffic' && req.method === 'GET') {
      const tool = url.searchParams.get('tool') || null;
      const direction = url.searchParams.get('direction') || null;
      const source = url.searchParams.get('source') || null;
      const limit = Math.max(1, parseInt(url.searchParams.get('limit') || '50') || 50);
      const since = url.searchParams.get('since') || null;
      // bridge 流量 + AgnesCode llm_request 采集
      const bridgeTraffic = db.queryTraffic({ tool, direction, source: source || null, limit, since });
      // 如果请求包含 source=agnes 或 source=all，也查 AgnesCode 日志
      let agnesTraffic = [];
      if (!source || source === 'agnes' || source === 'all') {
        agnesTraffic = readAgnesLLMLogs({ limit, since });
      }
      const combined = [...bridgeTraffic, ...agnesTraffic].sort((a, b) => (b.ts || '').localeCompare(a.ts || '')).slice(0, limit);
      sendJSON(res, 200, { traffic: combined, count: combined.length });
      return;
    }

    if (p === '/api/traffic/clear' && req.method === 'POST') {
      db.clearTraffic();
      sendJSON(res, 200, { success: true });
      return;
    }

    // ── mitmproxy 流量采集端点(由 mitm-addon.py 回调) ──
    if (p === '/api/traffic/capture' && req.method === 'POST') {
      const body = await readBody(req);
      db.recordTraffic({
        ts: body.ts || new Date().toISOString(),
        direction: body.direction || 'out',
        tool: String(body.tool || 'unknown').substring(0, 120),
        taskId: body.taskId || null,
        type: body.type || 'mitm-proxy',
        source: 'mitm',
        content: body.content || '',
        usage: null,
        success: body.status_code ? body.status_code < 400 : null,
        error: body.status_code && body.status_code >= 400 ? `HTTP ${body.status_code}` : null
      });
      sendJSON(res, 200, { success: true });
      return;
    }

    // ── mitmproxy 控制端点 ──
    if (p === '/api/mitm/status' && req.method === 'GET') {
      // 检查 mitmproxy 是否在运行(尝试连接 8888 端口)
      const net = require('net');
      const socket = new net.Socket();
      socket.setTimeout(1000);
      socket.on('connect', () => { try { socket.destroy(); } catch(_){} sendJSON(res, 200, { running: true, port: 8888 }); });
      socket.on('error', () => sendJSON(res, 200, { running: false, port: 8888 }));
      socket.on('timeout', () => { try { socket.destroy(); } catch(_){} sendJSON(res, 200, { running: false, port: 8888 }); });
      socket.connect(8888, '127.0.0.1');
      return;
    }

    // ── OpenAI 兼容反代:把各 AI 编程软件绑定的免费订阅统一以 OpenAI 格式暴露 ──
    // 清单 = models.json + kimi-code 自动同步条目(受 modelEnabled 开关约束)∪ 已启用工具(受 isToolEnabled 开关约束,不看 available)
    // 工具条目代表"可派发的算力"(含在线 MCP 客户端),与 models 条目 id 冲突时 models 优先(小写不敏感去重)
    if (p === '/v1/models' && req.method === 'GET') {
      const created = Math.floor(START_TIME / 1000);
      const modelEntries = loadAllModels().filter(modelEnabled).map(m => ({ id: m.id, object: 'model', created, owned_by: m.owned_by || 'ai-bridge' }));
      const modelIds = new Set(modelEntries.map(x => String(x.id).toLowerCase()));
      const allT = await getAllTools();
      const toolEntries = allT
        .filter(t => isToolEnabled(t) && !modelIds.has(String(t.name).toLowerCase()))
        .map(t => ({ id: t.name, object: 'model', created, owned_by: t.type }));
      sendJSON(res, 200, { object: 'list', data: modelEntries.concat(toolEntries) });
      return;
    }

    // ── Anthropic 兼容端点:Claude Code 类工具可直接以 Anthropic 协议接入(仅 codely-http 模型) ──
    if (p === '/v1/messages' && req.method === 'POST') {
      const body = await readBody(req, PROXY_MAX_BODY);
      const isStream = body.stream === true;
      const model = findModel(body.model);
      if (!model) { sendJSON(res, 404, { type: 'error', error: { type: 'not_found_error', message: `未知模型: ${body.model || '(空)'}。可用模型见 GET /v1/models` } }); return; }
      if (!modelEnabled(model)) { sendJSON(res, 403, { type: 'error', error: { type: 'permission_error', message: `模型 ${model.id} 已被开关禁用(${model.switch})` } }); return; }
      if (model.transport !== 'codely-http') { sendJSON(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: `/v1/messages 仅支持 codely-http 模型,${model.id} 是 ${model.transport}` } }); return; }
      const taskId = `proxy_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      const fwdBody = { ...body, model: model.upstreamModel || model.id };
      fwdBody.stream = isStream; // 统一显式声明
      const reqData = JSON.stringify(fwdBody);
      try {
        const cliKey = await getCodelyCliApiKey();
        // 签名按纯 path 计算(官方 fetch 拦截器用 URL.pathname),请求 URL 需带 ?beta=1 启用 Anthropic 兼容层
        forwardCodelyLiteLLM({ res, reqPath: '/v1/messages', reqUrl: `${CODELY_LITELLM_BASE}/v1/messages?beta=1`, reqData, messages: fwdBody.messages, model, taskId, isStream, cliKey, retried: false });
      } catch (e) {
        sendJSON(res, 500, { error: '获取 Codely cli_api_key 失败', detail: String(e.message || e).substring(0, 300) });
      }
      return;
    }

    // ── 模型清单自动同步:带签名拉 LiteLLM /v1/models,与 models.json 的 codely-http 条目 diff ──
    if (p === '/api/models/sync' && req.method === 'POST') {
      try {
        const cliKey = await getCodelyCliApiKey();
        const upRes = await requestCodelyLiteLLM('/v1/models', { method: 'GET', cliKey, timeout: 20000 });
        let rd = '';
        upRes.on('data', d => rd += d);
        await new Promise((resolve, reject) => { upRes.on('end', resolve); upRes.on('error', reject); });
        if (upRes.statusCode !== 200) {
          sendJSON(res, 502, { error: `上游 /v1/models 返回 ${upRes.statusCode}`, detail: rd.substring(0, 300) });
          return;
        }
        let upstreamModels = [];
        try { upstreamModels = (JSON.parse(rd).data || []).map(x => x.id).filter(Boolean); } catch (_) {}
        const models = loadModels();
        const existing = new Set(models.filter(m => m.transport === 'codely-http').map(m => m.upstreamModel || m.id));
        const added = [];
        for (const id of upstreamModels) {
          if (existing.has(id)) continue;
          models.push({ id, owned_by: 'codely', switch: 'codely', transport: 'codely-http', upstreamModel: id });
          added.push(id);
        }
        if (added.length > 0) {
          fs.writeFileSync(path.join(__dirname, 'models.json'), JSON.stringify(models, null, 2) + '\n', 'utf-8');
          _modelsCache = null; // 立即失效缓存
        }
        sendJSON(res, 200, { upstream: upstreamModels.length, added, total: loadModels().length });
        log('info', `模型清单同步完成: 上游 ${upstreamModels.length} 个, 新增 ${added.length} 个${added.length ? ': ' + added.join(', ') : ''}`);
      } catch (e) {
        sendJSON(res, 500, { error: '模型同步失败', detail: String(e.message || e).substring(0, 300) });
      }
      return;
    }

    if (p === '/v1/chat/completions' && req.method === 'POST') {
      const body = await readBody(req, PROXY_MAX_BODY);
      const isStream = body.stream === true;
      const model = findModel(body.model);
      if (!model) {
        // ── 分支 T3:model=<工具名> 直连单工具执行(纯 1:1 透传,无接力/评审/工作区;不支持 stream,始终一次性返回 JSON) ──
        // models 查找已优先执行(model 命中走下方 transport 分支);此处仅处理"模型名即工具名"的直连语义
        const allT = await getAllTools();
        const t = resolveToolReference(body.model, allT);
        if (!t) { sendJSON(res, 404, { error: `未知模型: ${body.model || '(空)'}。可用模型见 GET /v1/models` }); return; }
        if (!isToolEnabled(t)) { sendJSON(res, 403, { error: `工具 ${t.name} 已被开关禁用` }); return; }
        if (activeDispatchCount >= CONFIG.MAX_CONCURRENT_DISPATCH) { sendJSON(res, 429, { error: `并发数已达上限(${CONFIG.MAX_CONCURRENT_DISPATCH}),请稍后重试` }); return; }
        // prompt 提取:取最后一条 role==='user' 消息;content 为字符串直接用,为数组时取各 part.text 拼接;无有效文本 → 400
        const msgs = Array.isArray(body.messages) ? body.messages : [];
        let prompt = '';
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (!m || m.role !== 'user') continue;
          if (typeof m.content === 'string') prompt = m.content;
          else if (Array.isArray(m.content)) prompt = m.content.map(x => (x && typeof x.text === 'string') ? x.text : '').join('');
          break;
        }
        if (!String(prompt).trim()) { sendJSON(res, 400, { error: 'messages 中缺少可用文本内容', code: 'invalid_request' }); return; }
        const toolTaskId = `proxy_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        db.recordTraffic({ ts: new Date().toISOString(), direction: 'out', tool: t.name, taskId: toolTaskId, type: 'openai-tool', content: String(prompt).substring(0, 8000), source: 'bridge' });
        activeDispatchCount++;
        try {
          // 模型透传:model_override 为非空字符串时作为适配器的 opts.model(仅声明 modelFlag 的工具生效)
          const toolModelOverride = (typeof body.model_override === 'string' && body.model_override.trim()) ? body.model_override : undefined;
          const r = await executeTool(t.name, prompt, { model: toolModelOverride });
          const fail = isToolFailed(r, null);
          if (fail.failed) { sendJSON(res, 502, { error: `工具 ${t.name} 执行失败: ${String(fail.reason || '').substring(0, 300)}` }); return; }
          const tokens = r.tokens || {};
          const pt = tokens.input ?? estimateTokens(prompt);
          const ct = tokens.output ?? estimateTokens(r.content || '');
          sendJSON(res, 200, {
            id: 'chatcmpl-' + toolTaskId, object: 'chat.completion', created: Math.floor(Date.now() / 1000),
            model: String(body.model),
            choices: [{ index: 0, message: { role: 'assistant', content: r.content || '' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: tokens.total ?? (pt + ct) }
          });
        } catch (e) {
          sendJSON(res, 502, { error: `工具 ${t.name} 执行异常: ${String(e.message || e).substring(0, 300)}` });
        } finally {
          activeDispatchCount--;
        }
        return;
      }
      if (!modelEnabled(model)) { sendJSON(res, 403, { error: `模型 ${model.id} 已被开关禁用(${model.switch})` }); return; }
      const taskId = `proxy_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

      // ── 分支 A:HTTP 直连订阅(Agnes,支持流式 SSE) ──
      if (model.transport === 'agnes-http') {
        const token = readAgnesToken();
        if (!token) { sendJSON(res, 500, { error: 'AgnesCode token 未找到(Windows 凭据管理器)' }); return; }
        const fwdBody = { ...body, model: model.upstreamModel || model.id };
        const reqData = JSON.stringify(fwdBody);
        db.recordTraffic({ ts: new Date().toISOString(), direction: 'out', tool: model.id, taskId, type: 'openai-proxy', content: JSON.stringify(fwdBody.messages || []).substring(0, 8000), source: 'bridge' });
        const proxyReq = https.request(model.upstream, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqData), 'Authorization': 'Bearer ' + token }
        }, (proxyRes) => {
          if (proxyRes.statusCode !== 200) {
            let errBody = '';
            proxyRes.on('data', d => errBody += d);
            proxyRes.on('end', () => sendJSON(res, proxyRes.statusCode, { error: '上游错误', detail: errBody.substring(0, 500) }));
            return;
          }
          if (isStream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
            let fullContent = '';
            proxyRes.on('data', chunk => {
              res.write(chunk);
              for (const line of chunk.toString().split('\n').filter(Boolean)) {
                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                  try { fullContent += JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || ''; } catch (_) {}
                }
              }
            });
            proxyRes.on('end', () => {
              res.end();
              db.recordTraffic({ ts: new Date().toISOString(), direction: 'in', tool: model.id, taskId, type: 'openai-proxy', success: true, content: fullContent.substring(0, 8000), source: 'bridge' });
              recordTokens(model.id, { input: estimateTokens(JSON.stringify(body.messages || [])), output: estimateTokens(fullContent), estimated: true }, '—');
            });
          } else {
            let respData = '';
            proxyRes.on('data', d => respData += d);
            proxyRes.on('end', () => {
              res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
              res.end(respData);
              try {
                const parsed = JSON.parse(respData);
                // 写侧归一(#45 S2):落库只写 {input,output,total},不再存上游原样 usage;上游键名仅用于读取响应。
                // HTTP 响应体(res.end(respData))原样透传,不改一个字节。无 usage 时写 null(不猜,L3b 精神)。
                const inTok = parsed.usage ? (parsed.usage.prompt_tokens || parsed.usage.input_tokens || 0) : 0;
                const outTok = parsed.usage ? (parsed.usage.completion_tokens || parsed.usage.output_tokens || 0) : 0;
                const usageRow = parsed.usage ? { input: inTok, output: outTok, total: inTok + outTok } : null;
                db.recordTraffic({ ts: new Date().toISOString(), direction: 'in', tool: model.id, taskId, type: 'openai-proxy', success: true, content: (parsed.choices?.[0]?.message?.content || '').substring(0, 8000), usage: usageRow, source: 'bridge' });
                if (parsed.usage) recordTokens(model.id, { input: parsed.usage.prompt_tokens || 0, output: parsed.usage.completion_tokens || 0 }, '—');
              } catch (_) {}
            });
          }
        });
        proxyReq.on('error', e => { if (!res.headersSent) sendJSON(res, 502, { error: '上游请求失败', detail: e.message }); else res.end(); });
        proxyReq.write(reqData);
        proxyReq.end();
        return;
      }

      // ── 分支 A2:Codely(团结 Cowork)LiteLLM 转发(cli_api_key + X-Codely-Signature 签名,401/403 换新 key 重试一次) ──
      if (model.transport === 'codely-http') {
        const fwdBody = { ...body, model: model.upstreamModel || model.id };
        const reqData = JSON.stringify(fwdBody);
        // 幂等缓存命中(#47 语义,只有可回放才短路返回):
        //   非流式 → 原字节回放;流式且缓存体可回放 → sse-replay 合成合法 SSE 回放;
        //   流式但缓存体不可回放 → 逐出该条缓存、继续走下方正常转发(绝不因缓存坏向用户报错)
        const ck = cacheKey(model.id, fwdBody);
        const cached = cacheGet(ck);
        if (cached) {
          if (!isStream) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'HIT' });
            res.end(cached.value);
            db.recordEvent({ source: 'bridge', channel: 'cache', type: 'llm_request', model: model.id, detail: 'cache HIT' });
            return;
          }
          if (isReplayableJson(cached.value)) {
            // 合成器契约见 sse-replay.js:帧帧带 data: 前缀、usage 原样透传、末帧 [DONE]
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Cache': 'HIT' });
            res.write(sseFromChatJson(cached.value, { model: model.id }));
            res.end();
            db.recordEvent({ source: 'bridge', channel: 'cache', type: 'llm_request', model: model.id, detail: 'cache HIT' });
            return;
          }
          // 不可回放(坏形状/旧格式/tool_calls):逐出缓存回落到正常转发,不带 X-Cache
          _respCache.delete(ck);
        }
        try {
          const cliKey = await getCodelyCliApiKey();
          const ctx = { res, reqPath: '/v1/chat/completions', reqData, messages: fwdBody.messages, model, taskId, isStream, cliKey, retried: false };
          // 非流式:包装 res 捕获 200 响应体写缓存
          if (!isStream) {
            ctx.res = {
              headersSent: false,
              writeHead (code, headers) { this._code = code; this._headers = headers || {}; this.headersSent = true; return this; },
              end (data) {
                if (this._code === 200 && data) {
                  cacheSet(ck, data);
                  const h = { ...this._headers, 'Content-Type': 'application/json; charset=utf-8' };
                  res.writeHead(200, h);
                  res.end(data);
                } else {
                  res.writeHead(this._code || 502, this._headers || {});
                  res.end(data);
                }
              }
            };
          }
          forwardCodelyLiteLLM(ctx);
        } catch (e) {
          sendJSON(res, 500, { error: '获取 Codely cli_api_key 失败', detail: String(e.message || e).substring(0, 300) });
        }
        return;
      }

      // ── 分支 A3:本地 Ollama VL(qwen2.5-vl 等,零云端 token;图片走 base64) ──
      if (model.transport === 'local-vl') {
        const ollamaModel = model.ollamaModel || 'qwen2.5vl:3b';
        const ollamaBase = model.ollamaBase || process.env.AI_BRIDGE_OLLAMA_BASE || 'http://127.0.0.1:11434';
        // OpenAI messages → Ollama messages(字符串 content 原样;分段数组提取 text + image_url base64)
        const ollamaMessages = (Array.isArray(body.messages) ? body.messages : []).map(m => {
          const msg = { role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user' };
          if (typeof m.content === 'string') { msg.content = m.content; return msg; }
          const parts = Array.isArray(m.content) ? m.content : [];
          msg.content = parts.filter(x => x && typeof x.text === 'string').map(x => x.text).join('');
          const images = parts.filter(x => x && x.image_url && typeof x.image_url.url === 'string')
            .map(x => x.image_url.url.replace(/^data:[^;]+;base64,/, ''));
          if (images.length) msg.images = images;
          return msg;
        });
        if (ollamaMessages.length === 0) { sendJSON(res, 400, { error: '缺少 messages 内容' }); return; }
        const ollamaReqData = JSON.stringify({ model: ollamaModel, messages: ollamaMessages, stream: !!isStream, options: { temperature: body.temperature ?? undefined, top_p: body.top_p ?? undefined } });
        const ollamaUrl = new URL(ollamaBase + '/api/chat');
        const oMod = ollamaUrl.protocol === 'https:' ? https : http;
        db.recordTraffic({ ts: new Date().toISOString(), direction: 'out', tool: model.id, taskId, type: 'openai-proxy', content: JSON.stringify(body.messages || []).substring(0, 2000), source: 'bridge' });
        const created = Math.floor(Date.now() / 1000);
        const oReq = oMod.request(ollamaUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(ollamaReqData) }, timeout: 120000 }, oRes => {
          if (oRes.statusCode !== 200) {
            let eb = '';
            oRes.on('data', d => eb += d);
            oRes.on('end', () => sendJSON(res, oRes.statusCode === 404 ? 503 : oRes.statusCode, { error: 'Ollama 上游错误(确认 ollama serve 已运行且模型已拉取)', detail: eb.substring(0, 300) }));
            return;
          }
          if (isStream) {
            // Ollama NDJSON 流 → OpenAI SSE 逐块转换
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
            let buf = '';
            let full = '';
            oRes.on('data', chunk => {
              buf += chunk.toString('utf-8');
              let nl;
              while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                try {
                  const j = JSON.parse(line);
                  const delta = j.message?.content || '';
                  if (delta) full += delta;
                  res.write(`data: ${JSON.stringify({ id: taskId, object: 'chat.completion.chunk', created, model: model.id, choices: [{ index: 0, delta: j.done ? {} : { role: 'assistant', content: delta }, finish_reason: j.done ? 'stop' : null }] })}\n\n`);
                } catch (_) {}
              }
            });
            oRes.on('end', () => {
              res.write('data: [DONE]\n\n');
              res.end();
              db.recordTraffic({ ts: new Date().toISOString(), direction: 'in', tool: model.id, taskId, type: 'openai-proxy', success: true, content: full.substring(0, 8000), source: 'bridge' });
              recordTokens(model.id, { input: estimateTokens(JSON.stringify(body.messages || [])), output: estimateTokens(full), estimated: true }, '—');
            });
          } else {
            let rd = '';
            oRes.on('data', d => rd += d);
            oRes.on('end', () => {
              try {
                const j = JSON.parse(rd);
                const content = j.message?.content || '';
                const usage = { prompt_tokens: j.prompt_eval_count || 0, completion_tokens: j.eval_count || 0, total_tokens: (j.prompt_eval_count || 0) + (j.eval_count || 0) };
                sendJSON(res, 200, {
                  id: taskId, object: 'chat.completion', created, model: model.id,
                  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
                  usage
                });
                db.recordTraffic({ ts: new Date().toISOString(), direction: 'in', tool: model.id, taskId, type: 'openai-proxy', success: true, content: content.substring(0, 8000), usage, source: 'bridge' });
                recordTokens(model.id, { input: usage.prompt_tokens, output: usage.completion_tokens }, '—');
              } catch (e) {
                sendJSON(res, 502, { error: 'Ollama 响应解析失败', detail: String(e.message).substring(0, 300) });
              }
            });
          }
        });
        oReq.on('timeout', () => oReq.destroy(new Error('Ollama 上游超时')));
        oReq.on('error', e => { if (!res.headersSent) sendJSON(res, 502, { error: 'Ollama 上游请求失败(确认 ollama serve 已运行)', detail: e.message }); else res.end(); });
        oReq.write(ollamaReqData);
        oReq.end();
        return;
      }

      // ── 分支 B:CLI 型订阅(安全 spawn,shell:false;复用经测试的 CliAdapter,无 execSync 拼接注入面) ──
      // 超长 prompt 的落盘回退已下沉到 CliAdapter(inputMode=arg 时自动生效)
      if (model.transport === 'cli') {
        const fullPrompt = messagesToPrompt(body.messages);
        if (!fullPrompt) { sendJSON(res, 400, { error: '缺少 messages 内容' }); return; }
        const cliCfg = model.cli || {};
        const adapter = new CliAdapter({
          name: model.owned_by || model.id,
          command: cliCfg.command,
          commandPaths: cliCfg.commandPaths || [],
          args: cliCfg.args || ['-p', '{{task}}'],
          inputMode: cliCfg.inputMode || 'arg',
          outputMode: cliCfg.outputMode || 'stdout-text',
          timeout: cliCfg.timeout || 120000
        });
        db.recordTraffic({ ts: new Date().toISOString(), direction: 'out', tool: model.id, taskId, type: 'openai-proxy', content: fullPrompt.substring(0, 8000), source: 'bridge' });
        let result;
        try {
          result = await adapter.execute(fullPrompt, { taskId });
        } catch (e) {
          db.recordTraffic({ ts: new Date().toISOString(), direction: 'in', tool: model.id, taskId, type: 'openai-proxy', success: false, error: e.message, content: '', source: 'bridge' });
          sendJSON(res, 502, { error: `${model.id} CLI 执行失败`, detail: String(e.message || e).substring(0, 300) });
          return;
        }
        // 剔除 CLI 噪声行([warning]/[error] 前缀)
        const content = (result.content || '').split('\n').filter(l => !/^\[(warning|error)\]/i.test(l.trim())).join('\n').trim();
        const usage = { prompt_tokens: estimateTokens(fullPrompt), completion_tokens: estimateTokens(content), total_tokens: 0 };
        usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
        db.recordTraffic({ ts: new Date().toISOString(), direction: 'in', tool: model.id, taskId, type: 'openai-proxy', success: true, content: content.substring(0, 8000), source: 'bridge' });
        recordTokens(model.id, { input: usage.prompt_tokens, output: usage.completion_tokens, estimated: true }, '—');
        const created = Math.floor(Date.now() / 1000);
        if (isStream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
          res.write(`data: ${JSON.stringify({ id: taskId, object: 'chat.completion.chunk', created, model: model.id, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: taskId, object: 'chat.completion.chunk', created, model: model.id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          sendJSON(res, 200, {
            id: taskId, object: 'chat.completion', created, model: model.id,
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage
          });
        }
        return;
      }

      sendJSON(res, 500, { error: `模型 ${model.id} 的 transport "${model.transport}" 暂不支持` });
      return;
    }

    // ── 会议/讨论 API ──
    if (p === '/api/discuss' && req.method === 'POST') {
      const body = await readBody(req);
      // 入参硬化:topic 必须是非空字符串;participants 非数组视为未指定(防会议已落盘但执行器未启动的孤儿会议占满并发闸门)
      if (!body.topic || typeof body.topic !== 'string') { sendJSON(res, 400, { error: '缺少或非法 topic(须为非空字符串)' }); return; }
      if (body.participants != null && !Array.isArray(body.participants)) body.participants = null;
      const allTools = await getAllTools();
      // 并发讨论会闸门:放在所有 await 之后、createMeeting 之前,消除检查与落盘之间的时间窗
      const inflightMeetings = (store.loadMemory().meetings || []).filter(m => m.status === 'discussing' || m.status === 'active' || m.status === 'implementing').length;
      if (inflightMeetings >= CONFIG.MAX_CONCURRENT_MEETINGS) {
        sendJSON(res, 429, { error: `并发讨论会已达上限(${CONFIG.MAX_CONCURRENT_MEETINGS}),请等待现有讨论结束` });
        return;
      }
      const participants = body.participants && body.participants.length > 0
        ? body.participants.map(n => resolveToolReference(n, allTools)).filter(t => t?.available && isToolEnabled(t)).map(t => t.name)
        : allTools.filter(t => t.available && isToolEnabled(t)).map(t => t.name);

      if (participants.length === 0) { sendJSON(res, 400, { error: '没有可用的参与工具' }); return; }

      // 自动止损预算:调用方可通过 max_tokens/max_ms 收紧(只能收紧不能放宽,受 CONFIG 硬顶约束)
      const meetingMaxTokens = Math.min(CONFIG.MAX_MEETING_TOKENS, Number.isFinite(body.max_tokens) ? Math.max(0, body.max_tokens) : CONFIG.MAX_MEETING_TOKENS);
      const meetingMaxMs = Math.min(CONFIG.MEETING_MAX_MS, Number.isFinite(body.max_ms) ? Math.max(0, body.max_ms) : CONFIG.MEETING_MAX_MS);

      // 异步讨论:立即返回 meetingId,后台逐轮执行
      const meeting = store.createMeeting(body.topic, participants);
      // 元数据真正落盘:load→找到该会议→赋值→save(原先改游离对象再 save(loadMemory()) 是空操作)
      {
        const mem = store.loadMemory();
        const m = mem.meetings.find(x => x.id === meeting.id);
        if (m) {
          m.status = 'discussing';
          m.round = 0;
          m.guidance = body.guidance || '';
          m.round2Guidance = body.round2_guidance || '';
          m.round2 = body.round2 !== false;
          m.implement = body.implement || false;
          store.saveSync('memory', mem);
        }
      }
      METRICS.meetingsStarted++;
      log('info', `会议 ${meeting.id} 创建(异步), 话题: "${body.topic.substring(0, 60)}", 参与者: ${participants.join(', ')}`);

      // 后台执行讨论(不阻塞 HTTP 响应)
      runDiscussionAsync(meeting.id, body.topic, participants, body.guidance || '', body.round2_guidance || '', body.round2 !== false, body.implement || false, meetingMaxTokens, meetingMaxMs)
        .catch(e => log('error', `会议 ${meeting.id} 异步执行失败: ${e.message}`));

      sendJSON(res, 200, {
        meetingId: meeting.id,
        topic: body.topic,
        participants,
        status: 'discussing',
        messageCount: 0,
        totalTokens: 0,
        budget: { maxTokens: meetingMaxTokens, maxMs: meetingMaxMs },
        message: '讨论已启动,用 GET /api/discuss/status/' + meeting.id + ' 查看进度'
      });
      return;
    }

    // ── 讨论状态查询 ──
    if (p.startsWith('/api/discuss/status/') && req.method === 'GET') {
      const meetingId = p.split('/').pop();
      const meeting = store.getMeeting(meetingId);
      if (!meeting) { sendJSON(res, 404, { error: '会议不存在' }); return; }
      sendJSON(res, 200, {
        meetingId: meeting.id,
        topic: meeting.topic,
        status: meeting.status,
        round: meeting.round || 0,
        participants: meeting.participants,
        messageCount: (meeting.messages || []).length,
        messages: meeting.messages,
        totalTokens: meeting.totalTokens || 0,
        interrupted: meeting.interrupted || false,
        interruptReason: meeting.interruptReason || null,
        summary: meeting.summary || null
      });
      return;
    }

    // ── 当前活跃讨论 ──
    if (p === '/api/discuss/active' && req.method === 'GET') {
      const mem = store.loadMemory();
      const active = (mem.meetings || []).filter(m => m.status === 'discussing' || m.status === 'active');
      sendJSON(res, 200, { meetings: active, count: active.length });
      return;
    }

    // ── 讨论控制:中断 ──
    if (p === '/api/discuss/interrupt' && req.method === 'POST') {
      const body = await readBody(req);
      const mem = store.loadMemory();
      const meeting = mem.meetings.find(m => m.id === body.meetingId);
      if (!meeting) { sendJSON(res, 404, { error: '会议不存在' }); return; }
      meeting.interrupted = true;
      meeting.interruptReason = body.reason || '用户手动中断';
      meeting.status = 'interrupted';
      store.saveSync('memory', mem);
      db.recordMeeting(meeting); // 终态写穿全局库
      log('info', `会议 ${body.meetingId} 被中断: ${body.reason || '手动'}`);
      sendJSON(res, 200, { success: true, meetingId: body.meetingId, reason: meeting.interruptReason, messages: meeting.messages });
      return;
    }

    // ── 讨论控制:注入 ──
    if (p === '/api/discuss/inject' && req.method === 'POST') {
      const body = await readBody(req);
      const mem = store.loadMemory();
      const meeting = mem.meetings.find(m => m.id === body.meetingId);
      if (!meeting) { sendJSON(res, 404, { error: '会议不存在' }); return; }
      if (meeting.status === 'closed' || meeting.status === 'interrupted') {
        sendJSON(res, 400, { error: '会议已' + meeting.status });
        return;
      }
      // 注入主持人消息
      meeting.messages.push({ ts: new Date().toISOString(), speaker: '主持人', content: body.message || '', injected: true });
      // 更新 guidance 供下一轮使用
      if (meeting.guidance) {
        meeting.guidance += '\n' + body.message;
      } else {
        meeting.guidance = body.message;
      }
      store.saveSync('memory', mem);
      log('info', `会议 ${body.meetingId} 主持人注入: ${(body.message || '').substring(0, 60)}`);
      sendJSON(res, 200, { success: true, meetingId: body.meetingId, message: '注入成功,下一轮生效' });
      return;
    }

    if (p === '/api/meetings' && req.method === 'GET') {
      const limit = Math.max(1, parseInt(url.searchParams.get('limit') || '10') || 10);
      sendJSON(res, 200, { meetings: store.getRecentMeetings(limit) });
      return;
    }

    sendJSON(res, 404, { error: 'Not found' });
  } catch (err) {
    // 全局兜底:任何异常不崩溃服务
    METRICS.errors5xx++;
    console.error(`[ai-bridge] 未捕获异常: ${err.message}\n${err.stack}`);
    try { sendJSON(res, 500, { error: '内部错误' }); } catch (_) {}
  }
});

server.listen(CONFIG.PORT, CONFIG.HOST, () => {
  console.log(`[ai-bridge] HTTP 服务已启动: http://${CONFIG.HOST}:${CONFIG.PORT}`);
  console.log(`[ai-bridge] Web UI: 浏览器打开 http://${CONFIG.HOST}:${CONFIG.PORT}`);
  console.log(`[ai-bridge] 鉴权: ${CONFIG.AUTH_TOKEN ? '已启用' : '未启用(设置 AI_BRIDGE_TOKEN 环境变量启用)'}`);
  console.log(`[ai-bridge] 并发上限: ${CONFIG.MAX_CONCURRENT_DISPATCH}`);
});

// ── 清理超长 prompt 落盘等异常退出遗留的任务目录(>24h；正常路径 CliAdapter 执行后自删) ──
// 匹配白名单逻辑见 output-cleaner.js;prefixes 每次调用现算,兼容 kimi 热更新新增工具名
const CLEANUP_ROOTS = [
  path.join(__dirname, 'output'), // ai-bridge/output(现行统一输出根)
  path.join(__dirname, '..', 'output') // 仓库根 output(旧进程 cwd 漂移时期遗留)
];
function runOutputCleanup () {
  return cleanupStaleTaskDirs({ roots: CLEANUP_ROOTS, prefixes: TOOLS.map(t => t.name) });
}
runOutputCleanup();
setInterval(runOutputCleanup, 3600 * 1000).unref();

// ── qidi-code 配置自动同步:桥接模型清单(models.json + kimi-code 自动条目)变化时重写 qidi config.toml ──
try {
  qidiSync.startAutoSync({ loadModels: loadAllModels, modelEnabled, log });
} catch (e) {
  log('error', `qidi-sync 启动失败: ${e.message}`);
}

// ── 异步讨论执行器(带顶层 try/catch/finally) ──

async function runDiscussionAsync(meetingId, topic, participants, guidance, round2Guidance, doRound2, doImplement, maxTokens = CONFIG.MAX_MEETING_TOKENS, maxMs = CONFIG.MEETING_MAX_MS) {
  let totalTokens = 0; // 累计实际 token
  const meetingStart = Date.now();
  let autoStop = null; // 非空则记录自动止损原因(token 预算/时长超限)

  // 自动止损判定:token 预算优先,其次壁钟时长;返回原因字符串或 null
  function overBudget () {
    if (totalTokens >= maxTokens) return `token 预算耗尽(${totalTokens}/${maxTokens})`;
    if (Date.now() - meetingStart >= maxMs) return `时长超限(${Math.round((Date.now() - meetingStart) / 1000)}s/${Math.round(maxMs / 1000)}s)`;
    return null;
  }

  function updateMeeting(updates) {
    const mem = store.loadMemory();
    const meeting = mem.meetings.find(m => m.id === meetingId);
    if (!meeting) return null;
    Object.assign(meeting, updates);
    store.saveSync('memory', mem);
    return meeting;
  }

  function checkInterrupted() {
    const mem = store.loadMemory();
    const meeting = mem.meetings.find(m => m.id === meetingId);
    return meeting && (meeting.interrupted || meeting.status === 'interrupted');
  }

  function closeMeeting(summary) {
    updateMeeting({ totalTokens }); // 先把最终 token 落盘,再关会写穿 DB(修:原时序颠倒导致 SQLite 副本 total_tokens 永久少记)
    store.closeMeeting(meetingId, summary);
    db.recordMeeting(store.getMeeting(meetingId)); // 终态写穿全局库(跨重启可查)
  }

  // 自动止损收尾:标注中断原因 + 记一条系统消息 + 关闭会议
  function finalizeAutoStop (reason) {
    METRICS.meetingsAutoStopped++;
    updateMeeting({ interrupted: true, interruptReason: '自动止损: ' + reason });
    store.addMessage(meetingId, '系统', `(自动止损: ${reason},讨论提前结束)`);
    closeMeeting(`自动止损: ${reason}, ${totalTokens} tokens`);
    log('warn', `会议 ${meetingId} 自动止损: ${reason}`);
  }

  try {
    // 第一轮
    updateMeeting({ round: 1, status: 'discussing' });
    log('info', `会议 ${meetingId} 第一轮开始`);
    const round1Results = {};

    for (const name of participants) {
      if (checkInterrupted()) { log('info', `会议 ${meetingId} 第一轮被中断`); break; }
      autoStop = overBudget();
      if (autoStop) { log('warn', `会议 ${meetingId} 第一轮触发自动止损: ${autoStop}`); break; }
      const mem = store.loadMemory();
      const mtg = mem.meetings.find(m => m.id === meetingId);
      const currentGuidance = mtg?.guidance || guidance;
      const gText = currentGuidance ? `\n\n【主持人指示】: ${currentGuidance}` : '';

      try {
        const result = await executeTool(name, `你正在参加一个 AI 技术讨论会。\n\n话题: ${topic}${gText}\n\n请给出你的技术观点和方案,简洁有料。`, { taskId: `${name}_${meetingId}_r1_${Date.now()}` });
        if (isEmptyOutput(result)) throw new Error('空产出(无输出)'); // 落入下方既有"发言失败"分支
        const content = result.content.substring(0, 2000);
        store.addMessage(meetingId, name, content);
        round1Results[name] = { content, tokens: result.tokens.total };
        totalTokens += result.tokens.total;
        log('debug', `会议 ${meetingId}: ${name} 第一轮发言完成, ${result.tokens.total} tokens`);
      } catch (e) {
        store.addMessage(meetingId, name, `(发言失败: ${e.message})`);
        round1Results[name] = { content: `(发言失败: ${e.message})`, tokens: 0 };
      }
    }
    updateMeeting({ totalTokens }); // 每轮结束持久化一次 token(避免每位发言者触发两次全量重写)

    if (autoStop) { finalizeAutoStop(autoStop); return; }
    if (checkInterrupted()) {
      closeMeeting(`第一轮后被中断, ${totalTokens} tokens`);
      log('info', `会议 ${meetingId} 被中断`);
      return;
    }

    // 第二轮
    if (doRound2 && Object.keys(round1Results).length > 1) {
      updateMeeting({ round: 2 });
      log('info', `会议 ${meetingId} 第二轮开始`);

      for (const name of participants) {
        if (checkInterrupted()) { log('info', `会议 ${meetingId} 第二轮被中断`); break; }
        autoStop = overBudget();
        if (autoStop) { log('warn', `会议 ${meetingId} 第二轮触发自动止损: ${autoStop}`); break; }

        const othersText = Object.entries(round1Results)
          .filter(([speaker]) => speaker !== name)
          .filter(([, r]) => r.content && !r.content.startsWith('(发言失败'))
          .map(([speaker, r]) => `${speaker}: ${r.content.substring(0, 500)}`)
          .join('\n\n');

        if (!othersText) continue;

        // 拼接全部注入消息 + round2_guidance(不再二选一)
        const mem = store.loadMemory();
        const mtg = mem.meetings.find(m => m.id === meetingId);
        const injectedMsgs = (mtg?.messages || []).filter(m => m.injected);
        let injectText = '';
        if (injectedMsgs.length > 0) {
          injectText = '\n\n【主持人指示(全部)】:\n' + injectedMsgs.map(m => `- ${m.content}`).join('\n');
        }
        if (round2Guidance) {
          injectText += `\n\n【主持人补充】: ${round2Guidance}`;
        }

        try {
          const result = await executeTool(name, `你正在参加一个 AI 技术讨论会。\n\n话题: ${topic}\n\n以下是其他参与者的观点:\n\n${othersText}${injectText}\n\n请基于讨论,给出你的补充意见或最终结论。`, { taskId: `${name}_${meetingId}_r2_${Date.now()}` });
          if (isEmptyOutput(result)) throw new Error('空产出(无输出)'); // 落入下方既有"发言失败"分支
          store.addMessage(meetingId, name, result.content.substring(0, 2000));
          totalTokens += result.tokens.total;
        } catch (e) {
          store.addMessage(meetingId, name, `(第二轮发言失败: ${e.message})`);
        }
      }
      updateMeeting({ totalTokens }); // 每轮结束持久化一次 token
    }

    if (autoStop) { finalizeAutoStop(autoStop); return; }
    if (checkInterrupted()) {
      closeMeeting(`第二轮后被中断, ${totalTokens} tokens`);
      return;
    }

    // 自动实现前再验一次预算(时长可能在等待中超限)
    const preImplStop = overBudget();
    if (preImplStop) { finalizeAutoStop(preImplStop); return; }

    // 共识引擎:讨论正常结束后自动生成共识总结(结论/分歧/行动项),沉淀到经验库供 memory_search 复用
    const speeches = (store.getMeeting(meetingId)?.messages || []).filter(m => m.content && !m.content.startsWith('(') && m.speaker !== '主持人' && m.speaker !== '系统');
    let consensus = null;
    if (speeches.length >= 2 && !overBudget()) {
      try {
        const digest = speeches.map(m => `【${m.speaker}】: ${m.content.substring(0, 800)}`).join('\n\n');
        const sumResult = await executeTool(participants[0], `你是会议主持人。请对以下 AI 讨论会做共识总结,输出三部分:1)达成的结论 2)主要分歧 3)行动项。简洁列点。\n\n话题: ${topic}\n\n讨论记录:\n${digest}`, { taskId: `consensus_${meetingId}_${Date.now()}` });
        totalTokens += sumResult.tokens.total || 0;
        consensus = sumResult.content.substring(0, 2000);
        store.addMessage(meetingId, '共识总结', consensus);
        store.writeExperience('会议共识', `话题: ${topic}\n${consensus}`, ['讨论会', '共识']);
        log('info', `会议 ${meetingId} 共识总结完成, ${sumResult.tokens.total} tokens`);
      } catch (e) {
        store.addMessage(meetingId, '系统', `(共识总结失败: ${e.message})`);
      }
    }

    // 共识度评分:共识总结产出后,请每位参与者对共识表态(赞成/有保留/反对),量化收敛程度
    if (consensus && participants.length >= 2 && !overBudget()) {
      const votes = [];
      for (const name of participants) {
        if (checkInterrupted()) break;
        if (overBudget()) break;
        try {
          const vResult = await executeTool(name, `以下是关于"${topic}"的讨论共识总结:\n\n${consensus.substring(0, 1200)}\n\n请你对这份共识表态,第一行只写:赞成 / 有保留 / 反对,第二行用一句话说明理由。`, { taskId: `vote_${name}_${meetingId}_${Date.now()}` });
          totalTokens += vResult.tokens.total || 0;
          const firstLine = (vResult.content.split('\n').find(l => l.trim()) || '').trim();
          const stance = /赞成/.test(firstLine) ? '赞成' : /反对/.test(firstLine) ? '反对' : /保留/.test(firstLine) ? '有保留' : '未表态';
          votes.push({ tool: name, stance, reason: vResult.content.split('\n').slice(1).join(' ').trim().substring(0, 200) });
        } catch (e) {
          votes.push({ tool: name, stance: '未表态', reason: `(表态失败: ${e.message.substring(0, 100)})` });
        }
      }
      if (votes.length > 0) {
        const approve = votes.filter(v => v.stance === '赞成').length;
        const consensusScore = Math.round((approve / votes.length) * 100);
        const voteDigest = votes.map(v => `${v.tool}: ${v.stance}${v.reason ? ' — ' + v.reason : ''}`).join('\n');
        store.addMessage(meetingId, '共识度', `共识度 ${consensusScore}%(${approve}/${votes.length} 赞成)\n${voteDigest}`);
        updateMeeting({ consensusScore, consensusVotes: votes });
        log('info', `会议 ${meetingId} 共识度评分: ${consensusScore}%(${approve}/${votes.length})`);
      }
    }

    // 自动实现
    let implResult = null;
    if (doImplement) {
      updateMeeting({ round: 3, status: 'implementing' });
      log('info', `会议 ${meetingId} 开始自动实现`);
      const finalMeeting = store.getMeeting(meetingId);
      const discussionSummary = (finalMeeting.messages || [])
        .filter(m => m.content && !m.content.startsWith('(') && m.speaker !== '主持人')
        .map(m => `【${m.speaker}】: ${m.content}`)
        .join('\n\n');
      const implTask = `基于以下 AI 讨论会的结论,编写完整的代码实现。\n\n讨论话题: ${topic}\n\n讨论记录:\n${discussionSummary}\n\n请根据讨论结论,编写完整可运行的代码。`;
      try {
        implResult = await doDispatch(implTask, participants, true);
        totalTokens += implResult.totalTokens || 0;
        store.addMessage(meetingId, '系统', `自动实现完成: ${implResult.successCount}/${implResult.total} 成功, ${implResult.totalTokens} tokens`);
      } catch (e) {
        store.addMessage(meetingId, '系统', `自动实现失败: ${e.message}`);
      }
    }

    // 完成:用 closeMeeting(补 closedAt;内部已先持久化 totalTokens 再写穿)
    const msgCount = (store.getMeeting(meetingId)?.messages || []).length;
    closeMeeting(`${participants.length} 个参与者, ${msgCount} 条发言, ${totalTokens} tokens${implResult ? ', 实现 ' + implResult.successCount + '/' + implResult.total + ' 成功' : ''}`);
    log('info', `会议 ${meetingId} 结束: ${msgCount} 条发言, ${totalTokens} tokens`);

  } catch (err) {
    // 顶层异常兜底:会议不会卡在 'discussing'
    log('error', `会议 ${meetingId} 异常: ${err.message}\n${err.stack}`);
    store.addMessage(meetingId, '系统', `(会议异常: ${err.message})`);
    closeMeeting(`异常终止: ${err.message}, ${totalTokens} tokens`);
  }
}

// ── AgnesCode llm_request 日志采集 ──
// 文件格式:第一行是请求(model_config+input),后续每行是流式响应 chunk(data.content[])
function readAgnesLLMLogs (opts = {}) {
  const limit = Math.max(1, Math.min(opts.limit || 50, 200));
  const since = opts.since || null;
  try {
    const logDir = path.join(os.homedir(), '.agnes', 'state', 'logs');
    if (!fs.existsSync(logDir)) return [];
    const files = fs.readdirSync(logDir)
      .filter(f => /^llm_request\.\d+\.jsonl$/.test(f))
      .map(f => ({ name: f, path: path.join(logDir, f), mtime: fs.statSync(path.join(logDir, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime);

    const results = [];
    for (const file of files) {
      if (results.length >= limit) break;
      try {
        const lines = fs.readFileSync(file.path, 'utf-8').trim().split('\n').filter(Boolean);
        let currentReq = null;
        let respChunks = [];

        const flush = () => {
          if (!currentReq) return;
          const model = currentReq.model_config?.model_name || currentReq.input?.model || 'unknown';
          const messages = currentReq.input?.messages || [];
          const userMsg = messages.find(m => m.role === 'user');
          const systemMsg = messages.find(m => m.role === 'system');
          const ts = new Date(currentReq._created || Date.now()).toISOString();
          if (since && ts < since) { currentReq = null; respChunks = []; return; }
          // 请求
          results.push({
            ts, direction: 'out', tool: 'agnes-code', source: 'agnes', model,
            content: (userMsg?.content || '').substring(0, 8000),
            system_prompt: (systemMsg?.content || '').substring(0, 2000) || null,
            usage: null
          });
          // 响应（聚合所有 chunk）
          if (respChunks.length > 0) {
            results.push({
              ts, direction: 'in', tool: 'agnes-code', source: 'agnes', model,
              content: respChunks.join('').substring(0, 8000),
              usage: currentReq._usage || null
            });
          }
          currentReq = null;
          respChunks = [];
        };

        for (const line of lines) {
          if (results.length >= limit * 2) break;
          try {
            const entry = JSON.parse(line);
            if (entry.model_config && entry.input) {
              // 新请求行
              flush();
              currentReq = entry;
            } else if (entry.data && entry.data.content) {
              // 响应 chunk
              const chunk = Array.isArray(entry.data.content)
                ? entry.data.content.map(c => c.text || '').join('')
                : String(entry.data.content || '');
              if (chunk) respChunks.push(chunk);
              if (entry.data.created && !currentReq?._created) currentReq._created = entry.data.created * 1000;
              if (entry.usage) currentReq._usage = entry.usage;
            }
          } catch (_) {}
        }
        flush();
      } catch (_) {}
    }
    return results.sort((a, b) => (b.ts || '').localeCompare(a.ts || '')).slice(0, limit);
  } catch (_) { return []; }
}

// ── Graceful shutdown ──
function shutdown (signal) {
  console.log(`[ai-bridge] 收到 ${signal},正在关闭...`);
  isShuttingDown = true;

  // 拒绝新请求,等待活跃 dispatch 完成(最多 10 秒)
  const shutdownTimeout = setTimeout(() => {
    console.log('[ai-bridge] 强制关闭(等待超时)');
    process.exit(1);
  }, 10000);

  // 检查活跃 dispatch
  const checkInterval = setInterval(() => {
    if (activeDispatchCount === 0) {
      clearInterval(checkInterval);
      clearTimeout(shutdownTimeout);

      // 清理客户端
      for (const [name, client] of connectedClients) {
        if (client.pendingReject) client.pendingReject(new Error('服务关闭'));
      }
      connectedClients.clear();

      server.close(() => {
        console.log('[ai-bridge] 已关闭');
        process.exit(0);
      });
    }
  }, 500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGBREAK', () => shutdown('SIGBREAK')); // Windows

// ── 客户端 TTL 清理(每 60 秒清理超过 5 分钟无活动的客户端) ──
setInterval(() => {
  const now = Date.now();
  for (const [name, client] of connectedClients) {
    // 按最后活动时间(lastSeen)判定,持续轮询的活跃客户端不会被误清
    const lastActive = client.lastSeen || new Date(client.connectedAt).getTime();
    if (now - lastActive > CONFIG.CLIENT_TTL && !client.pendingResolve) {
      rememberClientDisconnect(name, client, 'ttl_expired', `超过 ${Math.round((now - lastActive) / 1000)}s 无活动`);
      connectedClients.delete(name);
      log('warn', `清理超时客户端(${Math.round((now - lastActive) / 1000)}s 无活动): ${name}`);
    }
  }
}, 60000);

// ── 全局库:启动时标记重启前遗留的孤儿异步任务(执行进度已丢,不谎报 running) ──
const orphanedTasks = db.markOrphanTasks();
if (orphanedTasks > 0) log('warn', `启动时标记 ${orphanedTasks} 个孤儿异步任务(中枢重启导致执行中断)`);
try {
  const sweptMeetings = store.markOrphanMeetings();
  if (sweptMeetings.length > 0) {
    sweptMeetings.forEach(m => db.recordMeeting(m)); // 终态写穿全局库,与人工中断路径同形
    log('warn', `启动时清扫 ${sweptMeetings.length} 个孤儿会议(中枢重启导致讨论中断,已标记 interrupted 并释放并发闸门额度)`);
  }
} catch (e) {
  // 启动期任何数据异常都不得阻止进程起来:崩溃遗留会触发 watchdog 重启至熔断=整体不可用
  log('error', `启动清扫孤儿会议异常已忽略(不影响中枢启动): ${e.message}`);
}
if (db.available) console.log(`[ai-bridge] 全局库已就绪: ${db.dbPath}`);
else console.warn(`[ai-bridge] ⚠️ 全局库不可用(不影响主链路): ${db.stats().lastError || 'unknown'}`);

// ── 启动时鉴权警告 ──
if (!CONFIG.AUTH_TOKEN) {
  console.warn('[ai-bridge] ⚠️ 警告: 未设置 AI_BRIDGE_TOKEN,API 无鉴权保护! 设置环境变量启用鉴权。');
}
