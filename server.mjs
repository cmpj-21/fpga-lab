import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promises as fs, appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileDesign, restartSession, configuration, sessions, closeAllSessions, setEngineLogger } from './backend/engine.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const IS_PACKAGED = process.env.TRACE_PACKAGED === '1';
const USER_DATA_DIR = path.resolve(process.env.TRACE_DATA_DIR || (IS_PACKAGED ? path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'TraceFPGA') : ROOT));
const CONFIG_FILE = path.resolve(process.env.TRACE_CONFIG_FILE || path.join(USER_DATA_DIR, 'trace.config.json'));
const STATE_FILE = path.resolve(process.env.TRACE_STATE_FILE || path.join(USER_DATA_DIR, 'trace.state.json'));
let stateWriteQueue = Promise.resolve();
let configWriteQueue = Promise.resolve();

async function atomicWriteJson(filePath, obj) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  try {
    await fs.rename(tmp, filePath);
  } catch {
    await fs.writeFile(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

async function readAppState() {
  try {
    const raw = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}
async function patchAppState(patch) {
  if (!patch || typeof patch !== 'object') return readAppState();
  const allowed = ['recents', 'lastProject', 'theme', 'layout', 'skipHomeExitConfirm', 'wordWrap'];
  let nextState = {};
  const op = stateWriteQueue.catch(() => {}).then(async () => {
    const current = await readAppState();
    const next = { ...current };
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        if (patch[key] === null) delete next[key];
        else next[key] = patch[key];
      }
    }
    await atomicWriteJson(STATE_FILE, next);
    nextState = next;
  });
  stateWriteQueue = op.catch(() => {});
  await op;
  return nextState;
}
function loadInitialHdlRoot() {
  if (process.env.HDL_ROOT) return path.resolve(process.env.HDL_ROOT);
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    if (typeof raw?.hdlRoot === 'string' && path.isAbsolute(raw.hdlRoot) && statSync(raw.hdlRoot).isDirectory()) {
      return path.resolve(raw.hdlRoot);
    }
  } catch {}
  const sibling = path.resolve(ROOT, '..', 'HDL');
  try { if (statSync(sibling).isDirectory()) return sibling; } catch {}
  const docs = path.join(os.homedir(), 'Documents', 'fpga-lab');
  try { if (IS_PACKAGED && statSync(docs).isDirectory()) return docs; } catch {}
  return IS_PACKAGED ? path.join(os.homedir(), 'Documents') : ROOT;
}
let hdlRoot = loadInitialHdlRoot();
const authorizedRoots = new Set();
const saveTokens = new Map();
function authorizeRoot(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return;
  authorizedRoots.add(path.resolve(dir).toLowerCase());
}
function isAuthorizedDir(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return false;
  const resolved = path.resolve(dir);
  const low = resolved.toLowerCase();
  for (const root of authorizedRoots) {
    if (low === root || within(root, low)) return true;
  }
  return false;
}
authorizeRoot(hdlRoot);
authorizeRoot(ROOT);
try {
  const initialState = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  if (initialState?.lastProject?.projectDir) authorizeRoot(initialState.lastProject.projectDir);
  if (Array.isArray(initialState?.recents)) {
    for (const r of initialState.recents) if (r?.dir) authorizeRoot(r.dir);
  }
} catch {}

async function persistConfig(patch) {
  const op = configWriteQueue.catch(() => {}).then(async () => {
    let current = {};
    try { current = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8')); } catch {}
    const next = { ...current, ...patch };
    await atomicWriteJson(CONFIG_FILE, next);
  });
  configWriteQueue = op.catch(() => {});
  await op;
}
async function setHdlRoot(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('Local HDL library folder must be an absolute path.');
  const resolved = path.resolve(dir);
  const st = await fs.stat(resolved).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error(`Folder does not exist: ${resolved}`);
  hdlRoot = resolved;
  authorizeRoot(hdlRoot);
  await persistConfig({ hdlRoot }).catch(e => appendLogLine('warn', 'app', `Could not save config: ${e.message}`));
  if (ownsLog) appendLogLine('info', 'app', `Changed Local HDL library folder to ${hdlRoot}`);
  return { ok: true, root: hdlRoot, groups: await hdlTree() };
}
const PORT_ENV = process.env.PORT;
const AUTO_PORT = PORT_ENV === 'auto';
const REQUESTED_PORT = AUTO_PORT ? 8044 : (PORT_ENV !== undefined && PORT_ENV !== '' ? Number(PORT_ENV) : 8044);
let activePort = REQUESTED_PORT || 8044;
let triedFallbackPort = false;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.vcd': 'text/plain', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm' };
const within = (root, full) => { const rel = path.relative(root, full); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
const LOG_DIR = path.resolve(process.env.TRACE_LOG_DIR || path.join(USER_DATA_DIR, 'logs'));
const LOG_FILE = path.join(LOG_DIR, 'latest.log');
const ACTION_LOG_FILE = path.join(LOG_DIR, 'actions.log');
let logQueue = Promise.resolve(true), ownsLog = false, stopping = false;

const clip = (value, max) => String(value ?? '').replace(/\r\n?/g, '\n').slice(0, max);
const indent = text => text.split('\n').map(line => '  ' + line).join('\n');
function stamp(date = new Date()) {
  const p = n => String(n).padStart(2, '0'), offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')} UTC${offset < 0 ? '-' : '+'}${p(Math.floor(Math.abs(offset) / 60))}:${p(Math.abs(offset) % 60)}`;
}
function formatEntry({ source, message, stack = '', details = {}, recent = [], actions = [] }) {
  const lines = [`==== ${stamp()} | ${source} error ====`, 'Message:', indent(message)];
  for (const [key, value] of Object.entries(details)) if (value) lines.push(`${key}: ${value}`);
  if (stack) lines.push('Stack:', indent(stack));
  if (actions.length) lines.push('Recent UI actions (oldest first):', indent(actions.join('\n')));
  if (recent.length) lines.push('Recent console (oldest first):', indent(recent.join('\n')));
  return lines.join('\n') + '\n\n';
}
function appendLogLine(level, source, message) {
  const clean = clip(message, 2000).replace(/\n/g, '\n    ').trimEnd();
  if (!clean) return Promise.resolve(true);
  const line = `[${stamp()}] [${source.toUpperCase()}/${level.toUpperCase()}] ${clean}\n`;
  return logQueue = logQueue.then(async () => {
    await fs.mkdir(LOG_DIR, { recursive: true });
    await fs.appendFile(LOG_FILE, line, 'utf8'); return true;
  }).catch(e => { console.error(`Cannot write ${LOG_FILE}: ${e.message}`); return false; });
}
function appendLogLineSync(level, source, message) {
  const clean = clip(message, 2000).replace(/\n/g, '\n    ').trimEnd();
  if (!clean) return;
  try { mkdirSync(LOG_DIR, { recursive: true }); appendFileSync(LOG_FILE, `[${stamp()}] [${source.toUpperCase()}/${level.toUpperCase()}] ${clean}\n`, 'utf8'); } catch {}
}
function appendLog(entry) {
  const text = formatEntry(entry);
  return logQueue = logQueue.then(async () => {
    await fs.mkdir(LOG_DIR, { recursive: true });
    await fs.appendFile(LOG_FILE, text, 'utf8'); return true;
  }).catch(e => { console.error(`Cannot write ${LOG_FILE}: ${e.message}`); return false; });
}
function appendActionLog(text) {
  return logQueue = logQueue.then(async () => {
    await fs.mkdir(LOG_DIR, { recursive: true });
    await fs.appendFile(ACTION_LOG_FILE, text, 'utf8'); return true;
  }).catch(e => { console.error(`Cannot write ${ACTION_LOG_FILE}: ${e.message}`); return false; });
}
function appendLogSync(entry) { try { mkdirSync(LOG_DIR, { recursive: true }); appendFileSync(LOG_FILE, formatEntry(entry), 'utf8'); } catch {} }
function archiveLog() {
  try {
    const text = readFileSync(LOG_FILE, 'utf8'), days = new Map();
    let day = stamp(statSync(LOG_FILE).mtime).slice(0, 10);
    for (const chunk of text.split(/^(?=(?:==== |\[)\d{4}-\d\d-\d\d )/m)) {
      day = chunk.match(/^(?:==== |\[)(\d{4}-\d\d-\d\d) /)?.[1] ?? day;
      days.set(day, (days.get(day) ?? '') + chunk);
    }
    for (const [date, body] of days) if (body.trim()) appendFileSync(path.join(LOG_DIR, `${date}.log`), body, 'utf8');
    rmSync(LOG_FILE);
  } catch (e) { if (e.code !== 'ENOENT') console.error(`Cannot archive ${LOG_FILE}: ${e.message}`); }
  try {
    const text = readFileSync(ACTION_LOG_FILE, 'utf8'), days = new Map();
    let day = stamp(statSync(ACTION_LOG_FILE).mtime).slice(0, 10);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      day = line.match(/^\[(\d{4}-\d\d-\d\d) /)?.[1] ?? day;
      days.set(day, (days.get(day) ?? '') + line + '\n');
    }
    for (const [date, body] of days) if (body.trim()) appendFileSync(path.join(LOG_DIR, `${date}-actions.log`), body, 'utf8');
    rmSync(ACTION_LOG_FILE);
  } catch (e) { if (e.code !== 'ENOENT') console.error(`Cannot archive ${ACTION_LOG_FILE}: ${e.message}`); }
}
const LOG_LOCK_FILE = path.join(os.tmpdir(), `trace-log-owner-${createHash('sha256').update(LOG_DIR.toLowerCase()).digest('hex').slice(0, 12)}.pid`);
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function claimLog(startupNote = '') {
  try {
    const holder = Number(readFileSync(LOG_LOCK_FILE, 'utf8').trim());
    if (isPidAlive(holder)) {
      ownsLog = false;
      if (startupNote) appendLogLineSync('info', 'app', `${startupNote} [window pid=${process.pid}]`);
      return;
    }
  } catch {}
  ownsLog = true;
  try { writeFileSync(LOG_LOCK_FILE, String(process.pid), 'utf8'); } catch {}
  archiveLog();
  if (startupNote) appendLogLineSync('info', 'app', startupNote);
}
function releaseLogLock() {
  try {
    const holder = Number(readFileSync(LOG_LOCK_FILE, 'utf8').trim());
    if (holder === process.pid) rmSync(LOG_LOCK_FILE, { force: true });
  } catch {}
}
setEngineLogger((level, message) => { if (ownsLog) appendLogLine(level, 'engine', message); });
function eventReport(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.events) || !body.events.length) throw new Error('Event log entries need events.');
  const lines = body.events.slice(0, 50)
    .filter(ev => ev && typeof ev.message === 'string' && ev.message.trim())
    .map(ev => {
      const level = ['info', 'warning', 'warn', 'error'].includes(String(ev.level || '').toLowerCase()) ? String(ev.level).toUpperCase().replace('WARNING', 'WARN') : 'INFO';
      const simTime = typeof ev.simTime === 'string' && ev.simTime.trim() ? `[${clip(ev.simTime, 32).replace(/\n/g, ' ')}] ` : '';
      return `[${stamp()}] [CLIENT/${level}] ${simTime}${clip(ev.message, 1200).replace(/\n/g, '\n    ').trimEnd()}`;
    });
  if (!lines.length) throw new Error('Event log entries need non-empty messages.');
  return lines.join('\n') + '\n';
}
function clientReport(body) {
  if (!body || typeof body !== 'object' || typeof body.message !== 'string' || !body.message.trim()) throw new Error('Log entries need a message.');
  const details = {};
  if (body.details && typeof body.details === 'object') for (const [key, value] of Object.entries(body.details).slice(0, 16)) {
    if (/^[A-Za-z][A-Za-z ]{0,31}$/.test(key) && typeof value === 'string') details[key] = clip(value, 400).replace(/\n/g, ' ');
  }
  const recent = Array.isArray(body.recent) ? body.recent.slice(-40).filter(line => typeof line === 'string').map(line => clip(line, 800)) : [];
  const actions = Array.isArray(body.actions) ? body.actions.slice(-30).filter(line => typeof line === 'string').map(line => clip(line, 600)) : [];
  return { source: 'client', message: clip(body.message, 4000).trimEnd(), stack: typeof body.stack === 'string' ? clip(body.stack, 8000).trimEnd() : '', details, recent, actions };
}
function actionReport(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.lines) || !body.lines.length) throw new Error('Action log entries need lines.');
  const lines = body.lines.slice(0, 50).filter(l => typeof l === 'string' && l.trim()).map(l => `[${stamp()}] ${clip(l, 600).replace(/\n/g, ' ').trim()}`);
  if (!lines.length) throw new Error('Action log entries need non-empty lines.');
  return lines.join('\n') + '\n';
}

