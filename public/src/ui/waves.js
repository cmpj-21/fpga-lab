import { fmtTime } from '../sim/types.js';
const COLORS = ['#69904b', '#aa874f', '#628d93', '#847aa1', '#b57165', '#819955', '#6787a0', '#9b8971'];
const DARK_COLORS = ['#b7d98c', '#ddba7c', '#8bc8ce', '#bdb0e0', '#eca292', '#c4d68b', '#98c0e1', '#d4bda0'];
const ROW = 32, HEADER = 24, LOD_BLOCK = 64;
export function hexOf(bits) {
  if (!/^[01]+$/.test(bits)) return bits;
  return BigInt('0b' + bits).toString(16).toUpperCase().padStart(Math.ceil(bits.length / 4), '0');
}
function summarizeBitMask(signal, block) {
  const { width, kind } = signal;
  const real = ['real', 'realtime'].includes(kind);
  if (real) return { real: true, s0: 0, s1: 0, su: 0, bits: null, first: block[0]?.v, last: block[block.length - 1]?.v, uniform: block.every(s => s.v === block[0]?.v) };
  if (width <= 30) {
    let s0 = 0, s1 = 0, su = 0, uniform = true;
    const first = block[0]?.v;
    for (let i = 0; i < block.length; i++) {
      const v = block[i].v;
      if (v !== first) uniform = false;
      for (let b = 0; b < width; b++) {
        const ch = v[b];
        const m = 1 << b;
        if (ch === '0' || ch === 'L') s0 |= m;
        else if (ch === '1' || ch === 'H') s1 |= m;
        else su |= m;
      }
    }
    return { real: false, s0, s1, su, bits: null, first, last: block[block.length - 1]?.v, uniform };
  }
  const bits = new Uint8Array(width);
  let uniform = true;
  const first = block[0]?.v;
  for (let i = 0; i < block.length; i++) {
    const v = block[i].v;
    if (v !== first) uniform = false;
    for (let b = 0; b < width; b++) {
      const ch = v[b];
      bits[b] |= (ch === '0' || ch === 'L') ? 1 : (ch === '1' || ch === 'H') ? 2 : 4;
    }
  }
  return { real: false, s0: 0, s1: 0, su: 0, bits, first, last: block[block.length - 1]?.v, uniform };
}
function compactSignalSamples(signal, targetMax) {
  const s = signal.samples;
  if (s.length <= targetMax) return;
  const keepRecent = Math.max(256, Math.floor(targetMax * 0.55));
  const recentStart = Math.max(1, s.length - keepRecent);
  const maxOlder = Math.max(64, Math.floor(targetMax * 0.35));
  const step = Math.max(2, Math.ceil(recentStart / maxOlder));
  const out = [s[0]];
  for (let i = step; i < recentStart; i += step) out.push(s[i]);
  for (let i = recentStart; i < s.length; i++) out.push(s[i]);
  signal.samples = out;
  signal._lod = null;
}
function ensureSignalLod(signal) {
  const samples = signal.samples;
  const n = samples.length;
  let lod = signal._lod;
  if (!lod || lod.firstRef !== samples[0] || lod.builtLen > n) {
    lod = { firstRef: samples[0], builtLen: 0, blocks: [] };
    signal._lod = lod;
  }
  const fullBlocks = Math.floor(n / LOD_BLOCK);
  const startBlock = Math.floor(lod.builtLen / LOD_BLOCK);
  for (let b = startBlock; b < fullBlocks; b++) {
    const off = b * LOD_BLOCK;
    lod.blocks[b] = summarizeBitMask(signal, samples.slice(off, off + LOD_BLOCK));
  }
  lod.builtLen = fullBlocks * LOD_BLOCK;
  return lod;
}
function sampleIndexGe(samples, time, loHint = 0) {
  let lo = Math.max(0, loHint), hi = samples.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= time) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
