// Expression evaluator + sequential statement interpreter (generator-based).
import {
  U, X, L0, L1, Z, W, L, H, DC, SL_CHARS,
  sl, int, bool, real, timeV, enumV, charV, strV, arr, slv, unsigned, signed, bv,
  arrLen, arrIndex, arrSetIndex, arrSlice, cloneVal, slvFromString, valToString,
  and2, or2, xor2, nand2, nor2, xnor2, not1, to01, is1, is0,
  bitsToBig, bigToArr, xArr, numericOf, truthy, valsEqual, valsCompare, resolveVec,
} from './types.js';

const LOGIC_TABLES = { and: and2, or: or2, xor: xor2, nand: nand2, nor: nor2, xnor: xnor2 };
const ARRAY_TYPES = ['slv', 'unsigned', 'signed', 'bv', 'string'];
const NUM_ARRAYS = ['slv', 'unsigned', 'signed'];

export const typeName = (n) => n.split('.').pop().toLowerCase();

export class Interp {
  constructor(design) {
    this.design = design;
    this.kernel = design.kernel;
  }

  // ---------- name resolution ----------
  lookup(inst, name) {
    let sc = inst;
    while (sc) {
      if (sc.signals && sc.signals.has(name)) return { kind: 'signal', sig: sc.signals.get(name) };
      if (sc.ports && sc.ports.has(name)) return { kind: 'signal', sig: sc.ports.get(name).sig, port: sc.ports.get(name) };
      if (sc.consts && sc.consts.has(name)) return { kind: 'const', value: sc.consts.get(name) };
      if (sc.generics && sc.generics.has(name)) return { kind: 'const', value: sc.generics.get(name) };
      if (sc.types && sc.types.has(name)) return { kind: 'type', type: sc.types.get(name) };
      if (sc.subprograms && sc.subprograms.has(name)) return { kind: 'func', decls: sc.subprograms.get(name) };
      if (sc.components && sc.components.has(name)) return { kind: 'component', decl: sc.components.get(name) };
      sc = sc.scopeParent;
    }
    const d = this.design;
    if (d.consts.has(name)) return { kind: 'const', value: d.consts.get(name) };
    if (d.types.has(name)) return { kind: 'type', type: d.types.get(name) };
    if (d.subprograms.has(name)) return { kind: 'func', decls: d.subprograms.get(name) };
    if (d.enumLiterals.has(name)) return { kind: 'enum', ...d.enumLiterals.get(name) };
    return null;
  }

  resolveSignal(node, env) {
    if (node.kind === 'name') {
      const r = this.lookup(env.inst, node.name);
      if (r && r.kind === 'signal') return r.sig;
      return null;
    }
    if (node.kind === 'indexed' || node.kind === 'attribute' || node.kind === 'selected') {
      return this.resolveSignal(node.prefix, env);
    }
    return null;
  }

  collectSens(node, env, set) {
    if (!node || typeof node !== 'object') return set;
    if (node.kind === 'name') {
      const r = this.lookup(env.inst, node.name);
      if (r && r.kind === 'signal') set.add(r.sig);
      return set;
    }
    if (node.kind === 'indexed') {
      this.collectSens(node.prefix, env, set);
      for (const a of node.args) {
        if (a.kind === 'sliceArg') { this.collectSens(a.left, env, set); this.collectSens(a.right, env, set); }
        else this.collectSens(a, env, set);
      }
      return set;
    }
    if (node.kind === 'selected' || node.kind === 'attribute') { this.collectSens(node.prefix, env, set); return set; }
    if (node.kind === 'binary') { this.collectSens(node.left, env, set); this.collectSens(node.right, env, set); return set; }
    if (node.kind === 'unary') { this.collectSens(node.operand, env, set); return set; }
    if (node.kind === 'aggregate') {
      for (const e of node.elems) {
        this.collectSens(e.value, env, set);
        if (e.choices) for (const c of e.choices) { if (c.value) this.collectSens(c.value, env, set); if (c.left) { this.collectSens(c.left, env, set); this.collectSens(c.right, env, set); } }
      }
      return set;
    }
    return set;
  }

  // ---------- ranges ----------
  evalRange(node, env) {
    if (!node) throw new Error('missing range');
    if (node.kind === 'range') {
      const l = this.evalExpr(node.left, env).v;
      const r = this.evalExpr(node.right, env).v;
      return { left: l, right: r, dir: node.dir };
    }
    if (node.kind === 'rangeExpr') {
      const v = this.evalExpr(node.expr, env);
      if (v && v.t === 'range') return { left: v.left, right: v.right, dir: v.dir };
      if (v && Array.isArray(v.v)) return { left: v.left, right: v.right, dir: v.dir };
      if (v && v.t === 'type' && v.type.range) return v.type.range;
      throw new Error('expression does not denote a range');
    }
    const v = this.evalExpr(node, env);
    if (v && v.t === 'range') return v;
    if (v && Array.isArray(v.v)) return { left: v.left, right: v.right, dir: v.dir };
    if (node.kind === 'name') {
      const r = this.lookup(env.inst, node.name);
      if (r && r.kind === 'type' && r.type.range) return r.type.range;
      if (r && r.kind === 'signal' && r.sig.isArr) return r.sig.range;
    }
    throw new Error('cannot evaluate range');
  }

  // ---------- expressions ----------
  evalExpr(node, env, hint = null) {
    switch (node.kind) {
      case 'num': return int(node.value);
      case 'real': return real(node.value);
      case 'charlit': {
        const up = node.value.toUpperCase();
        const idx = SL_CHARS.indexOf(up);
        if (idx >= 0 && node.value.length === 1) return sl(idx);
        return charV(node.value);
      }
      case 'bitstr': return this.evalBitstr(node);
      case 'name': return this.evalName(node.name, env);
      case 'indexed': return this.evalIndexed(node, env, hint);
      case 'selected': return this.evalSelected(node, env, hint);
      case 'attribute': return this.evalAttribute(node, env);
      case 'binary': return this.evalBinary(node, env, hint);
      case 'unary': return this.evalUnary(node, env, hint);
      case 'aggregate': return this.evalAggregate(node, env, hint);
      default: throw new Error(`cannot evaluate expression kind '${node.kind}'`);
    }
  }

  evalBitstr(node) {
    const s = node.value;
    const raw = node.raw !== undefined ? node.raw : s;
    if (node.base === 'b') {
      if (/^[01]+$/.test(s)) return slvFromString(s, 'slv');
      return strV(raw);
    }
    if (node.base === 'x') {
      if (!/^[0-9a-f]+$/.test(s)) return strV(raw);
      let bits = '';
      for (const c of s) bits += parseInt(c, 16).toString(2).padStart(4, '0');
      return slvFromString(bits, 'slv');
    }
    if (node.base === 'o') {
      let bits = '';
      for (const c of s) bits += parseInt(c, 8).toString(2).padStart(3, '0');
      return slvFromString(bits, 'slv');
    }
    if (node.base === 'd') {
      const n = parseInt(s, 10);
      return slvFromString(n.toString(2), 'slv');
    }
    return strV(raw);
  }

