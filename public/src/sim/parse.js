// VHDL lexer + recursive-descent parser -> AST.
// Covers the synthesizable subset used in coursework plus testbench constructs.

const KEYWORDS = new Set(('abs access after alias all and architecture array assert attribute begin block body buffer bus case component configuration constant disconnect downto else elsif end entity exit file for function generate generic group guarded if impure in inertial inout is label library linkage literal loop map mod nand new next nor not null of on open or others out package port postponed procedure process pure range record register reject rem report return rol ror select severity shared signal sla sll sra srl subtype then to transport type unaffected units until use variable wait when while with xnor xor').split(' '));

// internal time unit = femtoseconds
const TIME_UNITS = { fs: 1, ps: 1e3, ns: 1e6, us: 1e9, ms: 1e12, sec: 1e15, min: 6e16, hr: 3.6e18 };

export function lex(src, file = '<input>') {
  const toks = [];
  let i = 0, line = 1, col = 1;
  const n = src.length;
  const push = (kind, value, extra) => toks.push({ kind, value, line, col, file, ...extra });
  while (i < n) {
    const c = src[i];
    if (c === '\n') { i++; line++; col = 1; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; col++; continue; }
    if (c === '-' && src[i + 1] === '-') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') { line++; col = 1; } i++; } i += 2; continue; }
    const startLine = line, startCol = col;
    // bit string / hex / octal / binary literals: x"FF", b"1010", o"77", "0101"
    if (/[xobdXOBD]/.test(c) && src[i + 1] === '"') {
      const base = c.toLowerCase();
      let j = i + 2, s = '';
      while (j < n && src[j] !== '"') { s += src[j]; j++; }
      i = j + 1; col += (i - (startCol - 1));
      push('bitstr', s.replace(/_/g, '').toLowerCase(), { base, raw: s, line: startLine, col: startCol });
      continue;
    }
    if (c === '"') {
      let j = i + 1, s = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '"' && src[j + 1] === '"') { s += '"'; j += 2; continue; }
        s += src[j]; j++;
      }
      i = j + 1;
      push('bitstr', s.toLowerCase(), { base: 'b', raw: s, line: startLine, col: startCol });
      continue;
    }
    if (c === "'") {
      // char literal '0' / '1' / 'a' vs attribute 'event
      if (src[i + 2] === "'") {
        push('charlit', src[i + 1], { line: startLine, col: startCol });
        i += 3; col += 3; continue;
      }
      let j = i + 1, s = '';
      while (j < n && /[a-zA-Z0-9_]/.test(src[j])) { s += src[j]; j++; }
      if (s.length && src[j] !== "'") {
        // attribute name like 'range handled as attr token
      }
      i = j;
      push('attr', s.toLowerCase(), { line: startLine, col: startCol });
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i, s = '';
      while (j < n && /[0-9a-fA-F_#.eE+\-]/.test(src[j])) {
        // stop before exponent sign unless preceded by e/E
        if ((src[j] === '+' || src[j] === '-') && !/[eE]/.test(src[j - 1])) break;
        s += src[j]; j++;
      }
      i = j;
      const clean = s.replace(/_/g, '');
      if (clean.includes('#')) {
        const m = clean.match(/^(\d+)#([0-9a-fA-F.]+)#(?:[eE]([+-]?\d+))?$/);
        if (m) {
          const base = parseInt(m[1], 10);
          let v = parseInt(m[2].split('.')[0], base);
          if (m[3]) v *= Math.pow(base, parseInt(m[3], 10));
          push('num', v, { line: startLine, col: startCol });
        } else push('num', parseFloat(clean), { line: startLine, col: startCol });
      } else if (/[.eE]/.test(clean)) {
        push('realnum', parseFloat(clean), { line: startLine, col: startCol });
      } else {
        push('num', parseInt(clean, 10), { line: startLine, col: startCol });
      }
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i, s = '';
      while (j < n && /[a-zA-Z0-9_]/.test(src[j])) { s += src[j]; j++; }
      i = j;
      const low = s.toLowerCase();
      push(KEYWORDS.has(low) ? 'kw' : 'id', low, { orig: s, line: startLine, col: startCol });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['<=', '=>', ':=', '/=', '>=', '**', '<<', '>>', '??', '?=', '?/=', '?<', '?<=', '?>', '?>='].includes(two)) {
      push('sym', two, { line: startLine, col: startCol }); i += 2; col += 2; continue;
    }
    if ('()[]:;,.+-*/<>=&|'.includes(c)) {
      push('sym', c, { line: startLine, col: startCol }); i++; col++; continue;
    }
    throw new Error(`${file}:${startLine}:${startCol}: unexpected character '${c}'`);
  }
  push('eof', null, { line, col });
  return toks;
}

