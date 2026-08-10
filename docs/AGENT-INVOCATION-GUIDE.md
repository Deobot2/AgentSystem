# Agent Invocation Guide

**Last Updated:** 2026-08-10
**Owner:** Threepio (Docs)
**Linked from:** HANDOFF.md, README.md

Command syntax and troubleshooting for each agent across the two supported harnesses: Claude Code
and Antigravity (`agy`). There is no `gemini` CLI in this system — see `docs/harness-support.md`
for the authoritative harness list.

---

## Related: Mission Control

For **remote spawning** of new sessions (vs. attaching to running sessions), see
[mission-control.md](mission-control.md). Mission Control dispatches Claude Code or Antigravity
sessions from a phone/browser without SSH. It complements this guide (direct CLI invocation) and
remote control (driving already-running sessions).

---

## Quick Reference

Model IDs below are the live `MODELS.claude` map in `tools/sync-agents.js`.

| Agent | Model | Role | Claude Code | Antigravity |
|---|---|---|---|---|
| Jarvis | claude-opus-5 | CEO / Default | `claude --agent jarvis` | `agy --agent jarvis` |
| Friday | claude-sonnet-5 | CTO | `claude --agent friday` | `agy --agent friday` |
| Sam | claude-opus-5 | CSO / Security | `claude --agent sam` | `agy --agent sam` |
| Nat | claude-sonnet-5 | CBO | `claude --agent nat` | `agy --agent nat` |
| clarification-needed | claude-sonnet-5 | Clarifies vague requests | `claude --agent clarification-needed` | `agy --agent clarification-needed` |
| Ultron | claude-haiku-4-5-20251001 | Backend | `claude --agent ultron` | `agy --agent ultron` |
| Astra | claude-haiku-4-5-20251001 | Frontend | `claude --agent astra` | `agy --agent astra` |
| Pym | claude-haiku-4-5-20251001 | Database | `claude --agent pym` | `agy --agent pym` |
| Leo | claude-haiku-4-5-20251001 | DevOps | `claude --agent leo` | `agy --agent leo` |
| Wanda | claude-haiku-4-5-20251001 | Design | `claude --agent wanda` | `agy --agent wanda` |
| Threepio | claude-haiku-4-5-20251001 | Docs | `claude --agent threepio` | `agy --agent threepio` |
| r2d2 | claude-haiku-4-5-20251001 | General technical worker | `claude --agent r2d2` | `agy --agent r2d2` |

Sam is opus-tier because it is the hard security gate on `main` merges, not sonnet — see the
model-choice comment above `MODELS` in `tools/sync-agents.js`.

Antigravity uses `gemini-*` model ids (it is a Gemini-family runtime driven through the `agy` CLI,
not a `gemini` CLI) — see `MODELS.gemini` in the same file for the current mapping.

---

## Real `claude` CLI flags relevant to agent invocation

There is no per-agent, per-task flag surface (no `--api-review`, `--pr-description`,
`--arch-review=`, etc.). Verified against `claude --help` on this host:

| Flag | Purpose |
|---|---|
| `--agent <agent>` | Select the agent for this session, overriding the `agent` setting |
| `--bg`, `--background` | Start the session as a background agent and return immediately (manage with `claude agents`) |
| `-c`, `--continue` | Continue the most recent conversation in the current directory |
| `-p`, `--print` | Non-interactive output (print the response and exit) |
| `--bare` | Minimal mode: skips hooks, LSP, plugin sync, CLAUDE.md auto-discovery, etc. |
| `--add-dir <dirs...>` | Grant tool access to additional directories |
| `--dangerously-skip-permissions` | Bypass all permission checks (use with care) |
| `--append-system-prompt <prompt>` | Append to the default system prompt |
| `--settings <file>` | Point at an alternate settings file |

Run `claude --help` for the full, current list — flags change between CLI releases and this table
is not exhaustive. Task-specific behavior (a security audit, a PR review) comes from what you type
in the prompt or from a slash command / skill, not from a dedicated flag.

