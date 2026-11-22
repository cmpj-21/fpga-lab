const CHECK_SVG = '<svg class="ts-check" viewBox="0 0 16 16" aria-hidden="true"><polyline points="3.5 8.5 6.5 11.5 12.5 5"/></svg>';
const CHEV_SVG = '<svg class="ts-chev" viewBox="0 0 16 16" aria-hidden="true"><polyline points="4 6 8 10 12 6"/></svg>';

const VALUE_DESC = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
const INDEX_DESC = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');

const instances = new WeakMap();
let active = null; // { select, wrap, popEl, optionEls, highlightIdx, close, setHighlight, commit }
let typeBuffer = '';
let typeTimer = 0;

function detectVariant(select) {
  if (select.closest('.bench-footer')) return 'ghost';
  if (select.closest('.term-new-group')) return 'flush';
  if (select.closest('.unit-label, .truth-export-group, #rtab-uart') || select.classList.contains('pm-select') || select.classList.contains('truth-format')) return 'compact';
  if (select.closest('#left, .deck, .pm-dock')) return 'panel';
  return 'field';
}

function getSelectedDisplayText(select) {
  const opt = select.selectedOptions?.[0] || select.options?.[select.selectedIndex] || select.options?.[0];
  return opt ? opt.textContent.trim() : '—';
}

function syncTrigger(select) {
  const inst = instances.get(select);
  if (!inst) return;
  const { wrap, labelEl } = inst;
  labelEl.textContent = getSelectedDisplayText(select);
  const empty = select.options.length === 0;
  const disabled = Boolean(select.disabled || select.closest('fieldset:disabled'));
  wrap.classList.toggle('is-disabled', disabled);
  wrap.classList.toggle('is-empty', empty);
  wrap.classList.toggle('hidden', select.classList.contains('hidden') || select.hidden);
  wrap.title = select.title || '';
}

function isOptionEnabled(opt) {
  if (!opt || opt.disabled) return false;
  const group = opt.parentElement;
  if (group && group.tagName === 'OPTGROUP' && group.disabled) return false;
  return true;
}

function nextEnabledIndex(select, startIdx, step) {
  const opts = select.options;
  const len = opts.length;
  if (!len) return -1;
  let idx = startIdx;
  for (let i = 0; i < len; i++) {
    idx += step;
    if (idx < 0) idx = len - 1;
    else if (idx >= len) idx = 0;
    if (isOptionEnabled(opts[idx])) return idx;
  }
  return -1;
}

function firstEnabledIndex(select) {
  for (let i = 0; i < select.options.length; i++) {
    if (isOptionEnabled(select.options[i])) return i;
  }
  return -1;
}

function lastEnabledIndex(select) {
  for (let i = select.options.length - 1; i >= 0; i--) {
    if (isOptionEnabled(select.options[i])) return i;
  }
  return -1;
}

function closeActivePopup(restoreFocus = false) {
  if (!active) return;
  const prev = active;
  active = null;
  prev.wrap.classList.remove('is-open');
  prev.popEl.remove();
  const target = prev.focusBack || prev.select;
  if (restoreFocus && target && document.contains(target)) {
    try { target.focus({ preventScroll: true }); } catch {}
  }
}

export function positionFloatingMenu(anchorEl, popEl, minWidth = 148, maxWidth = 360, capHeight = 320) {
  const rect = anchorEl.getBoundingClientRect();
  const minW = Math.max(rect.width, minWidth);
  popEl.style.minWidth = `${Math.round(minW)}px`;
  popEl.style.maxWidth = `${Math.max(minW, Math.min(maxWidth, window.innerWidth - 16))}px`;
  popEl.style.maxHeight = 'none';

  const popRect = popEl.getBoundingClientRect();
  const naturalH = popRect.height;
  const naturalW = Math.max(minW, popRect.width);
  const gap = 5;
  const spaceBelow = window.innerHeight - rect.bottom - gap - 8;
  const spaceAbove = rect.top - gap - 8;
  const openAbove = spaceBelow < naturalH && spaceAbove > spaceBelow;

  const availH = openAbove ? spaceAbove : spaceBelow;
  const maxH = Math.max(110, Math.min(capHeight, availH));
  popEl.style.maxHeight = `${Math.round(maxH)}px`;

  if (openAbove) {
    popEl.dataset.placement = 'top';
    popEl.style.top = 'auto';
    popEl.style.bottom = `${Math.round(window.innerHeight - rect.top + gap)}px`;
  } else {
    popEl.dataset.placement = 'bottom';
    popEl.style.bottom = 'auto';
    popEl.style.top = `${Math.round(rect.bottom + gap)}px`;
  }

  let left = rect.left;
  if (left + naturalW > window.innerWidth - 8) {
    left = Math.max(8, rect.right - naturalW);
  }
  left = Math.max(8, Math.min(left, window.innerWidth - naturalW - 8));
  popEl.style.left = `${Math.round(left)}px`;
}

