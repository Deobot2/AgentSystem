# setup-scheduled-tasks.ps1 — register Windows Task Scheduler jobs for AgentSystem memory maintenance.
# Replaces dead self-hosted GitHub Actions cron (scheduled-tasks.yml jobs that use `runs-on: self-hosted`).
#
# Tasks registered:
#   AgentSystem-WeeklyBrainConsolidation  — Monday   08:00, runs memory-maintenance.js --reflect
#   AgentSystem-WeeklyMemoryDecay         — Sunday   00:00, runs memory-decay.js for both brains
#   AgentSystem-WeeklyTrustScores         — Saturday 08:00, runs compute-trust-scores.js
#   AgentSystem-WeeklyAgentReview         — Saturday 09:00, spawns headless Jarvis review via `claude --bg`
#   AgentSystem-EventDispatcherDrain      — every 5 min, drains the durable event bus (event-dispatcher.js)
#
# Note: daily-standup is skipped: interactive agent invocation requires an active session.
# (weekly-trust-scores was previously skipped citing an ESM/CJS bug in compute-trust-scores.js —
# that bug no longer exists as of 2026-07-12; the script is pure ESM and runs clean.)
#
# Usage: Run once as the same user that runs AgentSystem (no admin required for CURRENT_USER tasks).
#   pwsh -File tools/setup-scheduled-tasks.ps1
# To remove all tasks: pwsh -File tools/setup-scheduled-tasks.ps1 -Uninstall

param([switch]$Uninstall)

$NodePath  = (Get-Command node -ErrorAction Stop).Source
# Derive from this script's location instead of hardcoding a user profile path (2026-07-12 audit).
$ToolsRoot = $PSScriptRoot
$LogDir    = Join-Path (Split-Path $PSScriptRoot -Parent) 'logs'

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force $LogDir | Out-Null }

$tasks = @(
    @{
        Name        = 'AgentSystem-WeeklyBrainConsolidation'
        Description = 'Run full memory sleep cycle (split/reconsolidate/decay/stale-prune/consolidate/seed + reflection)'
        # Monday 08:00 local time
        Trigger     = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At '08:00'
        Script      = "$ToolsRoot\memory-maintenance.js"
        Args        = '--reflect'
        Log         = "$LogDir\brain-consolidation.log"
    },
    @{
        Name        = 'AgentSystem-WeeklyMemoryDecay'
        Description = 'Decay visit_count across personal-brain and agentsystem graphs'
        # Sunday 00:00 local time
        Trigger     = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At '00:00'
        Script      = $null  # multi-command; handled via wrapper below
        Args        = $null
        Log         = "$LogDir\memory-decay.log"
    }
)

if ($Uninstall) {
    foreach ($t in $tasks) {
        if (Get-ScheduledTask -TaskName $t.Name -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $t.Name -Confirm:$false
            Write-Host "Removed: $($t.Name)"
        } else {
            Write-Host "Not found (already removed?): $($t.Name)"
        }
    }
    exit 0
}

# ── Task 1: WeeklyBrainConsolidation ─────────────────────────────────────────
# NOTE (fixed): Task Scheduler launches $NodePath directly with no shell, so a
# trailing "$Log 2>&1" was being passed to node.exe as literal argv (node has
# no redirect syntax) instead of being interpreted as shell redirection —
# stdout/stderr were silently discarded and the log file was never written.
# Fixed by routing through cmd.exe /c, which does understand >>/2>&1.
$t = $tasks[0]
$action = New-ScheduledTaskAction `
    -Execute 'cmd.exe' `
    -Argument "/c `"`"$NodePath`" `"$($t.Script)`" $($t.Args) >> `"$($t.Log)`" 2>&1`"" `
    -WorkingDirectory $ToolsRoot

$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable:$false

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $t.Name -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $t.Name -Confirm:$false
}
Register-ScheduledTask `
    -TaskName $t.Name `
    -Description $t.Description `
    -Action $action `
    -Trigger $t.Trigger `
    -Settings $settings `
    -Principal $principal | Out-Null
Write-Host "Registered: $($t.Name) (Monday 08:00)"

# ── Task 2: WeeklyMemoryDecay — two commands, use pwsh wrapper ───────────────
$t = $tasks[1]
$decayScript = @"
node "$ToolsRoot\memory-decay.js" --brain=agentsystem >> "$($t.Log)" 2>&1
node "$ToolsRoot\memory-decay.js" --brain=personal-brain >> "$($t.Log)" 2>&1
"@
$wrapperPath = "$ToolsRoot\memory-decay-wrapper.ps1"
Set-Content -Path $wrapperPath -Value $decayScript -Encoding utf8

$action2 = New-ScheduledTaskAction `
    -Execute 'pwsh.exe' `
    -Argument "-NonInteractive -File `"$wrapperPath`"" `
    -WorkingDirectory $ToolsRoot

$settings2 = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable:$false

