# Mission Control — Remote Linux Server Deployment

How to install and run the Mission Control webhook server on a headless Linux
server (Ubuntu/Debian) so you can dispatch and monitor Claude Code / Antigravity
agents from a phone or laptop.

This is the **Linux** deployment guide. `mission-control-windows-deploy.md` is a
historical note about a Windows desktop host and is **not** the path for a real
server — use this document.

---

## 1. What gets installed

- **`tools/mission-control/webhook-server.js`** — a Node.js (stdlib-only) HTTP
  server. REST API + a mobile web panel at `/panel`.
- A **systemd service** (`claude-webhook`) that runs it with `Restart=always`,
  logging to the journal.
- A **bearer key** at `~/.claude/remote-webhook.key` (auto-generated, `chmod 600`).
- A **repo allowlist** at `~/agent-memory/nexus/known-repos.json` (seeded with the
  current repo; `POST /run` refuses any repo not listed here).

On a fresh server the installer also bootstraps everything the server and the CI
workflows need — each step skipped when already present, so re-running is a no-op:

| Dependency | Source |
|------------|--------|
| `curl`, `git`, `tmux`, `jq`, `openssl`, `ca-certificates` | apt (one transaction) |
| Node.js 22 LTS | `deb.nodesource.com/setup_22.x` |
| `gh` (GitHub CLI) | official `cli.github.com` apt repo |
| `claude` (Claude Code) | `https://claude.ai/install.sh` → `~/.local/bin/claude` |
| `agy` (Antigravity CLI) | `https://antigravity.google/cli/install.sh` → `~/.local/bin/agy` |
| `tailscale` *(only with `--with-tailscale`)* | `https://tailscale.com/install.sh` |

`tmux` backs persistent `agy` sessions; the webhook server shells out to `claude`,
`agy`, and `gh`, resolving `~/.local/bin` first. Pass `--no-clis` to skip the two
agent CLIs (offline box, or you manage them yourself).

**The installer cannot log you in.** After it finishes, run each of these once:

```bash
claude              # sign in (or: claude setup-token for a headless token)
agy                 # sign in to Antigravity
gh auth login       # PR actions + self-hosted runner registration
```

Until then dispatch requests reach the server and fail on auth.

---

## 2. Install

On a bare Ubuntu/Debian box, from a normal (non-root) user with sudo:

```bash
sudo apt-get update && sudo apt-get install -y git   # only thing needed to clone
git clone <repo> ~/AgentSystem && cd ~/AgentSystem

# One command: bootstraps prerequisites, installs the agent system, then Mission
# Control with phone access, the CI runner, and the daily self-update timer.
./install.sh --with-mission-control --with-tailscale --with-runner --with-auto-update
```

`install.sh` detects missing `node`/`gh` and runs the Mission Control dependency
bootstrap itself, then continues; any flag it doesn't recognise is forwarded to
`tools/mission-control/install-local.sh`. Running that installer directly works
too — it just skips the agent-system half (brains, agent sync, hooks, MCP server).

Do not run either installer with `sudo` — both CLI installers refuse to install
into root's home, and the service is meant to run as your deploy user.

By default this installs a **system** service bound to **loopback (127.0.0.1)** —
the safe default. Nothing is exposed to the network until you opt in.

### Co-locating the GitHub Actions self-hosted runner (recommended)

The Sam/Friday audits, `/agent` dispatch, and scheduled cron workflows all run on a
**self-hosted runner** (`runs-on: [self-hosted, Linux]`). Install one on this same
box so CI is co-located with Mission Control and there's no dependency on a separate
desktop:

```bash
# authenticate gh with repo-admin scope first (auto-fetches the registration token):
gh auth login
bash tools/mission-control/install-runner.sh
# or fold it into the mission-control install:
bash tools/mission-control/install-local.sh --with-runner
# no gh admin? pass a token from repo Settings > Actions > Runners > New:
bash tools/mission-control/install-runner.sh --token <registration-token>
```

The runner installs as its own boot-persistent systemd service (via the runner's
`svc.sh`). It gets the built-in labels `self-hosted, Linux, X64` (plus
`mission-control`), which satisfy the workflows' `[self-hosted, Linux]` target. The
audit/dispatch workflows shell out to `gh` and the `claude` CLI, resolving them by
absolute path (`~/.local/bin` first) so the runner's minimal service PATH is a
non-issue — but both CLIs must be installed on this host.

