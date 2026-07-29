#!/bin/bash
# install-local.sh — Mission Control installer for a headless Linux server (Ubuntu/Debian).
#
# Bootstraps a bare server: OS packages, Node 22, gh, the Claude Code CLI and the
# Antigravity (agy) CLI, then installs the webhook server as a systemd service,
# generates a bearer key, and provisions the repo allowlist. Safe by default:
# binds loopback-only unless you explicitly opt into LAN/public exposure.
#
# Usage:
#   bash tools/mission-control/install-local.sh [options]
#
# Options:
#   --user            Install as a systemd --user service (no sudo; needs linger).
#                     Default is a system service under /etc/systemd/system.
#   --no-clis         Skip installing the claude / agy agent CLIs (offline box, or
#                     you manage them yourself). They are installed when missing.
#   --lan             Bind 0.0.0.0 (reachable on the LAN). Implies a firewall port open.
#   --bind <addr>     Bind a specific address (e.g. a Tailscale IP). Overrides --lan.
#   --tailscale       Bind this host's already-joined Tailscale IPv4 — reachable from
#                     any device on the tailnet, unreachable from the LAN or the
#                     internet. WireGuard already provides transport encryption and
#                     device identity, so no TLS cert is needed and the only firewall
#                     rule added is on tailscale0. Use --with-tailscale if Tailscale
#                     is not installed/joined yet.
#   --port <n>        Listen port (default 8765).
#   --public-url <u>  Externally-reachable base URL to advertise (behind a proxy/Tailscale),
#                     e.g. https://mc.example.com. Sets PUBLIC_URL in the unit.
#   --with-tailscale  Install Tailscale, join the tailnet, and bind the tailnet IP so
#                     only your own devices (phone, laptop) can reach the panel.
#                     Interactive login unless an auth key is supplied.
#   --tailscale-authkey <k>  Non-interactive tailnet join (or set TS_AUTHKEY in the
#                     environment, which keeps the key out of the process list).
#   --no-service      Do everything except install/start the systemd service.
#   --with-runner     Also register a GitHub Actions self-hosted runner on this host
#                     (Sam/Friday audits, /agent dispatch, cron). See install-runner.sh.
#   --runner-token <t>  Registration token passed through to the runner installer.
#   --with-auto-update  Install a daily systemd timer that pulls origin/main
#                     (fast-forward only) and restarts the service. Self-updating box.
#   -h | --help       Show this help.
#
# See docs/mission-control-linux-deploy.md for the full remote-server guide
# (TLS, Tailscale, security posture).

set -euo pipefail

# ── Resolve repo root (two levels up from this script) ─────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEMPLATE="$SCRIPT_DIR/claude-webhook.service"

# ── Defaults ───────────────────────────────────────────────────────────────────
MODE="system"        # system | user
HOST="127.0.0.1"
HOST_EXPLICIT="no"   # did the caller pick the bind address themselves?
PORT="8765"
PUBLIC_URL=""
INSTALL_SERVICE="yes"
FIREWALL="no"        # open a firewall port only when binding non-loopback
WITH_RUNNER="no"
RUNNER_TOKEN=""
WITH_AUTO_UPDATE="no"
INSTALL_CLIS="yes"   # install the claude / agy CLIs when they are missing
WITH_TAILSCALE="no"  # install Tailscale and join the tailnet, then bind that IP
TS_AUTHKEY="${TS_AUTHKEY:-}"   # env is preferred over the flag: not visible in `ps`
TAILSCALE_BIND="no"  # bound address is a tailnet address (either entry point)

