$ErrorActionPreference = 'Stop'
$taskNode = Join-Path $PSScriptRoot 'runtime/node.exe'
if (-not (Test-Path -LiteralPath $taskNode)) { $taskNode = (Get-Command node -ErrorAction Stop).Source }
$taskUrl = 'http://127.0.0.1:41600'
$taskRunning = $false
try { $taskHealth = Invoke-RestMethod "$taskUrl/api/health" -TimeoutSec 2; $taskRunning = $taskHealth.name -eq 'AssetNest' } catch {}
if (-not $taskRunning) {
    $env:ASSETNEST_REQUIRE_LOCATION = '1'
    $taskProcess = Start-Process -FilePath $taskNode -ArgumentList ('"' + (Join-Path $PSScriptRoot 'server.mjs') + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'server.log') -RedirectStandardError (Join-Path $PSScriptRoot 'server-error.log') -PassThru
    $taskProcess.Id | Set-Content (Join-Path $PSScriptRoot 'server.pid')
    for ($taskAttempt = 0; $taskAttempt -lt 30; $taskAttempt++) {
        Start-Sleep -Milliseconds 200
        try { $taskHealth = Invoke-RestMethod "$taskUrl/api/health" -TimeoutSec 1; if ($taskHealth.name -eq 'AssetNest') { $taskRunning = $true; break } } catch {}
    }
}
if (-not $taskRunning) { throw '拾素材启动失败，请查看 server-error.log' }
$taskEdge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (Test-Path -LiteralPath $taskEdge) { Start-Process -FilePath $taskEdge -ArgumentList "--app=$taskUrl" } else { Start-Process $taskUrl }
