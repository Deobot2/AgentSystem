#!/usr/bin/env bash
# install-actions-watchdog.sh — put tools/actions-watchdog.js on an hourly systemd --user timer.
#
# The point of the watchdog is to live OUTSIDE GitHub Actions (#197), so it is installed on the
# host rather than as a workflow. User units, not system units: no sudo, and `gh` is already
# authenticated as this user. Lingering is enabled so the timer keeps firing after logout.
#
#   bash tools/install-actions-watchdog.sh            # install + start
#   bash tools/install-actions-watchdog.sh --uninstall
set -euo pipefail

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME=actions-watchdog

if [ "${1:-}" = "--uninstall" ]; then
  systemctl --user disable --now "$NAME.timer" 2>/dev/null || true
  rm -f "$UNIT_DIR/$NAME.service" "$UNIT_DIR/$NAME.timer"
  systemctl --user daemon-reload
  echo "removed $NAME.timer"
  exit 0
fi

command -v gh >/dev/null || { echo "gh not on PATH — the watchdog needs it"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh is not authenticated — run 'gh auth login' first"; exit 1; }

mkdir -p "$UNIT_DIR"

# PATH is set explicitly: a systemd user unit gets a minimal environment, and both `node` and `gh`
# must resolve. Inheriting the caller's PATH is what makes this work on a host where node came
# from nvm or a tarball rather than /usr/bin.
cat > "$UNIT_DIR/$NAME.service" <<UNIT
[Unit]
Description=GitHub Actions liveness watchdog (runs off Actions, see #197)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$REPO_ROOT
Environment=PATH=$PATH
Environment=HOME=$HOME
ExecStart=$(command -v node) $REPO_ROOT/tools/actions-watchdog.js
# 3 = outage detected and alert raised. That is the watchdog working, not the unit failing, so
# systemd must not mark it failed and must not back off.
SuccessExitStatus=0 3
UNIT

cat > "$UNIT_DIR/$NAME.timer" <<'UNIT'
[Unit]
Description=Hourly GitHub Actions liveness check

[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
# Catch up after the host was off, so a reboot does not open a silent gap in the one check that
# exists to notice silent gaps.
Persistent=true

[Install]
WantedBy=timers.target
UNIT

loginctl enable-linger "$(whoami)" 2>/dev/null || echo "  !! could not enable linger — the timer will stop at logout"
systemctl --user daemon-reload
systemctl --user enable --now "$NAME.timer"

echo "installed: $NAME.timer (hourly)"
systemctl --user list-timers "$NAME.timer" --no-pager
