param([Parameter(Mandatory=$true)][string]$Configuration)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $projectRoot
$bridgeConfig = Get-Content -LiteralPath $Configuration -Raw | ConvertFrom-Json
$nodeExecutable = if ($bridgeConfig.nodeExecutable) { $bridgeConfig.nodeExecutable } else { (Get-Command node -ErrorAction Stop).Source }
& $nodeExecutable (Join-Path $PSScriptRoot 'suggestion-bridge.mjs') $Configuration
exit $LASTEXITCODE