  evalName(name, env) {
    if (env.vars.has(name)) return env.vars.get(name);
    if (name === 'true') return bool(true);
    if (name === 'false') return bool(false);
    if (name === 'now') return timeV(this.kernel.time);
    if (['note', 'warning', 'error', 'failure'].includes(name)) return { t: 'severity', v: name };
    const r = this.lookup(env.inst, name);
    if (!r) {
      // zero-arg builtin?
      const b = this.callBuiltin(name, [], env, null);
      if (b !== undefined) return b;
      throw new Error(`unknown identifier '${name}'`);
    }
    switch (r.kind) {
      case 'signal': return r.sig.value;
      case 'const': return r.value;
      case 'enum': return enumV(r.type, r.idx);
      case 'type': return { t: 'type', type: r.type };
      case 'func': return this.callUserFunction(r.decls, [], env, null);
      default: throw new Error(`'${name}' is not a value`);
    }
  }

  evalSelected(node, env, hint) {
    // flatten a.b.c
    const parts = [];
    let n = node;
    while (n.kind === 'selected') { parts.unshift(n.sel); n = n.prefix; }
    if (n.kind === 'name') parts.unshift(n.name);
    const full = parts.join('.');
    const last = parts[parts.length - 1];
    if (env.vars.has(last)) return env.vars.get(last);
    const r = this.lookup(env.inst, last) || this.lookup(env.inst, full);
    if (r) {
      if (r.kind === 'const') return r.value;
      if (r.kind === 'signal') return r.sig.value;
      if (r.kind === 'enum') return enumV(r.type, r.idx);
      if (r.kind === 'func') return this.callUserFunction(r.decls, [], env, hint);
    }
    const b = this.callBuiltin(last, [], env, hint);
    if (b !== undefined) return b;
    throw new Error(`unknown selected name '${full}'`);
  }

  evalIndexed(node, env, hint) {
    // attribute with argument: T'image(x), enum'pos(x), T'val(x)
    if (node.prefix.kind === 'attribute') {
      return this.evalAttrCall(node.prefix, node.args, env);
    }
    // resolve base name
    let baseName = null;
    if (node.prefix.kind === 'name') baseName = node.prefix.name;
    else if (node.prefix.kind === 'selected') {
      const parts = [];
      let n = node.prefix;
      while (n.kind === 'selected') { parts.unshift(n.sel); n = n.prefix; }
      if (n.kind === 'name') parts.unshift(n.name);
      baseName = parts[parts.length - 1];
    }
    if (baseName !== null) {
      if (env.vars.has(baseName)) {
        return this.indexValue(env.vars.get(baseName), node.args, env);
      }
      const r = this.lookup(env.inst, baseName);
      if (r && (r.kind === 'signal' || r.kind === 'const')) {
        const val = r.kind === 'signal' ? r.sig.value : r.value;
        if (Array.isArray(val.v) || val.t === 'string') return this.indexValue(val, node.args, env);
      }
      if (r && r.kind === 'type' && r.type.range && node.args.length === 1) {
        // subtype conversion / qualification: treat as conversion
        return this.convertType(baseName, node.args.map(a => this.evalExpr(a, env)), env, hint);
      }
      // function call
      const args = node.args.map(a => this.evalExpr(a, env));
      if (r && r.kind === 'func') return this.callUserFunction(r.decls, args, env, hint);
      const b = this.callBuiltin(baseName, args, env, hint, node);
      if (b !== undefined) return b;
      if (r && r.kind === 'type') return this.convertType(baseName, args, env, hint);
      throw new Error(`unknown function or indexed name '${baseName}'`);
    }
    // nested indexing
    const pv = this.evalExpr(node.prefix, env);
    return this.indexValue(pv, node.args, env);
  }

  indexValue(val, args, env) {
    if (val.t === 'string') {
      const i = this.evalExpr(args[0], env).v;
      return charV(val.v[i - 1] ?? ' ');
    }
    if (!Array.isArray(val.v)) throw new Error('indexing a scalar value');
    if (args[0] && args[0].kind === 'sliceArg') {
      const l = this.evalExpr(args[0].left, env).v;
      const r = this.evalExpr(args[0].right, env).v;
      return arrSlice(val, l, r);
    }
    const i = this.evalExpr(args[0], env).v;
    const e = arrIndex(val, i);
    if (e === undefined) throw new Error(`index ${i} out of range (${val.left}..${val.right})`);
    if (val.t === 'int') return int(e);
    if (val.t === 'bv') return sl(e ? L1 : L0);
    return sl(e);
  }

  evalAttrCall(attrNode, args, env) {
    const attr = attrNode.attr;
    const arg = this.evalExpr(args[0], env);
    const base = this.evalExpr(attrNode.prefix, env);
    if (attr === 'image') return strV(valToString(arg));
    if (attr === 'value') {
      const s = arg.t === 'string' ? arg.v : valToString(arg);
      if (base.t === 'type') {
        const ty = base.type;
        if (ty.base === 'int') return int(parseInt(s, 10));
        if (ty.base === 'enum') { const i = ty.enumType.literals.indexOf(s.toLowerCase()); return enumV(ty.enumType, i); }
        if (ty.base === 'sl') return sl(SL_CHARS.indexOf(s.toUpperCase()));
        if (ty.base === 'time') return timeV(parseInt(s, 10));
      }
      return strV(s);
    }
    if (attr === 'pos') {
      if (arg.t === 'enum') return int(arg.v);
      if (arg.t === 'char') return int(arg.v.charCodeAt(0));
      return int(arg.v);
    }
    if (attr === 'val') {
      if (base.t === 'type' && base.type.base === 'enum') return enumV(base.type.enumType, arg.v);
      if (base.t === 'type' && base.type.base === 'char') return charV(String.fromCharCode(arg.v));
      return int(arg.v);
    }
    if (attr === 'succ' || attr === 'pred' || attr === 'leftof' || attr === 'rightof') {
      const d = attr === 'succ' || attr === 'rightof' ? 1 : -1;
      if (arg.t === 'enum') return enumV(arg.type, arg.v + d);
      if (arg.t === 'char') return charV(String.fromCharCode(arg.v.charCodeAt(0) + d));
      return int(arg.v + d);
    }
    throw new Error(`unsupported attribute call '${attr}`);
  }

