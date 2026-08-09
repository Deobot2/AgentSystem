// graph-lib.js — core graph library, zero npm dependencies
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// Cross-CLI shared memory root. Neutral path — readable by Claude, Gemini, Copilot, any CLI.
// Override with AGENT_MEMORY_ROOT env var if needed.
export function agentMemoryRoot() {
  return process.env.AGENT_MEMORY_ROOT || join(homedir(), 'agent-memory');
}

// Single source of truth for "where does this repo's graph brain live on disk".
// Repo brains live IN the repo working tree (<repo path>/nexus/<slug>/graph.json),
// not under agentMemoryRoot() — only the personal-brain / agent-brain tiers live there.
// `repo` is a known-repos.json entry: { slug, path, brain_path? }.
// brain_path (when present) is relative to repo.path; falls back to 'nexus/<slug>'
// for entries registered before brain_path existed.
export function resolveRepoBrainDir(repo) {
  if (!repo || !repo.path) return null;
  const rel = repo.brain_path
    ? dirname(repo.brain_path)
    : join('nexus', repo.slug);
  return join(repo.path, rel);
}

export function resolveRepoGraphPath(repo) {
  const dir = resolveRepoBrainDir(repo);
  return dir ? join(dir, 'graph.json') : null;
}

// --- Fix 2: Context-adaptive weight profiles ---
// Different task modes weight graph dimensions differently.
// Debugging: co_change matters most (what changed together when this broke?)
// Architecture: semantic matters most (what concepts are related?)
// Routine: confidence matters most (what worked before?)
// Incident: co_change + speed (what's coupled, fast)
export const WEIGHT_PROFILES = {
  debugging:    { co_change: 0.40, semantic: 0.15, visit_count: 0.25, confidence: 0.20 },
  architecture: { co_change: 0.10, semantic: 0.40, visit_count: 0.15, confidence: 0.35 },
  routine:      { co_change: 0.15, semantic: 0.20, visit_count: 0.25, confidence: 0.40 },
  incident:     { co_change: 0.45, semantic: 0.10, visit_count: 0.20, confidence: 0.25 },
  default:      { co_change: 0.20, semantic: 0.20, visit_count: 0.30, confidence: 0.30 },
};

export function emptyGraph(brain, projectSlug) {
  return { version: '1.0', brain, project_slug: projectSlug, nodes: [], edges: [] };
}

export function readGraph(graphPath) {
  return JSON.parse(readFileSync(graphPath, 'utf8'));
}

// Read-only analysis passes (decay, stale-detection) run over a brain that may
// legitimately not have a graph.json yet -- per-repo/agent brains are gitignored,
// so a fresh host or a brain nothing has written to yet is a normal state, not a
// corruption (see CLAUDE.md "Central brain"). Returns null instead of throwing so
// callers can skip cleanly without ever writing a placeholder graph to disk.
export function readGraphIfExists(graphPath) {
  return existsSync(graphPath) ? readGraph(graphPath) : null;
}

export function writeGraph(graphPath, graph) {
  mkdirSync(dirname(graphPath), { recursive: true });
  writeFileSync(graphPath, JSON.stringify(graph, null, 2) + '\n', 'utf8');
}

export function addNode(graph, nodeId) {
  if (graph.nodes.includes(nodeId)) return graph;
  return { ...graph, nodes: [...graph.nodes, nodeId] };
}

export function addEdge(graph, source, target) {
  const exists = graph.edges.some(e => e.source === source && e.target === target);
  if (exists) return graph;
  const edge = {
    source,
    target,
    weights: {
      co_change: 0.0,
      semantic: 0.0,
      _visit_raw: 0,
      visit_count: 0.0,
      last_visited: null,
      confidence: { n_confirms: 0, n_contradicts: 0 },
      valid_from: new Date().toISOString(),
      valid_until: null,
    },
    composite: 0.0,
  };
  const protectedEdge = { source, target };
  let updated = { ...graph, edges: [...graph.edges, edge] };
  updated = enforceEdgeCap(updated, source, 15, protectedEdge);
  updated = enforceEdgeCap(updated, target, 15, protectedEdge);
  return updated;
}

