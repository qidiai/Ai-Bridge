#!/usr/bin/env node
/**
 * #127 台账新鲜度守卫 —— 旁挂只读守卫（零依赖 / ESM / Node 22）
 *
 * 病灶：ai-bridge/TEST-LOCK.json 是本仓的指纹台账
 *   source_faces  每个源文件的 git blob sha1
 *   source_faces_owner 每个面"最后一次被哪一轮改动"的文本
 *   head          指纹取自哪个提交（语义=使全部面与账面逐字节一致的那个 commit）
 *   updated       最新一轮
 * 既有校验拿 git hash-object 比工作树，工作树与落账轮同内容所以恒绿，
 * 抓不到"指针与树不同名"。本守卫改成对着 head 所指提交逐面回算，把三处账实不符
 * 变成常驻机器判据：
 *   J1 head 回源：git rev-parse <head>:ai-bridge/<面> 必须逐字符等于账面 blob
 *   J2 updated 新鲜度：head 提交 subject 里的槽位号（#NN）必须全部出现在 updated
 *   J3 owner 末次改动点名：owner 文本必须含该面末次提交的 --short=7 哈希
 *
 * 用法：node ai-bridge/check-ledger-hygiene.mjs [--repo <仓库根绝对路径>] [--ledger <台账绝对路径>]
 * 默认 --repo = 本脚本所在目录的上一级（仓库根），默认 --ledger = <repo>/ai-bridge/TEST-LOCK.json
 *
 * 输出（stdout，逐行）：J1 / J2 / J3 三行 + 末行 STATUS=ok|drift；
 *   drift 时另加一行 faces-checked 明细，便于回源定位（不改判据）。
 * 退出码：0 全绿 / 1 drift / 2 用法或环境错。
 *
 * 只读约束：全程只读台账与 git 元数据，不落任何盘（验收有结构锁）。
 * 调 git 一律 spawnSync + 数组参数，不用 shell，面名（外部可控文本）只作参数传递。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const USAGE = 'node ai-bridge/check-ledger-hygiene.mjs [--repo <仓库根绝对路径>] [--ledger <台账绝对路径>]'

function exitUsage (message) {
  process.stdout.write('[usage] ' + message + '\n')
  process.exit(2)
}

function exitEnv (message) {
  process.stdout.write('[env] ' + message + '\n')
  process.exit(2)
}

/** git 只经 spawnSync + 数组参数调用；绝不拼 shell 串 */
function git (repo, args) {
  const r = spawnSync('git', ['-C', repo].concat(args), { encoding: 'utf-8' })
  const err = r.error ? String(r.error.message) : String(r.stderr || '').trim()
  return { ok: !r.error && r.status === 0, out: String(r.stdout || '').trim(), err }
}

function parseArgs (argv) {
  // Repo root: this script lives at the root of the standalone repo, but historically
// it lived in <QiDi-Agent>/ai-bridge/. Prefer the layout that actually has a .git.
const REPO_CANDIDATES = [SCRIPT_DIR, path.resolve(SCRIPT_DIR, '..')]
const DEFAULT_REPO = REPO_CANDIDATES.find((p) => fs.existsSync(path.join(p, '.git'))) || REPO_CANDIDATES[0]
const opts = { repo: DEFAULT_REPO, ledger: null }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a !== '--repo' && a !== '--ledger') exitUsage('未知参数: ' + a + '（用法: ' + USAGE + '）')
    const v = argv[i + 1]
    if (v === undefined || v === '' || v.slice(0, 2) === '--') exitUsage(a + ' 缺少路径参数（用法: ' + USAGE + '）')
    if (!path.isAbsolute(v)) exitUsage(a + ' 需绝对路径,收到: ' + v)
    if (a === '--repo') opts.repo = v; else opts.ledger = v
    i += 1
  }
  if (opts.ledger === null) {
  // TEST-LOCK.json is an internal work ledger kept in .local/ (gitignored).
  // Candidates are tried in order so both the standalone repo layout and the
  // historical <repo>/ai-bridge/ layout resolve.
  const cands = [
    path.join(SCRIPT_DIR, '.local', 'TEST-LOCK.json'),
    path.join(SCRIPT_DIR, 'TEST-LOCK.json'),
    path.join(opts.repo, 'ai-bridge', 'TEST-LOCK.json'),
    path.join(opts.repo, 'TEST-LOCK.json')
  ];
  opts.ledger = cands.find((p) => fs.existsSync(p)) || cands[0];
}
  return opts
}

