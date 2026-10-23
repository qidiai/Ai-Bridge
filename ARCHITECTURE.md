# AI Bridge 架构图

> 更新：2026-10-22（MCP 工具面三轨裁剪：20→15 + AI_BRIDGE_TOOLSET 角色套餐；字节数口径见 README）

## 模块分层

```
┌────────────────────────────────────────────────────────────────┐
│ 接入层(仅本机 127.0.0.1:9800)                                   │
│  bridge-stdio.js   MCP stdio 桥接器(全量 15 个;lite 套餐 5 个)  │
│  ui.html           Web UI(8 Tab:仪表盘/派发/讨论/记忆/日志/流量/用量/模型) │
└──────────────┬─────────────────────────────────────────────────┘
┌──────────────▼─────────────────────────────────────────────────┐
│ 服务层 server.js (HTTP 常驻, nssm 服务 AIBridgeHub)              │
│  ├─ /api/*          调度/讨论/评审/记忆/流量/观测/用量 API        │
│  ├─ /api/health     健康检查(免凭据=存活7字段;余须凭据 #68)       │
│  ├─ /v1/models + /api/models/sync   模型清单与自动同步            │
│  ├─ /v1/chat/completions            OpenAI 兼容反代(含幂等缓存)   │
│  ├─ /v1/messages                    Anthropic 兼容反代(?beta=1) │
│  ├─ /proxy/<source>/<key>/...       透传观测代理                  │
│  └─ 凭据区: AgnesToken(凭据管理器) / AtomToken(auth.toml)         │
├────────────────────────────────────────────────────────────────┤
│ 注册表                                                          │
│  tool-registry.js  工具配置注册表(读 tools.json)                 │
│  tool-identity.js  工具身份归一化(canonical/实例ID分离)           │
│  routing-score.js  7维贝叶斯路由评分(衰减加权+Wilson+冷却)        │
│  workspace-manager.js 工作区注册表(登记/受管/归档/独占租约)       │
├────────────────────────────────────────────────────────────────┤
│ 适配层 adapters/   base.js / cli-adapter.js / http-adapter      │
├────────────────────────────────────────────────────────────────┤
│ 持久层                                                          │
│  db.js             SQLite 全局库(7表: dispatches/meetings/       │
│                    reviews/async_tasks/events/traffic+用量报表)  │
│  store.js          JSON 持久化(memory.json/workspaces.json) + 日志轮转 │
│  observe.js        工具 baseUrl 接管/代理路由                     │
│  watchdog.js       进程守护(自动重启+熔断)                        │
└────────────────────────────────────────────────────────────────┘
```

## OpenAI 反代数据流（/v1/chat/completions）

```
客户端(Base URL=http://127.0.0.1:9800/v1)
  │  POST {model, messages, stream?}
  ▼
server.js → findModel(models.json) → modelEnabled(switches.json)
  │
  ├─ 幂等缓存查询(sha256(model+messages+参数), TTL 10min, LRU 100)
  │    命中 → X-Cache: HIT 直接回放(非流式) / 合成单块 SSE(流式)
  │
  ├─ transport=agnes-http ──→ AgnesCode 上游(凭据管理器 token)
  │
  ├─ transport=local-vl ──→ Ollama /api/chat (127.0.0.1:11434)
  │        OpenAI 消息转 Ollama 格式(图片 image_url→base64 images)
  │        流式: NDJSON→OpenAI SSE 逐块转换; 非流式: 直接映射+usage
  │
  └─ transport=cli ──→ CliAdapter spawn 子工具 CLI(atomcode/codely 等)
        Codely 路线: spawn 官方 codely.exe -y --model <id> -p <task>
        (2026-08-26 起: codely-http 自签直连因 session 签名检测被封号,已弃用)
```

## Anthropic 反代数据流（/v1/messages）

```
Claude Code 类客户端(ANTHROPIC_BASE_URL=http://127.0.0.1:9800)
  │  POST /v1/messages {model, messages, stream?}
  ▼
server.js → findModel → transport 上游
  上游需要 Anthropic 兼容层时附加 ?beta=1(官方拦截器用 URL.pathname 计算签名)
  响应原样透传(Anthropic 格式,含 SSE)
```

