import { fmtTime } from '../sim/types.js';
const COLORS = ['#69904b', '#aa874f', '#628d93', '#847aa1', '#b57165', '#819955', '#6787a0', '#9b8971'];
const DARK_COLORS = ['#b7d98c', '#ddba7c', '#8bc8ce', '#bdb0e0', '#eca292', '#c4d68b', '#98c0e1', '#d4bda0'];
const ROW = 32, HEADER = 24;
export function hexOf(bits) {
  if (!/^[01]+$/.test(bits)) return bits;
  return BigInt('0b' + bits).toString(16).toUpperCase().padStart(Math.ceil(bits.length / 4), '0');
}
export class WaveViewer {
  constructor(canvas, namesEl) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.namesEl = namesEl;
    this.signals = []; this.tStart = 0; this.tEnd = 1e9; this.cursorT = 0; this.lastTime = 0; this.maxSamples = 40000; this.drag = null;
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.setTheme();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    canvas.addEventListener('pointerdown', e => { this.drag = { x: e.clientX, start: this.tStart, end: this.tEnd }; canvas.setPointerCapture(e.pointerId); this.onNavigate?.(); });
    canvas.addEventListener('pointermove', e => {
      const rect = canvas.getBoundingClientRect(); const fraction = (e.clientX - rect.left) / rect.width;
      this.cursorT = Math.max(0, this.tStart + fraction * (this.tEnd - this.tStart));
      if (this.drag) { const span = this.drag.end - this.drag.start; const dt = (this.drag.x - e.clientX) / rect.width * span; this.tStart = Math.max(0, this.drag.start + dt); this.tEnd = this.tStart + span; }
      this.draw(); this.onCursor?.(this.cursorT);
    });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(event, () => this.drag = null);
    canvas.addEventListener('wheel', e => {
      const isHorizontalPan = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (e.ctrlKey) {
        e.preventDefault();
        this.onNavigate?.();
        const rect = canvas.getBoundingClientRect();
        const span = this.tEnd - this.tStart;
        const cursorT = this.tStart + ((e.clientX - rect.left) / rect.width) * span;
        const lineFactor = e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? rect.height : 1;
        const dy = e.deltaY * lineFactor;
        this.zoom(Math.exp(dy * 0.005), cursorT);
        return;
      }
      if (isHorizontalPan) {
        e.preventDefault();
        this.onNavigate?.();
        const rect = canvas.getBoundingClientRect();
        const span = this.tEnd - this.tStart;
        const lineFactor = e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? rect.height : 1;
        const dy = e.deltaY * lineFactor, dx = e.deltaX * lineFactor;
        const deltaPixels = e.shiftKey ? (Math.abs(dx) > 0 ? dx : dy) : dx;
        const timeDelta = (deltaPixels / rect.width) * span;
        this.tStart = Math.max(0, this.tStart + timeDelta);
        this.tEnd = this.tStart + span;
        this.draw();
        return;
      }
    }, { passive: false });
    this.resize();
  }
  resize() {
    const width = this.canvas.parentElement.clientWidth; if (!width) return;
    const height = Math.max(HEADER + this.signals.filter(s => s.visible).length * ROW, this.canvas.parentElement.parentElement.clientHeight - 2);
    this.canvas.width = Math.round(width * this.dpr); this.canvas.height = Math.round(height * this.dpr);
    this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`; this.namesEl.style.minHeight = `${height}px`;
    this.draw();
  }
  setTheme() {
    const style = getComputedStyle(document.documentElement);
    this.palette = Object.fromEntries(['bg', 'grid', 'row', 'text', 'unknown', 'cursor'].map(key => [key, style.getPropertyValue(`--wave-${key}`).trim()]));
    this.colors = document.documentElement.dataset.theme === 'dark' ? DARK_COLORS : COLORS;
    this.signals.forEach((signal, i) => signal.color = this.colors[i % this.colors.length]);
    this.renderNames(); this.draw();
  }
  setSignals(list) {
    this.signals = list.map((s, i) => ({ ...s, width: s.width || 1, visible: s.visible !== false, color: this.colors[i % this.colors.length], samples: [], last: null }));
    this.tStart = 0; this.tEnd = 1e9; this.cursorT = 0; this.lastTime = 0; this.renderNames(); this.resize();
  }
  toggle(name) { const signal = this.signals.find(s => s.name === name); if (!signal) return false; signal.visible = !signal.visible; this.renderNames(); this.resize(); return signal.visible; }
  renderNames() {
    this.namesEl.replaceChildren(); this.valueElements = new Map();
    for (const signal of this.signals.filter(s => s.visible)) {
      const row = document.createElement('div'); row.className = 'wave-name'; row.title = signal.name;
      const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = signal.color;
      const name = document.createElement('span'); name.textContent = signal.name;
      const value = document.createElement('span'); value.className = 'wn-val'; value.textContent = '—';
      row.append(dot, name, value); this.namesEl.append(row); this.valueElements.set(signal.name, value);
    }
  }
  push(time, values) {
    this.lastTime = Math.max(this.lastTime, time);
    for (const signal of this.signals) {
      const value = values.get(signal.name); if (value === undefined || value === signal.last) continue;
      if (signal.samples.at(-1)?.t === time) signal.samples[signal.samples.length - 1] = { t: time, v: value };
      else signal.samples.push({ t: time, v: value });
      signal.last = value;
      if (signal.samples.length > this.maxSamples) signal.samples.splice(0, 1000);
    }
  }
  clear() { for (const s of this.signals) { s.samples = []; s.last = null; } this.lastTime = 0; this.tStart = 0; this.tEnd = 1e9; this.draw(); }
  fit() {
    const first = Math.min(...this.signals.filter(s => s.samples.length).map(s => s.samples[0].t));
    this.tStart = Number.isFinite(first) ? first : 0; this.tEnd = Math.max(this.lastTime, this.tStart + 1e6); this.tEnd += (this.tEnd - this.tStart) * .03; this.draw();
  }
  follow(time, span) { this.tStart = Math.max(0, time - span); this.tEnd = Math.max(time + span * .04, span); this.cursorT = time; }
  zoom(factor, center = (this.tStart + this.tEnd) / 2) {
    const span = Math.max(1, Math.min(9e15, (this.tEnd - this.tStart) * factor));
    const fraction = (center - this.tStart) / (this.tEnd - this.tStart); this.tStart = Math.max(0, center - span * fraction); this.tEnd = this.tStart + span; this.draw();
  }
  sampleIndex(signal, time) {
    let lo = 0, hi = signal.samples.length - 1, answer = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (signal.samples[mid].t <= time) { answer = mid; lo = mid + 1; } else hi = mid - 1; }
    return answer;
  }
  valueAt(signal, time) { const index = this.sampleIndex(signal, time); return index < 0 ? null : signal.samples[index].v; }
  draw() {
    const g = this.ctx, width = this.canvas.width / this.dpr, height = this.canvas.height / this.dpr;
    if (!width || !height) return;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); g.clearRect(0, 0, width, height); g.fillStyle = this.palette.bg; g.fillRect(0, 0, width, height);
    const span = this.tEnd - this.tStart || 1, xOf = time => (time - this.tStart) / span * width;
    const raw = span / Math.max(3, width / 100), magnitude = 10 ** Math.floor(Math.log10(raw)), normalized = raw / magnitude;
    const grid = (normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10) * magnitude;
    g.font = '8px Consolas, monospace'; g.textBaseline = 'alphabetic'; g.lineWidth = 1;
    for (let t = Math.ceil(this.tStart / grid) * grid; t <= this.tEnd; t += grid) {
      const x = xOf(t); g.strokeStyle = this.palette.grid; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, height); g.stroke();
      g.fillStyle = this.palette.text; g.fillText(fmtTime(t).replace(/\.0+ /, ' '), x + 5, 14);
    }
    this.signals.filter(s => s.visible).forEach((signal, row) => {
      const top = HEADER + row * ROW, high = top + 6, low = top + ROW - 7, mid = (high + low) / 2;
      g.strokeStyle = this.palette.row; g.beginPath(); g.moveTo(0, top + ROW); g.lineTo(width, top + ROW); g.stroke();
      const samples = signal.samples; let previousY = null;
      const start = Math.max(0, this.sampleIndex(signal, this.tStart));
      for (let i = start; i < samples.length; i++) {
        const sample = samples[i]; if (sample.t > this.tEnd) break;
        const nextTime = samples[i + 1]?.t ?? this.lastTime;
        if (nextTime < this.tStart) continue;
        const x1 = Math.max(0, xOf(sample.t)), x2 = Math.min(width, xOf(nextTime));
        const real = ['real', 'realtime'].includes(signal.kind);
        const unknown = !real && /[^01LH]/.test(sample.v); g.strokeStyle = unknown ? this.palette.unknown : signal.color; g.fillStyle = g.strokeStyle; g.lineWidth = 1.4;
        if (signal.width === 1 && !real) {
          const y = unknown ? mid : /[1H]/.test(sample.v) ? high : low;
          g.setLineDash(unknown ? [3, 3] : []); g.beginPath();
          if (previousY !== null) { g.moveTo(x1, previousY); g.lineTo(x1, y); } else g.moveTo(x1, y);
          g.lineTo(x2, y); g.stroke(); g.setLineDash([]); previousY = y;
          if (unknown && x2 - x1 > 20) { g.font = '9px Consolas, monospace'; g.fillText(sample.v, x1 + 5, mid - 3); }
        } else if (x2 - x1 > .5) {
          g.globalAlpha = .07; g.fillRect(x1, high, x2 - x1, low - high); g.globalAlpha = 1;
          const bevel = Math.min(3, (x2 - x1) / 2);
          g.beginPath(); g.moveTo(x1, mid); g.lineTo(x1 + bevel, high); g.lineTo(x2 - bevel, high); g.lineTo(x2, mid); g.lineTo(x2 - bevel, low); g.lineTo(x1 + bevel, low); g.closePath(); g.stroke();
          if (x2 - x1 > 24) { g.save(); g.beginPath(); g.rect(x1, high, x2 - x1, low - high); g.clip(); g.font = '9px Consolas, monospace'; g.textBaseline = 'middle'; g.fillText(real ? sample.v : hexOf(sample.v), x1 + 6, mid); g.restore(); }
        }
      }
      const value = this.valueAt(signal, this.cursorT); const element = this.valueElements?.get(signal.name);
      if (element) element.textContent = value === null ? '—' : signal.width === 1 || ['real','realtime'].includes(signal.kind) ? value : hexOf(value);
    });
    const cursor = xOf(this.cursorT);
    if (cursor >= 0 && cursor <= width) { g.strokeStyle = this.palette.cursor; g.lineWidth = 1; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(cursor, HEADER); g.lineTo(cursor, height); g.stroke(); g.setLineDash([]); }
  }
}
