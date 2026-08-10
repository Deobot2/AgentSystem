'use strict';
// SubagentStop (and Stop) hook — detached, non-blocking episodic write-back.
// Reads the session transcript, extracts {task, files, outcome, agent} and appends
// a SONA episodic entry so subagent work is captured in the memory bank.
// Mirrors the non-blocking detached pattern from memory-capture-hook.js — spawns
// the writer, unrefs, and exits 0 immediately. Never fails the harness.

const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
// #124: routing accuracy telemetry — reuse memory-router.js's promptHash algorithm and
// routing-log.jsonl writer verbatim (do NOT reimplement the hash) so the "actual agent"
// record we append here joins cleanly against the "hint" record memory-router.js already
// wrote for the same prompt.
const { promptHash, logRoutingEvent } = require('./memory-router');

// Deployed copies live in ~/.claude/hooks where "../tools" does not exist — every
// candidate is existence-checked so the hook works from both locations (2026-07-12 audit).
const TOOLS = [
  process.env.AGENT_TOOLS_ROOT,
  path.resolve(__dirname, '..', 'tools'),
  path.join(os.homedir(), 'dev', 'AgentSystem', 'tools'),
].find((p) => { try { return p && fs.existsSync(path.join(p, 'sona-episodic-write.js')); } catch { return false; } });

// Offset-tracking state file: this hook fires on every Stop/SubagentStop event, and a
// long session can accumulate a large transcript. Re-reading the whole file from byte 0
// on every fire is O(n^2) over a session. Instead we remember how many bytes we've
// already consumed per transcript and only read the new tail each time.
const STATE_DIR = path.join(os.homedir(), '.claude', 'hooks', '.state');
const OFFSETS_FILE = path.join(STATE_DIR, 'sona-writeback-offsets.json');