Background CLI spawn pattern used across this repo (see root `CLAUDE.md`):
```bash
claude --bg --agent <name> -p "<full task context, target audience, source material>"
```

---

## Antigravity (`agy`)

Agents are installed to Antigravity via a plugin manifest, not a per-file agent directory:
`tools/sync-agents.js` writes agent markdown to `~/.gemini/agentsystem-plugin/agents/` and then
runs `agy plugin install <plugin-dir>` (falling back to printing that command if `agy` is not on
PATH). Invoke an agent the same way as Claude Code: `agy --agent <name>`.

Hooks, and everything hook-borne (session auto-rename, continuous brain sync at session
start/end, etc.), do not run under Antigravity — see `docs/harness-support.md` for the full list
of what is and is not supported per harness.

---

## Escalation patterns

Escalation between agents is a plain `@agent` mention in conversation or a PR/issue comment, not a
CLI flag. Examples, matching the roles in `docs/AGENTS.md`:

- Any agent → Jarvis: `@jarvis — [agent] is blocked on [issue]. [what is needed]`
- Friday → Jarvis: `@jarvis — Friday needs a CEO decision on [X]`
- Ultron/Astra/Pym/Leo → Friday: `@friday — [conflict or architecture question]`
- Astra (design questions) → Wanda: `@wanda — [question]`

Sam is a hard gate on all `main` merges (pre-merge security audit); it is never bypassed without
explicit written approval recorded in the PR.

---

## Troubleshooting

### Agent doesn't respond as expected

**Steps:**
1. Re-invoke the agent — transient issues happen.
2. Confirm the agent file is valid: `.agents/agents/<name>.md` has `---` frontmatter and a
   non-empty body.
3. Run `node tools/sync-agents.js --check` to confirm the installed copy (`~/.claude/agents/` or
   `~/.gemini/agentsystem-plugin/agents/`) matches the repo source.
4. Try the plain invocation with no extra prompt content: `claude --agent <name>`.
5. Escalate via `@friday` or `@jarvis` depending on the agent's domain.

---

### Auth failure

**Symptom:** `Error: unauthorized` or `agent not found`.

**Claude Code:**
1. `claude --version` — confirm the CLI is current.
2. Re-authenticate per Claude Code's normal auth flow (`/login` inside a session, or see
   Anthropic's Claude Code docs — there is no `claude auth login` subcommand in this CLI version).
3. Confirm the agent file exists: `%USERPROFILE%\.claude\agents\<name>.md`.

**Antigravity:**
1. Confirm `agy` is installed and on PATH.
2. Confirm the plugin is installed: `agy plugin install ~/.gemini/agentsystem-plugin` (this is
   also what `tools/sync-agents.js` runs automatically when `agy` is found).
3. Confirm the agent file exists: `%USERPROFILE%\.gemini\agentsystem-plugin\agents\<name>.md`.

---

### Memory not found

**Symptom:** Agent reports no memory or starts without prior context.

**Steps:**
1. Live memory is the graph brain under `~/agent-memory/nexus/` — query via
   `node tools/graph/graph-query.js agentsystem <keywords>`.
2. Run `node tools/sync-agents.js` to make sure the agent definitions themselves are in sync.
3. `.agents/memory/*.md` is deprecated (#117) and no longer present — historical scratch notes,
   read by no tool. This repo is public and deleting a file from HEAD does not remove it from
   history, so keep client and infrastructure specifics out of anything committed here.

---

### Agent loads but ignores domain routing

**Symptom:** Jarvis not routing to the expected domain agent.

**Steps:**
1. Check `docs/AGENTS.md` routing rules — is the task description triggering the right pattern?
2. Use explicit `--agent <name>` to bypass routing and invoke directly.
3. If the routing rule itself is wrong, update the routing section in `docs/AGENTS.md` and re-run
   `node tools/sync-agents.js`.