  evalAttribute(node, env) {
    const attr = node.attr;
    // type attributes: integer'high etc.
    if (node.prefix.kind === 'name') {
      const r = this.lookup(env.inst, node.prefix.name);
      if (r && r.kind === 'type') {
        const ty = r.type;
        if (attr === 'left' || attr === 'right' || attr === 'high' || attr === 'low') {
          if (ty.range) return int(attr === 'left' ? ty.range.left : attr === 'right' ? ty.range.right : attr === 'high' ? Math.max(ty.range.left, ty.range.right) : Math.min(ty.range.left, ty.range.right));
          if (ty.base === 'int') return int(attr === 'high' ? 2147483647 : attr === 'low' ? -2147483648 : 0);
        }
        if (attr === 'range' && ty.range) return { t: 'range', ...ty.range };
        if (attr === 'length' && ty.range) return int(arrLen(ty.range));
      }
      if (r && r.kind === 'signal') {
        const sig = r.sig;
        switch (attr) {
          case 'event': return bool(sig.eventCurrent);
          case 'active': return bool(sig.eventPending || sig.eventCurrent);
          case 'last_value': return sig.lastValue || sig.value;
          case 'last_event': return timeV(sig.lastEvent < 0 ? 0 : this.kernel.time - sig.lastEvent);
          case 'stable': return bool(!sig.eventCurrent);
          case 'quiet': return bool(!sig.eventPending && !sig.eventCurrent);
          case 'transaction': return bool(sig.eventCurrent);
          case 'delayed': return sig.value;
          case 'driving': return bool(true);
        }
        const v = sig.value;
        if (Array.isArray(v.v)) {
          if (attr === 'length') return int(arrLen(v));
          if (attr === 'left') return int(v.left);
          if (attr === 'right') return int(v.right);
          if (attr === 'high') return int(Math.max(v.left, v.right));
          if (attr === 'low') return int(Math.min(v.left, v.right));
          if (attr === 'range') return { t: 'range', left: v.left, right: v.right, dir: v.dir };
          if (attr === 'reverse_range') return { t: 'range', left: v.right, right: v.left, dir: v.dir === 'downto' ? 'to' : 'downto' };
          if (attr === 'ascending') return bool(v.dir === 'to');
        }
        if (attr === 'length') return int(1);
        if (attr === 'range' && sig.range) return { t: 'range', ...sig.range };
      }
    }
    const v = this.evalExpr(node.prefix, env);
    if (Array.isArray(v.v)) {
      if (attr === 'length') return int(arrLen(v));
      if (attr === 'left') return int(v.left);
      if (attr === 'right') return int(v.right);
      if (attr === 'high') return int(Math.max(v.left, v.right));
      if (attr === 'low') return int(Math.min(v.left, v.right));
      if (attr === 'range') return { t: 'range', left: v.left, right: v.right, dir: v.dir };
      if (attr === 'reverse_range') return { t: 'range', left: v.right, right: v.left, dir: v.dir === 'downto' ? 'to' : 'downto' };
      if (attr === 'ascending') return bool(v.dir === 'to');
    }
    if (v.t === 'range') {
      if (attr === 'length') return int(arrLen(v));
      if (attr === 'left') return int(v.left);
      if (attr === 'right') return int(v.right);
    }
    if (attr === 'image') return strV(valToString(v));
    throw new Error(`unsupported attribute '${attr}`);
  }

  // ---------- operators ----------
  evalBinary(node, env, hint) {
    const op = node.op;
    if (op === '&') {
      const a = this.evalExpr(node.left, env);
      const b = this.evalExpr(node.right, env);
      return this.concat(a, b);
    }
    const a = this.evalExpr(node.left, env);
    const b = this.evalExpr(node.right, env);
    if (['=', '/=', '<', '<=', '>', '>='].includes(op)) {
      let eq;
      if (op === '=' || op === '/=') eq = valsEqual(a, b);
      else {
        const c = valsCompare(a, b);
        if (c === null) return bool(false);
        eq = op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0;
      }
      return bool(op === '/=' ? !eq : eq);
    }
    if (LOGIC_TABLES[op]) return this.logicOp(op, a, b);
    if (['sll', 'srl', 'sla', 'sra', 'rol', 'ror'].includes(op)) return this.shiftOp(op, a, b);
    if (['+', '-', '*', '/', 'mod', 'rem', '**'].includes(op)) return this.arithOp(op, a, b, env);
    throw new Error(`unsupported operator '${op}'`);
  }

  concat(a, b) {
    if (a.t === 'string' || b.t === 'string') {
      const sa = a.t === 'string' ? a.v : valToString(a);
      const sb = b.t === 'string' ? b.v : valToString(b);
      return strV(sa + sb);
    }
    const av = Array.isArray(a.v) ? a.v : [a.v];
    const bv2 = Array.isArray(b.v) ? b.v : [b.v];
    const elems = av.concat(bv2);
    const t = ARRAY_TYPES.includes(a.t) ? a.t : (ARRAY_TYPES.includes(b.t) ? b.t : 'slv');
    const dir = Array.isArray(a.v) ? a.dir : 'downto';
    const left = Array.isArray(a.v) ? a.left : (dir === 'downto' ? elems.length - 1 : 0);
    const right = dir === 'downto' ? left - elems.length + 1 : left + elems.length - 1;
    return arr(t === 'string' ? 'slv' : t, elems, left, right);
  }

  logicOp(op, a, b) {
    const fn = LOGIC_TABLES[op];
    if (a.t === 'bool' && b.t === 'bool') {
      const x = a.v, y = b.v;
      switch (op) {
        case 'and': return bool(x && y);
        case 'or': return bool(x || y);
        case 'nand': return bool(!(x && y));
        case 'nor': return bool(!(x || y));
        case 'xor': return bool(x !== y);
        case 'xnor': return bool(x === y);
      }
    }
    if (a.t === 'sl' && b.t === 'sl') return sl(fn(a.v, b.v));
    const aArr = Array.isArray(a.v), bArr = Array.isArray(b.v);
    if (aArr && bArr) {
      if (a.v.length !== b.v.length) throw new Error(`logic op '${op}' length mismatch ${a.v.length} vs ${b.v.length}`);
      const out = a.v.map((e, i) => fn(e, b.v[i]));
      return arr(a.t, out, a.left, a.right);
    }
    if (aArr && b.t === 'sl') return arr(a.t, a.v.map(e => fn(e, b.v)), a.left, a.right);
    if (a.t === 'sl' && bArr) return arr(b.t, b.v.map(e => fn(a.v, e)), b.left, b.right);
    throw new Error(`logic op '${op}' on unsupported types ${a.t}/${b.t}`);
  }

