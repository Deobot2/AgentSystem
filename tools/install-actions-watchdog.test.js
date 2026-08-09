#!/usr/bin/env node
// install-actions-watchdog.sh — the off-Actions watchdog timer (#197), and its --check (#361).
//
// The installer is barely worth testing; `--check` very much is. runner-maintenance.yml's
// repair-install now installs this timer and then verifies it with --check, and a verification step
// has exactly two ways to be useless: green when the timer is gone (the outage stays silent — that
// is #361, where the only signal was a missing heartbeat with no cause attached), or red on a
// healthy host (people mute it, and the outage stays silent anyway). Both are tested here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'install-actions-watchdog.sh');

// Git Bash on Windows, /bin/bash on Linux. If neither is here the whole file skips rather than
// failing — a missing bash says nothing about the watchdog.
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;

function run(args, configHome, env = {}) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, XDG_CONFIG_HOME: configHome, ...env },
  });
}

const scratch = () => mkdtempSync(join(tmpdir(), 'watchdog-check-'));

// Fake `systemctl`/`loginctl`/`gh` on PATH so both branches (bus up, bus down; gh authed, gh not)
// can be driven without real systemd or a real GitHub token anywhere — including on Windows Git
// Bash, where none of those binaries exist. `exitCode` is what every invocation of that fake
// returns. stderr is emitted so a test can assert the installer SURFACES systemd's own words
// instead of swallowing them: the target host refuses ssh, so that text is the only diagnostic
// that will ever exist, and an opaque exit 4 cannot be told apart from a masked unit.
function fakeBin({ systemctl, loginctl, gh } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-fakebin-'));
  const write = (name, exitCode) => {
    const p = join(dir, name);
    writeFileSync(p, `#!/usr/bin/env bash\necho "FAKE-SYSTEMD-BUS-ERROR: ${name} $*" >&2\nexit ${exitCode}\n`);
    chmodSync(p, 0o755);
  };
  if (systemctl !== undefined) write('systemctl', systemctl);
  if (loginctl !== undefined) write('loginctl', loginctl);
  if (gh !== undefined) write('gh', gh);
  return dir;
}

const REAL_SCRIPTS = [join(HERE, 'actions-watchdog.js'), join(HERE, 'pr-checks-watchdog.js')];

/** A unit pair that should pass --check: both real script paths, alert exit code, repeat interval. */
function installUnits(configHome, {
  execScripts = REAL_SCRIPTS,
  successLine = 'SuccessExitStatus=0 3',
  interval = 'OnUnitActiveSec=1h',
} = {}) {
  const dir = join(configHome, 'systemd', 'user');
  mkdirSync(dir, { recursive: true });
  const execLines = execScripts.map((s) => `ExecStart=/usr/bin/node ${s}`).join('\n');
  writeFileSync(join(dir, 'actions-watchdog.service'),
    `[Service]\nType=oneshot\n${execLines}\n${successLine}\n`);
  writeFileSync(join(dir, 'actions-watchdog.timer'),
    `[Timer]\nOnBootSec=5min\n${interval}\nPersistent=true\n`);
  return dir;
}

test('--dry-run prints both units and writes nothing', { skip: !hasBash }, () => {
  const home = scratch();
  const r = run(['--dry-run'], home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /actions-watchdog\.service/);
  assert.match(r.stdout, /actions-watchdog\.timer/);
  assert.match(r.stdout, /enable-linger/, 'without linger the timer dies at logout, which is the whole point');
  assert.equal(existsSync(join(home, 'systemd')), false, '--dry-run installed something');
});

test('--dry-run runs BOTH watchdogs and keeps a raised alert out of systemd failure territory', { skip: !hasBash }, () => {
  const r = run(['--dry-run'], scratch());
  assert.match(r.stdout, /ExecStart=.*actions-watchdog\.js/);
  assert.match(r.stdout, /ExecStart=.*pr-checks-watchdog\.js/,
    'the PR-checks half rides this same unit — dropping it looks like health, because the Actions half still stamps the heartbeat');
  assert.match(r.stdout, /SuccessExitStatus=0 3/,
    'exit 3 means "outage found, human alerted" — without this systemd reads a working watchdog as failed and backs the timer off');
  assert.match(r.stdout, /Persistent=true/, 'a host that was off must catch up, not skip the missed window');
});

