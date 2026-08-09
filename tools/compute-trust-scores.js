// compute-trust-scores.js — aggregate agent-dispatch run logs into a trust-score report.
// Usage: node tools/compute-trust-scores.js [--dry-run] [--help]

import fs from 'fs';
import path from 'path';

import { agentMemoryRoot } from './graph/graph-lib.js';
import { parseFlagsOrExit } from './cli-args.js';
import { isMainModule } from './is-main.js';

const USAGE = 'Usage: node tools/compute-trust-scores.js [--dry-run] [--allow-empty] [--help]';

// Resolved per call, not at import: AGENT_MEMORY_ROOT is how tests point this at a temp dir, and a
// module-level os.homedir() constant made that impossible to exercise.
const runLogDir = () => path.join(agentMemoryRoot(), 'nexus', 'run-log');
const outputFile = () => path.join(agentMemoryRoot(), 'nexus', 'trust-scores.md');

function classifyResult(result, verification) {
  if (!result || typeof result !== 'string') return 'unknown';
  const trimmed = result.trim().toUpperCase();
  if (trimmed.startsWith('DONE')) {
    // done-check.js mechanically verifies DONE claims (PR merged, commit landed,
    // files exist). A contradicted DONE is a false completion claim — count it
    // as a failure so it erodes trust instead of inflating it.
    if (verification && verification.verdict === 'contradicted') return 'failure';
    return 'success';
  }
  if (trimmed.startsWith('BLOCKED')) return 'failure';
  return 'unknown';
}

// No input is a broken pipeline, not an empty result. This tool used to print a friendly line and
// exit 0 in that case, so `weekly-trust-scores` was green every week while the report on disk sat
// at 159 bytes of "No run data yet." since 2026-07-05 -- and hooks/memory-router.js routes on that
// file. Missing input now exits 1. --allow-empty is the deliberate first-run bootstrap escape
// hatch, and even then an existing report is never clobbered with a stub.
// The single marker sentence writeEmpty() emits. Kept as one constant so the writer and this
// reader cannot drift apart -- if they did, the deadlock above comes straight back.
const EMPTY_REPORT_MARKER = 'No run data yet.';

// A read failure means "cannot prove it is a stub", which must fall through to refusing --
// unreadable is not permission to overwrite.
function isEmptyReport(file) {
  try {
    return fs.readFileSync(file, 'utf8').includes(EMPTY_REPORT_MARKER);
  } catch {
    return false;
  }
}

function missingInput(reason, { dryRun, allowEmpty }) {
  const OUTPUT_FILE = outputFile();
  if (!allowEmpty) {
    console.error(`[trust-scores] ${reason} — refusing to overwrite ${OUTPUT_FILE} with an empty report.`);
    console.error('[trust-scores] Run logs are written by agent-dispatch.yml into ' + runLogDir() + '.');
    console.error('[trust-scores] If this host has genuinely never dispatched an agent, pass --allow-empty.');
    process.exit(1);
  }
  // "Exists" is not "holds data". The stub written by writeEmpty() below is committed to the
  // agent-memory repo and therefore present on every host, so testing existence alone made
  // --allow-empty -- this tool's own documented escape hatch -- impossible to use anywhere:
  // weekly-trust-scores could not go green without deleting a tracked file. Refuse only when the
  // report on disk is something other than our own empty stub; replacing a stub with a
  // freshly-dated stub loses nothing.
  if (fs.existsSync(OUTPUT_FILE) && !isEmptyReport(OUTPUT_FILE)) {
    console.error(`[trust-scores] ${reason}, but ${OUTPUT_FILE} already exists — refusing to replace real data with a stub.`);
    process.exit(1);
  }
  console.log(`[trust-scores] ${reason} — writing empty report (--allow-empty)`);
  if (dryRun) console.log('[dry-run] would write empty report to', OUTPUT_FILE);
  else writeEmpty();
}

function main(dryRun = false, allowEmpty = false) {
  const RUN_LOG_DIR = runLogDir();
  const OUTPUT_FILE = outputFile();
  console.log('[trust-scores] Reading run-log from:', RUN_LOG_DIR);

  if (!fs.existsSync(RUN_LOG_DIR)) {
    missingInput('Run-log directory does not exist', { dryRun, allowEmpty });
    return;
  }

  const files = fs.readdirSync(RUN_LOG_DIR).filter(f => f.endsWith('.json'));

  if (files.length === 0) {
    missingInput('No run log files found', { dryRun, allowEmpty });
    return;
  }

  // agent -> { total, successes, failures, unknown }
  const scores = {};

  for (const file of files) {
    const filePath = path.join(RUN_LOG_DIR, file);
    let data;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      data = JSON.parse(raw);
    } catch (err) {
      console.warn('[trust-scores] Skipping malformed JSON:', file, err.message);
      continue;
    }

    const agent = (data.agent || 'unknown').toLowerCase();
    const classification = classifyResult(data.result, data.verification);

    if (!scores[agent]) {
      scores[agent] = { total: 0, successes: 0, failures: 0, unknown: 0 };
    }

    scores[agent].total++;
    if (classification === 'success') scores[agent].successes++;
    else if (classification === 'failure') scores[agent].failures++;
    else scores[agent].unknown++;
  }

  const now = new Date().toISOString();
  const sortedAgents = Object.keys(scores).sort();

  let rows = '';
  for (const agent of sortedAgents) {
    const s = scores[agent];
    const rate = s.total > 0 ? Math.round((s.successes / s.total) * 100) + '%' : '0%';
    rows += `| ${agent} | ${s.total} | ${s.successes} | ${s.failures} | ${s.unknown} | ${rate} |\n`;
  }

  const md = `# Agent Trust Scores
_Last updated: ${now}_

| Agent | Total Runs | Successes | Failures | Unknown | Success Rate |
|-------|-----------|-----------|---------|---------|-------------|
${rows}`;

  if (dryRun) {
    console.log(`[dry-run] would write to ${OUTPUT_FILE} — agents tracked: ${sortedAgents.length}, total runs: ${files.length}`);
    return;
  }

  // Ensure output dir exists
  const outDir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  fs.writeFileSync(OUTPUT_FILE, md, 'utf8');
  console.log('[trust-scores] Written to:', OUTPUT_FILE);
  console.log('[trust-scores] Agents tracked:', sortedAgents.length, '| Total runs:', files.length);
}

function writeEmpty() {
  const OUTPUT_FILE = outputFile();
  const now = new Date().toISOString();
  const md = `# Agent Trust Scores
_Last updated: ${now}_

${EMPTY_REPORT_MARKER} Run logs are written to \`~/agent-memory/nexus/run-log/\` by agent-dispatch.yml.
`;
  const outDir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  fs.writeFileSync(OUTPUT_FILE, md, 'utf8');
  console.log('[trust-scores] Empty report written to:', OUTPUT_FILE);
}

const isMain = isMainModule(import.meta.url);

if (isMain) {
  const flags = parseFlagsOrExit(process.argv.slice(2), { usage: USAGE, allowed: ['dry-run', 'allow-empty'] });
  main(!!flags['dry-run'], !!flags['allow-empty']);
}
