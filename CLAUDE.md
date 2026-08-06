# AgentSystem

## Agents
- Edit `.agents/agents/<name>.md`, then `node tools/sync-agents.js` (all platforms).
- Verify: `node tools/sync-agents.js --check` (exit 1 on drift, writes nothing), or
  `.agents/sync.log`, grep ERROR.
- **Never** verify with `diff .agents/agents/<a>.md ~/.claude/agents/<a>.md`. The source holds
  empty `<!-- SHARED:x -->` marker pairs that the sync expands from `.agents/rules/shared-blocks.md`,
  so that diff is never empty even when in step. Reading it as "installed copies are ahead of the
  repo" produced #195, a high-priority overwrite hazard that did not exist.
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

`tool-output-compress.js` was deleted in `4adeab6` (2026-07-26). Its PostToolUse implementation
could only **append**, so compressing a large output meant keeping the original and adding a
summary on top — measured at +3218 chars on a 10,000-char output. PostToolUse can now **replace** a
result via `hookSpecificOutput.updatedToolOutput` (confirmed against the hook docs, Aug 2026), so a
redo would actually save. Nobody has asked for one — don't build it on spec.

## Memory
Root `~/agent-memory/nexus/` — shared by Claude and Antigravity.
Per-agent nodes: `nexus/agent-brain/<agent>/nodes/`.

- Onboard one repo: `node tools/bootstrap-repo.js [repoPath]`
- Onboard every git repo under a dir (+ global brains): `node tools/bootstrap-repo.js --all ~/dev`

Node builtins only, idempotent. Per-repo `nexus/` brain is gitignored.

### Central brain (one brain, every host)

`~/agent-memory` is a checkout of the **private** repo `Zene8/agent-memory`. Every host running
AgentSystem shares it, so a fact learned on the laptop is available to the scheduled job on the Mission
Control server.

- New host: `bash tools/brain-join.sh` — commits that host's existing nodes first, then merges the
  central brain in, so nothing local is lost. Idempotent; tars a pre-join backup.
- Ongoing: `node tools/brain-sync.js` (pull, merge, commit, push) / `--status` to look only.

Two things that are easy to get wrong:
- **The brain repo is private and must stay private** — it holds user preferences, client project
  notes, and per-agent decision logs. `Zene8/AgentSystem` is public.
- **`graph.json` is generated, not authored.** The graph tools rewrite it whole, so two hosts
  thinking at once conflict on it every time. `brain-sync.js` takes either side and expects
  `graph/graph-init.js` to rebuild it from `nodes/`. Never hand-merge it.

Append-only per-host logs (`session-log.jsonl`, `routing-log.jsonl`, `injection-*.jsonl`,
`auto-capture.log`) are gitignored in the brain: they conflict on every sync and hold no facts.

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

## Is-main checks

