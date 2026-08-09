'use strict';
// SessionEnd hook — project management hygiene on session completion.
// - Finalizes session naming with done marker (session-namer.js --finalize-close)
// - Appends session summary to session-log.jsonl with git status flags
// - Creates/updates HANDOFF.md if work appears unfinished
//
// Runs detached (non-blocking, fire-and-forget) to never delay session close.

const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TOOLS = [
  process.env.AGENT_TOOLS_ROOT,
  path.resolve(__dirname, '..', 'tools'),
  path.join(os.homedir(), 'dev', 'AgentSystem', 'tools'),
].find((p) => { try { return p && fs.existsSync(path.join(p, 'session-namer.js')); } catch { return false; } });

// Helper to read the session registry entry for a session.
function readSessionEntry(sessionId) {
  if (!TOOLS) return null;
  try {
    const output = execFileSync(
      process.execPath,
      [path.join(TOOLS, 'session-namer.js'), '--search', sessionId],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    // session-namer.js --search outputs a formatted table — we need to parse it.
    // For now, just trust that the registry has the session (finalize-close will handle it).
    return { session: sessionId };
  } catch {
    return null;
  }
}

// Helper to check if there are uncommitted changes in a repo.
function hasUncommittedChanges(cwd) {
  if (!cwd) return false;
  try {
    const output = execFileSync('git', ['status', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

const isWorkerInvocation = process.argv.includes('--worker');

if (require.main === module && !isWorkerInvocation) {
  let sessionId = null;
  let cwd = null;

  try {
    const raw = fs.readFileSync(0, 'utf8');
    const payload = JSON.parse(raw);
    sessionId = payload.session_id || null;
    cwd = payload.cwd || null;
  } catch {
    // Malformed payload — exit cleanly, don't block session end.
    process.stdout.write('OK');
    process.exit(0);
  }

  if (!sessionId || !TOOLS) {
    process.stdout.write('OK');
    process.exit(0);
  }

  // Spawn detached worker so this hook exits immediately (never blocks session end).
  try {
    const worker = spawn(process.execPath, [__filename, '--worker', sessionId, cwd || ''], {
      detached: true,
      stdio: 'ignore',
    });
    worker.unref();
  } catch {
    // spawn failure is non-fatal.
  }

  process.stdout.write('OK');
  process.exit(0);
}

// ── Worker mode (detached, non-blocking) ──────────────────────────────────────

const workerIdx = process.argv.indexOf('--worker');
if (workerIdx !== -1) {
  const sessionId = process.argv[workerIdx + 1];
  const cwd = process.argv[workerIdx + 2] || '';

  // Get the session entry from the registry so we have repo/title for logging.
  let entry = null;
  try {
    // For now, try to extract info from the registry via a quick lookup.
    // The session-namer registry stores this, but we don't have a direct
    // query-by-id function, so we'll do best-effort parsing.
    // This is OK to fail gracefully — the important part is that
    // --finalize-close runs (which doesn't need this data).
    const registryPath = path.join(os.homedir(), 'agent-memory', 'nexus', 'session-registry.jsonl');
    if (fs.existsSync(registryPath)) {
      const lines = fs.readFileSync(registryPath, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.session === sessionId) {
            entry = obj;
            break;
          }
        } catch {
          // Skip malformed lines
        }
      }
    }
  } catch {
    // Registry not found or unreadable — continue anyway
  }

  // Always finalize with done marker (this is idempotent).
  try {
    execFileSync(
      process.execPath,
      [path.join(TOOLS, 'session-namer.js'), '--finalize-close', `--session=${sessionId}`],
      { stdio: 'ignore', timeout: 5000 }
    );
  } catch {
    // Non-critical — session-namer errors don't block cleanup
  }

  // Append to session log with git status.
  if (entry) {
    try {
      execFileSync(
        process.execPath,
        [
          path.join(TOOLS, 'session-log-append.js'),
          `--session=${sessionId}`,
          `--repo=${entry.repo || 'unknown'}`,
          `--title=${entry.title || 'untitled'}`,
          ...(cwd ? [`--cwd=${cwd}`] : []),
          `--timestamp=${entry.timestamp || new Date().toISOString()}`,
        ],
        { stdio: 'ignore', timeout: 5000 }
      );
    } catch {
      // Non-critical — logging failures don't affect session
    }
  }

  // Create/update HANDOFF.md if there are uncommitted changes.
  if (cwd && hasUncommittedChanges(cwd)) {
    try {
      const handoffPath = path.join(cwd, 'HANDOFF.md');
      const timestamp = new Date().toISOString();
      const lines = [];
      if (fs.existsSync(handoffPath)) {
        lines.push(fs.readFileSync(handoffPath, 'utf8'));
      }
      lines.push(`\n## Session ${sessionId.slice(0, 8)} (${timestamp})`);
      lines.push('Work in progress — uncommitted changes detected.');
      lines.push(`Session title: ${entry?.title || 'untitled'}`);
      fs.writeFileSync(handoffPath, lines.join('\n') + '\n', 'utf8');
    } catch {
      // Non-critical — HANDOFF.md creation failures don't affect session
    }
  }

  process.exit(0);
}
