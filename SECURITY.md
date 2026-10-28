# Security Policy

## Threat model

AI Bridge is designed for a **single-user workstation**. It brokers access to AI coding
tools installed on that machine, so the assets worth protecting are:

1. the ability to execute local CLIs (arbitrary command execution by design),
2. captured traffic and logs, which may contain prompts, source code and credentials,
3. the shared token that identifies authorised callers.

## Design invariants

| Invariant | Where |
|---|---|
| Binds `127.0.0.1` by default (`AI_BRIDGE_HOST`) | `server.js` |
| Peer identity comes from the socket only — `req.socket.remoteAddress`, read at exactly one place | `isLoopbackPeer()` `server.js:1112` |
| Forwarded headers (`X-Forwarded-For`) are never trusted for auth decisions | same |
| Token comparison is constant-time, length checked before `crypto.timingSafeEqual` | `checkAuth()` `server.js:1123`-`1130` |
| Off-loopback callers cannot use the proxy without a configured token | `server.js:1195` |
| Runtime data (`logs.jsonl*`, `traffic.jsonl`, `memory.json`, `clients-acl.json`, `switches.json`, `token-stats.json`, `workspaces.json`, `.env`, `*.local`, `.local/`) is gitignored | `.gitignore` |
| SQL access uses bound parameters only; `limit` is clamped to `1..200` | `db.js` |

## Supported versions

| Version | Supported |
|---|---|
| 1.1.x | yes |
| < 1.1 | no |

## Reporting a vulnerability

Please **do not** open a public issue. Use GitHub's private vulnerability reporting on this
repository, or contact the maintainer directly. Include: affected version, minimal
reproduction, and whether the hub was reachable off-loopback at the time.

We aim to acknowledge reports within 5 working days.

## Hardening checklist for users

- Keep the default loopback bind unless you specifically need LAN access.
- If you expose it beyond loopback, **set `AI_BRIDGE_TOKEN`** — without it, non-loopback
  callers are refused for proxy routes but you lose caller attribution.
- Approve clients explicitly; do not leave registrations pending.
- Treat `traffic.jsonl` and `logs.jsonl` as sensitive: they can contain prompts and code.