  shiftOp(op, a, b) {
    const n = Number(numericOf(b) ?? 0n);
    if (Array.isArray(a.v)) {
      const len = a.v.length;
      const out = new Array(len);
      const fill = op === 'sra' ? a.v[0] : L0;
      for (let i = 0; i < len; i++) {
        let src;
        if (op === 'sll' || op === 'sla') src = i + n;
        else if (op === 'srl' || op === 'sra') src = i - n;
        else if (op === 'rol') src = (i + n) % len;
        else src = ((i - n) % len + len) % len;
        if (op === 'rol' || op === 'ror') out[i] = a.v[(src + len) % len];
        else out[i] = (src >= 0 && src < len) ? a.v[src] : (op === 'sla' ? L0 : fill);
      }
      return arr(a.t, out, a.left, a.right);
    }
    const v = Number(numericOf(a) ?? 0n);
    switch (op) {
      case 'sll': return int(v << n);
      case 'srl': return int(v >>> n);
      case 'sla': return int(v << n);
      case 'sra': return int(v >> n);
      case 'rol': return int(((v << n) | (v >>> (32 - n))) | 0);
      case 'ror': return int(((v >>> n) | (v << (32 - n))) | 0);
    }
    throw new Error(`bad shift ${op}`);
  }

  arithOp(op, a, b, env) {
    if (op === '**') {
      if (a.t === 'real' || b.t === 'real') return real(Math.pow(Number(a.v), Number(b.v)));
      const base = numericOf(a), ex = numericOf(b);
      if (base === null || ex === null) throw new Error('X in exponentiation');
      return int(Number(base ** ex));
    }
    if (a.t === 'real' || b.t === 'real') {
      const x = Number(a.t === 'real' ? a.v : numericOf(a));
      const y = Number(b.t === 'real' ? b.v : numericOf(b));
      switch (op) {
        case '+': return real(x + y);
        case '-': return real(x - y);
        case '*': return real(x * y);
        case '/': return real(x / y);
        case 'mod': return real(x - Math.floor(x / y) * y);
        case 'rem': return real(x % y);
      }
    }
    const aArr = NUM_ARRAYS.includes(a.t), bArr = NUM_ARRAYS.includes(b.t);
    if (!aArr && !bArr) {
      const x = numericOf(a), y = numericOf(b);
      if (x === null || y === null) throw new Error('X in integer arithmetic');
      let r;
      switch (op) {
        case '+': r = x + y; break;
        case '-': r = x - y; break;
        case '*': r = x * y; break;
        case '/': if (y === 0n) throw new Error('division by zero'); r = x / y; break;
        case 'mod': if (y === 0n) throw new Error('mod by zero'); r = ((x % y) + y) % y; break;
        case 'rem': if (y === 0n) throw new Error('rem by zero'); r = x % y; break;
      }
      return int(Number(r));
    }
    // numeric_std / std_logic_arith array arithmetic
    const signedMode = a.t === 'signed' || b.t === 'signed' || (this.design.arithSigned && (a.t === 'slv' || b.t === 'slv'));
    const t = signedMode ? 'signed' : 'unsigned';
    const view = (x) => {
      if (x.t === 'unsigned' || x.t === 'signed') return x;
      if (x.t === 'slv') return arr(t, x.v.slice(), x.left, x.right);
      return null;
    };
    const av = view(a), bvv = view(b);
    const aw = av ? arrLen(av) : null;
    const bw = bvv ? arrLen(bvv) : null;
    const an = av ? bitsToBig(av, t) : numericOf(a);
    const bn = bvv ? bitsToBig(bvv, t) : numericOf(b);
    let width;
    if (op === '*') width = (aw || 32) + (bw || 0) || 32;
    else if (op === '/' || op === 'mod' || op === 'rem') width = aw || bw || 32;
    else width = Math.max(aw || 0, bw || 0) || 32;
    if (an === null || bn === null) return xArr(width, t);
    let r;
    switch (op) {
      case '+': r = an + bn; break;
      case '-': r = an - bn; break;
      case '*': r = an * bn; break;
      case '/': if (bn === 0n) { this.kernel.logMsg('warning', 'division by zero'); return xArr(width, t); } r = an / bn; break;
      case 'mod': if (bn === 0n) return xArr(width, t); r = ((an % bn) + bn) % bn; break;
      case 'rem': if (bn === 0n) return xArr(width, t); r = an % bn; break;
    }
    return bigToArr(r, width, t);
  }

  evalUnary(node, env, hint) {
    const v = this.evalExpr(node.operand, env, hint);
    const op = node.op;
    if (op === 'not') {
      if (v.t === 'sl') return sl(not1(v.v));
      if (v.t === 'bool') return bool(!v.v);
      if (Array.isArray(v.v)) return arr(v.t, v.v.map(not1), v.left, v.right);
      throw new Error('not on unsupported type');
    }
    if (op === 'abs') {
      if (v.t === 'real') return real(Math.abs(v.v));
      if (v.t === 'int') return int(Math.abs(v.v));
      const n = numericOf(v);
      if (n === null) return xArr(arrLen(v), v.t);
      return bigToArr(n < 0n ? -n : n, arrLen(v), v.t === 'signed' ? 'signed' : 'unsigned');
    }
    if (op === '-') {
      if (v.t === 'real') return real(-v.v);
      if (v.t === 'int') return int(-v.v);
      const n = numericOf(v);
      if (n === null) return xArr(arrLen(v), v.t);
      return bigToArr(-n, arrLen(v), NUM_ARRAYS.includes(v.t) ? v.t : 'signed');
    }
    if (op === '+') return v;
    throw new Error(`bad unary ${op}`);
  }

  evalAggregate(node, env, hint) {
    let t = 'slv', left = null, right = null, dir = 'downto';
    if (hint && hint.range) { t = hint.base === 'string' ? 'string' : (hint.base || 'slv'); left = hint.range.left; right = hint.range.right; dir = hint.range.dir; }
    const elemVal = (v) => {
      if (t === 'string') return v.t === 'char' ? v.v : valToString(v);
      if (v.t === 'sl') return v.v;
      if (v.t === 'char') { const i = SL_CHARS.indexOf(v.v.toUpperCase()); return i >= 0 ? i : X; }
      if (v.t === 'int') return v.v;
      if (v.t === 'bool') return v.v ? L1 : L0;
      return X;
    };
    if (left === null) {
      // infer from positional elements
      const pos = node.elems.filter(e => !e.choices);
      if (pos.length === node.elems.length && pos.length > 0) {
        const vals = pos.map(e => elemVal(this.evalExpr(e.value, env)));
        const isStr = pos.every(e => { const v = this.evalExpr(e.value, env); return v.t === 'char'; });
        if (isStr) return strV(vals.join(''));
        return arr(t, vals, vals.length - 1, 0);
      }
      // named indices: infer bounds
      let lo = Infinity, hi = -Infinity;
      for (const e of node.elems) {
        if (!e.choices) continue;
        for (const c of e.choices) {
          if (c.kind === 'value') { const i = this.evalExpr(c.value, env).v; lo = Math.min(lo, i); hi = Math.max(hi, i); }
          else if (c.kind === 'range') { const l = this.evalExpr(c.left, env).v, r = this.evalExpr(c.right, env).v; lo = Math.min(lo, l, r); hi = Math.max(hi, l, r); }
        }
      }
      if (lo === Infinity) throw new Error('(others => ...) aggregate needs a type context');
      left = hi; right = lo; dir = 'downto';
    }
    const n = Math.abs(left - right) + 1;
    const def = t === 'string' ? ' ' : (t === 'int' ? 0 : U);
    const out = new Array(n).fill(def);
    const posOf = (i) => dir === 'downto' ? left - i : i - left;
    let p = 0;
    const others = [];
    for (const e of node.elems) {
      const v = elemVal(this.evalExpr(e.value, env));
      if (!e.choices) { out[p++] = v; continue; }
      for (const c of e.choices) {
        if (c.kind === 'others') { others.push(v); continue; }
        if (c.kind === 'value') { out[posOf(this.evalExpr(c.value, env).v)] = v; continue; }
        if (c.kind === 'range') {
          const l = this.evalExpr(c.left, env).v, r = this.evalExpr(c.right, env).v;
          const lo2 = Math.min(l, r), hi2 = Math.max(l, r);
          for (let i = lo2; i <= hi2; i++) out[posOf(i)] = v;
        }
      }
    }
    if (others.length) {
      const ov = others[others.length - 1];
      for (let i = 0; i < n; i++) if (out[i] === def) out[i] = ov;
    }
    if (t === 'string') return strV(out.join(''));
    return arr(t, out, left, right);
  }

