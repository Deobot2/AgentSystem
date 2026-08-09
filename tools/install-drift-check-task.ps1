<#
install-drift-check-task.ps1 -- the Windows half of the enforcement drift check (#322).

.github/workflows/enforcement-drift-check.yml runs the hook/agent/routine drift trio daily, but
only on `runs-on: [self-hosted, Linux]`. This Windows workstation's hooks/agents/routines drift is
therefore detected by nothing -- an --check tool nobody ever runs is the same as no tool at all.

Same job, same shape as tools/install-brain-sync-timer.ps1: a Windows Scheduled Task that runs one
command, `node tools/drift-check-run.js`, so the hooks/agents/routines checks, the alerting and the
per-host key all live in that one script, not duplicated in the scheduler.

ASCII only, deliberately, same as install-brain-sync-timer.ps1. This file has no BOM, and Windows
PowerShell 5.1 then decodes it as cp1252, where the three UTF-8 bytes of an em dash come out as
three characters, the last of which is a curly closing quote -- and PowerShell reads that as a
string delimiter. One em dash inside a Write-Output string is a parse error ("The string is missing
the terminator") pointing at a line that looks perfectly fine.

  .\tools\install-drift-check-task.ps1              install / update the task
  .\tools\install-drift-check-task.ps1 -DryRun      print what would be registered
  .\tools\install-drift-check-task.ps1 -Check       exit 1 if the task is missing or points elsewhere
  .\tools\install-drift-check-task.ps1 -Uninstall

Runs as the current user, at logon and then once a day. Same honest limitation as the brain-sync
timer: without a stored password a Scheduled Task only runs while that user is logged on. That is
acceptable here for the same reason -- this is the interactive workstation, not the unattended
Linux runner that already gets the real daily job via GitHub Actions cron.
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Check,
  [switch]$Uninstall,
  [int]$IntervalHours = 24
)

$ErrorActionPreference = 'Stop'

$TaskName  = 'AgentSystem-DriftCheck'
$RepoRoot  = Split-Path -Parent $PSScriptRoot
$Script    = Join-Path $RepoRoot 'tools\drift-check-run.js'
$NodeExe   = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodeExe) { Write-Error 'node is not on PATH -- install Node or fix PATH before registering a task that needs it.'; exit 2 }

# The task stores an absolute node path and an absolute script path. A task whose command resolves
# through PATH is a task that breaks the first time it runs under a different environment.
$Action    = New-ScheduledTaskAction -Execute $NodeExe -Argument "`"$Script`"" -WorkingDirectory $RepoRoot
# Repetition is set through the -RepetitionInterval parameter, not by assigning $t.Repetition.*
# afterwards: on PowerShell 5.1 the object New-ScheduledTaskTrigger returns has a null Repetition,
# so the assignment dies with "The property 'Interval' cannot be found on this object."
#
# A finite repetition duration is a silent expiry date: the task keeps existing, keeps looking
# healthy in Task Scheduler and in -Check, and simply stops firing on the day it runs out -- a host
# that quietly stops checking for drift, which is the exact outage #322 exists to end.
#
# "Indefinitely" is an *absent* <Duration> in the task XML, not a huge one.
# `-RepetitionDuration ([TimeSpan]::MaxValue)` is the advice you find everywhere and it does not
# work here: it serialises to P99999999DT23H59M59S and Task Scheduler rejects the whole
# registration with "The task XML contains a value which is incorrectly formatted or out of range".
# So the trigger is built with a placeholder duration and the field is then cleared, which is what
# drops the element.
$Repeating = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) `
    -RepetitionInterval (New-TimeSpan -Hours $IntervalHours) `
    -RepetitionDuration (New-TimeSpan -Days 2)
$Repeating.Repetition.Duration = ''
$Repeating.Repetition.StopAtDurationEnd = $false
#
# The logon trigger is scoped to this user. A bare `-AtLogOn` means "at logon of ANY user", which is
# a machine-wide task, and registering one needs an elevated shell -- Register-ScheduledTask fails
# the whole call with a bare "Access is denied" that says nothing about which trigger caused it. The
# brain-sync timer uses the same per-user scoping, for the same reason.
$Triggers  = @($(New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"), $Repeating)
$Settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
              -MultipleInstances IgnoreNew

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($Uninstall) {
  if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; Write-Output "removed $TaskName" }
  else { Write-Output "not installed: $TaskName" }
  exit 0
}

if ($DryRun) {
  Write-Output "would register scheduled task: $TaskName"
  Write-Output "  command : `"$NodeExe`" `"$Script`""
  Write-Output "  workdir : $RepoRoot"
  Write-Output "  triggers: at logon, then every $IntervalHours hours"
  Write-Output "  present : $(if ($existing) { 'yes (would be replaced)' } else { 'no' })"
  exit 0
}

