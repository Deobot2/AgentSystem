# AgentSystem

## Agent Management
- Edit: `.agents/agents/<name>.md`
- Sync to all CLIs: `node tools/sync-agents.js` (all platforms)
- Verify: check `.agents/sync.log` for ERROR lines

## Hook Deployment
Hooks in `hooks/` do nothing until they are both **copied** to `~/.claude/hooks/` and
**registered** under the `hooks` key of `~/.claude/settings.json`. One command does both:

- Deploy + register: `node tools/deploy-hooks.js` (all platforms, idempotent)
- Check for drift: `node tools/deploy-hooks.js --check` (exit 1 if out of sync)

Run it after any change to `hooks/`. Registration was previously PowerShell-only
(`sync_hooks_from_repo.ps1`), so on Linux the whole pipeline was installed-but-inert —
`--check` in CI is what stops that recurring. The manifest lives in `HOOK_REGISTRY`
in `tools/deploy-hooks.js`; add new hooks there, not to the .ps1.
- Code-location searches ("where is X defined", "what calls Y"): prefer
  `caveman:cavecrew-investigator` over the generic `Explore` agent — same result, ~60% less
  context consumed by the tool-result injected back into the caller (#164).

## Memory
Root: `~/agent-memory/nexus/` — shared across Claude, Antigravity

Onboard a repo (CLAUDE.md block + graph brain + registry): `node tools/bootstrap-repo.js [repoPath]`
Onboard every git repo under a dir (also creates the global brains): `node tools/bootstrap-repo.js --all ~/dev`
Cross-platform (Node.js, builtins only); idempotent. The per-repo `nexus/` brain is gitignored.

## Routines Engine

Agent routines are defined in `config/routines.yml` and enforced hard by default. To add a new routine: add a YAML entry with `id`, `description`, `trigger`, `mechanism` (`agent-rule`|`hook`|`cron`), `enforce: hard`, `enabled: true`, and `action`. Then run `node tools/routines.js compile` to regenerate `.agents/rules/routines.generated.md`. To bypass a routine without editing the registry: `node tools/routines.js bypass <id>`. See `docs/memory-and-routing-redesign.md` → "Routines engine" section.

## Path-Scoped Rules

These rules only activate when touching matching files (Claude Code `paths:` feature):

- **Database / schema files** (`*.sql`, `prisma/**`, `*.prisma`):
  Pym domain. Run migrations in dev first. Never `prisma migrate deploy` without approval.

- **Agent definitions** (`.agents/**`):
Edit `.agents/agents/<name>.md`, then run `node tools/sync-agents.js` to sync to all CLIs.

- **CI/CD workflows** (`.github/workflows/**`):
  Test on feature branch before merging. Self-hosted runner required for agent-dispatch.yml.
  **Self-hosted runner is the Linux Mission Control host.** `agent-dispatch.yml`, `sam-audit.yml`,
  `friday-audit.yml`, and `scheduled-tasks.yml` pin `runs-on: [self-hosted, Linux]` and their steps
  are **bash** (ported from Windows PowerShell). Install/re-register the runner on the mission-control
  server with `bash tools/mission-control/install-runner.sh` (or `install-local.sh --with-runner`);
  it installs as a boot-persistent systemd service via the runner's own `svc.sh` and needs `gh`,
  `node`, and the `claude` CLI on the host (the audit/dispatch steps resolve them by absolute path,
  `~/.local/bin` first).
  **Single point of failure (see #115):** if that runner is offline, dispatched `/agent`, `/merge`,
  `/close` comments and label triggers silently no-op — no PR comment, no failure signal, nothing
  queues or retries. `.github/workflows/runner-health-check.yml` runs on a schedule and opens/updates
  a tracking issue labeled `runner:down` if the self-hosted runner has no recent job; check that issue
  (or `gh api repos/:owner/:repo/actions/runners`) if a dispatched command appears to hang.

  **Sam pre-merge audit timing (#164):** `sam-audit.yml` no longer runs on every `synchronize`
  push — it fires once per PR at merge-prep time: on `opened` (non-draft PRs only), on
  `ready_for_review` (draft→ready transition), or when the `ready-to-merge` label is added to an
  already-open PR. To (re-)trigger Sam's gate on an open PR — e.g. after addressing feedback —
  mark the PR "ready for review" if it's a draft, or add the `ready-to-merge` label. A non-draft
  PR opened directly still gets exactly one automatic audit on `opened`.
  `friday-audit.yml` (engineering review, informational only) fires once, on `opened`. Both
  workflows skip docs-only changes (`docs/**`, `**/*.md` via `paths-ignore`) and PRs labeled
  `spec`. `pr-auto-review` (cavecrew reviewer, formerly in `scheduled-tasks.yml`) is retired —
  `friday-audit.yml` is the single engineering reviewer.

- **Memory tools** (`tools/**`):
  No npm deps. Pure Node.js builtins + graph-lib.js imports only.

- **Test files** (`tests/**`, `**/*.test.js`):
  Run `node --test <file>` before committing. All tests must pass on dev before PR to main.

<!-- AGENT-SYSTEM-BOOTSTRAP: do not remove this block -->
## Agent System Context (auto-injected by bootstrap-repo.js)

- Agent routing: see `~/.claude/CLAUDE.md`
- Agent brain: `~/agent-memory/nexus/agent-brain/`
- Repo brain: `nexus/agentsystem/` (run `node tools/graph/graph-init.js agentsystem .` to refresh)
- Query graph: `node tools/graph/graph-query.js agentsystem <keywords>`
- Update weights: `node tools/graph/graph-weight.js visit agentsystem <source> <target>`
- Known repos: `~/agent-memory/nexus/known-repos.json`
- Shared memory: `~/agent-memory/nexus/` — same path for Claude Code and Gemini
<!-- END AGENT-SYSTEM-BOOTSTRAP -->
