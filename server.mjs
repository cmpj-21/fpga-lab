import http from 'node:http';
import { execFile } from 'node:child_process';
import { promises as fs, appendFileSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileDesign, configuration, sessions, closeAllSessions } from './backend/engine.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const HDL_ROOT = process.env.HDL_ROOT || 'C:\\Users\\cmpj\\dev\\HDL';
const PORT = Number(process.env.PORT || 8044);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.vcd': 'text/plain' };
const within = (root, full) => { const rel = path.relative(root, full); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
const LOG_DIR = path.resolve(process.env.TRACE_LOG_DIR || path.join(ROOT, 'logs'));
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
    for (const chunk of text.split(/^(?===== \d{4}-\d\d-\d\d )/m)) {
      day = chunk.match(/^==== (\d{4}-\d\d-\d\d) /)?.[1] ?? day;
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
function claimLog() { ownsLog = true; archiveLog(); }
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

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
  res.end(typeof body === 'object' && !Buffer.isBuffer(body) ? JSON.stringify(body) : body);
}
async function json(req, limit = 8 * 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error(`Request exceeds ${limit >= 1024 * 1024 ? `${limit / 1024 / 1024} MB` : `${limit / 1024} KB`}.`); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function hdlTree() {
  const groups = [];
  async function walk(dir, rel, depth) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = [];
    for (const e of entries) {
      if (e.name.startsWith('.') || ['work', 'greybox_tmp'].includes(e.name)) continue;
      const full = path.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && depth < 4) await walk(full, r, depth + 1);
      else if (e.isFile() && /\.(vhd|vhdl|qsf|sof|pof|vo|vho|vcd|cf|sdf|hex|mif|mem|txt|dat)$/i.test(e.name)) files.push({ name: e.name, rel: r, size: (await fs.stat(full)).size, kind: path.extname(e.name).slice(1).toLowerCase() });
    }
    if (files.length) groups.push({ dir: rel || '.', files: files.sort((a, b) => a.name.localeCompare(b.name)) });
  }
  await walk(HDL_ROOT, '', 0);
  return groups.sort((a, b) => a.dir.localeCompare(b.dir));
}

const server = http.createServer(async (req, res) => {
  try {
    if (![`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(req.headers.host)) return send(res, 403, { error: 'Localhost requests only.' });
    if (req.headers.origin && ![`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`].includes(req.headers.origin)) return send(res, 403, { error: 'Cross-origin access denied.' });
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname === '/api/health') {
      const cfg = await configuration().catch(e => ({ version: null, error: e.message }));
      return send(res, 200, { ok: !!cfg.version, app: 'trace-workbench', hdlRoot: HDL_ROOT, backend: cfg.version, error: cfg.error, sessions: sessions.size, logFile: LOG_FILE, actionLogFile: ACTION_LOG_FILE });
    }
    if (url.pathname === '/api/log' && req.method === 'POST') {
      const written = await appendLog(clientReport(await json(req, 64 * 1024)));
      return send(res, written ? 200 : 500, written ? { ok: true, file: LOG_FILE } : { error: `Cannot write ${LOG_FILE}.` });
    }
    if (url.pathname === '/api/log/action' && req.method === 'POST') {
      const written = await appendActionLog(actionReport(await json(req, 64 * 1024)));
      return send(res, written ? 200 : 500, written ? { ok: true, file: ACTION_LOG_FILE } : { error: `Cannot write ${ACTION_LOG_FILE}.` });
    }
    if (url.pathname === '/api/hdl/tree') return send(res, 200, { root: HDL_ROOT, groups: await hdlTree() });
    if (url.pathname === '/api/hdl/file') {
      const full = await fs.realpath(path.resolve(HDL_ROOT, url.searchParams.get('path') || ''));
      if (!within(await fs.realpath(HDL_ROOT), full)) return send(res, 403, { error: 'Path outside HDL root.' });
      if (!/\.(vhd|vhdl|vho|cf|sdf|qsf|vcd|sof|pof|vo|hex|mif|mem|txt|dat)$/i.test(full)) return send(res, 400, { error: 'Not a supported HDL/data artifact.' });
      if ((await fs.stat(full)).size > 32 * 1024 * 1024) return send(res, 413, { error: 'Artifact exceeds 32 MB.' });
      return send(res, 200, await fs.readFile(full), 'application/octet-stream');
    }
    if (url.pathname === '/api/sim/compile' && req.method === 'POST') return send(res, 200, await compileDesign(await json(req)));
    if (url.pathname === '/api/sim/close-all' && (req.method === 'POST' || req.method === 'DELETE')) {
      await closeAllSessions();
      return send(res, 200, { ok: true });
    }
    const match = url.pathname.match(/^\/api\/sim\/([a-f0-9-]+)(?:\/(step|vcd|close))?$/);
    if (match) {
      const session = sessions.get(match[1]);
      if (!session) return send(res, 404, { error: 'Simulation session ended. Build the design again.' });
      if (req.method === 'DELETE' || (match[2] === 'close' && req.method === 'POST')) { await session.close(); return send(res, 200, { ok: true }); }
      if (match[2] === 'step' && req.method === 'POST') return send(res, 200, await session.step(await json(req)));
      if (match[2] === 'vcd' && req.method === 'POST') return send(res, 200, await session.exportVcd(), 'text/plain; charset=utf-8');
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
    const full = path.resolve(PUBLIC, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!within(PUBLIC, full)) return send(res, 403, 'Forbidden', 'text/plain');
    const actual = await fs.realpath(full).catch(() => null);
    if (!actual || !within(PUBLIC, actual)) return send(res, 404, 'Not found', 'text/plain');
    return send(res, 200, await fs.readFile(actual), MIME[path.extname(actual)] || 'application/octet-stream');
  } catch (e) { return send(res, 400, { error: e.message }); }
});
const address = `http://127.0.0.1:${PORT}`;
function openBrowser() {
  if (process.env.OPEN_BROWSER === '1' && process.platform === 'win32') execFile('cmd.exe', ['/d', '/c', 'start', '', address], { windowsHide: true }, error => { if (error) console.error(`Open ${address} in your browser.`); });
}
server.listen(PORT, '127.0.0.1', () => { claimLog(); console.log(`Trace workbench: ${address}`); openBrowser(); });
server.on('error', async error => {
  if (error.code === 'EADDRINUSE') {
    const existing = await fetch(address + '/api/health', { signal: AbortSignal.timeout(3000) }).then(r => r.json()).catch(() => null);
    if (existing?.app === 'trace-workbench') { console.log(`Trace is already running at ${address}`); openBrowser(); return; }
  }
  console.error(`Cannot start Trace: ${error.message}`); process.exitCode = 1;
  claimLog();
  appendLogSync({ source: 'server', message: `Cannot start Trace: ${error.message}`, stack: error.stack, details: { Address: address } });
});
process.on('uncaughtExceptionMonitor', (error, origin) => appendLogSync({ source: 'server', message: `Server crashed (${origin}): ${error?.message ?? error}`, stack: error?.stack, details: { Address: address, Node: process.version } }));
process.on('exit', () => { if (ownsLog) archiveLog(); });
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  await Promise.race([Promise.all([...sessions.values()].map(s => s.close().catch(() => {}))), new Promise(r => setTimeout(r, 2000))]);
  await logQueue;
  process.exit();
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(signal, shutdown);
