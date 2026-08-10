# ADR-001: Agent System Architecture Review & Enhancement

**Status:** Adopted and implemented. Option B (below) was built out: Jarvis is the documented
default entry agent (`~/.claude/CLAUDE.md`), routing/coordination rules live in `docs/AGENTS.md`,
memory moved twice — first to `.agents/memory/<agent>.md` per this ADR's AD-04, then superseded by
the per-agent graph brain at `~/agent-memory/nexus/agent-brain/<agent>/nodes/` (#117) — and the
roster grew from 11 agents to the current 12 (`jarvis`, `friday`, `sam`, `nat`, `ultron`, `pym`,
`leo`, `astra`, `wanda`, `threepio`, `r2d2`, `clarification-needed`, per `tools/sync-agents.js`).
The historical analysis below (agent counts, model names, comparison tables) reflects the state on
2026-05-21 and is kept for context, not current fact — see `docs/AGENTS.md` for the live roster and
routing rules.
**Date:** 2026-05-21
**Deciders:** User (system architect), potentially Friday (CTO), Jarvis (CEO)
**Reviewers:** All agents (domain-specific feedback)

---

## Executive Summary

Current `.agents/` system (11 agents, 134 LOC) is **functionally correct but operationally thin**. Compared to `crhis_agents/` (9 agents, ~50KB), it lacks:
- **Proactive orchestration** (no agent drives work like crhis's Toni)
- **Persistent memory** (session logs, domain ownership map, coordination rules)
- **Default entry point** (unclear if Jarvis is default)
- **Explicit routing** (no inter-agent dispatch mechanism)
- **Bypass capability** (no direct-task bypass documented)
- **Startup procedures** (no structured onboarding)

**Verdict:** Current system is **production-ready for well-defined engineering tasks** but **not ready for autonomous cross-domain orchestration** or situations requiring agent initiative.

---

## Context

### Current System Architecture (.agents/)

**Design:** Tech-org structure (CEO + CTO + 9 specialists)

| Agent | Role | Model | Reports To | Status |
|-------|------|-------|------------|--------|
| **Jarvis** | CEO, orchestration | Opus 4.7 | — | Defined, unclear if default |
| **Friday** | CTO, architecture | Sonnet 4.6 | Jarvis | Clear authority, hard gate on main merges |
| **Sam** | CSO, security | Sonnet 4.6 | Jarvis | Hard gate (pre-merge audit required) |
| **Nat** | CBO, business strategy | Sonnet 4.6 | Jarvis | Defined but thin |
| **Leo** | DevOps, CI/CD | Haiku 4.5 | Friday | Escalates to Friday |
| **Pym** | Database, schema | Haiku (implied) | Friday | Escalates to Friday |
| **Ultron** | Backend API | Haiku 4.5 | Friday | TDD, SOLID, escalates to Friday |
| **Astra** | Frontend, components | Haiku 4.5 | Friday | Tests + accessibility, escalates to Friday |
| **Wanda** | Design, UX/UI | Sonnet 4.6 | Jarvis | Design authority, escalates Friday/Jarvis |
| **Threepio** | Comms, docs, PR descriptions | — | — | Minimal definition |
| **r2d2** | Catch-all | — | — | Fallback only |

**Strengths:**
- ✅ Clear escalation chains (Friday → Jarvis for conflicts)
- ✅ Hard gate on security (Sam pre-merge audit)
- ✅ Strong technical standards (TDD, type hints, validation, audit logging)
- ✅ Domain authority well-defined (backend, frontend, design, etc.)
- ✅ Sync mechanism (powershell script → user CLI configs)

**Gaps:**
- ❌ No default entry agent (unclear if user says "run tests" which agent catches it)
- ❌ No proactive agent (Friday reacts to PRs; no one drives work forward)
- ❌ No domain ownership map (no clear "this folder belongs to Agent X")
- ❌ No memory structure (no session logs, decision logs, learnings)
- ❌ No explicit routing rules (no "route backend questions to Ultron")
- ❌ No bypass mechanism (no "ignore Jarvis, dispatch directly to Soren")
- ❌ Threepio & r2d2 underspecified
- ❌ No startup procedure (no equivalent to Toni's 16-step startup)
- ❌ No coordination rules (no "If task spans agents, flag for Chris")
- ❌ Memory files exist (friday.md, jarvis.md, nat.md, sam.md) but structure undefined

### Comparison System (crhis_agents/)

**Design:** Business-org structure (CEO/CoS + 8 domain leads)

| Agent | Role | Personality | Status |
|-------|------|-------------|--------|
| **Toni** | Chief of Staff, orchestrator | Proactive, leader, initiator | **Default agent** |
| **Soren** | Chief Engineer | Hands-on, domain expert | Dispatch target |
| **Scout** | Sales & BD | Prospect-focused | Dispatch target |
| **Belissa** | CSO, compliance | Policy-focused | Dispatch target |
| **Tiffany** | Head of Marketing | Campaign-focused | Dispatch target |
| **Ralph** | Strategy advisor | Analysis-focused | Dispatch target |
| **Michelle** | Finance & expenses | Bookkeeping-focused | Dispatch target |
| **Margaret** | Leadership meeting mgr | Meeting-focused | Dispatch target |
| **Keegan** | CPO, HR/compliance | People-focused | Dispatch target |

**Strengths:**
- ✅ **Default entry agent** (Toni loads on startup via CLAUDE.md)
- ✅ **Proactive orchestrator** (Toni drives 16-step startup, dispatches work, reconciles)
- ✅ **Explicit routing** (Toni dispatches to agents by intent: "Research X" → Scout)
- ✅ **Bypass mechanism** (Chris says "be Soren" to skip Toni)
- ✅ **Rich memory** (session logs per agent, decision logs, learnings, cadence)
- ✅ **Domain ownership map** (Google Drive folders, GitHub boards, agent ownership)
- ✅ **Coordination rules** (documented: "If task spans agents, flag for Chris")
- ✅ **Startup procedures** (16-step Toni startup checklist with parallel queries)
- ✅ **Thick definitions** (~50KB per agent, detailed context, cadences)
- ✅ **Persistent learnings** (Memory section: operational patterns, session logs)

**Gaps vs. Current System:**
- ❌ Business-focused (not ideal for pure engineering codebases)
- ❌ Assumes human (Chris) at top; less autonomy than Jarvis
- ❌ Thin on technical standards (no equivalent to Friday's 11 engineering principles)
- ❌ No hard gate mechanism (Belissa doesn't block like Sam does)

---

## Detailed Comparison by Category

### 1. **Orchestration**

| Dimension | Current (.agents/) | crhis_agents/ | Winner | Gap |
|-----------|-------------------|---------------|--------|-----|
| **Entry point** | Undefined (Jarvis?) | Clear (Toni = default) | crhis | Current: No default agent specified |
| **Proactive work** | None | Toni initiates, dispatches, tracks | crhis | Current: No proactive orchestrator |
| **Routing rules** | Implicit (Friday→Jarvis) | Explicit (Toni→agents) | crhis | Current: No dispatch mechanism |
| **Work tracking** | GitHub issues? Unclear | GitHub Issues + Open Loops | crhis | Current: No unified task model |
| **Escalation** | Friday→Jarvis, then what? | Toni→Humans on stalemate | crhis | Current: No human escalation path |
| **Session continuity** | Memory files exist but undefined | Toni Session Log enforced | crhis | Current: No session log structure |

**Gap:** Current lacks any mechanism for **autonomous work dispatch**. If user says "refactor auth" with no specifics, no agent owns the routing decision.

### 2. **Security & Compliance**

| Dimension | Current (.agents/) | crhis_agents/ | Winner | Gap |
|-----------|-------------------|---------------|--------|-----|
| **Hard gate** | ✅ Sam pre-merge audit | ⚠️ Belissa policy-focused | Current | crhis lacks enforcement |
| **Audit trail** | Required in code | Belissa tracks | Tie | Both strong |
| **PHI discipline** | Explicit in Ultron | Belissa owns it | Tie | Both good |
| **Vendor reviews** | Sam decides | Belissa owns it | Tie | Comparable |
| **Standards** | Type hints, validation, logging | No equiv. standards | Current | crhis lighter on standards |

**Gap:** Current is **stronger** on security enforcement, but crhis is better at **compliance as governance** (SOC-2, HIPAA, policies).

### 3. **Backend Engineering**

| Dimension | Current (.agents/) | crhis_agents/ | Winner | Gap |
|-----------|-------------------|---------------|--------|-----|
| **TDD discipline** | ✅ Required (Ultron) | ⚠️ Soren uses it, not mandatory | Current | Current stronger |
| **SOLID principles** | ✅ Required (Ultron) | ⚠️ Implied, not explicit | Current | Current stronger |
| **API standards** | ✅ 10 REST standards | ⚠️ Implied | Current | Current stronger |
| **Deployment discipline** | ✅ CI/CD only, no manual | ✅ Soren enforces | Tie | Both strong |
| **DB schema** | Pym (separate agent) | Soren (includes it) | Current | Current: cleaner separation |

**Gap:** Current is **more precise** on engineering standards. crhis rolls backend into one agent (Soren).

### 4. **Communication & Coordination**

| Dimension | Current (.agents/) | crhis_agents/ | Winner | Gap |
|-----------|-------------------|---------------|--------|-----|
| **Coordination rules** | None documented | ✅ 8 explicit rules | crhis | Current: no rules |
| **Domain ownership map** | None | ✅ Clear (folders→agents) | crhis | Current: missing |
| **Dispatch mechanism** | None | ✅ Toni dispatches via Issues | crhis | Current: no dispatch model |
| **Cross-domain flag** | None | ✅ "Flag for Chris" | crhis | Current: no escalation model |
| **Memory structure** | Vague (files exist) | ✅ Enforced per agent | crhis | Current: no structure |

**Gap:** Current **lacks governance** around cross-agent work.

### 5. **Default Behavior (Critical)**

| Scenario | Current | crhis_agents/ | Result |
|----------|---------|---------------|--------|
| User says "write tests" | Which agent responds? | Toni (default) → dispatches to Soren | **crhis wins** |
| User has specific task | Unclear | "be Soren" to bypass Toni | **crhis wins** |
| No agent name mentioned | Default? | Toni loads | **crhis wins** |
| Async work dispatch | How? | Toni creates Issues + calendars events | **crhis wins** |

---

## Design Issues Identified

### Issue #1: No Default Entry Agent
**Severity:** High
**Impact:** Ambiguous startup behavior. If user doesn't name an agent, unclear which loads.
**Current State:** Jarvis defined as CEO but not marked as default in CLAUDE.md.
**Fix:** Explicit default in CLAUDE.md + agent system documentation.

### Issue #2: No Proactive Orchestration
**Severity:** High
**Impact:** System reacts to user requests; never initiates work or coordinates.
**Current State:** Friday waits for PRs. Jarvis waits for conflicts.
**Fix:** Implement Jarvis-as-orchestrator (like crhis's Toni) with:
- Startup checklist (git status, pending PRs, blocked issues, etc.)
- Dispatch mechanism (route tasks to specialists)
- Session reconciliation (what changed, what's next)

### Issue #3: No Inter-Agent Routing
**Severity:** High
**Impact:** No way to dispatch work across agents. User must explicitly name agent.
**Current State:** Agents exist but no router.
**Fix:** Router rules:
- "Write backend API" → Ultron
- "Review PR" → Friday (executive) + Sam (security)
- "Debug database" → Pym
- "Design component" → Wanda
- etc.

### Issue #4: No Bypass Mechanism
**Severity:** Medium
**Impact:** User can't override orchestration without losing context.
**Current State:** User could name agent directly, but no documented bypass.
**Fix:** Document bypass pattern: `--agent=ultron` or `claude @ultron` to skip Jarvis.

### Issue #5: Undefined Memory Structure
**Severity:** Medium
**Impact:** Memory files exist but no structure. Unclear what goes where.
**Current State:** `friday.md`, `jarvis.md`, `nat.md`, `sam.md` in `.agents/memory/` but no template.
**Fix:** Define memory structure (like crhis):
- Session Log (what changed, decisions, learnings)
- Operational Patterns (how this agent thinks)
- Key Decisions (decisions made in past sessions)
- Cadence (when does this agent activate)

### Issue #6: No Domain Ownership Map
**Severity:** Medium
**Impact:** Unclear which agent owns which folders/systems.
**Current State:** Agents have domain authority described but no folder ownership map.
**Fix:** Add to CLAUDE.md:
```
Domain Ownership:
- Backend APIs: Ultron
- Frontend components: Astra
- Database schema: Pym
- Design system: Wanda
- Security policies: Sam
- etc.
```

### Issue #7: Threepio & general-coding Underspecified
**Severity:** Low
**Impact:** Ambiguous when to use these fallbacks.
**Current State:** Minimal definitions.
**Fix:** Define clearly:
- **Threepio:** Documentation, PRs, release notes, handoffs ONLY
- **general-coding:** Catch-all when no specialist matches

### Issue #8: No Startup Procedure
**Severity:** Medium
**Impact:** No structured way to initialize agent system per session.
**Current State:** Agents defined but no startup checklist.
**Fix:** Implement Jarvis startup (parallel steps):
1. Read memory (decisions, blockers, last session outcomes)
2. Git status (uncommitted, pending PRs, merge conflicts)
3. GitHub queries (open issues, stale PRs, discussions)
4. Calendar scan (meetings, agent cadences due)
5. Identify blockers, risks, decisions
6. Synthesize: what changed, what's blocked, what needs decision
7. Brief user with agenda + decision queue
8. Execute + append to session log

---

## Options Considered

### Option A: Keep Current System As-Is
**Complexity:** None (no change)
**Cost:** Technical debt accumulates
**Team familiarity:** Already familiar with current structure
**Scalability:** Hits ceiling at ~3 interdependent agents
**Production-readiness:** Suitable for simple, self-contained tasks

**Pros:**
- No refactoring effort
- Already in use
- Clear escalation chains
- Strong security gate

**Cons:**
- No proactive work
- No routing
- No orchestration
- Thin on coordination
- Session continuity unclear
- Doesn't scale to cross-domain work
- User must name agent explicitly

**Verdict:** **Not viable for production codebases with cross-domain work** or teams expecting autonomous agent initialization.

---

### Option B: Enhance Current System (Recommended)
**Complexity:** Medium (add layers, no rewrite)
**Cost:** 8-12 hours (routing rules, memory structure, startup proc, docs)
**Team familiarity:** Builds on existing
**Scalability:** Scales to ~8-10 coordinated agents
**Production-readiness:** **Ready for production after implementation**

**Enhancements:**
1. **Mark Jarvis as default entry agent** (CLAUDE.md + AGENTS.md)
2. **Implement Jarvis as proactive orchestrator** (startup checklist, dispatch logic)
3. **Define inter-agent routing** (rules for which agent owns each task type)
4. **Add memory structure** (session log template, operational patterns, cadences)
5. **Document domain ownership map** (folders→agents)
6. **Define bypass mechanism** (documented pattern to skip Jarvis)
7. **Complete Threepio & general-coding definitions**
8. **Create AGENTS.md coordination rules** (cross-agent protocols)

**Pros:**
- Builds on current foundation
- No rewrite required
- Adds autonomy without losing precision
- Becomes production-ready
- Scales better
- Session continuity maintained

**Cons:**
- Requires work
- Thicker agent definitions (more tokens per session)
- Potential for over-orchestration (Jarvis too proactive)

**Verdict:** **Recommended. Keeps technical strengths while adding orchestration.**

---

### Option C: Adopt crhis_agents Model
**Complexity:** High (full rewrite)
**Cost:** 20+ hours (new agents, roles, processes)
**Team familiarity:** Must relearn system
**Scalability:** Excellent for cross-domain, business-focused teams
**Production-readiness:** Not suitable for pure engineering codebases (too business-focused)

**Changes:**
- Replace 11 tech agents with 8-9 business agents
- Adopt Toni-style orchestration
- Lose Friday's CTO authority
- Lose Sam's hard gate
- Trade engineering rigor for business coordination

**Pros:**
- Proven (works in production at Arbor Genie)
- Excellent orchestration
- Rich memory structure
- Clear domain ownership

**Cons:**
- Loses engineering specificity (Friday's 11 principles gone)
- Loses security gate (Sam pre-merge audit gone)
- Overkill for pure engineering shops
- Requires retraining
- Slower for isolated technical work (more hops through Toni)

**Verdict:** **Not recommended for engineering-focused shops.** Use if you're managing a business org with engineering as one domain.

---

### Option D: Hybrid (Current + crhis Elements)
**Complexity:** Medium-High
**Cost:** 12-16 hours
**Production-readiness:** Excellent

**Approach:** Keep current tech agents + add proactive coordinator + memory structure from crhis.

**Pros:**
- Keeps Friday's engineering authority
- Keeps Sam's security gate
- Adds Toni-style orchestration
- Best of both

**Cons:**
- 20 agents instead of 11 (complex)
- More tokens per session
- Coordination overhead

**Verdict:** **Over-complex. Option B achieves same benefit with simpler design.**

---

## Trade-off Analysis

### Autonomy vs. Precision
**Trade-off:** More autonomous agents (Jarvis proactively dispatching) = less precise routing (risk of wrong agent).
**Resolution:** Implement routing rules + memory from crhis model. Operators (users) stay in control via "--agent" bypass.

### Scale vs. Simplicity
**Trade-off:** More agents = more coordination overhead. Fewer agents = less specialization.
**Resolution:** Current 11 agents is near-optimal. Don't add more; enhance routing instead.

### Session Thickness vs. Tokens
**Trade-off:** Richer agent definitions (like crhis) = more tokens per session.
**Resolution:** Use memory files (not inline) to keep agent defs thin; load memory on-demand.

---

## Consequences

### If Option B is Adopted

**Becomes easier:**
- Users can say "write tests" without naming agent
- Cross-domain work coordinated automatically (Jarvis routes)
- Session continuity (agents know last session's outcomes)
- Scaling to 10-15 agents without losing coordination
- Debugging (clear routing rules)
- Production use (structured init + shutdown)

**Becomes harder:**
- More agent definitions to maintain
- Thicker CLAUDE.md (more context per session)
- Risk of over-routing (Jarvis interfering with specialist decisions)
- More memory management (per-agent session logs)

**What we'll need to revisit:**
- Memory structure (grows over time; need cleanup cadence)
- Routing rules (evolve as agent capabilities change)
- Bypass mechanism (ensure users understand how to override)
- Startup costs (parallel GitHub queries add latency)

---

## Action Items

- [ ] **AD-01:** Mark Jarvis as default entry agent in CLAUDE.md
- [ ] **AD-02:** Design Jarvis startup procedure (parallel checklist, 6-8 steps)
- [ ] **AD-03:** Define inter-agent routing rules (task category → agent mapping)
- [ ] **AD-04:** Create memory structure template (session log, patterns, cadence)
- [ ] **AD-05:** Document domain ownership map in AGENTS.md
- [ ] **AD-06:** Implement bypass mechanism (documented CLI pattern)
- [ ] **AD-07:** Complete Threepio & general-coding definitions
- [ ] **AD-08:** Create AGENTS.md coordination rules (cross-agent protocols)
- [ ] **AD-09:** Update sync_agents_from_repo.ps1 to handle new memory structure
- [ ] **AD-10:** Create GitHub Issues for each action item (tagged `system/agent-architecture`)

---

## Production Readiness Assessment

### Current System
- **Engineering codebase support:** ✅ **Ready** (strong technical gates, escalation chains)
- **Cross-domain orchestration:** ❌ **Not ready** (no routing, no proactive work)
- **Autonomous operation:** ❌ **Not ready** (no startup proc, no memory structure)
- **Scale (10+ agents):** ❌ **Not ready** (no routing bottleneck)

**Verdict:** **Production-ready for well-scoped engineering tasks. Not ready for autonomous cross-domain work.**

### After Option B Implementation
- **Engineering codebase support:** ✅ **Ready**
- **Cross-domain orchestration:** ✅ **Ready**
- **Autonomous operation:** ✅ **Ready**
- **Scale (10+ agents):** ✅ **Ready**

**Verdict:** **Production-ready across all dimensions.**

---

## Decision

**Adopt Option B (Enhance Current System).**

Rationale:
1. Builds on proven foundation (Friday's engineering authority, Sam's security gate)
2. Adds missing orchestration without rewrite
3. Gets to production-ready in ~10 hours of work
4. Maintains engineering precision while adding coordination
5. Scales to 10-15 agents without major refactoring

Next step: Convert action items to GitHub Issues and begin implementation.

**Outcome (added retroactively, 2026-08-10):** All ten action items (AD-01 through AD-10) were
completed. AD-01/AD-02/AD-03/AD-08 live in `docs/AGENTS.md`; AD-04's memory structure was replaced
by the graph-brain memory system (#117) rather than kept as flat `.agents/memory/*.md` files;
AD-06 is documented as `claude --agent <name>` / in-session `Agent({ subagent_type: ... })`; AD-07
(Threepio, r2d2) and AD-09 (sync script, `tools/sync-agents.js`) are both implemented and covered
by `tools/sync-agents.js --check`.
