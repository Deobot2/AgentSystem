'use strict';
// SessionStart hook — inject 3-layer memory context (user + project + recent), then kick off
// the memory "sleep cycle" maintenance in the background (run-on-use, only if stale).
// Non-blocking: context print is fast; maintenance is detached and unref'd.

const { execFileSync, spawn } = require('node:child_process');
const path = require('node:path');

// Deployed copies live in ~/.claude/hooks where "../tools" does not exist — every
// candidate is existence-checked so the hook works from both the repo and the
// deployed location (root cause of the silent SessionStart injection outage, 2026-07-12).
// #372: resolveTools is exported so a regression test can prove BOTH halves of this
// tradeoff — that it resolves under normal conditions, and that when every candidate
// lacks the marker file it returns undefined (the exact silent-no-op path every call
// site below swallows via a bare try/catch).
const fs = require('node:fs');
function resolveTools(candidates, markerFile) {
  return candidates.find((p) => { try { return p && fs.existsSync(path.join(p, markerFile)); } catch { return false; } });
}

const TOOLS = resolveTools([
  process.env.AGENT_TOOLS_ROOT,
  path.resolve(__dirname, '..', 'tools'),
  path.join(require('node:os').homedir(), 'dev', 'AgentSystem', 'tools'),
], 'memory-context.js');

module.exports = { resolveTools };

if (require.main === module) {
  let out = '';
  try {
    // #121: static SessionStart core trimmed 7 -> 3 (identity/role/hard-pref only). Task-relevant
    // facts are now injected on-demand by memory-router.js's UserPromptSubmit-stage BM25 retrieval.
    out = execFileSync(process.execPath, [path.join(TOOLS, 'memory-context.js'), `--cwd=${process.cwd()}`, '--core=3'], {
      timeout: 8000, encoding: 'utf8',
    });
  } catch { /* non-fatal — never block session start */ }

  try {
    const child = spawn(process.execPath, [path.join(TOOLS, 'memory-maintenance.js'), '--if-stale=3', '--quiet'], {
      detached: true, stdio: 'ignore', windowsHide: true,
      windowsHide: true,
    });
    child.unref();
  } catch { /* non-fatal */ }

  process.stdout.write(out && out.trim() ? `=== MEMORY CONTEXT ===\n${out.trim()}` : 'OK');
}