  // ---------- function calls ----------
  callUserFunction(decls, args, env, hint) {
    const decl = decls.find(d => d.params.length === args.length) || decls[0];
    if (!decl || !decl.body) throw new Error(`no function body for '${decl ? decl.name : '?'}'`);
    const fenv = { inst: env.inst, vars: new Map(), varTypes: new Map(), proc: null };
    decl.params.forEach((p, i) => {
      let v = args[i];
      if (v === undefined && p.init) v = this.evalExpr(p.init, fenv);
      if (v === undefined) throw new Error(`missing argument '${p.name}'`);
      fenv.vars.set(p.name, cloneVal(v));
      fenv.varTypes.set(p.name, this.resolveType(p.type, p.constraint, fenv));
    });
    this.initDecls(decl.decls, fenv);
    const gen = this.execSeq(decl.body, fenv);
    try {
      let r = gen.next();
      while (!r.done) {
        if (r.value && r.value.wait) throw new Error('wait statement inside function');
        r = gen.next();
      }
    } catch (e) {
      if (e && e.__ret !== undefined) return e.__ret;
      throw e;
    }
    return hint && hint.base === 'int' ? int(0) : sl(U);
  }

  initDecls(decls, env) {
    for (const d of decls || []) {
      if (d.kind === 'variableDecl' || d.kind === 'constantDecl') {
        for (const nm of d.names) {
          const ty = this.resolveType(d.type, d.constraint, env);
          let v = d.init ? this.evalExpr(d.init, env, ty) : this.defaultForType(ty);
          v = this.coerce(v, ty);
          env.vars.set(nm, v);
          env.varTypes.set(nm, ty);
          if (d.kind === 'constantDecl' && env.inst.consts) env.inst.consts.set(nm, v);
        }
      }
    }
  }

  defaultForType(ty) {
    if (!ty) return sl(U);
    if (ty.range) {
      const n = arrLen(ty.range);
      const def = ty.base === 'int' ? 0 : ty.base === 'string' ? ' ' : U;
      if (ty.base === 'string') return strV(' '.repeat(n));
      return arr(ty.base === 'slv' ? 'slv' : ty.base, new Array(n).fill(def), ty.range.left, ty.range.right);
    }
    switch (ty.base) {
      case 'int': return int(0);
      case 'real': return real(0);
      case 'bool': return bool(false);
      case 'time': return timeV(0);
      case 'char': return charV(' ');
      case 'string': return strV('');
      case 'enum': return enumV(ty.enumType, 0);
      default: return sl(ty.base === 'sl' ? U : U);
    }
  }

  resolveType(mark, constraint, env) {
    const name = typeName(mark);
    let base = null, enumType = null, range = null;
    const r = this.lookup(env.inst, name);
    if (r && r.kind === 'type') {
      base = r.type.base; enumType = r.type.enumType; range = r.type.range;
      if (r.type.elemBase) base = r.type.elemBase;
    } else {
      switch (name) {
        case 'std_logic': case 'std_ulogic': base = 'sl'; break;
        case 'std_logic_vector': case 'std_ulogic_vector': base = 'slv'; break;
        case 'unsigned': base = 'unsigned'; break;
        case 'signed': base = 'signed'; break;
        case 'bit': base = 'sl'; break;
        case 'bit_vector': base = 'bv'; break;
        case 'integer': case 'natural': case 'positive': base = 'int'; break;
        case 'real': base = 'real'; break;
        case 'boolean': base = 'bool'; break;
        case 'time': base = 'time'; break;
        case 'character': base = 'char'; break;
        case 'string': base = 'string'; break;
        case 'severity_level': base = 'enum'; enumType = { name: 'severity_level', literals: ['note', 'warning', 'error', 'failure'] }; break;
        default: base = 'sl';
      }
    }
    if (constraint) {
      const rr = this.evalRange(constraint, env);
      range = rr;
    }
    if (base === 'int' && range) { /* integer subtype bounds kept */ }
    return { base, range, enumType, name };
  }

  coerce(v, ty) {
    if (!ty) return v;
    if (ty.range && ARRAY_TYPES.includes(ty.base === 'slv' ? 'slv' : ty.base)) {
      const n = arrLen(ty.range);
      const t = ty.base;
      if (Array.isArray(v.v)) {
        if (v.v.length !== n) throw new Error(`width mismatch: ${v.v.length} vs ${n}`);
        return arr(t, v.v.slice(), ty.range.left, ty.range.right);
      }
      if (v.t === 'sl' && n === 1) return arr(t, [v.v], ty.range.left, ty.range.right);
      if (v.t === 'int' || v.t === 'unsigned' || v.t === 'signed' || v.t === 'slv') {
        const num = numericOf(v);
        if (num === null) return xArr(n, t, ty.range.left, ty.range.right);
        return bigToArr(num, n, t, ty.range.left, ty.range.right);
      }
      if (v.t === 'string' && t === 'string') return strV(v.v);
      throw new Error(`cannot coerce ${v.t} to array`);
    }
    if (ty.range && ty.base === 'string') {
      const s = v.t === 'string' ? v.v : valToString(v);
      return strV(s);
    }
    switch (ty.base) {
      case 'sl':
        if (v.t === 'sl') return v;
        if (v.t === 'char') { const i = SL_CHARS.indexOf(v.v.toUpperCase()); return sl(i >= 0 ? i : X); }
        if (Array.isArray(v.v) && v.v.length === 1) return sl(v.v[0]);
        return sl(X);
      case 'int': { const n = numericOf(v); return int(n === null ? 0 : Number(n)); }
      case 'real': return real(v.t === 'real' ? v.v : Number(numericOf(v) ?? 0n));
      case 'bool': return bool(truthy(v));
      case 'time': return timeV(v.v);
      case 'enum': return v;
      case 'char': return v.t === 'char' ? v : charV(valToString(v));
      case 'string': return strV(v.t === 'string' ? v.v : valToString(v));
      default: return v;
    }
  }

