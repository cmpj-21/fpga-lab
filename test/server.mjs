import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function startServer(port = Number(process.env.TRACE_TEST_PORT || 8045), seed = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-log-'));
  const logDir = path.join(dir, 'logs'), logFile = path.join(logDir, 'latest.log');
  await fs.mkdir(logDir);
  for (const [name, text] of Object.entries(seed)) await fs.writeFile(path.join(logDir, name), text);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, env: { ...process.env, PORT: String(port), TRACE_LOG_DIR: logDir, OPEN_BROWSER: '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const stop = async () => {
    if (child.exitCode === null) { child.kill(); await exited; }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  };
  const start = Date.now();
  while (true) {
    const health = await fetch(base + '/api/health').then(r => r.json()).catch(() => null);
    if (health?.logFile && path.resolve(health.logFile) === path.resolve(logFile)) return { base, logDir, logFile, stop };
    if (child.exitCode !== null || Date.now() - start > 20000) { await stop(); throw new Error(`Test server on port ${port} did not start: ${output.trim() || 'no output'}`); }
    await new Promise(r => setTimeout(r, 100));
  }
}
