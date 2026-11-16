// Elaboration: build instance tree, unify port-map nets, create processes.
import { Kernel } from './kernel.js';
import { Interp, typeName } from './interp.js';
import { parseVHDL } from './parse.js';
import { int, sl, arr, arrLen, cloneVal, U } from './types.js';

let PROC_ID = 0;

export class Design {
  constructor() {
    this.kernel = new Kernel();
    this.interp = new Interp(this);
    this.entities = new Map();
    this.archs = new Map();
    this.packages = new Map();
    this.consts = new Map();
    this.types = new Map();
    this.subprograms = new Map();
    this.enumLiterals = new Map();
    this.components = new Map();
    this.arithSigned = false;
    this.errors = [];
    this.top = null;
    this.topName = null;
    this.ports = [];
    this.files = [];
    this.globalScope = {
      design: this, path: '', name: 'global',
      signals: new Map(), ports: new Map(), consts: this.consts, generics: new Map(),
      types: this.types, subprograms: this.subprograms, components: this.components,
      scopeParent: null, children: [],
    };
  }
}

function newScope(design, parent, path, name) {
  return {
    design, path, name, scopeParent: parent,
    signals: new Map(), ports: new Map(), consts: new Map(), generics: new Map(),
    types: new Map(), subprograms: new Map(), components: new Map(), children: [],
  };
}

export function elaborate(sources, topName = null) {
  const design = new Design();
  const units = [];
  for (const src of sources) {
    try {
      const df = parseVHDL(src.text, src.name);
      design.files.push(src.name);
      for (const u of df.units) units.push(u);
    } catch (e) {
      design.errors.push(`${src.name}: ${e.message}`);
    }
  }
  // register design units
  for (const u of units) {
    if (u.kind === 'entity') design.entities.set(u.name, u);
    else if (u.kind === 'architecture') {
      if (!design.archs.has(u.entity)) design.archs.set(u.entity, new Map());
      design.archs.get(u.entity).set(u.name, u);
    } else if (u.kind === 'package') design.packages.set(u.name, u);
    else if (u.kind === 'packageBody') {
      const pkg = design.packages.get(u.name);
      if (pkg) pkg.bodyDecls = u.decls;
      else design.packages.set(u.name, { kind: 'package', name: u.name, decls: [], bodyDecls: u.decls, context: u.context });
    }
  }
  const genv = { inst: design.globalScope, vars: new Map(), varTypes: new Map(), proc: null };
  // packages
  for (const pkg of design.packages.values()) {
    try {
      processUseClauses(pkg.context, design);
      processDecls(pkg.decls, design.globalScope, genv, design);
      if (pkg.bodyDecls) processDecls(pkg.bodyDecls, design.globalScope, genv, design, true);
    } catch (e) {
      design.errors.push(`package ${pkg.name}: ${e.message}`);
    }
  }
  // pick top
  const instantiated = new Set();
  for (const u of units) {
    if (u.kind !== 'architecture') continue;
    scanInstances(u.stmts, instantiated);
  }
  let topEntity = null;
  if (topName && design.entities.has(topName.toLowerCase())) topEntity = design.entities.get(topName.toLowerCase());
  if (!topEntity && topName) {
    for (const [nm, e] of design.entities) if (nm === topName.toLowerCase()) topEntity = e;
  }
  if (!topEntity) {
    const candidates = [...design.entities.values()].filter(e => !instantiated.has(e.name));
    topEntity = candidates[candidates.length - 1] || [...design.entities.values()].pop() || null;
  }
  if (!topEntity) {
    design.errors.push('no entity found to elaborate');
    return design;
  }
  design.topName = topEntity.name;
  const archMap = design.archs.get(topEntity.name);
  const arch = archMap ? [...archMap.values()][0] : null;
  if (!arch) {
    design.errors.push(`no architecture found for entity '${topEntity.name}'`);
    return design;
  }
  try {
    design.top = elaborateInstance(design, topEntity, arch, new Map(), new Map(), topEntity.name, design.globalScope, true);
  } catch (e) {
    design.errors.push(`elaboration of ${topEntity.name}: ${e.message}`);
  }
  return design;
}

function scanInstances(stmts, set) {
  for (const s of stmts || []) {
    if (s.kind === 'instance') set.add(typeName(s.target.name));
    else if (s.kind === 'forGenerate') scanInstances(s.stmts, set);
    else if (s.kind === 'ifGenerate') { scanInstances(s.stmts, set); scanInstances(s.elseStmts, set); }
    else if (s.kind === 'block') scanInstances(s.stmts, set);
  }
}

