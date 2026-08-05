#!/usr/bin/env node
// routines.js — Routines engine CLI. No npm deps; pure Node.js builtins only.
//
// Commands:
//   compile             — generate .agents/rules/routines.generated.md from routines.yml
//   compile --verify    — same, but exit 1 if a cron routine has no matching workflow job
//   verify              — cross-check cron routines against scheduled-tasks.yml (no writes)
//   list                — show all routines + enabled/bypassed state
//   enable <id>         — set enabled: true in routines.yml
//   disable <id>        — set enabled: false in routines.yml
//   bypass <id>         — write override to ~/agent-memory/nexus/routine-overrides.json
//   bypass <id> --session — same, tagged as session-only
//   unbypass <id>       — remove override from routine-overrides.json

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-main.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const ROUTINES_YML = join(REPO_ROOT, 'config', 'routines.yml');
const GENERATED_MD = join(REPO_ROOT, '.agents', 'rules', 'routines.generated.md');
const OVERRIDES_PATH = join(homedir(), 'agent-memory', 'nexus', 'routine-overrides.json');
const SCHEDULED_YML = join(REPO_ROOT, '.github', 'workflows', 'scheduled-tasks.yml');

// ---------------------------------------------------------------------------
// Minimal YAML parser — handles the constrained routines.yml format only.
// Supports: list of objects with string/boolean values. No nested objects.
// ---------------------------------------------------------------------------
export function parseRoutinesYml(text) {
  const routines = [];
  let current = null;
  let inMultilineAction = false;
  let actionLines = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine;
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      if (inMultilineAction) {
        // blank line ends multiline action
        inMultilineAction = false;
        if (current) current.action = actionLines.join(' ').trim();
        actionLines = [];
      }
      continue;
    }

    // New list item
    if (trimmed.startsWith('- id:')) {
      if (current) routines.push(current);
      current = { id: trimmed.replace('- id:', '').trim() };
      inMultilineAction = false;
      actionLines = [];
      continue;
    }

    if (!current) continue;

    // key: value pairs (indented under the list item)
    const kvMatch = line.match(/^\s+(\w[\w_-]*):\s*(.*)/);
    if (!kvMatch) continue;

    const key = kvMatch[1];
    const val = kvMatch[2].trim();

    if (inMultilineAction) {
      // continuation of a block scalar — but we use quoted strings, so this
      // handles the case where action: spans via a quoted value.
      inMultilineAction = false;
      if (current) current.action = actionLines.join(' ').trim();
      actionLines = [];
    }

    if (val === 'true') { current[key] = true; continue; }
    if (val === 'false') { current[key] = false; continue; }

    // Strip surrounding quotes
    const unquoted = val.replace(/^["'](.*)["']$/, '$1');
    current[key] = unquoted;
  }

  if (current) routines.push(current);
  return routines;
}

// ---------------------------------------------------------------------------
// Serialize a single routine back to YAML (for enable/disable).
// Surgical: replaces only the `enabled:` line for the given id.
// ---------------------------------------------------------------------------
function setEnabledInYml(text, id, value) {
  const lines = text.split('\n');
  let inTarget = false;
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === `- id: ${id}`) { inTarget = true; }
    else if (inTarget && trimmed.startsWith('- id:')) { inTarget = false; }

    if (inTarget && /^\s+enabled:/.test(line)) {
      result.push(line.replace(/enabled:\s*(true|false)/, `enabled: ${value}`));
    } else {
      result.push(line);
    }
  }
  return result.join('\n');
}

