# AI Bridge — AI 工具调度中枢

本机常驻 HTTP 服务，统一调度多个 AI 编程工具。

## 快速开始

```bash
cd ai-bridge
npm install        # 安装 ws 依赖
node server.js     # 启动服务 (端口 9800)
```

浏览器打开 `http://127.0.0.1:9800` 即可访问 Web UI。

## 外部用户接入（OpenAI 兼容层）

本中枢同时以 OpenAI 兼容接口对外提供服务（zcode、one-api、任意 OpenAI SDK 均可直连）。**硬依赖：服务端需 Node.js 22+**（使用内置 `node:sqlite` 数据库，低版本无法启动）。

- **列出全量清单**：`GET /v1/models` 返回「模型清单 ∪ 全部已启用可派发工具」——既含 `models.json` 的模型条目，也含 `tools.json` 里每个可派发工具的 `name`（含在线接入的 MCP 客户端），外部客户端据此一眼看到所有可用算力。被开关禁用的工具不会出现；与模型同名（小写不敏感）时模型条目优先，不重复。
- **工具名直连**：`POST /v1/chat/completions` 的 `model` 既可用模型名，也可直接用**工具名**（如 `opencode-flash`、`claude-code`）触发该单工具的纯 1:1 透传执行（无接力、无评审、无工作区绑定）。命中 `models.json` 走原有反代 transport；两者皆不命中才返回 404 并提示查阅 `GET /v1/models`。
- **工具名直连暂不支持 stream**：工具分支忽略 `stream` 参数，始终一次性返回完整 JSON（模型反代分支不受此限，仍可流式）。
- **opencode CLI 安装 + 平台免费模型**：先安装 opencode CLI（如 `npm i -g opencode-ai`，或按官方安装脚本），接入后即可享用平台自带的 opencode-go 免费模型池（如 `deepseek-v4.1-flash`、`step-5-preview-free` 等 free/免费 模型），由 `opencode` / `opencode-flash` 工具直接派发，无需自备 API Key。
- **模型透传（运行时指定任意模型）**：`POST /api/dispatch` 请求体可加 `"model":"opencode-go/minimax-m3.1-flash-free"`，或在 `/v1/chat/completions` 请求体加 `"model_override":"<模型名>"`（后者等价于 dispatch 的 `model`），派发时临时覆盖工具默认的 `-m` 模型，无需改 `tools.json`；仅对声明了 `modelFlag` 的工具（opencode 系四个）生效，含空格/shell 元字符的模型名会被直接拒绝。货架上有哪些模型可自行枚举：`GET /api/discover-models?tool=opencode`。示例：`curl -s -X POST http://127.0.0.1:9800/api/dispatch -H "Content-Type: application/json" -d '{"task":"写一个 add 函数","tools":["opencode-flash"],"model":"opencode-go/minimax-m3.1-flash-free"}'`；查看模型清单：`curl -s "http://127.0.0.1:9800/api/discover-models?tool=opencode"`。
- **用量自报（T5 预告）**：工具输出可尾随 `[USAGE] input=… output=…` 自报行，中枢自动剥离计入 usage，供接入方智能体主动上报真实 token 消耗。

curl 示例（服务默认端口 9800）：

```bash
# 1) 列出全部可用模型与工具（含工具名，可直接当 model 用）
curl -s http://127.0.0.1:9800/v1/models

# 2) 用工具名当模型直连单工具执行（工具分支不支持 stream，始终返回完整 JSON）
curl -s http://127.0.0.1:9800/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"opencode-flash","messages":[{"role":"user","content":"写一个 Python 的 add 函数"}]}'
```

## 前置条件

