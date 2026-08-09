#!/usr/bin/env node
// workflow-lint.js — fail when a workflow file is unloadable, or embeds a `script:` body that is
// not valid JavaScript.
//
// Usage:
//   node tools/workflow-lint.js                  # lint .github/workflows in the repo root
//   node tools/workflow-lint.js <path> [<path>…] # lint specific files or directories
//   node tools/workflow-lint.js --json           # machine-readable findings on stdout
//
// Exit 0 = clean, 1 = findings, 2 = bad invocation.
//
// ── Why this exists ──────────────────────────────────────────────────────────────────────────
//
// `.github/workflows/pr-linked-issue-check.yml` shipped in #275 and never ran once. A line at
// column 0 inside a `script: |` block ended the YAML block scalar early, so the file was not
// loadable. GitHub does NOT surface an unloadable workflow as a failing check — it omits the
// check from the run list entirely. The repo therefore carried a "required gate" that was
// invisible, silent, and believed to be working for weeks (#286, #293).
//
// actionlint is the schema layer and catches that class outright. This tool covers the layer
// actionlint does not: the *contents* of a `script:` block for `actions/github-script`. To
// actionlint, `script:` is an opaque string — a block that is syntactically invalid JavaScript
// passes the schema and then throws SyntaxError at runtime, on a workflow that may only fire on
// a rare event. It also carries its own conservative YAML structure check, so a bad-YAML failure
// is reported even where actionlint is unavailable (a dev's laptop, `npm test`).
//
// ── Two traps encoded here ───────────────────────────────────────────────────────────────────
//
// 1. `node --check` is the WRONG validator for a github-script body, and there is no mode in
//    which it is right. github-script wraps the body in an async function, so top-level `await`
//    and top-level `return` are both legal — but `node --check` parses a whole *module*:
//      • as ESM (.mjs) it rejects top-level `return`  → "Illegal return statement"
//      • as CJS (.cjs) it rejects top-level `await`   → "await is only valid in async functions…"
//    Either choice fails correct workflows. Compile the body the way the runtime does instead:
//        Object.getPrototypeOf(async function () {}).constructor(body)
//    That is a compile, not an execution: the body's statements never run. Encoded in
//    workflow-lint.test.js so a future "simplification" to `node --check` fails the suite.
//
// 2. No npm dependencies (the `tools/**` rule), so no js-yaml. Block scalars are extracted by
//    the indentation rule directly — a block scalar ends at the first non-empty line indented
//    less than the block's own indent. That rule is precisely the one #275 violated, so
//    implementing it here is not a workaround; it is the check.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-main.js';

const WORKFLOW_EXT = /\.ya?ml$/i;

// ── YAML block scalar extraction ─────────────────────────────────────────────────────────────

