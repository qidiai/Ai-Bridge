#!/usr/bin/env node
'use strict';

/**
 * AI Bridge 纯单元测试(无文件系统 / 无网络 / 无子进程副作用)
 *
 * 覆盖 tool-registry.js 中 dispatch/handoff 依赖的核心纯函数:
 *   - estimateTokens  : 中文友好 token 估算(token 统计与展示的地基)
 *   - extractCodeBlocks: 代码块解析(dispatch/handoff 产出提取的地基)
 *   - findInPath      : PATH 可执行探测(工具可用性检测的地基,只读、无副作用)
 *
 * 与 test-e2e.mjs(集成级全链路)互补:此处只跑毫秒级纯逻辑,快且可精确定位。
 * 运行:node test-unit.mjs   退出码:0 全通过 / 1 有失败
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { estimateTokens, extractCodeBlocks, findInPath } = require('./tool-registry.js');
const {
  canonicalToolId,
  decorateToolIdentity,
  resolveToolReference,
  switchKeysFor,
  statsKeysFor
} = require('./tool-identity.js');
const {
  parseDurationMs,
  classifyTask,
  bayesianRate,
  wilsonLowerBound,
  buildRoutingProfile,
  rankRoutingProfiles
} = require('./routing-score.js');
const crypto = require('node:crypto');
const { parsePositiveInt, parseNonNegativeInt } = require('./env-int.js');

// codely-client 为可选模块(开源版剔除),缺失时跳过签名测试段
let codelySigningKey = null;
let codelySignature = null;
let codelyCliVersion = null;
let codelyUserAgent = null;
try {
  ({ codelySigningKey, codelySignature, codelyCliVersion, codelyUserAgent } = require('./codely-client.js'));
} catch (e) {
  /* 开源版剔除 codely-client.js:签名测试跳过 */
}

let passed = 0;
let failed = 0;
const failures = [];
function check (name, cond, detail) {
  if (cond) { passed++; process.stdout.write(`  ✅ ${name}\n`); }
  else { failed++; failures.push(name); process.stdout.write(`  ❌ ${name}${detail !== undefined ? ' — ' + detail : ''}\n`); }
}
function section (t) { process.stdout.write(`\n── ${t} ──\n`); }

