// session-namer-symlink.test.js — regression test: session-namer.js must run
// main() when invoked through a symlink.
//
// Why this exists: the is-main-module check compared
// `pathToFileURL(process.argv[1]).href` to `import.meta.url`. `import.meta.url`
// is ALWAYS the symlink-resolved path; argv[1] is not. Since ~/dev/AgentSystem
// is a symlink to the real checkout — and the installed hooks, session-close.sh,
// and /rename-session all invoke `node ~/dev/AgentSystem/tools/session-namer.js`
// — the comparison never matched and the tool exited 0 having done nothing at
// all. Silent, exit-code-clean no-op, for every production caller.
//
// Run: node --test tools/session-namer-symlink.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));

const SESSION_ID = 'ffeeddccbbaa9988';
const ENTRY = {
  session: SESSION_ID,
  name: 'original-name',
  title: 'original name',
  repo: 'test-repo',
  cwd: '/tmp/test',
  date: '2026-07-26',
};

let sandbox;      // holds both the fake HOME and the symlink to tools/
let fakeHome;
let registryPath;
let linkedTool;   // tools/ reached through a symlink, mimicking ~/dev/AgentSystem

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'sn-symlink-test-'));
  fakeHome = join(sandbox, 'home');
  const nexusDir = join(fakeHome, 'agent-memory', 'nexus');
  mkdirSync(nexusDir, { recursive: true });
  registryPath = join(nexusDir, 'session-registry.jsonl');
  writeFileSync(registryPath, `${JSON.stringify(ENTRY)}\n`);

  const linkDir = join(sandbox, 'linked-tools');
  symlinkSync(TOOLS_DIR, linkDir, 'dir');
  linkedTool = join(linkDir, 'session-namer.js');
});

after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function runVia(toolPath, args) {
  return execFileSync(process.execPath, [toolPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SESSION_NAMER_HOME: fakeHome },
    timeout: 10_000,
  });
}

function readRegistry() {
  return readFileSync(registryPath, 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('--list produces output when invoked through a symlinked directory', () => {
  const out = runVia(linkedTool, ['--list', '--limit=5']);
  assert.ok(out.trim().length > 0, 'symlinked invocation printed nothing — main() did not run');
  assert.match(out, /original-name/);
});

test('--auto-rename actually writes the registry through a symlinked path', () => {
  writeFileSync(registryPath, `${JSON.stringify(ENTRY)}\n`);
  runVia(linkedTool, ['--auto-rename', SESSION_ID, 'renamed via symlink', '--status=done']);

  const entry = readRegistry().filter((e) => e.session === SESSION_ID).pop();
  assert.ok(entry, 'session entry vanished');
  assert.notEqual(entry.name, 'original-name', '--auto-rename exited 0 but changed nothing');
  assert.match(entry.name, /renamed via symlink/);
});

test('the direct (non-symlinked) path still works', () => {
  const out = runVia(join(TOOLS_DIR, 'session-namer.js'), ['--list', '--limit=5']);
  assert.ok(out.trim().length > 0);
});
