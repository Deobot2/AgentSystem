#!/usr/bin/env node
// bootstrap-repo.js — Cross-platform repo onboarding for the AgentSystem (Linux/Mac/Windows).
// Idempotent — safe to re-run.
//
// Single repo:
//   node tools/bootstrap-repo.js [repoPath] [--slug=name] [--install-deps] [--skip-graph]
// All git repos under a directory (also ensures the global brains exist):
//   node tools/bootstrap-repo.js --all [scanDir] [--depth=3] [--skip-graph]
//
// "Onboarding agent memory" = graph-init (repo brain) + register in known-repos.json.
// The global agent-brain / personal-brain are created once in --all mode.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { agentMemoryRoot } from './graph/graph-lib.js';
import { readRegistry, writeRegistry, upsertRepo } from './graph/known-repos.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS = __dirname;
const BLOCK_TEMPLATE = join(TOOLS, 'claude-md-block.txt');
const GRAPH_INIT = join(TOOLS, 'graph', 'graph-init.js');
const REGISTRY = join(agentMemoryRoot(), 'nexus', 'known-repos.json');

function log(msg) { console.log(msg); }
function warn(msg) { console.warn(`[WARN] ${msg}`); }

// ---- arg parsing ----------------------------------------------------------
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (const a of argv) {
  if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags[k] = v ?? true; }
  else positional.push(a);
}

