#!/bin/bash
# PreToolUse hook: block destructive git ops on main/master without explicit user intent
INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)

if [ "$TOOL" != "Bash" ]; then
  exit 0
fi

CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)

# --- Segment the command, then match within a segment (#284) -----------------
#
# Every rule below inspects command TEXT, so a rule written as one flat regex
# matches a word that belongs to a *different* command in the same compound
# line. That is how the force-push rule blocked
#   git push -u origin <branch> && git log origin/main -1
# — the flag came from the push, the "main" came from the log, and nothing tied
# them to the same command.
#
# Splitting on the shell's command separators and letting grep do its normal
# per-line matching scopes every rule to one command at a time, which kills that
# whole class in one place instead of per-regex. Splitting only ever narrows a
# match, so no true positive is lost: a real `git push --force origin main` has
# no separator in it and stays one segment.
SEGMENTS=$(printf '%s\n' "$CMD" | tr '&|;' '\n\n\n')

# --- Token-anchored fragments ------------------------------------------------
#
# The second half of #284: `-f` and `main` were matched as bare SUBSTRINGS, so
# `-f` matched inside the branch name `issue-275-fix-...` and `main` matched
# inside anything. Both must be whole shell tokens.
GIT_PUSH='(^|[[:space:]])git[[:space:]]+push([[:space:]]|$)'
# Force flags as standalone tokens, including bundled short forms (-fu, -uf).
# The leading separator means `--follow-tags` cannot match: after the first `-`
# the pattern needs an `f`, and it finds `-`.
FORCE='(^|[[:space:]])(--force|--force-with-lease|-[a-zA-Z]*f[a-zA-Z]*)([[:space:]]|$)'
# A ref that actually lands on the default branch: a bare `main`/`master` token
# or any `<src>:main` refspec. `maintenance-branch` and `feat/main-menu` are not
# matches, because the token must END right after main/master.
MAIN_REF='(^|[[:space:]])(main|master|[^[:space:]]*:(main|master))([[:space:]]|$)'

# Block: force push to main/master.
# (A subset of the next rule — kept for the more specific message.)
if printf '%s\n' "$SEGMENTS" | grep -E "$GIT_PUSH" | grep -E "$FORCE" | grep -qE "$MAIN_REF"; then
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
if printf '%s\n' "$SEGMENTS" | grep -E "$GIT_PUSH" | grep -qE "$MAIN_REF"; then
  echo "BLOCKED: direct write to main/master. Use a branch and open a PR - see the hard limits in skills/daily-triage/SKILL.md." >&2
  exit 2
fi

# Block: hard reset on main/master (branch-aware check).
#
# Two more #284-class defects fixed here:
#  - it was `grep -qP`, but the pattern is plain ERE. On any host whose grep
#    lacks -P (BSD/macOS) grep exits 2, the `&&` short-circuits, and this guard
#    is silently inert — a blocking rule that never blocks.
#  - it only matched `--hard HEAD|origin`, so `git reset --hard <sha>` and
#    `git reset --hard @{u}` walked straight through a rule whose message
#    claims to stop hard resets on main. Any hard reset while ON main is what
#    this is for, so it no longer requires a particular target.
if printf '%s\n' "$SEGMENTS" | grep -qE '(^|[[:space:]])git[[:space:]]+reset[[:space:]]+.*--hard([[:space:]]|$)' \
   && git branch --show-current 2>/dev/null | grep -qE '^(main|master)$'; then
  echo "BLOCKED: Hard reset on main/master. Checkout a branch first." >&2
  exit 2
fi

# Warn (don't block): nuclear clean.
# The old `git clean -[^-]*f[^-]*d` let `[^-]*` run across spaces, so it fired on
# an ordinary `git clean -x foo.f bar.d`. Require real flag tokens instead, in
# either order and bundled or separate.
CLEAN_FORCE='(^|[[:space:]])(--force|-[a-zA-Z]*f[a-zA-Z]*)([[:space:]]|$)'
CLEAN_DIRS='(^|[[:space:]])(--directory|-[a-zA-Z]*d[a-zA-Z]*)([[:space:]]|$)'
if printf '%s\n' "$SEGMENTS" | grep -E '(^|[[:space:]])git[[:space:]]+clean([[:space:]]|$)' \
   | grep -E "$CLEAN_FORCE" | grep -qE "$CLEAN_DIRS"; then
  echo "WARNING: git clean -fd will delete untracked files. Proceeding." >&2
fi

exit 0
