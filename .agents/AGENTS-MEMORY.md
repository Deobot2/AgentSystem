# Agent Memory Index

**Last Updated:** 2026-07-12
**Maintained by:** Jarvis (reviewed as part of the startup ritual)

Quick-lookup table of each agent's domain, escalation path, and where its memory lives.

## Memory Architecture (current)

Per-agent markdown memory files (`.agents/memory/*.md`) are retired. Agent memory now lives in the shared graph brains under `~/agent-memory/nexus/`:

- **Personal brain** (`personal-brain/`) — user preferences and user-level facts
- **Agent brain** (`agent-brain/`) — per-agent decisions, blockers, learnings
- **Repo brains** (per-repo `nexus/` dirs) — code and architecture facts
- **SONA episodic patterns** — `~/agent-memory/nexus/sona-patterns.md`

Commands:
- Write: `node ~/dev/AgentSystem/tools/brain-remember.js --fact="..." [--tier=agent --target=<name> | --tier=repo --target=<slug>]`
- Query: `node ~/dev/AgentSystem/tools/graph/graph-query.js <brain> <keywords>`

Relevant memory is auto-injected at session start via SessionStart/SubagentStart hooks — agents do not need to manually load memory files.

---

## Index Table

| Agent | Domain | Escalation | Memory |
|---|---|---|---|
| Jarvis | CEO/orchestrator. Cross-domain coordination, 9-step startup checklist. | — | agent brain (`jarvis`) |
| Friday | CTO. Engineering architecture and delivery. Hard gate: Sam must approve all main merges. | Jarvis | agent brain (`friday`) |
| Sam | CSO. Security audit gating all main merges. Never bypassed without Jarvis written approval. | Jarvis | agent brain (`sam`) |
| Nat | CBO. Business strategy, revenue, customer health. | Jarvis | agent brain (`nat`) |
| Ultron | Backend API / services / deployment. | Conflicts → Friday; security → Sam | agent brain (`ultron`) |
| Astra | Frontend / components / UX / performance. | Design questions → Wanda; conflicts → Friday | agent brain (`astra`) |
| Pym | Database schema / migrations / queries. | Conflicts → Friday; security → Sam | agent brain (`pym`) |
| Leo | DevOps / CI-CD / infrastructure / observability. | Conflicts → Friday; security → Sam | agent brain (`leo`) |
| Wanda | Design / design system / tokens. | Technical issues → Friday; conflicts → Jarvis | agent brain (`wanda`) |
| Threepio | Docs / README / handoffs / PR descriptions. | Direction conflicts → Friday; announcements → Nat; cross-team comms → Jarvis | agent brain (`threepio`) |
| r2d2 | General technical fallback when no domain matches. | Friday | agent brain (`r2d2`) |

---

## Historical Logs

The pre-2026-06 markdown memory files are deprecated (#117) and gone from HEAD — no tool read
them. Write new facts to the graph brains instead.

**Treat anything committed here as permanently public.** This repo is public, and deleting a file
from HEAD does not remove it: every blob stays readable through normal git history. There is no
after-the-fact fix, so the check happens before the commit — never commit third-party details,
client identifiers, or infrastructure specifics, in docs or in scratch notes.
