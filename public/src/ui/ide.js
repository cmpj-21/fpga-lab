// IDE shell controller: resizable panes, multi-tab VHDL code editor, problems diagnostics, menus and status bar.
import { CodeEditor } from './editor.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const LAYOUT_KEY = 'trace.layout.v1';
const DEFAULT_LAYOUT = { leftW: 256, editorFrac: 42, panelH: 245 };
const NAME_PATTERN = /^[a-z0-9_][a-z0-9_. -]*\.(vhd|vhdl|vho|cf|hex|mif|mem|txt|dat)$/i;
const STANDARDS = { '93': 'VHDL-1993', '02': 'VHDL-2002', '08': 'VHDL-2008' };

export function parseDiagnostics(text) {
  const found = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const match = raw.match(/([^\s\\/:]+\.(?:vhd|vhdl|vho)):(\d+):(\d+):\s*(?:(error|warning|note)\s*:\s*)?(.*)$/i);
    if (!match) continue;
    const severity = (match[4] || 'error').toLowerCase() === 'warning' ? 'warning' : 'error';
    found.push({ file: match[1], line: Number(match[2]), col: Number(match[3]), severity, message: match[5].trim() || match[0].trim() });
  }
  return found;
}

function template(name) {
  if (!/\.(vhd|vhdl)$/i.test(name)) return '';
  let entity = name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_]/gi, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z]/i.test(entity)) entity = 'e_' + entity;
  return `library ieee;\nuse ieee.std_logic_1164.all;\n\nentity ${entity} is\n  port (\n    clk : in std_logic\n  );\nend entity ${entity};\n\narchitecture rtl of ${entity} is\nbegin\n\nend architecture rtl;\n`;
}

