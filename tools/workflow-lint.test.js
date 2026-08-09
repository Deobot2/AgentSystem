// workflow-lint.test.js — the failing fixtures that make tools/workflow-lint.js a real check.
//
// A linter with no failing fixture is the same paper check this whole exercise exists to
// eliminate (#293), so the load-bearing assertions here are the ones that demand a FAILURE:
// `regressionFixture` is the pre-#286 shape of pr-linked-issue-check.yml, and if this file ever
// goes green on it the gate is dead again.
//
// Fixtures are written to a tmpdir rather than committed as .yml files. Their content lives here
// as line arrays so the column-0 continuation — the actual defect — is visible in review instead
// of buried in escaping.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  extractBlockScalars,
  checkScriptBody,
  checkYamlStructure,
  lintWorkflowText,
  lint,
  stripWorkflowExpressions,
  checkGithubOutputMultiline,
} from './workflow-lint.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_WORKFLOWS = resolve(HERE, '..', '.github', 'workflows');

const L = (...lines) => lines.join('\n') + '\n';

function withTempFile(name, contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-lint-'));
  try {
    const p = join(dir, name);
    writeFileSync(p, contents);
    return fn(p, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const rules = (findings) => findings.map((f) => f.rule);

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────

// The exact defect from #275/#286: `script: |` is indented 12, and the comment body's template
// literal continues at COLUMN 0. The block scalar therefore ends at "Link your PR…", which YAML
// then reads as a new top-level mapping key. Unloadable — and GitHub reports that by silently
// omitting the check, not by failing it.
const regressionFixture = L(
  'name: PR Linked Issue Check',
  'on:',
  '  pull_request:',
  '    branches: [main]',
  'jobs:',
  '  check:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - name: Comment on unlinked PR',
  '        uses: actions/github-script@v7',
  '        with:',
  '          script: |',
  '            await github.rest.issues.createComment({',
  '              owner: context.repo.owner,',
  '              body: `**PR must be linked to an issue.**',
  '',
  // ↓↓↓ column 0 — ends the block scalar mid-template-literal ↓↓↓
  'Link your PR using ONE of these methods:',
  '1. Branch name: issue-<N>-description',
  '',
  'Example:',
  '- Branch: issue-42-add-auth-check',
  '',
  'Spec PRs are exempt.`,',
  '            });',
  '      - name: Fail check',
  '        run: exit 1'
);

// Valid YAML in every respect. Only the JavaScript is broken — an unbalanced brace. actionlint
// passes this file: to a schema linter, `script:` is an opaque string.
const badScriptFixture = L(
  'name: Bad script body',
  'on: [push]',
  'jobs:',
  '  go:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/github-script@v7',
  '        with:',
  '          script: |',
  '            const labels = context.payload.pull_request.labels;',
  '            if (labels.length > 0) {',
  '              core.setOutput("labelled", "true");',
  '            core.info("done");'
);

// Must pass. Deliberately exercises top-level `await`, top-level `return`, and a bare `${{ }}`
// expression — all three are legal github-script and all three would be rejected by a naive
// validator.
const goodFixture = L(
  'name: Good',
  'on: [push]',
  'jobs:',
  '  go:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/github-script@v7',
  '        with:',
  '          script: |',
  '            const comments = await github.paginate(github.rest.issues.listComments, {',
  '              issue_number: ${{ github.event.pull_request.number }},',
  '            });',
  '            if (!comments.length) return;',
  '            await core.summary.addRaw(String(comments.length)).write();'
);

// ── The regression fixture must FAIL ─────────────────────────────────────────────────────────

test('the pre-#286 broken workflow is reported as invalid', () => {
  const { findings } = lintWorkflowText('regression.yml', regressionFixture);
  assert.ok(findings.length > 0, 'the #275 defect must not lint clean');

  // Both layers must fire independently: the truncated block scalar leaves the template literal
  // unterminated (script-syntax), and the escaped text corrupts the document (a yaml-* rule).
  assert.ok(
    findings.some((f) => f.rule === 'script-syntax'),
    `expected a script-syntax finding, got ${JSON.stringify(rules(findings))}`
  );
  assert.ok(
    findings.some((f) => f.rule.startsWith('yaml-')),
    `expected a yaml-* structure finding, got ${JSON.stringify(rules(findings))}`
  );
});

test('the regression fixture exits non-zero through the CLI', () => {
  const cli = join(HERE, 'workflow-lint.js');
  withTempFile('pr-linked-issue-check.yml', regressionFixture, (p) => {
    assert.throws(
      () => execFileSync(process.execPath, [cli, p], { encoding: 'utf8', stdio: 'pipe' }),
      (err) => {
        assert.equal(err.status, 1, 'CLI must exit 1 on an unloadable workflow');
        assert.match(err.stdout, /script: block is not valid JavaScript/);
        return true;
      }
    );
  });
});

// ── Bad `script:` body inside otherwise-valid YAML must FAIL ─────────────────────────────────

test('valid YAML with an invalid script: body is reported as invalid', () => {
  const { findings, scriptBlocks } = lintWorkflowText('bad-script.yml', badScriptFixture);
  assert.equal(scriptBlocks, 1);
  assert.deepEqual(rules(findings), ['script-syntax']);
  assert.equal(
    checkYamlStructure(badScriptFixture).length,
    0,
    'this fixture is valid YAML — only the JavaScript is broken, which is the whole point'
  );
});

// ── The good fixture must PASS ───────────────────────────────────────────────────────────────

test('a workflow using top-level await, top-level return and ${{ }} lints clean', () => {
  const { findings, scriptBlocks } = lintWorkflowText('good.yml', goodFixture);
  assert.equal(scriptBlocks, 1);
  assert.deepEqual(findings, [], 'false positives here would block every PR in the repo');
});

// ── The `node --check` trap ──────────────────────────────────────────────────────────────────

test('checkScriptBody accepts top-level await and return', () => {
  assert.equal(checkScriptBody('const x = await foo();').ok, true);
  assert.equal(checkScriptBody('if (!context.issue) return;\nawait bar();').ok, true);
});

test('node --check cannot validate a github-script body in EITHER module mode', () => {
  // Guards against a future "simplification" to `node --check`. There is no mode in which it
  // works, because a github-script body is an async *function body* and `node --check` only
  // parses whole modules:
  //   - as ESM (.mjs), top-level `return` is "Illegal return statement";
  //   - as CJS (.cjs), top-level `await` is "await is only valid in async functions…".
  // Both constructs are legal, idiomatic github-script, so either choice produces false failures
  // on correct workflows. AsyncFunction reproduces the real wrapper and accepts both.
  const topLevelAwait = 'const x = await foo();\n';
  const topLevelReturn = 'if (!context.issue) return;\n';
  const rejects = (file, source) =>
    withTempFile(file, source, (p) => {
      try {
        execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' });
        return false;
      } catch {
        return true;
      }
    });

  assert.equal(rejects('a.mjs', topLevelReturn), true, 'ESM mode rejects top-level return');
  assert.equal(rejects('a.cjs', topLevelAwait), true, 'CJS mode rejects top-level await');

  assert.equal(checkScriptBody(topLevelAwait).ok, true);
  assert.equal(checkScriptBody(topLevelReturn).ok, true);
});

test('checkScriptBody rejects genuinely broken JavaScript', () => {
  for (const body of ['if (a) {', 'const = 1;', 'foo(', 'return `unterminated']) {
    const r = checkScriptBody(body);
    assert.equal(r.ok, false, `expected ${JSON.stringify(body)} to be rejected`);
    assert.ok(r.message.length > 0);
  }
});

test('workflow expressions are substituted, not parsed as JavaScript', () => {
  assert.equal(stripWorkflowExpressions('n: ${{ github.event.number }},'), 'n: 0,');
  assert.equal(checkScriptBody('const r = ${{ toJSON(steps.x.outputs.y) }};').ok, true);
  // Substitution must not paper over a real error elsewhere in the body.
  assert.equal(checkScriptBody('const r = ${{ toJSON(x) }};\nif (r) {').ok, false);
});

// ── Block scalar extraction: the indentation rule itself ─────────────────────────────────────

test('a block scalar ends at the first non-empty line indented less than its own indent', () => {
  const [scalar] = extractBlockScalars(
    L('a:', '  script: |', '    one', '', '    two', '  next: 1', '  other: 2')
  );
  assert.equal(scalar.key, 'script');
  assert.equal(scalar.indent, 4);
  assert.equal(scalar.body, 'one\n\ntwo');
});

test('blank lines do not end a block scalar', () => {
  const [scalar] = extractBlockScalars(L('run: |', '  a', '', '', '  b', 'x: 1'));
  assert.equal(scalar.body, 'a\n\n\nb');
});

test('folding and chomping indicators are recognised', () => {
  for (const header of ['|', '|-', '|+', '>', '>-', '>+']) {
    const [scalar] = extractBlockScalars(L(`  script: ${header}`, '    body();', '  next: 1'));
    assert.ok(scalar, `header ${header} not recognised`);
    assert.equal(scalar.body, 'body();');
  }
});

test('an explicit indentation indicator wins over the first line indent', () => {
  // `|2` means "content is indented 2 past the parent", so the extra spaces are content.
  const [scalar] = extractBlockScalars(L('script: |2', '      indented', '      more', 'x: 1'));
  assert.equal(scalar.indent, 2);
  assert.equal(scalar.body, '    indented\n    more');
});

test('a step list yields one scalar per script block, not a merged one', () => {
  const scalars = extractBlockScalars(
    L(
      'steps:',
      '  - with:',
      '      script: |',
      '        first();',
      '  - with:',
      '      script: |',
      '        second();'
    )
  ).filter((s) => s.key === 'script');
  assert.equal(scalars.length, 2);
  assert.deepEqual(
    scalars.map((s) => s.body),
    ['first();', 'second();']
  );
});

// ── Structure check: conservative, no false positives ────────────────────────────────────────

test('checkYamlStructure flags plain text where a mapping entry belongs', () => {
  const findings = checkYamlStructure(L('a: 1', 'just some prose'));
  assert.deepEqual(rules(findings), ['yaml-not-a-mapping-entry']);
});

test('checkYamlStructure flags a sequence entry inside a mapping block', () => {
  const findings = checkYamlStructure(L('a: 1', '- item'));
  assert.ok(findings.some((f) => f.rule === 'yaml-mixed-block'));
});

test('checkYamlStructure flags an unquoted value containing ": "', () => {
  // Found by running this tool against the workflow that ships it: a step named
  // `- name: Validate embedded script: bodies` is not loadable YAML.
  const findings = checkYamlStructure(L('steps:', '  - name: Validate embedded script: bodies'));
  assert.deepEqual(rules(findings), ['yaml-colon-in-plain-scalar']);
});

test('checkYamlStructure does not flag colons that are legal in a plain scalar', () => {
  const ok = L(
    'url: https://example.com/a:b',
    'quoted: "a: b"',
    "single: 'a: b'",
    'expr: check-${{ github.ref }}',
    'flow: {a: 1, b: 2}',
    'commented: value # note: trailing comment',
    'time: 12:30'
  );
  assert.deepEqual(checkYamlStructure(ok), []);
});

test('checkYamlStructure flags a tab used for indentation', () => {
  const findings = checkYamlStructure('a:\n\tb: 1\n');
  assert.deepEqual(rules(findings), ['yaml-tab-indent']);
});

test('checkYamlStructure accepts ordinary workflow shapes', () => {
  const ok = L(
    '# leading comment',
    'name: Thing',
    'on:',
    '  pull_request:',
    '    types: [opened,',
    '            synchronize]',
    '    branches: [main]',
    'concurrency:',
    '  group: g-${{ github.ref }}',
    '  cancel-in-progress: true',
    'jobs:',
    '  a:',
    '    runs-on: ubuntu-latest',
    '    permissions:',
    '      pull-requests: write',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - name: Run',
    '        if: >-',
    '          github.event_name == \'push\'',
    '        env:',
    '          URL: https://example.com/a:b',
    '        run: |',
    '          echo "not: yaml"',
    '          exit 0'
  );
  assert.deepEqual(checkYamlStructure(ok), []);
});

// ── `github-output-multiline`: #352 ──────────────────────────────────────────────────────────
//
// The offending line from .github/workflows/enforcement-drift-check.yml:101, pre-fix. `results`
// was built (line 3 here) by appending a literal `\n`, so `printf '%b'` expands it into a
// genuinely multi-line value — and the `key=value` GITHUB_OUTPUT form only accepts one line.

test('fires on the exact pre-fix enforcement-drift-check.yml line-101 shape', () => {
  const body = L(
    'set +e',
    'results=""',
    'results="${results}• Agent definition drift detected\\n"',
    'echo "drift_results=$(printf \'%b\' "$results")" >> "$GITHUB_OUTPUT"'
  );
  const findings = checkGithubOutputMultiline(body, 1);
  assert.deepEqual(rules(findings), ['github-output-multiline']);
  assert.match(findings[0].message, /drift_results<<EOF/);
});

test('fires on a bare $VAR whose value was assigned with a literal \\n elsewhere in the block', () => {
  const body = L(
    'results=""',
    'results="${results}foo\\n"',
    'echo "drift_results=$results" >> "$GITHUB_OUTPUT"'
  );
  const findings = checkGithubOutputMultiline(body, 1);
  assert.deepEqual(rules(findings), ['github-output-multiline']);
});

// The five real single-line command-substitution shapes surveyed across the repo (#352's
// investigation) — a blanket "no `$(` in a GITHUB_OUTPUT append" rule would false-positive on
// every one of these, which is the failure mode this rule must not have.
test('does not fire on real single-line command-substitution shapes', () => {
  const singleLineShapes = [
    'echo "gh_path=$(resolve gh "$HOME/.local/bin/gh" /usr/local/bin/gh /usr/bin/gh)" >> "$GITHUB_OUTPUT"',
    'echo "claude_path=$(resolve claude "$HOME/.local/bin/claude" /usr/local/bin/claude /usr/bin/claude)" >> "$GITHUB_OUTPUT"',
    'echo "node_path=$(resolve node "$HOME/.local/bin/node" /usr/local/bin/node /usr/bin/node)" >> "$GITHUB_OUTPUT"',
    'echo "down=$([ "$state" = down ] && echo true || echo false)" >> "$GITHUB_OUTPUT"',
  ];
  for (const line of singleLineShapes) {
    const findings = checkGithubOutputMultiline(line, 1);
    assert.deepEqual(findings, [], `expected no finding for: ${line}`);
  }
});

test('does not fire on a bare $VAR whose assignments never contain a literal \\n', () => {
  const body = L('agent="friday"', 'echo "agent=$agent" >> "$GITHUB_OUTPUT"');
  assert.deepEqual(checkGithubOutputMultiline(body, 1), []);
});

test('every workflow in .github/workflows has no github-output-multiline finding', () => {
  const report = lint([REPO_WORKFLOWS]);
  const problems = report.files
    .flatMap((f) => f.findings.filter((x) => x.rule === 'github-output-multiline').map((x) => `${f.file}:${x.line}`));
  assert.deepEqual(problems, [], 'a multi-line value is being appended via the single-line key=value GITHUB_OUTPUT form');
});

// ── The repo's own workflows ─────────────────────────────────────────────────────────────────

test('every workflow in .github/workflows lints clean', () => {
  const report = lint([REPO_WORKFLOWS]);
  assert.ok(report.total > 0, 'expected to find workflow files to lint');
  const problems = report.files
    .filter((f) => f.findings.length)
    .map((f) => `${f.file}: ${f.findings.map((x) => `${x.line} ${x.rule}`).join(', ')}`);
  assert.deepEqual(problems, [], 'a workflow in this repo is unloadable or has a broken script:');
  assert.ok(report.scriptBlocks > 0, 'expected github-script blocks to be found and validated');
});
