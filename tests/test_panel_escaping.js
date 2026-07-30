#!/usr/bin/env node
/**
 * Panel HTML/JS escaping.
 *
 * Session and agent names come from `claude agents --json`, not from panel.html, and
 * they were interpolated straight into onclick="fn('${name}')". escapeHtml did not even
 * escape `'`, so a quote in one of those values ended the JS string literal and whatever
 * followed ran as code. These tests pin both halves of the fix: the escaper covers `'`,
 * and no onclick in the file goes back to the raw single-quoted form.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PANEL = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'mission-control', 'panel.html');
const src = readFileSync(PANEL, 'utf8');

// Lift the helpers out of the page rather than duplicating them here — a copy would keep
// passing after someone weakened the real ones. Both go into one scope because jsArg calls
// escapeHtml.
function source(name) {
  const m = src.match(new RegExp(`function ${name}\\(s\\) \\{[\\s\\S]*?\\n    \\}`));
  assert.ok(m, `${name}() not found in panel.html`);
  return m[0];
}
const { escapeHtml, jsArg } = new Function(
  `${source('escapeHtml')}\n${source('jsArg')}\nreturn { escapeHtml, jsArg };`)();

test('escapeHtml escapes the single quote that closes an attribute JS string', () => {
  assert.equal(escapeHtml("'"), '&#39;');
  assert.equal(escapeHtml(`<&">'`), '&lt;&amp;&quot;&gt;&#39;');
});

test('jsArg neutralizes a breakout payload', () => {
  const out = jsArg("x'); alert(1); //");
  assert.ok(!out.includes("'"), `raw quote survived: ${out}`);
  // The value stays inside one JS string literal: quotes become entities, not delimiters.
  assert.ok(out.startsWith('&quot;') && out.endsWith('&quot;'), out);
});

test('jsArg escapes newlines that would otherwise terminate the literal', () => {
  assert.equal(jsArg('a\nb'), '&quot;a\\nb&quot;');
});

test('jsArg renders null/undefined as an empty string, not "null"', () => {
  assert.equal(jsArg(null), '&quot;&quot;');
  assert.equal(jsArg(undefined), '&quot;&quot;');
});

// The actual regression: `onclick="fn('${value}')"`. jsArg supplies its own quoting, so a
// hand-written `'` around an interpolation means someone reintroduced the old form.
test('no onclick passes a raw single-quoted interpolation', () => {
  const offenders = src.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /onclick="[A-Za-z_$][\w$]*\(\s*'\$\{/.test(line));
  assert.deepEqual(offenders, [], `use jsArg() instead:\n${offenders.map(([n, l]) => `  ${n}: ${l.trim()}`).join('\n')}`);
});
