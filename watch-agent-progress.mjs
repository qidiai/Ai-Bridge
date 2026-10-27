#!/usr/bin/env node
/**
 * watch-agent-progress.mjs —— #130 派工心跳观察器(零依赖 / ESM / Node 22 / 全程只读)
 *
 * 背景(本会话实测):
 *   1) 中枢派发的多轮 CLI 只回传末条 stdout —— 291.6s 的审稿只交回 68 字符,600s 被信号终止后仅剩尾部 247 字符;
 *   2) 进行中的派发,指挥官只能看到 GET /api/health 的 activeDispatches=1,没有任何"它在干什么";
 *   3) 子代理侧平台不推流,但被派工者可以每步自己落盘(progress.jsonl:T127 已验证 plan→…→handback 九步可用)。
 *   本文件把第 3 条固化成常驻观察器:读心跳文件,只报告状态,不写盘、不杀进程。
 *
 * 判活口径(用户明确纠正,写死): 看**新步骤(seq 推进)**,不看字节增长。
 *   "输出没增长就收割"是错判据,会把"想得多/慢"的合法深思误杀 ⇒ 状态必须多态而非二态。
 *
 * 用法:
 *   node ai-bridge/watch-agent-progress.mjs --file <progress.jsonl 绝对路径> --budget-ms <n>
 *        [--stale-ms <n>] [--interval-ms <n>] [--once]
 *
 * 心跳契约(每行一个 JSON):
 *   {"ts":"<ISO>","seq":<int>,"step":"plan|read|write|test-run|test-result|blocker|handback",
 *    "detail":"<文本>","files":[...],"checks":{...}}
 *
 * 七态判定(互斥且完备,严格按此顺序短路;终态只认"按 ts 最后那一条"心跳;
 *   ts 相等的多条按**文件里更靠后**的那条算末条——契约不强制毫秒精度,同秒并列是常态):
 *   1. 文件不存在 / 无一条可解析                ⇒ STALE-NO-HEARTBEAT  exit 1
 *   2. 末条心跳 step=handback(已交工)         ⇒ HANDED-BACK          exit 0 ← 终态,优先级高于静默钟与活跃度
 *   3. 末条心跳 step=blocker(自报停工)        ⇒ BLOCKED              exit 0 ← 同上(申报停工 ≠ 卡死)
 *   4. 非终态 且 心跳过期 且 预算已超           ⇒ STALE                exit 1
 *   5. 非终态 且 心跳过期 但 预算未超           ⇒ STALLED              exit 0(只报,不建议收割)
 *   6. 新鲜 且 distinct seq >= 2                ⇒ WORKING              exit 0
 *   7. 新鲜 但 distinct seq <= 1                ⇒ THINKING             exit 0
 *
 * #135: handback/blocker 是被派工者**自己申报的终止态**,静默再久也不叫卡死 ⇒ 必须先于第 4~7 条判。
 *   但终态判据只许看"按 ts 最后那一条":文件中间出现过 handback、更晚还有一条 read ⇒ 不算终态,
 *   仍走第 4~7 条。否则任何带 handback 的文件都永不判死,修复会变成新缺陷。
 *   #143: "最后那一条"含平局规则——ts 相等时取**文件里靠后**的那条(秒级粒度下同秒两步必然并列),
 *   于是同 ts 的 [read, handback] 判终态、同 ts 的 [handback, read] 判 WORKING,两边都不误判。
 *
 * 只读承诺: 本文件没有任何写盘调用,也没有任何中断/终止能力(收割由指挥官决定)。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// 正整数解析的**单点**是 env-int.js(parsePositiveInt(v, def, name),#49a/#96/#101 同族口径)。
// 本文件不再自带一份"两参数的尺"——同一规则只许有一把尺(#96/#101/#104/#126)。
const { parsePositiveInt } = require('./env-int');

const DEFAULT_STALE_MS = 60000;
const DEFAULT_INTERVAL_MS = 5000;

// 输出防灌爆: 单行硬上限 400 字符(判据),此处取 380 留余量;超长截断必须留痕,句式沿用 db.js clipEventDetail。
const MAX_LINE_CHARS = 380;
// detail 是外来文本,先按自己的上限截一刀,避免把整行 380 全吃满。
const DETAIL_CLIP_CHARS = 120;

const VERDICT_NO_HEARTBEAT = 'STALE-NO-HEARTBEAT';
const VERDICT_STALE = 'STALE';
const VERDICT_STALLED = 'STALLED';
const VERDICT_WORKING = 'WORKING';
const VERDICT_THINKING = 'THINKING';
// #135: 被派工者自我申报的两个终态(终态步骤名与 verdict 名都具名,判据里不散写字面量)。
const VERDICT_HANDED_BACK = 'HANDED-BACK';
const VERDICT_BLOCKED = 'BLOCKED';

const STEP_HANDBACK = 'handback';
const STEP_BLOCKER = 'blocker';
const TERMINAL_STEP_VERDICTS = new Map([
  [STEP_HANDBACK, VERDICT_HANDED_BACK],
  [STEP_BLOCKER, VERDICT_BLOCKED]
]);

function usageError (message) {
  const err = new Error(message);
  err.isUsageError = true;
  return err;
}

// 严格预检(协议层):`--budget-ms/--stale-ms/--interval-ms` 收到非法值(非纯十进制正整数,
// 如 abc / 0 / -5 / 1e7 / 12.9)必须点名参数并以退出码 2 结束,**不得静默回落默认值**。
// "拒绝"由本预检表达;"解析与留痕"仍归 env-int 单点 ⇒ 只有预检通过的值才会交给单点。
function assertStrictPositiveInt (raw, flagName) {
  const text = String(raw);
  const value = /^[0-9]+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw usageError(`参数 --${flagName} 非法: "${text}" 不是正整数(不静默回落默认值)`);
  }
}

// 单点 def 形参在预检之后不可达(非法值已 exit 2 拦下);--budget-ms 无默认值,
// 传 -1 作"绝不该发生"的哨兵:万一预检被削弱,只会让 budgetMs 变成非法值而非被悄悄替换成某个上限。
const BUDGET_NO_FALLBACK = -1;

function parseArgs (argv) {
  const opts = {
    file: null,
    budgetMs: null,
    staleMs: DEFAULT_STALE_MS,
    intervalMs: DEFAULT_INTERVAL_MS,
    once: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--once') {
      opts.once = true;
    } else if (arg === '--file') {
      const value = argv[i + 1];
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw usageError('参数 --file 缺失(必填:progress.jsonl 绝对路径)');
      }
      opts.file = value;
      i++;
    } else if (arg === '--budget-ms') {
      const value = argv[i + 1];
      if (value === undefined) throw usageError('参数 --budget-ms 缺失(必填:正整数毫秒)');
      assertStrictPositiveInt(value, 'budget-ms');
      opts.budgetMs = parsePositiveInt(value, BUDGET_NO_FALLBACK, 'budget-ms');
      i++;
    } else if (arg === '--stale-ms') {
      const value = argv[i + 1];
      if (value === undefined) throw usageError('参数 --stale-ms 缺失(正整数毫秒)');
      assertStrictPositiveInt(value, 'stale-ms');
      opts.staleMs = parsePositiveInt(value, DEFAULT_STALE_MS, 'stale-ms');
      i++;
    } else if (arg === '--interval-ms') {
      const value = argv[i + 1];
      if (value === undefined) throw usageError('参数 --interval-ms 缺失(正整数毫秒)');
      assertStrictPositiveInt(value, 'interval-ms');
      opts.intervalMs = parsePositiveInt(value, DEFAULT_INTERVAL_MS, 'interval-ms');
      i++;
    } else {
      throw usageError(`未知参数: "${arg}"(支持 --file/--budget-ms/--stale-ms/--interval-ms/--once)`);
    }
  }
  if (!opts.file) throw usageError('参数 --file 缺失(必填:progress.jsonl 绝对路径)');
  if (opts.budgetMs === null) throw usageError('参数 --budget-ms 缺失(必填:正整数毫秒)');
  return opts;
}

// 单行 JSON → 心跳对象;任何不合契约的地方一律返回 null(由调用方记为坏行,不静默吞掉)。
function parseBeat (line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch (_err) {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const ts = Date.parse(String(obj.ts === undefined ? '' : obj.ts));
  if (!Number.isFinite(ts)) return null;
  const seq = Number(obj.seq);
  if (!Number.isSafeInteger(seq)) return null;
  const files = Array.isArray(obj.files) ? obj.files.map((f) => String(f)) : [];
  return {
    ts,
    seq,
    step: typeof obj.step === 'string' ? obj.step : '',
    detail: typeof obj.detail === 'string' ? obj.detail : '',
    files
  };
}

// 只读一次文件;文件不存在不算异常,交给七态判定的第 1 条处理。
function readHeartbeats (filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (_err) {
    return { exists: false, beats: [], badLines: [] };
  }
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const physical = text.split('\n');
  const beats = [];
  const badLines = [];
  for (let i = 0; i < physical.length; i++) {
    const line = physical[i].replace(/\r$/, '').trim();
    if (!line) continue;
    const beat = parseBeat(line);
    if (beat) beats.push(beat);
    else badLines.push(i + 1);
  }
  return { exists: true, beats, badLines };
}

function clipLine (line) {
  const text = String(line);
  if (text.length <= MAX_LINE_CHARS) return text;
  const tail = `…(已截断,原长 ${text.length} 字符)`;
  return text.substring(0, Math.max(0, MAX_LINE_CHARS - tail.length)) + tail;
}

function clipDetail (detail) {
  const text = String(detail === undefined || detail === null ? '' : detail);
  if (text.length <= DETAIL_CLIP_CHARS) return text;
  return text.substring(0, DETAIL_CLIP_CHARS) + `…(已截断,原长 ${text.length} 字符)`;
}

/**
 * 七态判定。nowMs 由调用方在一次采样里只读一次 Date.now(),age 与 budget 共用同一个钟。
 *   heartbeat_age_ms = now - max(ts)   —— "最近一次心跳离现在多久"(看它还在不在动)
 *                     末条心跳(lastBeat)取 ts 最大的一条;ts 打平时取文件里**更靠后**的那条(#143:
 *                     心跳契约只要求 ts 是 ISO、不强制毫秒精度,秒级粒度下同秒两步必然并列,
 *                     平局若取靠前者,"按 ts 最后一条"的规则会被自相矛盾地执行)。
 *   budget_used_ms   = now - min(ts)   —— 心跳文件里最早的证据离现在多久;不用进程启动时刻,
 *                     因为观察器可能在派发途中才被拉起,用启动时刻会把已跑的时长算丢,让 STALE 误报。
 *   distinct seq     = 不同 seq 的个数 —— 判活看"新步骤",不看字节增长。
 */
