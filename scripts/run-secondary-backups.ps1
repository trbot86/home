param([Parameter(Mandatory = $true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $projectRoot
& $NodePath --import tsx scripts/replicate-backups.ts *>> (Join-Path $projectRoot '.local/phone-trial/secondary-backup.log')
exit $LASTEXITCODE
