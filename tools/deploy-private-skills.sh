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
# Usage:
#   bash tools/deploy-private-skills.sh --check                  # verify THIS host only
#   bash tools/deploy-private-skills.sh --local                  # install on THIS host
#   bash tools/deploy-private-skills.sh --host <user@host>       # ship + install remotely
#   bash tools/deploy-private-skills.sh --host <user@host> --check
#
# Options:
#   --host <user@host>  Target. Omit to operate on this host.
#   --path <dir>        Remote checkout to copy into. Default: ~/dev/AgentSystem.
#   --life <dir>        Remote LIFE_REPO root to create briefings/ + closeouts/ under.
#                       Default: ~/life. Must match $LIFE_REPO on the target.
#   --local             Operate on this host (same as omitting --host).
#   --check             Verify only; copy nothing, install nothing. Exit 1 on any gap.
#   -h | --help         Show this help.
#
# Idempotent. Re-run after every edit to either skill — there is no auto-sync.

set -euo pipefail

HOST=""
REMOTE_PATH='$HOME/dev/AgentSystem'
LIFE_DIR='$HOME/life'
CHECK=0

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:?--host needs user@host}"; shift 2 ;;
    --path) REMOTE_PATH="${2:?--path needs a dir}"; shift 2 ;;
    --life) LIFE_DIR="${2:?--life needs a dir}"; shift 2 ;;
    --local) HOST=""; shift ;;
    --check) CHECK=1; shift ;;
    -h|--help) sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

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
  if [ -z "$HOST" ]; then bash -c "$script"; else ssh "$HOST" "bash -s" <<<"$script"; fi
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
  ssh "$HOST" "bash -s" <<REMOTE_EOF
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
  exit $?
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
  | ssh "$HOST" "mkdir -p \"$REMOTE_PATH\" && tar -C \"$REMOTE_PATH\" -xf - --no-same-owner"

run_installer "$REMOTE_PATH" "$LIFE_DIR"

echo
echo "Deployed to $HOST. Verify the pipeline end to end with:"
echo "  gh workflow run scheduled-tasks.yml -f job=daily-triage"
