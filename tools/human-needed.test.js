// human-needed.test.js — the pure logic behind the idempotent alert.
//
// The gh calls are not exercised (they need a live repo); what is tested is everything that
// decides *whether* a call happens, because those are the bugs that matter: a duplicate issue
// every morning, or a ping storm on a tight loop.
//
// Run: node --test tools/human-needed.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  markerFor, findByMarker, shouldPing, buildBody, parseArgs, PING_WINDOW_HOURS,
} from './human-needed.js';

const TOOL = join(dirname(fileURLToPath(import.meta.url)), 'human-needed.js');

test('markerFor embeds the key in an HTML comment', () => {
  assert.equal(markerFor('daily-triage-skill-missing'), '<!-- human-needed:key=daily-triage-skill-missing -->');
});

test('findByMarker matches on the key, not the title', () => {
  const issues = [
    { number: 1, title: 'unrelated', body: 'no marker here' },
    { number: 2, title: 'Human edited this title beyond recognition', body: `${markerFor('abc')}\n\nwhy` },
  ];
  assert.equal(findByMarker(issues, 'abc').number, 2);
});

test('findByMarker does not match a key that is a prefix of another', () => {
  const issues = [{ number: 7, body: markerFor('daily-triage-skill-missing') }];
  assert.equal(findByMarker(issues, 'daily-triage'), null);
});

test('findByMarker returns null on no match and tolerates a missing body', () => {
  assert.equal(findByMarker([{ number: 1 }], 'abc'), null);
  assert.equal(findByMarker([], 'abc'), null);
});

test('shouldPing is true with no comments', () => {
  assert.equal(shouldPing([]), true);
  assert.equal(shouldPing(undefined), true);
});

test('shouldPing is false inside the window and true outside it', () => {
  const now = new Date('2026-08-03T07:00:00Z');
  const hoursAgo = (h) => ({ createdAt: new Date(now.getTime() - h * 3600e3).toISOString() });
  assert.equal(shouldPing([hoursAgo(1)], now), false);
  assert.equal(shouldPing([hoursAgo(PING_WINDOW_HOURS - 1)], now), false);
  assert.equal(shouldPing([hoursAgo(PING_WINDOW_HOURS + 1)], now), true);
});

test('shouldPing uses the newest comment regardless of array order', () => {
  const now = new Date('2026-08-03T07:00:00Z');
  const comments = [
    { createdAt: '2026-07-01T00:00:00Z' },      // ancient
    { createdAt: '2026-08-03T06:30:00Z' },      // 30 min ago
    { createdAt: '2026-07-15T00:00:00Z' },
  ];
  assert.equal(shouldPing(comments, now), false);
});

test('shouldPing ignores unparseable timestamps', () => {
  const now = new Date('2026-08-03T07:00:00Z');
  assert.equal(shouldPing([{ createdAt: 'not-a-date' }], now), true);
});

test('a daily job at a fixed time still pings every day', () => {
  // The reason the window is 20h and not 24h: consecutive daily runs drift, and a 24h window
  // would swallow every second day's ping.
  const yesterday = { createdAt: '2026-08-02T07:04:00Z' };
  const todayRun = new Date('2026-08-03T07:01:00Z');   // 23h57m later
  assert.equal(shouldPing([yesterday], todayRun), true);
});

test('buildBody puts the marker first so a human editing the body keeps it', () => {
  const body = buildBody({ key: 'k1', why: 'because', action: 'do the thing', source: 'wf' });
  assert.ok(body.startsWith(markerFor('k1')));
  assert.match(body, /because/);
  assert.match(body, /What a human needs to do/);
  assert.match(body, /do the thing/);
  assert.match(body, /Raised by `wf`/);
});

test('buildBody omits the action section when there is no action', () => {
  const body = buildBody({ key: 'k1', why: 'because' });
  assert.doesNotMatch(body, /What a human needs to do/);
});

test('parseArgs accepts both --flag value and --flag=value', () => {
  const a = parseArgs(['raise', 'my-key', '--title', 'A title', '--why=some reason']);
  assert.equal(a.cmd, 'raise');
  assert.equal(a.key, 'my-key');
  assert.equal(a.flags.title, 'A title');
  assert.equal(a.flags.why, 'some reason');
});

test('parseArgs treats a trailing bare flag as boolean', () => {
  const a = parseArgs(['resolve', 'k', '--dry-run']);
  assert.equal(a.flags['dry-run'], true);
});

test('parseArgs does not swallow the next flag as a value', () => {
  const a = parseArgs(['raise', 'k', '--why', '--title', 'T']);
  assert.equal(a.flags.why, true, '--why had no value; --title must not become it');
  assert.equal(a.flags.title, 'T');
});

// ── CLI contract ───────────────────────────────────────────────────────────────

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

test('CLI exits 2 on an unknown command', () => {
  assert.equal(run(['frobnicate']).code, 2);
});

test('CLI exits 2 when raise is missing its key or title', () => {
  assert.equal(run(['raise', '--title', 'T']).code, 2);
  assert.equal(run(['raise', 'some-key']).code, 2);
});

test('CLI --dry-run raises nothing and exits 0', () => {
  // Proves the guard order: no gh call can happen before the dry-run branch, so this test is
  // safe to run in CI against a real repo.
  const r = run(['raise', 'test-key', '--title', 'T', '--why', 'W', '--dry-run']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /\[dry-run\]/);
  assert.match(r.stdout, /human-needed:key=test-key/);
});

test('CLI runs main() when invoked through a symlinked path', () => {
  // The whole point of tools/is-main.js. A new tool that fails this is a silent no-op in prod.
  const sandbox = mkdtempSync(join(tmpdir(), 'hn-symlink-'));
  try {
    const link = join(sandbox, 'tools');
    symlinkSync(dirname(TOOL), link, 'dir');
    const r = run([]);            // sanity: usage path works
    assert.equal(r.code, 2);
    const viaLink = (() => {
      try {
        return { code: 0, stdout: execFileSync(process.execPath, [join(link, 'human-needed.js'), 'raise', 'k', '--title', 'T', '--dry-run'], { encoding: 'utf8' }) };
      } catch (err) { return { code: err.status, stdout: err.stdout || '' }; }
    })();
    assert.equal(viaLink.code, 0);
    assert.match(viaLink.stdout, /\[dry-run\]/, 'symlinked invocation must still run main()');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
