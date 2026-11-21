import { spawn, execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import readline from 'node:readline';

const exec = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const GHDL = process.env.GHDL_PATH || 'ghdl';
let configPromise;
const activeCompiles = new Set();
export const sessions = new Map();

export async function closeAllSessions() {
  for (const token of activeCompiles) token.cancelled = true;
  activeCompiles.clear();
  const active = [...sessions.values()];
  sessions.clear();
  await Promise.all(active.map(s => s.close().catch(() => {})));
}

export function configuration() {
  return configPromise ??= (async () => {
    const options = { windowsHide: true, timeout: 30000, maxBuffer: 2e6 };
    const version = (await exec(GHDL, ['--version'], options)).stdout.split(/\r?\n/)[0];
    const include = (await exec(GHDL, ['--vpi-include-dir'], options)).stdout.trim();
    const lib = (await exec(GHDL, ['--vpi-library-dir'], options)).stdout.trim();
    const gcc = process.env.CC || (process.platform === 'win32' ? 'C:/msys64/ucrt64/bin/gcc.exe' : 'gcc');
    const env = { ...process.env, PATH: [lib, path.dirname(gcc), process.env.PATH].join(path.delimiter) };
    const source = path.join(ROOT, 'bridge.c');
    const hash = createHash('sha256').update(await fs.readFile(source)).update(version).digest('hex').slice(0, 16);
    const plugin = path.join(ROOT, `bridge-${hash}.vpi`);
    const built = await fs.stat(plugin).catch(() => null);
    if (!built) {
      await exec(gcc, ['-shared', '-O2', '-Wall', `-I${include}`, source, `-L${lib}`, '-lghdlvpi', '-o', plugin], { ...options, env });
    }
    return { version, plugin, env };
  })();
}

export async function compileDesign({ sources, top, topLibrary = 'work', standard = '08', generics = {}, sdf = null }) {
  if (!Array.isArray(sources) || !sources.length || sources.length > 100) throw new Error('Provide 1–100 VHDL source or compiled library files.');
  if (!['93', '02', '08'].includes(standard)) throw new Error('Supported language standards: 93, 02, 08.');
  if (top && !/^[a-z][a-z0-9_]*$/i.test(top)) throw new Error('Invalid top entity name.');
  if (!/^[a-z][a-z0-9_]*$/i.test(topLibrary)) throw new Error('Invalid top library name.');
  if (!generics || typeof generics !== 'object' || Array.isArray(generics)) throw new Error('Generic overrides must be an object.');
  if (sessions.size + activeCompiles.size >= 4) throw new Error('Four simulations are already open or compiling. Close another session first.');
  const compileToken = { cancelled: false };
  activeCompiles.add(compileToken);
  let session, dir;
  try {
    const cfg = await configuration();
    if (compileToken.cancelled) throw new Error('Simulation compilation cancelled.');
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-ghdl-'));
    topLibrary = topLibrary.toLowerCase();
    const entities = new Set(), groups = new Map(), names = new Set(), manifests = [];
    const diagnostics = [];
    for (const source of sources) {
      if (!source || !/^[a-z0-9_][a-z0-9_. -]*\.(?:vhd|vhdl|vho|cf|hex|mif|mem|txt|dat)$/i.test(source.name) || typeof source.text !== 'string') throw new Error('Invalid source/data filename or content.');
      if (names.has(source.name.toLowerCase())) throw new Error(`Duplicate filename: ${source.name}`);
      names.add(source.name.toLowerCase());
      if (/\.cf$/i.test(source.name)) { manifests.push(source); continue; }
      const library = (source.library || 'work').toLowerCase();
      if (!/^[a-z][a-z0-9_]*$/i.test(library)) throw new Error('Invalid VHDL library name.');
      await fs.writeFile(path.join(dir, source.name), source.text);
      if (/\.(vhd|vhdl|vho)$/i.test(source.name)) {
        for (const m of source.text.replace(/--[^\n]*/g, '').matchAll(/\bentity\s+([a-z]\w*)\s+is\b/gi)) entities.add(m[1].toLowerCase());
        if (!groups.has(library)) groups.set(library, []);
        groups.get(library).push(source.name);
      }
    }
    for (const manifest of manifests) {
      if (!/^v\s+\d+\s*$/m.test(manifest.text)) throw new Error(`${manifest.name} is not a GHDL library manifest.`);
      const refs = [...manifest.text.matchAll(/^file\s+[^\n]*?"([^"]+)"/gm)].map(m => path.basename(m[1].replaceAll('\\', '/')));
      if (!refs.length) throw new Error(`${manifest.name} contains no source references.`);
      const missing = refs.filter(name => !names.has(name.toLowerCase()));
      if (missing.length) throw new Error(`GHDL .cf files are library indexes, not portable executables. Also open the referenced sources: ${missing.join(', ')}.`);
      diagnostics.push(`${manifest.name}: recompiling accompanying sources; absolute paths and cached compiler hashes are not portable.`);
    }
    if (!groups.size) throw new Error('No VHDL sources to compile. Open the sources referenced by the library manifest.');
    const options = { cwd: dir, env: cfg.env, windowsHide: true, timeout: 30000, maxBuffer: 2e6 };
    for (const [library, files] of groups) {
      const r = await exec(GHDL, ['-i', `--std=${standard}`, '-fsynopsys', `--work=${library}`, ...files], options);
      if (r.stderr) diagnostics.push(r.stderr.trim());
    }
    if (!top) {
      const result = await exec(GHDL, ['--find-top', `--std=${standard}`, '-fsynopsys', `--work=${topLibrary}`, `-P${dir}`], options);
      const candidates = result.stdout.trim().split(/\s+/).filter(Boolean);
      if (candidates.length !== 1) throw new Error(`Select a top entity. Candidates: ${candidates.join(', ') || [...entities].join(', ')}`);
      top = candidates[0];
    }
    const flags = [`--std=${standard}`, '-fsynopsys', `--work=${topLibrary}`, `-P${dir}`];
    const built = await exec(GHDL, ['-m', ...flags, top], options);
    if (built.stderr) diagnostics.push(built.stderr.trim());
    const args = ['-r', ...flags, top];
    for (const [key, value] of Object.entries(generics)) {
      if (!/^[a-z]\w*$/i.test(key) || !['string','number','boolean'].includes(typeof value) || String(value).length > 4096 || /[\0\r\n]/.test(String(value))) throw new Error('Invalid generic name or value.');
      args.push(`-g${key}=${value}`);
    }
    args.push(`--vpi=${cfg.plugin}`, '--assert-level=error', '--stop-delta=10000', '--unbuffered', '--vcd=trace.vcd');
    if (sdf) {
      if (typeof sdf.text !== 'string' || !/^[a-z0-9_./]+$/i.test(sdf.instance) || !['min', 'typ', 'max'].includes(sdf.corner || 'typ')) throw new Error('Invalid SDF annotation.');
      await fs.writeFile(path.join(dir, 'timing.sdf'), sdf.text);
      args.push(`--sdf=${sdf.corner || 'typ'}=${sdf.instance}=timing.sdf`);
    }
    if (compileToken.cancelled) throw new Error('Simulation compilation cancelled.');
    session = new EngineSession(spawn(GHDL, args, { cwd: dir, env: cfg.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }), dir);
    const initial = await session.result();
    if (compileToken.cancelled) {
      await session.close();
      throw new Error('Simulation compilation cancelled.');
    }
    top = top.toLowerCase();
    for (const signal of session.schema.signals) signal.driveable = [1, 3].includes(signal.direction) && signal.name.startsWith(top + '.') && !signal.name.slice(top.length + 1).includes('.');
    sessions.set(session.id, session);
    return { id: session.id, backend: cfg.version, top, topLibrary, standard, entities: [...entities], diagnostics, ...session.schema, ...initial };
  } catch (error) {
    if (session) await session.close();
    else if (dir) await fs.rm(dir, { recursive: true, force: true });
    throw new Error(error.stderr || error.message);
  } finally { activeCompiles.delete(compileToken); }
}

class EngineSession {
  constructor(child, dir) {
    this.id = randomUUID(); this.child = child; this.dir = dir;
    this.schema = null; this.samples = []; this.logs = []; this.failure = null;
    this.pending = null; this.completed = null; this.lastUsed = Date.now();
    this.busy = true; this.time = 0n;
    const output = readline.createInterface({ input: child.stdout });
    output.on('line', line => {
      if (!line.startsWith('@TRACE ')) { this.log(line); return; }
      try {
        const data = JSON.parse(line.slice(7));
        if (data.type === 'ready') {
          this.schema = { signals: data.signals, precision: data.precision };
          this.values = data.signals.map(s => 'U'.repeat(s.width));
        } else if (data.type === 'sample' || data.type === 'change') {
          this.time = BigInt(data.time);
          if (data.type === 'sample') this.values = data.values.map(v => v.toUpperCase());
          else this.values[data.id] = data.value.toUpperCase();
          const sample = { time: data.time, values: [...this.values] };
          if (this.samples.at(-1)?.time === data.time) this.samples[this.samples.length - 1] = sample;
          else this.samples.push(sample);
          if (this.samples.length >= 50000) throw new Error('Signal event limit exceeded for one batch; reduce step size.');
        } else if (data.type === 'done') this.complete(false);
      } catch (e) { this.fail(e); }
    });
    readline.createInterface({ input: child.stderr }).on('line', line => this.log(line));
    child.on('error', e => this.fail(e));
    this.closed = new Promise(resolve => child.once('close', code => {
      this.ended = true; this.busy = false;
      if (!this.closing) {
        if (code === 0 && this.schema && !this.failure) this.complete(true);
        else this.fail(new Error(this.logs.join('\n') || `GHDL exited with status ${code}.`));
      }
      resolve();
    }));
    child.stdin.on('error', e => { if (!this.closing && !this.ended && e.code !== 'EPIPE') this.fail(e); });
  }
  complete(ended) {
    this.busy = false;
    const previous = this.completed;
    const value = { samples: [...(previous?.samples || []), ...this.samples.splice(0)], logs: [...(previous?.logs || []), ...this.logs.splice(0)], ended };
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.resolve(value); this.pending = null; }
    else this.completed = value;
  }
  log(line) { if (line.trim()) this.logs.push(line); if (this.logs.length > 1000) this.logs.shift(); }
  fail(error) {
    this.failure ||= error;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(this.failure); this.pending = null; }
    if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded) this.child.stdin.end('Q\n');
  }
  result() {
    if (this.failure) return Promise.reject(this.failure);
    if (this.completed) { const value = this.completed; this.completed = null; return Promise.resolve(value); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error('GHDL did not respond within 15 seconds; simulation stopped.'));
        this.child.kill();
      }, 15000);
      this.pending = { resolve, reject, timer };
    });
  }
  async step({ cycles = 1, halfPeriod = '500000000000', clock = -1, inputs = [] }) {
    if (this.failure) throw this.failure;
    if (this.ended || this.closing) throw new Error('Simulation complete. Export its waveform or build again.');
    if (this.busy) throw new Error('A simulation step is already in progress.');
    if (!Number.isInteger(cycles) || cycles < 0 || cycles > 4096) throw new Error('Cycles must be 0–4096.');
    if (!/^\d+$/.test(String(halfPeriod))) throw new Error('Half period must be a positive integer in simulator ticks.');
    const hp = BigInt(halfPeriod);
    if (hp < 1n || hp > 1000000000000000n || this.time + hp * BigInt(cycles * 2) > 9007199254740991n) throw new Error('Time is outside the supported exact waveform range; reset or reduce the duration.');
    const clk = this.schema.signals[clock];
    if (clock !== -1 && (!clk || !clk.driveable || clk.direction !== 1 || clk.width !== 1)) throw new Error('Clock must be a scalar input port.');
    if (!Array.isArray(inputs) || inputs.length > 512) throw new Error('Invalid input list.');
    const lines = inputs.map(({ id, value }) => {
      const signal = this.schema.signals[id];
      if (!signal?.driveable) throw new Error('Only input/inout ports on the top entity may be driven.');
      if (typeof value !== 'string' || value.length !== signal.width || !/^[01UXZWLH-]+$/i.test(value)) throw new Error(`Invalid ${signal.width}-bit value for ${signal.name}.`);
      return `${id} ${value.toUpperCase()}`;
    });
    this.busy = true;
    const vcd = await fs.stat(path.join(this.dir, 'trace.vcd')).catch(() => null);
    if (vcd?.size > 64 * 1024 * 1024) { this.busy = false; throw new Error('Waveform capture reached 64 MB. Export and restart the simulation.'); }
    this.lastUsed = Date.now();
    const result = this.result();
    this.child.stdin.write(`R ${cycles * 2} ${hp} ${clock} ${lines.length}\n${lines.length ? lines.join('\n') + '\n' : ''}`);
    return result;
  }
  async exportVcd() {
    if (this.busy) throw new Error('Pause and finish the current step before exporting.');
    return this.close(true);
  }
  async close(capture = false) {
    if (this.closing) return;
    this.closing = true;
    sessions.delete(this.id);
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error('Simulation session closed.')); this.pending = null; }
    if (!this.ended) {
      if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded) this.child.stdin.end('Q\n');
      const timer = setTimeout(() => this.child.kill(), 1500);
      await this.closed;
      clearTimeout(timer);
    }
    try { return capture ? await fs.readFile(path.join(this.dir, 'trace.vcd'), 'utf8') : undefined; }
    finally { await fs.rm(this.dir, { recursive: true, force: true }); }
  }
}

const idleCleanup = setInterval(() => {
  for (const session of sessions.values()) if (Date.now() - session.lastUsed > 30 * 60 * 1000 && !session.busy) session.close().catch(() => {});
}, 60000);
idleCleanup.unref();
