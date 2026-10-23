'use strict';

/**
 * #47 SSE 回放合成器(纯函数、零依赖、不 require 项目内任何其他模块)
 *
 * 职责:把幂等缓存里存的非流式 chat.completion JSON(缓存唯一写入形状,
 * 见 server.js `if (!isStream) ... cacheSet(ck, data)`)合成为流式客户端
 * 能解析的合法 SSE 文本流。
 *
 * 历史 bug(红基线 a2194ee):流式命中时直接 `res.write(cached.value)` 把 JSON
 * 原文写进 text/event-stream 响应 —— SSE 解析器会丢弃所有无 `data:` 前缀的行,
 * 客户端看到空流却被告知 X-Cache: HIT「成功」。
 *
 * 帧契约(#47a1~a3 锁):
 *   data: {"object":"chat.completion.chunk",...,"choices":[{"index":0,"delta":{"role":"assistant","content":"<逐字>"},...}]}
 *   data: {"object":"chat.completion.chunk",...,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{原样}}
 *   data: [DONE]
 * 每帧以 `data: ` 开头、`\n\n` 分帧,末帧固定 `data: [DONE]`;不改写内容、
 * 不丢 id/created、usage 原键名原内容透传(供 #45 账本与预算闸门)。
 *
 * tool_calls 的流式回放本单不做(S3):isReplayableJson 将其判为不可回放,
 * 由调用方逐出缓存转发生上游。
 */

// 缓存值(Buffer/string)→ 解析后的对象;任何解析失败返回 null,绝不抛异常
function parseCached (body) {
  let text = null;
  if (Buffer.isBuffer(body)) text = body.toString('utf-8');
  else if (typeof body === 'string') text = body;
  if (text === null || text.length === 0) return null;
  try {
    const obj = JSON.parse(text);
    return (obj && typeof obj === 'object') ? obj : null;
  } catch (_) {
    return null;
  }
}

// 可回放充要条件:能解析为对象 + choices 非空数组 + choices[0].message 为对象
// + message.tool_calls 不存在或为空 + message.content 是字符串或 null。
// 任何一条不满足(含 undefined/坏 Buffer/非法 JSON)→ false,不抛异常。
function isReplayableJson (body) {
  const obj = parseCached(body);
  if (!obj) return false;
  if (!Array.isArray(obj.choices) || obj.choices.length === 0) return false;
  const ch0 = obj.choices[0];
  if (!ch0 || typeof ch0 !== 'object') return false;
  const msg = ch0.message;
  if (!msg || typeof msg !== 'object') return false;
  const tc = msg.tool_calls;
  if (tc !== undefined && tc !== null) {
    if (!Array.isArray(tc) || tc.length > 0) return false;
  }
  return typeof msg.content === 'string' || msg.content === null;
}

// 非流式 chat.completion → 合法 SSE(两帧数据 + [DONE])。
// 输入不可回放时行为未定义(调用方必须先判 isReplayableJson);防御性地
// 返回仅含 `data: [DONE]\n\n` 的字符串,保证坏输入不崩进程、不吐畸形正文。
function sseFromChatJson (body, opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const DONE = 'data: [DONE]\n\n';
  const obj = parseCached(body);
  if (!obj) return DONE;
  if (!Array.isArray(obj.choices) || obj.choices.length === 0) return DONE;
  const ch0 = obj.choices[0];
  if (!ch0 || typeof ch0 !== 'object' || !ch0.message || typeof ch0.message !== 'object') return DONE;
  // model 取原件原值,缺省(空串/缺失)时才用 opts.model 兜底
  const model = obj.model || o.model;
  const chunk1 = {
    id: obj.id,
    object: 'chat.completion.chunk',
    created: obj.created,
    model,
    choices: [{ index: 0, delta: { role: 'assistant', content: ch0.message.content }, finish_reason: null }]
  };
  const chunk2 = {
    id: obj.id,
    object: 'chat.completion.chunk',
    created: obj.created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: ch0.finish_reason || 'stop' }]
  };
  // usage 原键名原内容挂在末帧上(原件没有就不造,不注入估算值)
  if (obj.usage) chunk2.usage = obj.usage;
  return `data: ${JSON.stringify(chunk1)}\n\ndata: ${JSON.stringify(chunk2)}\n\n${DONE}`;
}

module.exports = { isReplayableJson, sseFromChatJson };
