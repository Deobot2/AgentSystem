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
import { evaluate, parseMcpList, softAlertBody, REQUIRED_CONNECTORS } from './life-os-doctor.js';

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
    knownRepoCount: 4,
    todaysBrief: null,
    todaysCloseout: null,
    connectors: Object.fromEntries(REQUIRED_CONNECTORS.map((c) => [c, 'connected'])),
    beeper: false,
    ...overrides,
  };
}

const find = (checks, name) => checks.find((c) => c.name === name);

test('a healthy host has no hard and no soft gaps', () => {
  const { hardGaps, softGaps } = evaluate(healthyFacts());
  assert.equal(hardGaps, 0);
  assert.equal(softGaps, 0);
});

test('an unreachable Beeper is info, never a gap', () => {
  // SKILL.md STEP 3 documents this as the normal case on the headless host. If it ever counts as
  // a gap, the coverage alert is open 365 days a year and stops meaning anything.
  const { checks, softGaps } = evaluate(healthyFacts({ beeper: false }));
  const beeper = find(checks, 'Beeper bridge (localhost:23373)');
  assert.equal(beeper.level, 'info');
  assert.equal(beeper.ok, false);
  assert.equal(softGaps, 0, 'an unreachable Beeper must not be counted as a coverage gap');
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

test('Beeper is info by default and soft when LIFE_OS_EXPECT_BEEPER is set', () => {
  // Default: the skill documents an unreachable bridge as normal here, so it must not alert.
  const off = evaluate(healthyFacts({ beeper: false, expectBeeper: false }));
  assert.equal(off.softGaps, 0);
  assert.equal(find(off.checks, 'Beeper bridge (localhost:23373)').level, 'info');

  // Once someone declares they expect it, a dead bridge is a real coverage gap.
  const on = evaluate(healthyFacts({ beeper: false, expectBeeper: true }));
  assert.equal(on.softGaps, 1);
  assert.equal(find(on.checks, 'Beeper bridge (localhost:23373)').level, 'soft');
});

test('a reachable Beeper is never a gap, expected or not', () => {
  for (const expectBeeper of [true, false]) {
    const r = evaluate(healthyFacts({ beeper: true, expectBeeper }));
    assert.equal(r.softGaps, 0);
    assert.equal(find(r.checks, 'Beeper bridge (localhost:23373)').ok, true);
  }
});

test('an unprobed Beeper is never a gap, even when expected', () => {
  // --hard-only declines to probe; that is not evidence the bridge is down.
  const { checks, softGaps } = evaluate(healthyFacts({ beeper: null, expectBeeper: true }));
  assert.equal(softGaps, 0);
  assert.equal(find(checks, 'Beeper bridge (localhost:23373)').level, 'info');
});
