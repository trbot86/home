param([string]$Configuration = '.local/suggestion-bridge/config.json', [switch]$Start, [switch]$Restart)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$configurationPath = [IO.Path]::GetFullPath((Join-Path $projectRoot $Configuration))
$localRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.local')) + [IO.Path]::DirectorySeparatorChar
if (!$configurationPath.StartsWith($localRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Bridge configuration must remain in ignored local storage.' }
$bridgeConfig = Get-Content -LiteralPath $configurationPath -Raw | ConvertFrom-Json
if ([IO.Path]::GetFullPath($bridgeConfig.repository) -ne [IO.Path]::GetFullPath($projectRoot)) { throw 'Bridge configuration belongs to another repository.' }
$taskName = 'OurPlaceSuggestionBridge'
if ($Restart) {
    $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existingTask) { Stop-ScheduledTask -TaskName $taskName }
    # Task Scheduler can stop the PowerShell wrapper while its Node child survives.
    # Stop only the PID whose executable and full script/config arguments still match.
    $lockPath = Join-Path $bridgeConfig.stateRoot 'bridge.lock'
    if (Test-Path -LiteralPath $lockPath) {
        $bridgeLock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
        $bridgeProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$bridgeLock.pid)"
        if ($bridgeProcess) {
            $expectedScript = Join-Path $projectRoot 'scripts\suggestion-bridge.mjs'
            $argumentPattern = '(?:^|\s)"?' + [regex]::Escape($expectedScript) + '"?\s+"?' + [regex]::Escape($configurationPath) + '"?\s*$'
            if (!$bridgeConfig.nodeExecutable -or ![string]::Equals($bridgeProcess.ExecutablePath, $bridgeConfig.nodeExecutable, [StringComparison]::OrdinalIgnoreCase) -or $bridgeProcess.CommandLine -notmatch $argumentPattern) {
                throw 'Bridge lock PID does not match the expected worker. Inspect it before restarting.'
            }
            Stop-Process -Id $bridgeProcess.ProcessId -ErrorAction Stop
        }
    }
}
$bridgeConfig | Add-Member -NotePropertyName nodeExecutable -NotePropertyValue (Get-Command node -ErrorAction Stop).Source -Force
[IO.File]::WriteAllText($configurationPath, ($bridgeConfig | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
$shellExecutable = (Get-Command powershell.exe -ErrorAction Stop).Source
$bridgeScript = Join-Path $projectRoot 'scripts/run-suggestion-bridge.ps1'
$taskAction = New-ScheduledTaskAction -Execute $shellExecutable -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $bridgeScript + '" -Configuration "' + $configurationPath + '"') -WorkingDirectory $projectRoot
$taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$taskPrincipal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger -Settings $taskSettings -Principal $taskPrincipal -Description 'Pull explicitly requested Our Place suggestion work and retain progress in the household app.' -Force | Out-Null
if ($Start -or $Restart) { Start-ScheduledTask -TaskName $taskName }
Write-Output 'Suggestion bridge task registered for the signed-in development user.'