function loadOffsets() {
  try {
    return JSON.parse(fs.readFileSync(OFFSETS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveOffsets(offsets) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(OFFSETS_FILE, JSON.stringify(offsets));
  } catch {
    // Non-fatal — worst case we re-read from 0 next time.
  }
}

function offsetKey(transcriptPath) {
  return crypto.createHash('md5').update(transcriptPath).digest('hex');
}

// Read only the bytes appended to transcriptPath since the last recorded offset for it.
// Falls back to reading the whole file if the file shrank (rotated/truncated) or this is
// the first time we've seen it. Returns { text, newOffset }.
function readTranscriptTail(transcriptPath) {
  const stat = fs.statSync(transcriptPath);
  const offsets = loadOffsets();
  const key = offsetKey(transcriptPath);
  const lastOffset = offsets[key] || 0;

  let text;
  if (lastOffset > 0 && lastOffset <= stat.size) {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const len = stat.size - lastOffset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, lastOffset);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } else {
    // First read of this transcript, or file was rotated/truncated — read it all.
    text = fs.readFileSync(transcriptPath, 'utf8');
  }

  offsets[key] = stat.size;
  saveOffsets(offsets);
  return text;
}

// Parse a Claude Code JSONL transcript and extract episodic facts for SONA.
// Transcript format: newline-delimited JSON. Each line is one of:
//   { type: "queue-operation", ... }           — hook/system entries, skip
//   { parentUuid, isSidechain, message: { role, content: [...] }, ... }  — conversation turns
// Only the NEW bytes since the last invocation are read (see readTranscriptTail) — on a
// long session this turns an O(n) full-file read on every Stop/SubagentStop into an O(delta)
// read of just what's new.
// Returns { task, files, outcome, agent } or null on any failure.
function extractEpisodicFacts(transcriptPath) {
  try {
    const raw = readTranscriptTail(transcriptPath);

    // JSONL: split on newlines, parse each line individually.
    const lines = raw.split('\n').filter(l => l.trim());
    const turns = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        // Only keep conversation turns (have a .message with .role).
        if (parsed && parsed.message && parsed.message.role) {
          turns.push(parsed.message);
        }
      } catch {
        // Malformed line — skip.
      }
    }

    if (turns.length === 0) return null;

    let outcome = 'unknown';
    let task = 'subagent task';
    let agent = 'unknown';
    const touchedFiles = new Set();

    // Scan backwards: find assistant's last DONE/BLOCKED status line.
    for (let i = turns.length - 1; i >= 0; i--) {
      const msg = turns[i];
      if (!msg || !msg.content) continue;

      const contentArr = Array.isArray(msg.content) ? msg.content : [msg.content];
      for (const block of contentArr) {
        const text = typeof block === 'string' ? block :
          (block && block.type === 'text' ? block.text : '');
        if (!text) continue;

        if (outcome === 'unknown') {
          if (/^DONE:/m.test(text)) {
            outcome = 'done';
            const m = text.match(/^DONE:\s*(.+)$/m);
            if (m) task = m[1].trim().slice(0, 120);
          } else if (/^BLOCKED:/m.test(text)) {
            outcome = 'blocked';
            const m = text.match(/^BLOCKED:\s*(.+)$/m);
            if (m) task = m[1].trim().slice(0, 120);
          }
        }
      }

      // Look for agent name in tool_use blocks (subagent invocations carry .input.agent).
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && block.type === 'tool_use' && block.name === 'agent') {
            agent = (block.input && block.input.agent) || agent;
          }
        }
      }
    }

    // Collect file paths from Edit/Write/Read tool_use blocks in all turns.
    for (const msg of turns) {
      if (!msg || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (!block || block.type !== 'tool_use') continue;
        const filePath = block.input && (block.input.file_path || block.input.path);
        if (filePath && typeof filePath === 'string') {
          const parts = filePath.replace(/\\/g, '/').split('/');
          const rel = parts.slice(-3).join('/');
          touchedFiles.add(rel);
        }
      }
    }

    const files = [...touchedFiles].slice(0, 10).join(', ') || 'none';

    // #155 / 2026-07-12 audit: only persist entries with an explicit DONE:/BLOCKED:
    // status line. The old OR-guard (any of outcome/files/agent known) let
    // outcome=unknown, task="subagent task" rows through whenever a file was touched —
    // that produced ~400 junk entries dominating sona-patterns.md. Outcome is the field
    // that makes an episodic pattern actionable on retrieval; without it, skip.
    if (outcome === 'unknown') return null;

    return { task, files, outcome, agent };
  } catch {
    return null;
  }
}

// #124: find the FIRST user-turn's text in the transcript (not just the newly-read tail —
// the tail-offset optimization above exists for episodic extraction, but the first user
// prompt may have scrolled out of the "new bytes" window by the time Stop fires, so this
// reads the transcript independently). Returns the raw prompt text, or null if none found.
//
// #351: this used to be what logRoutingActual() hashed for the join key, but `Stop` (and
// `SubagentStop`) fire once per completed turn, not once per session — so on turn 2+ this
// re-hashes the SAME turn-1 text every time, while memory-router.js's hint record for that
// turn hashes the CURRENT turn's prompt. The two promptHashes only coincide on a session's
// first turn, which is why the #351 audit found only 2/241 hint hashes joining to an actual
// row. Kept here (and still exported/tested) because it is still the right text for anything
// that wants "what was this session originally about"; routing uses extractLastUserPromptText
// instead — see below.
function extractFirstUserPromptText(transcriptPath) {
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const lines = raw.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const msg = parsed && parsed.message;
      if (!msg || msg.role !== 'user') continue;
      const contentArr = Array.isArray(msg.content) ? msg.content : [msg.content];
      for (const block of contentArr) {
        const text = typeof block === 'string' ? block :
          (block && block.type === 'text' ? block.text : '');
        if (text && text.trim()) return text;
      }
    }
  } catch {
    // Non-fatal — routing telemetry is best-effort.
  }
  return null;
}

