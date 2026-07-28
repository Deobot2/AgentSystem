#!/usr/bin/env bash
# test_memory_consistency.sh — Verify agent memory system consistency
# Tests that master memory files exist and are valid.
# Full cross-CLI sync validation runs in the developer's local environment
# (requires user-level CLI config directories to be present).
#
# Usage:
#   bash tests/test_memory_consistency.sh              # local full run
#   SKIP_CLI_SYNC=true bash tests/test_memory_consistency.sh  # CI-safe run

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MASTER_MEMORY_DIR="${REPO_ROOT}/.agents/memory"
SKIP_CLI_SYNC="${SKIP_CLI_SYNC:-false}"

PASS=0
FAIL=0

# --- Helpers -----------------------------------------------------------------

pass() {
  echo "[PASS] $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "[FAIL] $1"
  FAIL=$((FAIL + 1))
}

assert_file_exists() {
  local label="$1"
  local path="$2"
  if [ -f "$path" ]; then
    pass "$label: file exists"
  else
    fail "$label: file not found — $path"
  fi
}

assert_files_equal() {
  local label="$1"
  local file_a="$2"
  local file_b="$3"
  if diff -q "$file_a" "$file_b" > /dev/null 2>&1; then
    pass "$label: files are identical"
  else
    fail "$label: files differ"
    diff "$file_a" "$file_b" | head -20
  fi
}

assert_file_timestamp_within() {
  local label="$1"
  local path="$2"
  local max_age_seconds="$3"

  if [ ! -f "$path" ]; then
    fail "$label: file not found — $path"
    return
  fi

  local file_time
  file_time=$(stat -c %Y "$path" 2>/dev/null || stat -f %m "$path" 2>/dev/null)
  local now
  now=$(date +%s)
  local age=$(( now - file_time ))

  if [ "$age" -le "$max_age_seconds" ]; then
    pass "$label: file is fresh (age=${age}s, max=${max_age_seconds}s)"
  else
    fail "$label: file is stale (age=${age}s, max=${max_age_seconds}s) — $path"
  fi
}

# --- Test 1: Master memory directory and core files exist --------------------

echo ""
echo "=== Test 1: Master memory files exist ==="

assert_file_exists "master memory dir/jarvis.md" "${MASTER_MEMORY_DIR}/jarvis.md"
assert_file_exists "master memory dir/friday.md" "${MASTER_MEMORY_DIR}/friday.md"
assert_file_exists "master memory dir/sam.md"    "${MASTER_MEMORY_DIR}/sam.md"
assert_file_exists "master memory dir/nat.md"    "${MASTER_MEMORY_DIR}/nat.md"
assert_file_exists "master memory template"      "${MASTER_MEMORY_DIR}/TEMPLATE.md"

# --- Test 2: Master memory files are non-empty ------------------------------

echo ""
echo "=== Test 2: Master memory files are non-empty ==="

for agent in jarvis friday sam nat; do
  FILE="${MASTER_MEMORY_DIR}/${agent}.md"
  if [ -f "$FILE" ] && [ -s "$FILE" ]; then
    pass "master memory/${agent}.md: non-empty"
  else
    fail "master memory/${agent}.md: empty or missing"
  fi
done

# --- Test 3: Sync log exists and has a recent SUCCESS entry -----------------

echo ""
echo "=== Test 3: Sync log health ==="

SYNC_LOG="${REPO_ROOT}/.agents/sync.log"
assert_file_exists "sync.log exists" "$SYNC_LOG"

if [ -f "$SYNC_LOG" ]; then
  LAST_SUCCESS=$(grep "\[SUCCESS\]" "$SYNC_LOG" | tail -1)
  if [ -n "$LAST_SUCCESS" ]; then
    pass "sync.log: has at least one SUCCESS entry"
    echo "    Last success: $LAST_SUCCESS"
  else
    fail "sync.log: no SUCCESS entries found"
  fi

  # Check no consecutive ERROR entries (>2 in a row indicates a real failure)
  CONSECUTIVE_ERRORS=$(grep "\[ERROR\]" "$SYNC_LOG" 2>/dev/null | tail -3 | wc -l || true)
  if [ "$CONSECUTIVE_ERRORS" -ge 3 ]; then
    fail "sync.log: 3+ consecutive ERROR entries — sync may be broken"
  else
    pass "sync.log: no extended error streak detected"
  fi
fi

# --- Test 4: Agent definitions present and valid ----------------------------

echo ""
echo "=== Test 4: Agent frontmatter validity ==="