// Fix 1: Temporal decay — visit_count decays over time without reinforcement.
// Half-life: 30 days. An edge not touched in 30 days has half its normalized visit strength.
export function updateVisitCount(graph, source, target) {
  const now = new Date().toISOString();
  const edges = graph.edges.map(e => {
    if (e.source === source && e.target === target) {
      return {
        ...e,
        weights: {
          ...e.weights,
          _visit_raw: (e.weights._visit_raw || 0) + 1,
          last_visited: now,
        },
      };
    }
    return e;
  });
  const maxRaw = Math.max(...edges.map(e => e.weights._visit_raw || 0), 1);
  const normalized = edges.map(e => ({
    ...e,
    weights: { ...e.weights, visit_count: (e.weights._visit_raw || 0) / maxRaw },
  }));
  const recomputed = normalized.map(e => ({ ...e, composite: recomputeComposite(e.weights) }));
  return { ...graph, edges: recomputed };
}

// Apply Ebbinghaus decay to a visit_count score at query time.
// decayed = visit_count * 0.5^(daysSinceLast / effectiveHalfLife)
// degreeCentrality: hub nodes decay slower (more connections = more durable memory)
export function decayedVisitScore(visit_count, last_visited, now = Date.now(), halfLifeDays = 30, degreeCentrality = 0) {
  if (!last_visited || !visit_count) return 0;
  const alpha = 0.5;
  const effectiveHalfLife = halfLifeDays * (1 + alpha * degreeCentrality);
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysSince = (now - new Date(last_visited).getTime()) / msPerDay;
  const decay = Math.pow(0.5, daysSince / effectiveHalfLife);
  return parseFloat((visit_count * decay).toFixed(4));
}

// Bayesian confidence updates using n_confirms / n_contradicts counts.
// delta > 0 → increment n_confirms; delta < 0 → increment n_contradicts
// Posterior mean = (n_confirms + 1) / (n_confirms + n_contradicts + 2)  [Laplace smoothing]
export function updateConfidence(graph, source, target, delta) {
  const edges = graph.edges.map(e => {
    if (e.source === source && e.target === target) {
      const conf = e.weights.confidence && typeof e.weights.confidence === 'object'
        ? { ...e.weights.confidence }
        : { n_confirms: 0, n_contradicts: 0 };
      if (delta > 0) conf.n_confirms += 1;
      else if (delta < 0) conf.n_contradicts += 1;
      const updated = {
        ...e,
        weights: {
          ...e.weights,
          confidence: conf,
        },
      };
      return { ...updated, composite: recomputeComposite(updated.weights) };
    }
    return e;
  });
  return { ...graph, edges };
}

// recomputeComposite accepts mode string OR weight config object.
// Handles Bayesian confidence object by computing posterior mean.
export function recomputeComposite(weights, config = {}) {
  const profile = typeof config === 'string'
    ? (WEIGHT_PROFILES[config] || WEIGHT_PROFILES.default)
    : { ...WEIGHT_PROFILES.default, ...config };
  const confVal = typeof weights.confidence === 'object' && weights.confidence !== null
    ? (weights.confidence.n_confirms + 1) / (weights.confidence.n_confirms + weights.confidence.n_contradicts + 2)
    : (weights.confidence || 0);
  return parseFloat((
    (weights.co_change || 0) * profile.co_change +
    (weights.semantic || 0) * profile.semantic +
    (weights.visit_count || 0) * profile.visit_count +
    confVal * profile.confidence
  ).toFixed(4));
}

// Enforce a maximum edge count per node. Removes lowest-composite edges until count <= cap.
// protectedEdge: { source, target } — this edge is excluded from removal candidates.
// Tie-breaking: when composite values are equal, null last_visited is oldest (remove first).
export function enforceEdgeCap(graph, nodeId, cap = 15, protectedEdge = null) {
  const nodeEdges = graph.edges.filter(e => e.source === nodeId || e.target === nodeId);
  if (nodeEdges.length <= cap) return graph;
  const isProtected = e => protectedEdge &&
    e.source === protectedEdge.source && e.target === protectedEdge.target;
  const candidates = nodeEdges.filter(e => !isProtected(e));
  // Stable sort: ascending composite, then null last_visited first (oldest)
  const sorted = [...candidates].sort((a, b) => {
    const diff = (a.composite || 0) - (b.composite || 0);
    if (diff !== 0) return diff;
    const aTime = a.weights?.last_visited ? new Date(a.weights.last_visited).getTime() : -Infinity;
    const bTime = b.weights?.last_visited ? new Date(b.weights.last_visited).getTime() : -Infinity;
    return aTime - bTime;
  });
  const toRemove = new Set();
  for (let i = 0; i < nodeEdges.length - cap; i++) {
    if (sorted[i]) toRemove.add(sorted[i]);
  }
  const edges = graph.edges.filter(e => !toRemove.has(e));
  return { ...graph, edges };
}