function processUseClauses(context, design) {
  for (const c of context || []) {
    if (c.kind === 'use') {
      const s = c.sel.toLowerCase();
      if (s.includes('std_logic_signed') || s.includes('std_logic_arith')) design.arithSigned = true;
    }
  }
}

function processDecls(decls, scope, env, design, isBody = false) {
  const I = design.interp;
  for (const d of decls || []) {
    switch (d.kind) {
      case 'use': {
        const s = d.sel.toLowerCase();
        if (s.includes('std_logic_signed') || s.includes('std_logic_arith')) design.arithSigned = true;
        break;
      }
      case 'constantDecl': {
        const ty = I.resolveType(d.type, d.constraint, env);
        for (const nm of d.names) {
          const v = d.init ? I.coerce(I.evalExpr(d.init, env, ty), ty) : I.defaultForType(ty);
          scope.consts.set(nm, v);
        }
        break;
      }
      case 'subtypeDecl': {
        const ty = I.resolveType(d.type, d.constraint, env);
        scope.types.set(d.name, ty);
        break;
      }
      case 'enumType': {
        const et = { name: d.name, literals: d.literals.map(l => String(l).toLowerCase()) };
        scope.types.set(d.name, { base: 'enum', enumType: et, range: null });
        et.literals.forEach((lit, idx) => {
          if (!design.enumLiterals.has(lit)) design.enumLiterals.set(lit, { type: et, idx });
        });
        break;
      }
      case 'arrayType': {
        let range = null;
        if (d.index && d.index.kind === 'range') range = I.evalRange(d.index, env);
        const elem = typeName(d.elem);
        const base = elem === 'std_logic' || elem === 'std_ulogic' || elem === 'bit' ? 'slv' : elem === 'integer' ? 'int' : 'slv';
        scope.types.set(d.name, { base, range, elemBase: elem });
        break;
      }
      case 'rangeType': {
        const range = I.evalRange(d.range, env);
        scope.types.set(d.name, { base: 'int', range });
        break;
      }
      case 'componentDecl': {
        scope.components.set(d.name, d);
        design.components.set(d.name, d);
        break;
      }
      case 'subprogramSpec': case 'subprogramBody': {
        const key = d.name.toLowerCase();
        if (!scope.subprograms.has(key)) scope.subprograms.set(key, []);
        const list = scope.subprograms.get(key);
        if (d.kind === 'subprogramBody') {
          const idx = list.findIndex(x => x.kind === 'subprogramSpec' && x.params.length === d.params.length);
          if (idx >= 0) list[idx] = d; else list.push(d);
        } else {
          list.push(d);
        }
        if (scope !== design.globalScope) {
          if (!design.subprograms.has(key)) design.subprograms.set(key, []);
          design.subprograms.get(key).push(d);
        }
        break;
      }
      case 'signalDecl': {
        // package-level signals (rare): create in global scope
        const ty = I.resolveType(d.type, d.constraint, env);
        for (const nm of d.names) {
          const init = d.init ? I.coerce(I.evalExpr(d.init, env, ty), ty) : null;
          const sig = design.kernel.addSignal(`pkg.${nm}`, ty.base, ty.range, init, ty.enumType);
          scope.signals.set(nm, sig);
        }
        break;
      }
      default: break;
    }
  }
}

