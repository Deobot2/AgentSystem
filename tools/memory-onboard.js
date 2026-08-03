#!/usr/bin/env node
// memory-onboard.js — onboard memory facts from prompts, messages, or sessions.
//
// Three input modes (pick one):
//   --text="..."        Raw text (prompt/message) to extract facts from via LLM
//   --session=ID        Session ID (prefix OK) — resolves transcript via session-registry
//   --fact="..."        Write a single known fact directly (no LLM)
//
// Stdin mode: pipe text when none of the above flags are given.
//
// Usage:
//   node tools/memory-onboard.js --fact="I always use TypeScript strict mode"
//   node tools/memory-onboard.js --session=abc123 [--section="Preferences"]
//   node tools/memory-onboard.js --text="I always deploy to Railway, not Vercel"
//   echo "conversation text" | node tools/memory-onboard.js
//
// --section defaults to "Session Notes". Override per-call.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';

import { remember } from './brain-remember.js';
import { buildClassifyPrompt, parseClassifiedFacts, AGENT_ROSTER } from './memory-classify.js';
import { agentMemoryRoot } from './graph/graph-lib.js';
import { readRegistry } from './graph/known-repos.js';
import { isMainModule } from './is-main.js';

const HOME     = homedir();
const REGISTRY = join(HOME, 'agent-memory', 'nexus', 'session-registry.jsonl');
const PROJECTS = join(HOME, '.claude', 'projects');

// ── Registry helpers ──────────────────────────────────────────────────────────

function loadRegistry() {
  if (!existsSync(REGISTRY)) return [];
  return readFileSync(REGISTRY, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/**
 * Resolve a session ID (or prefix) to { filePath, entry }.
 * Checks registry cwd first, then scans all project dirs.
 * Returns null if not found.
 */
function resolveTranscript(sessionIdOrPrefix) {
  const registry = loadRegistry();

  // Find matching entry (exact or prefix)
  const entry = registry.find(e => e.session === sessionIdOrPrefix)
             || registry.find(e => e.session.startsWith(sessionIdOrPrefix));
  if (!entry) return null;

  const { session, cwd } = entry;

  // Fast path: use registry cwd
  if (cwd) {
    const dirName  = cwd.replace(/\//g, '-');
    const candidate = join(PROJECTS, dirName, `${session}.jsonl`);
    const resolved = resolve(candidate);
    if (!resolved.startsWith(PROJECTS)) {
      return null;
    }
    if (existsSync(candidate)) return { filePath: candidate, entry };
  }

  // Fallback: scan all project dirs
  if (!existsSync(PROJECTS)) return null;
  for (const dirName of readdirSync(PROJECTS)) {
    const fp = join(PROJECTS, dirName, `${session}.jsonl`);
    if (existsSync(fp)) return { filePath: fp, entry };
  }
  return null;
}

// ── Transcript text extraction ───────────────────────────────────────────────

/** Read a session transcript JSONL and return concatenated message text. */
export function readTranscriptText(filePath) {
  const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const texts = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      // Claude Code format
      if (typeof obj.message?.content === 'string' && obj.message.content.trim()) {
        texts.push(obj.message.content.trim());
      }
      // Antigravity format
      else if (obj.source === 'USER_EXPLICIT' && obj.content) {
        const m = obj.content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
        if (m) texts.push(m[1].trim());
      }
    } catch { /* skip malformed lines */ }
  }
  if (texts.length) return texts.join('\n\n');
  // Plain-text transcript (not JSONL): no line parsed as JSON — return raw content.
  const raw = lines.join('\n').trim();
  const looksJsonl = lines.length > 0 && lines.every(l => l.trimStart().startsWith('{'));
  return looksJsonl ? '' : raw;
}

// ── LLM extraction (same contract as memory-capture.js) ──────────────────────

/** Injectable LLM — defaults to `claude -p` (no API key required).
 * Reverted from haiku to sonnet 2026-07-03: haiku's extraction recall was noticeably
 * worse on dense, multi-entity pastes (a paste with ~16 distinct facts only extracted
 * 6; a paste with 8 well-separated facts extracted cleanly) -- this feature preserves
 * data, so recall matters more than the cost delta memory-capture/reconcile/reflect
 * can safely absorb. Kept token-efficient without dropping to haiku: --effort low
 * (this is extraction, not deep reasoning -- see claude-api skill's effort guidance)
 * and --exclude-dynamic-system-prompt-sections (drops per-machine system-prompt
 * bloat -- cwd/env/memory-path/git-status sections -- from every single call).
 * Deliberately NOT --bare: this machine has no ANTHROPIC_API_KEY set, and --bare
 * disables OAuth/keychain auth entirely -- would break every call outright. */
export const defaultLlm = (prompt) =>
  execFileSync('claude', [
    '-p', prompt,
    '--model', 'claude-sonnet-5',
    '--effort', 'low',
    '--exclude-dynamic-system-prompt-sections',
  ], {
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
    // Guard: hooks inside this headless session must not re-trigger memory capture.
    env: { ...process.env, AGENT_MEMORY_CAPTURE: '1' },
  });

/**
 * Extract durable facts from free text, classify each by tier, and write via remember().
 * Returns { ok, extracted, written, byTier, warnings } or { ok: false, message, written }.
 */
export function extractAndRemember(text, { section = 'Session Notes', llm = defaultLlm } = {}) {
  if (!text || !text.trim()) return { ok: true, extracted: 0, written: [], byTier: { personal: 0, repo: 0, agent: 0 }, warnings: [] };

  const registryPath = join(agentMemoryRoot(), 'nexus', 'known-repos.json');
  // Pass full { slug, description } objects so the classifier can match a fact to a
  // repo by what the repo IS, not just its slug spelling (fixes product-vs-business-logic
  // repos like genie/genie-brain and basely/basely-brain being routed by name alone).
  const repos = readRegistry(registryPath).repos.map(r => ({ slug: r.slug, description: r.description || '' }));

  const prompt = buildClassifyPrompt(text, { repos, agents: AGENT_ROSTER });
  let raw;
  try { raw = llm(prompt); }
  catch (e) { return { ok: false, message: `llm failed: ${e.message}`, written: [] }; }

  const classified = parseClassifiedFacts(raw, { repos, agents: AGENT_ROSTER });
  const written = [];
  const byTier = { personal: 0, repo: 0, agent: 0 };
  const warnings = [];

  for (const { fact, tier, target } of classified) {
    try {
      const r = remember({ fact, section, tier, target });
      if (r.ok && r.added) { written.push({ fact, tier, target }); byTier[tier]++; }
      else if (!r.ok) { warnings.push(r.message); }
    } catch (e) {
      warnings.push(`${fact}: ${e.message}`);
    }
  }
  return { ok: true, extracted: classified.length, written, byTier, warnings };
}

// ── Stdin reader ──────────────────────────────────────────────────────────────

function readStdin() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) { resolve(null); return; }
    const lines = [];
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on('line',  l => lines.push(l));
    rl.on('close', () => resolve(lines.join('\n').trim() || null));
  });
}

