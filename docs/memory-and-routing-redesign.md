# Memory & Routing Redesign — Research + Design Doc

**Author:** Friday (CTO), Jarvis oversight · **Date:** 2026-06-03 · **Status:** Wire-up complete 2026-06-06
**Scope:** Two independent workstreams — (A) agent memory system, (B) lightweight routing.

---

## 0. TL;DR — the reframe

The starting premise was "memory is inefficient by design: collection, retention, and retrieval are all broken — rebuild it." **The evidence contradicts that.** The cognitive architecture already exists and is good. The failures are **wiring and usage**, not design. Rebuilding would violate your own rule (*"don't rebuild things that already exist"*).

**Empirical anchor.** Same "who am I" lookup, two ways:

| Path | Tokens |
|------|--------|
| Jarvis subagent (what actually happened) | **47,129** |
| `graph-query personal-brain "who am I identity"` (the path that should run) | **~110** (427 chars) |

~400×. The efficient retrieval returned exactly the right nodes (`solo-founder-developer`, `subscriptions`, `primary-repos`, `communication-style`, `architecture-delegation`). The machinery works. It is not being invoked.

**The real problem is three unwired connections + one stale data store**, detailed below.

---

## 1. Current-state audit

### 1.1 What already exists and is good (`tools/graph/graph-lib.js`)

| Human-memory faculty | Implementation | Where |
|---|---|---|
| Relevance ranking | BM25 (k1=1.5, b=0.75) | `graph-query.js:28-44` |
| Forgetting curve | Ebbinghaus decay, 30-day half-life, hub nodes decay slower (degree-centrality) | `graph-lib.js:98-106` |
| Associative recall | Spreading activation, 3-hop, lateral inhibition (top-7/hop) | `graph-lib.js:233-298` |
| Confidence / belief | Bayesian posterior with Laplace smoothing | `graph-lib.js:111-131` |
| Importance | `computeSalience()` — incident severity, duration, first-solve | `graph-lib.js:176-183` |
| Context-aware ranking | Mode weight profiles (debugging/architecture/routine/incident) | `graph-lib.js:18-24` |
| Priming | `--primed` adds bonus to neighbors of active nodes | `graph-query.js` |

This is a credible cognitive model — it independently implements the things the human-memory literature says matter (§2).

### 1.2 What is WIRED vs ORPHANED

**Wired (invoked by an agent def, cron, or tool):** `graph-lib`, `graph-query` (`--hot-stub` in agent startups), `graph-init`, `memory-lookup`, `memory-search`, `memory-decay` (cron), `memory-stale` (cron), `compute-trust-scores` (cron), `personal-brain-split` (cron), `known-repos`.

**Orphaned (exists, nothing calls it):** `graph-weight`, **`graph-consolidate`** (the episodic→semantic distiller — never scheduled), `memory-embed`, `memory-reinforce`, **`sona-append`** (the write-back tool — no hook calls it), **`decision-log`**, **`task-scratchpad`**, `agent-brain-seed` (manual only).

### 1.3 The four concrete defects

1. **Retrieval not invoked + a path bug.** The efficient query exists but agents `ls`+`read` flat files instead. Worse: Jarvis's own startup command (`jarvis.md:79,128,132`) queries `--brain-path=~/agent-memory/nexus` → looks for `nexus/graph.json`. The graph is actually at `nexus/personal-brain/graph.json`. **The documented command errors every time.**

2. **Personal brain was never populated as a graph.** `personal-brain-split.js` existed but the `nodes/` directory did not exist until it was run manually today (→ 37 nodes, 31 edges). The "Monday 8am" cron in `scheduled-tasks.yml:25-33` is on a **`self-hosted` runner that has not been executing** (nodes absent despite the schedule). So even the wired consolidation isn't actually running.

3. **No automatic write-back.** `sona-append.js`, `decision-log.js`, `task-scratchpad.js` are all orphaned. Nothing captures facts *during* a session. That is why "the breakdown of me isn't detailed" — collection is manual, and `user-brain.md` was last hand-edited 2026-05-27.

4. **No episodic→semantic consolidation in the cycle.** `graph-consolidate.js` (distills outcome clusters → `reasoning-bank.md`) is orphaned. No importance score is written at encode time (`computeSalience` is never called during writes). No per-project read scoping — queries cross-contaminate across repos.

---

## 2. Human memory — model & transferable principles