## 模型清单自动同步（POST /api/models/sync）

```
GET 上游 /v1/models(带鉴权) → 上游模型列表
  → diff models.json 中对应 transport 条目
  → 新增: {id, owned_by, switch, transport}
  → 写回 models.json + 失效内存缓存
```

## 路由自学习闭环（已存在，无新代码）

```
doDispatch → store.recordTask(results{success,duration,tokens,fallbackLog})
  → getToolObservations(含 fallback 失败补偿样本)
  → buildRoutingProfile(14天半衰期加权 + Bayesian成功率 + Wilson稳定性 + 30min失败冷却)
  → 下次 dispatch 未指定 tools 时 rankRoutingProfiles 自动选优
```

## 讨论会流程（runDiscussionAsync）

```
创建(异步返回 meetingId) → 第一轮各自发言 → (可中断/注入/自动止损)
  → 第二轮互相回应 → 共识总结(结论/分歧/行动项→经验库)
  → 共识度评分(每位参与者表态 赞成/有保留/反对 → N% 共识度)
  → 可选自动实现(doDispatch) → closeMeeting + SQLite 写穿
```

## 工作区流程（workspace-manager）

```
POST /api/workspaces {name, path?, exclusive?}
  ├─ 无 path → managed: 在 AI_BRIDGE_WORKSPACE_ROOT 下创建目录(受管,可回收)
  └─ 有 path → linked:  登记已存在目录(绝对路径/拒绝根目录,永不删文件)
  → workspaces.json 原子写入(store.saveSync)
  ▼
dispatch/handoff 带 workspace(id/name/path 均可解析)
  → resolveForDispatch(归档/不存在 → 4xx)
  → beginRun 租约(exclusive 工作区已有运行 → 409)
  → CliAdapter cwd={{workspaceDir}}, {{workspaceDir}} 模板 = 工作区路径
  → finally endRun(释放租约;更新 useCount/lastUsedAt)
  ▼
archive/restore 切换 status;运行中工作区禁止归档/删除
remove: linked 仅解除登记;managed + delete_files=1 且 realpath 严格落在根内才递归删除
```

## 超时与预算模型（三层，2026-10-23 起）

一次"把任务派给外部软件/CLI"的调用，最长能活多久由**三层**独立预算决定，它们必须同向，否则会出现"下游还在干活、上游已判死刑"的假失败：

| 层 | 位置 | 取值 | 说明 |
|----|------|------|------|
| 中枢执行窗口 | `server.js:47` `CONFIG.EXECUTE_TIMEOUT` | `AI_BRIDGE_EXECUTE_TIMEOUT`，默认 900000 | 用于 CLI 执行链 `:580`（`opts.timeout ‖ tool.timeout ‖ EXECUTE_TIMEOUT`）与客户端反向执行 `:683` |
| 桥侧 HTTP 预算 | `bridge-stdio.js:25` `HTTP_TIMEOUT_MS` | `AI_BRIDGE_HTTP_TIMEOUT`，默认 **960000** | POST/同步类默认值；**不变式：≥ 中枢窗口 + 30000**（桥先判死＝误报失败 + 脏台账）。由 `test-audit-fixes` 段 F 数值关系锁守护（不写死常量，改窗口时锁跟着动） |
| 桥侧工具总超时 | `bridge-stdio.js:31` `CALL_BUDGET_MS = HTTP_TIMEOUT_MS + 30000` | 派生 | `callTool` 用 `Promise.race` 包住整个工具调用（`:285`），串行多跳（handoff 的 POST→GET、discuss 的 POST→轮询）的**累加**耗时不再无界；`finally` 必 `clearTimeout`，不留孤儿定时器 |
| 适配器进程超时 | `adapters/cli-adapter.js:321` `budgetMs = opts.timeout ‖ 120000` | tools.json 的 `tool.timeout` | 与 `:281` 传给 `spawn({timeout})` 的是**同一表达式**，错误文案里的预算数字因此是真实生效值，不是第二个写死的数 |

