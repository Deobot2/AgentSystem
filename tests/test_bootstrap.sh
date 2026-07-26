#!/usr/bin/env bash
set -euo pipefail
PASS=0; FAIL=0
ok()   { echo "[PASS] $1"; PASS=$((PASS+1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_REPO_DIR="/tmp/test-bootstrap-repo-$(date +%s)"
# Resolve the registry exactly the way bootstrap-repo.js does. Hardcoding
# ~/.claude/agent-memory here silently pointed at a path that never existed, so the
# "registry entry created" assertion always failed and cleanup() never removed the
# test entry from the real registry.
export REGISTRY
REGISTRY=$(node --input-type=module -e "
  import { agentMemoryRoot } from '$REPO_ROOT/tools/graph/graph-lib.js';
  import { join } from 'node:path';
  process.stdout.write(join(agentMemoryRoot(), 'nexus', 'known-repos.json'));
" 2>/dev/null)

cleanup() {
  rm -rf "$TEST_REPO_DIR"
  if [ -f "$REGISTRY" ]; then
    node -e "
      const fs=require('fs');
      const reg=process.env.REGISTRY;
      try {
        const data=JSON.parse(fs.readFileSync(reg,'utf8'));
        data.repos=data.repos.filter(r=>r.slug!=='test-bootstrap-target');
        fs.writeFileSync(reg,JSON.stringify(data,null,2)+'\n','utf8');
      } catch(e){}
    " 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "=== Setup: create minimal test repo ==="
mkdir -p "$TEST_REPO_DIR"
cd "$TEST_REPO_DIR"
git init -q
git config user.email "test@test.com"
git config user.name "Test"
echo "# Test Repo" > README.md
echo "console.log('hello')" > index.js
git add . && git commit -q -m "initial"
cd "$REPO_ROOT"

echo "=== Test: bootstrap-repo.js runs without error ==="
node "$REPO_ROOT/tools/bootstrap-repo.js" "$TEST_REPO_DIR" \
  --slug=test-bootstrap-target 2>/dev/null \
  && ok "bootstrap exits 0" || fail "bootstrap exited non-zero"

echo "=== Test: repo brain created ==="
[ -f "$TEST_REPO_DIR/nexus/test-bootstrap-target/graph.json" ] \
  && ok "repo brain graph.json created" \
  || fail "repo brain graph.json missing"

echo "=== Test: CLAUDE.md injected ==="
[ -f "$TEST_REPO_DIR/CLAUDE.md" ] && ok "CLAUDE.md exists" || fail "CLAUDE.md missing"
grep -q "AGENT-SYSTEM-BOOTSTRAP" "$TEST_REPO_DIR/CLAUDE.md" \
  && ok "CLAUDE.md has agent block" || fail "CLAUDE.md missing agent block"

echo "=== Test: registry entry created ==="
node -e "
  const fs=require('fs');
  const reg=JSON.parse(fs.readFileSync(process.env.REGISTRY,'utf8'));
  const entry=reg.repos.find(r=>r.slug==='test-bootstrap-target');
  if (!entry) { process.exit(1); }
  console.log('found');
" 2>/dev/null && ok "registry entry exists" || fail "registry entry missing"

echo "=== Test: bootstrap is idempotent ==="
node "$REPO_ROOT/tools/bootstrap-repo.js" "$TEST_REPO_DIR" \
  --slug=test-bootstrap-target 2>/dev/null \
  && ok "second run exits 0" || fail "second run failed"

# Count only the opening marker (with colon) to detect duplicate block injection
BLOCK_COUNT=$(grep -c "AGENT-SYSTEM-BOOTSTRAP:" "$TEST_REPO_DIR/CLAUDE.md" 2>/dev/null || echo "0")
[ "$BLOCK_COUNT" -eq 1 ] && ok "CLAUDE.md block not duplicated" || fail "CLAUDE.md block duplicated ($BLOCK_COUNT times)"

REGISTRY_COUNT=$(node -e "
  const fs=require('fs');
  const reg=JSON.parse(fs.readFileSync(process.env.REGISTRY,'utf8'));
  process.stdout.write(String(reg.repos.filter(r=>r.slug==='test-bootstrap-target').length));
" 2>/dev/null)
[ "$REGISTRY_COUNT" -eq 1 ] && ok "registry entry not duplicated" || fail "registry entry duplicated ($REGISTRY_COUNT times)"

echo ""
echo "========================================"
printf "  PASSED: %d\n" $PASS
printf "  FAILED: %d\n" $FAIL
echo "========================================"
[ $FAIL -eq 0 ] && echo "RESULT: PASSED" && exit 0 || echo "RESULT: FAILED" && exit 1