if (Get-ScheduledTask -TaskName $t.Name -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $t.Name -Confirm:$false
}
Register-ScheduledTask `
    -TaskName $t.Name `
    -Description $t.Description `
    -Action $action2 `
    -Trigger $t.Trigger `
    -Settings $settings2 `
    -Principal $principal | Out-Null
Write-Host "Registered: $($t.Name) (Sunday 00:00)"

# ── Task 3: WeeklyTrustScores — Saturday 08:00 ───────────────────────────────
# Registered as of 2026-07-12: the "ESM/CJS bug" that previously blocked this task is gone.
$trustName = 'AgentSystem-WeeklyTrustScores'
$trustLog  = "$LogDir\trust-scores.log"
$action3 = New-ScheduledTaskAction `
    -Execute 'cmd.exe' `
    -Argument "/c `"`"$NodePath`" `"$ToolsRoot\compute-trust-scores.js`" >> `"$trustLog`" 2>&1`"" `
    -WorkingDirectory $ToolsRoot
$trigger3 = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Saturday -At '08:00'
$settings3 = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable:$false
if (Get-ScheduledTask -TaskName $trustName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $trustName -Confirm:$false
}
Register-ScheduledTask `
    -TaskName $trustName `
    -Description 'Aggregate agent-dispatch run logs into trust-scores.md' `
    -Action $action3 `
    -Trigger $trigger3 `
    -Settings $settings3 `
    -Principal $principal | Out-Null
Write-Host "Registered: $trustName (Saturday 08:00)"

# ── Task 4: WeeklyAgentReview — Saturday 09:00, headless via `claude --bg` ───
# routines.yml declares this cron routine but nothing registered it before 2026-07-12.
# `claude --bg` is daemon-managed and does not need an interactive terminal, so the
# fleet review CAN run headlessly (unlike daily-standup, which expects a live session).
$claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
if ($claudeCmd) {
    $reviewName = 'AgentSystem-WeeklyAgentReview'
    $reviewLog  = "$LogDir\agent-review.log"
    $reviewPrompt = 'Weekly agent fleet review: review routing-log.jsonl misroutes, session costs (node ~/dev/AgentSystem/tools/session-cost.js --week), open blockers, and goal scorecard. Log outcome via decision-log.js.'
    $action4 = New-ScheduledTaskAction `
        -Execute 'cmd.exe' `
        -Argument "/c `"`"$($claudeCmd.Source)`" --bg --agent jarvis `"$reviewPrompt`" >> `"$reviewLog`" 2>&1`"" `
        -WorkingDirectory (Split-Path $ToolsRoot -Parent)
    $trigger4 = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Saturday -At '09:00'
    $settings4 = New-ScheduledTaskSettingsSet `
        -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
        -StartWhenAvailable `
        -RunOnlyIfNetworkAvailable:$false
    if (Get-ScheduledTask -TaskName $reviewName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $reviewName -Confirm:$false
    }
    Register-ScheduledTask `
        -TaskName $reviewName `
        -Description 'Saturday agent fleet review (routing misroutes, costs, blockers) via headless Jarvis' `
        -Action $action4 `
        -Trigger $trigger4 `
        -Settings $settings4 `
        -Principal $principal | Out-Null
    Write-Host "Registered: $reviewName (Saturday 09:00)"
} else {
    Write-Host "Skipped: AgentSystem-WeeklyAgentReview (claude CLI not on PATH)"
}

# ── Task 5: EventDispatcherDrain — every 5 minutes ───────────────────────────
# Drains the durable event bus (~/agent-memory/nexus/events/) so queued triggers
# (e.g. spawns skipped by webhook-server's concurrency cap) retry instead of dying.
$drainName = 'AgentSystem-EventDispatcherDrain'
$drainLog  = "$LogDir\event-dispatcher.log"
$action5 = New-ScheduledTaskAction `
    -Execute 'cmd.exe' `
    -Argument "/c `"`"$NodePath`" `"$ToolsRoot\event-dispatcher.js`" --drain >> `"$drainLog`" 2>&1`"" `
    -WorkingDirectory $ToolsRoot
$trigger5 = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
    -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings5 = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable:$false
if (Get-ScheduledTask -TaskName $drainName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $drainName -Confirm:$false
}
Register-ScheduledTask `
    -TaskName $drainName `
    -Description 'Drain durable event bus (retries, dead-letter) every 5 minutes' `
    -Action $action5 `
    -Trigger $trigger5 `
    -Settings $settings5 `
    -Principal $principal | Out-Null
Write-Host "Registered: $drainName (every 5 minutes)"

Write-Host ""
Write-Host "Done. Tasks registered for current user ($env:USERNAME)."
Write-Host "Verify in Task Scheduler: taskschd.msc"
Write-Host "Log output: $LogDir\"
Write-Host ""
Write-Host "Skipped (requires manual fix):"
Write-Host "  - daily-standup: needs active claude session (cannot run headlessly)"
