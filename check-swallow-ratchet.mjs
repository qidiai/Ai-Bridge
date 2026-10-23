#!/usr/bin/env node
'use strict';

/**
 * check-swallow-ratchet.mjs — 吞异常棘轮门禁（dev-orchestra 派工 #26）
 *
 * 干什么：用 ESLint 显式规则静态计数"纯吞异常"的 catch 块（catch 块里既不记录〔无任何
 * 函数调用〕、也不做任何决定〔无 return / throw〕），与逐文件棘轮基线
 * swallow-baseline.json 比对：只许降、不许升，且基线必须与源码同源。
 *
 * 为什么是旁挂脚本而不是写进 ai-bridge/.eslintrc.json：源码现有 45 处纯吞，写成 error
 * 会当场把"必须 0 error"那道既有 lint 门打成 45 error，写成 warn 又无人看；只有
 * "旁挂脚本 + 逐文件只降不升的棘轮基线"既不爆破又真咬人。故 .eslintrc.json 一字未改。
 *
 * 用法：
 *   node check-swallow-ratchet.mjs                  棘轮模式：默认基线校验默认根（本文件所在目录）
 *   node check-swallow-ratchet.mjs --root DIR       换扫描根
 *   node check-swallow-ratchet.mjs --baseline FILE  换基线文件
 *   node check-swallow-ratchet.mjs --update         用实测重写基线后退出 0
 *   node check-swallow-ratchet.mjs --count TARGET   计数模式：TARGET 为单个 .js 文件或目录，打印 COUNT=<n>
 *
 * 退出码：0 通过 / 1 棘轮不通过（计数增长、口径漂移、total 与逐文件之和不一致）/ 2 用法或环境错误
 *
 * 确定性：不联网、不级联 ai-bridge/.eslintrc.json（内联配置，等价 --no-eslintrc）、
 * 目录扫描按名字排序、不写任何临时文件（只有 --update 会重写基线 JSON，而 JSON 不计数）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// 口径原文（逐字锁死，改一个字符就等于换口径，#26m2 直接比对基线里的 selector 字段）
const SELECTOR = 'CatchClause:not(:has(CallExpression)):not(:has(ThrowStatement)):not(:has(ReturnStatement))';
const SELF_DIR = import.meta.dirname;
const DEFAULT_BASELINE = path.join(SELF_DIR, 'swallow-baseline.json');
// 内联规则配置 = CLI 的 --no-eslintrc --rule '{"no-restricted-syntax":["error","<SELECTOR>"]}'
const CONFIG_SCRIPT = {
  parserOptions: { ecmaVersion: 2022, sourceType: 'script' },
  rules: { 'no-restricted-syntax': ['error', SELECTOR] }
};
// 兜底：仓里若出现 ESM 语法的 .js，script 解析失败时按 module 再解析一次（口径不变）
const CONFIG_MODULE = {
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  rules: { 'no-restricted-syntax': ['error', SELECTOR] }
};
const BASELINE_NOTE = '口径(逐字锁死,勿改): CatchClause:not(:has(CallExpression)):not(:has(ThrowStatement)):not(:has(ReturnStatement)) —— catch 块里既无任何函数调用(不记录)、也无 return/throw(不做决定) = 纯吞异常;注释不是 AST 节点,写注释绕不过。计数内核: ESLint 8.57.1 显式规则 no-restricted-syntax + esquery 1.7.0 的 :has(),内联配置不级联 ai-bridge/.eslintrc.json(等价 --no-eslintrc)。范围: 根目录 **/*.js,排除 node_modules/、点目录/点文件、*.bak* 与全部 *.mjs(测试套 56 处不入门禁)。路径一律正斜杠相对根目录。交叉核对命令(在 ai-bridge 目录): npx eslint . --ext .js --rule \'{"no-restricted-syntax":["error","CatchClause:not(:has(CallExpression)):not(:has(ThrowStatement)):not(:has(ReturnStatement))"]}\' -f json'

