$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Push-Location $projectRoot
try {
    # A fixed name prevents duplicate login sessions. Never copy another Codex home.
    & docker compose -f ops/filing-worker/compose.yaml up -d --wait auth-egress network-guard
    if ($LASTEXITCODE -ne 0) { throw 'Worker network guard is not ready.' }
    & docker compose -f ops/filing-worker/compose.yaml run --rm --no-deps --name our-place-filing-login -T worker timeout --signal=TERM --kill-after=2s 900 codex -c 'cli_auth_credentials_store="file"' login --device-auth
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
