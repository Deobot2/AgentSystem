# Harness support matrix

Which AgentSystem features actually work on which host CLI. Every feature is `supported`,
`unsupported-by-design`, or `gap` — there is no fourth state and no blank cell. A cell that is not
`supported` carries a reason.

Hosts: **Claude Code** (`claude`) and **Antigravity** (`agy`). Both are first-class; support is not.

Keep this file honest by editing it in the same commit as the change it describes.
`tests/harness-support.test.js` fails the build if a hook exists in `HOOK_REGISTRY` that this file
does not account for, and if a `gap` cell has no linked issue.

## The one root cause

**Antigravity has no hook layer.** `tools/deploy-hooks.js` copies hooks to `~/.claude/hooks` and
registers them under `hooks` in `~/.claude/settings.json`. Nothing equivalent exists for `agy`, so
every registered hook in `HOOK_REGISTRY` is Claude-only.

That single fact explains most of the `gap` cells below, which is why they share one tracking issue
rather than one each. Everything AgentSystem does *automatically* — inject memory, enforce routines,
route agents, log session cost, name sessions — rides on a hook. In an Antigravity session, those
features are not degraded; they never run. The tools they call still work when a human or a script
invokes them directly, which is the difference between the `gap` rows and an outright
`unsupported-by-design`.

Prior art for exactly this shape: hooks were once registered PowerShell-only, so on Linux the whole
pipeline was installed-but-inert (`CLAUDE.md` → Hooks). Same failure, different axis.

## Matrix

