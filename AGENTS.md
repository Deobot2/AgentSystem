# Agent System Reference

Comprehensive reference for the agent system. Canonical definitions live in `.agents/agents/`. Agent memory lives in the shared graph brains under `~/agent-memory/nexus/` (see "Memory Structure" below).

For Claude-specific setup, see `CLAUDE.md`. For in-flight blockers, see `HANDOFF.md` (repo root).

---

## Agent Roster

| Agent | Role | Model | Authority |
|-------|------|-------|-----------|
| **Jarvis** | CEO — default entry, cross-agent coordination, escalations | Opus | Autonomous |
| **Friday** | CTO — engineering architecture and delivery | Sonnet | Autonomous (Sam gate for main merges) |
| **Nat** | CBO — strategy and GTM | Sonnet | Autonomous |
| **Sam** | CSO — security, compliance, vendor review | Sonnet | Autonomous + Hard Gate |
| **Wanda** | Design — UX/UI, design system, tokens | Sonnet | Domain |
| **Threepio** | Comms & Docs — README, CHANGELOG, PR descriptions, handoffs | Sonnet | Domain |
| **Ultron** | Backend — APIs, services, deployment | Haiku | Domain |
| **Astra** | Frontend — components, UX, performance | Haiku | Domain |
| **Pym** | Database — schema, migrations, queries | Haiku | Domain |
| **Leo** | DevOps — CI/CD, infrastructure, observability | Haiku | Domain |
| **r2d2** | Fallback — coding tasks that don't fit a specialist | Haiku | Domain |

**Default entry agent:** Jarvis. Override with `--agent=<name>` or see "Bypassing Jarvis" below.

---

## Routing Rules

When a request matches a pattern, dispatch to the listed agent. Match the most specific pattern first. If no pattern matches, Jarvis determines routing.

| Pattern | Primary Agent | Escalation |
|---------|--------------|------------|
| Backend API / Service / Deployment | Ultron | Conflicts → Friday |
| Database schema / migrations / queries | Pym | Conflicts → Friday |
| Frontend / Component / UX / Performance | Astra | Design questions → Wanda; conflicts → Friday |
| Design / Component design / Design system / Tokens | Wanda | Technical issues → Friday; conflicts → Jarvis |
| DevOps / CI-CD / Infrastructure / Observability | Leo | Conflicts → Friday |
| Security / Compliance / Auth / Vendor review | Sam | Hard gate on all main merges |
| Business strategy / Revenue / Pricing / Customer health | Nat | Conflicts → Jarvis |
| Leadership / Orchestration / Cross-domain | Jarvis | — |
| Docs / README / Handoffs / Release notes / PR descriptions | Threepio | Direction conflicts → Friday; announcements → Nat |
| Architecture / Tech decisions / Design review | Friday | Escalates to Jarvis |
| **All engineering tasks** | **Friday (direct — `claude @friday`)** | Workers via peer dispatch |

**Ambiguous cases:**
- "Auth in frontend" → Astra (implementation) + Sam (audit)
- "Database schema + API" → coordinate via Jarvis; Pym owns schema, Ultron owns API layer
- "Design system + frontend component" → Wanda designs, Astra implements

---

## Domain Ownership Map

| Domain | Owner | Others Can Read? | Notes |
|--------|-------|-----------------|-------|
| Backend APIs / Services | Ultron | All | Ultron approves API contracts |
| Database Schema / Migrations | Pym | Ultron (read), Sam (audit) | Pym signs off all schema changes |
| Frontend Components / UX | Astra | All | — |
| Design System / Tokens | Wanda | Astra (implementation) | Wanda owns visual language |
| DevOps / CI-CD / Infrastructure | Leo | All | Leo owns deployment gates |
| Security Policies / Compliance | Sam | All (audit) | Sam is hard gate on main merges |
| Architecture / Tech Decisions | Friday | All | Friday owns ADRs and tech direction |
| Business Strategy / Revenue | Nat | Jarvis | Nat owns GTM and customer health |
| GitHub Discussions (Decisions) | Jarvis | All | Jarvis owns decision record |
| README / Docs / Handoffs | Threepio | All | Threepio owns documentation quality |