// A line that opens a block scalar: `key: |`, `key: >-`, `- key: |2`, `key: |+ # comment`.
// Group 1 = full leading indent (including any `- ` bullets), group 2 = key, group 3 = the
// header (style char + optional chomping indicator + optional explicit indentation indicator).
const BLOCK_HEADER = /^([ \t]*(?:-[ \t]+)*)([^\s#][^:]*?)[ \t]*:[ \t]*([|>][+-]?[0-9]?|[|>][0-9]?[+-]?)[ \t]*(#.*)?$/;

const indentOf = (line) => line.length - line.replace(/^[ \t]*/, '').length;
const isBlank = (line) => line.trim() === '';

/**
 * Extract every block scalar in a YAML document, using the indentation rule directly.
 *
 * The rule, stated exactly: the scalar's content indent is the explicit indentation indicator if
 * the header carries one, else the indent of the scalar's first non-empty line. The scalar then
 * ends at the first non-empty line whose indent is LESS than that. Blank lines never end it, and
 * a `#` at a lower indent is a dedent (comments are not recognised inside a block scalar), so it
 * ends the scalar too.
 *
 * @param {string} text
 * @returns {Array<{key:string, headerLine:number, firstLine:number, indent:number, body:string}>}
 */
export function extractBlockScalars(text) {
  const lines = text.split(/\r?\n/);
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const m = BLOCK_HEADER.exec(lines[i]);
    if (!m) continue;

    const [, lead, rawKey, header] = m;
    const headerIndent = lead.length;
    const explicit = /[0-9]/.exec(header);

    // Find the first non-empty line of the body.
    let j = i + 1;
    while (j < lines.length && isBlank(lines[j])) j++;
    if (j >= lines.length) continue; // header at EOF: empty scalar, nothing to check

    const firstIndent = indentOf(lines[j]);
    // An explicit indicator is relative to the parent node's indentation.
    const contentIndent = explicit ? headerIndent + Number(explicit[0]) : firstIndent;

    // Not actually a block scalar body — the next content line is not indented past the header.
    // (Most often this means the "header" match was a false positive, e.g. a value that merely
    // looks like one.) Skip rather than mis-report.
    if (contentIndent <= headerIndent) continue;

    const body = [];
    let k = i + 1;
    for (; k < lines.length; k++) {
      if (isBlank(lines[k])) {
        body.push('');
        continue;
      }
      if (indentOf(lines[k]) < contentIndent) break; // ← the rule #275 violated
      body.push(lines[k].slice(contentIndent));
    }

    // Trim trailing blank lines that belong to the following node, not the scalar.
    while (body.length && body[body.length - 1] === '') body.pop();

    out.push({
      key: rawKey.trim().replace(/^["']|["']$/g, ''),
      headerLine: i + 1,
      firstLine: j + 1,
      indent: contentIndent,
      body: body.join('\n'),
    });

    i = k - 1; // do not rescan the scalar's own body for headers
  }

  return out;
}

// ── Conservative YAML structure check ────────────────────────────────────────────────────────

/**
 * Find the offset of the `:` that separates a mapping key from its value, ignoring colons inside
 * quotes and inside `${{ … }}`. YAML plain scalars cannot contain `: `, so "first `:` followed by
 * whitespace or end-of-line, outside quotes" is the exact rule.
 * @returns {number} offset of the separator, or -1 if the line is not a mapping entry.
 */
function keySeparator(content) {
  let quote = null;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(content[i - 1]))) return -1; // trailing comment
    if (c === ':' && (i + 1 === content.length || /\s/.test(content[i + 1]))) return i;
  }
  return -1;
}

/** Net change in flow-collection depth ( [] and {} ) on a line, ignoring quoted regions. */
function flowDelta(content) {
  let quote = null;
  let delta = 0;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(content[i - 1]))) break;
    if (c === '[' || c === '{') delta++;
    else if (c === ']' || c === '}') delta--;
  }
  return delta;
}

/**
 * Structural sanity check over the document's block context, skipping block scalar interiors.
 *
 * Deliberately conservative — it reports only what is unambiguously invalid YAML, because a false
 * positive here blocks every PR in the repo. actionlint remains the authoritative schema layer;
 * this exists so `npm test` alone still catches an unloadable file.
 *
 * @param {string} text
 * @returns {Array<{line:number, rule:string, message:string}>}
 */
