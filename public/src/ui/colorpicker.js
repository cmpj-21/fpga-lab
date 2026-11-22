import { positionFloatingMenu } from './selects.js';

const INPUT_VALUE_DESC = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

const QUICK_SWATCHES = [
  '#b7d98c',
  '#d2e991',
  '#58b4ff',
  '#8bc8ce',
  '#ddba7c',
  '#eca292',
  '#bdb0e0',
  '#165432',
  '#ffffff',
  '#121611',
];

const pickers = new WeakMap();
let activePicker = null; // { input, wrap, popEl, openedAt, initialHex, close }

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function normalizeHex(raw, fallback = '#888888') {
  const s = String(raw || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  if (/^[0-9a-f]{6}$/i.test(s)) return `#${s.toLowerCase()}`;
  const m3 = s.match(/^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (m3) return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`.toLowerCase();
  return fallback;
}

function hexToRgb(hex) {
  const clean = normalizeHex(hex, '#000000');
  return {
    r: parseInt(clean.slice(1, 3), 16),
    g: parseInt(clean.slice(3, 5), 16),
    b: parseInt(clean.slice(5, 7), 16),
  };
}

function rgbToHex(r, g, b) {
  const to2 = v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

function rgbToHsv(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let rn = 0, gn = 0, bn = 0;
  if (h < 60) { rn = c; gn = x; }
  else if (h < 120) { rn = x; gn = c; }
  else if (h < 180) { gn = c; bn = x; }
  else if (h < 240) { gn = x; bn = c; }
  else if (h < 300) { rn = x; bn = c; }
  else { rn = c; bn = x; }
  return {
    r: Math.round((rn + m) * 255),
    g: Math.round((gn + m) * 255),
    b: Math.round((bn + m) * 255),
  };
}

function syncSwatch(input) {
  const inst = pickers.get(input);
  if (!inst) return;
  const hex = normalizeHex(INPUT_VALUE_DESC ? INPUT_VALUE_DESC.get.call(input) : input.value, '#888888');
  inst.fillEl.style.background = hex;
  inst.wrap.classList.toggle('is-disabled', Boolean(input.disabled));
  inst.wrap.classList.toggle('hidden', input.classList.contains('hidden') || input.hidden);
  inst.wrap.title = input.title || hex.toUpperCase();
}

function closeActiveColorPicker(restoreFocus = false) {
  if (!activePicker) return;
  const prev = activePicker;
  activePicker = null;
  prev.wrap.classList.remove('is-open');
  prev.popEl.remove();
  if (prev.changed) {
    prev.input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (restoreFocus && document.contains(prev.input)) {
    try { prev.input.focus({ preventScroll: true }); } catch {}
  }
}

function hookColorValue(input) {
  if (!INPUT_VALUE_DESC?.get || !INPUT_VALUE_DESC?.set) return;
  Object.defineProperty(input, 'value', {
    configurable: true,
    get() { return INPUT_VALUE_DESC.get.call(this); },
    set(val) {
      const normalized = normalizeHex(val, '#000000');
      INPUT_VALUE_DESC.set.call(this, normalized);
      syncSwatch(this);
      if (activePicker && activePicker.input === this && !activePicker.internalUpdate) {
        activePicker.syncExternal(normalized);
      }
    },
  });
}

function openColorPopup(input) {
  const inst = pickers.get(input);
  if (!inst || input.disabled) return;
  if (activePicker && activePicker.input === input) return;
  closeActiveColorPicker(false);

  const token = Symbol('tcp');
  window.dispatchEvent(new CustomEvent('trace:close-popups', { detail: token }));
  document.querySelectorAll('.menu-pop:not(.hidden), .ctx-menu:not(.hidden)').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.menu-btn[aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'));

  const initialHex = normalizeHex(input.value, '#888888');
  const startRgb = hexToRgb(initialHex);
  const hsv = rgbToHsv(startRgb.r, startRgb.g, startRgb.b);

  const popEl = document.createElement('div');
  popEl.className = 'tcp-pop';
  popEl.setAttribute('role', 'dialog');
  popEl.setAttribute('aria-label', 'Color picker');

  // 1. Saturation / Value plane
  const svPad = document.createElement('div');
  svPad.className = 'tcp-sv';
  const svWhite = document.createElement('div');
  svWhite.className = 'tcp-sv-white';
  const svBlack = document.createElement('div');
  svBlack.className = 'tcp-sv-black';
  const svDot = document.createElement('div');
  svDot.className = 'tcp-sv-dot';
  svPad.append(svWhite, svBlack, svDot);

  // 2. Preview + Eyedropper + Hue track
  const controls = document.createElement('div');
  controls.className = 'tcp-controls';

  const compare = document.createElement('div');
  compare.className = 'tcp-compare';
  const prevSw = document.createElement('button');
  prevSw.type = 'button';
  prevSw.className = 'tcp-prev-sw';
  prevSw.title = `Revert to ${initialHex.toUpperCase()}`;
  prevSw.style.background = initialHex;
  const currSw = document.createElement('div');
  currSw.className = 'tcp-curr-sw';
  compare.append(prevSw, currSw);

  const sliders = document.createElement('div');
  sliders.className = 'tcp-sliders';

  const hueRow = document.createElement('div');
  hueRow.className = 'tcp-hue-row';
  const hueTrack = document.createElement('div');
  hueTrack.className = 'tcp-hue';
  const hueThumb = document.createElement('div');
  hueThumb.className = 'tcp-hue-thumb';
  hueTrack.append(hueThumb);
  hueRow.append(hueTrack);

  if (typeof window.EyeDropper === 'function') {
    const dropBtn = document.createElement('button');
    dropBtn.type = 'button';
    dropBtn.className = 'tcp-dropper';
    dropBtn.title = 'Pick color from screen';
    dropBtn.setAttribute('aria-label', 'Pick color from screen');
    dropBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m18.4 3.6 2 2a2 2 0 0 1 0 2.8l-3.2 3.2-4.8-4.8 3.2-3.2a2 2 0 0 1 2.8 0Z"/><path d="m14 6.8 3.2 3.2-8.8 8.8H5v-3.4l8.8-8.6Z"/><path d="m4 20 1.4-1.4"/></svg>';
    dropBtn.addEventListener('click', async e => {
      e.preventDefault();
      e.stopPropagation();
      try {
        const res = await new window.EyeDropper().open();
        if (res?.sRGBHex) applyHex(res.sRGBHex, true);
      } catch {}
    });
    hueRow.append(dropBtn);
  }
  sliders.append(hueRow);
  controls.append(compare, sliders);

  // 3. Hex + R / G / B numeric inputs
  const fields = document.createElement('div');
  fields.className = 'tcp-fields';

  const hexWrap = document.createElement('label');
  hexWrap.className = 'tcp-field tcp-field-hex';
  const hexIn = document.createElement('input');
  hexIn.type = 'text';
  hexIn.className = 'tcp-input mono';
  hexIn.spellcheck = false;
  hexIn.maxLength = 7;
  const hexTag = document.createElement('span');
  hexTag.textContent = 'HEX';
  hexWrap.append(hexIn, hexTag);
  fields.append(hexWrap);

  const rgbInputs = {};
  for (const ch of ['r', 'g', 'b']) {
    const f = document.createElement('label');
    f.className = 'tcp-field';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.inputMode = 'numeric';
    inp.className = 'tcp-input mono';
    inp.maxLength = 3;
    const tag = document.createElement('span');
    tag.textContent = ch.toUpperCase();
    f.append(inp, tag);
    fields.append(f);
    rgbInputs[ch] = inp;
  }

  // 4. Quick curated swatches
  const presetRow = document.createElement('div');
  presetRow.className = 'tcp-presets';
  for (const colorHex of QUICK_SWATCHES) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'tcp-preset-dot';
    sw.style.background = colorHex;
    sw.title = colorHex.toUpperCase();
    sw.setAttribute('aria-label', `Choose ${colorHex}`);
    sw.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      applyHex(colorHex, true);
    });
    presetRow.append(sw);
  }

  popEl.append(svPad, controls, fields, presetRow);

  const renderUiOnly = (rgb, hex) => {
    svPad.style.background = `hsl(${Math.round(hsv.h)}, 100%, 50%)`;
    svDot.style.left = `${(hsv.s * 100).toFixed(2)}%`;
    svDot.style.top = `${((1 - hsv.v) * 100).toFixed(2)}%`;
    svDot.style.background = hex;
    hueThumb.style.left = `${((hsv.h / 360) * 100).toFixed(2)}%`;
    hueThumb.style.background = `hsl(${Math.round(hsv.h)}, 100%, 50%)`;
    currSw.style.background = hex;
    if (document.activeElement !== hexIn) hexIn.value = hex.toUpperCase();
    if (document.activeElement !== rgbInputs.r) rgbInputs.r.value = String(rgb.r);
    if (document.activeElement !== rgbInputs.g) rgbInputs.g.value = String(rgb.g);
    if (document.activeElement !== rgbInputs.b) rgbInputs.b.value = String(rgb.b);
  };

  const commitHsv = (emit = true) => {
    const rgb = hsvToRgb(hsv.h, hsv.s, hsv.v);
    const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    renderUiOnly(rgb, hex);
    if (emit && activePicker) {
      activePicker.internalUpdate = true;
      if (INPUT_VALUE_DESC?.set) INPUT_VALUE_DESC.set.call(input, hex);
      syncSwatch(input);
      if (hex !== initialHex) activePicker.changed = true;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      activePicker.internalUpdate = false;
    }
  };

  const applyHex = (hexStr, emit = true) => {
    const clean = normalizeHex(hexStr, '');
    if (!clean) return false;
    const rgb = hexToRgb(clean);
    const nextHsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    if (nextHsv.s > 0.001 && nextHsv.v > 0.001) hsv.h = nextHsv.h;
    hsv.s = nextHsv.s;
    hsv.v = nextHsv.v;
    renderUiOnly(rgb, clean);
    if (emit && activePicker) {
      activePicker.internalUpdate = true;
      if (INPUT_VALUE_DESC?.set) INPUT_VALUE_DESC.set.call(input, clean);
      syncSwatch(input);
      if (clean !== initialHex) activePicker.changed = true;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      activePicker.internalUpdate = false;
    }
    return true;
  };

  // Dragging helpers
  const wireDrag = (el, onPos) => {
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const update = ev => {
        const r = el.getBoundingClientRect();
        const fx = clamp((ev.clientX - r.left) / Math.max(1, r.width), 0, 1);
        const fy = clamp((ev.clientY - r.top) / Math.max(1, r.height), 0, 1);
        onPos(fx, fy);
      };
      update(e);
      const onMove = ev => update(ev);
      const onEnd = () => {
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onEnd);
        el.removeEventListener('pointercancel', onEnd);
      };
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onEnd);
      el.addEventListener('pointercancel', onEnd);
    });
  };

  wireDrag(svPad, (fx, fy) => {
    hsv.s = fx;
    hsv.v = 1 - fy;
    commitHsv(true);
  });

  wireDrag(hueTrack, fx => {
    hsv.h = Math.min(359.99, fx * 360);
    commitHsv(true);
  });

  prevSw.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    applyHex(initialHex, true);
  });

  hexIn.addEventListener('input', () => {
    if (/^#?[0-9a-f]{6}$/i.test(hexIn.value.trim())) applyHex(hexIn.value, true);
  });
  hexIn.addEventListener('change', () => {
    if (!applyHex(hexIn.value, true)) hexIn.value = input.value.toUpperCase();
  });
  hexIn.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      applyHex(hexIn.value, true);
      closeActiveColorPicker(true);
    }
  });

  const onRgbEdit = commitOnEnter => {
    const r = clamp(Number(rgbInputs.r.value) || 0, 0, 255);
    const g = clamp(Number(rgbInputs.g.value) || 0, 0, 255);
    const b = clamp(Number(rgbInputs.b.value) || 0, 0, 255);
    applyHex(rgbToHex(r, g, b), true);
    if (commitOnEnter) closeActiveColorPicker(true);
  };
  for (const ch of ['r', 'g', 'b']) {
    rgbInputs[ch].addEventListener('input', () => onRgbEdit(false));
    rgbInputs[ch].addEventListener('change', () => onRgbEdit(false));
    rgbInputs[ch].addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onRgbEdit(true); }
    });
  }

  const host = input.closest('dialog[open]') || input.closest('dialog') || document.body;
  popEl.style.visibility = 'hidden';
  host.append(popEl);

  activePicker = {
    token,
    input,
    wrap: inst.wrap,
    popEl,
    openedAt: performance.now(),
    initialHex,
    changed: false,
    internalUpdate: false,
    syncExternal: nextHex => applyHex(nextHex, false),
  };
  inst.wrap.classList.add('is-open');
  renderUiOnly(startRgb, initialHex);
  positionFloatingMenu(inst.wrap, popEl, 248, 260, 340);
  popEl.style.visibility = '';
  requestAnimationFrame(() => popEl.classList.add('is-visible'));
}

function toggleColorPopup(input) {
  if (activePicker && activePicker.input === input) closeActiveColorPicker(true);
  else openColorPopup(input);
}

export function upgradeColorInput(input) {
  if (!input || input.tagName !== 'INPUT' || input.type !== 'color' || input.dataset.tcpUpgraded === '1') return;
  input.dataset.tcpUpgraded = '1';

  const inCustomStudio = Boolean(input.closest('.ct-inputs'));
  const variant = inCustomStudio ? 'inline' : 'field';
  const wrap = document.createElement('span');
  wrap.className = `tcp-wrap tcp-wrap--${variant}`;

  const swatch = document.createElement('span');
  swatch.className = 'tcp-swatch';
  swatch.setAttribute('aria-hidden', 'true');
  const fillEl = document.createElement('span');
  fillEl.className = 'tcp-swatch-fill';
  swatch.append(fillEl);

  input.before(wrap);
  wrap.append(swatch, input);
  input.classList.add('tcp-native');

  pickers.set(input, { wrap, swatch, fillEl, variant });
  hookColorValue(input);
  syncSwatch(input);

  let handledPointerDown = false;
  input.addEventListener('mousedown', e => {
    if (e.button !== 0 || input.disabled) return;
    e.preventDefault();
    try { input.focus({ preventScroll: true }); } catch {}
    handledPointerDown = true;
    window.addEventListener('pointerup', () => setTimeout(() => { handledPointerDown = false; }, 0), { once: true });
    toggleColorPopup(input);
  });

  input.addEventListener('click', e => {
    if (handledPointerDown) {
      handledPointerDown = false;
      e.preventDefault();
      return;
    }
    if (input.disabled) return;
    e.preventDefault();
    try { input.focus({ preventScroll: true }); } catch {}
    toggleColorPopup(input);
  });

  input.addEventListener('keydown', e => {
    if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'F4') {
      e.preventDefault();
      e.stopPropagation();
      toggleColorPopup(input);
    }
  });

  const obs = new MutationObserver(() => syncSwatch(input));
  obs.observe(input, {
    attributes: true,
    attributeFilter: ['disabled', 'hidden', 'class', 'title', 'value'],
  });
}

let globalWired = false;
function wireGlobalHandlers() {
  if (globalWired) return;
  globalWired = true;

  window.addEventListener('trace:close-popups', e => {
    if (activePicker && e.detail !== activePicker.token) closeActiveColorPicker(false);
  });

  document.addEventListener('pointerdown', e => {
    if (!activePicker) return;
    if (activePicker.wrap.contains(e.target) || activePicker.popEl.contains(e.target)) return;
    closeActiveColorPicker(false);
  }, true);

  document.addEventListener('keydown', e => {
    if (!activePicker) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeActiveColorPicker(true);
    }
  }, true);

  document.addEventListener('cancel', e => {
    if (!activePicker) return;
    e.preventDefault();
    closeActiveColorPicker(true);
  }, true);

  document.addEventListener('scroll', e => {
    if (!activePicker) return;
    if (activePicker.popEl.contains(e.target)) return;
    if (performance.now() - activePicker.openedAt < 80) return;
    closeActiveColorPicker(false);
  }, true);

  window.addEventListener('resize', () => closeActiveColorPicker(false));
  window.addEventListener('blur', () => closeActiveColorPicker(false));

  const domObs = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.tagName === 'INPUT' && node.type === 'color') upgradeColorInput(node);
        else node.querySelectorAll?.('input[type="color"]:not([data-tcp-upgraded="1"])').forEach(upgradeColorInput);
      }
    }
  });
  domObs.observe(document.body, { childList: true, subtree: true });
}

export function initCustomColorPickers(root = document) {
  wireGlobalHandlers();
  root.querySelectorAll('input[type="color"]:not([data-tcp-upgraded="1"])').forEach(upgradeColorInput);
}