function send(res, code, body, type = 'application/json; charset=utf-8', extraHeaders = null) {
  const headers = {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    ...(extraHeaders || {}),
  };
  res.writeHead(code, headers);
  res.end(typeof body === 'object' && !Buffer.isBuffer(body) ? JSON.stringify(body) : body);
}
async function json(req, limit = 8 * 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error(`Request exceeds ${limit >= 1024 * 1024 ? `${limit / 1024 / 1024} MB` : `${limit / 1024} KB`}.`); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function runPowershell(script, envPatch = {}) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024, env: { ...process.env, ...envPatch } }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.trim() || err.message));
      resolve(stdout.trim());
    });
  });
}
async function pickProjectFolder(initialDir = '', description = 'Choose FPGA Project Folder (saves .qpf, .qsf & .vhd files)') {
  if (process.platform !== 'win32') throw new Error('Native folder picker is supported on Windows.');
  let start = hdlRoot;
  if (initialDir && path.isAbsolute(initialDir)) {
    const exists = await fs.stat(initialDir).then(s => s.isDirectory(), () => false);
    if (exists) start = initialDir;
  } else {
    const exists = await fs.stat(start).then(s => s.isDirectory(), () => false);
    if (!exists) start = ROOT;
  }
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$owner.StartPosition = "CenterScreen"',
    '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$dlg.Description = $env:TRACE_PICK_DESC',
    '$dlg.UseDescriptionForTitle = $true',
    '$dlg.ShowNewFolderButton = $true',
    '$dlg.SelectedPath = $env:TRACE_PICK_START',
    '$res = $dlg.ShowDialog($owner)',
    '$owner.Dispose()',
    'if ($res -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.SelectedPath }',
  ].join('; ');
  const chosen = await runPowershell(ps, { TRACE_PICK_START: start, TRACE_PICK_DESC: String(description || 'Choose Folder') });
  if (chosen) {
    const resolved = path.resolve(chosen);
    authorizeRoot(resolved);
    return { cancelled: false, dir: resolved };
  }
  return { cancelled: true };
}
async function pickProjectFile(initialDir = '') {
  if (process.platform !== 'win32') throw new Error('Native file picker is supported on Windows.');
  let start = hdlRoot;
  if (initialDir && path.isAbsolute(initialDir)) {
    const exists = await fs.stat(initialDir).then(s => s.isDirectory(), () => false);
    if (exists) start = initialDir;
  } else {
    const exists = await fs.stat(start).then(s => s.isDirectory(), () => false);
    if (!exists) start = ROOT;
  }
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$dlg = New-Object System.Windows.Forms.OpenFileDialog',
    '$dlg.Title = "Open Trace / Quartus FPGA Project"',
    '$dlg.InitialDirectory = $env:TRACE_PICK_START',
    '$dlg.Filter = "FPGA Projects (*.qpf;*.qsf;*.json)|*.qpf;*.qsf;*.json|All Files (*.*)|*.*"',
    '$res = $dlg.ShowDialog($owner)',
    '$owner.Dispose()',
    'if ($res -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.FileName }',
  ].join('; ');
  const chosen = await runPowershell(ps, { TRACE_PICK_START: start });
  if (chosen) {
    const resolved = path.resolve(chosen);
    authorizeRoot(path.dirname(resolved));
    return { cancelled: false, file: resolved };
  }
  return { cancelled: true };
}
async function pickSaveFile(initialDir = '', defaultName = 'untitled.vhd') {
  if (process.platform !== 'win32') throw new Error('Native file dialog is supported on Windows.');
  let start = hdlRoot;
  if (initialDir && path.isAbsolute(initialDir)) {
    const exists = await fs.stat(initialDir).then(s => s.isDirectory(), () => false);
    if (exists) start = initialDir;
  } else {
    const exists = await fs.stat(start).then(s => s.isDirectory(), () => false);
    if (!exists) start = ROOT;
  }
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$dlg = New-Object System.Windows.Forms.SaveFileDialog',
    '$dlg.Title = "Save File As"',
    '$dlg.InitialDirectory = $env:TRACE_PICK_START',
    '$dlg.FileName = $env:TRACE_PICK_DEFAULT',
    '$dlg.Filter = "VHDL Files (*.vhd;*.vhdl)|*.vhd;*.vhdl|Quartus Settings (*.qsf;*.qpf)|*.qsf;*.qpf|Data & Text (*.txt;*.md;*.hex;*.mif;*.mem;*.dat)|*.txt;*.md;*.hex;*.mif;*.mem;*.dat|All Files (*.*)|*.*"',
    '$res = $dlg.ShowDialog($owner)',
    '$owner.Dispose()',
    'if ($res -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.FileName }',
  ].join('; ');
  const chosen = await runPowershell(ps, { TRACE_PICK_START: start, TRACE_PICK_DEFAULT: String(defaultName || 'untitled.vhd') });
  if (chosen) {
    const resolved = path.resolve(chosen);
    const saveToken = randomUUID();
    saveTokens.set(saveToken, { file: resolved, expires: Date.now() + 5 * 60 * 1000 });
    for (const [k, v] of saveTokens) if (v.expires < Date.now()) saveTokens.delete(k);
    return { cancelled: false, file: resolved, filePath: resolved, saveToken };
  }
  return { cancelled: true };
}
function resolveProjectRel(dir, rel = '', { allowRoot = false } = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('Project folder must be an absolute path.');
  const root = path.resolve(dir);
  if (!isAuthorizedDir(root)) throw new Error('Project directory is not authorized. Open or save the project folder first.');
  const clean = String(rel || '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (!clean) {
    if (allowRoot) return { root, full: root, rel: '' };
    throw new Error('Specify a file or folder path.');
  }
  if (clean.split('/').some(seg => !seg || seg === '.' || seg === '..' || /[<>:"|?*\0]/.test(seg))) {
    throw new Error(`Invalid relative path: ${rel}`);
  }
  const full = path.resolve(root, clean);
  if (!within(root, full)) throw new Error('Path escapes project directory.');
  return { root, full, rel: clean };
}
async function readProjectTree(dir) {
  const { root } = resolveProjectRel(dir, '', { allowRoot: true });
  const st = await fs.stat(root).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error(`Project folder not found: ${root}`);
  const SKIP = new Set(['.git', '.trace-build', 'node_modules', 'work', 'greybox_tmp', 'db', 'incremental_db', 'output_files']);
  async function walk(cur, relPrefix, depth) {
    const entries = await fs.readdir(cur, { withFileTypes: true }).catch(() => []);
    const dirs = [], files = [];
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.env' && e.name !== '.gitignore') continue;
      if (e.isDirectory() && SKIP.has(e.name)) continue;
      const full = path.join(cur, e.name);
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        dirs.push({ type: 'dir', name: e.name, rel, children: depth < 6 ? await walk(full, rel, depth + 1) : [] });
      } else if (e.isFile()) {
        const info = await fs.stat(full).catch(() => null);
        files.push({ type: 'file', name: e.name, rel, ext: path.extname(e.name).slice(1).toLowerCase(), size: info?.size || 0 });
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return [...dirs, ...files];
  }
  return { ok: true, dir: root, name: path.basename(root), children: await walk(root, '', 0) };
}
async function readProjectFile({ dir, rel }) {
  const { full, rel: clean } = resolveProjectRel(dir, rel);
  const st = await fs.stat(full).catch(() => null);
  if (!st || !st.isFile()) throw new Error(`File not found: ${clean}`);
  if (st.size > 4 * 1024 * 1024) throw new Error('File exceeds 4 MB editor limit.');
  const text = await fs.readFile(full, 'utf8');
  return { ok: true, rel: clean, name: path.basename(full), text, size: st.size };
}
async function writeProjectFile({ dir, rel, text }) {
  if (typeof text !== 'string') throw new Error('File content must be a string.');
  const { full, rel: clean } = resolveProjectRel(dir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, text, 'utf8');
  appendLogLine('info', 'app', `Saved file ${clean} in ${dir}`);
  return { ok: true, rel: clean, full };
}
async function writeAbsoluteFile({ filePath, text, saveToken }) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('File path must be absolute.');
  if (typeof text !== 'string') throw new Error('File content must be a string.');
  const full = path.resolve(filePath);
  const tok = saveToken ? saveTokens.get(saveToken) : null;
  const authorizedByToken = tok && tok.expires >= Date.now() && tok.file.toLowerCase() === full.toLowerCase();
  if (!authorizedByToken && !isAuthorizedDir(path.dirname(full))) {
    throw new Error('Destination path is not authorized. Use Save File As to pick a destination.');
  }
  if (authorizedByToken) saveTokens.delete(saveToken);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, text, 'utf8');
  appendLogLine('info', 'app', `Saved file as ${full}`);
  return { ok: true, file: full, filePath: full, name: path.basename(full), dir: path.dirname(full) };
}
async function mkdirInProject({ dir, rel }) {
  const { full, rel: clean } = resolveProjectRel(dir, rel);
  await fs.mkdir(full, { recursive: true });
  appendLogLine('info', 'app', `Created folder ${clean} in ${dir}`);
  return { ok: true, rel: clean };
}
async function renameInProject({ dir, oldRel, newRel }) {
  const src = resolveProjectRel(dir, oldRel);
  const dst = resolveProjectRel(dir, newRel);
  if (src.full === dst.full) return { ok: true, oldRel: src.rel, newRel: dst.rel };
  const exists = await fs.stat(dst.full).then(() => true, () => false);
  if (exists) throw new Error(`A file or folder named "${dst.rel}" already exists.`);
  await fs.mkdir(path.dirname(dst.full), { recursive: true });
  await fs.rename(src.full, dst.full);
  appendLogLine('info', 'app', `Renamed ${src.rel} -> ${dst.rel} in ${dir}`);
  return { ok: true, oldRel: src.rel, newRel: dst.rel };
}
async function deleteInProject({ dir, rel }) {
  const { root, full, rel: clean } = resolveProjectRel(dir, rel);
  if (full === root) throw new Error('Cannot delete the project root folder.');
  await fs.rm(full, { recursive: true, force: false });
  appendLogLine('info', 'app', `Deleted ${clean} in ${dir}`);
  return { ok: true, rel: clean };
}
async function revealInExplorer({ dir, rel = '' }) {
  if (process.platform !== 'win32') throw new Error('Reveal in File Explorer is supported on Windows.');
  const { full } = resolveProjectRel(dir, rel, { allowRoot: true });
  const st = await fs.stat(full).catch(() => null);
  if (!st) throw new Error('Path not found on disk.');
  const args = st.isDirectory() ? [full] : [`/select,${full}`];
  execFile('explorer.exe', args, { windowsHide: false }, () => {});
  return { ok: true };
}
const SAFE_SRC_NAME = /^(?:[a-z0-9_][a-z0-9_. -]*\/)*[a-z0-9_][a-z0-9_. -]*\.(vhd|vhdl|vho|cf|hex|mif|mem|txt|dat|md)$/i;
function sanitizeProjectSlug(name, fallback = 'fpga_project') {
  const clean = String(name || '').trim().replace(/[^a-z0-9_-]/gi, '_').replace(/_+/g, '_').replace(/^[_-]+|[_-]+$/g, '');
  return clean || fallback;
}
function formatQsfValue(val) {
  return /[\s\[\]()]/.test(val) ? `{${val}}` : val;
}
async function saveProjectToFolder({ dir, projectName, project }) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('Project folder must be an absolute path.');
  if (!project || !Array.isArray(project.sources) || !project.sources.length || project.sources.length > 100) throw new Error('Project must contain 1–100 source files.');
  const targetDir = path.resolve(dir);
  if (!isAuthorizedDir(targetDir)) throw new Error('Project folder is not authorized. Use Save Project As to choose a folder.');
  await fs.mkdir(targetDir, { recursive: true });
  const top = String(project.top || '').trim() || project.sources[0].name.replace(/\.[^.]+$/, '');
  const slug = sanitizeProjectSlug(projectName || top || path.basename(targetDir));
  const stdMap = { '93': 'VHDL_1993', '02': 'VHDL_2002', '08': 'VHDL_2008' };
  const std = ['93', '02', '08'].includes(project.standard) ? project.standard : '08';
  const writtenFiles = [];
  for (const src of project.sources) {
    const normName = typeof src?.name === 'string' ? src.name.replaceAll('\\', '/') : '';
    if (!src || typeof src.text !== 'string' || !SAFE_SRC_NAME.test(normName) || normName.split('/').some(seg => seg === '.' || seg === '..')) throw new Error(`Invalid source filename: ${src?.name}`);
    const dest = path.resolve(targetDir, normName);
    if (!within(targetDir, dest)) throw new Error(`Source escapes project folder: ${src.name}`);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, src.text, 'utf8');
    writtenFiles.push(normName);
  }
  let sdfFile = null;
  if (project.sdf && typeof project.sdf.text === 'string') {
    const sdfName = /^[a-z0-9_][a-z0-9_. -]*\.sdf$/i.test(project.sdf.name || '') ? project.sdf.name : `${slug}.sdf`;
    await fs.writeFile(path.join(targetDir, sdfName), project.sdf.text, 'utf8');
    writtenFiles.push(sdfName);
    sdfFile = { name: sdfName, instance: project.sdf.instance || '/', corner: project.sdf.corner || 'typ' };
  }
  const qpfName = `${slug}.qpf`;
  const qsfName = `${slug}.qsf`;
  const qpfBody = [
    'QUARTUS_VERSION = "20.1"',
    `DATE = "${new Date().toISOString()}"`,
    '',
    '# Revisions',
    `PROJECT_REVISION = "${slug}"`,
    '',
  ].join('\n');
  const qsfLines = [
    '# Trace FPGA Workbench — Quartus Settings File',
    '# Target: RZ-EasyFPGA A2.2 (Intel Cyclone IV EP4CE6E22C8N)',
    'set_global_assignment -name FAMILY "Cyclone IV E"',
    'set_global_assignment -name DEVICE EP4CE6E22C8N',
    `set_global_assignment -name TOP_LEVEL_ENTITY ${formatQsfValue(top)}`,
    `set_global_assignment -name VHDL_INPUT_VERSION ${stdMap[std]}`,
  ];
  for (const src of project.sources) {
    if (/\.(vhd|vhdl|vho)$/i.test(src.name)) {
      const lib = src.library && src.library !== 'work' && /^[a-z][a-z0-9_]*$/i.test(src.library) ? ` -library ${src.library}` : '';
      qsfLines.push(`set_global_assignment -name VHDL_FILE ${formatQsfValue(src.name)}${lib}`);
    }
  }
  const assignments = Array.isArray(project.assignments) ? project.assignments : [];
  const validPins = assignments.filter(p => Array.isArray(p) && p.length === 2 && Number.isInteger(p[0]) && p[0] >= 1 && p[0] <= 144 && typeof p[1] === 'string' && p[1].trim());
  if (validPins.length) {
    qsfLines.push('');
    qsfLines.push('# Pin & Location Assignments');
    for (const [pin, port] of validPins.sort((a, b) => a[0] - b[0])) {
      qsfLines.push(`set_location_assignment PIN_${pin} -to ${formatQsfValue(port.trim())}`);
    }
  }
  const meta = {
    version: 1,
    projectName: String(projectName || slug),
    topLibrary: project.topLibrary || 'work',
    clkHz: Number.isFinite(Number(project.clkHz)) && Number(project.clkHz) > 0 ? Number(project.clkHz) : 50000000,
    generics: project.generics || '',
    sdf: sdfFile,
    extraFiles: project.sources.filter(s => !/\.(vhd|vhdl|vho)$/i.test(s.name)).map(s => s.name),
    compiledHash: typeof project.compiledHash === 'string' ? project.compiledHash : '',
    flashedHash: typeof project.flashedHash === 'string' ? project.flashedHash : '',
    compiledAssignments: Array.isArray(project.compiledAssignments) ? project.compiledAssignments : [],
    discoveredPorts: Array.isArray(project.discoveredPorts) ? project.discoveredPorts : [],
  };
  qsfLines.push('', `# TRACE_META: ${JSON.stringify(meta)}`, '');
  await fs.writeFile(path.join(targetDir, qpfName), qpfBody, 'utf8');
  await fs.writeFile(path.join(targetDir, qsfName), qsfLines.join('\n'), 'utf8');
  writtenFiles.push(qpfName, qsfName);
  appendLogLine('info', 'app', `Saved project "${meta.projectName}" to ${targetDir} (${qpfName}, ${qsfName}, ${project.sources.length} source(s), ${validPins.length} pin(s))`);
  return { ok: true, dir: targetDir, projectName: meta.projectName, qpf: qpfName, qsf: qsfName, files: writtenFiles };
}
function parseQsfText(text) {
  const pins = [], files = [];
  let top = '', standard = '08', meta = null;
  for (const raw of text.split(/\r?\n/)) {
    const metaMatch = raw.match(/^\s*#\s*TRACE_META:\s*(\{.*\})\s*$/);
    if (metaMatch) { try { meta = JSON.parse(metaMatch[1]); } catch {} continue; }
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const unq = s => s.replace(/^["'{]|["'}]$/g, '').trim();
    const tok = line.match(/"[^"]*"|'[^']*'|\{[^}]*\}|\S+/g)?.map(unq) || [];
    if (tok[0] === 'set_location_assignment') {
      const pinTok = tok.find(t => /^PIN_\d+$/i.test(t));
      const toIdx = tok.indexOf('-to');
      if (pinTok && toIdx >= 0 && tok[toIdx + 1]) {
        const pin = Number(pinTok.slice(4));
        if (pin >= 1 && pin <= 144) pins.push([pin, tok[toIdx + 1].toLowerCase()]);
      }
    } else if (tok[0] === 'set_global_assignment') {
      const nameIdx = tok.indexOf('-name');
      const key = nameIdx >= 0 ? tok[nameIdx + 1]?.toUpperCase() : '';
      const val = nameIdx >= 0 ? tok[nameIdx + 2] : '';
      if (key === 'TOP_LEVEL_ENTITY' && val) top = val.toLowerCase();
      else if (key === 'VHDL_INPUT_VERSION' && val) {
        if (/1993|93/i.test(val)) standard = '93';
        else if (/2002|02/i.test(val)) standard = '02';
        else if (/2008|08/i.test(val)) standard = '08';
      } else if (key === 'VHDL_FILE' && val) {
        const libIdx = tok.indexOf('-library');
        const library = libIdx >= 0 && tok[libIdx + 1] ? tok[libIdx + 1].toLowerCase() : 'work';
        files.push({ name: path.basename(val.replaceAll('\\', '/')), rel: val, library });
      }
    }
  }
  return { top, standard, pins, files, meta };
}
async function openProjectFromDisk(inputPath) {
  if (typeof inputPath !== 'string' || !inputPath.trim()) throw new Error('Specify a project file or folder path.');
  const resolved = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(hdlRoot, inputPath);
  const st = await fs.stat(resolved).catch(() => null);
  if (!st) throw new Error(`Project path not found: ${resolved}`);
  if (st.isFile() && /\.json$/i.test(resolved)) {
    const parsed = JSON.parse(await fs.readFile(resolved, 'utf8'));
    const dir = path.dirname(resolved);
    authorizeRoot(dir);
    appendLogLine('info', 'app', `Opened JSON project from ${resolved}`);
    return { ok: true, dir, projectName: parsed.top || path.basename(resolved, '.json'), qpf: null, qsf: null, project: parsed };
  }
  const dir = st.isDirectory() ? resolved : path.dirname(resolved);
  let qpfName = st.isFile() && /\.qpf$/i.test(resolved) ? path.basename(resolved) : null;
  let qsfName = st.isFile() && /\.qsf$/i.test(resolved) ? path.basename(resolved) : null;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  if (!qpfName) qpfName = entries.find(e => e.isFile() && /\.qpf$/i.test(e.name))?.name || null;
  if (!qsfName && qpfName) {
    const qpfText = await fs.readFile(path.join(dir, qpfName), 'utf8').catch(() => '');
    const rev = qpfText.match(/PROJECT_REVISION\s*=\s*"([^"]+)"/i)?.[1];
    if (rev && entries.some(e => e.isFile() && e.name.toLowerCase() === `${rev}.qsf`.toLowerCase())) {
      qsfName = entries.find(e => e.isFile() && e.name.toLowerCase() === `${rev}.qsf`.toLowerCase()).name;
    }
  }
  if (!qsfName) qsfName = entries.find(e => e.isFile() && /\.qsf$/i.test(e.name))?.name || null;
  if (!qsfName) throw new Error(`No .qsf project file found in ${dir}`);
  const qsfText = await fs.readFile(path.join(dir, qsfName), 'utf8');
  const parsed = parseQsfText(qsfText);
  const sources = [];
  const seen = new Set();
  for (const ref of parsed.files) {
    const relTarget = path.resolve(dir, ref.rel);
    const flatTarget = path.resolve(dir, ref.name);
    let candidate = null;
    if (within(dir, relTarget) && await fs.stat(relTarget).then(s => s.isFile(), () => false)) candidate = relTarget;
    else if (within(dir, flatTarget) && await fs.stat(flatTarget).then(s => s.isFile(), () => false)) candidate = flatTarget;
    if (!candidate) continue;
    const relFromDir = path.relative(dir, candidate).replaceAll('\\', '/');
    const srcName = SAFE_SRC_NAME.test(relFromDir) ? relFromDir : ref.name;
    if (!SAFE_SRC_NAME.test(srcName) || seen.has(srcName.toLowerCase())) continue;
    const text = await fs.readFile(candidate, 'utf8').catch(() => null);
    if (text !== null) {
      seen.add(srcName.toLowerCase());
      sources.push({ name: srcName, text, library: ref.library || 'work' });
    }
  }
  for (const extra of parsed.meta?.extraFiles || []) {
    if (SAFE_SRC_NAME.test(extra) && !seen.has(extra.toLowerCase())) {
      const extraFull = path.resolve(dir, extra);
      if (!within(dir, extraFull)) continue;
      const text = await fs.readFile(extraFull, 'utf8').catch(() => null);
      if (text !== null) { seen.add(extra.toLowerCase()); sources.push({ name: extra, text, library: 'work' }); }
    }
  }
  if (!sources.length) {
    for (const e of entries) {
      if (e.isFile() && /\.(vhd|vhdl|vho)$/i.test(e.name) && SAFE_SRC_NAME.test(e.name)) {
        sources.push({ name: e.name, text: await fs.readFile(path.join(dir, e.name), 'utf8'), library: 'work' });
      }
    }
  }
  if (!sources.length) throw new Error(`No readable VHDL source files found for ${qsfName} in ${dir}`);
  let sdf = null;
  if (parsed.meta?.sdf?.name && /^[a-z0-9_][a-z0-9_. -]*\.sdf$/i.test(parsed.meta.sdf.name)) {
    const sdfFull = path.resolve(dir, parsed.meta.sdf.name);
    if (within(dir, sdfFull)) {
      const sdfText = await fs.readFile(sdfFull, 'utf8').catch(() => null);
      if (sdfText !== null) sdf = { name: parsed.meta.sdf.name, text: sdfText, instance: parsed.meta.sdf.instance || '/', corner: parsed.meta.sdf.corner || 'typ' };
    }
  }
  authorizeRoot(dir);
  const project = {
    format: 'trace-project',
    version: 1,
    sources,
    assignments: parsed.pins,
    top: parsed.top || '',
    topLibrary: parsed.meta?.topLibrary || 'work',
    standard: parsed.standard || '08',
    clkHz: Number.isFinite(Number(parsed.meta?.clkHz)) && Number(parsed.meta?.clkHz) > 0 ? Number(parsed.meta.clkHz) : 50000000,
    generics: parsed.meta?.generics || '',
    sdf,
    compiledHash: typeof parsed.meta?.compiledHash === 'string' ? parsed.meta.compiledHash : '',
    flashedHash: typeof parsed.meta?.flashedHash === 'string' ? parsed.meta.flashedHash : '',
    compiledAssignments: Array.isArray(parsed.meta?.compiledAssignments) ? parsed.meta.compiledAssignments : [],
    discoveredPorts: Array.isArray(parsed.meta?.discoveredPorts) ? parsed.meta.discoveredPorts : [],
  };
  const projectName = parsed.meta?.projectName || path.basename(qsfName, '.qsf');
  appendLogLine('info', 'app', `Opened project "${projectName}" from ${dir} (${sources.length} source(s), ${parsed.pins.length} pin(s))`);
  return { ok: true, dir, projectName, qpf: qpfName, qsf: qsfName, project };
}
async function hdlTree() {
  const groups = [];
  async function walk(dir, rel, depth) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = [];
    for (const e of entries) {
      if (e.name.startsWith('.') || ['work', 'greybox_tmp', '.trace-build'].includes(e.name)) continue;
      const full = path.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && depth < 4) await walk(full, r, depth + 1);
      else if (e.isFile() && /\.(vhd|vhdl|qpf|qsf|sof|pof|vo|vho|vcd|cf|sdf|hex|mif|mem|txt|dat|md)$/i.test(e.name)) {
        const info = await fs.stat(full).catch(() => null);
        if (info) files.push({ name: e.name, rel: r, size: info.size, kind: path.extname(e.name).slice(1).toLowerCase() });
      }
    }
    if (files.length) groups.push({ dir: rel || '.', files: files.sort((a, b) => a.name.localeCompare(b.name)) });
  }
  await walk(hdlRoot, '', 0);
  return groups.sort((a, b) => a.dir.localeCompare(b.dir));
}