function positionPopup(wrap, popEl, variant) {
  const minW = variant === 'compact' || variant === 'ghost' || variant === 'flush' ? 112 : 148;
  positionFloatingMenu(wrap, popEl, minW, 360, 320);
}

function buildPopupOptions(select, popEl) {
  const optionEls = [];
  let optIdx = 0;

  const appendOption = (opt, parent) => {
    const idx = optIdx++;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ts-opt';
    btn.setAttribute('role', 'option');
    btn.tabIndex = -1;
    btn.dataset.idx = String(idx);
    const enabled = isOptionEnabled(opt);
    if (!enabled) {
      btn.disabled = true;
      btn.classList.add('is-disabled');
    }
    if (idx === select.selectedIndex) {
      btn.classList.add('is-selected');
      btn.setAttribute('aria-selected', 'true');
    } else {
      btn.setAttribute('aria-selected', 'false');
    }

    const span = document.createElement('span');
    span.className = 'ts-opt-text';
    span.textContent = opt.textContent.trim();
    btn.append(span);
    btn.insertAdjacentHTML('beforeend', CHECK_SVG);

    btn.addEventListener('pointermove', () => {
      if (active && enabled && active.highlightIdx !== idx) active.setHighlight(idx, false);
    });
    btn.addEventListener('pointerdown', e => {
      e.preventDefault();
    });
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      if (enabled && active) active.commit(idx);
    });

    parent.append(btn);
    optionEls[idx] = btn;
  };

  for (const child of select.children) {
    if (child.tagName === 'OPTGROUP') {
      const grp = document.createElement('div');
      grp.className = 'ts-group-label';
      grp.textContent = child.label || '';
      popEl.append(grp);
      for (const opt of child.children) {
        if (opt.tagName === 'OPTION') appendOption(opt, popEl);
      }
    } else if (child.tagName === 'OPTION') {
      appendOption(child, popEl);
    }
  }

  if (optionEls.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ts-empty';
    empty.textContent = 'No options available';
    popEl.append(empty);
  }
  return optionEls;
}

