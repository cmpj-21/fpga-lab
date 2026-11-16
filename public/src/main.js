import { createBoard3D } from './board/board3d.js';
import { NET_PIN, LED_NETS, KEY_NETS, SEG_NETS, DIGIT_NETS } from './board/boardDef.js';
import { parseQsf } from './sim/qsf.js';
import { parseGenerics } from './sim/generics.js';
import { UartReceiver } from './sim/uart.js';
import { inspectBitstream } from './sim/sof.js';
import { parseVcd } from './sim/vcd.js';
import { fmtTime } from './sim/types.js';
import { WaveViewer } from './ui/waves.js';
import { DEMO_SRC, DEMO_NAME, DEMO_TOP } from './ui/demo.js';
import * as audio from './ui/audio.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const S = { sources: [], sim: null, running: false, power: true, building: false, busy: false, clkHz: 1000, speed: 55, time: 0, inputs: {}, assignments: new Map(), bindings: {}, values: new Map(), pending: [], generation: 0, cycles: 0, vcd: null, standard: '93', generics: {}, topLibrary: 'work', dirty: false, error: false, importing: false, truthBusy: false, exporting: false };
let board, waves, toastTimer, sourceIndex, consoleCount = 0, logFile = '', reportCount = 0;
let lastFrame = performance.now(), accumulator = 0, lastDraw = 0;
const uart = new UartReceiver();
const reported = new Map();

