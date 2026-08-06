#!/usr/bin/env node
// Keeps docs/harness-support.md honest.
//
// The matrix is only worth having if it cannot quietly go stale, and the way it goes stale is
// someone registering a new hook. Every hook is Claude-only (issue #240), so a new one is a new
// Antigravity gap by construction — if the matrix does not mention it, the matrix now overstates
// Antigravity support. That is the same defect class as #200: the artefact claiming coverage it
// does not have.
//
// Deliberately not checked: whether a `supported` cell is actually reachable on that host. Probing
// a live `agy` needs the CLI installed, which CI does not have, and a probe that silently skips is
// worse than no probe. The doc's "Verifying a cell" section makes that a human step.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOOK_REGISTRY } from '../tools/deploy-hooks.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = join(REPO, 'docs', 'harness-support.md');
const doc = readFileSync(DOC, 'utf8');

// `node "<dir>/foo.js"` / `bash "<dir>/foo.sh"` -> foo.js
const hookFile = (cmd) => basename(cmd.replace(/"$/, ''));

// Rows of the support matrix, as { feature, claude, antigravity, reason }.
function matrixRows() {
  const rows = doc
    .split('\n')
    .filter((l) => l.startsWith('|'))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
    .filter((c) => c.length === 4)
    .filter((c) => c[0] !== 'Feature' && !/^-+$/.test(c[0]));
  assert.ok(rows.length > 5, 'no matrix rows parsed — did the table format change?');
  return rows.map(([feature, claude, antigravity, reason]) => ({ feature, claude, antigravity, reason }));
}

const STATES = ['`supported`', '`unsupported-by-design`', '`gap`'];

test('harness matrix: every hook is accounted for', () => {
  const missing = HOOK_REGISTRY
    .map((h) => hookFile(h.command))
    .filter((f, i, all) => all.indexOf(f) === i)
    .filter((f) => !doc.includes(f));

  assert.deepEqual(
    missing,
    [],
    `these hooks are registered but absent from docs/harness-support.md.\n`
    + `Every hook is Claude-only, so each one is an Antigravity gap — add it to a row's reason, `
    + `or the matrix now claims support that does not exist.`,
  );
});

test('harness matrix: every cell has a declared state', () => {
  for (const row of matrixRows()) {
    for (const host of ['claude', 'antigravity']) {
      assert.ok(
        STATES.some((s) => row[host].startsWith(s)),
        `"${row.feature}" / ${host} is "${row[host]}" — must start with one of ${STATES.join(', ')}`,
      );
    }
  }
});

test('harness matrix: every gap links a tracking issue', () => {
  for (const row of matrixRows()) {
    if (row.claude !== '`gap`' && row.antigravity !== '`gap`') continue;
    assert.match(
      row.reason,
      /#\d+/,
      `"${row.feature}" is a gap with no issue link — a gap nobody tracks is just an excuse`,
    );
  }
});

test('harness matrix: every non-supported cell gives a reason', () => {
  for (const row of matrixRows()) {
    if (row.claude === '`supported`' && row.antigravity === '`supported`') continue;
    assert.ok(row.reason.length > 20, `"${row.feature}" is not fully supported but has no real reason string`);
  }
});