export function checkYamlStructure(text) {
  const lines = text.split(/\r?\n/);

  // Mark every line that lives inside a block scalar body — those are opaque text.
  const inScalar = new Set();
  for (const s of extractBlockScalars(text)) {
    const count = s.body === '' ? 0 : s.body.split('\n').length;
    for (let n = 0; n < count; n++) inScalar.add(s.firstLine + n);
    // Blank lines interleaved in the body are covered by the range above.
  }

  const findings = [];
  /** @type {Array<{indent:number, kind:'map'|'seq'}>} */
  const stack = [];
  let flowDepth = 0;
  let opensBlock = true; // the document root may be indented

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i];
    if (inScalar.has(lineNo)) continue;
    if (isBlank(raw)) continue;

    const content = raw.replace(/^[ \t]*/, '');
    if (content.startsWith('#')) continue;
    if (content === '---' || content === '...') {
      stack.length = 0;
      opensBlock = true;
      continue;
    }

    if (flowDepth > 0) {
      flowDepth += flowDelta(content);
      continue;
    }

    if (/^\t/.test(raw) || /^[ ]*\t/.test(raw.slice(0, raw.length - content.length))) {
      findings.push({
        line: lineNo,
        rule: 'yaml-tab-indent',
        message: 'tab character in indentation — YAML forbids tabs for indentation',
      });
      continue;
    }

    const indent = raw.length - content.length;

    // Dedent: pop every deeper level, then the indent must land exactly on an open level.
    while (stack.length && stack[stack.length - 1].indent > indent) stack.pop();

    const isSeq = /^-(\s|$)/.test(content);

    if (stack.length && stack[stack.length - 1].indent < indent && !opensBlock) {
      findings.push({
        line: lineNo,
        rule: 'yaml-unexpected-indent',
        message:
          `unexpected indentation: column ${indent} opens a block, but the previous line already ` +
          'had a value (nothing here can be its parent)',
      });
      // Resync so one mistake does not cascade into a wall of noise.
      stack.push({ indent, kind: isSeq ? 'seq' : 'map' });
      opensBlock = false;
      continue;
    }

    if (!stack.length || stack[stack.length - 1].indent < indent) {
      stack.push({ indent, kind: isSeq ? 'seq' : 'map' });
    } else {
      const top = stack[stack.length - 1];
      if (top.indent !== indent) {
        findings.push({
          line: lineNo,
          rule: 'yaml-bad-dedent',
          message:
            `bad indentation: column ${indent} does not line up with any open block ` +
            `(nearest is column ${top.indent})`,
        });
        top.indent = indent; // resync
      }
      const kind = isSeq ? 'seq' : 'map';
      if (top.kind !== kind) {
        findings.push({
          line: lineNo,
          rule: 'yaml-mixed-block',
          message:
            `${kind === 'seq' ? 'sequence entry' : 'mapping key'} at column ${indent}, but this ` +
            `block is already a ${top.kind === 'seq' ? 'sequence' : 'mapping'} — ` +
            'a block cannot be both',
        });
        top.kind = kind;
      }
    }

    // Everything below inspects the entry's own content.
    let entry = content;
    let entryIndent = indent;
    if (isSeq) {
      const after = content.replace(/^-\s*/, '');
      if (after === '') {
        opensBlock = true;
        flowDepth += flowDelta(content);
        continue;
      }
      entryIndent = indent + (content.length - after.length);
      entry = after;
      // `- key: value` opens a mapping nested inside the sequence entry.
      stack.push({ indent: entryIndent, kind: keySeparator(entry) >= 0 ? 'map' : 'seq' });
    }

    const sep = keySeparator(entry);
    const topKind = stack[stack.length - 1].kind;

    if (topKind === 'map' && sep < 0 && !/^[?&*]/.test(entry)) {
      findings.push({
        line: lineNo,
        rule: 'yaml-not-a-mapping-entry',
        message:
          `expected a "key: value" mapping entry at column ${entryIndent}, got plain text ` +
          `(${JSON.stringify(entry.slice(0, 60))}) — a block scalar above probably ended early`,
      });
      opensBlock = false;
      flowDepth += flowDelta(entry);
      continue;
    }

    const value = sep >= 0 ? entry.slice(sep + 1).trim() : '';

    // A plain (unquoted) scalar may not contain ": " — YAML reads the second colon as another
    // mapping separator and rejects the line ("mapping values are not allowed in this context").
    // This is how `- name: Validate embedded script: bodies` gets caught. Workflow expressions
    // are stripped first: they are substituted before YAML ever sees them in spirit, and a colon
    // inside one is not a separator.
    if (
      sep >= 0 &&
      value !== '' &&
      // `{` / `[` open a flow collection, where `key: value` pairs are legal on one line
      // (`types: [opened, synchronize]`, `env: {A: 1}`). `|`/`>` are block scalar headers,
      // `&`/`*`/`!` anchors, aliases and tags.
      !/^[|>&*!{[]/.test(value) &&
      flowDelta(value) === 0 &&
      keySeparator(stripWorkflowExpressions(value)) >= 0
    ) {
      findings.push({
        line: lineNo,
        rule: 'yaml-colon-in-plain-scalar',
        message:
          `unquoted value contains ": " (${JSON.stringify(value.slice(0, 60))}) — YAML reads ` +
          'the second colon as a mapping separator; quote the value',
      });
    }

    // A key with no value (or a block-scalar header) opens a nested block on the next line.
    opensBlock = sep >= 0 && (value === '' || value.startsWith('#') || /^[|>][+-]?[0-9]?$/.test(value));
    flowDepth += flowDelta(entry);
  }

  return findings;
}

// ── github-script body validation ────────────────────────────────────────────────────────────

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// A `${{ … }}` workflow expression. Actions substitutes these textually BEFORE the JS is
// compiled, so a bare one (`pull_number: ${{ github.event.pull_request.number }},`) is legal in a
// script body even though it is not legal JavaScript. Left alone it would make four correct
// workflows in this repo fail the check — a false positive, which is the one failure mode a
// repo-wide gate cannot afford.
//
// The body is disallowed braces (`(?:[^{}]|\}(?!\}))*`) so the match cannot run away past the end
// of a real expression and swallow surrounding code. actionlint is the layer that validates what
// is *inside* the expression; here it only has to become something JS can parse.
const WORKFLOW_EXPR = /\$\{\{(?:[^{}]|\}(?!\}))*\}\}/g;