export class WaveViewer {
  constructor(canvas, namesEl, scrollTrackEl = null, scrollThumbEl = null) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.namesEl = namesEl;
    this.scrollTrack = scrollTrackEl; this.scrollThumb = scrollThumbEl; this.scrollDrag = null;
    this.signals = []; this.tStart = 0; this.tEnd = 1e9; this.cursorT = 0; this.lastTime = 0; this.maxSamples = 40000; this.drag = null; this.timeUnit = 'auto';
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.dataVersion = 1; this.themeVersion = 1; this.cacheKey = '';
    this.cacheCanvas = document.createElement('canvas');
    this.cacheCtx = this.cacheCanvas.getContext('2d');
    this.scrollHost = canvas.parentElement?.parentElement || null;
    this.scrollHost?.addEventListener('scroll', () => this.draw(), { passive: true });
    this.setTheme();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    canvas.addEventListener('pointerdown', e => {
      canvas.setPointerCapture(e.pointerId);
      const allowed = this.canPan ? this.canPan() : true;
      if (!allowed) { this.drag = null; this.onLockedAction?.('pan'); return; }
      this.drag = { x: e.clientX, start: this.tStart, end: this.tEnd };
      this.onNavigate?.();
    });
    canvas.addEventListener('pointermove', e => {
      const rect = canvas.getBoundingClientRect(); const fraction = (e.clientX - rect.left) / rect.width;
      this.cursorT = Math.max(0, this.tStart + fraction * (this.tEnd - this.tStart));
      if (this.drag) {
        const span = this.drag.end - this.drag.start;
        const dt = (this.drag.x - e.clientX) / rect.width * span;
        const maxStart = Math.max(0, Math.max(this.lastTime, 1e6) - span * 0.25);
        this.tStart = Math.max(0, Math.min(maxStart, this.drag.start + dt));
        this.tEnd = this.tStart + span;
      }
      this.draw(); this.onCursor?.(this.cursorT);
    });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(event, () => this.drag = null);
    if (this.scrollTrack && this.scrollThumb) {
      const track = this.scrollTrack, thumb = this.scrollThumb;
      track.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        if (this.canPan && !this.canPan()) { this.onLockedAction?.('pan'); return; }
        this.onNavigate?.();
        const rect = track.getBoundingClientRect();
        const { total, span, scrollable, maxLeft } = this.scrollMetrics();
        if (e.target !== thumb && scrollable > 0) {
          const clickFrac = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
          const newStart = Math.max(0, Math.min(scrollable, clickFrac * total - span / 2));
          this.tStart = newStart;
          this.tEnd = newStart + span;
          this.draw();
        }
        const m = this.scrollMetrics();
        this.scrollDrag = { x: e.clientX, startT: this.tStart, span: m.span, scrollable: m.scrollable, maxLeft: m.maxLeft };
        thumb.classList.add('dragging');
        track.setPointerCapture(e.pointerId);
      });
      track.addEventListener('pointermove', e => {
        if (!this.scrollDrag) return;
        const { x, startT, span, scrollable, maxLeft } = this.scrollDrag;
        if (scrollable <= 0 || maxLeft <= 0) return;
        const dx = e.clientX - x;
        const nextStart = Math.max(0, Math.min(scrollable, startT + (dx / maxLeft) * scrollable));
        this.tStart = nextStart;
        this.tEnd = nextStart + span;
        this.draw();
      });
      for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        track.addEventListener(ev, () => { this.scrollDrag = null; thumb.classList.remove('dragging'); });
      }
      track.addEventListener('keydown', e => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        if (this.canPan && !this.canPan()) { this.onLockedAction?.('pan'); return; }
        const { span, scrollable } = this.scrollMetrics();
        if (e.key === 'ArrowLeft') { this.onNavigate?.(); this.tStart = Math.max(0, this.tStart - span * 0.2); this.tEnd = this.tStart + span; this.draw(); }
        else if (e.key === 'ArrowRight') { this.onNavigate?.(); this.tStart = Math.min(scrollable, this.tStart + span * 0.2); this.tEnd = this.tStart + span; this.draw(); }
        else if (e.key === 'Home') { this.onNavigate?.(); this.tStart = 0; this.tEnd = span; this.draw(); }
        else if (e.key === 'End') { this.onNavigate?.(); this.tStart = Math.max(0, this.lastTime - span); this.tEnd = this.tStart + span; this.draw(); }
      });
    }
    canvas.addEventListener('wheel', e => {
      const isHorizontalPan = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (e.ctrlKey) {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const span = this.tEnd - this.tStart;
        const cursorT = this.tStart + ((e.clientX - rect.left) / rect.width) * span;
        const lineFactor = e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? rect.height : 1;
        const factor = Math.exp((e.deltaY * lineFactor) * 0.005);
        if (this.onCustomZoom) { this.onCustomZoom(factor, cursorT); return; }
        if (this.canZoom && !this.canZoom()) { this.onLockedAction?.('zoom'); return; }
        this.onNavigate?.();
        this.zoom(factor, cursorT);
        return;
      }
      if (isHorizontalPan) {
        e.preventDefault();
        if (this.canPan && !this.canPan()) { this.onLockedAction?.('pan'); return; }
        this.onNavigate?.();
        const rect = canvas.getBoundingClientRect();
        const span = this.tEnd - this.tStart;
        const lineFactor = e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? rect.height : 1;
        const dy = e.deltaY * lineFactor, dx = e.deltaX * lineFactor;
        const deltaPixels = e.shiftKey ? (Math.abs(dx) > 0 ? dx : dy) : dx;
        const timeDelta = (deltaPixels / rect.width) * span;
        const maxStart = Math.max(0, Math.max(this.lastTime, 1e6) - span * 0.25);
        this.tStart = Math.max(0, Math.min(maxStart, this.tStart + timeDelta));
        this.tEnd = this.tStart + span;
        this.draw();
        return;
      }
    }, { passive: false });
    this.resize();
  }
  displayRows() {
    const rows = [];
    for (const signal of this.signals) {
      if (!signal.visible) continue;
      rows.push({ key: signal.name, signal, bitOffset: null, bitLabel: null });
      const real = ['real', 'realtime'].includes(signal.kind);
      if (signal.width > 1 && !real && signal.expanded) {
        const left = Number.isInteger(signal.left) ? signal.left : signal.width - 1;
        const right = Number.isInteger(signal.right) ? signal.right : 0;
        const step = left <= right ? 1 : -1;
        for (let offset = 0; offset < signal.width; offset++) {
          const bitIdx = left + offset * step;
          const label = `${signal.name}[${bitIdx}]`;
          rows.push({ key: label, signal, bitOffset: offset, bitLabel: label });
        }
      }
    }
    return rows;
  }
  resize() {
    const width = this.canvas.parentElement.clientWidth; if (!width) return;
    const height = Math.max(HEADER + this.displayRows().length * ROW, this.canvas.parentElement.parentElement.clientHeight - 2);
    this.canvas.width = Math.round(width * this.dpr); this.canvas.height = Math.round(height * this.dpr);
    this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`; this.namesEl.style.minHeight = `${height}px`;
    this.draw();
  }
  setTheme() {
    const style = getComputedStyle(document.documentElement);
    this.palette = Object.fromEntries(['bg', 'grid', 'row', 'text', 'unknown', 'cursor'].map(key => [key, style.getPropertyValue(`--wave-${key}`).trim()]));
    this.palette.header = style.getPropertyValue('--wave-header').trim() || this.palette.bg;
    this.palette.line = style.getPropertyValue('--wave-line').trim() || style.getPropertyValue('--line').trim() || this.palette.grid;
    const isDarkCanvas = document.documentElement.dataset.scheme === 'dark' || /^#0[0-5]|^#1[0-9]|^#2[0-9]/i.test(this.palette.bg);
    const fallbackColors = isDarkCanvas ? DARK_COLORS : COLORS;
    this.colors = Array.from({ length: 8 }, (_, i) => style.getPropertyValue(`--wave-c${i}`).trim() || fallbackColors[i]);
    this.signals.forEach((signal, i) => signal.color = this.colors[i % this.colors.length]);
    this.themeVersion = (this.themeVersion || 0) + 1;
    this.renderNames(); this.draw();
  }
  setMaxSamples(limit) {
    const next = Math.max(2000, Math.min(200000, Number(limit) || 40000));
    this.maxSamples = next;
    for (const s of this.signals) compactSignalSamples(s, next);
    this.dataVersion++;
  }
  setTimeUnit(unit = 'auto') {
    this.timeUnit = unit || 'auto';
    this.dataVersion++;
    this.draw();
    this.onCursor?.(this.cursorT);
  }
  setSignals(list) {
    this.signals = list.map((s, i) => ({ ...s, width: s.width || 1, visible: s.visible !== false, expanded: !!s.expanded, color: this.colors[i % this.colors.length], samples: [], last: null, _lod: null }));
    this.tStart = 0; this.tEnd = 1e9; this.cursorT = 0; this.lastTime = 0; this.dataVersion++; this.renderNames(); this.resize();
    if (!this.signals.length) this.onCursor?.(null);
  }
  toggle(name) { const signal = this.signals.find(s => s.name === name); if (!signal) return false; signal.visible = !signal.visible; this.dataVersion++; this.renderNames(); this.resize(); return signal.visible; }
  toggleExpand(name) { const signal = this.signals.find(s => s.name === name); if (!signal || signal.width <= 1) return false; signal.expanded = !signal.expanded; this.dataVersion++; this.renderNames(); this.resize(); return signal.expanded; }
  renderNames() {
    this.namesEl.replaceChildren(); this.valueElements = new Map();
    const head = document.createElement('div'); head.className = 'wave-names-head';
    head.innerHTML = '<span>Signal</span><span>Value</span>';
    this.namesEl.append(head);
    for (const entry of this.displayRows()) {
      const { signal, bitOffset, bitLabel, key } = entry;
      const real = ['real', 'realtime'].includes(signal.kind);
      const isBus = bitOffset === null && signal.width > 1 && !real;
      const range = isBus ? `[${Number.isInteger(signal.left) ? signal.left : signal.width - 1}:${Number.isInteger(signal.right) ? signal.right : 0}]` : '';
      const row = document.createElement('div');
      row.className = bitOffset !== null ? 'wave-name wave-bit' : 'wave-name';
      row.title = bitLabel || `${signal.name}${range}`;
      if (isBus) {
        const exp = document.createElement('button');
        exp.type = 'button';
        exp.className = 'wave-exp';
        exp.textContent = signal.expanded ? '▾' : '▸';
        exp.setAttribute('aria-label', `${signal.expanded ? 'Collapse' : 'Expand'} ${signal.name} bits`);
        exp.title = signal.expanded ? `Collapse ${signal.name}${range} bits` : `Expand ${signal.name}${range} into ${signal.width} bit waveforms`;
        exp.onclick = e => { e.stopPropagation(); this.toggleExpand(signal.name); };
        row.append(exp);
      }
      const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = signal.color;
      const name = document.createElement('span'); name.textContent = bitLabel || `${signal.name}${range}`;
      const value = document.createElement('span'); value.className = 'wn-val'; value.textContent = '—';
      row.append(dot, name, value);
      if (isBus) { row.style.cursor = 'pointer'; row.onclick = () => this.toggleExpand(signal.name); }
      this.namesEl.append(row); this.valueElements.set(key, value);
    }
  }
  push(time, values) {
    this.lastTime = Math.max(this.lastTime, time);
    let dirty = false;
    for (const signal of this.signals) {
      const value = values.get(signal.name); if (value === undefined || value === signal.last) continue;
      if (signal.samples.at(-1)?.t === time) {
        signal.samples[signal.samples.length - 1] = { t: time, v: value };
        if (signal._lod && signal.samples.length - 1 < signal._lod.builtLen) signal._lod = null;
      } else {
        signal.samples.push({ t: time, v: value });
      }
      signal.last = value;
      dirty = true;
      if (signal.samples.length > this.maxSamples) compactSignalSamples(signal, this.maxSamples);
    }
    if (dirty) this.dataVersion++;
  }
  clear() { for (const s of this.signals) { s.samples = []; s.last = null; s._lod = null; } this.lastTime = 0; this.tStart = 0; this.tEnd = 1e9; this.dataVersion++; this.draw(); }
  fit() {
    const first = Math.min(...this.signals.filter(s => s.samples.length).map(s => s.samples[0].t));
    this.tStart = Number.isFinite(first) ? first : 0; this.tEnd = Math.max(this.lastTime, this.tStart + 1e6); this.tEnd += (this.tEnd - this.tStart) * .03; this.draw();
  }
  follow(time, span) { this.tStart = Math.max(0, time - span); this.tEnd = Math.max(time + span * .04, span); this.cursorT = time; this.onCursor?.(this.cursorT); }
  zoom(factor, center = (this.tStart + this.tEnd) / 2) {
    const span = Math.max(1, Math.min(1.8e19, (this.tEnd - this.tStart) * factor));
    const fraction = (center - this.tStart) / (this.tEnd - this.tStart); this.tStart = Math.max(0, center - span * fraction); this.tEnd = this.tStart + span; this.draw();
  }
  sampleIndex(signal, time) {
    let lo = 0, hi = signal.samples.length - 1, answer = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (signal.samples[mid].t <= time) { answer = mid; lo = mid + 1; } else hi = mid - 1; }
    return answer;
  }
  valueAt(signal, time) { const index = this.sampleIndex(signal, time); return index < 0 ? null : signal.samples[index].v; }
  drawSingleBitLod(g, signal, bitOffset, rowTop, high, low, mid, width, startIdx, endIdx, span) {
    const samples = signal.samples, lod = ensureSignalLod(signal);
    const pxWidth = Math.max(1, Math.ceil(width));
    const mask = (bitOffset === null && signal.width === 1) ? 1 : (signal.width <= 30 && bitOffset !== null) ? (1 << bitOffset) : 0;
    const bitIdx = bitOffset ?? 0;
    let idx = startIdx, previousY = null;
    const solidPath = new Path2D();
    const unkPath = new Path2D();
    let hasSolid = false, hasUnk = false;
    let barStartPx = -1, barUnk = false;
    const flushBar = px => {
      if (barStartPx < 0) return;
      g.fillStyle = barUnk ? this.palette.unknown : signal.color;
      g.fillRect(barStartPx, high, Math.max(1, px - barStartPx), low - high);
      barStartPx = -1;
      barUnk = false;
    };

    for (let px = 0; px < pxWidth; px++) {
      const t0 = this.tStart + (px / width) * span;
      const t1 = this.tStart + ((px + 1) / width) * span;
      if (t0 > (this.lastTime > 0 ? Math.max(this.lastTime, samples[samples.length - 1].t) : this.tEnd) && samples.length) break;
      while (idx + 1 < endIdx && samples[idx + 1].t <= t0) idx++;
      if (samples[idx].t > t1) continue;

      let endInPx = idx;
      if (idx + 1 < endIdx && samples[idx + 1].t < t1) {
        if (idx + 16 < endIdx && samples[idx + 16].t < t1) {
          endInPx = sampleIndexGe(samples, t1, idx);
          if (endInPx >= endIdx) endInPx = endIdx - 1;
        } else {
          while (endInPx + 1 < endIdx && samples[endInPx + 1].t < t1) endInPx++;
        }
      }

      let saw0 = false, saw1 = false, sawU = false;
      if (endInPx === idx) {
        const ch = samples[idx].v[bitIdx] ?? 'U';
        if (ch === '0' || ch === 'L') saw0 = true;
        else if (ch === '1' || ch === 'H') saw1 = true;
        else sawU = true;
      } else {
        let p = idx;
        const bStart = Math.floor(idx / LOD_BLOCK);
        const bEnd = Math.floor(endInPx / LOD_BLOCK);
        if (bEnd > bStart + 1) {
          const headEnd = (bStart + 1) * LOD_BLOCK;
          for (; p < headEnd; p++) {
            const ch = samples[p].v[bitIdx] ?? 'U';
            if (ch === '0' || ch === 'L') saw0 = true;
            else if (ch === '1' || ch === 'H') saw1 = true;
            else sawU = true;
          }
          for (let b = bStart + 1; b < bEnd; b++) {
            const blk = lod.blocks[b];
            if (!blk) continue;
            if (mask) {
              if (blk.s0 & mask) saw0 = true;
              if (blk.s1 & mask) saw1 = true;
              if (blk.su & mask) sawU = true;
            } else if (blk.bits) {
              const f = blk.bits[bitIdx];
              if (f & 1) saw0 = true;
              if (f & 2) saw1 = true;
              if (f & 4) sawU = true;
            }
          }
          p = bEnd * LOD_BLOCK;
        }
        for (; p <= endInPx; p++) {
          const ch = samples[p].v[bitIdx] ?? 'U';
          if (ch === '0' || ch === 'L') saw0 = true;
          else if (ch === '1' || ch === 'H') saw1 = true;
          else sawU = true;
          if (saw0 && saw1 && sawU) break;
        }
      }

      const toggled = (saw0 && saw1) || (sawU && (saw0 || saw1));
      if (toggled) {
        const lastCh = samples[endInPx].v[bitIdx] ?? 'U';
        const exitY = (lastCh === '0' || lastCh === 'L') ? low : (lastCh === '1' || lastCh === 'H') ? high : mid;
        if (previousY !== null) {
          solidPath.moveTo(px, previousY);
          solidPath.lineTo(px, exitY);
          hasSolid = true;
        }
        if (barStartPx < 0) { barStartPx = px; barUnk = sawU; }
        else if (barUnk !== sawU) { flushBar(px); barStartPx = px; barUnk = sawU; }
        previousY = exitY;
      } else {
        flushBar(px);
        const y = sawU ? mid : saw1 ? high : low;
        if (sawU) {
          if (previousY !== null && previousY !== y) { unkPath.moveTo(px, previousY); unkPath.lineTo(px, y); }
          else unkPath.moveTo(px, y);
          unkPath.lineTo(px + 1, y);
          hasUnk = true;
        } else {
          if (previousY !== null && previousY !== y) { solidPath.moveTo(px, previousY); solidPath.lineTo(px, y); }
          else solidPath.moveTo(px, y);
          solidPath.lineTo(px + 1, y);
          hasSolid = true;
        }
        previousY = y;
      }
      idx = endInPx;
    }
    flushBar(pxWidth);

    g.lineWidth = 1.4;
    if (hasSolid) {
      g.strokeStyle = signal.color;
      g.setLineDash([]);
      g.stroke(solidPath);
    }
    if (hasUnk) {
      g.strokeStyle = this.palette.unknown;
      g.setLineDash([3, 3]);
      g.stroke(unkPath);
      g.setLineDash([]);
    }
  }
  drawBusLod(g, signal, real, high, low, mid, width, startIdx, endIdx, span) {
    const samples = signal.samples;
    const pxWidth = Math.max(1, Math.ceil(width));
    let idx = startIdx;
    let runStartPx = -1, runSample = null, runDense = false, runDenseUnknown = false;
    const solidPath = new Path2D();
    let hasSolid = false;

    const flushFlat = px => {
      if (runStartPx < 0 || !runSample) return;
      const x1 = runStartPx, x2 = px, w = x2 - x1;
      const val = runSample.v;
      const unk = !real && /[^01LH]/.test(val);
      if (unk) {
        g.fillStyle = this.palette.unknown;
        g.strokeStyle = this.palette.unknown;
        g.globalAlpha = 0.09;
        g.fillRect(x1, high, w, low - high);
        g.globalAlpha = 1;
        g.lineWidth = 1.4;
        g.strokeRect(x1 + 0.5, high + 0.5, Math.max(1, w - 1), low - high - 1);
      } else {
        g.fillStyle = signal.color;
        g.globalAlpha = 0.07;
        g.fillRect(x1, high, w, low - high);
        g.globalAlpha = 1;
        const bevel = Math.min(3, w / 2);
        solidPath.moveTo(x1, mid); solidPath.lineTo(x1 + bevel, high); solidPath.lineTo(x2 - bevel, high);
        solidPath.lineTo(x2, mid); solidPath.lineTo(x2 - bevel, low); solidPath.lineTo(x1 + bevel, low);
        solidPath.closePath();
        hasSolid = true;
      }
      if (w > 24) {
        g.save(); g.beginPath(); g.rect(x1, high, w, low - high); g.clip();
        g.fillStyle = unk ? this.palette.unknown : signal.color;
        g.font = '9px Consolas, monospace'; g.textBaseline = 'middle';
        g.fillText(real ? val : hexOf(val), x1 + 6, mid);
        g.restore();
      }
      runStartPx = -1; runSample = null;
    };

    const flushDense = px => {
      if (!runDense || runStartPx < 0) return;
      const w = Math.max(1, px - runStartPx);
      g.fillStyle = runDenseUnknown ? this.palette.unknown : signal.color;
      g.globalAlpha = 0.34;
      g.fillRect(runStartPx, high, w, low - high);
      g.globalAlpha = 1;
      solidPath.moveTo(runStartPx, high); solidPath.lineTo(px, high);
      solidPath.moveTo(runStartPx, low); solidPath.lineTo(px, low);
      hasSolid = true;
      runStartPx = -1; runDense = false; runDenseUnknown = false;
    };

    for (let px = 0; px < pxWidth; px++) {
      const t0 = this.tStart + (px / width) * span;
      const t1 = this.tStart + ((px + 1) / width) * span;
      if (t0 > (this.lastTime > 0 ? Math.max(this.lastTime, samples[samples.length - 1].t) : this.tEnd) && samples.length) break;
      while (idx + 1 < endIdx && samples[idx + 1].t <= t0) idx++;
      if (samples[idx].t > t1) continue;

      let endInPx = idx;
      if (idx + 1 < endIdx && samples[idx + 1].t < t1) {
        if (idx + 16 < endIdx && samples[idx + 16].t < t1) {
          endInPx = sampleIndexGe(samples, t1, idx);
          if (endInPx >= endIdx) endInPx = endIdx - 1;
        } else {
          while (endInPx + 1 < endIdx && samples[endInPx + 1].t < t1) endInPx++;
        }
      }

      if (endInPx > idx) {
        if (!runDense) flushFlat(px);
        const unk = !real && /[^01LH]/.test(samples[idx].v);
        if (!runDense) { runStartPx = px; runDense = true; runDenseUnknown = unk; }
        else if (unk) runDenseUnknown = true;
      } else {
        if (runDense) flushDense(px);
        if (runStartPx < 0) { runStartPx = px; runSample = samples[idx]; }
        else if (runSample !== samples[idx] && runSample.v !== samples[idx].v) {
          flushFlat(px);
          runStartPx = px; runSample = samples[idx];
        }
      }
      idx = endInPx;
    }
    if (runDense) flushDense(pxWidth);
    else flushFlat(pxWidth);

    if (hasSolid) {
      g.strokeStyle = signal.color;
      g.lineWidth = 1.4;
      g.setLineDash([]);
      g.stroke(solidPath);
    }
  }
  renderStaticWaveforms(rows, firstRow, lastRow, width, height) {
    const g = this.cacheCtx;
    if (!g) return;
    if (this.cacheCanvas.width !== this.canvas.width || this.cacheCanvas.height !== this.canvas.height) {
      this.cacheCanvas.width = this.canvas.width;
      this.cacheCanvas.height = this.canvas.height;
    }
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    g.fillStyle = this.palette.bg;
    g.fillRect(0, 0, width, height);
    g.fillStyle = this.palette.header;
    g.fillRect(0, 0, width, HEADER);

    const span = this.tEnd - this.tStart || 1, xOf = time => (time - this.tStart) / span * width;
    const raw = span / Math.max(3, width / 100), magnitude = 10 ** Math.floor(Math.log10(raw)), normalized = raw / magnitude;
    const grid = (normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10) * magnitude;

    g.font = '8.5px Consolas, monospace'; g.textBaseline = 'middle'; g.lineWidth = 1;
    const gridPath = new Path2D(), tickPath = new Path2D();
    g.fillStyle = this.palette.text;
    for (let t = Math.ceil(this.tStart / grid) * grid; t <= this.tEnd; t += grid) {
      const x = xOf(t);
      gridPath.moveTo(x, HEADER); gridPath.lineTo(x, height);
      tickPath.moveTo(x, HEADER - 5); tickPath.lineTo(x, HEADER);
      g.fillText(fmtTime(t, this.timeUnit), x + 5, HEADER / 2);
    }
    g.strokeStyle = this.palette.grid; g.stroke(gridPath);
    g.strokeStyle = this.palette.line;
    tickPath.moveTo(0, HEADER - 0.5); tickPath.lineTo(width, HEADER - 0.5);
    g.stroke(tickPath);

    const divPath = new Path2D();
    for (let r = firstRow; r <= lastRow; r++) {
      const y = HEADER + (r + 1) * ROW;
      divPath.moveTo(0, y); divPath.lineTo(width, y);
    }
    g.strokeStyle = this.palette.row; g.lineWidth = 1; g.stroke(divPath);

    const lodThreshold = Math.max(600, width * 1.5);
    for (let row = firstRow; row <= lastRow; row++) {
      const entry = rows[row];
      if (!entry) continue;
      const { signal, bitOffset } = entry;
      const top = HEADER + row * ROW, high = top + 6, low = top + ROW - 7, mid = (high + low) / 2;
      const samples = signal.samples;
      if (!samples.length) continue;
      const startIdx = Math.max(0, this.sampleIndex(signal, this.tStart));
      let endIdx = sampleIndexGe(samples, this.tEnd, startIdx) + 1;
      if (endIdx <= startIdx) endIdx = startIdx + 1;
      if (endIdx > samples.length) endIdx = samples.length;
      const visCount = endIdx - startIdx;
      const real = ['real', 'realtime'].includes(signal.kind);
      const isSingleBit = bitOffset !== null || (signal.width === 1 && !real);

      if (visCount > lodThreshold) {
        if (isSingleBit) this.drawSingleBitLod(g, signal, bitOffset, top, high, low, mid, width, startIdx, endIdx, span);
        else this.drawBusLod(g, signal, real, high, low, mid, width, startIdx, endIdx, span);
        continue;
      }

      if (isSingleBit) {
        let previousY = null;
        const solidPath = new Path2D(), unkPath = new Path2D();
        let hasSolid = false, hasUnk = false;
        const unkLabels = [];
        for (let i = startIdx; i < endIdx; i++) {
          const sample = samples[i]; if (sample.t > this.tEnd) break;
          const nextTime = samples[i + 1]?.t ?? (this.lastTime > sample.t ? this.lastTime : this.tEnd);
          if (nextTime < this.tStart) continue;
          const x1 = Math.max(0, xOf(sample.t)), x2 = Math.min(width, xOf(nextTime));
          const val = bitOffset !== null ? (sample.v[bitOffset] ?? 'U') : sample.v;
          const unknown = !real && /[^01LH]/.test(val);
          const y = unknown ? mid : /[1H]/.test(val) ? high : low;
          if (unknown) {
            if (previousY !== null) { unkPath.moveTo(x1, previousY); unkPath.lineTo(x1, y); } else unkPath.moveTo(x1, y);
            unkPath.lineTo(x2, y); hasUnk = true;
            if (x2 - x1 > 20) unkLabels.push([val, x1 + 5, mid - 3]);
          } else {
            if (previousY !== null) { solidPath.moveTo(x1, previousY); solidPath.lineTo(x1, y); } else solidPath.moveTo(x1, y);
            solidPath.lineTo(x2, y); hasSolid = true;
          }
          previousY = y;
        }
        g.lineWidth = 1.4;
        if (hasSolid) { g.strokeStyle = signal.color; g.setLineDash([]); g.stroke(solidPath); }
        if (hasUnk) {
          g.strokeStyle = this.palette.unknown; g.setLineDash([3, 3]); g.stroke(unkPath); g.setLineDash([]);
          if (unkLabels.length) {
            g.fillStyle = this.palette.unknown; g.font = '9px Consolas, monospace';
            for (const [txt, lx, ly] of unkLabels) g.fillText(txt, lx, ly);
          }
        }
      } else {
        const solidPath = new Path2D(), unkPath = new Path2D();
        let hasSolid = false, hasUnk = false;
        for (let i = startIdx; i < endIdx; i++) {
          const sample = samples[i]; if (sample.t > this.tEnd) break;
          const nextTime = samples[i + 1]?.t ?? (this.lastTime > sample.t ? this.lastTime : this.tEnd);
          if (nextTime < this.tStart) continue;
          const x1 = Math.max(0, xOf(sample.t)), x2 = Math.min(width, xOf(nextTime));
          if (x2 - x1 <= 0.5) continue;
          const val = sample.v;
          const unknown = !real && /[^01LH]/.test(val);
          const col = unknown ? this.palette.unknown : signal.color;
          g.fillStyle = col; g.globalAlpha = 0.07; g.fillRect(x1, high, x2 - x1, low - high); g.globalAlpha = 1;
          const bevel = Math.min(3, (x2 - x1) / 2);
          const targetPath = unknown ? unkPath : solidPath;
          targetPath.moveTo(x1, mid); targetPath.lineTo(x1 + bevel, high); targetPath.lineTo(x2 - bevel, high);
          targetPath.lineTo(x2, mid); targetPath.lineTo(x2 - bevel, low); targetPath.lineTo(x1 + bevel, low); targetPath.closePath();
          if (unknown) hasUnk = true; else hasSolid = true;
          if (x2 - x1 > 24) {
            g.save(); g.beginPath(); g.rect(x1, high, x2 - x1, low - high); g.clip();
            g.fillStyle = col; g.font = '9px Consolas, monospace'; g.textBaseline = 'middle';
            g.fillText(real ? val : hexOf(val), x1 + 6, mid); g.restore();
          }
        }
        g.lineWidth = 1.4; g.setLineDash([]);
        if (hasSolid) { g.strokeStyle = signal.color; g.stroke(solidPath); }
        if (hasUnk) { g.strokeStyle = this.palette.unknown; g.stroke(unkPath); }
      }
    }
  }
  draw() {
    const g = this.ctx, width = this.canvas.width / this.dpr, height = this.canvas.height / this.dpr;
    if (!width || !height) return;
    const rows = this.displayRows();
    const scrollTop = this.scrollHost?.scrollTop || 0;
    const viewH = this.scrollHost?.clientHeight || height;
    const firstRow = rows.length ? Math.max(0, Math.floor((scrollTop - HEADER) / ROW) - 1) : 0;
    const lastRow = rows.length ? Math.min(rows.length - 1, Math.ceil((scrollTop + viewH - HEADER) / ROW) + 1) : -1;

    const key = `${this.canvas.width}x${this.canvas.height}|${this.dpr}|${this.tStart}|${this.tEnd}|${this.lastTime}|${this.dataVersion}|${this.themeVersion}|${this.timeUnit}|${firstRow}:${lastRow}`;
    if (key !== this.cacheKey) {
      this.renderStaticWaveforms(rows, firstRow, lastRow, width, height);
      this.cacheKey = key;
    }

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.cacheCanvas, 0, 0);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const span = this.tEnd - this.tStart || 1;
    const cursor = (this.cursorT - this.tStart) / span * width;
    if (cursor >= 0 && cursor <= width) {
      g.strokeStyle = this.palette.cursor; g.lineWidth = 1; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(cursor, HEADER); g.lineTo(cursor, height); g.stroke();
      g.setLineDash([]);
    }

    for (let row = 0; row < rows.length; row++) {
      const { signal, bitOffset, key: rKey } = rows[row];
      const element = this.valueElements?.get(rKey);
      if (!element) continue;
      const real = ['real', 'realtime'].includes(signal.kind);
      const rawVal = this.valueAt(signal, this.cursorT);
      let nextTxt = '—';
      if (rawVal !== null) {
        if (bitOffset !== null) nextTxt = rawVal[bitOffset] ?? 'U';
        else nextTxt = (signal.width === 1 || real) ? rawVal : hexOf(rawVal);
      }
      if (element.textContent !== nextTxt) element.textContent = nextTxt;
    }
    this.syncScrollbar();
  }
  scrollMetrics() {
    const trackW = this.scrollTrack?.clientWidth || 1;
    const span = Math.max(1, this.tEnd - this.tStart);
    const total = Math.max(this.lastTime, this.tEnd, 1e6);
    const scrollable = Math.max(0, total - span);
    const ratio = Math.min(1, span / total);
    const thumbW = Math.max(28, Math.min(trackW, Math.round(trackW * ratio)));
    const maxLeft = Math.max(0, trackW - thumbW);
    return { trackW, span, total, scrollable, thumbW, maxLeft };
  }
  syncScrollbar() {
    if (!this.scrollTrack || !this.scrollThumb) return;
    const { scrollable, thumbW, maxLeft } = this.scrollMetrics();
    const frac = scrollable > 0 ? Math.max(0, Math.min(1, this.tStart / scrollable)) : 0;
    this.scrollThumb.style.width = `${thumbW}px`;
    this.scrollThumb.style.transform = `translateX(${Math.round(maxLeft * frac)}px)`;
    this.scrollThumb.classList.toggle('full', scrollable <= 0);
    this.scrollTrack.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
  }
}
