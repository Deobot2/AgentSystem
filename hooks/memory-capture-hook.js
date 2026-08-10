'use strict';
// SessionEnd hook — detached, non-blocking extraction of durable facts from the session
// transcript. Shells memory-capture.js in the background and exits 0 immediately.
// Never blocks the session end, never crashes the harness.

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// Deployed copies live in ~/.claude/hooks where "../tools" does not exist — every
// candidate is existence-checked so the hook works from both the repo and the
// deployed location (root cause of the silent SessionEnd capture outage, 2026-07-12).
// #372: resolveTools is exported so a regression test can prove BOTH halves of this
// tradeoff — that it resolves under normal conditions, and that when every candidate
// lacks the marker file it returns undefined (the exact silent-no-op path every call
// site below swallows via a bare try/catch).
function resolveTools(candidates, markerFile) {
  return candidates.find((p) => { try { return p && fs.existsSync(path.join(p, markerFile)); } catch { return false; } });
}

const TOOLS = resolveTools([
  process.env.AGENT_TOOLS_ROOT,
  path.resolve(__dirname, '..', 'tools'),
  path.join(require('node:os').homedir(), 'dev', 'AgentSystem', 'tools'),
], 'memory-capture.js');

module.exports = { resolveTools };

// #168: auto-capture.log was stale since Jul 3 — root cause: this hook spawned the
// capture child with stdio:'ignore', so its stdout/stderr (the "extracted N, wrote M
// facts" summary) went nowhere. The file's prior content was a one-off manual debug
// redirect, not a live log — nothing in this codebase ever wrote to it automatically.
// Fix: open a real append fd so every SessionEnd capture leaves a durable trail.
function captureLogFd() {
  try {
    const nexusDir = process.env.AGENT_MEMORY_ROOT ||
      path.join(require('node:os').homedir(), 'agent-memory', 'nexus');
    fs.mkdirSync(nexusDir, { recursive: true });
    return fs.openSync(path.join(nexusDir, 'auto-capture.log'), 'a');
  } catch {
    return 'ignore';
  }
}

if (require.main === module) {
  // Recursion guard: the capture pipeline itself runs `claude -p` sessions whose own
  // SessionEnd would re-trigger capture — an unbounded chain of headless sessions.
  if (process.env.AGENT_MEMORY_CAPTURE === '1') {
    process.stdout.write('OK');
    process.exit(0);
  }

  let transcriptPath = null;

  try {
    const raw = fs.readFileSync(0, 'utf8');
    const payload = JSON.parse(raw);
    transcriptPath = payload.transcript_path || null;
  } catch {
    // Malformed or missing payload — exit cleanly, don't block session end.
    process.stdout.write('OK');
    process.exit(0);
  }

  // Skip CI-runner sessions too — audit bots produce no durable user facts, and each
  // capture costs a headless `claude -p` session.
  if (!transcriptPath || /actions-runner/i.test(transcriptPath)) {
    process.stdout.write('OK');
    process.exit(0);
  }

  try {
    const logFd = captureLogFd();
    const child = spawn(process.execPath, [path.join(TOOLS, 'memory-capture.js'), transcriptPath], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
    child.unref();
  } catch {
    // spawn failure is non-fatal — never block session end.
  }

  process.stdout.write('OK');
}
