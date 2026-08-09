#!/usr/bin/env bash
# install-brain-sync-timer.sh — run the agent-memory sync on a ~15 minute systemd --user timer (#341).
#
# The hooks in HOOK_REGISTRY cover a host with sessions on it. They do not cover Mission Control,
# which writes memory from cron with no Claude session ever open — and that is precisely the host
# that drifted until a weekly job hit ~250 conflicting nodes at once (#340). A timer is the only
# trigger that reaches a machine nobody is sitting at.
#
# User units, not system units: no sudo, and the checkout, the brain and `gh` all belong to this
# user. Lingering is enabled so the timer keeps firing after logout — same reason as
# install-actions-watchdog.sh, and the reason a plain cron entry under an interactive session
# would not have covered the failing host either.
#
#   bash tools/install-brain-sync-timer.sh              # install + start
#   bash tools/install-brain-sync-timer.sh --dry-run    # print the units, change nothing
#   bash tools/install-brain-sync-timer.sh --check      # exit 1 if the units drifted or the timer is not running
#   bash tools/install-brain-sync-timer.sh --check-units # the same, minus the liveness half (tests)
#   bash tools/install-brain-sync-timer.sh --uninstall
set -euo pipefail

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME=brain-sync
INTERVAL="${BRAIN_SYNC_INTERVAL:-15min}"
NODE_BIN="$(command -v node || echo /usr/bin/node)"

MODE="${1:-install}"