export function createIde(api) {
  const { S } = api;
  const docs = new Map();
  const tabs = [];
  let active = null, problems = [], cursor = null, layout = { ...DEFAULT_LAYOUT };
  try { layout = { ...DEFAULT_LAYOUT, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') }; } catch {}
  const saveLayout = () => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch {} };
  const find = name => S.sources.find(source => source.name === name);
  const libraryOf = source => source?.library || 'work';
  const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

  const fallbackTextarea = document.createElement('textarea');
  fallbackTextarea.id = 'sourceEditor';
  fallbackTextarea.className = 'ce-input ce-text hidden';
  fallbackTextarea.setAttribute('aria-label', 'VHDL source code');

  function syncFallbackId() {
    const hasActiveDoc = active && docs.has(active);
    if (hasActiveDoc) {
      fallbackTextarea.removeAttribute('id');
      fallbackTextarea.remove();
    } else if (!document.getElementById('sourceEditor')) {
      fallbackTextarea.id = 'sourceEditor';
      $('#editorHost')?.append(fallbackTextarea);
    }
  }

  // ---------- layout (resizable panes) ----------
  function applyLayout() {
    const root = document.documentElement.style;
    root.setProperty('--left-w', `${layout.leftW}px`);
    root.setProperty('--editor-frac', `${layout.editorFrac}%`);
    root.setProperty('--panel-h', `${layout.panelH}px`);
  }
  function drag(handle, onMove) {
    if (!handle) return;
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('dragging'); document.body.classList.add('resizing');
      const stop = () => {
        handle.classList.remove('dragging'); document.body.classList.remove('resizing');
        handle.removeEventListener('pointermove', onMove); handle.removeEventListener('pointerup', stop); handle.removeEventListener('pointercancel', stop);
        saveLayout();
      };
      handle.addEventListener('pointermove', onMove); handle.addEventListener('pointerup', stop); handle.addEventListener('pointercancel', stop);
    });
  }
  function wireSplitters() {
    drag($('#vSplit'), event => {
      const rect = $('#ideMain').getBoundingClientRect();
      layout.editorFrac = clamp(Math.round((event.clientX - rect.left) / Math.max(rect.width, 1) * 1000) / 10, 20, 75); applyLayout();
    });
    drag($('#hSplit'), event => {
      const rect = $('#workbench').getBoundingClientRect();
      layout.panelH = clamp(Math.round(rect.bottom - event.clientY), 130, Math.max(170, rect.height - 200)); applyLayout();
    });
    drag($('#lSplit'), event => {
      layout.leftW = clamp(Math.round(event.clientX - $('#rail').getBoundingClientRect().right), 200, 480); applyLayout();
    });
    const reset = (splitter, patch) => splitter?.addEventListener('dblclick', () => { Object.assign(layout, patch); applyLayout(); saveLayout(); });
    reset($('#vSplit'), { editorFrac: DEFAULT_LAYOUT.editorFrac });
    reset($('#hSplit'), { panelH: DEFAULT_LAYOUT.panelH });
    reset($('#lSplit'), { leftW: DEFAULT_LAYOUT.leftW });
  }
  function syncEditorVisibility() {
    const dialog = $('#sourceDialog');
    const isOpen = !!dialog?.open;
    $('#ideMain')?.classList.toggle('editor-closed', !isOpen);
    if ($('#btnFocusBoard')) {
      $('#btnFocusBoard').setAttribute('aria-pressed', String(!isOpen));
      $('#btnFocusBoard').classList.toggle('active', !isOpen);
      $('#btnFocusBoard').title = isOpen ? 'Maximize 3D board (hide code editor)' : 'Show VHDL code editor';
    }
  }
  function setEditorPaneOpen(open) {
    const dialog = $('#sourceDialog');
    if (!dialog) return;
    if (open) {
      if (!tabs.length && S.sources.length) openFile(S.sources[0].name, { focus: false });
      else if (!dialog.open) dialog.show();
    } else if (dialog.open) {
      if (dialog.contains(document.activeElement)) document.activeElement.blur();
      dialog.close();
    }
    syncEditorVisibility();
  }
  function resetLayout() {
    layout = { ...DEFAULT_LAYOUT }; applyLayout(); saveLayout();
    $('#app').classList.remove('no-library', 'no-waves', 'panel-max');
    setEditorPaneOpen(true);
    api.syncNavigation();
  }

  // ---------- problems ----------
  const markersFor = name => problems.filter(p => p.file && p.file.toLowerCase() === name.toLowerCase() && p.line > 0);
  function renderProblems() {
    const errors = problems.filter(p => p.severity === 'error').length, warnings = problems.length - errors;
    const badge = $('#problemCount');
    if (badge) {
      badge.textContent = String(problems.length);
      badge.classList.toggle('hidden', !problems.length);
      badge.classList.toggle('error', errors > 0);
    }
    const list = $('#problemList');
    if (list) {
      list.replaceChildren();
      if (!problems.length) {
        const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'No problems reported by the last build.'; list.append(empty);
      }
      for (const problem of problems) {
        const row = document.createElement('button'); row.className = `problem ${problem.severity}`;
        const icon = document.createElement('span'); icon.className = 'p-ico'; icon.textContent = problem.severity === 'error' ? '✖' : '▲';
        const message = document.createElement('span'); message.className = 'p-msg'; message.textContent = problem.message;
        const where = document.createElement('span'); where.className = 'p-loc'; where.textContent = problem.file ? `${problem.file}:${problem.line}:${problem.col}` : '';
        row.append(icon, message, where);
        if (problem.file && find(problem.file)) row.onclick = () => openFile(find(problem.file).name, { line: problem.line, col: problem.col });
        else row.disabled = !problem.file;
        list.append(row);
      }
    }
    if ($('#sbErr')) $('#sbErr').textContent = `✖ ${errors}`;
    if ($('#sbWarn')) $('#sbWarn').textContent = `▲ ${warnings}`;
    $('#sbProblems')?.classList.toggle('has-error', errors > 0);
  }
  function setProblems(list) {
    problems = list || []; renderProblems();
    for (const [name, doc] of docs) doc.editor.setMarkers(markersFor(name));
  }
  function reportBuildFailure(text) {
    let list = parseDiagnostics(text);
    if (!list.length) {
      const first = String(text || 'Build failed').split(/\r?\n/).find(line => line.trim()) || 'Build failed';
      list = [{ file: active || S.sources[0]?.name || '', line: 1, col: 1, severity: 'error', message: first.trim() }];
    }
    setProblems(list);
    const first = list.find(p => p.file && p.line && find(p.file));
    if (first && $('#sourceDialog')?.open) openFile(find(first.file).name, { line: first.line, col: first.col, focus: false });
    return list.length;
  }

  // ---------- editor tabs ----------
  const isDirty = name => {
    const doc = docs.get(name), source = find(name);
    return !!doc && !!source && (doc.editor.value !== doc.saved || doc.library !== libraryOf(source));
  };
  function renderTabs() {
    const host = $('#docTabs');
    if (!host) return;
    host.replaceChildren(...tabs.map(name => {
      const dirty = isDirty(name);
      if (docs.get(name)) docs.get(name).dirty = dirty;
      const tab = document.createElement('div');
      tab.className = `doc-tab${name === active ? ' active' : ''}${dirty ? ' dirty' : ''}`;
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(name === active)); tab.dataset.file = name;
      const main = document.createElement('button'); main.className = 'doc-tab-main'; main.title = name;
      main.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v4h4"/></svg>';
      const label = document.createElement('span'); label.textContent = name; main.append(label);
      main.onclick = () => activate(name);
      const close = document.createElement('button'); close.className = 'doc-tab-x'; close.textContent = '×'; close.title = `Close ${name}`; close.setAttribute('aria-label', `Close ${name}`);
      close.onclick = event => { event.stopPropagation(); closeTab(name); };
      tab.onauxclick = event => { if (event.button === 1) { event.preventDefault(); closeTab(name); } };
      const dot = document.createElement('i'); dot.className = 'dirty-dot';
      tab.append(main, dot, close);
      return tab;
    }));
    host.querySelector('.doc-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    renderExplorerState();
  }
  function renderExplorerState() {
    $$('#srcList li').forEach(item => {
      item.classList.toggle('active', item.dataset.file === active);
      item.classList.toggle('dirty', isDirty(item.dataset.file));
    });
  }
  function updateStatus() {
    if ($('#sbCursor')) {
      $('#sbCursor').textContent = active && cursor ? `Ln ${cursor.line}, Col ${cursor.col}${cursor.selected ? ` (${cursor.selected} sel)` : ''}` : 'Ln 1, Col 1';
      $('#sbCursor').classList.toggle('hidden', !active);
    }
    if ($('#sbLang')) $('#sbLang').textContent = STANDARDS[$('#standardSelect')?.value || S.standard] || 'VHDL';
  }
  function activate(name) {
    if (!docs.has(name)) return;
    active = name;
    for (const [other, doc] of docs) {
      doc.editor.show(other === name);
      if (other === name) doc.editor.input.id = 'sourceEditor'; else doc.editor.input.removeAttribute('id');
    }
    syncFallbackId();
    const doc = docs.get(name);
    if ($('#sourceLibrary')) $('#sourceLibrary').value = doc.library;
    if ($('#sourceName')) $('#sourceName').textContent = name;
    if ($('#editorCrumb')) $('#editorCrumb').textContent = name;
    $('#editorBar')?.classList.remove('hidden');
    $('#editorEmpty')?.classList.add('hidden');
    cursor = doc.editor.cursor();
    renderTabs(); updateStatus();
  }
  function openFile(name, { line = 0, col = 1, focus = true } = {}) {
    const source = find(name);
    if (!source) return false;
    const dialog = $('#sourceDialog');
    if (dialog && !dialog.open) dialog.show();
    syncEditorVisibility();
    let doc = docs.get(name);
    if (!doc) {
      const editor = new CodeEditor($('#editorHost'), {
        onChange: () => {
          const current = docs.get(name);
          if (!current) return;
          const dirty = isDirty(name);
          if (dirty !== current.dirty) renderTabs();
        },
        onSave: () => saveAndFlash(),
        onCursor: info => { if (active === name) { cursor = info; updateStatus(); } },
      });
      editor.setValue(source.text);
      editor.setMarkers(markersFor(name));
      doc = { editor, saved: source.text, library: libraryOf(source), dirty: false };
      docs.set(name, doc);
    }
    if (!tabs.includes(name)) tabs.push(name);
    activate(name);
    if (line) doc.editor.goto(line, col);
    else if (focus) requestAnimationFrame(() => doc.editor.focus());
    return true;
  }
  function closeTab(name, force = false) {
    const doc = docs.get(name);
    if (!doc) return;
    if (!force && isDirty(name) && !confirm(`Discard unsaved changes to ${name}?`)) return;
    doc.editor.dispose(); docs.delete(name);
    const index = tabs.indexOf(name); if (index >= 0) tabs.splice(index, 1);
    if (active === name) {
      active = null;
      const next = tabs[Math.min(index, tabs.length - 1)];
      if (next) activate(next);
      else {
        syncFallbackId();
        $('#editorBar')?.classList.add('hidden');
        $('#editorEmpty')?.classList.remove('hidden');
        if ($('#sourceName')) $('#sourceName').textContent = '';
        if ($('#editorCrumb')) $('#editorCrumb').textContent = '';
        cursor = null; renderTabs(); updateStatus();
      }
    } else renderTabs();
  }
  function commitAll() {
    let changed = false;
    if (active && docs.has(active) && $('#sourceLibrary')) {
      docs.get(active).library = $('#sourceLibrary').value.trim();
    }
    for (const [name, doc] of docs) {
      const source = find(name);
      if (!source) continue;
      doc.editor.renderNow();
      const text = doc.editor.value;
      if (source.text !== text || libraryOf(source) !== doc.library) { source.text = text; source.library = doc.library; changed = true; }
      doc.saved = text;
    }
    renderTabs();
    return changed;
  }
  function saveAndFlash() {
    if (S.building || S.importing || S.exporting) return false;
    if (active && docs.has(active) && $('#sourceLibrary')) {
      docs.get(active).library = $('#sourceLibrary').value.trim();
    }
    const bad = [...docs.values()].find(doc => !/^[a-z][a-z0-9_]*$/i.test(doc.library));
    if (bad) { api.toast('Enter a valid VHDL library name.', 'err'); return false; }
    commitAll(); api.renderSources(); api.markDirty();
    return api.build();
  }
  function syncFromSources() {
    let vanished = false;
    for (const name of [...docs.keys()]) {
      const source = find(name);
      if (!source) { closeTab(name, true); vanished = true; continue; }
      const doc = docs.get(name);
      if (source.text !== doc.saved) { doc.saved = source.text; doc.editor.setValue(source.text); }
      if (libraryOf(source) !== doc.library && !isDirty(name)) doc.library = libraryOf(source);
      if (name === active && $('#sourceLibrary')) $('#sourceLibrary').value = doc.library;
    }
    if ((vanished || !tabs.length) && S.sources.length) openFirst();
    renderTabs();
  }
  function openFirst() {
    if (!tabs.length && S.sources.length) {
      openFile(S.sources[0].name, { focus: false });
      if (window.innerWidth <= 1000) setEditorPaneOpen(false);
    }
  }

  // ---------- explorer ----------
  function showNewFile() {
    $('#newFileRow')?.classList.remove('hidden');
    if ($('#app').classList.contains('no-library')) $('#btnLibrary').click();
    $('#newFileName').value = ''; $('#newFileName').focus();
  }
  function createFile(raw) {
    let name = raw.trim();
    if (!name) return;
    if (!/\.[a-z0-9]+$/i.test(name)) name += '.vhd';
    if (!NAME_PATTERN.test(name)) return api.toast('Use a simple filename ending in .vhd, .vhdl, .vho, .txt, .dat, .hex, .mif, .mem or .cf.', 'err');
    if (S.sources.some(source => source.name.toLowerCase() === name.toLowerCase())) return api.toast(`${name} already exists.`, 'err');
    if (S.sources.length >= 100) return api.toast('A project can hold at most 100 files.', 'err');
    S.sources.push({ name, text: template(name) });
    api.renderSources(); api.markDirty();
    $('#newFileRow').classList.add('hidden');
    openFile(name);
    api.toast(`Created ${name}. Press Ctrl+S or click Flash to compile.`);
  }

  // ---------- menus ----------
  const commands = {
    newFile: showNewFile,
    openFiles: () => $('#fileInput').click(),
    save: saveAndFlash,
    saveProject: () => $('#btnSaveProject').click(),
    loadDemo: () => $('#btnDemo').click(),
    closeTab: () => active && closeTab(active),
    undo: () => { docs.get(active)?.editor.focus(); document.execCommand('undo'); },
    redo: () => { docs.get(active)?.editor.focus(); document.execCommand('redo'); },
    comment: () => docs.get(active)?.editor.toggleComment(),
    viewExplorer: () => $('#btnLibrary').click(),
    viewPins: () => $('#btnPins').click(),
    panelWaves: () => { if ($('#app').classList.contains('no-waves')) $('#btnSignals').click(); },
    panelProblems: () => api.openTools('problems'),
    panelConsole: () => api.openTools('console'),
    panelTruth: () => api.openTools('truth'),
    panelUart: () => api.openTools('uart'),
    panelBitstream: () => api.openTools('programmer'),
    toggleEditor: () => setEditorPaneOpen(!$('#sourceDialog')?.open),
    focusBoard: () => setEditorPaneOpen(!$('#sourceDialog')?.open),
    photo: () => $('#btnPhotoMode').click(),
    theme: () => $('#btnTheme').click(),
    resetLayout,
    flash: saveAndFlash,
    restart: () => $('#btnReset').click(),
    step: () => $('#btnStep').click(),
    run: () => $('#btnRun').click(),
    limits: () => $('#btnLimits').click(),
    shortcuts: () => $('#keysDialog')?.showModal(),
  };
  function closeMenus() {
    $$('.menu-pop').forEach(pop => pop.classList.add('hidden'));
    $$('.menu-btn').forEach(button => button.setAttribute('aria-expanded', 'false'));
  }
  function wireMenus() {
    const open = button => {
      const wasOpen = button.getAttribute('aria-expanded') === 'true';
      closeMenus();
      if (wasOpen) return;
      button.setAttribute('aria-expanded', 'true');
      $(`.menu-pop[data-pop="${button.dataset.menu}"]`)?.classList.remove('hidden');
    };
    $$('.menu-btn').forEach(button => {
      button.onclick = event => { event.stopPropagation(); open(button); };
      button.onmouseenter = () => { if ($$('.menu-btn').some(other => other.getAttribute('aria-expanded') === 'true') && button.getAttribute('aria-expanded') !== 'true') open(button); };
    });
    $$('.menu-pop [data-cmd]').forEach(item => item.onclick = event => {
      event.stopPropagation(); closeMenus();
      commands[item.dataset.cmd]?.();
    });
    document.addEventListener('click', event => { if (!event.target.closest('.menu')) closeMenus(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenus(); });
    window.addEventListener('blur', closeMenus);
  }

  // ---------- wiring ----------
  function wire() {
    applyLayout();
    syncFallbackId();
    wireSplitters(); wireMenus();
    $('#btnFocusBoard')?.addEventListener('click', () => setEditorPaneOpen(!$('#sourceDialog')?.open));
    $('#btnOpenFirst')?.addEventListener('click', () => { if (S.sources.length) openFile(S.sources[0].name); else showNewFile(); });
    $('#btnNewFile')?.addEventListener('click', showNewFile);
    $('#btnNewFileExplorer')?.addEventListener('click', showNewFile);
    if ($('#newFileRow')) {
      $('#newFileRow').onsubmit = event => { event.preventDefault(); createFile($('#newFileName').value); };
      $('#newFileName').onkeydown = event => { if (event.key === 'Escape') { event.stopPropagation(); $('#newFileRow').classList.add('hidden'); } };
      $('#newFileName').onblur = () => { if (!$('#newFileName').value.trim()) $('#newFileRow').classList.add('hidden'); };
    }
    $('#saveSource').onclick = saveAndFlash;
    if ($('#btnFlash')) $('#btnFlash').onclick = saveAndFlash;
    $('#sourceLibrary').oninput = event => { const doc = docs.get(active); if (doc) { doc.library = event.target.value.trim(); renderTabs(); } };
    $('#sourceDialog')?.addEventListener('close', () => {
      if ($('#sourceDialog').contains(document.activeElement)) document.activeElement.blur();
      syncEditorVisibility();
    });
    if ($('#sbProblems')) $('#sbProblems').onclick = () => api.openTools('problems');
    $('#standardSelect')?.addEventListener('change', updateStatus);
    matchMedia('(max-width: 1000px)').addEventListener('change', e => { if (e.matches && $('#sourceDialog')?.open) setEditorPaneOpen(false); });
    renderProblems(); updateStatus(); syncEditorVisibility();
  }
  wire();

  return {
    openFile, closeTab, activate, commitAll, saveAndFlash, syncFromSources, openFirst, updateStatus,
    setProblems, reportBuildFailure, resetLayout, setEditorPaneOpen,
    get active() { return active; },
    get tabs() { return [...tabs]; },
    get problems() { return problems; },
    get editor() { return docs.get(active)?.editor || null; },
    isDirty,
  };
}