  convertType(name, args, env, hint) {
    const ty = this.resolveType(name, null, env);
    const a = args[0];
    if (a === undefined) throw new Error(`conversion ${name} needs an argument`);
    if (ty.range || (hint && hint.range && ARRAY_TYPES.includes(ty.base))) {
      const range = ty.range || hint.range;
      return this.coerce(a, { base: ty.base, range });
    }
    if (ARRAY_TYPES.includes(ty.base) && Array.isArray(a.v)) {
      return arr(ty.base, a.v.slice(), a.left, a.right);
    }
    if (ARRAY_TYPES.includes(ty.base) && (a.t === 'int' || a.t === 'sl')) {
      const width = hint && hint.range ? arrLen(hint.range) : (a.t === 'sl' ? 1 : 32);
      if (a.t === 'sl') return arr(ty.base, [a.v], width - 1, 0);
      return bigToArr(BigInt(a.v), width, ty.base);
    }
    return this.coerce(a, ty);
  }

  // ---------- builtins ----------
  callBuiltin(name, args, env, hint, callNode) {
    const n = typeName(name);
    const K = this.kernel;
    switch (n) {
      case 'rising_edge': case 'falling_edge': {
        const sig = this.resolveSignal(callNode ? callNode.args[0] : args[0], env);
        if (!sig) { const v = args[0]; return bool(false); }
        const cur = sig.value.v, last = sig.lastValue ? sig.lastValue.v : U;
        const edge = n === 'rising_edge' ? (cur === L1 && last === L0) : (cur === L0 && last === L1);
        return bool(sig.eventCurrent && edge);
      }
      case 'now': return timeV(K.time);
      case 'to_integer': case 'conv_integer': {
        const v = numericOf(args[0]);
        if (v === null) { K.logMsg('warning', 'to_integer on value containing X'); return int(0); }
        return int(Number(v));
      }
      case 'to_unsigned': case 'conv_unsigned': {
        if (args.length === 2) {
          const val = numericOf(args[0]); const w = Number(numericOf(args[1]));
          if (val === null) return xArr(w, 'unsigned');
          return bigToArr(val, w, 'unsigned');
        }
        return this.convertType('unsigned', args, env, hint);
      }
      case 'to_signed': case 'conv_signed': {
        if (args.length === 2) {
          const val = numericOf(args[0]); const w = Number(numericOf(args[1]));
          if (val === null) return xArr(w, 'signed');
          return bigToArr(val, w, 'signed');
        }
        return this.convertType('signed', args, env, hint);
      }
      case 'conv_std_logic_vector': {
        const val = numericOf(args[0]); const w = Number(numericOf(args[1]));
        if (val === null) return xArr(w, 'slv');
        return bigToArr(val, w, 'slv');
      }
      case 'to_stdlogicvector': case 'to_stdulogicvector': return this.convertType('std_logic_vector', args, env, hint);
      case 'to_bitvector': return this.convertType('bit_vector', args, env, hint);
      case 'resize': {
        const a = args[0]; const w = Number(numericOf(args[1]));
        const t = a.t === 'signed' ? 'signed' : 'unsigned';
        const num = bitsToBig(a, t);
        if (num === null) return xArr(w, t);
        if (t === 'signed' && w > arrLen(a)) {
          const neg = is1(to01(a.v[0]));
          const ext = neg ? ((1n << BigInt(w)) - (1n << BigInt(arrLen(a)))) : 0n;
          return bigToArr((num < 0n ? (1n << BigInt(arrLen(a))) + num : num) | ext, w, t);
        }
        return bigToArr(num, w, t);
      }
      case 'shift_left': case 'shift_right': case 'rotate_left': case 'rotate_right': {
        const a = args[0]; const cnt = Number(numericOf(args[1]));
        const op = n === 'shift_left' ? 'sll' : n === 'shift_right' ? 'srl' : n === 'rotate_left' ? 'rol' : 'ror';
        return this.shiftOp(op, a, int(cnt));
      }
      case 'and_reduce': case 'or_reduce': case 'xor_reduce': case 'nand_reduce': case 'nor_reduce': case 'xnor_reduce': {
        const a = args[0]; const op = n.replace('_reduce', '');
        const fn = LOGIC_TABLES[op];
        let r = a.v[0];
        for (let i = 1; i < a.v.length; i++) r = fn(r, a.v[i]);
        return sl(r);
      }
      case 'std_match': {
        const a = args[0], b = args[1];
        const av = Array.isArray(a.v) ? a.v : [a.v];
        const bvv = Array.isArray(b.v) ? b.v : [b.v];
        if (av.length !== bvv.length) return bool(false);
        for (let i = 0; i < av.length; i++) {
          if (av[i] === DC || bvv[i] === DC) continue;
          if (to01(av[i]) !== to01(bvv[i])) return bool(false);
        }
        return bool(true);
      }
      case 'to_01': {
        const a = args[0];
        if (Array.isArray(a.v)) return arr(a.t, a.v.map(e => to01(e)), a.left, a.right);
        return sl(to01(a.v));
      }
      case 'is_x': {
        const a = args[0];
        const vs = Array.isArray(a.v) ? a.v : [a.v];
        return bool(vs.some(e => to01(e) === X));
      }
      case 'maximum': case 'minimum': {
        const c = valsCompare(args[0], args[1]);
        if (c === null) return args[0];
        return (n === 'maximum') === (c >= 0) ? args[0] : args[1];
      }
      case 'to_string': return strV(valToString(args[0]));
      case 'to_hstring': {
        const a = args[0]; let s = '';
        for (let i = 0; i < a.v.length; i += 4) {
          let nib = 0;
          for (let j = 0; j < 4; j++) nib = (nib << 1) | (is1(to01(a.v[i + j] ?? L0)) ? 1 : 0);
          s += nib.toString(16).toUpperCase();
        }
        return strV(s);
      }
      case 'floor': return int(Math.floor(args[0].v));
      case 'ceil': return int(Math.ceil(args[0].v));
      case 'round': return int(Math.round(args[0].v));
      case 'sqrt': return real(Math.sqrt(args[0].v));
      case 'stop': case 'finish': {
        K.stopped = true; K.stopReason = `std.env.${n}`;
        K.logMsg('note', `simulation finished (${n}) at ${valToString(timeV(K.time))}`);
        return { t: 'void', v: 0 };
      }
      default: {
        // type conversion?
        const ty = this.resolveType(n, null, env);
        const known = ['std_logic', 'std_ulogic', 'std_logic_vector', 'std_ulogic_vector', 'unsigned', 'signed', 'bit', 'bit_vector', 'integer', 'natural', 'positive', 'real', 'boolean', 'time', 'character', 'string'];
        if (known.includes(n) && args.length === 1) return this.convertType(n, args, env, hint);
        return undefined;
      }
    }
  }

