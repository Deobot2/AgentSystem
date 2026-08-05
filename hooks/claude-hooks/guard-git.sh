#!/bin/bash
# PreToolUse hook: block destructive git ops on main/master without explicit user intent
INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)

if [ "$TOOL" != "Bash" ]; then
  exit 0
fi

CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)

# Block: force push to main/master
if echo "$CMD" | grep -qE 'git push.+(--force|-f).*(main|master)|git push.*(main|master).+(--force|-f)'; then
  echo "BLOCKED: Force push to main/master detected. Use 'git push --force-with-lease' or get explicit user approval." >&2
  exit 2
fi

# Block: ANY push to main/master, forced or not.
#
# The force rule above left a plain push to main wide open, while
# skills/daily-triage/SKILL.md states "Never push to `main` in any repo" as a hard limit. That was
# prose with nothing behind it. It became load-bearing once the unattended 05:00/13:00 run was
# cleared to dispatch code items against a CLIENT repo (arboreyecare/genie, #220) — an agent could
# have written straight to a client's default branch and nothing in the stack would have stopped it.
#
# Matches the ref forms that actually land on main: a bare `main`/`master` final ref, `HEAD:main`,
# and `-u origin main`. Any other branch is untouched, which is what draft-PR work needs, and
# `maintenance-branch` does not false-positive.
if echo "$CMD" | grep -qE 'git[[:space:]]+push([[:space:]]+[^[:space:]]+)*[[:space:]]+(main|master|[^[:space:]]*:(main|master))([[:space:]]|$)'; then
  echo "BLOCKED: direct write to main/master. Use a branch and open a PR - see the hard limits in skills/daily-triage/SKILL.md." >&2
  exit 2
fi

# Block: hard reset on main/master (branch-aware check)
if echo "$CMD" | grep -qP 'git reset --hard (HEAD|origin)' && git branch --show-current 2>/dev/null | grep -qE '^(main|master)$'; then
  echo "BLOCKED: Hard reset on main/master. Checkout a branch first." >&2
  exit 2
fi

# Warn (don't block): nuclear clean
if echo "$CMD" | grep -qE 'git clean -[^-]*f[^-]*d|git clean -fd'; then
  echo "WARNING: git clean -fd will delete untracked files. Proceeding." >&2
fi

exit 0
