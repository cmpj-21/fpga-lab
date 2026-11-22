// IDE shell controller: resizable panes, multi-tab VHDL code editor, problems diagnostics, menus and status bar.
import { CodeEditor, renderMarkdownHtml } from './editor.js';
import { DEMO_SRC, DEMO_TOP } from './demo.js';
import { Terminal } from '/vendor/xterm.mjs?v=2';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const LAYOUT_KEY = 'trace.layout.v1';
const RECENTS_KEY = 'trace.recents.v1';
const DEFAULT_LAYOUT = { leftW: 256, editorFrac: 42, panelH: 245 };
const NAME_PATTERN = /^(?:[a-z0-9_][a-z0-9_. -]*\/)*[a-z0-9_][a-z0-9_. -]*\.(vhd|vhdl|vho|cf|hex|mif|mem|txt|dat|md)$/i;
const STANDARDS = { '93': 'VHDL-1993', '02': 'VHDL-2002', '08': 'VHDL-2008' };
const FORBIDDEN_SEG = /[<>:"\\|?*\x00-\x1f]/;
function cleanRelPath(raw) {
  return String(raw || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
}
function isValidRelPath(rel) {
  if (!rel || rel.length > 200) return false;
  const parts = rel.split('/');
  return parts.every(seg => seg && seg !== '.' && seg !== '..' && !FORBIDDEN_SEG.test(seg) && !/[. ]$/.test(seg));
}
function fileKindLabel(name) {
  const base = String(name || '').split('/').pop() || '';
  const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
  if (ext === 'vhd' || ext === 'vhdl' || ext === 'vho') return 'VHDL';
  if (!ext) return 'FILE';
  return ext.slice(0, 6).toUpperCase();
}
function parentDirOf(rel) {
  const idx = String(rel || '').lastIndexOf('/');
  return idx > 0 ? rel.slice(0, idx) : '';
}
function baseNameOf(rel) {
  return String(rel || '').split('/').pop() || '';
}

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
  if (/\.md$/i.test(name)) {
    const title = baseNameOf(name).replace(/\.[^.]+$/, '') || 'Notes';
    return `# ${title}\n\n## Overview\nAdd your FPGA lab notes, pinout documentation, or test results here.\n`;
  }
  if (!/\.(vhd|vhdl)$/i.test(name)) return '';
  let entity = baseNameOf(name).replace(/\.[^.]+$/, '').replace(/[^a-z0-9_]/gi, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z]/i.test(entity)) entity = 'e_' + entity;
  return `library ieee;\nuse ieee.std_logic_1164.all;\n\nentity ${entity} is\n  port (\n    clk : in std_logic\n  );\nend entity ${entity};\n\narchitecture rtl of ${entity} is\nbegin\n\nend architecture rtl;\n`;
}

