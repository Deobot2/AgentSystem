#!/usr/bin/env node
// Copies skills/<name>/SKILL.md from this repo into ~/.claude/skills/<name>/SKILL.md.
// Node builtins only. Idempotent — safe to re-run any time skills change.
//
// Usage:
//   node tools/install-skills.js [names...] [--all]      install (default set is CORE)
//   node tools/install-skills.js [names...] [--all] --check   dry-run: exit 1 on drift, writes nothing
//   node tools/install-skills.js --check --require-install    a bare host is failure, not a pass
//
// #305: closes the "install-skills.js has no --check, so nothing detects re-drift" gap left open
// by #199. Modeled on tools/deploy-hooks.js --check (the closer analogue of the two existing
// --check tools): both this tool and deploy-hooks.js do a plain repo-file -> ~/.claude copy with
// no content transformation, so "drift" is a straight hash/content comparison of the same bytes.
// sync-agents.js --check is the wrong template here — it rewrites content per platform (strips
// `tools:`, injects SHARED blocks, sets a model line) before comparing, which this tool never does.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import { isMainModule } from './is-main.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const srcRoot = path.join(repoRoot, 'skills');
const destRoot = path.join(os.homedir(), '.claude', 'skills');

function listSkillDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function copySkill(name) {
  const srcFile = path.join(srcRoot, name, 'SKILL.md');
  if (!fs.existsSync(srcFile)) {
    return { name, status: 'skipped', reason: 'no SKILL.md' };
  }
  const destDir = path.join(destRoot, name);
  const destFile = path.join(destDir, 'SKILL.md');
  fs.mkdirSync(destDir, { recursive: true });

  let existed = false;
  let unchanged = false;
  if (fs.existsSync(destFile)) {
    existed = true;
    const before = fs.readFileSync(destFile, 'utf8');
    const after = fs.readFileSync(srcFile, 'utf8');
    unchanged = before === after;
  }

  fs.copyFileSync(srcFile, destFile);

  if (!existed) return { name, status: 'installed' };
  if (unchanged) return { name, status: 'unchanged' };
  return { name, status: 'updated' };
}

// Every installed skill's description is loaded into EVERY session (~70 tok each), so
// installing all of them is a real per-session cost for skills that fire once a month.
// CORE = high value and frequently triggered. The rest stay in the repo and are installed
// on demand: `node tools/install-skills.js standup stale-sweep`, or `--all`.
// daily-briefing and daily-triage are CORE because they fire every day (scheduled-tasks.yml) and
// the user triggers them by name. Both are gitignored private life-OS skills (.gitignore #187), so
// they exist only on this machine — the CORE.filter below silently drops them where the dir is
// absent.
const CORE = ['verify-claim', 'replicate-bug', 'pr-ready', 'postmortem', 'refute', 'daily-briefing', 'daily-triage'];

// Skill parity check (#305). For each requested skill, compare the repo's SKILL.md against
// what is installed under ~/.claude/skills/<name>/SKILL.md — the exact bytes copySkill() would
// write. No transformation happens in between (unlike sync-agents.js), so a plain string
// comparison is the whole check.
export function diffSkills(names) {
  return names.map((name) => {
    const srcFile = path.join(srcRoot, name, 'SKILL.md');
    if (!fs.existsSync(srcFile)) return { name, status: 'skipped', reason: 'no SKILL.md' };
    const destFile = path.join(destRoot, name, 'SKILL.md');
    if (!fs.existsSync(destFile)) return { name, status: 'missing' };
    const src = fs.readFileSync(srcFile, 'utf8');
    const dest = fs.readFileSync(destFile, 'utf8');
    return { name, status: src === dest ? 'same' : 'drift' };
  });
}

export { listSkillDirs, copySkill, CORE, srcRoot, destRoot };

// Resolve the set of skill names an invocation (install or check) targets, using the same
// precedence in both modes: explicit names > --all > CORE default.
function resolveNames(args) {
  const all = args.includes('--all');
  const explicit = args.filter((a) => !a.startsWith('--'));
  const available = listSkillDirs(srcRoot);
  const names = explicit.length ? explicit : all ? available : CORE.filter((n) => available.includes(n));
  const missing = explicit.length ? explicit.filter((n) => !available.includes(n)) : [];
  return { names, available, missing };
}

function runInstall(args) {
  const { names, available, missing } = resolveNames(args);
  if (missing.length) {
    console.error(`Unknown skill(s): ${missing.join(', ')}\nAvailable: ${available.join(', ')}`);
    process.exit(1);
  }
  if (names.length === 0) {
    console.log(`No skills found under ${srcRoot}`);
    process.exit(0);
  }

  fs.mkdirSync(destRoot, { recursive: true });

  const results = names.map(copySkill);

  const installed = results.filter((r) => r.status === 'installed');
  const updated = results.filter((r) => r.status === 'updated');
  const unchanged = results.filter((r) => r.status === 'unchanged');
  const skipped = results.filter((r) => r.status === 'skipped');

  console.log(`install-skills: ${srcRoot} -> ${destRoot}`);
  console.log(`  installed: ${installed.length}${installed.length ? ' (' + installed.map((r) => r.name).join(', ') + ')' : ''}`);
  console.log(`  updated:   ${updated.length}${updated.length ? ' (' + updated.map((r) => r.name).join(', ') + ')' : ''}`);
  console.log(`  unchanged: ${unchanged.length}`);
  if (skipped.length) {
    console.log(`  skipped:   ${skipped.length} (${skipped.map((r) => `${r.name}: ${r.reason}`).join(', ')})`);
  }
  console.log(`  total skills processed: ${results.length}`);
}

function runCheck(args) {
  const requireInstall = args.includes('--require-install');

  // A completely bare host (no ~/.claude/skills at all) is a clean skip UNLESS the caller
  // asserts this host is supposed to have skills deployed (--require-install), mirroring
  // deploy-hooks.js's --check / --require-install split: a hosted CI runner with no ~/.claude
  // is not drift, but the self-hosted runner reporting the same thing IS the outage.
  if (!fs.existsSync(destRoot)) {
    console.log(`no-install ${destRoot} not found — skill parity check skipped`);
    if (requireInstall) {
      console.log('\nnothing installed on this host, but --require-install was passed — treating as drift');
      process.exit(1);
    }
    console.log('\nnothing installed on this host — nothing to check');
    process.exit(0);
  }

  const { names, available, missing } = resolveNames(args);
  if (missing.length) {
    console.error(`Unknown skill(s): ${missing.join(', ')}\nAvailable: ${available.join(', ')}`);
    process.exit(1);
  }

  const results = diffSkills(names);
  let drift = 0;
  for (const r of results) {
    if (r.status === 'same') continue;
    drift++;
    console.log(`${r.status.padEnd(10)} ${r.name}${r.reason ? `  (${r.reason})` : ''}`);
  }

  console.log(drift
    ? `\n${drift} of ${results.length} skill(s) drifted or missing — run: node tools/install-skills.js`
    : `in sync — all ${results.length} checked skill(s) match the repo`);
  process.exit(drift ? 1 : 0);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--check')) runCheck(args.filter((a) => a !== '--check'));
  else runInstall(args);
}

if (isMainModule(import.meta.url)) main();
