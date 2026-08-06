/**
 * agy-dispatcher: the agy harness is wired to the real agy-persistence module
 * (#84) and no longer has a stub path (#203).
 *
 * What is real here: the dispatcher, agy-persistence, the argv it builds, an OS
 * spawn, and the pid that comes back. What is stubbed: the `agy` binary itself,
 * and `tmux` (forced to fail so the spawn goes down agy-persistence's direct
 * path, which returns the pid we assert on — the tmux branch would otherwise
 * inherit PATH from an already-running tmux server and invoke the real agy).
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// agy-persistence resolves its log dir from homedir() at import time, so HOME is
// redirected before the dynamic import below — otherwise this litters the real
// ~/.agy-mission-control.
const sandbox = mkdtempSync(join(tmpdir(), 'agy-dispatcher-test-'));
process.env.HOME = sandbox;

const argvLog = join(sandbox, 'argv.txt');
const fakeBin = join(sandbox, 'bin');
mkdirSync(fakeBin, { recursive: true });

// /bin/sh, not node: the kernel resolves this shebang directly, with no PATH lookup.
// Records the argv it was handed, then stays alive so the reported pid is still
// a live process when we assert on it.
writeFileSync(join(fakeBin, 'agy'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvLog}'\nexec sleep 30\n`);
chmodSync(join(fakeBin, 'agy'), 0o755);
writeFileSync(join(fakeBin, 'tmux'), '#!/bin/sh\nexit 1\n');
chmodSync(join(fakeBin, 'tmux'), 0o755);
process.env.PATH = `${fakeBin}:${process.env.PATH}`;

const mod = await import('./agy-dispatcher.js');

const spawnedPids = [];
after(() => {
  for (const pid of spawnedPids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  rmSync(sandbox, { recursive: true, force: true });
});

async function waitForFile(path, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, 'utf8');
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${path}`);
}

test('the one-shot stub path is gone, not merely bypassed', () => {
  assert.equal(mod.spawnAgyOneShotDirect, undefined);
  assert.deepEqual(Object.keys(mod.default), ['spawnAgyPersistent']);
});

test('a harness failure surfaces its real cause instead of a masked spawn error', async () => {
  // The stub caught this, re-spawned `agy` one-shot against the same bad path, and
  // reported "Failed to spawn agy: ... ENOENT" — losing the actual reason. Worse,
  // when the fallback did resolve it handed back sessionId 'agy-oneShotFallback'
  // with no pid, which webhook-server records as status=running, pid=null.
  await assert.rejects(
    () => mod.spawnAgyPersistent('task', join(sandbox, 'no-such-repo')),
    /Repo not found/,
  );
});

test('an agy dispatch reaches the real harness and reports a live pid', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'agy-repo-'));
  const result = await mod.spawnAgyPersistent('do a thing', repoPath, 'gemini-3-pro', 'leo');
  spawnedPids.push(result.pid);

  // sessionId comes from agy-persistence's conversationId, not a stub literal.
  assert.match(result.sessionId, /^agy-\d+$/);
  assert.equal(result.status, 'running');
  assert.equal(typeof result.pid, 'number');
  // The pid webhook-server stores must be reapable by reapDeadAgySessions().
  assert.doesNotThrow(() => process.kill(result.pid, 0));

  const argv = (await waitForFile(argvLog)).trim().split('\n');
  assert.deepEqual(argv, ['-p', 'do a thing', '--agent', 'leo', '--model', 'gemini-3-pro', '--add-dir', repoPath]);
  // Out of scope for #203 and must stay that way: unattended remote dispatch
  // does not silently skip the permission prompt.
  assert.ok(!argv.includes('--dangerously-skip-permissions'));

  rmSync(repoPath, { recursive: true, force: true });
});
