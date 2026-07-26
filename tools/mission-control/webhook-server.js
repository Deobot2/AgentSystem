#!/usr/bin/env node
/**
 * LINUX MISSION-CONTROL HOST COMPONENT: Runs on dedicated Linux host only. Not compatible with Windows.
 * See tools/mission-control/README.md for architecture.
 *
 * Claude Code Remote Control Server
 * REST API + mobile web panel for phone-based agent dispatch
 *
 * Auth:    Authorization: Bearer <key from ~/.claude/remote-webhook.key>
 * Endpoints:
 *   GET  /              — health + daemon status
 *   GET  /panel         — mobile web control panel
 *   GET  /sessions      — list running sessions
 *   GET  /cost          — today's spend summary
 *   GET  /log/:id       — tail agent run log (last 100 lines)
 *   POST /run           — spawn background agent
 *                         body: { agent, prompt, cwd? }
 *   POST /github        — GitHub webhook → auto-route to agent
 */

import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, openSync, closeSync, mkdirSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionRegistry } from './session-registry.js';
import { validateRepo } from './repo-validator.js';
import { spawnAgyPersistent } from './agy-dispatcher.js';
import { ipAllowed as ipAllowedFor, normalizeIp } from './ip-utils.js';
import { lanAddresses, publicBaseUrl } from './url-utils.js';
import { publish as publishEvent } from '../event-bus.js';

const HOME      = homedir();
const KEY_FILE  = `${HOME}/.claude/remote-webhook.key`;
const ROSTER    = `${HOME}/.claude/daemon/roster.json`;
const CLAUDE    = process.env.CLAUDE_BIN || `${HOME}/.local/bin/claude`;
if (process.env.CLAUDE_BIN && !existsSync(process.env.CLAUDE_BIN)) {
  console.error(`Specified CLAUDE_BIN does not exist: ${process.env.CLAUDE_BIN}`);
  process.exit(1);
}
const LOG_DIR   = `${HOME}/.claude/agent-runs`;
const COST_LOG  = `${HOME}/agent-memory/nexus/session-log.jsonl`;
const KNOWN_REPOS_FILE = `${HOME}/agent-memory/nexus/known-repos.json`;
const MC_REGISTRY_FILE = `${HOME}/.claude/mission-control-registry.json`;
// Repo whose PRs + self-hosted runner health the /pipelines endpoint reports on.
const GH_REPO   = process.env.GH_REPO || 'Zene8/AgentSystem';
const PORT      = parseInt(process.env.PORT || '8765');
const GH_SECRET = process.env.GITHUB_WEBHOOK_SECRET || '';
// PUBLIC_URL: externally-reachable base URL (e.g. behind a reverse proxy or
// Tailscale). When set, advertised log URLs use it instead of a Host-header or
// localhost guess. No trailing slash needed.
const PUBLIC_URL = process.env.PUBLIC_URL || '';

const SECRET = existsSync(KEY_FILE) ? readFileSync(KEY_FILE, 'utf8').trim() : null;
if (!SECRET) { console.error('No ~/.claude/remote-webhook.key found'); process.exit(1); }

const HOST      = process.env.HOST || '127.0.0.1';
const AUDIT_LOG = `${HOME}/.claude/mission-control-audit.jsonl`;

// ── CORS origin restriction ───────────────────────────────────────────────────
// The panel is served same-origin from this server, so cross-origin browser
// access is not required by default. Set ALLOWED_ORIGIN to a specific origin
// (e.g. "https://panel.example.com") to opt in to CORS from that origin only.
// `Access-Control-Allow-Origin: *` is never emitted.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';
function corsOriginFor(req) {
  const reqOrigin = req.headers.origin;
  if (!ALLOWED_ORIGIN || !reqOrigin) return null;
  return reqOrigin === ALLOWED_ORIGIN ? reqOrigin : null;
}

const rateLimitWindowMs = 60 * 1000;
const rateLimitMaxRequests = 100;
const ipRequestCounts = new Map();

// ── IP allowlist (optional) ───────────────────────────────────────────────────
// ~/.claude/webhook-allowlist.json: { "allow": ["127.0.0.1", "192.168.1.0/24"] }
// Absent/empty file = no IP filtering (auth + rate limit still apply).
const ALLOWLIST_FILE = `${HOME}/.claude/webhook-allowlist.json`;
function loadAllowlist() {
  try {
    const j = JSON.parse(readFileSync(ALLOWLIST_FILE, 'utf8'));
    return Array.isArray(j.allow) ? j.allow : [];
  } catch { return []; }
}
const ALLOWLIST = loadAllowlist();

// IP parsing/matching helpers (ipToInt, normalizeIp, ipAllowed) live in
// ./ip-utils.js so they can be unit tested in isolation.
function ipAllowed(rawIp) {
  return ipAllowedFor(rawIp, ALLOWLIST);
}

// ── Failed-auth lockout ───────────────────────────────────────────────────────
// >=10 failed auths within 60s from one IP → locked out for 15 min (exponential
// doubling on repeat lockouts, capped at 24h).
const failedAuth = new Map(); // ip -> { fails: number[], lockedUntil: number, lockCount: number }
const AUTH_FAIL_MAX = 10, AUTH_FAIL_WINDOW = 60_000, LOCKOUT_BASE = 15 * 60_000, LOCKOUT_CAP = 24 * 3600_000;

