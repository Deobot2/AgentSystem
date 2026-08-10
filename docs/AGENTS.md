# Agent System — Complete Reference

**Last Updated:** 2026-08-10  
**Status:** Production-ready architecture with comprehensive governance  
**Single Source of Truth:** This file consolidates all agent definitions, routing rules, domain ownership, and coordination protocols.

---

## Quick Reference

### Default Agent
**Jarvis** loads automatically on session start. Bypass with `--agent=<name>` or say "Be <AgentName>:" in chat.  
See "Bypassing Jarvis" section below for full guidance.

### Agent Roster

Models below are sourced from the `MODELS.claude` map in `tools/sync-agents.js` — the actual
source of truth; `tools/sync-agents.js --check` verifies every installed copy matches it.

| Agent | Role | Model | Domain | Reports To |
|-------|------|-------|--------|-----------|
| **Jarvis** | CEO & Orchestrator | claude-opus-5 | Cross-domain leadership, strategy, hiring, pivots | — |
| **Friday** | CTO | claude-sonnet-5 | Engineering decisions, architecture, code audit | Jarvis |
| **Sam** | CSO | claude-opus-5 | Security policies, compliance, pre-merge audit (hard gate) | Jarvis |
| **Nat** | CBO | claude-sonnet-5 | Business strategy, revenue, GTM, pricing, customer health | Jarvis |
| **Ultron** | Backend Dev | claude-haiku-4-5-20251001 | Backend APIs, services, database deployment | Friday |
| **Astra** | Frontend Dev | claude-haiku-4-5-20251001 | React/Vue components, UX, a11y, performance | Friday |
| **Pym** | Database Dev | claude-haiku-4-5-20251001 | Schema design, migrations, pressure-testing, query optimization | Friday |
| **Leo** | DevOps | claude-haiku-4-5-20251001 | CI/CD, infrastructure, observability, deployments | Friday |
| **Wanda** | Design | claude-haiku-4-5-20251001 | UI design, design systems, component design, tokens | Friday |
| **Threepio** | Comms & Docs | claude-haiku-4-5-20251001 | README, CHANGELOG, PR descriptions, release notes, announcements | Jarvis |
| **r2d2** | Fallback Dev | claude-haiku-4-5-20251001 | Catch-all for tasks not matching a specialist | — |
| **clarification-needed** | Clarifier | claude-sonnet-5 | Asks clarifying questions when a request is too vague to act on | Jarvis |

---

## Routing Rules

**When user request matches a pattern, dispatch to:**

- **Backend API / Service / Deployment** → Ultron (if conflicts → Friday)
- **Database schema / migrations / queries / pressure-testing** → Pym (if conflicts → Friday)
- **Frontend / Component / React / Vue / UX / Performance** → Astra (if design questions → Wanda, if conflicts → Friday)
- **Design system / UI tokens / Component design / Wireframes** → Wanda (if technical implementation → Astra, if conflicts → Friday)
- **DevOps / CI-CD / Infrastructure / Observability** → Leo (if conflicts → Friday)
- **Security / Compliance / Auth / Vendor PHI review** → Sam (hard gate on all main merges; cannot be overridden)
- **Business strategy / Revenue / Pricing / Customer health** → Nat (if conflicts → Jarvis)
- **Architecture / Tech decisions / Engineering standards review** → Friday (escalates to Jarvis if needed)
- **Docs / README / CHANGELOG / Handoffs / Release notes / PR descriptions** → Threepio
- **Leadership / Orchestration / Cross-domain coordination** → Jarvis
- **Task doesn't fit any specialist** → r2d2 (fallback only; should recommend specialist if applicable)

**Routing logic:** Match most specific pattern first. If ambiguous → Jarvis determines.

---

## Domain Ownership Map

| Domain | Owner | Read Access | Notes |
|--------|-------|-------------|-------|
| Backend APIs / Services | Ultron | All | Pym audits for schema impact |
| Database Schema / Migrations | Pym | Ultron (read), Sam (audit), Friday (review) | All schema changes pressure-tested |
| Frontend Components / UX | Astra | All | Wanda (design review), Friday (performance) |
| Design System / Tokens | Wanda | Astra (implementation), All (reference) | Single source of truth for visual standards |
| DevOps / CI-CD / Infrastructure | Leo | All | Escalate deployment questions to Leo |
| Security Policies / Compliance | Sam | All (audit) | Hard gate on main merges. Cannot be overridden. |
| Architecture / Tech Decisions | Friday | All | Escalates CEO-level decisions to Jarvis |
| Business Strategy / Revenue | Nat | Jarvis (oversight), All (reference) | Quarterly reviews with Jarvis approval |
| GitHub Discussions (Decisions) | Jarvis | All | Cross-domain decisions documented here |
| README / Docs / Handoffs | Threepio | All | Communication hub for all team updates |

---

## Coordination Rules

**All cross-agent work follows these 8 explicit protocols:**

