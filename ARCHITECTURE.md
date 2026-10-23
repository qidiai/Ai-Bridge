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
  │    命中 → X-Cache: HIT：非流式原字节回放；流式经 sse-replay 合成合法 SSE（两数据帧 + `data: [DONE]`，usage 原样透传）；流式但缓存体不可回放 → 逐出该条并回落正常转发（不吐坏流、不报错）
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
- [x] 2026-10-23 #44 形状非法与解析失败同口径:`store.js` 新增 `SHAPES` 契约表 + `assertShape`/`shapeReason`,在 `load`/`loadList` 的 `JSON.parse` 成功后统一把关——顶层须 plain object(拒 null/数组/primitive),`memory.tasks|experiences|meetings` 须数组、`preferences` 须对象,`acl.allowlist|blocklist|pending` 须数组,`workspaces.workspaces` 须数组,`switches`/`stats` 只锁顶层(值类型留给 #45/#46);**缺失字段属合法稀疏**(仍由 `loadMemory`/`loadACL` 补),数组元素不设卡(会误拒在用历史数据)。违规走既有 `quarantine`(保全改名 `.corrupt-*` + 置脏 + 拒写)并返回空结构,**绝不抛错**。修前三形态实测:字段类型错→`saveACL` wrote=true 静默覆写且 0 保全;`tasks` 为对象→`mem.tasks.unshift is not a function`;`acl=null`→`Cannot read properties of null`。红基线 c736792 = 27/37(红集 10)→ 交付 403 项双跑全绿,commit f7eb239。生产五 key 非破坏性复核:.corrupt- 产物 0、原件 md5 五条 OK。残项:`loadList` 未导出零调用方却名叫 List 而拒绝顶层数组,随 #31 删除为正解
- [x] 2026-10-23 #43 写被拒不得报成功 + 删除"先落盘后回收":`saveJSONSync`/`saveState` 回传布尔;/api/toggle 未落盘 → 503 `{error,persisted:false,runtimeOnly:true,…}` 且**不再有 `success:true`**(实测现状是 200 success:true 而 `switches.json` 根本不存在);`remove()` 改为资格校验→落盘→落盘成功才 `rmSync`,`rmSync` 失败回滚登记、回滚再失败 `appendLog(error)` 明示"注册表与磁盘不一致";`filesDeleted` 仅在目录真删时为 true;`create/archive/restore` 同批收紧,统一经 `trySaveState()` 区分**拒写(该 key 已隔离)**与**写入故障(抛异常)**两态,`causeOf()` 有界 200 且截断时补回错误码前缀(EISDIR/EPERM/ENOSPC 不得被截掉)。红基线 87114ba(e2e 198/199、workspace 36/40)→ 我审计判出"原因被吞"归因回归,追加 `#43c1/#43b6`(commit a727387,40/42)并出返工单 R1 → 我再按 P4 自亲笔补 `#43d1/#43d2`(归档/恢复同尺)→ 交付 415 项双跑全绿(commit 本次)。核准遗留:#72(`beginRun` 第 5 个站点仍丢弃返回值)、#73(隔离期已知 id 的写/删回 404 而非 5xx)、#74(`causeOf` 与 #54 的取尾部重复 + `REFUSED_CAUSE` 文案窄于事实)
- [x] 2026-10-23 #31 死代码与双账本收口:`store.js` 的 JSONL 流量账(`appendTraffic/readTraffic/clearTraffic` + 队列/轮转 + `FILES.traffic`)全仓零调用方,生产 `traffic.jsonl` 实测停在 07-26 19:14、1274 字节 / 4 行;活账本是 SQLite(`/api/db/stats` 实测 `dispatches.n=102`,`/api/traffic` 走 `db.queryTraffic`)。危害不是"几行没人跑的代码"而是 **store 与 db 导出同名 `clearTraffic`**:`server.js:1880` 调的是 `db.clearTraffic()`,清的是活账本,死文件原地留存,按名字找会清错对象。同批删 `async save`(唯一使用者,删后 `const _locks` 成孤儿——K5 锁这条)与 `loadList`(#44 后已成"名叫 List 却拒绝顶层数组"的名实不符者);`saveSync`/`_syncLocks`/`_corrupt`/logs/memory/meetings/ACL 逻辑零改动。红基线 9609988(audit 51/55,红集 K1/K2/K2b/K3)→ 我补 K5(c9b66f9,55/56,规格漏项在我:验收写死 19 warning 诱导编码手保留孤儿)→ 交付 **422 项双跑全绿**,`store.js` 572→474 行,eslint 0 error/19 warning。**数据文件未删**:代码删了不等于用户数据可删,`traffic.jsonl` 的处置属 #29/#71。双向锁 K3b/K4 专防"清理时把活的半条腿一起删"。
- [x] 2026-10-23 #45 用量报表不再恒 0:`db.js` 单点 `usageTokensSql()` 用 COALESCE 链认全三种 usage 形状(input|prompt_tokens|input_tokens + output|completion_tokens|output_tokens),byDay/byTool/todayTokens 三处共用;**链式取首个非空而非相加**,混合键名行实测 260 而非 520。写侧 `server.js:296/:2081` 不再落上游原样 usage,改存 `{input,output,total}`,无 usage 写 null;对外响应体一个字节未改(落库在 `res.end(respData)` 之后)。病灶实测:500 条 traffic 里 usage 非空 52 条全是归一化形状 → 报表每行 tokens=0、`/api/health` 的 todayTokens=0 → 预算告警永不触发,而同库 dispatches.tokens=638931。红基线 34d7f8d(audit 59/63,红集 L1/L2/L3/L5)→ 交付 429 项双跑全绿,commit eba52a7。L0 保险栓(runner 必须回显所打开的库路径,防写生产库)、L3b(null 行计 calls 不猜 tokens)、L4(events 按列聚合)三条现状即绿未虚报。我的两条错:上一轮把 K4 写坏成 K3b 副本(锁数量对、内容少一把,现已恢复并改为"改锁后逐个点名断言");L5 用 grep 型探针,漏抓 `server.js:2209/2215` 的 Ollama 形状①写手 → 登记 #77(锁应升级为"落库行键集合"行为锁)。#76:19→18 的真相就是那次破坏留下的 unused 变量。
- [x] 2026-10-23 #46 tools.json 损坏只降级不拦启动:`loadTools()` 的 JSON.parse 原在 try 外且于模块加载期执行(server.js:16 一 require 就抛),watchdog 重启到熔断。现分四态 ok/missing/corrupt-parse/corrupt-shape(missing 属合法部署态不写 error 级),损坏后果一致:静态工具按空处理、绝不抛、继续加载 kimi 自动同步、**原件原样不动**(不得把 P0 的 .corrupt-* 隔离用在配置原件上,#46a5 锁死);新增 getLoadDiagnostics(){status,error(有界 200 且保留开头错误码),file(仅 basename),entryCount};留痕由 server.js 写 logs.jsonl+stderr(#46a4 —— tool-registry 不得新增 store 依赖,否则每个 MCP 桥进程加载期 mkdir 数据目录)。实测:截断=SyntaxError、顶层 null/42=TypeError: configs is not iterable、顶层字符串=静默 0 工具零留痕。红基线 33a05bc(store 38/43)→ 交付 435 项双跑全绿,commit 6ba0ff1;端到端独立复核(整目录副本+截断件+9849):进程活着、logs.jsonl 那条含四要素的 error、/api/tools 降级为空数组、原件 39→39 字节未动、0 个 .corrupt-*;对照组零留痕且 12 工具。我的流程漏项:取基线那格没跑 eslint,把 no-inner-declarations 的 error 提交进了红基线(编码手申报 SPEC GAP 才暴露),修于 2de1196 —— 基线格也必须过 lint 门。另:boundedReason 是"有界原因摘要"的第三处实现,并入 #74。
- [x] 2026-10-23 #47 幂等缓存流式命中不再吐畸形 SSE:缓存只由非流式 200 写入而 `cacheKey` 不含 stream,流式请求命中同一 key 时旧实现把 **JSON 原文** `res.write(cached.value)` 写进 `text/event-stream` 响应(SSE 解析器丢弃所有非 `data:` 行 → 客户端拿到空流,却被告知 `X-Cache: HIT`「成功」),而本文件与 `server.js` 注释都写着「合成单块 SSE」= 文档与实现背离。现新增零依赖纯函数 `sse-replay.js`:`isReplayableJson`(解析成功 + choices 非空数组 + choices[0].message 为对象 + tool_calls 缺失或空 + content 为 string|null,否则 false 且不抛)与 `sseFromChatJson`(帧1 `delta{role,content 逐字}`/finish_reason:null;帧2 `delta{}`/finish_reason + **usage 原键名原内容透传**;末帧 `data: [DONE]`;id/created/model 全保留,不注入估算值)。命中分支三分支:非流式→原字节回放(逐字未动,#47a6 反向锁)/流式且可回放→合成回放/流式但不可回放→`_respCache.delete(ck)` 回落正常转发(不吐坏流、不 502、不因缓存坏报错)。明确决定**不按 stream 拆 cacheKey**(值形状不变、由回放器适配,两类客户端互相受益),已写进注释防后人误判为遗漏。红基线 a2194ee(unit 42/48,红集 a0~a5)→ 交付 unit 48/48、六套合计 **442 项双跑同数全绿**,eslint 0 error/18 warning(= lint_baseline),commit ff32318。**两条记账**:① 我在基线里写的 `#47a1`(末帧必须恰为 `[DONE]`)与 `#47a3`(又去 `JSON.parse` 末帧取 finish_reason)**互斥**,任何正确实现都过不了 ——编码手报 SPEC GAP 而非 monkey-patch 凑数,我复算成立后亲笔改锁(commit db40cad)。这是流水线第二次「锁数量对、内容错」(第一次是我把 K4 写成 K3b 副本),根因相同:我写完断言只验「能不能跑」,没验「能不能被满足」——新锁今后必须附「某正确实现下该断言为绿」的推理或反证。② 本轮只做到**单元级 + 源码结构锁级**,**没有端到端证明**「流式命中→客户端真能解析」:缓存唯一写入口需真凭据的 codely-http 上游、基址硬编码在不入库的 `codely-client.js`,测试不该联网也不该烧免费额度 → 接缝缺口登记 #79(含 tool_calls 与 `/v1/messages` 两类未覆盖形状)。
- [x] 2026-10-23 #80 注册表配置路径接缝 `AI_BRIDGE_TOOLS_PATH`:`tool-registry.js:98` 的 `configPath` 改 env 三元(未设时逐字节等于原值,不用 `path.resolve(...)` 免随 cwd 漂移;缺失/损坏照常落既有 `missing`/`corrupt-*` 分支,`file` 报 basename),`/api/tools` 响应加 `registry: getLoadDiagnostics()`(单一写手,不在 server 内另拼字段)。目的是给 #40/#79 提供**零网络真链路**验收面:测试可把 `node -e` 假 CLI 经隔离 tools.json 塞进真派发。红基线 25d4a5a(e2e 200/203,红集 a2/a3/a4,a1 为生产中性哨兵)→ 交付 446 项双跑同数、eslint 0/18,commit c6ffcff。**两条记账**:① 编码手报 SPEC GAP 且结论成立——探针装了却 `available=false`,被 `server.js:787` 可用位过滤挡在派发外;我独立复现(`where <绝对路径>` 退出码 2 + detect=false/execute="ok")后判定这是**我基线漏写设计内 `commandPaths` 通道**的自身缺陷(改锁 commit adb3ffb),不对称本身立项 #81。② #80a4 的绿只可能来自 F1(装载)而非放宽断言:该断言要求结果内容含 `PROBE|len=`,只能由真子进程打印。
- [x] 2026-10-23 测试面现状:六套件合计 **446 项**(unit 48 / workspace 44 / store-corrupt 43 / audit-fixes 63 / external-fixes 45 / e2e 203),两轮同数才允许合并;`TEST-LOCK.json` 已拆分 `locked_tests`(行为冻结,编码手禁改) / `source_faces`(对照基线,指挥官每轮重算) / `source_faces_owner`(归属轮次,防并发覆盖只能靠哈希漂移反推)。注意 eslint warning 基线会随源码同源漂移(本轮 19→20→19),不得靠记忆判定回退——见 #76。
- [ ] 未修清单(2026-10-23 快照,按队列序):#40 恒假分支致 CLI 拿不到工作区简报;#51 工作区 path 无效时静默改建空目录;#26 吞异常门禁;#49 两个 HTTP 封装单点化 + slow-drip 兜底(含负数 env 钳制与注销预算具名化);#27/#28/#29 表驱动化/出口归一/仓库卫生;#56 别名点名的在册客户端被报"未知工具";**#57 同宿主多会话塌成 `unknown` 且塌缩静默不可观测**;**#58 MCP 面缺 `async` 派发与结果取回**;**#60 判定器短文本数字子串(401/402/429)仍会误伤**;#61 文档保真锁(env 表/套件计数/端点行号与源码同源——本轮 README 的 45/184/374 三处漂移就是该病的现行样本);#62 `recordTask` 字段白名单丢 total/requested/skipped;#63 测试残留清理不实且 `.bak-cleanup-*` 未被忽略;#64 `/proxy/*` 免凭据透传 + `checkAuth` 非恒定时间;#65 运维脚本硬连 9800 不带凭据;#66 凭据取证 harness 常驻化;#67 UI 流式解析三缺陷;#69 edge-agent 漏配凭据静默降级;#70 `?probe=1` 零调用方,裁定存废;#55 北极星端到端子智能体加载验收;#72 beginRun 丢弃 saveState 返回值(租约/useCount 写失败时静默漂移);#73 key 隔离期间对已知 id 的写/删返回 404 而非 5xx;#74 causeOf 与 #54 取尾部重复实现且 REFUSED_CAUSE 文案窄于事实;#76 eslint warning 基线应随源码快照成锁(本轮 19→20→19 靠人肉追数);#77 形状①第三写手(server.js:2209/2215 Ollama 路径)未被 L5 的 grep 探针抓到,且 token-stats.json 估算把整段历史重复计入(实测 total.input 达 37.7 亿);#79 幂等缓存流式命中无端到端验证(**接缝面已随 #80 部分打开**:注册表路径可注入,假 CLI 能进真派发链路;缺的是假**上游**接缝,含 tool_calls 与 /v1/messages 两类未覆盖形状);#81 CLI 绝对路径可用位不对称(detect() 判不可用而 execute() 能跑,拒绝文案还报"未知工具")。

