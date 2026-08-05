// life-os-doctor.test.js — the evaluation logic, driven by synthetic facts.
//
// gatherFacts() reads the live host, so it is not what is tested here; evaluate() is pure by
// design precisely so the hard/soft/info classification can be pinned down. That classification
// is the whole value of the tool: get it wrong and you either block a run that would have worked,
// or alert every morning about a condition that is documented as normal.
//
// Run: node --test tools/life-os-doctor.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, parseMcpList, softAlertBody, chatSources, REQUIRED_CONNECTORS, TRIAGE_AGENT } from './life-os-doctor.js';

/** A host where everything is in place. */
function healthyFacts(overrides = {}) {
  return {
    devLink: '/home/u/dev/AgentSystem',
    devLinkTarget: '/home/u/AgentSystem',
    repo: '/home/u/AgentSystem',
    today: '2026-08-03',
    life: '/home/u/life',
    skillSizes: {
      'skills/daily-briefing/SKILL.md': 2221,
      'skills/daily-triage/SKILL.md': 10406,
      'skills/daily-briefing/portable-prompt.md': 3989,
      'skills/daily-briefing/handoff-schema.md': 2774,
    },
    installedSkills: { 'daily-briefing': true, 'daily-triage': true },
    lifeDirs: { briefings: true, closeouts: true },
    claudeOnPath: true,
    agentNames: ['Jarvis', 'Friday', 'Sam', 'r2d2'],
    knownRepoCount: 4,
    todaysBrief: null,
    todaysCloseout: null,
    connectors: Object.fromEntries(REQUIRED_CONNECTORS.map((c) => [c, 'connected'])),
    chat: [{ name: 'Beeper Desktop API', url: 'http://localhost:23373', up: true, code: '401' }],
    ...overrides,
  };
}

const find = (checks, name) => checks.find((c) => c.name === name);

test('a healthy host has no hard and no soft gaps', () => {
  const { hardGaps, softGaps } = evaluate(healthyFacts());
  assert.equal(hardGaps, 0);
  assert.equal(softGaps, 0);
});


test('a missing private skill is a hard gap and names the deploy script', () => {
  const facts = healthyFacts();
  facts.skillSizes['skills/daily-triage/SKILL.md'] = null;
  const { checks, hardGaps } = evaluate(facts);
  assert.equal(hardGaps, 1);
  const c = find(checks, 'skills/daily-triage/SKILL.md');
  assert.equal(c.level, 'hard');
  assert.match(c.fix, /deploy-private-skills\.sh/);
});

test('an empty skill file is treated as missing', () => {
  // A zero-byte SKILL.md is what a truncated tar-over-ssh leaves behind, and it fails at 07:00
  // in a much more confusing way than an absent file.
  const facts = healthyFacts();
  facts.skillSizes['skills/daily-triage/SKILL.md'] = 0;
  assert.equal(evaluate(facts).hardGaps, 1);
});

test('a missing ~/dev/AgentSystem symlink is hard, not cosmetic', () => {
  // STEP 4 of the skill runs its GitHub sweep in that directory, and routines.yml invokes every
  // weekly tool through it.
  const { checks, hardGaps } = evaluate(healthyFacts({ devLinkTarget: null }));
  assert.equal(hardGaps, 1);
  assert.equal(find(checks, '~/dev/AgentSystem symlink').level, 'hard');
});

test('no working copy reports the skills as unchecked rather than silently passing', () => {
  const { checks, hardGaps } = evaluate(healthyFacts({ repo: null, devLinkTarget: null, skillSizes: {} }));
  assert.ok(hardGaps >= 2);
  const c = find(checks, 'private life-OS skills');
  assert.equal(c.level, 'hard');
  assert.match(c.detail, /not checked/);
});

test('an unauthenticated connector is soft — the run degrades, it does not break', () => {
  const facts = healthyFacts();
  facts.connectors.Gmail = 'needs-auth';
  const { checks, hardGaps, softGaps } = evaluate(facts);
  assert.equal(hardGaps, 0, 'a connector gap must never block the 07:00 run');
  assert.equal(softGaps, 1);
  assert.equal(find(checks, 'connector: Gmail').level, 'soft');
});

test('a connector that is not configured at all is reported', () => {
  const facts = healthyFacts();
  delete facts.connectors.Notion;
  const { checks, softGaps } = evaluate(facts);
  assert.equal(softGaps, 1);
  assert.match(find(checks, 'connector: Notion').detail, /not configured/);
});

test('connectors outside the required set are ignored', () => {
  // claude.ai offers ~17 connectors; 13 of them are irrelevant to stage 2 and must not be
  // reported as gaps.
  const facts = healthyFacts();
  facts.connectors.Asana = 'needs-auth';
  facts.connectors.Figma = 'needs-auth';
  assert.equal(evaluate(facts).softGaps, 0);
});

