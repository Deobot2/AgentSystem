#!/usr/bin/env node
/**
 * decision-log.js — architectural decision record tool
 *
 * Decisions are cross-project and searchable when working on any repo.
 * File path: ~/agent-memory/nexus/decisions/YYYY-MM-DD-<project>-<slug>.md
 *
 * Usage:
 *   --write  --title="<t>" --decision="<d>" --rationale="<r>" --agent=<name> [--expires=180] [--project=<slug>]
 *   --search --query="<text>"
 *   --list   [--expired]
 *   --expire
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { isMainModule } from './is-main.js';

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.length ? v.join('=') : true];
    })
);

const nexusDir     = process.env.AGENT_MEMORY_ROOT || join(homedir(), 'agent-memory', 'nexus');
const decisionsDir = join(nexusDir, 'decisions');
const archiveDir   = join(nexusDir, 'decisions', 'archive');

function deriveProjectSlug() {
  if (args.project) return args.project;
  try {
    const remote = execSync('git remote get-url origin', { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
    const match = remote.match(/[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (match) return match[2].toLowerCase().replace(/[^a-z0-9-]/g, '-');
  } catch {}
  return 'unknown-project';
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function tokenize(text) {
  return [...new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean))];
}

function getDecisionFiles() {
  if (!existsSync(decisionsDir)) return [];
  return readdirSync(decisionsDir)
    .filter(f => f.endsWith('.md') && !statSync(join(decisionsDir, f)).isDirectory());
}

function write() {
  const title     = args.title     || '';
  const decision  = args.decision  || '';
  const rationale = args.rationale || '';
  const agent     = args.agent     || 'unknown';
  const expires   = parseInt(args.expires || '180', 10);

  if (!title || !decision) {
    console.error('--title and --decision are required');
    process.exit(1);
  }

  mkdirSync(decisionsDir, { recursive: true });

  const project     = deriveProjectSlug();
  const slug        = slugify(title);
  const date        = today();
  const expiresDate = new Date(Date.now() + expires * 86400000).toISOString().slice(0, 10);
  const filename    = `${date}-${project}-${slug}.md`;
  const filepath    = join(decisionsDir, filename);

  const content = [
    `# ${title}`,
    ``,
    `**Date:** ${date}`,
    `**Project:** ${project}`,
    `**Agent:** ${agent}`,
    `**Expires:** ${expiresDate}`,
    ``,
    `## Decision`,
    ``,
    decision,
    ``,
    `## Rationale`,
    ``,
    rationale,
    ``,
  ].join('\n');

  writeFileSync(filepath, content, 'utf8');
  console.log(`Decision written: ${filepath}`);
}

function search() {
  const query = args.query || '';
  if (!query) { console.error('--query is required'); process.exit(1); }

  const files = getDecisionFiles();
  if (files.length === 0) { process.stdout.write('[]'); return; }

  const queryTokens = tokenize(query);
  const results = files.map(f => {
    const content = readFileSync(join(decisionsDir, f), 'utf8');
    const tokens = tokenize(content);
    const overlap = queryTokens.filter(t => tokens.includes(t)).length;
    const score = overlap / (queryTokens.length || 1);
    const titleMatch = content.match(/^# (.+)/m);
    return {
      file: f,
      title: titleMatch ? titleMatch[1] : f,
      score,
      summary: content.slice(0, 300).replace(/\n/g, ' '),
    };
  }).filter(r => r.score > 0).sort((a, b) => b.score - a.score);

  process.stdout.write(JSON.stringify(results, null, 2));
}

function list() {
  const showExpired = args.expired === true;
  const files = getDecisionFiles();
  if (files.length === 0) { console.log('No decisions found.'); return; }

  const now = new Date();
  for (const f of files) {
    const content = readFileSync(join(decisionsDir, f), 'utf8');
    const titleMatch   = content.match(/^# (.+)/m);
    const expiresMatch = content.match(/\*\*Expires:\*\* (\S+)/);
    const projectMatch = content.match(/\*\*Project:\*\* (\S+)/);
    const title   = titleMatch   ? titleMatch[1]   : f;
    const expires = expiresMatch ? expiresMatch[1] : 'unknown';
    const project = projectMatch ? projectMatch[1] : 'unknown';
    const isExpired = expires !== 'unknown' && new Date(expires) < now;
    if (isExpired && !showExpired) continue;
    const tag = isExpired ? ' [EXPIRED]' : '';
    console.log(`${f}${tag}`);
    console.log(`  Title:   ${title}`);
    console.log(`  Project: ${project}`);
    console.log(`  Expires: ${expires}`);
    console.log('');
  }
}

function expire() {
  const files = getDecisionFiles();
  const now = new Date();
  let count = 0;
  mkdirSync(archiveDir, { recursive: true });

  for (const f of files) {
    const content = readFileSync(join(decisionsDir, f), 'utf8');
    const expiresMatch = content.match(/\*\*Expires:\*\* (\S+)/);
    if (!expiresMatch) continue;
    const expiry = new Date(expiresMatch[1]);
    if (expiry < now) {
      renameSync(join(decisionsDir, f), join(archiveDir, f));
      console.log(`Archived expired decision: ${f}`);
      count++;
    }
  }
  console.log(`${count} decision(s) archived.`);
}

function main() {
  if      (args.write)  write();
  else if (args.search) search();
  else if (args.list)   list();
  else if (args.expire) expire();
  else {
    console.error('Specify --write, --search, --list, or --expire');
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) main();