export class Parser {
  constructor(toks, file = '<input>') {
    this.toks = toks; this.pos = 0; this.file = file;
  }
  peek(k = 0) { return this.toks[Math.min(this.pos + k, this.toks.length - 1)]; }
  next() { return this.toks[this.pos++]; }
  at(kind, value) { const t = this.peek(); return t.kind === kind && (value === undefined || t.value === value); }
  atKw(...vals) { return this.at('kw') && vals.includes(this.peek().value); }
  atSym(...vals) { return this.at('sym') && vals.includes(this.peek().value); }
  accept(kind, value) { if (this.at(kind, value)) return this.next(); return null; }
  acceptKw(...vals) { if (this.atKw(...vals)) return this.next(); return null; }
  acceptSym(...vals) { if (this.atSym(...vals)) return this.next(); return null; }
  expect(kind, value) {
    const t = this.next();
    if (t.kind !== kind || (value !== undefined && t.value !== value)) {
      throw new Error(`${this.file}:${t.line}:${t.col}: expected ${value || kind}, got '${t.value ?? t.kind}'`);
    }
    return t;
  }
  expectKw(v) { return this.expect('kw', v); }
  expectSym(v) { return this.expect('sym', v); }
  err(msg) { const t = this.peek(); throw new Error(`${this.file}:${t.line}:${t.col}: ${msg}`); }

  parseDesignFile() {
    const units = [];
    const context = [];
    while (!this.at('eof')) {
      if (this.acceptKw('library')) {
        const names = [this.expect('id').value];
        while (this.acceptSym(',')) names.push(this.expect('id').value);
        this.expectSym(';');
        context.push({ kind: 'library', names });
      } else if (this.acceptKw('use')) {
        const sel = this.parseSelectedName();
        this.expectSym(';');
        context.push({ kind: 'use', sel });
      } else if (this.atKw('entity')) units.push(this.parseEntity(context.splice(0)));
      else if (this.atKw('architecture')) units.push(this.parseArchitecture(context.splice(0)));
      else if (this.atKw('package')) units.push(this.parsePackage(context.splice(0)));
      else if (this.atKw('configuration')) { this.skipConfiguration(); }
      else this.err(`unexpected token '${this.peek().value}' at design-file level`);
    }
    return { kind: 'designFile', file: this.file, units };
  }

  skipConfiguration() {
    // consume until matching 'end' at depth 0 (configurations are not simulated)
    let depth = 0;
    while (!this.at('eof')) {
      const t = this.next();
      if (t.kind === 'kw' && ['configuration', 'block', 'for', 'if', 'case', 'loop'].includes(t.value)) depth++;
      if (t.kind === 'kw' && t.value === 'end') { if (depth === 0) break; depth--; }
    }
    this.acceptKw('configuration'); this.accept('id'); this.expectSym(';');
  }

  parseSelectedName() {
    let s = this.expect('id').value;
    while (this.acceptSym('.')) {
      if (this.acceptKw('all')) { s += '.all'; break; }
      s += '.' + this.expect('id').value;
    }
    return s;
  }

  parseEntity(context) {
    this.expectKw('entity');
    const name = this.expect('id').value;
    this.expectKw('is');
    const generics = [];
    const ports = [];
    if (this.acceptKw('generic')) { this.expectSym('('); this.parseInterfaceList(generics, 'constant'); this.expectSym(')'); this.expectSym(';'); }
    if (this.acceptKw('port')) { this.expectSym('('); this.parseInterfaceList(ports, 'signal'); this.expectSym(')'); this.expectSym(';'); }
    // entity declarative part (rare): skip to begin/end
    while (!this.atKw('end', 'begin') && !this.at('eof')) {
      if (this.atKw('signal', 'constant', 'type', 'subtype', 'attribute', 'use')) this.parseDeclaration();
      else this.next();
    }
    if (this.acceptKw('begin')) { while (!this.atKw('end') && !this.at('eof')) this.next(); }
    this.expectKw('end');
    this.acceptKw('entity'); this.accept('id'); this.expectSym(';');
    return { kind: 'entity', name, generics, ports, context };
  }

