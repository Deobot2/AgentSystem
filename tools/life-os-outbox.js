#!/usr/bin/env node
// life-os-outbox.js — deferred outbound messages for the daily triage.
//
// Usage:
//   node tools/life-os-outbox.js draft --chat <id> --network <name> --to <label> --body <text>
//   node tools/life-os-outbox.js list [--json]        # everything pending, with due state
//   node tools/life-os-outbox.js due [--json]         # only what is eligible to send now
//   node tools/life-os-outbox.js cancel <id> [--reason "..."]
//   node tools/life-os-outbox.js mark-sent <id>       # after the send actually succeeds
//
// WHY DEFERRED RATHER THAN IMMEDIATE
//
// A sent message is the one thing this pipeline does that cannot be undone, and it lands on a third
// party. Everything else it produces is reviewable after the fact: a draft PR sits there, a closeout
// is a file. So sending gets a veto window instead of an approval step — the run drafts, the 08:00
// closeout shows the full text, and the NEXT run sends whatever has not been cancelled.
//
// That buys the thing an unattended job otherwise cannot have: a human in the loop, without a human
// being awake. Cost is a day of latency, which for a morning digest is the right trade.
//
// Cancelling is deliberately a file operation — `cancel`, or just delete the .json. No service to
// be up, nothing to authenticate, works from any shell or a file manager on a phone over ssh.
//
// The hold is measured from `createdAt`, not "one run ago": two runs on the same morning (a manual
// dispatch plus the 07:00 cron) must not collapse the window to minutes.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { isMainModule } from './is-main.js';

const HOME = process.env.HOME || homedir();
const LIFE = process.env.LIFE_REPO || join(HOME, 'life');
const OUTBOX = join(LIFE, 'outbox');
const PENDING = join(OUTBOX, 'pending');
const SENT = join(OUTBOX, 'sent');
const CANCELLED = join(OUTBOX, 'cancelled');

/** Minimum time between drafting and sending. */
export const HOLD_HOURS = 12;

// Where the draft ALSO gets placed, so it is reviewable in context rather than only in a file.
// `PATCH /v1/chats/{id}` with a `draft` field puts the text straight in that chat's composer in
// Beeper, on every device. Two things make this the right surface:
//   - Beeper refuses a non-empty draft when a draft already exists, so it cannot overwrite
//     something Nathan is mid-way through typing. Failing there is correct, not an error.
//   - It is REST, not MCP: the MCP server exposes read/send/reminders but no draft tool, so this
//     needs a bearer token (Beeper: Settings -> Integrations -> "+"). Without BEEPER_ACCESS_TOKEN
//     the outbox still works exactly as before and the closeout stays the review surface.
const BEEPER_BASE = (process.env.BEEPER_API_URL || 'http://localhost:23373').replace(/\/$/, '');
const BEEPER_TOKEN = process.env.BEEPER_ACCESS_TOKEN || '';

/**
 * Put `body` in the chat's Beeper composer. Returns a short status string; never throws, because a
 * failure here must not lose the draft — the outbox file is the source of truth either way.
 */
export function pushDraftToBeeper(chatID, body, { base = BEEPER_BASE, token = BEEPER_TOKEN, exec = execFileSync } = {}) {
  if (!token) return 'skipped: no BEEPER_ACCESS_TOKEN';
  try {
    const out = exec('curl', [
      '-s', '-m', '10', '-o', '/dev/null', '-w', '%{http_code}',
      '-X', 'PATCH', `${base}/v1/chats/${encodeURIComponent(chatID)}`,
      '-H', 'Content-Type: application/json',
      '-H', `Authorization: Bearer ${token}`,
      // `draft` is an OBJECT, not a string: sending {"draft":"text"} returns
      // VALIDATION_ERROR "expected object, received string". Note also that an unknown key such as
      // {"draftText":"..."} returns 200 while doing nothing at all, so a 2xx here is not by itself
      // proof the draft landed — the shape has to be right.
      '--data-binary', JSON.stringify({ draft: body === null ? null : { text: body } }),
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (out.startsWith('2')) return 'placed in Beeper';
    // 409/400 is the documented refusal when a draft already exists. Leave theirs alone.
    if (out === '409' || out === '400') return `not placed (HTTP ${out}) — an existing draft was left untouched`;
    if (out === '401' || out === '403') return `not placed (HTTP ${out}) — token rejected`;
    return `not placed (HTTP ${out})`;
  } catch (err) {
    return `not placed (${(err.message || 'curl failed').slice(0, 60)})`;
  }
}

function ensureDirs() {
  for (const d of [PENDING, SENT, CANCELLED]) mkdirSync(d, { recursive: true });
}

/** True when a draft has sat long enough to be sent. */
export function isDue(entry, now = new Date(), holdHours = HOLD_HOURS) {
  const created = Date.parse(entry.createdAt);
  if (!Number.isFinite(created)) return false; // unparseable → never auto-send
  return now.getTime() - created >= holdHours * 3600 * 1000;
}

/**
 * Validate a draft before it can be written. A malformed entry must fail at draft time, in a run a
 * human will read the closeout of — not at send time in a later run nobody is watching.
 */
export function validateDraft(d) {
  const errs = [];
  if (!d.chat) errs.push('chat is required (the Beeper chatID)');
  if (!d.network) errs.push('network is required');
  if (!d.body || !d.body.trim()) errs.push('body is required and cannot be blank');
  if (d.body && d.body.length > 4000) errs.push('body exceeds 4000 chars');
  return errs;
}

/**
 * Send-eligibility for a channel, read from config/outbound-channels.json.
 *
 * Enforced at SEND time, not only when drafting. That matters: flipping a channel to `draft-only`
 * must also stop anything already sitting in the queue for it, otherwise yesterday's drafts go out
 * under today's revoked policy. Unknown or unreadable config fails CLOSED — never send.
 */
export function channelMode(network, { configPath } = {}) {
  const p = configPath || join(new URL('..', import.meta.url).pathname, 'config', 'outbound-channels.json');
  try {
    const cfg = JSON.parse(readFileSync(p, 'utf8'));
    const c = (cfg.channels || {})[network];
    return c && c.mode === 'send' ? 'send' : 'draft-only';
  } catch {
    return 'draft-only';
  }
}

export function readPending() {
  ensureDirs();
  return readdirSync(PENDING)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try { return { ...JSON.parse(readFileSync(join(PENDING, f), 'utf8')), _file: f }; }
      catch { return { id: f.replace(/\.json$/, ''), _file: f, _malformed: true }; }
    });
}