async function listSystemPlaces(projectDir = '') {
  const places = [];
  const addPlace = (label, dirPath, kind = 'folder') => {
    if (!dirPath) return;
    try {
      const resolved = path.resolve(dirPath);
      if (statSync(resolved).isDirectory() && !places.some(p => p.path.toLowerCase() === resolved.toLowerCase())) {
        places.push({ label, path: resolved, kind });
      }
    } catch {}
  };
  addPlace('HDL Workspace', hdlRoot, 'workspace');
  if (projectDir && path.isAbsolute(projectDir)) addPlace('Active Project', projectDir, 'project');
  const home = os.homedir();
  addPlace('Documents', path.join(home, 'Documents'), 'docs');
  addPlace('Desktop', path.join(home, 'Desktop'), 'desktop');
  addPlace('Downloads', path.join(home, 'Downloads'), 'downloads');
  addPlace('Home', home, 'home');
  if (process.platform === 'win32') {
    for (let code = 67; code <= 90; code++) {
      const letter = String.fromCharCode(code);
      const driveRoot = `${letter}:\\`;
      try {
        if (statSync(driveRoot).isDirectory()) {
          places.push({ label: `Local Disk (${letter}:)`, path: driveRoot, kind: 'drive' });
        }
      } catch {}
    }
  }
  return places;
}

