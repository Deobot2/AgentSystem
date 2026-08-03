# Agent Invocation Guide

**Last Updated:** 2026-05-21  
**Owner:** Threepio (Docs)  
**Linked from:** HANDOFF.md, README.md

Command syntax, latency expectations, invocation patterns, and troubleshooting for each agent across Claude Code and Gemini CLIs.

---

## Related: Mission Control

For **remote spawning** of new sessions (vs. attaching to running sessions), see [mission-control.md](mission-control.md). Mission Control enables dispatching Claude Code or Antigravity CLI sessions from a phone/browser without SSH, with repo picker, fleet management, and cost tracking. It complements this guide (which focuses on direct invocation via CLI) and remote control (which drives already-running sessions).

---

## Quick Reference

| Agent | Model | Role | Claude Code | Gemini |
|---|---|---|---|---|
| Jarvis | claude-opus-4-8 | CEO / Default | `claude --agent jarvis` | `gemini --agent jarvis` |
| Friday | claude-sonnet-4-6 | CTO | `claude --agent friday` | `gemini --agent friday` |
| Sam | claude-sonnet-4-6 | CSO / Security | `claude --agent sam` | `gemini --agent sam` |
| Nat | claude-sonnet-4-6 | CBO | `claude --agent nat` | `gemini --agent nat` |
| Ultron | claude-haiku-4-5 | Backend | `claude --agent ultron` | `gemini --agent ultron` |
| Astra | claude-haiku-4-5 | Frontend | `claude --agent astra` | `gemini --agent astra` |
| Pym | claude-haiku-4-5 | Database | `claude --agent pym` | `gemini --agent pym` |
| Leo | claude-haiku-4-5 | DevOps | `claude --agent leo` | `gemini --agent leo` |
| Wanda | claude-sonnet-4-6 | Design | `claude --agent wanda` | `gemini --agent wanda` |
| Threepio | claude-sonnet-4-6 | Docs | `claude --agent threepio` | `gemini --agent threepio` |
| r2d2 | claude-haiku-4-5 | Fallback | `claude --agent r2d2` | `gemini --agent r2d2` |

---

## Latency Expectations by Model

| Model | Typical p50 Response | Notes |
|---|---|---|
| claude-opus-4-8 | 8–15s first token | Highest quality; used for Jarvis (CEO) |
| claude-sonnet-4-6 | 3–6s first token | Balance of quality and speed |
| claude-haiku-4-5 | 1–3s first token | Fastest; used for domain-specialist agents |

---

## Per-Agent Invocation Guide

---

### Jarvis (CEO / Default)

**Model:** claude-opus-4-8  
**Claude Code:**
```bash
# Default — loads automatically when no agent specified
claude

# Explicit invocation
claude --agent jarvis

# With flags
claude --agent jarvis --skip-mcp          # Skip MCP tools (faster startup)
claude --agent jarvis --agenda-only       # Weekly agenda only, no deep work
claude --agent jarvis --focus=repo-name   # Focus on a specific repo
claude --agent jarvis --weekly-review     # Trigger weekly review ritual
```

**Gemini:**
```bash
gemini --agent jarvis
```


**Best-case invocation:**
```
claude --agent jarvis --weekly-review
```
Triggers the 8-step startup checklist: reviews memory, scans PRs/issues, checks calendar, synthesizes blockers.

**Clarification pattern:**
```
If Jarvis asks for clarification, provide: project context, urgency level, and expected output format.
```

**Escalation pattern:**
```
Jarvis is the final escalation point. Escalate from any other agent using:
"@jarvis — [agent] is blocked on [issue]. [what is needed]"
```

---

### Friday (CTO)

**Model:** claude-sonnet-4-6  
**Claude Code:**
```bash
claude --agent friday
claude --agent friday --review-pr                   # PR review mode
claude --agent friday --pressure-test=auth-flow     # Pressure-test a scenario
claude --agent friday --arch-review=repo-name       # Architecture review
```

**Gemini:**
```bash
gemini --agent friday
```


**Best-case invocation:**
```
claude --agent friday --arch-review=AgentSystem
```

**Escalation pattern:**
```
Friday escalates to Jarvis for unresolved conflicts:
"@jarvis — Friday needs CEO decision on [X]."
```

---

### Sam (CSO / Security Gate)

**Model:** claude-sonnet-4-6  
**Note: Sam is a hard gate. All main merges require Sam's approval.**

**Claude Code:**
```bash
claude --agent sam
claude --agent sam --pre-merge-audit              # Pre-merge security review
claude --agent sam --compliance-check=SOC2        # Compliance check
claude --agent sam --vendor-review=vendor-name    # Vendor security review
```

