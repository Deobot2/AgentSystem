#!/bin/bash
# install-local.sh — Mission Control installer for a headless Linux server (Ubuntu/Debian).
#
# Installs the webhook server as a systemd service, generates a bearer key, and
# provisions the repo allowlist. Safe by default: binds loopback-only unless you
# explicitly opt into LAN/public exposure.
#
# Usage:
#   bash tools/mission-control/install-local.sh [options]
#
# Options:
#   --user            Install as a systemd --user service (no sudo; needs linger).
#                     Default is a system service under /etc/systemd/system.
#   --lan             Bind 0.0.0.0 (reachable on the LAN). Implies a firewall port open.
#   --bind <addr>     Bind a specific address (e.g. a Tailscale IP). Overrides --lan.
#   --tailscale       Bind this host's Tailscale IPv4 — reachable from any device on
#                     the tailnet, unreachable from the LAN or the internet. This is
#                     the recommended way to get phone access: WireGuard already
#                     provides transport encryption and device identity, so no TLS
#                     cert and no firewall hole are needed.
#   --port <n>        Listen port (default 8765).
#   --public-url <u>  Externally-reachable base URL to advertise (behind a proxy/Tailscale),
#                     e.g. https://mc.example.com. Sets PUBLIC_URL in the unit.
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
PORT="8765"
PUBLIC_URL=""
INSTALL_SERVICE="yes"
FIREWALL="no"        # open a firewall port only when binding non-loopback
WITH_RUNNER="no"
RUNNER_TOKEN=""
WITH_AUTO_UPDATE="no"
TAILSCALE_BIND="no"

# ── Parse args ───────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --user)         MODE="user"; shift ;;
    --lan)          HOST="0.0.0.0"; FIREWALL="yes"; shift ;;
    --bind)         HOST="$2"; FIREWALL="yes"; shift 2 ;;
    --tailscale)
      command -v tailscale >/dev/null 2>&1 || { echo "--tailscale: tailscale not installed" >&2; exit 2; }
      HOST="$(tailscale ip -4 2>/dev/null | head -n1)"
      [ -n "$HOST" ] || { echo "--tailscale: no Tailscale IPv4 (is 'tailscale up' done?)" >&2; exit 2; }
      # Deliberately no firewall hole: the port is bound to the tailscale0 address
      # only, so it is not reachable from the LAN and UFW has nothing to open.
      FIREWALL="no"; TAILSCALE_BIND="yes"; shift ;;
    --port)         PORT="$2"; shift 2 ;;
    --public-url)   PUBLIC_URL="$2"; shift 2 ;;
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
echo "[1/6] Checking dependencies..."
apt_install() {
  if command -v apt-get &>/dev/null; then
    sudo apt-get update -qq && sudo apt-get install -y "$@"
  else
    echo "  !! apt-get not found — install '$*' manually" >&2
  fi
}
command -v git  &>/dev/null || apt_install git
command -v tmux &>/dev/null || apt_install tmux
if ! command -v node &>/dev/null; then
  echo "  Installing Node.js 22 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
NODE_BIN="$(command -v node)"
echo "  node: $NODE_BIN ($(node --version))"

# The server shells out to the claude CLI — warn loudly if it is missing.
if command -v claude &>/dev/null; then
  echo "  claude CLI: $(command -v claude)"
elif [ -x "$HOME/.local/bin/claude" ]; then
  echo "  claude CLI: $HOME/.local/bin/claude"
else
  echo "  !! claude CLI not found on PATH or ~/.local/bin — POST /run will fail"
  echo "     until it is installed. Continuing so the service is ready for it."
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
  SLUG="$(basename "$REPO_ROOT")"
  cat > "$REPOS_FILE" <<JSON
{
  "$SLUG": { "path": "$REPO_ROOT" }
}
JSON
  echo "  seeded $REPOS_FILE with '$SLUG' -> $REPO_ROOT"
  echo "  (edit this file to allow more repos for remote dispatch)"
else
  echo "  reusing existing $REPOS_FILE"
fi

# ── 5. Firewall (only when binding beyond loopback) ────────────────────────────
if [ "$FIREWALL" = "yes" ] && command -v ufw &>/dev/null; then
  echo "[5/6] Opening port $PORT in UFW..."
  sudo ufw allow "$PORT/tcp" || true
else
  echo "[5/6] Firewall: no change (loopback bind or UFW absent)."
fi

# ── 6. systemd service ─────────────────────────────────────────────────────────
if [ "$INSTALL_SERVICE" != "yes" ]; then
  echo "[6/6] --no-service: skipping systemd install."
  echo "  Run manually: HOST=$HOST PORT=$PORT node tools/mission-control/webhook-server.js"
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
  echo "  Reachable from any device on the tailnet, and from nothing else — no"
  echo "  firewall hole was opened and no TLS cert is needed (WireGuard provides"
  echo "  transport encryption and device identity)."
  echo "  On your phone, open:"
  echo "    http://$HOST:$PORT/panel?key=\$(cat $KEY_FILE)"
  echo "  and use 'Add to Home Screen' to install it as a PWA."
else
  echo "  Bound to $HOST:$PORT — put TLS + a trusted network in front (see"
  echo "  docs/mission-control-linux-deploy.md). Access key: $KEY_FILE"
fi
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
