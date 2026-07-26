#!/usr/bin/env node
/**
 * sync-agents.js -- Cross-platform agent sync (Linux/Mac/Windows)
 * Replicates sync_agents_from_repo.ps1 in Node.js.
 * Usage: node tools/sync-agents.js
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = join(__dirname, '..');
const AGENTS_DIR = join(REPO_ROOT, '.agents', 'agents');
const CONFIG_DIR = join(REPO_ROOT, 'config');
const HOME       = homedir();

// Model assignments per CLI. Authoritative — this table is what actually ships.
// It used to "mirror config/models.yml"; that file was read by nothing (its only
// consumer, agent-context-inject.js, was never written) so it has been deleted
// rather than left as a second copy to drift against.
// ultron/pym/leo/astra are tier-1 specialist workers (downgraded to cheapest tier in ede47b6).
const MODELS = {
  claude:  { jarvis:'claude-opus-4-8', sam:'claude-sonnet-5', friday:'claude-sonnet-5', nat:'claude-sonnet-5', ultron:'claude-haiku-4-5-20251001', pym:'claude-haiku-4-5-20251001', leo:'claude-haiku-4-5-20251001', astra:'claude-haiku-4-5-20251001', wanda:'claude-haiku-4-5-20251001', threepio:'claude-haiku-4-5-20251001', r2d2:'claude-haiku-4-5-20251001' },
  gemini:  { jarvis:'gemini-3.1-pro-preview', sam:'gemini-3.1-pro-preview', friday:'gemini-3-flash-preview', nat:'gemini-3-flash-preview', ultron:'gemini-3.1-flash-lite-preview', pym:'gemini-3.1-flash-lite-preview', leo:'gemini-3.1-flash-lite-preview', astra:'gemini-3.1-flash-lite-preview', wanda:'gemini-3.1-flash-lite-preview', threepio:'gemini-3.1-flash-lite-preview', r2d2:'gemini-3.1-flash-lite-preview' },
};

const SYNC_LOG = join(REPO_ROOT, '.agents', 'sync.log');
function logLine(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] [sync-agents.js] ${msg}\n`;
  try { writeFileSync(SYNC_LOG, line, { flag: 'a' }); } catch { /* best-effort */ }
}

function ok(msg)   { console.log('[SUCCESS]', msg); logLine('SUCCESS', msg); }
function info(msg) { console.log('[INFO]', msg); logLine('INFO', msg); }
function warn(msg) { console.warn('[WARN]', msg); logLine('ERROR', msg); }

function parseFrontmatter(content) {
  // Source files are CRLF (Windows-authored); frontmatter fence is "---\r\n", not "---\n".
  // A CRLF-blind regex here silently fails to match -- meta ends up {} and any agent not
  // in the MODELS map (e.g. clarification-needed) is deployed with an empty model: line.
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return meta;
}

function setModel(content, model) {
  return content.replace(/^(model:\s*).*$/m, `$1${model}`);
}

function stripFrontmatter(content) {
  return content.replace(/^---[\s\S]*?---\r?\n/, '');
}

export { parseFrontmatter, stripFrontmatter, stripToolsLine };

// Remove the `tools:` line from the frontmatter block.
// Our agent defs list abstract tool names (github-cli, bash, git, npm, docker, figma, ...)
// that are NOT valid Claude Code / Gemini tool identifiers. A subagent loaded with an
// allowlist of unrecognized names ends up with ZERO usable tools, so it hallucinates
// `<function_calls>` as plain text instead of executing anything. Omitting `tools:`
// makes the agent inherit full/default tool access (Bash, MCPs, sub-agent spawn).
// Antigravity strips it too (builds fresh frontmatter without tools).
function stripToolsLine(content) {
  // Source agent defs are CRLF (Windows-authored) -- the frontmatter fence is "---\r\n",
  // not "---\n". A CRLF-only regex here silently fails to match, `stripToolsLine` returns
  // content UNCHANGED, and the tools: allowlist survives into the synced file -- which is
  // exactly the hallucination failure mode described in the comment above. Confirmed live:
  // this exact bug reintroduced tools: into all 11 synced agents when sync-agents.js was
  // re-run 2026-07-02, and a spawned Ultron with a real-tool-shaped-but-invalid allowlist
  // fabricated an entire fictional tool-call transcript (zero actual tool_uses) rather than
  // doing any work.
  const m = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!m) return content;
  const fmBody = m[2].split(/\r?\n/).filter(l => !/^tools:/.test(l)).join('\n');
  return m[1] + fmBody + m[3] + content.slice(m[0].length);
}

