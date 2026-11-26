import { spawn, execFile } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import readline from 'node:readline';
import { compileSynthVerilogToModule } from './rtlCompiler.mjs';
import { lintVhdlHardwarePitfalls } from './vhdlLint.mjs';

function extractDeviceUsageFromRtl(rtlCode) {
  if (!rtlCode) return null;
  const m = rtlCode.match(/^export const meta = (\{[^\n]+\});/m);
  if (!m) return null;
  try { return JSON.parse(m[1])?.deviceUsage || null; } catch { return null; }
}

const exec = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const BUILD_CACHE_ROOT = path.resolve(
  process.env.TRACE_BUILD_CACHE ||
  (process.env.TRACE_DATA_DIR
    ? path.join(process.env.TRACE_DATA_DIR, 'build-cache')
    : (process.env.TRACE_PACKAGED === '1'
      ? path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'TraceFPGA', 'build-cache')
      : path.join(os.tmpdir(), 'trace-build-cache')))
);
const MAX_CACHE_ENTRIES = 24;

// Sweep orphaned trace-ghdl-* temp dirs (>2h old) in the background on startup
(async () => {
  try {
    const tmp = os.tmpdir();
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const entry of await fs.readdir(tmp, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('trace-ghdl-')) continue;
      const full = path.join(tmp, entry.name);
      const st = await fs.stat(full).catch(() => null);
      if (st && st.mtimeMs < cutoff) await fs.rm(full, { recursive: true, force: true }).catch(() => {});
    }
  } catch {}
})();

async function pruneBuildCache() {
  try {
    const entries = await fs.readdir(BUILD_CACHE_ROOT, { withFileTypes: true }).catch(() => []);
    const dirs = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(BUILD_CACHE_ROOT, e.name);
      const st = await fs.stat(full).catch(() => null);
      if (st) dirs.push({ full, mtime: st.mtimeMs });
    }
    if (dirs.length <= MAX_CACHE_ENTRIES) return;
    dirs.sort((a, b) => a.mtime - b.mtime);
    for (const old of dirs.slice(0, dirs.length - MAX_CACHE_ENTRIES)) {
      await fs.rm(old.full, { recursive: true, force: true }).catch(() => {});
    }
  } catch {}
}

function resolveGhdlRuntime() {
  if (process.env.GHDL_PATH) {
    const bin = path.resolve(process.env.GHDL_PATH);
    const binDir = path.dirname(bin);
    const prefix = path.resolve(binDir, '..', 'lib', 'ghdl');
    return { ghdl: bin, binDir, prefix: existsSync(prefix) ? prefix : process.env.GHDL_PREFIX || '' };
  }
  const candidates = [
    path.resolve(ROOT, '..', '..', 'runtime', 'ghdl', 'bin', 'ghdl.exe'),
    path.resolve(ROOT, '..', 'runtime', 'ghdl', 'bin', 'ghdl.exe'),
  ];
  for (const bin of candidates) {
    if (existsSync(bin)) {
      const binDir = path.dirname(bin);
      const prefix = path.resolve(binDir, '..', 'lib', 'ghdl');
      return { ghdl: bin, binDir, prefix: existsSync(prefix) ? prefix : '' };
    }
  }
  return { ghdl: 'ghdl', binDir: '', prefix: process.env.GHDL_PREFIX || '' };
}
let configPromise, engineLog = () => {};
const activeCompiles = new Set();
export const sessions = new Map();
export function setEngineLogger(fn) { engineLog = typeof fn === 'function' ? fn : () => {}; }

export async function closeAllSessions() {
  for (const token of activeCompiles) {
    token.cancelled = true;
    try { token.controller?.abort(); } catch {}
  }
  activeCompiles.clear();
  const active = [...sessions.values()];
  sessions.clear();
  await Promise.all(active.map(s => s.close().catch(() => {})));
}

