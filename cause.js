/**
 * ai-bridge/cause.js — 有界原因摘要的**唯一一把尺**（#54/#74/#97/#104 单点）
 *
 * 本模块是归因规则的唯一实现,store.js 与 tool-registry.js 共用此把尺。
 * tool-registry 不得改挂 store.js(#46a4 锁):bridge-stdio.js 也 require tool-registry,
 * 一旦 tool-registry 挂上 store 依赖,每个 MCP 桥进程都会在加载期 mkdir 数据目录。
 * 因此这把尺必须下沉到本零依赖模块,供两侧共同引用。
 *
 * 规则(#97 唯一一把"有界原因摘要"的尺,废除旧 flattenReason 的保头规则——它与 workspace-manager
 *   的保尾规则互相矛盾,store 那套把末尾真因截掉,正是 #54 修过的同一种错误):
 *   压平空白;取不到有信息正文(空串、'Error' 之类异常名壳、或 '[object Object]' 之类 toString 标签壳)=> 诚实说"未知",
 *   不输出壳、不编造;
 *   <=CAUSE_MAX => 原文照抄不加省略号;>CAUSE_MAX => 保留尾部并把开头错误码补回最前,总长 <=CAUSE_MAX。
 * 纯函数:不写日志、不改状态、不抛错。类别前缀(如「解析失败: 」)由调用方组合,**不计入预算**
 * (前缀最长 4 字 + ': ',组合后 <=约204 可接受;为凑 200 再截会把类别截没=新的归因事故)。
 *
 * 约束:零 require、零副作用(不 mkdir、不写日志、不读 env、不碰 fs)。
 */

const CAUSE_MAX = 200;

// 无信息壳有两类:'Error'/'SyntaxError' 这类异常名壳,以及 String(x) 塌成的 toString 标签 '[object Object]' 等。
// 两者都取不到有信息正文 ⇒ 一律诚实判"未知",绝不把壳本身当原因外泄(运维读到 '[object Object]' 等于没读到)。
// 判据必须整串锚定:真实正文里含 '[object Object]' 子串(如"参数不可序列化"提示)时不得被误杀成"未知"。
const SHELL_RE = /^(\[object \w+\]|[A-Za-z]*Error)$/;

function causeOf (e) {
  const msg = String((e && e.message) || e || '').replace(/\s+/g, ' ').trim();
  // 空串,或命中异常名壳/toString 标签壳(如 'Error'、'[object Object]')都取不到有信息正文 => 诚实说"未知",
  // 绝不把壳本身当原因外泄
  if (!msg || SHELL_RE.test(msg)) return '未知故障（无异常信息）';
  if (msg.length <= CAUSE_MAX) return msg;
  const codeMatch = /^[A-Z]+(?=:| )/.exec(msg);
  const prefix = codeMatch ? codeMatch[0] + ': ' : '';
  return prefix + '…' + msg.slice(-(CAUSE_MAX - prefix.length - 1));
}

module.exports = { causeOf, CAUSE_MAX };
