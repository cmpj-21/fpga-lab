// Quartus .vo gate-level netlist importer + simulator (Cyclone IV E primitives).
// Parses structural Verilog and simulates lcell_comb (4-input LUT + carry),
// cycloneive_ff, io_ibuf/obuf, clkctrl on the shared event kernel.
import { Kernel } from './kernel.js';
import { sl, L0, L1, X, U, Z, to01, is1, is0, valToString, cloneVal } from './types.js';

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
const cleanNet = (n) => {
  n = n.trim();
  if (n.startsWith('\\')) { const sp = n.indexOf(' '); return sp >= 0 ? n.slice(1, sp) : n.slice(1); }
  return n;
};

export function parseVo(text) {
  const src = stripComments(text);
  const modMatch = src.match(/module\s+([A-Za-z_]\w*)\s*\(([\s\S]*?)\)\s*;([\s\S]*?)endmodule/);
  if (!modMatch) throw new Error('no module found in .vo netlist');
  const name = modMatch[1];
  const portList = modMatch[2].split(',').map(s => cleanNet(s)).filter(Boolean);
  const body = modMatch[3];
  const ports = [];
  const cells = [];
  const assigns = [];
  const declRe = /(input|output|inout)\s*(\[\s*(\d+)\s*:\s*(\d+)\s*\])?\s*([^;]+);/g;
  let m;
  while ((m = declRe.exec(body))) {
    const dir = m[1];
    const hi = m[3] !== undefined ? parseInt(m[3], 10) : null;
    const lo = m[4] !== undefined ? parseInt(m[4], 10) : null;
    for (const nm of m[5].split(',')) {
      const n = cleanNet(nm);
      if (n) ports.push({ name: n, dir, hi, lo });
    }
  }
  // statements split on ';' (structural primitives contain no inner ';')
  const defparams = new Map();
  const stmts = body.split(';');
  for (let st of stmts) {
    st = st.trim();
    if (!st) continue;
    if (st.startsWith('defparam')) {
      const dm = st.match(/^defparam\s+(\\[^\s]+|[A-Za-z_][\w$.\[\]]*)\s*\.(\w+)\s*=\s*([\s\S]+)$/);
      if (dm) {
        const inst = cleanNet(dm[1]);
        let v = dm[3].trim();
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        if (!defparams.has(inst)) defparams.set(inst, {});
        defparams.get(inst)[dm[2].toLowerCase()] = v;
      }
      continue;
    }
    if (/^(input|output|inout|wire|tri|supply|reg|parameter|localparam|initial|specify|timeprecision|timescale)/.test(st)) continue;
    if (st.startsWith('assign')) {
      const am = st.match(/^assign\s+([^=]+)=([\s\S]+)$/);
      if (am) assigns.push({ lhs: cleanNet(am[1]), rhs: am[2].trim() });
      continue;
    }
    const inst = splitInstance(st);
    if (inst) {
      const params = {};
      if (inst.params) {
        const pre = /\.(\w+)\s*\(\s*("(?:[^"]*)"|[^)]*?)\s*\)/g;
        let pm;
        while ((pm = pre.exec(inst.params))) {
          let v = pm[2].trim();
          if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
          params[pm[1].toLowerCase()] = v;
        }
      }
      const conns = {};
      const cre = /\.(\w+)\s*\(([^)]*)\)/g;
      let cm;
      while ((cm = cre.exec(inst.conns))) conns[cm[1].toLowerCase()] = cleanNet(cm[2]);
      cells.push({ cellType: inst.cellType, instName: inst.instName, params, conns });
    }
  }
  for (const c of cells) {
    const dp = defparams.get(c.instName);
    if (dp) Object.assign(c.params, dp);
  }
  return { name, portList, ports, cells, assigns };
}

function readBalanced(s, i) {
  // s[i] === '(' ; return [inner, endIndex] honoring quoted strings
  let depth = 0, j = i, inStr = false;
  for (; j < s.length; j++) {
    const ch = s[j];
    if (inStr) { if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return [s.slice(i + 1, j), j + 1]; }
  }
  return [s.slice(i + 1), s.length];
}

function splitInstance(st) {
  const tm = /^[A-Za-z_]\w*/.exec(st);
  if (!tm) return null;
  const cellType = tm[0];
  let i = tm[0].length;
  const ws = () => { while (i < st.length && /\s/.test(st[i])) i++; };
  ws();
  let params = null;
  if (st[i] === '#') {
    i++; ws();
    if (st[i] !== '(') return null;
    const [p, end] = readBalanced(st, i);
    params = p; i = end; ws();
  }
  let instName;
  if (st[i] === '\\') {
    const sp = st.indexOf(' ', i);
    if (sp < 0) return null;
    instName = st.slice(i + 1, sp); i = sp + 1;
  } else {
    const nm = /^[A-Za-z_][\w$.\[\]]*/.exec(st.slice(i));
    if (!nm) return null;
    instName = nm[0]; i += nm[0].length;
  }
  ws();
  if (st[i] !== '(') return null;
  const [conns] = readBalanced(st, i);
  return { cellType, params, instName, conns };
}