  parseInterfaceList(out, defaultClass) {
    for (;;) {
      let cls = defaultClass;
      if (this.atKw('signal', 'constant', 'variable')) cls = this.next().value;
      const names = [this.expect('id').value];
      while (this.acceptSym(',')) names.push(this.expect('id').value);
      this.expectSym(':');
      let mode = 'in';
      if (this.atKw('in', 'out', 'inout', 'buffer', 'linkage')) mode = this.next().value;
      const type = this.parseTypeMark();
      let constraint = null;
      if (this.atKw('range')) constraint = this.parseRangeConstraint();
      else if (this.atSym('(')) constraint = this.parseIndexConstraint();
      let init = null;
      if (this.acceptSym(':=')) init = this.parseExpr();
      for (const nm of names) out.push({ name: nm, class: cls, mode, type, constraint, init });
      if (!this.acceptSym(';')) break;
      if (this.atSym(')')) break;
    }
  }

  parseTypeMark() {
    let name = this.expect('id').value;
    while (this.acceptSym('.')) name += '.' + this.expect('id').value;
    return name;
  }

  parseRangeConstraint() {
    this.expectKw('range');
    return this.parseRange();
  }
  parseRange() {
    const left = this.parseExpr();
    if (this.atKw('to', 'downto')) {
      const dir = this.next().value;
      const right = this.parseExpr();
      return { kind: 'range', left, dir, right };
    }
    return { kind: 'rangeExpr', expr: left };
  }
  parseIndexConstraint() {
    this.expectSym('(');
    const r = this.parseRange();
    this.expectSym(')');
    return r;
  }

  parseArchitecture(context) {
    this.expectKw('architecture');
    const name = this.expect('id').value;
    this.expectKw('of');
    const entity = this.expect('id').value;
    this.expectKw('is');
    const decls = [];
    while (!this.atKw('begin') && !this.at('eof')) decls.push(this.parseDeclaration());
    this.expectKw('begin');
    const stmts = [];
    while (!this.atKw('end') && !this.at('eof')) stmts.push(this.parseConcurrent());
    this.expectKw('end');
    this.acceptKw('architecture'); this.accept('id'); this.expectSym(';');
    return { kind: 'architecture', name, entity, decls, stmts, context };
  }

  parsePackage(context) {
    this.expectKw('package');
    if (this.acceptKw('body')) {
      const name = this.expect('id').value;
      this.expectKw('is');
      const decls = [];
      while (!this.atKw('end') && !this.at('eof')) decls.push(this.parseDeclaration());
      this.expectKw('end');
      this.acceptKw('package'); this.acceptKw('body'); this.accept('id'); this.expectSym(';');
      return { kind: 'packageBody', name, decls, context };
    }
    const name = this.expect('id').value;
    this.expectKw('is');
    const decls = [];
    while (!this.atKw('end') && !this.at('eof')) decls.push(this.parseDeclaration());
    this.expectKw('end');
    this.acceptKw('package'); this.accept('id'); this.expectSym(';');
    return { kind: 'package', name, decls, context };
  }

