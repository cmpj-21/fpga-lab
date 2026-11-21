// IDE shell controller: resizable panes, multi-tab VHDL code editor, problems diagnostics, menus and status bar.
import { CodeEditor } from './editor.js';
import { DEMO_SRC, DEMO_TOP } from './demo.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const LAYOUT_KEY = 'trace.layout.v1';
const RECENTS_KEY = 'trace.recents.v1';
const DEFAULT_LAYOUT = { leftW: 256, editorFrac: 42, panelH: 245 };
const NAME_PATTERN = /^[a-z0-9_][a-z0-9_. -]*\.(vhd|vhdl|vho|cf|hex|mif|mem|txt|dat)$/i;
const STANDARDS = { '93': 'VHDL-1993', '02': 'VHDL-2002', '08': 'VHDL-2008' };

function buildStarterSource(kind, entity) {
  if (kind === 'counter') {
    return DEMO_SRC.replaceAll(DEMO_TOP, entity);
  }
  if (kind === 'board_io') {
    return `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity ${entity} is
  port (
    clk       : in  std_logic;
    reset_btn : in  std_logic;
    s1, s2, s3, s4 : in  std_logic;
    led1, led2, led3, led4 : out std_logic;
    seven_seg : out std_logic_vector(7 downto 0);
    dtube1, dtube2, dtube3, dtube4 : out std_logic;
    beep      : out std_logic
  );
end entity ${entity};

architecture rtl of ${entity} is
  signal count  : unsigned(15 downto 0) := (others => '0');
  signal scan   : unsigned(1 downto 0)  := "00";
  signal nibble : unsigned(3 downto 0);
  signal segs   : std_logic_vector(6 downto 0);
begin
  process (clk)
  begin
    if rising_edge(clk) then
      if reset_btn = '0' then
        count <= (others => '0');
        scan  <= "00";
      else
        scan <= scan + 1;
        if s2 = '0' then
          count <= (others => '0');
        elsif s3 = '0' then
          count <= count - 1;
        elsif s1 = '0' then
          count <= count + 16;
        else
          count <= count + 1;
        end if;
      end if;
    end if;
  end process;

  with scan select nibble <=
    count(3 downto 0)   when "00",
    count(7 downto 4)   when "01",
    count(11 downto 8)  when "10",
    count(15 downto 12) when others;

  with nibble select segs <=
    "1000000" when x"0", "1111001" when x"1", "0100100" when x"2", "0110000" when x"3",
    "0011001" when x"4", "0010010" when x"5", "0000010" when x"6", "1111000" when x"7",
    "0000000" when x"8", "0010000" when x"9", "0001000" when x"A", "0000011" when x"B",
    "1000110" when x"C", "0100001" when x"D", "0000110" when x"E", "0001110" when others;

  seven_seg <= (others => '0') when s4 = '0' else '1' & segs;
  dtube1 <= '0' when s4 = '0' or scan = "00" else '1';
  dtube2 <= '0' when s4 = '0' or scan = "01" else '1';
  dtube3 <= '0' when s4 = '0' or scan = "10" else '1';
  dtube4 <= '0' when s4 = '0' or scan = "11" else '1';

  -- Active-low LEDs respond to S1..S4 / DIP switches and live counter bits
  led1 <= '0' when s4 = '0' or s1 = '0' else not std_logic(count(0));
  led2 <= '0' when s4 = '0' or s2 = '0' else not std_logic(count(1));
  led3 <= '0' when s4 = '0' or s3 = '0' else not std_logic(count(2));
  led4 <= '0' when s4 = '0' else not std_logic(count(3));

  beep <= std_logic(count(0)) and (not s3);
end architecture rtl;
`;
  }
  if (kind === 'keys_leds') {
    return `library ieee;
use ieee.std_logic_1164.all;

entity ${entity} is
  port (
    s1, s2, s3, s4 : in  std_logic;
    led1, led2, led3, led4 : out std_logic
  );
end entity ${entity};

architecture rtl of ${entity} is
begin
  -- Active-low inputs (0 = pressed) and active-low LEDs (0 = lit)
  led1 <= s1;
  led2 <= s2;
  led3 <= s1 or s2;   -- Lit when both S1 and S2 are pressed
  led4 <= s3 and s4;  -- Lit when either S3 or S4 is pressed
end architecture rtl;
`;
  }
  if (kind === 'uart_tx') {
    return `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity ${entity} is
  port (
    clk       : in  std_logic;
    reset_btn : in  std_logic;
    s1        : in  std_logic;
    uart_txd  : out std_logic := '1';
    led1      : out std_logic := '1'
  );
end entity ${entity};

architecture rtl of ${entity} is
  -- 8-N-1 frame for ASCII 'A' (0x41): Stop(1) & "01000001" & Start(0)
  constant FRAME : std_logic_vector(9 downto 0) := "1010000010";
  signal bit_idx : integer range 0 to 9 := 0;
  signal busy    : std_logic := '0';
begin
  led1 <= not busy;
  process (clk)
  begin
    if rising_edge(clk) then
      if reset_btn = '0' then
        uart_txd <= '1';
        busy <= '0';
        bit_idx <= 0;
      elsif busy = '0' then
        uart_txd <= '1';
        if s1 = '0' then
          busy <= '1';
          bit_idx <= 0;
        end if;
      else
        uart_txd <= FRAME(bit_idx);
        if bit_idx = 9 then
          busy <= '0';
        else
          bit_idx <= bit_idx + 1;
        end if;
      end if;
    end if;
  end process;
end architecture rtl;
`;
  }
  if (kind === 'buzzer') {
    return `library ieee;
use ieee.std_logic_1164.all;

entity ${entity} is
  port (
    clk       : in  std_logic;
    reset_btn : in  std_logic;
    s1        : in  std_logic;
    beep      : out std_logic;
    led1      : out std_logic
  );
end entity ${entity};

architecture rtl of ${entity} is
  signal tone : std_logic := '0';
begin
  process (clk)
  begin
    if rising_edge(clk) then
      if reset_btn = '0' then
        tone <= '0';
      elsif s1 = '0' then
        tone <= not tone;
      end if;
    end if;
  end process;
  beep <= tone and (not s1);
  led1 <= s1;
end architecture rtl;
`;
  }
  return template(`${entity}.vhd`);
}

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
      $('#btnFocusBoard').setAttribute('aria-pressed', String(isOpen));
      $('#btnFocusBoard').classList.toggle('active', isOpen);
      $('#btnFocusBoard').title = isOpen ? 'Hide VHDL code editor (Ctrl+E)' : 'Show VHDL code editor (Ctrl+E)';
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
          if (dirty && !S.dirty) api.markDirty();
          if (dirty !== current.dirty) renderTabs();
        },
        onSave: () => saveAndCompile(),
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
  function hasUnsaved() {
    if (active && docs.has(active) && $('#sourceLibrary')) {
      docs.get(active).library = $('#sourceLibrary').value.trim();
    }
    return [...docs.keys()].some(isDirty);
  }
  function validateLibraries() {
    if (active && docs.has(active) && $('#sourceLibrary')) {
      docs.get(active).library = $('#sourceLibrary').value.trim();
    }
    const bad = [...docs.values()].find(doc => !/^[a-z][a-z0-9_]*$/i.test(doc.library));
    if (bad) { api.toast('Enter a valid VHDL library name.', 'err'); return false; }
    return true;
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
  function saveAndCompile() {
    if (S.building || S.importing || S.exporting) return false;
    if (!validateLibraries()) return false;
    commitAll(); api.renderSources(); api.markDirty();
    return api.build();
  }
  function saveAndFlash() {
    if (S.building || S.importing || S.exporting) return false;
    return api.flashToBoard ? api.flashToBoard() : saveAndCompile();
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
    showHome(false);
    $('#newFileRow')?.classList.remove('hidden');
    if ($('#app').classList.contains('no-library') || !$('#ltab-library')?.classList.contains('active')) $('#btnLibrary').click();
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

  // ---------- home interface & recent projects ----------
  let baselineProject = null, baselineStorage = null, baselineRecents = [], projectTitle = '', pendingFocusWizard = false;

  function loadRecents() {
    try {
      const list = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch { return []; }
  }
  function saveRecents(list) {
    try { localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, 12))); } catch {}
  }
  function currentProjectTitle() {
    const topName = $('#topSelect')?.value || S.sim?.top || S.sources[0]?.name.replace(/\.[^.]+$/, '') || 'fpga_project';
    return projectTitle || (topName === DEMO_TOP ? 'Counter demo' : topName);
  }
  function captureBaseline(customTitle = '', { keepPreSession = false, prevRecents = null, prevStorage = undefined } = {}) {
    if (customTitle !== undefined) projectTitle = customTitle;
    try { baselineProject = api.projectData ? JSON.parse(JSON.stringify(api.projectData())) : null; } catch { baselineProject = null; }
    if (!keepPreSession) {
      try { baselineStorage = prevStorage !== undefined ? prevStorage : localStorage.getItem('trace.project.v1'); } catch { baselineStorage = null; }
      baselineRecents = prevRecents !== null ? prevRecents : loadRecents();
    }
  }
  function describeRecentChanges() {
    const dirtyTabs = [...docs.keys()].filter(isDirty);
    const changes = [];
    if (dirtyTabs.length) changes.push(`unsaved editor edits in ${dirtyTabs.join(', ')}`);
    if (baselineProject) {
      const baseFiles = new Map((baselineProject.sources || []).map(s => [s.name, s.text]));
      const curFiles = new Map(S.sources.map(s => [s.name, docs.has(s.name) ? docs.get(s.name).editor.value : s.text]));
      const modified = [];
      for (const [name, text] of curFiles) {
        if (!baseFiles.has(name) || baseFiles.get(name) !== text) modified.push(name);
      }
      for (const name of baseFiles.keys()) {
        if (!curFiles.has(name)) modified.push(name);
      }
      const uniqueMod = [...new Set(modified)].filter(n => !dirtyTabs.includes(n));
      if (uniqueMod.length) changes.push(`modified sources (${uniqueMod.join(', ')})`);
      if (JSON.stringify([...S.assignments]) !== JSON.stringify(baselineProject.assignments || [])) changes.push('pin mappings');
      if (($('#standardSelect')?.value || S.standard) !== baselineProject.standard || ($('#genericInput')?.value || '') !== (baselineProject.generics || '')) changes.push('compiler options');
    }
    return changes.length
      ? `Detected ${changes.join(', ')}. Saving updates your workspace and Recent Projects list; discarding reverts these changes. All active simulations will be cancelled and stopped.`
      : 'Saving updates your workspace and Recent Projects list; discarding reverts any changes from this session. Returning to the Home menu will cancel and stop all active simulations.';
  }
  function recordRecentProject(customTitle = '') {
    if (!S.sources.length || !api.projectData) return;
    const project = api.projectData();
    const topName = project.top || S.sim?.top || project.sources[0]?.name.replace(/\.[^.]+$/, '') || 'fpga_project';
    const title = customTitle || projectTitle || (topName === DEMO_TOP ? 'Counter demo' : topName);
    const key = `${title.toLowerCase()}::${project.sources.map(s => s.name).join(',')}`;
    const list = loadRecents().filter(item => item.key !== key);
    list.unshift({
      key,
      title,
      top: topName,
      standard: project.standard || S.standard || '93',
      files: project.sources.map(s => s.name),
      updatedAt: Date.now(),
      project,
    });
    saveRecents(list);
  }
  function fmtAgo(ts) {
    const sec = Math.max(0, Math.floor((Date.now() - (ts || Date.now())) / 1000));
    if (sec < 45) return 'Just now';
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return new Date(ts).toLocaleDateString();
  }
  function renderHome() {
    const box = $('#homeRecentList');
    if (!box) return;
    const recents = loadRecents();
    if ($('#homeClearRecents')) $('#homeClearRecents').disabled = !recents.length;
    box.replaceChildren();
    if (!recents.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No recent projects yet. Create a new project or open a starter template.';
      box.append(empty);
      return;
    }
    for (const item of recents) {
      const row = document.createElement('div');
      row.className = 'home-recent-item';
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'home-recent-main';
      const titleRow = document.createElement('div');
      titleRow.className = 'hr-top';
      const strong = document.createElement('strong');
      strong.textContent = item.title;
      const badge = document.createElement('span');
      badge.className = 'hr-std mono';
      badge.textContent = STANDARDS[item.standard] || 'VHDL';
      const time = document.createElement('span');
      time.className = 'hr-time';
      time.textContent = fmtAgo(item.updatedAt);
      titleRow.append(strong, badge, time);
      const filesRow = document.createElement('div');
      filesRow.className = 'hr-files mono';
      filesRow.textContent = `${item.files?.join(', ') || 'No files'} · Top: ${item.top || 'auto'}`;
      openBtn.append(titleRow, filesRow);
      openBtn.onclick = () => {
        try {
          const prevRecents = loadRecents();
          let prevStorage = null;
          try { prevStorage = localStorage.getItem('trace.project.v1'); } catch {}
          for (const name of [...docs.keys()]) closeTab(name, true);
          api.restoreProject(item.project);
          openFirst();
          captureBaseline(item.title, { prevRecents, prevStorage });
          showHome(false);
          api.markDirty();
          api.toast(`Opened ${item.title}. Click Build design or Flash to compile.`);
        } catch (err) {
          api.toast(err.message, 'err');
        }
      };
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'home-recent-del';
      delBtn.textContent = '×';
      delBtn.title = `Remove ${item.title} from recent projects`;
      delBtn.setAttribute('aria-label', delBtn.title);
      delBtn.onclick = e => {
        e.stopPropagation();
        saveRecents(loadRecents().filter(r => r.key !== item.key));
        renderHome();
      };
      row.append(openBtn, delBtn);
      box.append(row);
    }
  }
  function showHome(visible = true) {
    const view = $('#homeView');
    if (!view) return;
    if (visible) renderHome();
    view.classList.toggle('hidden', !visible);
    $('#btnHome')?.classList.toggle('active', visible);
  }
  function resumeWorkbench() {
    captureBaseline(projectTitle);
    showHome(false);
  }
  function requestReturnHome({ focusWizard = false } = {}) {
    const view = $('#homeView');
    if (!view || !view.classList.contains('hidden')) {
      if (focusWizard) { $('#npName')?.focus(); $('#npName')?.select(); }
      return;
    }
    pendingFocusWizard = focusWizard;
    const dlg = $('#homeConfirmDialog');
    if (!dlg) {
      api.stopAllSimulations?.();
      showHome(true);
      return;
    }
    if ($('#homeConfirmProject')) $('#homeConfirmProject').textContent = currentProjectTitle();
    if ($('#homeConfirmDetail')) $('#homeConfirmDetail').textContent = describeRecentChanges();
    if (!dlg.open) dlg.showModal();
  }
  async function confirmSaveAndReturnHome() {
    if (!validateLibraries()) return;
    commitAll();
    api.renderSources();
    api.saveProject?.();
    recordRecentProject(projectTitle);
    captureBaseline(projectTitle);
    $('#homeConfirmDialog')?.close();
    await api.stopAllSimulations?.();
    showHome(true);
    if (pendingFocusWizard) {
      pendingFocusWizard = false;
      $('#npName')?.focus();
      $('#npName')?.select();
    }
    api.toast('Saved project changes. All simulations stopped.');
  }
  async function confirmDiscardAndReturnHome() {
    for (const name of [...docs.keys()]) closeTab(name, true);
    if (baselineProject) {
      try { api.restoreProject(JSON.parse(JSON.stringify(baselineProject))); } catch {}
    }
    openFirst();
    try {
      if (baselineStorage === null) localStorage.removeItem('trace.project.v1');
      else localStorage.setItem('trace.project.v1', baselineStorage);
    } catch {}
    saveRecents(baselineRecents);
    setProblems([]);
    $('#homeConfirmDialog')?.close();
    await api.stopAllSimulations?.();
    showHome(true);
    if (pendingFocusWizard) {
      pendingFocusWizard = false;
      $('#npName')?.focus();
      $('#npName')?.select();
    }
    api.toast('Discarded recent changes. All simulations stopped.');
  }
  async function launchTemplateProject({ name, entity, standard = '08', templateKind = 'board_io' }) {
    const cleanEntity = entity.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
    if (!/^[a-z][a-z0-9_]*$/i.test(cleanEntity)) {
      api.toast('Top-level entity must start with a letter and use letters, digits or underscores.', 'err');
      return;
    }
    const prevRecents = loadRecents();
    let prevStorage = null;
    try { prevStorage = localStorage.getItem('trace.project.v1'); } catch {}
    const fileName = `${cleanEntity}.vhd`;
    const code = buildStarterSource(templateKind, cleanEntity);
    for (const tabName of [...docs.keys()]) closeTab(tabName, true);
    const project = {
      format: 'trace-project',
      version: 1,
      sources: [{ name: fileName, text: code, library: 'work' }],
      assignments: [],
      top: cleanEntity,
      topLibrary: 'work',
      standard,
      generics: '',
      sdf: null,
    };
    api.restoreProject(project);
    openFirst();
    captureBaseline(name || cleanEntity, { prevRecents, prevStorage });
    showHome(false);
    api.markDirty();
    api.toast(`Loaded ${name || cleanEntity}. Click Build design or Flash to compile.`);
  }
  function populateHomeHdl(groups = []) {
    const container = $('#homeHdlList');
    if (!container) return;
    container.replaceChildren();
    if (!groups.length) {
      container.innerHTML = '<p class="empty">No local HDL files discovered.</p>';
      return;
    }
    for (const group of groups) {
      for (const file of group.files) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'home-hdl-item';
        btn.dataset.search = `${group.dir}/${file.name}`.toLowerCase();
        const kind = document.createElement('span');
        kind.className = 'fk';
        kind.textContent = file.kind.toUpperCase();
        const pathSpan = document.createElement('span');
        pathSpan.className = 'mono';
        pathSpan.textContent = `${group.dir}/${file.name}`;
        btn.append(kind, pathSpan);
        btn.onclick = async () => {
          try {
            const prevRecents = loadRecents();
            let prevStorage = null;
            try { prevStorage = localStorage.getItem('trace.project.v1'); } catch {}
            const response = await fetch('/api/hdl/file?path=' + encodeURIComponent(file.rel));
            if (!response.ok) throw new Error('File could not be read.');
            showHome(false);
            await api.loadFiles([new File([await response.blob()], file.name)]);
            captureBaseline(file.name.replace(/\.[^.]+$/, ''), { prevRecents, prevStorage });
          } catch (e) { api.toast(e.message, 'err'); }
        };
        container.append(btn);
      }
    }
  }

  // ---------- menus ----------
  const commands = {
    home: () => requestReturnHome(),
    newProject: () => requestReturnHome({ focusWizard: true }),
    newFile: showNewFile,
    openFiles: () => $('#fileInput').click(),
    save: saveAndCompile,
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
    flash: () => api.flashToBoard?.(),
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
    $('#saveSource').onclick = saveAndCompile;
    if ($('#btnFlash')) $('#btnFlash').onclick = () => api.flashToBoard?.();
    $('#sourceLibrary').oninput = event => { const doc = docs.get(active); if (doc) { doc.library = event.target.value.trim(); renderTabs(); } };
    $('#sourceDialog')?.addEventListener('close', () => {
      if ($('#sourceDialog').contains(document.activeElement)) document.activeElement.blur();
      syncEditorVisibility();
    });
    if ($('#sbProblems')) $('#sbProblems').onclick = () => api.openTools('problems');
    $('#standardSelect')?.addEventListener('change', updateStatus);
    matchMedia('(max-width: 1000px)').addEventListener('change', e => {
      if (e.matches && $('#sourceDialog')?.open) setEditorPaneOpen(false);
      else if (!e.matches && tabs.length && !$('#sourceDialog')?.open) setEditorPaneOpen(true);
    });
    // Home Interface wiring
    $('#topbar .brand')?.addEventListener('click', e => { e.preventDefault(); requestReturnHome(); });
    $('#btnHome')?.addEventListener('click', () => {
      if (!$('#homeView') || $('#homeView').classList.contains('hidden')) requestReturnHome();
      else resumeWorkbench();
    });
    $('#homeContinueBtn')?.addEventListener('click', () => resumeWorkbench());
    $('#homeConfirmSave')?.addEventListener('click', () => confirmSaveAndReturnHome());
    $('#homeConfirmDiscard')?.addEventListener('click', () => confirmDiscardAndReturnHome());
    $('#homeConfirmCancel')?.addEventListener('click', () => { pendingFocusWizard = false; $('#homeConfirmDialog')?.close(); });
    $('#homeThemeBtn')?.addEventListener('click', () => $('#btnTheme')?.click());
    $('#homeAboutBtn')?.addEventListener('click', () => $('#btnAbout')?.click());
    $('#homeOpenBtn')?.addEventListener('click', () => $('#fileInput')?.click());
    $('#homeDemoBtn')?.addEventListener('click', () => {
      const prevRecents = loadRecents();
      let prevStorage = null;
      try { prevStorage = localStorage.getItem('trace.project.v1'); } catch {}
      showHome(false);
      $('#btnDemo')?.click();
      captureBaseline('Counter demo', { prevRecents, prevStorage });
    });
    $('#homeNewProjectBtn')?.addEventListener('click', () => { $('#npName')?.focus(); $('#npName')?.select(); });
    $('#homeClearRecents')?.addEventListener('click', () => { saveRecents([]); renderHome(); });
    let entityTouched = false;
    $('#npEntity')?.addEventListener('input', () => {
      entityTouched = true;
      const ent = $('#npEntity').value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_') || 'fpga_lab';
      if ($('#npFilePreview')) $('#npFilePreview').textContent = `${ent}.vhd`;
    });
    $('#npName')?.addEventListener('input', () => {
      const slug = $('#npName').value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'fpga_lab';
      const ent = /^[a-z]/i.test(slug) ? slug : 'p_' + slug;
      if (!entityTouched && $('#npEntity')) $('#npEntity').value = ent;
      if ($('#npFilePreview')) $('#npFilePreview').textContent = `${($('#npEntity')?.value || ent)}.vhd`;
    });
    $('#homeWizardForm')?.addEventListener('submit', e => {
      e.preventDefault();
      launchTemplateProject({
        name: $('#npName').value.trim() || 'fpga_lab',
        entity: $('#npEntity').value.trim() || 'fpga_lab',
        standard: $('#npStandard').value || '08',
        templateKind: $('#npTemplate').value || 'board_io',
      });
    });
    $$('[data-starter]').forEach(btn => btn.addEventListener('click', () => {
      const kind = btn.dataset.starter;
      const names = { counter: ['Counter & 7-Seg Demo', DEMO_TOP, '93'], board_io: ['Board I/O Starter', 'board_top', '08'], keys_leds: ['Keys & LEDs Logic', 'keys_leds', '08'], uart_tx: ['UART Transmitter', 'uart_hello', '08'] };
      const [title, ent, std] = names[kind] || ['FPGA Starter', 'fpga_lab', '08'];
      launchTemplateProject({ name: title, entity: ent, standard: std, templateKind: kind });
    }));
    $('#homeHdlSearch')?.addEventListener('input', e => {
      const q = e.target.value.toLowerCase();
      $$('#homeHdlList .home-hdl-item').forEach(item => { item.hidden = !item.dataset.search.includes(q); });
    });
    renderProblems(); updateStatus(); syncEditorVisibility();
  }
  wire();

  return {
    openFile, closeTab, activate, commitAll, hasUnsaved, validateLibraries, saveAndCompile, saveAndFlash, syncFromSources, openFirst, updateStatus,
    setProblems, reportBuildFailure, resetLayout, setEditorPaneOpen,
    showHome, requestReturnHome, resumeWorkbench, captureBaseline, renderHome, recordRecentProject, populateHomeHdl,
    get active() { return active; },
    get tabs() { return [...tabs]; },
    get problems() { return problems; },
    get editor() { return docs.get(active)?.editor || null; },
    isDirty,
  };
}
