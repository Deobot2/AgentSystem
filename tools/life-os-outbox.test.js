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