export function configuration() {
  if (configPromise) return configPromise;
  configPromise = (async () => {
    const rt = resolveGhdlRuntime();
    const basePathParts = [rt.binDir, process.env.PATH].filter(Boolean);
    const baseEnv = { ...process.env, PATH: basePathParts.join(path.delimiter), ...(rt.prefix ? { GHDL_PREFIX: rt.prefix } : {}) };
    const options = { windowsHide: true, timeout: 30000, maxBuffer: 2e6, env: baseEnv };
    const version = (await exec(rt.ghdl, ['--version'], options)).stdout.split(/\r?\n/)[0].trim();
    const source = path.join(ROOT, 'bridge.c');
    const hash = createHash('sha256').update(await fs.readFile(source)).update(version).digest('hex').slice(0, 16);
    const pluginName = `bridge-${hash}.vpi`;
    let plugin = path.join(ROOT, pluginName);
    let built = await fs.stat(plugin).catch(() => null);
    if (!built) {
      const cachePlugin = path.join(BUILD_CACHE_ROOT, pluginName);
      if (await fs.stat(cachePlugin).catch(() => null)) { plugin = cachePlugin; built = true; }
    }
    let env = baseEnv;
    if (!built) {
      const include = (await exec(rt.ghdl, ['--vpi-include-dir'], options)).stdout.trim();
      const lib = (await exec(rt.ghdl, ['--vpi-library-dir'], options)).stdout.trim();
      const gcc = process.env.CC || (process.platform === 'win32' ? 'C:/msys64/ucrt64/bin/gcc.exe' : 'gcc');
      env = { ...baseEnv, PATH: [lib, path.dirname(gcc), baseEnv.PATH].filter(Boolean).join(path.delimiter) };
      let targetPlugin = plugin;
      try {
        await fs.access(ROOT, fs.constants?.W_OK ?? 2);
      } catch {
        await fs.mkdir(BUILD_CACHE_ROOT, { recursive: true });
        targetPlugin = path.join(BUILD_CACHE_ROOT, pluginName);
      }
      const tmpPlugin = `${targetPlugin}.${process.pid}.tmp`;
      engineLog('info', `Building VPI plugin ${pluginName} with ${gcc}`);
      await exec(gcc, ['-shared', '-O2', '-Wall', `-I${include}`, source, `-L${lib}`, '-lghdlvpi', '-o', tmpPlugin], { ...options, env });
      await fs.rename(tmpPlugin, targetPlugin).catch(async () => {
        await fs.copyFile(tmpPlugin, targetPlugin);
        await fs.rm(tmpPlugin, { force: true }).catch(() => {});
      });
      plugin = targetPlugin;
    } else if (!rt.binDir) {
      const lib = await exec(rt.ghdl, ['--vpi-library-dir'], options).then(r => r.stdout.trim()).catch(() => '');
      if (lib) env = { ...baseEnv, PATH: [lib, baseEnv.PATH].filter(Boolean).join(path.delimiter) };
    }
    engineLog('info', `GHDL engine ready: ${version} (VPI: ${path.basename(plugin)})`);
    return { version, plugin, env, ghdl: rt.ghdl };
  })().catch(err => {
    configPromise = null;
    throw err;
  });
  return configPromise;
}

