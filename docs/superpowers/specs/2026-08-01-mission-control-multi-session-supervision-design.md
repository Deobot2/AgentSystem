# Mission Control — Multi-Session Supervision

**Date:** 2026-08-01
**Status:** Approved, pending implementation
**Supersedes:** the single-session concurrency cap from #95

> **Interim state (as of #265).** The concurrency half of this spec was partially unblocked
> ahead of the rearchitecture: `MAX_PER_HARNESS` is no longer hard-coded to `1` but is
> `MC_MAX_PER_HARNESS` (default 4) with `MC_MAX_BG_SESSIONS` (default 8) capping the total,
> and `POST /swarm` dispatches a batch. That is still the `--bg` model — configurable caps
> rather than the resource guard below, and no pty, so the observe and steer problems are
> untouched. Read the sections below against `webhook-server.js` as it stands after #265;
> line numbers cited here predate it.

## Problem

Mission Control can dispatch one agent session per harness and then mostly loses touch with
it. Concretely, today:

- `POST /run` enforces **max 1 concurrent session per harness** (`webhook-server.js:930`, a
  deliberate autonomy constraint from #95).
- `GET /log/:id` returns the last 100 lines on poll. There is no stream and no live screen.
- `POST /reply` steers only by `claude --bg --resume <uuid> <prompt>`, which starts a *new*
  background turn. It cannot reach a session mid-flight, cannot interrupt a tool call, and
  cannot answer a permission prompt the session is currently sitting on.
- A server restart orphans `--bg` sessions: the processes survive, the registry association
  does not.

The goal is parity with sitting at the terminal, for several sessions at once: launch N
sessions, watch each one, and guide any of them — including answering a prompt mid-turn.

## Decisions

Settled during design; recorded because each one closes off alternatives.

| Decision | Choice | Rejected |
|---|---|---|
| Steering fidelity | Full interactive pty | Turn-level messaging; claude-only pty |
| Concurrency | Uncapped, resource + spend guard only | Configurable caps; caps plus queue |
| Harness scope | `claude` + `agy` only, done properly | Registry-driven harnesses; arbitrary command dispatch |
| Terminal rendering | Server-side `capture-pane`, plain-text panel | Vendored xterm.js; in-house ANSI renderer |
| Attention | State detection + Web Push | Detection without push; raw panes only |
| API compatibility | Clean break, migrate all callers in one PR | Shim old endpoints; freeze old, add new |
| Pty structure | tmux substrate behind a `pane-supervisor` module | tmux called directly from `webhook-server.js`; in-process `node-pty` |

`node-pty` was rejected on two counts: it is a native npm dependency, which `tools/**`
forbids, and in-process ptys die with the server.

## Architecture

Every session is a **tmux pane running the harness CLI interactively** — not `--bg`, not
`--print`. tmux is the process substrate and the liveness source of truth. The registry
holds metadata only.

```
panel (PWA)  ──HTTP──▶  webhook-server.js        routing, auth, validation only
                              │
                              ▼
                        pane-supervisor.js       owns tmux; the only tmux caller
                              │  spawn / capture / sendKeys / kill / list
                              ▼
                        tmux server ── mc-claude-a1b2 ── claude --agent friday "prompt"
                                    ── mc-agy-c3d4    ── agy ...
                              │
                        pipe-pane ──▶ ~/.claude/mc-logs/<id>.log   durable transcript
```

Three consequences:

1. **Sessions outlive the server.** `systemctl restart claude-webhook` leaves panes running;
   the supervisor rebuilds its inventory from `tmux list-sessions` at boot.
2. **`claude` and `agy` stop being different.** One spawn path, one stop path, one log path.
3. **Linux only, by design.** tmux is required with no fallback, matching the deployment
   model already documented in `tools/mission-control/README.md`.

## Components

| File | Change | Role |
|---|---|---|
| `tools/mission-control/pane-supervisor.js` | new | tmux lifecycle, capture, inventory, tick loop. The only file that shells to tmux. |
| `tools/mission-control/pane-state.js` | new | Pure function: captured screen → state. No I/O, table-driven. |
| `tools/mission-control/resource-guard.js` | new | Given RAM, load, spend, pane count: allow or refuse with a reason. |
| `tools/mission-control/harness-spec.js` | new | Per-harness launch argv and prompt style. Replaces `claude-args.js` and `agyArgs`. |
| `tools/mission-control/push-sender.js` | new | VAPID Web Push; subscriptions in `~/.claude/mc-push-subs.json`. |
| `tools/mission-control/session-registry.js` | modified | Add `paneName`, `state`, `lastActivityAt`, `attentionAt`. Drop the cap helper `getRunning()`. |
| `tools/mission-control/webhook-server.js` | modified | Routes only; session logic moves out. |
| `tools/mission-control/agy-persistence.js` | **deleted** | Absorbed by the supervisor. |
| `tools/mission-control/agy-dispatcher.js` | **deleted** | A wrapper around `agy-persistence.js` with a one-shot fallback that the pty model makes meaningless. |
| `tools/mission-control/claude-args.js` | **deleted** | Absorbed by `harness-spec.js`; its regression test moves with it. |
| `tools/mission-control/panel/` | new dir | `index.html`, `panel.js`, `panel.css`, `sw.js` split out of the 1628-line `panel.html`. |

### `pane-supervisor.js` interface

Everything else depends only on this surface:

```js
spawnPane({ harness, agent, model, repoPath, prompt }) → { id, paneName, logPath, pid }
capturePane(id, { lines })    → { screen: string, capturedAt }
sendKeys(id, { text, enter }) → { ok }
sendControl(id, key)          → { ok }
killPane(id)                  → { ok, exitCode }
listPanes()                   → [{ paneName, pid, alive }]
```

## Data flow

### Spawn

`POST /sessions` → validate harness, agent, and repo slug (existing `repo-validator.js`
allowlist, unchanged) → `resource-guard.js` check → `registry.createSession()` →
`spawnPane()`:

```
tmux new-session -d -s mc-claude-a1b2 -c <repoPath> -- claude --agent friday <prompt>
tmux pipe-pane  -t mc-claude-a1b2 -o "cat >> ~/.claude/mc-logs/claude-a1b2.log"
```

The prompt is the **positional** argument, preserving the lesson encoded in
`claude-args.js`: the prompt must never be passed as `-p`/`--print`, which every dispatch
path in the repo once got wrong. `--bg` itself disappears — tmux now provides the
backgrounding it was there for. Arguments are passed as separate argv entries with no shell string, as
`agy-persistence.js:55` already does. Responds `202` with the session id.

### Observe

The supervisor ticks every 3s, and only while at least one pane is alive, so an idle server
does no work. Each tick captures every pane, classifies it, and updates a cache.
`GET /sessions` serves that cache and never shells out on the request path — this is what
keeps the 13s `claude` cold start (which `getActiveSessions()` currently works around with a
30s TTL) off the request path entirely.

### Steer

- `POST /sessions/:id/keys` with `{text, enter}` → `tmux send-keys -t <pane> -l <text>`, then
  `Enter` if requested. The `-l` literal flag is what prevents `text` being interpreted as
  tmux key names.
- `POST /sessions/:id/keys` with `{control}` → `tmux send-keys -t <pane> <Key>` for an
  allowlisted key only.

This is the path that answers a permission prompt, nudges an agent mid-turn, or interrupts a
running tool call.

### Exit

A pane missing from `list-panes` is reaped on the next tick: the session is marked `exited`
with an exit code when one is available, and the log file is retained.
`GET /sessions/:id/log` reads the file, so completed sessions stay fully readable.

## State classification

`pane-state.js` maps the last ~40 captured lines to one state via an ordered pattern table:

| State | Signal | Meaning |
|---|---|---|
| `waiting-input` | permission prompt box; `❯ 1. Yes`; `Do you want to` | needs you; sorted top; fires push |
| `waiting-answer` | agent asked a question, cursor idle at prompt | needs you; fires push |
| `working` | screen changed since last tick, or spinner present | fine |
| `idle` | screen unchanged ≥60s, no spinner, prompt ready | probably done |
| `exited` | pane gone | terminal |
| `unknown` | nothing matched | surfaced as `unknown`, never coerced |

Two deliberate properties:

- **`unknown` is visible.** This is the mitigation for pattern brittleness. When a Claude Code
  UI change breaks a pattern, the panel reports "cannot tell" — a bug report, rather than a
  silently missed notification.
- **Screen-diffing is independent of the pattern table.** `working` versus `idle` is decided
  by whether the captured screen changed, so that distinction survives even if every text
  pattern rots.

Fixtures are real captured screens committed under `tests/fixtures/panes/*.txt`, one per
state, so the table is tested against actual TUI output.

## Resource and spend guard

Replaces the `webhook-server.js:930` cap. A spawn is refused when **any** guard trips:

| Guard | Default | Env |
|---|---|---|
| Free RAM | refuse below 1.5 GB free | `MC_MIN_FREE_MB` |
| Load average (1m) per core | refuse above 2.0 | `MC_MAX_LOAD` |
| Today's spend, via `session-cost.js` | refuse above $50/day | `MC_DAILY_USD_CAP` |
| Absolute pane ceiling | refuse above 12 panes | `MC_MAX_PANES` |

The pane ceiling is not a policy limit on operator autonomy; it is a runaway-fan-out
tripwire, set far above any number a human would open by hand.

Refusals return `429` naming the tripped guard and its current value, so the panel can
explain itself. `GET /health` reports all four so headroom is visible before dispatching.
Every threshold is env-tunable without a deploy.

## HTTP API

Clean break. Old session endpoints are removed, not shimmed.

| New | Replaces |
|---|---|
| `POST /sessions` | `POST /run` (both request formats) |
| `GET /sessions` | `GET /sessions`, now cache-backed and including `state` |
| `GET /sessions/:id` | — |
| `GET /sessions/:id/screen` | — |
| `POST /sessions/:id/keys` | `POST /reply` |
| `DELETE /sessions/:id` | `POST /stop` |
| `GET /sessions/:id/log` | `GET /log/:id` |
| `POST /push/subscribe` | — |

Callers migrated in the same change:

- `panel/` — rewritten against the new API.
- `event-dispatcher.js` — two changes, both required by the clean break:
  - Its over-cap requeue logic is **deleted**. With no cap there is nothing to requeue
    against, and a `429` from a resource guard should surface rather than be silently
    retried.
  - Its `spawn-agent` handler currently spawns `claude --bg` itself (`event-dispatcher.js:70-72`),
    importing `claudeBgArgs` on POSIX and building a shell string on win32. Deleting
    `claude-args.js` breaks it, so the handler is rewritten to `POST /sessions` on
    `127.0.0.1` with the bearer key from `~/.claude/remote-webhook.key`. That leaves exactly
    one writer to tmux and the registry, and drops the win32 shell branch. Dispatched
    sessions become visible and steerable in the panel, which they are not today. If the
    server is down the dispatch fails loudly rather than spawning an unsupervised process.
- `POST /github` — its internal dispatch call changes. The external HMAC contract is
  unchanged, so senders are unaffected.

Untouched: `/pipelines`, `/repos`, `/cost`, `/runs`, `/briefing`, `/diff`, `/branches`,
`/scratchpad*`, `/memory/*`.

The service worker gets a version bump that force-refreshes on activate, so a stale PWA on a
phone self-heals on next open rather than talking to endpoints that no longer exist.

## Panel

The session list is sorted attention-first: `waiting-input`, `waiting-answer`, `unknown`,
`working`, `idle`, `exited`. Each row shows harness, agent, repo, state, elapsed time, and
spend.

Tapping a row opens the pane view: a `<pre>` of the captured screen polled at 2s, a text
input that posts keystrokes, and buttons for Enter, Esc, Ctrl-C, and kill. Plain text and
server-rendered — no xterm.js and no new frontend dependencies.

Push: `POST /push/subscribe` stores a VAPID subscription. A session entering `waiting-input`
or `waiting-answer` fires one notification deep-linking to that pane — one per state
transition, never per tick.

## Security

The existing model is unchanged: bearer key from `~/.claude/remote-webhook.key`, optional IP
allowlist, lockout after 10 failed auths per minute, and repo slug allowlisting.

Two new surfaces:

**`POST /sessions/:id/keys` is remote keystroke injection into a live TUI.** Mitigations:

- `send-keys -l` literal mode, so text is never interpreted as tmux key names.
- The target pane is resolved from the registry by session id. A caller-supplied pane name is
  never accepted.
- Control keys are restricted to an allowlist: `escape`, `c-c`, `enter`, `tab`, `up`, `down`.
- `text` is length-capped, matching today's `MAX_REPLY_CHARS`.
- Every call is `auditLog`'d with a hash of the text, not the text itself.

**`prompt`, `agent`, and `model` reach argv.** The checks that exist today — `VALID_AGENTS`
membership and the `model` shape regex at `webhook-server.js:915` — move into
`harness-spec.js` so both harnesses share one implementation.

Stated plainly: anyone holding the bearer key can type into a Claude session running with the
operator's permissions. This is already true of `POST /run`, but keystrokes make it
interactive. Deploy bound to the tailnet (`install-local.sh --tailscale`), never `--lan`.

## Error handling

| Failure | Behavior |
|---|---|
| tmux not installed | Server refuses to boot, with a clear message. No silent degradation — the previous `spawnDirect` fallback produced sessions that could not be stopped, as documented at `agy-persistence.js:97`. |
| `new-session` fails | Session marked `failed` with stderr; `500` to the caller. No orphan `spawning` rows. |
| Pane dies unexpectedly | Reaped on the next tick as `exited`, with an exit code when available. Log retained. |
| `capture-pane` fails for one pane | That session reports `unknown`. Other panes are unaffected; one bad pane never breaks `GET /sessions`. |
| `send-keys` to a dead pane | `409` with the current state, so the panel refreshes rather than reporting a delivery that did not happen. |
| tmux server dies entirely | The next tick finds zero panes and reaps every session to `exited`. `/health` reports `tmux: unreachable`. |
| Supervisor tick throws | Caught per tick and logged; the cache is kept. A tick failure must never take down HTTP. |
| Log file growth | `pipe-pane` output is rotated at 50 MB per session. |

## Testing

| Test | Covers |
|---|---|
| `pane-state.test.js` | The pattern table, driven by `tests/fixtures/panes/*.txt`. Highest-value tests in the change. |
| `resource-guard.test.js` | Each guard tripping alone and in combination; pure inputs. |
| `harness-spec.test.js` | argv shape for both harnesses, including the positional-prompt regression `claude-args.js` exists to prevent. Absorbs `tests/test_claude_args.js` and the argv half of `tests/agy-args.test.js`, which are **deleted** with the modules they cover. |
| `pane-supervisor.test.js` | spawn, capture, sendKeys, kill against a **fake tmux** — a stub binary on `PATH` that records argv — so it runs on any CI runner without a real tmux. Replaces `tests/test_agy_persistence.js`, which is **deleted** with `agy-persistence.js`; its tmux-argv assertions carry over. |
| `test_mission_control_http.js` | Extended for the new routes with a stubbed supervisor. Keeps the free-port allocation from #207. |

One **manual acceptance run** on the Linux host, because a fake tmux cannot prove the real
thing works:

1. Spawn 3 claude sessions in different repos; confirm 3 live panes.
2. Drive one to a permission prompt; answer it from the phone.
3. Interrupt another mid-tool-call with Esc.
4. Kill the third from the panel.
5. Restart the server; confirm surviving panes are re-inventoried.

## Out of scope

Queueing and scheduling; arbitrary command dispatch; xterm.js-fidelity rendering; multi-user
or multi-tenant support; session hand-off between devices; changes to cost attribution beyond
reading `session-cost.js`.