  // ---------- signal assignment ----------
  resolveTarget(node, env) {
    if (node.kind === 'name') {
      const r = this.lookup(env.inst, node.name);
      if (!r || r.kind !== 'signal') throw new Error(`assignment target '${node.name}' is not a signal`);
      const sig = r.sig;
      return { sig, left: sig.range ? sig.range.left : null, right: sig.range ? sig.range.right : null, whole: true };
    }
    if (node.kind === 'indexed') {
      const sig = this.resolveSignal(node.prefix, env);
      if (!sig) throw new Error('assignment target is not a signal');
      const a = node.args[0];
      let l, r;
      if (a.kind === 'sliceArg') {
        l = this.evalExpr(a.left, env).v; r = this.evalExpr(a.right, env).v;
      } else {
        l = r = this.evalExpr(a, env).v;
      }
      if (sig.isArr) {
        const lo = Math.min(sig.range.left, sig.range.right), hi = Math.max(sig.range.left, sig.range.right);
        if (Math.min(l, r) < lo || Math.max(l, r) > hi) {
          throw new Error(`index (${l}..${r}) out of bounds for '${sig.name}' (${sig.range.left} ${sig.range.dir} ${sig.range.right})`);
        }
      }
      return { sig, left: l, right: r, whole: false, index: !a.kind || a.kind !== 'sliceArg' };
    }
    throw new Error('unsupported assignment target');
  }

  assignSignal(targetNode, value, env, proc, afterFs = 0, transport = false) {
    const tgt = this.resolveTarget(targetNode, env);
    const sig = tgt.sig;
    const at = this.kernel.time + afterFs;
    const pid = proc ? proc.id : 'anon';
    if (!sig.isArr) {
      const v = this.coerce(value, { base: sig.type });
      const d = sig.getDriver(`${pid}:${sig.id}`, pid, 0, 0);
      this.kernel.schedule(sig, d, v, at, transport);
      return;
    }
    const left = tgt.whole ? sig.range.left : tgt.left;
    const right = tgt.whole ? sig.range.right : tgt.right;
    const n = Math.abs(left - right) + 1;
    const dir = left >= right ? 'downto' : 'to';
    const v = this.coerce(value, { base: sig.type, range: { left, right, dir } });
    for (let i = 0; i < n; i++) {
      const idx = dir === 'downto' ? left - i : left + i;
      const d = sig.getDriver(`${pid}:${sig.id}:${idx}`, pid, idx, idx);
      this.kernel.schedule(sig, d, { t: sig.type, v: [v.v[i]], left: idx, right: idx, dir: 'downto' }, at, transport);
    }
  }

  assignVariable(targetNode, value, env) {
    const getVar = (nm) => {
      if (!env.vars.has(nm)) throw new Error(`variable '${nm}' not declared`);
      return env.vars.get(nm);
    };
    if (targetNode.kind === 'name') {
      const ty = env.varTypes.get(targetNode.name);
      env.vars.set(targetNode.name, this.coerce(value, ty));
      return;
    }
    if (targetNode.kind === 'indexed') {
      let base = targetNode.prefix;
      if (base.kind !== 'name') throw new Error('unsupported variable target');
      const cur = cloneVal(getVar(base.name));
      const a = targetNode.args[0];
      if (a.kind === 'sliceArg') {
        const l = this.evalExpr(a.left, env).v, r = this.evalExpr(a.right, env).v;
        const n = Math.abs(l - r) + 1;
        if (!Array.isArray(value.v) || value.v.length !== n) throw new Error('slice width mismatch');
        const dir = l >= r ? 'downto' : 'to';
        for (let i = 0; i < n; i++) arrSetIndex(cur, dir === 'downto' ? l - i : l + i, value.v[i]);
      } else {
        const i = this.evalExpr(a, env).v;
        const e = value.t === 'sl' ? value.v : value.v;
        arrSetIndex(cur, i, e);
      }
      env.vars.set(base.name, cur);
      return;
    }
    throw new Error('unsupported variable assignment target');
  }

  // ---------- sequential statements ----------
  *execSeq(stmts, env) {
    for (const s of stmts) yield* this.execStmt(s, env);
  }

  *execStmt(s, env) {
    switch (s.kind) {
      case 'null': return;
      case 'if': {
        if (truthy(this.evalExpr(s.cond, env))) { yield* this.execSeq(s.then, env); return; }
        for (const e of s.elsifs) {
          if (truthy(this.evalExpr(e.cond, env))) { yield* this.execSeq(e.body, env); return; }
        }
        if (s.els) yield* this.execSeq(s.els, env);
        return;
      }
      case 'case': {
        const sel = this.evalExpr(s.sel, env);
        for (const arm of s.arms) {
          if (this.matchChoices(sel, arm.choices, env)) { yield* this.execSeq(arm.body, env); return; }
        }
        throw new Error(`case statement: no matching arm for ${valToString(sel)} and no others`);
      }
      case 'for': {
        const r = this.evalRange(s.range, env);
        const asc = r.dir === 'to';
        const start = asc ? r.left : r.left;
        const end = r.right;
        const step = asc ? 1 : -1;
        const rev = s.reverse ? -1 : 1;
        const lo = Math.min(r.left, r.right), hi = Math.max(r.left, r.right);
        const seq = [];
        if ((asc ? 1 : -1) * rev > 0) for (let i = lo; i <= hi; i++) seq.push(i);
        else for (let i = hi; i >= lo; i--) seq.push(i);
        for (const i of seq) {
          env.vars.set(s.id, int(i));
          env.varTypes.set(s.id, { base: 'int' });
          try { yield* this.execSeq(s.body, env); }
          catch (e) {
            if (e && e.__ctl === 'exit' && (!e.label || e.label === s.label)) break;
            if (e && e.__ctl === 'next' && (!e.label || e.label === s.label)) continue;
            throw e;
          }
        }
        env.vars.delete(s.id);
        return;
      }
      case 'while': {
        while (truthy(this.evalExpr(s.cond, env))) {
          try { yield* this.execSeq(s.body, env); }
          catch (e) {
            if (e && e.__ctl === 'exit' && (!e.label || e.label === s.label)) break;
            if (e && e.__ctl === 'next' && (!e.label || e.label === s.label)) continue;
            throw e;
          }
        }
        return;
      }
      case 'loop': {
        for (;;) {
          try { yield* this.execSeq(s.body, env); }
          catch (e) {
            if (e && e.__ctl === 'exit' && (!e.label || e.label === s.label)) break;
            if (e && e.__ctl === 'next' && (!e.label || e.label === s.label)) continue;
            throw e;
          }
        }
        return;
      }
      case 'exit': {
        if (s.cond && !truthy(this.evalExpr(s.cond, env))) return;
        throw { __ctl: 'exit', label: s.label };
      }
      case 'next': {
        if (s.cond && !truthy(this.evalExpr(s.cond, env))) return;
        throw { __ctl: 'next', label: s.label };
      }
      case 'wait': {
        yield* this.execWait(s, env);
        return;
      }
      case 'report': {
        const msg = this.evalExpr(s.msg, env);
        const sev = s.severity ? this.evalExpr(s.severity, env).v : 'note';
        this.kernel.logMsg(sev, msg.t === 'string' ? msg.v : valToString(msg));
        return;
      }
      case 'assert': {
        if (!truthy(this.evalExpr(s.cond, env))) {
          const msg = s.msg ? this.evalExpr(s.msg, env) : strV('Assertion violation');
          const sev = s.severity ? this.evalExpr(s.severity, env).v : 'error';
          this.kernel.logMsg(sev, msg.t === 'string' ? msg.v : valToString(msg));
        }
        return;
      }
      case 'return': {
        const v = s.value ? this.evalExpr(s.value, env) : undefined;
        throw { __ret: v === undefined ? { t: 'void', v: 0 } : v };
      }
      case 'varAssign': {
        const ty = this.varHint(s.target, env);
        const v = this.evalExpr(s.value, env, ty);
        this.assignVariable(s.target, v, env);
        return;
      }
      case 'sigAssign': {
        const ty = this.targetHint(s.target, env);
        for (const w of s.waves) {
          const v = this.evalExpr(w.value, env, ty);
          const after = w.after ? Number(numericOf(this.evalExpr(w.after, env)) ?? 0n) : 0;
          this.assignSignal(s.target, v, env, env.proc, after, false);
        }
        return;
      }
      case 'procCall': {
        yield* this.execProcCall(s.name, env);
        return;
      }
      default: throw new Error(`unsupported statement '${s.kind}'`);
    }
  }