function authLocked(ip) {
  const e = failedAuth.get(ip);
  return !!(e && e.lockedUntil > Date.now());
}
function recordAuthFail(ip) {
  const now = Date.now();
  const e = failedAuth.get(ip) || { fails: [], lockedUntil: 0, lockCount: 0 };
  e.fails = e.fails.filter(t => now - t < AUTH_FAIL_WINDOW);
  e.fails.push(now);
  if (e.fails.length >= AUTH_FAIL_MAX) {
    e.lockCount += 1;
    e.lockedUntil = now + Math.min(LOCKOUT_BASE * 2 ** (e.lockCount - 1), LOCKOUT_CAP);
    e.fails = [];
    console.warn(`[auth] lockout: ${ip} until ${new Date(e.lockedUntil).toISOString()} (lockout #${e.lockCount})`);
  }
  failedAuth.set(ip, e);
}
function clearAuthFails(ip) { failedAuth.delete(ip); }

function rateLimiter(req) {
  const ip = req.socket.remoteAddress || req.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  
  if (!ipRequestCounts.has(ip)) {
    ipRequestCounts.set(ip, []);
  }
  
  const timestamps = ipRequestCounts.get(ip);
  const activeTimestamps = timestamps.filter(ts => now - ts < rateLimitWindowMs);
  
  if (activeTimestamps.length >= rateLimitMaxRequests) {
    return false;
  }
  
  activeTimestamps.push(now);
  ipRequestCounts.set(ip, activeTimestamps);
  return true;
}

function auditLog(action, req, details = {}) {
  try {
    const logEntry = {
      timestamp: new Date().toISOString(),
      action,
      ip: req.socket.remoteAddress || req.headers['x-forwarded-for'] || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      details,
    };
    appendFileSync(AUDIT_LOG, JSON.stringify(logEntry) + '\n');
  } catch (e) {
    console.error('Failed to write audit log:', e.message);
  }
}

mkdirSync(LOG_DIR, { recursive: true });

// Initialize Mission Control registry (for both claude + agy sessions)
const registry = new SessionRegistry(MC_REGISTRY_FILE);

// Reconcile any stale active sessions on server startup
function reconcileRegistryOnStartup() {
  try {
    const running = registry.getRunning();
    if (running.length > 0) {
      console.log(`[mc-registry] Found ${running.length} stale active session(s) on startup. Cleaning up...`);
      for (const s of running) {
        registry.exitSession(s.id, 137, s.logPath);
      }
    }
  } catch (e) {
    console.warn('[mc-registry] Startup reconciliation failed:', e.message);
  }
}
reconcileRegistryOnStartup();

// ── helpers ──────────────────────────────────────────────────────────────────

function readJSON(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      try { resolve({ raw, parsed: JSON.parse(raw.toString() || '{}') }); }
      catch { resolve({ raw, parsed: {} }); }
    });
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function html(res, body) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