| Feature | Claude Code | Antigravity | Reason |
|---|---|---|---|
| Agent roster + definitions | `supported` | `supported` | `tools/sync-agents.js` writes both `~/.claude/agents/` and an `agy` plugin, then runs `agy plugin install`. See the caveat below. |
| Agent routing (automatic) | `supported` | `gap` | `hooks/memory-router.js`, `hooks/routing-config.js`. Hook-borne — see [#240](https://github.com/Zene8/AgentSystem/issues/240). Naming an agent explicitly still works. |
| Hooks | `supported` | `unsupported-by-design` | `agy` exposes no hook registration surface. If one appears, this becomes a `gap`. |
| Routines engine — compile/verify | `supported` | `supported` | `tools/routines.js` is a plain Node CLI. Host-neutral. |
| Routines engine — enforcement | `supported` | `gap` | `hooks/routines-context-inject.js` (SessionStart) is the only thing that puts `routines.generated.md` in front of a model. `enforce: hard` is not enforced in an `agy` session. [#240](https://github.com/Zene8/AgentSystem/issues/240). |
| Memory / brain — read + write | `supported` | `supported` | `brain-remember.js`, `graph-query.js`, `brain-sync.js` are Node CLIs over `~/agent-memory/nexus/`. `GEMINI.md` documents the same paths. |
| Memory — auto-injection | `supported` | `gap` | `hooks/memory-context-inject.js` (SessionStart) and `hooks/memory-context-inject-subagent.js` (SubagentStart). [#240](https://github.com/Zene8/AgentSystem/issues/240). |
| Pre-compaction handoff doc | `supported` | `gap` | `hooks/claude-hooks/context-handoff.sh` (PreCompact) writes a handoff before context is compacted. `agy` loses that context with no record. [#240](https://github.com/Zene8/AgentSystem/issues/240). |
| Memory — auto-capture | `supported` | `gap` | `hooks/memory-capture-hook.js`, `hooks/sona-writeback-hook.js`. [#240](https://github.com/Zene8/AgentSystem/issues/240). |
| Session naming — the namer | `supported` | `supported` | `tools/session-namer.js` reads `agy` transcripts directly from `~/.gemini/antigravity-cli/`. |
| Session naming — automatic | `supported` | `gap` | `hooks/session-auto-rename-hook.js` (SessionEnd). An `agy` session is nameable but never named on its own. [#240](https://github.com/Zene8/AgentSystem/issues/240). |
| Skills | `supported` | `unsupported-by-design` | `tools/deploy-private-skills.sh` installs to `~/.claude/skills/`; skills are a Claude Code construct with no `agy` equivalent. Life OS stage 2 therefore pins Claude. |
| Memory — usefulness scoring | `supported` | `gap` | `hooks/injection-feedback-hook.js` (Stop). Injections are never scored on `agy`, so the ranking it feeds is trained on Claude sessions only. [#240](https://github.com/Zene8/AgentSystem/issues/240). |
| Cost tracking | `supported` | `gap` | `tools/session-cost.js` reads `nexus/session-log.jsonl`, written by `hooks/claude-hooks/session-end.sh` and `tools/pm-hygiene.js`. No hook, no rows — `agy` spend is invisible, not merely unreported. [#240](https://github.com/Zene8/AgentSystem/issues/240). |
| Session registry bookkeeping | `supported` | `gap` | `hooks/claude-hooks/session-start.sh` registers the session, `user-prompt-submit.sh` finalises its name on the first prompt, `session-close.sh` writes the handoff doc. None of it happens for an `agy` session. [#240](https://github.com/Zene8/AgentSystem/issues/240). |
| Session status lifecycle | `supported` | `gap` | `hooks/claude-hooks/pr-status-detect.sh` (PostToolUse, Bash-scoped) flips a session from `started` to `pr` when it opens a PR ([#158](https://github.com/Zene8/AgentSystem/issues/158)). An `agy` session never advances past `started`. [#240](https://github.com/Zene8/AgentSystem/issues/240). |
| Routine dispatch + compliance | `supported` | `gap` | `hooks/routine-dispatch.js` (PostToolUse, Bash-scoped) fires routine actions; `hooks/routine-compliance-hook.js` (Stop) checks they were followed. [#240](https://github.com/Zene8/AgentSystem/issues/240). |
| Git safety guard | `supported` | `gap` | `hooks/claude-hooks/guard-git.sh` (PreToolUse) blocks pushes to `main`/`master`. An `agy` session has nothing stopping it. The sharpest gap on this list after `enforce: hard`. [#240](https://github.com/Zene8/AgentSystem/issues/240). |
| WIP checkpointing | `supported` | `gap` | `hooks/claude-hooks/wip-checkpoint.sh` (PostToolUse) auto-stages edits on feature branches so work survives a lost session. [#240](https://github.com/Zene8/AgentSystem/issues/240). |
| Mission Control — dispatch | `supported` | `supported` | `webhook-server.js` takes `harness: "claude"｜"agy"` and enforces a per-harness concurrency cap. `agy-dispatcher.js` / `agy-persistence.js` handle the `agy` side. |
| Mission Control — session persistence | `supported` | `supported`, degradable | `agy` sessions need tmux; without it they run detached and cannot be attached to or reattached. Reported as `agy_persistence` on `/health` since #201. |
| human-needed alerts | `supported` | `supported` | `tools/human-needed.js` is a Node CLI over `gh`. Host-neutral. |
| Actions watchdog | `supported` | `supported` | `tools/actions-watchdog.js` runs on a systemd timer, outside both harnesses on purpose. |

## Caveats that are not gaps

**Agent `tools:` frontmatter is dropped for Antigravity.** `agy` silently discards any agent whose
`tools:` names a tool it does not recognise, and the roster's tool names are Claude-style. So
`sync-agents.js` omits the key entirely and `agy` agents load with default tool access. The agent
exists and works; its tool restrictions do not travel. Deliberate — see the comment at
`tools/sync-agents.js:157`.

**Model IDs differ.** `agy` is a Gemini-family runtime, so the sync maps each agent to
`MODELS.gemini`. Same roster, different model per host.

## Verifying a cell

Before flipping a cell to `supported`, run the feature on that host and check the effect, not the
exit code. The failure mode this document exists to prevent is a step that succeeds while doing
nothing: `deploy-hooks.js` exited 0 on Linux for months while registering nothing (`CLAUDE.md` →
Hooks), and four `enforce: hard` cron routines sat unregistered while `compile` printed Windows
instructions (#200). Exit 0 is not evidence.