### Installer options

| Flag | Effect |
|------|--------|
| `--user` | Install as a `systemd --user` service (no sudo). Enables linger so it survives logout/reboot. |
| `--no-clis` | Skip installing the `claude` / `agy` CLIs. OS packages, Node, and `gh` still install. |
| `--lan` | Bind `0.0.0.0` and open the port in UFW. LAN-reachable. |
| `--bind <addr>` | Bind a specific address (e.g. a Tailscale IP `100.x.y.z`). Preferred over `--lan`. |
| `--port <n>` | Listen port (default 8765). |
| `--public-url <url>` | Advertise this base URL in API responses (behind a proxy/Tailscale). |
| `--with-tailscale` | Install Tailscale, join the tailnet, bind the tailnet IP, and open the port on `tailscale0` only. Best option for phone access. |
| `--tailscale-authkey <k>` | Join non-interactively. Prefer `TS_AUTHKEY=tskey-… bash …` — a flag is visible in `ps`. |
| `--no-service` | Set everything up but don't install/start systemd (run manually). |

---

## 2b. Life OS daily triage (the 07:00 job)

`.github/workflows/scheduled-tasks.yml` runs **stage 2** of the Life OS cadence on this same
runner at 07:00 UTC: it reads the brief that stage 1 (06:00, Grok Tasks, external) archived,
covers the channels stage 1 cannot reach, and executes the AI-actionable items as **draft PRs**.

