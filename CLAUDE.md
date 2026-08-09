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
- `node tools/deploy-hooks.js` — deploy + register + drop stale registrations, idempotent
- `node tools/deploy-hooks.js --check` — exit 1 on drift, missing **or stale** registration

Run after any `hooks/` change. Manifest is `HOOK_REGISTRY` in `tools/deploy-hooks.js` — add new
hooks there. Registration was once PowerShell-only, so on Linux the whole pipeline was
installed-but-inert; `--check` is what stops that recurring.

The daily automation is the `enforcement-drift-check` job, which lives in its own
`.github/workflows/enforcement-drift-check.yml` — **not** in `scheduled-tasks.yml`, where it was
gated behind a multi-cron `github.event.schedule` match and never once fired (#300).

Registration used to be additive-only, so a hook deleted from the repo kept firing off an invisible
registration (#302). `--check` now also reports **stale** entries — inside `~/.claude/hooks` but not
in `HOOK_REGISTRY`, or pointing at a file that is gone — and deploy removes them, plus the orphan
file when a stale registration of ours attributes it. Third-party registrations (plugin hooks under
`~/.claude/plugins/**`) are matched by path prefix and never touched. The automation is the daily
`enforcement-drift-check` job in `enforcement-drift-check.yml` on the self-hosted runner; `test.yml` does
**not** run `--check`, because a hosted runner has no install and would only pass vacuously.

A completely bare `~/.claude` makes `--check` print `no-install` and exit 0 — pass
`--require-install` (the daily job does) on a host that is *supposed* to have hooks, so an
un-deployed runner fails instead of reporting success. A hooks dir with **no** `settings.json` is
never a clean skip: that is the installed-but-inert state, and every missing registration is
reported.

Hooks are Claude Code only — there is no Antigravity equivalent, so every hook-borne feature is
inert in an `agy` session (#240). Adding a hook therefore adds an Antigravity gap: record it in
`docs/harness-support.md`, which `tests/harness-support.test.js` enforces.

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

## Continuous sync (#341)

`brain-sync.js` was correct and nothing ran it, so hosts only converged when a person remembered.
Three triggers now do, all through one wrapper, `tools/brain-sync-run.js`:

| Trigger | Memory | Code (this checkout) |
|---|---|---|
| SessionStart (`hooks/continuous-sync-hook.js --phase=start`) | `--pull-only` | `tools/repo-sync.js` — `git pull --ff-only` |
| SessionEnd (`--phase=end`) | commit + push | never |
| Host timer, ~15 min | commit + push | never |

- **The timer is not a nicety.** It is the only trigger that reaches a host with no session ever
  open — the Mission Control box, which writes memory from cron and drifted until a weekly job hit
  ~250 conflicting nodes (#340). Install it: `bash tools/install-brain-sync-timer.sh` (systemd
  `--user`, linger enabled) or `.\tools\install-brain-sync-timer.ps1` on Windows. `--check` runs in
  the daily `enforcement-drift-check` job, because an un-installed timer fails silently by
  construction.
- **Code is pulled at SessionStart only**, never at end and never on the timer: rewriting the tree
  under a running session means the model's picture of it silently stops matching. A dirty tree or
  any branch other than `main` is skipped in silence, and nothing here ever pushes — PR plus Sam's
  gate is unchanged.
- **A memory conflict is never auto-resolved.** No `-X ours`, no retry with a different strategy.
  `~/agent-memory` is user data in a private repo, so a strategy that picks a side is data loss with
  a green exit code. brain-sync exit 1 becomes exit 3 here plus a `brain-sync-conflict`
  human-needed alert; a later clean sync resolves it. (`graph.json` is the one exception and
  `brain-sync.js` already handles it — take either side, rebuild from `nodes/`.)
- The alert key is **per host** (`brain-sync-conflict-<hostname>`): one issue per machine, because
  a conflict on the laptop and a conflict on the runner are two different people-tasks, and a
  single shared key lets the second one resolve the first one's issue. Alert state lives in
  `~/.cache/agentsystem/` (`%LOCALAPPDATA%\agentsystem` on Windows), not `tmpdir()` — a reboot
  clearing the 20h de-duplication window turns a daily timer back into a daily issue comment.
- A brain with committed conflict markers (`<<<<<<<`) in it is refused before the sync runs, since
  syncing on top of them propagates them to every host. `--ignore-markers` is the escape hatch for
  the person actually resolving them. The scan is repo-wide on purpose: scoping it to files git
  reports as *unmerged* would see nothing in exactly the case that motivated it (#340), where the
  markers were already committed.
- **`brain-sync.js` carries the same guard itself** (#348), because the wrapper is not its only
  caller: the alert body, `brain-join.sh` and the docs all tell a person to run
  `node tools/brain-sync.js` directly, which is exactly the moment the tree is half-merged. It
  refuses before `git add -A` when `MERGE_HEAD` exists, when a path is unmerged, or when tracked
  content still holds `<<<<<<<`. `--ignore-markers` is forwarded down and suppresses only the
  **text scan** — an actually-unfinished merge is git state, and a flag that concluded it would
  re-open #348 behind an override; the ways out there are `git commit` and `git merge --abort`.
  The refusal says "merge conflict needs a human" verbatim, because `brain-sync-run.js` classifies
  on that phrase and reads a bare exit 1 as a network blip that alerts nobody.
- Exit codes: `0` synced/skipped, `2` no brain checkout on this host (passed through, *not*
  alerted, or a host that never cloned it would re-raise forever), `3` conflict alerted — hence
  `SuccessExitStatus=0 3` in the unit.
- Overlap is real: the timer can fire mid-`SessionEnd`. `tools/sync-lock.js` is a time-stale
  lockfile in `tmpdir()` — deliberately **outside** the brain, since `brain-sync.js` runs
  `git add -A` and would commit and push a lockfile to every host.

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

**This is a deliberate reversal of #158, and #158 never said so (#307).** #158 closed
(commit `1124f95`, 2026-07-06) on the acceptance criterion "zero claude/model invocations in
SessionStart/SessionEnd/rename paths," with a pure-string `<repo> - <slug> - <YYMMDD-HHmm> -
<status>` format. Three weeks later, PR #193 / commit `5a2d59c` (2026-07-26) added the headless
`claude -p` call described above — replacing the deterministic slug with a model-written
4-word summary — because the actual ask ("call `/rename-session` from the SessionEnd hook") needs
a natural-language read of the transcript that string ops can't produce; `rename_session` itself
errors "not supported in this context" outside a live session, so reproducing its steps headlessly
was the only way to get an equivalent name. That tradeoff is sound — the log
(`~/agent-memory/nexus/session-autorename.log`) shows real 4-word summaries like
`"validated engineering skill patterns"` that a slug-only scheme cannot produce — but PR #193
never linked #158 or recorded that it was knowingly overriding that closed issue's criterion, so
the guarantee kept reading as live after it no longer was. **Cost per rename:** one Haiku
(`claude-haiku-4-5-20251001`) call, `--max-turns 1`, `--tools ""`, digest capped at 6000 chars
(≈1,500 input tokens) plus a one-line JSON reply — a few hundredths of a cent, once per session
close, not per turn.

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
- Because there is no shared source of truth, the per-host copies can **fork**, and they did:
  a fix applied on the runner was five days newer than the laptop's copy, and a routine deploy
  would have overwritten it silently (#298, which re-opened #257). The deploy now hashes both
  sides first and **refuses** to overwrite a target copy that is different *and* newer; `--force`
  is the only way past it. `--check --host <user@host>` reports that drift without deploying —
  the bare `--check` only compares source-vs-installed on one host and cannot see it.
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
bash tools/install-actions-watchdog.sh          # systemd --user timer, hourly, enables linger
bash tools/install-actions-watchdog.sh --check  # exit 1 on drift; names WHICH fault
node tools/actions-watchdog.js --dry-run        # verdict only, changes nothing
```
Living off Actions does not mean it cannot be **installed** by Actions, and that distinction is
what #361 turned on: the timer had no repair channel on the host that refuses ssh, so the daily
drift check reported a missing heartbeat for weeks with no way to act on it. `repair-install`
(`runner-maintenance.yml -f mode=repair-install`) now installs it from the canonical checkout
`$HOME/dev/AgentSystem` — never the runner workspace, whose path `actions/checkout` rewrites, which
would bake a rotting `ExecStart=` into the unit — and then gates on `--check`. Exit 4 (units on
disk, systemd `--user` bus unreachable) and exit 5 (`gh` missing or unauthenticated, nothing
written) both fail the job and print the exact console command, because a repair that reports
success for a timer that will never fire is the failure it was built to end.

**The installer refuses to install against an unauthenticated `gh`, and no caller may hand it a
token.** Both watchdogs shell out to `gh`; the unit runs later with only `PATH` and `HOME`, so a
token in the installing process proves authentication the timer will never have. The result would
be a timer that fires hourly, fails hourly and stamps no heartbeat — indistinguishable from #361.

`--check` exists because `--check-heartbeat` cannot say *why*: never installed, installed but never
enabled, pointing at a checkout that moved, and `gh` unauthenticated all surface as the same
"heartbeat missing or stale" line. The daily job now prints `--check` as a diagnostic under that
failure. It is diagnostic only — the heartbeat stays the arbiter, since a green `--check` with no
heartbeat is still an outage.
**A hard-won instance of that (#362).** The daily job reported no heartbeat while
`install-actions-watchdog.sh --check` reported every unit in sync, and both were telling the truth.
`runner-maintenance.yml -f mode=status` showed the service had run hourly all day with
`Result=success`, `ExecMainStatus=0`, `gh` authenticated — and no heartbeat file anywhere under
`nexus/`. The unit was fine; the **code it executed** was not. `ExecStart` points at the canonical
checkout `$HOME/dev/AgentSystem`, and that checkout was parked on the long-merged branch
`issue-348-brain-sync-merge-guard`, cut before `b228331` (#355) added `writeHeartbeat` at all
(`git show 7eacfa6:tools/actions-watchdog.js | grep -c writeHeartbeat` → `0`). So every run
succeeded honestly and stamped nothing. `repair-install`'s canon heal (#360) switched canon back to
`main`, the next hourly fire stamped a heartbeat, and the drift check went green.

Two rules fall out of it. **A unit that points at a working tree inherits that tree's git state** —
verifying the unit file verifies the path, never the revision behind it, so canon heal and watchdog
install belong in the same repair pass. And **"the process ran and exited 0" is not "the feature
ran"**: a heartbeat can only attest to code that knows how to write one, which is why the #362
diagnostics report the timer, the last exit status, the journal, the resolved path *and* the file,
rather than any one of them.

Exit 3 means "outage detected, alert raised" — the unit declares `SuccessExitStatus=0 3` so
systemd does not read a working watchdog as a failed one. Alerting still goes through GitHub
Issues, which is unaffected by `actions/permissions.enabled = false`.

`tools/pr-checks-watchdog.js` rides the **same unit** and answers the other half: is any open PR
against `main` producing **none** of the required contexts? PR #326 sat there having dispatched not
one workflow run — its branch conflicted with `main`, so GitHub could not build
`refs/pull/326/merge`, and **GitHub fires no `pull_request` events for a PR it cannot merge**. Only
the GitGuardian app ran, because a GitHub App webhook does not need a merge ref. That is the
#228/#229 class again: an **absent** required check is not a **failing** one, and branch protection
only makes noise about the failing kind.

The predicate is "none of the required contexts present", not "any missing": a partially-checked PR
is already visibly `BLOCKED` and GitHub refuses the merge, so that case is loud and handled — and
"any missing" would page on every check still in flight, which is indistinguishable from one that
never dispatched. Note "zero check runs" would **not** have caught #326 either; it had one, from
GitGuardian. A 30-minute grace window keeps a just-opened PR quiet. Alert key
`pr-missing-required-checks`; `--dry-run` prints the verdict.
When a PR shows zero checks, check `gh pr view <n> --json mergeable` **first** — `CONFLICTING` is
the usual answer, and a rebase brings the checks back.

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