function openPopup(select) {
  const inst = instances.get(select);
  if (!inst || select.disabled || select.closest('fieldset:disabled')) return;
  if (active && active.select === select) return;
  closeActivePopup(false);
  const popupToken = Symbol('ts');
  window.dispatchEvent(new CustomEvent('trace:close-popups', { detail: popupToken }));

  // Close open menubar or explorer popovers so only one floating menu shows cleanly
  document.querySelectorAll('.menu-pop:not(.hidden), .ctx-menu:not(.hidden)').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.menu-btn[aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'));

  const popEl = document.createElement('div');
  popEl.className = 'ts-pop';
  popEl.setAttribute('role', 'listbox');
  if (inst.variant === 'compact' || inst.variant === 'ghost' || inst.variant === 'flush') {
    popEl.classList.add('ts-pop--compact');
  }

  const optionEls = buildPopupOptions(select, popEl);
  const host = select.closest('dialog[open]') || select.closest('dialog') || document.body;
  popEl.style.visibility = 'hidden';
  host.append(popEl);

  const setHighlight = (idx, scrollIntoView = true) => {
    if (!active) return;
    const prevBtn = active.optionEls[active.highlightIdx];
    if (prevBtn) prevBtn.classList.remove('is-highlighted');
    active.highlightIdx = idx;
    const nextBtn = active.optionEls[idx];
    if (nextBtn) {
      nextBtn.classList.add('is-highlighted');
      if (scrollIntoView) {
        const pr = popEl.getBoundingClientRect();
        const br = nextBtn.getBoundingClientRect();
        if (br.top < pr.top + 4) popEl.scrollTop -= (pr.top + 4 - br.top);
        else if (br.bottom > pr.bottom - 4) popEl.scrollTop += (br.bottom - (pr.bottom - 4));
      }
    }
  };

  const commit = idx => {
    const targetOpt = select.options[idx];
    if (!targetOpt || !isOptionEnabled(targetOpt)) return;
    const changed = select.selectedIndex !== idx;
    select.selectedIndex = idx;
    syncTrigger(select);
    closeActivePopup(true);
    if (changed) {
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  const initIdx = isOptionEnabled(select.options[select.selectedIndex])
    ? select.selectedIndex
    : firstEnabledIndex(select);

  active = { token: popupToken, select, wrap: inst.wrap, popEl, optionEls, highlightIdx: initIdx, openedAt: performance.now(), setHighlight, commit };
  inst.wrap.classList.add('is-open');

  positionPopup(inst.wrap, popEl, inst.variant);
  popEl.style.visibility = '';
  if (initIdx >= 0) setHighlight(initIdx, true);
  requestAnimationFrame(() => popEl.classList.add('is-visible'));
}

function togglePopup(select) {
  if (active && active.select === select) closeActivePopup(true);
  else openPopup(select);
}

function hookSelectProperties(select) {
  if (VALUE_DESC?.get && VALUE_DESC?.set) {
    Object.defineProperty(select, 'value', {
      configurable: true,
      get() { return VALUE_DESC.get.call(this); },
      set(val) {
        VALUE_DESC.set.call(this, val);
        syncTrigger(this);
        if (active && active.select === this) active.setHighlight(this.selectedIndex, false);
      },
    });
  }
  if (INDEX_DESC?.get && INDEX_DESC?.set) {
    Object.defineProperty(select, 'selectedIndex', {
      configurable: true,
      get() { return INDEX_DESC.get.call(this); },
      set(idx) {
        INDEX_DESC.set.call(this, idx);
        syncTrigger(this);
        if (active && active.select === this) active.setHighlight(this.selectedIndex, false);
      },
    });
  }
}

export function upgradeSelect(select) {
  if (!select || select.tagName !== 'SELECT' || select.dataset.tsUpgraded === '1') return;
  select.dataset.tsUpgraded = '1';

  const variant = detectVariant(select);
  const wrap = document.createElement('span');
  wrap.className = `ts-wrap ts-wrap--${variant}`;

  const trigger = document.createElement('span');
  trigger.className = 'ts-trigger';
  trigger.setAttribute('aria-hidden', 'true');

  const labelEl = document.createElement('span');
  labelEl.className = 'ts-label';
  trigger.append(labelEl);
  trigger.insertAdjacentHTML('beforeend', CHEV_SVG);

  select.before(wrap);
  wrap.append(trigger, select);
  select.classList.add('ts-native');

  instances.set(select, { wrap, trigger, labelEl, variant });
  hookSelectProperties(select);
  syncTrigger(select);

  let handledPointerDown = false;

  select.addEventListener('mousedown', e => {
    if (e.button !== 0 || select.disabled || select.closest('fieldset:disabled')) return;
    e.preventDefault();
    try { select.focus({ preventScroll: true }); } catch {}
    handledPointerDown = true;
    window.addEventListener('pointerup', () => setTimeout(() => { handledPointerDown = false; }, 0), { once: true });
    togglePopup(select);
  });

  select.addEventListener('click', e => {
    if (handledPointerDown) {
      handledPointerDown = false;
      e.preventDefault();
      return;
    }
    if (select.disabled || select.closest('fieldset:disabled')) return;
    e.preventDefault();
    try { select.focus({ preventScroll: true }); } catch {}
    togglePopup(select);
  });

  select.addEventListener('change', () => syncTrigger(select));
  select.addEventListener('input', () => syncTrigger(select));

  select.addEventListener('keydown', e => {
    const isOpen = Boolean(active && active.select === select);
    if (!isOpen) {
      if (e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'F4' || (e.altKey && e.key === 'ArrowDown')) {
        e.preventDefault();
        openPopup(select);
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = nextEnabledIndex(select, active.highlightIdx, 1);
      if (next >= 0) active.setHighlight(next, true);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = nextEnabledIndex(select, active.highlightIdx, -1);
      if (prev >= 0) active.setHighlight(prev, true);
    } else if (e.key === 'Home') {
      e.preventDefault();
      const first = firstEnabledIndex(select);
      if (first >= 0) active.setHighlight(first, true);
    } else if (e.key === 'End') {
      e.preventDefault();
      const last = lastEnabledIndex(select);
      if (last >= 0) active.setHighlight(last, true);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      const idx = active.highlightIdx >= 0 ? active.highlightIdx : select.selectedIndex;
      if (idx >= 0) active.commit(idx);
      else closeActivePopup(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeActivePopup(true);
    } else if (e.key === 'Tab') {
      closeActivePopup(false);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      clearTimeout(typeTimer);
      typeBuffer += e.key.toLowerCase();
      typeTimer = setTimeout(() => { typeBuffer = ''; }, 550);
      const opts = select.options;
      const start = Math.max(0, active.highlightIdx + (typeBuffer.length === 1 ? 1 : 0));
      for (let step = 0; step < opts.length; step++) {
        const idx = (start + step) % opts.length;
        if (isOptionEnabled(opts[idx]) && opts[idx].textContent.trim().toLowerCase().startsWith(typeBuffer)) {
          active.setHighlight(idx, true);
          break;
        }
      }
    }
  });

  const obs = new MutationObserver(() => {
    syncTrigger(select);
    if (active && active.select === select) {
      const sel = select;
      closeActivePopup(false);
      openPopup(sel);
    }
  });
  obs.observe(select, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['disabled', 'hidden', 'class', 'label', 'title'],
  });
}

let globalWired = false;
function wireGlobalHandlers() {
  if (globalWired) return;
  globalWired = true;

  window.addEventListener('trace:close-popups', e => {
    if (active && e.detail !== active.token) closeActivePopup(false);
  });

  document.addEventListener('pointerdown', e => {
    if (!active) return;
    if (active.wrap.contains(e.target) || active.popEl.contains(e.target)) return;
    closeActivePopup(false);
  }, true);

  document.addEventListener('keydown', e => {
    if (!active) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeActivePopup(true);
    }
  }, true);

  document.addEventListener('cancel', e => {
    if (!active) return;
    e.preventDefault();
    closeActivePopup(true);
  }, true);

  document.addEventListener('scroll', e => {
    if (!active) return;
    if (active.popEl.contains(e.target)) return;
    if (performance.now() - active.openedAt < 80) return;
    closeActivePopup(false);
  }, true);

  window.addEventListener('resize', () => closeActivePopup(false));
  window.addEventListener('blur', () => closeActivePopup(false));

  const domObs = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.tagName === 'SELECT') upgradeSelect(node);
        else node.querySelectorAll?.('select:not([data-ts-upgraded="1"])').forEach(upgradeSelect);
      }
    }
  });
  domObs.observe(document.body, { childList: true, subtree: true });
}