function evaluate (state, opts, nowMs) {
  const beats = state.beats;
  if (!state.exists || beats.length === 0) {
    return {
      verdict: VERDICT_NO_HEARTBEAT,
      exitCode: 1,
      maxSeq: 0,
      distinct: 0,
      fileCount: 0,
      heartbeatAgeMs: 0,
      budgetUsedMs: 0,
      lastBeat: null
    };
  }
  let maxTs = -Infinity;
  let minTs = Infinity;
  let maxSeq = -Infinity;
  let lastBeat = null;
  const seqSet = new Set();
  const fileSet = new Set();
  for (const beat of beats) {
    // #143: 用 `>=` 而非 `>` —— ts 相等时**后出现的行胜出**(后写者胜)。
    // 心跳契约只要求 ts 是 ISO,不强制毫秒精度;宿主写秒级粒度时同秒两步必然并列,
    // 若平局保留文件里靠前那条,"按 ts 最后那一条"就名不副实(已交工的 handback 会被同 ts 的前一条 read 吞掉)。
    if (beat.ts >= maxTs) {
      maxTs = beat.ts;
      lastBeat = beat;
    }
    if (beat.ts < minTs) minTs = beat.ts;
    if (beat.seq > maxSeq) maxSeq = beat.seq;
    seqSet.add(beat.seq);
    for (const f of beat.files) fileSet.add(f);
  }
  const heartbeatAgeMs = nowMs - maxTs;
  const budgetUsedMs = Math.round(nowMs - minTs);
  const common = {
    maxSeq,
    distinct: seqSet.size,
    fileCount: fileSet.size,
    heartbeatAgeMs,
    budgetUsedMs,
    lastBeat
  };
  // ── 终态短路(#135)━━ 只看 lastBeat = 按 ts 最大的那一条(平局取文件靠后者,#143)。━━━━━━━━
  // handback(已交工)/ blocker(自报停工)是被派工者申报的终止态,不是卡死:
  // 静默再久、预算再超、seq 再新鲜,都不得判 STALE(建议收割)也不得判 WORKING。
  // 反向:文件中间出现过 handback 但更晚还有一条 read ⇒ lastBeat.step 是 read,
  //   这里自然不命中,继续走下面的时间/活跃度判据(带 handback 的文件仍会判死)。
  // 平局同理受最后一条约束:同 ts 的 [read, handback] ⇒ 终态;同 ts 的 [handback, read] ⇒ 不判终态。
  const terminalVerdict = TERMINAL_STEP_VERDICTS.get(lastBeat.step);
  if (terminalVerdict !== undefined) {
    return Object.assign({ verdict: terminalVerdict, exitCode: 0 }, common);
  }
  if (heartbeatAgeMs > opts.staleMs && budgetUsedMs > opts.budgetMs) {
    return Object.assign({ verdict: VERDICT_STALE, exitCode: 1 }, common);
  }
  if (heartbeatAgeMs > opts.staleMs) {
    return Object.assign({ verdict: VERDICT_STALLED, exitCode: 0 }, common);
  }
  if (seqSet.size >= 2) {
    return Object.assign({ verdict: VERDICT_WORKING, exitCode: 0 }, common);
  }
  return Object.assign({ verdict: VERDICT_THINKING, exitCode: 0 }, common);
}

