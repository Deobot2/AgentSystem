# Mission Control — Always-On Remote Session Dispatch

**Status:** Architecture + Specification (pre-implementation)  
**Issues:** #82–#88  
**Last Updated:** 2026-06-30  
**Owner:** Leo (infra), Friday (oversight)

---

## Overview

Mission Control transforms the Ubuntu mini-PC into a persistent, remote-accessible session broker. Engineers can spawn new Claude Code or Antigravity (`agy`) sessions from a phone/browser without SSH, pick a harness (Claude API subscription tier or Google AI), select a repo from an allowlist, and stream logs in real time.

### Goals

- **Remote spawn without SSH:** Dispatch sessions to the mini-PC via secure HTTP webhook.
- **Multi-harness support:** Claude Code (subscription-based) OR Antigravity CLI (Google AI Pro / API fallback).
- **Unified session fleet:** See all running sessions (Claude + agy) in one place; cost tracking per session.
- **Persistent storage:** Session state survives PC reboot (systemd `Restart=always`).
- **Repo isolation:** Allowlisted repos only; no arbitrary filesystem access.
- **External integrations:** MCP servers (e.g., GitHub, Stripe, etc.) as first-class extensibility.

### Non-Goals

- Replace Claude.ai remote control (ATTACH-ONLY mode) — Mission Control is complementary, not a replacement.
- Real-time terminal emulation — log streaming only; for interactive use, use remote control or SSH.
- API-based billing — subscription (Claude Max, Google AI Pro) or headless console usage only. No token accounting via Mission Control.

---

## Remote Control vs. Mission Control Complementarity

Mission Control and Claude.ai remote control serve different needs and work together:

| Aspect | Remote Control | Mission Control |
|--------|---|---|
| **Invocation** | Attach to running session | Spawn new session |
| **Transport** | Anthropic-managed OAuth → claude.ai | HTTP webhook (TLS over Tailscale / LAN) |
| **Auth** | Anthropic account + device trust | Static key at `~/.claude/remote-webhook.key` |
| **Harness** | Claude Code only | Claude Code + Antigravity CLI |
| **Repo picker** | None — drives cwd of running session | Yes — select from allowlist |
| **Terminal fidelity** | Full (stdin/stdout/stderr, colors, prompts) | Logs only (JSON or plain text) |
| **Workflow** | Deep interactive driving | Quick dispatch + background monitoring |
| **Setup** | Zero — built-in to claude.ai | One-time webhook service install |

**Key principle:** Sessions spawned by Mission Control auto-register to claude.ai and are immediately drivable via remote control. This is intentional — MC handles the *spawn* layer; RC handles the *interactive* layer.

---

## Architecture

### High-Level Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                      PHONE / BROWSER                             │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Mission Control FE                                       │   │
│  │  (React SPA / HTML form)                                 │   │
│  │                                                           │   │
│  │  [Repo] [Harness] [Prompt] [Submit]                      │   │
│  │                                                           │   │
│  │  Session List (live cost)                                │   │
│  └────────────────────────┬─────────────────────────────────┘   │
└─────────────────────────────┼────────────────────────────────────┘
                              │
                              │ HTTPS (TLS + API key auth)
                              ↓
