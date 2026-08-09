'use strict';
// hooks/lib/override-state.cjs — shared routine-override logic for both module systems.
//
// `.cjs` extension forces CommonJS regardless of directory package.json, so this is
// consumable both via `require()` from hooks/ (CommonJS) and via `import` from tools/
// (ESM, using Node's cjs-module-lexer interop for named exports of a .cjs file).
//
// Previously duplicated near-verbatim in tools/routines.js and hooks/routines-context-inject.js —
// see AgentSystem PR #270 follow-up. One copy now; both call sites re-export/re-use this.

const path = require('node:path');
const os = require('node:os');

/**
 * Resolve the routine-overrides.json path.
 * Reads AGENT_ROUTINE_OVERRIDES_PATH from the environment first (test isolation hook — a test
 * suite that hardcoded the real path once clobbered every host's live bypass state), falling
 * back to the real default path used in production.
 */
function resolveOverridesPath() {
  return process.env.AGENT_ROUTINE_OVERRIDES_PATH ||
    path.join(os.homedir(), 'agent-memory', 'nexus', 'routine-overrides.json');
}

/**
 * Check if a session-scoped bypass override is still active.
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

module.exports = { isOverrideActive, resolveOverridesPath };
