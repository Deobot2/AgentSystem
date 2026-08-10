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
import { join, dirname, sep } from 'node:path';
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

// Recursive — the original non-recursive readdirSync missed everything under tools/graph/ and
// tools/integrations/ (e.g. tools/integrations/sentry-bridge.js, one of the #374 offenders),
// which is exactly the kind of scan gap that let 15 unguarded files sail through.
function sourceFiles() {
  const out = [];
  for (const dir of ['tools', 'hooks']) {
    const base = join(REPO_ROOT, dir);
    let names;
    try { names = readdirSync(base, { withFileTypes: true, recursive: true }); } catch { continue; }
    for (const entry of names) {
      if (entry.isDirectory()) continue;
      if (!entry.name.endsWith('.js') && !entry.name.endsWith('.mjs')) continue;
      // node's recursive readdirSync gives entry.path/parentPath as an absolute (or base-relative
      // on older Node) directory; normalize to a REPO_ROOT-relative, forward-slash path.
      const parentDir = entry.parentPath || entry.path || base;
      const abs = join(parentDir, entry.name);
      const rel = abs.slice(REPO_ROOT.length + 1).split(sep).join('/');
      if (ALLOWED.has(rel)) continue;
      out.push(rel);
    }
  }
  return out;
}

// ── Shared source-scanning helpers for the entry-point-guard checks below ──────────
//
// Blank out comments, string, and template literal *contents* (keep delimiters and length
// roughly intact) so brace-counting and regexes below don't get confused by braces/semicolons
// that appear inside strings or comments. Never done well by a single regex pass because
// template literals can contain `${ ... }` with nested braces, so this walks char-by-char.
function blankNonCode(rawSrc) {
  // A `#!/usr/bin/env node` shebang is neither a `//` nor a `/*` comment, so without this it
  // merges into whatever the first real statement is and makes that statement's text start with
  // `#!...` — which matches no declaration pattern and false-flags nearly every CLI script here.
  const src = rawSrc.startsWith('#!') ? rawSrc.slice(rawSrc.indexOf('\n') + 1) : rawSrc;
  let out = '';
  let i = 0;
  const n = src.length;
  // Tracks whether the previous significant token was a value (identifier, number, string,
  // `)`/`]`) or an operator/punctuation/keyword-or-start-of-file — the standard heuristic for
  // telling a regex literal's leading `/` apart from division, since without it a regex
  // containing `{`/`}`/`;` (e.g. `/[^a-z0-9\s]/`, common in tokenizers) corrupts brace-depth
  // tracking and silently misaligns every statement split after it.
  let lastSig = '';
  const VALUE_END = /[\w$)\]]$/;
  while (i < n) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (two === '//') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      out += ' '.repeat(j - i);
      i = j;
      continue;
    }
    if (two === '/*') {
      let j = src.indexOf('*/', i + 2);
      if (j === -1) j = n; else j += 2;
      out += src.slice(i, j).replace(/[^\n]/g, ' ');
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < n && src[j] !== quote) {
        if (src[j] === '\\') j++;
        j++;
      }
      j = Math.min(j + 1, n);
      out += src.slice(i, j).replace(/[^\n]/g, ' ');
      i = j;
      lastSig = 'x';
      continue;
    }
    if (c === '/' && !VALUE_END.test(lastSig)) {
      // Candidate regex literal. Scan for its unescaped, non-charclass closing `/`, bailing (and
      // falling through to treat `/` as a plain char) if a newline is hit first.
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) { j++; closed = true; break; }
        j++;
      }
      if (closed) {
        while (j < n && /[a-z]/i.test(src[j])) j++; // flags
        out += src.slice(i, j).replace(/[^\n]/g, ' ');
        i = j;
        lastSig = 'x';
        continue;
      }
      // Not a regex (or unterminated on this line) — fall through, treat '/' as an ordinary char.
    }
    out += c;
    if (!/\s/.test(c)) lastSig = c;
    i++;
  }
  return out;
}

