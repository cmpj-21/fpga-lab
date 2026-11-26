// Lightweight interactive 2D top-down PCB renderer for RZ-EasyFPGA A2.2 (EP4CE6E22C8N).
// Runs on pure HTML5 Canvas2D with ~0% GPU overhead for low-end GPUs or fast schematic view.
// Physical 7-segment digit order Left->Right matches real PCB: Q4(137), Q3(136), Q2(135), Q1(133).

export function createBoard2D(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const PCB_W = 136;
  const PCB_H = 106;

  const state = {
    active: false,
    power: true,
    glow: 0.65,
    persistenceMs: 28,
    tdmPeakBoost: true,
    buzzer: false,
    dipMask: 0,
    keys: { key1: false, key2: false, key3: false, key4: false, reset: false },
    leds: Array.from({ length: 4 }, () => ({ on: false, target: 0, duty: 0 })),
    digits: Array.from({ length: 4 }, () => ({
      segs: 0,
      enabled: false,
      target: new Float32Array(8),
      duty: new Float32Array(8),
    })),
    hoverId: null,
    activePointerKey: null,
  };

  let fps = 60;
  let prevMs = performance.now();
  let rafId = 0;

  // Hitboxes in PCB mm coordinates (origin = top-left of 136x106 mm PCB)
  const hitRegions = [
    { id: 'power', kind: 'power', x: 18, y: 8, w: 12, h: 12 },
    { id: 'reset', kind: 'key', keyId: 'reset', x: 8, y: 82, w: 12, h: 12 },
    { id: 'key1', kind: 'key', keyId: 'key1', x: 82, y: 83, w: 9, h: 9 },
    { id: 'key2', kind: 'key', keyId: 'key2', x: 93, y: 83, w: 9, h: 9 },
    { id: 'key3', kind: 'key', keyId: 'key3', x: 104, y: 83, w: 9, h: 9 },
    { id: 'key4', kind: 'key', keyId: 'key4', x: 115, y: 83, w: 9, h: 9 },
    { id: 'dip_0', kind: 'dip', index: 0, x: 87.8, y: 63.5, w: 3.1, h: 13 },
    { id: 'dip_1', kind: 'dip', index: 1, x: 91.0, y: 63.5, w: 3.1, h: 13 },
    { id: 'dip_2', kind: 'dip', index: 2, x: 94.2, y: 63.5, w: 3.1, h: 13 },
    { id: 'dip_3', kind: 'dip', index: 3, x: 97.4, y: 63.5, w: 3.1, h: 13 },
  ];

  let viewTransform = { scale: 1, ox: 0, oy: 0 };

  function tdmCurve(duty) {
    const d = Math.max(0, Math.min(1, duty));
    if (d < 0.002) return 0;
    return state.tdmPeakBoost !== false ? (3.0 * d) / (1.0 + 2.0 * d) : d;
  }

  function clientToPcb(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const x = (clientX - r.left - viewTransform.ox) / viewTransform.scale;
    const y = (clientY - r.top - viewTransform.oy) / viewTransform.scale;
    return { x, y };
  }

  function hitTest(px, py) {
    for (const h of hitRegions) {
      if (px >= h.x && px <= h.x + h.w && py >= h.y && py <= h.y + h.h) return h;
    }
    return null;
  }

  canvas.addEventListener('pointermove', e => {
    const { x, y } = clientToPcb(e.clientX, e.clientY);
    const hit = hitTest(x, y);
    state.hoverId = hit ? hit.id : null;
    canvas.style.cursor = hit ? 'pointer' : 'default';
  });
  canvas.addEventListener('pointerleave', () => {
    state.hoverId = null;
    if (state.activePointerKey) {
      opts.onKey?.(state.activePointerKey, false);
      state.activePointerKey = null;
    }
  });
  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const { x, y } = clientToPcb(e.clientX, e.clientY);
    const hit = hitTest(x, y);
    if (!hit) return;
    e.preventDefault();
    if (hit.kind === 'key') {
      state.activePointerKey = hit.keyId;
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      opts.onKey?.(hit.keyId, true);
    } else if (hit.kind === 'dip') {
      opts.onDip?.(hit.index);
    } else if (hit.kind === 'power') {
      opts.onPower?.(!state.power);
    }
  });
  const releaseKey = () => {
    if (!state.activePointerKey) return;
    const k = state.activePointerKey;
    state.activePointerKey = null;
    opts.onKey?.(k, false);
  };
  canvas.addEventListener('pointerup', releaseKey);
  canvas.addEventListener('pointercancel', releaseKey);

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  function drawHSeg(cx, cy, len, thick) {
    const hl = len / 2, ht = thick / 2;
    ctx.beginPath();
    ctx.moveTo(cx - hl, cy);
    ctx.lineTo(cx - hl + ht, cy - ht);
    ctx.lineTo(cx + hl - ht, cy - ht);
    ctx.lineTo(cx + hl, cy);
    ctx.lineTo(cx + hl - ht, cy + ht);
    ctx.lineTo(cx - hl + ht, cy + ht);
    ctx.closePath();
    ctx.fill();
  }

  function drawVSeg(cx, cy, len, thick) {
    const hl = len / 2, ht = thick / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy - hl);
    ctx.lineTo(cx + ht, cy - hl + ht);
    ctx.lineTo(cx + ht, cy + hl - ht);
    ctx.lineTo(cx, cy + hl);
    ctx.lineTo(cx - ht, cy + hl - ht);
    ctx.lineTo(cx - ht, cy - hl + ht);
    ctx.closePath();
    ctx.fill();
  }

  function drawFrame(now, dt) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (!cw || !ch) return;
    const pw = Math.round(cw * dpr);
    const ph = Math.round(ch * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }

    // Update persistence decay identically to board3d.js
    const tauMs = Math.max(0, Number(state.persistenceMs) || 0);
    const decayAlpha = tauMs > 0 ? (1 - Math.exp(-(dt * 1000) / tauMs)) : 1;
    for (const led of state.leds) {
      const target = state.power ? led.target : 0;
      led.duty = tauMs > 0 ? led.duty + (target - led.duty) * decayAlpha : target;
      if (led.duty < 1e-4) led.duty = 0;
    }
    for (const d of state.digits) {
      for (let b = 0; b < 8; b++) {
        const target = state.power ? d.target[b] : 0;
        const next = tauMs > 0 ? d.duty[b] + (target - d.duty[b]) * decayAlpha : target;
        d.duty[b] = next < 1e-4 ? 0 : next;
      }
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const isDark = document.documentElement.dataset.scheme === 'dark';
    ctx.fillStyle = isDark ? '#11161d' : '#e5eaf0';
    ctx.fillRect(0, 0, cw, ch);

    const pad = 22;
    const scale = Math.min((cw - pad * 2) / PCB_W, (ch - pad * 2) / PCB_H);
    const ox = (cw - PCB_W * scale) / 2;
    const oy = (ch - PCB_H * scale) / 2;
    viewTransform = { scale, ox, oy };

    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);

    // Subtle PCB drop shadow + matte black board body
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.38)';
    ctx.shadowBlur = 16;
    ctx.shadowOffsetY = 5;
    roundRect(0, 0, PCB_W, PCB_H, 3);
    ctx.fillStyle = '#181b20';
    ctx.fill();
    ctx.restore();
    roundRect(0, 0, PCB_W, PCB_H, 3);
    ctx.strokeStyle = '#333a45';
    ctx.lineWidth = 0.6;
    ctx.stroke();

    // 4 Corner mounting holes (gold ring)
    for (const [hx, hy] of [[5, 5], [PCB_W - 5, 5], [5, PCB_H - 5], [PCB_W - 5, PCB_H - 5]]) {
      ctx.beginPath(); ctx.arc(hx, hy, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#d4aa4c'; ctx.fill();
      ctx.beginPath(); ctx.arc(hx, hy, 1.35, 0, Math.PI * 2);
      ctx.fillStyle = isDark ? '#11161d' : '#e5eaf0'; ctx.fill();
    }

    // Silkscreen title
    ctx.fillStyle = 'rgba(235,240,248,0.78)';
    ctx.font = 'bold 3px ui-monospace, monospace';
    ctx.fillText('RZ-EasyFPGA A2.2', 36, 16);
    ctx.font = '2.3px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(200,210,224,0.58)';
    ctx.fillText('Cyclone IV · EP4CE6E22C8N · 50 MHz', 36, 20);

    // DC barrel + USB power + Power switch + PWR LED
    ctx.fillStyle = '#252930';
    roundRect(6, 3, 10, 12, 1); ctx.fill();
    ctx.fillStyle = '#c5ccd6';
    roundRect(24, 2, 11, 12, 1); ctx.fill();
    ctx.fillStyle = '#1f2329'; ctx.font = '1.8px ui-monospace, monospace';
    ctx.fillText('USB', 27.3, 9);

    // Power switch (interactive)
    roundRect(18, 9, 5, 7, 1);
    ctx.fillStyle = state.power ? '#d63b3b' : '#555d68';
    ctx.fill();
    if (state.hoverId === 'power') { ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.5; ctx.stroke(); }
    ctx.fillStyle = '#cfd8e3'; ctx.font = '1.8px ui-monospace, monospace';
    ctx.fillText('PWR', 17.6, 19);

    // Green Power LED
    ctx.beginPath(); ctx.arc(27, 18.5, 1.4, 0, Math.PI * 2);
    if (state.power) {
      ctx.save();
      ctx.shadowColor = '#39d66b'; ctx.shadowBlur = 8;
      ctx.fillStyle = '#4ef285'; ctx.fill();
      ctx.restore();
    } else {
      ctx.fillStyle = '#1b3a24'; ctx.fill();
    }

    // Yellow Expansion Headers P1 (top), P2 (bottom), P3 (right)
    const drawHeader = (x, y, cols, rows, label) => {
      ctx.fillStyle = '#d4ad2a';
      roundRect(x, y, cols * 2.1 + 1.2, rows * 2.1 + 1.2, 0.5); ctx.fill();
      ctx.fillStyle = '#f8e27c';
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          ctx.fillRect(x + 0.9 + c * 2.1, y + 0.9 + r * 2.1, 0.85, 0.85);
        }
      }
      ctx.fillStyle = 'rgba(220,228,238,0.65)';
      ctx.font = '2px ui-monospace, monospace';
      ctx.fillText(label, x, y - 1);
    };
    drawHeader(28, 28, 19, 2, 'P1');
    drawHeader(24, 71, 21, 2, 'P2');
    drawHeader(74, 38, 2, 12, 'P3');

    // JTAG & AS headers (left edge)
    for (const [yy, lbl] of [[34, 'AS'], [54, 'JTAG']]) {
      ctx.fillStyle = '#101318';
      roundRect(4, yy, 9, 16, 0.8); ctx.fill();
      ctx.strokeStyle = '#404854'; ctx.lineWidth = 0.5; ctx.stroke();
      ctx.fillStyle = '#cbd5e1'; ctx.font = '2px ui-monospace, monospace';
      ctx.fillText(lbl, 14.5, yy + 9);
    }

    // Cyclone IV EP4CE6E22C8N Main FPGA IC
    const fx = 42, fy = 40, fs = 22;
    ctx.fillStyle = '#9aa3b0';
    for (let i = 0; i < 16; i++) {
      const p = 1.8 + i * 1.2;
      ctx.fillRect(fx + p, fy - 1.2, 0.6, 1.2);
      ctx.fillRect(fx + p, fy + fs, 0.6, 1.2);
      ctx.fillRect(fx - 1.2, fy + p, 1.2, 0.6);
      ctx.fillRect(fx + fs, fy + p, 1.2, 0.6);
    }
    ctx.fillStyle = '#242830';
    roundRect(fx, fy, fs, fs, 1); ctx.fill();
    ctx.strokeStyle = '#485260'; ctx.lineWidth = 0.4; ctx.stroke();
    ctx.fillStyle = '#d8e0ea'; ctx.font = 'bold 2.6px ui-monospace, monospace';
    ctx.fillText('ALTERA', fx + 4.4, fy + 8.5);
    ctx.font = '2.1px ui-monospace, monospace'; ctx.fillStyle = '#9db0c7';
    ctx.fillText('Cyclone IV', fx + 3.6, fy + 12.2);
    ctx.font = '1.7px ui-monospace, monospace';
    ctx.fillText('EP4CE6E22C8N', fx + 3.0, fy + 15.6);

    // 50 MHz Crystal Oscillator
    ctx.fillStyle = '#cdd5df';
    roundRect(28, 52, 7, 5, 0.6); ctx.fill();
    ctx.fillStyle = '#232830'; ctx.font = '1.6px ui-monospace, monospace';
    ctx.fillText('50M', 29.4, 55.2);

    // SDRAM IC (bottom center-left)
    ctx.fillStyle = '#232730';
    roundRect(38, 82, 22, 11, 0.8); ctx.fill();
    ctx.fillStyle = '#9aa8b8'; ctx.font = '1.9px ui-monospace, monospace';
    ctx.fillText('SDRAM 64M', 42, 88.2);

    // Right-edge connectors: DB9 RS-232 & Blue DB15 VGA
    ctx.fillStyle = '#303640';
    roundRect(121, 24, 14, 24, 1); ctx.fill();
    ctx.fillStyle = '#dbe4ef'; ctx.font = '2px ui-monospace, monospace';
    ctx.fillText('UART', 124.2, 37);

    ctx.fillStyle = '#2563eb';
    roundRect(121, 52, 14, 26, 1); ctx.fill();
    ctx.fillStyle = '#eff6ff'; ctx.font = '2.1px ui-monospace, monospace';
    ctx.fillText('VGA', 125.2, 66);

    // === 4-DIGIT 7-SEGMENT DISPLAY (YLB3641BH) ===
    // Left -> Right: Q4(137/dtube4) · Q3(136/dtube3) · Q2(135/dtube2) · Q1(133/dtube1)
    const dx = 76, dy = 8, dw = 40, dh = 15;
    ctx.fillStyle = '#e5e7eb';
    roundRect(dx, dy, dw, dh, 0.9); ctx.fill();
    ctx.fillStyle = '#15181d';
    roundRect(dx + 0.8, dy + 0.8, dw - 1.6, dh - 1.6, 0.5); ctx.fill();
    ctx.fillStyle = 'rgba(220,228,238,0.7)';
    ctx.font = '1.7px ui-monospace, monospace';
    const dLabels = ['Q4·137', 'Q3·136', 'Q2·135', 'Q1·133'];
    for (let d = 0; d < 4; d++) {
      const cx = dx + 5.5 + d * 9.5;
      const cy = dy + dh / 2;
      ctx.fillStyle = 'rgba(210,220,235,0.6)';
      ctx.fillText(dLabels[d], cx - 3.3, dy - 1.2);
      const digit = state.digits[d];
      const segGeom = [
        () => drawHSeg(cx, cy - 4.4, 4.8, 1.05),      // a
        () => drawVSeg(cx + 2.4, cy - 2.2, 4.1, 1.05), // b
        () => drawVSeg(cx + 2.4, cy + 2.2, 4.1, 1.05), // c
        () => drawHSeg(cx, cy + 4.4, 4.8, 1.05),       // d
        () => drawVSeg(cx - 2.4, cy + 2.2, 4.1, 1.05), // e
        () => drawVSeg(cx - 2.4, cy - 2.2, 4.1, 1.05), // f
        () => drawHSeg(cx, cy, 4.6, 1.05),             // g
      ];
      for (let b = 0; b < 8; b++) {
        const lit = state.power ? tdmCurve(digit.duty[b]) : 0;
        ctx.save();
        if (lit > 0.02) {
          const alpha = Math.min(1, 0.25 + lit * 0.75);
          ctx.fillStyle = `rgba(255, ${Math.round(58 + lit * 30)}, ${Math.round(46 + lit * 18)}, ${alpha})`;
          ctx.shadowColor = `rgba(255, 48, 36, ${Math.min(1, lit * (0.55 + state.glow * 0.6))})`;
          ctx.shadowBlur = 4 + lit * 8 * state.glow;
        } else {
          ctx.fillStyle = '#252930';
        }
        if (b < 7) {
          segGeom[b]();
        } else {
          ctx.beginPath();
          ctx.arc(cx + 3.6, cy + 4.4, 0.65, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }

    // === PIEZO BUZZER (BZ1 · PIN_110) ===
    const bx = 96, by = 43;
    ctx.beginPath(); ctx.arc(bx, by, 6.2, 0, Math.PI * 2);
    ctx.fillStyle = '#12151a'; ctx.fill();
    ctx.strokeStyle = state.buzzer && state.power ? '#f59e0b' : '#3a424e';
    ctx.lineWidth = state.buzzer && state.power ? 0.8 : 0.5;
    ctx.stroke();
    ctx.beginPath(); ctx.arc(bx, by, 1.6, 0, Math.PI * 2);
    ctx.fillStyle = '#6b7280'; ctx.fill();
    if (state.buzzer && state.power) {
      const pulse = (now / 350) % 1;
      for (let r = 0; r < 2; r++) {
        const p = (pulse + r * 0.5) % 1;
        ctx.beginPath();
        ctx.arc(bx, by, 6.5 + p * 6, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(245, 158, 11, ${(1 - p) * 0.75})`;
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }
    }
    ctx.fillStyle = '#cbd5e1'; ctx.font = '1.8px ui-monospace, monospace';
    ctx.fillText('BZ1·110', bx - 3.6, by + 8.5);

    // === RED 4-POSITION DIP SWITCH (SW2 · Parallel with S1..S4) ===
    const dipX = 87.5, dipY = 63.5, dipW = 13.4, dipH = 13;
    ctx.fillStyle = '#c81e32';
    roundRect(dipX, dipY, dipW, dipH, 0.9); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 1.8px ui-monospace, monospace';
    ctx.fillText('ON  DIP', dipX + 2.2, dipY + 2.4);
    for (let i = 0; i < 4; i++) {
      const lx = dipX + 1.0 + i * 3.1;
      const isOn = !!(state.dipMask & (1 << i));
      ctx.fillStyle = '#1b1d22';
      ctx.fillRect(lx, dipY + 3.4, 2.0, 6.2);
      ctx.fillStyle = state.hoverId === `dip_${i}` ? '#ffffff' : '#f1f5f9';
      ctx.fillRect(lx + 0.15, isOn ? dipY + 3.6 : dipY + 6.9, 1.7, 2.5);
      ctx.fillStyle = '#fde68a'; ctx.font = '1.8px ui-monospace, monospace';
      ctx.fillText(String(i + 1), lx + 0.5, dipY + 11.9);
    }

    // === USER LEDs (LED1..LED4 · PIN_87..84 · Active-Low) ===
    for (let i = 0; i < 4; i++) {
      const lx = 66 + i * 3.6;
      const ly = 89;
      const lit = state.power ? tdmCurve(state.leds[i].duty) : 0;
      ctx.fillStyle = '#d1d5db';
      ctx.fillRect(lx - 1.1, ly - 2.1, 2.2, 4.2);
      ctx.save();
      if (lit > 0.02) {
        ctx.fillStyle = `rgba(255, 68, 56, ${Math.min(1, 0.35 + lit * 0.65)})`;
        ctx.shadowColor = `rgba(255, 45, 36, ${Math.min(1, lit * (0.65 + state.glow * 0.6))})`;
        ctx.shadowBlur = 6 + lit * 10 * state.glow;
      } else {
        ctx.fillStyle = '#4b1c20';
      }
      ctx.beginPath(); ctx.arc(lx, ly, 1.15, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.fillStyle = '#cbd5e1'; ctx.font = '1.7px ui-monospace, monospace';
      ctx.fillText(String(i + 1), lx - 0.5, ly - 3);
    }
    ctx.fillStyle = '#cbd5e1'; ctx.font = '1.7px ui-monospace, monospace';
    ctx.fillText('LED', 66, 94.5);

    // === TACTILE PUSH BUTTONS (S1..S4 + RESET) ===
    const drawButton = (reg, label, isReset = false) => {
      const pressed = !!state.keys[reg.keyId];
      const hovered = state.hoverId === reg.id;
      ctx.fillStyle = '#b4bcc8';
      roundRect(reg.x, reg.y, reg.w, reg.h, 1.1); ctx.fill();
      if (hovered) { ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 0.6; ctx.stroke(); }
      ctx.beginPath();
      ctx.arc(reg.x + reg.w / 2, reg.y + reg.h / 2, reg.w * (pressed ? 0.27 : 0.31), 0, Math.PI * 2);
      ctx.fillStyle = isReset ? (pressed ? '#dc2626' : '#ef4444') : (pressed ? '#38bdf8' : '#181c22');
      ctx.fill();
      ctx.fillStyle = '#e2e8f0'; ctx.font = 'bold 2px ui-monospace, monospace';
      ctx.fillText(label, reg.x + (isReset ? 1.2 : 2.6), reg.y + reg.h + 3.2);
    };
    drawButton(hitRegions[1], 'RESET', true);
    drawButton(hitRegions[2], 'S1');
    drawButton(hitRegions[3], 'S2');
    drawButton(hitRegions[4], 'S3');
    drawButton(hitRegions[5], 'S4');

    ctx.restore();
  }

  function tick(now) {
    if (!state.active) { rafId = 0; return; }
    rafId = requestAnimationFrame(tick);
    const dt = Math.max(0, Math.min(0.05, (now - prevMs) / 1000));
    prevMs = now;
    fps += (1 / Math.max(dt, 0.0001) - fps) * 0.06;
    drawFrame(now, dt);
  }

  return {
    setActive(on) {
      state.active = !!on;
      canvas.classList.toggle('hidden', !state.active);
      if (state.active && !rafId) {
        prevMs = performance.now();
        rafId = requestAnimationFrame(tick);
      }
    },
    get active() { return state.active; },
    get fps() { return fps; },
    setPower(on) { state.power = !!on; },
    setGlow(g) { state.glow = Math.max(0, Math.min(3, Number(g) || 0)); },
    setBuzzer(on) { state.buzzer = !!on; },
    setDip(mask) { state.dipMask = mask | 0; },
    setKeyVisual(id, pressed) { if (id in state.keys) state.keys[id] = !!pressed; },
    setLed(i, on) {
      const led = state.leds[i];
      if (!led) return;
      led.on = !!on;
      led.target = on ? 1 : 0;
      led.duty = led.target;
    },
    setSegDigit(i, segs, enabled) {
      const d = state.digits[i];
      if (!d) return;
      d.segs = segs;
      d.enabled = !!enabled;
      for (let b = 0; b < 8; b++) {
        const v = (enabled && (segs & (1 << b))) ? 1 : 0;
        d.target[b] = v;
        d.duty[b] = v;
      }
    },
    setDisplayTargets(segTargets, ledTargets, immediate = false) {
      if (segTargets && segTargets.length >= 32) {
        for (let d = 0; d < 4; d++) {
          const digit = state.digits[d];
          let mask = 0;
          const base = d * 8;
          for (let b = 0; b < 8; b++) {
            const t = Math.max(0, Math.min(1, segTargets[base + b] || 0));
            digit.target[b] = t;
            if (immediate) digit.duty[b] = t;
            if (t > 0.01) mask |= (1 << b);
          }
          digit.segs = mask;
          digit.enabled = mask !== 0;
        }
      }
      if (ledTargets && ledTargets.length >= 4) {
        for (let i = 0; i < 4; i++) {
          const led = state.leds[i];
          const t = Math.max(0, Math.min(1, ledTargets[i] || 0));
          led.target = t;
          if (immediate) led.duty = t;
          led.on = t > 0.01;
        }
      }
    },
    setDisplayOptics({ persistenceMs, tdmPeakBoost } = {}) {
      if (Number.isFinite(Number(persistenceMs))) state.persistenceMs = Math.max(0, Math.min(250, Number(persistenceMs)));
      if (typeof tdmPeakBoost === 'boolean') state.tdmPeakBoost = tdmPeakBoost;
    },
    clearOutputs() {
      for (const d of state.digits) { d.segs = 0; d.enabled = false; d.duty.fill(0); d.target.fill(0); }
      for (const l of state.leds) { l.on = false; l.duty = 0; l.target = 0; }
      state.buzzer = false;
    },
  };
}