  parseDeclaration() {
    if (this.atKw('signal')) {
      this.next();
      const names = [this.expect('id').value];
      while (this.acceptSym(',')) names.push(this.expect('id').value);
      this.expectSym(':');
      const type = this.parseTypeMark();
      let constraint = null;
      if (this.atKw('range')) constraint = this.parseRangeConstraint();
      else if (this.atSym('(')) constraint = this.parseIndexConstraint();
      let init = null;
      if (this.acceptSym(':=')) init = this.parseExpr();
      this.expectSym(';');
      return { kind: 'signalDecl', names, type, constraint, init };
    }
    if (this.atKw('constant')) {
      this.next();
      const names = [this.expect('id').value];
      while (this.acceptSym(',')) names.push(this.expect('id').value);
      this.expectSym(':');
      const type = this.parseTypeMark();
      let constraint = null;
      if (this.atKw('range')) constraint = this.parseRangeConstraint();
      else if (this.atSym('(')) constraint = this.parseIndexConstraint();
      let init = null;
      if (this.acceptSym(':=')) init = this.parseExpr();
      this.expectSym(';');
      return { kind: 'constantDecl', names, type, constraint, init };
    }
    if (this.atKw('variable', 'shared')) {
      this.acceptKw('shared');
      this.expectKw('variable');
      const names = [this.expect('id').value];
      while (this.acceptSym(',')) names.push(this.expect('id').value);
      this.expectSym(':');
      const type = this.parseTypeMark();
      let constraint = null;
      if (this.atKw('range')) constraint = this.parseRangeConstraint();
      else if (this.atSym('(')) constraint = this.parseIndexConstraint();
      let init = null;
      if (this.acceptSym(':=')) init = this.parseExpr();
      this.expectSym(';');
      return { kind: 'variableDecl', names, type, constraint, init };
    }
    if (this.atKw('subtype')) {
      this.next();
      const name = this.expect('id').value;
      this.expectKw('is');
      const type = this.parseTypeMark();
      let constraint = null;
      if (this.atKw('range')) constraint = this.parseRangeConstraint();
      else if (this.atSym('(')) constraint = this.parseIndexConstraint();
      this.expectSym(';');
      return { kind: 'subtypeDecl', name, type, constraint };
    }
    if (this.atKw('type')) {
      this.next();
      const name = this.expect('id').value;
      if (this.acceptSym(';')) return { kind: 'incompleteType', name };
      this.expectKw('is');
      if (this.acceptSym('(')) {
        const literals = [this.parseEnumLiteral()];
        while (this.acceptSym(',')) literals.push(this.parseEnumLiteral());
        this.expectSym(')');
        this.expectSym(';');
        return { kind: 'enumType', name, literals };
      }
      if (this.acceptKw('array')) {
        this.expectSym('(');
        let index;
        if (this.atKw('range')) { this.next(); index = { kind: 'unconstrained' }; this.acceptSym('<>'); }
        else if (this.at('id') && this.peek(1).kind === 'kw' && this.peek(1).value === 'range') {
          index = { kind: 'typeRange', type: this.next().value }; this.next(); this.acceptSym('<>');
        } else {
          index = this.parseRange();
        }
        this.expectSym(')');
        this.expectKw('of');
        const elem = this.parseTypeMark();
        this.expectSym(';');
        return { kind: 'arrayType', name, index, elem };
      }
      if (this.acceptKw('range')) {
        const r = this.parseRange();
        this.expectSym(';');
        return { kind: 'rangeType', name, range: r };
      }
      this.err('unsupported type definition');
    }
    if (this.atKw('component')) {
      this.next();
      const name = this.expect('id').value;
      this.acceptKw('is');
      const generics = [], ports = [];
      if (this.acceptKw('generic')) { this.expectSym('('); this.parseInterfaceList(generics, 'constant'); this.expectSym(')'); this.expectSym(';'); }
      if (this.acceptKw('port')) { this.expectSym('('); this.parseInterfaceList(ports, 'signal'); this.expectSym(')'); this.expectSym(';'); }
      this.expectKw('end');
      this.acceptKw('component'); this.accept('id'); this.expectSym(';');
      return { kind: 'componentDecl', name, generics, ports };
    }
    if (this.atKw('function', 'procedure', 'impure', 'pure')) {
      return this.parseSubprogram();
    }
    if (this.atKw('attribute')) {
      // attribute decl/spec: consume to ';'
      while (!this.atSym(';') && !this.at('eof')) this.next();
      this.expectSym(';');
      return { kind: 'attributeDecl' };
    }
    if (this.atKw('use')) {
      this.next();
      const sel = this.parseSelectedName();
      this.expectSym(';');
      return { kind: 'use', sel };
    }
    if (this.atKw('alias')) {
      while (!this.atSym(';') && !this.at('eof')) this.next();
      this.expectSym(';');
      return { kind: 'aliasDecl' };
    }
    this.err(`unsupported declaration near '${this.peek().value}'`);
  }

  parseEnumLiteral() {
    if (this.at('charlit')) return this.next().value;
    return this.expect('id').value;
  }

  parseSubprogram() {
    this.acceptKw('impure'); this.acceptKw('pure');
    const kind = this.next().value; // function | procedure
    const name = this.at('id') ? this.next().value : this.expect('bitstr').value; // operator overload "and" etc as string
    const params = [];
    if (this.acceptSym('(')) {
      for (;;) {
        let cls = 'constant';
        if (this.atKw('signal', 'constant', 'variable')) cls = this.next().value;
        const names = [this.expect('id').value];
        while (this.acceptSym(',')) names.push(this.expect('id').value);
        this.expectSym(':');
        let mode = 'in';
        if (this.atKw('in', 'out', 'inout')) mode = this.next().value;
        const type = this.parseTypeMark();
        let constraint = null;
        if (this.atSym('(')) constraint = this.parseIndexConstraint();
        else if (this.atKw('range')) constraint = this.parseRangeConstraint();
        let init = null;
        if (this.acceptSym(':=')) init = this.parseExpr();
        for (const nm of names) params.push({ name: nm, class: cls, mode, type, constraint, init });
        if (!this.acceptSym(';')) break;
        if (this.atSym(')')) break;
      }
      this.expectSym(')');
    }
    let retType = null;
    if (kind === 'function') { this.expectKw('return'); retType = this.parseTypeMark(); }
    if (this.acceptSym(';')) return { kind: 'subprogramSpec', subkind: kind, name, params, retType };
    this.expectKw('is');
    const decls = [];
    while (!this.atKw('begin') && !this.at('eof')) decls.push(this.parseDeclaration());
    this.expectKw('begin');
    const body = this.parseSeqStmts(['end']);
    this.expectKw('end');
    this.acceptKw(kind); this.accept('id'); this.accept('bitstr'); this.expectSym(';');
    return { kind: 'subprogramBody', subkind: kind, name, params, retType, decls, body };
  }

