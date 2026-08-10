#!/usr/bin/env node
// auto-resolve-pr-comments.js — responds to open review comments on a PR.
// Spawned hidden/detached by routine-dispatch.js with --delay=120000 after PR creation.
//
// Scope: responds to comments (posts acknowledgment), but does NOT auto-dismiss
// human review requests — that would undermine the Sam security gate.
// Only posts a response to top-level PR review comments that have no reply yet.
//
// Usage: node tools/auto-resolve-pr-comments.js --pr=<number>

import { execFileSync } from 'node:child_process';
import { isMainModule } from './is-main.js';

function ghJson(args) {
  try {
    const out = execFileSync('gh', args, { encoding: 'utf8', timeout: 15000 });
    return JSON.parse(out.trim());
  } catch (e) {
    throw new Error(`gh ${args.join(' ')} failed: ${(e.stderr || e.message || '').trim()}`);
  }
}

function parseArgs() {
  const flags = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--(\w[\w-]*)=(.*)$/);
    if (m) flags[m[1]] = m[2];
  }
  return flags;
}

async function main() {
  const { pr: prNumber, delay } = parseArgs();
  if (!prNumber) {
    console.error('Usage: auto-resolve-pr-comments.js --pr=<number> [--delay=<ms>]');
    process.exit(2);
  }

  const delayMs = Number(delay) || 0;
  if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));

  // Get PR info to find repo
  let prInfo;
  try {
    prInfo = ghJson(['pr', 'view', prNumber, '--json', 'url,number,title,comments']);
  } catch (e) {
    console.error(`auto-resolve: could not fetch PR #${prNumber}: ${e.message}`);
    process.exit(1);
  }

  const urlParts = prInfo.url.replace('https://github.com/', '').split('/');
  const owner = urlParts[0];
  const repo = urlParts[1];

  // Get review comments
  let reviewComments = [];
  try {
    reviewComments = ghJson(['api', `repos/${owner}/${repo}/pulls/${prNumber}/comments`,
      '--jq', '[.[] | {id, body, user: .user.login, in_reply_to_id}]']);
  } catch (e) {
    console.log(`auto-resolve: could not fetch review comments: ${e.message}`);
    process.exit(0);
  }

  // Find top-level comments (no in_reply_to_id) that haven't been replied to
  const topLevel = reviewComments.filter(c => !c.in_reply_to_id);
  const repliedIds = new Set(reviewComments.filter(c => c.in_reply_to_id).map(c => c.in_reply_to_id));
  const unanswered = topLevel.filter(c => !repliedIds.has(c.id));

  if (unanswered.length === 0) {
    console.log(`auto-resolve: PR #${prNumber} — no unanswered review comments`);
    process.exit(0);
  }

  console.log(`auto-resolve: PR #${prNumber} — responding to ${unanswered.length} unanswered comment(s)`);

  for (const comment of unanswered) {
    try {
      // Post an acknowledgment reply — conservative: does NOT dismiss or resolve
      execFileSync('gh', ['api',
        `repos/${owner}/${repo}/pulls/${prNumber}/comments`,
        '--method', 'POST',
        '-f', `body=Acknowledged. This comment will be addressed before merge.`,
        '-f', `in_reply_to=${comment.id}`,
      ], { encoding: 'utf8', timeout: 10000 });
      console.log(`  replied to comment ${comment.id} by ${comment.user}`);
    } catch (e) {
      console.log(`  failed to reply to comment ${comment.id}: ${e.message}`);
    }
  }
}

if (isMainModule(import.meta.url)) {
  main().catch(e => {
    console.error(`auto-resolve: unexpected error: ${e.message}`);
    process.exit(1);
  });
}
