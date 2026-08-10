#!/usr/bin/env node
// agent-message.js — send structured inter-agent messages to inbox files
//
// Usage:
//   node tools/agent-message.js --from=Friday --to=Sam \
//     --subject="Pre-merge audit request" \
//     --action="Run security audit on branch feat/auth-refactor" \
//     --context="Auth middleware rewrite. Tests pass. PR #87." \
//     --links="https://github.com/Zene8/AgentSystem/pull/87" \
//     --priority=high
//
//   node tools/agent-message.js --from=Ultron --to=Friday \
//     --subject="API complete, needs arch review" \
//     --action="Review API shape in PR #91 before Sam audit" \
//     --context="Rate-limiting logic uncertain. Two approaches in PR — need decision." \
//     --priority=normal
//
//   node tools/agent-message.js --list --to=Friday   (print inbox)
//   node tools/agent-message.js --archive --to=Friday (archive read messages)
//
// Message appended to: ~/agent-memory/nexus/inbox/<To>.md (cross-CLI neutral path)
// Override with AGENT_MEMORY_ROOT env var.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { agentMemoryRoot } from './graph/graph-lib.js';
import { isMainModule } from './is-main.js';

const INBOX_ROOT = join(agentMemoryRoot(), 'nexus', 'inbox');

const VALID_AGENTS = [
  'Jarvis', 'Friday', 'Sam', 'Ultron', 'Pym', 'Leo',
  'Astra', 'Wanda', 'Threepio', 'Nat', 'r2d2',
];

const VALID_PRIORITIES = ['high', 'normal', 'low'];

// ── Normalize agent name (case-insensitive) ───────────────────────────────────

function normalizeAgent(name) {
  if (!name) return null;
  const found = VALID_AGENTS.find(a => a.toLowerCase() === name.toLowerCase());
  return found || null;
}

// ── Inbox path ────────────────────────────────────────────────────────────────

function inboxPath(agent) {
  return join(INBOX_ROOT, `${agent}.md`);
}

function ensureInbox(agent) {
  mkdirSync(INBOX_ROOT, { recursive: true });
  const p = inboxPath(agent);
  if (!existsSync(p)) {
    writeFileSync(p, `# ${agent} Inbox\n\n<!-- Messages appended below -->\n`, 'utf8');
  }
  return p;
}

// ── Commands ──────────────────────────────────────────────────────────────────

function main() {
  // ── Arg parsing ───────────────────────────────────────────────────────────
  const args = process.argv.slice(2);
  const flags = {};
  for (const a of args) {
    if (a.startsWith('--')) {
      const eqIdx = a.indexOf('=');
      if (eqIdx === -1) {
        flags[a.slice(2)] = true;
      } else {
        flags[a.slice(2, eqIdx)] = a.slice(eqIdx + 1);
      }
    }
  }

  if (flags.list) {
    // Print inbox contents
    const to = normalizeAgent(flags.to);
    if (!to) {
      console.error(`--to required for --list. Valid agents: ${VALID_AGENTS.join(', ')}`);
      process.exit(1);
    }
    const p = inboxPath(to);
    if (!existsSync(p)) {
      console.log(`${to} inbox is empty.`);
    } else {
      console.log(readFileSync(p, 'utf8'));
    }
    process.exit(0);
  }

  if (flags.archive) {
    // Archive current inbox for agent
    const to = normalizeAgent(flags.to);
    if (!to) {
      console.error(`--to required for --archive`);
      process.exit(1);
    }
    const p = inboxPath(to);
    if (!existsSync(p)) {
      console.log(`${to} has no inbox to archive.`);
      process.exit(0);
    }
    const archiveDir = join(INBOX_ROOT, 'archive');
    mkdirSync(archiveDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const archivePath = join(archiveDir, `${to}-${date}-${Date.now()}.md`);
    renameSync(p, archivePath);
    // Recreate empty inbox
    writeFileSync(p, `# ${to} Inbox\n\n<!-- Messages appended below -->\n`, 'utf8');
    console.log(`Archived ${to} inbox → ${archivePath}`);
    process.exit(0);
  }

  // ── Send message ────────────────────────────────────────────────────────
  const from = normalizeAgent(flags.from);
  const to = normalizeAgent(flags.to);
  const subject = flags.subject;
  const action = flags.action;
  const context = flags.context || '';
  const links = flags.links || '';
  const priority = flags.priority || 'normal';

  // Validate
  const errors = [];
  if (!from) errors.push(`--from required. Valid: ${VALID_AGENTS.join(', ')}`);
  if (!to)   errors.push(`--to required. Valid: ${VALID_AGENTS.join(', ')}`);
  if (!subject) errors.push('--subject required');
  if (!action)  errors.push('--action required (what the recipient must do)');
  if (!VALID_PRIORITIES.includes(priority)) {
    errors.push(`--priority must be: ${VALID_PRIORITIES.join(' | ')}`);
  }
  if (errors.length > 0) {
    console.error('Validation errors:\n' + errors.map(e => `  • ${e}`).join('\n'));
    console.error(`
Usage: node tools/agent-message.js \\
  --from=Friday --to=Sam \\
  --subject="Pre-merge audit for PR #87" \\
  --action="Run security audit, check auth changes" \\
  --context="Auth middleware rewrite, tests passing" \\
  --links="https://github.com/Zene8/AgentSystem/pull/87" \\
  --priority=high`);
    process.exit(1);
  }

  // Format message block
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 5);

  const message = [
    `## ${dateStr} ${timeStr} from ${from} — ${subject}`,
    `**Priority:** ${priority}`,
    `**Action needed:** ${action}`,
    ...(context ? [`**Context:** ${context}`] : []),
    ...(links   ? [`**Links:** ${links}`]   : []),
    `---`,
    ``,
  ].join('\n');

  const p = ensureInbox(to);
  const current = readFileSync(p, 'utf8');
  writeFileSync(p, current + '\n' + message, 'utf8');

  console.log(`✓ Message sent → ${to} inbox`);
  console.log(`  From: ${from}`);
  console.log(`  Subject: ${subject}`);
  console.log(`  Priority: ${priority}`);
  if (priority === 'high') {
    console.log(`  ⚠  HIGH priority — recipient should act within 1 hour`);
  }
}

if (isMainModule(import.meta.url)) main();
