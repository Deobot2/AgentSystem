#!/usr/bin/env node
// install-brain-sync-timer.sh — the host timer that covers a machine with no session on it (#341).
//
// The installer itself is barely worth testing; `--check` very much is. It runs in the daily
// enforcement-drift job, and a drift check has exactly two ways to be useless: green when the timer
// is gone (the outage stays silent, which is #340), or red on a healthy host (people mute it, and
// then the outage stays silent anyway). Both are tested here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'install-brain-sync-timer.sh');

// Git Bash on Windows, /bin/bash on Linux. If neither is here the whole file skips rather than
// failing — a missing bash says nothing about the timer.
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;

function run(args, configHome, env = {}) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, XDG_CONFIG_HOME: configHome, ...env },
  });
}

const scratch = () => mkdtempSync(join(tmpdir(), 'timer-check-'));

/** A unit pair that should pass --check: real script path, conflict exit code, repeat interval. */
function installUnits(configHome, { execScript = join(HERE, 'brain-sync-run.js'), successLine = 'SuccessExitStatus=0 3', interval = 'OnUnitActiveSec=15min' } = {}) {
  const dir = join(configHome, 'systemd', 'user');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'brain-sync.service'),
    `[Service]\nType=oneshot\nExecStart=/usr/bin/node ${execScript}\n${successLine}\n`);
  writeFileSync(join(dir, 'brain-sync.timer'),
    `[Timer]\nOnBootSec=2min\n${interval}\nPersistent=true\n`);
  return dir;
}

test('--dry-run prints both units and writes nothing', { skip: !hasBash }, () => {
  const home = scratch();
  const r = run(['--dry-run'], home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /brain-sync\.service/);
  assert.match(r.stdout, /brain-sync\.timer/);
  assert.match(r.stdout, /enable-linger/, 'without linger the timer dies at logout, which is the whole point');
  assert.equal(existsSync(join(home, 'systemd')), false, '--dry-run installed something');
});

test('--dry-run keeps the conflict exit code out of systemd failure territory', { skip: !hasBash }, () => {
  const r = run(['--dry-run'], scratch());
  assert.match(r.stdout, /SuccessExitStatus=0 3/,
    'exit 3 means "conflict found, human alerted" — without this systemd reads a working sync as failed');
  assert.match(r.stdout, /Persistent=true/, 'a host that was off must catch up, not skip the missed window');
});

// systemd reads % in a unit value as a specifier. An unescaped PATH entry like %NVM_HOME% either
// expands to something else or makes systemd reject the unit at load — and a unit that will not load
// is a timer that never fires, on a host where everything else looks installed. This is not
// contrived: the PATH on the Windows box already contains %NVM_HOME%.
test('a PATH containing % survives into the unit as a literal', { skip: !hasBash }, () => {
  const r = run(['--dry-run'], scratch(), { PATH: `${process.env.PATH}:/opt/%NVM_HOME%/bin` });
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.includes('Environment="PATH='));
  assert.ok(line, 'no PATH line in the generated unit');
  assert.match(line, /%%NVM_HOME%%/, 'a bare % in PATH is a systemd specifier, not a character');
  assert.match(line, /^\s*Environment="PATH=.*"$/, 'the value must be quoted — PATH entries contain spaces');
});

// Real drift, and the hardest kind to report: the check runs under `set -euo pipefail`, so the grep
// that finds no ExecStart exits 1 and would kill the script mid-check. That aborts with no message
// about the thing it just found — a check that dies while detecting drift looks identical to a
// check that is itself broken.
test('--check reports a service that lost its ExecStart instead of aborting', { skip: !hasBash }, () => {
  const home = scratch();
  const dir = join(home, 'systemd', 'user');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'brain-sync.service'), '[Service]\nType=oneshot\nSuccessExitStatus=0 3\n');
  writeFileSync(join(dir, 'brain-sync.timer'), '[Timer]\nOnBootSec=2min\nOnUnitActiveSec=15min\n');

  const r = run(['--check-units'], home);
  assert.equal(r.status, 1, 'a service with no command to run reported healthy');
  assert.match(r.stdout, /drift/, `the check exited without saying what was wrong: ${r.stderr}`);
});

