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
`main`. Fires once per PR at merge-prep time (#164):

- on `opened`, for non-draft PRs only
- on `ready_for_review` (draft → ready)
- when the `ready-to-merge` label is added to an already-open PR

To re-trigger after addressing feedback: mark the PR ready for review if it is a draft,
or add the `ready-to-merge` label. It no longer runs on every `synchronize` push.

**Friday (`friday-audit.yml`)** — engineering review, informational only. Fires once, on
`opened`.

Both skip docs-only changes (`docs/**`, `**/*.md` via `paths-ignore`) and PRs labelled
`spec`. `pr-auto-review` (the cavecrew reviewer, formerly in `scheduled-tasks.yml`) is
retired; `friday-audit.yml` is the single engineering reviewer.

## Required status checks on `main`

`Node.js tests` and `Security Audit (Sam CSO)`. The latter needs the self-hosted runner,
so with no usable runner every PR is unmergeable without an admin override — and an admin
override merges without the security gate. Fix the runner rather than making a habit of
`--admin`.
