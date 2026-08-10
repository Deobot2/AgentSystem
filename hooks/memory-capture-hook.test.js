'use strict';
// #372: memory-capture-hook.js's TOOLS-resolution can silently no-op (all three candidate dirs
// lack the marker file) while every call site swallows the resulting throw in a bare try/catch
// and still exits 0 -- a "ran but did nothing" false-green. These tests prove both halves:
// resolveTools finds a real path under normal conditions, and returns undefined (not a throw)
// when nothing qualifies -- plus an end-to-end proof the hook's actual side effect (spawning
// memory-capture.js) happens when TOOLS resolves.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { resolveTools } = require('./memory-capture-hook.js');

test('resolveTools finds the candidate holding the marker file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-tools-'));
  try {
    fs.writeFileSync(path.join(dir, 'memory-capture.js'), '// stub');
    const found = resolveTools([undefined, '/does/not/exist', dir], 'memory-capture.js');
    assert.equal(found, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveTools returns undefined (not a throw) when no candidate has the marker', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-tools-empty-'));
  try {
    const found = resolveTools([undefined, '/does/not/exist', emptyDir], 'memory-capture.js');
    assert.equal(found, undefined);
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('resolveTools tolerates a candidate whose existsSync check itself throws', () => {
  // path.join(null, ...) throws a TypeError inside the .find() predicate -- the exact class of
  // fault the try/catch inside resolveTools exists to swallow per-candidate, not fleet-wide.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-tools-'));
  try {
    fs.writeFileSync(path.join(dir, 'memory-capture.js'), '// stub');
    const found = resolveTools([null, dir], 'memory-capture.js');
    assert.equal(found, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('end-to-end: hook spawns memory-capture.js with the resolved TOOLS dir when transcript is valid', () => {
  // Build a fixture tools dir with a stub memory-capture.js that proves it ran by writing a
  // marker file -- the actual side effect this hook exists to trigger, not merely "exited 0".
  const toolsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tools-root-'));
  const memRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-root-'));
  const ranMarker = path.join(toolsDir, 'ran.marker');
  try {
    fs.writeFileSync(
      path.join(toolsDir, 'memory-capture.js'),
      `require('node:fs').writeFileSync(${JSON.stringify(ranMarker)}, process.argv[2] || '');`
    );

    const transcriptPath = path.join(toolsDir, 'fake-transcript.jsonl');
    fs.writeFileSync(transcriptPath, '');

    execFileSync(process.execPath, [path.join(__dirname, 'memory-capture-hook.js')], {
      input: JSON.stringify({ transcript_path: transcriptPath }),
      env: { ...process.env, AGENT_TOOLS_ROOT: toolsDir, AGENT_MEMORY_ROOT: memRoot },
      encoding: 'utf8',
      timeout: 5000,
    });

    // The child is spawned detached+unref'd -- poll briefly for the marker instead of assuming
    // it lands within the parent's own exit.
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(ranMarker) && Date.now() < deadline) {
      execFileSync(process.execPath, ['-e', 'setTimeout(()=>{}, 50)']);
    }
    assert.equal(fs.existsSync(ranMarker), true, 'stub memory-capture.js never ran -- resolveTools silently failed to resolve AGENT_TOOLS_ROOT');
  } finally {
    fs.rmSync(toolsDir, { recursive: true, force: true });
    fs.rmSync(memRoot, { recursive: true, force: true });
  }
});
