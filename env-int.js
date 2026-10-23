'use strict';

/**
 * env 整数钳制的单一实现(#49a F1)。
 *
 * 病根:`parseInt(process.env.X, 10) || 默认` 对 0/非数字会落默认,但**负数原样直通**——
 * 实测 http.request({timeout:-1}) 同步抛 ERR_OUT_OF_RANGE:一个手滑的负数让桥彻底失联,
 * 且 stderr 零归因。仓内原有语义正确的 parsePositiveInt(server.js:57)早已存在却无人调用。
 * 本模块把它归一为单一实现,并补上"非法值留痕"(F2):env 已设置却解析不出合法值时,
 * 向 stderr 写一条 warn(同时含变量名与"非法/回落"字样);未设置该 env 则静默落默认,不噪音告警。
 */

// 核心归一:allowZero=false 要求 >0(F1 正整数语义);
// allowZero=true 要求 >=0(如 AI_BRIDGE_DAILY_TOKEN_BUDGET 的"0=不设预算"特例,F3)。
function _normalizeEnvInt (v, def, name, allowZero) {
  const n = parseInt(v);
  const valid = Number.isFinite(n) && (allowZero ? n >= 0 : n > 0);
  // 仅当"env 已设置(非 undefined/空串)"且非法、且调用方提供了变量名时才留痕,避免噪音告警。
  if (!valid && name != null && v !== undefined && v !== '') {
    const rule = allowZero ? '必须为非负整数' : '必须为正整数';
    console.error(`[env] ${name} 非法值 "${v}"（${rule}），回落默认 ${def}`);
  }
  return valid ? n : def;
}

/**
 * 正整数归一:非有限值 / 0 / 负数一律回落 def(语义等价原 server.js parsePositiveInt)。
 * @param {*} v process.env 原始值(可能 undefined)
 * @param {number} def 默认值
 * @param {string} [name] 变量名;提供时,env 已设置却非法会向 stderr 留痕 warn
 */
function parsePositiveInt (v, def, name) {
  return _normalizeEnvInt(v, def, name, false);
}

/**
 * 非负整数归一:允许 0(用于"0=不设上限"语义的 env,如 AI_BRIDGE_DAILY_TOKEN_BUDGET,F3)。
 * 负数 / 非有限值回落 def,并(传 name 时)留痕。
 */
function parseNonNegativeInt (v, def, name) {
  return _normalizeEnvInt(v, def, name, true);
}

module.exports = { parsePositiveInt, parseNonNegativeInt };
