# Agent Decision Review Cadence

**Last Updated:** 2026-08-10  
**Owner:** Jarvis (CEO)

Structured review schedule for agent decisions, system health, and performance trends.

Note: the **weekly** and **monthly** reviews below were designed as manual, human-triggered
process (Friday posts a report by hand). They have since been superseded by the automated
`weekly-agent-review` cron job (`config/routines.yml`, Sat 09:00 UTC, registered in
`.github/workflows/scheduled-tasks.yml`), which runs headless Jarvis and writes to
`node tools/decision-log.js`, not a memory file. The manual cadence described here is kept for the
**Quarterly** review, which is still a human-run process — see `QUARTERLY-REVIEW.md`.

---

## Review Schedule

### Weekly — Friday Metrics Pulse (Every Friday, async)
**Who:** Friday (CTO)  
**Duration:** 30 min  
**Output:** Historically a report posted to `.agents/memory/friday.md`; that path was deprecated by
#117. This manual review is superseded by the automated `weekly-agent-review` cron (see note above)
— treat this section as historical unless you are deliberately reviving the manual version.
**Covers:**
- Decision volume, escalation %, reversal %
- Execution time p50/p95
- CI health, sync success rate
- Any metric outside target — flag and assign owner

**Calendar:** No meeting; Friday posts report each Friday end-of-week.

---

### Monthly — Friday CTO Review (1st Monday of each month, 2h)
**Who:** Friday (CTO)  
**Duration:** 2h  
**Output:** Historically a summary appended to `.agents/memory/friday.md` (path deprecated by
#117); current memory writes go through `node tools/brain-remember.js` to
`~/agent-memory/nexus/agent-brain/friday/nodes/`. As with the weekly pulse, this manual cadence is
superseded in practice by the automated weekly cron.
**Schedule:** First occurrence: 2026-06-01  
**Covers:**
- Last month's escalations and reversals (review decisions, check patterns)
- Engineering backlog velocity
- Architecture health (debt, scaling concerns)
- Test coverage trends
- Deployment incident rate
- Cross-agent technical coordination review
- Subdomain agent performance (Ultron, Astra, Pym, Leo)

**Success criteria for healthy system:**
- Escalation % < 15%
- Reversal % < 5%
- p50 execution time < 2h
- Zero security incidents
- Sync success rate > 99%

---

### Sam — Every Main Merge (Hard Gate, on-demand)
**Who:** Sam (CSO)  
**Trigger:** Every PR targeting `main`  
**SLA:** 8h from PR open to review  
**Output:** Approval or blocking comment on PR  
**Covers:** Security audit per Sam's domain  
**Override:** Only Jarvis with written justification — never bypassed silently.

---

### Quarterly — System Deep Review (1st week of Jan/Apr/Jul/Oct, 4h)
**Who:** Jarvis (CEO), Friday (CTO), Sam (CSO), Nat (CBO)  
**Duration:** 4h  
**Schedule:** 2026-07-01 (next occurrence after system launch)  
**Output:** Quarterly review findings doc — store via `node tools/brain-remember.js` under the
relevant agent's node directory, or as a decision-log entry via `node tools/decision-log.js`, not a
flat `.agents/memory/` file (deprecated, #117).  
**Covers:** See QUARTERLY-REVIEW.md for full checklist  

---

## Decision Log

Decisions are logged via `node tools/decision-log.js` and via per-agent memory writes
(`node tools/brain-remember.js`) to `~/agent-memory/nexus/agent-brain/<agent>/nodes/`. Query with
`node tools/graph/graph-query.js agentsystem <keywords>`. The flat `.agents/memory/<agent>.md` /
`.agents/AGENTS-MEMORY.md` files referenced in earlier drafts of this doc no longer exist (#117).

---

## Calendar Invites

**Monthly CTO Review:** Recurring first Monday of each month, 2h block.  
Email template for invite:
```
Subject: Monthly CTO Review — [Month YYYY]

Agenda:
1. Last month metrics (escalations, reversals, p50/p95)
2. Architecture health check
3. Test coverage and CI status
4. Next month engineering priorities

Attendees: Friday (CTO)
Output: Monthly summary via node tools/decision-log.js
```

**Quarterly System Review:** See QUARTERLY-REVIEW.md for invite template.

---

## Success Criteria by Role

| Role | "Healthy System" Looks Like |
|---|---|
| Friday (CTO) | Escalation < 15%, no security incidents, p50 < 2h, sync > 99% |
| Sam (CSO) | Zero security incidents post-merge, all main merges reviewed |
| Nat (CBO) | Business decisions made within 24h SLA, no customer-impacting bugs |
| Jarvis (CEO) | All agents active, no agent stale >3 days, metrics trending toward targets |
| Wanda | Design decisions not reversed due to technical oversight |
