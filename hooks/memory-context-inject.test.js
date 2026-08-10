'use strict';
// #372: same TOOLS-resolution pattern as memory-capture-hook.js, marker file memory-context.js.
// See that test file's header for why both halves (resolves / silently returns undefined) and
// an end-to-end real-side-effect proof all matter here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { resolveTools } = require('./memory-context-inject.js');

test('resolveTools finds the candidate holding the marker file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-tools-'));
  try {
    fs.writeFileSync(path.join(dir, 'memory-context.js'), '// stub');
    const found = resolveTools([undefined, '/does/not/exist', dir], 'memory-context.js');
    assert.equal(found, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveTools returns undefined (not a throw) when no candidate has the marker', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-tools-empty-'));
  try {
    const found = resolveTools([undefined, '/does/not/exist', emptyDir], 'memory-context.js');
    assert.equal(found, undefined);
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('end-to-end: hook prints the resolved memory-context.js stub output, not a silent OK', () => {
  const toolsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tools-root-'));
  try {
    // memory-context.js is invoked via execFileSync in the hook and its stdout becomes the
    // injected context -- the real side effect. A silent-no-op TOOLS resolution instead throws
    // inside the hook's own try/catch and the hook falls back to printing bare 'OK'.
    fs.writeFileSync(
      path.join(toolsDir, 'memory-context.js'),
      `process.stdout.write('STUB CONTEXT LINE');`
    );

    const out = execFileSync(process.execPath, [path.join(__dirname, 'memory-context-inject.js')], {
      env: { ...process.env, AGENT_TOOLS_ROOT: toolsDir },
      encoding: 'utf8',
      timeout: 5000,
    });

    assert.match(out, /STUB CONTEXT LINE/, `expected injected stub context, got: ${out}`);
  } finally {
    fs.rmSync(toolsDir, { recursive: true, force: true });
  }
});

test('end-to-end regression: with no resolvable TOOLS dir anywhere, hook falls back to bare OK (documents the no-op, does not crash)', () => {
  // The real second candidate is path.resolve(__dirname, '..', 'tools') -- to actually exhaust
  // all three candidates (not accidentally fall through to this repo's real tools/), copy the
  // hook into an isolated fixture dir with no sibling tools/ and no marker anywhere reachable.
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-fixture-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-home-'));
  const hooksDir = path.join(fixtureRoot, 'hooks');
  const emptyToolsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tools-root-empty-'));
  try {
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'memory-context-inject.js'), path.join(hooksDir, 'memory-context-inject.js'));
    // fixtureRoot has no tools/ dir at all, so ../tools relative to hooksDir does not exist.

    const out = execFileSync(process.execPath, [path.join(hooksDir, 'memory-context-inject.js')], {
      env: { ...process.env, AGENT_TOOLS_ROOT: emptyToolsRoot, HOME: fakeHome, USERPROFILE: fakeHome },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(out, 'OK');
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(emptyToolsRoot, { recursive: true, force: true });
  }
});
