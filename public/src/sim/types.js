// IEEE std_logic_1164 nine-value logic + numeric semantics.
// Values: U=0 X=1 '0'=2 '1'=3 Z=4 W=5 L=6 H=7 '-'=8
export const U = 0, X = 1, L0 = 2, L1 = 3, Z = 4, W = 5, L = 6, H = 7, DC = 8;
export const SL_CHARS = ['U', 'X', '0', '1', 'Z', 'W', 'L', 'H', '-'];

const T = (rows) => rows.map(r => r.split('').map(c => SL_CHARS.indexOf(c)));

export const RES_TABLE = T([
  'UUUUUUUUU',
  'UXXXXXXXX',
  'UX0X0000X',
  'UXX11111X',
  'UX01ZWLHW',
  'UX01WWWWW',
  'UX01LWLWL',
  'UX01HWWHH',
  'UXXXWWLHX',
]);

export const AND_TABLE = T([
  'UU0UUU0UU',
  'UX0XXX0XX',
  '000000000',
  'UX01XX01X',
  'UX0XXX0XX',
  'UX0XXX0XX',
  '000000000',
  'UX01XX01X',
  'UX0XXX0XX',
]);

export const OR_TABLE = T([
  'UUU1UUU1U',
  'UXX1XXX1X',
  'UX01XX01X',
  '111111111',
  'UXX1XXX1X',
  'UXX1XXX1X',
  'UX01XX01X',
  '111111111',
  'UXX1XXX1X',
]);

export const XOR_TABLE = T([
  'UUUUUUUUU',
  'UXXXXXXXX',
  'UX01XX01X',
  'UX10XX10X',
  'UXXXXXXXX',
  'UXXXXXXXX',
  'UX01XX01X',
  'UX10XX10X',
  'UXXXXXXXX',
]);

export const NOT_TABLE = [U, X, L1, L0, X, X, L1, L0, X];

export function resolve(a, b) { return RES_TABLE[a][b]; }
export function resolveVec(vals) {
  let r = Z;
  for (const v of vals) r = RES_TABLE[r][v];
  return r;
}
export const and2 = (a, b) => AND_TABLE[a][b];
export const or2 = (a, b) => OR_TABLE[a][b];
export const xor2 = (a, b) => XOR_TABLE[a][b];
export const nand2 = (a, b) => NOT_TABLE[AND_TABLE[a][b]];
export const nor2 = (a, b) => NOT_TABLE[OR_TABLE[a][b]];
export const xnor2 = (a, b) => NOT_TABLE[XOR_TABLE[a][b]];
export const not1 = (a) => NOT_TABLE[a];
export const to01 = (a) => (a === L0 || a === L) ? L0 : (a === L1 || a === H) ? L1 : X;
export const is1 = (a) => a === L1 || a === H;
export const is0 = (a) => a === L0 || a === L;

// ---- typed value constructors ----
export const sl = (v) => ({ t: 'sl', v });
export const int = (v) => ({ t: 'int', v: Math.trunc(v) });
export const bool = (v) => ({ t: 'bool', v: !!v });
export const real = (v) => ({ t: 'real', v });
export const timeV = (v) => ({ t: 'time', v });
export const enumV = (type, idx) => ({ t: 'enum', type, v: idx });
export const charV = (c) => ({ t: 'char', v: c });
export const strV = (s) => ({ t: 'string', v: s });

export function arr(t, elems, left, right) {
  return { t, v: elems, left, right, dir: left >= right ? 'downto' : 'to' };
}
export const slv = (elems, left, right) => arr('slv', elems, left, right);
export const unsigned = (elems, left, right) => arr('unsigned', elems, left, right);
export const signed = (elems, left, right) => arr('signed', elems, left, right);
export const bv = (elems, left, right) => arr('bv', elems, left, right);

export function arrLen(a) { return Math.abs(a.left - a.right) + 1; }
export function arrElemsLR(a) {
  // elements ordered left-to-right as declared
  return a.v;
}
export function arrIndex(a, i) {
  // i is a VHDL index value; v[] stored left-to-right
  const off = a.dir === 'downto' ? a.left - i : i - a.left;
  return a.v[off];
}
export function arrSetIndex(a, i, val) {
  const off = a.dir === 'downto' ? a.left - i : i - a.left;
  a.v[off] = val;
}
export function arrSlice(a, l, r) {
  const dir = l >= r ? 'downto' : 'to';
  const out = [];
  if (dir === 'downto') for (let i = l; i >= r; i--) out.push(arrIndex(a, i));
  else for (let i = l; i <= r; i++) out.push(arrIndex(a, i));
  return arr(a.t, out, l, r);
}
export function cloneVal(x) {
  if (x === null || typeof x !== 'object') return x;
  if (Array.isArray(x.v)) return { ...x, v: x.v.slice() };
  return { ...x };
}