1. **Each agent owns their domain.** Do not write to another agent's memory or folder without flagging it.
2. **Cross-domain work requires coordination.** If task spans agents (e.g., backend API + frontend), coordinate via Jarvis. Note in both agent memories + HANDOFF.md.
3. **GitHub Issues are the task model.** All work tracked as Issues. Agent memories link to Issues, not vice-versa.
4. **Memory stays in the agent brain.** Session logs, decisions, learnings belong in
   `~/agent-memory/nexus/agent-brain/<agent>/nodes/`, written via `node tools/brain-remember.js`.
   The flat-file paths `.agents/memory/{agent}.md` and `agents-memory/{agent}.md` described in an
   earlier version of this doc were deprecated by #117 and no longer exist — see "Memory
   Structure" below.
5. **HANDOFF.md tracks blockers.** If Agent A waits on Agent B, note it in HANDOFF.md "What's blocked" section. Jarvis monitors on startup.
6. **Escalation is transparent.** When escalating to Jarvis, state why in GitHub Discussion or agent memory.
7. **Bypass is documented.** Users can invoke agents directly to skip Jarvis. Agent respects the direct request.
8. **Sync script is authoritative.** Run `node tools/sync-agents.js` after any agent definition change.

**Exception:** Ephemeral thinking (single session) doesn't need coordination. Only decisions/blockers that outlive the session.

---

## Startup Procedure

**Source of truth:** `.agents/agents/jarvis.md` → "Startup (9 steps, run in parallel where
marked)". This section summarizes it; if the two disagree, `jarvis.md` wins. It is skipped
entirely for trivial/identity/lookup queries — Jarvis answers those inline via
`memory-context.js` / `graph-query.js` rather than loading MCPs or spawning agents.

1. Load memory context (user + project + recent, one call): `node tools/memory-context.js`
2. Check inbox: `node tools/agent-message.js --list --to=Jarvis` — act on high-priority messages
3. Query agent brain for decision log, blockers, last outcomes:
   `node tools/graph/graph-query.js agent-brain jarvis blockers decisions`
4. **[parallel]** Three GitHub queries: last-48h merged PRs, open stale issues (>2 weeks),
   unresolved Discussions
5. Check for new preference nodes: `node tools/graph/graph-query.js personal-brain --hot-stub
   --brain-path=~/agent-memory/nexus/personal-brain`
6. Scan `HANDOFF.md` "blocked" section + agent review due dates in
   `~/agent-memory/nexus/agent-brain/`
7. **[parallel]** Probe email (last 24h) + calendar (next 7 days) via MCP
8. Identify blockers + assess risks + decisions needed
9. Brief the user with agenda + decision queue, then execute — or, if no task is specified,
   enter Autonomous Mode ("do work") automatically

---

## Bypassing Jarvis

**If you have a specific, well-scoped task and know which agent should handle it, bypass Jarvis:**

### CLI Invocation
```bash
claude @ultron      # Invoke Ultron directly
claude @friday       # Load Friday without Jarvis
```
Per-session override: `claude --agent friday` (see `~/.claude/CLAUDE.md` → "Agent Roster").

### In Conversation
```
Be Ultron: review this API design
```

### When to Bypass
- ✅ Specific, well-scoped task (e.g., "fix this bug")
- ✅ Know which agent should handle it
- ✅ No cross-domain coordination needed

### When NOT to Bypass
- ❌ Task is ambiguous or spans domains
- ❌ Need work prioritized against current goals
- ❌ Need cross-team coordination

---

## Memory Structure

`.agents/memory/{agent}.md` (with a `TEMPLATE.md`) was the original per-agent memory format.
It was deprecated in #117 and the directory no longer exists in this repo — the flat-file
sections it described (Session Log, Key Decisions, Operational Patterns, Cadence, Learnings)
are not written or read by any current tool. If you land here from an old link or a cached
context, that structure is history, not practice.

**Current mechanism:** each agent's memory lives as per-agent nodes under
`~/agent-memory/nexus/agent-brain/<agent>/nodes/`, outside this repo (shared across hosts —
see CLAUDE.md → Memory). Agents write to it via `node tools/brain-remember.js --fact="..."`
(optionally `--section=` or `--tier=repo|agent --target=...`), which dedups and re-splits
facts rather than appending raw log lines. Reading back goes through the graph, not a
flat file: `node tools/graph/graph-query.js agentsystem <keywords>`, or the MCP tools
`memory_read_agent`, `memory_context`, and `memory_reflect` in `tools/mcp-server.js`.

---

## Escalation Paths

**Decision authority matrix:**

| Decision Type | Owner | Escalates To |
|---------------|-------|--------------|
| Technical (code, arch) | Friday | Jarvis (if CEO-level) |
| Security policy | Sam | Jarvis (if compliance/vendor) |
| Business strategy | Nat | Jarvis (if CEO decision needed) |
| Engineering standards | Friday | Sam (if security impact) |
| Hiring / org | Jarvis | Chris (human) if board approval needed |
| Budget / pricing | Nat | Jarvis → Chris (human) if >$100k |
| Major pivot | Jarvis | Chris (human) for final approval |

