$taskPidFile = Join-Path $PSScriptRoot 'server.pid'
if (Test-Path -LiteralPath $taskPidFile) {
    $taskProcessId = [int](Get-Content -LiteralPath $taskPidFile)
    $taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$taskProcessId"
    if ($taskProcess -and $taskProcess.Name -eq 'node.exe' -and $taskProcess.CommandLine.Contains((Join-Path $PSScriptRoot 'server.mjs'))) { Stop-Process -Id $taskProcessId }
    Remove-Item -LiteralPath $taskPidFile
}