两处**有意不同源**的例外（都是被锁定测试钉住的，不得"顺手统一"）：

- `GET_TIMEOUT_MS`（`bridge-stdio.js:29`）未设 env 时仍为 **30000**：`pollLoop` 的 30s 快速失败是桥自愈节奏，抬到 960s 会让 `test-e2e #38a`（无 env 时黑洞约 30010ms 自行回 `isError`）当场回归。设了 `AI_BRIDGE_HTTP_TIMEOUT` 时 GET/POST 同源覆盖。
- 关停期注销预算 `httpPost('/api/client/unregister', …, 1500)` 是**具名调用点例外**（既有代码），删掉它会让关停挂满 16 分钟，收敛单点封装时再统一命名。

**超时归因的真实形状（#54）**：`spawn({timeout})` 杀死子进程时 `close` 回 `code=null, signal='SIGTERM'`（本机实测）。适配器必须收下 `signal` 并分三支归因，且失败详情取 **`stderr‖stdout` 的尾部**（有界）——头部往往是 CLI 自己的启动横幅，历史上曾被当成"失败原因"写进台账（`Command exited with code null: Console code pages…`，实测流量 18 行 + `fallbackLog` 12 处）。

## 客户端注册·能力·状态契约（2026-10-23 起）

外部编程软件经 `bridge-stdio.js` 接入后的三条硬契约：

1. **能力只认"更晚的决定"，但允许真撤回**（#50）。注册带单调 `registerSeq`（毫秒基数×1000＋进程内递增，跨进程可比且在 2^53 内）。`server.js` 的 register 处理器对 **seq 更小者拒绝改动能力字段**（防"桥启动即发的 `sampling=false` 迟到覆写宿主声明的 true"），而 **seq 更大者允许把能力改回 false**（宿主真的不再支持时不留虚高）。不带 `registerSeq` 的旧客户端 `seq=null` → 行为与既往完全一致。桥侧：宿主 `initialize` 若早于首注册回执到达，置 `pendingCapRefresh`，首注册 `approved` 后用更大 seq **补发一次**（发后不理，不阻塞回执）。准入前提：只有"完成过首轮 poll、未 stale、`supportsSampling===true`"的客户端才进入执行调度面（`server.js:379`）。
2. **任务态条目禁止整体替换**（#41）。`connectedClients` 的存活条目只能用 `client.x = …` 就地写；`set(key, {...存活对象, …})` 取的是**局部变量快照**，会与就地 mutate 的超时清理互相"复活"已清空字段。此不变式由 `test-audit-fixes` 段 G 的结构锁守护（`spread-set` 必须为 0；注册**新建**条目用 `set` 是合法的，不属禁止面）。
3. **状态判据是三个字段之或**（`server.js:449`）：`pendingResolve ‖ _busy ‖ taskPending → online_busy`。因此**每个置 true 的字段都必须有对应的清理出口**——#59 补的就是超时清理里漏掉的 `taskPending`（`:679`），否则"取走任务却没回结果"的客户端会被永久误判 busy，而打开的长轮询每秒还在 `:1732` 续 `lastSeen`，连 `stale` 兜底都触发不了。`taskPending` 的写点：`:1710`/`:1736`（poll 取走）、`:1762`（result 复位）、`:679`（超时复位）。

已知未修（见 README「已知问题」）：同默认名 `unknown`（`bridge-stdio.js:18`）的多会话会塌进**同一个**在册条目，且复用的是静默分支（无日志）→ 不可观测（#57）；`no_targets` 归因对"别名点名的无资格在册客户端"仍报"未知工具"（#56）。

## 影响链（改 A 影响谁）