**Cross-domain rule:** If a task spans multiple domains (e.g., backend API + frontend), coordinate via Jarvis. Note outcomes in both agents' brain memory and `HANDOFF.md`.

---

## Coordination Rules

1. **Each agent owns their domain.** Don't write to another agent's memory or folders without flagging it.
2. **Cross-domain work is coordinated via Jarvis.** Note in both agents' brain memory and `HANDOFF.md`.
3. **GitHub Issues are the task model.** All work tracked as Issues. Agent memories link to Issues, not vice-versa.
4. **Memory goes to the graph brains.** Durable facts, decisions, and learnings are written via `node tools/brain-remember.js --fact="..." [--tier=agent --target=<name>]` and recalled via `node tools/graph/graph-query.js <brain> <keywords>`.
5. **HANDOFF.md is for blockers.** If Agent A is blocked waiting on Agent B, note it in `HANDOFF.md`. Jarvis monitors this on startup.
6. **Escalation is transparent.** When escalating to Jarvis, state why in GitHub Discussion or agent memory.
7. **Bypass is documented.** Users can invoke agents directly to skip Jarvis. The agent respects the direct request.
8. **Sync script is authoritative.** Run `node tools/sync-agents.js` after any agent definition change.

**Exception:** Ephemeral thinking within a single session doesn't need coordination. Only decisions and blockers that outlive the session require documentation.

---

## Engineering Entry Point

**For all engineering work, go directly to Friday — not Jarvis.**

```bash
claude @friday
```

Friday is the direct entry agent for: code, architecture, debugging, design, deployment, testing, PR review, and any technical task. Jarvis is NOT in the loop for engineering execution.

**Friday's peer dispatch** (no Jarvis approval needed):

| Worker | When |
|--------|------|
| Ultron | Backend APIs, services, deployment |
| Pym | Database schema, migrations, queries |
| Leo | CI/CD, infrastructure, observability |
| Astra | Frontend components, UX, performance |
| Wanda | Design system, tokens, visual specs |
| Threepio | Docs, PR descriptions, README, release notes |
| Sam | Security audit (REQUIRED before every main merge) |

**Inter-agent messaging:**
```bash
# Friday → Sam pre-merge audit (required every main merge)
node tools/agent-message.js --from=Friday --to=Sam \
  --subject="Pre-merge audit: <branch>" \
  --action="Security audit before merge to main" \
  --context="<what changed>" --links="<PR URL>" --priority=high

# Read Friday inbox
node tools/agent-message.js --list --to=Friday

# Friday → worker handoff
node tools/agent-message.js --from=Friday --to=Ultron \
  --subject="<task>" --action="<what to do>" \
  --context="<what Friday decided>" --links="<issue/PR>" --priority=normal
```

**Escalate to Jarvis ONLY for:** cross-domain strategy (business + engineering tradeoff), resource conflicts between agents, budget/timeline requiring CEO input, Sam vs. Friday security disagreement.

---

## Bypassing Jarvis

If you have a specific, well-scoped task and want to skip Jarvis orchestration, invoke the agent directly.

### CLI Methods

- **Claude Code (named agent):** `claude @ultron`
- **In conversation:** "Be Ultron: review this API"
- **With argument hint:** `claude @friday --focus=api-layer`

### When to Bypass

- You have a specific, well-scoped task (e.g., "fix this bug in the auth service")
- You know which agent should handle it
- You don't need cross-domain coordination
- You don't need work prioritized against current goals

### When NOT to Bypass

- Task is ambiguous or spans multiple domains
- You need the current goal/priority context
- You need cross-team coordination or a decision record
- You're unsure which agent owns the task

---

## Memory Structure

Agent memory lives in the shared graph brains under `~/agent-memory/nexus/` (shared across Claude and Antigravity):

- **Personal brain** (`personal-brain/`) — user preferences and user-level facts
- **Agent brain** (`agent-brain/`) — per-agent decisions, blockers, learnings
- **Repo brains** (per-repo `nexus/` dirs) — code and architecture facts

