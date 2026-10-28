# Architecture

AI Bridge is a single-process Node.js service plus a stdio MCP bridge. There is no build step and one runtime dependency (`ws`).

```
                        ┌──────────────────────────────────────────────┐
   MCP client           │                  server.js                   │
 (Claude Desktop,       │  HTTP 127.0.0.1:9800                         │
  Cursor, agents)       │                                              │
      │ stdio           │  ┌────────────┐   ┌───────────────────────┐  │
      ▼                 │  │ auth gate  │──▶│ 47 /api/* routes      │  │
 bridge-stdio.js ──────▶│  │ loopback + │   │ + /v1/* + /proxy/*    │  │
                        │  │ token      │   └──────────┬────────────┘  │
  OpenAI / Anthropic    │  └────────────┘              │               │
  compatible clients ──▶│                    ┌─────────▼──────────┐    │
                        │                    │  tool-registry.js  │    │
  Web UI (ui.html) ────▶│                    │  tool-identity.js  │    │
                        │                    │  routing-score.js  │    │
                        │                    └─────────┬──────────┘    │
                        │              ┌───────────────┼─────────────┐ │
                        │              ▼               ▼             ▼ │
                        │      adapters/cli     adapters/http   observe │
                        └──────────────┬───────────────┬─────────────┬─┘
                                       ▼               ▼             ▼
                              local AI CLIs     HTTP tools     mitm-addon.py
                                       │
                        ┌──────────────▼───────────────────────────────┐
                        │ store.js (JSON) · db.js (SQLite) ·           │
                        │ workspace-manager.js · usage-reporter.js     │
                        └──────────────────────────────────────────────┘
```

## Code size (measured, not estimated)

| Layer | Files | Lines |
|---|---|---|
| Production code (incl. `ui.html`) | 25 | **8,257** |
| Test code (`test-*`, `verify-real-task`, `watch-agent-progress`) | 17 | **7,409** |
| Internal guard scripts (`check-*`) | 3 | 550 |
| **Total** | **45** | **16,216** |

Test-to-production ratio ≈ **0.9 : 1**. `server.js` alone is 3,015 lines; the largest suite, `test-e2e.mjs`, is 2,107 lines.

## Components

| Module | Lines | Responsibility |
|---|---|---|
| `server.js` | 3,015 | HTTP service: auth gate, 47 `/api/*` routes, `/v1/*` + `/proxy/*` compatibility, dispatch orchestration, discussion sessions, SSE |
| `bridge-stdio.js` | 1,150 | MCP stdio bridge — exposes the hub as 16 MCP tools to any MCP client |
| `ui.html` | 676 | Single-file web console (no framework, no build) |
| `store.js` | 545 | JSON-file persistence (atomic write, corrupt-state recovery) |
| `workspace-manager.js` | 429 | Per-task workspace isolation: create / list / restore |
| `db.js` | 409 | SQLite-backed event and traffic store, parameter-bound queries |
| `edge-agent.js` | 283 | Remote/edge agent runner (register, poll, execute) |
| `qidi-sync.js` | 217 | Sync of tool/model state with the QiDi-Agent framework layer |
| `routing-score.js` | 211 | Scoring used to pick or order tools for a dispatch |
| `tool-registry.js` | 189 | Registry of dispatchable tools from `tools.json` (12 entries) |
| `observe.js` | 170 | Observation/takeover of an in-flight run (status, route, restore) |
| `kimi-models.js` | 148 | Model catalogue helper for one upstream family |
| `tool-identity.js` | 112 | Stable tool identity resolution (alias → canonical id) |
| `sse-replay.js` | 89 | Replay of captured SSE streams |
| `watchdog.js` | 80 | Liveness watchdog for spawned tool processes |
| `env-int.js` | 61 | Typed integer environment parsing (single source for numeric config) |
| `output-cleaner.js` | 52 | Normalisation of tool stdout before it reaches callers |
| `usage-reporter.js` | 45 | Token usage accounting for the CLI ⇄ hub agreement |
| `cause.js` | 38 | Error-cause summarisation (single call site by design) |
| `adapters/base.js`, `cli-adapter.js`, `http-adapter.js` | — | Adapter contract + the two adapter kinds (spawn a CLI, call HTTP) |
| `mitm-addon.py` | 157 | Optional mitmproxy add-on for capturing upstream traffic |
| `ocr.py` | 41 | Optional local OCR helper behind `recognize_image` |
| `install-service*.js/.ps1/.bat`, `register-autostart.ps1`, `start-*.ps1/.bat`, `read-cred.ps1`, `cleanup-stuck.js`, `check-active.js` | — | Windows service packaging, autostart, and small operational helpers |

## Data flow: one dispatch