| 改动点 | 影响 |
|--------|------|
| models.json | /v1/models 清单、transport 分支选择、模型同步 diff 基线 |
| workspaces.json | /api/workspaces、dispatch/handoff 的 cwd 绑定、归档/租约判定 |
| switches.json | 禁用工具 → 模型从清单消失、dispatch 跳过 |
| codely-client.js 缺失(开源版) | codely-http 模型不可用,health/probe 返回明确错误 |
| Ollama 未运行 | local-vl 模型返回 502/503 明确指引 |
| /v1 反代不可用 | 所有 Base URL 指向 9800 的客户端(zcode/Claude Code 等)报错 |
| nssm 服务环境变量 | AI_BRIDGE_HOST 改 0.0.0.0 会暴露无鉴权端点(已改回 127.0.0.1) |
| tools.json | **仅在进程启动时被 `tool-registry.js:84 const TOOLS = loadTools()` 读一次**，全仓无第二处调用、无写 tools.json 的端点 → 运行中的中枢不会重读；改文件只影响下一次启动（实测：临时给文件加一个假工具后，在跑的生产中枢仍只报原 12 个）。推论：#46「tools.json 损坏即崩」只在启动时发生，运行期改坏不会立刻炸 |
| CONFIG.EXECUTE_TIMEOUT | 桥侧 `HTTP_TIMEOUT_MS`/`CALL_BUDGET_MS` 的下界依据（不变式：桥预算 ≥ 窗口 + 30000，`test-audit-fixes` 段 F 锁死）；改窗口不同步改桥默认值 → 长任务假失败回归 |
| clientState 判据 | `/api/clients`、Web UI 在线态、按 state 打分的可观测面；新增/删除判据字段必须同时补齐所有清理出口（#59 的教训：置 true 有 3 处、置 false 只 1 处 = 状态位烂死） |
| dispatch 响应的 total/skipped | 桥侧三处渲染（`bridge-stdio.js:317/318` 汇总与跳过、`:382`/`:397` 历史列表用 `results.length`）——**同一件事已有三种分母实现**，改任一分母语义必须三处同批统一（#36） |
| 非 2xx 承载业务语义的端点 | 桥按结构化字段解包（`/api/poll` 404 未注册→重注册自愈、`/api/client/register` 403 denied→30s 慢重试、`no_targets`→409）。新增此类端点必须同步桥侧解包，否则宿主只看到 `isError` 文案 |

## 配置消费者

| 文件/环境变量 | 消费者 |
|------|--------|
| tools.json | tool-registry → /api/tools、dispatch、讨论会 |
| models.json | loadModels → /v1/models、/v1/chat/completions、/v1/messages |
| switches.json | isToolEnabled → 工具开关、模型过滤 |
| clients-acl.json | 准入控制(白名单/黑名单/待审批) |
| workspaces.json | workspace-manager → /api/workspaces、dispatch/handoff |
| AI_BRIDGE_WORKSPACE_ROOT | managed 工作区根目录(创建/回收边界) |
| AI_BRIDGE_CACHE_TTL/MAX | 反代幂等缓存 |
| AI_BRIDGE_DAILY_TOKEN_BUDGET | /api/health 预算告警 |
| AI_BRIDGE_OLLAMA_BASE | local-vl 上游地址 |
| AI_BRIDGE_EXECUTE_TIMEOUT | 中枢单次执行窗口（`server.js:47` → CLI 执行链 `:580`、客户端反向执行 `:683`、超时清理 `:672-680`） |
| AI_BRIDGE_HTTP_TIMEOUT | 桥侧同步预算（`bridge-stdio.js:25/29/31` → `httpPost`/`httpGet`/`callTool` 总超时）；未设时 GET 仍走 30000ms 自愈节奏 |
| AI_BRIDGE_SAMPLING_TIMEOUT | 桥侧反向 `sampling/createMessage` 的防泄漏兜底（默认 900000，节奏由中枢窗口管控） |
| AI_BRIDGE_CAP_EXEC | 桥是否声明 exec 能力（严格 opt-in：`1/true/yes/on`）；决定能否承接 workspace 任务 |
| AI_BRIDGE_CLIENT | 桥在册身份名（默认 `unknown`，见 #57 的多会话塌缩风险） |
| AI_BRIDGE_DATA_DIR | store 层 JSON 数据目录（测试/沙箱实例的隔离锚点） |
| AI_BRIDGE_DB | 全局 SQLite 路径（默认 `~/.ai-bridge/bridge.db`；沙箱实例必须同时隔离它，否则写穿生产台账） |
| AI_BRIDGE_TOOLSET | 桥暴露工具套餐 full(15)/lite(5)，直接决定 `tools/list` 响应体积 |