export function initCustomSelects(root = document) {
  wireGlobalHandlers();
  root.querySelectorAll('select:not([data-ts-upgraded="1"])').forEach(upgradeSelect);
}

export function refreshAllCustomSelects(root = document) {
  root.querySelectorAll('select[data-ts-upgraded="1"]').forEach(syncTrigger);
}

export function createPinChevronSvg() {
  return CHEV_SVG;
}

export function openPinPickerPopup({ anchorWrap, focusInput, groups, currentPin, assignments, portName, onPick }) {
  if (active && active.wrap === anchorWrap) {
    closeActivePopup(true);
    return;
  }
  closeActivePopup(false);
  const popupToken = Symbol('pin');
  window.dispatchEvent(new CustomEvent('trace:close-popups', { detail: popupToken }));
  document.querySelectorAll('.menu-pop:not(.hidden), .ctx-menu:not(.hidden)').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.menu-btn[aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'));

  const popEl = document.createElement('div');
  popEl.className = 'ts-pop pin-pop';
  popEl.setAttribute('role', 'listbox');

  const optionEls = [];
  let selectedBtnIdx = -1;

  const addOptionRow = ({ pinVal, pinText, netText, metaText, isSelected, ownerPort }) => {
    const idx = optionEls.length;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ts-opt pin-pop-opt';
    btn.setAttribute('role', 'option');
    btn.tabIndex = -1;
    if (isSelected) {
      btn.classList.add('is-selected');
      btn.setAttribute('aria-selected', 'true');
      selectedBtnIdx = idx;
    } else {
      btn.setAttribute('aria-selected', 'false');
    }

    const left = document.createElement('span');
    left.className = 'pin-pop-left';
    const pinBadge = document.createElement('span');
    pinBadge.className = 'pin-pop-code mono';
    pinBadge.textContent = pinText;
    const netLabel = document.createElement('span');
    netLabel.className = 'pin-pop-net';
    netLabel.textContent = netText;
    left.append(pinBadge, netLabel);

    const right = document.createElement('span');
    right.className = 'pin-pop-right';
    if (ownerPort) {
      const used = document.createElement('span');
      used.className = 'pin-pop-used mono';
      used.textContent = ownerPort;
      right.append(used);
    } else if (metaText) {
      const note = document.createElement('span');
      note.className = 'pin-pop-meta';
      note.textContent = metaText;
      right.append(note);
    }
    btn.append(left, right);
    btn.insertAdjacentHTML('beforeend', CHECK_SVG);

    btn.addEventListener('pointerdown', e => e.preventDefault());
    btn.addEventListener('pointermove', () => {
      if (active && active.highlightIdx !== idx) active.setHighlight(idx, false);
    });
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      closeActivePopup(false);
      onPick(pinVal);
    });

    popEl.append(btn);
    optionEls.push(btn);
  };

  if (currentPin !== null) {
    addOptionRow({
      pinVal: '',
      pinText: 'CLEAR',
      netText: 'Unassign pin',
      metaText: '',
      isSelected: false,
      ownerPort: '',
    });
  }

  for (const grp of groups) {
    const hdr = document.createElement('div');
    hdr.className = 'ts-group-label';
    hdr.textContent = grp.group;
    popEl.append(hdr);
    for (const p of grp.pins) {
      const owner = (assignments?.get(p.pin) || '').trim().toLowerCase();
      const usedElsewhere = owner && owner !== portName ? owner : '';
      addOptionRow({
        pinVal: `PIN_${p.pin}`,
        pinText: `PIN_${p.pin}`,
        netText: p.net,
        metaText: p.polarity,
        isSelected: currentPin === p.pin,
        ownerPort: usedElsewhere,
      });
    }
  }

  popEl.style.visibility = 'hidden';
  document.body.append(popEl);

  const setHighlight = (idx, scrollIntoView = true) => {
    if (!active) return;
    const prevBtn = active.optionEls[active.highlightIdx];
    if (prevBtn) prevBtn.classList.remove('is-highlighted');
    active.highlightIdx = idx;
    const nextBtn = active.optionEls[idx];
    if (nextBtn) {
      nextBtn.classList.add('is-highlighted');
      if (scrollIntoView) {
        const pr = popEl.getBoundingClientRect();
        const br = nextBtn.getBoundingClientRect();
        if (br.top < pr.top + 4) popEl.scrollTop -= (pr.top + 4 - br.top);
        else if (br.bottom > pr.bottom - 4) popEl.scrollTop += (br.bottom - (pr.bottom - 4));
      }
    }
  };

  active = {
    token: popupToken,
    select: null,
    focusBack: focusInput || anchorWrap,
    wrap: anchorWrap,
    popEl,
    optionEls,
    highlightIdx: selectedBtnIdx,
    openedAt: performance.now(),
    setHighlight,
    commit: () => {},
  };
  anchorWrap.classList.add('is-open');
  positionFloatingMenu(anchorWrap, popEl, 250, 340, 310);
  popEl.style.visibility = '';
  if (selectedBtnIdx >= 0) setHighlight(selectedBtnIdx, true);
  requestAnimationFrame(() => popEl.classList.add('is-visible'));
}
