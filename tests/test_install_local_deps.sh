#!/usr/bin/env bash
# test_install_local_deps.sh — Verify the dependency-bootstrap step of
# tools/mission-control/install-local.sh on a simulated fresh Ubuntu box.
#
# Runs the real installer with --no-service inside a sandbox HOME and a minimal
# PATH made of stubs, so nothing is installed and no sudo is used. Asserts that
# missing OS packages are batched into one apt call, that gh / claude / agy are
# fetched from the right URLs when absent, that --no-clis skips the agent CLIs,
# and that already-present CLIs are left alone.
#
# Usage: bash tests/test_install_local_deps.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALLER="$REPO_ROOT/tools/mission-control/install-local.sh"
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

PASS=0
FAIL=0
pass() { echo "[PASS] $1"; PASS=$((PASS + 1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL + 1)); }
check() { # check <description> <needle> <file>
  if grep -qF -- "$2" "$3"; then pass "$1"; else fail "$1 (missing: $2)"; fi
}
check_absent() {
  if grep -qF -- "$2" "$3"; then fail "$1 (unexpected: $2)"; else pass "$1"; fi
}

# ── Stub PATH ─────────────────────────────────────────────────────────────────
# Only the coreutils the installer actually shells out to, so git/tmux/jq/openssl
# genuinely look absent — that is the fresh-server condition under test.
build_stubs() {
  local stub="$1"
  mkdir -p "$stub"
  local u tool
  for u in bash sh sed mkdir cat chmod cp rm mktemp basename dirname whoami grep tee head; do
    ln -sf "$(command -v "$u")" "$stub/$u"
  done
  # Recorders: every call is appended to $CALLS, nothing touches the system.
  for tool in npm dpkg; do
    cat > "$stub/$tool" <<EOS
#!/bin/bash
echo "$tool \$*" >> "\$CALLS"
exit 0
EOS
    chmod +x "$stub/$tool"
  done
  # sudo: record, then forward only apt-get (the one call whose effect the rest of
  # the installer depends on). Everything else — tee into /usr/share/keyrings,
  # chmod, systemctl — is recorded and swallowed, since it would need real root.
  cat > "$stub/sudo" <<'EOS'
#!/bin/bash
echo "sudo $*" >> "$CALLS"
while [ $# -gt 0 ]; do case "$1" in -E|-n) shift ;; *) break ;; esac; done
# Forward the calls whose side effects the rest of the installer reads back:
# apt-get "installs" packages, `tailscale up` flips the node to joined.
case "${1:-}" in apt-get|tailscale) exec "$@" ;; esac
# Drain piped stdin (`... | sudo tee <root path>`): exiting without reading it
# would SIGPIPE the writer, which the installer's `set -o pipefail` treats as a
# real failure. Real sudo+tee consumes it. Installer stdin is </dev/null.
cat >/dev/null 2>&1 || true
exit 0
EOS
  chmod +x "$stub/sudo"
  # apt-get: record, and for `install` drop a fake binary per package into the
  # stub dir so later steps (openssl rand, git, ...) find what was "installed".
  cat > "$stub/apt-get" <<'EOS'
#!/bin/bash
echo "apt-get $*" >> "$CALLS"
[ "${1:-}" = "install" ] || exit 0
shift
for pkg in "$@"; do
  case "$pkg" in -*|ca-certificates) continue ;; esac
  printf '#!/bin/sh\nexit 0\n' > "$STUBDIR/$pkg"
  chmod +x "$STUBDIR/$pkg"
done
EOS
  chmod +x "$stub/apt-get"
  printf '#!/bin/bash\necho "node stub v22.0.0"\nexit 0\n' > "$stub/node"
  printf '#!/bin/bash\necho "v22.0.0"\n' > "$stub/node"
  chmod +x "$stub/node"
  # curl: record the URL, and for the two vendor CLI installers emit a script
  # that drops a fake binary into ~/.local/bin (what the real ones do).
  cat > "$stub/curl" <<'EOS'
#!/bin/bash
url=""
for a in "$@"; do case "$a" in http*) url="$a" ;; esac; done
echo "curl $url" >> "$CALLS"
case "$url" in
  *claude.ai/install.sh) bin=claude ;;
  *antigravity.google/cli/install.sh) bin=agy ;;
  # Vendor script; emit one that drops the fake CLI on PATH, like the real one.
  *tailscale.com/install.sh)
    echo "cp \"\$STUBDIR/.tailscale-src\" \"\$STUBDIR/tailscale\""
    echo "chmod +x \"\$STUBDIR/tailscale\""
    exit 0 ;;
  *) exit 0 ;;
esac
# stdout is piped into bash by the installer
echo "mkdir -p \"\$HOME/.local/bin\""
echo "printf '#!/bin/sh\\n' > \"\$HOME/.local/bin/$bin\""
echo "chmod +x \"\$HOME/.local/bin/$bin\""
EOS
  chmod +x "$stub/curl"
  # Staged out of PATH until "installed": reports an IP only once `up` has run.
  cat > "$stub/.tailscale-src" <<'EOS'