function text(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end(body);
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Still run timingSafeEqual against an equal-length buffer so comparison
    // time doesn't leak the correct secret length to a network attacker.
    timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function checkAuth(req) {
  const h = req.headers.authorization || '';
  if (safeEqual(h, `Bearer ${SECRET}`) || safeEqual(h, SECRET)) return true;
  // Also allow ?key= query param for panel bookmarks
  const url = new URL(req.url, `http://localhost`);
  return safeEqual(url.searchParams.get('key') || '', SECRET);
}

function verifyGitHubSig(raw, sig) {
  if (!GH_SECRET || !sig) return false;
  const expected = 'sha256=' + createHmac('sha256', GH_SECRET).update(raw).digest('hex');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(sigBuf, expectedBuf);
}

function getSessions() {
  const roster = readJSON(ROSTER) || {};
  return Object.entries(roster.workers || {}).map(([id, w]) => ({
    id, pid: w.pid, cwd: w.cwd,
    startedAt: new Date(w.startedAt).toISOString(),
    agent: w.dispatch?.flagArgs?.find((a, i, arr) => arr[i-1] === '--agent') || 'unknown',
  }));
}

function getCostSummary() {
  if (!existsSync(COST_LOG)) return { today: { sessions: 0, cost_usd: 0 }, recent: [] };
  const lines = readFileSync(COST_LOG, 'utf8').trim().split('\n').filter(Boolean);
  const sessions = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const today = new Date(new Date().toDateString());
  const todaySessions = sessions.filter(s => new Date(s.ts) >= today);
  const weekAgo = new Date(Date.now() - 7 * 86400_000);
  const weekSessions = sessions.filter(s => new Date(s.ts) >= weekAgo);
  return {
    today: {
      sessions: todaySessions.length,
      cost_usd: todaySessions.reduce((s, r) => s + (r.cost_usd || 0), 0),
    },
    week: {
      sessions: weekSessions.length,
      cost_usd: weekSessions.reduce((s, r) => s + (r.cost_usd || 0), 0),
    },
    recent: sessions.slice(-5).reverse(),
  };
}

// ── bg-agent spawn protection ─────────────────────────────────────────────────
// Guards the raw `claude --bg` spawn path (used directly by /github and the
// legacy /run handler, which do NOT go through SessionRegistry's per-harness
// cap). Prevents duplicate spawns from rapid-fire repeated events (e.g. GitHub
// retries/flapping webhooks) and caps total concurrent background sessions.
const SPAWN_DEDUPE_WINDOW_MS = 30 * 1000;
const MAX_CONCURRENT_BG_SESSIONS = 5;
const recentSpawnKeys = new Map(); // `${agent}|${cwd}` -> last spawn timestamp

function pruneRecentSpawnKeys(now) {
  for (const [key, ts] of recentSpawnKeys) {
    if (now - ts > SPAWN_DEDUPE_WINDOW_MS) recentSpawnKeys.delete(key);
  }
}

function spawnAgent(agent, prompt, cwd = HOME) {
  return new Promise(async (resolve) => {
    const now = Date.now();
    pruneRecentSpawnKeys(now);

    // 1. Debounce/dedup: skip identical agent+cwd spawns within the window.
    const dedupeKey = `${agent}|${cwd}`;
    const lastSpawn = recentSpawnKeys.get(dedupeKey);
    if (lastSpawn && (now - lastSpawn) < SPAWN_DEDUPE_WINDOW_MS) {
      console.log(`[spawn-guard] Skipped duplicate spawn for agent=${agent} cwd=${cwd} (last spawned ${now - lastSpawn}ms ago, window=${SPAWN_DEDUPE_WINDOW_MS}ms)`);
      resolve({ skipped: true, reason: 'duplicate', agent, ts: now });
      return;
    }

    // 2. Concurrency cap: reject/queue beyond MAX_CONCURRENT_BG_SESSIONS active sessions.
    let activeCount = 0;
    try {
      const active = await getActiveSessions();
      activeCount = Array.isArray(active) ? active.length : 0;
    } catch {
      activeCount = 0;
    }
    if (activeCount >= MAX_CONCURRENT_BG_SESSIONS) {
      console.log(`[spawn-guard] Rejected spawn for agent=${agent} — concurrency cap reached (${activeCount}/${MAX_CONCURRENT_BG_SESSIONS} active bg sessions)`);
      // Don't lose the trigger: queue it on the event bus so the scheduled
      // dispatcher drain retries the spawn once capacity frees up.
      let queuedId = null;
      try {
        const evt = publishEvent({
          type: 'spawn-agent',
          source: 'webhook-server:concurrency_cap',
          payload: { agent, prompt, cwd },
        });
        queuedId = evt.id;
        console.log(`[spawn-guard] Queued spawn on event bus id=${evt.id}`);
      } catch (err) {
        console.error(`[spawn-guard] Failed to queue spawn event: ${err.message}`);
      }
      resolve({ skipped: true, reason: 'concurrency_cap', queuedEventId: queuedId, agent, active: activeCount, cap: MAX_CONCURRENT_BG_SESSIONS, ts: now });
      return;
    }

    recentSpawnKeys.set(dedupeKey, now);

    const ts = now;
    const logFile = `${LOG_DIR}/${ts}-${agent}.log`;

    // Use --bg for proper daemon-managed background sessions
    // stdout: "backgrounded · <8-char-id>"
    const child = spawn(CLAUDE, ['--bg', '--agent', agent, '-p', prompt], {
      cwd: existsSync(cwd) ? cwd : HOME,
      env: { ...process.env, HOME },
      windowsHide: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.unref();

    let stdout = '', stderr = '';
    child.stdout?.on('data', d => stdout += d);
    child.stderr?.on('data', d => stderr += d);

    child.on('close', () => {
      // Parse session short ID from "backgrounded · abc123de"
      const match = stdout.match(/backgrounded\s*[·•]\s*([a-f0-9]+)/i);
      const shortId = match?.[1] || null;
      resolve({
        sessionId: shortId || `${ts}-${agent}`,
        shortId,
        logFile: shortId ? null : logFile,
        logId: shortId || `${ts}-${agent}`,
        ts
      });
    });

    // Fallback: if spawn fails, log to file
    child.on('error', () => {
      const logFd = openSync(logFile, 'w');
      const fallback = spawn(CLAUDE, ['--agent', agent, '-p', prompt], {
        cwd: existsSync(cwd) ? cwd : HOME,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env, HOME },
      });
      fallback.unref();
      closeSync(logFd);
      resolve({
        sessionId: `${ts}-${agent}`,
        shortId: null,
        logFile,
        logId: `${ts}-${agent}`,
        ts,
        pid: fallback.pid
      });
    });
  });
}

/**
 * Dispatch a claude background agent via Mission Control format
 * Wraps spawnAgent() with required return interface for registry update
 * @param {string} agent - Agent name
 * @param {string} prompt - Task prompt
 * @param {string} repoPath - Working directory
 * @returns {Promise<{sessionId, logPath, logFile, pid}>}
 */
async function dispatchClaude(agent, prompt, repoPath) {
  return spawnAgent(agent, prompt, repoPath);
}

function getActiveSessions() {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE, ['agents', '--json'], { env: { ...process.env, HOME } });
    let out = '';
    child.stdout?.on('data', d => out += d);
    child.on('close', () => {
      try { resolve(JSON.parse(out)); } catch { resolve([]); }
    });
    child.on('error', () => resolve([]));
  });
}

function getAgentLog(shortId) {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE, ['logs', shortId], { env: { ...process.env, HOME } });
    let out = '';
    child.stdout?.on('data', d => out += d);
    child.stderr?.on('data', d => out += d);
    child.on('close', () => resolve(out));
    child.on('error', () => resolve(''));
    setTimeout(() => { child.kill(); resolve(out); }, 5000);
  });
}

function getRecentRuns(limit = 10) {
  try {
    return readdirSync(LOG_DIR)
      .filter(f => f.endsWith('.log'))
      .map(f => {
        const [ts, ...rest] = f.replace('.log', '').split('-');
        return { id: f.replace('.log', ''), ts: parseInt(ts), agent: rest.join('-'), file: `${LOG_DIR}/${f}` };
      })
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
  } catch { return []; }
}

