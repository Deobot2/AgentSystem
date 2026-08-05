// known-repos.js — global registry of bootstrapped repos
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export function readRegistry(registryPath) {
  if (!existsSync(registryPath)) return { version: '1.0', repos: [] };
  try {
    return JSON.parse(readFileSync(registryPath, 'utf8'));
  } catch (e) {
    console.warn(`known-repos: malformed registry at ${registryPath} — returning empty. Error: ${e.message}`);
    return { version: '1.0', repos: [] };
  }
}

export function writeRegistry(registryPath, registry) {
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');
}

export function upsertRepo(registry, entry) {
  const today = new Date().toISOString().slice(0, 10);
  const record = {
    slug: entry.slug,
    path: entry.path,
    brain_path: entry.brain_path ?? `nexus/${entry.slug}/graph.json`,
    last_init: today,
    primary_cli: entry.primary_cli ?? 'claude',
    bootstrap_complete: true,
  };
  // Only set description when explicitly provided — otherwise the spread below
  // preserves any existing description on re-bootstrap (never clobber to empty).
  if (typeof entry.description === 'string' && entry.description.trim()) {
    record.description = entry.description.trim();
  }
  const idx = registry.repos.findIndex(r => r.slug === entry.slug);
  if (idx >= 0) {
    const repos = [...registry.repos];
    repos[idx] = { ...repos[idx], ...record };
    return { ...registry, repos };
  }
  return { ...registry, repos: [...registry.repos, record] };
}

/**
 * The filesystem path for a repo ON THIS HOST.
 *
 * known-repos.json lives in ~/agent-memory, which is one registry SHARED by every host, so a single
 * `path` cannot be right everywhere: the laptop's checkouts are at `C:/Users/natha/dev/...` and the
 * Mission Control server's are under `/home/basely`. Until #220 this stored only the Windows paths,
 * so on Linux every entry pointed at a directory that does not exist — and stage 2 validates every
 * code item against this registry, which meant it could not dispatch a single one.
 *
 * Resolution order, first hit wins:
 *   1. `paths[process.platform]`  — explicit per-platform entry
 *   2. `path`                     — the legacy single field, still correct on the host that wrote it
 * Returns null when nothing resolves, which callers must treat as "not available here" rather than
 * as a bad slug — the repo may be perfectly valid on another host.
 */
export function repoPathForHost(repo, platform = process.platform) {
  if (!repo) return null;
  const fromMap = repo.paths && typeof repo.paths === 'object' ? repo.paths[platform] : null;
  return fromMap || repo.path || null;
}

export function findRepo(registry, slug) {
  return registry.repos.find(r => r.slug === slug) ?? null;
}
