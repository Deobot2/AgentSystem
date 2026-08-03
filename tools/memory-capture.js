#!/usr/bin/env node
// memory-capture.js — automatic fact capture from a session transcript.
// Reads a transcript file (path as first positional arg), extracts durable facts, and
// routes EACH across the three memory tiers (personal / repo:<slug> / agent:<name>) via
// the same classifier + descriptions used by /onboard-memory. Conservative by design:
// high precision over recall. On LLM failure it captures nothing — never guesses.
//
// This is the auto-capture safety net wired to the SessionEnd hook (hooks/memory-capture-hook.js,
// spawned detached/non-blocking): whatever durable facts surfaced during a session get persisted
// and correctly routed without the user having to run /onboard-memory by hand. Agents can also
// self-capture mid-session via brain-remember.js when they judge a specific fact relevant.
//
// Usage: node tools/memory-capture.js <transcript-path>
//
// The legacy pure helpers (buildCapturePrompt/parseCaptureFacts) are retained and still
// exported for the existing unit tests, but the orchestrator now delegates to the
// tier-aware extractAndRemember() so auto-capture and manual onboarding route identically.

import { existsSync } from 'node:fs';

import { extractAndRemember, readTranscriptText } from './memory-onboard.js';
import { parseFlagsOrExit } from './cli-args.js';
import { isMainModule } from './is-main.js';

const USAGE = 'Usage: node tools/memory-capture.js <transcript-path> [--dry-run] [--help]';
const MAX_FACTS = 5;

// Pure (legacy): build a personal-only extraction prompt. Retained for backward-compat
// tests; the live path uses memory-classify's tier-aware prompt via extractAndRemember.
export function buildCapturePrompt(transcriptText) {
  return [
    'You are a memory extraction engine reading a session transcript.',
    'Extract ONLY facts that are ALL of:',
    '  (a) durable — true beyond this session (preferences, decisions, stable context, corrections)',
    '  (b) specific — about the user or their project, not the task itself',
    '  (c) high-precision — you are certain, not inferring',
    '',
    'EXCLUDE: one-off task details, speculation, ephemeral state, things already obvious from code.',
    `Cap: at most ${MAX_FACTS} facts. If none qualify, output exactly: NONE`,
    '',
    'Output ONLY the facts as bullet lines prefixed with "- ". No preamble, no explanation.',
    '',
    '--- TRANSCRIPT START ---',
    transcriptText.slice(0, 8000),
    '--- TRANSCRIPT END ---',
  ].join('\n');
}

// Pure (legacy): parse bullet-line LLM output into fact strings.
export function parseCaptureFacts(text) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.toUpperCase() === 'NONE') return [];
  return trimmed.split('\n')
    .map(l => l.trim())
    .filter(l => /^[-*]\s+/.test(l))
    .map(l => l.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean)
    .slice(0, MAX_FACTS);
}

// Orchestrator: read transcript, extract + tier-route via extractAndRemember.
// On any failure → returns { ok: false, ... } without writing anything.
// llm: injectable — forwarded to extractAndRemember (pass a stub in tests).
export function captureFromTranscript(transcriptPath, { llm, section = 'Session Notes' } = {}) {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return { ok: false, message: `transcript not found: ${transcriptPath}`, written: [] };
  }

  let text;
  try {
    text = readTranscriptText(transcriptPath);
  } catch (e) {
    return { ok: false, message: `cannot read transcript: ${e.message}`, written: [] };
  }
  if (!text || !text.trim()) return { ok: true, extracted: 0, written: [], byTier: { personal: 0, repo: 0, agent: 0 } };

  const result = extractAndRemember(text, llm ? { section, llm } : { section });
  // Normalize to the historical { ok, extracted, written } shape (written = string[]).
  if (!result.ok) return result;
  return {
    ok: true,
    extracted: result.extracted,
    written: result.written.map(w => `[${w.tier}${w.target ? ':' + w.target : ''}] ${w.fact}`),
    byTier: result.byTier,
    warnings: result.warnings,
  };
}

const isMain = isMainModule(import.meta.url);

if (isMain) {
  const argv = process.argv.slice(2);
  const positional = argv.filter(a => !a.startsWith('-'));
  const flags = parseFlagsOrExit(argv.filter(a => a.startsWith('-')), { usage: USAGE, allowed: ['dry-run'] });
  const transcriptPath = positional[0];
  if (!transcriptPath) {
    console.error(USAGE);
    process.exit(2);
  }
  if (!existsSync(transcriptPath)) {
    console.error(`memory-capture: transcript not found: ${transcriptPath}`);
    process.exit(1);
  }
  if (flags['dry-run']) {
    console.log(`[dry-run] would extract + write facts from ${transcriptPath} (no writes performed)`);
    process.exit(0);
  }
  const r = captureFromTranscript(transcriptPath);
  if (!r.ok) { console.error(`memory-capture: ${r.message}`); process.exit(1); }
  console.log(`memory-capture: extracted ${r.extracted}, wrote ${r.written.length} new facts`);
  for (const f of r.written) console.log(`  + ${f}`);
}
