#!/usr/bin/env node
// sona-append.js — append a SONA entry to ~/agent-memory/nexus/sona-patterns.md
// Usage: node tools/sona-append.js --issue=<N> --branch=<name> --agent=<name> --files=<comma-list> [--duration=<mins>]

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentMemoryRoot } from './graph/graph-lib.js';
import { isMainModule } from './is-main.js';

function parseArgs() {
  const args = {};
  process.argv.slice(2).forEach(arg => {
    const [key, val] = arg.startsWith('--') ? arg.slice(2).split('=') : [null, null];
    if (key) args[key] = val;
  });
  return args;
}

function main() {
  const args = parseArgs();

  // Validate required args
  if (!args.issue || !args.branch || !args.agent || !args.files) {
    console.error('Usage: node sona-append.js --issue=<N> --branch=<name> --agent=<name> --files=<comma-list> [--duration=<mins>]');
    console.error('Example: node sona-append.js --issue=44 --branch=fix-runner --agent=Jarvis --files=tools/setup-runner.ps1 --duration=15');
    process.exit(1);
  }

  const sonaPath = join(agentMemoryRoot(), 'nexus', 'sona-patterns.md');
  let content = '';

  // Read existing file if it exists
  try {
    content = readFileSync(sonaPath, 'utf8');
  } catch {
    // File doesn't exist, will create it
  }

  // Generate timestamp (ISO format, used in filename)
  const now = new Date();
  const timestamp = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const dateStr = timestamp;

  // Build entry
  const duration = args.duration || 'unknown';
  const filesStr = args.files.split(',').map(f => f.trim()).join('\n  - ');

  const entry = `
## SONA-${timestamp} | Issue #${args.issue} | Agent: ${args.agent}
- **Situation:** Branch \`${args.branch}\` merged for issue #${args.issue}
- **Outcome:** Files changed: ${args.files}
- **Notes:** Duration: ${duration} min
- **Action:** Review pattern for reuse`;

  // If file is empty or doesn't have the append marker, create basic structure
  if (!content.includes('<!-- Agents: append new patterns below this line -->')) {
    content = `# SONA Patterns — Cross-Agent Learning Bank

**Format:** Situation → Observation → Node → Action
**Agents write here** after completing significant tasks. Agents read this at startup for relevant patterns.
**Propagation:** patterns with success=yes are candidates for \`nexus/shared/\` if confidence > 0.8.

---

<!-- Agents: append new patterns below this line -->
`;
  }

  // Append entry
  content = content.replace(
    '<!-- Agents: append new patterns below this line -->',
    `<!-- Agents: append new patterns below this line -->${entry}`
  );

  // Write back
  writeFileSync(sonaPath, content, 'utf8');
  console.log(`appended SONA entry for issue #${args.issue}`);
}

if (isMainModule(import.meta.url)) main();