- Node.js 22+（使用内置 `node:sqlite`）
- 已安装至少一个 AI 编程工具的 CLI（如 OpenClaw、AtomCode）

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AI_BRIDGE_PORT` | 9800 | 服务端口 |
| `AI_BRIDGE_HOST` | 127.0.0.1 | 监听地址（**仅本机**；改 0.0.0.0 前务必设 TOKEN） |
| `AI_BRIDGE_TOKEN` | 无 | 鉴权 token（不设则无鉴权）。**自 #42 起门覆盖 `/api/*` 与 `/v1/*`**（`server.js:1341`）：设了 token 后，用 OpenAI 兼容层的任何客户端都必须把 API key 配成同一个值（`Authorization: Bearer <AI_BRIDGE_TOKEN>`），否则一律 401；比较改用 `crypto.timingSafeEqual`（先比长度再比字节，#64）；Web UI 会在首次 401 时提示输入一次并存入 localStorage（不设 token 时不会弹框）。**`GET /api/health` 自 #68 起按鉴权态给两种视图**：它在门之前处理（`server.js:1276`），无凭据只返回 `status/uptime/port/clients/activeDispatches/dispatchTotal/version` 七个存活与负载计数；`codely`（CLI 版本 / access_token 剩余天数）与 `usage`（今日 token / 预算）仅在带凭据时出现；`?probe=1` 无凭据一律 401 **且绝不发起任何上游请求**（`#68b2` 源码顺序锁死"判权必须先于探测"，防止"先探测后判权"这种照样返回 401 但上游已被打过的回潮）。不设 token 时 `checkAuth` 恒真 → 自用实例仍拿完整视图（零负担）。**#64 起两条免鉴权路由必须核实物理对端**（判定收敛在 `isLoopbackPeer` 单点，只认 TCP 层对端、不认 `X-Forwarded-For` 这类可篡改头）：`GET /`（Web UI 首页）仅回环可取，非回环 403 且不回出页面；`/proxy/*` 透传仅"回环对端 或 中枢已配置凭据且校验通过"可用——未配置凭据的中枢对非回环一律拒，杜绝把 `AI_BRIDGE_HOST` 设成 `0.0.0.0` 时局域网把中枢当免费 LLM 中继 |
| `AI_BRIDGE_CLIENT` | unknown | 作为 MCP 客户端时的身份名（**注意**：默认值是常量 `unknown`，同一宿主开多个会话会全部塌进同一个在册条目且复用是静默无日志的，见「已知问题」） |
| `AI_BRIDGE_EXECUTE_TIMEOUT` | 900000 | 中枢单次执行窗口(ms)：CLI 执行链与客户端反向执行都吃它。**桥侧 `AI_BRIDGE_HTTP_TIMEOUT` 必须 ≥ 本值 + 30000**，否则长任务会被桥早判死而中枢仍在执行（`test-audit-fixes` 段 F 锁死该数值关系） |
| `AI_BRIDGE_HTTP_TIMEOUT` | 960000 | 桥侧同步调用预算(ms)。**自 #49 起它同时是 inactivity 空闲超时与墙钟绝对 deadline**（二者同值,刻意不引入更小的魔数上限,否则服务端 30s 长轮询 `/api/poll` 会被掐短）;超时归因文案带**实际生效的预算数值**,并区分"全程无响应"与"慢速续命(已回 N 字节)"。**未设时 GET/轮询仍为 30000ms 快速失败**（自愈节奏,有意与 POST 不同尺） |
| `AI_BRIDGE_SAMPLING_TIMEOUT` | 900000 | 桥侧反向 `sampling/createMessage` 的防泄漏兜底；实际节奏由中枢 `AI_BRIDGE_EXECUTE_TIMEOUT` 管控，慢宿主可放宽 |
| `AI_BRIDGE_CAP_EXEC` | 否 | 严格 opt-in（`1/true/yes/on`）声明 exec 能力；不带 exec 的客户端可被派发但不能承接 workspace 任务 |
| `AI_BRIDGE_DATA_DIR` | `ai-bridge/` 内默认位置 | store 层 JSON 数据目录。**跑任何探针/沙箱实例必须显式隔离它**，否则写穿生产台账 |
| `AI_BRIDGE_TOOLS_PATH` | 仓库内 `tools.json` | 工具注册表配置文件路径（`tool-registry.js`）。**未设时逐字节等于默认**；仅供沙箱/测试把本地假 CLI 塞进真派发链路而不触碰生产 `tools.json`（#80）。实际载入的是哪个文件由 `/api/tools` 的 `registry.file` 如实回报 |
| `AI_BRIDGE_DB` | `~/.ai-bridge/bridge.db` | 全局 SQLite 路径。沙箱实例须**同时**隔离它（只隔离 DATA_DIR 不够，流量/派发行会写穿生产库） |
| `AI_BRIDGE_CACHE_TTL` | 600000 | 反代幂等缓存 TTL(ms) |
| `AI_BRIDGE_CACHE_MAX` | 100 | 反代幂等缓存条目上限(LRU) |
| `AI_BRIDGE_DAILY_TOKEN_BUDGET` | 无 | 每日 token 预算，超出时 /api/health 告警 |
| `AI_BRIDGE_OLLAMA_BASE` | http://127.0.0.1:11434 | local-vl 模型的 Ollama 地址 |
| `AI_BRIDGE_WORKSPACE_ROOT` | `~/.ai-bridge/workspaces` | 受管工作区根目录（托管目录创建/回收均限制在此） |
| `AI_BRIDGE_TOOLSET` | full | 桥暴露的工具套餐：full=全部 15 个；lite=面向被派发 CLI 对端智能体的 5 工具精简面（dispatch/handoff/list_tools/memory_search/memory_recent）；非法值按 full |

| `AI_BRIDGE_MAX_CONCURRENT_DISPATCH` | 5 | 并发讨论/派发闸门额度（`server.js:66`，走 `parsePositiveInt`：非正数与坏值落默认） |
| `AI_BRIDGE_RESULT_MAX_CHARS` | 2000 | dispatch 结果 `content` 截断上限（`server.js:67`，`parsePositiveInt`） |
| `AI_BRIDGE_CLIENT_TTL` | 300000 | 在册客户端 stale 判定窗口(ms)（`server.js:70`，`parsePositiveInt`；测试里常用 `'1200'` 加速过期） |
| `AI_BRIDGE_MEETING_MAX_TOKENS` | 100000 | 单场会议 token 上限，超出 `/api/discuss` 返 429（`server.js:71`） |
| `AI_BRIDGE_MEETING_MAX_MS` | 600000 | 单场会议时长上限(ms)（`server.js:72`） |
| `AI_BRIDGE_CORS` | 不设=不发 CORS 头 | `Access-Control-Allow-Origin` 的值（`server.js:74`）。**设 `*` 等于把本机反代开放给任意网页**，慎设 |
| `AI_BRIDGE_PROXY_TIMEOUT` | 600000 | OpenAI 反代到上游的超时(ms)（`server.js:1162`） |
| `AI_BRIDGE_BASE_URL` | `http://127.0.0.1:9800/v1` | `qidi-sync.js` 同步器指向的中枢基址（`qidi-sync.js:28`）。多实例并存时**必须**显式指定，否则同步进别的实例 |
| `AI_BRIDGE_OBSERVE_DIR` | `~/.ai-bridge` | 观测件（快照/审计产物）根目录（`observe.js:22`）。沙箱实例须与 `AI_BRIDGE_DATA_DIR`、`AI_BRIDGE_DB` 一起隔离 |
| `AI_BRIDGE_VISION_PORT` | 11434 | 桥侧 `recognize_image` 的 Ollama 端口（`bridge-stdio.js:753`） |
| `AI_BRIDGE_VISION_HOST` | 127.0.0.1 | 同上，Ollama 主机（`bridge-stdio.js:754`） |
| `AI_BRIDGE_VISION_MODEL` | `qwen2.5vl:3b` | 同上，视觉模型名（`bridge-stdio.js:851`） |
| `AI_BRIDGE_SAMPLING_MAX_TOKENS` | 16384 | 反向 `sampling/createMessage` 请求宿主模型时的 maxTokens（`bridge-stdio.js:1091`） |
| `AI_BRIDGE_CLI_MAX_OUTPUT_CHARS` | 10485760（10MB） | CLI 子进程 stdout+stderr **合计**输出上限（字符数,非精确字节）：超限即 `child.kill()` 并 reject「输出超过 N 字符上限,已终止」。取值走 `parsePositiveInt`（`adapters/cli-adapter.js:43`，#96 起并入单点、#102 起求值挪到模块顶层=启动即点名且每进程最多一次）;未设/非数字/≤0 一律回落默认 10MB。**值必须是纯十进制整数**：`1e7`/`10MB`/`0x10`/`12.9` 自 #96 起判非法⇒回落默认并在 stderr 点名，不再被 `parseInt` 前缀宽容成 1/10/16/12 |
| `AI_BRIDGE_CLOUD_URL` | 无（必填） | `edge-agent` 要连接的云端中枢基址：读取时对未设值取空串并剥去末尾斜杠（`String(env.AI_BRIDGE_CLOUD_URL ...)` 于 `edge-agent.js:30`）。**未设或为空即抛 `缺少 AI_BRIDGE_CLOUD_URL`**（`edge-agent.js:32`）；非 `https://` 前缀且未另设 `EDGE_ALLOW_INSECURE_HTTP` 为真时同样抛（`edge-agent.js:33`） |
| `AI_BRIDGE_LOCAL_URL` | `http://127.0.0.1:9800` | `edge-agent` 回连本机 ai-bridge 的地址：未设时取默认 `http://127.0.0.1:9800`,并对值剥去末尾斜杠（`edge-agent.js:42`） |

> **env 解析口径（#49a 已归一）**：曾实测全仓有 **12 处** `parseInt(process.env.AI_BRIDGE_*, 10) || 默认`（`bridge-stdio.js` 6 + `server.js` 6）;这种写法 0 与非数字落默认、**负数却原样直通**（实测 `http.request({timeout:-1})` 同步抛 `ERR_OUT_OF_RANGE`,一个手滑的负数就能让桥失联且零归因）。现在 12 处全部走**仓内已有**的 `parsePositiveInt`（单一实现,`env-int.js`）,非法值回落默认**并在 stderr 留痕**（含变量名与原因）;`AI_BRIDGE_DAILY_TOKEN_BUDGET` 的 `0` 语义（=不设预算）由配套的 `parseNonNegativeInt` 保住。GET 的 30000 短兜底**有意保留**,不随 POST 抬高。
## 功能

- **dispatch** — 并行派发任务给多个 AI 工具，自动故障转移
- **discuss** — 多 AI 讨论会（两轮 + 共识引擎 + 共识度评分 + 自动止损）
- **review** — 交叉评审（A 产出 → B 评审）
- **routing** — 7维贝叶斯路由评分自动选最佳工具（真实历史自学习）
- **handoff** — 接力续写（A 干不完 → B 接着干）
- **workspace** — 工作区管理（dispatch/handoff 以指定目录为 CLI 执行 cwd；支持登记目录与受管目录、归档/回收、独占租约）
- **traffic** — 完整流量监控（所有 AI 和云端的通信记录）
- **OpenAI 反代** — `/v1/chat/completions` 统一暴露免费模型（含幂等缓存）
- **Anthropic 反代** — `/v1/messages` Claude Code 类工具直接接入
- **MCP 桥接** — 任何支持 MCP 的 AI 工具可接入

## OpenAI 反代模型

所有模型统一入口：`http://127.0.0.1:9800/v1`，API Key 随便填（本地代理不校验）。

| 模型 | 来源 | transport |
|------|------|-----------|
| agnes-2.0-flash / agnes-2.5-flash / auto | AgnesCode | agnes-http |
| glm-5.2 / deepseek-v4-flash / qwen3-vl-8b-instruct | AtomCode | cli |
| qwen2.5-vl-local | 本地 Ollama | local-vl |

- **模型清单自动同步**：`POST /api/models/sync` 带签名拉上游 /v1/models，新模型自动注册进 models.json
- **幂等缓存**：非流式 200 响应按 sha256(model+messages+参数) 缓存，命中直接原字节回放（`X-Cache: HIT`）。**流式请求命中同一缓存时不再回放 JSON 原文**（#47）——那会被 SSE 解析器整段丢弃、客户端看到空流；现由 `sse-replay.js` 合成合法 SSE（两数据帧 `data: {...}

` + 末帧 `data: [DONE]`，`id/created/model` 原样保留、`usage` 原键名透传）。缓存体不可回放（非法 JSON / 无 choices / 含 tool_calls 等）时**逐出该条并回落正常转发**，绝不吐坏流也不报错。`cacheKey` 有意**不**按 stream 拆分：缓存值形状不变、由回放器适配，两种客户端互相受益。
- **上游健康探测**：`GET /api/health?probe=1` 带签名实测 LiteLLM 连通性（**自 #68 起须带凭据**：无凭据一律 401，且未鉴权时绝不发起上游请求——该分支每次调用都会驱使中枢带真实签名打上游，属"能花钱"面）
- **用量报表**：`GET /api/usage/report?days=7` 按天/按模型聚合，Web UI「用量」Tab 可视化

### Claude Code / Anthropic 兼容客户端接入

```
ANTHROPIC_BASE_URL: http://127.0.0.1:9800
API Key:  随便填
模型名:   codely-core / GLM-5.3 等（仅 codely-http 模型；上游需 ?beta=1 已自动附加）
```

### zcode / 任何 OpenAI 兼容客户端接入

```
Base URL: http://127.0.0.1:9800/v1
API Key:  随便填（如 sk-1234）
模型名:   codely-core / GLM-5.3 / codely-flash / codely-vl 等（见上表）
```


## 配置文件

| 文件 | 说明 | 首次运行 |
|------|------|---------|
| `tools.json` | 工具配置（CLI/HTTP/routing-marker） | 已包含 |
| `models.json` | OpenAI 反代模型注册表 | 已包含 |
| `switches.json` | 工具开关 | 自动生成 |
| `clients-acl.json` | 客户端准入控制 | 自动生成 |
| `token-stats.json` | Token 统计 | 自动生成 |
| `memory.json` | 任务历史 + 经验 + 会议 | 自动生成 |
| `workspaces.json` | 工作区注册表 | 自动生成 |

## 测试

```bash
node test-unit.mjs          # 65 项  纯单元测试（含 #47 SSE 回放合成器、#96 env 整串解析与留痕）
node test-workspace.mjs   # 91 项  工作区与租约（含 #43 写失败守卫、#51 空白 path、#81 可用位与执行同尺、#73 隔离期 503 降级、#74 隔离原因真因、#75 回滚失败与日志同真）
node test-store-corrupt.mjs # 65 项  坏 JSON 与坏形状隔离/拒绝覆写 + 配置损坏只降级（子进程 + 隔离 DATA_DIR；含 #97 归因类别与单一把尺）
node test-audit-fixes.mjs   # 111 项  审计修复验收（含结构锁 E/F/G/H/I/J/K/L/M 段；M 段会实际调起棘轮门禁）
node test-external-fixes.mjs# 45 项  外部模型审计修复（端口 9811）
node test-e2e.mjs           # 238 项 全链路 E2E（主中枢 9810 + 假中枢 9813 + 黑洞 9814/9815 + 死端口 9899（故意无人监听，验连接失败路径） + 第二实例 9821/9827/9830 + 第四实例 9841 + 注册表接缝与假 CLI 实例 9833/9834/9835，均不影响生产）
npx eslint . --ext .js,.mjs # 0 error / 18 warning（warning 为既有基线；**必须在 ai-bridge/ 目录内跑**，仓根跑会命中指挥官未提交的 WIP 而报出上千条无关错误）
node check-swallow-ratchet.mjs # 0=棘轮通过并打印 STATUS=ok / TOTAL=<实测>；非 0 时点名 GROWTH / SCOPE-DRIFT / TOTAL-SUM-CONFLICT。**只认 `--root/--baseline/--count/--update/--help`，位置参数直接报"未知参数"（默认根 = 脚本所在目录 = ai-bridge）**
```

合计 **615 项**（分项机械相加 65+91+65+111+45+238，不手算）；`npm test` 只串了前四项，全量口径以六套件为准。合并纪律：**同一棵树连跑两轮同数全绿**才算过（编码手贴的输出不作数，指挥官亲跑才作数）。E2E 会自举隔离数据目录（`AI_BRIDGE_DATA_DIR`/`AI_BRIDGE_DB`/`AI_BRIDGE_WORKSPACE_ROOT` 全部指向套件自建的临时运行目录），不会写生产数据；测后自动清理并打印"生产数据未改写"（已知残留见 #63：Windows 下 SQLite 句柄未关，`test-runtime-data/` 可能留 `*.db-journal`）。


### 派发长任务前必读（超时口径）

- MCP 的 `dispatch` 工具是**同步** HTTP 往返：中枢窗口默认 15 分钟（`AI_BRIDGE_EXECUTE_TIMEOUT`），桥预算默认 16 分钟（`AI_BRIDGE_HTTP_TIMEOUT`）。**超过窗口的任务现在没有可用的规避路径**——中枢本身支持 `async: true` 异步队列（`/api/dispatch`），但 15 个 MCP 工具既没有 `async` 入参、也没有取回异步结果的工具（见「已知问题」#58）。
- 中枢侧**不会**因为宿主放弃而停止执行：客户端断开/超时后，任务照常跑完并烧配额，只是结果回不到调用方。这也是台账里曾出现 `Command exited with code null` 的同一族问题。
- 桥侧对超时已改为如实归因：`命令被信号 SIGTERM 终止(超时预算 Nms 用尽…): <输出尾部>`，不再输出 `code null` + 启动横幅。要看真因请查 `/api/traffic` 的 `error` 字段（持久化在 SQLite 流量表，含正文）。

## 工作区管理

dispatch / handoff 可绑定工作区；绑定时 CLI 工具以该目录为 `cwd` 执行（未绑定时仍用一次性输出目录）。两种模式：

| 模式 | 创建方式 | 文件归属 | 删除行为 |
|------|---------|---------|---------|
| `linked` | `POST /api/workspaces` 带已存在的绝对 `path` | 用户目录，仅登记 | 只解除登记，**永不删文件** |
| `managed` | 只带 `name`（省略则自动生成），在 `AI_BRIDGE_WORKSPACE_ROOT` 下创建 | 受管目录 | 可 `delete_files=1` 回收 |

```bash
# 创建受管工作区
curl -X POST http://127.0.0.1:9800/api/workspaces -H "Content-Type: application/json" \
  -d '{"name":"demo","exclusive":true}'

# 登记已有目录
curl -X POST http://127.0.0.1:9800/api/workspaces -H "Content-Type: application/json" \
  -d '{"name":"my-repo","path":"D:/code/my-repo"}'

# 绑定工作区执行任务（id / name / path 均可）
curl -X POST http://127.0.0.1:9800/api/dispatch -H "Content-Type: application/json" \
  -d '{"task":"修复 bug","workspace":"demo"}'
```

- `GET /api/workspaces` 列出全部（含 `activeRuns`）；`GET/DELETE /api/workspaces/<id>` 查看/删除（`?delete_files=1` 回收受管目录）
- `POST /api/workspaces/<id>/archive|restore` 归档/恢复；归档工作区不能被 dispatch 绑定
- `exclusive: true` 的工作区同一时刻只允许一个任务运行，冲突返回 409
- 运行中的工作区禁止归档/删除；路径必须是绝对路径，且拒绝文件系统根目录

## 新增工具

编辑 `tools.json`，加一段配置：

```json
{
  "name": "my-tool",
  "displayName": "My Tool",
  "transport": "cli",
  "command": "mytool",
  "args": ["--prompt", "{{task}}"],
  "inputMode": "arg",
  "outputMode": "stdout-text",
  "timeout": 120000
}
```

重启服务即可，不改代码。

## MCP 客户端接入

在 AI 工具的 MCP 配置中注册 `bridge-stdio.js`：

```json
{
  "mcpServers": {
    "ai-bridge": {
      "command": "node",
      "args": ["/path/to/ai-bridge/bridge-stdio.js"],
      "env": {
        "AI_BRIDGE_CLIENT": "my-ai-tool",
        "AI_BRIDGE_PORT": "9800"
      }
    }
  }
}
```

### 全量工具清单（15 个）

默认套餐（`AI_BRIDGE_TOOLSET=full`）下 `tools/list` 暴露以下 15 个工具，「用途」逐字摘自 `bridge-stdio.js` 的 description：

| 工具 | 用途 |
|------|------|
| `dispatch` | 把任务分发给已开启的工具(可多个并行)。工具限额/断开时自动转给其他工具接力。返回代码产出和 token 用量。 |
| `list_tools` | 列出所有工具:检测状态 + 开关状态 + 累计 token |
| `toggle_tool` | 打开/关闭工具开关 |
| `list_switches` | 查看所有工具开关状态 |
| `list_workspaces` | 列出工作区:登记/受管模式、路径、状态、使用次数、当前活动任务数 |
| `create_workspace` | 创建或登记工作区。不传 path 时在受管根目录创建空目录;传 path 时登记已有绝对路径(不会移动/删除用户文件)。 |
| `token_stats` | 查看累计 token 用量统计 |
| `handoff` | 接力:把已有代码传给另一个工具接着干 |
| `memory_search` | 搜索历史任务记录和经验记忆 |
| `memory_recent` | 查看最近的 dispatch 任务记录 |
| `logs` | 查看服务运行日志(调试用) |
| `discuss` | AI 讨论会统一管理入口,按 action 分发四种动作:start 召开讨论会(指定话题和参与者,各工具先独立发表观点再互相补充,返回会议ID);status 查看讨论会状态和实时发言;interrupt 中断正在进行的讨论会(防止无休止循环或方向偏移);inject 向正在进行的讨论会注入主持人消息(纠正方向/补充信息/指出错误)。 |
| `list_clients` | 查看接入共享中枢的客户端:已连接 / 待审批 / 黑名单 |
| `manage_client` | 客户端准入管理:approve 批准待准入或重纳被拒客户端(移入白名单),deny 拒绝并拉黑(若在线则踢出),kick 断开(可选拉黑) |
| `recognize_image` | 识别图片/截图,本地处理不发云端,零token。模式:ocr快速提文字/vision理解内容布局,默认auto |

### discuss — 讨论会单入口

`action` 必填，枚举 `start | status | interrupt | inject`（旧会话未传时按 `start` 兼容处理）：

- **start**：`topic` 必填（讨论话题）；可选 `participants`（留空=全部已开启工具）、`round2`（默认 true）、`implement`（默认 false）、`guidance` / `round2_guidance`。异步启动，立即返回会议ID。
- **status**：`meetingId` 必填，返回会议状态与实时发言（兼容旧字段名 `meeting_id` 回退）。
- **interrupt**：`meetingId` 必填，`reason` 可选（中断原因，防止无休止循环或方向偏移时使用）。
- **inject**：`meetingId` + `message` 必填，向进行中的会议注入主持人消息（纠正方向/补充信息/指出错误）。

会议ID 从 start 的返回文本中获取。

### manage_client — 客户端准入单入口

取代旧的 `approve_client` / `deny_client` / `kick_client` 三个独立工具。`action` + `client_key` 均必填（`client_key` 为 `list_clients` 返回的客户端 ID）：

- **approve**：批准待准入或重纳被拒客户端（移入白名单）。
- **deny**：拒绝并拉黑（若在线则同时踢出）。
- **kick**：断开连接；`block` 仅对 kick 有效，默认 false（true 时同时拉黑）。

### lite 套餐（面向被派发 CLI 的对端智能体）

在被接入方 `.mcp.json` 的 `env` 块中加一行 `"AI_BRIDGE_TOOLSET": "lite"`，桥仅暴露 5 个工具（dispatch/handoff/list_tools/memory_search/memory_recent）：

```json
{
  "mcpServers": {
    "ai-bridge": {
      "command": "node",
      "args": ["/path/to/ai-bridge/bridge-stdio.js"],
      "env": {
        "AI_BRIDGE_CLIENT": "my-ai-tool",
        "AI_BRIDGE_PORT": "9800",
        "AI_BRIDGE_TOOLSET": "lite"
      }
    }
  }
}
```

裁剪收益：tools/list 响应 full 6880B → lite 1901B（**-72%**；测量口径：tools/list 完整 JSON-RPC 响应字节数，不含尾随换行 `\n`，计入换行则为 6881B/1902B）。非法套餐值按 full 处理。

降级行为分两种，勿混淆：

- **lite 套餐**下调用任何不在 5 工具清单内的名字（包括旧工具名 `kick_client` 等），被桥的 toolset 门直接拦截，返回 isError：`工具 X 在 toolset=lite 下不可用(可用: dispatch, handoff, list_tools, memory_search, memory_recent)`。
- **full 套餐**下调用旧工具名（`approve_client`/`deny_client`/`kick_client` 已从清单移除），落入 callTool 的 default 分支，返回 isError：`未知工具: X`。

### 已知问题

- 桥层失败路径已根治：`httpGet`/`httpPost` 感知 HTTP 状态码，非 2xx 一律 reject 并在 Error 上附带 `status`/`body` 结构化上下文；`tools/call` 的任何异常统一降级为 MCP 规范的 `isError` 结果（文案前缀"桥调用失败: "），不再返回 jsonrpc -32603。两处"以非 2xx 承载业务语义"的端点按结构化字段显式处理：`/api/poll` 的 404 `未注册` 触发重新注册（中枢重启后桥可自愈）、`/api/client/register` 的 403 `denied` 走 30 秒慢重试。
- 持久化文件损坏时的保护语义：任一 JSON（`memory.json`/`clients-acl.json`/`switches.json`/`token-stats.json`/`workspaces.json`）解析失败时，中枢把坏文件改名保全为 `<文件>.corrupt-<时间戳>`，并**在本进程内拒绝再写该文件**（防止空结构被当作"新真相"覆写，导致任务历史被洗成 1 条、或黑名单被清空/已关闭工具被静默回启）。期间不影响读取与可用性，只拒绝落盘；`logs.jsonl` 有 `error` 级留痕（含备份文件名）。恢复方式：从 `.corrupt-*` 取回原文件修复后放回，重启进程即恢复写入。
- `TEST-LOCK.json`：仓库测试锁定机制，用于检测测试文件漂移，哈希由指挥官每次合并后重算。现分三类语义：`locked_tests`（行为冻结面，编码手禁改，未申报而变=测试作弊）、`source_faces`（生产源码对照基线，每轮合并后重算，可否改动由当轮规格白名单决定）、`source_faces_owner`（每个面最近被哪一轮改动并验收，用于并发派工时不再靠哈希漂移反推）。
- 2026-10-23 已根治（均有锁定测试与生产验真，细节见 `ARCHITECTURE.md` 的「超时与预算模型」「客户端注册·能力·状态契约」两节）：
  - **注册顺序契约**：桥启动即发的 `sampling=false` 注册若迟到，不再能覆写宿主声明的能力（单调 `registerSeq`，seq 更大者仍允许真撤回）；宿主 `initialize` 早于首注册回执时，桥会补发一次能力刷新——此前接入的编程软件会**永久**失去执行资格且无自愈路径。
  - **超时预算**：桥侧同步预算 600000→960000（≥ 中枢窗口 900000 + 余量）并可 `AI_BRIDGE_HTTP_TIMEOUT` 配置；`callTool` 有总超时，串行多跳不再无界；GET/轮询保持 30s 快速失败（自愈节奏，有意不抬高）。
  - **超时归因**：适配器不再丢弃 `signal`，失败详情取输出**尾部**且有界，台账不再出现 `Command exited with code null: <启动横幅>` 这类误导行。
  - **任务态写入**：在册客户端条目只允许就地 mutate（禁止 `set(key, {...快照})` 整体替换），避免"已清空的 `pendingTask`/已释放的 `_busy` 被复活"。
  - **状态位归位**：超时清理补 `taskPending` 复位，"取走任务却没回结果"不再把客户端永久钉在 `online_busy`。
  - **启动期健壮性**：坏形状（能解析但字段类型非法）的 `memory.json` 不再阻止进程起来；讨论孤儿会议启动清扫，避免并发闸门被崩溃残留堵成永久 429。
  - **点名跳过的诚实呈现**：被禁用而没跑的点名目标现在进分母（响应新增 `requested`，`total` 语义不变），`skipped` 升级为 `{ref, reason}`（"被开关禁用"与"没资格"可区分），桥侧汇总行随之显示 `1/1 成功(点名 2)`；同一件事曾有的三种分母实现收敛为 `total` 优先。
  - **鉴权覆盖面**：门同时覆盖 `/api/*` 与 `/v1/*`（`server.js:1341`），零凭据不再能枚举 `/v1/models`、也不再能走进 `model=<工具名>` 的真实执行支；Web UI 有自己的凭据注入点（`ui.html` 的 `withAuth()`，401 提示一次并至多重试一次），**设了 token 不再把自己的管理界面锁死**。
  - **免鉴权 health 视图（#68）**：`/api/health` 按鉴权态分视图——无凭据只剩存活与负载计数 7 个字段，`codely` token 期限与 `usage` 汇总须带凭据；`?probe=1` 无凭据一律 401 且绝不发起上游（此前零凭据即可驱使中枢带真实签名打 LiteLLM）。
  - **形状非法与解析失败同口径（#44）**：`switches/stats/memory/acl/workspaces` 五类文件里，"能解析但形状非法"（顶层是 null/数组/primitive、`tasks`/`meetings`/`allowlist` 等字段类型错）不再被"补成合法空结构"后覆写——与解析失败同走保全(改名 `.corrupt-*`)+置脏+拒写+不抛错。#52 当年只给了 `meetings` 一个点，本轮是同一把尺子。
  - **写被拒不再谎报成功（#43）**：`/api/toggle` 在开关未能持久化时返回 **503** 并明示 `persisted:false, runtimeOnly:true`，不再回 `200 {success:true}`（实测修复前：`switches.json` 已被隔离改名 `.corrupt-*`、磁盘上根本没有该文件，接口却宣称成功——重启后全部回启）。工作区删除改为**先落盘后回收**：注册表未能落盘就绝不碰目录（修复前实测：真实工作区已被 `rmSync` 删除，注册表却仍指向它，留下必然失败的悬空记录）；目录回收失败则回滚登记，回滚也失败才升级为"注册表与磁盘不一致，需人工核查"的 error 留痕。`create/archive/restore` 与 `remove` 共用同一入口区分**拒写（该 key 已隔离）**与**写入故障（抛异常）**两态，错误消息必须带底层原因（有界 200、截断时补回 `EISDIR/EPERM/ENOSPC` 这类错误码前缀）。
  - **用量报表不再恒 0（#45）**：`traffic.usage` 曾有三种形状各写一遍（上游原样 / 归一化 / 客户端上报），而 `db.js` 的报表与 `todayTokens()` 只 SUM `prompt_tokens`+`completion_tokens`。生产实测：最近 500 条里 usage 非空的 52 条**全是**归一化形状 → `/api/usage/report` 每行 `tokens:0`，带凭据 `/api/health` 的 `usage.todayTokens=0`，`AI_BRIDGE_DAILY_TOKEN_BUDGET` 预算告警因此**永不触发**（同库 `dispatches.tokens=638931`，账在、报表看不见）。现：`db.usageTokensSql()` 单点定义 `COALESCE(input, prompt_tokens, input_tokens, 0) + COALESCE(output, completion_tokens, output_tokens, 0)三处聚合共用；**取第一个非空键而非相加**（混合键名行实测 260 而非 520）。写侧两处入站反代不再把上游原样 usage 落库，改存 `{input,output,total}`，无 usage 写 `null`（不猜）；**对外响应体一个字节都没改**（落库发生在 `res.end(respData)` 之后）。
  - **`tools.json` 损坏不再拖垮进程（#46）**：加载器原先把 `JSON.parse` 放在 try 之外、又在模块加载期执行，配置坏掉 = `server.js` 一 require 就抛 = 进程起不来 = watchdog 重启到熔断。现分 `ok / missing / corrupt-parse / corrupt-shape` 四态：损坏时静态工具按空处理、**绝不抛**、照常加载自动同步工具，并把事实写进 `logs.jsonl`（error 级）与 stderr —— 消息含状态、原因、后果（"静态工具全部缺席"）、以及"原件未被改动需人工修复"四件事；诊断经 `getLoadDiagnostics()` 暴露（`file` 只给 basename）。**与数据文件的差别是刻意的**：`tools.json` 是 git 跟踪的配置原件，服务进程**不改名、不覆写、不隔离**它（P0 那套 `.corrupt-*` 只用于运行数据）。`missing`（文件不存在）是合法部署态，不写 error 级。
  - **幂等缓存的流式命中终于合法（#47）**：缓存只由非流式 200 响应写入，而 `cacheKey` 不含 `stream`，于是流式请求命中同一 key 时旧代码把 **JSON 原文**直接 `res.write()` 进 `text/event-stream` 响应 —— SSE 解析器丢弃所有非 `data:` 前缀的行，客户端拿到**空流**却被告知 `X-Cache: HIT`「成功」；文档与代码注释当时都写着「合成单块 SSE」，实现根本不合（现均已改为与实现一致）。新增零依赖纯函数 `sse-replay.js` 负责合成，命中分支三分支：非流式原样回放 / 流式可回放→合成 / 流式不可回放→逐出并转发上游。**能力边界如实说明**：这条链只做到单元级 + 结构锁级，**没有端到端证明**「流式命中→客户端真能解析」，因为缓存唯一写入口需要真凭据的 codely-http 上游（基址在不入库的 `codely-client.js` 里），测试不该联网也不该烧免费额度 —— 接缝缺口记 **#79**。
  - **注册表配置路径可注入（#80）**：`tools.json` 的载入路径原先硬编码在 `tool-registry.js:98`，测试无法在不碰生产配置的前提下把一个本地假 CLI 送进**真派发链路**——于是「CLI 侧到底收到什么任务文本」（#40）、「流式缓存命中的端到端形状」（#79）只能靠源码结构锁兜住，而结构锁已被 #74 证明会漏抓第二/第三写手。现 `AI_BRIDGE_TOOLS_PATH` 存在时按该文件装载（未设时逐字节不变，且刻意不用 `path.resolve('tools.json')` 防随 cwd 漂移），`/api/tools` 响应带 `registry: getLoadDiagnostics()` 让"到底读了哪个文件"可归因。附带立项 #81：`CliAdapter.detect()` 对绝对路径 `command` 恒判不可用（`where <绝对路径>` 退出码 2），而 `execute()` 走的 `resolveWindowsCommand` 却认它——跑得动却永不被派发。
  - **CLI 终于拿到工作区简报，出站文本收成单一写手（#40）**：`server.js` 里 `outboundTask` 的 else（CLI）分支曾在自己内部再判一次 `toolDef.type === 'client'` —— 在该分支恒为 false，于是 **CLI 工具永远只拿到 `[USAGE]` 自报后缀、拿不到"只在该目录内动文件"这段唯一的文字护栏**（`cwd` 只约束进程起始目录，拦不住越界绝对路径）。现在简报与后缀分型一次组装（`brief = workspace ? 拼简报 : 原文`，client 不加后缀、CLI 加后缀）；同时删掉 `executeClient` 内的**第二次**组装（旧 `:572` 记台账、`:685` 才实发，恰好等值但一改就漂）——台账所记与进程实收/客户端实收自此按构造同源，由 `#40e4`/`#40e8` 两条**逐字节相等**哨兵锁住（探针 CLI 把实收 stdin 以 base64 回吐）。两处 exec 准入守卫刻意双存、拒绝文案逐字不变、且仍在写台账之前，#43 的"被拒派发不产生假发出流量"不回退。
  - **空白 `path` 不再被当成"没给"（#51）**：`workspace-manager.js` 原判定 `input.path != null && String(input.path).trim() !== ''` 把"提供了但纯空白"（`""` / `"   "` / `"\t"` / `"\n"`）折叠成"未提供"，于是**静默在受管根 mkdir 一个空目录、写注册表落盘、返回成功**——调用方本意是登记自己已有的目录，结果拿到一个从没人要的工作区，此后所有派发产生的文件都写进那里。现在 `create()` 最顶端（先于 `loadState`/`mkdirSync`/`trySaveState`）以 **400** 拒绝，文案点名 `path` 并说清真因（"已提供但为空白"），不伪装成"路径不存在"；三分类互斥且全覆盖：未提供（`null`/`undefined`）→ 照旧 managed，提供且非空白 → 校验链一字未动，提供但空白 → 拒绝且不留任何记录或目录。
  - **吞异常有了只降不升的门禁（#26）**：源码里 `try { … } catch (e) { }` 式"既不记录也不做任何决定"的纯吞曾有 **45 处 / 11 文件**（最多 `server.js 19`），过去没有任何机制阻止它继续生长——`no-empty` 视注释为非空，写一行 `/* 有意忽略 */` 就能过关（实测）。现在 `check-swallow-ratchet.mjs` 用 ESLint 显式规则 + esquery `:has()` 选择器计数（**注释不是 AST 节点，绕不过**），与 `swallow-baseline.json` 比对：某文件增长、基线幽灵文件、`total` 与逐文件之和不符——三者都非 0 退出并点名正斜杠相对路径；基线比实测更严则放行（这就是"只降不升"）。口径刻意放过 `catch { return false }` 这类**有决定的降级**（严格口径会把 `db.js`/`sse-replay.js` 也算红，只会逼出噪声 log 换绿灯）。门禁是**旁挂脚本**：`ai-bridge/.eslintrc.json` 一字未改（写 error 会把 45 处当场打成 45 error、毁掉"必须 0 error"那道门；写 warn 无人看），由 `test-audit-fixes` 的 M 段调起 ⇒ 跑套件即跑门禁。
  - **出站 HTTP 收敛为单点 + 绝对 deadline（#49）**：桥的 `httpGet`/`httpPost` 原先各写一套状态码阶梯（同一件事两份实现,文案已经漂成 POST=`服务返回格式错误`、GET=`格式错误`），且超时只用 Node 的 **inactivity** 型 socket timeout —— 对端每 40ms 吐一个字节、永不结束时它**永不触发**（实测桥 12s 都不自行回话）。现在统一走 `requestJson` 内核：`settle` 先到先得并清定时器（不留孤儿 timer）,除空闲超时外加一条**与活动无关的墙钟 deadline**（缺省即该调用生效的预算，故 30s 长轮询 `/api/poll` 有 32 倍余量、掐不到它）,三种失败可辨且都带预算数值：连接失败（含 `host:port` 与 Node 原始码）/ 全程无响应 / 慢速续命（含已回字节数）。非 2xx 仍 reject 且带 `status`/`body`，`/api/poll` 404 重注册与 `register` 403 慢重试契约不变。
  - **可用位与执行期同一把尺（#81）**：`CliAdapter` 原先有**两套**"命令在哪里"的判断 —— `detect()` 走 `commandPaths` + `where`（Windows 下 `where "C:\...\node.exe"` 退出码 2，把盘符当模式，于是**绝对路径命令永远判不可用**、相对 cwd 存在的路径同样不可用），而执行期 `resolveWindowsCommand` 却认绝对/相对路径；反过来 `commandPaths` **只喂可用位、不喂执行**，出现"标着可用、派发即失败"。合并为单一解析器 `resolveCommandPath`（①绝对 ②相对 ③`commandPaths` ④PATH，④是全项目唯一一次 `where/which` 子进程），`detect` 与 `runCommand` 同调它 ⇒ `available === 执行期真能解析出文件`。细节一起保住：`windowsHide`（否则服务态闪控制台窗）、`.cmd/.bat/.exe` 优先（原先"detect 认第一行、执行认另一行"的错位消灭）、失败文案仍带那个 `command` 名、`detect` 不 spawn 真实命令。成本：六形态 `where` 调用 9→6（净降），生产 11 条 CLI 工具 `available` **逐条不变**、探测次数 10→10。
  - **MCP 派发器表驱动化，必填以中枢真实校验面为准（#27）**：`dispatchToolCall` 原先 365 行 / 15 个 `case`，内联 **19 处** `httpPost`/`httpGet` 各自拼端点、各自处理错误，`recognize_image` 一个 case 就占 146 行（40%）。现在出站一律由 `TOOL_TABLE` 表项（`path`/`method`/`requiredArgs`/`render`）驱动、统一走 #49b 的 `requestJson` 内核，函数体内内联出站调用归零。**代价实测两处真回归并已返工修掉**：表里的 `requiredArgs` 是抄 `inputSchema.required` 得来的，而那份 schema 在重构前就**没有任何代码执行**（只是给宿主看的文案），文案一旦被抄成真门禁就等于静默删功能——`toggle_tool` 因此把 `enabled` 也列成必填，可中枢 `server.js:1410` 只校验 `tool`（写开关那一行不校验 `enabled`，"省略 `enabled`"本来就是合法的"**关掉它**"）；`memory_search` 因此把 `query` 列成必填，而 `server.js:1942` 传 `body.query || ''`、`store.js:355` 对空串返回"最近 10 条任务 + 10 条经验"，是一条**"浏览"通道**而非错误。两处均由锁定快照 `#27s9`/`#27s9b`/`#27s10` 以缺陷而红抓到，修法是把必填来源改回"被调端点的真实校验面"（另反向补一处：`create_workspace` 缺 `name` 原先**静默自动取名并建目录**（#88），现在出桥前拒绝，并把 `inputSchema` 的 `required` 与那句已失效的"省略时自动生成"文案同步改掉——**声明与门禁不同源就是这次的病根**）。护栏背景：`tools/list` 暴露的 15 个工具里只有 4 个在锁定套件中出现过 `tools/call`，**其余 11 个零覆盖**，所以重构前必须先补行为快照。
  - **隔离期不再谎称"不存在"（#73）**：某数据文件读不回合法 JSON/形状非法时，`store.js` 的 `quarantine()` 会把**当前坏字节**改名成 `.corrupt-*` 留作取证并置进程级脏标志，此后该 key 的写被闸门拒绝（#30 的防静默清库成果）。但 `workspace-manager.js` 的 `requireRecord()` 把"记录看不见"直接写成 `404 工作区不存在` ——实测隔离期间 `archive`/`restore`/`remove`/`resolveForDispatch`/`beginRun` **五个 op 一律 404**，而受管目录还在磁盘上、记录还在保全件里。404 是一次**假的断言**：它把存储故障伪装成用户错误，宿主会据此去重建工作区或以为数据丢了（#54/#74 归因误导同族）。现 `requireRecord` 顶端设**单一守卫点**查 `store.isQuarantined(key)`（新增的只读访问器，`= _corrupt.has(key)`，刻意不提供解除接口 ⇒ "重启即恢复"语义成立并被锁住），隔离期一律 `503 无法判定…在册状态`，文案点名 key、含 `.corrupt-*` 与 `logs.jsonl` 线索、绝不含"不存在"；位置在任何状态变更与文件操作之前，故隔离期 `remove{deleteFiles:true}` 既不删目录也不改注册表。未隔离时行为一字未改（未知 ref 仍 404）。
  - **落盘垃圾不再以未跟踪形态暴露（#29 第一半）**：`.gitignore` 只写了 `ai-bridge/*.bak`，而仓库里真实的备份形态是带后缀的 `.bak-cleanup-2026-10-14` —— 不匹配，于是 5 个备份、套件自建目录 `test-runtime-data/`、以及 `quarantine()` 留下的损坏取证件 `*.corrupt-*` 长期以 `??` 挂在工作树里。危害不是难看：它们会被 `git add -A` 扫进提交，而本项目另有**公开镜像仓**（`qidiai/Ai-Bridge`），保全件/备份里可能带本机路径与历史任务内容。现补三条 `ai-bridge/` 前缀窄规则（`*.bak-*`、`test-runtime-data/`、`*.corrupt-*`），**只让 git 看不见、不删任何文件**；反向锁 `#29h4` 钉住 `tools.json`/`models.json`/`server.js` 仍必须被跟踪，防"整目录 ignore"把配置从版本控制里抹掉。行为判据 `#29h5` = `git status --porcelain ai-bridge` 不再出现这三类条目。
  - **隔离原因现在说清真因（#74）**：`store.js` 的 `quarantine(key, reason)` 有两个来源完全不同的调用点 —— `load()` 的 `catch` 给引擎原文（解析/读取失败），`assertShape` 失败给 `shapeReason()`（如"顶层为数组(须 plain object)"）。但真因此前**只进日志、不进可查状态**，于是三个下游各自硬编了一句"本轮已因**解析损坏**被隔离"：`workspace-manager.js` 的 `REFUSED_CAUSE`（写被拒⇒500）、#73 那条 503、`store.js` 的写闸门日志。实测把 `workspaces.json` 写成顶层数组（**JSON 完全可解析**，只违反形状契约）触发隔离后，三处仍然全报"解析损坏"⇒ 运维会去查"谁写坏了 JSON"，而真因是容器类型错（#54 归因误导同族）。现新增 `_corruptReason`（仅首次置脏记、压平且 ≤200 字符）与只读访问器 `quarantineReason(key)`（未隔离返回 `null`），三处文案由真因组合；真因缺失时兜底说"原因未记录"，**绝不退回具体猜测**。
  - **用量统计只剩一本日历（#78）**：`db.js` 里同一份 `traffic.ts`（UTC ISO）曾被两本日历读 —— `todayTokens()` 用**本地**日期拼 `today` 去比 `substr(ts,1,10)`（**UTC 日**），而 `usageReport().byDay` 也按 UTC 日分组 ⇒ 预算页与报表页说的不是同一个"今天"。因为 `todayTokens` 是 `AI_BRIDGE_DAILY_TOKEN_BUDGET` 的唯一输入，**每天本地零点后约 8 小时内预算闸门实际是盲的**。现引入单点 `dayExpr(col) = substr(datetime(col,'localtime'),1,10)`，`usageReport.byDay`、`todayTokens`、`eventsSummary.byDay` 三处一律经它；**写侧零改动**（`ts` 仍是带 `Z` 的 UTC ISO，锁 `#78c3` 钉住——改落库格式会把全部历史与新数据劈成两套，那才是真毁账本）。可见影响：`byDay[].day` 的含义由 UTC 日变成本地日（键名与形状不变、无迁移）。锁刻意用"本地今天 00:30 与 23:30"两行做种子，使红灯**与运行钟点无关**；并在 4 种时区下各跑一遍全绿（本机 / `TZ=UTC` / `Asia/Shanghai` / `America/New_York`）。
  - **回滚失败不再谎称"已恢复"（#75）**：`remove(ref,{deleteFiles:true})` 的失败分支里，回收目录失败后会 `trySaveState` 回滚；回滚**失败**时原先只写一条 error 日志（"回滚失败，注册表与磁盘不一致需人工核查"）却照样向宿主抛出 `500 工作区目录回收失败，**已恢复注册表登记**` —— 同一函数里一边记"没恢复"一边说"恢复了"，是**积极错误的断言**（运维据此不再人工核查，而真实状态是"记录已摘、目录还在"）。现在该分支抛出与日志同真的正文：`回滚注册表登记也失败，注册表与磁盘不一致需人工核查 … — 回收原因: … — 回滚原因: …`，状态码仍 500；回滚**成功**时保留原句"已恢复注册表登记"（那是实话，`#75a4` 反向哨兵 + 沙箱真 OS 级 EPERM 实测都钉着它）。
  - **env 数字钳制改整串匹配（#96）**：`env-int.js` 的内核原先是 `parseInt(v)`——无 radix 且**前缀宽容**,实测把 `1e7`→**1**、`10MB`→**10**、`0x10`→**16**、`12.9`→**12**、`1,5`→**1**、`5 5`→**5**、`1_000`→**1** 全当合法值返回,且**一条留痕都不写**;超位大数还会返回 float 形态(`1e20`)埋 `ERR_OUT_OF_RANGE` 崩进程的雷。现在只接受"可选 +/- 号的纯十进制整串"(数字入参须为安全整数),其余一律回落默认并 stderr 点名变量名。运维口径:写 `AI_BRIDGE_DAILY_TOKEN_BUDGET=1e9` 原先=预算 1 token(闸门当天全灭、无痕迹),现在=按"不设预算"处理且启动即点名。`adapters/cli-adapter.js` 里最后一处手搓 `parseInt(process.env.AI_BRIDGE_CLI_MAX_OUTPUT_CHARS)` 已并入同一单点。**留痕时机**由 #102 收口:该 env 的求值已从 `runCommand` 内挪到 `adapters/cli-adapter.js` 模块顶层 ⇒ 中枢启动即点名,且同一变量每进程最多一条。
  - **env 钳制的每一处都会点名（#101）**：`env-int.js` 只在调用方**传了第三个参数 `name`** 时才写 stderr 留痕;`server.js` 有 5 个调用点只传了 2 个参(acorn 与零依赖扫描器双口径对表:调用点 18 / 缺 `name` 5 —— :66 `AI_BRIDGE_MAX_CONCURRENT_DISPATCH`、:67 `AI_BRIDGE_RESULT_MAX_CHARS`、:70 `AI_BRIDGE_CLIENT_TTL`、:225 `AI_BRIDGE_CACHE_TTL`、:226 `AI_BRIDGE_CACHE_MAX`)⇒ 这几个 env 写错时中枢**默默用默认值跑,一句不说**。现在 5 处都补齐变量名,并且有一条启动行为锁 + 一条调用点结构锁钉住。
  - **沙箱复制清单由闭包实时校验（#100，预防锁）**：`test-store-corrupt.mjs` 的 #46 探针把 `tool-registry.js` 等文件复制进临时树再 `require`，清单原先是**手写白名单**；#96 给 `adapters/cli-adapter.js` 加了一句 `require(../env-int)` 就让 5 条断言崩成 `Cannot find module`（实测 38/43），红因在工装不在产品。现在清单收敛为单一真源 `REGISTRY_COPY`，并由 `#100a1` 在**每次运行**实时计算 `tool-registry.js` 的传递 require 闭包来比对（缺项/冗余都点名），`#100a3` 用变异自证（人为删掉 `env-int.js` 必须报缺 1 项）钉住这条锁**不是空对空**，`#100a4` 再钉住解析器本身（>=6 个文件、零未解析边）。今后"加 require 忘加文件"= 指名道姓红，不再神秘崩溃。
  - **非法 env 启动即点名、每进程最多一次（#102）**：`AI_BRIDGE_CLI_MAX_OUTPUT_CHARS` 原先在 `runCommand` **函数体内**每次求值 ⇒ 两个毛病:配置写错时中枢**启动完全正常、零痕迹**(直到第一条派发才被悄悄回落救回),而一旦开始派发又**每次调用刷一条同样的 warn**(噪声随任务数线性增长)。现在求值挪到 `adapters/cli-adapter.js` 模块顶层:与 `server.js` CONFIG、`bridge-stdio.js` 端口/超时同属"加载期求值",启动那一刻就点名;每进程只执行一次。护栏没有挪走——上限仍在每次 `runCommand` 的 `checkOutputLimit` 里真执行(实测:上限=10 时 50 字符输出仍被终止;上限=100 时 50 字符仍成功)。锁:`#102a1` 启动即点名、`#102a2` 同进程两次派发只留一条、`#102a3~a5` 三条反向哨兵(未设置零噪音 / 合法小值必须真拦 / 合法大值必须真放行)。
  - **损坏的类别由代码位置给出，不再靠认英文句式（#97）**：`store.js` 原先把 `readFileSync` 与 `JSON.parse` 塞在**同一个 try** 里,catch 直接拿 `e.message` 当原因 ⇒ 对外文案(`quarantineReason()` → #73 的 503 正文、#74 的拒写日志、工作区 `refusedCause()`)里"这是什么类型的损坏"完全取决于 V8/libuv 的措辞,读错误与解析错误分不开。现分三阶段各自组合类别:**读取失败**(连字节都没拿到,如 EISDIR/EPERM/EBUSy)/**解析失败**(字节合法拿到但 JSON 不合法)/**形状非法**(能解析但结构不对,字段名细节保留在冒号之后)。同时"有界原因摘要"归成**一把尺** `store.causeOf`(尾部优先 + 把开头错误码补回 + 总长 ≤200,即 #54 立的规则)——此前 `store.flattenReason` 保**头**、`workspace-manager.causeOf` 保**尾**,同一规则两套实现且互相矛盾,store 那套正好把末尾真因截掉;`workspace-manager.js` 的本地实现已删除并改调单点。保守策略一字未动:仍隔离、仍返回空结构、绝不抛错、first-write-wins。
  - **同一件事只有一种留痕句式（#103）**：`store.js` 原先对「某文件本轮被隔离」写两套帧——`:74`「存储文件 X 损坏(半角括号…原因: …),本进程内拒绝覆写」与 `:165`「拒绝覆写 X:本轮已隔离（全角括号…）」,同一 key 两条 error 留痕形状不同,运维**一条正则捞不全**。现由唯一写手 `store.storageNotice(key, event, detail)` 产出固定骨架 `存储文件 <basename> <event>（原因: <reason>[; <detail>]）`,原因一律取 `quarantineReason(key)`(两帧同源)。另删除 `markOrphanMeetings()` 里一处**手抄 `shapeReason` 文案的死码**(实测该文案在 `store.js` 出现 2 次;可达性实验证明它永不可观测——真因总由 `load()` 先写入且 `quarantine` 只记首次),守卫 `return []` 保留、对外行为一字不变。
  - **名单写被拒就不再报成功（#105）**：`store.saveSync` 在 key 被隔离时返回 `false` 而不抛错,而 `server.js` 里 5 处 `store.saveACL(acl)` 全是裸调用、返回值被丢 ⇒ `clients-acl` 隔离期真 HTTP 实测 `approve`/`deny`/`kick` 都回 **200 `success:true`**,同一进程却写着「拒写（原因: …）」的留痕、活文件也不在——**名单变更根本没落盘却告诉调用方成功**(#43 同族换面)。现新增单点构造器 `aclRefusal(action, clientId, runtime)`:拒写一律 **503 + `原因: <quarantineReason('acl')>`**、正文不含 `success`、带 `persisted:false`,并按各点实况如实携带运行时半事实(`runtimeKicked`/`runtimeOccupiedNow`/`runtimeRegistered`);成功路径的 200 响应体与顺序一字未动。
  - **桥不再把"拒写 503"说成"连接失败"（#107）**：#105 让中枢诚实回 `503 + persisted:false`,但桥的内层 catch(`bridge-stdio.js:946-949`)只特判 `403+denied`,其余一律 throw ⇒ 实测真桥打「连接失败(1/100)…」并按指数退避烧 100 次预算,耗尽后还要人"检查中枢是否存活"(实况 health=200)。现在识别 `status>=500 && body.persisted===false`:打含「拒写/名单」+「原因」且该行不含「连接失败」的诚实留痕、按待审批 5 秒节奏重试、不烧预算;原因逐字携自回执,缺失写"原因未记录"。三条反向哨兵钉住不许把**所有** 5xx 洗白(500 无 persisted / 端口不可达 / 403 denied 三条既有语义不回退)。
  - **建会回执与落盘同真（#106）**：`memory.json` 启动即坏时,`POST /api/discuss` 实测曾回 **200 + meetingId + status:"discussing"**,而同一次运行里 `拒写（原因: 解析失败: …）` 的留痕已写下、`memory.json` 已被改名保全——会议哪儿都不存在,后台循环却真的跑起来了(沙箱日志里 2 行轮次 = 幽灵循环)。现:消费 `saveSync` 返回值**并处理"找不到该会议"这一支**,任一失败 ⇒ **503 + 原因 + `persisted:false` + `started:false`,且在启动后台循环之前 return**(实测幽灵行 2→0);健康态 200 响应体一字未动。`#105` 的 `aclRefusal` 泛化为唯一构造器 `persistRefusal(key, action, extra)`,`server.js` 里 5 处整句丢弃 `store.saveSync` 返回值的写点全部消费(stats 拒写改记计数,不另起日志帧)。
  - **有界原因摘要只剩一把尺（#104，预防锁）**：`store.js` 的 `CAUSE_MAX`+`causeOf` 与 `tool-registry.js` 的 `DIAG_ERROR_MAX`+`boundedReason` 是同一条规则的两份复制，后者还缺 #97 补的 `'XxxError'` 空壳判「未知」。因 `#46a4` 禁止 tool-registry 依赖 store（桥进程加载期不得 mkdir 数据目录），规则下沉为 `cause.js`——零 require、零副作用、导出 `causeOf(e)` 与 `CAUSE_MAX=200`；store 引它并继续 re-export（`workspace-manager.js` 的 5 处 `store.causeOf` 与 `#97a11` 不回退），tool-registry 引它并把唯一调用点改为 `causeOf`。可达性实验实测两尺在真配置路径上逐字相等（5 个解析样本，长度 28/28/56/85/69，均不触发截断），所以本格**没有行为红**，价值在防第 4 把尺漂移：`#104a1/a2/a3` 钉结构（实现指纹、同义上限常量、两侧都引 `./cause`）、`#104a5` 双向自证指纹（复制品必被抓、`store.js:276` 日志窗口与 `:332` 消息上限这类无关尾部截取必放过）、`#104a4` 钉行为不回退（`/api/tools` 的 `registry.status=corrupt-parse` 与可归因 error 且有界）。真 HTTP 前后对照（改前树 `git archive 327c493` vs 当前树，各自四重隔离沙箱）：截断/形状非法/合法数组三种配置的 `/api/tools` 响应体逐字一致（175/175、175/175、364/364 字符），中枢 `logs.jsonl` 的降级留痕除时间戳外相同。
  - **等待节奏只剩一份（#108，纯重构）**：`bridge-stdio.js` 的注册/轮询等待此前有 **8 处表达、5 个语义档** —— `setTimeout` 裸数值 4 处（`:955` 拒写／`:975` 被拒／`:979` 待审批／`:1065` 轮询）、退避上限裸 `30000` 1 处（`:984`，与"被拒档"同值不同义）、留痕文案再各自手写秒数 3 处（「N 秒后重试」）。现收敛为 `REGISTER_PENDING_MS`／`REGISTER_REFUSED_MS`／`REGISTER_PERSIST_REFUSED_MS`／`REGISTER_BACKOFF_CAP_MS`／`POLL_RETRY_MS` 五个具名常量，文案秒数由 `pacingSeconds(ms)` 导出 ⇒ 改节奏不可能再漏改文案。**刻意没被并掉**的三处 `30000`（GET 超时默认、`CALL_BUDGET_MS` 余量、ocr.py 子进程 timeout）各有独立语义，`#108a5` 反向哨兵钉住不许顺手并入。行为等价不靠"看起来没改"：改前树（`git archive c8a19a1`）与当前树各跑真桥 × 假中枢五档，**stderr 逐字节相等**且相邻留痕间隔最大偏移 ≤12ms（拒写档实测 5008ms 对文案 5 秒）。`#108a6` 是这一格的墙钟交叉锁、`#108a7` 是三条结构判据的双向指纹自证（防过宽永远红/过窄永远绿）。桥侧文件不被 `server.js` 加载 ⇒ 本格未重启生产中枢（宿主下次 spawn 自然生效）。
  - **建会落盘事实由 store 回传（#109）**：`store.saveSync` 在隔离期返回 `false` 而不抛错，而 `createMeeting`（实测 `:294`，台账旧号 `:310`）曾把返回值整句丢弃 —— store 内 7 个 `saveSync` 调用点里唯一的例外（其余 6 处是 `return saveSync` 5 处 + `!saveSync` 条件 1 处）。HTTP 谎面 #106 已在调用方堵住（建会后 `loadMemory().find()` 反查不到 ⇒ 503），但**判据放错了地方**：知道真假的一方不回传，只能靠另一方"再读一遍碰巧找不到"去猜。现在 `createMeeting` 回传 `{ meeting, persisted }`，`server.js` 用 `let metadataSaved = persisted`；`load→find` 的职责退回"取回对象补运行时字段"，"找不到 m"作为竞态防御支路保留（仍 503），`persisted===false` 时不再做多余的 load/find。锁：`#109a1` store 内不得再有整句丢弃、`a2` `createMeeting` 必须回传、`a3` server 的诚实来源必须是 `persisted`、`a4` 反向哨兵钉住其余消费形态（5/1/8）不被顺手重构带走、`a5` 建会 503 仍须带 `meetingId`。行为面零变化由真启动中枢 A/B 证明：脏态两棵树 503 文案逐字相同、`logs.jsonl` 该会议留痕 0 行（幽灵循环不回退）、`onDisk=false`；净态 200 响应体（归一 `meeting_\d+` 后）逐字一致且读盘确认落盘。
  - **讨论循环的持久化看门狗（#110）**：后台循环里 `updateMeeting()`/`store.addMessage()`/`store.closeMeeting()` 三类写点原基线有 **20 处整句丢弃返回值**（#106 R4 已经让 `updateMeeting` 写被拒时回 `null`，却没人接）。于是 `memory.json` 在循环中途被隔离时：这一轮写不进去、下一位发言者照样派发、轮次与统计只在闭包里走 —— 幽灵循环的存量变种，还继续烧真实派发配额。现在闭包内有 `persistFails`（**连续**失败计数，一次成功清零 ⇒ 偶发一次失败不会误杀健康会议）、`notePersist(ok)`（truthy 判据、收尾期短路）、`storageDead()`（`>= 2`）、`checkStorageDead()`（成立即走**既有** `finalizeAutoStop('存储拒写（memory 已被隔离，本轮无法落盘）')` 并由调用方 `return`）、`storageStopped`（防重入：收尾自身的三次写入不再计数，且闸门只可能让 `finalizeAutoStop` 执行一次）；5 处闸门插在每次将要派发之前与共识总结/共识度投票/自动实现之前。顺带把 #109 核准并入的 P1 做掉：`meetingRefusal(action, meetingId)` 单点构造器，`interrupt`/`inject` 不再各抄 `persistRefusal`（建会那处带 `started:false` 的 503 刻意不并，并进来会改坏 `#106a2` 的旁证）。行为锁用**可数的派发次数**取证（沙箱真中枢 + 3 个本地假 CLI，零网络零配额）：损坏态派发 3→2、`logs.jsonl` 自动止损留痕 0→1；健康态照旧恰好 7 次派发、拒写留痕 0。已知残留见 **#114**（止损那句系统消息同样落不了盘，磁盘只有 `logs.jsonl` 一帧）。
  - **留痕秒数只剩一个算法（#113，纯重构一行）**：`#108` 收了注册三档却漏掉连接失败档——`bridge-stdio.js:989` 仍自己写 `${Math.round(retryDelay/1000)}`，而 `:42` 已有 `pacingSeconds`。现在该行走 `pacingSeconds(retryDelay)`，全仓"毫秒→秒"换算只剩定义那一处（实测 `Math.round(…/1000)` 由 2 处收敛为 1 处，`pacingSeconds` 调用 3→4，「秒后重试」文案总数 4 不变）。行为零变化两个机制互证：同一 `retryDelay` 值集两侧算出 1/2/2/3/30 秒逐字节相同；改前树与当前树各跑真桥 × 同一不可达端口，留痕整行逐字节一致、宣称序列 `[1,2,2,3]` 两侧相同、间隔最大偏移 10ms。锁定测试 `#113a4` 用"宣称秒数 vs 实测间隔偏差 ≤1s"钉同源——**不能**写成"间隔==宣称×1000"，因为 `Math.round(1500/1000)=2` 而实睡 1.5s，那是今天也过不了的不可满足锁（我差点又踩，容差与理由都写进注释）。桥侧文件不被中枢加载 ⇒ 本单未重启生产，只读复核逐项一致。
  - **无信息壳判据补全 toString 标签形态（#111）**：`cause.js` 原先只把 `'Error'`/`'SyntaxError'` 这类**异常名壳**判为"未知"，而同一事实的第二类形态——`String(x)` 塌成的 `Object.prototype.toString` 标签——实测**四类输入 0 类被判出来**：`causeOf({})`、`causeOf({message:''})`、`causeOf({message:'[object Object]'})`、`causeOf({message:'[object Module]'})` 全把壳本身外泄成"原因"（运维读到 `'[object Object]'` 等于没读到）。现在两类壳由**一条整串锚定**判据 `SHELL_RE = /^(\[object \w+\]|[A-Za-z]*Error)$/` 一起判"未知"。锚定是重点：判据若写成 `includes('[object')`，`'参数 value [object Object] 不可序列化'` 这类**带真实正文**的归因会被误杀（`#111a2` 反向哨兵钉住，与 #60 同族）。可达性实验先行：`causeOf` 的 8 个调用点喂入的都是真 Error 或 `shapeReason()` 非空字符串，仓内非 Error 形态 `throw`/`reject` 命中 0 ⇒ 生产今天打不出，本单修的是**单点 API 的输入域完备性 + 防下一次复制变质**，不夸大成线上故障。取证分两组（改前树 `b7cc00d` vs 当前树，同一子进程分别 require 两棵树）：A 组真路径**逐字节 0 漂移**（隔离原因、`saveSync=false`、`storageNotice` 全帧、registry 诊断、12 条真 Error 摘要含两条子串样本与两条 250 字符有界样本）；B 组只有四类壳输入按设计变成"未知"。
  - **注释与文档里的行号锚点只剩一把尺（#112，结构锁 + 说明书语义锁，零源码改动）**：`#61a3/a4` 那道旧检查只看"路径可达 + 行号不越界"，既不看命中的那一行是不是**空行**，也完全不覆盖源码/测试注释；而 `文件.js:NNN` 这种锚点每遇一次重构就漂移一次（#108/#109/#110/#113 四格连续认领过同一族）。本轮把两样都补上并当场把存量清零：判据实测基线（commit `162d873`，分母由锁自己扫）= 源码+测试注释点号锚点 **84 处、失效 9 处**（7 空行 / 1 越界 / 1 目标不存在），README 37 处失效 1、ARCHITECTURE 55 处失效 0，**9 处全在测试注释、源码 0 处** ⇒ 修复不需要编码手。第二把尺 `#112a4` 管结构锁看不见的那一类：README env 表里**整行只有一个锚点**的行，该锚点所在行必须点名该 env——判据跑在 `git show 162d873:ai-bridge/README.md`（源码取当前树）上实测红 **11/14**：CONFIG 块 6 行整体错位 1–2 行（`AI_BRIDGE_CORS` 指到 `};`）、桥侧视觉与反向 sampling 4 处落在报表文本拼接行、`AI_BRIDGE_PROXY_TIMEOUT` 指空行；多锚点行与无锚点行不判（前者合法地引旁证行，强行要求每个锚点都点名＝打假红，`a4b` 用变异自证把这条边界钉住：真行判绿、把它的锚点改指 shebang 判红、过宽版必须打红那条三锚点真行）。手工回源抽样 12 处"行非空因而被结构锁放行"的锚点，**5 处指向的是别的变量**，已一并订正。不可锁的残项（源码注释里的裸 `:NNN` 续指）拆出 **#116**。交付 audit **127/127**、六套 **651/651** 两轮同数、eslint 0/18、棘轮 43/43；生产未重启（零源码改动），只读复核逐项一致（pid 36932、工具 12 条 `registry.status=ok`、工作区 1、非终态会议 0、五个 JSON sha256 与 `bridge.db` 6291456 字节一致、`.corrupt-*` 0 件）。
  - **启动就绪等待只剩一把尺（#115，纯测试工装，源码 0 文件）**：等"中枢起来了"这件事此前有两种写法并存——主实例走有界轮询，而六个第二实例探针写的是**先睡够再判**（`sleep(2000)`/`sleep(2200)`×3/`sleep(1800)`/`sleep(2000)` + 一次性 4s 请求）。后果不是产品缺陷而是**验收面自己产假红**：与前置套件（会起多个带 90s 超时的沙箱中枢）争 CPU 时 2 秒窗口不够，`#52b1`/`#80a1` 双双假红（上一格实录：同序双跑第 1 轮 247/249，单独重跑 249/249）。现收敛为 `waitHubReady(port,{timeoutMs,throwOnTimeout}) -> {ok, elapsedMs, last}`（节奏具名 200ms/20s），主实例的旧封装退化为薄壳（超时文案逐字不变），就绪耗时写进详串使"慢启动"与"起不来"可分辨。**判据强度未放宽**：仍要求真响应且 `status==='ok'`。三条行为锁自带鉴别力：真延迟 2.6s 监听的假中枢上"等得到"、永不开监的端口上"预算等满才判 false"、同一场景下**旧形状必须失败**（缺这条就分不清"修好了等待"与"把判据放宽成永远绿"）。交付 e2e **253/253**、六套 **655/655** 两轮同数、eslint 0/18、棘轮 43/43；同序双跑不再抖动即本单的验收。残项：**#117**（跨套件仍有 10 处手写 `for` 轮询各写节奏与预算，等的是客户端 online/busy、会议终态、taskPending 清除等别的状态，应收敛为通用 `waitUntil`）。
  - **台账留住了路由分解字段（#62）**：点名几个（`requested`）/实派几个（`total`）/被静默跳过的是谁（`skipped`）此前**只在响应里诚实一次**——调用点本就带着这三个字段，但 `store.recordTask` 的字段白名单不收，于是生产 `memory.json` 的 118 条真工具任务里 0 条含它们，事后复盘时"点名 3 个跳过 2 个"和"只点名 1 个"长得一模一样。现在三字段原样落台账（不加 `|| 0` 之类的兜底，免得把"没传"和"真是 0"混成一个值），并由三条判据钉住：白名单内字段必须能读回（对照组，防"空对空假红"）、三字段必须逐值落住（行为锁）、`routing`/`dispatchId` 不得顺手整体落盘（反向哨兵）。SQLite 的 `dispatches` 表仍只有 `total`，补 `requested`/`skipped` 需要给在用的 6.29MB 生产库做 `ALTER TABLE` 迁移 ⇒ 另立 **#121** 待你裁定（产品决策，不是技术决策）。交付：store-corrupt **77/77**、六套 **658/658** 两轮同数、eslint 0/18、棘轮 43/43；真链路补验用沙箱中枢 + 假 CLI（零成本、零生产足迹）实测台账与响应逐值一致、`skipped` 两名俱在。生产按闸门重启后零漂移。
  - **免鉴权路由必须核实物理对端（#64）**：`/proxy/*` 与 Web UI 首页这两条免鉴权路由，注释长期写着"仅监听本地回环/只允许本地访问"，而 `server.js` 全文 **0 处** `socket.remoteAddress` 判定 —— 未经核实的假设被当成了控制措施。实测：把中枢以 `AI_BRIDGE_HOST=0.0.0.0` 起在沙箱，从本机 WLAN 地址打过去，`/proxy/<source>/<key>/v1/chat/completions` **回 200 且上游真收到请求**（等于给局域网开了个免费 LLM 中继），`GET /` 回 **200 + 完整页面**。现在两条路共用单点 `isLoopbackPeer(req)`（只认 TCP 层对端，`X-Forwarded-For` 这类可篡改头一律不算数；取不到地址按非回环处理）：Web UI 仅回环可取；`/proxy/` 仅"**回环** 或（中枢**已配置**凭据 **且** 校验通过)"可用 —— 未配凭据的中枢对非回环一律拒，避免 `checkAuth` 的"未配 token 恒真"把门退化成全放行。`checkAuth` 同时改为 `crypto.timingSafeEqual`（先比长度再比字节，长度不等会抛 `RangeError`），判定结果与原先逐字相等完全一致。三处反向自证钉住"不过宽"：本机被接管的工具（不带中枢凭据）零回归、局域网调用方**带**凭据仍可借据、未配凭据自用实例的回环仍可透传、`GET /api/health` 从非回环无凭据仍返回存活视图（#68 的裁定：外部监控要能不被挡住才叫判活）。
  - **MCP 面能异步派发了（#58）**：此前宿主只能吃同步窗口——桥的 `dispatch` 没有声明 `async`，也没有任何取回结果的通道，而中枢侧异步其实早就可用（`POST /api/dispatch` 带 `async` 实测 202/13.5ms 交回 `taskId`，`GET /api/task/:id` 内存优先、回落 SQLite，跨重启仍可查）。更糟的是桥的渲染器无条件按同步形状取 `results/successCount`，真把 `async` 透传过去时"刚入队"会被渲染成 `📊 undefined tokens | undefined/undefined 成功`（把未完成报成已完成）。现在：`dispatch` 声明 `async`(boolean)，新增 `task_status` 工具（必填 `taskId`，出站对 id 做 `encodeURIComponent`，状态点名 `running/done/failed` 并带 taskId，`done` 给成功数与 token、`failed` 给原因），渲染按响应形状分支；同步派发那条路输出**一字未改**（`#58a7` 反向自证锁它）。长任务由此不再受桥的 HTTP 墙钟限制，这也是北极星（把其他编码工具当子智能体使）的正墙一块。改动只在 `bridge-stdio.js`——桥是每个宿主各自 spawn 的进程、不被中枢加载，**生产中枢不需重启**（但已在跑的旧桥进程要等宿主重启才会带上新工具）。
  - **止损的"为何停止"不再随 memory 一起丢（#114）**：讨论循环的持久化看门狗触发自动止损时，那句 `(自动止损: 存储拒写…,讨论提前结束)` 此前和会议终态一起押在**同一个坏掉的落点**上（三处写入全部经 `saveSync('memory')`），memory 被隔离并改名后必然全被拒，于是它只剩 `logs.jsonl` 一行；而 `GET /api/discuss/status/<id>` 读不到会议就直接回 `404 会议不存在`——**把存储故障谎报成没这回事**。现在止损会另经既有单点 `db.recordEvent` 记一笔全局事件（`type='auto_stop'`，`detail` 带原因原文），status 视图在 memory 读不到时先回读该落点：有止损记录就回 **200 降级视图**（`degraded:true`、`status` 明说"存储不可读（memory 已被隔离/拒写）"、`interruptReason`、`autoStops[]`，并注明"不含会议正文"），一条都没有才维持 404。读侧新增的 `db.queryEvents` 全部走绑定参数（`source` 来自 URL 路径分段，属外部可控，SQL 文本里只拼常量片段），且**不动 schema**（不建表、不 `ALTER`）。
  - **两处"看着没事、实际丢信息"的静默行为被消掉（#123 + #124）**：① 建会 id 原先只有 `meeting_${Date.now()}` 一个因子，同一毫秒并发建会必然撞名 —— 而全仓取会议的唯一方式是按 id 精确查找，撞完之后**两个讨论后台循环共用同一条记录**（发言串台、终态互相覆盖），且没有任何地方知道撞过；现在 id 追加 3 字节随机后缀（形如 `meeting_…_1b4942`），前缀与 `{meeting, persisted}` 返回形状不变。② `db.recordEvent` 对 `detail` 做的 2000 字符兜底截断原先**砍尾不留痕迹** —— 而 #114 刚把"讨论为什么被止损"托付给这张 `events` 表当第二落点，超长原因读回来是一句断话却看不出被截；现在超长会接尾部标记 `…(已截断,原长 N 字符)`，而未超长与**恰好 2000** 一字不变（边界用 `<=`，防留痕变成噪音），且不动 schema、不新增落点。
  - **未修（如实列示，按当前队列序）**：
  - #114 隔离期止损的那句系统消息本身也落不了盘：#110 的看门狗触发 `finalizeAutoStop` 时，「`(自动止损: 存储拒写…,讨论提前结束)`」这条 `store.addMessage` 恰好也要写正被隔离的 `memory.json` ⇒ 磁盘侧只剩 `logs.jsonl` 一帧 warn，管理员事后查会议历史看不到"它是被存储故障停掉的"（与 #33 P0b 同族，但那是现势状态、这是历史侧写）。候选改法两条，均需单独取红基线：① store 侧「隔离期暂存-解除后补写」（须定义暂存上限、补写时机与幂等）；② 把止损事实改写到未被隔离的 key（DB 面给会议打终态标记）。**约束**：`#110a2` 的判据继续取 `logs.jsonl`（磁盘可读的那一帧），不许改成只认 `memory.json`——那与隔离语义自相矛盾。
  - #116 源码注释里的**裸 `:NNN` 续指**与陈旧行号引用仍会随重构漂移（#112 的不可锁残项，2026-10-24 实测两例：待审批档那句「与某行同」指向的其实是 `hasRegistered = true` 那行，真正的 await 在别处；损坏/拒写两帧的旧写点仍用裸行号描述 #103 之前的形态而不标"修复前"）。为什么不能像 #112 那样写成锁：裸 `:NNN` 判不出归属文件，`#112a3` 已实测三类假阳性（token 数 `{input:200`、URL 端口 `localhost:8500`、跨文件续指 `server.js:1342,:1347`），任何"扫裸行号"的判据今天都不可满足。改法：① 逐条人工核并把措辞改成**符号/分支名**（如「与 `REGISTER_PENDING_MS` 档同」）；② 描述历史形态的一律加"修复前"或直接去掉数字；③ 范围含 `ARCHITECTURE.md` 里 #108 提案记过的 `bridge-stdio.js` 若干位移引用，以及 README/ARCHITECTURE 编年史里已经漂移的历史行号。因改点落在**源码文件** ⇒ 须派编码手（白名单只给注释行，禁碰任何可执行语句），并照纪律跑闸门后重启中枢、做零漂移对照。与 #61 文档保真锁部分重叠，后续并轨。
  - #121 `dispatches` 表缺 `requested`/`skipped` 列 ⇒ **待你裁定，不是我可顺手做的**：#62 只补了 memory 台账（`store.recordTask` 白名单，零迁移风险）。实测 `db.js:112` 的 INSERT 列表是 `(id, ts, task, tools, success_count, total, total_tokens, elapsed_ms, routing, results)`——有 `total`，**没有 `requested`、没有 `skipped`** ⇒ 按派发维度跨重启查询仍然分不清"点名 3 个跳过 2 个"和"只点名 1 个"。为什么不当顺手事做：① `CREATE TABLE IF NOT EXISTS` 对既有库不生效，必须 `PRAGMA table_info` 探测缺列再 `ALTER TABLE`，且读侧 SQL 在旧库上不能直接引用新列（一查就抛），要写降级；② 生产库 `~/.ai-bridge/bridge.db` 是 6,291,456 字节的在用文件，且 observe 根与它同目录（#120 刚记的共用风险），迁移前必须备份并在台账留 sha256；③ 当前 SQLite 侧唯一消费方是 `/api/insights` 与报表，都不需要 `skipped` ⇒ **收益是"未来可精确复盘"，代价是"给在用库做结构迁移"**，这是产品判断。指挥官意见：先不做，等 #55 真跑起来、确实需要按派发维度审计"谁被跳过"时一次性做；届时约束是"ALTER 失败必须留痕且不阻断派发、写穿失败不得谎报成功"（沿用 #43/#75 的规矩）。
  - #117 测试工装里"等某个状态成立"仍各写一遍（#115 的上位单，2026-10-24 实测分母）：#115 只收了"等中枢就绪"这一件事，跨套件仍有 **10 处手写 `for (let i = 0; i < N …)` 轮询循环**（e2e 7 处、audit 3 处），等的是客户端 `online`/`online_busy`、会议终态、`taskPending` 清除、`firstPollAt` 生效等别的状态——间隔、预算、失败详串各写一套（#104/#108/#111/#115 同族病：同一规则多处实现）。改法：把 `waitHubReady` 泛化为 `waitUntil(label, probe, { intervalMs, budgetMs })`，"等条件成立"只留一把尺，失败详串统一带 `elapsedMs`。**顺带解决一条本轮实测到的可观测性缺口**：`check()` 只在**失败**时打印详串 ⇒ 绿灯侧的实测耗时进不了输出，所以现在拿不到"这次启动实际花了多少毫秒"的历史读数；统一 poller 应带一个开关把 elapsed 打到 stdout（开关名待定，但**禁止**取 `AI_BRIDGE_` 前缀——那会被 `#61a2` 反向哨兵判成"文档里凭空多出的 env"，我在这段话的初稿里就踩了这一次，实测幽灵计数 1 条）。代价与边界：改动牵动 #42/#43/#59/#39 段的时序断言，须**逐段**取红→绿并把每段实测耗时记进台账；一次做完风险集中，建议按段分小格。零生产风险（不触碰源码）。
  - #57 桥默认身份是常量 `unknown`：`connectedClients` 以名字为键，同一宿主的多个派生会话必然塌进**一个**在册条目，共享 `pendingTask` 槽与能力字段；后启动会话的 `registerSeq` 基数天然更大，于是"后来者覆写全体能力"成为合法行为。且注册复用分支**静默无日志**，中枢也无 `hostCount`/poll 计数面——该缺陷目前**无法从可观测面证明有几个会话在共享身份**。
  - #58 MCP 面无异步派发：中枢支持 `body.async === true`，但 `dispatch` 工具没有 `async` 入参、也没有取回异步结果的工具，宿主只能吃同步窗口。
  - #60 失败判定器仍会被**短文本里的数字子串**误伤：`looksLikeError` 只要正文 ≤400 字符即返回 true，而关键词表含裸 `'401'/'402'/'429'`，于是"耗时 4021ms""见 `:398-401`"这类成功产出可能被记成失败（#37 只修了长文那一半）。
  - 其余：#86 `tool-registry.js` 里还留着**第二把** PATH 尺（`findInPath:186`，`server.js:16` 死导入、但被 `test-unit.mjs:86/88` 锁着行为 ⇒ 不能直接删，须与锁同源归一）、#87 生产 `tools.json` 里 `codely`/`codely-k3` 的 `commandPaths` 指向**不存在的文件**（靠裸名在 PATH 掩盖，#81 之后若那文件出现会优先于 PATH 被选中）；#85 Ollama 视觉调用(`recognize_image`)仍是独立出站实现,只有 inactivity 超时(drip 型挂起可永悬)、且 `commandPaths` 只喂可用位不喂执行;#95 /v1 错误体是扁平 `{error:"字符串",detail}` 而 README 承诺"任意 OpenAI SDK 可直连"(4 处原因只在 detail;**但扁平形状被自家锁定测试 T3-8 钉着 ⇒ 属文档/契约偏差待裁定,不是可直接修的缺陷**)、#28/#29 出口归一(实测 66 处错误站点已有 65 处带 `error`,**降档为可维护性**)/仓库卫生、#89 桥侧 `dispatch` 缺 `MAX_TASK_LENGTH` 预门（要加必须与中枢常量同源，硬编码数值会造出第二把尺，建议随 #58 异步派发同批）、#90 `requiredArgs` 字面量引号风格不统一（`:411/:434/:531` 仍是双引号，纯格式改动会污染逐字节审计 diff，故随 #29 批量清）、#91 未获批的探针注销后在 `clients-acl.json` 的 `pending` 里留**永久残留**（注销只摘在册客户端，不摘审批队列；本轮实测三行、已备份后人肉清理，与 #63/#71 同族＝清理动作没有验收面）、#55 北极星端到端验收、#32 HTTP 入口坏 JSON 伪装成参数缺失（本轮实测再现：非法 JSON 的 toggle 请求回的是 `400 缺少 tool 参数`，不是"body 解析失败"）、#33/#34 损坏与隔离状态上报到 `/api/health` 与 UI、#35 `tools.json` 模型漂移。
  - 鉴权面残项（#42/#68 之后仍然成立的口子）：**#64** `/proxy/*` 在鉴权门**之前**免凭据透传（与 `/v1` 同属"能执行能花钱"面，另含 `checkAuth` 非恒定时间比较）、**#65** `check-active.js`/`cleanup-stuck.js` 硬连生产 9800 却不带凭据（设 token 后必然 401，运维脚本自己失效）、**#66** 把 #42/#68 的一次性凭据取证 harness 固化成第 7 套常驻套件（防"第二个调用点漏网"复发；禁止"复制一份 JS 进测试"那种永远绿假锁）、**#67** UI 流式解析三缺陷（无跨块缓冲、`TextDecoder` 未开 `stream` 会碎中文、`catch(_){}` 静默吞）。
  - #43 之后核准新增：**#72** `beginRun` 是第 5 个丢弃 `saveState` 返回值的站点（隔离/写故障时租约与 `useCount` 静默漂移，本单规格明令不动）、**#73** key 被隔离期间对已知 id 的写/删返回 404「不存在」而非 5xx 降级（`store.load` 返回 `{}` 使记录不可见，与 #33/#34 同源）、**#74 残项（主项已修，见上）**：`causeOf` 与 #54 的"取尾部且有界"仍是同一规则的两处实现；`store.js` 里"隔离留痕日志"与"写闸门日志"两套句式并存；`load()` 的 `catch` 分支文案仍依赖引擎原文（换 Node 版本或遇到 EBUSY 这类读错误时，类别词会消失——宜加显式标签"无法读取或解析:"）。
  - 本轮（#68）核准新增：**#69** `edge-agent` 漏配 `AI_BRIDGE_TOKEN` 时，`bridge:health` 会**静默**降级成 7 字段存活视图（运维无从归因），应启动自检并告警——属 `edge-agent.js` 面，另行派工；**#70** `?probe=1` 在仓内**零代码调用方**（只有两处文档提及），若确认无运维使用方，整段删除才是根除"签名放大器"面的正解，删除须与文档同批修订。
  - #47 之后核准新增：**#79** 幂等缓存的流式命中缺一个可注入假上游的接缝，导致它只能被单元级/结构级验证（同条含 `tool_calls` 与 `/v1/messages` Anthropic 两类未覆盖形状：前者当前被保守判为"不可回放"→逐出转发，行为安全但对流式请求放弃了缓存收益）。与 #49（HTTP 封装单点化）、#58（MCP 异步派发）同属"可测性与接缝"家族。
  - #45 之后核准新增：**#77** 形状①还有第三处写手 —— `server.js:2341` 一带的 Ollama/llama.cpp 路径把 `{prompt_tokens, completion_tokens, total_tokens}` 原样落库，我这条红锁 `L5` 的探针模式 ``usage: parsed.usage ||` 抓不到它（grep 型锁的固有盲区，应升级为"落库行键集合恰为 {input,output,total}"的行为锁）；同条还记 `token-stats.json` 这第五本账与 `estimateTokens(JSON.stringify(messages))` 把**整段对话历史**每轮重复计入 —— 生产实测 `total.input = 3,774,187,517`（15167 次调用），与 traffic/dispatches 口径不可比。另 **#76**：本轮 eslint `19→18` 的真相是我上一轮把 `K4` 写坏成 `K3b` 的副本后 `srvSrc` 成了未使用变量 —— 一条 warning 精确指出了我的一次破坏，锁数量对了但内容少一把，此后改锁定文件必须逐个点名断言，不能只看"N/N"。
  - #31 之后的卫生残项：生产数据目录里仍留着死账本文件 `traffic.jsonl`（1274 字节 / 4 行，自 07-26 起再无写入），
    本轮**只删代码不删用户数据**，文件处置随 #29 仓库卫生一并决定；`.gitignore` 里该规则成为无害遗留。
  - **#76** eslint warning 基线应随源码快照成锁：本轮实测 19→20→19 全靠人肉追数（删 `loadList` 减一条、
    留 `_locks` 孤儿多一条），差一步就被误判成"回退"或逼出"为凑数保留死码"。
  - #44 残项：`loadList` 未导出、全仓零调用方，本轮按规格给它加了与 `load` 同一把尺子的守卫，结果是"名叫 loadList 却拒绝顶层数组"——名实不符，正确解法是随 #31 一并删除，而非再加豁免。
  - 落盘与卫生：**#62** `store.js` 的 `recordTask` 是字段白名单，`requested/skipped/total` 进不了历史（#36 的诚实只在响应里，历史里仍丢失）、**#63** 测试残留清理不实（Windows 下 SQLite 句柄未关，`cleanup()` 删不净却打印"目录已清理"；且 `.bak-cleanup-*` 一类文件未被 `.gitignore` 覆盖，靠"用历史切分而非复制目录"来避免误发布）、**#61** 文档保真锁（env 表 / 套件计数 / 端点行号与源码同源，否则红灯——本轮 README 的 `45/184/374` 三处漂移就是它要治的病）。


