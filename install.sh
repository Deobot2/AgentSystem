#!/usr/bin/env bash
# install.sh -- First-time AgentSystem setup (Linux / macOS)
# Idempotent -- safe to re-run.
#
# Usage:
#   ./install.sh
#   NAME="Your Name" EMAIL="you@example.com" ./install.sh
#   ./install.sh --skip-labels
#   ./install.sh --with-mission-control   # also install the remote-dispatch server
#
# Any other flag is forwarded to tools/mission-control/install-local.sh, so a bare
# server goes from git clone to fully usable in one command:
#   ./install.sh --with-mission-control --with-tailscale --with-runner

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The claude / agy CLIs live here; a fresh login shell may not have it on PATH yet.
export PATH="$HOME/.local/bin:$PATH"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "   ${GREEN}OK${NC}  $1"; }
warn() { echo -e "   ${YELLOW}!!${NC}  $1"; }
fail() { echo -e "   ${RED}XX${NC}  $1"; }
step() { echo -e "\n${CYAN}>> $1${NC}"; }

# NOTE: `((VAR++))` returns exit status 1 when the pre-increment value is 0, which
# under `set -e` aborts the script on the very first counter bump. Use assignment
# helpers instead — `VAR=$((VAR+1))` always exits 0.
bump_pass() { PASS=$((PASS + 1)); }
bump_warn() { WARN=$((WARN + 1)); }
bump_fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); }

SKIP_LABELS=0
WITH_MC=0
MC_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --skip-labels)          SKIP_LABELS=1 ;;
    --with-mission-control) WITH_MC=1 ;;
    # Everything else (--with-tailscale, --user, --port 8765, ...) belongs to the
    # Mission Control installer. Order is preserved, so value flags survive.
    *)                      MC_ARGS+=("$arg") ;;
  esac
done

PASS=0; WARN=0; FAIL_COUNT=0
MC_INSTALLER="$SCRIPT_DIR/tools/mission-control/install-local.sh"

check_prereqs() {
  FAIL_COUNT=0
  for cmd in node git gh; do
    if command -v "$cmd" &>/dev/null; then
      ok "$cmd  $($cmd --version 2>&1 | head -1)"
      bump_pass
    else
      fail "$cmd not found"
      bump_fail
    fi
  done
}

# 1. Prerequisites
step "Checking prerequisites"
check_prereqs

# On a bare server, bootstrap them instead of dead-ending: the Mission Control
# installer is the dependency bootstrapper (apt packages, Node 22, gh, claude, agy).
if [ "$FAIL_COUNT" -gt 0 ] && [ -f "$MC_INSTALLER" ]; then
  step "Bootstrapping missing prerequisites (tools/mission-control/install-local.sh)"
  # --no-service here: the service is installed later only if --with-mission-control.
  bash "$MC_INSTALLER" --no-service || warn "bootstrap reported errors - re-checking anyway"
  PASS=0
  check_prereqs
fi

for cli in claude; do
  if command -v "$cli" &>/dev/null; then ok "$cli CLI found"
  else warn "$cli CLI not found (sync will skip it)"; bump_warn; fi
done

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo -e "\n${RED}FATAL: $FAIL_COUNT prerequisite(s) still missing after bootstrap.${NC}"
  echo "Install them by hand, then re-run ./install.sh:"
  echo "  https://nodejs.org  ·  https://cli.github.com"
  exit 1
fi

# 2. Personal brain
step "Initializing personal brain"
NAME="${NAME:-$(git config user.name 2>/dev/null || echo 'User')}"
EMAIL="${EMAIL:-$(git config user.email 2>/dev/null || echo '')}"
node "$SCRIPT_DIR/tools/personal-brain-init.js" --name="$NAME" --email="$EMAIL"
ok "Personal brain ready"
bump_pass

# 3. Sync agents
step "Syncing agents to all CLIs"
node "$SCRIPT_DIR/tools/sync-agents.js"
ok "Agents synced"
bump_pass

# 3b. Repo graph brain (gitignored, so a fresh clone has none)
step "Building repo graph brain"
if node "$SCRIPT_DIR/tools/graph/graph-init.js" agentsystem "$SCRIPT_DIR" >/dev/null 2>&1; then
  ok "Graph brain ready (query: node tools/graph/graph-query.js agentsystem <keywords>)"
  bump_pass
else
  warn "graph-init failed - run it by hand: node tools/graph/graph-init.js agentsystem ."
  bump_warn
fi

