#!/usr/bin/env node
// sona-episodic-write.js — write a single episodic SONA entry to sona-patterns.md.
// Called detached from sona-writeback-hook.js (SubagentStop/Stop).
// Unlike sona-append.js, requires no --issue/--branch — designed for hook contexts.
//
// Usage: node tools/sona-episodic-write.js --task="..." --files="..." --outcome="..." --agent="..."

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { isMainModule } from './is-main.js';

function parseArgs() {
  const flags = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([\w-]+)=(.*)$/s);
    if (m) flags[m[1]] = m[2];
  }
  return flags;
}

function main() {
  const args = parseArgs();
  const task = (args.task || 'subagent task').slice(0, 120);
  const files = args.files || 'none';
  const outcome = args.outcome || 'unknown';
  const agent = args.agent || 'unknown';

  const sonaPath = join(homedir(), 'agent-memory', 'nexus', 'sona-patterns.md');

  let content = '';
  try {
    content = readFileSync(sonaPath, 'utf8');
  } catch {
    mkdirSync(dirname(sonaPath), { recursive: true });
  }

  const MARKER = '<!-- Agents: append new patterns below this line -->';
  if (!content.includes(MARKER)) {
    content = `# SONA Patterns — Cross-Agent Learning Bank

**Format:** Situation → Observation → Node → Action
**Agents write here** after completing significant tasks. Agents read this at startup for relevant patterns.

---

${MARKER}
`;
  }

  const date = new Date().toISOString().split('T')[0];
  const entry = `
### [episodic] — ${date} — ${agent}
**S:** subagent task completion
**O:** outcome=${outcome} | files=${files}
**N:** task="${task}"
**A:** ${outcome === 'done' ? 'task succeeded' : outcome === 'blocked' ? 'task blocked — check for missing context' : 'outcome unknown'} | success: ${outcome === 'done' ? 'yes' : 'no'}
`;

  content = content.replace(MARKER, `${MARKER}${entry}`);

  try {
    writeFileSync(sonaPath, content, 'utf8');
  } catch {
    // Non-fatal — file write failure should not crash anything.
    process.exit(0);
  }
}

if (isMainModule(import.meta.url)) main();
