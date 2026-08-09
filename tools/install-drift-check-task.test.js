#!/usr/bin/env node
// install-drift-check-task.test.js -- covers the Windows drift-check task installer (#322).
//
// The installer itself is Windows-Scheduled-Task-only and cannot be exercised on the Linux CI
// runner, so what is tested here is what a Linux runner CAN prove: the file stays parseable by
// PowerShell 5.1 (ASCII only -- see install-brain-sync-timer.test.js for why that specific
// property broke the sibling installer once), and the pure logic in drift-check-run.js that the
// task actually invokes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alertKey, raiseArgs } from './drift-check-run.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// Windows PowerShell 5.1 decodes a BOM-less script as cp1252, and the three UTF-8 bytes of an em
// dash land as three cp1252 characters ending in a curly closing quote -- which PowerShell reads
// as a string delimiter. One em dash inside a Write-Output string turns the whole file into "The
// string is missing the terminator", reported at a line that looks fine, and the installer becomes
// unrunnable on the only platform it targets. Cheaper to forbid the bytes than to debug it twice.
test('the PowerShell installer is pure ASCII', () => {
  const src = readFileSync(join(HERE, 'install-drift-check-task.ps1'), 'latin1');
  const bad = [...src].map((c, i) => [c, i]).filter(([c]) => c.charCodeAt(0) > 126);
  assert.deepEqual(bad, [],
    `non-ASCII byte(s) at offset(s) ${bad.map(([, i]) => i).join(', ')} -- PowerShell 5.1 will mis-decode them`);
});

test('alertKey is per-host, lowercased, and safe for a GitHub issue marker', () => {
  assert.equal(alertKey('DESKTOP-ABC123'), 'enforcement-drift-desktop-abc123');
  assert.equal(alertKey('my host!!'), 'enforcement-drift-my-host');
});

test('raiseArgs lists only the checks that actually failed', () => {
  const results = [
    { label: 'Hook deploy + registration drift', bullet: 'Hook deploy/registration drift detected', ok: false },
    { label: 'Installed agent definition drift', bullet: 'Agent definition drift detected', ok: true },
    { label: 'Orphan hard cron routines', bullet: 'Cron routine verification failed', ok: false },
  ];
  const args = raiseArgs(results, 'my-laptop');
  assert.equal(args[0], 'raise');
  assert.equal(args[1], 'enforcement-drift-my-laptop');
  const why = args[args.indexOf('--why') + 1];
  assert.match(why, /Hook deploy\/registration drift detected/);
  assert.match(why, /Cron routine verification failed/);
  assert.doesNotMatch(why, /Agent definition drift detected/);
});
