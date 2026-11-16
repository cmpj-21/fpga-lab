// Discrete-event simulation kernel with VHDL delta-cycle semantics.
import { resolve, resolveVec, cloneVal, arrLen, arrIndex, arrSetIndex, sl, L0, L1, Z, X, U, valToString } from './types.js';

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].t <= a[i].t) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    if (!a.length) return null;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].t < a[m].t) m = l;
        if (r < a.length && a[r].t < a[m].t) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  peek() { return this.a[0] || null; }
}

let SIG_ID = 0;

export class Signal {
  constructor(name, type, range, init) {
    this.id = SIG_ID++;
    this.name = name;
    this.type = type;           // 'sl' | 'slv' | 'unsigned' | 'signed' | 'int' | 'bool' | 'enum' | ...
    this.range = range;         // {left,right,dir} for arrays
    this.isArr = !!range;
    this.sensitive = new Set(); // processes
    this.drivers = new Map();   // key -> {key, procId, left, right, cur, wave:[]}
    this.lastEvent = -1;
    this.lastValue = null;
    this.value = null;
    this.envDriver = null;
    this.trace = true;
    this._init = init;
    this.reset(init);
  }
  reset(init) {
    this.drivers.clear();
    this.lastEvent = -1;
    this.eventPending = false;
    this.eventCurrent = false;
    const v = init !== undefined && init !== null ? cloneVal(init) : this.defaultValue();
    this.initVal = init !== undefined && init !== null ? cloneVal(init) : null;
    this.value = v;
    this.lastValue = cloneVal(v);
  }
  defaultValue() {
    if (this.isArr) {
      const n = arrLen({ left: this.range.left, right: this.range.right });
      const elems = new Array(n).fill(this.type === 'int' ? 0 : U);
      return { t: this.type, v: elems, left: this.range.left, right: this.range.right, dir: this.range.dir };
    }
    switch (this.type) {
      case 'sl': return sl(U);
      case 'int': return { t: 'int', v: 0 };
      case 'bool': return { t: 'bool', v: false };
      case 'real': return { t: 'real', v: 0 };
      case 'time': return { t: 'time', v: 0 };
      case 'char': return { t: 'char', v: ' ' };
      case 'string': return { t: 'string', v: '' };
      case 'enum': return { t: 'enum', type: this.enumType, v: 0 };
      default: return sl(U);
    }
  }
  getDriver(key, procId, left, right) {
    let d = this.drivers.get(key);
    if (!d) {
      d = { key, procId, left, right, cur: null, wave: [] };
      this.drivers.set(key, d);
    }
    return d;
  }
  covers(d, idx) {
    if (!this.isArr) return true;
    const lo = Math.min(d.left, d.right), hi = Math.max(d.left, d.right);
    return idx >= lo && idx <= hi;
  }
  recompute() {
    if (!this.isArr) {
      if (this.type !== 'sl') {
        let last = null;
        for (const d of this.drivers.values()) if (d.cur !== null) last = d.cur;
        if (last) return cloneVal(last);
        if (this.initVal) return cloneVal(this.initVal);
        return this.defaultValue();
      }
      const vals = [];
      for (const d of this.drivers.values()) if (d.cur !== null) vals.push(d.cur.v);
      if (vals.length) return sl(resolveVec(vals));
      if (this.initVal) return cloneVal(this.initVal);
      return sl(U);
    }
    const n = this.value.v.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const idx = this.range.dir === 'downto' ? this.range.left - i : this.range.left + i;
      const vals = [];
      for (const d of this.drivers.values()) {
        if (d.cur === null || !this.covers(d, idx)) continue;
        const off = d.left >= d.right ? d.left - idx : idx - d.left;
        const e = d.cur.v[off];
        if (e !== undefined) vals.push(e);
      }
      if (vals.length) out[i] = resolveVec(vals);
      else if (this.initVal && Array.isArray(this.initVal.v)) {
        const io = this.initVal.dir === 'downto' ? this.initVal.left - idx : idx - this.initVal.left;
        out[i] = this.initVal.v[io] !== undefined ? this.initVal.v[io] : U;
      } else out[i] = U;
    }
    return { t: this.type, v: out, left: this.range.left, right: this.range.right, dir: this.range.dir };
  }
}

