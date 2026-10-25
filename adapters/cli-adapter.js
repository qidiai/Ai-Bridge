'use strict';

/**
 * CliAdapter — CLI 传输适配器
 *
 * 通过 spawn 子进程调用 AI 编程工具的 CLI。
 * 安全设计：shell:false, windowsHide, 严格退出码判成败。
 *
 * 配置字段:
 *   command:        命令名 (如 "openclaw")
 *   commandPaths:   绝对路径候选 (如 ["{{LOCALAPPDATA}}/AtomCode/atomcode.exe"])
 *                   #81 起:候选命中既决定可用位,也真正用于执行期(两侧同一把尺)
 *   args:            参数模板 (支持 {{task}} {{messageFile}} {{sessionId}} {{outputDir}} {{workspaceDir}} {{taskId}})
 *   inputMode:       arg | message-file | stdin
 *   outputMode:      stdout-text | stdout-json | file
 *   parse.textPath:  stdout-json 模式下提取文本的 JSONPath
 *   parse.usagePath: stdout-json 模式下提取 usage 的 JSONPath
 *   parse.outputFile: file 模式下要读取的输出文件名
 *   timeout:         超时毫秒数
 *   modelFlag:       可选,模型参数字面(如 "-m")。声明后 execute 的 opts.model
 *                    会覆盖 args 中该 flag 的下一个参数(不存在则追加),实现运行时模型透传
 *
 * 执行目录:
 *   opts.workspaceDir 存在时,子进程 cwd = workspaceDir(工作区模式);
 *   否则回退到 outputDir(一次性输出目录,兼容旧行为)。
 *   outputDir 始终用于存放 input.txt 等桥接中间产物。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { BaseAdapter } = require('./base');
const { parsePositiveInt } = require('../env-int');

// Windows CreateProcess 命令行上限约 32K 字符，留出模板其余部分的安全余量
const MAX_ARG_TASK_LEN = 24000;

// 输出总量上限(字符数,非精确字节):防失控子进程无限吐出拖垮内存;可用 env 覆盖,默认 10MB
// #96 R4:走 env-int 单点整串解析(带变量名留痕),不再手搓 parseInt 前缀宽容
// #102 R1/R2:求值挪到模块顶层(runCommand 之外)——server.js 经 tool-registry.js 加载本文件即点名,
// 配置写错在启动那一刻向 stderr 留痕;模块顶层每进程只执行一次 ⇒ 同一非法值最多留痕一次。
// R3:上限仍在每次 runCommand 的 checkOutputLimit 里真正执行(判定式与 kill 逻辑一字未动)。
const MAX_OUTPUT_CHARS = parsePositiveInt(process.env.AI_BRIDGE_CLI_MAX_OUTPUT_CHARS, 10 * 1024 * 1024, 'AI_BRIDGE_CLI_MAX_OUTPUT_CHARS');

class CliAdapter extends BaseAdapter {
  constructor (config) {
    super(config);
    this.inputMode = config.inputMode || 'arg';
    this.outputMode = config.outputMode || 'stdout-text';
    this.parseConfig = config.parse || {};
    this.timeout = config.timeout || 120000;
    this.commandPaths = config.commandPaths || [];
  }

  /**
   * 检测命令是否可用
   * #81:与执行期共用同一个解析函数 resolveCommandPath —— 不存在第二把"命令在哪里"的尺,
   * 于是 available === true 的含义就是"执行期确实能解析出一个可执行文件"(回环)。
   * 只做路径判定,绝不 spawn 真实命令(启动期每个工具都 detect 一次,副作用与成本都不可接受)。
   */
  async detect () {
    return (await resolveCommandPath(this.config.command, this.commandPaths)) !== null;
  }

  /**
   * 执行任务
   */
  async execute (task, opts = {}) {
    // ── 模型透传:校验先行,必须在任何 spawn/落盘之前抛出 ──
    // opts.model 为 undefined/null/空串/纯空白/非字符串 → 视为未指定;合法但工具未声明 modelFlag → 静默忽略,行为原样
    let modelOverride = null;
    if (typeof opts.model === 'string' && opts.model.trim() !== '') {
      if (!/^[A-Za-z0-9][A-Za-z0-9.:/@_-]{0,79}$/.test(opts.model)) {
        throw new Error(`model 名称不合法: ${opts.model.substring(0, 40)}`);
      }
      modelOverride = opts.model;
    }

    const taskId = opts.taskId || `${this.name}_${Date.now()}`;
    // 默认输出根固定在 ai-bridge/output(不随进程 cwd 漂移,与 server 清理逻辑同一坐标系)
    const dir = opts.outputDir || path.join(__dirname, '..', 'output', `${this.name}_${taskId}`);
    fs.mkdirSync(dir, { recursive: true });

    const workspaceDir = opts.workspaceDir ? path.resolve(opts.workspaceDir) : dir;
    if (opts.workspaceDir && (!fs.existsSync(workspaceDir) || !fs.statSync(workspaceDir).isDirectory())) {
      throw new Error(`工作区目录不存在或不是目录: ${workspaceDir}`);
    }

    const sessionId = `bridge-${taskId}-${Date.now()}`;

    // 准备输入
    let messageFile = null;
    if (this.inputMode === 'message-file') {
      messageFile = path.join(dir, 'input.txt');
      fs.writeFileSync(messageFile, task, 'utf-8');
    }

    // Windows 命令行 argv 上限约 32K：arg 模式超长时落盘，任务文本改为让 agent 读文件的短指令
    // 落盘位置用 cwd(workspaceDir)内的相对路径,保证 agent 以自身 cwd 就能读到,且不污染任务目录之外的位置
    // 文件名含 taskId:同一工作区并发多个超长任务时,固定名会互踩(后写者覆盖/先完成者误删),必须唯一
    let effectiveTask = task;
    let longTaskFile = null;
    if (this.inputMode === 'arg' && task.length > MAX_ARG_TASK_LEN) {
      const longTaskName = `ai-bridge-long-task-${taskId}.md`;
      longTaskFile = path.join(workspaceDir, longTaskName);
      fs.writeFileSync(longTaskFile, task, 'utf-8');
      effectiveTask = `完整任务内容已写入当前目录下的文件: ./${longTaskName}\n请先读取该文件的全部内容，然后严格按照文件中的指令执行任务并给出最终结果。`;
    }

    // 构建参数（模板替换）
    const args = (this.config.args || []).map(arg => {
      return replaceTemplates(arg, {
        task: effectiveTask,
        messageFile: messageFile || '',
        sessionId,
        outputDir: dir,
        workspaceDir,
        taskId
      });
    });

    // 模型覆盖:仅对声明了 modelFlag 的工具生效。
    // 替换基于模板替换后的 args 数组:找到第一个等于 modelFlag 的位置 i,把 i+1 替换为用户模型;
    // args 中不存在该 flag 时在末尾追加 [modelFlag, model]。args 是 map() 生成的新数组,并发安全不污染 config。
    if (modelOverride && this.config.modelFlag) {
      const flag = this.config.modelFlag;
      const flagIdx = args.indexOf(flag);
      if (flagIdx >= 0) {
        if (flagIdx + 1 < args.length) args[flagIdx + 1] = modelOverride;
        else args.push(modelOverride);
      } else {
        args.push(flag, modelOverride);
      }
    }

    // 执行
    const stdin = this.inputMode === 'stdin' ? task : null;
    let stdout;
    try {
      stdout = await runCommand(this.config.command, args, {
        timeout: opts.timeout || this.timeout,
        cwd: workspaceDir,
        stdin,
        // #81 同源:commandPaths 不再是一条"只喂可用位、不喂执行"的半截通道 ——
        // 执行期同样把它交给同一个解析器,命中就用那个绝对路径去 spawn
        commandPaths: this.commandPaths
      });
    } finally {
      if (longTaskFile) { try { fs.rmSync(longTaskFile, { force: true }); } catch (_) {} }
    }

    // 解析输出
    return this.parseOutput(stdout, dir, workspaceDir);
  }

  /**
   * 按 outputMode 解析命令输出
   */
  parseOutput (stdout, outputDir, workspaceDir = outputDir) {
    switch (this.outputMode) {
      case 'stdout-text':
        return this.buildResult(stdout);

      case 'stdout-json': {
        // 尝试从 stdout 中找到 JSON 部分
        const jsonResult = extractJSON(stdout);
        if (!jsonResult) {
          // JSON 解析失败，fallback 到原始文本
          return this.buildResult(stdout);
        }

        // 用 parsePath 提取文本
        const text = this.parseConfig.textPath
          ? this.parsePath(jsonResult, this.parseConfig.textPath)
          : null;

        // 用 parsePath 提取 usage
        let usage = null;
        if (this.parseConfig.usagePath) {
          const rawUsage = this.parsePath(jsonResult, this.parseConfig.usagePath);
          if (rawUsage) {
            usage = {
              input: rawUsage.input || rawUsage.inputTokens || 0,
              output: rawUsage.output || rawUsage.outputTokens || 0,
              estimated: false
            };
            usage.total = usage.input + usage.output;
          }
        }

        return this.buildResult(text || stdout, usage);
      }

      case 'file': {
        const outputName = this.parseConfig.outputFile || 'output.md';
        let outputFile = path.join(outputDir, outputName);
        // 工作区模式:工具可能把文件直接写进 cwd,两级回退
        if (!fs.existsSync(outputFile) && workspaceDir !== outputDir) {
          outputFile = path.join(workspaceDir, outputName);
        }
        let content = '';
        if (fs.existsSync(outputFile)) {
          content = fs.readFileSync(outputFile, 'utf-8');
        }
        if (!content.trim()) {
          throw new Error(`${this.config.command} 未产出 ${outputName}`);
        }
        return this.buildResult(content);
      }

      default:
        return this.buildResult(stdout);
    }
  }
}

