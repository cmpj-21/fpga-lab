# Downloads the official Microsoft.Web.WebView2 NuGet package (~2 MB)
# and extracts ONLY WebView2.h and x64\WebView2Loader.dll into packaging\webview2\.
param(
  [string]$Version = '1.0.2903.40'
)
$ErrorActionPreference = 'Stop'
$dest = Join-Path $PSScriptRoot 'webview2'
$tmpZip = Join-Path $env:TEMP "Microsoft.Web.WebView2.$Version.zip"
$tmpDir = Join-Path $env:TEMP "webview2-extract-$Version"
$url = "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/$Version"

Write-Host "Downloading Microsoft.Web.WebView2 $Version (~2 MB)..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $url -OutFile $tmpZip -UseBasicParsing

if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir }
Expand-Archive -Path $tmpZip -DestinationPath $tmpDir -Force

if (!(Test-Path $dest)) { New-Item -ItemType Directory -Path $dest -Force | Out-Null }
Copy-Item (Join-Path $tmpDir 'build\native\include\WebView2.h') (Join-Path $dest 'WebView2.h') -Force
Copy-Item (Join-Path $tmpDir 'build\native\x64\WebView2Loader.dll') (Join-Path $dest 'WebView2Loader.dll') -Force

Remove-Item -Force $tmpZip -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue

Write-Host "WebView2 SDK ready in $dest" -ForegroundColor Green
Get-ChildItem $dest | Format-Table Name, Length -AutoSize
