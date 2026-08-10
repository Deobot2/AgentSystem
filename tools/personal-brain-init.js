#!/usr/bin/env node
// personal-brain-init.js — initialize a user's personal brain file
// Usage: node tools/personal-brain-init.js --name="Your Name" --email="you@example.com"
// Idempotent — will not overwrite existing user-brain.md

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { agentMemoryRoot, emptyGraph, writeGraph } from './graph/graph-lib.js';
import { isMainModule } from './is-main.js';

function main() {
const args = process.argv.slice(2);
const flags = {};
for (const a of args) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    flags[k] = v ?? true;
  }
}

const name = flags.name || 'User';
const email = flags.email || '';
const brainDir = join(agentMemoryRoot(), 'nexus', 'personal-brain');
const brainPath = join(brainDir, 'user-brain.md');

if (existsSync(brainPath)) {
  console.log(`personal-brain-init: already exists at ${brainPath} — skipping (use --force to overwrite)`);
  if (!flags.force) process.exit(0);
}

mkdirSync(brainDir, { recursive: true });

const today = new Date().toISOString().slice(0, 10);
const content = `# ${name}'s Brain — Personal Context for All Agents

**Owner:** ${name}${email ? ` (${email})` : ''}
**Last updated:** ${today}
**Purpose:** Cross-project, cross-session context. Agents read this at startup. Update when preferences or goals change.

---

## Who I Am

<!-- Edit this file to add real bullets, e.g.:
- Your role — e.g., solo founder, developer, team lead
- Subscriptions: e.g., Claude Max, Gemini Pro, GitHub Copilot
- Primary repos: list your repos
- Communication style: e.g., direct, concise, no fluff
-->


---

## How I Like to Work

### Code style
- No comments unless the WHY is non-obvious
- TDD: tests first, code passes them
- SOLID principles throughout
- No premature abstraction
<!-- - Add your own code-style preferences here -->


### Workflow preferences
- Always branch from \`dev\`, never from \`main\`
- PR to \`dev\`, squash merge
- Conventional commits: \`feat:\`, \`fix:\`, \`refactor:\`, \`test:\`, \`chore:\`
- Complex task = 2 issues (design + implementation); simple = 1 issue
<!-- - Add your own workflow preferences here -->


### What I don't want
- Asking for confirmation on reversible actions
- Long summaries of what you just did
- Rebuilding things that already exist
<!-- - Add anything else you don't want here -->


---

## Current Goals (update regularly)

<!-- ### Project Name
- Goal 1
- Goal 2
-->


---

## Active Projects

| Repo | Status | Current Focus |
|------|--------|---------------|
<!-- | repo-name | Active | what's in progress | -->


---

## Technical Preferences

<!-- - Language: your primary language
- Other preferences -->


---

## Long-term Vision

[Describe what you want your agent team to accomplish over time]

---

## Session Notes (agents append here)

- ${today}: Personal brain initialized
`;

writeFileSync(brainPath, content, 'utf8');
console.log(`personal-brain-init: created ${brainPath}`);
console.log(`Edit this file to add your preferences and goals.`);
console.log(`Agents will read it at every session startup.`);

const graphPath = join(brainDir, 'graph.json');
if (!existsSync(graphPath)) {
  writeGraph(graphPath, emptyGraph('agent', 'personal-brain'));
  console.log('Created empty personal-brain graph.json — run personal-brain-split.js to populate.');
}
// After populating user-brain.md, run:
//   node tools/personal-brain-split.js
// to split into graph nodes.
}

if (isMainModule(import.meta.url)) main();
