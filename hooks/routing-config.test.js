'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRoutingConfig, loadRoutingRules, defaultConfigPath } = require('./routing-config.js');

const SAMPLE = `
# comment line, ignored
infra | \\b(deploy|ci)\\b | Friday | claude @friday | Friday (engineering) | deploy, CI

security | \\b(security audit)\\b | Sam | claude @sam | Sam (security) | security audit
`;

test('parseRoutingConfig: skips blank lines and comments', () => {
  const rules = parseRoutingConfig(SAMPLE);
  assert.equal(rules.length, 2);
});

test('parseRoutingConfig: extracts all six columns per rule', () => {
  const rules = parseRoutingConfig(SAMPLE);
  assert.equal(rules[0].id, 'infra');
  assert.equal(rules[0].agentShort, 'Friday');
  assert.equal(rules[0].command, 'claude @friday');
  assert.equal(rules[0].hintDisplay, 'Friday (engineering)');
  assert.equal(rules[0].keywordsDisplay, 'deploy, CI');
  assert.ok(rules[0].regex.test('please deploy this'));
});

test('parseRoutingConfig: throws on malformed row (too few columns)', () => {
  assert.throws(() => parseRoutingConfig('bad | row | only-three'));
});

test('parseRoutingConfig: throws on invalid regex', () => {
  assert.throws(() => parseRoutingConfig('id | \\b(unterminated | Friday | cmd | hint | kw'));
});

test('loadRoutingRules: real config/routing.yml loads and parses without error', () => {
  const rules = loadRoutingRules(defaultConfigPath());
  assert.ok(rules.length >= 7);
  assert.ok(rules.every(r => r.id && r.regex && r.agentShort));
});

test('loadRoutingRules: returns [] for a nonexistent path', () => {
  assert.deepEqual(loadRoutingRules('/nonexistent/routing.yml'), []);
});

// #351: defaultConfigPath() used to return only the repo-relative candidate
// (__dirname/../config/routing.yml), which resolves to ~/.claude/config/routing.yml — a path
// that has never existed — when this file runs from its DEPLOYED location ~/.claude/hooks/.
// loadRoutingRules() swallowed the resulting ENOENT and returned [], so DOMAIN_RULES was
// permanently empty in production and every hint record carried hint:"none". Fix: search an
// ordered candidate list (env override, repo-relative, canonical checkout).
test('defaultConfigPath: prefers AGENT_ROUTING_CONFIG env override when it exists', () => {
  const real = defaultConfigPath();
  const prev = process.env.AGENT_ROUTING_CONFIG;
  process.env.AGENT_ROUTING_CONFIG = real;
  try {
    assert.equal(defaultConfigPath(), real);
  } finally {
    if (prev === undefined) delete process.env.AGENT_ROUTING_CONFIG;
    else process.env.AGENT_ROUTING_CONFIG = prev;
  }
});

test('defaultConfigPath: ignores an env override pointing at a nonexistent file', () => {
  const prev = process.env.AGENT_ROUTING_CONFIG;
  process.env.AGENT_ROUTING_CONFIG = '/nonexistent/routing-override.yml';
  try {
    const resolved = defaultConfigPath();
    assert.notEqual(resolved, '/nonexistent/routing-override.yml');
  } finally {
    if (prev === undefined) delete process.env.AGENT_ROUTING_CONFIG;
    else process.env.AGENT_ROUTING_CONFIG = prev;
  }
});

test('defaultConfigPath: falls back to a real, existing config/routing.yml with no env override', () => {
  const prev = process.env.AGENT_ROUTING_CONFIG;
  delete process.env.AGENT_ROUTING_CONFIG;
  try {
    const resolved = defaultConfigPath();
    assert.ok(require('fs').existsSync(resolved), `expected ${resolved} to exist`);
  } finally {
    if (prev !== undefined) process.env.AGENT_ROUTING_CONFIG = prev;
  }
});
