# AgentSystem Full Audit — 2026-07-05

> **ARCHIVED — point-in-time snapshot from 2026-07-05, not current status.** Most of the CRITICAL/
> ROOT CAUSE findings below are now resolved:
> - Self-hosted runner offline (§4 root cause, feature #37-#41) — runner is online; branch
>   protection on `main` now has 4 required status checks including `sam-audit.yml`.
> - `generate-routing-table.js` wipe bug (#1 in the critical list) — the tool now has strict flag
>   validation and refuses an empty write.
> - Cron routines never-run (#3; feature #32) — `weekly-agent-review` and other cron routines are
>   registered in `.github/workflows/scheduled-tasks.yml` and `node tools/routines.js verify`
>   passes.
> - Trust-score pipeline never-run (#6; feature #25) — `weekly-trust-scores` cron now runs.
> - `.agents/memory/*.md` review templates (feature #11) — intentionally dead; superseded by the
>   graph-brain memory system (#117), not a bug.
>
> Not independently re-verified during this pass: the Mission Control webhook server status
> (§5), session-cost double-counting suspicion, and the dead/unwired memory tools list
> (memory-embed.js etc.) — treat those specific items as unconfirmed either way. Kept for
> historical record of what a full audit looked like and as a template for future ones; do not
> use it to judge current system health.

Post PR #153 merge. Four parallel auditors: CI/Mission Control, Agents/Orchestration, Hooks/Routines, Memory. Statuses: **FUNCTIONAL / PARTIAL / BROKEN / NEVER-RUN / DEAD**.

---

## Executive Overview

AgentSystem = multi-agent Claude Code setup: 12-agent roster (Jarvis CEO orchestrator, Friday CTO, Sam CSO hard gate, Nat CBO + 8 specialists/workers), a tiered graph-based memory system (`~/agent-memory/nexus/`), a hook layer (routing, memory injection, guards, capture), a routines engine, GitHub Actions automation, and a mission-control webhook server for phone/remote dispatch.

**Core verdict:** the *local* half of the system (agents, spawning, hooks, memory retrieval/injection, guards) is solid and verified live. The *automation* half (CI dispatch, scheduled maintenance, trust scores, Sam audit workflow, webhooks) is largely dead — almost all of it funnels through a **self-hosted GitHub runner that is offline (0 registered)**. One root cause explains ~70% of the broken features.

**Critical bugs found during audit (new):**
1. `generate-routing-table.js` — unknown flag silently wipes Jarvis routing table (reproduced live, reverted).
2. `routine-dispatch.js` PostToolUse matcher missing `Bash` — auto-resolve-pr-comments routine can never fire.
3. Cron routines have zero Task Scheduler backing — weekly reviews never run.
4. Runner watchdog (`runner-health-check.yml`) itself failing — nothing reliable reports the runner outage.
5. Memory tools without `--help`/`--dry-run` guards executed live during audit (benign, but real footgun).
6. Trust-score pipeline NEVER-RUN — `run-log/` directory doesn't exist; router trust augmentation is a silent no-op.

---

## Component Reports

### 1. Agent Roster & Orchestration — FUNCTIONAL

**What:** 12 agent definitions in `.agents/agents/*.md`, synced to `~/.claude/agents/` (and Antigravity) via `sync-agents.js`. Jarvis routes by domain; Friday owns engineering; Sam hard-gates main merges; Nat owns business.

**How:** In-session spawning via Agent tool (`subagent_type: "Friday"`); background via `claude --bg --agent friday -p "..."`; monitoring via `claude agents --json`. Routing hints injected by UserPromptSubmit hook from `config/routing.yml`.

**Benefits:** Clean separation of authority; parallel swarm capability verified live; hard security gate on merges; sync tooling tested (31/31 tests, Claude 12 + Antigravity 12, no sync.log errors).

**Issues:**
- **CRITICAL:** `tools/generate-routing-table.js` has zero arg validation. Unknown flag (e.g. `--check`) is consumed as config path, `loadRoutingRules` returns `[]`, and it unconditionally writes an EMPTY routing table into jarvis.md — wipes all 7 rules. Reproduced live by auditor; reverted.
- `clarification-needed` agent non-conforming: different schema, missing from `VALID_AGENTS` + `MODELS` map.
- Wanda escalates to Jarvis, not Friday (asymmetry vs other specialists).
- Pym/Leo declare MCP servers that are dead pending #119.
- Copilot CLI support is ASPIRATIONAL — no code exists; `CLI-MEMORY-SYNC-VERIFICATION.md` fully stale.
- Inbox (`agent-message.js`) PARTIAL: Sam.md live and current; Friday/Jarvis each one stale message; `archive/` never used; reading depends on voluntary convention.
- `.agents/memory/*.md` all deprecated (#117 banner) — dead by design, still in repo.
- `sync-agents.js` has a dead never-invoked `warn()` [ERROR] path; no rollback on partial sync failure.

**Improvements:** Fix generate-routing-table (strict flag allowlist, refuse write when `rules.length===0`, add `--check` dry-run). SessionStart hook to surface unread inbox + auto-archive. Delete deprecated memory files and stale Copilot docs. Normalize clarification-needed schema.

---

### 2. Memory Subsystem — FUNCTIONAL core, PARTIAL automation

**What:** Tiered graph memory at `~/agent-memory/nexus/`: personal-brain (126 nodes), per-agent brains (12), per-repo brains (agentsystem: 289 nodes), session/cost/routing/SONA logs. BM25 + edge-weight + Ebbinghaus-decay retrieval.

**How:** `graph-query.js` scores nodes (BM25 + decayed visits + edge weight); `memory-context.js` builds tiered slices (~85 tokens); hooks inject at SessionStart (~100 tokens), SubagentStart (~50–70 tokens, tier-aware: leads get user facts, workers don't), UserPromptSubmit (task-aware retrieval, once per session). Write-back via `brain-remember.js` (with #144 contradiction detection), capture via SessionEnd hook. Maintenance: decay, stale-prune, split, consolidate via `memory-maintenance.js`.

**Benefits:** Token-efficient by design — on-demand retrieval instead of full injection (the #152 goal, achieved). Verified live: 7 real injection markers across projects; retrieval correct; tiering works; deployed hook copies byte-identical to repo.

**Issues:**
- **Trust scores NEVER-RUN:** `run-log/` doesn't exist; `trust-scores.md` permanent empty placeholder; `augmentWithTrust` in memory-router is a silent no-op. Upstream feeder is agent-dispatch.yml (runner-dead).
- **Maintenance staleness:** `.last-maintenance` was 2+ days stale despite `--if-stale` wiring — trigger not firing reliably.
- **SONA data quality:** recent sona-patterns.md entries degenerate (`outcome=unknown | success: no` repeated) — pipeline runs, captures no signal; subagents get fed this noise in "Recent patterns".
- **Missing `--help`/`--dry-run` guards:** `memory-maintenance.js`, `personal-brain-split.js`, `compute-trust-scores.js`, `memory-capture.js` execute for real on unknown flags (bit the auditor; no data loss).
- `graph-query.js --brain-path` inconsistent: full graph.json path throws `p.startsWith is not a function`; agent-brain layout not reachable via documented invocation.
- Contradiction detection (#144): wired, zero real-world hits, three fast-follow gaps from merge notes still open (memory-reflect superseded-filter, toYaml escaping, catch-block observability).
- Dead/unwired tools: `memory-embed.js`, `memory-search.js`, `memory-reinforce.js`, `memory-reconcile.js`, `migrate-memory.js`.
- 5 uncleaned `session-registry.jsonl.bak-*` files; stray `test123` row in live session-registry (audit side effect — clean up).
- `personal-brain-split.js` "N nodes created" misleading on idempotent re-runs.

**Improvements:** Populate `run-log/` (or flag trust path inactive); diagnose maintenance staleness trigger; standardize `--help`/`--dry-run` across all memory tools; fix SONA field extraction; normalize `--brain-path`; wire or delete embed/search tools; canary test for contradiction detection.

---

### 3. Hooks & Routines — mostly FUNCTIONAL, two real bugs

**What:** ~17 hooks in `~/.claude/hooks/` (deploy-hooks.js keeps repo↔installed in sync via sha256); routines engine (`config/routines.yml` → compiled rules, dispatched by `routine-dispatch.js`).

**How:** SessionStart/SubagentStart memory injection; UserPromptSubmit routing + retrieval; PostToolUse guards; Stop/SessionEnd capture + SONA writeback; `guard-git.sh` mechanically blocks dangerous git ops.

**Benefits:** deploy-hooks `--check` reports "in sync" (17 entries) post-deploy. guard-git.sh confirmed live-blocking during audit — the only mechanically hard control, works. Memory hooks all verified live.

**Issues:**
- **BUG:** `routine-dispatch.js` PostToolUse matcher is `Write|Edit|NotebookEdit` only. `gh pr create` detection needs Bash events — auto-resolve-pr-comments routine BROKEN/dead.
- **Cron routines NEVER-RUN:** weekly-agent-review (Sat 09:00), weekly-brain-review (Mon 08:00) have zero Task Scheduler backing; `setup-scheduled-tasks.ps1` registers different names and isn't registered anyway.
- **session-cost anomaly:** $3083/week, 6248 sessions/week (~893/day) — suspect double-count (Stop + SubagentStop both log?) or runaway loop. Don't trust numbers until deduped.
- Nothing enforces hook sync automatically (weekly-hygiene CI job exists but runner offline).
- Hook latency worst case: SessionStart 25s, UserPromptSubmit 25s per prompt; sona-writeback 15s timeout on every Stop.
- Duplicate identity-regex in memory-router.js and routine-dispatch.js — both fire on same prompt.
- Naming trap: `session-close.sh` handles SessionEnd, `session-end.sh` handles Stop.
- `wip-checkpoint.sh` silently auto-stages every Write/Edit — no audit trail.
- agent-rule routines are advisory text only (honest framing in YAML, but worth knowing: only guard-git is hard).

**Improvements:** Add PostToolUse `Bash` matcher entry; register scheduled tasks (or move cron routines to GitHub-hosted runner); dedup session-cost logging; single source for identity regex; stdout note in wip-checkpoint.

---

### 4. CI/CD & GitHub Automation — mostly BROKEN (one root cause)

**What:** Workflows: test.yml, sam-audit.yml, agent-dispatch.yml, scheduled-tasks.yml, runner-health-check.yml, sentry-webhook. Branch protection on main.

**How:** Everything except test.yml + runner-health-check pins `runs-on: self-hosted`.

**Issues:**
- **ROOT CAUSE: self-hosted runner OFFLINE — 0 registered** (`gh api .../actions/runners`). Consequences:
  - sam-audit.yml: 0-second failures on every PR (#131).
  - agent-dispatch.yml: `/merge` `/close` `/agent` comments silent no-op, zero user feedback; also the trust-score run-log feeder.
  - scheduled-tasks.yml: daily standup, weekly brain consolidation, memory decay, trust scores, log rotation/hygiene — NONE running. Silent data-hygiene regression.
  - sentry-webhook: NEVER-RUN.
- **runner-health-check.yml's own last run FAILED** — the watchdog for the runner outage is itself broken.
- **Branch protection main: no required status checks, no required reviews** — only anti-force-push/deletion. Web-UI merge bypasses Sam gate entirely. #147 open, blocked on #131.
- test.yml FUNCTIONAL but ~50% recent fail rate — signal fatigue.
- pr-guard.js requires an APPROVED review from `github-actions[bot]` with "Sam (CSO)" markers — unattainable while runner offline; interim = manual Sam agent audit + PR comment (used for #153).
- workflows-archive: "Agent Memory Consistency Tests" still shows recent runs — reconcile.

**Improvements:** #1 priority for whole system: **bring runner back online or migrate light jobs (hygiene, decay, trust, health-check) to `ubuntu-latest`**. Then fix runner-health-check, enable required checks (#147), and fix sam-audit (#131).

---

### 5. Mission Control / Remote Access — PARTIAL

**What:** `webhook-server.js` (REST on :8765): /panel, /run, /sessions, /cost, /log, /github. Phone access via claude.ai Code tab (works) or webhook panel.

**Issues:**
- Server not running on this host (port 8765 silent); systemd unit targets Linux/WSL, no Windows service.
- GitHub repo webhooks: NONE configured — /github endpoint dead from GitHub side.
- `HOST=0.0.0.0` default risky; ACAO `*` broad; legacy /run path bypasses SessionRegistry caps.
- OpenTofu DO droplet spec NOT FOUND in repo despite commit message claim.
- Code itself mature; recent hardening solid. Sam noted IPv4-only CIDR allowlist (fails closed — acceptable), x-forwarded-for rate-limit key fallback.

**Improvements:** Windows service (nssm/Task Scheduler) or accept claude.ai-only remote; configure GitHub webhook or delete /github; retire legacy /run; commit or drop droplet spec.

---

## Full Feature Matrix

| # | Feature | Status |
|---|---------|--------|
| 1 | Agent roster (12 agents, definitions) | FUNCTIONAL |
| 2 | sync-agents.js (Claude + Antigravity) | FUNCTIONAL |
| 3 | Copilot CLI sync | DEAD (aspirational, no code) |
| 4 | In-session Agent tool spawning | FUNCTIONAL (verified live) |
| 5 | `claude --bg` background agents + fleet monitoring | FUNCTIONAL (verified live) |
| 6 | Jarvis routing hints (routing.yml + memory-router) | FUNCTIONAL (advisory by design) |
| 7 | generate-routing-table.js | BROKEN (arg-validation wipe bug) |
| 8 | Routing telemetry (routing-log.jsonl + routing-report) | FUNCTIONAL |
| 9 | Agent inbox (agent-message.js) | PARTIAL (voluntary reads, archive unused) |
| 10 | decision-log.js | FUNCTIONAL |
| 11 | .agents/memory/*.md review templates | DEAD (deprecated #117) |
| 12 | Personal brain (126 nodes) + graph-query BM25 | FUNCTIONAL (brain-path bug) |
| 13 | Repo brains (agentsystem 289 nodes) | FUNCTIONAL |
| 14 | Per-agent brains (12) | FUNCTIONAL (hard to query via documented CLI) |
| 15 | memory-context.js tiering (--core/--subagent/--keywords) | FUNCTIONAL |
| 16 | SessionStart memory injection | FUNCTIONAL |
| 17 | SubagentStart tiered injection (#120) | FUNCTIONAL |
| 18 | UserPromptSubmit task-aware retrieval | FUNCTIONAL |
| 19 | brain-remember.js write-back | FUNCTIONAL (write path unverified) |
| 20 | Contradiction detection / supersession (#144) | PARTIAL (0 real hits, fast-follows open) |
| 21 | memory-capture / classify / onboard (SessionEnd sweep) | PARTIAL |
| 22 | memory-decay.js | FUNCTIONAL (tool) / NEVER-RUN (schedule) |
| 23 | memory-stale.js | FUNCTIONAL |
| 24 | memory-maintenance.js | FUNCTIONAL tool, unreliable trigger (2+ day gap) |
| 25 | Trust scores (compute-trust-scores + augmentWithTrust) | NEVER-RUN (no run-log data) |
| 26 | SONA pattern logging | PARTIAL (writes degenerate "unknown" entries) |
| 27 | memory-embed / memory-search / reinforce / reconcile / migrate | DEAD/UNWIRED |
| 28 | deploy-hooks.js sync + --check | FUNCTIONAL (no auto-enforcement) |
| 29 | guard-git.sh hard block | FUNCTIONAL (only hard control; verified) |
| 30 | Routines engine (agent-rule advisories) | FUNCTIONAL (advisory) |
| 31 | auto-resolve-pr-comments routine | BROKEN (missing Bash matcher) |
| 32 | Cron routines (weekly reviews) | NEVER-RUN (no scheduler) |
| 33 | wip-checkpoint auto-stage | FUNCTIONAL (silent, no audit trail) |
| 34 | Session naming + registry | FUNCTIONAL (stray test row; .bak churn) |
| 35 | session-cost.js tracking | PARTIAL (numbers suspect, likely double-count) |
| 36 | test.yml CI | FUNCTIONAL (~50% fail rate) |
| 37 | sam-audit.yml Sam gate | BROKEN (#131 + runner offline) |
| 38 | agent-dispatch.yml (/agent /merge /close) | BROKEN (runner offline, silent no-op) |
| 39 | scheduled-tasks.yml (standup/decay/trust/hygiene) | NEVER-RUN (runner offline) |
| 40 | runner-health-check.yml watchdog | BROKEN (own runs failing) |
| 41 | Branch protection main | PARTIAL (no required checks/reviews; #147) |
| 42 | pr-guard.js merge gate | FUNCTIONAL locally (Sam-check unattainable via CI) |
| 43 | issue-close.js verify-before-close | FUNCTIONAL |
| 44 | webhook-server.js remote API | PARTIAL (code good, not running on host) |
| 45 | GitHub webhook integration (/github) | NEVER-RUN (no webhook configured) |
| 46 | Phone via claude.ai Code tab | FUNCTIONAL |
| 47 | OpenTofu DO droplet spec | DEAD (not in repo) |
| 48 | sentry-webhook workflow | NEVER-RUN |
| 49 | bootstrap-repo.js onboarding | FUNCTIONAL |
| 50 | Cost auto-logging (Stop hook) | FUNCTIONAL (feeds suspect #35) |

**Tally:** ~27 FUNCTIONAL · 8 PARTIAL · 5 BROKEN · 5 NEVER-RUN · 5 DEAD.

---

## Priority Fix List

1. **Runner** — restore self-hosted runner OR migrate light jobs (hygiene, decay, trust, health-check, standup) to `ubuntu-latest`. Unblocks #131, #147, trust scores, scheduled maintenance, dispatch. Single biggest lever.
2. **generate-routing-table.js wipe bug** — strict flags, refuse empty write, `--check` mode. Data-loss class.
3. **routine-dispatch Bash matcher** — one-line settings fix, revives auto-resolve-pr-comments.
4. **Register scheduled tasks** (or fold into #1) — cron routines + memory maintenance currently never run.
5. **session-cost dedup** — verify Stop/SubagentStop double-logging before trusting spend numbers.
6. **`--help`/`--dry-run` guards** on mutating memory tools.
7. **SONA extraction fix** — stop writing "unknown" noise into subagent context.
8. **Cleanup:** stray `test123` registry row, `.bak-*` churn, dead tools (embed/search/reinforce/reconcile/migrate), deprecated `.agents/memory/*.md`, stale Copilot doc.
9. **Branch protection (#147)** once runner back: required checks + required review.
