import { createBoard3D } from './board/board3d.js';
import { NET_PIN, PIN_NET, LED_NETS, KEY_NETS, SEG_NETS, DIGIT_NETS, BOARD_PINOUT_GROUPS } from './board/boardDef.js';
import { parseQsf } from './sim/qsf.js';
import { parseGenerics } from './sim/generics.js';
import { UartReceiver } from './sim/uart.js';
import { inspectBitstream } from './sim/sof.js';
import { parseVcd } from './sim/vcd.js';
import { fmtTime } from './sim/types.js';
import { WaveViewer } from './ui/waves.js';
import { DEMO_SRC, DEMO_NAME, DEMO_TOP } from './ui/demo.js';
import { createIde, parseDiagnostics } from './ui/ide.js';
import * as audio from './ui/audio.js';
import { initCustomSelects } from './ui/selects.js';
import {
  THEME_PRESETS,
  TOKEN_GROUPS,
  DEFAULT_SETTINGS,
  normalizeThemeId,
  findThemePreset,
  getAllThemes,
  resolveThemeSpec,
  normalizeCssHex,
  applyThemeToDocument,
  loadStoredSettings,
  saveStoredSettings,
  loadStoredCustomThemes,
  saveStoredCustomThemes,
} from './ui/themes.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const S = { sources: [], sim: null, flashed: false, compiledHash: '', flashedHash: '', projectDir: null, projectName: '', running: false, power: true, building: false, busy: false, clkHz: 50000000, speed: 55, time: 0, inputs: {}, assignments: new Map(), compiledAssignments: new Map(), discoveredPorts: [], bindings: {}, values: new Map(), pending: [], generation: 0, cycles: 0, vcd: null, standard: '93', generics: {}, topLibrary: 'work', dirty: false, error: false, importing: false, truthBusy: false, exporting: false, keys: {}, dip: 0, waveMode: 'fit', followZoomFactor: 1 };
let board, waves, ide, toastTimer, sourceIndex, consoleCount = 0, logFile = '', actionLogFile = '', currentHdlRoot = '', reportCount = 0;
let lastFrame = performance.now(), accumulator = 0, wallTimeAccum = 0, lastDraw = 0;
let actionSeq = 0, lastErrorSeq = 0, lastErrorMsg = '', actionFlushTimer = 0, eventFlushTimer = 0, stateFlushTimer = 0;
let manualStepping = false, lastWaveLockToast = 0;
const uart = new UartReceiver();
const reported = new Map();
const uiActions = [], pendingActions = [], pendingEvents = [];
let pendingStatePatch = null;
let appSettings = loadStoredSettings();
let customThemes = loadStoredCustomThemes();
let projectWaveModes = {};
try { projectWaveModes = JSON.parse(localStorage.getItem('trace.projectWaveModes.v1') || '{}') || {}; } catch { projectWaveModes = {}; }
let activeThemeId = normalizeThemeId(document.documentElement.dataset.theme) || 'trace-dark';
let customDraft = null;

