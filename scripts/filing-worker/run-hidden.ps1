param([Parameter(Mandatory=$true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$brokerPath = Join-Path $PSScriptRoot 'broker.mjs'
$configPath = Join-Path $projectRoot '.local/filing-worker/broker.json'
# Keep the scheduled task alive and propagate failure, without creating a visible
# Node console. Stopping the task also stops its process tree.
$worker = Start-Process -FilePath $NodePath -ArgumentList ('"' + $brokerPath + '" "' + $configPath + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -Wait
exit $worker.ExitCode
