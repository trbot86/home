param([string[]]$Tasks = @(':app:assembleDebug', ':app:testDebugUnitTest'), [string]$ServerOrigin)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$trialConfig = Join-Path $projectRoot '.local/phone-trial/host.json'
if (!$PSBoundParameters.ContainsKey('ServerOrigin') -and (Test-Path -LiteralPath $trialConfig)) {
    $trialHost = Get-Content -LiteralPath $trialConfig -Raw | ConvertFrom-Json
    if ([IO.Path]::GetFullPath($trialHost.workspace) -ne [IO.Path]::GetFullPath($projectRoot)) { throw 'Trial configuration belongs to another workspace.' }
    $ServerOrigin = $trialHost.origin
}
$serverBuildArguments = @()
if ($ServerOrigin) {
    $serverUri = [Uri]$ServerOrigin
    if (!$serverUri.IsAbsoluteUri -or $serverUri.Scheme -ne 'https' -or !$serverUri.Host -or $serverUri.UserInfo -or $serverUri.Query -or $serverUri.Fragment -or $serverUri.AbsolutePath -ne '/') { throw 'ServerOrigin must be an HTTPS origin without credentials, query or path.' }
    $ServerOrigin = $ServerOrigin.TrimEnd('/')
    $serverBuildArguments = @("-PhouseholdServerOrigin=$ServerOrigin")
    Write-Host "Default household server: $ServerOrigin"
}
$env:GRADLE_USER_HOME = Join-Path $projectRoot '.cache/gradle'
$projectSdk = Join-Path $projectRoot '.tools/android-sdk'
if (Test-Path -LiteralPath (Join-Path $projectSdk 'platforms/android-36')) { $env:ANDROID_HOME = $projectSdk }
if (!$env:ANDROID_HOME -or !(Test-Path -LiteralPath (Join-Path $env:ANDROID_HOME 'platforms/android-36'))) { throw 'Set ANDROID_HOME to an Android SDK with API36 installed.' }
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:ANDROID_SDK_HOME = Join-Path $projectRoot '.cache/android-home'
$env:ANDROID_USER_HOME = Join-Path $env:ANDROID_SDK_HOME '.android'
$projectJdk = Join-Path $projectRoot '.tools/temurin21'
$jdk = if (Test-Path -LiteralPath $projectJdk) { Get-ChildItem -LiteralPath $projectJdk -Directory | Select-Object -First 1 } else { $null }
if ($jdk) { $env:JAVA_HOME = $jdk.FullName }
if (!$env:JAVA_HOME -or !(Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin/java.exe'))) { throw 'Set JAVA_HOME to a JDK 21 installation.' }
& (Join-Path $projectRoot 'apps/android/gradlew.bat') -p (Join-Path $projectRoot 'apps/android') @Tasks @serverBuildArguments --no-daemon --console=plain
exit $LASTEXITCODE
