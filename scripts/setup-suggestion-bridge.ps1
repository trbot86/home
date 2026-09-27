param([string]$Configuration = '.local/suggestion-bridge/config.json', [switch]$Start)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$configurationPath = [IO.Path]::GetFullPath((Join-Path $projectRoot $Configuration))
$localRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.local')) + [IO.Path]::DirectorySeparatorChar
if (!$configurationPath.StartsWith($localRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Bridge configuration must remain in ignored local storage.' }
$bridgeConfig = Get-Content -LiteralPath $configurationPath -Raw | ConvertFrom-Json
if ([IO.Path]::GetFullPath($bridgeConfig.repository) -ne [IO.Path]::GetFullPath($projectRoot)) { throw 'Bridge configuration belongs to another repository.' }
$shellExecutable = (Get-Command powershell.exe -ErrorAction Stop).Source
$bridgeScript = Join-Path $projectRoot 'scripts/run-suggestion-bridge.ps1'
$taskName = 'OurPlaceSuggestionBridge'
$taskAction = New-ScheduledTaskAction -Execute $shellExecutable -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $bridgeScript + '" -Configuration "' + $configurationPath + '"') -WorkingDirectory $projectRoot
$taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$taskPrincipal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger -Settings $taskSettings -Principal $taskPrincipal -Description 'Pull explicitly requested Our Place suggestion work and retain progress in the household app.' -Force | Out-Null
if ($Start) { Start-ScheduledTask -TaskName $taskName }
Write-Output 'Suggestion bridge task registered for the signed-in development user.'
