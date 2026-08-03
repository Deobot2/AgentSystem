#!/usr/bin/env node
// human-needed.js — raise, ping, and resolve "a human must do this" alerts.
//
// Usage:
//   node tools/human-needed.js raise <key> --title "..." --why "..." [--action "..."]
//                                          [--label <extra>] [--assignee <user>] [--dry-run]
//   node tools/human-needed.js resolve <key> [--comment "..."] [--dry-run]
//   node tools/human-needed.js list [--json]
//
// The alert channel is a GitHub issue labelled `human-needed`, because that is the only channel
// this system already has that reaches a person when nobody is watching a terminal: it emails the
// hub inbox, shows up in Mission Control's /pipelines view, and survives a host reboot. There is
// no push endpoint on the webhook server (only the PWA shell's notificationclick), so inventing
// one here would add a secret and a delivery guarantee nobody maintains.
//
// `<key>` is a stable caller-chosen id (e.g. `daily-triage-skill-missing`), embedded in the issue
// body as an HTML comment marker. That is what makes this idempotent: a job that runs every day
// and stays blocked must not open 365 issues. Re-raising an already-open alert adds a "still
// blocked" comment instead — at most one per PING_WINDOW_HOURS, so a job on a 15-minute loop does
// not bury the issue in noise either.
//
// Why a key marker rather than matching on the title: titles get edited by humans triaging the
// issue, and an edited title would orphan the alert and cause a duplicate on the next run.
//
// Exit codes: 0 success · 1 gh/API failure · 2 bad usage.

import { execFileSync } from 'node:child_process';
import { isMainModule } from './is-main.js';

const LABEL = 'human-needed';
const LABEL_COLOR = 'D93F0B';
const LABEL_DESC = 'Blocked on a human — no agent can complete this unattended';

// A still-blocked ping at most this often. 20h rather than 24h so a job that runs at a fixed
// daily time still pings every day: consecutive runs drift by a few minutes and a 24h window
// would swallow every second day.
export const PING_WINDOW_HOURS = 20;

export function markerFor(key) {
  return `<!-- human-needed:key=${key} -->`;
}

/** Find the open alert whose body carries this key's marker. Returns the issue or null. */
export function findByMarker(issues, key) {
  const marker = markerFor(key);
  return issues.find((i) => typeof i.body === 'string' && i.body.includes(marker)) || null;
}

/**
 * True when the last thing said on this alert is older than the ping window.
 *
 * `issueCreatedAt` counts as the first utterance, not just comments: an alert opened a minute ago
 * has said everything it has to say, and a second job hitting the same key (the watchdog's
 * scheduled run after a manual dispatch, say) must not immediately comment "still blocked" under
 * a brand-new issue. Without it the first day of any outage collects a redundant comment.
 *
 * `comments` are gh's `{ createdAt }` objects; order is not assumed.
 */
export function shouldPing(comments, now = new Date(), windowHours = PING_WINDOW_HOURS, issueCreatedAt = null) {
  const times = [...(comments || []).map((c) => c.createdAt), issueCreatedAt]
    .map((t) => Date.parse(t))
    .filter((t) => Number.isFinite(t));
  if (times.length === 0) return true;
  const newest = Math.max(...times);
  return now.getTime() - newest >= windowHours * 3600 * 1000;
}

export function buildBody({ key, why, action, source }) {
  const lines = [markerFor(key), ''];
  lines.push(why || '_No detail supplied._', '');
  if (action) {
    lines.push('**What a human needs to do**', '', action, '');
  }
  lines.push(
    `Raised by \`${source || 'human-needed.js'}\` at ${new Date().toISOString()}.`,
    '',
    `This alert is keyed \`${key}\`. Re-running the blocked job comments here rather than opening ` +
      `a duplicate, and closes this issue once the block clears — so leave the marker at the top ` +
      `of the body intact.`,
  );
  return lines.join('\n');
}

// ── gh plumbing ────────────────────────────────────────────────────────────────

