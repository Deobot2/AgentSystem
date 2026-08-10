// sam-audit-cache.test.js — reuse-or-audit decision logic for #337.
//
// Run: node --test tools/sam-audit-cache.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, record, hashDiffFile, readEntry } from './sam-audit-cache.js';

const TOOL = join(dirname(fileURLToPath(import.meta.url)), 'sam-audit-cache.js');

function tmpDiff(content) {
  const dir = mkdtempSync(join(tmpdir(), 'sam-audit-diff-'));
  const file = join(dir, 'diff.txt');
  writeFileSync(file, content);
  return { dir, file };
}

function tmpCacheDir() {
  return mkdtempSync(join(tmpdir(), 'sam-audit-cache-'));
}

test('check misses when no cache entry exists', () => {
  const { file } = tmpDiff('diff A');
  const dir = tmpCacheDir();
  const result = check({ pr: '1', baseRef: 'main', diffFile: file, dir });
  assert.equal(result.reuse, false);
  assert.match(result.reason, /no cache entry/);
});

test('record then check hits on an identical diff and base ref', () => {
  const { file } = tmpDiff('diff A');
  const dir = tmpCacheDir();
  record({ pr: '2', baseRef: 'main', diffFile: file, runId: '555', dir });
  const result = check({ pr: '2', baseRef: 'main', diffFile: file, dir });
  assert.equal(result.reuse, true);
  assert.equal(result.runId, '555');
});

test('check misses when the diff content changed', () => {
  const first = tmpDiff('diff A');
  const dir = tmpCacheDir();
  record({ pr: '3', baseRef: 'main', diffFile: first.file, runId: '1', dir });
  const second = tmpDiff('diff A but different');
  const result = check({ pr: '3', baseRef: 'main', diffFile: second.file, dir });
  assert.equal(result.reuse, false);
  assert.match(result.reason, /diff changed/);
});

test('check misses across a base-branch change even with an identical diff', () => {
  const { file } = tmpDiff('diff A');
  const dir = tmpCacheDir();
  record({ pr: '4', baseRef: 'dev', diffFile: file, runId: '1', dir });
  const result = check({ pr: '4', baseRef: 'main', diffFile: file, dir });
  assert.equal(result.reuse, false);
  assert.match(result.reason, /base ref changed/);
});

test('check never reuses a non-approved cached verdict', () => {
  const { file } = tmpDiff('diff A');
  const dir = tmpCacheDir();
  // Simulate a cache entry that somehow recorded a non-approved verdict (defense in depth —
  // record() never writes one today, but check() must not trust the field blindly).
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pr-5.json'), JSON.stringify({
    verdict: 'blocked', baseRef: 'main', diffHash: hashDiffFile(file), runId: '1', auditedAt: 'x',
  }));
  const result = check({ pr: '5', baseRef: 'main', diffFile: file, dir });
  assert.equal(result.reuse, false);
  assert.match(result.reason, /not 'approved'/);
});

test('check fails toward auditing on a missing diff file', () => {
  const dir = tmpCacheDir();
  const result = check({ pr: '6', baseRef: 'main', diffFile: join(dir, 'does-not-exist.txt'), dir });
  assert.equal(result.reuse, false);
  assert.match(result.reason, /could not hash diff/);
});

test('check fails toward auditing on a corrupt cache file', () => {
  const { file } = tmpDiff('diff A');
  const dir = tmpCacheDir();
  writeFileSync(join(dir, 'pr-7.json'), '{ not json');
  const result = check({ pr: '7', baseRef: 'main', diffFile: file, dir });
  assert.equal(result.reuse, false);
});

test('check requires pr/baseRef/diffFile', () => {
  const dir = tmpCacheDir();
  const result = check({ pr: '', baseRef: 'main', diffFile: 'x', dir });
  assert.equal(result.reuse, false);
  assert.match(result.reason, /missing required input/);
});

test('record always writes verdict "approved"', () => {
  const { file } = tmpDiff('diff A');
  const dir = tmpCacheDir();
  const entry = record({ pr: '8', baseRef: 'main', diffFile: file, runId: '9', dir });
  assert.equal(entry.verdict, 'approved');
  const stored = readEntry(dir, '8');
  assert.equal(stored.diffHash, hashDiffFile(file));
});

test('CLI check prints JSON and exits 0 on a miss', () => {
  const dir = tmpCacheDir();
  const { file } = tmpDiff('diff A');
  const out = execFileSync(process.execPath, [
    TOOL, 'check', '--pr', '10', '--base-ref', 'main', '--diff-file', file, '--cache-dir', dir,
  ], { encoding: 'utf8' });
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.reuse, false);
});

test('CLI record then CLI check hits', () => {
  const dir = tmpCacheDir();
  const { file } = tmpDiff('diff A');
  execFileSync(process.execPath, [
    TOOL, 'record', '--pr', '11', '--base-ref', 'main', '--diff-file', file, '--run-id', '42', '--cache-dir', dir,
  ], { encoding: 'utf8' });
  const out = execFileSync(process.execPath, [
    TOOL, 'check', '--pr', '11', '--base-ref', 'main', '--diff-file', file, '--cache-dir', dir,
  ], { encoding: 'utf8' });
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.reuse, true);
  assert.equal(parsed.runId, '42');
});

test('CLI record exits 2 on missing required flags', () => {
  const dir = tmpCacheDir();
  assert.throws(() => {
    execFileSync(process.execPath, [TOOL, 'record', '--pr', '12', '--cache-dir', dir], { encoding: 'utf8' });
  });
});

test('CLI with unknown command exits 2', () => {
  assert.throws(() => {
    execFileSync(process.execPath, [TOOL, 'bogus'], { encoding: 'utf8' });
  });
});
