// #323: with no .gitattributes, a Windows checkout under core.autocrlf=true rewrites shell
// scripts to CRLF. That makes tools/deploy-hooks.js --check report permanent false-positive
// drift (repo LF vs. installed CRLF, byte-different but content-identical), and a CRLF shebang
// (`#!/bin/bash\r`) is a real failure on the self-hosted Linux runner — the kernel looks for an
// interpreter literally named `bash\r`.
//
// Fix is a .gitattributes pinning `eol=lf` for *.sh and hooks/**. This test asks git itself
// (`git check-attr`, the same resolution a checkout uses) whether that pin is in effect, rather
// than asserting file contents — the failure mode is about attribute resolution, not bytes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

function eolAttr(relPath) {
  const out = execFileSync('git', ['check-attr', 'eol', '--', relPath], { cwd: REPO, encoding: 'utf8' });
  // Format: "<path>: eol: <value>"
  return out.trim().split(': eol: ')[1];
}

const SHELL_HOOKS = [
  'hooks/claude-hooks/context-handoff.sh',
  'hooks/claude-hooks/guard-git.sh',
  'hooks/claude-hooks/session-close.sh',
];

for (const f of SHELL_HOOKS) {
  test(`${f} resolves to eol=lf`, () => {
    assert.equal(eolAttr(f), 'lf', `${f} is not pinned to lf — Windows checkouts will rewrite it to CRLF`);
  });
}

test('*.sh anywhere in the repo resolves to eol=lf, not just hooks/', () => {
  assert.equal(eolAttr('install.sh'), 'lf');
  assert.equal(eolAttr('tools/brain-join.sh'), 'lf');
});

test('non-.sh files under hooks/ are also pinned (issue asked for hooks/** too)', () => {
  assert.equal(eolAttr('hooks/memory-router.js'), 'lf');
});
