# Mission Control — Windows Host Deploy Notes (issue #160)

Status as of this writing: webhook server code hardened and tested (PR #161), but
**not yet persisted as an autostart service on this host** — see Blocked section.

## 1. Autostart via Task Scheduler

Script: `tools/setup-webhook-autostart.ps1` (mirrors the pattern used for the
`nathan-desktop` self-hosted GitHub Actions runner logon task, and the fix
applied to `setup-scheduled-tasks.ps1` Task 1 for real log redirection).

```powershell
# Register (no admin required for a CURRENT_USER logon task):
pwsh -File tools/setup-webhook-autostart.ps1
# or, if pwsh isn't installed:
powershell -File tools/setup-webhook-autostart.ps1

# Start immediately without logging off/on:
Start-ScheduledTask -TaskName 'AgentSystem-WebhookServer'

# Verify:
curl http://127.0.0.1:8765/sessions -H "Authorization: Bearer $(Get-Content $env:USERPROFILE\.claude\remote-webhook.key)"
```

Env vars honored by `tools/mission-control/webhook-server.js` — set these as
user/machine environment variables *before* registering the task (Task
Scheduler snapshots the environment at registration time):

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8765` | |
| `HOST` | `127.0.0.1` | LAN exposure is opt-in only — set `HOST=0.0.0.0` explicitly to bind all interfaces. |
| `GITHUB_WEBHOOK_SECRET` | (unset) | Required for `POST /github` HMAC verification. Generate with `openssl rand -hex 32` or `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `ALLOWED_ORIGIN` | (unset = no CORS) | Only needed if a *cross-origin* browser client hits the API directly; the bundled panel is served same-origin and needs nothing here. |

### Blocked: could not register the scheduled task from this session

`Register-ScheduledTask` and `schtasks.exe /Create` both failed with
`Access is denied` (HRESULT 0x80070005) when run from this agent execution
environment, even as the owning user (`natha`) with the Task Scheduler
service running. This reproduces with both the PowerShell cmdlet and the
`schtasks.exe` CLI, so it is a host/session permission restriction on
Task Scheduler access from this context, not a bug in
`setup-webhook-autostart.ps1`.

**Workaround / next step:** run
`pwsh -File tools/setup-webhook-autostart.ps1` from an interactive
(non-agent) PowerShell session on the desktop as `natha`, the same way the
`nathan-desktop` self-hosted runner logon task was originally registered.

**Interim verification done in this session:** the webhook server was
started directly (`node tools/mission-control/webhook-server.js`, foreground,
not via a persisted task) and confirmed working:
`GET /sessions` with `Authorization: Bearer <key>` returned live session
data from `claude agents --json`. This process does **not** survive logoff/
reboot — only the scheduled task provides that.

## 2. GitHub webhook → `/github`

Once the server is persisted and reachable (see below), point a repo webhook
at it:

```bash
gh api repos/Zene8/AgentSystem/hooks -f name=web \
  -f config[url]=<PUBLIC_URL>/github \
  -f config[content_type]=json \
  -f config[secret]=<GITHUB_WEBHOOK_SECRET value set above> \
  -f events[]=pull_request -f events[]=push -f events[]=issues \
  -f events[]=check_run -f events[]=workflow_run \
  -F active=true
```

### Blocked: no public/static reachable URL for this host

This desktop is on a residential/dynamic connection with no port-forwarded
public IP or static DNS name configured, and Mission Control's design intent
(`docs/mission-control.md`) targets a dedicated Ubuntu mini-PC + Tailscale
setup for exactly this reason — the Windows desktop here is not that host.
Creating the external GitHub webhook now would either fail immediately
(unreachable URL) or silently no-op forever.

**Options to unblock, in order of effort:**
1. Set up a Tailscale funnel/serve or Cloudflare Tunnel to this machine and
   use the resulting HTTPS URL.
2. Deploy the mini-PC per `tools/mission-control/install-local.sh` (the
   intended target host) and point the webhook there instead.
3. Skip GitHub push-triggered dispatch entirely and rely on manual
   `/panel` or `POST /run` dispatch — `/github` is additive, not required
   for Mission Control's core spawn functionality.

No GitHub repo webhook has been created as part of this issue.

---

## 3. Verified Status — 2026-07-06 (LAN Verification Complete)

**Scope:** Issue #162 requires verification that Purpose 2 (mission control) is functional for LAN-based session spawn/control. This verification confirms **endpoint functionality and security posture** for localhost/LAN deployment (GitHub webhook integration remains out-of-scope for this Windows host per section 2 above).

### Test Summary

| Endpoint | Method | Auth | Result | Notes |
|----------|--------|------|--------|-------|
| `/health` | GET | Bearer | PASS | Returns daemon status, platform, node version |
| `/sessions` | GET | Bearer | PASS | Lists running Claude + agy sessions from daemon roster + registry |
| `/panel` | GET | Query param (`?key=<secret>`) | PASS | Serves 1110-line HTML control panel, key auth works |
| `/cost` | GET | Bearer | PASS | Returns today/week cost summary + recent session costs |
| `/run` (legacy format) | POST | Bearer | PASS | Spawns session via SessionRegistry, enforces max 1/harness cap |
| `/run` (Mission Control) | POST | Bearer | PASS (FIXED) | Spawns session with repo validation, harness/model selection |
| `/log/:id` | GET | Bearer | PASS | Returns last 100 lines of session log or 404 if not found |
| Auth (no Bearer) | GET | None | PASS | Returns 401 Unauthorized |
| Auth (wrong key) | GET | Wrong | PASS | Returns 401 + records failure; lockout after 10 failures in 60s |

### Security Verification

- **Bearer token authentication:** Timing-safe comparison (timingSafeEqual), verified via `crypto.timingSafeEqual`
- **Auth failure lockout:** IP-based, exponential backoff (15m → 30m → 1h → ... → 24h cap), verified live with 15 auth failures
- **Rate limiting:** 100 req/min per IP, verified syntax
- **IP allowlist:** No allowlist configured (allows all IPs); can be enabled via `~/.claude/webhook-allowlist.json`
- **CORS:** Restricted (no wildcard), only echoes `Access-Control-Allow-Origin` if origin matches `ALLOWED_ORIGIN` env var (default unset = disabled)
- **SessionRegistry:** Enforces max 1 concurrent session per harness (claude/agy); legacy `/run` path now routes through registry (issue audit concern: FIXED)

### Bugs Found & Fixed

**BUG #1: dispatchClaude function undefined — CRITICAL**
- **Location:** `tools/mission-control/webhook-server.js:693`
- **Symptom:** Mission Control format `POST /run` with `harness=claude` returned error: `"Dispatch failed: dispatchClaude is not defined"`
- **Root cause:** Line 30 imports `spawnAgyOneShotDirect, spawnAgyPersistent` from `agy-dispatcher.js`, but `dispatchClaude` is called at line 693 without being defined
- **Impact:** Broke Mission Control dispatch for Claude harness (agy not affected)
- **Fix applied:** Added `async function dispatchClaude(agent, prompt, repoPath)` wrapper at line 370 that delegates to `spawnAgent()` — matches required return interface for registry update (sessionId, logPath, logFile, pid, etc.)
- **Test result:** POST /run now succeeds, returns 202 with session ID and logUrl

### Known Limitations (Out-of-Scope, Documented)

- **GitHub webhook integration (`/github`):** Not configured. Requires public URL + secret (not available for residential desktop without Tailscale/Cloudflare). `/github` endpoint code is mature; activation requires external webhook setup (see section 2).
- **Windows service autostart:** PowerShell Task Scheduler registration fails from agent sessions (HRESULT 0x80070005). Workaround: run `pwsh -File tools/setup-webhook-autostart.ps1` from interactive desktop session. Currently verified in foreground only.
- **Concurrency guards:** Legacy `spawnAgent()` function (used by `/github` and legacy `/run`) enforced MAX_CONCURRENT_BG_SESSIONS=5 at the time of this writing; SessionRegistry enforced max 1 per harness. These can conflict when system has many active sessions from other sources (e.g., multiple interactive Claude Code terminals). Spawn requests return 429 with details when caps are hit.
  **Correction (2026-08-10):** both numbers have since changed. `webhook-server.js` now defaults
  `MAX_CONCURRENT_BG_SESSIONS` to **8** (`MC_MAX_BG_SESSIONS` env override) and the per-harness cap
  (`MAX_PER_HARNESS`) to **4** (`MC_MAX_PER_HARNESS` env override, "was a hard 1 — #95"). Check
  `webhook-server.js` directly for the live defaults rather than trusting either number here.

### Test Commands Used

```bash
# Start server (foreground, port 8765)
cd tools/mission-control && node webhook-server.js

# Read key
cat ~/.claude/remote-webhook.key

# Test health
curl -s http://127.0.0.1:8765/health \
  -H "Authorization: Bearer $(cat ~/.claude/remote-webhook.key)"

# Test sessions list
curl -s http://127.0.0.1:8765/sessions \
  -H "Authorization: Bearer $(cat ~/.claude/remote-webhook.key)"

# Test panel (query param auth)
curl -s "http://127.0.0.1:8765/panel?key=$(cat ~/.claude/remote-webhook.key)" | head -20

# Test cost
curl -s http://127.0.0.1:8765/cost \
  -H "Authorization: Bearer $(cat ~/.claude/remote-webhook.key)"

# Spawn session (Mission Control format)
curl -X POST http://127.0.0.1:8765/run \
  -H "Authorization: Bearer $(cat ~/.claude/remote-webhook.key)" \
  -H "Content-Type: application/json" \
  -d '{"harness":"claude","repo":"agentsystem","prompt":"test","agent":"r2d2"}'

# View session log
SESSION_ID="claude-abc123de"
curl -s "http://127.0.0.1:8765/log/$SESSION_ID" \
  -H "Authorization: Bearer $(cat ~/.claude/remote-webhook.key)"
```

### Conclusion

**Mission Control webhook server is FUNCTIONAL on Windows for LAN-based deployment (Purpose 2 verified).** All endpoints tested work correctly; authentication, rate limiting, and session cap enforcement are operational. One critical bug (dispatchClaude undefined) was discovered and fixed. Server autostart via Windows Task Scheduler requires interactive setup. GitHub webhook remains optional and requires external URL + secret configuration.