service_unit() {
cat <<UNIT
[Unit]
Description=Agent memory continuous sync (see #341)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$REPO_ROOT
# PATH is set explicitly: a systemd user unit gets a minimal environment, and both node and gh must
# resolve. Inheriting the caller's PATH is what makes this work where node came from nvm.
# Quoted, and every % doubled: systemd reads % in a unit value as a specifier (%h, %i, %%…), so a
# PATH containing one — a Windows-style dir under WSL, a directory with a literal % in its name —
# either expands to something else or makes systemd reject the whole unit at load.
Environment="PATH=${PATH//%/%%}"
Environment="HOME=${HOME//%/%%}"
ExecStart=$NODE_BIN $REPO_ROOT/tools/brain-sync-run.js
# 3 = a merge conflict was found and a human-needed alert was raised. That is the sync working as
# designed — it refuses to resolve user data on its own — so systemd must not mark the unit failed
# and back off. Same convention as actions-watchdog.service.
SuccessExitStatus=0 3
UNIT
}

timer_unit() {
cat <<UNIT
[Unit]
Description=Agent memory sync every $INTERVAL (covers hosts with no Claude session, see #341)

[Timer]
OnBootSec=2min
OnUnitActiveSec=$INTERVAL
# Catch up after the host was off. A machine that misses a day of syncs is exactly how the
# divergence in #340 got large enough to need a human.
Persistent=true

[Install]
WantedBy=timers.target
UNIT
}

case "$MODE" in
  --uninstall)
    systemctl --user disable --now "$NAME.timer" 2>/dev/null || true
    rm -f "$UNIT_DIR/$NAME.service" "$UNIT_DIR/$NAME.timer"
    systemctl --user daemon-reload 2>/dev/null || true
    echo "removed $NAME.timer"
    exit 0
    ;;

  --dry-run)
    echo "would write $UNIT_DIR/$NAME.service:"; service_unit | sed 's/^/  /'
    echo "would write $UNIT_DIR/$NAME.timer:";   timer_unit   | sed 's/^/  /'
    echo "would run: loginctl enable-linger $(whoami)"
    echo "would run: systemctl --user enable --now $NAME.timer"
    exit 0
    ;;

  --check|--check-units)
    # Checked by meaning, not by byte-equality against what this run would generate. Two things in
    # the unit are environment-derived — the absolute repo path and the inherited PATH — so a
    # `diff` passes for the person who installed it and fails for everyone else, including the CI
    # job, whose checkout lives in the runner workspace. A check that is red on a healthy host gets
    # muted, and a muted check is the outage it was supposed to find.
    #
    # So assert what actually has to hold: the units exist, the service still points at a
    # brain-sync-run.js that is on disk, the conflict exit code is still not treated as failure,
    # and the timer still repeats. That still catches the stale-unit case — a task pointing at a
    # moved or deleted checkout, which looks perfectly healthy in `systemctl status`.
    drift=0
    svc="$UNIT_DIR/$NAME.service"
    tmr="$UNIT_DIR/$NAME.timer"

    if [ ! -f "$svc" ]; then
      echo "missing    $svc"; drift=1
    else
      # `|| true`: under `set -e` a grep that matches nothing exits 1 and kills the whole check
      # mid-way, so a service file that had lost its ExecStart line — real drift, the exact thing
      # being looked for — would abort the script before it could report it, and an aborted check
      # reads as a failed one with no explanation. Missing is handled below, as a value.
      exec_line="$(grep -m1 '^ExecStart=' "$svc" | cut -d= -f2- || true)"
      script_path="$(printf '%s\n' "$exec_line" | awk '{print $2}')"
      if [ -z "$script_path" ] || [ ! -f "$script_path" ]; then
        echo "drift      $svc runs a script that is not there: ${script_path:-<none>}"; drift=1
      elif ! grep -q '^SuccessExitStatus=0 3' "$svc"; then
        echo "drift      $svc lost SuccessExitStatus=0 3 — a raised conflict alert would read as a unit failure"; drift=1
      else
        echo "in sync    $svc -> $script_path"
      fi
    fi

    if [ ! -f "$tmr" ]; then
      echo "missing    $tmr"; drift=1
    elif ! grep -q '^OnUnitActiveSec=' "$tmr"; then
      echo "drift      $tmr has no repeat interval — it would fire once and never again"; drift=1
    else
      echo "in sync    $tmr ($(grep -m1 '^OnUnitActiveSec=' "$tmr" | cut -d= -f2))"
    fi
    # Liveness second: `systemctl --user` from a service account with no D-Bus session errors out
    # for reasons that have nothing to do with drift, so an unreachable bus is reported and not
    # counted — a check that cries wolf gets ignored, which is how a real outage hides. When the bus
    # IS reachable, units-on-disk-but-not-enabled is drift, and the most likely kind: that is the
    # installed-but-inert shape the whole check exists for.
    #
    # --check-units skips this half. It is for callers holding a fabricated unit pair with no
    # systemd behind it (the tests), where "not running" says nothing. Never use it in the daily
    # job — a green check on a timer that is not scheduled is the outage reported as health.
    if [ "$MODE" = '--check-units' ]; then
      echo "skipped    timer liveness (--check-units)"
    elif systemctl --user list-timers "$NAME.timer" --no-pager >/dev/null 2>&1; then
      if systemctl --user is-active "$NAME.timer" >/dev/null 2>&1; then
        echo "active     $NAME.timer"
      else
        echo "INACTIVE   $NAME.timer — units are on disk but the timer is not running"
        drift=1
      fi
    else
      echo "unknown    cannot reach the user systemd bus — timer state not checked"
    fi
    exit "$drift"
    ;;

  install|"")
    mkdir -p "$UNIT_DIR"
    service_unit > "$UNIT_DIR/$NAME.service"
    timer_unit   > "$UNIT_DIR/$NAME.timer"
    loginctl enable-linger "$(whoami)" 2>/dev/null \
      || echo "  !! could not enable linger — the timer will stop at logout, which defeats the point"
    systemctl --user daemon-reload
    systemctl --user enable --now "$NAME.timer"
    echo "installed: $NAME.timer (every $INTERVAL)"
    systemctl --user list-timers "$NAME.timer" --no-pager
    ;;

  *)
    echo "unknown option: $MODE (try --dry-run, --check, --uninstall)" >&2
    exit 2
    ;;
esac