export class Kernel {
  constructor() {
    this.time = 0;
    this.heap = new MinHeap();
    this.signals = new Map();
    this.processes = [];
    this.ready = [];
    this.deltaCount = 0;
    this.txnCount = 0;
    this.cycleCount = 0;
    this.errors = [];
    this.log = [];
    this.stopped = false;
    this.stopReason = null;
    this.maxTime = Infinity;
    this.onLog = null;
    this.changedThisStep = new Set();
    this._seq = 0;
  }

  addSignal(name, type, range, init, enumType) {
    const s = new Signal(name, type, range, init);
    if (enumType) s.enumType = enumType;
    this.signals.set(name, s);
    return s;
  }

  logMsg(sev, msg) {
    const entry = { t: this.time, sev, msg };
    this.log.push(entry);
    if (this.log.length > 2000) this.log.shift();
    if (this.onLog) this.onLog(entry);
    if (sev === 'failure') { this.stopped = true; this.stopReason = `ASSERTION FAILURE: ${msg}`; }
  }

  // Schedule a transaction on a driver (LRM 8.4 inertial semantics).
  schedule(sig, driver, value, atTime, transport = false) {
    const t = atTime;
    const wave = driver.wave;
    if (!transport) {
      // inertial: delete all transactions at or after t
      let k = wave.length;
      while (k > 0 && wave[k - 1].t >= t) k--;
      wave.length = k;
    } else {
      // transport: delete transactions at or after t only if same value ordering requires;
      // LRM transport: delete all transactions with time >= t
      let k = wave.length;
      while (k > 0 && wave[k - 1].t >= t) k--;
      wave.length = k;
    }
    const last = wave[wave.length - 1];
    const sameAsLast = last && valsEq(last.v, value);
    const sameAsCur = driver.cur !== null && valsEq(driver.cur, value);
    if (wave.length === 0) {
      if (!sameAsCur) wave.push({ t, v: cloneVal(value) });
    } else if (!sameAsLast) {
      wave.push({ t, v: cloneVal(value) });
    }
    if (wave.length) {
      this.heap.push({ t: wave[0].t, kind: 'txn', sig, driver, seq: this._seq++ });
    }
  }

  wake(proc) {
    if (proc.state === 'ready' || proc.state === 'done' || proc.dead) return;
    proc.state = 'ready';
    this.ready.push(proc);
  }

  addProcess(proc) {
    this.processes.push(proc);
    if (proc.sens) for (const s of proc.sens) s.sensitive.add(proc);
    proc.state = 'ready';
    this.ready.push(proc);
    return proc;
  }

  // Execute one delta: run ready processes, then apply transactions at current time.
  delta() {
    // promote pending events to current so 'EVENT is true exactly in the delta
    // where sensitive processes resume (LRM 12.6.4)
    for (const sig of this.signals.values()) {
      sig.eventCurrent = sig.eventPending;
      sig.eventPending = false;
    }
    const procs = this.ready;
    this.ready = [];
    for (const p of procs) {
      if (p.dead) continue;
      p.state = 'running';
      this.runProcess(p);
    }
    // apply all transactions at this.time
    const affected = new Map();
    while (this.heap.size && this.heap.peek().t <= this.time) {
      const ev = this.heap.pop();
      if (ev.kind === 'wake') {
        this.wake(ev.proc);
        continue;
      }
      const { sig, driver } = ev;
      const wave = driver.wave;
      // pop head transaction(s) at this time
      while (wave.length && wave[0].t <= this.time) {
        const tr = wave.shift();
        driver.cur = tr.v;
      }
      if (wave.length) this.heap.push({ t: wave[0].t, kind: 'txn', sig, driver, seq: this._seq++ });
      affected.set(sig, true);
      this.txnCount++;
    }
    // resolve affected signals, detect events
    for (const sig of affected.keys()) {
      const old = sig.value;
      const next = sig.recompute();
      if (!valsEq(old, next)) {
        sig.lastValue = old;
        sig.value = next;
        sig.lastEvent = this.time;
        sig.eventPending = true;
        this.changedThisStep.add(sig.name);
        for (const p of sig.sensitive) this.wake(p);
      } else {
        sig.value = next;
      }
    }
    this.deltaCount++;
    return this.ready.length > 0;
  }

