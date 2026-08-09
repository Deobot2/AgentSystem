#!/bin/bash
# deploy-private-skills.sh — ship the gitignored life-OS skills to a host and install them.
#
# skills/daily-briefing/ and skills/daily-triage/ are gitignored (.gitignore, #187): private
# life-OS content that must never hit GitHub. That means a `git clone` on the Mission Control
# server does NOT contain them, and the 07:00 daily-triage job hard-fails on a missing
# SKILL.md. This script is the transport that git deliberately isn't.
#
# Transport is tar-over-ssh, not rsync: Git Bash on Windows ships ssh but not rsync, and this
# is run from a Windows laptop as often as from Linux.
#
# Because the skills live only on the hosts that hold them, the copies can silently FORK: an
# edit made on the server is invisible here, and a routine deploy from here would overwrite it
# with older text and no output at all. That is #298 — it re-opened #257, whose fix had been
# applied on the server and never travelled back. So every deploy first compares content hashes
# and mtimes against the target and REFUSES to overwrite a remote copy that is both different
# and newer. Overwriting is still available, but only by typing --force.
#
# Usage:
#   bash tools/deploy-private-skills.sh --check                  # verify THIS host only
#   bash tools/deploy-private-skills.sh --local                  # install on THIS host
#   bash tools/deploy-private-skills.sh --host <user@host>       # ship + install remotely
#   bash tools/deploy-private-skills.sh --host <user@host> --check   # + cross-host drift report
#
# Options:
#   --host <user@host>  Target. Omit to operate on this host.
#   --path <dir>        Remote checkout to copy into. Default: ~/dev/AgentSystem.
#   --life <dir>        Remote LIFE_REPO root to create briefings/ + closeouts/ under.
#                       Default: ~/life. Must match $LIFE_REPO on the target.
#   --local             Operate on this host (same as omitting --host).
#   --check             Verify only; copy nothing, install nothing. Exit 1 on any gap.
#                       With --host, also reports cross-host content drift.
#   --force             Deploy even when the target holds newer, different content.
#                       Only correct when you have already reconciled by hand.
#   -h | --help         Show this help.
#
# Env:
#   SKILL_DEPLOY_SSH    ssh command to use. Default `ssh`. Exists so the guard can be tested
#                       against a fake host — same idea as GIT_SSH_COMMAND.
#
# Idempotent. Re-run after every edit to either skill — there is no auto-sync.

set -euo pipefail

HOST=""
REMOTE_PATH='$HOME/dev/AgentSystem'
LIFE_DIR='$HOME/life'
CHECK=0
FORCE=0
SSH_CMD="${SKILL_DEPLOY_SSH:-ssh}"

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:?--host needs user@host}"; shift 2 ;;
    --path) REMOTE_PATH="${2:?--path needs a dir}"; shift 2 ;;
    --life) LIFE_DIR="${2:?--life needs a dir}"; shift 2 ;;
    --local) HOST=""; shift ;;
    --check) CHECK=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

# $SSH_CMD may carry arguments (`ssh -F alt_config`), so it must word-split — deliberate.
ssh_run() { # ssh_run <host> <remote-command>  [stdin passes through]
  # shellcheck disable=SC2086
  $SSH_CMD "$@"
}

SKILLS=(daily-briefing daily-triage)
repo_root="$(cd "$(dirname "$0")/.." && pwd)"

# ---------------------------------------------------------------- local presence

missing=0
for s in "${SKILLS[@]}"; do
  f="$repo_root/skills/$s/SKILL.md"
  if [ -f "$f" ]; then
    printf 'local  ok      skills/%s/SKILL.md (%s bytes)\n' "$s" "$(wc -c <"$f" | tr -d ' ')"
  else
    printf 'local  MISSING skills/%s/SKILL.md\n' "$s" >&2
    missing=1
  fi
done
# The stage-1 prompt and the stage1<->stage2 contract are load-bearing, not docs: daily-triage
# parses the handoff per handoff-schema.md, and daily-briefing/SKILL.md executes portable-prompt.
for f in skills/daily-briefing/portable-prompt.md skills/daily-briefing/handoff-schema.md; do
  if [ -f "$repo_root/$f" ]; then printf 'local  ok      %s\n' "$f"
  else printf 'local  MISSING %s\n' "$f" >&2; missing=1; fi
done

if [ "$missing" = 1 ]; then
  echo >&2
  echo "Refusing to deploy: the private skills are absent from this working copy." >&2
  echo "They are gitignored, so they exist only where they were authored. Find that host," >&2
  echo "or re-author them — a partial deploy leaves the 07:00 job failing either way." >&2
  exit 1
fi

