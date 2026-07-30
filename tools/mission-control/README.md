# Mission Control — Webhook Control Plane

Remote dispatch server for the Claude Code agent fleet and Antigravity (`agy`) sessions.
Spawn, monitor, stop, and cost-track agent runs from a phone or browser.

**Architecture:** production runs on a dedicated Linux host. Windows is dev-only.

## Files

| File | Role |
|------|------|
| `webhook-server.js` | HTTP REST API + panel host. Linux only. |
| `panel.html` | Mobile web panel (served at `/panel`, installable as a PWA). |
| `session-registry.js` | Durable session records; enforces 1 concurrent session per harness. |
| `agy-dispatcher.js` | Positional-arg wrapper around the agy persistence layer. |
| `agy-persistence.js` | Tmux-backed persistent agy sessions; falls back to direct spawn without tmux. |
| `repo-validator.js` | Resolves a repo slug against the `known-repos.json` allowlist. |
| `ip-utils.js` / `url-utils.js` | IP allowlist matching and public-URL derivation (unit tested). |
| `install-local.sh` | **The** installer: key generation, systemd unit, firewall, optional runner. |
| `install-runner.sh` | Registers the co-located GitHub Actions self-hosted runner. |
| `claude-webhook.service` | systemd unit **template** — placeholders substituted by the installer. |
| `mission-control-update.{service,timer}` | Optional daily `git pull` + restart. |

## Deployment

Use the installer. Do **not** hand-copy `claude-webhook.service` — it contains
`__PLACEHOLDER__` tokens that `install-local.sh` substitutes (user, absolute paths,
node binary, bind address).

```bash
git clone git@github.com:Zene8/AgentSystem.git ~/dev/AgentSystem
cd ~/dev/AgentSystem
bash tools/mission-control/install-local.sh
```

Defaults to a system service bound to `127.0.0.1:8765`. Useful flags:

| Flag | Effect |
|------|--------|
| `--user` | Install as a `systemd --user` unit (no sudo; needs linger enabled). |
| `--tailscale` | Bind this host's Tailscale IPv4. **Recommended for phone access.** |
| `--lan` | Bind `0.0.0.0` and open the port in UFW. Opt-in — see Security. |
| `--bind <addr>` | Bind a specific address. |
| `--port <n>` | Override port 8765. |
| `--no-service` | Set up key/config only; run the server by hand. |
| `--with-runner` | Also register the GitHub Actions self-hosted runner. |
| `--with-auto-update` | Daily timer that pulls `origin/main` and restarts. |

### Reaching it from a phone

Preferred — bind to the tailnet:

```bash
bash tools/mission-control/install-local.sh --tailscale
```

The port binds to the `tailscale0` address only, so it is reachable from every
device on your tailnet and from nothing else. No firewall hole is opened and no
TLS certificate is needed: WireGuard already provides transport encryption and
device identity. The installer prints the phone URL; use "Add to Home Screen" to
install the panel as a PWA.

Alternative, if you would rather not bind off-loopback at all:

