# AI Bridge

**Local-first MCP hub that turns the AI coding CLIs you already have into one dispatchable tool fleet.**

[![CI](https://github.com/qidiai/Ai-Bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/qidiai/Ai-Bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![MCP](https://img.shields.io/badge/MCP-16%20tools-blue)
![deps](https://img.shields.io/badge/dependencies-1%20(ws)-lightgrey)

AI Bridge is a resident HTTP service (default `127.0.0.1:9800`) that sits between your agent and the AI tools already installed on your machine. It registers external coding CLIs — Claude Code, OpenCode, Qoder, Atom Code, OpenClaw, WorkBuddy, Codely, Agnes MCP and more — as **dispatchable tools**, exposes them through a **16-tool MCP server**, and serves **OpenAI- and Anthropic-compatible endpoints** so existing clients can reach the same fleet unchanged.

Runtime footprint: **one dependency (`ws`)**, ~15,300 lines of JavaScript across 42 files, no build step.

---

## Why

| Problem | What AI Bridge does |
|---|---|
| Many heterogeneous AI CLIs, each with its own invocation shape | One registry + one `dispatch` verb, with auto-fallback across tools |
| Agents can't see what ran, what it cost, who called it | Traffic capture, token accounting, per-client ACL, structured logs |
| Parallel agent sessions trample each other's files | Per-task workspace isolation with create/list/restore |
| Cloud relays are a privacy and latency liability | Loopback-first: binds `127.0.0.1` by default, no cloud dependency |
| Clients speak different protocols | MCP (stdio bridge) + OpenAI `/v1/chat/completions` + Anthropic `/v1/messages` |

## Quick start

```bash
npm install          # installs the single dependency (ws)
node server.js       # listens on 127.0.0.1:9800
```

Point an MCP client at the stdio bridge:

```jsonc
// claude_desktop_config.json / .cursor/mcp.json
{ "mcpServers": { "ai-bridge": { "command": "node", "args": ["<repo>/bridge-stdio.js"] } } }
```

Health check:

```bash
curl http://127.0.0.1:9800/api/health
# {"status":"ok","uptime":…,"port":9800,"clients":…,"version":"1.1"}
```

Optional Windows service install: `install-service.ps1` / `install-service.bat` (node-windows or NSSM); `register-autostart.ps1` for logon start. Uninstall: `uninstall-service-nodewin.js`.

## MCP tools (16)

`bridge-stdio.js` exposes the hub to any MCP client:

| Tool | Purpose |
|---|---|
| `dispatch` | Send a task to one or more registered CLI tools (auto-fallback) |
| `task_status` | Poll an async task until a terminal state |
| `list_tools` / `toggle_tool` / `list_switches` | Inspect and switch the tool fleet on/off |
| `list_clients` / `manage_client` | Registry and ACL for calling agents (register/approve/deny/kick) |
| `handoff` | Transfer an in-flight task between tools |
| `discuss` | Multi-model discussion session (inject / interrupt / auto-stop) |
| `create_workspace` / `list_workspaces` | Isolated per-task working directories |
| `logs` | Structured event log query |
| `memory_search` / `memory_recent` | Cross-session memory retrieval |
| `token_stats` | Token accounting per tool/day |
| `recognize_image` | Vision pass-through to a local OCR/vision endpoint |

## HTTP surface

47 `/api/*` routes plus protocol-compatible endpoints. Grouped:

| Group | Routes |
|---|---|
| Health & metrics | `/api/health`, `/api/metrics`, `/api/stats`, `/api/db/stats`, `/api/insights` |
| Tool fleet | `/api/tools`, `/api/toggle`, `/api/discover-models`, `/api/models/sync`, `/api/refresh` |
| Dispatch & tasks | `/api/dispatch`, `/api/task/<id>`, `/api/result`, `/api/poll`, `/api/handoff` |
| Discussions | `/api/discuss`, `/api/discuss/status/<id>`, `/api/discuss/active`, `/api/discuss/inject`, `/api/discuss/interrupt`, `/api/meetings` |
| Memory | `/api/memory/search`, `/api/memory/recent`, `/api/memory/experience`, `/api/memory/stats` |
| Observation | `/api/observe/status`, `/api/observe/route`, `/api/observe/takeover`, `/api/observe/restore`, `/api/mitm/status` |
| Traffic & usage | `/api/traffic`, `/api/traffic/capture`, `/api/traffic/clear`, `/api/usage/report`, `/api/telemetry` |
| Clients & ACL | `/api/client/register`, `/api/client/unregister`, `/api/clients`, `/api/clients/approve`, `/api/clients/deny`, `/api/clients/kick` |
| Workspaces | `/api/workspaces`, `/api/workspaces/<id>` |
| Compatibility | `/v1/chat/completions`, `/v1/models`, `/v1/messages`, `/proxy/<source>/<key>/…` |

## Security model

Defaults are chosen for a single-user workstation; every claim below is backed by code:

- **Loopback by default.** `AI_BRIDGE_HOST` defaults to `127.0.0.1`. The peer check reads `req.socket.remoteAddress` at exactly one place — `isLoopbackPeer()` (`server.js:1112`) — so `/api/*`, `/v1/*` and `/proxy/*` cannot disagree about who is local.
- **Constant-time credential compare.** `checkAuth()` (`server.js:1123`) compares length first, then `crypto.timingSafeEqual`, avoiding the `RangeError` trap on unequal lengths.
- **Unauthenticated relaying is refused off-loopback.** The proxy gate is `isLoopbackPeer(req) || (!!CONFIG.AUTH_TOKEN && checkAuth(req))` (`server.js:1195`): with no token configured, non-loopback callers cannot turn the hub into an open LLM relay. Spoofed `X-Forwarded-For: 127.0.0.1` is ignored — only the socket peer counts.
- **Per-client ACL.** Callers register and must be approved; `deny` / `kick` revoke. Pending registrations are tracked separately from the active registry.
- **Runtime data never enters version control.** `.gitignore` excludes `logs.jsonl*`, `traffic.jsonl`, `token-stats.json`, `memory.json`, `switches.json`, `clients-acl.json`, `workspaces.json`, `.env`, `*.local`, and the locally-retained `codely-client.js`.
- See [SECURITY.md](./SECURITY.md) for the threat model and reporting channel.

## Configuration

32 environment variables, all optional. Grouped:

| Group | Variables |
|---|---|
| Network | `AI_BRIDGE_HOST`, `AI_BRIDGE_PORT`, `AI_BRIDGE_TOKEN`, `AI_BRIDGE_CORS`, `AI_BRIDGE_BASE_URL` |
| Storage | `AI_BRIDGE_DATA_DIR`, `AI_BRIDGE_DB`, `AI_BRIDGE_OBSERVE_DIR`, `AI_BRIDGE_WORKSPACE_ROOT`, `AI_BRIDGE_TOOLS_PATH` |
| Dispatch | `AI_BRIDGE_MAX_CONCURRENT_DISPATCH`, `AI_BRIDGE_EXECUTE_TIMEOUT`, `AI_BRIDGE_HTTP_TIMEOUT`, `AI_BRIDGE_PROXY_TIMEOUT`, `AI_BRIDGE_CAP_EXEC`, `AI_BRIDGE_TOOLSET`, `AI_BRIDGE_RESULT_MAX_CHARS` |
| Clients | `AI_BRIDGE_CLIENT`, `AI_BRIDGE_CLIENT_TTL` |
| Discussions | `AI_BRIDGE_MEETING_MAX_MS`, `AI_BRIDGE_MEETING_MAX_TOKENS` |
| Sampling & cache | `AI_BRIDGE_SAMPLING_MAX_TOKENS`, `AI_BRIDGE_SAMPLING_TIMEOUT`, `AI_BRIDGE_CACHE_TTL`, `AI_BRIDGE_CACHE_MAX`, `AI_BRIDGE_DAILY_TOKEN_BUDGET` |
| Upstream & vision | `AI_BRIDGE_LOCAL_URL`, `AI_BRIDGE_CLOUD_URL`, `AI_BRIDGE_OLLAMA_BASE`, `AI_BRIDGE_VISION_HOST`, `AI_BRIDGE_VISION_PORT`, `AI_BRIDGE_VISION_MODEL` |

## Testing

Eight `.mjs` suites plus legacy `.js` suites:

```bash
npm test        # test-unit + test-workspace + test-store-corrupt + test-e2e
npm run lint    # eslint over .js and .mjs
```

| Suite | Covers |
|---|---|
| `test-unit.mjs` | Core units, tool registry, routing score |
| `test-workspace.mjs` | Workspace isolation, create/list/restore |
| `test-store-corrupt.mjs` | Persistence under corrupted/partial state |
| `test-e2e.mjs` | End-to-end dispatch against a hub instance |
| `test-external-fixes.mjs` | Off-loopback auth and proxy gating |
| `test-audit-fixes.mjs` | Regression locks for audited defects |
| `test-progress-watch.mjs` | Async task progress states |
| `test-ledger-hygiene.mjs` | Internal bookkeeping freshness (optional) |

> ⚠️ `test-e2e.mjs` binds a **fixed port**. Do not run the suite while a production hub is listening on it.

CI runs lint and the test suites on push and pull request: [`.github/workflows/ci.yml`](./.github/workflows/ci.yml).

## Extending

Tool adapters live in `adapters/`:

| File | Role |
|---|---|
| `base.js` | Adapter contract (detect / execute / normalize) |
| `cli-adapter.js` | Spawn a local CLI, capture stdout, normalize the result |
| `http-adapter.js` | Call an HTTP tool endpoint |

Adding a tool = one adapter module + a `tools.json` entry (`id`, `name`, `command`/`commandPaths`, `enabled`, `available`).

## Limitations and non-goals

- **Windows-first packaging.** Service install scripts target node-windows/NSSM; on Linux/macOS run `node server.js` under your own supervisor.
- **Compatibility shim, not a full API.** `/v1/*` covers chat completions, model listing and Anthropic messages — enough for clients and tests, not every upstream feature.
- **Ships no models.** AI Bridge orchestrates tools you already have; it does not host weights.
- **Single-user by design.** The ACL separates callers, but there is no multi-tenant quota or billing layer.

## Related

- **[QiDi-Agent](https://github.com/qidiai/QiDi-Agent)** — the orchestration framework (task splitting, interface contracts, three-layer quality checks, multi-path merge) this hub was extracted from. AI Bridge is the runtime; QiDi-Agent is the framework layer.

## License

MIT © Qidi AI — see [LICENSE](./LICENSE).

---

<details>
<summary><b>中文摘要</b></summary>

AI Bridge 是一个常驻本机 HTTP 服务（默认 `127.0.0.1:9800`）的 **MCP 中枢**：把你机器上已装的各种 AI 编程 CLI（Claude Code、OpenCode、Qoder、Atom Code、OpenClaw、WorkBuddy、Codely、Agnes MCP 等）注册成**可派发的工具**，通过 **16 个 MCP 工具**暴露给任意 MCP 客户端，同时提供 **OpenAI / Anthropic 兼容端点**，让现有客户端不改代码就能调用同一批工具。

特点：**依赖只有一个 `ws`**、约 15,300 行 JS、无需构建；默认只绑回环、凭据恒定时间比较、非回环无凭据拒绝透传；带流量留痕、token 记账、客户端 ACL、按任务隔离工作区、多模型讨论会话（可注入/中断/自动止损）。

它是 [QiDi-Agent](https://github.com/qidiai/QiDi-Agent) 框架拆出来的**运行时层**：QiDi-Agent 负责任务拆分、接口契约、三层质检与多路合并，AI Bridge 负责把这些能力变成可被任意 Agent 调用的服务。

</details>
