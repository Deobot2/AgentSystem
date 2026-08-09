// resolve-brain-markers.test.js — the repair must be lossless, and must never touch graph.json
// line-by-line. Both properties are asserted directly rather than through the CLI, plus one
// end-to-end run over a real git checkout so the `git grep` discovery path is exercised too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseSegments,
  isDateBlock,
  earlierValue,
  resolveDateBlock,
  unionBlock,
  resolveText,
  renderSide,
  resolveGeneratedJson,
  isGeneratedGraph,
  findCandidateFiles,
  repair,
  main,
  CONFLICT_TOKEN,
} from './resolve-brain-markers.js';

const conflict = (ours, theirs, { label = 'HEAD', incoming = 'origin/main' } = {}) =>
  `<<<<<<< ${label}\n${ours}=======\n${theirs}>>>>>>> ${incoming}\n`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'brain-markers-'));
}

// ── parsing ──────────────────────────────────────────────────────────────────────────────────

test('parseSegments splits a complete conflict into ours/theirs', () => {
  const text = `top\n${conflict('a\nb\n', 'c\n')}bottom\n`;
  const { segments } = parseSegments(text);
  assert.deepEqual(segments.map((s) => s.type), ['text', 'conflict', 'text']);
  assert.deepEqual(segments[1].ours, ['a', 'b']);
  assert.deepEqual(segments[1].theirs, ['c']);
});

test('parseSegments understands the diff3 common-ancestor section', () => {
  const text = '<<<<<<< HEAD\nours\n||||||| base\nold\n=======\ntheirs\n>>>>>>> other\n';
  const { segments } = parseSegments(text);
  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0].ours, ['ours']);
  assert.deepEqual(segments[0].base, ['old']);
  assert.deepEqual(segments[0].theirs, ['theirs']);
});

test('an INCOMPLETE marker is left as ordinary text — prose about conflicts is never rewritten', () => {
  // A doc that explains merge markers must survive byte-for-byte. This tool runs unattended over
  // a whole brain; rewriting documentation would be data loss dressed up as a repair.
  const doc = `Git writes ${CONFLICT_TOKEN} HEAD at the top of a conflict.\nNo separator follows.\n`;
  const result = resolveText(doc);
  assert.equal(result.changed, false);
  assert.equal(result.blocks, 0);
  assert.equal(result.text, doc);
});

test('a second start marker before the separator abandons the block rather than guessing', () => {
  const text = '<<<<<<< HEAD\na\n<<<<<<< HEAD\nb\n';
  assert.equal(resolveText(text).blocks, 0);
});

// ── rule 1: date blocks ──────────────────────────────────────────────────────────────────────

test('isDateBlock only fires when every non-blank line on both sides is a date-ish key', () => {
  assert.equal(isDateBlock(['created: 2026-01-01'], ['created: 2026-02-02']), true);
  assert.equal(isDateBlock(['created: 2026-01-01'], []), true, 'an empty side is vacuously fine');
  assert.equal(isDateBlock(['created: 2026-01-01'], ['salience: 0.4']), false);
  assert.equal(isDateBlock([], []), false, 'nothing at all is not a date block');
});

test('earlierValue prefers the real earlier date, not the string order', () => {
  // '2026-1-9' sorts AFTER '2026-01-10' lexicographically but is the earlier day.
  assert.equal(earlierValue('2026-1-9', '2026-01-10'), '2026-1-9');
  assert.equal(earlierValue('2026-05-01T10:00:00Z', '2026-05-01T09:00:00Z'), '2026-05-01T09:00:00Z');
  assert.equal(earlierValue('zeta', 'alpha'), 'alpha', 'unparseable values fall back to lexicographic');
});

test('rule 1 keeps the EARLIER created: — a later value is a re-import artifact', () => {
  const text = conflict('created: 2026-07-20\n', 'created: 2026-03-02\n');
  const out = resolveText(text);
  assert.equal(out.dateBlocks, 1);
  assert.equal(out.unionBlocks, 0);
  assert.equal(out.text, 'created: 2026-03-02\n');
});

test('rule 1 handles several date keys at once and keeps HEAD ordering', () => {
  const lines = resolveDateBlock(
    ['created: 2026-07-20', 'updated: 2026-08-01'],
    ['updated: 2026-07-30', 'created: 2026-01-05', 'last_visited: 2026-02-02']
  );
  assert.deepEqual(lines, ['created: 2026-01-05', 'updated: 2026-07-30', 'last_visited: 2026-02-02']);
});

test('rule 1 preserves the winning line verbatim, indentation included', () => {
  const lines = resolveDateBlock(['  created:  2026-09-09'], ['  created:  2026-04-04']);
  assert.deepEqual(lines, ['  created:  2026-04-04']);
});

// ── rule 2: union ────────────────────────────────────────────────────────────────────────────