function loadKnownRepos() {
  try {
    if (existsSync(KNOWN_REPOS_FILE)) {
      return JSON.parse(readFileSync(KNOWN_REPOS_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('Failed to load known-repos.json:', e.message);
  }
  return { repos: [] };
}

function panelHTML(key) {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const htmlPath = path.join(dir, 'panel.html');
  try {
    const raw = readFileSync(htmlPath, 'utf8');
    return raw.replaceAll('${key}', key);
  } catch (err) {
    return `<!DOCTYPE html><html><body>Error loading panel template: ${err.message}</body></html>`;
  }
}

// ── PWA assets (installable home-screen app) ──────────────────────────────────
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#0a152e"/><path d="M300 56 150 288h92l-42 168 214-256H316z" fill="#ff6933"/></svg>`;

const SW_JS = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => {
    for (const c of cs) { if ('focus' in c) return c.focus(); }
  }));
});`;

function manifest(key) {
  return {
    name: 'Mission Control',
    short_name: 'Mission Ctl',
    description: 'Agent dispatch & fleet control',
    start_url: `/panel?key=${key}`,
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0a152e',
    theme_color: '#0a152e',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
  };
}

// ── Pipelines: self-hosted runner health + open PRs (read-only gh) ────────────
function runGh(args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let out = '', err = '';
    const child = spawn('gh', args, { env: { ...process.env, HOME } });
    const t = setTimeout(() => { child.kill(); resolve({ ok: false, error: 'gh timed out' }); }, timeoutMs);
    child.stdout?.on('data', d => out += d);
    child.stderr?.on('data', d => err += d);
    child.on('close', code => { clearTimeout(t); code === 0 ? resolve({ ok: true, out }) : resolve({ ok: false, error: (err.trim() || `gh exited ${code}`) }); });
    child.on('error', e => { clearTimeout(t); resolve({ ok: false, error: e.message }); });
  });
}

function rollupState(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none';
  let fail = 0, pending = 0;
  for (const c of rollup) {
    const s = (c.conclusion || c.state || c.status || '').toUpperCase();
    if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(s)) fail++;
    else if (['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', ''].includes(s)) pending++;
  }
  if (fail) return 'failing';
  if (pending) return 'pending';
  return 'passing';
}

async function getPipelines() {
  const result = { repo: GH_REPO, runner: null, prs: [], generatedAt: new Date().toISOString() };

  const r1 = await runGh(['api', `repos/${GH_REPO}/actions/runners`]);
  if (r1.ok) {
    try {
      const runners = JSON.parse(r1.out).runners || [];
      const online = runners.filter(x => x.status === 'online');
      result.runner = {
        healthy: online.length > 0,
        total: runners.length,
        online: online.length,
        busy: runners.some(x => x.busy),
      };
    } catch { result.runner = { healthy: false, error: 'failed to parse runner status' }; }
  } else {
    result.runner = { healthy: false, error: r1.error };
  }

  const r2 = await runGh(['pr', 'list', '--repo', GH_REPO, '--limit', '20', '--json',
    'number,title,url,isDraft,reviewDecision,statusCheckRollup,headRefName']);
  if (r2.ok) {
    try {
      result.prs = JSON.parse(r2.out).map(p => ({
        number: p.number,
        title: p.title,
        url: p.url,
        draft: p.isDraft,
        branch: p.headRefName,
        reviewDecision: p.reviewDecision || null,
        checks: rollupState(p.statusCheckRollup),
      }));
    } catch { result.prsError = 'failed to parse PR list'; }
  } else {
    result.prsError = r2.error;
  }
  return result;
}

// ── GitHub webhook router ─────────────────────────────────────────────────────

function routeGitHubEvent(event, payload) {
  const repo = payload.repository?.full_name || 'unknown';

  if (event === 'pull_request') {
    const action = payload.action;
    const pr = payload.pull_request;
    if (['opened', 'synchronize'].includes(action)) {
      return {
        agent: 'friday',
        prompt: `GitHub PR #${pr.number} ${action} in ${repo}: "${pr.title}". Review the changes, check for issues, and post a review summary. PR URL: ${pr.html_url}`,
      };
    }
  }

  if (event === 'push' && payload.ref === 'refs/heads/main') {
    return {
      agent: 'leo',
      prompt: `New push to main in ${repo} by ${payload.pusher?.name}. ${payload.commits?.length || 0} commit(s). Check CI status and alert on failures. Ref: ${payload.after}`,
    };
  }

  if (event === 'issues' && payload.action === 'opened') {
    const issue = payload.issue;
    return {
      agent: 'jarvis',
      prompt: `New GitHub issue #${issue.number} opened in ${repo}: "${issue.title}". Triage it, label it appropriately, and route to the right agent. URL: ${issue.html_url}`,
    };
  }

  if (event === 'check_run' && payload.check_run?.conclusion === 'failure') {
    return {
      agent: 'friday',
      prompt: `CI check failed in ${repo}: ${payload.check_run?.name}. Investigate the failure and create a fix. Commit: ${payload.check_run?.head_sha?.slice(0,8)}`,
    };
  }

  if (event === 'workflow_run' && payload.workflow_run?.conclusion === 'failure') {
    return {
      agent: 'leo',
      prompt: `GitHub Actions workflow "${payload.workflow_run?.name}" failed in ${repo}. Investigate and fix. URL: ${payload.workflow_run?.html_url}`,
    };
  }

  return null; // unhandled event
}