```bash
ssh -L 8765:127.0.0.1:8765 <user>@<server>
```

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8765` | Listen port. |
| `HOST` | `127.0.0.1` | Bind address. Anything other than loopback prints a security warning. |
| `CLAUDE_BIN` | `~/.local/bin/claude` | Claude CLI path. Server exits at boot if set but missing. |
| `PUBLIC_URL` | — | Externally reachable base URL; used to build `logUrl` behind a proxy/Tailscale. |
| `ALLOWED_ORIGIN` | — | Single origin allowed for CORS. `*` is never emitted. |
| `GITHUB_WEBHOOK_SECRET` | — | HMAC secret for `POST /github`. Unset means every webhook is rejected. |
| `GH_REPO` | `Zene8/AgentSystem` | Repo whose PRs + runner health `/pipelines` reports. |
| `LIFE_REPO` | `~/life` | Root containing `briefings/` for `GET /briefing`. |

## API

**Auth:** `Authorization: Bearer <key>` (key at `~/.claude/remote-webhook.key`), or
`?key=<key>` for panel bookmarks. `POST /github` authenticates by HMAC signature
instead. `/favicon.ico`, `/icon.svg`, and `/sw.js` are unauthenticated (no secrets).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Health + daemon status + session count. |
| GET | `/health` | Detailed health (platform, node version, active sessions). |
| GET | `/panel` | Mobile control panel. |
| GET | `/manifest.webmanifest` | PWA manifest (auth'd — `start_url` embeds the key). |
| GET | `/repos` | Spawnable repos from the `known-repos.json` allowlist. |
| GET | `/sessions` | Active claude sessions + agy sessions from the registry. |
| GET | `/runs` | Recent run log files. |
| GET | `/log/:id` | Last 100 lines for a session (registry path, bg short-id, or file). |
| GET | `/cost` | Today + 7-day spend summary. |
| GET | `/pipelines` | Self-hosted runner health + open PRs (read-only `gh`). |
| GET | `/briefing` | Newest daily briefing markdown. |
| GET | `/scratchpads` | List active task scratchpads. |
| GET | `/scratchpad?project=&issue=` | Scratchpad content. |
| POST | `/scratchpad` | Append an entry. Body: `{project, issue, agent?, message}`. |
| GET | `/memory/search?agent=&query=` | Scored memory-file search. |
| GET | `/memory/file?path=` | Read a file. Confined to `~/agent-memory`. |
| POST | `/memory/remember` | Save a durable fact. Body: `{fact, section?, tier?, target?}`. |
| GET | `/diff?pr=` | Unified diff for a PR (truncated at 200 000 chars). |
| GET | `/branches?repo=` | Branches, worktrees, dirty-file count for an allowlisted repo. |
| POST | `/run` | Spawn a session (see below). |
| POST | `/stop` | Stop a session. Body: `{id}`. |
| POST | `/reply` | Answer a session waiting on input. Body: `{sessionId, message}`. |
| POST | `/pr` | Act on a PR. Body: `{number, action: ready\|merge\|comment, body?}`. |
| POST | `/github` | GitHub webhook receiver (HMAC-authenticated). |

### POST /run

Mission Control format — repo must be an allowlisted slug:

```json
{ "harness": "claude", "prompt": "review the schema", "repo": "genie", "agent": "pym" }
{ "harness": "agy",    "prompt": "review the schema", "repo": "genie", "model": "gemini-2.0-flash" }
```

Legacy panel format (`{agent, prompt, cwd?}`) is still accepted and now routes
through the same registry, so it obeys the same concurrency cap.

Returns `202` with `{id, harness, repo, status, logUrl}`. Returns `409` if that
harness already has a running session — the cap is 1 per harness.

### POST /reply

`claude agents --json` reports `state: "blocked"` for a background session that asked a
question and is waiting. `/reply` resumes that conversation with the answer:

```json
{ "sessionId": "<full session UUID from /sessions>", "message": "yes, use the squash merge" }
```

There is no CLI verb that messages a live background session, so this shells out to
`claude --resume <id> --bg <message>` and returns the new `backgroundId` to follow.

### POST /pr

`ready` flips a draft (which is what fires the required checks — Sam's security audit
skips drafts), `merge` squash-merges and deletes the branch, `comment` posts a comment.
`merge` never passes `--admin`, so branch protection on `main` still holds.

## Security

Guards, in request order: optional IP allowlist → failed-auth lockout → per-IP rate
limit (100 req/min) → timing-safe bearer auth.

- **IP allowlist** — `~/.claude/webhook-allowlist.json`:
  `{"allow": ["127.0.0.1", "192.168.1.0/24"]}`. Absent or empty means no IP filtering.
- **Lockout** — 10 failed auths within 60s locks that IP for 15 min, doubling on
  repeat lockouts up to 24h.
- **Audit log** — `~/.claude/mission-control-audit.jsonl` records run/stop/log-view
  and memory writes.
- **Spawn guards** — identical `agent|cwd` spawns within 30s are deduped; beyond 5
  concurrent background sessions the trigger is queued on the event bus rather than
  dropped.

Binding off-loopback exposes agent spawn to anyone who obtains the bearer key.
Prefer an SSH tunnel or Tailscale; rotate `~/.claude/remote-webhook.key` periodically.

## agy Persistence

```javascript
import { spawnAgyPersistent, stopAgyPersistent } from './agy-persistence.js';

const session = await spawnAgyPersistent({
  prompt: 'review schema',
  repoPath: '/home/nathan/dev/genie',
  model: 'gemini-2.0-flash',
});

await stopAgyPersistent({ tmuxSessionName: session.tmuxSessionName });
```

## Tests

```bash
npm run test:mission-control   # unit (registry/validator) + live HTTP endpoint tests
```

`tests/test_mission_control_http.js` boots the real server against a throwaway
`HOME` and exercises the endpoints over HTTP. Unit tests alone previously missed a
shadowed identifier that broke five endpoints and crashed the process.

## References

- **Full spec:** `docs/mission-control.md`
- **Linux deploy guide:** `docs/mission-control-linux-deploy.md`
- **Session costs:** `tools/session-cost.js`
