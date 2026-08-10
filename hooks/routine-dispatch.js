'use strict';
// routine-dispatch.js — single dispatcher hook for hook-mechanism routines.
// Wired to UserPromptSubmit and PostToolUse events. At runtime it:
//   1. Reads routines.yml + routine-overrides.json
//   2. Finds enabled, non-bypassed hook-mechanism routines whose trigger matches
//   3. Injects their action as context (UserPromptSubmit) or runs their check (PostToolUse)
//
// Adding a hook-routine = edit config/routines.yml + run `node tools/routines.js compile`.
// NO settings.json change needed — this dispatcher handles all hook routines.

const { execFileSync, spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Deployed copies live in ~/.claude/hooks where "../tools" does not exist — every
// candidate is existence-checked so the hook works from both locations (2026-07-12 audit).
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
  path.join(os.homedir(), 'dev', 'AgentSystem', 'tools'),
], 'auto-resolve-pr-comments.js');

module.exports = { resolveTools };

// NOTE: dispatchRoutines() in tools/routines.js is NOT wired into this hook's dispatch path below —
// this file hardcodes its own inline pr_create detection. dispatchRoutines() exists for the
// `list`/`compile` CLI's own bypass-awareness, not live PostToolUse/UserPromptSubmit dispatch.
const ROUTINES_SCRIPT = path.join(TOOLS, 'routines.js');

if (require.main === module) {
  let input = '';
  process.stdin.on('data', d => (input += d));
  process.stdin.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(input || '{}'); } catch { /* ignore */ }

    const event = payload.hook_event_name || '';
    const toolName = payload.tool_name || '';
    const toolResult = JSON.stringify(payload.tool_response || '');

    // Determine what context to build
    let hints = [];

    // UserPromptSubmit: identity-query hint intentionally NOT emitted here — memory-router.js
    // (also on UserPromptSubmit) owns that routine; emitting from both produced duplicate
    // hints on every identity prompt (2026-07-12 audit).

    // PostToolUse: detect gh pr create and schedule auto-resolve job
    if (event === 'PostToolUse' && toolName === 'Bash') {
      // Detect if the tool call was a `gh pr create`
      const toolInput = JSON.stringify(payload.tool_input || '');
      if (/gh pr create/.test(toolInput)) {
        // Extract PR number from gh pr create output
        const prUrlMatch = toolResult.match(/https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
        if (prUrlMatch) {
          const prNumber = prUrlMatch[1];
          scheduleAutoResolve(prNumber);
          hints.push(`ROUTINE [auto-resolve-pr-comments]: scheduled comment-response job for PR #${prNumber} in ~2min`);
        }
      }
    }

    process.stdout.write(hints.join('\n') || '');
    process.exit(0);
  });
}

// Spawn a hidden, detached node process that waits ~2min then responds to PR comments.
// Replaces the old schtasks approach: `schtasks` + the scheduled node.exe each opened a
// visible foreground console window per PR, and the one-shot tasks were never deleted —
// stale AgentSystem-AutoResolvePR-* tasks accumulated in Task Scheduler.
function scheduleAutoResolve(prNumber) {
  if (!/^\d+$/.test(prNumber)) return;
  try {
    const scriptPath = path.join(TOOLS, 'auto-resolve-pr-comments.js');
    const child = spawn(process.execPath, [scriptPath, `--pr=${prNumber}`, '--delay=120000'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch {
    // Non-fatal: spawn failed.
  }
}