# ---------------------------------------------------------------- cross-host drift guard
#
# The pre-existing --check compares source-vs-installed *within a single host*, so it is
# structurally blind to the failure that actually happened: two hosts, each internally
# consistent, holding different content. Nothing compared across the ssh boundary, so a deploy
# overwrote a newer remote fix and printed only its usual success text (#298 / #257).
#
# So: hash both sides, and refuse when the target's copy differs AND is newer than ours.
# Different-but-older is the normal deploy direction and only gets a line of output.
#
# Content comes from the hash; only the *direction* comes from mtime. So the transport has to
# preserve mtime — tar does, in both directions, which is another reason the pull suggested in
# the abort message is a tar and not a `cp`. A copy made with plain `cp` reads as brand new and
# would look authoritative when it is not.

# Every file the tar actually ships — not just SKILL.md. portable-prompt.md and
# handoff-schema.md are load-bearing too, and can fork exactly the same way.
mapfile -t SHIPPED < <(cd "$repo_root" && find "${SKILLS[@]/#/skills/}" -type f | sort)

hash_of()  { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }
mtime_of() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }
fmt_time() {
  date -u -d "@$1" '+%Y-%m-%d %H:%M:%SZ' 2>/dev/null \
    || date -u -r "$1" '+%Y-%m-%d %H:%M:%SZ' 2>/dev/null \
    || echo "epoch $1"
}

# Let the target enumerate its own files rather than shipping it a list: no quoting of local
# paths across the ssh boundary, and it also surfaces files that exist there and not here.
remote_manifest() {
  ssh_run "$HOST" "bash -s" <<REMOTE_EOF
cd "$REMOTE_PATH" 2>/dev/null || exit 0
find skills/daily-briefing skills/daily-triage -type f 2>/dev/null | sort | while read -r f; do
  h=\$(sha256sum "\$f" 2>/dev/null | cut -d' ' -f1)
  m=\$(stat -c %Y "\$f" 2>/dev/null || stat -f %m "\$f" 2>/dev/null || echo 0)
  printf '%s %s %s\n' "\$h" "\$m" "\$f"
done
REMOTE_EOF
}

declare -A R_HASH R_MTIME
load_remote_manifest() {
  local h m f
  while read -r h m f; do
    [ -n "${f:-}" ] || continue
    R_HASH["$f"]="$h"; R_MTIME["$f"]="$m"
  done < <(remote_manifest)
}

# 0 = nothing newer on the target; 1 = at least one file is newer there and would be clobbered.
drift_report() {
  local newer=0 f lh rh lmt rmt
  for f in "${SHIPPED[@]}"; do
    rh="${R_HASH[$f]:-}"
    if [ -z "$rh" ]; then
      printf 'drift  new     %s (not on %s yet)\n' "$f" "$HOST"
      continue
    fi
    lh="$(hash_of "$repo_root/$f")"
    [ "$lh" = "$rh" ] && { printf 'drift  same    %s\n' "$f"; continue; }
    lmt="$(mtime_of "$repo_root/$f")"; rmt="${R_MTIME[$f]:-0}"
    if [ "$rmt" -gt "$lmt" ]; then
      {
        printf 'drift  NEWER   %s — the copy on %s is different AND newer\n' "$f" "$HOST"
        printf '                 local   %s  %s\n' "$(fmt_time "$lmt")" "$repo_root/$f"
        printf '                 %-7s %s  %s\n' "$HOST" "$(fmt_time "$rmt")" "$REMOTE_PATH/$f"
      } >&2
      newer=1
    else
      printf 'drift  older   %s (differs on %s but is older; deploy would replace it)\n' "$f" "$HOST"
    fi
  done
  return "$newer"
}

# ---------------------------------------------------------------- install helper
#
# Emitted as a script so the local and remote paths run byte-identical logic.
installer() {
  cat <<'REMOTE_EOF'
set -euo pipefail
root="__ROOT__"
life="__LIFE__"
cd "$root" || { echo "no checkout at $root" >&2; exit 1; }
for s in daily-briefing daily-triage; do
  [ -f "skills/$s/SKILL.md" ] || { echo "target MISSING skills/$s/SKILL.md" >&2; exit 1; }
done
mkdir -p "$life/briefings" "$life/closeouts"
# install-skills.js copies skills/<n>/SKILL.md into ~/.claude/skills/. Both names are in its
# CORE list, so a bare run picks them up; naming them explicitly makes the failure loud if the
# CORE list ever changes.
node tools/install-skills.js daily-briefing daily-triage
for s in daily-briefing daily-triage; do
  [ -f "$HOME/.claude/skills/$s/SKILL.md" ] || { echo "install FAILED for $s" >&2; exit 1; }
  echo "target ok      ~/.claude/skills/$s/SKILL.md"
done
echo "target ok      $life/{briefings,closeouts}"
REMOTE_EOF
}

run_installer() {
  local script
  script="$(installer | sed "s|__ROOT__|$1|; s|__LIFE__|$2|")"
  if [ -z "$HOST" ]; then bash -c "$script"; else ssh_run "$HOST" "bash -s" <<<"$script"; fi
}

# ---------------------------------------------------------------- act