async function browseFileSystem({ dir = '', projectDir = '' } = {}) {
  let target = '';
  if (typeof dir === 'string' && dir.trim()) {
    const cand = path.resolve(dir.trim());
    const st = await fs.stat(cand).catch(() => null);
    if (st?.isDirectory()) target = cand;
    else if (st?.isFile()) target = path.dirname(cand);
  }
  if (!target && projectDir && path.isAbsolute(projectDir)) {
    const st = await fs.stat(projectDir).catch(() => null);
    if (st?.isDirectory()) target = path.resolve(projectDir);
  }
  if (!target) {
    const st = await fs.stat(hdlRoot).catch(() => null);
    target = st?.isDirectory() ? path.resolve(hdlRoot) : os.homedir();
  }
  const parentDir = path.dirname(target) !== target ? path.dirname(target) : null;
  const rawEntries = await fs.readdir(target, { withFileTypes: true }).catch(() => []);
  const dirs = [], files = [];
  for (const e of rawEntries) {
    if (e.name.startsWith('$') || e.name === 'System Volume Information') continue;
    const full = path.join(target, e.name);
    const info = await fs.stat(full).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) {
      dirs.push({
        type: 'dir',
        name: e.name,
        path: full,
        mtime: info.mtimeMs || 0,
      });
    } else if (info.isFile()) {
      files.push({
        type: 'file',
        name: e.name,
        path: full,
        ext: path.extname(e.name).slice(1).toLowerCase(),
        size: info.size || 0,
        mtime: info.mtimeMs || 0,
      });
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return {
    ok: true,
    dir: target,
    parent: parentDir,
    places: await listSystemPlaces(projectDir),
    entries: [...dirs, ...files],
  };
}

async function createBrowserFolder({ dir, name } = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('Select a valid parent folder first.');
  const cleanName = String(name || '').trim();
  if (!cleanName || cleanName === '.' || cleanName === '..' || /[<>:"/\\|?*\x00-\x1f]/.test(cleanName)) {
    throw new Error('Enter a valid folder name without special characters.');
  }
  const target = path.join(path.resolve(dir), cleanName);
  const exists = await fs.stat(target).then(() => true, () => false);
  if (exists) throw new Error(`Folder "${cleanName}" already exists.`);
  await fs.mkdir(target, { recursive: true });
  authorizeRoot(target);
  return { ok: true, dir: target, name: cleanName };
}

async function authorizeBrowserSelection({ targetPath, mode = 'folder' } = {}) {
  if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath.trim())) {
    throw new Error('Enter or select an absolute path.');
  }
  const resolved = path.resolve(targetPath.trim());
  if (mode === 'save-file') {
    const parent = path.dirname(resolved);
    const st = await fs.stat(parent).catch(() => null);
    if (!st || !st.isDirectory()) throw new Error(`Destination folder does not exist: ${parent}`);
    authorizeRoot(parent);
    const saveToken = randomUUID();
    saveTokens.set(saveToken, { file: resolved, expires: Date.now() + 5 * 60 * 1000 });
    for (const [k, v] of saveTokens) if (v.expires < Date.now()) saveTokens.delete(k);
    return { ok: true, cancelled: false, file: resolved, filePath: resolved, dir: parent, saveToken };
  }
  if (mode === 'folder') {
    await fs.mkdir(resolved, { recursive: true });
    authorizeRoot(resolved);
    return { ok: true, cancelled: false, dir: resolved };
  }
  const st = await fs.stat(resolved).catch(() => null);
  if (!st) throw new Error(`Path not found: ${resolved}`);
  const authDir = st.isDirectory() ? resolved : path.dirname(resolved);
  authorizeRoot(authDir);
  return { ok: true, cancelled: false, file: resolved, dir: authDir, isDirectory: st.isDirectory() };
}

