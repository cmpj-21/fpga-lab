import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http, { get } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { startServer } from './server.mjs';

const server = await startServer();
const { base, logFile } = server;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, session;
const check = (value, message) => { assert.ok(value, message); passed++; console.log(`ok ${message}`); };
const post = (url, data) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
try {
  const response = await fetch(base + '/api/health');
  const health = await response.json();
  check(health.ok && health.app === 'trace-workbench', 'health identifies a working native backend');
  check(response.headers.get('x-content-type-options') === 'nosniff' && response.headers.get('content-security-policy').includes("frame-ancestors 'none'"), 'responses restrict MIME sniffing and framing');
  const badHost = await new Promise((resolve, reject) => get(base + '/api/health', { headers: { Host: 'untrusted.invalid' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }).on('error', reject));
  check(badHost === 403, 'untrusted Host headers are rejected');
  check((await post('/api/sim/compile', { sources: [] })).status === 400, 'empty source sets produce a structured client error');
  check((await fetch(base + '/api/sim/compile', { method: 'POST', headers: { Origin: 'https://untrusted.invalid', 'Content-Type': 'application/json' }, body: '{}' })).status === 403, 'cross-origin compilation is rejected');
  check((await fetch(base + '/%2e%2e%5cbackend%5cengine.mjs')).status === 403, 'encoded static traversal cannot leave the public directory');
  const outside = path.relative(health.hdlRoot, path.join(root, 'server.mjs'));
  check((await fetch(base + '/api/hdl/file?path=' + encodeURIComponent(outside))).status === 403, 'library downloads cannot leave the configured HDL root');
  check((await fetch(base + '/%zz')).status === 400, 'malformed URL escapes fail without stopping the server');
  check((await fetch(base + '/missing-file.js')).status === 404, 'missing assets return not found');
  check((await fetch(base + '/', { method: 'POST' })).status === 405, 'static routes reject unsupported methods');
  check((await fetch(base + '/api/sim/compile', { method: 'POST', body: '{' })).status === 400, 'malformed JSON produces a client error');
  check((await post('/api/sim/compile', { sources: [{ name: '../escape.vhd', text: '' }] })).status === 400, 'source filenames cannot traverse outside scratch storage');
  check(path.resolve(health.logFile) === path.resolve(logFile), 'health reports the error log location');
  check((await post('/api/log', { message: '  ' })).status === 400, 'error log rejects entries without a message');
  check((await fetch(base + '/api/log', { method: 'POST', headers: { Origin: 'https://untrusted.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'forged' }) })).status === 403, 'cross-origin pages cannot write the error log');
  check((await post('/api/log', { message: 'x'.repeat(70 * 1024) }).catch(() => ({ status: 400 }))).status === 400, 'oversized error log entries are rejected');
  const logged = await post('/api/log', { message: 'First line\nsecond line', stack: 'Error: probe\n    at test', details: { Design: 'gate.vhd', 'Bad\nKey': 'dropped', Status: 'Error\nforged header' }, recent: ['[00:00:00] [0 fs] ERROR probe'] });
  const text = await fs.readFile(logFile, 'utf8');
  const expected = ['Message:', '  First line', '  second line', 'Design: gate.vhd', 'Status: Error forged header', 'Stack:', '  Error: probe', '      at test', 'Recent console (oldest first):', '  [00:00:00] [0 fs] ERROR probe', '', ''].join('\n');
  const errIdx = text.indexOf('==== ');
  const [header, ...body] = (errIdx >= 0 ? text.slice(errIdx) : '').split('\n');
  check(text.includes('[SERVER/INFO] Trace workbench started at ') && logged.ok && /^==== \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} UTC[+-]\d\d:\d\d \| client error ====$/.test(header) && body.join('\n') === expected, `session log records startup info and appends sanitized error entries: ${JSON.stringify(text)}`);
  check(path.basename(logFile) === 'latest.log' && path.basename(path.dirname(logFile)) === 'logs', 'the running session logs to logs/latest.log');
  const duplicate = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, env: { ...process.env, PORT: new URL(base).port, TRACE_LOG_DIR: server.logDir, OPEN_BROWSER: '0' }, windowsHide: true, stdio: 'ignore' });
  const [duplicateCode] = await once(duplicate, 'exit');
  check(duplicateCode === 0 && (await fs.readFile(logFile, 'utf8')) === text && (await fs.readdir(server.logDir)).join() === 'latest.log', 'a second launch while Trace runs leaves the live session log alone');

  const entry = (date, message) => `==== ${date} 23:59:59.000 UTC+08:00 | client error ====\nMessage:\n  ${message}\n\n`;
  const leftover = await startServer(8046, { 'latest.log': entry('2026-11-15', 'crash A') + entry('2026-11-16', 'crash B'), '2026-11-16.log': entry('2026-11-16', 'earlier session') });
  try {
    const read = name => fs.readFile(path.join(leftover.logDir, name), 'utf8').catch(() => null);
    const [latest, day15, day16] = await Promise.all(['latest.log', '2026-11-15.log', '2026-11-16.log'].map(read));
    check(latest && latest.includes('[SERVER/INFO] Trace workbench started at ') && day15 === entry('2026-11-15', 'crash A') && day16 === entry('2026-11-16', 'earlier session') + entry('2026-11-16', 'crash B'), `a leftover latest.log is archived by entry date on the next launch and a fresh session log starts immediately: ${JSON.stringify([latest, day15, day16])}`);
  } finally { await leftover.stop(); }

  const blocker = http.createServer((req, res) => res.end('busy')).listen(8047, '127.0.0.1');
  await once(blocker, 'listening');
  const failDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-log-'));
  try {
    const child = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, env: { ...process.env, PORT: '8047', TRACE_LOG_DIR: failDir, OPEN_BROWSER: '0' }, windowsHide: true, stdio: 'ignore' });
    const [code] = await once(child, 'exit');
    const today = new Date(), p = n => String(n).padStart(2, '0');
    const archived = await fs.readFile(path.join(failDir, `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}.log`), 'utf8').catch(() => '');
    const stillLatest = await fs.stat(path.join(failDir, 'latest.log')).then(() => true, () => false);
    check(code === 1 && archived.includes('| server error ====') && archived.includes('Cannot start Trace: listen EADDRINUSE') && !stillLatest, 'a server that quits archives its session log to the dated file');
  } finally { blocker.close(); await fs.rm(failDir, { recursive: true, force: true }); }

  const source = 'library ieee; use ieee.std_logic_1164.all; entity dut is port(a: in std_logic; y: out std_logic); end; architecture rtl of dut is begin y <= not a; end;';
  const compiled = await post('/api/sim/compile', { sources: [{ name: 'gate.vhd', text: source }], top: 'dut' });
  session = await compiled.json();
  check(compiled.ok && !!session.id, 'compile API creates a real simulation session');
  const input = session.signals.find(s => s.name === 'dut.a');
  const output = session.signals.find(s => s.name === 'dut.y');
  const step = data => post(`/api/sim/${session.id}/step`, data);
  check((await step({ cycles: -1 })).status === 400, 'negative cycle counts are rejected');
  check((await step({ cycles: 0, inputs: [{ id: output.id, value: '1' }] })).status === 400, 'output ports cannot be driven through HTTP');
  check((await step({ cycles: 0, inputs: [{ id: input.id, value: '00' }] })).status === 400, 'wrong-width input values are rejected');
  check((await step({ cycles: 1, clock: output.id })).status === 400, 'output ports cannot be used as stimulus clocks');
  const valid = await step({ cycles: 0, inputs: [{ id: input.id, value: '0' }] });
  const state = await valid.json();
  check(valid.ok && state.samples.at(-1).values[output.id] === '1', 'validation failures leave the active session usable');
  const vcd = await fetch(`${base}/api/sim/${session.id}/vcd`, { method: 'POST' });
  check(vcd.ok && (await vcd.text()).includes('$enddefinitions'), 'HTTP export returns finalized native VCD');
  check((await step({ cycles: 1 })).status === 404, 'finalized sessions cannot be stepped');
  check((await (await fetch(base + '/api/health')).json()).ok, 'backend remains healthy after boundary tests');
  console.log(`\n${passed} API checks passed`);
} finally {
  if (session?.id) await fetch(`${base}/api/sim/${session.id}`, { method: 'DELETE' }).catch(() => {});
  await server.stop();
}