// ---------------------------------------------------------------------------
// Overrides file (runtime bypass — no registry edit needed)
// ---------------------------------------------------------------------------
function readOverrides() {
  try {
    return JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeOverrides(overrides) {
  mkdirSync(join(homedir(), 'agent-memory', 'nexus'), { recursive: true });
  writeFileSync(OVERRIDES_PATH, JSON.stringify(overrides, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdList() {
  const text = readFileSync(ROUTINES_YML, 'utf8');
  const routines = parseRoutinesYml(text);
  const overrides = readOverrides();

  console.log('Routines:\n');
  for (const r of routines) {
    const bypass = overrides[r.id];
    const bypassed = bypass ? ` [BYPASSED${bypass.session ? ' session' : ''}]` : '';
    const enabled = r.enabled ? 'enabled' : 'disabled';
    console.log(`  ${r.id}`);
    console.log(`    mechanism: ${r.mechanism}  enforce: ${r.enforce}  ${enabled}${bypassed}`);
    console.log(`    ${r.description}`);
    console.log();
  }
}

function cmdCompile({ verify = false } = {}) {
  const text = readFileSync(ROUTINES_YML, 'utf8');
  const routines = parseRoutinesYml(text);
  const overrides = readOverrides();

  // Registry state ONLY — deliberately not filtered by `overrides`.
  //
  // .agents/rules/routines.generated.md is tracked in git, and routine-overrides.json is
  // machine-local runtime state. Filtering here baked one machine's bypasses into the shared
  // artifact: compiling on a host that had `always-worktree` and `fix-pr-until-green` bypassed
  // (one of them a `session: true` bypass from three weeks earlier that nothing ever cleared)
  // silently dropped two `enforce: hard` routines from the file every session reads — for every
  // machine, permanently, via a commit.
  //
  // Bypass still means "the text is not injected", as documented at the top of routines.yml. That
  // suppression now happens where the local state belongs: hooks/routines-context-inject.js
  // filters bypassed ids at injection time.
  const agentRules = routines.filter(r => r.mechanism === 'agent-rule' && r.enabled);

  // #122: compact 1-2 line-per-routine format (id/enforce + action only). Full prose
  // (description) stays in config/routines.yml itself and `node tools/routines.js list` —
  // this generated file is injected into every session's fixed context, so it stays terse.
  const lines = [
    '<!-- AUTO-GENERATED by `node tools/routines.js compile` — DO NOT EDIT BY HAND -->',
    '<!-- Source: config/routines.yml. Full descriptions: `node tools/routines.js list` -->',
    '',
    '# Enforced Routines (bypass: `node tools/routines.js bypass <id> [--session]`)',
    '',
  ];

  for (const r of agentRules) {
    lines.push(`- **${r.id}** (${r.enforce}): ${r.action}`);
  }
  lines.push('');

  if (agentRules.length === 0) {
    lines.push('_(no active agent-rule routines)_');
    lines.push('');
  }

  mkdirSync(join(REPO_ROOT, '.agents', 'rules'), { recursive: true });
  writeFileSync(GENERATED_MD, lines.join('\n'), 'utf8');
  console.log(`[routines] compiled ${agentRules.length} agent-rules → ${GENERATED_MD}`);

  // Report other mechanisms
  const hooks = routines.filter(r => r.mechanism === 'hook' && r.enabled);
  const crons = routines.filter(r => r.mechanism === 'cron' && r.enabled);
  if (hooks.length) console.log(`[routines] ${hooks.length} hook-routines active (dispatched by routine-dispatch.js)`);
  if (crons.length) console.log(`[routines] ${crons.length} cron-routines (scheduled by .github/workflows/scheduled-tasks.yml on the self-hosted Linux runner)`);

  // #200: a cron routine that reports as enforced while no scheduler can fire it is the defect
  // this whole file was accused of. Report it every compile; fail the command under --verify so
  // CI can gate on it.
  const problems = verifyCronRoutines(routines);
  if (problems.length) {
    console.log('');
    for (const p of problems) console.log(`[routines] ${p.severity === 'error' ? 'UNREGISTERED' : 'warning'}: ${p.id} — ${p.detail}`);
    if (verify && problems.some(p => p.severity === 'error')) {
      console.error('\n[routines] verify FAILED — a cron routine cannot fire. Add the job to '
        + '.github/workflows/scheduled-tasks.yml, or `node tools/routines.js disable <id>`.');
      process.exit(1);
    }
  } else if (crons.length) {
    console.log('[routines] all cron-routines have a matching job and schedule in scheduled-tasks.yml');
  }
}

/**
 * Cross-check every enabled `mechanism: cron` routine against scheduled-tasks.yml.
 *
 * The old message here told the operator to register these via Windows Task Scheduler and a .ps1
 * script, on a Linux host, which is how four `enforce: hard` routines sat unregistered and unnoticed
 * (#200). The real scheduler is the workflow, so that is what gets checked — by job id AND by cron
 * expression, because a routine whose schedule silently disagrees with the workflow (weekly-trust-
 * scores said Saturday 08:00 while the job ran Sunday midnight) is just as wrong as a missing one.
 *
 * `mechanism: external` is exempt on purpose: stage 1 of the Life OS cadence runs in Grok Tasks and
 * will never have a job here. That is why it is not declared `cron`.
 *
 * The job is looked up by the routine's `workflow_job` field, falling back to its id. Routine ids
 * and job names are allowed to differ — `weekly-brain-review` runs the `weekly-brain-consolidation`
 * job — so the link is declared explicitly rather than inferred from a naming convention that was
 * never actually followed.
 *
 * Text-scan rather than a YAML parse: tools/ takes no npm deps, and a full YAML parser for two
 * facts (does a job with this name exist, and which crons does the file schedule) is not worth it.
 *
 * @returns {Array<{id: string, severity: 'error'|'warning', detail: string}>}
 */
export function verifyCronRoutines(routines, { workflowText } = {}) {
  let text = workflowText;
  if (text === undefined) {
    try { text = readFileSync(SCHEDULED_YML, 'utf8'); } catch { text = null; }
  }
  const crons = routines.filter(r => r.mechanism === 'cron' && r.enabled);
  if (!crons.length) return [];
  if (text === null) {
    return crons.map(r => ({ id: r.id, severity: 'error', detail: `${SCHEDULED_YML} not found — nothing can schedule this` }));
  }

  const jobIds = new Set(
    [...text.matchAll(/^ {2}([a-z0-9][a-z0-9-]*):$/gm)].map(m => m[1]),
  );
  const schedules = new Set(
    [...text.matchAll(/^\s*-\s*cron:\s*['"]([^'"]+)['"]/gm)].map(m => m[1].trim()),
  );

  const problems = [];
  for (const r of crons) {
    const jobName = r.workflow_job || r.id;
    if (!jobIds.has(jobName)) {
      problems.push({
        id: r.id,
        severity: 'error',
        detail: r.workflow_job
          ? `workflow_job \`${jobName}\` does not exist in scheduled-tasks.yml`
          : `no job named \`${r.id}\` in scheduled-tasks.yml (set \`workflow_job:\` if the job has a different name)`,
      });
      continue;
    }
    // A routine may map to SEVERAL crons — daily-triage runs twice a day — so `schedule` accepts a
    // comma-separated list and EVERY entry must exist in the workflow. Checking only the first would
    // let a second schedule drift away unnoticed, which is the whole failure this guards.
    const declared = String(r.schedule || '').split(',').map(x => x.trim()).filter(Boolean);
    const missing = declared.filter(x => !schedules.has(x));
    if (missing.length) {
      problems.push({
        id: r.id,
        severity: 'error',
        detail: `schedule ${missing.map(x => `"${x}"`).join(' and ')} not among the workflow's crons `
          + `(${[...schedules].map(x => `"${x}"`).join(', ')})`,
      });
    }
  }
  return problems;
}

function cmdVerify() {
  const routines = parseRoutinesYml(readFileSync(ROUTINES_YML, 'utf8'));
  const problems = verifyCronRoutines(routines);
  const crons = routines.filter(r => r.mechanism === 'cron' && r.enabled);
  if (!problems.length) {
    console.log(`[routines] ok — ${crons.length} cron-routine(s) all have a matching job and schedule in scheduled-tasks.yml`);
    return;
  }
  for (const p of problems) console.error(`[routines] ${p.severity === 'error' ? 'UNREGISTERED' : 'warning'}: ${p.id} — ${p.detail}`);
  if (problems.some(p => p.severity === 'error')) {
    console.error('\n[routines] A routine declared `enforce: hard` that no scheduler can fire is the #200 defect.');
    console.error('Add the job to .github/workflows/scheduled-tasks.yml, or `node tools/routines.js disable <id>`.');
    process.exit(1);
  }
}

function cmdEnable(id) {
  if (!id) { console.error('Usage: routines.js enable <id>'); process.exit(1); }
  let text = readFileSync(ROUTINES_YML, 'utf8');
  const routines = parseRoutinesYml(text);
  if (!routines.find(r => r.id === id)) {
    console.error(`[routines] unknown routine: ${id}`); process.exit(1);
  }
  text = setEnabledInYml(text, id, true);
  writeFileSync(ROUTINES_YML, text, 'utf8');
  console.log(`[routines] enabled: ${id}`);
}

function cmdDisable(id) {
  if (!id) { console.error('Usage: routines.js disable <id>'); process.exit(1); }
  let text = readFileSync(ROUTINES_YML, 'utf8');
  const routines = parseRoutinesYml(text);
  if (!routines.find(r => r.id === id)) {
    console.error(`[routines] unknown routine: ${id}`); process.exit(1);
  }
  text = setEnabledInYml(text, id, false);
  writeFileSync(ROUTINES_YML, text, 'utf8');
  console.log(`[routines] disabled: ${id}`);
}

function cmdBypass(id, sessionFlag) {
  if (!id) { console.error('Usage: routines.js bypass <id> [--session]'); process.exit(1); }
  const text = readFileSync(ROUTINES_YML, 'utf8');
  const routines = parseRoutinesYml(text);
  if (!routines.find(r => r.id === id)) {
    console.error(`[routines] unknown routine: ${id}`); process.exit(1);
  }
  const overrides = readOverrides();
  overrides[id] = { bypassed: true, session: !!sessionFlag, at: new Date().toISOString() };
  writeOverrides(overrides);
  console.log(`[routines] bypassed: ${id}${sessionFlag ? ' (session)' : ''}`);
}

function cmdUnbypass(id) {
  if (!id) { console.error('Usage: routines.js unbypass <id>'); process.exit(1); }
  const overrides = readOverrides();
  if (!overrides[id]) { console.log(`[routines] ${id} was not bypassed`); return; }
  delete overrides[id];
  writeOverrides(overrides);
  console.log(`[routines] unbypass: ${id}`);
}

// ---------------------------------------------------------------------------
// Dispatch mode — called by routine-dispatch.js hook at runtime
// ---------------------------------------------------------------------------
export function dispatchRoutines({ event, context } = {}) {
  const text = readFileSync(ROUTINES_YML, 'utf8');
  const routines = parseRoutinesYml(text);
  const overrides = readOverrides();

  return routines.filter(r => {
    if (!r.enabled) return false;
    if (overrides[r.id]) return false;
    if (r.mechanism !== 'hook') return false;
    // Match trigger to event context
    if (event === 'PostToolUse' && r.trigger === 'pr_create') return true;
    if (event === 'UserPromptSubmit' && r.trigger === 'identity_lookup') return true;
    return false;
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const isMain = isMainModule(import.meta.url);

if (isMain) {
  const [,, cmd, arg, ...rest] = process.argv;
  const sessionFlag = rest.includes('--session');

  switch (cmd) {
    case 'list':    cmdList(); break;
    // `verify` is compile-with-the-gate-on and no file written: the same cross-check CI wants,
    // without regenerating a tracked file as a side effect of a read-only question.
    case 'compile': cmdCompile({ verify: process.argv.includes('--verify') }); break;
    case 'verify':  cmdVerify(); break;
    case 'enable':  cmdEnable(arg); break;
    case 'disable': cmdDisable(arg); break;
    case 'bypass':  cmdBypass(arg, sessionFlag); break;
    case 'unbypass': cmdUnbypass(arg); break;
    default:
      console.log('Usage: node tools/routines.js <list|compile [--verify]|verify|enable|disable|bypass|unbypass> [id] [--session]');
      process.exit(1);
  }
}
