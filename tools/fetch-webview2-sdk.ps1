$ErrorActionPreference = 'Stop'
$taskSdkVersion = '1.0.4258.31'
$taskSdkHash = '56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9'
$taskWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskSdkRoot = Join-Path $taskWorkspace "desktop\webview2-sdk\$taskSdkVersion"
New-Item -ItemType Directory -Path $taskSdkRoot -Force | Out-Null
$taskPackage = Join-Path $taskSdkRoot "microsoft.web.webview2.$taskSdkVersion.nupkg"
if (-not (Test-Path -LiteralPath $taskPackage)) {
    Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$taskSdkVersion/microsoft.web.webview2.$taskSdkVersion.nupkg" -OutFile $taskPackage
}
if ((Get-FileHash -LiteralPath $taskPackage -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskSdkHash) { throw 'WebView2 SDK 校验值不符，已停止构建' }
$taskExpanded = Join-Path $taskSdkRoot 'package'
if (-not (Test-Path -LiteralPath $taskExpanded)) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($taskPackage, $taskExpanded)
}
Write-Output "WebView2 SDK $taskSdkVersion 已就绪：$taskSdkRoot"