// ============================================================
// 命令解析唯一入口（#81：可用位与执行期同源）
// detect() 与 runCommand() 都必须且只经 resolveCommandPath；
// 绝对路径 / 相对路径 / commandPaths 三条支路各只写这一处，禁止任何一侧再各写一遍 existsSync。
// ============================================================

/** 路径是否为真实文件（不存在、或是目录 → false） */
function isExecFile (p) {
  return !!p && fs.existsSync(p) && fs.statSync(p).isFile();
}

/**
 * PATH 探测：全项目唯一的 where/which 子进程调用点（每次调用至多 1 个子进程）
 * @returns {Promise<string|null>} 命中的可执行文件路径；查不到返回 null
 */
async function findInPath (name) {
  const isWin = process.platform === 'win32';
  const checker = isWin ? 'where' : 'which';
  const raw = await new Promise((resolve) => {
    // windowsHide:改造前执行期那次 PATH 查询是带 windowsHide: true 的同步调用,
    // 合并成单一入口后必须把这项带着,否则服务态(无控制台)会多出控制台闪窗
    const child = spawn(checker, [name], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let found = '';
    child.stdout.on('data', d => found += d);
    // 退出码非 0 / 子进程起不来(ENOENT 等)一律归一为"查不到"，不抛出
    child.on('close', code => resolve(code === 0 ? found : ''));
    child.on('error', () => resolve(''));
  });
  if (!raw) return null;
  const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  // .cmd/.bat/.exe 优先（裸名常被 npm shim 接管）：执行期原本就是这个偏好，
  // 现在可用位与它同一把尺，不再出现"detect 认第一行、执行认另一行"的错位
  const preferred = lines.find(l => /\.(cmd|bat|exe)$/i.test(l) && isExecFile(l));
  return preferred || lines.find(l => isExecFile(l)) || null;
}

/**
 * 把一个 CLI 配置解析成真实可执行文件路径；解析不出来 = 不可用。
 * 支路顺序（前三条纯 fs、零子进程）：
 *   ① command 本身是绝对路径且存在
 *   ② command 是相对当前 cwd 且存在的路径
 *   ③ commandPaths 候选（{{ENV}} 模板解析行为不变）
 *   ④ PATH 查询 —— 整个函数里唯一一次 where/which 子进程
 * ①②③ 都不命中才走 ④；绝对路径查不到时也会落到 ④（与改造前逐字同结果，
 * Windows 下 `where <绝对路径>` 恒退出码 2 而已，不额外起子进程数量）。
 * @returns {Promise<string|null>}
 */
async function resolveCommandPath (cmd, commandPaths) {
  const candidates = Array.isArray(commandPaths) ? commandPaths : [];
  const usable = typeof cmd === 'string' && cmd.trim() !== '';
  if (usable && path.isAbsolute(cmd) && isExecFile(cmd)) return cmd;
  if (usable && !path.isAbsolute(cmd) && isExecFile(cmd)) return path.resolve(cmd);
  for (const p of candidates) {
    const resolved = resolveEnvVars(p);
    if (isExecFile(resolved)) return resolved;
  }
  return usable ? findInPath(cmd) : null;
}

/** Run command safely (严格按退出码判成败;无 shell:true 注入面) */
async function runCommand (cmd, args, opts = {}) {
  // #81 同源:执行期与 detect() 共用 resolveCommandPath(含 commandPaths),
  // 消灭"标着可用、派发即失败"与"跑得动却标不可用"两个对称缺陷。
  const resolved = await resolveCommandPath(cmd, opts.commandPaths);
  if (!resolved) {
    throw new Error(`命令未找到或无法安全解析: ${cmd}(已禁用 shell 回退以防命令注入)`);
  }
  // .cmd/.bat 不能直接交给 CreateProcess,必须经 cmd.exe /c 拉起(路径本身已由解析器确认可存在)
  const isBatch = /\.(?:cmd|bat)$/i.test(resolved);
  const actualCmd = isBatch ? (process.env.ComSpec || 'cmd.exe') : resolved;
  const actualArgs = isBatch ? ['/c', resolved, ...args] : args;

  return new Promise((resolve, reject) => {
    const child = spawn(actualCmd, actualArgs, {
      cwd: opts.cwd || process.cwd(),
      timeout: opts.timeout || 120000,
      env: { ...process.env, FORCE_COLOR: '0' },
      shell: false,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    // #102 R3:MAX_OUTPUT_CHARS 已在模块顶层求值(见文件头),此处仅引用;
    // checkOutputLimit 判定式与 kill 逻辑保持原样 —— 上限仍在每次 runCommand 里真正执行
    let settled = false; // 防 kill 后 close/error 事件二次 resolve/reject
    function settleReject (err) {
      if (settled) return;
      settled = true;
      reject(err);
    }
    function checkOutputLimit () {
      if (stdout.length + stderr.length > MAX_OUTPUT_CHARS) {
        try { child.kill(); } catch { /* 已退出则忽略 */ }
        settleReject(new Error(`输出超过 ${MAX_OUTPUT_CHARS} 字符上限,已终止`));
      }
    }

    child.stdout.on('data', d => { stdout += d.toString(); checkOutputLimit(); });
    child.stderr.on('data', d => { stderr += d.toString(); checkOutputLimit(); });

    if (opts.stdin) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve(stdout);
        return;
      }
      // 计算真实生效的超时预算(不得写死数字,从 opts 链取)
      const budgetMs = opts.timeout || 120000;
      // 详情取尾部(真因几乎总在末尾),总长度有界防止巨量输出灌进台账行
      const rawDetail = (stderr || stdout).trim();
      const detail = rawDetail.length > 200
        ? '...' + rawDetail.slice(-200)
        : (rawDetail || '(无输出)');
      let message;
      if (code === null && signal) {
        // 被信号终止(超时或被外部 kill):绝不出现 "code null" 无归因字面
        message = `命令被信号 ${signal} 终止(超时预算 ${budgetMs}ms 用尽,或外部主动终止): ${detail}`;
      } else if (signal) {
        // 罕见:code 非 null 但 signal 也存在(Windows 少见) — 按非零退出处理,但带上 signal 信息
        message = `Command exited with code ${code} (signal: ${signal}): ${detail}`;
      } else {
        // 正常非零退出
        message = `Command exited with code ${code}: ${detail}`;
      }
      const err = new Error(message);
      err.code = code;
      err.signal = signal || null;
      err.stdout = stdout;
      err.timedOut = (code === null && !!signal);
      reject(err);
    });

    child.on('error', (err) => {
      settleReject(new Error(`Execution failed: ${err.message}`));
    });
  });
}