// Fix 7 (issue #38): Salience tagging — high-stakes events encode stronger memories.
export function computeSalience({ incident = false, durationMinutes = 0, firstTimeSolve = false, presolveConfidence = 1.0 } = {}) {
  let s = 0.0;
  if (incident) s += 0.40;
  if (durationMinutes > 120) s += 0.20;
  if (firstTimeSolve) s += 0.20;
  if (presolveConfidence < 0.3) s += 0.20;
  return parseFloat(Math.min(1.0, s).toFixed(4));
}

// Need-probability (Anderson & Schooler): rank by relevance/recency × importance.
// baseScore already encodes recency×frequency (decayed visit) + relevance (BM25), so this
// only multiplies in the orthogonal importance signal. importance ∈ [0,1], default 0 = neutral.
// Returns baseScore × (1 + gain × importance). No migration: absent importance leaves score unchanged.
export function needProbabilityScore(baseScore, importance = 0, gain = 0.5) {
  const imp = Math.max(0, Math.min(1, importance || 0));
  return parseFloat((baseScore * (1 + gain * imp)).toFixed(4));
}

// Adaptive importance — blends section-assigned static importance with a learned access signal.
// accessSignal: normalised, RECENCY-FREE frequency derived from raw visit_count (not decayed),
// so it measures durability/frequency without double-counting the recency already in baseScore.
// Floor: static importance is a strict floor so hard-constraints never degrade.
// Ceiling: 1.0. Formula: static + gain × accessSignal × (1 − static).
// WHY gain*(1-static): boost room shrinks as static rises — high-static nodes need no help.
export function effectiveImportance(staticImportance = 0, accessSignal = 0, { gain = 0.5 } = {}) {
  const s = Math.max(0, Math.min(1, staticImportance || 0));
  const a = Math.max(0, Math.min(1, accessSignal || 0));
  return parseFloat(Math.min(1, s + gain * a * (1 - s)).toFixed(4));
}

// Derive the access signal for a single node from its incident edges.
// Uses NORMALISED (not time-decayed) visit_count so recency is NOT included — this is
// a pure frequency/durability signal. Returns max normalised visit_count across all incident edges.
export function nodeAccessSignal(edges, nodeId) {
  const incident = edges.filter(e => e.source === nodeId || e.target === nodeId);
  if (incident.length === 0) return 0;
  return Math.max(...incident.map(e => e.weights?.visit_count || 0));
}

// Fix 8 (issue #35): Episodic memory node builder.
export function buildEpisodeNode({ id, sequence = [], contextTags = [], salience = 0.0, durationMinutes = 0, outcomeRef = null, connections = [] }) {
  const created = new Date().toISOString().slice(0, 10);
  const frontmatter = {
    id,
    type: 'episode',
    brain: 'agent',
    created,
    context_tags: contextTags,
    salience,
    duration_minutes: durationMinutes,
    ...(outcomeRef ? { outcome_ref: outcomeRef } : {}),
    connections: [...(outcomeRef ? [`[[${outcomeRef.replace(/[\[\]]/g, '')}]]`] : []), ...connections],
  };
  const seqLines = sequence.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const body = `# Episode: ${id}\n\n## Sequence\n\n${seqLines || '(none recorded)'}\n\n**Salience:** ${salience}\n**Duration:** ${durationMinutes} min\n`;
  return serializeFrontmatter(frontmatter, body);
}

// Fix 9 (issue #39): Cross-agent memory propagation gate check.
export function shouldPropagate(confidence, salience) {
  return confidence >= 0.8 && salience >= 0.7;
}

export function buildSharedMemoryEntry({ id, body, confidence, salience, sourceAgent, audience = [] }) {
  const created = new Date().toISOString().slice(0, 10);
  const frontmatter = {
    id: `shared-${id}`,
    type: 'shared-outcome',
    brain: 'agent',
    created,
    source_agent: sourceAgent,
    audience,
    confidence,
    salience,
  };
  return serializeFrontmatter(frontmatter, body);
}

export function pruneOrphanedEdges(graph) {
  const nodeSet = new Set(graph.nodes);
  const edges = graph.edges.filter(e => nodeSet.has(e.source) && nodeSet.has(e.target));
  return { ...graph, edges };
}

