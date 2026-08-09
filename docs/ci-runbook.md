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

`Node.js tests`, `Security Audit (Sam CSO)` and `PR must be linked to an issue`. The security
audit needs the self-hosted runner, so with no usable runner every PR is unmergeable without an
admin override — and an admin override merges without the security gate. Fix the runner rather
than making a habit of `--admin`.

## Linked-issue check (#275, #296)

`pr-linked-issue-check.yml` runs on `ubuntu-latest` for every PR opened, synchronized, edited or
(un)labelled against `main`, and is a **required status check** with `enforce_admins`. It
collects candidate issue references from:

- the branch name matching `issue-<N>-...`, and
- close/fix/resolve keywords plus `#N` in the PR body (`closes #42`, `fixes #42`, …)

Every candidate is then **resolved through the API** (`issues.get` against this repo). This is
the part #296 added; before it, the check only pattern-matched strings, so `Closes #99999` and a
branch named `issue-0-whatever` both passed a gate that was already required on `main`.

| Case | Verdict | Why |
|------|---------|-----|
| number resolves to an issue here, open **or closed** | linked | the gate enforces that the work is tracked, not that the tracker is still open — issues legitimately close before their PR merges |
| number resolves to a **pull request** | not linked | PRs share the issue numbering space and come back from the same endpoint; a PR is not a tracked work item, and `Closes #<pr>` is usually a typo for the PR's own number |
| number does not exist (**404**) | not linked | the #296 case |
| `#0`, or no reference at all | not linked | rejected before any API call |
| any other API error — 403 rate limit, 5xx, 410, network | **linked, marked UNVERIFIED** | fail-open, deliberately: see below |
| PR labelled `spec` | exempt | design/discussion, not merged code |

**The fail-open is load-bearing.** This is a required check with `enforce_admins`, so failing
closed on a transient API error blocks every merge in the repo at once with no non-admin way
out and no code change that fixes it. A run that could not reach the issues API emits a
`::warning` containing `DEGRADED` and a reason string starting `UNVERIFIED`, and passes. If you
see that, re-run the job — the green check verified nothing.

The `issues: read` permission on that job is what makes the resolution work. Drop it and every
call errors into the fail-open path, i.e. the gate silently reverts to the syntax-only check
#296 removed, staying green the whole time. `tests/pr_linked_issue_check.test.js` pins it.

## "Ready to merge" ping (#295)

The ping `sam-audit.yml` posts after an approving audit used to state that tests were passing
and the PR was ready to merge, having read neither the test check nor the rollup — it fired on
Sam's own verdict alone. On PR #294 it invited a human to `/merge` while a required check was
red. `/merge` itself was never bypassable (`tools/pr-guard.js` gates it in `agent-dispatch.yml`
and does read the checks), so the cost was trust: a confident wrong "ready to merge" trains
people out of reading the check list.

It now reads the check rollup for the head SHA — check runs plus legacy commit statuses,
excluding its own in-progress run — and posts one of: ready to merge, N checks failing (named),
N checks still running (named), or, if the rollup cannot be read, an explicit statement that it
does not know. Sam's approval is reported as covering the security audit only.

## Workflow lint (#293)

`workflow-lint.yml` fails when a file in `.github/workflows/` is unloadable or invalid.