┌──────────────────────────────────────────────────────────────────┐
│              UBUNTU MINI-PC (Mission Control Host)               │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Webhook Service (Node.js / claude-webhook.service)        │ │
│  │                                                            │ │
│  │  POST /run                                                 │ │
│  │    { harness, prompt, repo, agent?, model? }             │ │
│  │  GET  /repos — return allowlist                           │ │
│  │  GET  /sessions — return fleet (claude + agy)            │ │
│  │  GET  /health — service status + daemon state            │ │
│  │  GET  /log/<session-id> — stream logs                     │ │
│  │  GET  /cost — today's spend (claude sessions only)        │ │
│  │  POST /github — GitHub webhook receiver (routines)        │ │
│  └────────────────────────┬─────────────────────────────────┘ │
│                           │                                     │
│        ┌──────────────────┼──────────────────┐                 │
│        ↓                  ↓                  ↓                  │
│  ┌───────────┐      ┌────────────┐     ┌──────────┐            │
│  │ Harness   │      │ Harness    │     │Session   │            │
│  │Dispatcher │      │Dispatcher  │     │Registry  │            │
│  │(claude)   │      │(agy)       │     │JSON      │            │
│  └─────┬─────┘      └──────┬─────┘     └──────────┘            │
│        │                   │                                     │
│        ↓                   ↓                                     │
│  ┌──────────────┐  ┌──────────────┐                            │
│  │claude --bg   │  │agy --continue│  ┌─────────────────────┐   │
│  │--agent X     │  │--model Y     │  │ Systemd daemon      │   │
│  │              │  │--add-dir     │  │ (auto-restart)      │   │
│  │Session logs: │  │              │  │ Logs → Journal      │   │
│  │${HOME}/...   │  │Session logs: │  │ Persistence:        │   │
│  │or JSON sink  │  │~/.gemini/... │  │ Restart=always      │   │
│  └──────────────┘  └──────────────┘  └─────────────────────┘   │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Repo Allowlist (known-repos.json + validation)           │ │
│  │ { agentsystem, arborgenie-website, genie, ... }          │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ MCP Servers (external integrations)                        │ │
│  │ { github, stripe, slack, linear, ... }                    │ │
│  └────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### Component Descriptions

#### Webhook Service (`claude-webhook.service`)

**Status:** Currently ACTIVE, listening on `0.0.0.0:8765`.

Node.js HTTP server (single process, no load balancing required — mini-PC context). Auth via static API key. Endpoints documented in "HTTP API Contract" below.

**Key behavior:**
- Validates incoming request (signature, API key, repo whitelist).
- Checks system availability (harness not already in use, adequate CPU/memory).
- Dispatches to appropriate harness (Claude Code or agy).
- Stores session metadata in registry; returns session ID to caller.
- Streams logs from spawned process back via HTTP chunked encoding or SSE.

#### Harness Dispatcher (Claude Code)

**Invocation:** `claude -p "<prompt>" --agent <agent-name> --bg` (daemon-managed background session).

**Spec:**
- Persistent: daemon keeps session alive across interrupts.
- Cwd: selected from repo allowlist (validated by webhook).
- Model override: `--model` flag (if provided by FE).
- Agent override: `--agent` flag (if provided by FE).
- Logs: written to stderr and captured by systemd journal; also collected by webhook service.

**Resume:** Not applicable for Claude Code — each `--bg` spawn is independent.

#### Harness Dispatcher (Antigravity CLI / `agy`)

**Invocation:** `agy -p "<prompt>" --add-dir <repo> --model <model> [--continue <session-id>]` (headless mode).