// ── Request router ────────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  // Restricted CORS: only echo back an Access-Control-Allow-Origin when the
  // request's Origin header matches the configured ALLOWED_ORIGIN. No
  // wildcard is ever emitted — the panel itself is served same-origin and
  // does not need CORS at all.
  const allowedOrigin = corsOriginFor(req);
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Hub-Signature-256');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const clientIp = normalizeIp(req.socket.remoteAddress || 'unknown');

  // IP allowlist (if configured)
  if (!ipAllowed(clientIp)) {
    return json(res, 403, { error: 'Forbidden' });
  }

  // Failed-auth lockout
  if (authLocked(clientIp)) {
    return json(res, 429, { error: 'Locked out after repeated auth failures. Try later.' });
  }

  // Rate Limiting check
  if (!rateLimiter(req)) {
    return json(res, 429, { error: 'Too many requests. Rate limit exceeded.' });
  }

  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;

  // GitHub webhook — auth via HMAC sig, not Bearer
  if (req.method === 'POST' && pathname === '/github') {
    const { raw, parsed } = await readBody(req);
    const sig = req.headers['x-hub-signature-256'] || '';
    if (!GH_SECRET || !verifyGitHubSig(raw, sig)) {
      return json(res, 401, { error: 'Invalid GitHub webhook signature' });
    }
    const event = req.headers['x-github-event'] || '';
    const route = routeGitHubEvent(event, parsed);
    if (!route) return json(res, 200, { status: 'ignored', event });

    const run = await spawnAgent(route.agent, route.prompt, HOME);
    if (run.skipped) {
      console.log(`[github] ${event} → ${route.agent} SKIPPED (${run.reason})`);
      return json(res, 200, { status: 'skipped', ...run, agent: route.agent, event });
    }
    console.log(`[github] ${event} → ${route.agent} id=${run.shortId || run.logId}`);
    return json(res, 200, { status: 'dispatched', ...run, agent: route.agent, event });
  }

  // GET /favicon.ico — no auth; browsers auto-request it and 401s spam the console
  if (req.method === 'GET' && pathname === '/favicon.ico') {
    res.writeHead(204); res.end(); return;
  }

  // PWA static assets — no auth (contain no secrets); the browser fetches the
  // service worker and icon without the bearer key.
  if (req.method === 'GET' && pathname === '/icon.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' });
    res.end(ICON_SVG); return;
  }
  if (req.method === 'GET' && pathname === '/sw.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' });
    res.end(SW_JS); return;
  }

  // All other routes need Bearer auth
  if (!checkAuth(req)) {
    recordAuthFail(clientIp);
    return json(res, 401, { error: 'Unauthorized — use Authorization: Bearer <key>' });
  }
  clearAuthFails(clientIp);

  // GET / — status
  if (req.method === 'GET' && pathname === '/') {
    return json(res, 200, {
      status: 'ok', version: '1.0.0',
      daemon: readJSON(`${HOME}/.claude/daemon.status.json`),
      sessions: getSessions().length,
    });
  }

  // GET /panel — mobile control panel
  if (req.method === 'GET' && pathname === '/panel') {
    return html(res, panelHTML(SECRET));
  }

  // GET /manifest.webmanifest — PWA manifest (auth'd: start_url embeds the key)
  if (req.method === 'GET' && pathname === '/manifest.webmanifest') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
    return res.end(JSON.stringify(manifest(SECRET)));
  }

  // GET /pipelines — self-hosted runner health + open PRs (for the Pipelines tab)
  if (req.method === 'GET' && pathname === '/pipelines') {
    return json(res, 200, await getPipelines());
  }

  // GET /repos — list spawnable repos
  if (req.method === 'GET' && pathname === '/repos') {
    const knownRepos = loadKnownRepos();
    const repos = (knownRepos.repos || []).map(r => ({
      slug: r.slug,
      path: r.path,
      primary_cli: r.primary_cli || 'claude',
      description: r.description || ''
    }));
    return json(res, 200, { repos });
  }

  // GET /sessions — live from claude agents --json + agy sessions from registry
  if (req.method === 'GET' && pathname === '/sessions') {
    const claudeSessions = await getActiveSessions();
    const roster = getSessions(); // from roster.json as fallback
    const sessions = claudeSessions.length ? claudeSessions : roster;

    // Add agy sessions from registry
    const allSessions = [...sessions];
    const registrySessions = registry.getSessions();
    const agySessions = registrySessions.filter(s => s.harness === 'agy');
    allSessions.push(...agySessions);

    return json(res, 200, { sessions: allSessions, source: claudeSessions.length ? 'cli+registry' : 'roster+registry' });
  }

  // GET /cost
  if (req.method === 'GET' && pathname === '/cost') {
    return json(res, 200, getCostSummary());
  }

  // GET /runs
  if (req.method === 'GET' && pathname === '/runs') {
    return json(res, 200, { runs: getRecentRuns() });
  }

  // GET /briefing — newest daily briefing markdown ($LIFE_REPO/briefings, default ~/life)
  if (req.method === 'GET' && pathname === '/briefing') {
    const dir = `${process.env.LIFE_REPO || `${HOME}/life`}/briefings`;
    let file = null;
    try {
      file = readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().pop();
    } catch {}
    if (!file) return json(res, 404, { error: 'No briefing found' });
    return json(res, 200, { date: file.replace('.md', ''), markdown: readFileSync(`${dir}/${file}`, 'utf8') });
  }

  // GET /log/:id — uses claude logs <id> for bg sessions, file fallback
  if (req.method === 'GET' && pathname.startsWith('/log/')) {
    const id = pathname.slice(5).replace(/[^a-z0-9_\-]/gi, '');
    auditLog('view_log', req, { id });
    
    // Check if session exists in registry and has a logPath
    const session = registry.getSession(id);
    if (session && session.logPath) {
      if (existsSync(session.logPath)) {
        const content = readFileSync(session.logPath, 'utf8');
        const last = content.split('\n').slice(-100).join('\n');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(last);
      }
    }

    // Try as a background session short-id first
    if (/^[a-f0-9]{8}$/.test(id)) {
      const output = await getAgentLog(id);
      if (output) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(output);
      }
    }
    // Fallback: file-based log
    const logFile = `${LOG_DIR}/${id}.log`;
    if (!existsSync(logFile)) return json(res, 404, { error: 'Log not found' });
    const content = readFileSync(logFile, 'utf8');
    const last = content.split('\n').slice(-100).join('\n');
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(last);
  }

  // POST /run — supports two request formats:
  //   1. NEW (Mission Control): { harness: "claude"|"agy", prompt, repo, agent?, model? }
  //   2. LEGACY (panel): { agent, prompt, cwd? }
  if (req.method === 'POST' && pathname === '/run') {
    const { parsed } = await readBody(req);
    
    auditLog('run_session', req, {
      harness: parsed.harness || 'claude',
      repo: parsed.repo || 'unknown',
      agent: parsed.agent || null,
      model: parsed.model || null
    });

    // Detect which format based on presence of 'harness' or 'repo' fields
    const isMissionControlFormat = parsed.harness || parsed.repo;

    if (isMissionControlFormat) {
      // NEW FORMAT: Mission Control dispatch
      const { harness, prompt, repo, agent = null, model = null } = parsed;

      // Validate required fields
      if (!harness) return json(res, 400, { error: 'harness required (claude or agy)' });
      if (!prompt) return json(res, 400, { error: 'prompt required' });
      if (!repo) return json(res, 400, { error: 'repo required (slug from allowlist)' });

      if (!['claude', 'agy'].includes(harness)) {
        return json(res, 400, { error: `Unknown harness "${harness}". Valid: claude, agy` });
      }

      // Validate repo against allowlist
      const knownRepos = loadKnownRepos();
      let repoPath;
      try {
        const validated = validateRepo(repo, knownRepos);
        repoPath = validated.path;
      } catch (e) {
        return json(res, 403, { error: e.message });
      }

      // CONCURRENCY CAP: Enforce max 1 concurrent session per harness (CEO requirement)
      // See https://github.com/Zene8/AgentSystem/issues/95 — autonomy constraints
      const running = registry.getRunning().filter(s => s.harness === harness);
      if (running.length > 0) {
        return json(res, 409, {
          error: `${harness} harness already running`,
          running: running[0],
          message: 'Max 1 concurrent session per harness. Wait for current session to complete.',
        });
      }

      // Create session registry entry
      const sessionRecord = registry.createSession({
        harness,
        repo,
        prompt,
        agent: harness === 'claude' ? agent : null,
        model: harness === 'agy' ? model : null,
      });

      try {
        let dispatchResult;
        if (harness === 'claude') {
          // Dispatch claude agent
          if (!agent) {
            registry.exitSession(sessionRecord.id, 1);
            return json(res, 400, { error: 'agent required for claude harness' });
          }
          const validAgents = ['jarvis','friday','sam','nat','ultron','pym','leo','astra','wanda','threepio','r2d2'];
          if (!validAgents.includes(agent.toLowerCase())) {
            registry.exitSession(sessionRecord.id, 1);
            return json(res, 400, { error: `Unknown agent: ${agent}` });
          }
          dispatchResult = await dispatchClaude(agent.toLowerCase(), prompt, repoPath);
        } else {
          // Dispatch agy
          dispatchResult = await spawnAgyPersistent(prompt, repoPath, model);
        }

        // Update registry with dispatch result
        if (dispatchResult.sessionId) {
          registry.updateSession(sessionRecord.id, {
            status: 'running',
            logPath: dispatchResult.logPath || dispatchResult.logFile || null,
            harnessSessionId: dispatchResult.sessionId,
            tmuxSession: dispatchResult.tmuxSession || null,
            pid: dispatchResult.pid || null
          });
        } else {
          registry.exitSession(sessionRecord.id, dispatchResult.exitCode || 1);
        }

        console.log(`[mc-${harness}] repo=${repo} id=${sessionRecord.id} prompt="${prompt.slice(0, 60)}"`);
        return json(res, 202, {
          id: sessionRecord.id,
          harness,
          repo,
          status: dispatchResult.status || 'running',
          spawnedAt: sessionRecord.spawnedAt,
          logUrl: `${publicBaseUrl({
            publicUrl: PUBLIC_URL,
            hostHeader: req.headers.host,
            forwardedProto: req.headers['x-forwarded-proto'],
            port: PORT,
          })}/log/${sessionRecord.id}`,
        });
      } catch (e) {
        registry.exitSession(sessionRecord.id, 1);
        console.error(`[mc-${harness}] dispatch error:`, e.message);
        return json(res, 500, { error: `Dispatch failed: ${e.message}` });
      }
    } else {
      // LEGACY FORMAT: Panel dispatch (backward compat).
      // Routed through SessionRegistry (same as the Mission Control format)
      // so legacy /run calls are subject to the same per-harness concurrency
      // cap and show up in /sessions, /stop, and audit history — this used
      // to call spawnAgent() directly and bypass the registry entirely.
      const { agent = 'jarvis', prompt, cwd = HOME } = parsed;
      if (!prompt) return json(res, 400, { error: 'prompt required' });

      const validAgents = ['jarvis','friday','sam','nat','ultron','pym','leo','astra','wanda','threepio','r2d2'];
      if (!validAgents.includes(agent.toLowerCase())) {
        return json(res, 400, { error: `Unknown agent. Valid: ${validAgents.join(', ')}` });
      }

      const running = registry.getRunning().filter(s => s.harness === 'claude');
      if (running.length > 0) {
        return json(res, 409, {
          error: 'claude harness already running',
          running: running[0],
          message: 'Max 1 concurrent session per harness. Wait for current session to complete.',
        });
      }

      const sessionRecord = registry.createSession({
        harness: 'claude',
        repo: cwd,
        prompt,
        agent: agent.toLowerCase(),
        model: null,
      });

      const run = await spawnAgent(agent.toLowerCase(), prompt, cwd);
      if (run.skipped) {
        registry.exitSession(sessionRecord.id, 1);
        console.log(`[run-legacy] ${agent} SKIPPED (${run.reason}) prompt="${prompt.slice(0, 60)}"`);
        return json(res, 429, { status: 'skipped', agent, reason: run.reason, active: run.active, cap: run.cap });
      }

      registry.updateSession(sessionRecord.id, {
        status: 'running',
        logPath: run.logFile || null,
        harnessSessionId: run.shortId || run.logId,
        pid: run.pid || null,
      });

      console.log(`[run-legacy] ${agent} id=${sessionRecord.id} shortId=${run.shortId || run.logId} prompt="${prompt.slice(0, 60)}"`);
      return json(res, 200, { status: 'dispatched', id: sessionRecord.id, agent, shortId: run.shortId, logId: run.logId,
        monitor: run.shortId ? `claude attach ${run.shortId}` : null });
    }
  }

  // GET /health — health status
  if (req.method === 'GET' && pathname === '/health') {
    const runningSessions = registry.getRunning();
    return json(res, 200, {
      status: 'ok',
      timestamp: new Date().toISOString(),
      daemon: readJSON(`${HOME}/.claude/daemon.status.json`) || { status: 'unknown' },
      active_sessions: runningSessions.length,
      platform: process.platform,
      node_version: process.version,
    });
  }

  // POST /stop — stop/kill a running session
  if (req.method === 'POST' && pathname === '/stop') {
    const { parsed } = await readBody(req);
    const { id } = parsed;
    if (!id) return json(res, 400, { error: 'id required' });

    auditLog('stop_session', req, { id });

    const session = registry.getSession(id);
    if (!session) return json(res, 404, { error: 'Session not found' });
    if (session.status !== 'running' && session.status !== 'spawning') {
      return json(res, 400, { error: `Session is not running (status: ${session.status})` });
    }

    try {
      if (session.harness === 'claude') {
        const shortId = session.harnessSessionId;
        if (shortId && /^[a-f0-9]{8}$/.test(shortId)) {
          const child = spawn(CLAUDE, ['stop', shortId], { env: { ...process.env, HOME } });
          child.on('close', (code) => {
            registry.exitSession(id, code || 0);
            return json(res, 200, { status: 'stopped', id });
          });
          child.on('error', (err) => {
            return json(res, 500, { error: `Failed to stop agent: ${err.message}` });
          });
        } else {
          registry.exitSession(id, 0);
          return json(res, 200, { status: 'stopped', id, warning: 'No active background ID to stop' });
        }
      } else if (session.harness === 'agy') {
        const tmuxName = session.tmuxSession;
        if (tmuxName) {
          const { stopAgyPersistent } = await import('./agy-persistence.js');
          const result = await stopAgyPersistent({ tmuxSessionName: tmuxName });
          registry.exitSession(id, result.exitCode || 0);
          return json(res, 200, { status: 'stopped', id });
        } else if (session.pid) {
          try {
            process.kill(session.pid, 'SIGTERM');
          } catch {}
          registry.exitSession(id, 0);
          return json(res, 200, { status: 'stopped', id });
        } else {
          registry.exitSession(id, 0);
          return json(res, 200, { status: 'stopped', id });
        }
      }
    } catch (e) {
      return json(res, 500, { error: `Failed to stop session: ${e.message}` });
    }
    return;
  }

  // GET /scratchpads — list active task scratchpads
  if (req.method === 'GET' && pathname === '/scratchpads') {
    const tasksDir = `${HOME}/agent-memory/nexus/tasks`;
    const list = [];
    try {
      if (existsSync(tasksDir)) {
        const projects = readdirSync(tasksDir);
        for (const project of projects) {
          const projectPath = path.join(tasksDir, project);
          if (statSync(projectPath).isDirectory()) {
            const issues = readdirSync(projectPath);
            for (const issue of issues) {
              const issuePath = path.join(projectPath, issue);
              const scratchpadFile = path.join(issuePath, 'scratchpad.md');
              if (statSync(issuePath).isDirectory() && existsSync(scratchpadFile)) {
                list.push({ project, issue, path: scratchpadFile });
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn('Failed to read scratchpads directory:', e.message);
    }
    return json(res, 200, { scratchpads: list });
  }

  // GET /scratchpad — get scratchpad content
  if (req.method === 'GET' && pathname === '/scratchpad') {
    const project = url.searchParams.get('project') || '';
    const issue = url.searchParams.get('issue') || '';
    
    if (!project || !issue) {
      return json(res, 400, { error: 'project and issue query parameters are required' });
    }
    
    if (project.includes('..') || issue.includes('..')) {
      return json(res, 400, { error: 'Invalid project or issue format' });
    }
    
    const file = `${HOME}/agent-memory/nexus/tasks/${project}/${issue}/scratchpad.md`;
    if (!existsSync(file)) {
      return json(res, 404, { error: 'Scratchpad not found' });
    }
    
    try {
      const content = readFileSync(file, 'utf8');
      return text(res, 200, content);
    } catch (e) {
      return json(res, 500, { error: `Failed to read scratchpad: ${e.message}` });
    }
  }

  // POST /scratchpad — append a message/entry to a task scratchpad
  if (req.method === 'POST' && pathname === '/scratchpad') {
    const { parsed } = await readBody(req);
    const { project, issue, agent = 'Jarvis', message } = parsed;
    
    if (!project || !issue || !message) {
      return json(res, 400, { error: 'project, issue, and message are required' });
    }
    
    if (project.includes('..') || issue.includes('..')) {
      return json(res, 400, { error: 'Invalid project or issue format' });
    }
    
    auditLog('write_scratchpad', req, { project, issue, agent });
    
    try {
      const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'task-scratchpad.js');
      const args = [
        scriptPath,
        '--write',
        `--project=${project}`,
        `--issue=${issue}`,
        `--agent=${agent}`,
        `--message=${message}`
      ];
      const result = execFileSync(process.argv[0], args, { encoding: 'utf8', env: { ...process.env, HOME } });
      return json(res, 200, { status: 'success', output: result });
    } catch (e) {
      return json(res, 500, { error: `Failed to write scratchpad: ${e.message}` });
    }
  }

  // POST /memory/remember — save a durable fact
  if (req.method === 'POST' && pathname === '/memory/remember') {
    const { parsed } = await readBody(req);
    const { fact, section = 'Session Notes', tier = 'personal', target = '' } = parsed;
    
    if (!fact) {
      return json(res, 400, { error: 'fact is required' });
    }
    
    auditLog('remember_fact', req, { tier, target });
    
    try {
      const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'brain-remember.js');
      const args = [
        scriptPath,
        `--fact=${fact}`,
        `--section=${section}`,
        `--tier=${tier}`,
        `--target=${target}`
      ];
      const result = execFileSync(process.argv[0], args, { encoding: 'utf8', env: { ...process.env, HOME } });
      return json(res, 200, { status: 'success', output: result });
    } catch (e) {
      return json(res, 500, { error: `Failed to remember fact: ${e.message}` });
    }
  }

  // GET /memory/search — scored synonym search for memory files
  if (req.method === 'GET' && pathname === '/memory/search') {
    const agent = url.searchParams.get('agent') || '';
    const query = url.searchParams.get('query') || '';
    
    if (!agent || !query) {
      return json(res, 400, { error: 'agent and query parameters are required' });
    }
    
    try {
      const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'memory-lookup.js');
      const args = [
        scriptPath,
        agent,
        query,
        '--json'
      ];
      const result = execFileSync(process.argv[0], args, { encoding: 'utf8', env: { ...process.env, HOME } });
      const scoredFiles = JSON.parse(result);
      return json(res, 200, { results: scoredFiles });
    } catch (e) {
      return json(res, 500, { error: `Failed to search memory: ${e.message}` });
    }
  }

  // GET /memory/file — get memory file content securely
  if (req.method === 'GET' && pathname === '/memory/file') {
    const filePath = url.searchParams.get('path') || '';
    if (!filePath) return json(res, 400, { error: 'path parameter required' });
    
    const resolvedPath = path.resolve(filePath);
    const memoryRoot = path.resolve(`${HOME}/agent-memory`);
    
    // Safety check: must be inside ~/agent-memory
    if (!resolvedPath.startsWith(memoryRoot)) {
      return json(res, 403, { error: 'Access denied: path outside agent-memory root' });
    }
    
    if (!existsSync(resolvedPath)) {
      return json(res, 404, { error: 'File not found' });
    }
    
    try {
      const content = readFileSync(resolvedPath, 'utf8');
      return text(res, 200, content);
    } catch (e) {
      return json(res, 500, { error: `Failed to read file: ${e.message}` });
    }
  }

  return json(res, 404, { error: 'Not found' });
}

// A throw inside handleRequest used to reject unhandled and take the whole
// server process down (one bad request = fleet outage until systemd restarted
// it). Catch here so a broken endpoint degrades to a 500 for that one request.
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    console.error(`[handler] ${req.method} ${req.url} failed:`, err);
    try {
      if (!res.headersSent) json(res, 500, { error: 'Internal server error' });
      else res.end();
    } catch { /* response already destroyed */ }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\nClaude Remote Control Server`);
  console.log(`  Local:   http://${HOST}:${PORT}`);
  if (PUBLIC_URL) {
    console.log(`  Public:  ${PUBLIC_URL}`);
  }
  // Advertise the host's real external IPv4 addresses (LAN / Tailscale) so a
  // phone or laptop can reach the panel — only meaningful when not loopback-only.
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    for (const ip of lanAddresses(networkInterfaces())) {
      console.log(`  LAN:     http://${ip}:${PORT}`);
    }
  }
  console.log(`  Panel:   http://${HOST}:${PORT}/panel?key=<key>`);
  console.log(`  Key:     ${SECRET.slice(0,8)}...${SECRET.slice(-4)}\n`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.warn(
      `  WARNING: bound to ${HOST}, not loopback-only. Anyone who can reach this ` +
      `host/port on the network can spawn agent runs if they obtain the bearer key.\n` +
      `  Guards active: timing-safe bearer auth, 100 req/min per-IP rate limit, ` +
      `lockout after 10 failed auths/min, IP allowlist ${ALLOWLIST.length ? `(${ALLOWLIST.length} rule(s))` : 'NOT CONFIGURED'}.\n` +
      (ALLOWLIST.length ? '' :
        `  Set ~/.claude/webhook-allowlist.json {"allow":["192.168.1.0/24"]} to restrict by source IP.\n`) +
      `  Prefer an SSH tunnel or a trusted-LAN-only network for phone access; rotate ` +
      `the key (~/.claude/remote-webhook.key) periodically and keep its file ACL ` +
      `restricted to the owning user.\n`
    );
  }
});

server.on('error', err => { console.error('Server error:', err); process.exit(1); });