# ── Parse args ───────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --user)         MODE="user"; shift ;;
    --no-clis)      INSTALL_CLIS="no"; shift ;;
    --lan)          HOST="0.0.0.0"; FIREWALL="yes"; HOST_EXPLICIT="yes"; shift ;;
    --bind)         HOST="$2"; FIREWALL="yes"; HOST_EXPLICIT="yes"; shift 2 ;;
    --tailscale)
      command -v tailscale >/dev/null 2>&1 || { echo "--tailscale: tailscale not installed" >&2; exit 2; }
      HOST="$(tailscale ip -4 2>/dev/null | head -n1)"
      [ -n "$HOST" ] || { echo "--tailscale: no Tailscale IPv4 (is 'tailscale up' done?)" >&2; exit 2; }
      HOST_EXPLICIT="yes"; TAILSCALE_BIND="yes"; shift ;;
    --port)         PORT="$2"; shift 2 ;;
    --public-url)   PUBLIC_URL="$2"; shift 2 ;;
    --with-tailscale) WITH_TAILSCALE="yes"; shift ;;
    --tailscale-authkey) TS_AUTHKEY="$2"; shift 2 ;;
    --no-service)   INSTALL_SERVICE="no"; shift ;;
    --with-runner)  WITH_RUNNER="yes"; shift ;;
    --runner-token) RUNNER_TOKEN="$2"; shift 2 ;;
    --with-auto-update) WITH_AUTO_UPDATE="yes"; shift ;;
    # Print the header comment block, whatever its length — a hardcoded line range
    # silently truncates the help every time an option is added.
    -h|--help)      awk 'NR>1 && /^#/ {print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
# Loopback binds never need a firewall hole.
if [ "$HOST" = "127.0.0.1" ] || [ "$HOST" = "localhost" ]; then FIREWALL="no"; fi

echo "================================================================="
echo "  Mission Control installer — Linux server"
echo "  repo: $REPO_ROOT"
echo "  mode: $MODE service | bind: $HOST:$PORT"
echo "================================================================="

# ── 1. Dependencies ────────────────────────────────────────────────────────────
# Fresh-server bootstrap: OS packages, Node, gh, then the two agent CLIs the
# webhook server shells out to (claude, agy). Every step is skip-if-present, so
# re-running the installer on a provisioned box is a no-op here.
echo "[1/6] Dependencies..."
# Both CLIs install into ~/.local/bin; make it visible to the rest of this script.
export PATH="$HOME/.local/bin:$PATH"

apt_install() {
  if command -v apt-get &>/dev/null; then
    sudo apt-get update -qq && sudo apt-get install -y "$@"
  else
    echo "  !! apt-get not found — install '$*' manually" >&2
  fi
}

# Package name == binary name for all of these. One apt transaction, not five.
MISSING=()
for bin in curl git tmux jq openssl; do
  command -v "$bin" &>/dev/null || MISSING+=("$bin")