async function spawnFromSpec(spec, compileToken = null) {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-ghdl-'));
  let session;
  try {
    for (const df of spec.dataFiles) {
      const dest = path.resolve(runDir, df.name);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, df.text);
    }
    const runArgs = [...spec.runArgs];
    if (spec.sdf) {
      await fs.writeFile(path.join(runDir, 'timing.sdf'), spec.sdf.text);
      runArgs.push(`--sdf=${spec.sdf.corner || 'typ'}=${spec.sdf.instance}=timing.sdf`);
    }
    if (compileToken?.cancelled) throw new Error('Simulation compilation cancelled.');
    session = new EngineSession(
      spawn(spec.cfg.ghdl, runArgs, { cwd: runDir, env: spec.cfg.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }),
      runDir,
      spec
    );
    const initial = await session.result();
    if (compileToken?.cancelled) {
      await session.close();
      throw new Error('Simulation compilation cancelled.');
    }
    const top = spec.top.toLowerCase();
    let hasAscendingPort = false;
    for (const signal of session.schema.signals) {
      const isTopPort = signal.name.startsWith(top + '.') && !signal.name.slice(top.length + 1).includes('.');
      signal.driveable = [1, 3].includes(signal.direction) && isTopPort;
      if (isTopPort && signal.width > 1 && Number.isInteger(signal.left) && Number.isInteger(signal.right) && signal.left < signal.right) {
        hasAscendingPort = true;
      }
    }
    session.rtlCode = !hasAscendingPort ? (spec.rtlCode || null) : null;
    const rtlUsage = extractDeviceUsageFromRtl(spec.rtlCode);
    let topIoPins = 0;
    for (const s of session.schema.signals) {
      const isTopPort = s.name.startsWith(top + '.') && !s.name.slice(top.length + 1).includes('.') && [1, 2, 3].includes(s.direction);
      if (isTopPort) topIoPins += (s.width || 1);
    }
    const deviceUsage = rtlUsage || {
      device: 'EP4CE6E22C8N',
      leMin: null,
      leMax: null,
      maxLes: 6272,
      registers: null,
      memoryBits: null,
      maxMemoryBits: 276480,
      m9kBlocks: null,
      maxM9kBlocks: 30,
      multipliers: null,
      maxMultipliers: 15,
      ioPins: topIoPins,
      maxIoPins: 91,
      estimated: true,
    };
    sessions.set(session.id, session);
    return {
      id: session.id,
      backend: spec.cfg.version,
      top,
      topLibrary: spec.topLibrary,
      standard: spec.standard,
      entities: [...spec.entities],
      diagnostics: [...spec.diagnostics],
      deviceUsage,
      buildHash: spec.buildHash,
      cached: !!spec.cached,
      hasRtl: !!session.rtlCode,
      ...session.schema,
      ...initial,
    };
  } catch (err) {
    if (session) await session.close().catch(() => {});
    else await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

export async function restartSession(id) {
  const existing = sessions.get(id);
  if (!existing || !existing.spawnSpec) throw new Error('Simulation session ended. Build the design again.');
  const spec = { ...existing.spawnSpec, cached: true };
  await existing.close().catch(() => {});
  return spawnFromSpec(spec);
}

const inFlightCacheBuilds = new Map();
export async function compileDesign({ sources, top, topLibrary = 'work', standard = '08', generics = {}, sdf = null }) {
  if (!Array.isArray(sources) || !sources.length || sources.length > 100) throw new Error('Provide 1–100 VHDL source or compiled library files.');
  if (!['93', '02', '08'].includes(standard)) throw new Error('Supported language standards: 93, 02, 08.');
  if (top && (!/^[a-z][a-z0-9_]*$/i.test(top) || WIN_RESERVED.test(top))) throw new Error('Invalid top entity name.');
  if (!/^[a-z][a-z0-9_]*$/i.test(topLibrary) || WIN_RESERVED.test(topLibrary)) throw new Error('Invalid top library name.');
  if (!generics || typeof generics !== 'object' || Array.isArray(generics)) throw new Error('Generic overrides must be an object.');
  if (sdf && (typeof sdf.text !== 'string' || typeof sdf.instance !== 'string' || !/^[a-z0-9_./]+$/i.test(sdf.instance) || !['min', 'typ', 'max'].includes(sdf.corner || 'typ'))) {
    throw new Error('Invalid SDF annotation.');
  }
  const compileToken = { cancelled: false, controller: new AbortController() };
  activeCompiles.add(compileToken);
  try {
    while (sessions.size + activeCompiles.size > 4) {
      const oldestIdle = [...sessions.values()].filter(s => !s.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!oldestIdle) break;
      engineLog('info', `Auto-evicting oldest idle simulation session ${oldestIdle.id.slice(0, 8)} to free pool slot`);
      await oldestIdle.close().catch(() => {});
    }
    if (sessions.size + activeCompiles.size > 4) throw new Error('Four simulations are already open or compiling. Close another session first.');
    const cfg = await configuration();
    if (compileToken.cancelled) throw new Error('Simulation compilation cancelled.');
    topLibrary = topLibrary.toLowerCase();
    const entities = new Set(), groups = new Map(), names = new Set(), baseNames = new Set(), manifests = [], dataFiles = [], normalizedSources = [];
    const diagnostics = [];
    for (const source of sources) {
      if (!source || typeof source.name !== 'string' || typeof source.text !== 'string') throw new Error('Invalid source/data filename or content.');
      const rel = source.name.replaceAll('\\', '/');
      if (!/^(?:[a-z0-9_][a-z0-9_. -]*\/)*[a-z0-9_][a-z0-9_. -]*\.(?:vhd|vhdl|vho|cf|hex|mif|mem|txt|dat)$/i.test(rel) || rel.split('/').some(seg => seg === '.' || seg === '..' || WIN_RESERVED.test(seg.replace(/\.[^.]+$/, '')))) {
        throw new Error('Invalid source/data filename or content.');
      }
      if (names.has(rel.toLowerCase())) throw new Error(`Duplicate filename: ${rel}`);
      names.add(rel.toLowerCase());
      baseNames.add(path.basename(rel).toLowerCase());
      if (/\.cf$/i.test(rel)) { manifests.push({ ...source, name: rel }); continue; }
      const library = (source.library || 'work').toLowerCase();
      if (!/^[a-z][a-z0-9_]*$/i.test(library) || WIN_RESERVED.test(library)) throw new Error('Invalid VHDL library name.');
      normalizedSources.push({ rel, library, text: source.text });
      if (/\.(vhd|vhdl|vho)$/i.test(rel)) {
        for (const m of source.text.replace(/--[^\n]*/g, '').matchAll(/\bentity\s+([a-z]\w*)\s+is\b/gi)) entities.add(m[1].toLowerCase());
        if (!groups.has(library)) groups.set(library, []);
        groups.get(library).push(rel);
      } else {
        dataFiles.push({ name: rel, text: source.text });
      }
    }
    for (const manifest of manifests) {
      if (!/^v\s+\d+\s*$/m.test(manifest.text)) throw new Error(`${manifest.name} is not a GHDL library manifest.`);
      const refs = [...manifest.text.matchAll(/^file\s+[^\n]*?"([^"]+)"/gm)].map(m => path.basename(m[1].replaceAll('\\', '/')));
      if (!refs.length) throw new Error(`${manifest.name} contains no source references.`);
      const missing = refs.filter(name => !names.has(name.toLowerCase()) && !baseNames.has(name.toLowerCase()));
      if (missing.length) throw new Error(`GHDL .cf files are library indexes, not portable executables. Also open the referenced sources: ${missing.join(', ')}.`);
      diagnostics.push(`${manifest.name}: recompiling accompanying sources; absolute paths and cached compiler hashes are not portable.`);
    }
    if (!groups.size) throw new Error('No VHDL sources to compile. Open the sources referenced by the library manifest.');

    const genericArgs = [];
    for (const [key, value] of Object.entries(generics)) {
      if (!/^[a-z]\w*$/i.test(key) || !['string', 'number', 'boolean'].includes(typeof value) || String(value).length > 4096 || /[\0\r\n]/.test(String(value))) throw new Error('Invalid generic name or value.');
      genericArgs.push(`-g${key}=${value}`);
    }

    // Deterministic build hash over GHDL version + language/top settings + all VHDL & data files
    const hashObj = createHash('sha256')
      .update(cfg.version + '\0' + standard + '\0' + topLibrary + '\0' + (top || '').toLowerCase() + '\0');
    for (const s of [...normalizedSources].sort((a, b) => a.rel.localeCompare(b.rel))) {
      hashObj.update(s.rel + '\0' + s.library + '\0' + s.text + '\0');
    }
    const buildHash = hashObj.digest('hex').slice(0, 20);
    const cacheDir = path.join(BUILD_CACHE_ROOT, buildHash);
    const cacheMetaPath = path.join(cacheDir, '.trace-cache.json');
    let cached = false;
    let resolvedTop = top;
    let cachedDiagnostics = [...diagnostics];

    if (inFlightCacheBuilds.has(buildHash)) {
      await inFlightCacheBuilds.get(buildHash).catch(() => {});
    }
    const cachedMeta = await fs.readFile(cacheMetaPath, 'utf8').then(t => JSON.parse(t)).catch(() => null);
    if (cachedMeta && typeof cachedMeta.top === 'string') {
      cached = true;
      resolvedTop = cachedMeta.top;
      if (Array.isArray(cachedMeta.diagnostics)) cachedDiagnostics = [...diagnostics, ...cachedMeta.diagnostics];
      const now = new Date();
      fs.utimes(cacheDir, now, now).catch(() => {});
      engineLog('info', `Build cache hit (${buildHash.slice(0, 8)}) for ${resolvedTop}`);
    } else {
      let resolveBuildLock;
      const buildLock = new Promise(r => { resolveBuildLock = r; });
      inFlightCacheBuilds.set(buildHash, buildLock);
      await fs.mkdir(BUILD_CACHE_ROOT, { recursive: true });
      const stagingDir = `${cacheDir}.${process.pid}.${Date.now()}.tmp`;
      await fs.mkdir(stagingDir, { recursive: true });
      try {
        for (const s of normalizedSources) {
          const dest = path.resolve(stagingDir, s.rel);
          const checkRel = path.relative(stagingDir, dest);
          if (checkRel.startsWith('..') || path.isAbsolute(checkRel)) throw new Error('Invalid source path.');
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.writeFile(dest, s.text);
        }
        const buildDiags = [];
        const options = { cwd: stagingDir, env: cfg.env, windowsHide: true, timeout: 30000, maxBuffer: 2e6, signal: compileToken.controller.signal };
        for (const [library, files] of groups) {
          const r = await exec(cfg.ghdl, ['-i', `--std=${standard}`, '-fsynopsys', '-fexplicit', `--work=${library}`, ...files], options);
          if (r.stderr) buildDiags.push(r.stderr.trim());
        }
        if (!resolvedTop) {
          const result = await exec(cfg.ghdl, ['--find-top', `--std=${standard}`, '-fsynopsys', '-fexplicit', `--work=${topLibrary}`, `-P${stagingDir}`], options);
          const candidates = result.stdout.trim().split(/\s+/).filter(Boolean);
          if (candidates.length !== 1) throw new Error(`Select a top entity. Candidates: ${candidates.join(', ') || [...entities].join(', ')}`);
          resolvedTop = candidates[0];
        }
        const flags = [`--std=${standard}`, '-fsynopsys', '-fexplicit', `--work=${topLibrary}`, `-P${stagingDir}`];
        const built = await exec(cfg.ghdl, ['-m', ...flags, resolvedTop], options);
        if (built.stderr) buildDiags.push(built.stderr.trim());
        await fs.writeFile(path.join(stagingDir, '.trace-cache.json'), JSON.stringify({ top: resolvedTop, diagnostics: buildDiags }), 'utf8');
        await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
        await fs.rename(stagingDir, cacheDir).catch(async () => {
          await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
        });
        cachedDiagnostics = [...diagnostics, ...buildDiags];
        pruneBuildCache();
      } catch (err) {
        await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
        throw err;
      } finally {
        inFlightCacheBuilds.delete(buildHash);
        resolveBuildLock?.();
      }
    }

    const trySynthRtl = async (workDir, extraFlags) => {
      try {
        const res = await exec(cfg.ghdl, ['synth', ...extraFlags, '--out=verilog', resolvedTop, ...genericArgs], {
          cwd: workDir, env: cfg.env, windowsHide: true, timeout: 12000, maxBuffer: 4e6, signal: compileToken.controller.signal,
        });
        return res.stdout ? compileSynthVerilogToModule(res.stdout) : null;
      } catch {
        return null;
      }
    };

    const runFlags = [`--std=${standard}`, '-fsynopsys', '-fexplicit', `--work=${topLibrary}`, `--workdir=${cacheDir}`, `-P${cacheDir}`];
    let rtlCode = null;
    if (!sdf) {
      const cachedRtlPath = path.join(cacheDir, 'rtl-v8.mjs');
      if (!genericArgs.length) {
        rtlCode = await fs.readFile(cachedRtlPath, 'utf8').catch(() => null);
      }
      if (!rtlCode) {
        rtlCode = await trySynthRtl(cacheDir, runFlags);
        if (rtlCode && !genericArgs.length) {
          await fs.writeFile(cachedRtlPath, rtlCode, 'utf8').catch(() => {});
        }
      }
    }
    const lintWarnings = lintVhdlHardwarePitfalls(sources);
    const allDiagnostics = [...cachedDiagnostics, ...lintWarnings];
    const runArgs = ['-r', ...runFlags, resolvedTop, ...genericArgs, `--vpi=${cfg.plugin}`, '--assert-level=error', '--stop-delta=10000'];
    const spec = { cfg, runArgs, cacheDir, dataFiles, sdf, top: resolvedTop, topLibrary, standard, entities: [...entities], diagnostics: allDiagnostics, buildHash, cached, rtlCode };
    return await spawnFromSpec(spec, compileToken);
  } catch (error) {
    throw new Error(error.stderr || error.message);
  } finally {
    activeCompiles.delete(compileToken);
  }
}

function vcdIdFor(index) {
  let s = '', x = index;
  do { s += String.fromCharCode(33 + (x % 94)); x = Math.floor(x / 94); } while (x > 0);
  return s;
}
function vcdBits(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    out += (ch === '0' || ch === 'L') ? '0' : (ch === '1' || ch === 'H') ? '1' : ch === 'Z' ? 'z' : 'x';
  }
  return out;
}
function vcdTimescale(precision) {
  const map = { '-15': '1fs', '-14': '10fs', '-13': '100fs', '-12': '1ps', '-11': '10ps', '-10': '100ps', '-9': '1ns', '-8': '10ns', '-7': '100ns', '-6': '1us', '-3': '1ms', '0': '1s' };
  return map[String(precision)] || '1fs';
}