// Spreading activation — multi-hop traversal with decay per hop.
// lateralInhibition: after each hop, keep top M=7 nodes at full strength,
// apply β=0.15 penalty to the rest to prevent hub nodes from dominating.
export function spreadingActivation(graph, seedNodes, {
  maxHops = 3,
  decayPerHop = 0.5,
  threshold = 0.1,
  lateralInhibition = true,
} = {}) {
  const activation = new Map();
  const seedSet = new Set(seedNodes);

  let frontier = new Map(seedNodes.map(n => [n, 1.0]));

  for (let hop = 0; hop < maxHops; hop++) {
    const nextFrontier = new Map();

    for (const [nodeId, strength] of frontier) {
      const edges = graph.edges.filter(
        e => e.source === nodeId || e.target === nodeId
      );

      for (const edge of edges) {
        const neighbor = edge.source === nodeId ? edge.target : edge.source;
        const newStrength = strength * decayPerHop * (edge.composite || 0.01);

        if (newStrength < threshold) continue;

        const existing = nextFrontier.get(neighbor) ?? 0;
        if (newStrength > existing) {
          nextFrontier.set(neighbor, newStrength);
        }

        const globalExisting = activation.get(neighbor) ?? 0;
        if (newStrength > globalExisting) {
          activation.set(neighbor, parseFloat(newStrength.toFixed(4)));
        }
      }
    }

    // Lateral inhibition: keep top M=7 nodes at full strength, penalise rest
    if (lateralInhibition && nextFrontier.size > 0) {
      const M = 7;
      const beta = 0.15;
      const sorted = [...nextFrontier.entries()].sort((a, b) => b[1] - a[1]);
      for (let i = M; i < sorted.length; i++) {
        const [nodeId, str] = sorted[i];
        const inhibited = str * (1 - beta);
        nextFrontier.set(nodeId, inhibited);
        // Update global activation map with inhibited value if it was previously set from this hop
        const globalExisting = activation.get(nodeId) ?? 0;
        if (inhibited < globalExisting) {
          // Don't reduce global — global tracks max across hops; inhibition is frontier-local
        } else {
          activation.set(nodeId, parseFloat(inhibited.toFixed(4)));
        }
      }
    }

    frontier = nextFrontier;
    if (frontier.size === 0) break;
  }

  for (const seed of seedSet) {
    activation.delete(seed);
  }

  return activation;
}

export function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n?---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  return { frontmatter: parseYaml(match[1]), body: match[2] };
}

export function serializeFrontmatter(frontmatter, body) {
  return `---\n${toYaml(frontmatter)}---\n\n${body.trimStart()}`;
}

function parseYaml(text) {
  const result = {};
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const inlineArr = line.match(/^([\w-]+):\s+\[([^\]]*)\]\s*$/);
    if (inlineArr) {
      result[inlineArr[1]] = inlineArr[2].split(',').map(s => s.trim());
      i++; continue;
    }
    const blockListStart = line.match(/^([\w-]+):\s*$/);
    if (blockListStart) {
      const key = blockListStart[1];
      const items = [];
      i++;
      while (i < lines.length && lines[i].match(/^\s+-\s+/)) {
        items.push(lines[i].replace(/^\s+-\s+/, '').replace(/^["']|["']$/g, ''));
        i++;
      }
      result[key] = items;
      continue;
    }
    const scalar = line.match(/^([\w-]+):\s+(.+)$/);
    if (scalar) {
      const raw = scalar[2];
      if (raw === 'true') result[scalar[1]] = true;
      else if (raw === 'false') result[scalar[1]] = false;
      else result[scalar[1]] = raw.replace(/^["']|["']$/g, '');
    }
    i++;
  }
  return result;
}

// #144/#155: escape embedded double quotes and backslashes before quoting a scalar,
// and force-quote any string scalar containing YAML-significant characters (colon,
// hash, newline, leading/trailing whitespace) that would otherwise silently corrupt
// the frontmatter block or get parsed as the wrong type.
function yamlEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
function needsQuoting(s) {
  return typeof s === 'string' && /[:#\n"]|^\s|\s$|^$/.test(s);
}
export function toYamlScalar(v) {
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (needsQuoting(v)) return `"${yamlEscape(v)}"`;
  return String(v);
}

export function toYaml(obj) {
  return Object.entries(obj).map(([k, v]) => {
    if (Array.isArray(v)) {
      if (v.length === 0) return `${k}: []`;
      if (k === 'connections') {
        return `${k}:\n${v.map(s => `  - "${yamlEscape(s)}"`).join('\n')}`;
      }
      return `${k}: [${v.map(s => toYamlScalar(s)).join(', ')}]`;
    }
    return `${k}: ${toYamlScalar(v)}`;
  }).join('\n') + '\n';
}