**Gemini:**
```bash
gemini --agent sam --pre-merge-audit
```


**Best-case invocation:**
```
claude --agent sam --pre-merge-audit
# Sam reads the PR diff and provides approval or blocking comment.
```

**Override:** Never bypassed without Jarvis written approval in the PR.

---

### Nat (CBO)

**Model:** claude-sonnet-4-6

**Claude Code:**
```bash
claude --agent nat
claude --agent nat --market-analysis=segment-name
claude --agent nat --revenue-forecast=4
claude --agent nat --customer-health
```

**Gemini:**
```bash
gemini --agent nat --customer-health
```


---

### Ultron (Backend Dev)

**Model:** claude-haiku-4-5  

**Claude Code:**
```bash
claude --agent ultron
claude --agent ultron --api-review
claude --agent ultron --deploy-check
claude --agent ultron --service-audit
```

**Gemini:**
```bash
gemini --agent ultron --api-review
```


**Escalation:** Conflicts → `@friday`

---

### Astra (Frontend Dev)

**Model:** claude-haiku-4-5

**Claude Code:**
```bash
claude --agent astra
claude --agent astra --component-review
claude --agent astra --e2e-test
claude --agent astra --perf-audit
```

**Gemini:**
```bash
gemini --agent astra --component-review
```


**Escalation:** Design questions → `@wanda`. Conflicts → `@friday`

---

### Pym (Database)

**Model:** claude-haiku-4-5

**Claude Code:**
```bash
claude --agent pym
claude --agent pym --schema-review
claude --agent pym --migration-test
claude --agent pym --perf-check
```

**Gemini:**
```bash
gemini --agent pym --schema-review
```


**Escalation:** Conflicts → `@friday`

---

### Leo (DevOps)

**Model:** claude-haiku-4-5

**Claude Code:**
```bash
claude --agent leo
claude --agent leo --ci-review
claude --agent leo --infra-audit
claude --agent leo --deploy-test
```

**Gemini:**
```bash
gemini --agent leo --ci-review
```


**Escalation:** Conflicts → `@friday`

---

### Wanda (Design)

**Model:** claude-sonnet-4-6

**Claude Code:**
```bash
claude --agent wanda
claude --agent wanda --design-review=ComponentName
claude --agent wanda --system-audit
claude --agent wanda --ux-feedback
```

**Gemini:**
```bash
gemini --agent wanda --design-review=Button
```


**Escalation:** Technical issues → `@friday`

---

### Threepio (Docs)

**Model:** claude-sonnet-4-6

**Claude Code:**
```bash
claude --agent threepio
claude --agent threepio --pr-description
claude --agent threepio --changelog
claude --agent threepio --handoff
claude --agent threepio --release-notes
```

**Gemini:**
```bash
gemini --agent threepio --pr-description
```


---

## Troubleshooting

### Agent Timeout

**Symptom:** No response within expected latency window (3x normal p50).

**Steps:**
1. Re-invoke the agent — transient issues are common.
2. If second attempt fails, check agent file validity: confirm `---` frontmatter and non-empty body.
3. Try without flags: `claude --agent [name]`
4. Escalate via `@friday` or `@jarvis` depending on the agent.

---

### Auth Failure

**Symptom:** `Error: unauthorized` or `agent not found`.

**Claude Code:**
1. Run `claude --version` — confirm CLI is current.
2. Re-authenticate: `claude auth login`
3. Confirm agent file exists: `%USERPROFILE%\.claude\agents\[name].md`

**Gemini:**
1. Run `gemini --version`
2. Re-authenticate: `gemini auth login`
3. Confirm agent file exists: `%USERPROFILE%\.gemini\antigravity-cli\agent\[name].json`

---

### Memory Not Found

**Symptom:** Agent reports no memory or starts without prior context.

**Steps:**
1. Live memory is the graph brain under `~/agent-memory/nexus/` — query via `node tools/graph/graph-query.js`
2. Run sync: `node tools/sync-agents.js`
3. `.agents/memory/*.md` is deprecated (#117). The archived copies under `docs/archive/agents-memory/`
   were removed from HEAD in #213 — historical scratch notes, read by no tool, in a public repo.
   Still present in git history; purge tracked in #214.

---

### Agent Loads But Ignores Domain Routing

**Symptom:** Jarvis not routing to the expected domain agent.

**Steps:**
1. Check `AGENTS.md` routing rules — is the task description triggering the right pattern?
2. Use explicit `--agent [name]` to bypass routing and invoke directly.
3. If routing rule is wrong, update `AGENTS.md` routing section and sync.