export function draft({ chat, network, to, body, item }) {
  const errs = validateDraft({ chat, network, body });
  if (errs.length) throw new Error(`invalid draft: ${errs.join('; ')}`);
  ensureDirs();
  const id = randomUUID().slice(0, 8);
  const entry = {
    id,
    chat: String(chat),
    network,
    to: to || null,
    body,
    item: item || null,
    createdAt: new Date().toISOString(),
    sendsAfter: new Date(Date.now() + HOLD_HOURS * 3600 * 1000).toISOString(),
  };
  entry.beeperDraft = pushDraftToBeeper(entry.chat, body);
  writeFileSync(join(PENDING, `${id}.json`), JSON.stringify(entry, null, 2) + '\n');
  return entry;
}

function move(id, destDir, extra) {
  const src = join(PENDING, `${id}.json`);
  if (!existsSync(src)) throw new Error(`no pending draft with id ${id}`);
  const entry = { ...JSON.parse(readFileSync(src, 'utf8')), ...extra };
  mkdirSync(destDir, { recursive: true });
  writeFileSync(join(destDir, `${id}.json`), JSON.stringify(entry, null, 2) + '\n');
  unlinkSync(src);
  return entry;
}

export function cancel(id, reason) {
  return move(id, CANCELLED, { cancelledAt: new Date().toISOString(), reason: reason || null });
}

export function markSent(id) {
  return move(id, SENT, { sentAt: new Date().toISOString() });
}

// ── CLI ────────────────────────────────────────────────────────────────────────

const USAGE = `Usage:
  node tools/life-os-outbox.js draft --chat <id> --network <name> [--to <label>] --body <text> [--item <ref>]
  node tools/life-os-outbox.js list [--json]
  node tools/life-os-outbox.js due [--json]
  node tools/life-os-outbox.js cancel <id> [--reason "..."]
  node tools/life-os-outbox.js mark-sent <id>

Drafts wait ${HOLD_HOURS}h before becoming eligible to send. Cancel with the command above, or just
delete the file under $LIFE_REPO/outbox/pending/.`;

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = true;
      else { flags[a.slice(2)] = next; i++; }
    } else positional.push(a);
  }
  return { cmd, id: positional[0], flags };
}

/**
 * The label shown for a pending entry. Must agree with the same two gates `due` filters on
 * (isDue AND channelMode === 'send') — otherwise `list` can call something DUE that the send
 * gate will never actually release, which reads as "about to go out" or "sending is broken".
 */
export function stateLabel(entry, now = new Date(), { configPath } = {}) {
  if (!isDue(entry, now)) return `holds until ${entry.sendsAfter}`;
  if (channelMode(entry.network, { configPath }) === 'send') return 'DUE';
  return `held — ${entry.network} is draft-only`;
}

function show(entries, { json, configPath } = {}) {
  if (json) { console.log(JSON.stringify(entries, null, 2)); return; }
  if (!entries.length) { console.log('Outbox empty.'); return; }
  const now = new Date();
  for (const e of entries) {
    if (e._malformed) { console.log(`  [${e.id}] MALFORMED — will never send; delete or fix it`); continue; }
    const state = stateLabel(e, now, { configPath });
    console.log(`  [${e.id}] ${e.network} -> ${e.to || e.chat}  (${state})`);
    console.log(`        ${e.body.split('\n')[0].slice(0, 100)}${e.body.length > 100 ? '…' : ''}`);
  }
}

if (isMainModule(import.meta.url)) {
  const { cmd, id, flags } = parseArgs(process.argv.slice(2));
  const json = flags.json === true || flags.json === 'true';
  try {
    if (cmd === 'draft') {
      const e = draft({
        chat: flags.chat, network: flags.network, to: flags.to,
        body: typeof flags.body === 'string' ? flags.body : '', item: flags.item,
      });
      console.log(`drafted ${e.id} — sends after ${e.sendsAfter} unless cancelled`);
      console.log(`  Beeper composer: ${e.beeperDraft}`);
    } else if (cmd === 'list') {
      show(readPending(), { json });
    } else if (cmd === 'due') {
      // Both gates: the hold has expired AND the channel is still send-eligible.
      show(readPending().filter((e) => !e._malformed && isDue(e) && channelMode(e.network) === 'send'), { json });
    } else if (cmd === 'cancel') {
      if (!id) { console.error(USAGE); process.exit(2); }
      cancel(id, typeof flags.reason === 'string' ? flags.reason : null);
      console.log(`cancelled ${id}`);
    } else if (cmd === 'mark-sent') {
      if (!id) { console.error(USAGE); process.exit(2); }
      markSent(id);
      console.log(`marked ${id} sent`);
    } else {
      console.error(USAGE);
      process.exit(2);
    }
  } catch (err) {
    console.error(`outbox: ${err.message}`);
    process.exit(1);
  }
}
