# Agent System — Complete Reference

**Last Updated:** 2026-05-21  
**Status:** Production-ready architecture with comprehensive governance  
**Single Source of Truth:** This file consolidates all agent definitions, routing rules, domain ownership, and coordination protocols.

---

## Quick Reference

### Default Agent
**Jarvis** loads automatically on session start. Bypass with `--agent=<name>` or say "Be <AgentName>:" in chat.  
See "Bypassing Jarvis" section below for full guidance.

### Agent Roster

| Agent | Role | Model | Domain | Reports To |
|-------|------|-------|--------|-----------|
| **Jarvis** | CEO & Orchestrator | Opus 4.7 | Cross-domain leadership, strategy, hiring, pivots | — |
| **Friday** | CTO | Sonnet 4.6 | Engineering decisions, architecture, code audit | Jarvis |
| **Sam** | CSO | Sonnet 4.6 | Security policies, compliance, pre-merge audit (hard gate) | Jarvis |
| **Nat** | CBO | Sonnet 4.6 | Business strategy, revenue, GTM, pricing, customer health | Jarvis |
| **Ultron** | Backend Dev | Sonnet 4.6 | Backend APIs, services, database deployment | Friday |
| **Astra** | Frontend Dev | Sonnet 4.6 | React/Vue components, UX, a11y, performance | Friday |
| **Pym** | Database Dev | Sonnet 4.6 | Schema design, migrations, pressure-testing, query optimization | Friday |
| **Leo** | DevOps | Sonnet 4.6 | CI/CD, infrastructure, observability, deployments | Friday |
| **Wanda** | Design | Sonnet 4.6 | UI design, design systems, component design, tokens | Friday |
| **Threepio** | Comms & Docs | Sonnet 4.6 | README, CHANGELOG, PR descriptions, release notes, announcements | Jarvis |
| **r2d2** | Fallback Dev | Haiku 4.5 | Catch-all for tasks not matching a specialist | — |

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
4. **Memory stays in agent file.** Session logs, decisions, learnings belong in `.agents/memory/{agent}.md` or `agents-memory/{agent}.md`.
5. **HANDOFF.md tracks blockers.** If Agent A waits on Agent B, note it in HANDOFF.md "What's blocked" section. Jarvis monitors on startup.
6. **Escalation is transparent.** When escalating to Jarvis, state why in GitHub Discussion or agent memory.
7. **Bypass is documented.** Users can invoke agents directly to skip Jarvis. Agent respects the direct request.
8. **Sync script is authoritative.** Run `node tools/sync-agents.js` after any agent definition change.

**Exception:** Ephemeral thinking (single session) doesn't need coordination. Only decisions/blockers that outlive the session.

---

## Startup Procedure

**Every Jarvis session (16 steps, 4 phases):**

### Phase 1: Read Memory (2 steps)
1. **Read agents-memory/jarvis.md**
   - Decision Log: recent decisions?
   - Critical Risks: any HIGH items overdue?
   - Escalations: any @-mentions awaiting response?

2. **Read agents-memory/{friday,nat,sam}.md**
   - Check Decision Log: recent architecture/business/security decisions?
   - Check Critical Risks: cross-domain risks?

### Phase 2: Scan Multi-Repo State (5 steps)
3. **Query GitHub PRs (last 48h merged)**
   - MCP: GitHub `gh pr list --state merged`
   - Fallback: Read HANDOFF.md "What shipped" section

4. **Scan HANDOFF.md files** across all repos
   - Shipped work, blockers, due dates

5. **Check GitHub Issues (stale + overdue)**
   - Issues >2 weeks without progress

6. **Scan GitHub Discussions** for strategic decisions awaiting

7. **Check Obsidian vault** or personal notes (if available)

### Phase 3: Probe Edges (4 steps)
8. **Scan Gmail** (last 24h) for escalations

9. **Calendar scan** (next 7 days) for agent reviews due

10. **Product feedback** + customer signal — any new risks?

11. **Agent memory currency check** — last session <3 days old?

### Phase 4: Synthesize + Act (5 steps)
12. **Synthesize cross-project health**
    - Cross-reference HANDOFF.md blocked sections
    - Check Critical Risks for HIGH items >1 week old
    - Spot dependency chains + bottlenecks

13. **Check escalations** — grep agents-memory/ for unflagged @-mentions

14. **Propose 3-5 agenda items** ordered by risk, priority, deadline

15. **Dispatch agents** — create GitHub Issues with owner + success criteria

16. **Auto-schedule reviews** if calendar available

---

## Bypassing Jarvis

**If you have a specific, well-scoped task and know which agent should handle it, bypass Jarvis:**

### CLI Invocation
```bash
claude @ultron --api-review      # Invoke Ultron directly
claude @friday                    # Load Friday without Jarvis
```

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

See `agents-memory/quarterly-reviews.md` for full schedule and framework.

---

## Production Readiness Checklist

**System meets 9 requirements:**

- ✅ Default entry point (Jarvis loads automatically)
- ✅ Routing rules (explicit task → agent mapping)
- ✅ Proactive orchestration (Jarvis 16-step startup)
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

Generates agent configs for:
- Claude Code: `%USERPROFILE%\.claude\agents\`
- Gemini: `%USERPROFILE%\.gemini\agents\`

**Verification after sync:**
- [ ] `claude` loads Jarvis by default
- [ ] `claude @friday` loads Friday
- [ ] Check `.agents/sync.log` for errors
- [ ] Verify memory files exist in `%USERPROFILE%\.claude\agents-memory\`

---

## Questions & Escalations

- **How do I know if my task needs multiple agents?** → Ask Jarvis. If task spans routing rules, it likely does.
- **What if I disagree with an agent's decision?** → Flag Jarvis. Agent mediates conflicts.
- **Can I override the security gate?** → Only Jarvis can approve (written). Sam's gate is non-negotiable.
- **How do I remember what was decided last session?** → Read `.agents/memory/{agent}.md` session logs.
- **What if an agent is overloaded?** → Flag in HANDOFF.md "What's blocked." Jarvis prioritizes on startup.

---

## References

- **CLAUDE.md** — CLI configuration and default agent setup
- **HANDOFF.md (repo root)** — Current blockers, what shipped, watch-outs
- **agents-memory/jarvis.md** — CEO decision log, critical risks, escalations
- **agents-memory/{agent}.md** — Per-agent session logs, decisions, learnings
- **.agents/agents/{agent}.md** — Agent definitions (master source of truth)
- **.agents/memory/TEMPLATE.md** — Memory file template
- **docs/PRODUCTION-READINESS.md** — Assessment of system readiness