#!/bin/bash
echo "tailscale $*" >> "$CALLS"
case "${1:-}" in
  ip) [ -f "$STUBDIR/.ts-joined" ] && echo "100.64.1.5" ;;
  up) : > "$STUBDIR/.ts-joined" ;;
esac
exit 0
EOS
}

run_installer() { # run_installer <case-name> [extra installer args...]
  local name="$1"; shift
  export HOME="$SANDBOX/$name"
  export CALLS="$SANDBOX/$name.calls"
  local stub="$SANDBOX/$name.bin"
  mkdir -p "$HOME"
  : > "$CALLS"
  build_stubs "$stub"
  # Fresh-box conditions: no git/tmux/jq/openssl/gh/claude/agy on PATH.
  env -i HOME="$HOME" CALLS="$CALLS" STUBDIR="$stub" PATH="$stub" \
    bash "$INSTALLER" --no-service "$@" > "$SANDBOX/$name.out" 2>&1 < /dev/null || {
      echo "--- installer output ($name) ---"; cat "$SANDBOX/$name.out"
      fail "installer exited non-zero ($name)"; return 1; }
}

echo "=== fresh box, defaults ==="
run_installer fresh
OUT="$SANDBOX/fresh.out"; CALLS_F="$SANDBOX/fresh.calls"
# One apt transaction carrying every missing package, not one per package.
# (curl is present in the stub PATH — the installer cannot fetch anything without it.)
check "base packages batched into one apt install" \
  "sudo apt-get install -y ca-certificates git tmux jq openssl" "$CALLS_F"
check "gh installed from cli.github.com" "cli.github.com/packages" "$CALLS_F"
check "claude fetched from claude.ai/install.sh" "curl https://claude.ai/install.sh" "$CALLS_F"
check "agy fetched from antigravity.google" \
  "curl https://antigravity.google/cli/install.sh" "$CALLS_F"
check "claude resolved after install" "claude CLI: $SANDBOX/fresh/.local/bin/claude" "$OUT"
check "agy resolved after install" "agy CLI: $SANDBOX/fresh/.local/bin/agy" "$OUT"
check "auth follow-up printed" "gh auth login" "$OUT"
check_absent "tailscale untouched without the flag" "tailscale" "$CALLS_F"
check "loopback bind by default" "HOST=127.0.0.1" "$OUT"

echo "=== fresh box, --with-tailscale ==="
run_installer ts --with-tailscale --tailscale-authkey tskey-test
OUT_TS="$SANDBOX/ts.out"; CALLS_TS="$SANDBOX/ts.calls"
check "tailscale installed from tailscale.com" \
  "curl https://tailscale.com/install.sh" "$CALLS_TS"
check "joins the tailnet with the auth key" "sudo tailscale up --authkey tskey-test" "$CALLS_TS"
check "tailnet IP discovered" "tailnet IP: 100.64.1.5" "$OUT_TS"
check "binds the tailnet IP" "binding the tailnet IP: 100.64.1.5:8765" "$OUT_TS"
check "server told to bind it" "HOST=100.64.1.5" "$OUT_TS"

echo "=== --with-tailscale, explicit --bind wins ==="
run_installer tsbind --with-tailscale --tailscale-authkey tskey-test --bind 10.0.0.5
check "explicit bind kept" "keeping the requested bind 10.0.0.5" "$SANDBOX/tsbind.out"
check_absent "tailnet IP not bound" "binding the tailnet IP" "$SANDBOX/tsbind.out"

echo "=== fresh box, --no-clis ==="
run_installer noclis --no-clis
check_absent "claude not fetched with --no-clis" "claude.ai/install.sh" "$SANDBOX/noclis.calls"
check_absent "agy not fetched with --no-clis" "antigravity.google" "$SANDBOX/noclis.calls"
check "warns claude is missing" "claude CLI not found (--no-clis)" "$SANDBOX/noclis.out"

echo "=== CLIs already present: no reinstall ==="
export HOME="$SANDBOX/warm"; mkdir -p "$HOME/.local/bin"
for b in claude agy gh git tmux jq openssl; do
  printf '#!/bin/sh\n' > "$HOME/.local/bin/$b"; chmod +x "$HOME/.local/bin/$b"
done
CALLS="$SANDBOX/warm.calls"; : > "$CALLS"
build_stubs "$SANDBOX/warm.bin"
env -i HOME="$HOME" CALLS="$CALLS" STUBDIR="$SANDBOX/warm.bin" \
  PATH="$SANDBOX/warm.bin:$HOME/.local/bin" \
  bash "$INSTALLER" --no-service > "$SANDBOX/warm.out" 2>&1 < /dev/null \
  || { cat "$SANDBOX/warm.out"; fail "installer exited non-zero (warm)"; }
check "base packages reported ok" "base packages: ok" "$SANDBOX/warm.out"
check_absent "no CLI reinstall on a warm box" "install.sh" "$CALLS"
check_absent "no apt install on a warm box" "apt-get install" "$CALLS"

echo "-----------------------------------------------------------------"
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
