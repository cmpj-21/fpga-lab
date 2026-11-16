// VCD (Value Change Dump) export + import for waveform interchange with
// GHDL / ModelSim / GTKWave.
import { SL_CHARS, U, X, L0, L1, Z, W, L, H, DC, valToString } from './types.js';

const SL_TO_VCD = { [U]: 'x', [X]: 'x', [L0]: '0', [L1]: '1', [Z]: 'z', [W]: 'x', [L]: '0', [H]: '1', [DC]: 'x' };
const VCD_TO_SL = { '0': L0, '1': L1, 'x': X, 'X': X, 'z': Z, 'Z': Z, 'u': U, 'U': U, 'w': W, 'W': W, 'l': L, 'L': L, 'h': H, 'H': H, '-': DC };

export function slToVcd(code) { return SL_TO_VCD[code] ?? 'x'; }
export function vcdToSl(ch) { return VCD_TO_SL[ch] ?? X; }

function idGen() {
  let n = 0;
  return () => {
    let s = '';
    let x = n++;
    do { s += String.fromCharCode(33 + (x % 94)); x = Math.floor(x / 94); } while (x > 0);
    return s;
  };
}

function valueToVcd(v) {
  if (Array.isArray(v.v)) {
    if (v.t === 'int') {
      const bits = (v.v >>> 0).toString(2).padStart(32, '0');
      return 'b' + bits;
    }
    return 'b' + v.v.map(e => slToVcd(e)).join('');
  }
  if (v.t === 'sl') return slToVcd(v.v);
  if (v.t === 'int') return 'b' + ((v.v >>> 0).toString(2).padStart(32, '0'));
  if (v.t === 'real') return 'r' + v.v;
  if (v.t === 'bool') return v.v ? '1' : '0';
  if (v.t === 'time') return 'b' + (Number(v.v) >>> 0).toString(2).padStart(32, '0');
  return 'x';
}

// samples: [{ t: fs, values: Map(sigName -> typedValue) }]
export function writeVcd(design, samples, opts = {}) {
  const timescale = opts.timescale || '1ps';
  const scaleFs = { '1fs': 1, '1ps': 1e3, '1ns': 1e6, '1us': 1e9, '1ms': 1e12 }[timescale] || 1e3;
  const sigs = [...design.kernel.signals.values()].filter(s => s.trace);
  const nextId = idGen();
  const ids = new Map();
  for (const s of sigs) ids.set(s.name, nextId());
  const width = (s) => s.isArr ? s.value.v.length : (s.type === 'int' || s.type === 'time' ? 32 : 1);
  const lines = [];
  lines.push('$date', '  TRACE//LAB virtual bench', '$end');
  lines.push('$version', '  TRACE//LAB EP4CE6 Simulator', '$end');
  lines.push('$timescale', '  ' + timescale, '$end');
  lines.push(`$scope module ${design.topName || 'top'} $end`);
  for (const s of sigs) {
    const nm = s.name.includes('.') ? s.name.split('.').pop() : s.name;
    lines.push(`$var wire ${width(s)} ${ids.get(s.name)} ${nm} $end`);
  }
  lines.push('$upscope $end');
  lines.push('$enddefinitions $end');
  lines.push('$dumpvars');
  if (samples.length) {
    for (const s of sigs) {
      const v = samples[0].values.get(s.name);
      if (v !== undefined) lines.push(valueToVcd(v) + ' ' + ids.get(s.name));
    }
  }
  lines.push('$end');
  let lastT = -1;
  for (const sample of samples) {
    const t = Math.round(sample.t / scaleFs);
    if (t !== lastT) { lines.push('#' + t); lastT = t; }
    for (const s of sigs) {
      const v = sample.values.get(s.name);
      if (v === undefined) continue;
      const enc = valueToVcd(v);
      if (Array.isArray(v.v) || v.t === 'int' || v.t === 'real' || v.t === 'time') lines.push(enc + ' ' + ids.get(s.name));
      else lines.push(enc + ids.get(s.name));
    }
  }
  return lines.join('\n') + '\n';
}