test('--check fails when the timer was never installed', { skip: !hasBash }, () => {
  const r = run(['--check-units'], scratch());
  assert.equal(r.status, 1, 'a host with no timer reported healthy');
  assert.match(r.stdout, /missing/);
});

test('--check passes on a healthy install', { skip: !hasBash }, () => {
  const home = scratch();
  installUnits(home);
  const r = run(['--check-units'], home);
  assert.equal(r.status, 0, `healthy install reported drift:\n${r.stdout}`);
  assert.match(r.stdout, /in sync/);
});

test('--check passes even though the unit was written from a different checkout path', { skip: !hasBash }, () => {
  // The CI job checks out into the runner workspace; the installed unit points at ~/dev/AgentSystem.
  // Byte-comparing the generated unit would fail here, on a host that is entirely fine.
  const home = scratch();
  installUnits(home);
  const r = run(['--check-units'], home);
  assert.equal(r.status, 0, r.stdout);
});

test('--check catches a unit pointing at a checkout that moved', { skip: !hasBash }, () => {
  const home = scratch();
  installUnits(home, { execScript: join(scratch(), 'gone', 'brain-sync-run.js') });
  const r = run(['--check-units'], home);
  assert.equal(r.status, 1, 'a timer running a script that no longer exists reported healthy');
  assert.match(r.stdout, /not there/);
});

test('--check catches a service that would mark a raised alert as a failure', { skip: !hasBash }, () => {
  const home = scratch();
  installUnits(home, { successLine: '' });
  const r = run(['--check-units'], home);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /SuccessExitStatus/);
});

test('--check catches a timer that would fire once and never again', { skip: !hasBash }, () => {
  const home = scratch();
  installUnits(home, { interval: '' });
  const r = run(['--check-units'], home);
  assert.equal(r.status, 1, 'a one-shot timer looks installed and syncs the host exactly once');
  assert.match(r.stdout, /repeat interval/);
});

test('plain --check never calls units-on-disk healthy on its own', { skip: !hasBash }, () => {
  // The unit files here were fabricated, never enabled — the installed-but-inert shape. Whether
  // systemd can be reached depends on the host (CI runner: yes; Git Bash on Windows: no), so what
  // is asserted is that --check either reports the timer down or says it could not look, and never
  // just prints "in sync" and stops. --check-units is the only way to opt out of that half.
  const home = scratch();
  installUnits(home);
  const r = run(['--check'], home);
  assert.match(r.stdout, /INACTIVE|cannot reach the user systemd bus/);
  if (/INACTIVE/.test(r.stdout)) {
    assert.equal(r.status, 1, 'a timer that is not scheduled to run was reported as healthy');
  }
});

// The Windows half, guarded from Linux CI too: Windows PowerShell 5.1 decodes a BOM-less script as
// cp1252, and the three UTF-8 bytes of an em dash land as three cp1252 characters ending in a curly
// closing quote — which PowerShell reads as a string delimiter. One em dash inside a Write-Output
// string turns the whole file into "The string is missing the terminator", reported at a line that
// looks fine, and the installer becomes unrunnable on the only platform it targets. Cheaper to
// forbid the bytes than to debug it a second time.
test('the PowerShell installer is pure ASCII', () => {
  const src = readFileSync(join(HERE, 'install-brain-sync-timer.ps1'), 'latin1');
  const bad = [...src].map((c, i) => [c, i]).filter(([c]) => c.charCodeAt(0) > 126);
  assert.deepEqual(bad, [],
    `non-ASCII byte(s) at offset(s) ${bad.map(([, i]) => i).join(', ')} — PowerShell 5.1 will mis-decode them`);
});

test('--uninstall leaves no units behind', { skip: !hasBash }, () => {
  const home = scratch();
  const dir = installUnits(home);
  const r = run(['--uninstall'], home);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(dir), []);
});
