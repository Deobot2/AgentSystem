// life-os-outbox.test.js — the deferred-send window and its guards.
//
// A sent message is the only irreversible, third-party-visible thing this pipeline does, so the
// logic deciding WHEN one goes out is the part worth pinning down. The hold is measured from
// createdAt rather than "one run ago" specifically so two runs in one morning (a manual dispatch
// plus the 07:00 cron) cannot collapse the veto window to minutes.
//
// Run: node --test tools/life-os-outbox.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDue, validateDraft, HOLD_HOURS } from './life-os-outbox.js';

const at = (iso) => ({ createdAt: iso });

test('a fresh draft is not due', () => {
  const now = new Date('2026-08-05T08:00:00Z');
  assert.equal(isDue(at('2026-08-05T07:00:00Z'), now), false);
});

test('a draft older than the hold is due', () => {
  const now = new Date('2026-08-06T07:00:00Z');
  assert.equal(isDue(at('2026-08-05T07:00:00Z'), now), true, '24h later must be sendable');
});

test('two runs in one morning cannot collapse the window', () => {
  // The bug this guards: "send anything drafted before the previous run" would fire minutes later
  // when a manual dispatch precedes the 07:00 cron.
  const drafted = at('2026-08-05T03:18:00Z');   // manual dispatch
  const cronRun = new Date('2026-08-05T07:00:00Z'); // same morning
  assert.equal(isDue(drafted, cronRun), false, 'less than the hold has elapsed');
});

test('the boundary is inclusive at exactly the hold', () => {
  const created = '2026-08-05T00:00:00Z';
  const exactly = new Date(Date.parse(created) + HOLD_HOURS * 3600e3);
  assert.equal(isDue(at(created), exactly), true);
  assert.equal(isDue(at(created), new Date(exactly.getTime() - 1000)), false);
});

test('an unparseable createdAt never auto-sends', () => {
  // Fail closed: a corrupt file must not become a message to a third party.
  assert.equal(isDue(at('not-a-date'), new Date()), false);
  assert.equal(isDue({}, new Date()), false);
});

test('validateDraft rejects the ways a send could go wrong', () => {
  assert.deepEqual(validateDraft({ chat: '1', network: 'whatsapp', body: 'hi' }), []);
  assert.match(validateDraft({ network: 'x', body: 'hi' }).join(), /chat is required/);
  assert.match(validateDraft({ chat: '1', body: 'hi' }).join(), /network is required/);
  assert.match(validateDraft({ chat: '1', network: 'x', body: '   ' }).join(), /cannot be blank/);
  assert.match(validateDraft({ chat: '1', network: 'x' }).join(), /body is required/);
});

test('validateDraft caps body length', () => {
  assert.match(validateDraft({ chat: '1', network: 'x', body: 'a'.repeat(4001) }).join(), /exceeds 4000/);
});

// ── placing the draft in Beeper's composer ─────────────────────────────────────

import { pushDraftToBeeper } from './life-os-outbox.js';

const fakeCurl = (code) => (bin, args) => { fakeCurl.last = { bin, args }; return code; };

test('no token: skipped, and the draft is still kept', () => {
  assert.match(pushDraftToBeeper('244', 'hi', { token: '' }), /skipped: no BEEPER_ACCESS_TOKEN/);
});

test('2xx reports placed', () => {
  assert.equal(pushDraftToBeeper('244', 'hi', { token: 't', exec: fakeCurl('200') }), 'placed in Beeper');
});

test('an existing draft is left untouched rather than treated as an error', () => {
  // Beeper accepts a non-empty draft only when the current one is empty. Refusing is correct
  // behaviour — it means Nathan was mid-way through typing, and his text wins.
  assert.match(pushDraftToBeeper('244', 'hi', { token: 't', exec: fakeCurl('409') }), /left untouched/);
  assert.match(pushDraftToBeeper('244', 'hi', { token: 't', exec: fakeCurl('400') }), /left untouched/);
});