1. **Authenticate.** `isLoopbackPeer(req)` (`server.js:1112`) reads `req.socket.remoteAddress` — the only place peer identity is derived. `checkAuth(req)` (`server.js:1130`) compares length first, then `crypto.timingSafeEqual`.
2. **Resolve the caller.** Registered clients are matched against the ACL; unapproved clients are queued, not served.
3. **Select tools.** `tool-registry.js` loads `tools.json`; `tool-identity.js` canonicalises aliases; `routing-score.js` orders candidates. Auto-fallback walks the list until one succeeds.
4. **Isolate the workspace.** `workspace-manager.js` creates a per-task directory so concurrent sessions cannot trample each other.
5. **Execute.** `adapters/cli-adapter.js` spawns the CLI (with `watchdog.js` supervising) or `adapters/http-adapter.js` calls an HTTP tool. `output-cleaner.js` normalises stdout.
6. **Record.** Traffic, tokens and events are written through `store.js` / `db.js` / `usage-reporter.js`; `logs.jsonl` and `traffic.jsonl` are gitignored.
7. **Return.** Synchronously, or asynchronously via `/api/task/<id>` and the MCP `task_status` tool. Terminal states are explicit; a missing record is reported as a storage failure, not as "no such task".

## Discussions (multi-model sessions)

`/api/discuss*` runs a bounded multi-model conversation: participants, per-meeting token and wall-clock caps (`AI_BRIDGE_MEETING_MAX_*`), external injection (`/inject`), cooperative interruption (`/interrupt`), and an auto-stop path. Auto-stop events are persisted as first-class records so a stopped session is distinguishable from a vanished one.

## Persistence

| Store | Backend | Contents |
|---|---|---|
| `store.js` | JSON files (atomic replace) | meetings, messages, workspaces, switches, client ACL |
| `db.js` | SQLite | events, traffic rows; every value bound as a parameter, `limit` clamped to `1..200` |
| `logs.jsonl` / `traffic.jsonl` | append-only files | operational logs and captured traffic (gitignored) |

Corrupt or partially-written state is a tested path, not an assumption: `test-store-corrupt.mjs` (774 lines) covers truncated JSON, missing files and concurrent writers.

## Security model

See [SECURITY.md](./SECURITY.md) for the threat model. Design invariants:

- **One peer-identity read point.** Every gate (`/api/*`, `/v1/*`, `/proxy/*`) calls the same `isLoopbackPeer`; headers such as `X-Forwarded-For` are never trusted.
- **No unauthenticated relay off-loopback.** The proxy gate is `isLoopbackPeer(req) || (!!CONFIG.AUTH_TOKEN && checkAuth(req))` (`server.js:1195`).
- **Constant-time comparison** for the shared token, with the length check before `timingSafeEqual`.
- **Data at rest stays out of git** — runtime files are gitignored by default.

## Testing strategy

| Suite | Lines | Focus |
|---|---|---|
| `test-e2e.mjs` | 2,107 | End-to-end dispatch against a hub instance (binds a fixed port) |
| `test-audit-fixes.mjs` | 1,584 | Regression locks for previously audited defects |
| `test-store-corrupt.mjs` | 774 | Persistence under corrupt/partial state |
| `test-workspace.mjs` | 563 | Workspace isolation and restore |
| `test-external-fixes.mjs` | 507 | Off-loopback auth, proxy gating, health visibility |
| `verify-real-task.mjs` | 398 | Real-task verification harness |
| `watch-agent-progress.mjs` | 309 | Async progress state machine |
| `test-unit.mjs` | 304 | Units: registry, routing score, env parsing |
| `test-ledger-hygiene.mjs` | 238 | Internal bookkeeping freshness (optional) |
| `test-progress-watch.mjs` | 216 | Progress terminal states |
| legacy `test-*.js` | 417 | Earlier HTTP/discuss smoke suites |

`npm test` runs `test-unit` + `test-workspace` + `test-store-corrupt` + `test-e2e`. CI (`.github/workflows/ci.yml`) runs lint and the suites on an isolated runner.

> ⚠️ `test-e2e.mjs` binds a fixed port; do not run the suite while a production hub is listening on it.

## Non-goals

- **Not a model host.** No weights, no inference kernels — it orchestrates tools that already exist on the machine.
- **Not multi-tenant.** The ACL separates callers on one workstation; there is no per-tenant quota or billing.
- **Not a full OpenAI implementation.** `/v1/*` is a compatibility shim covering chat completions, model listing and Anthropic messages.
- **Not cross-platform packaging.** Service install targets Windows (node-windows/NSSM); elsewhere run `node server.js` under your own supervisor.

## Relationship to QiDi-Agent

AI Bridge was extracted from [QiDi-Agent](https://github.com/qidiai/QiDi-Agent). QiDi-Agent owns the framework layer — task splitting, interface contracts, three-layer quality checks, contract assembly, multi-path merge — and exposes it as an MCP server (`src/mcp/MCPServer.js`, 8 tools). AI Bridge owns the runtime: tool registration, dispatch, ACL, workspaces, persistence and protocol compatibility. `qidi-sync.js` keeps the two layers' tool and model state consistent.
