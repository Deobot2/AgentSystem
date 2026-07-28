/**
 * tests/test_routine_dispatch.js
 * node --test tests/test_routine_dispatch.js
 *
 * Regression coverage for #154: hooks/routine-dispatch.js already parsed PostToolUse Bash
 * payloads (tool_input.command / tool_response) to detect `gh pr create` and schedule the
 * auto-resolve-pr-comments routine, but the settings hook registration
 * only wired routine-dispatch.js to the `Write|Edit|NotebookEdit` PostToolUse matcher — it was
 * never invoked with Bash tool events at all, so the routine never fired in practice. This suite
 * locks in that the dispatcher's own Bash-handling logic behaves correctly (the settings-side
 * wiring fix is verified separately by asserting the matcher registration exists in the script).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_REGISTRY } from '../tools/deploy-hooks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', 'hooks', 'routine-dispatch.js');

function runHook(payload) {
  return execFileSync('node', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
}

describe('routine-dispatch.js PostToolUse Bash handling', () => {
  it('detects `gh pr create` in a Bash tool_input and schedules auto-resolve when a PR URL is present', () => {
    const out = runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --title "x" --body "y"' },
      tool_response: 'https://github.com/Zene8/AgentSystem/pull/999',
    });
    assert.match(out, /auto-resolve-pr-comments/);
    assert.match(out, /#999/);
  });

  it('does nothing for a Bash command that is not `gh pr create`', () => {
    const out = runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      tool_response: '',
    });
    assert.equal(out.trim(), '');
  });

  it('does nothing when `gh pr create` runs but no PR URL is found in the response', () => {
    const out = runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --title "x" --body "y"' },
      tool_response: 'error: could not create pull request',
    });
    assert.equal(out.trim(), '');
  });

  it('ignores non-Bash PostToolUse tool names even if the input mentions gh pr create', () => {
    const out = runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { command: 'gh pr create' },
      tool_response: 'https://github.com/Zene8/AgentSystem/pull/999',
    });
    assert.equal(out.trim(), '');
  });

  it('handles malformed/empty stdin without throwing', () => {
    const out = runHook(undefined) ?? '';
    assert.equal(typeof out, 'string');
  });
});

describe('HOOK_REGISTRY registers routine-dispatch.js on the Bash PostToolUse matcher (#154)', () => {
  it('has a PostToolUse hook entry for routine-dispatch.js with matcher = Bash', () => {
    const entries = HOOK_REGISTRY.filter(e =>
      e.event === 'PostToolUse' && /routine-dispatch\.js/.test(e.command));
    // 2026-07-12 audit: the Write|Edit|NotebookEdit registration was removed — routine-dispatch's
    // only PostToolUse job is detecting `gh pr create` in Bash output, so exactly one Bash
    // matcher is the correct wiring now.
    assert.ok(entries.length >= 1, 'expected routine-dispatch.js registered on the Bash PostToolUse matcher');
    const matchers = entries.map(e => e.matcher);
    assert.ok(matchers.includes('Bash'), `expected a Bash matcher among ${JSON.stringify(matchers)}`);
  });
});
