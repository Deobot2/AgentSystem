#!/usr/bin/env node
// rotate-logs.js — size-based rotation for append-only .jsonl logs under ~/agent-memory/nexus/
// (session-log.jsonl and any sibling .jsonl logs), so they don't grow forever (#117).
//
// Rotation scheme: when a target file exceeds the threshold, shift numbered suffixes up
// (.4 -> .5, .3 -> .4, ...) then move the live file to `.1`, keeping at most --keep
// rotated generations (default 5) before the oldest is deleted. A fresh empty file is NOT
// recreated automatically here — the writer (session-cost.js / any appender) creates it
// again lazily on next append, matching existing behavior for a missing log file.
//
// Usage:
//   node tools/rotate-logs.js [--dir=PATH] [--threshold-mb=5] [--keep=5] [--dry-run]
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
  const flags = { dir: '~/agent-memory/nexus', thresholdMb: 5, keep: 5, dryRun: false };
  for (const a of argv) {
    if (a === '--dry-run') flags.dryRun = true;
    else if (a.startsWith('--dir=')) flags.dir = a.slice('--dir='.length);
    else if (a.startsWith('--threshold-mb=')) flags.thresholdMb = parseFloat(a.slice('--threshold-mb='.length));
    else if (a.startsWith('--keep=')) flags.keep = parseInt(a.slice('--keep='.length), 10);
  }
  return flags;
}

function rotateFile(filePath, keep, dryRun) {
  const actions = [];
  for (let i = keep; i >= 1; i--) {
    const src = i === 1 ? filePath : `${filePath}.${i - 1}`;
    const dest = `${filePath}.${i}`;
    if (fs.existsSync(src)) {
      if (i === keep && fs.existsSync(dest)) {
        actions.push(`delete ${dest}`);
        if (!dryRun) fs.unlinkSync(dest);
      }
      actions.push(`${src} -> ${dest}`);
      if (!dryRun) fs.renameSync(src, dest);
    }
  }
  return actions;
}

function findJsonlLogs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
    .map(e => path.join(dir, e.name));
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const dir = path.resolve(expandTilde(flags.dir));
  const thresholdBytes = flags.thresholdMb * 1024 * 1024;

  const logs = findJsonlLogs(dir);
  if (logs.length === 0) {
    console.log(`[rotate-logs] no .jsonl files found in ${dir}`);
    return;
  }

  let rotatedCount = 0;
  for (const logPath of logs) {
    const size = fs.statSync(logPath).size;
    if (size > thresholdBytes) {
      console.log(`[rotate-logs] ${logPath} is ${(size / 1024 / 1024).toFixed(2)} MB (> ${flags.thresholdMb} MB) — rotating`);
      const actions = rotateFile(logPath, flags.keep, flags.dryRun);
      actions.forEach(a => console.log(`  ${flags.dryRun ? '[dry-run] would' : 'did'}: ${a}`));
      rotatedCount++;
    }
  }
  if (rotatedCount === 0) {
    console.log(`[rotate-logs] all ${logs.length} .jsonl log(s) under threshold (${flags.thresholdMb} MB) — nothing rotated.`);
  }
}

export { rotateFile, findJsonlLogs };

const isMain = isMainModule(import.meta.url);
if (isMain) main();
