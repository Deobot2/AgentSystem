# CI/CD runbook

Read this when touching `.github/workflows/**`, or when a dispatched command or audit
appears to hang. CLAUDE.md links here rather than inlining it, because this detail is
only needed for CI work and would otherwise cost ~400 tokens in every session.

Test on a feature branch before merging.

## Self-hosted runner

The self-hosted runner is the Linux Mission Control host. These workflows pin
`runs-on: [self-hosted, Linux]` and their steps are bash:

- `agent-dispatch.yml`
- `sam-audit.yml`
- `friday-audit.yml`
- `scheduled-tasks.yml`

Install or re-register:

```bash
bash tools/mission-control/install-runner.sh
# or, together with the webhook server:
bash tools/mission-control/install-local.sh --with-runner
```

It installs as a boot-persistent systemd service via the runner's own `svc.sh`, and needs
`gh`, `node`, and the `claude` CLI on the host. The audit and dispatch steps resolve those
by absolute path, `~/.local/bin` first.

## When a dispatched command hangs (#115)

Runner offline ⇒ dispatched `/agent`, `/merge`, `/close` comments and label triggers
silently no-op. No PR comment, no failure signal, nothing queues and nothing retries.

`.github/workflows/runner-health-check.yml` runs daily on `ubuntu-latest` and
opens/updates an issue labelled `runner:down`.

Three failure modes to check, in order:

```bash
# 1. Is Actions enabled at all? Disabled repo-wide silently stops everything,
#    including the health check that is supposed to warn you.
gh api repos/:owner/:repo/actions/permissions

# 2. Is a runner registered and online?
gh api repos/:owner/:repo/actions/runners

# 3. Does it carry every required label? An online runner missing `Linux`
#    is exactly as useless as an offline one — jobs queue forever.
```

The health check enforces #3 via `REQUIRED_LABELS`. It also treats "no evidence" as
`unknown` rather than healthy: without a `RUNNER_ADMIN_TOKEN` secret (fine-grained PAT,
Administration: Read-only) it can only prove *down*, never *up*, so it will not
auto-close the tracking issue on indirect detection alone.

## Audit timing

**Sam (`sam-audit.yml`)** — the pre-merge security gate, and a required status check on
`main`. Triggers, as of #228:

- on `opened`, for non-draft PRs only
- on `ready_for_review` (draft → ready)
- on `synchronize` (every push)

There is no label-based trigger. `labeled`/`ready-to-merge` was deliberately removed in #228:
adding *any* label made the job skip, and GitHub counts a skipped required check as satisfied —
so `open PR → push → add label → merge` shipped code to main with no audit at all. Don't
reintroduce a label trigger to "force a re-audit"; that's the exact bypass this closed.

To re-trigger after addressing feedback: push a commit (covered by `synchronize`), or re-run
the job from the Actions UI.

**Friday (`friday-audit.yml`)** — engineering review, informational only. Fires once, on
`opened`.

`friday-audit.yml` skips docs-only changes via a workflow-level `paths-ignore`
(`docs/**`, `**/*.md`) and PRs labelled `spec`. `sam-audit.yml` deliberately does **not** use
`paths-ignore` (#147): it is a required status check, so a workflow-level path filter would mean
docs-only PRs never produce the check at all, making them permanently unmergeable once branch
protection requires it. Instead it early-exits *inside* the job (still labelled `spec` PRs too),
so the required check still reports a passing result without spending an audit run. Do not add
`paths-ignore` to `sam-audit.yml` — it would silently break docs-only PRs. `pr-auto-review` (the
cavecrew reviewer, formerly in `scheduled-tasks.yml`) is retired; `friday-audit.yml` is the single
engineering reviewer.

## Required status checks on `main`

`Node.js tests` and `Security Audit (Sam CSO)`. The latter needs the self-hosted runner,
so with no usable runner every PR is unmergeable without an admin override — and an admin
override merges without the security gate. Fix the runner rather than making a habit of
`--admin`.

## Linked-issue check (#275)

`pr-linked-issue-check.yml` runs on `ubuntu-latest` for every PR opened or synchronized against
`main`. It requires each PR to reference an issue, checked in order:

- the branch name matches `issue-<N>-...`, or
- the PR body contains a close/fix/resolve keyword plus `#N` (`closes #42`, `fixes #42`, etc.)

PRs labelled `spec` are exempt (design/discussion, not merged code). An unlinked PR gets a
one-time bot comment explaining how to link it, and the check fails (`exit 1`) until it is
linked or labelled `spec`. It is not currently in the `Required status checks` list above —
add it there if it should block merges rather than just flag them.