function ensureDir(p) { mkdirSync(p, { recursive: true }); }

// Shared-block expansion: .agents/rules/shared-blocks.md holds the canonical text of
// sections duplicated across many agent files (Operating Discipline, swarm-sizing, ...).
// Agent .md sources carry empty marker pairs `<!-- SHARED:name --> <!-- /SHARED:name -->`;
// at sync time we inject the canonical text between the markers (re-indented to match the
// marker line) before writing to any platform dir. Unknown block names fail loudly and the
// marker pair is left as-is (skip injection, do not abort the sync).
const SHARED_BLOCKS_FILE = join(REPO_ROOT, '.agents', 'rules', 'shared-blocks.md');
function loadSharedBlocks() {
  if (!existsSync(SHARED_BLOCKS_FILE)) return {};
  const txt = readFileSync(SHARED_BLOCKS_FILE, 'utf8');
  const blocks = {};
  const re = /<!-- SHARED:([\w-]+) -->\r?\n([\s\S]*?)<!-- \/SHARED:\1 -->/g;
  for (let m; (m = re.exec(txt)); ) blocks[m[1]] = m[2].replace(/\r?\n$/, '');
  return blocks;
}
const SHARED_BLOCKS = loadSharedBlocks();
function expandSharedBlocks(content, file) {
  return content.replace(
    /([ \t]*)<!-- SHARED:([\w-]+) -->[\s\S]*?<!-- \/SHARED:\2 -->/g,
    (full, indent, name) => {
      if (!(name in SHARED_BLOCKS)) {
        console.error(`[ERROR] ${file}: unknown shared block "${name}" -- injection skipped`);
        logLine('ERROR', `${file}: unknown shared block "${name}" -- injection skipped`);
        return full;
      }
      const body = SHARED_BLOCKS[name].split(/\r?\n/).map(l => (l ? indent + l : l)).join('\n');
      return `${indent}<!-- SHARED:${name} -->\n${body}\n${indent}<!-- /SHARED:${name} -->`;
    }
  );
}

// Antigravity CLI (agy) ships agents as a plugin: a plugin.json manifest plus an
// agents/<name>.md dir (frontmatter name+description, body = system prompt).
// Installed via `agy plugin install <dir>`. See sync verification notes.
const ANTI_PLUGIN_DIR = join(HOME, '.gemini', 'agentsystem-plugin');
const ANTI_AGENTS_DIR = join(ANTI_PLUGIN_DIR, 'agents');

// Pull the behavior block (the agent's system prompt) out of an agent .md and dedent it.
function behaviorBody(content) {
  const body = stripFrontmatter(content);
  const m = body.match(/^\s*behavior:\s*\|[^\n]*\n([\s\S]*)$/);
  const raw = m ? m[1] : body;
  return raw.split('\n').map(l => l.replace(/^  /, '')).join('\n').trim();
}