test('--hard-only skipping the probe is info, not a failed probe', () => {
  const { checks, softGaps } = evaluate(healthyFacts({ connectors: 'skipped', beeper: null }));
  assert.equal(softGaps, 0, 'declining to probe is not evidence of a gap');
  assert.equal(find(checks, 'MCP connectors').level, 'info');
});

test('a probe that ran and failed IS a soft gap', () => {
  const { checks, softGaps } = evaluate(healthyFacts({ connectors: null }));
  assert.equal(softGaps, 1);
  assert.equal(find(checks, 'MCP connectors').level, 'soft');
});

test('an unparseable known-repos.json is hard', () => {
  // STEP 5 validates every item's repo slug against it; without it nothing dispatches.
  assert.equal(evaluate(healthyFacts({ knownRepoCount: null })).hardGaps, 1);
});

test('a missing claude CLI is hard', () => {
  assert.equal(evaluate(healthyFacts({ claudeOnPath: false })).hardGaps, 1);
});

test('missing LIFE_REPO dirs are hard', () => {
  const { hardGaps } = evaluate(healthyFacts({ lifeDirs: { briefings: false, closeouts: false } }));
  assert.equal(hardGaps, 2);
});

test('a missing stage-1 brief is not a gap at all', () => {
  // Stage 1 is an external Grok job with a documented fallback. Treating its absence as a gap
  // would fire an alert every day before 06:00.
  const { hardGaps, softGaps } = evaluate(healthyFacts({ todaysBrief: null }));
  assert.equal(hardGaps + softGaps, 0);
});

test('every failing check carries an actionable fix', () => {
  const facts = healthyFacts({
    devLinkTarget: null, claudeOnPath: false, knownRepoCount: null,
    lifeDirs: { briefings: false, closeouts: true },
    installedSkills: { 'daily-briefing': false, 'daily-triage': true },
  });
  facts.connectors.Gmail = 'needs-auth';
  for (const c of evaluate(facts).checks.filter((x) => !x.ok)) {
    assert.ok(c.fix && c.fix.length > 10, `${c.name} has no usable fix text`);
  }
});

// ── parseMcpList ───────────────────────────────────────────────────────────────

test('parseMcpList reads the real CLI output shape', () => {
  const out = parseMcpList([
    'Checking MCP server health…',
    '',
    'claude.ai Google Chat: https://chatmcp.googleapis.com/mcp/v1 - ✔ Connected',
    'claude.ai Lucid: https://mcp.lucid.app/mcp - ! Needs authentication',
    'claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected',
    'agentsystem: node /home/u/AgentSystem/tools/mcp-server.js - ✔ Connected',
  ].join('\n'));
  assert.equal(out['Google Chat'], 'connected');
  assert.equal(out.Lucid, 'needs-auth');
  assert.equal(out.Gmail, 'connected');
  assert.equal(out.agentsystem, 'connected', 'local stdio servers are listed too');
});

test('parseMcpList strips the claude.ai prefix so names match REQUIRED_CONNECTORS', () => {
  const out = parseMcpList('claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✔ Connected');
  assert.ok('Google Drive' in out);
  assert.ok(!('claude.ai Google Drive' in out));
});

test('parseMcpList tolerates noise and empty input', () => {
  assert.deepEqual(parseMcpList(''), {});
  assert.deepEqual(parseMcpList(null), {});
  assert.deepEqual(parseMcpList('no colon dash structure here'), {});
});

test('parseMcpList classifies an unrecognised status as failed, not connected', () => {
  const out = parseMcpList('claude.ai Box: https://mcp.box.com - ✘ Connection refused');
  assert.equal(out.Box, 'failed');
});

// ── alert body ─────────────────────────────────────────────────────────────────

test('softAlertBody lists only soft gaps, with their fixes', () => {
  const facts = healthyFacts({ claudeOnPath: false, beeper: false });
  facts.connectors.Gmail = 'needs-auth';
  const body = softAlertBody(evaluate(facts).checks);
  assert.match(body, /connector: Gmail/);
  assert.doesNotMatch(body, /claude CLI/, 'hard gaps belong in the preflight failure, not the coverage alert');
  assert.doesNotMatch(body, /Beeper/, 'info-level notes must stay out of the alert');
});




// ── chat source chain ──────────────────────────────────────────────────────────

const chat = (...s) => s;
const src = (name, up, code = '200') => ({ name, url: `http://${name}`, up, code });

test('chatSources: localhost by default, Matrix only when configured', () => {
  const bare = chatSources({});
  assert.equal(bare.length, 1);
  assert.match(bare[0].url, /localhost:23373/);

  const both = chatSources({ BEEPER_API_URL: 'http://100.82.195.75:23373', MATRIX_HOMESERVER: 'https://matrix.beeper.com' });
  assert.equal(both.length, 2);
  assert.equal(both[0].url, 'http://100.82.195.75:23373');
  assert.match(both[1].probe, /_matrix\/client\/versions$/);
});

