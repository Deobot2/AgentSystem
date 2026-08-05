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

/** Ids with an active bypass in the machine-local overrides file. */
function bypassedIds() {
  try {
    const overrides = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
    return Object.keys(overrides).filter(id => overrides[id] && overrides[id].bypassed);
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
  const bypassed = bypassedIds();

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