  runProcess(p) {
    try {
      if (!p.gen) p.gen = p.makeGen();
      const res = p.gen.next();
      if (res.done) {
        if (p.sens && p.sens.size) {
          // sensitivity-list process: restart on next event
          p.gen = null;
          p.state = 'idle';
        } else {
          p.state = 'done';
        }
        return;
      }
      const w = res.value;
      if (w.wait === 'for') {
        p.state = 'waiting';
        this.heap.push({ t: this.time + Math.max(0, w.t), kind: 'wake', proc: p, seq: this._seq++ });
      } else if (w.wait === 'on' || w.wait === 'until' || w.wait === 'plain') {
        p.state = 'waiting';
        p.waitCond = w;
        const sigs = w.sigs || (p.sens ? [...p.sens] : []);
        for (const s of sigs) s.sensitive.add(p);
        if (w.wait === 'until') {
          if (w.deadline !== undefined && isFinite(w.deadline)) {
            this.heap.push({ t: w.deadline, kind: 'wake', proc: p, seq: this._seq++ });
          }
          if (w.test && w.test()) this.wake(p);
        }
      } else {
        p.state = 'idle';
      }
    } catch (e) {
      p.dead = true;
      p.state = 'done';
      this.errors.push(String(e && e.stack || e));
      this.logMsg('error', `process ${p.name}: ${e && e.message || e}`);
      this.stopped = true;
      this.stopReason = String(e && e.message || e);
    }
  }

  // Advance simulation. budget = max signal-event time steps (not deltas).
  run(budgetSteps = 100000, maxDeltasPerStep = 20000) {
    this.changedThisStep.clear();
    let steps = 0;
    while (!this.stopped && steps < budgetSteps && this.time < this.maxTime) {
      // settle deltas at current time
      let d = 0;
      while (this.ready.length && d < maxDeltasPerStep && !this.stopped) {
        this.delta();
        d++;
      }
      if (this.stopped) break;
      if (d >= maxDeltasPerStep) {
        this.stopped = true;
        this.stopReason = 'delta-cycle limit reached (combinational loop?)';
        this.logMsg('error', this.stopReason);
        break;
      }
      if (this.ready.length) continue;
      // advance to next event
      const next = this.heap.peek();
      if (!next) {
        if (!this.processes.some(p => p.state === 'waiting' && p.waitCond && p.waitCond.wait === 'until')) {
          this.stopped = true;
          this.stopReason = 'no future events (simulation idle)';
        }
        break;
      }
      this.time = next.t;
      steps++;
      this.cycleCount++;
      // apply transactions / wakes at the new time inside delta()
      this.delta();
    }
    return { steps, time: this.time, stopped: this.stopped, reason: this.stopReason };
  }

  // Run until no deltas pending at current time (settle), used after env input changes.
  settle(maxDeltas = 20000) {
    let d = 0;
    while ((this.ready.length || (this.heap.size && this.heap.peek().t <= this.time)) && d < maxDeltas && !this.stopped) {
      this.delta();
      d++;
    }
    return d;
  }

  setEnvValue(sig, value) {
    if (!sig.isArr) {
      const d = sig.getDriver(`env:${sig.name}`, -1, 0, 0);
      this.schedule(sig, d, value, this.time, true);
    } else {
      const n = value.v.length;
      for (let i = 0; i < n; i++) {
        const idx = sig.range.dir === 'downto' ? sig.range.left - i : sig.range.left + i;
        const d = sig.getDriver(`env:${sig.name}:${idx}`, -1, idx, idx);
        this.schedule(sig, d, { t: sig.type, v: [value.v[i]], left: idx, right: idx, dir: 'downto' }, this.time, true);
      }
    }
    this.settle();
  }
}

export function valsEq(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.t !== b.t) return false;
  if (Array.isArray(a.v)) {
    if (a.v.length !== b.v.length) return false;
    for (let i = 0; i < a.v.length; i++) if (a.v[i] !== b.v[i]) return false;
    return true;
  }
  return a.v === b.v;
}