# Building Native Windows Releases for Trace FPGA Workbench

This packaging suite compiles Trace into a self-contained native Windows 64-bit desktop application (`Trace.exe` powered by Win32 + Microsoft Edge WebView2) bundling Node.js, portable GHDL + IEEE/VITAL libraries, the pre-compiled VPI bridge, Three.js, and all 3D board assets.

End users do **not** need Node.js, GHDL, MSYS2, or GCC installed.

## Outputs Produced in `dist/`

1. **`dist\Trace-FPGA-Workbench-Portable-x64.exe`** — Single-file portable `.exe` (no install or admin rights needed; unpacks once to `%LOCALAPPDATA%\TraceFPGA\portable\<hash>\` on first run, then launches instantly on all subsequent runs).
2. **`dist\Trace-FPGA-Workbench-Portable-x64.zip`** — Plain portable folder archive (unzip and double-click `Trace.exe`).
3. **`dist\Trace-FPGA-Workbench-Setup-x64.exe`** — Native Windows installer with Start Menu, Desktop shortcut, `.qpf` file association, and Windows Uninstaller (requires Inno Setup 6).

## Step 1 — One-Time WebView2 SDK Fetch (~2 MB)

Run once to download `WebView2.h` and `x64\WebView2Loader.dll` into `packaging\webview2\`:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\cmpj\dev\fpga-lab\packaging\fetch-webview2.ps1"
```

*(Optional, for the Setup installer `.exe`: install [Inno Setup 6](https://jrsoftware.org/isinfo.php), ~5 MB.)*

## Step 2 — Build All Release Artifacts

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\cmpj\dev\fpga-lab\packaging\build-release.ps1" -Version "1.0.0"
```

To skip the Inno Setup installer step and build only the Portable `.exe` + Portable `.zip`:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\cmpj\dev\fpga-lab\packaging\build-release.ps1" -Version "1.0.0" -SkipInstaller
```

## Debugging a Packaged Build

Launch `Trace.exe` with `--devtools` to enable DevTools (`F12` / `Ctrl+Shift+I`):

```powershell
& "C:\Users\cmpj\dev\fpga-lab\dist\Trace\Trace.exe" --devtools
```

Packaged runtime logs and config live in `%LOCALAPPDATA%\TraceFPGA\logs\latest.log`.
