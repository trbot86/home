param([switch]$Start)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$localRoot = Join-Path $projectRoot '.local/filing-worker'
$clientRoot = Join-Path $localRoot 'client'
New-Item -ItemType Directory -Path $clientRoot -Force | Out-Null
$configPath = Join-Path $localRoot 'broker.json'
if (Test-Path -LiteralPath $configPath) {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($config.repository -ne $projectRoot) { throw 'Broker belongs to another repository.' }
} else {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
    $config = [pscustomobject]@{repository=$projectRoot;docker=(Get-Command docker).Source;port=3178;token=$token}
    [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
}
$client = @{url=('http://host.docker.internal:' + $config.port + '/filing');token=$config.token}
$provider = @{launcher='/app/apps/server/filing-client.mjs';workingDirectory='/tmp';model='gpt-5.6-luna';effort='low';isolationReviewed=$true}
[IO.File]::WriteAllText((Join-Path $clientRoot 'client.json'), ($client | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $clientRoot 'provider.json'), ($provider | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$nodePath = (Get-Command node).Source
$launcher = Join-Path $PSScriptRoot 'run-hidden.ps1'
$scriptHost = Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
$action = New-ScheduledTaskAction -Execute $scriptHost -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launcher + '" -NodePath "' + $nodePath + '"') -WorkingDirectory $projectRoot
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'OurPlaceFilingWorker' -Action $action -Settings $settings -Trigger $trigger -Principal $principal -Description 'Run bounded isolated household filing jobs; no household database access.' -Force | Out-Null
if ($Start) { Start-ScheduledTask -TaskName 'OurPlaceFilingWorker' }
Write-Output 'Filing broker prepared. App activation remains a separate reviewed deployment step.'
