// tests/deploy-private-skills.test.js
//
// The Life OS skills are gitignored (#187), so they exist only as per-host files with no shared
// source of truth and no merge base. They forked: the runner got the #257 fix on 2026-08-08, the
// laptop stayed on 2026-08-03 text, and a routine `--host` deploy would have overwritten the fix
// while printing nothing but its usual success message (#298).
//
// These tests pin the guard that stops that. Everything runs against temp dirs and a fake ssh —
// no real skills, no real host. The fake ssh is wired in with SKILL_DEPLOY_SSH, the same escape
// hatch the script documents (cf. GIT_SSH_COMMAND).

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'tools', 'deploy-private-skills.sh');

// Git Bash accepts C:/... but treats backslashes as escapes, so every path handed to the shell
// must be forward-slashed.
const sh = (p) => p.replace(/\\/g, '/');

const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;

const SHIPPED = [
  'skills/daily-briefing/SKILL.md',
  'skills/daily-briefing/portable-prompt.md',
  'skills/daily-briefing/handoff-schema.md',
  'skills/daily-triage/SKILL.md',
];

// A stand-in for tools/install-skills.js: the installer step is not under test here, but the
// deploy path calls it, and it must not touch the real ~/.claude.
const INSTALL_STUB = `
import fs from 'node:fs';
import path from 'node:path';
for (const s of ['daily-briefing', 'daily-triage']) {
  const dest = path.join(process.env.HOME, '.claude', 'skills', s);
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join('skills', s, 'SKILL.md'), path.join(dest, 'SKILL.md'));
}
`;

let tmpRoot;
before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-skills-'));
});
after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

let caseId = 0;

/**
 * Build an isolated world: a "local" checkout, a "remote" checkout, a fake HOME, and a fake ssh
 * that executes its command locally instead of dialling out.
 *
 * @param {object} opts
 * @param {string} opts.localText     content of the local daily-triage SKILL.md
 * @param {string|null} opts.remoteText content on the "remote"; null = remote has no skills at all
 * @param {number} opts.localMtime    epoch seconds
 * @param {number} opts.remoteMtime   epoch seconds
 */
function makeWorld({ localText, remoteText, localMtime, remoteMtime, driftFile = 'skills/daily-triage/SKILL.md' }) {
  const dir = path.join(tmpRoot, `case-${++caseId}`);
  const local = path.join(dir, 'local');
  const remote = path.join(dir, 'remote');
  const home = path.join(dir, 'home');
  const life = path.join(dir, 'life');
  fs.mkdirSync(home, { recursive: true });

  for (const root of [local, remote]) {
    fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(root, 'tools', 'deploy-private-skills.sh'));
    fs.writeFileSync(path.join(root, 'tools', 'install-skills.js'), INSTALL_STUB);
  }

  // Baseline: every shipped file identical on both sides, so only the file under test differs.
  const write = (root, rel, text, mtime) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    if (mtime) fs.utimesSync(p, mtime, mtime);
  };
  for (const rel of SHIPPED) {
    write(local, rel, `baseline ${rel}\n`, 1_700_000_000);
    if (remoteText !== null) write(remote, rel, `baseline ${rel}\n`, 1_700_000_000);
  }
  write(local, driftFile, localText, localMtime);
  if (remoteText !== null) write(remote, driftFile, remoteText, remoteMtime);

  // `ssh <host> <cmd>`: drop the host, run the command, let stdin through. That exercises the
  // real remote-probe script, the real tar pipeline, and the real installer invocation.
  const fakeSsh = path.join(dir, 'fake-ssh.sh');
  fs.writeFileSync(fakeSsh, '#!/bin/bash\nshift\nexec bash -c "$*"\n');
  fs.chmodSync(fakeSsh, 0o755);

  return { dir, local, remote, home, life, fakeSsh, driftFile };
}

function run(world, args) {
  const r = spawnSync(
    'bash',
    [sh(path.join(world.local, 'tools', 'deploy-private-skills.sh')),
      '--host', 'fake@host',
      '--path', sh(world.remote),
      '--life', sh(world.life),
      ...args],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: sh(world.home),
        SKILL_DEPLOY_SSH: `bash ${sh(world.fakeSsh)}`,
      },
    },
  );
  return { status: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout, stderr: r.stderr };
}

const remoteContent = (world, rel = world.driftFile) =>
  fs.readFileSync(path.join(world.remote, rel), 'utf8');

const NEWER = { localMtime: 1_754_000_000, remoteMtime: 1_754_400_000 };  // remote 4.6 days ahead
const OLDER = { localMtime: 1_754_400_000, remoteMtime: 1_754_000_000 };

// The script prints UTC `YYYY-MM-DD HH:MM:SSZ`. Derive the expected text from the same epochs
// rather than hardcoding dates, so the assertion cannot drift from the fixture.
const utcDay = (epoch) => new Date(epoch * 1000).toISOString().slice(0, 10);

