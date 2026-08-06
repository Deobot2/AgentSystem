import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stateLabel } from '../tools/life-os-outbox.js';

function fixtureConfig(mode) {
  const dir = mkdtempSync(join(tmpdir(), 'outbox-test-'));
  const p = join(dir, 'outbound-channels.json');
  writeFileSync(p, JSON.stringify({ channels: { messenger: { mode } } }));
  return p;
}

function expiredEntry() {
  return {
    network: 'messenger',
    createdAt: new Date(Date.now() - 13 * 3600 * 1000).toISOString(), // hold (12h) has passed
    sendsAfter: new Date(Date.now() - 3600 * 1000).toISOString(),
  };
}

test('label is NOT DUE when hold expired but channel is draft-only', () => {
  const configPath = fixtureConfig('draft-only');
  const label = stateLabel(expiredEntry(), new Date(), { configPath });
  assert.notStrictEqual(label, 'DUE');
  assert.strictEqual(label, 'held — messenger is draft-only');
});

test('label IS DUE when hold expired and channel is send-eligible', () => {
  const configPath = fixtureConfig('send');
  const label = stateLabel(expiredEntry(), new Date(), { configPath });
  assert.strictEqual(label, 'DUE');
});

test('label still shows the hold window when it has not expired yet', () => {
  const configPath = fixtureConfig('send');
  const entry = {
    network: 'messenger',
    createdAt: new Date().toISOString(),
    sendsAfter: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
  };
  const label = stateLabel(entry, new Date(), { configPath });
  assert.strictEqual(label, `holds until ${entry.sendsAfter}`);
});
