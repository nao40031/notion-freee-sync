param(
  [ValidateSet('plan','register','stop','resume')][string]$Mode = 'plan',
  [string]$TaskName = 'NotionFreeeSync',
  [string]$ProjectRoot,
  [string]$HostModule,
  [string]$At = '10:00',
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'

function Assert-SafeName([string]$Value) {
  if ($Value -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw 'task_name_invalid' }
}

Assert-SafeName $TaskName
if ($Mode -in @('plan','register')) {
  if (-not $ProjectRoot -or -not $HostModule) { throw 'project_root_and_host_module_required' }
  $root = (Resolve-Path -LiteralPath $ProjectRoot).Path
  $hostPath = (Resolve-Path -LiteralPath $HostModule).Path
  $entry = Join-Path $root 'scripts\run-configured-sync.mjs'
  if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'sync_entry_missing' }
  if (-not (Test-Path -LiteralPath $hostPath -PathType Leaf)) { throw 'host_module_missing' }
  if ($At -notmatch '^(?:[01]\d|2[0-3]):[0-5]\d$') { throw 'task_time_invalid' }
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $summary = [ordered]@{ task_name=$TaskName; user=$identity; schedule='weekdays'; at=$At; project_root=$root;
    node=$node; entry=$entry; host_module=$hostPath; multiple_instances='IgnoreNew'; start_when_available=$true;
    logon_mode='InteractiveToken'; register_enabled=$false; no_task_will_be_created=($Mode -eq 'plan' -or -not $Apply) }
  if ($Mode -eq 'plan' -or -not $Apply) { $summary | ConvertTo-Json -Depth 4; exit 0 }
}

if (-not $Apply) { throw 'apply_switch_required' }
switch ($Mode) {
  'register' {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) { throw 'task_already_exists_refusing_duplicate' }
    $arguments = '"{0}" --host-module "{1}"' -f $entry, $hostPath
    $action = New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory $root
    $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At ([datetime]::ParseExact($At,'HH:mm',$null))
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable
    $definition = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings
    $definition.Settings.Enabled = $false
    Register-ScheduledTask -TaskName $TaskName -InputObject $definition | Out-Null
    Disable-ScheduledTask -TaskName $TaskName | Out-Null
    Write-Output 'registered_disabled'
  }
  'stop' {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName }
    Disable-ScheduledTask -TaskName $TaskName | Out-Null
    Write-Output 'stopped_disabled'
  }
  'resume' {
    Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null
    Enable-ScheduledTask -TaskName $TaskName | Out-Null
    Write-Output 'resumed_enabled'
  }
  default { throw 'task_mode_invalid' }
}
