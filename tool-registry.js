'use strict';

/**
 * tool-registry.js — 工具注册表（配置驱动）
 *
 * 从 tools.json 加载工具配置，按 transport 字段创建对应适配器实例。
 * 新增工具只需在 tools.json 加一段配置，不改代码。
 *
 * 导出（向后兼容，server.js / bridge-stdio.js 依赖）:
 *   - TOOLS:       适配器实例数组（每个有 name/displayName/description/detect/execute）
 *   - findInPath:  PATH 可执行探测
 *   - estimateTokens:  中文友好 token 估算
 *   - extractCodeBlocks: 代码块提取
 *   - getLoadDiagnostics: #46 tools.json 加载诊断（server.js 据此把降级事实落进 logs.jsonl）
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const { BaseAdapter, estimateTokens, extractCodeBlocks } = require('./adapters/base');
const { CliAdapter } = require('./adapters/cli-adapter');
const { HttpAdapter } = require('./adapters/http-adapter');
const { getKimiToolConfigs, kimiConfigPath } = require('./kimi-models');

// ============================================================
// Routing Marker Adapter（agnes-mcp 专用，不 spawn 进程）
// ============================================================
class RoutingMarkerAdapter extends BaseAdapter {
  constructor (config) { super(config); }
  async detect () { return true; }
  async execute (task) {
    return {
      content: `[AGNES_TASK]\n${task}\n[END_AGNES_TASK]\n\n⚠️ This task is routed to Agnes for direct handling. Do not forward to other AI tools.`,
      codeBlocks: [],
      usage: { input: estimateTokens(task), output: 0, total: estimateTokens(task), estimated: true }
    };
  }
}

// ============================================================
// 从 tools.json 加载工具 + 自动同步 Kimi Code 模型
// ============================================================
function buildAdapter (config) {
  switch (config.transport) {
    case 'cli': return new CliAdapter(config);
    case 'http': return new HttpAdapter(config);
    case 'routing-marker': return new RoutingMarkerAdapter(config);
    default: return null;
  }
}

function addConfigs (tools, seen, configs) {
  for (const config of configs) {
    if (!config || !config.name || seen.has(config.name)) continue; // 静态配置优先，同名去重
    try {
      const adapter = buildAdapter(config);
      if (!adapter) {
        console.warn(`[tool-registry] 未知 transport "${config.transport}" for tool "${config.name}"，跳过`);
        continue;
      }
      if (config.autoSync) adapter.autoSync = config.autoSync;
      seen.add(config.name);
      tools.push(adapter);
    } catch (e) {
      console.error(`[tool-registry] 加载工具 "${config.name}" 失败: ${e.message}`);
    }
  }
}

// ── #46 加载期诊断:tools.json 损坏只能降级功能,绝不能阻止进程起来(与 store P0/#52/#44 同尺)──
//   留痕在本模块内的诊断状态,由 server.js 消费后落进 logs.jsonl(#46a4)。
//   本模块不得为此新增对 store.js 的引用(#46a4):bridge-stdio.js:12 也 require tool-registry,
//   一旦加上 store 依赖,每个 MCP 桥进程都会在加载期 mkdir 数据目录。
//   损坏原件必须原样留在原处:不改名、不覆写、不隔离(#46a5;P0 的 .corrupt-* 隔离只用于运行数据)。
const DIAG_ERROR_MAX = 200; // 原因摘要上限,与 #54/#74 的 causeOf 同尺:压换行、超长取尾部并保留开头错误码

/** 有界原因摘要:SyntaxError/EBUSY 这类第一顺位归因(开头的错误码/异常名)不得被截掉 */
function boundedReason (e) {
  const msg = String((e && e.message) || e || '').replace(/\s+/g, ' ').trim();
  if (!msg) return '未知故障（无异常信息）';
  if (msg.length <= DIAG_ERROR_MAX) return msg;
  const codeMatch = /^[A-Z]+(?=:| )/.exec(msg);
  const prefix = codeMatch ? codeMatch[0] + ': ' : '';
  return prefix + '…' + msg.slice(-(DIAG_ERROR_MAX - prefix.length - 1));
}

// 诊断状态:仅在每次 loadTools() 后整体更新;kimi 热更新(resyncKimiTools)走自身 try/catch,不得写这里。
// { status: 'ok'|'missing'|'corrupt-parse'|'corrupt-shape', error: string|null, file: basename, entryCount: number }
let lastLoadDiag = { status: 'missing', error: null, file: 'tools.json', entryCount: 0 };

