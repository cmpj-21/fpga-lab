# Building Native Windows Releases for Trace FPGA Workbench

This packaging suite compiles Trace into a self-contained native Windows 64-bit desktop application (`Trace.exe` powered by Win32 + Microsoft Edge WebView2) bundling Node.js, portable GHDL + IEEE/VITAL libraries, the pre-compiled VPI bridge, Three.js, and all 3D board assets.

End users do **not** need Node.js, GHDL, MSYS2, or GCC installed.

## Outputs Produced in `dist/`

1. **`dist\Trace-FPGA-Workbench-Portable-x64.exe`** — Single-file portable `.exe` (stores user data—`trace.config.json`, `logs\`, and `webview2\`—in a `TraceData\` folder right beside the `.exe`; unpacks runtime binaries once into `%LOCALAPPDATA%\TraceFPGA\portable\<hash>\` so subsequent launches start instantly).
2. **`dist\Trace-FPGA-Workbench-Portable-x64.zip`** — Plain portable folder archive (includes `portable.mode` so unzipping anywhere stores user data in `TraceData\` beside `Trace.exe`).
3. **`dist\Trace-FPGA-Workbench-Setup-x64.exe`** — Native Windows installer (`Program Files`, Start Menu, Desktop shortcut, `.qpf` file association, Windows Uninstaller; stores user data in `%LOCALAPPDATA%\TraceFPGA\`). Requires Inno Setup 6.

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

## GitHub-hosted release build

The `Release Windows builds` workflow (`.github/workflows/release.yml`) builds on a GitHub-hosted Windows runner, so no local toolchain or download is needed. Push a `v*` tag, or run the workflow manually with a version such as `1.0.0`. It publishes a GitHub release containing the versioned portable EXE, portable ZIP, and setup EXE. GitHub adds its own `Source code (zip)` and `Source code (tar.gz)` archives automatically, so no duplicate source ZIP is uploaded.

## Debugging a Packaged Build

Launch `Trace.exe` with `--devtools` to enable DevTools (`F12` / `Ctrl+Shift+I`):

```powershell
& "C:\Users\cmpj\dev\fpga-lab\dist\Trace\Trace.exe" --devtools
```

Packaged runtime logs and config live in `%LOCALAPPDATA%\TraceFPGA\logs\latest.log`.