/** 一行判据：J1|J2|J3 <PASS|FAIL> hits=n/总 [missing: 面名,面名] */
function judgeLine (tag, hits, total, missing) {
  const ok = missing.length === 0
  let line = tag + ' ' + (ok ? 'PASS' : 'FAIL') + ' hits=' + hits + '/' + total
  if (!ok) line += ' [missing: ' + (missing.length ? missing.join(',') : '无') + ']'
  return line
}

/** 同一路径判定（Windows 大小写不敏感；git 输出用 / 分隔） */
function samePath (a, b) {
  const na = path.resolve(a)
  const nb = path.resolve(b)
  if (na === nb) return true
  return process.platform === 'win32' && na.toLowerCase() === nb.toLowerCase()
}

const opts = parseArgs(process.argv.slice(2))

// ── 1. 环境校验：必须是 git 工作树，且必须是仓库根，台账必须读得到且能解析 ──
const inside = git(opts.repo, ['rev-parse', '--is-inside-work-tree'])
if (!inside.ok || inside.out !== 'true') {
  exitEnv('不是 git 工作树: ' + opts.repo + '（rev-parse --is-inside-work-tree -> ' + JSON.stringify(inside.out || inside.err) + '）')
}
// 路径基准钉死仓库根：git log 的面名是相对 cwd 的，cwd 落在子目录会让 J3 静默全脱靶
const topLevel = git(opts.repo, ['rev-parse', '--show-toplevel'])
if (!topLevel.ok || topLevel.out === '' || !samePath(topLevel.out, opts.repo)) {
  exitEnv('--repo 不是仓库根（git 路径基准要求 cwd=仓库根）: ' + opts.repo +
    '（rev-parse --show-toplevel -> ' + JSON.stringify(topLevel.out || topLevel.err) + '）')
}

let ledgerText = null
try {
  ledgerText = fs.readFileSync(opts.ledger, 'utf-8')
} catch (e) {
  exitEnv('台账读不到: ' + opts.ledger + '（' + String((e && e.message) || e) + '）')
}
let ledger = null
try {
  ledger = JSON.parse(ledgerText)
} catch (e) {
  exitEnv('台账 JSON 解析失败: ' + opts.ledger + '（' + String((e && e.message) || e) + '）')
}
if (!ledger || typeof ledger !== 'object' || !ledger.source_faces || typeof ledger.source_faces !== 'object') {
  exitEnv('台账缺少 source_faces 对象: ' + opts.ledger)
}

// 面数一律动态取，禁止把当前面数写成字面量参与比较
const faces = Object.keys(ledger.source_faces)
const N = faces.length
const owners = (ledger.source_faces_owner && typeof ledger.source_faces_owner === 'object') ? ledger.source_faces_owner : {}

// ── 2. 浅历史必须显式红：git log 取不到真实末次提交，三条判据一律不得静默跳过 ──
const shallow = git(opts.repo, ['rev-parse', '--is-shallow-repository'])
if (!shallow.ok) exitEnv('读不到浅历史状态: ' + opts.repo + '（' + shallow.err + '）')
if (shallow.out === 'true') {
  const note = '浅克隆(shallow)历史不完整: git log 取不到真实末次提交,三条判据均不可信'
  process.stdout.write(judgeLine('J1', 0, N, faces) + '\n')
  process.stdout.write('J2 FAIL hits=0/1 [missing: ' + note + ']\n')
  process.stdout.write(judgeLine('J3', 0, N, faces) + '\n')
  process.stdout.write('notice: ' + note + '\n')
  process.stdout.write('STATUS=drift\n')
  process.exit(1)
}