function toast(message, kind = '') { const el = $('#toast'); el.textContent = message; el.className = `toast ${kind}`; clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 4500); if (kind === 'err') report(message); }
function log(message, severity = 'info', stack = '') {
  const row = document.createElement('div'); row.className = `console-line ${severity}`; row.dataset.severity = severity; row.dataset.clock = new Date().toTimeString().slice(0, 8);
  const time = document.createElement('span'); time.className = 'ct'; time.textContent = fmtTime(S.time);
  const text = document.createElement('span'); text.textContent = message; row.append(time, text);
  $('#consoleOut').append(row); while ($('#consoleOut').children.length > 500) $('#consoleOut').firstChild.remove();
  $('#consoleCount').textContent = ++consoleCount; $('#consoleOut').scrollTop = $('#consoleOut').scrollHeight;
  if (severity === 'error') report(message, stack);
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
  setTimeout(() => { try { fetch('/api/log', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: key, stack: stack || '', details: sessionDetails(), recent: consoleLines().slice(-20) }) }).catch(() => {}); } catch {} });
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
  const name = S.building ? 'Compiling' : S.error ? 'Error' : !S.power ? 'Power off' : S.dirty ? 'Build needed' : S.sim?.ended ? 'Complete' : S.running ? 'Running' : S.sim ? 'Paused' : 'No design';
  $('#statusPill').className = `status-pill ${name.toLowerCase().replaceAll(' ', '-')}`; $('#statusPill').textContent = name;
  $('#btnRun').classList.toggle('running', S.running); $('#runLabel').textContent = S.running ? 'Pause' : 'Run';
  $('#btnRun').setAttribute('aria-label', S.running ? 'Pause simulation' : 'Run simulation');
  const locked = S.building || S.importing || S.exporting;
  for (const input of $$('#pinBody input, #sdfControls input, #sdfControls select, .src-name, .src-x')) input.disabled = locked;
  $('#btnRun').disabled = $('#btnStep').disabled = locked || !S.power || !S.sim || S.sim.ended || S.dirty || S.error;
  $('#btnElab').disabled = $('#btnReset').disabled = locked;
  $('#btnVcd').disabled = locked || !S.sim;
  for (const id of ['btnDemo', 'btnImport', 'dropZone', 'btnQsf', 'topSelect', 'standardSelect', 'topLibrary', 'genericInput', 'pwrToggle', 'btnPinReset', 'clearSdf', 'saveSource', 'progDrop', 'btnSaveProject', 'replayScope']) $('#' + id).disabled = locked;
  $('#btnTruth').disabled = locked || S.truthBusy || !S.sim || !!S.vcd || S.dirty || S.error;
  for (const input of $$('#virtualInputs input')) input.disabled = locked || S.dirty || S.error || !S.power || !S.sim || S.sim.ended || !!S.vcd;
  $('#clkHz').disabled = !!S.vcd;
  $('#btnStep').title = S.vcd ? 'Next recorded timestamp (.)' : 'One clock cycle (.)';
  $('#btnVcd').textContent = S.vcd || S.sim?.ended ? 'Export VCD ↗' : 'Finish & export ↗';
  syncKeys();
}
function pause() { S.running = false; accumulator = 0; audio.stopBuzzer(); setStatus(); }
function fail(e) { S.error = true; S.pending = []; pause(); log(e.message, 'error'); toast(e.message, 'err'); openTools('console'); }
function markDirty() { S.dirty = true; S.error = false; S.pending = []; ++S.generation; pause(); saveProject(); }
function projectData() { return { format: 'trace-project', version: 1, sources: S.sources, assignments: [...S.assignments], top: $('#topSelect').value, topLibrary: $('#topLibrary').value, standard: $('#standardSelect').value, generics: $('#genericInput').value, sdf: S.sdf ? { ...S.sdf, instance: $('#sdfInstance').value, corner: $('#sdfCorner').value } : null }; }
function saveProject() { try { localStorage.setItem('trace.project.v1', JSON.stringify(projectData())); } catch { toast('Browser storage is full or unavailable. Use Save project to keep your files.', 'err'); } }
function restoreProject(project) {
  if (!project || project.format !== 'trace-project' || project.version !== 1 || !Array.isArray(project.sources) || project.sources.length > 100 || !project.sources.every(s => s && typeof s.name === 'string' && typeof s.text === 'string' && /^[a-z0-9_][a-z0-9_. -]*\.(vhd|vhdl|vho|cf|hex|mif|mem|txt|dat)$/i.test(s.name) && (!s.library || /^[a-z][a-z0-9_]*$/i.test(s.library))) || !['93','02','08'].includes(project.standard) || !/^[a-z][a-z0-9_]*$/i.test(project.topLibrary || 'work') || typeof project.generics !== 'string' || !Array.isArray(project.assignments) || !project.assignments.every(p => Array.isArray(p) && p.length === 2 && Number.isInteger(p[0]) && p[0] >= 1 && p[0] <= 144 && typeof p[1] === 'string') || (project.sdf && (typeof project.sdf.text !== 'string' || typeof project.sdf.instance !== 'string' || !['min','typ','max'].includes(project.sdf.corner)))) throw new Error('Invalid Trace project file.');
  S.sources = project.sources; S.assignments = new Map(project.assignments); S.sdf = project.sdf || null;
  $('#standardSelect').value = project.standard; $('#genericInput').value = project.generics; $('#topLibrary').value = project.topLibrary || 'work';
  renderSources(); $('#topSelect').value = project.top || ''; renderSdf();
}
function download(text, name, type = 'text/plain') { const url = URL.createObjectURL(new Blob([text], { type })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function renderSdf() { $('#sdfControls').classList.toggle('hidden', !S.sdf); $('#sdfName').textContent = S.sdf?.name || 'Timing annotation'; $('#sdfInstance').value = S.sdf?.instance || ''; $('#sdfCorner').value = S.sdf?.corner || 'typ'; }
function allEntities() {
  return [...new Set(S.sources.flatMap(s => [...s.text.replace(/--[^\n]*/g, '').matchAll(/\bentity\s+([a-z]\w*)\s+is\b/gi)].map(m => m[1].toLowerCase())))];
}
function renderSources() {
  $('#srcList').replaceChildren(); $('#srcCount').textContent = S.sources.length;
  S.sources.forEach((s, i) => {
    const li = document.createElement('li'); const kind = document.createElement('span'); kind.className = 'src-kind'; kind.textContent = s.name.split('.').pop().toUpperCase();
    const name = document.createElement('button'); name.className = 'src-name'; name.textContent = s.name; name.title = `Edit ${s.name}`;
    name.onclick = () => { sourceIndex = i; $('#sourceName').textContent = s.name; $('#sourceEditor').value = s.text; $('#sourceLibrary').value = s.library || 'work'; $('#sourceDialog').showModal(); };
    const remove = document.createElement('button'); remove.className = 'src-x'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${s.name}`);
    remove.onclick = () => { if (S.building || S.importing) return; S.sources.splice(i, 1); renderSources(); markDirty(); toast('Source removed. Build to apply changes.'); };
    li.append(kind, name, remove); $('#srcList').append(li);
  });
  const selected = $('#topSelect').value; $('#topSelect').replaceChildren(new Option('Auto-detect top', ''));
  for (const entity of allEntities()) $('#topSelect').add(new Option(entity, entity));
  if (allEntities().includes(selected)) $('#topSelect').value = selected;
}
async function closeSession(sim) { if (sim?.id) await api(`/api/sim/${sim.id}`, undefined, 'DELETE').catch(() => {}); }
async function build(top = $('#topSelect').value) {
  if (S.building || S.exporting) return;
  S.dirty = true; S.pending = []; pause();
  if (!S.sources.length) return toast('Open VHDL sources first.', 'err');
  S.standard = $('#standardSelect').value; S.topLibrary = $('#topLibrary').value.trim(); S.generics = {};
  if (!/^[a-z][a-z0-9_]*$/i.test(S.topLibrary)) return toast('Enter a valid top library name.', 'err');
  if (S.sdf) { S.sdf.instance = $('#sdfInstance').value.trim(); S.sdf.corner = $('#sdfCorner').value; if (!S.sdf.instance) return toast('Enter / for the top level, or a child instance path such as /u1.', 'err'); }
  try { S.generics = parseGenerics($('#genericInput').value); } catch (e) { return toast(e.message, 'err'); }
  pause(); S.building = true; S.error = false; const generation = ++S.generation; setStatus(); saveProject();
  S.pending = []; await closeSession(S.sim); S.sim = null; S.vcd = null;
  try {
    const result = await api('/api/sim/compile', { sources: S.sources, top: top || undefined, standard: S.standard, topLibrary: S.topLibrary, generics: S.generics, sdf: S.sdf });
    if (generation !== S.generation) { await closeSession(result); return; }
    S.sim = result; S.dirty = false; S.time = 0; S.cycles = 0; S.inputs = {}; S.values.clear();
    $('#replayControls').classList.add('hidden');
    for (const signal of result.signals) signal.short = signal.name.startsWith(result.top + '.') ? signal.name.slice(result.top.length + 1) : signal.name;
    buildBindings(); buildWaves(); renderVirtualInputs(); renderPins(); renderTruthInputs();
    uart.reset(); $('#uartOut').replaceChildren();
    board?.clearOutputs(); consume(result);
    for (const signal of result.signals.filter(s => s.driveable && !result.ended)) {
      const bits = Array(signal.width).fill(signal.direction === 3 ? 'Z' : '0');
      for (const net of ['reset_btn', ...KEY_NETS, 'uart_rxd']) {
        const bound = S.bindings[net]; if (bound?.signal.id === signal.id) bits[bound.offset] = '1';
      }
      const value = bits.join(''); S.inputs[signal.id] = value; S.pending.push({ id: signal.id, value });
    }
    if (!result.ended) {
      const initial = await api(`/api/sim/${result.id}/step`, { cycles: 0, inputs: S.pending.splice(0), clock: clockId(), halfPeriod: halfPeriod() });
      consume(initial);
    }
    syncKeys();
    $('#designTitle').textContent = result.top === DEMO_TOP ? 'Counter demo' : result.top;
    $('#designSubtitle').textContent = `GHDL · VHDL-${S.standard === '08' ? '2008' : S.standard === '93' ? '1993' : '2002'}`;
    $('#inputHint').textContent = result.top === DEMO_TOP ? 'Hold S1 to count' : 'Active-low inputs';
    $('.mode-label').textContent = 'GHDL · compiled VHDL';
    log(`${result.backend}\nCompiled ${result.top}. ${result.signals.length} observable signals.`);
    result.diagnostics.forEach(d => log(d, 'warning')); toast(`Compiled ${result.top}`, 'ok');
    waves.fit();
  } catch (e) {
    await closeSession(S.sim); S.sim = null; S.bindings = {}; S.inputs = {}; S.values.clear(); S.time = 0;
    board?.clearOutputs(); sampleOutputs(); renderPins(); waves.setSignals([]); renderSignalChips();
    $('#virtualInputs').replaceChildren(); $('#virtualInputs').classList.add('hidden');
    for (const id of ['truthInputs', 'truthHead', 'truthBody', 'truthSummary', 'uartOut']) $('#' + id).replaceChildren();
    $('#replayControls').classList.add('hidden'); $('#designTitle').textContent = 'Build failed'; $('#designSubtitle').textContent = 'No active simulation'; $('#roTime').textContent = fmtTime(0);
    fail(e);
  } finally { S.building = false; setStatus(); }
}
function buildBindings() {
  S.bindings = {};
  if (!S.sim) return;
  for (const [net, pin] of Object.entries(NET_PIN)) {
    const target = S.assignments.get(pin) ?? (SEG_NETS.includes(net) ? `seven_seg[${SEG_NETS.indexOf(net)}]` : net);
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
function clockId() { const bound = S.bindings.clk?.signal; return bound?.driveable && bound.width === 1 ? bound.id : S.sim?.signals.find(s => s.driveable && s.direction === 1 && s.width === 1 && /^(clk|clock|fpga_clk|clock_50)$/i.test(s.short))?.id ?? -1; }
function halfPeriod() { return String(Math.max(1, Math.round(0.5 * 10 ** -(S.sim?.precision ?? -15) / S.clkHz))); }
function boardValue(net) {
  const bound = S.bindings[net]; if (!bound) return 'U';
  const value = S.values.get(bound.signal.short) ?? 'U';
  return value[bound.offset] ?? 'U';
}
function sampleOutputs() {
  const active = S.power;
  LED_NETS.forEach((net, i) => {
    const value = boardValue(net), on = active && /[0L]/.test(value), indicator = $(`[data-led="${i}"]`);
    board?.setLed(i, on); indicator.classList.toggle('on', on); indicator.classList.toggle('unknown', active && !/^[01LH]$/.test(value));
    indicator.title = `${net.toUpperCase()}: ${!active ? 'power off' : value + (on ? ' · on' : ' · off/unknown')}`;
    indicator.setAttribute('aria-label', indicator.title);
  });
  let byte = 0; SEG_NETS.forEach((net, b) => { if (/[0L]/.test(boardValue(net))) byte |= 1 << b; });
  DIGIT_NETS.forEach((net, i) => board?.setSegDigit(i, byte, active && /[0L]/.test(boardValue(net))));
  const beep = active && /[1H]/.test(boardValue('beep')); board?.setBuzzer(beep);
  if (beep && S.running) audio.startBuzzer(); else audio.stopBuzzer();
}
function consume(result) {
  result.logs?.forEach(m => log(m, /warning/i.test(m) ? 'warning' : 'info'));
  for (const sample of result.samples || []) {
    S.time = Number(sample.time) * 10 ** (15 + (S.sim?.precision ?? -15));
    S.sim.signals.forEach((signal, i) => S.values.set(signal.short, sample.values[i]));
    waves.push(S.time, S.values); sampleOutputs(); uartSample();
  }
  if (result.ended) { S.sim.ended = true; S.pending = []; pause(); log('Testbench completed normally. Its final waveform is ready to export.'); }
  $('#roTime').textContent = fmtTime(S.time);
  if ($('#waveFollow').checked && S.time > 0) waves.follow(S.time, 1e15 / S.clkHz * 12);
  waves.draw();
  for (const input of $$('#virtualInputs input')) {
    if (document.activeElement === input) continue;
    input.disabled = S.building || S.dirty || S.error || !S.power || S.sim?.ended;
    const value = S.inputs[input.dataset.signal];
    if (input.type === 'checkbox') input.checked = value === '1'; else input.value = value ?? '';
  }
}
async function advance(cycles = 1) {
  if (!S.sim || S.sim.ended || S.dirty || S.error || !S.power || S.busy || S.building || S.importing || S.exporting) return;
  if (S.vcd) { stepPlayback(cycles); return; }
  S.busy = true; const generation = S.generation;
  const pending = S.pending.splice(0);
  const batches = [[]]; let ids = new Set();
  for (const input of pending) {
    if (ids.has(input.id)) { batches.push([]); ids = new Set(); }
    batches.at(-1).push(input); ids.add(input.id);
  }
  try {
    for (let i = 0; i < batches.length; i++) {
      const result = await api(`/api/sim/${S.sim.id}/step`, { cycles: i === batches.length - 1 ? cycles : 0, halfPeriod: halfPeriod(), clock: clockId(), inputs: batches[i] });
      if (generation !== S.generation) return;
      consume(result);
      if (S.sim.ended) break;
    }
    S.cycles += cycles;
  } catch (e) { if (generation === S.generation) fail(e); } finally { S.busy = false; }
}
function setInput(id, value) {
  if (!S.power || S.vcd || S.building || S.importing || S.exporting || S.dirty || S.error || !S.sim || S.sim.ended || S.inputs[id] === value) return;
  S.inputs[id] = value; S.pending.push({ id, value }); syncKeys();
  if (!S.running) advance(0);
}
function keyInput(net, pressed) {
  const bound = S.bindings[net]; if (!bound || bound.signal.direction !== 1) return;
  let value = S.inputs[bound.signal.id] ?? '1'.repeat(bound.signal.width);
  if (bound.bit === null) value = pressed ? '0' : '1';
  else { const bits = [...value]; bits[bound.offset] = pressed ? '0' : '1'; value = bits.join(''); }
  setInput(bound.signal.id, value);
}
function syncKeys() {
  $$('.key-btn').forEach(button => {
    const net = button.dataset.key === 'reset' ? 'reset_btn' : button.dataset.key.replace('key', 's');
    const bound = S.bindings[net]; const down = S.power && bound && S.inputs[bound.signal.id]?.[bound.offset] === '0';
    button.classList.toggle('down', !!down); button.setAttribute('aria-pressed', String(!!down));
    button.disabled = S.building || S.importing || S.exporting || S.dirty || S.error || !S.power || !bound?.signal.driveable || !!S.vcd || S.sim?.ended; board?.setKeyVisual(button.dataset.key, !!down);
  });
}
function releaseKeys() { for (const net of ['reset_btn', ...KEY_NETS]) { const bound = S.bindings[net]; if (bound && S.inputs[bound.signal.id]?.[bound.offset] === '0') keyInput(net, false); } }
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
function buildWaves() {
  const preferred = ['clk', 's1', 'count', 'scan', 'seven_seg', 'dtube1', 'led1'];
  waves.setSignals(S.sim.signals.map(s => ({ name: s.short, width: s.width, visible: preferred.includes(s.short) || S.sim.signals.length < 10 })));
  renderSignalChips();
}
function renderSignalChips() {
  $('#sigChips').replaceChildren(); $('#signalCount').textContent = `${waves.signals.length} signals`;
  waves.signals.forEach(signal => {
    const button = document.createElement('button'); button.className = `sig-chip ${signal.visible ? 'on' : 'off'}`;
    const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = signal.color;
    button.append(dot, document.createTextNode(signal.name)); button.setAttribute('aria-pressed', String(signal.visible));
    button.onclick = () => { const on = waves.toggle(signal.name); button.className = `sig-chip ${on ? 'on' : 'off'}`; button.setAttribute('aria-pressed', String(on)); };
    $('#sigChips').append(button);
  });
}
function renderPins() {
  $('#pinBody').replaceChildren();
  for (const [net, pin] of Object.entries(NET_PIN)) {
    const tr = document.createElement('tr'); const netCell = document.createElement('td'); netCell.textContent = net;
    const port = document.createElement('td'), bound = S.bindings[net], input = document.createElement('input');
    input.value = S.assignments.get(pin) ?? (SEG_NETS.includes(net) ? `seven_seg[${SEG_NETS.indexOf(net)}]` : net);
    input.setAttribute('aria-label', `${net} design port`); input.title = bound ? 'Mapped · changing this restarts the design' : 'Unmapped · enter a port or leave blank to disconnect';
    input.className = bound ? 'mapped' : 'unmapped'; input.disabled = S.building || S.importing;
    input.onchange = async () => { S.assignments.set(pin, input.value.trim().toLowerCase()); saveProject(); if (S.vcd) { buildBindings(); renderPins(); board?.clearOutputs(); sampleOutputs(); } else { markDirty(); await build(); } };
    port.append(input);
    const td = document.createElement('td'); td.textContent = pin; tr.append(netCell, port, td); $('#pinBody').append(tr);
  }
}
function uartSample() {
  const result = uart.sample(S.time, boardValue('uart_txd'), Number($('#uartBaud').value));
  result.errors.forEach(message => log(message, 'warning'));
  if (result.bytes.length) { const output = $('#uartOut'); output.textContent = (output.textContent + String.fromCharCode(...result.bytes)).slice(-16384); output.scrollTop = output.scrollHeight; }
}
function renderTruthInputs() {
  $('#truthInputs').replaceChildren(); $('#truthHead').replaceChildren(); $('#truthBody').replaceChildren(); $('#truthSummary').textContent = '';
  S.sim.signals.filter(s => s.driveable && s.direction === 1 && s.width === 1 && s.id !== clockId()).slice(0, 12).forEach((signal, i) => {
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
    for (let row = 0; row < 2 ** names.length; row++) {
      const inputs = isolated.signals.filter(s => s.driveable).map(s => ({ id: s.id, value: (baseInputs.get(s.name) ?? '0'.repeat(s.width)) }));
      ins.forEach((s, i) => { inputs.find(p => p.id === s.id).value = String((row >> (names.length - i - 1)) & 1); });
      const result = await api(`/api/sim/${isolated.id}/step`, { cycles: 0, inputs });
      if (generation !== S.generation || S.dirty) return;
      const tr = document.createElement('tr'); [...ins.map(s => inputs.find(p => p.id === s.id).value), ...outs.map(s => result.samples.at(-1).values[s.id])].forEach(v => { const td = document.createElement('td'); td.textContent = v; tr.append(td); }); $('#truthBody').append(tr);
    }
    $('#truthSummary').textContent = `${2 ** names.length} input combinations · isolated GHDL run · no timing advance`;
  } catch (e) { toast(e.message, 'err'); log(e.message, 'error'); } finally { await closeSession(isolated); S.truthBusy = false; setStatus(); }
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
    if (!['vhd','vhdl','vho','cf','hex','mif','mem','txt','dat','qsf','sdf','vcd','json','sof','pof'].includes(ext)) throw new Error(`Unsupported artifact: .${ext}. See About for supported formats.`);
  }
  pause(); S.importing = true; setStatus();
  try {
    if (['sof','pof'].includes(extensions[0])) return await loadBitstream(await files[0].arrayBuffer(), files[0].name);
    const loaded = await Promise.all(files.map(async (file, i) => ({ name: file.name, text: await file.text(), ext: extensions[i] })));
    if (extensions[0] === 'vcd') return await loadVcd(loaded[0].text, loaded[0].name);
    if (extensions[0] === 'json') { restoreProject(JSON.parse(loaded[0].text)); S.importing = false; markDirty(); return await build(); }
    let changed = false, requestedTop;
    let nextSources = S.sources.map(s => ({ ...s }));
    const qsfFiles = loaded.filter(f => f.ext === 'qsf').map(f => ({ ...f, data: parseQsf(f.text) }));
    for (const file of loaded.filter(f => !['qsf','sdf'].includes(f.ext))) {
      if (!/^[a-z0-9_][a-z0-9_. -]*\.(vhd|vhdl|vho|cf|hex|mif|mem|txt|dat)$/i.test(file.name)) throw new Error(`Invalid filename: ${file.name}. Use a simple filename without directory separators.`);
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
      log('SDF loaded. Verify instance path and min/typ/max corner in Compiler options before building.', 'warning');
    }
    S.importing = false;
    if (S.vcd && !loaded.some(f => f.ext !== 'qsf')) { buildBindings(); renderPins(); sampleOutputs(); saveProject(); }
    else if (changed) { markDirty(); if (!loaded.some(f => f.ext === 'sdf')) await build(); }
  } finally { S.importing = false; setStatus(); }
}
function importError(e) { log(e.message, 'error'); toast(e.message, 'err'); openTools('console'); }
async function fetchTree() {
  try {
    const result = await fetch('/api/hdl/tree').then(r => r.json()); $('#hdlTree').replaceChildren();
    for (const group of result.groups) {
      const wrap = document.createElement('div'); wrap.className = 'hdl-group';
      const heading = document.createElement('button'); heading.className = 'hdl-dir'; heading.textContent = group.dir; heading.onclick = () => wrap.classList.toggle('open');
      const list = document.createElement('div'); list.className = 'hdl-files';
      for (const file of group.files) {
        const button = document.createElement('button'); button.className = 'hdl-file'; button.dataset.name = `${group.dir}/${file.name}`.toLowerCase();
        const kind = document.createElement('span'); kind.className = 'fk'; kind.textContent = file.kind.toUpperCase(); button.append(kind, document.createTextNode(file.name));
        button.onclick = async () => { try { const response = await fetch('/api/hdl/file?path=' + encodeURIComponent(file.rel)); if (!response.ok) throw new Error('File could not be read.'); await loadFiles([new File([await response.blob()], file.name)]); } catch (e) { toast(e.message, 'err'); } };
        list.append(button);
      }
      wrap.append(heading, list); $('#hdlTree').append(wrap);
    }
    if (!result.groups.length) $('#hdlTree').textContent = 'No HDL files found. Open files to begin.';
  } catch { $('#hdlTree').textContent = 'Local library unavailable. Open files to begin.'; }
}
async function loadBitstream(buffer, name) {
  const info = await inspectBitstream(buffer, name); openTools('programmer'); $('#progInfo').classList.remove('hidden');
  for (const [id, value] of Object.entries({ piFile: info.filename, piDevice: info.device || 'Unknown', piFamily: info.family || 'Unknown', piVersion: info.version || 'Unknown', piDate: info.date || 'Unknown', piSize: `${(info.size / 1024).toFixed(1)} KB`, piMatch: info.deviceMatch ? 'EP4CE6 family' : 'Not verified', piHash: info.sha256, piNote: info.note })) $('#' + id).textContent = value;
  log(`Inspected ${name}. No configuration was executed. Cyclone IV bitstream execution requires a device-specific decoder/model, which is not implemented.`, 'warning');
}
async function loadVcd(text, name) {
  const vcd = parseVcd(text);
  pause(); ++S.generation; await closeSession(S.sim);
  const scopes = [...new Set(vcd.vars.map(v => v.scope))];
  const score = scope => vcd.vars.filter(v => v.scope === scope && (Object.hasOwn(NET_PIN, v.shortName.toLowerCase()) || v.shortName.toLowerCase() === 'seven_seg')).length;
  scopes.sort((a, b) => score(b) - score(a) || a.split('.').length - b.split('.').length);
  S.sim = { top: name, signals: vcd.vars.map(v => ({ ...v, short: v.name, localName: v.shortName, driveable: false })) };
  S.vcd = { data: vcd, index: 0, text, scope: scopes[0] }; S.time = 0; S.values.clear(); S.inputs = {}; S.pending = []; S.error = false; S.dirty = false;
  for (const v of vcd.vars) S.values.set(v.name, ['real','realtime'].includes(v.kind) ? '—' : 'U'.repeat(v.width));
  waves.setSignals(vcd.vars.map((v, i) => ({ name: v.name, width: v.width, kind: v.kind, visible: i < 8 }))); renderSignalChips();
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
  if ($('#waveFollow').checked) { waves.fit(); waves.cursorT = S.time; } waves.draw();
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
  const states = {
    btnLibrary: leftOpen && $('#ltab-library').classList.contains('active'),
    btnPins: leftOpen && $('#ltab-pins').classList.contains('active'),
    btnSignals: !$('#app').classList.contains('no-waves'),
    btnTools: !$('#right').classList.contains('hidden')
  };
  for (const [id, open] of Object.entries(states)) {
    $('#' + id).classList.toggle('active', open);
    $('#' + id).setAttribute('aria-expanded', String(open));
  }
}
function leftTab(name) {
  $$('#left .tab').forEach(t => { const active = t.dataset.ltab === name; t.classList.toggle('active', active); t.setAttribute('aria-selected', String(active)); });
  $$('.ltab').forEach(t => t.classList.toggle('active', t.id === 'ltab-' + name));
  syncNavigation();
}
function toggleLeft(name) {
  const app = $('#app'), open = getComputedStyle($('#left')).display !== 'none';
  const close = open && $('#ltab-' + name).classList.contains('active');
  if (innerWidth <= 1000) app.classList.toggle('mobile-library', !close); else app.classList.toggle('no-library', close);
  leftTab(name);
}
function openTools(name = 'console') {
  $('#right').classList.remove('hidden');
  $$('#right .tab').forEach(t => { const active = t.dataset.rtab === name; t.classList.toggle('active', active); t.setAttribute('aria-selected', String(active)); });
  $$('.rtab').forEach(t => t.classList.toggle('active', t.id === 'rtab-' + name));
  syncNavigation();
}
function applyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = theme;
  $('#btnTheme').classList.toggle('active', dark);
  $('#btnTheme').setAttribute('aria-pressed', String(dark));
  $('#btnTheme').title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  $('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  board?.setTheme();
  if (waves) { waves.setTheme(); renderSignalChips(); }
}
function wire() {
  $('#btnTheme').onclick = () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(theme);
    try { localStorage.setItem('trace.theme', theme); } catch {}
  };
  $('#btnRun').onclick = () => { if (!S.sim || S.sim.ended || S.dirty || S.error || !S.power || S.building || S.importing) return; if (S.running) pause(); else { S.running = true; setStatus('Running'); lastFrame = performance.now(); } };
  $('#btnStep').onclick = () => { pause(); advance(1); };
  $('#btnReset').onclick = () => S.vcd ? loadVcd(S.vcd.text, S.sim.top) : build(S.sim?.top);
  $('#speed').oninput = e => { S.speed = Number(e.target.value); $('#rateLabel').textContent = `${(10 ** ((S.speed - 55) / 25)).toFixed(1).replace('.0', '')}×`; };
  $('#clkHz').onchange = e => { S.clkHz = Number(e.target.value); accumulator = 0; log(`Ideal clock: ${S.clkHz} Hz. Execution speed is limited by native simulation and display throughput.`); };
  $('#btnMute').onclick = () => { const muted = !audio.isMuted(); audio.setMuted(muted); if (!muted) audio.resume(); $('#btnMute').setAttribute('aria-pressed', String(muted)); $('#muteLabel').textContent = muted ? 'Sound off' : 'Sound on'; };
  $('#btnElab').onclick = () => build(); $('#topSelect').onchange = () => build();
  $('#btnDemo').onclick = () => { S.sources = [{ name: DEMO_NAME, text: DEMO_SRC }]; S.assignments.clear(); S.sdf = null; $('#genericInput').value = ''; $('#topLibrary').value = 'work'; $('#standardSelect').value = '93'; renderSdf(); renderSources(); build(DEMO_TOP); };
  $('#btnSaveProject').onclick = () => { saveProject(); download(JSON.stringify(projectData(), null, 2), 'trace-project.json', 'application/json'); toast('Project saved, including sources, libraries and pin mappings.'); };
  for (const id of ['standardSelect', 'topLibrary', 'genericInput', 'sdfInstance', 'sdfCorner']) $('#' + id).onchange = markDirty;
  $('#clearSdf').onclick = () => { S.sdf = null; renderSdf(); markDirty(); };
  $('#replayScope').onchange = e => { S.vcd.scope = e.target.value; buildBindings(); renderPins(); board?.clearOutputs(); sampleOutputs(); };
  $('#btnLedView').onclick = () => camera('leds');
  for (const id of ['btnImport', 'dropZone', 'btnQsf']) $('#' + id).onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = async e => { try { await loadFiles([...e.target.files]); } catch (err) { importError(err); } e.target.value = ''; };
  $('#progDrop').onclick = () => $('#progFile').click(); $('#progFile').onchange = e => loadFiles([...e.target.files]).catch(importError);
  window.addEventListener('dragover', e => e.preventDefault()); window.addEventListener('drop', e => { e.preventDefault(); loadFiles([...e.dataTransfer.files]).catch(importError); });
  $('#libSearch').oninput = e => { const query = e.target.value.toLowerCase(); $$('.hdl-group').forEach(group => { let visible = false; group.querySelectorAll('.hdl-file').forEach(file => { const match = file.dataset.name.includes(query); file.hidden = !match; visible ||= match; }); group.hidden = !visible; if (query) group.classList.add('open'); }); };
  $('#btnPinReset').onclick = () => { S.assignments.clear(); saveProject(); if (S.vcd) { buildBindings(); renderPins(); sampleOutputs(); } else { markDirty(); build(); } };
  $$('.key-btn').forEach(button => {
    const net = button.dataset.key === 'reset' ? 'reset_btn' : button.dataset.key.replace('key', 's');
    button.onpointerdown = e => { if (button.disabled) return; e.preventDefault(); button.setPointerCapture(e.pointerId); keyInput(net, true); };
    button.onpointerup = button.onpointercancel = button.onlostpointercapture = () => keyInput(net, false);
    button.onkeydown = e => { if (['Enter', ' '].includes(e.key)) { e.preventDefault(); e.stopPropagation(); keyInput(net, true); } };
    button.onkeyup = e => { if (['Enter', ' '].includes(e.key)) { e.preventDefault(); e.stopPropagation(); keyInput(net, false); } };
  });
  const keys = { '1': 's1', '2': 's2', '3': 's3', '4': 's4', r: 'reset_btn' };
  window.addEventListener('keydown', e => {
    if (e.target.closest('input,select,textarea,dialog') || e.repeat) return;
    if (keys[e.key.toLowerCase()]) { e.preventDefault(); keyInput(keys[e.key.toLowerCase()], true); }
    if (e.code === 'Space' && e.target.tagName !== 'BUTTON') { e.preventDefault(); $('#btnRun').click(); }
    if (e.key === '.') $('#btnStep').click();
    if (e.key === 'Escape') { $('#right').classList.add('hidden'); $('#deck').classList.add('hidden'); $('#app').classList.remove('mobile-library'); syncNavigation(); }
  });
  window.addEventListener('keyup', e => { if (keys[e.key.toLowerCase()]) keyInput(keys[e.key.toLowerCase()], false); });
  window.addEventListener('blur', releaseKeys);
  document.addEventListener('visibilitychange', () => { if (document.hidden) { releaseKeys(); pause(); } });
  $('#pwrToggle').onchange = async e => { S.power = e.target.checked; pause(); board?.setPower(S.power); if (!S.power) { releaseKeys(); board?.clearOutputs(); sampleOutputs(); } else if (S.sim && !S.vcd) await build(S.sim.top); else sampleOutputs(); syncKeys(); };
  const camera = name => { board?.setCamera(name); $('#center').classList.toggle('closeup', ['leds','fpga','display','dtubes','io'].includes(name)); $('#camPreset').value = name; $$('[data-camera]').forEach(b => b.classList.toggle('active', b.dataset.camera === name)); };
  $$('[data-camera]').forEach(b => b.onclick = () => camera(b.dataset.camera)); $('#camPreset').onchange = e => camera(e.target.value);
  $('#btnViewSettings').onclick = () => { $('#deck').classList.toggle('hidden'); $('#btnViewSettings').setAttribute('aria-expanded', String(!$('#deck').classList.contains('hidden'))); };
  $('#deckCollapse').onclick = () => $('#btnViewSettings').click();
  for (const [id, display, setter] of [['explode', 'explodeVal', 'setExplode'], ['persistence', 'persistVal', 'setPersistence'], ['glow', 'glowVal', 'setGlow']]) $('#' + id).oninput = e => { $('#' + display).textContent = `${e.target.value}%`; board?.[setter](Number(e.target.value) / 100); };
  for (const [id, setter] of [['tglOrbit', 'setAutoOrbit'], ['tglLabels', 'setLabels'], ['tglGrid', 'setGrid'], ['tglTraces', 'setTraces']]) $('#' + id).onchange = e => board?.[setter](e.target.checked);
  $('#quality').onchange = e => board?.setQuality(e.target.value); $('#btnResetView').onclick = () => camera('hero');
  $('#btnShot').onclick = () => { if (!board) return; const a = document.createElement('a'); a.href = board.screenshot(); a.download = 'trace-board.png'; a.click(); };
  $('#btnVcd').onclick = exportVcd; $('#waveZoomIn').onclick = () => { $('#waveFollow').checked = false; waves.zoom(1 / 1.4); }; $('#waveZoomOut').onclick = () => { $('#waveFollow').checked = false; waves.zoom(1.4); }; $('#waveFit').onclick = () => { $('#waveFollow').checked = false; waves.fit(); };
  waves.onCursor = time => $('#waveCursor').textContent = `Cursor ${fmtTime(time)}`; waves.onNavigate = () => $('#waveFollow').checked = false;
  $('#btnLibrary').onclick = () => toggleLeft('library');
  $('#btnPins').onclick = () => toggleLeft('pins'); $('#closeLeft').onclick = () => { $('#app').classList.remove('mobile-library'); $('#app').classList.add('no-library'); syncNavigation(); };
  $('#btnSignals').onclick = () => { $('#app').classList.toggle('no-waves'); syncNavigation(); };
  $('#btnTools').onclick = () => $('#right').classList.contains('hidden') ? openTools() : $('#closeRight').click();
  $('#closeRight').onclick = () => { $('#right').classList.add('hidden'); syncNavigation(); };
  $$('[data-ltab]').forEach(b => b.onclick = () => leftTab(b.dataset.ltab)); $$('[data-rtab]').forEach(b => b.onclick = () => openTools(b.dataset.rtab));
  for (const id of ['btnAbout', 'btnLimits']) $('#' + id).onclick = () => $('#aboutDialog').showModal();
  $$('[data-close]').forEach(b => b.onclick = () => $('#' + b.dataset.close).close());
  $('#saveSource').onclick = () => { const library = $('#sourceLibrary').value.trim(); if (!/^[a-z][a-z0-9_]*$/i.test(library)) return toast('Enter a valid VHDL library name.', 'err'); if (S.building || !S.sources[sourceIndex]) return; S.sources[sourceIndex].library = library; S.sources[sourceIndex].text = $('#sourceEditor').value; $('#sourceDialog').close(); renderSources(); markDirty(); build(); };
  $('#consoleClear').onclick = () => { $('#consoleOut').replaceChildren(); $('#consoleCount').textContent = consoleCount = 0; };
  $('#consoleCopy').onclick = copyConsole;
  $('#uartClear').onclick = () => $('#uartOut').replaceChildren(); $('#btnTruth').onclick = runTruth;
  window.addEventListener('pagehide', () => { if (S.sim?.id) navigator.sendBeacon(`/api/sim/${S.sim.id}/close`, ''); });
}
function frame(now) {
  requestAnimationFrame(frame); const dt = Math.min(.1, (now - lastFrame) / 1000); lastFrame = now;
  if (now - lastDraw > 250) { $('#roFps').textContent = board ? Math.round(board.fps) : '—'; lastDraw = now; }
  if (S.running && !S.busy) { accumulator += S.clkHz * 10 ** ((S.speed - 55) / 25) * dt; const cycles = Math.min(512, Math.floor(accumulator)); if (cycles) { accumulator -= cycles; accumulator = Math.min(accumulator, 512); advance(cycles); } }
  else if (!S.running && S.pending.length && !S.busy && !S.building) advance(0);
}
async function boot() {
  matchMedia('(max-width: 1000px)').addEventListener('change', syncNavigation);
  syncNavigation();
  audio.setMuted(true);
  fetch('/api/health').then(response => response.json()).then(health => { logFile = health.logFile || ''; }).catch(() => {});
  try { board = await createBoard3D($('#view3d'), { onKey: (id, pressed) => keyInput(id === 'reset' ? 'reset_btn' : id.replace('key', 's'), pressed) }); board.setPower(true); board.setGlow(.4); } catch (e) { $('#glOverlay').classList.remove('hidden'); log(e.message, 'error'); }
  waves = new WaveViewer($('#waveCanvas'), $('#waveNames')); applyTheme(document.documentElement.dataset.theme); wire(); fetchTree();
  S.sources = [{ name: DEMO_NAME, text: DEMO_SRC }]; renderSources(); requestAnimationFrame(frame);
  window.__lab = { get state() { return S; }, get board() { return board; }, get waves() { return waves; }, build, advance, loadFiles };
  try { const saved = localStorage.getItem('trace.project.v1'); if (saved) restoreProject(JSON.parse(saved)); } catch (e) { importError(new Error(`Saved project could not be restored: ${e.message}`)); S.sources = []; renderSources(); setStatus(); return; }
  await build();
}
boot();