// Split into top-level (brace-depth 0) statements. Only `{`/`}` are tracked — good enough once
// strings/comments are blanked, since every other bracket type appears only inside an expression
// that is itself already inside some `{}` block or is irrelevant to depth.
// Statements like `function main(){...}`, `class X {...}`, `if (...) {...}` end right at their
// closing brace (no trailing `;` in JS grammar). Everything else — `import { a, b } from '...';`,
// `const x = { a: 1 };`, object/array literals — keeps accumulating past a `}` that merely closes
// a nested brace, because more of the same statement (a `from` clause, a trailing `;`) follows.
// Without this split, `import { a, b } from 'x';` was cut at the `}`, leaving an orphaned
// `from 'x';` fragment that fails DECLARATION_START and is wrongly flagged as a bare statement.
const BLOCK_STATEMENT_START = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\b|class\b|if\s*\(|if\(|for\s*\(|for\(|while\s*\(|while\(|switch\s*\(|switch\(|try\b)/;
// A `{`/`}` pair inside an *unmatched* `(...)` — a destructured parameter default, e.g.
// `function f({ usage, allowed = [] }) {` — closes before the statement is anywhere near done
// (the function body's own `{` hasn't even opened yet). Braces are only meaningful for
// depth/statement-end purposes while parenDepth is 0; while inside a paren they're just part of
// whatever expression is being passed and are appended to `cur` without touching `depth`.
function topLevelStatements(code) {
  const stmts = [];
  let depth = 0;
  let parenDepth = 0;
  let cur = '';
  for (const ch of code) {
    if (ch === '(') { parenDepth++; cur += ch; continue; }
    if (ch === ')') { parenDepth = Math.max(0, parenDepth - 1); cur += ch; continue; }
    if (ch === '{') { if (parenDepth === 0) depth++; cur += ch; continue; }
    if (ch === '}') {
      cur += ch;
      if (parenDepth === 0) {
        depth = Math.max(0, depth - 1);
        if (depth === 0 && BLOCK_STATEMENT_START.test(cur.trimStart())) { stmts.push(cur); cur = ''; }
      }
      continue;
    }
    cur += ch;
    if (depth === 0 && parenDepth === 0 && ch === ';') { stmts.push(cur); cur = ''; }
  }
  if (cur.trim()) stmts.push(cur);
  return stmts.map((s) => s.trim()).filter(Boolean);
}

const DECLARATION_START = /^(import\s|export\s|const\s|let\s|var\s|function\s|async\s+function\s|class\s|\/\/|\/\*)/;
const GUARDED_CALL = /\bisMainModule\s*\(/;
// A bare top-level call to main()/run(), with or without `await`, `void`, or a `.catch(...)`
// chain — the exact shape every #374 offender had.
const BARE_ENTRY_CALL = /^(await\s+|void\s+)?(main|run)\s*\(\s*\)\s*(\.catch\s*\([\s\S]*)?;?\s*$/;
const BARE_IIFE = /^\(\s*(async\s+)?(function\b[\s\S]*?|\([^)]*\)\s*=>[\s\S]*?)\)\s*\(\s*\)\s*;?\s*$/;

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
    if (!/from '(?:\.\.?\/)+is-main\.js'/.test(src)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], 'isMainModule() used without importing tools/is-main.js');
});

// ── #374 ─────────────────────────────────────────────────────────────────────────
//
// A tool merely being `import`-ed (e.g. by an audit, a test, or another tool re-using one of
// its exports) must never run its CLI body. 15 files did exactly that: some called `main()`/
// `run()` bare at module scope with no guard at all, and one (graph-cleanup-nodes.js) had no
// main()/run() wrapper whatsoever — its side-effecting body (deleting hardcoded node IDs from
// graph.json) ran directly at module scope on every import. Neither existing structural test
// above catches this class: both only look for the argv[1]-vs-import.meta.url comparison or a
// missing is-main.js import, not an unguarded *invocation*. This test catches the invocation
// itself, whichever shape it takes, and names the offending file.
//
// A "require.main === module" guard (the CJS-native equivalent, used by
// tools/integrations/sentry-bridge.js, which is CommonJS despite the repo's ESM package.json)
// is also accepted — it is the correct guard for a file that cannot use import.meta at all.
const CJS_GUARD = /require\.main\s*===\s*module/;

test('no tool or hook invokes its entry point at module scope without an is-main guard', () => {
  const offenders = [];
  for (const rel of sourceFiles()) {
    const raw = readFileSync(join(REPO_ROOT, rel), 'utf8');
    const code = blankNonCode(raw);
    const fileIsGuarded = GUARDED_CALL.test(code) || CJS_GUARD.test(code);

    for (const stmt of topLevelStatements(code)) {
      if (DECLARATION_START.test(stmt)) continue;
      // A statement that itself performs the guard check (`if (isMainModule(...)) main();`,
      // `if (require.main === module) { main().catch(...) }`) is exactly the safe shape.
      if (GUARDED_CALL.test(stmt) || CJS_GUARD.test(stmt)) continue;

      const isBareEntryCall = BARE_ENTRY_CALL.test(stmt) || BARE_IIFE.test(stmt);
      if (!isBareEntryCall) continue;

      // A bare main()/run()/IIFE call is only safe if the *whole file* never guards at all
      // because it has no CLI entry point to guard (not applicable here — BARE_ENTRY_CALL only
      // matches an actual main()/run() call, which is the entry point by definition) — so any
      // match here is unconditionally an offense regardless of fileIsGuarded.
      offenders.push(rel);
      break;
    }

    // Second shape: no main()/run() wrapper exists at all (graph-cleanup-nodes.js's original
    // form), so the module's executable body runs directly as top-level statements. Flag any
    // non-declaration, non-guarded top-level statement in a file that defines no main()/run()
    // function and never performs the is-main guard anywhere — i.e. a file with real top-level
    // side effects and zero guarding mechanism at all.
    const definesEntryFn = /\b(?:function|const|let)\s+(?:main|run)\s*[=(]/.test(code) || /\basync\s+function\s+(?:main|run)\s*\(/.test(code);
    // *.test.js files register cases via top-level test()/describe() calls by design — that's
    // node:test's own entry mechanism, not the #374 bug class of "importing runs the program".
    const isTestFile = rel.endsWith('.test.js');
    if (!definesEntryFn && !fileIsGuarded && !isTestFile) {
      for (const stmt of topLevelStatements(code)) {
        if (DECLARATION_START.test(stmt)) continue;
        // Control-flow-only top-level statements (e.g. a bare `if (require.main === module) {}`
        // block, or the .forEach/try patterns used by CLI bodies) are exactly the executable
        // shape we're flagging — any survivor here is unguarded top-level work.
        offenders.push(rel);
        break;
      }
    }
  }
  assert.deepEqual(
    [...new Set(offenders)],
    [],
    `These files run CLI/side-effecting code at module scope with no is-main guard — merely ` +
      `importing them executes their body. Wrap the entry point (adding a main()/run() function ` +
      `first if none exists) and gate it with: import { isMainModule } from './is-main.js'; ` +
      `if (isMainModule(import.meta.url)) main();`,
  );
});