describe('deploy-private-skills.sh cross-host clobber guard', { skip: !hasBash && 'bash unavailable' }, () => {
  test('aborts rather than overwrite a remote copy that is different AND newer', () => {
    const w = makeWorld({ localText: 'stale aug 3 text\n', remoteText: 'fixed aug 8 text\n', ...NEWER });
    const r = run(w, []);

    assert.equal(r.status, 1, 'must exit non-zero');
    assert.match(r.out, /Refusing to deploy/);
    // The message has to be actionable on its own: which file, and both timestamps.
    assert.match(r.out, /skills\/daily-triage\/SKILL\.md/);
    assert.match(r.out, new RegExp(`local\\s+${utcDay(NEWER.localMtime)} `), 'local mtime shown');
    assert.match(r.out, new RegExp(`fake@host\\s+${utcDay(NEWER.remoteMtime)} `), 'remote mtime shown');
    assert.match(r.out, /--force/, 'names the override');
    // The whole point: the fix on the target survives.
    assert.equal(remoteContent(w), 'fixed aug 8 text\n', 'remote must be untouched');
  });

  test('the abort is silent-proof — it names the drift on stderr, not just a bare exit code', () => {
    const w = makeWorld({ localText: 'stale\n', remoteText: 'fixed\n', ...NEWER });
    const r = run(w, []);
    assert.match(r.stderr, /NEWER/);
    assert.notEqual(r.stderr.trim(), '', 'a silent refusal would repeat the original defect');
  });

  test('--force overwrites the newer remote copy on purpose', () => {
    const w = makeWorld({ localText: 'laptop is authoritative\n', remoteText: 'fixed aug 8 text\n', ...NEWER });
    const r = run(w, ['--force']);

    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /--force given/);
    assert.equal(remoteContent(w), 'laptop is authoritative\n', 'force must actually deploy');
  });

  test('deploys without --force when the remote differs but is OLDER (the normal direction)', () => {
    const w = makeWorld({ localText: 'new local text\n', remoteText: 'old remote text\n', ...OLDER });
    const r = run(w, []);

    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /drift {2}older/);
    assert.doesNotMatch(r.out, /Refusing to deploy/);
    assert.equal(remoteContent(w), 'new local text\n');
  });

  test('deploys when both sides are identical', () => {
    const w = makeWorld({ localText: 'same\n', remoteText: 'same\n', ...NEWER });
    const r = run(w, []);

    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /Refusing to deploy/);
    // Equal content is not drift even when the remote mtime is newer — hash decides, not mtime.
    assert.match(r.out, /drift {2}same {4}skills\/daily-triage\/SKILL\.md/);
  });

  test('deploys to a target that has no skills yet (first-ever deploy)', () => {
    const w = makeWorld({ localText: 'first\n', remoteText: null, ...NEWER });
    const r = run(w, []);

    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /drift {2}new/);
    assert.equal(remoteContent(w), 'first\n');
  });

  test('guards every shipped file, not just SKILL.md', () => {
    const w = makeWorld({
      driftFile: 'skills/daily-briefing/handoff-schema.md',
      localText: 'stale schema\n',
      remoteText: 'fixed schema\n',
      ...NEWER,
    });
    const r = run(w, []);

    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /handoff-schema\.md/);
    assert.equal(remoteContent(w), 'fixed schema\n');
  });
});

describe('deploy-private-skills.sh --check --host sees cross-host drift', { skip: !hasBash && 'bash unavailable' }, () => {
  // The old --check compared source-vs-installed within one host, so it passed while the two
  // hosts held different text. That blind spot is what let the fork sit unnoticed.
  test('reports drift and exits 1 when the remote is newer', () => {
    const w = makeWorld({ localText: 'stale\n', remoteText: 'fixed\n', ...NEWER });
    // Make the presence half pass so the exit code can only come from the drift half.
    fs.mkdirSync(path.join(w.home, '.claude', 'skills', 'daily-briefing'), { recursive: true });
    fs.mkdirSync(path.join(w.home, '.claude', 'skills', 'daily-triage'), { recursive: true });
    fs.writeFileSync(path.join(w.home, '.claude', 'skills', 'daily-briefing', 'SKILL.md'), 'x');
    fs.writeFileSync(path.join(w.home, '.claude', 'skills', 'daily-triage', 'SKILL.md'), 'x');
    fs.mkdirSync(path.join(w.life, 'briefings'), { recursive: true });
    fs.mkdirSync(path.join(w.life, 'closeouts'), { recursive: true });

    const r = run(w, ['--check']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /Content drift/);
    assert.match(r.out, /skills\/daily-triage\/SKILL\.md/);
    // --check must never write.
    assert.equal(remoteContent(w), 'fixed\n');
  });

  test('exits 0 when content agrees and everything is installed', () => {
    const w = makeWorld({ localText: 'same\n', remoteText: 'same\n', ...NEWER });
    for (const s of ['daily-briefing', 'daily-triage']) {
      fs.mkdirSync(path.join(w.home, '.claude', 'skills', s), { recursive: true });
      fs.writeFileSync(path.join(w.home, '.claude', 'skills', s, 'SKILL.md'), 'x');
    }
    fs.mkdirSync(path.join(w.life, 'briefings'), { recursive: true });
    fs.mkdirSync(path.join(w.life, 'closeouts'), { recursive: true });

    const r = run(w, ['--check']);
    assert.equal(r.status, 0, r.out);
  });
});
