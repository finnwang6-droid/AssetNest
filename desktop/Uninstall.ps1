$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath($PSScriptRoot)
$taskMarker=Join-Path $taskRoot 'assetnest-install.json'
if(-not (Test-Path -LiteralPath $taskMarker)){throw '缺少安装标记，停止卸载'}
Add-Type -AssemblyName System.Windows.Forms
if([System.Windows.Forms.MessageBox]::Show('卸载拾素材程序？素材库、连接配置与备份会保留。','拾素材卸载','YesNo') -ne 'Yes'){exit}
& (Join-Path $taskRoot 'AssetNest.exe') /stop
Start-Sleep -Milliseconds 800
$taskManifest=Get-Content -LiteralPath $taskMarker -Raw | ConvertFrom-Json
foreach($taskRelative in $taskManifest.files){if($taskRelative -eq 'assetnest-install.json'){continue};$taskFile=[IO.Path]::GetFullPath((Join-Path $taskRoot $taskRelative));if(-not $taskFile.StartsWith($taskRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw '安装文件路径越界'};if(Test-Path -LiteralPath $taskFile -PathType Leaf){Remove-Item -LiteralPath $taskFile}}
foreach($taskShortcut in @((Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) '拾素材.lnk'),(Join-Path ([Environment]::GetFolderPath('Programs')) '拾素材/拾素材.lnk'))){if(Test-Path -LiteralPath $taskShortcut){Remove-Item -LiteralPath $taskShortcut}}
Remove-Item -LiteralPath 'HKCU:SoftwareMicrosoftWindowsCurrentVersionUninstallAssetNest' -ErrorAction SilentlyContinue
[System.Windows.Forms.MessageBox]::Show('程序已卸载，素材与配置已保留。','拾素材') | Out-Null