  // ---------- concurrent statements ----------
  parseConcurrent() {
    // labeled?
    let label = null;
    if (this.at('id') && this.peek(1).kind === 'sym' && this.peek(1).value === ':') {
      label = this.next().value; this.next();
    }
    if (this.acceptKw('process')) {
      let sens = null;
      if (this.acceptSym('(')) {
        sens = [];
        if (!this.atSym(')')) {
          sens.push(this.parseName());
          while (this.acceptSym(',')) sens.push(this.parseName());
        }
        this.expectSym(')');
      }
      this.acceptKw('is');
      const decls = [];
      while (!this.atKw('begin') && !this.at('eof')) decls.push(this.parseDeclaration());
      this.expectKw('begin');
      const body = this.parseSeqStmts(['end']);
      this.expectKw('end');
      this.acceptKw('postponed'); this.acceptKw('process'); this.accept('id'); this.expectSym(';');
      return { kind: 'process', label, sens, decls, body };
    }
    if (this.acceptKw('with')) {
      const sel = this.parseExpr();
      this.expectKw('select');
      const target = this.parseName();
      this.expectSym('<=');
      const waves = [];
      for (;;) {
        const value = this.parseExpr();
        this.expectKw('when');
        const choices = this.parseChoices();
        waves.push({ value, choices });
        if (!this.acceptSym(',')) break;
      }
      this.expectSym(';');
      return { kind: 'selectedAssign', label, sel, target, waves };
    }
    if (this.acceptKw('for')) {
      const id = this.expect('id').value;
      this.expectKw('in');
      const range = this.parseRange();
      this.expectKw('generate');
      const decls = [];
      while (!this.atKw('begin') && !this.at('eof')) decls.push(this.parseDeclaration());
      let stmts = [];
      if (this.acceptKw('begin')) {
        while (!this.atKw('end') && !this.at('eof')) stmts.push(this.parseConcurrent());
      } else {
        while (!this.atKw('end') && !this.at('eof')) stmts.push(this.parseConcurrent());
      }
      this.expectKw('end');
      this.acceptKw('generate'); this.accept('id'); this.expectSym(';');
      return { kind: 'forGenerate', label, id, range, decls, stmts };
    }
    if (this.acceptKw('if')) {
      const cond = this.parseExpr();
      this.expectKw('generate');
      const stmts = [];
      while (!this.atKw('end', 'else', 'elsif') && !this.at('eof')) stmts.push(this.parseConcurrent());
      let elseStmts = null;
      if (this.acceptKw('else')) {
        this.acceptKw('generate');
        elseStmts = [];
        while (!this.atKw('end') && !this.at('eof')) elseStmts.push(this.parseConcurrent());
      }
      this.expectKw('end');
      this.acceptKw('generate'); this.accept('id'); this.expectSym(';');
      return { kind: 'ifGenerate', label, cond, stmts, elseStmts };
    }
    if (this.atKw('entity') || this.atKw('component') || (this.at('id') && !this.atSym('<=') && this.isInstantiation())) {
      let target = null;
      if (this.acceptKw('entity')) target = { kind: 'entity', name: this.parseSelectedName() };
      else if (this.acceptKw('component')) target = { kind: 'component', name: this.expect('id').value };
      else target = { kind: 'component', name: this.expect('id').value };
      let arch = null;
      if (this.acceptSym('(')) { arch = this.expect('id').value; this.expectSym(')'); }
      let genericMap = null, portMap = null;
      if (this.acceptKw('generic')) { this.expectKw('map'); this.expectSym('('); genericMap = this.parseAssociations(); this.expectSym(')'); }
      if (this.acceptKw('port')) { this.expectKw('map'); this.expectSym('('); portMap = this.parseAssociations(); this.expectSym(')'); }
      this.expectSym(';');
      return { kind: 'instance', label, target, arch, genericMap, portMap };
    }
    if (this.acceptKw('block')) {
      // block statement: treat inner concurrent stmts as flat (guards unsupported)
      while (!this.atKw('begin') && !this.at('eof')) this.next();
      this.expectKw('begin');
      const stmts = [];
      while (!this.atKw('end') && !this.at('eof')) stmts.push(this.parseConcurrent());
      this.expectKw('end'); this.acceptKw('block'); this.accept('id'); this.expectSym(';');
      return { kind: 'block', label, stmts };
    }
    // signal assignment (simple or conditional)
    const target = this.parseName();
    this.expectSym('<=');
    this.acceptKw('transport'); this.acceptKw('inertial');
    const first = this.parseExpr();
    if (this.acceptKw('when')) {
      const arms = [];
      let cond = this.parseExpr();
      this.expectKw('else');
      let value = first;
      arms.push({ value, cond });
      for (;;) {
        const v = this.parseExpr();
        if (this.acceptKw('when')) {
          const c = this.parseExpr();
          arms.push({ value: v, cond: c });
          if (this.acceptKw('else')) continue;
          this.expectSym(';');
          break;
        }
        arms.push({ value: v, cond: null });
        this.expectSym(';');
        break;
      }
      return { kind: 'condAssign', label, target, arms };
    }
    const waves = [{ value: first, after: null }];
    if (this.acceptKw('after')) waves[0].after = this.parseExpr();
    while (this.acceptSym(',')) {
      const v = this.parseExpr();
      let after = null;
      if (this.acceptKw('after')) after = this.parseExpr();
      waves.push({ value: v, after });
    }
    this.expectSym(';');
    return { kind: 'simpleAssign', label, target, waves };
  }