export function slvFromString(s, t = 'slv') {
  const elems = [...s].map(c => SL_CHARS.indexOf(c.toUpperCase()));
  return arr(t, elems, elems.length - 1, 0);
}
export function valToString(x) {
  if (x == null) return 'null';
  switch (x.t) {
    case 'sl': return SL_CHARS[x.v];
    case 'int': return String(x.v);
    case 'real': return String(x.v);
    case 'bool': return x.v ? 'TRUE' : 'FALSE';
    case 'time': return fmtTime(x.v);
    case 'enum': return x.type.literals[x.v];
    case 'char': return `'${x.v}'`;
    case 'string': return x.v;
    case 'slv': case 'bv': case 'unsigned': case 'signed':
      return x.v.map(e => x.t === 'bv' ? ((e === L1 || e === H || e === 1) ? '1' : '0') : SL_CHARS[e]).join('');
    default: return String(x.v);
  }
}
export function fmtTime(fs) {
  const abs = Math.abs(fs);
  if (abs >= 1e15) return `${(fs / 1e15).toPrecision(6)} s`;
  if (abs >= 1e12) return `${(fs / 1e12).toPrecision(6)} ms`;
  if (abs >= 1e9) return `${(fs / 1e9).toPrecision(6)} us`;
  if (abs >= 1e6) return `${(fs / 1e6).toPrecision(6)} ns`;
  if (abs >= 1e3) return `${(fs / 1e3).toPrecision(6)} ps`;
  return `${fs} fs`;
}

// ---- numeric conversions (BigInt backbone, exact for any width) ----
export function bitsToBig(a, signedness) {
  let bad = false;
  let r = 0n;
  for (const e of a.v) {
    const b = to01(e);
    if (b === X) { bad = true; break; }
    r = (r << 1n) | (b === L1 ? 1n : 0n);
  }
  if (bad) return null;
  const n = BigInt(arrLen(a));
  if (signedness === 'signed' && a.v.length && is1(to01(a.v[0]))) r -= (1n << n);
  return r;
}
export function bigToArr(val, width, t, left = width - 1, right = 0) {
  const elems = new Array(width);
  let v = BigInt.asUintN(width, val);
  for (let i = width - 1; i >= 0; i--) {
    elems[i] = (v & 1n) ? L1 : L0;
    v >>= 1n;
  }
  return arr(t, elems, left, right);
}
export function xArr(width, t, left = width - 1, right = 0) {
  return arr(t, new Array(width).fill(X), left, right);
}

export function numericOf(x) {
  if (x.t === 'int' || x.t === 'real' || x.t === 'time') return BigInt(Math.trunc(x.v));
  if (x.t === 'unsigned') return bitsToBig(x, 'unsigned');
  if (x.t === 'signed') return bitsToBig(x, 'signed');
  if (x.t === 'slv') return bitsToBig(x, 'unsigned');
  if (x.t === 'sl') { const b = to01(x.v); return b === X ? null : (b === L1 ? 1n : 0n); }
  return null;
}

export function truthy(x) {
  if (x.t === 'bool') return x.v;
  if (x.t === 'sl') return is1(x.v);
  if (x.t === 'int') return x.v !== 0;
  return false;
}

export function valsEqual(a, b) {
  if (a.t === 'sl' && b.t === 'sl') return a.v === b.v;
  if (a.t === 'int' && b.t === 'int') return a.v === b.v;
  if (a.t === 'bool' && b.t === 'bool') return a.v === b.v;
  if (a.t === 'enum' && b.t === 'enum') return a.type === b.type && a.v === b.v;
  if (a.t === 'char' && b.t === 'char') return a.v === b.v;
  if (a.t === 'string' && b.t === 'string') return a.v === b.v;
  if (a.t === 'time' && b.t === 'time') return a.v === b.v;
  if (a.t === 'real' && b.t === 'real') return a.v === b.v;
  if (Array.isArray(a.v) && Array.isArray(b.v)) {
    if (a.v.length !== b.v.length) return false;
    for (let i = 0; i < a.v.length; i++) if (a.v[i] !== b.v[i]) return false;
    return true;
  }
  const na = numericOf(a), nb = numericOf(b);
  if (na !== null && nb !== null) return na === nb;
  return false;
}

export function valsCompare(a, b) {
  // returns -1/0/1; arrays of logic compare lexicographically, numerics numerically
  const numericTypes = ['unsigned', 'signed', 'int', 'real'];
  if (numericTypes.includes(a.t) && numericTypes.includes(b.t)) {
    const na = numericOf(a), nb = numericOf(b);
    if (na === null || nb === null) return null;
    return na < nb ? -1 : na > nb ? 1 : 0;
  }
  if (a.t === 'sl' && b.t === 'sl') return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
  if (a.t === 'enum' && b.t === 'enum' && a.type === b.type) return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
  if (a.t === 'char' && b.t === 'char') return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
  if (a.t === 'time' && b.t === 'time') return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
  if (Array.isArray(a.v) && Array.isArray(b.v)) {
    const n = Math.min(a.v.length, b.v.length);
    for (let i = 0; i < n; i++) {
      const av = a.v[i], bv = b.v[i];
      if (av !== bv) return av < bv ? -1 : 1;
    }
    return a.v.length < b.v.length ? -1 : a.v.length > b.v.length ? 1 : 0;
  }
  const na = numericOf(a), nb = numericOf(b);
  if (na !== null && nb !== null) return na < nb ? -1 : na > nb ? 1 : 0;
  return null;
}