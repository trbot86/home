param([Parameter(Mandatory=$true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$brokerPath = Join-Path $PSScriptRoot 'broker.mjs'
$configPath = Join-Path $projectRoot '.local/filing-worker/broker.json'
# Prevent console allocation, rather than creating a console and hiding it.
# Keep the task alive for the lifetime of the broker and propagate its exit code.
$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $NodePath
$startInfo.Arguments = ('"' + $brokerPath + '" "' + $configPath + '" --supervised')
$startInfo.WorkingDirectory = $projectRoot
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
# Closing the parent closes this pipe, so stopping the task cannot orphan Node.
$startInfo.RedirectStandardInput = $true
$parentId = (Get-CimInstance Win32_Process -Filter "ProcessId = $PID").ParentProcessId
$parentProcess = Get-Process -Id $parentId -ErrorAction Stop
$worker = [System.Diagnostics.Process]::Start($startInfo)
while (-not $worker.WaitForExit(1000)) {
    # Task Scheduler may stop only conhost. Close the broker's lifetime pipe
    # when that parent exits, then terminate this remaining wrapper as well.
    if ($parentProcess.HasExited) {
        $worker.StandardInput.Close()
        if (-not $worker.WaitForExit(5000)) { $worker.Kill(); $worker.WaitForExit() }
        break
    }
}
exit $worker.ExitCode