function normalizeMask(mask) {
  if (!mask) return null;
  mask = mask.replace(/\s/g, '');
  if (/^[01]{16}$/.test(mask)) return mask;
  if (/^[0-9a-fA-F]{4}$/.test(mask)) {
    let bits = '';
    for (const c of mask) bits += parseInt(c, 16).toString(2).padStart(4, '0');
    return bits;
  }
  if (/^[01]+$/.test(mask)) return mask.padStart(16, '0').slice(-16);
  return null;
}

export class NetlistSim {
  constructor(netlist) {
    this.nl = netlist;
    this.kernel = new Kernel();
    this.nets = new Map();
    this.ports = [];
    this.errors = [];
    this.cellCount = { comb: 0, ff: 0, io: 0, other: 0 };
    this._build();
  }
  net(name) {
    if (name === '' || name === undefined) return null;
    if (/^1'b[01xz]$/i.test(name)) {
      const c = name[3].toLowerCase();
      const key = `const_${c}`;
      if (!this.nets.has(key)) {
        const s = this.kernel.addSignal(key, 'sl', null, sl(c === '1' ? L1 : c === '0' ? L0 : X));
        this.nets.set(key, s);
      }
      return this.nets.get(key);
    }
    if (name === 'gnd' || name === 'vcc' || name === '1\'b0' || name === '1\'b1') {
      const key = `const_${name}`;
      if (!this.nets.has(key)) this.nets.set(key, this.kernel.addSignal(key, 'sl', null, sl(name === 'vcc' || name.endsWith('1') ? L1 : L0)));
      return this.nets.get(key);
    }
    if (!this.nets.has(name)) this.nets.set(name, this.kernel.addSignal(name, 'sl', null, null));
    return this.nets.get(name);
  }
  _build() {
    const K = this.kernel;
    // top port signals
    for (const p of this.nl.ports) {
      if (p.hi !== null) {
        for (let i = p.hi; i >= p.lo; i--) {
          const nm = `${p.name}[${i}]`;
          const sig = this.net(nm);
          this.ports.push({ name: nm, base: p.name, index: i, dir: p.dir, sig });
        }
      } else {
        const sig = this.net(p.name);
        this.ports.push({ name: p.name, base: p.name, index: null, dir: p.dir, sig });
      }
    }
    let pid = 0;
    const mkProc = (sensNets, fn, label) => {
      const sens = new Set(sensNets.filter(Boolean));
      const proc = { id: 100000 + (pid++), name: label, sens, state: 'idle', gen: null, dead: false, makeGen: fn };
      K.addProcess(proc);
      return proc;
    };
    const drive = (sig, val, proc) => {
      if (!sig) return;
      const d = sig.getDriver(`${proc.id}:${sig.id}`, proc.id, 0, 0);
      K.schedule(sig, d, val, K.time, false);
    };
    const rd = (n) => { const s = this.net(n); return s ? s.value.v : U; };

    for (const c of this.nl.cells) {
      const t = c.cellType.toLowerCase();
      const cn = c.conns;
      if (t === 'cycloneive_io_ibuf' || t === 'io_ibuf') {
        this.cellCount.io++;
        const inp = this.net(cn.i), outp = this.net(cn.o);
        mkProc([inp], function* () { drive(outp, sl(rd(cn.i)), this); }, c.instName);
      } else if (t === 'cycloneive_io_obuf' || t === 'io_obuf') {
        this.cellCount.io++;
        const inp = this.net(cn.i), outp = this.net(cn.o);
        const oe = cn.oe ? this.net(cn.oe) : null;
        mkProc([inp, oe], function* () {
          const en = oe ? rd(cn.oe) : L1;
          drive(outp, sl(is0(en) ? Z : rd(cn.i)), this);
        }, c.instName);
      } else if (t === 'cycloneive_clkctrl' || t === 'clkctrl') {
        this.cellCount.other++;
        const inp = this.net(cn.inclk), outp = this.net(cn.outclk);
        mkProc([inp], function* () { drive(outp, sl(rd(cn.inclk)), this); }, c.instName);
      } else if (t === 'cycloneive_lcell_comb' || t === 'lcell_comb') {
        this.cellCount.comb++;
        const mask = normalizeMask(c.params.lut_mask);
        const arith = (c.params.sum_lutc_input || '').toLowerCase() === 'cin';
        const da = this.net(cn.dataa), db = this.net(cn.datab), dc = this.net(cn.datac), dd = this.net(cn.datad);
        const cin = cn.cin ? this.net(cn.cin) : null;
        const combout = this.net(cn.combout), cout = cn.cout ? this.net(cn.cout) : null;
        const sens = [da, db, dc, dd, cin];
        mkProc(sens, function* () {
          const a = to01(rd(cn.dataa)), b = to01(rd(cn.datab));
          const cc = arith && cin ? to01(rd(cn.cin)) : to01(rd(cn.datac));
          const d = to01(rd(cn.datad));
          let out;
          if (!mask) out = X;
          else if (a === X || b === X || cc === X || d === X) {
            // resolve X inputs against the mask: if output independent of X inputs, keep value
            out = resolveLutX(mask, a, b, cc, d);
          } else {
            const idx = (a === L1 ? 1 : 0) | (b === L1 ? 2 : 0) | (cc === L1 ? 4 : 0) | (d === L1 ? 8 : 0);
            out = mask[15 - idx] === '1' ? L1 : L0;
          }
          drive(combout, sl(out), this);
          if (cout && arith) {
            const carry = (a === X || b === X || cc === X) ? X : ((is1(a) && is1(b)) || (is1(cc) && (is1(a) || is1(b))) ? L1 : L0);
            drive(cout, sl(carry), this);
          }
        }, c.instName);
      } else if (t === 'cycloneive_ff' || t === 'dff' || t === 'lcell_ff') {
        this.cellCount.ff++;
        const clk = this.net(cn.clk), clrn = cn.clrn ? this.net(cn.clrn) : null, prn = cn.prn ? this.net(cn.prn) : null;
        const ena = cn.ena ? this.net(cn.ena) : null;
        const d = this.net(cn.d), q = this.net(cn.q);
        const powerUp = (c.params.power_up || 'low').toLowerCase();
        if (q && powerUp === 'high') q.initVal = sl(L1);
        const proc = mkProc([clk, clrn, prn], null, c.instName);
        proc.makeGen = function* () {
          const self = this;
          if (clrn && is0(rd(cn.clrn))) { drive(q, sl(L0), self); return; }
          if (prn && is0(rd(cn.prn))) { drive(q, sl(L1), self); return; }
          const clkV = rd(cn.clk);
          const last = clk ? clk.lastValue.v : U;
          const en = ena ? rd(cn.ena) : L1;
          if (clk && clk.eventCurrent && clkV === L1 && last === L0 && is1(en)) {
            drive(q, sl(to01(rd(cn.d))), self);
          }
        };
      } else {
        this.cellCount.other++;
        // unknown primitive: tie outputs to X, keep simulating the rest
        for (const k of ['o', 'q', 'combout', 'outclk', 'cout']) {
          if (cn[k]) { const s = this.net(cn[k]); if (s) s.initVal = sl(X); }
        }
        this.errors.push(`unsupported primitive '${c.cellType}' (${c.instName}) — output tied X`);
      }
    }
    // continuous assigns (buffer / invert / simple gate)
    for (const a of this.nl.assigns) {
      const lhs = this.net(a.lhs);
      const rhs = a.rhs;
      const sensNets = [];
      const netRefs = rhs.match(/\\?[A-Za-z_][\w$.\[\]]*/g) || [];
      for (const n of netRefs) { const s = this.net(cleanNet(n)); if (s) sensNets.push(s); }
      mkProc(sensNets, function* () {
        drive(lhs, sl(evalSimpleRhs(rhs, (n) => rd(cleanNet(n)))), this);
      }, 'assign_' + a.lhs);
    }
  }
  setInput(name, value) {
    const p = this.ports.find(p => p.name === name && p.dir === 'input');
    if (p) this.kernel.setEnvValue(p.sig, value);
  }
  getOutput(name) {
    const p = this.ports.find(p => p.name === name);
    return p ? p.sig.value : null;
  }
  settle() { return this.kernel.settle(); }
}

