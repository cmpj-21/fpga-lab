# Master Windows Release Builder for Trace FPGA Workbench
# Produces:
#   1. dist\Trace\                                      (staged self-contained app directory)
#   2. dist\Trace-FPGA-Workbench-Portable-x64.zip       (portable folder ZIP)
#   3. dist\Trace-FPGA-Workbench-Portable-x64.exe       (single-file cached portable EXE)
#   4. dist\Trace-FPGA-Workbench-Setup-x64.exe          (Windows installer, if Inno Setup ISCC.exe is installed)
param(
  [string]$Version = '1.0.0',
  [string]$MsysBin = 'C:\msys64\ucrt64\bin',
  [switch]$SkipInstaller
)
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$pkgDir   = $PSScriptRoot
$nativeDir = Join-Path $pkgDir 'native'
$wv2Dir   = Join-Path $pkgDir 'webview2'
$buildDir = Join-Path $pkgDir 'build'
$distDir  = Join-Path $repoRoot 'dist'
$stageDir = Join-Path $distDir 'Trace'

Write-Host "=== Trace FPGA Workbench Release Builder v$Version ===" -ForegroundColor Cyan

# 0. Stop any lingering Trace / portable / WebView2 processes holding locks before rebuilding
$lockProcs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  ($_.Name -eq 'Trace.exe') -or
  ($_.Name -like 'Trace-FPGA-Workbench*.exe') -or
  ($_.Name -eq 'conpty_host.exe') -or
  (($_.Name -eq 'node.exe' -or $_.Name -eq 'msedgewebview2.exe') -and (
    ($_.ExecutablePath -like '*TraceFPGA*') -or
    ($_.CommandLine -like '*TraceFPGA*') -or
    ($_.CommandLine -like "*$distDir*") -or
    ($_.CommandLine -like '*TraceData\\webview2*') -or
    ($_.CommandLine -like '*--webview-exe-name=Trace.exe*')
  ))
}
if ($lockProcs) {
  Write-Host "Stopping lingering Trace background processes ($($lockProcs.Count))..." -ForegroundColor Yellow
  foreach ($lp in $lockProcs) {
    Stop-Process -Id $lp.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 350
}

# Clear stale WebView2 HTTP/JS cache so rebuilt assets take effect immediately (preserves LocalStorage & app state)
foreach ($staleCache in @(
  (Join-Path $distDir 'TraceData\webview2\EBWebView\Default\Cache'),
  (Join-Path $distDir 'TraceData\webview2\EBWebView\Default\Code Cache')
)) {
  if (Test-Path $staleCache) {
    Remove-Item -Recurse -Force $staleCache -ErrorAction SilentlyContinue
  }
}

# 1. Verify required local tools
$gpp     = Join-Path $MsysBin 'g++.exe'
$gcc     = Join-Path $MsysBin 'gcc.exe'
$windres = Join-Path $MsysBin 'windres.exe'
$sysTar  = Join-Path $env:SystemRoot 'System32\tar.exe'

foreach ($tool in @($gpp, $gcc, $windres, $sysTar)) {
  if (!(Test-Path $tool)) { throw "Required build tool not found: $tool" }
}

$wv2Header = Join-Path $wv2Dir 'WebView2.h'
$wv2Dll    = Join-Path $wv2Dir 'WebView2Loader.dll'
if (!(Test-Path $wv2Header) -or !(Test-Path $wv2Dll)) {
  throw "WebView2 SDK files missing in $wv2Dir. Run: powershell -ExecutionPolicy Bypass -File `"$pkgDir\fetch-webview2.ps1`""
}

$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if (!$nodeCmd) { throw "node.exe not found on PATH." }
$nodeExe = $nodeCmd.Source

$ghdlCmd = Get-Command ghdl.exe -ErrorAction SilentlyContinue
if (!$ghdlCmd -and (Test-Path (Join-Path $MsysBin 'ghdl.exe'))) {
  $ghdlExe = Join-Path $MsysBin 'ghdl.exe'
} elseif ($ghdlCmd) {
  $ghdlExe = $ghdlCmd.Source
} else {
  throw "ghdl.exe not found on PATH or in $MsysBin."
}
$ghdlBinDir = Split-Path -Parent $ghdlExe
$ghdlPrefix = Resolve-Path (Join-Path $ghdlBinDir '..\lib\ghdl') -ErrorAction SilentlyContinue
if (!$ghdlPrefix) { throw "Could not find GHDL standard library directory near $ghdlBinDir\..\lib\ghdl" }

Write-Host "  Node.js : $nodeExe"
Write-Host "  GHDL    : $ghdlExe"
Write-Host "  GHDL Lib: $ghdlPrefix"
Write-Host "  Compiler: $gpp"

# 2. Generate app icon if missing
$icoPath = Join-Path $nativeDir 'trace.ico'
if (!(Test-Path $icoPath)) {
  & (Join-Path $pkgDir 'make-icon.ps1') -OutPath $icoPath
}

# 3. Prepare build directory
New-Item -ItemType Directory -Path $buildDir -Force | Out-Null

# 4. Pre-compile backend bridge-<hash>.vpi against this exact GHDL version
Write-Host "Pre-compiling GHDL VPI bridge plugin..." -ForegroundColor Cyan
$ghdlVersion = (& $ghdlExe --version | Select-Object -First 1).Trim()
$vpiInclude  = (& $ghdlExe --vpi-include-dir).Trim()
$vpiLib      = (& $ghdlExe --vpi-library-dir).Trim()
$bridgeSrc   = Join-Path $repoRoot 'backend\bridge.c'
$sha = [System.Security.Cryptography.SHA256]::Create()
$srcBytes = [System.IO.File]::ReadAllBytes($bridgeSrc)
$verBytes = [System.Text.Encoding]::UTF8.GetBytes($ghdlVersion)
$combined = New-Object byte[] ($srcBytes.Length + $verBytes.Length)
[Buffer]::BlockCopy($srcBytes, 0, $combined, 0, $srcBytes.Length)
[Buffer]::BlockCopy($verBytes, 0, $combined, $srcBytes.Length, $verBytes.Length)
$hashHex = ([BitConverter]::ToString($sha.ComputeHash($combined)) -replace '-', '').ToLower().Substring(0, 16)
$vpiOut = Join-Path $buildDir "bridge-$hashHex.vpi"

Write-Host "  VPI include: $vpiInclude"
Write-Host "  VPI library: $vpiLib"
$vpiStdout = Join-Path $buildDir 'vpi-build.stdout'
$vpiStderr = Join-Path $buildDir 'vpi-build.stderr'
$gccArgs = @(
  '-shared', '-O2', '-Wall',
  ('-I"{0}"' -f $vpiInclude),
  ('"{0}"' -f $bridgeSrc),
  ('-L"{0}"' -f $vpiLib),
  '-lghdlvpi', '-o', ('"{0}"' -f $vpiOut)
) -join ' '
$gccProc = Start-Process -FilePath $gcc -ArgumentList $gccArgs -NoNewWindow -Wait -PassThru -RedirectStandardOutput $vpiStdout -RedirectStandardError $vpiStderr
$gccExit = $gccProc.ExitCode
if (Test-Path $vpiStdout) { Get-Content $vpiStdout | ForEach-Object { Write-Host $_ } }
if (Test-Path $vpiStderr) { Get-Content $vpiStderr | ForEach-Object { Write-Host $_ } }
Write-Host "  GCC exit code: $gccExit"
if ($gccExit -ne 0) { throw "Failed to compile $vpiOut" }
Write-Host "  Built VPI plugin: $(Split-Path -Leaf $vpiOut)" -ForegroundColor Green

# 5. Compile Win32 resources + native Trace.exe + portable_stub.exe
Write-Host "Compiling native Windows executables..." -ForegroundColor Cyan
$verParts = @($Version -split '\.' | ForEach-Object { if ($_ -match '^\d+') { [int]$matches[0] } else { 0 } })
$verMajor = if ($verParts.Count -ge 1) { $verParts[0] } else { 1 }
$verMinor = if ($verParts.Count -ge 2) { $verParts[1] } else { 0 }
$verPatch = if ($verParts.Count -ge 3) { $verParts[2] } else { 0 }
$resObj = Join-Path $buildDir 'trace.res'
& $windres "-DTRACE_VER_MAJOR=$verMajor" "-DTRACE_VER_MINOR=$verMinor" "-DTRACE_VER_PATCH=$verPatch" -I $nativeDir (Join-Path $nativeDir 'trace.rc') -O coff -o $resObj
if ($LASTEXITCODE -ne 0) { throw "windres failed" }

$traceExe = Join-Path $buildDir 'Trace.exe'
& $gpp -O2 -std=c++17 -municode -mwindows `
  "-I$wv2Dir" "-I$buildDir" `
  (Join-Path $nativeDir 'main.cpp') $resObj `
  -static-libgcc -static-libstdc++ "-Wl,-Bstatic" -lwinpthread "-Wl,-Bdynamic" `
  -lole32 -lshell32 -ldwmapi -luser32 -lgdi32 -luuid `
  -o $traceExe
if ($LASTEXITCODE -ne 0) { throw "Failed to compile Trace.exe" }

$stubExe = Join-Path $buildDir 'portable_stub.exe'
& $gpp -O2 -std=c++17 -municode -mwindows `
  (Join-Path $nativeDir 'portable_stub.cpp') $resObj `
  -static-libgcc -static-libstdc++ "-Wl,-Bstatic" -lwinpthread "-Wl,-Bdynamic" `
  -lole32 -lshell32 -ldwmapi -luser32 -lgdi32 -luuid `
  -o $stubExe
if ($LASTEXITCODE -ne 0) { throw "Failed to compile portable_stub.exe" }

$conptyExe = Join-Path $buildDir 'conpty_host.exe'
& $gpp -O2 -std=c++17 -municode -mwindows `
  (Join-Path $nativeDir 'conpty_host.cpp') `
  -static-libgcc -static-libstdc++ "-Wl,-Bstatic" -lwinpthread "-Wl,-Bdynamic" `
  -lkernel32 -lshell32 `
  -o $conptyExe
if ($LASTEXITCODE -ne 0) { throw "Failed to compile conpty_host.exe" }
Copy-Item $conptyExe (Join-Path $repoRoot 'backend\conpty_host.exe') -Force

Write-Host "  Compiled Trace.exe ($([math]::Round((Get-Item $traceExe).Length / 1KB, 1)) KB)" -ForegroundColor Green
Write-Host "  Compiled portable_stub.exe ($([math]::Round((Get-Item $stubExe).Length / 1KB, 1)) KB)" -ForegroundColor Green
Write-Host "  Compiled conpty_host.exe ($([math]::Round((Get-Item $conptyExe).Length / 1KB, 1)) KB)" -ForegroundColor Green

# 6. Stage complete self-contained directory (dist\Trace\)
Write-Host "Staging self-contained release folder: $stageDir" -ForegroundColor Cyan
if (Test-Path $stageDir) { Remove-Item -Recurse -Force $stageDir }
New-Item -ItemType Directory -Path (Join-Path $stageDir 'app\backend') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stageDir 'runtime\node') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stageDir 'runtime\ghdl\bin') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stageDir 'runtime\ghdl\lib') -Force | Out-Null