/** tools.json 加载诊断(导出给 server.js 落账;返回副本防调用方改内部状态) */
function getLoadDiagnostics () {
  return { ...lastLoadDiag };
}

function loadTools () {
  const configPath = path.join(__dirname, 'tools.json');
  const tools = [];
  const seen = new Set();
  let status = 'ok';
  let error = null;
  let entryCount = 0;
  if (!fs.existsSync(configPath)) {
    // 文件不存在是合法部署态:保持现状语义(仅 warn、不算损坏、不写 error 级留痕)
    status = 'missing';
    console.warn('[tool-registry] tools.json 不存在，仅加载自动同步工具');
  } else {
    let configs = null;
    try {
      // 读文件 + JSON.parse 整体纳入保护:EBUSY/EPERM 一类读错误与 store P0
      // "读不确定即不覆写"同尺 —— 保守当损坏,绝不让它抛穿模块加载期
      configs = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (e) {
      status = 'corrupt-parse';
      error = boundedReason(e);
    }
    if (status === 'ok' && !Array.isArray(configs)) {
      // 能解析但顶层不是数组:null/数字/字符串/对象都算([] 是合法空配置,不走这支)
      status = 'corrupt-shape';
      error = `顶层形状非法：期望 JSON 数组，实际为 ${configs === null ? 'null' : typeof configs}`;
    }
    if (status === 'ok') {
      entryCount = configs.length; // 本次实际交给 addConfigs 的静态条目数(损坏时为 0)
      addConfigs(tools, seen, configs);
    } else {
      // 两种 corrupt-* 后果一致:静态工具集按空处理、绝不抛、原件原样在、照常继续加载 kimi 自动同步工具
      console.error(`[tool-registry] tools.json ${status === 'corrupt-parse' ? '解析失败' : '顶层形状非法'}，静态工具全部缺席、仅剩自动同步工具；原件未被改动，需人工修复: ${error}`);
    }
  }
  lastLoadDiag = { status, error, file: path.basename(configPath), entryCount };
  // 自动同步 Kimi Code 模型（kimi-code 更新模型后无需手工改 tools.json）
  addConfigs(tools, seen, getKimiToolConfigs());
  return tools;
}

const TOOLS = loadTools();

// kimi-code config.toml 热更新：模型增删后自动重同步 dispatch 工具（原地变更 TOOLS，server.js 引用立即可见）
// 幂等：名单一致时不动 TOOLS；kimi-models 在配置暂不可读时回退旧结果，配合本比较不会把工具洗空
function resyncKimiTools () {
  try {
    const configs = getKimiToolConfigs();
    const current = TOOLS.filter(t => t.autoSync === 'kimi-code').map(t => t.name).join(',');
    const next = new Set(TOOLS.filter(t => t.autoSync !== 'kimi-code').map(t => t.name));
    const wanted = configs.filter(c => c && c.name && !next.has(c.name)).map(c => c.name).join(',');
    if (current === wanted) return; // 无变化（含配置不可读时回退旧结果的情形）
    for (let i = TOOLS.length - 1; i >= 0; i--) {
      if (TOOLS[i].autoSync === 'kimi-code') TOOLS.splice(i, 1);
    }
    addConfigs(TOOLS, next, configs);
    console.log('[tool-registry] kimi-code 模型工具已热更新');
  } catch (e) {
    console.error(`[tool-registry] kimi-code 热更新失败: ${e.message}`);
  }
}

try {
  const kimiCfg = kimiConfigPath();
  if (fs.existsSync(kimiCfg)) {
    let timer = null;
    fs.watch(kimiCfg, () => {
      clearTimeout(timer);
      timer = setTimeout(resyncKimiTools, 1000); // 防抖：编辑器可能多次触发
    });
  }
} catch (e) {
  console.error(`[tool-registry] kimi-code config 监听失败: ${e.message}`);
}

// 兜底轮询：fs.watch 事件丢失（如原子替换写、启动时文件尚不存在）时仍能恢复同步
setInterval(resyncKimiTools, 5000).unref();

// ============================================================
// 共享工具函数（向后兼容导出）
// ============================================================

/** Find command in PATH */
async function findInPath (name) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const checker = isWin ? 'where' : 'which';
    const child = spawn(checker, [name], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    let found = '';
    child.stdout.on('data', d => found += d);
    child.on('close', code => resolve(code === 0 && found.trim().length > 0));
    child.on('error', () => resolve(false));
  });
}

module.exports = { TOOLS, findInPath, estimateTokens, extractCodeBlocks, getLoadDiagnostics };
