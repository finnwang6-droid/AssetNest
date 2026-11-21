$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) { throw 'Run this script on Windows x64.' }
$taskNode = Get-Command node -ErrorAction SilentlyContinue
if (-not $taskNode) { throw 'Install Node.js 24+ from https://nodejs.org/ and run this script again.' }
& node -e "if(Number(process.versions.node.split('.')[0])<24||process.arch!=='x64')process.exit(1)"
if ($LASTEXITCODE -ne 0) { throw 'Node.js 24+ x64 is required.' }
& npm.cmd ci --omit=dev
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
& npm.cmd test
if ($LASTEXITCODE -ne 0) { throw 'Tests failed; no installer was built.' }
$taskRuntime = Join-Path (Get-Location) 'runtime/node.exe'
$taskExpected = ((Get-Content 'runtime/SHASUMS256.txt' | Where-Object { $_ -match ' win-x64/node.exe$' }) -split '\s+')[0]
if (-not (Test-Path -LiteralPath $taskRuntime)) {
    $taskPending = $taskRuntime + '.download'
    try {
        Invoke-WebRequest 'https://nodejs.org/dist/v24.19.0/win-x64/node.exe' -OutFile $taskPending
        if ((Get-FileHash -LiteralPath $taskPending -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskExpected) { throw 'Node runtime checksum mismatch.' }
        Move-Item -LiteralPath $taskPending -Destination $taskRuntime
    } finally { if (Test-Path -LiteralPath $taskPending) { Remove-Item -LiteralPath $taskPending } }
}
if ((Get-FileHash -LiteralPath $taskRuntime -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskExpected) { throw 'Node runtime checksum mismatch.' }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'tools/fetch-webview2-sdk.ps1'
if ($LASTEXITCODE -ne 0) { throw 'WebView2 SDK setup failed.' }
& node tools/build-desktop.mjs
if ($LASTEXITCODE -ne 0) { throw 'Windows build failed.' }
# Check the compiled launcher against a real Windows named event, without opening a library.
$taskSignal = [System.Threading.EventWaitHandle]::new($false, [System.Threading.EventResetMode]::AutoReset, 'Local\AssetNest.Show.41678')
try {
    $taskProbe = Start-Process -FilePath (Join-Path (Get-Location) 'test-output/desktop-build/AssetNest.exe') -ArgumentList '/show','/port=41678' -Wait -PassThru
    if ($taskProbe.ExitCode -ne 0 -or -not $taskSignal.WaitOne(1000)) { throw 'Compiled Windows launcher foreground signal check failed.' }
} finally { $taskSignal.Dispose() }
& node tools/package-release.mjs
if ($LASTEXITCODE -ne 0) { throw 'Release packaging failed.' }
Write-Output 'Build complete. Installers and browser extension ZIP are in releases/.'