# Top-level native binaries
Copy-Item $traceExe (Join-Path $stageDir 'Trace.exe') -Force
Copy-Item $wv2Dll   (Join-Path $stageDir 'WebView2Loader.dll') -Force
Set-Content -Path (Join-Path $stageDir 'portable.mode') -Value "Portable data mode enabled (user data stored in TraceData\ beside Trace.exe)." -Encoding ASCII

# App code + all public assets (Three.js, GLB models, CSS, JS)
Copy-Item (Join-Path $repoRoot 'server.mjs') (Join-Path $stageDir 'app\server.mjs') -Force
if (Test-Path (Join-Path $repoRoot 'TUTORIAL.md')) {
  Copy-Item (Join-Path $repoRoot 'TUTORIAL.md') (Join-Path $stageDir 'app\TUTORIAL.md') -Force
}
Copy-Item (Join-Path $repoRoot 'backend\engine.mjs') (Join-Path $stageDir 'app\backend\engine.mjs') -Force
Copy-Item (Join-Path $repoRoot 'backend\rtlCompiler.mjs') (Join-Path $stageDir 'app\backend\rtlCompiler.mjs') -Force
Copy-Item (Join-Path $repoRoot 'backend\vhdlLint.mjs') (Join-Path $stageDir 'app\backend\vhdlLint.mjs') -Force
Copy-Item (Join-Path $repoRoot 'backend\updater.mjs') (Join-Path $stageDir 'app\backend\updater.mjs') -Force
[System.IO.File]::WriteAllText((Join-Path $stageDir 'app\version.json'), (@{ version = $Version; repo = 'cmpj-21/fpga-lab' } | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
Copy-Item $conptyExe (Join-Path $stageDir 'app\backend\conpty_host.exe') -Force
Copy-Item $bridgeSrc (Join-Path $stageDir 'app\backend\bridge.c') -Force
Copy-Item $vpiOut (Join-Path $stageDir "app\backend\$(Split-Path -Leaf $vpiOut)") -Force
Copy-Item (Join-Path $repoRoot 'public') (Join-Path $stageDir 'app\public') -Recurse -Force

# Portable Node.js binary
Copy-Item $nodeExe (Join-Path $stageDir 'runtime\node\node.exe') -Force

# Portable GHDL binary (+ any companion ghdl1-*.exe) + IEEE/VITAL libraries + auto-discovered non-Windows DLL dependencies
$stageGhdlBin = Join-Path $stageDir 'runtime\ghdl\bin'
Copy-Item $ghdlExe (Join-Path $stageGhdlBin 'ghdl.exe') -Force
foreach ($extraGhdl in (Get-ChildItem -Path $ghdlBinDir -Filter 'ghdl*.exe' -ErrorAction SilentlyContinue)) {
  Copy-Item $extraGhdl.FullName (Join-Path $stageGhdlBin $extraGhdl.Name) -Force
}
Copy-Item $ghdlPrefix.Path (Join-Path $stageDir 'runtime\ghdl\lib\ghdl') -Recurse -Force

# Collect only GHDL-owned DLLs + transitive non-Windows DLLs imported by ghdl*.exe / bridge.vpi
$dllCandidates = New-Object System.Collections.Generic.HashSet[string]([System.StringComparer]::OrdinalIgnoreCase)
foreach ($dir in @($ghdlBinDir, $vpiLib)) {
  if (Test-Path $dir) {
    foreach ($pat in @('libghdl*.dll', '*ghdlvpi*.dll')) {
      foreach ($d in (Get-ChildItem -Path $dir -Filter $pat -ErrorAction SilentlyContinue)) {
        [void]$dllCandidates.Add($d.FullName)
      }
    }
  }
}

$objdump = Join-Path $MsysBin 'objdump.exe'
$searchDirs = @($ghdlBinDir, $vpiLib, $MsysBin) | Where-Object { Test-Path $_ } | Select-Object -Unique
if (Test-Path $objdump) {
  $queue = New-Object System.Collections.Generic.Queue[string]
  $visited = New-Object System.Collections.Generic.HashSet[string]([System.StringComparer]::OrdinalIgnoreCase)
  $extraGhdlExes = @(Get-ChildItem -Path $ghdlBinDir -Filter 'ghdl*.exe' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
  foreach ($seed in (@($ghdlExe, $vpiOut) + $extraGhdlExes + @($dllCandidates))) {
    if ($seed -and (Test-Path $seed) -and $visited.Add($seed)) { $queue.Enqueue($seed) }
  }
  while ($queue.Count -gt 0) {
    $cur = $queue.Dequeue()
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $outLines = & $objdump -p $cur 2>$null
    $ErrorActionPreference = $prevEap
    foreach ($line in $outLines) {
      if ($line -match '^\s*DLL Name:\s+(\S+)') {
        $dllName = $matches[1].Trim()
        $sysPath = Join-Path $env:SystemRoot "System32\$dllName"
        if (Test-Path $sysPath) { continue }
        foreach ($sd in $searchDirs) {
          $found = Join-Path $sd $dllName
          if (Test-Path $found) {
            [void]$dllCandidates.Add($found)
            if ($visited.Add($found)) { $queue.Enqueue($found) }
            break
          }
        }
      }
    }
  }
}

foreach ($dll in $dllCandidates) {
  Copy-Item $dll (Join-Path $stageGhdlBin (Split-Path -Leaf $dll)) -Force
}
Write-Host "  Bundled $($dllCandidates.Count) GHDL runtime DLL(s)" -ForegroundColor Green

# 7. Package Portable Folder ZIP (using Windows System32 bsdtar, never MSYS2/Git GNU tar)
$zipOut = Join-Path $distDir "Trace-FPGA-Workbench-Portable-x64.zip"
if (Test-Path $zipOut) { Remove-Item -Force $zipOut }
Write-Host "Creating Portable ZIP: $zipOut" -ForegroundColor Cyan
Push-Location $stageDir
try {
  & $sysTar -a -c -f $zipOut *
  if ($LASTEXITCODE -ne 0) { throw "System32 tar.exe failed creating $zipOut" }
} finally {
  Pop-Location
}
$zipSizeMB = [math]::Round((Get-Item $zipOut).Length / 1MB, 2)
Write-Host "  Created Portable ZIP ($zipSizeMB MB)" -ForegroundColor Green

# 8. Package Single-File Portable EXE (stub + zip + 32-byte TRCPORT1 trailer)
$portableExeOut = Join-Path $distDir "Trace-FPGA-Workbench-Portable-x64.exe"
if (Test-Path $portableExeOut) { Remove-Item -Force $portableExeOut }
Write-Host "Creating Single-File Portable EXE: $portableExeOut" -ForegroundColor Cyan

$zipHash = (Get-FileHash -Path $zipOut -Algorithm SHA256).Hash.ToLower().Substring(0, 8)
$stubLen = [uint64](Get-Item $stubExe).Length
$zipLen  = [uint64](Get-Item $zipOut).Length

$outFs = [System.IO.File]::Open($portableExeOut, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
try {
  $stubFs = [System.IO.File]::OpenRead($stubExe)
  try { $stubFs.CopyTo($outFs) } finally { $stubFs.Dispose() }

  $zipFs = [System.IO.File]::OpenRead($zipOut)
  try { $zipFs.CopyTo($outFs) } finally { $zipFs.Dispose() }

  $bw = New-Object System.IO.BinaryWriter($outFs)
  $bw.Write([System.Text.Encoding]::ASCII.GetBytes('TRCPORT1'))
  $bw.Write($stubLen)
  $bw.Write($zipLen)
  $bw.Write([System.Text.Encoding]::ASCII.GetBytes($zipHash))
  $bw.Flush()
} finally {
  $outFs.Dispose()
}
$portSizeMB = [math]::Round((Get-Item $portableExeOut).Length / 1MB, 2)
Write-Host "  Created Single-File Portable EXE ($portSizeMB MB, cache tag: $zipHash)" -ForegroundColor Green

# 9. Build Windows Installer EXE via Inno Setup (optional if installed)
if (!$SkipInstaller) {
  $isccCandidates = @(
    'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
    'C:\Program Files\Inno Setup 6\ISCC.exe'
  )
  $iscc = $isccCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (!$iscc) {
    $cmd = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($cmd) { $iscc = $cmd.Source }
  }
  if ($iscc) {
    Write-Host "Building Windows Installer with Inno Setup..." -ForegroundColor Cyan
    & $iscc "/DMyAppVersion=$Version" (Join-Path $pkgDir 'trace.iss')
    if ($LASTEXITCODE -ne 0) { throw "Inno Setup compilation failed." }
    $setupOut = Join-Path $distDir 'Trace-FPGA-Workbench-Setup-x64.exe'
    if (Test-Path $setupOut) {
      Write-Host "  Created Installer EXE ($([math]::Round((Get-Item $setupOut).Length / 1MB, 2)) MB)" -ForegroundColor Green
    }
  } else {
    Write-Host "Inno Setup 6 (ISCC.exe) not found — skipped installer .exe." -ForegroundColor Yellow
    Write-Host "  To also build the Setup installer, install Inno Setup 6 (~5 MB) and run:" -ForegroundColor Yellow
    Write-Host "  ISCC.exe /DMyAppVersion=$Version `"$pkgDir\trace.iss`"" -ForegroundColor Yellow
  }
}

Write-Host "`nRelease build complete! Outputs in: $distDir" -ForegroundColor Green
Get-ChildItem $distDir -File | Format-Table Name, @{N='Size (MB)';E={[math]::Round($_.Length/1MB,2)}} -AutoSize
