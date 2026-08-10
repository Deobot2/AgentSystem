#!/usr/bin/env node
/**
 * task-scratchpad.js — per-task shared scratchpad for multi-agent coordination
 *
 * Project slug is derived from CWD git remote (origin URL) or --project flag.
 * Path: ~/agent-memory/nexus/tasks/<project-slug>/issue-<N>/scratchpad.md
 *
 * Usage:
 *   --init    --issue=<N> --workers=<list> [--project=<slug>]
 *   --write   --issue=<N> --agent=<name> --message="<text>" [--project=<slug>]
 *   --read    --issue=<N> [--project=<slug>]
 *   --close   --issue=<N> [--project=<slug>]
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { isMainModule } from './is-main.js';

function main() {

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.length ? v.join('=') : true];
    })
);

const issueN  = args.issue;
const agent   = args.agent   || 'unknown';
const message = args.message || '';
const workers = args.workers || '';

if (!issueN) {
  console.error('--issue=<N> is required');
  process.exit(1);
}

function deriveProjectSlug() {
  if (args.project) return args.project;
  try {
    const remote = execSync('git remote get-url origin', { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
    const match = remote.match(/[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (match) return match[2].toLowerCase().replace(/[^a-z0-9-]/g, '-');
  } catch {}
  return basename(process.cwd()).toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

const projectSlug = deriveProjectSlug();
const nexusDir    = process.env.AGENT_MEMORY_ROOT || join(homedir(), 'agent-memory', 'nexus');
const tasksDir    = join(nexusDir, 'tasks', projectSlug, `issue-${issueN}`);
const archiveBase = join(nexusDir, 'tasks', 'archive', projectSlug);
const scratchpad  = join(tasksDir, 'scratchpad.md');

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function init() {
  mkdirSync(tasksDir, { recursive: true });
  const header = [
    `# Scratchpad — ${projectSlug} issue #${issueN}`,
    ``,
    `**Initialized:** ${timestamp()}`,
    `**Workers:** ${workers}`,
    `**Project:** ${projectSlug}`,
    ``,
    `---`,
    ``,
  ].join('\n');
  writeFileSync(scratchpad, header, 'utf8');
  console.log(`Initialized: ${scratchpad}`);
}

function write() {
  if (!existsSync(scratchpad)) {
    console.error(`Scratchpad not found. Run --init first: ${scratchpad}`);
    process.exit(1);
  }
  const entry = `\n### [${timestamp()}] ${agent}\n\n${message}\n`;
  appendFileSync(scratchpad, entry, 'utf8');
  console.log(`Written to scratchpad (${projectSlug} #${issueN})`);
}

function read() {
  if (!existsSync(scratchpad)) {
    console.log(`No scratchpad found for ${projectSlug} issue #${issueN}`);
    return;
  }
  process.stdout.write(readFileSync(scratchpad, 'utf8'));
}

function close() {
  if (!existsSync(tasksDir)) {
    console.error(`No scratchpad to close: ${tasksDir}`);
    process.exit(1);
  }
  mkdirSync(archiveBase, { recursive: true });
  const dest = join(archiveBase, `issue-${issueN}-${Date.now()}`);
  renameSync(tasksDir, dest);
  console.log(`Closed and archived to: ${dest}`);
}

if      (args.init)  init();
else if (args.write) write();
else if (args.read)  read();
else if (args.close) close();
else {
  console.error('Specify --init, --write, --read, or --close');
  process.exit(1);
}

}

if (isMainModule(import.meta.url)) main();
