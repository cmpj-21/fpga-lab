// In-app update checker and SHA-256 verified self-updater for Trace FPGA Workbench.
// Supports Single-File Portable EXE, Portable Folder ZIP, Inno Setup EXE, and Dev mode.

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REPO = 'cmpj-21/fpga-lab';

export function readAppVersionInfo() {
  try {
    const raw = JSON.parse(readFileSync(path.join(ROOT, 'version.json'), 'utf8'));
    return {
      version: String(raw?.version || '1.2.0').replace(/^v/i, '').trim(),
      repo: String(raw?.repo || DEFAULT_REPO).trim(),
    };
  } catch {
    return { version: '1.2.0', repo: DEFAULT_REPO };
  }
}

export function detectInstallMode() {
  const portableExe = (process.env.TRACE_PORTABLE_EXE || '').trim();
  const installDir = (process.env.TRACE_INSTALL_DIR || '').trim();
  const isPackaged = process.env.TRACE_PACKAGED === '1';
  if (portableExe && existsSync(portableExe)) {
    return { mode: 'portable-exe', targetPath: portableExe, installDir, cacheDir: (process.env.TRACE_PORTABLE_CACHE_DIR || '').trim() };
  }
  if (isPackaged && installDir) {
    if (existsSync(path.join(installDir, 'portable.mode'))) {
      return { mode: 'portable-zip', targetPath: installDir, installDir, cacheDir: '' };
    }
    return { mode: 'installed', targetPath: installDir, installDir, cacheDir: '' };
  }
  return { mode: 'dev', targetPath: ROOT, installDir: ROOT, cacheDir: '' };
}

