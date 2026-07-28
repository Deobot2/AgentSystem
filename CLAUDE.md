# AgentSystem

## Agents
- Edit `.agents/agents/<name>.md`, then `node tools/sync-agents.js` (all platforms).
- Verify: `.agents/sync.log`, grep ERROR.
- Code-location searches ("where is X defined", "what calls Y"): use
  `caveman:cavecrew-investigator`, not `Explore` — same result, ~60% less caller context (#164).

## Hooks
Hooks do nothing until **copied** to `~/.claude/hooks/` AND **registered** under `hooks` in
`~/.claude/settings.json`. One command does both:
- `node tools/deploy-hooks.js` — deploy + register, idempotent
- `node tools/deploy-hooks.js --check` — exit 1 on drift or missing registration

Run after any `hooks/` change. Manifest is `HOOK_REGISTRY` in `tools/deploy-hooks.js` — add new
hooks there. Registration was once PowerShell-only, so on Linux the whole pipeline was
installed-but-inert; `--check` in CI is what stops that recurring.

Not registered on purpose: `tool-output-compress.js`. PostToolUse can only append context, never
replace a tool result — it cost ~800 tok per large Bash output while claiming to save.

## Memory
Root `~/agent-memory/nexus/` — shared by Claude and Antigravity.
Per-agent nodes: `nexus/agent-brain/<agent>/nodes/`.

- Onboard one repo: `node tools/bootstrap-repo.js [repoPath]`
- Onboard every git repo under a dir (+ global brains): `node tools/bootstrap-repo.js --all ~/dev`

Node builtins only, idempotent. Per-repo `nexus/` brain is gitignored.

## Session Naming

Sessions are named automatically at exit by `hooks/session-auto-rename-hook.js` (wired as the
third `SessionEnd` hook). A hook cannot invoke `/rename-session` — hooks are shell commands with
no model turn — so it reproduces the command's steps: digest the transcript → headless
`claude -p` (haiku, `--safe-mode --no-session-persistence`) for `{"summary","status"}` →
`tools/session-namer.js --auto-rename`. Two-phase: the hook returns in ~80ms and a detached
worker does the ~12s model call.

A manual `/rename-session` always wins — the hook only overwrites names it wrote itself, tracked
by markers in `~/.claude/cache/session-autorename/`. Results land in
`~/agent-memory/nexus/session-autorename.log`; the worker verifies the registry actually changed
rather than trusting exit code 0.

**Never compare `pathToFileURL(process.argv[1])` to `import.meta.url` without realpath'ing
argv[1]** — `import.meta.url` is always symlink-resolved. `~/dev/AgentSystem` is a symlink to the
real checkout, so that check silently disabled `session-namer.js` for every production caller
(exit 0, zero work). Guarded by `tools/session-namer-symlink.test.js`.

## Routines
`config/routines.yml`, enforced hard by default. New routine: add entry with `id`, `description`,
`trigger`, `mechanism` (`agent-rule`|`hook`|`cron`), `enforce: hard`, `enabled: true`, `action`;
then `node tools/routines.js compile` to regenerate `.agents/rules/routines.generated.md`.
Bypass without editing: `node tools/routines.js bypass <id>`.
**`action:` text is injected every session — keep it terse.**
See `docs/memory-and-routing-redesign.md` → "Routines engine".

## Path-Scoped Rules

**DB / schema** (`*.sql`, `prisma/**`, `*.prisma`) — Pym domain. Migrate in dev first. Never
`prisma migrate deploy` without approval.

**Agent defs** (`.agents/**`) — edit `.agents/agents/<name>.md`, then `node tools/sync-agents.js`.

**Tools** (`tools/**`) — no npm deps. Node builtins + `graph-lib.js` imports only.

**Tests** (`tests/**`, `**/*.test.js`) — `node --test <file>` before committing. Full suite:
`npm test`. All green on dev before PR to main.

**CI/CD** (`.github/workflows/**`) — test on a feature branch before merging. Sam's
`sam-audit.yml` is a required check on `main` and needs the self-hosted Linux runner.
Read `docs/ci-runbook.md` before editing workflows, or when a dispatched `/agent`,
`/merge`, `/close` or an audit appears to hang (#115) — it covers runner install, the
three things to check when one hangs, and audit trigger timing (#164).

<!-- AGENT-SYSTEM-BOOTSTRAP: do not remove this block -->
## Agent System Context (auto-injected by bootstrap-repo.js)

- Agent routing: see `~/.claude/CLAUDE.md`
- Agent brain: `~/agent-memory/nexus/agent-brain/`
- Repo brain: `nexus/agentsystem/` (refresh: `node tools/graph/graph-init.js agentsystem .`)
- Query graph: `node tools/graph/graph-query.js agentsystem <keywords>`
- Update weights: `node tools/graph/graph-weight.js visit agentsystem <source> <target>`
- Known repos: `~/agent-memory/nexus/known-repos.json`
- Shared memory: `~/agent-memory/nexus/` — same path for Claude Code and Gemini
<!-- END AGENT-SYSTEM-BOOTSTRAP -->
