import test from 'node:test';
import assert from 'node:assert';
import { agyArgs } from '../tools/mission-control/agy-persistence.js';

test('agent name is passed through as --agent', () => {
  const args = agyArgs({ prompt: 'do thing', repoPath: '/tmp', agent: 'friday' });
  assert.deepStrictEqual(args.slice(0, 4), ['-p', 'do thing', '--agent', 'friday']);
});

test('no --agent when none given (agy default agent)', () => {
  assert.ok(!agyArgs({ prompt: 'p', repoPath: '/tmp' }).includes('--agent'));
});

test('resume uses --conversation <id>, never --continue', () => {
  const args = agyArgs({ prompt: 'p', repoPath: '/tmp', continueId: 'abc123' });
  assert.ok(!args.includes('--continue'), '--continue is boolean; an ID after it becomes a stray positional');
  assert.strictEqual(args[args.indexOf('--conversation') + 1], 'abc123');
});

test('no --model when the agent should use its own', () => {
  assert.ok(!agyArgs({ prompt: 'p', repoPath: '/tmp', agent: 'leo' }).includes('--model'));
});