  isInstantiation() {
    // lookahead: id [ ( id ) ] generic|port map
    let k = 1;
    if (this.toks[this.pos + k] && this.toks[this.pos + k].kind === 'sym' && this.toks[this.pos + k].value === '(') {
      k += 3;
    }
    const t = this.toks[this.pos + k];
    return t && t.kind === 'kw' && (t.value === 'generic' || t.value === 'port');
  }

  parseAssociations() {
    const out = [];
    if (this.atSym(')')) return out;
    for (;;) {
      let formal = null;
      // formal => actual  OR positional actual
      if ((this.at('id') || this.at('kw')) && this.peek(1).kind === 'sym' && this.peek(1).value === '=>') {
        formal = this.next().value; this.next();
      }
      let actual;
      if (this.acceptKw('open')) actual = { kind: 'open' };
      else actual = this.parseExpr();
      out.push({ formal, actual });
      if (!this.acceptSym(',')) break;
    }
    return out;
  }

  parseChoices() {
    const out = [this.parseChoice()];
    while (this.acceptSym('|')) out.push(this.parseChoice());
    return out;
  }
  parseChoice() {
    if (this.acceptKw('others')) return { kind: 'others' };
    const e = this.parseExpr();
    if (this.atKw('to', 'downto')) {
      const dir = this.next().value;
      const r = this.parseExpr();
      return { kind: 'range', left: e, dir, right: r };
    }
    return { kind: 'value', value: e };
  }

  // ---------- sequential statements ----------
  parseSeqStmts(endKws) {
    const out = [];
    while (!this.at('eof') && !(this.at('kw') && endKws.includes(this.peek().value))) {
      out.push(this.parseSeqStmt());
    }
    return out;
  }

