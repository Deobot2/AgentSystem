# GitHub Issues for Agent System Enhancement

**Status: HISTORICAL / ARCHIVED.** This was the proposed issue backlog from the ADR-001 review.
Its *intent* was implemented, but not via the concrete files this doc describes — do not create
these issues or follow their "Work" steps literally today. What actually landed:

- AD-01/02/03/05/06/08/10 (default agent, startup procedure, routing rules, domain ownership map,
  bypass mechanism, coordination rules, consolidated docs) → all live today as sections in
  `docs/AGENTS.md`: "Routing Rules", "Domain Ownership Map", "Coordination Rules", "Startup
  Procedure", "Bypassing Jarvis", "Memory Structure", "Escalation Paths".
- AD-04's memory template intent → superseded by the graph-brain layout at
  `~/agent-memory/nexus/agent-brain/<agent>/nodes/` (see root `CLAUDE.md` → "Memory"). There is no
  `.agents/memory/` directory in this repo (deprecated per #117) and no `MEMORY.md` template file.
- AD-07 (Threepio & r2d2 definitions) → done: both are fully specified in `.agents/agents/threepio.md`
  and `.agents/agents/r2d2.md`.
- AD-09's sync-script update → done, but the tool named in this doc never existed under that name.
  The real, current sync tool is `node tools/sync-agents.js` (with `--check` for drift detection),
  not `sync_agents_from_repo.ps1`.

The per-issue bodies below are kept for historical reference only; several reference paths that
never existed in this repo (`.agents/memory/<agent>.md`, `agents-memory/jarvis.md`,
`sync_agents_from_repo.ps1`) — see the corrections inline.

---

## AD-01: Mark Jarvis as default entry agent
**Label:** `system/agent-architecture`, `documentation`, `enhancement`
**Body:**
```
**From:** ADR-001 Agent System Architecture Review

## Context
Current system has Jarvis defined as CEO orchestrator but no explicit default entry point in CLAUDE.md. Unclear which agent loads on startup if user doesn't specify.

## Work
1. Update CLAUDE.md to mark Jarvis as `default_agent: jarvis`
2. Add note in AGENTS.md: "Jarvis is the default entry point. Override with `--agent=<name>` or invoking agent by name directly."
3. Update Jarvis agent file comment: "Jarvis is the default entry agent for all sessions."

## Acceptance Criteria
- [ ] CLAUDE.md explicitly sets default_agent
- [ ] AGENTS.md documents default and bypass mechanism
- [ ] Agent system documentation updated
- [ ] Sync script verifies default in generated CLI configs
```

---

## AD-02: Design Jarvis startup procedure
**Label:** `system/agent-architecture`, `enhancement`
**Correction:** `agents-memory/jarvis.md` (step 1 below) never existed. The real memory location
is `~/agent-memory/nexus/agent-brain/jarvis/nodes/`.
**Body:**
```
**From:** ADR-001 Agent System Architecture Review

## Context
Current system has no structured startup procedure. Compare to crhis_agents/toni.md which has 16-step startup with parallel queries.

## Work
Design Jarvis startup checklist:
1. Read agents-memory/jarvis.md (session log, blockers, last outcomes)
2. Run parallel GitHub queries:
   - Last 48h merged PRs (all repos)
   - Open stale issues (>2 weeks)
   - Unresolved Discussions
3. Scan .agents/memory/ for stale agents (no session log >3 days)
4. Check HANDOFF.md for blocked work
5. Probe calendar (next 7 days, agent cadences due)
6. Assess risks, blockers, decisions needed
7. Synthesize: what changed, what's blocked, what needs decision
8. Brief user with agenda + decision queue

## Acceptance Criteria
- [ ] Jarvis behavior updated with startup checklist
- [ ] Parallel query pattern documented (avoid sequential slowness)
- [ ] 8-step procedure added to agent file
- [ ] Example startup session log in agents-memory/jarvis.md
```

---

## AD-03: Define inter-agent routing rules
**Label:** `system/agent-architecture`, `enhancement`
**Body:**
```
**From:** ADR-001 Agent System Architecture Review

## Context
No explicit routing mechanism. No way for Jarvis (or user) to programmatically decide which agent should handle a task.

## Work
Create AGENTS.md "Routing Rules" section:

\`\`\`
## Routing Rules

When user request matches pattern, dispatch to:

- **Backend API / Service / Database / Deployment**: Ultron (if conflicts → Friday)
- **Database schema / migrations / queries**: Pym (if conflicts → Friday)  
- **Frontend / Component / UX / Performance**: Astra (if design questions → Wanda, if conflicts → Friday)
- **Design / Component design / Design system**: Wanda (if technical issues → Friday, if conflicts → Jarvis)
- **DevOps / CI-CD / Infrastructure / Observability**: Leo (if conflicts → Friday)
- **Security / Compliance / Auth / Vendor review**: Sam (hard gate on main merges)
- **Business strategy / Revenue / Pricing / Customer health**: Nat (if conflicts → Jarvis)
- **Leadership / Orchestration / Cross-domain**: Jarvis
- **Docs / README / Handoffs / Release notes / PR descriptions**: Threepio
- **Architecture / Tech decisions / Design review**: Friday (escalates to Jarvis)

Routing logic: match most specific pattern first. If no match → Jarvis determines.
\`\`\`

## Acceptance Criteria
- [ ] AGENTS.md includes routing rules
- [ ] Jarvis updated to reference routing rules in startup
- [ ] Ambiguous cases documented (e.g., "auth in frontend" → Astra + Sam)
```

---

## AD-04: Create memory structure template
**Label:** `system/agent-architecture`, `documentation`
**Correction:** `.agents/memory/` never existed as a directory in this repo and no `MEMORY.md`
template was ever added there. Memory structure landed instead as the graph-brain layout under
`~/agent-memory/nexus/agent-brain/<agent>/nodes/`, documented in root `CLAUDE.md` → "Memory".
**Body:**
```
**From:** ADR-001 Agent System Architecture Review

## Context
Memory files exist (.agents/memory/friday.md, jarvis.md, nat.md, sam.md) but no structure. Agents don't know what to record.

## Work
Create MEMORY.md template in .agents/memory/:

\`\`\`markdown
# {Agent} Memory

## Session Log
- **[DATE HH:MM]**: [What happened, decisions made, blockers surfaced, learnings]
- Format: one line per session = concise summary of outcomes

## Operational Patterns
- How does this agent think?
- What are their decision rules?
- What signals trigger escalation?
- Example: "Ultron always asks: is this TDD? Is validation at boundaries?"

## Key Decisions
- Decision: [What was decided]
- When: [Date]
- Context: [Why]
- Impact: [What changed]

## Cadence
- Next review due: [DATE]
- Checklist: [If recurring, what to check]
- Example: "Friday reviews architecture every Tuesday. Checks: any pending design docs? Any unresolved tech decisions?"

## Learnings
- [What this agent learned that surprised them or will change future decisions]
\`\`\`

## Acceptance Criteria
- [ ] MEMORY.md template created
- [ ] Added to .agents/memory/TEMPLATE.md
- [ ] All agent memory files updated to follow structure
- [ ] Jarvis enforces memory updates on shutdown
```

---

## AD-05: Document domain ownership map
**Label:** `system/agent-architecture`, `documentation`
**Body:**
```
**From:** ADR-001 Agent System Architecture Review

## Context
Agents have domain authority described but no explicit folder/system ownership map like crhis_agents/.

## Work
Add to AGENTS.md:

\`\`\`markdown
## Domain Ownership Map

| Domain | Owner | Others Can Read? |
|--------|-------|-----------------|
| Backend APIs / Services | Ultron | All |
| Database Schema / Migrations | Pym | Ultron (read), Sam (audit) |
| Frontend Components / UX | Astra | All |
| Design System / Tokens | Wanda | Astra (implementation) |
| DevOps / CI-CD / Infrastructure | Leo | All |
| Security Policies / Compliance | Sam | All (audit) |
| Architecture / Tech Decisions | Friday | All |
| Business Strategy / Revenue | Nat | Jarvis |
| GitHub Discussions (Decisions) | Jarvis | All |
| README / Docs / Handoffs | Threepio | All |

**Rule:** If task spans multiple domains (e.g., "Backend API + frontend"), coordinate via Jarvis.
\`\`\`

## Acceptance Criteria
- [ ] AGENTS.md includes domain ownership map
- [ ] Clearly states who owns what
- [ ] Clarifies read access (audit vs. deep changes)
```

---

## AD-06: Implement bypass mechanism
**Label:** `system/agent-architecture`, `documentation`
**Body:**
```
**From:** ADR-001 Agent System Architecture Review

## Context
No documented way to skip Jarvis orchestration. Users must manually avoid default agent.

## Work
Document in CLAUDE.md and AGENTS.md:

\`\`\`markdown
## Bypassing Jarvis

If you have a specific task and want to skip Jarvis orchestration, invoke the agent directly:

### CLI Methods
- **Claude Code**: \`claude @ultron --api-review\`
- **In conversation**: "Be Ultron: review this API"
- **Direct dispatch**: Message Ultron directly with task

### When to Bypass
- You have a specific, well-scoped task (e.g., "fix this bug")
- You know which agent should handle it
- You don't need cross-domain coordination

### When NOT to Bypass
- Task is ambiguous or spans domains
- You need work prioritized against current goals
- You need cross-team coordination
\`\`\`

## Acceptance Criteria
- [ ] CLAUDE.md documents bypass pattern
- [ ] AGENTS.md clarifies when to bypass
- [ ] Sync script respects agent-specific invocation
```

---

## AD-07: Complete Threepio & r2d2 definitions
**Label:** `system/agent-architecture`, `enhancement`
**Body:**
```
**From:** ADR-001 Agent System Architecture Review

## Context
Threepio & r2d2 are underspecified. Unclear when to use.

## Work

### Threepio (Communications & Documentation)
Update .agents/agents/threepio.md:
\`\`\`yaml
name: Threepio
model: claude-sonnet-4-6
description: Comms & Docs, README, CHANGELOG, HANDOFF, Notion syncs, PR descriptions, release notes, email drafts, docs updates
argument-hint: --pr-description, --changelog, --email-draft, --handoff
behavior: |
  Domain authority: documentation, communications, PR descriptions, release notes, email drafts, handoff docs, README updates, CHANGELOG.
  Standards: clear language, target audience (engineers, users, non-technical), consistent formatting, SEO for public docs.
  Escalation: Conflicts on docs direction → Friday (CTO). Comms on company announcements → Nat (CBO).
\`\`\`

### r2d2 (Fallback Agent)
Update or create .agents/agents/r2d2.md:
\`\`\`yaml
name: r2d2
model: claude-haiku-4-5
description: Catch-all for coding tasks that don't fit a specialist. Use ONLY if no other agent matches.
behavior: |
  This agent is a fallback ONLY. When to use:
  - Task doesn't fit Ultron, Astra, Pym, Leo, or Wanda
  - Prototyping / exploration (before specialist takes over)
  - Cross-agent coordination (like Jarvis would do, but lighter)
  
  Before responding: check routing rules in AGENTS.md. If task matches a specialist, recommend user dispatch to that agent directly.
  
  Don't own this agent — specialize or escalate.
\`\`\`

## Acceptance Criteria
- [ ] Threepio.md updated with full behavior
- [ ] r2d2.md created/updated
- [ ] Both have clear escalation paths
- [ ] Routing rules reflect these agents
```

---

## AD-08: Create AGENTS.md coordination rules
**Label:** `system/agent-architecture`, `documentation`
**Correction:** `.agents/memory/{agent}.md` (rule 4) never existed; memory is
`~/agent-memory/nexus/agent-brain/<agent>/nodes/`. `sync_agents_from_repo.ps1` (rule 8) never
existed; the real sync tool is `node tools/sync-agents.js`. "GitHub Discussion" (rule 6) does not
apply — Discussions are disabled repo-wide; escalation is via GitHub Issue.
**Body:**
```
**From:** ADR-001 Agent System Architecture Review

## Context
No documented protocols for cross-agent work. From crhis_agents/README.md: coordination rules prevent chaos.

## Work
Create AGENTS.md section:

\`\`\`markdown
## Coordination Rules

1. **Each agent owns their domain.** Don't write to another agent's memory or folders without flagging it.
2. **Cross-domain work:** If a task spans agents (e.g., backend API + frontend), coordinate via Jarvis. Note in both agent memories + HANDOFF.md.
3. **GitHub Issues are the task model.** All work tracked as Issues. Agent memories link to Issues, not vice-versa.
4. **Memory stays in agent file.** Session logs, decisions, learnings belong in .agents/memory/{agent}.md.
5. **HANDOFF.md is for blockers.** If Agent A is blocked waiting on Agent B, note it in HANDOFF.md. Jarvis monitors this on startup.
6. **Escalation is transparent.** When escalating to Jarvis, state why in GitHub Discussion or agent memory.
7. **Bypass is documented.** Users can invoke agents directly to skip Jarvis. Agent respects the direct request.
8. **Sync script is authoritative.** Run sync_agents_from_repo.ps1 after any agent definition change.

**Exception:** Ephemeral thinking (single session) doesn't need coordination. Only decisions/blockers that outlive the session.
\`\`\`

## Acceptance Criteria
- [ ] AGENTS.md includes 8 coordination rules
- [ ] Agents understand and follow them
- [ ] HANDOFF.md structure updated to support rule #5
```

---

## AD-09: Update sync script for memory structure
**Label:** `system/agent-architecture`, `tooling`
**Correction:** `sync_agents_from_repo.ps1` never existed. The real, current sync tool is
`node tools/sync-agents.js`, which syncs `.agents/agents/*.md` to `~/.claude/agents/*.md` (Claude
Code) and to a plugin manifest at `~/.gemini/agentsystem-plugin/agents/*.md` (Antigravity) — not
`~/.gemini/agents/*.yaml` as step 1 below describes. `node tools/sync-agents.js --check` is the
drift-detection step.
**Body:**
```
**From:** ADR-001 Agent System Architecture Review

## Context
sync_agents_from_repo.ps1 syncs agent definitions to user CLI configs. Doesn't handle memory files.

## Work
1. Verify sync script correctly:
   - Reads .agents/agents/*.md (agent definitions)
   - Generates ~/.claude/agents/*.md for Claude CLI
   - Generates ~/.gemini/agents/*.yaml for Gemini CLI

2. Update script to:
   - Warn if agent memory file missing (e.g., friday.md not found)
   - Validate agent file has name: field (non-empty slug)
   - Validate agent file has behavior: section
   - Report errors clearly

3. Update CLAUDE.md with post-sync check:
   - Verify agent loads: \`claude @friday\` should work
   - Verify default loads: \`claude\` should start Jarvis

## Acceptance Criteria
- [ ] Sync script handles all CLI formats
- [ ] Memory file validation in place
- [ ] Error reporting clear
- [ ] CLAUDE.md has post-sync checklist
```

---

## AD-10: Comprehensive system documentation update
**Label:** `system/agent-architecture`, `documentation`
**Body:**
```
**From:** ADR-001 Agent System Architecture Review

## Context
Current system docs spread across CLAUDE.md, AGENTS.md, HANDOFF.md, README.md. No single source of truth.

## Work
Consolidate into AGENTS.md:
1. Agent roster (name, role, model, escalations)
2. Routing rules (which agent handles which task)
3. Domain ownership map
4. Coordination rules
5. Bypass mechanism
6. Memory structure (link to MEMORY.md template)
7. Startup procedure (link to Jarvis agent file)
8. Escalation paths (visual diagram)

Update in sequence:
1. Read current .agents/agents/*.md files
2. Read current HANDOFF.md
3. Update AGENTS.md to be comprehensive
4. Remove redundancy from CLAUDE.md (point to AGENTS.md)
5. Update HANDOFF.md for blocked work tracking

## Acceptance Criteria
- [ ] AGENTS.md is comprehensive one-stop reference
- [ ] No redundancy with CLAUDE.md
- [ ] All routing rules documented
- [ ] All coordination rules documented
- [ ] Memory structure clear
- [ ] Escalation paths clear
```

---

## Summary

Total estimated effort: **10-15 hours**

### Implementation sequence:
1. AD-01 (mark Jarvis default) — 30 min
2. AD-04 (memory template) — 1 hour
3. AD-03 (routing rules) — 1.5 hours
4. AD-02 (Jarvis startup) — 2 hours
5. AD-05 (domain map) — 1 hour
6. AD-06 (bypass mechanism) — 1 hour
7. AD-07 (Threepio & general-coding) — 1.5 hours
8. AD-08 (coordination rules) — 1.5 hours
9. AD-09 (sync script) — 2 hours
10. AD-10 (consolidated docs) — 2 hours

**Parallelizable:** AD-03, AD-05, AD-06, AD-07 can be done in parallel after AD-04.

After implementation: **System is production-ready across all dimensions.**
