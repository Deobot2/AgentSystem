#!/usr/bin/env node
// Copies skills/<name>/SKILL.md from this repo into ~/.claude/skills/<name>/SKILL.md.
// Node builtins only. Idempotent — safe to re-run any time skills change.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';

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
const CORE = ['verify-claim', 'replicate-bug', 'pr-ready', 'postmortem', 'refute'];

function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const explicit = args.filter((a) => !a.startsWith('--'));

  const available = listSkillDirs(srcRoot);
  const names = explicit.length ? explicit : all ? available : CORE.filter((n) => available.includes(n));

  const missing = names.filter((n) => !available.includes(n));
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

main();