// Write one agent into the Antigravity plugin's agents/ dir as Claude-style markdown.
// NOTE: agy silently drops any agent whose `tools:` frontmatter names a tool it
// doesn't recognize (github-cli, gmail, figma, npm, docker, ...). Our tool names are
// abstract/Claude-style and have no agy equivalent, so we omit `tools:` entirely --
// the agent then loads with default tool access (same as built-in agy agents).
function writeAntigravityAgent(file, name, desc, model, content) {
  ensureDir(ANTI_AGENTS_DIR);
  const safeDesc = desc.replace(/\n+/g, ' ').replace(/"/g, "'");
  const md = `---\nname: ${name}\ndescription: "${safeDesc}"\nmodel: ${model}\n`
    + `---\n\n${behaviorBody(content)}\n`;
  writeFileSync(join(ANTI_AGENTS_DIR, file), md, 'utf8');
  ok(`Antigravity: ${join(ANTI_AGENTS_DIR, file)}`);
}

// Finalize the plugin manifest and install it into agy if the CLI is available.
function installAntigravityPlugin() {
  writeFileSync(join(ANTI_PLUGIN_DIR, 'plugin.json'), JSON.stringify({
    name: 'agentsystem',
    version: '1.0.0',
    description: 'AgentSystem agent roster synced from .agents/agents',
    author: 'AgentSystem',
  }, null, 2) + '\n', 'utf8');

  for (const agy of ['agy', join(HOME, '.local', 'bin', 'agy')]) {
    try {
      execFileSync(agy, ['plugin', 'install', ANTI_PLUGIN_DIR], { stdio: 'inherit' });
      ok(`Antigravity: installed plugin via ${agy}`);
      return true;
    } catch { /* try next candidate */ }
  }
  warn(`agy CLI not found -- to register agents run: agy plugin install ${ANTI_PLUGIN_DIR}`);
  return false;
}

function syncAgent(file) {
  const agentName = file.replace(/\.md$/, '').toLowerCase();
  const srcPath   = join(AGENTS_DIR, file);
  // Expand SHARED marker pairs before any platform write (see expandSharedBlocks above).
  const content   = expandSharedBlocks(readFileSync(srcPath, 'utf8'), file);
  const meta      = parseFrontmatter(content);
  const name      = meta.name || agentName;
  const desc      = meta.description || '';

  info(`Syncing: ${agentName}`);

  // Claude Code
  const claudeDir = join(HOME, '.claude', 'agents');
  ensureDir(claudeDir);
  const claudeModel = MODELS.claude[agentName] || meta.model || '';
  writeFileSync(join(claudeDir, file), setModel(stripToolsLine(content), claudeModel), 'utf8');
  ok(`Claude: ${join(claudeDir, file)}`);

  // Antigravity CLI (agy) -- stage into the plugin agents/ dir (installed after the loop).
  // agy is a Gemini-family runtime, so it still uses gemini-* model ids from MODELS.gemini.
  const antiModel = MODELS.gemini[agentName] || 'gemini-3-flash-preview';
  writeAntigravityAgent(file, name, desc, antiModel, content);
}

function syncConfig() {
  const destDir = join(HOME, '.claude', 'agents', 'config');
  ensureDir(destDir);
  if (!existsSync(CONFIG_DIR)) return;
  for (const f of readdirSync(CONFIG_DIR)) {
    if (!f.endsWith('.yml')) continue;
    copyFileSync(join(CONFIG_DIR, f), join(destDir, f));
    ok(`Config: ${f} -> ${destDir}`);
  }
}

// Slash commands (.agents/commands/*.md) were previously never synced -- edits to the
// repo source silently never reached ~/.claude/commands/, so fixes (e.g. stale absolute
// paths) never took effect. Sync them the same way config/ is synced: flat copy.
const COMMANDS_DIR = join(REPO_ROOT, '.agents', 'commands');
function syncCommands() {
  const destDir = join(HOME, '.claude', 'commands');
  ensureDir(destDir);
  if (!existsSync(COMMANDS_DIR)) return;
  for (const f of readdirSync(COMMANDS_DIR)) {
    if (!f.endsWith('.md')) continue;
    copyFileSync(join(COMMANDS_DIR, f), join(destDir, f));
    ok(`Command: ${f} -> ${destDir}`);
  }
}

function main() {
  info('Starting cross-platform agent sync...');

  // Rebuild the Antigravity plugin staging dir from scratch so removed agents don't linger.
  if (existsSync(ANTI_AGENTS_DIR)) rmSync(ANTI_AGENTS_DIR, { recursive: true, force: true });

  const files = readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'));
  for (const file of files) {
    try { syncAgent(file); } catch (e) { warn(`Failed ${file}: ${e.message}`); }
  }

  syncConfig();
  syncCommands();
  installAntigravityPlugin();

  const claudeCount  = readdirSync(join(HOME, '.claude', 'agents')).filter(f => f.endsWith('.md')).length;
  const antiCount    = existsSync(ANTI_AGENTS_DIR) ? readdirSync(ANTI_AGENTS_DIR).filter(f => f.endsWith('.md')).length : 0;

  ok(`Sync complete -- Claude: ${claudeCount}, Antigravity: ${antiCount}`);
}

// Only sync when run as a script. Importing this module (e.g. sync-agents.test.js
// pulling in the frontmatter helpers) used to rm -rf the Antigravity agents dir
// and rewrite ~/.claude/agents as a side effect of `npm test`.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();