## 修复/演进清单

- [x] 2026-08-21 反代修复:上游强制签名策略,旧实现 401。新增签名校验+401换key重试。
- [x] 2026-08-22 安全:服务绑定 0.0.0.0→127.0.0.1(堵局域网白嫖);清理 34 个 .bak/_patch 残留。
- [x] 2026-08-22 健壮:UA 自动跟版(扫 exe 版本串);持续 401 告警;token JWT 到期监测(剩7天预警)。
- [x] 2026-08-22 功能:/v1/messages Anthropic 反代(?beta=1);local-vl Ollama 实现(NDJSON→SSE);幂等缓存(X-Cache:HIT);模型清单自动同步(/api/models/sync);用量报表(/api/usage/report+Web UI 用量Tab);共识度评分(discuss)。
- [x] 2026-08-22 工程:codely-client.js 拆分为可选模块(开源版剔除);单测全过(签名单测 8 项);全端点真实调用回归。
- [x] 2026-08-26 安全:官方按 session 签名检测封号(3个号全灭),codely-http 自签直连永久弃用;models.json 新增 glm-5.3/codely-core/codely-flash/kimi-k3 走 cli transport(spawn 官方 CLI,官方明示安全路径);switches.json 新增 codely-cli 开关;端到端测试通过。
- [x] 2026-08-26 调度:tools.json 注册 codely 为 dispatch 工具(spawn 官方 CLI,30min超时,默认模型跟随 codely settings);QIDI Code 经 MCP(.mcp.json 已接 bridge-stdio.js)可派发任务给 Codely;dispatch 端到端测试通过(10.4s)。
- [x] 2026-08-26 调度:新增 codely-k3 工具变体(--model KIMI-K3 执行),测试通过(100.2s,注意 K3 比 GLM-5.3 慢约10倍)。QIDI 侧只能用 K3 当执行模型,不能当大脑(bridge cli transport 无 tool_calls 协议,QIDI agent 循环不兼容)。
- [x] 2026-10-21 工作区(P0-1):新增 workspace-manager.js + workspaces.json;dispatch/handoff 支持 workspace 绑定,CLI 以工作区为 cwd;登记(linked)/受管(managed)双模式、归档/恢复、独占租约;HTTP /api/workspaces* 与 MCP list_workspaces/create_workspace;测试 test-workspace.mjs + E2E 工作区链路。
- [x] 2026-10-22 MCP 工具面裁剪:20→15(discuss 合并 action 枚举、manage_client 取代 approve/deny/kick、描述压缩、full/lite 双套餐);tools/list 响应 full 6880B / lite 1901B(-72%,口径:完整 JSON-RPC 响应字节数不含尾随换行,计换行为 6881B/1902B),commit 621161e
- [x] 2026-10-22 桥层失败路径根治(T-D):httpGet/httpPost 感知 HTTP 状态码,非 2xx reject 且 Error 附带 status/body;tools/call 异常统一降级为 MCP 规范 isError;`/api/poll` 404 未注册与 `/api/client/register` 403 denied 显式解包以保中枢重启后桥自愈。红→绿载体 test-e2e section 9.3,commit 4fc1c4a→b1adcbf
- [x] 2026-10-22 ai-bridge 独立 lint 护栏(E2-lint):`ai-bridge/.eslintrc.json` 以 `root:true` 切断仓根 eslint-config-standard 级联,关闭 12 项风格规则、保留 eslint:recommended 正确性规则,`.mjs` 测试按 ESM 解析;`package.json` 增 lint/test 脚本。实测 0 error/18 warning(13 项被排除的一次性脚本若入网亦 0 error)。CI 接线待仓根 ci.yml 解冻后接 `npm --prefix ai-bridge run lint`
- [x] 2026-10-23 P0 静默清库根治:坏 JSON 改名保全 `<file>.corrupt-<时间戳>` + 进程内脏标志拒绝覆写(不抛错),防任务历史被洗成 1 条 / 黑名单被清空 / 已关工具被静默回启。commit d374ea7
- [x] 2026-10-23 #39 会议孤儿启动清扫:并发闸门按 memory.json 的 discussing/active/implementing 计数(上限 3),崩溃残留会永久 429 死锁讨论。新增 `store.markOrphanMeetings()`,无孤儿不写盘、落盘被拒只留 error 日志绝不抛错。实测 156/156,commit d5f852b
- [x] 2026-10-23 #38 桥侧 `httpGet` 补 `timeout` 监听:Node 的 timeout 选项只发事件不自动中断,中枢半死时 GET 类工具永久悬空。实测黑洞耗时由"60015ms 靠宿主 RPC 超时"变为"30010ms 桥自行回 isError",commit 752aedd
- [x] 2026-10-23 #37 失败判定器根治:"谈论失败"的长文交付物被关键词子串判失败并销毁正文。引入 `looksLikeError`(≤400 字符或以错误头开头才算错误文本,ANSI 容忍)为关键词分支加门;失败条目保留正文;流量 `success` 与判定同一次裁决。实测 164/164,commit 4094d20
- [x] 2026-10-23 #52 【指挥官自己的回归】坏形状 `memory.json.meetings` 令中枢启动即崩:P0 只隔离"解析失败"，管不了"能解析但形状非法"。补形状守卫 + 启动期 try/catch(注释即约束:"启动期任何数据异常都不得阻止进程起来")。实测 335 项全绿,commit afacc4c
- [x] 2026-10-23 #50 乱序注册与能力补发根治(北极星主链第一道门):`registerSeq` 单调保护 + `pendingCapRefresh`;seq 更大者仍可真撤回(不做只升不降)。生产真验:探针桥故意乱序注册后仍取得 `supportsSampling/executionEligible`,并发乱序 515ms 收敛。commit 148135c
- [x] 2026-10-23 #53+#48 超时预算统一:桥 POST 预算 600000→**960000**(≥ 中枢窗口 900000+余量)且可 `AI_BRIDGE_HTTP_TIMEOUT` 配置;GET 形参化但**有意保持 30000** 自愈节奏;`callTool` 加 `Promise.race` 总超时并 `finally` 清定时器。实测 353 项双跑全绿,commit 012f828
- [x] 2026-10-23 #41 任务态 map 禁止整体替换:四处 `set(key, {...存活对象})` 改就地 mutate(局部快照会"复活"已清空字段);`:663` 名不副实的"CAS"注释改为如实的 check-then-act。副产物:入队不再更换条目对象身份,"先开长轮询后入队"时守卫通过,任务 ≤1s 直达。实测 358 项双跑全绿,commit c93ff54
- [x] 2026-10-23 #54 超时归因真实化:适配器 close 收下 `signal`、三分支归因、详情取**尾部且有界**、结构化 `err.signal/timedOut`;台账不再把 CLI 启动横幅当失败原因(实测历史污染:流量 18 行 + fallbackLog 12 处)。实测 362 项双跑全绿,commit 0db17d2
- [x] 2026-10-23 #59 超时清理补 `taskPending=false`:状态判据三字段之或里有置 true 无对应清理出口 → 客户端取走任务不回结果会被永久误判 `online_busy`。修复为**一行**；主验只能在中枢第二实例(`AI_BRIDGE_EXECUTE_TIMEOUT=4000` 造确定性超时,生产窗口不可改)，生产侧仅验结果路径未回退。实测 367 项双跑全绿,commit a8c30d6
- [x] 2026-10-23 #36 点名被跳过者诚实呈现:响应新增 `requested`(点名数,未点名时取 `targets.length`,绝不输出 0),`skipped` 升级为 `{ref, reason}`(`skippedTargetReason` 与 #50 归因同名字面),桥侧 `skippedLabel()` 兼容旧 `string[]` 并有跳过时抬分母(`1/1 成功(点名 2)`);历史视图三种分母实现收敛为 `total` 优先。`total` 语义与取值未动。实测 374 项双跑全绿,commit ae58da1。落盘缺口(`recordTask` 白名单不收 total/requested/skipped)登记 #62
- [x] 2026-10-23 #42 鉴权覆盖面扩到 `/v1/*` + UI 自证身份:门从只挡 `/api/` 扩到 `/api/`|`/v1/`(`:1248`),401 复用同一处 `sendJSON` 不新造错误体,`GET /` 与静态面仍开放;`ui.html` 以 `withAuth()` 为唯一凭据注入点(`api()` 与 `:620` 流式裸 fetch 都走它),401 提示一次并至多重试一次,错误体绝不进 SSE 解析器。实测 383 项双跑全绿,commit 765271c。残项:#64 `/proxy/*` 免凭据透传、#65 运维脚本不带凭据、#66 凭据取证 harness 常驻化
- [x] 2026-10-23 #68 `/api/health` 按鉴权态分视图 + `?probe=1` 判权前置:免鉴权 payload 只留 `status/uptime/port/clients/activeDispatches/dispatchTotal/version` 七个存活/负载字段,`codely`(CLI 版本、token 剩余天数)与 `usage`(今日 token、预算)仅 `checkAuth` 为真时追加;`?probe=1` 未鉴权一律 401 且**绝不发起上游**(该分支每次调用都带真实签名打 LiteLLM,是放大器也是成本)。豁免理由经核不成立:`watchdog.js` 对 health 引用数=0(判活靠 `:49` child exit),唯一使用方 `edge-agent.js:186` 自带凭据。红基线 192/193(`#68a1` 外带 `[codely,usage]`)→ 我审计时补 `#68b1`/`#68b2`(probe 面原本无常驻锁),交付 389 项双跑全绿,commit 00a7894。核准遗留:#69(edge-agent 漏配 token 静默降级应自检告警)、#70(probe 面零调用方,裁定是否整段删除)
- [x] 2026-10-23 测试面现状:六套件合计 **389 项**(unit 41 / workspace 36 / store-corrupt 23 / audit-fixes 49 / external-fixes 45 / e2e 195),两轮同数才允许合并;`TEST-LOCK.json` 已拆分 `locked_tests`(行为冻结,编码手禁改) / `source_faces`(对照基线,指挥官每轮重算) / `source_faces_owner`(归属轮次,防并发覆盖只能靠哈希漂移反推)
- [ ] 未修清单(2026-10-23 快照,按队列序):#44 合法但形状错的 JSON 仍被静默覆写(#52 是点补);#43 写被拒却报 200、删工作区先删文件后落盘;#31 死代码与双账本;#45 usage 三处形状各写一遍;#46 tools.json 损坏即崩(与 P0 双重标准,现知只发生在启动时);#47 幂等缓存命中流式写出畸形 SSE;#40 恒假分支致 CLI 拿不到工作区简报;#51 工作区 path 无效时静默改建空目录;#26 吞异常门禁;#49 两个 HTTP 封装单点化 + slow-drip 兜底(含负数 env 钳制与注销预算具名化);#27/#28/#29 表驱动化/出口归一/仓库卫生;#56 别名点名的在册客户端被报"未知工具";**#57 同宿主多会话塌成 `unknown` 且塌缩静默不可观测**;**#58 MCP 面缺 `async` 派发与结果取回**;**#60 判定器短文本数字子串(401/402/429)仍会误伤**;#61 文档保真锁(env 表/套件计数/端点行号与源码同源——本轮 README 的 45/184/374 三处漂移就是该病的现行样本);#62 `recordTask` 字段白名单丢 total/requested/skipped;#63 测试残留清理不实且 `.bak-cleanup-*` 未被忽略;#64 `/proxy/*` 免凭据透传 + `checkAuth` 非恒定时间;#65 运维脚本硬连 9800 不带凭据;#66 凭据取证 harness 常驻化;#67 UI 流式解析三缺陷;#69 edge-agent 漏配凭据静默降级;#70 `?probe=1` 零调用方,裁定存废;#55 北极星端到端子智能体加载验收