test('chatSources: trailing slashes do not produce doubled paths', () => {
  const s = chatSources({ BEEPER_API_URL: 'http://x:23373/', MATRIX_HOMESERVER: 'https://m/' });
  assert.equal(s[0].probe, 'http://x:23373/v0/mcp');
  assert.equal(s[1].probe, 'https://m/_matrix/client/versions');
});

test('the fallback carries coverage when the primary is down', () => {
  // The whole point: a sleeping laptop must not read as "chat uncovered" when Beeper Cloud is up.
  const facts = healthyFacts({
    expectBeeper: true,
    chat: chat(src('Beeper Desktop API', false, '000'), src('Matrix homeserver', true)),
  });
  const { checks, softGaps } = evaluate(facts);
  assert.equal(softGaps, 0);
  const cov = find(checks, 'chat coverage');
  assert.equal(cov.ok, true);
  assert.match(cov.detail, /using Matrix homeserver/);
});

test('every source down IS a gap once chat is expected', () => {
  const facts = healthyFacts({
    expectBeeper: true,
    chat: chat(src('Beeper Desktop API', false, '000'), src('Matrix homeserver', false, '000')),
  });
  const { checks, softGaps } = evaluate(facts);
  assert.equal(softGaps, 1);
  assert.equal(find(checks, 'chat coverage').level, 'soft');
});

test('every source down is only a note when chat is not expected', () => {
  const facts = healthyFacts({ expectBeeper: false, chat: chat(src('Beeper Desktop API', false, '000')) });
  assert.equal(evaluate(facts).softGaps, 0);
});

test('an unprobed chain is never a gap, even when expected', () => {
  const { checks, softGaps } = evaluate(healthyFacts({ chat: null, expectBeeper: true }));
  assert.equal(softGaps, 0);
  assert.equal(find(checks, 'chat bridge').level, 'info');
});

test('each source is reported individually so a silent fallback is visible', () => {
  // If only the aggregate were shown, months could pass on the fallback without anyone noticing
  // the primary had been dead the whole time.
  const facts = healthyFacts({
    chat: chat(src('Beeper Desktop API', false, '000'), src('Matrix homeserver', true)),
  });
  const { checks } = evaluate(facts);
  assert.equal(find(checks, 'chat: Beeper Desktop API').ok, false);
  assert.equal(find(checks, 'chat: Matrix homeserver').ok, true);
});

test('a 401 source is reachable but NOT usable coverage', () => {
  // Regression: the first version of probeChatSources counted any HTTP response as "up", so an
  // unauthenticated Beeper (401) reported as covered while stage 2 could not read a single
  // message — the same false-green as the Google Chat connector saying Connected and 404ing.
  const facts = healthyFacts({
    expectBeeper: true,
    chat: [{ name: 'Beeper Desktop API', url: 'http://x:23373', up: false, reachable: true, unauthorized: true, code: '401' }],
  });
  const { checks, softGaps } = evaluate(facts);
  assert.equal(softGaps, 1, 'an unauthenticated source must count as a coverage gap');
  const s = find(checks, 'chat: Beeper Desktop API');
  assert.equal(s.ok, false);
  assert.match(s.detail, /UNAUTHENTICATED/);
  assert.match(s.fix, /\/mcp/);
});

test('an authenticated source still counts as coverage', () => {
  const facts = healthyFacts({
    expectBeeper: true,
    chat: [{ name: 'Beeper Desktop API', url: 'http://x:23373', up: true, reachable: true, unauthorized: false, code: '200' }],
  });
  assert.equal(evaluate(facts).softGaps, 0);
});

// ── the agent name check ───────────────────────────────────────────────────────

test('a case-mismatched agent name is a HARD gap', () => {
  // The real failure: the workflow ran `--agent jarvis` while the installed agent is `Jarvis`.
  // The CLI only reports this after the run is dispatched, so it must be caught in preflight.
  const { checks, hardGaps } = evaluate(healthyFacts({ agentNames: ['jarvis', 'Friday'] }));
  assert.equal(hardGaps, 1);
  const c = find(checks, `--agent ${TRIAGE_AGENT} installed`);
  assert.equal(c.level, 'hard');
  assert.match(c.detail, /no agent named exactly/);
  assert.match(c.detail, /jarvis/, 'the message should show what IS installed');
});

test('the exact agent name passes', () => {
  assert.equal(evaluate(healthyFacts({ agentNames: ['Jarvis'] })).hardGaps, 0);
});

test('an unreadable agents dir is a hard gap, not a silent pass', () => {
  const { checks, hardGaps } = evaluate(healthyFacts({ agentNames: null }));
  assert.equal(hardGaps, 1);
  assert.match(find(checks, `--agent ${TRIAGE_AGENT} installed`).detail, /could not read/);
});

test('no agents installed at all is reported clearly', () => {
  const { checks } = evaluate(healthyFacts({ agentNames: [] }));
  assert.match(find(checks, `--agent ${TRIAGE_AGENT} installed`).detail, /installed: none/);
});