// ── Result printer ────────────────────────────────────────────────────────────

function printResult(result) {
  if (!result.ok) { console.error(`memory-onboard: ${result.message}`); return; }
  if (result.extracted === 0) { console.log('no durable facts extracted'); return; }

  const parts = [];
  if (result.byTier.personal) parts.push(`${result.byTier.personal} → personal-brain`);
  if (result.byTier.repo) parts.push(`${result.byTier.repo} → repo`);
  if (result.byTier.agent) parts.push(`${result.byTier.agent} → agent`);

  console.log(`extracted ${result.extracted} candidate(s), stored ${result.written.length} new fact(s): ${parts.join(', ')}`);
  for (const w of result.written) console.log(`  + [${w.tier}${w.target ? ':' + w.target : ''}] ${w.fact}`);
  const skipped = result.extracted - result.written.length;
  if (skipped > 0) console.log(`  (${skipped} already known or skipped)`);
  for (const w of (result.warnings || [])) console.log(`  ! ${w}`);
}

// ── CLI entry point ───────────────────────────────────────────────────────────

const isMain = isMainModule(import.meta.url);

if (isMain) {
  const flags = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([\w-]+)(?:=(.*))?$/);
    if (m) flags[m[1]] = m[2] !== undefined ? m[2] : true;
  }

  const section = typeof flags.section === 'string' ? flags.section : 'Session Notes';

  (async () => {
    // ── Mode 1: --fact — direct write, no LLM ──────────────────────────────
    if (flags.fact) {
      const fact = String(flags.fact).trim();
      if (!fact) { console.error('--fact value is empty'); process.exit(1); }
      const r = remember({ fact, section });
      if (!r.ok) { console.error(`memory-onboard: ${r.message}`); process.exit(1); }
      if (r.added) console.log(`remembered [${section}]: ${fact}`);
      else         console.log(`already known (skipped): ${fact}`);
      process.exit(0);
    }

    // ── Mode 2: --session=ID — resolve transcript and extract ───────────────
    if (flags.session) {
      const sessionId = String(flags.session);
      const found = resolveTranscript(sessionId);
      if (!found) {
        console.error(`session not found: ${sessionId}`);
        console.error('Tip: node tools/session-namer.js --scan  to index sessions first');
        process.exit(1);
      }
      const label = found.entry.name || found.entry.session.slice(0, 8) + '…';
      console.log(`extracting from session: ${label}`);
      const text = readTranscriptText(found.filePath);
      if (!text.trim()) { console.log('transcript appears empty — nothing to extract'); process.exit(0); }
      const result = extractAndRemember(text, { section });
      printResult(result);
      process.exit(result.ok ? 0 : 1);
    }

    // ── Mode 3: --text — inline text ────────────────────────────────────────
    if (flags.text) {
      const text = String(flags.text).trim();
      if (!text) { console.error('--text value is empty'); process.exit(1); }
      const result = extractAndRemember(text, { section });
      printResult(result);
      process.exit(result.ok ? 0 : 1);
    }

    // ── Mode 4: stdin ────────────────────────────────────────────────────────
    const stdin = await readStdin();
    if (stdin) {
      const result = extractAndRemember(stdin, { section });
      printResult(result);
      process.exit(result.ok ? 0 : 1);
    }

    // ── No input — show help ─────────────────────────────────────────────────
    console.log(`memory-onboard.js — extract and store memory from prompts or sessions

Modes (pick one):
  --fact="..."         Write a single fact directly (no LLM)
  --session=ID         Extract from a session transcript (ID prefix OK)
  --text="..."         Extract facts from inline text via LLM
  <stdin>              Pipe text to extract from

Options:
  --section="..."      Target section in user-brain.md (default: "Session Notes")

Examples:
  node tools/memory-onboard.js --fact="prefers TypeScript strict mode"
  node tools/memory-onboard.js --session=abc123
  node tools/memory-onboard.js --text="deploy target is Railway, not Vercel"
  echo "conversation" | node tools/memory-onboard.js --section="Preferences"
`);
  })();
}
