// tests/compute-trust-scores.test.js
// Regression test for the "green run, no work done" failure mode (#314).
//
// compute-trust-scores.js used to print "Run-log directory does not exist — writing empty report"
// and exit 0, so `weekly-trust-scores` reported success every week while the real report at
// ~/agent-memory/nexus/trust-scores.md stayed frozen at 159 bytes of "No run data yet." from
// 2026-07-05. hooks/memory-router.js routes on that file, so the stub was actively load-bearing.
// Missing input must now be a hard failure, and --allow-empty must never clobber a real report.
//
// node --test tests/compute-trust-scores.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(repoRoot, 'tools', 'compute-trust-scores.js');

// os.homedir() reads USERPROFILE on win32 and ignores HOME, so seeding only HOME would let a
// failing test write into the developer's real brain. AGENT_MEMORY_ROOT is checked first by
// graph-lib.js:agentMemoryRoot() on every platform -- that is the whole reason this tool was
// switched off the hardcoded os.homedir() path.
function run(memoryRoot, args = []) {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_MEMORY_ROOT: memoryRoot },
  });
}

function runExpectingFailure(memoryRoot, args = []) {
  try {
    run(memoryRoot, args);
  } catch (err) {
    return { status: err.status, stderr: err.stderr || '', stdout: err.stdout || '' };
  }
  assert.fail('expected a non-zero exit');
}

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'trust-scores-test-'));
  try {
    fn(root, join(root, 'nexus', 'trust-scores.md'), join(root, 'nexus', 'run-log'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('missing run-log directory exits non-zero and writes nothing', () => {
  withRoot((root, report) => {
    const { status, stderr } = runExpectingFailure(root);
    assert.equal(status, 1);
    assert.match(stderr, /Run-log directory does not exist/);
    assert.equal(existsSync(report), false, 'must not write a stub report on failure');
  });
});

test('empty run-log directory exits non-zero', () => {
  withRoot((root, report, runLog) => {
    mkdirSync(runLog, { recursive: true });
    const { status, stderr } = runExpectingFailure(root);
    assert.equal(status, 1);
    assert.match(stderr, /No run log files found/);
    assert.equal(existsSync(report), false);
  });
});

test('--allow-empty bootstraps a report when none exists', () => {
  withRoot((root, report) => {
    const stdout = run(root, ['--allow-empty']);
    assert.match(stdout, /allow-empty/);
    assert.equal(existsSync(report), true);
    assert.match(readFileSync(report, 'utf8'), /No run data yet/);
  });
});

test('--allow-empty refuses to overwrite an existing report with a stub', () => {
  withRoot((root, report) => {
    mkdirSync(dirname(report), { recursive: true });
    writeFileSync(report, '# Agent Trust Scores\n\n| leo | 12 | 11 | 1 | 0 | 92% |\n', 'utf8');
    const { status, stderr } = runExpectingFailure(root, ['--allow-empty']);
    assert.equal(status, 1);
    assert.match(stderr, /refusing to replace real data/);
    assert.match(readFileSync(report, 'utf8'), /92%/, 'the real report must survive');
  });
});

test('real run logs produce a real report', () => {
  withRoot((root, report, runLog) => {
    mkdirSync(runLog, { recursive: true });
    writeFileSync(join(runLog, 'a.json'), JSON.stringify({ agent: 'Leo', result: 'DONE: shipped' }));
    writeFileSync(join(runLog, 'b.json'), JSON.stringify({ agent: 'leo', result: 'BLOCKED: no runner' }));

    // Numbers passed as separate console.log args are inspected, so they arrive ANSI-coloured --
    // assert on the report content, which is the actual deliverable.
    const stdout = run(root);
    assert.match(stdout, /Agents tracked:/);

    const md = readFileSync(report, 'utf8');
    assert.match(md, /\| leo \| 2 \| 1 \| 1 \| 0 \| 50% \|/);
  });
});

// The "already exists" guard tested existence as a proxy for "holds real data", and the file it
// was protecting on every host was the tool's OWN empty stub -- committed to the agent-memory
// repo and synced everywhere. So --allow-empty, the documented escape hatch, could never fire:
// weekly-trust-scores was unfixable short of deleting a tracked file. A stub is not data.
test('--allow-empty replaces the tool\'s own empty stub instead of deadlocking', () => {
  withRoot((root, report) => {
    mkdirSync(join(root, 'nexus'), { recursive: true });
    writeFileSync(report, [
      '# Agent Trust Scores',
      '_Last updated: 2026-07-06T05:15:28.729Z_',
      '',
      'No run data yet. Run logs are written to `~/agent-memory/nexus/run-log/` by agent-dispatch.yml.',
    ].join('\n'));

    const stdout = run(root, ['--allow-empty']);
    assert.match(stdout, /writing empty report/);
  });
});

test('--allow-empty still refuses to replace a report holding real run data', () => {
  withRoot((root, report) => {
    mkdirSync(join(root, 'nexus'), { recursive: true });
    writeFileSync(report, '# Agent Trust Scores\n\n| agent | runs | success |\n| friday | 12 | 11 |\n');

    const { status, stderr } = runExpectingFailure(root, ['--allow-empty']);
    assert.equal(status, 1);
    assert.match(stderr, /refusing to replace real data/);
  });
});