function flushState(useBeacon = false) {
  if (!pendingStatePatch) return;
  const patch = pendingStatePatch;
  pendingStatePatch = null;
  const body = JSON.stringify(patch);
  if (useBeacon && navigator.sendBeacon) {
    try { navigator.sendBeacon('/api/state', new Blob([body], { type: 'application/json' })); return; } catch {}
  }
  try { fetch('/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => {}); } catch {}
}
function persistAppState(patch) {
  if (!patch || typeof patch !== 'object') return;
  pendingStatePatch = pendingStatePatch ? { ...pendingStatePatch, ...patch } : { ...patch };
  clearTimeout(stateFlushTimer);
  stateFlushTimer = setTimeout(() => flushState(false), 100);
}
function flushEvents(useBeacon = false) {
  if (!pendingEvents.length) return;
  const events = pendingEvents.splice(0, 50);
  const body = JSON.stringify({ events });
  if (useBeacon && navigator.sendBeacon) {
    try { navigator.sendBeacon('/api/log/event', new Blob([body], { type: 'application/json' })); return; } catch {}
  }
  try { fetch('/api/log/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => {}); } catch {}
  if (pendingEvents.length) {
    clearTimeout(eventFlushTimer);
    eventFlushTimer = setTimeout(() => flushEvents(false), 180);
  }
}
function recordLogEvent(level, message) {
  pendingEvents.push({ level, message: String(message), simTime: fmtTime(S.time) });
  clearTimeout(eventFlushTimer);
  eventFlushTimer = setTimeout(() => flushEvents(false), 180);
}
function flushActions(useBeacon = false) {
  if (!pendingActions.length) return;
  const lines = pendingActions.splice(0, 50);
  const body = JSON.stringify({ lines });
  if (useBeacon && navigator.sendBeacon) {
    try { navigator.sendBeacon('/api/log/action', new Blob([body], { type: 'application/json' })); return; } catch {}
  }
  try { fetch('/api/log/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => {}); } catch {}
  if (pendingActions.length) {
    clearTimeout(actionFlushTimer);
    actionFlushTimer = setTimeout(() => flushActions(false), 180);
  }
}
function recordActionLine(line) {
  uiActions.push(line);
  if (uiActions.length > 60) uiActions.shift();
  pendingActions.push(line);
  clearTimeout(actionFlushTimer);
  actionFlushTimer = setTimeout(() => flushActions(false), 180);
}
function toast(message, kind = '') { const el = $('#toast'); el.textContent = message; el.className = `toast ${kind}`; clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 4500); if (kind === 'err') { lastErrorSeq++; lastErrorMsg = String(message); report(message); } }
function log(message, severity = 'info', stack = '') {
  const row = document.createElement('div'); row.className = `console-line ${severity}`; row.dataset.severity = severity; row.dataset.clock = new Date().toTimeString().slice(0, 8);
  const time = document.createElement('span'); time.className = 'ct'; time.textContent = fmtTime(S.time);
  const text = document.createElement('span'); text.textContent = message; row.append(time, text);
  $('#consoleOut').append(row); while ($('#consoleOut').children.length > 500) $('#consoleOut').firstChild.remove();
  $('#consoleCount').textContent = ++consoleCount; $('#consoleOut').scrollTop = $('#consoleOut').scrollHeight;
  if (severity === 'error') { lastErrorSeq++; lastErrorMsg = String(message); report(message, stack); }
  else recordLogEvent(severity, message);
}
function consoleLines() {
  return [...$('#consoleOut').children].map(row => {
    const [time, text] = row.children;
    return `[${row.dataset.clock}] [${time.textContent}] ${row.dataset.severity.toUpperCase()} ${text.textContent.replace(/\n/g, '\n    ')}`;
  });
}
function sessionDetails() {
  return {
    Page: location.href,
    Design: S.sources.map(s => s.name).join(', ') || 'none',
    Top: S.sim?.top || $('#topSelect').value || 'auto-detect',
    Language: $('#standardSelect').selectedOptions[0]?.textContent || S.standard,
    Status: $('#statusPill').textContent,
    'Sim time': fmtTime(S.time),
    Backend: S.sim?.backend || 'none',
    Theme: document.documentElement.dataset.theme || 'light',
    Viewport: `${innerWidth}x${innerHeight}`,
    Browser: navigator.userAgent
  };
}
function report(message, stack = '') {
  const now = Date.now(), key = String(message);
  if (now - (reported.get(key) || 0) < 3000 || reportCount >= 200) return;
  reported.set(key, now); reportCount++;
  flushActions();
  setTimeout(() => { try { fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: key, stack: stack || '', details: sessionDetails(), recent: consoleLines().slice(-20), actions: uiActions.slice(-25) }) }).catch(() => {}); } catch {} });
}
function describeControl(el) {
  if (!el || !el.tagName || el === document.body || el === document.documentElement) return 'window';
  let sel = el.tagName.toLowerCase();
  if (el.id) sel = `#${el.id}`;
  else {
    for (const attr of ['data-cmd', 'data-key', 'data-dip', 'data-ltab', 'data-rtab', 'data-docktab', 'data-camera', 'data-tool', 'data-nav', 'data-starter', 'data-menu', 'data-pmtab', 'data-pm-aspect', 'data-close', 'data-gfx', 'aria-label']) {
      if (el.hasAttribute?.(attr)) { sel = `[${attr}="${el.getAttribute(attr)}"]`; break; }
    }
    if (sel === el.tagName.toLowerCase()) {
      const tab = el.closest?.('.doc-tab');
      if (tab?.dataset.file) sel = `.doc-tab(${tab.dataset.file})${el.classList.contains('doc-tab-x') ? '×' : ''}`;
      else if (el.className && typeof el.className === 'string') sel += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    }
  }
  const textFallback = ['FORM', 'SELECT'].includes(el.tagName) ? '' : el.textContent;
  const rawLabel = (el.getAttribute?.('aria-label') || el.getAttribute?.('title') || textFallback || '').replace(/\s+/g, ' ').trim().slice(0, 42);
  return rawLabel ? `${sel} "${rawLabel}"` : sel;
}
const SEG_GLYPHS = { 0x3f: '0', 0x06: '1', 0x5b: '2', 0x4f: '3', 0x66: '4', 0x6d: '5', 0x7d: '6', 0x07: '7', 0x7f: '8', 0x6f: '9', 0x77: 'A', 0x7c: 'b', 0x39: 'C', 0x5e: 'd', 0x79: 'E', 0x71: 'F', 0x40: '-' };
function currentDisplayText() {
  if (!S.power || !board?.displayState) return 'off';
  let anyLit = false;
  const out = board.displayState.map(d => {
    if (!d.enabled) return '_';
    const segs = d.segs;
    const mask = segs & 0x7f;
    if (!mask && !(segs & 0x80)) return '_';
    anyLit = true;
    return (SEG_GLYPHS[mask] || (mask ? '?' : '_')) + ((segs & 0x80) ? '.' : '');
  }).join('');
  return anyLit ? out : 'off';
}
function uiSnapshot() {
  const leftOpen = $('#left') && getComputedStyle($('#left')).display !== 'none';
  return {
    view: $('#homeView') && !$('#homeView').classList.contains('hidden') ? 'home' : $('#center')?.classList.contains('photo-mode') ? 'photo' : 'workbench',
    status: $('#statusPill')?.textContent || '',
    top: S.sim?.top || $('#topSelect')?.value || 'none',
    time: fmtTime(S.time),
    cycles: S.cycles,
    timeCap: (!S.vcd && S.sim && S.flashed && !S.sim.ended && remainingSimCycles() <= 0) ? '9s-limit' : 'ok',
    files: S.sources.map(s => s.name).join(',') || 'none',
    tabs: ide?.tabs?.join(',') || 'none',
    tab: ide?.active || 'none',
    editor: $('#sourceDialog')?.open ? 'open' : 'closed',
    board: $('#ideMain')?.classList.contains('board-closed') ? 'closed' : 'open',
    left: !leftOpen ? 'closed' : ($('#ltab-pins')?.classList.contains('active') ? 'pins' : 'library'),
    hdlOpen: $$('#hdlTree .hdl-group.open').length,
    hdlRoot: currentHdlRoot || 'none',
    waves: $('#app')?.classList.contains('no-waves') ? 'hidden' : 'open',
    right: $('#right')?.classList.contains('hidden') ? 'closed' : ($$('.dock-tab.active')[0]?.dataset.docktab || 'open'),
    deck: $('#deck')?.classList.contains('hidden') ? 'closed' : 'open',
    about: $('#aboutDialog')?.open ? 'open' : 'closed',
    keysDlg: $('#keysDialog')?.open ? 'open' : 'closed',
    homeDlg: $('#homeConfirmDialog')?.open ? 'open' : 'closed',
    newProjDlg: $('#newProjectDialog')?.open ? 'open' : 'closed',
    projDlg: $('#projectSettingsDialog')?.open ? 'open' : 'closed',
    switchDlg: $('#projectSwitchDialog')?.open ? 'open' : 'closed',
    menu: $$('.menu-btn[aria-expanded="true"]')[0]?.dataset.menu || 'closed',
    theme: document.documentElement.dataset.theme || 'light',
    power: S.power ? 'on' : 'off',
    dip: '0x' + S.dip.toString(16),
    keys: Object.entries(S.keys).filter(([, v]) => v).map(([k]) => k).join(',') || 'none',
    downKeys: $$('.key-btn.down').map(b => b.dataset.key).join(',') || 'none',
    leds: [0, 1, 2, 3].filter(i => $(`[data-led="${i}"]`)?.classList.contains('on')).map(i => i + 1).join(',') || 'off',
    seg: currentDisplayText(),
    cam: $('#camPreset')?.value || 'hero',
    tool: board?.toolMode || 'interact',
    nav: board?.navMode || 'orbit',
    part: board?.selectedPart?.id || 'none',
    clkHz: S.clkHz,
    std: $('#standardSelect')?.value || S.standard,
    truthRows: $('#truthBody')?.children.length || 0,
    uartLen: $('#uartOut')?.textContent.length || 0,
    recents: $('#homeRecentList')?.querySelectorAll('.home-recent-item').length || 0,
    problems: ide?.problems?.length || 0,
    newFile: $('#newFileRow')?.classList.contains('hidden') ? 'closed' : 'open',
    consoleCount,
    error: S.error,
    errSeq: lastErrorSeq,
  };
}
function diffSnapshot(before, after) {
  const keys = ['view', 'status', 'top', 'time', 'cycles', 'timeCap', 'files', 'tabs', 'tab', 'editor', 'board', 'left', 'hdlOpen', 'hdlRoot', 'waves', 'right', 'deck', 'about', 'keysDlg', 'homeDlg', 'newProjDlg', 'projDlg', 'switchDlg', 'menu', 'theme', 'power', 'dip', 'keys', 'downKeys', 'leds', 'seg', 'cam', 'tool', 'nav', 'part', 'clkHz', 'std', 'truthRows', 'uartLen', 'recents', 'problems', 'newFile'];
  const out = [];
  for (const k of keys) if (before[k] !== after[k]) out.push(`${k}:${before[k]}->${after[k]}`);
  return out;
}
function trackUiAction(kind, el, detail = '') {
  const id = String(++actionSeq).padStart(4, '0');
  const target = detail ? `${describeControl(el)} (${detail})` : describeControl(el);
  const before = uiSnapshot();
  const t0 = performance.now();
  const isDisabled = !!(el?.disabled || el?.closest?.('[disabled]'));
  if (isDisabled) {
    recordActionLine(`#${id} ${kind.padEnd(8)} ${target} -> BLOCKED (0ms) [reason:control disabled | status:${before.status} | view:${before.view}]`);
    return;
  }
  const IMPERATIVE = /^(#btnShot|#pmShutterBtn|#pmCopyBtn|#consoleCopy|#btnTruthCopy|#btnTruthExport|#saveFileBtn|#btnRefreshExplorer|#homeConfirmSave|#psSave|#btnVcd|#dropZone|#btnQsf|#progDrop|#homeOpenBtn|#homeOpenProjectBtn|#btnChangeHdlRoot|#homeChangeHdlRoot|#waveZoomIn|#waveZoomOut|#waveModeGroup|#btnResetView|#btnCenterComp|#ciCenter|#ciPins|#btnOpenPinoutRef|#btnLedView|#btnResetGfx|#pmResetFxBtn)\b/;
  setTimeout(async () => {
    await new Promise(r => requestAnimationFrame(r));
    const waitStart = performance.now();
    while ((S.building || S.importing || S.exporting || (!S.running && S.busy) || S.truthBusy) && performance.now() - waitStart < 12000) {
      await new Promise(r => setTimeout(r, 30));
    }
    const ms = Math.round(performance.now() - t0);
    const after = uiSnapshot();
    const changes = diffSnapshot(before, after);
    let outcome = 'OK';
    if (after.errSeq > before.errSeq || (!before.error && after.error)) {
      outcome = 'ERR';
      changes.push(`err=${JSON.stringify(lastErrorMsg.replace(/\s+/g, ' ').slice(0, 140))}`);
    } else if (!changes.length) {
      if (IMPERATIVE.test(target) || el?.tagName === 'SUMMARY' || el?.tagName === 'INPUT' || el?.tagName === 'SELECT' || kind === 'CHANGE') {
        changes.push('executed');
      } else if (after.consoleCount > before.consoleCount) {
        changes.push(`console:${before.consoleCount}->${after.consoleCount}`);
      } else {
        outcome = 'NOOP';
        changes.push(`no state change | status:${after.status} | view:${after.view}`);
      }
    }
    recordActionLine(`#${id} ${kind.padEnd(8)} ${target} -> ${outcome} (${ms}ms) [${changes.join(' | ')}]`);
  }, 0);
}
function wireActionLogger() {
  document.addEventListener('pointerdown', e => {
    const keyBtn = e.target.closest?.('.key-btn');
    if (keyBtn) trackUiAction('PRESS', keyBtn);
  }, true);
  for (const ev of ['pointerup', 'pointercancel']) {
    document.addEventListener(ev, e => {
      const keyBtn = e.target.closest?.('.key-btn');
      if (!keyBtn) return;
      const net = keyBtn.dataset.key === 'reset' ? 'reset_btn' : keyBtn.dataset.key.replace('key', 's');
      if (S.keys[net]) trackUiAction('RELEASE', keyBtn);
    }, true);
  }
  let dispatchingClick = false;
  document.addEventListener('click', e => {
    if (!e.isTrusted || dispatchingClick || e.target.closest?.('.key-btn')) return;
    const ctrl = e.target.closest?.('button, a, summary, [role="tab"], [role="button"]');
    if (ctrl) {
      dispatchingClick = true;
      queueMicrotask(() => { dispatchingClick = false; });
      trackUiAction('CLICK', ctrl);
    }
  }, true);
  document.addEventListener('change', e => {
    const el = e.target;
    if (!el || el.id === 'sourceEditor' || el.classList?.contains('ce-input')) return;
    if (el.matches?.('select, input')) {
      const val = el.type === 'checkbox' ? (el.checked ? 'checked' : 'unchecked') : el.type === 'file' ? `${el.files?.length || 0} files` : String(el.value).slice(0, 32);
      trackUiAction('CHANGE', el, `val=${val}`);
    }
  }, true);
  document.addEventListener('submit', e => {
    if (e.target?.tagName === 'FORM') trackUiAction('SUBMIT', e.target);
  }, true);
  window.addEventListener('keydown', e => {
    if (e.repeat) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.altKey && ['s', 'n'].includes(e.key.toLowerCase())) {
      trackUiAction('SHORTCUT', document.activeElement, `Ctrl+Alt+${e.key.toUpperCase()}`);
      return;
    }
    if (mod && !e.altKey && ['b', 's', 'e', 'o'].includes(e.key.toLowerCase())) {
      trackUiAction('SHORTCUT', document.activeElement, `Ctrl+${e.shiftKey ? 'Shift+' : ''}${e.key.toUpperCase()}`);
      return;
    }
    if (!mod && !e.altKey && !e.shiftKey && e.key === 'F7') {
      trackUiAction('SHORTCUT', document.activeElement, 'F7');
      return;
    }
    if (e.target.closest?.('input,select,textarea,dialog:modal')) return;
    if (e.altKey && ['1', '2', '3', '4'].includes(e.key)) { trackUiAction('SHORTCUT', document.activeElement, `Alt+${e.key}`); return; }
    if (!mod && !e.altKey && ['1', '2', '3', '4', 'r', 'f', 'v', 'p', 'h', '.', 'escape'].includes(e.key.toLowerCase())) {
      trackUiAction('SHORTCUT', document.activeElement, e.key.length === 1 ? e.key.toUpperCase() : e.key);
    } else if (!mod && !e.altKey && e.code === 'Space' && e.target.tagName !== 'BUTTON') {
      trackUiAction('SHORTCUT', document.activeElement, 'Space');
    }
  }, true);
}
async function copyConsole() {
  const lines = consoleLines(), details = sessionDetails();
  const text = ['Trace FPGA workbench console report', `Copied: ${new Date().toString()}`, ...Object.entries(details).map(([key, value]) => `${key}: ${value}`), `Error log: ${logFile || 'logs\\latest.log in the Trace folder'}`, '', `Console (${lines.length} events, oldest first):`, ...(lines.length ? lines : ['(empty)'])].join('\n');
  try { await navigator.clipboard.writeText(text); }
  catch {
    const area = Object.assign(document.createElement('textarea'), { value: text }); area.setAttribute('readonly', ''); area.style.cssText = 'position:fixed;opacity:0';
    document.body.append(area); area.select(); const copied = document.execCommand('copy'); area.remove();
    if (!copied) return toast('Copy was blocked by the browser. Select the console text and press Ctrl+C.', 'err');
  }
  const button = $('#consoleCopy'); button.textContent = 'Copied'; clearTimeout(button.resetTimer); button.resetTimer = setTimeout(() => { button.textContent = 'Copy'; }, 1600);
  toast(`Copied ${lines.length} console ${lines.length === 1 ? 'event' : 'events'} with session details.`);
}
addEventListener('error', event => { if (!/^ResizeObserver loop/.test(event.message)) log(`Uncaught error: ${event.message.replace(/^Uncaught /, '')}${event.filename ? ` (${event.filename.replace(location.origin, '')}:${event.lineno}:${event.colno})` : ''}`, 'error', event.error?.stack); });
addEventListener('unhandledrejection', event => log(`Unhandled promise rejection: ${event.reason?.message ?? event.reason}`, 'error', event.reason?.stack));
async function api(url, body, method = 'POST') {
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`); return result;
}
function setStatus() {
  const atTimeLimit = !S.vcd && S.sim && S.flashed && !S.sim.ended && !S.dirty && !S.error && remainingSimCycles() <= 0;
  const name = S.building ? 'Compiling' : S.error ? 'Error' : !S.power ? 'Power off' : S.dirty ? 'Build needed' : S.sim && !S.flashed && !S.vcd ? 'Ready to flash' : S.sim?.ended ? 'Complete' : atTimeLimit ? 'Time limit' : S.running ? 'Running' : S.sim && (S.flashed || S.vcd) ? 'Paused' : 'No design';
  $('#statusPill').className = `status-pill ${name.toLowerCase().replaceAll(' ', '-')}`; $('#statusPill').textContent = name;
  if (atTimeLimit && $('#inputHint')) $('#inputHint').textContent = 'Reached simulation time limit — click Restart (↻) to continue from 0 ns';
  $('#btnRun').classList.toggle('running', S.running); $('#runLabel').textContent = S.running ? 'Pause' : 'Run';
  $('#btnRun').setAttribute('aria-label', S.running ? 'Pause simulation' : 'Run simulation');
  const locked = S.building || S.importing || S.exporting;
  for (const input of $$('#pinBody input, #sdfControls input, #sdfControls select, .src-name, .src-x')) input.disabled = locked;
  $('#btnRun').disabled = $('#btnStep').disabled = locked || !S.power || !S.sim || (!S.flashed && !S.vcd) || S.sim.ended || S.dirty || S.error;
  $('#btnElab').disabled = locked;
  $('#btnReset').disabled = locked || !S.sim || (!S.flashed && !S.vcd) || S.dirty;
  if ($('#btnFlash')) $('#btnFlash').disabled = locked || !S.sim || !!S.vcd || S.dirty || S.error;
  $('#btnVcd').disabled = locked || !S.sim || (!S.flashed && !S.vcd);
  for (const id of ['btnDemo', 'dropZone', 'btnQsf', 'topSelect', 'standardSelect', 'topLibrary', 'genericInput', 'pwrToggle', 'btnPinReset', 'clearSdf', 'saveFileBtn', 'saveSource', 'progDrop', 'replayScope']) {
    const el = $('#' + id);
    if (el) el.disabled = locked;
  }
  $('#btnTruth').disabled = locked || S.truthBusy || !S.sim || !!S.vcd || S.dirty || S.error;
  for (const input of $$('#virtualInputs input')) input.disabled = locked || S.dirty || S.error || !S.power || !S.sim || !S.flashed || S.sim.ended || !!S.vcd;
  $('#clkHz').disabled = !!S.vcd;
  $('#btnStep').title = S.vcd ? 'Next recorded timestamp (.)' : 'One clock cycle (.)';
  $('#btnVcd').textContent = S.vcd || S.sim?.ended ? 'Export VCD ↗' : 'Finish & export ↗';
  syncKeys();
}
function pause() {
  S.running = false; accumulator = 0; wallTimeAccum = 0; clearMuxDisplayState(); resetBuzzerTracker(false); sampleOutputs(); setStatus();
  if (waves && !$('#app')?.classList.contains('no-waves')) {
    waves.draw();
  }
}
function fail(e) { S.error = true; S.pending = []; pause(); log(e.message, 'error'); toast(e.message, 'err'); ide?.reportBuildFailure(e.message); openTools('console'); }
function fnvHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
function computeCompileFingerprint() {
  const srcs = [...S.sources]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(s => `${s.name}\0${s.library || 'work'}\0${s.text}`)
    .join('\x1e');
  const top = ($('#topSelect')?.value || '').trim().toLowerCase();
  const topLib = ($('#topLibrary')?.value || S.topLibrary || 'work').trim().toLowerCase();
  const std = $('#standardSelect')?.value || S.standard || '93';
  const gen = ($('#genericInput')?.value || '').trim();
  const sdfSig = S.sdf ? `${S.sdf.name}|${$('#sdfInstance')?.value || S.sdf.instance || ''}|${$('#sdfCorner')?.value || S.sdf.corner || ''}|${S.sdf.text}` : '';
  return fnvHash(`${std}\0${topLib}\0${top}\0${gen}\0${sdfSig}\0${srcs}`);
}
function computeFlashFingerprint() {
  const pins = [...S.assignments.entries()]
    .filter(([, v]) => v && v.trim())
    .sort((a, b) => a[0] - b[0])
    .map(([p, v]) => `${p}=${v.trim().toLowerCase()}`)
    .join(',');
  return fnvHash(`${computeCompileFingerprint()}\0${pins}`);
}
function markDirty() { S.dirty = true; S.flashed = false; S.compiledHash = ''; S.flashedHash = ''; S.error = false; S.pending = []; S.bindings = {}; ++S.generation; board?.clearOutputs(); sampleOutputs(); pause(); saveProject(); }
function projectData() {
  ide?.commitAll();
  return {
    format: 'trace-project',
    version: 1,
    sources: S.sources,
    assignments: [...S.assignments],
    top: $('#topSelect').value,
    topLibrary: $('#topLibrary').value,
    standard: $('#standardSelect').value,
    clkHz: S.clkHz,
    generics: $('#genericInput').value,
    sdf: S.sdf ? { ...S.sdf, instance: $('#sdfInstance').value, corner: $('#sdfCorner').value } : null,
    projectDir: S.projectDir || null,
    projectName: S.projectName || '',
    compiledHash: S.compiledHash || '',
    flashedHash: S.flashedHash || '',
    compiledAssignments: [...S.compiledAssignments],
    discoveredPorts: S.discoveredPorts || [],
    waveMode: S.waveMode || 'fit',
    followZoomFactor: S.followZoomFactor || 1,
  };
}
function syncProjectSaveUI() {
  const saved = !!S.projectDir;
  if ($('#btnSaveProject')) {
    $('#btnSaveProject').title = saved ? `Save Project (${S.projectDir}) (Ctrl+Shift+S)` : 'Save Project As… (Ctrl+Shift+S)';
    $('#btnSaveProject').setAttribute('aria-label', saved ? 'Save Project' : 'Save Project As');
  }
  if ($('#menuSaveProjectLabel')) $('#menuSaveProjectLabel').textContent = saved ? 'Save Project' : 'Save Project As…';
  if ($('#menuSaveProjectAs')) $('#menuSaveProjectAs').classList.toggle('hidden', !saved);
  if ($('#projectRootSummary')) {
    $('#projectRootSummary').title = saved ? `Project folder: ${S.projectDir}\nRight-click for folder actions` : 'Unsaved workspace (File → Save Project As… to save on disk)';
  }
}
async function saveProjectToDisk({ saveAs = false, quiet = false } = {}) {
  if (!S.sources.length) { toast('Add VHDL source files before saving.', 'err'); return false; }
  if (ide && !ide.validateLibraries()) return false;
  ide?.commitAll();
  renderSources();
  let dir = saveAs ? null : S.projectDir;
  if (!dir) {
    try {
      const picked = ide?.openFileBrowserModal
        ? await ide.openFileBrowserModal({
            mode: 'folder',
            title: 'Choose FPGA Project Folder',
            eyebrow: 'SAVE PROJECT TO DISK',
            initialDir: S.projectDir || currentHdlRoot || '',
            confirmText: 'Select Folder',
          })
        : await api('/api/project/pick-folder', { initialDir: S.projectDir || '' });
      if (picked.cancelled || !picked.dir) return false;
      dir = picked.dir;
    } catch (e) {
      toast(e.message, 'err');
      return false;
    }
  }
  const name = S.projectName || ide?.currentProjectTitle?.() || $('#topSelect').value || S.sources[0]?.name.replace(/\.[^.]+$/, '') || 'fpga_project';
  try {
    const result = await api('/api/project/save', { dir, projectName: name, project: projectData() });
    S.projectDir = result.dir;
    S.projectName = result.projectName;
    saveProject();
    ide?.updateTermCwd?.(S.projectDir);
    ide?.recordRecentProject(S.projectName, S.projectDir, result.qpf);
    ide?.captureBaseline(S.projectName);
    syncProjectSaveUI();
    await ide?.refreshProjectTree?.();
    fetchTree();
    if (!quiet) toast(`Saved ${result.qpf}, ${result.qsf} & ${S.sources.length} source(s) to ${result.dir}.`, 'ok');
    return true;
  } catch (e) {
    toast(e.message, 'err');
    log(`Save project failed: ${e.message}`, 'error');
    return false;
  }
}
async function openProjectFromDiskPath(targetPath = '', { promptIfInWorkbench = false } = {}) {
  try {
    let chosen = targetPath;
    if (!chosen) {
      const picked = ide?.openFileBrowserModal
        ? await ide.openFileBrowserModal({
            mode: 'open-project',
            title: 'Open Trace / Quartus FPGA Project',
            eyebrow: 'OPEN PROJECT',
            initialDir: S.projectDir || currentHdlRoot || '',
            confirmText: 'Open Project',
            extensions: ['qpf', 'qsf', 'json'],
          })
        : await api('/api/project/pick-open', { initialDir: S.projectDir || '' });
      if (picked.cancelled || !(picked.file || picked.dir)) return false;
      chosen = picked.file || picked.dir;
    }
    if (promptIfInWorkbench && ide?.requestProjectSwitch && $('#homeView')?.classList.contains('hidden')) {
      const label = chosen.split(/[\\/]/).filter(Boolean).pop() || chosen;
      ide.requestProjectSwitch({
        label,
        newWindowUrl: `/?openProject=${encodeURIComponent(chosen)}`,
        onSwitchHere: () => openProjectFromDiskPath(chosen, { promptIfInWorkbench: false }),
      });
      return true;
    }
    const result = await api('/api/project/open', { path: chosen });
    await stopAllSimulations();
    for (const tabName of [...(ide?.tabs || [])]) ide?.closeTab(tabName, true);
    restoreProject(result.project);
    S.projectDir = result.dir;
    S.projectName = result.projectName;
    const remembered = projectWaveModes[result.dir.toLowerCase()];
    if (remembered && ['follow', 'fit', 'free'].includes(remembered.waveMode)) {
      S.waveMode = remembered.waveMode;
      S.followZoomFactor = Number(remembered.followZoomFactor) > 0 ? Number(remembered.followZoomFactor) : 1;
      syncWaveModeUI();
    }
    saveProject();
    ide?.updateTermCwd?.(S.projectDir);
    ide?.openFirst();
    ide?.recordRecentProject(result.projectName, result.dir, result.qpf);
    ide?.captureBaseline(result.projectName);
    ide?.showHome(false);
    syncProjectSaveUI();
    await ide?.refreshProjectTree?.();
    const restoredState = await restoreSavedCompileState();
    const suffix = restoredState === 'flashed' ? 'Restored compiled & flashed state.' : restoredState === 'compiled' ? 'Restored compiled state — ready to flash.' : 'Click Compile when ready.';
    toast(`Opened ${result.projectName} (${result.project.sources.length} file${result.project.sources.length === 1 ? '' : 's'}). ${suffix}`, 'ok');
    return true;
  } catch (e) {
    toast(e.message, 'err');
    log(`Open project failed: ${e.message}`, 'error');
    return false;
  }
}
function saveProject() {
  const data = projectData();
  try { localStorage.setItem('trace.project.v1', JSON.stringify(data)); } catch { toast('Browser storage is full or unavailable. Use Save Project As… to keep your files.', 'err'); }
  persistAppState({ lastProject: data });
}
function restoreProject(project) {
  if (!project || project.format !== 'trace-project' || project.version !== 1 || !Array.isArray(project.sources) || project.sources.length > 100 || !project.sources.every(s => s && typeof s.name === 'string' && typeof s.text === 'string' && /^(?:[a-z0-9_][a-z0-9_. -]*\/)*[a-z0-9_][a-z0-9_. -]*\.(vhd|vhdl|vho|cf|hex|mif|mem|txt|dat|md)$/i.test(s.name) && (!s.library || /^[a-z][a-z0-9_]*$/i.test(s.library))) || !['93','02','08'].includes(project.standard) || !/^[a-z][a-z0-9_]*$/i.test(project.topLibrary || 'work') || typeof project.generics !== 'string' || !Array.isArray(project.assignments) || !project.assignments.every(p => Array.isArray(p) && p.length === 2 && Number.isInteger(p[0]) && p[0] >= 1 && p[0] <= 144 && typeof p[1] === 'string') || (project.sdf && (typeof project.sdf.text !== 'string' || typeof project.sdf.instance !== 'string' || !['min','typ','max'].includes(project.sdf.corner)))) throw new Error('Invalid Trace project file.');
  S.sources = project.sources; S.assignments = new Map(project.assignments); S.sdf = project.sdf || null;
  S.projectDir = typeof project.projectDir === 'string' && project.projectDir ? project.projectDir : null;
  S.projectName = typeof project.projectName === 'string' ? project.projectName : '';
  S.discoveredPorts = Array.isArray(project.discoveredPorts) ? project.discoveredPorts : [];
  S.compiledAssignments = Array.isArray(project.compiledAssignments) ? new Map(project.compiledAssignments) : new Map();
  S.compiledHash = typeof project.compiledHash === 'string' ? project.compiledHash : '';
  S.flashedHash = typeof project.flashedHash === 'string' ? project.flashedHash : '';
  $('#standardSelect').value = project.standard; $('#genericInput').value = project.generics; $('#topLibrary').value = project.topLibrary || 'work';
  const savedClk = Number(project.clkHz);
  if (Number.isFinite(savedClk) && savedClk > 0 && $(`#clkHz option[value="${savedClk}"]`)) {
    S.clkHz = savedClk;
    $('#clkHz').value = String(savedClk);
  } else {
    S.clkHz = Number($('#clkHz')?.value) || 50000000;
  }
  const mode = ['follow', 'fit', 'free'].includes(project.waveMode) ? project.waveMode : (appSettings.defaultWaveMode || 'fit');
  S.waveMode = mode;
  S.followZoomFactor = Number.isFinite(Number(project.followZoomFactor)) && Number(project.followZoomFactor) > 0 ? Number(project.followZoomFactor) : 1;
  syncWaveModeUI();
  renderSources(); $('#topSelect').value = (project.top || '').toLowerCase(); renderSdf(); renderPins(); syncProjectSaveUI();
  const topName = project.top || allEntities()[0] || S.sources[0]?.name || 'No design';
  $('#designTitle').textContent = S.projectName || (topName === DEMO_TOP ? 'Counter demo' : topName);
  $('#designSubtitle').textContent = `Build needed · VHDL-${project.standard === '08' ? '2008' : project.standard === '93' ? '1993' : '2002'}`;
  ide?.refreshProjectTree?.();
}
async function restoreSavedCompileState() {
  const wantCompile = S.compiledHash && S.compiledHash === computeCompileFingerprint();
  const wantFlash = wantCompile && S.flashedHash && S.flashedHash === computeFlashFingerprint();
  if (!wantCompile) {
    S.dirty = true;
    S.flashed = false;
    setStatus();
    return 'dirty';
  }
  await build($('#topSelect').value, { quiet: true });
  if (S.error || !S.sim) return 'error';
  if (wantFlash) {
    await flashToBoard({ quiet: true, preserveBoardPane: true });
    if (!S.error && S.flashed) return 'flashed';
  }
  return 'compiled';
}
function download(text, name, type = 'text/plain') { const url = URL.createObjectURL(new Blob([text], { type })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function renderSdf() { $('#sdfControls').classList.toggle('hidden', !S.sdf); $('#sdfName').textContent = S.sdf?.name || 'Timing annotation'; $('#sdfInstance').value = S.sdf?.instance || ''; $('#sdfCorner').value = S.sdf?.corner || 'typ'; }
function allEntities() {
  return [...new Set(S.sources.flatMap(s => [...s.text.replace(/--[^\n]*/g, '').matchAll(/\bentity\s+([a-z]\w*)\s+is\b/gi)].map(m => m[1].toLowerCase())))];
}
function renderSources() {
  if ($('#srcCount')) $('#srcCount').textContent = String(S.sources.length);
  const selected = $('#topSelect').value; $('#topSelect').replaceChildren(new Option('Auto-detect top', ''));
  for (const entity of allEntities()) $('#topSelect').add(new Option(entity, entity));
  if (allEntities().includes(selected)) $('#topSelect').value = selected;
  ide?.syncFromSources();
  if (S.projectDir) ide?.refreshProjectTree?.();
  else ide?.renderProjectTree?.();
}
async function closeSession(sim) { if (sim?.id) await api(`/api/sim/${sim.id}`, undefined, 'DELETE').catch(() => {}); }
async function stopAllSimulations() {
  pause();
  releaseKeys();
  clearRtlRunner();
  ++S.generation;
  S.pending = [];
  S.building = false;
  S.busy = false;
  S.truthBusy = false;
  S.importing = false;
  S.exporting = false;
  S.error = false;
  const prevSim = S.sim;
  S.sim = null;
  S.flashed = false;
  S.vcd = null;
  S.compiledAssignments = new Map();
  S.discoveredPorts = [];
  S.bindings = {};
  S.inputs = {};
  S.values.clear();
  S.time = 0;
  S.cycles = 0;
  $('#replayControls')?.classList.add('hidden');
  $('#virtualInputs')?.replaceChildren();
  $('#virtualInputs')?.classList.add('hidden');
  $('#roTime').textContent = fmtTime(0);
  uart.reset();
  board?.clearOutputs();
  sampleOutputs();
  waves?.setSignals([]);
  renderSignalChips();
  renderPins();
  setStatus();
  await closeSession(prevSim);
}
async function build(top = $('#topSelect').value, { quiet = false } = {}) {
  if (S.building || S.exporting) return;
  if (ide?.hasUnsaved()) {
    if (!ide.validateLibraries()) return;
    ide.commitAll();
    renderSources();
    if (!top) top = $('#topSelect').value;
  }
  S.dirty = true; S.flashed = false; S.pending = []; S.bindings = {}; pause();
  if (!S.sources.length) return toast('Open VHDL sources first.', 'err');
  S.standard = $('#standardSelect').value; S.topLibrary = $('#topLibrary').value.trim(); S.generics = {};
  if (!/^[a-z][a-z0-9_]*$/i.test(S.topLibrary)) return toast('Enter a valid top library name.', 'err');
  if (S.sdf) { S.sdf.instance = $('#sdfInstance').value.trim(); S.sdf.corner = $('#sdfCorner').value; if (!S.sdf.instance) return toast('Enter / for the top level, or a child instance path such as /u1.', 'err'); }
  try { S.generics = parseGenerics($('#genericInput').value); } catch (e) { return toast(e.message, 'err'); }
  pause(); S.building = true; S.error = false; const generation = ++S.generation; setStatus();
  clearRtlRunner();
  S.pending = []; await closeSession(S.sim); S.sim = null; S.vcd = null;
  board?.clearOutputs(); sampleOutputs();
  try {
    const result = await api('/api/sim/compile', { sources: S.sources, top: top || undefined, standard: S.standard, topLibrary: S.topLibrary, generics: S.generics, sdf: S.sdf });
    if (generation !== S.generation) { await closeSession(result); return; }
    S.sim = result; S.dirty = false; S.flashed = false; S.time = 0; S.cycles = 0; S.inputs = {}; S.values.clear();
    S.compiledAssignments = new Map(S.assignments);
    S.compiledHash = computeCompileFingerprint();
    if (S.flashedHash && S.flashedHash !== computeFlashFingerprint()) S.flashedHash = '';
    $('#replayControls').classList.add('hidden');
    const dirLabel = d => d === 1 ? 'IN' : d === 2 ? 'OUT' : d === 3 ? 'INOUT' : 'SIG';
    const discovered = [];
    for (const signal of result.signals) {
      signal.short = signal.name.startsWith(result.top + '.') ? signal.name.slice(result.top.length + 1) : signal.name;
      if (signal.name.startsWith(result.top + '.') && !signal.short.includes('.') && [1, 2, 3].includes(signal.direction)) {
        const dir = dirLabel(signal.direction);
        if (signal.width === 1) discovered.push({ name: signal.short.toLowerCase(), label: signal.short, dir, base: signal.short.toLowerCase(), bit: null });
        else if (Number.isInteger(signal.left) && Number.isInteger(signal.right)) {
          const step = signal.left <= signal.right ? 1 : -1;
          for (let b = signal.left; b !== signal.right + step; b += step) {
            discovered.push({ name: `${signal.short.toLowerCase()}[${b}]`, label: `${signal.short}[${b}]`, dir, base: signal.short.toLowerCase(), bit: b });
          }
        }
      }
    }
    S.discoveredPorts = discovered;
    S.bindings = {};
    waves.setSignals([]); renderSignalChips();
    $('#virtualInputs').replaceChildren(); $('#virtualInputs').classList.add('hidden');
    renderPins(); renderTruthInputs();
    uart.reset(); $('#uartOut').replaceChildren();
    board?.clearOutputs(); sampleOutputs();
    $('#roTime').textContent = fmtTime(0);
    syncKeys();
    saveProject();
    const assignedCount = [...S.compiledAssignments.values()].filter(v => v && v.trim()).length;
    $('#designTitle').textContent = S.projectName || (result.top === DEMO_TOP ? 'Counter demo' : result.top);
    $('#designSubtitle').textContent = `Compiled (${assignedCount} pin${assignedCount === 1 ? '' : 's'} assigned) · Ready to flash`;
    $('#inputHint').textContent = 'Flash compiled design to activate board I/O';
    $('.mode-label').textContent = 'GHDL · compiled (unflashed)';
    log(`${result.backend}\nCompiled ${result.top}${result.cached ? ' (cached)' : ''} (${result.signals.length} signals, ${assignedCount} board pin${assignedCount === 1 ? '' : 's'} assigned). Click Flash to program the devboard.`);
    result.diagnostics.forEach(d => log(d, 'warning'));
    ide?.setProblems(parseDiagnostics((result.diagnostics || []).join('\n')));
    if (!quiet) {
      toast(assignedCount ? `Compiled ${result.top} (${assignedCount} pin${assignedCount === 1 ? '' : 's'} assigned). Click Flash to program board.` : `Compiled ${result.top} (0 pins assigned). Assign pins in Pin Planner or click Flash.`, 'ok');
    }
  } catch (e) {
    if (generation !== S.generation) return;
    await closeSession(S.sim); S.sim = null; S.flashed = false; S.compiledHash = ''; S.flashedHash = ''; S.bindings = {}; S.inputs = {}; S.values.clear(); S.time = 0;
    board?.clearOutputs(); sampleOutputs(); renderPins(); waves.setSignals([]); renderSignalChips();
    $('#virtualInputs').replaceChildren(); $('#virtualInputs').classList.add('hidden');
    for (const id of ['truthInputs', 'truthHead', 'truthBody', 'truthSummary', 'uartOut']) $('#' + id).replaceChildren();
    $('#replayControls').classList.add('hidden'); $('#designTitle').textContent = 'Build failed'; $('#designSubtitle').textContent = 'No active simulation'; $('#roTime').textContent = fmtTime(0);
    fail(e);
  } finally { S.building = false; setStatus(); }
}
function attachSignalShortNames(result) {
  for (const signal of result.signals) {
    signal.short = signal.name.startsWith(result.top + '.') ? signal.name.slice(result.top.length + 1) : signal.name;
  }
}
let rtlRunner = null;
let rtlSignalMap = [];
let rtlInputMap = new Map();
let rtlIdleBeep = null;

function clearRtlRunner() {
  rtlRunner = null;
  rtlSignalMap = [];
  rtlInputMap.clear();
  rtlIdleBeep = null;
}

async function initRtlRunnerForSim() {
  clearRtlRunner();
  if (!S.sim?.hasRtl || S.vcd) return false;
  try {
    const mod = await import(`/api/sim/${S.sim.id}/rtl.mjs`);
    const beepBind = S.bindings.beep;
    const beepPortName = (beepBind && beepBind.bit === null) ? beepBind.signal.short : '';
    const runner = mod.createRunner(beepPortName);
    const sigByShort = new Map();
    S.sim.signals.forEach((s, idx) => sigByShort.set(s.short.toLowerCase(), idx));
    const map = [];
    runner.meta.observed.forEach((obs, obsIdx) => {
      const sigIdx = sigByShort.get(obs.name.toLowerCase());
      if (sigIdx !== undefined) map.push({ obsIdx, sigIdx, width: obs.width });
    });
    for (const inp of runner.meta.inputs) {
      const sigIdx = sigByShort.get(inp.name.toLowerCase());
      if (sigIdx !== undefined) rtlInputMap.set(S.sim.signals[sigIdx].id, inp.name);
    }
    rtlRunner = runner;
    rtlSignalMap = map;
    return true;
  } catch {
    clearRtlRunner();
    return false;
  }
}

function syncAllInputsToRtl() {
  if (!rtlRunner) return;
  for (const [id, name] of rtlInputMap.entries()) {
    const raw = S.inputs[id];
    if (typeof raw === 'string' && raw.length) {
      const num = parseInt(raw.replace(/[^01]/g, '0'), 2) >>> 0;
      rtlRunner.setInput(name, num);
    }
  }
  const beepBind = S.bindings.beep;
  rtlRunner.setBeepPort(beepBind && beepBind.bit === null ? beepBind.signal.short : '');
}

function runRtlStepBatch(cycles, wallDt = 0) {
  if (!rtlRunner || !S.sim) return;
  const trueCycleFs = 1e15 / S.clkHz;
  if (cycles > 0) {
    const maxCycles = trueCycleFs > 0 ? Math.max(0, Math.floor((MAX_SIM_FS - S.time) / trueCycleFs)) : Infinity;
    if (maxCycles <= 0) {
      pause();
      log('Reached 64-bit simulation time ceiling (~5 hours at 1 fs). Click Restart to continue from 0 ns.', 'info');
      toast('Reached simulation time limit. Click Restart to continue from 0 ns.');
      return;
    }
    if (cycles > maxCycles) cycles = maxCycles;
  }
  const startTimeFs = S.time;
  const tickFs = 10 ** (15 + (S.sim.precision ?? -15));
  const hasScalarBeep = !!(S.bindings.beep && S.bindings.beep.bit === null);
  let audioOut = null;
  if (cycles > 0 && S.running && hasScalarBeep && !audio.isMuted() && wallDt > 0) {
    const aSamples = Math.max(1, Math.min(4096, Math.round(wallDt * audio.sampleRate())));
    audioOut = new Float32Array(aSamples);
  }
  const res = rtlRunner.runBatch(cycles, cycles > 64 ? 96 : Math.max(1, cycles), audioOut);
  const template = S.sim.signals.map(s => S.values.get(s.short) ?? S.inputs[s.id] ?? '0'.repeat(s.width));
  for (const [id] of rtlInputMap.entries()) {
    const sig = S.sim.signals.find(s => s.id === id);
    if (sig && S.inputs[id]) {
      const idx = S.sim.signals.indexOf(sig);
      if (idx !== -1) template[idx] = S.inputs[id];
    }
  }
  const samples = res.samples.map(snap => {
    const row = template.slice();
    for (let k = 0; k < rtlSignalMap.length; k++) {
      const m = rtlSignalMap[k];
      const v = snap.vals[m.obsIdx] >>> 0;
      row[m.sigIdx] = m.width === 1 ? (v & 1 ? '1' : '0') : v.toString(2).padStart(m.width, '0');
    }
    const ticks = Math.round((startTimeFs + snap.offset * trueCycleFs) / tickFs);
    return { time: String(ticks), values: row };
  });
  S.cycles += res.cyclesRun;
  if (audioOut && hasScalarBeep) {
    let minV = 2, maxV = -2;
    for (let i = 0; i < audioOut.length; i++) {
      const v = audioOut[i];
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const acMoving = (maxV - minV) > 0.05;
    const steadyDcHigh = !acMoving && minV > 0.9 && rtlIdleBeep === '0';
    if (steadyDcHigh) {
      audio.startBuzzer(2048);
      buzzerState.sounding = true;
    } else {
      audio.pushBuzzerPcm(audioOut);
      buzzerState.sounding = acMoving;
    }
    board?.setBuzzer(buzzerState.sounding);
    consume({ samples }, trueCycleFs, true);
  } else {
    consume({ samples }, trueCycleFs, false);
  }
}

async function applyInitialFlashedState({ preserveWaves = false } = {}) {
  const prevVis = preserveWaves ? new Map(waves.signals.map(s => [s.name, !!s.visible])) : null;
  const prevExp = preserveWaves ? new Map(waves.signals.map(s => [s.name, !!s.expanded])) : null;
  S.time = 0; S.cycles = 0; S.inputs = {}; S.values.clear(); S.pending = [];
  buildBindings();
  buildWaves(prevVis, prevExp);
  renderVirtualInputs();
  renderPins();
  renderTruthInputs();
  uart.reset(); $('#uartOut').replaceChildren();
  board?.clearOutputs();
  resetBuzzerTracker(true);
  consume(S.sim);
  for (const signal of S.sim.signals.filter(s => s.driveable && !S.sim.ended)) {
    const bits = Array(signal.width).fill(signal.direction === 3 ? 'Z' : '0');
    let touched = false;
    for (const net of ['reset_btn', ...KEY_NETS, 'uart_rxd']) {
      const bound = S.bindings[net];
      if (bound?.signal.id === signal.id) {
        bits[bound.offset] = (net === 'uart_rxd' || !isNetActive(net)) ? '1' : '0';
        touched = true;
      }
    }
    if (touched) {
      const value = bits.join(''); S.inputs[signal.id] = value; S.pending.push({ id: signal.id, value });
    }
  }
  if (await initRtlRunnerForSim()) {
    syncAllInputsToRtl();
    S.pending.length = 0;
    runRtlStepBatch(0, 0);
    rtlIdleBeep = /[1H]/.test(boardValue('beep')) ? '1' : /[0L]/.test(boardValue('beep')) ? '0' : null;
  } else if (!S.sim.ended && S.pending.length) {
    S.busy = true;
    try {
      const initial = await api(`/api/sim/${S.sim.id}/step`, { cycles: 0, inputs: S.pending.splice(0), clock: clockId(), halfPeriod: halfPeriod() });
      consume(initial);
    } finally { S.busy = false; }
  } else {
    sampleOutputs();
  }
  $('#roTime').textContent = fmtTime(0);
  if ($('#waveCursor')) $('#waveCursor').textContent = 'Cursor —';
  syncKeys();
  setStatus();
  if (S.waveMode === 'follow' && S.time > 0) waves.follow(S.time, autoFollowSpan());
  else if (S.waveMode === 'fit') waves.fit();
  else waves.draw();
}
async function restartSimulation() {
  if (!S.sim || S.building || S.importing || S.exporting) return;
  if (S.vcd) { loadVcd(S.vcd.text, S.sim.top); toast('Waveform replay restarted at 0 ns.'); return; }
  pause();
  S.building = true; setStatus();
  const generation = ++S.generation;
  try {
    const restarted = await api(`/api/sim/${S.sim.id}/restart`, {});
    if (generation !== S.generation) { await closeSession(restarted); return; }
    attachSignalShortNames(restarted);
    S.sim = restarted;
    S.flashed = true;
    await applyInitialFlashedState({ preserveWaves: true });
    log(`Restarted simulation (${S.sim.top}) at 0 fs.`);
    toast('Simulation restarted.');
  } catch (e) {
    if (generation !== S.generation) return;
    fail(e);
  } finally { S.building = false; setStatus(); }
}
async function flashToBoard({ quiet = false, preserveBoardPane = false } = {}) {
  if (S.building || S.importing || S.exporting) return;
  if (ide?.hasUnsaved() || S.dirty || !S.sim || S.error) {
    return toast('Build & Compile your code and pin assignments first before flashing to the board.', 'err');
  }
  pause();
  if (!preserveBoardPane && ide && !ide.boardOpen) ide.setBoardPaneOpen(true);
  if (S.flashed || S.time > 0 || S.cycles > 0 || S.sim.ended) {
    S.building = true; setStatus();
    const generation = ++S.generation;
    try {
      const restarted = await api(`/api/sim/${S.sim.id}/restart`, {});
      if (generation !== S.generation) { await closeSession(restarted); return; }
      attachSignalShortNames(restarted);
      S.sim = restarted;
    } catch (e) {
      if (generation !== S.generation) return;
      fail(e);
      return;
    } finally { S.building = false; }
  }
  S.flashed = true;
  S.flashedHash = computeFlashFingerprint();
  await applyInitialFlashedState({ preserveWaves: false });
  saveProject();
  const boundEntries = Object.entries(S.bindings);
  const boundCount = boundEntries.length;
  $('#designSubtitle').textContent = boundCount
    ? `Flashed (${boundCount} pin${boundCount === 1 ? '' : 's'} connected) · VHDL-${S.standard === '08' ? '2008' : S.standard === '93' ? '1993' : '2002'}`
    : 'Flashed (0 pins connected — board I/O inactive)';
  $('#inputHint').textContent = boundCount ? 'Active-low inputs (mapped pins only)' : 'No pins assigned in Pin Planner';
  $('.mode-label').textContent = boundCount ? 'GHDL · flashed to board' : 'GHDL · flashed (unmapped)';
  if (boundCount === 0) {
    log(`Flashed ${S.sim.top} to devboard with 0 connected pins. Because no pins were assigned in Pin Planner before compiling, the devboard will behave as if no code was flashed.`, 'warning');
    if (!quiet) toast(`Flashed ${S.sim.top} with 0 pins mapped (devboard I/O is unconnected).`);
  } else {
    const pinList = boundEntries.map(([net, b]) => `${b.bit === null ? b.signal.short : `${b.signal.short}[${b.bit}]`}->${net}(P${NET_PIN[net]})`).join(', ');
    log(`Flashed ${S.sim.top} onto 3D devboard (${boundCount} pin${boundCount === 1 ? '' : 's'} connected: ${pinList}).`);
    if (!quiet) toast(`Flashed ${S.sim.top} to devboard (${boundCount} pin${boundCount === 1 ? '' : 's'} connected).`, 'ok');
  }
}
function buildBindings() {
  S.bindings = {};
  if (!S.sim || (!S.flashed && !S.vcd)) return;
  const map = S.vcd ? S.assignments : S.compiledAssignments;
  for (const [net, pin] of Object.entries(NET_PIN)) {
    const target = (map.get(pin) ?? '').trim();
    if (!target) continue;
    const match = target.toLowerCase().match(/^(.+?)(?:\[(-?\d+)\]|\((-?\d+)\))?$/);
    if (!match) continue;
    const name = match[1], bit = match[2] ?? match[3];
    const signal = S.sim.signals.find(s => S.vcd ? s.scope === S.vcd.scope && s.localName.toLowerCase() === name && !['real','realtime'].includes(s.kind) : s.short.toLowerCase() === name);
    if (!signal) continue;
    const offset = bit === undefined ? 0 : signal.left <= signal.right ? Number(bit) - signal.left : signal.left - Number(bit);
    if ((bit === undefined && signal.width !== 1) || !Number.isInteger(offset) || offset < 0 || offset >= signal.width) continue;
    S.bindings[net] = { signal, bit: bit === undefined ? null : Number(bit), offset };
  }
}
function clockId() { const bound = S.bindings.clk?.signal; return bound?.driveable && bound.width === 1 ? bound.id : -1; }
function halfPeriod() { return String(Math.max(1, Math.round(0.5 * 10 ** -(S.sim?.precision ?? -15) / S.clkHz))); }
function boardValue(net) {
  const bound = S.bindings[net]; if (!bound) return 'U';
  const value = S.values.get(bound.signal.short) ?? 'U';
  return value[bound.offset] ?? 'U';
}
const muxSlots = [null, null, null, null];
const muxAge = [0, 0, 0, 0];
let muxCursor = 0;
let multiDigitFrame = null;
function clearMuxDisplayState() {
  muxSlots.fill(null);
  muxAge.fill(0);
  multiDigitFrame = null;
}
function captureDisplayFrame() {
  let segByte = 0; SEG_NETS.forEach((net, b) => { if (/[0L]/.test(boardValue(net))) segByte |= 1 << b; });
  let digitMask = 0; DIGIT_NETS.forEach((net, i) => { if (/[0L]/.test(boardValue(net))) digitMask |= 1 << i; });
  let ledMask = 0; LED_NETS.forEach((net, i) => { if (/[0L]/.test(boardValue(net))) ledMask |= 1 << i; });
  return { segByte, digitMask, ledMask };
}
function applyDisplayFrame(f) {
  const active = S.power;
  for (let i = 0; i < 4; i++) {
    board?.setSegDigit(i, f.segByte, active && !!(f.digitMask & (1 << i)));
    const on = active && !!(f.ledMask & (1 << i));
    board?.setLed(i, on);
    $(`[data-led="${i}"]`)?.classList.toggle('on', on);
  }
}
function sampleDisplayOnly() {
  const active = S.power;
  let byte = 0; SEG_NETS.forEach((net, b) => { if (/[0L]/.test(boardValue(net))) byte |= 1 << b; });
  DIGIT_NETS.forEach((net, i) => board?.setSegDigit(i, byte, active && /[0L]/.test(boardValue(net))));
}
const buzzerState = {
  idleLevel: null,
  lastLevel: null,
  lastEdgeCycle: null,
  lastHalfPeriodCycles: null,
  lastToggleMs: 0,
  lastToggleIntervalMs: 0,
  consecutiveEdges: 0,
  freqHz: 2048,
  sounding: false,
};
function resetBuzzerTracker(full = true) {
  if (full) {
    buzzerState.idleLevel = null;
    buzzerState.lastLevel = null;
  }
  buzzerState.lastEdgeCycle = null;
  buzzerState.lastHalfPeriodCycles = null;
  buzzerState.lastToggleMs = 0;
  buzzerState.lastToggleIntervalMs = 0;
  buzzerState.consecutiveEdges = 0;
  buzzerState.freqHz = 2048;
  buzzerState.sounding = false;
  audio.stopBuzzer();
}
function updateBuzzerFromSamples(samples, burstStartCycles, burstStartTimeFs, stepFs) {
  const bound = S.bindings.beep;
  if (!bound || !S.power || !S.sim) {
    buzzerState.sounding = false;
    board?.setBuzzer(false);
    audio.stopBuzzer();
    return;
  }
  const now = performance.now();
  const precExp = 15 + (S.sim.precision ?? -15);
  const sigIdx = S.sim.signals.indexOf(bound.signal);
  if (sigIdx !== -1) {
    for (let idx = 0; idx < samples.length; idx++) {
      const sample = samples[idx];
      const ch = (sample.values[sigIdx] ?? 'U')[bound.offset] ?? 'U';
      const lvl = /[1H]/.test(ch) ? '1' : /[0L]/.test(ch) ? '0' : null;
      if (lvl === null) continue;
      if (buzzerState.idleLevel === null && burstStartCycles === 0) buzzerState.idleLevel = lvl;
      const sampleTimeFs = Number(sample.time) * (10 ** precExp);
      const sampleCycle = burstStartCycles + (stepFs > 0 ? Math.max(0, (sampleTimeFs - burstStartTimeFs) / stepFs) : 0);
      if (buzzerState.lastLevel !== null && lvl !== buzzerState.lastLevel) {
        const edgeGapMs = buzzerState.lastToggleMs ? (now - buzzerState.lastToggleMs) : 0;
        if (buzzerState.lastEdgeCycle !== null) {
          const hp = sampleCycle - buzzerState.lastEdgeCycle;
          if (hp > 0) {
            const prevHp = buzzerState.lastHalfPeriodCycles;
            const periodCycles = prevHp !== null ? (hp + prevHp) : (2 * hp);
            const rawFreq = S.clkHz / periodCycles;
            const symmetric = prevHp === null || (Math.max(hp, prevHp) / Math.min(hp, prevHp) <= 3.5);
            if (rawFreq >= 40 && rawFreq <= 12000 && symmetric) {
              buzzerState.freqHz = rawFreq;
              buzzerState.consecutiveEdges = Math.max(2, buzzerState.consecutiveEdges + 1);
            } else if (rawFreq > 12000 && symmetric) {
              buzzerState.freqHz = 2048;
              buzzerState.consecutiveEdges += 1;
            } else {
              buzzerState.freqHz = 2048;
              buzzerState.consecutiveEdges = 1;
            }
            buzzerState.lastHalfPeriodCycles = hp;
          }
        }
        buzzerState.lastEdgeCycle = sampleCycle;
        if (edgeGapMs > 0 && edgeGapMs < 1500) buzzerState.lastToggleIntervalMs = edgeGapMs;
        buzzerState.lastToggleMs = now;
      }
      buzzerState.lastLevel = lvl;
    }
  }
  const sinceToggle = now - buzzerState.lastToggleMs;
  const holdMs = Math.max(80, Math.min(450, (buzzerState.lastToggleIntervalMs || 140) * 2.5));
  let sounding = false;
  let freq = buzzerState.freqHz;
  if (S.running) {
    if (buzzerState.consecutiveEdges >= 2 && sinceToggle <= holdMs) {
      sounding = true;
    } else if (buzzerState.consecutiveEdges === 1 && sinceToggle <= 55) {
      sounding = true;
      freq = 2048;
    } else if (buzzerState.lastLevel === '1' && buzzerState.idleLevel === '0' && (buzzerState.consecutiveEdges === 0 || sinceToggle > holdMs)) {
      sounding = true;
      freq = 2048;
    } else if (sinceToggle > 600) {
      buzzerState.consecutiveEdges = 0;
      buzzerState.lastHalfPeriodCycles = null;
    }
  }
  buzzerState.sounding = sounding;
  board?.setBuzzer(sounding);
  if (sounding) audio.startBuzzer(freq);
  else audio.stopBuzzer();
}
function sampleNonDisplayOutputs() {
  const active = S.power;
  LED_NETS.forEach((net, i) => {
    const value = boardValue(net), on = active && /[0L]/.test(value), indicator = $(`[data-led="${i}"]`);
    board?.setLed(i, on); indicator.classList.toggle('on', on); indicator.classList.toggle('unknown', active && !/^[01LH]$/.test(value));
    indicator.title = `${net.toUpperCase()}: ${!active ? 'power off' : value + (on ? ' · on' : ' · off/unknown')}`;
    indicator.setAttribute('aria-label', indicator.title);
  });
  const beep = active && (S.running ? buzzerState.sounding : /[1H]/.test(boardValue('beep')) && buzzerState.idleLevel !== '1');
  board?.setBuzzer(beep);
  if (!S.running || !active) audio.stopBuzzer();
  $$('#ciNets [data-ci-net]').forEach(el => {
    const val = S.power ? boardValue(el.dataset.ciNet) : '—';
    el.textContent = val;
    el.classList.toggle('hi', /[1H]/.test(val));
  });
}
function sampleOutputs() {
  sampleNonDisplayOutputs();
  sampleDisplayOnly();
}
let cachedVhdlTimeScaleKey = '';
let cachedVhdlTimeScaleFs = 0;

function extractVhdlTimeHintFs() {
  const key = S.sources.map(s => `${s.name}\0${s.text.length}\0${s.text.slice(0, 120)}`).join('|');
  if (key === cachedVhdlTimeScaleKey) return cachedVhdlTimeScaleFs;
  cachedVhdlTimeScaleKey = key;
  const unitMult = { fs: 1, ps: 1e3, ns: 1e6, us: 1e9, ms: 1e12, sec: 1e15, s: 1e15 };
  const matches = [];
  for (const src of S.sources) {
    if (!/\.(vhd|vhdl)$/i.test(src.name)) continue;
    const text = src.text.replace(/--[^\n]*/g, ' ');
    const re = /\b(\d+(?:\.\d+)?)\s*(fs|ps|ns|us|ms|sec|s)\b/gi;
    let m;
    while ((m = re.exec(text)) && matches.length < 64) {
      const val = Number(m[1]) * (unitMult[m[2].toLowerCase()] || 0);
      if (val > 0 && Number.isFinite(val)) matches.push(val);
    }
  }
  if (!matches.length) { cachedVhdlTimeScaleFs = 0; return 0; }
  matches.sort((a, b) => a - b);
  cachedVhdlTimeScaleFs = matches[Math.floor(matches.length * 0.5)];
  return cachedVhdlTimeScaleFs;
}

function estimateSignalCadenceFs() {
  const sigs = waves?.signals || [];
  const deltas = [];
  for (const sig of sigs) {
    const short = sig.name.split('.').pop()?.toLowerCase() || '';
    if (short === 'clk' || short === 'clock') continue;
    const samples = sig.samples;
    if (!samples || samples.length < 2) continue;
    const start = Math.max(1, samples.length - 64);
    for (let i = start; i < samples.length; i++) {
      const d = samples[i].t - samples[i - 1].t;
      if (d > 0) deltas.push(d);
    }
  }
  if (!deltas.length) return 0;
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length * 0.5)];
}

function autoFollowSpan() {
  const cycleFs = 1e15 / Math.max(1, S.clkHz || 50000000);
  const cadenceFs = estimateSignalCadenceFs();
  const vhdlHintFs = extractVhdlTimeHintFs();
  const zoomMult = S.followZoomFactor || 1;
  const unitBase = { fs: 100, ps: 1e5, ns: 1e8, us: 1e11, ms: 1e14, s: 2e15 };

  let baseSpan;
  if (cadenceFs > 0) {
    baseSpan = cadenceFs * 32;
  } else if (S.clkHz <= 10000) {
    baseSpan = cycleFs * 20;
  } else if (vhdlHintFs > 0) {
    baseSpan = vhdlHintFs * 20;
  } else if (waves?.timeUnit && waves.timeUnit !== 'auto' && unitBase[waves.timeUnit]) {
    baseSpan = unitBase[waves.timeUnit];
  } else {
    baseSpan = S.time > 0 && S.time < 5000 * cycleFs ? cycleFs * 40 : 2e14;
  }

  const minSpan = Math.max(cycleFs * 8, 1e4);
  const maxSpan = 6e16;
  return Math.max(minSpan, Math.min(maxSpan, baseSpan * zoomMult));
}

function syncWaveModeUI() {
  const mode = S.waveMode || 'fit';
  $$('#waveModeGroup [data-wave-mode]').forEach(btn => {
    const active = btn.dataset.waveMode === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', String(active));
  });
  $('#waveZoomIn')?.classList.toggle('wave-locked-ctl', mode === 'fit');
  $('#waveZoomOut')?.classList.toggle('wave-locked-ctl', mode === 'fit');
  const tip = mode === 'free'
    ? 'Drag thumb or click track to scroll across waveform timeline'
    : `Viewport locked in ${mode === 'fit' ? 'Fit' : 'Follow'} mode — switch to Free to pan manually`;
  if ($('#waveScrollWrap')) $('#waveScrollWrap').title = tip;
}

function persistProjectWaveMode() {
  if (S.projectDir) {
    projectWaveModes[S.projectDir.toLowerCase()] = { waveMode: S.waveMode, followZoomFactor: S.followZoomFactor || 1 };
    try { localStorage.setItem('trace.projectWaveModes.v1', JSON.stringify(projectWaveModes)); } catch {}
    persistAppState({ projectWaveModes });
  }
  saveProject();
}

function setWaveMode(nextMode, { save = true, resetFollowZoom = true } = {}) {
  const mode = ['follow', 'fit', 'free'].includes(nextMode) ? nextMode : 'fit';
  const wasSame = S.waveMode === mode;
  S.waveMode = mode;
  if (mode === 'follow' && resetFollowZoom && wasSame) S.followZoomFactor = 1;
  syncWaveModeUI();
  if (waves) {
    if (mode === 'fit') waves.fit();
    else if (mode === 'follow') {
      if (S.time > 0) waves.follow(S.time, autoFollowSpan());
      else waves.fit();
    }
    waves.draw();
  }
  if (save) persistProjectWaveMode();
}

function notifyWaveLocked(actionKind) {
  const now = performance.now();
  if (now - lastWaveLockToast < 2400) return;
  lastWaveLockToast = now;
  const modeLabel = S.waveMode === 'fit' ? 'Fit' : 'Follow';
  const msg = actionKind === 'zoom' && S.waveMode === 'fit'
    ? 'Locked in Fit mode — switch to Free to zoom or pan.'
    : `Locked in ${modeLabel} mode — switch to Free to pan manually.`;
  toast(msg);
}

function zoomWaveform(factor, cursorT) {
  if (S.waveMode === 'fit') {
    notifyWaveLocked('zoom');
    return;
  }
  if (S.waveMode === 'follow') {
    S.followZoomFactor = Math.max(0.05, Math.min(20, (S.followZoomFactor || 1) * factor));
    if (S.time > 0) waves?.follow(S.time, autoFollowSpan());
    waves?.draw();
    persistProjectWaveMode();
    return;
  }
  waves?.zoom(factor, cursorT);
}

let lastWaveDraw = 0;
function consume(result, stepFs = 0, skipLegacyBuzzer = false) {
  result.logs?.forEach(m => log(m, /warning/i.test(m) ? 'warning' : 'info'));
  const list = result.samples || [];
  const burstStartTimeFs = S.time;
  const burstStartCycles = S.cycles;
  const seenInBurst = [null, null, null, null];
  let sawMultiDigit = null;
  let lastDisplayFrame = null;
  for (let idx = 0; idx < list.length; idx++) {
    const sample = list[idx];
    S.time = Number(sample.time) * 10 ** (15 + (S.sim?.precision ?? -15));
    S.sim.signals.forEach((signal, i) => S.values.set(signal.short, sample.values[i]));
    waves.push(S.time, S.values);
    if (S.running && list.length > 1) {
      const df = captureDisplayFrame();
      lastDisplayFrame = df;
      if (df.digitMask !== 0) {
        if ((df.digitMask & (df.digitMask - 1)) === 0) {
          const d = 31 - Math.clz32(df.digitMask);
          if (d >= 0 && d < 4) seenInBurst[d] = df;
        } else {
          sawMultiDigit = df;
        }
      }
    }
    uartSample();
  }
  if (list.length > 0 && !skipLegacyBuzzer) updateBuzzerFromSamples(list, burstStartCycles, burstStartTimeFs, stepFs);
  if (S.running && list.length > 1) {
    sampleNonDisplayOutputs();
    const anySeen = seenInBurst.some(Boolean);
    if (!anySeen && !sawMultiDigit && (!lastDisplayFrame || lastDisplayFrame.digitMask === 0)) {
      clearMuxDisplayState();
      sampleDisplayOnly();
    } else if (sawMultiDigit) {
      multiDigitFrame = sawMultiDigit;
      muxSlots.fill(null);
      muxAge.fill(0);
    } else {
      multiDigitFrame = null;
      for (let d = 0; d < 4; d++) {
        if (seenInBurst[d]) {
          muxSlots[d] = seenInBurst[d];
          muxAge[d] = 0;
        } else if (muxSlots[d]) {
          muxAge[d]++;
          if (muxAge[d] > 6) muxSlots[d] = null;
        }
      }
    }
  } else if (list.length > 0) {
    sampleOutputs();
  }
  if (result.ended) { S.sim.ended = true; S.pending = []; pause(); log('Testbench completed normally. Its final waveform is ready to export.'); }
  $('#roTime').textContent = fmtTime(S.time);
  const now = performance.now();
  const wavesVisible = !$('#app')?.classList.contains('no-waves');
  if (wavesVisible && (!S.running || now - lastWaveDraw >= 40)) {
    lastWaveDraw = now;
    if (S.running || manualStepping) {
      if (S.waveMode === 'follow' && S.time > 0) waves.follow(S.time, autoFollowSpan());
      else if (S.waveMode === 'fit') waves.fit();
    }
    waves.draw();
  }
  for (const input of $$('#virtualInputs input')) {
    if (document.activeElement === input) continue;
    input.disabled = S.building || S.dirty || S.error || !S.power || S.sim?.ended;
    const value = S.inputs[input.dataset.signal];
    if (input.type === 'checkbox') input.checked = value === '1'; else input.value = value ?? '';
  }
}
function reloadQsfText(text, fileName = 'project.qsf') {
  try {
    const parsed = parseQsf(text);
    S.assignments = new Map(parsed.pins.map(({ pin, target }) => [pin, target.toLowerCase()]));
    renderPins();
    markDirty();
    log(`Reloaded ${parsed.pins.length} pin assignment(s) from ${fileName}.`);
  } catch {}
}
const MAX_SIM_FS = 1.8e19;
let adaptiveMaxCycles = 53249;
function remainingSimCycles() {
  if (!S.sim || S.vcd) return Infinity;
  const stepFs = 2 * Number(halfPeriod()) * 10 ** (15 + (S.sim.precision ?? -15));
  return stepFs > 0 ? Math.max(0, Math.floor((MAX_SIM_FS - S.time) / stepFs)) : Infinity;
}
async function advance(cycles = 1, wallSec = 0) {
  if (!Number.isInteger(cycles) || cycles < 0) return;
  if (!S.sim || S.sim.ended || S.dirty || S.error || !S.power || S.busy || S.building || S.importing || S.exporting) return;
  if (S.vcd) { stepPlayback(cycles); return; }
  if (rtlRunner) { runRtlStepBatch(cycles, wallSec); return; }
  const ticksPerSec = 10 ** -(S.sim.precision ?? -15);
  const stepHalfPeriod = (wallSec > 0 && cycles > 0)
    ? String(Math.max(1, Math.round((0.5 * wallSec * ticksPerSec) / cycles)))
    : halfPeriod();
  const stepFs = 2 * Number(stepHalfPeriod) * 10 ** (15 + (S.sim.precision ?? -15));
  if (cycles > 0) {
    const maxCycles = stepFs > 0 ? Math.max(0, Math.floor((MAX_SIM_FS - S.time) / stepFs)) : Infinity;
    if (maxCycles <= 0) {
      pause();
      log('Reached 64-bit simulation time ceiling (~5 hours at 1 fs). Click Restart to continue from 0 ns.', 'info');
      toast('Reached simulation time limit. Click Restart to continue from 0 ns.');
      return;
    }
    if (cycles > maxCycles) cycles = maxCycles;
  }
  S.busy = true; const generation = S.generation;
  const stepStart = performance.now();
  const pending = S.pending.splice(0);
  const batches = [[]]; let ids = new Set();
  for (const input of pending) {
    if (ids.has(input.id)) { batches.push([]); ids = new Set(); }
    batches.at(-1).push(input); ids.add(input.id);
  }
  // Use non-aliasing odd decimation stride for large bursts (>64 cycles) so GHDL runs at full native speed
  // while still sampling ~96 evenly-spaced points across every frame for 7-seg multiplexing & waveforms.
  const stride = cycles > 64 ? Math.max(3, Math.floor((cycles * 2) / 96) | 1) : 1;
  try {
    for (let i = 0; i < batches.length; i++) {
      const isLast = i === batches.length - 1;
      const batchCycles = isLast ? cycles : 0;
      const result = await api(`/api/sim/${S.sim.id}/step`, { cycles: batchCycles, stride: batchCycles > 64 ? stride : 1, halfPeriod: stepHalfPeriod, clock: clockId(), inputs: batches[i] });
      if (generation !== S.generation) return;
      consume(result, stepFs);
      if (S.sim.ended) break;
    }
    S.cycles += cycles;
    if (cycles >= 256) {
      const elapsed = performance.now() - stepStart;
      if (elapsed < 28 && cycles >= adaptiveMaxCycles * 0.85) {
        adaptiveMaxCycles = Math.min(131071, Math.round(adaptiveMaxCycles * 1.45) | 1);
      } else if (elapsed > 60) {
        adaptiveMaxCycles = Math.max(4097, Math.round(adaptiveMaxCycles * 0.75) | 1);
      }
    }
    if (S.running && remainingSimCycles() <= 0) {
      pause();
      log('Reached 64-bit simulation time ceiling (~5 hours at 1 fs). Click Restart to continue from 0 ns.', 'info');
      toast('Reached simulation time limit. Click Restart to continue from 0 ns.');
    }
  } catch (e) { if (generation === S.generation) fail(e); } finally { S.busy = false; }
}
function setInput(id, value) {
  if (!S.power || S.vcd || S.building || S.importing || S.exporting || S.dirty || S.error || !S.sim || !S.flashed || S.sim.ended || S.inputs[id] === value) return;
  clearMuxDisplayState();
  S.inputs[id] = value; syncKeys();
  if (rtlRunner) {
    const inpName = rtlInputMap.get(id);
    if (inpName) rtlRunner.setInput(inpName, parseInt(value.replace(/[^01]/g, '0'), 2) >>> 0);
    if (!S.running) runRtlStepBatch(0, 0);
    return;
  }
  S.pending.push({ id, value });
  if (!S.running) advance(0);
}
function isNetActive(net) {
  if (net === 'reset_btn') return !!S.keys.reset_btn;
  const idx = KEY_NETS.indexOf(net);
  if (idx !== -1) return !!S.keys[net] || ((S.dip & (1 << idx)) !== 0);
  return false;
}
function updateNetInput(net) {
  const bound = S.bindings[net]; if (!bound || bound.signal.direction !== 1) return;
  const active = isNetActive(net);
  let value = S.inputs[bound.signal.id] ?? '1'.repeat(bound.signal.width);
  if (bound.bit === null) value = active ? '0' : '1';
  else { const bits = [...value]; bits[bound.offset] = active ? '0' : '1'; value = bits.join(''); }
  setInput(bound.signal.id, value);
}
function keyInput(net, pressed) {
  S.keys[net] = pressed;
  updateNetInput(net);
  syncKeys();
}
function toggleDip(index) {
  S.dip ^= (1 << index);
  updateNetInput(KEY_NETS[index]);
  syncKeys();
}
function syncKeys() {
  $$('.key-btn').forEach(button => {
    const net = button.dataset.key === 'reset' ? 'reset_btn' : button.dataset.key.replace('key', 's');
    const bound = S.bindings[net];
    const isDown = !!S.keys[net];
    const isNetLow = Boolean(S.power && S.flashed && bound && S.inputs[bound.signal.id]?.[bound.offset] === '0');
    const active = isDown || isNetLow;
    button.classList.toggle('down', active);
    button.classList.toggle('unmapped', Boolean(S.flashed && !bound));
    button.setAttribute('aria-pressed', String(active));
    button.disabled = false;
    board?.setKeyVisual(button.dataset.key, isDown);
  });
  $$('.dip-btn').forEach(button => {
    const index = Number(button.dataset.dip);
    const isOn = (S.dip & (1 << index)) !== 0;
    button.classList.toggle('on', isOn);
    button.setAttribute('aria-pressed', String(isOn));
    button.disabled = false;
  });
  board?.setDip(S.dip);
}
function releaseKeys() {
  let changed = false;
  for (const net of ['reset_btn', ...KEY_NETS]) {
    if (S.keys[net]) {
      S.keys[net] = false;
      updateNetInput(net);
      changed = true;
    }
  }
  if (changed) syncKeys();
}
function renderVirtualInputs() {
  const wrap = $('#virtualInputs'); wrap.replaceChildren();
  const mapped = new Set(Object.values(S.bindings).map(b => b.signal.id));
  for (const signal of S.sim.signals.filter(s => s.driveable && (!mapped.has(s.id) || s.width > 1) && s.id !== clockId())) {
    const label = document.createElement('label'); label.append(document.createTextNode(signal.short));
    const input = document.createElement('input'); input.dataset.signal = signal.id;
    input.type = signal.width === 1 ? 'checkbox' : 'text'; input.setAttribute('aria-label', signal.short);
    input.title = signal.width === 1 ? 'Drive logical 0 or 1' : `${signal.width} bits, MSB first; 0 1 U X Z W L H -`;
    input.onchange = () => {
      const value = input.type === 'checkbox' ? (input.checked ? '1' : '0') : input.value.toUpperCase();
      if (value.length !== signal.width || !/^[01UXZWLH-]+$/.test(value)) return toast(`Enter exactly ${signal.width} logic bits.`, 'err');
      setInput(signal.id, value);
    };
    label.append(input); wrap.append(label);
  }
  wrap.classList.toggle('hidden', !wrap.children.length);
}
function buildWaves(prevVis = null, prevExp = null) {
  waves.setSignals(S.sim.signals.map(s => ({
    name: s.short,
    width: s.width,
    left: s.left,
    right: s.right,
    kind: s.kind,
    visible: prevVis ? !!prevVis.get(s.short) : false,
    expanded: prevExp ? !!prevExp.get(s.short) : false,
  })));
  renderSignalChips();
}
function updateSignalCount() {
  const total = waves.signals.length;
  const shown = waves.signals.filter(s => s.visible).length;
  $('#signalCount').textContent = total ? `${shown} / ${total} signals` : '0 signals';
}
function renderSignalChips() {
  const box = $('#sigChips');
  box.replaceChildren();
  updateSignalCount();
  if (waves.signals.length) {
    const bulk = document.createElement('span');
    bulk.className = 'sig-bulk';
    const setAll = visible => {
      for (const s of waves.signals) s.visible = visible;
      waves.renderNames();
      waves.resize();
      renderSignalChips();
    };
    const allBtn = document.createElement('button'); allBtn.type = 'button'; allBtn.textContent = 'All'; allBtn.title = 'Show all signals'; allBtn.onclick = () => setAll(true);
    const noneBtn = document.createElement('button'); noneBtn.type = 'button'; noneBtn.textContent = 'None'; noneBtn.title = 'Hide all signals'; noneBtn.onclick = () => setAll(false);
    bulk.append(allBtn, noneBtn);
    box.append(bulk);
  }
  waves.signals.forEach(signal => {
    const real = ['real', 'realtime'].includes(signal.kind);
    const range = signal.width > 1 && !real ? `[${Number.isInteger(signal.left) ? signal.left : signal.width - 1}:${Number.isInteger(signal.right) ? signal.right : 0}]` : '';
    const label = document.createElement('label'); label.className = `sig-chip ${signal.visible ? 'on' : 'off'}`;
    label.title = range ? `${signal.name}${range} (${signal.width}-bit vector — click ▸ in Logic Analyzer to expand bits)` : signal.name;
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = signal.visible; check.setAttribute('aria-label', `Toggle ${signal.name} waveform`);
    const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = signal.color;
    label.append(check, dot, document.createTextNode(`${signal.name}${range}`));
    check.onchange = () => {
      const on = waves.toggle(signal.name);
      check.checked = on;
      label.className = `sig-chip ${on ? 'on' : 'off'}`;
      updateSignalCount();
    };
    box.append(label);
  });
}
function parsePinInput(raw) {
  const clean = String(raw || '').trim();
  if (!clean) return null;
  const m = clean.match(/^(?:pin_|p)?(\d+)$/i);
  if (!m) return NaN;
  const num = Number(m[1]);
  return Number.isInteger(num) && num >= 1 && num <= 144 ? num : NaN;
}
function findPinForPort(portName) {
  const target = String(portName || '').toLowerCase();
  for (const [pin, assigned] of S.assignments.entries()) {
    if (String(assigned || '').trim().toLowerCase() === target) return pin;
  }
  return null;
}
function renderPinoutRef() {
  const body = $('#pinoutRefBody');
  if (!body) return;
  const q = ($('#pinoutSearch')?.value || '').trim().toLowerCase();
  body.replaceChildren();
  for (const grp of BOARD_PINOUT_GROUPS) {
    const matched = grp.pins.filter(p => !q || `${grp.group} pin_${p.pin} ${p.pin} ${p.net} ${p.polarity} ${p.note} ${S.assignments.get(p.pin) || ''}`.toLowerCase().includes(q));
    if (!matched.length) continue;
    const head = document.createElement('tr');
    head.className = 'po-group';
    const td = document.createElement('td');
    td.colSpan = 4;
    td.textContent = grp.group;
    head.append(td);
    body.append(head);
    for (const entry of matched) {
      const tr = document.createElement('tr');
      tr.dataset.pin = entry.pin;
      tr.onclick = () => { if (ide && !ide.boardOpen) ide.setBoardPaneOpen(true); board?.highlightPin(entry.pin); };
      const pinTd = document.createElement('td');
      pinTd.className = 'po-pin';
      pinTd.textContent = `PIN_${entry.pin}`;
      const netTd = document.createElement('td');
      netTd.textContent = entry.net;
      const infoTd = document.createElement('td');
      const pol = document.createElement('span');
      pol.className = 'po-pol';
      pol.textContent = entry.polarity;
      infoTd.append(pol, document.createTextNode(entry.note));
      const assignedTd = document.createElement('td');
      const assignedPort = (S.assignments.get(entry.pin) || '').trim();
      assignedTd.textContent = assignedPort || '—';
      if (assignedPort) assignedTd.className = 'po-assigned';
      tr.append(pinTd, netTd, infoTd, assignedTd);
      body.append(tr);
    }
  }
}
function renderPins() {
  $('#pinBody').replaceChildren();
  const datalist = $('#boardPinList');
  if (datalist && !datalist.children.length) {
    for (const grp of BOARD_PINOUT_GROUPS) {
      for (const p of grp.pins) {
        const opt = document.createElement('option');
        opt.value = `PIN_${p.pin}`;
        opt.label = `${p.net} · ${p.polarity} (${p.note})`;
        datalist.append(opt);
      }
    }
  }
  const hint = $('#pinStepHint');
  if (hint) {
    hint.textContent = S.vcd
      ? 'Recorded waveform replay: enter a board pin number for each signal, or inspect the Board Pinout reference.'
      : !S.discoveredPorts.length
        ? 'Step 2 required: Click Build & Compile first so Trace can detect your entity ports, then type devboard pin numbers here.'
        : S.dirty
          ? 'Step 4 required: Pin assignments changed — click Build & Compile again before flashing to the board.'
          : !S.flashed
            ? `Step 3/5: ${S.discoveredPorts.length} design port${S.discoveredPorts.length === 1 ? '' : 's'} detected. Enter pin numbers (e.g. 88 or PIN_88), then Build & Compile → Flash.`
            : `Flashed to board (${Object.keys(S.bindings).length} pin${Object.keys(S.bindings).length === 1 ? '' : 's'} connected). Editing a pin requires Build & Compile then Flash.`;
  }
  const activeNets = board?.selectedPart?.nets || [];
  const rows = [];
  const seenPorts = new Set();
  if (S.vcd && S.sim) {
    for (const s of S.sim.signals.filter(sig => sig.scope === S.vcd.scope && !['real', 'realtime'].includes(sig.kind))) {
      const base = s.localName.toLowerCase();
      if (s.width === 1) { rows.push({ name: base, label: s.localName, dir: 'VCD' }); seenPorts.add(base); }
      else if (Number.isInteger(s.left) && Number.isInteger(s.right)) {
        const step = s.left <= s.right ? 1 : -1;
        for (let b = s.left; b !== s.right + step; b += step) {
          rows.push({ name: `${base}[${b}]`, label: `${s.localName}[${b}]`, dir: 'VCD' });
          seenPorts.add(`${base}[${b}]`);
        }
      }
    }
  } else {
    for (const p of S.discoveredPorts || []) {
      rows.push(p);
      seenPorts.add(p.name);
    }
    for (const [, assigned] of S.assignments.entries()) {
      const clean = String(assigned || '').trim().toLowerCase();
      if (clean && !seenPorts.has(clean)) {
        rows.push({ name: clean, label: clean, dir: 'QSF' });
        seenPorts.add(clean);
      }
    }
  }
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'empty';
    td.textContent = 'No design ports detected yet. Click Build & Compile to discover entity ports.';
    tr.append(td);
    $('#pinBody').append(tr);
  }
  const focusPinRow = idx => {
    const inputs = $$('#pinBody input');
    if (idx < 0 || idx >= inputs.length) return;
    const next = inputs[idx];
    if (!next || next.disabled) return;
    next.closest('tr')?.scrollIntoView({ block: 'nearest' });
    next.focus();
    next.select();
  };
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const port = rows[rowIndex];
    const currentPin = findPinForPort(port.name);
    const boardNet = currentPin ? (PIN_NET[currentPin] || '') : '';
    const bound = boardNet ? S.bindings[boardNet] : null;
    const tr = document.createElement('tr');
    tr.dataset.port = port.name;
    if (boardNet) tr.dataset.net = boardNet;
    if (currentPin) tr.dataset.pin = currentPin;
    if (boardNet && activeNets.includes(boardNet)) tr.classList.add('selected-pin');
    tr.onclick = e => {
      if (e.target.tagName !== 'INPUT' && currentPin) {
        if (ide && !ide.boardOpen) ide.setBoardPaneOpen(true);
        board?.highlightPin(currentPin);
      }
    };
    const nameCell = document.createElement('td');
    nameCell.textContent = port.label;
    const dirCell = document.createElement('td');
    const dirBadge = document.createElement('span');
    dirBadge.className = `pin-dir ${port.dir.toLowerCase()}`;
    dirBadge.textContent = port.dir;
    dirCell.append(dirBadge);
    const locCell = document.createElement('td');
    const input = document.createElement('input');
    input.value = currentPin ? `PIN_${currentPin}` : '';
    input.placeholder = 'PIN_...';
    input.setAttribute('list', 'boardPinList');
    input.setAttribute('aria-label', `${port.label} pin location`);
    input.title = currentPin ? `Assigned to PIN_${currentPin}${boardNet ? ` (${boardNet})` : ''}` : 'Enter devboard pin number (1–144), e.g. 88 or PIN_88';
    input.className = bound ? 'mapped' : currentPin ? 'assigned' : 'unmapped';
    input.disabled = S.building || S.importing;
    let committed = false;
    const commitInput = (moveDelta = 0) => {
      const parsed = parsePinInput(input.value);
      if (Number.isNaN(parsed)) {
        toast('Enter a valid EP4CE6 pin number from 1 to 144 (e.g. 88 or PIN_88).', 'err');
        input.value = currentPin ? `PIN_${currentPin}` : '';
        input.select();
        return false;
      }
      if (parsed !== null) {
        const existingOwner = (S.assignments.get(parsed) || '').trim().toLowerCase();
        if (existingOwner && existingOwner !== port.name) {
          toast(`PIN_${parsed} is already assigned to ${existingOwner}. Clear or change it first.`, 'err');
          input.value = currentPin ? `PIN_${currentPin}` : '';
          input.select();
          return false;
        }
      }
      if (parsed === currentPin) {
        input.value = currentPin ? `PIN_${currentPin}` : '';
        if (moveDelta !== 0) focusPinRow(rowIndex + moveDelta);
        return true;
      }
      committed = true;
      if (currentPin !== null) S.assignments.delete(currentPin);
      if (parsed !== null) {
        S.assignments.set(parsed, port.name);
        board?.highlightPin(parsed);
      }
      saveProject();
      if (S.vcd) { buildBindings(); renderPins(); board?.clearOutputs(); sampleOutputs(); }
      else { markDirty(); renderPins(); toast(parsed ? `Assigned ${port.label} → PIN_${parsed}${PIN_NET[parsed] ? ` (${PIN_NET[parsed]})` : ''}. Click Build & Compile before flashing.` : `Unassigned ${port.label}. Click Build & Compile before flashing.`); }
      if (moveDelta !== 0) focusPinRow(rowIndex + moveDelta);
      return true;
    };
    input.onchange = () => { if (!committed) commitInput(0); };
    input.onkeydown = e => {
      if (e.key === 'Enter') { e.preventDefault(); commitInput(e.shiftKey ? -1 : 1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); commitInput(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); commitInput(-1); }
      else if (e.key === 'Escape') { e.preventDefault(); input.value = currentPin ? `PIN_${currentPin}` : ''; input.blur(); }
    };
    locCell.append(input);
    const netCell = document.createElement('td');
    const netSpan = document.createElement('span');
    netSpan.className = `pin-net-tag${boardNet ? '' : ' empty'}`;
    netSpan.textContent = boardNet || (currentPin ? 'GPIO' : '—');
    netCell.append(netSpan);
    tr.append(nameCell, dirCell, locCell, netCell);
    $('#pinBody').append(tr);
  }
  renderPinoutRef();
  if (board?.selectedPart) renderInspector(board.selectedPart);
}
function renderInspector(part) {
  const card = $('#compInspector'), centerBtn = $('#btnCenterComp');
  $$('#pinBody tr').forEach(tr => tr.classList.toggle('selected-pin', !!part && part.nets.includes(tr.dataset.net)));
  const partPins = new Set((part?.nets || []).map(n => String(NET_PIN[n] || '')).filter(Boolean));
  $$('#pinoutRefBody tr').forEach(tr => tr.classList.toggle('selected-pin', !!part && partPins.has(tr.dataset.pin)));
  if (centerBtn) {
    centerBtn.classList.toggle('has-target', !!part);
    centerBtn.title = part ? `Center camera on ${part.title} (F)` : 'Center camera on selected component or reset view (F)';
  }
  if (!card) return;
  if (!part) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  $('#ciCategory').textContent = part.category;
  $('#ciTitle').textContent = part.title;
  $('#ciPart').textContent = part.part;
  $('#ciNote').textContent = part.note;
  const netsBox = $('#ciNets'), pinsBtn = $('#ciPins');
  netsBox.replaceChildren();
  if (part.nets.length) {
    netsBox.classList.remove('hidden');
    pinsBtn.classList.remove('hidden');
    for (const net of part.nets) {
      const pin = NET_PIN[net], bound = S.bindings[net];
      const portName = bound ? (bound.bit === null ? bound.signal.short : `${bound.signal.short}[${bound.bit}]`) : null;
      const chip = document.createElement('span'); chip.className = 'ci-chip';
      const label = document.createElement('b'); label.textContent = net;
      const meta = document.createTextNode(`${pin ? ` · P${pin}` : ''}${portName && portName !== net ? ` → ${portName}` : ''}`);
      const val = document.createElement('span'); val.className = 'ci-val'; val.dataset.ciNet = net;
      const stateVal = S.power ? boardValue(net) : '—';
      val.textContent = stateVal; val.classList.toggle('hi', /[1H]/.test(stateVal));
      chip.append(label, meta, val); netsBox.append(chip);
    }
  } else {
    netsBox.classList.add('hidden');
    pinsBtn.classList.add('hidden');
  }
}
function syncViewportHint() {
  const hint = $('#viewportHint');
  if (!hint) return;
  const tool = board?.toolMode === 'select' ? 'Click: Select' : 'Click: Interact';
  const nav = board?.navMode === 'pan' ? 'Drag: Pan' : 'Drag: Orbit';
  hint.innerHTML = `<i class="orbit-icon">↔</i> ${tool} <b>·</b> ${nav} <b>·</b> Scroll: Zoom`;
}
function uartSample() {
  const result = uart.sample(S.time, boardValue('uart_txd'), Number($('#uartBaud').value));
  result.errors.forEach(message => log(message, 'warning'));
  if (result.bytes.length) { const output = $('#uartOut'); output.textContent = (output.textContent + String.fromCharCode(...result.bytes)).slice(-16384); output.scrollTop = output.scrollHeight; }
}
function syncTruthExportButtons() {
  const hasRows = ($('#truthBody')?.children.length || 0) > 0;
  if ($('#btnTruthCopy')) $('#btnTruthCopy').disabled = !hasRows;
  if ($('#btnTruthExport')) $('#btnTruthExport').disabled = !hasRows;
}
function formatTruthTable(format = $('#truthFormat')?.value || 'tsv') {
  const headers = $$('#truthHead th').map(th => th.textContent || '');
  const rows = $$('#truthBody tr').map(tr => [...tr.children].map(td => td.textContent || ''));
  if (!headers.length || !rows.length) return null;
  const spec = {
    tsv: { sep: '\t', ext: 'tsv', mime: 'text/tab-separated-values;charset=utf-8', label: 'TSV' },
    csv: { sep: ',', ext: 'csv', mime: 'text/csv;charset=utf-8', label: 'CSV' },
    psv: { sep: '|', ext: 'psv', mime: 'text/plain;charset=utf-8', label: 'PSV' },
  }[format] || { sep: '\t', ext: 'tsv', mime: 'text/tab-separated-values;charset=utf-8', label: 'TSV' };
  const esc = cell => (cell.includes(spec.sep) || cell.includes('"') || /[\r\n]/.test(cell)) ? `"${cell.replace(/"/g, '""')}"` : cell;
  const lines = [headers, ...rows].map(r => r.map(esc).join(spec.sep));
  return { ...spec, text: lines.join('\n') + '\n', count: rows.length };
}
async function copyTruthTable() {
  const formatted = formatTruthTable();
  if (!formatted) return toast('Generate a truth table first.', 'err');
  try {
    await navigator.clipboard.writeText(formatted.text);
  } catch {
    const ta = document.createElement('textarea'); ta.value = formatted.text; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast(`Copied truth table as ${formatted.label} (${formatted.count} rows).`);
}
function exportTruthTable() {
  const formatted = formatTruthTable();
  if (!formatted) return toast('Generate a truth table first.', 'err');
  const slug = (S.sim?.top || 'truth_table').replace(/[^a-z0-9_-]/gi, '_');
  download(formatted.text, `${slug}_truth_table.${formatted.ext}`, formatted.mime);
  toast(`Exported ${slug}_truth_table.${formatted.ext} (${formatted.count} rows).`);
}
function renderTruthInputs() {
  $('#truthInputs').replaceChildren(); $('#truthHead').replaceChildren(); $('#truthBody').replaceChildren(); $('#truthSummary').textContent = '';
  syncTruthExportButtons();
  const clkPortName = (S.compiledAssignments.get(23) || S.assignments.get(23) || '').trim().toLowerCase();
  S.sim.signals.filter(s => s.driveable && s.direction === 1 && s.width === 1 && s.id !== clockId() && s.short.toLowerCase() !== clkPortName).slice(0, 12).forEach((signal, i) => {
    const label = document.createElement('label'); label.className = 'truth-chip'; const input = document.createElement('input'); input.type = 'checkbox'; input.checked = i < 4; input.dataset.truth = signal.short;
    label.append(input, document.createTextNode(signal.short)); $('#truthInputs').append(label);
  });
}
async function runTruth() {
  const names = $$('#truthInputs input:checked').map(input => input.dataset.truth);
  if (!S.sim || S.vcd || !names.length || names.length > 8) return toast('Select 1–8 scalar inputs from a compiled design.', 'err');
  if (S.truthBusy || S.dirty || S.building || S.error) return;
  S.truthBusy = true; setStatus(); let isolated; const generation = S.generation;
  const baseInputs = new Map(S.sim.signals.map(s => [s.name, S.inputs[s.id]]));
  try {
    isolated = await api('/api/sim/compile', { sources: S.sources, top: S.sim.top, standard: S.standard, topLibrary: S.topLibrary, generics: S.generics, sdf: S.sdf });
    if (generation !== S.generation || S.dirty) return;
    const ins = names.map(n => isolated.signals.find(s => s.name === isolated.top + '.' + n));
    const outs = isolated.signals.filter(s => s.direction === 2 && s.name.startsWith(isolated.top + '.') && !s.name.slice(isolated.top.length + 1).includes('.'));
    const header = document.createElement('tr'); [...names, ...outs.map(s => s.name.split('.').pop())].forEach(n => { const th = document.createElement('th'); th.textContent = n; header.append(th); }); $('#truthHead').replaceChildren(header); $('#truthBody').replaceChildren();
    const activeLowPorts = new Set([25, 88, 89, 90, 91].map(p => (S.compiledAssignments.get(p) || S.assignments.get(p) || '').trim().toLowerCase()).filter(Boolean));
    for (let row = 0; row < 2 ** names.length; row++) {
      const inputs = isolated.signals.filter(s => s.driveable).map(s => {
        const shortLow = s.name.startsWith(isolated.top + '.') ? s.name.slice(isolated.top.length + 1).toLowerCase() : s.name.toLowerCase();
        const fallback = s.width === 1 && activeLowPorts.has(shortLow) ? '1' : '0'.repeat(s.width);
        return { id: s.id, value: (baseInputs.get(s.name) ?? fallback) };
      });
      ins.forEach((s, i) => { inputs.find(p => p.id === s.id).value = String((row >> (names.length - i - 1)) & 1); });
      const result = await api(`/api/sim/${isolated.id}/step`, { cycles: 0, inputs });
      if (generation !== S.generation || S.dirty) return;
      const tr = document.createElement('tr'); [...ins.map(s => inputs.find(p => p.id === s.id).value), ...outs.map(s => result.samples.at(-1).values[s.id])].forEach(v => { const td = document.createElement('td'); td.textContent = v; tr.append(td); }); $('#truthBody').append(tr);
    }
    $('#truthSummary').textContent = `${2 ** names.length} input combinations · isolated GHDL run · no timing advance`;
    syncTruthExportButtons();
  } catch (e) { if (generation === S.generation) { toast(e.message, 'err'); log(e.message, 'error'); } } finally { await closeSession(isolated); S.truthBusy = false; setStatus(); }
}
async function loadFiles(files) {
  if (S.building || S.importing || S.exporting) throw new Error('Wait for the current import, build or export to finish.');
  if (!files.length) return;
  if (files.length > 100) throw new Error('Open at most 100 files at once.');
  const extensions = files.map(f => f.name.split('.').pop().toLowerCase());
  const standalone = extensions.some(e => ['vcd','json','sof','pof'].includes(e));
  if (standalone && files.length !== 1) throw new Error('Open a waveform, saved project, or bitstream separately from source files.');
  const limit = standalone && extensions[0] !== 'json' ? 32 : 6;
  if (files.reduce((n, f) => n + f.size, 0) > limit * 1024 * 1024) throw new Error(`This import exceeds ${limit} MB.`);
  for (const ext of extensions) {
    if (['vo','v','sv'].includes(ext)) throw new Error('Verilog requires a native Verilog simulator and matching vendor libraries. This installation executes VHDL with GHDL; use a VHDL netlist or replay its VCD.');
    if (!['vhd','vhdl','vho','cf','hex','mif','mem','txt','dat','md','qsf','sdf','vcd','json','sof','pof'].includes(ext)) throw new Error(`Unsupported artifact: .${ext}. See About for supported formats.`);
  }
  pause(); S.importing = true; setStatus();
  ide?.showHome(false);
  try {
    if (['sof','pof'].includes(extensions[0])) return await loadBitstream(await files[0].arrayBuffer(), files[0].name);
    const loaded = await Promise.all(files.map(async (file, i) => ({ name: file.name, text: await file.text(), ext: extensions[i] })));
    if (extensions[0] === 'vcd') return await loadVcd(loaded[0].text, loaded[0].name);
    if (extensions[0] === 'json') { await stopAllSimulations(); ide?.closeDiskTabs?.(); restoreProject(JSON.parse(loaded[0].text)); S.importing = false; renderPins(); const st = await restoreSavedCompileState(); toast(st === 'flashed' ? 'Project loaded (restored compiled & flashed state).' : st === 'compiled' ? 'Project loaded (restored compiled state — ready to flash).' : 'Project loaded. Click Compile when ready.'); return; }
    let changed = false, requestedTop;
    let nextSources = S.sources.map(s => ({ ...s }));
    const qsfFiles = loaded.filter(f => f.ext === 'qsf').map(f => ({ ...f, data: parseQsf(f.text) }));
    for (const file of loaded.filter(f => !['qsf','sdf'].includes(f.ext))) {
      if (!/^[a-z0-9_][a-z0-9_. -]*\.(vhd|vhdl|vho|cf|hex|mif|mem|txt|dat|md)$/i.test(file.name)) throw new Error(`Invalid filename: ${file.name}. Use a simple filename without directory separators.`);
      if (nextSources.length === 1 && nextSources[0].name === DEMO_NAME && file.name !== DEMO_NAME) nextSources = [];
      const old = nextSources.find(s => s.name.toLowerCase() === file.name.toLowerCase());
      if (old) old.text = file.text; else nextSources.push({ name: file.name, text: file.text });
      changed = true;
    }
    const sdfFile = loaded.findLast(f => f.ext === 'sdf');
    if (nextSources.length > 100 || JSON.stringify({ sources: nextSources, sdf: sdfFile || S.sdf }).length > 6 * 1024 * 1024) throw new Error('Combined project exceeds 100 files or 6 MB. Remove files before importing.');
    S.sources = nextSources;
    for (const qsf of qsfFiles) {
      for (const ref of qsf.data.files) {
        const source = S.sources.find(s => s.name.toLowerCase() === ref.path.split(/[\\/]/).pop().toLowerCase());
        if (source && ref.library) source.library = ref.library;
      }
      S.assignments = new Map(qsf.data.pins.map(({ pin, target }) => [pin, target.toLowerCase()])); requestedTop = qsf.data.top?.toLowerCase();
      if (qsf.data.device && !/^EP4CE6E22C8N?$/i.test(qsf.data.device)) log(`QSF targets ${qsf.data.device}, not this board's EP4CE6E22C8N. Verify pin compatibility.`, 'warning');
      const missing = qsf.data.files.filter(f => f.lang === 'vhdl' && !S.sources.some(s => s.name.toLowerCase() === f.path.split(/[\\/]/).pop().toLowerCase()));
      if (missing.length) log(`Also open the QSF sources: ${missing.map(f => f.path).join(', ')}. Browser imports do not read other disk files automatically.`, 'warning');
      log(`Imported ${qsf.data.pins.length} pin assignments from ${qsf.name}.`); changed = true;
    }
    renderSources();
    if (requestedTop) { if (allEntities().includes(requestedTop)) $('#topSelect').value = requestedTop; else log(`QSF top ${requestedTop} is not in the loaded sources.`, 'warning'); }
    for (const file of loaded.filter(f => f.ext === 'sdf')) {
      S.sdf = { name: file.name, text: file.text, instance: '/', corner: 'typ' }; renderSdf(); changed = true;
      log('SDF loaded. Verify instance path and min/typ/max corner in Project & compiler settings before building.', 'warning');
    }
    S.importing = false;
    if (S.vcd && !loaded.some(f => f.ext !== 'qsf')) { buildBindings(); renderPins(); sampleOutputs(); saveProject(); }
    else if (changed) { renderPins(); markDirty(); toast('Files loaded. Click Compile when ready.'); }
  } finally { S.importing = false; setStatus(); }
}
function importError(e) { log(e.message, 'error'); toast(e.message, 'err'); openTools('console'); }
function renderHdlTree(result) {
  currentHdlRoot = result?.root || '';
  for (const id of ['hdlRootPath', 'homeHdlRoot']) {
    const el = $('#' + id);
    if (!el) continue;
    el.textContent = currentHdlRoot || 'Not configured';
    el.title = currentHdlRoot || 'Local HDL library folder';
  }
  const groups = result?.groups || [];
  $('#hdlTree').replaceChildren();
  for (const group of groups) {
    const wrap = document.createElement('div'); wrap.className = 'hdl-group';
    const heading = document.createElement('button'); heading.className = 'hdl-dir'; heading.textContent = group.dir; heading.onclick = () => wrap.classList.toggle('open');
    const list = document.createElement('div'); list.className = 'hdl-files';
    for (const file of group.files) {
      const button = document.createElement('button'); button.className = 'hdl-file'; button.dataset.name = `${group.dir}/${file.name}`.toLowerCase();
      const kind = document.createElement('span'); kind.className = 'fk'; kind.textContent = file.kind.toUpperCase(); button.append(kind, document.createTextNode(file.name));
      button.onclick = async () => {
        try {
          if (file.kind === 'qpf') { await openProjectFromDiskPath(file.rel, { promptIfInWorkbench: true }); return; }
          const response = await fetch('/api/hdl/file?path=' + encodeURIComponent(file.rel));
          if (!response.ok) throw new Error('File could not be read.');
          await loadFiles([new File([await response.blob()], file.name)]);
        } catch (e) { toast(e.message, 'err'); }
      };
      list.append(button);
    }
    wrap.append(heading, list); $('#hdlTree').append(wrap);
  }
  ide?.populateHomeHdl(groups);
  if (!groups.length) $('#hdlTree').textContent = 'No HDL files found in this folder. Click Change… to pick another folder.';
}
async function fetchTree() {
  try {
    const result = await fetch('/api/hdl/tree').then(r => r.json());
    renderHdlTree(result);
  } catch { $('#hdlTree').textContent = 'Local library unavailable. Open files to begin.'; }
}
async function changeHdlRoot() {
  try {
    let chosenDir = '';
    if (ide?.openFileBrowserModal) {
      const picked = await ide.openFileBrowserModal({
        mode: 'folder',
        title: 'Choose Local HDL Library Folder',
        eyebrow: 'LOCAL HDL WORKSPACE',
        initialDir: currentHdlRoot || S.projectDir || '',
        confirmText: 'Set Library Folder',
      });
      if (!picked || picked.cancelled || !picked.dir) return;
      chosenDir = picked.dir;
    } else {
      const res = await fetch('/api/hdl/pick-root', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not change Local HDL library folder.');
      if (data.cancelled || !data.root) return;
      chosenDir = data.root;
    }
    const updated = await api('/api/hdl/root', { path: chosenDir });
    if ($('#libSearch')) $('#libSearch').value = '';
    if ($('#homeHdlSearch')) $('#homeHdlSearch').value = '';
    renderHdlTree(updated);
    recordLogEvent('info', `Local HDL library folder changed to ${updated.root}`);
    toast(`Local HDL library set to ${updated.root}`);
  } catch (e) { toast(e.message, 'err'); }
}
async function loadBitstream(buffer, name) {
  const info = await inspectBitstream(buffer, name); openTools('programmer'); $('#progInfo').classList.remove('hidden');
  for (const [id, value] of Object.entries({ piFile: info.filename, piDevice: info.device || 'Unknown', piFamily: info.family || 'Unknown', piVersion: info.version || 'Unknown', piDate: info.date || 'Unknown', piSize: `${(info.size / 1024).toFixed(1)} KB`, piMatch: info.deviceMatch ? 'EP4CE6 family' : 'Not verified', piHash: info.sha256, piNote: info.note })) $('#' + id).textContent = value;
  log(`Inspected ${name}. No configuration was executed. Cyclone IV bitstream execution requires a device-specific decoder/model, which is not implemented.`, 'warning');
}
async function loadVcd(text, name) {
  const vcd = parseVcd(text);
  pause(); ++S.generation; clearRtlRunner(); await closeSession(S.sim);
  const scopes = [...new Set(vcd.vars.map(v => v.scope))];
  const score = scope => vcd.vars.filter(v => v.scope === scope && (Object.hasOwn(NET_PIN, v.shortName.toLowerCase()) || v.shortName.toLowerCase() === 'seven_seg')).length;
  scopes.sort((a, b) => score(b) - score(a) || a.split('.').length - b.split('.').length);
  S.sim = { top: name, signals: vcd.vars.map(v => ({ ...v, short: v.name, localName: v.shortName, driveable: false })) };
  S.vcd = { data: vcd, index: 0, text, scope: scopes[0] }; S.time = 0; S.values.clear(); S.inputs = {}; S.pending = []; S.error = false; S.dirty = false;
  for (const v of vcd.vars) S.values.set(v.name, ['real','realtime'].includes(v.kind) ? '—' : 'U'.repeat(v.width));
  waves.setSignals(vcd.vars.map(v => ({ name: v.name, width: v.width, kind: v.kind, visible: false }))); renderSignalChips();
  $('#replayScope').replaceChildren(...scopes.map(s => new Option(s || '(root)', s))); $('#replayControls').classList.remove('hidden');
  $('#virtualInputs').replaceChildren(); $('#virtualInputs').classList.add('hidden'); $('#designTitle').textContent = name; $('#designSubtitle').textContent = 'Recorded waveform · read-only'; $('.mode-label').textContent = 'VCD replay';
  $('#inputHint').textContent = 'Read-only recorded outputs'; $('#truthInputs').replaceChildren(); $('#truthHead').replaceChildren(); $('#truthBody').replaceChildren(); $('#truthSummary').textContent = '';
  uart.reset(); $('#uartOut').replaceChildren();
  buildBindings(); renderPins(); board?.clearOutputs(); stepPlayback(1); setStatus(); log(`Loaded ${vcd.events.length} timestamps from ${name}. Board scope: ${S.vcd.scope || '(root)'}.`);
}
function stepPlayback(count) {
  for (let i = 0; i < count && S.vcd.index < S.vcd.data.events.length; i++) {
    const event = S.vcd.data.events[S.vcd.index++]; S.time = event.t;
    for (const change of event.changes) for (const variable of S.vcd.data.aliases.get(change.id)) S.values.set(variable.name, typeof change.value === 'object' ? String(change.value.real) : change.value);
    waves.push(S.time, S.values); sampleOutputs(); uartSample();
  }
  $('#roTime').textContent = fmtTime(S.time); $('#replayPosition').textContent = `${S.vcd.index} / ${S.vcd.data.events.length} timestamps`;
  if (S.running || manualStepping) {
    if (S.waveMode === 'follow' && S.time > 0) { waves.follow(S.time, autoFollowSpan()); waves.cursorT = S.time; }
    else if (S.waveMode === 'fit') { waves.fit(); waves.cursorT = S.time; }
  }
  waves.draw();
  if (S.vcd.index >= S.vcd.data.events.length) { S.sim.ended = true; pause(); }
}
async function exportVcd() {
  if (!S.sim || S.building || S.importing || S.exporting) return;
  pause();
  if (S.busy) return toast('The current step is finishing. Export again when it has settled.');
  S.exporting = true; setStatus();
  try {
    const text = S.vcd?.text ?? S.sim.exportedVcd ?? await fetch(`/api/sim/${S.sim.id}/vcd`, { method: 'POST' }).then(async r => { if (!r.ok) throw new Error('Cannot finalize this session.'); return r.text(); });
    if (!S.vcd) { S.sim.ended = true; S.sim.exportedVcd = text; S.pending = []; setStatus('Complete'); syncKeys(); log('Native waveform finalized. Build or restart to run a new simulation.'); }
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); const a = document.createElement('a'); a.href = url; a.download = `${S.sim.top.replace(/\.vcd$/i, '')}.vcd`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { toast(e.message, 'err'); } finally { S.exporting = false; setStatus(); }
}
function syncNavigation() {
  const leftOpen = getComputedStyle($('#left')).display !== 'none';
  const dockOpen = !$('#app').classList.contains('no-waves') || !$('#right').classList.contains('hidden');
  const states = {
    btnLibrary: leftOpen && $('#ltab-library').classList.contains('active'),
    btnPins: leftOpen && $('#ltab-pins').classList.contains('active'),
    btnTools: dockOpen
  };
  for (const [id, open] of Object.entries(states)) {
    const el = $('#' + id);
    if (!el) continue;
    el.classList.toggle('active', open);
    el.setAttribute('aria-expanded', String(open));
  }
}
function leftTab(name) {
  $$('.ltab').forEach(t => t.classList.toggle('active', t.id === 'ltab-' + name));
  const title = $('#leftTitle');
  if (title) title.textContent = name === 'pins' ? 'Pin Planner' : 'Explorer';
  syncNavigation();
}
function toggleLeft(name) {
  const app = $('#app'), open = getComputedStyle($('#left')).display !== 'none';
  const close = open && $('#ltab-' + name).classList.contains('active');
  if (innerWidth <= 1000) app.classList.toggle('mobile-library', !close); else app.classList.toggle('no-library', close);
  leftTab(name);
}
let lastBottomTab = 'waves';
function openBottomTab(tab = 'console') {
  lastBottomTab = tab || 'console';
  if (lastBottomTab === 'waves') {
    $('#app').classList.remove('no-waves');
    $('#right').classList.add('hidden');
    $$('.dock-tab').forEach(t => { const active = t.dataset.docktab === 'waves'; t.classList.toggle('active', active); t.setAttribute('aria-selected', String(active)); });
    requestAnimationFrame(() => waves?.resize());
  } else {
    $('#app').classList.add('no-waves');
    $('#right').classList.remove('hidden');
    $$('.dock-tab').forEach(t => { const active = t.dataset.docktab === lastBottomTab; t.classList.toggle('active', active); t.setAttribute('aria-selected', String(active)); });
    $$('.rtab').forEach(t => t.classList.toggle('active', t.id === 'rtab-' + lastBottomTab));
    if (lastBottomTab === 'terminal') {
      ide?.ensureTerminalInitialized?.();
    }
  }
  syncNavigation();
}
function closeBottomDock() {
  $('#app').classList.add('no-waves');
  $('#right').classList.add('hidden');
  syncNavigation();
}
function openTools(name = lastBottomTab) {
  openBottomTab(name || 'console');
}
function applyResolvedThemeVisuals(spec) {
  applyThemeToDocument(spec, appSettings);
  const dark = spec.scheme === 'dark';
  $('#btnTheme')?.classList.toggle('active', dark);
  $('#btnTheme')?.setAttribute('aria-pressed', String(dark));
  if ($('#btnTheme')) $('#btnTheme').title = `Color theme: ${spec.name}`;
  if ($('#homeThemeBtn')) $('#homeThemeBtn').title = `Color theme: ${spec.name}`;
  const waveEl = $('#waves');
  if (waveEl) {
    const waveBg = spec.tokens['--wave-bg'] || '';
    const isWaveDark = appSettings.waveCanvasMode === 'always-dark' || (appSettings.waveCanvasMode === 'follow-theme' ? dark : /^#0[0-9]|^#1[0-9]|^#2[0-9]/i.test(waveBg));
    waveEl.dataset.waveDark = isWaveDark ? '1' : '0';
  }
  board?.setTheme();
  if (waves) { waves.setTheme(); renderSignalChips(); }
  ide?.applyTerminalOptions?.({ themeMode: appSettings.termThemeMode });
  if ($('#tpActiveName')) $('#tpActiveName').textContent = spec.name;
  syncThemeCardsSelection();
}
function applyTheme(themeId = activeThemeId, { save = false } = {}) {
  const targetId = normalizeThemeId(themeId) || activeThemeId || 'trace-dark';
  const spec = resolveThemeSpec(targetId, customThemes, appSettings);
  activeThemeId = spec.id;
  applyResolvedThemeVisuals(spec);
  if (save) {
    try { localStorage.setItem('trace.theme', spec.id); } catch {}
    persistAppState({ theme: spec.id });
  }
  return spec;
}
function toggleScheme() {
  const cur = resolveThemeSpec(activeThemeId, customThemes, appSettings);
  const pairs = {
    'trace-dark': 'trace-light', 'trace-light': 'trace-dark',
    'quartus-dark': 'quartus-light', 'quartus-light': 'quartus-dark',
    'solarized-dark': 'solarized-light', 'solarized-light': 'solarized-dark',
  };
  const next = pairs[cur.id] || (cur.scheme === 'dark' ? 'trace-light' : 'trace-dark');
  applyTheme(next, { save: true });
  renderThemePopover();
}
function syncThemeCardsSelection() {
  $$('.tp-item[data-theme-id], .theme-card[data-theme-id]').forEach(el => {
    el.classList.toggle('active', el.dataset.themeId === activeThemeId);
  });
}
function closeThemePopover() {
  $('#themePopover')?.classList.add('hidden');
}
function openThemePopover(anchorEl) {
  const pop = $('#themePopover');
  if (!pop) return;
  renderThemePopover();
  pop.classList.remove('hidden');
  const homeOpen = !!($('#homeView') && !$('#homeView').classList.contains('hidden'));
  const anchor = anchorEl || (homeOpen ? $('#homeThemeBtn') : $('#btnTheme'));
  const rect = anchor?.getBoundingClientRect();
  if (rect) {
    const pw = pop.offsetWidth || 270;
    const ph = pop.offsetHeight || 360;
    let left = homeOpen ? Math.min(rect.left, window.innerWidth - pw - 12) : rect.right + 8;
    let top = homeOpen ? rect.bottom + 8 : Math.min(rect.top, window.innerHeight - ph - 12);
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - ph - 8));
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }
}
function renderThemePopover() {
  const list = $('#tpList');
  if (!list) return;
  list.replaceChildren();
  const all = getAllThemes(customThemes);
  const byCat = new Map();
  for (const t of all) {
    const cat = t.category || 'Themes';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(t);
  }
  for (const [cat, items] of byCat) {
    const hdr = document.createElement('div');
    hdr.className = 'tp-cat';
    hdr.textContent = cat;
    list.append(hdr);
    for (const t of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `tp-item${t.id === activeThemeId ? ' active' : ''}`;
      btn.dataset.themeId = t.id;
      const nameSpan = document.createElement('span');
      nameSpan.textContent = t.name;
      const swWrap = document.createElement('span');
      swWrap.className = 'tp-swatches';
      for (const k of ['--bg', '--surface', '--accent', '--tk-kw']) {
        const sw = document.createElement('i');
        sw.className = 'tp-sw';
        sw.style.background = t.tokens[k] || '#888';
        swWrap.append(sw);
      }
      btn.append(nameSpan, swWrap);
      btn.onclick = () => {
        applyTheme(t.id, { save: true });
        renderThemePopover();
      };
      list.append(btn);
    }
  }
  const activeSpec = resolveThemeSpec(activeThemeId, customThemes, appSettings);
  if ($('#tpActiveName')) $('#tpActiveName').textContent = activeSpec.name;
}
function applyAllSettings({ persist = true } = {}) {
  saveStoredSettings(appSettings);
  applyTheme(activeThemeId);
  waves?.setTimeUnit?.(appSettings.waveTimeUnit || 'auto');
  if ($('#waveTimeUnit')) $('#waveTimeUnit').value = appSettings.waveTimeUnit || 'auto';
  syncWaveModeUI();
  waves?.setMaxSamples?.(appSettings.waveMaxSamples);
  ide?.applyEditorOptions?.({
    fontSize: appSettings.editorFontSize,
    tabSize: appSettings.editorTabSize,
    autoIndent: appSettings.editorAutoIndent,
    highlightLine: appSettings.editorHighlightLine,
  });
  ide?.applyTerminalOptions?.({
    fontSize: appSettings.termFontSize,
    cursorStyle: appSettings.termCursorStyle,
    cursorBlink: appSettings.termCursorBlink,
    themeMode: appSettings.termThemeMode,
  });
  ide?.setWatchExternalEnabled?.(appSettings.watchExternalFiles !== false);
  audio.setVolume(appSettings.masterVolume);
  syncSettingsUI();
  if (persist) persistAppState({ settings: appSettings });
}
function openSettingsModal(tab = '') {
  closeThemePopover();
  const dlg = $('#settingsDialog');
  if (!dlg) return;
  if (tab) switchSettingsTab(tab);
  renderSettingsThemes();
  syncSettingsUI();
  if (!dlg.open) dlg.showModal();
}
function switchSettingsTab(tabId) {
  $$('.set-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.settab === tabId));
  $$('.set-pane').forEach(p => p.classList.toggle('active', p.dataset.setpane === tabId));
}
function renderSettingsThemes() {
  const grid = $('#themePresetGrid');
  if (!grid) return;
  grid.replaceChildren();
  const all = getAllThemes(customThemes);
  for (const t of all) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `theme-card${t.id === activeThemeId ? ' active' : ''}`;
    card.dataset.themeId = t.id;
    const top = document.createElement('div');
    top.className = 'tc-top';
    const title = document.createElement('strong');
    title.textContent = t.name;
    const tag = document.createElement('span');
    tag.className = 'tc-tag mono';
    tag.textContent = t.isCustom ? `CUSTOM · ${t.scheme}` : t.scheme;
    top.append(title, tag);
    const desc = document.createElement('span');
    desc.className = 'tc-desc';
    desc.textContent = t.description || (t.isCustom ? 'User customized workbench palette.' : '');
    const sw = document.createElement('div');
    sw.className = 'tc-swatches';
    for (const k of ['--bg', '--surface', '--accent', '--tk-kw', '--tk-ty', '--wave-c0']) {
      const bar = document.createElement('span');
      bar.style.background = t.tokens[k] || '#888';
      sw.append(bar);
    }
    card.append(top, desc, sw);
    card.onclick = () => {
      applyTheme(t.id, { save: true });
      if (t.isCustom) loadThemeIntoCustomDraft(t);
      syncSettingsUI();
    };
    grid.append(card);
  }
  const cloneSel = $('#ctCloneSelect');
  if (cloneSel) {
    cloneSel.replaceChildren(...all.map(t => new Option(`${t.name} (${t.scheme})`, t.id)));
    cloneSel.value = findThemePreset(activeThemeId, customThemes)?.id || THEME_PRESETS[0].id;
  }
}
function loadThemeIntoCustomDraft(themeObj) {
  const src = resolveThemeSpec(themeObj?.id || activeThemeId, customThemes, { ...appSettings, waveCanvasMode: 'follow-theme', termThemeMode: 'follow-theme' });
  const existingCustom = themeObj?.isCustom ? themeObj : null;
  customDraft = {
    id: existingCustom ? existingCustom.id : null,
    name: existingCustom ? existingCustom.name : `${src.name} Custom`,
    scheme: existingCustom ? existingCustom.scheme : src.scheme,
    tokens: { ...src.baseTokens },
  };
  if ($('#ctName')) $('#ctName').value = customDraft.name;
  if ($('#ctScheme')) $('#ctScheme').value = customDraft.scheme;
  $('#ctDeleteBtn')?.classList.toggle('hidden', !existingCustom);
  if ($('#customStudioBadge')) {
    $('#customStudioBadge').textContent = existingCustom ? `Editing saved theme "${existingCustom.name}"` : `Draft based on ${src.name}`;
  }
  renderCustomTokenGroups();
}
function previewCustomDraftLive() {
  if (!customDraft) return;
  const resolved = resolveThemeSpec('__draft__', [{
    id: customDraft.id || '__draft__',
    name: customDraft.name || 'Custom Preview',
    scheme: customDraft.scheme === 'light' ? 'light' : 'dark',
    tokens: customDraft.tokens,
  }], appSettings);
  applyResolvedThemeVisuals(resolved);
}
function renderCustomTokenGroups() {
  const host = $('#ctGroups');
  if (!host || !customDraft) return;
  host.replaceChildren();
  for (const grp of TOKEN_GROUPS) {
    const box = document.createElement('div');
    box.className = 'ct-group';
    const title = document.createElement('div');
    title.className = 'ct-group-title';
    title.textContent = grp.title;
    const grid = document.createElement('div');
    grid.className = 'ct-grid';
    for (const item of grp.items) {
      const row = document.createElement('label');
      row.className = 'ct-row';
      const lbl = document.createElement('span');
      lbl.textContent = item.label;
      const inputs = document.createElement('div');
      inputs.className = 'ct-inputs';
      const hex = document.createElement('input');
      hex.type = 'text';
      hex.className = 'ct-hex';
      hex.spellcheck = false;
      const currentVal = customDraft.tokens[item.key] || '#888888';
      const cleanHex = normalizeCssHex(currentVal, '#888888');
      hex.value = cleanHex;
      const picker = document.createElement('input');
      picker.type = 'color';
      picker.value = cleanHex;
      const onTokenEdit = val => {
        const nextHex = normalizeCssHex(val, cleanHex);
        customDraft.tokens[item.key] = nextHex;
        picker.value = nextHex;
        hex.value = nextHex;
        if (item.key.startsWith('--wave-') && appSettings.waveCanvasMode === 'always-dark') {
          appSettings.waveCanvasMode = 'custom';
          saveStoredSettings(appSettings);
          syncSettingsUI();
          toast('Waveform Canvas switched to Custom Theme Wave Palette for live preview.');
        }
        if (item.key.startsWith('--term-') && appSettings.termThemeMode === 'always-dark' && customDraft.scheme === 'light') {
          appSettings.termThemeMode = 'follow-theme';
          saveStoredSettings(appSettings);
          syncSettingsUI();
        }
        previewCustomDraftLive();
      };
      picker.addEventListener('input', e => onTokenEdit(e.target.value));
      hex.addEventListener('change', e => onTokenEdit(e.target.value));
      inputs.append(hex, picker);
      row.append(lbl, inputs);
      grid.append(row);
    }
    box.append(title, grid);
    host.append(box);
  }
}
function syncSettingsUI() {
  const modeLabelMap = { 'always-dark': 'Scope Canvas: Dark', 'follow-theme': 'Scope Canvas: Follow', 'custom': 'Scope Canvas: Custom' };
  if ($('#setToggleWaveCanvas')) $('#setToggleWaveCanvas').textContent = modeLabelMap[appSettings.waveCanvasMode] || 'Scope Canvas: Dark';
  if ($('#setEditorFont')) $('#setEditorFont').value = appSettings.editorFontFamily;
  if ($('#setEditorFontSize')) { $('#setEditorFontSize').value = String(appSettings.editorFontSize); if ($('#setEditorFontVal')) $('#setEditorFontVal').textContent = `${appSettings.editorFontSize}px`; }
  if ($('#setEditorTabSize')) $('#setEditorTabSize').value = String(appSettings.editorTabSize);
  if ($('#setEditorWrap')) $('#setEditorWrap').checked = localStorage.getItem('trace.wordWrap') === '1';
  if ($('#setEditorHighlightLine')) $('#setEditorHighlightLine').checked = appSettings.editorHighlightLine !== false;
  if ($('#setEditorAutoIndent')) $('#setEditorAutoIndent').checked = appSettings.editorAutoIndent !== false;
  if ($('#setWaveCanvasMode')) $('#setWaveCanvasMode').value = appSettings.waveCanvasMode || 'always-dark';
  if ($('#setWaveUnit')) $('#setWaveUnit').value = appSettings.waveTimeUnit || 'auto';
  if ($('#setDefaultWaveMode')) $('#setDefaultWaveMode').value = appSettings.defaultWaveMode || 'fit';
  if ($('#setWaveMaxSamples')) $('#setWaveMaxSamples').value = String(appSettings.waveMaxSamples || 40000);
  if ($('#setDefaultClk')) $('#setDefaultClk').value = String(appSettings.defaultClkHz || 50000000);
  if ($('#setDefaultStd')) $('#setDefaultStd').value = appSettings.defaultStandard || '93';
  if ($('#setTermThemeMode')) $('#setTermThemeMode').value = appSettings.termThemeMode || 'always-dark';
  if ($('#setTermFontSize')) { $('#setTermFontSize').value = String(appSettings.termFontSize || 12); if ($('#setTermFontVal')) $('#setTermFontVal').textContent = `${appSettings.termFontSize || 12}px`; }
  if ($('#setTermCursorStyle')) $('#setTermCursorStyle').value = appSettings.termCursorStyle || 'block';
  if ($('#setTermCursorBlink')) $('#setTermCursorBlink').checked = appSettings.termCursorBlink !== false;
  if ($('#setWatchExternal')) $('#setWatchExternal').checked = appSettings.watchExternalFiles !== false;
  if ($('#setHdlRootPath')) $('#setHdlRootPath').textContent = currentHdlRoot || '—';
  if ($('#setConfirmHomeExit')) {
    let skip = false;
    try { skip = localStorage.getItem('trace.skipHomeExitConfirm') === '1'; } catch {}
    $('#setConfirmHomeExit').checked = !skip;
  }
  if ($('#setMasterVolume')) { $('#setMasterVolume').value = String(appSettings.masterVolume ?? 50); if ($('#setVolumeVal')) $('#setVolumeVal').textContent = `${appSettings.masterVolume ?? 50}%`; }
  const gfx = board?.getGfx?.();
  if (gfx && $('#setGfxQuality')) $('#setGfxQuality').value = gfx.quality || 'high';
  if ($('#glow') && $('#setBoardGlow')) {
    $('#setBoardGlow').value = $('#glow').value;
    if ($('#setGlowVal')) $('#setGlowVal').textContent = `${$('#glow').value}%`;
  }
}
function wireSettingsAndThemes() {
  $$('.set-nav-btn').forEach(btn => btn.addEventListener('click', () => switchSettingsTab(btn.dataset.settab)));
  $('#btnSettings')?.addEventListener('click', () => openSettingsModal());
  $('#homeSettingsBtn')?.addEventListener('click', () => openSettingsModal());
  $('#tpOpenCustomizer')?.addEventListener('click', () => openSettingsModal('themes'));
  $('#setNewCustomBtn')?.addEventListener('click', () => {
    const studio = $('#customThemeStudio');
    if (studio) studio.open = true;
    loadThemeIntoCustomDraft(findThemePreset(activeThemeId, customThemes));
    studio?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  $('#customThemeStudio')?.addEventListener('toggle', e => {
    if (e.target.open && !customDraft) loadThemeIntoCustomDraft(findThemePreset(activeThemeId, customThemes));
  });
  $('#setToggleWaveCanvas')?.addEventListener('click', () => {
    const order = ['always-dark', 'follow-theme', 'custom'];
    const idx = order.indexOf(appSettings.waveCanvasMode || 'always-dark');
    appSettings.waveCanvasMode = order[(idx + 1) % order.length];
    applyAllSettings();
  });
  $('#ctCloneSelect')?.addEventListener('change', e => {
    const picked = findThemePreset(e.target.value, customThemes);
    if (picked) {
      loadThemeIntoCustomDraft({ ...picked, isCustom: false });
      previewCustomDraftLive();
    }
  });
  $('#ctName')?.addEventListener('input', e => { if (customDraft) customDraft.name = e.target.value; });
  $('#ctScheme')?.addEventListener('change', e => {
    if (customDraft) {
      customDraft.scheme = e.target.value === 'light' ? 'light' : 'dark';
      previewCustomDraftLive();
    }
  });
  $('#ctApplyLiveBtn')?.addEventListener('click', () => {
    previewCustomDraftLive();
    toast('Live preview applied.');
  });
  $('#ctSaveBtn')?.addEventListener('click', () => {
    if (!customDraft) loadThemeIntoCustomDraft(findThemePreset(activeThemeId, customThemes));
    const name = ($('#ctName')?.value || customDraft.name || 'My Custom Theme').trim().slice(0, 48);
    const id = customDraft.id || `custom-${Date.now().toString(36)}`;
    const savedObj = {
      id,
      name,
      category: 'Custom',
      isCustom: true,
      scheme: $('#ctScheme')?.value === 'light' ? 'light' : 'dark',
      description: 'User customized theme.',
      tokens: { ...customDraft.tokens },
    };
    const idx = customThemes.findIndex(t => t.id === id);
    if (idx >= 0) customThemes[idx] = savedObj;
    else customThemes.push(savedObj);
    saveStoredCustomThemes(customThemes);
    persistAppState({ customThemes });
    customDraft.id = id;
    customDraft.name = name;
    applyTheme(id, { save: true });
    renderSettingsThemes();
    loadThemeIntoCustomDraft(savedObj);
    toast(`Saved custom theme "${name}".`, 'ok');
  });
  $('#ctDeleteBtn')?.addEventListener('click', () => {
    if (!customDraft?.id) return;
    const doomedId = customDraft.id;
    customThemes = customThemes.filter(t => t.id !== doomedId);
    saveStoredCustomThemes(customThemes);
    persistAppState({ customThemes });
    if (activeThemeId === doomedId) applyTheme('trace-dark', { save: true });
    renderSettingsThemes();
    loadThemeIntoCustomDraft(findThemePreset(activeThemeId, customThemes));
    toast('Deleted custom theme.');
  });
  $('#ctExportBtn')?.addEventListener('click', () => {
    const src = customDraft || resolveThemeSpec(activeThemeId, customThemes, appSettings);
    const payload = {
      traceThemeVersion: 1,
      name: ($('#ctName')?.value || src.name || 'custom-theme').trim(),
      scheme: ($('#ctScheme')?.value || src.scheme || 'dark'),
      tokens: customDraft ? customDraft.tokens : src.baseTokens,
    };
    download(JSON.stringify(payload, null, 2), `${payload.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'trace-theme'}.json`, 'application/json');
    toast('Exported theme JSON.');
  });
  $('#ctImportBtn')?.addEventListener('click', () => $('#ctImportFile')?.click());
  $('#ctImportFile')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || typeof parsed.tokens !== 'object') throw new Error('Invalid theme JSON format.');
      const imported = {
        id: `custom-${Date.now().toString(36)}`,
        name: String(parsed.name || file.name.replace(/\.json$/i, '')).slice(0, 48),
        category: 'Custom',
        isCustom: true,
        scheme: parsed.scheme === 'light' ? 'light' : 'dark',
        description: 'Imported custom theme.',
        tokens: { ...THEME_PRESETS[parsed.scheme === 'light' ? 1 : 0].tokens, ...parsed.tokens },
      };
      customThemes.push(imported);
      saveStoredCustomThemes(customThemes);
      persistAppState({ customThemes });
      applyTheme(imported.id, { save: true });
      renderSettingsThemes();
      loadThemeIntoCustomDraft(imported);
      if ($('#customThemeStudio')) $('#customThemeStudio').open = true;
      toast(`Imported theme "${imported.name}".`, 'ok');
    } catch (err) { toast(err.message || 'Could not import theme JSON.', 'err'); }
  });

  // Editor settings
  $('#setEditorFont')?.addEventListener('change', e => { appSettings.editorFontFamily = e.target.value; applyAllSettings(); });
  $('#setEditorFontSize')?.addEventListener('input', e => { appSettings.editorFontSize = Number(e.target.value); applyAllSettings(); });
  $('#setEditorTabSize')?.addEventListener('change', e => { appSettings.editorTabSize = Number(e.target.value); applyAllSettings(); });
  $('#setEditorWrap')?.addEventListener('change', e => { ide?.toggleWordWrap?.(e.target.checked); });
  $('#setEditorHighlightLine')?.addEventListener('change', e => { appSettings.editorHighlightLine = e.target.checked; applyAllSettings(); });
  $('#setEditorAutoIndent')?.addEventListener('change', e => { appSettings.editorAutoIndent = e.target.checked; applyAllSettings(); });

  // Waveforms & Simulator settings
  $('#setWaveCanvasMode')?.addEventListener('change', e => { appSettings.waveCanvasMode = e.target.value; applyAllSettings(); });
  $('#setWaveUnit')?.addEventListener('change', e => { appSettings.waveTimeUnit = e.target.value; applyAllSettings(); });
  $('#setDefaultWaveMode')?.addEventListener('change', e => { appSettings.defaultWaveMode = e.target.value; applyAllSettings(); });
  $('#setWaveMaxSamples')?.addEventListener('change', e => { appSettings.waveMaxSamples = Number(e.target.value); applyAllSettings(); });
  $('#setDefaultClk')?.addEventListener('change', e => {
    appSettings.defaultClkHz = Number(e.target.value);
    if ($('#clkHz')) { $('#clkHz').value = String(appSettings.defaultClkHz); $('#clkHz').dispatchEvent(new Event('change')); }
    applyAllSettings();
  });
  $('#setDefaultStd')?.addEventListener('change', e => {
    appSettings.defaultStandard = e.target.value;
    if ($('#standardSelect')) $('#standardSelect').value = appSettings.defaultStandard;
    applyAllSettings();
  });

  // Terminal & Workspace settings
  $('#setTermThemeMode')?.addEventListener('change', e => { appSettings.termThemeMode = e.target.value; applyAllSettings(); });
  $('#setTermFontSize')?.addEventListener('input', e => { appSettings.termFontSize = Number(e.target.value); applyAllSettings(); });
  $('#setTermCursorStyle')?.addEventListener('change', e => { appSettings.termCursorStyle = e.target.value; applyAllSettings(); });
  $('#setTermCursorBlink')?.addEventListener('change', e => { appSettings.termCursorBlink = e.target.checked; applyAllSettings(); });
  $('#setWatchExternal')?.addEventListener('change', e => { appSettings.watchExternalFiles = e.target.checked; applyAllSettings(); });
  $('#setChangeHdlRootBtn')?.addEventListener('click', () => changeHdlRoot());
  $('#setConfirmHomeExit')?.addEventListener('change', e => {
    ide?.setSkipHomeExitConfirm?.(!e.target.checked);
  });

  // Audio & 3D Board settings
  $('#setMasterVolume')?.addEventListener('input', e => {
    appSettings.masterVolume = Number(e.target.value);
    if (appSettings.masterVolume > 0) audio.resume();
    applyAllSettings();
  });
  $('#setGfxQuality')?.addEventListener('change', e => {
    if ($('#quality')) { $('#quality').value = e.target.value; $('#quality').dispatchEvent(new Event('change')); }
  });
  $('#setBoardGlow')?.addEventListener('input', e => {
    if ($('#glow')) { $('#glow').value = e.target.value; $('#glow').dispatchEvent(new Event('input')); }
    if ($('#setGlowVal')) $('#setGlowVal').textContent = `${e.target.value}%`;
  });
  $('#setResetAllBtn')?.addEventListener('click', () => {
    appSettings = { ...DEFAULT_SETTINGS };
    applyAllSettings();
    applyTheme('trace-dark', { save: true });
    renderSettingsThemes();
    toast('Restored default preferences.');
  });

  // Close theme popover on outside click / Escape
  document.addEventListener('click', e => {
    const pop = $('#themePopover');
    if (!pop || pop.classList.contains('hidden')) return;
    if (e.target.closest('#themePopover, #btnTheme, #homeThemeBtn')) return;
    closeThemePopover();
  });
  window.addEventListener('resize', closeThemePopover);
}
function wire() {
  $('#btnTheme').onclick = () => {
    const pop = $('#themePopover');
    if (pop && !pop.classList.contains('hidden')) closeThemePopover();
    else openThemePopover();
  };
  $('#btnRun').onclick = async () => {
    if (!S.power || S.building || S.importing || S.exporting) return;
    if (S.running) { pause(); recordLogEvent('info', `Simulation paused (${S.sim?.top || 'design'}, ${S.cycles} cycles)`); return; }
    if (ide?.hasUnsaved()) { markDirty(); return toast('Compile and flash your design before running.', 'err'); }
    if (!S.sim || S.sim.ended || S.dirty || S.error) return;
    if (!S.vcd && remainingSimCycles() <= 0) {
      return toast('Reached simulation time limit. Click Restart to continue from 0 ns.');
    }
    if ((appSettings.masterVolume ?? 50) > 0) audio.resume();
    S.running = true; setStatus(); lastFrame = performance.now();
    recordLogEvent('info', `Simulation started (${S.sim.top}, clock=${S.clkHz} Hz)`);
  };
  $('#btnStep').onclick = async () => {
    if (!S.power || S.building || S.importing || S.exporting) return;
    pause();
    if (ide?.hasUnsaved()) { markDirty(); return toast('Compile and flash your design before stepping.', 'err'); }
    manualStepping = true;
    try { await advance(1); } finally { manualStepping = false; }
  };
  $('#btnReset').onclick = restartSimulation;
  $('#speed').oninput = e => { S.speed = Number(e.target.value); $('#rateLabel').textContent = `${(10 ** ((S.speed - 55) / 25)).toFixed(1).replace('.0', '')}×`; };
  $('#clkHz').onchange = e => { S.clkHz = Number(e.target.value); accumulator = 0; saveProject(); log(`Ideal clock: ${S.clkHz} Hz. Execution speed is limited by native simulation and display throughput.`); };
  $('#btnElab').onclick = () => ide ? ide.saveAndCompile() : build(); $('#topSelect').onchange = markDirty;
  $('#btnDemo').onclick = async () => { await stopAllSimulations(); ide?.closeDiskTabs?.(); S.sources = [{ name: DEMO_NAME, text: DEMO_SRC }]; S.assignments.clear(); S.discoveredPorts = []; S.compiledAssignments = new Map(); S.compiledHash = ''; S.flashedHash = ''; S.projectDir = null; S.projectName = 'Counter demo'; S.sdf = null; S.waveMode = appSettings.defaultWaveMode || 'fit'; S.followZoomFactor = 1; syncWaveModeUI(); $('#genericInput').value = ''; $('#topLibrary').value = 'work'; $('#standardSelect').value = '93'; renderSdf(); renderSources(); $('#topSelect').value = DEMO_TOP; $('#designTitle').textContent = 'Counter demo'; $('#designSubtitle').textContent = 'Build needed · VHDL-1993'; renderPins(); syncProjectSaveUI(); ide?.refreshProjectTree?.(); markDirty(); toast('Counter demo loaded. Click Compile when ready.'); };
  $('#btnOpenPinoutRef')?.addEventListener('click', () => openTools('pinout'));
  $('#pinoutSearch')?.addEventListener('input', () => renderPinoutRef());
  for (const id of ['standardSelect', 'topLibrary', 'genericInput', 'sdfInstance', 'sdfCorner']) $('#' + id).onchange = markDirty;
  $('#clearSdf').onclick = () => { S.sdf = null; renderSdf(); markDirty(); };
  $('#replayScope').onchange = e => { S.vcd.scope = e.target.value; buildBindings(); renderPins(); board?.clearOutputs(); sampleOutputs(); };
  $('#btnLedView').onclick = () => camera('leds');
  for (const id of ['dropZone', 'btnQsf']) { const el = $('#' + id); if (el) el.onclick = () => $('#fileInput').click(); }
  $('#fileInput').onchange = async e => { try { await loadFiles([...e.target.files]); } catch (err) { importError(err); } e.target.value = ''; };
  $('#progDrop').onclick = () => $('#progFile').click(); $('#progFile').onchange = e => loadFiles([...e.target.files]).catch(importError);
  window.addEventListener('dragover', e => e.preventDefault()); window.addEventListener('drop', e => { e.preventDefault(); loadFiles([...e.dataTransfer.files]).catch(importError); });
  $('#libSearch').oninput = e => { const query = e.target.value.toLowerCase(); $$('.hdl-group').forEach(group => { let visible = false; group.querySelectorAll('.hdl-file').forEach(file => { const match = file.dataset.name.includes(query); file.hidden = !match; visible ||= match; }); group.hidden = !visible; if (query) group.classList.add('open'); }); };
  $('#btnPinReset').onclick = () => { S.assignments.clear(); saveProject(); if (S.vcd) { buildBindings(); renderPins(); sampleOutputs(); } else { markDirty(); renderPins(); toast('Pin map reset. Click Compile to apply changes.'); } };
  $$('.key-btn').forEach(button => {
    const net = button.dataset.key === 'reset' ? 'reset_btn' : button.dataset.key.replace('key', 's');
    button.onpointerdown = e => { if (button.disabled) return; e.preventDefault(); button.setPointerCapture(e.pointerId); keyInput(net, true); };
    button.onpointerup = button.onpointercancel = button.onlostpointercapture = () => { if (S.keys[net]) keyInput(net, false); };
    button.onkeydown = e => { if (['Enter', ' '].includes(e.key) && !e.repeat) { e.preventDefault(); e.stopPropagation(); keyInput(net, true); } };
    button.onkeyup = e => { if (['Enter', ' '].includes(e.key) && S.keys[net]) { e.preventDefault(); e.stopPropagation(); keyInput(net, false); } };
  });
  $$('.dip-btn').forEach(button => {
    button.onclick = () => toggleDip(Number(button.dataset.dip));
  });
  const keys = { '1': 's1', '2': 's2', '3': 's3', '4': 's4', r: 'reset_btn' };
  const setTool = mode => { board?.setToolMode(mode); $$('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === mode)); $('#lblHideOutline')?.classList.toggle('hidden', mode !== 'select'); syncViewportHint(); };
  const setNav = mode => { board?.setNavMode(mode); $$('[data-nav]').forEach(b => b.classList.toggle('active', b.dataset.nav === mode)); syncViewportHint(); };
  $('#chkHideOutline').onchange = e => board?.setHideOutline(e.target.checked);
  const centerSelection = () => {
    if (board?.selectedPart) {
      board.centerSelected();
      $('#center').classList.add('closeup');
      $$('[data-camera]').forEach(b => b.classList.remove('active'));
    } else {
      camera('hero');
    }
  };
  $$('[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
  $$('[data-nav]').forEach(b => b.onclick = () => setNav(b.dataset.nav));
  $('#btnCenterComp').onclick = centerSelection;
  $('#ciCenter').onclick = centerSelection;
  $('#ciClose').onclick = () => board?.selectPart(null);
  $('#ciPins').onclick = () => {
    const leftClosed = getComputedStyle($('#left')).display === 'none';
    if (leftClosed) {
      if (window.innerWidth <= 1000) $('#app').classList.add('mobile-library');
      else $('#app').classList.remove('no-library');
    }
    leftTab('pins');
    const row = $('#pinBody tr.selected-pin');
    if (row) {
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      const inp = row.querySelector('input');
      if (inp && !inp.disabled) { inp.focus(); inp.select(); }
      return;
    }
    const part = board?.selectedPart;
    const partPins = (part?.nets || []).map(n => NET_PIN[n]).filter(Boolean);
    if (partPins.length) {
      if ($('#pinoutSearch')?.value) { $('#pinoutSearch').value = ''; renderPinoutRef(); }
      openTools('pinout');
      $$('#pinoutRefBody tr.selected-pin').forEach(tr => tr.classList.remove('selected-pin'));
      let firstMatch = null;
      for (const pin of partPins) {
        const refRow = $(`#pinoutRefBody tr[data-pin="${pin}"]`);
        if (refRow) { refRow.classList.add('selected-pin'); if (!firstMatch) firstMatch = refRow; }
      }
      firstMatch?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  };
  window.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod && !e.altKey && !e.shiftKey && e.key === 'F11') { e.preventDefault(); ide?.toggleAppFullscreen?.(); return; }
    const modalOpen = !!document.querySelector('dialog:modal');
    if (e.key === 'Escape' && !$('#themePopover')?.classList.contains('hidden')) {
      e.preventDefault();
      closeThemePopover();
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && e.key === ',') {
      e.preventDefault();
      if ($('#settingsDialog')?.open) $('#settingsDialog').close();
      else openSettingsModal();
      return;
    }
    const homeOpen = !!($('#homeView') && !$('#homeView').classList.contains('hidden'));
    if (e.key === 'Escape' && !modalOpen && homeOpen) { if (ide?.hasActiveSession) ide.resumeWorkbench(); return; }
    if (modalOpen) return;
    if (homeOpen) {
      if (mod && !e.altKey && e.key.toLowerCase() === 'o') { e.preventDefault(); $('#fileInput').click(); }
      return;
    }
    if (mod && e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); ide?.saveActiveFileAs(); return; }
    if (mod && e.altKey && !e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); ide?.showNewFile(); return; }
    if (!mod && e.altKey && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); ide?.toggleWordWrap?.(); return; }
    if (mod && !e.altKey && !e.shiftKey && (e.key === '`' || e.code === 'Backquote')) { e.preventDefault(); ide?.toggleTerminalPane?.(); return; }
    if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'w') { e.preventDefault(); if (ide?.active) ide.closeTab(ide.active); return; }
    if (mod && !e.altKey && (e.key === 'Tab' || e.key === 'PageDown' || e.key === 'PageUp')) { e.preventDefault(); ide?.cycleTab?.(e.shiftKey || e.key === 'PageUp' ? -1 : 1); return; }
    if (mod && !e.altKey && e.shiftKey && e.key.toLowerCase() === 'e') { e.preventDefault(); $('#btnLibrary')?.click(); return; }
    if (mod && !e.altKey && e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); ide?.saveAndCompile(); return; }
    if (mod && !e.altKey && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); saveProjectToDisk({ saveAs: false }); return; }
    if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); ide?.saveActiveFile(); return; }
    if (!mod && !e.altKey && !e.shiftKey && e.key === 'F7') { e.preventDefault(); ide?.saveAndCompile(); return; }
    if (mod && !e.altKey && e.key.toLowerCase() === 'b') { e.preventDefault(); flashToBoard(); return; }
    if (mod && !e.altKey && e.key.toLowerCase() === 'e') { e.preventDefault(); ide?.setEditorPaneOpen(!$('#sourceDialog')?.open); return; }
    if (!mod && e.altKey && e.key.toLowerCase() === 'b') { e.preventDefault(); ide?.setBoardPaneOpen(!ide.boardOpen); return; }
    if (mod && !e.altKey && e.key.toLowerCase() === 'o') { e.preventDefault(); $('#fileInput').click(); return; }
    if (e.target.closest('input,select,textarea') || e.repeat) return;
    if (e.altKey && ['1', '2', '3', '4'].includes(e.key)) { e.preventDefault(); toggleDip(Number(e.key) - 1); return; }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'f') { e.preventDefault(); centerSelection(); return; }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'v') { e.preventDefault(); setTool(board?.toolMode === 'select' ? 'interact' : 'select'); return; }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'p') { e.preventDefault(); togglePhotoMode(); return; }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'h' && $('#center').classList.contains('photo-mode')) { e.preventDefault(); $('#pmHideHudBtn').click(); return; }
    if (keys[e.key.toLowerCase()]) { e.preventDefault(); keyInput(keys[e.key.toLowerCase()], true); }
    if (e.code === 'Space' && e.target.tagName !== 'BUTTON') { e.preventDefault(); $('#btnRun').click(); }
    if (e.key === '.') $('#btnStep').click();
    if (e.key === 'Escape') {
      if ($('#center').classList.contains('photo-mode')) { togglePhotoMode(false); return; }
      $('#right').classList.add('hidden'); $('#deck').classList.add('hidden'); $('#app').classList.remove('mobile-library'); board?.selectPart(null); syncNavigation();
    }
  });
  window.addEventListener('keyup', e => {
    const net = keys[e.key.toLowerCase()];
    if (net && S.keys[net]) keyInput(net, false);
  });
  window.addEventListener('blur', releaseKeys);
  document.addEventListener('visibilitychange', () => { if (document.hidden) { releaseKeys(); pause(); } });
  $('#pwrToggle').onchange = e => { S.power = e.target.checked; pause(); board?.setPower(S.power); recordLogEvent('info', `Board power switched ${S.power ? 'ON' : 'OFF'}`); if (!S.power) { releaseKeys(); board?.clearOutputs(); sampleOutputs(); } else { if (S.flashed) KEY_NETS.forEach(updateNetInput); sampleOutputs(); } syncKeys(); setStatus(); };
  const camera = name => { board?.setCamera(name); $('#center').classList.toggle('closeup', ['leds','fpga','display','dtubes','io','macro_low'].includes(name)); if ($('#camPreset').querySelector(`option[value="${name}"]`)) $('#camPreset').value = name; if ($('#pmCamSelect')) $('#pmCamSelect').value = name; $$('[data-camera]').forEach(b => b.classList.toggle('active', b.dataset.camera === name)); };
  $$('[data-camera]').forEach(b => b.onclick = () => camera(b.dataset.camera)); $('#camPreset').onchange = e => camera(e.target.value);
  $('#btnViewSettings').onclick = () => { $('#deck').classList.toggle('hidden'); $('#btnViewSettings').setAttribute('aria-expanded', String(!$('#deck').classList.contains('hidden'))); };
  $('#deckCollapse').onclick = () => $('#btnViewSettings').click();
  for (const [id, display, setter] of [['explode', 'explodeVal', 'setExplode'], ['glow', 'glowVal', 'setGlow']]) $('#' + id).oninput = e => { $('#' + display).textContent = `${e.target.value}%`; if (id === 'explode' && $('#pmExplode')) { $('#pmExplode').value = e.target.value; $('#pmExplodeVal').textContent = `${e.target.value}%`; } board?.[setter](Number(e.target.value) / 100); if (id === 'glow') syncGfxUI(); };
  for (const [id, setter] of [['tglOrbit', 'setAutoOrbit'], ['tglLabels', 'setLabels'], ['tglGrid', 'setGrid'], ['tglTraces', 'setTraces']]) $('#' + id).onchange = e => { if (id === 'tglOrbit' && $('#pmTglOrbit')) $('#pmTglOrbit').checked = e.target.checked; board?.[setter](e.target.checked); };
  $('#quality').onchange = e => { board?.setQuality(e.target.value); syncGfxUI(); }; $('#btnResetView').onclick = () => camera('hero');
  $('#btnShot').onclick = () => { if (!board) return; const a = document.createElement('a'); a.href = board.screenshot(); a.download = 'trace-board.png'; a.click(); };
  let pmAspect = 'free';
  function formatGfxVal(key, val) {
    if (['fov', 'cameraRoll', 'envRotation', 'keyAzimuth', 'keyElevation', 'rimAzimuth', 'rimElevation'].includes(key)) return `${val}°`;
    if (key === 'dofFocus') return `${val}mm`;
    if (key === 'orbitSpeed') return `${val}×`;
    if (['exposure', 'keyIntensity', 'rimIntensity', 'fillIntensity', 'hemiIntensity', 'cursorLightInt', 'temperature', 'tint', 'shadowBias'].includes(key)) return String(val);
    return `${val}%`;
  }
  function syncGfxUI() {
    const g = board?.getGfx();
    if (!g) return;
    $$('[data-gfx]').forEach(el => {
      const k = el.dataset.gfx;
      if (g[k] === undefined) return;
      if (el.type === 'checkbox') el.checked = !!g[k];
      else if (document.activeElement !== el || el.tagName === 'SELECT') el.value = String(g[k]);
    });
    $$('[data-gfx-val]').forEach(el => {
      const k = el.dataset.gfxVal;
      if (g[k] !== undefined) el.textContent = formatGfxVal(k, g[k]);
    });
    if ($('#glow') && document.activeElement !== $('#glow')) {
      $('#glow').value = String(Math.min(100, g.ledGlow));
      $('#glowVal').textContent = `${g.ledGlow}%`;
    }
    $('#center').classList.toggle('bg-transparent', g.bgMode === 'transparent');
    const focalMm = Math.round(24 / (2 * Math.tan((g.fov * 0.5) * Math.PI / 180)));
    if ($('#pmReadout')) $('#pmReadout').textContent = `${focalMm}mm · ${g.fov}° · ${g.shadingMode.toUpperCase()}${g.dof > 0 ? ` · DoF ${g.dofFocus}mm` : ''}`;
    syncAllRangeFills();
  }
  function updateRangeFill(el) {
    if (!el || el.type !== 'range') return;
    const min = Number(el.min || 0), max = Number(el.max || 100), val = Number(el.value || 0);
    const pct = max > min ? Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100)) : 0;
    el.style.setProperty('--fill', `${pct.toFixed(2)}%`);
  }
  function syncAllRangeFills() {
    $$('input[type="range"]').forEach(updateRangeFill);
  }
  $$('input[type="range"]').forEach(el => {
    const def = el.getAttribute('value') ?? el.defaultValue ?? el.value;
    el.dataset.defaultValue = def;
    if (!el.title) el.title = 'Double-click to reset to default';
    else if (!/double-click/i.test(el.title)) el.title += ' (double-click to reset)';
    updateRangeFill(el);
    el.addEventListener('input', () => updateRangeFill(el));
    el.addEventListener('change', () => updateRangeFill(el));
    el.addEventListener('dblclick', e => {
      e.preventDefault();
      el.value = el.dataset.defaultValue;
      updateRangeFill(el);
      el.classList.remove('slider-reset-pop');
      void el.offsetWidth;
      el.classList.add('slider-reset-pop');
      clearTimeout(el._popTimer);
      el._popTimer = setTimeout(() => el.classList.remove('slider-reset-pop'), 220);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
  $$('[data-gfx]').forEach(el => {
    const handler = () => {
      const k = el.dataset.gfx;
      const val = el.type === 'checkbox' ? el.checked : (el.type === 'range' || k === 'fpsCap') ? Number(el.value) : el.value;
      if (k === 'quality') board?.setQuality(val);
      board?.setGfx({ [k]: val });
      syncGfxUI();
    };
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
  });
  function updatePhotoFrameBox() {
    const wrap = $('#pmFrameWrap'), box = $('#pmFrameBox');
    if (!wrap || !box) return;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h || pmAspect === 'free') { box.style.width = '100%'; box.style.height = '100%'; return; }
    const ratios = { '16:9': 16 / 9, '21:9': 21 / 9, '4:3': 4 / 3, '3:2': 3 / 2, '1:1': 1, '9:16': 9 / 16 };
    const r = ratios[pmAspect] || (w / h);
    let bw = w, bh = Math.round(w / r);
    if (bh > h) { bh = h; bw = Math.round(h * r); }
    box.style.width = `${bw}px`; box.style.height = `${bh}px`;
  }
  if ($('#pmFrameWrap')) new ResizeObserver(updatePhotoFrameBox).observe($('#pmFrameWrap'));
  function togglePhotoMode(force) {
    const active = force !== undefined ? !!force : !$('#center').classList.contains('photo-mode');
    if (active && ide && !ide.boardOpen) ide.setBoardPaneOpen(true);
    $('#center').classList.toggle('photo-mode', active);
    $('#photoStudio').classList.toggle('hidden', !active);
    $('#btnPhotoMode').classList.toggle('active', active);
    $('#btnPhotoMode').setAttribute('aria-expanded', String(active));
    if (active) {
      $('#deck').classList.add('hidden');
      $('#btnViewSettings').setAttribute('aria-expanded', 'false');
      syncGfxUI();
      requestAnimationFrame(updatePhotoFrameBox);
    } else {
      $('#app').classList.remove('photo-theater');
      $('#pmTheaterBtn').classList.remove('active');
      $('#pmTheaterBtn').textContent = 'Maximize';
      $('#photoStudio').classList.remove('hud-hidden');
      $('#pmHideHudBtn').classList.remove('active');
      $('#pmHideHudBtn').textContent = 'Hide HUD';
      board?.setPhotoFocusMode(false);
      $('#pmFocusPickBtn')?.classList.remove('active');
      if (board?.stagePose?.enabled) {
        board.setStagePose({ enabled: false });
        if ($('#pmStageEnable')) $('#pmStageEnable').checked = false;
        sampleOutputs();
      }
    }
  }
  $('#btnPhotoMode').onclick = () => togglePhotoMode();
  $('#btnOpenPhotoStudio').onclick = () => togglePhotoMode(true);
  $('#pmCloseBtn').onclick = () => togglePhotoMode(false);
  $('#btnResetGfx').onclick = $('#pmResetFxBtn').onclick = () => { board?.resetGfx(); syncGfxUI(); toast('Graphics, lighting and post-FX reset to defaults.'); };
  $$('[data-pm-aspect]').forEach(b => b.onclick = () => {
    pmAspect = b.dataset.pmAspect;
    $$('[data-pm-aspect]').forEach(x => x.classList.toggle('active', x === b));
    updatePhotoFrameBox();
  });
  $('#pmGridSelect').onchange = e => { $('#pmFrameBox').dataset.grid = e.target.value; };
  $('#pmFocusPickBtn').onclick = () => {
    const next = !board?.photoFocusMode;
    board?.setPhotoFocusMode(next);
    $('#pmFocusPickBtn').classList.toggle('active', next);
    if (next) toast('Click any part on the 3D board to focus the lens on that surface.');
  };
  $('#pmTheaterBtn').onclick = () => {
    const on = $('#app').classList.toggle('photo-theater');
    $('#pmTheaterBtn').classList.toggle('active', on);
    $('#pmTheaterBtn').textContent = on ? 'Restore' : 'Maximize';
    setTimeout(updatePhotoFrameBox, 50);
  };
  $('#pmHideHudBtn').onclick = () => {
    const on = $('#photoStudio').classList.toggle('hud-hidden');
    $('#pmHideHudBtn').classList.toggle('active', on);
    $('#pmHideHudBtn').textContent = on ? 'Show HUD' : 'Hide HUD';
  };
  $$('[data-pmtab]').forEach(b => b.onclick = () => {
    $$('[data-pmtab]').forEach(t => t.classList.toggle('active', t === b));
    $$('.pm-tab-body').forEach(p => p.classList.toggle('active', p.id === 'pmtab-' + b.dataset.pmtab));
  });
  $('#pmCamSelect').onchange = e => camera(e.target.value);
  $('#pmTglOrbit').onchange = e => { $('#tglOrbit').checked = e.target.checked; board?.setAutoOrbit(e.target.checked); };
  $('#pmExplode').oninput = e => { $('#explode').value = e.target.value; $('#explodeVal').textContent = $('#pmExplodeVal').textContent = `${e.target.value}%`; board?.setExplode(Number(e.target.value) / 100); };
  const syncStagePose = () => {
    board?.setStagePose({
      enabled: $('#pmStageEnable').checked,
      text: $('#pmStageText').value,
      leds: $$('.pm-stage-led').map(c => c.checked),
    });
    if (!$('#pmStageEnable').checked) sampleOutputs();
  };
  $('#pmStageEnable').onchange = syncStagePose;
  $('#pmStageText').oninput = () => { if (!$('#pmStageEnable').checked) $('#pmStageEnable').checked = true; syncStagePose(); };
  $$('.pm-stage-led').forEach(c => c.onchange = () => { if (!$('#pmStageEnable').checked) $('#pmStageEnable').checked = true; syncStagePose(); });
  function triggerShutterFlash() {
    const fl = $('#pmFlash');
    if (!fl) return;
    fl.classList.add('active');
    audio.click(true);
    requestAnimationFrame(() => requestAnimationFrame(() => fl.classList.remove('active')));
  }
  function captureStudioShot(downloadFile = true) {
    if (!board) return null;
    triggerShutterFlash();
    const shot = board.capturePhoto({
      resolution: $('#pmResolution').value,
      aspect: pmAspect,
      format: $('#pmFormat').value,
      transparent: $('#pmTransparent').checked,
      stamp: $('#pmStampPos').value,
      caption: $('#pmStampCaption').value.trim(),
      simInfo: S.sim ? `${S.sim.top} · ${fmtTime(S.time)}` : '',
    });
    const ext = shot.format === 'jpeg' ? 'jpg' : shot.format;
    const filename = `trace-photo-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${ext}`;
    if (downloadFile) {
      const a = document.createElement('a'); a.href = shot.dataUrl; a.download = filename; a.click();
      toast(`Saved ${filename} (${shot.width}×${shot.height}).`);
    }
    const strip = $('#pmFilmstrip');
    if (strip) {
      const btn = document.createElement('button'); btn.className = 'pm-thumb'; btn.title = `Download ${filename} (${shot.width}×${shot.height})`;
      const img = document.createElement('img'); img.src = shot.dataUrl; img.alt = filename;
      const badge = document.createElement('span'); badge.textContent = `${shot.width}×${shot.height}`;
      btn.append(img, badge);
      btn.onclick = () => { const a = document.createElement('a'); a.href = shot.dataUrl; a.download = filename; a.click(); };
      strip.prepend(btn);
      while (strip.children.length > 8) strip.lastChild.remove();
    }
    return shot;
  }
  $('#pmShutterBtn').onclick = () => captureStudioShot(true);
  $('#pmCopyBtn').onclick = async () => {
    const shot = captureStudioShot(false);
    if (!shot) return;
    try {
      const blob = await fetch(shot.dataUrl).then(r => r.blob());
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      toast(`Copied ${shot.width}×${shot.height} studio photo to clipboard.`);
    } catch {
      const ext = shot.format === 'jpeg' ? 'jpg' : shot.format;
      const a = document.createElement('a'); a.href = shot.dataUrl; a.download = `trace-photo.${ext}`; a.click();
      toast(`Clipboard image copy unavailable; downloaded ${shot.width}×${shot.height} image instead.`);
    }
  };
  $('#btnVcd').onclick = exportVcd;
  $('#waveZoomIn').onclick = () => zoomWaveform(1 / 1.4);
  $('#waveZoomOut').onclick = () => zoomWaveform(1.4);
  $$('#waveModeGroup [data-wave-mode]').forEach(btn => {
    btn.onclick = () => setWaveMode(btn.dataset.waveMode);
  });
  if ($('#waveTimeUnit')) $('#waveTimeUnit').onchange = e => { waves.setTimeUnit(e.target.value); if (S.waveMode === 'follow' && S.time > 0) { waves.follow(S.time, autoFollowSpan()); waves.draw(); } };
  waves.canPan = () => S.waveMode === 'free';
  waves.canZoom = () => S.waveMode === 'free';
  waves.onCustomZoom = (factor, cursorT) => zoomWaveform(factor, cursorT);
  waves.onLockedAction = kind => notifyWaveLocked(kind);
  waves.onCursor = time => $('#waveCursor').textContent = time === null ? 'Cursor —' : `Cursor ${fmtTime(time, waves.timeUnit)}`;
  syncWaveModeUI();
  $('#btnLibrary').onclick = () => toggleLeft('library');
  if ($('#btnChangeHdlRoot')) $('#btnChangeHdlRoot').onclick = changeHdlRoot;
  if ($('#homeChangeHdlRoot')) $('#homeChangeHdlRoot').onclick = changeHdlRoot;
  $('#btnPins').onclick = () => toggleLeft('pins'); $('#closeLeft').onclick = () => { $('#app').classList.remove('mobile-library'); $('#app').classList.add('no-library'); syncNavigation(); };
  $('#btnTools').onclick = () => (!$('#app').classList.contains('no-waves') || !$('#right').classList.contains('hidden')) ? closeBottomDock() : openBottomTab(lastBottomTab);
  $('#closeRight').onclick = closeBottomDock;
  $$('[data-ltab]').forEach(b => b.onclick = () => leftTab(b.dataset.ltab)); $$('[data-docktab]').forEach(b => b.onclick = () => openBottomTab(b.dataset.docktab));
  for (const id of ['btnAbout', 'btnLimits']) $('#' + id).onclick = () => $('#aboutDialog').showModal();
  $$('[data-close]').forEach(b => b.onclick = () => $('#' + b.dataset.close).close());
  $('#consoleClear').onclick = () => { $('#consoleOut').replaceChildren(); $('#consoleCount').textContent = consoleCount = 0; };
  $('#consoleCopy').onclick = copyConsole;
  $('#uartClear').onclick = () => $('#uartOut').replaceChildren(); $('#btnTruth').onclick = runTruth;
  if ($('#btnTruthCopy')) $('#btnTruthCopy').onclick = copyTruthTable;
  if ($('#btnTruthExport')) $('#btnTruthExport').onclick = exportTruthTable;
  window.addEventListener('pagehide', () => { flushState(true); flushActions(true); flushEvents(true); if (S.sim?.id) navigator.sendBeacon(`/api/sim/${S.sim.id}/close`, ''); });
}
function frame(now) {
  requestAnimationFrame(frame); const dt = Math.max(0, Math.min(.1, (now - lastFrame) / 1000)); lastFrame = now;
  if (now - lastDraw > 250) { $('#roFps').textContent = board ? Math.round(board.fps) : '—'; lastDraw = now; }
  if (S.running) {
    if (multiDigitFrame) {
      applyDisplayFrame(multiDigitFrame);
    } else {
      let nextFrame = null;
      for (let step = 1; step <= 4; step++) {
        const idx = (muxCursor + step) % 4;
        if (muxSlots[idx]) {
          muxCursor = idx;
          nextFrame = muxSlots[idx];
          break;
        }
      }
      if (nextFrame) applyDisplayFrame(nextFrame);
      else sampleDisplayOnly();
    }
    const rate = 10 ** ((S.speed - 55) / 25);
    if (rtlRunner && !S.vcd) {
      const frameDt = Math.min(0.04, dt);
      const stepWall = frameDt * rate;
      accumulator += S.clkHz * stepWall;
      accumulator = Math.min(accumulator, 5000000);
      const cycles = Math.min(2500000, Math.floor(accumulator));
      if (Number.isInteger(cycles) && cycles > 0) {
        accumulator = Math.max(0, accumulator - cycles);
        runRtlStepBatch(cycles, frameDt);
      }
    } else {
      const maxPerFrame = S.clkHz >= 10000 ? adaptiveMaxCycles : 4096;
      const stepWall = dt * rate;
      wallTimeAccum = Math.min(0.25 * rate, wallTimeAccum + stepWall);
      accumulator += S.clkHz * stepWall;
      accumulator = Math.min(accumulator, maxPerFrame * 2);
      if (!S.busy) {
        let cycles = Math.min(maxPerFrame, Math.floor(accumulator));
        if (cycles > 1) cycles |= 1;
        if (Number.isInteger(cycles) && cycles > 0) {
          const wallSec = wallTimeAccum;
          wallTimeAccum = 0;
          accumulator = Math.max(0, accumulator - cycles);
          advance(cycles, wallSec);
        }
      }
    }
  }
  else if (!S.running && S.pending.length && !S.busy && !S.building) advance(0);
}
async function hydrateDiskState() {
  try {
    const res = await fetch('/api/state');
    if (!res.ok) return;
    const data = await res.json();
    const st = data?.state;
    if (!st || typeof st !== 'object') return;
    if (st.theme && typeof st.theme === 'string') {
      activeThemeId = normalizeThemeId(st.theme);
      try { localStorage.setItem('trace.theme', activeThemeId); } catch {}
    }
    if (Array.isArray(st.customThemes)) {
      customThemes = st.customThemes.filter(t => t && t.id && t.name && t.tokens);
      saveStoredCustomThemes(customThemes);
    }
    if (st.settings && typeof st.settings === 'object') {
      appSettings = { ...DEFAULT_SETTINGS, ...st.settings };
      saveStoredSettings(appSettings);
    }
    if (st.projectWaveModes && typeof st.projectWaveModes === 'object') {
      projectWaveModes = { ...projectWaveModes, ...st.projectWaveModes };
      try { localStorage.setItem('trace.projectWaveModes.v1', JSON.stringify(projectWaveModes)); } catch {}
    }
    if (st.layout && typeof st.layout === 'object') {
      try { localStorage.setItem('trace.layout.v1', JSON.stringify(st.layout)); } catch {}
    }
    if (Array.isArray(st.recents)) {
      try { localStorage.setItem('trace.recents.v1', JSON.stringify(st.recents)); } catch {}
    }
    if (st.lastProject && Array.isArray(st.lastProject.sources) && st.lastProject.sources.length) {
      try { localStorage.setItem('trace.project.v1', JSON.stringify(st.lastProject)); } catch {}
    }
    if (typeof st.skipHomeExitConfirm === 'boolean') {
      try {
        if (st.skipHomeExitConfirm) localStorage.setItem('trace.skipHomeExitConfirm', '1');
        else localStorage.removeItem('trace.skipHomeExitConfirm');
      } catch {}
    }
    if (typeof st.wordWrap === 'boolean') {
      try { localStorage.setItem('trace.wordWrap', st.wordWrap ? '1' : '0'); } catch {}
    }
  } catch {}
}
async function prepareExit() {
  flushState(true);
  flushActions(true);
  flushEvents(true);
  await new Promise(r => setTimeout(r, 45));
}
async function boot() {
  await hydrateDiskState();
  S.waveMode = appSettings.defaultWaveMode || 'fit';
  matchMedia('(max-width: 1000px)').addEventListener('change', syncNavigation);
  syncNavigation();
  audio.setVolume(appSettings.masterVolume);
  const unlockAudio = () => { if ((appSettings.masterVolume ?? 50) > 0) audio.resume(); window.removeEventListener('pointerdown', unlockAudio); window.removeEventListener('keydown', unlockAudio); };
  window.addEventListener('pointerdown', unlockAudio, { passive: true });
  window.addEventListener('keydown', unlockAudio, { passive: true });
  fetch('/api/health').then(response => response.json()).then(health => { logFile = health.logFile || ''; actionLogFile = health.actionLogFile || ''; }).catch(() => {});
  try { board = await createBoard3D($('#view3d'), { onKey: (id, pressed) => { trackUiAction('3D', $('#view3d'), `${pressed ? 'press' : 'release'} ${id}`); keyInput(id === 'reset' ? 'reset_btn' : id.replace('key', 's'), pressed); }, onDip: index => { trackUiAction('3D', $('#view3d'), `dip ${index + 1}`); toggleDip(index); }, onSelect: part => renderInspector(part), onPower: on => { trackUiAction('3D', $('#view3d'), `power ${on ? 'on' : 'off'}`); $('#pwrToggle').checked = on; $('#pwrToggle').dispatchEvent(new Event('change')); }, onFocusPick: (dist, x, y) => { if (board.getGfx().dof === 0) board.setGfx({ dof: 55 }); board.setPhotoFocusMode(false); $('#pmFocusPickBtn')?.classList.remove('active'); const ring = $('#pmFocusRing'); if (ring) { ring.style.left = `${x}px`; ring.style.top = `${y}px`; $('#pmFocusDistLabel').textContent = `${dist}mm`; ring.classList.remove('hidden'); clearTimeout(ring.timer); ring.timer = setTimeout(() => ring.classList.add('hidden'), 1800); } syncGfxUI(); toast(`Focus locked at ${dist} mm.`); } }); board.setPower(true); board.setGlow(.65); } catch (e) { $('#glOverlay').classList.remove('hidden'); log(e.message, 'error'); }
  waves = new WaveViewer($('#waveCanvas'), $('#waveNames'), $('#waveScrollTrack'), $('#waveScrollThumb'));
  ide = createIde({ S, toast, logEvent: recordLogEvent, markDirty, build, flashToBoard, restartSimulation, restoreSavedCompileState, renderSources, openTools, openBottomTab, syncNavigation, projectData, saveProject, persistAppState, prepareExit, saveProjectToDisk, openProjectFromDiskPath, syncProjectSaveUI, download, restoreProject, loadFiles, stopAllSimulations, reloadQsfText, openSettings: tab => openSettingsModal(tab), toggleScheme });
  applyTheme(activeThemeId);
  wire();
  wireSettingsAndThemes();
  applyAllSettings({ persist: false });
  initCustomSelects();
  wireActionLogger();
  fetchTree();
  S.sources = [{ name: DEMO_NAME, text: DEMO_SRC }]; renderSources(); requestAnimationFrame(frame);
  window.__lab = { get state() { return S; }, get board() { return board; }, get waves() { return waves; }, get ide() { return ide; }, get actions() { return [...uiActions]; }, flushActions, build, flashToBoard, advance, loadFiles, toggleDip, stopAllSimulations, saveProjectToDisk, openProjectFromDiskPath };
  const launchParams = new URLSearchParams(location.search);
  const openProjectParam = launchParams.get('openProject');
  const newProjectParam = launchParams.get('newProject') === '1';
  const demoParam = launchParams.get('demo') === '1';
  if (openProjectParam || newProjectParam || demoParam) {
    try { history.replaceState(null, '', '/'); } catch {}
  }
  recordLogEvent('info', `Workbench session initialized (${innerWidth}x${innerHeight}, theme=${document.documentElement.dataset.theme})`);
  if (openProjectParam) {
    await openProjectFromDiskPath(openProjectParam, { promptIfInWorkbench: false });
    return;
  }
  if (demoParam) {
    ide.showHome(false);
    $('#btnDemo')?.click();
    ide.captureBaseline('Counter demo');
    return;
  }
  if (newProjectParam) {
    ide.showHome(true);
    ide.openNewProjectWizard();
    return;
  }
  try { const saved = localStorage.getItem('trace.project.v1'); if (saved) { const parsed = JSON.parse(saved); if (Array.isArray(parsed?.sources) && parsed.sources.length) restoreProject(parsed); } } catch (e) { importError(new Error(`Saved project could not be restored: ${e.message}`)); S.sources = []; renderSources(); setStatus(); return; }
  S.dirty = true;
  renderPins();
  syncProjectSaveUI();
  ide.openFirst();
  ide.captureBaseline();
  ide.showHome(true);
  setStatus();
}
boot();
