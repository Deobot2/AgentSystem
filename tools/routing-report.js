#!/usr/bin/env node
// routing-report.js — #124: joins the two halves of routing-log.jsonl (hint records written by
// hooks/memory-router.js and actual-agent records written by hooks/sona-writeback-hook.js) by
// their shared promptHash, and prints per-branch (config/routing.yml `id`) hit rate plus the
// most common misroute patterns. Plain Node, no new deps — reads the log directly.
//
// Usage:
//   node tools/routing-report.js [--log=<path>]

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { isMainModule } from './is-main.js';

export const ROUTING_LOG_PATH = join(homedir(), 'agent-memory', 'nexus', 'routing-log.jsonl');

// Pure: parse JSONL text into an array of records, skipping blank/malformed lines.
export function loadRecords(logPath) {
  let raw;
  try {
    raw = readFileSync(logPath || ROUTING_LOG_PATH, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed line.
    }
  }
  return out;
}

// Pure: split records into hint records (have a `hint` field, written by memory-router.js) and
// actual-agent records (have an `agent` field, written by sona-writeback-hook.js), then join by
// promptHash. If multiple records share a promptHash on one side, the last one wins (matches
// append-order semantics — most recent write reflects the final state for that prompt).
export function joinRecords(records) {
  const hints = new Map();
  const actuals = new Map();
  for (const r of records) {
    if (!r || !r.promptHash) continue;
    if (Object.prototype.hasOwnProperty.call(r, 'hint')) {
      hints.set(r.promptHash, r);
    } else if (Object.prototype.hasOwnProperty.call(r, 'agent')) {
      actuals.set(r.promptHash, r);
    }
  }
  const joined = [];
  for (const [hash, hintRec] of hints) {
    const actualRec = actuals.get(hash);
    if (!actualRec) continue;
    joined.push({
      promptHash: hash,
      hint: hintRec.hint,
      agentHint: hintRec.agentHint || null,
      agentActual: actualRec.agent || null,
    });
  }
  return joined;
}

// Pure: compute per-branch hit rate and misroute pattern counts from joined records.
// Records with hint === 'none' (no domain match, e.g. identity queries) are excluded from
// branch scoring — there's no keyword branch to attribute a hit/miss to.
export function computeStats(joined) {
  const branches = new Map(); // id -> { total, hit }
  const misroutes = new Map(); // "hinted -> actual" -> count

  for (const rec of joined) {
    if (!rec.hint || rec.hint === 'none') continue;
    const branch = branches.get(rec.hint) || { total: 0, hit: 0 };
    branch.total += 1;

    const hinted = (rec.agentHint || '').toLowerCase();
    const actual = (rec.agentActual || '').toLowerCase();
    const isHit = Boolean(hinted) && Boolean(actual) && hinted === actual;
    if (isHit) branch.hit += 1;
    branches.set(rec.hint, branch);

    if (!isHit) {
      const key = `${rec.agentHint || rec.hint} -> ${rec.agentActual || 'unknown'}`;
      misroutes.set(key, (misroutes.get(key) || 0) + 1);
    }
  }
  return { branches, misroutes };
}

// Pure: render the report as a plain-text string.
export function formatReport(branches, misroutes) {
  const lines = [];
  lines.push('Routing accuracy report');
  lines.push('========================');

  if (branches.size === 0) {
    lines.push('');
    lines.push('No joined hint/actual records yet — routing-log.jsonl needs both a hint record');
    lines.push('(from memory-router.js) and an actual-agent record (from sona-writeback-hook.js)');
    lines.push('for the same promptHash.');
  } else {
    lines.push('');
    lines.push('Per-branch hit rate:');
    const sorted = [...branches.entries()].sort((a, b) => b[1].total - a[1].total);
    for (const [id, s] of sorted) {
      const pct = s.total ? ((s.hit / s.total) * 100).toFixed(1) : '0.0';
      lines.push(`  ${id.padEnd(14)} ${s.hit}/${s.total} (${pct}%)`);
    }
  }

  lines.push('');
  lines.push('Top misroute patterns:');
  if (misroutes.size === 0) {
    lines.push('  none');
  } else {
    const sortedMis = [...misroutes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [pattern, count] of sortedMis) {
      lines.push(`  ${pattern}: ${count}`);
    }
  }

  return lines.join('\n');
}

// Pure: #351 --check predicate. A quiet week (no log file) is NOT a failure. A log that EXISTS
// with content but yields zero PARSED records, or parses but joins to zero rows (the "241/97
// unique hashes, only 2 overlap" failure from the #351 audit — hint records and actual records
// minted with different promptHashes for the same turn) is the blind-routing-telemetry failure
// this exists to catch.
export function checkRoutingLog(logPath) {
  const path = logPath || ROUTING_LOG_PATH;
  if (!existsSync(path)) {
    return { blind: false, reason: null, totalRecords: 0, joinedRecords: 0 };
  }
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { blind: false, reason: null, totalRecords: 0, joinedRecords: 0 };
  }
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length === 0) {
    return { blind: false, reason: null, totalRecords: 0, joinedRecords: 0 };
  }
  const records = loadRecords(path);
  if (records.length === 0) {
    return { blind: true, reason: `${lines.length} line(s) present but 0 parsed as valid JSON`, totalRecords: 0, joinedRecords: 0 };
  }
  const joined = joinRecords(records);
  if (joined.length === 0) {
    return { blind: true, reason: `${records.length} record(s) parsed but 0 hint/actual pairs share a promptHash`, totalRecords: records.length, joinedRecords: 0 };
  }
  return { blind: false, reason: null, totalRecords: records.length, joinedRecords: joined.length };
}

function parseArgs(argv) {
  const flags = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([\w-]+)(?:=(.*))?$/);
    if (m) flags[m[1]] = m[2] ?? true;
  }
  return flags;
}

function main() {
  const flags = parseArgs(process.argv);

  if (flags.check) {
    const result = checkRoutingLog(flags.log);
    if (result.blind) {
      console.error(`routing-report --check: FAILED — ${result.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(`routing-report --check: OK — ${result.totalRecords} record(s), ${result.joinedRecords} joined`);
    return;
  }

  const records = loadRecords(flags.log);
  const joined = joinRecords(records);
  const { branches, misroutes } = computeStats(joined);
  console.log(formatReport(branches, misroutes));
}

const isMain = isMainModule(import.meta.url);

if (isMain) main();