// systemd reads % in a unit value as a specifier. An unescaped PATH entry like %NVM_HOME% either
// expands to something else or makes systemd reject the unit at load — and a unit that will not
// load is a timer that never fires on a host where everything else looks installed. Not contrived:
// the PATH on the Windows box already contains %NVM_HOME%.
test('a PATH containing % survives into the unit as a literal', { skip: !hasBash }, () => {
  const r = run(['--dry-run'], scratch(), { PATH: `${process.env.PATH}:/opt/%NVM_HOME%/bin` });
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.includes('Environment="PATH='));
  assert.ok(line, 'no PATH line in the generated unit');
  assert.match(line, /%%NVM_HOME%%/, 'a bare % in PATH is a systemd specifier, not a character');
  assert.match(line, /^\s*Environment="PATH=.*"$/, 'the value must be quoted — PATH entries contain spaces');
});

test('--check fails when the timer was never installed', { skip: !hasBash }, () => {
  const r = run(['--check-units'], scratch());
  assert.equal(r.status, 1, 'a host with no watchdog timer reported healthy — that is exactly #361 going unnoticed');
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
  // repair-install runs --check from the runner workspace while the unit points at the canonical
  // ~/dev/AgentSystem. Byte-comparing the generated unit would fail here, on a host that is fine.
  const home = scratch();
  installUnits(home);
  const r = run(['--check-units'], home);
  assert.equal(r.status, 0, r.stdout);
});

test('--check catches a unit pointing at a checkout that moved', { skip: !hasBash }, () => {
  const home = scratch();
  installUnits(home, { execScripts: [join(scratch(), 'gone', 'actions-watchdog.js'), REAL_SCRIPTS[1]] });
  const r = run(['--check-units'], home);
  assert.equal(r.status, 1, 'a timer running a script that no longer exists reported healthy');
  assert.match(r.stdout, /not there/);
});

// The half that a first-ExecStart-only check would miss entirely.
test('--check catches a unit that dropped the pr-checks watchdog', { skip: !hasBash }, () => {
  const home = scratch();
  installUnits(home, { execScripts: [REAL_SCRIPTS[0]] });
  const r = run(['--check-units'], home);
  assert.equal(r.status, 1, 'half a watchdog reported healthy — the Actions half keeps stamping the heartbeat, so nothing else would ever notice');
  assert.match(r.stdout, /expected 2/);
});

// Real drift, and the hardest kind to report: the check runs under `set -euo pipefail`, so a grep
// that finds no ExecStart exits 1 and would kill the script mid-check. That aborts with no message
// about the thing it just found — a check that dies while detecting drift looks identical to a
// check that is itself broken.
test('--check reports a service that lost its ExecStart instead of aborting', { skip: !hasBash }, () => {
  const home = scratch();
  const dir = join(home, 'systemd', 'user');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'actions-watchdog.service'), '[Service]\nType=oneshot\nSuccessExitStatus=0 3\n');
  writeFileSync(join(dir, 'actions-watchdog.timer'), '[Timer]\nOnBootSec=5min\nOnUnitActiveSec=1h\n');

  const r = run(['--check-units'], home);
  assert.equal(r.status, 1, 'a service with no command to run reported healthy');
  assert.match(r.stdout, /drift/, `the check exited without saying what was wrong: ${r.stderr}`);
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
  assert.equal(r.status, 1, 'a one-shot timer looks installed and checks Actions exactly once');
  assert.match(r.stdout, /repeat interval/);
});

// The failure mode #361 could not distinguish from a dead timer: units fine, timer running, `gh`
// unable to answer — so every hourly run dies before writing a heartbeat, and the only symptom is
// the same "heartbeat missing or stale" line.
test('--check counts an unauthenticated gh as drift', { skip: !hasBash }, () => {
  const home = scratch();
  installUnits(home);
  const bin = fakeBin({ systemctl: 0, loginctl: 0, gh: 1 });
  const r = run(['--check'], home, { PATH: `${bin}${delimiter}${process.env.PATH}` });
  assert.equal(r.status, 1, 'a watchdog that cannot call the API was reported as healthy');
  assert.match(r.stdout, /not authenticated/);
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
});

test('--check-units skips the halves that need a real host', { skip: !hasBash }, () => {
  const home = scratch();
  installUnits(home);
  const r = run(['--check-units'], home);
  assert.match(r.stdout, /skipped/);
  assert.doesNotMatch(r.stdout, /INACTIVE/, '--check-units must not evaluate liveness — the tests have no systemd behind them');
});

