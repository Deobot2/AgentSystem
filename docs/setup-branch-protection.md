# Branch Protection Setup — Required for Autonomous Loop

Run these once to wire up the fully autonomous development loop:
Issue → Friday works → PR opens → Sam audits → Tests pass → Auto-merge → Issue closes

## What the autonomous loop looks like

```
1. Issue exists with agent:friday label
   → agent-dispatch.yml fires
   → Friday executes: branch → work → PR (with --auto merge enabled)

2. PR opened
   → sam-audit.yml fires automatically (no prompt needed)
   → Sam runs 10-item checklist, posts GitHub Review (APPROVE or REQUEST_CHANGES)
   → test.yml fires (Node tests)

3. All checks pass (Sam approved + tests green)
   → PR auto-merges (--auto was set in step 1)
   → Branch deleted
   → Issue auto-closed (via "Closes #N" in PR body)
```

## One-time GitHub setup (run from repo root)

```powershell
# 1. Enable auto-merge on the repo (required for --auto flag to work)
gh repo edit --enable-auto-merge

# 2. Protect dev branch: require Sam audit + tests before merge
gh api repos/:owner/:repo/branches/dev/protection `
  --method PUT `
  --field required_status_checks='{"strict":true,"contexts":["Security Audit (Sam CSO)","Node.js tests"]}' `
  --field enforce_admins=false `
  --field required_pull_request_reviews='{"required_approving_review_count":0,"dismiss_stale_reviews":true}' `
  --field restrictions=null

# 3. Protect main branch: same checks, stricter
gh api repos/:owner/:repo/branches/main/protection `
  --method PUT `
  --field required_status_checks='{"strict":true,"contexts":["Security Audit (Sam CSO)","Node.js tests"]}' `
  --field enforce_admins=false `
  --field required_pull_request_reviews='{"required_approving_review_count":1,"dismiss_stale_reviews":true}' `
  --field restrictions=null
```

## Self-hosted runner required

Sam audit runs on `self-hosted` runner (needs Claude CLI installed).
If not yet set up:
```powershell
# Run as Administrator
powershell -File tools/setup-runner.ps1
```

Verify runner is online:
```powershell
gh api repos/:owner/:repo/actions/runners --jq '.runners[] | {name, status}'
```

## What "auto-merge" means in practice

After Friday runs `gh pr merge {N} --squash --delete-branch --auto`:
- GitHub queues the PR for auto-merge
- The PR stays open until ALL required checks pass
- When Sam approves AND tests pass → GitHub merges automatically
- No human needs to click anything

If Sam blocks: PR stays open, Sam's review shows REQUEST_CHANGES, the `sam-audit` check fails.
Fix the issue, push to the branch → Sam re-audits automatically (new push triggers new audit).

## Checking status

```powershell
# See all open PRs and their check status
gh pr list --state=open --json number,title,statusCheckRollup

# See Sam's review on a specific PR
gh pr reviews 43
```