function resolveLutX(mask, a, b, c, d) {
  const inputs = [a, b, c, d];
  const xIdx = inputs.map((v, i) => v === X ? i : -1).filter(i => i >= 0);
  let result = null;
  const combos = 1 << xIdx.length;
  for (let m = 0; m < combos; m++) {
    const vals = inputs.slice();
    xIdx.forEach((idx, k) => { vals[idx] = (m >> k) & 1 ? L1 : L0; });
    const idx = (vals[0] === L1 ? 1 : 0) | (vals[1] === L1 ? 2 : 0) | (vals[2] === L1 ? 4 : 0) | (vals[3] === L1 ? 8 : 0);
    const bit = mask[15 - idx] === '1' ? L1 : L0;
    if (result === null) result = bit;
    else if (result !== bit) return X;
  }
  return result === null ? X : result;
}

function evalSimpleRhs(rhs, rd) {
  let r = rhs.trim();
  if (/^1'b[01xz]$/i.test(r)) { const c = r[3].toLowerCase(); return c === '1' ? L1 : c === '0' ? L0 : X; }
  if (r.startsWith('~') || r.startsWith('!')) return to01(rd(r.slice(1).trim())) === L1 ? L0 : L1;
  const bin = r.match(/^(.+?)\s*([&|^])\s*(.+)$/);
  if (bin) {
    const a = to01(evalSimpleRhs(bin[1], rd)), b = to01(evalSimpleRhs(bin[3], rd));
    if (bin[2] === '&') return (is1(a) && is1(b)) ? L1 : (is0(a) || is0(b)) ? L0 : X;
    if (bin[2] === '|') return (is1(a) || is1(b)) ? L1 : (is0(a) && is0(b)) ? L0 : X;
    if (bin[2] === '^') return (a === X || b === X) ? X : (a === b ? L0 : L1);
  }
  return to01(rd(r));
}