The two skills it needs — `skills/daily-briefing/` and `skills/daily-triage/` — are
**gitignored** (private life-OS content, #187). A `git clone` on this server does **not**
contain them, and the job hard-fails on the missing `SKILL.md`. They ship out of band:

```bash
# from the machine where the skills exist (the authoring laptop), NOT from the server:
bash tools/deploy-private-skills.sh --host you@server           # ship + install
bash tools/deploy-private-skills.sh --host you@server --check   # verify, change nothing
```

That copies the skills into `~/dev/AgentSystem/skills/` on the target, runs
`tools/install-skills.js` there, and creates `$LIFE_REPO/{briefings,closeouts}`. Idempotent.

**Re-run it after every edit to either skill.** The `mission-control-update.timer` self-update
pulls git, and git does not carry these files — so a skill edit on the laptop reaches the server
only through this script. That is the one part of this deployment that does not self-heal.

Then, on the server:

```bash
# 1. the job needs a checkout at this exact path (a symlink is fine):
ls -d ~/dev/AgentSystem

# 2. LIFE_REPO — where the brief and closeout live. Default ~/life; set it only to override.
#    Must be identical for the webhook service and the runner, or MC serves a different
#    directory than the job writes:
gh variable set LIFE_REPO --body /home/you/life      # repo variable, read by the workflow
sudo systemctl edit claude-webhook                   # add Environment=LIFE_REPO=/home/you/life

# 3. the connectors. daily-triage reads Drive/Gmail/Notion/Calendar through interactively
#    authenticated MCP connectors in THIS host's ~/.claude — `claude` must be signed in here:
claude   # then verify the connectors resolve in a real session
```

**Known coverage gap, by design:** the skill also tries Beeper (`localhost:23373`) and Discord.
A headless server runs neither, so those channels come back uncovered and the closeout says so
rather than claiming a sweep it did not do. If you want them covered, the fix is installing the
bridge on this host — not changing the skill.

Verify the whole path before trusting the 07:00 cron:

```bash
gh workflow run scheduled-tasks.yml -f job=daily-triage
gh run watch "$(gh run list --workflow=scheduled-tasks.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
curl -s -H "Authorization: Bearer $(cat ~/.claude/remote-webhook.key)" localhost:8765/briefing | head -c 400
```

The run's second step fails loudly when no closeout landed — a silent 07:00 no-op is the failure
mode that hurts, so a red run is the intended signal, and it emails the hub inbox that stage 1
triages next morning.

---

## 3. Reaching it (three options, most→least secure)

**A. SSH tunnel (default, no exposure).** Leave the server on loopback:
```bash
ssh -L 8765:127.0.0.1:8765 user@server
# then open http://localhost:8765/panel?key=$(ssh user@server cat .claude/remote-webhook.key)
```

**B. Tailscale (recommended for phone access).** The installer does the whole
thing — installs Tailscale, joins the tailnet, binds that IP, sets `PUBLIC_URL`,
and opens the port on `tailscale0` only:
```bash
bash tools/mission-control/install-local.sh --with-tailscale
# it prints a login URL to authorise the server; or join non-interactively with a
# pre-auth key from https://login.tailscale.com/admin/settings/keys :
TS_AUTHKEY=tskey-auth-… bash tools/mission-control/install-local.sh --with-tailscale
```
Only devices on your tailnet can reach it — install the Tailscale app on the phone
and open the `http://100.x.y.z:8765/panel?key=…` URL the installer prints. For
HTTPS and a stable hostname instead of the raw IP: `sudo tailscale serve --bg 8765`.

An explicit `--bind`/`--lan` wins over the tailnet IP, so the manual form still
works if Tailscale is already up: `--bind "$(tailscale ip -4)"`.

**C. Public + reverse proxy with TLS.** If it must face the internet, never expose
the Node port directly — front it with nginx/Caddy doing TLS, and bind the app to
loopback:
```nginx
server {
  listen 443 ssl;
  server_name mc.example.com;
  ssl_certificate     /etc/letsencrypt/live/mc.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/mc.example.com/privkey.pem;
  location / {
    proxy_pass http://127.0.0.1:8765;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```
Install with `--public-url https://mc.example.com` so advertised log URLs are
correct. The server reads `X-Forwarded-Proto` to build `https://` URLs.

---

## 4. Security posture

The only guards on the agent-spawn API are a **timing-safe bearer key** and a
**100 req/min per-IP rate limit**. There is no user model. Therefore:

- **Never bind `0.0.0.0` on a public server** without TLS + a trusted network in
  front. On a public box, prefer Tailscale or an SSH tunnel.
- Keep `~/.claude/remote-webhook.key` `chmod 600`; rotate it periodically
  (regenerate the file and restart the service).
- Optional IP allowlist: `~/.claude/webhook-allowlist.json`
  `{ "allow": ["100.64.0.0/10", "192.168.1.0/24"] }`.
- Optional GitHub webhook HMAC: set `GITHUB_WEBHOOK_SECRET` in the unit
  (`systemctl edit claude-webhook`) — `/github` returns 401 without it.
- Only repos in `known-repos.json` can be dispatched; path traversal and absolute
  paths are rejected by `repo-validator.js`.

---

## 5. Configuration reference (environment variables)

| Var | Default | Meaning |
|-----|---------|---------|
| `HOST` | `127.0.0.1` | Bind address. |
| `PORT` | `8765` | Listen port. |
| `PUBLIC_URL` | *(unset)* | Base URL advertised in responses (behind proxy/Tailscale). |
| `CLAUDE_BIN` | `~/.local/bin/claude` | Path to the `claude` CLI. |
| `GITHUB_WEBHOOK_SECRET` | *(unset)* | HMAC secret for `POST /github`. |
| `ALLOWED_ORIGIN` | *(off)* | Opt-in CORS origin (never `*`). |
| `AGY_ALLOW_DANGEROUS_SKIP_PERMISSIONS` | *(off)* | Antigravity permission bypass. |

Files: key `~/.claude/remote-webhook.key` · allowlist
`~/agent-memory/nexus/known-repos.json` · IP allowlist
`~/.claude/webhook-allowlist.json` · run logs `~/.claude/agent-runs/` · session
registry `~/.claude/mission-control-registry.json` · audit log
`~/.claude/mission-control-audit.jsonl`.

---

## 6. Operate

```bash
# system service
sudo systemctl status claude-webhook
sudo journalctl -u claude-webhook -f
sudo systemctl restart claude-webhook

# --user service
systemctl --user status claude-webhook
journalctl --user -u claude-webhook -f

# health check
curl -s localhost:8765/health
```

### Troubleshooting

- **Service exits immediately** → missing `~/.claude/remote-webhook.key`
  (the server refuses to start without it). Re-run the installer.
- **`POST /run` → 4xx "unknown repo"** → the repo isn't in `known-repos.json`.
- **`claude: not found` in the journal** → the CLI isn't on the service `PATH`;
  set `CLAUDE_BIN` via `systemctl edit claude-webhook`, or install it to
  `~/.local/bin`.
- **Can't reach it from the LAN** → it's loopback-bound by design. Re-install with
  `--lan` / `--bind`, or use an SSH tunnel.
