#!/usr/bin/env node
/**
 * Guards the backgrounded-claude argument shape.
 *
 * The CLI rejects `--bg -p` ("--bg and --print conflict"), so every dispatch path
 * that used -p exited non-zero without spawning anything. This test is what stops
 * the -p form coming back.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeBgArgs } from '../tools/mission-control/claude-args.js';

test('prompt is the positional, never -p', () => {
  const args = claudeBgArgs({ agent: 'r2d2', prompt: 'do thing' });
  assert.ok(!args.includes('-p'), '`--bg -p` is rejected by the CLI');
  assert.ok(!args.includes('--print'));
  assert.equal(args[args.length - 1], 'do thing', 'prompt must be the last positional');
});

test('agent and model are flags when given', () => {
  assert.deepEqual(
    claudeBgArgs({ agent: 'friday', prompt: 'p', model: 'claude-sonnet-5' }),
    ['--bg', '--agent', 'friday', '--model', 'claude-sonnet-5', 'p'],
  );
});

test('no --agent/--model when absent', () => {
  assert.deepEqual(claudeBgArgs({ prompt: 'p' }), ['--bg', 'p']);
});

test('resume puts --resume <id> before --bg', () => {
  const id = '11111111-2222-4333-8444-555555555555';
  const args = claudeBgArgs({ resumeId: id, prompt: 'answer' });
  assert.deepEqual(args, ['--resume', id, '--bg', 'answer']);
});

test('empty prompt throws rather than spawning a promptless session', () => {
  assert.throws(() => claudeBgArgs({ agent: 'r2d2' }), /prompt required/);
});