# 3c. MCP server (memory + graph tools inside Claude Code)
step "Registering the agentsystem MCP server with Claude Code"
if ! command -v claude &>/dev/null; then
  warn "claude CLI absent - register later: claude mcp add agentsystem -- node $SCRIPT_DIR/tools/mcp-server.js"
  bump_warn
elif claude mcp list 2>/dev/null | grep -q 'agentsystem'; then
  ok "MCP server already registered"
  bump_pass
elif claude mcp add agentsystem -- node "$SCRIPT_DIR/tools/mcp-server.js" >/dev/null 2>&1; then
  ok "MCP server registered (memory_*, graph_query, agent inbox tools)"
  bump_pass
else
  warn "Could not register MCP server - run: claude mcp add agentsystem -- node $SCRIPT_DIR/tools/mcp-server.js"
  bump_warn
fi

# 4. GitHub labels
if [ "$SKIP_LABELS" -eq 0 ]; then
  step "Creating GitHub labels"
  if gh auth status &>/dev/null 2>&1; then
    AGENTS="jarvis friday sam ultron pym leo nat wanda astra threepio r2d2"
    for agent in $AGENTS; do
      if gh label list --limit 200 2>/dev/null | grep -q "agent:$agent"; then
        echo "  Exists: agent:$agent"
      else
        gh label create "agent:$agent" --color "0075ca" --description "Dispatch to $agent agent" 2>/dev/null \
          && echo "  Created: agent:$agent" || true
      fi
    done
    ok "Labels ready"
    bump_pass
  else
    warn "gh not authenticated - skipping labels (run: gh auth login)"
    bump_warn
  fi
else
  echo "  -- Labels skipped (--skip-labels)"
fi

# 5. Claude Code hooks
step "Installing Claude Code hooks to ~/.claude/hooks/"
HOOKS_DIR="$HOME/.claude/hooks"
mkdir -p "$HOOKS_DIR"
HOOK_SCRIPTS=(
  "session-start.sh"
  "session-end.sh"
  "user-prompt-submit.sh"
  "guard-git.sh"
  "wip-checkpoint.sh"
  "session-close.sh"
  "context-handoff.sh"
)
HOOKS_SRC="$SCRIPT_DIR/hooks/claude-hooks"
if [ -d "$HOOKS_SRC" ]; then
  for hook in "${HOOK_SCRIPTS[@]}"; do
    src="$HOOKS_SRC/$hook"
    dst="$HOOKS_DIR/$hook"
    if [ -f "$src" ]; then
      cp "$src" "$dst"
      chmod +x "$dst"
      ok "Installed $hook"
      bump_pass
    fi
  done
else
  warn "hooks/claude-hooks/ not found in repo — skipping hook install"
  warn "Manually copy hook scripts to $HOOKS_DIR"
  bump_warn
fi

# 6. Mission Control (optional — remote agent dispatch server)
if [ "$WITH_MC" -eq 1 ]; then
  step "Installing Mission Control webhook server"
  bash "$SCRIPT_DIR/tools/mission-control/install-local.sh" "${MC_ARGS[@]}"
  ok "Mission Control installed (see docs/mission-control-linux-deploy.md)"
  bump_pass
else
  step "Mission Control (optional)"
  echo "     Skipped. To install the remote agent-dispatch server on this host:"
  echo "       bash $SCRIPT_DIR/tools/mission-control/install-local.sh"
  echo "     or re-run: ./install.sh --with-mission-control"
  echo "     Guide: docs/mission-control-linux-deploy.md"
fi

# 7. Self-hosted runner note
step "Self-hosted runner"
echo "     Install the Linux Actions runner (co-located with Mission Control) with:"
echo "       bash $SCRIPT_DIR/tools/mission-control/install-runner.sh"
echo "     It registers as a boot-persistent systemd service and serves the"
echo "     sam-audit / friday-audit / agent-dispatch / scheduled workflows."

# Summary
echo ""
echo "======================================="
echo " AgentSystem install complete"
echo "  Pass: $PASS  Warn: $WARN  Fail: $FAIL_COUNT"
echo "======================================="
echo ""
echo " Start working:"
echo "   claude @friday              - engineering tasks"
echo "   claude @jarvis              - strategy / cross-domain"
echo "   claude @nat                 - business / GTM"
echo ""
echo " New repo:"
echo "   node $SCRIPT_DIR/tools/bootstrap-repo.js  (or bootstrap-repo.ps1 on Windows)"
echo ""
echo " After editing agents:"
echo "   node $SCRIPT_DIR/tools/sync-agents.js"
echo ""
if [ "$WARN" -gt 0 ]; then
  echo -e "${YELLOW} Warnings above - check output and re-run if needed.${NC}"
fi