if ($Check) {
  # Existence is not the check. A task registered last month against a moved checkout still shows up
  # as healthy in Task Scheduler and has been running the wrong script the whole time -- the same
  # installed-but-inert shape the hook --check exists to catch.
  if (-not $existing) { Write-Output "missing    $TaskName"; exit 1 }
  # Checked by meaning, not by string-equality with the path this run would register: the checkout
  # can legitimately live somewhere else than the copy running this script (a worktree, a second
  # clone), and a check that is red on a healthy host gets muted. What must hold is that it runs
  # node against a drift-check-run.js that still exists.
  $cmd = ($existing.Actions | Select-Object -First 1)
  $target = ([regex]::Match($cmd.Arguments, '"([^"]*drift-check-run\.js)"')).Groups[1].Value
  $exeOk  = $cmd.Execute -like '*node*'
  if (-not $exeOk -or -not $target -or -not (Test-Path $target)) {
    Write-Output "drift      $TaskName runs: $($cmd.Execute) $($cmd.Arguments)"
    Write-Output "           that script is not on disk -- the checkout moved or was deleted"
    exit 1
  }
  # Liveness, not just wiring. A task can be correctly registered, point at the right script, and
  # still be dead: disabled by a person, failing on every run, or never firing because its trigger
  # expired. Printing LastTaskResult and exiting 0 regardless is a green check that means nothing --
  # the same false-green this whole exercise is about. So the run history is evaluated, and drift
  # exits 1.
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  $result = $info.LastTaskResult
  $lastRun = $info.LastRunTime

  if ($existing.State -eq 'Disabled') {
    Write-Output "drift      $TaskName is Disabled -- registered but never fires"
    exit 1
  }

  # 0 = clean. 1 = drift-check-run.js found drift and raised a human-needed alert -- that is the
  # check working as designed, not a broken task, same convention as the brain-sync timer's 0/3.
  $neverRan = ($null -eq $lastRun) -or ($lastRun -lt (Get-Date '1980-01-01')) -or ($result -eq 267011)

  if (-not $neverRan -and $result -notin @(0, 1)) {
    Write-Output "drift      $TaskName last run failed (result $result at $lastRun)"
    Write-Output "           run it by hand to see why: `"$NodeExe`" `"$Script`""
    exit 1
  }

  # Two intervals of slack: one missed firing is a laptop that was asleep, but nothing at all in
  # twice the period means the trigger is not firing any more. The task registered before its first
  # run is exempt.
  $staleAfter = (Get-Date).AddHours(-2 * $IntervalHours)
  if (-not $neverRan -and $lastRun -lt $staleAfter) {
    Write-Output "drift      $TaskName has not run since $lastRun (interval is $IntervalHours hours)"
    exit 1
  }

  Write-Output "in sync    $TaskName"
  if ($neverRan) { Write-Output "last       never run yet (registered, waiting for its first trigger)" }
  else { Write-Output "last       $lastRun (result $result)" }
  exit 0
}

if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
# -ErrorAction Stop, and the success line only after it returns. Register-ScheduledTask reports a
# rejected task XML as a non-terminating error, so without this the script printed
# "installed: AgentSystem-DriftCheck" over the top of a registration that had just failed, and
# exited 0. An installer that says it installed something it did not is the same false green the
# -Check work above is about, one step earlier in the chain.
try {
  Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Triggers -Settings $Settings `
    -Description 'Enforcement drift check (hooks/agents/routines) on this workstation (see #322)' -ErrorAction Stop | Out-Null
} catch {
  Write-Output "failed to register $TaskName : $($_.Exception.Message)"
  exit 1
}
Write-Output "installed: $TaskName (every $IntervalHours hours)"
Get-ScheduledTaskInfo -TaskName $TaskName | Format-List TaskName, NextRunTime, LastRunTime, LastTaskResult