done
if [ ${#MISSING[@]} -gt 0 ]; then
  echo "  Installing: ${MISSING[*]}"
  apt_install ca-certificates "${MISSING[@]}"
else
  echo "  base packages: ok (curl git tmux jq openssl)"
fi

if ! command -v node &>/dev/null; then
  echo "  Installing Node.js 22 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
NODE_BIN="$(command -v node)"
echo "  node: $NODE_BIN ($(node --version))"

# gh: used by POST /run's PR helpers and by every CI workflow on this host.
if command -v gh &>/dev/null; then
  echo "  gh: $(command -v gh)"
elif command -v apt-get &>/dev/null; then
  echo "  Installing GitHub CLI from cli.github.com..."
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | sudo tee /usr/share/keyrings/githubcli-archive-keyring.gpg >/dev/null
  sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  sudo apt-get update -qq && sudo apt-get install -y gh
else
  echo "  !! gh not found and apt-get unavailable — install it manually"
fi

# The server shells out to the claude CLI (POST /run) and agy (Antigravity harness).
install_cli() {
  local bin="$1" url="$2" label="$3"
  if command -v "$bin" &>/dev/null; then
    echo "  $label: $(command -v "$bin")"
    return 0
  fi
  if [ "$INSTALL_CLIS" != "yes" ]; then
    echo "  !! $label not found (--no-clis) — dispatch to it will fail until installed"
    return 0
  fi
  echo "  Installing $label from ${url%/*}..."
  # Vendor installers, run as this user, unpacking into ~/.local/bin. Not piped
  # through sudo on purpose: both refuse to install into root's home.
  if curl -fsSL "$url" | bash; then
    command -v "$bin" &>/dev/null \
      && echo "  $label: $(command -v "$bin")" \
      || echo "  !! $label installer finished but '$bin' is not on PATH"
  else
    echo "  !! $label install failed — dispatch to it will fail until installed"
  fi
}
install_cli claude https://claude.ai/install.sh "claude CLI"
install_cli agy https://antigravity.google/cli/install.sh "agy CLI"

# Tailscale: opt-in, and the only exposure path that needs no TLS or open port —
# the panel becomes reachable from your own devices and nothing else.
if [ "$WITH_TAILSCALE" = "yes" ]; then
  if command -v tailscale &>/dev/null; then
    echo "  tailscale: $(command -v tailscale)"
  else
    echo "  Installing Tailscale from tailscale.com..."
    # Vendor script; it elevates with sudo itself and installs the tailscaled unit.
    curl -fsSL https://tailscale.com/install.sh | sh
  fi
  # Already logged in? `tailscale ip` only answers once the node has joined.
  TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  if [ -z "$TS_IP" ]; then
    if [ -n "$TS_AUTHKEY" ]; then
      echo "  Joining tailnet with the supplied auth key..."
      sudo tailscale up --authkey "$TS_AUTHKEY" || true
    else
      echo "  Joining tailnet — open the URL below in a browser to authorise this server:"
      sudo tailscale up || true
    fi
    TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  fi
  if [ -n "$TS_IP" ]; then
    echo "  tailnet IP: $TS_IP"
    # Bind it unless the caller already chose an address — an explicit --bind wins.
    if [ "$HOST_EXPLICIT" = "no" ]; then
      HOST="$TS_IP"
      TAILSCALE_BIND="yes"
      [ -n "$PUBLIC_URL" ] || PUBLIC_URL="http://$TS_IP:$PORT"
      echo "  binding the tailnet IP: $HOST:$PORT"
    else
      echo "  keeping the requested bind $HOST (--bind/--lan/--tailscale given)"
    fi
  else
    echo "  !! not on a tailnet yet — run 'sudo tailscale up', then re-run this installer"
  fi
fi

# ── 2. Directories + node deps ───────────────────────────────────────────────
echo "[2/6] Preparing directories..."
mkdir -p "$HOME/agent-memory/nexus/tasks" "$HOME/.claude/agent-runs"
( cd "$REPO_ROOT" && npm install --omit=dev --silent ) || echo "  !! npm install failed (non-fatal for stdlib-only server)"

# ── 3. Bearer key ────────────────────────────────────────────────────────────
echo "[3/6] Bearer key..."
KEY_FILE="$HOME/.claude/remote-webhook.key"
if [ ! -f "$KEY_FILE" ]; then
  openssl rand -hex 32 > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  echo "  generated $KEY_FILE"
else
  echo "  reusing existing $KEY_FILE"
fi

# ── 4. Repo allowlist (POST /run refuses repos not listed here) ────────────────
echo "[4/6] Repo allowlist..."
REPOS_FILE="$HOME/agent-memory/nexus/known-repos.json"
if [ ! -f "$REPOS_FILE" ]; then
  # Schema must match repo-validator.js, which looks up knownRepos.repos[].slug.
  # A bare { "<slug>": { "path": ... } } map parses fine but matches nothing, so
  # every POST /run would be rejected as "not in allowlist".
  SLUG="$(basename "$REPO_ROOT" | tr '[:upper:]' '[:lower:]')"
  cat > "$REPOS_FILE" <<JSON
{
  "version": "1.0",
  "repos": [
    { "slug": "$SLUG", "path": "$REPO_ROOT", "primary_cli": "claude" }
  ]
}
JSON
  echo "  seeded $REPOS_FILE with '$SLUG' -> $REPO_ROOT"
  echo "  (edit this file to allow more repos for remote dispatch)"
else
  echo "  reusing existing $REPOS_FILE"
fi

# ── 5. Firewall (only when binding beyond loopback) ────────────────────────────
if [ "$TAILSCALE_BIND" = "yes" ] && command -v ufw &>/dev/null; then
  # Tailnet bind: default-deny-incoming drops packets arriving on tailscale0 too, so
  # the port does need opening — but on that interface only, never LAN-wide.
  echo "[5/6] Opening port $PORT in UFW on tailscale0 only..."
  sudo ufw allow in on tailscale0 to any port "$PORT" proto tcp || true
elif [ "$FIREWALL" = "yes" ] && command -v ufw &>/dev/null; then
  echo "[5/6] Opening port $PORT in UFW..."
  sudo ufw allow "$PORT/tcp" || true
else
  echo "[5/6] Firewall: no change (loopback bind or UFW absent)."
fi

# The installers cannot log anybody in — that stays a manual step either way.
print_auth_todo() {
  echo "  Still to do by hand — each CLI needs an interactive login once:"
  echo "    claude            # sign in (or: claude setup-token for a headless token)"
  echo "    agy               # sign in to Antigravity"
  echo "    gh auth login     # needed for PR actions and the self-hosted runner"
  echo "  Until then dispatch requests reach the server and fail on auth."
}

# ── 6. systemd service ─────────────────────────────────────────────────────────
if [ "$INSTALL_SERVICE" != "yes" ]; then
  echo "[6/6] --no-service: skipping systemd install."
  echo "  Run manually: HOST=$HOST PORT=$PORT node tools/mission-control/webhook-server.js"
  echo "-----------------------------------------------------------------"
  print_auth_todo
  exit 0
fi

echo "[6/6] Installing systemd service ($MODE)..."
# Build the PATH the service will use: user's local bins first, then system.
SVC_PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

render_unit() {
  sed \
    -e "s|__USER__|$(whoami)|g" \
    -e "s|__WORKDIR__|$REPO_ROOT|g" \
    -e "s|__PATH__|$SVC_PATH|g" \
    -e "s|__HOST__|$HOST|g" \
    -e "s|__NODE__|$NODE_BIN|g" \
    -e "s|__WANTEDBY__|$1|g" \
    "$TEMPLATE"
}

if [ "$MODE" = "user" ]; then
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  # User units must not carry a User= line.
  render_unit "default.target" | grep -v '^User=' > "$UNIT_DIR/claude-webhook.service"
  [ -n "$PUBLIC_URL" ] && sed -i "/Environment=HOST=/a Environment=PUBLIC_URL=$PUBLIC_URL" "$UNIT_DIR/claude-webhook.service"
  # Keep the service alive after logout / across reboot on a headless box.
  loginctl enable-linger "$(whoami)" 2>/dev/null || echo "  !! could not enable linger (service stops at logout)"
  systemctl --user daemon-reload
  systemctl --user enable --now claude-webhook.service
  echo "  status: systemctl --user status claude-webhook"
  echo "  logs:   journalctl --user -u claude-webhook -f"
else
  TMP_UNIT="$(mktemp)"
  render_unit "multi-user.target" > "$TMP_UNIT"
  [ -n "$PUBLIC_URL" ] && sed -i "/Environment=HOST=/a Environment=PUBLIC_URL=$PUBLIC_URL" "$TMP_UNIT"
  sudo cp "$TMP_UNIT" /etc/systemd/system/claude-webhook.service
  rm -f "$TMP_UNIT"
  sudo systemctl daemon-reload
  sudo systemctl enable --now claude-webhook.service
  echo "  status: sudo systemctl status claude-webhook"
  echo "  logs:   sudo journalctl -u claude-webhook -f"
fi

echo "-----------------------------------------------------------------"
echo "  Mission Control installed."
if [ "$HOST" = "127.0.0.1" ] || [ "$HOST" = "localhost" ]; then
  echo "  Bound to loopback. Reach it from your workstation with an SSH tunnel:"
  echo "    ssh -L $PORT:127.0.0.1:$PORT <user>@<server>"
  echo "  then open http://localhost:$PORT/panel?key=\$(cat $KEY_FILE)"
elif [ "$TAILSCALE_BIND" = "yes" ]; then
  echo "  Bound to the Tailscale address $HOST:$PORT."
  echo "  Reachable from any device on the tailnet, and from nothing else — the port"
  echo "  is opened on tailscale0 only, and no TLS cert is needed (WireGuard provides"
  echo "  transport encryption and device identity)."
  echo "  On your phone, open:"
  echo "    http://$HOST:$PORT/panel?key=\$(cat $KEY_FILE)"
  echo "  and use 'Add to Home Screen' to install it as a PWA."
  echo "  For HTTPS + a stable name instead of the raw IP: sudo tailscale serve --bg $PORT"
else
  echo "  Bound to $HOST:$PORT — put TLS + a trusted network in front (see"
  echo "  docs/mission-control-linux-deploy.md). Access key: $KEY_FILE"
fi
echo "-----------------------------------------------------------------"
print_auth_todo
echo "================================================================="

# ── Optional: daily self-update timer ──────────────────────────────────────────
if [ "$WITH_AUTO_UPDATE" = "yes" ] && [ "$INSTALL_SERVICE" = "yes" ]; then
  echo
  echo "Installing daily self-update timer..."
  UPD_SVC_TMPL="$SCRIPT_DIR/mission-control-update.service"
  UPD_TIMER_TMPL="$SCRIPT_DIR/mission-control-update.timer"
  render_update_unit() {
    sed \
      -e "s|__WORKDIR__|$REPO_ROOT|g" \
      -e "s|__MODE__|$MODE|g" \
      -e "s|__USER__|$(whoami)|g" \
      -e "s|__PATH__|$SVC_PATH|g" \
      "$UPD_SVC_TMPL"
  }
  if [ "$MODE" = "user" ]; then
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    render_update_unit > "$UNIT_DIR/mission-control-update.service"
    cp "$UPD_TIMER_TMPL" "$UNIT_DIR/mission-control-update.timer"
    systemctl --user daemon-reload
    systemctl --user enable --now mission-control-update.timer
    echo "  timer: systemctl --user list-timers mission-control-update"
  else
    TMP_SVC="$(mktemp)"; render_update_unit > "$TMP_SVC"
    sudo cp "$TMP_SVC" /etc/systemd/system/mission-control-update.service
    sudo cp "$UPD_TIMER_TMPL" /etc/systemd/system/mission-control-update.timer
    rm -f "$TMP_SVC"
    sudo systemctl daemon-reload
    sudo systemctl enable --now mission-control-update.timer
    echo "  timer: systemctl list-timers mission-control-update"
  fi
  echo "  runs daily ~04:00 -> git pull origin/main (ff-only) + restart service."
  if [ "$MODE" = "user" ]; then
    echo "  run once now:  systemctl --user start mission-control-update.service"
  else
    echo "  run once now:  sudo systemctl start mission-control-update.service"
  fi
elif [ "$WITH_AUTO_UPDATE" = "yes" ]; then
  echo "  (--with-auto-update ignored: needs the systemd service, not --no-service)"
fi

# ── Optional: co-locate the GitHub Actions self-hosted runner on this host ─────
if [ "$WITH_RUNNER" = "yes" ]; then
  echo
  echo "Installing GitHub Actions self-hosted runner on this host..."
  RUNNER_ARGS=()
  [ -n "$RUNNER_TOKEN" ] && RUNNER_ARGS+=(--token "$RUNNER_TOKEN")
  bash "$SCRIPT_DIR/install-runner.sh" "${RUNNER_ARGS[@]}"
fi
