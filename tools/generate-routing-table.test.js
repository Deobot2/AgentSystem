import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRow, renderTable, spliceTable, generate, START_MARKER, END_MARKER } from './generate-routing-table.js';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('renderRow: formats a routing rule as a markdown table row', () => {
  const row = renderRow({ keywordsDisplay: 'deploy, CI', agentShort: 'Friday', command: 'claude @friday' });
  assert.equal(row, '  | deploy, CI | **Friday** | `claude @friday` |');
});

test('renderTable: joins multiple rows with newlines, in input order', () => {
  const table = renderTable([
    { keywordsDisplay: 'a', agentShort: 'Friday', command: 'claude @friday' },
    { keywordsDisplay: 'b', agentShort: 'Sam', command: 'claude @sam' },
  ]);
  assert.equal(table.split('\n').length, 2);
  assert.ok(table.includes('**Friday**'));
  assert.ok(table.includes('**Sam**'));
});

test('spliceTable: replaces content between existing markers', () => {
  const content = `before\n${START_MARKER}\nold row\n${END_MARKER}\nafter`;
  const updated = spliceTable(content, 'new row');
  assert.ok(updated.includes('new row'));
  assert.ok(!updated.includes('old row'));
  assert.ok(updated.startsWith('before'));
  assert.ok(updated.endsWith('after'));
});

test('spliceTable: inserts markers after header separator when absent (self-healing)', () => {
  const content = '  | Task signal | Route to | Command |\n  |---|---|---|\n  | old hardcoded row | **X** | `y` |\n\nNote: ...';
  const updated = spliceTable(content, 'new row');
  assert.ok(updated.includes(START_MARKER));
  assert.ok(updated.includes(END_MARKER));
  assert.ok(updated.includes('new row'));
});

test('spliceTable: throws when no "Task signal" header found and no markers', () => {
  assert.throws(() => spliceTable('nothing relevant here', 'row'));
});

test('spliceTable: running twice is idempotent', () => {
  const content = `  | Task signal | Route to | Command |\n  |---|---|---|\n\nNote`;
  const once = spliceTable(content, 'row-a');
  const twice = spliceTable(once, 'row-a');
  assert.equal(once, twice);
});

test('generate: reads real config/routing.yml and writes rows into a jarvis.md fixture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'routing-table-test-'));
  const jarvisPath = join(dir, 'jarvis.md');
  writeFileSync(jarvisPath, '  | Task signal | Route to | Command |\n  |---|---|---|\n\nNote: end', 'utf8');
  try {
    const result = generate(undefined, jarvisPath);
    assert.ok(result.rulesCount >= 7);
    const written = readFileSync(jarvisPath, 'utf8');
    assert.ok(written.includes(START_MARKER));
    assert.ok(written.includes('**Friday**'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- CRLF regression: jarvis.md lives under .agents/**, which .gitattributes does NOT pin to
// eol=lf, so on Windows (core.autocrlf=true) it is checked out CRLF. spliceTable used to emit LF
// unconditionally, making `changed` true on every run: `--check` said "OUT OF DATE" forever and a
// write produced a mixed-ending file. These fail against the pre-fix code.

test('spliceTable: preserves CRLF endings in a CRLF file', () => {
  const content = `  | Task signal | Route to | Command |\r\n  |---|---|---|\r\n\r\nNote: end`;
  const updated = spliceTable(content, 'row-a\nrow-b');
  assert.ok(!/(?<!\r)\n/.test(updated), 'no bare LF may survive in a CRLF file');
  assert.ok(updated.includes('row-a\r\nrow-b'));
});

test('spliceTable: preserves LF endings in an LF file', () => {
  const content = `  | Task signal | Route to | Command |\n  |---|---|---|\n\nNote: end`;
  const updated = spliceTable(content, 'row-a\nrow-b');
  assert.ok(!updated.includes('\r'), 'no CR may be introduced into an LF file');
});

test('generate: --check reports no change for an already-current CRLF jarvis.md', () => {
  const dir = mkdtempSync(join(tmpdir(), 'routing-table-crlf-'));
  const jarvisPath = join(dir, 'jarvis.md');
  writeFileSync(jarvisPath, '  | Task signal | Route to | Command |\r\n  |---|---|---|\r\n\r\nNote: end', 'utf8');
  try {
    generate(undefined, jarvisPath);                                  // first run writes CRLF rows
    const second = generate(undefined, jarvisPath, { dryRun: true }); // second must be a no-op
    assert.equal(second.changed, false, '--check must not report drift on an up-to-date CRLF file');
    assert.ok(!/(?<!\r)\n/.test(readFileSync(jarvisPath, 'utf8')), 'written file must stay pure CRLF');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
