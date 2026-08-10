#!/usr/bin/env node
// session-cost-compute.js — compute real USD cost for a Claude Code session transcript.
//
// WHY THIS EXISTS: the Stop hook's stdin JSON does NOT contain cost_usd or usage fields
// (verified against the Claude Code hooks reference 2026-07-02) — only session_id,
// transcript_path, cwd, permission_mode, turn_number, stop_reason, and optionally
// agent_type/agent_id. Real per-turn token usage + model name live inside the
// transcript JSONL itself, on each `type: "assistant"` line's `message.usage` /
// `message.model`. This script reads that file and computes real cost from it —
// session-end.sh no longer guesses from fields that were never sent.
//
// Usage: node tools/session-cost-compute.js <transcript-path>
// Output (stdout): {"cost_usd": N, "in_tok": N, "out_tok": N, "models": {...}, "unknown_models": [...]}

import { existsSync, readFileSync } from 'node:fs';
import { isMainModule } from './is-main.js';

// USD per 1M tokens. Cache write/read prices follow Anthropic's standard multipliers
// of the base input price (5m write = 1.25x, 1h write = 2x, read = 0.1x) — confirmed
// convention, applied here explicitly per model since Claude Sonnet 5 has a
// time-limited introductory rate that the multiplier alone doesn't capture.
// Sonnet 5 intro pricing ($2/$10) runs through 2026-08-31; after that it reverts to
// $3/$15 — update SONNET_5_INTRO_ENDS or the standard-rate block if this drifts.
const SONNET_5_INTRO_ENDS = new Date('2026-08-31T23:59:59Z');

function sonnet5Pricing(now) {
  if (now <= SONNET_5_INTRO_ENDS) {
    return { input: 2.00, output: 10.00, cacheWrite5m: 2.50, cacheWrite1h: 4.00, cacheRead: 0.20 };
  }
  return { input: 3.00, output: 15.00, cacheWrite5m: 3.75, cacheWrite1h: 6.00, cacheRead: 0.30 };
}

export function buildPricingTable(now = new Date()) {
  return {
    'claude-opus-4-8':           { input: 5.00, output: 25.00, cacheWrite5m: 6.25, cacheWrite1h: 10.00, cacheRead: 0.50 },
    'claude-sonnet-5':           sonnet5Pricing(now),
    'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00,  cacheWrite5m: 1.25, cacheWrite1h: 2.00,  cacheRead: 0.10 },
    'claude-haiku-4-5':          { input: 1.00, output: 5.00,  cacheWrite5m: 1.25, cacheWrite1h: 2.00,  cacheRead: 0.10 },
  };
}

// Pure: parse transcript JSONL text into per-model usage totals.
// Includes sidechain turns (isSidechain: true) deliberately — those are in-session
// Agent-tool subagent dispatches (Ultron, Jarvis, etc.), and their spend is real spend
// against this session, not a separate one.
export function aggregateUsage(transcriptText) {
  const byModel = {};
  for (const line of transcriptText.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== 'assistant') continue;
    const model = obj.message?.model;
    const usage = obj.message?.usage;
    if (!model || !usage) continue;

    if (!byModel[model]) {
      byModel[model] = { input_tokens: 0, output_tokens: 0, cache_5m: 0, cache_1h: 0, cache_read: 0 };
    }
    const m = byModel[model];
    m.input_tokens += usage.input_tokens || 0;
    m.output_tokens += usage.output_tokens || 0;
    m.cache_read += usage.cache_read_input_tokens || 0;
    // cache_creation breaks 5m/1h out explicitly; fall back to lumping the (rare,
    // legacy-shape) flat cache_creation_input_tokens into the 5m bucket if the
    // breakdown object is absent, so no tokens are silently dropped from cost.
    if (usage.cache_creation) {
      m.cache_5m += usage.cache_creation.ephemeral_5m_input_tokens || 0;
      m.cache_1h += usage.cache_creation.ephemeral_1h_input_tokens || 0;
    } else if (usage.cache_creation_input_tokens) {
      m.cache_5m += usage.cache_creation_input_tokens;
    }
  }
  return byModel;
}

// Pure: price aggregated per-model usage. Unknown models are reported separately
// (not silently priced at $0 and not silently dropped) so a new/renamed model shows
// up as a visible gap instead of a quietly wrong total.
export function priceUsage(byModel, pricing) {
  let totalCost = 0, totalIn = 0, totalOut = 0;
  const unknownModels = [];
  const models = {};

  for (const [model, u] of Object.entries(byModel)) {
    totalIn += u.input_tokens;
    totalOut += u.output_tokens;

    const price = pricing[model];
    if (!price) {
      unknownModels.push(model);
      models[model] = { ...u, cost_usd: null };
      continue;
    }
    const cost =
      (u.input_tokens / 1_000_000) * price.input +
      (u.output_tokens / 1_000_000) * price.output +
      (u.cache_5m / 1_000_000) * price.cacheWrite5m +
      (u.cache_1h / 1_000_000) * price.cacheWrite1h +
      (u.cache_read / 1_000_000) * price.cacheRead;
    totalCost += cost;
    models[model] = { ...u, cost_usd: Math.round(cost * 1e6) / 1e6 };
  }

  return {
    cost_usd: Math.round(totalCost * 1e6) / 1e6,
    in_tok: totalIn,
    out_tok: totalOut,
    models,
    unknown_models: unknownModels,
  };
}

export function computeSessionCost(transcriptPath, { now = new Date() } = {}) {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return { ok: false, message: `transcript not found: ${transcriptPath}` };
  }
  const text = readFileSync(transcriptPath, 'utf8');
  const byModel = aggregateUsage(text);
  const priced = priceUsage(byModel, buildPricingTable(now));
  return { ok: true, ...priced };
}

function main() {
  const transcriptPath = process.argv[2];
  const result = computeSessionCost(transcriptPath);
  if (!result.ok) {
    console.error(`session-cost-compute: ${result.message}`);
    // Emit a zeroed record rather than nothing — session-end.sh always gets valid
    // JSON to log, even when the transcript can't be read.
    console.log(JSON.stringify({ cost_usd: 0, in_tok: 0, out_tok: 0, models: {}, unknown_models: [] }));
    process.exit(0);
  }
  console.log(JSON.stringify(result));
}

if (isMainModule(import.meta.url)) main();