test('a rejected token says so specifically', () => {
  assert.match(pushDraftToBeeper('244', 'hi', { token: 'bad', exec: fakeCurl('401') }), /token rejected/);
});

test('it PATCHes the documented endpoint with a JSON draft field', () => {
  pushDraftToBeeper('2 44/x', 'hello', { token: 't', base: 'http://h:23373', exec: fakeCurl('200') });
  const args = fakeCurl.last.args;
  assert.ok(args.includes('PATCH'));
  assert.ok(args.some(a => a === 'http://h:23373/v1/chats/2%2044%2Fx'), 'chatID must be URL-encoded');
  assert.ok(args.some(a => a === JSON.stringify({ draft: { text: 'hello' } })));
});

test('curl blowing up never throws or loses the draft', () => {
  const boom = () => { throw new Error('curl: (7) connection refused'); };
  assert.match(pushDraftToBeeper('244', 'hi', { token: 't', exec: boom }), /not placed/);
});

test('draft is sent as an OBJECT, and null clears', () => {
  // The API rejects {"draft":"text"} with VALIDATION_ERROR "expected object, received string".
  // Worse, an unknown key like {"draftText":"..."} returns 200 and silently does nothing — so a
  // 2xx is not proof the draft landed. Verified live by reading the draft back off the chat.
  pushDraftToBeeper('9', 'hello', { token: 't', exec: fakeCurl('200') });
  assert.ok(fakeCurl.last.args.includes(JSON.stringify({ draft: { text: 'hello' } })));

  pushDraftToBeeper('9', null, { token: 't', exec: fakeCurl('200') });
  assert.ok(fakeCurl.last.args.includes(JSON.stringify({ draft: null })), 'null must clear, not wrap');
});

// ── channel mode is enforced at SEND time, not just at draft time ───────────────

import { channelMode } from './life-os-outbox.js';
import { writeFileSync as wf, mkdtempSync as mkd, rmSync as rms } from 'node:fs';
import { tmpdir as tmp } from 'node:os';
import { join as j } from 'node:path';

test('channelMode reads the config and only "send" counts as sendable', () => {
  const dir = mkd(j(tmp(), 'chanmode-'));
  try {
    const p = j(dir, 'outbound-channels.json');
    wf(p, JSON.stringify({ channels: { messenger: { mode: 'send' }, instagram: { mode: 'draft-only' } } }));
    assert.equal(channelMode('messenger', { configPath: p }), 'send');
    assert.equal(channelMode('instagram', { configPath: p }), 'draft-only');
  } finally { rms(dir, { recursive: true, force: true }); }
});

test('an unknown channel fails CLOSED', () => {
  const dir = mkd(j(tmp(), 'chanmode-'));
  try {
    const p = j(dir, 'outbound-channels.json');
    wf(p, JSON.stringify({ channels: {} }));
    assert.equal(channelMode('telegram', { configPath: p }), 'draft-only');
  } finally { rms(dir, { recursive: true, force: true }); }
});

test('an unreadable or malformed config fails CLOSED', () => {
  // Never send when policy cannot be determined.
  assert.equal(channelMode('messenger', { configPath: '/nonexistent/x.json' }), 'draft-only');
  const dir = mkd(j(tmp(), 'chanmode-'));
  try {
    const p = j(dir, 'outbound-channels.json');
    wf(p, 'not json at all');
    assert.equal(channelMode('messenger', { configPath: p }), 'draft-only');
  } finally { rms(dir, { recursive: true, force: true }); }
});

test('the live config is currently draft-only for every channel', () => {
  // Nathan's instruction: the pipeline composes, a human sends. If this ever fails, someone flipped
  // a channel to `send` — which is allowed, but should be a deliberate, visible change.
  const cfg = JSON.parse(readFileSync(new URL('../config/outbound-channels.json', import.meta.url), 'utf8'));
  const sending = Object.entries(cfg.channels).filter(([, v]) => v.mode === 'send').map(([k]) => k);
  assert.deepEqual(sending, [], `these channels would auto-send: ${sending.join(', ')}`);
});
