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
| `AI_BRIDGE_TOKEN` | 无 | 鉴权 token（不设则无鉴权）。**自 #42 起门覆盖 `/api/*` 与 `/v1/*`**（`server.js:1248`）：设了 token 后，用 OpenAI 兼容层的任何客户端都必须把 API key 配成同一个值（`Authorization: Bearer <AI_BRIDGE_TOKEN>`），否则一律 401；Web UI 会在首次 401 时提示输入一次并存入 localStorage（不设 token 时不会弹框）。**`GET /api/health` 自 #68 起按鉴权态给两种视图**：它在门之前处理（`server.js:1185`），无凭据只返回 `status/uptime/port/clients/activeDispatches/dispatchTotal/version` 七个存活与负载计数；`codely`（CLI 版本 / access_token 剩余天数）与 `usage`（今日 token / 预算）仅在带凭据时出现；`?probe=1` 无凭据一律 401 **且绝不发起任何上游请求**（`#68b2` 源码顺序锁死"判权必须先于探测"，防止"先探测后判权"这种照样返回 401 但上游已被打过的回潮）。不设 token 时 `checkAuth` 恒真 → 自用实例仍拿完整视图（零负担）。仍免凭据的只剩 `GET /`（UI 首页本身，无数据）与 health 的上述存活视图；另有 `/proxy/*` 免凭据透传（#64） |
| `AI_BRIDGE_CLIENT` | unknown | 作为 MCP 客户端时的身份名（**注意**：默认值是常量 `unknown`，同一宿主开多个会话会全部塌进同一个在册条目且复用是静默无日志的，见「已知问题」） |
| `AI_BRIDGE_EXECUTE_TIMEOUT` | 900000 | 中枢单次执行窗口(ms)：CLI 执行链与客户端反向执行都吃它。**桥侧 `AI_BRIDGE_HTTP_TIMEOUT` 必须 ≥ 本值 + 30000**，否则长任务会被桥早判死而中枢仍在执行（`test-audit-fixes` 段 F 锁死该数值关系） |
| `AI_BRIDGE_HTTP_TIMEOUT` | 960000 | 桥侧同步工具调用总预算(毫秒)，同时驱动 `httpPost` 默认值与 `callTool` 总超时；**未设时 GET/轮询仍为 30000ms 快速失败**（自愈节奏，有意不与 POST 同源抬高） |
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
node test-unit.mjs          # 48 项  纯单元测试（含 #47 SSE 回放合成器）
node test-workspace.mjs     # 44 项  工作区管理（独立临时数据目录 + 写失败注入）
node test-store-corrupt.mjs # 43 项  坏 JSON 与坏形状隔离/拒绝覆写 + 配置损坏只降级（子进程 + 隔离 DATA_DIR）
node test-audit-fixes.mjs   # 63 项  审计修复验收（含结构锁 E/F/G/H/I/J/K/L 段）
node test-external-fixes.mjs# 45 项  外部模型审计修复（端口 9811）
node test-e2e.mjs           # 203 项 全链路 E2E（主中枢 9810 + 假中枢 9813 + 黑洞 9814/9815 + 第二实例 9821/9827/9830 + 第四实例 9841 + 注册表接缝实例 9833/9834，均不影响生产）
npx eslint . --ext .js,.mjs # 0 error / 19 warning（warning 为既有基线；**必须在 ai-bridge/ 目录内跑**，仓根跑会命中指挥官未提交的 WIP 而报出上千条无关错误）
```

合计 **446 项**；`npm test` 只串了前四项，全量口径以六套件为准。合并纪律：**同一棵树连跑两轮同数全绿**才算过（编码手贴的输出不作数，指挥官亲跑才作数）。E2E 会自举隔离数据目录（`AI_BRIDGE_DATA_DIR`/`AI_BRIDGE_DB`/`AI_BRIDGE_WORKSPACE_ROOT` 全部指向套件自建的临时运行目录），不会写生产数据；测后自动清理并打印"生产数据未改写"（已知残留见 #63：Windows 下 SQLite 句柄未关，`test-runtime-data/` 可能留 `*.db-journal`）。


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
  - **鉴权覆盖面**：门同时覆盖 `/api/*` 与 `/v1/*`（`server.js:1248`），零凭据不再能枚举 `/v1/models`、也不再能走进 `model=<工具名>` 的真实执行支；Web UI 有自己的凭据注入点（`ui.html` 的 `withAuth()`，401 提示一次并至多重试一次），**设了 token 不再把自己的管理界面锁死**。
  - **免鉴权 health 视图（#68）**：`/api/health` 按鉴权态分视图——无凭据只剩存活与负载计数 7 个字段，`codely` token 期限与 `usage` 汇总须带凭据；`?probe=1` 无凭据一律 401 且绝不发起上游（此前零凭据即可驱使中枢带真实签名打 LiteLLM）。
  - **形状非法与解析失败同口径（#44）**：`switches/stats/memory/acl/workspaces` 五类文件里，"能解析但形状非法"（顶层是 null/数组/primitive、`tasks`/`meetings`/`allowlist` 等字段类型错）不再被"补成合法空结构"后覆写——与解析失败同走保全(改名 `.corrupt-*`)+置脏+拒写+不抛错。#52 当年只给了 `meetings` 一个点，本轮是同一把尺子。
  - **写被拒不再谎报成功（#43）**：`/api/toggle` 在开关未能持久化时返回 **503** 并明示 `persisted:false, runtimeOnly:true`，不再回 `200 {success:true}`（实测修复前：`switches.json` 已被隔离改名 `.corrupt-*`、磁盘上根本没有该文件，接口却宣称成功——重启后全部回启）。工作区删除改为**先落盘后回收**：注册表未能落盘就绝不碰目录（修复前实测：真实工作区已被 `rmSync` 删除，注册表却仍指向它，留下必然失败的悬空记录）；目录回收失败则回滚登记，回滚也失败才升级为"注册表与磁盘不一致，需人工核查"的 error 留痕。`create/archive/restore` 与 `remove` 共用同一入口区分**拒写（该 key 已隔离）**与**写入故障（抛异常）**两态，错误消息必须带底层原因（有界 200、截断时补回 `EISDIR/EPERM/ENOSPC` 这类错误码前缀）。
  - **用量报表不再恒 0（#45）**：`traffic.usage` 曾有三种形状各写一遍（上游原样 / 归一化 / 客户端上报），而 `db.js` 的报表与 `todayTokens()` 只 SUM `prompt_tokens`+`completion_tokens`。生产实测：最近 500 条里 usage 非空的 52 条**全是**归一化形状 → `/api/usage/report` 每行 `tokens:0`，带凭据 `/api/health` 的 `usage.todayTokens=0`，`AI_BRIDGE_DAILY_TOKEN_BUDGET` 预算告警因此**永不触发**（同库 `dispatches.tokens=638931`，账在、报表看不见）。现：`db.usageTokensSql()` 单点定义 `COALESCE(input, prompt_tokens, input_tokens, 0) + COALESCE(output, completion_tokens, output_tokens, 0)三处聚合共用；**取第一个非空键而非相加**（混合键名行实测 260 而非 520）。写侧两处入站反代不再把上游原样 usage 落库，改存 `{input,output,total}`，无 usage 写 `null`（不猜）；**对外响应体一个字节都没改**（落库发生在 `res.end(respData)` 之后）。
  - **`tools.json` 损坏不再拖垮进程（#46）**：加载器原先把 `JSON.parse` 放在 try 之外、又在模块加载期执行，配置坏掉 = `server.js` 一 require 就抛 = 进程起不来 = watchdog 重启到熔断。现分 `ok / missing / corrupt-parse / corrupt-shape` 四态：损坏时静态工具按空处理、**绝不抛**、照常加载自动同步工具，并把事实写进 `logs.jsonl`（error 级）与 stderr —— 消息含状态、原因、后果（"静态工具全部缺席"）、以及"原件未被改动需人工修复"四件事；诊断经 `getLoadDiagnostics()` 暴露（`file` 只给 basename）。**与数据文件的差别是刻意的**：`tools.json` 是 git 跟踪的配置原件，服务进程**不改名、不覆写、不隔离**它（P0 那套 `.corrupt-*` 只用于运行数据）。`missing`（文件不存在）是合法部署态，不写 error 级。
  - **幂等缓存的流式命中终于合法（#47）**：缓存只由非流式 200 响应写入，而 `cacheKey` 不含 `stream`，于是流式请求命中同一 key 时旧代码把 **JSON 原文**直接 `res.write()` 进 `text/event-stream` 响应 —— SSE 解析器丢弃所有非 `data:` 前缀的行，客户端拿到**空流**却被告知 `X-Cache: HIT`「成功」；文档与代码注释当时都写着「合成单块 SSE」，实现根本不合（现均已改为与实现一致）。新增零依赖纯函数 `sse-replay.js` 负责合成，命中分支三分支：非流式原样回放 / 流式可回放→合成 / 流式不可回放→逐出并转发上游。**能力边界如实说明**：这条链只做到单元级 + 结构锁级，**没有端到端证明**「流式命中→客户端真能解析」，因为缓存唯一写入口需要真凭据的 codely-http 上游（基址在不入库的 `codely-client.js` 里），测试不该联网也不该烧免费额度 —— 接缝缺口记 **#79**。
  - **注册表配置路径可注入（#80）**：`tools.json` 的载入路径原先硬编码在 `tool-registry.js:98`，测试无法在不碰生产配置的前提下把一个本地假 CLI 送进**真派发链路**——于是「CLI 侧到底收到什么任务文本」（#40）、「流式缓存命中的端到端形状」（#79）只能靠源码结构锁兜住，而结构锁已被 #74 证明会漏抓第二/第三写手。现 `AI_BRIDGE_TOOLS_PATH` 存在时按该文件装载（未设时逐字节不变，且刻意不用 `path.resolve('tools.json')` 防随 cwd 漂移），`/api/tools` 响应带 `registry: getLoadDiagnostics()` 让"到底读了哪个文件"可归因。附带立项 #81：`CliAdapter.detect()` 对绝对路径 `command` 恒判不可用（`where <绝对路径>` 退出码 2），而 `execute()` 走的 `resolveWindowsCommand` 却认它——跑得动却永不被派发。
- **未修（如实列示，按当前队列序）**：
  - #81 CLI 绝对路径可用位不对称：`detect()` 只查 `commandPaths` + `findInPath`（Windows `where <绝对路径>` 恒失败），而 `execute()` 的 `resolveWindowsCommand` 认绝对路径——同一份配置跑得动却永远不被派发，拒绝文案还是"未知工具/no_targets"（归因误导，#54 同族）
  - #57 桥默认身份是常量 `unknown`：`connectedClients` 以名字为键，同一宿主的多个派生会话必然塌进**一个**在册条目，共享 `pendingTask` 槽与能力字段；后启动会话的 `registerSeq` 基数天然更大，于是"后来者覆写全体能力"成为合法行为。且注册复用分支**静默无日志**，中枢也无 `hostCount`/poll 计数面——该缺陷目前**无法从可观测面证明有几个会话在共享身份**。
  - #58 MCP 面无异步派发：中枢支持 `body.async === true`，但 `dispatch` 工具没有 `async` 入参、也没有取回异步结果的工具，宿主只能吃同步窗口。
  - #60 失败判定器仍会被**短文本里的数字子串**误伤：`looksLikeError` 只要正文 ≤400 字符即返回 true，而关键词表含裸 `'401'/'402'/'429'`，于是"耗时 4021ms""见 `:398-401`"这类成功产出可能被记成失败（#37 只修了长文那一半）。
  - 其余：#40 恒假分支致 CLI 拿不到工作区简报、#51 工作区 path 无效时静默改建空目录、#26 吞异常门禁、#49 两个 HTTP 封装单点化（含负数 env 钳制：`parseInt(env) || 默认` 对负数不成立，而 Node 的 `setTimeout(<0)` 语义是"超时失效"）、#27/#28/#29 结构性重构、#55 北极星端到端验收、#32 HTTP 入口坏 JSON 伪装成参数缺失（本轮实测再现：非法 JSON 的 toggle 请求回的是 `400 缺少 tool 参数`，不是"body 解析失败"）、#33/#34 损坏与隔离状态上报到 `/api/health` 与 UI、#35 `tools.json` 模型漂移。
  - 鉴权面残项（#42/#68 之后仍然成立的口子）：**#64** `/proxy/*` 在鉴权门**之前**免凭据透传（与 `/v1` 同属"能执行能花钱"面，另含 `checkAuth` 非恒定时间比较）、**#65** `check-active.js`/`cleanup-stuck.js` 硬连生产 9800 却不带凭据（设 token 后必然 401，运维脚本自己失效）、**#66** 把 #42/#68 的一次性凭据取证 harness 固化成第 7 套常驻套件（防"第二个调用点漏网"复发；禁止"复制一份 JS 进测试"那种永远绿假锁）、**#67** UI 流式解析三缺陷（无跨块缓冲、`TextDecoder` 未开 `stream` 会碎中文、`catch(_){}` 静默吞）。
  - #43 之后核准新增：**#72** `beginRun` 是第 5 个丢弃 `saveState` 返回值的站点（隔离/写故障时租约与 `useCount` 静默漂移，本单规格明令不动）、**#73** key 被隔离期间对已知 id 的写/删返回 404「不存在」而非 5xx 降级（`store.load` 返回 `{}` 使记录不可见，与 #33/#34 同源）、**#74** `causeOf` 与 #54 的"取尾部且有界"是同一规则的两处实现，且 `REFUSED_CAUSE` 文案只写"解析损坏"、窄于 #44 之后"解析失败或形状非法"的事实。
  - 本轮（#68）核准新增：**#69** `edge-agent` 漏配 `AI_BRIDGE_TOKEN` 时，`bridge:health` 会**静默**降级成 7 字段存活视图（运维无从归因），应启动自检并告警——属 `edge-agent.js` 面，另行派工；**#70** `?probe=1` 在仓内**零代码调用方**（只有两处文档提及），若确认无运维使用方，整段删除才是根除"签名放大器"面的正解，删除须与文档同批修订。
  - #47 之后核准新增：**#79** 幂等缓存的流式命中缺一个可注入假上游的接缝，导致它只能被单元级/结构级验证（同条含 `tool_calls` 与 `/v1/messages` Anthropic 两类未覆盖形状：前者当前被保守判为"不可回放"→逐出转发，行为安全但对流式请求放弃了缓存收益）。与 #49（HTTP 封装单点化）、#58（MCP 异步派发）同属"可测性与接缝"家族。
  - #45 之后核准新增：**#77** 形状①还有第三处写手 —— `server.js:2209/2215` 的 Ollama/llama.cpp 路径把 `{prompt_tokens, completion_tokens, total_tokens}` 原样落库，我这条红锁 `L5` 的探针模式 ``usage: parsed.usage ||` 抓不到它（grep 型锁的固有盲区，应升级为"落库行键集合恰为 {input,output,total}"的行为锁）；同条还记 `token-stats.json` 这第五本账与 `estimateTokens(JSON.stringify(messages))` 把**整段对话历史**每轮重复计入 —— 生产实测 `total.input = 3,774,187,517`（15167 次调用），与 traffic/dispatches 口径不可比。另 **#76**：本轮 eslint `19→18` 的真相是我上一轮把 `K4` 写坏成 `K3b` 的副本后 `srvSrc` 成了未使用变量 —— 一条 warning 精确指出了我的一次破坏，锁数量对了但内容少一把，此后改锁定文件必须逐个点名断言，不能只看"N/N"。
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
