#!/usr/bin/env node
// log-rotate.js — #168 memory-hygiene: date-based archival for session-log.jsonl and
// in-place truncation for plain .log files (auto-capture.log).
//
// Different semantics from tools/rotate-logs.js (generation-suffix rotation of .jsonl
// files only, already wired to weekly-hygiene): this tool (a) archives oversized .jsonl
// logs into a dated file under an archive/ subdir and prunes archives older than
// --keep-days, and (b) truncates oversized plain .log files IN PLACE (keeping only the
// tail, since these are debug/trace logs where only recent context matters — unlike
// session-log.jsonl, which is an append-only record worth archiving, not discarding).
//
// Usage:
//   node tools/log-rotate.js [--dir=PATH] [--jsonl-threshold-kb=500] [--log-threshold-kb=100]
//                             [--keep-days=30] [--keep-tail-kb=20] [--dry-run]
//
// No npm deps (project convention for tools/**).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isMainModule } from './is-main.js';

function expandTilde(p) {
  return p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function parseArgs(argv) {
  const flags = {
    dir: '~/agent-memory/nexus',
    jsonlThresholdKb: 500,
    logThresholdKb: 100,
    keepDays: 30,
    keepTailKb: 20,
    dryRun: false,
  };
  for (const a of argv) {
    if (a === '--dry-run') flags.dryRun = true;
    else if (a.startsWith('--dir=')) flags.dir = a.slice('--dir='.length);
    else if (a.startsWith('--jsonl-threshold-kb=')) flags.jsonlThresholdKb = parseFloat(a.slice('--jsonl-threshold-kb='.length));
    else if (a.startsWith('--log-threshold-kb=')) flags.logThresholdKb = parseFloat(a.slice('--log-threshold-kb='.length));
    else if (a.startsWith('--keep-days=')) flags.keepDays = parseInt(a.slice('--keep-days='.length), 10);
    else if (a.startsWith('--keep-tail-kb=')) flags.keepTailKb = parseFloat(a.slice('--keep-tail-kb='.length));
  }
  return flags;
}

function dateStamp(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

/** Archive an oversized .jsonl file: move to archive/<name>.<date>.jsonl, leave a fresh
 * empty live file behind (the appender recreates it lazily otherwise, matching the
 * existing rotate-logs.js convention). Returns the archive path, or null if under threshold. */
export function archiveJsonl(filePath, thresholdBytes, { dryRun = false, now = new Date() } = {}) {
  if (!fs.existsSync(filePath)) return null;
  const size = fs.statSync(filePath).size;
  if (size <= thresholdBytes) return null;

  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const archiveDir = path.join(dir, 'archive');
  const archivePath = path.join(archiveDir, `${base}.${dateStamp(now)}`);

  if (!dryRun) {
    fs.mkdirSync(archiveDir, { recursive: true });
    // If today's archive already exists (rerun same day), append rather than clobber.
    if (fs.existsSync(archivePath)) {
      fs.appendFileSync(archivePath, fs.readFileSync(filePath));
      fs.writeFileSync(filePath, '');
    } else {
      fs.renameSync(filePath, archivePath);
      fs.writeFileSync(filePath, '');
    }
  }
  return archivePath;
}

/** Delete archived files older than keepDays (mtime-based). Returns list of deleted paths. */
export function pruneArchive(archiveDir, keepDays, { dryRun = false, now = new Date() } = {}) {
  if (!fs.existsSync(archiveDir)) return [];
  const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1000;
  const deleted = [];
  for (const name of fs.readdirSync(archiveDir)) {
    const fp = path.join(archiveDir, name);
    const stat = fs.statSync(fp);
    if (stat.isFile() && stat.mtimeMs < cutoff) {
      deleted.push(fp);
      if (!dryRun) fs.unlinkSync(fp);
    }
  }
  return deleted;
}

/** Truncate an oversized plain .log file in place, keeping only the last keepTailBytes. */
export function truncateLog(filePath, thresholdBytes, keepTailBytes, { dryRun = false } = {}) {
  if (!fs.existsSync(filePath)) return false;
  const size = fs.statSync(filePath).size;
  if (size <= thresholdBytes) return false;

  if (!dryRun) {
    const fd = fs.openSync(filePath, 'r');
    const tailSize = Math.min(keepTailBytes, size);
    const buf = Buffer.alloc(tailSize);
    fs.readSync(fd, buf, 0, tailSize, size - tailSize);
    fs.closeSync(fd);
    fs.writeFileSync(filePath, buf);
  }
  return true;
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const dir = path.resolve(expandTilde(flags.dir));
  const jsonlThreshold = flags.jsonlThresholdKb * 1024;
  const logThreshold = flags.logThresholdKb * 1024;
  const keepTailBytes = flags.keepTailKb * 1024;

  if (!fs.existsSync(dir)) {
    console.log(`[log-rotate] dir not found: ${dir} — nothing to do`);
    return;
  }

  // session-log.jsonl: archive with 30-day retention.
  const sessionLog = path.join(dir, 'session-log.jsonl');
  const archived = archiveJsonl(sessionLog, jsonlThreshold, { dryRun: flags.dryRun });
  if (archived) {
    console.log(`[log-rotate] ${flags.dryRun ? '[dry-run] would archive' : 'archived'} session-log.jsonl -> ${archived}`);
  } else {
    console.log(`[log-rotate] session-log.jsonl under ${flags.jsonlThresholdKb}KB — no archive needed`);
  }
  const pruned = pruneArchive(path.join(dir, 'archive'), flags.keepDays, { dryRun: flags.dryRun });
  for (const p of pruned) console.log(`[log-rotate] ${flags.dryRun ? '[dry-run] would delete' : 'deleted'} expired archive: ${p}`);

  // auto-capture.log: truncate in place, keep tail.
  const autoCapture = path.join(dir, 'auto-capture.log');
  const truncated = truncateLog(autoCapture, logThreshold, keepTailBytes, { dryRun: flags.dryRun });
  if (truncated) {
    console.log(`[log-rotate] ${flags.dryRun ? '[dry-run] would truncate' : 'truncated'} auto-capture.log to last ${flags.keepTailKb}KB`);
  } else {
    console.log(`[log-rotate] auto-capture.log under ${flags.logThresholdKb}KB — no truncation needed`);
  }
}

const isMain = isMainModule(import.meta.url);
if (isMain) main();