**Spec:**
- Headless: `agy` runs without prompts (docs: `--dangerously-skip-permissions` assumed safe in MC context).
- Session storage: `~/.gemini/antigravity-cli/brain/` (conversation history + state).
- Resume: `--continue <id>` resumes conversation from `last_conversations.json` lookup.
- Model selection: `--model` (Google AI, Gemini, or local fallback per user's API keys).
- Logs: written to stdout/stderr; webhook captures and stores.

**OPEN QUESTION:** agy has no documented `--bg` flag. Persistence pattern is TBD:
- Option A: Wrapper script with `tmux` or `nohup` + `stdout` redirection.
- Option B: Accept that agy is single-shot; encourage `--continue` for multi-turn.
- Option C: Patch `agy` to support `--bg` (requires agy maintainer coordination).

Currently recommend **Option A** for MVP (tmux-wrapped, signal handling for cleanup).

#### Session Registry

**Location:** In-memory during operation; persisted to `~/.claude/mission-control-registry.json`.

**Format:**
```json
{
  "sessions": [
    {
      "id": "claude-abc123",
      "harness": "claude",
      "agent": "friday",
      "model": "claude-sonnet-4-6",
      "repo": "agentsystem",
      "prompt": "audit auth flow",
      "spawnedAt": "2026-06-30T14:22:00Z",
      "exitedAt": null,
      "status": "running",
      "logPath": "/home/natha/.claude/logs/abc123.jsonl",
      "costEstimate": 0.042,
      "exitCode": null
    },
    {
      "id": "agy-def456",
      "harness": "agy",
      "model": "gemini-2.0",
      "repo": "genie",
      "prompt": "schema review",
      "spawnedAt": "2026-06-30T14:15:00Z",
      "exitedAt": null,
      "status": "running",
      "logPath": "~/.gemini/antigravity-cli/history.jsonl",
      "costEstimate": null,
      "exitCode": null
    }
  ]
}
```

**Durability:** Persisted on spawn, on status change, and on process exit (via systemd unit hook or polling).

#### Repo Allowlist

**Source:** `~/agent-memory/nexus/known-repos.json` (shared across Claude Code and Gemini/Antigravity).

**Validation:**
- Webhook validates every repo against this list before dispatch.
- Blocks absolute paths (no `/tmp`, no `../`, no symlink escapes).
- Returns 403 if repo not in allowlist.

**Example:**
```json
{
  "repos": [
    { "slug": "agentsystem", "path": "/home/natha/dev/AgentSystem", "env": "prod", "description": "Agent fleet dispatcher" },
    { "slug": "arborgenie-website", "path": "/home/natha/dev/arborgenie-website", "env": "prod", "description": "Public website" },
    { "slug": "genie", "path": "/home/natha/dev/genie", "env": "dev", "description": "Embedded agent lib" },
    { "slug": "basely", "path": "/home/natha/dev/basely", "env": "dev", "description": "SQL DB formatter" }
  ]
}
```

#### MCP Servers (External Integrations)

MCP servers are configured per harness (Claude Code or agy). Mission Control does not manage MCP lifecycle — that's handled by the harness itself via `.mcp.json` or env vars.

**For Claude Code:**
- MCP servers listed in `~/.claude/mcp.json`.
- Webhook service checks that requested MCP servers are safe in the given repo context.
- No restriction — MC trusts the harness config.

**For agy:**
- MCP servers configured via `~/.gemini/antigravity-cli/mcp.json` (if supported) or pass-through.
- Same trust model.

**Security note:** `--dangerously-skip-permissions` is allowed in MC context because:
1. Spawned only from authenticated webhook.
2. Repo and agent are allowlisted.
3. Session logs are preserved for audit.
4. PC is on private network (Tailscale or LAN).

---

## HTTP API Contract

### Authentication

All endpoints require an `Authorization: Bearer <key>` header where `<key>` matches `~/.claude/remote-webhook.key`.

Fallback for mobile: URL param `?key=<key>` (less secure; use header in production).

### Endpoints

#### `POST /run`

Spawn a new session.

**Request:**
```json
{
  "harness": "claude",
  "prompt": "review the auth middleware",
  "repo": "agentsystem",
  "agent": "friday",
  "model": "claude-sonnet-4-6"
}
```

**Fields:**
- `harness` (required): `"claude"` or `"agy"`
- `prompt` (required): Task description.
- `repo` (required): Slug from allowlist (e.g., `"agentsystem"`).
- `agent` (optional): Agent name; ignored if `harness: "agy"`.
- `model` (optional): Override default model.

**Response (202 Accepted):**
```json
{
  "id": "claude-xyz789",
  "harness": "claude",
  "repo": "agentsystem",
  "status": "spawning",
  "logUrl": "http://localhost:8765/log/claude-xyz789?key=...",
  "costUrl": "http://localhost:8765/cost",
  "registerAt": "2026-06-30T14:22:00Z"
}
```

**Errors:**
- `400 Bad Request`: Missing required fields or invalid JSON.
- `403 Forbidden`: Repo not in allowlist, or auth key invalid.
- `409 Conflict`: Harness at capacity — `MC_MAX_PER_HARNESS` concurrent sessions (default 4).
- `500 Internal Server Error`: Dispatch failed (logs in service stderr).

#### `POST /swarm`

Spawn several sessions in one call: `{harness, repo, model?, tasks: [{agent, prompt, repo?, model?}]}`,
max 20 tasks. Each task runs the same validation and cap check as one `/run`. Returns `202` with
`{requested, dispatched: [...], rejected: [...], cap}` when anything launched, `409` when the whole
batch bounced. See `tools/mission-control/README.md` for the response shape.

#### `GET /skills`

`{skills, commands, agents}` — installed skills (`~/.claude/skills`, plugin marketplaces), slash
commands, and the agent roster. The panel renders these as chips that prefix the prompt with
`/<name>`, which is how a dispatched `claude -p` session invokes either one.

#### `GET /ops` and `POST /ops/run`

Allowlisted maintenance operations (routines, Life OS doctor, human-needed alerts, brain sync,
agent/hook drift checks, session cost, graph query). `POST /ops/run` takes `{id, arg?}` and returns
`{exitCode, ms, command, output}`. Strict registry, pattern-validated argument, no shell.

#### `GET /sessions`

List all sessions (running + exited in last 24h).

**Response:**
```json
{
  "sessions": [
    {
      "id": "claude-abc123",
      "harness": "claude",
      "repo": "agentsystem",
      "agent": "friday",
      "status": "running",
      "spawnedAt": "2026-06-30T14:22:00Z",
      "exitedAt": null,
      "costEstimate": 0.042
    },
    {
      "id": "agy-def456",
      "harness": "agy",
      "repo": "genie",
      "status": "exited",
      "spawnedAt": "2026-06-30T14:15:00Z",
      "exitedAt": "2026-06-30T14:45:00Z",
      "costEstimate": null
    }
  ]
}
```

#### `GET /repos`

List allowlisted repos.

**Response:**
```json
{
  "repos": [
    { "slug": "agentsystem", "path": "/home/natha/dev/AgentSystem", "env": "prod" },
    { "slug": "arborgenie-website", "path": "/home/natha/dev/arborgenie-website", "env": "prod" },
    { "slug": "genie", "path": "/home/natha/dev/genie", "env": "dev" },
    { "slug": "basely", "path": "/home/natha/dev/basely", "env": "dev" }
  ]
}
```

#### `GET /log/<session-id>`

Stream logs from a session.

**Query params:**
- `?format=json` (default) — JSONL (one event per line).
- `?format=text` — Plain text (ansi colors preserved).
- `?follow=true` — Keep connection open and stream new logs (like `tail -f`).

**Response:** 200 OK, `Content-Type: application/x-ndjson` or `text/plain`. Chunked transfer encoding if `follow=true`.

**Example (text):**
```
[14:22:01] Spawning claude --agent friday --bg
[14:22:05] Session running (PID 12345)
[14:22:10] > Analyzing auth middleware...
...
```

#### `GET /health`

Service status and diagnostics.

**Response:**
```json
{
  "ok": true,
  "webhookService": "active",
  "claudeDaemon": "active",
  "daemonStatus": "running",
  "uptime": "3 days, 2 hours",
  "sessionsRunning": 1,
  "sessionsToday": 12,
  "costToday": 1.24,
  "nextBootstrap": "2026-07-15T00:00:00Z"
}
```

#### `GET /cost`

Cost summary (Claude sessions only).

**Query params:**
- `?period=today` (default) — Today's cumulative spend.
- `?period=week` — Last 7 days.
- `?period=month` — Last 30 days.

**Response:**
```json
{
  "period": "today",
  "total": 1.24,
  "sessions": [
    { "id": "claude-abc123", "spent": 0.67 },
    { "id": "claude-def456", "spent": 0.57 }
  ]
}
```

#### `POST /github` (optional)

GitHub webhook receiver (routes events to agent-dispatch via routines engine).

See `.github/workflows/agent-dispatch.yml` for upstream integration. Signature validation via `GITHUB_WEBHOOK_SECRET` env.

---

## Harness Dispatch Matrix

| Harness | Spawn Command | Persistence | Resume | Log Source | Registry Hook |
|---------|---|---|---|---|---|
| **Claude Code** | `claude -p "<prompt>" --agent <agent> --bg` | `claude-daemon.service` (systemd) | N/A (new session each time) | stderr + systemd journal | Webhook polls `/proc` and journal |
| **Antigravity CLI** | `agy -p "<prompt>" --add-dir <repo> --model <model> [--continue <id>]` | TBD (see open questions) | `--continue <id>` (resumes from history) | stdout/stderr → webhook sink | Webhook manages history.jsonl lookup |

---

## Security Model

### Authentication & Authorization

**Webhook key:** Single static key at `~/.claude/remote-webhook.key` (256+ bits, random, never committed).

**Best practice:** Rotate key annually; store in password manager or 1Password vault.

**Binding interface:** Currently `0.0.0.0:8765` (accepts external connections). For production:

1. **Tailscale VPN:** Bind to Tailscale interface only (e.g., `--tailscale-only` flag or `listen 100.x.x.x:8765`).
2. **TLS enforcement:** Webhook must use TLS (self-signed cert for Tailscale is acceptable; full cert for internet-facing).
3. **Per-device auth (future):** Device fingerprint + key rotation per connected client (Issue #83).

### Repo Isolation

- **Allowlist enforcement:** Webhook validates all repos against `known-repos.json` before dispatch.
- **No symlink escapes:** Rejected if repo path contains `..` or absolute path outside home.
- **Separate cwd per spawn:** Each session runs in its allowed repo dir; no cross-repo access during a single session.

### MCP Server Sandboxing

- **Trust model:** MCP servers are opt-in per harness config; MC doesn't restrict.
- **Audit trail:** All MCP tool calls logged (if harness supports it).
- **Dangerously-skip-permissions:** Allowed in MC context (authenticated, allowlisted repo, audit log). Justification in Issue #79 (self-hosted runner risk).

### Threat Model

| Threat | Mitigation | Residual Risk |
|--------|---|---|
| **Unauthorized spawn** | API key auth + Tailscale/TLS binding | Leaked key → unauthorized sessions (no code execution on MC host) |
| **Repo escape** | Allowlist + path validation | Symlink to `/etc/` outside allowed dirs (mitigated by chroot/container in future) |
| **Session hijacking** | Webhook socket binding to private network | MiTM on LAN (mitigated by Tailscale + mTLS) |
| **Cost/resource abuse** | Per-user spawn limits (Issue #84) + daily cost threshold | DOS via high-token-count prompts (mitigated by rate limiting) |
| **Log leakage** | Logs in userspace (not world-readable) | Malicious user on mini-PC reads logs (accept as on-device risk; audit log in place) |

See Issue #79 for deeper risk analysis (self-hosted runner context).

---

## Persistence & Boot Resilience

### Systemd Service

**Service:** `claude-daemon.service` and `claude-webhook.service`

**Config:**
```ini
[Service]
Type=simple
ExecStart=/path/to/webhook-server
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
User=natha
Environment=WEBHOOK_KEY=<key>
Environment=WEBHOOK_PORT=8765

[Install]
WantedBy=multi-user.target
```

**Behavior:**
- Service auto-starts on boot.
- On crash, systemd restarts within 5 seconds.
- Logs to systemd journal (queryable via `journalctl -u claude-webhook -f`).

### Session Recovery

**Claude Code:**
- Sessions persisted by `claude-daemon.service`.
- On restart, `claude agents` lists all running/recent sessions.
- Webhook pulls session state from daemon on startup.

**Antigravity CLI (TBD):**
- Currently unclear how `agy` survives PC reboot.
- Recommendation: Store session state in `~/.gemini/antigravity-cli/history.jsonl` (standard agy behavior).
- Webhook must query this on startup to reconstruct registry.

### Registry Durability

**File:** `~/.claude/mission-control-registry.json`

**Sync points:**
1. On spawn (add new session).
2. On session exit (mark as exited, record cost).
3. Periodic (every 30 seconds via webhook cleanup loop).

**Recovery:** On webhook restart, re-read registry and reconcile with actual running processes (prevent orphaned entries).

---

## Definition of Done (Epic #82–#88)

### Specification Phase (Issue #82) ✓ In Progress
- [x] Architecture doc (this file).
- [x] HTTP API contract defined.
- [x] Harness dispatch matrix specified.
- [x] Security model documented.
- [ ] Verify agy persistence behavior (BLOCKED on agy maintainer or user config testing).

### Security Audit (Issue #83)
- [ ] Threat model review and approval (Sam).
- [ ] Tailscale binding or equivalent TLS enforcement.
- [ ] Per-device auth token rotation (if required).
- [ ] Audit log format and retention policy.
- [ ] Compliance checklist (SOC 2, zero-trust).

### Versioning & Compatibility (Issue #84)
- [ ] API version header (e.g., `X-Mission-Control-Version: 1.0`).
- [ ] Backward-compatible migration path for API changes.
- [ ] Semantic versioning for webhook service.
- [ ] Changelog maintained in `docs/CHANGELOG.md`.

### Antigravity Dispatcher (Issue #85)
- [ ] Implement agy harness in webhook dispatcher.
- [ ] Resolve agy persistence (tmux wrapper? native --bg?).
- [ ] Test resume flow (`--continue <id>`).
- [ ] Integrate agy session registry (read from `~/.gemini/`).

### Repo Picker & Allowlist (Issue #86)
- [ ] Build repo picker UI (dropdown or search).
- [ ] Validate allowlist on spawn.
- [ ] Admin panel: add/remove repos.
- [ ] Schema validation for `known-repos.json`.

### Frontend (Issue #87)
- [ ] React SPA or static HTML form.
- [ ] Phone-friendly responsive layout.
- [ ] Session list with live cost tracking (Claude only, TBD for agy).
- [ ] Log viewer (tail-like, follow mode).
- [ ] Error handling and retry UI.

### Persistence & Boot Resilience (Issue #88)
- [ ] Systemd service auto-start on boot.
- [ ] Session recovery on webhook restart.
- [ ] Registry sync and orphan cleanup.
- [ ] Monitoring dashboard (uptime, error rate).

---

## Key Open Questions

1. **Antigravity persistence:** How does `agy` survive PC reboot? Is `--continue` the intended resume pattern, or is there a `--bg` flag pending? (Blocks Issue #85.)
   - **RESOLVED (spike #91):** agy has no native `--bg` flag. Available modes: `--print` (one-shot), `--continue`/`--conversation <id>` (resumes from `~/.gemini/antigravity-cli/history.jsonl`), and interactive TUI. For reboot/long-running survival, a **tmux or systemd wrapper** is required — not provided by agy itself. This is a new build item under #85 (owner Leo), also feeds issue #88. Issue #85 is now unblocked and scope-expanded to include this persistence wrapper.

2. **Concurrent session limits:** Should MC allow multiple harness instances (e.g., two Claude sessions + one agy session) or enforce one-at-a-time? (Affects Issue #84 rate limiting.)
   - **PARTIAL/DEFERRED (spike #91):** Google AI Pro operates on a flat subscription model. agy exposes `/quota` and `/usage` endpoints. The Terms of Service regarding headless/always-on automation and any hard concurrency cap are NOT determinable from CLI inspection alone. Deferred to Nat (business/legal review) under new issue #95. If a hard limit surfaces, dispatcher #85/#88 will enforce it — noted as follow-up dependency, not yet actionable.
   - **RESOLVED (2026-08-08):** Multiple instances are allowed, bounded rather than forbidden. `MC_MAX_PER_HARNESS` (default 4) caps sessions per harness and `MC_MAX_BG_SESSIONS` (default 8) caps the total; set `MC_MAX_PER_HARNESS=1` for the original one-at-a-time behaviour. The one-at-a-time gate was what made `POST /swarm` impossible to express.

3. **Cost accounting for agy:** Google AI Pro is subscription-based, not token-counted. How should cost display work? (Impacts Issue #87 FE design.)
   - **RESOLVED (spike #91):** Quota-based, not token-metered. agy exposes `/quota` and `/usage` but has no cost-API equivalent to Claude's `/cost` endpoint. Recommendation for #87: Display a "Subscription/Quota" badge for agy sessions (showing quota usage %) instead of dollar cost; keep `/cost` metric for Claude sessions only.

4. **MCP server security for agy:** Does agy support MCP at all? If so, how are permissions enforced vs. Claude Code? (Blocks Issue #83 security audit.)
   - **RESOLVED (spike #91):** agy DOES support MCP. Configuration file: `~/.gemini/config/mcp_config.json` (shared with IDE usage). Built-in servers: notebooks, visualization. Custom servers supported (command/remote/OAuth). Permissions enforced via `/permissions` and `/config` commands, with regex-based rules (v1.0.13+) and `--sandbox` mode. The permission model is isomorphic to Claude Code's MCP security model — issue #83 (Sam) applies the same threat model to both harnesses, with no lesser bar for agy. Issue #83 is now unblocked.

5. **Un-versioned production code risk:** Webhook server code lives in `~/AgentSystem/tools/` which is not a git repo. Should it be moved into the main codebase (`/home/natha/dev/AgentSystem`) for version control? (Noted in HANDOFF.md; escalate to Jarvis.)
   - **RESOLVED (in progress, spike #91):** Addressed by issue #84 (owner Leo, in flight): moving webhook server code from `~/AgentSystem/tools/` and `~/.claude/remote-control-server.js` into `~/dev/AgentSystem/tools/mission-control/` under git version control. This places all production code under the versioned monorepo.

---

## Future Extensions (Out of Scope for #82–#88)

- **Multi-user / role-based access control:** Currently single-user (natha). Future: RBAC per agent role.
- **Session collaboration:** Share logs / co-drive a session via second concurrent connection.
- **Cost optimization:** Auto-select cheaper model tier based on prompt complexity.
- **Self-healing:** Auto-retry on transient failures (network blip, harness crash).
- **Feedback loop:** Model selection based on historical session cost/quality.

---

## Mapping to Issues

| Issue | Scope | Owner | Depends On |
|-------|-------|-------|-----------|
| #82 | Spec & architecture (this doc) | Friday/Threepio | — |
| #83 | Security audit + TLS + per-device auth (incl. agy MCP) | Sam | #82 (spec done); agy MCP research ✅ |
| #84 | API versioning + rate limiting + cost tracking (incl. webhook versioning) | Leo | #82 |
| #85 | Implement agy dispatcher + tmux/systemd persistence wrapper | Ultron/Leo | #82; agy persistence research ✅ |
| #86 | Repo picker UI + allowlist validation | Astra | #82 |
| #87 | Frontend (React SPA / HTML form) + quota display | Astra | #82, #86 |
| #88 | Systemd boot resilience + recovery | Leo | #82, #85 |

---

## References

- **Remote Control:** See `docs/AGENT-INVOCATION-GUIDE.md` → "Remote Control" section (Anthropic-managed, zero-setup).
- **Session registry:** `session-namer.js` already scans Claude + agy sessions; integrate with MC registry.
- **Cost tracking:** `session-cost.js` tracks Claude spend; extend for MC sessions.
- **Known repos:** `~/agent-memory/nexus/known-repos.json` (shared source of truth).
- **Risk analysis:** Issue #79 (self-hosted runner, same threat model as MC).
- **GitHub integration:** `.github/workflows/agent-dispatch.yml` (example of webhook routing).

---

## Document Status

**Reviewed by:** (Pending)
**Approved by:** (Pending)
**Last revision:** 2026-06-30

If you find gaps or have clarifications, file an issue linked to #82 or comment on the issue directly.