const termSessions = new Map();
let cachedShellInfo = null;

function buildTerminalPathEnv() {
  const extraBins = [
    path.resolve(ROOT, 'runtime', 'ghdl', 'bin'),
    path.resolve(ROOT, 'runtime', 'node'),
    path.resolve(ROOT, '..', 'runtime', 'ghdl', 'bin'),
    path.resolve(ROOT, '..', 'runtime', 'node'),
    'C:\\msys64\\ucrt64\\bin',
  ].filter(p => { try { return statSync(p).isDirectory(); } catch { return false; } });
  return [...extraBins, process.env.PATH || ''].filter(Boolean).join(path.delimiter);
}

function findExecutableOnPath(exeName, fallbacks = []) {
  for (const candidate of fallbacks) {
    try { if (candidate && statSync(candidate).isFile()) return candidate; } catch {}
  }
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const full = path.join(dir, exeName);
    try { if (statSync(full).isFile()) return full; } catch {}
  }
  return null;
}

async function detectAvailableShells() {
  if (cachedShellInfo) return cachedShellInfo;
  const shells = [];
  if (process.platform === 'win32') {
    const pwshPath = findExecutableOnPath('pwsh.exe', [
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe',
    ]);
    if (pwshPath) {
      const ver = await new Promise(resolve => {
        execFile(pwshPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { windowsHide: true, timeout: 4000 }, (err, stdout) => {
          resolve(!err && stdout?.trim() ? `PowerShell ${stdout.trim()}` : 'PowerShell 7');
        });
      });
      shells.push({ id: 'pwsh', label: 'pwsh.exe', exe: pwshPath, banner: ver });
    }
    const winPsPath = findExecutableOnPath('powershell.exe', [
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'),
    ]);
    if (winPsPath) {
      shells.push({ id: 'powershell', label: 'powershell.exe', exe: winPsPath, banner: 'Windows PowerShell 5.1' });
    }
    const cmdPath = findExecutableOnPath('cmd.exe', [
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32\\cmd.exe'),
    ]);
    if (cmdPath) {
      shells.push({ id: 'cmd', label: 'cmd.exe', exe: cmdPath, banner: 'Microsoft Windows Command Prompt' });
    }
  } else {
    shells.push({ id: 'sh', label: 'sh', exe: '/bin/sh', banner: 'POSIX Shell' });
  }
  cachedShellInfo = {
    defaultShell: shells[0]?.id || 'powershell',
    shells,
  };
  return cachedShellInfo;
}

