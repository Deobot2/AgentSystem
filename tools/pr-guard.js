#!/usr/bin/env node
// pr-guard.js — checks a GitHub PR is green and fully reviewed before allowing merge.
// Checks: (1) all CI checks pass, (2) zero unresolved review threads.
// No npm deps — uses gh CLI (must be authenticated) and Node.js builtins.
//
// Usage:
//   node tools/pr-guard.js <pr-number|pr-url>   — check a PR
//   node tools/pr-guard.js --help               — show usage
//
// Exit codes:
//   0 — PR is green (all checks pass, no unresolved threads)
//   1 — PR is not ready (details printed to stdout)
//   2 — Usage error or gh CLI failure

import { execFileSync } from 'node:child_process';
import { isMainModule } from './is-main.js';

function ghJson(args) {
  try {
    const out = execFileSync('gh', args, { encoding: 'utf8', timeout: 15000 });
    return JSON.parse(out.trim());
  } catch (e) {
    const msg = e.stderr || e.message || String(e);
    throw new Error(`gh ${args.join(' ')} failed: ${msg.trim()}`);
  }
}

// Trusted identity that sam-audit.yml's review-posting step authors as (it uses the
// workflow's built-in GITHUB_TOKEN via actions/github-script, which always creates
// content as this service account -- no human account or PAT can produce this identity).
const SAM_BOT_LOGIN = 'github-actions[bot]';

// Reviewer identity check (not just body text): submitting an "Approve" review does NOT
// require write/maintainer permission on GitHub -- any collaborator (or, on a public repo,
// any GitHub user) can leave an approving review with arbitrary body text. Checking body
// text alone lets anyone forge "Sam (CSO)" + "APPROVED:" and pass the gate (#112 follow-up
// finding from Sam's own audit of this file). Require BOTH the trusted bot identity AND the
// body markers sam-audit.yml actually posts.
//
// State is COMMENTED, not APPROVED: GitHub hard-blocks the built-in GITHUB_TOKEN from
// submitting an APPROVE review ("GitHub Actions is not permitted to approve pull requests"),
// so sam-audit.yml submits the approved verdict as a COMMENT review (see its createReview
// step). Requiring state === 'APPROVED' here made the gate unpassable for every approved PR
// (found on #172). Identity + body markers remain the anti-forgery check; a blocked verdict
// arrives as CHANGES_REQUESTED with a "BLOCKED:" body and never matches this.
function isSamApproval(review) {
  return !!review &&
    (review.state === 'APPROVED' || review.state === 'COMMENTED') &&
    !!review.user && review.user.type === 'Bot' && review.user.login === SAM_BOT_LOGIN &&
    typeof review.body === 'string' &&
    review.body.includes('Sam (CSO)') &&
    review.body.includes('APPROVED:');
}

export { isSamApproval };

function extractPrNumber(arg) {
  if (!arg) return null;
  // URL form: https://github.com/owner/repo/pull/123
  const urlMatch = String(arg).match(/\/pull\/(\d+)/);
  if (urlMatch) return urlMatch[1];
  // Plain number
  if (/^\d+$/.test(String(arg))) return String(arg);
  return null;
}

export async function checkPr(prArg) {
  const prNumber = extractPrNumber(prArg);
  if (!prNumber) {
    return { ok: false, error: `Invalid PR argument: ${prArg}` };
  }

  const results = { prNumber, checks: null, threads: null, ok: false, summary: [] };

  // 1. CI checks
  try {
    const checks = ghJson(['pr', 'checks', prNumber, '--json', 'name,state,bucket']);
    results.checks = checks;
    // bucket=pass means green. bucket=fail/pending/waiting means not ready.
    const failing = checks.filter(c => {
      const bucket = (c.bucket || '').toLowerCase();
      const state = (c.state || '').toLowerCase();
      if (bucket === 'pass') return false;
      if (bucket === 'skipping' || bucket === 'neutral') return false;
      if (state === 'success') return false;
      return true;
    });

    if (failing.length > 0) {
      results.summary.push(`CI: ${failing.length} check(s) not green:`);
      for (const c of failing.slice(0, 5)) {
        results.summary.push(`  - ${c.name}: state=${c.state} bucket=${c.bucket || 'unknown'}`);
      }
    } else {
      results.summary.push(`CI: ${checks.length} check(s) all green`);
    }
    results.checksOk = failing.length === 0;
  } catch (e) {
    results.summary.push(`CI checks: ${e.message}`);
    results.checksOk = false;
  }

  // 2. Unresolved review threads + explicit Sam (CSO) security-audit approval via gh api.
  // (#112) A generic "no CHANGES_REQUESTED" is NOT sufficient as the hard security gate — a PR
  // with zero reviews at all would otherwise pass. Require an actual APPROVE review whose body
  // is Sam's automated audit post (sam-audit.yml posts "**Sam (CSO)**" + "APPROVED:" on approval).
  try {
    // Get the repo from the PR
    const prInfo = ghJson(['pr', 'view', prNumber, '--json', 'url,number']);
    const urlParts = prInfo.url.replace('https://github.com/', '').split('/');
    const owner = urlParts[0];
    const repo = urlParts[1];

    const reviewsData = ghJson(['api', `repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
      '--jq', '[.[] | {state, user: {login: .user.login, type: .user.type}, body}]']);

    // Count unresolved: state = CHANGES_REQUESTED and not subsequently APPROVED
    const latestByUser = {};
    for (const r of reviewsData) {
      latestByUser[r.user.login] = r.state;
    }
    const changesRequested = Object.values(latestByUser).filter(s => s === 'CHANGES_REQUESTED');

    if (changesRequested.length > 0) {
      results.summary.push(`Reviews: ${changesRequested.length} reviewer(s) requested changes (not yet approved)`);
    } else {
      results.summary.push(`Reviews: no blocking change requests`);
    }
    results.threadsOk = changesRequested.length === 0;

    // Reviewer identity check (not just body text) -- see isSamApproval() below.
    const samApproval = reviewsData.find(isSamApproval);

    if (samApproval) {
      results.summary.push('Sam audit: APPROVED review found from trusted identity (github-actions[bot])');
    } else {
      results.summary.push('Sam audit: no APPROVED review from github-actions[bot] with Sam (CSO) markers found — sam-audit check must pass first');
    }
    results.samAuditOk = !!samApproval;
  } catch (e) {
    results.summary.push(`Review threads / Sam audit: ${e.message}`);
    results.threadsOk = false;
    results.samAuditOk = false;
  }

  results.ok = !!(results.checksOk && results.threadsOk && results.samAuditOk);
  return results;
}

function main() {
  const arg = process.argv[2];
  if (!arg || arg === '--help') {
    console.log('Usage: node tools/pr-guard.js <pr-number|pr-url>');
    console.log('  Exits 0 if CI green + no blocking reviews. Exits 1 if not ready.');
    process.exit(arg ? 0 : 2);
  }

  checkPr(arg).then(result => {
    if (result.error) {
      console.error(`pr-guard error: ${result.error}`);
      process.exit(2);
    }

    const statusLine = result.ok ? 'PASS' : 'FAIL';
    console.log(`pr-guard: PR #${result.prNumber} — ${statusLine}`);
    for (const line of result.summary) console.log(line);

    process.exit(result.ok ? 0 : 1);
  }).catch(e => {
    console.error(`pr-guard: unexpected error: ${e.message}`);
    process.exit(2);
  });
}

if (isMainModule(import.meta.url)) main();