function elaborateInstance(design, entity, arch, genericOverrides, portBindings, path, parentScope, isTop = false) {
  const I = design.interp;
  const inst = newScope(design, parentScope, path, entity.name);
  inst.entity = entity;
  inst.arch = arch;
  const env = { inst, vars: new Map(), varTypes: new Map(), proc: null };
  processUseClauses(entity.context, design);
  processUseClauses(arch.context, design);
  // generics
  for (const g of entity.generics || []) {
    let v;
    if (genericOverrides.has(g.name)) v = genericOverrides.get(g.name);
    else if (g.init) v = I.evalExpr(g.init, env);
    else v = int(0);
    inst.generics.set(g.name, v);
  }
  // ports
  for (const p of entity.ports || []) {
    const ty = I.resolveType(p.type, p.constraint, env);
    let sig = portBindings.get(p.name);
    if (!sig) {
      const init = p.init ? I.coerce(I.evalExpr(p.init, env, ty), ty) : null;
      const sigName = isTop ? p.name : `${path}.${p.name}`;
      sig = design.kernel.addSignal(sigName, ty.base, ty.range, init, ty.enumType);
      if (isTop) design.ports.push({ name: p.name, mode: p.mode, type: ty, sig });
    }
    inst.ports.set(p.name, { sig, mode: p.mode, type: ty });
  }
  // architecture declarations
  processDecls(arch.decls, inst, env, design);
  for (const d of arch.decls || []) {
    if (d.kind === 'signalDecl') {
      const ty = I.resolveType(d.type, d.constraint, env);
      for (const nm of d.names) {
        const init = d.init ? I.coerce(I.evalExpr(d.init, env, ty), ty) : null;
        const sig = design.kernel.addSignal(`${path}.${nm}`, ty.base, ty.range, init, ty.enumType);
        inst.signals.set(nm, sig);
      }
    }
  }
  // concurrent statements
  for (const s of arch.stmts || []) {
    elaborateConcurrent(design, s, inst, env, path);
  }
  return inst;
}

function makeProcess(design, inst, env, label, sensSet, makeGen, path) {
  const proc = {
    id: PROC_ID++,
    name: `${path}${label ? ':' + label : ''}`,
    inst, env, sens: sensSet, makeGen,
    state: 'idle', gen: null, dead: false, waitCond: null,
  };
  env.proc = proc;
  design.kernel.addProcess(proc);
  return proc;
}

