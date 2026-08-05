import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findClaudeJsonBackups, pruneBackups, findOrphanedTmpFiles, deleteFiles } from './claude-json-hygiene.js';

function touch(filePath, mtimeMs) {
  fs.writeFileSync(filePath, '');
  if (mtimeMs != null) {
    const d = new Date(mtimeMs);
    fs.utimesSync(filePath, d, d);
  }
}

test('findClaudeJsonBackups finds corrupted and backup family files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cjh-'));
  touch(path.join(dir, '.claude.json.corrupted.1'));
  touch(path.join(dir, '.claude.json.backup.1'));
  touch(path.join(dir, '.claude.json'));
  touch(path.join(dir, 'settings.json'));
  const found = findClaudeJsonBackups(dir);
  assert.equal(found.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pruneBackups keeps newest N per family and deletes the rest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cjh-'));
  const now = Date.now();
  const files = [];
  for (let i = 0; i < 7; i++) {
    const p = path.join(dir, `.claude.json.corrupted.${i}`);
    touch(p, now - i * 3600 * 1000);
    files.push({ full: p, name: path.basename(p), family: 'corrupted', mtimeMs: now - i * 3600 * 1000 });
  }
  const { deleted } = pruneBackups(files, 5, false);
  assert.equal(deleted.length, 2);
  for (const d of deleted) assert.ok(!fs.existsSync(d));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pruneBackups dry-run deletes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cjh-'));
  const now = Date.now();
  const files = [];
  for (let i = 0; i < 3; i++) {
    const p = path.join(dir, `.claude.json.backup.${i}`);
    touch(p, now - i * 1000);
    files.push({ full: p, name: path.basename(p), family: 'backup', mtimeMs: now - i * 1000 });
  }
  const { deleted } = pruneBackups(files, 1, true);
  assert.equal(deleted.length, 2);
  for (const d of deleted) assert.ok(fs.existsSync(d), 'dry-run must not actually delete');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pruneBackups flags same-minute clusters among kept files as collisions', () => {
  // Anchored to the START of a minute, not to Date.now(). With a bare `now`, `now + 500` crosses
  // into the NEXT minute whenever the test happens to run in the final 500ms of one — so the
  // cluster splits, no collision is found, and the assertion fails. ~1 run in 120. It flaked
  // locally and then failed CI on a required check, which is the worst version of this: a test
  // that is right 99% of the time and blocks a merge the other 1%.
  const minuteStart = Math.floor(Date.now() / 60000) * 60000;
  const files = [
    { full: '/a', name: 'a', family: 'corrupted', mtimeMs: minuteStart },
    { full: '/b', name: 'b', family: 'corrupted', mtimeMs: minuteStart + 500 }, // same minute, guaranteed
  ];
  const { collisions } = pruneBackups(files, 5, true);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].names.length, 2);
});

test('findOrphanedTmpFiles finds only tmp files older than cutoff', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cjh-home-'));
  const old = path.join(dir, 'installed_plugins.json.tmp.abc123');
  const fresh = path.join(dir, 'known_marketplaces.json.tmp.def456');
  touch(old, Date.now() - 48 * 3600 * 1000);
  touch(fresh, Date.now());
  const found = findOrphanedTmpFiles(dir, 24);
  assert.equal(found.length, 1);
  assert.ok(found[0].endsWith('installed_plugins.json.tmp.abc123'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('deleteFiles removes listed files and returns their paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cjh-'));
  const f = path.join(dir, 'x.tmp.1');
  touch(f);
  const deleted = deleteFiles([f], false);
  assert.deepEqual(deleted, [f]);
  assert.ok(!fs.existsSync(f));
  fs.rmSync(dir, { recursive: true, force: true });
});