async function main () {
  process.stdout.write('AI Bridge 纯单元测试\n' + '='.repeat(40) + '\n');

  // ── estimateTokens ──
  section('estimateTokens(中文友好估算)');
  check('空/假值返回 0', estimateTokens('') === 0 && estimateTokens(null) === 0 && estimateTokens(undefined) === 0);
  check('纯 ASCII:按 ÷4 向上取整', estimateTokens('abcdefgh') === 2, '期望 2 实际 ' + estimateTokens('abcdefgh'));
  const cjk3 = estimateTokens('中文字'); // 3 * 1.7 = 5.1 → ceil 6
  check('纯 CJK:按 ×1.7 向上取整', cjk3 === 6, '期望 6 实际 ' + cjk3);
  check('CJK 密度显著高于同长度 ASCII', estimateTokens('这是一段中文测试文本内容') > estimateTokens('abcdefghijkl'));
  check('中英混合 = CJK 部分 + ASCII 部分', estimateTokens('中hello') === Math.ceil(1 * 1.7 + 5 / 4), '实际 ' + estimateTokens('中hello'));
  check('返回值恒为非负整数', Number.isInteger(estimateTokens('混合 mixed 文本 123')) && estimateTokens('x') >= 0);

  // ── extractCodeBlocks ──
  section('extractCodeBlocks(代码块解析)');
  check('空文本返回空数组', Array.isArray(extractCodeBlocks('')) && extractCodeBlocks('').length === 0);
  const one = extractCodeBlocks('说明\n```python\ndef add(a, b):\n    return a + b\n```\n结尾');
  check('单个围栏块:数量正确', one.length === 1);
  check('单个围栏块:语言标签解析', one[0]?.language === 'python');
  check('单个围栏块:代码去除首尾空白', one[0]?.code === 'def add(a, b):\n    return a + b');
  const multi = extractCodeBlocks('```js\nconst a=1;\n```\n中间\n```go\nfunc main(){}\n```');
  check('多个围栏块:全部提取', multi.length === 2 && multi[0].language === 'js' && multi[1].language === 'go');
  const noLang = extractCodeBlocks('```\nplain code\n```');
  check('无语言标签:回退为 text', noLang[0]?.language === 'text');
  const bare = extractCodeBlocks('def foo():\n    pass');
  check('无围栏但含代码特征:整体作为一块', bare.length === 1 && bare[0].language === 'text');
  check('纯散文无代码特征:返回空', extractCodeBlocks('这只是一段普通说明文字,没有代码。').length === 0);

  // ── findInPath(只读探测,无副作用) ──
  section('findInPath(PATH 可执行探测,只读)');
  const nodeFound = await findInPath('node');
  check('能探测到 node(本进程解释器必然在 PATH)', nodeFound === true);
  const ghost = await findInPath('__definitely_not_a_real_cmd_xyz__');
  check('不存在的命令返回 false', ghost === false);

  // ── tool identity（规范身份与执行实例分离） ──
  section('tool identity（canonical ID / alias / 实例隔离）');
  check('atomcode 归一为 atom-code', canonicalToolId('atomcode', 'client') === 'atom-code');
  check('client-openclaw 归一为 openclaw', canonicalToolId('client-openclaw', 'client') === 'openclaw');
  const cliOpenClaw = decorateToolIdentity({ name: 'openclaw', sourceId: 'openclaw', type: 'cli' });
  const clientOpenClaw = decorateToolIdentity({ name: 'client-openclaw', sourceId: 'openclaw', type: 'client' });
  const identityTools = [cliOpenClaw, clientOpenClaw];
  check('同产品不同 transport 生成不同实例 ID', cliOpenClaw.id === 'cli:openclaw' && clientOpenClaw.id === 'client:openclaw');
  check('历史调度名精确解析到客户端实例', resolveToolReference('client-openclaw', identityTools)?.id === 'client:openclaw');
  check('稳定实例 ID 精确解析', resolveToolReference('cli:openclaw', identityTools)?.name === 'openclaw');
  check('精确调度名优先于歧义 sourceId', resolveToolReference('OPENCLAW', identityTools)?.id === 'cli:openclaw');
  const sameSourceTools = [
    decorateToolIdentity({ name: 'foo-cli', sourceId: 'foo', type: 'cli' }),
    decorateToolIdentity({ name: 'foo-client', sourceId: 'foo', type: 'client' })
  ];
  check('仅 sourceId 重名时不猜测 transport', resolveToolReference('foo', sameSourceTools) === null);
  check('客户端开关键不回退到 CLI 裸键', JSON.stringify(switchKeysFor(clientOpenClaw)) === JSON.stringify(['client:openclaw', 'client-openclaw']));
  check('客户端统计键不聚合 CLI 裸键', !statsKeysFor(clientOpenClaw, identityTools).includes('openclaw'));

  // ── composite routing score ──
  section('composite routing score（可解释综合路由）');
  check('耗时字符串可解析为毫秒', parseDurationMs('33.6s') === 33600 && parseDurationMs('250ms') === 250);
  check('任务能力分类可识别 code/review/ops', classifyTask('写一个 Python 函数') === 'code' && classifyTask('请审查这段代码') === 'review' && classifyTask('重启 Docker 服务') === 'ops');
  check('Bayesian 成功率冷启动为中性先验', bayesianRate(0, 0) === 0.5);
  check('Wilson 下界随可靠样本增加', wilsonLowerBound(18, 20) > wilsonLowerBound(1, 1));
  const now = Date.parse('2026-07-29T12:00:00Z');
  const reliableTool = { name: 'reliable', id: 'client:reliable', canonicalId: 'reliable' };
  const fastTool = { name: 'fast', id: 'client:fast', canonicalId: 'fast' };
  const reliableObs = Array.from({ length: 10 }, (_, i) => ({ ts: `2026-07-${String(19 + i).padStart(2, '0')}T12:00:00Z`, task: '写 Python 函数', success: i < 9, duration: '20s', tokens: 1200 }));
  const fastObs = Array.from({ length: 10 }, (_, i) => ({ ts: `2026-07-${String(19 + i).padStart(2, '0')}T12:00:00Z`, task: '写 Python 函数', success: i < 6, duration: '1s', tokens: 100 }));
  const reliableProfile = buildRoutingProfile(reliableTool, reliableObs, {}, now);
  const fastProfile = buildRoutingProfile(fastTool, fastObs, {}, now);
  const qualityRanking = rankRoutingProfiles([fastProfile, reliableProfile], '写一个 Python API');
  check('可靠性优势可压过单纯低时延低 Token', qualityRanking[0]?.tool === 'reliable', JSON.stringify(qualityRanking.map(x => ({ tool: x.tool, score: x.score }))));
  const coldProfile = buildRoutingProfile({ name: 'cold', id: 'client:cold', canonicalId: 'cold' }, [], {}, now);
  const coldRanking = rankRoutingProfiles([coldProfile, reliableProfile], '写代码');
  check('零样本工具不会靠探索奖励压过已验证工具', coldRanking[0]?.tool === 'reliable');
  check('路由结果包含全部可解释分量', ['success', 'capability', 'latency', 'tokenCost', 'freshness', 'stability', 'confidence'].every(k => Number.isFinite(qualityRanking[0]?.components?.[k])));
  const staleObs = reliableObs.map(r => ({ ...r, ts: '2025-01-01T00:00:00Z' }));
  const staleProfile = buildRoutingProfile({ name: 'stale', id: 'client:stale', canonicalId: 'stale' }, staleObs, {}, now);
  check('旧样本的新鲜度显著衰减', staleProfile.freshness < reliableProfile.freshness);
  const failedNow = buildRoutingProfile(
    { name: 'failed-now', id: 'client:failed-now', canonicalId: 'failed-now' },
    [{ ts: '2026-07-29T11:59:00Z', task: '写代码', success: false }],
    {},
    now
  );
  const cooldownRanking = rankRoutingProfiles([failedNow, coldProfile], '写代码');
  check('最近失败工具进入短期冷却且分数归零', failedNow.coolingDown === true && cooldownRanking.at(-1)?.tool === 'failed-now' && cooldownRanking.at(-1)?.score === 0);
  const recovered = buildRoutingProfile(
    { name: 'recovered', id: 'client:recovered', canonicalId: 'recovered' },
    [
      { ts: '2026-07-29T11:50:00Z', task: '写代码', success: false },
      { ts: '2026-07-29T11:59:00Z', task: '写代码', success: true }
    ],
    {},
    now
  );
  check('失败后有更新成功则立即解除冷却', recovered.coolingDown === false && recovered.cooldownUntil === null);

  section('#47 幂等缓存流式回放的帧合成（sse-replay 纯函数 + server.js 命中分支结构锁）');
  {
    // 背景（现状实测）：缓存**只由非流式 200 响应写入**（server.js:2139-2145 `if (!isStream) ... cacheSet`），
    // 而 cacheKey(:227) 不含 stream → 流式请求命中同一 key 时，:2123-2127 把 **JSON 原文**直接
    // `res.write(cached.value)` 写进 `Content-Type: text/event-stream` 响应，再补一行 `data: [DONE]`。
    // 客户端拿到的是"没有 data: 前缀的一坨 JSON + 一个 DONE 帧"= 畸形 SSE（SSE 解析器会直接丢弃非 data: 行 → 空流）。
    // 文档却写"合成单块 SSE"（ARCHITECTURE.md:49）、代码注释也写"流式命中缓存时直接合成单块 SSE 回放"——
    // 这就是 #47 标题里的"文档与实现背离"。修法必须真的合成，且缓存体不可回放时**逐出并转发上游**：
    // 绝不因缓存坏而向用户报错，也绝不静默吐畸形流。
    // 可测性接缝：缓存只能用真签名上游预热（免费额度、网络），故合成逻辑必须是可独立 require 的纯函数模块。
    let replay = null, reqErr = null;
    try { replay = require('./sse-replay.js'); } catch (e) { reqErr = e.code === 'MODULE_NOT_FOUND' ? 'MODULE_NOT_FOUND' : e.message; }
    check('#47a0 纯函数模块 sse-replay.js 必须存在并导出 isReplayableJson / sseFromChatJson',
      !!replay && typeof replay.isReplayableJson === 'function' && typeof replay.sseFromChatJson === 'function',
      reqErr || Object.keys(replay || {}).join(','));

    const OK_JSON = JSON.stringify({
      id: 'chatcmpl-47', object: 'chat.completion', created: 1700000000, model: 'glm-5.3',
      choices: [{ index: 0, message: { role: 'assistant', content: '你好，世界' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
    });
    let frames = null, firstChunk = null, lastChunk = null, rawOut = null;
    if (replay && typeof replay.sseFromChatJson === 'function') {
      rawOut = String(replay.sseFromChatJson(OK_JSON, { model: 'glm-5.3' }));
      frames = rawOut.split('\n\n').filter(x => x.length > 0);
      const dataFrames = frames.filter(x => x.startsWith('data: '));
      // 我自己的 off-by-one(编码手申报 SPEC GAP、我复算成立):#47a1 要求末帧恰为 `data: [DONE]`,
      // 而 #47a3 又要 JSON.parse 末帧取 finish_reason —— 二者互斥,任何正确实现都过不了 a3。
      // 判"末帧必须是 [DONE]"看的是**全部帧**;取"最后一个数据帧"必须先排除 [DONE] 这个控制帧。
      const payloadFrames = dataFrames.filter(f => f !== 'data: [DONE]');
      try { firstChunk = JSON.parse(payloadFrames[0].slice(6)); } catch (_) { firstChunk = null; }
      try { lastChunk = JSON.parse(payloadFrames[payloadFrames.length - 1].slice(6)); } catch (_) { lastChunk = null; }
    }
    check('#47a1 回放每一帧都必须以 `data: ` 开头、以空行分帧、最后一帧严格 `data: [DONE]`（无 data: 前缀的行会被 SSE 解析器丢弃 = 客户端看到空流）',
      Array.isArray(frames) && frames.length >= 2 && frames.every(f => f.startsWith('data: ')) && frames[frames.length - 1] === 'data: [DONE]',
      frames && JSON.stringify(frames.map(f => f.slice(0, 24))));
    check('#47a2 内容不得丢失或改写:首帧 object=chat.completion.chunk、delta.content 与原 message.content 逐字相等、model 原样',
      !!firstChunk && firstChunk.object === 'chat.completion.chunk' && firstChunk.model === 'glm-5.3'
      && firstChunk.choices?.[0]?.delta?.content === '你好，世界',
      firstChunk && JSON.stringify(firstChunk).substring(0, 160));
    check('#47a3 usage 必须随回放透传，且末帧 finish_reason=stop（丢了 usage 就是"看着成功、账上没有"，与 #45 同族）',
      !!rawOut && /"total_tokens"\s*:\s*18/.test(rawOut) && !!lastChunk && lastChunk.choices?.[0]?.finish_reason === 'stop',
      rawOut && ('末 240 字符=' + rawOut.slice(-240)));

    const BAD = [null, undefined, '', 'not json at all', '{"choices":[]}', '{"id":"x"}', '{"choices":[{"index":0}]}'];
    const misjudge = [];
    if (replay && typeof replay.isReplayableJson === 'function') {
      for (const b of BAD) { if (replay.isReplayableJson(b) !== false) misjudge.push(String(b).substring(0, 16)); }
      if (replay.isReplayableJson(OK_JSON) !== true) misjudge.push('合法件被判不可回放');
    } else { misjudge.push('无 isReplayableJson'); }
    check('#47a4 不可回放判定必须准确:null/空串/非法 JSON/无 choices/choices 空/条目无 message → false;合法件 → true（判错=要么吐畸形流要么误逐出好缓存）',
      misjudge.length === 0, misjudge.join(' | '));

    const srvSrc = require('node:fs').readFileSync('./server.js', 'utf-8');
    const hitAt = srvSrc.indexOf('if (cached) {');
    const hitBlock = hitAt >= 0 ? srvSrc.slice(hitAt, hitAt + 1400) : '';
    const streamBranch = hitBlock.split('} else {')[0] || '';
    const streamsViaReplay = /sseFromChatJson/.test(streamBranch) && !/res\.write\(\s*cached\.value\s*\)/.test(streamBranch);
    const evictsWhenUnplayable = /isReplayableJson/.test(hitBlock) && /_respCache\.delete\(/.test(hitBlock);
    check('#47a5 命中分支必须真的走合成器（不得再直接 res.write(cached.value) 进 SSE），且不可回放时逐出缓存并继续转发上游（不得 502 糊弄、不得静默吐坏流）',
      hitAt >= 0 && streamsViaReplay && evictsWhenUnplayable,
      '找到命中块=' + (hitAt >= 0) + ' 走合成器=' + streamsViaReplay + ' 逐出并转发=' + evictsWhenUnplayable);
    const nonStreamHit = /'application\/json; charset=utf-8',\s*'X-Cache':\s*'HIT'/.test(srvSrc)
      && /res\.end\(\s*cached\.value\s*\)/.test(srvSrc);
    check('#47a6 反向锁:非流式命中路径不得被牵连改动（仍原字节回放 + application/json + X-Cache: HIT）',
      nonStreamHit, '非流式命中形状=' + nonStreamHit);
  }

  // ── codely-client 签名(可选模块:开源版剔除 codely-client.js 时整段跳过) ──
  if (codelySigningKey && codelySignature && codelyCliVersion && codelyUserAgent) {
    section('codely-client(X-Codely-Signature 签名/UA 跟版)');
    const fakeKey = 'sk-test-key-1234567890';
    const ts = '1787309310';
    const sig1 = codelySignature('/v1/chat/completions', codelySigningKey(fakeKey), ts);
    check('签名为 base64url 字符集(无 + / =)', /^[v0-9.]+$/u.test(sig1.split('.').slice(0, 2).join('.') + '.') && !/[+/=]/.test(sig1.split('.')[2]));
    const sig2 = codelySignature('/v1/messages', codelySigningKey(fakeKey), ts);
    check('不同 path 产生不同签名', sig2 !== sig1);
    check('时间戳参与签名(同 path 不同 ts 签名不同)', codelySignature('/v1/chat/completions', codelySigningKey(fakeKey), '1787309311') !== sig1);
    // UA 跟版
    const ver = codelyCliVersion();
    check('本地 exe 版本提取或回退(格式 x.y.z-release.NN)', /^\d+\.\d+\.\d+-release\.\d+$/.test(ver), `实际 ${ver}`);
    check('UA 格式 = codely-cli/{version} (win32; x64)', /^codely-cli\/\d+\.\d+\.\d+-release\.\d+ \(win32; x64\)$/.test(codelyUserAgent()), `实际 ${codelyUserAgent()}`);
    process.env.CODELY_CLI_EXE = 'Z:\\definitely\\not\\exists\\codely.exe';
    const fallbackVer = codelyCliVersion(true);
    check('exe 缺失时回退内置版本', fallbackVer === '1.0.0-release.52', `实际 ${fallbackVer}`);
    delete process.env.CODELY_CLI_EXE;
  }

  // ── #96 env 数字解析:必须整串匹配,不许前缀宽容(指挥官亲笔锁定,编码手禁改) ──
  //   病根实测(env-int.js:16 `parseInt(v)` 无 radix、前缀宽容):
  //     "1e7"→1  "10MB"→10  "0x10"→16  "12.9"→12  "1,5"→1  "5 5"→5  "1_000"→1
  //   全部**当作合法值返回**,且**一条留痕都不写**。业务后果是真金白银:
  //     AI_BRIDGE_CLI_MAX_OUTPUT_CHARS=1e7 ⇒ 上限 1 字符 ⇒ 每条 CLI 派发被"输出超上限"误杀
  //     AI_BRIDGE_DAILY_TOKEN_BUDGET=1e6   ⇒ 预算 1 token ⇒ 中枢当天拒绝一切任务
  //     AI_BRIDGE_PORT=0x2668              ⇒ 16 ⇒ 桥连的是不存在端口
  //   反向哨兵同样重要:不许将钳制改成"一律拒绝"或"一律噪音"。
  section('#96 env 数字解析:整串匹配 + 非法必留痕');
  {
    const scratch = [];
    const capture = (fn) => {
      const orig = console.error;
      console.error = (...a) => { scratch.push(a.join(' ')); };
      try { return fn(); } finally { console.error = orig; }
    };
    check('#96u1 科学计数法 "1e7" 不得被当成 1(必须回落默认)', parsePositiveInt('1e7', 999) === 999, '实际 ' + parsePositiveInt('1e7', 999));
    check('#96u2 带单位 "10MB" 不得被当成 10', parsePositiveInt('10MB', 999) === 999, '实际 ' + parsePositiveInt('10MB', 999));
    check('#96u3 十六进制 "0x10" 不得被当成 16', parsePositiveInt('0x10', 999) === 999, '实际 ' + parsePositiveInt('0x10', 999));
    check('#96u4 小数串 "12.9" 不得静默截成 12', parsePositiveInt('12.9', 999) === 999, '实际 ' + parsePositiveInt('12.9', 999));
    check('#96u5 千分位 "1,5" 不得被当成 1', parsePositiveInt('1,5', 999) === 999, '实际 ' + parsePositiveInt('1,5', 999));
    check('#96u6 一次给两个数 "5 5" 不得被当成 5', parsePositiveInt('5 5', 999) === 999, '实际 ' + parsePositiveInt('5 5', 999));
    check('#96u7 下划线分组 "1_000" 不得被当成 1', parsePositiveInt('1_000', 999) === 999, '实际 ' + parsePositiveInt('1_000', 999));
    check('#96u8 超出安全整数的位数不得返回 float 形态大数(防 ERR_OUT_OF_RANGE 崩进程)',
      parsePositiveInt('99999999999999999999', 999) === 999, '实际 ' + parsePositiveInt('99999999999999999999', 999));
    check('#96u9 数字入参里的小数 12.9 不得静默截成 12', parsePositiveInt(12.9, 999) === 999, '实际 ' + parsePositiveInt(12.9, 999));
    check('#96u10 反向哨兵:纯数字串/首尾空白/显式正号仍是正解',
      parsePositiveInt(' 12 ', 999) === 12 && parsePositiveInt('12345', 999) === 12345 && parsePositiveInt('+8', 999) === 8);
    check('#96u11 反向哨兵:数字入参仍兼容安全整数(30000→30000)', parsePositiveInt(30000, 999) === 30000, '实际 ' + parsePositiveInt(30000, 999));
    check('#96u12 反向哨兵:0 的两把尺不动(正整数拒 0、非负收 0)',
      parsePositiveInt('0', 999) === 999 && parseNonNegativeInt('0', 7) === 0);
    check('#96u13 反向哨兵:负数照旧回落(负数直通是 #49 F1 的病,不许复发)',
      parsePositiveInt('-5', 999) === 999 && parseNonNegativeInt('-5', 7) === 7);
    check('#96u14 反向哨兵:未设置/空串静默落默认(不许噪音告警)',
      capture(() => parsePositiveInt(undefined, 999, 'ZTEST_UNSET')) === 999 && scratch.length === 0
        && capture(() => parsePositiveInt('', 999, 'ZTEST_EMPTY')) === 999 && scratch.length === 0);
    check('#96u15 留痕新增:前缀宽容型非法值("1e7")必须与 "abc" 同口径留痕(变量名 + 非法/回落字样)',
      (() => {
        scratch.length = 0;
        const r = capture(() => parsePositiveInt('1e7', 999, 'ZTEST_PREFIX'));
        return r === 999 && scratch.some(s => /ZTEST_PREFIX/.test(s) && /非法|无效|不是正数|必须为正|回落/.test(s));
      })(), 'stderr=' + JSON.stringify(scratch));
    check('#96u16 反向哨兵:合法值不得留痕(钳制不得变成噪音)',
      (() => {
        scratch.length = 0;
        const r = capture(() => parsePositiveInt('12345', 999, 'ZTEST_OK'));
        return r === 12345 && scratch.length === 0;
      })(), 'stderr=' + JSON.stringify(scratch));
    check('#96u17 反向哨兵:#49 F2 既有留痕路径不回退(负数带 name 必须说清)',
      (() => {
        scratch.length = 0;
        const r = capture(() => parsePositiveInt('-5', 999, 'ZTEST_NEG'));
        return r === 999 && scratch.some(s => /ZTEST_NEG/.test(s) && /非法|无效|不是正数|必须为正|回落/.test(s));
      })(), 'stderr=' + JSON.stringify(scratch));
  }
}

main()
  .catch(e => { failed++; failures.push('主流程异常'); process.stdout.write(`\n💥 异常: ${e.message}\n`); })
  .finally(() => {
    process.stdout.write('\n' + '='.repeat(40) + '\n');
    process.stdout.write(`总计: ${passed}/${passed + failed} 通过\n`);
    if (failed > 0) process.stdout.write(`失败: ${failures.join(', ')}\n`);
    process.exit(failed > 0 ? 1 : 0);
  });
