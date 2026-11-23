// Compiles flat GHDL `--synth --out=verilog` netlists into a fast, zero-dependency
// ES module stepper for real-time 50 MHz board & 48 kHz AudioWorklet simulation.

function stripVerilogComments(text) {
  return String(text || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

function parseWidthSpec(spec) {
  if (!spec) return { width: 1, hi: 0, lo: 0 };
  const m = spec.match(/\[\s*(-?\d+)\s*:\s*(-?\d+)\s*\]/);
  if (!m) return null;
  const hi = Number(m[1]), lo = Number(m[2]);
  if (!Number.isInteger(hi) || !Number.isInteger(lo) || hi < lo) return null;
  const width = hi - lo + 1;
  return { width, hi, lo };
}

function parseBinaryLiteral(tok) {
  const m = tok.match(/^(\d+)'([bdh])([0-9a-fA-FxXzZ_]+)$/);
  if (!m) return null;
  const width = Number(m[1]);
  const base = m[2].toLowerCase();
  const digits = m[3].replace(/_/g, '');
  if (/[xz]/i.test(digits) || width < 1 || width > 32) return null;
  const radix = base === 'b' ? 2 : base === 'h' ? 16 : 10;
  const val = parseInt(digits, radix);
  if (!Number.isFinite(val)) return null;
  return { width, val: val >>> 0 };
}

function maskExpr(code, width) {
  if (width >= 32) return `((${code}) >>> 0)`;
  const mask = ((1n << BigInt(width)) - 1n).toString();
  return `((${code}) & ${mask})`;
}

function signedExpr(code, width) {
  if (width >= 32) return `((${code}) | 0)`;
  const shift = 32 - width;
  return `(((${code}) << ${shift}) >> ${shift})`;
}

// Recursive-descent parser for the small expression grammar emitted by `ghdl --synth --out=verilog`
function compileExpression(rawExpr, symWidths, memNames) {
  const tokens = [];
  const src = rawExpr.trim();
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '<<', '>>', '&&', '||'].includes(two)) {
      tokens.push({ t: 'op', v: two }); i += 2; continue;
    }
    if ('~&|^+-*<>?:(){}[],!'.includes(ch)) {
      tokens.push({ t: 'op', v: ch }); i++; continue;
    }
    if (ch === '$') {
      const m = src.slice(i).match(/^\$[a-zA-Z_]\w*/);
      if (!m) throw new Error(`Unsupported sys id near ${src.slice(i, i + 16)}`);
      tokens.push({ t: 'id', v: m[0] }); i += m[0].length; continue;
    }
    const lit = src.slice(i).match(/^\d+'[bdh][0-9a-fA-FxXzZ_]+/);
    if (lit) {
      tokens.push({ t: 'lit', v: lit[0] }); i += lit[0].length; continue;
    }
    const num = src.slice(i).match(/^\d+/);
    if (num) {
      tokens.push({ t: 'num', v: num[0] }); i += num[0].length; continue;
    }
    const id = src.slice(i).match(/^[a-zA-Z_][a-zA-Z0-9_$]*/);
    if (id) {
      tokens.push({ t: 'id', v: id[0] }); i += id[0].length; continue;
    }
    throw new Error(`Unexpected token near ${src.slice(i, i + 16)}`);
  }

  let pos = 0;
  const peek = () => tokens[pos] || null;
  const eat = (val) => {
    const tok = tokens[pos];
    if (!tok || (val !== undefined && tok.v !== val)) {
      throw new Error(`Expected ${val ?? 'token'}, got ${tok ? tok.v : 'EOF'} in "${rawExpr}"`);
    }
    pos++;
    return tok;
  };
  const deps = new Set();

  function parseTernary() {
    const cond = parseOr();
    if (peek()?.v === '?') {
      eat('?');
      const a = parseTernary();
      eat(':');
      const b = parseTernary();
      const w = Math.max(a.width, b.width);
      return { code: `((${cond.code}) ? (${a.code}) : (${b.code}))`, width: w };
    }
    return cond;
  }

  function parseOr() {
    let left = parseXor();
    while (peek()?.v === '|' || peek()?.v === '||') {
      const op = eat().v;
      const right = parseXor();
      const w = op === '||' ? 1 : Math.max(left.width, right.width);
      const code = op === '||' ? `(((${left.code}) || (${right.code})) ? 1 : 0)` : maskExpr(`(${left.code}) | (${right.code})`, w);
      left = { code, width: w };
    }
    return left;
  }

  function parseXor() {
    let left = parseAnd();
    while (peek()?.v === '^') {
      eat('^');
      const right = parseAnd();
      const w = Math.max(left.width, right.width);
      left = { code: maskExpr(`(${left.code}) ^ (${right.code})`, w), width: w };
    }
    return left;
  }

  function parseAnd() {
    let left = parseEq();
    while (peek()?.v === '&' || peek()?.v === '&&') {
      const op = eat().v;
      const right = parseEq();
      const w = op === '&&' ? 1 : Math.max(left.width, right.width);
      const code = op === '&&' ? `(((${left.code}) && (${right.code})) ? 1 : 0)` : maskExpr(`(${left.code}) & (${right.code})`, w);
      left = { code, width: w };
    }
    return left;
  }

  function parseEq() {
    let left = parseRel();
    while (peek()?.v === '==' || peek()?.v === '!=') {
      const op = eat().v;
      const right = parseRel();
      const l = left.signed ? signedExpr(left.code, left.width) : `(${left.code} >>> 0)`;
      const r = right.signed ? signedExpr(right.code, right.width) : `(${right.code} >>> 0)`;
      const jsOp = op === '==' ? '===' : '!==';
      left = { code: `(${l} ${jsOp} ${r} ? 1 : 0)`, width: 1 };
    }
    return left;
  }

  function parseRel() {
    let left = parseShift();
    while (['<', '<=', '>', '>='].includes(peek()?.v)) {
      const op = eat().v;
      const right = parseShift();
      const useSigned = !!(left.signed || right.signed);
      const w = Math.max(left.width, right.width);
      const l = useSigned ? signedExpr(left.code, left.width) : `(${left.code} >>> 0)`;
      const r = useSigned ? signedExpr(right.code, right.width) : `(${right.code} >>> 0)`;
      left = { code: `(${l} ${op} ${r} ? 1 : 0)`, width: 1, signed: false };
    }
    return left;
  }

  function parseShift() {
    let left = parseAdd();
    while (peek()?.v === '<<' || peek()?.v === '>>') {
      const op = eat().v;
      const right = parseAdd();
      const jsOp = op === '>>' && !left.signed ? '>>>' : op;
      left = { code: maskExpr(`(${left.code}) ${jsOp} (${right.code})`, left.width), width: left.width };
    }
    return left;
  }

  function parseAdd() {
    let left = parseMul();
    while (peek()?.v === '+' || peek()?.v === '-') {
      const op = eat().v;
      const right = parseMul();
      const w = Math.max(left.width, right.width);
      left = { code: maskExpr(`(${left.code}) ${op} (${right.code})`, w), width: w };
    }
    return left;
  }

  function parseMul() {
    let left = parseUnary();
    while (peek()?.v === '*') {
      eat('*');
      const right = parseUnary();
      const w = Math.max(left.width, right.width);
      if (w > 24) throw new Error('Wide multiply fallback to GHDL');
      left = { code: maskExpr(`Math.imul(${left.code}, ${right.code})`, w), width: w };
    }
    return left;
  }

  function parseUnary() {
    const p = peek();
    if (p?.v === '~') {
      eat('~');
      const u = parseUnary();
      return { code: maskExpr(`~(${u.code})`, u.width), width: u.width };
    }
    if (p?.v === '!') {
      eat('!');
      const u = parseUnary();
      return { code: `((${u.code}) ? 0 : 1)`, width: 1 };
    }
    if (p?.v === '-') {
      eat('-');
      const u = parseUnary();
      return { code: maskExpr(`-(${u.code})`, u.width), width: u.width };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const tok = peek();
    if (!tok) throw new Error(`Unexpected EOF in "${rawExpr}"`);
    if (tok.v === '(') {
      eat('(');
      const inner = parseTernary();
      eat(')');
      return inner;
    }
    if (tok.v === '{') {
      eat('{');
      const parts = [];
      do {
        if (peek()?.v === ',') eat(',');
        parts.push(parseTernary());
      } while (peek()?.v === ',');
      eat('}');
      const totalWidth = parts.reduce((a, b) => a + b.width, 0);
      if (totalWidth > 32) throw new Error('Wide concat fallback to GHDL');
      let acc = parts[0].code;
      for (let k = 1; k < parts.length; k++) {
        acc = `(((${acc}) << ${parts[k].width}) | (${parts[k].code}))`;
      }
      return { code: maskExpr(acc, totalWidth), width: totalWidth };
    }
    if (tok.t === 'lit') {
      eat();
      const parsed = parseBinaryLiteral(tok.v);
      if (!parsed) throw new Error(`Unsupported literal ${tok.v}`);
      return { code: `${parsed.val}`, width: parsed.width };
    }
    if (tok.t === 'num') {
      eat();
      const n = Number(tok.v);
      return { code: `${n >>> 0}`, width: 32 };
    }
    if (tok.t === 'id') {
      eat();
      if (tok.v === '$signed' || tok.v === '$unsigned') {
        eat('(');
        const inner = parseTernary();
        eat(')');
        return { code: inner.code, width: inner.width, signed: tok.v === '$signed' };
      }
      const info = symWidths.get(tok.v);
      if (!info) throw new Error(`Unknown identifier "${tok.v}"`);
      deps.add(tok.v);
      if (peek()?.v === '[') {
        eat('[');
        const first = parseTernary();
        if (peek()?.v === ':') {
          eat(':');
          const second = parseTernary();
          eat(']');
          const hi = Number(first.code), lo = Number(second.code);
          if (!Number.isInteger(hi) || !Number.isInteger(lo) || hi < lo) throw new Error(`Non-const slice on ${tok.v}`);
          const sw = hi - lo + 1;
          const shift = lo - (info.lo || 0);
          return { code: maskExpr(shift > 0 ? `(${tok.v} >>> ${shift})` : tok.v, sw), width: sw };
        }
        eat(']');
        if (memNames.has(tok.v)) {
          return { code: `${tok.v}[${first.code}]`, width: info.width };
        }
        const offset = Number(first.code) - (info.lo || 0);
        if (!Number.isInteger(offset) || offset < 0 || offset >= info.width) throw new Error(`Unsupported index on ${tok.v}`);
        return { code: maskExpr(offset > 0 ? `(${tok.v} >>> ${offset})` : tok.v, 1), width: 1 };
      }
      return { code: tok.v, width: info.width };
    }
    throw new Error(`Unexpected token ${tok.v} in "${rawExpr}"`);
  }

  const res = parseTernary();
  if (pos !== tokens.length) throw new Error(`Trailing tokens in "${rawExpr}"`);
  return { code: res.code, width: res.width, deps };
}

export function compileSynthVerilogToModule(verilogText, { clkHz = 50000000 } = {}) {
  const clean = stripVerilogComments(verilogText);
  const modMatch = clean.match(/module\s+([a-zA-Z_]\w*)\s*\(([\s\S]*?)\)\s*;([\s\S]*?)endmodule/);
  if (!modMatch) return null;
  const topName = modMatch[1];
  const portRaw = modMatch[2];
  const body = modMatch[3];

  const ports = [];
  const symWidths = new Map();
  const memNames = new Set();
  for (const part of portRaw.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const pm = p.match(/^(input|output|inout)\s*(?:wire|reg)?\s*(signed\s+)?(\[[^\]]+\])?\s*([a-zA-Z_]\w*)$/);
    if (!pm || pm[1] === 'inout' || pm[2]) return null;
    const wInfo = parseWidthSpec(pm[3]);
    if (!wInfo || wInfo.width > 32) return null;
    ports.push({ dir: pm[1], name: pm[4], ...wInfo });
    symWidths.set(pm[4], wInfo);
  }

  // Split statements by `;` except `initial begin ... end` and `case ... endcase`
  const localparams = new Map();
  const regDecls = new Map();
  const initVals = new Map();
  const memories = new Map(); // name -> { width, lo, depth, init: Map }
  const combNodes = []; // { dst, deps, emit(ctx) }
  const ffNodes = []; // { dst, clk, rst, rstVal, rhs, deps }

  // First pass: declarations & memories
  const declRe = /(?:^|;|\n)\s*(localparam|wire|reg)\s*(\[[^\]]+\])?\s*([a-zA-Z_]\w*)(?:\s*\[(\d+)\s*:\s*(\d+)\])?\s*(?:=\s*([^;]+))?\s*;/g;
  let dm;
  while ((dm = declRe.exec(body))) {
    const kind = dm[1], wSpec = dm[2], name = dm[3], mHi = dm[4], mLo = dm[5], lpVal = dm[6];
    const wInfo = parseWidthSpec(wSpec);
    if (!wInfo || wInfo.width > 32) return null;
    if (mHi !== undefined) {
      const hi = Number(mHi), lo = Number(mLo);
      if (lo !== 0 || hi >= 65536) return null;
      memNames.add(name);
      memories.set(name, { width: wInfo.width, depth: hi + 1, init: new Map() });
      symWidths.set(name, wInfo);
      continue;
    }
    symWidths.set(name, wInfo);
    if (kind === 'localparam') {
      const lit = parseBinaryLiteral((lpVal || '').trim());
      if (!lit) return null;
      localparams.set(name, lit.val);
    } else if (kind === 'reg') {
      regDecls.set(name, wInfo);
    }
  }

  // Parse `initial begin ... end` (memories) and single-line `initial x = lit;`
  let rest = body.replace(/initial\s+begin([\s\S]*?)end/g, (_, blk) => {
    for (const line of blk.split(';')) {
      const m = line.trim().match(/^([a-zA-Z_]\w*)\[(\d+)\]\s*=\s*(.+)$/);
      if (!m) continue;
      const mem = memories.get(m[1]);
      const lit = parseBinaryLiteral(m[3].trim());
      if (!mem || !lit) throw new Error('Unsupported memory init');
      mem.init.set(Number(m[2]), lit.val);
    }
    return '';
  });

  rest = rest.replace(/initial\s+([a-zA-Z_]\w*)\s*=\s*([^;]+);/g, (_, name, rhs) => {
    const lit = parseBinaryLiteral(rhs.trim());
    if (lit) initVals.set(name, lit.val);
    return '';
  });

  // Parse `always @* case (...) ... endcase`
  rest = rest.replace(/always\s*@\s*\*\s*case\s*\(\s*([a-zA-Z_]\w*)\s*\)([\s\S]*?)endcase/g, (_, selName, blk) => {
    const branches = [];
    let defaultBranch = null;
    let targetDst = null;
    const deps = new Set([selName]);
    for (const stmt of blk.split(';')) {
      const s = stmt.trim();
      if (!s) continue;
      const m = s.match(/^(default|\d+'[bdh][0-9a-fA-F_]+)\s*:\s*([a-zA-Z_]\w*)\s*=\s*(.+)$/);
      if (!m) return '; /*unsupported case*/';
      targetDst = m[2];
      const expr = compileExpression(m[3], symWidths, memNames);
      for (const d of expr.deps) deps.add(d);
      if (m[1] === 'default') defaultBranch = expr.code;
      else {
        const lit = parseBinaryLiteral(m[1]);
        if (!lit) return '; /*unsupported case lit*/';
        branches.push({ val: lit.val, code: expr.code });
      }
    }
    if (!targetDst) return '';
    combNodes.push({
      dst: targetDst,
      deps,
      emit: () => {
        const lines = [`let ${targetDst};`, `switch (${selName}) {`];
        for (const b of branches) lines.push(`  case ${b.val}: ${targetDst} = ${b.code}; break;`);
        if (defaultBranch !== null) lines.push(`  default: ${targetDst} = ${defaultBranch}; break;`);
        lines.push(`}`);
        return lines.join('\n');
      },
    });
    return '';
  });

  // Bail if any unhandled `case` or `initial` remains
  if (/\bcase\b/.test(rest)) return null;

  // Parse `always @(posedge clk ...)` flip-flops
  rest = rest.replace(/always\s*@\s*\(\s*posedge\s+([a-zA-Z_]\w*)(?:\s+or\s+posedge\s+([a-zA-Z_]\w*))?\s*\)\s*(?:if\s*\(\s*([a-zA-Z_]\w*)\s*\)\s*([a-zA-Z_]\w*)\s*<=\s*([^;]+);\s*else\s*)?([a-zA-Z_]\w*)\s*<=\s*([^;]+);/g,
    (_, clk, asyncRst, ifRst, dst1, val1, dst2, val2) => {
      if (asyncRst && asyncRst !== ifRst) return '; /*bad async*/';
      const dst = dst2;
      const rhs = compileExpression(val2, symWidths, memNames);
      const deps = new Set(rhs.deps);
      let rstCode = null;
      if (asyncRst) {
        if (dst1 !== dst2) return '; /*mismatch async*/';
        const rExpr = compileExpression(val1, symWidths, memNames);
        rstCode = rExpr.code;
        for (const d of rExpr.deps) deps.add(d);
        deps.add(asyncRst);
      }
      ffNodes.push({ dst, clk, rst: asyncRst || null, rstCode, rhsCode: rhs.code, deps });
      return '';
    });

  // Check for unhandled `always @(` blocks (like negedge or RAM writes)
  if (/always\s*@\s*\(/.test(rest)) return null;

  // Parse remaining `assign dst = rhs;` and `always @* dst = rhs;`
  const assignRe = /(?:assign|always\s*@\s*\*)\s+([a-zA-Z_]\w*)\s*=\s*([^;]+);/g;
  let am;
  while ((am = assignRe.exec(rest))) {
    const dst = am[1], rhsRaw = am[2];
    const expr = compileExpression(rhsRaw, symWidths, memNames);
    const wInfo = symWidths.get(dst);
    if (!wInfo) return null;
    combNodes.push({
      dst,
      deps: expr.deps,
      emit: () => `const ${dst} = ${maskExpr(expr.code, wInfo.width)};`,
    });
  }

  // Ensure all FFs share at most 1 clock net
  const clocks = [...new Set(ffNodes.map(f => f.clk))];
  if (clocks.length > 1) return null;
  const clkPort = clocks[0] || null;
  if (ffNodes.length > 0 && !ports.some(p => p.dir === 'input' && p.name === clkPort)) return null;

  // Topological sort of combNodes
  const ffSet = new Set(ffNodes.map(f => f.dst));
  const inputSet = new Set(ports.filter(p => p.dir === 'input').map(p => p.name));
  const nodeByDst = new Map();
  for (const n of combNodes) {
    if (nodeByDst.has(n.dst)) return null;
    nodeByDst.set(n.dst, n);
  }
  const sortedComb = [];
  const visitState = new Map(); // 0/undef=unvisited, 1=visiting, 2=done
  function visit(dst) {
    const st = visitState.get(dst);
    if (st === 2) return true;
    if (st === 1) return false; // combinational loop
    const node = nodeByDst.get(dst);
    if (!node) return true;
    visitState.set(dst, 1);
    for (const dep of node.deps) {
      if (ffSet.has(dep) || inputSet.has(dep) || localparams.has(dep) || memNames.has(dep)) continue;
      if (!visit(dep)) return false;
    }
    visitState.set(dst, 2);
    sortedComb.push(node);
    return true;
  }
  for (const n of combNodes) {
    if (!visit(n.dst)) return null;
  }

  // Gather observable named internal signals (excluding internal compiler temps `n<digits>`)
  const internalSignals = [];
  for (const [name, info] of symWidths.entries()) {
    if (ports.some(p => p.name === name) || memNames.has(name) || localparams.has(name)) continue;
    if (/^n\d+$/.test(name)) continue;
    if (nodeByDst.has(name) || ffSet.has(name)) internalSignals.push({ name, ...info });
  }

  const inputPorts = ports.filter(p => p.dir === 'input' && p.name !== clkPort);
  const outputPorts = ports.filter(p => p.dir === 'output');
  const observedSignals = [...outputPorts, ...internalSignals];

  const lines = [];
  lines.push(`// Auto-generated real-time RTL runner for ${topName}`);
  lines.push(`export const meta = ${JSON.stringify({
    top: topName,
    clock: clkPort,
    defaultClkHz: clkHz,
    inputs: inputPorts,
    outputs: outputPorts,
    internals: internalSignals,
    observed: observedSignals.map(s => ({ name: s.name, width: s.width, hi: s.hi, lo: s.lo })),
  })};`);
  lines.push(`export function createRunner(_rt_beepName = '') {`);
  for (const [name, val] of localparams.entries()) lines.push(`  const ${name} = ${val};`);
  for (const [name, mem] of memories.entries()) {
    const arr = new Array(mem.depth).fill(0);
    for (const [idx, v] of mem.init.entries()) arr[idx] = v;
    lines.push(`  const ${name} = new Uint32Array(${JSON.stringify(arr)});`);
  }
  for (const inp of inputPorts) lines.push(`  let ${inp.name} = ${inp.width === 1 ? (inp.width === 1 ? 1 : 0) : 0};`);
  if (clkPort) lines.push(`  let ${clkPort} = 0;`);
  for (const ff of ffNodes) {
    const init = initVals.has(ff.dst) ? initVals.get(ff.dst) : 0;
    lines.push(`  let ${ff.dst} = ${init};`);
  }
  const scalarOutputs = outputPorts.filter(p => p.width === 1);
  const collectCombCone = seedNames => {
    const needed = new Set();
    const stack = [...seedNames];
    while (stack.length) {
      const cur = stack.pop();
      if (needed.has(cur)) continue;
      needed.add(cur);
      const node = nodeByDst.get(cur);
      if (node) for (const d of node.deps) stack.push(d);
    }
    return sortedComb.filter(n => needed.has(n.dst));
  };
  const ffSeedNames = [];
  for (const ff of ffNodes) for (const d of ff.deps) ffSeedNames.push(d);
  const ffCombNodes = collectCombCone(ffSeedNames);
  const combEmitNoAudio = ffCombNodes.map(n => `      ${n.emit().replace(/\n/g, '\n      ')}`).join('\n');
  const nextEmit = ffNodes.map(ff => {
    const wInfo = symWidths.get(ff.dst);
    const expr = ff.rst ? `(${ff.rst} ? (${ff.rstCode}) : (${ff.rhsCode}))` : ff.rhsCode;
    return `      const _next_${ff.dst} = ${maskExpr(expr, wInfo.width)};`;
  }).join('\n');
  const commitEmit = ffNodes.map(ff => `      ${ff.dst} = _next_${ff.dst};`).join('\n');
  const snapWrites = observedSignals.map((s, idx) => `    _rt_dst[${idx}] = ${s.name} >>> 0;`).join('\n');
  const combEmitTop = sortedComb.map(n => `    ${n.emit().replace(/\n/g, '\n    ')}`).join('\n');

  lines.push(`  const _rt_snap = new Uint32Array(${observedSignals.length});`);
  lines.push(`  function _rt_evalTo(_rt_dst) {`);
  lines.push(combEmitTop);
  lines.push(snapWrites);
  lines.push(`  }`);

  lines.push(`  function reset() {`);
  for (const ff of ffNodes) {
    const init = initVals.has(ff.dst) ? initVals.get(ff.dst) : 0;
    lines.push(`    ${ff.dst} = ${init};`);
  }
  lines.push(`  }`);

  lines.push(`  function setInput(_rt_name, _rt_val) {`);
  lines.push(`    switch (_rt_name) {`);
  for (const inp of inputPorts) lines.push(`      case ${JSON.stringify(inp.name)}: ${inp.name} = ${maskExpr('_rt_val', inp.width)}; break;`);
  lines.push(`    }`);
  lines.push(`  }`);

  lines.push(`  function setBeepPort(_rt_name) { _rt_beepName = _rt_name || ''; }`);

  lines.push(`  function _rt_stepNoAudio(_rt_n) {`);
  lines.push(`    for (let _rt_k = 0; _rt_k < _rt_n; _rt_k++) {`);
  lines.push(combEmitNoAudio);
  lines.push(nextEmit);
  lines.push(commitEmit);
  lines.push(`    }`);
  lines.push(`  }`);

  const useSpecializedAudio = scalarOutputs.length > 0 && scalarOutputs.length <= 16;
  if (useSpecializedAudio) {
    lines.push(`  const _rt_audioSteppers = [`);
    for (const p of scalarOutputs) {
      const coneNodes = collectCombCone([...ffSeedNames, p.name]);
      const audioCombEmit = coneNodes.map(n => `        ${n.emit().replace(/\n/g, '\n        ')}`).join('\n');
      const nextEmitIndented = nextEmit.replace(/^/gm, '  ');
      const commitEmitIndented = commitEmit.replace(/^/gm, '  ');
      lines.push(`    function(_rt_n) {`);
      lines.push(`      let _rt_beepSum = 0;`);
      lines.push(`      for (let _rt_k = 0; _rt_k < _rt_n; _rt_k++) {`);
      lines.push(audioCombEmit);
      lines.push(`        _rt_beepSum += ${p.name};`);
      lines.push(nextEmitIndented);
      lines.push(commitEmitIndented);
      lines.push(`      }`);
      lines.push(`      return _rt_beepSum;`);
      lines.push(`    },`);
    }
    lines.push(`  ];`);
    lines.push(`  function _rt_stepWithAudio(_rt_n, _rt_beepIdx) {`);
    lines.push(`    const _rt_fn = _rt_audioSteppers[_rt_beepIdx];`);
    lines.push(`    if (_rt_fn) return _rt_fn(_rt_n);`);
    lines.push(`    _rt_stepNoAudio(_rt_n);`);
    lines.push(`    return 0;`);
    lines.push(`  }`);
  } else {
    const allHotNodes = collectCombCone([...ffSeedNames, ...scalarOutputs.map(p => p.name)]);
    const combEmitAll = allHotNodes.map(n => `      ${n.emit().replace(/\n/g, '\n      ')}`).join('\n');
    lines.push(`  function _rt_stepWithAudio(_rt_n, _rt_beepIdx) {`);
    lines.push(`    let _rt_beepSum = 0;`);
    lines.push(`    for (let _rt_k = 0; _rt_k < _rt_n; _rt_k++) {`);
    lines.push(combEmitAll);
    if (scalarOutputs.length > 1) {
      lines.push(`      let _rt_b = 0;`);
      lines.push(`      switch (_rt_beepIdx) {`);
      scalarOutputs.forEach((p, idx) => lines.push(`        case ${idx}: _rt_b = ${p.name}; break;`));
      lines.push(`      }`);
      lines.push(`      _rt_beepSum += _rt_b;`);
    }
    lines.push(nextEmit);
    lines.push(commitEmit);
    lines.push(`    }`);
    lines.push(`    return _rt_beepSum;`);
    lines.push(`  }`);
  }

  lines.push(`  function _rt_runLoop(_rt_total, _rt_sTarget, _rt_audioOut, _rt_beepIdx) {`);
  lines.push(`    const _rt_samples = [];`);
  lines.push(`    if (_rt_total <= 0) {`);
  lines.push(`      _rt_evalTo(_rt_snap);`);
  lines.push(`      _rt_samples.push({ offset: 0, vals: _rt_snap.slice() });`);
  lines.push(`      return { samples: _rt_samples, cyclesRun: 0 };`);
  lines.push(`    }`);
  lines.push(`    const _rt_sampleStep = _rt_total / _rt_sTarget;`);
  lines.push(`    let _rt_nextSampleAt = _rt_sampleStep;`);
  lines.push(`    const _rt_aCount = _rt_audioOut ? _rt_audioOut.length : 0;`);
  lines.push(`    const _rt_audioStep = _rt_aCount > 0 ? _rt_total / _rt_aCount : 1e18;`);
  lines.push(`    let _rt_nextAudioAt = _rt_audioStep;`);
  lines.push(`    let _rt_c = 0, _rt_beepSum = 0, _rt_beepCnt = 0, _rt_aIdx = 0, _rt_lastAudio = 0;`);
  lines.push(`    while (_rt_c < _rt_total) {`);
  lines.push(`      let _rt_next = _rt_total;`);
  lines.push(`      if (_rt_aCount > 0 && _rt_aIdx < _rt_aCount) {`);
  lines.push(`        const _rt_aTarget = Math.ceil(_rt_nextAudioAt);`);
  lines.push(`        if (_rt_aTarget < _rt_next) _rt_next = _rt_aTarget;`);
  lines.push(`      }`);
  lines.push(`      if (_rt_samples.length < _rt_sTarget - 1) {`);
  lines.push(`        const _rt_sTargetC = Math.ceil(_rt_nextSampleAt);`);
  lines.push(`        if (_rt_sTargetC < _rt_next) _rt_next = _rt_sTargetC;`);
  lines.push(`      }`);
  lines.push(`      const _rt_chunk = Math.max(1, _rt_next - _rt_c);`);
  lines.push(`      if (_rt_aCount > 0) {`);
  lines.push(`        _rt_beepSum += _rt_stepWithAudio(_rt_chunk, _rt_beepIdx);`);
  lines.push(`        _rt_beepCnt += _rt_chunk;`);
  lines.push(`      } else {`);
  lines.push(`        _rt_stepNoAudio(_rt_chunk);`);
  lines.push(`      }`);
  lines.push(`      _rt_c += _rt_chunk;`);
  lines.push(`      if (_rt_aCount > 0 && _rt_c >= _rt_nextAudioAt && _rt_aIdx < _rt_aCount) {`);
  lines.push(`        _rt_lastAudio = (_rt_beepSum / _rt_beepCnt) * 2 - 1;`);
  lines.push(`        _rt_audioOut[_rt_aIdx++] = _rt_lastAudio;`);
  lines.push(`        _rt_beepSum = 0; _rt_beepCnt = 0;`);
  lines.push(`        _rt_nextAudioAt += _rt_audioStep;`);
  lines.push(`      }`);
  lines.push(`      if (_rt_c >= _rt_nextSampleAt && _rt_samples.length < _rt_sTarget - 1) {`);
  lines.push(`        _rt_evalTo(_rt_snap);`);
  lines.push(`        _rt_samples.push({ offset: _rt_c, vals: _rt_snap.slice() });`);
  lines.push(`        _rt_nextSampleAt += _rt_sampleStep;`);
  lines.push(`      }`);
  lines.push(`    }`);
  lines.push(`    if (_rt_aCount > 0 && _rt_aIdx < _rt_aCount) {`);
  lines.push(`      if (_rt_beepCnt > 0) _rt_lastAudio = (_rt_beepSum / _rt_beepCnt) * 2 - 1;`);
  lines.push(`      while (_rt_aIdx < _rt_aCount) _rt_audioOut[_rt_aIdx++] = _rt_lastAudio;`);
  lines.push(`    }`);
  lines.push(`    _rt_evalTo(_rt_snap);`);
  lines.push(`    _rt_samples.push({ offset: _rt_total, vals: _rt_snap.slice() });`);
  lines.push(`    return { samples: _rt_samples, cyclesRun: _rt_total };`);
  lines.push(`  }`);

  const beepNamesJson = JSON.stringify(scalarOutputs.map(p => p.name));
  lines.push(`  const _rt_scalarOuts = ${beepNamesJson};`);
  lines.push(`  function runBatch(cycles, sampleCount = 96, audioOut = null) {`);
  lines.push(`    const _rt_total = Math.max(0, cycles | 0);`);
  lines.push(`    const _rt_sTarget = Math.max(1, Math.min(Math.max(1, _rt_total), sampleCount | 0));`);
  lines.push(`    const _rt_beepIdx = _rt_beepName ? _rt_scalarOuts.indexOf(_rt_beepName) : -1;`);
  lines.push(`    return _rt_runLoop(_rt_total, _rt_sTarget, audioOut, _rt_beepIdx);`);
  lines.push(`  }`);
  lines.push(`  return { meta, reset, setInput, setBeepPort, runBatch };`);
  lines.push(`}`);
  return lines.join('\n');
}