// eslint 载入失败就带话退出,不让后面 new Linter() 抛栈
function loadLinter () {
  try {
    return require('eslint').Linter
  } catch (e) {
    process.stderr.write('check-swallow-ratchet: 载入 eslint 失败(' + e.message + ')。本脚本零新依赖,复用仓根 devDependencies 里的 eslint 8.x。\n')
    return null
  }
}
const LinterClass = loadLinter()
const linter = LinterClass ? new LinterClass() : null

function isFatalParse (msgs) {
  return msgs.some((m) => m.fatal === true)
}

function lintOnce (code, filename, config) {
  return linter.verify(code, config, { filename })
}

// 单个文件的纯吞计数。解析失败会被抛出,绝不静默按 0 计。
function countSwallows (code, filename) {
  let msgs = lintOnce(code, filename, CONFIG_SCRIPT)
  if (isFatalParse(msgs)) {
    msgs = lintOnce(code, filename, CONFIG_MODULE)
  }
  if (isFatalParse(msgs)) {
    const first = msgs.find((m) => m.fatal === true)
    const err = new Error('解析失败(line ' + first.line + ' col ' + first.column + '): ' + first.message)
    err.filename = filename
    throw err
  }
  return msgs.filter((m) => m.ruleId === 'no-restricted-syntax').length
}

function toPosix (p) {
  return p.split(path.sep).join('/')
}

// 收集计数对象:目录 → 递归 **/*.js;显式单文件 → 只它自己
function collectTargets (targetAbs) {
  if (!fs.existsSync(targetAbs)) {
    throw new Error('目标不存在: ' + targetAbs)
  }
  if (fs.statSync(targetAbs).isFile()) {
    if (!/\.(?:js|cjs|mjs)$/.test(targetAbs)) {
      throw new Error('--count 的单文件目标必须是 .js/.cjs/.mjs,收到: ' + targetAbs)
    }
    return [{ rel: path.basename(targetAbs), abs: targetAbs }]
  }
  const out = []
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const ent of entries) {
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        // node_modules/ 与点目录(.git/.atomcode/临时点目录)不入范围
        if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue
        walk(abs)
        continue
      }
      if (!ent.isFile()) continue
      // .mjs/.cjs 不会被 endsWith('.js') 命中:测试套不入门禁(指挥官口径)
      if (!ent.name.endsWith('.js')) continue
      if (ent.name.startsWith('.') || ent.name.includes('.bak')) continue
      out.push({ rel: toPosix(path.relative(targetAbs, abs)), abs })
    }
  }
  walk(targetAbs)
  return out
}

// 实测: Map<相对路径, 命中数>(含 0,便于区分"改进到 0"与"文件消失")
function measure (targetAbs) {
  const counts = new Map()
  const problems = []
  let total = 0
  let scanned = 0
  for (const f of collectTargets(targetAbs)) {
    let code
    try {
      code = fs.readFileSync(f.abs, 'utf8')
    } catch (e) {
      problems.push('READ-FAIL ' + f.rel + ' — ' + e.message)
      continue
    }
    try {
      const n = countSwallows(code, f.rel)
      counts.set(f.rel, n)
      total += n
      scanned += 1
    } catch (e) {
      problems.push('PARSE-FAIL ' + f.rel + ' — ' + e.message + '(该文件无法计数,拒绝按 0 蒙混)')
    }
  }
  return { counts, problems, total, scanned }
}

function sortedMap (iterable) {
  return [...iterable].sort((a, b) => a[0].localeCompare(b[0]))
}

function printTable (counts) {
  const lines = []
  for (const [rel, n] of sortedMap(counts)) {
    if (n > 0) lines.push('  ' + rel + ' ' + n)
  }
  if (!lines.length) lines.push('  (无命中)')
  return lines
}

function nonzeroCount (counts) {
  let c = 0
  for (const n of counts.values()) {
    if (n > 0) c += 1
  }
  return c
}