// #351: find the LAST user-turn's text in the transcript — the prompt that belongs to the
// turn which just completed and triggered this Stop/SubagentStop event. This is the text
// memory-router.js hashed for the hint record it wrote at the START of this same turn
// (UserPromptSubmit fires before the turn runs; Stop fires after), so hashing the same text
// here is what makes the hint and actual-agent rows share a promptHash and actually join.
function extractLastUserPromptText(transcriptPath) {
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const msg = parsed && parsed.message;
      if (!msg || msg.role !== 'user') continue;
      const contentArr = Array.isArray(msg.content) ? msg.content : [msg.content];
      for (const block of contentArr) {
        const text = typeof block === 'string' ? block :
          (block && block.type === 'text' ? block.text : '');
        if (text && text.trim()) return text;
      }
    }
  } catch {
    // Non-fatal — routing telemetry is best-effort.
  }
  return null;
}

// #124: append the "actual agent used" half of the routing-accuracy telemetry pair to
// routing-log.jsonl, keyed by the same promptHash memory-router.js used for its hint record.
// Never throws — telemetry must never affect the episodic write-back it rides alongside.
function logRoutingActual(facts, transcriptPath) {
  try {
    // #351: hash the LAST user prompt (the turn that just completed), not the first — see
    // extractLastUserPromptText's comment for why that's the one memory-router.js's hint
    // record for this turn actually shares a promptHash with.
    const lastPrompt = extractLastUserPromptText(transcriptPath);
    if (!lastPrompt) return;
    logRoutingEvent({
      ts: new Date().toISOString(),
      promptHash: promptHash(lastPrompt),
      agent: (facts && facts.agent) || 'unknown',
    });
  } catch {
    // Non-fatal.
  }
}

// Write an episodic node directly to sona-patterns.md (no CLI arg constraints).
function writeEpisodicNode(facts, transcriptPath) {
  const writerScript = path.join(TOOLS, 'sona-episodic-write.js');
  const args = [
    writerScript,
    `--task=${facts.task}`,
    `--files=${facts.files}`,
    `--outcome=${facts.outcome}`,
    `--agent=${facts.agent}`,
  ];

  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch {
    // spawn failure is non-fatal.
  }
}

// #118: extraction (transcript tail read + JSONL parse) used to run synchronously on the
// main hook process before it could exit. On a slow cold start or a large transcript delta
// this can exceed the hook's configured timeout (5s in settings.json), silently dropping the
// episodic write when the harness kills the process. Fix: do NOT extract inline. Immediately
// re-spawn this same script in a detached `--worker` mode that does the extraction AND the
// write-back, then exit the foreground process with 'OK' right away — mirroring the existing
// fire-and-forget pattern already used by hooks/memory-capture-hook.js.
if (require.main === module) {
  // Recursion guard: headless `claude -p` sessions spawned by the memory pipeline set
  // this env var — their Stop hooks must not trigger another episodic write-back.
  if (process.env.AGENT_MEMORY_CAPTURE === '1' && !process.argv.includes('--worker')) {
    process.stdout.write('OK');
    process.exit(0);
  }

  const workerFlagIdx = process.argv.indexOf('--worker');

  if (workerFlagIdx !== -1) {
    // Detached worker mode: argv[workerFlagIdx + 1] is the transcript path.
    const transcriptPath = process.argv[workerFlagIdx + 1];
    try {
      if (transcriptPath) {
        const facts = extractEpisodicFacts(transcriptPath);
        if (facts) {
          writeEpisodicNode(facts, transcriptPath);
          logRoutingActual(facts, transcriptPath);
        }
      }
    } catch {
      // Non-fatal — worker has no one to report to.
    }
    process.exit(0);
  }

  let transcriptPath = null;

  try {
    const raw = fs.readFileSync(0, 'utf8');
    const payload = JSON.parse(raw);
    transcriptPath = payload.transcript_path || null;
  } catch {
    process.stdout.write('OK');
    process.exit(0);
  }

  if (!transcriptPath) {
    process.stdout.write('OK');
    process.exit(0);
  }

  try {
    const child = spawn(process.execPath, [__filename, '--worker', transcriptPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch {
    // Non-fatal — never block session end.
  }

  process.stdout.write('OK');
}

module.exports = {
  extractEpisodicFacts, extractFirstUserPromptText, extractLastUserPromptText,
  logRoutingActual, writeEpisodicNode,
};
