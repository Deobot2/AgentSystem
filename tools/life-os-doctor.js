#!/usr/bin/env node
// life-os-doctor.js — verify every precondition the 07:00 daily triage depends on.
//
// Usage:
//   node tools/life-os-doctor.js               # table; exit 1 if any HARD check fails
//   node tools/life-os-doctor.js --json        # machine-readable
//   node tools/life-os-doctor.js --hard-only   # skip the network probes (~8s faster)
//   node tools/life-os-doctor.js --alert       # also raise/clear the human-needed alert
//
// Why this exists: the pipeline had four consecutive silent failures because its preconditions
// live in six different places — a gitignored skill shipped over ssh, a symlink nothing creates,
// two directories, a CLI on PATH, a JSON registry, and five interactively-authenticated MCP
// connectors. Any one of them missing produced either a red run nobody read or a degraded run
// that looked green. There was no single command that answered "can tomorrow's 07:00 run
// actually work", so nobody could tell.
//
// HARD vs SOFT is the useful distinction, not present/absent:
//   HARD — the run cannot start, or cannot produce a closeout. Fails the preflight.
//   SOFT — the run works but covers less than it should. Never fails a run; surfaces as a
//          human-needed alert, because the fix is always a human authenticating something.
// Conflating the two is what made the old check useless: it either blocked on things that only
// degrade coverage, or stayed silent about them forever.