function stripAnsi(str = '') {
  return String(str).replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

async function resolveValidCwd(cwd = '') {
  if (typeof cwd === 'string' && cwd.trim() && path.isAbsolute(cwd.trim())) {
    const st = await fs.stat(cwd.trim()).catch(() => null);
    if (st?.isDirectory()) return path.resolve(cwd.trim());
  }
  const st = await fs.stat(hdlRoot).catch(() => null);
  return st?.isDirectory() ? path.resolve(hdlRoot) : ROOT;
}

function resolveConptyHelper() {
  const candidates = [
    path.join(ROOT, 'backend', 'conpty_host.exe'),
    path.join(ROOT, '..', 'packaging', 'build', 'conpty_host.exe'),
    path.join(ROOT, 'packaging', 'build', 'conpty_host.exe'),
  ];
  for (const c of candidates) {
    try { if (statSync(c).isFile()) return c; } catch {}
  }
  return null;
}

function broadcastTermEvent(session, payload) {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of [...session.clients]) {
    try {
      res.write(msg);
    } catch {
      session.clients.delete(res);
    }
  }
}

async function createTerminalSession({ shell = '', cwd = '', cols = 120, rows = 28 } = {}) {
  const info = await detectAvailableShells();
  const chosen = info.shells.find(s => s.id === shell) || info.shells[0];
  const workDir = await resolveValidCwd(cwd);
  const id = randomUUID();
  const safeCols = Math.max(20, Math.min(500, Number(cols) || 120));
  const safeRows = Math.max(5, Math.min(200, Number(rows) || 28));
  const conptyExe = process.platform === 'win32' ? resolveConptyHelper() : null;

  const proc = conptyExe
    ? spawn(conptyExe, [String(safeCols), String(safeRows), chosen.exe], {
        cwd: workDir,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PATH: buildTerminalPathEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      })
    : spawn(chosen.exe, chosen.id === 'cmd' ? ['/Q', '/K'] : ['-NoLogo'], {
        cwd: workDir,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PATH: buildTerminalPathEnv(), TERM: 'xterm-256color' },
      });

  const session = {
    id,
    shell: chosen.id,
    label: chosen.label,
    banner: chosen.banner,
    exe: chosen.exe,
    cwd: workDir,
    proc,
    replayBuf: '',
    clients: new Set(),
  };

  const onChunk = chunk => {
    const str = chunk.toString('utf8');
    if (!str) return;
    session.replayBuf += str;
    if (session.replayBuf.length > 96 * 1024) {
      session.replayBuf = session.replayBuf.slice(-64 * 1024);
    }
    broadcastTermEvent(session, { type: 'data', data: str });
  };

  proc.stdout.on('data', onChunk);
  proc.stderr.on('data', onChunk);
  proc.on('close', code => {
    broadcastTermEvent(session, { type: 'exit', code: code ?? 0 });
    for (const res of session.clients) {
      try { res.end(); } catch {}
    }
    session.clients.clear();
    if (termSessions.get(id) === session) termSessions.delete(id);
  });

  termSessions.set(id, session);
  return {
    ok: true,
    id: session.id,
    shell: session.shell,
    label: session.label,
    banner: session.banner,
    cwd: session.cwd,
    pty: !!conptyExe,
  };
}

