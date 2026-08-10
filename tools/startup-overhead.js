#!/usr/bin/env node
/**
 * startup-overhead.js — measure fixed per-session context injection (#122).
 * Sums bytes/estimated tokens of: global CLAUDE.md, repo CLAUDE.md (cwd), the compiled
 * routines block, and a representative memory-context SessionStart output (--core=3).
 * Rough token estimate: chars / 4 (standard heuristic used elsewhere in this codebase).
 *
 * Usage:
 *   node tools/startup-overhead.js            # human-readable breakdown
 *   node tools/startup-overhead.js --json     # machine-readable, for session-cost.js --startup
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isMainModule } from './is-main.js';

const CHARS_PER_TOKEN = 4;
const estTokens = s => Math.ceil((s || '').length / CHARS_PER_TOKEN);

function safeRead(p) {
  try { return existsSync(p) ? readFileSync(p, 'utf8') : ''; } catch { return ''; }
}

function safeRun(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000 }); } catch { return ''; }
}

function main() {
const home = homedir();
const globalClaudeMd = safeRead(join(home, '.claude', 'CLAUDE.md'));
const repoClaudeMd = safeRead(join(process.cwd(), 'CLAUDE.md'));
const routinesGenerated = safeRead(join(process.cwd(), '.agents', 'rules', 'routines.generated.md'));

const toolsDir = join(process.cwd(), 'tools');
const memoryContextOut = existsSync(join(toolsDir, 'memory-context.js'))
  ? safeRun(process.execPath, [join(toolsDir, 'memory-context.js'), `--cwd=${process.cwd()}`, '--core=3'])
  : '';

const items = [
  { name: 'global CLAUDE.md', text: globalClaudeMd },
  { name: 'repo CLAUDE.md', text: repoClaudeMd },
  { name: 'routines.generated.md', text: routinesGenerated },
  { name: 'memory-context (SessionStart, core=3)', text: memoryContextOut },
];

const rows = items.map(i => ({ name: i.name, bytes: i.text.length, tokens: estTokens(i.text) }));
const totalBytes = rows.reduce((s, r) => s + r.bytes, 0);
const totalTokens = rows.reduce((s, r) => s + r.tokens, 0);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ rows, totalBytes, totalTokens }, null, 2));
} else {
  console.log('\nFixed per-session startup overhead (#122):');
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(40)} ${String(r.bytes).padStart(7)}B  ~${r.tokens} tok`);
  }
  console.log(`  ${'TOTAL'.padEnd(40)} ${String(totalBytes).padStart(7)}B  ~${totalTokens} tok`);
  console.log(`\n  Target: <=8000 tok. Current: ~${totalTokens} tok (${totalTokens <= 8000 ? 'OK' : 'OVER'}).`);
}
}

if (isMainModule(import.meta.url)) main();
