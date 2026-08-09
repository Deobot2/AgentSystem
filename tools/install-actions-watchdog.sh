#!/usr/bin/env bash
# install-actions-watchdog.sh — put the off-Actions CI watchdogs on an hourly systemd --user timer.
#
# Two checks share the unit, because they answer the same question from opposite ends:
#   tools/actions-watchdog.js     — is Actions running at all? (#197)
#   tools/pr-checks-watchdog.js   — is any open PR against main producing no required checks?
#
# The point of both is to live OUTSIDE GitHub Actions (#197), so they are installed on the
# host rather than as a workflow. User units, not system units: no sudo, and `gh` is already
# authenticated as this user. Lingering is enabled so the timer keeps firing after logout.
#
#   bash tools/install-actions-watchdog.sh              # install + start
#   bash tools/install-actions-watchdog.sh --dry-run    # print the units, change nothing
#   bash tools/install-actions-watchdog.sh --check      # exit 1 if the units drifted or the timer is not running
#   bash tools/install-actions-watchdog.sh --check-units # the same, minus the liveness half (tests)
#   bash tools/install-actions-watchdog.sh --uninstall
#
# install exit codes: 0 = units written AND the timer is enabled and active. 4 = units were written
# to disk but the systemd --user bus was unreachable (or enable failed), so the timer is NOT running
# and a human must finish it at a console. 5 = `gh` is missing or unauthenticated for THIS user, so
# nothing was written: both watchdogs shell out to `gh`, and a timer installed against an
# unauthenticated `gh` fires hourly, fails hourly, and stamps no heartbeat — installed-but-inert
# wearing a green systemctl status. Anything else non-zero means the units could not be written.
#
# ── Why --check exists (#361) ────────────────────────────────────────────────────────────────
# `enforcement-drift-check.yml` can only observe this timer indirectly, through the heartbeat
# actions-watchdog.js stamps into ~/agent-memory (#313). "Heartbeat missing or stale" is one message
# covering four very different faults: never installed, units present but never enabled, units
# pointing at a checkout that moved, or `gh` unauthenticated so every run dies before the stamp.
# --check names which. Without it, runner-maintenance.yml's repair-install could install this timer
# but could not verify it — and a repair step that cannot verify itself is a paper check.
set -euo pipefail

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME=actions-watchdog
NODE_BIN="$(command -v node || echo /usr/bin/node)"

# The two scripts the unit runs, in ExecStart order. --check asserts every one of them is still on
# disk: the unit carries two ExecStart lines, and a check that only read the first would call a
# service healthy while half of it pointed into a deleted checkout.
SCRIPTS=(tools/actions-watchdog.js tools/pr-checks-watchdog.js)

MODE="${1:-install}"