export function createIde(api) {
  const { S } = api;
  const docs = new Map();
  const tabs = [];
  let active = null, problems = [], cursor = null, layout = { ...DEFAULT_LAYOUT };
  let wordWrap = false, mdMode = 'view';
  try { wordWrap = localStorage.getItem('trace.wordWrap') === '1'; } catch {}
  try { layout = { ...DEFAULT_LAYOUT, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') }; } catch {}
  const saveLayout = () => {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch {}
    api.persistAppState?.({ layout });
  };
  const find = name => S.sources.find(source => source.name === name) || S.sources.find(source => source.name.toLowerCase() === String(name || '').toLowerCase());
  const findByDiagFile = file => find(file) || S.sources.find(source => baseNameOf(source.name).toLowerCase() === baseNameOf(file).toLowerCase());
  const libraryOf = source => source?.library || 'work';
  const languageFor = name => /\.(vhd|vhdl|vho)$/i.test(name || '') ? 'vhdl' : /\.(qsf|qpf)$/i.test(name || '') ? 'qsf' : /\.md$/i.test(name || '') ? 'markdown' : 'plain';
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
  let boardPaneOpen = false;
  function computeMinTopHeight() {
    if (!boardPaneOpen || $('#ideMain')?.classList.contains('board-closed')) return 140;
    const headH = $('.board-pane-head')?.offsetHeight || 34;
    const tbH = $('#boardPane > .view-toolbar')?.offsetHeight || 40;
    const ioH = $('#inputBar')?.offsetHeight || 44;
    const vIn = $('#virtualInputs');
    const vInH = (vIn && !vIn.classList.contains('hidden')) ? vIn.offsetHeight : 0;
    return headH + tbH + ioH + vInH + 110;
  }
  function clampLayoutBounds() {
    const ideMain = $('#ideMain');
    const bothClosed = ideMain?.classList.contains('editor-closed') && ideMain?.classList.contains('board-closed');
    const mainRect = ideMain?.getBoundingClientRect();
    if (mainRect && mainRect.width > 560 && !ideMain?.classList.contains('editor-closed') && !ideMain?.classList.contains('board-closed')) {
      const minBoardPx = 320;
      const minEditorPx = 240;
      const maxEditorPct = Math.max(20, Math.min(75, Math.floor(((mainRect.width - minBoardPx) / mainRect.width) * 1000) / 10));
      const minEditorPct = Math.min(maxEditorPct, Math.max(20, Math.ceil((minEditorPx / mainRect.width) * 1000) / 10));
      layout.editorFrac = clamp(layout.editorFrac, minEditorPct, maxEditorPct);
    }
    const wbRect = $('#workbench')?.getBoundingClientRect();
    if (!bothClosed && wbRect && wbRect.height > 260) {
      const maxPanelH = Math.max(130, Math.floor(wbRect.height - computeMinTopHeight()));
      layout.panelH = clamp(layout.panelH, 130, maxPanelH);
    }
  }
  function applyLayout() {
    clampLayoutBounds();
    const root = document.documentElement.style;
    root.setProperty('--left-w', `${layout.leftW}px`);
    root.setProperty('--editor-frac', `${layout.editorFrac}%`);
    root.setProperty('--panel-h', `${layout.panelH}px`);
  }
  function drag(handle, onMove, cls = 'resizing') {
    if (!handle) return;
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('dragging'); document.body.classList.add(cls);
      const stop = () => {
        handle.classList.remove('dragging'); document.body.classList.remove(cls);
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
      const maxPanelH = Math.max(130, Math.floor(rect.height - computeMinTopHeight()));
      layout.panelH = clamp(Math.round(rect.bottom - event.clientY), 130, maxPanelH); applyLayout();
    }, 'resizing-h');
    drag($('#lSplit'), event => {
      layout.leftW = clamp(Math.round(event.clientX - $('#rail').getBoundingClientRect().right), 200, 480); applyLayout();
    });
    window.addEventListener('resize', () => applyLayout());
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        const prev = layout.panelH;
        clampLayoutBounds();
        if (layout.panelH !== prev) document.documentElement.style.setProperty('--panel-h', `${layout.panelH}px`);
      });
      const tb = $('#boardPane > .view-toolbar');
      const io = $('#inputBar');
      if (tb) ro.observe(tb);
      if (io) ro.observe(io);
    }
    const reset = (splitter, patch) => splitter?.addEventListener('dblclick', () => { Object.assign(layout, patch); applyLayout(); saveLayout(); });
    reset($('#vSplit'), { editorFrac: DEFAULT_LAYOUT.editorFrac });
    reset($('#hSplit'), { panelH: DEFAULT_LAYOUT.panelH });
    reset($('#lSplit'), { leftW: DEFAULT_LAYOUT.leftW });
  }
  function syncEditorVisibility() {
    const dialog = $('#sourceDialog');
    const isOpen = !!dialog?.open;
    $('#ideMain')?.classList.toggle('editor-closed', !isOpen);
    if ($('#wbEmptyProject')) $('#wbEmptyProject').textContent = currentProjectTitle();
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
  function syncBoardVisibility() {
    $('#ideMain')?.classList.toggle('board-closed', !boardPaneOpen);
    if ($('#wbEmptyProject')) $('#wbEmptyProject').textContent = currentProjectTitle();
    const btn = $('#btnToggleBoard');
    if (btn) {
      btn.setAttribute('aria-pressed', String(boardPaneOpen));
      btn.classList.toggle('active', boardPaneOpen);
      btn.title = boardPaneOpen ? 'Hide 3D Devboard Simulator (Alt+B)' : 'Show 3D Devboard Simulator (Alt+B)';
    }
  }
  function setBoardPaneOpen(open) {
    boardPaneOpen = !!open;
    syncBoardVisibility();
    applyLayout();
    if (boardPaneOpen) requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }
  function resetLayout() {
    layout = { ...DEFAULT_LAYOUT };
    $('#app').classList.remove('no-library', 'panel-max');
    $('#app').classList.add('no-waves');
    $('#right')?.classList.add('hidden');
    setBoardPaneOpen(false);
    setEditorPaneOpen(true);
    applyLayout(); saveLayout();
    api.syncNavigation();
  }

  // ---------- problems ----------
  const markersFor = name => problems.filter(p => p.file && (p.file.toLowerCase() === name.toLowerCase() || baseNameOf(p.file).toLowerCase() === baseNameOf(name).toLowerCase()) && p.line > 0);
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
        const matchSrc = problem.file ? findByDiagFile(problem.file) : null;
        if (matchSrc) row.onclick = () => openFile(matchSrc.name, { line: problem.line, col: problem.col });
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
    const first = list.find(p => p.file && p.line && findByDiagFile(p.file));
    if (first && $('#sourceDialog')?.open) openFile(findByDiagFile(first.file).name, { line: first.line, col: first.col, focus: false });
    return list.length;
  }

  // ---------- editor tabs ----------
  const isDirty = name => {
    const doc = docs.get(name);
    if (!doc) return false;
    if (doc.diskOnly) return doc.editor.value !== doc.saved;
    const source = find(name);
    return !!source && (doc.editor.value !== doc.saved || doc.library !== libraryOf(source));
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
      const label = document.createElement('span'); label.textContent = baseNameOf(name); main.append(label);
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
    $$('#srcList .tree-row').forEach(item => {
      const rel = item.dataset.rel;
      const type = item.dataset.type;
      const isSel = !!(selectedNode && selectedNode.rel === rel && selectedNode.type === type);
      item.classList.toggle('selected', isSel);
      if (type === 'file') {
        item.classList.toggle('active', rel === active);
        item.classList.toggle('dirty', isDirty(rel));
      }
    });
  }
  function syncWordWrapUI() {
    const btn = $('#btnWordWrap');
    if (btn) {
      btn.classList.toggle('active', wordWrap);
      btn.setAttribute('aria-pressed', String(wordWrap));
    }
  }
  function toggleWordWrap(force) {
    wordWrap = force !== undefined ? !!force : !wordWrap;
    try { localStorage.setItem('trace.wordWrap', wordWrap ? '1' : '0'); } catch {}
    api.persistAppState?.({ wordWrap });
    for (const doc of docs.values()) doc.editor.setWordWrap(wordWrap);
    syncWordWrapUI();
  }
  function syncMarkdownView() {
    const isMd = !!(active && /\.md$/i.test(active) && docs.has(active));
    $('#mdModeSwitch')?.classList.toggle('hidden', !isMd);
    $$('#mdModeSwitch [data-md-mode]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mdMode === mdMode);
    });
    const preview = $('#mdPreviewPane');
    if (!preview) return;
    if (isMd && mdMode === 'view') {
      const doc = docs.get(active);
      preview.innerHTML = renderMarkdownHtml(doc.editor.value);
      preview.classList.remove('hidden');
      doc.editor.show(false);
    } else {
      preview.classList.add('hidden');
      if (active && docs.has(active)) docs.get(active).editor.show(true);
    }
  }
  function setMarkdownMode(mode = 'view') {
    mdMode = mode === 'raw' ? 'raw' : 'view';
    syncMarkdownView();
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
    selectedNode = { type: 'file', rel: name, name: baseNameOf(name) };
    for (const [other, doc] of docs) {
      doc.editor.show(other === name);
      if (other === name) doc.editor.input.id = 'sourceEditor'; else doc.editor.input.removeAttribute('id');
    }
    syncFallbackId();
    const doc = docs.get(name);
    const isVhdl = !doc.diskOnly && /\.(vhd|vhdl|vho)$/i.test(name);
    if ($('#editorKind')) $('#editorKind').textContent = fileKindLabel(name);
    if ($('#sourceLibraryWrap')) $('#sourceLibraryWrap').classList.toggle('hidden', !isVhdl);
    if ($('#sourceLibrary')) $('#sourceLibrary').value = doc.library || 'work';
    if ($('#sourceName')) $('#sourceName').textContent = name;
    if ($('#editorCrumb')) $('#editorCrumb').textContent = name;
    $('#editorBar')?.classList.remove('hidden');
    $('#editorEmpty')?.classList.add('hidden');
    cursor = doc.editor.cursor();
    syncMarkdownView();
    renderTabs(); updateStatus();
  }
  function mountDocTab(name, text, { library = 'work', diskOnly = false, line = 0, col = 1, focus = true } = {}) {
    const dialog = $('#sourceDialog');
    if (dialog && !dialog.open) dialog.show();
    syncEditorVisibility();
    let doc = docs.get(name);
    if (!doc) {
      const editor = new CodeEditor($('#editorHost'), {
        language: languageFor(name),
        wordWrap,
        onToggleWrap: () => toggleWordWrap(),
        onChange: () => {
          const current = docs.get(name);
          if (!current) return;
          const dirty = isDirty(name);
          if (dirty && !current.diskOnly && !S.dirty) api.markDirty();
          if (dirty !== current.dirty) renderTabs();
        },
        onSave: () => saveActiveFile(),
        onCursor: info => { if (active === name) { cursor = info; updateStatus(); } },
      });
      editor.setValue(text);
      editor.setMarkers(diskOnly ? [] : markersFor(name));
      doc = { editor, saved: text, library, dirty: false, diskOnly };
      docs.set(name, doc);
    }
    if (!tabs.includes(name)) tabs.push(name);
    activate(name);
    if (line) doc.editor.goto(line, col);
    else if (focus) requestAnimationFrame(() => doc.editor.focus());
    return true;
  }
  function openFile(name, { line = 0, col = 1, focus = true } = {}) {
    const source = find(name);
    if (!source) {
      if (docs.has(name)) {
        activate(name);
        if (line) docs.get(name).editor.goto(line, col);
        else if (focus) requestAnimationFrame(() => docs.get(name).editor.focus());
        return true;
      }
      return false;
    }
    return mountDocTab(source.name, source.text, { library: libraryOf(source), diskOnly: false, line, col, focus });
  }
  async function openDiskFile(rel, opts = {}) {
    const source = find(rel);
    if (source) return openFile(source.name, opts);
    if (docs.has(rel)) return openFile(rel, opts);
    if (!S.projectDir) return false;
    try {
      const res = await fetch('/api/project/read-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: S.projectDir, rel }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not open file.');
      return mountDocTab(data.rel || rel, data.text ?? '', { library: 'work', diskOnly: true, ...opts });
    } catch (e) {
      api.toast(e.message, 'err');
      return false;
    }
  }
  function closeTabNow(name) {
    const doc = docs.get(name);
    if (!doc) return;
    doc.editor.dispose(); docs.delete(name);
    const index = tabs.indexOf(name); if (index >= 0) tabs.splice(index, 1);
    if (active === name) {
      active = null;
      const next = tabs[Math.min(index, tabs.length - 1)];
      if (next) activate(next);
      else {
        if (selectedNode?.type === 'file' && selectedNode.rel === name) selectedNode = null;
        syncFallbackId();
        $('#editorBar')?.classList.add('hidden');
        $('#mdPreviewPane')?.classList.add('hidden');
        $('#editorEmpty')?.classList.remove('hidden');
        if ($('#sourceName')) $('#sourceName').textContent = '';
        if ($('#editorCrumb')) $('#editorCrumb').textContent = '';
        cursor = null; renderTabs(); updateStatus();
      }
    } else renderTabs();
  }
  function closeTab(name, force = false) {
    const doc = docs.get(name);
    if (!doc) return;
    if (force || !isDirty(name)) {
      closeTabNow(name);
      return;
    }
    openExplorerDialog({
      eyebrow: 'UNSAVED CHANGES',
      title: `Close ${baseNameOf(name)}?`,
      text: `Discard unsaved changes to "${name}"?`,
      confirmText: 'Discard & Close',
      danger: true,
    }).then(confirmed => {
      if (confirmed !== null) closeTabNow(name);
    });
  }
  function hasUnsaved() {
    if (active && docs.has(active) && $('#sourceLibrary') && !docs.get(active).diskOnly) {
      docs.get(active).library = $('#sourceLibrary').value.trim();
    }
    return [...docs.keys()].some(name => !docs.get(name)?.diskOnly && isDirty(name));
  }
  function validateLibraries() {
    if (active && docs.has(active) && $('#sourceLibrary') && !docs.get(active).diskOnly) {
      docs.get(active).library = $('#sourceLibrary').value.trim();
    }
    const bad = [...docs.entries()].find(([name, doc]) => !doc.diskOnly && /\.(vhd|vhdl|vho)$/i.test(name) && !/^[a-z][a-z0-9_]*$/i.test(doc.library));
    if (bad) { api.toast('Enter a valid VHDL library name.', 'err'); return false; }
    return true;
  }
  function commitAll() {
    let changed = false;
    if (active && docs.has(active) && $('#sourceLibrary') && !docs.get(active).diskOnly) {
      docs.get(active).library = $('#sourceLibrary').value.trim();
    }
    for (const [name, doc] of docs) {
      if (doc.diskOnly) continue;
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
  async function saveActiveFile(targetName = active) {
    const name = targetName || active;
    if (!name || !docs.has(name)) {
      api.toast('Open a file in the editor to save it.');
      return false;
    }
    const doc = docs.get(name);
    if (!doc.diskOnly && /\.(vhd|vhdl|vho)$/i.test(name)) {
      if (name === active && $('#sourceLibrary')) doc.library = $('#sourceLibrary').value.trim();
      if (!/^[a-z][a-z0-9_]*$/i.test(doc.library || 'work')) {
        api.toast('Enter a valid VHDL library name.', 'err');
        return false;
      }
    }
    doc.editor.renderNow();
    const text = doc.editor.value;
    const source = !doc.diskOnly ? find(name) : null;
    const sourceChanged = !!(source && (source.text !== text || libraryOf(source) !== doc.library));
    if (!S.projectDir) {
      const savedAs = await saveActiveFileAs(name);
      if (savedAs) {
        if (source) {
          source.text = text;
          source.library = doc.library;
        }
        if (sourceChanged) { api.saveProject?.(); api.markDirty?.(); }
      }
      return savedAs;
    }
    try {
      const res = await fetch('/api/project/write-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: S.projectDir, rel: name, text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save file.');
      if (source) {
        source.text = text;
        source.library = doc.library;
        if (baselineProject && Array.isArray(baselineProject.sources)) {
          const bSrc = baselineProject.sources.find(s => s.name === source.name);
          if (bSrc) { bSrc.text = text; bSrc.library = doc.library || 'work'; }
          else baselineProject.sources.push({ name: source.name, text, library: doc.library || 'work' });
        }
      }
      doc.saved = text;
      if (/\.qsf$/i.test(name)) {
        api.reloadQsfText?.(text, name);
        if (baselineProject) baselineProject.assignments = [...S.assignments];
      }
      if (sourceChanged) { api.saveProject?.(); api.markDirty?.(); }
      if (detectProjectChanges().length === 0) {
        captureBaseline(projectTitle);
      }
      renderTabs();
      refreshProjectTree();
      api.toast(`Saved ${name}.`);
      api.logEvent?.('info', `Saved file: ${name}`);
      return true;
    } catch (e) {
      api.toast(e.message, 'err');
      return false;
    }
  }
  async function saveActiveFileAs(targetName = active) {
    const name = targetName || active;
    let text = '';
    const doc = name ? docs.get(name) : null;
    if (doc) {
      doc.editor.renderNow();
      text = doc.editor.value;
    } else if (name && find(name)) {
      text = find(name).text;
    } else {
      api.toast('Open a file in the editor first.', 'err');
      return false;
    }
    try {
      const picked = await openFileBrowserModal({
        mode: 'save-file',
        title: 'Save File As',
        eyebrow: 'SAVE FILE AS',
        initialDir: S.projectDir || '',
        defaultName: baseNameOf(name),
        confirmText: 'Save File',
      });
      const targetPath = picked?.filePath || picked?.file;
      if (!picked || picked.cancelled || !targetPath) return false;
      const writeRes = await fetch('/api/project/write-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: targetPath, text, saveToken: picked.saveToken }),
      });
      const written = await writeRes.json();
      if (!writeRes.ok) throw new Error(written.error || 'Could not write file.');
      const savedPath = written.filePath || written.file || targetPath;
      if (doc) {
        doc.saved = text;
        if (!doc.diskOnly && find(name)) {
          const src = find(name);
          src.text = text;
          src.library = doc.library;
          if (baselineProject && Array.isArray(baselineProject.sources)) {
            const bSrc = baselineProject.sources.find(s => s.name === src.name);
            if (bSrc) { bSrc.text = text; bSrc.library = doc.library || 'work'; }
            else baselineProject.sources.push({ name: src.name, text, library: doc.library || 'work' });
          }
        }
      }
      renderTabs();
      refreshProjectTree();
      const shortName = savedPath.split(/[\\/]/).filter(Boolean).pop() || baseNameOf(name);
      if (/\.qsf$/i.test(savedPath)) {
        api.reloadQsfText?.(text, shortName);
        if (baselineProject) baselineProject.assignments = [...S.assignments];
      }
      if (detectProjectChanges().length === 0) {
        captureBaseline(projectTitle);
      }
      api.toast(`Saved ${shortName} to ${savedPath}.`, 'ok');
      api.logEvent?.('info', `Saved file as: ${savedPath}`);
      return true;
    } catch (e) {
      api.toast(e.message, 'err');
      return false;
    }
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
      const doc = docs.get(name);
      if (doc?.diskOnly) continue;
      const source = find(name);
      if (!source) { closeTab(name, true); vanished = true; continue; }
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

  // ---------- explorer (real project folder tree + context menu) ----------
  let diskTree = null, treeSeq = 0, newEntryMode = 'file', newEntryDir = '', selectedNode = null;
  const expandedDirs = new Set();
  const virtualDirs = new Set();

  function countTreeFiles(nodes = []) {
    let total = 0;
    for (const node of nodes) {
      if (node.type === 'dir') total += countTreeFiles(node.children || []);
      else total += 1;
    }
    return total;
  }
  function buildVirtualTree() {
    const rootChildren = [];
    const dirMap = new Map([['', rootChildren]]);
    const ensureDir = relDir => {
      if (dirMap.has(relDir)) return dirMap.get(relDir);
      const parent = parentDirOf(relDir);
      const parentList = ensureDir(parent);
      const children = [];
      parentList.push({ type: 'dir', name: baseNameOf(relDir), rel: relDir, children });
      dirMap.set(relDir, children);
      return children;
    };
    for (const dir of virtualDirs) ensureDir(dir);
    for (const src of S.sources) {
      const rel = cleanRelPath(src.name);
      const parent = parentDirOf(rel);
      const list = ensureDir(parent);
      const name = baseNameOf(rel);
      const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
      list.push({ type: 'file', name, rel, ext });
    }
    const sortNodes = list => {
      list.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.type === 'dir' ? -1 : 1));
      for (const item of list) if (item.type === 'dir') sortNodes(item.children);
    };
    sortNodes(rootChildren);
    return rootChildren;
  }
  function renderProjectTree() {
    const host = $('#srcList');
    if (!host) return;
    const nodes = S.projectDir && Array.isArray(diskTree) ? diskTree : buildVirtualTree();
    const fileCount = countTreeFiles(nodes);
    if ($('#srcCount')) $('#srcCount').textContent = String(fileCount);
    const rootSummary = $('#projectRootSummary');
    if (rootSummary) {
      rootSummary.title = S.projectDir ? `Project folder: ${S.projectDir}\nRight-click for folder actions` : 'Unsaved workspace (File → Save Project As… to save on disk)';
    }
    host.replaceChildren();
    if (!nodes.length) {
      const empty = document.createElement('div');
      empty.className = 'tree-empty';
      empty.textContent = 'No files in project yet. Right-click or use + to create a file or folder.';
      host.append(empty);
      return;
    }
    const renderLevel = (list, depth) => {
      for (const node of list) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `tree-row ${node.type === 'dir' ? 'tree-dir' : 'tree-file'}`;
        row.dataset.type = node.type;
        row.dataset.rel = node.rel;
        row.style.paddingLeft = `${10 + depth * 14}px`;
        row.title = S.projectDir ? `${S.projectDir}\\${node.rel.replace(/\//g, '\\')}` : node.rel;
        const isSelected = selectedNode && selectedNode.rel === node.rel && selectedNode.type === node.type;
        if (isSelected) row.classList.add('selected');
        if (node.type === 'dir') {
          const isOpen = expandedDirs.has(node.rel);
          row.classList.toggle('expanded', isOpen);
          row.setAttribute('role', 'treeitem');
          row.setAttribute('aria-expanded', String(isOpen));
          row.innerHTML = `<span class="tree-chev" aria-hidden="true">›</span><svg class="tree-ico" viewBox="0 0 24 24" aria-hidden="true">${isOpen ? '<path d="M3 7V5h7l2 2h9v4H3z"/><path d="M3 11h18l-2 9H5z"/>' : '<path d="M3 7V5h7l2 2h9v13H3z"/>'}</svg>`;
          const label = document.createElement('span');
          label.className = 'tree-name';
          label.textContent = node.name;
          row.append(label);
          row.onclick = () => {
            selectedNode = { type: 'dir', rel: node.rel, name: node.name };
            if (expandedDirs.has(node.rel)) expandedDirs.delete(node.rel);
            else expandedDirs.add(node.rel);
            renderProjectTree();
          };
          row.oncontextmenu = e => openExplorerMenu(e, { type: 'dir', rel: node.rel, name: node.name });
          host.append(row);
          if (isOpen && node.children?.length) renderLevel(node.children, depth + 1);
        } else {
          row.setAttribute('role', 'treeitem');
          row.classList.toggle('active', node.rel === active);
          row.classList.toggle('dirty', isDirty(node.rel));
          const badge = document.createElement('span');
          badge.className = 'tree-badge';
          badge.textContent = fileKindLabel(node.name);
          const label = document.createElement('span');
          label.className = 'tree-name src-name';
          label.textContent = node.name;
          row.append(badge, label);
          row.onclick = () => {
            selectedNode = { type: 'file', rel: node.rel, name: node.name };
            openDiskFile(node.rel);
            renderProjectTree();
          };
          row.oncontextmenu = e => openExplorerMenu(e, { type: 'file', rel: node.rel, name: node.name });
          host.append(row);
        }
      }
    };
    renderLevel(nodes, 0);
  }
  async function refreshProjectTree() {
    if (!S.projectDir) {
      diskTree = null;
      renderProjectTree();
      return;
    }
    const seq = ++treeSeq;
    try {
      const res = await fetch('/api/project/tree', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: S.projectDir }),
      });
      const data = await res.json();
      if (seq !== treeSeq) return;
      if (res.ok && data.ok) {
        diskTree = data.children || [];
      } else {
        diskTree = null;
      }
    } catch {
      if (seq !== treeSeq) return;
      diskTree = null;
    }
    renderProjectTree();
  }
  function defaultTargetDir() {
    if (!selectedNode) return '';
    return selectedNode.type === 'dir' ? selectedNode.rel : parentDirOf(selectedNode.rel);
  }
  function openNewEntry(mode, targetDir = null) {
    showHome(false);
    closeExplorerMenu();
    newEntryMode = mode;
    newEntryDir = targetDir !== null ? cleanRelPath(targetDir) : defaultTargetDir();
    if (newEntryDir) expandedDirs.add(newEntryDir);
    const sec = $('.exp-project'); if (sec) sec.open = true;
    if ($('#app').classList.contains('no-library') || !$('#ltab-library')?.classList.contains('active')) $('#btnLibrary').click();
    const prefix = $('#newEntryPrefix');
    if (prefix) {
      prefix.textContent = newEntryDir ? `${newEntryDir}/` : '';
      prefix.classList.toggle('hidden', !newEntryDir);
    }
    const input = $('#newFileName');
    if (input) {
      input.placeholder = mode === 'folder' ? 'folder_name' : 'filename.vhd';
      input.setAttribute('aria-label', mode === 'folder' ? 'New folder name' : 'New file name');
      input.value = '';
    }
    if ($('#newEntrySubmit')) $('#newEntrySubmit').textContent = mode === 'folder' ? 'Create' : 'Add';
    $('#newFileRow')?.classList.remove('hidden');
    input?.focus();
  }
  function showNewFile(targetDir = null) { openNewEntry('file', targetDir); }
  function showNewFolder(targetDir = null) { openNewEntry('folder', targetDir); }
  async function submitNewEntry(raw) {
    const cleaned = cleanRelPath(raw);
    if (!cleaned) return;
    const rel = newEntryDir ? `${newEntryDir}/${cleaned}` : cleaned;
    if (!isValidRelPath(rel)) {
      return api.toast('Invalid name. Avoid .. and special characters <>:"|?*', 'err');
    }
    if (newEntryMode === 'folder') {
      if (S.projectDir) {
        try {
          const res = await fetch('/api/project/mkdir', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dir: S.projectDir, rel }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Could not create folder.');
        } catch (e) {
          return api.toast(e.message, 'err');
        }
      } else {
        virtualDirs.add(rel);
      }
      for (let p = rel; p; p = parentDirOf(p)) expandedDirs.add(p);
      selectedNode = { type: 'dir', rel, name: baseNameOf(rel) };
      $('#newFileRow')?.classList.add('hidden');
      await refreshProjectTree();
      api.toast(`Created folder ${rel}.`);
      return;
    }
    // File creation
    const initialText = template(rel);
    const isSourceCandidate = NAME_PATTERN.test(rel);
    if (isSourceCandidate && S.sources.some(source => source.name.toLowerCase() === rel.toLowerCase())) {
      return api.toast(`${rel} already exists.`, 'err');
    }
    if (isSourceCandidate && S.sources.length >= 100) {
      return api.toast('A project can hold at most 100 compilable source files.', 'err');
    }
    if (S.projectDir) {
      try {
        const res = await fetch('/api/project/write-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dir: S.projectDir, rel, text: initialText }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not create file.');
      } catch (e) {
        return api.toast(e.message, 'err');
      }
    }
    for (let p = parentDirOf(rel); p; p = parentDirOf(p)) expandedDirs.add(p);
    selectedNode = { type: 'file', rel, name: baseNameOf(rel) };
    $('#newFileRow')?.classList.add('hidden');
    if (isSourceCandidate) {
      S.sources.push({ name: rel, text: initialText, library: 'work' });
      api.renderSources();
      api.markDirty();
      openFile(rel);
    } else {
      mountDocTab(rel, initialText, { library: 'work', diskOnly: true });
    }
    await refreshProjectTree();
    api.toast(`Created ${rel}.`);
  }

  // ---------- explorer modal (rename / delete confirmation) ----------
  let eaResolve = null;
  function openExplorerDialog({ eyebrow = 'FILE EXPLORER', title = 'Confirm', text = '', hint = '', inputValue = null, confirmText = 'Confirm', danger = false } = {}) {
    const dlg = $('#explorerActionDialog');
    if (!dlg) return Promise.resolve(null);
    $('#eaEyebrow').textContent = eyebrow;
    $('#eaTitle').textContent = title;
    $('#eaText').textContent = text;
    const hintEl = $('#eaHint');
    hintEl.textContent = hint;
    hintEl.classList.toggle('hidden', !hint);
    const inputEl = $('#eaInput');
    const hasInput = inputValue !== null;
    inputEl.classList.toggle('hidden', !hasInput);
    inputEl.required = hasInput;
    inputEl.value = hasInput ? inputValue : '';
    const btn = $('#eaConfirm');
    btn.textContent = confirmText;
    btn.className = danger ? 'btn confirm-discard' : 'btn dark';
    return new Promise(resolve => {
      eaResolve = resolve;
      if (!dlg.open) dlg.showModal();
      if (hasInput) {
        requestAnimationFrame(() => {
          inputEl.focus();
          const dot = inputEl.value.lastIndexOf('.');
          if (dot > 0) inputEl.setSelectionRange(0, dot);
          else inputEl.select();
        });
      } else {
        requestAnimationFrame(() => btn.focus());
      }
    });
  }
  async function renameNode(node) {
    if (!node || !node.rel) return;
    const oldRel = node.rel;
    const parent = parentDirOf(oldRel);
    const answer = await openExplorerDialog({
      eyebrow: node.type === 'dir' ? 'RENAME FOLDER' : 'RENAME FILE',
      title: `Rename ${node.name}`,
      text: `Enter a new name for ${oldRel}:`,
      inputValue: node.name,
      confirmText: 'Rename',
    });
    if (answer === null) return;
    const newName = cleanRelPath(answer);
    if (!newName || newName.includes('/')) {
      return api.toast('Enter a single file or folder name without slashes.', 'err');
    }
    const newRel = parent ? `${parent}/${newName}` : newName;
    if (newRel === oldRel) return;
    if (!isValidRelPath(newRel)) return api.toast('Invalid name. Avoid .. and special characters <>:"|?*', 'err');
    if (S.projectDir) {
      try {
        const res = await fetch('/api/project/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dir: S.projectDir, oldRel, newRel }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Rename failed.');
      } catch (e) {
        return api.toast(e.message, 'err');
      }
    }
    const replacePrefix = p => {
      if (p === oldRel) return newRel;
      if (node.type === 'dir' && p.startsWith(oldRel + '/')) return newRel + p.slice(oldRel.length);
      return p;
    };
    let sourcesChanged = false;
    for (const src of S.sources) {
      const updated = replacePrefix(src.name);
      if (updated !== src.name) { src.name = updated; sourcesChanged = true; }
    }
    if (node.type === 'file') {
      const wasCompilable = NAME_PATTERN.test(oldRel);
      const isCompilable = NAME_PATTERN.test(newRel);
      if (wasCompilable && !isCompilable) {
        const idx = S.sources.findIndex(s => s.name === newRel);
        if (idx >= 0) { S.sources.splice(idx, 1); sourcesChanged = true; }
      }
    }
    for (const dir of [...virtualDirs]) {
      const updated = replacePrefix(dir);
      if (updated !== dir) { virtualDirs.delete(dir); virtualDirs.add(updated); }
    }
    for (const dir of [...expandedDirs]) {
      const updated = replacePrefix(dir);
      if (updated !== dir) { expandedDirs.delete(dir); expandedDirs.add(updated); }
    }
    for (const key of [...docs.keys()]) {
      const updated = replacePrefix(key);
      if (updated !== key) {
        const doc = docs.get(key);
        docs.delete(key);
        docs.set(updated, doc);
        doc.editor.setLanguage?.(languageFor(updated));
        if (node.type === 'file' && updated === newRel) {
          if (NAME_PATTERN.test(oldRel) && !NAME_PATTERN.test(newRel)) {
            doc.diskOnly = true;
          } else if (!NAME_PATTERN.test(oldRel) && NAME_PATTERN.test(newRel)) {
            doc.diskOnly = false;
            if (!find(newRel)) {
              S.sources.push({ name: newRel, text: doc.editor.value, library: 'work' });
              sourcesChanged = true;
            }
          }
        }
        const idx = tabs.indexOf(key);
        if (idx >= 0) tabs[idx] = updated;
        if (active === key) active = updated;
      }
    }
    selectedNode = { type: node.type, rel: newRel, name: baseNameOf(newRel) };
    if (active && docs.has(active)) activate(active);
    if (sourcesChanged) { api.renderSources(); api.markDirty(); }
    else renderTabs();
    await refreshProjectTree();
    api.toast(`Renamed ${oldRel} → ${newRel}.`);
  }
  async function deleteNode(node) {
    if (!node || !node.rel) return;
    if (S.building || S.importing || S.exporting) return;
    const confirmed = await openExplorerDialog({
      eyebrow: node.type === 'dir' ? 'DELETE FOLDER' : 'DELETE FILE',
      title: `Delete ${node.name}?`,
      text: S.projectDir
        ? `Permanently delete "${node.rel}" ${node.type === 'dir' ? 'and all files inside it ' : ''}from ${S.projectDir}?`
        : `Remove "${node.rel}" from this workspace?`,
      hint: S.projectDir ? 'This deletes the item from disk and cannot be undone.' : 'Unsaved workspace edits to this item will be lost.',
      confirmText: node.type === 'dir' ? 'Delete Folder' : 'Delete File',
      danger: true,
    });
    if (confirmed === null) return;
    if (S.projectDir) {
      try {
        const res = await fetch('/api/project/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dir: S.projectDir, rel: node.rel }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Delete failed.');
      } catch (e) {
        return api.toast(e.message, 'err');
      }
    }
    const matches = p => p === node.rel || (node.type === 'dir' && p.startsWith(node.rel + '/'));
    const beforeLen = S.sources.length;
    S.sources = S.sources.filter(src => !matches(src.name));
    for (const dir of [...virtualDirs]) if (matches(dir)) virtualDirs.delete(dir);
    for (const dir of [...expandedDirs]) if (matches(dir)) expandedDirs.delete(dir);
    for (const key of [...docs.keys()]) if (matches(key)) closeTab(key, true);
    if (selectedNode && matches(selectedNode.rel)) selectedNode = null;
    if (S.sources.length !== beforeLen) { api.renderSources(); api.markDirty(); }
    else renderTabs();
    await refreshProjectTree();
    api.toast(`Deleted ${node.rel}.`);
  }
  async function revealNode(rel = '') {
    if (!S.projectDir) return api.toast('Save the project to disk first to reveal it in File Explorer.');
    try {
      const res = await fetch('/api/project/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: S.projectDir, rel }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not open File Explorer.');
    } catch (e) {
      api.toast(e.message, 'err');
    }
  }
  function closeExplorerMenu() {
    $('#explorerMenu')?.classList.add('hidden');
  }
  function openExplorerMenu(event, node) {
    event.preventDefault();
    event.stopPropagation();
    closeMenus();
    if (node && node.type !== 'root') {
      selectedNode = node;
      renderProjectTree();
    }
    const menu = $('#explorerMenu');
    if (!menu) return;
    menu.replaceChildren();
    const addItem = (label, onClick, { kbd = '', danger = false, disabled = false } = {}) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      if (danger) btn.classList.add('danger');
      btn.disabled = disabled;
      const span = document.createElement('span');
      span.textContent = label;
      btn.append(span);
      if (kbd) { const k = document.createElement('kbd'); k.textContent = kbd; btn.append(k); }
      btn.onclick = e => { e.stopPropagation(); closeExplorerMenu(); onClick(); };
      menu.append(btn);
    };
    const addSep = () => menu.append(document.createElement('hr'));
    if (!node || node.type === 'root') {
      addItem('New File…', () => showNewFile(''), { kbd: 'Ctrl+Alt+N' });
      addItem('New Folder…', () => showNewFolder(''));
      addItem('Import Files…', () => $('#fileInput').click(), { kbd: 'Ctrl+O' });
      addItem('Refresh Explorer', () => refreshProjectTree());
      addSep();
      addItem(S.projectDir ? 'Save Project' : 'Save Project As…', () => api.saveProjectToDisk?.({ saveAs: false }), { kbd: 'Ctrl+Shift+S' });
      addItem('Reveal Project Folder', () => revealNode(''), { disabled: !S.projectDir });
    } else if (node.type === 'dir') {
      addItem('New File…', () => showNewFile(node.rel));
      addItem('New Folder…', () => showNewFolder(node.rel));
      addItem('Import Files…', () => $('#fileInput').click());
      addSep();
      addItem('Rename Folder…', () => renameNode(node), { kbd: 'F2' });
      addItem('Copy Relative Path', () => { navigator.clipboard?.writeText(node.rel).catch(() => {}); api.toast(`Copied ${node.rel}`); });
      addItem('Reveal in File Explorer', () => revealNode(node.rel), { disabled: !S.projectDir });
      addSep();
      addItem('Delete Folder…', () => deleteNode(node), { danger: true });
    } else {
      addItem('Open', () => openDiskFile(node.rel));
      addItem('Rename…', () => renameNode(node), { kbd: 'F2' });
      addSep();
      addItem('Save File', async () => { await openDiskFile(node.rel, { focus: false }); saveActiveFile(node.rel); }, { kbd: 'Ctrl+S' });
      addItem('Save File As…', async () => { await openDiskFile(node.rel, { focus: false }); saveActiveFileAs(node.rel); }, { kbd: 'Ctrl+Alt+S' });
      addItem('Copy Relative Path', () => { navigator.clipboard?.writeText(node.rel).catch(() => {}); api.toast(`Copied ${node.rel}`); });
      addItem('Reveal in File Explorer', () => revealNode(node.rel), { disabled: !S.projectDir });
      addSep();
      addItem('Delete…', () => deleteNode(node), { danger: true });
    }
    menu.classList.remove('hidden');
    const rect = menu.getBoundingClientRect();
    const x = Math.min(event.clientX, Math.max(8, window.innerWidth - rect.width - 8));
    const y = Math.min(event.clientY, Math.max(8, window.innerHeight - rect.height - 8));
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
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
    const trimmed = list.slice(0, 12);
    try { localStorage.setItem(RECENTS_KEY, JSON.stringify(trimmed)); } catch {}
    api.persistAppState?.({ recents: trimmed });
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
  function detectProjectChanges() {
    const dirtyTabs = [...docs.keys()].filter(isDirty);
    const changes = [];
    if (dirtyTabs.length) changes.push(`unsaved editor edits in ${dirtyTabs.join(', ')}`);
    if (baselineProject) {
      const baseFiles = new Map((baselineProject.sources || []).map(s => [s.name, { text: s.text, lib: s.library || 'work' }]));
      const curFiles = new Map(S.sources.map(s => [s.name, {
        text: docs.has(s.name) ? docs.get(s.name).editor.value : s.text,
        lib: docs.has(s.name) ? (docs.get(s.name).library || 'work') : (s.library || 'work'),
      }]));
      const modified = [];
      for (const [name, cur] of curFiles) {
        const base = baseFiles.get(name);
        if (!base || base.text !== cur.text || base.lib !== cur.lib) modified.push(name);
      }
      for (const name of baseFiles.keys()) {
        if (!curFiles.has(name)) modified.push(name);
      }
      const uniqueMod = [...new Set(modified)].filter(n => !dirtyTabs.includes(n));
      if (uniqueMod.length) changes.push(`modified sources (${uniqueMod.join(', ')})`);
      if (JSON.stringify([...S.assignments]) !== JSON.stringify(baselineProject.assignments || [])) changes.push('pin mappings');
      const curTop = $('#topSelect')?.value || '';
      const curTopLib = $('#topLibrary')?.value || 'work';
      const curSdf = S.sdf ? `${S.sdf.name}|${$('#sdfInstance')?.value || ''}|${$('#sdfCorner')?.value || ''}` : '';
      const baseSdf = baselineProject.sdf ? `${baselineProject.sdf.name}|${baselineProject.sdf.instance || ''}|${baselineProject.sdf.corner || ''}` : '';
      if (($('#standardSelect')?.value || S.standard) !== baselineProject.standard || ($('#genericInput')?.value || '') !== (baselineProject.generics || '') || curTop !== (baselineProject.top || '') || curTopLib !== (baselineProject.topLibrary || 'work') || curSdf !== baseSdf) {
        changes.push('compiler settings');
      }
    }
    return changes;
  }
  function describeRecentChanges() {
    const changes = detectProjectChanges();
    return changes.length
      ? `Detected ${changes.join(', ')}. Saving updates your workspace and Recent Projects list; discarding reverts these changes. All active simulations will be cancelled and stopped.`
      : 'Saving updates your workspace and Recent Projects list; discarding reverts any changes from this session. Returning to the Home menu will cancel and stop all active simulations.';
  }
  function recordRecentProject(customTitle = '', customDir = null, customQpf = null) {
    if (!S.sources.length || !api.projectData) return;
    const project = api.projectData();
    const topName = project.top || S.sim?.top || project.sources[0]?.name.replace(/\.[^.]+$/, '') || 'fpga_project';
    const title = customTitle || S.projectName || projectTitle || (topName === DEMO_TOP ? 'Counter demo' : topName);
    const dir = customDir !== null ? customDir : (S.projectDir || null);
    const key = dir ? `dir::${dir.toLowerCase()}` : `${title.toLowerCase()}::${project.sources.map(s => s.name).join(',')}`;
    const list = loadRecents().filter(item => item.key !== key);
    list.unshift({
      key,
      title,
      top: topName,
      standard: project.standard || S.standard || '93',
      files: project.sources.map(s => s.name),
      dir,
      qpf: customQpf || null,
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
      filesRow.textContent = item.dir ? `${item.dir} · ${item.files?.join(', ') || ''}` : `${item.files?.join(', ') || 'No files'} · Top: ${item.top || 'auto'}`;
      openBtn.append(titleRow, filesRow);
      openBtn.onclick = async () => {
        try {
          if (item.dir && api.openProjectFromDiskPath) {
            const opened = await api.openProjectFromDiskPath(item.dir);
            if (opened) return;
          }
          const prevRecents = loadRecents();
          let prevStorage = null;
          try { prevStorage = localStorage.getItem('trace.project.v1'); } catch {}
          await api.stopAllSimulations?.();
          for (const name of [...docs.keys()]) closeTab(name, true);
          api.restoreProject(item.project);
          openFirst();
          captureBaseline(item.title, { prevRecents, prevStorage });
          showHome(false);
          const restoredState = await api.restoreSavedCompileState?.();
          const suffix = restoredState === 'flashed' ? 'Restored compiled & flashed state.' : restoredState === 'compiled' ? 'Restored compiled state — ready to flash.' : 'Click Compile when ready.';
          api.toast(`Opened ${item.title}. ${suffix}`);
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
  let hasActiveSession = false;
  function syncHomeContinue() {
    $('#homeContinueBtn')?.classList.toggle('hidden', !hasActiveSession || !S.sources.length);
  }
  function showHome(visible = true, { clearSession = false } = {}) {
    const view = $('#homeView');
    if (!view) return;
    if (!visible) hasActiveSession = true;
    else if (clearSession) hasActiveSession = false;
    syncHomeContinue();
    if (visible) renderHome();
    view.classList.toggle('hidden', !visible);
    $('#btnHome')?.classList.toggle('active', visible);
  }
  function resumeWorkbench() {
    if (!hasActiveSession || !S.sources.length) return;
    captureBaseline(projectTitle);
    showHome(false);
  }
  let pendingSwitch = null;
  function requestProjectSwitch({ label = 'this project', newWindowUrl = '/?newProject=1', onSwitchHere } = {}) {
    const view = $('#homeView');
    if (view && !view.classList.contains('hidden')) {
      onSwitchHere?.();
      return;
    }
    const dlg = $('#projectSwitchDialog');
    if (!dlg) {
      onSwitchHere?.();
      return;
    }
    const changes = detectProjectChanges();
    const hasChanges = changes.length > 0;
    pendingSwitch = { label, newWindowUrl, onSwitchHere, hasChanges };
    if ($('#psTitle')) $('#psTitle').textContent = `Open ${label}?`;
    if ($('#psCurrentProject')) $('#psCurrentProject').textContent = currentProjectTitle();
    if ($('#psDetail')) {
      $('#psDetail').textContent = changes.length
        ? `Detected ${changes.join(', ')}. Open in a new Trace window to keep both running independently, or save/discard changes and switch here.`
        : 'Open in a new Trace window to keep both projects running independently, or replace the project in this window.';
    }
    if ($('#psDiscard')) $('#psDiscard').classList.toggle('hidden', !hasChanges);
    if ($('#psSave')) {
      $('#psSave').textContent = !hasChanges ? 'Open in This Window' : (S.projectDir ? 'Save & Open Here' : 'Save As… & Open Here');
    }
    if (!dlg.open) dlg.showModal();
  }
  let entityTouched = false;
  function syncWizardPreview() {
    const ent = ($('#npEntity')?.value || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_') || 'fpga_lab';
    const extras = ($('#npExtraFiles')?.value || '').split(',').map(s => s.trim()).filter(Boolean).map(s => /\.[a-z0-9]+$/i.test(s) ? s : `${s}.vhd`);
    if ($('#npFilePreview')) $('#npFilePreview').textContent = [`${ent}.vhd`, ...extras].join(', ');
  }
  function openNewProjectWizard() {
    const dlg = $('#newProjectDialog');
    if (!dlg) return;
    entityTouched = false;
    $('#homeWizardForm')?.reset();
    syncWizardPreview();
    if (!dlg.open) dlg.showModal();
    requestAnimationFrame(() => { $('#npName')?.focus(); $('#npName')?.select(); });
  }
  function requestReturnHome({ focusWizard = false } = {}) {
    const view = $('#homeView');
    if (!view || !view.classList.contains('hidden')) {
      if (focusWizard) openNewProjectWizard();
      return;
    }
    pendingFocusWizard = focusWizard;
    const changes = detectProjectChanges();
    const hasUnsaved = changes.length > 0;
    const dlg = $('#homeConfirmDialog');
    if (!dlg || !hasUnsaved) {
      api.stopAllSimulations?.();
      showHome(true, { clearSession: true });
      if (focusWizard) { pendingFocusWizard = false; openNewProjectWizard(); }
      return;
    }
    if ($('#homeConfirmProject')) $('#homeConfirmProject').textContent = currentProjectTitle();
    if ($('#homeConfirmDetail')) $('#homeConfirmDetail').textContent = describeRecentChanges();
    if ($('#homeConfirmSave')) $('#homeConfirmSave').textContent = S.projectDir ? 'Save & Return Home' : 'Save Project As… & Return';
    if (!dlg.open) dlg.showModal();
  }
  async function confirmSaveAndReturnHome() {
    if (!validateLibraries()) return;
    commitAll();
    api.renderSources();
    if (api.saveProjectToDisk) {
      const ok = await api.saveProjectToDisk({ saveAs: !S.projectDir });
      if (!ok) return;
    } else {
      api.saveProject?.();
      recordRecentProject(projectTitle);
      captureBaseline(projectTitle);
    }
    $('#homeConfirmDialog')?.close();
    await api.stopAllSimulations?.();
    showHome(true, { clearSession: true });
    if (pendingFocusWizard) {
      pendingFocusWizard = false;
      openNewProjectWizard();
    }
    api.logEvent?.('info', `Returned to Home: saved changes to ${currentProjectTitle()} (${S.projectDir || 'local'}) and stopped all simulations`);
  }
  async function confirmDiscardAndReturnHome() {
    const discardedTitle = currentProjectTitle();
    for (const name of [...docs.keys()]) closeTab(name, true);
    if (baselineProject) {
      try { api.restoreProject(JSON.parse(JSON.stringify(baselineProject))); } catch {}
    }
    openFirst();
    try {
      if (baselineStorage === null) localStorage.removeItem('trace.project.v1');
      else localStorage.setItem('trace.project.v1', baselineStorage);
      api.persistAppState?.({ lastProject: baselineStorage ? JSON.parse(baselineStorage) : null });
    } catch {}
    saveRecents(baselineRecents);
    setProblems([]);
    $('#homeConfirmDialog')?.close();
    await api.stopAllSimulations?.();
    showHome(true, { clearSession: true });
    if (pendingFocusWizard) {
      pendingFocusWizard = false;
      openNewProjectWizard();
    }
    api.toast('Discarded recent changes. All simulations stopped.');
    api.logEvent?.('info', `Returned to Home: discarded changes to ${discardedTitle} and stopped all simulations`);
  }
  function isSkipHomeExitConfirm() {
    try { return localStorage.getItem('trace.skipHomeExitConfirm') === '1'; } catch { return false; }
  }
  function setSkipHomeExitConfirm(skip) {
    try {
      if (skip) localStorage.setItem('trace.skipHomeExitConfirm', '1');
      else localStorage.removeItem('trace.skipHomeExitConfirm');
    } catch {}
    api.persistAppState?.({ skipHomeExitConfirm: !!skip });
  }
  function toggleAppFullscreen() {
    if (window.chrome?.webview?.postMessage) {
      window.chrome.webview.postMessage('app:toggle-fullscreen');
    } else if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }
  async function executeNativeExit() {
    await api.stopAllSimulations?.();
    await api.prepareExit?.();
    if (window.chrome?.webview?.postMessage) {
      window.chrome.webview.postMessage('app:close-now');
    } else {
      window.close();
    }
  }
  function closeOtherModals(keepId) {
    $$('dialog[open]').forEach(d => {
      if (d.id !== keepId && d.id !== 'sourceDialog') {
        try { d.close(); } catch {}
      }
    });
  }
  function requestAppClose() {
    const view = $('#homeView');
    const inHome = !!(view && !view.classList.contains('hidden'));
    const changes = inHome ? [] : detectProjectChanges();
    if (inHome || changes.length === 0) {
      if (isSkipHomeExitConfirm()) {
        executeNativeExit();
        return;
      }
      const dlg = $('#exitHomeDialog');
      if (!dlg) {
        executeNativeExit();
        return;
      }
      closeOtherModals('exitHomeDialog');
      if ($('#exitHomeDontAsk')) $('#exitHomeDontAsk').checked = false;
      if (!dlg.open) dlg.showModal();
      return;
    }
    const dlg = $('#exitWorkbenchDialog');
    if (!dlg) {
      executeNativeExit();
      return;
    }
    closeOtherModals('exitWorkbenchDialog');
    if ($('#exitWbProject')) $('#exitWbProject').textContent = currentProjectTitle();
    if ($('#exitWbDetail')) $('#exitWbDetail').textContent = describeRecentChanges();
    if ($('#exitWbSave')) $('#exitWbSave').textContent = S.projectDir ? 'Save & Exit' : 'Save Project As… & Exit';
    if (!dlg.open) dlg.showModal();
  }
  async function confirmSaveAndExit() {
    if (!validateLibraries()) return;
    commitAll();
    api.renderSources();
    if (api.saveProjectToDisk) {
      const ok = await api.saveProjectToDisk({ saveAs: !S.projectDir });
      if (!ok) return;
    } else {
      api.saveProject?.();
      recordRecentProject(projectTitle);
      captureBaseline(projectTitle);
    }
    $('#exitWorkbenchDialog')?.close();
    api.logEvent?.('info', `Exited workbench: saved changes to ${currentProjectTitle()} (${S.projectDir || 'local'})`);
    await executeNativeExit();
  }
  async function confirmDiscardAndExit() {
    const discardedTitle = currentProjectTitle();
    for (const name of [...docs.keys()]) closeTab(name, true);
    if (baselineProject) {
      try { api.restoreProject(JSON.parse(JSON.stringify(baselineProject))); } catch {}
    }
    try {
      if (baselineStorage === null) localStorage.removeItem('trace.project.v1');
      else localStorage.setItem('trace.project.v1', baselineStorage);
      api.persistAppState?.({ lastProject: baselineStorage ? JSON.parse(baselineStorage) : null });
    } catch {}
    saveRecents(baselineRecents);
    $('#exitWorkbenchDialog')?.close();
    api.logEvent?.('info', `Exited workbench: discarded changes to ${discardedTitle}`);
    await executeNativeExit();
  }
  async function confirmHomeExit() {
    const dontAsk = !!$('#exitHomeDontAsk')?.checked;
    if (dontAsk) setSkipHomeExitConfirm(true);
    $('#exitHomeDialog')?.close();
    api.logEvent?.('info', `Exited application from Home menu (dontAskAgain=${dontAsk})`);
    await executeNativeExit();
  }
  window.__traceRequestClose = requestAppClose;
  async function launchTemplateProject({ name, entity, standard = '08', templateKind = 'board_io', extraFiles = '' }) {
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
    const sources = [{ name: fileName, text: code, library: 'work' }];
    const extras = String(extraFiles || '').split(',').map(s => s.trim()).filter(Boolean);
    for (let raw of extras) {
      if (!/\.[a-z0-9]+$/i.test(raw)) raw += '.vhd';
      if (!NAME_PATTERN.test(raw)) {
        api.toast(`Invalid additional filename: ${raw}`, 'err');
        return;
      }
      if (!sources.some(s => s.name.toLowerCase() === raw.toLowerCase())) {
        sources.push({ name: raw, text: template(raw), library: 'work' });
      }
    }
    for (const tabName of [...docs.keys()]) closeTab(tabName, true);
    virtualDirs.clear(); expandedDirs.clear(); diskTree = null; selectedNode = null;
    const project = {
      format: 'trace-project',
      version: 1,
      sources,
      assignments: [],
      top: cleanEntity,
      topLibrary: 'work',
      standard,
      generics: '',
      sdf: null,
      projectDir: null,
      projectName: name || cleanEntity,
    };
    $('#newProjectDialog')?.close();
    api.restoreProject(project);
    for (const src of sources) openFile(src.name, { focus: false });
    openFile(fileName);
    captureBaseline(name || cleanEntity, { prevRecents, prevStorage });
    api.syncProjectSaveUI?.();
    showHome(false);
    api.markDirty();
    api.toast(`Created ${name || cleanEntity} (${sources.length} file${sources.length === 1 ? '' : 's'}). Click Build & Compile when ready.`);
    api.logEvent?.('info', `Project created: ${name || cleanEntity} (top=${cleanEntity}, std=VHDL-${standard}, files=${sources.map(s => s.name).join(', ')})`);
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
      const card = document.createElement('div');
      card.className = 'home-hdl-group';
      const head = document.createElement('div');
      head.className = 'hhg-head';
      const titleSpan = document.createElement('span');
      titleSpan.className = 'hhg-title mono';
      titleSpan.textContent = group.dir === '.' ? 'Workspace Root' : group.dir;
      head.append(titleSpan);
      const qpfFile = group.files.find(f => f.kind === 'qpf') || group.files.find(f => f.kind === 'qsf');
      if (qpfFile && api.openProjectFromDiskPath) {
        const openProjBtn = document.createElement('button');
        openProjBtn.type = 'button';
        openProjBtn.className = 'hhg-open-btn';
        openProjBtn.textContent = 'Open Project →';
        openProjBtn.onclick = e => {
          e.stopPropagation();
          api.openProjectFromDiskPath(qpfFile.rel);
        };
        head.append(openProjBtn);
      }
      card.append(head);
      const filesBox = document.createElement('div');
      filesBox.className = 'hhg-files';
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
        pathSpan.textContent = file.name;
        btn.append(kind, pathSpan);
        btn.onclick = async () => {
          try {
            if ((file.kind === 'qpf' || file.kind === 'qsf') && api.openProjectFromDiskPath) {
              await api.openProjectFromDiskPath(file.rel);
              return;
            }
            const prevRecents = loadRecents();
            let prevStorage = null;
            try { prevStorage = localStorage.getItem('trace.project.v1'); } catch {}
            const response = await fetch('/api/hdl/file?path=' + encodeURIComponent(file.rel));
            if (!response.ok) throw new Error('File could not be read.');
            showHome(false);
            if (/\.md$/i.test(file.name)) {
              const mdText = await response.text();
              mountDocTab(file.name, mdText, { diskOnly: true });
              setMarkdownMode('view');
              return;
            }
            await api.loadFiles([new File([await response.blob()], file.name)]);
            captureBaseline(file.name.replace(/\.[^.]+$/, ''), { prevRecents, prevStorage });
          } catch (e) { api.toast(e.message, 'err'); }
        };
        filesBox.append(btn);
      }
      card.append(filesBox);
      container.append(card);
    }
  }

  async function openTutorial() {
    try {
      const res = await fetch('/api/tutorial');
      const data = await res.json();
      if (!res.ok || !data.text) throw new Error('Could not load TUTORIAL.md.');
      showHome(false);
      if (!$('#sourceDialog')?.open) setEditorPaneOpen(true);
      mountDocTab('TUTORIAL.md', data.text, { diskOnly: true, focus: false });
      setMarkdownMode('view');
    } catch (e) {
      api.toast(e.message, 'err');
    }
  }

  function cycleTab(delta = 1) {
    if (tabs.length < 2) return;
    const idx = Math.max(0, tabs.indexOf(active));
    const nextIdx = (idx + delta + tabs.length) % tabs.length;
    activate(tabs[nextIdx]);
  }

  // ---------- in-app native GUI file explorer modal ----------
  let fbState = {
    resolve: null,
    mode: 'folder',
    curDir: '',
    parentDir: null,
    entries: [],
    places: [],
    selectedPath: '',
    selectedType: '',
    extensions: null,
  };

  function fmtBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  async function fbNavigate(dir = '') {
    try {
      const res = await fetch('/api/fs/browse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir, projectDir: S.projectDir || '' }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not browse folder.');
      fbState.curDir = data.dir;
      fbState.parentDir = data.parent;
      fbState.entries = data.entries || [];
      fbState.places = data.places || [];
      if (fbState.mode === 'folder') {
        fbState.selectedPath = data.dir;
        fbState.selectedType = 'dir';
      } else {
        fbState.selectedPath = '';
        fbState.selectedType = '';
      }
      renderFileBrowser();
    } catch (e) {
      api.toast(e.message, 'err');
    }
  }

  function renderFileBrowser() {
    if ($('#fbPathInput')) $('#fbPathInput').value = fbState.curDir;
    if ($('#fbUpBtn')) $('#fbUpBtn').disabled = !fbState.parentDir;
    const placesHost = $('#fbPlaces');
    if (placesHost) {
      placesHost.replaceChildren();
      const iconFor = kind => ({ workspace: '◈', project: '★', docs: '▤', desktop: '▣', downloads: '↓', home: '⌂', drive: '⛁' }[kind] || '▸');
      for (const p of fbState.places) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `fb-place-btn${p.path.toLowerCase() === fbState.curDir.toLowerCase() ? ' active' : ''}`;
        btn.title = p.path;
        const ico = document.createElement('span');
        ico.className = 'fb-place-ico';
        ico.textContent = iconFor(p.kind);
        const lbl = document.createElement('span');
        lbl.textContent = p.label;
        btn.append(ico, lbl);
        btn.onclick = () => fbNavigate(p.path);
        placesHost.append(btn);
      }
    }
    const crumbsHost = $('#fbCrumbs');
    if (crumbsHost) {
      crumbsHost.replaceChildren();
      const parts = fbState.curDir.split(/[\\/]/).filter(Boolean);
      let accum = '';
      parts.forEach((seg, i) => {
        accum = i === 0 && seg.endsWith(':') ? `${seg}\\` : `${accum.replace(/\\$/, '')}\\${seg}`;
        const target = accum;
        if (i > 0) {
          const sep = document.createElement('span');
          sep.textContent = '›';
          crumbsHost.append(sep);
        }
        const cBtn = document.createElement('button');
        cBtn.type = 'button';
        cBtn.className = 'fb-crumb';
        cBtn.textContent = seg;
        cBtn.onclick = () => fbNavigate(target);
        crumbsHost.append(cBtn);
      });
    }
    const listHost = $('#fbList');
    if (!listHost) return;
    listHost.replaceChildren();
    const q = ($('#fbFilterInput')?.value || '').trim().toLowerCase();
    const filtered = fbState.entries.filter(item => {
      if (q && !item.name.toLowerCase().includes(q)) return false;
      if (fbState.mode === 'folder') return item.type === 'dir';
      if (item.type === 'file' && Array.isArray(fbState.extensions) && fbState.extensions.length) {
        return fbState.extensions.includes(item.ext);
      }
      return true;
    });
    if (!filtered.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 3;
      td.className = 'empty';
      td.textContent = fbState.mode === 'folder' ? 'No subfolders in this directory (click Select Folder below to choose this directory).' : 'No matching files or folders in this directory.';
      tr.append(td);
      listHost.append(tr);
    }
    for (const item of filtered) {
      const tr = document.createElement('tr');
      const isSel = fbState.selectedPath && fbState.selectedPath.toLowerCase() === item.path.toLowerCase();
      tr.className = `fb-row${isSel ? ' selected' : ''}`;
      const nameTd = document.createElement('td');
      const nameWrap = document.createElement('div');
      nameWrap.className = 'fb-name-cell';
      const badge = document.createElement('span');
      badge.className = `fb-badge ${item.type === 'dir' ? 'dir' : item.ext}`;
      badge.textContent = item.type === 'dir' ? 'DIR' : (item.ext || 'FILE').slice(0, 5).toUpperCase();
      const nameSpan = document.createElement('span');
      nameSpan.className = 'mono';
      nameSpan.textContent = item.name;
      nameWrap.append(badge, nameSpan);
      nameTd.append(nameWrap);
      const typeTd = document.createElement('td');
      typeTd.textContent = item.type === 'dir' ? 'Folder' : `${(item.ext || 'File').toUpperCase()} File`;
      const sizeTd = document.createElement('td');
      sizeTd.className = 'mono';
      sizeTd.textContent = item.type === 'dir' ? '—' : fmtBytes(item.size);
      tr.append(nameTd, typeTd, sizeTd);
      tr.onclick = () => {
        fbState.selectedPath = item.path;
        fbState.selectedType = item.type;
        if (item.type === 'file' && $('#fbFileNameInput')) {
          $('#fbFileNameInput').value = item.name;
        } else if (item.type === 'dir' && fbState.mode === 'folder' && $('#fbFileNameInput')) {
          $('#fbFileNameInput').value = item.path;
        }
        renderFileBrowser();
      };
      tr.ondblclick = () => {
        if (item.type === 'dir') {
          fbNavigate(item.path);
        } else {
          fbState.selectedPath = item.path;
          fbState.selectedType = 'file';
          if ($('#fbFileNameInput')) $('#fbFileNameInput').value = item.name;
          confirmFileBrowserSelection();
        }
      };
      listHost.append(tr);
    }
    if (fbState.mode === 'folder' && $('#fbFileNameInput')) {
      $('#fbFileNameInput').value = fbState.selectedPath || fbState.curDir;
    }
    if ($('#fbSelectionHint')) {
      $('#fbSelectionHint').textContent = fbState.mode === 'folder'
        ? `Target: ${fbState.selectedPath || fbState.curDir}`
        : fbState.selectedPath ? baseNameOf(fbState.selectedPath.replace(/\\/g, '/')) : '';
    }
  }

  async function confirmFileBrowserSelection() {
    try {
      let targetPath = '';
      if (fbState.mode === 'folder') {
        targetPath = ($('#fbFileNameInput')?.value || '').trim() || fbState.selectedPath || fbState.curDir;
      } else if (fbState.mode === 'save-file') {
        const fname = ($('#fbFileNameInput')?.value || '').trim();
        if (!fname) { api.toast('Enter a file name first.', 'err'); return; }
        targetPath = /^[a-z]:[\\/]/i.test(fname) ? fname : `${fbState.curDir.replace(/\\$/, '')}\\${fname}`;
      } else {
        if (fbState.selectedType === 'dir' && fbState.selectedPath && fbState.mode !== 'open-project') {
          await fbNavigate(fbState.selectedPath);
          return;
        }
        const typed = ($('#fbFileNameInput')?.value || '').trim();
        targetPath = fbState.selectedPath || (typed ? (/^[a-z]:[\\/]/i.test(typed) ? typed : `${fbState.curDir.replace(/\\$/, '')}\\${typed}`) : '');
        if (!targetPath) { api.toast('Select a file or project folder first.', 'err'); return; }
      }
      const res = await fetch('/api/fs/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPath, mode: fbState.mode }),
      });
      const auth = await res.json();
      if (!res.ok || !auth.ok) throw new Error(auth.error || 'Invalid selection.');
      const done = fbState.resolve;
      fbState.resolve = null;
      $('#fileBrowserDialog')?.close();
      done?.(auth);
    } catch (e) {
      api.toast(e.message, 'err');
    }
  }

  function openFileBrowserModal({
    mode = 'folder',
    title = 'Choose Folder',
    eyebrow = 'FILE EXPLORER',
    initialDir = '',
    defaultName = '',
    confirmText = 'Select',
    extensions = null,
  } = {}) {
    const dlg = $('#fileBrowserDialog');
    if (!dlg) return Promise.resolve({ cancelled: true });
    if (fbState.resolve) {
      const prev = fbState.resolve;
      fbState.resolve = null;
      prev({ cancelled: true });
    }
    fbState.mode = mode;
    fbState.extensions = extensions;
    fbState.selectedPath = '';
    fbState.selectedType = '';
    if ($('#fbEyebrow')) $('#fbEyebrow').textContent = eyebrow;
    if ($('#fbTitle')) $('#fbTitle').textContent = title;
    if ($('#fbConfirmBtn')) $('#fbConfirmBtn').textContent = confirmText;
    if ($('#fbFileNameLabel')) {
      $('#fbFileNameLabel').textContent = mode === 'folder' ? 'Folder:' : mode === 'open-project' ? 'Project (.qpf/.qsf):' : 'File name:';
    }
    if ($('#fbFileNameInput')) $('#fbFileNameInput').value = defaultName || '';
    if ($('#fbFilterInput')) $('#fbFilterInput').value = '';
    $('#fbMkdirForm')?.classList.add('hidden');
    return new Promise(resolve => {
      fbState.resolve = resolve;
      if (!dlg.open) dlg.showModal();
      fbNavigate(initialDir || S.projectDir || '');
    });
  }

  // ---------- multi-tab xterm.js + ConPTY integrated terminal in tools dock ----------
  const termSessionsList = [];
  let activeTermId = null;
  let availableShells = [];
  let defaultShellId = 'pwsh';
  let termInfoLoaded = false;
  let termResizeObs = null;

  const XTERM_THEME = {
    background: '#121611',
    foreground: '#e4eadc',
    cursor: '#e4eadc',
    cursorAccent: '#121611',
    selectionBackground: '#b7d98c44',
    black: '#141813',
    red: '#f0655b',
    green: '#b7d98c',
    yellow: '#f0e68c',
    blue: '#78c6d9',
    magenta: '#d1a6f0',
    cyan: '#78c6d9',
    white: '#e4eadc',
    brightBlack: '#6e7865',
    brightRed: '#f5897f',
    brightGreen: '#d4ed80',
    brightYellow: '#fff2a1',
    brightBlue: '#98dcf0',
    brightMagenta: '#e2bffa',
    brightCyan: '#98dcf0',
    brightWhite: '#ffffff',
  };

  const emojiPresRe = /\p{Emoji_Presentation}/u;
  const emojiWidthCache = new Map();

  function registerUnicode11Provider(xterm) {
    if (!xterm?.unicode) return;
    const v6 = xterm._core?.unicodeService?._providers?.['6'] || null;
    const wcwidth = cp => {
      if (cp < 32) return 0;
      if (cp < 127) return 1;
      if (cp === 0x200D || (cp >= 0xFE00 && cp <= 0xFE0F) ||
          (cp >= 0x1F3FB && cp <= 0x1F3FF) || (cp >= 0xE0100 && cp <= 0xE01EF)) {
        return 0;
      }
      const base = v6 ? v6.wcwidth(cp) : (cp >= 0x1100 ? 1 : 1);
      if (base === 0 || base === 2) return base;
      if (cp >= 0x1F1E6 && cp <= 0x1F1FF) return 2;
      if (cp >= 0x2300) {
        let cached = emojiWidthCache.get(cp);
        if (cached === undefined) {
          cached = emojiPresRe.test(String.fromCodePoint(cp)) ? 2 : base;
          emojiWidthCache.set(cp, cached);
        }
        return cached;
      }
      return base;
    };
    const charProperties = (cp, preceding) => {
      let w = wcwidth(cp);
      let shouldJoin = w === 0 && preceding !== 0;
      if (shouldJoin) {
        const prevW = (preceding >> 1) & 3;
        if (prevW === 0) {
          shouldJoin = false;
        } else if (cp === 0xFE0F && prevW === 1) {
          w = 2;
        } else if (prevW > w) {
          w = prevW;
        }
      }
      return ((w & 3) << 1) | (shouldJoin ? 1 : 0);
    };
    try {
      xterm.unicode.register({ version: '11', wcwidth, charProperties });
      xterm.unicode.activeVersion = '11';
    } catch {}
  }

  function activeTerm() {
    return termSessionsList.find(t => t.id === activeTermId) || termSessionsList[0] || null;
  }

  function computeTermColsRows(xtermInstance = null) {
    const screen = $('#termScreen');
    const rect = screen?.getBoundingClientRect();
    const cs = screen ? getComputedStyle(screen) : null;
    const padX = cs ? (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) : 20;
    const padY = cs ? (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) : 12;
    const w = Math.max(240, (rect?.width || 800) - padX - 12);
    const h = Math.max(80, (rect?.height || 220) - padY);
    const cell = xtermInstance?._core?._renderService?.dimensions?.css?.cell;
    const cellW = (cell?.width && cell.width > 3) ? cell.width : 7.22;
    const cellH = (cell?.height && cell.height > 6) ? cell.height : 16.8;
    const cols = Math.max(40, Math.min(400, Math.floor(w / cellW)));
    const rows = Math.max(5, Math.min(160, Math.floor(h / cellH)));
    return { cols, rows };
  }

  function fitActiveXterm() {
    const term = activeTerm();
    if (!term || !term.xterm) return;
    const screen = $('#termScreen');
    if (!screen || screen.offsetParent === null) return;
    const { cols, rows } = computeTermColsRows(term.xterm);
    if (term.xterm.cols !== cols || term.xterm.rows !== rows) {
      try { term.xterm.resize(cols, rows); } catch {}
      fetch('/api/terminal/resize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: term.id, cols, rows }),
      }).catch(() => {});
    }
  }

  function renderTerminalTabs() {
    const host = $('#termTabs');
    if (!host) return;
    host.replaceChildren();
    const counts = new Map();
    for (const t of termSessionsList) {
      const num = (counts.get(t.label) || 0) + 1;
      counts.set(t.label, num);
      const tab = document.createElement('div');
      tab.className = `term-tab${t.id === activeTermId ? ' active' : ''}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(t.id === activeTermId));
      tab.onclick = () => activateTerminalTab(t.id);
      const ico = document.createElement('span');
      ico.className = 'term-tab-ico';
      ico.textContent = '>_';
      const title = document.createElement('span');
      title.textContent = num > 1 ? `${t.label} (${num})` : t.label;
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'term-tab-x';
      closeBtn.textContent = '×';
      closeBtn.title = `Close ${t.label}`;
      closeBtn.onclick = e => {
        e.stopPropagation();
        closeTerminalTab(t.id);
      };
      tab.append(ico, title, closeBtn);
      host.append(tab);
    }
    const cur = activeTerm();
    if ($('#termCwdBadge')) {
      $('#termCwdBadge').textContent = cur?.cwd || '';
      $('#termCwdBadge').title = cur?.cwd || '';
    }
  }

  async function ensureShellInfo() {
    if (termInfoLoaded) return;
    termInfoLoaded = true;
    try {
      const res = await fetch('/api/terminal/info');
      const data = await res.json();
      if (res.ok && data.ok && Array.isArray(data.shells) && data.shells.length) {
        availableShells = data.shells;
        defaultShellId = data.defaultShell || data.shells[0].id;
        const sel = $('#termShellSelect');
        if (sel) {
          sel.replaceChildren(...availableShells.map(s => new Option(s.label, s.id)));
          sel.value = defaultShellId;
        }
      }
    } catch {}
  }

  function sendTermWrite(term, dataStr) {
    if (!term || !dataStr) return;
    term.writeBuf += dataStr;
    if (term.writePending) return;
    term.writePending = true;
    queueMicrotask(async () => {
      while (term.writeBuf.length > 0) {
        const chunk = term.writeBuf;
        term.writeBuf = '';
        try {
          await fetch('/api/terminal/write', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: term.id, data: chunk }),
          });
        } catch {}
      }
      term.writePending = false;
    });
  }

  async function createTerminalTab(requestedShell = '') {
    await ensureShellInfo();
    const shell = requestedShell || $('#termShellSelect')?.value || defaultShellId || 'pwsh';
    const initialCwd = S.projectDir || '';
    const { cols, rows } = computeTermColsRows();
    try {
      const res = await fetch('/api/terminal/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shell, cwd: initialCwd, cols, rows }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not start terminal session.');

      const hostDiv = document.createElement('div');
      hostDiv.className = 'term-xterm-host';
      $('#termScreen')?.append(hostDiv);

      const xterm = new Terminal({
        cols,
        rows,
        cursorBlink: true,
        cursorStyle: 'block',
        fontFamily: '"Cascadia Mono", Consolas, "Segoe UI Emoji", monospace',
        fontSize: 12,
        lineHeight: 1.2,
        scrollback: 5000,
        convertEol: false,
        allowProposedApi: true,
        rescaleOverlappingGlyphs: true,
        ...(data.pty ? { windowsPty: { backend: 'conpty', buildNumber: 26200 } } : {}),
        theme: XTERM_THEME,
      });
      registerUnicode11Provider(xterm);

      const term = {
        id: data.id,
        shell: data.shell,
        label: data.label,
        banner: data.banner,
        cwd: data.cwd,
        hostDiv,
        xterm,
        es: null,
        writeBuf: '',
        writePending: false,
      };

      xterm.open(hostDiv);
      requestAnimationFrame(() => fitActiveXterm());
      xterm.attachCustomKeyEventHandler(ev => {
        if (ev.type !== 'keydown') return true;
        const mod = ev.ctrlKey || ev.metaKey;
        if (mod && !ev.altKey && !ev.shiftKey && ev.key === '`') {
          ev.preventDefault();
          toggleTerminalPane();
          return false;
        }
        if (mod && !ev.altKey && ev.key.toLowerCase() === 'c' && xterm.hasSelection()) {
          ev.preventDefault();
          navigator.clipboard?.writeText(xterm.getSelection()).catch(() => {});
          xterm.clearSelection();
          return false;
        }
        if (mod && !ev.altKey && ev.key.toLowerCase() === 'v') {
          ev.preventDefault();
          navigator.clipboard?.readText().then(txt => { if (txt) sendTermWrite(term, txt); }).catch(() => {});
          return false;
        }
        return true;
      });

      xterm.onData(inputData => {
        sendTermWrite(term, inputData);
      });

      const es = new EventSource(`/api/terminal/stream?id=${encodeURIComponent(term.id)}`);
      term.es = es;
      es.onmessage = event => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'data' && msg.data) {
            xterm.write(msg.data);
          } else if (msg.type === 'exit') {
            xterm.write(`\r\n\x1b[90m[Process exited with code ${msg.code ?? 0}]\x1b[0m\r\n`);
          }
        } catch {}
      };

      termSessionsList.push(term);
      activateTerminalTab(term.id);
      return term;
    } catch (e) {
      api.toast(e.message, 'err');
      return null;
    }
  }

  function activateTerminalTab(id) {
    const target = termSessionsList.find(t => t.id === id);
    if (!target) return;
    activeTermId = id;
    for (const t of termSessionsList) {
      t.hostDiv.classList.toggle('hidden', t.id !== id);
    }
    renderTerminalTabs();
    requestAnimationFrame(() => {
      fitActiveXterm();
      target.xterm?.focus();
    });
  }

  async function closeTerminalTab(id) {
    const idx = termSessionsList.findIndex(t => t.id === id);
    if (idx < 0) return;
    const [removed] = termSessionsList.splice(idx, 1);
    try { removed.es?.close(); } catch {}
    try { removed.xterm?.dispose(); } catch {}
    try { removed.hostDiv?.remove(); } catch {}
    fetch('/api/terminal/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).catch(() => {});
    if (!termSessionsList.length) {
      await createTerminalTab();
      return;
    }
    if (activeTermId === id) {
      activateTerminalTab(termSessionsList[Math.max(0, idx - 1)].id);
    } else {
      renderTerminalTabs();
    }
  }

  function updateTermCwd(nextCwd) {
    if (!nextCwd) return;
    const term = activeTerm();
    if (!term) return;
    term.cwd = nextCwd;
    if ($('#termCwdBadge')) {
      $('#termCwdBadge').textContent = nextCwd;
      $('#termCwdBadge').title = nextCwd;
    }
  }

  async function ensureTerminalInitialized() {
    if (!termResizeObs && typeof ResizeObserver !== 'undefined' && $('#termScreen')) {
      termResizeObs = new ResizeObserver(() => fitActiveXterm());
      termResizeObs.observe($('#termScreen'));
    }
    if (!termSessionsList.length) {
      await createTerminalTab();
    } else {
      activateTerminalTab(activeTermId || termSessionsList[0].id);
    }
  }

  function toggleTerminalPane() {
    const isTermOpen = !$('#right')?.classList.contains('hidden') && $('#rtab-terminal')?.classList.contains('active');
    if (isTermOpen) {
      $('#closeRight')?.click();
    } else {
      api.openTools('terminal');
      ensureTerminalInitialized();
    }
  }

  // ---------- menus ----------
  const commands = {
    home: () => requestReturnHome(),
    newProject: () => requestProjectSwitch({ label: 'a new project', newWindowUrl: '/?newProject=1', onSwitchHere: () => openNewProjectWizard() }),
    newFile: () => showNewFile(),
    newFolder: () => showNewFolder(),
    openProject: () => api.openProjectFromDiskPath?.('', { promptIfInWorkbench: true }),
    openFiles: () => $('#fileInput').click(),
    saveFile: () => saveActiveFile(),
    saveFileAs: () => saveActiveFileAs(),
    save: saveAndCompile,
    saveProject: () => api.saveProjectToDisk?.({ saveAs: false }),
    saveProjectAs: () => api.saveProjectToDisk?.({ saveAs: true }),
    exportJson: () => { api.saveProject?.(); api.download?.(JSON.stringify(api.projectData(), null, 2), 'trace-project.json', 'application/json'); api.toast('Exported project JSON backup.'); },
    loadDemo: () => requestProjectSwitch({ label: 'Counter Demo', newWindowUrl: '/?demo=1', onSwitchHere: () => { $('#btnDemo').click(); captureBaseline('Counter demo'); } }),
    closeTab: () => active && closeTab(active),
    undo: () => { docs.get(active)?.editor.focus(); document.execCommand('undo'); },
    redo: () => { docs.get(active)?.editor.focus(); document.execCommand('redo'); },
    comment: () => docs.get(active)?.editor.toggleComment(),
    dupLine: () => docs.get(active)?.editor.duplicateLines?.(1),
    delLine: () => docs.get(active)?.editor.deleteLines?.(),
    wordWrap: () => toggleWordWrap(),
    viewExplorer: () => $('#btnLibrary').click(),
    viewPins: () => $('#btnPins').click(),
    panelWaves: () => api.openBottomTab?.('waves'),
    panelTerminal: () => toggleTerminalPane(),
    panelProblems: () => api.openTools('problems'),
    panelConsole: () => api.openTools('console'),
    panelPinout: () => api.openTools('pinout'),
    panelTruth: () => api.openTools('truth'),
    panelUart: () => api.openTools('uart'),
    panelBitstream: () => api.openTools('programmer'),
    toggleEditor: () => setEditorPaneOpen(!$('#sourceDialog')?.open),
    toggleBoard: () => setBoardPaneOpen(!boardPaneOpen),
    focusBoard: () => setEditorPaneOpen(!$('#sourceDialog')?.open),
    photo: () => $('#btnPhotoMode').click(),
    fullscreen: () => toggleAppFullscreen(),
    theme: () => $('#btnTheme').click(),
    resetLayout,
    exit: () => requestAppClose(),
    flash: () => api.flashToBoard?.(),
    projectSettings: () => $('#projectSettingsDialog')?.showModal(),
    restart: () => $('#btnReset').click(),
    step: () => $('#btnStep').click(),
    run: () => $('#btnRun').click(),
    tutorial: () => openTutorial(),
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
      closeExplorerMenu();
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
    document.addEventListener('click', event => {
      if (!event.target.closest('.menu')) closeMenus();
      if (!event.target.closest('#explorerMenu')) closeExplorerMenu();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') { closeMenus(); closeExplorerMenu(); }
      if (event.key === 'F2' && selectedNode && document.activeElement?.closest('#ltab-library') && !document.activeElement?.closest('input,textarea')) {
        event.preventDefault();
        renameNode(selectedNode);
      }
    });
    window.addEventListener('blur', () => { closeMenus(); closeExplorerMenu(); });
  }

  // ---------- wiring ----------
  function wire() {
    applyLayout();
    syncFallbackId();
    wireSplitters(); wireMenus();
    $('#btnFocusBoard')?.addEventListener('click', () => setEditorPaneOpen(!$('#sourceDialog')?.open));
    $('#btnToggleBoard')?.addEventListener('click', () => setBoardPaneOpen(!boardPaneOpen));
    $('#closeBoardPane')?.addEventListener('click', () => setBoardPaneOpen(false));
    $$('[data-wb-open]').forEach(btn => btn.addEventListener('click', () => {
      const target = btn.dataset.wbOpen;
      if (target === 'editor') setEditorPaneOpen(true);
      else if (target === 'board') setBoardPaneOpen(true);
      else if (target === 'signals') commands.panelWaves();
      else if (target === 'tools') api.openTools();
    }));
    $('#wbResetLayout')?.addEventListener('click', resetLayout);
    $('#btnProjectSettings')?.addEventListener('click', () => $('#projectSettingsDialog')?.showModal());
    $('#sbLang')?.addEventListener('click', () => $('#projectSettingsDialog')?.showModal());
    $('#btnOpenFirst')?.addEventListener('click', () => { if (S.sources.length) openFile(S.sources[0].name); else showNewFile(); });
    $('#btnNewFile')?.addEventListener('click', () => showNewFile());
    $('#btnNewFileExplorer')?.addEventListener('click', () => showNewFile());
    $('#btnNewFolderExplorer')?.addEventListener('click', () => showNewFolder());
    $('#btnRefreshExplorer')?.addEventListener('click', () => refreshProjectTree());
    $('#projectRootSummary')?.addEventListener('contextmenu', e => openExplorerMenu(e, { type: 'root', rel: '', name: '' }));
    $('#projectTreeBody')?.addEventListener('contextmenu', e => {
      if (!e.target.closest('.tree-row')) openExplorerMenu(e, { type: 'root', rel: '', name: '' });
    });
    $('#projectTreeBody')?.addEventListener('click', e => {
      if (!e.target.closest('.tree-row') && !e.target.closest('#newFileRow')) {
        selectedNode = null;
        renderProjectTree();
      }
    });
    if ($('#eaForm')) {
      $('#eaForm').onsubmit = e => {
        e.preventDefault();
        const resolve = eaResolve;
        eaResolve = null;
        const inputEl = $('#eaInput');
        const val = inputEl && !inputEl.classList.contains('hidden') ? inputEl.value : true;
        $('#explorerActionDialog')?.close();
        resolve?.(val);
      };
    }
    $('#explorerActionDialog')?.addEventListener('close', () => {
      const resolve = eaResolve;
      eaResolve = null;
      resolve?.(null);
    });
    if ($('#newFileRow')) {
      $('#newFileRow').onsubmit = event => { event.preventDefault(); submitNewEntry($('#newFileName').value); };
      $('#newFileName').onkeydown = event => { if (event.key === 'Escape') { event.stopPropagation(); $('#newFileRow').classList.add('hidden'); } };
      $('#newFileName').onblur = () => { if (!$('#newFileName').value.trim()) $('#newFileRow').classList.add('hidden'); };
    }
    if ($('#saveFileBtn')) $('#saveFileBtn').onclick = () => saveActiveFile();
    $('#saveSource').onclick = saveAndCompile;
    if ($('#btnFlash')) $('#btnFlash').onclick = () => api.flashToBoard?.();
    $('#btnWordWrap')?.addEventListener('click', () => toggleWordWrap());
    syncWordWrapUI();
    $$('#mdModeSwitch [data-md-mode]').forEach(btn => {
      btn.addEventListener('click', () => setMarkdownMode(btn.dataset.mdMode));
    });
    // Native GUI File Explorer Modal wiring
    $('#fbUpBtn')?.addEventListener('click', () => { if (fbState.parentDir) fbNavigate(fbState.parentDir); });
    $('#fbRefreshBtn')?.addEventListener('click', () => fbNavigate(fbState.curDir));
    $('#fbPathForm')?.addEventListener('submit', e => {
      e.preventDefault();
      const val = ($('#fbPathInput')?.value || '').trim();
      if (val) fbNavigate(val);
    });
    $('#fbFilterInput')?.addEventListener('input', () => renderFileBrowser());
    $('#fbNewFolderBtn')?.addEventListener('click', () => {
      $('#fbMkdirForm')?.classList.toggle('hidden');
      if (!$('#fbMkdirForm')?.classList.contains('hidden')) {
        if ($('#fbMkdirInput')) $('#fbMkdirInput').value = '';
        $('#fbMkdirInput')?.focus();
      }
    });
    $('#fbMkdirCancel')?.addEventListener('click', () => $('#fbMkdirForm')?.classList.add('hidden'));
    $('#fbMkdirForm')?.addEventListener('submit', async e => {
      e.preventDefault();
      const name = ($('#fbMkdirInput')?.value || '').trim();
      if (!name) return;
      try {
        const res = await fetch('/api/fs/mkdir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dir: fbState.curDir, name }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Could not create folder.');
        $('#fbMkdirForm')?.classList.add('hidden');
        await fbNavigate(data.dir);
        api.toast(`Created folder "${data.name}".`, 'ok');
      } catch (err) {
        api.toast(err.message, 'err');
      }
    });
    $('#fbConfirmBtn')?.addEventListener('click', () => confirmFileBrowserSelection());
    $('#fbFileNameInput')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); confirmFileBrowserSelection(); }
    });
    $('#fileBrowserDialog')?.addEventListener('close', () => {
      if (fbState.resolve) {
        const done = fbState.resolve;
        fbState.resolve = null;
        done({ cancelled: true });
      }
    });
    // Multi-Tab xterm.js + ConPTY Integrated Terminal wiring
    ensureShellInfo();
    $('#termScreen')?.addEventListener('mousedown', () => {
      requestAnimationFrame(() => activeTerm()?.xterm?.focus());
    });
    $('#termNewTabBtn')?.addEventListener('click', () => createTerminalTab());
    $('#termClearBtn')?.addEventListener('click', () => {
      const term = activeTerm();
      if (!term) return;
      term.xterm?.clear();
      sendTermWrite(term, term.shell === 'cmd' ? 'cls\r' : 'cls\r');
      term.xterm?.focus();
    });
    $('#termCopyBtn')?.addEventListener('click', async () => {
      const term = activeTerm();
      if (!term?.xterm) return;
      const sel = term.xterm.getSelection();
      if (sel) {
        try { await navigator.clipboard.writeText(sel); api.toast('Copied terminal selection.'); } catch {}
      } else {
        term.xterm.selectAll();
        const all = term.xterm.getSelection();
        term.xterm.clearSelection();
        try { await navigator.clipboard.writeText(all); api.toast('Copied terminal buffer.'); } catch {}
      }
      term.xterm.focus();
    });
    $('#termKillBtn')?.addEventListener('click', () => {
      const term = activeTerm();
      if (!term) return;
      sendTermWrite(term, '\x03');
      term.xterm?.focus();
    });
    $('#termCdProject')?.addEventListener('click', () => {
      const term = activeTerm();
      if (!term) return;
      if (S.projectDir) {
        updateTermCwd(S.projectDir);
        const cmd = term.shell === 'cmd' ? `cd /d "${S.projectDir}"\r` : `Set-Location -LiteralPath "${S.projectDir}"\r`;
        sendTermWrite(term, cmd);
        term.xterm?.focus();
      } else {
        api.toast('Save or open a project folder on disk first.');
      }
    });
    $('#sourceLibrary').oninput = event => {
      const doc = docs.get(active);
      if (doc) {
        doc.library = event.target.value.trim();
        if (!doc.diskOnly && !S.dirty) api.markDirty();
        renderTabs();
      }
    };
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
    $('#exitWbSave')?.addEventListener('click', () => confirmSaveAndExit());
    $('#exitWbDiscard')?.addEventListener('click', () => confirmDiscardAndExit());
    $('#exitWbCancel')?.addEventListener('click', () => $('#exitWorkbenchDialog')?.close());
    $('#exitHomeYes')?.addEventListener('click', () => confirmHomeExit());
    $('#exitHomeNo')?.addEventListener('click', () => $('#exitHomeDialog')?.close());
    $('#psNewWindow')?.addEventListener('click', () => {
      const sw = pendingSwitch;
      pendingSwitch = null;
      $('#projectSwitchDialog')?.close();
      if (sw?.newWindowUrl) window.open(sw.newWindowUrl, '_blank');
    });
    $('#psSave')?.addEventListener('click', async () => {
      const sw = pendingSwitch;
      if (!sw) return;
      if (sw.hasChanges) {
        if (!validateLibraries()) return;
        commitAll();
        api.renderSources();
        if (api.saveProjectToDisk) {
          const ok = await api.saveProjectToDisk({ saveAs: !S.projectDir });
          if (!ok) return;
        } else {
          api.saveProject?.();
          recordRecentProject(projectTitle);
          captureBaseline(projectTitle);
        }
      }
      pendingSwitch = null;
      $('#projectSwitchDialog')?.close();
      await api.stopAllSimulations?.();
      await sw.onSwitchHere?.();
    });
    $('#psDiscard')?.addEventListener('click', async () => {
      const sw = pendingSwitch;
      pendingSwitch = null;
      $('#projectSwitchDialog')?.close();
      await api.stopAllSimulations?.();
      await sw?.onSwitchHere?.();
    });
    $('#psCancel')?.addEventListener('click', () => { pendingSwitch = null; });
    $('#homeThemeBtn')?.addEventListener('click', () => $('#btnTheme')?.click());
    $('#homeAboutBtn')?.addEventListener('click', () => $('#btnAbout')?.click());
    $('#homeTutorialBtn')?.addEventListener('click', () => openTutorial());
    $('#homeShortcutsBtn')?.addEventListener('click', () => $('#keysDialog')?.showModal());
    $('#homeOpenProjectBtn')?.addEventListener('click', () => api.openProjectFromDiskPath?.());
    $('#homeOpenBtn')?.addEventListener('click', () => $('#fileInput')?.click());
    $('#homeDemoBtn')?.addEventListener('click', () => {
      const prevRecents = loadRecents();
      let prevStorage = null;
      try { prevStorage = localStorage.getItem('trace.project.v1'); } catch {}
      showHome(false);
      $('#btnDemo')?.click();
      captureBaseline('Counter demo', { prevRecents, prevStorage });
    });
    $('#homeNewProjectBtn')?.addEventListener('click', () => openNewProjectWizard());
    $('#homeClearRecents')?.addEventListener('click', () => { saveRecents([]); renderHome(); });
    $('#npEntity')?.addEventListener('input', () => {
      entityTouched = true;
      syncWizardPreview();
    });
    $('#npName')?.addEventListener('input', () => {
      const slug = $('#npName').value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'fpga_lab';
      const ent = /^[a-z]/i.test(slug) ? slug : 'p_' + slug;
      if (!entityTouched && $('#npEntity')) $('#npEntity').value = ent;
      syncWizardPreview();
    });
    $('#npExtraFiles')?.addEventListener('input', syncWizardPreview);
    $('#homeWizardForm')?.addEventListener('submit', e => {
      e.preventDefault();
      launchTemplateProject({
        name: $('#npName').value.trim() || 'fpga_lab',
        entity: $('#npEntity').value.trim() || 'fpga_lab',
        standard: $('#npStandard').value || '08',
        templateKind: $('#npTemplate').value || 'blank',
        extraFiles: $('#npExtraFiles')?.value || '',
      });
    });
    $$('[data-starter]').forEach(btn => btn.addEventListener('click', () => {
      const kind = btn.dataset.starter;
      const names = {
        counter: ['Counter & 7-Seg Demo', DEMO_TOP, '93'],
        board_io: ['Board I/O Starter', 'board_top', '08'],
        keys_leds: ['Keys & LEDs Logic', 'keys_leds', '08'],
        buzzer: ['Piezo Buzzer Synth', 'buzzer_top', '08'],
        uart_tx: ['UART Transmitter', 'uart_hello', '08'],
        blank: ['FPGA Lab Starter', 'fpga_lab', '08'],
      };
      const [title, ent, std] = names[kind] || ['FPGA Starter', 'fpga_lab', '08'];
      launchTemplateProject({ name: title, entity: ent, standard: std, templateKind: kind });
    }));
    $('#homeHdlSearch')?.addEventListener('input', e => {
      const q = e.target.value.toLowerCase();
      $$('#homeHdlList .home-hdl-group').forEach(grp => {
        let anyVis = false;
        grp.querySelectorAll('.home-hdl-item').forEach(item => {
          const match = !q || item.dataset.search.includes(q);
          item.hidden = !match;
          if (match) anyVis = true;
        });
        grp.hidden = !anyVis;
      });
    });
    renderProblems(); updateStatus(); syncEditorVisibility(); syncBoardVisibility();
  }
  wire();

  function closeDiskTabs() {
    for (const [name, doc] of [...docs.entries()]) {
      if (doc.diskOnly) closeTab(name, true);
    }
  }
  return {
    openFile, openDiskFile, closeTab, closeDiskTabs, activate, commitAll, hasUnsaved, validateLibraries, saveActiveFile, saveActiveFileAs, saveAndCompile, saveAndFlash, syncFromSources, openFirst, updateStatus,
    refreshProjectTree, renderProjectTree, showNewFile, showNewFolder, closeExplorerMenu,
    setProblems, reportBuildFailure, resetLayout, setEditorPaneOpen, setBoardPaneOpen,
    showHome, requestReturnHome, requestProjectSwitch, requestAppClose, toggleAppFullscreen, setSkipHomeExitConfirm, openNewProjectWizard, resumeWorkbench, captureBaseline, currentProjectTitle, renderHome, recordRecentProject, populateHomeHdl,
    openFileBrowserModal, toggleWordWrap, setMarkdownMode, openTutorial, cycleTab, toggleTerminalPane, ensureTerminalInitialized, updateTermCwd,
    get hasActiveSession() { return hasActiveSession; },
    get active() { return active; },
    get tabs() { return [...tabs]; },
    get problems() { return problems; },
    get editor() { return docs.get(active)?.editor || null; },
    get boardOpen() { return boardPaneOpen; },
    isDirty,
  };
}