  parseSeqStmt() {
    let label = null;
    if (this.at('id') && this.peek(1).kind === 'sym' && this.peek(1).value === ':') {
      label = this.next().value; this.next();
    }
    if (this.acceptKw('if')) {
      const cond = this.parseExpr();
      this.expectKw('then');
      const then = this.parseSeqStmts(['end', 'elsif', 'else']);
      const elsifs = [];
      let els = null;
      while (this.acceptKw('elsif')) {
        const c = this.parseExpr();
        this.expectKw('then');
        elsifs.push({ cond: c, body: this.parseSeqStmts(['end', 'elsif', 'else']) });
      }
      if (this.acceptKw('else')) els = this.parseSeqStmts(['end']);
      this.expectKw('end');
      this.expectKw('if'); this.accept('id'); this.expectSym(';');
      return { kind: 'if', label, cond, then, elsifs, els };
    }
    if (this.acceptKw('case')) {
      const sel = this.parseExpr();
      this.expectKw('is');
      const arms = [];
      while (this.acceptKw('when')) {
        const choices = this.parseChoices();
        this.expectSym('=>');
        const body = this.parseSeqStmts(['when', 'end']);
        arms.push({ choices, body });
      }
      this.expectKw('end');
      this.expectKw('case'); this.accept('id'); this.expectSym(';');
      return { kind: 'case', label, sel, arms };
    }
    if (this.acceptKw('for')) {
      const id = this.expect('id').value;
      this.expectKw('in');
      const reverse = !!this.acceptKw('reverse');
      const range = this.parseRange();
      this.expectKw('loop');
      const body = this.parseSeqStmts(['end']);
      this.expectKw('end');
      this.expectKw('loop'); this.accept('id'); this.expectSym(';');
      return { kind: 'for', label, id, reverse, range, body };
    }
    if (this.acceptKw('while')) {
      const cond = this.parseExpr();
      this.expectKw('loop');
      const body = this.parseSeqStmts(['end']);
      this.expectKw('end');
      this.expectKw('loop'); this.accept('id'); this.expectSym(';');
      return { kind: 'while', label, cond, body };
    }
    if (this.acceptKw('loop')) {
      const body = this.parseSeqStmts(['end']);
      this.expectKw('end');
      this.expectKw('loop'); this.accept('id'); this.expectSym(';');
      return { kind: 'loop', label, body };
    }
    if (this.acceptKw('exit', 'next')) {
      const kind = this.toks[this.pos - 1].value;
      let lbl = null;
      if (this.at('id')) lbl = this.next().value;
      let cond = null;
      if (this.acceptKw('when')) cond = this.parseExpr();
      this.expectSym(';');
      return { kind, label: lbl, cond };
    }
    if (this.acceptKw('wait')) {
      let on = null, until = null, forT = null;
      if (this.acceptKw('on')) {
        on = [this.parseName()];
        while (this.acceptSym(',')) on.push(this.parseName());
      }
      if (this.acceptKw('until')) until = this.parseExpr();
      if (this.acceptKw('for')) forT = this.parseExpr();
      this.expectSym(';');
      return { kind: 'wait', label, on, until, forT };
    }
    if (this.acceptKw('null')) { this.expectSym(';'); return { kind: 'null', label }; }
    if (this.acceptKw('report')) {
      const msg = this.parseExpr();
      let severity = null;
      if (this.acceptKw('severity')) severity = this.parseExpr();
      this.expectSym(';');
      return { kind: 'report', label, msg, severity };
    }
    if (this.acceptKw('assert')) {
      const cond = this.parseExpr();
      let msg = null, severity = null;
      if (this.acceptKw('report')) msg = this.parseExpr();
      if (this.acceptKw('severity')) severity = this.parseExpr();
      this.expectSym(';');
      return { kind: 'assert', label, cond, msg, severity };
    }
    if (this.acceptKw('return')) {
      let value = null;
      if (!this.atSym(';')) value = this.parseExpr();
      this.expectSym(';');
      return { kind: 'return', label, value };
    }
    // assignment or procedure call
    const name = this.parseName();
    if (this.acceptSym(':=')) {
      const value = this.parseExpr();
      this.expectSym(';');
      return { kind: 'varAssign', label, target: name, value };
    }
    if (this.acceptSym('<=')) {
      this.acceptKw('transport'); this.acceptKw('inertial');
      const waves = [];
      for (;;) {
        const value = this.parseExpr();
        let after = null;
        if (this.acceptKw('after')) after = this.parseExpr();
        waves.push({ value, after });
        if (!this.acceptSym(',')) break;
      }
      this.expectSym(';');
      return { kind: 'sigAssign', label, target: name, waves };
    }
    this.expectSym(';');
    return { kind: 'procCall', label, name };
  }