test('rule 2 unions both sides, HEAD first, de-duplicated', () => {
  assert.deepEqual(unionBlock(['a', 'b'], ['b', 'c']), ['a', 'b', 'c']);
});

test('union cannot lose a fact — every line from either side survives', () => {
  const ours = '- decided to keep the self-hosted runner\n- pym owns migrations\n';
  const theirs = '- pym owns migrations\n- leo owns the runner box\n';
  const out = resolveText(conflict(ours, theirs));
  assert.equal(out.unionBlocks, 1);
  for (const line of [...ours.split('\n'), ...theirs.split('\n')].filter(Boolean)) {
    assert.ok(out.text.includes(line), `union dropped: ${line}`);
  }
  assert.equal(out.text.match(/pym owns migrations/g).length, 1, 'and de-duplicates');
});

test('a mixed block unions rather than taking the date rule', () => {
  const out = resolveText(conflict('created: 2026-07-20\nfact: a\n', 'created: 2026-01-01\nfact: b\n'));
  assert.equal(out.dateBlocks, 0);
  assert.equal(out.unionBlocks, 1);
  assert.ok(out.text.includes('fact: a') && out.text.includes('fact: b'));
});

test('no conflict marker survives a repair', () => {
  const text = `head\n${conflict('a\n', 'b\n')}mid\n${conflict('created: 2026-02-02\n', 'created: 2026-01-01\n')}tail\n`;
  const out = resolveText(text);
  assert.equal(out.blocks, 2);
  for (const token of ['<<<<<<<', '=======', '>>>>>>>']) {
    assert.ok(!out.text.includes(token), `${token} survived`);
  }
});

test('CRLF documents stay CRLF', () => {
  const text = '<<<<<<< HEAD\r\na\r\n=======\r\nb\r\n>>>>>>> x\r\n';
  const out = resolveText(text);
  assert.equal(out.text, 'a\r\nb\r\n');
});

// ── graph.json: generated, never line-merged ─────────────────────────────────────────────────

test('isGeneratedGraph identifies graph.json anywhere', () => {
  assert.equal(isGeneratedGraph('/x/nexus/personal-brain/graph.json'), true);
  assert.equal(isGeneratedGraph('/x/nexus/personal-brain/nodes/a.md'), false);
});

test('resolveGeneratedJson takes ONE side and never merges the two', () => {
  const text =
    '{"brain":"personal","nodes":[\n' +
    '<<<<<<< HEAD\n"cl-port",\n=======\n"other-node",\n>>>>>>> origin/main\n' +
    '"shared"]}\n';
  const picked = resolveGeneratedJson(text);
  assert.equal(picked.side, 'ours');
  const parsed = JSON.parse(picked.text);
  assert.deepEqual(parsed.nodes, ['cl-port', 'shared']);
  assert.ok(!picked.text.includes('other-node'), 'a union would have produced invalid JSON');
});

test('resolveGeneratedJson falls through to the incoming side when HEAD does not parse', () => {
  const text =
    '<<<<<<< HEAD\n{"nodes":[broken\n=======\n{"nodes":["ok"],"edges":[]}\n>>>>>>> origin/main\n';
  const picked = resolveGeneratedJson(text);
  assert.equal(picked.side, 'theirs');
  assert.deepEqual(JSON.parse(picked.text).nodes, ['ok']);
});

test('resolveGeneratedJson returns null when neither side is a graph — STOP, do not guess', () => {
  const text = '<<<<<<< HEAD\n{"nope":1}\n=======\nnot json at all\n>>>>>>> origin/main\n';
  assert.equal(resolveGeneratedJson(text), null);
});

test('renderSide keeps exactly one side', () => {
  const text = `x\n${conflict('a\n', 'b\n')}y\n`;
  assert.equal(renderSide(text, 'ours'), 'x\na\ny\n');
  assert.equal(renderSide(text, 'theirs'), 'x\nb\ny\n');
});

// ── repair() over a real tree ────────────────────────────────────────────────────────────────

function seedBrain(root) {
  const brain = join(root, 'nexus', 'personal-brain');
  mkdirSync(join(brain, 'nodes'), { recursive: true });
  writeFileSync(
    join(brain, 'nodes', 'decision.md'),
    `---\nid: decision-1\n${conflict('created: 2026-07-20\n', 'created: 2026-02-02\n')}---\n` +
      `${conflict('- keep the runner\n', '- keep the gate\n')}`,
    'utf8'
  );
  writeFileSync(
    join(brain, 'graph.json'),
    '{"brain":"personal","nodes":[\n<<<<<<< HEAD\n"a",\n=======\n"b",\n>>>>>>> origin/main\n"c"],"edges":[]}\n',
    'utf8'
  );
  writeFileSync(join(brain, 'nodes', 'clean.md'), '---\nid: clean\n---\nnothing to do\n', 'utf8');
  return brain;
}

