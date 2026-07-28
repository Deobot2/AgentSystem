// test_memory_lookup.js — tests for fuzzy memory recall tool (issue #37)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

function tmpMemoryDir(agent) {
  const d = join(tmpdir(), `memory-test-${Date.now()}`, agent);
  mkdirSync(d, { recursive: true });
  return d;
}

function writeMemoryFile(dir, filename, keywords, body) {
  const content = `---\nname: ${filename.replace('.md', '')}\ndescription: test memory\nmetadata:\n  type: user\nrelevance_keywords: [${keywords.join(', ')}]\n---\n\n${body}\n`;
  writeFileSync(join(dir, filename), content, 'utf8');
}

function runLookup(memDir, agent, keywords, extraFlags = []) {
  try {
    const result = execFileSync(
      process.execPath,
      [
        join(process.cwd(), 'tools', 'memory-lookup.js'),
        agent,
        ...keywords,
        '--json',
        `--memory-root=${memDir}`,
        ...extraFlags,
      ],
      { encoding: 'utf8', cwd: process.cwd() }
    );
    return JSON.parse(result);
  } catch (e) {
    return [];
  }
}

test('memory-lookup: exact keyword match returns file', () => {
  const dir = tmpMemoryDir('TestAgent');
  writeMemoryFile(dir, 'auth.md', ['auth', 'jwt'], 'JWT auth patterns.');
  writeMemoryFile(dir, 'deploy.md', ['deploy', 'ci'], 'Deployment notes.');

  const results = runLookup(dir, 'TestAgent', ['auth'], [`--memory-root=${dir}`]);
  assert.ok(results.length >= 1, 'Should find at least one match');
  assert.ok(results[0].file === 'auth.md', `Expected auth.md first, got ${results[0]?.file}`);
  rmSync(join(dir, '..'), { recursive: true });
});

test('memory-lookup: synonym expansion finds file without exact keyword', () => {
  const dir = tmpMemoryDir('TestAgent');
  // File has "auth" in keywords, but we query "credential" (synonym)
  writeMemoryFile(dir, 'auth.md', ['auth', 'token'], 'Authentication patterns and token handling.');
  writeMemoryFile(dir, 'deploy.md', ['deploy'], 'Deployment notes only.');

  const results = runLookup(dir, 'TestAgent', ['credential'], [`--memory-root=${dir}`]);
  assert.ok(results.length >= 1, 'Should find auth.md via synonym expansion');
  const authResult = results.find(r => r.file === 'auth.md');
  assert.ok(authResult, 'auth.md should be in results via credential→auth synonym');
  rmSync(join(dir, '..'), { recursive: true });
});

test('memory-lookup: "bearer credential refresh" finds jwt/auth file', () => {
  const dir = tmpMemoryDir('TestAgent');
  // This is the exact scenario from issue #37 — no overlap without synonym expansion
  writeMemoryFile(dir, 'jwt-patterns.md', ['auth', 'jwt', 'token'], 'JWT token refresh patterns. Auth retry on 401.');
  writeMemoryFile(dir, 'unrelated.md', ['deploy', 'ci'], 'CI/CD deployment notes.');

  const results = runLookup(dir, 'TestAgent', ['bearer', 'credential', 'refresh'], [`--memory-root=${dir}`]);
  const jwtResult = results.find(r => r.file === 'jwt-patterns.md');
  assert.ok(jwtResult, 'jwt-patterns.md should be found for "bearer credential refresh" query');
  rmSync(join(dir, '..'), { recursive: true });
});

test('memory-lookup: returns top N results', () => {
  const dir = tmpMemoryDir('TestAgent');
  for (let i = 0; i < 8; i++) {
    writeMemoryFile(dir, `file-${i}.md`, ['auth'], `Auth content ${i}`);
  }
  const results = runLookup(dir, 'TestAgent', ['auth'], [`--memory-root=${dir}`, '--top=3']);
  assert.ok(results.length <= 3, `Should return at most 3, got ${results.length}`);
  rmSync(join(dir, '..'), { recursive: true });
});

test('memory-lookup: no match returns empty array', () => {
  const dir = tmpMemoryDir('TestAgent');
  writeMemoryFile(dir, 'deploy.md', ['deploy', 'ci'], 'Deployment notes.');
  const results = runLookup(dir, 'TestAgent', ['quantum', 'physics'], [`--memory-root=${dir}`]);
  assert.equal(results.length, 0);
  rmSync(join(dir, '..'), { recursive: true });
});

// Every test above passes --memory-root explicitly, so the DEFAULT path was never
// exercised. It pointed at <root>/<agent>, a directory the system has never
// created — real nodes live at <root>/nexus/agent-brain/<agent>/nodes. Result:
// every default-path lookup silently found nothing.
test('memory-lookup: default path resolves to nexus/agent-brain/<agent>/nodes', () => {
  const root = join(tmpdir(), `memory-default-${process.pid}`);
  const nodes = join(root, 'nexus', 'agent-brain', 'testagent', 'nodes');
  mkdirSync(nodes, { recursive: true });
  writeMemoryFile(nodes, 'auth.md', ['auth', 'jwt'], 'JWT auth patterns.');

  const out = execFileSync(
    process.execPath,
    [join(process.cwd(), 'tools', 'memory-lookup.js'), 'testagent', 'auth', '--json'],
    { encoding: 'utf8', cwd: process.cwd(), env: { ...process.env, AGENT_MEMORY_ROOT: root } }
  );
  const results = JSON.parse(out);
  rmSync(root, { recursive: true, force: true });

  assert.equal(results.length, 1, 'default path did not find the agent-brain node');
  assert.equal(results[0].file, 'auth.md');
});
