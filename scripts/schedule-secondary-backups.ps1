$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$config = Get-Content -LiteralPath (Join-Path $projectRoot '.local/phone-trial/secondary-backup.json') -Raw | ConvertFrom-Json
$hostConfig = Get-Content -LiteralPath (Join-Path $projectRoot '.local/phone-trial/host.json') -Raw | ConvertFrom-Json
if ($config.installationId -ne $hostConfig.installationId -or [IO.Path]::GetFullPath($hostConfig.workspace) -ne [IO.Path]::GetFullPath($projectRoot)) { throw 'Foreign backup configuration' }
$description = "Our place secondary backups; installation=$($config.installationId); workspace=$projectRoot"
$existing = Get-ScheduledTask -TaskName $config.taskName -ErrorAction SilentlyContinue
if ($existing -and $existing.Description -ne $description) { throw 'Scheduled task belongs to something else' }
$nodePath = (Get-Command node).Source
$wrapper = Join-Path $PSScriptRoot 'run-secondary-backups.ps1'
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $wrapper + '" -NodePath "' + $nodePath + '"'
$action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe') -Argument $arguments -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Hours 1)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $config.taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $description -Force | Select-Object TaskName,State
Start-ScheduledTask -TaskName $config.taskName