## mitmproxy 流量监控（可选）

```bash
pip install mitmproxy
# 首次运行安装 CA 证书到受信任根证书
start-mitm.bat
```

## 进程守护（可选）

```bash
node watchdog.js    # 自动重启 + 熔断（连续崩溃5次停止）
```

## 文件结构

```
ai-bridge/
├── server.js              # HTTP 常驻服务 (40+ API 端点)
├── codely-client.js       # 团结 LiteLLM 客户端(凭据/签名/UA跟版/请求)
├── bridge-stdio.js        # MCP stdio 桥接器 (全量 15 个 MCP 工具;AI_BRIDGE_TOOLSET=lite 时 5 个)
├── tool-registry.js       # 配置驱动工具注册表
├── workspace-manager.js   # 工作区注册表（登记/受管/归档/租约）
├── routing-score.js       # 7维复合路由评分
├── tool-identity.js       # 工具身份归一化
├── observe.js             # 工具 baseUrl 接管
├── edge-agent.js          # 云端边缘代理
├── db.js                  # SQLite 全局数据库 (6 张表 + 用量报表)
├── store.js               # JSON 持久化 + 日志轮转
├── watchdog.js            # 进程守护
├── adapters/
│   ├── base.js            # 基类 + parsePath 引擎
│   ├── cli-adapter.js     # CLI 传输
│   └── http-adapter.js    # HTTP 传输
├── tools.json             # 工具配置
├── models.json            # 模型注册表
├── ui.html                # Web UI (8 Tab)
├── mitm-addon.py          # mitmproxy 流量捕获
├── start-mitm.bat         # mitmproxy 启动脚本
├── read-cred.ps1          # Windows 凭据读取（AgnesCode token）
├── start.bat              # 服务启动脚本
├── test-unit.mjs          # 单元测试 (43 用例)
├── test-workspace.mjs     # 工作区管理单元测试
└── test-e2e.mjs           # E2E 测试
```