**Never hand-roll "am I the entry point?".** Use:
```js
import { isMainModule } from './is-main.js';
if (isMainModule(import.meta.url)) main();
```
`import.meta.url` is always symlink-resolved; `process.argv[1]` is not. `~/dev/AgentSystem` is a
symlink to the real checkout and is the path `config/routines.yml`, the installed hooks and the
docs all tell callers to use — so any comparison that skips `realpathSync(argv[1])` is false in
production and `main()` never runs. Exit 0, zero work, no error. It hit `session-namer.js` first
(#158 era), then sat in **25 other tools** until fixed fleet-wide, because that fix was a local
edit instead of a shared helper. `tools/is-main.test.js` now fails the build if any tool compares
`process.argv[1]` to `import.meta.url` itself.

## Routines
`config/routines.yml`, enforced hard by default. New routine: add entry with `id`, `description`,
`trigger`, `mechanism` (`agent-rule`|`hook`|`cron`|`external`), `enforce: hard`, `enabled: true`,
`action`; then `node tools/routines.js compile` to regenerate
`.agents/rules/routines.generated.md`. Bypass without editing: `node tools/routines.js bypass <id>`.
**`action:` text is injected every session — keep it terse.**

- `mechanism: cron` **must** have a matching job in `.github/workflows/scheduled-tasks.yml`, with
  the same cron expression. Add `workflow_job:` when the job name differs from the routine id.
- `node tools/routines.js verify` (or `compile --verify`) cross-checks that and exits 1 on a
  mismatch. Four `enforce: hard` cron routines once sat unregistered for weeks while `compile`
  printed Windows Task Scheduler instructions on a Linux host (#200) — the compile step lying
  about enforcement was the defect, the dead routines were the symptom.
- `mechanism: external` is for jobs on platforms this repo does not control (Life OS stage 1 runs
  in Grok Tasks). It must not be `enforce: hard` — nothing here can enforce it — and it is exempt
  from cron verify.

See `docs/memory-and-routing-redesign.md` → "Routines engine".

## Life OS daily cadence

Two stages. **Stage 1 (06:00)** is a Grok Task, external to this repo: it triages mail/calendar and
archives a brief with a machine-readable `handoff:` block. **Stage 2 (13:00 and 05:00 UTC — 06:00 and 22:00 Pacific)** is the `daily-triage`
job in `scheduled-tasks.yml` — Jarvis reads that handoff, covers Beeper/Discord/GitHub, executes
AI-actionable items as **draft PRs only**, and writes `$LIFE_REPO/closeouts/YYYY-MM-DD.md`, which
Mission Control's `GET /briefing` serves.

- **Is it healthy?** `node tools/life-os-doctor.js`. Hard gaps fail the preflight; soft gaps
  (an unauthenticated MCP connector) degrade coverage without failing the run. `--hard-only` skips
  the network probes; `--alert` opens/closes the coverage issue.
- **The skills are gitignored** (#187) and git will never carry them. Ship them from the machine
  that has them: `bash tools/deploy-private-skills.sh --host <user@host>`.
- Stage 2 needs `~/dev/AgentSystem` to exist — the skill's GitHub sweep runs there.
- A missed or failed run raises a `human-needed` issue from two directions: the job itself, and
  `daily-triage-watchdog.yml` on GitHub-hosted infra, so a dead self-hosted runner cannot hide the
  outage. Both use the key `daily-triage-down`, so one outage is one issue. A successful run closes
  it. Four consecutive silent failures went unnoticed before this existed.

## Human-needed alerts

When an agent or job is blocked on something only a person can do, raise it — do not just fail:
```bash
node tools/human-needed.js raise <stable-key> --title "..." --why "..." --action "..."
node tools/human-needed.js resolve <stable-key>
node tools/human-needed.js list
```
It opens one GitHub issue labelled `human-needed` per key, keyed by a marker in the body (not the
title, which humans edit). Re-raising an open alert comments instead of duplicating, at most once
per 20h, so a daily job neither opens 365 issues nor goes quiet. GitHub is the channel because it
already emails and survives a host reboot; there is no push endpoint on the webhook server.

## Actions watchdog (runs off Actions on purpose)

`tools/actions-watchdog.js` checks hourly that Actions is enabled repo-wide **and** that the newest
workflow run is younger than 24h, and raises/resolves the `actions-down` human-needed alert.

**Do not move this into a workflow.** Every other watchdog here is an Actions workflow, so a
repo-level disable silences the detector along with everything it detects — that is how Actions
sat off for five days unnoticed (#197). It lives on the host:
```bash
bash tools/install-actions-watchdog.sh      # systemd --user timer, hourly, enables linger
node tools/actions-watchdog.js --dry-run    # verdict only, changes nothing
```
Exit 3 means "outage detected, alert raised" — the unit declares `SuccessExitStatus=0 3` so
systemd does not read a working watchdog as a failed one. Alerting still goes through GitHub
Issues, which is unaffected by `actions/permissions.enabled = false`.

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