**Why it exists.** GitHub does not surface an unloadable workflow as a failing check — it omits
the check from the list entirely. No red X, no annotation, nothing in `gh pr checks`.
`pr-linked-issue-check.yml` shipped in #275 with a line at column 0 inside a `script: |` block,
which ended the YAML block scalar early and made the file unparseable. It then sat for weeks
looking like a working required gate while executing zero times (#286). A required check that
cannot load is worse than no check: it looks like coverage and provides none.

Two layers, neither of which covers the other:

| Layer | Catches | Does not catch |
|-------|---------|----------------|
| `actionlint` (pinned v1.7.12, sha256-verified) | YAML syntax, schema, expressions, runner labels, action inputs | anything inside a `script:` body — to it that is an opaque string |
| `node tools/workflow-lint.js` | invalid JavaScript in every `script:` block; a conservative YAML structure check | schema and expression errors |

Run either locally:

```bash
node tools/workflow-lint.js                 # all workflows; exit 1 on findings
node tools/workflow-lint.js path/to.yml     # one file
node --test tools/workflow-lint.test.js     # also runs under npm test
```

Two things to know before changing the linter:

- **Do not swap `AsyncFunction` for `node --check`.** A github-script body is an async *function
  body*, so top-level `await` and top-level `return` are both legal. `node --check` parses a whole
  module and rejects one or the other depending on mode — ESM rejects `return`, CJS rejects
  `await`. There is no mode that accepts both. `tools/workflow-lint.test.js` asserts this.
- **`tools/**` is Node-builtins-only**, so there is no `js-yaml`. Block scalars are extracted by
  applying the indentation rule directly: a block scalar ends at the first non-empty line indented
  less than the block's own indent. That is the rule #275 violated, so implementing it here is the
  check, not a workaround.

actionlint's `shellcheck` and `pyflakes` integrations are disabled (`-shellcheck= -pyflakes=`).
shellcheck is preinstalled on ubuntu runners and reports pre-existing SC2086/SC2001 style findings
in unrelated workflows; folding those into this gate would make it land red for reasons unrelated
to loadability. Enabling it is a follow-up once those are cleared.

## Runner host maintenance (#347)

`ssh` to the runner box is refused (port 22, connection refused), so
`.github/workflows/runner-maintenance.yml` is the only hands-on channel to its `~/agent-memory`. It
is `workflow_dispatch` **only** — deliberately not a routine, because `config/routines.yml` would
then demand a matching cron job in `scheduled-tasks.yml` and `node tools/routines.js verify` would
exit 1, and because a repair that can lose facts should never run unattended.

The single input is `type: choice`. That is a security boundary, not a convenience: these steps run
privileged commands on the same host that runs `sam-audit.yml`, the hard gate on merges to `main`,
so a free-form string input would be arbitrary remote code execution on the machine that decides
what gets merged.

**It cannot be dispatched before it is merged.** GitHub only indexes a `workflow_dispatch` workflow
that exists on the repository's **default branch**; until then `--ref <feature-branch>` returns
`HTTP 404: workflow runner-maintenance.yml not found on the default branch`, and the file does not
appear in `gh api repos/:owner/:repo/actions/workflows` at all. `--ref` selects which branch's copy
*runs*, not whether the workflow exists. So the first `status` run is a post-merge action, and the
branch-before-merge testing rule cannot apply to a dispatch-only workflow — lint and YAML parse are
the pre-merge evidence available.

```bash
gh workflow run runner-maintenance.yml -f mode=status            # read-only; always run this first
gh workflow run runner-maintenance.yml -f mode=repair-brain      # only after reading a status run
gh workflow run runner-maintenance.yml -f mode=bootstrap-run-log # one-time; unblocks weekly-trust-scores
```

`repair-brain` is the dangerous one, because the runner's checkout may hold commits that exist on
no other host (per-agent decision logs, user preference nodes). Its order is the safety property:

1. tar the whole checkout **including `.git`** to `~/agent-memory-backups/` — the local-only commits
   are the irreplaceable part, and a working-tree-only backup would not restore them;
2. resolve markers **before any `git add`**. This inversion is the whole fix: `brain-sync.js` runs
   `git add -A` *before* it pulls, so a half-merged tree is just file content to it and markers get
   committed and pushed as data (#344, 128 files);
3. reconcile with `git merge`, which keeps **both** parents. A merge commit cannot drop a local
   commit; a reset can. `reset --hard`, `push --force`, `checkout --theirs` and `clean -fd` are
   absent from that file on purpose;
4. prove zero markers remain **before** pushing, so the repair run cannot be the one that publishes
   markers to origin;
5. rebuild every graph, then re-run `memory-decay.js --all` — verification by execution, not by
   exit code.

If any of that cannot be done losslessly the job **stops**, raises the `runner-brain-repair-blocked`
human-needed alert, and exits nonzero. Stopping is the designed outcome; forcing a resolution is the
failure mode.

`tools/resolve-brain-markers.js` is the repair itself and is runnable anywhere (`--check` reports
without writing). Two rules, both lossless: a block whose every line on both sides is a date-ish
frontmatter key keeps the **earlier** value (`created:` is a creation timestamp, so a later value is
a re-import artifact); everything else **unions** both sides, HEAD first, de-duplicated.
`graph.json` is never repaired line-by-line — it is generated, so the tool takes one side that
parses and the rebuild comes from `nodes/` via:

```bash
node tools/graph/graph-init.js <slug> --brain-path="$HOME/agent-memory/nexus/<slug>"
```

Use `--brain-path`. The positional `graph-init.js <slug> <path>` form writes a brain nested inside
the brain and prints a success line for work it did not do (#346), and its output arrow is relative
so the two forms are indistinguishable from the log.