function elaborateConcurrent(design, s, inst, env, path) {
  const I = design.interp;
  switch (s.kind) {
    case 'process': {
      const penv = { inst, vars: new Map(), varTypes: new Map(), proc: null };
      I.initDecls(s.decls, penv);
      let sensSet = new Set();
      if (s.sens) {
        for (const nm of s.sens) {
          const sig = I.resolveSignal(nm, penv);
          if (sig) sensSet.add(sig);
        }
      }
      const body = s.body;
      makeProcess(design, inst, penv, s.label, sensSet, () => I.execSeq(body, penv), path);
      break;
    }
    case 'simpleAssign': case 'condAssign': case 'selectedAssign': {
      const penv = { inst, vars: new Map(), varTypes: new Map(), proc: null };
      const sensSet = new Set();
      const target = s.target;
      const collect = (n) => I.collectSens(n, penv, sensSet);
      if (s.kind === 'simpleAssign') for (const w of s.waves) { collect(w.value); if (w.after) collect(w.after); }
      else if (s.kind === 'condAssign') for (const a of s.arms) { collect(a.value); if (a.cond) collect(a.cond); }
      else { collect(s.sel); for (const w of s.waves) collect(w.value); }
      const stmt = s;
      const gen = function* () {
        const ty = I.targetHint(target, penv);
        if (stmt.kind === 'simpleAssign') {
          for (const w of stmt.waves) {
            const v = I.evalExpr(w.value, penv, ty);
            const after = w.after ? Number(I.evalExpr(w.after, penv).v) : 0;
            I.assignSignal(target, v, penv, penv.proc, after, false);
          }
        } else if (stmt.kind === 'condAssign') {
          for (const a of stmt.arms) {
            if (a.cond === null || I.evalExpr(a.cond, penv).v) {
              I.assignSignal(target, I.evalExpr(a.value, penv, ty), penv, penv.proc);
              break;
            }
          }
        } else {
          const sel = I.evalExpr(stmt.sel, penv);
          for (const w of stmt.waves) {
            if (I.matchChoices(sel, w.choices, penv)) {
              I.assignSignal(target, I.evalExpr(w.value, penv, ty), penv, penv.proc);
              break;
            }
          }
        }
      };
      makeProcess(design, inst, penv, s.label, sensSet, gen, path);
      break;
    }
    case 'instance': {
      const tname = typeName(s.target.name);
      let entity = design.entities.get(tname);
      let compDecl = inst.components.get(tname) || design.components.get(tname);
      if (!entity && compDecl) entity = design.entities.get(compDecl.name);
      if (!entity) {
        // component name may differ from entity: search by port signature match fallback
        design.errors.push(`instance '${s.label}': entity/component '${tname}' not found`);
        break;
      }
      const archMap = design.archs.get(entity.name);
      const arch = s.arch && archMap && archMap.get(s.arch) ? archMap.get(s.arch) : (archMap ? [...archMap.values()][0] : null);
      if (!arch) { design.errors.push(`instance '${s.label}': no architecture for '${entity.name}'`); break; }
      const genv = { inst, vars: new Map(), varTypes: new Map(), proc: null };
      const overrides = new Map();
      const gmap = s.genericMap || [];
      const glist = entity.generics || [];
      gmap.forEach((a, i) => {
        const formal = a.formal || (glist[i] && glist[i].name);
        if (formal && a.actual.kind !== 'open') overrides.set(formal, I.evalExpr(a.actual, genv));
      });
      const bindings = new Map();
      const pmap = s.portMap || [];
      const plist = entity.ports || [];
      pmap.forEach((a, i) => {
        const formal = a.formal || (plist[i] && plist[i].name);
        if (!formal) return;
        if (a.actual.kind === 'open') { bindings.set(formal, null); return; }
        const sig = I.resolveSignal(a.actual, genv);
        if (sig) { bindings.set(formal, sig); return; }
        // expression actual on input port: implicit net + driver
        const pport = plist.find(p => p.name === formal);
        if (pport && pport.mode === 'in') {
          const ty = I.resolveType(pport.type, pport.constraint, genv);
          const netName = `${path}.pm_${formal}_${i}`;
          const net = design.kernel.addSignal(netName, ty.base, ty.range, null, ty.enumType);
          inst.signals.set(netName.split('.').pop(), net);
          bindings.set(formal, net);
          const nenv = { inst, vars: new Map(), varTypes: new Map(), proc: null };
          const sensSet = I.collectSens(a.actual, nenv, new Set());
          const actual = a.actual;
          const nty = ty;
          makeProcess(design, inst, nenv, `pm_${formal}`, sensSet, function* () {
            I.assignSignal({ kind: 'name', name: netName.split('.').pop() }, I.evalExpr(actual, nenv, nty), nenv, nenv.proc);
          }, path);
        } else {
          design.errors.push(`instance '${s.label}': port '${formal}' actual must be a signal`);
        }
      });
      const childPath = `${path}/${s.label || entity.name}`;
      const child = elaborateInstance(design, entity, arch, overrides, bindings, childPath, inst, false);
      inst.children.push(child);
      break;
    }
    case 'forGenerate': {
      const r = I.evalRange(s.range, env);
      const lo = Math.min(r.left, r.right), hi = Math.max(r.left, r.right);
      const asc = r.dir === 'to';
      const seq = [];
      if (asc) for (let i = lo; i <= hi; i++) seq.push(i);
      else for (let i = hi; i >= lo; i--) seq.push(i);
      for (const i of seq) {
        const gpath = `${path}/${s.label || 'gen'}(${i})`;
        const gscope = newScope(design, inst, gpath, `${s.label || 'gen'}_${i}`);
        gscope.consts.set(s.id, int(i));
        const genv = { inst: gscope, vars: new Map(), varTypes: new Map(), proc: null };
        processDecls(s.decls, gscope, genv, design);
        for (const d of s.decls || []) {
          if (d.kind === 'signalDecl') {
            const ty = I.resolveType(d.type, d.constraint, genv);
            for (const nm of d.names) {
              const init = d.init ? I.coerce(I.evalExpr(d.init, genv, ty), ty) : null;
              const sig = design.kernel.addSignal(`${gpath}.${nm}`, ty.base, ty.range, init, ty.enumType);
              gscope.signals.set(nm, sig);
            }
          }
        }
        for (const st of s.stmts || []) elaborateConcurrent(design, st, gscope, genv, gpath);
        inst.children.push(gscope);
      }
      break;
    }
    case 'ifGenerate': {
      const cond = I.evalExpr(s.cond, env).v;
      const branch = cond ? s.stmts : s.elseStmts;
      if (branch) {
        const gpath = `${path}/${s.label || 'gif'}`;
        const gscope = newScope(design, inst, gpath, s.label || 'gif');
        const genv = { inst: gscope, vars: new Map(), varTypes: new Map(), proc: null };
        for (const st of branch) elaborateConcurrent(design, st, gscope, genv, gpath);
        inst.children.push(gscope);
      }
      break;
    }
    case 'block': {
      for (const st of s.stmts || []) elaborateConcurrent(design, st, inst, env, `${path}/${s.label || 'blk'}`);
      break;
    }
    default:
      design.errors.push(`unsupported concurrent statement '${s.kind}'`);
  }
}