Sources are cited inline; full list in §6. Load-bearing claims anchored to primary papers.

| Faculty | How it works in humans | Transferable principle |
|---|---|---|
| **Tiers** | Working (~4 chunks, Cowan [6]), episodic (events), semantic (facts), procedural (skills) — distinct stores [1][4] | Keep separate tiers: bounded working set + episodic log + semantic facts + procedural playbooks |
| **Encoding** | Attention + salience gate what sticks; arousal tags priority items, *impairs* low-priority ones [8][9][12] | Score each event for importance/goal-relevance **at write time**; don't store everything equally |
| **Consolidation** | Sleep replays episodes, abstracts gist, transfers episodic→semantic ("semantization") [13][14][15] | Run an offline "sleep" pass that distills recurring episodes into semantic facts |
| **Reconsolidation** | Recalled memories become labile and are re-saved — they change on retrieval [14][17] | Rewrite/refine entries on access, not append-only freezing |
| **Retrieval** | Cue-dependent; spreading activation; **need-probability** = frequency × recency × pattern (Anderson & Schooler [25][26]) | Rank by relevance × associative links × need-probability — not similarity alone |
| **Forgetting** | Ebbinghaus power-law curve [23][24]; adaptive — discards low-need items so recall stays cheap; spacing effect strengthens on review | Decay low-need memories (prune for relevance, not just age); strengthen on each access |

**The single most transferable idea — need-probability (Anderson & Schooler [25][26]):** encoding strength, retrieval rank, and forgetting are all downstream of one estimate — *"how likely is this to be needed again?"* — computed from importance at write time + frequency/recency at access. Get that score right and the other behaviors largely follow. The graph already has the inputs (visit_count, decay, confidence); it does not yet combine them into an explicit need score at encode.

---

## 3. Best agent-memory systems — patterns to steal