Commands:
- Write a durable fact: `node ~/dev/AgentSystem/tools/brain-remember.js --fact="..." [--tier=agent --target=<name>]`
- Query: `node ~/dev/AgentSystem/tools/graph/graph-query.js <brain> <keywords>`
- Episodic patterns (SONA): append to `~/agent-memory/nexus/sona-patterns.md`

Relevant memory is auto-injected into sessions via SessionStart/SubagentStart hooks. Jarvis persists a session summary on shutdown (step 9 of the startup checklist). The old `.agents/memory/*.md` files are deprecated (#117); the archived copies under
`docs/archive/agents-memory/` were removed from HEAD in #213 — no tool read them, and this repo is
public. They remain reachable in git history; the purge is tracked in #214.

---

## Startup Procedure

Jarvis runs a 9-step startup on every session (skipped for trivial/lookup queries). See `.agents/agents/jarvis.md` for the full definition.

Summary:
1. Load memory context (`node tools/memory-context.js`)
2. Check inbox (`node tools/agent-message.js --list --to=Jarvis`)
3. Query agent brain — decisions, blockers, last outcomes
4. [PARALLEL] GitHub: last-48h PRs, stale issues, unresolved Discussions
5. Check for new preference nodes in the personal brain
6. Scan `HANDOFF.md` blocked section + agent review due dates
7. [PARALLEL] Email (last 24h) + calendar (next 7d)
8. Identify blockers, risks, decisions needed
9. Brief user with agenda + decision queue — then execute

---

## Escalation Paths

```
User
 ├─▶ Friday (engineering entry — claude @friday) ← ALL code/arch/debug/deploy tasks
 │     ├─▶ Ultron ──── backend APIs, services
 │     │     └─▶ Pym ─ database (if API touches schema)
 │     ├─▶ Astra ───── frontend
 │     │     └─▶ Wanda design (if UX questions arise)
 │     ├─▶ Leo ──────── DevOps / CI-CD
 │     ├─▶ Threepio ─── docs and comms
 │     └─▶ Sam ──────── security audit (REQUIRED before every main merge)
 │
 └─▶ Jarvis (cross-domain, strategy, CEO-level orchestration only)
       ├─▶ Friday ─── engineering escalations
       ├─▶ Nat ──────── business strategy, GTM
       └─▶ Sam ──────── security (any agent, any time)
```

**Hard gate:** Sam must review ALL main branch merges. No exceptions. If Friday and Sam disagree on a finding, escalate to Jarvis with documented reasoning from both sides — Jarvis decides. Friday does not override Sam unilaterally.

---

## Source of Truth

| File | Purpose |
|------|---------|
| `.agents/agents/<agent>.md` | Master agent definition |
| `.agents/rules/shared-blocks.md` | Canonical text injected into `<!-- SHARED:... -->` markers at sync time |
| `~/agent-memory/nexus/` | Shared graph-brain memory (personal, agent, repo brains) |
| `tools/sync-agents.js` | Canonical sync — generates user-level Claude + Antigravity copies (all platforms) |
| `CLAUDE.md` | Claude-specific usage, default agent, bypass pattern |
| `HANDOFF.md` | Current-state log for in-flight and blocked work (repo root, written by `tools/generate-handoff.js`) |
| `README.md` | Repo overview and quick start |

---

## Model Policy

| Agent | Claude | Antigravity (Gemini model id) |
|-------|--------|-------------------------------|
| Jarvis | claude-opus-4-8 | gemini-3.1-pro-preview |
| Sam | claude-sonnet-5 | gemini-3.1-pro-preview |
| Friday / Nat | claude-sonnet-5 | gemini-3-flash-preview |
| Ultron / Pym / Leo / Astra / Wanda / Threepio / r2d2 | claude-haiku-4-5-20251001 | gemini-3.1-flash-lite-preview |

Antigravity is a Gemini-family runtime, so it loads `gemini-*` model ids (the `gemini` row of the map below).
Source of truth: the `MODELS` map in `tools/sync-agents.js`. If a mapping changes, edit that map and re-run `node tools/sync-agents.js`.
