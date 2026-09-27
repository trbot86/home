param([Parameter(Mandatory=$true)][string]$Configuration)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $projectRoot
& node (Join-Path $PSScriptRoot 'suggestion-bridge.mjs') $Configuration
exit $LASTEXITCODE