AGENTS_DIR="${REPO_ROOT}/.agents/agents"
AGENT_COUNT=$(ls "${AGENTS_DIR}"/*.md 2>/dev/null | wc -l)

if [ "$AGENT_COUNT" -ge 10 ]; then
  pass "agent count: found $AGENT_COUNT agents (expected >=10)"
else
  fail "agent count: found $AGENT_COUNT agents (expected >=10)"
fi

# Spot-check 3 agents for valid frontmatter
for AGENT in jarvis friday sam; do
  FILE="${AGENTS_DIR}/${AGENT}.md"
  if [ ! -f "$FILE" ]; then
    fail "agent $AGENT: file missing"
    continue
  fi

  FIRST_LINE=$(head -1 "$FILE")
  if [ "$FIRST_LINE" = "---" ]; then
    pass "agent $AGENT: has YAML frontmatter"
  else
    fail "agent $AGENT: missing YAML frontmatter (first line: '$FIRST_LINE')"
  fi

  NAME_VALUE=$(grep -m1 "^name:" "$FILE" | sed 's/name: //' | tr -d '[:space:]')
  if [ -n "$NAME_VALUE" ]; then
    pass "agent $AGENT: name field present ($NAME_VALUE)"
  else
    fail "agent $AGENT: name field missing or empty"
  fi
done

# --- Test 5: CLI sync consistency (local only — skipped in CI) --------------

echo ""
echo "=== Test 5: Cross-CLI memory consistency ==="

if [ "$SKIP_CLI_SYNC" = "true" ]; then
  echo "[SKIP] SKIP_CLI_SYNC=true — skipping cross-CLI sync test (CI mode)"
else
  # Detect OS — user-level paths differ
  if [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]] || [[ -n "$WINDIR" ]]; then
    USERPROFILE="${USERPROFILE:-$HOME}"
    CLAUDE_MEMORY_DIR="${USERPROFILE}/.claude/agents-memory"
    COPILOT_MEMORY_DIR="${USERPROFILE}/.copilot/memory"
    GEMINI_MEMORY_DIR="${USERPROFILE}/.gemini/antigravity-cli/memory"
  else
    HOME_DIR="${HOME}"
    CLAUDE_MEMORY_DIR="${HOME_DIR}/.claude/agents-memory"
    COPILOT_MEMORY_DIR="${HOME_DIR}/.copilot/memory"
    GEMINI_MEMORY_DIR="${HOME_DIR}/.gemini/antigravity-cli/memory"
  fi

  CLI_FOUND=0

  # Check Claude Code CLI memory
  if [ -d "$CLAUDE_MEMORY_DIR" ]; then
    CLI_FOUND=$((CLI_FOUND + 1))
    echo "Found Claude Code memory: $CLAUDE_MEMORY_DIR"
    for AGENT in jarvis friday sam nat; do
      CLI_FILE="${CLAUDE_MEMORY_DIR}/${AGENT}.md"
      MASTER_FILE="${MASTER_MEMORY_DIR}/${AGENT}.md"
      if [ -f "$CLI_FILE" ] && [ -f "$MASTER_FILE" ]; then
        assert_files_equal "Claude Code memory/${AGENT}.md == master" "$MASTER_FILE" "$CLI_FILE"
      else
        fail "Claude Code memory/${AGENT}.md: missing in CLI path ($CLI_FILE)"
      fi
    done
  else
    echo "[SKIP] Claude Code memory dir not found — not installed locally"
  fi

  # Check Copilot CLI memory
  if [ -d "$COPILOT_MEMORY_DIR" ]; then
    CLI_FOUND=$((CLI_FOUND + 1))
    echo "Found Copilot memory: $COPILOT_MEMORY_DIR"
    for AGENT in jarvis friday sam nat; do
      CLI_FILE="${COPILOT_MEMORY_DIR}/${AGENT}.md"
      MASTER_FILE="${MASTER_MEMORY_DIR}/${AGENT}.md"
      if [ -f "$CLI_FILE" ] && [ -f "$MASTER_FILE" ]; then
        assert_files_equal "Copilot memory/${AGENT}.md == master" "$MASTER_FILE" "$CLI_FILE"
      else
        fail "Copilot memory/${AGENT}.md: missing in CLI path ($CLI_FILE)"
      fi
    done
  else
    echo "[SKIP] Copilot memory dir not found — not installed locally"
  fi

  # Check Gemini CLI memory
  if [ -d "$GEMINI_MEMORY_DIR" ]; then
    CLI_FOUND=$((CLI_FOUND + 1))
    echo "Found Gemini memory: $GEMINI_MEMORY_DIR"
    for AGENT in jarvis friday sam nat; do
      CLI_FILE="${GEMINI_MEMORY_DIR}/${AGENT}.md"
      MASTER_FILE="${MASTER_MEMORY_DIR}/${AGENT}.md"
      if [ -f "$CLI_FILE" ] && [ -f "$MASTER_FILE" ]; then
        assert_files_equal "Gemini memory/${AGENT}.md == master" "$MASTER_FILE" "$CLI_FILE"
      else
        fail "Gemini memory/${AGENT}.md: missing in CLI path ($CLI_FILE)"
      fi
    done
  else
    echo "[SKIP] Gemini memory dir not found — not installed locally"
  fi

  if [ "$CLI_FOUND" -eq 0 ]; then
    echo "[SKIP] No local CLI installs found — cross-CLI test skipped"
  fi
fi

# --- Summary ----------------------------------------------------------------

echo ""
echo "========================================"
echo "  Memory Consistency Test Results"
echo "========================================"
echo "  PASSED: $PASS"
echo "  FAILED: $FAIL"
echo "========================================"

if [ "$FAIL" -gt 0 ]; then
  echo "RESULT: FAILED — $FAIL test(s) did not pass."
  echo "Recovery: run 'node tools/sync-agents.js' to resync"
  exit 1
else
  echo "RESULT: PASSED — all $PASS tests passed."
  exit 0
fi
