#!/usr/bin/env node
'use strict';
// Detects and fixes plugin-cache hash drift in ~/.claude/settings.json (stale
// installPath hash referenced in hook/statusLine commands after a plugin update
// rotates the cache dir), plus sweeps stale `.caveman-active.*` / `.in_use`
// marker files left behind in ~/.claude by crashed/interrupted sessions.
//
// Root cause (#116): plugin cache dirs are content-hashed
// (~/.claude/plugins/cache/<plugin>/<plugin>/<hash>/...). When a plugin updates,
// installed_plugins.json's hash advances but any hardcoded absolute paths in
// settings.json (hooks, statusLine) still point at the old hash dir, causing
// duplicate/stale skill registration and no-op hooks pointing at a directory
// that may eventually be GC'd.
//
// Usage:
//   node tools/caveman-cache-fix.js [--dry-run] [--home <path>]
//
// No npm deps (project convention for tools/**).

import fs from 'fs';
import path from 'path';
import os from 'os';

import { isMainModule } from './is-main.js';

function parseArgs(argv) {
  const args = { dryRun: false, home: os.homedir() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--home') args.home = argv[++i];
  }
  return args;
}

// Reads installed_plugins.json and returns { pluginName -> canonicalHash }.
function loadCanonicalHashes(claudeDir) {
  const p = path.join(claudeDir, 'plugins', 'installed_plugins.json');
  if (!fs.existsSync(p)) return {};
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  const plugins = data.plugins && typeof data.plugins === 'object' ? data.plugins : data;
  const out = {};
  for (const [key, entries] of Object.entries(plugins)) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const hash = entries[0].version || entries[0].gitCommitSha;
    if (hash) out[key] = String(hash).slice(0, 12);
  }
  return out;
}

// Finds stale cache-dir hash references in settings.json text and rewrites
// them to the canonical hash for that plugin, based on the
// .../cache/<plugin>/<plugin>/<hash>/ path shape.
function fixSettingsText(text, canonicalHashes) {
  let fixed = text;
  let changed = 0;
  const findings = [];
  const re = /cache[\\/]([a-zA-Z0-9_-]+)[\\/]\1[\\/]([0-9a-f]{8,40})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [full, plugin, hash] = m;
    const canonical = canonicalHashes[`${plugin}@${plugin}`];
    if (canonical && hash !== canonical) {
      const replacement = full.replace(hash, canonical);
      findings.push({ plugin, staleHash: hash, canonicalHash: canonical });
      fixed = fixed.split(full).join(replacement);
      changed++;
    }
  }
  return { fixed, changed, findings };
}

function sweepMarkers(claudeDir, dryRun) {
  const entries = fs.readdirSync(claudeDir, { withFileTypes: true });
  const markers = entries
    .filter(e => e.isFile() && (/^\.caveman-active\./.test(e.name) || /\.in_use$/.test(e.name)))
    .map(e => path.join(claudeDir, e.name));
  if (!dryRun) {
    for (const f of markers) {
      try { fs.unlinkSync(f); } catch { /* ignore races */ }
    }
  }
  return markers;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const claudeDir = path.join(args.home, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');

  const canonicalHashes = loadCanonicalHashes(claudeDir);
  const text = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : '';
  const { fixed, changed, findings } = fixSettingsText(text, canonicalHashes);

  if (changed > 0) {
    console.log(`[caveman-cache-fix] ${changed} stale cache-hash reference(s) found in settings.json:`);
    for (const f of findings) {
      console.log(`  ${f.plugin}: ${f.staleHash} -> ${f.canonicalHash}`);
    }
    if (!args.dryRun) {
      fs.writeFileSync(settingsPath, fixed, 'utf8');
      console.log('[caveman-cache-fix] settings.json updated.');
    } else {
      console.log('[caveman-cache-fix] --dry-run: no changes written.');
    }
  } else {
    console.log('[caveman-cache-fix] no stale cache-hash references found in settings.json.');
  }

  const markers = fs.existsSync(claudeDir) ? sweepMarkers(claudeDir, args.dryRun) : [];
  if (markers.length > 0) {
    console.log(`[caveman-cache-fix] ${args.dryRun ? 'found' : 'removed'} ${markers.length} stale marker file(s) (.caveman-active.*, *.in_use).`);
  } else {
    console.log('[caveman-cache-fix] no stale marker files found.');
  }
}

export { fixSettingsText, loadCanonicalHashes, sweepMarkers };

const isMain = isMainModule(import.meta.url);
if (isMain) main();
