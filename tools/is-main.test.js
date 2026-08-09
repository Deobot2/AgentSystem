// is-main.test.js — two guarantees about the is-main-module check.
//
// 1. Behavioural: a tool invoked through a symlinked directory still runs main().
// 2. Structural: no file under tools/ or hooks/ hand-rolls the comparison again.
//
// Guarantee 2 is the point of this file. The symlink bug was found and fixed in
// session-namer.js (tools/session-namer-symlink.test.js), but the fix was a local edit, so the
// same broken comparison stayed in 25 other tools — including every one that config/routines.yml
// tells agents to run as `node ~/dev/AgentSystem/tools/<x>.js`, which is a symlink path. Each of
// those exited 0 having done nothing. A behavioural test per tool would not have caught the
// spread; a structural test does.
//
// Run: node --test tools/is-main.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainModule } from './is-main.js';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TOOLS_DIR, '..');

// The generated fixtures below `import` is-main.js by absolute path. An ESM specifier must be a
// file:// URL, not a bare OS path: on Windows `C:\...` is read as the URL scheme `c:` and the
// loader throws ERR_UNSUPPORTED_ESM_URL_SCHEME before the test's own assertion is reached.
const IS_MAIN_SPECIFIER = JSON.stringify(pathToFileURL(join(TOOLS_DIR, 'is-main.js')).href);

// Creating a directory symlink on Windows needs Developer Mode or an elevated shell; without
// either, symlinkSync throws EPERM. Probe once rather than assuming, so the guard narrows to the
// actual missing capability instead of to the platform.
function canSymlinkDirs() {
  const probe = mkdtempSync(join(tmpdir(), 'symlink-probe-'));
  try {
    mkdirSync(join(probe, 'target'));
    symlinkSync(join(probe, 'target'), join(probe, 'link'), 'dir');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}
const CAN_SYMLINK = canSymlinkDirs();
const NO_SYMLINK_REASON =
  'cannot create directory symlinks on this host (Windows without Developer Mode/admin); ' +
  'the symlink-resolution guarantee is still covered on Linux CI';

test('isMainModule is false when the module is merely imported', () => {
  // This test file is the entry point, not is-main.js, and not the caller's module.
  assert.equal(isMainModule(new URL('./is-main.js', import.meta.url).href), false);
});

test('isMainModule is true for the process entry point, reached directly', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'is-main-direct-'));
  try {
    const tool = join(sandbox, 'tool.mjs');
    writeFileSync(tool, [
      `import { isMainModule } from ${IS_MAIN_SPECIFIER};`,
      'process.stdout.write(isMainModule(import.meta.url) ? "MAIN" : "NOT_MAIN");',
    ].join('\n'));
    const out = execFileSync(process.execPath, [tool], { encoding: 'utf8' });
    assert.equal(out, 'MAIN');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('isMainModule is true when the entry point is reached through a symlinked dir', (t) => {
  if (!CAN_SYMLINK) return t.skip(NO_SYMLINK_REASON);
  // This is the production shape: ~/dev/AgentSystem is a symlink to the real checkout, so
  // argv[1] is the symlink path while import.meta.url is already resolved.
  const sandbox = mkdtempSync(join(tmpdir(), 'is-main-symlink-'));
  try {
    const real = join(sandbox, 'real');
    mkdirSync(real);
    const tool = join(real, 'tool.mjs');
    writeFileSync(tool, [
      `import { isMainModule } from ${IS_MAIN_SPECIFIER};`,
      'process.stdout.write(isMainModule(import.meta.url) ? "MAIN" : "NOT_MAIN");',
    ].join('\n'));

    const link = join(sandbox, 'link');
    symlinkSync(real, link, 'dir');

    const out = execFileSync(process.execPath, [join(link, 'tool.mjs')], { encoding: 'utf8' });
    assert.equal(out, 'MAIN', 'a symlinked invocation must still be recognised as main');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('isMainModule does not throw when argv[1] does not exist on disk', () => {
  // Defensive: an is-main check must never be the reason a tool fails to start.
  const saved = process.argv[1];
  try {
    process.argv[1] = join(tmpdir(), 'definitely-not-a-real-file-9e3f.mjs');
    assert.doesNotThrow(() => isMainModule(import.meta.url));
    assert.equal(isMainModule(import.meta.url), false);
  } finally {
    process.argv[1] = saved;
  }
});

// ── Structural guard ────────────────────────────────────────────────────────────
//
// Anything that mentions process.argv[1] in the same expression as import.meta.url is
// hand-rolling this check. `tools/is-main.js` documents the wrong forms, and the two
// symlink tests explain them in prose, so both are allowed to contain the strings.
const ALLOWED = new Set(['tools/is-main.js', 'tools/is-main.test.js', 'tools/session-namer-symlink.test.js']);

function sourceFiles() {
  const out = [];
  for (const dir of ['tools', 'hooks']) {
    let names;
    try { names = readdirSync(join(REPO_ROOT, dir)); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.js') && !name.endsWith('.mjs')) continue;
      const rel = `${dir}/${name}`;
      if (ALLOWED.has(rel)) continue;
      out.push(rel);
    }
  }
  return out;
}

test('no tool or hook hand-rolls the is-main comparison', () => {
  const offenders = [];
  for (const rel of sourceFiles()) {
    const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
    // Only flag lines/expressions that pair argv[1] with import.meta.url — the exact defect.
    // Comments are stripped first so an explanatory comment is not a failure.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (!/process\.argv\[1\]/.test(code)) continue;
    // Collapse to single-line statements so multi-line guards are seen whole.
    const flat = code.replace(/\s+/g, ' ');
    for (const stmt of flat.split(';')) {
      if (/process\.argv\[1\]/.test(stmt) && /import\.meta\.url/.test(stmt)) {
        offenders.push(rel);
        break;
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `These files compare process.argv[1] to import.meta.url directly. That check is false for ` +
      `every caller arriving through a symlink (~/dev/AgentSystem), making the tool a silent ` +
      `no-op. Use: import { isMainModule } from './is-main.js'; if (isMainModule(import.meta.url))`,
  );
});

test('every tool that guards on is-main imports the shared helper', () => {
  const offenders = [];
  for (const rel of sourceFiles()) {
    const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
    if (!/\bisMainModule\s*\(/.test(src)) continue;
    if (!/from '(?:\.\/|\.\.\/tools\/)is-main\.js'/.test(src)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], 'isMainModule() used without importing tools/is-main.js');
});