function runCount (opts) {
  const m = measure(opts.target)
  const out = ['check-swallow-ratchet 模式=--count', '  target  = ' + opts.target, '  selector = ' + SELECTOR, '  scanned = ' + m.scanned + ' 个 .js']
  out.push(...printTable(m.counts))
  out.push(...m.problems.map((p) => '  ' + p))
  out.push('COUNT=' + m.total)
  process.stdout.write(out.join('\n') + '\n')
  return m.problems.length ? 2 : 0
}

function runUpdate (opts) {
  const m = measure(opts.root)
  if (m.problems.length) {
    process.stdout.write(m.problems.map((p) => '  ' + p).join('\n') + '\n')
    process.stderr.write('check-swallow-ratchet: 实测阶段就有文件读/解析失败,拒绝据此重写基线\n')
    return 2
  }
  const files = {}
  const entries = [...m.counts.entries()]
    .filter((e) => e[1] > 0)
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
  for (const [rel, n] of entries) files[rel] = n
  const baseline = { selector: SELECTOR, total: m.total, files, note: BASELINE_NOTE }
  fs.writeFileSync(opts.baseline, JSON.stringify(baseline, null, 2) + '\n', 'utf8')
  const out = ['check-swallow-ratchet 模式=--update(用实测重写基线)', '  root     = ' + opts.root, '  baseline = ' + opts.baseline, '  selector = ' + SELECTOR, '  scanned  = ' + m.scanned + ' 个 .js,命中 ' + Object.keys(files).length + ' 个文件']
  out.push(...printTable(m.counts))
  out.push('WROTE=' + opts.baseline)
  out.push('TOTAL=' + m.total)
  out.push('STATUS=ok')
  process.stdout.write(out.join('\n') + '\n')
  return 0
}

function runRatchet (opts) {
  const m = measure(opts.root)
  const problems = m.problems.slice()
  let baseline = null
  if (!fs.existsSync(opts.baseline)) {
    problems.push('BASELINE-MISSING ' + opts.baseline + ' — 先跑 node check-swallow-ratchet.mjs --update 生成基线')
  } else {
    try {
      baseline = JSON.parse(fs.readFileSync(opts.baseline, 'utf8'))
    } catch (e) {
      problems.push('BASELINE-UNPARSABLE ' + opts.baseline + ' — ' + e.message)
    }
  }
  if (baseline) {
    if (baseline.selector !== SELECTOR) {
      problems.push('SELECTOR-DRIFT 基线口径与脚本口径不一致: 基线=' + String(baseline.selector) + ' / 脚本=' + SELECTOR)
    }
    const bf = baseline.files
    if (!bf || typeof bf !== 'object' || Array.isArray(bf)) {
      problems.push('BASELINE-MALFORMED files 字段必须是 相对路径→计数 的对象,收到: ' + String(bf))
    } else {
      const baseEntries = new Map(Object.entries(bf))
      let sum = 0
      for (const [rel, raw] of baseEntries) {
        if (rel.includes('\\')) problems.push('BASELINE-MALFORMED 键必须是正斜杠相对路径: ' + rel)
        const v = Number(raw)
        if (!Number.isInteger(v) || v < 0) problems.push('BASELINE-MALFORMED ' + rel + ' 的计数不是非负整数: ' + String(raw))
        else sum += v
      }
      if (Number(baseline.total) !== sum) {
        problems.push('TOTAL-SUM-CONFLICT 基线 total=' + String(baseline.total) + ' 与逐文件之和=' + sum + ' 不一致(基线与源码不同源)')
      }
      // 失败场景一:某文件实测 > 基线(增长);基线里没有的文件按 0 起算,同样算增长
      for (const [rel, n] of sortedMap(m.counts)) {
        const base = baseEntries.has(rel) ? Number(baseEntries.get(rel)) : 0
        if (n > base) problems.push('GROWTH ' + rel + ' 基线=' + base + ' 实测=' + n + ' —— 棘轮只降不升,补点或按口径记录决定')
      }
      // 失败场景二:基线里有、实测扫描中根本没有这个文件(改名/删除/掉出计数范围 = 口径漂移)
      for (const [rel, base] of sortedMap(baseEntries)) {
        if (Number(base) > 0 && !m.counts.has(rel)) {
          problems.push('SCOPE-DRIFT ' + rel + ' 基线记有 ' + base + ' 处,实测扫描里却没有该文件 —— 口径/路径漂移,请核对后 --update')
        }
      }
    }
  }
  const out = ['check-swallow-ratchet 模式=棘轮校验(只降不升)', '  root     = ' + opts.root, '  baseline = ' + opts.baseline, '  selector = ' + SELECTOR, '  scanned  = ' + m.scanned + ' 个 .js,命中 ' + nonzeroCount(m.counts) + ' 个文件']
  out.push(...printTable(m.counts))
  out.push('  measured ' + m.total + ' / baseline total ' + (baseline ? String(baseline.total) : 'n/a'))
  out.push(...problems.map((p) => '  VIOLATION ' + p))
  out.push('TOTAL=' + m.total)
  out.push('STATUS=' + (problems.length ? 'fail' : 'ok'))
  process.stdout.write(out.join('\n') + '\n')
  if (problems.length) {
    process.stderr.write('check-swallow-ratchet: 棘轮不通过(' + problems.length + ' 条违规),明细见上方 VIOLATION\n')
  }
  return problems.length ? 1 : 0
}

