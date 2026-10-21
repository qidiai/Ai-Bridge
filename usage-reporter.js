/**
 * T5 — CLI 通道智能体用量自报协议(中枢 <-> CLI 另一端智能体)
 * 派发给 CLI 类型工具的任务追加 USAGE_REPORT_SUFFIX;结果回流时用 parseUsageReport
 * 剥离末行 [USAGE] 自报行并把自报数值转为正式用量(reported:true),优先于 estimateTokens。
 * 连接的客户端(type='client')豁免:MCP sampling 通道已上报真实用量,严禁套用本协议。
 */
'use strict';

const USAGE_REPORT_SUFFIX =
  '\n\n---\n(中枢协议)请在任务全部完成后,于最后一行单独输出用量自报(整数,不要其它文字): ' +
  '[USAGE] input=<输入token数> output=<输出token数> —— 此行仅供中枢统计,会被自动剥离。';

const MARKER_RE = /\[USAGE\]\s*input\s*=\s*(\d+)\s+output\s*=\s*(\d+)/gi;
const MAX_REPORTED = 1e8; // 任一数值超此阈值视为无效自报(仍剥离标记行)

/** 解析并剥离文本中最后一个 [USAGE] 自报行。返回 { content, usage };无标记/无效值时 usage=null(严格 null)。 */
function parseUsageReport (text) {
  if (typeof text !== 'string') return { content: text ?? '', usage: null };
  let m; let last = null;
  while ((m = MARKER_RE.exec(text)) !== null) last = m; // 全量扫描取最后一个匹配(exec 耗尽后 lastIndex 自动复位)
  if (!last) return { content: text, usage: null };

  // 扩展到匹配所在整行:行界按换行界定,ls=行首,le=行尾换行符位置(或文末)
  let ls = last.index;
  while (ls > 0 && text[ls - 1] !== '\n') ls--;
  let le = last.index + last[0].length;
  while (le < text.length && text[le] !== '\n') le++;
  const after = text.slice(le < text.length ? le + 1 : le); // 本行之后(越过其后换行符)的剩余文本
  let content;
  if (after.trim() === '') {
    // 末行(其后无非空白内容):连同前面的 \r?\n 一并剥离
    let cut = ls;
    if (cut > 0 && text[cut - 1] === '\n') cut--;
    if (cut > 0 && text[cut - 1] === '\r') cut--;
    content = text.slice(0, cut);
  } else {
    content = text.slice(0, ls) + after; // 非末行:仅剥离该标记行本身
  }

  const input = Number(last[1]); const output = Number(last[2]);
  if (input > MAX_REPORTED || output > MAX_REPORTED) return { content, usage: null };
  return { content, usage: { input, output, total: input + output, reported: true } };
}

module.exports = { USAGE_REPORT_SUFFIX, parseUsageReport };