  varHint(target, env) {
    if (target.kind === 'name') return env.varTypes.get(target.name) || null;
    if (target.kind === 'indexed' && target.prefix.kind === 'name') {
      const ty = env.varTypes.get(target.prefix.name);
      if (!ty) return null;
      const a = target.args[0];
      if (a.kind === 'sliceArg') {
        const l = this.evalExpr(a.left, env).v, r = this.evalExpr(a.right, env).v;
        return { base: ty.base, range: { left: l, right: r, dir: l >= r ? 'downto' : 'to' } };
      }
      return { base: 'sl' };
    }
    return null;
  }

  targetHint(target, env) {
    const sig = this.resolveSignal(target, env);
    if (!sig) return null;
    if (target.kind === 'indexed') {
      const a = target.args[0];
      if (a.kind === 'sliceArg') {
        const l = this.evalExpr(a.left, env).v, r = this.evalExpr(a.right, env).v;
        return { base: sig.type, range: { left: l, right: r, dir: l >= r ? 'downto' : 'to' } };
      }
      return { base: 'sl' };
    }
    return { base: sig.type, range: sig.range };
  }

  *execWait(s, env) {
    const K = this.kernel;
    if (s.forT && !s.on && !s.until) {
      const t = Number(numericOf(this.evalExpr(s.forT, env)) ?? 0n);
      yield { wait: 'for', t };
      return;
    }
    let sigs;
    if (s.on) sigs = s.on.map(nm => this.resolveSignal(nm, env)).filter(Boolean);
    else if (s.until) sigs = [...this.collectSens(s.until, env, new Set())];
    else sigs = env.proc && env.proc.sens ? [...env.proc.sens] : [];
    if (s.until) {
      const deadline = s.forT ? K.time + Number(numericOf(this.evalExpr(s.forT, env)) ?? 0n) : Infinity;
      for (;;) {
        yield { wait: 'until', sigs, test: () => truthy(this.evalExpr(s.until, env)), deadline };
        if (truthy(this.evalExpr(s.until, env))) break;
        if (K.time >= deadline) break;
      }
      return;
    }
    yield { wait: 'on', sigs };
  }

  *execProcCall(node, env) {
    let name = null, args = [];
    if (node.kind === 'indexed') {
      name = node.prefix.kind === 'name' ? node.prefix.name : null;
      args = node.args;
    } else if (node.kind === 'name') name = node.name;
    else if (node.kind === 'selected') {
      const parts = [];
      let n = node;
      while (n.kind === 'selected') { parts.unshift(n.sel); n = n.prefix; }
      if (n.kind === 'name') parts.unshift(n.name);
      name = parts[parts.length - 1];
    }
    const bn = typeName(name || '');
    if (['stop', 'finish'].includes(bn)) {
      this.callBuiltin(bn, [], env, null);
      return;
    }
    const r = this.lookup(env.inst, bn);
    if (r && r.kind === 'func') {
      const decl = r.decls.find(d => d.subkind === 'procedure' && d.params.length === args.length) || r.decls.find(d => d.subkind === 'procedure');
      if (decl && decl.body) {
        const penv = { inst: env.inst, vars: new Map(), varTypes: new Map(), proc: env.proc };
        const evalArgs = args.map(a => this.evalExpr(a, env));
        decl.params.forEach((p, i) => {
          penv.vars.set(p.name, p.mode === 'in' ? cloneVal(evalArgs[i]) : (env.vars.has(args[i].name) ? cloneVal(env.vars.get(args[i].name)) : sl(U)));
          penv.varTypes.set(p.name, this.resolveType(p.type, null, penv));
        });
        this.initDecls(decl.decls, penv);
        yield* this.execSeq(decl.body, penv);
        // write back out/inout params
        decl.params.forEach((p, i) => {
          if (p.mode === 'out' || p.mode === 'inout') {
            const actual = args[i];
            const v = penv.vars.get(p.name);
            if (actual.kind === 'name' && env.vars.has(actual.name)) env.vars.set(actual.name, v);
            else if (actual.kind === 'name') this.assignSignal(actual, v, env, env.proc);
          }
        });
        return;
      }
    }
    // builtin procedure with args (e.g. deallocate) — ignore unknown safely
    const b = this.callBuiltin(bn, args.map(a => this.evalExpr(a, env)), env, null);
    if (b !== undefined) return;
    throw new Error(`unknown procedure '${name}'`);
  }

  matchChoices(val, choices, env) {
    for (const c of choices) {
      if (c.kind === 'others') return true;
      if (c.kind === 'value') {
        const cv = this.evalExpr(c.value, env);
        if (valsEqual(val, cv)) return true;
      } else if (c.kind === 'range') {
        const l = this.evalExpr(c.left, env), r = this.evalExpr(c.right, env);
        const lo = Math.min(l.v, r.v), hi = Math.max(l.v, r.v);
        const cmpLo = valsCompare(val, int(lo)), cmpHi = valsCompare(val, int(hi));
        if (cmpLo !== null && cmpHi !== null && cmpLo >= 0 && cmpHi <= 0) return true;
      }
    }
    return false;
  }
}