function slugify(name) {
  return name.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

function isGitRepo(p) {
  // .git is a directory in a normal clone, a file in a worktree/submodule.
  return existsSync(join(p, '.git'));
}

function gitConfig(key) {
  try { return execFileSync('git', ['config', key], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
}

// ---- CLAUDE.md block injection (idempotent) -------------------------------
const MARKER = 'AGENT-SYSTEM-BOOTSTRAP';
function injectClaudeMd(repoPath, slug) {
  const cmPath = join(repoPath, 'CLAUDE.md');
  if (existsSync(cmPath) && readFileSync(cmPath, 'utf8').includes(MARKER)) return 'block exists';
  if (!existsSync(BLOCK_TEMPLATE)) { warn(`template missing: ${BLOCK_TEMPLATE}`); return 'skipped (no template)'; }
  const block = readFileSync(BLOCK_TEMPLATE, 'utf8').replace(/\{\{SLUG\}\}/g, slug);
  if (existsSync(cmPath)) { appendFileSync(cmPath, `\n${block}\n`, 'utf8'); return 'appended'; }
  writeFileSync(cmPath, `# ${slug}\n\n${block}\n`, 'utf8'); return 'created';
}

// ---- gitignore the local decaying brain (idempotent) ----------------------
function ignoreNexus(repoPath) {
  const giPath = join(repoPath, '.gitignore');
  const has = existsSync(giPath) && readFileSync(giPath, 'utf8').split(/\r?\n/).some(l => l.trim().replace(/\/$/, '') === 'nexus');
  if (has) return 'already';
  appendFileSync(giPath, `\n# AgentSystem local graph brain (decaying memory — not committed)\nnexus/\n`, 'utf8');
  return 'added';
}

// ---- optional dependency install ------------------------------------------
function maybeInstallDeps(repoPath) {
  const run = (cmd, args) => { try { execFileSync(cmd, args, { cwd: repoPath, stdio: 'ignore' }); return true; } catch { return false; } };
  if (existsSync(join(repoPath, 'package.json'))) { log('  deps: npm install'); if (!run('npm', ['install', '--silent'])) warn('npm install failed (non-fatal)'); }
  if (existsSync(join(repoPath, 'requirements.txt'))) { log('  deps: pip install'); if (!run('pip', ['install', '-r', join(repoPath, 'requirements.txt'), '-q'])) warn('pip install failed (non-fatal)'); }
  if (existsSync(join(repoPath, 'go.mod'))) { log('  deps: go mod download'); if (!run('go', ['mod', 'download'])) warn('go mod download failed (non-fatal)'); }
}

// ---- graph-init (repo brain) ----------------------------------------------
function graphInit(repoPath, slug) {
  if (!existsSync(GRAPH_INIT)) { warn(`graph-init.js not found at ${GRAPH_INIT}`); return false; }
  try {
    const out = execFileSync('node', [GRAPH_INIT, slug, repoPath], { encoding: 'utf8' });
    const line = out.trim().split('\n').filter(Boolean).pop() || '';
    if (line) log(`  ${line}`);
    return true;
  } catch (e) { warn(`graph-init failed (non-fatal): ${e.message}`); return false; }
}

// ---- bootstrap one repo ---------------------------------------------------
function bootstrapRepo(repoPathRaw, opts = {}) {
  const repoPath = resolve(repoPathRaw);
  const slug = opts.slug || slugify(basename(repoPath));
  log(`\nBootstrap: ${slug} @ ${repoPath}`);

  const git = isGitRepo(repoPath);
  if (!git) { warn('not a git repo — skipping graph-init/gitignore, CLAUDE.md + registry only'); }

  if (opts.installDeps) maybeInstallDeps(repoPath);

  const cm = injectClaudeMd(repoPath, slug);
  log(`  CLAUDE.md: ${cm}`);

  if (git) log(`  .gitignore nexus/: ${ignoreNexus(repoPath)}`);

  let brainOk = false;
  if (git && !opts.skipGraph) brainOk = graphInit(repoPath, slug);
  else if (opts.skipGraph) log('  graph-init: skipped (--skip-graph)');

  let reg = readRegistry(REGISTRY);
  reg = upsertRepo(reg, { slug, path: repoPath.replace(/\\/g, '/'), primary_cli: 'claude' });
  writeRegistry(REGISTRY, reg);
  log(`  registered: ${slug} → ${REGISTRY}`);

  return { slug, repoPath, git, brainOk };
}

// ---- discover git repos under a dir ---------------------------------------
function discoverRepos(dir, depth) {
  const found = [];
  function walk(d, lvl) {
    if (lvl > depth) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    if (existsSync(join(d, '.git'))) { found.push(d); return; } // don't descend into a repo
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules' || e.name === 'nexus' || e.name.startsWith('.')) continue;
      walk(join(d, e.name), lvl + 1);
    }
  }
  walk(resolve(dir), 0);
  return found;
}

// ---- ensure global brains exist (--all) -----------------------------------
function ensureGlobalBrains() {
  const nexus = join(agentMemoryRoot(), 'nexus');
  const node = (script, args) => { try { execFileSync('node', [join(TOOLS, script), ...args], { encoding: 'utf8' }); return true; } catch (e) { warn(`${script}: ${e.message}`); return false; } };
  if (!existsSync(join(nexus, 'agent-brain', 'graph.json'))) { log('Global: init agent-brain'); node('graph/agent-brain-init.js', []); }
  else log('Global: agent-brain exists');
  if (!existsSync(join(nexus, 'personal-brain', 'user-brain.md'))) {
    const name = gitConfig('user.name') || 'User';
    const email = gitConfig('user.email') || '';
    log('Global: init personal-brain');
    node('personal-brain-init.js', [`--name=${name}`, `--email=${email}`]);
  } else log('Global: personal-brain exists');
}

// ---- main -----------------------------------------------------------------
const opts = { skipGraph: !!flags['skip-graph'], installDeps: !!flags['install-deps'], slug: flags.slug };

if (flags.all !== undefined) {
  const scanDir = (typeof flags.all === 'string' ? flags.all : positional[0]) || process.cwd();
  const depth = parseInt(flags.depth || '3', 10);
  ensureGlobalBrains();
  const repos = discoverRepos(scanDir, depth);
  log(`\nDiscovered ${repos.length} git repo(s) under ${resolve(scanDir)} (depth ${depth})`);
  const results = repos.map(r => bootstrapRepo(r, opts));
  log(`\n=== Onboarded ${results.length} repo(s): ${results.map(r => r.slug).join(', ')} ===`);
} else {
  bootstrapRepo(positional[0] || process.cwd(), opts);
  log('\nBootstrap complete.');
}
