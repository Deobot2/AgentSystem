'use strict';
// SessionStart hook — injects the compiled routines rules into agent context.
// Reads .agents/rules/routines.generated.md (compiled by `node tools/routines.js compile`).
// Also checks routine-overrides.json and notes any active bypasses.
// Non-blocking: if the file is missing, emits nothing (compile not yet run is fine).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Path to the compiled rules file (repo-relative from AGENT_TOOLS_ROOT/../)
const TOOLS = process.env.AGENT_TOOLS_ROOT ||
  path.resolve(__dirname, '..', 'tools');
const REPO_ROOT = path.resolve(TOOLS, '..');
const GENERATED_MD = path.join(REPO_ROOT, '.agents', 'rules', 'routines.generated.md');
const OVERRIDES_PATH = path.join(os.homedir(), 'agent-memory', 'nexus', 'routine-overrides.json');

/**
 * Check if a session-scoped bypass override is still active.
 * Duplicated in tools/routines.js — keep in sync with that copy.
 * Both copies follow the same logic for consistency across read paths:
 * - If override.session is falsy, it's permanent (always active)
 * - If override.session is true:
 *   - If override.sessionId is missing/falsy, treat as NOT active (fail-closed)
 *   - If override.sessionId matches currentSessionId, it's active
 *   - Otherwise, it's expired (not active in a new session)
 */
function isOverrideActive(override, currentSessionId) {
  if (!override || !override.bypassed) return false;
  // Non-session bypasses (session: false or absent) are always active (permanent)
  if (!override.session) return true;
  // Session-scoped bypass: only active if sessionId matches
  // Missing/null sessionId is treated as NOT active (fail-closed)
  return override.sessionId === currentSessionId && currentSessionId;
}

/** Ids with an active bypass in the machine-local overrides file. */
function bypassedIds(currentSessionId) {
  try {
    const overrides = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
    return Object.keys(overrides).filter(id => isOverrideActive(overrides[id], currentSessionId));
  } catch {
    return []; // No overrides file — nothing bypassed.
  }
}

/**
 * Drop the compiled line for each bypassed routine.
 *
 * Bypass means "the action text is not injected" (see the header of config/routines.yml), and this
 * is where that has to happen. It used to happen in `routines.js compile`, which wrote one
 * machine's local bypasses into a git-tracked file and disabled those routines everywhere.
 *
 * Lines look like `- **<id>** (hard): ...`, one per routine.
 */
function applyBypasses(md, bypassed) {
  if (bypassed.length === 0) return md;
  const skip = new Set(bypassed);
  return md
    .split('\n')
    .filter((line) => {
      const m = /^-\s+\*\*([\w-]+)\*\*/.exec(line);
      return !(m && skip.has(m[1]));
    })
    .join('\n');
}

module.exports = { applyBypasses };

if (require.main === module) {
  let out = '';
  let currentSessionId = null;

  // Read session_id from stdin JSON payload (if provided by hook harness)
  try {
    const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (payload && payload.session_id) {
      currentSessionId = payload.session_id;
    }
  } catch {
    // No stdin or not JSON — session_id will be null, fail-closed: no session bypasses honored
  }

  const bypassed = bypassedIds(currentSessionId);

  try {
    const md = applyBypasses(fs.readFileSync(GENERATED_MD, 'utf8'), bypassed);
    if (md && md.trim()) {
      out += `=== ENFORCED ROUTINES ===\n${md.trim()}`;
    }
  } catch {
    // Missing generated file — compile not run yet, or no agent-rule routines. Silent.
  }

  if (bypassed.length > 0) {
    out += `\n\n[ROUTINES] Active bypasses: ${bypassed.join(', ')}. These routines are NOT enforced this session.`;
  }

  process.stdout.write(out || 'OK');
}
