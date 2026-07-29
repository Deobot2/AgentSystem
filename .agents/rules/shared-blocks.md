# Shared Agent Blocks

Canonical text for sections duplicated across agent definitions. Agent files in
`.agents/agents/*.md` contain empty marker pairs like
`<!-- SHARED:operating-discipline --> <!-- /SHARED:operating-discipline -->`;
`tools/sync-agents.js` injects the text between the matching markers below at sync
time, before writing to platform dirs. Edit the text here once — it deploys to every
agent that carries the marker.

## Operating Discipline

<!-- SHARED:operating-discipline -->
EVIDENCE RULE: never claim done/fixed/works without running the actual flow and quoting the decisive output line -- tests green != behavior correct.
KNOWN TRAPS: PowerShell 5.1 has no `&&`/ternary and pipes reset LASTEXITCODE; Git Bash paths are `/c/...`; gh CLI GraphQL Int args need `-F` not `-f`, GITHUB_TOKEN cannot APPROVE a PR; self-hosted runner PATH is not inherited (use absolute exe paths); `--agent` names are case-sensitive; large payloads go via stdin, not argv; workflow here-string closers (`'@`/`EOF`) must sit at column 0.
CONTEXT BUDGET: delegate searches to `caveman:cavecrew-investigator` over raw Explore; read only needed line ranges; keep replies under 500 words.
BRIEF FORMAT: every dispatch you send states the verbatim ask, definition of done, constraints, and a don't-touch list (skill `handoff-brief`).
MEMORY DUTY: durable fact learned -> `node tools/brain-remember.js` immediately; failure -> skill `postmortem` -> `sona-patterns.md`; decision -> `node tools/decision-log.js`.
SKILLS: `verify-claim` before declaring done, `refute` before committing to an architecture, `scope` before spawning a swarm, `replicate-bug` before fixing a bug, `trap-check` before shell/CI work.
<!-- /SHARED:operating-discipline -->

## Swarm sizing

<!-- SHARED:swarm-sizing -->
RULE: own a task directly unless it decomposes into 3+ genuinely independent streams -- do
not fan a 1-2 stream task into a swarm just because delegation is mandatory.
RULE: spawn mechanical/rote subtasks (renames, config tweaks, doc updates, lookups) at low
effort; reserve high/max effort for architecture, security, and cross-cutting design work.
<!-- /SHARED:swarm-sizing -->

## Model override

<!-- SHARED:model-override -->
MODEL OVERRIDE AUTHORITY: you choose the child's model per task, and your choice beats the
child's default from `MODELS.claude` in `tools/sync-agents.js`. Classify BEFORE spawning.
Ladder, most costly + capable first: fable ($10/$50 per 1M tok, 1M ctx) > opus ($5/$25, 1M) >
sonnet ($3/$15, 1M) > haiku ($1/$5, 200K ctx — the only tier without a 1M window).
| Task class | Model | Signals |
|---|---|---|
| CRITICAL | fable | the call the org bets on: security gate on an irreversible change, cross-domain architecture. Rare — justify it in the brief. |
| COMPLEX | opus | architecture, security review, >15 files, cross-cutting design decisions |
| STANDARD | sonnet | feature implementation, bug fix, 1-15 files (default) |
| SIMPLE | haiku | docs, read-only, grep/search, single file |
In-session Agent tool: `model` takes ALIASES ONLY — `fable` | `opus` | `sonnet` | `haiku`. A
full ID such as `claude-opus-5` is rejected by the schema.
Background CLI: full IDs — `claude --bg --agent <name> --model claude-opus-5 -p "<brief>"`.
RULE: override UP when the child's cheap default is the likely reason it fails — haiku default
but >200K of context to read, or an auth path / DB migration / anything irreversible.
RULE: override DOWN when a costly default would burn budget on rote work.
RULE: name the override and its reason in the brief, so the child knows the tier it got.
<!-- /SHARED:model-override -->