if [ -z "$HOST" ]; then
  target_root="$repo_root"
  # $HOME is unexpanded in the defaults so it resolves on the *target*; expand it here.
  life_resolved="$(eval echo "$LIFE_DIR")"
  if [ "$CHECK" = 1 ]; then
    # Same two things the remote --check reports: source present (above) and installed copy
    # present. A check that only proves the source exists says nothing about whether the 07:00
    # job can find it.
    gaps=0
    for s in "${SKILLS[@]}"; do
      if [ -f "$HOME/.claude/skills/$s/SKILL.md" ]; then
        printf 'target ok      %s\n' "$HOME/.claude/skills/$s/SKILL.md"
      else
        printf 'target MISSING %s\n' "$HOME/.claude/skills/$s/SKILL.md" >&2; gaps=1
      fi
    done
    for d in "$life_resolved/briefings" "$life_resolved/closeouts"; do
      if [ -d "$d" ]; then printf 'target ok      %s\n' "$d"
      else printf 'target MISSING %s\n' "$d" >&2; gaps=1; fi
    done
    [ "$gaps" = 1 ] && echo "Run without --check to install into ~/.claude/skills." >&2
    exit "$gaps"
  fi
  run_installer "$target_root" "$life_resolved"
  echo
  echo "Installed on this host."
  exit 0
fi

if [ "$CHECK" = 1 ]; then
  # Report every gap in one pass rather than exiting on the first — a check that stops at the
  # first problem makes you re-run it three times to see three problems.
  gaps=0
  ssh_run "$HOST" "bash -s" <<REMOTE_EOF || gaps=1
gaps=0
for s in daily-briefing daily-triage; do
  for f in "$REMOTE_PATH/skills/\$s/SKILL.md" "\$HOME/.claude/skills/\$s/SKILL.md"; do
    if [ -f "\$f" ]; then echo "target ok      \$f"; else echo "target MISSING \$f"; gaps=1; fi
  done
done
for d in "$LIFE_DIR/briefings" "$LIFE_DIR/closeouts"; do
  if [ -d "\$d" ]; then echo "target ok      \$d"; else echo "target MISSING \$d"; gaps=1; fi
done
exit \$gaps
REMOTE_EOF
  # Presence is not agreement. Compare content too, or --check keeps passing while the two
  # hosts drift apart — which is exactly how #298 stayed invisible.
  load_remote_manifest
  drift_report || {
    echo >&2
    echo "Content drift: $HOST holds newer text than this host (see above)." >&2
    echo "Deploying from here would overwrite it. Reconcile before you deploy." >&2
    gaps=1
  }
  exit "$gaps"
fi

# ---------------------------------------------------------------- guard, then ship
#
# This runs BEFORE the tar. An overwrite that destroys a newer fix must not be recoverable-only
# after the fact — it has to not happen.
load_remote_manifest
if ! drift_report; then
  if [ "$FORCE" = 1 ]; then
    echo >&2
    echo "--force given: overwriting newer content on $HOST anyway." >&2
  else
    echo >&2
    echo "Refusing to deploy: $HOST holds content that is different from this host AND newer." >&2
    echo "These skills are gitignored, so there is no merge base and no undo — shipping now" >&2
    echo "would silently destroy whatever was fixed there." >&2
    echo >&2
    echo "If the target is right, pull its copy back here first:" >&2
    # Outer SINGLE quotes on the remote command, inner double quotes around the path: the path
    # defaults to the literal text `$HOME/...` and must be expanded by the *remote* shell. The
    # reverse (outer double, inner single) reaches the target as a literal `$HOME` — the same
    # quoting trap the tar line below is commented for.
    echo "  $SSH_CMD $HOST 'tar -C \"$REMOTE_PATH\" -cf - skills/daily-briefing skills/daily-triage' \\" >&2
    echo "    | tar -C \"$repo_root\" -xf -" >&2
    echo "  bash tools/deploy-private-skills.sh --local" >&2
    echo >&2
    echo "If THIS host is right, re-run with --force." >&2
    exit 1
  fi
fi

echo
echo "Shipping ${#SKILLS[@]} private skills to $HOST:$REMOTE_PATH/skills/ ..."
# --no-same-owner: the tarball is written by whatever uid packed it; the deploy user owns the
# result on the target.
# The path is double-quoted, not single-quoted, on purpose: $REMOTE_PATH defaults to the literal
# text `$HOME/dev/AgentSystem` so it resolves on the *target*. Single quotes would survive the
# local expansion and reach the remote shell as literal `$HOME`, extracting into a directory
# actually named `$HOME` while the installer looked in the real checkout and reported the skills
# missing.
tar -C "$repo_root" -cf - "${SKILLS[@]/#/skills/}" \
  | ssh_run "$HOST" "mkdir -p \"$REMOTE_PATH\" && tar -C \"$REMOTE_PATH\" -xf - --no-same-owner"

run_installer "$REMOTE_PATH" "$LIFE_DIR"

echo
echo "Deployed to $HOST. Verify the pipeline end to end with:"
echo "  gh workflow run scheduled-tasks.yml -f job=daily-triage"
