// routine-compliance-report.js — summarize routine violations logged by
// hooks/routine-compliance-hook.js (Stop hook) into a per-routine table.
//
// Usage: node tools/routine-compliance-report.js [--days=7] [--json]
//
// No npm deps — Node builtins only (tools/ rule). ESM.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMainModule } from './is-main.js';

const LOG_PATH = path.join(os.homedir(), 'agent-memory', 'nexus', 'routine-compliance.jsonl');

export function summarize(records, sinceMs = 0) {
  const perRoutine = {}; // id -> { sessions: Set, violations, examples }
  let sessions = 0, sessionsWithViolations = 0;
  for (const rec of records) {
    if (Date.parse(rec.ts) < sinceMs) continue;
    sessions++;
    if (rec.violations && rec.violations.length) sessionsWithViolations++;
    for (const v of rec.violations || []) {
      const r = perRoutine[v.routineId] || (perRoutine[v.routineId] = { violations: 0, examples: [] });
      r.violations++;
      if (r.examples.length < 3) r.examples.push(v.evidence);
    }
  }
  return { sessions, sessionsWithViolations, perRoutine };
}

export function readLog(logPath = LOG_PATH) {
  let raw;
  try { raw = fs.readFileSync(logPath, 'utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean).flatMap(l => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
}

function main() {
  const args = process.argv.slice(2);
  const daysArg = args.find(a => a.startsWith('--days='));
  const days = daysArg ? parseInt(daysArg.slice(7), 10) : 7;
  const since = Date.now() - days * 24 * 3600 * 1000;
  const summary = summarize(readLog(), since);
  if (args.includes('--json')) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Routine compliance — last ${days} day(s): ${summary.sessions} session(s), ${summary.sessionsWithViolations} with violations`);
    const ids = Object.keys(summary.perRoutine).sort();
    if (!ids.length) console.log('No violations recorded.');
    for (const id of ids) {
      const r = summary.perRoutine[id];
      console.log(`\n${id}: ${r.violations} violation(s)`);
      for (const e of r.examples) console.log(`  - ${e}`);
    }
  }
}

if (isMainModule(import.meta.url)) main();
