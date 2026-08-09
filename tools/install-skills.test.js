#!/usr/bin/env node
// install-skills.js --check (#305): closes the "nothing detects skill parity drift" gap left
// open by #199. Modeled on deploy-hooks.test.js's sandboxed-HOME pattern — these tests must
// never touch the real ~/.claude/skills, only a throwaway HOME.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffSkills, listSkillDirs, CORE, srcRoot } from './install-skills.js';

// ── diffSkills unit tests (against the real repo skills/ as source, since it is read-only) ──

test('diffSkills reports "missing" when nothing is installed', () => {
  const [available] = listSkillDirs(srcRoot);
  assert.ok(available, 'repo must have at least one skill under skills/ for this test to mean anything');
  const [r] = diffSkills([available]);
  // destRoot is the real ~/.claude/skills at import time; this only asserts the *shape* of the
  // result (missing/same/drift), never asserts which one, so it can't assume anything about the
  // real host running the suite.
  assert.ok(['missing', 'same', 'drift'].includes(r.status));
});

test('diffSkills reports "skipped" for a name with no SKILL.md', () => {
  const [r] = diffSkills(['__no-such-skill-305__']);
  assert.equal(r.status, 'skipped');
});

// ── CLI, driven against a sandboxed HOME ──────────────────────────────────────
// Mirrors deploy-hooks.test.js: os.homedir() on win32 reads USERPROFILE and ignores HOME, so
// both must be seeded or these tests hit the developer's real ~/.claude/skills.

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'install-skills.js');
const REAL_SKILLS_DIR = join(homedir(), '.claude', 'skills');
const realSkillNames = existsSync(REAL_SKILLS_DIR) ? listSkillDirs(REAL_SKILLS_DIR) : null;
const sandboxes = [];

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'install-skills-'));
  sandboxes.push(home);
  return home;
}

function runCli(home, args = []) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: String(e.stdout ?? '') + String(e.stderr ?? '') };
  }
}

const sandboxSkills = home => join(home, '.claude', 'skills');

test('--check on a host with nothing installed says so and exits 0', () => {
  const home = sandbox();
  const r = runCli(home, ['--check']);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /no-install .*skills not found/);
  assert.doesNotMatch(r.stdout, /^in sync/m, 'an empty host must not be reported as in sync');
});

test('--require-install turns a bare host into a failure', () => {
  // The self-hosted runner is meant to have skills deployed. A bare home there is the outage,
  // one step earlier than the installed-but-drifted case, so the daily job must not read it clean.
  const r = runCli(sandbox(), ['--check', '--require-install']);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /--require-install/);
});

test('--check reports missing skills once the destination dir exists but is empty', () => {
  // The exact #199/#305 state: install-skills has run before on this host, so ~/.claude/skills
  // exists, but a CORE skill has never landed (or is stale). An empty-but-present dir must not
  // be confused with the "nothing installed" clean-skip case above.
  const home = sandbox();
  mkdirSync(sandboxSkills(home), { recursive: true });
  const r = runCli(home, ['--check']);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /^missing /m);
  assert.doesNotMatch(r.stdout, /nothing installed on this host/);
});

test('full install then --check comes back clean, and a source edit reintroduces drift', () => {
  const home = sandbox();
  const install = runCli(home, ['--all']);
  assert.equal(install.code, 0, install.stdout);

  const clean = runCli(home, ['--all', '--check']);
  assert.equal(clean.code, 0, clean.stdout);
  assert.match(clean.stdout, /in sync/);

  // Mutate one installed copy directly (simulating a host-side edit or a repo change since the
  // last install) and confirm --check catches it without writing anything back.
  const target = CORE.find(n => existsSync(join(srcRoot, n, 'SKILL.md')));
  assert.ok(target, 'need at least one CORE skill with a SKILL.md to drift');
  const installedFile = join(sandboxSkills(home), target, 'SKILL.md');
  const before = readFileSync(installedFile, 'utf8');
  writeFileSync(installedFile, before + '\nlocally edited, never synced back\n');

  const drifted = runCli(home, ['--all', '--check']);
  assert.equal(drifted.code, 1, drifted.stdout);
  assert.match(drifted.stdout, new RegExp(`^drift\\s+${target}$`, 'm'));
  // --check must never write — the installed copy is still the mutated one.
  assert.equal(readFileSync(installedFile, 'utf8'), before + '\nlocally edited, never synced back\n');
});

test('--check rejects an unknown explicit skill name the same way install does', () => {
  const home = sandbox();
  mkdirSync(sandboxSkills(home), { recursive: true }); // past the bare-host clean-skip path
  const r = runCli(home, ['--check', 'this-skill-does-not-exist']);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /Unknown skill\(s\)/);
});

test('the real ~/.claude/skills was never touched by this suite', () => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  if (!realSkillNames) return;
  assert.deepEqual(
    existsSync(REAL_SKILLS_DIR) ? listSkillDirs(REAL_SKILLS_DIR) : [],
    realSkillNames,
    'SANDBOX ESCAPE: real ~/.claude/skills directory listing changed',
  );
});