test('repair(--check) reports without writing, and exits 1 through main()', () => {
  const root = tempDir();
  try {
    const brain = seedBrain(root);
    const before = readFileSync(join(brain, 'nodes', 'decision.md'), 'utf8');

    const report = repair(root, { check: true });
    assert.equal(report.files.length, 2);
    assert.equal(report.repaired, 0);
    assert.equal(readFileSync(join(brain, 'nodes', 'decision.md'), 'utf8'), before, '--check wrote to disk');

    assert.equal(main([`--root=${root}`, '--check', '--quiet']), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repair rewrites authored files line-wise and graph.json side-wise, and names the rebuild', () => {
  const root = tempDir();
  try {
    const brain = seedBrain(root);
    const report = repair(root);

    assert.equal(report.unresolved.length, 0);
    assert.equal(report.repaired, 2);
    assert.deepEqual(report.rebuildBrains, ['nexus/personal-brain']);

    const node = readFileSync(join(brain, 'nodes', 'decision.md'), 'utf8');
    assert.ok(node.includes('created: 2026-02-02'), 'kept the earlier created');
    assert.ok(!node.includes('2026-07-20'));
    assert.ok(node.includes('- keep the runner') && node.includes('- keep the gate'), 'unioned the facts');
    assert.ok(!node.includes('<<<<<<<') && !node.includes('>>>>>>>'));

    const graph = JSON.parse(readFileSync(join(brain, 'graph.json'), 'utf8'));
    assert.deepEqual(graph.nodes, ['a', 'c']);

    // Idempotent: a second pass finds nothing.
    assert.equal(repair(root).files.length, 0);
    assert.equal(main([`--root=${root}`, '--check', '--quiet']), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unresolvable graph.json makes the run exit 1 instead of writing a guess', () => {
  const root = tempDir();
  try {
    const brain = join(root, 'nexus', 'broken');
    mkdirSync(brain, { recursive: true });
    const text = '<<<<<<< HEAD\n{"nope":1}\n=======\nnot json\n>>>>>>> origin/main\n';
    writeFileSync(join(brain, 'graph.json'), text, 'utf8');

    const report = repair(root);
    assert.equal(report.unresolved.length, 1);
    assert.equal(readFileSync(join(brain, 'graph.json'), 'utf8'), text, 'left the file alone');
    assert.equal(main([`--root=${root}`, '--quiet']), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findCandidateFiles uses git grep on a checkout and finds untracked files too', () => {
  const root = tempDir();
  try {
    execFileSync('git', ['-C', root, 'init', '-q'], { stdio: 'ignore' });
    execFileSync('git', ['-C', root, 'config', 'user.email', 't@t'], { stdio: 'ignore' });
    execFileSync('git', ['-C', root, 'config', 'user.name', 't'], { stdio: 'ignore' });

    const brain = seedBrain(root);
    execFileSync('git', ['-C', root, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', ['-C', root, 'commit', '-qm', 'committed markers, the #344 shape'], { stdio: 'ignore' });

    // An untracked node with markers must be found as well — brain-sync commits with `add -A`,
    // so "untracked" and "tracked" are both one sync away from being permanent.
    writeFileSync(join(brain, 'nodes', 'untracked.md'), conflict('x\n', 'y\n'), 'utf8');

    const found = findCandidateFiles(root).map((p) => p.replace(/\\/g, '/'));
    assert.ok(found.some((f) => f.endsWith('nodes/decision.md')));
    assert.ok(found.some((f) => f.endsWith('nodes/untracked.md')), 'missed the untracked file');
    assert.ok(found.some((f) => f.endsWith('graph.json')));
    assert.ok(!found.some((f) => f.endsWith('nodes/clean.md')));

    assert.equal(repair(root).unresolved.length, 0);
    assert.equal(main([`--root=${root}`, '--check', '--quiet']), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the search never builds a shell string — markers must not reach cmd.exe as redirection', () => {
  // `<<<<<<<` inside a command STRING is parsed as redirection by cmd.exe. The guard is that the
  // token is passed through an execFileSync args array, so assert the source never interpolates
  // it into an exec*Sync call that takes a string.
  const src = readFileSync(new URL('./resolve-brain-markers.js', import.meta.url), 'utf8');
  assert.ok(!/execSync\s*\(/.test(src), 'execSync takes a shell string — use execFileSync with an args array');
  assert.ok(/execFileSync\(\s*'git',\s*\[/.test(src), 'git must be invoked with an args array');
  assert.ok(!/shell:\s*true/.test(src), 'no shell:true anywhere in this tool');
});

test('an empty or missing root is a usage error, not a silent clean report', () => {
  assert.equal(main(['--root=/definitely/not/here/at/all', '--quiet']), 2);
});