function formatBlock (result, opts, badLines) {
  const ageSec = (result.heartbeatAgeMs / 1000).toFixed(1);
  const lines = [
    `VERDICT=${result.verdict}`,
    `metrics: seq=${result.maxSeq} distinct=${result.distinct} heartbeat_age_s=${ageSec} budget_used_ms=${result.budgetUsedMs} budget_limit_ms=${opts.budgetMs} files=${result.fileCount}`
  ];
  if (badLines && badLines.length > 0) lines.push('CONTRACT-BAD-LINE: ' + badLines.join(','));
  if (result.lastBeat) {
    const beat = result.lastBeat;
    lines.push(`last-step: seq=${beat.seq} step=${clipDetail(beat.step)} detail=${clipDetail(beat.detail)}`);
  }
  return lines.map(clipLine);
}

async function main () {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`watch-agent-progress: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }
  for (;;) {
    const state = readHeartbeats(opts.file);
    const nowMs = Date.now(); // 一次采样只读一次钟
    const result = evaluate(state, opts, nowMs);
    process.stdout.write(formatBlock(result, opts, state.badLines).join('\n') + '\n');
    if (result.exitCode !== 0 || opts.once) {
      process.exitCode = result.exitCode;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs));
    process.stdout.write('\n');
  }
}

await main();