  // ---------- expressions ----------
  parseExpr() { return this.parseLogical(); }
  parseLogical() {
    let left = this.parseRelational();
    while (this.atKw('and', 'or', 'nand', 'nor', 'xor', 'xnor')) {
      const op = this.next().value;
      const right = this.parseRelational();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }
  parseRelational() {
    let left = this.parseShift();
    while (this.atSym('=', '/=', '<', '<=', '>', '>=')) {
      const op = this.next().value;
      const right = this.parseShift();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }
  parseShift() {
    let left = this.parseAdding();
    while (this.atKw('sll', 'srl', 'sla', 'sra', 'rol', 'ror')) {
      const op = this.next().value;
      const right = this.parseAdding();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }
  parseAdding() {
    let left = this.parseMultiplying();
    while (this.atSym('+', '-', '&')) {
      const op = this.next().value;
      const right = this.parseMultiplying();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }
  parseMultiplying() {
    let left = this.parseUnary();
    while (this.atSym('*', '/') || this.atKw('mod', 'rem')) {
      const op = this.next().value;
      const right = this.parseUnary();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }
  parseUnary() {
    if (this.atSym('+', '-') || this.atKw('abs', 'not')) {
      const op = this.next().value;
      const operand = this.parseUnary();
      return { kind: 'unary', op, operand };
    }
    return this.parsePrimary();
  }
  parsePrimary() {
    const t = this.peek();
    if (t.kind === 'num' || t.kind === 'realnum') {
      this.next();
      let value = t.value;
      // physical literal: 10 ns, 1.5 us ...
      if (this.at('id') && TIME_UNITS[this.peek().value] !== undefined) {
        value = Math.round(value * TIME_UNITS[this.next().value]);
        return { kind: 'num', value };
      }
      return { kind: t.kind === 'num' ? 'num' : 'real', value };
    }
    if (t.kind === 'charlit') { this.next(); return { kind: 'charlit', value: t.value }; }
    if (t.kind === 'bitstr') { this.next(); return { kind: 'bitstr', value: t.value, base: t.base, raw: t.raw }; }
    if (t.kind === 'id' || (t.kind === 'kw' && ['others', 'open'].includes(t.value))) {
      if (t.kind === 'kw' && t.value === 'others') this.err("'others' only valid in aggregates");
      return this.parseName();
    }
    if (this.acceptSym('(')) {
      // aggregate or parenthesized expr
      if (this.atKw('others') || this.isAggregateStart()) {
        const elems = this.parseAggregateElems();
        this.expectSym(')');
        return { kind: 'aggregate', elems };
      }
      const e = this.parseExpr();
      this.expectSym(')');
      return e;
    }
    this.err(`unexpected token '${t.value}' in expression`);
  }

  isAggregateStart() {
    // (expr => ... | others => ... | expr , expr ...) — positional aggregates allowed
    // detect: after parsing one expr, next is '=>' or ','
    const save = this.pos;
    try {
      if (this.atKw('others')) return true;
      this.parseExpr();
      const isAgg = this.atSym('=>') || this.atSym(',');
      this.pos = save;
      return isAgg;
    } catch {
      this.pos = save;
      return false;
    }
  }

  parseAggregateElems() {
    const out = [];
    for (;;) {
      if (this.acceptKw('others')) {
        this.expectSym('=>');
        out.push({ choices: [{ kind: 'others' }], value: this.parseExpr() });
      } else {
        const first = this.parseExpr();
        if (this.acceptSym('=>')) {
          const choices = [{ kind: 'value', value: first }];
          // additional choices separated by '|' before '=>' handled below
          out.push({ choices, value: this.parseExpr() });
        } else if (this.atKw('to', 'downto')) {
          const dir = this.next().value;
          const right = this.parseExpr();
          this.expectSym('=>');
          out.push({ choices: [{ kind: 'range', left: first, dir, right }], value: this.parseExpr() });
        } else {
          out.push({ choices: null, value: first }); // positional
        }
      }
      if (!this.acceptSym(',')) break;
    }
    return out;
  }

  parseName() {
    let node;
    const t = this.peek();
    if (t.kind === 'id') { this.next(); node = { kind: 'name', name: t.value }; }
    else if (t.kind === 'kw' && ['and', 'or', 'xor', 'not', 'abs'].includes(t.value)) {
      // operator as function name prefix e.g. "and"(a,b) rare; treat as name
      this.next(); node = { kind: 'name', name: t.value };
    }
    else this.err(`expected name, got '${t.value}'`);
    for (;;) {
      if (this.acceptSym('(')) {
        const args = [];
        if (!this.atSym(')')) {
          for (;;) {
            const e = this.parseExpr();
            if (this.atKw('to', 'downto')) {
              const dir = this.next().value;
              const r = this.parseExpr();
              args.push({ kind: 'sliceArg', left: e, dir, right: r });
            } else args.push(e);
            if (!this.acceptSym(',')) break;
          }
        }
        this.expectSym(')');
        node = { kind: 'indexed', prefix: node, args };
      } else if (this.acceptSym('.')) {
        const sel = this.expect('id').value;
        node = { kind: 'selected', prefix: node, sel };
      } else if (this.at('attr')) {
        const attr = this.next().value;
        node = { kind: 'attribute', prefix: node, attr };
      } else break;
    }
    return node;
  }
}

export function parseVHDL(src, file) {
  return new Parser(lex(src, file), file).parseDesignFile();
}