function writeTerminalInput({ id = '', data = '' } = {}) {
  const session = id ? termSessions.get(id) : null;
  if (!session || !session.proc || session.proc.killed) return { ok: false, error: 'Terminal session ended.' };
  if (typeof data === 'string' && data.length > 0) {
    try { session.proc.stdin.write(data, 'utf8'); } catch {}
  }
  return { ok: true };
}

function resizeTerminalSession({ id = '', cols = 120, rows = 28 } = {}) {
  const session = id ? termSessions.get(id) : null;
  if (!session || !session.proc || session.proc.killed) return { ok: false };
  const c = Math.max(10, Math.min(500, Math.floor(Number(cols) || 120)));
  const r = Math.max(4, Math.min(200, Math.floor(Number(rows) || 28)));
  try {
    session.proc.stdin.write(`\x1b]9999;R;${c};${r}\x07`, 'utf8');
  } catch {}
  return { ok: true };
}

function closeTerminalSession({ id = '' } = {}) {
  const session = id ? termSessions.get(id) : null;
  if (session) {
    for (const res of session.clients) {
      try { res.end(); } catch {}
    }
    session.clients.clear();
    try { session.proc.stdin.end(); } catch {}
    try { session.proc.kill(); } catch {}
    termSessions.delete(id);
  }
  return { ok: true };
}

