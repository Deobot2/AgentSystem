# Quarterly Agent System Deep Review

**Last Updated:** 2026-08-10  
**Owner:** Jarvis (CEO)  
**Next Scheduled:** 2026-07-01 (first week of Q3) — check `HANDOFF.md` / decision log for whether
this has since run; the schedule table below has not been reconciled against actual occurrences.

---

## Schedule

| Quarter | Date | Block |
|---|---|---|
| Q3 2026 | 2026-07-01 | 4h |
| Q4 2026 | 2026-10-01 | 4h |
| Q1 2027 | 2027-01-05 | 4h |
| Q2 2027 | 2027-04-01 | 4h |

---

## Participants

| Role | Agent | Attendance |
|---|---|---|
| CEO / Facilitator | Jarvis | Required |
| CTO | Friday | Required |
| CSO | Sam | Required |
| CBO | Nat | Required |
| Design (if design debt items) | Wanda | Optional |

---

## Quarterly Review Checklist

### 1. Decision Quality Audit (30 min)
- [ ] Review all `[ESCALATION]` tags from the quarter — were escalations resolved appropriately?
- [ ] Review all `[REVERSAL]` tags — what caused reversals? Pattern analysis.
- [ ] Check: are domain routing rules (AGENTS.md) producing correct first-routing decisions?
- [ ] Identify any recurring conflict between agents — does routing need refinement?

### 2. Model Fit Review (20 min)
- [ ] Are the assigned models (see `MODELS` map in `tools/sync-agents.js` — currently
      `claude-opus-5` for Jarvis/Sam, `claude-sonnet-5` for Friday/Nat/clarification-needed,
      `claude-haiku-4-5-20251001` for the specialist/worker agents) still appropriate for each
      agent's workload?
- [ ] Any new model capabilities that should be adopted?
- [ ] Any cost/performance tradeoffs worth adjusting?

### 3. Memory System Health (20 min)
- [ ] Are all 12 agents' memory nodes up to date? Check
      `~/agent-memory/nexus/agent-brain/<agent>/nodes/` (the flat `.agents/memory/*.md` layout and
      `.agents/AGENTS-MEMORY.md` index were deprecated by #117 and no longer exist).
- [ ] Any memory corruption or sync failures this quarter? Check `node tools/brain-sync.js --status`.
- [ ] Is agent-definition sync clean? `node tools/sync-agents.js --check` should exit 0.

### 4. Test Coverage Review (15 min)
- [ ] Full suite green? `npm test` (no coverage-percentage tool is currently wired up in this repo —
      there is no `>80%` coverage target being measured; if you want that number, run a coverage
      tool manually and record the baseline here, since none exists yet).
- [ ] Any untested domains or agents?
- [ ] Are the 5 minimum sprint tests being maintained?

### 5. Escalation SLA Compliance (15 min)
- [ ] Were all escalations resolved within defined SLAs (ESCALATION-CONVENTIONS.md)?
- [ ] Any SLA breaches? Root cause?
- [ ] Do SLA targets need adjustment based on actual data?

### 6. Hard Gate Effectiveness (15 min)
- [ ] Were all main merges reviewed by Sam?
- [ ] Any attempted bypasses (with or without Jarvis approval)?
- [ ] Is the security gate adding value — are Sam's blocks catching real issues?

### 7. Agent Performance by Domain (20 min)
- [ ] Execution time p50/p95 per agent — any outliers?
- [ ] Agents with high escalation rates — coaching needed?
- [ ] Any agents underutilized (routing not reaching them)?

### 8. Findings, Recommendations, Action Items (25 min)
- [ ] Document findings using output template below
- [ ] Assign action items with owners and due dates
- [ ] Update HANDOFF.md with next quarterly review date

---

## Output Template

Store via `node tools/brain-remember.js` (or `node tools/decision-log.js`) — not a flat file in
`.agents/memory/`, which was deprecated by #117 and no longer exists.

```markdown
# Quarterly Review — [YYYY Q#]

**Date:** [YYYY-MM-DD]
**Participants:** [list]
**Facilitator:** Jarvis

## Findings

### Decision Quality
[summary]

### Model Fit
[summary]

### Memory System Health
[summary]

### Test Coverage
[summary — current % vs target]

### Escalation SLA Compliance
[summary — # breaches, patterns]

### Hard Gate Effectiveness
[summary]

### Agent Performance
[summary by domain]

## Recommendations
1. [recommendation] — Owner: [agent] — Due: [date]
2. ...

## Action Items
| # | Action | Owner | Due Date | Status |
|---|---|---|---|---|
| 1 | | | | Open |

## Next Quarter Adjustments
[Changes to routing rules, SLAs, models, or process being made for next quarter]

## Next Review Date
[Date of next quarterly review]
```

---

## Calendar Invite Template

```
Subject: Quarterly Agent System Review — [YYYY Q#]

Agenda (4h):
1. Decision quality audit — 30 min
2. Model fit review — 20 min
3. Memory system health — 20 min
4. Test coverage — 15 min
5. Escalation SLA compliance — 15 min
6. Hard gate effectiveness — 15 min
7. Agent performance by domain — 20 min
8. Findings + action items — 25 min
[Break / async wrap-up — remaining time]

Required attendees: Jarvis, Friday, Sam, Nat
Optional: Wanda (if design debt on agenda)

Pre-read: 
- node tools/graph/graph-query.js agentsystem <keywords> (recent decisions)
- docs/METRICS-DASHBOARD.md — NOTE: this describes an unimplemented metrics proposal, not a live
  trend report; there is nothing to pull real numbers from there yet.
- docs/ESCALATION-CONVENTIONS.md
```

---

## Links

- Review cadence overview: [REVIEW-CADENCE.md](REVIEW-CADENCE.md)
- Metrics schema: [METRICS-DASHBOARD.md](METRICS-DASHBOARD.md)
- HANDOFF.md: [HANDOFF.md](HANDOFF.md)
