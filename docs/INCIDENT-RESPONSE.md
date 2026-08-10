# Incident Response Procedures

**Last Updated:** 2026-05-21  
**Owner:** Friday (CTO) + Jarvis (CEO)

Step-by-step runbooks for common agent system failures. Each procedure includes detection signal, diagnostic steps, recovery steps, and escalation criteria.

---

## 1. Agent Timeout / No Response

**Detection:** Agent has not produced output or updated memory within its SLA window (see ESCALATION-CONVENTIONS.md).

**Diagnostic steps:**
1. Check `~/agent-memory/nexus/agent-brain/<agent>/nodes/` — is there a recent session log entry?
2. Check GitHub Issues for the current task — has the agent posted an update?
3. Check if the agent file is valid: `cat .agents/agents/<agent>.md` — confirm frontmatter and body present.

**Recovery steps:**
1. Re-invoke the agent with the same task + `--resume` context.
2. If second attempt fails within 15 min, escalate to Friday (CTO) via @friday mention.
3. Friday either retakes the task or re-delegates to a different capable agent.
4. Record the incident via `node tools/graph/graph-weight.js` or a note under
   `~/agent-memory/nexus/agent-brain/<agent>/nodes/` (see root `CLAUDE.md` → "Memory").

**Escalation criteria:** Two consecutive timeouts → Friday decides whether to suspend agent and delegate domain to another.

**Owner:** Jarvis (initial detection, step 3+5 of startup checklist)

---

## 2. Memory Sync Failure

**Detection:**
- `.agents/sync.log` shows error or no entry within expected window.
- File timestamps in `%USERPROFILE%\.claude\agents\` are older than last commit.
- `node tools/sync-agents.js --check` exits 1 (drift between `.agents/agents/` and installed
  copies). There is no CI workflow for this — it runs on demand and in the daily
  `enforcement-drift-check` job.

**Diagnostic steps:**
1. Read last entries in `.agents/sync.log` — identify which step failed.
2. Verify `tools/sync-agents.js` is present.
3. Run `Test-Path "$env:USERPROFILE\.claude\agents\"` — confirm target directories exist.
4. Check if any agent `.md` file has invalid frontmatter (missing `---` block or empty `name:`).

**Recovery steps:**
1. Fix the invalid agent file if that is the root cause.
2. Re-run: `node tools/sync-agents.js`
3. Verify output: check timestamps of `%USERPROFILE%\.claude\agents\*.md` match current time.
4. If sync still fails, manually copy `.agents/agents/<agent>.md` to `%USERPROFILE%\.claude\agents\`.
5. Log the incident under `~/agent-memory/nexus/agent-brain/friday/nodes/`.

**Escalation criteria:** Sync fails 3 consecutive times → Leo (DevOps) investigates script; Friday reviews agent file validity.

**Owner:** Leo (DevOps) for script failures; Friday for agent file validity.

---

## 3. Decision Conflict Between Agents

**Detection:** Two agents have made incompatible decisions (e.g., Ultron chose tech stack A, Friday chose tech stack B for same component).

**Diagnostic steps:**
1. Identify both decisions in respective memory files (`~/agent-memory/nexus/agent-brain/<agent>/nodes/`).
2. Determine which decision was made first (timestamp in memory log).
3. Determine which agent has authority over the domain per `AGENTS.md` routing rules.

**Recovery steps:**
1. The higher-authority agent's decision takes precedence (routing rules in AGENTS.md define precedence).
2. If domain is ambiguous, Friday (CTO) makes the tie-breaking call.
3. Document the resolution and reason in both agents' memory files.
4. If conflict has already propagated to code/PRs, Friday creates a reconciliation PR.
5. Update HANDOFF.md if work is now in-flight.

**Escalation criteria:** If Friday cannot resolve or the conflict involves strategy (not just tech), escalate to Jarvis.

**Owner:** Friday (CTO) for technical conflicts; Jarvis (CEO) for strategy conflicts.

---

## 4. Security Gate Override (Sam Blocks a Merge)

**Detection:** Sam has added a blocking review comment on a PR and is not approving.

**Diagnostic steps:**
1. Read Sam's blocking comment — identify the specific security concern.
2. Determine if the concern is a true security risk or a process/scope disagreement.
3. Check if the issue can be resolved within 8h (Sam's SLA).

**Recovery steps:**
1. Address Sam's concern in code — fix the identified security issue.
2. Update the PR and re-request Sam's review.
3. If Sam is unavailable beyond 8h SLA: Friday documents justification in writing in the PR.
4. Friday escalates to Jarvis with written justification.
5. Jarvis makes the final call — override requires Jarvis written approval in the PR.
6. **Never merge to main without Sam approval OR explicit Jarvis written override.** No exceptions.

**Escalation criteria:** >8h block without resolution → Friday escalates to Jarvis with documented justification.

**Owner:** Sam (security gate owner); Friday (escalation path); Jarvis (override authority only).

---

## 5. CI/CD Pipeline Failure

**Detection:**
- GitHub Actions workflow shows red status on a PR or scheduled run.
- Push to main fails pre-merge checks.

**Diagnostic steps:**
1. Open the failing workflow run in GitHub Actions — identify the failing step.
2. Classify failure type:
   - **Transient (network/timeout):** Retry once.
   - **Test failure:** A test is failing — identify which test and why.
   - **Lint/format failure:** Code style issue — auto-fixable or needs manual fix.
   - **Sync failure:** Agent sync job failed — see procedure #2.
   - **Dependency failure:** Package install or build tool failed.

**Recovery steps (by type):**

*Transient:*
1. Re-run the workflow from GitHub Actions UI.
2. If it fails again, escalate to Leo.

*Test failure:*
1. Leo reads the test output — identify the failing test name and assertion.
2. Route to domain agent: Ultron (backend test), Astra (frontend test), Pym (DB test).
3. Agent fixes the root cause and pushes a commit to the branch.
4. Re-run CI.

*Lint/format:*
1. There is no `npm run lint` script in this repo (`package.json` only defines `test`,
   `test:graph`, `test:memory`, `test:mission-control`, `mcp`). If a workflow step names a specific
   linter (e.g. `tools/workflow-lint.js`, which only lints GitHub Actions workflow files), run that
   tool directly and fix what it reports.
2. Commit the fix.

*Sync failure:*
1. Follow Memory Sync Failure procedure (#2 above).

*Dependency failure:*
1. Check if package was removed or version incompatible.
2. Leo updates dependency manifest — Friday reviews if architectural impact.

**Escalation criteria:** Pipeline red for >2h on a main-bound PR → Friday reviews and unblocks.

**Owner:** Leo (DevOps) for all CI/CD failures. Routes to domain agents for test fixes.

---

## Escalation Paths Summary

| Incident Type | First Responder | Escalation (if unresolved) | Final Authority |
|---|---|---|---|
| Agent timeout | Jarvis | Friday | Friday |
| Memory sync failure | Leo | Friday | Friday |
| Decision conflict | Friday | Jarvis | Jarvis |
| Security gate block | Sam | Friday → Jarvis | Jarvis |
| CI/CD failure | Leo | Friday | Friday |

---

## Links

- Escalation conventions and SLAs: [ESCALATION-CONVENTIONS.md](ESCALATION-CONVENTIONS.md)
- Agent dependency map and failure cascades: [AGENT-DEPENDENCY-MAP.md](AGENT-DEPENDENCY-MAP.md)
- Current blockers: [HANDOFF.md](HANDOFF.md)
