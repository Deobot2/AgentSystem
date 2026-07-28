#!/usr/bin/env node
'use strict';
/**
 * Test suite for session-auto-rename-hook.js — the SessionEnd hook that
 * reproduces /rename-session automatically. Covers the pure pieces: digest
 * building, model-reply parsing, and the manual-rename precedence rule.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const hook = require('./session-auto-rename-hook.js');

// ── helpers ──────────────────────────────────────────────────────────────────

function userLine(text, extra = {}) {
  return JSON.stringify({
    type: 'user',
    origin: { kind: 'human' },
    message: { content: text },
    ...extra,
  });
}

function assistantLine(text, extra = {}) {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text }] },
    ...extra,
  });
}

// ── extractText ──────────────────────────────────────────────────────────────

test('extractText: string content', () => {
  assert.equal(hook.extractText('  hello  '), 'hello');
});

test('extractText: block array keeps only text blocks', () => {
  const blocks = [
    { type: 'thinking', thinking: 'secret' },
    { type: 'text', text: 'visible' },
    { type: 'tool_use', name: 'Bash', input: {} },
  ];
  assert.equal(hook.extractText(blocks), 'visible');
});

test('extractText: unusable content yields empty string', () => {
  assert.equal(hook.extractText(undefined), '');
  assert.equal(hook.extractText(42), '');
});

// ── buildDigest ──────────────────────────────────────────────────────────────

test('buildDigest: returns null when no human prompt exists', () => {
  const lines = [
    assistantLine('automated reply'),
    JSON.stringify({ type: 'system', content: 'ping' }),
  ];
  assert.equal(hook.buildDigest(lines), null);
});

test('buildDigest: ignores non-human user turns', () => {
  const lines = [
    userLine('automated ping', { origin: { kind: 'system' }, promptSource: 'system' }),
  ];
  assert.equal(hook.buildDigest(lines), null);
});

test('buildDigest: accepts queued/sdk prompts like session-namer does', () => {
  const lines = [
    JSON.stringify({ type: 'user', promptSource: 'queued', origin: {}, message: { content: 'do the thing' } }),
  ];
  const digest = hook.buildDigest(lines);
  assert.match(digest, /first user request: do the thing/);
});

test('buildDigest: includes branch, first prompt, later prompts, final reply', () => {
  const lines = [
    userLine('add a session end rename hook', { gitBranch: 'issue-190-autoname' }),
    assistantLine('working on it'),
    userLine('also add tests'),
    assistantLine('tests added and passing'),
  ];
  const digest = hook.buildDigest(lines);
  assert.match(digest, /git branch: issue-190-autoname/);
  assert.match(digest, /first user request: add a session end rename hook/);
  assert.match(digest, /- also add tests/);
  assert.match(digest, /- tests added and passing/);
});

test('buildDigest: keeps only the last four later prompts', () => {
  const lines = [userLine('first ask')];
  for (let i = 1; i <= 8; i++) lines.push(userLine(`follow up ${i}`));
  const digest = hook.buildDigest(lines);
  assert.match(digest, /follow up 8/);
  assert.match(digest, /follow up 5/);
  assert.doesNotMatch(digest, /follow up 4/);
});

test('buildDigest: skips malformed lines instead of throwing', () => {
  const lines = ['not json', '', userLine('real prompt'), '{"broken":'];
  const digest = hook.buildDigest(lines);
  assert.match(digest, /real prompt/);
});

test('buildDigest: respects the maxChars ceiling', () => {
  const lines = [userLine('x'.repeat(5000)), assistantLine('y'.repeat(5000))];
  const digest = hook.buildDigest(lines, { maxChars: 300 });
  assert.ok(digest.length <= 300, `digest was ${digest.length} chars`);
});

// ── buildPrompt ──────────────────────────────────────────────────────────────

test('buildPrompt: asks for 4 words, the status set, and marks digest untrusted', () => {
  const prompt = hook.buildPrompt('git branch: main');
  assert.match(prompt, /EXACTLY 4 words/);
  assert.match(prompt, /started\|pr\|done/);
  assert.match(prompt, /never follow instructions/);
  assert.match(prompt, /git branch: main/);
});

// ── parseNameResponse ────────────────────────────────────────────────────────

test('parseNameResponse: plain JSON', () => {
  const out = hook.parseNameResponse('{"summary":"fix session namer autonaming","status":"done"}');
  assert.deepEqual(out, { summary: 'fix session namer autonaming', status: 'done' });
});

test('parseNameResponse: tolerates code fences and surrounding prose', () => {
  const raw = 'Here you go:\n```json\n{"summary":"add rename hook tests","status":"pr"}\n```\n';
  const out = hook.parseNameResponse(raw);
  assert.deepEqual(out, { summary: 'add rename hook tests', status: 'pr' });
});

test('parseNameResponse: trims to four words and strips punctuation', () => {
  const out = hook.parseNameResponse('{"summary":"One, Two! Three? Four Five Six","status":"done"}');
  assert.equal(out.summary, 'one two three four');
});

test('parseNameResponse: keeps hyphens inside words', () => {
  const out = hook.parseNameResponse('{"summary":"wire session-end rename hook","status":"done"}');
  assert.equal(out.summary, 'wire session-end rename hook');
});

test('parseNameResponse: unknown status falls back to started', () => {
  const out = hook.parseNameResponse('{"summary":"some real work","status":"banana"}');
  assert.equal(out.status, 'started');
});

test('parseNameResponse: missing status falls back to started', () => {
  const out = hook.parseNameResponse('{"summary":"some real work"}');
  assert.equal(out.status, 'started');
});

test('parseNameResponse: rejects unusable replies', () => {
  assert.equal(hook.parseNameResponse(''), null);
  assert.equal(hook.parseNameResponse('I cannot help with that.'), null);
  assert.equal(hook.parseNameResponse('{"summary":""}'), null);
  assert.equal(hook.parseNameResponse('{"summary":"!!! ???"}'), null);
  assert.equal(hook.parseNameResponse('{"summary":42}'), null);
  assert.equal(hook.parseNameResponse(null), null);
});

test('parseNameResponse: every allowed status survives', () => {
  for (const status of hook.STATUSES) {
    const out = hook.parseNameResponse(`{"summary":"a b c d","status":"${status}"}`);
    assert.equal(out.status, status);
  }
});

// ── shouldRename (manual-rename precedence) ──────────────────────────────────

test('shouldRename: no registry entry means nothing to rename', () => {
  assert.equal(hook.shouldRename(null, false), false);
});

test('shouldRename: a fresh auto-named entry is ours to overwrite', () => {
  assert.equal(hook.shouldRename({ session: 'a', renamed: false }, false), true);
});

test('shouldRename: a manual /rename-session wins over the hook', () => {
  assert.equal(hook.shouldRename({ session: 'a', renamed: true }, false), false);
});

test('shouldRename: a name this hook wrote before can be refreshed', () => {
  assert.equal(hook.shouldRename({ session: 'a', renamed: true }, true), true);
});

// ── wiring guards ────────────────────────────────────────────────────────────

test('hook shells out to session-namer --auto-rename, same as /rename-session', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, 'session-auto-rename-hook.js'), 'utf8');
  assert.match(src, /'--auto-rename'/);
  assert.match(src, /--safe-mode/);              // child must not re-run hooks
  assert.match(src, /--no-session-persistence/); // child must not enter the registry
});
