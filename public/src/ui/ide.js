// IDE shell controller: resizable panes, multi-tab VHDL code editor, problems diagnostics, menus and status bar.
import { CodeEditor } from './editor.js';
import { DEMO_SRC, DEMO_TOP } from './demo.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const LAYOUT_KEY = 'trace.layout.v1';
const RECENTS_KEY = 'trace.recents.v1';
const DEFAULT_LAYOUT = { leftW: 256, editorFrac: 42, panelH: 245 };
const NAME_PATTERN = /^(?:[a-z0-9_][a-z0-9_. -]*\/)*[a-z0-9_][a-z0-9_. -]*\.(vhd|vhdl|vho|cf|hex|mif|mem|txt|dat)$/i;
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
  try { layout = { ...DEFAULT_LAYOUT, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') }; } catch {}
  const saveLayout = () => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch {} };
  const find = name => S.sources.find(source => source.name === name) || S.sources.find(source => source.name.toLowerCase() === String(name || '').toLowerCase());
  const findByDiagFile = file => find(file) || S.sources.find(source => baseNameOf(source.name).toLowerCase() === baseNameOf(file).toLowerCase());
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
      const maxPanelH = Math.max(130, Math.floor(rect.height - computeMinTopHeight()));
      layout.panelH = clamp(Math.round(rect.bottom - event.clientY), 130, maxPanelH); applyLayout();
    });
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
    $$('#srcList .tree-row[data-type="file"]').forEach(item => {
      const rel = item.dataset.rel;
      item.classList.toggle('active', rel === active);
      item.classList.toggle('dirty', isDirty(rel));
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
    const isVhdl = !doc.diskOnly && /\.(vhd|vhdl|vho)$/i.test(name);
    if ($('#editorKind')) $('#editorKind').textContent = fileKindLabel(name);
    if ($('#sourceLibraryWrap')) $('#sourceLibraryWrap').classList.toggle('hidden', !isVhdl);
    if ($('#sourceLibrary')) $('#sourceLibrary').value = doc.library || 'work';
    if ($('#sourceName')) $('#sourceName').textContent = name;
    if ($('#editorCrumb')) $('#editorCrumb').textContent = name;
    $('#editorBar')?.classList.remove('hidden');
    $('#editorEmpty')?.classList.add('hidden');
    cursor = doc.editor.cursor();
    renderTabs(); updateStatus();
  }
  function mountDocTab(name, text, { library = 'work', diskOnly = false, line = 0, col = 1, focus = true } = {}) {
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
    let sourceChanged = false;
    if (!doc.diskOnly) {
      const source = find(name);
      if (source) {
        sourceChanged = source.text !== text || libraryOf(source) !== doc.library;
        source.text = text;
        source.library = doc.library;
      }
    }
    if (!S.projectDir) {
      const savedAs = await saveActiveFileAs(name);
      if (savedAs && sourceChanged) { api.saveProject?.(); api.markDirty?.(); }
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
      doc.saved = text;
      if (sourceChanged) { api.saveProject?.(); api.markDirty?.(); }
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
      const pickRes = await fetch('/api/project/pick-save-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initialDir: S.projectDir || '', defaultName: baseNameOf(name) }),
      });
      const picked = await pickRes.json();
      if (!pickRes.ok) throw new Error(picked.error || 'Save dialog failed.');
      if (picked.cancelled || !picked.filePath) return false;
      const writeRes = await fetch('/api/project/write-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: picked.filePath, text }),
      });
      const written = await writeRes.json();
      if (!writeRes.ok) throw new Error(written.error || 'Could not write file.');
      if (doc) {
        doc.saved = text;
        if (!doc.diskOnly && find(name)) { find(name).text = text; find(name).library = doc.library; }
      }
      renderTabs();
      refreshProjectTree();
      const shortName = written.filePath.split(/[\\/]/).filter(Boolean).pop() || baseNameOf(name);
      api.toast(`Saved ${shortName} to ${written.filePath}.`, 'ok');
      api.logEvent?.('info', `Saved file as: ${written.filePath}`);
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
  function detectProjectChanges() {
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
          for (const name of [...docs.keys()]) closeTab(name, true);
          api.restoreProject(item.project);
          openFirst();
          captureBaseline(item.title, { prevRecents, prevStorage });
          showHome(false);
          api.markDirty();
          api.toast(`Opened ${item.title}. Click Build & Compile when ready.`);
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
    const hasChanges = changes.length > 0 || !S.projectDir;
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
  function openNewProjectWizard() {
    const dlg = $('#newProjectDialog');
    if (!dlg) return;
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
    const dlg = $('#homeConfirmDialog');
    if (!dlg) {
      api.stopAllSimulations?.();
      showHome(true);
      if (focusWizard) openNewProjectWizard();
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
    showHome(true);
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
    } catch {}
    saveRecents(baselineRecents);
    setProblems([]);
    $('#homeConfirmDialog')?.close();
    await api.stopAllSimulations?.();
    showHome(true);
    if (pendingFocusWizard) {
      pendingFocusWizard = false;
      openNewProjectWizard();
    }
    api.toast('Discarded recent changes. All simulations stopped.');
    api.logEvent?.('info', `Returned to Home: discarded changes to ${discardedTitle} and stopped all simulations`);
  }
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
            if (file.kind === 'qpf' && api.openProjectFromDiskPath) {
              await api.openProjectFromDiskPath(file.rel);
              return;
            }
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
    viewExplorer: () => $('#btnLibrary').click(),
    viewPins: () => $('#btnPins').click(),
    panelWaves: () => api.openBottomTab?.('waves'),
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
    theme: () => $('#btnTheme').click(),
    resetLayout,
    flash: () => api.flashToBoard?.(),
    projectSettings: () => $('#projectSettingsDialog')?.showModal(),
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
    let entityTouched = false;
    const syncWizardPreview = () => {
      const ent = ($('#npEntity')?.value || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_') || 'fpga_lab';
      const extras = ($('#npExtraFiles')?.value || '').split(',').map(s => s.trim()).filter(Boolean).map(s => /\.[a-z0-9]+$/i.test(s) ? s : `${s}.vhd`);
      if ($('#npFilePreview')) $('#npFilePreview').textContent = [`${ent}.vhd`, ...extras].join(', ');
    };
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
      const names = { counter: ['Counter & 7-Seg Demo', DEMO_TOP, '93'], board_io: ['Board I/O Starter', 'board_top', '08'], keys_leds: ['Keys & LEDs Logic', 'keys_leds', '08'], uart_tx: ['UART Transmitter', 'uart_hello', '08'] };
      const [title, ent, std] = names[kind] || ['FPGA Starter', 'fpga_lab', '08'];
      launchTemplateProject({ name: title, entity: ent, standard: std, templateKind: kind });
    }));
    $('#homeHdlSearch')?.addEventListener('input', e => {
      const q = e.target.value.toLowerCase();
      $$('#homeHdlList .home-hdl-item').forEach(item => { item.hidden = !item.dataset.search.includes(q); });
    });
    renderProblems(); updateStatus(); syncEditorVisibility(); syncBoardVisibility();
  }
  wire();

  return {
    openFile, openDiskFile, closeTab, activate, commitAll, hasUnsaved, validateLibraries, saveActiveFile, saveActiveFileAs, saveAndCompile, saveAndFlash, syncFromSources, openFirst, updateStatus,
    refreshProjectTree, renderProjectTree, showNewFile, showNewFolder, closeExplorerMenu,
    setProblems, reportBuildFailure, resetLayout, setEditorPaneOpen, setBoardPaneOpen,
    showHome, requestReturnHome, requestProjectSwitch, openNewProjectWizard, resumeWorkbench, captureBaseline, currentProjectTitle, renderHome, recordRecentProject, populateHomeHdl,
    get active() { return active; },
    get tabs() { return [...tabs]; },
    get problems() { return problems; },
    get editor() { return docs.get(active)?.editor || null; },
    get boardOpen() { return boardPaneOpen; },
    isDirty,
  };
}
