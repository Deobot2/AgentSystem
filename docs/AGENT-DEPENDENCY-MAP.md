# Agent Dependency Map

**Last Updated:** 2026-05-21  
**Owner:** Friday (CTO)

Documents which agents call which, data flow, failure propagation, retry behavior, and SLAs.

---

## Dependency Diagram

```mermaid
graph TD
    User([User / External Trigger])
    Jarvis[Jarvis - CEO / Orchestrator]
    Friday[Friday - CTO]
    Sam[Sam - CSO / Security Gate]
    Nat[Nat - CBO]
    Ultron[Ultron - Backend]
    Astra[Astra - Frontend]
    Pym[Pym - Database]
    Leo[Leo - DevOps / CI-CD]
    Wanda[Wanda - Design]
    Threepio[Threepio - Docs]
    MainBranch[(main branch)]

    User -->|all sessions| Jarvis
    Jarvis -->|backend/API/service| Ultron
    Jarvis -->|DB schema/migrations| Pym
    Jarvis -->|frontend/UX| Astra
    Jarvis -->|design system| Wanda
    Jarvis -->|devops/infra| Leo
    Jarvis -->|security/compliance| Sam
    Jarvis -->|business strategy| Nat
    Jarvis -->|docs/handoffs| Threepio
    Jarvis -->|architecture/tech decisions| Friday

    Ultron -->|conflict| Friday
    Pym -->|conflict| Friday
    Astra -->|design question| Wanda
    Astra -->|conflict| Friday
    Wanda -->|technical issue| Friday
    Leo -->|conflict| Friday
    Nat -->|conflict| Jarvis
    Friday -->|escalation| Jarvis

    Friday -->|pre-merge security audit| Sam
    Sam -->|gate passed| MainBranch
    Sam -.->|blocked - no override| Friday
    Friday -.->|override request with justification| Jarvis
```

---

## Call Chain Examples

### Feature development (typical path)
```
User → Jarvis → Ultron (backend) → Friday (architecture conflict) → Sam (pre-merge) → main
                → Pym (DB schema) ─────────────────────────────────────────────────────┘
```

### UI feature with design review
```
User → Jarvis → Astra (frontend) → Wanda (design question) → Astra (implementation)
                                 → Friday (if technical conflict)
              → Sam (pre-merge) → main
```

### Infrastructure change
```
User → Jarvis → Leo (devops/CI-CD) → Friday (if architecture impact)
              → Sam (pre-merge) → main
```

### Security incident
```
Detect → Sam (owns it) → Jarvis (escalation if >30min blocker)
       → Friday (remediation design) → Sam (verification) → main
```

---

## Failure Mode Analysis

**ASPIRATIONAL — not implemented.** The table and retry conventions below describe a proposed
retry/SLA/timeout automation layer. No code in this repo enforces these timeouts, retry counts, or
escalation triggers; there is no scheduler watching "PR not opened >2h" or "no response >24h"
conditions. The only mechanically enforced items in the whole system are Sam's pre-merge gate
(`sam-audit.yml`, a required check on `main`) and `guard-git.sh` (hard-blocks dangerous git ops).
Everything else here is a documented convention agents are expected to follow voluntarily, not a
working system. Kept as a design reference for anyone who wants to build this; do not read it as
current behavior.

| Agent | Failure Mode | Detection Signal | Who Retries | Timeout | Override / Recovery |
|---|---|---|---|---|---|
| Jarvis | Startup fails / no response | No session log update in >3h | Self-retry once | 30 min | Escalate to Nathan directly |
| Sam | Security audit blocked / unavailable | PR sits without approval >8h | None — Sam owns gate | 8h SLA | Friday documents justification → Jarvis written approval |
| Friday | Architecture decision stalled | GitHub issue no update >4h | Self-retry once | 4h SLA | Escalate to Jarvis |
| Ultron | Backend task stalled | PR not opened >2h after start | Friday retries once | 2h | Friday takes over, re-delegates |
| Pym | Migration fails | CI test failure | Friday retries + review | 1h | Friday reviews schema, re-runs |
| Astra | Frontend build fails | CI failure on PR | Astra retries once | 1h | Friday reviews, may delegate to Ultron |
| Leo | CI/CD pipeline failure | Build status red | Leo retries up to 2x | 15 min | Friday reviews infra config |
| Wanda | Design review stalled | Astra waiting >1h | Astra proceeds with best judgment | 1h | Friday unblocks |
| Nat | Strategy decision stalled | No response >24h | Jarvis retries | 24h | Jarvis decides |
| Threepio | Docs incomplete | PR review comment | Threepio retries | 30 min | Domain expert fills gaps |
| Memory sync | Sync lag between CLIs | File timestamp check fails | Leo retries sync job | 5 min | Manual `node tools/sync-agents.js` |

---

## Retry Conventions (proposed, unimplemented)

- **Max retries:** 2 for all automated agents; 1 for human-gate agents (Sam, Jarvis)
- **Backoff:** 5 min wait between retries for network-related failures
- **Idempotency:** All mutations (file writes, memory updates) must be idempotent — retrying a completed operation must produce same result without duplication
- **Postcondition check:** After each retry, verify the expected state change occurred before proceeding

---

## Data Flow

```
User input → Jarvis (routing decision)
           → Agent (domain work → produces artifact: code, doc, decision)
           → Sam (security check if main-bound)
           → main branch (via PR + CI)
           → ~/agent-memory/nexus/agent-brain/<agent>/nodes/ (memory written via
             tools/brain-remember.js — flat .agents/memory/<agent>.md files were deprecated by #117)
           → HANDOFF.md (in-flight/blockers updated if needed)
```