class EngineSession {
  constructor(child, dir, spawnSpec = null) {
    this.id = randomUUID(); this.child = child; this.dir = dir; this.spawnSpec = spawnSpec;
    this.schema = null; this.samples = []; this.vcdHistory = []; this.logs = []; this.failure = null;
    this.pending = null; this.completed = null; this.lastUsed = Date.now();
    this.busy = true; this.time = 0n; this.closePromise = null;
    const output = readline.createInterface({ input: child.stdout });
    output.on('line', line => {
      if (this.failure || this.closing) return;
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
          if (this.vcdHistory.at(-1)?.time === data.time) this.vcdHistory[this.vcdHistory.length - 1] = sample;
          else {
            this.vcdHistory.push(sample);
            if (this.vcdHistory.length > 25000) this.vcdHistory.splice(1, 2500);
          }
          if (this.samples.length >= 50000) {
            this.child.kill();
            throw new Error('Signal event limit exceeded for one batch; reduce step size.');
          }
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
        engineLog('warn', `Session ${this.id.slice(0, 8)} timed out after 15s; killing GHDL process`);
        this.fail(new Error('GHDL did not respond within 15 seconds; simulation stopped.'));
        this.child.kill();
      }, 15000);
      this.pending = { resolve, reject, timer };
    });
  }
  async step({ cycles = 1, halfPeriod = '500000000000', clock = -1, inputs = [], stride = 1 }) {
    if (this.failure) throw this.failure;
    if (this.ended || this.closing) throw new Error('Simulation complete. Export its waveform or build again.');
    if (this.busy) throw new Error('A simulation step is already in progress.');
    if (!Number.isInteger(cycles) || cycles < 0 || cycles > 131072) throw new Error('Cycles must be 0–131072.');
    if (!Number.isInteger(stride) || stride < 1 || stride > 262144) throw new Error('Invalid sample stride.');
    if (!/^\d+$/.test(String(halfPeriod))) throw new Error('Half period must be a positive integer in simulator ticks.');
    const hp = BigInt(halfPeriod);
    if (hp < 1n || hp > 1000000000000000n || this.time + hp * BigInt(cycles * 2) > 18000000000000000000n) throw new Error('Time is outside the supported 64-bit simulation range; restart the simulation.');
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
    this.lastUsed = Date.now();
    const result = this.result();
    this.child.stdin.write(`R ${cycles * 2} ${hp} ${clock} ${lines.length} ${stride}\n${lines.length ? lines.join('\n') + '\n' : ''}`);
    return result;
  }
  buildVcd() {
    const signals = this.schema?.signals || [];
    const lines = [
      '$date', `  ${new Date().toUTCString()}`, '$end',
      '$version', '  Trace FPGA Workbench (GHDL)', '$end',
      '$timescale', `  ${vcdTimescale(this.schema?.precision ?? -15)}`, '$end',
    ];
    const tree = { children: new Map(), vars: [] };
    signals.forEach((sig, idx) => {
      const parts = String(sig.name || `sig_${idx}`).split('.');
      const leaf = parts.pop();
      let node = tree;
      for (const p of parts) {
        if (!node.children.has(p)) node.children.set(p, { children: new Map(), vars: [] });
        node = node.children.get(p);
      }
      const range = sig.width > 1 && Number.isInteger(sig.left) && Number.isInteger(sig.right) ? ` [${sig.left}:${sig.right}]` : '';
      node.vars.push({ id: vcdIdFor(idx), width: sig.width || 1, label: `${leaf}${range}` });
    });
    const emitTree = node => {
      for (const v of node.vars) lines.push(`$var wire ${v.width} ${v.id} ${v.label} $end`);
      for (const [scope, child] of node.children) {
        lines.push(`$scope module ${scope} $end`);
        emitTree(child);
        lines.push('$upscope $end');
      }
    };
    emitTree(tree);
    lines.push('$enddefinitions $end');
    const prev = Array(signals.length).fill(null);
    for (let sIdx = 0; sIdx < this.vcdHistory.length; sIdx++) {
      const sample = this.vcdHistory[sIdx];
      lines.push(`#${sample.time}`);
      if (sIdx === 0) lines.push('$dumpvars');
      for (let i = 0; i < signals.length; i++) {
        const bits = vcdBits(sample.values[i] || 'U'.repeat(signals[i].width || 1));
        if (sIdx > 0 && bits === prev[i]) continue;
        prev[i] = bits;
        const id = vcdIdFor(i);
        lines.push((signals[i].width || 1) === 1 ? `${bits}${id}` : `b${bits} ${id}`);
      }
      if (sIdx === 0) lines.push('$end');
    }
    return lines.join('\n') + '\n';
  }
  async exportVcd() {
    if (this.busy) throw new Error('Pause and finish the current step before exporting.');
    return this.close(true);
  }
  async close(capture = false) {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    sessions.delete(this.id);
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error('Simulation session closed.')); this.pending = null; }
    this.closePromise = (async () => {
      if (!this.ended) {
        if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded) this.child.stdin.end('Q\n');
        const timer = setTimeout(() => { try { this.child.kill(); } catch {} }, 1500);
        await this.closed;
        clearTimeout(timer);
      }
      try { return capture ? this.buildVcd() : undefined; }
      finally { await fs.rm(this.dir, { recursive: true, force: true }).catch(() => {}); }
    })();
    return this.closePromise;
  }
}

const idleCleanup = setInterval(() => {
  if (sessions.size <= 1) return;
  for (const session of sessions.values()) if (Date.now() - session.lastUsed > 4 * 60 * 60 * 1000 && !session.busy) session.close().catch(() => {});
}, 60000);
idleCleanup.unref();