service_unit() {
cat <<UNIT
[Unit]
Description=GitHub Actions + PR check watchdogs (run off Actions, see #197)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$REPO_ROOT
# PATH is set explicitly: a systemd user unit gets a minimal environment, and both \`node\` and \`gh\`
# must resolve. Inheriting the caller's PATH is what makes this work on a host where node came
# from nvm or a tarball rather than /usr/bin.
# Quoted, and every % doubled: systemd reads % in a unit value as a specifier (%h, %i, %%…), so a
# PATH containing one either expands to something else or makes systemd reject the whole unit at
# load — a unit that will not load is a watchdog that never fires on a host where everything else
# looks installed. Same treatment as brain-sync.service.
Environment="PATH=${PATH//%/%%}"
Environment="HOME=${HOME//%/%%}"
ExecStart=$NODE_BIN $REPO_ROOT/${SCRIPTS[0]}
ExecStart=$NODE_BIN $REPO_ROOT/${SCRIPTS[1]}
# 3 = problem detected and alert raised, from either script. That is a watchdog working, not the
# unit failing, so systemd must not mark it failed and must not back off. Both use the same code
# so a raised alert in the first ExecStart still lets the second one run.
SuccessExitStatus=0 3
UNIT
}

timer_unit() {
cat <<'UNIT'
[Unit]
Description=Hourly off-Actions CI health checks (Actions liveness + unchecked PRs)

[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
# Catch up after the host was off, so a reboot does not open a silent gap in the one check that
# exists to notice silent gaps.
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
    # Checked by MEANING, not byte-equality against what this run would generate — same reasoning as
    # install-brain-sync-timer.sh. Two things in the unit are environment-derived (the absolute repo
    # path and the inherited PATH), so a `diff` passes for whoever installed it and fails for the CI
    # job, whose checkout lives in the runner workspace. A check that is red on a healthy host gets
    # muted, and a muted check is the outage it was supposed to find.
    drift=0
    svc="$UNIT_DIR/$NAME.service"
    tmr="$UNIT_DIR/$NAME.timer"

    if [ ! -f "$svc" ]; then
      echo "missing    $svc"; drift=1
    else
      # `|| true` on every grep: under `set -e` a grep that matches nothing exits 1 and kills the
      # check mid-way, so a service that had LOST its ExecStart lines — real drift, the exact thing
      # being looked for — would abort before it could be reported, and an aborted check reads as a
      # broken check rather than a found fault.
      exec_lines="$(grep '^ExecStart=' "$svc" || true)"
      if [ -z "$exec_lines" ]; then
        echo "drift      $svc has no ExecStart at all — the unit runs nothing"; drift=1
      else
        n=0
        while IFS= read -r line; do
          [ -n "$line" ] || continue
          n=$((n + 1))
          script_path="$(printf '%s\n' "${line#ExecStart=}" | awk '{print $2}')"
          if [ -z "$script_path" ] || [ ! -f "$script_path" ]; then
            echo "drift      $svc runs a script that is not there: ${script_path:-<none>}"; drift=1
          else
            echo "in sync    $svc -> $script_path"
          fi
        done <<< "$exec_lines"
        # Both watchdogs ride this one unit on purpose. If a unit written by an older revision (or
        # by hand) carries only one, the PR-checks half is silently not running — which looks
        # exactly like health, because the Actions half still stamps the heartbeat.
        if [ "$n" -lt "${#SCRIPTS[@]}" ]; then
          echo "drift      $svc has $n ExecStart line(s), expected ${#SCRIPTS[@]} (${SCRIPTS[*]}) — one watchdog is not running"; drift=1
        fi
      fi

      if ! grep -q '^SuccessExitStatus=0 3' "$svc"; then
        echo "drift      $svc lost SuccessExitStatus=0 3 — a raised alert would read as a unit failure and systemd would back the timer off"; drift=1
      fi
    fi

    if [ ! -f "$tmr" ]; then
      echo "missing    $tmr"; drift=1
    elif ! grep -q '^OnUnitActiveSec=' "$tmr"; then
      echo "drift      $tmr has no repeat interval — it would fire once and never again"; drift=1
    else
      echo "in sync    $tmr ($(grep -m1 '^OnUnitActiveSec=' "$tmr" | cut -d= -f2))"
    fi

    # `gh` is checked here and not only at install time: an install that succeeded a month ago on an
    # authenticated host is indistinguishable from a dead timer once the token expires — both show a
    # missing heartbeat and nothing else. Reported, and counted as drift, because a watchdog that
    # cannot call the API is not watching anything. --check-units skips it for the same reason it
    # skips liveness: the tests hold fabricated units with no gh, no systemd and no host behind them.
    if [ "$MODE" = '--check-units' ]; then
      echo "skipped    gh auth and timer liveness (--check-units)"
      exit "$drift"
    fi

    if ! command -v gh >/dev/null 2>&1; then
      echo "drift      gh is not on PATH — both watchdogs shell out to it, so every run dies before it can stamp a heartbeat"; drift=1
    elif ! gh auth status >/dev/null 2>&1; then
      echo "drift      gh is not authenticated for $(whoami) — the timer fires hourly and fails hourly, leaving no heartbeat"; drift=1
    else
      echo "in sync    gh is authenticated"
    fi

    # Liveness last: `systemctl --user` from a service account with no D-Bus errors out for reasons
    # that have nothing to do with drift, so an unreachable bus is REPORTED and not counted — a check
    # that cries wolf gets ignored, which is how a real outage hides. When the bus IS reachable,
    # units-on-disk-but-not-enabled is drift, and the most likely kind: it is the installed-but-inert
    # shape this whole check exists for, and the shape #361 is most likely to be.
    if systemctl --user list-timers "$NAME.timer" --no-pager >/dev/null 2>&1; then
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
    command -v gh >/dev/null || {
      echo "gh is not on PATH — both watchdogs shell out to it, so nothing was installed" >&2
      echo "install gh on this host as $(whoami), then re-run: bash tools/install-actions-watchdog.sh" >&2
      exit 5
    }
    # Deliberately NOT given a GH_TOKEN by any caller, including runner-maintenance.yml: the unit
    # runs as this user with only PATH and HOME, so a token injected into the installing process
    # would prove authentication the timer will never have.
    gh auth status >/dev/null 2>&1 || {
      echo "gh is not authenticated as $(whoami) — nothing was installed" >&2
      echo "a human must run this at a console on $(hostname) as $(whoami): gh auth login" >&2
      exit 5
    }

    mkdir -p "$UNIT_DIR"
    service_unit > "$UNIT_DIR/$NAME.service"
    timer_unit   > "$UNIT_DIR/$NAME.timer"

    who="$(whoami)"
    # Best effort, but report the outcome rather than swallowing it. Enabling linger is what starts
    # the user manager and creates /run/user/<uid>; on a service account that has never logged in
    # interactively, that is usually *why* the bus below is unreachable.
    if loginctl enable-linger "$who" 2>/dev/null; then
      echo "linger enabled for $who"
    else
      echo "  !! could not enable linger — the timer will stop at logout, which defeats the point"
    fi

    # Guarded, not chained, and systemd's own stderr is CAPTURED rather than discarded: the host this
    # targets refuses ssh, so this text is the only diagnostic that will ever exist, and "Failed to
    # connect to bus" needs a different fix from a masked unit or one systemd rejected at load.
    bus_ok=1
    bus_err=""
    if ! bus_err="$(systemctl --user daemon-reload 2>&1)"; then
      bus_ok=0
    elif ! bus_err="$(systemctl --user enable --now "$NAME.timer" 2>&1)"; then
      bus_ok=0
    fi

    if [ "$bus_ok" = 0 ]; then
      echo "units written to $UNIT_DIR/$NAME.{service,timer} but NOT enabled — systemd --user is unreachable in this session (or enable failed)" >&2
      echo "systemd said: ${bus_err:-<no output>}" >&2
      echo "a human must run this at a console: loginctl enable-linger $who && systemctl --user daemon-reload && systemctl --user enable --now $NAME.timer" >&2
      exit 4
    fi

    echo "installed: $NAME.timer (hourly)"
    systemctl --user list-timers "$NAME.timer" --no-pager
    ;;

  *)
    echo "unknown option: $MODE (try --dry-run, --check, --check-units, --uninstall)" >&2
    exit 2
    ;;
esac