// ── 3. head 解析：head 不可解析时 J1 逐面点名，不得计 0 命中静默通过 ──
const headRaw = (typeof ledger.head === 'string' && ledger.head.trim() !== '') ? ledger.head.trim() : null
let headCommit = null
let headNote = ''
if (headRaw === null) {
  headNote = 'head 字段缺失或非字符串,head 不可解析'
} else if (headRaw.startsWith('-') || !/^[0-9a-zA-Z._~^@{}+/-]{2,64}$/.test(headRaw)) {
  headNote = 'head 字段形状非法,head 不可解析: ' + headRaw
} else {
  const r = git(opts.repo, ['rev-parse', '--verify', headRaw + '^{commit}'])
  if (r.ok && r.out !== '') headCommit = r.out
  else headNote = 'head 不可解析: ' + headRaw + '（' + (r.err || 'rev-parse --verify 返回空') + '）'
}

// ── 4. J1：对着 head 所指树逐面回算 blob，路径基准钉死 ai-bridge/<面名> ──
const j1Missing = []
let j1Hits = 0
for (const face of faces) {
  if (headCommit === null) { j1Missing.push(face); continue }
  const r = git(opts.repo, ['rev-parse', '--verify', headCommit + ':ai-bridge/' + face])
  const expected = String(ledger.source_faces[face])
  if (r.ok && r.out !== '' && r.out === expected) j1Hits += 1
  else j1Missing.push(face)
}

// ── 5. J2：head 提交 subject 的槽位号必须全部出现在 updated（分母固定 1）──
const j2Missing = []
let j2Hits = 0
if (headCommit === null) {
  j2Missing.push('head 提交信息不可读(head 不可解析)')
} else {
  const s = git(opts.repo, ['log', '-1', '--format=%s', headCommit])
  const subject = s.ok ? s.out : ''
  const slots = Array.from(new Set(Array.from(subject.matchAll(/#(\d+)\b/g), (m) => m[1])))
  if (slots.length === 0) {
    j2Missing.push('head 提交信息无槽位号')
  } else {
    const updatedText = String(ledger.updated)
    const lack = slots.filter((n) => !updatedText.includes('#' + n))
    if (lack.length === 0) j2Hits = 1
    else for (const n of lack) j2Missing.push('#' + n)
  }
}

// ── 6. J3：owner 必须点名该面末次提交的 --short=7 哈希（槽位号不作替代）──
const j3Missing = []
let j3Hits = 0
for (const face of faces) {
  const log = git(opts.repo, ['log', '-1', '--format=%H', '--', 'ai-bridge/' + face])
  const full = log.ok ? log.out : ''
  if (full === '') { j3Missing.push(face); continue }
  const short = git(opts.repo, ['rev-parse', '--short=7', full])
  const ownerText = (typeof owners[face] === 'string') ? owners[face] : ''
  if (short.ok && short.out !== '' && ownerText.includes(short.out)) j3Hits += 1
  else j3Missing.push(face)
}

// ── 7. 输出：三行判据 + 末行 STATUS；drift 时补一行面清单明细 ──
const drift = j1Missing.length > 0 || j2Missing.length > 0 || j3Missing.length > 0
const out = []
if (headNote !== '') out.push('[head] ' + headNote)
out.push(judgeLine('J1', j1Hits, N, j1Missing))
out.push(judgeLine('J2', j2Hits, 1, j2Missing))
out.push(judgeLine('J3', j3Hits, N, j3Missing))
if (drift) out.push('faces-checked: N=' + N + ' [' + faces.join(',') + ']')
out.push('STATUS=' + (drift ? 'drift' : 'ok'))
process.stdout.write(out.join('\n') + '\n')
process.exit(drift ? 1 : 0)