/**
 * 模板变量替换
 * {{task}} {{messageFile}} {{sessionId}} {{outputDir}} {{workspaceDir}} {{taskId}}
 */
function replaceTemplates (str, vars) {
  return str
    .replace(/\{\{task\}\}/g, vars.task || '')
    .replace(/\{\{messageFile\}\}/g, vars.messageFile || '')
    .replace(/\{\{sessionId\}\}/g, vars.sessionId || '')
    .replace(/\{\{outputDir\}\}/g, vars.outputDir || '')
    .replace(/\{\{workspaceDir\}\}/g, vars.workspaceDir || '')
    .replace(/\{\{taskId\}\}/g, vars.taskId || '');
}

/**
 * 环境变量替换（用于 commandPaths）
 * {{LOCALAPPDATA}} {{APPDATA}} {{USERPROFILE}} {{ProgramFiles}}
 */
function resolveEnvVars (str) {
  return str
    .replace(/\{\{LOCALAPPDATA\}\}/g, process.env.LOCALAPPDATA || '')
    .replace(/\{\{APPDATA\}\}/g, process.env.APPDATA || '')
    .replace(/\{\{USERPROFILE\}\}/g, process.env.USERPROFILE || '')
    .replace(/\{\{ProgramFiles\}\}/g, process.env.ProgramFiles || '')
    .replace(/\{\{ProgramFiles\(x86\)\}\}/g, process.env['ProgramFiles(x86)'] || '')
    .replace(/\//g, path.sep); // Unix → Windows 路径分隔符
}

/**
 * 从 stdout 中提取 JSON
 * 支持：纯 JSON、JSON 前有日志行（找第一个 { 开始）
 */
function extractJSON (stdout) {
  const lines = stdout.split('\n');
  const jsonStart = lines.findIndex(l => l.trim().startsWith('{'));
  if (jsonStart < 0) return null;

  const jsonText = lines.slice(jsonStart).join('\n');
  try {
    return JSON.parse(jsonText);
  } catch (_) {
    // 尝试正则提取最外层 JSON
    const match = stdout.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (_) {}
    }
    return null;
  }
}

module.exports = { CliAdapter, runCommand };