function usage () {
  process.stdout.write([
    '用法: node check-swallow-ratchet.mjs [--root DIR] [--baseline FILE] [--update | --count TARGET]',
    '  (无参数)          棘轮模式:用基线校验默认根(本脚本所在目录);增长/漂移 → 非 0 退出并点名文件',
    '  --root DIR        换扫描根',
    '  --baseline FILE   换基线文件',
    '  --update          用实测重写基线后退出 0',
    '  --count TARGET    计数模式:TARGET 为单个 .js 文件或目录,打印 COUNT=<n>',
    '口径: ' + SELECTOR,
    ''
  ].join('\n'))
}

function parseArgs (argv) {
  const opts = { mode: 'ratchet', root: SELF_DIR, baseline: DEFAULT_BASELINE, target: '' }
  // 缺值的 --root/--baseline/--count 一律报用法错:绝不悄悄退化成 cwd
  const needValue = (flag, i) => {
    const v = argv[i]
    if (v === undefined || v === '') throw new Error(flag + ' 需要一个值')
    return v
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--root') {
      i += 1
      opts.root = path.resolve(needValue('--root', i))
    } else if (a === '--baseline') {
      i += 1
      opts.baseline = path.resolve(needValue('--baseline', i))
    } else if (a === '--update') {
      opts.mode = 'update'
    } else if (a === '--count') {
      i += 1
      opts.mode = 'count'
      opts.target = path.resolve(needValue('--count', i))
    } else if (a === '--help' || a === '-h') {
      opts.mode = 'help'
    } else {
      throw new Error('未知参数 ' + a + '(用法见 --help)')
    }
  }
  return opts
}

// 统一走 exitCode(不调 process.exit):Windows 上 stdout 接管道时写是异步的,
// process.exit 有截断输出的风险,而 #26m1/m2 正是靠 stdout 里的 STATUS=/TOTAL= 字面判定。
function main () {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (e) {
    process.stderr.write('check-swallow-ratchet: ' + e.message + '\n')
    usage()
    return 2
  }
  if (opts.mode === 'help') {
    usage()
    return 0
  }
  if (linter === null) return 2
  try {
    if (opts.mode === 'count') {
      if (!opts.target) {
        process.stderr.write('check-swallow-ratchet: --count 需要 TARGET(单个 .js 文件或目录)\n')
        return 2
      }
      return runCount(opts)
    }
    if (opts.mode === 'update') {
      return runUpdate(opts)
    }
    return runRatchet(opts)
  } catch (e) {
    // 环境/用法类异常:非 0 退出并把话说清楚,绝不"吞掉后报绿"
    process.stderr.write('check-swallow-ratchet: 运行失败 — ' + e.message + '\n')
    return 2
  }
}

process.exitCode = main()
