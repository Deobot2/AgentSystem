'use strict';
// #372: same TOOLS-resolution pattern, marker file auto-resolve-pr-comments.js. This hook's real
// side effect is spawning auto-resolve-pr-comments.js after detecting `gh pr create` in a
// PostToolUse Bash payload -- prove that spawn actually happens when TOOLS resolves, not just
// that the hook prints a hint and exits 0.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { resolveTools } = require('./routine-dispatch.js');

test('resolveTools finds the candidate holding the marker file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-tools-'));
  try {
    fs.writeFileSync(path.join(dir, 'auto-resolve-pr-comments.js'), '// stub');
    const found = resolveTools([undefined, '/does/not/exist', dir], 'auto-resolve-pr-comments.js');
    assert.equal(found, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveTools returns undefined (not a throw) when no candidate has the marker', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-tools-empty-'));
  try {
    const found = resolveTools([undefined, '/does/not/exist', emptyDir], 'auto-resolve-pr-comments.js');
    assert.equal(found, undefined);
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('end-to-end: PostToolUse gh pr create payload spawns the resolved auto-resolve-pr-comments.js', () => {
  const toolsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tools-root-'));
  const ranMarker = path.join(toolsDir, 'ran.marker');
  try {
    fs.writeFileSync(
      path.join(toolsDir, 'auto-resolve-pr-comments.js'),
      `require('node:fs').writeFileSync(${JSON.stringify(ranMarker)}, process.argv.slice(2).join(' '));`
    );

    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --title x --body y' },
      tool_response: 'https://github.com/Zene8/AgentSystem/pull/999',
    };

    const out = execFileSync(process.execPath, [path.join(__dirname, 'routine-dispatch.js')], {
      input: JSON.stringify(payload),
      env: { ...process.env, AGENT_TOOLS_ROOT: toolsDir },
      encoding: 'utf8',
      timeout: 5000,
    });

    assert.match(out, /auto-resolve-pr-comments\]: scheduled comment-response job for PR #999/);

    const deadline = Date.now() + 3000;
    while (!fs.existsSync(ranMarker) && Date.now() < deadline) {
      execFileSync(process.execPath, ['-e', 'setTimeout(()=>{}, 50)']);
    }
    assert.equal(fs.existsSync(ranMarker), true, 'stub auto-resolve-pr-comments.js never ran -- resolveTools silently failed to resolve AGENT_TOOLS_ROOT');
    assert.match(fs.readFileSync(ranMarker, 'utf8'), /--pr=999/);
  } finally {
    fs.rmSync(toolsDir, { recursive: true, force: true });
  }
});

test('non-gh-pr-create PostToolUse payload emits no hint and does not spawn anything', () => {
  const toolsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tools-root-'));
  try {
    fs.writeFileSync(path.join(toolsDir, 'auto-resolve-pr-comments.js'), '// stub, should never run');

    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
      tool_response: '',
    };

    const out = execFileSync(process.execPath, [path.join(__dirname, 'routine-dispatch.js')], {
      input: JSON.stringify(payload),
      env: { ...process.env, AGENT_TOOLS_ROOT: toolsDir },
      encoding: 'utf8',
      timeout: 5000,
    });

    assert.equal(out, '');
  } finally {
    fs.rmSync(toolsDir, { recursive: true, force: true });
  }
});