/** Replace workflow expressions with a placeholder that is valid in any JS expression position. */
export function stripWorkflowExpressions(body) {
  return body.replace(WORKFLOW_EXPR, '0');
}

/**
 * Compile `body` the way actions/github-script does: as the body of an async function.
 *
 * Uses AsyncFunction, NOT `node --check`. `node --check` parses as a *script*, where top-level
 * `await` and top-level `return` are syntax errors — and both are legal, idiomatic github-script.
 * Using it here would reject correct workflows while still missing nothing extra.
 *
 * Compilation does not execute the body.
 *
 * @param {string} body
 * @returns {{ok: true} | {ok: false, message: string}}
 */
export function checkScriptBody(body) {
  try {
    // eslint-disable-next-line no-new -- compile-only; the body is never invoked.
    new AsyncFunction(stripWorkflowExpressions(body));
    return { ok: true };
  } catch (err) {
    if (err instanceof SyntaxError) return { ok: false, message: err.message };
    throw err;
  }
}

// ── File-level lint ──────────────────────────────────────────────────────────────────────────

/**
 * @param {string} filePath
 * @param {string} [text] pre-read contents (used by tests)
 * @returns {{file:string, findings:Array<{line:number, rule:string, message:string}>, scriptBlocks:number}}
 */
export function lintWorkflowText(filePath, text) {
  const source = text ?? readFileSync(filePath, 'utf8');
  const findings = checkYamlStructure(source).map((f) => ({ ...f }));

  let scriptBlocks = 0;
  for (const scalar of extractBlockScalars(source)) {
    if (scalar.key !== 'script') continue;
    scriptBlocks++;
    const result = checkScriptBody(scalar.body);
    if (!result.ok) {
      findings.push({
        line: scalar.firstLine,
        rule: 'script-syntax',
        message: `script: block is not valid JavaScript: ${result.message}`,
      });
    }
  }

  findings.sort((a, b) => a.line - b.line);
  return { file: filePath, findings, scriptBlocks };
}

/** Expand a path into the workflow files under it. */
export function collectWorkflowFiles(target) {
  let st;
  try {
    st = statSync(target);
  } catch {
    return [];
  }
  if (st.isFile()) return WORKFLOW_EXT.test(target) ? [target] : [];
  return readdirSync(target)
    .filter((n) => WORKFLOW_EXT.test(n))
    .sort()
    .map((n) => join(target, n));
}

/**
 * @param {string[]} targets files and/or directories
 * @returns {{files:Array<ReturnType<typeof lintWorkflowText>>, total:number, invalid:number, scriptBlocks:number}}
 */
export function lint(targets) {
  const files = targets.flatMap(collectWorkflowFiles).map((f) => lintWorkflowText(f));
  return {
    files,
    total: files.length,
    invalid: files.filter((f) => f.findings.length).length,
    scriptBlocks: files.reduce((n, f) => n + f.scriptBlocks, 0),
  };
}

function defaultTarget() {
  const here = fileURLToPath(new URL('.', import.meta.url));
  return resolve(here, '..', '.github', 'workflows');
}

function main(argv) {
  const args = argv.filter((a) => a !== '--json');
  const asJson = argv.includes('--json');
  const targets = args.length ? args : [defaultTarget()];

  const report = lint(targets);

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return report.invalid ? 1 : 0;
  }

  if (report.total === 0) {
    process.stderr.write(`workflow-lint: no workflow files found under ${targets.join(', ')}\n`);
    return 2;
  }

  const cwd = process.cwd();
  for (const f of report.files) {
    if (!f.findings.length) continue;
    const shown = relative(cwd, f.file).split(sep).join('/') || f.file;
    for (const finding of f.findings) {
      process.stdout.write(`${shown}:${finding.line}: ${finding.message} [${finding.rule}]\n`);
    }
  }

  process.stdout.write(
    `workflow-lint: ${report.total} workflow file(s), ${report.scriptBlocks} script block(s), ` +
      `${report.invalid} invalid\n`
  );
  return report.invalid ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