const server = http.createServer(async (req, res) => {
  try {
    if (![`127.0.0.1:${activePort}`, `localhost:${activePort}`].includes(req.headers.host)) return send(res, 403, { error: 'Localhost requests only.' });
    if (req.headers.origin && ![`http://127.0.0.1:${activePort}`, `http://localhost:${activePort}`].includes(req.headers.origin)) return send(res, 403, { error: 'Cross-origin access denied.' });
    const url = new URL(req.url, `http://127.0.0.1:${activePort}`);
    if (url.pathname === '/api/health') {
      const cfg = await configuration().catch(e => ({ version: null, error: e.message }));
      return send(res, 200, { ok: !!cfg.version, app: 'trace-workbench', hdlRoot, backend: cfg.version, error: cfg.error, sessions: sessions.size, logFile: LOG_FILE, actionLogFile: ACTION_LOG_FILE, stateFile: STATE_FILE });
    }
    if (url.pathname === '/api/state' && req.method === 'GET') {
      return send(res, 200, { ok: true, state: await readAppState() });
    }
    if (url.pathname === '/api/state' && req.method === 'POST') {
      const patch = await json(req, 12 * 1024 * 1024);
      await patchAppState(patch);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/log' && req.method === 'POST') {
      const written = await appendLog(clientReport(await json(req, 64 * 1024)));
      return send(res, written ? 200 : 500, written ? { ok: true, file: LOG_FILE } : { error: `Cannot write ${LOG_FILE}.` });
    }
    if (url.pathname === '/api/log/event' && req.method === 'POST') {
      const text = eventReport(await json(req, 64 * 1024));
      const written = await (logQueue = logQueue.then(async () => {
        await fs.mkdir(LOG_DIR, { recursive: true });
        await fs.appendFile(LOG_FILE, text, 'utf8'); return true;
      }).catch(e => { console.error(`Cannot write ${LOG_FILE}: ${e.message}`); return false; }));
      return send(res, written ? 200 : 500, written ? { ok: true, file: LOG_FILE } : { error: `Cannot write ${LOG_FILE}.` });
    }
    if (url.pathname === '/api/log/action' && req.method === 'POST') {
      const written = await appendActionLog(actionReport(await json(req, 64 * 1024)));
      return send(res, written ? 200 : 500, written ? { ok: true, file: ACTION_LOG_FILE } : { error: `Cannot write ${ACTION_LOG_FILE}.` });
    }
    if (url.pathname === '/api/hdl/tree') return send(res, 200, { root: hdlRoot, groups: await hdlTree() });
    if (url.pathname === '/api/hdl/pick-root' && req.method === 'POST') {
      const picked = await pickProjectFolder(hdlRoot, 'Choose Local HDL Library Folder');
      if (picked.cancelled || !picked.dir) return send(res, 200, { ok: true, cancelled: true, root: hdlRoot });
      const updated = await setHdlRoot(picked.dir);
      return send(res, 200, { ...updated, cancelled: false });
    }
    if (url.pathname === '/api/hdl/root' && req.method === 'POST') {
      const body = await json(req, 32 * 1024);
      return send(res, 200, await setHdlRoot(body?.path));
    }
    if (url.pathname === '/api/fs/browse' && req.method === 'POST') {
      const body = await json(req, 32 * 1024).catch(() => ({}));
      return send(res, 200, await browseFileSystem(body));
    }
    if (url.pathname === '/api/fs/mkdir' && req.method === 'POST') {
      const body = await json(req, 32 * 1024);
      return send(res, 200, await createBrowserFolder(body));
    }
    if (url.pathname === '/api/fs/authorize' && req.method === 'POST') {
      const body = await json(req, 32 * 1024);
      return send(res, 200, await authorizeBrowserSelection(body));
    }
    if (url.pathname === '/api/terminal/info' && req.method === 'GET') {
      return send(res, 200, { ok: true, ...(await detectAvailableShells()) });
    }
    if (url.pathname === '/api/terminal/create' && req.method === 'POST') {
      const body = await json(req, 32 * 1024).catch(() => ({}));
      return send(res, 200, await createTerminalSession(body));
    }
    if (url.pathname === '/api/terminal/stream' && req.method === 'GET') {
      const id = url.searchParams.get('id') || '';
      const session = termSessions.get(id);
      if (!session) return send(res, 404, { error: 'Terminal session not found.' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      if (session.replayBuf) {
        res.write(`data: ${JSON.stringify({ type: 'data', data: session.replayBuf })}\n\n`);
      }
      session.clients.add(res);
      req.on('close', () => {
        session.clients.delete(res);
      });
      return;
    }
    if (url.pathname === '/api/terminal/write' && req.method === 'POST') {
      const body = await json(req, 256 * 1024);
      return send(res, 200, writeTerminalInput(body));
    }
    if (url.pathname === '/api/terminal/resize' && req.method === 'POST') {
      const body = await json(req, 32 * 1024);
      return send(res, 200, resizeTerminalSession(body));
    }
    if (url.pathname === '/api/terminal/close' && req.method === 'POST') {
      const body = await json(req, 32 * 1024).catch(() => ({}));
      return send(res, 200, closeTerminalSession(body));
    }
    if (url.pathname === '/api/tutorial' && req.method === 'GET') {
      const tutPath = path.join(ROOT, 'TUTORIAL.md');
      const text = await fs.readFile(tutPath, 'utf8').catch(() => '# Trace Tutorial\n\nTutorial file not found.');
      return send(res, 200, { ok: true, name: 'TUTORIAL.md', text });
    }
    if (url.pathname === '/api/project/pick-folder' && req.method === 'POST') {
      const body = await json(req, 32 * 1024).catch(() => ({}));
      return send(res, 200, await pickProjectFolder(body?.initialDir));
    }
    if (url.pathname === '/api/project/pick-open' && req.method === 'POST') {
      const body = await json(req, 32 * 1024).catch(() => ({}));
      return send(res, 200, await pickProjectFile(body?.initialDir));
    }
    if (url.pathname === '/api/project/pick-save-file' && req.method === 'POST') {
      const body = await json(req, 32 * 1024).catch(() => ({}));
      return send(res, 200, await pickSaveFile(body?.initialDir, body?.defaultName));
    }
    if (url.pathname === '/api/project/tree' && req.method === 'POST') {
      const body = await json(req, 32 * 1024);
      return send(res, 200, await readProjectTree(body?.dir));
    }
    if (url.pathname === '/api/project/read-file' && req.method === 'POST') {
      return send(res, 200, await readProjectFile(await json(req, 32 * 1024)));
    }
    if (url.pathname === '/api/project/write-file' && req.method === 'POST') {
      return send(res, 200, await writeProjectFile(await json(req, 8 * 1024 * 1024)));
    }
    if (url.pathname === '/api/project/write-path' && req.method === 'POST') {
      return send(res, 200, await writeAbsoluteFile(await json(req, 8 * 1024 * 1024)));
    }
    if (url.pathname === '/api/project/mkdir' && req.method === 'POST') {
      return send(res, 200, await mkdirInProject(await json(req, 32 * 1024)));
    }
    if (url.pathname === '/api/project/rename' && req.method === 'POST') {
      return send(res, 200, await renameInProject(await json(req, 32 * 1024)));
    }
    if (url.pathname === '/api/project/delete' && req.method === 'POST') {
      return send(res, 200, await deleteInProject(await json(req, 32 * 1024)));
    }
    if (url.pathname === '/api/project/reveal' && req.method === 'POST') {
      return send(res, 200, await revealInExplorer(await json(req, 32 * 1024)));
    }
    if (url.pathname === '/api/project/save' && req.method === 'POST') {
      return send(res, 200, await saveProjectToFolder(await json(req, 12 * 1024 * 1024)));
    }
    if (url.pathname === '/api/project/open' && req.method === 'POST') {
      const body = await json(req, 32 * 1024);
      return send(res, 200, await openProjectFromDisk(body?.path));
    }
    if (url.pathname === '/api/hdl/file') {
      const full = await fs.realpath(path.resolve(hdlRoot, url.searchParams.get('path') || ''));
      if (!within(await fs.realpath(hdlRoot), full)) return send(res, 403, { error: 'Path outside HDL root.' });
      if (!/\.(vhd|vhdl|vho|cf|sdf|qsf|vcd|sof|pof|vo|hex|mif|mem|txt|dat|md)$/i.test(full)) return send(res, 400, { error: 'Not a supported HDL/data artifact.' });
      if ((await fs.stat(full)).size > 32 * 1024 * 1024) return send(res, 413, { error: 'Artifact exceeds 32 MB.' });
      return send(res, 200, await fs.readFile(full), 'application/octet-stream');
    }
    if (url.pathname === '/api/sim/compile' && req.method === 'POST') {
      const payload = await json(req);
      const compiled = await compileDesign(payload);
      appendLogLine('info', 'engine', `Compiled ${compiled.top} (VHDL-${compiled.standard}, ${payload.sources?.length || 0} source(s), ${compiled.signals?.length || 0} signals, session ${compiled.id.slice(0, 8)})`);
      return send(res, 200, compiled);
    }
    if (url.pathname === '/api/sim/close-all' && (req.method === 'POST' || req.method === 'DELETE')) {
      const openCount = sessions.size;
      await closeAllSessions();
      if (openCount > 0) appendLogLine('info', 'engine', `Stopped and closed ${openCount} active simulation session(s)`);
      return send(res, 200, { ok: true });
    }
    const match = url.pathname.match(/^\/api\/sim\/([a-f0-9-]+)(?:\/(step|vcd|close|restart))?$/);
    if (match) {
      const session = sessions.get(match[1]);
      if (!session) return send(res, 404, { error: 'Simulation session ended. Build the design again.' });
      if (req.method === 'DELETE' || (match[2] === 'close' && req.method === 'POST')) {
        await session.close();
        appendLogLine('info', 'engine', `Closed simulation session ${match[1].slice(0, 8)}`);
        return send(res, 200, { ok: true });
      }
      if (match[2] === 'restart' && req.method === 'POST') {
        const restarted = await restartSession(match[1]);
        appendLogLine('info', 'engine', `Restarted simulation ${restarted.top} (session ${match[1].slice(0, 8)} -> ${restarted.id.slice(0, 8)}, cached)`);
        return send(res, 200, restarted);
      }
      if (match[2] === 'step' && req.method === 'POST') return send(res, 200, await session.step(await json(req)));
      if (match[2] === 'vcd' && req.method === 'POST') {
        const vcd = await session.exportVcd();
        appendLogLine('info', 'engine', `Exported VCD for session ${match[1].slice(0, 8)} (${vcd.length} bytes)`);
        return send(res, 200, vcd, 'text/plain; charset=utf-8');
      }
      return send(res, 405, { error: 'Method not allowed.' });
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
    const full = path.resolve(PUBLIC, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!within(PUBLIC, full)) return send(res, 403, 'Forbidden', 'text/plain');
    const actual = await fs.realpath(full).catch(() => null);
    const actualStat = actual ? await fs.stat(actual).catch(() => null) : null;
    if (!actual || !actualStat?.isFile() || !within(PUBLIC, actual)) return send(res, 404, 'Not found', 'text/plain');
    const cacheHeaders = IS_PACKAGED && /^\/(vendor|assets)\//.test(url.pathname) ? { 'Cache-Control': 'public, max-age=31536000, immutable' } : null;
    return send(res, 200, await fs.readFile(actual), MIME[path.extname(actual)] || 'application/octet-stream', cacheHeaders);
  } catch (e) {
    if (ownsLog && /^\/api\/(sim|hdl)\//.test(req.url || '')) {
      appendLogLine('warn', 'engine', `${req.method} ${req.url} failed: ${String(e.message || e).split(/\r?\n/)[0]}`);
    }
    return send(res, 400, { error: e.message });
  }
});
let address = `http://127.0.0.1:${activePort}`;
function openBrowser() {
  if (process.env.OPEN_BROWSER === '1' && process.platform === 'win32') execFile('cmd.exe', ['/d', '/c', 'start', '', address], { windowsHide: true }, error => { if (error) console.error(`Open ${address} in your browser.`); });
}
server.listen(REQUESTED_PORT, '127.0.0.1', () => {
  activePort = server.address().port;
  address = `http://127.0.0.1:${activePort}`;
  claimLog(`Trace workbench started at ${address} (Node ${process.version}, HDL root: ${hdlRoot})`);
  console.log(`TRACE_READY ${address}`);
  console.log(`Trace workbench: ${address}`);
  openBrowser();
});
server.on('error', async error => {
  if (error.code === 'EADDRINUSE' && AUTO_PORT && !triedFallbackPort) {
    triedFallbackPort = true;
    server.listen(0, '127.0.0.1');
    return;
  }
  if (error.code === 'EADDRINUSE') {
    const existing = await fetch(address + '/api/health', { signal: AbortSignal.timeout(3000) }).then(r => r.json()).catch(() => null);
    if (existing?.app === 'trace-workbench') { console.log(`Trace is already running at ${address}`); openBrowser(); return; }
  }
  console.error(`Cannot start Trace: ${error.message}`); process.exitCode = 1;
  claimLog();
  appendLogSync({ source: 'server', message: `Cannot start Trace: ${error.message}`, stack: error.stack, details: { Address: address } });
});
process.on('uncaughtExceptionMonitor', (error, origin) => appendLogSync({ source: 'server', message: `Server crashed (${origin}): ${error?.message ?? error}`, stack: error?.stack, details: { Address: address, Node: process.version } }));
process.on('exit', () => { if (ownsLog) { archiveLog(); releaseLogLock(); } });
async function shutdown() {
  if (stopping) return;
  stopping = true;
  // Brief grace window so WebView2 pagehide sendBeacon log/state flushes land on disk
  if (IS_PACKAGED) await new Promise(r => setTimeout(r, 180));
  if (ownsLog) appendLogLine('info', 'app', 'Trace workbench shutting down');
  for (const s of termSessions.values()) {
    clearTimeout(s.activeTimer);
    try { s.proc.kill(); } catch {}
  }
  termSessions.clear();
  server.close();
  await Promise.race([Promise.all([...sessions.values()].map(s => s.close().catch(() => {}))), new Promise(r => setTimeout(r, 2000))]);
  await stateWriteQueue.catch(() => {});
  await logQueue;
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(signal, shutdown);
if (IS_PACKAGED) {
  process.stdin.resume();
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
}
