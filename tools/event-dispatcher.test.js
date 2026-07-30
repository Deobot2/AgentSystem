// Dispatcher: drains bus with typed handlers; handler errors flow into the bus's
// retry/dead-letter path; unknown types dead-letter after maxAttempts; run-tool is
// confined to tools/.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as bus from './event-bus.js';
import { drain, runToolHandler, spawnAgentHandler, cmdQuote } from './event-dispatcher.js';

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'event-disp-')); }

test('drain: completes noop events and reports summary', () => {
  const root = tmpRoot();
  bus.publish({ type: 'noop' }, root);
  bus.publish({ type: 'noop' }, root);
  const s = drain({ root });
  assert.deepEqual(
    { processed: s.processed, completed: s.completed, dead: s.dead },
    { processed: 2, completed: 2, dead: 0 });
  assert.equal(bus.stats(root).done, 2);
});

test('drain: failing handler requeues with backoff (not retried in same pass)', () => {
  const root = tmpRoot();
  bus.publish({ type: 'run-tool' }, root);
  const s = drain({ root, handlers: { 'run-tool': () => { throw new Error('nope'); } } });
  assert.equal(s.requeued, 1);
  const [p] = bus.listPending(root);
  assert.equal(p.event.attempts, 1);
});

test('drain: event type without a handler dead-letters after maxAttempts with alert', () => {
  const root = tmpRoot();
  bus.publish({ type: 'spawn-agent', maxAttempts: 1 }, root);
  const s = drain({ root, handlers: { 'spawn-agent': undefined } });
  assert.equal(s.dead, 1);
  const dead = fs.readFileSync(bus.dirs(root).dead, 'utf8').trim().split('\n').map(JSON.parse);
  assert.match(dead[0].lastError, /no handler/);
  assert.equal(bus.stats(root).alerts, 1);
});

test('drain: respects max events per pass', () => {
  const root = tmpRoot();
  for (let i = 0; i < 5; i++) bus.publish({ type: 'noop' }, root);
  const s = drain({ root, max: 2 });
  assert.equal(s.processed, 2);
  assert.equal(bus.listPending(root).length, 3);
});

test('drain: recovers stale processing claims before draining', () => {
  const root = tmpRoot();
  bus.publish({ type: 'noop' }, root);
  const stale = bus.claimNext(root);
  const old = Date.now() - 3600_000;
  fs.utimesSync(stale.claimFile, old / 1000, old / 1000);
  const s = drain({ root });
  assert.equal(s.recovered, 1);
  assert.equal(s.completed, 1); // recovered event drained in same pass
});

test('runToolHandler: rejects scripts outside tools/', () => {
  assert.throws(() => runToolHandler({ script: '../hooks/memory-router.js' }), /escapes tools/);
  assert.throws(() => runToolHandler({ script: 'C:/Windows/System32/evil.js' }), /escapes tools|not found/);
});

test('runToolHandler: runs a real tools script and returns tail of output', () => {
  const out = runToolHandler({ script: 'routines.js', args: ['list'] });
  assert.equal(typeof out, 'string');
});

test('spawnAgentHandler: rejects agent names outside the roster shape', () => {
  assert.throws(() => spawnAgentHandler({ agent: 'friday; rm -rf /', prompt: 'x' }), /invalid agent name/);
  assert.throws(() => spawnAgentHandler({ agent: 'friday && whoami', prompt: 'x' }), /invalid agent name/);
});

test('spawnAgentHandler: rejects model overrides outside the model-id shape', () => {
  assert.throws(
    () => spawnAgentHandler({ agent: 'threepio', prompt: 'x', model: 'claude-sonnet-5; whoami' }),
    /invalid model/,
  );
});

test('cmdQuote: neutralizes quotes and newlines so payload cannot break out of cmd', () => {
  assert.equal(cmdQuote('plain prompt'), '"plain prompt"');
  assert.equal(cmdQuote('say "hi" & del *'), '"say ""hi"" & del *"');
  assert.equal(cmdQuote('line1\r\nline2'), '"line1 line2"');
});
