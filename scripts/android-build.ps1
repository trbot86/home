param([string[]]$Tasks = @(':app:assembleDebug', ':app:testDebugUnitTest'), [string]$ServerOrigin, [string]$SourceRoot)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$buildRoot = if ($SourceRoot) { [IO.Path]::GetFullPath($SourceRoot) } else { $projectRoot }
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
& (Join-Path $buildRoot 'apps/android/gradlew.bat') -p (Join-Path $buildRoot 'apps/android') @Tasks @serverBuildArguments --no-daemon --console=plain
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
# Release checkouts must update existing phone installations without changing their signer.
if ($SourceRoot) {
    $publishedApk = Join-Path $projectRoot '.local/phone-trial/install/our-place-debug.apk'
    $builtApk = Join-Path $buildRoot 'apps/android/app/build/outputs/apk/debug/app-debug.apk'
    $buildTools = Get-ChildItem -LiteralPath (Join-Path $env:ANDROID_HOME 'build-tools') -Directory | Sort-Object Name -Descending | Select-Object -First 1
    $signer = Join-Path $buildTools.FullName 'lib/apksigner.jar'
    $java = Join-Path $env:JAVA_HOME 'bin/java.exe'
    function Read-SignerDigest([string]$Apk) {
        $certificate = & $java -jar $signer verify --print-certs $Apk
        if ($LASTEXITCODE -ne 0) { throw 'Android package signature verification failed.' }
        $digest = @($certificate | Select-String -Pattern '^Signer #1 certificate SHA-256 digest: [a-f0-9]+$')
        if ($digest.Count -ne 1) { throw 'Expected one verified Android signing identity.' }
        return $digest[0].Line
    }
    $builtSigner = Read-SignerDigest $builtApk
    if (!(Test-Path -LiteralPath $publishedApk) -or $builtSigner -ne (Read-SignerDigest $publishedApk)) { throw 'Release APK does not match the currently published signing identity.' }
    Write-Host 'Android update signing identity verified.'
}
exit $LASTEXITCODE