test('--uninstall leaves no units behind', { skip: !hasBash }, () => {
  const home = scratch();
  const dir = installUnits(home);
  const bin = fakeBin({ systemctl: 0, loginctl: 0 });
  const r = run(['--uninstall'], home, { PATH: `${bin}${delimiter}${process.env.PATH}` });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(dir), []);
});

// install degrading honestly when the systemd --user bus is unreachable. This is the exact state
// runner-maintenance.yml's repair-install codes against (exit 4), and the state the Mission Control
// runner is in: `systemctl --user` errors out in a service-account session with no D-Bus.
test('install writes units but exits 4 when the systemd bus is unreachable', { skip: !hasBash }, () => {
  const home = scratch();
  const bin = fakeBin({ systemctl: 1, loginctl: 1, gh: 0 });
  const r = run(['install'], home, { PATH: `${bin}${delimiter}${process.env.PATH}` });

  assert.equal(r.status, 4, `expected exit 4 (bus unreachable), got ${r.status}\nstdout:${r.stdout}\nstderr:${r.stderr}`);

  const dir = join(home, 'systemd', 'user');
  assert.ok(existsSync(join(dir, 'actions-watchdog.service')), 'service unit was not written to disk');
  assert.ok(existsSync(join(dir, 'actions-watchdog.timer')), 'timer unit was not written to disk');

  const out = r.stdout + r.stderr;
  assert.match(out, /systemctl --user enable --now actions-watchdog\.timer/,
    'must name the exact command a human needs to run at a console');
  assert.doesNotMatch(out, /^installed:/m,
    'a bare "installed:" success line on a bus-down install is the false-green this exists to prevent');
  assert.match(out, /FAKE-SYSTEMD-BUS-ERROR/,
    "systemd's own error text must reach the log — ssh to this host is refused, so an opaque exit 4 "
    + 'cannot be told apart from a masked unit or a unit systemd rejected at load');
});

// Installing against an unauthenticated gh would produce a timer that fires hourly, fails hourly,
// and stamps no heartbeat — i.e. it would look exactly like #361 while `systemctl status` stayed
// green. Refusing before writing anything is the only outcome that stays honest.
test('install refuses with exit 5 and writes nothing when gh is unauthenticated', { skip: !hasBash }, () => {
  const home = scratch();
  const bin = fakeBin({ systemctl: 0, loginctl: 0, gh: 1 });
  const r = run(['install'], home, { PATH: `${bin}${delimiter}${process.env.PATH}` });

  assert.equal(r.status, 5, `expected exit 5 (gh unusable), got ${r.status}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
  assert.equal(existsSync(join(home, 'systemd')), false, 'units were written against a gh that cannot answer');
  assert.match(r.stdout + r.stderr, /gh auth login/, 'must name the exact command a human needs to run');
});

test('install succeeds and reports enabled when the systemd bus is reachable', { skip: !hasBash }, () => {
  const home = scratch();
  const bin = fakeBin({ systemctl: 0, loginctl: 0, gh: 0 });
  const env = { PATH: `${bin}${delimiter}${process.env.PATH}` };
  const r = run(['install'], home, env);

  assert.equal(r.status, 0, `expected exit 0 (bus reachable), got ${r.status}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
  assert.match(r.stdout, /installed:/, 'a healthy install should say so');

  const check = run(['--check-units'], home, env);
  assert.equal(check.status, 0, `--check-units disagreed with a fresh install:\n${check.stdout}`);
});

test('install is idempotent when the systemd bus is reachable', { skip: !hasBash }, () => {
  const home = scratch();
  const bin = fakeBin({ systemctl: 0, loginctl: 0, gh: 0 });
  const env = { PATH: `${bin}${delimiter}${process.env.PATH}` };

  const first = run(['install'], home, env);
  assert.equal(first.status, 0, first.stderr);
  const dir = join(home, 'systemd', 'user');
  const svc1 = readFileSync(join(dir, 'actions-watchdog.service'), 'utf8');
  const tmr1 = readFileSync(join(dir, 'actions-watchdog.timer'), 'utf8');

  const second = run(['install'], home, env);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(svc1, readFileSync(join(dir, 'actions-watchdog.service'), 'utf8'),
    'service unit content changed across a re-install with nothing else different');
  assert.equal(tmr1, readFileSync(join(dir, 'actions-watchdog.timer'), 'utf8'),
    'timer unit content changed across a re-install with nothing else different');
});