import { existsSync, readFileSync, statSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { isMainModule } from './is-main.js';

const HOME = process.env.HOME || homedir();
const LIFE = process.env.LIFE_REPO || join(HOME, 'life');

// The MCP connectors stage 2 actually uses: Drive to read the brief stage 1 archived, and
// Gmail/Calendar/Notion for the fallback sweep when stage 1 was missed. The other ~13 connectors
// claude.ai offers are irrelevant here and must not be reported as gaps.
export const REQUIRED_CONNECTORS = ['Gmail', 'Google Drive', 'Google Calendar', 'Notion'];

// ── fact gathering (all host I/O lives here, so evaluate() stays pure) ──────────

export function gatherFacts({ hardOnly = false } = {}) {
  const devLink = join(HOME, 'dev', 'AgentSystem');
  let devLinkTarget = null;
  try { devLinkTarget = lstatSync(devLink).isSymbolicLink() ? realpathSync(devLink) : (existsSync(join(devLink, 'tools')) ? devLink : null); } catch { /* absent */ }

  const repo = devLinkTarget || (existsSync(join(HOME, 'AgentSystem', 'tools')) ? join(HOME, 'AgentSystem') : null);

  const fileSize = (p) => { try { return statSync(p).size; } catch { return null; } };

  let knownRepos = null;
  try { knownRepos = JSON.parse(readFileSync(join(HOME, 'agent-memory', 'nexus', 'known-repos.json'), 'utf8')); } catch { /* absent or malformed */ }

  const today = new Date().toISOString().slice(0, 10);

  return {
    devLink, devLinkTarget, repo, today, life: LIFE,
    skillSizes: repo ? {
      'skills/daily-briefing/SKILL.md': fileSize(join(repo, 'skills/daily-briefing/SKILL.md')),
      'skills/daily-triage/SKILL.md': fileSize(join(repo, 'skills/daily-triage/SKILL.md')),
      'skills/daily-briefing/portable-prompt.md': fileSize(join(repo, 'skills/daily-briefing/portable-prompt.md')),
      'skills/daily-briefing/handoff-schema.md': fileSize(join(repo, 'skills/daily-briefing/handoff-schema.md')),
    } : {},
    installedSkills: {
      'daily-briefing': existsSync(join(HOME, '.claude/skills/daily-briefing/SKILL.md')),
      'daily-triage': existsSync(join(HOME, '.claude/skills/daily-triage/SKILL.md')),
    },
    lifeDirs: {
      briefings: existsSync(join(LIFE, 'briefings')),
      closeouts: existsSync(join(LIFE, 'closeouts')),
    },
    claudeOnPath: which('claude'),
    knownRepoCount: knownRepos && Array.isArray(knownRepos.repos) ? knownRepos.repos.length
      : knownRepos && typeof knownRepos === 'object' ? Object.keys(knownRepos).length : null,
    todaysBrief: fileSize(join(LIFE, 'briefings', `${today}.md`)),
    todaysCloseout: fileSize(join(LIFE, 'closeouts', `${today}.md`)),
    // 'skipped' and null mean different things and must not collapse: 'skipped' is --hard-only
    // declining to probe, null is a probe that ran and failed. Reporting the first as the second
    // makes --hard-only claim a coverage gap that nobody has evidence for.
    connectors: hardOnly ? 'skipped' : probeConnectors(),
    chat: hardOnly ? null : probeChatSources(chatSources()),
    expectBeeper: /^(1|true|yes)$/i.test(process.env.LIFE_OS_EXPECT_BEEPER || ''),
  };
}

function which(bin) {
  try { execFileSync('command', ['-v', bin], { shell: '/bin/bash', stdio: 'pipe' }); return true; }
  catch { /* fall through */ }
  try { execFileSync('bash', ['-lc', `command -v ${bin}`], { stdio: 'pipe' }); return true; }
  catch { return false; }
}

/**
 * Parse `claude mcp list` into { name: 'connected' | 'needs-auth' | 'failed' }.
 * Returns null when the CLI could not be run at all — which is different from "nothing is
 * connected" and must not be reported as a gap in every connector.
 */
export function parseMcpList(text) {
  const out = {};
  for (const raw of (text || '').split('\n')) {
    const line = raw.trim();
    // Two shapes, both "<name>: <target> - <status>":
    //   claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected
    //   agentsystem: node /home/u/AgentSystem/tools/mcp-server.js - ✔ Connected
    // The target can contain spaces (a stdio command), so the split is on the LAST " - ",
    // not on a whitespace-free middle field.
    const colon = line.indexOf(': ');
    const dash = line.lastIndexOf(' - ');
    if (colon === -1 || dash === -1 || dash < colon) continue;
    const name = line.slice(0, colon).replace(/^claude\.ai\s+/, '').trim();
    const status = line.slice(dash + 3).toLowerCase();
    if (!name) continue;
    out[name] = status.includes('connected') ? 'connected'
      : status.includes('authentication') ? 'needs-auth'
      : 'failed';
  }
  return out;
}

function probeConnectors() {
  try {
    const out = execFileSync('claude', ['mcp', 'list'], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return parseMcpList(out);
  } catch (err) {
    // Partial output on timeout is still worth parsing.
    const partial = (err.stdout || '').toString();
    return partial ? parseMcpList(partial) : null;
  }
}

// The chat-source chain, in preference order. Stage 2 needs exactly one of these to be up.
//
// Beeper Desktop's API lives in the desktop app, so it is only reachable while that machine is
// awake — a laptop is not a 24/7 dependency you want under a 07:00 cron. matrix.beeper.com is the
// same account's homeserver, runs on Beeper's infrastructure, and is up regardless. Anything
// bridged via Beeper Cloud is readable there when the laptop is not.
//
// BEEPER_API_URL: default is localhost for a host running Beeper itself; set it to the tailnet
// address of the machine that does (Settings -> Integrations -> Advanced -> Remote Access).
export function chatSources(env = process.env) {
  const sources = [];
  const beeper = env.BEEPER_API_URL || 'http://localhost:23373';
  // Probe the endpoint stage 2 would actually call, not `/`. The root 302s to a landing page even
  // when the API is unauthenticated, so probing it reports "usable" for a server that answers 401
  // to every real request.
  sources.push({ name: 'Beeper Desktop API', url: beeper, probe: `${beeper.replace(/\/$/, '')}/v0/mcp` });
  if (env.MATRIX_HOMESERVER) {
    const hs = env.MATRIX_HOMESERVER.replace(/\/$/, '');
    sources.push({ name: 'Matrix homeserver', url: hs, probe: `${hs}/_matrix/client/versions` });
  }
  return sources;
}

/**
 * Probe each source, distinguishing REACHABLE from USABLE.
 *
 * An earlier version of this counted any HTTP response as "up", on the reasoning that a 401 is a
 * healthy Beeper that merely wants its token. That is true for liveness and useless for coverage:
 * stage 2 cannot read a single message through a 401, so reporting it as up is the same false-green
 * as the Google Chat connector claiming `✔ Connected` while 404ing on every call. The question this
 * tool answers is "can the 07:00 run read chat", not "is a socket open".
 *
 * So 401/403 is reachable-but-unusable, and only that counts as coverage.
 */
function probeChatSources(sources) {
  return sources.map((s) => {
    try {
      const code = execFileSync('curl', ['-s', '-m', '5', '-o', '/dev/null', '-w', '%{http_code}', s.probe],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      const reachable = code !== '000' && code !== '';
      const unauthorized = code === '401' || code === '403';
      return { ...s, reachable, up: reachable && !unauthorized, unauthorized, code };
    } catch { return { ...s, reachable: false, up: false, unauthorized: false, code: '000' }; }
  });
}

// ── evaluation (pure) ──────────────────────────────────────────────────────────

/** @returns {{checks: Array<{name,level,ok,detail,fix}>, hardGaps: number, softGaps: number}} */
export function evaluate(f) {
  const checks = [];
  const add = (name, level, ok, detail, fix) => checks.push({ name, level, ok, detail, fix });

  add('working copy resolvable', 'hard', !!f.repo,
    f.repo ? f.repo : 'no checkout with a tools/ dir at ~/dev/AgentSystem or ~/AgentSystem',
    'Clone the repo, or point ~/dev/AgentSystem at the existing checkout.');

  // Not cosmetic: daily-triage/SKILL.md STEP 4 runs its GitHub sweep in $HOME/dev/AgentSystem,
  // and config/routines.yml invokes every weekly tool through that path.
  add('~/dev/AgentSystem symlink', 'hard', !!f.devLinkTarget,
    f.devLinkTarget ? `-> ${f.devLinkTarget}` : 'missing',
    `ln -sfn "$HOME/AgentSystem" "${f.devLink}"`);

  for (const [rel, size] of Object.entries(f.skillSizes)) {
    add(rel, 'hard', typeof size === 'number' && size > 0,
      size ? `${size} bytes` : 'missing or empty',
      'Gitignored (#187) — ship from the authoring machine: bash tools/deploy-private-skills.sh --host <user@host>');
  }
  if (Object.keys(f.skillSizes).length === 0) {
    add('private life-OS skills', 'hard', false, 'not checked (no working copy)', 'Fix the working copy first.');
  }

  for (const [name, ok] of Object.entries(f.installedSkills)) {
    add(`~/.claude/skills/${name}`, 'hard', ok, ok ? 'installed' : 'not installed',
      `node tools/install-skills.js ${name}`);
  }

  for (const [name, ok] of Object.entries(f.lifeDirs)) {
    add(`${f.life}/${name}`, 'hard', ok, ok ? 'present' : 'missing', `mkdir -p "${f.life}/${name}"`);
  }

  add('claude CLI on PATH', 'hard', f.claudeOnPath === true,
    f.claudeOnPath ? 'found' : 'not found',
    'Install the Claude Code CLI for the runner user; a login shell PATH is not guaranteed in Actions.');

  add('known-repos.json', 'hard', typeof f.knownRepoCount === 'number',
    typeof f.knownRepoCount === 'number' ? `${f.knownRepoCount} repo(s)` : 'missing or unparseable',
    'node tools/bootstrap-repo.js --all ~/dev');

  // ── soft: coverage, not capability ──
  if (f.connectors === 'skipped') {
    add('MCP connectors', 'info', false, 'not probed (--hard-only)',
      'Re-run without --hard-only to check the connectors.');
  } else if (f.connectors === null) {
    add('MCP connectors', 'soft', false, 'could not run `claude mcp list`',
      'Run `claude mcp list` by hand on the host to see why.');
  } else {
    for (const name of REQUIRED_CONNECTORS) {
      const status = f.connectors[name];
      add(`connector: ${name}`, 'soft', status === 'connected', status || 'not configured',
        'Authenticate it interactively on the host — `claude` then `/mcp`. Only a human can complete the OAuth flow.');
    }
  }

  // Chat coverage is a chain, not a single host: stage 2 needs ANY one source up. Reported per
  // source so a fallback silently carrying every run is visible rather than looking like health.
  //
  // `info` by default and `soft` once LIFE_OS_EXPECT_BEEPER says chat is meant to work.
  // daily-triage/SKILL.md STEP 3 documents an unreachable bridge as the normal case on this
  // headless host, so alerting out of the box would fire daily for an accepted condition — the
  // fastest way to teach someone to ignore alerts. Not probing (--hard-only) is never a gap.
  if (f.chat === null) {
    add('chat bridge', 'info', false, 'not probed', 'Re-run without --hard-only.');
  } else {
    const live = f.chat.filter((s) => s.up);
    for (const s of f.chat) {
      add(`chat: ${s.name}`, 'info', s.up,
        s.up ? `usable (${s.url}, HTTP ${s.code})`
          : s.unauthorized ? `reachable but UNAUTHENTICATED (HTTP ${s.code}) — stage 2 cannot read it`
          : `unreachable (${s.url})`,
        s.unauthorized
          ? 'Authenticate it: `claude` then `/mcp` and pick `beeper`. Reachability is not coverage.'
          : 'See #216.');
    }
    add('chat coverage', (f.expectBeeper && !live.length) ? 'soft' : 'info', live.length > 0,
      live.length ? `${live.length}/${f.chat.length} source(s) up — using ${live[0].name}`
        : f.expectBeeper ? 'no chat source reachable — stage 2 will report the channel uncovered'
        : 'no chat source reachable (set LIFE_OS_EXPECT_BEEPER=1 to treat as a gap)',
      'Bring up Beeper Desktop on the configured host, or set MATRIX_HOMESERVER=https://matrix.beeper.com '
        + 'so the always-on Beeper Cloud path can cover a sleeping laptop. See #216.');
  }

  const hardGaps = checks.filter((c) => c.level === 'hard' && !c.ok).length;
  const softGaps = checks.filter((c) => c.level === 'soft' && !c.ok).length;
  return { checks, hardGaps, softGaps };
}

// ── output ─────────────────────────────────────────────────────────────────────

function report(f, { checks, hardGaps, softGaps }) {
  const width = Math.max(...checks.map((c) => c.name.length));
  console.log(`Life OS daily-triage doctor — ${f.today}\n`);
  for (const c of checks) {
    const mark = c.ok ? 'ok  ' : c.level === 'hard' ? 'FAIL' : c.level === 'soft' ? 'warn' : 'note';
    console.log(`  [${mark}] ${c.name.padEnd(width)}  ${c.detail}`);
  }
  console.log('');
  // Informational, never a gap: stage 1 is an external Grok job. Its brief legitimately does not
  // exist before 06:00, and stage 2 has a documented fallback for when it never arrives.
  console.log(`  stage 1 brief for ${f.today}: ${f.todaysBrief ? `${f.todaysBrief} bytes` : 'not on disk (stage 2 will fall back)'}`);
  console.log(`  stage 2 closeout for ${f.today}: ${f.todaysCloseout ? `${f.todaysCloseout} bytes` : 'not written yet'}`);
  console.log('');

  if (hardGaps === 0 && softGaps === 0) {
    const notes = checks.filter((c) => c.level === 'info' && !c.ok);
    console.log('All checks pass — the 07:00 run has everything it needs.');
    for (const c of notes) console.log(`  note: ${c.name} — ${c.detail}`);
    return;
  }
  if (hardGaps === 0) console.log(`No blocking gaps. ${softGaps} coverage gap(s) — the run will work but cover less:`);
  else console.log(`${hardGaps} BLOCKING gap(s) — the 07:00 run cannot succeed:`);
  for (const c of checks.filter((x) => !x.ok && x.level !== 'info')) {
    console.log(`\n  ${c.level === 'hard' ? '✖' : '!'} ${c.name}: ${c.detail}`);
    console.log(`    fix: ${c.fix}`);
  }
}

/** The human-needed alert text for soft gaps. Kept separate from the table for testability. */
export function softAlertBody(checks) {
  const gaps = checks.filter((c) => c.level === 'soft' && !c.ok);
  const lines = gaps.map((c) => `- **${c.name}** — ${c.detail}\n  - fix: ${c.fix}`);
  return lines.join('\n');
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const facts = gatherFacts({ hardOnly: args.includes('--hard-only') });
  const result = evaluate(facts);

  if (args.includes('--json')) {
    console.log(JSON.stringify({ facts, ...result }, null, 2));
  } else {
    report(facts, result);
  }

  if (args.includes('--alert')) {
    const { raise, resolve } = await import('./human-needed.js');
    const KEY = 'life-os-coverage-gaps';
    try {
      const gaps = result.checks.filter((c) => c.level === 'soft' && !c.ok);
      if (gaps.length) {
        raise({
          key: KEY,
          title: '[Life OS]: daily triage is running with reduced coverage',
          why: `\`life-os-doctor.js\` on \`${process.env.HOSTNAME || 'this host'}\` found ${gaps.length} coverage gap(s):\n\n${softAlertBody(result.checks)}`,
          action: 'Each of these needs a human: an MCP connector OAuth flow can only be completed '
            + 'interactively (`claude`, then `/mcp`), and the Beeper bridge only exists on a machine '
            + 'running the desktop app. Until then the 07:00 run still completes and writes a '
            + 'closeout — it just reports these channels as uncovered.',
          source: 'life-os-doctor.js',
        });
      } else {
        resolve({ key: KEY, comment: 'All Life OS coverage checks pass — closing automatically.' });
      }
    } catch (err) {
      console.error(`doctor: could not update the human-needed alert: ${err.message}`);
    }
  }

  // Soft gaps deliberately do not fail: this exit code gates the 07:00 preflight, and a run that
  // covers less is still worth doing.
  process.exit(result.hardGaps > 0 ? 1 : 0);
}
