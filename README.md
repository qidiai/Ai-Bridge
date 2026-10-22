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
| `AI_BRIDGE_TOKEN` | 无 | API 鉴权 token（不设则无鉴权） |
| `AI_BRIDGE_CLIENT` | unknown | 作为 MCP 客户端时的身份名 |
| `AI_BRIDGE_EXECUTE_TIMEOUT` | 900000 | 单次执行超时(ms) |
| `AI_BRIDGE_HTTP_TIMEOUT` | 960000 | 桥侧同步工具调用总预算(毫秒)，必须 ≥ 中枢 `AI_BRIDGE_EXECUTE_TIMEOUT`(桥先判死=误报失败+脏台账)；GET/轮询在未设该 env 时仍为 30000ms 快速失败(自愈节奏) |
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
- **幂等缓存**：非流式 200 响应按 sha256(model+messages+参数) 缓存，命中直接回放（`X-Cache: HIT`）
- **上游健康探测**：`GET /api/health?probe=1` 带签名实测 LiteLLM 连通性
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
node test-unit.mjs       # 纯单元测试
node test-workspace.mjs  # 工作区管理单元测试（独立临时数据目录）
node test-e2e.mjs        # 全链路 E2E（使用端口 9810，不影响生产）
```

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
- `TEST-LOCK.json`：仓库测试锁定机制，用于检测测试文件漂移，哈希由指挥官每次合并后重算。

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