function gh(args, { allowFail = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (allowFail) return null;
    const detail = (err.stderr || err.message || '').toString().trim();
    throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${detail}`);
  }
}

function ensureLabel() {
  // Idempotent: `label create` on an existing label exits non-zero, which is not an error here.
  gh(['label', 'create', LABEL, '--color', LABEL_COLOR, '--description', LABEL_DESC], { allowFail: true });
}

function openAlerts() {
  const out = gh(['issue', 'list', '--state', 'open', '--label', LABEL, '--limit', '100',
                  '--json', 'number,title,body,createdAt,url']);
  return JSON.parse(out || '[]');
}

function commentsOf(number) {
  const out = gh(['issue', 'view', String(number), '--json', 'comments'], { allowFail: true });
  if (!out) return [];
  try { return JSON.parse(out).comments || []; } catch { return []; }
}

// ── commands ───────────────────────────────────────────────────────────────────

export function raise({ key, title, why, action, extraLabels = [], assignee, source, dryRun }) {
  const body = buildBody({ key, why, action, source });
  if (dryRun) {
    console.log(`[dry-run] would ensure label ${LABEL} and raise/ping key=${key}`);
    console.log(`[dry-run] title: ${title}`);
    console.log(body);
    return { action: 'dry-run' };
  }
  ensureLabel();
  const existing = findByMarker(openAlerts(), key);

  if (!existing) {
    const args = ['issue', 'create', '--title', title, '--body', body, '--label', LABEL];
    for (const l of extraLabels) args.push('--label', l);
    if (assignee) args.push('--assignee', assignee);
    const url = (gh(args) || '').trim();
    console.log(`raised: ${url}`);
    return { action: 'created', url };
  }

  if (!shouldPing(commentsOf(existing.number), new Date(), PING_WINDOW_HOURS, existing.createdAt)) {
    console.log(`already open and pinged recently: ${existing.url}`);
    return { action: 'skipped', url: existing.url, number: existing.number };
  }
  gh(['issue', 'comment', String(existing.number), '--body',
      `Still blocked as of ${new Date().toISOString()}.${why ? `\n\n${why}` : ''}`]);
  console.log(`pinged: ${existing.url}`);
  return { action: 'pinged', url: existing.url, number: existing.number };
}

export function resolve({ key, comment, dryRun }) {
  if (dryRun) {
    console.log(`[dry-run] would close the open alert keyed ${key}`);
    return { action: 'dry-run' };
  }
  const existing = findByMarker(openAlerts(), key);
  if (!existing) {
    console.log(`no open alert keyed ${key} — nothing to resolve`);
    return { action: 'none' };
  }
  const body = comment || `Unblocked as of ${new Date().toISOString()} — closing automatically.`;
  gh(['issue', 'close', String(existing.number), '--comment', body]);
  console.log(`resolved: ${existing.url}`);
  return { action: 'closed', url: existing.url, number: existing.number };
}

export function list({ json } = {}) {
  const alerts = openAlerts();
  if (json) { console.log(JSON.stringify(alerts, null, 2)); return alerts; }
  if (alerts.length === 0) { console.log('No open human-needed alerts.'); return alerts; }
  console.log(`${alerts.length} open human-needed alert(s):\n`);
  for (const a of alerts) {
    const m = /<!-- human-needed:key=([^\s>]+) -->/.exec(a.body || '');
    console.log(`  #${a.number}  [${m ? m[1] : 'no-key'}]  ${a.title}`);
    console.log(`           ${a.url}`);
  }
  return alerts;
}

// ── CLI ────────────────────────────────────────────────────────────────────────

const USAGE = `Usage:
  node tools/human-needed.js raise <key> --title "..." --why "..." [--action "..."]
                                         [--label <extra>] [--assignee <user>] [--dry-run]
  node tools/human-needed.js resolve <key> [--comment "..."] [--dry-run]
  node tools/human-needed.js list [--json]`;

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const name = a.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) { flags[name] = true; }
      else { flags[name] = next; i++; }
    } else positional.push(a);
  }
  return { cmd, key: positional[0], flags };
}

if (isMainModule(import.meta.url)) {
  const { cmd, key, flags } = parseArgs(process.argv.slice(2));
  const dryRun = flags['dry-run'] === true || flags['dry-run'] === 'true';
  try {
    if (cmd === 'list') {
      list({ json: flags.json === true || flags.json === 'true' });
    } else if (cmd === 'raise') {
      if (!key || typeof flags.title !== 'string') {
        console.error(`raise needs <key> and --title\n${USAGE}`);
        process.exit(2);
      }
      raise({
        key,
        title: flags.title,
        why: typeof flags.why === 'string' ? flags.why : '',
        action: typeof flags.action === 'string' ? flags.action : '',
        extraLabels: typeof flags.label === 'string' ? [flags.label] : [],
        assignee: typeof flags.assignee === 'string' ? flags.assignee : null,
        source: process.env.GITHUB_WORKFLOW || process.env.HUMAN_NEEDED_SOURCE || 'human-needed.js',
        dryRun,
      });
    } else if (cmd === 'resolve') {
      if (!key) { console.error(`resolve needs <key>\n${USAGE}`); process.exit(2); }
      resolve({ key, comment: typeof flags.comment === 'string' ? flags.comment : '', dryRun });
    } else {
      console.error(USAGE);
      process.exit(2);
    }
  } catch (err) {
    // Deliberately exit 1, not 0: a caller that could not raise its alert must not look healthy.
    console.error(`human-needed: ${err.message}`);
    process.exit(1);
  }
}