export function parseVcd(text) {
  if (typeof text !== 'string' || text.length > 32 * 1024 * 1024) throw new Error('VCD replay accepts up to 32 MB of text.');
  const vars = [], events = [], scope = [], byId = new Map(), aliases = new Map(), names = new Set();
  const tokens = text.match(/\S+/g) || [];
  let timescaleFs = 1000, i = 0, cur, definitions = false, changes = 0;
  const eventAt = ticks => {
    if (!/^\d+$/.test(ticks)) throw new Error('Invalid VCD timestamp.');
    const exact = BigInt(ticks) * BigInt(timescaleFs);
    if (exact > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('VCD time exceeds the exact femtosecond display range (about 9 seconds).');
    const t = Number(exact);
    if (cur && t < cur.t) throw new Error('VCD timestamps must be nondecreasing.');
    if (!cur || cur.t !== t) { cur = { t, ticks, changes: [] }; events.push(cur); }
    if (events.length > 250000) throw new Error('VCD replay exceeds 250,000 timestamps. Export a shorter interval.');
  };
  while (i < tokens.length) {
    const token = tokens[i++];
    if (token === '$end' || /^\$dump(vars|all|off|on)$/.test(token)) continue;
    if (token.startsWith('$')) {
      const body = [];
      while (i < tokens.length && tokens[i] !== '$end') body.push(tokens[i++]);
      if (i === tokens.length) throw new Error(`Unterminated VCD directive ${token}.`);
      i++;
      if (token === '$timescale') {
        const match = body.join('').match(/^(1|10|100)(fs|ps|ns|us|ms|s)$/i);
        if (!match || definitions) throw new Error('Invalid VCD timescale.');
        timescaleFs = Number(match[1]) * { fs: 1, ps: 1e3, ns: 1e6, us: 1e9, ms: 1e12, s: 1e15 }[match[2].toLowerCase()];
      } else if (token === '$scope') {
        if (definitions || body.length !== 2) throw new Error('Invalid VCD scope.');
        scope.push(body[1]);
      } else if (token === '$upscope') {
        if (definitions || !scope.length) throw new Error('Unbalanced VCD scope.');
        scope.pop();
      } else if (token === '$var') {
        const [kind, size, id, reference, ...suffix] = body, width = Number(size);
        if (definitions || !id || !reference || !Number.isInteger(width) || width < 1 || width > 4096 || vars.length >= 4096) throw new Error('Invalid VCD declaration or signal limit (4096).');
        const fullReference = reference + suffix.join('');
        const range = fullReference.match(/^(.*?)\[(-?\d+)(?::(-?\d+))?\]$/);
        const shortName = range ? range[1] : reference;
        const left = range ? Number(range[2]) : width - 1, right = range ? Number(range[3] ?? range[2]) : 0;
        if (!['real', 'realtime'].includes(kind) && Math.abs(left - right) + 1 !== width) throw new Error(`VCD range does not match width: ${fullReference}.`);
        const name = [...scope, fullReference].join('.');
        if (names.has(name)) throw new Error(`Duplicate VCD signal: ${name}.`);
        names.add(name);
        const v = { id, name, shortName, reference: fullReference, kind, width, left, right, scope: scope.join('.') };
        if (byId.has(id) && (byId.get(id).width !== width || ['real','realtime'].includes(byId.get(id).kind) !== ['real','realtime'].includes(kind))) throw new Error(`Incompatible VCD aliases: ${id}.`);
        vars.push(v);
        if (!byId.has(id)) { byId.set(id, v); aliases.set(id, []); }
        aliases.get(id).push(v);
      } else if (token === '$enddefinitions') {
        if (definitions || scope.length) throw new Error('Unbalanced VCD definitions.');
        definitions = true;
      }
      continue;
    }
    if (!definitions) throw new Error('VCD values appear before $enddefinitions.');
    if (token.startsWith('#')) { eventAt(token.slice(1)); continue; }
    let id, value;
    if (/^[bB]/.test(token)) { id = tokens[i++]; value = token.slice(1).toUpperCase(); }
    else if (/^[rR]/.test(token)) {
      id = tokens[i++]; const real = token.slice(1);
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(real) || !Number.isFinite(Number(real))) throw new Error('Invalid VCD real value.');
      value = { real: Number(real) };
    } else { id = token.slice(1); value = token[0].toUpperCase(); }
    const variable = byId.get(id);
    if (!variable) throw new Error(`VCD value references undeclared identifier: ${id}.`);
    if (typeof value === 'string') {
      if (!/^[01UXZWLH-]+$/.test(value) || value.length > variable.width || ['real', 'realtime'].includes(variable.kind)) throw new Error(`Invalid VCD value for ${variable.name}.`);
      value = value.padStart(variable.width, /^[UXZWLH-]/.test(value) ? value[0] : '0');
    } else if (!['real', 'realtime'].includes(variable.kind)) throw new Error(`Real value for non-real VCD signal: ${variable.name}.`);
    if (!cur) eventAt('0');
    cur.changes.push({ id, value });
    if (++changes > 2000000) throw new Error('VCD replay exceeds two million value changes.');
  }
  if (!definitions || !vars.length) throw new Error('No complete VCD signal definitions found.');
  return { timescaleFs, vars, byId, aliases, events };
}

// reconstruct typed values from a parsed VCD for wave display
export function vcdValueToTyped(entry, width) {
  if (typeof entry === 'object' && entry.real !== undefined) return { t: 'real', v: entry.real };
  const s = String(entry);
  if (/^[01xzXZuUwWlLhH-]+$/.test(s) && s.length > 1) {
    const elems = [...s].map(vcdToSl);
    return { t: 'slv', v: elems, left: elems.length - 1, right: 0, dir: 'downto' };
  }
  if (s.length === 1) return { t: 'sl', v: vcdToSl(s) };
  const elems = [...s].map(vcdToSl);
  return { t: 'slv', v: elems, left: elems.length - 1, right: 0, dir: 'downto' };
}