export function compareSemver(a, b) {
  const pa = String(a || '0.0.0').replace(/^v/i, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0.0.0').replace(/^v/i, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function pickReleaseAsset(assets, mode) {
  const list = Array.isArray(assets) ? assets : [];
  const matcher =
    mode === 'portable-exe' ? /-Portable-x64\.exe$/i :
    mode === 'portable-zip' ? /-Portable-x64\.zip$/i :
    /-Setup-x64\.exe$/i;
  const hit = list.find(a => matcher.test(String(a?.name || ''))) || list.find(a => /\.exe$|\.zip$/i.test(String(a?.name || ''))) || null;
  if (!hit) return null;
  const rawDigest = String(hit.digest || '').trim();
  const sha256 = rawDigest.toLowerCase().startsWith('sha256:') ? rawDigest.slice(7).toLowerCase() : null;
  return {
    name: hit.name,
    size: Number(hit.size) || 0,
    url: hit.browser_download_url,
    sha256,
  };
}

let updateState = {
  phase: 'idle', // idle | checking | downloading | verifying | staging | launching | error
  downloadedBytes: 0,
  totalBytes: 0,
  percent: 0,
  verifiedSha256: '',
  error: '',
  lastCheck: null,
};

export function getUpdateStatus() {
  return { ...updateState };
}

export async function checkForUpdates({ apiBase = '' } = {}) {
  const { version: currentVersion, repo } = readAppVersionInfo();
  const install = detectInstallMode();
  const endpoint = apiBase
    ? `${apiBase.replace(/\/$/, '')}/releases/latest`
    : `https://api.github.com/repos/${repo}/releases/latest`;
  updateState = { ...updateState, phase: 'checking', error: '' };
  try {
    const res = await fetch(endpoint, {
      headers: {
        'User-Agent': `Trace-FPGA-Workbench/${currentVersion}`,
        Accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`GitHub API returned HTTP ${res.status}.`);
    const rel = await res.json();
    const latestVersion = String(rel.tag_name || rel.name || '').replace(/^v/i, '').trim();
    const updateAvailable = Boolean(latestVersion && compareSemver(latestVersion, currentVersion) > 0);
    const asset = pickReleaseAsset(rel.assets, install.mode);
    const info = {
      ok: true,
      currentVersion,
      latestVersion: latestVersion || currentVersion,
      updateAvailable,
      installMode: install.mode,
      canSelfUpdate: install.mode !== 'dev' && Boolean(asset?.url),
      releaseName: rel.name || `v${latestVersion}`,
      releaseUrl: rel.html_url || `https://github.com/${repo}/releases`,
      publishedAt: rel.published_at || '',
      notes: String(rel.body || '').slice(0, 6000),
      asset,
    };
    updateState = { ...updateState, phase: 'idle', lastCheck: info, error: '' };
    return info;
  } catch (err) {
    const msg = err?.name === 'TimeoutError' ? 'Update check timed out (check your internet connection).' : (err?.message || String(err));
    updateState = { ...updateState, phase: 'error', error: msg };
    throw new Error(msg);
  }
}

function psQuote(s) {
  return `'${String(s || '').replace(/'/g, "''")}'`;
}

export async function applyUpdate({ onExitRequest } = {}) {
  const install = detectInstallMode();
  if (install.mode === 'dev') {
    return {
      ok: false,
      devMode: true,
      message: 'Running from local source checkout — run `git pull` or download a release build from GitHub.',
      releaseUrl: updateState.lastCheck?.releaseUrl || `https://github.com/${readAppVersionInfo().repo}/releases`,
    };
  }
  const info = updateState.lastCheck?.asset ? updateState.lastCheck : await checkForUpdates();
  if (!info.asset?.url) throw new Error('No matching Windows release asset found for this installation mode.');
  if (!/^https:\/\//i.test(info.asset.url)) throw new Error('Refusing non-HTTPS update download URL.');

  const workDir = path.join(os.tmpdir(), `trace-update-${info.latestVersion}-${Date.now()}`);
  await fs.mkdir(workDir, { recursive: true });
  const dlPath = path.join(workDir, info.asset.name.replace(/[^a-zA-Z0-9._-]/g, '_'));

  updateState = {
    ...updateState,
    phase: 'downloading',
    downloadedBytes: 0,
    totalBytes: info.asset.size || 0,
    percent: 0,
    verifiedSha256: '',
    error: '',
  };

  try {
    const res = await fetch(info.asset.url, {
      headers: { 'User-Agent': `Trace-FPGA-Workbench/${info.currentVersion}` },
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`);
    const total = Number(res.headers.get('content-length')) || info.asset.size || 0;
    updateState.totalBytes = total;

    const hash = createHash('sha256');
    const out = createWriteStream(dlPath);
    let downloaded = 0;
    for await (const chunk of res.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buf);
      out.write(buf);
      downloaded += buf.length;
      updateState.downloadedBytes = downloaded;
      updateState.percent = total > 0 ? Math.min(99, Math.round((downloaded / total) * 100)) : 0;
    }
    await new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); out.end(); });

    updateState.phase = 'verifying';
    updateState.percent = 100;
    const actualSha = hash.digest('hex').toLowerCase();
    if (info.asset.sha256 && actualSha !== info.asset.sha256.toLowerCase()) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(`SHA-256 integrity mismatch! Expected ${info.asset.sha256.slice(0, 12)}…, got ${actualSha.slice(0, 12)}…. Update aborted.`);
    }
    updateState.verifiedSha256 = actualSha;
    updateState.phase = 'staging';

    const hostPid = parseInt(process.env.TRACE_HOST_PID || '0', 10) || 0;
    const nodePid = process.pid;
    const scriptPath = path.join(workDir, 'apply-trace-update.ps1');
    const waitBlock = `
$pids = @(${hostPid}, ${nodePid}) | Where-Object { $_ -gt 0 }
for ($i = 0; $i -lt 60; $i++) {
  $alive = @($pids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
  if ($alive.Count -eq 0) { break }
  Start-Sleep -Milliseconds 250
}
Start-Sleep -Milliseconds 350
`;

    let scriptBody = '';
    if (install.mode === 'portable-exe') {
      scriptBody = `$ErrorActionPreference = 'Stop'
${waitBlock}
$src = ${psQuote(dlPath)}
$dst = ${psQuote(install.targetPath)}
for ($try = 0; $try -lt 20; $try++) {
  try {
    Copy-Item -LiteralPath $src -Destination $dst -Force
    break
  } catch {
    if ($try -eq 19) { throw }
    Start-Sleep -Milliseconds 300
  }
}
Start-Process -FilePath $dst
Start-Sleep -Milliseconds 400
Remove-Item -LiteralPath ${psQuote(workDir)} -Recurse -Force -ErrorAction SilentlyContinue
`;
    } else if (install.mode === 'portable-zip') {
      const extractDir = path.join(workDir, 'extracted');
      scriptBody = `$ErrorActionPreference = 'Stop'
${waitBlock}
$zip = ${psQuote(dlPath)}
$ext = ${psQuote(extractDir)}
$dst = ${psQuote(install.installDir)}
New-Item -ItemType Directory -Path $ext -Force | Out-Null
& "$env:SystemRoot\\System32\\tar.exe" -xf $zip -C $ext
$root = if (Test-Path (Join-Path $ext 'Trace\\Trace.exe')) { Join-Path $ext 'Trace' } else { $ext }
foreach ($item in @('Trace.exe', 'WebView2Loader.dll', 'app', 'runtime')) {
  $s = Join-Path $root $item
  $d = Join-Path $dst $item
  if (Test-Path $s) {
    for ($try = 0; $try -lt 20; $try++) {
      try {
        if (Test-Path $d) { Remove-Item -LiteralPath $d -Recurse -Force }
        Copy-Item -LiteralPath $s -Destination $d -Recurse -Force
        break
      } catch {
        if ($try -eq 19) { throw }
        Start-Sleep -Milliseconds 300
      }
    }
  }
}
Start-Process -FilePath (Join-Path $dst 'Trace.exe') -WorkingDirectory $dst
Start-Sleep -Milliseconds 400
Remove-Item -LiteralPath ${psQuote(workDir)} -Recurse -Force -ErrorAction SilentlyContinue
`;
    } else {
      // Inno Setup installer (relaunch explicitly because trace.iss uses skipifsilent)
      scriptBody = `$ErrorActionPreference = 'Stop'
${waitBlock}
$p = Start-Process -FilePath ${psQuote(dlPath)} -ArgumentList '/SILENT /CLOSEAPPLICATIONS /NORESTART' -Wait -PassThru
$exe = Join-Path ${psQuote(install.installDir)} 'Trace.exe'
if ($p.ExitCode -eq 0 -and (Test-Path $exe)) {
  Start-Process -FilePath $exe -WorkingDirectory ${psQuote(install.installDir)}
}
Start-Sleep -Milliseconds 400
Remove-Item -LiteralPath ${psQuote(workDir)} -Recurse -Force -ErrorAction SilentlyContinue
`;
    }

    await fs.writeFile(scriptPath, scriptBody, 'utf8');
    updateState.phase = 'launching';

    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath,
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();

    setTimeout(() => { onExitRequest?.(); }, 350);
    return {
      ok: true,
      installMode: install.mode,
      version: info.latestVersion,
      sha256: actualSha,
      restarting: true,
    };
  } catch (err) {
    updateState = { ...updateState, phase: 'error', error: err?.message || String(err) };
    throw err;
  }
}