| System | One key idea | Relevance to us |
|---|---|---|
| **MemGPT / Letta** [arXiv 2310.08560] | Self-editing memory blocks with hard char budgets; agent curates an always-in-context summary via tool calls | Gives agents a hot-path write tool — fills our write-back gap |
| **mem0** [arXiv 2504.19413] | Every new fact reconciled vs neighbors → **ADD / UPDATE / DELETE / NOOP** before writing | Prevents contradiction buildup; our `memory-reinforce` is the half-built version |
| **Generative Agents** [arXiv 2304.03442] | Retrieval = **recency × importance × relevance**; periodic **reflection** abstracts episodes into insights | The reference salience model; we have recency+relevance, missing importance-at-write + reflection |
| **A-MEM** [arXiv 2502.12110] | **Memory evolution** — new writes retroactively update linked old notes | Our graph edges approximate this; evolution step is missing |
| **Zep / Graphiti** [arXiv 2501.13956] | **Bi-temporal edges** — supersede facts (invalidate, don't delete); reason about what was true *when* | Upgrade path for conflict resolution that preserves history |
| **Claude memory tool** [docs.claude.com] | File-directory memory + **context editing** evicts stale in-context junk while model spills durable state to files | Native pattern; pairs with our file-based nodes |
| **LangMem / LangGraph** | Explicit semantic/episodic/procedural split; **hot-path + background** dual write modes | Names the tiering and the two-speed write-back we should adopt |

**Recurring patterns across all of them:**
1. **Dual write-back** — cheap hot-path capture during the turn + heavier async/background processing.
2. **Consolidation pass** — reconcile new facts against neighbors, abstract episodic→semantic, *supersede don't delete*.
3. **Importance/salience at encode** — Generative Agents' explicit score is the cleanest.
4. **Layered scoping** — `session → user → agent/project → global`; session ephemeral, user/global durable.

**Verdict:** every pattern the best systems add sits *on top of* primitives we already have. This confirms wire-up, not rebuild.

---

## 4. Proposed architecture — Memory (Workstream A)

Reuse all of `graph-lib`. Add the four missing connectors.

### A1. Encode — automatic write-back (fills gap #3)
- **Hot path:** a `Stop`/`SubagentStop` hook calls `sona-append.js` (already built, orphaned) to capture `{task, files, outcome, agent}` at task end. Plus wire `decision-log.js` for architectural decisions.
- **Importance at write:** call `computeSalience()` (already in `graph-lib.js:176`) during encode and persist the score on the node — so retrieval can use a true `need-probability` term (§2).
- Borrowed from: MemGPT hot-path, Generative Agents importance-at-write.

### A2. Consolidate — the "sleep" cycle (fills gaps #2, #4)
- **Fix the runner first** — the `self-hosted` cron in `scheduled-tasks.yml` isn't running; until it does, no scheduled memory work happens. Either register the runner reliably or move these to a local Windows Task Scheduler job.
- **Add `graph-consolidate.js` to the cycle** (currently orphaned): cluster recent episodic outcomes → promote to semantic nodes in `reasoning-bank.md`.
- **Add a reconciliation step** (mem0 ADD/UPDATE/DELETE/NOOP) using the existing `memory-reinforce.js` Bayesian update + dedupe by keyword overlap.
- Borrowed from: Generative Agents reflection, mem0 reconciliation, human systems-consolidation.

### A3. Retrieve — actually invoke it (fills gap #1)
- **Fix the `--brain-path` bug** in `jarvis.md` (and any agent that copied it): `…/nexus/personal-brain`, not `…/nexus`.
- Make `graph-query --hot-stub` (+ keyword query) the **standard** identity/context load — not `ls`+`read`. ~110 tokens vs 47k.
- Add the `need-probability` term (recency × frequency × importance) to the composite so ranking matches §2.

### A4. Scope — three-layer read (fills gap #4)
- Standard startup loads, merged: **global user brain** (who Nathan is) + **active-project brain** (this repo's graph) + **recent episodic** (last N session outcomes).
- Borrowed from: mem0 `user_id/agent_id/run_id`, LangMem namespaces. The per-repo and per-agent graphs already exist; this just composes them at query time with project awareness.

---

## 5. Proposed architecture — Lightweight Router (Workstream B)

**Decision:** lightweight router + keep Jarvis. **Independent of memory work — do not couple them.**

**Harness facts (authoritative):**
- There is **no** way to make a subagent the literal default entry that intercepts the first message. "Jarvis is the default entry agent" is unenforceable prose.
- `SessionStart` / `UserPromptSubmit` hooks can only **inject context** — they cannot reroute or rewrite the prompt.
- Subagents do **not** inherit MCP servers or the parent context by default; cost comes from the agent's own `mcpServers` list + tools + its exploration. The 47k was Jarvis loading 4 MCP servers + a 9-step startup ritual for a trivial question.

**Recommended design (combine two cheap mechanisms):**
1. **`UserPromptSubmit` hook** — fast local classifier (regex/keyword on the prompt) injects a routing hint: trivial/identity/lookup → "answer inline from `graph-query`"; domain work → Friday/etc.; genuine cross-domain/CEO → Jarvis. ~0 token cost.
2. **Jarvis def + a `router` discipline** — rewrite Jarvis's "default entry" prose into "invoke only for genuine cross-domain/CEO work; trivial questions answered inline." Optionally a Haiku-tier `router` subagent (no MCPs, Read/Grep/Glob only) for nuanced cases (~2-3k tokens, still ~15× cheaper than 47k).
3. **Make Jarvis cheap on trivial paths** — don't load 4 MCP servers and run the 9-step ritual to answer "who am I." Gate the startup ritual behind actual orchestration tasks.

Target: trivial query **47k → ~1-2k tokens**.

---

## 6. Phased plan (no code until approved)

**Workstream B (router) — small, do first, unblocks the token bleed:**
- B1. Fix `--brain-path` bug in `jarvis.md`. *(verify: query returns nodes, not "No graph")*
- B2. `UserPromptSubmit` classifier hook + rewrite Jarvis entry prose. *(verify: "who am I" answers <2k tokens)*

**Workstream A (memory) — wire up, in order:**
- A0. Fix/replace the self-hosted cron so scheduled jobs actually run. *(verify: nodes regenerate on schedule)*
- A1. `Stop`-hook write-back via `sona-append` + `decision-log`; persist `computeSalience` at encode. *(verify: a session writes an episodic node)*
- A2. Add `graph-consolidate` + reconciliation to the weekly cycle. *(verify: reasoning-bank grows from real outcomes)*
- A3. Add `need-probability` term to composite; make `graph-query` the standard load. *(verify: ranking surfaces recent+important first)*
- A4. Three-layer scoped read at startup. *(verify: project query doesn't return unrelated-repo nodes)*

**Explicitly NOT doing:** rebuilding `graph-lib`, replacing BM25/decay/spreading-activation, adopting a new framework, or adding npm deps (per your zero-dep rule).

---

## 7. Sources

**Human memory:** Cowan 4-chunk [PMC2864034]; Miller 7±2; Anderson & Schooler, *Reflections of the Environment in Memory* [users.cs.northwestern.edu/~paritosh/papers/KIP/AndersonSchooler1991…]; Schooler & Anderson, *Adaptive Nature of Memory* [act-r.psy.cmu.edu]; Ebbinghaus forgetting curve [en.wikipedia.org/wiki/Forgetting_curve]; Wixted & Ebbesen power-law [PLOS ONE 10.1371/journal.pone.0120644]; systems consolidation & sleep [PMC3278619; Cell Neuron S0896-6273(15)00761-8; S0896-6273(23)00201-5]; reconsolidation [PMC2680680]; spreading activation [PMC5664228; bioRxiv 778563]; emotion/arousal encoding [PNAS 0506308103; eNeuro 0108-18.2019].

**Agent systems:** MemGPT [arXiv 2310.08560; letta.com/blog/memory-blocks]; mem0 [arXiv 2504.19413; docs.mem0.ai]; Generative Agents [arXiv 2304.03442; ACM 3586183.3606763]; A-MEM [arXiv 2502.12110]; Zep/Graphiti [arXiv 2501.13956; neo4j.com/blog/developer/graphiti-knowledge-graph-memory]; Claude memory tool & context management [docs.claude.com/en/docs/agents-and-tools/tool-use/memory-tool; anthropic.com/news/context-management]; LangMem/LangGraph [rywalker.com/research/langmem].

**Harness:** Claude Code hooks [code.claude.com/docs/en/hooks-guide]; subagents [code.claude.com/docs/en/sub-agents].

**Internal:** `tools/graph/graph-lib.js`, `graph-query.js`; `tools/personal-brain-split.js`; `tools/sona-append.js`, `decision-log.js`, `graph-consolidate.js` (orphaned); `.github/workflows/scheduled-tasks.yml`; `.agents/agents/jarvis.md`.

---

## 9. Implementation status — 2026-06-06 wire-up

### P0 — Tilde expansion bug (FIXED)

`--brain-path=~/...` was not expanded by Node's `path.resolve()` — treated `~` as a literal directory. Fixed in `graph-query.js` and `graph-consolidate.js` by adding an `expandTilde()` helper (exported, tested with 5 unit tests). Verified: `graph-query.js personal-brain --hot-stub "--brain-path=~/agent-memory/nexus/personal-brain"` returns real nodes.

Note: the documented brain-path in jarvis.md/friday.md/system_instructions.md is CORRECT (`~/agent-memory/nexus/personal-brain`). The fix was in the tool, not the docs.

### P0 — Friday parallel-spawn prose (FIXED)

Three locations in friday.md claimed "SINGLE parallel batch — one message, multiple agent calls" with an implication of concurrent threads. Corrected to "single response turn — issue multiple agent invocations in one message. The harness serializes tool calls within a turn." Also fixed the "Claude Code only" distinction — same mechanism works across runtimes.

### P0 — UserPromptSubmit identity short-circuit (CONFIRMED)

Hook emits ~46 tokens advisory hint for identity queries. Hook is advisory-only (harness cannot reroute). Confirmed: regex matches and lightweight hint emitted, no heavyweight agent spawn forced.

### Routines engine (BUILT — 2026-06-06)

Hard-enforced, runtime-bypassable rules system for agent behavior.

**Registry:** `config/routines.yml` — single source of truth. Five routines wired:
- `always-worktree` (agent-rule) — feature work in a git worktree
- `fix-pr-until-green` (agent-rule) — no DONE until pr-guard passes
- `auto-resolve-pr-comments` (hook) — scheduled comment response ~2min after PR create
- `identity-query-inline` (agent-rule) — inline graph-query for identity lookups
- `teach-the-swarm` (agent-rule, disabled) — meta-routine showing prompt-match→swarm pattern

**CLI:** `node tools/routines.js <list|compile|enable|disable|bypass|unbypass>`

**Bypass (runtime, no registry edit):**
```
node tools/routines.js bypass always-worktree [--session]
node tools/routines.js unbypass always-worktree
```
Override persists to `~/agent-memory/nexus/routine-overrides.json`. Every enforcement point checks this file first.

**Compile → inject:**
```
node tools/routines.js compile
```
Generates `.agents/rules/routines.generated.md` with all enabled, non-bypassed agent-rule actions. This file is read by `hooks/routines-context-inject.js` at SessionStart. Note: the task spec assumed an existing rules-injection path via `agent-context-inject.js`; that path only reads specific YAML files (models.yml, mcps.yml, tools.yml) and does not scan the rules directory. A dedicated `routines-context-inject.js` SessionStart hook was added to fill this gap.

**Hook dispatcher:** `hooks/routine-dispatch.js` — single hook wired to `UserPromptSubmit` + `PostToolUse`. Reads routines.yml + overrides at runtime. Adding a hook-routine = edit yaml only, no settings.json change.

**PR guard:** `tools/pr-guard.js <pr-number>` — checks `gh pr checks` + review CHANGES_REQUESTED. Exits 0=pass, 1=fail.

**Auto-resolve:** `tools/auto-resolve-pr-comments.js` — posts acknowledgment replies to unanswered review comments. Intentionally does NOT dismiss Sam's change-request reviews (preserves security gate).

**Tests:** 15 tests in `tools/routines.test.js` + `tools/pr-guard.test.js`. All passing.

**Verification:**
- `node tools/routines.js list` — shows all 5 routines
- `node tools/routines.js compile` — generates .agents/rules/routines.generated.md
- `node tools/routines.js bypass always-worktree && node tools/routines.js list` — shows [BYPASSED]
- `node tools/pr-guard.js 76` → `PASS` (3 checks green, no blocking reviews)

---

### P1 — Scheduled memory jobs (FIXED)

Dead `self-hosted` GitHub Actions cron replaced with Windows Task Scheduler:
- `AgentSystem-WeeklyBrainConsolidation` — Monday 08:00, `memory-maintenance.js --reflect`
- `AgentSystem-WeeklyMemoryDecay` — Sunday 00:00, `memory-decay.js` for both brains
- Registered via `tools/setup-scheduled-tasks.ps1` (idempotent, supports `-Uninstall`)
- Skipped: daily-standup (needs active claude session), weekly-trust-scores (`compute-trust-scores.js` has pre-existing ESM/CJS bug — uses `require` in ESM scope)
- Verified: both tasks state=Ready in Task Scheduler. `memory-maintenance.js` verified clean manually.

### P2 — computeSalience at encode (FIXED)

`brain-remember.js`'s `remember()` now calls `stampSalience()` after every successful fact write. Salience is computed from: `firstTimeSolve=true` for ADD actions, `presolveConfidence=0.1` for new facts (→ salience 0.40), `presolveConfidence=0.5` for UPDATE (→ salience 0.20). Verified: a live test fact got `salience: 0.4` in its node frontmatter.

`sona-append.js` status: remains an agent-invoked tool (not a hook). It requires structured args (issue/branch/agent/files) that can't be derived from a Stop hook. Agents should call it explicitly after completing issues, as documented in friday.md's SONA Pattern Logging section.

`graph-consolidate.js` is already included in `memory-maintenance.js` step 5 (`consolidate`). Now that the cron actually runs (Task Scheduler), consolidation happens weekly.

### P2b — Wikilink sync (FIXED)

New tool: `tools/graph/wikilink-sync.js`
- Walks `graph.json` edges → writes `connections: [[nodeA]], [[nodeB]]` into each node's frontmatter
- Undirected: both source→target and target→source are written
- Idempotent: second run shows 0 updated
- Wired into `memory-maintenance.js` step 6 (runs after consolidate, before agent-brain-seed)
- Verified live: 41 nodes updated, second run 0 updated. Sample: `solo-founder-developer.md` → `connections: [[subscriptions-claude-max-gemini-pro-github-copilot-use]]`
- 7 unit tests covering: adjacency building, undirected links, isolated nodes, idempotency, stats

### P3 — Obsidian vault setup

Open `~/agent-memory/nexus/` as an Obsidian vault. Obsidian reads `connections: [[wikilink]]` from frontmatter to build its graph view. No code changes needed — just open the directory. After wikilink-sync runs, the graph view will show all edges from graph.json.

---

## 8. Router honest state + "who am I" manual check (2026-06-03)

### What the hook actually does

`~/.claude/hooks/memory-router.js` runs as a `UserPromptSubmit` hook. It classifies the prompt with a regex map and writes an advisory routing hint to stdout. The harness prepends that hint to the prompt before the main loop sees it.

**Hard constraint:** the hook is advisory only. The harness passes the hint as context — it cannot reroute to a different agent. There is no `PreToolUse` intercept for routing.

### Trust augmentation (added 2026-06-03)

The hook now dynamically imports `tools/agent-trust.js` and appends the matched lead's trust score to the hint — e.g. `[trust: 82%]`. If trust < 0.60 it adds `— trust low: consider review or pair`. Falls back silently on file-not-found or parse error.

Format note: `trust-scores.md` on disk uses the hand/`/task-outcome`-maintained format (Score column as 0–1 float). `compute-trust-scores.js` emits a different format (Success Rate column as percentage, from run-log JSON). The parser in `agent-trust.js` handles both. The generator/consumer divergence is a known gap — `compute-trust-scores.js` and the on-disk file are not yet unified.

### Fresh-session "who am I" verification

To confirm the identity-query short-circuit is working in a new session:

1. Open a fresh Claude Code session (no prior context).
2. Type: `who am I`
3. Expected: response answers inline from the personal brain graph (~100-500 tokens). It should NOT spawn Jarvis or any subagent.
4. If it spawns Jarvis or uses >2k tokens: the hook is not firing. Check `~/.claude/settings.json` — `hooks.UserPromptSubmit` must point to `memory-router.js`. Verify with: `node ~/.claude/hooks/memory-router.js` ← type `{"prompt":"who am I"}` on stdin.

### To verify the trust annotation:

```
echo '{"prompt":"fix the bug in the auth api"}' | node ~/.claude/hooks/memory-router.js
```

Expected output contains `[trust: 82%]` (Friday's current score). No throw, exits 0.

---

## 10. Model tiers + swarm topology (2026-06-07)

### Final model map

| Agent | Claude model | Tier | Notes |
|-------|-------------|------|-------|
| jarvis | claude-opus-4-8 | 3 | CEO/orchestrator; requires CC ≥ 2.1.154 |
| sam | claude-sonnet-4-6 | 2 | Security CSO |
| friday | claude-sonnet-4-6 | 2 | CTO |
| nat | claude-sonnet-4-6 | 2 | CBO |
| ultron | claude-haiku-4-5-20251001 | 1 | Backend specialist (downgraded 2026-06-07) |
| pym | claude-haiku-4-5-20251001 | 1 | DB specialist (downgraded 2026-06-07) |
| leo | claude-haiku-4-5-20251001 | 1 | DevOps specialist (downgraded 2026-06-07) |
| astra | claude-haiku-4-5-20251001 | 1 | Frontend specialist (downgraded 2026-06-07) |
| wanda | claude-haiku-4-5-20251001 | 1 | Design system |
| threepio | claude-haiku-4-5-20251001 | 1 | General non-technical worker |
| r2d2 | claude-haiku-4-5-20251001 | 1 | General technical worker |

`config/models.yml` is the single source of truth. Agent frontmatter `model:` fields must match.

**Quality safety valve:** Friday's `spawn_tiers` block in models.yml lets any spawn be escalated to sonnet or opus via `--model=<tier>` when the subtask is complex (architecture, security, >15 files). Base assignment is haiku; complex override is explicit.

**CC upgrade note:** `claude-opus-4-8` requires Claude Code ≥ 2.1.154. Run `claude update` before jarvis sessions if on an older version.

### Jarvis-as-default mechanism

`settings.json` has `"agent": "jarvis"` — this is the settings key that tells the Claude Code harness to load jarvis.md as the system prompt for the main thread. It is NOT a routing layer. The harness still receives every message; jarvis.md's INSTANT ROUTING rules determine whether to answer inline, route to a specialist, or own the task. The `UserPromptSubmit` hook (`memory-router.js`) injects a lightweight advisory hint before the main loop, which Jarvis reads as context.

### Subprocess swarm reality

Swarms are launched as `claude -p "<full-context task>" --agent=X &` subprocesses. Each subprocess is its own top-level CLI process — it can itself spawn further `claude -p` subprocesses, enabling true hierarchical nesting (Jarvis→Fridays→workers). There is no harness-level "in-session fan-out" — the `&` background mechanism is what creates parallelism.

**Gemini/Copilot multi-CLI dispatch is NOT currently active.** Agent defs previously claimed Gemini/Copilot swarms worked identically; that was fiction. Until wired, those runtimes execute sequentially.

### r2d2 and threepio as general workers

Both agents are haiku-tier, parallelizable, and open to any agent in the system:
- **r2d2** — general-purpose TECHNICAL worker: grep/search, file transforms, prototyping, scoped edits, read-only investigation.
- **threepio** — general-purpose NON-TECHNICAL worker: docs, comms, PR descriptions, release notes, email drafts, Notion syncs.

Any agent (jarvis, nat, friday, sam, specialists) may spawn N instances of either in parallel for independent subtasks. Include full context in each spawn — subprocesses share no session memory.

## 11. Memory feedback loop (2026-07-12)

Closes retrieval -> usefulness loop; three legs:

1. **Injection log** — `hooks/memory-router.js` appends every task-aware injection to
   `~/agent-memory/nexus/injection-log.jsonl` (`{ts, sessionKey, promptHash, nodes:[{id, brain, brainDir}]}`).
2. **Stop-hook scorer** — `hooks/injection-feedback-hook.js` (registered as a Stop hook) joins the
   session's injection records to the finished transcript. A node counts as *used* only if its id
   appears in assistant text or tool inputs (user turns excluded — the injected hint echo doesn't
   count). Outcomes append to `~/agent-memory/nexus/injection-feedback.jsonl`; used nodes are
   reinforced by appending to the brain's `visits.log` — the same channel `graph-query --record-access`
   writes, folded by `memory-reconsolidate.js` — so useful memories rise and unused injections decay.
3. **Retrieval eval harness** — `tools/memory-eval.js` builds a fixture brain and asserts recall@1/@3
   on canned queries; pinned in CI via `tools/memory-eval.test.js`. `node tools/memory-eval.js --report`
   summarizes the usefulness rate from injection-feedback.jsonl per brain.

## 12. Unified event bus (2026-07-13)

Durable file-backed event queue at `~/agent-memory/nexus/events/` (`tools/event-bus.js`) plus a
stateless dispatcher (`tools/event-dispatcher.js`). Async triggers that previously fired side
effects directly — and silently lost them on a skipped spawn or crashed process — now publish a
small JSON event instead; the dispatcher drains the queue with retries + exponential backoff
(1/2/4 min), dead-letters events that exhaust `maxAttempts` (default 3) and writes an alert
record to `alerts.jsonl`.

- Layout: `queue/` (pending, atomic tmp+rename), `processing/` (atomic claim via rename —
  concurrent-drain safe), `done.jsonl`, `dead-letter.jsonl`, `alerts.jsonl`. Stale claims
  (>15 min) auto-recover on next drain.
- Handlers: `run-tool` (path-confined to `tools/`), `spawn-agent` (`claude --bg`), `noop`.
- Producers wired: `webhook-server.js` queues `spawn-agent` when the concurrency cap rejects
  a spawn (dedupe skips stay dropped by design).
- Drain: `AgentSystem-EventDispatcherDrain` scheduled task, every 5 min
  (`tools/setup-scheduled-tasks.ps1`).
- CLI: `node tools/event-bus.js [stats|list|dead|requeue-dead|publish --type=... --json=...]`,
  `node tools/event-dispatcher.js --drain [--max=N]`.
- Tests: `tools/event-bus.test.js` (10), `tools/event-dispatcher.test.js` (7). Test roots via
  `AGENT_EVENT_ROOT` or explicit root param.

## 13. Routine compliance telemetry (2026-07-13)

"enforce: hard" agent-rule routines are injected text, not mechanical gates (#119) — nothing
measured whether sessions actually followed them. `hooks/routine-compliance-hook.js` (Stop hook,
registered via `tools/deploy-hooks.js`) replays the session's Bash/PowerShell commands from the
transcript and checks the mechanically-checkable routines:

- **fix-pr-until-green** — `gh pr create` must be followed by a `pr-guard.js` run
- **post-merge-cleanup** — `gh pr merge` must use `--delete-branch` or delete the branch later
- **verify-before-close** — no direct `gh issue close`; `tools/issue-close.js` is the sanctioned path

One record per session appends to `~/agent-memory/nexus/routine-compliance.jsonl`
(`{ ts, sessionId, checked, violations }`). Summarize: `node tools/routine-compliance-report.js
[--days=7] [--json]`. Telemetry only — never blocks Stop, never throws.
