import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { startServer } from './server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await startServer();
const { base, logFile } = server;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-browser-'));
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--enable-unsafe-swiftshader', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let socket, seq = 0, sessionId, passed = 0, onLoad, cleanup;
const waiting = new Map(), errors = [], remote = new Set(), downloads = new Map();
const check = (value, message) => { assert.ok(value, message); passed++; console.log(`ok ${message}`); };
try {
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''; const timeout = setTimeout(() => reject(new Error('Chrome startup timed out')), 20000);
    chrome.on('error', reject); chrome.stderr.on('data', chunk => { output += chunk; const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timeout); resolve(match[1]); } });
  });
  socket = new WebSocket(endpoint); await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id) { const p = waiting.get(msg.id); if (!p) return; waiting.delete(msg.id); clearTimeout(p.timer); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
    if (msg.method === 'Browser.downloadWillBegin') downloads.set(msg.params.guid, { name: msg.params.suggestedFilename, done: false });
    if (msg.method === 'Browser.downloadProgress' && downloads.has(msg.params.guid)) downloads.get(msg.params.guid).done = msg.params.state === 'completed';
    if (msg.method === 'Page.loadEventFired') { onLoad?.(); onLoad = null; }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails);
    if (msg.method === 'Network.requestWillBeSent' && /^https?:/.test(msg.params.request.url) && !msg.params.request.url.startsWith(base + '/')) remote.add(msg.params.request.url);
  };
  const send = (method, params = {}, inPage = true) => new Promise((resolve, reject) => {
    const id = ++seq; const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method} timed out`)); }, 45000);
    waiting.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(inPage && sessionId ? { sessionId } : {}) }));
  });
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: profile, eventsEnabled: true }, false);
  const downloaded = async name => { const start = Date.now(); while (![...downloads.values()].some(d => d.name === name && d.done)) { if (Date.now() - start > 10000) throw new Error(`Download did not finish: ${name}`); await new Promise(r => setTimeout(r, 25)); } return fs.readFile(path.join(profile, name), 'utf8'); };
  const target = await send('Target.createTarget', { url: 'about:blank' }, false);
  sessionId = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, false)).sessionId;
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  cleanup = () => evaluate('window.__lab?.state.sim?.id ? fetch(`/api/sim/${__lab.state.sim.id}`,{method:"DELETE"}) : null');
  const wait = async expression => evaluate(`(async()=>{const start=performance.now();while(!(${expression})){if(performance.now()-start>30000)throw new Error('Page state timeout: '+${JSON.stringify(expression)});await new Promise(r=>setTimeout(r,40));}return true;})()`);
  const idle = () => wait('window.__lab && !__lab.state.building && !__lab.state.importing && !__lab.state.busy && !__lab.state.pending.length');
  const click = async selector => {
    const rect = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1 });
  };
  const fill = async (selector, text) => {
    check(await evaluate(`!document.querySelector(${JSON.stringify(selector)}).disabled`), `editable control: ${selector}`);
    await click(selector);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await send('Input.insertText', { text });
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  };
  const screenshot = async name => {
    await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await fs.writeFile(path.join(root, 'research', name), Buffer.from(shot.data, 'base64')); console.log(`screenshot research/${name}`);
  };
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await send('Browser.grantPermissions', { origin: base, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }, false);
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.navigate', { url: base + '/' }); await idle();
  check(await evaluate('!document.querySelector("#homeView").classList.contains("hidden") && !__lab.state.sim && document.querySelectorAll("#homeStarterGrid .home-starter-item").length===4'), 'app starts at the IDE Home interface without compiling in the background');
  await click('#homeContinueBtn'); await idle();
  check(await evaluate('!!__lab.board && __lab.state.sim.backend.startsWith("GHDL")'), 'entering workbench compiles design with native backend and WebGL board');
  check(await evaluate('__lab.board.model.children.length===41 && ["p1","p2","p3"].every(n=>__lab.board.model.getObjectByName(n)) && !__lab.board.model.getObjectByName("p4")'), 'Blender asset contains the corrected three-header layout');
  check(await evaluate(`(async()=>{const T=await import('three');const size=new T.Box3().setFromObject(__lab.board.model.getObjectByName('pcb')).getSize(new T.Vector3());return Math.abs(size.x-136)<.01&&Math.abs(size.z-106)<.01&&Math.abs(size.y-1.6)<.01;})()`), 'imported PCB preserves 136 by 106 by 1.6 mm model dimensions');
  check(await evaluate('document.querySelector("#homeView").classList.contains("hidden") && document.documentElement.scrollWidth === innerWidth'), 'desktop has no horizontal overflow');
  await screenshot('overhaul-desktop.png');
  const checkNavigation = async (activeIds, message) => {
    const state = await evaluate(`(() => {
      const visible = id => getComputedStyle(document.getElementById(id)).display !== 'none';
      const panels = { btnLibrary: visible('left') && visible('ltab-library'), btnPins: visible('left') && visible('ltab-pins'), btnSignals: visible('waves'), btnTools: visible('right') };
      return Object.entries(panels).map(([id, visible]) => { const button = document.getElementById(id); return { id, visible, active: button.classList.contains('active'), expanded: button.getAttribute('aria-expanded') }; });
    })()`);
    check(state.every(s => s.visible === activeIds.includes(s.id) && s.active === s.visible && s.expanded === String(s.visible)), `${message}: ${JSON.stringify(state)}`);
  };
  const escape = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  };
  await click('#closeLeft'); await checkNavigation(['btnSignals'], 'closing Project clears Files and Pins highlights');
  await screenshot('sidebar-closed.png');
  await click('#btnLibrary'); await checkNavigation(['btnLibrary', 'btnSignals'], 'Files highlights its open panel');
  await click('#btnLibrary'); await checkNavigation(['btnSignals'], 'clicking Files again clears its highlight');
  await click('#btnPins'); await checkNavigation(['btnPins', 'btnSignals'], 'Pins highlights its open panel');
  await click('#btnLibrary'); await checkNavigation(['btnLibrary', 'btnSignals'], 'switching from Pins to Files moves the highlight');
  await click('#btnPins'); await click('#btnPins'); await checkNavigation(['btnSignals'], 'clicking Pins again closes it and clears its highlight');
  await click('#btnLibrary'); await click('#btnTools'); await checkNavigation(['btnLibrary', 'btnSignals', 'btnTools'], 'Tools can highlight alongside other visible panels');
  await click('#closeRight'); await checkNavigation(['btnLibrary', 'btnSignals'], 'Tools close button clears its highlight');
  await click('#btnTools'); await click('#btnTools'); await checkNavigation(['btnLibrary', 'btnSignals'], 'Tools toggle clears its highlight');
  await click('#btnTools'); await escape(); await checkNavigation(['btnLibrary', 'btnSignals'], 'Escape clears Tools without hiding the desktop Project panel');
  await click('#btnSignals'); await checkNavigation(['btnLibrary'], 'hiding Signals clears its highlight');
  await click('#btnSignals'); await checkNavigation(['btnLibrary', 'btnSignals'], 'showing Signals restores its highlight');
  for (const width of [1000, 390]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    await checkNavigation(['btnSignals'], `${width}px hidden project drawer is not highlighted`);
    await click('#btnLibrary'); await checkNavigation(['btnLibrary', 'btnSignals'], `${width}px Files drawer highlights when open`);
    await click('#btnPins'); await checkNavigation(['btnPins', 'btnSignals'], `${width}px switching to Pins keeps the drawer open`);
    await click('#btnLibrary'); await checkNavigation(['btnLibrary', 'btnSignals'], `${width}px switching back to Files keeps the drawer open`);
    await click('#closeLeft'); await checkNavigation(['btnSignals'], `${width}px drawer close clears its highlight`);
    await click('#btnPins'); await click('#btnPins'); await checkNavigation(['btnSignals'], `${width}px Pins toggles closed`);
    await click('#btnLibrary'); await click('#btnTools'); await escape(); await checkNavigation(['btnSignals'], `${width}px Escape clears both drawer highlights`);
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  await checkNavigation(['btnSignals'], 'returning to desktop preserves the closed project state');
  await click('#btnLibrary'); await checkNavigation(['btnLibrary', 'btnSignals'], 'desktop Files reopens after responsive transitions');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '1', code: 'Digit1', windowsVirtualKeyCode: 49 }); await idle();
  check(await evaluate('__lab.state.values.get("s1")==="0" && document.querySelector("[data-key=key1]").classList.contains("down")'), 'keyboard drives active-low S1 and pressed styling');
  await evaluate('__lab.advance(20)'); await idle();
  check(await evaluate('BigInt("0b"+__lab.state.values.get("count"))===20n'), 'held S1 produces exactly twenty counts');
  check(await evaluate('__lab.board.displayState.every(s=>s.latched!==0)'), 'all multiplexed digits reach the model');
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '1', code: 'Digit1', windowsVirtualKeyCode: 49 }); await idle();
  await click('#btnStep'); await idle();
  check(await evaluate('BigInt("0b"+__lab.state.values.get("count"))===20n'), 'step with released enable holds count');
  await click('#btnRun'); await wait('__lab.state.time>25000000000000'); await click('#btnRun'); await idle();
  check(await evaluate('!__lab.state.running'), 'run and pause controls work');
  await screenshot('overhaul-running-trace.png');
  await click('#btnViewSettings'); check(await evaluate('!document.querySelector("#deck").classList.contains("hidden")'), 'view settings open');
  await click('#deckCollapse');
  await click('[data-camera="top"]');
  await wait('Math.abs(__lab.board.camera.position.x)<0.001 && __lab.board.camera.position.y>239');
  await screenshot('overhaul-top.png');
  const keyPoint = await evaluate(`(async()=>{const T=await import('three');const cap=__lab.board.model.getObjectByName('key_key1_cap');const v=cap.getWorldPosition(new T.Vector3()).project(__lab.board.camera);const r=document.querySelector('#view3d').getBoundingClientRect();return {x:r.x+(v.x+1)*r.width/2,y:r.y+(1-v.y)*r.height/2,baseY:cap.position.y};})()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: keyPoint.x, y: keyPoint.y, button: 'left', clickCount: 1 }); await idle();
  await wait(`__lab.board.model.getObjectByName('key_key1_cap').position.y < ${keyPoint.baseY - .0003}`);
  check(await evaluate('__lab.state.values.get("s1")==="0" && !__lab.board.controls.enabled'), 'clicking the actual 3D key drives S1 and depresses its cap');
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 350, y: 185, button: 'left', clickCount: 1 }); await idle();
  check(await evaluate('__lab.state.values.get("s1")==="1" && __lab.board.controls.enabled'), 'releasing outside the 3D key restores input and orbit controls');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '4', code: 'Digit4', windowsVirtualKeyCode: 52 }); await idle();
  await evaluate('__lab.advance(4)'); await idle();
  await wait('__lab.board.model.getObjectByName("led_led1_lens").material.emissiveIntensity>0');
  check(await evaluate('__lab.board.displayState.every(s=>s.latched===127) && __lab.state.values.get("led1")==="0"'), 'native lamp test drives independent GLB LED and digit meshes');
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '4', code: 'Digit4', windowsVirtualKeyCode: 52 }); await idle();
  await evaluate('__lab.board.setCamera("fpga")'); await wait('__lab.board.camera.position.y<62'); await screenshot('blender-browser-detail.png');
  await evaluate('__lab.board.setExplode(1)'); await wait('__lab.board.model.getObjectByName("fpga").position.y>.035');
  check(await evaluate('__lab.board.model.getObjectByName("pcb").position.y<.002'), 'exploded view lifts components without moving the PCB');
  await evaluate('__lab.board.setExplode(0);__lab.board.setCamera("underside")'); await wait('__lab.board.camera.position.y < -209.9');
  await screenshot('blender-browser-underside.png');
  check(await evaluate('__lab.board.controls.maxPolarAngle>Math.PI*.99'), 'underside is accessible without orbit restrictions');
  await click('[data-camera="hero"]');
  await click('#btnTools'); check(await evaluate('!document.querySelector("#right").classList.contains("hidden")'), 'inspection drawer opens'); await click('#closeRight');
  await click('#pwrToggle'); check(await evaluate('!__lab.state.power && !__lab.state.running && document.querySelector("#btnRun").disabled && !document.querySelector("[data-led].on")'), 'power-off blanks outputs and disables transport');
  await click('#pwrToggle'); await idle(); check(await evaluate('__lab.state.time===0 && /^0+$/.test(__lab.state.values.get("count"))'), 'power-on starts a fresh native simulation');
  await click('#btnVcd'); await wait('__lab.state.sim.ended'); check(await evaluate('__lab.state.sim.exportedVcd.includes("$enddefinitions") && document.querySelector("#btnRun").disabled'), 'finish-and-export finalizes native VCD and disables ended session');
  await click('#btnReset'); await idle();
  await click('.src-name'); check(await evaluate('document.querySelector("#sourceDialog").open'), 'source editor opens'); await click('[data-close="sourceDialog"]');
  await click('#btnLedView'); await wait('Math.abs(__lab.board.camera.position.y-45)<.05');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '4', code: 'Digit4', windowsVirtualKeyCode: 52 }); await idle();
  await wait('[1,2,3,4].every(i=>__lab.board.model.getObjectByName(`led_led${i}_lens`).material.emissiveIntensity>0)');
  check(await evaluate('document.querySelectorAll("[data-led].on").length===4'), 'LED locator focuses the four independent active-low indicators');
  await screenshot('product-leds.png');
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '4', code: 'Digit4', windowsVirtualKeyCode: 52 }); await idle();

  const loadProject = async (sources, extra = {}) => {
    const project = { format: 'trace-project', version: 1, sources, assignments: [], top: 'dut', topLibrary: 'work', standard: '08', generics: '', sdf: null, ...extra };
    await evaluate(`__lab.loadFiles([new File([${JSON.stringify(JSON.stringify(project))}], 'project.json')])`); await idle();
  };
  const andGate = `library ieee; use ieee.std_logic_1164.all; entity dut is port(a,b: in std_logic; y: out std_logic); end; architecture rtl of dut is begin y <= a and b; end;`;
  await loadProject([{ name: 'gate.vhd', text: andGate }]);
  check(await evaluate('__lab.state.sim.top==="dut" && document.querySelectorAll("#virtualInputs input").length===2'), 'saved project import builds source and exposes virtual inputs');
  await click('#virtualInputs input[aria-label="a"]'); await idle(); await click('#virtualInputs input[aria-label="b"]'); await idle();
  check(await evaluate('__lab.state.values.get("y")==="1"'), 'real virtual input controls drive compiled AND gate');
  await click('#btnTools'); await click('[data-rtab="truth"]'); await click('#btnTruth'); await wait('!__lab.state.truthBusy');
  check(await evaluate('[...document.querySelectorAll("#truthBody tr")].map(r=>r.lastChild.textContent).join("")==="0001" && __lab.state.values.get("y")==="1"'), 'isolated truth table covers all inputs without changing active simulation');
  await screenshot('product-truth.png');
  await evaluate(`window.originalFetch=window.fetch;window.fetch=async(...args)=>{const response=await originalFetch(...args);if(args[0]==='/api/sim/compile'){await new Promise(r=>window.releaseTruthCompile=r);}return response;}`);
  await click('#btnTruth'); await wait('typeof releaseTruthCompile==="function"');
  await evaluate('window.fetch=originalFetch');
  await loadProject([{ name: 'gate.vhd', text: andGate }]);
  await evaluate('releaseTruthCompile()'); await wait('!__lab.state.truthBusy');
  check(await evaluate('document.querySelector("#truthBody").children.length===0 && !__lab.state.error'), 'late truth-table results cannot overwrite a rebuilt design');
  await click('#closeRight');
  await click('.src-name'); await evaluate('document.querySelector("#sourceEditor").value="entity dut is invalid syntax; end;"'); await click('#saveSource'); await idle();
  check(await evaluate('document.querySelector("#statusPill").textContent==="Error" && document.querySelector("#btnRun").disabled && document.querySelector("#consoleOut").textContent.includes("expected")'), 'compiler errors remain visible and disable invalid designs');
  check(await evaluate('__lab.waves.signals.length===0 && !document.querySelector("#virtualInputs input") && !document.querySelector("#truthBody tr") && document.querySelector("#designTitle").textContent==="Build failed"'), 'failed builds remove stale signals, inputs and truth results');
  await click('#closeRight'); await click('.src-name'); await evaluate(`document.querySelector('#sourceEditor').value=${JSON.stringify(andGate)}`); await click('#saveSource'); await idle();
  check(await evaluate('!__lab.state.error && !!__lab.state.sim && !document.querySelector("#btnRun").disabled'), 'source editor recovers from a compiler failure');
  await evaluate('document.querySelector(".compiler-options").open=true;document.querySelector("#genericInput").value="BAD=";document.querySelector("#genericInput").dispatchEvent(new Event("change"))');
  await click('#btnElab');
  check(await evaluate('__lab.state.dirty && document.querySelector("#btnRun").disabled && document.querySelector("#toast").textContent.includes("scalar")'), 'invalid compiler settings cannot run a stale compiled design');
  await evaluate('document.querySelector("#genericInput").value="";document.querySelector("#genericInput").dispatchEvent(new Event("change"))'); await click('#btnElab'); await idle();
  const readLog = async (pattern, message) => {
    const start = Date.now(); let text = '';
    while (!pattern.test(text = await fs.readFile(logFile, 'utf8').catch(() => ''))) { if (Date.now() - start > 5000) break; await new Promise(r => setTimeout(r, 50)); }
    check(pattern.test(text), `${message}: ${JSON.stringify(text.slice(-1500))}`); return text;
  };
  const entries = (await readLog(/scalar/, 'error log receives the invalid-generic toast')).split(/(?=^==== )/m).filter(Boolean);
  const compileEntries = entries.filter(e => /^Message:\n {2}.*expected/m.test(e)), genericEntries = entries.filter(e => /^Message:\n {2}.*scalar/m.test(e));
  const compileEntry = compileEntries[0] || '';
  check(/\| client error ====/.test(compileEntry) && /^Design: gate\.vhd$/m.test(compileEntry) && /^Status: Error$/m.test(compileEntry) && /^Backend: none$/m.test(compileEntry) && /^Browser: .*Chrome/m.test(compileEntry) && /Recent console \(oldest first\):\n(?: {2}.*\n)*? {2}\[\d\d:\d\d:\d\d\] \[[^\]]+\] ERROR .*expected/.test(compileEntry), `compiler failures are logged with session details and recent console lines: ${JSON.stringify(compileEntry)}`);
  check(compileEntries.length === 1 && genericEntries.length === 1, `an error shown in both the console and a toast is logged once: ${compileEntries.length}, ${genericEntries.length}`);
  await evaluate('setTimeout(() => { throw new Error("trace log probe") })');
  await readLog(/Message:\n {2}Uncaught error: Error: trace log probe[\s\S]*?Stack:\n {2}Error: trace log probe/, 'uncaught page exceptions are logged with their stack');
  check(await evaluate('[...document.querySelectorAll("#consoleOut .console-line.error")].some(r => r.textContent.includes("Uncaught error: Error: trace log probe"))'), 'uncaught page exceptions also appear in the console');
  await click('#btnTools'); await click('[data-rtab="console"]');
  const consoleState = await evaluate('({ count: document.querySelectorAll("#consoleOut .console-line").length, last: document.querySelector("#consoleOut .console-line:last-child span:last-child").textContent })');
  await click('#consoleCopy');
  await wait('document.querySelector("#consoleCopy").textContent === "Copied"');
  const copied = (await evaluate('navigator.clipboard.readText()')).replace(/\r\n/g, '\n');
  const copyLines = copied.split('\n');
  check(copyLines[0] === 'Trace FPGA workbench console report' && /^Copied: .+GMT[+-]\d{4}/.test(copyLines[1]) && copyLines.includes(`Error log: ${logFile}`) && copyLines.includes('Design: gate.vhd') && copyLines.some(l => /^Status: \S/.test(l)) && copyLines.some(l => /^Browser: .*Chrome/.test(l)), `console copy includes session details and the log path: ${JSON.stringify(copyLines.slice(0, 14))}`);
  check(copyLines.includes(`Console (${consoleState.count} events, oldest first):`) && copied.endsWith(consoleState.last.replace(/\n/g, '\n    ')) && copyLines.filter(l => /^\[\d\d:\d\d:\d\d\] \[[^\]]+\] (INFO|WARNING|ERROR) /.test(l)).length === consoleState.count, `console copy contains every event in order: ${consoleState.count}`);
  check(await evaluate('document.querySelector("#toast").textContent') === `Copied ${consoleState.count} console events with session details.`, 'console copy confirms what was copied');
  await screenshot('console-copy.png'); await click('#closeRight');

  const mapped = `library ieee; use ieee.std_logic_1164.all; entity dut is generic(W: positive := 5); port(keys: in std_logic_vector(4 to 4+W-1); leds: out std_logic_vector(4 to 7)); end; architecture rtl of dut is begin leds <= keys(4 to 7); end;`;
  await loadProject([{ name: 'range.vhd', text: mapped }], { generics: 'W=5' });
  const qsf = [88,89,90,91].map((pin,i)=>`set_location_assignment PIN_${pin} -to {keys[${i+4}]}`).concat([87,86,85,84].map((pin,i)=>`set_location_assignment PIN_${pin} -to {leds[${i+4}]}`)).join('\n');
  await evaluate(`__lab.loadFiles([new File([${JSON.stringify(qsf)}], 'board.qsf')])`); await idle();
  check(await evaluate('__lab.state.values.get("keys")==="11110" && __lab.state.bindings.s1.offset===0 && __lab.state.bindings.s4.offset===3'), 'QSF initializes mapped active-low bits in ascending nonzero vectors without changing unmapped bits');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '1', code: 'Digit1', windowsVirtualKeyCode: 49 }); await idle();
  check(await evaluate('__lab.state.values.get("keys")==="01110" && document.querySelector(`[data-led="0"]`).classList.contains("on")'), 'physical key correctly drives ascending-range vector and mapped LED');
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '1', code: 'Digit1', windowsVirtualKeyCode: 49 }); await idle();
  await click('#btnPins');
  await fill('input[aria-label="led1 design port"]', 'leds[7]'); await idle();
  check(await evaluate('__lab.state.bindings.led1.offset===3'), 'editable pin map rebuilds with the chosen vector bit');
  check(await evaluate('[...document.querySelectorAll("#pinBody input")].every(e=>!e.disabled)'), 'pin controls remain editable after rebuilding');
  await screenshot('product-pins.png');
  await click('#btnLibrary');
  await click('#btnSaveProject');
  check(await evaluate('JSON.parse(localStorage.getItem("trace.project.v1")).assignments.some(p=>p[0]===87&&p[1]==="leds[7]")'), 'project save includes source settings and edited pin map');
  const savedProject = JSON.parse(await downloaded('trace-project.json'));
  check(savedProject.generics === 'W=5' && savedProject.sources[0].text === mapped && savedProject.assignments.some(p=>p[0]===87&&p[1]==='leds[7]'), 'downloaded project contains exact source, generics and pin mappings');
  const documentNode = await send('DOM.getDocument');
  const fileInput = await send('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '#fileInput' });
  await send('DOM.setFileInputFiles', { nodeId: fileInput.nodeId, files: [path.join(profile, 'trace-project.json')] }); await idle();
  check(await evaluate('__lab.state.sim.top==="dut" && !__lab.state.error'), 'file picker reloads an actual saved project through its change handler');
  const reloaded = new Promise(resolve => { onLoad = resolve; }); await send('Page.reload'); await reloaded; await idle();
  await click('#homeContinueBtn'); await idle();
  check(await evaluate('__lab.state.sim.top==="dut" && __lab.state.bindings.led1.offset===3 && document.querySelector("#genericInput").value==="W=5"'), 'page reload restores and recompiles saved project upon entering workbench');

  const replay = `$timescale 1 ns $end
$scope module tb $end $scope module dut $end
$var wire 1 ! led1 $end $var wire 1 @ led2 $end $var wire 1 # led3 $end $var wire 1 $ led4 $end
$var wire 8 % seven_seg[7:0] $end $var wire 1 & dtube1 $end
$var wire 8 % alias[7:0] $end $var real 64 * voltage $end
$upscope $end $scope module other $end $var wire 1 + led1 $end $upscope $end $upscope $end
$enddefinitions $end $dumpvars 0! 1@ 0# 1$ b1 % 0& r1.25 * 1+ $end
#5 1! 0@ 1# 0$ bX % r10 *
#10 0! b10 % r2.5 *`;
  await evaluate('__lab.state.assignments.clear()');
  await evaluate(`__lab.loadFiles([new File([${JSON.stringify(replay)}], 'scope.vcd')])`); await idle();
  check(await evaluate('__lab.state.vcd.scope==="tb.dut" && __lab.state.values.get("tb.dut.seven_seg[7:0]")==="00000001" && __lab.state.values.get("tb.dut.alias[7:0]")==="00000001" && document.querySelectorAll("[data-led].on").length===2'), 'VCD scope, aliases and padded vectors drive the board correctly');
  await click('#btnStep'); await idle();
  check(await evaluate('__lab.state.values.get("tb.dut.voltage")==="10" && __lab.state.values.get("tb.dut.seven_seg[7:0]")==="XXXXXXXX" && __lab.state.time===5000000'), 'real-valued and unknown VCD replay advances without crashes or binary reinterpretation');
  await click('#btnPins');
  await evaluate('document.querySelector("#replayScope").value="tb.other";document.querySelector("#replayScope").dispatchEvent(new Event("change"))');
  check(await evaluate('__lab.state.bindings.led1.signal.short==="tb.other.led1" && !document.querySelector(`[data-led="0"]`).classList.contains("on")'), 'replay scope selector avoids ambiguous hierarchical short names');
  await screenshot('product-replay.png');
  await click('#btnStep'); await idle();
  check(await evaluate('__lab.state.sim.ended && document.querySelector("#statusPill").textContent==="Complete" && document.querySelector("#btnRun").disabled'), 'end of VCD disables replay transport and retains final values');
  await click('#btnReset'); await idle();
  check(await evaluate('__lab.state.vcd.index===1 && !__lab.state.sim.ended'), 'restart rewinds VCD to first timestamp');
  const invalidVcd = await evaluate('__lab.loadFiles([new File(["garbage"],"bad.vcd")]).then(()=>false,e=>!!e.message)');
  check(invalidVcd && await evaluate('__lab.state.vcd.index===1 && __lab.state.sim.top==="scope.vcd"'), 'malformed VCD does not destroy active replay');
  const rejected = await evaluate('__lab.loadFiles([new File(["module x;endmodule"],"netlist.vo")]).then(()=>false,e=>e.message.includes("Verilog"))');
  check(rejected, 'unsupported native formats are explicitly rejected instead of simulated falsely');

  await loadProject([{ name: 'done.vhd', text: 'library std; use std.env.all; entity dut is end; architecture test of dut is signal done: bit := \'0\'; begin process begin wait for 5 ns; done <= \'1\'; wait for 1 ns; finish; wait; end process; end;' }]);
  await click('#btnStep'); await idle();
  check(await evaluate('__lab.state.sim.ended && !__lab.state.error && __lab.state.time===6000000 && __lab.state.values.get("done")==="1"'), 'normal native testbench completion reaches exact final state without an error');
  await evaluate(`window.originalFetch=window.fetch;window.fetch=async(...args)=>{const response=await originalFetch(...args);if(String(args[0]).endsWith('/vcd'))await new Promise(r=>window.releaseExport=r);return response;}`);
  await click('#btnVcd'); await wait('typeof releaseExport==="function"');
  check(await evaluate('__lab.state.exporting && ["btnElab","btnReset","btnImport","btnPinReset","btnVcd"].every(id=>document.getElementById(id).disabled)'), 'waveform export locks design mutation until finalization completes');
  await evaluate('window.fetch=originalFetch;releaseExport()'); await wait('!!__lab.state.sim.exportedVcd && !__lab.state.exporting');
  check(await evaluate('__lab.state.sim.exportedVcd.includes("#6000000")'), 'completed native testbench exports final timestamp');

  check((await downloaded('dut.vcd')).includes('#6000000'), 'downloaded VCD contains the finalized native waveform');
  await loadProject([{ name: 'uart.vhd', text: `library ieee; use ieee.std_logic_1164.all; use std.env.all; entity dut is port(uart_txd: out std_logic := '1'); end; architecture test of dut is begin process variable data: std_logic_vector(7 downto 0) := "01000001"; begin wait for 1 us; uart_txd <= '0'; wait for 8680 ns; for i in 0 to 7 loop uart_txd <= data(i); wait for 8680 ns; end loop; uart_txd <= '1'; wait for 8680 ns; finish; wait; end process; end;` }]);
  await click('#btnStep'); await idle();
  check(await evaluate('document.querySelector("#uartOut").textContent==="A" && !__lab.state.error'), 'UART decodes sparse native transitions without relying on the UI clock rate');
  await click('#btnTools'); await click('[data-rtab="uart"]'); await screenshot('product-uart.png'); await click('#uartClear');
  check(await evaluate('document.querySelector("#uartOut").textContent===""'), 'UART clear control works'); await click('#closeRight');

  const vital = `library ieee; use ieee.std_logic_1164.all; use ieee.vital_timing.all; entity dut is generic(tipd_a: VitalDelayType01 := (0 ns,0 ns)); port(a: in std_logic; y: out std_logic); attribute VITAL_LEVEL0 of dut: entity is true; end; architecture rtl of dut is signal a_ipd: std_logic; begin VitalWireDelay(a_ipd,a,tipd_a); y <= a_ipd; end;`;
  await loadProject([{ name: 'vital.vhd', text: vital }], { standard: '93' });
  const timing = '(DELAYFILE (SDFVERSION "3.0") (DESIGN "dut") (TIMESCALE 1 ns) (CELL (CELLTYPE "dut") (INSTANCE) (DELAY (ABSOLUTE (PORT a (2:3:4) (2:3:4))))))';
  await evaluate(`__lab.loadFiles([new File([${JSON.stringify(timing)}], 'timing.sdf')])`); await idle();
  check(await evaluate('__lab.state.dirty && __lab.state.sdf.instance==="/" && !document.querySelector("#sdfControls").classList.contains("hidden")'), 'SDF import exposes instance and corner before rebuilding');
  await click('#btnLibrary');
  await evaluate('document.querySelector(".compiler-options").open=true;document.querySelector("#sdfCorner").value="max";document.querySelector("#sdfCorner").dispatchEvent(new Event("change"))');
  await click('#btnElab'); await idle();
  await click('#clkHz'); await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 }); await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await click('#virtualInputs input'); await idle(); await click('#btnStep'); await idle(); await click('#waveFit');
  check(await evaluate('__lab.waves.signals.find(s=>s.name==="y").samples.some(s=>s.t===4000000&&s.v==="1")'), 'SDF max-corner UI produces verified 4 ns native delay in the analyzer');
  check(await evaluate('__lab.state.clkHz===50000000 && __lab.waves.tEnd < 30000000'), 'native clock selector and analyzer fit expose nanosecond timing');
  await screenshot('product-timing.png');
  const span = await evaluate('__lab.waves.tEnd-__lab.waves.tStart');
  await click('#waveZoomIn');
  check(await evaluate(`__lab.waves.tEnd-__lab.waves.tStart < ${span} && !document.querySelector('#waveFollow').checked`), 'waveform zoom controls change the visible time range');
  await click('#sigChips button:nth-child(2)');
  check(await evaluate('__lab.waves.signals.find(s=>s.name==="y").visible===false'), 'signal chips hide selected waveforms');
  await click('#sigChips button:nth-child(2)'); await click('#waveFit');
  await click('#clearSdf');
  check(await evaluate('__lab.state.sdf===null && __lab.state.dirty'), 'removing timing annotation requires a rebuild');
  await loadProject([{ name: 'gate.vhd', text: andGate, library: 'logiclib' }], { topLibrary: 'logiclib' });
  check(await evaluate('__lab.state.sim.topLibrary==="logiclib" && !__lab.state.error'), 'named source library and top library survive project import and compilation');
  const bitstreamName = 'mismatched.sof';
  await evaluate(`__lab.loadFiles([new File(['Device: EP4CE22F17C6N'],${JSON.stringify(bitstreamName)})])`); await idle();
  check(await evaluate('document.querySelector("#piMatch").textContent==="Not verified" && __lab.state.sim.top==="dut"'), 'bitstream inspector flags mismatched hardware without replacing the live simulation');
  await click('#closeRight');
  await click('#btnDemo'); await idle(); await click('[data-camera="hero"]');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await evaluate('new Promise(r=>setTimeout(r,500))');
  await screenshot('overhaul-mobile.png');
  const mobile = await evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll("body *")].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.right>innerWidth||r.left<0)}).map(e=>({tag:e.tagName,id:e.id,cls:e.className,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right})).slice(0,30)})');
  check(mobile.scroll === mobile.width, 'mobile has no horizontal overflow');
  const framed = await evaluate(`(async()=>{const T=await import('three');const box=new T.Box3().setFromObject(__lab.board.model);const points=[];for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z])points.push(new T.Vector3(x,y,z).project(__lab.board.camera));return points.every(p=>Math.abs(p.x)<1&&Math.abs(p.y)<1);})()`);
  check(framed, 'entire board bounding box fits the mobile viewport');
  await click('#btnLibrary'); check(await evaluate('document.querySelector("#app").classList.contains("mobile-library")'), 'mobile project drawer opens'); await click('#closeLeft');
  for (const width of [320, 768, 1920]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const layout = await evaluate('({width:innerWidth,viewport:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth})');
    if (width === 320 || layout.scroll > layout.viewport) await screenshot(`product-${width}px.png`);
    check(layout.scroll <= layout.viewport, `${width}px layout has no horizontal overflow: ${JSON.stringify(layout)}`);
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await click('#btnLibrary'); await click('#btnViewSettings'); await click('#btnShot');
  await downloaded('trace-board.png');
  const boardImage = await fs.readFile(path.join(profile, 'trace-board.png'));
  check(boardImage.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'board screenshot control downloads a PNG');
  await click('#deckCollapse'); await screenshot('product-final.png');

  const press = async (key, code, vk) => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, ...(type === 'keyDown' && key === 'Enter' ? { text: '\r' } : {}) }); };
  const dtubeFrame = () => evaluate(`(async()=>{const T=await import('three');const box=new T.Box3();for(let d=0;d<4;d++)for(let b=0;b<8;b++)box.expandByObject(__lab.board.model.getObjectByName('segment_'+d+'_'+b));const xs=[],ys=[];for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z]){const p=new T.Vector3(x,y,z).project(__lab.board.camera);xs.push(p.x);ys.push(p.y);}const r=document.querySelector('#view3d').getBoundingClientRect();return {inside:xs.every(v=>Math.abs(v)<.95)&&ys.every(v=>Math.abs(v)<.95),width:(Math.max(...xs)-Math.min(...xs))/2,closeup:document.querySelector('#center').classList.contains('closeup'),view:[r.width,r.height]};})()`);
  const dtubeSettled = 'Math.hypot(__lab.board.camera.position.x-25.3,__lab.board.camera.position.y-65,__lab.board.camera.position.z+16)<.05';
  check(await evaluate('[...document.querySelectorAll("#camPreset option")].map(o=>o.value).join()==="hero,top,fpga,display,dtubes,leds,io,underside" && document.querySelector("#camPreset option[value=dtubes]").textContent==="Four dtubes"'), 'camera menu adds Four dtubes and keeps every existing preset');
  await click('#btnViewSettings'); await click('#camPreset');
  await press('Home', 'Home', 36); for (let i = 0; i < 4; i++) await press('ArrowDown', 'ArrowDown', 40); await press('Enter', 'Enter', 13);
  await wait(dtubeSettled);
  check(await evaluate('document.querySelector("#camPreset").value==="dtubes"'), 'keyboard selection in the native camera menu chooses Four dtubes');
  await click('#deckCollapse');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '4', code: 'Digit4', windowsVirtualKeyCode: 52 }); await idle();
  await evaluate('__lab.advance(4)'); await idle();
  const desktopTubes = await dtubeFrame();
  check(desktopTubes.inside && desktopTubes.width > .3 && desktopTubes.closeup, `desktop Four dtubes frames all 32 segments: ${JSON.stringify(desktopTubes)}`);
  await screenshot('camera-dtubes-desktop.png');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await evaluate('new Promise(r=>setTimeout(r,300))');
  const mobileTubes = await dtubeFrame();
  check(mobileTubes.inside && mobileTubes.width > .5, `mobile Four dtubes frames all 32 segments: ${JSON.stringify(mobileTubes)}`);
  await screenshot('camera-dtubes-mobile.png');
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '4', code: 'Digit4', windowsVirtualKeyCode: 52 }); await idle();
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await click('#btnViewSettings'); await evaluate('document.querySelector("#camPreset").value="display";document.querySelector("#camPreset").dispatchEvent(new Event("change"))');
  await wait('Math.abs(__lab.board.camera.position.y-52)<.05');
  check(await evaluate('Math.abs(__lab.board.camera.position.x-36)<.05 && document.querySelector("#center").classList.contains("closeup")'), 'existing Display detail preset is unchanged');
  await click('#deckCollapse'); await click('[data-camera="hero"]');

  const themeSnapshot = `({theme:document.documentElement.dataset.theme,pressed:document.querySelector('#btnTheme').getAttribute('aria-pressed'),stored:localStorage.getItem('trace.theme'),body:getComputedStyle(document.body).backgroundColor,editor:getComputedStyle(document.querySelector('#sourceEditor')).backgroundColor,panel:getComputedStyle(document.querySelector('#rail')).backgroundColor,scene:__lab.board.scene.background.getHexString(),meta:document.querySelector('meta[name=theme-color]').content,sun:getComputedStyle(document.querySelector('#btnTheme .theme-sun')).display,wave:(()=>{const c=document.querySelector('#waveCanvas'),d=c.getContext('2d').getImageData(0,0,40,4).data,count={};for(let i=0;i<d.length;i+=4){const k=d[i]+','+d[i+1]+','+d[i+2];count[k]=(count[k]||0)+1;}return Object.entries(count).sort((a,b)=>b[1]-a[1])[0][0];})(),chip:document.querySelector('#sigChips .dot')?.style.background,trace:__lab.waves.signals[0]?.color})`;
  const simSnapshot = '({id:__lab.state.sim.id,time:__lab.state.time,samples:__lab.waves.signals.map(s=>s.samples.length).join(),visible:__lab.waves.signals.map(s=>s.visible).join(),materials:(()=>{const out=[];__lab.board.model.traverse(o=>{if(o.isMesh&&!/^(segment_|led_)/.test(o.name))out.push(o.material.color.getHexString())});return out.join();})()})';
  const light = await evaluate(themeSnapshot);
  check(light.theme === 'light' && light.pressed === 'false' && light.stored === null && light.body === 'rgb(246, 246, 243)' && light.scene === 'e9ebe4' && light.wave === '255,255,255' && light.sun === 'none', `light theme is the untouched default: ${JSON.stringify(light)}`);
  const beforeTheme = await evaluate(simSnapshot);
  await click('#btnTheme');
  const dark = await evaluate(themeSnapshot);
  check(dark.theme === 'dark' && dark.pressed === 'true' && dark.stored === 'dark' && dark.meta === '#141813' && dark.sun === 'block', `dark mode toggle updates state, storage and browser chrome: ${JSON.stringify(dark)}`);
  check(dark.body === 'rgb(20, 24, 19)' && dark.panel === 'rgb(28, 33, 26)' && dark.editor === 'rgb(23, 28, 22)' && dark.scene === '20261e' && dark.wave === '23,28,22', `dark mode covers page, panels, editor, analyzer and 3D backdrop: ${JSON.stringify(dark)}`);
  check(dark.trace === '#b7d98c' && dark.chip.replace(/\s/g, '') === 'rgb(183,217,140)', 'dark mode recolors traces and signal chips together');
  check(JSON.stringify(await evaluate(simSnapshot)) === JSON.stringify(beforeTheme), 'switching theme keeps the simulation session, trace history and board materials');
  await screenshot('theme-dark-desktop.png');
  await click('#btnTools'); await screenshot('theme-dark-tools.png'); await click('#closeRight');
  await click('.src-name'); await screenshot('theme-dark-editor.png'); await click('[data-close="sourceDialog"]');
  await click('#btnViewSettings'); await evaluate('document.querySelector("#tglLabels").click()'); await screenshot('theme-dark-settings.png'); await evaluate('document.querySelector("#tglLabels").click()'); await click('#deckCollapse');
  for (const width of [320, 390, 768, 1920]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: width < 700 ? 844 : 1000, deviceScaleFactor: 1, mobile: false });
    await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    if (width === 390) await screenshot('theme-dark-mobile.png');
    const layout = await evaluate('({viewport:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth})');
    check(layout.scroll <= layout.viewport, `${width}px dark layout has no horizontal overflow: ${JSON.stringify(layout)}`);
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const themeReload = new Promise(resolve => { onLoad = resolve; }); await send('Page.reload'); await themeReload; await idle();
  check(await evaluate('document.documentElement.dataset.theme==="dark" && document.querySelector("#btnTheme").getAttribute("aria-pressed")==="true" && __lab.board.scene.background.getHexString()==="20261e"'), 'dark mode persists across page reload');
  await evaluate('document.querySelector("#btnTheme").focus()'); await press('Enter', 'Enter', 13);
  const restored = await evaluate(themeSnapshot);
  check(restored.theme === 'light' && restored.stored === 'light' && restored.body === light.body && restored.scene === light.scene && restored.wave === light.wave && restored.trace === light.trace, `keyboard toggle restores the original light theme: ${JSON.stringify(restored)}`);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  const preferenceReload = new Promise(resolve => { onLoad = resolve; }); await send('Page.reload'); await preferenceReload; await idle();
  check(await evaluate('document.documentElement.dataset.theme==="light"'), 'a saved light choice overrides a dark system preference');
  await evaluate('localStorage.removeItem("trace.theme")');
  const systemReload = new Promise(resolve => { onLoad = resolve; }); await send('Page.reload'); await systemReload; await idle();
  check(await evaluate('document.documentElement.dataset.theme==="dark" && document.querySelector("#btnTheme").getAttribute("aria-pressed")==="true" && __lab.waves.palette.bg==="#171c16"'), 'without a saved choice the site follows a dark system preference');
  check(remote.size === 0, 'application loads no external network resources');
  const unexpected = errors.filter(e => !JSON.stringify(e).includes('trace log probe'));
  check(unexpected.length === 0, `no browser exceptions: ${JSON.stringify(unexpected)}`);
  console.log(`\n${passed} browser checks passed`);
  await evaluate('fetch(`/api/sim/${__lab.state.sim.id}`,{method:"DELETE"})');
  cleanup = null;
  await send('Browser.close', {}, false).catch(() => {});
} finally {
  await cleanup?.().catch(() => {});
  socket?.close(); chrome.kill();
  for (const entry of waiting.values()) clearTimeout(entry.timer);
  await new Promise(resolve => { if (chrome.exitCode !== null) resolve(); else { chrome.once('exit', resolve); setTimeout(resolve, 1500).unref(); } });
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  await server.stop();
}
