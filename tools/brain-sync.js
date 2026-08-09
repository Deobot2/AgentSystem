#!/usr/bin/env node
// brain-sync.js — sync ~/agent-memory (the central agent brain) with its private remote.
//
// The brain is shared by every host running AgentSystem: this laptop, the Mission Control server,
// and anything added later. Git is the transport rather than a cloud drive because a drive syncs
// whole files last-writer-wins, and `graph.json` is rewritten in full by the graph tools — two
// hosts writing in the same window would silently drop one side's nodes. Git turns that into a
// visible conflict instead.
//
// Usage:
//   node tools/brain-sync.js              pull, merge, commit local changes, push
//   node tools/brain-sync.js --status     report what would sync; change nothing
//   node tools/brain-sync.js --pull-only  pull and merge; do not push
//   node tools/brain-sync.js --path <dir> operate on a checkout other than ~/agent-memory
//
// Exit codes: 0 synced (or nothing to do), 1 conflict needing a human, 2 usage/setup error.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);

const args = process.argv.slice(2);
const opt = { status: false, pullOnly: false, root: path.join(os.homedir(), 'agent-memory') };

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--status': opt.status = true; break;
    case '--pull-only': opt.pullOnly = true; break;
    case '--path': opt.root = args[++i] || die('--path needs a directory', 2); break;
    case '-h': case '--help':
      process.stdout.write(
        fs.readFileSync(__filename, 'utf8').split('\n')
          .slice(1).filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, ''))
          .join('\n') + '\n');
      process.exit(0);
      break;
    default: die(`unknown option: ${args[i]} (try --help)`, 2);
  }
}

function die(msg, code) { process.stderr.write(`brain-sync: ${msg}\n`); process.exit(code); }
function log(msg) { process.stdout.write(`${msg}\n`); }

// Every git call is checked. A sync tool that ignores a failed pull and pushes anyway is how you
// get a force-push argument with yourself later.
function git(gitArgs, { allowFail = false } = {}) {
  const r = spawnSync('git', ['-C', opt.root, ...gitArgs], { encoding: 'utf8' });
  if (r.error) die(`cannot run git: ${r.error.message}`, 2);
  if (r.status !== 0 && !allowFail) {
    die(`git ${gitArgs.join(' ')} failed (${r.status})\n${(r.stderr || r.stdout).trim()}`, 1);
  }
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

if (!fs.existsSync(path.join(opt.root, '.git'))) {
  die(`no git checkout at ${opt.root}\n` +
      `  clone it first: git clone <brain-remote> ${opt.root}`, 2);
}

// Identity: commits are made non-interactively by hooks and cron, where a missing user.email is a
// hard failure with an unhelpful message. Supply one per-command rather than mutating global config.
const IDENT = ['-c', 'user.name=AgentSystem brain-sync', '-c', 'user.email=brain-sync@localhost'];
const HOST = os.hostname();

// ---------------------------------------------------------------------------- status

const dirty = git(['status', '--porcelain']).out;
git(['fetch', '--quiet', 'origin']);
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out;
const counts = git(['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`], { allowFail: true });
const [behind, ahead] = counts.code === 0 ? counts.out.split(/\s+/) : ['?', '?'];

if (opt.status) {
  const changed = dirty ? dirty.split('\n').length : 0;
  log(`brain     ${opt.root}`);
  log(`branch    ${branch} (${ahead} ahead, ${behind} behind origin)`);
  log(`local     ${changed} uncommitted change(s)`);
  if (dirty) log(dirty.split('\n').map((l) => `          ${l}`).join('\n'));
  process.exit(0);
}

// ---------------------------------------------------------------------------- commit local work

// --pull-only means pull only, all the way down. This ran at SessionStart, where the promise to the
// user is "bring this host up to date, write nothing" — but committing here made every session open
// by staging `git add -A` and writing a commit, so an editor left mid-thought or a half-finished
// merge became a permanent commit that the next non-pull-only run pushed everywhere. The pull below
// can still fail on a dirty tree; that is the honest outcome, and it stops rather than committing.
if (dirty && opt.pullOnly) {
  log(`${dirty.split('\n').length} local change(s) left uncommitted (--pull-only)`);
} else if (dirty) {
  git(['add', '-A']);
  // Host in the subject on purpose: when a conflict does show up, knowing which machine wrote
  // which side is the whole diagnosis.
  git([...IDENT, 'commit', '--quiet', '-m',
    `brain: sync from ${HOST}`,
    '-m', `${dirty.split('\n').length} path(s) changed. Written by tools/brain-sync.js.`]);
  log(`committed ${dirty.split('\n').length} local change(s)`);
}

// ---------------------------------------------------------------------------- pull

// Merge, not rebase: brain history is a record of what each host knew when, and rebasing rewrites
// commits that other hosts have already pulled.
const pull = git([...IDENT, 'pull', '--no-edit', '--no-rebase', 'origin', branch], { allowFail: true });

if (pull.code !== 0) {
  const conflicts = git(['diff', '--name-only', '--diff-filter=U'], { allowFail: true }).out
    .split('\n').filter(Boolean);

  // A dirty tree under --pull-only is not a conflict. Since --pull-only no longer commits first, git
  // refuses the merge outright when incoming changes touch a locally modified file — nothing is
  // merged, nothing is broken, there is no unmerged path to resolve. Reporting that as "a human must
  // resolve a merge" would open an issue at every session start on any host with unsaved memory
  // edits. Say so and exit 0; the next full sync commits and pushes properly.
  if (opt.pullOnly && dirty && !conflicts.length) {
    log('pull skipped: local changes are uncommitted (--pull-only writes nothing)');
    process.exit(0);
  }

  // graph.json is a generated index, not authored content — it is rewritten whole on every graph
  // write, so a conflict there is guaranteed the moment two hosts think. Take our side and let the
  // next graph-init rebuild it from nodes/, which is where the real facts live. Anything else is a
  // genuine content conflict and stops here for a human.
  const generated = conflicts.filter((f) => path.basename(f) === 'graph.json');
  const real = conflicts.filter((f) => path.basename(f) !== 'graph.json');

  if (real.length || !generated.length) {
    process.stderr.write(
      `brain-sync: merge conflict needs a human:\n${
        (conflicts.length ? conflicts : ['(see git status)']).map((f) => `  ${f}`).join('\n')}\n` +
      `\nResolve in ${opt.root}, then: git commit && node tools/brain-sync.js\n`);
    process.exit(1);
  }

  for (const f of generated) git(['checkout', '--ours', '--', f]);
  git(['add', ...generated]);
  git([...IDENT, 'commit', '--quiet', '--no-edit']);
  log(`resolved ${generated.length} generated graph.json conflict(s) — ` +
      `regenerate with tools/graph/graph-init.js`);
}

// ---------------------------------------------------------------------------- push

if (opt.pullOnly) { log('pulled (--pull-only, not pushing)'); process.exit(0); }

const outgoing = git(['rev-list', '--count', `origin/${branch}..HEAD`], { allowFail: true }).out;
if (outgoing === '0') { log('up to date, nothing to push'); process.exit(0); }

git(['push', '--quiet', 'origin', branch]);
log(`pushed ${outgoing} commit(s) to origin/${branch}`);
