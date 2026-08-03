#!/bin/bash
# brain-join.sh — make this host's ~/agent-memory a checkout of the central brain, without
# losing anything it already knows.
#
# Run once per host. Every host that runs AgentSystem writes graph nodes into ~/agent-memory/nexus/;
# before joining, each host's copy is an island. This turns the island into a branch of the shared
# history: the host's own nodes are committed first, then the central brain is merged in, so a node
# that exists only here survives.
#
# Deliberately NOT a `git clone` into place: clone requires an empty directory, and the way people
# get there is `rm -rf ~/agent-memory` — which throws away exactly the nodes this script exists to
# preserve.
#
# Usage:
#   bash tools/brain-join.sh                 # join ~/agent-memory to the default remote
#   bash tools/brain-join.sh --remote <url>  # different brain remote
#   bash tools/brain-join.sh --path <dir>    # different brain location
#   bash tools/brain-join.sh --dry-run       # report what it would do
#
# Idempotent: on an already-joined host it reports state and exits 0.
# After it finishes, ongoing sync is `node tools/brain-sync.js`.

set -euo pipefail

REMOTE="https://github.com/Zene8/agent-memory.git"
ROOT="$HOME/agent-memory"
DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --remote) REMOTE="${2:?--remote needs a url}"; shift 2 ;;
    --path)   ROOT="${2:?--path needs a dir}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then say "  would: $*"; else "$@"; fi; }

IDENT=(-c "user.name=AgentSystem brain-join" -c "user.email=brain-sync@localhost")

[ -d "$ROOT" ] || { echo "no brain at $ROOT — nothing to join" >&2; exit 2; }

say "brain   $ROOT"
say "remote  $REMOTE"
say "files   $(find "$ROOT" -path "$ROOT/.git" -prune -o -type f -print | wc -l | tr -d ' ') on disk"

# ------------------------------------------------------------------ already joined?
#
# This answers "was this host ever joined", not "is it up to date": it reads the locally cached
# origin/main ref and does not fetch. Staleness is brain-sync.js's job, and fetching here would
# make the idempotent no-op path require network.

if [ -d "$ROOT/.git" ] && git -C "$ROOT" rev-parse --verify -q HEAD >/dev/null 2>&1 \
   && git -C "$ROOT" rev-parse --verify -q origin/main >/dev/null 2>&1 \
   && git -C "$ROOT" merge-base --is-ancestor origin/main HEAD 2>/dev/null; then
  say "already joined — origin/main is an ancestor of HEAD. Use tools/brain-sync.js from here."
  exit 0
fi

# ------------------------------------------------------------------ safety copy
#
# Cheap, and the only thing standing between a bad merge and six months of accumulated facts.
BACKUP="$(dirname "$ROOT")/$(basename "$ROOT")-preJoin-$(date -u +%Y%m%dT%H%M%SZ).tgz"
run tar -czf "$BACKUP" -C "$(dirname "$ROOT")" "$(basename "$ROOT")"
# Owner-only: the brain holds client project notes, and this tarball outlives the join — it sits in
# the home directory until someone deletes it.
run chmod 600 "$BACKUP"
say "backup  $BACKUP"

# ------------------------------------------------------------------ repo + remote

[ -d "$ROOT/.git" ] || run git -C "$ROOT" init -q -b main
# Node filenames are generated from the fact text, so they run long — brain-remember.js has produced
# names over 100 characters. On Windows that trips MAX_PATH and the merge dies mid-checkout with
# "Filename too long". Harmless no-op on Linux.
run git -C "$ROOT" config core.longpaths true
if git -C "$ROOT" remote get-url origin >/dev/null 2>&1; then
  run git -C "$ROOT" remote set-url origin "$REMOTE"
else
  run git -C "$ROOT" remote add origin "$REMOTE"
fi
run git -C "$ROOT" fetch -q origin main

if [ "$DRY" = 1 ]; then
  say "  would: commit local state, then merge origin/main (--allow-unrelated-histories -X theirs)"
  exit 0
fi

# ------------------------------------------------------------------ commit local state
#
# Pull .gitignore and .gitattributes out of the remote BEFORE the first commit. Otherwise this
# host's append-only logs (session-log.jsonl and friends) enter history on commit one and conflict
# on every sync forever, and CRLF normalisation rewrites every file.
# `git restore --source=` rather than `git show origin/main:<path> >file`: under Git Bash on Windows
# MSYS rewrites the `rev:path` argument as a path list at the colon, and the command dies with
# "ambiguous argument 'origin\main;.gitignore'". This form has no colon.
#
# One restore per file, failure tolerated: an older brain remote may predate either file, and under
# `set -e` a single restore naming both paths would abort the entire join on a raw git error rather
# than just skipping the file that isn't there.
for f in .gitignore .gitattributes; do
  git -C "$ROOT" restore --source=origin/main -- "$f" 2>/dev/null \
    || say "local   origin/main has no $f — continuing without it"
done

git -C "$ROOT" add -A
if git -C "$ROOT" diff --cached --quiet; then
  say "local   nothing to commit"
else
  git -C "$ROOT" "${IDENT[@]}" commit -q \
    -m "brain: $(hostname) snapshot before joining the central brain"
  say "local   committed $(git -C "$ROOT" show --stat --oneline HEAD | tail -1 | tr -s ' ')"
fi

# ------------------------------------------------------------------ merge
#
# -X theirs: where a path exists on both sides, the central brain wins. The central copy is the
# accumulated one; a fresh host's file is usually a re-initialised stub that would otherwise
# overwrite real content. Paths that exist ONLY here are untouched by this — that is the point.
if ! git -C "$ROOT" "${IDENT[@]}" merge --allow-unrelated-histories -X theirs -q origin/main \
     -m "brain: join the central brain

Union merge. Paths unique to $(hostname) are kept; where a path exists on both,
the central copy wins. graph.json is regenerated from nodes/ afterwards so any
node unique to this host gets re-indexed." >/dev/null 2>&1; then
  echo >&2
  echo "Merge did not complete cleanly. Conflicts:" >&2
  git -C "$ROOT" diff --name-only --diff-filter=U | sed 's/^/  /' >&2
  echo >&2
  echo "Nothing is lost — the pre-join state is in $BACKUP." >&2
  echo "Resolve in $ROOT, 'git commit', then: node tools/brain-sync.js" >&2
  exit 1
fi

say "merged  $(git -C "$ROOT" ls-files | wc -l | tr -d ' ') files tracked"

# ------------------------------------------------------------------ reindex
#
# graph.json is a generated index. After a merge that took the central side of it, nodes that exist
# only on this host are on disk but absent from the index, so graph-query cannot see them. Rebuild.
say
say "Next: rebuild the graph indexes so this host's own nodes are searchable —"
say "  node tools/graph/graph-init.js <slug> <repo-path>   # per repo brain"
say "then push the union back:"
say "  node tools/brain-sync.js"