**Escalation trigger:** When an agent is unsure if they own the decision, flag Jarvis.

---

## Pre-Merge Security Gate (Non-Negotiable)

**Sam (CSO) audits all main merges. Hard gate — cannot be bypassed without Jarvis written approval.**

Sam checklist before approving merge:
- [ ] No credentials/API keys committed
- [ ] No PHI in code or logs
- [ ] Auth flows validated
- [ ] Dependency security checked
- [ ] No SQL injection / XSS / CSRF vectors
- [ ] Data classification respected (public/internal/confidential)

---

## Quarterly Reviews

**Cadence:**
- **Monthly (Security):** First Friday → Sam (2 hrs)
- **Quarterly:**
  - Security: Jan/Apr/Jul/Oct last week → Sam → Jarvis approves
  - Engineering: Feb/May/Aug/Nov last week → Friday → Jarvis approves
  - Business: Mar/Jun/Sep/Dec last week → Nat → Jarvis approves

See `docs/REVIEW-CADENCE.md` and `docs/QUARTERLY-REVIEW.md` for full schedule and framework
(`agents-memory/quarterly-reviews.md` does not exist in this repo). Note the automated
`weekly-agent-review` / `weekly-trust-scores` cron jobs in `.github/workflows/scheduled-tasks.yml`
are the current mechanized successor to the manual cadence described there.

---

## Production Readiness Checklist

**System meets 9 requirements:**

- ✅ Default entry point (Jarvis loads automatically)
- ✅ Routing rules (explicit task → agent mapping)
- ✅ Proactive orchestration (Jarvis 9-step startup)
- ✅ Memory structure (per-agent session logs and decisions)
- ✅ Coordination rules (8 explicit protocols)
- ✅ Domain ownership map (clear agent authority)
- ✅ Startup procedures (structured initialization)
- ✅ Bypass mechanism (direct agent invocation)
- ✅ Sync validation (agent definitions sync to CLI configs)

**Status:** ✅ **PRODUCTION-READY** for engineering, cross-domain, and autonomous work.

---

## Sync & Deployment

**Master source of truth:** `.agents/agents/` (this repo)

**Sync process:**
```powershell
node tools/sync-agents.js
```

Generates agent configs for both harnesses this system supports (see `docs/harness-support.md`):
- Claude Code: `%USERPROFILE%\.claude\agents\`
- Antigravity: `ANTI_AGENTS_DIR` (the Antigravity plugin's agents directory — not a "Gemini CLI";
  there is no third CLI)

**Verification after sync:**
- [ ] `node tools/sync-agents.js --check` exits 0 (all 12 agents match source)
- [ ] `claude` loads Jarvis by default
- [ ] `claude @friday` loads Friday
- [ ] Check `.agents/sync.log` for errors

There is no `agents-memory\` directory under `%USERPROFILE%\.claude\` — agent memory lives outside
this repo entirely, at `~/agent-memory/nexus/agent-brain/<agent>/nodes/` (see "Memory Structure"
below).

---

## Questions & Escalations

- **How do I know if my task needs multiple agents?** → Ask Jarvis. If task spans routing rules, it likely does.
- **What if I disagree with an agent's decision?** → Flag Jarvis. Agent mediates conflicts.
- **Can I override the security gate?** → Only Jarvis can approve (written). Sam's gate is non-negotiable.
- **How do I remember what was decided last session?** → Query the agent brain:
  `node tools/graph/graph-query.js agentsystem <keywords>` (or `agent-brain <agent> <keywords>`);
  `.agents/memory/{agent}.md` was deprecated by #117 and no longer exists.
- **What if an agent is overloaded?** → Flag in HANDOFF.md "What's blocked." Jarvis prioritizes on startup.

---

## References

- **CLAUDE.md** — CLI configuration and default agent setup
- **HANDOFF.md (repo root)** — Current blockers, what shipped, watch-outs
- **`~/agent-memory/nexus/agent-brain/jarvis/nodes/`** — CEO decision log, critical risks,
  escalations (queried via `graph-query.js`, not read as a flat file)
- **`~/agent-memory/nexus/agent-brain/<agent>/nodes/`** — Per-agent session logs, decisions,
  learnings
- **.agents/agents/{agent}.md** — Agent definitions (master source of truth)
- **docs/PRODUCTION-READINESS.md** — Historical assessment of system readiness (dated 2026-05-25;
  see its header banner for what's since changed)

`agents-memory/jarvis.md`, `agents-memory/{agent}.md`, and `.agents/memory/TEMPLATE.md` referenced
in older versions of this doc do not exist in this repo — see "Memory Structure" above.
